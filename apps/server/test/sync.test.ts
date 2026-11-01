import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Keyring,
  MAX_SYNC_CIPHERTEXT,
  MAX_SYNC_PUSH,
  generateDataKey,
  type SyncPullResponse,
  type SyncPushItem,
  type SyncPushResponse,
} from '@libraria/core';
import { bearer, p, startServer, type TestServer } from './helpers';

let t: TestServer;
let a: string;
let b: string;
beforeEach(async () => {
  t = await startServer();
  a = (await t.setup()).token;
  b = (await t.user('bee')).token;
});
afterEach(async () => {
  await t.destroy();
});

const push = async (token: string, items: SyncPushItem[]) => {
  const res = await t.api.post(p('/sync/records')).set(bearer(token)).send({ items });
  return res;
};
const pull = async (token: string, since = 0, limit?: number) => {
  const res = await t.api.get(p('/sync/records')).query({ since, ...(limit ? { limit } : {}) }).set(bearer(token));
  expect(res.status).toBe(200);
  return res.body as SyncPullResponse;
};
const item = (ref: string, baseRev: number | null, ciphertext = `ct-${ref}-${Math.random()}`): SyncPushItem => ({
  kind: 'progress',
  ref,
  baseRev,
  deleted: false,
  ciphertext,
});

describe('sync keys', () => {
  it('creates once, refuses silent overwrite, replaces with header, wipes', async () => {
    expect((await t.api.get(p('/sync/keys')).set(bearer(a))).status).toBe(404);
    const keys = { wrappedDataKey: 'd'.repeat(60), wrappedRecoveryKey: 'r'.repeat(60) };
    expect((await t.api.put(p('/sync/keys')).set(bearer(a)).send(keys)).status).toBe(201);
    expect((await t.api.get(p('/sync/keys')).set(bearer(a))).body).toEqual(keys);
    expect((await t.api.get(p('/sync/keys')).set(bearer(b))).status).toBe(404);

    const next = { wrappedDataKey: 'e'.repeat(60), wrappedRecoveryKey: 's'.repeat(60) };
    const conflict = await t.api.put(p('/sync/keys')).set(bearer(a)).send(next);
    expect(conflict.status).toBe(409);
    const replaced = await t.api.put(p('/sync/keys')).set(bearer(a)).set('X-Libraria-Replace-Keys', '1').send(next);
    expect(replaced.status).toBe(200);
    expect((await t.api.get(p('/sync/keys')).set(bearer(a))).body).toEqual(next);
    expect((await t.api.put(p('/sync/keys')).set(bearer(a)).send({ wrappedDataKey: 'not base64!', wrappedRecoveryKey: 'x'.repeat(30) })).status).toBe(400);

    await push(a, [item('r1', null)]);
    expect((await t.api.delete(p('/sync')).set(bearer(a))).status).toBe(204);
    expect((await t.api.get(p('/sync/keys')).set(bearer(a))).status).toBe(404);
    expect((await pull(a)).records).toHaveLength(0);
  });
});

