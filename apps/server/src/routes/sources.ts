/** /sources — server disk sources (owner only). */
import { Router } from 'express';
import {
  uuidv7,
  type ServerSourceDto,
  type ServerSourceListResponse,
  type SourceRootsResponse,
} from '@libraria/core';
import { requireRole } from '../auth';
import type { AppContext } from '../context';
import type { SourceRow } from '../db/schema';
import { conflict, notFound } from '../errors';
import { pruneOrphanBooks } from '../services/books';
import { realRoots, resolveSourcePath, scanSource } from '../services/scan';
import { body, oneOf, str } from '../validate';

export function sourceRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use('/sources', requireRole('owner'));

  const dto = async (s: SourceRow): Promise<ServerSourceDto> => {
    const row = await ctx.db
      .selectFrom('book_files')
      .select((eb) => eb.fn.count<number>('book_id').distinct().as('n'))
      .where('source_id', '=', s.id)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return { id: s.id, kind: s.kind, path: s.path, lastScanAt: s.last_scan_at, bookCount: Number(row?.n ?? 0) };
  };

  const load = async (id: string) => {
    const s = await ctx.db.selectFrom('sources').selectAll().where('id', '=', id).executeTakeFirst();
    if (!s) throw notFound('No such source');
    return s;
  };

  const ensureUnique = async (path: string, exceptId?: string) => {
    let q = ctx.db.selectFrom('sources').select('id').where('path', '=', path);
    if (exceptId) q = q.where('id', '!=', exceptId);
    if (await q.executeTakeFirst()) throw conflict('A source with this path already exists');
  };

  r.get('/sources/roots', async (_req, res) => {
    const out: SourceRootsResponse = { roots: await realRoots(ctx) };
    res.json(out);
  });

  r.get('/sources', async (_req, res) => {
    const rows = await ctx.db.selectFrom('sources').selectAll().orderBy('id').execute();
    const out: ServerSourceListResponse = { items: await Promise.all(rows.map(dto)) };
    res.json(out);
  });

  r.post('/sources', async (req, res) => {
    const b = body(req.body);
    const kind = oneOf(b.kind, ['disk'] as const, 'kind');
    const path = await resolveSourcePath(ctx, str(b, 'path', { max: 4096 }));
    await ensureUnique(path);
    const row: SourceRow = { id: uuidv7(), kind, path, last_scan_at: null, created_at: ctx.now() };
    await ctx.db.insertInto('sources').values(row).execute();
    res.status(201).json(await dto(row));
  });

  r.get('/sources/:id', async (req, res) => {
    res.json(await dto(await load(String(req.params.id))));
  });

  r.patch('/sources/:id', async (req, res) => {
    const source = await load(String(req.params.id));
    const path = await resolveSourcePath(ctx, str(body(req.body), 'path', { max: 4096 }));
    await ensureUnique(path, source.id);
    if (path !== source.path) {
      // Files under the old path no longer belong to this source.
      await ctx.db.deleteFrom('book_files').where('source_id', '=', source.id).execute();
      await ctx.db.updateTable('sources').set({ path, last_scan_at: null }).where('id', '=', source.id).execute();
      await pruneOrphanBooks(ctx);
    }
    res.json(await dto(await load(source.id)));
  });

  r.delete('/sources/:id', async (req, res) => {
    const source = await load(String(req.params.id));
    if (ctx.locks.has(source.id)) throw conflict('A scan of this source is running');
    await ctx.db.deleteFrom('book_files').where('source_id', '=', source.id).execute();
    await ctx.db.deleteFrom('sources').where('id', '=', source.id).execute();
    await pruneOrphanBooks(ctx);
    res.status(204).end();
  });

  r.post('/sources/:id/scan', async (req, res) => {
    const source = await load(String(req.params.id));
    if (ctx.locks.has(source.id)) throw conflict('A scan of this source is already running');
    ctx.locks.add(source.id);
    try {
      res.json(await scanSource(ctx, source));
    } finally {
      ctx.locks.delete(source.id);
    }
  });

  return r;
}
