import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { runShell } from '@acc/executor';
import { addDetachedWorktree, git, removeWorktree } from '@acc/git';
import { redact } from '@acc/security';
import type { RepositoryCommand, StageInstance, TestFailureClass } from '@acc/shared';
import type { Bus } from '../bus.js';
import { newId, now, type BaselineCheckKey, type BaselineCheckRecord, type RepositoryRecord, type Store, type TaskRecord } from '../store/store.js';
import { LogSink } from './log-sink.js';
import { MAX_TARGETED_FILES, targetedCommand, testFilesOf } from './targeted-tests.js';
import { FailureIdCollector, testFailureSummary, testPassSummary } from './test-summary.js';
import type { EngineTooling } from './tooling.js';

/**
 * Baseline-aware checks (docs/plans/AUTOPILOT_GATES_PLAN.md §3.B). The first
 * time a command fails in a task, the same command runs once on the task's
 * baseline commit, in a detached worktree under the data folder — never in
 * the operator's checkout. One result per repository, commit and command is
 * kept and shared by every task on that commit, and only one run per key is
 * ever in flight.
 */

/** What a failed run is, compared with the baseline. */
export interface Classification {
  classification: TestFailureClass;
  /** The commit it was compared with, when a baseline result exists. */
  baselineCommit: string | null;
  /** Why the comparison could not be made (unknown). */
  reason: string | null;
  /** Set when only the failing test files were run on the baseline (LEAD_TIME_PLAN §3.1): how many. */
  checkedFiles?: number;
}

/**
 * `preexisting` only when the baseline failed too and every failing id of the
 * task's run is among the baseline's failures; `new` when the baseline passed
 * or any failure is not among its failures; `unknown` (treated as new) when
 * either side's ids could not be read, or no baseline result exists.
 */
export function classifyFailures(task: { failures: string[]; overflow: boolean }, baseline: Pick<BaselineCheckRecord, 'status' | 'failures'> | null): TestFailureClass {
  if (!baseline || baseline.status === 'error') return 'unknown';
  if (baseline.status === 'passed') return 'new';
  if (task.overflow || !task.failures.length || !baseline.failures.length) return 'unknown';
  const before = new Set(baseline.failures);
  return task.failures.every((id) => before.has(id)) ? 'preexisting' : 'new';
}

export interface BaselineChecksDeps {
  store: Store;
  bus: Bus;
  tooling: EngineTooling;
  dataDir: string;
}

export class BaselineChecks {
  private readonly inflight = new Map<string, Promise<BaselineCheckRecord>>();

  constructor(private readonly d: BaselineChecksDeps) {}

  root(): string {
    return path.join(this.d.dataDir, 'baselines');
  }

  static commandSha(command: string): string {
    return createHash('sha256').update(command).digest('hex').slice(0, 16);
  }

  /**
   * Classify a failed run of `command` in `repo` against the task's baseline
   * commit, running the baseline once when no result is recorded yet.
   */
  async classify(
    input: { task: TaskRecord; stage: StageInstance; repo: RepositoryRecord; baselineCommit: string | null; command: RepositoryCommand; env: NodeJS.ProcessEnv; failures: string[]; overflow: boolean },
    signal: { stopped: () => boolean },
  ): Promise<Classification> {
    const { baselineCommit } = input;
    if (!baselineCommit) return { classification: 'unknown', baselineCommit: null, reason: 'the task has no baseline commit' };
    // Nothing to compare: the failing tests could not be named, so no baseline run can prove them old.
    if (input.overflow || !input.failures.length) return { classification: 'unknown', baselineCommit, reason: input.overflow ? 'too many failing tests to compare' : 'the failing tests could not be identified in the output' };
    const key: BaselineCheckKey = { repositoryId: input.repo.id, baselineCommit, commandId: input.command.id, commandSha: BaselineChecks.commandSha(input.command.command) };
    // Only the failing test files first (LEAD_TIME_PLAN §3.1), unless the whole suite's answer is already known.
    const known = this.d.store.getBaselineCheck(key);
    if (!known || known.status === 'error') {
      const targeted = await this.targeted(input, key, signal);
      if (targeted) return targeted;
    }
    let result: BaselineCheckRecord;
    try {
      result = await this.result(key, input, signal);
    } catch (error) {
      return { classification: 'unknown', baselineCommit, reason: redact((error as Error).message).slice(0, 300) };
    }
    const classification = classifyFailures(input, result);
    const reason = result.status === 'error' ? (result.summary ?? 'the baseline could not be checked') : null;
    return { classification, baselineCommit, reason };
  }

  /**
   * Run only the failing test files on the baseline. It answers only when every
   * failure reproduces there (pre-existing); otherwise null, and the full run
   * decides. Its result is kept under the narrowed command's own sha, so it can
   * never stand in for a full run.
   */
  private async targeted(input: Parameters<BaselineChecks['classify']>[0], key: BaselineCheckKey, signal: { stopped: () => boolean }): Promise<Classification | null> {
    const files = testFilesOf(input.failures);
    if (!files.length || files.length > MAX_TARGETED_FILES || signal.stopped()) return null;
    try {
      const repoPath = input.repo.path;
      // The command and the files as they are at the baseline commit, not in the task's changed copy.
      const present = await git(repoPath, ['ls-tree', '-r', '--name-only', key.baselineCommit, '--', ...files]);
      if (present.code !== 0) return null;
      const atBaseline = new Set(present.stdout.split('\n').filter(Boolean));
      if (!files.every((f) => atBaseline.has(f))) return null;
      const pkg = await git(repoPath, ['show', `${key.baselineCommit}:package.json`]);
      let scripts: Record<string, string> | null = null;
      if (pkg.code === 0) {
        const parsed = JSON.parse(pkg.stdout) as { scripts?: unknown };
        if (parsed.scripts && typeof parsed.scripts === 'object') scripts = parsed.scripts as Record<string, string>;
      }
      const narrowed = targetedCommand(input.command.command, scripts, files);
      if (!narrowed) return null;
      const command = { ...input.command, command: narrowed.commandLine };
      const record = await this.result({ ...key, commandSha: BaselineChecks.commandSha(narrowed.commandLine) }, { ...input, command }, signal);
      if (classifyFailures(input, record) !== 'preexisting') return null;
      return { classification: 'preexisting', baselineCommit: key.baselineCommit, reason: null, checkedFiles: files.length };
    } catch {
      return null;
    }
  }

