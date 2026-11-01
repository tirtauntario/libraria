/**
 * Offline copies of books from remote sources, and their eviction.
 *
 * Books in a local source (imported into this device, or a linked folder)
 * have no offline copy: the source itself is local, and is never evicted.
 */
import type { OfflineFileRecord } from '../db/schema';
import type { Services } from '../services';

const DAY = 24 * 60 * 60 * 1000;

export async function removeOfflineCopy(bookId: string, s: Services): Promise<boolean> {
  const rec = await s.repo.getOffline(bookId);
  if (!rec) return false;
  await s.files.remove(rec.opfsName);
  await s.repo.deleteOffline(rec.id);
  return true;
}

export async function setPinned(bookId: string, pinned: boolean, s: Services): Promise<void> {
  const rec = await s.repo.getOffline(bookId);
  if (rec) await s.repo.putOffline({ ...rec, pinned });
}

export interface EvictionPolicy {
  now: number;
  /** Remove unpinned copies not opened for this many days; 0 = never. */
  autoRemoveDays: number;
  /** Keep the total size of offline copies under this many bytes; 0 = no limit. */
  limitBytes: number;
  /** Never evict these books (e.g. the one being read). */
  keepBookIds?: Iterable<string>;
}

/**
 * Which offline copies to remove. Pure, so it is easy to test.
 * 1. Unpinned copies not opened within `autoRemoveDays`.
 * 2. Then, while over `limitBytes`, the least recently opened unpinned copies.
 * Pinned copies are never removed, even if that leaves the total over the limit.
 */
export function selectEvictions(files: OfflineFileRecord[], policy: EvictionPolicy): OfflineFileRecord[] {
  const keep = new Set(policy.keepBookIds ?? []);
  const evict = new Set<OfflineFileRecord>();
  const candidates = files.filter((f) => !f.pinned && !keep.has(f.bookId)).sort((a, b) => a.lastOpenedAt - b.lastOpenedAt);

  if (policy.autoRemoveDays > 0) {
    const cutoff = policy.now - policy.autoRemoveDays * DAY;
    for (const f of candidates) if (f.lastOpenedAt < cutoff) evict.add(f);
  }

  if (policy.limitBytes > 0) {
    let total = files.reduce((sum, f) => sum + (evict.has(f) ? 0 : f.size), 0);
    for (const f of candidates) {
      if (total <= policy.limitBytes) break;
      if (evict.has(f)) continue;
      evict.add(f);
      total -= f.size;
    }
  }
  return candidates.filter((f) => evict.has(f));
}

/** Apply the device's eviction settings now. Returns the removed copies. */
export async function runEviction(s: Services, opts: { keepBookIds?: Iterable<string>; extraBytes?: number } = {}): Promise<OfflineFileRecord[]> {
  const settings = await s.repo.getDeviceSettings();
  if (settings.autoRemoveDays <= 0 && settings.offlineLimitBytes <= 0) return [];
  const files = await s.repo.listOffline();
  const limit = settings.offlineLimitBytes > 0 ? Math.max(1, settings.offlineLimitBytes - (opts.extraBytes ?? 0)) : 0;
  const victims = selectEvictions(files, {
    now: Date.now(),
    autoRemoveDays: settings.autoRemoveDays,
    limitBytes: limit,
    keepBookIds: opts.keepBookIds,
  });
  for (const v of victims) {
    await s.files.remove(v.opfsName);
    await s.repo.deleteOffline(v.id);
  }
  return victims;
}
