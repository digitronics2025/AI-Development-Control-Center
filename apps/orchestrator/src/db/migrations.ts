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
  {
    version: 2,
    name: 'chairman supervisor',
    // Additive only: existing tasks keep supervised = 0 and behave exactly as
    // before; existing directives become active, task-wide instructions.
    sql: `
      ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN supervised INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN recovery_cycle INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN limits TEXT;
      ALTER TABLE tasks ADD COLUMN pause_after_stage INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN extra_check_kinds TEXT NOT NULL DEFAULT '[]';

      ALTER TABLE task_directives ADD COLUMN scope TEXT NOT NULL DEFAULT 'CURRENT_TASK';
      ALTER TABLE task_directives ADD COLUMN kind TEXT NOT NULL DEFAULT 'instruction';
      ALTER TABLE task_directives ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE task_directives ADD COLUMN normalized_rule TEXT;
      ALTER TABLE task_directives ADD COLUMN source_message_id TEXT;
      ALTER TABLE task_directives ADD COLUMN removed_at TEXT;
      ALTER TABLE task_directives ADD COLUMN superseded_by TEXT;

      CREATE TABLE task_contracts (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        goal TEXT NOT NULL,
        success_criteria TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT '{}',
        autonomy_mode TEXT NOT NULL,
        constraints TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, version)
      );

      CREATE TABLE chairman_sessions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        health TEXT NOT NULL DEFAULT 'UNKNOWN',
        strategy_summary TEXT,
        strategy_fingerprints TEXT NOT NULL DEFAULT '[]',
        last_decision_id TEXT,
        last_recovery_reason TEXT,
        degraded_reason TEXT,
        conversation_summary TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE chairman_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        intent TEXT,
        status TEXT NOT NULL,
        client_message_id TEXT,
        decision_id TEXT,
        action_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (task_id, seq)
      );
      CREATE UNIQUE INDEX idx_chairman_messages_client ON chairman_messages(task_id, client_message_id) WHERE client_message_id IS NOT NULL;

      CREATE TABLE chairman_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        trigger TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        summary TEXT NOT NULL,
        reasoning_summary TEXT NOT NULL,
        decision TEXT NOT NULL,
        expected_result TEXT NOT NULL,
        hard_blocker INTEGER NOT NULL DEFAULT 0,
        health TEXT NOT NULL,
        reasoner TEXT NOT NULL,
        strategy_fingerprint TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_chairman_decisions_task ON chairman_decisions(task_id, created_at);

      CREATE TABLE chairman_actions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        decision_id TEXT,
        message_id TEXT,
        type TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        initiator TEXT NOT NULL,
        source TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        result TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_chairman_actions_task ON chairman_actions(task_id, created_at);
      CREATE UNIQUE INDEX idx_chairman_actions_idem ON chairman_actions(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE failure_signatures (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_id TEXT,
        stage_key TEXT NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        signature TEXT NOT NULL,
        hash TEXT NOT NULL,
        failure_count INTEGER,
        message TEXT NOT NULL,
        recovery_cycle INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_failures_task ON failure_signatures(task_id, created_at);

      CREATE TABLE task_checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        label TEXT NOT NULL,
        reason TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        ref TEXT NOT NULL,
        head TEXT,
        stage_key TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (task_id, seq)
      );
    `,
  },
  {
    // Version 2 is the Chairman supervisor migration, developed in parallel;
    // the two touch different tables and apply in either order.
    version: 3,
    name: 'source control operation journal',
    // Audit and recovery records of Source Control mutations. Only bounded
    // operational metadata: never diffs, file contents, commands or credentials.
    sql: `
      CREATE TABLE git_operations (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        task_id TEXT,
        execution_id TEXT,
        idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        pre_head TEXT,
        post_head TEXT,
        pre_state_version TEXT,
        post_state_version TEXT,
        remote TEXT,
        ref TEXT,
        commit_sha TEXT,
        error_code TEXT,
        error_summary TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX idx_git_operations_idempotency ON git_operations(repository_id, idempotency_key);
      CREATE INDEX idx_git_operations_repository ON git_operations(repository_id, started_at);
      CREATE INDEX idx_git_operations_open ON git_operations(status) WHERE status IN ('started', 'uncertain');
      CREATE INDEX idx_git_operations_commit ON git_operations(commit_sha) WHERE commit_sha IS NOT NULL;
    `,
  },
  {
    version: 4,
    name: 'universal tool layer',
    // docs/plans/tool-layer-v2. Only operational metadata: tool inputs are
    // stored as redacted, bounded summaries; credential values only as
    // AES-GCM ciphertext under a DPAPI-protected key; terminal output and
    // tool output are never stored here.
    sql: `
      CREATE TABLE tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'builtin',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tool_capabilities (
        tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
        capability_id TEXT NOT NULL,
        permission_level INTEGER NOT NULL,
        PRIMARY KEY (tool_id, capability_id)
      );
      CREATE TABLE tool_health (
        tool_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        installed INTEGER NOT NULL,
        version TEXT,
        path TEXT,
        message TEXT,
        auth TEXT NOT NULL DEFAULT '{}',
        checked_at TEXT NOT NULL,
        auth_checked_at TEXT,
        duration_ms INTEGER
      );
      CREATE TABLE tool_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        stage_id TEXT,
        session_id TEXT,
        capability TEXT NOT NULL,
        provider_id TEXT,
        origin TEXT NOT NULL,
        decision TEXT NOT NULL,
        route_reason TEXT,
        permission_level INTEGER NOT NULL,
        risk TEXT NOT NULL,
        effects TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        summary TEXT,
        error_code TEXT,
        input_summary TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 1,
        recovery_of TEXT,
        artifacts TEXT NOT NULL DEFAULT '[]',
        files_changed TEXT NOT NULL DEFAULT '[]',
        network_targets TEXT NOT NULL DEFAULT '[]',
        evidence TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX idx_tool_executions_task ON tool_executions(task_id, started_at);
      CREATE INDEX idx_tool_executions_capability ON tool_executions(capability, started_at);
      CREATE TABLE pty_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        shell TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        owner_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        cols INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        exit_code INTEGER
      );
      CREATE TABLE task_processes (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        stage_id TEXT,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        process_started_at TEXT,
        port INTEGER,
        url TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        stopped_at TEXT,
        exit_code INTEGER,
        stop_reason TEXT
      );
      CREATE INDEX idx_task_processes_task ON task_processes(task_id);
      CREATE INDEX idx_task_processes_live ON task_processes(status) WHERE status IN ('starting', 'running', 'healthy', 'unhealthy');
      CREATE TABLE recovery_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        stage_id TEXT,
        command TEXT NOT NULL,
        category TEXT NOT NULL,
        strategy TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        evidence TEXT,
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_recovery_attempts_task ON recovery_attempts(task_id, created_at);
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL,
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env_credentials TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        permission_level INTEGER NOT NULL DEFAULT 2,
        allowed_tools TEXT,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        health TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE capability_escalations (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        stage_id TEXT,
        session_id TEXT,
        capability TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        permission_level INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_capability_escalations_task ON capability_escalations(task_id, created_at);
      CREATE TABLE credential_references (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        env_var TEXT,
        description TEXT NOT NULL DEFAULT '',
        repository_ids TEXT,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );
      ALTER TABLE task_checkpoints ADD COLUMN type TEXT NOT NULL DEFAULT 'git';
      ALTER TABLE task_checkpoints ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE tasks ADD COLUMN policy_mode TEXT;
      ALTER TABLE repositories ADD COLUMN policy_mode TEXT;
      ALTER TABLE repositories ADD COLUMN runtime TEXT NOT NULL DEFAULT '{}';
    `,
  },
];
