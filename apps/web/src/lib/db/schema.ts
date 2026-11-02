/**
 * IndexedDB schema for the web client.
 *
 * Primary keys are UUIDv7 everywhere, except where a natural key is the
 * identity of the record:
 * - progress: keyed by the book's SHA-512. There is exactly one progress
 *   record per book across all devices (last-write-wins), so the hash *is*
 *   the identity and a surrogate id would only add a lookup.
 * - settings: singleton rows keyed by name ('synced', 'device', 'meta', ...).
 * - changes: keyed by the sync logical key (`progress:<sha>`, `bookmark:<id>`,
 *   `config:library:<id>`), so repeated writes to one record coalesce.
 * - fileBlobs: keyed by the file-store name; it mirrors OPFS paths.
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type {
  BookFormat,
  BookMeta,
  Bookmark,
  DeviceSettings,
  Library,
  Progress,
  Source,
  SyncedSettings,
} from '@libraria/core';

export const DB_NAME = 'libraria';

/** A book known to this device. UUIDs are local; sha512 is the global identity. */
export interface BookRecord extends BookMeta {
  id: string;
  /** Null until the file has been downloaded/opened once and hashed. */
  sha512: string | null;
  format: BookFormat;
  fileSize: number;
  /** JPEG thumbnail. */
  cover: Blob | null;
  customGroup: string | null;
  /** 'file' once metadata came from the file itself; 'filename' for scan placeholders. */
  metaSource: 'file' | 'filename';
  /** The user edited title/series by hand; never overwrite with extracted metadata. */
  metaEdited: boolean;
  addedAt: number;
  updatedAt: number;
  lastReadAt: number | null;
}

/** Where a book's file lives in a source. One book can live in several places. */
export interface BookFileRecord {
  id: string;
  bookId: string;
  sourceId: string;
  /** Path inside the source, '/'-separated, no leading slash. */
  path: string;
  size: number | null;
  mtime: number | null;
  etag: string | null;
  addedAt: number;
  /** Human-readable path when `path` is made of ids (Google Drive). */
  displayPath?: string | null;
  /**
   * The last scan did not find the file. The record stays so the book stays
   * in its libraries (with its offline copy, if any) instead of vanishing.
   */
  missing?: boolean;
}

/** A downloaded copy of a remote book, kept in the file store (OPFS). */
export interface OfflineFileRecord {
  id: string;
  bookId: string;
  /** Name in the file store, e.g. `offline/<id>.cbz`. */
  opfsName: string;
  size: number;
  pinned: boolean;
  createdAt: number;
  lastOpenedAt: number;
}

export type ChangeKind = 'progress' | 'bookmark' | 'library' | 'source' | 'settings';

/** Outbox entry for the sync engine. One per logical record; newest write wins. */
export interface ChangeRecord {
  /** Sync logical key, see core `logicalKey`. */
  key: string;
  kind: ChangeKind;
  /** Id of the record in its own store (sha512 for progress, 'synced' for settings). */
  ref: string;
  updatedAt: number;
}

/**
 * Page counts of an EPUB's chapters for one layout (font, size, margins, frame
 * size...). Device-only, never synced: another screen paginates differently.
 */
export interface PageCountRecord {
  /** `<sha512>:<layout key>` */
  id: string;
  sha512: string;
  counts: number[];
  usedAt: number;
}

