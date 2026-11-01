/**
 * Server-side secrets. The client already stretched the password with
 * Argon2id; the server adds scrypt over auth_hash so a leaked database cannot
 * be replayed as login credentials.
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { toBase64Url } from '@libraria/core';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(secret: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashAuth(authHash: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(authHash, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyAuth(authHash: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(authHash, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A stored hash that never matches; used to keep login timing uniform for unknown users. */
export const DUMMY_AUTH_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${randomBytes(16).toString('base64url')}$${randomBytes(32).toString('base64url')}`;

/** Tokens (sessions, invites, setup) are high-entropy, so a plain SHA-256 is enough. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hmac(secret: string, message: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

export function newToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}
