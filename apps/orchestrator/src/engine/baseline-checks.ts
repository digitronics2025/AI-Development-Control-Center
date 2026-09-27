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
 * ever in flight. A command whose latest baseline result failed may be run
 * there earlier, when its tests stage starts (`warm`), so the answer is ready.
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

/** What a baseline run needs: the task and stage it is recorded under, and the command to run on the task's baseline commit. */
export interface BaselineRunInput {
  task: TaskRecord;
  stage: StageInstance;
  repo: RepositoryRecord;
  baselineCommit: string | null;
  command: RepositoryCommand;
  env: NodeJS.ProcessEnv;
}

/** When a baseline run gives up: `stopped` is asked between steps; `abort` also cancels the command while it runs (a warm-up nobody needs any more). */
export interface BaselineSignal {
  stopped: () => boolean;
  abort?: AbortSignal;
}

/** A warm-up started by `BaselineChecks.warm`: `done` settles when it ends (null when it could not run), `cancel` stops it unless another caller waits on it. */
export interface BaselineWarmup {
  done: Promise<BaselineCheckRecord | null>;
  cancel: () => void;
  /** How long it was expected to take, from the kept history. */
  expectedMs: number;
}

const keyId = (key: BaselineCheckKey): string => `${key.repositoryId}|${key.baselineCommit}|${key.commandId}|${key.commandSha}`;

export interface BaselineChecksDeps {
  store: Store;
  bus: Bus;
  tooling: EngineTooling;
  dataDir: string;
}

export class BaselineChecks {
  private readonly inflight = new Map<string, Promise<BaselineCheckRecord>>();
  /** In-flight runs someone other than their starter waits on: a warm-up's `cancel` leaves these running. */
  private readonly shared = new Set<string>();

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
  async classify(input: BaselineRunInput & { failures: string[]; overflow: boolean }, signal: BaselineSignal): Promise<Classification> {
    const { baselineCommit } = input;
    if (!baselineCommit) return { classification: 'unknown', baselineCommit: null, reason: 'the task has no baseline commit' };
    // Nothing to compare: the failing tests could not be named, so no baseline run can prove them old.
    if (input.overflow || !input.failures.length) return { classification: 'unknown', baselineCommit, reason: input.overflow ? 'too many failing tests to compare' : 'the failing tests could not be identified in the output' };
    const key = BaselineChecks.key(input.repo, baselineCommit, input.command);
    // A warm-up of this very run may be under way (started with the tests stage): its answer is waited for, never run twice.
    await this.join(keyId(key))?.catch(() => null);
    // Only the failing test files first (LEAD_TIME_PLAN §3.1), unless the whole suite's answer is already known.
    const known = this.d.store.getBaselineCheck(key);
    if (!known || known.status === 'error') {
      const targeted = await this.targeted(input, key, signal);
      if (targeted) return targeted;
      // Stopped during the narrowed run: no full run (and no install) starts after the stop.
      if (signal.stopped()) return { classification: 'unknown', baselineCommit, reason: 'stopped before the baseline check finished' };
    }
    let result: BaselineCheckRecord;
    try {
      result = await this.result(key, input, signal);
    } catch (error) {
      return { classification: 'unknown', baselineCommit, reason: redact((error as Error).message).slice(0, 300) };
    }
    const classification = classifyFailures(input, result);
    if (classification === 'new' && result.status !== 'error' && !signal.stopped()) {
      // A kept answer can be out of date for a test that depends on the clock or the machine: in the
      // TASK-0010 replay a time-of-day test failed at night on the baseline too, but not in the full run
      // kept from the afternoon. The failures it does not explain run again on the baseline, now.
      const explained = new Set(result.status === 'failed' ? result.failures : []);
      const unexplained = input.failures.filter((id) => !explained.has(id));
      const fresh = await this.targeted({ ...input, failures: unexplained }, key, signal, { fresh: true });
      if (fresh) return fresh;
    }
    const reason = result.status === 'error' ? (result.summary ?? 'the baseline could not be checked') : null;
    return { classification, baselineCommit, reason };
  }

  /**
   * Run only the failing test files on the baseline. It answers only when every
   * failure reproduces there (pre-existing); otherwise null, and the full run
   * decides. Its result is kept under the narrowed command's own sha, so it can
   * never stand in for a full run.
   */
  private async targeted(input: Parameters<BaselineChecks['classify']>[0], key: BaselineCheckKey, signal: BaselineSignal, opts: { fresh?: boolean } = {}): Promise<Classification | null> {
    const files = testFilesOf(input.failures);
    if (!files.length || files.length > MAX_TARGETED_FILES || signal.stopped()) return null;
    try {
      const repoPath = input.repo.path;
      // The command and the files as they are at the baseline commit, not in the task's changed copy.
      const present = await git(repoPath, ['--literal-pathspecs', 'ls-tree', '-r', '--name-only', key.baselineCommit, '--', ...files]);
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
      const narrowedKey = { ...key, commandSha: BaselineChecks.commandSha(narrowed.commandLine) };
      // Fresh: run now, whatever an earlier run of the same files said (it replaces that row).
      const record = opts.fresh ? await this.run(narrowedKey, { ...input, command }, signal) : await this.result(narrowedKey, { ...input, command }, signal);
      if (classifyFailures(input, record) !== 'preexisting') return null;
      return { classification: 'preexisting', baselineCommit: key.baselineCommit, reason: null, checkedFiles: files.length };
    } catch {
      return null;
    }
  }

