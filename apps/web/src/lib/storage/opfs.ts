/**
 * Book file storage. Files live in the Origin Private File System when the
 * browser supports it, otherwise as Blobs in IndexedDB.
 *
 * Names are '/'-separated paths such as `local/<id>/Book.epub` or
 * `offline/<id>.cbz`. Writes stream: a file is never loaded into memory as a
 * whole (except on the IndexedDB fallback, where the browser itself decides
 * how to hold the Blob).
 */
import type { Db } from '../db/schema';

export interface WriteOptions {
  signal?: AbortSignal;
  /** Bytes written so far. */
  onProgress?: (bytes: number) => void;
}

export interface StoredFile {
  name: string;
  size: number;
}

export interface FileStore {
  readonly kind: 'opfs' | 'idb';
  /** Write (or overwrite) a file. Resolves to the number of bytes written. */
  write(name: string, data: Blob | ReadableStream<Uint8Array>, opts?: WriteOptions): Promise<number>;
  /** A lazily-read Blob (an OPFS File), or null if missing. */
  read(name: string): Promise<Blob | null>;
  remove(name: string): Promise<void>;
  /** Files whose name starts with `prefix` (e.g. 'local/'). */
  list(prefix?: string): Promise<StoredFile[]>;
  /** Remove everything. */
  clear(): Promise<void>;
}

const STORE_ROOT = 'libraria';

function splitName(name: string): { dirs: string[]; file: string } {
  const parts = name.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) throw new Error(`Bad file name: ${name}`);
  return { dirs: parts.slice(0, -1), file: parts[parts.length - 1]! };
}

/** Wrap a stream so every chunk reports progress and the signal can abort it. */
function counted(stream: ReadableStream<Uint8Array>, opts?: WriteOptions): ReadableStream<Uint8Array> {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        if (opts?.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
        total += chunk.byteLength;
        opts?.onProgress?.(total);
        ctrl.enqueue(chunk);
      },
    }),
  );
}

const toStream = (data: Blob | ReadableStream<Uint8Array>) =>
  data instanceof Blob ? (data.stream() as ReadableStream<Uint8Array>) : data;

// ---------------------------------------------------------------------------

export class OpfsFileStore implements FileStore {
  readonly kind = 'opfs';

  private constructor(
    private root: FileSystemDirectoryHandle,
    private readonly hasWritable: boolean,
  ) {}

  static async open(): Promise<OpfsFileStore | null> {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
      const top = await navigator.storage.getDirectory();
      const root = await top.getDirectoryHandle(STORE_ROOT, { create: true });
      const hasWritable = typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
      // Without createWritable (older Safari) writes go through a worker with
      // a sync access handle; make sure workers exist at all.
      if (!hasWritable && typeof Worker === 'undefined') return null;
      return new OpfsFileStore(root, hasWritable);
    } catch {
      return null;
    }
  }

  private async dir(dirs: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let d = this.root;
    try {
      for (const name of dirs) d = await d.getDirectoryHandle(name, { create });
      return d;
    } catch {
      return null;
    }
  }

  async write(name: string, data: Blob | ReadableStream<Uint8Array>, opts?: WriteOptions): Promise<number> {
    const { dirs, file } = splitName(name);
    const dir = await this.dir(dirs, true);
    if (!dir) throw new Error(`Cannot create folder for ${name}`);
    const handle = await dir.getFileHandle(file, { create: true });
    let written = 0;
    const source = counted(toStream(data), {
      signal: opts?.signal,
      onProgress: (n) => {
        written = n;
        opts?.onProgress?.(n);
      },
    });
    try {
      if (this.hasWritable) {
        const writable = await handle.createWritable();
        await source.pipeTo(writable, { signal: opts?.signal });
      } else {
        await writeWithWorker([STORE_ROOT, ...dirs, file], source);
      }
    } catch (err) {
      await dir.removeEntry(file).catch(() => {});
      throw err;
    }
    return written;
  }

  async read(name: string): Promise<Blob | null> {
    const { dirs, file } = splitName(name);
    const dir = await this.dir(dirs, false);
    if (!dir) return null;
    try {
      return await (await dir.getFileHandle(file)).getFile();
    } catch {
      return null;
    }
  }

  async remove(name: string): Promise<void> {
    const { dirs, file } = splitName(name);
    const dir = await this.dir(dirs, false);
    if (!dir) return;
    await dir.removeEntry(file).catch(() => {});
    // Tidy up empty per-file folders such as local/<id>/.
    if (dirs.length > 1) {
      const parent = await this.dir(dirs.slice(0, -1), false);
      const empty = await isEmpty(dir);
      if (parent && empty) await parent.removeEntry(dirs[dirs.length - 1]!).catch(() => {});
    }
  }

  async list(prefix = ''): Promise<StoredFile[]> {
    const out: StoredFile[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
      for await (const [entryName, entry] of entries(dir)) {
        const full = path ? `${path}/${entryName}` : entryName;
        if (entry.kind === 'directory') {
          await walk(entry as FileSystemDirectoryHandle, full);
        } else if (full.startsWith(prefix)) {
          const f = await (entry as FileSystemFileHandle).getFile();
          out.push({ name: full, size: f.size });
        }
      }
    };
    await walk(this.root, '');
    return out;
  }

  async clear(): Promise<void> {
    const top = await navigator.storage.getDirectory();
    await top.removeEntry(STORE_ROOT, { recursive: true }).catch(() => {});
    const root = await top.getDirectoryHandle(STORE_ROOT, { create: true });
    this.root = root;
  }
}

