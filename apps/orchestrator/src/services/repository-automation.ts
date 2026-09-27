import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RepositoryAutomationRun, RepositoryAutomationStatus, RepositoryDiscoveryReport, RepositoryDownloadReport, RepositorySyncOutcome, RepositorySyncResult } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { SourceControlService } from '../source-control/service.js';
import type { ToolService } from '../tools/service.js';
import { now, type Store } from '../store/store.js';
import { pathKey, RepositoryError, type RepositoryService } from './repositories.js';
import type { SettingsService } from './settings.js';

/** Folder names never searched: dependency trees, OS and application data. Compared lowercase. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'appdata', 'application data', 'library', '$recycle.bin', 'system volume information', '__pycache__', 'venv']);
/** Upper bound on folders read per discovery pass, so a huge root cannot stall the orchestrator. */
const MAX_SCANNED_FOLDERS = 20_000;
/** Fetches in flight at once; each is a network round trip, so a few overlap well. */
const SYNC_CONCURRENCY = 4;

export interface RepositoryAutomationDeps {
  settings: SettingsService;
  repositories: RepositoryService;
  sourceControl: SourceControlService;
  store: Store;
  bus: Bus;
  /** Folders discovery never enters (the orchestrator's own data folder). */
  excludedFolders: string[];
  /** Search root when none is configured. */
  homeDir?: string;
  /** Lists GitHub accounts' repositories (`github.repo_list`) for GitHub downloads. */
  tools: ToolService;
}

/** One row of `gh repo list --json` as `github.repo_list` returns it. */
interface GitHubRepoRow {
  name: string;
  nameWithOwner: string;
  url: string;
  isArchived: boolean;
  isFork: boolean;
  isEmpty: boolean;
  /** Kilobytes. */
  diskUsage: number;
}

const FETCHED: ReadonlySet<RepositorySyncOutcome> = new Set(['up-to-date', 'fast-forwarded', 'behind-dirty', 'ahead', 'diverged']);

/**
 * A remote answering "repository not found" is deleted only if another
 * repository of the same account fetched fine in the same run. Hosts answer a
 * private repository the caller cannot see the same way, so without that
 * proof (an expired sign-in fails every repository alike) it stays `failed`.
 */
