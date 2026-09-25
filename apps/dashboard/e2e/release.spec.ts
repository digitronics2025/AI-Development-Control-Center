import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Releases (docs/plans/RELEASE_STAGE_PLAN.md): the repository Release panel
 * with Check setup, the Level 5 release approval card, the Release button on a
 * completed task, and the Release card and badge of a release the live site
 * did not answer for — nothing is sent in any of these. In both themes and at
 * phone width.
 */

/** A repository with a bare `origin` that main was pushed to. */
function releaseRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-release-'));
  const dir = path.join(root, 'app');
  const remote = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'release', private: true, scripts: { test: 'node -e "console.log(\'3 passed\')"' } }, null, 2));
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  return dir;
}

// Port 9 (discard) refuses connections: the live site "is not answering", so no release is ever sent.
const RELEASE = { method: 'push', remote: 'origin', branch: 'main', liveUrl: 'https://127.0.0.1:9/', proof: { versionUrl: 'https://127.0.0.1:9/api/version' }, manualPaths: ['db/migrations/**'], timeoutSec: 60 };

async function waitFor<T>(page: Page, read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = await read();
    if (ok(v)) return v;
    await page.waitForTimeout(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let repoId = '';
let waitingTask = '';
let refusedTask = '';

interface Approval { id: string; kind: string; status: string; stageKey: string | null }
interface Task { status: string; git: { release?: { state: string } | null } }

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  repoId = (await api<{ id: string }>(page, 'POST', '/api/repositories', { path: releaseRepo(), name: 'release-app' })).id;
  await api(page, 'PATCH', `/api/repositories/${repoId}`, { release: RELEASE });
  const start = async (description: string) => (await api<{ id: string }>(page, 'POST', '/api/tasks', { repositoryId: repoId, workflowId: 'full-autopilot', mode: 'autopilot', supervised: false, description })).id;
  const releaseApproval = (id: string) => waitFor(page, async () => (await api<Approval[]>(page, 'GET', `/api/tasks/${id}/approvals`)).find((a) => a.status === 'pending' && a.stageKey === 'release'), (a) => a !== undefined, 'the release approval');

  // One declined, then released with the button: refused because the live site does not answer.
  refusedTask = await start('Add a contact link to the footer.');
  const declined = (await releaseApproval(refusedTask))!;
  await api(page, 'POST', `/api/approvals/${declined.id}/deny`, {});
  await waitFor(page, () => api<Task>(page, 'GET', `/api/tasks/${refusedTask}`), (t) => t.status === 'COMPLETED', 'the declined task to complete');
  const requested = await api<{ approval: Approval }>(page, 'POST', `/api/tasks/${refusedTask}/release`, {});
  await api(page, 'POST', `/api/approvals/${requested.approval.id}/approve`, { confirmation: refusedTask });
  await waitFor(page, () => api<Task>(page, 'GET', `/api/tasks/${refusedTask}`), (t) => t.git.release?.state === 'refused', 'the release to be refused');
  // One task left waiting on its Release approval (it holds the repository, so it runs last).
  waitingTask = await start('Show the opening hours on the home page.');
  await releaseApproval(waitingTask);
  await page.close();
});

for (const theme of ['dark', 'light'] as const) {
  test.describe(`releases in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
    });

    test('the repository Release panel checks the setup and sends nothing', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/repositories/${repoId}`);
      const panel = page.getByTestId('release-panel');
      await expect(panel.getByText('Releasing sends work to your live site. It always asks you first.')).toBeVisible();
      await expect(panel.getByRole('radio', { name: 'Push to a branch' })).toBeChecked();
      await panel.getByRole('button', { name: 'Check setup' }).click();
      const results = page.getByTestId('release-setup-results');
      await expect(results.getByText(/Remote passed/)).toBeVisible();
      await expect(results.getByText(/Branch passed/)).toBeVisible();
      await expect(results.getByText(/Live URL failed/)).toBeVisible();
      // A form with no proof says why it cannot be saved.
      await panel.getByLabel('Version URL').fill('');
      await expect(panel.getByText('Choose at least one way to prove the release is live')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
      await expectNoAxeViolations(page, testInfo);
      expect(errors).toEqual([]);
    });

    test('the release approval says what is sent and asks for the task id', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/approvals?task=${waitingTask}`);
      await expect(page.getByText(/^Push [0-9a-f]{7} to origin\/main$/).first()).toBeVisible();
      await expect(page.getByText(/Releasing sends work to your live site/).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve production release' }).first()).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      expect(errors).toEqual([]);
    });

    test('a completed task shows its release, the badge and the Release button', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/tasks/${refusedTask}`);
      const card = page.getByTestId('release-card');
      await expect(card.getByText(/The live site isn't answering/)).toBeVisible();
      await expect(card.getByText('Not passed: Nothing was sent')).toBeVisible();
      await expect(page.locator('header').getByText('Not released')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Release…' }).first()).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      await page.goto('/tasks');
      await expect(page.getByRole('row', { name: new RegExp(refusedTask) }).getByText('Not released')).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('the release parts fit a phone', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/tasks/${refusedTask}`);
      await expect(page.getByTestId('release-card')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.goto(`/repositories/${repoId}`);
      await expect(page.getByTestId('release-panel')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  });
}

test.afterAll(async ({ browser }) => {
  // The theme is a server setting: put back the dark theme the other files expect.
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});
