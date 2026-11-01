/**
 * End-to-end encrypted sync with the sync-home server.
 *
 * One run:
 * 1. Check the keys on the server still match ours (reset elsewhere → stop).
 * 2. Pull records since the last cursor (paged), decrypt with the Keyring,
 *    apply through `repo.applyRemote*` (never recorded as local changes).
 * 3. Push the outbox (`repo.listChanges()`): load the current value,
 *    drop device-only data, encrypt, send with the rev it is based on.
 *    Conflicts come back with the server's version: decrypt, merge with the
 *    core rules, apply or re-push on the new rev. Only what the server took
 *    (or what lost to a newer remote value) is acknowledged.
 *
 * The server sees kind, ref = HMAC(logical key), rev, deleted, ciphertext.
 */
import {
  DEVICE_ONLY_SOURCES,
  logicalKey,
  lww,
  MAX_SYNC_PUSH,
  mergeBookmark,
  mergeProgress,
  payloadDeleted,
  payloadUpdatedAt,
  type Bookmark,
  type ConfigPayload,
  type Keyring,
  type Library,
  type Source,
  type SyncPayload,
  type SyncPushItem,
  type SyncRecordDto,
} from '@libraria/core';
import type { Repo } from '../db/repo';
import type { ChangeRecord } from '../db/schema';
import type { ServerApi } from '../server/api';
import { SYNC_CURSOR, SYNC_REVS, type StoredSyncKey } from './keys';

export interface SyncReport {
  pulled: number;
  applied: number;
  pushed: number;
  conflicts: number;
  /** Records that could not be decrypted or parsed. */
  skipped: number;
  at: number;
}

export class SyncKeysChangedError extends Error {
  constructor(readonly reason: 'disabled' | 'replaced') {
    super(
      reason === 'disabled'
        ? 'Sync was turned off for this account on another device.'
        : 'Sync was reset on another device. Set it up again on this device.',
    );
    this.name = 'SyncKeysChangedError';
  }
}

export interface EngineHooks {
  /** A remote config change was applied (e.g. a new or deleted source). */
  onApplied?: (payload: SyncPayload) => void | Promise<void>;
}

const PULL_PAGE = 500;
const MAX_CONFLICT_ROUNDS = 4;

interface Prepared {
  change: ChangeRecord;
  payload: SyncPayload;
  ref: string;
  baseRev: number | null;
}

export class SyncEngine {
  constructor(
    private readonly repo: Repo,
    private readonly api: ServerApi,
    private readonly keyring: Keyring,
    private readonly key: Pick<StoredSyncKey, 'wrappedRecoveryKey'>,
    private readonly hooks: EngineHooks = {},
  ) {}

  async run(): Promise<SyncReport> {
    const report: SyncReport = { pulled: 0, applied: 0, pushed: 0, conflicts: 0, skipped: 0, at: Date.now() };
    await this.checkKeys();
    const revs = (await this.repo.getValue<Record<string, number>>(SYNC_REVS)) ?? {};
    const remoteWon = new Map<string, number>();
    try {
      await this.pull(revs, remoteWon, report);
      await this.push(revs, remoteWon, report);
    } finally {
      await this.repo.setValue(SYNC_REVS, revs);
    }
    report.at = Date.now();
    return report;
  }

  private async checkKeys(): Promise<void> {
    const keys = await this.api.getSyncKeys();
    if (!keys) throw new SyncKeysChangedError('disabled');
    if (keys.wrappedRecoveryKey !== this.key.wrappedRecoveryKey) throw new SyncKeysChangedError('replaced');
  }

  // --- pull --------------------------------------------------------------------

  private async pull(revs: Record<string, number>, remoteWon: Map<string, number>, report: SyncReport): Promise<void> {
    let cursor = (await this.repo.getValue<number>(SYNC_CURSOR)) ?? 0;
    for (;;) {
      const page = await this.api.pullSync(cursor, PULL_PAGE);
      for (const rec of page.records) {
        report.pulled++;
        revs[rec.ref] = rec.rev;
        const payload = await this.decrypt(rec);
        if (!payload) {
          report.skipped++;
          continue;
        }
        if (await this.apply(payload)) {
          report.applied++;
          remoteWon.set(logicalKey(payload), payloadUpdatedAt(payload));
        }
      }
      cursor = Math.max(cursor, page.rev);
      await this.repo.setValue(SYNC_CURSOR, cursor);
      if (!page.more || page.records.length === 0) break;
    }
  }

