import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentCapabilities, ModelDescriptor } from '@acc/shared';
import type {
  AgentAdapter,
  AgentDetectionResult,
  AgentExecutionHandle,
  AgentExecutionInput,
  AgentExecutionResult,
  AgentHealth,
  RawAgentResult,
} from './contract.js';

/**
 * Deterministic stand-in for a real provider, used by automated tests and the
 * dashboard's end-to-end suite. It is only registered when the orchestrator
 * is started with ACC_SIMULATED_AGENTS=1, and the UI labels it as simulated.
 *
 * Scenario markers in the task description steer it:
 *   [sim:review-fail-once]   reviewer returns FAIL once, then PASS
 *   [sim:review-fail-always] reviewer always returns FAIL
 *   [sim:usage-limit]        implementer hits a usage limit on its first run
 *   [sim:fail:<role>]        that role always crashes
 *   [sim:slow]               every run takes several seconds
 */
export class SimulatedAgentAdapter implements AgentAdapter {
  readonly displayName: string;
  private readonly timers = new Map<string, { cancel: () => void }>();
  private static readonly seen = new Set<string>();

  constructor(
    readonly id: string,
    displayName?: string,
    private readonly delayMs = Number(process.env.ACC_SIM_DELAY_MS ?? 300),
  ) {
    this.displayName = displayName ?? `${id} (simulated)`;
  }

  static reset(): void {
    SimulatedAgentAdapter.seen.clear();
  }

  async detect(): Promise<AgentDetectionResult> {
    return { found: true, executablePath: '(simulated)', version: 'simulated', error: null };
  }

  async healthCheck(): Promise<AgentHealth> {
    return {
      state: 'connected',
      message: 'Simulated agent — no provider is contacted',
      authMethod: 'simulated',
      billing: 'subscription',
      checkedAt: new Date().toISOString(),
    };
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      repositoryRead: true,
      repositoryWrite: true,
      commandExecution: false,
      images: false,
      interactive: false,
      nonInteractive: true,
      modelSelection: true,
      effortSelection: true,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        agentId: this.id,
        modelId: 'sim-standard',
        label: 'Simulated Standard',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        source: 'builtin',
        description: 'Deterministic test model',
      },
    ];
  }

  private once(key: string): boolean {
    if (SimulatedAgentAdapter.seen.has(key)) return false;
    SimulatedAgentAdapter.seen.add(key);
    return true;
  }

  async execute(input: AgentExecutionInput): Promise<AgentExecutionHandle> {
    const role = /^Role: (\w+)/m.exec(input.prompt)?.[1]?.toLowerCase() ?? 'agent';
    const taskId = /^Task: (TASK-\d+)/m.exec(input.prompt)?.[1] ?? 'TASK';
    const has = (marker: string) => input.prompt.includes(`[sim:${marker}]`);
    const slow = has('slow');
    const steps = slow ? 6 : 3;
    const stepMs = slow ? Math.max(this.delayMs, 900) : this.delayMs;
    const startedAt = new Date();
    const emit = (text: string) => input.onLine?.('stdout', text);

    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    let resolveWait: (() => void) | undefined;
    this.timers.set(input.executionId, {
      cancel: () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        resolveWait?.();
      },
    });

    const done = (async (): Promise<AgentExecutionResult> => {
      for (let step = 1; step <= steps && !cancelled; step++) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
          timer = setTimeout(resolve, stepMs);
        });
        if (!cancelled) emit(`[${role}] step ${step}/${steps}`);
      }
      this.timers.delete(input.executionId);
      const finishedAt = new Date();
      const base = {
        executionId: input.executionId,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        sessionId: null,
        filesChanged: [] as string[],
      };
      if (cancelled) {
        return { ...base, status: 'cancelled', exitCode: null, output: '', errorClass: null, errorMessage: 'Cancelled' };
      }
      if (has(`fail:${role}`)) {
        emit(`[${role}] simulated crash`);
        return { ...base, status: 'failed', exitCode: 1, output: '', errorClass: 'PROCESS_CRASH', errorMessage: `Simulated ${role} crash` };
      }
      if (role === 'implementer' && has('usage-limit') && this.once(`${taskId}:usage`)) {
        emit('You have hit your usage limit. Limit resets at 21:00.');
        return {
          ...base,
          status: 'failed',
          exitCode: 1,
          output: '',
          errorClass: 'USAGE_LIMIT',
          errorMessage: 'You have hit your usage limit. Limit resets at 21:00.',
        };
      }

      let output: string;
      switch (role) {
        case 'investigator':
          output = `## Findings\n\nThe repository at ${path.basename(input.cwd)} was inspected.\n\n## Relevant files\n\n- README.md\n\n## Risks\n\nNone found.`;
          break;
        case 'planner':
          output = `## Goal\n\nComplete the requested change.\n\n## Implementation Plan\n\n1. Update sim-output.md\n\n## Success Criteria\n\n- sim-output.md contains the change\n- tests pass`;
          break;
        case 'implementer':
        case 'fixer': {
          const file = path.join(input.cwd, 'sim-output.md');
          await appendFile(file, `- ${role} change at ${finishedAt.toISOString()}\n`, 'utf8');
          base.filesChanged = ['sim-output.md'];
          emit(`[file] update sim-output.md`);
          output = `## Changes\n\n- Updated sim-output.md\n\n## Notes\n\nSimulated ${role} run.`;
          break;
        }
        case 'reviewer': {
          const fail = has('review-fail-always') || (has('review-fail-once') && this.once(`${taskId}:review`));
          output = fail
            ? '## Review\n\n- sim-output.md is missing a heading.\n\nVERDICT: FAIL'
            : '## Review\n\nThe diff matches the plan.\n\nVERDICT: PASS';
          break;
        }
        case 'verifier':
          output = '## Verification\n\nAll success criteria were checked.\n\nVERDICT: PASS';
          break;
        default:
          output = `Simulated ${role} output.`;
      }
      for (const line of output.split('\n')) if (line.trim()) emit(line);
      return { ...base, status: 'succeeded', exitCode: 0, output, errorClass: null, errorMessage: null };
    })();

    return { executionId: input.executionId, pid: null, commandLine: `${this.id} (simulated) --model ${input.model}`, done };
  }

  async cancel(executionId: string): Promise<void> {
    this.timers.get(executionId)?.cancel();
  }

  async parseResult(raw: RawAgentResult): Promise<AgentExecutionResult> {
    return {
      executionId: raw.executionId,
      status: raw.process.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: raw.process.exitCode,
      output: raw.finalMessage ?? '',
      errorClass: raw.process.exitCode === 0 ? null : 'UNKNOWN',
      errorMessage: null,
      durationMs: raw.process.durationMs,
      startedAt: raw.process.startedAt.toISOString(),
      finishedAt: raw.process.finishedAt.toISOString(),
      sessionId: raw.sessionId,
      filesChanged: raw.filesChanged,
    };
  }
}
