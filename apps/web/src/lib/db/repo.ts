/**
 * All reads and writes of the IndexedDB database go through Repo.
 *
 * Every write to a synced entity (progress, bookmarks, libraries, sources,
 * synced settings) records a ChangeRecord in the same transaction, so the
 * sync engine can find local changes with `listChanges()`. Device-only data
 * (the built-in local source and library, device settings, books, offline
 * copies) is never recorded.
 */
import {
  DEFAULT_DEVICE_SETTINGS,
  DEFAULT_SYNCED_SETTINGS,
  DEVICE_ONLY_SOURCES,
  locatorPercent,
  lww,
  mergeBookmark,
  mergeProgress,
  uuidv7,
  type Bookmark,
  type DeviceSettings,
  type Library,
  type LibrarySourceRef,
  type Locator,
  type Progress,
  type Source,
  type SourceConfig,
  type SyncedSettings,
} from '@libraria/core';
import { ChangeBus, type Topic } from './events';
import type {
  BookFileRecord,
  BookRecord,
  ChangeKind,
  ChangeRecord,
  Db,
  DeviceMeta,
  OfflineFileRecord,
  SettingsKey,
  SettingsValues,
  UiState,
} from './schema';

const DEFAULT_UI: UiState = { collapsedGroups: [] };

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Blob);

/** Fill missing keys of `value` from `defaults`, recursively. Unknown keys are kept. */
export function withDefaults<T>(defaults: T, value: unknown): T {
  if (!isPlain(defaults) || !isPlain(value)) return (value === undefined ? structuredClone(defaults) : value) as T;
  const out: Plain = { ...value };
  for (const [k, d] of Object.entries(defaults)) {
    out[k] = k in value ? withDefaults(d, value[k]) : structuredClone(d);
  }
  return out as T;
}

export function changeKey(kind: ChangeKind, ref: string): string {
  switch (kind) {
    case 'progress':
      return `progress:${ref}`;
    case 'bookmark':
      return `bookmark:${ref}`;
    case 'settings':
      return 'config:settings:settings';
    default:
      return `config:${kind}:${ref}`;
  }
}

export class Repo {
  private metaCache: DeviceMeta | null = null;

  constructor(
    readonly db: Db,
    readonly events: ChangeBus = new ChangeBus(),
    private readonly now: () => number = Date.now,
  ) {}

  // --- bootstrap --------------------------------------------------------------

  /**
   * Make sure the device has its id, the built-in local source and the
   * default "On this device" library. Safe to call on every start.
   */
  async init(): Promise<DeviceMeta> {
    const tx = this.db.transaction(['settings', 'sources', 'libraries'], 'readwrite');
    const settings = tx.objectStore('settings');
    let meta = (await settings.get('meta')) as DeviceMeta | undefined;
    if (!meta) {
      const t = this.now();
      meta = { deviceId: uuidv7(t), localSourceId: uuidv7(t), localLibraryId: uuidv7(t), createdAt: t };
      await settings.put(meta, 'meta');
    }
    if (!(await tx.objectStore('sources').get(meta.localSourceId))) {
      const t = this.now();
      await tx.objectStore('sources').put({
        id: meta.localSourceId,
        name: 'This device',
        config: { kind: 'local' },
        createdAt: t,
        updatedAt: t,
        deleted: false,
      });
    }
    if (!(await tx.objectStore('libraries').get(meta.localLibraryId))) {
      const t = this.now();
      await tx.objectStore('libraries').put({
        id: meta.localLibraryId,
        name: 'On this device',
        sources: [{ sourceId: meta.localSourceId, path: '' }],
        createdAt: t,
        updatedAt: t,
        deleted: false,
      });
    }
    await tx.done;
    this.metaCache = meta;
    return meta;
  }

  async meta(): Promise<DeviceMeta> {
    if (this.metaCache) return this.metaCache;
    const meta = (await this.db.get('settings', 'meta')) as DeviceMeta | undefined;
    if (meta) return (this.metaCache = meta);
    return this.init();
  }

  private emit(...topics: Topic[]) {
    this.events.emit(...topics);
  }

  // --- books ------------------------------------------------------------------

  getBook(id: string): Promise<BookRecord | undefined> {
    return this.db.get('books', id);
  }

  getBookBySha(sha512: string): Promise<BookRecord | undefined> {
    return this.db.getFromIndex('books', 'sha512', sha512);
  }

  listBooks(): Promise<BookRecord[]> {
    return this.db.getAll('books');
  }

  async putBook(book: BookRecord): Promise<void> {
    await this.db.put('books', book);
    this.emit('books');
  }

