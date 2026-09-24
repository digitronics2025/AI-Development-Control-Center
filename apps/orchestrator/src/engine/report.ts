import { taskIdFromBranch } from '@acc/git';
import type { ChangedFile, FinalStatus, StageInstance, TestRun } from '@acc/shared';
import type { RepositoryRecord, TaskRecord } from '../store/store.js';

export interface ReportInput {
  task: TaskRecord;
  repo: RepositoryRecord;
  stages: StageInstance[];
  testRuns: TestRun[];
  files: ChangedFile[] | null;
  testsSkipped: boolean;
  deployed: 'none' | 'staging';
  /** Items the last review or verification said only the operator can settle. */
  operatorItems?: string[];
  /** Completion-gate checks that did not pass on a supervised task. */
  gateLimitations?: string[];
  /** Verification matrix for the project type (docs/plans/tool-layer-v2 §42). */
  verification?: { type: string; satisfied: string[]; missing: string[] } | null;
  /** Tool calls, repairs, escalations and processes. */
  executionLines?: string[];
  /** Re-checks the operator attached from Private Browser (docs/systems/connected-apps.md): informational, never a pass. */
  browserRechecks?: string[];
  /** A task across repositories: each one with its folder and Git record, primary first. */
  repositories?: Array<{ name: string; path: string; folder: string | null; git: TaskRecord['git'] }>;
}

