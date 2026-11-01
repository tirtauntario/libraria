import { mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, binary, makeCbz, makeEpub, p, sha512hex, startServer, upload, type TestServer } from './helpers';

let t: TestServer;
let owner: string;
let root: string;
let outside: string;

beforeEach(async () => {
  // Build the tree before starting so the root exists when config is resolved.
  const base = join(process.env.TMPDIR ?? '/tmp', `libraria-src-${Math.random().toString(36).slice(2)}`);
  root = join(base, 'library');
  outside = join(base, 'secret');
  await mkdir(join(root, 'comics', 'series'), { recursive: true });
  await mkdir(outside, { recursive: true });
  t = await startServer({ sourceRoots: [root] });
  owner = (await t.setup()).token;
});
afterEach(async () => {
  await t.destroy();
  await rm(join(root, '..'), { recursive: true, force: true });
});

const createSource = (path: string) => t.api.post(p('/sources')).set(bearer(owner)).send({ kind: 'disk', path });

describe('disk sources', () => {
  it('only accepts paths inside a configured root', async () => {
    const roots = await t.api.get(p('/sources/roots')).set(bearer(owner));
    expect(roots.body.roots).toHaveLength(1);

    expect((await createSource(outside)).status).toBe(400);
    expect((await createSource(join(root, '..', 'secret'))).status).toBe(400);
    expect((await createSource('/etc')).status).toBe(400);
    expect((await createSource(join(root, 'missing'))).status).toBe(400);
    await writeFile(join(root, 'file.txt'), 'x');
    expect((await createSource(join(root, 'file.txt'))).status).toBe(400);

    // A symlink inside the root that points outside resolves outside: refused.
    await symlink(outside, join(root, 'escape'));
    const esc = await createSource(join(root, 'escape'));
    expect(esc.status).toBe(400);
    expect(esc.body.message).toMatch(/outside/);

    const ok = await createSource(join(root, 'comics'));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: 'disk', lastScanAt: null, bookCount: 0 });
    expect((await createSource(join(root, 'comics'))).status).toBe(409);
    expect((await createSource(root)).status).toBe(201);
  });

  it('refuses sources when no roots are configured', async () => {
    await t.destroy();
    t = await startServer();
    owner = (await t.setup()).token;
    const res = await createSource(root);
    expect(res.status).toBe(400);
    expect((await t.api.get(p('/sources/roots')).set(bearer(owner))).body.roots).toEqual([]);
  });

  it('scans, dedupes, skips symlinks and tracks removals', async () => {
    const cbz = await makeCbz(4, {
      comicInfo: '<ComicInfo><Series>Hero</Series><Number>3</Number><Writer>W. Riter</Writer></ComicInfo>',
    });
    const epub = await makeEpub('Disk Book');
    await writeFile(join(root, 'comics', 'series', 'hero-03.cbz'), cbz);
    await writeFile(join(root, 'comics', 'copy-of-hero.cbz'), cbz); // same bytes, same book
    await writeFile(join(root, 'disk-book.epub'), epub);
    await writeFile(join(root, 'notes.txt'), 'not a book');
    await writeFile(join(root, '.hidden.cbz'), cbz);
    await writeFile(join(root, 'broken.pdf'), 'not really a pdf');
    await writeFile(join(outside, 'private.epub'), await makeEpub('Private'));
    await symlink(join(outside, 'private.epub'), join(root, 'linked.epub'));
    await symlink(outside, join(root, 'linked-dir'));

    const src = (await createSource(root)).body;
    const scan = await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner));
    expect(scan.status).toBe(200);
    // broken.pdf has the extension but no PDF magic bytes.
    expect(scan.body).toEqual({ added: 3, removed: 0, unchanged: 0, failed: 1 });

    const books = (await t.api.get(p('/books')).set(bearer(owner))).body.items as { title: string; sha512: string; id: string; hasCover: boolean; authors: string[]; pageCount: number | null }[];
    expect(books.map((b) => b.title).sort()).toEqual(['Disk Book', 'Hero #3']);
    expect(books.some((b) => b.title === 'Private')).toBe(false);
    const hero = books.find((b) => b.title === 'Hero #3')!;
    expect(hero).toMatchObject({ sha512: sha512hex(cbz), hasCover: true, authors: ['W. Riter'], pageCount: 4 });

    const file = await t.api.get(p(`/books/${hero.id}/file`)).set(bearer(owner)).buffer(true).parse(binary);
    expect(Buffer.compare(file.body as Buffer, cbz)).toBe(0);
    expect(file.headers['content-type']).toBe('application/vnd.comicbook+zip');

    const dto = (await t.api.get(p(`/sources/${src.id}`)).set(bearer(owner))).body;
    expect(dto.bookCount).toBe(2);
    expect(dto.lastScanAt).toBeTypeOf('number');

    // Unchanged rescan.
    const again = await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner));
    expect(again.body).toEqual({ added: 0, removed: 0, unchanged: 3, failed: 1 });

    // Remove one copy: the book stays (other copy); remove both: it disappears.
    await rm(join(root, 'comics', 'copy-of-hero.cbz'));
    expect((await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner))).body).toEqual({ added: 0, removed: 1, unchanged: 2, failed: 1 });
    expect((await t.api.get(p(`/books/${hero.id}`)).set(bearer(owner))).status).toBe(200);
    await rm(join(root, 'comics', 'series', 'hero-03.cbz'));
    expect((await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner))).body.removed).toBe(1);
    expect((await t.api.get(p(`/books/${hero.id}`)).set(bearer(owner))).status).toBe(404);

    // Coming back restores the same book row (metadata edits survive).
    await writeFile(join(root, 'hero.cbz'), cbz);
    expect((await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner))).body.added).toBe(1);
    expect((await t.api.get(p(`/books/${hero.id}`)).set(bearer(owner))).status).toBe(200);

    // A changed file is re-hashed.
    const epub2 = await makeEpub('Disk Book 2');
    await writeFile(join(root, 'disk-book.epub'), epub2);
    await utimes(join(root, 'disk-book.epub'), new Date(), new Date(Date.now() + 5000));
    const changed = await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner));
    expect(changed.body).toMatchObject({ added: 1, failed: 1 });
    const titles = ((await t.api.get(p('/books')).set(bearer(owner))).body.items as { title: string }[]).map((b) => b.title);
    expect(titles).toContain('Disk Book 2');
    expect(titles).not.toContain('Disk Book');
  });

  it('dedupes against uploaded books and keeps deleted books hidden', async () => {
    const cbz = await makeCbz(2);
    const up = await upload(t, owner, cbz);
    const uploadedId = (await t.api.get(p(`/submissions/${up.id}`)).set(bearer(owner))).body.bookId;
    await writeFile(join(root, 'same.cbz'), cbz);
    const src = (await createSource(root)).body;
    await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner));
    const list = (await t.api.get(p('/books')).set(bearer(owner))).body.items;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(uploadedId);

    // Curator removes it: the uploaded copy is deleted, the disk copy is left
    // alone, and rescans do not bring it back.
    expect((await t.api.delete(p(`/books/${uploadedId}`)).set(bearer(owner))).status).toBe(204);
    await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner));
    await writeFile(join(root, 'same-again.cbz'), cbz);
    await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner));
    expect((await t.api.get(p('/books')).set(bearer(owner))).body.items).toHaveLength(0);

    // Deleting the source drops its books.
    await writeFile(join(root, 'other.epub'), await makeEpub('Other'));
    await t.api.post(p(`/sources/${src.id}/scan`)).set(bearer(owner));
    expect((await t.api.get(p('/books')).set(bearer(owner))).body.items).toHaveLength(1);
    expect((await t.api.delete(p(`/sources/${src.id}`)).set(bearer(owner))).status).toBe(204);
    expect((await t.api.get(p('/books')).set(bearer(owner))).body.items).toHaveLength(0);
    expect(await t.ctx.db.selectFrom('books').selectAll().execute()).toHaveLength(0);
  });
});
