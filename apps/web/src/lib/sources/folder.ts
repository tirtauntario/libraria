/**
 * A folder on this device, linked with the File System Access API
 * (Chromium only). Books are read in place: `read()` returns the File
 * itself, nothing is copied into OPFS.
 *
 * The FileSystemDirectoryHandle is stored in IndexedDB (settings store, key
 * `folder:handle:<handleId>`). Browsers drop the read permission between
 * sessions; asking again needs a user gesture, so the driver only *checks*
 * the permission and throws SourceError('permission'); the UI shows a
 * "Grant access" button that calls `requestFolderAccess()` from a click.
 * Device-only: never synced.
 */
import type { Source } from '@libraria/core';
import type { Repo } from '../db/repo';
import { SourceError } from './errors';
import type { ListOptions, ReadOptions, SourceDriver, SourceEntry } from './types';

/** The subset of FileSystemHandle APIs used here (so tests can fake them). */
export interface DirHandle {
  readonly kind: 'directory';
  readonly name: string;
  entries(): AsyncIterable<[string, DirHandle | FileHandle]>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface FileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}

export type FolderAccess = 'granted' | 'prompt' | 'denied' | 'missing';

export function folderSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

const handleKey = (id: string) => `folder:handle:${id}`;

/** Handles in memory, so a freshly linked folder works without a database round trip. */
const handles = new Map<string, DirHandle>();

export function rememberHandle(handleId: string, handle: DirHandle): void {
  handles.set(handleId, handle);
}

export async function saveFolderHandle(repo: Repo, handleId: string, handle: DirHandle): Promise<void> {
  rememberHandle(handleId, handle);
  await repo.setValue(handleKey(handleId), handle);
}

export async function forgetFolderHandle(repo: Repo, handleId: string): Promise<void> {
  handles.delete(handleId);
  await repo.setValue(handleKey(handleId), null);
}

export async function loadFolderHandle(repo: Repo, source: Source): Promise<DirHandle | null> {
  if (source.config.kind !== 'folder' || !source.config.handleId) return null;
  const id = source.config.handleId;
  const cached = handles.get(id);
  if (cached) return cached;
  const stored = await repo.getValue<DirHandle | null>(handleKey(id));
  if (stored) handles.set(id, stored);
  return stored ?? null;
}

export async function folderAccess(repo: Repo, source: Source): Promise<FolderAccess> {
  const h = await loadFolderHandle(repo, source);
  if (!h) return 'missing';
  if (!h.queryPermission) return 'granted';
  return h.queryPermission({ mode: 'read' });
}

/** Ask for read access again. Must run inside a click handler. */
export async function requestFolderAccess(repo: Repo, source: Source): Promise<boolean> {
  const h = await loadFolderHandle(repo, source);
  if (!h) return false;
  if (!h.requestPermission) return true;
  return (await h.requestPermission({ mode: 'read' })) === 'granted';
}

/** Open the browser's folder picker. Must run inside a click handler. */
export async function pickDirectory(): Promise<DirHandle | null> {
  const w = window as unknown as { showDirectoryPicker(opts?: { mode?: 'read'; id?: string }): Promise<DirHandle> };
  try {
    return await w.showDirectoryPicker({ mode: 'read', id: 'libraria-books' });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null; // user cancelled
    throw err;
  }
}

export class FolderDriver implements SourceDriver {
  readonly isLocal = true;

  constructor(
    readonly source: Source,
    private readonly repo: Repo,
  ) {}

  private get label(): string {
    return this.source.config.kind === 'folder' ? this.source.config.name : this.source.name;
  }

  private async root(): Promise<DirHandle> {
    const h = await loadFolderHandle(this.repo, this.source);
    if (!h) throw new SourceError('config', `The link to the folder “${this.label}” is missing on this device. Remove the source and add the folder again.`);
    const state = h.queryPermission ? await h.queryPermission({ mode: 'read' }) : 'granted';
    if (state !== 'granted') throw new SourceError('permission', `Libraria needs your permission to read the folder “${this.label}” again.`);
    return h;
  }

  private async dir(path: string): Promise<DirHandle> {
    let d = await this.root();
    for (const seg of path.split('/').filter(Boolean)) {
      try {
        d = await d.getDirectoryHandle(seg);
      } catch (err) {
        throw this.mapError(err, path);
      }
    }
    return d;
  }

  private mapError(err: unknown, path: string): unknown {
    const name = (err as Error)?.name;
    if (name === 'NotFoundError' || name === 'TypeMismatchError') return new SourceError('not-found', `“${path}” is no longer in the folder “${this.label}”.`);
    if (name === 'NotAllowedError' || name === 'SecurityError') return new SourceError('permission', `Libraria needs your permission to read the folder “${this.label}” again.`);
    return err;
  }

  async *list(path: string, opts: ListOptions = {}): AsyncIterable<SourceEntry> {
    const d = await this.dir(path);
    for await (const [name, h] of d.entries()) {
      opts.signal?.throwIfAborted();
      const p = path ? `${path}/${name}` : name;
      if (h.kind === 'directory') {
        yield { path: p, name, isDir: true, size: null, mtime: null, etag: null };
      } else {
        try {
          const f = await h.getFile();
          yield { path: p, name, isDir: false, size: f.size, mtime: f.lastModified, etag: null };
        } catch {
          // unreadable entry (locked, vanished): skip it
        }
      }
    }
  }

  private async file(path: string): Promise<File> {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new SourceError('not-found', 'Empty path');
    const d = await this.dir(parts.join('/'));
    try {
      return await (await d.getFileHandle(name)).getFile();
    } catch (err) {
      throw this.mapError(err, path);
    }
  }

  async stat(path: string): Promise<SourceEntry | null> {
    try {
      const f = await this.file(path);
      return { path, name: f.name, isDir: false, size: f.size, mtime: f.lastModified, etag: null };
    } catch (err) {
      if (err instanceof SourceError && err.code === 'not-found') return null;
      throw err;
    }
  }

  async read(path: string, opts: ReadOptions = {}): Promise<Blob> {
    const f = await this.file(path);
    opts.onProgress?.(f.size, f.size);
    return f;
  }

  describe() {
    return { title: 'Folder on this device', detail: this.label };
  }
}
