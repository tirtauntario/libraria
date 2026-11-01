/** /books */
import express, { Router, type Response } from 'express';
import { sql } from 'kysely';
import { FORMAT_MIME, isSha512, type BookListResponse, type BookLookupResponse } from '@libraria/core';
import { allowAnonymous, currentUser, requireRole, requireUser } from '../auth';
import type { AppContext } from '../context';
import { badRequest, forbidden, HttpError, notFound } from '../errors';
import {
  bookDto,
  COVER_MIME,
  deleteBook,
  findVisibleBook,
  imageExt,
  MAX_COVER_BYTES,
  saveCover,
  searchText,
  servableFile,
  visibleBooks,
} from '../services/books';
import { authors, body, optNum, optStr, queryInt, queryString } from '../validate';
import { join } from 'node:path';

/** Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function contentDisposition(title: string, ext: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'book';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
  const encoded = encodeURIComponent(`${base}.${ext}`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}.${ext}"; filename*=UTF-8''${encoded}`;
}

export function sendFile(res: Response, path: string, options: Parameters<Response['sendFile']>[1] = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    res.sendFile(path, { dotfiles: 'allow', ...options }, (err) => {
      if (!err) return resolve();
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNABORTED' || code === 'ECONNRESET' || res.headersSent) return resolve();
      reject(code === 'ENOENT' ? notFound('File is missing') : err);
    });
  });
}

function escapeLike(term: string): string {
  return term.replace(/[!%_]/g, (c) => `!${c}`);
}

export function bookRoutes(ctx: AppContext): Router {
  const r = Router();
  const staff = requireRole('owner', 'curator');
  const browse = allowAnonymous(ctx, 'browse');
  const read = allowAnonymous(ctx, 'read');

  const getBook = async (id: string) => {
    const book = await findVisibleBook(ctx.db, { id });
    if (!book) throw notFound('No such book');
    return book;
  };

  r.get('/books', browse, async (req, res) => {
    const limit = queryInt(req.query.limit, 100, 1, 500);
    const cursor = queryString(req.query.cursor);
    const q = queryString(req.query.q)?.trim().toLowerCase() ?? '';
    let query = visibleBooks(ctx.db).selectAll('books').orderBy('books.id', 'desc').limit(limit + 1);
    if (cursor) query = query.where('books.id', '<', cursor);
    for (const term of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
      query = query.where(sql<boolean>`${sql.ref('books.search_text')} like ${`%${escapeLike(term)}%`} escape '!'`);
    }
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const out: BookListResponse = {
      items: page.map(bookDto),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
    res.json(out);
  });

  r.get('/books/lookup', requireUser, async (req, res) => {
    const sha = queryString(req.query.sha512)?.toLowerCase();
    if (!isSha512(sha)) throw badRequest('sha512 must be 128 lowercase hex characters');
    const book = await findVisibleBook(ctx.db, { sha512: sha });
    const sub = await ctx.db
      .selectFrom('submissions')
      .select('id')
      .where('sha512', '=', sha)
      .where('status', 'in', ['uploading', 'pending'])
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const out: BookLookupResponse = { bookId: book?.id ?? null, submissionId: sub?.id ?? null };
    res.json(out);
  });

  r.get('/books/:id', browse, async (req, res) => {
    res.json(bookDto(await getBook(String(req.params.id))));
  });

  r.patch('/books/:id', staff, async (req, res) => {
    const book = await getBook(String(req.params.id));
    const b = body(req.body);
    const patch: Record<string, unknown> = {};
    const title = optStr(b, 'title', 500);
    if (title === null) throw badRequest('title cannot be empty');
    if (title !== undefined) patch.title = title;
    if (b.authors !== undefined) patch.authors = JSON.stringify(authors(b.authors));
    for (const [key, col, max, multiline] of [
      ['series', 'series', 500, false],
      ['description', 'description', 4000, true],
      ['language', 'language', 35, false],
      ['publisher', 'publisher', 500, false],
    ] as const) {
      const v = optStr(b, key, max, multiline);
      if (v !== undefined) patch[col] = v;
    }
    const seriesIndex = optNum(b, 'seriesIndex', { min: 0, max: 1e9 });
    if (seriesIndex !== undefined) patch.series_index = seriesIndex;
    if (Object.keys(patch).length === 0) throw badRequest('Nothing to update');

    const next = { ...book, ...patch } as typeof book;
    await ctx.db
      .updateTable('books')
      .set({
        ...patch,
        search_text: searchText(next.title, JSON.parse(next.authors) as string[], next.series),
        updated_at: ctx.now(),
      })
      .where('id', '=', book.id)
      .execute();
    res.json(bookDto(await getBook(book.id)));
  });

  r.delete('/books/:id', staff, async (req, res) => {
    await deleteBook(ctx, await getBook(String(req.params.id)));
    res.status(204).end();
  });

  r.get('/books/:id/file', read, async (req, res) => {
    const book = await getBook(String(req.params.id));
    const found = await servableFile(ctx, book.id);
    if (!found) throw notFound('The file for this book is missing');
    res.setHeader('Content-Type', FORMAT_MIME[book.format]);
    res.setHeader('Content-Disposition', contentDisposition(book.title, book.format));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    await sendFile(res, found.path, { cacheControl: false });
  });

  r.get('/books/:id/cover', browse, async (req, res) => {
    const book = await getBook(String(req.params.id));
    if (!book.cover_ext) throw notFound('This book has no cover');
    res.setHeader('Content-Type', COVER_MIME[book.cover_ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    await sendFile(res, join(ctx.paths.covers, `${book.id}.${book.cover_ext}`), { cacheControl: false });
  });

  r.put(
    '/books/:id/cover',
    requireUser,
    express.raw({ type: () => true, limit: MAX_COVER_BYTES }),
    async (req, res) => {
      const user = currentUser(req);
      const book = await getBook(String(req.params.id));
      const isStaff = user.role === 'owner' || user.role === 'curator';
      if (!isStaff && book.submitted_by !== user.id) throw forbidden('Only staff or the submitter can change the cover');
      const data = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
      if (!imageExt(data)) throw new HttpError(415, 'unsupported_format', 'Cover must be a PNG, JPEG, GIF or WebP image');
      await saveCover(ctx, book.id, data);
      res.json(bookDto(await getBook(book.id)));
    },
  );

  return r;
}
