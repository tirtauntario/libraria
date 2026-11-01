import type { Source } from '@libraria/core';
import { describe, expect, it } from 'vitest';
import { bookIdsInLibrary } from '../src/lib/library/catalog';
import { keepOffline, openBook } from '../src/lib/library/open';
import { scanSource } from '../src/lib/library/scan';
import { dueForRescan, removeSource, scanRoots } from '../src/lib/library/sources';
import { FolderDriver, folderAccess, rememberHandle, requestFolderAccess, type DirHandle, type FileHandle } from '../src/lib/sources/folder';
import { getSourceKind, registerSourceKind } from '../src/lib/sources';
import { cbzFile, epubFile, testServices } from './helpers';

// Node has no showDirectoryPicker: use the real folder driver as if it had.
registerSourceKind({ ...getSourceKind('folder')!, isSupported: () => true });

type Tree = { [name: string]: File | Tree };

/** An in-memory FileSystemDirectoryHandle with a switchable permission. */
class FakeDir implements DirHandle {
  readonly kind = 'directory' as const;
  permission: PermissionState = 'granted';
  grantOnRequest = true;
  constructor(
    readonly name: string,
    private readonly tree: Tree,
  ) {}
  async *entries(): AsyncIterable<[string, DirHandle | FileHandle]> {
    for (const [name, v] of Object.entries(this.tree)) yield [name, v instanceof File ? fileHandle(v) : new FakeDir(name, v)];
  }
  async getDirectoryHandle(name: string): Promise<DirHandle> {
    const v = this.tree[name];
    if (!v) throw new DOMException('missing', 'NotFoundError');
    if (v instanceof File) throw new DOMException('file', 'TypeMismatchError');
    return new FakeDir(name, v);
  }
  async getFileHandle(name: string): Promise<FileHandle> {
    const v = this.tree[name];
    if (!v) throw new DOMException('missing', 'NotFoundError');
    if (!(v instanceof File)) throw new DOMException('dir', 'TypeMismatchError');
    return fileHandle(v);
  }
  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    if (this.grantOnRequest) this.permission = 'granted';
    return this.permission;
  }
}

const fileHandle = (f: File): FileHandle => ({ kind: 'file', name: f.name, getFile: async () => f });

async function setup() {
  const s = await testServices();
  const comic = await cbzFile('Night Garden v01.cbz', 3, 'folder-1');
  const tree: Tree = {
    Comics: { 'Night Garden v01.cbz': comic, '.hidden': { 'x.cbz': await cbzFile('x.cbz') } },
    'notes.txt': new File(['hi'], 'notes.txt'),
    'Reading Room.epub': await epubFile('Reading Room.epub', 'The Reading Room'),
  };
  const root = new FakeDir('Books', tree);
  rememberHandle('h1', root);
  const source = await s.repo.createSource('Books', { kind: 'folder', name: 'Books', handleId: 'h1' });
  return { s, root, tree, source, comic };
}

