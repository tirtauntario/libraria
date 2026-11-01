/**
 * A small read-only WebDAV server for the e2e tests: OPTIONS, PROPFIND
 * (Depth 0/1), GET and HEAD with Range, Basic auth, and CORS that can be
 * switched off to test the error the app shows.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DavServer {
  /** Base URL of the share, e.g. http://127.0.0.1:1234/dav/ */
  url: string;
  requests: { method: string; path: string; range?: string }[];
  /** Make the next GET of a file drop the connection after `bytes`. */
  dropNextGetAfter(bytes: number): void;
  close(): Promise<void>;
}

export interface DavOptions {
  files: Record<string, Buffer>;
  cors?: boolean;
  user?: string;
  password?: string;
  prefix?: string;
}

const MTIME = new Date('2026-10-01T12:00:00Z');

export async function startWebdav(opts: DavOptions): Promise<DavServer> {
  const prefix = opts.prefix ?? '/dav/';
  const cors = opts.cors ?? true;
  const requests: DavServer['requests'] = [];
  let dropAfter: number | null = null;

  // Folder set derived from the file paths.
  const dirs = new Set<string>(['']);
  for (const p of Object.keys(opts.files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }

  const etag = (p: string) => `"${opts.files[p]!.length.toString(16)}-${Buffer.from(p).toString('hex').slice(0, 8)}"`;
  const href = (p: string, dir: boolean) =>
    prefix + p.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (dir && p ? '/' : '');

  function corsHeaders(req: IncomingMessage): Record<string, string> {
    if (!cors) return {};
    return {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, PROPFIND',
      'Access-Control-Allow-Headers': 'Authorization, Depth, Content-Type, Range, If-Range',
      'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Range, Accept-Ranges',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  function authorized(req: IncomingMessage): boolean {
    if (!opts.user) return true;
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return false;
    return Buffer.from(h.slice(6), 'base64').toString('utf8') === `${opts.user}:${opts.password ?? ''}`;
  }

  function entryXml(p: string): string {
    const isDir = dirs.has(p);
    const props = isDir
      ? '<d:resourcetype><d:collection/></d:resourcetype>'
      : `<d:resourcetype/><d:getcontentlength>${opts.files[p]!.length}</d:getcontentlength><d:getetag>${etag(p)}</d:getetag><d:getcontenttype>application/octet-stream</d:getcontenttype>`;
    return (
      `<d:response><d:href>${href(p, isDir)}</d:href><d:propstat><d:prop>${props}<d:getlastmodified>${MTIME.toUTCString()}</d:getlastmodified></d:prop>` +
      '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
    );
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    requests.push({ method, path: decodeURIComponent(url.pathname), range: req.headers.range });
    const base = corsHeaders(req);

    if (method === 'OPTIONS') {
      res.writeHead(cors ? 204 : 200, { ...base, DAV: '1', Allow: 'OPTIONS, GET, HEAD, PROPFIND' });
      res.end();
      return;
    }
    if (!url.pathname.startsWith(prefix) && url.pathname !== prefix.slice(0, -1)) {
      res.writeHead(404, base).end();
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { ...base, 'WWW-Authenticate': 'Basic realm="books"' }).end();
      return;
    }
    const rel = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/+$/, '');

    if (method === 'PROPFIND') {
      if (!dirs.has(rel) && !(rel in opts.files)) {
        res.writeHead(404, base).end();
        return;
      }
      const depth = req.headers.depth ?? 'infinity';
      const items = [rel];
      if (depth === '1' && dirs.has(rel)) {
        const pre = rel ? rel + '/' : '';
        for (const d of dirs) if (d && d.startsWith(pre) && !d.slice(pre.length).includes('/')) items.push(d);
        for (const f of Object.keys(opts.files)) if (f.startsWith(pre) && !f.slice(pre.length).includes('/')) items.push(f);
      }
      // Drain the request body (the propfind XML) before answering.
      req.resume();
      req.on('end', () => {
        res.writeHead(207, { ...base, 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${items.map(entryXml).join('')}</d:multistatus>`);
      });
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const data = opts.files[rel];
      if (!data) {
        res.writeHead(404, base).end();
        return;
      }
      const headers: Record<string, string> = { ...base, ETag: etag(rel), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'Last-Modified': MTIME.toUTCString() };
      let start = 0;
      let end = data.length - 1;
      let status = 200;
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const ifRange = req.headers['if-range'];
      if (m && (!ifRange || ifRange === etag(rel))) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), end) : end;
        if (start > end) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${data.length}` }).end();
          return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
      }
      headers['Content-Length'] = String(end - start + 1);
      res.writeHead(status, headers);
      if (method === 'HEAD') {
        res.end();
        return;
      }
      const body = data.subarray(start, end + 1);
      if (dropAfter != null && dropAfter < body.length) {
        const cut = dropAfter;
        dropAfter = null;
        res.write(body.subarray(0, cut), () => setTimeout(() => res.destroy(), 50));
        return;
      }
      res.end(body);
      return;
    }
    res.writeHead(405, { ...base, Allow: 'OPTIONS, GET, HEAD, PROPFIND' }).end();
  }

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    requests,
    dropNextGetAfter: (bytes) => (dropAfter = bytes),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
