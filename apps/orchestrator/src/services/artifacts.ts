import { mkdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '@acc/security';
import type { Artifact, ArtifactType } from '@acc/shared';
import type { Bus } from '../bus.js';
import { newId, now, type ArtifactRecord, type Store } from '../store/store.js';

const MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.patch': 'text/x-diff',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.sql': 'text/plain',
  '.html': 'text/plain',
};

export const MAX_ARTIFACT_READ_BYTES = 2 * 1024 * 1024;

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '');
  return base || 'artifact.txt';
}

export function toArtifactView(rec: ArtifactRecord): Artifact {
  const { path: _path, ...view } = rec;
  return view;
}

/**
 * Durable task artifacts (PLAN §16). Files live in the orchestrator's data
 * directory — not inside the user's repository — so they never appear in the
 * task's Git diff. Content is redacted before it is written.
 */
export class ArtifactService {
  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly dataDir: string,
  ) {}

  taskDir(taskId: string): string {
    const dir = path.join(this.dataDir, 'tasks', taskId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async write(
    taskId: string,
    options: { name: string; type: ArtifactType; content: string | Buffer; stageId?: string | null; stageKey?: string | null; redactContent?: boolean },
  ): Promise<Artifact> {
    const dir = this.taskDir(taskId);
    let name = safeName(options.name);
    const existing = new Set(this.store.listArtifacts(taskId).map((a) => a.name));
    if (existing.has(name)) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      for (let n = 2; existing.has(name); n++) name = `${stem}-${n}${ext}`;
    }
    const body =
      typeof options.content === 'string' && options.redactContent !== false ? redact(options.content) : options.content;
    const file = path.join(dir, name);
    await writeFile(file, body);
    const size = (await stat(file)).size;
    const rec: ArtifactRecord = {
      id: newId(),
      taskId,
      stageId: options.stageId ?? null,
      stageKey: options.stageKey ?? null,
      name,
      type: options.type,
      mime: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
      size,
      path: path.relative(this.dataDir, file),
      createdAt: now(),
    };
    this.store.insertArtifact(rec);
    const view = toArtifactView(rec);
    this.bus.publish({ type: 'artifact', artifact: view });
    return view;
  }

  absolutePath(rec: ArtifactRecord): string {
    const resolved = path.resolve(this.dataDir, rec.path);
    if (!resolved.startsWith(path.resolve(this.dataDir) + path.sep)) throw new Error('Artifact path escapes the data directory');
    return resolved;
  }

  async read(rec: ArtifactRecord, maxBytes = MAX_ARTIFACT_READ_BYTES): Promise<{ content: string; truncated: boolean }> {
    const buffer = await readFile(this.absolutePath(rec));
    const truncated = buffer.length > maxBytes;
    return { content: buffer.subarray(0, maxBytes).toString('utf8'), truncated };
  }

  /** Latest artifact text of a type, or null. Used by the context builder. */
  async latestText(taskId: string, type: ArtifactType, maxBytes = 200_000): Promise<string | null> {
    const rec = this.store.latestArtifactOfType(taskId, type);
    if (!rec) return null;
    try {
      const { content, truncated } = await this.read(rec, maxBytes);
      return truncated ? `${content}\n\n[truncated]` : content;
    } catch {
      return null;
    }
  }
}
