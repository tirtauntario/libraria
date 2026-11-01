/**
 * Client-side key handling for login and end-to-end encrypted sync.
 *
 *   master_key = Argon2id(password, salt)               never leaves the device
 *   auth_hash  = HKDF(master_key, "libraria/auth")      sent to the server to log in
 *   wrap_key   = HKDF(master_key, "libraria/wrap")      wraps data_key
 *   data_key   = 32 random bytes                        stored on the server wrapped
 *     enc_key  = HKDF(data_key, "libraria/enc")         AES-256-GCM for records
 *     ref_key  = HKDF(data_key, "libraria/ref")         HMAC-SHA256 for record refs
 *   recovery   = 32 random bytes shown once             also wraps data_key
 */
import { argon2id } from 'hash-wasm';
import { bufferOf, fromBase64Url, fromUtf8, toBase64Url, toHex, utf8 } from './encoding';

export interface KdfParams {
  algorithm: 'argon2id';
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_KDF: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
};

/** Bounds the server enforces so a client cannot store absurd params. */
export function isValidKdf(kdf: unknown): kdf is KdfParams {
  if (!kdf || typeof kdf !== 'object') return false;
  const k = kdf as KdfParams;
  return (
    k.algorithm === 'argon2id' &&
    Number.isInteger(k.memoryKiB) && k.memoryKiB >= 16 * 1024 && k.memoryKiB <= 1024 * 1024 &&
    Number.isInteger(k.iterations) && k.iterations >= 1 && k.iterations <= 20 &&
    Number.isInteger(k.parallelism) && k.parallelism >= 1 && k.parallelism <= 16
  );
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomSalt(): string {
  return toBase64Url(randomBytes(16));
}

/** Random opaque token (e.g. session or invite), base64url. */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export async function deriveMasterKey(password: string, salt: string, kdf: KdfParams): Promise<Uint8Array> {
  return argon2id({
    password: password.normalize('NFKC'),
    salt: fromBase64Url(salt),
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memoryKiB,
    hashLength: 32,
    outputType: 'binary',
  });
}

async function hkdf(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bufferOf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: bufferOf(utf8(info)) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveAuthHash(masterKey: Uint8Array): Promise<string> {
  return toBase64Url(await hkdf(masterKey, 'libraria/auth'));
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bufferOf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bufferOf(iv), additionalData: bufferOf(utf8(aad)) },
    key,
    bufferOf(plaintext),
  );
  const out = new Uint8Array(1 + iv.length + ct.byteLength);
  out[0] = 1; // format version
  out.set(iv, 1);
  out.set(new Uint8Array(ct), 1 + iv.length);
  return toBase64Url(out);
}

async function open(key: CryptoKey, sealed: string, aad: string): Promise<Uint8Array> {
  const bytes = fromBase64Url(sealed);
  if (bytes[0] !== 1) throw new Error('Unknown ciphertext version');
  const iv = bytes.subarray(1, 13);
  const ct = bytes.subarray(13);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bufferOf(iv), additionalData: bufferOf(utf8(aad)) },
    key,
    bufferOf(ct),
  );
  return new Uint8Array(pt);
}

export function generateDataKey(): Uint8Array {
  return randomBytes(32);
}

export async function wrapDataKey(dataKey: Uint8Array, masterKey: Uint8Array): Promise<string> {
  return seal(await aesKey(await hkdf(masterKey, 'libraria/wrap')), dataKey, 'data-key');
}

export async function unwrapDataKey(wrapped: string, masterKey: Uint8Array): Promise<Uint8Array> {
  return open(await aesKey(await hkdf(masterKey, 'libraria/wrap')), wrapped, 'data-key');
}

// Recovery key: 32 random bytes shown as 8 groups of base32 characters.
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateRecoveryKey(): string {
  const bytes = randomBytes(32);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32_ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out.match(/.{1,4}/g)!.join('-');
}

export function normalizeRecoveryKey(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

async function recoveryWrapKey(recoveryKey: string): Promise<CryptoKey> {
  const normalized = normalizeRecoveryKey(recoveryKey);
  if (normalized.length !== 52) throw new Error('Invalid recovery key');
  return aesKey(await hkdf(utf8(normalized), 'libraria/recovery'));
}

export async function wrapWithRecoveryKey(dataKey: Uint8Array, recoveryKey: string): Promise<string> {
  return seal(await recoveryWrapKey(recoveryKey), dataKey, 'data-key');
}

export async function unwrapWithRecoveryKey(wrapped: string, recoveryKey: string): Promise<Uint8Array> {
  return open(await recoveryWrapKey(recoveryKey), wrapped, 'data-key');
}


/** Encrypts and decrypts sync records with keys derived from data_key. */
export class Keyring {
  private constructor(
    private readonly encKey: CryptoKey,
    private readonly refKey: CryptoKey,
  ) {}

  static async fromDataKey(dataKey: Uint8Array): Promise<Keyring> {
    const enc = await aesKey(await hkdf(dataKey, 'libraria/enc'));
    const refRaw = await hkdf(dataKey, 'libraria/ref');
    const ref = await crypto.subtle.importKey(
      'raw',
      bufferOf(refRaw),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return new Keyring(enc, ref);
  }

  /** Opaque, stable reference for a logical key (e.g. "progress:<sha512>"). */
  async ref(logicalKey: string): Promise<string> {
    const sig = await crypto.subtle.sign('HMAC', this.refKey, bufferOf(utf8(logicalKey)));
    return toHex(new Uint8Array(sig));
  }

  /** AAD binds the ciphertext to its kind and ref so records can't be swapped. */
  async encrypt(kind: string, ref: string, value: unknown): Promise<string> {
    return seal(this.encKey, utf8(JSON.stringify(value)), `${kind}:${ref}`);
  }

  async decrypt<T>(kind: string, ref: string, sealed: string): Promise<T> {
    return JSON.parse(fromUtf8(await open(this.encKey, sealed, `${kind}:${ref}`))) as T;
  }
}
