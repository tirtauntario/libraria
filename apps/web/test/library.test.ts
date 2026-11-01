import { sha512, type Source } from '@libraria/core';
import { describe, expect, it } from 'vitest';
import type { BookRecord, OfflineFileRecord } from '../src/lib/db/schema';
import { deleteBook } from '../src/lib/library/books';
import { bookIdsInLibrary, continueReading, groupCatalog, queryBooks, seriesSiblings, withProgress } from '../src/lib/library/catalog';
import { importFiles } from '../src/lib/library/import';
import { runEviction, selectEvictions } from '../src/lib/library/offline';
import { BookUnavailableError, keepOffline, openBook } from '../src/lib/library/open';
import { scanSource, walkSource } from '../src/lib/library/scan';
import { registerSourceKind } from '../src/lib/sources';
import type { SourceDriver, SourceEntry } from '../src/lib/sources/types';
import { cbzFile, epubFile, testServices } from './helpers';

describe('import', () => {
  it('imports, extracts metadata and stores the file on the device', async () => {
    const s = await testServices();
    const file = await cbzFile('Night Garden v01.cbz', 4);
    const progress: string[] = [];
    const r = await importFiles([file, await epubFile('book.epub')], s, { onProgress: (p) => progress.push(p.phase) });
    expect(r.failed).toEqual([]);
    expect(r.added.map((b) => b.title).sort()).toEqual(['Night Garden v01', 'The Test Book']);
    expect(progress).toContain('hashing');
    expect(progress).toContain('copying');

    const comic = r.added.find((b) => b.format === 'cbz')!;
    expect(comic.sha512).toBe(await sha512(file));
    expect(comic.pageCount).toBe(4);
    expect(comic.fileSize).toBe(file.size);

    const { localSourceId } = await s.repo.meta();
    const [bf] = await s.repo.listBookFiles(comic.id);
    expect(bf).toMatchObject({ sourceId: localSourceId, size: file.size });
    expect(bf!.path.endsWith('/Night Garden v01.cbz')).toBe(true);
    const stored = await s.files.read(`local/${bf!.path}`);
    expect(stored?.size).toBe(file.size);

    const epub = r.added.find((b) => b.format === 'epub')!;
    expect(epub.authors).toEqual(['Ada Lovelace']);
  });

  it('dedupes by SHA-512, not by name', async () => {
    const s = await testServices();
    const a = await cbzFile('a.cbz', 2, 'same');
    const b = await cbzFile('b.cbz', 2, 'same'); // same bytes, other name
    const c = await cbzFile('a.cbz', 2, 'other'); // same name, other bytes
    const r1 = await importFiles([a], s);
    const r2 = await importFiles([b, c], s);
    expect(r1.added).toHaveLength(1);
    expect(r2.duplicates.map((d) => d.name)).toEqual(['b.cbz']);
    expect(r2.added).toHaveLength(1);
    expect(await s.repo.listBooks()).toHaveLength(2);
    // The duplicate was never written to storage.
    expect(await s.files.list('local/')).toHaveLength(2);
  });

  it('rejects files that are not books', async () => {
    const s = await testServices();
    const r = await importFiles([new File(['hello'], 'notes.txt')], s);
    expect(r.failed).toEqual([{ name: 'notes.txt', error: expect.stringMatching(/Not an EPUB/) }]);
    expect(await s.repo.listBooks()).toEqual([]);
  });

  it('deletes a book with its device file but keeps progress', async () => {
    const s = await testServices();
    const { added } = await importFiles([await cbzFile('x.cbz')], s);
    const book = added[0]!;
    await s.repo.saveProgress(book.sha512!, { type: 'page', page: 1, total: 3 }, book.id);
    await deleteBook(book.id, s);
    expect(await s.repo.getBook(book.id)).toBeUndefined();
    expect(await s.repo.listBookFiles(book.id)).toEqual([]);
    expect(await s.files.list('local/')).toEqual([]);
    expect(await s.repo.getProgress(book.sha512!)).toBeDefined();
  });
});

