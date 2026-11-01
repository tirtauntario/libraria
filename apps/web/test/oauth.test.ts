import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  base64url,
  captureOAuthRedirect,
  parseRedirect,
  pkceChallenge,
  pkcePair,
  randomToken,
  redirectUri,
  savePending,
  takeCapturedRedirect,
  takePending,
  type PendingAuth,
} from '../src/lib/sources/oauth';
import { finishSignIn, oauthFlow, prepareSignIn, tokensFromCapture } from '../src/lib/sources/oauth-flow.svelte';
import { FetchMock, installLocalStorage, json } from './fetch-mock';
import { testServices } from './helpers';

const pending = (over: Partial<PendingAuth> = {}): PendingAuth => ({
  state: 'st4te',
  provider: 'gdrive',
  purpose: 'setup',
  returnTo: '#/libraries?add=gdrive',
  clientId: 'client.apps.googleusercontent.com',
  createdAt: Date.now(),
  ...over,
});

/** A window stand-in: just enough Location and History for capture. */
function fakeWindow(href: string) {
  const u = new URL(href);
  const replaced: string[] = [];
  return {
    replaced,
    location: { href: u.href, pathname: u.pathname, hash: u.hash, search: u.search, origin: u.origin } as unknown as Location,
    history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) } as unknown as History,
  };
}

beforeEach(() => {
  installLocalStorage();
  takeCapturedRedirect();
});

describe('PKCE and random values', () => {
  it('computes S256 challenges (checked against node:crypto)', async () => {
    for (const v of ['dBjftJeZ4CVP-mJ0kzOKQE4QJ3-ibrqVb8iBMtS4lsQ', randomToken(64)]) {
      expect(await pkceChallenge(v)).toBe(createHash('sha256').update(v).digest('base64url'));
    }
  });

  it('makes verifiers in the allowed length and alphabet', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(await pkceChallenge(verifier));
    expect(randomToken()).not.toBe(randomToken());
    expect(base64url(Uint8Array.from([251, 255, 254]))).toBe('-__-');
  });
});

describe('redirect parsing', () => {
  it('finds token responses in the fragment and code responses in the query', () => {
    expect(parseRedirect('https://app.example/#access_token=ya29&token_type=Bearer&expires_in=3599&state=abc')).toEqual({
      where: 'fragment',
      params: { access_token: 'ya29', token_type: 'Bearer', expires_in: '3599', state: 'abc' },
    });
    expect(parseRedirect('https://app.example/sub/?code=XYZ&state=abc')).toEqual({ where: 'query', params: { code: 'XYZ', state: 'abc' } });
    expect(parseRedirect('https://app.example/#error=access_denied&state=abc')?.params.error).toBe('access_denied');
  });

  it('ignores ordinary routes and parameters without state', () => {
    expect(parseRedirect('https://app.example/#/book/123?tab=x')).toBeNull();
    expect(parseRedirect('https://app.example/#access_token=1')).toBeNull();
    expect(parseRedirect('https://app.example/?code=1')).toBeNull();
    expect(parseRedirect('https://app.example/')).toBeNull();
  });

  it('uses origin + path as the redirect URI', () => {
    expect(redirectUri({ origin: 'https://h.example', pathname: '/libraria/' })).toBe('https://h.example/libraria/');
  });
});

describe('capture before the router', () => {
  it('accepts a response whose state matches, cleans the URL and restores the route', () => {
    savePending(pending());
    const w = fakeWindow('https://app.example/libraria/#access_token=ya29.tok&expires_in=3600&state=st4te');
    const c = captureOAuthRedirect(w);
    expect(c && 'pending' in c && c.params.access_token).toBe('ya29.tok');
    expect(w.replaced).toEqual(['/libraria/#/libraries?add=gdrive']);
    expect(takeCapturedRedirect()).toBe(c);
    expect(takeCapturedRedirect()).toBeNull();
    // The pending entry is single use.
    expect(takePending('st4te')).toBeNull();
  });

  it('rejects an unknown state (CSRF) and still cleans the URL', () => {
    savePending(pending());
    const w = fakeWindow('https://app.example/?code=evil&state=forged');
    const c = captureOAuthRedirect(w);
    expect(c).toEqual({ error: expect.stringMatching(/did not match/) });
    expect(w.replaced).toEqual(['/#/']);
    expect(takePending('st4te')).not.toBeNull(); // the real request is untouched
  });

  it('expires pending requests', () => {
    savePending(pending({ createdAt: Date.now() - 20 * 60 * 1000 }));
    expect(takePending('st4te')).toBeNull();
  });

  it('does nothing for ordinary URLs', () => {
    const w = fakeWindow('https://app.example/#/libraries');
    expect(captureOAuthRedirect(w)).toBeNull();
    expect(w.replaced).toEqual([]);
  });
});

