import type { LearningFinding, LearningSettings } from '@acc/shared';

/**
 * The desk's rules for acting on a finding by itself
 * (docs/systems/learning.md#desk). Pure: the service supplies the counts.
 */

/** Distinct tasks a model-read finding must appear in before the Chairman acts on it. */
export const MIN_TASKS = 2;
/** Lessons that reach one prompt, per scope. */
export const MAX_LESSONS_PER_SCOPE = 12;
/** Managed skills per scope (global, or one repository). */
export const MAX_SKILLS_PER_SCOPE = 10;

export interface DeskContext {
  settings: LearningSettings;
  actionsToday: number;
  /** Live lessons and skill recommendations in the finding's scope. */
  lessonsInScope: number;
  /** Live managed skills in the finding's scope. */
  skillsInScope: number;
  /** The same fingerprint was adopted before and then undone. */
  undoneBefore: boolean;
}

export type DeskDecision = { act: true } | { act: false; wait: boolean; reason: string };

export function deskDecision(finding: LearningFinding, ctx: DeskContext): DeskDecision {
  if (finding.status !== 'open') return { act: false, wait: false, reason: `Already ${finding.status.replace('_', ' ')}.` };
  if (!ctx.settings.enabled) return { act: false, wait: true, reason: 'Learning is turned off in Settings.' };
  // One sighting read by a model is an anecdote: it waits, whether or not it proposes anything.
  const enough = finding.taskCount >= MIN_TASKS || (finding.observed && finding.confidence === 'HIGH');
  if (!enough) return { act: false, wait: true, reason: `Seen in ${finding.taskCount} task${finding.taskCount === 1 ? '' : 's'}; the Chairman acts after ${MIN_TASKS}.` };
  if (!finding.proposal) return { act: false, wait: false, reason: 'Nothing the Chairman can change by itself; recorded for you.' };
  if (ctx.undoneBefore) return { act: false, wait: false, reason: 'The same change was tried before and undone; it is not tried again on its own.' };
  if (ctx.settings.autonomy !== 'act') return { act: false, wait: false, reason: 'Settings ask the Chairman to propose rather than act: waiting for you.' };
  if (ctx.actionsToday >= ctx.settings.maxActionsPerDay) return { act: false, wait: true, reason: `Today's limit of ${ctx.settings.maxActionsPerDay} improvements is used; it will be considered after the next task tomorrow.` };
  const type = finding.proposal.type;
  if ((type === 'ADD_LESSON' || type === 'USE_SKILL') && ctx.lessonsInScope >= MAX_LESSONS_PER_SCOPE) {
    return { act: false, wait: false, reason: `${MAX_LESSONS_PER_SCOPE} lessons are already live here; undo one to make room.` };
  }
  if ((type === 'AUTHOR_SKILL' || type === 'USE_SKILL') && ctx.skillsInScope >= MAX_SKILLS_PER_SCOPE) {
    return { act: false, wait: false, reason: `${MAX_SKILLS_PER_SCOPE} learned skills are already live here; undo one to make room.` };
  }
  return { act: true };
}

/**
 * An improvement is tried on `target` later tasks. The problem coming back in
 * at least half of them means it did not help — decided as soon as that many
 * recurrences are seen, since the rest could not change the verdict.
 */
export function trialVerdict(trial: { target: number; seen: number; recurrences: number }): 'continue' | 'keep' | 'undo' {
  if (trial.recurrences * 2 >= trial.target) return 'undo';
  return trial.seen >= trial.target ? 'keep' : 'continue';
}
