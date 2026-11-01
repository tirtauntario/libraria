import type { BookRecord } from '../db/schema';
import type { Services } from '../services';

/**
 * Remove a book from this device: its records, its offline copy and the
 * files it has in sources that can delete (the local source). Files in
 * remote sources are left alone; a later scan would find them again.
 * Progress and bookmarks are kept: they are keyed by hash and synced.
 */
export async function deleteBook(bookId: string, s: Services): Promise<void> {
  const files = await s.repo.listBookFiles(bookId);
  for (const f of files) {
    const source = await s.repo.getSource(f.sourceId);
    if (!source) continue;
    try {
      const driver = s.driver(source);
      if (driver.isLocal && source.config.kind === 'local') await driver.remove?.(f.path);
    } catch {
      // Source unavailable: nothing to delete there.
    }
  }
  const { offline } = await s.repo.deleteBookRecords(bookId);
  if (offline) await s.files.remove(offline.opfsName);
}

export type BookEdit = Pick<BookRecord, 'title' | 'series' | 'customGroup'> & { authors?: string[] };

export async function editBook(bookId: string, edit: BookEdit, s: Services): Promise<BookRecord | undefined> {
  return s.repo.updateBook(bookId, {
    title: edit.title.trim() || 'Untitled',
    series: edit.series?.trim() || null,
    customGroup: edit.customGroup?.trim() || null,
    ...(edit.authors ? { authors: edit.authors.map((a) => a.trim()).filter(Boolean) } : {}),
    metaEdited: true,
  });
}
