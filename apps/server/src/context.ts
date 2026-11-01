import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Kysely, SqliteDialect } from 'kysely';
import { DEFAULT_LIBRARY_SETTINGS, randomToken, uuidv7, type LibrarySettings } from '@libraria/core';
import type { ServerConfig } from './config';
import type { Database } from './db/schema';
import { migrate } from './db/migrations';
import { openSqlite, type NodeSqliteDatabase } from './db/sqlite';
import type { Logger } from './log';
import { hashToken } from './security';

export interface Paths {
  data: string;
  db: string;
  books: string;
  covers: string;
  uploads: string;
}

export interface AppContext {
  config: ServerConfig;
  db: Kysely<Database>;
  log: Logger;
  paths: Paths;
  serverId: string;
  /** Persisted random secret for HMACs (fake prelogin salts). */
  secret: string;
  /** Cached library settings; updated in place by PATCH /settings. */
  settings: LibrarySettings;
  /** Submission ids with an upload in flight, and source ids being scanned. */
  locks: Set<string>;
  now: () => number;
}

export function dataPaths(dataDir: string): Paths {
  return {
    data: dataDir,
    db: join(dataDir, 'libraria.db'),
    books: join(dataDir, 'books'),
    covers: join(dataDir, 'covers'),
    uploads: join(dataDir, 'uploads'),
  };
}

function loadSecret(dataDir: string): string {
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) {
    const s = readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  }
  const s = randomToken(32);
  writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}

export function mergeSettings(stored: unknown): LibrarySettings {
  const s = stored && typeof stored === 'object' ? (stored as Partial<LibrarySettings>) : {};
  return { ...DEFAULT_LIBRARY_SETTINGS, ...s, allowedFormats: [...(s.allowedFormats ?? DEFAULT_LIBRARY_SETTINGS.allowedFormats)] };
}

export async function openDatabase(path: string): Promise<{ db: Kysely<Database>; sqlite: NodeSqliteDatabase }> {
  const sqlite = openSqlite(path);
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  await migrate(db);
  return { db, sqlite };
}

/** Opens the data dir and database, runs migrations and creates the singleton rows. */
export async function createContext(config: ServerConfig, log: Logger, now: () => number = Date.now): Promise<AppContext> {
  const paths = dataPaths(config.dataDir);
  for (const dir of [paths.data, paths.books, paths.covers, paths.uploads]) mkdirSync(dir, { recursive: true });
  const { db } = await openDatabase(paths.db);

  let server = await db.selectFrom('server').selectAll().executeTakeFirst();
  if (!server) {
    server = { id: uuidv7(), created_at: now() };
    await db.insertInto('server').values(server).execute();
  }

  let settingsRow = await db.selectFrom('settings').selectAll().executeTakeFirst();
  if (!settingsRow) {
    settingsRow = { id: uuidv7(), data: JSON.stringify(DEFAULT_LIBRARY_SETTINGS), updated_at: now() };
    await db.insertInto('settings').values(settingsRow).execute();
  }

  return {
    config,
    db,
    log,
    paths,
    serverId: server.id,
    secret: loadSecret(config.dataDir),
    settings: mergeSettings(JSON.parse(settingsRow.data)),
    locks: new Set(),
    now,
  };
}

export async function saveSettings(ctx: AppContext, settings: LibrarySettings): Promise<void> {
  await ctx.db.updateTable('settings').set({ data: JSON.stringify(settings), updated_at: ctx.now() }).execute();
  ctx.settings = settings;
}

export async function ownerExists(ctx: AppContext): Promise<boolean> {
  const row = await ctx.db.selectFrom('users').select('id').where('role', '=', 'owner').executeTakeFirst();
  return !!row;
}

/**
 * On a server without an owner, replaces any previous setup token with a new
 * one and returns it (only its hash is stored). Returns null once set up.
 */
export async function issueSetupToken(ctx: AppContext): Promise<string | null> {
  if (await ownerExists(ctx)) {
    await ctx.db.deleteFrom('setup_tokens').execute();
    return null;
  }
  const token = randomToken(24);
  await ctx.db.deleteFrom('setup_tokens').execute();
  await ctx.db.insertInto('setup_tokens').values({ id: uuidv7(), token_hash: hashToken(token), created_at: ctx.now() }).execute();
  return token;
}
