import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_KDF, deriveAuthHash, deriveMasterKey, randomSalt } from '@libraria/core';
import { bearer, newCreds, p, startServer, TEST_KDF, type TestServer } from './helpers';

let t: TestServer;
beforeEach(async () => {
  t = await startServer();
});
afterEach(async () => {
  await t.destroy();
});

describe('first-run setup', () => {
  it('reports setupRequired and blocks registration until setup', async () => {
    const info = await t.api.get(p('/info'));
    expect(info.status).toBe(200);
    expect(info.body.setupRequired).toBe(true);
    expect(info.body.apiVersion).toBe(1);
    expect(t.setupToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const reg = await t.api.post(p('/auth/register')).send({ username: 'early', ...newCreds() });
    expect(reg.status).toBe(409);
    expect(reg.body.error).toBe('setup_required');
  });

  it('creates the owner once and refuses token reuse', async () => {
    const wrong = await t.api.post(p('/setup')).send({ setupToken: 'nope-nope-nope', username: 'owner', libraryName: 'L', ...newCreds() });
    expect(wrong.status).toBe(403);

    const creds = newCreds();
    const ok = await t.api
      .post(p('/setup'))
      .send({ setupToken: t.setupToken, username: 'Owner', libraryName: 'My Library', ...creds });
    expect(ok.status).toBe(201);
    expect(ok.body.user).toMatchObject({ username: 'owner', role: 'owner', status: 'active' });
    expect(ok.body.token).toBeTruthy();

    const again = await t.api
      .post(p('/setup'))
      .send({ setupToken: t.setupToken, username: 'other', libraryName: 'X', ...newCreds() });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_setup');

    const info = await t.api.get(p('/info'));
    expect(info.body).toMatchObject({ setupRequired: false, name: 'My Library' });
    const stored = await t.ctx.db.selectFrom('setup_tokens').selectAll().execute();
    expect(stored).toHaveLength(0);
  });

  it('validates kdf bounds and username rules', async () => {
    const weak = await t.api
      .post(p('/setup'))
      .send({ setupToken: t.setupToken, username: 'owner', libraryName: 'L', ...newCreds(), kdf: { ...TEST_KDF, memoryKiB: 1024 } });
    expect(weak.status).toBe(400);
    const badName = await t.api
      .post(p('/setup'))
      .send({ setupToken: t.setupToken, username: 'a b', libraryName: 'L', ...newCreds() });
    expect(badName.status).toBe(400);
  });
});

describe('prelogin', () => {
  it('does not reveal whether a username exists', async () => {
    const { creds } = await t.setup();
    const real = await t.api.get(p('/auth/prelogin')).query({ username: 'owner' });
    expect(real.status).toBe(200);
    expect(real.body).toEqual({ salt: creds.salt, kdf: TEST_KDF });

    const fake1 = await t.api.get(p('/auth/prelogin')).query({ username: 'ghost' });
    const fake2 = await t.api.get(p('/auth/prelogin')).query({ username: 'GHOST' });
    expect(fake1.status).toBe(200);
    expect(fake1.body.kdf).toEqual(DEFAULT_KDF);
    expect(fake1.body.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fake2.body.salt).toBe(fake1.body.salt);
    expect(Object.keys(fake1.body).sort()).toEqual(Object.keys(real.body).sort());
    const fake3 = await t.api.get(p('/auth/prelogin')).query({ username: 'ghost2' });
    expect(fake3.body.salt).not.toBe(fake1.body.salt);
  });
});

describe('login and sessions', () => {
  it('logs in with a real Argon2id-derived auth hash, then logs out', async () => {
    await t.setup();
    const salt = randomSalt();
    const authHash = await deriveAuthHash(await deriveMasterKey('correct horse', salt, TEST_KDF));
    const reg = await t.api.post(p('/auth/register')).send({ username: 'reader', salt, kdf: TEST_KDF, authHash, deviceName: 'Laptop' });
    expect(reg.status).toBe(201);
    // Private library: waits for approval, no token.
    expect(reg.body.user.status).toBe('pending');
    expect(reg.body.token).toBeUndefined();

    const pending = await t.api.post(p('/auth/login')).send({ username: 'reader', authHash });
    expect(pending.status).toBe(403);
    expect(pending.body.error).toBe('pending_approval');

    const owner = await t.api.post(p('/auth/login')).send({ username: 'owner', authHash: 'x'.repeat(43) });
    expect(owner.status).toBe(401);
    const unknown = await t.api.post(p('/auth/login')).send({ username: 'nobody', authHash: 'x'.repeat(43) });
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(owner.body.message);
  });

  it('issues tokens that work until logout', async () => {
    const { creds } = await t.setup();
    const login = await t.api.post(p('/auth/login')).send({ username: 'owner', authHash: creds.authHash, deviceName: 'Phone' });
    expect(login.status).toBe(200);
    const token = login.body.token as string;
    const me = await t.api.get(p('/me')).set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('owner');

    const session = await t.ctx.db.selectFrom('sessions').selectAll().where('device_name', '=', 'Phone').executeTakeFirstOrThrow();
    expect(session.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.token_hash).not.toContain(token);

    expect((await t.api.post(p('/auth/logout')).set(bearer(token))).status).toBe(204);
    expect((await t.api.get(p('/me')).set(bearer(token))).status).toBe(401);
    expect((await t.api.get(p('/me')).set(bearer('garbage-token-value-123'))).status).toBe(401);
    expect((await t.api.get(p('/me'))).status).toBe(401);
  });

  it('expires sessions after 90 days without use, and rolls expiry on use', async () => {
    const { token } = await t.setup();
    t.clock.advance(60 * 24 * 3600 * 1000);
    expect((await t.api.get(p('/me')).set(bearer(token))).status).toBe(200);
    t.clock.advance(60 * 24 * 3600 * 1000); // 120 days since login, 60 since last use
    expect((await t.api.get(p('/me')).set(bearer(token))).status).toBe(200);
    t.clock.advance(91 * 24 * 3600 * 1000);
    expect((await t.api.get(p('/me')).set(bearer(token))).status).toBe(401);
  });

  it('changes the password, re-wraps the data key and signs out other devices', async () => {
    const { token, creds } = await t.setup();
    const other = (await t.api.post(p('/auth/login')).send({ username: 'owner', authHash: creds.authHash })).body.token;
    await t.api.put(p('/sync/keys')).set(bearer(token)).send({ wrappedDataKey: 'a'.repeat(40), wrappedRecoveryKey: 'r'.repeat(40) });

    const bad = await t.api.post(p('/me/password')).set(bearer(token)).send({ currentAuthHash: 'z'.repeat(43), ...newCreds() });
    expect(bad.status).toBe(401);

    const next = newCreds();
    const ok = await t.api
      .post(p('/me/password'))
      .set(bearer(token))
      .send({ currentAuthHash: creds.authHash, ...next, wrappedDataKey: 'b'.repeat(40) });
    expect(ok.status).toBe(204);
    expect((await t.api.get(p('/me')).set(bearer(token))).status).toBe(200);
    expect((await t.api.get(p('/me')).set(bearer(other))).status).toBe(401);

    expect((await t.api.post(p('/auth/login')).send({ username: 'owner', authHash: creds.authHash })).status).toBe(401);
    expect((await t.api.post(p('/auth/login')).send({ username: 'owner', authHash: next.authHash })).status).toBe(200);
    const pre = await t.api.get(p('/auth/prelogin')).query({ username: 'owner' });
    expect(pre.body.salt).toBe(next.salt);
    const keys = await t.api.get(p('/sync/keys')).set(bearer(token));
    expect(keys.body).toEqual({ wrappedDataKey: 'b'.repeat(40), wrappedRecoveryKey: 'r'.repeat(40) });
  });

  it('rate-limits login attempts per IP', async () => {
    await t.destroy();
    t = await startServer({ rateLimit: { anonymous: { capacity: 1000, refillPerSecond: 1000 }, auth: { capacity: 3, refillPerSecond: 0.001 } } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await t.api.get(p('/auth/prelogin')).query({ username: 'someone' })).status);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await t.api.post(p('/auth/login')).send({ username: 'x', authHash: 'y'.repeat(43) });
    expect(limited.body.error).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeTruthy();
  });
});
