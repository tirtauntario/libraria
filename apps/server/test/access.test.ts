import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, makeCbz, newCreds, p, startServer, upload, type TestServer } from './helpers';

let t: TestServer;
let owner: string;
beforeEach(async () => {
  t = await startServer();
  owner = (await t.setup()).token;
});
afterEach(async () => {
  await t.destroy();
});

async function setSettings(patch: Record<string, unknown>) {
  const res = await t.api.patch(p('/settings')).set(bearer(owner)).send(patch);
  expect(res.status).toBe(200);
  return res.body;
}

/** Owner uploads a book (auto-approved) and returns its id. */
async function ownerBook(): Promise<string> {
  const { id, last } = await upload(t, owner, await makeCbz(2));
  expect(last.status).toBe(204);
  const sub = await t.api.get(p(`/submissions/${id}`)).set(bearer(owner));
  return sub.body.bookId as string;
}

describe('role permissions', () => {
  it('enforces the owner / curator / member matrix', async () => {
    const curator = await t.user('cura', 'curator');
    const member = await t.user('mem');
    const bookId = await ownerBook();

    // Books: everyone reads, staff edits.
    expect((await t.api.get(p(`/books/${bookId}`)).set(bearer(member.token))).status).toBe(200);
    expect((await t.api.patch(p(`/books/${bookId}`)).set(bearer(member.token)).send({ title: 'X' })).status).toBe(403);
    expect((await t.api.delete(p(`/books/${bookId}`)).set(bearer(member.token))).status).toBe(403);
    const edit = await t.api.patch(p(`/books/${bookId}`)).set(bearer(curator.token)).send({ title: 'Edited', authors: ['A', 'B'] });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ title: 'Edited', authors: ['A', 'B'] });

    // Users and invites: staff only.
    expect((await t.api.get(p('/users')).set(bearer(member.token))).status).toBe(403);
    expect((await t.api.get(p('/users')).set(bearer(curator.token))).status).toBe(200);
    expect((await t.api.post(p('/invites')).set(bearer(member.token))).status).toBe(403);
    expect((await t.api.post(p('/invites')).set(bearer(curator.token))).status).toBe(201);

    // Roles: owner only; owner cannot be demoted or disabled by anyone.
    const promote = await t.api.patch(p(`/users/${member.userId}`)).set(bearer(curator.token)).send({ role: 'curator' });
    expect(promote.status).toBe(403);
    const ownerId = (await t.api.get(p('/me')).set(bearer(owner))).body.id;
    expect((await t.api.patch(p(`/users/${ownerId}`)).set(bearer(owner)).send({ role: 'member' })).status).toBe(403);
    expect((await t.api.patch(p(`/users/${ownerId}`)).set(bearer(owner)).send({ status: 'disabled' })).status).toBe(403);
    expect((await t.api.patch(p(`/users/${ownerId}`)).set(bearer(curator.token)).send({ status: 'disabled' })).status).toBe(403);
    expect((await t.api.patch(p(`/users/${member.userId}`)).set(bearer(owner)).send({ role: 'owner' })).status).toBe(400);
    // Curators cannot disable other curators.
    const cura2 = await t.user('cura2', 'curator');
    expect((await t.api.patch(p(`/users/${cura2.userId}`)).set(bearer(curator.token)).send({ status: 'disabled' })).status).toBe(403);

    // Settings and sources: owner only.
    expect((await t.api.patch(p('/settings')).set(bearer(curator.token)).send({ name: 'X' })).status).toBe(403);
    expect((await t.api.get(p('/sources')).set(bearer(curator.token))).status).toBe(403);
    expect((await t.api.get(p('/sources/roots')).set(bearer(member.token))).status).toBe(403);
    expect((await t.api.get(p('/sources'))).status).toBe(401);
    expect((await t.api.get(p('/sources')).set(bearer(owner))).status).toBe(200);

    // Review: staff only.
    const sub = await upload(t, member.token, await makeCbz(1));
    expect(sub.last.status).toBe(204);
    expect((await t.api.post(p(`/submissions/${sub.id}/review`)).set(bearer(member.token)).send({ action: 'approve' })).status).toBe(403);
    expect((await t.api.post(p(`/submissions/${sub.id}/review`)).set(bearer(curator.token)).send({ action: 'approve' })).status).toBe(200);

    // Owner promotes; disabling kills sessions.
    expect((await t.api.patch(p(`/users/${member.userId}`)).set(bearer(owner)).send({ role: 'curator' })).body.role).toBe('curator');
    expect((await t.api.patch(p(`/users/${member.userId}`)).set(bearer(owner)).send({ status: 'disabled' })).status).toBe(200);
    expect((await t.api.get(p('/me')).set(bearer(member.token))).status).toBe(401);
    const relog = await t.api.post(p('/auth/login')).send({ username: 'mem', authHash: member.creds.authHash });
    expect(relog.status).toBe(403);
  });

  it('blocks submissions from members when membersCanSubmit is off', async () => {
    const member = await t.user('mem');
    await setSettings({ membersCanSubmit: false });
    const res = await upload(t, member.token, await makeCbz(1));
    expect(res.create.status).toBe(403);
    const staffUpload = await upload(t, owner, await makeCbz(1));
    expect(staffUpload.create.status).toBe(201);
  });
});

