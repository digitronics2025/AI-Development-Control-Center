import { readFile } from 'node:fs/promises';
import { defaultArtifactSensitivity, REMOTE_LIMITS, sha256Hex, type Artifact, type Execution } from '@acc/shared';
import type { ArtifactService } from '../services/artifacts.js';
import type { Store } from '../store/store.js';
import type { EgressSanitizer } from './egress.js';
import type { RemoteStore, SyncObject } from './store.js';

/**
 * Artifact and log-chunk uploads to R2 (docs/systems/remote-node.md §Uploads).
 *
 * - Only `safe_sync` (and `user_shared`) objects are ever uploaded; diffs,
 *   environment reports, task JSON and raw tool output stay `local_only`.
 * - Text is redacted and path-scrubbed again right before upload; the SHA-256
 *   of the exact bytes sent travels with them and R2 verifies it on write.
 * - Uploads run in the background with backoff. A failure is recorded on the
 *   object and never changes the task: the local file is the source of truth.
 */

export interface UploadTarget {
  /** Fresh relay session (challenge-response) for a round of uploads. */
  session(): Promise<string>;
  upload(path: string, session: string, body: Buffer, sha256: string, contentType: string, headers: Record<string, string>): Promise<void>;
  manifest(payload: { artifactId: string; taskId: string; name: string; mime: string; size: number; sha256: string | null; sensitivity: 'safe_sync' | 'local_only' | 'user_shared'; status: 'pending' | 'uploaded' | 'failed' | 'local_only'; error: string | null }): void;
}

const FINAL_EXECUTION = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const MAX_ATTEMPTS = 8;
const TEXT = /^(text\/|application\/(json|x-ndjson|x-diff))/;

export class UploadQueue {
  private running: Promise<{ uploaded: number; failed: number }> | null = null;
  private stopped = false;

