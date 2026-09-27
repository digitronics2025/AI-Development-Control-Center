import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { git } from '@acc/git';
import { buildFinalReport } from '../src/engine/report.js';
import { addRepo, createTask, createTestApp, makeRepo, waitForStatus, IN_PLACE, TOKEN, type TestApp } from './helpers.js';

/** The completion artifacts are read by people and tools after the task: each must say what it seems to say. */

describe('git-diff.patch', () => {
  let t: TestApp;
  beforeEach(async () => {
    SimulatedAgentAdapter.reset();
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('is a patch Git can apply: it ends with exactly one newline', async () => {
    // A tracked file the simulated implementer appends to; LF on disk and no conversion, so the check means the same everywhere.
    const repoPath = await makeRepo({ files: { 'sim-output.md': '# Output\n' } });
    await git(repoPath, ['config', 'core.autocrlf', 'false']);
    const id = await createTask(t, await addRepo(t, repoPath, IN_PLACE), 'Add a line to the output file');
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(task.status).toBe('COMPLETED');

    const file = path.join(t.dataDir, 'tasks', id, 'git-diff.patch');
    const patch = readFileSync(file, 'utf8');
    expect(patch).toContain('+++ b/sim-output.md');
    // The change is uncommitted in the task branch checkout, so the patch must reverse cleanly out of it.
    const check = await git(repoPath, ['apply', '--check', '-R', file]);
    expect(check.code, check.stderr).toBe(0);
    expect(patch.endsWith('\n')).toBe(true);
    expect(patch.endsWith('\n\n')).toBe(false);
  });

  it('keeps CRLF lines byte-exact, carries binary files by object id, and withholds a file holding a secret', async () => {
    // Assembled at runtime: no credential-shaped literal in the repository (AGENTS.md).
    const secret = ['ghp', '_', 'A1b2C3d4'.repeat(5)].join('');
    const repoPath = await makeRepo({ files: { 'sim-output.md': '# Output\n' } });
    await git(repoPath, ['config', 'core.autocrlf', 'false']);
    writeFileSync(path.join(repoPath, 'run.bat'), 'echo one\r\necho two\r\n');
    writeFileSync(path.join(repoPath, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 13, 10]));
    await git(repoPath, ['add', 'run.bat', 'logo.bin']);
    await git(repoPath, ['commit', '-m', 'CRLF and binary files']);
    // Work already in the checkout when the task starts is part of the patch too.
    writeFileSync(path.join(repoPath, 'run.bat'), 'echo one\r\necho three\r\n');
    writeFileSync(path.join(repoPath, 'logo.bin'), Buffer.from([0, 1, 2, 4, 0, 255, 13, 10, 7]));
    writeFileSync(path.join(repoPath, 'added.bin'), Buffer.from([0, 0, 9, 200]));
    writeFileSync(path.join(repoPath, 'notes.txt'), `deploy token ${secret}\n`);
    const id = await createTask(t, await addRepo(t, repoPath, IN_PLACE), 'Add a line to the output file');
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(task.status).toBe('COMPLETED');

    const file = path.join(t.dataDir, 'tasks', id, 'git-diff.patch');
    const patch = readFileSync(file, 'latin1');
    expect(patch).toContain('+echo three\r\n');
    expect(patch).toContain('diff --git a/added.bin b/added.bin');
    // Binary files carry only their object ids: `git apply` takes them from the repository, and no payload (or secret in one) is in the artifact.
    expect(patch).toContain('Binary files a/logo.bin and b/logo.bin differ');
    expect(patch).not.toContain('GIT binary patch');
    expect(patch).not.toContain(secret);
    // The file holding the secret is left out with a note, so the rest of the patch still applies.
    expect(patch).toContain('[withheld from git-diff.patch: notes.txt held secret-shaped content]');
    const check = await git(repoPath, ['apply', '--check', '-R', file]);
    expect(check.code, check.stderr).toBe(0);
    expect(patch.endsWith('\n')).toBe(true);
  });
});

describe('final report Tests section', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 26, 12, m)).toISOString();
  const task = {
    id: 'TASK-0018', title: 'x', description: 'x', mode: 'autopilot', supervised: false, fixCycles: 0, maxFixCycles: 3, recoveryCycle: 0,
    git: { baselineBranch: 'main', baselineCommit: null, taskBranch: null, isolated: false, commits: [] }, workflow: { name: 'W', stages: [{ key: 'test', kind: 'tests' }] },
  } as never;
  const repo = { name: 'r', path: '/r' } as never;
  const stages = [
    { id: 'impl', role: 'implementer', kind: 'agent', status: 'SUCCESS', createdAt: at(1), name: 'Implement', summary: null, verdict: null, errorMessage: null },
    { id: 't1', role: 'tester', kind: 'tests', status: 'SUCCESS', createdAt: at(2), name: 'Test', summary: null, verdict: null, errorMessage: null },
  ] as never[];
  const run = (name: string, kind: string, status: string, summary: string | null) => ({ id: `run-${name}`, stageId: 't1', kind, name, status, durationMs: 2000, summary }) as never;
  const section = (testRuns: never[]) => {
    const md = buildFinalReport({ task, repo, stages, testRuns, files: [], testsSkipped: false, deployed: 'none' }).markdown;
    return md.slice(md.indexOf('## Tests'), md.indexOf('## Build'));
  };

  it('counts commands, not tests, and shows each passing run its runner totals', () => {
    // TASK-0018: one `node --test` command ran twelve tests; the report said "1 passed".
    const text = section([run('unit tests', 'test', 'passed', '12 passed (12)')]);
    expect(text).toContain('1 command passed · 0 failed · 0 not run');
    expect(text).toContain('- ✓ unit tests (2.0s) — 12 passed (12)');
  });

  it('names several commands in the plural and leaves a run without totals bare', () => {
    const text = section([run('lint', 'lint', 'passed', null), run('unit tests', 'test', 'passed', 'Tests 429 passed | 1 skipped (430)'), run('build', 'build', 'failed', 'error TS2322')]);
    expect(text).toContain('2 commands passed · 1 failed · 0 not run');
    expect(text).toMatch(/^- ✓ lint \(2\.0s\)$/m);
    expect(text).toContain('- ✓ unit tests (2.0s) — Tests 429 passed | 1 skipped (430)');
    expect(text).toContain('- ✕ build (2.0s) — error TS2322');
  });
});

