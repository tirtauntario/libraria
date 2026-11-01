import { sha512 } from '@libraria/core';

export type Hasher = (blob: Blob, onProgress?: (bytes: number) => void, signal?: AbortSignal) => Promise<string>;

/** Streaming SHA-512 in the current thread. */
export const hashInThread: Hasher = (blob, onProgress) => sha512(blob, onProgress);

/**
 * Streaming SHA-512 in a Web Worker, so hashing a 500 MB comic does not
 * freeze the UI. Blobs are passed by reference (no copy). Falls back to the
 * current thread where workers are unavailable.
 */
export const hashInWorker: Hasher = (blob, onProgress, signal) => {
  if (typeof Worker === 'undefined') return hashInThread(blob, onProgress, signal);
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    const done = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      done();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (e: MessageEvent<{ type: 'progress'; bytes: number } | { type: 'done'; hash: string } | { type: 'error'; message: string }>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.bytes);
      else if (m.type === 'done') {
        done();
        resolve(m.hash);
      } else {
        done();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      done();
      // Worker failed to start (e.g. CSP): hash here instead.
      e.preventDefault();
      hashInThread(blob, onProgress, signal).then(resolve, reject);
    };
    worker.postMessage(blob);
  });
};
