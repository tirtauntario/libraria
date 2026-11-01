/**
 * Inline migrations written with Kysely's schema builder only, so they run
 * unchanged on other dialects. Never edit a shipped migration; add a new one.
 */
import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

const id = 'varchar(36)';
const ms = 'bigint';

const init: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable('server')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('created_at', ms, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('settings')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('data', 'text', (c) => c.notNull())
      .addColumn('updated_at', ms, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('setup_tokens')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('token_hash', 'varchar(64)', (c) => c.notNull().unique())
      .addColumn('created_at', ms, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('users')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('username', 'varchar(32)', (c) => c.notNull().unique())
      .addColumn('auth_hash', 'varchar(255)', (c) => c.notNull())
      .addColumn('salt', 'varchar(128)', (c) => c.notNull())
      .addColumn('kdf', 'varchar(255)', (c) => c.notNull())
      .addColumn('role', 'varchar(16)', (c) => c.notNull())
      .addColumn('status', 'varchar(16)', (c) => c.notNull())
      .addColumn('sync_rev', ms, (c) => c.notNull().defaultTo(0))
      .addColumn('invite_id', id)
      .addColumn('created_at', ms, (c) => c.notNull())
      .addColumn('updated_at', ms, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('users_status_idx').on('users').column('status').execute();

    await db.schema
      .createTable('sessions')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('user_id', id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('token_hash', 'varchar(64)', (c) => c.notNull().unique())
      .addColumn('device_name', 'varchar(100)')
      .addColumn('created_at', ms, (c) => c.notNull())
      .addColumn('last_used_at', ms, (c) => c.notNull())
      .addColumn('expires_at', ms, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

    await db.schema
      .createTable('invites')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('token_hash', 'varchar(64)', (c) => c.notNull().unique())
      .addColumn('created_by', id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('expires_at', ms, (c) => c.notNull())
      .addColumn('used_by', id, (c) => c.references('users.id').onDelete('set null'))
      .addColumn('used_at', ms)
      .addColumn('created_at', ms, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('sources')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('kind', 'varchar(16)', (c) => c.notNull())
      .addColumn('path', 'text', (c) => c.notNull())
      .addColumn('last_scan_at', ms)
      .addColumn('created_at', ms, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('books')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('sha512', 'varchar(128)', (c) => c.notNull().unique())
      .addColumn('format', 'varchar(8)', (c) => c.notNull())
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('authors', 'text', (c) => c.notNull())
      .addColumn('series', 'text')
      .addColumn('series_index', 'real')
      .addColumn('description', 'text')
      .addColumn('language', 'varchar(35)')
      .addColumn('publisher', 'text')
      .addColumn('page_count', 'integer')
      .addColumn('file_size', ms, (c) => c.notNull())
      .addColumn('cover_ext', 'varchar(8)')
      .addColumn('search_text', 'text', (c) => c.notNull())
      .addColumn('submitted_by', id, (c) => c.references('users.id').onDelete('set null'))
      .addColumn('added_at', ms, (c) => c.notNull())
      .addColumn('updated_at', ms, (c) => c.notNull())
      .addColumn('deleted_at', ms)
      .execute();

    await db.schema
      .createTable('book_files')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('book_id', id, (c) => c.notNull().references('books.id').onDelete('cascade'))
      .addColumn('source_id', id, (c) => c.references('sources.id').onDelete('cascade'))
      .addColumn('path', 'text', (c) => c.notNull())
      .addColumn('size', ms, (c) => c.notNull())
      .addColumn('mtime', ms, (c) => c.notNull())
      .addColumn('removed_at', ms)
      .addColumn('created_at', ms, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('book_files_book_idx').on('book_files').column('book_id').execute();
    await db.schema.createIndex('book_files_source_idx').on('book_files').column('source_id').execute();

    await db.schema
      .createTable('submissions')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('user_id', id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('sha512', 'varchar(128)', (c) => c.notNull())
      .addColumn('format', 'varchar(8)', (c) => c.notNull())
      .addColumn('file_size', ms, (c) => c.notNull())
      .addColumn('filename', 'varchar(255)', (c) => c.notNull())
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('authors', 'text', (c) => c.notNull())
      .addColumn('series', 'text')
      .addColumn('series_index', 'real')
      .addColumn('description', 'text')
      .addColumn('language', 'varchar(35)')
      .addColumn('publisher', 'text')
      .addColumn('page_count', 'integer')
      .addColumn('upload_offset', ms, (c) => c.notNull().defaultTo(0))
      .addColumn('status', 'varchar(16)', (c) => c.notNull())
      .addColumn('review_note', 'text')
      .addColumn('reviewed_by', id, (c) => c.references('users.id').onDelete('set null'))
      .addColumn('reviewed_at', ms)
      .addColumn('book_id', id, (c) => c.references('books.id').onDelete('set null'))
      .addColumn('created_at', ms, (c) => c.notNull())
      .addColumn('updated_at', ms, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('submissions_user_idx').on('submissions').column('user_id').execute();
    await db.schema.createIndex('submissions_sha512_idx').on('submissions').column('sha512').execute();
    await db.schema.createIndex('submissions_status_idx').on('submissions').column('status').execute();

    await db.schema
      .createTable('sync_keys')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('user_id', id, (c) => c.notNull().unique().references('users.id').onDelete('cascade'))
      .addColumn('wrapped_data_key', 'text', (c) => c.notNull())
      .addColumn('wrapped_recovery_key', 'text', (c) => c.notNull())
      .addColumn('updated_at', ms, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('sync_records')
      .addColumn('id', id, (c) => c.primaryKey())
      .addColumn('user_id', id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('kind', 'varchar(16)', (c) => c.notNull())
      .addColumn('ref', 'varchar(255)', (c) => c.notNull())
      .addColumn('rev', ms, (c) => c.notNull())
      .addColumn('deleted', 'integer', (c) => c.notNull())
      .addColumn('ciphertext', 'text', (c) => c.notNull())
      .addColumn('updated_at', ms, (c) => c.notNull())
      .addUniqueConstraint('sync_records_ref_uq', ['user_id', 'kind', 'ref'])
      .addUniqueConstraint('sync_records_rev_uq', ['user_id', 'rev'])
      .execute();
  },
};

export const MIGRATIONS: Record<string, Migration> = {
  '0001_init': init,
};

class InlineProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return MIGRATIONS;
  }
}

export async function migrate(db: Kysely<any>): Promise<void> {
  const migrator = new Migrator({ db, provider: new InlineProvider() });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) {
    throw new Error(`Migration ${failed?.migrationName ?? ''} failed: ${(error as Error)?.message ?? 'unknown error'}`);
  }
}
