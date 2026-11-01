/** /users, /invites, /settings */
import { Router } from 'express';
import {
  BOOK_FORMATS,
  randomToken,
  uuidv7,
  type BookFormat,
  type InviteDto,
  type InviteListResponse,
  type LibrarySettings,
  type UserListResponse,
  type UserStatus,
} from '@libraria/core';
import { currentUser, requireRole, userDto } from '../auth';
import { saveSettings, type AppContext } from '../context';
import type { InviteRow } from '../db/schema';
import { badRequest, forbidden, notFound } from '../errors';
import { hashToken } from '../security';
import { body, oneOf, optBool, optNum, optStr, queryString } from '../validate';

const STATUSES: UserStatus[] = ['pending', 'active', 'rejected', 'disabled'];
const DAY_MS = 24 * 60 * 60 * 1000;

function inviteDto(i: InviteRow, token?: string): InviteDto {
  const dto: InviteDto = { id: i.id, createdBy: i.created_by, expiresAt: i.expires_at, usedBy: i.used_by, createdAt: i.created_at };
  if (token) dto.token = token;
  return dto;
}

export function adminRoutes(ctx: AppContext): Router {
  const r = Router();
  const staff = requireRole('owner', 'curator');
  const owner = requireRole('owner');

  // --- users ---------------------------------------------------------------

  r.get('/users', staff, async (req, res) => {
    const status = queryString(req.query.status);
    let q = ctx.db.selectFrom('users').selectAll().orderBy('id', 'asc');
    if (status) q = q.where('status', '=', oneOf(status, STATUSES, 'status'));
    const out: UserListResponse = { items: (await q.execute()).map(userDto) };
    res.json(out);
  });

  r.patch('/users/:id', staff, async (req, res) => {
    const actor = currentUser(req);
    const b = body(req.body);
    const target = await ctx.db.selectFrom('users').selectAll().where('id', '=', String(req.params.id)).executeTakeFirst();
    if (!target) throw notFound('No such user');
    if (target.role === 'owner') throw forbidden('The owner cannot be changed');

    const patch: { status?: UserStatus; role?: 'curator' | 'member' } = {};
    if (b.role !== undefined) {
      if (actor.role !== 'owner') throw forbidden('Only the owner changes roles');
      patch.role = oneOf(b.role, ['curator', 'member'] as const, 'role');
    }
    if (b.status !== undefined) {
      // Curators review members; only the owner manages curators.
      if (actor.role !== 'owner' && target.role !== 'member') throw forbidden('Only the owner manages curators');
      patch.status = oneOf(b.status, ['active', 'rejected', 'disabled'] as const, 'status');
    }
    if (!patch.role && !patch.status) throw badRequest('Nothing to update');

    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ ...patch, updated_at: ctx.now() }).where('id', '=', target.id).execute();
      if (patch.status && patch.status !== 'active') {
        await trx.deleteFrom('sessions').where('user_id', '=', target.id).execute();
      }
    });
    const updated = await ctx.db.selectFrom('users').selectAll().where('id', '=', target.id).executeTakeFirstOrThrow();
    res.json(userDto(updated));
  });

  // --- invites -------------------------------------------------------------

  r.post('/invites', staff, async (req, res) => {
    const actor = currentUser(req);
    const token = randomToken(24);
    const now = ctx.now();
    const row: InviteRow = {
      id: uuidv7(),
      token_hash: hashToken(token),
      created_by: actor.id,
      expires_at: now + ctx.settings.inviteExpiryDays * DAY_MS,
      used_by: null,
      used_at: null,
      created_at: now,
    };
    await ctx.db.insertInto('invites').values(row).execute();
    res.status(201).json(inviteDto(row, token));
  });

  r.get('/invites', staff, async (_req, res) => {
    const rows = await ctx.db.selectFrom('invites').selectAll().orderBy('id', 'desc').execute();
    const out: InviteListResponse = { items: rows.map((i) => inviteDto(i)) };
    res.json(out);
  });

  r.delete('/invites/:id', staff, async (req, res) => {
    const result = await ctx.db.deleteFrom('invites').where('id', '=', String(req.params.id)).executeTakeFirst();
    if (!result.numDeletedRows) throw notFound('No such invite');
    res.status(204).end();
  });

  // --- settings ------------------------------------------------------------

  r.get('/settings', staff, (_req, res) => {
    res.json(ctx.settings);
  });

  r.patch('/settings', owner, async (req, res) => {
    const b = body(req.body);
    const next: LibrarySettings = { ...ctx.settings, allowedFormats: [...ctx.settings.allowedFormats] };
    const name = optStr(b, 'name', 100);
    if (name !== undefined) {
      if (!name) throw badRequest('name is required');
      next.name = name;
    }
    const description = optStr(b, 'description', 2000, true);
    if (description !== undefined) next.description = description ?? '';
    if (b.visibility !== undefined) next.visibility = oneOf(b.visibility, ['public', 'private'] as const, 'visibility');
    if (b.anonymousAccess !== undefined) {
      next.anonymousAccess = oneOf(b.anonymousAccess, ['none', 'browse', 'read'] as const, 'anonymousAccess');
    }
    const num = (key: keyof LibrarySettings, min: number, max: number) => {
      const v = optNum(b, key, { min, max, integer: true });
      if (v === null) throw badRequest(`${key} cannot be null`);
      if (v !== undefined) (next as unknown as Record<string, number>)[key] = v;
    };
    num('maxUploadBytes', 1, 1024 ** 4);
    num('memberQuotaBytes', 0, 1024 ** 5);
    num('maxPendingPerMember', 0, 100_000);
    num('inviteExpiryDays', 1, 3650);
    const bool = (key: 'membersCanSubmit' | 'invitesSkipApproval') => {
      const v = optBool(b, key);
      if (v !== undefined) next[key] = v;
    };
    bool('membersCanSubmit');
    bool('invitesSkipApproval');
    if (b.allowedFormats !== undefined) {
      if (!Array.isArray(b.allowedFormats)) throw badRequest('allowedFormats must be an array');
      const formats = b.allowedFormats.map((f) => oneOf(f, BOOK_FORMATS as BookFormat[], 'allowedFormats'));
      next.allowedFormats = BOOK_FORMATS.filter((f) => formats.includes(f));
    }
    await saveSettings(ctx, next);
    res.json(next);
  });

  return r;
}
