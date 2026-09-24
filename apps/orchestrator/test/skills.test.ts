import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { addRepo, createTask, createTestApp, repoWithSkill, waitFor, waitForStatus, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

describe('requested skills in stage prompts', () => {
  it('names each /skill from the description with its description, and ignores paths', async () => {
    const repositoryId = await addRepo(t, await repoWithSkill());
    const id = await createTask(t, repositoryId, 'Run /file-census and write the result to CENSUS.md; do not touch /api/tasks or /unknown-skill.');
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    const prompt = readFileSync(path.join(t.dataDir, 'tasks', id, 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('## Requested skills');
    expect(prompt).toContain('- `file-census` — Count the files in this repository');
    expect(prompt).toContain('You are the implementer in stage');
    expect(prompt).not.toContain('`api');
    expect(prompt).not.toContain('`unknown-skill`');
  });

  it('also reads skills named in a directive', async () => {
    const repositoryId = await addRepo(t, await repoWithSkill());
    const id = await createTask(t, repositoryId, 'Slow work [sim:slow]');
    await waitFor(() => t.services.store.latestStage(id, 'investigate'), (s) => s?.status === 'RUNNING', 20_000);
    expect((await t.api('POST', `/api/tasks/${id}/directives`, { text: 'Before finishing, run /file-census.' })).status).toBe(200);
    const promptFile = path.join(t.dataDir, 'tasks', id, 'implementation-prompt.md');
    await waitFor(() => existsSync(promptFile), (found) => found, 60_000);
    expect(readFileSync(promptFile, 'utf8')).toContain('- `file-census` — Count the files in this repository');
    await t.api('POST', `/api/tasks/${id}/cancel`);
  });

  it('adds no section when the description names no skill', async () => {
    const repositoryId = await addRepo(t, await repoWithSkill());
    const id = await createTask(t, repositoryId, 'Add a greeting; see docs/guide and /api/tasks.');
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    const prompt = readFileSync(path.join(t.dataDir, 'tasks', id, 'implementation-prompt.md'), 'utf8');
    expect(prompt).not.toContain('## Requested skills');
  });
});

describe('GET /api/skills', () => {
  it('lists the skills the enabled agents would load in the repository', async () => {
    const repositoryId = await addRepo(t, await repoWithSkill());
    const res = await t.api('GET', `/api/skills?repositoryId=${repositoryId}`);
    expect(res.status).toBe(200);
    expect(res.body.agents.sort()).toEqual(['claude', 'codex']);
    // Both simulated agents report it; the catalog lists it once.
    expect(res.body.skills).toEqual([{ name: 'file-census', description: 'Count the files in this repository', source: 'project', plugin: null }]);
  });

  it('leaves out disabled agents', async () => {
    const repositoryId = await addRepo(t, await repoWithSkill());
    await t.api('PATCH', '/api/agents/codex', { enabled: false });
    const res = await t.api('GET', `/api/skills?repositoryId=${repositoryId}`);
    expect(res.body.agents).toEqual(['claude']);
  });

  it('answers 404 for an unknown repository and 400 without one', async () => {
    expect((await t.api('GET', '/api/skills?repositoryId=nope')).status).toBe(404);
    expect((await t.api('GET', '/api/skills')).status).toBe(400);
  });
});
