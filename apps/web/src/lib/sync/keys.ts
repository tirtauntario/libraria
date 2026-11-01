/**
 * Sync keys (see the key hierarchy in core `crypto.ts`).
 *
 * The login password is also the sync password (Bitwarden-style): the
 * master key derived at sign-in wraps the random data key, and a recovery
 * key shown once at setup wraps it too.
 *
 * Device-trusted model: after setup or unlock, this device keeps the raw
 * data key in IndexedDB (`sync:key`), so sync runs without asking for the
 * password again. Anyone with access to this browser profile can read it,
 * the same as the books and progress stored next to it. "Forget sync key"
 * deletes it; the password or recovery key unlocks sync again.
 */
import {
  fromBase64Url,
  generateDataKey,
  generateRecoveryKey,
  Keyring,
  toBase64Url,
  unwrapDataKey,
  unwrapWithRecoveryKey,
  wrapDataKey,
  wrapWithRecoveryKey,
  type SyncKeysDto,
} from '@libraria/core';
import type { Repo } from '../db/repo';
import { ServerError, type ServerApi } from '../server/api';

export const SYNC_KEY = 'sync:key';
export const SYNC_CURSOR = 'sync:cursor';
export const SYNC_REVS = 'sync:revs';
export const SYNC_STATUS = 'sync:status';

/** What this device stores to sync without the password. */
export interface StoredSyncKey {
  /** Raw data key, base64url. */
  dataKey: string;
  /** The `libraria` source that is the sync home, and its server id. */
  sourceId: string;
  serverId: string;
  username: string;
  /** Lets the engine notice that keys were replaced on another device. */
  wrappedRecoveryKey: string;
  setupAt: number;
}

export async function loadSyncKey(repo: Repo): Promise<StoredSyncKey | null> {
  return (await repo.getValue<StoredSyncKey>(SYNC_KEY)) ?? null;
}

export async function saveSyncKey(repo: Repo, key: StoredSyncKey): Promise<void> {
  await repo.setValue(SYNC_KEY, key);
}

/** Wipe the key and the sync bookkeeping from this device. Local data stays. */
export async function forgetSyncKey(repo: Repo): Promise<void> {
  await repo.setValue(SYNC_KEY, undefined);
  await repo.setValue(SYNC_CURSOR, undefined);
  await repo.setValue(SYNC_REVS, undefined);
  await repo.setValue(SYNC_STATUS, undefined);
}

export function keyringOf(key: StoredSyncKey): Promise<Keyring> {
  return Keyring.fromDataKey(fromBase64Url(key.dataKey));
}

/** The password does not unwrap the stored data key (changed elsewhere, or keys were reset). */
export class KeyMismatchError extends Error {
  constructor(readonly keys: SyncKeysDto) {
    super('Your password does not unlock the sync data on this server. Enter your recovery key.');
    this.name = 'KeyMismatchError';
  }
}

export type KeySetup =
  | { status: 'created'; dataKey: Uint8Array; recoveryKey: string; keys: SyncKeysDto }
  | { status: 'unlocked'; dataKey: Uint8Array; keys: SyncKeysDto };

/**
 * First device: create the data key, wrap it with the master key and a new
 * recovery key, upload both wrapped copies. Later devices: unwrap the
 * existing key with the master key. Throws KeyMismatchError when the
 * master key does not fit (offer the recovery key then).
 */
export async function setupOrUnlock(api: ServerApi, masterKey: Uint8Array): Promise<KeySetup> {
  const existing = await api.getSyncKeys();
  if (existing) return unlock(existing, masterKey);
  const dataKey = generateDataKey();
  const recoveryKey = generateRecoveryKey();
  const keys: SyncKeysDto = {
    wrappedDataKey: await wrapDataKey(dataKey, masterKey),
    wrappedRecoveryKey: await wrapWithRecoveryKey(dataKey, recoveryKey),
  };
  try {
    await api.putSyncKeys(keys);
  } catch (err) {
    // Another device set up sync at the same moment: use its keys.
    if (err instanceof ServerError && err.status === 409) {
      const now = await api.getSyncKeys();
      if (now) return unlock(now, masterKey);
    }
    throw err;
  }
  return { status: 'created', dataKey, recoveryKey, keys };
}

async function unlock(keys: SyncKeysDto, masterKey: Uint8Array): Promise<KeySetup> {
  try {
    return { status: 'unlocked', dataKey: await unwrapDataKey(keys.wrappedDataKey, masterKey), keys };
  } catch {
    throw new KeyMismatchError(keys);
  }
}

/**
 * Unlock with the recovery key. With the master key of the current
 * password, the data key is re-wrapped so the password works again.
 */
export async function unlockWithRecovery(
  api: ServerApi,
  keys: SyncKeysDto,
  recoveryKey: string,
  masterKey: Uint8Array | null,
): Promise<{ dataKey: Uint8Array; keys: SyncKeysDto }> {
  let dataKey: Uint8Array;
  try {
    dataKey = await unwrapWithRecoveryKey(keys.wrappedRecoveryKey, recoveryKey);
  } catch {
    throw new Error('That recovery key does not unlock this sync data.');
  }
  if (!masterKey) return { dataKey, keys };
  const next: SyncKeysDto = { wrappedDataKey: await wrapDataKey(dataKey, masterKey), wrappedRecoveryKey: keys.wrappedRecoveryKey };
  await api.putSyncKeys(next, true);
  return { dataKey, keys: next };
}

/** For POST /me/password on the sync home: the data key under the new master key. */
export async function rewrapDataKey(stored: StoredSyncKey, newMasterKey: Uint8Array): Promise<string> {
  return wrapDataKey(fromBase64Url(stored.dataKey), newMasterKey);
}

export function storedKey(
  dataKey: Uint8Array,
  keys: SyncKeysDto,
  home: { sourceId: string; serverId: string; username: string },
): StoredSyncKey {
  return { dataKey: toBase64Url(dataKey), wrappedRecoveryKey: keys.wrappedRecoveryKey, setupAt: Date.now(), ...home };
}
