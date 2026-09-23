import type { ToolRegistry } from './registry.js';
import type { DetectContext, ToolDetection, ToolProvider } from './sdk.js';

export interface ToolHealthRecord extends ToolDetection {
  providerId: string;
  checkedAt: string;
  /** When the (slow) account check last ran, if ever. */
  authCheckedAt: string | null;
  /** Health: ready, missing, needs auth, or an error during detection. */
  state: 'ready' | 'missing' | 'auth_required' | 'error';
  durationMs: number;
}

function stateOf(d: ToolDetection): ToolHealthRecord['state'] {
  if (!d.installed) return 'missing';
  if (d.auth.required && d.auth.state === 'missing') return 'auth_required';
  return 'ready';
}

/**
 * Cached tool detection (V2 plan §18, §55). Probing every executable is
 * slow, so results are kept for `ttlMs`, refreshed lazily when asked for,
 * detected in parallel with a small concurrency cap, and persisted by the
 * owner through `onUpdate`. Account checks run only on explicit request.
 */
export class ToolHealthCache {
  private readonly records = new Map<string, ToolHealthRecord>();
  private readonly inFlight = new Map<string, Promise<ToolHealthRecord>>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly context: () => DetectContext,
    private readonly options: { ttlMs?: number; onUpdate?: (record: ToolHealthRecord) => void; concurrency?: number } = {},
  ) {}

  /** Load persisted results (startup) without probing anything. */
  seed(records: Iterable<ToolHealthRecord>): void {
    for (const r of records) if (this.registry.provider(r.providerId)) this.records.set(r.providerId, r);
  }

  get(providerId: string): ToolHealthRecord | undefined {
    return this.records.get(providerId);
  }

  all(): ToolHealthRecord[] {
    return [...this.records.values()];
  }

  private fresh(record: ToolHealthRecord | undefined): boolean {
    return Boolean(record && Date.now() - new Date(record.checkedAt).getTime() < (this.options.ttlMs ?? 10 * 60_000));
  }

  async check(providerId: string, opts: { force?: boolean; auth?: boolean } = {}): Promise<ToolHealthRecord> {
    const provider = this.registry.provider(providerId);
    if (!provider) throw new Error(`Unknown tool "${providerId}"`);
    const existing = this.records.get(providerId);
    if (!opts.force && !opts.auth && this.fresh(existing)) return existing!;
    const key = `${providerId}|${opts.auth ? 'auth' : 'plain'}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const job = this.detect(provider, Boolean(opts.auth), existing).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async detect(provider: ToolProvider, withAuth: boolean, previous: ToolHealthRecord | undefined): Promise<ToolHealthRecord> {
    const ctx = this.context();
    const started = Date.now();
    let detection: ToolDetection;
    let state: ToolHealthRecord['state'];
    try {
      detection = await provider.detect(ctx);
      // Keep a previous account result unless we re-check it now.
      if (!withAuth && previous && previous.installed && detection.installed && detection.auth.required) detection = { ...detection, auth: previous.auth };
      if (withAuth && provider.checkAuth && detection.installed) detection = { ...detection, auth: await provider.checkAuth(ctx, detection) };
      state = stateOf(detection);
    } catch (error) {
      detection = { installed: false, version: null, path: null, auth: { required: false, state: 'not_required', message: null }, message: `Detection failed: ${(error as Error).message}` };
      state = 'error';
    }
    const now = new Date().toISOString();
    const record: ToolHealthRecord = {
      ...detection,
      providerId: provider.id,
      checkedAt: now,
      authCheckedAt: withAuth && provider.checkAuth ? now : (previous?.authCheckedAt ?? null),
      state,
      durationMs: Date.now() - started,
    };
    this.records.set(provider.id, record);
    this.options.onUpdate?.(record);
    return record;
  }

  /** Detect many providers (stale ones only unless forced), a few at a time. */
  async refresh(opts: { force?: boolean; ids?: string[]; platform?: NodeJS.Platform } = {}): Promise<ToolHealthRecord[]> {
    const platform = opts.platform ?? process.platform;
    const providers = this.registry
      .listProviders({ platform })
      .filter((p) => !opts.ids || opts.ids.includes(p.id))
      .filter((p) => opts.force || !this.fresh(this.records.get(p.id)));
    const limit = this.options.concurrency ?? 6;
    const queue = [...providers];
    const results: ToolHealthRecord[] = [];
    await Promise.all(
      Array.from({ length: Math.min(limit, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) results.push(await this.check(next.id, { force: opts.force }));
      }),
    );
    return results;
  }
}