type DirEntries = AsyncIterable<[string, FileSystemHandle]>;
function entries(dir: FileSystemDirectoryHandle): DirEntries {
  return (dir as unknown as { entries(): DirEntries }).entries();
}

async function isEmpty(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const _ of entries(dir)) return false;
  return true;
}

/** Older Safari: OPFS files can only be written from a worker via createSyncAccessHandle. */
async function writeWithWorker(path: string[], source: ReadableStream<Uint8Array>): Promise<void> {
  const worker = new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), { type: 'module' });
  const call = (msg: unknown, transfer: Transferable[] = []) =>
    new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ ok: boolean; error?: string }>) =>
        e.data.ok ? resolve() : reject(new Error(e.data.error ?? 'OPFS write failed'));
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage(msg, transfer);
    });
  const reader = source.getReader();
  try {
    await call({ op: 'open', path });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const copy = value.slice();
      await call({ op: 'write', chunk: copy.buffer }, [copy.buffer]);
    }
    await call({ op: 'close' });
  } finally {
    reader.releaseLock();
    worker.terminate();
  }
}

// ---------------------------------------------------------------------------

/** Fallback store: Blobs in the `fileBlobs` object store. */
export class IdbFileStore implements FileStore {
  readonly kind = 'idb';

  constructor(private readonly db: Db) {}

  async write(name: string, data: Blob | ReadableStream<Uint8Array>, opts?: WriteOptions): Promise<number> {
    splitName(name);
    const blob = await new Response(counted(toStream(data), opts)).blob();
    await this.db.put('fileBlobs', blob, name);
    return blob.size;
  }

  async read(name: string): Promise<Blob | null> {
    return (await this.db.get('fileBlobs', name)) ?? null;
  }

  async remove(name: string): Promise<void> {
    await this.db.delete('fileBlobs', name);
  }

  async list(prefix = ''): Promise<StoredFile[]> {
    const out: StoredFile[] = [];
    let cursor = await this.db.transaction('fileBlobs').store.openCursor();
    while (cursor) {
      const name = String(cursor.key);
      if (name.startsWith(prefix)) out.push({ name, size: cursor.value.size });
      cursor = await cursor.continue();
    }
    return out;
  }

  async clear(): Promise<void> {
    await this.db.clear('fileBlobs');
  }
}

export async function createFileStore(db: Db): Promise<FileStore> {
  return (await OpfsFileStore.open()) ?? new IdbFileStore(db);
}

// ---------------------------------------------------------------------------
// Quota and persistence

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export async function storageEstimate(): Promise<StorageEstimate | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}

export async function isPersisted(): Promise<boolean | null> {
  try {
    return (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    return null;
  }
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
