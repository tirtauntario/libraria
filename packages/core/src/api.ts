/**
 * Libraria server HTTP API, version 1. Shared by server and client.
 *
 * All endpoints live under API_PREFIX. Authenticated requests send
 * `Authorization: Bearer <token>`. Errors return ApiError with a 4xx/5xx status.
 */
import type { BookFormat } from './format';
import type {
  AnonymousAccess,
  LibrarySettings,
  Role,
  SubmissionStatus,
  UserStatus,
  Visibility,
} from './models';
import type { KdfParams } from './crypto';

export const API_VERSION = 1;
export const API_PREFIX = '/api/v1';

export interface ApiError {
  error: string;
  message: string;
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'duplicate'
  | 'too_large'
  | 'quota_exceeded'
  | 'unsupported_format'
  | 'hash_mismatch'
  | 'rate_limited'
  | 'setup_required'
  | 'already_setup'
  | 'pending_approval'
  | 'internal';

// --- GET /info --------------------------------------------------------------

export interface ServerInfo {
  id: string;
  name: string;
  description: string;
  apiVersion: number;
  serverVersion: string;
  setupRequired: boolean;
  visibility: Visibility;
  anonymousAccess: AnonymousAccess;
  /** 'open': signups are active at once. 'approval': owner/curator must accept. */
  registration: 'open' | 'approval';
  membersCanSubmit: boolean;
  maxUploadBytes: number;
  allowedFormats: BookFormat[];
  capabilities: string[];
}

// --- Auth -------------------------------------------------------------------
// The client never sends the password. It derives master_key with Argon2id
// using the salt and KDF params from /auth/prelogin, then sends auth_hash.

export interface PreloginResponse {
  salt: string;
  kdf: KdfParams;
}

/** POST /setup — first run only. Requires the setup token printed on the console. */
export interface SetupRequest {
  setupToken: string;
  username: string;
  salt: string;
  kdf: KdfParams;
  authHash: string;
  libraryName: string;
  deviceName?: string;
}

/** POST /auth/register */
export interface RegisterRequest {
  username: string;
  salt: string;
  kdf: KdfParams;
  authHash: string;
  inviteToken?: string;
  deviceName?: string;
}

/** POST /auth/login */
export interface LoginRequest {
  username: string;
  authHash: string;
  deviceName?: string;
}

export interface UserDto {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: number;
}

/** token is absent when the account waits for approval. */
export interface AuthResponse {
  user: UserDto;
  token?: string;
}

/** POST /me/password */
export interface ChangePasswordRequest {
  currentAuthHash: string;
  salt: string;
  kdf: KdfParams;
  authHash: string;
  /** data_key re-wrapped with the new master key, if sync is set up. */
  wrappedDataKey?: string | null;
}

// --- Books ------------------------------------------------------------------

export interface BookDto {
  id: string;
  sha512: string;
  format: BookFormat;
  title: string;
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  pageCount: number | null;
  fileSize: number;
  hasCover: boolean;
  addedAt: number;
  updatedAt: number;
}

/** GET /books?cursor=&limit=&q= */
export interface BookListResponse {
  items: BookDto[];
  nextCursor: string | null;
}

/** PATCH /books/:id (owner, curator) */
export type BookUpdateRequest = Partial<
  Pick<BookDto, 'title' | 'authors' | 'series' | 'seriesIndex' | 'description' | 'language' | 'publisher'>
>;

/** GET /books/lookup?sha512= */
export interface BookLookupResponse {
  bookId: string | null;
  submissionId: string | null;
}

// GET /books/:id/file  — supports Range. Content-Type by format.
// GET /books/:id/cover — image, 404 if none.
// PUT /books/:id/cover — owner/curator/submitter; raw image body.

// --- Submissions (contributing books) ----------------------------------------

/** POST /submissions */
export interface SubmissionCreateRequest {
  sha512: string;
  format: BookFormat;
  fileSize: number;
  filename: string;
  title: string;
  authors: string[];
  series?: string | null;
  seriesIndex?: number | null;
  description?: string | null;
  language?: string | null;
  publisher?: string | null;
  pageCount?: number | null;
}

export interface SubmissionDto {
  id: string;
  userId: string;
  username: string;
  sha512: string;
  format: BookFormat;
  fileSize: number;
  filename: string;
  title: string;
  authors: string[];
  uploadOffset: number;
  status: SubmissionStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
  bookId: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

// HEAD  /submissions/:id/content -> header Upload-Offset
// PATCH /submissions/:id/content  headers Upload-Offset: <n>,
//        Content-Type: application/offset+octet-stream; body = next chunk.
//        Responds 204 with Upload-Offset. When offset reaches fileSize the
//        server verifies SHA-512 and format, then status becomes 'pending'
//        (or 'approved' for owner/curator uploads).
export const UPLOAD_OFFSET_HEADER = 'Upload-Offset';
export const UPLOAD_CONTENT_TYPE = 'application/offset+octet-stream';
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** GET /submissions?status=&mine=1 */
export interface SubmissionListResponse {
  items: SubmissionDto[];
}

/** POST /submissions/:id/review (owner, curator) */
export interface ReviewRequest {
  action: 'approve' | 'reject';
  note?: string;
}

// --- Users, invites, settings -------------------------------------------------

/** GET /users?status= (owner, curator) */
export interface UserListResponse {
  items: UserDto[];
}

/** PATCH /users/:id — status: owner/curator (approve/reject members); role: owner only. */
export interface UserUpdateRequest {
  status?: UserStatus;
  role?: Exclude<Role, 'owner'>;
}

export interface InviteDto {
  id: string;
  token?: string;
  createdBy: string;
  expiresAt: number;
  usedBy: string | null;
  createdAt: number;
}

/** GET /settings, PATCH /settings (owner) */
export type SettingsDto = LibrarySettings;

// --- Server sources (owner) ----------------------------------------------------

export interface ServerSourceDto {
  id: string;
  kind: 'disk';
  path: string;
  lastScanAt: number | null;
  bookCount: number;
}

/** POST /sources */
export interface ServerSourceCreateRequest {
  kind: 'disk';
  path: string;
}

/** GET /sources/roots — allowed roots from the server config file. */
export interface SourceRootsResponse {
  roots: string[];
}

export interface ScanResult {
  added: number;
  removed: number;
  unchanged: number;
  failed: number;
}

// --- Encrypted sync --------------------------------------------------------------

export type SyncKind = 'progress' | 'bookmark' | 'config';

/** What the server stores. ciphertext is opaque to the server. */
export interface SyncRecordDto {
  id: string;
  kind: SyncKind;
  /** HMAC of the logical key; unique per (user, kind). */
  ref: string;
  rev: number;
  deleted: boolean;
  ciphertext: string;
  updatedAt: number;
}

/** GET /sync/keys — 404 if sync was never set up. */
export interface SyncKeysDto {
  wrappedDataKey: string;
  wrappedRecoveryKey: string;
}

/** GET /sync/records?since=<rev>&limit= */
export interface SyncPullResponse {
  records: SyncRecordDto[];
  /** Highest rev included; pass as `since` next time. */
  rev: number;
  more: boolean;
}

export interface SyncPushItem {
  kind: SyncKind;
  ref: string;
  /** rev the client last saw for this ref, or null if it believes it is new. */
  baseRev: number | null;
  deleted: boolean;
  ciphertext: string;
}

/** POST /sync/records */
export interface SyncPushRequest {
  items: SyncPushItem[];
}

export interface SyncPushResponse {
  applied: { ref: string; kind: SyncKind; rev: number; id: string }[];
  /** Current server versions for items whose baseRev was stale. Merge and retry. */
  conflicts: SyncRecordDto[];
}

export const MAX_SYNC_PUSH = 500;
export const MAX_SYNC_CIPHERTEXT = 64 * 1024;
