/**
 * The built-in "This device" source: books imported into the file store
 * (OPFS). Every device has exactly one; it never syncs.
 *
 * Paths are `<fileId>/<filename>`, stored at `local/<fileId>/<filename>`.
 * The per-file folder keeps the original filename without collisions.
 */
import type { Source } from '@libraria/core';
import type { FileStore } from '../storage/opfs';
import { registerSourceKind } from './registry';
import type { ReadOptions, SourceDriver, SourceEntry } from './types';

export const LOCAL_PREFIX = 'local/';

export function localStoreName(path: string): string {
  return LOCAL_PREFIX + path;
}

/** Make a filename safe for OPFS and for display. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '_').trim();
  return (clean || 'book').slice(0, 180);
}

export class LocalDriver implements SourceDriver {
  readonly isLocal = true;

  constructor(
    readonly source: Source,
    private readonly files: FileStore,
  ) {}

  async *list(path: string): AsyncIterable<SourceEntry> {
    // The store is flat per file; present every book at the root.
    if (path !== '') return;
    for (const f of await this.files.list(LOCAL_PREFIX)) {
      const rel = f.name.slice(LOCAL_PREFIX.length);
      yield { path: rel, name: rel.split('/').pop() ?? rel, isDir: false, size: f.size, mtime: null, etag: null };
    }
  }

  async stat(path: string): Promise<SourceEntry | null> {
    const blob = await this.files.read(localStoreName(path));
    if (!blob) return null;
    const mtime = blob instanceof File ? blob.lastModified : null;
    return { path, name: path.split('/').pop() ?? path, isDir: false, size: blob.size, mtime, etag: null };
  }

  async read(path: string, opts?: ReadOptions): Promise<Blob> {
    const blob = await this.files.read(localStoreName(path));
    if (!blob) throw new Error('This file is missing from the device storage.');
    opts?.onProgress?.(blob.size, blob.size);
    return blob;
  }

  async write(path: string, data: Blob, opts?: ReadOptions): Promise<SourceEntry> {
    const size = await this.files.write(localStoreName(path), data, {
      signal: opts?.signal,
      onProgress: (n) => opts?.onProgress?.(n, data.size),
    });
    return { path, name: path.split('/').pop() ?? path, isDir: false, size, mtime: Date.now(), etag: null };
  }

  async remove(path: string): Promise<void> {
    await this.files.remove(localStoreName(path));
  }

  describe() {
    return { title: 'This device', detail: this.files.kind === 'opfs' ? 'Private browser storage' : 'Browser database storage' };
  }
}

registerSourceKind({
  kind: 'local',
  label: 'This device',
  description: 'Books you import are stored in this browser.',
  deviceOnly: true,
  implemented: true,
  userCreatable: false,
  isSupported: () => true,
  createDriver: (source, ctx) => new LocalDriver(source, ctx.files),
});
