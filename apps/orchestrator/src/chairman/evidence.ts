import { createHash } from 'node:crypto';
import { changesSince } from '@acc/git';
import { redact } from '@acc/security';
import { FAILURE_CATEGORY_LABEL, STRATEGY_OUTCOME_LABEL, nonBlockingFailure, type ChangedFile, type FailureCategory, type RecoveryAttempt, type ToolExecution } from '@acc/shared';
import { inFolder, taskRepositories } from '../engine/task-repositories.js';
import { taskWorkdir } from '../engine/workdir.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { Store, TaskRecord } from '../store/store.js';
import { fenceEvidence } from './reasoner.js';
import { failingTestIds, testFailureCount, type FailureSource } from './signatures.js';
import type { ChairmanStore } from './store.js';

/**
 * The Chairman's evidence (docs/systems/chairman.md §Evidence). One service
 * for background recovery and chat: it reads what the Control Center already
 * recorded, bounds and redacts it, labels how far each part can be trusted,
 * and renders it inside untrusted-evidence fences. A packet is rebuilt for
 * every decision or answer and never stored — only its digest is.
 */

/** Stable order: sections always appear in this order. */
export const EVIDENCE_KINDS = [
  'failure',
  'failure_history',
  'test_output',
  'work_report',
  'verification',
  'review',
  'plan',
  'changed_files',
  'tool_executions',
  'tool_recovery',
  'agent_health',
  'last_strategy',
] as const;
export type ChairmanEvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** OBSERVED = recorded by the orchestrator, tests or tools; AGENT_REPORTED = an agent's own prose (a claim). */
export type EvidenceReliability = 'OBSERVED' | 'AGENT_REPORTED';

export interface ChairmanEvidenceSection {
  kind: ChairmanEvidenceKind;
  reliability: EvidenceReliability;
  label: string;
  sourceId: string | null;
  /** Redacted and bounded. */
  text: string;
  truncated: boolean;
}

export interface ChairmanEvidencePacket {
  purpose: 'recovery' | 'chat';
  taskId: string;
  generatedAt: string;
  /** Hash of the sections' content: what an audit row may keep instead of the evidence. */
  digest: string;
  sections: ChairmanEvidenceSection[];
  availableKinds: ChairmanEvidenceKind[];
  unavailableKinds: ChairmanEvidenceKind[];
  /** Why each unavailable source could not be read (bounded, redacted). */
  unavailable: Array<{ kind: ChairmanEvidenceKind; reason: string }>;
}

/** The failure a recovery decision is about, as recorded by the Chairman. */
export interface EvidenceFailure {
  source: FailureSource;
  stageKey: string;
  stageId: string | null;
  category: FailureCategory;
  hash: string;
  message: string;
  failureCount: number | null;
}

const SECTION_LIMIT: Record<ChairmanEvidenceKind, number> = {
  failure: 1_500,
  failure_history: 1_500,
  test_output: 6_000,
  work_report: 4_000,
  verification: 8_000,
  review: 8_000,
  plan: 5_000,
  changed_files: 2_000,
  tool_executions: 2_500,
  tool_recovery: 1_500,
  agent_health: 800,
  last_strategy: 1_000,
};
export const TOTAL_LIMIT = 22_000;
const TEST_LOG_LINES = 80;

const RELIABILITY: Record<ChairmanEvidenceKind, EvidenceReliability> = {
  failure: 'OBSERVED',
  failure_history: 'OBSERVED',
  test_output: 'OBSERVED',
  work_report: 'AGENT_REPORTED',
  verification: 'AGENT_REPORTED',
  review: 'AGENT_REPORTED',
  plan: 'AGENT_REPORTED',
  changed_files: 'OBSERVED',
  tool_executions: 'OBSERVED',
  tool_recovery: 'OBSERVED',
  agent_health: 'OBSERVED',
  last_strategy: 'OBSERVED',
};

const LABEL: Record<ChairmanEvidenceKind, string> = {
  failure: 'current failure',
  failure_history: 'failure history',
  test_output: 'failing test output',
  work_report: 'latest implementation or fix report',
  verification: 'latest verification',
  review: 'latest review',
  plan: 'current plan',
  changed_files: 'files changed by this task',
  tool_executions: 'recent tool calls',
  tool_recovery: 'tool recovery attempts',
  agent_health: 'agent health',
  last_strategy: 'last Chairman strategy',
};

