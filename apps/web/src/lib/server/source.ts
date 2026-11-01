/**
 * The `libraria` source kind: books of a Libraria server.
 *
 * - list('') yields every server book (paginated /books). Entries carry the
 *   SHA-512, so a server book links to a local copy of the same file at once.
 * - read()/readStream() download /books/:id/file with progress, abort and
 *   Range resume after a dropped connection.
 * - refreshServerCatalog() runs the generic scan, then copies the server's
 *   metadata into the local book records and caches covers.
 *
 * Paths are `<serverBookId>/<title>.<format>`; a renamed book gets a new path
 * on the next refresh (same SHA-512, so it stays the same local book).
 */
import type { Component } from 'svelte';
import { BOOK_FORMATS, type BookDto, type BookFormat, type Source } from '@libraria/core';
import type { BookRecord } from '../db/schema';
import { dropIfOrphan, scanSource, type ScanResult } from '../library/scan';
import { isOnline } from '../net.svelte';
import type { Services } from '../services';
import { forgetDriver, registerSourceKind } from '../sources/registry';
import type { DriverContext, ListOptions, ReadOptions, SourceDriver, SourceEntry, SourceSetupProps } from '../sources/types';
import { ServerError, type ServerApi } from './api';
import { apiFor, getServerState, isLibrariaSource, patchServerState, type LibrariaSource } from './servers';

export const MAX_COVER_BYTES = 5 * 1024 * 1024;
const LIST_CACHE_MS = 10_000;
const RESUME_ATTEMPTS = 4;

/** `<serverBookId>/<title>.<format>`: the id keeps it unique, the name reads well on the book page. */
export function serverBookPath(dto: Pick<BookDto, 'id' | 'format' | 'title'>): string {
  return `${dto.id}/${safeName(dto.title, dto.format)}`;
}

/** Server book id from a bookFiles path, or null. */
export function serverBookIdFromPath(path: string): string | null {
  const m = /^([0-9a-f-]{36})\//i.exec(path);
  return m ? m[1]! : null;
}

