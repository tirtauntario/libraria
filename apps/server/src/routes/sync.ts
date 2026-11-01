/**
 * /sync — end-to-end encrypted personal sync. The server stores opaque
 * ciphertext and only enforces ordering (rev) and optimistic concurrency.
 */
import express, { Router } from 'express';
import {
  MAX_SYNC_CIPHERTEXT,
  MAX_SYNC_PUSH,
  uuidv7,
  type SyncKeysDto,
  type SyncKind,
  type SyncPullResponse,
  type SyncPushItem,
  type SyncPushResponse,
  type SyncRecordDto,
} from '@libraria/core';
import { currentUser, requireUser } from '../auth';
import type { AppContext } from '../context';
import type { SyncRecordRow } from '../db/schema';
import { badRequest, conflict, HttpError, notFound } from '../errors';
import { body, oneOf, queryInt, type Body } from '../validate';

const KINDS: SyncKind[] = ['progress', 'bookmark', 'config'];
const REF_RE = /^[A-Za-z0-9_.:-]{1,255}$/;
/** Lets PUT /sync/keys overwrite existing keys (after a recovery or reset). */
export const REPLACE_KEYS_HEADER = 'X-Libraria-Replace-Keys';
export const PUSH_BODY_LIMIT = MAX_SYNC_PUSH * (MAX_SYNC_CIPHERTEXT + 1024);

function recordDto(r: SyncRecordRow): SyncRecordDto {
  return { id: r.id, kind: r.kind, ref: r.ref, rev: r.rev, deleted: r.deleted === 1, ciphertext: r.ciphertext, updatedAt: r.updated_at };
}

function wrappedKey(b: Body, key: string): string {
  const v = b[key];
  if (typeof v !== 'string' || v.length < 16 || v.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(v)) {
    throw badRequest(`${key} must be a base64url string`);
  }
  return v;
}

function pushItem(v: unknown, i: number): SyncPushItem {
  if (!v || typeof v !== 'object') throw badRequest(`items[${i}] must be an object`);
  const it = v as Record<string, unknown>;
  const kind = oneOf(it.kind, KINDS, `items[${i}].kind`);
  if (typeof it.ref !== 'string' || !REF_RE.test(it.ref)) throw badRequest(`items[${i}].ref is invalid`);
  const baseRev = it.baseRev;
  if (baseRev !== null && !(typeof baseRev === 'number' && Number.isInteger(baseRev) && baseRev >= 0)) {
    throw badRequest(`items[${i}].baseRev must be a non-negative integer or null`);
  }
  if (typeof it.deleted !== 'boolean') throw badRequest(`items[${i}].deleted must be a boolean`);
  if (typeof it.ciphertext !== 'string') throw badRequest(`items[${i}].ciphertext must be a string`);
  if (it.ciphertext.length > MAX_SYNC_CIPHERTEXT) {
    throw new HttpError(413, 'too_large', `items[${i}].ciphertext exceeds ${MAX_SYNC_CIPHERTEXT} characters`);
  }
  return { kind, ref: it.ref, baseRev, deleted: it.deleted, ciphertext: it.ciphertext };
}

