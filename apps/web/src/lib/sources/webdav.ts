/**
 * WebDAV source (Nextcloud, ownCloud, Apache mod_dav, nginx, NAS boxes).
 * Talks to the server straight from the browser, so the server must answer
 * CORS preflights for this origin (see WebdavSetup's help).
 *
 * Paths are '/'-separated and decoded, relative to the configured URL.
 */
import type { Source, WebdavConfig } from '@libraria/core';
import { SourceError, basicCredentials, codeForStatus } from './errors';
import { rangeHeaders, request, resumableStream, streamToBlob, type OpenRange } from './http';
import type { ListOptions, ReadOptions, SourceDriver, SourceEntry } from './types';

export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/>' +
  '</d:prop></d:propfind>';

const DAV = 'DAV:';

export interface DavEntry {
  /** Decoded absolute path from the href, without a trailing slash (except '/'). */
  path: string;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
  etag: string | null;
  contentType: string | null;
}

/** The parts of DOMParser this module uses (tests pass @xmldom/xmldom). */
export interface XmlParser {
  parseFromString(xml: string, type: 'application/xml'): Document;
}

function defaultParser(): XmlParser {
  if (typeof DOMParser === 'undefined') throw new Error('DOMParser is not available');
  return new DOMParser();
}

/** Decode a percent-encoded path one segment at a time; bad escapes are kept as is. */
export function decodePath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

export function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

function child(el: Element, name: string): Element | null {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 1 && (c as Element).namespaceURI === DAV && (c as Element).localName === name) return c as Element;
  }
  return null;
}

function text(el: Element | null): string | null {
  const t = el?.textContent?.trim();
  return t ? t : null;
}

function statusOk(statusText: string | null): boolean {
  if (!statusText) return true;
  const m = /\s(\d{3})(\s|$)/.exec(statusText);
  return !m || (Number(m[1]) >= 200 && Number(m[1]) < 300);
}

/**
 * Parse a 207 Multi-Status body. Hrefs may be absolute URLs, absolute
 * paths or relative to the request URL; they are resolved against
 * `requestUrl` and percent-decoded.
 */
export function parseMultistatus(xml: string, requestUrl: string, parser: XmlParser = defaultParser()): DavEntry[] {
  let doc: Document;
  try {
    doc = parser.parseFromString(xml, 'application/xml');
  } catch {
    throw new SourceError('bad-response', 'The server sent a response that is not valid WebDAV XML.');
  }
  const root = doc.documentElement;
  if (!root || root.localName === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
    throw new SourceError('bad-response', 'The server sent a response that is not valid WebDAV XML.');
  }
  if (root.namespaceURI !== DAV || root.localName !== 'multistatus') {
    throw new SourceError('bad-response', 'The server did not answer like a WebDAV server. Check the address.');
  }
  const out: DavEntry[] = [];
  for (const res of Array.from(root.childNodes)) {
    if (res.nodeType !== 1 || (res as Element).namespaceURI !== DAV || (res as Element).localName !== 'response') continue;
    const r = res as Element;
    const href = text(child(r, 'href'));
    if (!href) continue;
    if (!statusOk(text(child(r, 'status')))) continue;

    let url: URL;
    try {
      url = new URL(href, requestUrl);
    } catch {
      continue;
    }
    let isDir = false;
    let size: number | null = null;
    let mtime: number | null = null;
    let etag: string | null = null;
    let contentType: string | null = null;
    for (const ps of Array.from(r.childNodes)) {
      if (ps.nodeType !== 1 || (ps as Element).localName !== 'propstat' || (ps as Element).namespaceURI !== DAV) continue;
      if (!statusOk(text(child(ps as Element, 'status')))) continue;
      const prop = child(ps as Element, 'prop');
      if (!prop) continue;
      const rt = child(prop, 'resourcetype');
      if (rt && child(rt, 'collection')) isDir = true;
      const len = text(child(prop, 'getcontentlength'));
      if (len && /^\d+$/.test(len)) size = Number(len);
      const lm = text(child(prop, 'getlastmodified'));
      if (lm) {
        const t = Date.parse(lm);
        if (!Number.isNaN(t)) mtime = t;
      }
      etag = text(child(prop, 'getetag')) ?? etag;
      contentType = text(child(prop, 'getcontenttype')) ?? contentType;
    }
    // Some servers mark folders only by the trailing slash.
    if (!isDir && url.pathname.endsWith('/') && size == null) isDir = true;
    out.push({ path: trimSlash(decodePath(url.pathname)), isDir, size: isDir ? null : size, mtime, etag, contentType });
  }
  return out;
}