describe('registration', () => {
  it('public library: signups are active immediately', async () => {
    await setSettings({ visibility: 'public' });
    expect((await t.api.get(p('/info'))).body.registration).toBe('open');
    const reg = await t.api.post(p('/auth/register')).send({ username: 'pub', ...newCreds() });
    expect(reg.status).toBe(201);
    expect(reg.body.user.status).toBe('active');
    expect(reg.body.token).toBeTruthy();
    expect((await t.api.get(p('/me')).set(bearer(reg.body.token))).status).toBe(200);
  });

  it('private library: pending until approved or rejected', async () => {
    const curator = await t.user('cura', 'curator');
    const a = newCreds();
    const regA = await t.api.post(p('/auth/register')).send({ username: 'alice', ...a });
    const regB = await t.api.post(p('/auth/register')).send({ username: 'bob', ...newCreds() });
    expect(regA.body.user.status).toBe('pending');
    expect((await t.api.post(p('/auth/register')).send({ username: 'ALICE', ...newCreds() })).status).toBe(409);

    const pending = await t.api.get(p('/users')).query({ status: 'pending' }).set(bearer(curator.token));
    expect(pending.body.items.map((u: { username: string }) => u.username).sort()).toEqual(['alice', 'bob']);

    expect((await t.api.patch(p(`/users/${regA.body.user.id}`)).set(bearer(curator.token)).send({ status: 'active' })).status).toBe(200);
    expect((await t.api.patch(p(`/users/${regB.body.user.id}`)).set(bearer(curator.token)).send({ status: 'rejected' })).status).toBe(200);

    expect((await t.api.post(p('/auth/login')).send({ username: 'alice', authHash: a.authHash })).status).toBe(200);
    const rejected = await t.api.post(p('/auth/login')).send({ username: 'bob', authHash: 'q'.repeat(43) });
    expect(rejected.status).toBe(401); // wrong hash still says 401 first
  });

  it('invites: skip approval, single use, expire', async () => {
    const invite = await t.api.post(p('/invites')).set(bearer(owner));
    expect(invite.status).toBe(201);
    expect(invite.body.token).toBeTruthy();
    const list = await t.api.get(p('/invites')).set(bearer(owner));
    expect(list.body.items[0].token).toBeUndefined();
    const stored = await t.ctx.db.selectFrom('invites').selectAll().executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(invite.body.token);

    const reg = await t.api.post(p('/auth/register')).send({ username: 'invited', inviteToken: invite.body.token, ...newCreds() });
    expect(reg.status).toBe(201);
    expect(reg.body.user.status).toBe('active');
    expect(reg.body.token).toBeTruthy();

    const reuse = await t.api.post(p('/auth/register')).send({ username: 'second', inviteToken: invite.body.token, ...newCreds() });
    expect(reuse.status).toBe(400);
    expect((await t.api.get(p('/invites')).set(bearer(owner))).body.items[0].usedBy).toBe(reg.body.user.id);

    // Expiry follows inviteExpiryDays.
    await setSettings({ inviteExpiryDays: 1 });
    const short = await t.api.post(p('/invites')).set(bearer(owner));
    expect(short.body.expiresAt - t.clock.now).toBe(24 * 3600 * 1000);
    t.clock.advance(24 * 3600 * 1000 + 1);
    const expired = await t.api.post(p('/auth/register')).send({ username: 'late', inviteToken: short.body.token, ...newCreds() });
    expect(expired.status).toBe(400);

    // Without skip-approval, an invite still leaves the account pending.
    await setSettings({ invitesSkipApproval: false });
    const third = await t.api.post(p('/invites')).set(bearer(owner));
    const pend = await t.api.post(p('/auth/register')).send({ username: 'third', inviteToken: third.body.token, ...newCreds() });
    expect(pend.body.user.status).toBe('pending');
    expect(pend.body.token).toBeUndefined();

    // Revoke.
    const fourth = await t.api.post(p('/invites')).set(bearer(owner));
    expect((await t.api.delete(p(`/invites/${fourth.body.id}`)).set(bearer(owner))).status).toBe(204);
    const revoked = await t.api.post(p('/auth/register')).send({ username: 'fourth', inviteToken: fourth.body.token, ...newCreds() });
    expect(revoked.status).toBe(400);
  });
});