/** A book being sent to a Libraria server (persisted so it survives reloads). */
export interface UploadJobRecord {
  id: string;
  /** The `libraria` source (server) it goes to. */
  sourceId: string;
  bookId: string;
  sha512: string;
  format: BookFormat;
  fileSize: number;
  title: string;
  submissionId: string | null;
  /** Bytes the server confirmed. */
  offset: number;
  status: 'queued' | 'uploading' | 'pending' | 'approved' | 'exists' | 'rejected' | 'failed';
  error: string | null;
  /** Server book id once approved (or when it already existed). */
  serverBookId: string | null;
  coverDone: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceMeta {
  deviceId: string;
  localSourceId: string;
  localLibraryId: string;
  createdAt: number;
}

export interface UiState {
  collapsedGroups: string[];
}

export interface SettingsValues {
  synced: SyncedSettings;
  syncedUpdatedAt: number;
  device: DeviceSettings;
  meta: DeviceMeta;
  ui: UiState;
}
export type SettingsKey = keyof SettingsValues;

export interface LibrariaDB extends DBSchema {
  books: {
    key: string;
    value: BookRecord;
    indexes: { sha512: string; addedAt: number; lastReadAt: number };
  };
  bookFiles: {
    key: string;
    value: BookFileRecord;
    indexes: { bookId: string; sourcePath: [string, string]; sourceId: string };
  };
  offlineFiles: {
    key: string;
    value: OfflineFileRecord;
    indexes: { bookId: string; lastOpenedAt: number };
  };
  /** IndexedDB fallback for the file store when OPFS is unavailable. */
  fileBlobs: {
    key: string;
    value: Blob;
  };
  progress: {
    key: string;
    value: Progress;
    indexes: { updatedAt: number };
  };
  bookmarks: {
    key: string;
    value: Bookmark;
    indexes: { sha512: string };
  };
  libraries: {
    key: string;
    value: Library;
  };
  sources: {
    key: string;
    value: Source;
  };
  settings: {
    key: string;
    value: unknown;
  };
  changes: {
    key: string;
    value: ChangeRecord;
    indexes: { updatedAt: number };
  };
  /** Since v2: queued and running uploads to Libraria servers. */
  uploads: {
    key: string;
    value: UploadJobRecord;
    indexes: { bookId: string; sourceId: string };
  };
  /** Since v3: EPUB page counts per layout (see PageCountRecord). */
  pageCounts: {
    key: string;
    value: PageCountRecord;
    indexes: { sha512: string };
  };
}

export type Db = IDBPDatabase<LibrariaDB>;
export type UpgradeTx = IDBPTransaction<LibrariaDB, StoreNames<LibrariaDB>[], 'versionchange'>;

/**
 * Ordered migrations. Migration i upgrades the database from version i to
 * i + 1. Never edit a released migration; append a new one. Later features
 * (servers, sync state) add their stores here.
 */
export const MIGRATIONS: ((db: Db, tx: UpgradeTx) => void)[] = [
  // v1: initial schema
  (db) => {
    const books = db.createObjectStore('books', { keyPath: 'id' });
    // null sha512 is not a valid IndexedDB key, so placeholders are simply not indexed.
    books.createIndex('sha512', 'sha512', { unique: true });
    books.createIndex('addedAt', 'addedAt');
    books.createIndex('lastReadAt', 'lastReadAt');

    const files = db.createObjectStore('bookFiles', { keyPath: 'id' });
    files.createIndex('bookId', 'bookId');
    files.createIndex('sourceId', 'sourceId');
    files.createIndex('sourcePath', ['sourceId', 'path'], { unique: true });

    const offline = db.createObjectStore('offlineFiles', { keyPath: 'id' });
    offline.createIndex('bookId', 'bookId', { unique: true });
    offline.createIndex('lastOpenedAt', 'lastOpenedAt');

    db.createObjectStore('fileBlobs');

    const progress = db.createObjectStore('progress', { keyPath: 'sha512' });
    progress.createIndex('updatedAt', 'updatedAt');

    const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'id' });
    bookmarks.createIndex('sha512', 'sha512');

    db.createObjectStore('libraries', { keyPath: 'id' });
    db.createObjectStore('sources', { keyPath: 'id' });
    db.createObjectStore('settings');

    const changes = db.createObjectStore('changes', { keyPath: 'key' });
    changes.createIndex('updatedAt', 'updatedAt');
  },
  // v2: upload jobs for contributing books to Libraria servers
  (db) => {
    const uploads = db.createObjectStore('uploads', { keyPath: 'id' });
    uploads.createIndex('bookId', 'bookId');
    uploads.createIndex('sourceId', 'sourceId');
  },
  // v3: EPUB page counts per layout
  (db) => {
    const counts = db.createObjectStore('pageCounts', { keyPath: 'id' });
    counts.createIndex('sha512', 'sha512');
  },
];

export const DB_VERSION = MIGRATIONS.length;

export async function openLibrariaDb(name = DB_NAME): Promise<Db> {
  return openDB<LibrariaDB>(name, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      for (let v = oldVersion; v < DB_VERSION; v++) MIGRATIONS[v]!(db, tx);
    },
    blocking(_current, _next, event) {
      // A newer version of the app (another tab) wants to upgrade: step aside.
      (event.target as IDBDatabase).close();
      if (typeof location !== 'undefined') location.reload();
    },
  });
}
