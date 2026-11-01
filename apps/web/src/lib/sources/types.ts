/**
 * Storage source drivers. A Source (core model) is the persisted config; a
 * SourceDriver is the live object that lists and reads files in it.
 *
 * To add a source kind (folder, WebDAV, Drive, Dropbox, Libraria server):
 * implement SourceDriver, then call registerSourceKind() with a
 * SourceKindDefinition from `src/lib/sources/<kind>.ts` and import that
 * module from `src/lib/sources/index.ts`.
 */
import type { Component } from 'svelte';
import type { Source, SourceConfig, SourceKind } from '@libraria/core';
import type { Repo } from '../db/repo';
import type { FileStore } from '../storage/opfs';

export interface SourceEntry {
  /** Path inside the source, '/'-separated, no leading slash. Stable: it is stored in bookFiles. */
  path: string;
  /** Display name (usually the last path segment). */
  name: string;
  isDir: boolean;
  size: number | null;
  /** Last modified, ms since epoch. */
  mtime: number | null;
  /** Server-provided change tag (WebDAV etag, Drive md5, Dropbox content_hash...). */
  etag: string | null;
  /** SHA-512 if the source already knows it (Libraria servers do). Saves hashing. */
  sha512?: string | null;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Bytes received so far and the total if known. */
  onProgress?: (loaded: number, total: number | null) => void;
}

export interface ListOptions {
  signal?: AbortSignal;
}

export interface SourceDescription {
  /** e.g. "This device", "WebDAV · nas.local". */
  title: string;
  detail?: string;
}

export interface SourceDriver {
  readonly source: Source;
  /**
   * Reads are local and cheap (OPFS, File System Access): opening a book
   * never makes an offline copy, and the file is never evicted.
   */
  readonly isLocal: boolean;
  /** Entries directly inside `path` ('' is the root). Folders have isDir. */
  list(path: string, opts?: ListOptions): AsyncIterable<SourceEntry>;
  /** Metadata for one path, or null if it does not exist. */
  stat?(path: string, opts?: ListOptions): Promise<SourceEntry | null>;
  /** The whole file. Remote drivers should honour signal and onProgress. */
  read(path: string, opts?: ReadOptions): Promise<Blob>;
  /**
   * Optional streaming read. When present it is preferred for downloads, so
   * the bytes go straight into OPFS instead of through a Blob in memory.
   */
  readStream?(path: string, opts?: ReadOptions): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }>;
  write?(path: string, data: Blob, opts?: ReadOptions): Promise<SourceEntry>;
  remove?(path: string): Promise<void>;
  describe(): SourceDescription;
  /** Release resources (open handles, timers). */
  close?(): void;
}

export interface DriverContext {
  repo: Repo;
  files: FileStore;
}

/** Props passed to a kind's setup component (the "Add source" form). */
export interface SourceSetupProps {
  /** Call with the finished config; the app creates the Source record. */
  onCreate: (name: string, config: SourceConfig) => void | Promise<void>;
  onCancel: () => void;
}

export interface SourceKindDefinition {
  kind: SourceKind;
  label: string;
  description: string;
  /** Never synced to other devices (local files, folder handles). */
  deviceOnly: boolean;
  /** False for kinds not built yet; the UI shows them as "coming soon". */
  implemented: boolean;
  /** Whether this browser can use the kind at all (e.g. File System Access). */
  isSupported(): boolean;
  createDriver(source: Source, ctx: DriverContext): SourceDriver;
  /** Form for adding a source of this kind. Omit for built-in kinds. */
  setup?: Component<SourceSetupProps>;
  /** Users can add sources of this kind from the UI. False for 'local'. */
  userCreatable: boolean;
}
