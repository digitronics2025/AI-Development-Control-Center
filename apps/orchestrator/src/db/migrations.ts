/**
 * Versioned, forward-only schema migrations. Each entry runs once inside a
 * transaction and is recorded in `schema_migrations`. Never edit a shipped
 * migration — add a new one.
 *
 * Secrets are never stored: command strings, log lines, artifacts and error
 * messages are redacted before they reach these tables.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        default_workflow_id TEXT,
        role_overrides TEXT NOT NULL DEFAULT '{}',
        commands TEXT NOT NULL DEFAULT '[]',
        git_mode TEXT NOT NULL DEFAULT 'task-branch',
        auto_approve_level INTEGER,
        tooling TEXT NOT NULL DEFAULT '[]',
        last_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        executable_path TEXT,
        load_user_config INTEGER NOT NULL DEFAULT 1,
        detection TEXT,
        health TEXT,
        capabilities TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE models (
        agent_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        label TEXT NOT NULL,
        efforts TEXT NOT NULL DEFAULT '[]',
        default_effort TEXT,
        source TEXT NOT NULL,
        description TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, model_id)
      );

      CREATE TABLE workflow_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL,
        max_fix_cycles INTEGER NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workflow_stages (
        profile_id TEXT NOT NULL REFERENCES workflow_profiles(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        key TEXT NOT NULL,
        definition TEXT NOT NULL,
        PRIMARY KEY (profile_id, key)
      );

      CREATE TABLE prompt_templates (
        role TEXT NOT NULL,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (role, version)
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        workflow_id TEXT NOT NULL,
        workflow_snapshot TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage_key TEXT,
        current_stage_id TEXT,
        overrides TEXT NOT NULL DEFAULT '{"roles":{},"stages":{}}',
        auto_approve_level INTEGER NOT NULL,
        max_fix_cycles INTEGER NOT NULL,
        fix_cycles INTEGER NOT NULL DEFAULT 0,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        blocker TEXT,
        last_event TEXT,
        final_status TEXT,
        git TEXT NOT NULL DEFAULT '{}',
        attachments TEXT NOT NULL DEFAULT '[]',
        prompt_versions TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_repository ON tasks(repository_id);
      CREATE INDEX idx_tasks_updated ON tasks(updated_at);

      CREATE TABLE task_stages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_key TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_id TEXT,
        model TEXT,
        effort TEXT,
        permission_level INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        cycle INTEGER NOT NULL DEFAULT 0,
        verdict TEXT,
        summary TEXT,
        error_class TEXT,
        error_message TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_stages_task ON task_stages(task_id, created_at);

      CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_id TEXT,
        kind TEXT NOT NULL,
        agent_id TEXT,
        model TEXT,
        effort TEXT,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        error_class TEXT,
        error_message TEXT,
        pid INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX idx_executions_task ON executions(task_id, started_at);
      CREATE INDEX idx_executions_status ON executions(status);

      CREATE TABLE execution_logs (
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        stream TEXT NOT NULL,
        text TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (execution_id, seq)
      );

      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        stage_id TEXT,
        message TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        at TEXT NOT NULL
      );
      CREATE INDEX idx_events_task ON task_events(task_id, id);

      CREATE TABLE task_directives (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        applied_stage_key TEXT
      );
      CREATE INDEX idx_directives_task ON task_directives(task_id, created_at);

      CREATE TABLE task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_id TEXT,
        stage_key TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_artifacts_task ON task_artifacts(task_id, created_at);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_id TEXT,
        stage_key TEXT,
        kind TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT,
        permission_level INTEGER NOT NULL,
        risk TEXT NOT NULL,
        reason TEXT NOT NULL,
        risk_explanation TEXT NOT NULL,
        environment TEXT,
        confirmation_phrase TEXT,
        status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX idx_approvals_status ON approvals(status, created_at);
      CREATE INDEX idx_approvals_task ON approvals(task_id);

      CREATE TABLE git_snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_id TEXT,
        kind TEXT NOT NULL,
        branch TEXT,
        head TEXT,
        files TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_snapshots_task ON git_snapshots(task_id, created_at);

      CREATE TABLE test_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_id TEXT,
        execution_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        duration_ms INTEGER,
        summary TEXT,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX idx_test_runs_task ON test_runs(task_id, started_at);
    `,
  },
];