describe('folder source (File System Access)', () => {
  it('lists folders and files with size and mtime', async () => {
    const { s, source } = await setup();
    const d = new FolderDriver(source, s.repo);
    const out = [];
    for await (const e of d.list('')) out.push([e.path, e.isDir]);
    expect(out).toEqual([
      ['Comics', true],
      ['notes.txt', false],
      ['Reading Room.epub', false],
    ]);
    const sub = [];
    for await (const e of d.list('Comics')) sub.push(e);
    expect(sub.find((e) => e.name === 'Night Garden v01.cbz')).toMatchObject({ path: 'Comics/Night Garden v01.cbz', size: expect.any(Number), mtime: 1_700_000_000_000 });
  });

  it('is device-only and never synced', async () => {
    const { s } = await setup();
    expect((await s.repo.listChanges()).some((c) => c.kind === 'source')).toBe(false);
  });

  it('scans, then opens books in place without copying them', async () => {
    const { s, source, comic } = await setup();
    expect(await scanSource(source, '', s)).toMatchObject({ added: 2 });
    const book = (await s.repo.listBooks()).find((b) => b.title === 'Night Garden v01')!;
    const opened = await openBook(book.id, s);
    expect(opened.origin).toBe('local');
    expect(opened.blob).toBe(comic); // the File itself
    expect(await s.repo.getOffline(opened.book.id)).toBeUndefined();
    expect(opened.book.sha512).toMatch(/^[0-9a-f]{128}$/);
  });

  it('reports lost permission as a "permission" problem and recovers after a grant', async () => {
    const { s, root, source } = await setup();
    await scanSource(source, '', s);
    const book = (await s.repo.listBooks())[0]!;
    root.permission = 'prompt';
    expect(await folderAccess(s.repo, source)).toBe('prompt');
    const d = new FolderDriver(source, s.repo);
    await expect(d.read('Reading Room.epub')).rejects.toMatchObject({ code: 'permission' });
    await expect(openBook(book.id, s)).rejects.toThrow(/permission/);
    expect(await requestFolderAccess(s.repo, source)).toBe(true);
    expect((await openBook(book.id, s)).origin).toBe('local');
  });

  it('maps missing files to not-found and reports a missing handle', async () => {
    const { s, source } = await setup();
    const d = new FolderDriver(source, s.repo);
    await expect(d.read('Comics/nope.cbz')).rejects.toMatchObject({ code: 'not-found' });
    expect(await d.stat('nope/x.cbz')).toBeNull();
    const orphan: Source = { ...source, id: 'o', config: { kind: 'folder', name: 'Gone', handleId: 'unknown' } };
    await expect(new FolderDriver(orphan, s.repo).read('a.cbz')).rejects.toMatchObject({ code: 'config' });
    expect(await folderAccess(s.repo, orphan)).toBe('missing');
  });

  it('keepOffline copies a folder book into the file store, so it survives the folder', async () => {
    const { s, source, root } = await setup();
    await scanSource(source, '', s);
    const book = (await s.repo.listBooks()).find((b) => b.title === 'Night Garden v01')!;
    const rec = await keepOffline(book.id, s);
    expect(rec).toMatchObject({ pinned: true });
    root.permission = 'denied';
    expect((await openBook(book.id, s)).origin).toBe('offline');
  });

  it('a removed file keeps its book when there is an offline copy', async () => {
    const { s, source, tree } = await setup();
    await scanSource(source, '', s);
    const book = (await s.repo.listBooks()).find((b) => b.title === 'Night Garden v01')!;
    const kept = await keepOffline(book.id, s);
    const bookId = kept!.bookId;
    delete (tree.Comics as Tree)['Night Garden v01.cbz'];
    expect(await scanSource(source, '', s)).toMatchObject({ removed: 1 });
    expect(await s.repo.getBook(bookId)).toBeDefined();
    const lib = await s.repo.createLibrary('Books', [{ sourceId: source.id, path: '' }]);
    expect(bookIdsInLibrary(lib, await s.repo.listAllBookFiles()).has(bookId)).toBe(true);
    expect((await openBook(bookId, s)).origin).toBe('offline');
  });
});

describe('source management', () => {
  it('scans the folders libraries use, without nested duplicates', () => {
    const lib = (sources: { sourceId: string; path: string }[], deleted = false) => ({ sources, deleted });
    expect(scanRoots('a', [])).toEqual(['']);
    expect(scanRoots('a', [lib([{ sourceId: 'b', path: 'x' }])])).toEqual(['']);
    expect(scanRoots('a', [lib([{ sourceId: 'a', path: 'Comics/' }]), lib([{ sourceId: 'a', path: 'Comics/Manga' }]), lib([{ sourceId: 'a', path: 'Books' }])])).toEqual([
      'Books',
      'Comics',
    ]);
    expect(scanRoots('a', [lib([{ sourceId: 'a', path: 'Comics' }]), lib([{ sourceId: 'a', path: '' }])])).toEqual(['']);
    expect(scanRoots('a', [lib([{ sourceId: 'a', path: 'Comics' }]), lib([{ sourceId: 'a', path: '' }], true)])).toEqual(['Comics']);
  });

  it('throttles automatic rescans', () => {
    const mk = (id: string, kind: 'webdav' | 'local' = 'webdav') =>
      ({ id, name: id, config: kind === 'local' ? { kind } : { kind, url: '', username: '', password: '' }, createdAt: 0, updatedAt: 0, deleted: false }) as Source;
    const now = 10_000_000;
    const last = new Map([
      ['recent', now - 1000],
      ['old', now - 2 * 3600_000],
    ]);
    expect(dueForRescan([mk('recent'), mk('old'), mk('never'), mk('dev', 'local')], last, now).map((s) => s.id)).toEqual(['old', 'never']);
  });

  it('removing a source drops it from libraries and forgets its books, except pinned ones', async () => {
    const { s, source } = await setup();
    const lib = await s.repo.createLibrary('Mixed', [
      { sourceId: source.id, path: '' },
      { sourceId: (await s.repo.meta()).localSourceId, path: '' },
    ]);
    await scanSource(source, '', s);
    const books = await s.repo.listBooks();
    const pinned = await keepOffline(books.find((b) => b.title === 'Night Garden v01')!.id, s);
    await removeSource(source, s);
    expect((await s.repo.getLibrary(lib.id))?.sources.map((r) => r.sourceId)).toEqual([(await s.repo.meta()).localSourceId]);
    expect((await s.repo.getSource(source.id))?.deleted).toBe(true);
    expect(await s.repo.listFilesBySource(source.id)).toEqual([]);
    expect((await s.repo.listBooks()).map((b) => b.id)).toEqual([pinned!.bookId]);
  });
});