describe('designer report', () => {
  let t: TestApp;
  beforeEach(async () => {
    SimulatedAgentAdapter.reset();
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('is saved as an implementation report and reaches the reviewer as {{implementation_report}}', async () => {
    t.services.workflows.save('design-flow', {
      name: 'Design flow',
      maxFixCycles: 0,
      stages: [
        { key: 'build', name: 'Build', role: 'designer', permissionLevel: 2, next: 'review' },
        { key: 'review', name: 'Design review', role: 'reviewer', permissionLevel: 1, verdict: true, next: 'complete' },
      ],
    });
    const id = await createTask(t, await addRepo(t, await makeRepo(), IN_PLACE), 'Restyle the landing page', { workflowId: 'design-flow' });
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    const artifacts = t.services.store.listArtifacts(id);
    const report = artifacts.find((a) => a.name === 'design-report.md');
    expect(report?.type).toBe('implementation-report');
    expect(artifacts.some((a) => a.name === 'design-prompt.md')).toBe(true);
    const designOutput = await t.services.artifacts.latestText(id, 'implementation-report');
    expect(designOutput).toBeTruthy();
    const reviewPrompt = artifacts.find((a) => a.name === 'review-prompt.md');
    const { content } = await t.services.artifacts.read(reviewPrompt!, 200_000);
    expect(content).toContain(designOutput!.trim().split('\n')[0]!);
  });
});

describe('final report Changed section', () => {
  it('lists what a designer stage changed, like an implementer', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 27, 12, m)).toISOString();
    const task = {
      id: 'TASK-0100', title: 'x', description: 'Restyle the landing page', mode: 'autopilot', supervised: false, fixCycles: 0, maxFixCycles: 3, recoveryCycle: 0,
      git: { baselineBranch: 'main', baselineCommit: null, taskBranch: null, isolated: false, commits: [] }, workflow: { name: 'Frontend Design', stages: [{ key: 'build', kind: 'agent' }] },
    } as never;
    const stages = [
      { id: 'b', role: 'designer', kind: 'agent', status: 'SUCCESS', createdAt: at(1), name: 'Build', summary: 'New hero, tokens and both themes', verdict: null, errorMessage: null },
    ] as never[];
    const md = buildFinalReport({ task, repo: { name: 'r', path: '/r' } as never, stages, testRuns: [], files: [], testsSkipped: false, deployed: 'none' }).markdown;
    expect(md.slice(md.indexOf('## Changed'), md.indexOf('## Files changed'))).toContain('- Build: New hero, tokens and both themes');
  });
});

describe('media artifacts', () => {
  let t: TestApp;
  beforeEach(async () => {
    SimulatedAgentAdapter.reset();
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('keep generated images and video with their media type, served only as downloads (SVG never inline)', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo(), IN_PLACE), 'Keep the hero image');
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const cases = [
      { name: 'hero.webp', type: 'image' as const, mime: 'image/webp' },
      { name: 'hero.avif', type: 'image' as const, mime: 'image/avif' },
      { name: 'icon.svg', type: 'image' as const, mime: 'image/svg+xml' },
      { name: 'loop.webm', type: 'video' as const, mime: 'video/webm' },
      { name: 'loop.mp4', type: 'video' as const, mime: 'video/mp4' },
    ];
    for (const c of cases) {
      const artifact = await t.services.artifacts.write(id, { name: c.name, type: c.type, content: png });
      expect(artifact).toMatchObject({ type: c.type, mime: c.mime, size: png.length });
      const res = await t.app.inject({ method: 'GET', url: `/api/artifacts/${artifact.id}/download`, headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(c.mime);
      expect(res.headers['content-disposition']).toMatch(/^attachment; /);
      expect(res.rawPayload.equals(png)).toBe(true);
    }
  });
});
