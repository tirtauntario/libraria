/**
 * Resolve a book to a readable Blob:
 * 1. its offline copy, if there is one;
 * 2. a local source (imported file, linked folder);
 * 3. otherwise download it from a remote source, into the file store when
 *    the device setting allows (so the next open works offline).
 * Then make sure the book has a SHA-512 and real metadata: placeholders from
 * a scan are hashed and analysed now, and merged into an existing book with
 * the same hash.
 */
import { uuidv7, type Source } from '@libraria/core';
import type { BookFileRecord, BookRecord, OfflineFileRecord } from '../db/schema';
import { isMetered, isOnline } from '../net.svelte';
import type { Services } from '../services';
import type { SourceDriver } from '../sources/types';
import { runEviction } from './offline';

export type OpenStage =
  | { phase: 'locating' }
  | { phase: 'downloading'; loaded: number; total: number | null }
  | { phase: 'hashing'; fraction: number }
  | { phase: 'reading' };

export interface OpenedBook {
  book: BookRecord;
  blob: Blob;
  origin: 'offline' | 'local' | 'download' | 'stream';
}

export interface OpenOptions {
  signal?: AbortSignal;
  onStage?: (stage: OpenStage) => void;
}

export class BookUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'missing' | 'offline' | 'no-source' | 'failed',
  ) {
    super(message);
    this.name = 'BookUnavailableError';
  }
}

interface Located {
  file: BookFileRecord;
  source: Source;
  driver: SourceDriver;
}

