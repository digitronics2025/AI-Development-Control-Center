import { existsSync, lstatSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  addChildWorktree,
  applyIfUnchanged,
  changedPathsBetween,
  combineResults,
  createCheckpoint,
  deleteRefs,
  git,
  removeWorktree,
  treeOf,
  workingTreeTree,
  type PathChange,
} from '@acc/git';
import { redact } from '@acc/security';
import {
  COMMAND_KIND_LABEL,
  independentOverlaps,
  pathInScope,
  ROLE_LABEL,
  transitiveDependencies,
  type ErrorClass,
  type StageDefinition,
  type StageInstance,
  type StageWorkUnit,
  type WorkUnitManifestUnit,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { SettingsService } from '../services/settings.js';
import { newId, now, type RepositoryRecord, type Store, type TaskRecord } from '../store/store.js';
import type { ContextBuilder, PromptCoverage } from './context.js';
import type { Publisher } from './publisher.js';
import { extractOperatorBlockers } from './report.js';
import { ROLE_ARTIFACT, parseVerdict, summarize, unreviewedFiles, type AgentRun, type RunControl, type StageOutcome, type StageRunners, type StopReason } from './runners.js';
import { agentWorkdir, isMultiRepository, taskRepositories } from './task-repositories.js';
import { readManifest, stableHash } from './work-units.js';

/**
 * Stage Teams (docs/plans/STAGE_TEAMS_PLAN.md): one workflow stage run by a
 * bounded team of Control Center workers, each its own agent run through
 * `AgentRegistry.launch`, returning one ordinary `StageOutcome` to the engine.
 *
 * Read-only workers share the task's working tree. Write workers each get a
 * disposable detached checkout of a hidden checkpoint of it; their results are
 * captured as hidden commits, checked against the paths they own, combined,
 * and written back only while the task's files still equal the wave's base.
 * Whenever a team cannot run safely, `run` returns null and the stage runs as
 * one agent, exactly as without a team.
 */

export interface StageTeamDeps {
  store: Store;
  bus: Bus;
  publisher: Publisher;
  agents: AgentRegistry;
  artifacts: ArtifactService;
  context: ContextBuilder;
  settings: SettingsService;
  runners: StageRunners;
  dataDir: string;
}

/** A unit about to run: from the fixed worker list, or from the manifest. */
interface PlannedUnit {
  key: string;
  title: string;
  focus: string;
  goal: string | null;
  dependsOn: string[];
  pathScope: string[];
  checks: string[];
  primary: boolean;
  agentId: string;
  model: string | null;
  effort: string | null;
}

/** What one worker left behind. */
interface UnitResult {
  unit: StageWorkUnit;
  planned: PlannedUnit;
  output: string | null;
  /** Write units: the paths it changed, relative to the wave's base. */
  changes: PathChange[];
  failure: { errorClass: ErrorClass; message: string } | null;
  stopped: StopReason | null;
  questions: string[];
}

/** Error classes that stop the task for a person or a reset; one worker hitting one decides the stage's class. */
const BLOCKING: readonly ErrorClass[] = ['USAGE_LIMIT', 'AUTH_FAILURE', 'MODEL_UNAVAILABLE', 'PERMISSION_DENIED', 'CONTEXT_FAILURE'];
/** A worker's report in the aggregate is kept within this much; the full text is its own artifact. */
const MAX_WORKER_IN_AGGREGATE = 30_000;
/** How deep the task's checkout is searched for installed dependency folders to share with a child checkout. */
const DEPENDENCY_DEPTH = 3;

/**
 * Worker slots shared by every task on this machine (Settings → Execution →
 * team worker limit). A waiter gives up as soon as its stage is stopped.
 */
class WorkerSlots {
  private used = 0;
  constructor(private readonly limit: () => number) {}

  async acquire(stopped: () => boolean): Promise<(() => void) | null> {
    while (this.used >= Math.max(1, this.limit())) {
      if (stopped()) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (stopped()) return null;
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
    };
  }
}

export class StageTeamRunner {
  private readonly slots: WorkerSlots;

  constructor(private readonly d: StageTeamDeps) {
    this.slots = new WorkerSlots(() => d.settings.get().execution.teamWorkerLimit);
  }

  /** Where write workers' disposable checkouts live; only this folder is ever swept. */
  root(): string {
    return path.join(this.d.dataDir, 'team-worktrees');
  }

  /**
   * Run `def` as its team. Returns null to run the stage as one agent (with an
   * event saying why): a team that cannot be planned is an optimisation that
   * did not apply, never a task failure.
   */
  async run(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl): Promise<StageOutcome | null> {
    const team = def.team;
    if (!team || def.kind !== 'agent') return null;
    if (def.permissionLevel >= 4) return this.fallback(task, def, stage, 'staging and production stages never run as a team');
    const write = def.permissionLevel >= 2;
    if (write) {
      if (isMultiRepository(this.d.store, task)) return this.fallback(task, def, stage, 'a team that changes files across several repositories is not supported yet');
      if (!task.git.isolated || !task.git.worktreePath) return this.fallback(task, def, stage, 'the task does not run in an isolated worktree, so parallel writers cannot be kept apart');
      if (team.mode === 'fixed') return this.fallback(task, def, stage, 'a fixed team runs only on a read-only stage');
    }

    let planned: PlannedUnit[];
    let fingerprint: unknown;
    if (team.mode === 'fixed') {
      planned = (team.workers ?? []).map((w) => ({
        key: w.key,
        title: w.focus.length > 60 ? `${w.focus.slice(0, 59)}…` : w.focus,
        focus: w.focus,
        goal: null,
        dependsOn: [],
        pathScope: [],
        checks: [],
        primary: w.primary,
        ...this.assignment(task, def, stage, w),
      }));
      if (planned.length < 2) return this.fallback(task, def, stage, 'a fixed team needs at least two workers');
      fingerprint = { stage: def.key, team };
    } else {
      const manifest = await this.manifestFor(task, def, stage, repo, control);
      if (manifest.kind === 'stopped') return { kind: 'stopped', stageId: stage.id, reason: manifest.reason };
      if (manifest.kind === 'none') return this.fallback(task, def, stage, manifest.reason);
      const units = manifest.units;
      if (units.length < 2) return this.fallback(task, def, stage, 'the plan has only one work unit, so one agent does it');
      if (write) {
        const overlaps = independentOverlaps(units);
        if (overlaps.length) return this.fallback(task, def, stage, `units ${overlaps.map(([a, b]) => `${a} and ${b}`).join(', ')} claim the same paths, so they cannot be written in parallel`);
      }
      if (!units.some((a) => units.some((b) => a !== b && !transitiveDependencies(units, a.key).has(b.key) && !transitiveDependencies(units, b.key).has(a.key)))) {
        return this.fallback(task, def, stage, 'every work unit depends on the one before it, so nothing could run in parallel');
      }
      const base = this.assignment(task, def, stage);
      planned = units.map((u) => ({ key: u.key, title: u.title, focus: u.goal, goal: u.goal, dependsOn: u.dependsOn, pathScope: write ? u.pathPrefixes : [], checks: u.checks, primary: false, ...base }));
      fingerprint = { stage: def.key, manifest: manifest.hash };
    }
    // Directives change what a worker is told, so a result from before one is not reused.
    const directives = this.d.store.listDirectives(task.id).filter((d) => d.state === 'active' && d.kind !== 'routing').map((d) => d.id);
    const hash = stableHash({ fingerprint, directives, permissionLevel: def.permissionLevel });
    const cap = Math.min(team.maxWorkers, planned.length);

    // Persist every unit before any starts: the database always knows the whole team.
    const earlier = this.d.store.listWorkUnits(task.id).filter((u) => u.stageKey === def.key);
    const rows = new Map<string, StageWorkUnit>();
    planned.forEach((p, ordinal) => {
      const unit = this.d.store.insertWorkUnit({
        id: newId(),
        taskId: task.id,
        stageId: stage.id,
        stageKey: def.key,
        unitKey: p.key,
        kind: 'worker',
        title: p.title,
        focus: p.focus,
        status: 'QUEUED',
        ordinal,
        dependencies: p.dependsOn,
        pathScope: p.pathScope,
        primary: p.primary,
        manifestHash: hash,
        baseCommit: null,
        resultCommit: null,
        agentId: p.agentId,
        model: p.model,
        effort: p.effort,
        attempt: earlier.filter((u) => u.unitKey === p.key).length + 1,
        reusedFrom: null,
        summary: null,
        errorClass: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now(),
      });
      rows.set(p.key, unit);
      this.publish(unit);
    });
    this.d.publisher.event(
      task.id,
      'STAGE_TEAM',
      `${def.name} runs as a team of ${planned.length} (${write ? 'each in its own checkout' : 'read-only, side by side'}, at most ${cap} at once): ${planned.map((p) => p.title).join(', ')}`,
      { mode: team.mode, units: planned.map((p) => p.key), maxWorkers: cap, write },
      stage.id,
    );

    const startedMs = Date.now();
    const results: UnitResult[] = [];
    const done = new Set<string>();
    let integratedUnits = 0;
    let wave = 0;
    let coverage: PromptCoverage = { required: [], all: [] };
    let pending = [...planned];
    while (pending.length) {
      if (control.stopReason) return this.stopAll(stage, rows, control.stopReason);
      const ready = pending.filter((p) => p.dependsOn.every((dep) => done.has(dep)));
      const batch = ready.slice(0, cap);
      if (!batch.length) break;
      wave++;
      // The prompt is built per wave: a later wave sees what the earlier ones integrated.
      let built;
      try {
        built = await this.d.context.build(this.task(task.id), def, stage);
        this.d.store.updateTask(task.id, { promptVersions: { ...this.task(task.id).promptVersions, [def.role]: built.templateVersion } });
      } catch (error) {
        this.markRemaining(rows, pending, 'CANCELLED', 'The stage context could not be built');
        return this.d.runners.failStage(stage, 'CONTEXT_FAILURE', `Context could not be built: ${(error as Error).message}`);
      }
      coverage = built.coverage;
      const others = (p: PlannedUnit) => planned.filter((o) => o.key !== p.key);
      const waveResults = write
        ? await this.writeWave(task, def, stage, repo, control, batch, rows, built.prompt, others, hash, earlier, wave)
        : await this.readWave(task, def, stage, repo, control, batch, rows, built.prompt, others, hash, earlier);
      if ('outcome' in waveResults) return waveResults.outcome;
      results.push(...waveResults.results);
      pending = pending.filter((p) => !batch.includes(p));

      const stopped = waveResults.results.find((r) => r.stopped);
      if (stopped || control.stopReason) return this.stopAll(stage, rows, control.stopReason ?? stopped!.stopped!);
      const questions = waveResults.results.flatMap((r) => r.questions);
      if (questions.length && def.role !== 'reviewer' && def.role !== 'verifier') {
        this.markRemaining(rows, pending, 'CANCELLED', 'A worker needs your decision first');
        await this.writeAggregate(task, def, stage, results);
        this.d.publisher.updateStage(stage.id, { status: 'PAUSED', summary: summarize(questions.join('\n')), finishedAt: now() });
        return { kind: 'needs_operator', stageId: stage.id, questions };
      }
      const failed = waveResults.results.filter((r) => r.failure);
      if (failed.length) {
        this.markRemaining(rows, pending, 'SKIPPED', 'An earlier work unit failed');
        await this.writeAggregate(task, def, stage, results);
        return this.failTeam(stage, failed, waveResults.results.length, write);
      }
      if (write) {
        const integration = await this.integrate(task, def, stage, waveResults.results, wave);
        if (integration.kind === 'failed') {
          this.markRemaining(rows, pending, 'SKIPPED', 'The team could not integrate an earlier wave');
          await this.writeAggregate(task, def, stage, results);
          return this.d.runners.failStage(stage, 'UNKNOWN', integration.message);
        }
        integratedUnits += integration.units;
      }
      for (const r of waveResults.results) done.add(r.planned.key);
    }
    if (pending.length) {
      this.markRemaining(rows, pending, 'SKIPPED', 'Its dependencies did not finish');
      return this.d.runners.failStage(stage, 'UNKNOWN', `${def.name}: ${pending.length} work unit(s) could not start because their dependencies did not finish`);
    }

    // Several writers' patches can each be right and still not fit together: one short lead pass reconciles them.
    let lead: string | null = null;
    if (write && integratedUnits >= 2) {
      const pass = await this.integrationPass(task, def, stage, repo, control, results);
      if (pass.kind === 'stopped') return { kind: 'stopped', stageId: stage.id, reason: pass.reason };
      if (pass.kind === 'failed') {
        await this.writeAggregate(task, def, stage, results);
        return this.d.runners.failStage(stage, pass.errorClass, `Integration pass: ${pass.message}`);
      }
      lead = pass.output;
    }

    const aggregate = await this.writeAggregate(task, def, stage, results, lead);
    const wallMs = Date.now() - startedMs;
    const agentMs = results.reduce((sum, r) => sum + (r.unit.startedAt && r.unit.finishedAt && r.unit.status === 'SUCCESS' ? new Date(r.unit.finishedAt).getTime() - new Date(r.unit.startedAt).getTime() : 0), 0);
    const teamData = { workers: results.length, reused: results.filter((r) => r.unit.status === 'REUSED').length, wallMs, agentMs, integrated: integratedUnits };

    let verdict: 'PASS' | 'FAIL' | null = null;
    if (def.verdict || def.role === 'reviewer' || def.role === 'verifier') {
      const verdicts = results.map((r) => ({ r, v: parseVerdict(r.output ?? '') }));
      const missing = verdicts.filter((x) => !x.v);
      if (def.verdict && missing.length) {
        return this.d.runners.failStage(stage, 'UNKNOWN', `${missing.map((x) => x.r.planned.title).join(', ')} did not end with "VERDICT: PASS" or "VERDICT: FAIL"`);
      }
      verdict = verdicts.some((x) => x.v === 'FAIL') ? 'FAIL' : verdicts.some((x) => x.v === 'PASS') ? 'PASS' : null;
      if (def.verdict && verdict === 'PASS') {
        // A PASS counts only when the primary reviewer accounted for every changed file the diff did not show (AUTOPILOT_GATES_PLAN §3.A).
        const primary = results.find((r) => r.planned.primary) ?? results[0]!;
        const gaps = unreviewedFiles(primary.output ?? '', coverage);
        if (gaps.length) {
          const retried = await this.coverageFollowUp(task, def, stage, repo, control, primary, gaps);
          if (retried.kind === 'stopped') return { kind: 'stopped', stageId: stage.id, reason: retried.reason };
          if (retried.kind === 'failed') return this.d.runners.failStage(stage, retried.errorClass, retried.message);
          const again = parseVerdict(retried.output);
          if (!again) return this.d.runners.failStage(stage, 'UNKNOWN', `${primary.planned.title} did not end its follow-up with a VERDICT line`);
          if (again === 'FAIL') verdict = 'FAIL';
          else {
            const still = unreviewedFiles(retried.output, coverage);
            if (still.length) return this.d.runners.failStage(stage, 'REVIEW_INCOMPLETE', `${def.name} (primary reviewer) gave PASS twice without reviewing ${still.length} changed file${still.length === 1 ? '' : 's'} the diff did not show: ${still.slice(0, 20).join(', ')}${still.length > 20 ? ', …' : ''}`);
          }
        }
      }
    }
    const first = lead ?? results.find((r) => r.planned.primary)?.output ?? results.find((r) => r.output)?.output ?? aggregate;
    const summary = `Team of ${results.length}${teamData.reused ? ` (${teamData.reused} reused)` : ''}: ${summarize(first, 200) ?? 'done'}`;
    return this.d.runners.completeAgentStage(task, def, stage, summary, verdict, wallMs, { team: teamData });
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  /** The stage's assignment for a worker: a fixed worker's own pin, else the stage's; a task reroute of the stage moves every worker. */
  private assignment(task: TaskRecord, def: StageDefinition, stage: StageInstance, worker?: { agentId?: string; model?: string; effort?: string }): { agentId: string; model: string | null; effort: string | null } {
    const override = task.overrides.stages[def.key];
    if (override?.agentId || !worker?.agentId) return { agentId: stage.agentId!, model: stage.model, effort: worker?.effort ?? stage.effort };
    const sameAgent = worker.agentId === stage.agentId;
    return { agentId: worker.agentId, model: worker.model ?? (sameAgent ? stage.model : 'default'), effort: worker.effort ?? stage.effort };
  }

  /**
   * The work units of an adaptive stage: from the latest plan's manifest, or —
   * for a Fix, whose failures the plan never saw — from one read-only
   * decomposition run over the fresh test and review evidence.
   */
  private async manifestFor(
    task: TaskRecord,
    def: StageDefinition,
    stage: StageInstance,
    repo: RepositoryRecord,
    control: RunControl,
  ): Promise<{ kind: 'units'; units: WorkUnitManifestUnit[]; hash: string } | { kind: 'none'; reason: string } | { kind: 'stopped'; reason: StopReason }> {
    if (def.role !== 'fixer') {
      const plan = await this.d.artifacts.latestText(task.id, 'plan');
      if (!plan) return { kind: 'none', reason: 'there is no plan to take work units from' };
      const read = readManifest(plan, def.key);
      return read.ok ? { kind: 'units', units: read.manifest.units, hash: read.hash } : { kind: 'none', reason: read.reason };
    }
    return this.decompose(task, def, stage, repo, control);
  }

  private async decompose(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl): Promise<{ kind: 'units'; units: WorkUnitManifestUnit[]; hash: string } | { kind: 'none'; reason: string } | { kind: 'stopped'; reason: StopReason }> {
    let built;
    try {
      built = await this.d.context.build(task, def, stage);
    } catch (error) {
      return { kind: 'none', reason: `the failure could not be read for decomposition (${(error as Error).message})` };
    }
    const unit = this.d.store.insertWorkUnit({
      ...this.blankUnit(task, def, stage, 'decompose', 'decomposer', 'Split the fix', 'Read-only: split the failures into independent repairs'),
      ...this.assignment(task, def, stage),
    });
    this.publish(unit);
    const prompt = [
      built.prompt.replace(/^Role: \w+$/m, 'Role: decomposer'),
      '',
      '## Decomposition only (from the orchestrator)',
      '',
      'Do not change any file. Read the failures above and decide whether they need two or more repairs that are genuinely independent: different files, no shared interface, each verifiable on its own. Prefer ONE unit whenever the repairs touch the same code or depend on each other — splitting is only worth it for truly separate work.',
      '',
      `End your answer with exactly one fenced block tagged \`acc-work-units\` holding JSON: {"version":1,"stage":"${def.key}","units":[{"key":"slug","title":"short title","goal":"what to repair","dependsOn":[],"pathPrefixes":["repository/relative/folder/"],"checks":["test"]}]}. Path prefixes are repository-relative folders or files each unit alone may change; units that may run together must not share any.`,
    ].join('\n');
    const release = await this.slots.acquire(() => control.stopReason !== null);
    if (!release) return { kind: 'stopped', reason: control.stopReason ?? 'cancel' };
    this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'RUNNING', startedAt: now() }));
    let run: AgentRun;
    try {
      run = await this.d.runners.launchAgent(task, def, stage, repo, control, { prompt, agentId: unit.agentId!, model: unit.model, effort: unit.effort, cwd: agentWorkdir(task, repo), permissionLevel: 1, workUnit: { id: unit.id, key: unit.unitKey, title: unit.title } });
    } finally {
      release();
    }
    if (run.kind === 'stopped') {
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'CANCELLED', finishedAt: now() }));
      return { kind: 'stopped', reason: run.reason };
    }
    if (run.kind === 'failed') {
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'FAILED', errorClass: run.errorClass, errorMessage: redact(run.message).slice(0, 500), finishedAt: now() }));
      return { kind: 'none', reason: `the decomposition run failed (${run.message.slice(0, 120)})` };
    }
    await this.d.artifacts.write(task.id, { name: `${def.key}-decomposition.md`, type: 'stage-output', content: run.output, stageId: stage.id, stageKey: def.key });
    const read = readManifest(run.output, def.key);
    this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'SUCCESS', summary: read.ok ? `${read.manifest.units.length} unit(s): ${read.manifest.units.map((u) => u.title).join(', ')}` : read.reason, finishedAt: now() }));
    return read.ok ? { kind: 'units', units: read.manifest.units, hash: read.hash } : { kind: 'none', reason: read.reason };
  }

  private fallback(task: TaskRecord, def: StageDefinition, stage: StageInstance, reason: string): null {
    this.d.publisher.event(task.id, 'STAGE_TEAM', `${def.name} runs as one agent: ${reason}`, { fallback: true, reason }, stage.id);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Waves
  // ---------------------------------------------------------------------------

  /** Read-only workers, side by side in the task's own working tree. */
  private async readWave(
    task: TaskRecord,
    def: StageDefinition,
    stage: StageInstance,
    repo: RepositoryRecord,
    control: RunControl,
    batch: PlannedUnit[],
    rows: Map<string, StageWorkUnit>,
    basePrompt: string,
    others: (p: PlannedUnit) => PlannedUnit[],
    hash: string,
    earlier: StageWorkUnit[],
  ): Promise<{ results: UnitResult[] } | { outcome: StageOutcome }> {
    const cwd = agentWorkdir(task, repo);
    const results = await Promise.all(
      batch.map(async (p): Promise<UnitResult> => {
        const unit = rows.get(p.key)!;
        const reused = await this.reusedOutput(task, stage, unit, hash, earlier);
        if (reused !== null) return { unit: this.d.store.getWorkUnit(unit.id)!, planned: p, output: reused, changes: [], failure: null, stopped: null, questions: [] };
        const prompt = basePrompt + this.unitSection(def, p, others(p), false);
        const run = await this.runUnit(task, def, stage, repo, control, unit, prompt, cwd, false);
        return this.settle(task, def, stage, unit, p, run, []);
      }),
    );
    return { results };
  }

  /**
   * Write workers, each in its own disposable checkout of a hidden checkpoint
   * of the task's working tree. Their results are captured and checked here;
   * nothing reaches the task until `integrate`.
   */
  private async writeWave(
    task: TaskRecord,
    def: StageDefinition,
    stage: StageInstance,
    repo: RepositoryRecord,
    control: RunControl,
    batch: PlannedUnit[],
    rows: Map<string, StageWorkUnit>,
    basePrompt: string,
    others: (p: PlannedUnit) => PlannedUnit[],
    hash: string,
    earlier: StageWorkUnit[],
    wave: number,
  ): Promise<{ results: UnitResult[] } | { outcome: StageOutcome }> {
    const parent = task.git.worktreePath!;
    let base;
    try {
      base = await createCheckpoint(parent, `${this.refPrefix(task)}${stage.id}/w${wave}-base`, `${task.id}: ${def.name} team wave ${wave} base`);
    } catch (error) {
      for (const p of batch) this.publish(this.d.store.updateWorkUnit(rows.get(p.key)!.id, { status: 'FAILED', errorClass: 'UNKNOWN', errorMessage: 'The team could not record its starting point', finishedAt: now() }));
      return { outcome: this.d.runners.failStage(stage, 'UNKNOWN', `The team could not record the task's files before starting: ${(error as Error).message}`) };
    }
    const results = await Promise.all(
      batch.map(async (p): Promise<UnitResult> => {
        const unit = this.d.store.updateWorkUnit(rows.get(p.key)!.id, { baseCommit: base.commit });
        const reused = await this.reusedResult(parent, unit, hash, earlier, base.tree);
        if (reused) return { unit: this.d.store.getWorkUnit(unit.id)!, planned: p, output: reused.output, changes: reused.changes, failure: null, stopped: null, questions: [] };
        const dir = path.join(this.root(), task.id, `${stage.id.slice(0, 8)}-${p.key}`);
        let links: string[] = [];
        try {
          if (existsSync(dir)) await this.removeChild(parent, dir, []);
          await addChildWorktree(parent, dir, base.commit);
          links = linkDependencies(parent, dir);
        } catch (error) {
          await this.removeChild(parent, dir, links);
          const message = `Its own checkout could not be created: ${redact((error as Error).message).slice(0, 300)}`;
          this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'FAILED', errorClass: 'UNKNOWN', errorMessage: message, finishedAt: now() }));
          return { unit: this.d.store.getWorkUnit(unit.id)!, planned: p, output: null, changes: [], failure: { errorClass: 'UNKNOWN', message }, stopped: null, questions: [] };
        }
        try {
          const prompt = rewritePaths(basePrompt, parent, dir) + this.unitSection(def, p, others(p), true);
          const run = await this.runUnit(task, def, stage, repo, control, unit, prompt, dir, true);
          if (run.kind !== 'ok') return this.settle(task, def, stage, unit, p, run, []);
          // Capture everything the worker left — new, deleted, binary files included — as a hidden commit, then check its paths.
          const result = await createCheckpoint(dir, `${this.refPrefix(task)}${stage.id}/${p.key}`, `${task.id}: ${def.name} · ${p.title}`);
          const changes = await changedPathsBetween(parent, base.commit, result.commit);
          const outside = changes.filter((c) => !pathInScope(c.path, p.pathScope));
          this.d.store.updateWorkUnit(unit.id, { resultCommit: result.commit });
          if (outside.length) {
            const names = outside.slice(0, 10).map((c) => c.path).join(', ') + (outside.length > 10 ? ', …' : '');
            return this.settle(task, def, stage, unit, p, { kind: 'failed', errorClass: 'UNKNOWN', message: `changed ${outside.length} file(s) outside the paths it owns (${names}); none of its work was used` }, changes, 'SCOPE_VIOLATION');
          }
          return this.settle(task, def, stage, unit, p, run, changes);
        } catch (error) {
          const message = `Its result could not be captured: ${redact((error as Error).message).slice(0, 300)}`;
          return this.settle(task, def, stage, unit, p, { kind: 'failed', errorClass: 'UNKNOWN', message }, []);
        } finally {
          await this.removeChild(parent, dir, links);
        }
      }),
    );
    return { results };
  }

  /** Write every unit of a finished wave into the task's working tree at once — or nothing. */
  private async integrate(task: TaskRecord, def: StageDefinition, stage: StageInstance, results: UnitResult[], wave: number): Promise<{ kind: 'ok'; units: number } | { kind: 'failed'; message: string }> {
    const parent = task.git.worktreePath!;
    const base = results[0]?.unit.baseCommit;
    const withChanges = results.filter((r) => r.changes.length);
    if (!base || !withChanges.length) return { kind: 'ok', units: 0 };
    const owners = new Map<string, string>();
    for (const r of withChanges) {
      for (const c of r.changes) {
        const other = owners.get(c.path);
        if (other) return { kind: 'failed', message: `${other} and ${r.planned.title} both changed ${c.path}; nothing from this wave was integrated` };
        owners.set(c.path, r.planned.title);
      }
    }
    try {
      const combined = await combineResults(parent, base, withChanges.map((r) => ({ changes: r.changes })), `${this.refPrefix(task)}${stage.id}/w${wave}-combined`, `${task.id}: ${def.name} team wave ${wave}`);
      const applied = await applyIfUnchanged(parent, base, combined.commit, new Set(owners.keys()));
      if (!applied) return { kind: 'failed', message: `The task's files changed while the team worked, so nothing from wave ${wave} was integrated (no file was overwritten)` };
      const files = applied.restored.length + applied.removed.length;
      this.d.publisher.event(
        task.id,
        'STAGE_TEAM',
        `${def.name}: integrated ${withChanges.length} work unit${withChanges.length === 1 ? '' : 's'} (${files} file${files === 1 ? '' : 's'}) into the task`,
        { wave, commit: combined.commit, units: withChanges.map((r) => r.planned.key), files },
        stage.id,
      );
      return { kind: 'ok', units: withChanges.length };
    } catch (error) {
      return { kind: 'failed', message: `The team's work could not be integrated: ${redact((error as Error).message).slice(0, 300)}` };
    }
  }

  /** The lead's short consistency pass over the integrated change, in the task's own working tree. */
  private async integrationPass(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl, results: UnitResult[]): Promise<AgentRun> {
    let built;
    try {
      built = await this.d.context.build(this.task(task.id), def, stage);
    } catch (error) {
      return { kind: 'failed', errorClass: 'CONTEXT_FAILURE', message: `Context could not be built: ${(error as Error).message}` };
    }
    const unit = this.d.store.insertWorkUnit({
      ...this.blankUnit(task, def, stage, 'integration', 'integration', 'Integration', 'Reconcile the units into one consistent change'),
      ...this.assignment(task, def, stage),
      ordinal: results.length,
      dependencies: results.map((r) => r.planned.key),
    });
    this.publish(unit);
    const prompt = [
      built.prompt,
      '',
      '## Integration pass (Stage Team lead, from the orchestrator)',
      '',
      `The Control Center ran this stage as ${results.length} work units, each in its own checkout, and has already integrated their changes into this working tree:`,
      '',
      ...results.map((r) => `- ${r.planned.title} (${r.planned.pathScope.join(', ')}): ${r.unit.summary ?? 'no summary'}`),
      '',
      'Your job is the final consistency pass: read the integrated diff above and reconcile contracts, types, imports and interfaces between the units. Fix only integration problems; do not redo or extend the units\' work. Run only the targeted checks for the areas touched. Do not commit. Then write your report as the template asks, covering the whole combined change.',
    ].join('\n');
    const release = await this.slots.acquire(() => control.stopReason !== null);
    if (!release) return { kind: 'stopped', reason: control.stopReason ?? 'cancel' };
    let run: AgentRun;
    try {
      run = await this.runUnit(task, def, stage, repo, control, unit, prompt, agentWorkdir(task, repo), false, true);
    } finally {
      release();
    }
    this.settleRow(unit, run);
    return run;
  }

  /** Ask the primary reviewer once more for the files its PASS did not account for (same unit, a second execution). */
  private async coverageFollowUp(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl, primary: UnitResult, missing: string[]): Promise<AgentRun> {
    const names = missing.slice(0, 20).join(', ') + (missing.length > 20 ? `, and ${missing.length - 20} more` : '');
    this.d.publisher.event(task.id, 'STAGE_RETRY', `${primary.planned.title} passed without accounting for ${missing.length} changed file${missing.length === 1 ? '' : 's'} the diff did not show (${names}); asking once more`, { missing, workUnitKey: primary.planned.key }, stage.id);
    const built = await this.d.context.build(this.task(task.id), def, stage);
    const prompt = [
      built.prompt + this.unitSection(def, primary.planned, [], false),
      '',
      '## Coverage follow-up (from the orchestrator)',
      '',
      'Your previous report ended with VERDICT: PASS but did not account for these changed files, which the diff above does not show in full:',
      '',
      ...missing.map((p) => `- ${p}`),
      '',
      'Read each of them from disk now (the Diff coverage section shows how). Then write your complete report again, with a `## Files reviewed` section naming every one of them and what you found, and end with the VERDICT line. If one of them changes your verdict, say so.',
      '',
      'Your previous report, for reference:',
      '',
      (primary.output ?? '').length > 20_000 ? `${primary.output!.slice(0, 20_000)}\n[previous report truncated]` : (primary.output ?? ''),
    ].join('\n');
    const run = await this.d.runners.launchAgent(task, def, stage, repo, control, { prompt, agentId: primary.unit.agentId!, model: primary.unit.model, effort: primary.unit.effort, cwd: agentWorkdir(task, repo), workUnit: { id: primary.unit.id, key: primary.unit.unitKey, title: primary.unit.title } });
    if (run.kind === 'ok') {
      await this.d.artifacts.write(task.id, { name: `${this.artifactBase(def)}-${primary.planned.key}.md`, type: 'stage-output', content: run.output, stageId: stage.id, stageKey: def.key });
      this.publish(this.d.store.updateWorkUnit(primary.unit.id, { summary: summarize(run.output) }));
    }
    return run;
  }

  // ---------------------------------------------------------------------------
  // One unit
  // ---------------------------------------------------------------------------

  private async runUnit(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl, unit: StageWorkUnit, prompt: string, cwd: string, confine: boolean, slotHeld = false): Promise<AgentRun> {
    const limit = this.runLimit(task);
    if (limit) return { kind: 'failed', errorClass: 'PERMISSION_DENIED', message: limit };
    const release = slotHeld ? () => undefined : await this.slots.acquire(() => control.stopReason !== null);
    if (!release) return { kind: 'stopped', reason: control.stopReason ?? 'cancel' };
    this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'RUNNING', startedAt: now(), finishedAt: null }));
    try {
      return await this.d.runners.launchAgent(task, def, stage, repo, control, {
        prompt,
        agentId: unit.agentId!,
        model: unit.model,
        effort: unit.effort,
        cwd,
        confineTools: confine,
        workUnit: { id: unit.id, key: unit.unitKey, title: unit.title },
      });
    } finally {
      release();
    }
  }

  /**
   * The Chairman's agent-run limit counts every worker (docs/plans/STAGE_TEAMS_PLAN.md §3.10):
   * a supervised team stops starting workers at the limit.
   */
  private runLimit(task: TaskRecord): string | null {
    if (!task.supervised) return null;
    const max = this.d.settings.get().chairman.maxAgentRuns;
    const runs = this.d.store.listExecutions(task.id).filter((e) => e.kind === 'agent').length;
    return runs >= max ? `Agent run limit reached (${runs} of ${max}) while the team was working; no further worker was started` : null;
  }

  /** Record a unit's result: its row, its own artifact, and what the stage needs from it. */
  private async settle(task: TaskRecord, def: StageDefinition, stage: StageInstance, unit: StageWorkUnit, planned: PlannedUnit, run: AgentRun, changes: PathChange[], errorLabel?: string): Promise<UnitResult> {
    const base = { planned, changes, failure: null, stopped: null, questions: [] as string[] };
    if (run.kind === 'stopped') return { ...base, unit: this.settleRow(unit, run), output: null, stopped: run.reason };
    if (run.kind === 'failed') {
      const row = this.publishRow(this.d.store.updateWorkUnit(unit.id, { status: 'FAILED', errorClass: errorLabel ?? run.errorClass, errorMessage: redact(run.message).slice(0, 500), finishedAt: now() }));
      this.d.publisher.event(task.id, 'WORK_UNIT', `${planned.title} failed: ${redact(run.message).slice(0, 200)}`, { workUnitId: unit.id, workUnitKey: planned.key, errorClass: errorLabel ?? run.errorClass }, stage.id);
      return { ...base, unit: row, output: null, failure: { errorClass: run.errorClass, message: `${planned.title}: ${run.message}` } };
    }
    await this.d.artifacts.write(task.id, { name: `${this.artifactBase(def)}-${planned.key}.md`, type: 'stage-output', content: run.output, stageId: stage.id, stageKey: def.key });
    const summary = summarize(run.output);
    const row = this.publishRow(this.d.store.updateWorkUnit(unit.id, { status: 'SUCCESS', summary: changes.length ? `${summary ?? 'Done'} (${changes.length} file${changes.length === 1 ? '' : 's'})` : summary, finishedAt: now() }));
    this.d.publisher.event(task.id, 'WORK_UNIT', `${planned.title} finished${changes.length ? ` · ${changes.length} file${changes.length === 1 ? '' : 's'} changed` : ''}`, { workUnitId: unit.id, workUnitKey: planned.key }, stage.id);
    return { ...base, unit: row, output: run.output, questions: extractOperatorBlockers(run.output) };
  }

  private settleRow(unit: StageWorkUnit, run: AgentRun): StageWorkUnit {
    if (run.kind === 'stopped') return this.publishRow(this.d.store.updateWorkUnit(unit.id, { status: 'CANCELLED', finishedAt: now() }));
    if (run.kind === 'failed') return this.publishRow(this.d.store.updateWorkUnit(unit.id, { status: 'FAILED', errorClass: run.errorClass, errorMessage: redact(run.message).slice(0, 500), finishedAt: now() }));
    return this.publishRow(this.d.store.updateWorkUnit(unit.id, { status: 'SUCCESS', summary: summarize(run.output), finishedAt: now() }));
  }

  // ---------------------------------------------------------------------------
  // Reuse (docs/plans/STAGE_TEAMS_PLAN.md §3.9, §3.12)
  // ---------------------------------------------------------------------------

  /**
   * An earlier successful run of the same read-only unit on the same files and
   * instructions: its report stands. A read-only unit records the tree it read
   * as its base (a unit that writes nothing needs no checkpoint commit).
   */
  private async reusedOutput(task: TaskRecord, stage: StageInstance, unit: StageWorkUnit, hash: string, earlier: StageWorkUnit[]): Promise<string | null> {
    const repo = this.d.store.getRepository(task.repositoryId);
    const tree = repo ? await workingTreeTree(agentWorkdir(task, repo)).catch(() => null) : null;
    if (!tree) return null;
    this.d.store.updateWorkUnit(unit.id, { baseCommit: tree });
    for (const prev of this.candidates(unit, hash, earlier)) {
      if (prev.baseCommit !== tree) continue;
      const content = await this.unitOutput(task, prev);
      if (!content.trim()) continue;
      this.markReused(task, stage, unit, prev);
      return content;
    }
    return null;
  }

  /** An earlier successful write unit whose base had exactly these files: its captured result applies unchanged. */
  private async reusedResult(parent: string, unit: StageWorkUnit, hash: string, earlier: StageWorkUnit[], baseTree: string): Promise<{ output: string; changes: PathChange[] } | null> {
    for (const prev of this.candidates(unit, hash, earlier)) {
      if (!prev.baseCommit || !prev.resultCommit) continue;
      try {
        if ((await treeOf(parent, prev.baseCommit)) !== baseTree) continue;
        const changes = await changedPathsBetween(parent, prev.baseCommit, prev.resultCommit);
        if (changes.some((c) => !pathInScope(c.path, unit.pathScope))) continue;
        const task = this.task(unit.taskId);
        const output = await this.unitOutput(task, prev);
        this.d.store.updateWorkUnit(unit.id, { resultCommit: prev.resultCommit });
        this.markReused(task, this.d.store.getStage(unit.stageId)!, unit, prev);
        return { output: output || prev.summary || 'Reused an earlier result', changes };
      } catch {
        // A result whose objects are gone (refs cleaned) is simply not reusable.
      }
    }
    return null;
  }

  private candidates(unit: StageWorkUnit, hash: string, earlier: StageWorkUnit[]): StageWorkUnit[] {
    return earlier
      .filter((u) => u.unitKey === unit.unitKey && u.kind === 'worker' && u.manifestHash === hash && (u.status === 'SUCCESS' || u.status === 'REUSED') && u.stageId !== unit.stageId)
      .reverse();
  }

  private markReused(task: TaskRecord, stage: StageInstance, unit: StageWorkUnit, prev: StageWorkUnit): void {
    const row = this.d.store.updateWorkUnit(unit.id, {
      status: 'REUSED',
      reusedFrom: prev.reusedFrom ?? prev.id,
      summary: prev.summary,
      startedAt: now(),
      finishedAt: now(),
    });
    this.publish(row);
    this.d.publisher.event(task.id, 'WORK_UNIT', `${unit.title}: reused its earlier result (same files, same instructions)`, { workUnitId: unit.id, reusedFrom: row.reusedFrom }, stage.id);
  }

  /** The latest report an earlier unit wrote: its own artifact `<role>-<unit>.md`, possibly numbered. */
  private async unitOutput(task: TaskRecord, prev: StageWorkUnit): Promise<string> {
    const def = task.workflow.stages.find((s) => s.key === prev.stageKey);
    const stem = `${def ? this.artifactBase(def) : prev.stageKey}-${prev.unitKey}`;
    const found = this.d.store
      .listArtifacts(task.id)
      .filter((a) => a.stageId === prev.stageId && (a.name === `${stem}.md` || (a.name.startsWith(`${stem}-`) && /^-\d+\.md$/.test(a.name.slice(stem.length)))))
      .at(-1);
    if (!found) return '';
    return (await this.d.artifacts.read(found).catch(() => ({ content: '' }))).content;
  }

  // ---------------------------------------------------------------------------
  // Aggregation and outcomes
  // ---------------------------------------------------------------------------

  /** One bounded report for the stage, under the role's usual artifact, so later stages read the team as one. */
  private async writeAggregate(task: TaskRecord, def: StageDefinition, stage: StageInstance, results: UnitResult[], lead: string | null = null): Promise<string> {
    const withOutput = results.filter((r) => r.output);
    if (!withOutput.length && !lead) return '';
    const parts = [`# ${def.name} — team of ${results.length}`, ''];
    if (lead) parts.push('## Integration (lead)', '', lead, '');
    for (const r of withOutput) {
      const agent = this.d.agents.has(r.unit.agentId ?? '') ? this.d.agents.adapter(r.unit.agentId!).displayName : (r.unit.agentId ?? 'agent');
      const text = r.output!.length > MAX_WORKER_IN_AGGREGATE ? `${r.output!.slice(0, MAX_WORKER_IN_AGGREGATE)}\n\n[truncated — the full report is ${this.artifactBase(def)}-${r.planned.key}.md]` : r.output!;
      parts.push(`## ${r.planned.title} (${agent}${r.planned.primary ? ', primary' : ''}${r.unit.status === 'REUSED' ? ', reused' : ''})`, '', text, '');
    }
    const content = parts.join('\n');
    const artifact = ROLE_ARTIFACT[def.role] ?? { type: 'stage-output' as const, name: `${def.key}.md` };
    await this.d.artifacts.write(task.id, { name: artifact.name, type: artifact.type, content, stageId: stage.id, stageKey: def.key });
    return content;
  }

  private failTeam(stage: StageInstance, failed: UnitResult[], total: number, write: boolean): StageOutcome {
    const blocking = failed.find((f) => BLOCKING.includes(f.failure!.errorClass));
    const chosen = blocking ?? failed[0]!;
    const note = `${failed.length} of ${total} work unit${total === 1 ? '' : 's'} failed${write ? '; nothing from this wave was integrated' : ''}`;
    return this.d.runners.failStage(stage, chosen.failure!.errorClass, `${chosen.failure!.message} (${note})`);
  }

  private stopAll(stage: StageInstance, rows: Map<string, StageWorkUnit>, reason: StopReason): StageOutcome {
    for (const row of rows.values()) {
      const current = this.d.store.getWorkUnit(row.id);
      if (current && (current.status === 'QUEUED' || current.status === 'RUNNING')) this.publish(this.d.store.updateWorkUnit(row.id, { status: 'CANCELLED', finishedAt: now() }));
    }
    return { kind: 'stopped', stageId: stage.id, reason };
  }

  private markRemaining(rows: Map<string, StageWorkUnit>, pending: PlannedUnit[], status: 'SKIPPED' | 'CANCELLED', why: string): void {
    for (const p of pending) {
      const row = rows.get(p.key);
      const current = row ? this.d.store.getWorkUnit(row.id) : null;
      if (current && current.status === 'QUEUED') this.publish(this.d.store.updateWorkUnit(current.id, { status, errorMessage: why, finishedAt: now() }));
    }
  }

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------

  private unitSection(def: StageDefinition, p: PlannedUnit, others: PlannedUnit[], write: boolean): string {
    const lines = ['', '', '## Your work unit (Stage Team, from the orchestrator)', ''];
    lines.push(`The Control Center runs this stage as a team of workers side by side. You are one of them: do only your unit; the others are done by other workers at the same time.`, '');
    lines.push(`- Unit: ${p.title} (key: ${p.key})`);
    if (p.goal) lines.push(`- Goal: ${p.goal}`);
    else lines.push(`- Focus: ${p.focus}`);
    if (others.length) lines.push(`- Other workers: ${others.map((o) => `${o.title}${o.pathScope.length ? ` (${o.pathScope.join(', ')})` : ''}`).join('; ')}`);
    if (write) {
      lines.push(`- Paths you own: ${p.pathScope.join(', ')}`);
      if (p.checks.length) lines.push(`- Checks for your change: ${p.checks.map((k) => COMMAND_KIND_LABEL[k as keyof typeof COMMAND_KIND_LABEL] ?? k).join(', ')} — only the tests for the files you changed`);
      lines.push(
        '',
        'Rules:',
        '- Change files only under the paths you own. A change anywhere else fails your unit and discards all of its work.',
        '- This working directory is your own checkout; the Control Center integrates your changes. Do not commit, push, reset or create branches.',
        '- Installed dependencies are shared with the task: do not install, add or remove packages. If your unit needs a new dependency, say so in your report.',
      );
    }
    if (def.verdict) {
      lines.push(
        p.primary
          ? '- You are the primary reviewer: your report must account for every changed file (see Diff coverage), and your VERDICT counts for the whole change.'
          : `- You are a specialist reviewer: concentrate on ${p.focus}. End with your own VERDICT line; any FAIL sends the change back.`,
      );
    }
    lines.push('- Never start other agents or sub-agents.', `- Write your ${ROLE_LABEL[def.role].toLowerCase()} report for your unit only.`);
    return lines.join('\n');
  }

  private artifactBase(def: StageDefinition): string {
    return (ROLE_ARTIFACT[def.role]?.name ?? `${def.key}.md`).replace(/\.md$/, '');
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  private refPrefix(task: TaskRecord): string {
    return `refs/acc/team/${task.id}/`;
  }

  private async removeChild(parent: string, dir: string, links: string[]): Promise<void> {
    unlinkDependencies(links.length ? links : findLinks(dir));
    await removeWorktree(parent, dir, { force: true }).catch(() => false);
  }

  /**
   * A finished or cancelled task keeps no team leftovers: its hidden result
   * refs and any child checkout folder (only under this runner's own root).
   */
  async cleanupTask(task: TaskRecord): Promise<void> {
    for (const unit of taskRepositories(this.d.store, task)) await deleteRefs(unit.repo.path, this.refPrefix(task)).catch(() => 0);
    const dir = path.join(this.root(), task.id);
    if (existsSync(dir)) {
      for (const child of await readdir(dir).catch(() => [] as string[])) unlinkDependencies(findLinks(path.join(dir, child)));
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => undefined);
    }
  }

  /**
   * After a restart no worker is alive: every child checkout left behind is
   * partial and never integrated. Its shared-dependency links are removed
   * first (never followed), then the folder, then each repository forgets it.
   */
  async sweep(repositories: RepositoryRecord[]): Promise<number> {
    const root = this.root();
    if (!existsSync(root)) return 0;
    let removed = 0;
    for (const taskDir of await readdir(root).catch(() => [] as string[])) {
      for (const child of await readdir(path.join(root, taskDir)).catch(() => [] as string[])) {
        unlinkDependencies(findLinks(path.join(root, taskDir, child)));
        removed++;
      }
      await rm(path.join(root, taskDir), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => undefined);
    }
    if (removed) for (const repo of repositories) if (existsSync(repo.path)) await git(repo.path, ['worktree', 'prune']).catch(() => null);
    return removed;
  }

  private task(id: string): TaskRecord {
    return this.d.store.getTask(id)!;
  }

  private blankUnit(task: TaskRecord, def: StageDefinition, stage: StageInstance, key: string, kind: StageWorkUnit['kind'], title: string, focus: string): StageWorkUnit {
    return {
      id: newId(),
      taskId: task.id,
      stageId: stage.id,
      stageKey: def.key,
      unitKey: key,
      kind,
      title,
      focus,
      status: 'QUEUED',
      ordinal: -1,
      dependencies: [],
      pathScope: [],
      primary: false,
      manifestHash: null,
      baseCommit: null,
      resultCommit: null,
      agentId: null,
      model: null,
      effort: null,
      attempt: 1,
      reusedFrom: null,
      summary: null,
      errorClass: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now(),
    };
  }

  private publishRow(unit: StageWorkUnit): StageWorkUnit {
    this.publish(unit);
    return unit;
  }

  private publish(unit: StageWorkUnit): void {
    this.d.bus.publish({ type: 'workUnit', workUnit: unit });
  }
}

