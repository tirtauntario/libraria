/**
 * Scanning a source: walk its folders and keep bookFiles in step with what
 * is there. New files become placeholder books (sha512 = null, title from
 * the filename). Hashing and real metadata wait until the book is first
 * downloaded or opened (see open.ts), because hashing needs the whole file.
 *
 * Remote source drivers reuse this as is; they only implement list().
 */
import { formatFromFilename, isBookFilename, titleFromFilename, uuidv7, type Source } from '@libraria/core';
import type { BookFileRecord, BookRecord } from '../db/schema';
import type { Services } from '../services';
import type { SourceEntry } from '../sources/types';
import { newBookRecord } from './import';
import { removeOfflineCopy } from './offline';

export interface ScanOptions {
  signal?: AbortSignal;
  /** Called for each book file found. */
  onProgress?: (found: number, path: string) => void;
  /** Descend into sub-folders (default true). */
  recursive?: boolean;
  /** Remove bookFiles under rootPath that were not seen (default true). */
  prune?: boolean;
}

export interface ScanResult {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

/** Walk a source depth-first, yielding book files only. */
export async function* walkSource(
  list: (path: string) => AsyncIterable<SourceEntry>,
  root: string,
  recursive = true,
  signal?: AbortSignal,
): AsyncIterable<SourceEntry> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    for await (const entry of list(dir)) {
      signal?.throwIfAborted();
      if (entry.isDir) {
        if (recursive && !entry.name.startsWith('.')) queue.push(entry.path);
      } else if (isBookFilename(entry.name)) {
        yield entry;
      }
    }
  }
}

const sameFile = (rec: BookFileRecord, e: SourceEntry) =>
  (e.etag != null && rec.etag != null ? e.etag === rec.etag : true) &&
  (e.size == null || rec.size == null || e.size === rec.size) &&
  (e.mtime == null || rec.mtime == null || e.mtime === rec.mtime);

export function inFolder(path: string, root: string): boolean {
  if (!root) return true;
  const r = root.replace(/\/+$/, '');
  return path === r || path.startsWith(r + '/');
}

export function placeholderBook(entry: SourceEntry, now: number): BookRecord | null {
  const format = formatFromFilename(entry.name);
  if (!format) return null;
  return newBookRecord(
    uuidv7(now),
    entry.sha512 ?? null,
    { format, meta: { title: titleFromFilename(entry.name), authors: [] }, cover: null },
    entry.size ?? 0,
    now,
    'filename',
  );
}

/** Delete a book if nothing points at it any more. A pinned offline copy keeps it. */
export async function dropIfOrphan(bookId: string, s: Services): Promise<boolean> {
  const files = await s.repo.listBookFiles(bookId);
  if (files.length > 0) return false;
  if ((await s.repo.getOffline(bookId))?.pinned) return false;
  await removeOfflineCopy(bookId, s);
  await s.repo.deleteBookRecords(bookId);
  return true;
}

export async function scanSource(source: Source, rootPath: string, s: Services, opts: ScanOptions = {}): Promise<ScanResult> {
  const driver = s.driver(source);
  const result: ScanResult = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  const seen = new Set<string>();
  let found = 0;

  for await (const entry of walkSource((p) => driver.list(p, { signal: opts.signal }), rootPath, opts.recursive ?? true, opts.signal)) {
    seen.add(entry.path);
    opts.onProgress?.(++found, entry.path);
    const existing = await s.repo.getFileByPath(source.id, entry.path);
    const now = Date.now();

    if (existing && sameFile(existing, entry)) {
      result.unchanged++;
      continue;
    }

    // Known hash (e.g. from a Libraria server): link to the same book directly.
    const known = entry.sha512 ? await s.repo.getBookBySha(entry.sha512) : undefined;
    let bookId = known?.id;
    if (!bookId) {
      const book = placeholderBook(entry, now);
      if (!book) continue;
      await s.repo.putBook(book);
      bookId = book.id;
    }

    const rec: BookFileRecord = {
      id: existing?.id ?? uuidv7(now),
      bookId,
      sourceId: source.id,
      path: entry.path,
      size: entry.size,
      mtime: entry.mtime,
      etag: entry.etag,
      addedAt: existing?.addedAt ?? now,
    };
    await s.repo.putBookFile(rec);
    if (existing) {
      // The file changed, so it is a different book now.
      if (existing.bookId !== bookId) await dropIfOrphan(existing.bookId, s);
      result.updated++;
    } else {
      result.added++;
    }
  }

  if (opts.prune ?? true) {
    for (const rec of await s.repo.listFilesBySource(source.id)) {
      if (!inFolder(rec.path, rootPath) || seen.has(rec.path)) continue;
      // Only prune folders that were walked.
      if (!(opts.recursive ?? true) && rec.path.slice(rootPath ? rootPath.length + 1 : 0).includes('/')) continue;
      await s.repo.deleteBookFile(rec.id);
      await dropIfOrphan(rec.bookId, s);
      result.removed++;
    }
  }
  return result;
}
