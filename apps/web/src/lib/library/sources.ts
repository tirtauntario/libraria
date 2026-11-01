/**
 * Source management on top of scanSource(): which folders to scan, when to
 * rescan automatically, and removing a source.
 */
import type { Library, Source } from '@libraria/core';
import type { Services } from '../services';
import { forgetFolderHandle } from '../sources/folder';
import { forgetDriver } from '../sources/registry';
import { dropIfOrphan, inFolder } from './scan';

const clean = (p: string) => p.trim().replace(/^\/+|\/+$/g, '');

/**
 * Folders of `sourceId` that libraries use, without nested duplicates. A
 * source no library uses, or one used as a whole, is scanned from the root.
 */
export function scanRoots(sourceId: string, libraries: Pick<Library, 'sources' | 'deleted'>[]): string[] {
  const paths = libraries
    .filter((l) => !l.deleted)
    .flatMap((l) => l.sources)
    .filter((r) => r.sourceId === sourceId)
    .map((r) => clean(r.path));
  if (paths.length === 0 || paths.includes('')) return [''];
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length);
  return unique.filter((p, i) => !unique.slice(0, i).some((q) => inFolder(p, q)));
}

export const RESCAN_INTERVAL = 60 * 60 * 1000;
const lastScanKey = (id: string) => `scan:last:${id}`;

export async function lastScanAt(s: Services, sourceId: string): Promise<number> {
  return (await s.repo.getValue<number>(lastScanKey(sourceId))) ?? 0;
}

export async function markScanned(s: Services, sourceId: string, at = Date.now()): Promise<void> {
  await s.repo.setValue(lastScanKey(sourceId), at);
}

/** Sources due for an automatic rescan (not scanned within `interval`). */
export function dueForRescan(sources: Source[], last: Map<string, number>, now: number, interval = RESCAN_INTERVAL): Source[] {
  return sources.filter((src) => src.config.kind !== 'local' && !src.deleted && now - (last.get(src.id) ?? 0) >= interval);
}

/**
 * Remove a source: soft-delete it (so the removal syncs), drop it from
 * libraries, and forget its files. Books found nowhere else are removed
 * unless they have a pinned offline copy. Progress and bookmarks stay.
 */
export async function removeSource(source: Source, s: Services): Promise<void> {
  for (const lib of await s.repo.listLibraries()) {
    if (lib.sources.some((r) => r.sourceId === source.id)) {
      await s.repo.updateLibrary(lib.id, { sources: lib.sources.filter((r) => r.sourceId !== source.id) });
    }
  }
  await s.repo.deleteSource(source.id);
  forgetDriver(source.id);
  const files = await s.repo.listFilesBySource(source.id);
  for (const f of files) await s.repo.deleteBookFile(f.id);
  for (const bookId of new Set(files.map((f) => f.bookId))) await dropIfOrphan(bookId, s);
  await s.repo.setValue(lastScanKey(source.id), null);
  if (source.config.kind === 'folder' && source.config.handleId) await forgetFolderHandle(s.repo, source.config.handleId);
}
