/**
 * Metadata extraction that runs in both the browser and Node (server).
 * Needs only a Blob: in Node use fs.openAsBlob(path) so nothing is loaded
 * into memory up front.
 */
import { BlobReader, BlobWriter, TextWriter, ZipReader, type Entry, type FileEntry } from '@zip.js/zip.js';
import { XMLParser } from 'fast-xml-parser';
import { detectFormat, FORMAT_HEAD_BYTES, titleFromFilename, type BookFormat } from './format';
import type { BookMeta } from './models';
import { imageMimeFromName, isImageFile, naturalSort } from './sort';

export interface CoverImage {
  data: Blob;
  mime: string;
}

export interface ExtractedBook {
  format: BookFormat;
  meta: BookMeta;
  /** Raw cover image from inside the file, when cheap to get (CBZ, EPUB). */
  cover: CoverImage | null;
}

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_XML_BYTES = 2 * 1024 * 1024;

export async function readHead(blob: Blob, bytes = FORMAT_HEAD_BYTES): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, bytes).arrayBuffer());
}

export async function extractBook(blob: Blob, filename: string): Promise<ExtractedBook> {
  const format = detectFormat(filename, await readHead(blob));
  if (!format) throw new Error(`Unsupported format: ${filename}`);
  const fallback: BookMeta = { title: titleFromFilename(filename), authors: [] };

  try {
    if (format === 'cbz') return { format, ...(await extractCbz(blob, fallback)) };
    if (format === 'epub') return { format, ...(await extractEpub(blob, fallback)) };
  } catch {
    // Damaged archives still import; they just lack metadata.
  }
  return { format, meta: fallback, cover: null };
}

function isFileEntry(e: Entry): e is FileEntry {
  return !e.directory;
}

async function entryText(entry: FileEntry): Promise<string> {
  if (entry.uncompressedSize > MAX_XML_BYTES) throw new Error('XML entry too large');
  return entry.getData(new TextWriter());
}

async function entryBlob(entry: FileEntry): Promise<Blob> {
  return entry.getData(new BlobWriter());
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  textNodeName: '#text',
  isArray: (name) => ['item', 'itemref', 'creator', 'meta', 'title', 'identifier', 'rootfile'].includes(name),
});

function text(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim() || null;
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return text((node as Record<string, unknown>)['#text']);
  }
  return null;
}

function cleanDescription(html: string | null): string | null {
  if (!html) return null;
  const plain = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.slice(0, 4000) || null;
}

async function extractCbz(blob: Blob, fallback: BookMeta): Promise<Omit<ExtractedBook, 'format'>> {
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const entries = (await reader.getEntries()).filter(isFileEntry);
    const images = entries.filter((e) => isImageFile(e.filename)).sort((a, b) => naturalSort(a.filename, b.filename));
    const meta: BookMeta = { ...fallback, pageCount: images.length };

    const info = entries.find((e) => e.filename.toLowerCase().split('/').pop() === 'comicinfo.xml');
    if (info) {
      const doc = xml.parse(await entryText(info))?.ComicInfo ?? {};
      const series = text(doc.Series);
      const number = text(doc.Number);
      const title = text(doc.Title);
      meta.series = series;
      meta.seriesIndex = number && !Number.isNaN(Number(number)) ? Number(number) : null;
      if (title) meta.title = series && number ? `${series} #${number}: ${title}` : title;
      else if (series && number) meta.title = `${series} #${number}`;
      meta.authors = [text(doc.Writer), text(doc.Penciller)]
        .filter((a): a is string => !!a)
        .flatMap((a) => a.split(',').map((s) => s.trim()))
        .filter((a, i, all) => a && all.indexOf(a) === i);
      meta.description = cleanDescription(text(doc.Summary));
      meta.publisher = text(doc.Publisher);
      meta.language = text(doc.LanguageISO);
    }

    const first = images[0];
    const cover = first && first.uncompressedSize <= MAX_COVER_BYTES
      ? { data: await entryBlob(first), mime: imageMimeFromName(first.filename) }
      : null;
    return { meta, cover };
  } finally {
    await reader.close();
  }
}

function resolvePath(base: string, href: string): string {
  const parts = base.split('/').filter(Boolean);
  for (const part of decodeURIComponent(href).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

async function extractEpub(blob: Blob, fallback: BookMeta): Promise<Omit<ExtractedBook, 'format'>> {
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const entries = (await reader.getEntries()).filter(isFileEntry);
    const byName = new Map(entries.map((e) => [e.filename.toLowerCase(), e]));
    const find = (path: string) => byName.get(path.toLowerCase());

    const container = find('META-INF/container.xml');
    if (!container) return { meta: fallback, cover: null };
    const rootfiles = xml.parse(await entryText(container))?.container?.rootfiles?.rootfile ?? [];
    const opfPath: string | undefined = rootfiles[0]?.['@full-path'];
    const opfEntry = opfPath ? find(opfPath) : undefined;
    if (!opfPath || !opfEntry) return { meta: fallback, cover: null };
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const pkg = xml.parse(await entryText(opfEntry))?.package ?? {};
    const md = pkg.metadata ?? {};
    const metas: Record<string, string>[] = md.meta ?? [];
    const metaProp = (prop: string) => text(metas.find((m) => m['@property'] === prop));
    const metaName = (name: string) => metas.find((m) => m['@name'] === name)?.['@content'] ?? null;

    const series = metaProp('belongs-to-collection') ?? metaName('calibre:series');
    const seriesIndexRaw = metaProp('group-position') ?? metaName('calibre:series_index');
    const meta: BookMeta = {
      title: text(md.title) ?? fallback.title,
      authors: ((md.creator ?? []) as unknown[]).map(text).filter((a): a is string => !!a),
      series,
      seriesIndex: seriesIndexRaw && !Number.isNaN(Number(seriesIndexRaw)) ? Number(seriesIndexRaw) : null,
      description: cleanDescription(text(md.description)),
      language: text(md.language),
      publisher: text(md.publisher),
      pageCount: null,
    };

    const items: Record<string, string>[] = pkg.manifest?.item ?? [];
    let coverHref = items.find((i) => (i['@properties'] ?? '').split(/\s+/).includes('cover-image'))?.['@href'];
    if (!coverHref) {
      const coverId = metaName('cover');
      coverHref = items.find((i) => i['@id'] === coverId)?.['@href'];
    }
    if (!coverHref) {
      coverHref = items.find((i) => /cover/i.test(i['@id'] ?? '') && (i['@media-type'] ?? '').startsWith('image/'))?.['@href'];
    }

    let cover: CoverImage | null = null;
    const coverEntry = coverHref ? find(resolvePath(opfDir, coverHref)) : undefined;
    if (coverEntry && isImageFile(coverEntry.filename) && coverEntry.uncompressedSize <= MAX_COVER_BYTES) {
      cover = { data: await entryBlob(coverEntry), mime: imageMimeFromName(coverEntry.filename) };
    }
    return { meta, cover };
  } finally {
    await reader.close();
  }
}
