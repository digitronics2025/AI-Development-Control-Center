import type { ChairmanActionInput, CommandKind, Directive, StageInstance, TestRun, WorkflowProfile } from '@acc/shared';
import { matchesAny } from './rules.js';

/**
 * Completion gate (plan §3.19). Checks objective state only — recorded test
 * runs, verdicts and the task's own changed files — so no agent or model
 * opinion can turn a failing task into a successful one.
 */

export interface GateInput {
  workflow: WorkflowProfile;
  stages: StageInstance[];
  testRuns: TestRun[];
  activeDirectives: Directive[];
  /** Files the task itself changed (origin task/both), or null outside Git. */
  taskFiles: string[] | null;
  /** Command kinds the repository has enabled commands for. */
  configuredKinds: ReadonlySet<CommandKind>;
}

export interface GateFailure {
  code: 'tests' | 'review' | 'verify' | 'required_check' | 'protected_paths';
  message: string;
  /** Actions that would satisfy this check, when there is a safe way. */
  remedy: ChairmanActionInput[] | null;
}

export interface GateResult {
  pass: boolean;
  failures: GateFailure[];
}

const lastOf = (stages: StageInstance[], pred: (s: StageInstance) => boolean) => [...stages].reverse().find(pred) ?? null;

export function completionGate(input: GateInput): GateResult {
  const { workflow, stages } = input;
  const failures: GateFailure[] = [];
  const has = (pred: (s: WorkflowProfile['stages'][number]) => boolean) => workflow.stages.find(pred) ?? null;
  const testsDef = has((s) => s.kind === 'tests');
  const fixDef = has((s) => s.role === 'fixer' && s.kind === 'agent') ?? has((s) => s.role === 'implementer' && s.kind === 'agent');

  const lastWrite = lastOf(stages, (s) => (s.role === 'implementer' || s.role === 'fixer') && s.status === 'SUCCESS');
  const after = (s: StageInstance | null) => !lastWrite || (s !== null && s.createdAt >= lastWrite.createdAt);

  let lastTests: StageInstance | null = null;
  if (testsDef) {
    lastTests = lastOf(stages, (s) => s.kind === 'tests' && ['SUCCESS', 'FAILED', 'SKIPPED'].includes(s.status));
    if (!lastTests || lastTests.status === 'FAILED' || !after(lastTests)) {
      failures.push({
        code: 'tests',
        message: !lastTests ? 'Tests have not run.' : lastTests.status === 'FAILED' ? 'The last test run failed.' : 'Tests have not run since the last change.',
        remedy: [{ type: 'RETURN_TO_STAGE', params: { stageKey: testsDef.key } }],
      });
    }
  }
  for (const role of ['reviewer', 'verifier'] as const) {
    const def = has((s) => s.role === role && s.kind === 'agent' && s.verdict);
    if (!def) continue;
    const last = lastOf(stages, (s) => s.role === role && s.status === 'SUCCESS');
    if (!last || last.verdict !== 'PASS' || !after(last)) {
      failures.push({
        code: role === 'reviewer' ? 'review' : 'verify',
        message: `${def.name} has not passed${last && last.verdict === 'PASS' ? ' since the last change' : ''}.`,
        remedy: [{ type: 'RETURN_TO_STAGE', params: { stageKey: def.key } }],
      });
    }
  }

  const required = new Set<CommandKind>();
  for (const d of input.activeDirectives) if (d.rule?.type === 'require_check') for (const k of d.rule.kinds) required.add(k);
  if (required.size) {
    const passedKinds = new Set(input.testRuns.filter((r) => r.status === 'passed' && lastTests && r.stageId === lastTests.id).map((r) => r.kind));
    const missing = [...required].filter((k) => !passedKinds.has(k));
    const unavailable = missing.filter((k) => !input.configuredKinds.has(k));
    if (unavailable.length) {
      failures.push({ code: 'required_check', message: `Required by your directive but not configured for this repository: ${unavailable.join(', ')}.`, remedy: null });
    } else if (missing.length) {
      failures.push({
        code: 'required_check',
        message: `Required by your directive and not yet passed: ${missing.join(', ')}.`,
        remedy: testsDef ? [{ type: missing.includes('e2e') ? 'RUN_E2E' : 'RUN_FULL_TESTS', params: {} }] : null,
      });
    }
  }

  if (input.taskFiles) {
    for (const d of input.activeDirectives) {
      if (d.rule?.type !== 'protect_paths') continue;
      const touched = input.taskFiles.filter((f) => matchesAny(f, (d.rule as { patterns: string[] }).patterns));
      if (!touched.length) continue;
      failures.push({
        code: 'protected_paths',
        message: `Changed files your directive protects ("${d.text.slice(0, 80)}"): ${touched.slice(0, 5).join(', ')}.`,
        remedy: fixDef
          ? [{ type: 'RETURN_TO_STAGE', params: { stageKey: fixDef.key, guidance: `Revert every change to ${touched.join(', ')}: the user's directive "${d.text}" forbids modifying them. Achieve the goal another way.` } }]
          : null,
      });
    }
  }
  return { pass: failures.length === 0, failures };
}
