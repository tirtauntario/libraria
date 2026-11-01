import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { API_PREFIX, randomSalt, randomToken, type AuthResponse, type BookFormat, type KdfParams } from '@libraria/core';
import { createServer, type ServerHandle } from '../src/app';
import { defaultConfig, finalizeConfig, type ServerConfig } from '../src/config';
import { createLogger } from '../src/log';

/** Cheapest KDF the server accepts. The server treats authHash as opaque anyway. */
export const TEST_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 16 * 1024, iterations: 1, parallelism: 1 };

export interface Creds {
  salt: string;
  kdf: KdfParams;
  authHash: string;
}

export function newCreds(): Creds {
  return { salt: randomSalt(), kdf: TEST_KDF, authHash: randomToken(32) };
}

export interface TestServer extends ServerHandle {
  dir: string;
  api: ReturnType<typeof request>;
  /** Test clock used by the server. */
  clock: { now: number; advance(ms: number): void };
  setup(): Promise<{ token: string; userId: string; creds: Creds }>;
  /** Registers (and, if needed, approves via the owner) a user with a role. */
  user(username: string, role?: 'member' | 'curator', ownerToken?: string): Promise<{ token: string; userId: string; creds: Creds }>;
  destroy(): Promise<void>;
}

export const p = (path: string) => `${API_PREFIX}${path}`;
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), 'libraria-test-'));
  const fast = { capacity: 1e9, refillPerSecond: 1e9 };
  const config = finalizeConfig({
    ...defaultConfig(join(dir, 'data')),
    webDir: null,
    rateLimit: { anonymous: fast, auth: fast },
    ...overrides,
  });
  const clock = {
    now: Date.now(),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const handle = await createServer(config, { log: createLogger('silent'), now: () => clock.now });
  const api = request(handle.app);

  let ownerToken: string | null = null;
  const t: TestServer = {
    ...handle,
    dir,
    api,
    clock,
    async setup() {
      const creds = newCreds();
      const res = await api
        .post(p('/setup'))
        .send({ setupToken: handle.setupToken, username: 'owner', libraryName: 'Test Library', ...creds });
      if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
      const body = res.body as AuthResponse;
      ownerToken = body.token!;
      return { token: body.token!, userId: body.user.id, creds };
    },
    async user(username, role = 'member', owner = ownerToken ?? undefined) {
      if (!owner) throw new Error('call setup() first');
      const creds = newCreds();
      const reg = await api.post(p('/auth/register')).send({ username, ...creds });
      if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
      const userId = (reg.body as AuthResponse).user.id;
      const patch: Record<string, string> = {};
      if ((reg.body as AuthResponse).user.status !== 'active') patch.status = 'active';
      if (role !== 'member') patch.role = role;
      if (Object.keys(patch).length) {
        const res = await api.patch(p(`/users/${userId}`)).set(bearer(owner)).send(patch);
        if (res.status !== 200) throw new Error(`patch user failed: ${res.status}`);
      }
      const login = await api.post(p('/auth/login')).send({ username, authHash: creds.authHash });
      if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
      return { token: login.body.token as string, userId, creds };
    },
    async destroy() {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return t;
}

export function sha512hex(data: Uint8Array): string {
  return createHash('sha512').update(data).digest('hex');
}

// 1x1 PNG
export const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function blobBytes(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

/** A CBZ; `seed` changes the bytes so each call can produce a distinct book. */
export async function makeCbz(pages = 3, opts: { comicInfo?: string; seed?: string } = {}): Promise<Buffer> {
  const zip = new ZipWriter(new BlobWriter('application/zip'));
  for (let i = 1; i <= pages; i++) await zip.add(`page${i}.png`, new Uint8ArrayReader(PNG));
  if (opts.comicInfo) await zip.add('ComicInfo.xml', new TextReader(opts.comicInfo));
  await zip.add('seed.txt', new TextReader(opts.seed ?? randomToken(8)));
  return blobBytes(await zip.close());
}

export async function makeEpub(title = 'The Test Book', seed = randomToken(8)): Promise<Buffer> {
  const zip = new ZipWriter(new BlobWriter('application/epub+zip'), { extendedTimestamp: false });
  await zip.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
  await zip.add(
    'META-INF/container.xml',
    new TextReader(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  await zip.add(
    'OEBPS/content.opf',
    new TextReader(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:${seed}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
    <meta property="belongs-to-collection" id="c1">Engines</meta>
    <meta property="group-position">2</meta>
  </metadata>
  <manifest>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`),
  );
  await zip.add('OEBPS/images/cover.png', new Uint8ArrayReader(PNG));
  await zip.add('OEBPS/text/ch1.xhtml', new TextReader('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hello</p></body></html>'));
  return blobBytes(await zip.close());
}

export function makePdf(size = 4096): Buffer {
  const buf = Buffer.alloc(size, 0x20);
  buf.write('%PDF-1.4\n', 0, 'latin1');
  buf.write(randomToken(16), 16, 'latin1');
  return buf;
}

export interface UploadOptions {
  format?: BookFormat;
  filename?: string;
  title?: string;
  chunk?: number;
  sha512?: string;
}

/** Creates a submission and uploads it in chunks. Returns the submission id and last response. */
export async function upload(t: TestServer, token: string, data: Buffer, opts: UploadOptions = {}) {
  const create = await t.api
    .post(p('/submissions'))
    .set(bearer(token))
    .send({
      sha512: opts.sha512 ?? sha512hex(data),
      format: opts.format ?? 'cbz',
      fileSize: data.length,
      filename: opts.filename ?? 'book.cbz',
      title: opts.title ?? '',
      authors: [],
    });
  if (create.status !== 201) return { create, id: null as string | null, last: create };
  const id = create.body.id as string;
  const chunk = opts.chunk ?? Math.ceil(data.length / 3);
  let last = create;
  for (let off = 0; off < data.length; off += chunk) {
    last = await t.api
      .patch(p(`/submissions/${id}/content`))
      .set(bearer(token))
      .set('Upload-Offset', String(off))
      .set('Content-Type', 'application/offset+octet-stream')
      .send(data.subarray(off, off + chunk));
    if (last.status !== 204) break;
  }
  return { create, id, last };
}

/** supertest parser that collects any response body as a Buffer. */
export function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  const stream = res as unknown as NodeJS.ReadableStream;
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}
