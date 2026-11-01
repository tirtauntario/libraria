import type { ServerInfo } from '@libraria/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importFiles } from '../src/lib/library/import';
import { attachServer, setServerFetch, type LibrariaSource } from '../src/lib/server/servers';
import { registerLibrariaSource, resumableDownload } from '../src/lib/server/source';
import { cancelUpload, enqueueUpload, listUploads, processUploads } from '../src/lib/server/uploads';
import { makeServices, type Services } from '../src/lib/services';
import { FakeServer } from './fake-server';
import { cbzFile, testServices } from './helpers';

registerLibrariaSource();

const INFO: ServerInfo = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Fake Library',
  description: '',
  apiVersion: 1,
  serverVersion: 'test',
  setupRequired: false,
  visibility: 'private',
  anonymousAccess: 'none',
  registration: 'approval',
  membersCanSubmit: true,
  maxUploadBytes: 1e9,
  allowedFormats: ['cbz', 'cbr', 'epub', 'pdf'],
  capabilities: [],
};

let fake: FakeServer;
let s: Services;
let source: LibrariaSource;

beforeEach(async () => {
  fake = new FakeServer();
  setServerFetch(fake.fetch, () => true);
  s = await testServices();
  source = await attachServer(s.repo, fake.url, INFO, {
    user: { id: 'me', username: 'me', role: 'member', status: 'active', createdAt: 1 },
    token: 'token-abcdefghijklmnop',
  });
});

afterEach(() => setServerFetch(undefined, () => true));

async function localBook(pages = 30, seed = 'x') {
  const file = await cbzFile(`book-${seed}.cbz`, pages, seed);
  const { added } = await importFiles([file], s);
  return { book: added[0]!, file };
}

const patches = () => fake.requests.filter((r) => r.startsWith('PATCH'));

describe('upload jobs', () => {
  it('resume after a dropped connection, from the offset the server confirmed', async () => {
    const { book, file } = await localBook();
    await enqueueUpload(s, source, book);
    let n = 0;
    fake.intercept = (method) => {
      if (method === 'PATCH' && ++n === 2) throw new TypeError('Failed to fetch');
    };
    await processUploads(s, { chunkBytes: 400 });
    let [job] = await listUploads(s);
    expect(job).toMatchObject({ status: 'uploading', offset: 400 });
    expect(job!.error).toMatch(/Could not reach/);

    fake.intercept = null;
    await processUploads(s, { chunkBytes: 400 });
    [job] = await listUploads(s);
    expect(job).toMatchObject({ status: 'pending', offset: file.size, error: null });
    const sub = fake.submissions.get(job!.submissionId!)!;
    expect(sub.status).toBe('pending');
    // HEAD told the client where to go on.
    expect(fake.requests.filter((r) => r.startsWith('HEAD')).length).toBe(2);
  });

  it('after a reload the persisted job continues from the server offset, not the local one', async () => {
    const { book, file } = await localBook();
    await enqueueUpload(s, source, book);
    fake.intercept = (method) => {
      if (method === 'PATCH' && patches().length === 3) throw new TypeError('Failed to fetch');
    };
    await processUploads(s, { chunkBytes: 300 });
    const [before] = await listUploads(s);
    expect(before!.offset).toBe(600);
    // The server lost the last chunk (e.g. crash before fsync).
    fake.submissions.get(before!.submissionId!)!.offset = 300;

    fake.intercept = null;
    const reloaded = makeServices(s.db, s.files, { hash: s.hash, analyze: s.analyze });
    await processUploads(reloaded, { chunkBytes: 300 });
    const [after] = await listUploads(reloaded);
    expect(after).toMatchObject({ status: 'pending', offset: file.size });
    expect(fake.requests).toContain('HEAD /submissions/' + after!.submissionId + '/content');
  });

  it('an Upload-Offset conflict resyncs to the server offset', async () => {
    const { book, file } = await localBook();
    const bytes = new Uint8Array(await file.arrayBuffer());
    await enqueueUpload(s, source, book);
    let first = true;
    fake.intercept = (method, path) => {
      if (method === 'PATCH' && first) {
        first = false;
        // Another tab already sent the first 500 bytes.
        const sub = fake.submissions.get(path.split('/')[2]!)!;
        sub.bytes.set(bytes.subarray(0, 500));
        sub.offset = 500;
      }
    };
    await processUploads(s, { chunkBytes: 400 });
    const [job] = await listUploads(s);
    expect(job!.status).toBe('pending');
    expect(fake.submissions.get(job!.submissionId!)!.bytes).toEqual(bytes);
  });

  it('a book the server has is linked without uploading', async () => {
    const { book } = await localBook(3, 'known');
    fake.books.set('srv-1', { id: 'srv-1', sha512: book.sha512!, hasCover: true });
    await enqueueUpload(s, source, book);
    await processUploads(s);
    const [job] = await listUploads(s);
    expect(job).toMatchObject({ status: 'exists', serverBookId: 'srv-1' });
    expect(fake.requests).not.toContain('POST /submissions');
    expect(patches()).toEqual([]);
  });

  it('waits while offline and goes out when back online', async () => {
    const { book } = await localBook(3, 'offline');
    await enqueueUpload(s, source, book);
    fake.online = false;
    setServerFetch(fake.fetch, () => false);
    await processUploads(s);
    let [job] = await listUploads(s);
    expect(job!.status).toBe('queued');
    expect(job!.error).toMatch(/offline/);
    expect(fake.requests).toEqual([]);

    fake.online = true;
    setServerFetch(fake.fetch, () => true);
    await processUploads(s);
    [job] = await listUploads(s);
    expect(job!.status).toBe('pending');
  });

  it('owner uploads are approved at once and the cover follows', async () => {
    fake.role = 'owner';
    const { book } = await localBook(3, 'owner');
    await s.repo.updateBook(book.id, { cover: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }) });
    await enqueueUpload(s, source, (await s.repo.getBook(book.id))!);
    await processUploads(s);
    const [job] = await listUploads(s);
    expect(job).toMatchObject({ status: 'approved', coverDone: true });
    expect(fake.covers.get(job!.serverBookId!)).toBeInstanceOf(Blob);
  });

  it('pending jobs pick up the review result', async () => {
    const { book } = await localBook(3, 'review');
    await enqueueUpload(s, source, book);
    await processUploads(s);
    let [job] = await listUploads(s);
    expect(job!.status).toBe('pending');
    fake.approve(job!.submissionId!);
    await processUploads(s);
    [job] = await listUploads(s);
    expect(job!.status).toBe('approved');
  });

  it('cancel deletes the submission on the server', async () => {
    const { book } = await localBook(3, 'cancel');
    await enqueueUpload(s, source, book);
    await processUploads(s);
    const [job] = await listUploads(s);
    await cancelUpload(s, job!.id);
    expect(await listUploads(s)).toEqual([]);
    expect(fake.submissions.size).toBe(0);
  });

  it('a hash mismatch fails the job', async () => {
    const { book } = await localBook(3, 'mismatch');
    await s.repo.updateBook(book.id, { sha512: 'a'.repeat(128) });
    await enqueueUpload(s, source, (await s.repo.getBook(book.id))!);
    await processUploads(s);
    const [job] = await listUploads(s);
    expect(job).toMatchObject({ status: 'failed', error: expect.stringMatching(/SHA-512/) });
  });
});

