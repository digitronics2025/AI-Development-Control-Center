import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { redact } from '@acc/security';
import type { PermissionLevel } from '@acc/shared';
import { z } from 'zod';
import { detectExecutable, run } from '../detect.js';
import { resolveInside } from '../paths.js';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';
import { classifySql } from '../sql.js';

/**
 * Database tools (V2 plan §24): SQLite files in the repository (built in),
 * Postgres and MySQL through their CLIs when installed. Credentials come from
 * the broker (`postgres` → DATABASE_URL, `mysql` → MYSQL_PWD); agents never
 * see them. D1 lives in the Cloudflare pack.
 */

const require = createRequire(import.meta.url);
type SqliteDatabase = import('better-sqlite3').Database;

function openSqlite(file: string, readonly: boolean): SqliteDatabase {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  return new Database(file, { readonly, fileMustExist: true, timeout: 5000 });
}

function resolveDb(ctx: OperationContext, file: string): string | OperationResult {
  try {
    return resolveInside(ctx.roots, ctx.cwd, file);
  } catch (error) {
    return failure('OUTSIDE_ROOT', (error as Error).message);
  }
}

const sqlClassify = (sql: string) => {
  const c = classifySql(sql);
  if (c.destructive) return { level: 5 as PermissionLevel, risk: 'dangerous' as const, reasons: c.reasons, effects: ['database' as const] };
  return { level: (c.readOnly ? 1 : 2) as PermissionLevel, reasons: c.reasons, effects: ['database' as const] };
};

const file = z.string().min(1).max(1000).describe('SQLite file path relative to the repository.');

function backupDir(ctx: OperationContext): string {
  return path.join(ctx.stateDir, 'backups', 'sqlite');
}

async function cliQuery(ctx: OperationContext, kind: 'postgres' | 'mysql', sql: string, readOnly: boolean): Promise<OperationResult> {
  const env = { ...ctx.env, ...(await ctx.credentials?.envFor([kind])) };
  if (kind === 'postgres') {
    if (!env.DATABASE_URL) return failure('AUTH_REQUIRED', 'Store a Postgres connection string as a `postgres` credential (Tools → Credentials)');
    const script = `${readOnly ? 'SET default_transaction_read_only = on;\n' : ''}${sql}`;
    const r = await run(ctx.detection('psql')?.path ?? 'psql', ['--no-psqlrc', '-X', '-v', 'ON_ERROR_STOP=1', '--csv', '-d', env.DATABASE_URL], { cwd: ctx.cwd, env, stdin: script, timeoutMs: 120_000 });
    if (r.spawnError) return failure('NOT_INSTALLED', 'psql is not installed');
    return r.code === 0 ? { ok: true, summary: `${Math.max(0, r.stdout.split('\n').length - 1)} row(s)`, stdout: redact(r.stdout).slice(0, 64_000) } : failure('FAILED', redact(r.stderr).slice(0, 500));
  }
  if (!env.MYSQL_PWD && !env.MYSQL_HOST) return failure('AUTH_REQUIRED', 'Store MySQL credentials as a `mysql` credential (Tools → Credentials)');
  const r = await run(ctx.detection('mysql')?.path ?? 'mysql', ['--batch', ...(readOnly ? ['--init-command=SET SESSION TRANSACTION READ ONLY'] : [])], { cwd: ctx.cwd, env, stdin: sql, timeoutMs: 120_000 });
  if (r.spawnError) return failure('NOT_INSTALLED', 'mysql is not installed');
  return r.code === 0 ? { ok: true, summary: `${Math.max(0, r.stdout.split('\n').length - 1)} row(s)`, stdout: redact(r.stdout).slice(0, 64_000) } : failure('FAILED', redact(r.stderr).slice(0, 500));
}

