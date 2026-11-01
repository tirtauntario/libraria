export type BookFormat = 'cbz' | 'cbr' | 'epub' | 'pdf';
export type ComicFormat = 'cbz' | 'cbr';

export const BOOK_FORMATS: readonly BookFormat[] = ['cbz', 'cbr', 'epub', 'pdf'];

export const FORMAT_MIME: Record<BookFormat, string> = {
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
};

/** Extensions accepted in file pickers and when scanning sources. */
export const BOOK_EXTENSIONS = ['.cbz', '.cbr', '.zip', '.rar', '.epub', '.pdf'];

/** Bytes of the file head that detectFormat needs. */
export const FORMAT_HEAD_BYTES = 512;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const RAR_MAGIC = [0x52, 0x61, 0x72, 0x21];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];
const EPUB_MIMETYPE = 'application/epub+zip';

export function isComic(format: BookFormat): format is ComicFormat {
  return format === 'cbz' || format === 'cbr';
}

function startsWith(head: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => head[i] === b);
}

/** EPUB: first ZIP entry is an uncompressed "mimetype" file. */
function isEpubZip(head: Uint8Array): boolean {
  if (head.length < 30) return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) return false;
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const name = new TextDecoder().decode(head.subarray(30, 30 + nameLen));
  if (name !== 'mimetype') return false;
  const start = 30 + nameLen + extraLen;
  const content = new TextDecoder().decode(head.subarray(start, start + EPUB_MIMETYPE.length));
  return content === EPUB_MIMETYPE;
}

function hasEpubExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.epub') || lower.includes('.epub.');
}

export function formatFromFilename(filename: string): BookFormat | null {
  if (hasEpubExtension(filename)) return 'epub';
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'cbz' || ext === 'zip') return 'cbz';
  if (ext === 'cbr' || ext === 'rar') return 'cbr';
  if (ext === 'pdf') return 'pdf';
  return null;
}

export function isBookFilename(filename: string): boolean {
  const name = filename.split('/').pop() ?? filename;
  if (name.startsWith('.')) return false;
  return formatFromFilename(name) !== null;
}

/** Detect by magic bytes, falling back to the extension. Returns null if unsupported. */
export function detectFormat(filename: string, head: Uint8Array): BookFormat | null {
  if (startsWith(head, ZIP_MAGIC)) {
    if (isEpubZip(head) || hasEpubExtension(filename)) return 'epub';
    return 'cbz';
  }
  if (startsWith(head, RAR_MAGIC)) return 'cbr';
  if (startsWith(head, PDF_MAGIC)) return 'pdf';
  return formatFromFilename(filename);
}

/** Like detectFormat but only trusts magic bytes. Used to validate uploads. */
export function detectFormatStrict(head: Uint8Array): BookFormat | null {
  if (startsWith(head, ZIP_MAGIC)) return isEpubZip(head) ? 'epub' : 'cbz';
  if (startsWith(head, RAR_MAGIC)) return 'cbr';
  if (startsWith(head, PDF_MAGIC)) return 'pdf';
  return null;
}

/** Title from a filename: strip folders and extension, tidy separators. */
export function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const noExt = base.replace(/\.epub\.zip$/i, '').replace(/\.[^.]+$/, '');
  const tidy = noExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return tidy || base;
}
