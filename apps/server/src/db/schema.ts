/**
 * Table types for Kysely. Ids are UUIDv7 text, timestamps are integer ms,
 * booleans are 0/1 integers and JSON is stored as text, so the same schema
 * works on SQLite, MySQL and Postgres.
 */
import type { Insertable, Selectable } from 'kysely';
import type { BookFormat, Role, SubmissionStatus, SyncKind, UserStatus } from '@libraria/core';

export interface ServerTable {
  id: string;
  created_at: number;
}

export interface SettingsTable {
  id: string;
  data: string;
  updated_at: number;
}

export interface SetupTokenTable {
  id: string;
  token_hash: string;
  created_at: number;
}

export interface UserTable {
  id: string;
  username: string;
  /** scrypt$N$r$p$salt$hash over the client's auth_hash. */
  auth_hash: string;
  /** Client KDF salt (base64url), returned by prelogin. */
  salt: string;
  /** KdfParams JSON. */
  kdf: string;
  role: Role;
  status: UserStatus;
  /** Highest sync rev handed out to this user. */
  sync_rev: number;
  invite_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionTable {
  id: string;
  user_id: string;
  token_hash: string;
  device_name: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
}

export interface InviteTable {
  id: string;
  token_hash: string;
  created_by: string;
  expires_at: number;
  used_by: string | null;
  used_at: number | null;
  created_at: number;
}

export interface SourceTable {
  id: string;
  kind: 'disk';
  path: string;
  last_scan_at: number | null;
  created_at: number;
}

export interface BookTable {
  id: string;
  sha512: string;
  format: BookFormat;
  title: string;
  /** JSON string[]. */
  authors: string;
  series: string | null;
  series_index: number | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  page_count: number | null;
  file_size: number;
  cover_ext: string | null;
  /** Lowercased title + authors + series for `q` search. */
  search_text: string;
  submitted_by: string | null;
  added_at: number;
  updated_at: number;
  /** Set when removed by a curator but its file still sits in a disk source. */
  deleted_at: number | null;
}

export interface BookFileTable {
  id: string;
  book_id: string;
  /** null: the uploads store inside the data dir; path is then relative to it. */
  source_id: string | null;
  path: string;
  size: number;
  mtime: number;
  removed_at: number | null;
  created_at: number;
}

export interface SubmissionTable {
  id: string;
  user_id: string;
  sha512: string;
  format: BookFormat;
  file_size: number;
  filename: string;
  title: string;
  authors: string;
  series: string | null;
  series_index: number | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  page_count: number | null;
  upload_offset: number;
  status: SubmissionStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  book_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SyncKeyTable {
  id: string;
  user_id: string;
  wrapped_data_key: string;
  wrapped_recovery_key: string;
  updated_at: number;
}

export interface SyncRecordTable {
  id: string;
  user_id: string;
  kind: SyncKind;
  ref: string;
  rev: number;
  deleted: number;
  ciphertext: string;
  updated_at: number;
}

export interface Database {
  server: ServerTable;
  settings: SettingsTable;
  setup_tokens: SetupTokenTable;
  users: UserTable;
  sessions: SessionTable;
  invites: InviteTable;
  sources: SourceTable;
  books: BookTable;
  book_files: BookFileTable;
  submissions: SubmissionTable;
  sync_keys: SyncKeyTable;
  sync_records: SyncRecordTable;
}

export type UserRow = Selectable<UserTable>;
export type SessionRow = Selectable<SessionTable>;
export type BookRow = Selectable<BookTable>;
export type NewBook = Insertable<BookTable>;
export type BookFileRow = Selectable<BookFileTable>;
export type SubmissionRow = Selectable<SubmissionTable>;
export type SourceRow = Selectable<SourceTable>;
export type SyncRecordRow = Selectable<SyncRecordTable>;
export type InviteRow = Selectable<InviteTable>;