export interface EvidenceDeps {
  store: Store;
  chairman: ChairmanStore;
  artifacts: Pick<ArtifactService, 'latestText'>;
  agents: Pick<AgentRegistry, 'list'>;
  /** The tool layer's store; null when the tool layer is not composed (tests). */
  tools: { listExecutions(filter: { taskId?: string; limit?: number }): ToolExecution[]; listRecovery(taskId: string): RecoveryAttempt[] } | null;
  /** Task-owned changes since the baseline; injectable for tests. */
  changedFiles?: (task: TaskRecord) => Promise<ChangedFile[] | null>;
}

type Builder = () => Promise<{ text: string; sourceId?: string | null } | null> | { text: string; sourceId?: string | null } | null;

export class ChairmanEvidenceService {
  constructor(private readonly d: EvidenceDeps) {}

  /** Evidence for a recovery decision: the failure plus what is relevant to its source. */
  async forRecovery(task: TaskRecord, failure: EvidenceFailure): Promise<ChairmanEvidencePacket> {
    const builders: Partial<Record<ChairmanEvidenceKind, Builder>> = {
      failure: () => ({ text: describeFailure(failure), sourceId: failure.stageId }),
      failure_history: () => this.history(task, failure.source),
      last_strategy: () => this.lastStrategy(task.id),
    };
    switch (failure.source) {
      case 'tests':
        builders.test_output = () => (failure.stageId ? this.testOutput(task, failure.stageId) : null);
        // What the worker says it did (or why it stopped): without it a refusal reads as a write that never lands.
        builders.work_report = () => this.workReport(task.id);
        builders.changed_files = () => this.changes(task);
        break;
      case 'review':
      case 'verify':
        builders.work_report = () => this.workReport(task.id);
        builders[failure.source === 'verify' ? 'verification' : 'review'] = () => this.artifact(task.id, failure.source === 'verify' ? 'verification' : 'review');
        if (failure.category === 'REQUIREMENT_OR_PLAN') builders.plan = () => this.artifact(task.id, 'plan');
        builders.changed_files = () => this.changes(task);
        break;
      case 'worker':
        builders.tool_executions = () => this.toolExecutions(task.id);
        builders.tool_recovery = () => this.toolRecovery(task.id);
        builders.agent_health = () => this.agentHealth();
        break;
      case 'gate':
        builders.work_report = () => this.workReport(task.id);
        builders.changed_files = () => this.changes(task);
        break;
    }
    return this.assemble('recovery', task, builders);
  }

  /** Lighter evidence for a chat answer: the latest verdicts, failure and strategy. */
  async forChat(task: TaskRecord): Promise<ChairmanEvidencePacket> {
    return this.assemble('chat', task, {
      failure: () => {
        const f = this.d.chairman.listFailures(task.id).at(-1);
        return f ? { text: describeFailure({ ...f, stageId: f.stageId }), sourceId: f.id } : null;
      },
      verification: () => this.artifact(task.id, 'verification'),
      review: () => this.artifact(task.id, 'review'),
      last_strategy: () => this.lastStrategy(task.id),
    });
  }

  /** The fenced text the reasoner reads. Every section is data, never instructions. */
  render(packet: ChairmanEvidencePacket): string {
    const blocks = packet.sections.map((s) => fenceEvidence(`${s.label} (${s.reliability})`, s.text + (s.truncated ? '\n[truncated]' : '')));
    if (packet.unavailable.length) {
      blocks.push(`Evidence not available this time: ${packet.unavailable.map((u) => `${LABEL[u.kind]} (${u.reason})`).join('; ')}.`);
    }
    return blocks.join('\n\n');
  }

  /** Last lines of the failed command in a tests stage (also what the failure signature reads). */
  testFailure(taskId: string, stageId: string): { detail: string; commandName: string | null } {
    const failed = this.d.store.listTestRuns(taskId, stageId).find((r) => r.status === 'failed' && !nonBlockingFailure(r));
    if (!failed?.executionId) return { detail: '', commandName: failed?.name ?? null };
    return { detail: this.d.store.tailLogLines(failed.executionId, TEST_LOG_LINES).map((l) => l.text).join('\n'), commandName: failed.name };
  }

  // ---------------------------------------------------------------------------

