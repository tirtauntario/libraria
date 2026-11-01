/**
 * Runs the sync engine for the UI: setup, triggers and status.
 *
 * Triggers: app start, local changes (debounced), coming online, an
 * interval while the app is visible, and "Sync now". Automatic runs respect
 * the device setting `autoSync`.
 */
import type { SyncKeysDto, SyncPayload } from '@libraria/core';
import { isOnline } from '../net.svelte';
import { describeError, ServerError } from '../server/api';
import { apiFor, getServer, patchServerState, type LibrariaSource } from '../server/servers';
import type { Services } from '../services';
import { SyncEngine, SyncKeysChangedError, type SyncReport } from './engine';
import {
  forgetSyncKey,
  keyringOf,
  loadSyncKey,
  saveSyncKey,
  setupOrUnlock,
  storedKey,
  SYNC_CURSOR,
  SYNC_REVS,
  SYNC_STATUS,
  unlockWithRecovery,
  type KeySetup,
  type StoredSyncKey,
} from './keys';
import { requeueAll } from './outbox';

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out' | 'reset';

interface StoredStatus {
  lastSyncAt: number;
  lastError: string | null;
  lastReport: SyncReport | null;
}

const DEBOUNCE_MS = 3000;
const INTERVAL_MS = 2 * 60_000;
const SYNCED_TOPICS = ['progress', 'bookmarks', 'libraries', 'sources', 'settings'] as const;

export interface ControllerHooks {
  onApplied?: (payload: SyncPayload, s: Services) => void | Promise<void>;
}

class SyncController {
  phase = $state<SyncPhase>('off');
  home = $state<{ sourceId: string; name: string; username: string } | null>(null);
  lastSyncAt = $state(0);
  lastError = $state<string | null>(null);
  lastReport = $state<SyncReport | null>(null);
  pending = $state(0);

  private s: Services | null = null;
  private key: StoredSyncKey | null = null;
  private running: Promise<SyncReport | null> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private hooks: ControllerHooks = {};
  private started = false;

  get enabled(): boolean {
    return !!this.key;
  }

