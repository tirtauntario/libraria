/** Server disk sources: path containment and scanning. */
import { createReadStream } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  detectFormat,
  FORMAT_HEAD_BYTES,
  isBookFilename,
  sha512,
  titleFromFilename,
  uuidv7,
  type ScanResult,
} from '@libraria/core';
import type { AppContext } from '../context';
import type { BookFileRow, SourceRow } from '../db/schema';
import { badRequest } from '../errors';
import { extractFile, isInside, pruneOrphanBooks, sanitizeMeta, saveExtractedCover, searchText } from './books';

const MAX_DEPTH = 32;

/** Real paths of the configured roots that exist. */
export async function realRoots(ctx: AppContext): Promise<string[]> {
  const out: string[] = [];
  for (const root of ctx.config.sourceRoots) {
    try {
      out.push(await realpath(root));
    } catch {
      ctx.log.warn(`Source root does not exist: ${root}`);
    }
  }
  return out;
}

/**
 * Resolves a requested source path (following symlinks) and requires that the
 * result is a directory inside one of the configured roots.
 */
export async function resolveSourcePath(ctx: AppContext, requested: string): Promise<string> {
  const roots = await realRoots(ctx);
  if (roots.length === 0) throw badRequest('No source roots are configured on this server (sourceRoots)');
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw badRequest('Path does not exist');
  }
  if (!roots.some((root) => isInside(root, real))) throw badRequest('Path is outside the allowed source roots');
  if (!(await stat(real)).isDirectory()) throw badRequest('Path is not a directory');
  return real;
}

async function head(path: string): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(FORMAT_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** Yields book files under dir. Symlinks and dot entries are skipped, never followed. */
async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > MAX_DEPTH) return;
  const handle = await opendir(dir);
  for await (const entry of handle) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, depth + 1);
    else if (entry.isFile() && isBookFilename(entry.name)) yield full;
  }
}

export async function scanSource(ctx: AppContext, source: SourceRow): Promise<ScanResult> {
  const root = await resolveSourcePath(ctx, source.path);
  const result: ScanResult = { added: 0, removed: 0, unchanged: 0, failed: 0 };
  const known = new Map<string, BookFileRow>();
  for (const f of await ctx.db.selectFrom('book_files').selectAll().where('source_id', '=', source.id).execute()) {
    known.set(f.path, f);
  }
  const seen = new Set<string>();

  for await (const path of walk(root)) {
    seen.add(path);
    const prev = known.get(path);
    try {
      const st = await lstat(path);
      if (!st.isFile()) continue;
      const mtime = Math.floor(st.mtimeMs);
      if (prev && prev.removed_at === null && prev.size === st.size && prev.mtime === mtime) {
        result.unchanged++;
        continue;
      }
      const name = basename(path);
      const format = detectFormat(name, await head(path));
      if (!format) {
        result.failed++;
        continue;
      }
      const hash = await sha512(createReadStream(path));
      const now = ctx.now();
      let book = await ctx.db.selectFrom('books').select(['id']).where('sha512', '=', hash).executeTakeFirst();
      if (!book) {
        const extracted = await extractFile(path, name);
        const meta = sanitizeMeta(extracted?.meta ?? { title: '', authors: [] }, titleFromFilename(name));
        book = { id: uuidv7() };
        await ctx.db
          .insertInto('books')
          .values({
            id: book.id,
            sha512: hash,
            format,
            title: meta.title,
            authors: JSON.stringify(meta.authors),
            series: meta.series,
            series_index: meta.seriesIndex,
            description: meta.description,
            language: meta.language,
            publisher: meta.publisher,
            page_count: meta.pageCount,
            file_size: st.size,
            cover_ext: null,
            search_text: searchText(meta.title, meta.authors, meta.series),
            submitted_by: null,
            added_at: now,
            updated_at: now,
            deleted_at: null,
          })
          .execute();
        await saveExtractedCover(ctx, book.id, extracted);
      }
      if (prev) {
        const same = prev.removed_at === null && prev.book_id === book.id;
        await ctx.db
          .updateTable('book_files')
          .set({ book_id: book.id, size: st.size, mtime, removed_at: null })
          .where('id', '=', prev.id)
          .execute();
        if (same) result.unchanged++;
        else result.added++;
      } else {
        await ctx.db
          .insertInto('book_files')
          .values({ id: uuidv7(), book_id: book.id, source_id: source.id, path, size: st.size, mtime, removed_at: null, created_at: now })
          .execute();
        result.added++;
      }
    } catch (err) {
      ctx.log.warn(`Scan failed for ${path}: ${(err as Error).message}`);
      result.failed++;
    }
  }

  const now = ctx.now();
  for (const [path, f] of known) {
    if (seen.has(path) || f.removed_at !== null) continue;
    await ctx.db.updateTable('book_files').set({ removed_at: now }).where('id', '=', f.id).execute();
    result.removed++;
  }
  await pruneOrphanBooks(ctx);
  await ctx.db.updateTable('sources').set({ last_scan_at: now }).where('id', '=', source.id).execute();
  ctx.log.info(`Scanned ${root}: ${JSON.stringify(result)}`);
  return result;
}
