import { openAsBlob } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { extractBook, type BookDto, type BookFormat, type BookMeta, type ExtractedBook } from '@libraria/core';
import type { AppContext } from '../context';
import type { BookFileRow, BookRow, Database } from '../db/schema';
import { cleanText } from '../validate';

export const MAX_COVER_BYTES = 5 * 1024 * 1024;

export const COVER_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Image type by magic bytes, or null if it is not an image we serve. */
export function imageExt(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp';
  return null;
}

export function parseAuthors(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function bookDto(b: BookRow): BookDto {
  return {
    id: b.id,
    sha512: b.sha512,
    format: b.format,
    title: b.title,
    authors: parseAuthors(b.authors),
    series: b.series,
    seriesIndex: b.series_index,
    description: b.description,
    language: b.language,
    publisher: b.publisher,
    pageCount: b.page_count,
    fileSize: b.file_size,
    hasCover: b.cover_ext !== null,
    addedAt: b.added_at,
    updatedAt: b.updated_at,
  };
}

export function searchText(title: string, authors: string[], series: string | null): string {
  return [title, ...authors, series ?? ''].join(' ').toLowerCase();
}

/** Trims and caps metadata that came from a file or a client. */
export function sanitizeMeta(meta: BookMeta, fallbackTitle: string): Required<BookMeta> {
  const opt = (v: string | null | undefined, max: number, multiline = false) => (v ? cleanText(v, max, multiline) || null : null);
  const num = (v: number | null | undefined, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
  return {
    title: (meta.title && cleanText(meta.title, 500)) || cleanText(fallbackTitle, 500) || 'Untitled',
    authors: [...new Set((meta.authors ?? []).map((a) => cleanText(a, 200)).filter(Boolean))].slice(0, 50),
    series: opt(meta.series, 500),
    seriesIndex: num(meta.seriesIndex, 1e9),
    description: opt(meta.description, 4000, true),
    language: opt(meta.language, 35),
    publisher: opt(meta.publisher, 500),
    pageCount: num(meta.pageCount, 1e7) !== null ? Math.floor(meta.pageCount!) : null,
  };
}

/** Path of an uploaded book inside the data dir (content-addressed). */
export function storeRelPath(sha512: string, format: BookFormat): string {
  return join('books', sha512.slice(0, 2), `${sha512}.${format}`);
}

/** Books members can see: not tombstoned and with at least one file present. */
export function visibleBooks(db: Kysely<Database>) {
  return db
    .selectFrom('books')
    .where('books.deleted_at', 'is', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('book_files')
          .select('book_files.id')
          .whereRef('book_files.book_id', '=', 'books.id')
          .where('book_files.removed_at', 'is', null),
      ),
    );
}

export async function findVisibleBook(db: Kysely<Database>, where: { id?: string; sha512?: string }) {
  let q = visibleBooks(db).selectAll('books');
  if (where.id) q = q.where('books.id', '=', where.id);
  if (where.sha512) q = q.where('books.sha512', '=', where.sha512);
  return q.executeTakeFirst();
}

export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Absolute path of a book's file that may be served, preferring the uploads
 * store. Disk-source files are re-checked to still resolve inside their source.
 */
export async function servableFile(ctx: AppContext, bookId: string): Promise<{ file: BookFileRow; path: string } | null> {
  const files = await ctx.db
    .selectFrom('book_files')
    .leftJoin('sources', 'sources.id', 'book_files.source_id')
    .selectAll('book_files')
    .select('sources.path as source_path')
    .where('book_files.book_id', '=', bookId)
    .where('book_files.removed_at', 'is', null)
    .orderBy(sql`case when book_files.source_id is null then 0 else 1 end`)
    .orderBy('book_files.id')
    .execute();
  for (const f of files) {
    try {
      if (f.source_id === null) {
        const abs = join(ctx.paths.data, f.path);
        const real = await realpath(abs);
        if (isInside(await realpath(ctx.paths.books), real)) return { file: f, path: real };
      } else if (f.source_path) {
        const real = await realpath(f.path);
        if (isInside(await realpath(f.source_path), real)) return { file: f, path: real };
      }
    } catch {
      // Missing file: try the next one.
    }
  }
  return null;
}

export async function saveCover(ctx: AppContext, bookId: string, data: Uint8Array): Promise<boolean> {
  const ext = imageExt(data);
  if (!ext || data.byteLength > MAX_COVER_BYTES) return false;
  const book = await ctx.db.selectFrom('books').select('cover_ext').where('id', '=', bookId).executeTakeFirst();
  if (!book) return false;
  await mkdir(ctx.paths.covers, { recursive: true });
  await writeFile(join(ctx.paths.covers, `${bookId}.${ext}`), data);
  if (book.cover_ext && book.cover_ext !== ext) await rm(join(ctx.paths.covers, `${bookId}.${book.cover_ext}`), { force: true });
  await ctx.db.updateTable('books').set({ cover_ext: ext, updated_at: ctx.now() }).where('id', '=', bookId).execute();
  return true;
}

export async function removeCover(ctx: AppContext, book: Pick<BookRow, 'id' | 'cover_ext'>): Promise<void> {
  if (book.cover_ext) await rm(join(ctx.paths.covers, `${book.id}.${book.cover_ext}`), { force: true });
}

/** Metadata and embedded cover; never throws for damaged files. */
export async function extractFile(path: string, filename: string): Promise<ExtractedBook | null> {
  try {
    return await extractBook(await openAsBlob(path), filename);
  } catch {
    return null;
  }
}

export async function saveExtractedCover(ctx: AppContext, bookId: string, extracted: ExtractedBook | null): Promise<void> {
  if (!extracted?.cover) return;
  try {
    await saveCover(ctx, bookId, new Uint8Array(await extracted.cover.data.arrayBuffer()));
  } catch (err) {
    ctx.log.warn(`Could not save cover for ${bookId}: ${(err as Error).message}`);
  }
}

/**
 * Removes a book. Uploaded files are deleted. If a disk source still holds
 * the file, the row stays as a tombstone so the next scan does not re-add it.
 */
export async function deleteBook(ctx: AppContext, book: BookRow): Promise<void> {
  const files = await ctx.db.selectFrom('book_files').selectAll().where('book_id', '=', book.id).execute();
  for (const f of files.filter((f) => f.source_id === null)) {
    await rm(join(ctx.paths.data, f.path), { force: true });
  }
  await ctx.db.deleteFrom('book_files').where('book_id', '=', book.id).where('source_id', 'is', null).execute();
  const onDisk = files.some((f) => f.source_id !== null);
  if (onDisk) {
    await ctx.db.updateTable('books').set({ deleted_at: ctx.now() }).where('id', '=', book.id).execute();
  } else {
    await removeCover(ctx, book);
    await ctx.db.deleteFrom('books').where('id', '=', book.id).execute();
  }
}

/** Drops books with no files left at all (after a source is deleted). */
export async function pruneOrphanBooks(ctx: AppContext): Promise<number> {
  const orphans = await ctx.db
    .selectFrom('books')
    .select(['id', 'cover_ext'])
    .where((eb) => eb.not(eb.exists(eb.selectFrom('book_files').select('book_files.id').whereRef('book_files.book_id', '=', 'books.id'))))
    .execute();
  for (const b of orphans) {
    await removeCover(ctx, b);
    await ctx.db.deleteFrom('books').where('id', '=', b.id).execute();
  }
  return orphans.length;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
