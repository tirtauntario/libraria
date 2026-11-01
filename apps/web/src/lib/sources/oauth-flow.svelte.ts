/**
 * Starting and finishing OAuth sign-ins for Drive and Dropbox sources.
 *
 * - `startSignIn()` stores a PendingAuth (state, PKCE verifier, where to come
 *   back to) and navigates to the provider.
 * - On return, `oauth.ts` captured the response before the router started;
 *   `finishSignIn()` (a startup hook) turns it into tokens: for a source
 *   being added they wait in `oauthFlow.setup` for the setup form; for an
 *   existing source they are written into its config.
 */
import type { OAuthTokens, Source } from '@libraria/core';
import type { Repo } from '../db/repo';
import { dropboxAuthError, dropboxAuthUrl, dropboxExchangeCode } from './dropbox';
import { SourceError, errorMessage } from './errors';
import { SILENT_RETRY_ERRORS, gdriveAuthUrl, gdriveTokensFromRedirect } from './gdrive';
import {
  currentRoute,
  navigateTo,
  pkcePair,
  randomToken,
  redirectUri,
  savePending,
  takeCapturedRedirect,
  type CapturedRedirect,
  type OAuthProvider,
  type PendingAuth,
} from './oauth';

class OAuthFlowState {
  /** Tokens for a source that is being added, by provider. */
  setup = $state<Partial<Record<OAuthProvider, OAuthTokens>>>({});
  /** Finishing a sign-in (Dropbox code exchange) is in progress. */
  busy = $state(false);
  /** Last sign-in error, per provider, for the setup form. */
  error = $state<Partial<Record<OAuthProvider, string>>>({});
  /** Source ids that just got new tokens (so the UI can rescan them). */
  lastReauthorized = $state<string | null>(null);

  takeSetup(provider: OAuthProvider): OAuthTokens | null {
    const t = this.setup[provider] ?? null;
    if (t) {
      const next = { ...this.setup };
      delete next[provider];
      this.setup = next;
    }
    return t;
  }
}

export const oauthFlow = new OAuthFlowState();

export interface SignInOptions {
  provider: OAuthProvider;
  clientId: string;
  purpose: 'setup' | 'reauth';
  sourceId?: string;
  /** Route to come back to; defaults to the current one. */
  returnTo?: string;
  /** Google only: try prompt=none first. */
  silent?: boolean;
}

/** Build the authorization URL and the pending record (pure apart from randomness; tested). */
export async function prepareSignIn(opts: SignInOptions, redirect: string, now = Date.now()): Promise<{ url: string; pending: PendingAuth }> {
  if (!opts.clientId) {
    throw new SourceError('config', opts.provider === 'gdrive' ? 'Enter a Google OAuth client ID first.' : 'Enter a Dropbox app key first.');
  }
  const state = randomToken(24);
  const pending: PendingAuth = {
    state,
    provider: opts.provider,
    purpose: opts.purpose,
    sourceId: opts.sourceId,
    returnTo: opts.returnTo ?? currentRoute(),
    clientId: opts.clientId,
    silent: opts.silent,
    createdAt: now,
  };
  let url: string;
  if (opts.provider === 'gdrive') {
    url = gdriveAuthUrl({ clientId: opts.clientId, redirectUri: redirect, state, silent: opts.silent });
  } else {
    const { verifier, challenge } = await pkcePair();
    pending.verifier = verifier;
    url = dropboxAuthUrl({ appKey: opts.clientId, redirectUri: redirect, state, challenge });
  }
  return { url, pending };
}

export async function startSignIn(opts: SignInOptions): Promise<void> {
  const { url, pending } = await prepareSignIn(opts, redirectUri());
  savePending(pending);
  navigateTo(url);
}

/** Sign an existing source in again (expired or revoked tokens). Drive tries silently first. */
export function reauthorize(source: Source, fallbackClientId = ''): Promise<void> {
  const c = source.config;
  if (c.kind === 'gdrive') {
    return startSignIn({ provider: 'gdrive', clientId: c.clientId || fallbackClientId, purpose: 'reauth', sourceId: source.id, silent: true });
  }
  if (c.kind === 'dropbox') {
    return startSignIn({ provider: 'dropbox', clientId: c.appKey || fallbackClientId, purpose: 'reauth', sourceId: source.id });
  }
  return Promise.reject(new Error('This source does not use sign-in.'));
}

export interface FinishResult {
  provider?: OAuthProvider;
  purpose?: 'setup' | 'reauth';
  sourceId?: string;
  ok: boolean;
  message?: string;
  /** A silent attempt needs the interactive flow; the page is navigating away. */
  redirecting?: boolean;
}

/** Turn a captured redirect into tokens. Exported for tests; the app calls finishSignIn(). */
export async function tokensFromCapture(c: CapturedRedirect, redirect: string, now = Date.now()): Promise<OAuthTokens> {
  const { pending, params } = c;
  if (pending.provider === 'gdrive') return gdriveTokensFromRedirect(params, now);
  if (params.error) throw dropboxAuthError(params.error, params.error_description);
  if (!params.code || !pending.verifier) throw new SourceError('bad-response', 'Dropbox did not return an authorization code.');
  return dropboxExchangeCode({ code: params.code, verifier: pending.verifier, appKey: pending.clientId, redirectUri: redirect }, now);
}

export async function finishSignIn(repo: Repo): Promise<FinishResult | null> {
  const c = takeCapturedRedirect();
  if (!c) return null;
  if ('error' in c) return { ok: false, message: c.error };
  const { pending, params } = c;
  const base = { provider: pending.provider, purpose: pending.purpose, sourceId: pending.sourceId };

  // prompt=none could not finish without the user: ask interactively.
  if (pending.provider === 'gdrive' && pending.silent && params.error && SILENT_RETRY_ERRORS.includes(params.error)) {
    await startSignIn({ ...pending, silent: false });
    return { ...base, ok: false, redirecting: true };
  }

  oauthFlow.busy = true;
  try {
    const tokens = await tokensFromCapture(c, redirectUri());
    if (pending.purpose === 'setup') {
      oauthFlow.setup = { ...oauthFlow.setup, [pending.provider]: tokens };
      oauthFlow.error = { ...oauthFlow.error, [pending.provider]: undefined };
      return { ...base, ok: true };
    }
    const src = pending.sourceId ? await repo.getSource(pending.sourceId) : undefined;
    if (!src || (src.config.kind !== 'gdrive' && src.config.kind !== 'dropbox')) {
      return { ...base, ok: false, message: 'The source to sign in to no longer exists.' };
    }
    await repo.updateSource(src.id, { config: { ...src.config, tokens } });
    oauthFlow.lastReauthorized = src.id;
    return { ...base, ok: true };
  } catch (err) {
    const message = errorMessage(err);
    if (pending.purpose === 'setup') oauthFlow.error = { ...oauthFlow.error, [pending.provider]: message };
    return { ...base, ok: false, message };
  } finally {
    oauthFlow.busy = false;
  }
}

