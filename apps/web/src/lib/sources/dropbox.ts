/**
 * Dropbox source. OAuth 2 code flow with PKCE and `token_access_type=offline`,
 * so there is a refresh token and no repeated sign-ins. Refreshed access
 * tokens are written back to the source config.
 *
 * Paths are Dropbox display paths relative to the configured root folder.
 */
import type { DropboxConfig, OAuthTokens, Source } from '@libraria/core';
import type { Repo } from '../db/repo';
import { SourceError, codeForStatus } from './errors';
import { rangeHeaders, request, resumableStream, streamToBlob, type OpenRange } from './http';
import type { ListOptions, ReadOptions, SourceDriver, SourceEntry } from './types';

export const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const DROPBOX_API = 'https://api.dropboxapi.com/2';
export const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
const HOST = 'Dropbox';

export function dropboxAuthUrl(opts: { appKey: string; redirectUri: string; state: string; challenge: string }): string {
  const p = new URLSearchParams({
    client_id: opts.appKey,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
  });
  return `${DROPBOX_AUTH_URL}?${p}`;
}

/**
 * JSON for the Dropbox-API-Arg header. HTTP headers must be ASCII, so every
 * character above 0x7E is written as a \uXXXX escape (Dropbox docs, "JSON
 * header encoding"). Surrogate pairs become two escapes.
 */
export function dropboxApiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function tokensFrom(body: TokenResponse, now: number, previousRefresh?: string | null): OAuthTokens {
  if (!body.access_token) throw new SourceError('auth', 'Dropbox did not return an access token.');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previousRefresh ?? null,
    expiresAt: body.expires_in ? now + Math.max(60, body.expires_in - 60) * 1000 : null,
  };
}

async function tokenRequest(form: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const res = await request(
    DROPBOX_TOKEN_URL,
    { method: 'POST', body: new URLSearchParams(form), signal, cache: 'no-store' },
    { host: HOST },
  );
  let body: TokenResponse = {};
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    // not JSON
  }
  if (!res.ok || body.error) {
    if (body.error === 'invalid_grant') throw new SourceError('auth', 'Dropbox access was revoked or has expired. Sign in again.', { status: res.status });
    if (body.error === 'invalid_client') throw new SourceError('config', 'Dropbox does not recognise this app key.', { status: res.status });
    throw new SourceError('auth', `Dropbox sign-in failed (${body.error ?? `HTTP ${res.status}`}).`, { status: res.status });
  }
  return body;
}

/** Exchange the authorization code from the redirect for tokens (PKCE, no secret). */
export async function dropboxExchangeCode(
  opts: { code: string; verifier: string; appKey: string; redirectUri: string },
  now = Date.now(),
): Promise<OAuthTokens> {
  const body = await tokenRequest({
    code: opts.code,
    grant_type: 'authorization_code',
    client_id: opts.appKey,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  return tokensFrom(body, now);
}

export async function dropboxRefresh(appKey: string, refreshToken: string, now = Date.now(), signal?: AbortSignal): Promise<OAuthTokens> {
  const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey }, signal);
  return tokensFrom(body, now, refreshToken);
}

export function dropboxAuthError(code: string, description?: string): SourceError {
  if (code === 'access_denied') return new SourceError('auth', 'Dropbox access was not granted.');
  return new SourceError('auth', `Dropbox sign-in failed (${code})${description ? `: ${description}` : ''}.`);
}

interface DropboxErrorBody {
  error_summary?: string;
  error?: { '.tag'?: string; reason?: { '.tag'?: string }; path?: { '.tag'?: string } };
}

/** Map a Dropbox API error response. `expired` tells the caller to refresh and retry. */
export async function mapDropboxError(res: Response): Promise<SourceError & { expired?: boolean }> {
  let body: DropboxErrorBody = {};
  let text = '';
  try {
    text = await res.text();
    body = JSON.parse(text) as DropboxErrorBody;
  } catch {
    // plain text errors (400 bad input)
  }
  const summary = body.error_summary ?? '';
  const status = res.status;
  if (status === 401) {
    const err: SourceError & { expired?: boolean } = new SourceError(
      'auth',
      summary.startsWith('expired_access_token') ? 'Your Dropbox session expired.' : 'Dropbox rejected this sign-in. Sign in again.',
      { status },
    );
    err.expired = summary.startsWith('expired_access_token');
    return err;
  }
  if (status === 409) {
    if (/not_found/.test(summary)) return new SourceError('not-found', 'This item is no longer in Dropbox (moved or deleted).', { status });
    if (/not_folder/.test(summary)) return new SourceError('config', 'This Dropbox path is a file, not a folder.', { status });
    if (/restricted_content|unsupported_file/.test(summary)) return new SourceError('forbidden', 'Dropbox does not allow downloading this file.', { status });
    if (/reset/.test(summary)) return new SourceError('bad-response', 'Dropbox asked to restart the listing. Rescan.', { status });
    return new SourceError('bad-response', `Dropbox could not do that (${summary.split('/')[0] || 'conflict'}).`, { status });
  }
  if (status === 429) {
    const after = Number(res.headers.get('retry-after') ?? '');
    return new SourceError('rate-limit', `Dropbox is limiting requests. Try again${after ? ` in ${after} s` : ' shortly'}.`, { status });
  }
  if (status === 400) return new SourceError('config', `Dropbox rejected the request${text ? `: ${text.slice(0, 200)}` : ''}.`, { status });
  if (status === 403) return new SourceError('forbidden', 'This Dropbox app is not allowed to read files. Give it the files.content.read permission.', { status });
  return new SourceError(codeForStatus(status), `Dropbox answered with an error (HTTP ${status}).`, { status });
}

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  name: string;
  id?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
  client_modified?: string;
  content_hash?: string;
  rev?: string;
}

