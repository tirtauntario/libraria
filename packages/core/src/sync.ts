/**
 * Plaintext shapes inside encrypted sync records, and merge rules.
 * The server only sees kind, ref (HMAC of the logical key) and ciphertext.
 */
import type { Bookmark, Library, Progress, Source } from './models';
import type { SyncKind } from './api';
import type { SyncedSettings } from './settings';

/** Config records: libraries, sources, settings, and remembered servers. */
export type ConfigPayload =
  | { type: 'library'; id: string; updatedAt: number; deleted: boolean; value: Library }
  | { type: 'source'; id: string; updatedAt: number; deleted: boolean; value: Source }
  | { type: 'settings'; id: 'settings'; updatedAt: number; deleted: false; value: SyncedSettings };

export type SyncPayload =
  | { kind: 'progress'; value: Progress }
  | { kind: 'bookmark'; value: Bookmark }
  | { kind: 'config'; value: ConfigPayload };

export function logicalKey(payload: SyncPayload): string {
  switch (payload.kind) {
    case 'progress':
      return `progress:${payload.value.sha512}`;
    case 'bookmark':
      return `bookmark:${payload.value.id}`;
    case 'config':
      return `config:${payload.value.type}:${payload.value.id}`;
  }
}

export function payloadUpdatedAt(payload: SyncPayload): number {
  return payload.value.updatedAt;
}

export function payloadDeleted(payload: SyncPayload): boolean {
  if (payload.kind === 'progress') return false;
  return payload.value.deleted;
}

/**
 * Last-write-wins on updatedAt. Ties break on a stable string compare so
 * every device picks the same winner.
 */
export function lww<T extends { updatedAt: number }>(a: T, b: T, tieKey: (v: T) => string): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return tieKey(a) >= tieKey(b) ? a : b;
}

export function mergeProgress(a: Progress, b: Progress): Progress {
  return lww(a, b, (p) => p.deviceId);
}

export function mergeBookmark(a: Bookmark, b: Bookmark): Bookmark {
  return lww(a, b, (m) => JSON.stringify(m));
}

export function mergePayload(a: SyncPayload, b: SyncPayload): SyncPayload {
  if (a.kind !== b.kind) throw new Error('Cannot merge different kinds');
  return lww(
    { updatedAt: payloadUpdatedAt(a), p: a },
    { updatedAt: payloadUpdatedAt(b), p: b },
    (x) => JSON.stringify(x.p),
  ).p;
}

export function kindOf(payload: SyncPayload): SyncKind {
  return payload.kind;
}
