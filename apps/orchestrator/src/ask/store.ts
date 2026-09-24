import { ASK_SOURCES, type AskMessage, type AskMessageStatus, type AskSource, type AskThread } from '@acc/shared';
import type { Db } from '../db/database.js';
import { newId, now } from '../store/store.js';

type Row = Record<string, any>;

const toThread = (r: Row): AskThread => ({
  id: r.id,
  title: r.title,
  repositoryId: r.repository_id ?? null,
  agentId: r.agent_id,
  model: r.model,
  effort: r.effort,
  sources: parseSources(r.sources),
  showPersonal: Boolean(r.show_personal),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function parseSources(text: unknown): AskSource[] {
  try {
    const list = JSON.parse(String(text ?? '[]')) as unknown[];
    return ASK_SOURCES.filter((s) => list.includes(s));
  } catch {
    return ['controlcenter'];
  }
}

const toMessage = (r: Row): AskMessage => ({
  id: r.id,
  threadId: r.thread_id,
  seq: r.seq,
  role: r.role,
  body: r.body,
  status: r.status,
  error: r.error ?? null,
  lookups: [],
  createdAt: r.created_at,
});

/** Persistence for Ask conversations (migration 14). */
export class AskStore {
  constructor(private readonly db: Db) {}

  // ----- threads ------------------------------------------------------------------

  insertThread(t: Pick<AskThread, 'title' | 'repositoryId' | 'agentId' | 'model' | 'effort' | 'sources'>): AskThread {
    const id = newId();
    const at = now();
    this.db
      .prepare('INSERT INTO ask_threads (id, title, repository_id, agent_id, model, effort, sources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.title, t.repositoryId, t.agentId, t.model, t.effort, JSON.stringify(t.sources), at, at);
    return this.thread(id)!;
  }

  thread(id: string): AskThread | null {
    const row = this.db.prepare('SELECT * FROM ask_threads WHERE id = ?').get(id) as Row | undefined;
    return row ? toThread(row) : null;
  }

  listThreads(limit = 200): AskThread[] {
    return (this.db.prepare('SELECT * FROM ask_threads ORDER BY updated_at DESC LIMIT ?').all(Math.min(limit, 500)) as Row[]).map(toThread);
  }

  updateThread(id: string, patch: Partial<Pick<AskThread, 'title' | 'repositoryId' | 'agentId' | 'model' | 'effort' | 'sources' | 'showPersonal'>>): AskThread {
    const columns: Record<string, [string, (v: any) => unknown]> = {
      title: ['title', (v) => v],
      repositoryId: ['repository_id', (v) => v],
      agentId: ['agent_id', (v) => v],
      model: ['model', (v) => v],
      effort: ['effort', (v) => v],
      sources: ['sources', (v) => JSON.stringify(v)],
      showPersonal: ['show_personal', (v) => (v ? 1 : 0)],
    };
    const entries = Object.entries(patch).filter(([k, v]) => columns[k] && v !== undefined);
    const sets = [...entries.map(([k]) => `${columns[k]![0]} = ?`), 'updated_at = ?'];
    this.db.prepare(`UPDATE ask_threads SET ${sets.join(', ')} WHERE id = ?`).run(...entries.map(([k, v]) => columns[k]![1](v)), now(), id);
    return this.thread(id)!;
  }

  touchThread(id: string): AskThread | null {
    this.db.prepare('UPDATE ask_threads SET updated_at = ? WHERE id = ?').run(now(), id);
    return this.thread(id);
  }

  deleteThread(id: string): void {
    this.db.prepare('DELETE FROM ask_threads WHERE id = ?').run(id);
  }

  // ----- messages -----------------------------------------------------------------

  insertMessage(m: { threadId: string; role: AskMessage['role']; body: string; status: AskMessageStatus; clientMessageId?: string | null }): AskMessage {
    const id = newId();
    const createdAt = now();
    this.db.transaction(() => {
      const seq = ((this.db.prepare('SELECT MAX(seq) AS s FROM ask_messages WHERE thread_id = ?').get(m.threadId) as Row).s ?? 0) + 1;
      this.db
        .prepare('INSERT INTO ask_messages (id, thread_id, seq, role, body, status, client_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, m.threadId, seq, m.role, m.body, m.status, m.clientMessageId ?? null, createdAt);
    })();
    return this.message(id)!;
  }

  message(id: string): AskMessage | null {
    const row = this.db.prepare('SELECT * FROM ask_messages WHERE id = ?').get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  messageByClientId(threadId: string, clientMessageId: string): AskMessage | null {
    const row = this.db.prepare('SELECT * FROM ask_messages WHERE thread_id = ? AND client_message_id = ?').get(threadId, clientMessageId) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  updateMessage(id: string, patch: { status?: AskMessageStatus; body?: string; error?: string | null; executionId?: string | null; toolSessionId?: string | null }): AskMessage {
    const columns: Record<string, string> = { status: 'status', body: 'body', error: 'error', executionId: 'execution_id', toolSessionId: 'tool_session_id' };
    const entries = Object.entries(patch).filter(([k, v]) => columns[k] && v !== undefined);
    if (entries.length) this.db.prepare(`UPDATE ask_messages SET ${entries.map(([k]) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
    return this.message(id)!;
  }

  listMessages(threadId: string, limit = 500): AskMessage[] {
    const rows = this.db.prepare('SELECT * FROM (SELECT * FROM ask_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(threadId, Math.min(limit, 1000)) as Row[];
    return rows.map(toMessage);
  }

  /** Answer id → the tool session it used, for the answers of one conversation that used tools. */
  toolSessions(threadId: string): Map<string, string> {
    const rows = this.db.prepare('SELECT id, tool_session_id FROM ask_messages WHERE thread_id = ? AND tool_session_id IS NOT NULL').all(threadId) as Row[];
    return new Map(rows.map((r) => [String(r.id), String(r.tool_session_id)]));
  }

  /** Questions a restart left unanswered, and answers it left half-written. */
  unfinished(): AskMessage[] {
    return (this.db.prepare("SELECT * FROM ask_messages WHERE status IN ('pending', 'running') ORDER BY created_at, seq").all() as Row[]).map(toMessage);
  }
}
