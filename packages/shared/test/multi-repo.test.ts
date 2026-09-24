import { describe, expect, it } from 'vitest';
import { createTaskSchema, MAX_LINKED_REPOSITORIES } from '../src/index.js';

const base = { description: 'Rename the client call', repositoryId: 'api', workflowId: 'normal', mode: 'autopilot' as const };
const messages = (input: unknown) => {
  const r = createTaskSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('createTaskSchema — linked repositories', () => {
  it('accepts a task without linked repositories exactly as before', () => {
    expect(createTaskSchema.parse(base).linkedRepositoryIds).toBeUndefined();
  });

  it('accepts distinct linked repositories', () => {
    expect(createTaskSchema.parse({ ...base, linkedRepositoryIds: ['web', 'shared'] }).linkedRepositoryIds).toEqual(['web', 'shared']);
  });

  it('refuses the task repository listed again', () => {
    expect(messages({ ...base, linkedRepositoryIds: ['web', 'api'] })).toContain('The task repository is already included; choose other repositories to also work in');
  });

  it('refuses duplicates', () => {
    expect(messages({ ...base, linkedRepositoryIds: ['web', 'web'] })).toContain('Each repository can be added only once');
  });

  it(`refuses more than ${MAX_LINKED_REPOSITORIES} linked repositories`, () => {
    const ids = Array.from({ length: MAX_LINKED_REPOSITORIES + 1 }, (_, i) => `r${i}`);
    expect(messages({ ...base, linkedRepositoryIds: ids })).toContain(`A task can work in at most ${MAX_LINKED_REPOSITORIES + 1} repositories`);
    expect(messages({ ...base, linkedRepositoryIds: ids.slice(0, MAX_LINKED_REPOSITORIES) })).toEqual([]);
  });

  it('refuses worktree:false with linked repositories, but not with none', () => {
    expect(messages({ ...base, linkedRepositoryIds: ['web'], worktree: false })).toContain('A task across several repositories always runs in isolated worktrees');
    expect(messages({ ...base, linkedRepositoryIds: [], worktree: false })).toEqual([]);
  });
});