  /** Load state and start triggers. Safe to call more than once. */
  async init(s: Services, hooks: ControllerHooks = {}): Promise<void> {
    this.s = s;
    this.hooks = hooks;
    this.key = await loadSyncKey(s.repo);
    const status = await s.repo.getValue<StoredStatus>(SYNC_STATUS);
    this.lastSyncAt = status?.lastSyncAt ?? 0;
    this.lastError = status?.lastError ?? null;
    this.lastReport = status?.lastReport ?? null;
    await this.refreshHome();
    await this.countPending();
    if (this.started) return;
    this.started = true;
    s.repo.events.subscribe((topics) => {
      if (!SYNCED_TOPICS.some((t) => topics.has(t))) return;
      void this.countPending();
      if (this.running) return;
      this.schedule();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.auto());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - this.lastSyncAt > 60_000) void this.auto();
      });
      this.interval = setInterval(() => {
        if (document.visibilityState === 'visible') void this.auto();
      }, INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    this.interval = null;
    this.debounce = null;
  }

  private async refreshHome(): Promise<void> {
    const s = this.s;
    if (!s || !this.key) {
      this.home = null;
      this.phase = 'off';
      return;
    }
    const src = await getServer(s.repo, this.key.sourceId);
    this.home = { sourceId: this.key.sourceId, name: src?.name ?? 'Removed server', username: this.key.username };
    if (this.phase === 'off') this.phase = this.lastError ? 'error' : 'idle';
  }

  async countPending(): Promise<void> {
    if (!this.s) return;
    this.pending = (await this.s.repo.listChanges()).length;
  }

  private schedule(delay = DEBOUNCE_MS): void {
    if (!this.key) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.auto();
    }, delay);
  }

  /** An automatic run: skipped when auto sync is off on this device. */
  async auto(): Promise<SyncReport | null> {
    if (!this.s || !this.key) return null;
    const device = await this.s.repo.getDeviceSettings();
    if (!device.autoSync) return null;
    return this.syncNow();
  }

  /** Run now (or join the run in progress, then run once more). */
  async syncNow(): Promise<SyncReport | null> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    const report = await this.running;
    if (this.again) {
      this.again = false;
      this.schedule(500);
    } else if (this.key && this.pending > 0 && this.phase === 'idle') {
      // Changes made during the run.
      this.schedule();
    }
    return report;
  }

  private async runOnce(): Promise<SyncReport | null> {
    const s = this.s;
    const key = this.key;
    if (!s || !key) return null;
    if (!isOnline()) {
      this.phase = 'offline';
      return null;
    }
    const source = await getServer(s.repo, key.sourceId);
    if (!source) {
      await this.fail('The sync server was removed from this device. Choose a sync server again.', 'error');
      return null;
    }
    this.phase = 'syncing';
    try {
      const engine = new SyncEngine(s.repo, apiFor(source, s.repo), await keyringOf(key), key, {
        onApplied: (p) => this.hooks.onApplied?.(p, s),
      });
      const report = await engine.run();
      this.lastSyncAt = report.at;
      this.lastReport = report;
      this.lastError = null;
      this.phase = 'idle';
      await s.repo.setValue<StoredStatus>(SYNC_STATUS, { lastSyncAt: report.at, lastError: null, lastReport: report });
      await this.countPending();
      return report;
    } catch (err) {
      if (err instanceof SyncKeysChangedError) {
        await this.fail(err.message, 'reset');
      } else if (err instanceof ServerError && err.status === 401) {
        await this.fail('Signed out of the sync server. Sign in again to keep syncing.', 'signed-out');
      } else if (err instanceof ServerError && err.transient) {
        await this.fail(describeError(err), isOnline() ? 'error' : 'offline');
      } else {
        await this.fail(describeError(err), 'error');
      }
      return null;
    }
  }

  private async fail(message: string, phase: SyncPhase): Promise<void> {
    this.lastError = message;
    this.phase = phase;
    await this.s?.repo.setValue<StoredStatus>(SYNC_STATUS, {
      lastSyncAt: this.lastSyncAt,
      lastError: message,
      lastReport: this.lastReport,
    });
  }

  // --- setup -------------------------------------------------------------------

  /**
   * Make `source` the sync home using the master key from signing in.
   * Returns the setup result: for 'created', show `recoveryKey` once.
   * Throws KeyMismatchError when the password does not unwrap existing keys.
   */
  async enable(source: LibrariaSource, masterKey: Uint8Array): Promise<KeySetup> {
    const s = this.need();
    const result = await setupOrUnlock(apiFor(source, s.repo), masterKey);
    await this.adopt(source, result.dataKey, result.keys);
    return result;
  }

  /** Unlock with the recovery key; re-wraps for the current password when the master key is given. */
  async enableWithRecovery(source: LibrariaSource, keys: SyncKeysDto, recoveryKey: string, masterKey: Uint8Array | null): Promise<void> {
    const s = this.need();
    const { dataKey, keys: next } = await unlockWithRecovery(apiFor(source, s.repo), keys, recoveryKey, masterKey);
    await this.adopt(source, dataKey, next);
  }

  private async adopt(source: LibrariaSource, dataKey: Uint8Array, keys: SyncKeysDto): Promise<void> {
    const s = this.need();
    const stored = storedKey(dataKey, keys, { sourceId: source.id, serverId: source.config.serverId, username: source.config.username });
    await s.repo.setValue(SYNC_CURSOR, 0);
    await s.repo.setValue(SYNC_REVS, {});
    await saveSyncKey(s.repo, stored);
    await requeueAll(s.repo);
    this.key = stored;
    this.lastError = null;
    this.phase = 'idle';
    await this.refreshHome();
    await this.countPending();
    void this.syncNow();
  }

  /** After a password change on the sync home the stored key stays valid. */
  get storedKey(): StoredSyncKey | null {
    return this.key;
  }

  /** Remove the data key from this device. Synced data stays on the server. */
  async forget(): Promise<void> {
    const s = this.need();
    await forgetSyncKey(s.repo);
    this.key = null;
    this.lastError = null;
    this.lastReport = null;
    this.lastSyncAt = 0;
    this.phase = 'off';
    this.home = null;
  }

  /** Delete every sync record and key on the server, then forget locally. */
  async reset(): Promise<void> {
    const s = this.need();
    if (this.key) {
      const source = await getServer(s.repo, this.key.sourceId);
      if (source) await apiFor(source, s.repo).deleteSync();
    }
    await this.forget();
  }

  isHome(sourceId: string): boolean {
    return this.key?.sourceId === sourceId;
  }

  private need(): Services {
    if (!this.s) throw new Error('Sync is not initialised');
    return this.s;
  }

  /** Mark the home session as fine again (after signing in). */
  async signedIn(sourceId: string): Promise<void> {
    if (this.key?.sourceId !== sourceId || !this.s) return;
    await patchServerState(this.s.repo, sourceId, { sessionExpired: false });
    if (this.phase === 'signed-out') {
      this.phase = 'idle';
      this.lastError = null;
    }
    void this.syncNow();
  }
}

export const sync = new SyncController();
