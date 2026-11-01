import type { Source } from '@libraria/core';
import { DOMParser } from '@xmldom/xmldom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceError, basicCredentials, errorMessage, redact, secretsOf } from '../src/lib/sources/errors';
import { resumableStream, streamToBlob } from '../src/lib/sources/http';
import { WebdavDriver, decodePath, normalizeWebdavUrl, parseMultistatus, type XmlParser } from '../src/lib/sources/webdav';
import type { SourceEntry } from '../src/lib/sources/types';
import { FetchMock, bytesOf, flakyBody } from './fetch-mock';

const parser = new DOMParser() as unknown as XmlParser;

const NEXTCLOUD = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
 <d:response>
  <d:href>/remote.php/dav/files/alice/Books/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Mon, 12 Oct 2026 10:00:00 GMT</d:getlastmodified><d:getetag>&quot;6512a1&quot;</d:getetag></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat><d:prop><d:getcontentlength/><d:getcontenttype/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/files/alice/Books/Night%20Garden%20v01.cbz</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype/>
    <d:getcontentlength>48213</d:getcontentlength>
    <d:getlastmodified>Tue, 13 Oct 2026 08:30:00 GMT</d:getlastmodified>
    <d:getetag>&quot;a1b2c3&quot;</d:getetag>
    <d:getcontenttype>application/vnd.comicbook+zip</d:getcontenttype>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/files/alice/Books/Caf%C3%A9%20%26%20Co/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Tue, 13 Oct 2026 08:31:00 GMT</d:getlastmodified></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/files/alice/Books/100%25%20real.epub</d:href>
  <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>900</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