  private async decrypt(rec: SyncRecordDto): Promise<SyncPayload | null> {
    try {
      const payload = await this.keyring.decrypt<SyncPayload>(rec.kind, rec.ref, rec.ciphertext);
      if (!payload || payload.kind !== rec.kind || !payload.value) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** Apply a remote payload. True if the remote value is now the local one. */
  private async apply(payload: SyncPayload): Promise<boolean> {
    let won = false;
    switch (payload.kind) {
      case 'progress':
        won = (await this.repo.applyRemoteProgress(payload.value)) === payload.value;
        break;
      case 'bookmark':
        won = (await this.repo.applyRemoteBookmark(payload.value)) === payload.value;
        break;
      case 'config':
        won = await this.applyConfig(payload.value);
        break;
    }
    if (won) await this.hooks.onApplied?.(payload);
    return won;
  }

  private async applyConfig(c: ConfigPayload): Promise<boolean> {
    if (c.type === 'settings') return this.repo.applyRemoteSettings(c.value, c.updatedAt);
    if (c.type === 'source') {
      // Device-only sources never sync; ignore one if a buggy client sent it.
      if (DEVICE_ONLY_SOURCES.includes(c.value.config.kind)) return false;
      const value: Source = { ...c.value, deleted: c.deleted || c.value.deleted };
      return (await this.repo.applyRemoteConfig('source', value)) === value;
    }
    const meta = await this.repo.meta();
    if (c.value.id === meta.localLibraryId) return false;
    // Keep this device's own folders/imports in a synced library.
    const local = await this.repo.getLibrary(c.value.id);
    const deviceOnly = await this.deviceOnlySourceIds();
    const keep = (local?.sources ?? []).filter((r) => deviceOnly.has(r.sourceId));
    const value: Library = {
      ...c.value,
      deleted: c.deleted || c.value.deleted,
      sources: [...c.value.sources.filter((r) => !deviceOnly.has(r.sourceId)), ...keep],
    };
    return (await this.repo.applyRemoteConfig('library', value)) === value;
  }

  private async deviceOnlySourceIds(): Promise<Set<string>> {
    const all = await this.repo.listSources(true);
    return new Set(all.filter((s) => DEVICE_ONLY_SOURCES.includes(s.config.kind)).map((s) => s.id));
  }

  // --- push --------------------------------------------------------------------

  /** The current value behind an outbox entry, or null if it must not (or cannot) sync. */
  async payloadFor(change: ChangeRecord): Promise<SyncPayload | null> {
    switch (change.kind) {
      case 'progress': {
        const value = await this.repo.getProgress(change.ref);
        return value ? { kind: 'progress', value } : null;
      }
      case 'bookmark': {
        const value = (await this.repo.db.get('bookmarks', change.ref)) as Bookmark | undefined;
        return value ? { kind: 'bookmark', value } : null;
      }
      case 'library': {
        const lib = await this.repo.getLibrary(change.ref);
        if (!lib || (await this.repo.isDeviceOnlyLibrary(lib.id))) return null;
        const deviceOnly = await this.deviceOnlySourceIds();
        const value: Library = { ...lib, sources: lib.sources.filter((r) => !deviceOnly.has(r.sourceId)) };
        return { kind: 'config', value: { type: 'library', id: lib.id, updatedAt: lib.updatedAt, deleted: lib.deleted, value } };
      }
      case 'source': {
        const src = await this.repo.getSource(change.ref);
        if (!src || DEVICE_ONLY_SOURCES.includes(src.config.kind)) return null;
        return { kind: 'config', value: { type: 'source', id: src.id, updatedAt: src.updatedAt, deleted: src.deleted, value: src } };
      }
      case 'settings': {
        const value = await this.repo.getSyncedSettings();
        const updatedAt = (await this.repo.getSetting('syncedUpdatedAt')) ?? 0;
        return { kind: 'config', value: { type: 'settings', id: 'settings', updatedAt, deleted: false, value } };
      }
    }
  }

  private async push(revs: Record<string, number>, remoteWon: Map<string, number>, report: SyncReport): Promise<void> {
    const changes = await this.repo.listChanges();
    const ack: ChangeRecord[] = [];
    let queue: Prepared[] = [];
    for (const change of changes) {
      const payload = await this.payloadFor(change);
      // Nothing to send (deleted record, device-only) or a newer remote value already replaced it.
      if (!payload || remoteWon.get(change.key) === payloadUpdatedAt(payload)) {
        ack.push(change);
        continue;
      }
      const ref = await this.keyring.ref(logicalKey(payload));
      queue.push({ change, payload, ref, baseRev: revs[ref] ?? null });
    }

    for (let round = 0; queue.length && round < MAX_CONFLICT_ROUNDS; round++) {
      const retry: Prepared[] = [];
      for (let i = 0; i < queue.length; i += MAX_SYNC_PUSH) {
        const batch = queue.slice(i, i + MAX_SYNC_PUSH);
        const items: SyncPushItem[] = await Promise.all(
          batch.map(async (p) => ({
            kind: p.payload.kind,
            ref: p.ref,
            baseRev: p.baseRev,
            deleted: payloadDeleted(p.payload),
            ciphertext: await this.keyring.encrypt(p.payload.kind, p.ref, p.payload),
          })),
        );
        const res = await this.api.pushSync(items);
        const byRef = new Map(batch.map((p) => [p.ref, p]));
        for (const a of res.applied) {
          revs[a.ref] = a.rev;
          const p = byRef.get(a.ref);
          if (p) {
            ack.push(p.change);
            report.pushed++;
          }
        }
        for (const rec of res.conflicts) {
          report.conflicts++;
          const p = byRef.get(rec.ref);
          if (!p) continue;
          revs[rec.ref] = rec.rev;
          const remote = await this.decrypt(rec);
          if (!remote) {
            // Unreadable server copy: ours replaces it.
            retry.push({ ...p, baseRev: rec.rev });
            continue;
          }
          const winner = merge(p.payload, remote);
          if (winner === remote) {
            await this.apply(remote);
            ack.push(p.change);
          } else {
            retry.push({ ...p, payload: winner, baseRev: rec.rev });
          }
        }
      }
      queue = retry;
    }
    await this.repo.ackChanges(ack);
  }
}

/** Core merge rules, per kind. Returns one of the two arguments. */
export function merge(local: SyncPayload, remote: SyncPayload): SyncPayload {
  if (local.kind === 'progress' && remote.kind === 'progress') {
    return mergeProgress(local.value, remote.value) === local.value ? local : remote;
  }
  if (local.kind === 'bookmark' && remote.kind === 'bookmark') {
    return mergeBookmark(local.value, remote.value) === local.value ? local : remote;
  }
  if (local.kind === 'config' && remote.kind === 'config') {
    return lww(local.value, remote.value, (v) => JSON.stringify(v)) === local.value ? local : remote;
  }
  return remote;
}
