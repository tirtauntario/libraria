/**
 * Import files picked by the user (file picker, drag & drop, PWA file
 * handler) into the built-in local source.
 *
 * Per file: detect format → streaming SHA-512 (worker) → dedupe →
 * stream the file into the file store → extract metadata + cover → records.
 *
 * Hashing comes before copying so a duplicate is never written to storage.
 */
import { detectFormat, readHead, uuidv7, type BookFormat } from '@libraria/core';
import type { BookFileRecord, BookRecord } from '../db/schema';
import type { Services } from '../services';
import { localStoreName, safeFilename } from '../sources/local';
import type { Analysis } from './analyze';
import { removeOfflineCopy } from './offline';

export type ImportPhase = 'hashing' | 'copying' | 'reading';

export interface ImportProgress {
  /** 0-based index of the current file. */
  index: number;
  total: number;
  name: string;
  phase: ImportPhase;
  /** 0..1 within the current phase. */
  fraction: number;
}

export interface ImportResult {
  added: BookRecord[];
  /** Files already in the library (same SHA-512, already stored on this device). */
  duplicates: { name: string; book: BookRecord }[];
  /** Files whose book was known (e.g. from a remote source) and now also lives on this device. */
  attached: BookRecord[];
  failed: { name: string; error: string }[];
}

export interface ImportOptions {
  signal?: AbortSignal;
  onProgress?: (p: ImportProgress) => void;
}

export function newBookRecord(
  id: string,
  sha512: string | null,
  analysis: Pick<Analysis, 'format' | 'meta' | 'cover'>,
  fileSize: number,
  now: number,
  metaSource: BookRecord['metaSource'] = 'file',
): BookRecord {
  const { meta } = analysis;
  return {
    id,
    sha512,
    format: analysis.format,
    title: meta.title,
    authors: meta.authors ?? [],
    series: meta.series ?? null,
    seriesIndex: meta.seriesIndex ?? null,
    description: meta.description ?? null,
    language: meta.language ?? null,
    publisher: meta.publisher ?? null,
    pageCount: meta.pageCount ?? null,
    fileSize,
    cover: analysis.cover,
    customGroup: null,
    metaSource,
    metaEdited: false,
    addedAt: now,
    updatedAt: now,
    lastReadAt: null,
  };
}

export async function importFiles(files: File[], s: Services, opts: ImportOptions = {}): Promise<ImportResult> {
  const result: ImportResult = { added: [], duplicates: [], attached: [], failed: [] };
  const { localSourceId } = await s.repo.meta();

  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const report = (phase: ImportPhase, fraction: number) =>
      opts.onProgress?.({ index, total: files.length, name: file.name, phase, fraction });
    if (opts.signal?.aborted) break;

    try {
      const format: BookFormat | null = detectFormat(file.name, await readHead(file));
      if (!format) throw new Error('Not an EPUB, PDF, CBZ or CBR file');

      report('hashing', 0);
      const sha512 = await s.hash(file, (n) => report('hashing', file.size ? n / file.size : 1), opts.signal);

      const existing = await s.repo.getBookBySha(sha512);
      if (existing) {
        const files = await s.repo.listBookFiles(existing.id);
        if (files.some((f) => f.sourceId === localSourceId)) {
          result.duplicates.push({ name: file.name, book: existing });
          continue;
        }
      }

      // Copy into device storage.
      report('copying', 0);
      const fileId = uuidv7();
      const path = `${fileId}/${safeFilename(file.name)}`;
      const storeName = localStoreName(path);
      const size = await s.files.write(storeName, file, {
        signal: opts.signal,
        onProgress: (n) => report('copying', file.size ? n / file.size : 1),
      });
      const now = Date.now();
      const bookFile: BookFileRecord = {
        id: fileId,
        bookId: existing?.id ?? uuidv7(),
        sourceId: localSourceId,
        path,
        size,
        mtime: file.lastModified || null,
        etag: null,
        addedAt: now,
      };

      try {
        if (existing) {
          await s.repo.putBookFile(bookFile);
          // A device copy makes a downloaded offline copy redundant.
          await removeOfflineCopy(existing.id, s);
          result.attached.push(existing);
          continue;
        }

        report('reading', 0);
        const stored = (await s.files.read(storeName)) ?? file;
        const analysis = await s.analyze(stored, file.name);
        const book = newBookRecord(bookFile.bookId, sha512, analysis, size, now);
        await s.repo.addBookWithFile(book, bookFile);
        result.added.push(book);
      } catch (err) {
        await s.files.remove(storeName);
        throw err;
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') break;
      result.failed.push({ name: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