  async updateBook(id: string, patch: Partial<Omit<BookRecord, 'id'>>): Promise<BookRecord | undefined> {
    const tx = this.db.transaction('books', 'readwrite');
    const book = await tx.store.get(id);
    if (!book) return undefined;
    const next = { ...book, ...patch, updatedAt: this.now() };
    await tx.store.put(next);
    await tx.done;
    this.emit('books');
    return next;
  }

  /** Remove a book and everything that points at it on this device. Progress and bookmarks stay (they are synced, by hash). */
  async deleteBookRecords(id: string): Promise<{ files: BookFileRecord[]; offline: OfflineFileRecord | undefined }> {
    const tx = this.db.transaction(['books', 'bookFiles', 'offlineFiles'], 'readwrite');
    const files = await tx.objectStore('bookFiles').index('bookId').getAll(id);
    for (const f of files) await tx.objectStore('bookFiles').delete(f.id);
    const offline = await tx.objectStore('offlineFiles').index('bookId').get(id);
    if (offline) await tx.objectStore('offlineFiles').delete(offline.id);
    await tx.objectStore('books').delete(id);
    await tx.done;
    this.emit('books', 'offline');
    return { files, offline };
  }

  /** Create a book together with the file record that locates it. */
  async addBookWithFile(book: BookRecord, file: BookFileRecord): Promise<void> {
    const tx = this.db.transaction(['books', 'bookFiles'], 'readwrite');
    await tx.objectStore('books').put(book);
    await tx.objectStore('bookFiles').put(file);
    await tx.done;
    this.emit('books');
  }

  /**
   * Fold book `fromId` into book `intoId` (same SHA-512 discovered later):
   * files and the offline copy move over, the duplicate record is removed.
   */
  async mergeBooks(
    fromId: string,
    intoId: string,
  ): Promise<{ book: BookRecord; droppedOffline: OfflineFileRecord | null } | undefined> {
    if (fromId === intoId) {
      const book = await this.getBook(intoId);
      return book && { book, droppedOffline: null };
    }
    const tx = this.db.transaction(['books', 'bookFiles', 'offlineFiles'], 'readwrite');
    const books = tx.objectStore('books');
    const from = await books.get(fromId);
    const into = await books.get(intoId);
    if (!into) {
      tx.abort();
      return undefined;
    }
    for (const f of await tx.objectStore('bookFiles').index('bookId').getAll(fromId)) {
      await tx.objectStore('bookFiles').put({ ...f, bookId: intoId });
    }
    const fromOffline = await tx.objectStore('offlineFiles').index('bookId').get(fromId);
    const intoOffline = await tx.objectStore('offlineFiles').index('bookId').get(intoId);
    let dropped: OfflineFileRecord | undefined;
    if (fromOffline) {
      if (intoOffline) {
        dropped = fromOffline;
        await tx.objectStore('offlineFiles').delete(fromOffline.id);
      } else {
        await tx.objectStore('offlineFiles').put({ ...fromOffline, bookId: intoId });
      }
    }
    const merged: BookRecord = {
      ...into,
      customGroup: into.customGroup ?? from?.customGroup ?? null,
      lastReadAt: Math.max(into.lastReadAt ?? 0, from?.lastReadAt ?? 0) || null,
      addedAt: Math.min(into.addedAt, from?.addedAt ?? into.addedAt),
      updatedAt: this.now(),
    };
    await books.put(merged);
    await books.delete(fromId);
    await tx.done;
    this.emit('books', 'offline');
    // The caller deletes the file of a redundant offline copy.
    return { book: merged, droppedOffline: dropped ?? null };
  }

  // --- book files -------------------------------------------------------------

  listBookFiles(bookId: string): Promise<BookFileRecord[]> {
    return this.db.getAllFromIndex('bookFiles', 'bookId', bookId);
  }

  listAllBookFiles(): Promise<BookFileRecord[]> {
    return this.db.getAll('bookFiles');
  }

  listFilesBySource(sourceId: string): Promise<BookFileRecord[]> {
    return this.db.getAllFromIndex('bookFiles', 'sourceId', sourceId);
  }

  getFileByPath(sourceId: string, path: string): Promise<BookFileRecord | undefined> {
    return this.db.getFromIndex('bookFiles', 'sourcePath', [sourceId, path]);
  }

  async putBookFile(file: BookFileRecord): Promise<void> {
    await this.db.put('bookFiles', file);
    this.emit('books');
  }

  async deleteBookFile(id: string): Promise<void> {
    await this.db.delete('bookFiles', id);
    this.emit('books');
  }