  private async result(key: BaselineCheckKey, input: Parameters<BaselineChecks['classify']>[0], signal: { stopped: () => boolean }): Promise<BaselineCheckRecord> {
    const cached = this.d.store.getBaselineCheck(key);
    // An earlier attempt that could not run proves nothing: it is tried again.
    if (cached && cached.status !== 'error') return cached;
    const id = `${key.repositoryId}|${key.baselineCommit}|${key.commandId}|${key.commandSha}`;
    let running = this.inflight.get(id);
    if (!running) {
      running = this.run(key, input, signal).finally(() => this.inflight.delete(id));
      this.inflight.set(id, running);
    }
    return running;
  }

  private async run(key: BaselineCheckKey, input: Parameters<BaselineChecks['classify']>[0], signal: { stopped: () => boolean }): Promise<BaselineCheckRecord> {
    const { store, bus } = this.d;
    const { task, stage, repo, command } = input;
    const slug = `${repo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${repo.id.slice(0, 6)}`;
    const dir = path.join(this.root(), slug, `${key.baselineCommit.slice(0, 12)}-${randomBytes(3).toString('hex')}`);
    const started = Date.now();
    const executionId = newId();
    const startedAt = now();
    store.insertExecution({ id: executionId, taskId: task.id, stageId: stage.id, kind: 'command', agentId: null, model: null, effort: null, command: `baseline ${key.baselineCommit.slice(0, 10)}: ${redact(command.command)}`, cwd: dir, status: 'running', exitCode: null, errorClass: null, errorMessage: null, pid: null, startedAt, finishedAt: null, durationMs: null });
    const publish = () => {
      const execution = store.getExecution(executionId);
      if (execution) bus.publish({ type: 'execution', execution });
    };
    publish();
    const sink = new LogSink(store, bus, task.id, executionId);
    const finish = (status: BaselineCheckRecord['status'], summary: string | null, failures: string[], exitCode: number | null): BaselineCheckRecord => {
      sink.flush();
      const finishedAt = now();
      store.updateExecution(executionId, { status: status === 'passed' ? 'succeeded' : 'failed', exitCode, errorMessage: status === 'error' ? summary : null, finishedAt, durationMs: Date.now() - started });
      publish();
      const rec: BaselineCheckRecord = { ...key, id: newId(), status, summary: summary ? redact(summary).slice(0, 400) : null, failures, durationMs: Date.now() - started, createdAt: finishedAt };
      store.saveBaselineCheck(rec);
      return rec;
    };
    try {
      mkdirSync(path.dirname(dir), { recursive: true });
      sink.push('system', `Checking the same command on the baseline commit ${key.baselineCommit.slice(0, 10)} in ${dir}`);
      try {
        await addDetachedWorktree(repo.path, dir, key.baselineCommit);
      } catch (error) {
        return finish('error', `The baseline worktree could not be created: ${(error as Error).message}`, [], null);
      }
      const prepared = await this.d.tooling.prepareDetached(task, repo, dir);
      if (!prepared.ok) return finish('error', `Dependencies could not be installed on the baseline: ${prepared.summary}`, [], null);
      if (signal.stopped()) return finish('error', 'Stopped before the baseline check ran', [], null);
      const collector = new FailureIdCollector();
      sink.push('system', `$ ${command.command}`);
      const handle = runShell({
        commandLine: command.command,
        cwd: dir,
        env: input.env,
        timeoutMs: command.timeoutSec * 1000,
        onLine: (stream, line) => {
          sink.push(stream, line);
          collector.push(line);
        },
      });
      const result = await handle.done;
      const tail = sink.recent(80);
      if (result.cancelled) return finish('error', 'The baseline check was stopped', [], result.exitCode);
      if (result.timedOut) return finish('error', `The baseline check timed out after ${command.timeoutSec}s`, [], result.exitCode);
      if (result.spawnError) return finish('error', `The baseline check could not start: ${result.spawnError}`, [], null);
      if (result.exitCode === 0) return finish('passed', testPassSummary(tail), [], 0);
      return finish(collector.overflow ? 'error' : 'failed', collector.overflow ? 'Too many failing tests on the baseline to compare' : testFailureSummary(tail), collector.list().map((f) => redact(f)), result.exitCode);
    } catch (error) {
      return finish('error', `The baseline check failed: ${(error as Error).message}`, [], null);
    } finally {
      await removeWorktree(repo.path, dir, { force: true }).catch(() => false);
    }
  }

  /**
   * Remove whatever an interrupted baseline check left under the data folder,
   * then let each repository forget those worktrees. Only paths under
   * `<dataDir>/baselines` are ever deleted.
   */
  async sweep(repositories: RepositoryRecord[]): Promise<number> {
    const root = this.root();
    if (!existsSync(root)) return 0;
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const name of entries) await rm(path.join(root, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => undefined);
    if (entries.length) for (const repo of repositories) if (existsSync(repo.path)) await git(repo.path, ['worktree', 'prune']).catch(() => null);
    return entries.length;
  }
}
