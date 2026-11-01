/**
 * Errors from remote and device sources, with a code the UI can act on
 * ("Sign in again", "Grant access", CORS help), and redaction of secrets.
 *
 * Credentials (passwords, tokens) live in the source config. They must never
 * reach the console or an error message: everything shown to the user goes
 * through `redact()` with the source's secrets.
 */
import type { SourceConfig } from '@libraria/core';

export type SourceErrorCode =
  /** fetch() failed: offline, DNS, TLS, refused, or blocked by CORS (the browser does not say which). */
  | 'network'
  /** Credentials rejected or token expired: sign in again. */
  | 'auth'
  /** File System Access permission was not granted (needs a click). */
  | 'permission'
  | 'forbidden'
  | 'not-found'
  | 'rate-limit'
  | 'server'
  | 'bad-response'
  /** The source is set up wrongly (no client ID, not a WebDAV URL, ...). */
  | 'config';

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly status: number | null;
  /** Show the CORS help next to this error. */
  readonly corsHelp: boolean;

  constructor(code: SourceErrorCode, message: string, opts: { status?: number | null; corsHelp?: boolean } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.status = opts.status ?? null;
    this.corsHelp = opts.corsHelp ?? false;
  }
}

export function isSourceError(err: unknown, code?: SourceErrorCode): err is SourceError {
  return err instanceof SourceError && (code === undefined || err.code === code);
}

export function isAbort(err: unknown): boolean {
  return (err as Error | null)?.name === 'AbortError';
}

/** Secrets in a source config, for redaction. */
export function secretsOf(config: SourceConfig | null | undefined): string[] {
  if (!config) return [];
  const out: (string | null | undefined)[] = [];
  if (config.kind === 'webdav') {
    out.push(config.password);
    if (config.password || config.username) out.push(basicCredentials(config.username, config.password));
  }
  if (config.kind === 'gdrive' || config.kind === 'dropbox') out.push(config.tokens?.accessToken, config.tokens?.refreshToken);
  if (config.kind === 'libraria') out.push(config.token);
  return out.filter((s): s is string => !!s && s.length >= 3);
}

/** Replace every secret (and anything that looks like a credential in a URL) with •••. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('•••');
  // user:password@host in URLs
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:[^/\s@]*@/gi, '$1•••@');
  // Bearer / Basic header values and token-ish query parameters
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 •••');
  out = out.replace(/([?&#](?:access_token|refresh_token|code|password|token)=)[^&\s]+/gi, '$1•••');
  return out;
}

/** A message safe to show: redacted, from any thrown value. */
export function errorMessage(err: unknown, config?: SourceConfig | null): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redact(raw, secretsOf(config));
}

/** Base64 of `user:password` as UTF-8 (btoa alone only takes Latin-1). */
export function basicCredentials(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Map an HTTP status to a code, for drivers without a better mapping. */
export function codeForStatus(status: number): SourceErrorCode {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  return 'bad-response';
}
