import { createSHA512 } from 'hash-wasm';

export type HashSource = Uint8Array | Blob | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

export interface HashProgress {
  (bytesHashed: number): void;
}

/**
 * Streaming SHA-512, lowercase hex. Never holds the whole input in memory,
 * unlike crypto.subtle.digest, so it is safe for large comics on phones.
 */
export async function sha512(source: HashSource, onProgress?: HashProgress): Promise<string> {
  const hasher = await createSHA512();
  hasher.init();
  let total = 0;
  const feed = (chunk: Uint8Array) => {
    hasher.update(chunk);
    total += chunk.byteLength;
    onProgress?.(total);
  };

  if (source instanceof Uint8Array) {
    feed(source);
  } else if (typeof Blob !== 'undefined' && source instanceof Blob) {
    await feedStream(source.stream() as ReadableStream<Uint8Array>, feed);
  } else if (typeof ReadableStream !== 'undefined' && source instanceof ReadableStream) {
    await feedStream(source, feed);
  } else {
    for await (const chunk of source as AsyncIterable<Uint8Array>) feed(chunk);
  }
  return hasher.digest('hex');
}

async function feedStream(stream: ReadableStream<Uint8Array>, feed: (chunk: Uint8Array) => void) {
  // getReader() rather than for-await: async iteration of ReadableStream
  // needs Safari 17.2+.
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) feed(value);
    }
  } finally {
    reader.releaseLock();
  }
}

const SHA512_RE = /^[0-9a-f]{128}$/;

export function isSha512(value: unknown): value is string {
  return typeof value === 'string' && SHA512_RE.test(value);
}
