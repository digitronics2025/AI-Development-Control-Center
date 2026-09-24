/**
 * Placeholders a role prompt template may use (docs/systems/prompts.md). The
 * context builder fills every one of them for every agent stage, so a
 * template can use any of them; a name outside this list is refused when a
 * template is saved, and a value that is empty for this stage renders as
 * "(none)".
 */
export const PROMPT_PLACEHOLDERS = {
  task_id: 'The task id, for example TASK-0042',
  title: 'The task title',
  role: "This stage's role label, for example Implementer",
  stage_name: "This stage's name in the workflow, for example Second opinion",
  workflow_name: 'The workflow profile the task runs',
  request: 'The task title and description, as the operator wrote them',
  attachments: 'Text attachments inline (up to 50 KB each); other files by path',
  repository_name: 'The repository name',
  repository_path: "This task's working directory: its worktree when isolated",
  repository_facts: 'Path, detected tooling, task branch, baseline commit and configured commands',
  git_status: 'git status of the working directory when the stage starts (first 80 entries)',
  directives: 'Active user directives for this stage: constraints, completion requirements, instructions',
  investigation: 'Every investigation report of this task so far',
  plan: 'The latest plan',
  implementation_report: 'Every implementation and fix report so far (20 KB each)',
  review: 'The latest review',
  test_results: "The last test stage: each command's status, the failing output tail, a rejected commit hook",
  verification_report: 'The latest app check (browser or HTTP) the orchestrator ran',
  changed_files: 'Files changed since the task baseline, each marked task change or pre-existing user work',
  diff: 'The diff against the task baseline (150 KB at most), redacted',
  verification_commands: 'The lint, typecheck, test and build commands the orchestrator runs after a change',
  preexisting_changes: 'Files with uncommitted user work when the task started, or none',
  previous_attempt: 'How the previous run of this stage ended, with its last output lines',
  fix_cycle: 'Fix cycles used so far (the current one during a fix stage)',
  max_fix_cycles: "The task's fix cycle limit",
} as const;

export type PromptPlaceholder = keyof typeof PROMPT_PLACEHOLDERS;

/** `{{name}}`, with optional spaces inside the braces. A fresh copy is needed per scan (global state). */
export const PLACEHOLDER_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Every distinct placeholder name a template uses, in order of first use. */
export function placeholdersIn(body: string): string[] {
  return [...new Set([...body.matchAll(new RegExp(PLACEHOLDER_PATTERN))].map((m) => m[1]!))];
}

/** Placeholder names a template uses that the context builder never fills. */
export function unknownPlaceholders(body: string): string[] {
  return placeholdersIn(body).filter((name) => !(name in PROMPT_PLACEHOLDERS));
}