  /** The key a result of `command` at `baselineCommit` is kept and deduplicated under. */
  static key(repo: Pick<RepositoryRecord, 'id'>, baselineCommit: string, command: Pick<RepositoryCommand, 'id' | 'command'>): BaselineCheckKey {
    return { repositoryId: repo.id, baselineCommit, commandId: command.id, commandSha: BaselineChecks.commandSha(command.command) };
  }

  /**
   * The newest usable (non-`error`) kept result of this command in this
   * repository that also matches `where`, at any commit. A narrowed run keeps
   * the command's id under its own sha, so it is found by id too.
   */
  private latest(repositoryId: string, commandId: string, where: string, ...params: string[]): Pick<BaselineCheckRecord, 'status' | 'durationMs'> | null {
    const sql = `SELECT status, duration_ms FROM baseline_checks WHERE repository_id = ? AND command_id = ? AND status <> 'error' AND ${where} ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    const row = this.d.store.db.prepare(sql).get(repositoryId, commandId, ...params) as { status: BaselineCheckRecord['status']; duration_ms: number | null } | undefined;
    return row ? { status: row.status, durationMs: row.duration_ms } : null;
  }

  /**
   * Start the full baseline run of `command` now, before anything has failed,
   * so a failure later in the stage is classified without waiting for it
   * (TASK-0014: the e2e baseline run, about two minutes, sat on the critical
   * path after the task's own e2e failed). Only when history predicts both
   * that it is needed and that it costs no wait:
   * - nothing usable is kept for it at this commit yet;
   * - the newest kept result that says whether it fails on a baseline says it
   *   does: a run of the whole command as it reads now, or a failed run of only
   *   some of its files (they fail the whole suite too). A narrowed run that
   *   passed says nothing about the rest. The warm-up keeps its own result, so
   *   once the baseline passes again, warming stops by itself;
   * - it is expected to end within `headStartMs`, the time the checks before
   *   it typically take, so the command never waits long for it. Expected: the
   *   newest whole run's duration, or without one the newest narrowed run's
   *   (its worktree and install) plus the command's `typicalRunMs` in tasks;
   *   neither known means no warm-up.
   * Null when nothing was started.
   */
  warm(input: BaselineRunInput, timing: { headStartMs: number; typicalRunMs: number | null }): BaselineWarmup | null {
    const { baselineCommit, repo, command } = input;
    if (!baselineCommit) return null;
    const key = BaselineChecks.key(repo, baselineCommit, command);
    if (this.latest(repo.id, command.id, 'baseline_commit = ?', baselineCommit)) return null;
    const verdict = this.latest(repo.id, command.id, "(command_sha = ? OR status = 'failed')", key.commandSha);
    if (verdict?.status !== 'failed') return null;
    const whole = this.latest(repo.id, command.id, 'command_sha = ?', key.commandSha)?.durationMs ?? null;
    const expectedMs = whole ?? (verdict.durationMs !== null && timing.typicalRunMs !== null ? verdict.durationMs + timing.typicalRunMs : null);
    if (expectedMs === null || expectedMs > timing.headStartMs) return null;
    const id = keyId(key);
    // Already running for someone else (another task on the same commit): wait for that run, never stop it.
    const running = this.join(id);
    if (running) return { done: running.catch(() => null), cancel: () => undefined, expectedMs };
    const controller = new AbortController();
    const done = this.result(key, input, { stopped: () => controller.signal.aborted, abort: controller.signal });
    return {
      done: done.catch(() => null),
      cancel: () => {
        if (!this.shared.has(id)) controller.abort();
      },
      expectedMs,
    };
  }

  /** The in-flight run of `id`, marked as waited on by a second caller; undefined when none runs. */
  private join(id: string): Promise<BaselineCheckRecord> | undefined {
    const running = this.inflight.get(id);
    if (running) this.shared.add(id);
    return running;
  }

  private async result(key: BaselineCheckKey, input: BaselineRunInput, signal: BaselineSignal): Promise<BaselineCheckRecord> {
    const cached = this.d.store.getBaselineCheck(key);
    // An earlier attempt that could not run proves nothing: it is tried again.
    if (cached && cached.status !== 'error') return cached;
    const id = keyId(key);
    let running = this.join(id);
    if (!running) {
      running = this.run(key, input, signal).finally(() => {
        this.inflight.delete(id);
        this.shared.delete(id);
      });
      this.inflight.set(id, running);
    }
    return running;
  }

  private async run(key: BaselineCheckKey, input: BaselineRunInput, signal: BaselineSignal): Promise<BaselineCheckRecord> {
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
      const cancel = () => void handle.cancel();
      signal.abort?.addEventListener('abort', cancel, { once: true });
      if (signal.abort?.aborted) cancel();
      const result = await handle.done.finally(() => signal.abort?.removeEventListener('abort', cancel));
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
