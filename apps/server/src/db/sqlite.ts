/**
 * Adapter that lets Kysely's SqliteDialect drive the built-in node:sqlite
 * module (no native addon, so it runs anywhere Node runs).
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type { SqliteDatabase, SqliteStatement } from 'kysely';

function toParam(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as SQLInputValue;
}

const CACHE_LIMIT = 500;

export class NodeSqliteDatabase implements SqliteDatabase {
  private readonly cache = new Map<string, { stmt: StatementSync; reader: boolean }>();

  constructor(readonly raw: DatabaseSync) {}

  close(): void {
    this.cache.clear();
    if (this.raw.isOpen) this.raw.close();
  }

  prepare(sql: string): SqliteStatement {
    let entry = this.cache.get(sql);
    if (!entry) {
      const stmt = this.raw.prepare(sql);
      entry = { stmt, reader: stmt.columns().length > 0 };
      if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
      this.cache.set(sql, entry);
    }
    const { stmt, reader } = entry;
    return {
      reader,
      all: (params) => stmt.all(...params.map(toParam)),
      run: (params) => stmt.run(...params.map(toParam)),
      iterate: (params) => stmt.iterate(...params.map(toParam)),
    };
  }
}

/** Opens (creating if needed) a database file with WAL and foreign keys on. */
export function openSqlite(path: string): NodeSqliteDatabase {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  return new NodeSqliteDatabase(db);
}