  private async assemble(purpose: ChairmanEvidencePacket['purpose'], task: TaskRecord, builders: Partial<Record<ChairmanEvidenceKind, Builder>>): Promise<ChairmanEvidencePacket> {
    const roots = this.roots(task);
    const sections: ChairmanEvidenceSection[] = [];
    const unavailable: ChairmanEvidencePacket['unavailable'] = [];
    let budget = TOTAL_LIMIT;
    for (const kind of EVIDENCE_KINDS) {
      const build = builders[kind];
      if (!build) continue;
      let raw: { text: string; sourceId?: string | null } | null;
      try {
        raw = await build();
      } catch (error) {
        unavailable.push({ kind, reason: scrubRoots(redact((error as Error).message ?? 'unreadable'), roots).replace(/\s+/g, ' ').slice(0, 160) });
        continue;
      }
      if (!raw || !raw.text.trim()) continue;
      const clean = scrubRoots(redact(raw.text), roots).trim();
      const limit = Math.min(SECTION_LIMIT[kind], Math.max(budget, 0));
      const truncated = clean.length > limit;
      const text = truncated ? clean.slice(0, limit) : clean;
      budget -= text.length;
      sections.push({ kind, reliability: RELIABILITY[kind], label: LABEL[kind], sourceId: raw.sourceId ?? null, text: text || '[omitted: evidence budget used]', truncated });
    }
    return {
      purpose,
      taskId: task.id,
      generatedAt: new Date().toISOString(),
      digest: digestOf(sections),
      sections,
      availableKinds: sections.map((s) => s.kind),
      unavailableKinds: unavailable.map((u) => u.kind),
      unavailable,
    };
  }

  private roots(task: TaskRecord): Array<string | { path: string; label: string }> {
    // Only a task across repositories has a workspace (while its worktrees exist, which is when paths can appear).
    const units = task.git.workspacePath ? taskRepositories(this.d.store, task) : [];
    if (units.length > 1) {
      // Each repository keeps its own label, so the model can tell them apart.
      return [
        ...units.flatMap((u) => [u.git.worktreePath, u.repo.path].filter((p): p is string => Boolean(p)).map((p) => ({ path: p, label: `<repo:${u.folder}>` }))),
        ...(task.git.workspacePath ? [{ path: task.git.workspacePath, label: '<workspace>' }] : []),
      ];
    }
    const repo = this.d.store.getRepository(task.repositoryId);
    return [task.git.worktreePath, repo?.path].filter((p): p is string => Boolean(p));
  }

  private history(task: TaskRecord, source: FailureSource) {
    const lines = this.d.chairman
      .listFailures(task.id)
      .filter((f) => f.source === source)
      .slice(-6)
      .map((f) => `- cycle ${f.recoveryCycle}, ${f.stageKey}: ${f.message.split('\n')[0]!.slice(0, 200)}${f.failureCount !== null ? ` (${f.failureCount} failing)` : ''} [signature ${f.hash}]`);
    return lines.length ? { text: lines.join('\n') } : null;
  }

  private testOutput(task: TaskRecord, stageId: string) {
    const failed = this.d.store.listTestRuns(task.id, stageId).find((r) => r.status === 'failed' && !nonBlockingFailure(r));
    if (!failed) return null;
    const { detail } = this.testFailure(task.id, stageId);
    const ids = failingTestIds(detail, 10);
    const count = testFailureCount(failed.summary ?? '') ?? testFailureCount(detail);
    const head = [
      `command: ${failed.name} (${failed.kind})`,
      count !== null ? `failing: ${count}` : null,
      ids.length ? `failing tests: ${ids.join(', ')}` : null,
      failed.summary ? `summary: ${failed.summary}` : null,
      `last ${TEST_LOG_LINES} lines of output:`,
    ].filter(Boolean);
    return { text: `${head.join('\n')}\n${detail || '(no output recorded)'}`, sourceId: failed.executionId ?? failed.id };
  }

  private async artifact(taskId: string, type: 'review' | 'verification' | 'plan') {
    const text = await this.d.artifacts.latestText(taskId, type, 40_000);
    return text ? { text } : null;
  }

  /** The newer of the latest implementation and fix reports. */
  private async workReport(taskId: string) {
    const newest = (['implementation-report', 'fix-report'] as const)
      .map((type) => ({ type, rec: this.d.store.latestArtifactOfType(taskId, type) }))
      .filter((x) => x.rec)
      .sort((a, b) => b.rec!.createdAt.localeCompare(a.rec!.createdAt))[0];
    if (!newest) return null;
    const text = await this.d.artifacts.latestText(taskId, newest.type, 40_000);
    return text ? { text } : null;
  }

  /** Names and status only — never a diff or file contents. */
  private async changes(task: TaskRecord) {
    const files = await (this.d.changedFiles ?? defaultChangedFiles(this.d.store))(task);
    if (!files) return null;
    const owned = files.filter((f) => f.origin !== 'preexisting');
    if (!owned.length) return { text: 'No files changed by this task.' };
    const lines = owned.slice(0, 60).map((f) => `${f.status} ${f.path}${f.additions !== null ? ` (+${f.additions}/-${f.deletions ?? 0})` : ''}`);
    if (owned.length > 60) lines.push(`… and ${owned.length - 60} more`);
    return { text: lines.join('\n') };
  }

