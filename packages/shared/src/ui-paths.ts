import type { StageCondition } from './constants.js';

/**
 * Which changed files are user-interface work (docs/plans/DESIGNER_ROUTING_PLAN.md §5):
 * what a visual critique in Full Autopilot looks at, and what decides whether
 * it runs. Pure, so the engine, the completion gate and the dashboard agree.
 *
 * Paths are repository-relative with `/` separators — never a multi-repository
 * task's folder prefix, whose name (`ui`, `tests`) would decide every file.
 */

/** Files that are the look itself: markup, styles, components, images, fonts. */
const UI_EXTENSION = /\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|styl|html?|svg|png|jpe?g|webp|avif|gif|ico|woff2?)$/i;
/** Script files that are UI by where they live (a component folder, a theme). */
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s)$/i;
const UI_FOLDERS = new Set(['components', 'pages', 'views', 'layouts', 'styles', 'theme', 'themes', 'ui']);
/** Tests, stories' snapshots and generated reports are not the look, even in a component folder. */
const NOT_UI = /(?:^|\/)(?:__tests__|__snapshots__|e2e|tests?|playwright-report|test-results|coverage|node_modules|dist|build)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;
/** The repository's design standard and design memory (context.ts designContext reads the same files). */
const DESIGN_STANDARD = /^(?:design\.md|DESIGN\.md|docs\/design\.md|design\/.+)$/;
const THEME_CONFIG = /(?:^|\/)(?:tailwind|postcss)\.config\.[cm]?[jt]s$/i;

/** Whether one changed file is user-interface work. */
export function isUiPath(repoRelativePath: string): boolean {
  const file = repoRelativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!file || file.endsWith('/')) return false;
  if (DESIGN_STANDARD.test(file)) return true;
  if (NOT_UI.test(file)) return false;
  if (THEME_CONFIG.test(file)) return true;
  if (UI_EXTENSION.test(file)) return true;
  if (!SCRIPT_EXTENSION.test(file) || /\.d\.[cm]?ts$/i.test(file)) return false;
  const folders = file.split('/').slice(0, -1);
  return folders.some((segment) => UI_FOLDERS.has(segment.toLowerCase()));
}

/** What the engine knows about the task's own changes when a condition is judged; null = unknown (no Git baseline, unreadable). */
export interface StageConditionFacts {
  uiChanged: boolean | null;
}

/**
 * Whether a stage with `when` runs. Unknown facts count as "holds": the stage
 * runs and the completion gate requires it (fail closed). No condition always holds.
 */
export function stageConditionHolds(when: StageCondition | undefined, facts: StageConditionFacts): boolean {
  if (!when) return true;
  switch (when) {
    case 'ui-changed':
      return facts.uiChanged !== false;
  }
}

/** Why a stage with `when` was skipped, for the timeline and the report. */
export const STAGE_CONDITION_SKIP: Record<StageCondition, string> = {
  'ui-changed': 'No user-interface files changed in this task',
};

/** What `when` means, for the workflow editor. */
export const STAGE_CONDITION_LABEL: Record<StageCondition, string> = {
  'ui-changed': 'Runs only when user-interface files change',
};
