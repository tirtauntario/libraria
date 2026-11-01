/**
 * Google Drive source. Browser-only OAuth "token" flow (no client secret,
 * no refresh token): the access token lasts about an hour, then the user
 * signs in again, silently first (prompt=none).
 *
 * Paths are chains of Drive file ids below the root folder
 * (`<folderId>/<folderId>/<fileId>`), so renames do not look like new files
 * and duplicate names are fine. Names are shown via `displayPath`.
 */
import type { GdriveConfig, OAuthTokens, Source } from '@libraria/core';
import { SourceError, codeForStatus } from './errors';
import { rangeHeaders, request, resumableStream, streamToBlob, type OpenRange } from './http';
import type { ListOptions, ReadOptions, SourceDriver, SourceEntry } from './types';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const HOST = 'Google Drive';

export function gdriveAuthUrl(opts: { clientId: string; redirectUri: string; state: string; silent?: boolean; loginHint?: string }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'token',
    scope: DRIVE_SCOPE,
    state: opts.state,
    include_granted_scopes: 'true',
  });
  if (opts.silent) p.set('prompt', 'none');
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  return `${GOOGLE_AUTH_URL}?${p}`;
}

/** Tokens from the redirect fragment. Expiry is pulled in by a minute to avoid using a token as it lapses. */
export function gdriveTokensFromRedirect(params: Record<string, string>, now = Date.now()): OAuthTokens {
  if (params.error) throw gdriveAuthError(params.error, params.error_description);
  const accessToken = params.access_token;
  if (!accessToken) throw new SourceError('bad-response', 'Google did not return an access token.');
  const expiresIn = Number(params.expires_in ?? 3600);
  return { accessToken, refreshToken: null, expiresAt: now + Math.max(60, expiresIn - 60) * 1000 };
}

/** Errors that mean "prompt=none could not finish; ask the user". */
export const SILENT_RETRY_ERRORS = ['interaction_required', 'login_required', 'consent_required', 'account_selection_required'];

export function gdriveAuthError(code: string, description?: string): SourceError {
  if (code === 'access_denied') return new SourceError('auth', 'Google Drive access was not granted.');
  if (SILENT_RETRY_ERRORS.includes(code)) return new SourceError('auth', 'Google needs you to sign in again.');
  return new SourceError('auth', `Google sign-in failed (${code})${description ? `: ${description}` : ''}.`);
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string }[] };
}

/** Turn a Drive API error response into a SourceError with an actionable message. */
export async function mapGoogleError(res: Response): Promise<SourceError> {
  let body: GoogleErrorBody = {};
  try {
    body = (await res.json()) as GoogleErrorBody;
  } catch {
    // not JSON
  }
  const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? '';
  const status = res.status;
  if (status === 401) return new SourceError('auth', 'Your Google sign-in has expired. Sign in again.', { status });
  if (status === 403 || status === 429) {
    if (/rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(reason) || status === 429) {
      return new SourceError('rate-limit', 'Google Drive is limiting requests. Wait a minute and try again.', { status });
    }
    if (/accessNotConfigured|SERVICE_DISABLED/.test(reason) || /has not been used|is disabled/.test(body.error?.message ?? '')) {
      return new SourceError('config', 'The Google Drive API is not enabled for this OAuth client’s project. Enable it in Google Cloud Console.', { status });
    }
    if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/.test(reason)) {
      return new SourceError('auth', 'Libraria was not given read access to your Drive. Sign in again and allow access.', { status });
    }
    if (/cannotDownloadFile|downloadQuotaExceeded/.test(reason)) {
      return new SourceError('forbidden', 'Google Drive does not allow downloading this file.', { status });
    }
    return new SourceError('forbidden', 'Google Drive refused access to this item.', { status });
  }
  if (status === 404) return new SourceError('not-found', 'This item is no longer in Google Drive (moved, deleted or unshared).', { status });
  return new SourceError(codeForStatus(status), `Google Drive answered with an error (HTTP ${status}).`, { status });
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}

