/**
 * Typed client for the Libraria server API v1 (`@libraria/core` api.ts).
 *
 * - Bearer token auth; no cookies.
 * - Every request has a timeout (headers only for streamed downloads).
 * - Errors become ServerError with the server's ErrorCode, or a client-side
 *   code: 'offline', 'network', 'timeout', 'aborted', 'mixed_content', 'bad_response'.
 * - A 401 on a request that carried a token calls `onUnauthorized` so the
 *   app can mark the session expired and ask the user to sign in again.
 */
import {
  API_PREFIX,
  UPLOAD_CONTENT_TYPE,
  UPLOAD_OFFSET_HEADER,
  type AuthResponse,
  type BookDto,
  type BookListResponse,
  type BookLookupResponse,
  type BookUpdateRequest,
  type ChangePasswordRequest,
  type ErrorCode,
  type InviteDto,
  type InviteListResponse,
  type LoginRequest,
  type PreloginResponse,
  type RegisterRequest,
  type ReviewRequest,
  type ScanResult,
  type ServerInfo,
  type ServerSourceDto,
  type ServerSourceListResponse,
  type SettingsDto,
  type SetupRequest,
  type SourceRootsResponse,
  type SubmissionCreateRequest,
  type SubmissionDto,
  type SubmissionListResponse,
  type SubmissionStatus,
  type SyncKeysDto,
  type SyncPullResponse,
  type SyncPushItem,
  type SyncPushResponse,
  type UserDto,
  type UserListResponse,
  type UserStatus,
  type UserUpdateRequest,
} from '@libraria/core';
import { isMixedContent } from './url';

export type ClientErrorCode = ErrorCode | 'offline' | 'network' | 'timeout' | 'aborted' | 'mixed_content' | 'bad_response';

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ClientErrorCode,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ServerError';
  }

  /** The request never got an answer (offline, unreachable, timed out). Worth retrying later. */
  get transient(): boolean {
    return (
      this.code === 'offline' ||
      this.code === 'network' ||
      this.code === 'timeout' ||
      this.code === 'rate_limited' ||
      this.status >= 500
    );
  }
}

export function isServerError(err: unknown, code?: ClientErrorCode): err is ServerError {
  return err instanceof ServerError && (code === undefined || err.code === code);
}