describe('sign-in URLs', () => {
  it('builds a Google token-flow URL with state, read-only scope and optional prompt=none', async () => {
    const { url, pending: p } = await prepareSignIn(
      { provider: 'gdrive', clientId: 'cid', purpose: 'reauth', sourceId: 'src1', returnTo: '#/libraries', silent: true },
      'https://app.example/',
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'cid',
      redirect_uri: 'https://app.example/',
      response_type: 'token',
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      state: p.state,
      prompt: 'none',
    });
    expect(p).toMatchObject({ provider: 'gdrive', purpose: 'reauth', sourceId: 'src1', silent: true, returnTo: '#/libraries' });
    expect(p.state.length).toBeGreaterThanOrEqual(32);
  });

  it('builds a Dropbox PKCE URL with offline access and keeps the verifier', async () => {
    const { url, pending: p } = await prepareSignIn({ provider: 'dropbox', clientId: 'appkey', purpose: 'setup', returnTo: '#/libraries?add=dropbox' }, 'https://app.example/');
    const q = new URL(url).searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('token_access_type')).toBe('offline');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBe(await pkceChallenge(p.verifier!));
    expect(q.get('state')).toBe(p.state);
  });

  it('refuses to start without a client ID', async () => {
    await expect(prepareSignIn({ provider: 'gdrive', clientId: '', purpose: 'setup' }, 'https://a/')).rejects.toMatchObject({ code: 'config' });
  });
});

describe('finishing sign-in', () => {
  let mock: FetchMock;
  beforeEach(() => (mock = new FetchMock()));
  afterEach(() => mock.restore());

  it('turns a Google fragment into tokens with an expiry', async () => {
    const t = await tokensFromCapture({ pending: pending(), params: { access_token: 'ya29.a', expires_in: '3600', state: 'st4te' } }, 'https://a/', 1_000_000);
    expect(t).toEqual({ accessToken: 'ya29.a', refreshToken: null, expiresAt: 1_000_000 + 3540 * 1000 });
    await expect(tokensFromCapture({ pending: pending(), params: { error: 'access_denied', state: 'st4te' } }, 'https://a/')).rejects.toMatchObject({ code: 'auth' });
  });

  it('exchanges a Dropbox code with the PKCE verifier', async () => {
    mock.on('POST', 'https://api.dropboxapi.com/oauth2/token', (call) => {
      const form = new URLSearchParams(call.body ?? '');
      expect(Object.fromEntries(form)).toEqual({
        code: 'CODE',
        grant_type: 'authorization_code',
        client_id: 'appkey',
        redirect_uri: 'https://a/',
        code_verifier: 'VERIFIER',
      });
      return json({ access_token: 'sl.A', refresh_token: 'R1', expires_in: 14400, token_type: 'bearer' });
    });
    const c = { pending: pending({ provider: 'dropbox', clientId: 'appkey', verifier: 'VERIFIER' }), params: { code: 'CODE', state: 'st4te' } };
    expect(await tokensFromCapture(c, 'https://a/', 0)).toEqual({ accessToken: 'sl.A', refreshToken: 'R1', expiresAt: 14340 * 1000 });
  });

  it('maps a rejected code exchange', async () => {
    mock.on('POST', /oauth2\/token/, () => json({ error: 'invalid_grant', error_description: 'code doesn\'t exist or has expired' }, 400));
    const c = { pending: pending({ provider: 'dropbox', clientId: 'k', verifier: 'v' }), params: { code: 'old', state: 'st4te' } };
    await expect(tokensFromCapture(c, 'https://a/')).rejects.toMatchObject({ code: 'auth' });
  });

  it('hands setup tokens to the form, and writes reauth tokens into the source', async () => {
    const s = await testServices();
    savePending(pending());
    captureOAuthRedirect(fakeWindow('https://app.example/#access_token=ya29.new&expires_in=3600&state=st4te'));
    expect(await finishSignIn(s.repo)).toMatchObject({ ok: true, purpose: 'setup', provider: 'gdrive' });
    expect(oauthFlow.takeSetup('gdrive')).toMatchObject({ accessToken: 'ya29.new' });
    expect(oauthFlow.takeSetup('gdrive')).toBeNull();

    const src = await s.repo.createSource('Drive', {
      kind: 'gdrive',
      clientId: 'cid',
      rootFolderId: 'root',
      rootFolderName: 'My Drive',
      tokens: { accessToken: 'old', expiresAt: 1 },
    });
    savePending(pending({ state: 'again', purpose: 'reauth', sourceId: src.id }));
    captureOAuthRedirect(fakeWindow('https://app.example/#access_token=ya29.fresh&expires_in=3600&state=again'));
    expect(await finishSignIn(s.repo)).toMatchObject({ ok: true, purpose: 'reauth', sourceId: src.id });
    const after = await s.repo.getSource(src.id);
    expect(after?.config).toMatchObject({ kind: 'gdrive', tokens: { accessToken: 'ya29.fresh' } });
  });

  it('reports a forged redirect without touching anything', async () => {
    const s = await testServices();
    captureOAuthRedirect(fakeWindow('https://app.example/#access_token=evil&state=nope'));
    expect(await finishSignIn(s.repo)).toMatchObject({ ok: false, message: expect.stringMatching(/did not match/) });
    expect(oauthFlow.takeSetup('gdrive')).toBeNull();
  });
});
