/** /submissions — contributing books. */
import { Router } from 'express';
import {
  BOOK_FORMATS,
  FORMAT_MIME,
  isSha512,
  titleFromFilename,
  UPLOAD_CONTENT_TYPE,
  UPLOAD_OFFSET_HEADER,
  uuidv7,
  type BookFormat,
  type DuplicateError,
  type SubmissionListResponse,
  type SubmissionStatus,
} from '@libraria/core';
import { currentUser, requireUser } from '../auth';
import type { AppContext } from '../context';
import type { SubmissionRow, UserRow } from '../db/schema';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors';
import { findVisibleBook, sanitizeMeta } from '../services/books';
import {
  approveSubmission,
  deleteSubmission,
  finalizeUpload,
  getSubmission,
  partPath,
  receiveChunk,
  rejectSubmission,
  submissionDto,
  submissionsWithUser,
} from '../services/submissions';
import { authors, body, cleanText, oneOf, optNum, optStr, queryString, str } from '../validate';
import { contentDisposition, sendFile } from './books';

const STATUSES: SubmissionStatus[] = ['uploading', 'pending', 'approved', 'rejected'];

function isStaff(u: UserRow): boolean {
  return u.role === 'owner' || u.role === 'curator';
}

export function submissionRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use('/submissions', requireUser);

  /** Submission visible to the user: their own, or any for staff. */
  const load = async (user: UserRow, id: string) => {
    const sub = await getSubmission(ctx, id);
    if (!sub || (sub.user_id !== user.id && !isStaff(user))) throw notFound('No such submission');
    return sub;
  };

  r.post('/submissions', async (req, res) => {
    const user = currentUser(req);
    const s = ctx.settings;
    const staff = isStaff(user);
    if (!staff && !s.membersCanSubmit) throw forbidden('Members cannot submit books to this library');

    const b = body(req.body);
    const sha = typeof b.sha512 === 'string' ? b.sha512.toLowerCase() : '';
    if (!isSha512(sha)) throw badRequest('sha512 must be 128 hex characters');
    const format = oneOf(b.format, BOOK_FORMATS as BookFormat[], 'format');
    if (!s.allowedFormats.includes(format)) {
      throw new HttpError(415, 'unsupported_format', `${format.toUpperCase()} is not accepted by this library`);
    }
    const fileSize = optNum(b, 'fileSize', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
    if (!fileSize) throw badRequest('fileSize is required');
    if (fileSize > s.maxUploadBytes) {
      throw new HttpError(413, 'too_large', `Files may be at most ${s.maxUploadBytes} bytes`);
    }
    const filename = cleanText(str(b, 'filename', { max: 1000 }).split(/[\\/]/).pop() ?? '', 255);
    if (!filename) throw badRequest('filename is required');
    const meta = sanitizeMeta(
      {
        title: typeof b.title === 'string' ? b.title : '',
        authors: authors(b.authors),
        series: optStr(b, 'series', 500),
        seriesIndex: optNum(b, 'seriesIndex', { min: 0, max: 1e9 }),
        description: optStr(b, 'description', 4000, true),
        language: optStr(b, 'language', 35),
        publisher: optStr(b, 'publisher', 500),
        pageCount: optNum(b, 'pageCount', { min: 0, max: 1e7, integer: true }),
      },
      titleFromFilename(filename),
    );

    const book = await findVisibleBook(ctx.db, { sha512: sha });
    const pendingDup = await ctx.db
      .selectFrom('submissions')
      .select('id')
      .where('sha512', '=', sha)
      .where('status', 'in', ['uploading', 'pending'])
      .executeTakeFirst();
    if (book || pendingDup) {
      const dup: DuplicateError = {
        error: 'duplicate',
        message: book ? 'This book is already in the library' : 'This book was already submitted',
        bookId: book?.id ?? null,
        submissionId: pendingDup?.id ?? null,
      };
      return res.status(409).json(dup);
    }

    if (!staff) {
      const usage = await ctx.db
        .selectFrom('submissions')
        .select((eb) => [eb.fn.sum<number>('file_size').as('bytes')])
        .where('user_id', '=', user.id)
        .where((eb) =>
          eb.or([
            eb('status', 'in', ['uploading', 'pending']),
            eb.and([eb('status', '=', 'approved'), eb('book_id', 'is not', null)]),
          ]),
        )
        .executeTakeFirst();
      if (Number(usage?.bytes ?? 0) + fileSize > s.memberQuotaBytes) {
        throw new HttpError(403, 'quota_exceeded', 'This upload would exceed your storage quota');
      }
      const open = await ctx.db
        .selectFrom('submissions')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('user_id', '=', user.id)
        .where('status', 'in', ['uploading', 'pending'])
        .executeTakeFirst();
      if (Number(open?.n ?? 0) >= s.maxPendingPerMember) {
        throw new HttpError(403, 'quota_exceeded', `You may have at most ${s.maxPendingPerMember} pending submissions`);
      }
    }

    const now = ctx.now();
    const row: SubmissionRow = {
      id: uuidv7(),
      user_id: user.id,
      sha512: sha,
      format,
      file_size: fileSize,
      filename,
      title: meta.title,
      authors: JSON.stringify(meta.authors),
      series: meta.series,
      series_index: meta.seriesIndex,
      description: meta.description,
      language: meta.language,
      publisher: meta.publisher,
      page_count: meta.pageCount,
      upload_offset: 0,
      status: 'uploading',
      review_note: null,
      reviewed_by: null,
      reviewed_at: null,
      book_id: null,
      created_at: now,
      updated_at: now,
    };
    await ctx.db.insertInto('submissions').values(row).execute();
    res.status(201).json(submissionDto({ ...row, username: user.username }));
  });

  r.get('/submissions', async (req, res) => {
    const user = currentUser(req);
    const mine = queryString(req.query.mine);
    const status = queryString(req.query.status);
    let q = submissionsWithUser(ctx).orderBy('submissions.id', 'desc').limit(1000);
    if (mine === '1' || mine === 'true' || !isStaff(user)) q = q.where('submissions.user_id', '=', user.id);
    if (status) q = q.where('submissions.status', '=', oneOf(status, STATUSES, 'status'));
    const out: SubmissionListResponse = { items: (await q.execute()).map(submissionDto) };
    res.json(out);
  });

  r.get('/submissions/:id', async (req, res) => {
    res.json(submissionDto(await load(currentUser(req), String(req.params.id))));
  });

  r.delete('/submissions/:id', async (req, res) => {
    await deleteSubmission(ctx, await load(currentUser(req), String(req.params.id)));
    res.status(204).end();
  });

  r.head('/submissions/:id/content', async (req, res) => {
    const user = currentUser(req);
    const sub = await getSubmission(ctx, String(req.params.id));
    if (!sub || sub.user_id !== user.id) throw notFound('No such submission');
    res.setHeader(UPLOAD_OFFSET_HEADER, String(sub.upload_offset));
    res.setHeader('Upload-Length', String(sub.file_size));
    res.setHeader('Cache-Control', 'no-store');
    res.status(204).end();
  });

  r.patch('/submissions/:id/content', async (req, res) => {
    const user = currentUser(req);
    const id = String(req.params.id);
    const sub = await getSubmission(ctx, id);
    if (!sub || sub.user_id !== user.id) throw notFound('No such submission');
    if (sub.status !== 'uploading') throw conflict(`Submission is ${sub.status}, not uploading`);
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== UPLOAD_CONTENT_TYPE) throw new HttpError(415, 'bad_request', `Content-Type must be ${UPLOAD_CONTENT_TYPE}`);
    const header = req.headers[UPLOAD_OFFSET_HEADER.toLowerCase()];
    if (typeof header !== 'string' || !/^\d+$/.test(header)) throw badRequest(`${UPLOAD_OFFSET_HEADER} header is required`);
    if (ctx.locks.has(id)) {
      throw new HttpError(409, 'conflict', 'Another upload request for this submission is in progress', {
        offset: sub.upload_offset,
      }, { [UPLOAD_OFFSET_HEADER]: String(sub.upload_offset) });
    }

    ctx.locks.add(id);
    try {
      const offset = await receiveChunk(ctx, req, sub, Number(header));
      if (offset === sub.file_size) await finalizeUpload(ctx, { ...sub, upload_offset: offset }, user);
      res.setHeader(UPLOAD_OFFSET_HEADER, String(offset));
      res.status(204).end();
    } finally {
      ctx.locks.delete(id);
    }
  });

  /** Lets reviewers (and the submitter) open a pending file before approving it. */
  r.get('/submissions/:id/file', async (req, res) => {
    const sub = await load(currentUser(req), String(req.params.id));
    if (sub.status !== 'pending') throw notFound('Only pending submissions have a file here; approved ones are books');
    res.setHeader('Content-Type', FORMAT_MIME[sub.format]);
    res.setHeader('Content-Disposition', contentDisposition(sub.title, sub.format));
    res.setHeader('Cache-Control', 'private, no-store');
    await sendFile(res, partPath(ctx, sub.id), { cacheControl: false });
  });

  r.post('/submissions/:id/review', async (req, res) => {
    const user = currentUser(req);
    if (!isStaff(user)) throw forbidden();
    const id = String(req.params.id);
    const sub = await getSubmission(ctx, id);
    if (!sub) throw notFound('No such submission');
    const b = body(req.body);
    const action = oneOf(b.action, ['approve', 'reject'] as const, 'action');
    const note = optStr(b, 'note', 2000, true) ?? null;
    if (sub.status !== 'pending') throw conflict(`Submission is ${sub.status}, not pending`);
    if (ctx.locks.has(id)) throw conflict('Submission is busy');
    ctx.locks.add(id);
    try {
      if (action === 'approve') await approveSubmission(ctx, sub, user.id, note);
      else await rejectSubmission(ctx, sub, user.id, note);
    } finally {
      ctx.locks.delete(id);
    }
    res.json(submissionDto((await getSubmission(ctx, id))!));
  });

  return r;
}