interface ListFolderResult {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

/** '' or '/Books/Comics' (Dropbox API form: leading slash, none trailing; '' is the root). */
export function dropboxPath(root: string, rel: string): string {
  const parts = [...root.split('/'), ...rel.split('/')].filter(Boolean);
  return parts.length ? '/' + parts.join('/') : '';
}

export class DropboxDriver implements SourceDriver {
  readonly isLocal = false;
  private tokens: OAuthTokens | null;
  private refreshing: Promise<string> | null = null;

  constructor(
    readonly source: Source,
    private readonly config: DropboxConfig,
    private readonly repo?: Repo,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = config.tokens ?? null;
  }

  private async accessToken(force = false): Promise<string> {
    const t = this.tokens;
    if (!t?.accessToken) throw new SourceError('auth', 'Sign in to Dropbox to use this source.');
    const stale = t.expiresAt != null && t.expiresAt <= this.now();
    if (!force && !stale) return t.accessToken;
    if (!t.refreshToken) throw new SourceError('auth', 'Your Dropbox session expired. Sign in again.');
    this.refreshing ??= (async () => {
      try {
        const next = await dropboxRefresh(this.config.appKey, t.refreshToken!, this.now());
        this.tokens = next;
        // Persist so other tabs and the next start use the fresh token.
        const src = await this.repo?.getSource(this.source.id);
        if (src && src.config.kind === 'dropbox') await this.repo?.updateSource(src.id, { config: { ...src.config, tokens: next } });
        return next.accessToken;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Call an endpoint; on an expired token, refresh once and retry. */
  private async call(url: string, init: RequestInit, retried = false): Promise<Response> {
    const token = await this.accessToken();
    const res = await request(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } }, { host: HOST });
    if (res.ok) return res;
    const err = await mapDropboxError(res);
    if (err.expired && !retried && this.tokens?.refreshToken) {
      await this.accessToken(true);
      return this.call(url, init, true);
    }
    throw err;
  }

  private rpc(endpoint: string, arg: unknown, signal?: AbortSignal): Promise<Response> {
    return this.call(`${DROPBOX_API}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arg),
      signal,
      cache: 'no-store',
    });
  }

  private relative(e: DropboxEntry): string | null {
    const display = e.path_display ?? '';
    const root = dropboxPath(this.config.rootPath, '');
    if (!root) return display.replace(/^\/+/, '');
    // Dropbox is case-insensitive: compare on path_lower.
    const lower = (e.path_lower ?? display.toLowerCase());
    if (!lower.startsWith(root.toLowerCase() + '/')) return null;
    return display.slice(root.length + 1);
  }

  async *list(path: string, opts: ListOptions = {}): AsyncIterable<SourceEntry> {
    let res = (await (
      await this.rpc('files/list_folder', { path: dropboxPath(this.config.rootPath, path), recursive: false, include_deleted: false, limit: 2000 }, opts.signal)
    ).json()) as ListFolderResult;
    for (;;) {
      for (const e of res.entries) {
        if (e['.tag'] === 'deleted') continue;
        const rel = this.relative(e) ?? (path ? `${path}/${e.name}` : e.name);
        const isDir = e['.tag'] === 'folder';
        yield {
          path: rel,
          name: e.name,
          isDir,
          size: isDir ? null : (e.size ?? null),
          mtime: isDir ? null : Date.parse(e.server_modified ?? e.client_modified ?? '') || null,
          etag: isDir ? null : (e.content_hash ?? e.rev ?? null),
        };
      }
      if (!res.has_more) break;
      res = (await (await this.rpc('files/list_folder/continue', { cursor: res.cursor }, opts.signal)).json()) as ListFolderResult;
    }
  }

  async stat(path: string, opts: ListOptions = {}): Promise<SourceEntry | null> {
    try {
      const e = (await (await this.rpc('files/get_metadata', { path: dropboxPath(this.config.rootPath, path) }, opts.signal)).json()) as DropboxEntry;
      const isDir = e['.tag'] === 'folder';
      return {
        path,
        name: e.name,
        isDir,
        size: isDir ? null : (e.size ?? null),
        mtime: Date.parse(e.server_modified ?? '') || null,
        etag: e.content_hash ?? null,
      };
    } catch (err) {
      if (err instanceof SourceError && err.code === 'not-found') return null;
      throw err;
    }
  }

  async readStream(path: string, opts: ReadOptions = {}): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
    const arg = dropboxApiArg({ path: dropboxPath(this.config.rootPath, path) });
    const open = (range: OpenRange) =>
      this.call(`${DROPBOX_CONTENT}/files/download`, {
        method: 'POST',
        // No Content-Type: the body is empty, and a JSON type would be rejected.
        headers: { 'Dropbox-API-Arg': arg, ...rangeHeaders({ offset: range.offset, etag: null }) },
        signal: opts.signal,
        cache: 'no-store',
      });
    return resumableStream(open, { signal: opts.signal, onProgress: opts.onProgress });
  }

  async read(path: string, opts: ReadOptions = {}): Promise<Blob> {
    return streamToBlob((await this.readStream(path, opts)).stream);
  }

  describe() {
    return { title: 'Dropbox', detail: this.config.rootPath || 'Whole Dropbox' };
  }
}
