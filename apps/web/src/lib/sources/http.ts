/**
 * HTTP helpers shared by the remote drivers: a fetch that turns network
 * failures into SourceErrors, and a streaming download that resumes with a
 * Range request when the connection drops.
 */
import { isOnline } from '../net.svelte';
import { SourceError, isAbort } from './errors';

export type Fetch = typeof fetch;

let fetchImpl: Fetch | null = null;

/** For tests: replace the fetch the drivers use. `null` restores the global one. */
export function setFetch(f: Fetch | null): void {
  fetchImpl = f;
}

function doFetch(input: string, init: RequestInit): Promise<Response> {
  return (fetchImpl ?? globalThis.fetch)(input, init);
}

/**
 * fetch() that rejects with a SourceError('network') when the request never
 * got a response. Browsers report CORS refusals the same way as an
 * unreachable host, so the message names both.
 */
export async function request(url: string, init: RequestInit, what: { host: string; cors?: boolean }): Promise<Response> {
  try {
    return await doFetch(url, { credentials: 'omit', ...init });
  } catch (err) {
    if (isAbort(err)) throw err;
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (!isOnline()) throw new SourceError('network', 'You are offline.');
    if (what.cors) {
      throw new SourceError(
        'network',
        `Could not connect to ${what.host}. The server is unreachable, or it does not allow requests from this app (CORS).`,
        { corsHelp: true },
      );
    }
    throw new SourceError('network', `Could not connect to ${what.host}. Check your connection and try again.`);
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number | null) => void;
  /** Resume attempts after the connection drops (default 3). */
  retries?: number;
  /** Delay before resume attempt n (ms). */
  backoff?: (attempt: number) => number;
}

export interface OpenRange {
  /** First byte wanted; 0 for the whole file. */
  offset: number;
  /** ETag of the first response, for If-Range. */
  etag: string | null;
}

export function totalFromResponse(res: Response, offset: number): number | null {
  const range = res.headers.get('content-range');
  const m = range && /\/(\d+)\s*$/.exec(range);
  if (m) return Number(m[1]);
  const len = res.headers.get('content-length');
  if (len == null || !/^\d+$/.test(len)) return null;
  return res.status === 206 ? offset + Number(len) : Number(len);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    });
  });

/**
 * Stream a download. `open` performs the request (adding `Range:
 * bytes=<offset>-` when offset > 0) and must throw a SourceError for error
 * statuses. When the body fails mid-way, the download resumes from the last
 * byte received: a 206 continues; a 200 (server ignored Range) restarts and
 * the bytes already delivered are skipped.
 */
export async function resumableStream(
  open: (range: OpenRange) => Promise<Response>,
  opts: StreamOptions = {},
): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoff ?? ((n) => 500 * 2 ** (n - 1));
  const first = await open({ offset: 0, etag: null });
  if (!first.body) throw new SourceError('bad-response', 'The server sent an empty response.');
  const etag = first.headers.get('etag');
  const total = totalFromResponse(first, 0);
  let reader = first.body.getReader();
  let received = 0;
  let skip = 0; // bytes to drop from a restarted (200) response
  let attempt = 0;

  const abortReason = () => opts.signal?.reason ?? new DOMException('Aborted', 'AbortError');

  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for (;;) {
        if (opts.signal?.aborted) throw abortReason();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (opts.signal?.aborted || isAbort(err)) throw isAbort(err) ? err : abortReason();
          if (attempt >= retries || (total != null && received >= total)) throw err;
          attempt++;
          await sleep(backoff(attempt), opts.signal);
          const res = await open({ offset: received, etag });
          if (!res.body) throw new SourceError('bad-response', 'The server sent an empty response.');
          skip = res.status === 206 ? 0 : received;
          reader = res.body.getReader();
          continue;
        }
        if (chunk.done) {
          if (total != null && received < total) {
            // Body ended early without an error: treat as a dropped connection.
            if (attempt >= retries) throw new SourceError('network', 'The download was interrupted.');
            attempt++;
            const res = await open({ offset: received, etag });
            if (!res.body) throw new SourceError('bad-response', 'The server sent an empty response.');
            skip = res.status === 206 ? 0 : received;
            reader = res.body.getReader();
            continue;
          }
          ctrl.close();
          return;
        }
        let value = chunk.value;
        if (skip > 0) {
          if (value.byteLength <= skip) {
            skip -= value.byteLength;
            continue;
          }
          value = value.subarray(skip);
          skip = 0;
        }
        received += value.byteLength;
        opts.onProgress?.(received, total);
        ctrl.enqueue(value);
        return;
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
  return { stream, size: total };
}

/** Collect a stream into a Blob. */
export async function streamToBlob(stream: ReadableStream<Uint8Array>, type = ''): Promise<Blob> {
  const parts: BlobPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array<ArrayBuffer>);
  }
  return new Blob(parts, { type });
}

/** Range header value for a resume, or undefined for a full download. */
export function rangeHeaders(range: OpenRange): Record<string, string> {
  if (range.offset <= 0) return {};
  const h: Record<string, string> = { Range: `bytes=${range.offset}-` };
  if (range.etag && !range.etag.startsWith('W/')) h['If-Range'] = range.etag;
  return h;
}
