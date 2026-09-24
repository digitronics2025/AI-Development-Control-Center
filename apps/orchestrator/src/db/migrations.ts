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
    name: 'usage, cost and capacity ledger',
    // docs/systems/usage.md. One row per actual provider attempt, append-only:
    // triggers refuse deletes and any change except costing an attempt whose
    // cost was Unknown (audited in usage_cost_revisions). Money is integer
    // nano-dollars. No foreign keys to tasks: financial history outlives them.
    // Only counts, identifiers, timings and a prompt hash are stored — never
    // prompts, responses or credentials.
    sql: `
      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL,
        provider TEXT NOT NULL,
        billing TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_model_id TEXT,
        provider_request_id TEXT,
        project_id TEXT,
        task_id TEXT,
        run_id TEXT,
        workflow_id TEXT,
        workflow_step TEXT,
        agent_role TEXT,
        mode TEXT,
        effort TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        api_duration_ms INTEGER,
        turns INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        retry_index INTEGER NOT NULL DEFAULT 0,
        retry_parent_event_id TEXT,
        attempt_reason TEXT NOT NULL,
        fallback_from_model TEXT,
        fallback_to_model TEXT,
        provider_cost_nanos INTEGER,
        calculated_cost_nanos INTEGER,
        display_cost_nanos INTEGER,
        currency TEXT NOT NULL DEFAULT 'USD',
        cost_source TEXT NOT NULL,
        pricing_version_id TEXT,
        status TEXT NOT NULL,
        error_class TEXT,
        prompt_chars INTEGER,
        prompt_hash TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_usage_started ON usage_events(started_at);
      CREATE INDEX idx_usage_task ON usage_events(task_id, started_at) WHERE task_id IS NOT NULL;
      CREATE INDEX idx_usage_project ON usage_events(project_id, started_at);
      CREATE INDEX idx_usage_provider ON usage_events(provider, started_at);
      CREATE INDEX idx_usage_agent_role ON usage_events(agent_role, started_at);
      CREATE INDEX idx_usage_run ON usage_events(run_id) WHERE run_id IS NOT NULL;
      CREATE INDEX idx_usage_prompt ON usage_events(prompt_hash, started_at) WHERE prompt_hash IS NOT NULL;
      CREATE INDEX idx_usage_unknown ON usage_events(cost_source) WHERE cost_source = 'UNKNOWN';

      CREATE TABLE usage_event_lines (
        event_id TEXT NOT NULL REFERENCES usage_events(id),
        line_no INTEGER NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cache_write_1h_tokens INTEGER,
        reasoning_tokens INTEGER,
        provider_cost_nanos INTEGER,
        calculated_cost_nanos INTEGER,
        pricing_version_id TEXT,
        PRIMARY KEY (event_id, line_no)
      );
      CREATE INDEX idx_usage_lines_model ON usage_event_lines(model);

      CREATE TABLE usage_cost_revisions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES usage_events(id),
        previous_source TEXT NOT NULL,
        new_source TEXT NOT NULL,
        calculated_cost_nanos INTEGER,
        pricing_version_id TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_usage_revisions_event ON usage_cost_revisions(event_id);

      -- Attempts dispatched but not yet recorded: an attempt still here at
      -- startup was interrupted and is recorded as such (usage unknown).
      CREATE TABLE usage_pending (
        idempotency_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        started_at TEXT NOT NULL
      );

      CREATE TRIGGER usage_events_append_only BEFORE DELETE ON usage_events
      BEGIN SELECT RAISE(ABORT, 'usage events are append-only'); END;
      CREATE TRIGGER usage_events_immutable BEFORE UPDATE OF
        id, idempotency_key, origin, provider, billing, agent_id, model, provider_model_id, provider_request_id,
        project_id, task_id, run_id, workflow_id, workflow_step, agent_role, mode, effort,
        started_at, finished_at, duration_ms, api_duration_ms, turns,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
        retry_index, retry_parent_event_id, attempt_reason, fallback_from_model, fallback_to_model,
        provider_cost_nanos, currency, status, error_class, prompt_chars, prompt_hash, metadata_json, created_at
        ON usage_events
      BEGIN SELECT RAISE(ABORT, 'usage events are immutable'); END;
      CREATE TRIGGER usage_events_cost_once BEFORE UPDATE OF calculated_cost_nanos, display_cost_nanos, cost_source, pricing_version_id
        ON usage_events WHEN OLD.cost_source <> 'UNKNOWN'
      BEGIN SELECT RAISE(ABORT, 'only an attempt with an unknown cost can be costed later'); END;
      CREATE TRIGGER usage_lines_append_only BEFORE DELETE ON usage_event_lines
      BEGIN SELECT RAISE(ABORT, 'usage events are append-only'); END;
      CREATE TRIGGER usage_lines_immutable BEFORE UPDATE OF
        event_id, line_no, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, provider_cost_nanos
        ON usage_event_lines
      BEGIN SELECT RAISE(ABORT, 'usage events are immutable'); END;

      CREATE TABLE pricing_versions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_model_id TEXT NOT NULL,
        input_nanos INTEGER NOT NULL,
        output_nanos INTEGER NOT NULL,
        cache_read_nanos INTEGER,
        cache_write_nanos INTEGER,
        cache_write_1h_nanos INTEGER,
        currency TEXT NOT NULL DEFAULT 'USD',
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        source TEXT NOT NULL,
        verification TEXT NOT NULL,
        last_verified_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_pricing_model ON pricing_versions(provider, provider_model_id, effective_from);

      CREATE TABLE capacity_snapshots (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        label TEXT NOT NULL,
        used_percent REAL,
        remaining_percent REAL,
        status TEXT NOT NULL,
        reset_at TEXT,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        detail TEXT,
        event_id TEXT
      );
      CREATE INDEX idx_capacity_metric ON capacity_snapshots(agent_id, metric, captured_at);

      CREATE TABLE budgets (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        period TEXT NOT NULL,
        amount_nanos INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        warning_threshold REAL NOT NULL,
        critical_threshold REAL NOT NULL,
        policy TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- One budget per scope and period: two would contradict each other.
      CREATE UNIQUE INDEX idx_budgets_scope ON budgets(scope_type, COALESCE(scope_id, ''), period);

      -- Anthropic first-party list prices per token in nano-dollars ($1/MTok = 1000).
      -- Haiku 4.5 matched Claude Code's own costUSD to the nano-dollar on 2026-09-23.
      INSERT INTO pricing_versions (id, provider, provider_model_id, input_nanos, output_nanos, cache_read_nanos, cache_write_nanos, cache_write_1h_nanos, effective_from, source, verification, last_verified_at, created_at) VALUES
        ('seed-claude-fable-5-1', 'anthropic', 'claude-fable-5-1', 10000, 50000, 250, 12500, 20000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24)', 'documented', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
        ('seed-claude-fable-5', 'anthropic', 'claude-fable-5', 10000, 50000, 1000, 12500, 20000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24)', 'documented', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
        ('seed-claude-opus-5-5', 'anthropic', 'claude-opus-5-5', 4000, 20000, 200, 5000, 8000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24); cache-write rates derived from the standard multipliers, to confirm at launch', 'unverified', NULL, '2026-09-23T00:00:00.000Z'),
        ('seed-claude-opus-5', 'anthropic', 'claude-opus-5', 5000, 25000, 500, 6250, 10000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24)', 'documented', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
        ('seed-claude-opus-4-8', 'anthropic', 'claude-opus-4-8', 5000, 25000, 500, 6250, 10000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24)', 'documented', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
        ('seed-claude-opus-4-7', 'anthropic', 'claude-opus-4-7', 5000, 25000, 500, 6250, 10000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24)', 'documented', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
        ('seed-claude-opus-4-6', 'anthropic', 'claude-opus-4-6', 5000, 25000, 500, 6250, 10000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24)', 'documented', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
        ('seed-claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 2000, 10000, 200, 2500, 4000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24)', 'documented', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
        ('seed-claude-sonnet-4-6', 'anthropic', 'claude-sonnet-4-6', 3000, 15000, 300, 3750, 6000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices (Claude API reference, 2026-06-24)', 'documented', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
        ('seed-claude-haiku-4-5', 'anthropic', 'claude-haiku-4-5', 1000, 5000, 100, 1250, 2000, '2026-01-01T00:00:00.000Z', 'Anthropic API list prices; matched Claude Code costUSD exactly (2026-09-23)', 'verified', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    `,
  },
  {
    // Version 4 is taken by the usage ledger, developed in parallel; the two
    // touch different tables and apply in either order.
    version: 5,
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
  {
    // Cloud control plane: this machine as a remote execution node
    // (docs/systems/remote-node.md). Additive only; an older binary ignores these tables.
    version: 6,
    name: 'remote execution node',
    sql: `
      CREATE TABLE remote_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        relay_url TEXT NOT NULL,
        node_id TEXT NOT NULL,
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        public_key TEXT NOT NULL,
        private_key_ciphertext TEXT NOT NULL,
        private_key_iv TEXT NOT NULL,
        private_key_tag TEXT NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1,
        remote_terminals INTEGER NOT NULL DEFAULT 0,
        remote_tools INTEGER NOT NULL DEFAULT 0,
        paired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE remote_sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        acked_seq INTEGER NOT NULL DEFAULT 0,
        usage_cursor TEXT,
        resync_required INTEGER NOT NULL DEFAULT 1,
        last_connected_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE remote_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE remote_commands_received (
        command_id TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER,
        result TEXT,
        error_code TEXT,
        received_at TEXT NOT NULL,
        finished_at TEXT,
        reported_at TEXT
      );
      CREATE INDEX idx_remote_commands_unreported ON remote_commands_received(reported_at, received_at);
      CREATE TABLE remote_artifact_sync (
        object_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_id TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        status TEXT NOT NULL,
        sha256 TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_remote_artifact_sync_due ON remote_artifact_sync(status, next_attempt_at);
    `,
  },
  {
    // MyVault credential bridge (docs/plans/myvault-credential-bridge.md).
    // Metadata only: values stay AES-GCM ciphertext in credential_references;
    // these tables hold ids, states, fingerprints and redacted notes.
    version: 7,
    name: 'myvault credential bridge',
    sql: `
      CREATE TABLE vault_bridge_origins (
        origin TEXT PRIMARY KEY,
        vault_id TEXT,
        trusted_at TEXT NOT NULL,
        last_connected_at TEXT
      );
      CREATE TABLE credential_vault_links (
        credential_id TEXT PRIMARY KEY REFERENCES credential_references(id) ON DELETE CASCADE,
        authority TEXT NOT NULL,
        origin TEXT,
        vault_id TEXT,
        vault_item_id TEXT,
        state TEXT NOT NULL,
        synced_fingerprint TEXT,
        vault_fingerprint TEXT,
        replace_vault_fingerprint TEXT,
        vault_updated_at TEXT,
        first_synced_at TEXT,
        last_synced_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_credential_vault_links_item ON credential_vault_links(origin, vault_id, vault_item_id) WHERE vault_item_id IS NOT NULL;
      CREATE INDEX idx_credential_vault_links_state ON credential_vault_links(state);
      CREATE TABLE credential_events (
        id TEXT PRIMARY KEY,
        credential_id TEXT,
        credential_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        direction TEXT,
        status TEXT NOT NULL,
        task_id TEXT,
        target TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_credential_events_credential ON credential_events(credential_id, created_at);
    `,
  },
  {
    // Chairman strategy outcomes (docs/systems/chairman.md §Strategy outcomes):
    // one row per recovery decision with its diagnosis and the objectively
    // observed result. Structured metadata only — no logs, prompts or replies.
    version: 8,
    name: 'chairman strategy outcomes',
    sql: `
      CREATE TABLE chairman_strategy_runs (
        decision_id TEXT PRIMARY KEY REFERENCES chairman_decisions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        contract_version INTEGER NOT NULL,
        recovery_cycle INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        strategy_fingerprint TEXT NOT NULL,
        strategy_kind TEXT NOT NULL,
        target_stage_key TEXT,
        target_agent_id TEXT,
        failure_source TEXT NOT NULL,
        failure_stage_key TEXT NOT NULL,
        failure_category TEXT NOT NULL,
        failure_hash TEXT NOT NULL,
        failure_count INTEGER,
        diagnosis_category TEXT NOT NULL,
        diagnosis_confidence TEXT NOT NULL,
        diagnosis_summary TEXT NOT NULL,
        diagnosis_source TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        expected_result TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome_summary TEXT,
        health_before TEXT NOT NULL,
        health_after TEXT,
        started_at TEXT NOT NULL,
        evaluated_at TEXT
      );
      CREATE INDEX idx_chairman_strategy_runs_task ON chairman_strategy_runs(task_id, started_at);
      CREATE INDEX idx_chairman_strategy_runs_open ON chairman_strategy_runs(task_id, status);
    `,
  },
  {
    // The Control Center's MyVault bridge identity
    // (docs/plans/myvault-bridge-identity-pinning.md): one ECDSA P-256 key
    // MyVault pins. The private half is sealed with the broker key, never plain.
    version: 9,
    name: 'myvault bridge identity',
    sql: `
      CREATE TABLE vault_bridge_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_key TEXT NOT NULL,
        private_key_ciphertext TEXT NOT NULL,
        private_key_iv TEXT NOT NULL,
        private_key_tag TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    // MyVault delivery box (docs/plans/secret-delivery-flow.md): where to leave
    // a newly generated secret sealed for MyVault while no bridge session is
    // open, and what was left. The sender token is sealed with the broker key.
    version: 10,
    name: 'myvault delivery box',
    sql: `
      CREATE TABLE vault_deposit_targets (
        origin TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        token_ciphertext TEXT NOT NULL,
        token_iv TEXT NOT NULL,
        token_tag TEXT NOT NULL,
        last_error TEXT,
        last_error_kind TEXT,
        last_deposit_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE vault_deposits (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES credential_references(id) ON DELETE CASCADE,
        origin TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt_status TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_vault_deposits_status ON vault_deposits(status);
      CREATE INDEX idx_vault_deposits_credential ON vault_deposits(credential_id);
    `,
  },
  {
    // Learning loop (docs/plans/learning-loop.md): one review per finished
    // task, findings aggregated across tasks by fingerprint, the improvements
    // the Chairman adopted on its own (with their trial counts), and a short
    // activity log. Structured summaries only: no prompts, logs or file contents.
    version: 11,
    name: 'learning loop',
    sql: `
      CREATE TABLE learning_reviews (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        repository_id TEXT,
        status TEXT NOT NULL,
        reviewer TEXT,
        signals TEXT NOT NULL DEFAULT '[]',
        finding_ids TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_learning_reviews_status ON learning_reviews(status, created_at);
      CREATE TABLE learning_findings (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        repository_id TEXT,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        proposal TEXT,
        confidence TEXT NOT NULL,
        observed INTEGER NOT NULL DEFAULT 0,
        occurrences INTEGER NOT NULL DEFAULT 0,
        task_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        status_reason TEXT,
        improvement_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_learning_findings_status ON learning_findings(status, last_seen_at);
      CREATE TABLE learning_observations (
        finding_id TEXT NOT NULL REFERENCES learning_findings(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        signal_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (finding_id, task_id)
      );
      CREATE TABLE learning_improvements (
        id TEXT PRIMARY KEY,
        finding_id TEXT REFERENCES learning_findings(id) ON DELETE SET NULL,
        fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        repository_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        content_hash TEXT,
        status TEXT NOT NULL,
        trial_target INTEGER NOT NULL,
        trial_seen INTEGER NOT NULL DEFAULT 0,
        trial_recurrences INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reverted_at TEXT,
        reverted_by TEXT
      );
      CREATE INDEX idx_learning_improvements_status ON learning_improvements(status, repository_id);
      CREATE INDEX idx_learning_improvements_fingerprint ON learning_improvements(fingerprint);
      CREATE TABLE learning_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        task_id TEXT,
        finding_id TEXT,
        improvement_id TEXT,
        message TEXT NOT NULL
      );
    `,
  },
  {
    // Connected apps (docs/plans/private-browser-control-center-link.md): a
    // paired local app — Private Browser — that may create tasks from evidence
    // the operator approved, read those tasks, and attach re-check evidence.
    // Metadata only: the app's token is kept as a SHA-256 hash, and evidence
    // lives in task attachments and artifacts like every other task file.
    version: 12,
    name: 'connected apps',
    sql: `
      CREATE TABLE connected_apps (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        default_mode TEXT NOT NULL DEFAULT 'discuss',
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE connected_app_tasks (
        app_id TEXT NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        source_origin TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (app_id, task_id),
        UNIQUE (app_id, request_id)
      );
      CREATE INDEX idx_connected_app_tasks_task ON connected_app_tasks(task_id);
      CREATE TABLE connected_app_evidence (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (app_id, request_id)
      );
      CREATE INDEX idx_connected_app_evidence_task ON connected_app_evidence(task_id);
    `,
  },
  {
    // Multi-repository tasks (docs/plans/MULTI_REPO_TASKS_PLAN.md): the
    // repositories a task works in besides its primary one (tasks.repository_id,
    // whose Git state stays in tasks.git). Each linked repository keeps its own
    // Git record. Additive only; single-repository tasks have no rows here.
    version: 13,
    name: 'multi-repository tasks',
    sql: `
      CREATE TABLE task_linked_repositories (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        position INTEGER NOT NULL,
        folder TEXT NOT NULL,
        git TEXT NOT NULL,
        PRIMARY KEY (task_id, repository_id),
        UNIQUE (task_id, folder)
      );
      CREATE INDEX idx_task_linked_repository ON task_linked_repositories(repository_id);
      ALTER TABLE test_runs ADD COLUMN repository_id TEXT;
      ALTER TABLE task_checkpoints ADD COLUMN parts TEXT;
    `,
  },
  {
    // Ask (docs/systems/ask.md): read-only conversations outside tasks. A
    // conversation outlives the repository it read (SET NULL) and takes its
    // messages with it when deleted. Additive only.
    version: 14,
    name: 'ask conversations',
    sql: `
      CREATE TABLE ask_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
        agent_id TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_ask_threads_updated ON ask_threads(updated_at);
      CREATE TABLE ask_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        client_message_id TEXT,
        execution_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (thread_id, seq)
      );
      CREATE UNIQUE INDEX idx_ask_messages_client ON ask_messages(thread_id, client_message_id) WHERE client_message_id IS NOT NULL;
    `,
  },
];