interface DriveList {
  nextPageToken?: string;
  files?: DriveFile[];
}

const FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)';

/** Google Docs, Sheets, shortcuts...: not downloadable as book files. */
export function isGoogleNative(mime: string): boolean {
  return mime.startsWith('application/vnd.google-apps.') && mime !== FOLDER_MIME;
}

const lastSegment = (path: string) => path.split('/').filter(Boolean).pop() ?? '';

export class GdriveDriver implements SourceDriver {
  readonly isLocal = false;
  /** idPath → display path, learnt while listing (parents are listed before children). */
  private names = new Map<string, string>();

  constructor(
    readonly source: Source,
    private readonly config: GdriveConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private token(): string {
    const t = this.config.tokens;
    if (!t?.accessToken) throw new SourceError('auth', 'Sign in to Google Drive to use this source.');
    if (t.expiresAt != null && t.expiresAt <= this.now()) throw new SourceError('auth', 'Your Google sign-in has expired. Sign in again.');
    return t.accessToken;
  }

  private async api(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await request(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.token()}` } }, { host: HOST });
    if (!res.ok) throw await mapGoogleError(res);
    return res;
  }

  folderId(path: string): string {
    return lastSegment(path) || this.config.rootFolderId || 'root';
  }

  async *list(path: string, opts: ListOptions = {}): AsyncIterable<SourceEntry> {
    const parent = this.folderId(path);
    const parentName = this.names.get(path) ?? '';
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        q: `'${parent.replace(/['\\]/g, '\\$&')}' in parents and trashed=false`,
        fields: FIELDS,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        orderBy: 'folder,name',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.api(`${DRIVE_API}/files?${q}`, { signal: opts.signal, cache: 'no-store' });
      const page = (await res.json()) as DriveList;
      for (const f of page.files ?? []) {
        if (isGoogleNative(f.mimeType)) continue;
        const p = path ? `${path}/${f.id}` : f.id;
        const display = parentName ? `${parentName}/${f.name}` : f.name;
        const isDir = f.mimeType === FOLDER_MIME;
        if (isDir) this.names.set(p, display);
        yield {
          path: p,
          name: f.name,
          isDir,
          size: isDir || f.size == null ? null : Number(f.size),
          mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : null,
          etag: isDir ? null : (f.md5Checksum ?? null),
          displayPath: display,
        };
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  async stat(path: string, opts: ListOptions = {}): Promise<SourceEntry | null> {
    try {
      const id = this.folderId(path);
      const q = new URLSearchParams({ fields: 'id,name,mimeType,size,modifiedTime,md5Checksum', supportsAllDrives: 'true' });
      const f = (await (await this.api(`${DRIVE_API}/files/${encodeURIComponent(id)}?${q}`, { signal: opts.signal })).json()) as DriveFile;
      const isDir = f.mimeType === FOLDER_MIME;
      return {
        path,
        name: f.name,
        isDir,
        size: isDir || f.size == null ? null : Number(f.size),
        mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : null,
        etag: f.md5Checksum ?? null,
      };
    } catch (err) {
      if (err instanceof SourceError && err.code === 'not-found') return null;
      throw err;
    }
  }

  async readStream(path: string, opts: ReadOptions = {}): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
    const id = lastSegment(path);
    if (!id) throw new SourceError('not-found', 'No file id in this path.');
    const url = `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
    const open = (range: OpenRange) => this.api(url, { headers: rangeHeaders(range), signal: opts.signal, cache: 'no-store' });
    return resumableStream(open, { signal: opts.signal, onProgress: opts.onProgress });
  }

  async read(path: string, opts: ReadOptions = {}): Promise<Blob> {
    return streamToBlob((await this.readStream(path, opts)).stream);
  }

  describe() {
    return { title: 'Google Drive', detail: this.config.rootFolderName || 'My Drive' };
  }
}
