let lastMs = 0;
let seq = 0;

/**
 * UUIDv7 (RFC 9562). Monotonic within one process: ids created in the same
 * millisecond use a 12-bit counter in rand_a so they still sort in order.
 */
export function uuidv7(now = Date.now()): string {
  if (now <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1;
    now = lastMs;
  } else {
    lastMs = now;
    seq = crypto.getRandomValues(new Uint16Array(1))[0]! & 0x3ff;
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes.subarray(8));
  const hi = Math.floor(now / 0x100000000);
  const lo = now >>> 0;
  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;
  bytes[6] = 0x70 | ((seq >>> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Milliseconds since epoch encoded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
