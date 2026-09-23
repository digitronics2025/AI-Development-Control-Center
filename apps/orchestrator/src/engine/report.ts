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

  const lastTestStage = [...stages].reverse().find((s) => s.kind === 'tests');
  const latestRuns = lastTestStage ? testRuns.filter((r) => r.stageId === lastTestStage.id) : [];
  const passed = latestRuns.filter((r) => r.status === 'passed').length;
  const failed = latestRuns.filter((r) => r.status === 'failed').length;
  const notRun = latestRuns.filter((r) => r.status === 'not_run' || r.status === 'blocked').length;
  const build = latestRuns.find((r) => r.kind === 'build');
  const hasTestsStage = task.workflow.stages.some((s) => s.kind === 'tests');

  if (input.testsSkipped) limitations.push('Verification commands were skipped with your approval; the change is not verified by tests.');
  if (hasTestsStage && !lastTestStage) limitations.push('No test stage ran.');
  if (failed > 0) limitations.push(`${failed} verification command(s) failed in the last run.`);
  const mixed = files?.filter((f) => f.origin === 'both') ?? [];
  if (mixed.length) limitations.push(`${mixed.length} file(s) mix your pre-existing uncommitted work with task changes: ${mixed.map((f) => f.path).join(', ')}.`);

  const verdictStages = stages.filter((s) => s.verdict !== null);
  const lastReview = [...verdictStages].reverse().find((s) => s.role === 'reviewer');
  const lastVerify = [...verdictStages].reverse().find((s) => s.role === 'verifier');
  if (lastReview?.verdict === 'FAIL') limitations.push('The last review did not pass.');
  if (lastVerify?.verdict === 'FAIL') limitations.push('The last verification did not pass.');

  const taskFiles = files?.filter((f) => f.origin !== 'preexisting') ?? [];
  const finalStatus: FinalStatus = limitations.length === 0 ? 'READY' : 'NEEDS_USER_ACTION';

  const lines = [
    `# ${finalStatus === 'READY' ? 'TASK COMPLETED' : 'TASK COMPLETED — NEEDS USER ACTION'}`,
    '',
    `**${task.id} · ${task.title}**`,
    '',
    `- Repository: ${repo.name} (${repo.path})`,
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
    `- Fix cycles used: ${task.fixCycles} of ${task.maxFixCycles}`,
    '',
    '## Cloud',
    '',
    input.deployed === 'staging' ? 'Staging deploy ran' : 'Not deployed',
    '',
    '## Git',
    '',
    `- Baseline: ${task.git.baselineBranch ?? '—'} @ ${task.git.baselineCommit?.slice(0, 10) ?? '—'}`,
    `- Task branch: ${task.git.taskBranch ?? 'none (worked on the current branch)'}`,
    `- Commits: ${task.git.commits.length ? task.git.commits.map((c) => c.slice(0, 10)).join(', ') : 'none — changes are uncommitted for your review'}`,
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