async function locate(bookId: string, s: Services): Promise<{ local: Located[]; remote: Located[]; errors: string[] }> {
  const local: Located[] = [];
  const remote: Located[] = [];
  const errors: string[] = [];
  for (const file of await s.repo.listBookFiles(bookId)) {
    const source = await s.repo.getSource(file.sourceId);
    if (!source || source.deleted) continue;
    try {
      const driver = s.driver(source);
      (driver.isLocal ? local : remote).push({ file, source, driver });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { local, remote, errors };
}

export function offlineName(id: string, book: Pick<BookRecord, 'format'>): string {
  return `offline/${id}.${book.format}`;
}

/** Download a book from a remote source into the file store. */
export async function downloadToStore(
  book: BookRecord,
  where: Located,
  s: Services,
  opts: OpenOptions & { pinned?: boolean } = {},
): Promise<{ record: OfflineFileRecord; blob: Blob }> {
  const id = uuidv7();
  const name = offlineName(id, book);
  const progress = (loaded: number, total: number | null) => opts.onStage?.({ phase: 'downloading', loaded, total });
  const readOpts = { signal: opts.signal, onProgress: progress };
  let size: number;
  if (where.driver.readStream) {
    const { stream, size: total } = await where.driver.readStream(where.file.path, readOpts);
    size = await s.files.write(name, stream, { signal: opts.signal, onProgress: (n) => progress(n, total ?? where.file.size) });
  } else {
    const blob = await where.driver.read(where.file.path, readOpts);
    size = await s.files.write(name, blob, { signal: opts.signal });
  }
  const now = Date.now();
  const record: OfflineFileRecord = { id, bookId: book.id, opfsName: name, size, pinned: !!opts.pinned, createdAt: now, lastOpenedAt: now };
  const previous = await s.repo.getOffline(book.id);
  if (previous) {
    await s.files.remove(previous.opfsName);
    await s.repo.deleteOffline(previous.id);
  }
  await s.repo.putOffline(record);
  const blob = await s.files.read(name);
  if (!blob) throw new BookUnavailableError('The downloaded file could not be read back from storage.', 'failed');
  await runEviction(s, { keepBookIds: [book.id] });
  return { record, blob };
}

/** "Keep offline": download a remote book and pin it. No-op for local books. */
export async function keepOffline(bookId: string, s: Services, opts: OpenOptions = {}): Promise<OfflineFileRecord | null> {
  const book = await s.repo.getBook(bookId);
  if (!book) throw new BookUnavailableError('This book is no longer in the library.', 'missing');
  const existing = await s.repo.getOffline(bookId);
  if (existing) {
    await s.repo.putOffline({ ...existing, pinned: true });
    return { ...existing, pinned: true };
  }
  const { local, remote } = await locate(bookId, s);
  if (local.length) return null;
  if (!remote[0]) throw new BookUnavailableError('No source has this book.', 'no-source');
  if (!isOnline()) throw new BookUnavailableError('You are offline.', 'offline');
  const { record, blob } = await downloadToStore(book, remote[0], s, { ...opts, pinned: true });
  await identify(book, blob, remote[0].file.path, s, opts);
  return record;
}

/** Hash and analyse a book that does not have a SHA-512 yet. May return a different (merged) book. */
export async function identify(book: BookRecord, blob: Blob, filename: string, s: Services, opts: OpenOptions = {}): Promise<BookRecord> {
  if (book.sha512) return book;
  opts.onStage?.({ phase: 'hashing', fraction: 0 });
  const sha512 = await s.hash(blob, (n) => opts.onStage?.({ phase: 'hashing', fraction: blob.size ? n / blob.size : 1 }), opts.signal);

  const twin = await s.repo.getBookBySha(sha512);
  if (twin && twin.id !== book.id) {
    const merged = await s.repo.mergeBooks(book.id, twin.id);
    if (merged?.droppedOffline) await s.files.remove(merged.droppedOffline.opfsName);
    return merged?.book ?? twin;
  }

  opts.onStage?.({ phase: 'reading' });
  const analysis = await s.analyze(blob, filename.split('/').pop() ?? filename);
  const meta = analysis.meta;
  const patch: Partial<BookRecord> = {
    sha512,
    format: analysis.format,
    fileSize: blob.size,
    cover: analysis.cover ?? book.cover,
    authors: meta.authors ?? [],
    description: meta.description ?? null,
    language: meta.language ?? null,
    publisher: meta.publisher ?? null,
    pageCount: meta.pageCount ?? null,
    seriesIndex: meta.seriesIndex ?? null,
    metaSource: 'file',
  };
  if (!book.metaEdited) {
    patch.title = meta.title;
    patch.series = meta.series ?? null;
  }
  return (await s.repo.updateBook(book.id, patch)) ?? book;
}

export async function openBook(bookId: string, s: Services, opts: OpenOptions = {}): Promise<OpenedBook> {
  opts.onStage?.({ phase: 'locating' });
  let book = await s.repo.getBook(bookId);
  if (!book) throw new BookUnavailableError('This book is no longer in the library.', 'missing');

  const offline = await s.repo.getOffline(bookId);
  const files = await s.repo.listBookFiles(bookId);
  const filename = files[0]?.path ?? `${book.title}.${book.format}`;

  if (offline) {
    const blob = await s.files.read(offline.opfsName);
    if (blob) {
      await s.repo.touchOffline(bookId);
      book = await identify(book, blob, filename, s, opts);
      return { book, blob, origin: 'offline' };
    }
    await s.repo.deleteOffline(offline.id); // file vanished (storage cleared)
  }

  const { local, remote, errors } = await locate(bookId, s);
  for (const where of local) {
    try {
      const blob = await where.driver.read(where.file.path, { signal: opts.signal });
      book = await identify(book, blob, where.file.path, s, opts);
      return { book, blob, origin: 'local' };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (remote.length === 0) {
    throw new BookUnavailableError(errors[0] ?? 'This book is not stored anywhere this device can reach.', 'no-source');
  }
  if (!isOnline()) {
    throw new BookUnavailableError('You are offline and this book has not been downloaded to this device.', 'offline');
  }

  const device = await s.repo.getDeviceSettings();
  const save = device.autoDownloadOnOpen && (device.downloadOnMetered || !isMetered());
  for (const where of remote) {
    try {
      let blob: Blob;
      let origin: OpenedBook['origin'];
      if (save) {
        blob = (await downloadToStore(book, where, s, opts)).blob;
        origin = 'download';
      } else {
        blob = await where.driver.read(where.file.path, {
          signal: opts.signal,
          onProgress: (loaded, total) => opts.onStage?.({ phase: 'downloading', loaded, total }),
        });
        origin = 'stream';
      }
      book = await identify(book, blob, where.file.path, s, opts);
      return { book, blob, origin };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new BookUnavailableError(errors[0] ?? 'Download failed.', 'failed');
}
