/**
 * A small in-memory stand-in for the Libraria server API, as a fetch
 * function, for fault injection in unit tests (dropped connections,
 * concurrent writes). Behaviour follows apps/server for the routes it has.
 */
import { sha512, uuidv7, type SyncKeysDto, type SyncPushItem, type SyncRecordDto } from '@libraria/core';
import type { FetchLike } from '../src/lib/server/api';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export interface FakeSubmission {
  id: string;
  sha512: string;
  fileSize: number;
  title: string;
  offset: number;
  bytes: Uint8Array;
  status: 'uploading' | 'pending' | 'approved' | 'rejected';
  bookId: string | null;
  userId: string;
}

export class FakeServer {
  readonly url = 'https://fake.example';
  role: 'owner' | 'member' = 'member';
  online = true;
  keys: SyncKeysDto | null = null;
  records: SyncRecordDto[] = [];
  rev = 0;
  submissions = new Map<string, FakeSubmission>();
  books = new Map<string, { id: string; sha512: string; hasCover: boolean }>();
  covers = new Map<string, Blob>();
  requests: string[] = [];
  /** Server-side cap on the sync page size. */
  pageLimit = Infinity;
  /** Called before a request is handled; may throw (network error) or return a Response. */
  intercept: ((method: string, path: string, init: RequestInit) => Response | void | Promise<Response | void>) | null = null;
  /** Called at the start of POST /sync/records (simulate another device writing first). */
  beforePush: (() => void) | null = null;

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1/, '');
    this.requests.push(`${method} ${path}`);
    if (!this.online) throw new TypeError('Failed to fetch');
    const intercepted = await this.intercept?.(method, path, init);
    if (intercepted) return intercepted;
    return this.handle(method, path, url.searchParams, init);
  };

  /** Write a record as another device would (no client involved). */
  putRecord(item: Omit<SyncPushItem, 'baseRev'>): SyncRecordDto {
    const existing = this.records.find((r) => r.kind === item.kind && r.ref === item.ref);
    this.rev++;
    if (existing) {
      Object.assign(existing, { rev: this.rev, deleted: item.deleted, ciphertext: item.ciphertext, updatedAt: Date.now() });
      return existing;
    }
    const rec: SyncRecordDto = { id: uuidv7(), kind: item.kind, ref: item.ref, rev: this.rev, deleted: item.deleted, ciphertext: item.ciphertext, updatedAt: Date.now() };
    this.records.push(rec);
    return rec;
  }

  private async handle(method: string, path: string, q: URLSearchParams, init: RequestInit): Promise<Response> {
    const body = () => JSON.parse(String(init.body)) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/me') return json(200, { id: 'me', username: 'me', role: this.role, status: 'active', createdAt: 1 });

    // --- sync ---
    if (path === '/sync/keys' && method === 'GET') return this.keys ? json(200, this.keys) : json(404, { error: 'not_found', message: 'Sync is not set up' });
    if (path === '/sync/keys' && method === 'PUT') {
      const replace = (init.headers as Record<string, string>)['X-Libraria-Replace-Keys'] === '1';
      if (this.keys && !replace) return json(409, { error: 'conflict', message: 'exists' });
      const created = !this.keys;
      this.keys = body() as unknown as SyncKeysDto;
      return json(created ? 201 : 200, this.keys);
    }
    if (path === '/sync' && method === 'DELETE') {
      this.keys = null;
      this.records = [];
      return new Response(null, { status: 204 });
    }
    if (path === '/sync/records' && method === 'GET') {
      const since = Number(q.get('since') ?? 0);
      const limit = Math.min(this.pageLimit, Number(q.get('limit') ?? 500));
      const rows = this.records.filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev);
      const page = rows.slice(0, limit);
      return json(200, { records: page, rev: page.length ? page[page.length - 1]!.rev : since, more: rows.length > limit });
    }
    if (path === '/sync/records' && method === 'POST') {
      this.beforePush?.();
      this.beforePush = null;
      const items = body().items as SyncPushItem[];
      const out = { applied: [] as { ref: string; kind: string; rev: number; id: string }[], conflicts: [] as SyncRecordDto[] };
      for (const it of items) {
        const existing = this.records.find((r) => r.kind === it.kind && r.ref === it.ref);
        if (existing && existing.rev !== it.baseRev) {
          out.conflicts.push({ ...existing });
          continue;
        }
        const rec = this.putRecord(it);
        out.applied.push({ ref: rec.ref, kind: rec.kind, rev: rec.rev, id: rec.id });
      }
      return json(200, out);
    }

    // --- books & submissions ---
    if (method === 'GET' && path === '/books/lookup') {
      const sha = q.get('sha512');
      const book = [...this.books.values()].find((b) => b.sha512 === sha);
      const sub = [...this.submissions.values()].find((s) => s.sha512 === sha && (s.status === 'uploading' || s.status === 'pending'));
      return json(200, { bookId: book?.id ?? null, submissionId: sub?.id ?? null });
    }
    if ((m = /^\/books\/([^/]+)$/.exec(path)) && method === 'GET') {
      const b = this.books.get(m[1]!);
      return b ? json(200, { ...b, title: 't', authors: [], format: 'cbz', fileSize: 1 }) : json(404, { error: 'not_found', message: 'No such book' });
    }
    if ((m = /^\/books\/([^/]+)\/cover$/.exec(path)) && method === 'PUT') {
      this.covers.set(m[1]!, init.body as Blob);
      const b = this.books.get(m[1]!)!;
      b.hasCover = true;
      return json(200, b);
    }
    if (method === 'POST' && path === '/submissions') {
      const b = body();
      const dupBook = [...this.books.values()].find((x) => x.sha512 === b.sha512);
      const dupSub = [...this.submissions.values()].find((s) => s.sha512 === b.sha512 && (s.status === 'uploading' || s.status === 'pending'));
      if (dupBook || dupSub) {
        return json(409, { error: 'duplicate', message: 'dup', bookId: dupBook?.id ?? null, submissionId: dupSub?.id ?? null });
      }
      const sub: FakeSubmission = {
        id: uuidv7(),
        sha512: String(b.sha512),
        fileSize: Number(b.fileSize),
        title: String(b.title),
        offset: 0,
        bytes: new Uint8Array(Number(b.fileSize)),
        status: 'uploading',
        bookId: null,
        userId: 'me',
      };
      this.submissions.set(sub.id, sub);
      return json(201, this.subDto(sub));
    }
    if ((m = /^\/submissions\/([^/]+)$/.exec(path))) {
      const sub = this.submissions.get(m[1]!);
      if (!sub) return json(404, { error: 'not_found', message: 'No such submission' });
      if (method === 'GET') return json(200, this.subDto(sub));
      if (method === 'DELETE') {
        this.submissions.delete(sub.id);
        return new Response(null, { status: 204 });
      }
    }
    if ((m = /^\/submissions\/([^/]+)\/content$/.exec(path))) {
      const sub = this.submissions.get(m[1]!);
      if (!sub) return json(404, { error: 'not_found', message: 'No such submission' });
      if (method === 'HEAD') return new Response(null, { status: 204, headers: { 'Upload-Offset': String(sub.offset) } });
      if (method === 'PATCH') {
        const offset = Number((init.headers as Record<string, string>)['Upload-Offset']);
        if (offset !== sub.offset) {
          return json(409, { error: 'conflict', message: 'offset', offset: sub.offset }, { 'Upload-Offset': String(sub.offset) });
        }
        const chunk = new Uint8Array(await (init.body as Blob).arrayBuffer());
        sub.bytes.set(chunk, offset);
        sub.offset += chunk.length;
        if (sub.offset === sub.fileSize) {
          if ((await sha512(sub.bytes)) !== sub.sha512) {
            sub.offset = 0;
            return json(422, { error: 'hash_mismatch', message: 'The uploaded file does not match the declared SHA-512' });
          }
          sub.status = 'pending';
          if (this.role === 'owner') this.approve(sub.id);
        }
        return new Response(null, { status: 204, headers: { 'Upload-Offset': String(sub.offset) } });
      }
    }
    return json(404, { error: 'not_found', message: `No such endpoint: ${method} ${path}` });
  }

  approve(id: string): string {
    const sub = this.submissions.get(id)!;
    const bookId = uuidv7();
    this.books.set(bookId, { id: bookId, sha512: sub.sha512, hasCover: false });
    sub.status = 'approved';
    sub.bookId = bookId;
    return bookId;
  }

  private subDto(s: FakeSubmission) {
    return {
      id: s.id,
      userId: s.userId,
      username: 'me',
      sha512: s.sha512,
      format: 'cbz',
      fileSize: s.fileSize,
      filename: 'f.cbz',
      title: s.title,
      authors: [],
      uploadOffset: s.offset,
      status: s.status,
      reviewNote: null,
      reviewedBy: null,
      bookId: s.bookId,
      createdAt: 1,
      reviewedAt: null,
    };
  }
}
