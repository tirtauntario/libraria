/**
 * Sending local books to Libraria servers ("contributions").
 *
 * 1. Look the SHA-512 up first: a book the server already has is linked,
 *    nothing is uploaded.
 * 2. POST /submissions, then PATCH chunks of UPLOAD_CHUNK_BYTES with
 *    Upload-Offset; HEAD tells where to resume after a reload or a dropped
 *    connection.
 * 3. Owner/curator uploads are approved by the server right away; member
 *    uploads wait as 'pending' until reviewed. Once approved, the local cover
 *    thumbnail is uploaded if the server has none.
 *
 * Jobs live in the `uploads` store, so they survive reloads; offline jobs
 * wait and run again on app start and when the device comes online.
 */
import { UPLOAD_CHUNK_BYTES, uuidv7, type BookFormat, type DuplicateError, type SubmissionCreateRequest } from '@libraria/core';
import type { BookRecord, UploadJobRecord } from '../db/schema';
import type { Services } from '../services';
import { ServerError, type ServerApi } from './api';
import { apiFor, getServer, type LibrariaSource } from './servers';
import { refreshServerCatalog } from './source';

export type UploadJob = UploadJobRecord;

/** Jobs that still need work from this device. */
const ACTIVE: UploadJob['status'][] = ['queued', 'uploading'];
/** Jobs that wait for the server (review). */
const WAITING: UploadJob['status'][] = ['pending'];

export interface UploadProgress {
  jobId: string;
  loaded: number;
  total: number;
}

type Listener = (event: { type: 'progress'; progress: UploadProgress } | { type: 'changed' }) => void;
const listeners = new Set<Listener>();

export function onUploads(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(e: Parameters<Listener>[0]): void {
  for (const l of listeners) l(e);
}

export async function listUploads(s: Services): Promise<UploadJob[]> {
  const all = await s.db.getAll('uploads');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function uploadsForBook(s: Services, bookId: string): Promise<UploadJob[]> {
  return s.db.getAllFromIndex('uploads', 'bookId', bookId);
}

async function save(s: Services, job: UploadJob): Promise<UploadJob> {
  job.updatedAt = Date.now();
  await s.db.put('uploads', job);
  emit({ type: 'changed' });
  return job;
}

/** The book's bytes on this device: an imported file, a linked folder, or an offline copy. */
export async function localBlob(s: Services, bookId: string): Promise<Blob | null> {
  for (const f of await s.repo.listBookFiles(bookId)) {
    const source = await s.repo.getSource(f.sourceId);
    if (!source || source.deleted) continue;
    try {
      const driver = s.driver(source);
      if (driver.isLocal) return await driver.read(f.path);
    } catch {
      // try the next place
    }
  }
  const offline = await s.repo.getOffline(bookId);
  if (offline) return s.files.read(offline.opfsName);
  return null;
}

export function submissionRequest(book: BookRecord, filename: string): SubmissionCreateRequest {
  return {
    sha512: book.sha512!,
    format: book.format,
    fileSize: book.fileSize,
    filename,
    title: book.title,
    authors: book.authors,
    series: book.series ?? null,
    seriesIndex: book.seriesIndex ?? null,
    description: book.description ?? null,
    language: book.language ?? null,
    publisher: book.publisher ?? null,
    pageCount: book.pageCount ?? null,
  };
}

/** Queue a book for a server. Returns the existing job if one is still going. */
export async function enqueueUpload(s: Services, source: LibrariaSource, book: BookRecord): Promise<UploadJob> {
  if (!book.sha512) throw new Error('Open the book once so Libraria can identify it, then send it.');
  const existing = (await uploadsForBook(s, book.id)).find(
    (j) => j.sourceId === source.id && !['failed', 'rejected'].includes(j.status),
  );
  if (existing) return existing;
  const now = Date.now();
  const job: UploadJob = {
    id: uuidv7(now),
    sourceId: source.id,
    bookId: book.id,
    sha512: book.sha512,
    format: book.format as BookFormat,
    fileSize: book.fileSize,
    title: book.title,
    submissionId: null,
    offset: 0,
    status: 'queued',
    error: null,
    serverBookId: null,
    coverDone: false,
    createdAt: now,
    updatedAt: now,
  };
  return save(s, job);
}

export async function retryUpload(s: Services, jobId: string): Promise<void> {
  const job = await s.db.get('uploads', jobId);
  if (!job) return;
  await save(s, { ...job, status: 'queued', error: null, ...(job.status === 'rejected' ? { submissionId: null, offset: 0 } : {}) });
}

/** Cancel: deletes the submission on the server when it is not approved yet, then the job. */
export async function cancelUpload(s: Services, jobId: string): Promise<void> {
  const job = await s.db.get('uploads', jobId);
  if (!job) return;
  aborts.get(jobId)?.abort();
  if (job.submissionId && ['queued', 'uploading', 'pending', 'failed'].includes(job.status)) {
    const source = await getServer(s.repo, job.sourceId);
    if (source) {
      try {
        await apiFor(source, s.repo).deleteSubmission(job.submissionId);
      } catch (err) {
        if (!(err instanceof ServerError && (err.status === 404 || err.status === 409))) throw err;
      }
    }
  }
  await s.db.delete('uploads', jobId);
  emit({ type: 'changed' });
}

/** Forget a finished job (the server keeps the book). */
export async function dismissUpload(s: Services, jobId: string): Promise<void> {
  await s.db.delete('uploads', jobId);
  emit({ type: 'changed' });
}

const aborts = new Map<string, AbortController>();
let running: Promise<void> | null = null;
let rerun = false;

/**
 * Work through the queue: upload active jobs, poll pending ones. One run at
 * a time per tab; across tabs Web Locks keep two tabs off the same job.
 */
export function processUploads(s: Services, opts: { chunkBytes?: number } = {}): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  const work = async () => {
    do {
      rerun = false;
      await withLock(() => processOnce(s, opts.chunkBytes ?? UPLOAD_CHUNK_BYTES));
    } while (rerun);
  };
  running = work().finally(() => {
    running = null;
  });
  return running;
}

async function withLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (locks?.request) {
    await locks.request('libraria-uploads', fn);
  } else {
    await fn();
  }
}