/** Short user-facing explanation of an error. */
export function describeError(err: unknown): string {
  if (err instanceof ServerError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const REPLACE_KEYS_HEADER = 'X-Libraria-Replace-Keys';
const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  /** Normalized server URL (see url.ts), without API_PREFIX. */
  baseUrl: string;
  /** Session token; empty or null for anonymous (guest) requests. */
  token?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Called when a request that carried the token was rejected with 401. */
  onUnauthorized?: () => void | Promise<void>;
  /** Fail fast with code 'offline' when this returns false. */
  isOnline?: () => boolean;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Do not send the token (login, register). */
  anonymous?: boolean;
  /** Return the Response without reading the body; the timeout covers headers only. */
  raw?: boolean;
  /** Statuses returned as-is instead of thrown (e.g. 404 for "not set up"). */
  allow?: number[];
}

const MESSAGES: Partial<Record<ClientErrorCode, string>> = {
  offline: 'You are offline.',
  timeout: 'The server took too long to answer.',
  aborted: 'Cancelled.',
};

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export class ServerApi {
  readonly baseUrl: string;
  token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onUnauthorized?: () => void | Promise<void>;
  private readonly isOnline: () => boolean;

  constructor(opts: ApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token || null;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onUnauthorized = opts.onUnauthorized;
    this.isOnline = opts.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  }

  /** Full URL of an API path, e.g. url('/books') → https://host/api/v1/books */
  url(path: string, query?: RequestOptions['query']): string {
    let u = `${this.baseUrl}${API_PREFIX}${path}`;
    if (query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
      const s = q.toString();
      if (s) u += `?${s}`;
    }
    return u;
  }

  get anonymous(): boolean {
    return !this.token;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, opts);
    if (opts.raw) return res as unknown as T;
    if (res.status === 204 || method === 'HEAD') return undefined as T;
    if (opts.allow?.includes(res.status) && !res.ok) return undefined as T;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('json')) return (await res.blob()) as unknown as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new ServerError('The server sent a reply Libraria could not read.', res.status, 'bad_response');
    }
  }

  /** Low-level send: returns the Response for ok and allowed statuses, throws ServerError otherwise. */
  async send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    if (opts.signal?.aborted) throw abortError();
    if (!this.isOnline()) throw new ServerError(MESSAGES.offline!, 0, 'offline');
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    const withToken = !opts.anonymous && !!this.token;
    if (withToken) headers.Authorization = `Bearer ${this.token}`;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, opts.timeoutMs ?? this.timeoutMs);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), { method, headers, body, signal: ctrl.signal, cache: 'no-store' });
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) throw abortError();
      if (timedOut) throw new ServerError(MESSAGES.timeout!, 0, 'timeout');
      if (isMixedContent(this.baseUrl)) {
        throw new ServerError(
          'This app is loaded over HTTPS, so the browser blocks a server on plain http://. Use the server’s https:// address.',
          0,
          'mixed_content',
        );
      }
      throw new ServerError(
        `Could not reach ${this.baseUrl}. Check the address and your connection. The server must use HTTPS and allow this app’s origin.`,
        0,
        'network',
        { cause: String(err) },
      );
    }
    if (opts.raw) {
      // The caller reads the body; keep listening to its signal but stop the header timeout.
      clearTimeout(timer);
    } else {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    if (res.ok || opts.allow?.includes(res.status)) return res;
    throw await this.toError(res, withToken);
  }

  private async toError(res: Response, withToken: boolean): Promise<ServerError> {
    let body: Record<string, unknown> | null = null;
    try {
      const text = await res.text();
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const code = (typeof body?.error === 'string' ? body.error : null) as ErrorCode | null;
    let message = typeof body?.message === 'string' ? body.message : `The server answered ${res.status}.`;
    if (res.status === 401 && withToken) {
      try {
        await this.onUnauthorized?.();
      } catch {
        // marking the session is best effort
      }
      message = 'Your session on this server has ended. Sign in again.';
    }
    if (res.status === 429) {
      const retry = res.headers.get('Retry-After');
      message = `Too many requests. Try again${retry ? ` in ${retry} s` : ' later'}.`;
    }
    return new ServerError(message, res.status, code ?? (res.status >= 500 ? 'internal' : 'bad_request'), body);
  }

  // --- info & auth -----------------------------------------------------------

  info(signal?: AbortSignal): Promise<ServerInfo> {
    return this.request('GET', '/info', { signal, anonymous: true });
  }

  prelogin(username: string): Promise<PreloginResponse> {
    return this.request('GET', '/auth/prelogin', { query: { username }, anonymous: true });
  }

  setup(req: SetupRequest): Promise<AuthResponse> {
    return this.request('POST', '/setup', { json: req, anonymous: true });
  }

  register(req: RegisterRequest): Promise<AuthResponse> {
    return this.request('POST', '/auth/register', { json: req, anonymous: true });
  }

  login(req: LoginRequest): Promise<AuthResponse> {
    return this.request('POST', '/auth/login', { json: req, anonymous: true });
  }

  logout(): Promise<void> {
    return this.request('POST', '/auth/logout');
  }

  me(): Promise<UserDto> {
    return this.request('GET', '/me');
  }

  changePassword(req: ChangePasswordRequest): Promise<void> {
    return this.request('POST', '/me/password', { json: req });
  }

  // --- books -----------------------------------------------------------------

  listBooks(params: { cursor?: string | null; limit?: number; q?: string } = {}, signal?: AbortSignal): Promise<BookListResponse> {
    return this.request('GET', '/books', { query: params, signal });
  }

  /** Every book, following cursors. */
  async allBooks(signal?: AbortSignal, pageSize = 500): Promise<BookDto[]> {
    const out: BookDto[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10_000; i++) {
      const page: BookListResponse = await this.listBooks({ cursor, limit: pageSize }, signal);
      out.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  getBook(id: string): Promise<BookDto> {
    return this.request('GET', `/books/${encodeURIComponent(id)}`);
  }

  updateBook(id: string, patch: BookUpdateRequest): Promise<BookDto> {
    return this.request('PATCH', `/books/${encodeURIComponent(id)}`, { json: patch });
  }

  deleteBook(id: string): Promise<void> {
    return this.request('DELETE', `/books/${encodeURIComponent(id)}`);
  }

  lookup(sha512: string): Promise<BookLookupResponse> {
    return this.request('GET', '/books/lookup', { query: { sha512 } });
  }

  /** Cover image, or null if the book has none. */
  async cover(id: string, signal?: AbortSignal): Promise<Blob | null> {
    const res = await this.send('GET', `/books/${encodeURIComponent(id)}/cover`, { signal, allow: [404], headers: { Accept: 'image/*' } });
    if (res.status === 404) return null;
    return res.blob();
  }

  putCover(id: string, image: Blob): Promise<BookDto> {
    return this.request('PUT', `/books/${encodeURIComponent(id)}/cover`, {
      body: image,
      headers: { 'Content-Type': image.type || 'application/octet-stream' },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  }

  /** Starts a book download. Range lets an interrupted download resume. */
  openBookFile(id: string, opts: { signal?: AbortSignal; from?: number } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: '*/*' };
    if (opts.from) headers.Range = `bytes=${opts.from}-`;
    return this.send('GET', `/books/${encodeURIComponent(id)}/file`, { signal: opts.signal, headers, raw: true });
  }

  // --- submissions -----------------------------------------------------------

  createSubmission(req: SubmissionCreateRequest): Promise<SubmissionDto> {
    return this.request('POST', '/submissions', { json: req });
  }

  listSubmissions(params: { status?: SubmissionStatus; mine?: boolean } = {}): Promise<SubmissionListResponse> {
    return this.request('GET', '/submissions', { query: { status: params.status, mine: params.mine ? 1 : undefined } });
  }

  getSubmission(id: string): Promise<SubmissionDto> {
    return this.request('GET', `/submissions/${encodeURIComponent(id)}`);
  }

  deleteSubmission(id: string): Promise<void> {
    return this.request('DELETE', `/submissions/${encodeURIComponent(id)}`);
  }

  review(id: string, req: ReviewRequest): Promise<SubmissionDto> {
    return this.request('POST', `/submissions/${encodeURIComponent(id)}/review`, { json: req });
  }

  /** Bytes the server has for an upload. */
  async uploadOffset(id: string): Promise<number> {
    const res = await this.send('HEAD', `/submissions/${encodeURIComponent(id)}/content`);
    const v = Number(res.headers.get(UPLOAD_OFFSET_HEADER));
    if (!Number.isFinite(v) || v < 0) throw new ServerError('The server did not report an upload offset.', res.status, 'bad_response');
    return v;
  }

  /**
   * Sends one chunk at `offset`. Returns the new offset. A 409 with the
   * server's offset is returned as `{ conflict: offset }` so the caller can resync.
   */
  async uploadChunk(id: string, offset: number, chunk: Blob, signal?: AbortSignal): Promise<{ offset: number } | { conflict: number }> {
    const res = await this.send('PATCH', `/submissions/${encodeURIComponent(id)}/content`, {
      body: chunk,
      headers: { [UPLOAD_OFFSET_HEADER]: String(offset), 'Content-Type': UPLOAD_CONTENT_TYPE },
      signal,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      allow: [409],
    });
    const header = Number(res.headers.get(UPLOAD_OFFSET_HEADER));
    if (res.status === 409) {
      let body: { offset?: number } = {};
      try {
        body = (await res.json()) as { offset?: number };
      } catch {
        // header only
      }
      const off = typeof body.offset === 'number' ? body.offset : header;
      if (!Number.isFinite(off)) throw new ServerError('Upload conflict without an offset.', 409, 'conflict');
      return { conflict: off };
    }
    if (!Number.isFinite(header)) return { offset: offset + chunk.size };
    return { offset: header };
  }

  /** The pending file of a submission (reviewers and the submitter). */
  async submissionFile(id: string, signal?: AbortSignal): Promise<Blob> {
    const res = await this.send('GET', `/submissions/${encodeURIComponent(id)}/file`, { signal, raw: true, headers: { Accept: '*/*' } });
    return res.blob();
  }

  // --- users, invites, settings --------------------------------------------------

  listUsers(status?: UserStatus): Promise<UserListResponse> {
    return this.request('GET', '/users', { query: { status } });
  }

  updateUser(id: string, patch: UserUpdateRequest): Promise<UserDto> {
    return this.request('PATCH', `/users/${encodeURIComponent(id)}`, { json: patch });
  }

  createInvite(): Promise<InviteDto> {
    return this.request('POST', '/invites', { json: {} });
  }

  listInvites(): Promise<InviteListResponse> {
    return this.request('GET', '/invites');
  }

  revokeInvite(id: string): Promise<void> {
    return this.request('DELETE', `/invites/${encodeURIComponent(id)}`);
  }

  getSettings(): Promise<SettingsDto> {
    return this.request('GET', '/settings');
  }

  updateSettings(patch: Partial<SettingsDto>): Promise<SettingsDto> {
    return this.request('PATCH', '/settings', { json: patch });
  }

  // --- server sources (owner) ------------------------------------------------------

  sourceRoots(): Promise<SourceRootsResponse> {
    return this.request('GET', '/sources/roots');
  }

  listSources(): Promise<ServerSourceListResponse> {
    return this.request('GET', '/sources');
  }

  createSource(path: string): Promise<ServerSourceDto> {
    return this.request('POST', '/sources', { json: { kind: 'disk', path } });
  }

  scanSource(id: string): Promise<ScanResult> {
    return this.request('POST', `/sources/${encodeURIComponent(id)}/scan`, { timeoutMs: 30 * 60_000 });
  }

  deleteSource(id: string): Promise<void> {
    return this.request('DELETE', `/sources/${encodeURIComponent(id)}`);
  }

  // --- encrypted sync ------------------------------------------------------------

  /** Null when sync was never set up for this account. */
  async getSyncKeys(): Promise<SyncKeysDto | null> {
    const res = await this.send('GET', '/sync/keys', { allow: [404] });
    if (res.status === 404) return null;
    return (await res.json()) as SyncKeysDto;
  }

  putSyncKeys(keys: SyncKeysDto, replace = false): Promise<SyncKeysDto> {
    return this.request('PUT', '/sync/keys', { json: keys, headers: replace ? { [REPLACE_KEYS_HEADER]: '1' } : {} });
  }

  deleteSync(): Promise<void> {
    return this.request('DELETE', '/sync');
  }

  pullSync(since: number, limit?: number): Promise<SyncPullResponse> {
    return this.request('GET', '/sync/records', { query: { since, limit } });
  }

  pushSync(items: SyncPushItem[]): Promise<SyncPushResponse> {
    return this.request('POST', '/sync/records', { json: { items }, timeoutMs: 60_000 });
  }
}
