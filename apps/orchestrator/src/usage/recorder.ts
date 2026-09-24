import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AgentExecutionResult, CapacityObservation, ProviderUsageCapabilities } from '@acc/agent-sdk';
import { redact } from '@acc/security';
import { blocksRuns, type AgentInfo, type UsageBilling, type UsageEventStatus } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { BudgetService } from './budgets.js';
import type { CapacityStore } from './capacity.js';
import type { UsageAttribution, UsageCompletion, UsageDispatch, UsageLedger } from './ledger.js';

/** What the agent registry tells the meter about a launch. */
export interface LaunchInfo {
  executionId: string;
  agentId: string;
  capabilities: ProviderUsageCapabilities;
  billing: UsageBilling;
  model: string;
  effort: string;
  prompt: string;
  attribution: UsageAttribution;
}

/**
 * The capture boundary's contract (docs/systems/usage.md#capture). Every
 * method is safe to call: telemetry never fails, delays or repeats an agent
 * run.
 */
export interface UsageMeter {
  /** Why a budget policy forbids this run, or null. Fails open. */
  blockReason(info: Pick<LaunchInfo, 'agentId' | 'capabilities' | 'model' | 'attribution'>): string | null;
  /** The process was started: a provider attempt exists from here on. */
  dispatched(info: LaunchInfo): UsageDispatch | null;
  finished(dispatch: UsageDispatch | null, result: AgentExecutionResult): void;
  /** The run's completion promise rejected; the attempt is recorded with unknown usage. */
  aborted(dispatch: UsageDispatch | null, error: unknown): void;
  /** A fresh reading that says this agent cannot run now (e.g. out of credits), or null. Fails open. */
  capacityBlock(agentId: string): AgentInfo['capacityBlock'];
}

interface SpooledWrite {
  dispatch: UsageDispatch;
  completion: UsageCompletion;
  capacity: CapacityObservation[];
}

export interface RecorderHealth {
  pendingWrites: number;
  lastError: { message: string; at: string } | null;
  lastWriteAt: string | null;
}

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 16);
}

function capacitySource(provider: string, observation: CapacityObservation): string {
  if (provider === 'simulated') return 'Simulated agent';
  if (observation.metric === 'credit' || observation.metric === 'usage_limit') return 'Provider error message';
  return provider === 'anthropic' ? 'Claude Code rate-limit event' : 'Reported during an agent run';
}

/**
 * Records one usage event per provider attempt. A failed database write is
 * appended to a spool file next to the database and retried with backoff;
 * replays are idempotent (the execution id is unique), so nothing is lost or
 * counted twice, and the provider is never called again to recreate
 * telemetry.
 */
export class UsageRecorder implements UsageMeter {
  private queue: SpooledWrite[] = [];
  private timer: NodeJS.Timeout | null = null;
  private delay = RETRY_MIN_MS;
  private lastError: RecorderHealth['lastError'] = null;
  private lastWriteAt: string | null = null;
  private stopped = false;

  constructor(
    private readonly d: {
      ledger: UsageLedger;
      capacity: CapacityStore;
      budgets: BudgetService;
      bus: Bus;
      spoolFile: string;
      log?: (message: string) => void;
    },
  ) {}

  private warn(message: string): void {
    const clean = redact(message);
    this.lastError = { message: clean, at: new Date().toISOString() };
    (this.d.log ?? ((m: string) => console.warn(`[usage] ${m}`)))(clean);
  }

  blockReason(info: Pick<LaunchInfo, 'agentId' | 'capabilities' | 'model' | 'attribution'>): string | null {
    try {
      return this.d.budgets.blockReason({
        provider: info.capabilities.provider,
        projectId: info.attribution.projectId,
        model: info.model,
        agentId: info.agentId,
        taskId: info.attribution.taskId,
      });
    } catch (error) {
      // A broken budget engine must not stop work: warn and let the run go.
      this.warn(`Budget check failed, run allowed: ${(error as Error).message}`);
      return null;
    }
  }

  capacityBlock(agentId: string): AgentInfo['capacityBlock'] {
    try {
      const reading = this.d.capacity.readings().find((r) => r.agentId === agentId && blocksRuns(r));
      return reading ? { label: reading.label, detail: reading.detail, capturedAt: reading.capturedAt } : null;
    } catch (error) {
      this.warn(`Capacity check failed: ${(error as Error).message}`);
      return null;
    }
  }

