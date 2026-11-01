/**
 * EPUB parser for the reader. Chapters are returned as complete HTML
 * documents meant for a sandboxed iframe (no allow-scripts):
 *
 * - DOMPurify strips scripts, event handlers, forms and javascript: URLs.
 * - A CSP meta tag blocks all network loads; only blob:/data: resources work,
 *   so a book cannot phone home.
 * - Resource URLs are rewritten to blob: URLs *after* sanitizing, because
 *   DOMPurify would otherwise drop blob: URLs.
 */
import { BlobReader, BlobWriter, TextWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';
import DOMPurify from 'dompurify';

export interface EpubTocEntry {
  title: string;
  href: string;
  spine: number;
  fragment: string | null;
  children: EpubTocEntry[];
}

export interface EpubInfo {
  title: string | null;
  authors: string[];
  language: string | null;
  direction: 'ltr' | 'rtl' | 'default';
}

export const EPUB_CSP =
  "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob:";

const XLINK = 'http://www.w3.org/1999/xlink';

export class EpubBook {
  private entries = new Map<string, FileEntry>();
  private blobUrls = new Map<string, string>();
  private zip: ZipReader<Blob> | null = null;
  private opfDir = '';
  private spineHrefs: string[] = [];
  private _toc: EpubTocEntry[] = [];
  private _info: EpubInfo = { title: null, authors: [], language: null, direction: 'default' };
  private coverPath: string | null = null;

  private constructor() {}

  static async open(source: Blob): Promise<EpubBook> {
    const book = new EpubBook();
    await book.load(source);
    return book;
  }

  get spineLength(): number {
    return this.spineHrefs.length;
  }

  get toc(): EpubTocEntry[] {
    return this._toc;
  }

  get info(): EpubInfo {
    return this._info;
  }

  /** Full path (inside the zip) of a spine item. */
  spinePath(index: number): string | null {
    return this.spineHrefs[index] ?? null;
  }

  /** Resolve a link found in chapter `fromSpine` to a spine index and fragment. */
  resolveLink(fromSpine: number, href: string): { spine: number; fragment: string | null } | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    const from = this.spineHrefs[fromSpine] ?? this.opfDir;
    const [path, fragment] = splitFragment(href);
    const target = path ? resolvePath(dirOf(from), path) : from;
    const spine = this.spineIndexOf(target);
    return spine < 0 ? null : { spine, fragment };
  }

  async cover(): Promise<Blob | null> {
    if (!this.coverPath) return null;
    const entry = this.entry(this.coverPath);
    return entry ? entry.getData(new BlobWriter()) : null;
  }

  /** Sanitized chapter as a complete HTML document. extraCss is appended last. */
  async chapterDocument(index: number, extraCss = ''): Promise<string> {
    const path = this.spineHrefs[index];
    if (!path) throw new Error(`Chapter ${index} out of range`);
    const source = await this.readText(path);
    const dir = dirOf(path);

    let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(source, 'text/html');

    let css = '';
    for (const el of Array.from(doc.querySelectorAll('link[rel~="stylesheet"], style'))) {
      if (el.tagName.toLowerCase() === 'style') {
        css += (await this.rewriteCss(el.textContent ?? '', dir)) + '\n';
      } else {
        const href = el.getAttribute('href');
        if (!href) continue;
        const cssPath = resolvePath(dir, splitFragment(href)[0]);
        try {
          css += (await this.rewriteCss(await this.readText(cssPath), dirOf(cssPath))) + '\n';
        } catch {
          // Missing stylesheet: render without it.
        }
      }
    }

    const body = doc.body ?? doc.documentElement;
    const clean = DOMPurify.sanitize(body.innerHTML, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'base', 'meta', 'link'],
      FORBID_ATTR: ['srcset'],
      ADD_TAGS: ['image'],
      ADD_ATTR: ['epub:type', 'xlink:href'],
    });
    await this.rewriteResources(clean, dir);

    const holder = document.createElement('div');
    holder.appendChild(clean);
    const bodyClass = escapeAttr(body.getAttribute('class') ?? '');
    const lang = escapeAttr(this._info.language ?? '');
    const dirAttr = this._info.direction === 'default' ? '' : ` dir="${this._info.direction}"`;

    return `<!doctype html><html lang="${lang}"${dirAttr}><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${EPUB_CSP}">` +
      `<style>${escapeStyle(css)}</style><style id="libraria-reader">${escapeStyle(extraCss)}</style>` +
      `</head><body class="${bodyClass}">${holder.innerHTML}</body></html>`;
  }

  close(): void {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
    void this.zip?.close();
    this.zip = null;
  }

  // --- loading -----------------------------------------------------------------

  private async load(source: Blob): Promise<void> {
    this.zip = new ZipReader(new BlobReader(source));
    for (const e of await this.zip.getEntries()) {
      if (!e.directory) this.entries.set(e.filename, e);
    }

    // Some downloads wrap the .epub in another zip.
    if (!this.entry('META-INF/container.xml')) {
      const inner = [...this.entries.values()].find((e) => e.filename.toLowerCase().endsWith('.epub'));
      if (!inner) throw new Error('Not an EPUB: META-INF/container.xml missing');
      const blob = await inner.getData(new BlobWriter('application/epub+zip'));
      await this.zip.close();
      this.entries.clear();
      return this.load(blob);
    }

    const container = parseXml(await this.readText('META-INF/container.xml'));
    const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB has no rootfile');
    this.opfDir = dirOf(opfPath);
    const opf = parseXml(await this.readText(opfPath));

    const md = opf.querySelector('metadata');
    this._info = {
      title: textOf(md, 'title'),
      authors: Array.from(md?.getElementsByTagNameNS('*', 'creator') ?? [], (c) => c.textContent?.trim() ?? '').filter(Boolean),
      language: textOf(md, 'language'),
      direction: (opf.querySelector('spine')?.getAttribute('page-progression-direction') as EpubInfo['direction']) ?? 'default',
    };

    const manifest = new Map<string, { href: string; type: string; props: string }>();
    for (const item of Array.from(opf.querySelectorAll('manifest > item'))) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (id && href) {
        manifest.set(id, {
          href: resolvePath(this.opfDir, href),
          type: item.getAttribute('media-type') ?? '',
          props: item.getAttribute('properties') ?? '',
        });
      }
    }
    for (const ref of Array.from(opf.querySelectorAll('spine > itemref'))) {
      const item = manifest.get(ref.getAttribute('idref') ?? '');
      if (item && ref.getAttribute('linear') !== 'no') this.spineHrefs.push(item.href);
    }
    // Non-linear items are still reachable through links.
    for (const ref of Array.from(opf.querySelectorAll('spine > itemref[linear="no"]'))) {
      const item = manifest.get(ref.getAttribute('idref') ?? '');
      if (item) this.spineHrefs.push(item.href);
    }

    const items = [...manifest.values()];
    const coverId = opf.querySelector('metadata meta[name="cover"]')?.getAttribute('content');
    this.coverPath =
      items.find((i) => i.props.split(/\s+/).includes('cover-image'))?.href ??
      (coverId ? manifest.get(coverId)?.href : undefined) ??
      null;

    const nav = items.find((i) => i.props.split(/\s+/).includes('nav'));
    const ncxId = opf.querySelector('spine')?.getAttribute('toc');
    const ncx = (ncxId && manifest.get(ncxId)) || items.find((i) => i.type === 'application/x-dtbncx+xml');
    try {
      if (nav) this._toc = this.parseNav(await this.readText(nav.href), dirOf(nav.href));
    } catch {
      this._toc = [];
    }
    if (this._toc.length === 0 && ncx) {
      try {
        this._toc = this.parseNcx(await this.readText(ncx.href), dirOf(ncx.href));
      } catch {
        this._toc = [];
      }
    }
  }

  private tocEntry(title: string, href: string, baseDir: string, children: EpubTocEntry[]): EpubTocEntry {
    const [path, fragment] = splitFragment(href);
    const full = path ? resolvePath(baseDir, path) : '';
    return { title, href: full, spine: this.spineIndexOf(full), fragment, children };
  }

  private parseNav(html: string, baseDir: string): EpubTocEntry[] {
    let doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(html, 'text/html');
    const navs = Array.from(doc.getElementsByTagName('nav'));
    const nav = navs.find((n) => (n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? n.getAttribute('epub:type')) === 'toc') ?? navs[0];
    const ol = nav?.querySelector('ol');
    const walk = (list: Element): EpubTocEntry[] =>
      Array.from(list.children)
        .filter((li) => li.tagName.toLowerCase() === 'li')
        .map((li) => {
          const a = Array.from(li.children).find((c) => ['a', 'span'].includes(c.tagName.toLowerCase()));
          const sub = Array.from(li.children).find((c) => c.tagName.toLowerCase() === 'ol');
          return this.tocEntry(a?.textContent?.trim() ?? '', a?.getAttribute('href') ?? '', baseDir, sub ? walk(sub) : []);
        });
    return ol ? walk(ol) : [];
  }

  private parseNcx(xml: string, baseDir: string): EpubTocEntry[] {
    const doc = parseXml(xml);
    const walk = (parent: Element): EpubTocEntry[] =>
      Array.from(parent.children)
        .filter((c) => c.localName === 'navPoint')
        .map((np) => {
          const label = Array.from(np.children).find((c) => c.localName === 'navLabel')?.textContent?.trim() ?? '';
          const src = Array.from(np.children).find((c) => c.localName === 'content')?.getAttribute('src') ?? '';
          return this.tocEntry(label, src, baseDir, walk(np));
        });
    const navMap = doc.getElementsByTagNameNS('*', 'navMap')[0];
    return navMap ? walk(navMap) : [];
  }

  // --- resources ---------------------------------------------------------------

  private spineIndexOf(path: string): number {
    const lower = path.toLowerCase();
    return this.spineHrefs.findIndex((h) => h.toLowerCase() === lower);
  }

  private entry(path: string): FileEntry | undefined {
    const exact = this.entries.get(path);
    if (exact) return exact;
    const lower = path.toLowerCase();
    for (const [name, e] of this.entries) if (name.toLowerCase() === lower) return e;
    return undefined;
  }

  private async readText(path: string): Promise<string> {
    const e = this.entry(path);
    if (!e) throw new Error(`Missing entry: ${path}`);
    return e.getData(new TextWriter());
  }

  private async blobUrl(path: string): Promise<string | null> {
    const cached = this.blobUrls.get(path);
    if (cached) return cached;
    const e = this.entry(path);
    if (!e) return null;
    const blob = await e.getData(new BlobWriter(mimeOf(path)));
    const url = URL.createObjectURL(blob);
    this.blobUrls.set(path, url);
    return url;
  }

  private async rewriteCss(css: string, baseDir: string): Promise<string> {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const found = new Map<string, string>();
    for (const m of css.matchAll(re)) {
      const raw = m[2]!.trim();
      if (found.has(raw) || raw.startsWith('data:') || raw.startsWith('#')) continue;
      const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? null : await this.blobUrl(resolvePath(baseDir, splitFragment(raw)[0]));
      found.set(raw, url ?? 'about:blank');
    }
    // @import would load other files; the CSP blocks them anyway, drop them.
    return css
      .replace(/@import[^;]+;/g, '')
      .replace(re, (_all, _q, raw: string) => `url("${found.get(raw.trim()) ?? raw}")`);
  }

  private async rewriteResources(root: DocumentFragment, baseDir: string): Promise<void> {
    const rewrite = async (el: Element, attr: string, ns?: string) => {
      const value = ns ? el.getAttributeNS(ns, attr) ?? el.getAttribute(`xlink:${attr}`) : el.getAttribute(attr);
      if (!value || value.startsWith('data:') || value.startsWith('#')) return;
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        el.removeAttribute(attr);
        return;
      }
      const url = await this.blobUrl(resolvePath(baseDir, splitFragment(value)[0]));
      if (!url) return;
      if (ns) {
        el.setAttributeNS(ns, `xlink:${attr}`, url);
        el.setAttribute(attr, url);
      } else {
        el.setAttribute(attr, url);
      }
    };
    for (const el of Array.from(root.querySelectorAll('img[src], audio[src], video[src], source[src]'))) await rewrite(el, 'src');
    for (const el of Array.from(root.querySelectorAll('video[poster]'))) await rewrite(el, 'poster');
    for (const el of Array.from(root.querySelectorAll('image'))) {
      if (el.hasAttribute('href')) await rewrite(el, 'href');
      else await rewrite(el, 'href', XLINK);
    }
    for (const el of Array.from(root.querySelectorAll('[style]'))) {
      el.setAttribute('style', await this.rewriteCss(el.getAttribute('style') ?? '', baseDir));
    }
  }
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

function textOf(parent: Element | null | undefined, localName: string): string | null {
  return parent?.getElementsByTagNameNS('*', localName)[0]?.textContent?.trim() || null;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function splitFragment(href: string): [string, string | null] {
  const i = href.indexOf('#');
  return i < 0 ? [href, null] : [href.slice(0, i), href.slice(i + 1) || null];
}

export function resolvePath(baseDir: string, href: string): string {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // keep raw
  }
  if (decoded.startsWith('/')) return decoded.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const part of decoded.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', avif: 'image/avif', css: 'text/css', ttf: 'font/ttf', otf: 'font/otf',
    woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', m4a: 'audio/mp4',
  };
  return map[ext ?? ''] ?? 'application/octet-stream';
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Prevent a stylesheet from closing the <style> element. */
function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}
