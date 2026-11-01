import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { open, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import { detectFormatStrict, FORMAT_HEAD_BYTES, sha512, uuidv7, type SubmissionDto } from '@libraria/core';
import type { AppContext } from '../context';
import type { SubmissionRow, UserRow } from '../db/schema';
import { conflict, HttpError } from '../errors';
import {
  ensureDir,
  extractFile,
  findVisibleBook,
  parseAuthors,
  sanitizeMeta,
  saveExtractedCover,
  searchText,
  storeRelPath,
} from './books';

export const STALE_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;

export type SubmissionWithUser = SubmissionRow & { username: string };

export function submissionDto(s: SubmissionWithUser): SubmissionDto {
  return {
    id: s.id,
    userId: s.user_id,
    username: s.username,
    sha512: s.sha512,
    format: s.format,
    fileSize: s.file_size,
    filename: s.filename,
    title: s.title,
    authors: parseAuthors(s.authors),
    uploadOffset: s.upload_offset,
    status: s.status,
    reviewNote: s.review_note,
    reviewedBy: s.reviewed_by,
    bookId: s.book_id,
    createdAt: s.created_at,
    reviewedAt: s.reviewed_at,
  };
}

export function submissionsWithUser(ctx: AppContext) {
  return ctx.db
    .selectFrom('submissions')
    .innerJoin('users', 'users.id', 'submissions.user_id')
    .selectAll('submissions')
    .select('users.username');
}

export async function getSubmission(ctx: AppContext, id: string): Promise<SubmissionWithUser | undefined> {
  return submissionsWithUser(ctx).where('submissions.id', '=', id).executeTakeFirst();
}

export function partPath(ctx: AppContext, id: string): string {
  return join(ctx.paths.uploads, `${id}.part`);
}

function offsetConflict(offset: number, message: string): HttpError {
  return new HttpError(409, 'conflict', message, { offset }, { 'Upload-Offset': String(offset) });
}

async function setOffset(ctx: AppContext, id: string, offset: number): Promise<void> {
  await ctx.db.updateTable('submissions').set({ upload_offset: offset, updated_at: ctx.now() }).where('id', '=', id).execute();
}

class TooLarge extends Error {}

/**
 * Appends one chunk at Upload-Offset, streaming straight to disk. The part
 * file is first truncated to the recorded offset, so bytes from an earlier
 * interrupted request never linger. Returns the new offset.
 */
export async function receiveChunk(ctx: AppContext, req: Request, sub: SubmissionRow, offset: number): Promise<number> {
  if (offset !== sub.upload_offset) throw offsetConflict(sub.upload_offset, 'Upload-Offset does not match the server');
  const length = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
  if (length !== null && offset + length > sub.file_size) {
    throw new HttpError(413, 'too_large', 'Chunk goes past the declared file size');
  }
  const path = partPath(ctx, sub.id);
  if (offset > 0 && !existsSync(path)) {
    await setOffset(ctx, sub.id, 0);
    throw offsetConflict(0, 'Upload data was lost; start again from 0');
  }

  const fh = await open(path, offset === 0 ? 'w' : 'r+');
  try {
    await fh.truncate(offset);
  } finally {
    await fh.close();
  }
  let tooLarge = false;
  let failure: unknown = null;
  let written = offset;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > sub.file_size) return cb(new TooLarge());
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, guard, createWriteStream(path, { flags: 'r+', start: offset }));
  } catch (err) {
    if (err instanceof TooLarge) tooLarge = true;
    else failure = err;
  }
  if (tooLarge) await truncate(path, offset);
  const size = Math.min((await stat(path)).size, sub.file_size);
  await setOffset(ctx, sub.id, size);
  if (tooLarge) throw new HttpError(413, 'too_large', 'Upload goes past the declared file size');
  if (failure) throw failure;
  return size;
}

async function resetUpload(ctx: AppContext, sub: SubmissionRow): Promise<void> {
  await rm(partPath(ctx, sub.id), { force: true });
  await setOffset(ctx, sub.id, 0);
}

