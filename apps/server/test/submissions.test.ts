import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, binary, makeCbz, makeEpub, makePdf, p, PNG, sha512hex, startServer, upload, type TestServer } from './helpers';

let t: TestServer;
let owner: string;
let member: { token: string; userId: string };
beforeEach(async () => {
  t = await startServer();
  owner = (await t.setup()).token;
  member = await t.user('mem');
});
afterEach(async () => {
  await t.destroy();
});

const patchChunk = (token: string, id: string, offset: number, data: Uint8Array) =>
  t.api
    .patch(p(`/submissions/${id}/content`))
    .set(bearer(token))
    .set('Upload-Offset', String(offset))
    .set('Content-Type', 'application/offset+octet-stream')
    .send(Buffer.from(data));

describe('submissions', () => {
  it('uploads a member EPUB in chunks, then a curator approves it', async () => {
    const data = await makeEpub('Uploaded Book');
    const sha = sha512hex(data);

    const lookup0 = await t.api.get(p('/books/lookup')).query({ sha512: sha }).set(bearer(member.token));
    expect(lookup0.body).toEqual({ bookId: null, submissionId: null });

    const create = await t.api.post(p('/submissions')).set(bearer(member.token)).send({
      sha512: sha,
      format: 'epub',
      fileSize: data.length,
      filename: '../../etc/Uploaded Book.epub',
      title: '',
      authors: ['  Someone  '],
    });
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({ status: 'uploading', uploadOffset: 0, filename: 'Uploaded Book.epub', username: 'mem' });
    const id = create.body.id as string;

    const lookup1 = await t.api.get(p('/books/lookup')).query({ sha512: sha }).set(bearer(member.token));
    expect(lookup1.body).toEqual({ bookId: null, submissionId: id });

    const head0 = await t.api.head(p(`/submissions/${id}/content`)).set(bearer(member.token));
    expect(head0.headers['upload-offset']).toBe('0');

    const chunk = 300;
    let offset = 0;
    while (offset < data.length) {
      const res = await patchChunk(member.token, id, offset, data.subarray(offset, offset + chunk));
      expect(res.status).toBe(204);
      offset = Math.min(data.length, offset + chunk);
      expect(res.headers['upload-offset']).toBe(String(offset));
      if (offset < data.length) {
        const head = await t.api.head(p(`/submissions/${id}/content`)).set(bearer(member.token));
        expect(head.headers['upload-offset']).toBe(String(offset));
      }
    }

    const done = await t.api.get(p(`/submissions/${id}`)).set(bearer(member.token));
    expect(done.body).toMatchObject({ status: 'pending', uploadOffset: data.length, title: 'Uploaded Book', authors: ['Someone'] });

    // Members do not see pending books; others cannot see the submission.
    expect((await t.api.get(p('/books')).set(bearer(member.token))).body.items).toHaveLength(0);
    const other = await t.user('other');
    expect((await t.api.get(p(`/submissions/${id}`)).set(bearer(other.token))).status).toBe(404);

    const curator = await t.user('cura', 'curator');
    const queue = await t.api.get(p('/submissions')).query({ status: 'pending' }).set(bearer(curator.token));
    expect(queue.body.items.map((s: { id: string }) => s.id)).toEqual([id]);
    const preview = await t.api.get(p(`/submissions/${id}/file`)).set(bearer(curator.token)).buffer(true).parse(binary);
    expect(preview.status).toBe(200);
    expect(Buffer.compare(preview.body as Buffer, data)).toBe(0);

    const review = await t.api.post(p(`/submissions/${id}/review`)).set(bearer(curator.token)).send({ action: 'approve', note: 'Thanks' });
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ status: 'approved', reviewNote: 'Thanks', reviewedBy: curator.userId });
    const bookId = review.body.bookId as string;

    const book = await t.api.get(p(`/books/${bookId}`)).set(bearer(member.token));
    expect(book.body).toMatchObject({ sha512: sha, format: 'epub', title: 'Uploaded Book', series: 'Engines', seriesIndex: 2, language: 'en', hasCover: true });
    expect(existsSync(join(t.ctx.paths.books, sha.slice(0, 2), `${sha}.epub`))).toBe(true);
    expect(readdirSync(t.ctx.paths.uploads)).toEqual([]);

    const mine = await t.api.get(p('/submissions')).query({ mine: 1 }).set(bearer(member.token));
    expect(mine.body.items[0]).toMatchObject({ id, status: 'approved', bookId });
    const lookup2 = await t.api.get(p('/books/lookup')).query({ sha512: sha }).set(bearer(member.token));
    expect(lookup2.body).toEqual({ bookId, submissionId: null });

    // Cover: the submitter may replace it, other members may not; only images accepted.
    expect((await t.api.put(p(`/books/${bookId}/cover`)).set(bearer(other.token)).send(Buffer.from(PNG))).status).toBe(403);
    const notImage = await t.api.put(p(`/books/${bookId}/cover`)).set(bearer(member.token)).set('Content-Type', 'image/png').send(Buffer.from('hello'));
    expect(notImage.status).toBe(415);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const put = await t.api.put(p(`/books/${bookId}/cover`)).set(bearer(member.token)).set('Content-Type', 'image/jpeg').send(jpeg);
    expect(put.status).toBe(200);
    const cover = await t.api.get(p(`/books/${bookId}/cover`)).set(bearer(member.token));
    expect(cover.headers['content-type']).toBe('image/jpeg');
    const huge = Buffer.alloc(5 * 1024 * 1024 + 10, 0);
    PNG.forEach((b, i) => (huge[i] = b));
    expect((await t.api.put(p(`/books/${bookId}/cover`)).set(bearer(owner)).set('Content-Type', 'image/png').send(huge)).status).toBe(413);
  });

  it('serves book files with Range support and a safe Content-Disposition', async () => {
    const data = makePdf(10_000);
    const { id, last } = await upload(t, owner, data, { format: 'pdf', filename: 'x.pdf', title: 'Café "Book"/../x' });
    expect(last.status).toBe(204);
    const sub = await t.api.get(p(`/submissions/${id}`)).set(bearer(owner));
    expect(sub.body.status).toBe('approved'); // owner uploads skip review
    const bookId = sub.body.bookId;

    const full = await t.api.get(p(`/books/${bookId}/file`)).set(bearer(member.token)).buffer(true).parse(binary);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('application/pdf');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-disposition']).toMatch(/^attachment; filename="[\x20-\x7e]+\.pdf"; filename\*=UTF-8''/);
    expect(full.headers['content-disposition']).not.toMatch(/\.\.\/|"Book"/);
    expect(Buffer.compare(full.body as Buffer, data)).toBe(0);

    const part = await t.api.get(p(`/books/${bookId}/file`)).set(bearer(member.token)).set('Range', 'bytes=100-199').buffer(true).parse(binary);
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${data.length}`);
    expect(Buffer.compare(part.body as Buffer, data.subarray(100, 200))).toBe(0);

    const tail = await t.api.get(p(`/books/${bookId}/file`)).set(bearer(member.token)).set('Range', 'bytes=9000-').buffer(true).parse(binary);
    expect(tail.status).toBe(206);
    expect((tail.body as Buffer).length).toBe(1000);

    const bad = await t.api.get(p(`/books/${bookId}/file`)).set(bearer(member.token)).set('Range', 'bytes=20000-30000');
    expect(bad.status).toBe(416);
  });

  it('rejects wrong offsets with 409 and the current offset', async () => {
    const data = await makeCbz(3);
    const create = await t.api.post(p('/submissions')).set(bearer(member.token)).send({
      sha512: sha512hex(data), format: 'cbz', fileSize: data.length, filename: 'c.cbz', title: 'C', authors: [],
    });
    const id = create.body.id;
    expect((await patchChunk(member.token, id, 0, data.subarray(0, 100))).status).toBe(204);
    const wrong = await patchChunk(member.token, id, 50, data.subarray(50, 150));
    expect(wrong.status).toBe(409);
    expect(wrong.headers['upload-offset']).toBe('100');
    expect(wrong.body).toMatchObject({ error: 'conflict', offset: 100 });

    const wrongType = await t.api
      .patch(p(`/submissions/${id}/content`))
      .set(bearer(member.token))
      .set('Upload-Offset', '100')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(data.subarray(100)));
    expect(wrongType.status).toBe(415);

    const tooMuch = await patchChunk(member.token, id, 100, Buffer.concat([data.subarray(100), Buffer.alloc(10)]));
    expect(tooMuch.status).toBe(413);
    expect((await t.api.head(p(`/submissions/${id}/content`)).set(bearer(member.token))).headers['upload-offset']).toBe('100');

    // Only the uploader can push bytes.
    expect((await patchChunk(owner, id, 100, data.subarray(100))).status).toBe(404);
    expect((await patchChunk(member.token, id, 100, data.subarray(100))).status).toBe(204);
    expect((await patchChunk(member.token, id, data.length, Buffer.alloc(1))).status).toBe(409);
  });

  it('detects hash mismatch and wrong format, restarting the upload', async () => {
    const data = await makeCbz(2);
    const wrongHash = await upload(t, member.token, data, { sha512: sha512hex(Buffer.from('other')) });
    expect(wrongHash.last.status).toBe(422);
    expect(wrongHash.last.body.error).toBe('hash_mismatch');
    const after = await t.api.get(p(`/submissions/${wrongHash.id}`)).set(bearer(member.token));
    expect(after.body).toMatchObject({ status: 'uploading', uploadOffset: 0 });
    expect(existsSync(join(t.ctx.paths.uploads, `${wrongHash.id}.part`))).toBe(false);

    // A CBZ declared as EPUB, and a PDF declared as CBZ.
    const asEpub = await upload(t, member.token, await makeCbz(1), { format: 'epub', filename: 'x.epub' });
    expect(asEpub.last.status).toBe(422);
    expect(asEpub.last.body.error).toBe('unsupported_format');
    const asCbz = await upload(t, member.token, makePdf(), { format: 'cbz' });
    expect(asCbz.last.body.error).toBe('unsupported_format');

    // Cancelling removes it.
    expect((await t.api.delete(p(`/submissions/${asCbz.id}`)).set(bearer(member.token))).status).toBe(204);
    expect((await t.api.get(p(`/submissions/${asCbz.id}`)).set(bearer(member.token))).status).toBe(404);
  });

  it('reports duplicates of books and of open submissions', async () => {
    const data = await makeCbz(2);
    const first = await upload(t, member.token, data);
    expect(first.last.status).toBe(204);
    const dupPending = await upload(t, owner, data);
    expect(dupPending.create.status).toBe(409);
    expect(dupPending.create.body).toMatchObject({ error: 'duplicate', bookId: null, submissionId: first.id });

    const review = await t.api.post(p(`/submissions/${first.id}/review`)).set(bearer(owner)).send({ action: 'approve' });
    const dupBook = await upload(t, member.token, data);
    expect(dupBook.create.status).toBe(409);
    expect(dupBook.create.body).toMatchObject({ error: 'duplicate', bookId: review.body.bookId, submissionId: null });
  });

  it('enforces allowed formats, size, quota and pending limits', async () => {
    const s = await t.api.patch(p('/settings')).set(bearer(owner)).send({ allowedFormats: ['cbz', 'epub'], maxUploadBytes: 50_000 });
    expect(s.body.allowedFormats).toEqual(['cbz', 'epub']);
    const pdf = await upload(t, member.token, makePdf(), { format: 'pdf' });
    expect(pdf.create.status).toBe(415);
    expect(pdf.create.body.error).toBe('unsupported_format');
    const big = await t.api.post(p('/submissions')).set(bearer(owner)).send({
      sha512: 'a'.repeat(128), format: 'cbz', fileSize: 50_001, filename: 'big.cbz', title: 'Big', authors: [],
    });
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('too_large');

    // Quota counts pending + uploading + approved bytes.
    const a = await makeCbz(2);
    const b = await makeCbz(2);
    await t.api.patch(p('/settings')).set(bearer(owner)).send({ memberQuotaBytes: a.length + b.length - 1, maxPendingPerMember: 10 });
    const ua = await upload(t, member.token, a);
    expect(ua.last.status).toBe(204);
    await t.api.post(p(`/submissions/${ua.id}/review`)).set(bearer(owner)).send({ action: 'approve' });
    const ub = await upload(t, member.token, b);
    expect(ub.create.status).toBe(403);
    expect(ub.create.body.error).toBe('quota_exceeded');
    // Owner uploads skip the quota.
    expect((await upload(t, owner, b)).last.status).toBe(204);

    // Pending limit: rejected submissions free their slot.
    await t.api.patch(p('/settings')).set(bearer(owner)).send({ memberQuotaBytes: 10_000_000, maxPendingPerMember: 2 });
    const p1 = await upload(t, member.token, await makeCbz(1));
    const p2 = await upload(t, member.token, await makeCbz(1));
    expect(p1.last.status).toBe(204);
    expect(p2.create.status).toBe(201);
    const p3 = await upload(t, member.token, await makeCbz(1));
    expect(p3.create.status).toBe(403);
    expect(p3.create.body.error).toBe('quota_exceeded');
    const rej = await t.api.post(p(`/submissions/${p1.id}/review`)).set(bearer(owner)).send({ action: 'reject', note: 'No rights' });
    expect(rej.body).toMatchObject({ status: 'rejected', reviewNote: 'No rights' });
    expect(existsSync(join(t.ctx.paths.uploads, `${p1.id}.part`))).toBe(false);
    expect((await upload(t, member.token, await makeCbz(1))).create.status).toBe(201);
    // Cannot review twice.
    expect((await t.api.post(p(`/submissions/${p1.id}/review`)).set(bearer(owner)).send({ action: 'approve' })).status).toBe(409);
  });

  it('cleans up stale uploads after 7 days', async () => {
    const data = await makeCbz(2);
    const create = await t.api.post(p('/submissions')).set(bearer(member.token)).send({
      sha512: sha512hex(data), format: 'cbz', fileSize: data.length, filename: 's.cbz', title: 'S', authors: [],
    });
    await patchChunk(member.token, create.body.id, 0, data.subarray(0, 50));
    const { cleanStaleUploads } = await import('../src/services/submissions');
    expect(await cleanStaleUploads(t.ctx)).toBe(0);
    t.clock.advance(7 * 24 * 3600 * 1000 + 1);
    expect(await cleanStaleUploads(t.ctx)).toBe(1);
    expect((await t.api.get(p(`/submissions/${create.body.id}`)).set(bearer(member.token))).status).toBe(404);
    expect(readdirSync(t.ctx.paths.uploads)).toEqual([]);
  });

  it('deletes books and their stored files', async () => {
    const { id } = await upload(t, owner, await makeCbz(2));
    const bookId = (await t.api.get(p(`/submissions/${id}`)).set(bearer(owner))).body.bookId;
    const list = await t.api.get(p('/books')).set(bearer(member.token));
    expect(list.body.items).toHaveLength(1);
    expect((await t.api.delete(p(`/books/${bookId}`)).set(bearer(owner))).status).toBe(204);
    expect((await t.api.get(p(`/books/${bookId}`)).set(bearer(owner))).status).toBe(404);
    expect(readdirSync(t.ctx.paths.covers)).toEqual([]);
  });
});

describe('book listing', () => {
  it('paginates with a cursor and searches title, authors and series', async () => {
    const titles = ['Alpha Story', 'Beta Tale', 'Gamma 100% Book', 'Delta Story', 'Epsilon'];
    for (const title of titles) {
      const r = await upload(t, owner, await makeCbz(1), { title });
      expect(r.last.status).toBe(204);
    }
    const page1 = await t.api.get(p('/books')).query({ limit: 2 }).set(bearer(member.token));
    expect(page1.body.items.map((b: { title: string }) => b.title)).toEqual(['Epsilon', 'Delta Story']);
    const page2 = await t.api.get(p('/books')).query({ limit: 2, cursor: page1.body.nextCursor }).set(bearer(member.token));
    expect(page2.body.items.map((b: { title: string }) => b.title)).toEqual(['Gamma 100% Book', 'Beta Tale']);
    const page3 = await t.api.get(p('/books')).query({ limit: 2, cursor: page2.body.nextCursor }).set(bearer(member.token));
    expect(page3.body.items.map((b: { title: string }) => b.title)).toEqual(['Alpha Story']);
    expect(page3.body.nextCursor).toBeNull();

    const story = await t.api.get(p('/books')).query({ q: 'STORY' }).set(bearer(member.token));
    expect(story.body.items).toHaveLength(2);
    const pct = await t.api.get(p('/books')).query({ q: '100%' }).set(bearer(member.token));
    expect(pct.body.items.map((b: { title: string }) => b.title)).toEqual(['Gamma 100% Book']);
    const underscore = await t.api.get(p('/books')).query({ q: '_' }).set(bearer(member.token));
    expect(underscore.body.items).toHaveLength(0);

    const id = page1.body.items[0].id;
    await t.api.patch(p(`/books/${id}`)).set(bearer(owner)).send({ authors: ['Zed Writer'], series: 'Saga' });
    expect((await t.api.get(p('/books')).query({ q: 'zed' }).set(bearer(member.token))).body.items[0].id).toBe(id);
    expect((await t.api.get(p('/books')).query({ q: 'saga' }).set(bearer(member.token))).body.items[0].id).toBe(id);
  });
});
