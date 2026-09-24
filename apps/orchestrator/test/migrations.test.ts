import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newCredentialKey, openSecret, sealSecret, secretFingerprint } from '@acc/security';
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
    expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 6))).toEqual([6]);
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

/**
 * MyVault credential bridge (docs/plans/myvault-credential-bridge.md):
 * migration 7 adds metadata tables next to credential_references and leaves
 * every stored credential — ciphertext, fingerprint, scope — exactly as it was.
 */
describe('credential bridge migration (v6 → v7)', () => {
  it('keeps existing sealed credentials byte-identical and still openable', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-migrate-bridge-'));
    const db = openDatabase(path.join(dataDir, 'acc.db'));
    const previous = MIGRATIONS.filter((m) => m.version <= 6);
    migrate(db, previous);
    const key = newCredentialKey();
    const value = ['legacy', 'credential', 'value'].join('-');
    const sealed = sealSecret(key, value, 'cred-legacy');
    const ts = '2026-09-23T10:00:00.000Z';
    db.prepare(
      `INSERT INTO credential_references (id, name, kind, env_var, description, repository_ids, ciphertext, iv, tag, fingerprint, created_at, updated_at, last_used_at)
       VALUES ('cred-legacy', 'legacy', 'cloudflare', NULL, 'before the bridge', '["r1"]', ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(sealed.ciphertext, sealed.iv, sealed.tag, secretFingerprint(value), ts, ts);
    const before = db.prepare('SELECT * FROM credential_references').all();
    expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 7))).toEqual([7]);
    expect(schemaVersion(db)).toBe(7);
    expect(db.prepare('SELECT * FROM credential_references').all()).toEqual(before);
    const row = db.prepare('SELECT ciphertext, iv, tag FROM credential_references WHERE id = ?').get('cred-legacy') as { ciphertext: string; iv: string; tag: string };
    expect(openSecret(key, row, 'cred-legacy')).toBe(value);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('credential_vault_links', 'vault_bridge_origins', 'credential_events') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(['credential_events', 'credential_vault_links', 'vault_bridge_origins']);
    // A link follows its credential: deleting the credential removes the link, never the other way round.
    db.prepare("INSERT INTO credential_vault_links (credential_id, authority, state, created_at, updated_at) VALUES ('cred-legacy', 'control-center', 'pending_push', ?, ?)").run(ts, ts);
    db.prepare("DELETE FROM credential_references WHERE id = 'cred-legacy'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM credential_vault_links').get()).toEqual({ n: 0 });
    // The previous binary applies nothing and does not fail.
    expect(migrate(db, previous)).toEqual([]);
    db.close();
  });
});

/**
 * Chairman strategy outcomes (docs/systems/chairman.md): migration 8 adds
 * chairman_strategy_runs next to the decision audit, leaving every existing
 * Chairman row untouched.
 */
describe('chairman strategy outcomes migration (v7 → v8)', () => {
  it('adds strategy runs additively, keyed one-to-one on decisions', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-migrate-strategy-'));
    const db = openDatabase(path.join(dataDir, 'acc.db'));
    const previous = MIGRATIONS.filter((m) => m.version <= 7);
    migrate(db, previous);
    const ts = '2026-09-23T10:00:00.000Z';
    db.prepare("INSERT INTO repositories (id, name, path, created_at, updated_at) VALUES ('r1', 'kept', ?, ?, ?)").run(dataDir, ts, ts);
    db.prepare(
      `INSERT INTO tasks (id, seq, title, description, repository_id, workflow_id, workflow_snapshot, mode, status, current_stage_key, auto_approve_level, max_fix_cycles, fix_cycles, created_at, updated_at)
       VALUES ('TASK-0001', 1, 'Supervised', 'Before outcomes', 'r1', 'quick-change', '{}', 'autopilot', 'RUNNING', 'test', 3, 3, 0, ?, ?)`,
    ).run(ts, ts);
    db.prepare("INSERT INTO task_events (task_id, type, message, at) VALUES ('TASK-0001', 'TASK_CREATED', 'Task created', ?)").run(ts);
    db.prepare("INSERT INTO task_directives (id, task_id, text, status, created_at) VALUES ('d1', 'TASK-0001', 'Keep the API stable', 'applied', ?)").run(ts);
    db.prepare(
      `INSERT INTO chairman_decisions (id, task_id, source, trigger, task_version, summary, reasoning_summary, decision, expected_result, hard_blocker, health, reasoner, strategy_fingerprint, created_at)
       VALUES ('dec-1', 'TASK-0001', 'supervisor', 'repeated_failure', 3, 'Same failure', '', 'Root-cause analysis', 'Tests pass', 0, 'STALLED', 'policy', 'fp1', ?)`,
    ).run(ts);
    const tables = ['tasks', 'task_events', 'task_directives', 'chairman_decisions'];
    const before = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));

    expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 8))).toEqual([8]);
    expect(schemaVersion(db)).toBe(8);
    for (const t of tables) expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual(before[t]);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chairman_strategy_runs' AND name LIKE 'idx_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toEqual(['idx_chairman_strategy_runs_open', 'idx_chairman_strategy_runs_task']);

    const insert = (decisionId: string) =>
      db
        .prepare(
          `INSERT INTO chairman_strategy_runs (decision_id, task_id, contract_version, recovery_cycle, trigger, strategy_fingerprint, strategy_kind, target_stage_key, target_agent_id,
             failure_source, failure_stage_key, failure_category, failure_hash, failure_count, diagnosis_category, diagnosis_confidence, diagnosis_summary, diagnosis_source,
             evidence_digest, expected_result, status, outcome_summary, health_before, health_after, started_at, evaluated_at)
           VALUES (?, 'TASK-0001', 1, 1, 'repeated_failure', 'fp1', 'rca', 'investigate', NULL, 'tests', 'test', 'CODE_OR_TEST', 'h1', 2, 'CODE_OR_TEST', 'HIGH', 'Two tests fail', 'policy',
             'digest', 'Tests pass', 'RUNNING', NULL, 'STALLED', NULL, ?, NULL)`,
        )
        .run(decisionId, ts);
    insert('dec-1');
    // One strategy per decision, and only for a decision that exists.
    expect(() => insert('dec-1')).toThrow();
    expect(() => insert('no-such-decision')).toThrow();
    // A run follows its decision: deleting the task (or the decision) removes it.
    db.prepare("DELETE FROM chairman_decisions WHERE id = 'dec-1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM chairman_strategy_runs').get()).toEqual({ n: 0 });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    // The previous binary applies nothing and does not fail; re-running is a no-op.
    expect(migrate(db, previous)).toEqual([]);
    expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 8))).toEqual([]);
    db.close();
  });
});

/**
 * MyVault bridge identity (docs/plans/myvault-bridge-identity-pinning.md):
 * migration 9 adds one table for the key MyVault pins; nothing else changes.
 */
describe('bridge identity migration (v8 → v9)', () => {
  it('adds a single-row identity table and leaves the bridge tables untouched', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-migrate-identity-'));
    const db = openDatabase(path.join(dataDir, 'acc.db'));
    const previous = MIGRATIONS.filter((m) => m.version <= 8);
    migrate(db, previous);
    const ts = '2026-09-24T10:00:00.000Z';
    db.prepare("INSERT INTO vault_bridge_origins (origin, vault_id, trusted_at, last_connected_at) VALUES ('https://vault.example', 'v1', ?, NULL)").run(ts);
    const before = db.prepare('SELECT * FROM vault_bridge_origins').all();
    expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 9))).toEqual([9]);
    expect(schemaVersion(db)).toBe(9);
    expect(db.prepare('SELECT * FROM vault_bridge_origins').all()).toEqual(before);
    const insert = (id: number) => db.prepare("INSERT INTO vault_bridge_identity (id, public_key, private_key_ciphertext, private_key_iv, private_key_tag, created_at) VALUES (?, 'pk', 'ct', 'iv', 'tag', ?)").run(id, ts);
    insert(1);
    // One identity per database: a second row, under any id, is refused.
    expect(() => insert(1)).toThrow();
    expect(() => insert(2)).toThrow();
    expect(migrate(db, previous)).toEqual([]);
    db.close();
  });
});

/**
 * MyVault delivery box (docs/plans/secret-delivery-flow.md): migration 10 adds
 * the delivery targets and the deposit log; a deposit follows its credential.
 */
describe('delivery box migration (v9 → v10)', () => {
  it('adds the delivery tables additively and ties deposits to their credential', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-migrate-delivery-'));
    const db = openDatabase(path.join(dataDir, 'acc.db'));
    const previous = MIGRATIONS.filter((m) => m.version <= 9);
    migrate(db, previous);
    const ts = '2026-09-24T12:00:00.000Z';
    const key = newCredentialKey();
    const sealed = sealSecret(key, ['kept', 'value'].join('-'), 'cred-kept');
    db.prepare(
      `INSERT INTO credential_references (id, name, kind, env_var, description, repository_ids, ciphertext, iv, tag, fingerprint, created_at, updated_at, last_used_at)
       VALUES ('cred-kept', 'kept', 'other', NULL, '', '[]', ?, ?, ?, 'abcd1234', ?, ?, NULL)`,
    ).run(sealed.ciphertext, sealed.iv, sealed.tag, ts, ts);
    const before = db.prepare('SELECT * FROM credential_references').all();
    expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 10))).toEqual([10]);
    expect(db.prepare('SELECT * FROM credential_references').all()).toEqual(before);
    db.prepare("INSERT INTO vault_deposits (id, credential_id, origin, vault_id, fingerprint, status, created_at, updated_at) VALUES ('dep-1', 'cred-kept', 'https://vault.example', 'v1', 'abcd1234', 'stored', ?, ?)").run(ts, ts);
    db.prepare("DELETE FROM credential_references WHERE id = 'cred-kept'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM vault_deposits').get()).toEqual({ n: 0 });
    expect(migrate(db, previous)).toEqual([]);
    db.close();
  });
});
