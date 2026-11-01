/** /info, /setup, /auth/*, /me */
import { Router } from 'express';
import {
  API_VERSION,
  DEFAULT_KDF,
  isValidKdf,
  toBase64Url,
  uuidv7,
  type AuthResponse,
  type KdfParams,
  type PreloginResponse,
  type ServerInfo,
} from '@libraria/core';
import { createSession, currentUser, requireUser, statusError, userDto } from '../auth';
import { ownerExists, saveSettings, type AppContext } from '../context';
import type { UserRow } from '../db/schema';
import { badRequest, forbidden, HttpError, unauthorized } from '../errors';
import { DUMMY_AUTH_HASH, hashAuth, hashToken, hmac, verifyAuth } from '../security';
import { base64url, body, optStr, queryString, str, username, type Body } from '../validate';
import { SERVER_VERSION } from '../version';

export const CAPABILITIES = ['books', 'range', 'covers', 'submissions', 'resumable-upload', 'sources', 'invites', 'sync'];

function kdfOf(b: Body): KdfParams {
  if (!isValidKdf(b.kdf)) throw badRequest('kdf is missing or out of bounds');
  const { algorithm, memoryKiB, iterations, parallelism } = b.kdf;
  return { algorithm, memoryKiB, iterations, parallelism };
}

interface Credentials {
  username: string;
  salt: string;
  kdf: KdfParams;
  authHash: string;
  deviceName: string | null;
}

function credentials(b: Body): Credentials {
  return {
    username: username(b.username),
    salt: base64url(b, 'salt', 16, 128),
    kdf: kdfOf(b),
    authHash: base64url(b, 'authHash', 16, 512),
    deviceName: optStr(b, 'deviceName', 100) ?? null,
  };
}

function setupRequired(): HttpError {
  return new HttpError(409, 'setup_required', 'This server has not been set up yet');
}

