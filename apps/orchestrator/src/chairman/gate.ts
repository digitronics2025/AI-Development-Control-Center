import { isWriteRole, judgeKind, stageConditionHolds, type ChairmanActionInput, type CommandKind, type Directive, type StageConditionFacts, type StageInstance, type TestRun, type WorkflowProfile } from '@acc/shared';
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
  /** Kinds the operator waived for this task (AUTOPILOT_GATES_PLAN §3.C): never required, whatever a directive says. */
  waivedKinds?: ReadonlySet<CommandKind>;
  /**
   * What a stage's `when` is judged on, read from the task's own changes exactly as the engine reads them
   * (engine/task-changes.ts). Absent = unknown: every conditional judge is required.
   */
  conditionFacts?: StageConditionFacts;
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
  // The remedy target edits code: the fixer, else the first write stage, and only one that can only edit (≤ Level 2),
  // so a remedy never re-runs a stage allowed to spend (Frontend Design's paid Assets stage, a Level 3 fixer). None: no remedy.
  const editing = (s: WorkflowProfile['stages'][number]) => isWriteRole(s.role) && s.kind === 'agent' && s.permissionLevel <= 2;
  const fixDef = has((s) => s.role === 'fixer' && editing(s)) ?? has(editing);

  const lastWrite = lastOf(stages, (s) => isWriteRole(s.role) && s.status === 'SUCCESS');
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
  // Each judge role with a verdict stage (review: reviewer, visual critic; verify: verifier) must have passed since the last
  // change, role by role: a critique's PASS is not the code review's. Its latest verdict run decides, whichever of that
  // role's verdict stages it was (a re-review after a fix stands for the review before it); an advisory run blocks nothing.
  const verdictDefs = workflow.stages.filter((s) => judgeKind(s.role) && s.kind === 'agent' && s.verdict);
  const verdictKeys = new Set(verdictDefs.map((s) => s.key));
  // A judge whose every verdict stage runs only on a condition that does not hold (a visual critique when no
  // user-interface file changed) was never needed: the engine skipped it on the same facts. Unknown facts hold.
  const facts = input.conditionFacts ?? { uiChanged: null };
  const needed = (role: string) => verdictDefs.some((s) => s.role === role && stageConditionHolds(s.when, facts));
  for (const kind of ['review', 'verify'] as const) {
    for (const role of new Set(verdictDefs.filter((s) => judgeKind(s.role) === kind).map((s) => s.role))) {
      if (!needed(role)) continue;
      const last = lastOf(stages, (s) => s.role === role && verdictKeys.has(s.stageKey) && s.status === 'SUCCESS');
      const def = verdictDefs.find((s) => s.key === last?.stageKey) ?? verdictDefs.find((s) => s.role === role)!;
      if (!last || last.verdict !== 'PASS' || !after(last)) {
        failures.push({
          code: kind,
          message: `${def.name} has not passed${last && last.verdict === 'PASS' ? ' since the last change' : ''}.`,
          remedy: [{ type: 'RETURN_TO_STAGE', params: { stageKey: def.key } }],
        });
      }
    }
  }

  const required = new Set<CommandKind>();
  for (const d of input.activeDirectives) if (d.rule?.type === 'require_check') for (const k of d.rule.kinds) if (!input.waivedKinds?.has(k)) required.add(k);
  if (required.size) {
    const latest = input.testRuns.filter((r) => lastTests && r.stageId === lastTests.id);
    const passedKinds = new Set(latest.filter((r) => r.status === 'passed').map((r) => r.kind));
    const missing = [...required].filter((k) => !passedKinds.has(k));
    const unavailable = missing.filter((k) => !input.configuredKinds.has(k));
    // A pre-existing failure is not a regression and not a pass: running it again cannot satisfy the requirement.
    const alreadyFailing = missing.filter((k) => latest.some((r) => r.kind === k && r.status === 'failed' && r.classification === 'preexisting'));
    if (unavailable.length) {
      failures.push({ code: 'required_check', message: `Required by your directive but not configured for this repository: ${unavailable.join(', ')}.`, remedy: null });
    } else if (alreadyFailing.length) {
      failures.push({ code: 'required_check', message: `Required by your directive, but already failing before this task (not a regression): ${alreadyFailing.join(', ')}.`, remedy: null });
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