export function syncRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use('/sync', requireUser);

  r.get('/sync/keys', async (req, res) => {
    const row = await ctx.db.selectFrom('sync_keys').selectAll().where('user_id', '=', currentUser(req).id).executeTakeFirst();
    if (!row) throw notFound('Sync is not set up');
    const out: SyncKeysDto = { wrappedDataKey: row.wrapped_data_key, wrappedRecoveryKey: row.wrapped_recovery_key };
    res.set('Cache-Control', 'no-store').json(out);
  });

  r.put('/sync/keys', async (req, res) => {
    const user = currentUser(req);
    const b = body(req.body);
    const wrappedDataKey = wrappedKey(b, 'wrappedDataKey');
    const wrappedRecoveryKey = wrappedKey(b, 'wrappedRecoveryKey');
    const replace = req.get(REPLACE_KEYS_HEADER) === '1' || req.get(REPLACE_KEYS_HEADER) === 'true';
    const now = ctx.now();
    const created = await ctx.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('sync_keys').select('id').where('user_id', '=', user.id).executeTakeFirst();
      if (existing && !replace) throw conflict(`Sync keys already exist; send ${REPLACE_KEYS_HEADER}: 1 to replace them`);
      if (existing) {
        await trx
          .updateTable('sync_keys')
          .set({ wrapped_data_key: wrappedDataKey, wrapped_recovery_key: wrappedRecoveryKey, updated_at: now })
          .where('id', '=', existing.id)
          .execute();
        return false;
      }
      await trx
        .insertInto('sync_keys')
        .values({ id: uuidv7(), user_id: user.id, wrapped_data_key: wrappedDataKey, wrapped_recovery_key: wrappedRecoveryKey, updated_at: now })
        .execute();
      return true;
    });
    const out: SyncKeysDto = { wrappedDataKey, wrappedRecoveryKey };
    res.status(created ? 201 : 200).json(out);
  });

  /** Wipes keys and records, e.g. when the user lost both password and recovery key. */
  r.delete('/sync', async (req, res) => {
    const user = currentUser(req);
    await ctx.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('sync_records').where('user_id', '=', user.id).execute();
      await trx.deleteFrom('sync_keys').where('user_id', '=', user.id).execute();
    });
    res.status(204).end();
  });

  r.get('/sync/records', async (req, res) => {
    const user = currentUser(req);
    const since = queryInt(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = queryInt(req.query.limit, MAX_SYNC_PUSH, 1, 1000);
    const rows = await ctx.db
      .selectFrom('sync_records')
      .selectAll()
      .where('user_id', '=', user.id)
      .where('rev', '>', since)
      .orderBy('rev', 'asc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const out: SyncPullResponse = {
      records: page.map(recordDto),
      rev: page.length ? page[page.length - 1]!.rev : since,
      more: rows.length > limit,
    };
    res.set('Cache-Control', 'no-store').json(out);
  });

  r.post('/sync/records', express.json({ limit: PUSH_BODY_LIMIT }), async (req, res) => {
    const user = currentUser(req);
    const b = body(req.body);
    if (!Array.isArray(b.items)) throw badRequest('items must be an array');
    if (b.items.length > MAX_SYNC_PUSH) throw new HttpError(413, 'too_large', `At most ${MAX_SYNC_PUSH} items per push`);
    const items = b.items.map(pushItem);
    const now = ctx.now();

    const out = await ctx.db.transaction().execute(async (trx) => {
      const result: SyncPushResponse = { applied: [], conflicts: [] };
      const { sync_rev } = await trx.selectFrom('users').select('sync_rev').where('id', '=', user.id).executeTakeFirstOrThrow();
      let rev = Number(sync_rev);
      for (const item of items) {
        const existing = await trx
          .selectFrom('sync_records')
          .selectAll()
          .where('user_id', '=', user.id)
          .where('kind', '=', item.kind)
          .where('ref', '=', item.ref)
          .executeTakeFirst();
        if (existing && existing.rev !== item.baseRev) {
          result.conflicts.push(recordDto(existing));
          continue;
        }
        rev += 1;
        const values = { rev, deleted: item.deleted ? 1 : 0, ciphertext: item.ciphertext, updated_at: now };
        let id: string;
        if (existing) {
          id = existing.id;
          await trx.updateTable('sync_records').set(values).where('id', '=', id).execute();
        } else {
          id = uuidv7();
          await trx.insertInto('sync_records').values({ id, user_id: user.id, kind: item.kind, ref: item.ref, ...values }).execute();
        }
        result.applied.push({ ref: item.ref, kind: item.kind, rev, id });
      }
      if (rev !== Number(sync_rev)) await trx.updateTable('users').set({ sync_rev: rev }).where('id', '=', user.id).execute();
      return result;
    });
    res.json(out);
  });

  return r;
}