async function processOnce(s: Services, chunkBytes: number): Promise<void> {
  for (const job of await listUploads(s)) {
    if (!ACTIVE.includes(job.status) && !WAITING.includes(job.status) && !(job.status === 'approved' && !job.coverDone)) continue;
    const fresh = await s.db.get('uploads', job.id);
    if (!fresh) continue;
    try {
      await step(s, fresh, chunkBytes);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') continue;
      const cur = (await s.db.get('uploads', job.id)) ?? fresh;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ServerError && err.transient) {
        // Try again later (online again, next app start).
        await save(s, { ...cur, error: message });
        if (err.code === 'offline') return;
      } else if (ACTIVE.includes(cur.status)) {
        await save(s, { ...cur, status: 'failed', error: message });
      } else {
        await save(s, { ...cur, error: message });
      }
    }
  }
}

async function step(s: Services, job: UploadJob, chunkBytes: number): Promise<void> {
  const source = await getServer(s.repo, job.sourceId);
  if (!source) {
    await save(s, { ...job, status: 'failed', error: 'This server was removed from the device.' });
    return;
  }
  if (!source.config.token) {
    await save(s, { ...job, status: 'failed', error: 'Sign in to this server to send books.' });
    return;
  }
  const api = apiFor(source, s.repo);
  const before = job.status;
  if (ACTIVE.includes(job.status)) job = await upload(s, api, job, chunkBytes);
  if (job.status === 'pending') job = await poll(s, api, job);
  if (job.status === 'approved' && !job.coverDone) await sendCover(s, api, job);
  if (job.status !== before && (job.status === 'approved' || job.status === 'exists')) {
    // Link the local book to the server copy (same SHA-512).
    try {
      await refreshServerCatalog(source, s);
    } catch {
      // The next refresh links it.
    }
  }
}

