-- Cloud control plane (docs/systems/cloud-control.md). Forward-only: never edit
-- an applied migration; add the next number instead.

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  os TEXT,
  app_version TEXT,
  protocol_version INTEGER,
  public_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'offline',
  capabilities TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  paired_by TEXT NOT NULL,
  last_seen_at TEXT,
  connected_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);

CREATE TABLE node_repositories (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  remote_host TEXT,
  default_branch TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, local_id)
);
CREATE INDEX idx_node_repositories_fingerprint ON node_repositories(fingerprint);

CREATE TABLE pairing_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_node TEXT,
  revoked_at TEXT
);

CREATE TABLE node_challenges (
  nonce_hash TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_node_challenges_expiry ON node_challenges(expires_at);

CREATE TABLE remote_commands (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  op TEXT NOT NULL,
  params TEXT NOT NULL,
  query TEXT NOT NULL,
  body TEXT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  precondition TEXT,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  delivered_at TEXT,
  claimed_at TEXT,
  finished_at TEXT,
  result_status INTEGER,
  result_body TEXT,
  error_code TEXT,
  error_message TEXT,
  task_id TEXT,
  lease_fingerprint TEXT,
  UNIQUE (created_by, idempotency_key)
);
CREATE INDEX idx_remote_commands_node ON remote_commands(node_id, status, created_at);

CREATE TABLE cloud_tasks (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  repository_id TEXT,
  repository_name TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  detail_updated_at TEXT,
  PRIMARY KEY (node_id, task_id)
);
CREATE INDEX idx_cloud_tasks_updated ON cloud_tasks(node_id, updated_at);

CREATE TABLE cloud_task_events (
  node_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (node_id, event_id)
);
CREATE INDEX idx_cloud_task_events_task ON cloud_task_events(node_id, task_id, event_id);

CREATE TABLE cloud_entities (
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  task_id TEXT,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (node_id, kind, entity_id)
);
CREATE INDEX idx_cloud_entities_task ON cloud_entities(node_id, kind, task_id);

CREATE TABLE cloud_usage_events (
  node_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  task_id TEXT,
  provider TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  display_cost_nanos INTEGER,
  json TEXT NOT NULL,
  PRIMARY KEY (node_id, event_id)
);
CREATE INDEX idx_cloud_usage_started ON cloud_usage_events(node_id, started_at);

CREATE TABLE artifact_manifests (
  node_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL,
  r2_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  PRIMARY KEY (node_id, artifact_id)
);

CREATE TABLE log_chunks (
  node_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (node_id, execution_id, chunk_index)
);

CREATE TABLE repository_leases (
  fingerprint TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  command_id TEXT,
  task_id TEXT,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  node_id TEXT,
  target TEXT,
  result TEXT NOT NULL,
  detail TEXT,
  request_id TEXT
);
CREATE INDEX idx_audit_events_at ON audit_events(at);