  dispatched(info: LaunchInfo): UsageDispatch | null {
    try {
      const dispatch: UsageDispatch = {
        key: info.executionId,
        agentId: info.agentId,
        provider: info.capabilities.provider,
        billing: info.billing,
        model: info.model,
        effort: info.effort === 'default' ? null : info.effort,
        promptChars: info.prompt.length,
        promptHash: promptHash(info.prompt),
        startedAt: new Date().toISOString(),
        attribution: info.attribution,
      };
      try {
        this.d.ledger.markPending(dispatch);
      } catch (error) {
        this.warn(`Could not mark attempt ${dispatch.key} as pending: ${(error as Error).message}`);
      }
      return dispatch;
    } catch (error) {
      this.warn(`Usage dispatch failed: ${(error as Error).message}`);
      return null;
    }
  }

  finished(dispatch: UsageDispatch | null, result: AgentExecutionResult): void {
    if (!dispatch) return;
    const status: UsageEventStatus = result.status;
    this.write({
      dispatch,
      completion: {
        finishedAt: result.finishedAt || new Date().toISOString(),
        durationMs: result.durationMs,
        status,
        errorClass: result.errorClass,
        usage: result.usage ?? null,
      },
      capacity: result.capacity ?? [],
    });
  }

  aborted(dispatch: UsageDispatch | null, error: unknown): void {
    if (!dispatch) return;
    const finishedAt = new Date().toISOString();
    this.warn(`Agent run ${dispatch.key} ended without a result: ${(error as Error)?.message ?? String(error)}`);
    this.write({
      dispatch,
      completion: { finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(dispatch.startedAt), status: 'failed', errorClass: 'PROCESS_CRASH', usage: null },
      capacity: [],
    });
  }

  private persist(item: SpooledWrite): void {
    const event = this.d.ledger.record(item.dispatch, item.completion);
    if (item.capacity.length) {
      const byProvider = item.dispatch.provider;
      for (const observation of item.capacity) {
        this.d.capacity.record(byProvider, item.dispatch.agentId, event?.id ?? null, capacitySource(byProvider, observation), [observation]);
      }
    }
    this.lastWriteAt = new Date().toISOString();
    if (event) this.d.bus.publish({ type: 'usage', event });
  }

  private write(item: SpooledWrite): void {
    try {
      this.persist(item);
    } catch (error) {
      this.warn(`Recording attempt ${item.dispatch.key} failed; kept for retry: ${(error as Error).message}`);
      this.queue.push(item);
      this.spool(item);
      this.schedule();
    }
  }

  private spool(item: SpooledWrite): void {
    try {
      appendFileSync(this.d.spoolFile, `${JSON.stringify(item)}\n`, 'utf8');
    } catch (error) {
      this.warn(`Could not write the usage spool: ${(error as Error).message}`);
    }
  }

  private rewriteSpool(): void {
    try {
      writeFileSync(this.d.spoolFile, this.queue.map((q) => `${JSON.stringify(q)}\n`).join(''), 'utf8');
    } catch (error) {
      this.warn(`Could not rewrite the usage spool: ${(error as Error).message}`);
    }
  }

  private schedule(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delay);
    this.timer.unref?.();
    this.delay = Math.min(this.delay * 2, RETRY_MAX_MS);
  }

  /** Retry spooled writes now. Returns how many are still waiting. */
  flush(): number {
    const waiting = this.queue;
    this.queue = [];
    for (const item of waiting) {
      try {
        this.persist(item);
      } catch (error) {
        this.warn(`Retry of attempt ${item.dispatch.key} failed: ${(error as Error).message}`);
        this.queue.push(item);
      }
    }
    this.rewriteSpool();
    if (this.queue.length) this.schedule();
    else this.delay = RETRY_MIN_MS;
    return this.queue.length;
  }

  /**
   * Startup: replay the spool, then record attempts that were dispatched but
   * never finished (the orchestrator stopped mid-run) as interrupted, with
   * unknown usage.
   */
  recover(): { replayed: number; interrupted: number } {
    let replayed = 0;
    if (existsSync(this.d.spoolFile)) {
      for (const line of readFileSync(this.d.spoolFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.queue.push(JSON.parse(line) as SpooledWrite);
          replayed += 1;
        } catch {
          this.warn('Skipped an unreadable line in the usage spool');
        }
      }
      this.flush();
    }
    let interrupted = 0;
    const now = new Date().toISOString();
    for (const dispatch of this.d.ledger.listPending()) {
      if (this.queue.some((q) => q.dispatch.key === dispatch.key)) continue;
      this.write({
        dispatch,
        completion: { finishedAt: now, durationMs: Date.parse(now) - Date.parse(dispatch.startedAt), status: 'interrupted', errorClass: null, usage: null },
        capacity: [],
      });
      interrupted += 1;
    }
    return { replayed, interrupted };
  }

  health(): RecorderHealth {
    return { pendingWrites: this.queue.length, lastError: this.lastError, lastWriteAt: this.lastWriteAt };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
