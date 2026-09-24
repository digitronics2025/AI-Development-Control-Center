import type { ConnectedAppKind, ConnectedAppMode, ConnectedAppTaskOrigin, ConnectedAppView } from '@acc/shared';
import type { Db } from '../db/database.js';

/** Migration 12 tables (docs/systems/connected-apps.md). Metadata only: the token is a hash here. */

type Row = Record<string, any>;

export interface ConnectedAppRecord {
  id: string;
  kind: ConnectedAppKind;
  name: string;
  tokenHash: string;
  defaultMode: ConnectedAppMode;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ConnectedAppTaskLink {
  appId: string;
  taskId: string;
  requestId: string;
  sourceOrigin: string;
  createdAt: string;
}

const toApp = (r: Row): ConnectedAppRecord => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  tokenHash: r.token_hash,
  defaultMode: r.default_mode,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

const toLink = (r: Row): ConnectedAppTaskLink => ({ appId: r.app_id, taskId: r.task_id, requestId: r.request_id, sourceOrigin: r.source_origin, createdAt: r.created_at });

export class ConnectedAppStore {
  constructor(readonly db: Db) {}

  insertApp(app: ConnectedAppRecord): void {
    this.db
      .prepare('INSERT INTO connected_apps (id, kind, name, token_hash, default_mode, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(app.id, app.kind, app.name, app.tokenHash, app.defaultMode, app.createdAt, app.lastUsedAt, app.revokedAt);
  }

  getApp(id: string): ConnectedAppRecord | null {
    const row = this.db.prepare('SELECT * FROM connected_apps WHERE id = ?').get(id) as Row | undefined;
    return row ? toApp(row) : null;
  }

  appByTokenHash(hash: string): ConnectedAppRecord | null {
    const row = this.db.prepare('SELECT * FROM connected_apps WHERE token_hash = ?').get(hash) as Row | undefined;
    return row ? toApp(row) : null;
  }

  view(app: ConnectedAppRecord): ConnectedAppView {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM connected_app_tasks WHERE app_id = ?').get(app.id) as { n: number };
    return { id: app.id, kind: app.kind, name: app.name, defaultMode: app.defaultMode, createdAt: app.createdAt, lastUsedAt: app.lastUsedAt, revokedAt: app.revokedAt, taskCount: n };
  }

  listApps(): ConnectedAppRecord[] {
    return (this.db.prepare('SELECT * FROM connected_apps ORDER BY created_at DESC').all() as Row[]).map(toApp);
  }

  setDefaultMode(id: string, mode: ConnectedAppMode): void {
    this.db.prepare('UPDATE connected_apps SET default_mode = ? WHERE id = ?').run(mode, id);
  }

  revoke(id: string, at: string): void {
    this.db.prepare('UPDATE connected_apps SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(at, id);
  }

  touch(id: string, at: string): void {
    this.db.prepare('UPDATE connected_apps SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  linkByRequest(appId: string, requestId: string): ConnectedAppTaskLink | null {
    const row = this.db.prepare('SELECT * FROM connected_app_tasks WHERE app_id = ? AND request_id = ?').get(appId, requestId) as Row | undefined;
    return row ? toLink(row) : null;
  }

  link(appId: string, taskId: string): ConnectedAppTaskLink | null {
    const row = this.db.prepare('SELECT * FROM connected_app_tasks WHERE app_id = ? AND task_id = ?').get(appId, taskId) as Row | undefined;
    return row ? toLink(row) : null;
  }

  insertLink(link: ConnectedAppTaskLink): void {
    this.db
      .prepare('INSERT INTO connected_app_tasks (app_id, task_id, request_id, source_origin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(link.appId, link.taskId, link.requestId, link.sourceOrigin, link.createdAt);
  }

  recentLinks(appId: string, limit: number): ConnectedAppTaskLink[] {
    return (this.db.prepare('SELECT * FROM connected_app_tasks WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(appId, limit) as Row[]).map(toLink);
  }

  tasksSince(appId: string, since: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM connected_app_tasks WHERE app_id = ? AND created_at >= ?').get(appId, since) as { n: number }).n;
  }

  taskOrigins(limit: number): ConnectedAppTaskOrigin[] {
    return (
      this.db
        .prepare('SELECT t.task_id, t.app_id, a.kind, a.name FROM connected_app_tasks t JOIN connected_apps a ON a.id = t.app_id ORDER BY t.created_at DESC LIMIT ?')
        .all(limit) as Row[]
    ).map((r) => ({ taskId: r.task_id, appId: r.app_id, kind: r.kind, name: r.name }));
  }

  evidenceByRequest(appId: string, requestId: string): { taskId: string; artifactId: string } | null {
    const row = this.db.prepare('SELECT task_id, artifact_id FROM connected_app_evidence WHERE app_id = ? AND request_id = ?').get(appId, requestId) as Row | undefined;
    return row ? { taskId: row.task_id, artifactId: row.artifact_id } : null;
  }

  insertEvidence(e: { id: string; appId: string; taskId: string; requestId: string; artifactId: string; createdAt: string }): void {
    this.db
      .prepare('INSERT INTO connected_app_evidence (id, app_id, task_id, request_id, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.id, e.appId, e.taskId, e.requestId, e.artifactId, e.createdAt);
  }

  evidenceSince(appId: string, since: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM connected_app_evidence WHERE app_id = ? AND created_at >= ?').get(appId, since) as { n: number }).n;
  }

  evidenceForTask(appId: string, taskId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM connected_app_evidence WHERE app_id = ? AND task_id = ?').get(appId, taskId) as { n: number }).n;
  }
}
