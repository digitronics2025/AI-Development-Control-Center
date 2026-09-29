import { describe, expect, it } from 'vitest';
import { editDistance, repositorySearchText, searchMatches, searchScore } from '../src/index.js';

/** The forgiving search behind the command palette and the Repositories filter. */

describe('searchScore', () => {
  it('matches every query word in any order, across separators', () => {
    expect(searchMatches('simple calc', 'Simple-calc')).toBe(true);
    expect(searchMatches('calc simple', 'Simple-calc')).toBe(true);
    expect(searchMatches('simple-calc', 'Simple-calc')).toBe(true);
    expect(searchMatches('SIMPLE', 'simple_calc')).toBe(true);
  });

  it('forgives a typo in a word of four letters or more', () => {
    expect(searchMatches('simple clac', 'Simple-calc')).toBe(true);
    expect(searchMatches('smiple', 'Simple-calc')).toBe(true);
    expect(searchMatches('calcualtor', 'calculator-app')).toBe(true);
    expect(searchMatches('calcul', 'calculator-app')).toBe(true);
    expect(searchMatches('calxul', 'calculator-app')).toBe(true);
  });

  it('gives short words no typo budget', () => {
    expect(searchMatches('cla', 'Simple-calc')).toBe(false);
    expect(searchMatches('cal', 'Simple-calc')).toBe(true);
  });

  it('fails when any word has no match', () => {
    expect(searchMatches('simple budget', 'Simple-calc')).toBe(false);
    expect(searchMatches('zzzz', 'Go to Agents')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(searchScore('', 'anything')).toBe(0);
    expect(searchScore('   ', 'anything')).toBe(0);
  });

  it('ranks word starts above inner matches above typos, and the typed phrase highest', () => {
    const prefix = searchScore('calc', 'calc-tool')!;
    const inner = searchScore('calc', 'minicalc')!;
    const typo = searchScore('clac', 'calc-tool')!;
    expect(prefix).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(typo);
    expect(searchScore('go to agents', 'Go to Agents')!).toBeGreaterThan(searchScore('agents go to', 'Go to Agents')!);
  });
});

describe('editDistance', () => {
  it('counts an adjacent swap as one edit', () => {
    expect(editDistance('clac', 'calc')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('stops early past the cap', () => {
    expect(editDistance('aaaaaaaa', 'bbbbbbbb', 1)).toBe(2);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
  });
});

describe('repositorySearchText', () => {
  it('uses the name and the folder name, never the parent folders', () => {
    expect(repositorySearchText({ name: 'Simple-calc', path: 'C:\\Users\\me\\simple-calc' })).toBe('Simple-calc simple-calc');
    expect(repositorySearchText({ name: 'app', path: '/home/me/app/' })).toBe('app');
    expect(searchMatches('users', repositorySearchText({ name: 'app', path: 'C:\\Users\\me\\app' }))).toBe(false);
  });
});
