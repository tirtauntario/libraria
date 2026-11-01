/**
 * Client API, uploads and the sync engine against the real server
 * (in-process, temp data dir), with two simulated devices.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator } from '@libraria/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importFiles } from '../src/lib/library/import';
import { openBook } from '../src/lib/library/open';
import { ServerError } from '../src/lib/server/api';
import { deriveInThread, setKeyDeriver } from '../src/lib/server/kdf';
import { anonymousApi, apiFor, attachServer, setupOwner, signIn, signUp } from '../src/lib/server/servers';
import { refreshServerCatalog, registerLibrariaSource } from '../src/lib/server/source';
import { enqueueUpload, listUploads, processUploads } from '../src/lib/server/uploads';
import type { Services } from '../src/lib/services';
import { SyncEngine } from '../src/lib/sync/engine';
import { keyringOf, setupOrUnlock, storedKey, type StoredSyncKey } from '../src/lib/sync/keys';
import { requeueAll } from '../src/lib/sync/outbox';
import { cbzFile, epubFile, testServices } from './helpers';
import { startRealServer, TEST_KDF, type RunningServer } from './server-harness';

setKeyDeriver(deriveInThread);
registerLibrariaSource();

let srv: RunningServer;
beforeAll(async () => {
  srv = await startRealServer();
});
afterAll(async () => {
  await srv?.stop();
});

const PASSWORD = 'correct horse battery staple';
const WEBDAV_PASSWORD = 'webdav-password-xyzzy-42';
const loc = (progression: number): Locator => ({ type: 'epub', spine: 0, progression, total: 1 });

async function engineFor(s: Services, key: StoredSyncKey, sourceId: string) {
  const source = (await s.repo.getSource(sourceId)) as Parameters<typeof apiFor>[0];
  return new SyncEngine(s.repo, apiFor(source, s.repo), await keyringOf(key), key);
}

function sqliteBytes(): Buffer {
  const parts = ['libraria.db', 'libraria.db-wal'].map((f) => join(srv.dataDir, f)).filter(existsSync);
  return Buffer.concat(parts.map((p) => readFileSync(p)));
}

describe('client against the real server', () => {
  let ownerKey: Uint8Array;
  let A: Services;
  let sourceId: string;

  it('first-run setup, owner upload is approved at once and links the local copy', async () => {
    const api = anonymousApi(srv.url);
    expect((await api.info()).setupRequired).toBe(true);
    await expect(setupOwner(srv.url, 'wrong-token', 'owner', PASSWORD, 'Club', { kdf: TEST_KDF })).rejects.toMatchObject({ status: 403 });

    const setup = await setupOwner(srv.url, srv.setupToken, 'owner', PASSWORD, 'Reading Club', { kdf: TEST_KDF });
    ownerKey = setup.masterKey;
    expect(setup.info.setupRequired).toBe(false);
    expect(setup.auth.user.role).toBe('owner');

    A = await testServices();
    const source = await attachServer(A.repo, srv.url, setup.info, setup.auth);
    sourceId = source.id;
    expect(source.id).toBe(setup.info.id);
    expect((await A.repo.getLibrary(source.id))?.name).toBe('Reading Club');

    const file = await epubFile('shared.epub', 'Shared Title');
    const { added } = await importFiles([file], A);
    const book = added[0]!;
    await enqueueUpload(A, source, book);
    await processUploads(A, { chunkBytes: 700 });
    const [job] = await listUploads(A);
    expect(job).toMatchObject({ status: 'approved', offset: file.size, coverDone: true });
    expect(job!.serverBookId).toBeTruthy();

    // The server copy and the local one are the same book.
    const files = await A.repo.listBookFiles(book.id);
    expect(files.map((f) => f.sourceId).sort()).toEqual([source.id, (await A.repo.meta()).localSourceId].sort());

    // Sending it again is a no-op: the server has it.
    const again = await enqueueUpload(A, source, book);
    expect(again.id).toBe(job!.id);
  });

  it('member: private library signup waits for approval, submissions need review, download works', async () => {
    const pending = await signUp(srv.url, 'mia', 'mia password 1', { kdf: TEST_KDF });
    expect(pending.auth.user.status).toBe('pending');
    expect(pending.auth.token).toBeUndefined();
    await expect(signIn(srv.url, 'mia', 'mia password 1')).rejects.toMatchObject({ name: 'PendingApprovalError' });

    const owner = apiFor((await A.repo.getSource(sourceId)) as never, A.repo);
    const waiting = await owner.listUsers('pending');
    expect(waiting.items.map((u) => u.username)).toEqual(['mia']);
    await owner.updateUser(waiting.items[0]!.id, { status: 'active' });

    await expect(signIn(srv.url, 'mia', 'wrong password')).rejects.toMatchObject({ status: 401 });
    const login = await signIn(srv.url, 'mia', 'mia password 1');
    const M = await testServices();
    const msrc = await attachServer(M.repo, srv.url, login.info, login.auth);
    expect(msrc.config.role).toBe('member');

    // The catalog arrives with server metadata and a SHA-512.
    const r = await refreshServerCatalog(msrc, M);
    expect(r.added).toBe(1);
    const [shared] = await M.repo.listBooks();
    expect(shared).toMatchObject({ title: 'Shared Title', authors: ['Ada Lovelace'], metaSource: 'file' });
    expect(shared!.sha512).toMatch(/^[0-9a-f]{128}$/);

    // Download for offline reading.
    const opened = await openBook(shared!.id, M);
    expect(opened.origin).toBe('download');
    expect(await M.repo.getOffline(shared!.id)).toBeTruthy();

    // Member submission: uploaded, then pending until the owner approves.
    const own = await cbzFile('mias-comic.cbz', 2, 'mia');
    const { added } = await importFiles([own], M);
    await enqueueUpload(M, msrc, added[0]!);
    await processUploads(M, { chunkBytes: 512 });
    let [job] = (await listUploads(M)).filter((j) => j.bookId === added[0]!.id);
    expect(job!.status).toBe('pending');

    const queue = await owner.listSubmissions({ status: 'pending' });
    expect(queue.items.map((s) => s.username)).toEqual(['mia']);
    const pendingFile = await owner.submissionFile(queue.items[0]!.id);
    expect(pendingFile.size).toBe(own.size);
    await owner.review(queue.items[0]!.id, { action: 'approve', note: 'Thanks!' });

    await processUploads(M);
    [job] = (await listUploads(M)).filter((j) => j.bookId === added[0]!.id);
    expect(job!.status).toBe('approved');
    expect((await owner.allBooks()).length).toBe(2);
  });

  it('two devices of one user converge through end-to-end encrypted sync', async () => {
    // Device A: first sync setup creates the keys.
    const src = (await A.repo.getSource(sourceId)) as Parameters<typeof apiFor>[0];
    const created = await setupOrUnlock(apiFor(src, A.repo), ownerKey);
    expect(created.status).toBe('created');
    const keyA = storedKey(created.dataKey, created.keys, { sourceId, serverId: src.config.serverId, username: 'owner' });
    await requeueAll(A.repo);

    // A private book, never uploaded: its title and hash must stay off the server.
    const secret = await epubFile('diary.epub', 'Private Garden Journal');
    const { added } = await importFiles([secret], A);
    const diary = added[0]!;
    await A.repo.saveProgress(diary.sha512!, loc(0.5), diary.id);
    const bm = await A.repo.addBookmark(diary.sha512!, loc(0.25), 'Marked passage alpha');
    const nas = await A.repo.createSource('Attic NAS', { kind: 'webdav', url: 'https://nas.example/dav', username: 'me', password: WEBDAV_PASSWORD });
    const { localSourceId } = await A.repo.meta();
    const lib = await A.repo.createLibrary('Bedside Favourites', [
      { sourceId: localSourceId, path: '' },
      { sourceId: nas.id, path: 'books' },
      { sourceId, path: '' },
    ]);
    const settingsA = await A.repo.getSyncedSettings();
    settingsA.book.fontSize = 140;
    await A.repo.saveSyncedSettings(settingsA);

    const rA = await (await engineFor(A, keyA, sourceId)).run();
    expect(rA.pushed).toBeGreaterThanOrEqual(5);
    expect(await A.repo.listChanges()).toEqual([]);

    // Device B signs in with the same password and unlocks the same data key.
    const login = await signIn(srv.url, 'owner', PASSWORD);
    const B = await testServices();
    const srcB = await attachServer(B.repo, srv.url, login.info, login.auth);
    expect(srcB.id).toBe(sourceId);
    const unlocked = await setupOrUnlock(apiFor(srcB, B.repo), login.masterKey);
    expect(unlocked.status).toBe('unlocked');
    expect(Buffer.from(unlocked.dataKey).equals(Buffer.from(created.dataKey))).toBe(true);
    const keyB = storedKey(unlocked.dataKey, unlocked.keys, { sourceId, serverId: srcB.config.serverId, username: 'owner' });
    await requeueAll(B.repo);
    const rB = await (await engineFor(B, keyB, sourceId)).run();
    expect(rB.applied).toBeGreaterThanOrEqual(5);

    expect(await B.repo.getProgress(diary.sha512!)).toMatchObject({ percent: 0.5 });
    expect((await B.repo.listBookmarks(diary.sha512!)).map((b) => b.label)).toEqual(['Marked passage alpha']);
    const nasB = await B.repo.getSource(nas.id);
    expect(nasB?.config).toMatchObject({ kind: 'webdav', password: WEBDAV_PASSWORD });
    const libB = await B.repo.getLibrary(lib.id);
    expect(libB?.name).toBe('Bedside Favourites');
    // A's device-only source was stripped; B's own local source is not involved.
    expect(libB?.sources).toEqual([
      { sourceId: nas.id, path: 'books' },
      { sourceId, path: '' },
    ]);
    expect((await B.repo.getSyncedSettings()).book.fontSize).toBe(140);
    // Only one copy of the server, even though both devices joined it.
    expect((await B.repo.listSources()).filter((s) => s.config.kind === 'libraria')).toHaveLength(1);

    // B reads further and deletes the bookmark; A picks both up.
    await B.repo.saveProgress(diary.sha512!, loc(0.9));
    await B.repo.deleteBookmark(bm.id);
    await (await engineFor(B, keyB, sourceId)).run();
    await (await engineFor(A, keyA, sourceId)).run();
    expect(await A.repo.getProgress(diary.sha512!)).toMatchObject({ percent: 0.9 });
    expect(await A.repo.listBookmarks(diary.sha512!)).toEqual([]);
    expect(await A.repo.listChanges()).toEqual([]);

    // The server holds ciphertext only.
    const raw = sqliteBytes();
    for (const plain of [WEBDAV_PASSWORD, 'Marked passage alpha', 'Bedside Favourites', 'Attic NAS', 'Private Garden Journal', diary.sha512!]) {
      expect(raw.includes(Buffer.from(plain, 'utf8')), plain).toBe(false);
    }
    // ...but it does hold records.
    const pulled = await apiFor(srcB, B.repo).pullSync(0);
    expect(pulled.records.length).toBeGreaterThanOrEqual(5);
  });

  it('maps server errors and rejects stale sessions', async () => {
    const src = (await A.repo.getSource(sourceId)) as Parameters<typeof apiFor>[0];
    const bad = apiFor({ ...src, config: { ...src.config, token: 'x'.repeat(43) } }, A.repo);
    const err = await bad.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized' });
    const { getServerState } = await import('../src/lib/server/servers');
    expect((await getServerState(A.repo, src.id)).sessionExpired).toBe(true);
  });
});
