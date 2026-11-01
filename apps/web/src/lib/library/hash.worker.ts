/// <reference lib="webworker" />
import { sha512 } from '@libraria/core';

self.onmessage = async (e: MessageEvent<Blob>) => {
  let last = 0;
  try {
    const hash = await sha512(e.data, (bytes) => {
      // Throttle progress messages to ~every 4 MB.
      if (bytes - last >= 4 * 1024 * 1024) {
        last = bytes;
        self.postMessage({ type: 'progress', bytes });
      }
    });
    self.postMessage({ type: 'done', hash });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
