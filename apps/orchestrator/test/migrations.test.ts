import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServices } from '../src/app.js';
import type { OrchestratorConfig } from '../src/config.js';
import { migrate, openDatabase, schemaVersion } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { ROOT, simAdapters, TOKEN } from './helpers.js';

/**
 * Plan §7.6: the Chairman migration against a database written by the
 * previous version. Old tasks must load unchanged, stay unsupervised and
 * keep every row of history.
 */
describe('chairman migration (v1 → v2)', () => {
  it('upgrades an existing database without losing or changing old tasks', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-migrate-'));
    const file = path.join(dataDir, 'acc.db');
    const old = openDatabase(file);
    migrate(old, MIGRATIONS.filter((m) => m.version === 1));
    expect(schemaVersion(old)).toBe(1);
    const ts = '2026-09-01T10:00:00.000Z';
    old.prepare("INSERT INTO repositories (id, name, path, created_at, updated_at) VALUES ('r1', 'legacy', ?, ?, ?)").run(dataDir, ts, ts);
    const workflow = JSON.stringify({ id: 'quick-change', name: 'Quick Change', description: '', version: 1, maxFixCycles: 2, builtin: true, stages: [{ key: 'implement', name: 'Implement', role: 'implementer', kind: 'agent', permissionLevel: 2, timeoutSec: 60, retry: { maxAttempts: 1 }, requiresApproval: false, next: 'complete', verdict: false, optional: false }] });
    old
      .prepare(
        `INSERT INTO tasks (id, seq, title, description, repository_id, workflow_id, workflow_snapshot, mode, status, current_stage_key, auto_approve_level, max_fix_cycles, fix_cycles, blocker, created_at, updated_at)
         VALUES ('TASK-0001', 1, 'Old task', 'Made before the Chairman', 'r1', 'quick-change', ?, 'autopilot', 'WAITING_FOR_USER', 'implement', 3, 2, 2, ?, ?, ?)`,
      )
      .run(workflow, JSON.stringify({ kind: 'fix_limit', message: 'Fix limit reached', stageKey: 'implement' }), ts, ts);
    old.prepare("INSERT INTO task_directives (id, task_id, text, status, created_at) VALUES ('d1', 'TASK-0001', 'Keep the API stable', 'applied', ?)").run(ts);
    old.prepare("INSERT INTO task_events (task_id, type, message, at) VALUES ('TASK-0001', 'TASK_CREATED', 'Task created', ?)").run(ts);
    old.close();

    const config: OrchestratorConfig = { host: '127.0.0.1', port: 0, dataDir, resourcesDir: ROOT, dashboardDir: null, token: TOKEN, simulatedAgents: true, repositoryAutomation: false, allowedOrigins: [], version: 'test' };
    const services = createServices(config, { adapters: simAdapters() });
    try {
      expect(schemaVersion(services.db)).toBe(MIGRATIONS.at(-1)!.version);
      const task = services.store.getTask('TASK-0001')!;
      expect(task).toMatchObject({ title: 'Old task', status: 'WAITING_FOR_USER', fixCycles: 2, supervised: false, recoveryCycle: 0, limits: null, version: 0, pauseAfterStage: false, extraCheckKinds: [] });
      expect(task.blocker).toMatchObject({ kind: 'fix_limit' });
      expect(services.store.listDirectives('TASK-0001')).toEqual([expect.objectContaining({ id: 'd1', state: 'active', scope: 'CURRENT_TASK', kind: 'instruction', rule: null })]);
      expect(services.store.listEvents('TASK-0001')).toHaveLength(1);
      // The Chairman can describe an old task (its contract is created on first use) without taking it over.
      const overview = services.chairman.overview('TASK-0001');
      expect(overview.state).toMatchObject({ supervised: false, status: 'off' });
      expect(overview.contract).toMatchObject({ version: 1, goal: 'Old task\n\nMade before the Chairman' });
      expect(services.engine.detail('TASK-0001').supervised).toBe(false);
      // Re-running the migrations is a no-op.
      expect(migrate(services.db)).toEqual([]);
    } finally {
      await services.close();
    }
  });
});

/**
 * Cloud control plane (docs/systems/remote-node.md): migration 6 adds the
 * remote-node tables to a v5 database without touching existing rows, and a
 * v5 binary opening the upgraded file finds nothing to apply.
 */
describe('remote node migration (v5 → v6)', () => {
  it('adds the remote tables additively and stays readable by the previous binary', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-migrate-remote-'));
    const db = openDatabase(path.join(dataDir, 'acc.db'));
    const previous = MIGRATIONS.filter((m) => m.version <= 5);
    migrate(db, previous);
    const ts = '2026-09-23T10:00:00.000Z';
    db.prepare("INSERT INTO repositories (id, name, path, created_at, updated_at) VALUES ('r1', 'kept', ?, ?, ?)").run(dataDir, ts, ts);
    expect(migrate(db)).toEqual([6]);
    expect(schemaVersion(db)).toBe(6);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'remote_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(['remote_artifact_sync', 'remote_commands_received', 'remote_config', 'remote_outbox', 'remote_sync_state']);
    expect(db.prepare('SELECT name FROM repositories').all()).toEqual([{ name: 'kept' }]);
    // The previous binary knows migrations 1–5 only: it applies nothing and does not fail.
    expect(migrate(db, previous)).toEqual([]);
    // A second config row is impossible: the node has exactly one identity.
    db.prepare("INSERT INTO remote_config (id, relay_url, node_id, label, public_key, private_key_ciphertext, private_key_iv, private_key_tag, paired_at, updated_at) VALUES (1, 'u', 'n', 'l', '{}', 'c', 'i', 't', ?, ?)").run(ts, ts);
    expect(() => db.prepare("INSERT INTO remote_config (id, relay_url, node_id, label, public_key, private_key_ciphertext, private_key_iv, private_key_tag, paired_at, updated_at) VALUES (2, 'u', 'n', 'l', '{}', 'c', 'i', 't', ?, ?)").run(ts, ts)).toThrow();
    db.close();
  });
});
