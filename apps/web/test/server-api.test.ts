import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerApi, ServerError, type FetchLike } from '../src/lib/server/api';
import { inviteLink, isMixedContent, normalizeServerUrl, ServerUrlError } from '../src/lib/server/url';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function api(fetch: FetchLike, extra: Partial<ConstructorParameters<typeof ServerApi>[0]> = {}) {
  return new ServerApi({ baseUrl: 'https://books.example.org', token: 'tok-1234567890abcdef', fetch, isOnline: () => true, ...extra });
}

describe('normalizeServerUrl', () => {
  it.each([
    ['books.example.org', 'https://books.example.org'],
    ['https://books.example.org/', 'https://books.example.org'],
    ['https://books.example.org/api/v1/info', 'https://books.example.org'],
    ['https://host.example/libraria/index.html', 'https://host.example/libraria'],
    ['localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:4318/#/join', 'http://127.0.0.1:4318'],
    ['  HTTPS://Books.Example.org  ', 'https://books.example.org'],
  ])('%s → %s', (input, out) => {
    expect(normalizeServerUrl(input)).toBe(out);
  });

  it('requires https except for localhost', () => {
    expect(() => normalizeServerUrl('http://192.168.1.20:8080')).toThrow(ServerUrlError);
    expect(() => normalizeServerUrl('http://192.168.1.20:8080')).toThrow(/HTTPS/);
    expect(() => normalizeServerUrl('ftp://x')).toThrow(ServerUrlError);
    expect(() => normalizeServerUrl('')).toThrow(ServerUrlError);
    expect(() => normalizeServerUrl('https://user:pw@host')).toThrow(ServerUrlError);
  });

  it('detects mixed content and builds invite links', () => {
    expect(isMixedContent('http://localhost:8080', 'https:')).toBe(true);
    expect(isMixedContent('http://localhost:8080', 'http:')).toBe(false);
    expect(isMixedContent('https://x', 'https:')).toBe(false);
    expect(inviteLink('https://app.example/#/servers', 'https://books.example.org', 'a b')).toBe(
      'https://app.example/#/join?server=https%3A%2F%2Fbooks.example.org&invite=a%20b',
    );
  });
});

describe('ServerApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bearer token and parses JSON', async () => {
    const fetch = vi.fn<FetchLike>(async () => json(200, { id: 'u', username: 'ann', role: 'member', status: 'active', createdAt: 1 }));
    const me = await api(fetch).me();
    expect(me.username).toBe('ann');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://books.example.org/api/v1/me');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-1234567890abcdef');
  });

  it('maps API errors to ServerError with the server code', async () => {
    const fetch: FetchLike = async () => json(403, { error: 'quota_exceeded', message: 'Too much' });
    const err = await api(fetch).createSubmission({} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 403, code: 'quota_exceeded', message: 'Too much', transient: false });
  });

  it('keeps extra error fields (duplicate)', async () => {
    const fetch: FetchLike = async () => json(409, { error: 'duplicate', message: 'dup', bookId: 'b1', submissionId: null });
    const err = (await api(fetch).createSubmission({} as never).catch((e: unknown) => e)) as ServerError;
    expect(err.code).toBe('duplicate');
    expect(err.body).toMatchObject({ bookId: 'b1' });
  });

  it('reports 401 with a token as an expired session, but not on login', async () => {
    const onUnauthorized = vi.fn();
    const fetch: FetchLike = async () => json(401, { error: 'unauthorized', message: 'Session expired or invalid' });
    const err = await api(fetch, { onUnauthorized }).me().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized', message: expect.stringMatching(/Sign in again/) });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    const login = await api(fetch, { onUnauthorized }).login({ username: 'a', authHash: 'x' }).catch((e: unknown) => e);
    expect(login).toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('fails fast offline without calling fetch', async () => {
    const fetch = vi.fn<FetchLike>();
    const err = await api(fetch, { isOnline: () => false }).me().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'offline', transient: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps network failures, timeouts and aborts', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await api(down).me().catch((e: unknown) => e)).toMatchObject({ code: 'network', transient: true });

    vi.stubGlobal('location', { protocol: 'https:' });
    const insecure = new ServerApi({ baseUrl: 'http://localhost:8080', fetch: down, isOnline: () => true });
    expect(await insecure.info().catch((e: unknown) => e)).toMatchObject({ code: 'mixed_content' });
    vi.unstubAllGlobals();

    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    expect(await api(hang, { timeoutMs: 20 }).me().catch((e: unknown) => e)).toMatchObject({ code: 'timeout' });

    const ctrl = new AbortController();
    const p = api(hang).listBooks({}, ctrl.signal).catch((e: unknown) => e);
    ctrl.abort();
    expect(await p).toMatchObject({ name: 'AbortError' });
  });

  it('explains rate limits and server errors', async () => {
    const limited: FetchLike = async () => json(429, { error: 'rate_limited', message: 'slow down' }, { 'Retry-After': '30' });
    expect(await api(limited).me().catch((e: unknown) => e)).toMatchObject({ code: 'rate_limited', message: expect.stringMatching(/30 s/), transient: true });
    const broken: FetchLike = async () => new Response('oops', { status: 502 });
    expect(await api(broken).me().catch((e: unknown) => e)).toMatchObject({ status: 502, code: 'internal', transient: true });
  });

  it('returns null for sync keys that were never set up and sends the replace header', async () => {
    const calls: [string, RequestInit][] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push([url, init!]);
      if (init?.method === 'GET') return json(404, { error: 'not_found', message: 'Sync is not set up' });
      return json(200, JSON.parse(String(init!.body)));
    };
    const a = api(fetch);
    expect(await a.getSyncKeys()).toBeNull();
    await a.putSyncKeys({ wrappedDataKey: 'a'.repeat(20), wrappedRecoveryKey: 'b'.repeat(20) }, true);
    expect((calls[1]![1].headers as Record<string, string>)['X-Libraria-Replace-Keys']).toBe('1');
  });

  it('upload chunks: offset from the header, 409 returns the server offset', async () => {
    let n = 0;
    const fetch: FetchLike = async (_url, init) => {
      const headers = init!.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/offset+octet-stream');
      n++;
      if (n === 1) return new Response(null, { status: 204, headers: { 'Upload-Offset': '5' } });
      return json(409, { error: 'conflict', message: 'offset', offset: 3 }, { 'Upload-Offset': '3' });
    };
    const a = api(fetch);
    expect(await a.uploadChunk('s1', 0, new Blob(['hello']))).toEqual({ offset: 5 });
    expect(await a.uploadChunk('s1', 5, new Blob(['world']))).toEqual({ conflict: 3 });
  });

  it('follows book list cursors', async () => {
    const pages: Record<string, unknown> = {
      '': { items: [{ id: '3' }, { id: '2' }], nextCursor: '2' },
      '2': { items: [{ id: '1' }], nextCursor: null },
    };
    const fetch: FetchLike = async (url) => json(200, pages[new URL(url).searchParams.get('cursor') ?? '']);
    expect((await api(fetch).allBooks(undefined, 2)).map((b) => b.id)).toEqual(['3', '2', '1']);
  });
});
