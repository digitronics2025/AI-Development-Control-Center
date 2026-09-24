import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { api, expectNoAxeViolations, setTheme, trackConsoleErrors } from './helpers';

/**
 * The whole operator journey through the real product, once, in order:
 *
 *   add a repository → configure how its app starts → start a Discuss First
 *   task on Full Autopilot → approve the plan → implement → the repository's
 *   own lint/test/build → the app started and checked in Chromium → a failed
 *   review and one fix cycle → verify → a Git commit on the task branch →
 *   completion report, Source Control history and usage.
 *
 * Only the agents are simulated (scripts/demo.mjs). The repository is a real
 * Git repository created here, its tests are real `node --test` suites, its
 * app is a real HTTP server, and every claim the UI makes is checked against
 * the repository on disk.
 */

const NAME = 'shop-journey';
const repoDir = path.join(process.env.ACC_E2E_DATA_ROOT!, 'journey', NAME);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();

test.describe.configure({ mode: 'serial' });

/** A free loopback port for the fixture app. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function makeRepository(): void {
  rmSync(repoDir, { recursive: true, force: true });
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
    writeFileSync(path.join(repoDir, file), content);
  };
  write(
    'package.json',
    JSON.stringify(
      {
        name: NAME,
        private: true,
        type: 'module',
        scripts: { lint: 'node scripts/lint.mjs', test: 'node --test', build: 'node scripts/build.mjs' },
      },
      null,
      2,
    ),
  );
  write('README.md', `# ${NAME}\n\nA tiny shop used by the end-to-end journey.\n`);
  write('src/cart.mjs', 'export const total = (items) => items.reduce((sum, i) => sum + i.price * i.qty, 0);\n');
  write(
    'test/cart.test.mjs',
    [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { total } from '../src/cart.mjs';",
      '',
      "test('an empty cart costs nothing', () => assert.equal(total([]), 0));",
      "test('quantities multiply prices', () => assert.equal(total([{ price: 250, qty: 2 }, { price: 100, qty: 1 }]), 600));",
      '',
    ].join('\n'),
  );
  write('scripts/lint.mjs', "import { readFileSync } from 'node:fs';\nif (readFileSync('src/cart.mjs', 'utf8').includes('var ')) process.exit(1);\nconsole.log('lint ok');\n");
  write('scripts/build.mjs', "import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('src/cart.mjs', 'dist/cart.mjs');\nconsole.log('built dist/cart.mjs');\n");
  // The app the App check stage starts: a real HTTP server on the port it is given.
  write(
    'server.mjs',
    [
      "import http from 'node:http';",
      'const port = Number(process.argv[2]);',
      'const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shop</title></head><body><main><h1>Shop</h1><p>Your cart is empty.</p></main></body></html>`;',
      "http.createServer((req, res) => {",
      "  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }",
      "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
      '  res.end(page);',
      "}).listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));",
      '',
    ].join('\n'),
  );
  write('.gitignore', 'dist/\nnode_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  git('config', 'user.email', 'journey@example.com');
  git('config', 'user.name', 'Journey');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-qm', 'Initial shop');
}

let appPort = 0;
let baseline = '';
let taskId = '';
let taskBranch = '';

test.beforeAll(async ({ browser }) => {
  makeRepository();
  baseline = git('rev-parse', 'HEAD');
  appPort = await freePort();
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});

async function taskStatus(page: Page): Promise<string> {
  const task = await api<{ status: string; blocker: { kind: string } | null }>(page, 'GET', `/api/tasks/${taskId}`);
  return task.blocker ? `${task.status}:${task.blocker.kind}` : task.status;
}

test('registers a local repository and detects its commands', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Add repository' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add repository' });
  await dialog.getByLabel('Folder path').fill(repoDir);
  await dialog.getByLabel('Display name').fill(NAME);
  await dialog.getByRole('button', { name: 'Add repository' }).click();

  await expect(page).toHaveURL(/\/repositories\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();
  await expect(page.getByText('Clean', { exact: true })).toBeVisible();
  // lint/test/build come from package.json, not from anything typed here.
  const commands = page.getByRole('textbox', { name: 'Command', exact: true });
  await expect(commands).toHaveCount(3);
  expect(await commands.evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value))).toEqual(['npm run lint', 'npm test', 'npm run build']);

  // How the App check stage starts the app and where it answers.
  await page.getByLabel('Start command').fill(`node server.mjs ${appPort}`);
  await page.getByLabel('Address').fill(`http://127.0.0.1:${appPort}`);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Repository settings saved' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

  const repos = await api<Array<{ name: string; path: string; runtime: { devCommand: string | null; devUrl: string | null } }>>(page, 'GET', '/api/repositories');
  const saved = repos.find((r) => r.name === NAME)!;
  expect(saved.runtime.devCommand).toBe(`node server.mjs ${appPort}`);
  expect(saved.runtime.devUrl).toBe(`http://127.0.0.1:${appPort}`);
  expect(errors).toEqual([]);
});

test('starts a Discuss First task on Full Autopilot and waits for plan approval', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tasks/new');
  await page.getByRole('combobox', { name: 'Repository' }).click();
  await page.getByRole('searchbox').fill(NAME);
  await page.keyboard.press('Enter');
  await page.getByLabel('Description').fill('Show the cart total on the shop page. Keep the existing tests passing. [sim:review-fail-once]');
  await page.getByRole('combobox', { name: 'Workflow' }).click();
  await page.getByRole('option', { name: /Full Autopilot/ }).click();
  await page.getByRole('radio', { name: 'Discuss First' }).click();
  await page.getByRole('button', { name: 'Start Task' }).click();

  await expect(page).toHaveURL(/\/tasks\/TASK-\d+/);
  taskId = /TASK-\d+/.exec(page.url())![0];
  const stages = page.getByRole('list', { name: 'Workflow stages' });
  for (const name of ['Investigate', 'Plan', 'Implement', 'Test', 'App check', 'Review', 'Verify', 'Git checkpoint']) await expect(stages).toContainText(name);

  // Discuss First: nothing is implemented before the plan is approved.
  await expect.poll(() => taskStatus(page), { timeout: 30_000 }).toBe('WAITING_FOR_USER:approval');
  await expect(page.getByText('Approval needed: Approve plan and start implementation').first()).toBeVisible();
  expect(readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toContain(NAME);
  expect(() => readFileSync(path.join(repoDir, 'sim-output.md'))).toThrow();

  // Read-only stages leave Git alone: no baseline, no task branch yet.
  const task = await api<{ git: { taskBranch: string | null; baselineCommit: string | null } }>(page, 'GET', `/api/tasks/${taskId}`);
  expect(task.git).toMatchObject({ baselineCommit: null, taskBranch: null });
  expect(git('branch', '--show-current')).toBe('main');
  expect(git('status', '--porcelain')).toBe('');
  expect(errors).toEqual([]);
});

test('approving the plan runs the workflow to a verified, committed completion', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/approvals');
  const card = page.getByRole('article').filter({ hasText: taskId });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByRole('article').filter({ hasText: taskId })).toHaveCount(0);

  // Watch it live on the task page: the stage list and header update over the WebSocket.
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
  expect(await taskStatus(page)).toBe('COMPLETED');
  expect(errors).toEqual([]);
});

test('the repository on disk matches what the task reports', async ({ page }) => {
  await page.goto('/');
  const task = await api<{
    status: string;
    fixCycles: number;
    git: { taskBranch: string | null; baselineCommit: string | null; commits: string[] };
  }>(page, 'GET', `/api/tasks/${taskId}`);
  expect(task.fixCycles).toBe(1);
  expect(task.git.baselineCommit).toBe(baseline);
  expect(task.git.taskBranch).toMatch(new RegExp(`^ai/${taskId}-show-the-cart-total`));
  taskBranch = task.git.taskBranch!;
  expect(git('branch', '--show-current')).toBe(taskBranch);
  expect(task.git.commits).toHaveLength(1);
  const commit = task.git.commits[0]!;

  // One commit on the task branch, on top of the baseline, holding only the task's own file.
  expect(git('rev-parse', taskBranch)).toBe(commit);
  expect(git('rev-parse', `${commit}^`)).toBe(baseline);
  expect(git('log', '-1', '--format=%s', commit)).toMatch(new RegExp(`^${taskId}: `));
  expect(git('show', '--name-only', '--format=', commit).split('\n')).toEqual(['sim-output.md']);
  // main is untouched and nothing is left uncommitted.
  expect(git('rev-parse', 'main')).toBe(baseline);
  expect(git('status', '--porcelain')).toBe('');
  // Both the implementer and the fixer wrote to the file.
  const output = readFileSync(path.join(repoDir, 'sim-output.md'), 'utf8');
  expect(output).toMatch(/implementer change/);
  expect(output).toMatch(/fixer change/);
  // The app the App check started was stopped afterwards.
  await expect
    .poll(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = net.connect(appPort, '127.0.0.1');
          socket.once('connect', () => (socket.destroy(), resolve(true)));
          socket.once('error', () => resolve(false));
        }),
      { timeout: 15_000 },
    )
    .toBe(false);
});

test('the task page shows the report, changes, real test output and evidence', async ({ page }, testInfo) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: 'Completion report' })).toBeVisible();
  await expect(page.getByText('1 of 3').first()).toBeVisible();
  await expect(page.getByText(taskBranch).first()).toBeVisible();
  await expectNoAxeViolations(page, testInfo);

  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(page.getByRole('list', { name: 'Changed files' })).toContainText('sim-output.md');

  // Each test stage ran the repository's own commands; the output is theirs.
  // The failed review sent the work back once, so Test and App check ran twice.
  await page.getByRole('tab', { name: /Tests/ }).click();
  for (const run of ['Test run 1', 'Test run 3', 'App check run 2', 'App check run 4']) await expect(page.getByRole('region', { name: run })).toBeVisible();
  const latestTests = page.getByRole('region', { name: 'Test run 3' });
  await expect(latestTests.getByRole('heading')).toContainText('3 passed · 0 failed · fix cycle 1');
  const unit = latestTests.getByRole('button', { name: /^unit tests · Unit tests · passed/ });
  await expect(unit).toContainText('2 passed (2)');
  await unit.click();
  await expect(page.getByRole('log', { name: 'Command output' })).toContainText('quantities multiply prices');
  await expect(page.getByRole('region', { name: 'App check run 4' }).getByRole('button', { name: /^Browser verification · End-to-end tests · passed/ })).toContainText(
    'Verified 1 page(s) at desktop and phone widths',
  );

  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText(/Committed 1 file on /).first()).toBeVisible();
  await expect(page.getByText(/Browser verification passed/).first()).toBeVisible();

  await page.getByRole('tab', { name: /Artifacts/ }).click();
  for (const name of ['final-report.md', 'browser-verification.md']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'browser-verification.md', exact: true }).click();
  const report = page.getByRole('dialog', { name: 'browser-verification.md' });
  await expect(report).toContainText('passed');
  await expect(report).toContainText(`http://127.0.0.1:${appPort}`);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Source Control, the task list and usage agree with the task', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const repos = await api<Array<{ id: string; name: string }>>(page, 'GET', '/api/repositories');
  const repo = repos.find((r) => r.name === NAME)!;

  await page.goto(`/source-control/${repo.id}?tab=history`);
  await expect(page.getByRole('region', { name: 'Branch' })).toContainText(taskBranch);
  const history = page.getByRole('list', { name: 'Commit history' });
  await expect(history.getByRole('listitem').first()).toContainText(taskId);
  await expect(history).toContainText('Initial shop');

  await page.goto('/tasks');
  const row = page.getByRole('row').filter({ hasText: taskId });
  await expect(row).toContainText('Completed');
  await expect(row).toContainText(NAME);

  await page.goto(`/usage/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: 'Cost flow' })).toBeVisible();
  expect(errors).toEqual([]);
});
