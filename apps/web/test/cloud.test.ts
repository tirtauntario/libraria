import type { DropboxConfig, GdriveConfig, Source } from '@libraria/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanSource } from '../src/lib/library/scan';
import { DropboxDriver, dropboxApiArg, dropboxPath, mapDropboxError } from '../src/lib/sources/dropbox';
import { SourceError } from '../src/lib/sources/errors';
import { GdriveDriver, gdriveAuthError, mapGoogleError } from '../src/lib/sources/gdrive';
import { streamToBlob } from '../src/lib/sources/http';
import type { SourceEntry } from '../src/lib/sources/types';
import { FetchMock, bytesOf, flakyBody, json } from './fetch-mock';
import { testServices } from './helpers';

async function collect(it: AsyncIterable<SourceEntry>): Promise<SourceEntry[]> {
  const out: SourceEntry[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const src = (config: Source['config']): Source => ({ id: 'src', name: 'X', config, createdAt: 0, updatedAt: 0, deleted: false });

let mock: FetchMock;
beforeEach(() => (mock = new FetchMock()));
afterEach(() => mock.restore());

// --- Google Drive ------------------------------------------------------------------

const gcfg = (over: Partial<GdriveConfig> = {}): GdriveConfig => ({
  clientId: 'cid',
  rootFolderId: 'ROOT',
  rootFolderName: 'Books',
  tokens: { accessToken: 'ya29.token', refreshToken: null, expiresAt: Date.now() + 3600_000 },
  ...over,
});

describe('Google Drive driver', () => {
  it('lists children with paging, skips Google Docs, keeps ids as paths and names as display paths', async () => {
    mock.on('GET', /\/drive\/v3\/files\?/, (call) => {
      const q = new URL(call.url).searchParams;
      expect(call.headers.authorization).toBe('Bearer ya29.token');
      expect(q.get('fields')).toContain('md5Checksum');
      expect(q.get('fields')).toContain('nextPageToken');
      if (q.get('q') === "'ROOT' in parents and trashed=false") {
        if (!q.get('pageToken')) {
          return json({
            nextPageToken: 'P2',
            files: [
              { id: 'F1', name: 'Manga', mimeType: 'application/vnd.google-apps.folder' },
              { id: 'D1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
            ],
          });
        }
        expect(q.get('pageToken')).toBe('P2');
        return json({
          files: [{ id: 'B1', name: 'Reading Room.epub', mimeType: 'application/epub+zip', size: '1234', modifiedTime: '2026-10-01T10:00:00.000Z', md5Checksum: 'abc' }],
        });
      }
      if (q.get('q') === "'F1' in parents and trashed=false") {
        return json({ files: [{ id: 'C1', name: 'Vol 1.cbz', mimeType: 'application/zip', size: '99', modifiedTime: '2026-10-02T00:00:00Z', md5Checksum: 'm1' }] });
      }
      return json({ files: [] });
    });
    const d = new GdriveDriver(src({ kind: 'gdrive', ...gcfg() }), gcfg());
    const root = await collect(d.list(''));
    expect(root).toEqual([
      { path: 'F1', name: 'Manga', isDir: true, size: null, mtime: null, etag: null, displayPath: 'Manga' },
      { path: 'B1', name: 'Reading Room.epub', isDir: false, size: 1234, mtime: Date.parse('2026-10-01T10:00:00Z'), etag: 'abc', displayPath: 'Reading Room.epub' },
    ]);
    expect(await collect(d.list('F1'))).toEqual([expect.objectContaining({ path: 'F1/C1', name: 'Vol 1.cbz', displayPath: 'Manga/Vol 1.cbz', etag: 'm1', size: 99 })]);
  });

  it('feeds scanSource: placeholders keep the readable name', async () => {
    const s = await testServices();
    mock.on('GET', /\/drive\/v3\/files\?/, (call) => {
      const q = new URL(call.url).searchParams.get('q');
      if (q?.startsWith("'ROOT'")) return json({ files: [{ id: 'F1', name: 'Manga', mimeType: 'application/vnd.google-apps.folder' }] });
      return json({ files: [{ id: 'C1', name: 'Vol 1.cbz', mimeType: 'application/zip', size: '99', md5Checksum: 'm1' }] });
    });
    const { registerSourceKind } = await import('../src/lib/sources');
    registerSourceKind({
      kind: 'gdrive',
      label: 'Drive',
      description: '',
      deviceOnly: false,
      implemented: true,
      userCreatable: true,
      isSupported: () => true,
      createDriver: (source) => new GdriveDriver(source, source.config as GdriveConfig),
    });
    const source = await s.repo.createSource('Drive', { kind: 'gdrive', ...gcfg() });
    expect(await scanSource(source, '', s)).toMatchObject({ added: 1 });
    const [file] = await s.repo.listFilesBySource(source.id);
    expect(file).toMatchObject({ path: 'F1/C1', displayPath: 'Manga/Vol 1.cbz', etag: 'm1' });
    expect((await s.repo.listBooks())[0]?.title).toBe('Vol 1');
  });

  it('downloads with alt=media and resumes with Range', async () => {
    const data = bytesOf(6000);
    mock.on('GET', /\/files\/C1\?alt=media/, () => new Response(flakyBody(data, 3000), { headers: { 'Content-Length': '6000' } }), { once: true });
    mock.on('GET', /\/files\/C1\?alt=media/, (call) => {
      expect(call.headers.range).toBe('bytes=3000-');
      return new Response(data.slice(3000), { status: 206, headers: { 'Content-Range': 'bytes 3000-5999/6000' } });
    });
    const d = new GdriveDriver(src({ kind: 'gdrive', ...gcfg() }), gcfg());
    const blob = await streamToBlob((await d.readStream('F1/C1')).stream);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
  });

  it('refuses expired tokens before calling Google', async () => {
    const expired = gcfg({ tokens: { accessToken: 'old', expiresAt: Date.now() - 1 } });
    const d = new GdriveDriver(src({ kind: 'gdrive', ...expired }), expired);
    await expect(collect(d.list(''))).rejects.toMatchObject({ code: 'auth' });
    expect(mock.calls).toHaveLength(0);
    const none = gcfg({ tokens: null });
    await expect(collect(new GdriveDriver(src({ kind: 'gdrive', ...none }), none).list(''))).rejects.toMatchObject({ code: 'auth' });
  });

  it('maps Drive API errors', async () => {
    const err = (status: number, reason: string, message = '') =>
      mapGoogleError(json({ error: { code: status, message, errors: [{ reason }] } }, status));
    expect(await err(401, 'authError')).toMatchObject({ code: 'auth' });
    expect(await err(403, 'userRateLimitExceeded')).toMatchObject({ code: 'rate-limit' });
    expect(await err(429, 'rateLimitExceeded')).toMatchObject({ code: 'rate-limit' });
    expect(await err(403, 'accessNotConfigured', 'Google Drive API has not been used in project 1')).toMatchObject({ code: 'config' });
    expect(await err(403, 'insufficientPermissions')).toMatchObject({ code: 'auth' });
    expect(await err(403, 'cannotDownloadFile')).toMatchObject({ code: 'forbidden' });
    expect(await err(404, 'notFound')).toMatchObject({ code: 'not-found' });
    expect(await mapGoogleError(new Response('oops', { status: 502 }))).toMatchObject({ code: 'server' });
    expect(gdriveAuthError('interaction_required')).toMatchObject({ code: 'auth' });
  });
});

// --- Dropbox -------------------------------------------------------------------------

const dcfg = (over: Partial<DropboxConfig> = {}): DropboxConfig => ({
  appKey: 'appkey',
  rootPath: '/Books',
  tokens: { accessToken: 'sl.old', refreshToken: 'R1', expiresAt: Date.now() + 3600_000 },
  ...over,
});

describe('Dropbox driver', () => {
  it('encodes Dropbox-API-Arg as ASCII JSON', () => {
    expect(dropboxApiArg({ path: '/Bücher/日本.cbz' })).toBe('{"path":"/B\\u00fccher/\\u65e5\\u672c.cbz"}');
    expect(dropboxApiArg({ path: '/😀.epub' })).toBe('{"path":"/\\ud83d\\ude00.epub"}');
    expect(JSON.parse(dropboxApiArg({ path: '/Bücher/😀' }))).toEqual({ path: '/Bücher/😀' });
    expect(dropboxApiArg({ path: '/a\u007fb' })).toBe('{"path":"/a\\u007fb"}');
  });

  it('builds API paths from the root and a relative path', () => {
    expect(dropboxPath('', '')).toBe('');
    expect(dropboxPath('/Books/', 'Manga/v1.cbz')).toBe('/Books/Manga/v1.cbz');
    expect(dropboxPath('', 'x')).toBe('/x');
  });

  it('lists with list_folder + continue, relative to the root, case-insensitively', async () => {
    mock.on('POST', 'https://api.dropboxapi.com/2/files/list_folder', (call) => {
      expect(JSON.parse(call.body!)).toMatchObject({ path: '/Books', recursive: false });
      expect(call.headers.authorization).toBe('Bearer sl.old');
      return json({
        entries: [
          { '.tag': 'folder', name: 'Manga', path_lower: '/books/manga', path_display: '/Books/Manga', id: 'id:1' },
          { '.tag': 'deleted', name: 'old.cbz', path_lower: '/books/old.cbz', path_display: '/Books/old.cbz' },
        ],
        cursor: 'C1',
        has_more: true,
      });
    });
    mock.on('POST', 'https://api.dropboxapi.com/2/files/list_folder/continue', (call) => {
      expect(JSON.parse(call.body!)).toEqual({ cursor: 'C1' });
      return json({
        entries: [
          {
            '.tag': 'file',
            name: 'Café.epub',
            path_lower: '/books/café.epub',
            path_display: '/books/Café.epub',
            size: 321,
            server_modified: '2026-10-03T12:00:00Z',
            content_hash: 'h1',
          },
        ],
        cursor: 'C2',
        has_more: false,
      });
    });
    const d = new DropboxDriver(src({ kind: 'dropbox', ...dcfg() }), dcfg());
    expect(await collect(d.list(''))).toEqual([
      { path: 'Manga', name: 'Manga', isDir: true, size: null, mtime: null, etag: null },
      { path: 'Café.epub', name: 'Café.epub', isDir: false, size: 321, mtime: Date.parse('2026-10-03T12:00:00Z'), etag: 'h1' },
    ]);
  });

  it('refreshes an expired access token once, retries, and saves the new token', async () => {
    const s = await testServices();
    const source = await s.repo.createSource('Dropbox', { kind: 'dropbox', ...dcfg() });
    let listCalls = 0;
    mock.on('POST', 'https://api.dropboxapi.com/2/files/list_folder', (call) => {
      listCalls++;
      if (call.headers.authorization === 'Bearer sl.old') return json({ error_summary: 'expired_access_token/..', error: { '.tag': 'expired_access_token' } }, 401);
      expect(call.headers.authorization).toBe('Bearer sl.new');
      return json({ entries: [], cursor: 'c', has_more: false });
    });
    mock.on('POST', 'https://api.dropboxapi.com/oauth2/token', (call) => {
      expect(Object.fromEntries(new URLSearchParams(call.body!))).toEqual({ grant_type: 'refresh_token', refresh_token: 'R1', client_id: 'appkey' });
      return json({ access_token: 'sl.new', expires_in: 14400 });
    });
    const d = new DropboxDriver(source, source.config as DropboxConfig, s.repo);
    expect(await collect(d.list(''))).toEqual([]);
    expect(listCalls).toBe(2);
    const saved = await s.repo.getSource(source.id);
    expect(saved?.config).toMatchObject({ tokens: { accessToken: 'sl.new', refreshToken: 'R1' } });
  });

  it('refreshes ahead of time when the stored token has lapsed', async () => {
    const lapsed = dcfg({ tokens: { accessToken: 'sl.old', refreshToken: 'R1', expiresAt: Date.now() - 1000 } });
    mock.on('POST', /oauth2\/token/, () => json({ access_token: 'sl.new', expires_in: 14400 }));
    mock.on('POST', /files\/list_folder$/, (call) => {
      expect(call.headers.authorization).toBe('Bearer sl.new');
      return json({ entries: [], cursor: 'c', has_more: false });
    });
    await collect(new DropboxDriver(src({ kind: 'dropbox', ...lapsed }), lapsed).list(''));
    expect(mock.calls.map((c) => c.url)).toEqual(['https://api.dropboxapi.com/oauth2/token', 'https://api.dropboxapi.com/2/files/list_folder']);
  });

  it('asks to sign in again when the refresh token is revoked', async () => {
    const lapsed = dcfg({ tokens: { accessToken: 'sl.old', refreshToken: 'R1', expiresAt: 1 } });
    mock.on('POST', /oauth2\/token/, () => json({ error: 'invalid_grant' }, 400));
    await expect(collect(new DropboxDriver(src({ kind: 'dropbox', ...lapsed }), lapsed).list(''))).rejects.toMatchObject({ code: 'auth' });
  });

  it('downloads with Dropbox-API-Arg and resumes with Range', async () => {
    const data = bytesOf(5000, 11);
    mock.on('POST', 'https://content.dropboxapi.com/2/files/download', (call) => {
      expect(call.headers['dropbox-api-arg']).toBe('{"path":"/Books/Manga/\\u4e00.cbz"}');
      expect(call.headers['content-type']).toBeUndefined();
      expect(call.headers.range).toBeUndefined();
      return new Response(flakyBody(data, 2000), { headers: { 'Content-Length': '5000' } });
    }, { once: true });
    mock.on('POST', 'https://content.dropboxapi.com/2/files/download', (call) => {
      expect(call.headers.range).toBe('bytes=2000-');
      return new Response(data.slice(2000), { status: 206, headers: { 'Content-Range': 'bytes 2000-4999/5000' } });
    });
    const d = new DropboxDriver(src({ kind: 'dropbox', ...dcfg() }), dcfg());
    const progress: number[] = [];
    const blob = await d.read('Manga/一.cbz', { onProgress: (n) => progress.push(n) });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
    expect(progress.at(-1)).toBe(5000);
  });

  it('maps Dropbox API errors', async () => {
    const err = (status: number, summary: string, headers: Record<string, string> = {}) =>
      mapDropboxError(json({ error_summary: summary, error: {} }, status, headers));
    expect(await err(409, 'path/not_found/..')).toMatchObject({ code: 'not-found' });
    expect(await err(409, 'path/not_folder/..')).toMatchObject({ code: 'config' });
    expect(await err(409, 'path/restricted_content/')).toMatchObject({ code: 'forbidden' });
    expect(await err(429, 'too_many_requests/', { 'Retry-After': '30' })).toMatchObject({ code: 'rate-limit', message: expect.stringContaining('30 s') });
    expect(await err(401, 'invalid_access_token/')).toMatchObject({ code: 'auth', expired: false });
    expect(await err(401, 'expired_access_token/')).toMatchObject({ code: 'auth', expired: true });
    expect(await mapDropboxError(new Response('Error in call to API function "files/download": Bad HTTP "Content-Type" header', { status: 400 }))).toMatchObject({
      code: 'config',
    });
    expect(await err(500, '')).toBeInstanceOf(SourceError);
  });
});