  // --- offline copies ---------------------------------------------------------

  getOffline(bookId: string): Promise<OfflineFileRecord | undefined> {
    return this.db.getFromIndex('offlineFiles', 'bookId', bookId);
  }

  listOffline(): Promise<OfflineFileRecord[]> {
    return this.db.getAll('offlineFiles');
  }

  async putOffline(rec: OfflineFileRecord): Promise<void> {
    await this.db.put('offlineFiles', rec);
    this.emit('offline');
  }

  async deleteOffline(id: string): Promise<void> {
    await this.db.delete('offlineFiles', id);
    this.emit('offline');
  }

  async touchOffline(bookId: string): Promise<void> {
    const tx = this.db.transaction('offlineFiles', 'readwrite');
    const rec = await tx.store.index('bookId').get(bookId);
    if (rec) await tx.store.put({ ...rec, lastOpenedAt: this.now() });
    await tx.done;
  }

  // --- change log ---------------------------------------------------------------

  private async record(
    tx: { objectStore(name: 'changes'): { put(v: ChangeRecord): Promise<unknown> } },
    kind: ChangeKind,
    ref: string,
    updatedAt: number,
  ): Promise<void> {
    await tx.objectStore('changes').put({ key: changeKey(kind, ref), kind, ref, updatedAt });
  }

  /** Local changes not yet acknowledged by the sync engine, oldest first. */
  listChanges(): Promise<ChangeRecord[]> {
    return this.db.getAllFromIndex('changes', 'updatedAt');
  }

  /**
   * Remove pushed changes. An entry is only removed if it was not written
   * again after it was listed (its updatedAt is unchanged).
   */
  async ackChanges(pushed: ChangeRecord[]): Promise<void> {
    const tx = this.db.transaction('changes', 'readwrite');
    for (const c of pushed) {
      const cur = await tx.store.get(c.key);
      if (cur && cur.updatedAt === c.updatedAt) await tx.store.delete(c.key);
    }
    await tx.done;
  }

  // --- progress -----------------------------------------------------------------

  getProgress(sha512: string): Promise<Progress | undefined> {
    return this.db.get('progress', sha512);
  }

  listProgress(): Promise<Progress[]> {
    return this.db.getAll('progress');
  }

  /** Save the reading position of a book and bump the book's lastReadAt. */
  async saveProgress(sha512: string, locator: Locator, bookId?: string): Promise<Progress> {
    const { deviceId } = await this.meta();
    const t = this.now();
    const progress: Progress = { sha512, locator, percent: locatorPercent(locator), updatedAt: t, deviceId };
    const tx = this.db.transaction(['progress', 'changes', 'books'], 'readwrite');
    await tx.objectStore('progress').put(progress);
    await this.record(tx, 'progress', sha512, t);
    if (bookId) {
      const book = await tx.objectStore('books').get(bookId);
      if (book) await tx.objectStore('books').put({ ...book, lastReadAt: t });
    }
    await tx.done;
    this.emit('progress', 'books');
    return progress;
  }

  /** Merge a progress record that came from another device (last write wins). Does not record a change. */
  async applyRemoteProgress(remote: Progress): Promise<Progress> {
    const tx = this.db.transaction(['progress', 'books'], 'readwrite');
    const local = await tx.objectStore('progress').get(remote.sha512);
    const winner = local ? mergeProgress(local, remote) : remote;
    if (winner === remote) {
      await tx.objectStore('progress').put(remote);
      const book = await tx.objectStore('books').index('sha512').get(remote.sha512);
      if (book && (book.lastReadAt ?? 0) < remote.updatedAt) {
        await tx.objectStore('books').put({ ...book, lastReadAt: remote.updatedAt });
      }
    }
    await tx.done;
    this.emit('progress', 'books');
    return winner;
  }

  // --- EPUB page counts (device-only cache) -----------------------------------------

  /** Page counts of a book's chapters for one layout, or null if never counted. */
  async getPageCounts(sha512: string, layout: string): Promise<number[] | null> {
    return (await this.db.get('pageCounts', `${sha512}:${layout}`))?.counts ?? null;
  }

  /** Remember page counts for one layout, keeping the few most recent layouts of the book. */
  async savePageCounts(sha512: string, layout: string, counts: number[], keep = 4): Promise<void> {
    const tx = this.db.transaction('pageCounts', 'readwrite');
    await tx.store.put({ id: `${sha512}:${layout}`, sha512, counts, usedAt: this.now() });
    const all = await tx.store.index('sha512').getAll(sha512);
    all.sort((a, b) => b.usedAt - a.usedAt);
    for (const old of all.slice(keep)) await tx.store.delete(old.id);
    await tx.done;
  }