async function upload(s: Services, api: ServerApi, job: UploadJob, chunkBytes: number): Promise<UploadJob> {
  const book = await s.repo.getBook(job.bookId);
  if (!book) return save(s, { ...job, status: 'failed', error: 'The book is no longer on this device.' });

  if (!job.submissionId) {
    const found = await api.lookup(job.sha512);
    if (found.bookId) return save(s, { ...job, status: 'exists', serverBookId: found.bookId, error: null, coverDone: true });
    const files = await s.repo.listBookFiles(book.id);
    const filename = files[0]?.path.split('/').pop() || `${book.title}.${book.format}`;
    try {
      const sub = await api.createSubmission(submissionRequest(book, filename));
      job = await save(s, { ...job, submissionId: sub.id, offset: 0, status: 'uploading', error: null });
    } catch (err) {
      if (!(err instanceof ServerError && err.code === 'duplicate')) throw err;
      const dup = err.body as unknown as DuplicateError;
      if (dup.bookId) return save(s, { ...job, status: 'exists', serverBookId: dup.bookId, error: null, coverDone: true });
      // Pending already: ours (resume it) or someone else's.
      const mine = dup.submissionId ? await ownSubmission(api, dup.submissionId) : false;
      if (!mine) return save(s, { ...job, status: 'exists', error: 'Someone already sent this book; it is waiting for review.', coverDone: true });
      job = await save(s, { ...job, submissionId: dup.submissionId, status: 'uploading', error: null });
    }
  }

  const id = job.submissionId!;
  let offset: number;
  try {
    offset = await api.uploadOffset(id);
  } catch (err) {
    if (err instanceof ServerError && err.status === 404) {
      // The submission is gone (cancelled elsewhere, or expired): start over.
      return save(s, { ...job, submissionId: null, offset: 0, status: 'queued' });
    }
    throw err;
  }

  if (offset < job.fileSize) {
    const blob = await localBlob(s, job.bookId);
    if (!blob) return save(s, { ...job, status: 'failed', error: 'The file is not on this device any more.' });
    if (blob.size !== job.fileSize) return save(s, { ...job, status: 'failed', error: 'The file changed on this device.' });
    const ctrl = new AbortController();
    aborts.set(job.id, ctrl);
    try {
      job = await save(s, { ...job, offset, status: 'uploading', error: null });
      while (offset < job.fileSize) {
        const chunk = blob.slice(offset, Math.min(job.fileSize, offset + chunkBytes));
        const r = await api.uploadChunk(id, offset, chunk, ctrl.signal);
        offset = 'conflict' in r ? r.conflict : r.offset;
        job = await save(s, { ...job, offset });
        emit({ type: 'progress', progress: { jobId: job.id, loaded: offset, total: job.fileSize } });
      }
    } finally {
      aborts.delete(job.id);
    }
  }

  const sub = await api.getSubmission(id);
  if (sub.status === 'approved') return save(s, { ...job, status: 'approved', serverBookId: sub.bookId, offset: job.fileSize });
  if (sub.status === 'pending') return save(s, { ...job, status: 'pending', offset: job.fileSize });
  if (sub.status === 'rejected') return save(s, { ...job, status: 'rejected', error: sub.reviewNote });
  // Still 'uploading': the server reset it (hash or format check failed).
  return save(s, { ...job, status: 'failed', error: 'The server did not accept the file.' });
}

async function ownSubmission(api: ServerApi, id: string): Promise<boolean> {
  try {
    const sub = await api.getSubmission(id);
    const me = await api.me();
    return sub.userId === me.id && sub.status === 'uploading';
  } catch {
    return false;
  }
}

async function poll(s: Services, api: ServerApi, job: UploadJob): Promise<UploadJob> {
  if (!job.submissionId) return job;
  try {
    const sub = await api.getSubmission(job.submissionId);
    if (sub.status === 'approved') return save(s, { ...job, status: 'approved', serverBookId: sub.bookId, error: null });
    if (sub.status === 'rejected') return save(s, { ...job, status: 'rejected', error: sub.reviewNote });
    return job;
  } catch (err) {
    if (err instanceof ServerError && err.status === 404) return save(s, { ...job, status: 'failed', error: 'The submission was removed from the server.' });
    throw err;
  }
}

async function sendCover(s: Services, api: ServerApi, job: UploadJob): Promise<void> {
  if (!job.serverBookId) {
    await save(s, { ...job, coverDone: true });
    return;
  }
  const book = await s.repo.getBook(job.bookId);
  try {
    const dto = await api.getBook(job.serverBookId);
    if (!dto.hasCover && book?.cover) await api.putCover(job.serverBookId, book.cover);
  } catch (err) {
    if (err instanceof ServerError && err.transient) throw err;
    // A cover is a nicety; never fail the job over it.
  }
  await save(s, { ...job, coverDone: true });
}
