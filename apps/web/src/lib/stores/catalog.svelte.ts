/**
 * In-memory snapshot of the library for the UI. Re-queried when the
 * underlying data changes (this tab, another tab, or the sync engine).
 */
import { DEVICE_ONLY_SOURCES, type Library, type Progress, type Source } from '@libraria/core';
import type { BookFileRecord, OfflineFileRecord } from '../db/schema';
import type { Topic } from '../db/events';
import { withProgress, type CatalogItem } from '../library/catalog';
import type { Services } from '../services';

class CatalogState {
  books = $state.raw<CatalogItem[]>([]);
  files = $state.raw<BookFileRecord[]>([]);
  offline = $state.raw<Map<string, OfflineFileRecord>>(new Map());
  progress = $state.raw<Map<string, Progress>>(new Map());
  libraries = $state.raw<Library[]>([]);
  sources = $state.raw<Source[]>([]);
  localLibraryId = $state('');
  localSourceId = $state('');
  loaded = $state(false);

  private s: Services | null = null;
  private pending = new Set<Topic>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  async load(s: Services): Promise<void> {
    this.s = s;
    const meta = await s.repo.meta();
    this.localLibraryId = meta.localLibraryId;
    this.localSourceId = meta.localSourceId;
    await this.refresh(new Set(['books', 'progress', 'libraries', 'sources', 'offline']));
    this.loaded = true;
    s.repo.events.subscribe((topics) => {
      for (const t of topics) this.pending.add(t);
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        const batch = this.pending;
        this.pending = new Set();
        void this.refresh(batch);
      }, 30);
    });
  }

  private async refresh(topics: Set<Topic>): Promise<void> {
    const s = this.s;
    if (!s) return;
    if (topics.has('settings')) {
      const meta = await s.repo.meta();
      this.localLibraryId = meta.localLibraryId;
      this.localSourceId = meta.localSourceId;
    }
    if (topics.has('progress') || topics.has('books')) {
      const [books, progress, files] = await Promise.all([s.repo.listBooks(), s.repo.listProgress(), s.repo.listAllBookFiles()]);
      this.progress = new Map(progress.map((p) => [p.sha512, p]));
      this.files = files;
      this.books = withProgress(books, this.progress);
    }
    if (topics.has('offline') || topics.has('books')) {
      this.offline = new Map((await s.repo.listOffline()).map((o) => [o.bookId, o]));
    }
    if (topics.has('libraries')) this.libraries = await s.repo.listLibraries();
    if (topics.has('sources')) this.sources = await s.repo.listSources();
  }

  book(id: string): CatalogItem | undefined {
    return this.books.find((b) => b.id === id);
  }

  /** Books that can be opened without the network (device file or offline copy). */
  onDeviceIds = $derived.by(() => {
    const local = new Set(this.sources.filter((s) => DEVICE_ONLY_SOURCES.includes(s.config.kind)).map((s) => s.id));
    const ids = new Set(this.offline.keys());
    for (const f of this.files) if (local.has(f.sourceId)) ids.add(f.bookId);
    return ids;
  });

  onDevice(bookId: string): boolean {
    return this.onDeviceIds.has(bookId);
  }

  /** Force a full reload (after clearing data). */
  reloadAll(): Promise<void> {
    return this.refresh(new Set(['books', 'progress', 'libraries', 'sources', 'offline', 'settings']));
  }
}

export const catalog = new CatalogState();