export function confirmGoneRemotes(results: RepositorySyncResult[]): RepositorySyncResult[] {
  const reachable = new Set(results.filter((r) => FETCHED.has(r.outcome) && r.remoteOwner).map((r) => r.remoteOwner));
  return results.map((r) =>
    r.outcome === 'failed' && r.remoteMissing && r.remoteOwner && reachable.has(r.remoteOwner)
      ? {
          ...r,
          outcome: 'remote-gone',
          message: `The online copy no longer exists (other ${r.remoteOwner} repositories download fine), so it was deleted or made private to another account. The copy on this computer is untouched.`,
        }
      : r,
  );
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/**
 * Repository automation (docs/systems/repository-automation.md): registers
 * new Git repositories found under the configured folders, and keeps every
 * registered repository downloaded from its upstream through Source
 * Control's background sync. Runs at startup and then every
 * `intervalMinutes`; a run never overlaps another.
 */
export class RepositoryAutomation {
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: number | null = null;
  private current: Promise<RepositoryAutomationRun> | null = null;
  private lastRun: RepositoryAutomationRun | null = null;
  private readonly results = new Map<string, RepositorySyncResult>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly d: RepositoryAutomationDeps) {}

  /** Start the schedule. The first run waits `initialDelayMs` so startup work settles first. */
  start(initialDelayMs = 0): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.d.bus.subscribe((message) => {
      if (message.type === 'settings') this.reschedule();
      if (message.type === 'repository.deleted') this.results.delete(message.repositoryId);
    });
    this.schedule(initialDelayMs, 'startup');
  }

  /** Stop scheduling and wait for a run in progress to finish. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
    await this.current?.catch(() => undefined);
  }

  status(): RepositoryAutomationStatus {
    return {
      running: this.current !== null,
      nextRunAt: this.nextRunAt === null ? null : new Date(this.nextRunAt).toISOString(),
      lastRun: this.lastRun,
      results: [...this.results.values()],
    };
  }

  /** Run discovery and sync as enabled in settings. A call while a run is in progress joins that run. */
  run(trigger: RepositoryAutomationRun['trigger']): Promise<RepositoryAutomationRun> {
    if (this.current) return this.current;
    this.clearTimer();
    const settings = this.d.settings.get().repositoryAutomation;
    const run: RepositoryAutomationRun = { trigger, startedAt: now(), finishedAt: null, discovery: null, downloads: null, sync: null };
    this.lastRun = run;
    this.current = (async () => {
      // Yield first so `current` is assigned before anything (even an empty run) completes.
      await Promise.resolve();
      try {
        if (settings.discover) run.discovery = await this.discover();
        // After the disk scan, so a copy that is already on disk is registered, not downloaded twice.
        if (settings.discover && settings.githubAccounts.length) run.downloads = await this.downloadFromGitHub();
        if (settings.sync) run.sync = await this.syncAll();
      } finally {
        run.finishedAt = now();
        this.current = null;
        this.reschedule();
        this.publish();
      }
      return run;
    })();
    this.publish();
    return this.current;
  }

  /** Find Git repositories under the configured roots and register the new ones. */
  async discover(): Promise<RepositoryDiscoveryReport> {
    const settings = this.d.settings.get().repositoryAutomation;
    const roots = settings.roots.length ? settings.roots : [this.d.homeDir ?? os.homedir()];
    const excluded = this.d.excludedFolders.map(pathKey);
    const isExcluded = (key: string) => excluded.some((x) => key === x || key.startsWith(`${x}${path.sep}`));
    const report: RepositoryDiscoveryReport = { scanned: 0, added: [], errors: [] };
    const found: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ dir: string; depth: number; root: boolean }> = roots.map((r) => ({ dir: path.resolve(r), depth: 0, root: true }));

    while (queue.length && report.scanned < MAX_SCANNED_FOLDERS) {
      const { dir, depth, root } = queue.shift()!;
      const key = pathKey(dir);
      if (seen.has(key) || isExcluded(key)) continue;
      seen.add(key);
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        // Unreadable folders below a root are normal (permissions); a missing root is worth telling.
        if (root) report.errors.push({ path: dir, message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Folder not found' : (error as Error).message });
        continue;
      }
      report.scanned++;
      // A `.git` folder marks a standalone repository. A `.git` file is a linked
      // worktree or submodule: it shares another repository's history, so it is skipped.
      if (entries.some((e) => e.name === '.git' && e.isDirectory())) found.push(dir);
      if (depth >= settings.maxDepth) continue;
      for (const entry of entries) {
        // Dirent.isDirectory() is false for symlinks and junctions, so links cannot loop the walk.
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name.toLowerCase())) continue;
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1, root: false });
      }
    }

    for (const folder of found) {
      if (this.d.repositories.isRegistered(folder) || this.d.repositories.isIgnored(folder)) continue;
      try {
        const repo = await this.d.repositories.add(folder, this.nameFor(folder));
        report.added.push({ id: repo.id, name: repo.name, path: repo.path });
      } catch (error) {
        if (error instanceof RepositoryError && error.code === 'DUPLICATE') continue;
        report.errors.push({ path: folder, message: (error as Error).message });
      }
    }
    return report;
  }

  /**
   * Download the repositories of the watched GitHub accounts that are not on
   * this computer yet, then register them (docs/systems/repository-automation.md).
   * "On this computer" means any registered repository has a remote with the
   * same `github.com/owner/name`, so a renamed folder still counts. Never
   * uploads, never touches an existing folder, never opens a sign-in window.
   */
  async downloadFromGitHub(): Promise<RepositoryDownloadReport> {
    const settings = this.d.settings.get().repositoryAutomation;
    const report: RepositoryDownloadReport = { accounts: [...settings.githubAccounts], downloaded: [], skipped: [], errors: [] };
    const parent = this.d.repositories.defaultCloneParent();
    const scope = {
      taskId: null,
      stageId: null,
      sessionId: null,
      repositoryId: null,
      cwd: parent,
      roots: [parent],
      stageLevel: 1 as const,
      autoApproveUpToLevel: 1 as const,
      mode: this.d.settings.get().execution.policyMode,
      profile: 'operator' as const,
      escalated: new Set<string>(),
      protectedPaths: [],
    };

    const listed: GitHubRepoRow[] = [];
    for (const owner of settings.githubAccounts) {
      const outcome = await this.d.tools.invoke({ capability: 'github.repo_list', input: { owner }, origin: 'engine', scope, timeoutMs: 60_000 });
      if (!outcome.result.ok || !Array.isArray(outcome.result.output)) {
        report.errors.push({ subject: owner, message: outcome.result.error?.message ?? outcome.result.summary });
        continue;
      }
      listed.push(...(outcome.result.output as GitHubRepoRow[]));
    }
    if (!listed.length) return report;

    const known = new Set<string>();
    await mapLimit(this.d.store.listRepositories(), SYNC_CONCURRENCY * 2, async (repo) => {
      for (const id of await this.d.repositories.remoteIdentities(repo.path)) known.add(id);
    });

    const maxKb = settings.githubMaxSizeMb * 1024;
    for (const row of listed) {
      const identity = `github.com/${row.nameWithOwner}`.toLowerCase();
      if (known.has(identity) || this.d.repositories.isRemoteIgnored(identity)) continue;
      const remote = `github.com/${row.nameWithOwner}`;
      if (row.isArchived) {
        report.skipped.push({ remote, reason: 'Archived on GitHub' });
        continue;
      }
      if (row.isFork) {
        report.skipped.push({ remote, reason: 'A fork of someone else’s repository' });
        continue;
      }
      if (row.diskUsage > maxKb) {
        report.skipped.push({ remote, reason: `${Math.round(row.diskUsage / 1024)} MB, over the ${settings.githubMaxSizeMb} MB limit: download it yourself from Add repository` });
        continue;
      }
      const destination = path.join(parent, row.name);
      if (this.d.repositories.isIgnored(destination)) continue;
      try {
        const repo = await this.d.repositories.clone({ url: row.url, parentFolder: parent, name: this.nameFor(destination) }, { unattended: true });
        known.add(identity);
        report.downloaded.push({ id: repo.id, name: repo.name, path: repo.path, remote });
      } catch (error) {
        if (error instanceof RepositoryError && error.code === 'DUPLICATE') {
          report.skipped.push({ remote, reason: `${destination} already exists and is a different folder` });
          continue;
        }
        report.errors.push({ subject: remote, message: (error as Error).message.slice(0, 500) });
      }
    }
    return report;
  }

  /** The folder name, or `parent/name` when another repository already uses that name. */
  private nameFor(folder: string): string {
    const base = path.basename(folder);
    const taken = this.d.store.listRepositories().some((r) => r.name.toLowerCase() === base.toLowerCase());
    return taken ? `${path.basename(path.dirname(folder))}/${base}` : base;
  }

  /** Background-sync every registered repository; returns how many ended in each outcome. */
  async syncAll(): Promise<Partial<Record<RepositorySyncOutcome, number>>> {
    const repositories = this.d.store.listRepositories();
    const run: RepositorySyncResult[] = [];
    await mapLimit(repositories, SYNC_CONCURRENCY, async (repo) => {
      let result: RepositorySyncResult;
      try {
        result = await this.d.sourceControl.backgroundSync(repo.id);
      } catch (error) {
        if (error instanceof RepositoryError && error.code === 'NOT_FOUND') return; // removed mid-run
        result = { repositoryId: repo.id, outcome: 'failed', message: (error as Error).message.slice(0, 500), ahead: null, behind: null, at: now(), remoteOwner: null, remoteMissing: false };
      }
      run.push(result);
      await this.d.repositories.refresh(repo.id).catch(() => undefined);
    });

    const counts: Partial<Record<RepositorySyncOutcome, number>> = {};
    for (const result of confirmGoneRemotes(run)) {
      this.results.set(result.repositoryId, result);
      counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    }
    return counts;
  }

  private schedule(delayMs: number, trigger: RepositoryAutomationRun['trigger']): void {
    this.clearTimer();
    const settings = this.d.settings.get().repositoryAutomation;
    if (!this.unsubscribe || (!settings.discover && !settings.sync)) return;
    this.nextRunAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRunAt = null;
      void this.run(trigger).catch((error: unknown) => console.error(`[repository-automation] run failed: ${(error as Error).message}`));
    }, delayMs);
    this.timer.unref();
  }

  /** Next run one interval after the last one finished, or sooner if the interval was shortened. */
  private reschedule(): void {
    if (this.current || !this.unsubscribe) return;
    const intervalMs = this.d.settings.get().repositoryAutomation.intervalMinutes * 60_000;
    const lastEnd = this.lastRun?.finishedAt ? Date.parse(this.lastRun.finishedAt) : Date.now();
    this.schedule(Math.max(0, lastEnd + intervalMs - Date.now()), 'schedule');
    this.publish();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  private publish(): void {
    this.d.bus.publish({ type: 'repositoryAutomation', status: this.status() });
  }
}
