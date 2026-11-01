import { DEFAULT_SYNCED_SETTINGS, isUuid, type Bookmark, type Progress } from '@libraria/core';
import { describe, expect, it } from 'vitest';
import { changeKey, withDefaults } from '../src/lib/db/repo';
import { DB_VERSION, MIGRATIONS, openLibrariaDb } from '../src/lib/db/schema';
import { testServices } from './helpers';

describe('schema', () => {
  it('opens at the latest version with every store', async () => {
    const db = await openLibrariaDb('schema-test');
    expect(db.version).toBe(DB_VERSION);
    expect(DB_VERSION).toBe(MIGRATIONS.length);
    expect([...db.objectStoreNames].sort()).toEqual(
      ['bookFiles', 'bookmarks', 'books', 'changes', 'fileBlobs', 'libraries', 'offlineFiles', 'progress', 'settings', 'sources', 'uploads'].sort(),
    );
    db.close();
  });

  it('indexes books without a hash yet (null sha512 is skipped by the unique index)', async () => {
    const s = await testServices();
    const base = { format: 'pdf', title: 't', authors: [] as string[], fileSize: 1, cover: null, customGroup: null, metaSource: 'filename', metaEdited: false, addedAt: 1, updatedAt: 1, lastReadAt: null } as const;
    await s.repo.putBook({ ...base, id: 'a', sha512: null });
    await s.repo.putBook({ ...base, id: 'b', sha512: null });
    await s.repo.putBook({ ...base, id: 'c', sha512: 'f'.repeat(128) });
    await expect(s.repo.putBook({ ...base, id: 'd', sha512: 'f'.repeat(128) })).rejects.toThrow();
    expect(await s.repo.getBookBySha('f'.repeat(128))).toMatchObject({ id: 'c' });
  });
});

describe('repo bootstrap', () => {
  it('creates the device id, local source and default library once', async () => {
    const s = await testServices();
    const meta = await s.repo.init();
    expect(isUuid(meta.deviceId)).toBe(true);
    const again = await s.repo.init();
    expect(again).toEqual(meta);
    const sources = await s.repo.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: meta.localSourceId, config: { kind: 'local' } });
    const libs = await s.repo.listLibraries();
    expect(libs).toEqual([expect.objectContaining({ id: meta.localLibraryId, name: 'On this device', sources: [{ sourceId: meta.localSourceId, path: '' }] })]);
    // Device-only records never enter the sync outbox.
    expect(await s.repo.listChanges()).toEqual([]);
  });

  it('fills missing settings keys from defaults, keeping stored values', () => {
    const stored = { comic: { zoom: 2 }, library: { groupRenames: { a: 'b' } } };
    const merged = withDefaults(DEFAULT_SYNCED_SETTINGS, stored);
    expect(merged.comic.zoom).toBe(2);
    expect(merged.comic.mode).toBe('paged');
    expect(merged.library.groupRenames).toEqual({ a: 'b' });
    expect(merged.pdf.fit).toBe('width');
    expect(withDefaults(DEFAULT_SYNCED_SETTINGS, undefined)).toEqual(DEFAULT_SYNCED_SETTINGS);
  });
});