export function databaseProviders(): ToolProvider[] {
  return [
    {
      id: 'sqlite',
      name: 'SQLite',
      description: 'SQLite database files in the repository: schema, queries, backups and integrity checks.',
      category: 'database',
      builtin: true,
      async detect() {
        try {
          require.resolve('better-sqlite3');
          return builtinDetection('better-sqlite3');
        } catch {
          return { ...builtinDetection(), installed: false, message: 'better-sqlite3 is not installed' };
        }
      },
      operations: [
        operation({
          id: 'database.sqlite_schema',
          title: 'SQLite schema',
          description: 'Tables, columns and indexes of a SQLite file.',
          input: z.object({ file }),
          level: 1,
          async run(input, ctx) {
            const abs = resolveDb(ctx, input.file);
            if (typeof abs !== 'string') return abs;
            const db = openSqlite(abs, true);
            try {
              const tables = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ name: string; type: string; sql: string }>;
              const detail = tables.filter((t) => t.type === 'table').map((t) => ({ table: t.name, columns: db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all(), rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(t.name)}`).get() as { n: number }).n }));
              return { ok: true, summary: `${detail.length} table(s) in ${input.file}`, output: { tables: detail, objects: tables.map((t) => ({ name: t.name, type: t.type })) } };
            } finally {
              db.close();
            }
          },
        }),
        operation({
          id: 'database.sqlite_query',
          title: 'Query SQLite (read-only)',
          description: 'Run a read-only query (the file is opened read-only).',
          input: z.object({ file, sql: z.string().min(1).max(100_000), params: z.array(z.union([z.string(), z.number(), z.null()])).max(100).default([]), limit: z.number().int().min(1).max(5000).default(500) }),
          level: 1,
          async run(input, ctx) {
            if (!classifySql(input.sql).readOnly) return failure('INVALID_INPUT', 'Only read-only statements here; use database.sqlite_execute to change data');
            const abs = resolveDb(ctx, input.file);
            if (typeof abs !== 'string') return abs;
            const db = openSqlite(abs, true);
            try {
              const stmt = db.prepare(input.sql);
              const rows: unknown[] = [];
              for (const row of stmt.iterate(...input.params)) {
                rows.push(row);
                if (rows.length >= input.limit) break;
              }
              return { ok: true, summary: `${rows.length} row(s)`, output: { rows: JSON.parse(redact(JSON.stringify(rows))), truncated: rows.length >= input.limit } };
            } catch (error) {
              return failure('FAILED', redact((error as Error).message));
            } finally {
              db.close();
            }
          },
        }),
        operation({
          id: 'database.sqlite_execute',
          title: 'Change a SQLite database',
          description: 'Run SQL that changes data or schema. A backup is taken first; destructive statements need your approval.',
          input: z.object({ file, sql: z.string().min(1).max(1_000_000) }),
          level: 2,
          classify: (i) => sqlClassify(i.sql),
          async run(input, ctx) {
            const abs = resolveDb(ctx, input.file);
            if (typeof abs !== 'string') return abs;
            await mkdir(backupDir(ctx), { recursive: true });
            const backup = path.join(backupDir(ctx), `${path.basename(abs)}-${Date.now()}.bak`);
            const db = openSqlite(abs, false);
            try {
              await db.backup(backup);
              const before = db.prepare('SELECT total_changes() AS n').get() as { n: number };
              db.exec(input.sql);
              const after = db.prepare('SELECT total_changes() AS n').get() as { n: number };
              return { ok: true, summary: `${after.n - before.n} row(s) changed in ${input.file}`, output: { backup, changes: after.n - before.n }, filesChanged: [input.file] };
            } catch (error) {
              return failure('FAILED', `${redact((error as Error).message)} (backup kept at ${backup})`);
            } finally {
              db.close();
            }
          },
        }),
        operation({
          id: 'database.sqlite_backup',
          title: 'Back up SQLite',
          description: 'Consistent online backup of a SQLite file into the Control Center data folder.',
          input: z.object({ file }),
          level: 2,
          async run(input, ctx) {
            const abs = resolveDb(ctx, input.file);
            if (typeof abs !== 'string') return abs;
            await mkdir(backupDir(ctx), { recursive: true });
            const backup = path.join(backupDir(ctx), `${path.basename(abs)}-${Date.now()}.bak`);
            const db = openSqlite(abs, true);
            try {
              await db.backup(backup);
            } finally {
              db.close();
            }
            const s = await stat(backup);
            return { ok: true, summary: `Backed up ${input.file} (${s.size} bytes)`, output: { backup }, evidence: [`sqlite backup ${backup}`] };
          },
        }),
        operation({
          id: 'database.sqlite_restore',
          title: 'Restore SQLite from a backup',
          description: 'Replace a SQLite file with one of its backups (the current file is backed up first).',
          input: z.object({ file, backup: z.string().min(1).max(1000) }),
          level: 3,
          classify: () => ({ reasons: ['Replaces a database file with a backup'], effects: ['database', 'filesystem'] }),
          async run(input, ctx) {
            const abs = resolveDb(ctx, input.file);
            if (typeof abs !== 'string') return abs;
            let backup: string;
            try {
              backup = resolveInside([backupDir(ctx)], backupDir(ctx), input.backup);
            } catch (error) {
              return failure('OUTSIDE_ROOT', (error as Error).message);
            }
            const safety = path.join(backupDir(ctx), `${path.basename(abs)}-${Date.now()}-before-restore.bak`);
            await copyFile(abs, safety);
            await copyFile(backup, abs);
            return { ok: true, summary: `Restored ${input.file}; previous version kept`, output: { safety }, filesChanged: [input.file] };
          },
        }),
        operation({
          id: 'database.sqlite_integrity',
          title: 'SQLite integrity check',
          description: 'PRAGMA integrity_check and foreign_key_check.',
          input: z.object({ file }),
          level: 1,
          async run(input, ctx) {
            const abs = resolveDb(ctx, input.file);
            if (typeof abs !== 'string') return abs;
            const db = openSqlite(abs, true);
            try {
              const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
              const fk = db.prepare('PRAGMA foreign_key_check').all();
              const ok = integrity.length === 1 && integrity[0] === 'ok' && fk.length === 0;
              return { ok, summary: ok ? `${input.file}: integrity ok` : `${input.file}: ${integrity.length} integrity issue(s), ${fk.length} foreign key issue(s)`, output: { integrity, foreignKeys: fk }, evidence: [`sqlite integrity ${input.file}: ${ok ? 'ok' : 'problems'}`] };
            } finally {
              db.close();
            }
          },
        }),
      ],
    },
    {
      id: 'psql',
      name: 'PostgreSQL (psql)',
      description: 'Postgres queries through psql with a brokered connection string.',
      category: 'database',
      detect: (ctx) => detectExecutable(ctx, ['psql']),
      operations: [
        operation({
          id: 'database.postgres_query',
          title: 'Query Postgres',
          description: 'Run SQL against the `postgres` credential. Read-only statements run in a read-only transaction; writes need Level 3; destructive SQL asks.',
          input: z.object({ sql: z.string().min(1).max(200_000) }),
          level: 1,
          credentials: ['postgres'],
          classify: (i) => {
            const c = sqlClassify(i.sql);
            return c.level === 2 ? { ...c, level: 3 as PermissionLevel } : c;
          },
          run: (i, ctx) => cliQuery(ctx, 'postgres', i.sql, classifySql(i.sql).readOnly),
        }),
      ],
    },
    {
      id: 'mysql',
      name: 'MySQL client',
      description: 'MySQL queries through the mysql client with brokered credentials.',
      category: 'database',
      detect: (ctx) => detectExecutable(ctx, ['mysql']),
      operations: [
        operation({
          id: 'database.mysql_query',
          title: 'Query MySQL',
          description: 'Run SQL against the `mysql` credential; read-only statements run in a read-only session.',
          input: z.object({ sql: z.string().min(1).max(200_000) }),
          level: 1,
          credentials: ['mysql'],
          classify: (i) => {
            const c = sqlClassify(i.sql);
            return c.level === 2 ? { ...c, level: 3 as PermissionLevel } : c;
          },
          run: (i, ctx) => cliQuery(ctx, 'mysql', i.sql, classifySql(i.sql).readOnly),
        }),
      ],
    },
  ];
}