describe('anonymous access', () => {
  it('private library: everything but info/auth/setup needs a token', async () => {
    const bookId = await ownerBook();
    await setSettings({ anonymousAccess: 'read' }); // ignored while private
    expect((await t.api.get(p('/info'))).status).toBe(200);
    expect((await t.api.get(p('/info'))).body.anonymousAccess).toBe('none');
    expect((await t.api.get(p('/auth/prelogin')).query({ username: 'x12' })).status).toBe(200);
    for (const path of ['/books', `/books/${bookId}`, `/books/${bookId}/file`, `/books/${bookId}/cover`, '/submissions', '/sync/keys', '/me', '/users']) {
      expect((await t.api.get(p(path))).status, path).toBe(401);
    }
  });

  it('public library: none / browse / read', async () => {
    const bookId = await ownerBook();
    await setSettings({ visibility: 'public', anonymousAccess: 'none' });
    expect((await t.api.get(p('/books'))).status).toBe(401);

    await setSettings({ anonymousAccess: 'browse' });
    expect((await t.api.get(p('/books'))).status).toBe(200);
    expect((await t.api.get(p(`/books/${bookId}`))).status).toBe(200);
    expect((await t.api.get(p(`/books/${bookId}/cover`))).status).toBe(200);
    expect((await t.api.get(p(`/books/${bookId}/file`))).status).toBe(401);
    expect((await t.api.get(p('/submissions'))).status).toBe(401);
    expect((await t.api.get(p('/sync/records'))).status).toBe(401);
    expect((await t.api.patch(p(`/books/${bookId}`)).send({ title: 'x' })).status).toBe(401);

    await setSettings({ anonymousAccess: 'read' });
    const file = await t.api.get(p(`/books/${bookId}/file`));
    expect(file.status).toBe(200);
    expect((await t.api.post(p('/submissions')).send({})).status).toBe(401);
  });

  it('rate-limits anonymous requests per IP but not signed-in ones', async () => {
    await t.destroy();
    t = await startServer({ rateLimit: { anonymous: { capacity: 2, refillPerSecond: 0.001 }, auth: { capacity: 100, refillPerSecond: 100 } } });
    owner = (await t.setup()).token;
    expect((await t.api.get(p('/info'))).status).toBe(200);
    expect((await t.api.get(p('/info'))).status).toBe(200);
    expect((await t.api.get(p('/info'))).status).toBe(429);
    expect((await t.api.get(p('/me')).set(bearer(owner))).status).toBe(200);
  });
});

describe('http basics', () => {
  it('answers CORS preflight for allowed origins only, with security headers', async () => {
    await t.destroy();
    t = await startServer({ allowedOrigins: ['https://app.example.org'] });
    const ok = await t.api
      .options(p('/books'))
      .set('Origin', 'https://app.example.org')
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'authorization, upload-offset');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.org');
    expect(ok.headers['access-control-allow-headers']).toMatch(/Upload-Offset/);
    expect(ok.headers['access-control-expose-headers']).toMatch(/Content-Range/);

    const evil = await t.api.options(p('/books')).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();

    const info = await t.api.get(p('/info')).set('Origin', 'https://app.example.org');
    expect(info.headers['access-control-allow-origin']).toBe('https://app.example.org');
    expect(info.headers['x-content-type-options']).toBe('nosniff');
    expect(info.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(info.headers['referrer-policy']).toBe('no-referrer');

    const unknown = await t.api.get(p('/nope'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('not_found');
    const badJson = await t.api.post(p('/auth/login')).set('Content-Type', 'application/json').send('{oops');
    expect(badJson.status).toBe(400);
    expect(badJson.body.error).toBe('bad_request');
  });
});
