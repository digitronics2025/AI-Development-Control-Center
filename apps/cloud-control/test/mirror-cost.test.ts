import type { D1Database } from '@cloudflare/workers-types';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboxEvent } from '@acc/shared';
import { CloudStore, ENTITY_REFRESH_MS } from '../src/store.js';

function sqliteBinding(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  throw new Error('Unsupported SQLite binding');
}

/** Mirror ingest writes only what changed (docs/systems/cloud-control.md § Data). */
describe('mirror ingest writes on change only, against SQLite', () => {
  let sqlite: DatabaseSync;
  let store: CloudStore;
  /** Rows changed per batch, the cursor UPDATE excluded (it is the last statement). */
  let writes: number[];
  let seq = 0;
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/0001_control_plane.sql', import.meta.url), 'utf8'));
    sqlite.exec("INSERT INTO nodes(id,label,public_key,created_at,paired_by) VALUES ('one','One','{}','2026-09-01','fixture')");
    writes = [];
    seq = 0;
    const prepare = (sql: string, bindings: SQLInputValue[] = []) => ({
      sql, bindings,
      bind(...values: unknown[]) { return prepare(sql, values.map(sqliteBinding)); },
      async first<T>() { return (sqlite.prepare(sql).get(...bindings) as T | undefined) ?? null; },
      async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...bindings).changes) } }; },
    });
    const binding = {
      prepare,
      async batch(statements: Array<ReturnType<typeof prepare>>) {
        sqlite.exec('BEGIN');
        try {
          const result = statements.map((statement) => ({ success: true, meta: { changes: Number(sqlite.prepare(statement.sql).run(...statement.bindings).changes) } }));
          sqlite.exec('COMMIT');
          writes.push(result.slice(0, -1).reduce((sum, r) => sum + r.meta.changes, 0));
          return result;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    };
    store = new CloudStore(binding as unknown as D1Database);
  });
  afterEach(() => sqlite.close());

  const message = (payload: unknown): OutboxEvent => ({ seq: ++seq, kind: 'message', payload } as OutboxEvent);
  const repository = (checkedAt: string, fields: Record<string, unknown> = {}) => message({ type: 'repository', repository: { id: 'r1', name: 'App', status: { checkedAt, branch: 'main', dirty: false }, ...fields } });
  const entityJson = () => (sqlite.prepare("SELECT json FROM cloud_entities WHERE entity_id = 'r1'").get() as { json: string }).json;

  it('skips a repository repeat that only moved its check time, and writes real changes', async () => {
    expect((await store.ingest('one', [repository('2026-10-07T01:00:00.000Z')])).advanced).toBe(true);
    expect(writes.at(-1)).toBe(1);
    await store.ingest('one', [repository('2026-10-07T01:05:00.000Z')]);
    expect(writes.at(-1)).toBe(0);
    expect(JSON.parse(entityJson()).status.checkedAt).toBe('2026-10-07T01:00:00.000Z');
    await store.ingest('one', [repository('2026-10-07T01:10:00.000Z', { name: 'Renamed' })]);
    expect(writes.at(-1)).toBe(1);
    expect(JSON.parse(entityJson()).status.checkedAt).toBe('2026-10-07T01:10:00.000Z');
    // The cursor still moves on every batch, so the node's acknowledgement stays exact.
    expect(await store.lastEventSeq('one')).toBe(3);
  });

  it('refreshes an unchanged entity once its copy is older than the refresh window', async () => {
    await store.ingest('one', [repository('2026-10-07T01:00:00.000Z')]);
    sqlite.prepare("UPDATE cloud_entities SET updated_at = ?").run(new Date(Date.now() - ENTITY_REFRESH_MS - 60_000).toISOString());
    await store.ingest('one', [repository('2026-10-07T09:00:00.000Z')]);
    expect(writes.at(-1)).toBe(1);
    expect(JSON.parse(entityJson()).status.checkedAt).toBe('2026-10-07T09:00:00.000Z');
  });

  it('compares array entities (agents) and the other mirrored kinds without error', async () => {
    const agents = (state: string) => message({ type: 'agents', agents: [{ id: 'claude', health: { state, checkedAt: '2026-10-07T01:00:00.000Z' } }] });
    await store.ingest('one', [agents('ready')]);
    await store.ingest('one', [agents('ready')]);
    expect(writes.at(-1)).toBe(0);
    await store.ingest('one', [agents('error')]);
    expect(writes.at(-1)).toBe(1);
    const approval = (status: string) => message({ type: 'approval', approval: { id: 'a1', taskId: 't1', status } });
    await store.ingest('one', [approval('pending')]);
    await store.ingest('one', [approval('pending')]);
    expect(writes.at(-1)).toBe(0);
    await store.ingest('one', [approval('approved')]);
    expect(writes.at(-1)).toBe(1);
  });

  it('skips an unchanged task, task detail and usage event', async () => {
    const task = (status: string) => message({ type: 'task', task: { id: 't1', title: 'Fix', status, version: 1, createdAt: '2026-10-07T01:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z' } });
    const detail = (summary: string): OutboxEvent => ({ seq: ++seq, kind: 'taskDetail', payload: { taskId: 't1', detail: { summary } } } as OutboxEvent);
    const usage = (cost: number) => message({ type: 'usage', event: { id: 'u1', taskId: 't1', provider: 'anthropic', model: 'x', startedAt: '2026-10-07T01:00:00.000Z', displayCostNanos: cost } });
    await store.ingest('one', [task('RUNNING'), detail('a'), usage(5)]);
    expect(writes.at(-1)).toBe(3);
    await store.ingest('one', [task('RUNNING'), detail('a'), usage(5)]);
    expect(writes.at(-1)).toBe(0);
    await store.ingest('one', [task('PAUSED'), detail('b'), usage(6)]);
    expect(writes.at(-1)).toBe(3);
  });

  it('reports no cursor move for a batch the cloud already stored', async () => {
    const event = repository('2026-10-07T01:00:00.000Z');
    await store.ingest('one', [event]);
    expect((await store.ingest('one', [event])).advanced).toBe(false);
  });

  it('checks revocation without writing', async () => {
    expect(await store.isActive('one')).toBe(true);
    sqlite.exec("UPDATE nodes SET revoked_at = '2026-10-07' WHERE id = 'one'");
    expect(await store.isActive('one')).toBe(false);
    expect(await store.isActive('missing')).toBe(false);
  });
});