function safeName(title: string, format: BookFormat): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 150) || 'book';
  return `${base}.${format}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * A download that resumes with a Range request when the connection drops.
 * Exported for tests.
 */
export async function resumableDownload(
  open: (from: number) => Promise<Response>,
  opts: ReadOptions & { attempts?: number; retryDelayMs?: number } = {},
): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
  const first = await open(0);
  if (!first.body) throw new ServerError('The server sent an empty file.', first.status, 'bad_response');
  const len = Number(first.headers.get('content-length'));
  const size = Number.isFinite(len) && len > 0 ? len : null;
  let reader = first.body.getReader();
  let loaded = 0;
  let failures = 0;
  const attempts = opts.attempts ?? RESUME_ATTEMPTS;
  const delay = opts.retryDelayMs ?? 1000;

  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for (;;) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (size !== null && loaded < size) throw new Error('Connection closed early');
            ctrl.close();
            return;
          }
          loaded += value.byteLength;
          failures = 0;
          opts.onProgress?.(loaded, size);
          ctrl.enqueue(value);
          return;
        } catch (err) {
          if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          if (++failures > attempts) throw err;
          await sleep(delay * failures, opts.signal);
          const res = await open(loaded);
          if (!res.body) throw err;
          if (loaded > 0 && res.status !== 206) {
            // The server ignored Range: skip what we already have.
            let skip = loaded;
            const r = res.body.getReader();
            let carry: Uint8Array | null = null;
            while (skip > 0) {
              const { done, value } = await r.read();
              if (done) throw new Error('The file on the server changed during the download');
              if (value.byteLength <= skip) skip -= value.byteLength;
              else {
                carry = value.subarray(skip);
                skip = 0;
              }
            }
            reader = r;
            if (carry) {
              loaded += carry.byteLength;
              opts.onProgress?.(loaded, size);
              ctrl.enqueue(carry);
              return;
            }
          } else {
            reader = res.body.getReader();
          }
        }
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
  return { stream, size };
}

export class LibrariaDriver implements SourceDriver {
  readonly isLocal = false;
  private cache: { at: number; books: BookDto[] } | null = null;

  constructor(
    readonly source: LibrariaSource,
    private readonly ctx: DriverContext,
  ) {}

  api(): ServerApi {
    return apiFor(this.source, this.ctx.repo);
  }

  /** Fetch every book; the next list() reuses the result for a few seconds. */
  async fetchBooks(signal?: AbortSignal): Promise<BookDto[]> {
    const books = await this.api().allBooks(signal);
    this.cache = { at: Date.now(), books };
    return books;
  }

  async *list(path: string, opts?: ListOptions): AsyncIterable<SourceEntry> {
    if (path !== '') return;
    const books = this.cache && Date.now() - this.cache.at < LIST_CACHE_MS ? this.cache.books : await this.fetchBooks(opts?.signal);
    for (const b of books) {
      if (!BOOK_FORMATS.includes(b.format)) continue;
      yield {
        path: serverBookPath(b),
        name: safeName(b.title, b.format),
        isDir: false,
        size: b.fileSize,
        mtime: null,
        etag: b.sha512,
        sha512: b.sha512,
      };
    }
  }

  async stat(path: string): Promise<SourceEntry | null> {
    const id = serverBookIdFromPath(path);
    if (!id) return null;
    try {
      const b = await this.api().getBook(id);
      return { path, name: safeName(b.title, b.format), isDir: false, size: b.fileSize, mtime: null, etag: b.sha512, sha512: b.sha512 };
    } catch (err) {
      if (err instanceof ServerError && err.status === 404) return null;
      throw err;
    }
  }

  async readStream(path: string, opts: ReadOptions = {}): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
    const id = serverBookIdFromPath(path);
    if (!id) throw new Error('Not a server book');
    const api = this.api();
    return resumableDownload((from) => api.openBookFile(id, { signal: opts.signal, from }), opts);
  }

  async read(path: string, opts: ReadOptions = {}): Promise<Blob> {
    const { stream } = await this.readStream(path, opts);
    return new Response(stream).blob();
  }

  describe() {
    let host = this.source.config.url;
    try {
      host = new URL(host).host;
    } catch {
      // keep as is
    }
    return { title: this.source.name, detail: `Libraria server · ${host}` };
  }
}

/** Replace the `libraria` stub with the real driver. The UI passes its "Add server" form. */
export function registerLibrariaSource(setup?: Component<SourceSetupProps>): void {
  registerSourceKind({
    kind: 'libraria',
    label: 'Libraria server',
    description: 'A community library you joined.',
    deviceOnly: false,
    implemented: true,
    userCreatable: true,
    isSupported: () => true,
    createDriver: (source, ctx) => new LibrariaDriver(source as LibrariaSource, ctx),
    setup,
  });
}

// --- catalog refresh ---------------------------------------------------------------

export interface RefreshResult extends ScanResult {
  metadata: number;
  covers: number;
}

const META_KEYS = ['title', 'authors', 'series', 'seriesIndex', 'description', 'language', 'publisher', 'pageCount', 'fileSize', 'format'] as const;

function metaPatch(book: BookRecord, dto: BookDto): Partial<BookRecord> | null {
  const next: Partial<BookRecord> = {
    title: dto.title,
    authors: dto.authors,
    series: dto.series,
    seriesIndex: dto.seriesIndex,
    description: dto.description,
    language: dto.language,
    publisher: dto.publisher,
    pageCount: dto.pageCount,
    fileSize: dto.fileSize,
    format: dto.format,
  };
  const patch: Partial<BookRecord> = {};
  for (const k of META_KEYS) {
    if (JSON.stringify(book[k] ?? null) !== JSON.stringify(next[k] ?? null)) (patch as Record<string, unknown>)[k] = next[k];
  }
  if (book.metaSource !== 'file') patch.metaSource = 'file';
  return Object.keys(patch).length ? patch : null;
}

function isImage(blob: Blob): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(blob.type) && blob.size > 0 && blob.size <= MAX_COVER_BYTES;
}

const inflight = new Map<string, Promise<RefreshResult>>();

/**
 * Bring the local book records of a server in step with its catalog.
 * Server metadata wins for books that only live on servers; a book the user
 * edited, or one that also lives on this device, keeps its own metadata.
 */
export function refreshServerCatalog(source: LibrariaSource, s: Services, opts: { signal?: AbortSignal } = {}): Promise<RefreshResult> {
  const running = inflight.get(source.id);
  if (running) return running;
  const p = doRefresh(source, s, opts).finally(() => inflight.delete(source.id));
  inflight.set(source.id, p);
  return p;
}

async function doRefresh(source: LibrariaSource, s: Services, opts: { signal?: AbortSignal }): Promise<RefreshResult> {
  const driver = s.driver(source) as LibrariaDriver;
  try {
    const books = await driver.fetchBooks(opts.signal);
    const scan = await scanSource(source, '', s, { signal: opts.signal });
    const result: RefreshResult = { ...scan, metadata: 0, covers: 0 };
    const localSources = new Set(
      (await s.repo.listSources()).filter((x) => x.config.kind === 'local' || x.config.kind === 'folder').map((x) => x.id),
    );
    const needCover: { bookId: string; dto: BookDto }[] = [];
    for (const dto of books) {
      const file = await s.repo.getFileByPath(source.id, serverBookPath(dto));
      if (!file) continue;
      const book = await s.repo.getBook(file.bookId);
      if (!book) continue;
      const files = await s.repo.listBookFiles(book.id);
      const ownCopy = files.some((f) => localSources.has(f.sourceId));
      if (!book.metaEdited && (!ownCopy || book.metaSource === 'filename')) {
        const patch = metaPatch(book, dto);
        if (patch) {
          await s.repo.updateBook(book.id, patch);
          result.metadata++;
        }
      }
      if (!book.cover && dto.hasCover) needCover.push({ bookId: book.id, dto });
    }
    const api = driver.api();
    // A few covers at a time.
    const queue = [...needCover];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          opts.signal?.throwIfAborted();
          try {
            const blob = await api.cover(job.dto.id, opts.signal);
            if (blob && isImage(blob)) {
              await s.repo.updateBook(job.bookId, { cover: blob });
              result.covers++;
            }
          } catch (err) {
            if ((err as Error)?.name === 'AbortError') throw err;
            // A missing cover is not worth failing the refresh.
          }
        }
      }),
    );
    await patchServerState(s.repo, source.id, { lastRefreshAt: Date.now(), lastRefreshError: null });
    return result;
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      await patchServerState(s.repo, source.id, { lastRefreshError: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}

export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Refresh when the cached catalog is older than `maxAgeMs` and the device is online. */
export async function refreshIfStale(source: LibrariaSource, s: Services, maxAgeMs = REFRESH_INTERVAL_MS): Promise<RefreshResult | null> {
  if (!isOnline()) return null;
  // Signed out (an account but no token): nothing to fetch until the user signs in.
  if (!source.config.token && source.config.username) return null;
  const state = await getServerState(s.repo, source.id);
  if (state.sessionExpired) return null;
  if (Date.now() - state.lastRefreshAt < maxAgeMs) return null;
  return refreshServerCatalog(source, s);
}

/**
 * Remove a server from this device: its books (unless they live elsewhere
 * too or are pinned offline), its library and the source. Signs out first
 * when asked and possible.
 */
export async function removeServer(source: Source, s: Services, opts: { logout?: boolean } = {}): Promise<void> {
  if (opts.logout && isLibrariaSource(source) && source.config.token && isOnline()) {
    try {
      await apiFor(source, s.repo).logout();
    } catch {
      // Already signed out or unreachable: forgetting it locally is what matters.
    }
  }
  await purgeSourceFiles(source.id, s);
  for (const lib of await s.repo.listLibraries()) {
    if (!lib.sources.some((r) => r.sourceId === source.id)) continue;
    const rest = lib.sources.filter((r) => r.sourceId !== source.id);
    if (rest.length === 0) await s.repo.deleteLibrary(lib.id);
    else await s.repo.updateLibrary(lib.id, { sources: rest });
  }
  await s.repo.deleteSource(source.id);
  forgetDriver(source.id);
  await s.repo.setValue(`server:state:${source.id}`, undefined);
}

/** Drop the bookFiles of a source and books nothing else points at. */
export async function purgeSourceFiles(sourceId: string, s: Services): Promise<void> {
  for (const f of await s.repo.listFilesBySource(sourceId)) {
    await s.repo.deleteBookFile(f.id);
    await dropIfOrphan(f.bookId, s);
  }
}
