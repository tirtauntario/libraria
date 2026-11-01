/// <reference lib="webworker" />
import { deriveMasterKey, type KdfParams } from '@libraria/core';

/** Argon2id off the main thread: 64 MiB and a few hundred ms would freeze the UI. */
self.onmessage = async (e: MessageEvent<{ password: string; salt: string; kdf: KdfParams }>) => {
  try {
    const key = await deriveMasterKey(e.data.password, e.data.salt, e.data.kdf);
    self.postMessage({ type: 'done', key });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
