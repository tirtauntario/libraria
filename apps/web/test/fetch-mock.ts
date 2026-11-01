/**
 * A tiny fetch mock for driver tests: handlers match on method + URL and
 * every call is recorded with its headers and body.
 */
import { setFetch } from '../src/lib/sources/http';

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

export class FetchMock {
  calls: Call[] = [];
  private routes: { method: string; match: (url: string) => boolean; handler: Handler; once: boolean }[] = [];

  constructor() {
    setFetch(this.fetch);
  }

  on(method: string, match: string | RegExp | ((url: string) => boolean), handler: Handler, opts: { once?: boolean } = {}): this {
    const fn = typeof match === 'string' ? (u: string) => u === match : match instanceof RegExp ? (u: string) => match.test(u) : match;
    this.routes.push({ method: method.toUpperCase(), match: fn, handler, once: !!opts.once });
    return this;
  }

  /** Requests fail like a browser blocked by CORS or with no network. */
  failNetwork(match: RegExp): this {
    return this.on('*', match, () => {
      throw new TypeError('Failed to fetch');
    });
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: string | null = null;
    if (typeof init.body === 'string') body = init.body;
    else if (init.body instanceof URLSearchParams) body = init.body.toString();
    const call = { method, url, headers, body };
    this.calls.push(call);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const i = this.routes.findIndex((r) => (r.method === '*' || r.method === method) && r.match(url));
    if (i < 0) return new Response('no mock for ' + method + ' ' + url, { status: 599 });
    const route = this.routes[i]!;
    if (route.once) this.routes.splice(i, 1);
    return route.handler(call);
  };

  restore(): void {
    setFetch(null);
  }
}

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A body that delivers `bytes` in chunks and then errors (a dropped connection) after `failAfter` bytes. */
export function flakyBody(bytes: Uint8Array, failAfter: number, chunk = 1024): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (pos >= failAfter) {
        ctrl.error(new TypeError('network error'));
        return;
      }
      const end = Math.min(failAfter, pos + chunk, bytes.length);
      ctrl.enqueue(bytes.slice(pos, end));
      pos = end;
      if (pos >= bytes.length) ctrl.close();
    },
  });
}

export function bytesOf(n: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * seed + (i >> 8)) & 0xff;
  return out;
}

/** A Map-backed localStorage for Node. */
export function installLocalStorage(): Storage {
  const m = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
  return ls;
}