describe('sync records', () => {
  it('stores real ciphertext opaquely and round-trips it', async () => {
    const ring = await Keyring.fromDataKey(generateDataKey());
    const ref = await ring.ref('progress:' + 'a'.repeat(128));
    const ct = await ring.encrypt('progress', ref, { percent: 0.5 });
    const res = await push(a, [{ kind: 'progress', ref, baseRev: null, deleted: false, ciphertext: ct }]);
    expect(res.status).toBe(200);
    const got = await pull(a);
    expect(got.records[0]!.ciphertext).toBe(ct);
    expect(await ring.decrypt('progress', ref, got.records[0]!.ciphertext)).toEqual({ percent: 0.5 });
  });

  it('assigns increasing per-user revs and pulls in order with paging', async () => {
    const r1 = (await push(a, [item('one', null), item('two', null), item('three', null)])).body as SyncPushResponse;
    expect(r1.conflicts).toEqual([]);
    expect(r1.applied.map((x) => x.rev)).toEqual([1, 2, 3]);
    for (const x of r1.applied) expect(x.id).toMatch(/^[0-9a-f-]{36}$/);

    // Another user's revs are independent.
    const rb = (await push(b, [item('one', null)])).body as SyncPushResponse;
    expect(rb.applied[0]!.rev).toBe(1);
    expect((await pull(b)).records.map((r) => r.ref)).toEqual(['one']);

    const page1 = await pull(a, 0, 2);
    expect(page1.records.map((r) => r.ref)).toEqual(['one', 'two']);
    expect(page1).toMatchObject({ rev: 2, more: true });
    const page2 = await pull(a, page1.rev, 2);
    expect(page2.records.map((r) => r.ref)).toEqual(['three']);
    expect(page2).toMatchObject({ rev: 3, more: false });
    const empty = await pull(a, 3);
    expect(empty).toEqual({ records: [], rev: 3, more: false });

    // Updating moves the record to a new rev; same id.
    const oneId = r1.applied[0]!.id;
    const upd = (await push(a, [{ ...item('one', 1), deleted: true }])).body as SyncPushResponse;
    expect(upd.applied[0]).toMatchObject({ ref: 'one', rev: 4, id: oneId });
    const latest = await pull(a, 3);
    expect(latest.records).toHaveLength(1);
    expect(latest.records[0]).toMatchObject({ ref: 'one', rev: 4, deleted: true, id: oneId, kind: 'progress' });
    // Pull from 0 shows each record once at its latest rev.
    expect((await pull(a)).records.map((r) => `${r.ref}@${r.rev}`)).toEqual(['two@2', 'three@3', 'one@4']);
  });

  it('rejects stale writes with the current record', async () => {
    await push(a, [item('doc', null, 'v1')]);
    await push(a, [item('doc', 1, 'v2')]);
    const stale = (await push(a, [item('doc', 1, 'v3-stale'), item('fresh', null, 'f1')])).body as SyncPushResponse;
    expect(stale.applied.map((x) => x.ref)).toEqual(['fresh']);
    expect(stale.conflicts).toHaveLength(1);
    expect(stale.conflicts[0]).toMatchObject({ ref: 'doc', rev: 2, ciphertext: 'v2' });

    // A client that believes the record is new also conflicts when it exists.
    const dupNew = (await push(a, [item('doc', null, 'again')])).body as SyncPushResponse;
    expect(dupNew.conflicts[0]).toMatchObject({ ref: 'doc', rev: 2 });

    // Same ref under another kind is a different record.
    const other = (await push(a, [{ ...item('doc', null), kind: 'bookmark' }])).body as SyncPushResponse;
    expect(other.applied).toHaveLength(1);

    // Two writes to one ref in a single push: the second is stale.
    const both = (await push(a, [item('pair', null, 'p1'), item('pair', null, 'p2')])).body as SyncPushResponse;
    expect(both.applied).toHaveLength(1);
    expect(both.conflicts[0]).toMatchObject({ ref: 'pair', ciphertext: 'p1' });
  });

  it('enforces push size and ciphertext limits, and validates items', async () => {
    const tooMany = Array.from({ length: MAX_SYNC_PUSH + 1 }, (_, i) => item(`r${i}`, null, 'x'));
    expect((await push(a, tooMany)).status).toBe(413);
    const max = Array.from({ length: MAX_SYNC_PUSH }, (_, i) => item(`r${i}`, null, 'x'));
    const ok = await push(a, max);
    expect(ok.status).toBe(200);
    expect(ok.body.applied).toHaveLength(MAX_SYNC_PUSH);

    expect((await push(a, [item('big', null, 'x'.repeat(MAX_SYNC_CIPHERTEXT + 1))])).status).toBe(413);
    expect((await push(a, [item('edge', null, 'x'.repeat(MAX_SYNC_CIPHERTEXT))])).status).toBe(200);

    expect((await push(a, [{ ...item('k', null), kind: 'nope' as 'progress' }])).status).toBe(400);
    expect((await push(a, [{ ...item('bad ref!', null) }])).status).toBe(400);
    expect((await push(a, [{ ...item('k', -1) }])).status).toBe(400);
    expect((await t.api.post(p('/sync/records')).set(bearer(a)).send({ nope: 1 })).status).toBe(400);
    expect((await t.api.post(p('/sync/records')).send({ items: [] })).status).toBe(401);
  });
});
