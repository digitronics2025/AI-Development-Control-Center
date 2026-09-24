import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.js';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** The fingerprint of a migration's SQL, recorded when it is applied. */
function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Apply pending migrations in order, each atomically. Returns the versions applied.
 *
 * A shipped migration never changes (AGENTS.md). The runner holds the code to
 * that: an applied version whose stored name or SQL fingerprint differs from
 * the code's is refused before anything runs, instead of trusting the number
 * and failing later on "table already exists" (audit F-29). Rows applied before
 * fingerprints existed take the current code's fingerprint once.
 */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'checksum')) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations').all() as Array<{ version: number; name: string; checksum: string | null }>;
  const applied = new Map(rows.map((r) => [r.version, r]));
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    const row = applied.get(migration.version);
    if (!row) continue;
    const sum = checksum(migration.sql);
    if (row.name !== migration.name) throw new MigrationMismatchError(migration.version, `is "${row.name}" in this database but "${migration.name}" in the code`);
    if (row.checksum === null) db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(sum, migration.version);
    else if (row.checksum !== sum) throw new MigrationMismatchError(migration.version, `("${migration.name}") was changed after this database applied it`);
  }
  const done: number[] = [];
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
        checksum(migration.sql),
      );
    })();
    done.push(migration.version);
  }
  return done;
}

export class MigrationMismatchError extends Error {
  constructor(
    readonly version: number,
    detail: string,
  ) {
    super(`Database migration ${version} ${detail}. A shipped migration must never be edited or renumbered: add a new one instead, or restore the code that matches this database.`);
    this.name = 'MigrationMismatchError';
  }
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}
