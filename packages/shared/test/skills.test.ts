import { describe, expect, it } from 'vitest';
import { filterSkills, requestedSkills, slashQueryAt, type SkillInfo } from '../src/index.js';

const known = new Set(['fix-bug', 'security-audit', 'tools:simplify', 'plan']);

describe('requestedSkills', () => {
  it('finds known /name tokens in order, once each', () => {
    expect(requestedSkills('/fix-bug the login test, then /security-audit. Again /fix-bug', known)).toEqual(['fix-bug', 'security-audit']);
  });

  it('accepts plugin names and trailing sentence punctuation', () => {
    expect(requestedSkills('Run /tools:simplify: then (/plan).', known)).toEqual(['tools:simplify', 'plan']);
  });

  it('ignores paths, URLs, unknown names and slashes inside words', () => {
    expect(requestedSkills('Call /api/tasks and /plan/steps, see https://x.dev/fix-bug and and/or /unknown-skill', known)).toEqual([]);
  });

  it('reads a token at the very start of the text', () => {
    expect(requestedSkills('/plan', known)).toEqual(['plan']);
  });
});

describe('slashQueryAt', () => {
  it('reports the token being typed at the caret', () => {
    expect(slashQueryAt('Please /fix', 11)).toEqual({ start: 7, query: 'fix' });
    expect(slashQueryAt('/', 1)).toEqual({ start: 0, query: '' });
    expect(slashQueryAt('use /tools:sim', 14)).toEqual({ start: 4, query: 'tools:sim' });
  });

  it('is null outside a token or inside a path', () => {
    expect(slashQueryAt('Please fix', 10)).toBeNull();
    expect(slashQueryAt('and/or', 6)).toBeNull();
    expect(slashQueryAt('/fix bug', 8)).toBeNull();
  });
});

describe('filterSkills', () => {
  const skills: SkillInfo[] = [
    { name: 'debug', description: 'Find a fix for a failing test', source: 'user', plugin: null },
    { name: 'fix-bug', description: null, source: 'user', plugin: null },
    { name: 'dx:fix-issue', description: null, source: 'plugin', plugin: 'dx' },
  ];

  it('puts names starting with the query first, plugin names by their bare part', () => {
    expect(filterSkills(skills, 'fix').map((s) => s.name)).toEqual(['fix-bug', 'dx:fix-issue', 'debug']);
  });

  it('returns everything, capped, for an empty query', () => {
    expect(filterSkills(skills, '', 2)).toHaveLength(2);
  });
});
