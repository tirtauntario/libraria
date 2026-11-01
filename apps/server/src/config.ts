/**
 * Host settings: `libraria.config.json` in the data directory, overridden by
 * LIBRARIA_* environment variables. Changing them needs a restart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from './log';

export interface BucketConfig {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  publicUrl: string | null;
  /** Passed to Express `trust proxy`. */
  trustProxy: boolean | number | string;
  allowedOrigins: string[];
  sourceRoots: string[];
  oauth: { google: string | null; dropbox: string | null };
  log: { level: LogLevel };
  /** Directory with the built PWA, or null to not serve it. */
  webDir: string | null;
  rateLimit: { anonymous: BucketConfig; auth: BucketConfig };
}

export const CONFIG_FILENAME = 'libraria.config.json';

/** No official static client is published yet; add its origin here when it is. */
export const OFFICIAL_CLIENT_ORIGINS: string[] = [];

const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

/** apps/server, from both src/config.ts and the bundled dist/index.js. */
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultWebDir(): string | null {
  const dir = resolve(PACKAGE_DIR, '../web/dist');
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

export function defaultConfig(dataDir: string): ServerConfig {
  return {
    port: 8080,
    host: '0.0.0.0',
    dataDir,
    publicUrl: null,
    trustProxy: false,
    allowedOrigins: [...OFFICIAL_CLIENT_ORIGINS],
    sourceRoots: [],
    oauth: { google: null, dropbox: null },
    log: { level: 'info' },
    webDir: defaultWebDir(),
    rateLimit: {
      anonymous: { capacity: 120, refillPerSecond: 2 },
      auth: { capacity: 20, refillPerSecond: 0.2 },
    },
  };
}

/** What a fresh config file contains. dataDir is not stored: the file lives in it. */
function fileTemplate(config: ServerConfig): Record<string, unknown> {
  return {
    port: config.port,
    host: config.host,
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    allowedOrigins: config.allowedOrigins,
    sourceRoots: config.sourceRoots,
    oauth: config.oauth,
    log: config.log,
    rateLimit: config.rateLimit,
  };
}

function list(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseTrustProxy(value: string): boolean | number | string {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`Invalid origin in config: ${value}`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bucket(value: unknown, fallback: BucketConfig): BucketConfig {
  const v = asObject(value);
  return {
    capacity: typeof v.capacity === 'number' && v.capacity > 0 ? v.capacity : fallback.capacity,
    refillPerSecond:
      typeof v.refillPerSecond === 'number' && v.refillPerSecond > 0 ? v.refillPerSecond : fallback.refillPerSecond,
  };
}

/** Merges a parsed config file onto defaults, validating each field. */
export function mergeConfig(base: ServerConfig, raw: Record<string, unknown>): ServerConfig {
  const out: ServerConfig = structuredClone(base);
  if (typeof raw.port === 'number') out.port = raw.port;
  if (typeof raw.host === 'string') out.host = raw.host;
  if (typeof raw.publicUrl === 'string' || raw.publicUrl === null) out.publicUrl = raw.publicUrl || null;
  if (['boolean', 'number', 'string'].includes(typeof raw.trustProxy)) out.trustProxy = raw.trustProxy as ServerConfig['trustProxy'];
  if (Array.isArray(raw.allowedOrigins)) out.allowedOrigins = raw.allowedOrigins.filter((o) => typeof o === 'string');
  if (Array.isArray(raw.sourceRoots)) out.sourceRoots = raw.sourceRoots.filter((o) => typeof o === 'string');
  if (typeof raw.webDir === 'string' || raw.webDir === null) out.webDir = raw.webDir || null;
  const oauth = asObject(raw.oauth);
  if (typeof oauth.google === 'string') out.oauth.google = oauth.google || null;
  if (typeof oauth.dropbox === 'string') out.oauth.dropbox = oauth.dropbox || null;
  const log = asObject(raw.log);
  if (LOG_LEVELS.includes(log.level as LogLevel)) out.log.level = log.level as LogLevel;
  const rl = asObject(raw.rateLimit);
  out.rateLimit = { anonymous: bucket(rl.anonymous, out.rateLimit.anonymous), auth: bucket(rl.auth, out.rateLimit.auth) };
  return out;
}

export function applyEnv(config: ServerConfig, env: NodeJS.ProcessEnv): ServerConfig {
  const out = structuredClone(config);
  if (env.LIBRARIA_PORT) out.port = Number(env.LIBRARIA_PORT);
  if (env.LIBRARIA_HOST) out.host = env.LIBRARIA_HOST;
  if (env.LIBRARIA_PUBLIC_URL !== undefined) out.publicUrl = env.LIBRARIA_PUBLIC_URL || null;
  if (env.LIBRARIA_TRUST_PROXY !== undefined) out.trustProxy = parseTrustProxy(env.LIBRARIA_TRUST_PROXY);
  if (env.LIBRARIA_ALLOWED_ORIGINS !== undefined) out.allowedOrigins = list(env.LIBRARIA_ALLOWED_ORIGINS);
  if (env.LIBRARIA_SOURCE_ROOTS !== undefined) out.sourceRoots = list(env.LIBRARIA_SOURCE_ROOTS);
  if (env.LIBRARIA_LOG_LEVEL && LOG_LEVELS.includes(env.LIBRARIA_LOG_LEVEL as LogLevel)) {
    out.log.level = env.LIBRARIA_LOG_LEVEL as LogLevel;
  }
  if (env.LIBRARIA_WEB_DIR !== undefined) out.webDir = env.LIBRARIA_WEB_DIR || null;
  return out;
}

/** Resolves paths and normalizes origins. Throws on invalid values. */
export function finalizeConfig(config: ServerConfig, cwd = process.cwd()): ServerConfig {
  const out = structuredClone(config);
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error(`Invalid port: ${out.port}`);
  out.dataDir = resolve(cwd, out.dataDir);
  if (out.publicUrl) {
    const url = new URL(out.publicUrl);
    out.publicUrl = url.origin + url.pathname.replace(/\/+$/, '');
  }
  out.allowedOrigins = [...new Set(out.allowedOrigins.map(normalizeOrigin))];
  out.sourceRoots = [...new Set(out.sourceRoots.map((r) => resolve(cwd, r)))];
  if (out.webDir) out.webDir = isAbsolute(out.webDir) ? out.webDir : resolve(cwd, out.webDir);
  return out;
}

/**
 * Loads the config for a run: data dir from LIBRARIA_DATA_DIR (default ./data),
 * then the config file there (written with defaults on first run), then env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const dataDir = resolve(cwd, env.LIBRARIA_DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true });
  const base = defaultConfig(dataDir);
  const file = join(dataDir, CONFIG_FILENAME);
  let config = base;
  if (existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot parse ${file}: ${(err as Error).message}`);
    }
    config = mergeConfig(base, asObject(raw));
  } else {
    writeFileSync(file, JSON.stringify(fileTemplate(base), null, 2) + '\n');
  }
  return finalizeConfig(applyEnv(config, env), cwd);
}