  private toolExecutions(taskId: string) {
    if (!this.d.tools) return null;
    const rows = this.d.tools.listExecutions({ taskId, limit: 12 });
    if (!rows.length) return null;
    return {
      text: rows
        .map((e) => `- ${e.capability} ${e.status}${e.errorCode ? ` [${e.errorCode}]` : ''}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}: ${(e.summary ?? '').split('\n')[0]!.slice(0, 200)}`)
        .join('\n'),
    };
  }

  private toolRecovery(taskId: string) {
    if (!this.d.tools) return null;
    const rows = this.d.tools.listRecovery(taskId).slice(-6);
    if (!rows.length) return null;
    return { text: rows.map((r) => `- ${r.category} → ${r.strategy}: ${r.status}${r.detail ? ` — ${r.detail.split('\n')[0]!.slice(0, 200)}` : ''}`).join('\n') };
  }

  private agentHealth() {
    const agents = this.d.agents.list();
    return agents.length ? { text: agents.map((a) => `- ${a.id}: ${a.health.state}${a.settings.enabled ? '' : ' (disabled)'}`).join('\n') } : null;
  }

  private lastStrategy(taskId: string) {
    const run = this.d.chairman.listStrategyRuns(taskId, 1)[0];
    if (!run) return null;
    return {
      text: [
        `strategy: ${run.strategyKind}${run.targetStageKey ? ` at ${run.targetStageKey}` : ''}${run.targetAgentId ? ` by ${run.targetAgentId}` : ''} (recovery cycle ${run.recoveryCycle})`,
        `diagnosis: ${FAILURE_CATEGORY_LABEL[run.diagnosis.category]}, ${run.diagnosis.confidence.toLowerCase()} confidence — ${run.diagnosis.summary}`,
        `expected: ${run.expectedResult || '(not stated)'}`,
        `outcome: ${STRATEGY_OUTCOME_LABEL[run.status]}${run.outcomeSummary ? ` — ${run.outcomeSummary}` : ''}`,
      ].join('\n'),
      sourceId: run.decisionId,
    };
  }
}

export function describeFailure(f: Omit<EvidenceFailure, 'stageId'> & { stageId?: string | null }): string {
  return [
    `source: ${f.source} at stage ${f.stageKey}`,
    `category: ${f.category}`,
    `signature: ${f.hash}`,
    f.failureCount !== null ? `failing: ${f.failureCount}` : null,
    `message: ${f.message}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Order-stable hash of what the reasoner was shown. */
export function digestOf(sections: Array<Pick<ChairmanEvidenceSection, 'kind' | 'sourceId' | 'text'>>): string {
  const canonical = JSON.stringify(sections.map((s) => [s.kind, s.sourceId, s.text]));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Absolute repository paths become `<repo>` (or their own label): the model needs relative names, not this machine's layout. */
export function scrubRoots(text: string, roots: Array<string | { path: string; label: string }>): string {
  let out = text;
  const all = roots.map((r) => (typeof r === 'string' ? { path: r, label: '<repo>' } : r));
  for (const root of all.sort((a, b) => b.path.length - a.path.length)) {
    const parts = root.path.replace(/[\\/]+$/, '').split(/[\\/]+/).map(escapeRegExp);
    out = out.replace(new RegExp(parts.join('[\\\\/]+'), 'gi'), root.label);
  }
  return out;
}

function defaultChangedFiles(store: Store) {
  return async (task: TaskRecord): Promise<ChangedFile[] | null> => {
    const units = taskRepositories(store, task);
    if (units.length > 1) {
      // Every repository's changes, paths under its folder.
      const out: ChangedFile[] = [];
      for (const u of units) {
        const baseline = u.git.baselineSnapshotId ? store.getSnapshot(u.git.baselineSnapshotId) : null;
        if (baseline) out.push(...(await changesSince(u.workdir, baseline)).map((f) => ({ ...f, path: inFolder(u.folder, f.path), repositoryId: u.repo.id })));
      }
      return out;
    }
    const repo = store.getRepository(task.repositoryId);
    const baseline = task.git.baselineSnapshotId ? store.getSnapshot(task.git.baselineSnapshotId) : null;
    if (!repo || !baseline) return null;
    return changesSince(taskWorkdir(task, repo), baseline);
  };
}
