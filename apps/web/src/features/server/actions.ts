import { DEVICE_ONLY_SOURCES } from '@libraria/core';
import type { BookRecord } from '../../lib/db/schema';
import { net } from '../../lib/net.svelte';
import { services } from '../../lib/services';
import { describeError } from '../../lib/server/api';
import type { LibrariaSource } from '../../lib/server/servers';
import { enqueueUpload, processUploads } from '../../lib/server/uploads';
import { catalog } from '../../lib/stores/catalog.svelte';
import { toasts } from '../../lib/stores/toasts.svelte';

/** Books this device can send: identified, and stored on the device (imported, folder, or offline copy). */
export function sendable(book: BookRecord): boolean {
  if (!book.sha512) return false;
  const local = new Set(catalog.sources.filter((s) => DEVICE_ONLY_SOURCES.includes(s.config.kind)).map((s) => s.id));
  return catalog.files.some((f) => f.bookId === book.id && local.has(f.sourceId)) || catalog.offline.has(book.id);
}

/** True if the server already lists the book. */
export function onServer(bookId: string, sourceId: string): boolean {
  return catalog.files.some((f) => f.bookId === bookId && f.sourceId === sourceId);
}

export async function sendBook(source: LibrariaSource, book: BookRecord): Promise<void> {
  try {
    await enqueueUpload(services(), source, book);
    toasts.show(net.online ? `Sending “${book.title}” to ${source.name}` : `“${book.title}” will be sent when you are online`, {
      timeout: 3000,
    });
    void processUploads(services()).catch(() => {});
  } catch (err) {
    toasts.error('Could not send the book', describeError(err));
  }
}
