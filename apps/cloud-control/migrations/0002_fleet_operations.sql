-- Operational state is separate from node-owned task/workflow state.
-- Bounded registries and indexed cursors: never poll application databases here.
CREATE TABLE ops_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  repository TEXT NOT NULL,
  contract TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE ops_jobs (
  app_id TEXT NOT NULL REFERENCES ops_apps(id),
  id TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  grace_seconds INTEGER NOT NULL,
  last_success_at TEXT,
  next_due_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (app_id,id)
);
CREATE TABLE ops_registry_capacity(id TEXT PRIMARY KEY,used INTEGER NOT NULL CHECK(used<=64));
INSERT INTO ops_registry_capacity(id,used) VALUES('apps',0);
CREATE INDEX idx_ops_jobs_due ON ops_jobs(enabled,next_due_at);
CREATE TABLE ops_events (
  app_id TEXT NOT NULL REFERENCES ops_apps(id),
  id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ingestion_nonce TEXT NOT NULL,
  incident_id TEXT,
  PRIMARY KEY (app_id,id)
);
CREATE INDEX idx_ops_events_retention ON ops_events(received_at);
CREATE TABLE ops_incidents (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES ops_apps(id),
  fingerprint TEXT NOT NULL UNIQUE,
  resource TEXT NOT NULL,
  operation TEXT NOT NULL,
  signature TEXT NOT NULL,
  classification TEXT NOT NULL,
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_uri TEXT,
  dependency_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  recurrence_count INTEGER NOT NULL DEFAULT 1,
  recurrence_started_at TEXT NOT NULL,
  prevention_required INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  command_id TEXT,
  task_id TEXT,
  node_id TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  proof TEXT,
  next_action_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_ops_incidents_due ON ops_incidents(state,next_action_at);
CREATE INDEX idx_ops_incidents_app ON ops_incidents(app_id,last_seen_at DESC,id);
CREATE INDEX idx_ops_incidents_dependency ON ops_incidents(dependency_id,state);
CREATE INDEX idx_ops_incidents_retention ON ops_incidents(state,resolved_at);
CREATE TABLE ops_delivery (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES ops_incidents(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_due_at TEXT NOT NULL,
  lease_until TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(incident_id,version)
);
CREATE INDEX idx_ops_delivery_due ON ops_delivery(state,next_due_at);
CREATE INDEX idx_ops_delivery_age ON ops_delivery(state,created_at);
CREATE INDEX idx_ops_delivery_retention ON ops_delivery(state,sent_at);
CREATE TABLE ops_budget (
  day TEXT PRIMARY KEY,
  units INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  tasks INTEGER NOT NULL DEFAULT 0,
  notifications INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ops_runtime (
  id TEXT PRIMARY KEY,
  next_tick_at TEXT NOT NULL,
  last_tick_at TEXT,
  last_completed_at TEXT,
  bootstrap_version TEXT,
  last_result TEXT
);
INSERT INTO ops_runtime(id,next_tick_at) VALUES ('fleet','1970-01-01T00:00:00.000Z');
CREATE TABLE ops_probes (
  app_id TEXT PRIMARY KEY REFERENCES ops_apps(id),
  state TEXT NOT NULL DEFAULT 'unknown',
  next_due_at TEXT NOT NULL,
  observed_at TEXT
);
CREATE INDEX idx_ops_probes_due ON ops_probes(next_due_at);
CREATE TABLE ops_recoveries (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES ops_incidents(id) ON DELETE CASCADE,
  recurrence INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verify_after TEXT NOT NULL,
  UNIQUE(incident_id,recurrence)
);