describe('resumable download', () => {
  const data = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);

  function failingBody(bytes: Uint8Array, failAfter: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(ctrl) {
        if (sent >= failAfter) {
          ctrl.error(new TypeError('network changed'));
          return;
        }
        const end = Math.min(failAfter, sent + 700, bytes.length);
        ctrl.enqueue(bytes.slice(sent, end));
        sent = end;
        if (sent >= bytes.length) ctrl.close();
      },
    });
  }

  it('continues with a Range request where the connection dropped', async () => {
    const froms: number[] = [];
    const progress: number[] = [];
    const { stream, size } = await resumableDownload(
      async (from) => {
        froms.push(from);
        if (from === 0) return new Response(failingBody(data, 2100), { status: 200, headers: { 'Content-Length': String(data.length) } });
        return new Response(data.slice(from), { status: 206 });
      },
      { retryDelayMs: 1, onProgress: (n) => progress.push(n) },
    );
    expect(size).toBe(data.length);
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(out).toEqual(data);
    expect(froms).toEqual([0, 2100]);
    expect(progress.at(-1)).toBe(data.length);
  });

  it('skips what it has when the server ignores Range', async () => {
    let calls = 0;
    const { stream } = await resumableDownload(
      async () => {
        calls++;
        return calls === 1
          ? new Response(failingBody(data, 1500), { status: 200, headers: { 'Content-Length': String(data.length) } })
          : new Response(data, { status: 200 });
      },
      { retryDelayMs: 1 },
    );
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(data);
  });

  it('gives up after repeated failures', async () => {
    const { stream } = await resumableDownload(
      async (from) => new Response(failingBody(data.slice(from), 0), { status: from ? 206 : 200, headers: { 'Content-Length': String(data.length) } }),
      { retryDelayMs: 1, attempts: 2 },
    );
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow();
  });
});
