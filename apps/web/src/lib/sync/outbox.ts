import { DEVICE_ONLY_SOURCES } from '@libraria/core';
import { changeKey, type Repo } from '../db/repo';
import type { ChangeKind, ChangeRecord } from '../db/schema';

/**
 * Put every synced record back into the outbox. Used when sync is set up
 * (again) on this device: entries acknowledged for an earlier account or key
 * are gone from the outbox, but the new sync home needs all of it. Existing
 * entries are left as they are. Returns how many were added.
 */
export async function requeueAll(repo: Repo): Promise<number> {
  const meta = await repo.meta();
  const db = repo.db;
  const tx = db.transaction(['progress', 'bookmarks', 'libraries', 'sources', 'settings', 'changes'], 'readwrite');
  const changes = tx.objectStore('changes');
  let added = 0;
  const add = async (kind: ChangeKind, ref: string, updatedAt: number) => {
    const key = changeKey(kind, ref);
    if (await changes.get(key)) return;
    const rec: ChangeRecord = { key, kind, ref, updatedAt };
    await changes.put(rec);
    added++;
  };
  for (const p of await tx.objectStore('progress').getAll()) await add('progress', p.sha512, p.updatedAt);
  for (const b of await tx.objectStore('bookmarks').getAll()) await add('bookmark', b.id, b.updatedAt);
  for (const l of await tx.objectStore('libraries').getAll()) {
    if (l.id !== meta.localLibraryId) await add('library', l.id, l.updatedAt);
  }
  for (const s of await tx.objectStore('sources').getAll()) {
    if (!DEVICE_ONLY_SOURCES.includes(s.config.kind)) await add('source', s.id, s.updatedAt);
  }
  const settingsAt = (await tx.objectStore('settings').get('syncedUpdatedAt')) as number | undefined;
  if (settingsAt) await add('settings', 'synced', settingsAt);
  await tx.done;
  return added;
}