async function readHeadOf(path: string): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(FORMAT_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/**
 * Called when the last byte arrived: verifies hash and format, extracts
 * metadata, and moves the submission to pending (or straight to approved
 * for owner/curator uploads). On failure the upload restarts from 0.
 */
export async function finalizeUpload(ctx: AppContext, sub: SubmissionRow, uploader: UserRow): Promise<void> {
  const path = partPath(ctx, sub.id);
  const hash = await sha512(createReadStream(path));
  if (hash !== sub.sha512) {
    await resetUpload(ctx, sub);
    throw new HttpError(422, 'hash_mismatch', 'The uploaded file does not match the declared SHA-512');
  }
  if (detectFormatStrict(await readHeadOf(path)) !== sub.format) {
    await resetUpload(ctx, sub);
    throw new HttpError(422, 'unsupported_format', `The uploaded file is not a valid ${sub.format.toUpperCase()}`);
  }

  // Client metadata wins (it may carry the member's edits); the file fills gaps.
  const extracted = await extractFile(path, sub.filename);
  const ex = extracted?.meta;
  const submittedAuthors = parseAuthors(sub.authors);
  const meta = sanitizeMeta(
    {
      title: sub.title || ex?.title || '',
      authors: submittedAuthors.length ? submittedAuthors : (ex?.authors ?? []),
      series: sub.series ?? ex?.series,
      seriesIndex: sub.series_index ?? ex?.seriesIndex,
      description: sub.description ?? ex?.description,
      language: sub.language ?? ex?.language,
      publisher: sub.publisher ?? ex?.publisher,
      pageCount: ex?.pageCount ?? sub.page_count,
    },
    sub.filename,
  );
  await ctx.db
    .updateTable('submissions')
    .set({
      title: meta.title,
      authors: JSON.stringify(meta.authors),
      series: meta.series,
      series_index: meta.seriesIndex,
      description: meta.description,
      language: meta.language,
      publisher: meta.publisher,
      page_count: meta.pageCount,
      status: 'pending',
      updated_at: ctx.now(),
    })
    .where('id', '=', sub.id)
    .execute();

  if (uploader.role === 'owner' || uploader.role === 'curator') {
    const fresh = await ctx.db.selectFrom('submissions').selectAll().where('id', '=', sub.id).executeTakeFirstOrThrow();
    await approveSubmission(ctx, fresh, uploader.id, null);
  }
}

/** Moves the file into the books store and creates (or revives) the book. */
export async function approveSubmission(ctx: AppContext, sub: SubmissionRow, reviewerId: string, note: string | null): Promise<string> {
  const part = partPath(ctx, sub.id);
  const now = ctx.now();
  let bookId: string;

  const existing = await findVisibleBook(ctx.db, { sha512: sub.sha512 });
  if (existing) {
    await rm(part, { force: true });
    bookId = existing.id;
  } else {
    const rel = storeRelPath(sub.sha512, sub.format);
    const abs = join(ctx.paths.data, rel);
    await ensureDir(abs);
    if (existsSync(abs)) await rm(part, { force: true });
    else await rename(part, abs);

    const authors = parseAuthors(sub.authors);
    const newId = uuidv7();
    const values = {
      format: sub.format,
      title: sub.title,
      authors: sub.authors,
      series: sub.series,
      series_index: sub.series_index,
      description: sub.description,
      language: sub.language,
      publisher: sub.publisher,
      page_count: sub.page_count,
      file_size: sub.file_size,
      search_text: searchText(sub.title, authors, sub.series),
      submitted_by: sub.user_id,
      updated_at: now,
    };
    // Book row and file row land together so an orphan sweep never sees one without the other.
    const tomb = await ctx.db.transaction().execute(async (trx) => {
      const prev = await trx.selectFrom('books').select(['id', 'cover_ext']).where('sha512', '=', sub.sha512).executeTakeFirst();
      if (prev) {
        await trx.updateTable('books').set({ ...values, deleted_at: null }).where('id', '=', prev.id).execute();
      } else {
        await trx
          .insertInto('books')
          .values({ id: newId, sha512: sub.sha512, cover_ext: null, added_at: now, deleted_at: null, ...values })
          .execute();
      }
      await trx
        .insertInto('book_files')
        .values({ id: uuidv7(), book_id: prev?.id ?? newId, source_id: null, path: rel, size: sub.file_size, mtime: now, removed_at: null, created_at: now })
        .execute();
      return prev;
    });
    bookId = tomb?.id ?? newId;
    if (!tomb?.cover_ext) await saveExtractedCover(ctx, bookId, await extractFile(abs, sub.filename));
  }

  await ctx.db
    .updateTable('submissions')
    .set({ status: 'approved', book_id: bookId, reviewed_by: reviewerId, reviewed_at: now, review_note: note, updated_at: now })
    .where('id', '=', sub.id)
    .execute();
  return bookId;
}

export async function rejectSubmission(ctx: AppContext, sub: SubmissionRow, reviewerId: string, note: string | null): Promise<void> {
  await rm(partPath(ctx, sub.id), { force: true });
  const now = ctx.now();
  await ctx.db
    .updateTable('submissions')
    .set({ status: 'rejected', reviewed_by: reviewerId, reviewed_at: now, review_note: note, updated_at: now })
    .where('id', '=', sub.id)
    .execute();
}

export async function deleteSubmission(ctx: AppContext, sub: SubmissionRow): Promise<void> {
  if (sub.status === 'approved') throw conflict('Approved submissions are removed by deleting the book');
  await rm(partPath(ctx, sub.id), { force: true });
  await ctx.db.deleteFrom('submissions').where('id', '=', sub.id).execute();
}

/** Deletes uploads that saw no bytes for STALE_UPLOAD_MS. */
export async function cleanStaleUploads(ctx: AppContext): Promise<number> {
  const stale = await ctx.db
    .selectFrom('submissions')
    .select('id')
    .where('status', '=', 'uploading')
    .where('updated_at', '<', ctx.now() - STALE_UPLOAD_MS)
    .execute();
  for (const s of stale) {
    if (ctx.locks.has(s.id)) continue;
    await rm(partPath(ctx, s.id), { force: true });
    await ctx.db.deleteFrom('submissions').where('id', '=', s.id).execute();
  }
  if (stale.length) ctx.log.info(`Removed ${stale.length} stale upload(s)`);
  return stale.length;
}