  // --- bookmarks ----------------------------------------------------------------

  async listBookmarks(sha512: string, includeDeleted = false): Promise<Bookmark[]> {
    const all = await this.db.getAllFromIndex('bookmarks', 'sha512', sha512);
    return all.filter((b) => includeDeleted || !b.deleted).sort((a, b) => locatorPercent(a.locator) - locatorPercent(b.locator));
  }

  async addBookmark(sha512: string, locator: Locator, label: string, note = ''): Promise<Bookmark> {
    const t = this.now();
    const bm: Bookmark = { id: uuidv7(t), sha512, locator, label, note, createdAt: t, updatedAt: t, deleted: false };
    const tx = this.db.transaction(['bookmarks', 'changes'], 'readwrite');
    await tx.objectStore('bookmarks').put(bm);
    await this.record(tx, 'bookmark', bm.id, t);
    await tx.done;
    this.emit('bookmarks');
    return bm;
  }

  async updateBookmark(id: string, patch: Partial<Pick<Bookmark, 'label' | 'note' | 'deleted'>>): Promise<Bookmark | undefined> {
    const t = this.now();
    const tx = this.db.transaction(['bookmarks', 'changes'], 'readwrite');
    const bm = await tx.objectStore('bookmarks').get(id);
    if (!bm) return undefined;
    const next = { ...bm, ...patch, updatedAt: t };
    await tx.objectStore('bookmarks').put(next);
    await this.record(tx, 'bookmark', id, t);
    await tx.done;
    this.emit('bookmarks');
    return next;
  }

  /** Soft delete, so the deletion syncs. */
  deleteBookmark(id: string): Promise<Bookmark | undefined> {
    return this.updateBookmark(id, { deleted: true });
  }

  async applyRemoteBookmark(remote: Bookmark): Promise<Bookmark> {
    const tx = this.db.transaction('bookmarks', 'readwrite');
    const local = await tx.store.get(remote.id);
    const winner = local ? mergeBookmark(local, remote) : remote;
    if (winner === remote) await tx.store.put(remote);
    await tx.done;
    this.emit('bookmarks');
    return winner;
  }

  // --- libraries ----------------------------------------------------------------

  async listLibraries(includeDeleted = false): Promise<Library[]> {
    const all = await this.db.getAll('libraries');
    return all.filter((l) => includeDeleted || !l.deleted).sort((a, b) => a.createdAt - b.createdAt);
  }

  getLibrary(id: string): Promise<Library | undefined> {
    return this.db.get('libraries', id);
  }

  /** The built-in library and local source never sync: they only exist on this device. */
  async isDeviceOnlyLibrary(id: string): Promise<boolean> {
    return (await this.meta()).localLibraryId === id;
  }

  /** `id` lets a feature use a well-known id (e.g. a server's id) so devices create the same record. */
  async createLibrary(name: string, sources: LibrarySourceRef[] = [], id?: string): Promise<Library> {
    const t = this.now();
    const lib: Library = { id: id ?? uuidv7(t), name, sources, createdAt: t, updatedAt: t, deleted: false };
    await this.putLibrary(lib);
    return lib;
  }

  async updateLibrary(id: string, patch: Partial<Pick<Library, 'name' | 'sources' | 'deleted'>>): Promise<Library | undefined> {
    const lib = await this.getLibrary(id);
    if (!lib) return undefined;
    const next = { ...lib, ...patch, updatedAt: this.now() };
    await this.putLibrary(next);
    return next;
  }

  deleteLibrary(id: string): Promise<Library | undefined> {
    return this.updateLibrary(id, { deleted: true });
  }

  private async putLibrary(lib: Library): Promise<void> {
    const deviceOnly = await this.isDeviceOnlyLibrary(lib.id);
    const tx = this.db.transaction(['libraries', 'changes'], 'readwrite');
    await tx.objectStore('libraries').put(lib);
    if (!deviceOnly) await this.record(tx, 'library', lib.id, lib.updatedAt);
    await tx.done;
    this.emit('libraries');
  }

  // --- sources ------------------------------------------------------------------

  async listSources(includeDeleted = false): Promise<Source[]> {
    const all = await this.db.getAll('sources');
    return all.filter((s) => includeDeleted || !s.deleted).sort((a, b) => a.createdAt - b.createdAt);
  }

  getSource(id: string): Promise<Source | undefined> {
    return this.db.get('sources', id);
  }