/** Normalise what the user typed: https default, trailing slash, credentials pulled out. */
export function normalizeWebdavUrl(input: string): { url: string; username?: string; password?: string } {
  let raw = input.trim();
  if (!raw) throw new SourceError('config', 'Enter the server address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError('config', 'That address is not a valid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SourceError('config', 'Use an http:// or https:// address.');
  const out: { url: string; username?: string; password?: string } = { url: '' };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  u.hash = '';
  u.search = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  out.url = u.toString();
  return out;
}

export class WebdavDriver implements SourceDriver {
  readonly isLocal = false;
  private readonly base: URL;
  private readonly auth: string | null;

  constructor(
    readonly source: Source,
    config: WebdavConfig,
    private readonly parser?: XmlParser,
  ) {
    this.base = new URL(normalizeWebdavUrl(config.url).url);
    this.auth = config.username || config.password ? 'Basic ' + basicCredentials(config.username, config.password) : null;
  }

  get host(): string {
    return this.base.host;
  }

  urlFor(path: string, dir: boolean): string {
    const enc = encodePath(path);
    return new URL(enc + (dir && enc ? '/' : ''), this.base).toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.auth ? { Authorization: this.auth, ...extra } : extra;
  }

  private fail(res: Response, path: string, what: 'folder' | 'file'): SourceError {
    const where = path ? `“${path}”` : 'The address';
    switch (res.status) {
      case 401:
        return new SourceError('auth', `${this.host} rejected the username or password.`, { status: 401 });
      case 403:
        return new SourceError('forbidden', `${this.host} does not allow access to ${path ? `“${path}”` : 'this folder'}.`, { status: 403 });
      case 404:
        return new SourceError('not-found', `${where} was not found on ${this.host}. The ${what} may have been moved or deleted.`, { status: 404 });
      case 405:
      case 501:
        return new SourceError(
          'config',
          `${this.host} does not speak WebDAV at this address. For Nextcloud use https://host/remote.php/dav/files/USERNAME/.`,
          { status: res.status },
        );
      default:
        return new SourceError(codeForStatus(res.status), `${this.host} answered with an error (HTTP ${res.status}).`, { status: res.status });
    }
  }

  private async propfind(path: string, depth: '0' | '1', signal?: AbortSignal): Promise<{ url: string; entries: DavEntry[] }> {
    const url = this.urlFor(path, true);
    const res = await request(
      url,
      {
        method: 'PROPFIND',
        headers: this.headers({ Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }),
        body: PROPFIND_BODY,
        cache: 'no-store',
        signal,
      },
      { host: this.host, cors: true },
    );
    if (res.status !== 207) {
      if (res.ok) throw new SourceError('config', `${this.host} did not answer like a WebDAV server. Check the address.`, { status: res.status });
      throw this.fail(res, path, 'folder');
    }
    return { url, entries: parseMultistatus(await res.text(), url, this.parser) };
  }

  async *list(path: string, opts: ListOptions = {}): AsyncIterable<SourceEntry> {
    const dir = trimSlash(path.replace(/^\/+/, ''));
    const { url, entries } = await this.propfind(dir, '1', opts.signal);
    const self = trimSlash(decodePath(new URL(url).pathname));
    for (const e of entries) {
      if (e.path === self) continue;
      // Children of the folder we asked for; anything else (servers that
      // rewrite paths) falls back to its last segment.
      const name = e.path.startsWith(self + '/') ? e.path.slice(self.length + 1) : (e.path.split('/').pop() ?? '');
      if (!name || name.includes('/')) continue;
      yield {
        path: dir ? `${dir}/${name}` : name,
        name,
        isDir: e.isDir,
        size: e.size,
        mtime: e.mtime,
        etag: e.etag,
      };
    }
  }

  async stat(path: string, opts: ListOptions = {}): Promise<SourceEntry | null> {
    try {
      const { entries } = await this.propfind(path, '0', opts.signal);
      const e = entries[0];
      if (!e) return null;
      const name = path.split('/').pop() ?? path;
      return { path, name, isDir: e.isDir, size: e.size, mtime: e.mtime, etag: e.etag };
    } catch (err) {
      if (err instanceof SourceError && err.code === 'not-found') return null;
      throw err;
    }
  }

  /** Check the address and credentials: PROPFIND Depth 0 on the root. */
  async test(signal?: AbortSignal): Promise<void> {
    const { entries } = await this.propfind('', '0', signal);
    if (!entries.length) throw new SourceError('bad-response', `${this.host} sent an empty WebDAV answer.`);
    if (!entries[0]!.isDir) throw new SourceError('config', 'This address is a file, not a folder.');
  }

  async readStream(path: string, opts: ReadOptions = {}): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
    const url = this.urlFor(path, false);
    const open = async (range: OpenRange) => {
      const res = await request(
        url,
        { method: 'GET', headers: this.headers(rangeHeaders(range)), cache: 'no-store', signal: opts.signal },
        { host: this.host, cors: true },
      );
      if (!res.ok) throw this.fail(res, path, 'file');
      return res;
    };
    return resumableStream(open, { signal: opts.signal, onProgress: opts.onProgress });
  }

  async read(path: string, opts: ReadOptions = {}): Promise<Blob> {
    const { stream } = await this.readStream(path, opts);
    return streamToBlob(stream);
  }

  describe() {
    return { title: `WebDAV · ${this.host}`, detail: this.base.pathname };
  }
}
