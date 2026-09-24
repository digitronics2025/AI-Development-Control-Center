import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeSkills, readSkillFrontmatter, scanSkillDirectory, SimulatedAgentAdapter } from '../src/index.js';

describe('readSkillFrontmatter', () => {
  it('reads plain, quoted and block values', () => {
    expect(readSkillFrontmatter('---\nname: fix-bug\ndescription: Fix a bug\n---\nbody')).toEqual({ name: 'fix-bug', description: 'Fix a bug' });
    expect(readSkillFrontmatter('---\nname: "plan"\ndescription: \'It\'\'s a plan\'\n---')).toEqual({ name: 'plan', description: "It's a plan" });
    expect(readSkillFrontmatter('---\r\nname: x\r\ndescription: >\r\n  First line\r\n  second line\r\nallowed-tools: Read\r\n---')).toEqual({ name: 'x', description: 'First line second line' });
  });

  it('reads a file saved with a byte-order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(readSkillFrontmatter(`${bom}---\nname: bom\n---`)).toEqual({ name: 'bom' });
    expect(readSkillFrontmatter('FEFF---\nname: x\n---')).toEqual({});
  });

  it('returns nothing without frontmatter and ignores the body', () => {
    expect(readSkillFrontmatter('# Title\nname: nope')).toEqual({});
    expect(readSkillFrontmatter('---\nname: a\n---\ndescription: body text')).toEqual({ name: 'a' });
  });
});

describe('scanSkillDirectory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-skills-'));
  const skill = (folder: string, frontmatter: string) => {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, 'SKILL.md'), `---\n${frontmatter}---\nBody\n`);
  };
  skill('fix-bug', 'description: Fix a failing test\n');
  skill('named', 'name: other-name\ndescription: "Uses its own name"\n');
  skill('long', `description: ${'x'.repeat(400)}\n`);
  mkdirSync(path.join(dir, 'no-skill-file'));
  writeFileSync(path.join(dir, 'README.md'), 'not a skill');

  it('lists folders with a SKILL.md, sorted, named by frontmatter or folder', async () => {
    const skills = await scanSkillDirectory(dir, 'user');
    expect(skills.map((s) => s.name)).toEqual(['fix-bug', 'long', 'other-name']);
    expect(skills[0]).toEqual({ name: 'fix-bug', description: 'Fix a failing test', source: 'user', plugin: null });
    expect(skills[1]!.description!.length).toBeLessThanOrEqual(240);
  });

  it('prefixes plugin skills and lists nothing for a missing folder', async () => {
    expect((await scanSkillDirectory(dir, 'plugin', 'dx')).map((s) => s.name)).toContain('dx:fix-bug');
    expect(await scanSkillDirectory(path.join(dir, 'missing'), 'project')).toEqual([]);
  });

  it("lets the simulated agent list a repository's own skills", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'acc-sim-skills-'));
    mkdirSync(path.join(repo, '.claude', 'skills', 'census'), { recursive: true });
    writeFileSync(path.join(repo, '.claude', 'skills', 'census', 'SKILL.md'), '---\ndescription: Count files\n---\n');
    const skills = await new SimulatedAgentAdapter('claude').listSkills({ billingMode: 'subscription', baseEnv: {} }, repo);
    expect(skills).toEqual([{ name: 'census', description: 'Count files', source: 'project', plugin: null }]);
  });

  it('keeps the first entry per name when merging', () => {
    const a = { name: 'x', description: 'repo', source: 'project' as const, plugin: null };
    const b = { name: 'x', description: 'user', source: 'user' as const, plugin: null };
    expect(mergeSkills([a], [b])).toEqual([a]);
  });
});
