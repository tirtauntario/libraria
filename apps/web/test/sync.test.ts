import {
  generateDataKey,
  Keyring,
  randomBytes,
  unwrapDataKey,
  type Locator,
  type ServerInfo,
  type SyncPayload,
} from '@libraria/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ServerApi } from '../src/lib/server/api';
import { attachServer, setServerFetch } from '../src/lib/server/servers';
import type { Services } from '../src/lib/services';
import { SyncEngine, SyncKeysChangedError } from '../src/lib/sync/engine';
import { KeyMismatchError, rewrapDataKey, setupOrUnlock, storedKey, unlockWithRecovery, type StoredSyncKey } from '../src/lib/sync/keys';
import { requeueAll } from '../src/lib/sync/outbox';
import { FakeServer } from './fake-server';
import { testServices } from './helpers';

const SHA = 'ab'.repeat(64);
const SHA2 = 'cd'.repeat(64);
const loc = (page: number): Locator => ({ type: 'page', page, total: 11 });

let fake: FakeServer;
let api: ServerApi;

beforeEach(() => {
  fake = new FakeServer();
  setServerFetch(fake.fetch, () => true);
  api = new ServerApi({ baseUrl: fake.url, token: 'token-abcdefghijklmnop', fetch: fake.fetch, isOnline: () => true });
});