/** Replace every spelling of the task's folder in a prompt with the worker's own checkout. */
export function rewritePaths(prompt: string, from: string, to: string): string {
  const variants = new Set([from, path.resolve(from), from.replace(/\\/g, '/'), path.resolve(from).replace(/\\/g, '/')]);
  let out = prompt;
  for (const v of [...variants].sort((a, b) => b.length - a.length)) if (v) out = out.split(v).join(to);
  return out;
}

/**
 * Share the task's installed dependency folders with a child checkout by
 * directory links (junctions on Windows), so a worker can run its targeted
 * checks. Returns the links made; they are removed — never followed — before
 * the checkout is deleted.
 */
export function linkDependencies(source: string, child: string): string[] {
  const links: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(path.join(source, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git') continue;
      const next = rel ? path.join(rel, e.name) : e.name;
      if (e.name === 'node_modules') {
        const target = path.join(child, next);
        if (existsSync(path.dirname(target)) && !existsSync(target) && links.length < 200) {
          try {
            symlinkSync(path.join(source, next), target, process.platform === 'win32' ? 'junction' : 'dir');
            links.push(target);
          } catch {
            /* a folder that cannot be linked is simply not shared */
          }
        }
        continue;
      }
      if (e.name.startsWith('.') || depth >= DEPENDENCY_DEPTH) continue;
      walk(next, depth + 1);
    }
  };
  walk('', 0);
  return links;
}

/** Directory links inside a child checkout (at the depths `linkDependencies` makes them). */
function findLinks(child: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        out.push(full);
        continue;
      }
      if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules' && depth < DEPENDENCY_DEPTH) walk(full, depth + 1);
    }
  };
  walk(child, 0);
  return out;
}

function unlinkDependencies(links: string[]): void {
  for (const link of links) {
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      /* already gone */
    }
  }
}
