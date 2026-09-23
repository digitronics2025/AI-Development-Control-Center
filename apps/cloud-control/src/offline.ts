import { ATTENTION_TASK_STATUSES, type NodeCapabilities } from '@acc/shared';

/**
 * Answers for reads while a node is offline, from the D1 mirror
 * (docs/systems/cloud-control.md §Offline). Only operations marked
 * `offline` in the catalog reach here; everything live-only answers
 * NODE_OFFLINE instead of showing stale success.
 */
export async function offlineRead(db: D1Database, nodeId: string, op: string, params: Record<string, string>, query: Record<string, string>): Promise<{ status: number; body: unknown } | null> {
  const parse = <T>(rows: Array<{ json?: string; summary?: string; detail?: string | null }>, field: 'json' | 'summary' = 'json') => rows.map((r) => JSON.parse(String(r[field])) as T);
  switch (op) {
    case 'task.list': {
      const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
      const statuses = (query.status ?? '').split(',').filter(Boolean);
      const where = ['node_id = ?'];
      const binds: unknown[] = [nodeId];
      if (statuses.length) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        binds.push(...statuses);
      }
      if (query.repositoryId) {
        where.push('repository_id = ?');
        binds.push(query.repositoryId);
      }
      if (query.q) {
        where.push('(title LIKE ? OR task_id LIKE ?)');
        binds.push(`%${query.q}%`, `%${query.q}%`);
      }
      if (query.before) {
        where.push('updated_at < ?');
        binds.push(query.before);
      }
      const rows = await db.prepare(`SELECT summary, updated_at FROM cloud_tasks WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).bind(...binds, limit + 1).all<{ summary: string; updated_at: string }>();
      const page = rows.results.slice(0, limit);
      return { status: 200, body: { items: parse(page, 'summary'), nextCursor: rows.results.length > limit ? (page.at(-1)?.updated_at ?? null) : null } };
    }
    case 'task.get': {
      const row = await db.prepare('SELECT summary, detail FROM cloud_tasks WHERE node_id = ? AND task_id = ?').bind(nodeId, params.id).first<{ summary: string; detail: string | null }>();
      if (!row) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'This task is not in the cloud history.' } } };
      const detail = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null;
      // Without a detail snapshot the summary still renders the header; stages stay empty rather than invented.
      return { status: 200, body: detail ? { ...detail, ...(JSON.parse(row.summary) as object) } : { ...(JSON.parse(row.summary) as object), stages: [], assignments: {}, attachments: [], description: '', snapshotMissing: true } };
    }
    case 'overview.get': {
      const rows = await db.prepare('SELECT summary, status, updated_at FROM cloud_tasks WHERE node_id = ? ORDER BY updated_at DESC LIMIT 500').bind(nodeId).all<{ summary: string; status: string; updated_at: string }>();
      const all = rows.results;
      const today = new Date().toISOString().slice(0, 10);
      const pick = (statuses: readonly string[], limit = 50) => parse(all.filter((r) => statuses.includes(r.status)).slice(0, limit), 'summary');
      const approvals = await db.prepare("SELECT COUNT(*) AS n FROM cloud_entities WHERE node_id = ? AND kind = 'approval' AND json_extract(json, '$.status') = 'pending'").bind(nodeId).first<{ n: number }>();
      const caps = await db.prepare('SELECT capabilities FROM nodes WHERE id = ?').bind(nodeId).first<{ capabilities: string | null }>();
      return {
        status: 200,
        body: {
          counts: {
            active: all.filter((r) => ['RUNNING', 'QUEUED', 'PAUSED'].includes(r.status)).length,
            waitingForMe: all.filter((r) => ['WAITING_FOR_USER', 'WAITING_FOR_USAGE_RESET'].includes(r.status)).length,
            failed: all.filter((r) => r.status === 'FAILED').length,
            completedToday: all.filter((r) => r.status === 'COMPLETED' && r.updated_at.startsWith(today)).length,
            pendingApprovals: approvals?.n ?? 0,
          },
          active: pick(['RUNNING', 'QUEUED', 'PAUSED']),
          attention: pick(ATTENTION_TASK_STATUSES),
          recent: parse(all.slice(0, 20), 'summary'),
          simulatedAgents: caps?.capabilities ? (JSON.parse(caps.capabilities) as NodeCapabilities).features.simulatedAgents : false,
        },
      };
    }
    case 'task.events': {
      const after = Number(query.after ?? 0) || 0;
      const limit = Math.min(2000, Math.max(1, Number(query.limit ?? 500) || 500));
      const rows = await db.prepare('SELECT json FROM cloud_task_events WHERE node_id = ? AND task_id = ? AND event_id > ? ORDER BY event_id LIMIT ?').bind(nodeId, params.id, after, limit).all<{ json: string }>();
      return { status: 200, body: parse(rows.results) };
    }
    case 'task.artifacts': {
      const rows = await db.prepare("SELECT json FROM cloud_entities WHERE node_id = ? AND kind = 'artifact' AND task_id = ? ORDER BY updated_at").bind(nodeId, params.id).all<{ json: string }>();
      return { status: 200, body: parse(rows.results) };
    }
    case 'approval.list': {
      const status = query.status ?? 'pending';
      const rows =
        status === 'all'
          ? await db.prepare("SELECT json FROM cloud_entities WHERE node_id = ? AND kind = 'approval' ORDER BY updated_at DESC LIMIT 200").bind(nodeId).all<{ json: string }>()
          : await db.prepare("SELECT json FROM cloud_entities WHERE node_id = ? AND kind = 'approval' AND json_extract(json, '$.status') = ? ORDER BY updated_at DESC LIMIT 200").bind(nodeId, status).all<{ json: string }>();
      return { status: 200, body: parse(rows.results) };
    }
    case 'agent.list': {
      const row = await db.prepare("SELECT json FROM cloud_entities WHERE node_id = ? AND kind = 'agents' AND entity_id = 'all'").bind(nodeId).first<{ json: string }>();
      return { status: 200, body: row ? JSON.parse(row.json) : [] };
    }
    case 'repository.list': {
      const rows = await db.prepare("SELECT json FROM cloud_entities WHERE node_id = ? AND kind = 'repository' ORDER BY json_extract(json, '$.name')").bind(nodeId).all<{ json: string }>();
      return { status: 200, body: parse(rows.results) };
    }
    case 'usage.events': {
      const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
      const from = query.from ?? '1970-01-01T00:00:00.000Z';
      const to = query.to ?? '9999-12-31T00:00:00.000Z';
      const cursor = query.cursor ?? '9999-12-31T00:00:00.000Z';
      const rows = await db
        .prepare('SELECT json, started_at FROM cloud_usage_events WHERE node_id = ? AND started_at >= ? AND started_at <= ? AND started_at < ? ORDER BY started_at DESC LIMIT ?')
        .bind(nodeId, from, to, cursor, limit + 1)
        .all<{ json: string; started_at: string }>();
      const total = await db.prepare('SELECT COUNT(*) AS n FROM cloud_usage_events WHERE node_id = ? AND started_at >= ? AND started_at <= ?').bind(nodeId, from, to).first<{ n: number }>();
      const page = rows.results.slice(0, limit);
      return { status: 200, body: { items: parse(page), nextCursor: rows.results.length > limit ? (page.at(-1)?.started_at ?? null) : null, total: total?.n ?? 0 } };
    }
    default:
      return null;
  }
}