describe('sync keys', () => {
  it('first device creates keys; the next unlocks them with the same master key', async () => {
    const master = randomBytes(32);
    const created = await setupOrUnlock(api, master);
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    expect(created.recoveryKey).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4})+/);
    expect(fake.keys).toEqual(created.keys);

    const again = await setupOrUnlock(api, master);
    expect(again.status).toBe('unlocked');
    expect(again.dataKey).toEqual(created.dataKey);
  });

  it('a different password does not unlock; the recovery key does and re-wraps for the new password', async () => {
    const created = await setupOrUnlock(api, randomBytes(32));
    if (created.status !== 'created') throw new Error('expected created');
    const otherMaster = randomBytes(32);
    const err = await setupOrUnlock(api, otherMaster).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyMismatchError);

    await expect(unlockWithRecovery(api, (err as KeyMismatchError).keys, 'AAAA-BBBB', otherMaster)).rejects.toThrow(/recovery key/);
    const r = await unlockWithRecovery(api, (err as KeyMismatchError).keys, created.recoveryKey.toLowerCase(), otherMaster);
    expect(r.dataKey).toEqual(created.dataKey);
    // The server copy now opens with the new master key, and the recovery wrap is unchanged.
    expect(await unwrapDataKey(fake.keys!.wrappedDataKey, otherMaster)).toEqual(created.dataKey);
    expect(fake.keys!.wrappedRecoveryKey).toBe(created.keys.wrappedRecoveryKey);
    expect((await setupOrUnlock(api, otherMaster)).status).toBe('unlocked');
  });

  it('two devices setting up at once end with one key', async () => {
    const master = randomBytes(32);
    const winner = await setupOrUnlock(api, master);
    // The second device saw 404 before the first one's PUT landed.
    let first = true;
    fake.intercept = (method, path) => {
      if (method === 'GET' && path === '/sync/keys' && first) {
        first = false;
        return new Response(JSON.stringify({ error: 'not_found', message: 'x' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
    };
    const loser = await setupOrUnlock(api, master);
    expect(loser.status).toBe('unlocked');
    expect(loser.dataKey).toEqual(winner.dataKey);
  });

  it('a password change re-wraps the stored key', async () => {
    const created = await setupOrUnlock(api, randomBytes(32));
    const stored = storedKey(created.dataKey, created.keys, { sourceId: 's', serverId: 'srv', username: 'u' });
    const next = randomBytes(32);
    expect(await unwrapDataKey(await rewrapDataKey(stored, next), next)).toEqual(created.dataKey);
  });
});

// --- engine ---------------------------------------------------------------------

interface Device {
  s: Services;
  key: StoredSyncKey;
  run(): ReturnType<SyncEngine['run']>;
}

async function device(dataKey: Uint8Array, wrappedRecoveryKey: string): Promise<Device> {
  const s = await testServices();
  const key: StoredSyncKey = { dataKey: '', sourceId: 's', serverId: 'srv', username: 'u', wrappedRecoveryKey, setupAt: 0 };
  const keyring = await Keyring.fromDataKey(dataKey);
  return {
    s,
    key,
    run: () => new SyncEngine(s.repo, api, keyring, key).run(),
  };
}

async function twoDevices() {
  fake.keys = { wrappedDataKey: 'w'.repeat(20), wrappedRecoveryKey: 'r'.repeat(20) };
  const dataKey = generateDataKey();
  const a = await device(dataKey, fake.keys.wrappedRecoveryKey);
  const b = await device(dataKey, fake.keys.wrappedRecoveryKey);
  return { a, b, dataKey };
}

async function decryptAll(dataKey: Uint8Array): Promise<SyncPayload[]> {
  const kr = await Keyring.fromDataKey(dataKey);
  return Promise.all(fake.records.map((r) => kr.decrypt<SyncPayload>(r.kind, r.ref, r.ciphertext)));
}

describe('sync engine', () => {
  it('pushes local changes encrypted, acks them, and the other device applies them', async () => {
    const { a, b, dataKey } = await twoDevices();
    await a.s.repo.saveProgress(SHA, loc(4));
    const bm = await a.s.repo.addBookmark(SHA, loc(2), 'Good bit');
    const settings = await a.s.repo.getSyncedSettings();
    settings.comic.direction = 'rtl';
    await a.s.repo.saveSyncedSettings(settings);

    const r = await a.run();
    expect(r.pushed).toBe(3);
    expect(await a.s.repo.listChanges()).toEqual([]);
    // Refs are HMACs, not hashes or ids; ciphertext hides the content.
    for (const rec of fake.records) {
      expect(rec.ref).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.ciphertext).not.toContain('Good');
    }
    expect(JSON.stringify(fake.records)).not.toContain(SHA);
    expect((await decryptAll(dataKey)).map((p) => p.kind).sort()).toEqual(['bookmark', 'config', 'progress']);

    const rb = await b.run();
    expect(rb.applied).toBe(3);
    expect(await b.s.repo.getProgress(SHA)).toMatchObject({ locator: loc(4) });
    expect((await b.s.repo.listBookmarks(SHA)).map((x) => x.id)).toEqual([bm.id]);
    expect((await b.s.repo.getSyncedSettings()).comic.direction).toBe('rtl');
    // Applying remote data does not echo back.
    expect(await b.s.repo.listChanges()).toEqual([]);
  });

  it('never syncs device-only sources or the built-in library, and strips them from libraries', async () => {
    const { a, b, dataKey } = await twoDevices();
    const { localSourceId, localLibraryId } = await a.s.repo.meta();
    const folder = await a.s.repo.createSource('My folder', { kind: 'folder', name: 'Comics' });
    const dav = await a.s.repo.createSource('NAS', { kind: 'webdav', url: 'https://nas', username: 'u', password: 'secret-pw' });
    const lib = await a.s.repo.createLibrary('Mixed', [
      { sourceId: localSourceId, path: '' },
      { sourceId: folder.id, path: '' },
      { sourceId: dav.id, path: 'comics' },
    ]);
    await a.s.repo.updateLibrary(localLibraryId, { name: 'Renamed local' });
    await requeueAll(a.s.repo);
    await a.run();

    const payloads = await decryptAll(dataKey);
    const sources = payloads.filter((p) => p.kind === 'config' && p.value.type === 'source');
    expect(sources.map((p) => (p.kind === 'config' ? p.value.id : ''))).toEqual([dav.id]);
    const libs = payloads.filter((p) => p.kind === 'config' && p.value.type === 'library');
    expect(libs).toHaveLength(1);
    expect(libs[0]!.kind === 'config' && libs[0]!.value.type === 'library' && libs[0]!.value.value.sources).toEqual([
      { sourceId: dav.id, path: 'comics' },
    ]);
    expect(JSON.stringify(payloads)).not.toContain(localSourceId);

    // B keeps its own device-only refs when the library changes remotely.
    await b.run();
    const bFolder = await b.s.repo.createSource('B folder', { kind: 'folder', name: 'X' });
    const libB = (await b.s.repo.getLibrary(lib.id))!;
    await b.s.repo.updateLibrary(lib.id, { sources: [...libB.sources, { sourceId: bFolder.id, path: '' }] });
    await b.run();
    await a.s.repo.updateLibrary(lib.id, { name: 'Mixed 2' });
    await a.run();
    await b.run();
    const after = (await b.s.repo.getLibrary(lib.id))!;
    expect(after.name).toBe('Mixed 2');
    expect(after.sources).toContainEqual({ sourceId: bFolder.id, path: '' });
    expect(after.sources).toContainEqual({ sourceId: dav.id, path: 'comics' });
    // A still has its own folder and local refs.
    const afterA = (await a.s.repo.getLibrary(lib.id))!;
    expect(afterA.sources).toContainEqual({ sourceId: folder.id, path: '' });
  });

  it('resolves a write conflict: newer remote wins and is applied; newer local is re-pushed on the new rev', async () => {
    const { a, b } = await twoDevices();
    await a.s.repo.saveProgress(SHA, loc(1));
    await a.s.repo.saveProgress(SHA2, loc(1));
    await a.run();
    await b.run();

    // B writes newer progress for SHA and older for SHA2; A the other way round.
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await a.s.repo.saveProgress(SHA, loc(2));
    await tick();
    await b.s.repo.saveProgress(SHA, loc(9));
    await b.s.repo.saveProgress(SHA2, loc(3));
    await tick();
    await a.s.repo.saveProgress(SHA2, loc(7));
    // B's sync lands between A's pull and A's push.
    let armed = true;
    fake.intercept = async (method, path) => {
      if (armed && method === 'POST' && path === '/sync/records') {
        armed = false;
        fake.intercept = null;
        await b.run();
      }
    };
    const r = await a.run();
    expect(r.conflicts).toBe(2);
    expect(await a.s.repo.listChanges()).toEqual([]);
    expect((await a.s.repo.getProgress(SHA))!.locator).toEqual(loc(9));
    expect((await a.s.repo.getProgress(SHA2))!.locator).toEqual(loc(7));

    await b.run();
    expect((await b.s.repo.getProgress(SHA))!.locator).toEqual(loc(9));
    expect((await b.s.repo.getProgress(SHA2))!.locator).toEqual(loc(7));
    expect(await b.s.repo.listChanges()).toEqual([]);
  });

  it('two devices with offline edits converge', async () => {
    const { a, b } = await twoDevices();
    const bmA = await a.s.repo.addBookmark(SHA, loc(1), 'A mark');
    await a.s.repo.saveProgress(SHA, loc(3));
    await new Promise((r) => setTimeout(r, 3));
    const bmB = await b.s.repo.addBookmark(SHA, loc(5), 'B mark');
    await b.s.repo.saveProgress(SHA, loc(6));
    await a.run();
    await b.run();
    await a.run();
    await b.s.repo.deleteBookmark(bmA.id);
    await b.run();
    await a.run();

    for (const d of [a, b]) {
      expect((await d.s.repo.getProgress(SHA))!.locator).toEqual(loc(6));
      expect((await d.s.repo.listBookmarks(SHA)).map((x) => x.id)).toEqual([bmB.id]);
      expect(await d.s.repo.listChanges()).toEqual([]);
    }
    expect((await a.s.repo.listBookmarks(SHA, true)).find((x) => x.id === bmA.id)?.deleted).toBe(true);
  });

  it('a change written during a push stays queued', async () => {
    const { a, dataKey } = await twoDevices();
    await a.s.repo.saveProgress(SHA, loc(1));
    await new Promise((r) => setTimeout(r, 3));
    fake.beforePush = () => void a.s.repo.saveProgress(SHA, loc(2));
    await a.run();
    await a.run();
    expect(await a.s.repo.listChanges()).toEqual([]);
    expect(fake.records).toHaveLength(1);
    const [payload] = await decryptAll(dataKey);
    expect(payload).toMatchObject({ kind: 'progress', value: { locator: loc(2) } });
  });

  it('skips records it cannot decrypt and stops when keys were replaced elsewhere', async () => {
    const { a } = await twoDevices();
    fake.putRecord({ kind: 'progress', ref: 'f'.repeat(64), deleted: false, ciphertext: 'AQ' + 'x'.repeat(40) });
    const r = await a.run();
    expect(r).toMatchObject({ pulled: 1, skipped: 1 });

    fake.keys = { wrappedDataKey: 'w'.repeat(20), wrappedRecoveryKey: 'other'.repeat(5) };
    await expect(a.run()).rejects.toBeInstanceOf(SyncKeysChangedError);
    fake.keys = null;
    await expect(a.run()).rejects.toMatchObject({ reason: 'disabled' });
  });

  it('pulls in pages and keeps the cursor', async () => {
    const { a, b } = await twoDevices();
    for (let i = 0; i < 7; i++) await a.s.repo.addBookmark(SHA, loc(i), `m${i}`);
    await a.run();
    fake.pageLimit = 3;
    const r = await b.run();
    expect(r.applied).toBe(7);
    expect(await b.s.repo.getValue('sync:cursor')).toBe(fake.rev);
    const again = await b.run();
    expect(again.pulled).toBe(0);
  });
});

describe('server dedupe by id', () => {
  it('joining the same server on two devices yields one source and one library', async () => {
    const info = { id: '01900000-0000-7000-8000-0000000000aa', name: 'Club' } as ServerInfo;
    const auth = { user: { id: 'u', username: 'u', role: 'member' as const, status: 'active' as const, createdAt: 1 }, token: 'x'.repeat(20) };
    const { a, b } = await twoDevices();
    await attachServer(a.s.repo, fake.url, info, auth);
    await attachServer(b.s.repo, fake.url, info, auth);
    await a.run();
    await b.run();
    await a.run();
    for (const d of [a, b]) {
      expect((await d.s.repo.listSources()).filter((x) => x.config.kind === 'libraria').map((x) => x.id)).toEqual([info.id]);
      expect((await d.s.repo.listLibraries()).filter((l) => l.name === 'Club')).toHaveLength(1);
    }
  });
});