// Apache mod_dav: upper-case prefix, live properties in a second prefix bound to DAV:,
// full URLs and an unencoded space in one href.
const APACHE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:ns0="DAV:">
<D:response xmlns:lp1="DAV:" xmlns:lp2="http://apache.org/dav/props/">
<D:href>http://nas.local/dav/books/</D:href>
<D:propstat><D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype><lp1:getlastmodified>Tue, 01 Sep 2026 08:00:00 GMT</lp1:getlastmodified><lp1:getetag>"1000-5b2"</lp1:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>
<D:response xmlns:lp1="DAV:" xmlns:lp2="http://apache.org/dav/props/">
<D:href>http://nas.local/dav/books/The Reading Room.epub</D:href>
<D:propstat><D:prop><lp1:resourcetype/><lp1:getcontentlength>12345</lp1:getcontentlength><lp1:getlastmodified>Wed, 02 Sep 2026 09:15:00 GMT</lp1:getlastmodified><lp1:getetag>"3039-5b3"</lp1:getetag><lp2:executable>F</lp2:executable></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>
<D:response xmlns:lp1="DAV:">
<D:href>/dav/books/manga/</D:href>
<D:propstat><D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>
<D:response>
<D:href>/dav/books/gone.pdf</D:href>
<D:status>HTTP/1.1 404 Not Found</D:status>
</D:response>
</D:multistatus>`;

// nginx / lighttpd style: relative hrefs and no namespace prefix.
const RELATIVE = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
<response><href>./</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>field-notes.pdf</href><propstat><prop><getcontentlength>777</getcontentlength><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>sub%20folder/</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;

describe('WebDAV multistatus parsing', () => {
  it('parses Nextcloud responses: encoded hrefs, collections, 404 propstats', () => {
    const entries = parseMultistatus(NEXTCLOUD, 'https://cloud.example.com/remote.php/dav/files/alice/Books/', parser);
    expect(entries).toEqual([
      { path: '/remote.php/dav/files/alice/Books', isDir: true, size: null, mtime: Date.parse('2026-10-12T10:00:00Z'), etag: '"6512a1"', contentType: null },
      {
        path: '/remote.php/dav/files/alice/Books/Night Garden v01.cbz',
        isDir: false,
        size: 48213,
        mtime: Date.parse('2026-10-13T08:30:00Z'),
        etag: '"a1b2c3"',
        contentType: 'application/vnd.comicbook+zip',
      },
      { path: '/remote.php/dav/files/alice/Books/Café & Co', isDir: true, size: null, mtime: Date.parse('2026-10-13T08:31:00Z'), etag: null, contentType: null },
      { path: '/remote.php/dav/files/alice/Books/100% real.epub', isDir: false, size: 900, mtime: null, etag: null, contentType: null },
    ]);
  });

  it('parses Apache responses: other prefixes, absolute URLs, unencoded spaces, failed responses', () => {
    const entries = parseMultistatus(APACHE, 'http://nas.local/dav/books/', parser);
    expect(entries.map((e) => [e.path, e.isDir, e.size])).toEqual([
      ['/dav/books', true, null],
      ['/dav/books/The Reading Room.epub', false, 12345],
      ['/dav/books/manga', true, null],
    ]);
    expect(entries[1]!.etag).toBe('"3039-5b3"');
  });

  it('resolves relative hrefs and treats a trailing slash as a folder', () => {
    const entries = parseMultistatus(RELATIVE, 'https://h/webdav/lib/', parser);
    expect(entries.map((e) => [e.path, e.isDir, e.size])).toEqual([
      ['/webdav/lib', true, null],
      ['/webdav/lib/field-notes.pdf', false, 777],
      ['/webdav/lib/sub folder', true, null],
    ]);
  });

  it('rejects HTML and broken XML with a clear message', () => {
    expect(() => parseMultistatus('<html><body>Login</body></html>', 'https://h/', parser)).toThrow(/did not answer like a WebDAV server/);
    expect(() => parseMultistatus('<d:multistatus xmlns:d="DAV:"><d:response>', 'https://h/', parser)).toThrow(SourceError);
  });

  it('decodes paths safely', () => {
    expect(decodePath('/a%20b/%E2%9C%93/%ZZ')).toBe('/a b/✓/%ZZ');
  });

  it('normalises typed addresses and pulls out credentials', () => {
    expect(normalizeWebdavUrl('nas.local/dav')).toEqual({ url: 'https://nas.local/dav/' });
    expect(normalizeWebdavUrl('https://bob:s%3Acret@h.example/x/?q=1#f')).toEqual({ url: 'https://h.example/x/', username: 'bob', password: 's:cret' });
    expect(() => normalizeWebdavUrl('ftp://x')).toThrow(/http/);
    expect(() => normalizeWebdavUrl('   ')).toThrow(/Enter/);
  });
});

const source = (config: { url: string; username: string; password: string }): Source => ({
  id: 's1',
  name: 'NAS',
  config: { kind: 'webdav', ...config },
  createdAt: 0,
  updatedAt: 0,
  deleted: false,
});

async function collect(it: AsyncIterable<SourceEntry>): Promise<SourceEntry[]> {
  const out: SourceEntry[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('WebDAV driver', () => {
  let mock: FetchMock;
  beforeEach(() => (mock = new FetchMock()));
  afterEach(() => mock.restore());

  const cfg = { url: 'https://cloud.example.com/remote.php/dav/files/alice/Books', username: 'alice', password: 'pä55word' };

  it('lists a folder with PROPFIND Depth 1, Basic auth (UTF-8) and decoded relative paths', async () => {
    mock.on('PROPFIND', 'https://cloud.example.com/remote.php/dav/files/alice/Books/', () => new Response(NEXTCLOUD, { status: 207 }));
    const d = new WebdavDriver(source(cfg), cfg, parser);
    const entries = await collect(d.list(''));
    expect(entries).toEqual([
      expect.objectContaining({ path: 'Night Garden v01.cbz', name: 'Night Garden v01.cbz', isDir: false, size: 48213, etag: '"a1b2c3"' }),
      expect.objectContaining({ path: 'Café & Co', isDir: true }),
      expect.objectContaining({ path: '100% real.epub', size: 900 }),
    ]);
    const call = mock.calls[0]!;
    expect(call.headers.depth).toBe('1');
    expect(call.headers.authorization).toBe('Basic ' + basicCredentials('alice', 'pä55word'));
    expect(atob(call.headers.authorization!.slice(6))).toBe(String.fromCharCode(...new TextEncoder().encode('alice:pä55word')));
    expect(call.body).toContain('<d:propfind xmlns:d="DAV:">');
  });

  it('encodes sub-folder paths in requests', async () => {
    mock.on('PROPFIND', /Caf%C3%A9%20%26%20Co\/$/, () =>
      new Response(
        `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/alice/Books/Caf%C3%A9%20%26%20Co/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
          `<d:response><d:href>/remote.php/dav/files/alice/Books/Caf%C3%A9%20%26%20Co/%E4%B8%80.cbz</d:href><d:propstat><d:prop><d:getcontentlength>5</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        { status: 207 },
      ),
    );
    const d = new WebdavDriver(source(cfg), cfg, parser);
    expect((await collect(d.list('Café & Co'))).map((e) => e.path)).toEqual(['Café & Co/一.cbz']);
  });

  it('maps 401, 404, 405 and network failures to actionable errors', async () => {
    const d = new WebdavDriver(source(cfg), cfg, parser);
    mock.on('PROPFIND', /Books\/$/, () => new Response('', { status: 401 }), { once: true });
    await expect(d.test()).rejects.toMatchObject({ code: 'auth', message: expect.stringMatching(/username or password/) });
    mock.on('PROPFIND', /Books\/$/, () => new Response('', { status: 404 }), { once: true });
    await expect(d.test()).rejects.toMatchObject({ code: 'not-found' });
    mock.on('PROPFIND', /Books\/$/, () => new Response('', { status: 405 }), { once: true });
    await expect(d.test()).rejects.toMatchObject({ code: 'config', message: expect.stringMatching(/remote\.php\/dav/) });
    mock.on('PROPFIND', /Books\/$/, () => new Response('<html></html>', { status: 200 }), { once: true });
    await expect(d.test()).rejects.toMatchObject({ code: 'config' });
    mock.failNetwork(/Books\/$/);
    const err = await d.test().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ code: 'network', corsHelp: true, message: expect.stringMatching(/CORS/) });
    // Nothing secret in what the UI shows.
    expect(errorMessage(err, source(cfg).config)).not.toContain('pä55word');
  });

  it('downloads with progress and resumes with a Range request after a dropped connection', async () => {
    const data = bytesOf(10_000);
    mock.on('GET', /Night%20Garden%20v01\.cbz$/, () =>
      new Response(flakyBody(data, 4096), { status: 200, headers: { 'Content-Length': String(data.length), ETag: '"v1"' } }),
    { once: true });
    mock.on('GET', /Night%20Garden%20v01\.cbz$/, (call) => {
      expect(call.headers.range).toBe('bytes=4096-');
      expect(call.headers['if-range']).toBe('"v1"');
      return new Response(data.slice(4096), { status: 206, headers: { 'Content-Range': `bytes 4096-9999/${data.length}`, 'Content-Length': '5904' } });
    });
    const d = new WebdavDriver(source(cfg), cfg, parser);
    const seen: [number, number | null][] = [];
    const { stream, size } = await d.readStream('Night Garden v01.cbz', { onProgress: (l, t) => seen.push([l, t]) });
    expect(size).toBe(10_000);
    const blob = await streamToBlob(stream);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
    expect(seen.at(-1)).toEqual([10_000, 10_000]);
    expect(mock.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('restarts and skips received bytes when the server ignores Range', async () => {
    const data = bytesOf(5000, 3);
    let n = 0;
    const open = async () =>
      n++ === 0 ? new Response(flakyBody(data, 2048, 512), { headers: { 'Content-Length': '5000' } }) : new Response(data, { headers: { 'Content-Length': '5000' } });
    const { stream } = await resumableStream(open, { backoff: () => 0 });
    expect(new Uint8Array(await (await streamToBlob(stream)).arrayBuffer())).toEqual(data);
  });

  it('gives up after the retries and honours abort', async () => {
    const data = bytesOf(3000);
    const open = async () => new Response(flakyBody(data, 1000), { headers: { 'Content-Length': '3000' } });
    const { stream } = await resumableStream(open, { retries: 2, backoff: () => 0 });
    await expect(streamToBlob(stream)).rejects.toThrow();

    const ctrl = new AbortController();
    const slow = await resumableStream(async () => new Response(flakyBody(data, 3000, 100)), { signal: ctrl.signal });
    const reader = slow.stream.getReader();
    await reader.read();
    ctrl.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('redaction', () => {
  it('removes passwords, tokens and URL credentials', () => {
    const config = { kind: 'webdav' as const, url: 'https://h/', username: 'me', password: 'hunter22' };
    expect(redact('Failed for hunter22 at https://me:hunter22@h/x', secretsOf(config))).toBe('Failed for ••• at https://•••@h/x');
    expect(redact('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer •••');
    expect(redact('back to /#access_token=ya29.x&state=1')).toBe('back to /#access_token=•••&state=1');
    const drive = { kind: 'gdrive' as const, clientId: 'c', rootFolderId: 'r', rootFolderName: 'n', tokens: { accessToken: 'ya29.secret', refreshToken: null } };
    expect(errorMessage(new Error('token ya29.secret rejected'), drive)).toBe('token ••• rejected');
  });
});
