/** Small input validators. Every user-supplied string is trimmed, capped and stripped of control chars. */
import { badRequest } from './errors';

export type Body = Record<string, unknown>;

export function body(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Expected a JSON object body');
  return value as Body;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(value: string, max: number, multiline = false): string {
  let s = value.replace(CONTROL, '');
  if (!multiline) s = s.replace(/[\r\n\t]+/g, ' ');
  return s.trim().slice(0, max);
}

export function str(b: Body, key: string, opts: { min?: number; max: number; multiline?: boolean }): string {
  const v = b[key];
  if (typeof v !== 'string') throw badRequest(`${key} must be a string`);
  const s = cleanText(v, opts.max, opts.multiline);
  if (s.length < (opts.min ?? 1)) throw badRequest(`${key} is required`);
  return s;
}

export function optStr(b: Body, key: string, max: number, multiline = false): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw badRequest(`${key} must be a string or null`);
  return cleanText(v, max, multiline) || null;
}

export function optNum(b: Body, key: string, opts: { min: number; max: number; integer?: boolean }): number | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < opts.min || v > opts.max || (opts.integer && !Number.isInteger(v))) {
    throw badRequest(`${key} must be a number between ${opts.min} and ${opts.max}`);
  }
  return v;
}

export function int(b: Body, key: string, min: number, max: number): number {
  const v = optNum(b, key, { min, max, integer: true });
  if (v == null) throw badRequest(`${key} is required`);
  return v;
}

export function optBool(b: Body, key: string): boolean | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw badRequest(`${key} must be a boolean`);
  return v;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw badRequest(`${key} must be one of ${allowed.join(', ')}`);
  return value as T;
}

export function authors(value: unknown, key = 'authors'): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((a) => typeof a !== 'string')) throw badRequest(`${key} must be an array of strings`);
  const out: string[] = [];
  for (const a of value as string[]) {
    const s = cleanText(a, 200);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function base64url(b: Body, key: string, min: number, max: number): string {
  const v = b[key];
  if (typeof v !== 'string' || v.length < min || v.length > max || !BASE64URL.test(v)) {
    throw badRequest(`${key} must be a base64url string`);
  }
  return v;
}

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

export function username(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('username must be a string');
  const u = value.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw badRequest('username must be 3-32 characters of a-z, 0-9, _ . -');
  return u;
}

export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function queryInt(value: unknown, fallback: number, min: number, max: number): number {
  const s = queryString(value);
  if (s === undefined || s === '') return fallback;
  if (!/^\d+$/.test(s)) throw badRequest('Expected a non-negative integer');
  return Math.min(max, Math.max(min, Number(s)));
}
