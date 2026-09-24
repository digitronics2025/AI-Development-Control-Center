import { describe, expect, it } from 'vitest';
import { classifyMessage } from '../src/chairman/intent.js';

/** Regression tests for the 2026-09-24 pre-release audit: chat commands (F-07). */

const ctx = { stages: [], agents: [] } as never;
const c = (text: string) => classifyMessage(text, ctx);

describe('F-07: a rollback is a bare command, not any sentence with "undo" in it', () => {
  it.each(['Roll back', 'rollback', 'Undo that.', 'Revert the last bad change', 'Please undo the last attempt', 'roll back the previous stage now', 'Could you roll back?', '/rollback'])('%s rolls back', (text) => {
    expect(c(text).actions).toEqual([{ type: 'ROLLBACK_CHECKPOINT', params: {} }]);
  });

  it.each([
    'Please undo the temporary console.log before finishing',
    'Revert the lockfile change and keep the rest',
    'Undo your change to the README',
    'Could you revert the lockfile change?',
    "Don't roll back anything",
    'Make sure the migration can be rolled back',
  ])('%s is not a rollback', (text) => {
    expect(c(text).actions.some((a) => a.type === 'ROLLBACK_CHECKPOINT')).toBe(false);
  });
});
