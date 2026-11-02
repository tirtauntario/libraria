import type { BookFormat } from './format';

/** Descriptive metadata shared by local and server books. */
export interface BookMeta {
  title: string;
  authors: string[];
  series?: string | null;
  seriesIndex?: number | null;
  description?: string | null;
  language?: string | null;
  publisher?: string | null;
  pageCount?: number | null;
}

/**
 * A reading position. Pages are 0-based.
 * EPUB uses spine index plus progression (0..1) inside that chapter, which
 * survives font and layout changes between devices. `percent` (0..1) is the
 * position in the whole book as the reader measured it (chapters weighted by
 * length); older records lack it and fall back to equal-weight chapters.
 */
export type Locator =
  | { type: 'page'; page: number; total: number }
  | { type: 'epub'; spine: number; progression: number; total: number; label?: string; percent?: number };

export function locatorPercent(loc: Locator): number {
  if (loc.type === 'page') return loc.total > 1 ? loc.page / (loc.total - 1) : 1;
  if (typeof loc.percent === 'number' && Number.isFinite(loc.percent)) return Math.min(1, Math.max(0, loc.percent));
  if (loc.total <= 0) return 0;
  return Math.min(1, (loc.spine + loc.progression) / loc.total);
}

/** Reading progress for one book, keyed by the book's SHA-512. */
export interface Progress {
  sha512: string;
  locator: Locator;
  percent: number;
  updatedAt: number;
  deviceId: string;
}

export interface Bookmark {
  id: string;
  sha512: string;
  locator: Locator;
  label: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Client configuration entities. These sync (encrypted) between devices.

export type SourceKind = 'local' | 'folder' | 'webdav' | 'gdrive' | 'dropbox' | 'libraria';

/** Sources whose data lives only on one device and must never sync. */
export const DEVICE_ONLY_SOURCES: readonly SourceKind[] = ['local', 'folder'];

export interface WebdavConfig {
  url: string;
  username: string;
  password: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
}

export interface GdriveConfig {
  clientId: string;
  rootFolderId: string;
  rootFolderName: string;
  tokens?: OAuthTokens | null;
}

export interface DropboxConfig {
  appKey: string;
  rootPath: string;
  tokens?: OAuthTokens | null;
}

export interface LibrariaConfig {
  /** Server's own id from /api/v1/info. */
  serverId: string;
  url: string;
  username: string;
  token: string;
  role: Role;
}

export type SourceConfig =
  | { kind: 'local' }
  /** `handleId` keys the FileSystemDirectoryHandle stored on this device only. */
  | { kind: 'folder'; name: string; handleId?: string }
  | ({ kind: 'webdav' } & WebdavConfig)
  | ({ kind: 'gdrive' } & GdriveConfig)
  | ({ kind: 'dropbox' } & DropboxConfig)
  | ({ kind: 'libraria' } & LibrariaConfig);

export interface Source {
  id: string;
  name: string;
  config: SourceConfig;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export interface LibrarySourceRef {
  sourceId: string;
  /** Folder inside the source, '' for the root. */
  path: string;
  /** Display name of `path` when the path is made of ids (Google Drive). */
  label?: string;
}

export interface Library {
  id: string;
  name: string;
  sources: LibrarySourceRef[];
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Server-side roles and settings.

export type Role = 'owner' | 'curator' | 'member';
export type UserStatus = 'pending' | 'active' | 'rejected' | 'disabled';
export type Visibility = 'public' | 'private';
export type AnonymousAccess = 'none' | 'browse' | 'read';
export type SubmissionStatus = 'uploading' | 'pending' | 'approved' | 'rejected';

export function canManageBooks(role: Role | null | undefined): boolean {
  return role === 'owner' || role === 'curator';
}

export interface LibrarySettings {
  name: string;
  description: string;
  visibility: Visibility;
  anonymousAccess: AnonymousAccess;
  maxUploadBytes: number;
  memberQuotaBytes: number;
  maxPendingPerMember: number;
  membersCanSubmit: boolean;
  allowedFormats: BookFormat[];
  inviteExpiryDays: number;
  invitesSkipApproval: boolean;
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  name: 'Libraria',
  description: '',
  visibility: 'private',
  anonymousAccess: 'none',
  maxUploadBytes: 500 * 1024 * 1024,
  memberQuotaBytes: 2 * 1024 * 1024 * 1024,
  maxPendingPerMember: 20,
  membersCanSubmit: true,
  allowedFormats: ['cbz', 'cbr', 'epub', 'pdf'],
  inviteExpiryDays: 7,
  invitesSkipApproval: true,
};
