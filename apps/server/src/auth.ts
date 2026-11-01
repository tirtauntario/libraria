import type { RequestHandler } from 'express';
import { randomToken, uuidv7, type Role, type UserDto } from '@libraria/core';
import type { AppContext } from './context';
import type { SessionRow, UserRow } from './db/schema';
import { forbidden, HttpError, unauthorized } from './errors';
import { hashToken } from './security';

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Do not rewrite last_used/expiry more often than this. */
const SESSION_TOUCH_MS = 60 * 1000;

export interface Auth {
  user: UserRow;
  session: SessionRow;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Auth;
    }
  }
}

export function userDto(u: UserRow): UserDto {
  return { id: u.id, username: u.username, role: u.role, status: u.status, createdAt: u.created_at };
}

export function pendingError(): HttpError {
  return new HttpError(403, 'pending_approval', 'This account is waiting for approval');
}

/** Error for a user who may not hold a session, or null if they may. */
export function statusError(user: UserRow): HttpError | null {
  if (user.status === 'active') return null;
  if (user.status === 'pending') return pendingError();
  return forbidden('This account is disabled');
}

export async function createSession(ctx: AppContext, userId: string, deviceName?: string | null): Promise<string> {
  const token = randomToken(32);
  const now = ctx.now();
  await ctx.db
    .insertInto('sessions')
    .values({
      id: uuidv7(),
      user_id: userId,
      token_hash: hashToken(token),
      device_name: deviceName ?? null,
      created_at: now,
      last_used_at: now,
      expires_at: now + SESSION_TTL_MS,
    })
    .execute();
  return token;
}

/** Reads the bearer token, if any, and attaches req.auth. Invalid tokens are a 401. */
export function authenticate(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header) return next();
    const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(header.trim());
    if (!m) throw unauthorized('Malformed Authorization header');
    const session = await ctx.db
      .selectFrom('sessions')
      .selectAll()
      .where('token_hash', '=', hashToken(m[1]!))
      .executeTakeFirst();
    const now = ctx.now();
    if (!session || session.expires_at <= now) {
      if (session) await ctx.db.deleteFrom('sessions').where('id', '=', session.id).execute();
      throw unauthorized('Session expired or invalid');
    }
    const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', session.user_id).executeTakeFirst();
    if (!user) throw unauthorized('Session expired or invalid');
    const err = statusError(user);
    if (err) throw err;
    if (now - session.last_used_at > SESSION_TOUCH_MS) {
      session.last_used_at = now;
      session.expires_at = now + SESSION_TTL_MS;
      await ctx.db
        .updateTable('sessions')
        .set({ last_used_at: now, expires_at: session.expires_at })
        .where('id', '=', session.id)
        .execute();
    }
    req.auth = { user, session };
    next();
  };
}

export function currentUser(req: Parameters<RequestHandler>[0]): UserRow {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const user = currentUser(req);
    if (!roles.includes(user.role)) throw forbidden();
    next();
  };
}

/**
 * Lets anonymous visitors through when the library is public and its
 * anonymousAccess allows the level. Signed-in users always pass.
 */
export function allowAnonymous(ctx: AppContext, level: 'browse' | 'read'): RequestHandler {
  return (req, _res, next) => {
    if (req.auth) return next();
    const { visibility, anonymousAccess } = ctx.settings;
    const ok =
      visibility === 'public' &&
      (anonymousAccess === 'read' || (anonymousAccess === 'browse' && level === 'browse'));
    if (!ok) throw unauthorized();
    next();
  };
}
