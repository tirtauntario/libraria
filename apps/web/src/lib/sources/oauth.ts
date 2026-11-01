/**
 * OAuth 2 redirect plumbing shared by Google Drive (token flow) and Dropbox
 * (code flow with PKCE).
 *
 * The app navigates the whole page to the provider (popups are unreliable in
 * installed PWAs) and comes back to `redirectUri()` = origin + path, with
 * the result in the fragment (`#access_token=…&state=…`) or the query
 * (`?code=…&state=…`). `captureOAuthRedirect()` runs before the hash router
 * starts (first import in main.ts): it checks `state` against what we stored
 * before leaving (CSRF protection), removes the parameters from the address
 * bar and restores the route the user was on. The result is finished later
 * by `oauth-flow.ts` once the database is open.
 *
 * Nothing here logs tokens or codes.
 */

export type OAuthProvider = 'gdrive' | 'dropbox';

export interface PendingAuth {
  state: string;
  provider: OAuthProvider;
  /** 'setup': a new source is being added; 'reauth': refresh an existing source's tokens. */
  purpose: 'setup' | 'reauth';
  sourceId?: string;
  /** Hash route to restore, e.g. '#/libraries?add=gdrive'. */
  returnTo: string;
  clientId: string;
  /** PKCE code verifier (Dropbox). */
  verifier?: string;
  /** The attempt used prompt=none; on "interaction required" retry interactively. */
  silent?: boolean;
  createdAt: number;
}

export interface CapturedRedirect {
  pending: PendingAuth;
  /** All parameters the provider returned (access_token, code, error, ...). */
  params: Record<string, string>;
}

export interface CaptureFailure {
  error: string;
}

const STORE_KEY = 'libraria:oauth:pending';
const MAX_AGE = 15 * 60 * 1000;

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readPending(): PendingAuth[] {
  try {
    const raw = storage()?.getItem(STORE_KEY);
    const list = raw ? (JSON.parse(raw) as PendingAuth[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingAuth[]): void {
  try {
    if (list.length) storage()?.setItem(STORE_KEY, JSON.stringify(list));
    else storage()?.removeItem(STORE_KEY);
  } catch {
    // storage full or blocked: the redirect will fail its state check
  }
}

export function savePending(p: PendingAuth, now = Date.now()): void {
  const list = readPending().filter((x) => now - x.createdAt < MAX_AGE && x.state !== p.state);
  list.push(p);
  writePending(list);
}

/** Remove and return the pending request for `state`, if it exists and is fresh. */
export function takePending(state: string, now = Date.now()): PendingAuth | null {
  const list = readPending();
  const hit = list.find((x) => x.state === state) ?? null;
  writePending(list.filter((x) => x !== hit && now - x.createdAt < MAX_AGE));
  if (!hit || now - hit.createdAt >= MAX_AGE) return null;
  return hit;
}

// --- random values and PKCE ----------------------------------------------------

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe random string from `bytes` random bytes (default 32 → 43 chars). */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  // 64 random bytes → 86 characters, inside RFC 7636's 43..128.
  const verifier = randomToken(64);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

// --- redirect ------------------------------------------------------------------

/** The redirect URI to register with Google / Dropbox: this page without query or fragment. */
export function redirectUri(loc: Pick<Location, 'origin' | 'pathname'> = location): string {
  return loc.origin + loc.pathname;
}

/**
 * OAuth parameters in a URL, if any. Fragment responses (token flow) carry
 * access_token or error; query responses (code flow) carry code or error.
 * Both need `state`. Ordinary hash routes ('#/book/…') are ignored.
 */
export function parseRedirect(href: string): { params: Record<string, string>; where: 'fragment' | 'query' } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const frag = url.hash.replace(/^#/, '');
  if (frag && !frag.startsWith('/')) {
    const p = new URLSearchParams(frag);
    if (p.has('state') && (p.has('access_token') || p.has('error'))) return { params: Object.fromEntries(p), where: 'fragment' };
  }
  const q = url.searchParams;
  if (q.has('state') && (q.has('code') || q.has('error'))) return { params: Object.fromEntries(q), where: 'query' };
  return null;
}

let captured: CapturedRedirect | CaptureFailure | null = null;

/**
 * Look for an OAuth response in the current URL. If there is one, verify its
 * state, clean the URL and restore the saved route. Call before the router.
 */
export function captureOAuthRedirect(
  win: { location: Location; history: History } = window,
  now = Date.now(),
): CapturedRedirect | CaptureFailure | null {
  const hit = parseRedirect(win.location.href);
  if (!hit) return null;
  const state = hit.params.state ?? '';
  const pending = takePending(state, now);
  const returnTo = pending?.returnTo && pending.returnTo.startsWith('#/') ? pending.returnTo : '#/';
  // Drop ?code=… / #access_token=… from the address bar and history.
  win.history.replaceState(null, '', win.location.pathname + returnTo);
  captured = pending
    ? { pending, params: hit.params }
    : { error: 'The sign-in response did not match a request from this app, so it was ignored. Please try again.' };
  return captured;
}

/** The redirect captured at startup, once. */
export function takeCapturedRedirect(): CapturedRedirect | CaptureFailure | null {
  const c = captured;
  captured = null;
  return c;
}

/** Leave for the provider's authorization page. */
export function navigateTo(url: string): void {
  location.assign(url);
}

/** Current hash route, to come back to after the redirect. */
export function currentRoute(): string {
  return location.hash && location.hash.startsWith('#/') ? location.hash : '#/';
}
