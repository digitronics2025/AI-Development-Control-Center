import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cloneRepository, failureText, git, isGitRepository, repositoryStatus, topLevel } from '@acc/git';
import { isCloneFolderName, parseCloneUrl, repositoryRuntimeSchema, type CloneRepositoryInput, type Repository, type RepositoryCommand, type RepositoryRuntime, type RepositoryStatus, type UpdateRepositoryInput } from '@acc/shared';
import type { Bus } from '../bus.js';
import { normalizeRemote } from '../remote/fingerprint.js';
import type { SettingsService } from './settings.js';
import { newId, now, type RepositoryRecord, type Store } from '../store/store.js';

export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID_PATH' | 'INVALID_URL' | 'DUPLICATE' | 'IN_USE' | 'CLONE_FAILED' | 'CREATE_FAILED',
  ) {
    super(message);
  }
}

const STATUS_TTL_MS = 5000;
/** Git processes the repository list may run at once; enough to stay fast, bounded as the list grows. */
const STATUS_CONCURRENCY = 8;

/** Runs at most `limit` jobs at a time; the rest wait in arrival order. */
class Slots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Comparable form of a folder path: resolved, without a trailing separator, case-folded on Windows. */
export function pathKey(folder: string): string {
  const resolved = path.resolve(folder).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface Detected {
  tooling: string[];
  commands: RepositoryCommand[];
  runtime: RepositoryRuntime;
}

/** Port the verify stage starts dev servers on: uncommon, so it rarely meets a server the user runs. */
export const VERIFY_PORT = 5199;

async function readJson(file: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Detect tooling and propose verification commands from the files present. */
export async function detectTooling(root: string): Promise<Detected> {
  const has = (file: string) => existsSync(path.join(root, file));
  const tooling: string[] = [];
  const commands: RepositoryCommand[] = [];
  const add = (id: string, name: string, command: string, kind: RepositoryCommand['kind'], timeoutSec = 900) =>
    commands.push({ id, name, command, kind, enabled: true, timeoutSec });

  let runtime: RepositoryRuntime = repositoryRuntimeSchema.parse({});
  const pkg = await readJson(path.join(root, 'package.json'));
  if (pkg) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    tooling.push('node', pm);
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`);
    if (scripts.lint) add('lint', 'lint', run('lint'), 'lint');
    if (scripts.typecheck) add('typecheck', 'typecheck', run('typecheck'), 'typecheck');
    else if (scripts['type-check']) add('typecheck', 'typecheck', run('type-check'), 'typecheck');
    if (scripts.test && !/no test specified/.test(scripts.test)) add('test', 'unit tests', pm === 'npm' ? 'npm test' : `${pm} test`, 'test', 1800);
    if (scripts.build) add('build', 'build', run('build'), 'build', 1800);
    if (scripts['test:e2e']) add('e2e', 'e2e tests', run('test:e2e'), 'e2e', 3600);
    if (scripts.smoke) add('smoke', 'smoke test', run('smoke'), 'smoke');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ['react', 'vite', 'next', 'typescript', 'vitest', 'jest', '@playwright/test', 'wrangler']) {
      if (deps[name]) tooling.push(name);
    }
    // Propose how the verify stage starts the app; the user can change or clear it.
    const dev = typeof scripts.dev === 'string' ? scripts.dev : '';
    const pass = (flags: string) => (pm === 'npm' ? `npm run dev -- ${flags}` : `${pm} run dev ${flags}`);
    const url = `http://127.0.0.1:${VERIFY_PORT}`;
    if (/\bvite\b/.test(dev)) runtime = { ...runtime, devCommand: pass(`--host 127.0.0.1 --port ${VERIFY_PORT} --strictPort`), devUrl: url };
    else if (/\bnext dev\b/.test(dev)) runtime = { ...runtime, devCommand: pass(`--hostname 127.0.0.1 --port ${VERIFY_PORT}`), devUrl: url };
    else if (/\bwrangler dev\b/.test(dev)) runtime = { ...runtime, devCommand: pass(`--ip 127.0.0.1 --port ${VERIFY_PORT}`), devUrl: url, verifyMode: 'http' };
  }
  if (has('gradlew') || has('gradlew.bat')) {
    tooling.push('gradle');
    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    add('gradle-test', 'unit tests', `${gradlew} test`, 'test', 3600);
    add('gradle-build', 'assemble debug', `${gradlew} assembleDebug`, 'build', 3600);
  }
  if (has('Cargo.toml')) {
    tooling.push('rust');
    add('cargo-test', 'unit tests', 'cargo test', 'test', 3600);
    add('cargo-build', 'build', 'cargo build', 'build', 3600);
  }
  if (has('pyproject.toml') || has('requirements.txt')) tooling.push('python');
  if (has('go.mod')) {
    tooling.push('go');
    add('go-test', 'unit tests', 'go test ./...', 'test', 1800);
  }
  if (has('wrangler.toml') || has('wrangler.jsonc') || has('wrangler.json')) {
    if (!tooling.includes('wrangler')) tooling.push('wrangler');
  }
  if (has('.git')) tooling.push('git');
  return { tooling: [...new Set(tooling)], commands, runtime };
}

export class RepositoryService {
  private readonly statusCache = new Map<string, { at: number; status: RepositoryStatus }>();
  private readonly statusSlots = new Slots(STATUS_CONCURRENCY);

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly settings: SettingsService,
  ) {}

  async status(rec: RepositoryRecord, fresh = false): Promise<RepositoryStatus> {
    const cached = this.statusCache.get(rec.id);
    if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
    const base = { checkedAt: now(), branch: null, head: null, dirty: false, dirtyCount: 0, upstream: null, ahead: null, behind: null, error: null };
    let result: RepositoryStatus;
    if (!existsSync(rec.path)) {
      result = { ...base, available: false, isGitRepo: false, error: 'Folder not found' };
    } else {
      try {
        // One Git process per repository: branch, head, upstream and changes all come from a single status call.
        const { branch, entries } = await this.statusSlots.run(() => repositoryStatus(rec.path));
        result = {
          ...base,
          available: true,
          isGitRepo: true,
          branch: branch.head,
          head: branch.oid,
          dirty: entries.length > 0,
          dirtyCount: entries.length,
          upstream: branch.upstream,
          ahead: branch.ahead,
          behind: branch.behind,
        };
      } catch (error) {
        result = (await isGitRepository(rec.path))
          ? { ...base, available: true, isGitRepo: true, error: (error as Error).message }
          : { ...base, available: true, isGitRepo: false };
      }
    }
    this.statusCache.set(rec.id, { at: Date.now(), status: result });
    return result;
  }

  /** Re-read one repository's status and push it to clients (after a background change). */
  async refresh(id: string): Promise<Repository> {
    const view = await this.get(id, true);
    this.bus.publish({ type: 'repository', repository: view });
    return view;
  }

  async toView(rec: RepositoryRecord, fresh = false): Promise<Repository> {
    return { ...rec, status: await this.status(rec, fresh) };
  }

  async list(): Promise<Repository[]> {
    return Promise.all(this.store.listRepositories().map((r) => this.toView(r)));
  }

  record(id: string): RepositoryRecord {
    const rec = this.store.getRepository(id);
    if (!rec) throw new RepositoryError(`Repository ${id} not found`, 'NOT_FOUND');
    return rec;
  }

  async get(id: string, fresh = false): Promise<Repository> {
    return this.toView(this.record(id), fresh);
  }

  async add(inputPath: string, name?: string): Promise<Repository> {
    let root = path.resolve(inputPath.trim().replace(/^"|"$/g, ''));
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new RepositoryError(`"${inputPath}" is not an existing folder`, 'INVALID_PATH');
    }
    if (await isGitRepository(root)) root = path.resolve(await topLevel(root));
    if (this.isRegistered(root)) throw new RepositoryError(`${root} is already registered`, 'DUPLICATE');
    const detected = await detectTooling(root);
    const ts = now();
    const rec: RepositoryRecord = {
      id: newId(),
      name: name?.trim() || path.basename(root),
      path: root,
      defaultWorkflowId: null,
      roleOverrides: {},
      commands: detected.commands,
      // Isolated by default: a task never switches or edits your own checkout (AUTOPILOT_GATES_PLAN §3.F).
      gitMode: 'worktree',
      autoApproveUpToLevel: null,
      tooling: detected.tooling,
      lastTaskId: null,
      policyMode: null,
      runtime: detected.runtime,
      preexistingFailures: 'allow',
      testSelection: 'full',
      // Detection never turns a release on (RELEASE_STAGE_PLAN §3.2).
      release: { method: 'none' },
      createdAt: ts,
      updatedAt: ts,
    };
    this.store.insertRepository(rec);
    this.setIgnored(root, false);
    await this.unignoreRemotes(root);
    const view = await this.toView(rec, true);
    this.bus.publish({ type: 'repository', repository: view });
    return view;
  }

  /** Where a clone goes when the request names no folder: the first discovery root, else the home folder. */
  defaultCloneParent(): string {
    return path.resolve(this.settings.get().repositoryAutomation.roots[0] ?? os.homedir());
  }

  /**
   * Download a repository that exists only online (for example one just
   * created on GitHub) into a new folder, then register it like `add`. The
   * folder must not exist; if the clone fails, whatever it left is removed.
   */
  async clone(input: CloneRepositoryInput, options: { unattended?: boolean } = {}): Promise<Repository> {
    const parsed = parseCloneUrl(input.url);
    if (!parsed) {
      throw new RepositoryError('Enter a GitHub "owner/name", or an https://, ssh:// or git@ address without a password in it.', 'INVALID_URL');
    }
    const folderName = input.folderName?.trim() || parsed.folderName;
    if (!isCloneFolderName(folderName)) throw new RepositoryError(`"${folderName}" is not a usable folder name`, 'INVALID_PATH');
    const parent = path.resolve((input.parentFolder?.trim() || this.defaultCloneParent()).replace(/^"|"$/g, ''));
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new RepositoryError(`"${parent}" is not an existing folder`, 'INVALID_PATH');
    const destination = path.join(parent, folderName);
    if (existsSync(destination)) throw new RepositoryError(`${destination} already exists. Choose another folder name, or add that folder instead.`, 'DUPLICATE');
    const result = await cloneRepository(parsed.url, destination, options);
    if (result.code !== 0) {
      // The folder did not exist before, so anything there now is the failed clone's.
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      const reason = result.timedOut ? 'the download took longer than 10 minutes' : failureText(result.stderr).split('\n').slice(-3).join(' ').slice(0, 500) || `git exited with ${result.code}`;
      throw new RepositoryError(`Could not download ${parsed.url}: ${reason}`, 'CLONE_FAILED');
    }
    return this.add(destination, input.name);
  }

  /**
   * Start a brand-new repository on this computer: a new folder, `git init`
   * on `main`, and a first commit holding a README (so it has a branch that
   * can be uploaded). Then it is registered like `add`. The folder must not
   * exist; on any failure the folder is removed. Creating it on GitHub as
   * well is a separate tool call (`github.repo_create`) made by the route.
   */
  async createNew(input: { name: string; parentFolder?: string; description?: string }): Promise<Repository> {
    if (!isCloneFolderName(input.name)) throw new RepositoryError(`"${input.name}" is not a usable folder name`, 'INVALID_PATH');
    const parent = path.resolve((input.parentFolder?.trim() || this.defaultCloneParent()).replace(/^"|"$/g, ''));
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new RepositoryError(`"${parent}" is not an existing folder`, 'INVALID_PATH');
    const destination = path.join(parent, input.name);
    if (existsSync(destination)) throw new RepositoryError(`${destination} already exists. Choose another name, or add that folder instead.`, 'DUPLICATE');
    await mkdir(destination);
    try {
      const readme = `# ${input.name}\n${input.description?.trim() ? `\n${input.description.trim()}\n` : ''}`;
      await writeFile(path.join(destination, 'README.md'), readme, 'utf8');
      for (const args of [['init', '-b', 'main'], ['add', '--', 'README.md'], ['commit', '-m', 'Initial commit']]) {
        const result = await git(destination, args);
        if (result.code !== 0) {
          const reason = failureText(`${result.stderr}\n${result.stdout}`).split('\n').slice(-3).join(' ').slice(0, 500);
          const hint = args[0] === 'commit' && /user\.(name|email)|identity/i.test(reason) ? ' Set your Git name and email first (git config --global user.name / user.email).' : '';
          throw new RepositoryError(`Could not create the repository (git ${args[0]}): ${reason}${hint}`, 'CREATE_FAILED');
        }
      }
    } catch (error) {
      // The folder did not exist before, so everything in it is ours.
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      throw error instanceof RepositoryError ? error : new RepositoryError(`Could not create the repository: ${(error as Error).message}`, 'CREATE_FAILED');
    }
    return this.add(destination);
  }

  async update(id: string, patch: UpdateRepositoryInput): Promise<Repository> {
    this.record(id);
    const ids = new Set<string>();
    for (const command of patch.commands ?? []) {
      if (ids.has(command.id)) throw new RepositoryError(`Command id "${command.id}" is used twice`, 'DUPLICATE');
      ids.add(command.id);
    }
    this.store.updateRepository(id, patch as Partial<RepositoryRecord>);
    const view = await this.get(id);
    this.bus.publish({ type: 'repository', repository: view });
    return view;
  }

  async redetect(id: string): Promise<Repository> {
    const rec = this.record(id);
    const detected = await detectTooling(rec.path);
    // Keep the user's commands; add newly detected ones by id.
    const existing = new Set(rec.commands.map((c) => c.id));
    const commands = [...rec.commands, ...detected.commands.filter((c) => !existing.has(c.id))];
    const runtime = rec.runtime.devCommand ? rec.runtime : detected.runtime;
    this.store.updateRepository(id, { tooling: detected.tooling, commands, runtime });
    const view = await this.get(id, true);
    this.bus.publish({ type: 'repository', repository: view });
    return view;
  }

  async remove(id: string): Promise<void> {
    const rec = this.record(id);
    if (this.store.countTasksForRepository(id) > 0) {
      throw new RepositoryError('This repository has task history. Tasks keep a reference to it, so it cannot be removed.', 'IN_USE');
    }
    // Read before deleting: the remotes are how GitHub downloads recognise it later.
    const remotes = await this.remoteIdentities(rec.path);
    this.store.deleteRepository(id);
    this.statusCache.delete(id);
    // Removing is a decision: neither discovery nor GitHub downloads may bring the repository back.
    this.setIgnored(rec.path, true);
    this.ignoreRemotes(remotes);
    this.bus.publish({ type: 'repository.deleted', repositoryId: id });
  }

  /** `host/owner/name` of every remote of the repository at `root` (empty when unreadable or none). */
  async remoteIdentities(root: string): Promise<string[]> {
    if (!existsSync(root)) return [];
    // The URLs as configured: `git remote -v` shows them after `insteadOf` rewriting.
    const result = await git(root, ['config', '--get-regexp', '^remote\\..*\\.(push)?url$']).catch(() => null);
    if (!result || result.code !== 0) return [];
    const ids = result.stdout
      .split('\n')
      .map((line) => line.split(/\s+/)[1])
      .filter((url): url is string => Boolean(url))
      .map((url) => normalizeRemote(url)?.identity)
      .filter((id): id is string => Boolean(id));
    return [...new Set(ids)];
  }

  isRemoteIgnored(identity: string): boolean {
    return this.settings.get().repositoryAutomation.ignoredRemotes.includes(identity.toLowerCase());
  }

  /** Adding a repository again (by hand or by download) takes its remotes off the ignore list. */
  private async unignoreRemotes(root: string): Promise<void> {
    const automation = this.settings.get().repositoryAutomation;
    if (!automation.ignoredRemotes.length) return;
    const ids = new Set(await this.remoteIdentities(root));
    if (!automation.ignoredRemotes.some((i) => ids.has(i))) return;
    this.settings.update({ repositoryAutomation: { ...automation, ignoredRemotes: automation.ignoredRemotes.filter((i) => !ids.has(i)) } });
  }

  private ignoreRemotes(identities: string[]): void {
    const automation = this.settings.get().repositoryAutomation;
    const fresh = identities.map((i) => i.toLowerCase()).filter((i) => !automation.ignoredRemotes.includes(i));
    if (!fresh.length) return;
    this.settings.update({ repositoryAutomation: { ...automation, ignoredRemotes: [...automation.ignoredRemotes, ...fresh].slice(-1000) } });
  }

  /** Whether automatic discovery skips `folder`. Paths compare case-insensitively on Windows. */
  isIgnored(folder: string): boolean {
    const key = pathKey(folder);
    return this.settings.get().repositoryAutomation.ignoredPaths.some((p) => pathKey(p) === key);
  }

  isRegistered(folder: string): boolean {
    const key = pathKey(folder);
    return this.store.listRepositories().some((r) => pathKey(r.path) === key);
  }

  private setIgnored(folder: string, ignored: boolean): void {
    if (this.isIgnored(folder) === ignored) return;
    const automation = this.settings.get().repositoryAutomation;
    const key = pathKey(folder);
    const ignoredPaths = ignored ? [...automation.ignoredPaths, folder].slice(-1000) : automation.ignoredPaths.filter((p) => pathKey(p) !== key);
    this.settings.update({ repositoryAutomation: { ...automation, ignoredPaths } });
  }

  /** Called after every orchestrator-controlled change; Source Control views refetch too. */
  invalidate(id: string): void {
    this.statusCache.delete(id);
    this.bus.publish({ type: 'sourceControl', repositoryId: id });
  }
}