describe('change log', () => {
  const sha = 'a'.repeat(128);

  it('records progress, bookmarks, libraries, sources and synced settings', async () => {
    let t = 1000;
    const s = await testServices(() => ++t);
    await s.repo.saveProgress(sha, { type: 'page', page: 1, total: 10 });
    const bm = await s.repo.addBookmark(sha, { type: 'page', page: 1, total: 10 }, 'Page 2');
    const lib = await s.repo.createLibrary('Manga');
    const src = await s.repo.createSource('NAS', { kind: 'webdav', url: 'https://nas', username: 'u', password: 'p' });
    await s.repo.createSource('Folder', { kind: 'folder', name: 'Comics' }); // device-only
    await s.repo.saveSyncedSettings(DEFAULT_SYNCED_SETTINGS);

    const keys = (await s.repo.listChanges()).map((c) => c.key);
    expect(keys).toEqual([
      changeKey('progress', sha),
      changeKey('bookmark', bm.id),
      changeKey('library', lib.id),
      changeKey('source', src.id),
      'config:settings:settings',
    ]);
    expect(keys[0]).toBe(`progress:${sha}`);
    expect(keys[2]).toBe(`config:library:${lib.id}`);
  });

  it('coalesces repeated writes and only acks entries that did not change since', async () => {
    let t = 1000;
    const s = await testServices(() => ++t);
    await s.repo.saveProgress(sha, { type: 'page', page: 1, total: 10 });
    const listed = await s.repo.listChanges();
    expect(listed).toHaveLength(1);
    await s.repo.saveProgress(sha, { type: 'page', page: 2, total: 10 }); // written again after listing
    await s.repo.ackChanges(listed);
    const left = await s.repo.listChanges();
    expect(left).toHaveLength(1);
    expect(left[0]!.updatedAt).toBeGreaterThan(listed[0]!.updatedAt);
    await s.repo.ackChanges(left);
    expect(await s.repo.listChanges()).toEqual([]);
  });

  it('does not record the built-in library', async () => {
    const s = await testServices();
    const { localLibraryId } = await s.repo.meta();
    await s.repo.updateLibrary(localLibraryId, { name: 'This iPad' });
    expect(await s.repo.listChanges()).toEqual([]);
  });
});

describe('progress and bookmarks', () => {
  const sha = 'b'.repeat(128);

  it('saves progress with percent and bumps the book lastReadAt', async () => {
    const s = await testServices(() => 5000);
    const base = { format: 'cbz', title: 't', authors: [] as string[], fileSize: 1, cover: null, customGroup: null, metaSource: 'file', metaEdited: false, addedAt: 1, updatedAt: 1, lastReadAt: null } as const;
    await s.repo.putBook({ ...base, id: 'book', sha512: sha });
    const p = await s.repo.saveProgress(sha, { type: 'page', page: 4, total: 9 }, 'book');
    expect(p.percent).toBe(0.5);
    expect((await s.repo.getProgress(sha))?.locator).toEqual({ type: 'page', page: 4, total: 9 });
    expect((await s.repo.getBook('book'))?.lastReadAt).toBe(5000);
  });

  it('merges remote progress last-write-wins', async () => {
    let t = 100;
    const s = await testServices(() => t);
    const { deviceId } = await s.repo.meta();
    await s.repo.saveProgress(sha, { type: 'page', page: 1, total: 10 });
    const older: Progress = { sha512: sha, locator: { type: 'page', page: 8, total: 10 }, percent: 0.8, updatedAt: 50, deviceId: 'other' };
    expect((await s.repo.applyRemoteProgress(older)).deviceId).toBe(deviceId);
    expect((await s.repo.getProgress(sha))?.locator).toMatchObject({ page: 1 });
    const newer = { ...older, updatedAt: 200 };
    await s.repo.applyRemoteProgress(newer);
    expect((await s.repo.getProgress(sha))?.locator).toMatchObject({ page: 8 });
    t = 300;
  });

  it('soft-deletes bookmarks so the deletion can sync', async () => {
    let t = 1;
    const s = await testServices(() => ++t);
    const a = await s.repo.addBookmark(sha, { type: 'page', page: 5, total: 10 }, 'Five');
    await s.repo.addBookmark(sha, { type: 'page', page: 2, total: 10 }, 'Two');
    expect((await s.repo.listBookmarks(sha)).map((b) => b.label)).toEqual(['Two', 'Five']);
    await s.repo.deleteBookmark(a.id);
    expect((await s.repo.listBookmarks(sha)).map((b) => b.label)).toEqual(['Two']);
    const all = await s.repo.listBookmarks(sha, true);
    expect(all.find((b) => b.id === a.id)).toMatchObject({ deleted: true });
    expect(all.find((b) => b.id === a.id)!.updatedAt).toBeGreaterThan(a.updatedAt);

    const remote: Bookmark = { ...a, label: 'Renamed', deleted: false, updatedAt: 1 }; // older than the delete
    await s.repo.applyRemoteBookmark(remote);
    expect((await s.repo.listBookmarks(sha, true)).find((b) => b.id === a.id)).toMatchObject({ deleted: true });
  });
});
