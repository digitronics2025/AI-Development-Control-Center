import type { D1Database } from '@cloudflare/workers-types';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NodeRepository } from '@acc/shared';
import { CloudStore } from '../src/store.js';

function sqliteBinding(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  throw new Error('Unsupported SQLite binding');
}

describe('C1 atomic repository snapshot diff against SQLite', () => {
  let sqlite: DatabaseSync;
  let store: CloudStore;
  let writes: number[];
  const repo = (localId: string, fields: Partial<NodeRepository> = {}): NodeRepository => ({ localId, name: localId, fingerprint: 'a'.repeat(64), remoteHost: null, defaultBranch: null, ...fields });
  const rows = () => sqlite.prepare('SELECT node_id,local_id,name,fingerprint,remote_host,default_branch,updated_at FROM node_repositories ORDER BY node_id,local_id').all();
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/0001_control_plane.sql', import.meta.url), 'utf8'));
    sqlite.exec("INSERT INTO nodes(id,label,public_key,created_at,paired_by) VALUES ('one','One','{}','2026-09-01','fixture'),('two','Two','{}','2026-09-01','fixture')");
    writes = [];
    const prepare = (sql: string, bindings: SQLInputValue[] = []) => ({
      sql, bindings,
      bind(...values: unknown[]) { return prepare(sql, values.map(sqliteBinding)); },
      async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...bindings).changes) } }; },
    });
    const binding = {
      prepare,
      async batch(statements: Array<ReturnType<typeof prepare>>) {
        sqlite.exec('BEGIN');
        try {
          const result = statements.map((statement) => ({ success: true, meta: { changes: Number(sqlite.prepare(statement.sql).run(...statement.bindings).changes) } }));
          sqlite.exec('COMMIT');
          writes.push(result.reduce((sum, result) => sum + result.meta.changes, 0));
          return result;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    };
    store = new CloudStore(binding as unknown as D1Database);
  });
  afterEach(() => sqlite.close());

  it('writes zero for repeated/reordered inventories and changes only new, changed or gone rows', async () => {
    await store.setRepositories('one', [repo('a'), repo('b')]);
    await store.setRepositories('two', [repo('a')]);
    sqlite.exec("UPDATE node_repositories SET updated_at='2000-01-01'");
    const before = rows();
    await store.setRepositories('one', [repo('b'), repo('a')]);
    expect(writes.at(-1)).toBe(0);
    expect(rows()).toEqual(before);
    await store.setRepositories('one', [repo('a', { fingerprint: 'b'.repeat(64) }), repo('c')]);
    expect(writes.at(-1)).toBe(3);
    expect(rows().filter((row) => row.node_id === 'two')).toEqual(before.filter((row) => row.node_id === 'two'));
    expect(rows().filter((row) => row.node_id === 'one').map((row) => row.local_id)).toEqual(['a', 'c']);
  });

  it('detects all persisted metadata changes including null transitions', async () => {
    await store.setRepositories('one', [repo('a')]);
    for (const fields of [{ name: 'Renamed' }, { remoteHost: 'example.com' }, { defaultBranch: 'main' }, { remoteHost: null }, { defaultBranch: null }]) {
      const current = rows()[0]!;
      const next = repo('a', { name: String(current.name), remoteHost: current.remote_host === null ? null : String(current.remote_host), defaultBranch: current.default_branch === null ? null : String(current.default_branch), ...fields });
      await store.setRepositories('one', [next]);
      expect(writes.at(-1)).toBe(1);
      await store.setRepositories('one', [next]);
      expect(writes.at(-1)).toBe(0);
    }
  });

  it('supports large inventories without exceeding the D1 binding limit and node-scopes an empty snapshot', async () => {
    await store.setRepositories('one', Array.from({ length: 150 }, (_, i) => repo(`repo-${i}`)));
    await store.setRepositories('two', [repo('other')]);
    await store.setRepositories('one', Array.from({ length: 150 }, (_, i) => repo(`repo-${i}`)));
    expect(writes.at(-1)).toBe(0);
    await store.setRepositories('one', []);
    expect(writes.at(-1)).toBe(150);
    expect(rows().map((row) => row.node_id)).toEqual(['two']);
  });

  it('rejects duplicates and rolls back deletion when a later insert fails', async () => {
    await store.setRepositories('one', [repo('keep')]);
    const before = rows();
    await expect(store.setRepositories('one', [repo('duplicate'), repo('duplicate')])).rejects.toThrow('Duplicate');
    expect(rows()).toEqual(before);
    sqlite.exec("CREATE TRIGGER fail_new BEFORE INSERT ON node_repositories WHEN NEW.local_id='bad' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    await expect(store.setRepositories('one', [repo('bad')])).rejects.toThrow('injected failure');
    expect(rows()).toEqual(before);
  });
});