  constructor(
    private readonly d: {
      remote: RemoteStore;
      store: Store;
      artifacts: ArtifactService;
      egress: EgressSanitizer;
      target: UploadTarget;
      /** Uploads only while the node is connected. */
      online: () => boolean;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** A new artifact: decide its policy once, tell the cloud, queue it when it may sync. */
  trackArtifact(a: Artifact): void {
    const key = `artifact:${a.id}`;
    if (this.d.remote.syncObject(key)) return;
    const sensitivity = defaultArtifactSensitivity(a.type);
    const status = sensitivity === 'local_only' ? 'local_only' : a.size > REMOTE_LIMITS.artifactBytes ? 'local_only' : 'pending';
    this.d.remote.upsertSyncObject({ objectKey: key, kind: 'artifact', taskId: a.taskId, sensitivity, status });
    this.d.target.manifest({ artifactId: a.id, taskId: a.taskId, name: a.name, mime: a.mime, size: a.size, sha256: null, sensitivity, status, error: status === 'local_only' && sensitivity !== 'local_only' ? 'Too large for the cloud' : null });
  }

  /** A finished execution: its log becomes history chunks in R2. */
  trackExecution(e: Execution): void {
    if (!FINAL_EXECUTION.has(e.status)) return;
    const key = `log:${e.id}`;
    if (this.d.remote.syncObject(key)) return;
    this.d.remote.upsertSyncObject({ objectKey: key, kind: 'log', taskId: e.taskId, sensitivity: 'safe_sync', status: 'pending' });
  }

  /** Shutdown: finish nothing new, and never write after the database closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    const current = this.running;
    if (current) await Promise.race([current.catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]);
  }

  /** One round: upload what is due. Never throws. */
  run(): Promise<{ uploaded: number; failed: number }> {
    if (this.running) return this.running;
    if (this.stopped || !this.d.online()) return Promise.resolve({ uploaded: 0, failed: 0 });
    this.running = this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async round(): Promise<{ uploaded: number; failed: number }> {
    let uploaded = 0;
    let failed = 0;
    try {
      const due = this.d.remote.dueObjects(new Date(this.now()).toISOString(), 20);
      if (!due.length) return { uploaded, failed };
      let session: string;
      try {
        session = await this.d.target.session();
      } catch {
        return { uploaded, failed }; // the cloud is away: try next round, attempts unchanged
      }
      for (const object of due) {
        if (this.stopped || !this.d.online()) break;
        try {
          if (object.kind === 'artifact') await this.uploadArtifact(object, session);
          else await this.uploadLog(object, session);
          uploaded++;
        } catch (error) {
          if (this.stopped) break;
          failed++;
          const attempts = object.attempts + 1;
          const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7));
          this.d.remote.markObject(object.objectKey, { status: 'failed', error: (error as Error).message.slice(0, 500), nextAttemptAt: new Date(this.now() + delay).toISOString(), attempted: true });
          if (object.kind === 'artifact') {
            const rec = this.d.store.getArtifact(object.objectKey.slice('artifact:'.length));
            if (rec) this.d.target.manifest({ artifactId: rec.id, taskId: rec.taskId, name: rec.name, mime: rec.mime, size: rec.size, sha256: null, sensitivity: object.sensitivity, status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', error: (error as Error).message.slice(0, 500) });
          }
        }
      }
    } catch {
      /* never let a background round reject */
    }
    return { uploaded, failed };
  }

  private async uploadArtifact(object: SyncObject, session: string): Promise<void> {
    const id = object.objectKey.slice('artifact:'.length);
    const rec = this.d.store.getArtifact(id);
    if (!rec) {
      this.d.remote.markObject(object.objectKey, { status: 'local_only', error: 'The artifact no longer exists' });
      return;
    }
    let body = await readFile(this.d.artifacts.absolutePath(rec));
    // Written redacted already; scrubbed and redacted once more for the cloud (new secrets may be known now).
    if (TEXT.test(rec.mime)) body = Buffer.from(this.d.egress.scrub(body.toString('utf8')), 'utf8');
    if (body.length > REMOTE_LIMITS.artifactBytes) {
      this.d.remote.markObject(object.objectKey, { status: 'local_only', error: 'Too large for the cloud' });
      return;
    }
    const sha = await sha256Hex(new Uint8Array(body));
    await this.d.target.upload(`/node/v1/artifacts/${encodeURIComponent(id)}`, session, body, sha, rec.mime, {
      'x-acc-task-id': rec.taskId,
      'x-acc-name': encodeURIComponent(rec.name),
      'x-acc-sensitivity': object.sensitivity,
    });
    this.d.remote.markObject(object.objectKey, { status: 'uploaded', sha256: sha, error: null, nextAttemptAt: null, attempted: true });
  }

  private async uploadLog(object: SyncObject, session: string): Promise<void> {
    const executionId = object.objectKey.slice('log:'.length);
    let after = -1;
    let index = 0;
    let lastSha: string | null = null;
    for (;;) {
      const lines = this.d.store.listLogLines(executionId, { after, limit: 5_000 });
      if (!lines.length) break;
      // Pack whole lines into chunks of at most 1 MB (log lines were redacted when stored).
      let text = '';
      let first = lines[0]!.seq;
      let last = first;
      const flush = async () => {
        if (!text) return;
        const body = Buffer.from(this.d.egress.scrub(text), 'utf8');
        const sha = await sha256Hex(new Uint8Array(body));
        await this.d.target.upload(`/node/v1/logs/${encodeURIComponent(executionId)}/${index}`, session, body, sha, 'text/plain; charset=utf-8', {
          'x-acc-task-id': object.taskId,
          'x-acc-first-seq': String(first),
          'x-acc-last-seq': String(last),
        });
        lastSha = sha;
        index++;
        text = '';
      };
      for (const line of lines) {
        const entry = `${line.at} ${line.stream} ${line.text}\n`;
        if (text && text.length + entry.length > REMOTE_LIMITS.logChunkBytes * 0.9) {
          await flush();
          first = line.seq;
        }
        text += entry;
        last = line.seq;
      }
      await flush();
      after = lines.at(-1)!.seq;
      if (lines.length < 5_000) break;
    }
    this.d.remote.markObject(object.objectKey, { status: 'uploaded', sha256: lastSha, error: null, nextAttemptAt: null, attempted: true });
  }
}