/** The Git lines of one repository's task branch. */
function gitLines(task: TaskRecord, git: TaskRecord['git']): string[] {
  const owner = taskIdFromBranch(git.baselineBranch);
  const stackedOn = owner !== task.id ? owner : null;
  return [
    `- Baseline: ${git.baselineBranch ?? '—'} @ ${git.baselineCommit?.slice(0, 10) ?? '—'}${stackedOn ? ` (${stackedOn}'s branch — merge ${stackedOn} first)` : ''}`,
    `- Task branch: ${git.taskBranch ?? 'none (worked on the current branch)'}${git.isolated ? ' — worked in an isolated worktree; your working tree was not touched. Merge the branch to take the change.' : ''}`,
    `- Commits: ${git.commits.length ? git.commits.map((c) => c.slice(0, 10)).join(', ') : 'none — changes are uncommitted for your review'}`,
  ];
}

const MAX_OPERATOR_ITEMS = 10;

/** `NEEDS OPERATOR: …` lines from a reviewer's or verifier's output (see prompts/verifier.md). */
export function extractOperatorItems(...outputs: Array<string | null | undefined>): string[] {
  const items = new Set<string>();
  for (const output of outputs) {
    for (const match of (output ?? '').matchAll(/^[\s>*+-]*\**NEEDS OPERATOR:?\**:?\s*(.+)$/gim)) {
      const text = match[1]!.replace(/\*\*/g, '').trim();
      if (text) items.add(text.length > 300 ? `${text.slice(0, 299)}…` : text);
    }
  }
  return [...items].slice(0, MAX_OPERATOR_ITEMS);
}

/**
 * `BLOCKED ON OPERATOR: …` lines from a work stage (investigator, planner,
 * implementer, fixer): the task cannot be done right without the operator's
 * answer, so it stops instead of testing, fixing and recovering around a
 * question no agent may settle (see prompts/implementer.md).
 */
export function extractOperatorBlockers(output: string | null | undefined): string[] {
  const items = new Set<string>();
  for (const match of (output ?? '').matchAll(/^[\s>*+-]*\**BLOCKED ON OPERATOR:?\**:?\s*(.+)$/gim)) {
    const text = match[1]!.replace(/\*\*/g, '').trim();
    if (text) items.add(text.length > 600 ? `${text.slice(0, 599)}…` : text);
  }
  return [...items].slice(0, MAX_OPERATOR_ITEMS);
}

/**
 * The operator decisions to report. The verifier reads the review before it
 * writes, so when a verification exists its list is the current one; taking
 * both listed the same concern twice in different words. Without a
 * verification the review's list stands.
 */
export function latestOperatorItems(review: string | null | undefined, verification: string | null | undefined): string[] {
  return verification ? extractOperatorItems(verification) : extractOperatorItems(review);
}

export interface ReportResult {
  markdown: string;
  finalStatus: FinalStatus;
  limitations: string[];
}

/**
 * Completion report (PLAN §34). Built from recorded facts — test runs,
 * verdicts, the Git diff — never from an agent's own claim of success.
 */
export function buildFinalReport(input: ReportInput): ReportResult {
  const { task, repo, stages, testRuns, files } = input;
  const limitations: string[] = [];

  // The test run that counts is the last one that finished — a cancelled or interrupted
  // instance proves nothing — and it must come after the last change (audit F-06, as gate.ts).
  const lastTestStage = [...stages].reverse().find((s) => s.kind === 'tests' && (s.status === 'SUCCESS' || s.status === 'FAILED' || s.status === 'SKIPPED'));
  const lastWrite = [...stages].reverse().find((s) => (s.role === 'implementer' || s.role === 'fixer') && s.status === 'SUCCESS');
  const latestRuns = lastTestStage ? testRuns.filter((r) => r.stageId === lastTestStage.id) : [];
  const passed = latestRuns.filter((r) => r.status === 'passed').length;
  const failed = latestRuns.filter((r) => r.status === 'failed').length;
  const notRun = latestRuns.filter((r) => r.status === 'not_run' || r.status === 'blocked').length;
  const build = latestRuns.find((r) => r.kind === 'build');
  const hasTestsStage = task.workflow.stages.some((s) => s.kind === 'tests');

  if (input.testsSkipped) limitations.push('Verification commands were skipped with your approval; the change is not verified by tests.');
  if (hasTestsStage && !lastTestStage && !input.testsSkipped) limitations.push('No test stage ran.');
  if (failed > 0) limitations.push(`${failed} verification command(s) failed in the last run.`);
  else if (lastTestStage?.status === 'FAILED') limitations.push('The last test stage failed.');
  if (lastTestStage?.status === 'SUCCESS' && latestRuns.length && passed === 0) limitations.push('No verification command passed in the last test run.');
  if (lastTestStage && lastWrite && lastWrite.createdAt > lastTestStage.createdAt) limitations.push('Tests have not run since the last change.');
  const lastVerifyStage = [...stages].reverse().find((s) => s.kind === 'verify' && s.status !== 'SKIPPED' && s.status !== 'CANCELLED');
  if (lastVerifyStage?.status === 'FAILED') limitations.push(`The last browser/HTTP verification failed: ${lastVerifyStage.errorMessage ?? 'see browser-verification.md'}`);
  const mixed = files?.filter((f) => f.origin === 'both') ?? [];
  if (mixed.length) limitations.push(`${mixed.length} file(s) mix your pre-existing uncommitted work with task changes: ${mixed.map((f) => f.path).join(', ')}.`);

  const verdictStages = stages.filter((s) => s.verdict !== null);
  const lastReview = [...verdictStages].reverse().find((s) => s.role === 'reviewer');
  const lastVerify = [...verdictStages].reverse().find((s) => s.role === 'verifier');
  if (lastReview?.verdict === 'FAIL') limitations.push('The last review did not pass.');
  if (lastVerify?.verdict === 'FAIL') limitations.push('The last verification did not pass.');
  for (const item of input.operatorItems ?? []) limitations.push(`Needs your decision: ${item}`);
  for (const item of input.gateLimitations ?? []) if (!limitations.includes(item)) limitations.push(item);

  const taskFiles = files?.filter((f) => f.origin !== 'preexisting') ?? [];
  const multi = (input.repositories?.length ?? 0) > 1 ? input.repositories! : null;
  const finalStatus: FinalStatus = limitations.length === 0 ? 'READY' : 'NEEDS_USER_ACTION';

  const lines = [
    `# ${finalStatus === 'READY' ? 'TASK COMPLETED' : 'TASK COMPLETED — NEEDS USER ACTION'}`,
    '',
    `**${task.id} · ${task.title}**`,
    '',
    ...(multi ? [`- Repositories: ${multi.map((r) => `${r.name} (${r.path}) as ${r.folder}/`).join(', ')}`] : [`- Repository: ${repo.name} (${repo.path})`]),
    `- Workflow: ${task.workflow.name}`,
    `- Mode: ${task.mode === 'discuss' ? 'Discuss First' : 'Autopilot'}`,
    '',
    '## Requested',
    '',
    task.description.trim(),
    '',
    '## Changed',
    '',
    ...(stages
      .filter((s) => (s.role === 'implementer' || s.role === 'fixer') && s.status === 'SUCCESS' && s.summary)
      .map((s) => `- ${s.name}: ${s.summary}`) as string[]),
    '',
    '## Files changed',
    '',
    ...(files === null
      ? ['Not a Git repository — changes could not be tracked.']
      : taskFiles.length
        ? taskFiles.map((f) => `- ${f.path} (${f.status}${f.additions !== null ? `, +${f.additions}` : ''}${f.deletions !== null ? ` -${f.deletions}` : ''}${f.origin === 'both' ? ', mixed with your work' : ''})`)
        : ['No files changed.']),
    '',
    '## Tests',
    '',
    latestRuns.length
      ? `${passed} passed · ${failed} failed · ${notRun} not run`
      : input.testsSkipped
        ? 'Skipped with approval'
        : 'Not run',
    ...latestRuns.map((r) => `- ${r.status === 'passed' ? '✓' : r.status === 'failed' ? '✕' : '○'} ${r.name}${r.durationMs !== null ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : ''}${r.summary && r.status === 'failed' ? ` — ${r.summary}` : ''}`),
    '',
    '## Build',
    '',
    build ? (build.status === 'passed' ? 'Passed' : build.status === 'failed' ? 'Failed' : 'Not run') : 'No build command configured',
    '',
    '## Review',
    '',
    `- Review: ${lastReview ? (lastReview.verdict === 'PASS' ? 'passed' : 'issues remain') : 'no review stage'}`,
    ...(lastVerify ? [`- Verification: ${lastVerify.verdict === 'PASS' ? 'passed' : 'failed'}`] : []),
    ...(task.supervised
      ? [
          `- Fix attempts: ${stages.filter((s) => s.role === 'fixer').length} across ${task.recoveryCycle + 1} strateg${task.recoveryCycle ? 'ies' : 'y'}`,
          `- Chairman recovery cycles: ${task.recoveryCycle}`,
        ]
      : [`- Fix cycles used: ${task.fixCycles} of ${task.maxFixCycles}`]),
    '',
    ...(input.verification
      ? [
          '## Verification coverage',
          '',
          `- Project type: ${input.verification.type}`,
          `- Verified: ${input.verification.satisfied.join(', ') || 'nothing yet'}`,
          ...(input.verification.missing.length ? [`- Not verified: ${input.verification.missing.join(', ')}`] : []),
          ...(input.browserRechecks?.length ? [`- Operator-observed browser evidence: ${input.browserRechecks.join(', ')}`] : []),
          '',
        ]
      : input.browserRechecks?.length
        ? ['## Verification coverage', '', `- Operator-observed browser evidence: ${input.browserRechecks.join(', ')}`, '']
        : []),
    ...(input.executionLines?.length ? ['## Execution', '', ...input.executionLines, ''] : []),
    '## Cloud',
    '',
    input.deployed === 'staging' ? 'Staging deploy ran' : 'Not deployed',
    '',
    '## Git',
    '',
    ...(multi ? multi.flatMap((r) => [`### ${r.name} (${r.folder}/)`, '', ...gitLines(task, r.git), '']) : gitLines(task, task.git)),
    '',
    '## Remaining limitations',
    '',
    ...(limitations.length ? limitations.map((l) => `- ${l}`) : ['None recorded.']),
    '',
    '## Final status',
    '',
    finalStatus === 'READY' ? 'READY' : 'NEEDS USER ACTION',
    '',
  ];
  return { markdown: lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n'), finalStatus, limitations };
}