// A fake remote source: files in memory, registered as the 'webdav' kind.
const remoteFiles = new Map<string, File>();
let reads = 0;
class MemoryDriver implements SourceDriver {
  readonly isLocal = false;
  constructor(readonly source: Source) {}
  async *list(path: string): AsyncIterable<SourceEntry> {
    const prefix = path ? path + '/' : '';
    const dirs = new Set<string>();
    for (const [p, f] of remoteFiles) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) dirs.add(rest.split('/')[0]!);
      else yield { path: p, name: rest, isDir: false, size: f.size, mtime: f.lastModified, etag: `${f.size}-${f.lastModified}` };
    }
    for (const d of dirs) yield { path: prefix + d, name: d, isDir: true, size: null, mtime: null, etag: null };
  }
  async read(path: string, opts?: { onProgress?: (n: number, t: number | null) => void }): Promise<Blob> {
    reads++;
    const f = remoteFiles.get(path);
    if (!f) throw new Error('404');
    opts?.onProgress?.(f.size, f.size);
    return f;
  }
  describe() {
    return { title: 'Memory' };
  }
}
registerSourceKind({
  kind: 'webdav',
  label: 'Memory',
  description: '',
  deviceOnly: false,
  implemented: true,
  userCreatable: true,
  isSupported: () => true,
  createDriver: (source) => new MemoryDriver(source),
});

describe('scanning and opening remote books', () => {
  it('walks folders and only yields book files', async () => {
    remoteFiles.clear();
    remoteFiles.set('a/one.cbz', await cbzFile('one.cbz'));
    remoteFiles.set('a/b/two.epub', await epubFile('two.epub'));
    remoteFiles.set('a/notes.txt', new File(['x'], 'notes.txt'));
    const driver = new MemoryDriver({} as Source);
    const found: string[] = [];
    for await (const e of walkSource((p) => driver.list(p), '')) found.push(e.path);
    expect(found.sort()).toEqual(['a/b/two.epub', 'a/one.cbz']);
  });

  it('creates placeholders, detects changes and removals, hashes on open and merges duplicates', async () => {
    remoteFiles.clear();
    const s = await testServices();
    const src = await s.repo.createSource('NAS', { kind: 'webdav', url: 'https://nas', username: '', password: '' });
    const lib = await s.repo.createLibrary('Comics', [{ sourceId: src.id, path: 'comics' }]);

    const shared = await cbzFile('Shared v01.cbz', 2, 'shared');
    remoteFiles.set('comics/Shared v01.cbz', shared);
    remoteFiles.set('comics/Solo.cbz', await cbzFile('Solo.cbz', 3));
    remoteFiles.set('other/Elsewhere.epub', await epubFile('Elsewhere.epub'));

    const r1 = await scanSource(src, '', s);
    expect(r1).toMatchObject({ added: 3, updated: 0, removed: 0 });
    const books = await s.repo.listBooks();
    expect(books.every((b) => b.sha512 === null && b.metaSource === 'filename')).toBe(true);
    expect(books.map((b) => b.title).sort()).toEqual(['Elsewhere', 'Shared v01', 'Solo']);

    // Library membership follows the folder.
    const inLib = bookIdsInLibrary(lib, await s.repo.listAllBookFiles());
    expect(inLib.size).toBe(2);

    // Unchanged rescan.
    expect(await scanSource(src, '', s)).toMatchObject({ added: 0, updated: 0, unchanged: 3, removed: 0 });

    // The same comic is also imported locally: opening the remote copy merges into it.
    const { added } = await importFiles([shared], s);
    const local = added[0]!;
    const placeholder = books.find((b) => b.title === 'Shared v01')!;
    reads = 0;
    const opened = await openBook(placeholder.id, s);
    expect(reads).toBe(1); // the placeholder must be downloaded once to learn its hash
    expect(opened.book.id).toBe(local.id);
    expect(await s.repo.getBook(placeholder.id)).toBeUndefined();
    expect(await s.repo.getOffline(local.id)).toBeUndefined(); // device copy makes the download redundant
    expect((await s.repo.listBookFiles(local.id)).map((f) => f.sourceId).sort()).toEqual([src.id, (await s.repo.meta()).localSourceId].sort());

    // A changed file becomes a new placeholder; a deleted one is pruned.
    remoteFiles.set('comics/Solo.cbz', await cbzFile('Solo.cbz', 4, 'changed'));
    remoteFiles.delete('other/Elsewhere.epub');
    const r2 = await scanSource(src, '', s);
    expect(r2).toMatchObject({ added: 0, updated: 1, unchanged: 1, removed: 1 });
    expect((await s.repo.listBooks()).map((b) => b.title).sort()).toEqual(['Shared v01', 'Solo']);
  });

  it('downloads into the file store on open, then reads offline', async () => {
    remoteFiles.clear();
    const s = await testServices();
    const src = await s.repo.createSource('NAS', { kind: 'webdav', url: 'https://nas', username: '', password: '' });
    const file = await cbzFile('Remote v02.cbz', 5);
    remoteFiles.set('Remote v02.cbz', file);
    await scanSource(src, '', s);
    const [placeholder] = await s.repo.listBooks();

    reads = 0;
    const stages: string[] = [];
    const first = await openBook(placeholder!.id, s, { onStage: (st) => stages.push(st.phase) });
    expect(first.origin).toBe('download');
    expect(reads).toBe(1);
    expect(stages).toEqual(expect.arrayContaining(['locating', 'hashing', 'reading']));
    expect(first.book).toMatchObject({ sha512: await sha512(file), pageCount: 5, metaSource: 'file' });

    const offline = await s.repo.getOffline(first.book.id);
    expect(offline).toMatchObject({ size: file.size, pinned: false });
    expect(offline!.opfsName).toMatch(/^offline\/.+\.cbz$/);

    remoteFiles.clear(); // source gone: the offline copy still opens
    const second = await openBook(first.book.id, s);
    expect(second.origin).toBe('offline');
    expect(second.blob.size).toBe(file.size);
    expect(reads).toBe(1);
  });

  it('streams without saving when auto-download is off, and pins with keepOffline', async () => {
    remoteFiles.clear();
    const s = await testServices();
    await s.repo.saveDeviceSettings({ ...(await s.repo.getDeviceSettings()), autoDownloadOnOpen: false });
    const src = await s.repo.createSource('NAS', { kind: 'webdav', url: 'https://nas', username: '', password: '' });
    remoteFiles.set('x.cbz', await cbzFile('x.cbz'));
    await scanSource(src, '', s);
    const [book] = await s.repo.listBooks();
    const opened = await openBook(book!.id, s);
    expect(opened.origin).toBe('stream');
    expect(await s.repo.getOffline(opened.book.id)).toBeUndefined();

    const rec = await keepOffline(opened.book.id, s);
    expect(rec).toMatchObject({ pinned: true });
    expect((await openBook(opened.book.id, s)).origin).toBe('offline');
  });

  it('reports a missing source clearly', async () => {
    const s = await testServices();
    await expect(openBook('nope', s)).rejects.toBeInstanceOf(BookUnavailableError);
  });
});