  async createSource(name: string, config: SourceConfig, id?: string): Promise<Source> {
    const t = this.now();
    const src: Source = { id: id ?? uuidv7(t), name, config, createdAt: t, updatedAt: t, deleted: false };
    await this.putSource(src);
    return src;
  }

  async updateSource(id: string, patch: Partial<Pick<Source, 'name' | 'config' | 'deleted'>>): Promise<Source | undefined> {
    const src = await this.getSource(id);
    if (!src) return undefined;
    const next = { ...src, ...patch, updatedAt: this.now() };
    await this.putSource(next);
    return next;
  }

  deleteSource(id: string): Promise<Source | undefined> {
    return this.updateSource(id, { deleted: true });
  }

  private async putSource(src: Source): Promise<void> {
    const tx = this.db.transaction(['sources', 'changes'], 'readwrite');
    await tx.objectStore('sources').put(src);
    if (!DEVICE_ONLY_SOURCES.includes(src.config.kind)) await this.record(tx, 'source', src.id, src.updatedAt);
    await tx.done;
    this.emit('sources');
  }

  /** Merge a library/source that came from another device. */
  async applyRemoteConfig(type: 'library', value: Library): Promise<Library>;
  async applyRemoteConfig(type: 'source', value: Source): Promise<Source>;
  async applyRemoteConfig(type: 'library' | 'source', value: Library | Source): Promise<Library | Source> {
    const store = type === 'library' ? 'libraries' : 'sources';
    const tx = this.db.transaction(store, 'readwrite');
    const local = (await tx.store.get(value.id)) as Library | Source | undefined;
    const winner = local ? lww(local, value, (v) => JSON.stringify(v)) : value;
    if (winner === value) await tx.store.put(value as never);
    await tx.done;
    this.emit(store);
    return winner;
  }

  // --- settings -----------------------------------------------------------------

  async getSetting<K extends SettingsKey>(key: K): Promise<SettingsValues[K] | undefined> {
    return (await this.db.get('settings', key)) as SettingsValues[K] | undefined;
  }

  async setSetting<K extends SettingsKey>(key: K, value: SettingsValues[K]): Promise<void> {
    await this.db.put('settings', value, key);
    this.emit('settings');
  }

  /** Free-form key/value for extensions (e.g. sync state). Keys should be namespaced: `sync:cursor`. */
  async getValue<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('settings', key)) as T | undefined;
  }

  async setValue<T>(key: string, value: T): Promise<void> {
    await this.db.put('settings', value, key);
  }

  async getSyncedSettings(): Promise<SyncedSettings> {
    return withDefaults(DEFAULT_SYNCED_SETTINGS, await this.getSetting('synced'));
  }

  async saveSyncedSettings(value: SyncedSettings): Promise<void> {
    const t = this.now();
    const tx = this.db.transaction(['settings', 'changes'], 'readwrite');
    await tx.objectStore('settings').put(value, 'synced');
    await tx.objectStore('settings').put(t, 'syncedUpdatedAt');
    await this.record(tx, 'settings', 'synced', t);
    await tx.done;
    this.emit('settings');
  }

  /** Apply synced settings from another device if they are newer. */
  async applyRemoteSettings(value: SyncedSettings, updatedAt: number): Promise<boolean> {
    const tx = this.db.transaction('settings', 'readwrite');
    const localAt = ((await tx.store.get('syncedUpdatedAt')) as number | undefined) ?? 0;
    const newer = updatedAt > localAt;
    if (newer) {
      await tx.store.put(value, 'synced');
      await tx.store.put(updatedAt, 'syncedUpdatedAt');
    }
    await tx.done;
    if (newer) this.emit('settings');
    return newer;
  }

  async getDeviceSettings(): Promise<DeviceSettings> {
    return withDefaults(DEFAULT_DEVICE_SETTINGS, await this.getSetting('device'));
  }

  saveDeviceSettings(value: DeviceSettings): Promise<void> {
    return this.setSetting('device', value);
  }

  async getUiState(): Promise<UiState> {
    return withDefaults(DEFAULT_UI, await this.getSetting('ui'));
  }

  saveUiState(value: UiState): Promise<void> {
    return this.setSetting('ui', value);
  }

  // --- maintenance --------------------------------------------------------------

  /** Delete every record. The caller clears the file store. */
  async clearAll(): Promise<void> {
    const names = [...this.db.objectStoreNames];
    const tx = this.db.transaction(names, 'readwrite');
    await Promise.all(names.map((n) => tx.objectStore(n).clear()));
    await tx.done;
    this.metaCache = null;
    this.emit('books', 'progress', 'bookmarks', 'libraries', 'sources', 'settings', 'offline');
  }
}
