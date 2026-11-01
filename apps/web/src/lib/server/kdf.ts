/**
 * Password → keys. Argon2id runs in a Web Worker (falls back to the current
 * thread where workers are unavailable, e.g. tests). Passwords never leave
 * the client: callers get the master key (kept in memory only as long as
 * needed) and the auth hash the server checks.
 */
import { deriveAuthHash, deriveMasterKey, type KdfParams } from '@libraria/core';

export type KeyDeriver = (password: string, salt: string, kdf: KdfParams) => Promise<Uint8Array>;

export const deriveInThread: KeyDeriver = (password, salt, kdf) => deriveMasterKey(password, salt, kdf);

export const deriveInWorker: KeyDeriver = (password, salt, kdf) => {
  if (typeof Worker === 'undefined') return deriveInThread(password, salt, kdf);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      deriveInThread(password, salt, kdf).then(resolve, reject);
      return;
    }
    worker.onmessage = (e: MessageEvent<{ type: 'done'; key: Uint8Array } | { type: 'error'; message: string }>) => {
      worker.terminate();
      if (e.data.type === 'done') resolve(new Uint8Array(e.data.key));
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      e.preventDefault();
      deriveInThread(password, salt, kdf).then(resolve, reject);
    };
    worker.postMessage({ password, salt, kdf });
  });
};

let deriver: KeyDeriver = deriveInWorker;

/** Tests swap in the in-thread deriver. */
export function setKeyDeriver(d: KeyDeriver): void {
  deriver = d;
}

export interface DerivedKeys {
  masterKey: Uint8Array;
  authHash: string;
}

export async function deriveKeys(password: string, salt: string, kdf: KdfParams): Promise<DerivedKeys> {
  const masterKey = await deriver(password, salt, kdf);
  return { masterKey, authHash: await deriveAuthHash(masterKey) };
}