export function accountRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/info', async (_req, res) => {
    const s = ctx.settings;
    const info: ServerInfo = {
      id: ctx.serverId,
      name: s.name,
      description: s.description,
      apiVersion: API_VERSION,
      serverVersion: SERVER_VERSION,
      setupRequired: !(await ownerExists(ctx)),
      visibility: s.visibility,
      anonymousAccess: s.visibility === 'public' ? s.anonymousAccess : 'none',
      registration: s.visibility === 'public' ? 'open' : 'approval',
      membersCanSubmit: s.membersCanSubmit,
      maxUploadBytes: s.maxUploadBytes,
      allowedFormats: [...s.allowedFormats],
      capabilities: CAPABILITIES,
      oauth: { google: ctx.config.oauth.google, dropbox: ctx.config.oauth.dropbox },
    };
    res.set('Cache-Control', 'no-cache').json(info);
  });

  r.post('/setup', async (req, res) => {
    const b = body(req.body);
    const setupToken = str(b, 'setupToken', { max: 200 });
    const creds = credentials(b);
    const libraryName = str(b, 'libraryName', { max: 100 });
    const now = ctx.now();
    const authStored = await hashAuth(creds.authHash);

    const user = await ctx.db.transaction().execute(async (trx) => {
      const owner = await trx.selectFrom('users').select('id').where('role', '=', 'owner').executeTakeFirst();
      if (owner) throw new HttpError(409, 'already_setup', 'This server is already set up');
      const token = await trx
        .selectFrom('setup_tokens')
        .select('id')
        .where('token_hash', '=', hashToken(setupToken))
        .executeTakeFirst();
      if (!token) throw forbidden('Invalid setup token');
      const row: UserRow = {
        id: uuidv7(),
        username: creds.username,
        auth_hash: authStored,
        salt: creds.salt,
        kdf: JSON.stringify(creds.kdf),
        role: 'owner',
        status: 'active',
        sync_rev: 0,
        invite_id: null,
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto('users').values(row).execute();
      await trx.deleteFrom('setup_tokens').execute();
      return row;
    });
    await saveSettings(ctx, { ...ctx.settings, name: libraryName });
    ctx.log.info(`Setup complete: owner "${user.username}", library "${libraryName}"`);
    const token = await createSession(ctx, user.id, creds.deviceName);
    const out: AuthResponse = { user: userDto(user), token };
    res.status(201).json(out);
  });

  r.get('/auth/prelogin', async (req, res) => {
    const name = username(queryString(req.query.username));
    const user = await ctx.db.selectFrom('users').select(['salt', 'kdf']).where('username', '=', name).executeTakeFirst();
    // Unknown names get a stable fake salt so responses do not reveal who has an account.
    const out: PreloginResponse = user
      ? { salt: user.salt, kdf: JSON.parse(user.kdf) as KdfParams }
      : { salt: toBase64Url(hmac(ctx.secret, `prelogin:${name}`).subarray(0, 16)), kdf: DEFAULT_KDF };
    res.set('Cache-Control', 'no-store').json(out);
  });

  r.post('/auth/register', async (req, res) => {
    const b = body(req.body);
    const creds = credentials(b);
    const inviteToken = optStr(b, 'inviteToken', 200) ?? null;
    if (!(await ownerExists(ctx))) throw setupRequired();
    const s = ctx.settings;
    const now = ctx.now();
    const authStored = await hashAuth(creds.authHash);

    const user = await ctx.db.transaction().execute(async (trx) => {
      let inviteId: string | null = null;
      if (inviteToken) {
        const invite = await trx
          .selectFrom('invites')
          .selectAll()
          .where('token_hash', '=', hashToken(inviteToken))
          .executeTakeFirst();
        if (!invite || invite.used_by !== null || invite.expires_at <= now) {
          throw badRequest('Invite is invalid, used or expired');
        }
        inviteId = invite.id;
      }
      const taken = await trx.selectFrom('users').select('id').where('username', '=', creds.username).executeTakeFirst();
      if (taken) throw new HttpError(409, 'conflict', 'Username is taken');
      const active = s.visibility === 'public' || (inviteId !== null && s.invitesSkipApproval);
      const row: UserRow = {
        id: uuidv7(),
        username: creds.username,
        auth_hash: authStored,
        salt: creds.salt,
        kdf: JSON.stringify(creds.kdf),
        role: 'member',
        status: active ? 'active' : 'pending',
        sync_rev: 0,
        invite_id: inviteId,
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto('users').values(row).execute();
      if (inviteId) {
        await trx.updateTable('invites').set({ used_by: row.id, used_at: now }).where('id', '=', inviteId).execute();
      }
      return row;
    });

    const out: AuthResponse = { user: userDto(user) };
    if (user.status === 'active') out.token = await createSession(ctx, user.id, creds.deviceName);
    res.status(201).json(out);
  });

  r.post('/auth/login', async (req, res) => {
    const b = body(req.body);
    const authHash = base64url(b, 'authHash', 16, 512);
    const deviceName = optStr(b, 'deviceName', 100) ?? null;
    let name: string | null = null;
    try {
      name = username(b.username);
    } catch {
      name = null;
    }
    const user = name
      ? await ctx.db.selectFrom('users').selectAll().where('username', '=', name).executeTakeFirst()
      : undefined;
    const ok = await verifyAuth(authHash, user?.auth_hash ?? DUMMY_AUTH_HASH);
    if (!user || !ok) throw unauthorized('Wrong username or password');
    const err = statusError(user);
    if (err) throw err;
    const out: AuthResponse = { user: userDto(user), token: await createSession(ctx, user.id, deviceName) };
    res.json(out);
  });

  r.post('/auth/logout', requireUser, async (req, res) => {
    await ctx.db.deleteFrom('sessions').where('id', '=', req.auth!.session.id).execute();
    res.status(204).end();
  });

  r.get('/me', requireUser, (req, res) => {
    res.json(userDto(currentUser(req)));
  });

  r.post('/me/password', requireUser, async (req, res) => {
    const user = currentUser(req);
    const b = body(req.body);
    const current = base64url(b, 'currentAuthHash', 16, 512);
    const salt = base64url(b, 'salt', 16, 128);
    const kdf = kdfOf(b);
    const authHash = base64url(b, 'authHash', 16, 512);
    let wrapped: string | null = null;
    if (b.wrappedDataKey !== undefined && b.wrappedDataKey !== null) wrapped = base64url(b, 'wrappedDataKey', 16, 4096);
    if (!(await verifyAuth(current, user.auth_hash))) throw unauthorized('Current password is wrong');

    const stored = await hashAuth(authHash);
    const now = ctx.now();
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ auth_hash: stored, salt, kdf: JSON.stringify(kdf), updated_at: now })
        .where('id', '=', user.id)
        .execute();
      if (wrapped) {
        await trx
          .updateTable('sync_keys')
          .set({ wrapped_data_key: wrapped, updated_at: now })
          .where('user_id', '=', user.id)
          .execute();
      }
      // Other devices must sign in again with the new password.
      await trx.deleteFrom('sessions').where('user_id', '=', user.id).where('id', '!=', req.auth!.session.id).execute();
    });
    res.status(204).end();
  });

  return r;
}