describe('eviction', () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;
  const rec = (id: string, size: number, daysAgo: number, pinned = false): OfflineFileRecord => ({
    id,
    bookId: `b-${id}`,
    opfsName: `offline/${id}`,
    size,
    pinned,
    createdAt: 0,
    lastOpenedAt: now - daysAgo * DAY,
  });
  const files = [rec('old', 100, 40), rec('pinned-old', 100, 90, true), rec('mid', 300, 10), rec('new', 200, 1)];

  it('does nothing when both policies are off', () => {
    expect(selectEvictions(files, { now, autoRemoveDays: 0, limitBytes: 0 })).toEqual([]);
  });

  it('removes unpinned copies not opened for N days', () => {
    expect(selectEvictions(files, { now, autoRemoveDays: 30, limitBytes: 0 }).map((f) => f.id)).toEqual(['old']);
  });

  it('removes least recently opened unpinned copies until under the limit', () => {
    // total 700; limit 350 → drop old (600 left), then mid (300 left)
    expect(selectEvictions(files, { now, autoRemoveDays: 0, limitBytes: 350 }).map((f) => f.id)).toEqual(['old', 'mid']);
    // never touches pinned copies or the book being read
    expect(selectEvictions(files, { now, autoRemoveDays: 0, limitBytes: 1, keepBookIds: ['b-new'] }).map((f) => f.id)).toEqual(['old', 'mid']);
  });

  it('applies device settings and deletes the files', async () => {
    const s = await testServices();
    await s.repo.saveDeviceSettings({ ...(await s.repo.getDeviceSettings()), autoRemoveDays: 7 });
    await s.files.write('offline/a.cbz', new Blob(['a']));
    await s.repo.putOffline({ id: 'a', bookId: 'ba', opfsName: 'offline/a.cbz', size: 1, pinned: false, createdAt: 0, lastOpenedAt: Date.now() - 30 * DAY });
    await s.repo.putOffline({ id: 'b', bookId: 'bb', opfsName: 'offline/b.cbz', size: 1, pinned: false, createdAt: 0, lastOpenedAt: Date.now() });
    const removed = await runEviction(s);
    expect(removed.map((r) => r.id)).toEqual(['a']);
    expect(await s.files.read('offline/a.cbz')).toBeNull();
    expect((await s.repo.listOffline()).map((o) => o.id)).toEqual(['b']);
  });
});

describe('catalog view', () => {
  const book = (id: string, title: string, extra: Partial<BookRecord> = {}): BookRecord => ({
    id,
    sha512: id.padEnd(128, '0'),
    format: 'cbz',
    title,
    authors: [],
    series: null,
    fileSize: 1,
    cover: null,
    customGroup: null,
    metaSource: 'file',
    metaEdited: false,
    addedAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    ...extra,
  });
  const books = [
    book('a', 'Saga v02', { addedAt: 2, lastReadAt: 50 }),
    book('b', 'Saga v10', { addedAt: 3 }),
    book('c', 'Saga v01', { addedAt: 1, lastReadAt: 10 }),
    book('d', 'Dune', { format: 'epub', authors: ['Frank Herbert'], addedAt: 4, lastReadAt: 30 }),
    book('e', 'Notes', { format: 'pdf', customGroup: 'Work', addedAt: 5 }),
  ];
  const progress = new Map([
    [books[0]!.sha512!, { sha512: '', locator: { type: 'page' as const, page: 1, total: 4 }, percent: 0.3, updatedAt: 0, deviceId: '' }],
    [books[3]!.sha512!, { sha512: '', locator: { type: 'page' as const, page: 1, total: 4 }, percent: 1, updatedAt: 0, deviceId: '' }],
  ]);
  const items = withProgress(books, progress);

  it('searches title/author/series and filters by format', () => {
    expect(queryBooks(items, { search: 'herbert', sort: 'name' }).map((b) => b.id)).toEqual(['d']);
    expect(queryBooks(items, { search: 'saga v1', sort: 'name' }).map((b) => b.id)).toEqual(['b']);
    expect(queryBooks(items, { format: 'comics', sort: 'name' }).map((b) => b.id)).toEqual(['c', 'a', 'b']);
    expect(queryBooks(items, { format: 'books', sort: 'added' }).map((b) => b.id)).toEqual(['e', 'd']);
  });

  it('sorts by last read with never-read books last', () => {
    expect(queryBooks(items, { sort: 'lastRead' }).map((b) => b.id)).toEqual(['a', 'd', 'c', 'e', 'b']);
  });

  it('groups series in reading order and honours custom groups and renames', () => {
    const groups = groupCatalog(queryBooks(items, { sort: 'name' }), 'name', { Saga: 'The Saga' });
    const saga = groups.find((g) => g.key === 'Saga')!;
    expect(saga.name).toBe('The Saga');
    expect(saga.isSeries).toBe(true);
    expect(saga.items.map((b) => b.title)).toEqual(['Saga v01', 'Saga v02', 'Saga v10']);
    expect(groups.find((g) => g.key === 'Work')?.items.map((b) => b.id)).toEqual(['e']);
    expect(groups.map((g) => g.name)).toEqual(['Dune', 'The Saga', 'Work']);
  });

  it('finds previous/next volume in a series', () => {
    const { prev, next } = seriesSiblings(books[0]!, books);
    expect(prev?.id).toBe('c');
    expect(next?.id).toBe('b');
    expect(seriesSiblings(books[3]!, books)).toEqual({ prev: null, next: null });
  });

  it('lists unfinished books for "continue reading"', () => {
    expect(continueReading(items).map((b) => b.id)).toEqual(['a', 'c']);
  });
});
