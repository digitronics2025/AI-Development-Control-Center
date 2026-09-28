import { existsSync, lstatSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  addChildWorktree,
  applyIfUnchanged,
  captureResult,
  changedPathsBetween,
  combineResults,
  committableTree,
  createWaveBase,
  deleteRefs,
  git,
  removeWorktree,
  treeOf,
  type PathChange,
  type WaveBase,
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
  type StageStatus,
  type StageWorkUnit,
  type WorkUnitKind,
  type WorkUnitManifestUnit,
  isJudgeRole,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import { limitReached } from '../chairman/policy.js';
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
 * disposable detached checkout of a hidden commit of it (as a commit would
 * record its files, so line endings look as they do in the task); their
 * results are captured as hidden commits, checked against the paths they own,
 * combined, and written back only while the task's files still equal the
 * wave's base. Whenever a team cannot run safely, `run` returns null and the
 * stage runs as one agent, exactly as without a team.
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
  /** Only for the start-up sweep of `<dataDir>/team-worktrees`, where checkouts were made before the work root existed. */
  dataDir: string;
  /** Checkouts are made under `<workDir>/team-worktrees`, outside the data folder (SEC-3). */
  workDir: string;
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
  /** Its changes are already in the task's files (an interrupted run integrated them): nothing to write, but they count as integrated. */
  alreadyIntegrated?: boolean;
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
/** Unit titles in timelines and events are kept to this many characters. */
const MAX_TITLE = 60;
/** One unit's line in the stage summary, and the whole summary, are kept within these. */
const MAX_UNIT_SUMMARY = 100;
const MAX_STAGE_SUMMARY = 500;
/** A stage run that was stopped before it finished — parked at a limit or rerouted, paused, cut off by a restart — rather than failed. */
const STOPPED: readonly StageStatus[] = ['CANCELLED', 'PAUSED', 'INTERRUPTED'];
/** A stage run that ended without finishing, for whatever reason; what it integrated may already be in the task. */
const UNFINISHED: readonly StageStatus[] = [...STOPPED, 'FAILED'];
const DECOMPOSE_FOCUS = 'Read-only: split the failures into independent repairs';
const JUDGE_FOCUS = 'Read-only: compare the variants and keep one';
/** What a judge is shown of each variant: its report, and (write stages) its diff, within these. */
const MAX_JUDGE_REPORT = 12_000;
const MAX_JUDGE_DIFF = 40_000;
const MAX_JUDGE_DIFF_TOTAL = 100_000;

/** A write wave that ran: its units, and the base they started from. */
interface WriteWave {
  results: UnitResult[];
  base: WaveBase;
}

/** A run the team needed but the task's own limits did not allow (see `limitFor`). */
interface LimitHit {
  kind: 'limit';
  message: string;
}

/** The integration pass's report and whose it is. */
interface LeadReport {
  output: string;
  agentId: string | null;
}

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

  /** Where write workers' disposable checkouts live; only this folder (and its old place in the data folder, at start) is ever swept. */
  root(): string {
    return path.join(this.d.workDir, 'team-worktrees');
  }

  /**
   * Run `def` as its team. Returns null to run the stage as one agent (with an
   * event saying why): a team that cannot be planned is an optimisation that
   * did not apply, never a task failure.
   */
  async run(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl): Promise<StageOutcome | null> {
    const team = def.team;
    if (!team || def.kind !== 'agent') return null;
    // The stage clock starts before planning: a decomposition run is part of the stage's wall time.
    const startedMs = Date.now();
    if (def.permissionLevel >= 4) return this.fallback(task, def, stage, 'staging and production stages never run as a team');
    const write = def.permissionLevel >= 2;
    // Variants: every worker does the whole stage its own way; a judge keeps one (docs/plans/stage-team-variants.md).
    const variants = team.mode === 'variants';
    if (write) {
      if (isMultiRepository(this.d.store, task)) return this.fallback(task, def, stage, 'a team that changes files across several repositories is not supported yet');
      if (!task.git.isolated || !task.git.worktreePath) return this.fallback(task, def, stage, 'the task does not run in an isolated worktree, so parallel writers cannot be kept apart');
      if (team.mode === 'fixed') return this.fallback(task, def, stage, 'a fixed team runs only on a read-only stage');
    }

    let planned: PlannedUnit[];
    let fingerprint: unknown;
    if (team.mode === 'fixed' || variants) {
      planned = (team.workers ?? []).map((w) => ({
        key: w.key,
        title: clipTitle(w.focus),
        focus: w.focus,
        goal: null,
        dependsOn: [],
        pathScope: [],
        checks: [],
        primary: w.primary,
        ...this.assignment(task, def, stage, w),
      }));
      if (planned.length < 2) return this.fallback(task, def, stage, variants ? 'variants need at least two workers' : 'a fixed team needs at least two workers');
      fingerprint = { stage: def.key, team };
    } else {
      const manifest = await this.manifestFor(task, def, stage, repo, control);
      if (manifest.kind === 'stopped') return { kind: 'stopped', stageId: stage.id, reason: manifest.reason };
      if (manifest.kind === 'limit') return this.parkAtLimit(task, def, stage, new Map(), [], [], manifest.message);
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
      planned = units.map((u) => ({ key: u.key, title: clipTitle(u.title), focus: u.goal, goal: u.goal, dependsOn: u.dependsOn, pathScope: write ? u.pathPrefixes : [], checks: u.checks, primary: false, ...base }));
      fingerprint = { stage: def.key, manifest: manifest.hash };
    }
    const hash = stableHash({ fingerprint, directives: this.directiveIds(task), permissionLevel: def.permissionLevel });
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
      variants
        ? `${def.name} runs as ${planned.length} competing variants (${write ? 'each in its own checkout' : 'read-only, side by side'}, at most ${cap} at once); a judge keeps one: ${planned.map((p) => p.title).join(', ')}`
        : `${def.name} runs as a team of ${planned.length} (${write ? 'each in its own checkout' : 'read-only, side by side'}, at most ${cap} at once): ${planned.map((p) => p.title).join(', ')}`,
      { mode: team.mode, units: planned.map((p) => p.key), maxWorkers: cap, write },
      stage.id,
    );

    const results: UnitResult[] = [];
    const done = new Set<string>();
    let integratedUnits = 0;
    let wave = 0;
    let coverage: PromptCoverage = { required: [], all: [] };
    let pending = [...planned];
    // Variants are integrated only after the judge: each result remembers the base it started from.
    const variantBases = new Map<string, { base: WaveBase; wave: number }>();
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
      // The last wave of a write team also reserves the lead's integration pass (variants: the judge) that follows it.
      const reserve = write && batch.length === pending.length ? 1 : 0;
      const waveResults = write
        ? await this.writeWave(task, def, stage, repo, control, batch, rows, built.prompt, others, hash, earlier, wave, reserve, variants)
        : await this.readWave(task, def, stage, repo, control, batch, rows, built.prompt, others, hash, earlier, variants);
      if ('outcome' in waveResults) return waveResults.outcome;
      if ('kind' in waveResults) return this.parkAtLimit(task, def, stage, rows, pending, results, waveResults.message);
      results.push(...waveResults.results);
      pending = pending.filter((p) => !batch.includes(p));

      const stopped = waveResults.results.find((r) => r.stopped);
      if (stopped || control.stopReason) return this.stopAll(stage, rows, control.stopReason ?? stopped!.stopped!);
      const questions = waveResults.results.flatMap((r) => r.questions);
      if (questions.length && !isJudgeRole(def.role)) {
        this.markRemaining(rows, pending, 'CANCELLED', 'A worker needs your decision first');
        await this.writeAggregate(task, def, stage, results);
        this.d.publisher.updateStage(stage.id, { status: 'PAUSED', summary: summarize(questions.join('\n')), finishedAt: now() });
        return { kind: 'needs_operator', stageId: stage.id, questions };
      }
      const failed = waveResults.results.filter((r) => r.failure);
      // A failed variant is one approach fewer, not a failed stage: the judge decides once every variant ran.
      if (failed.length && !variants) {
        this.markRemaining(rows, pending, 'SKIPPED', 'An earlier work unit failed');
        await this.writeAggregate(task, def, stage, results);
        return this.failTeam(stage, failed, waveResults.results.length, write);
      }
      if (variants) {
        if (waveResults.base) for (const r of waveResults.results) variantBases.set(r.planned.key, { base: waveResults.base, wave });
      } else if (waveResults.base) {
        const integration = await this.integrate(task, def, stage, waveResults.results, wave, waveResults.base);
        if (integration.kind === 'failed') {
          this.markRemaining(rows, pending, 'SKIPPED', 'The team could not integrate an earlier wave');
          await this.writeAggregate(task, def, stage, results);
          return this.d.runners.failStage(stage, 'UNKNOWN', integration.message);
        }
        // A unit an interrupted run already integrated counts too: the lead still reconciles it with the rest.
        integratedUnits += integration.units + waveResults.results.filter((r) => r.alreadyIntegrated).length;
      }
      for (const r of waveResults.results) done.add(r.planned.key);
    }
    if (pending.length) {
      this.markRemaining(rows, pending, 'SKIPPED', 'Its dependencies did not finish');
      return this.d.runners.failStage(stage, 'UNKNOWN', `${def.name}: ${pending.length} work unit(s) could not start because their dependencies did not finish`);
    }

    if (variants) return this.finishVariants(task, def, stage, repo, control, rows, results, variantBases, write, startedMs);

    // Several writers' patches can each be right and still not fit together: one short lead pass reconciles them.
    let lead: LeadReport | null = null;
    if (write && integratedUnits >= 2) {
      const pass = await this.integrationPass(task, def, stage, repo, control, results);
      if (pass.kind === 'stopped') return { kind: 'stopped', stageId: stage.id, reason: pass.reason };
      if (pass.kind === 'limit') return this.parkAtLimit(task, def, stage, rows, [], results, pass.message);
      if (pass.kind === 'failed') {
        await this.writeAggregate(task, def, stage, results);
        return this.d.runners.failStage(stage, pass.errorClass, `Integration pass: ${pass.message}`);
      }
      lead = pass.lead;
    }

    await this.writeAggregate(task, def, stage, results, lead);
    let verdict: 'PASS' | 'FAIL' | null = null;
    const failedBy: string[] = [];
    if (def.verdict || isJudgeRole(def.role)) {
      const verdicts = results.map((r) => ({ r, v: parseVerdict(r.output ?? '') }));
      const missing = verdicts.filter((x) => !x.v);
      if (def.verdict && missing.length) {
        return this.d.runners.failStage(stage, 'UNKNOWN', `${missing.map((x) => x.r.planned.title).join(', ')} did not end with "VERDICT: PASS" or "VERDICT: FAIL"`);
      }
      failedBy.push(...verdicts.filter((x) => x.v === 'FAIL').map((x) => x.r.planned.title));
      verdict = failedBy.length ? 'FAIL' : verdicts.some((x) => x.v === 'PASS') ? 'PASS' : null;
      if (def.verdict && verdict === 'PASS') {
        // A PASS counts only when the primary reviewer accounted for every changed file the diff did not show (AUTOPILOT_GATES_PLAN §3.A).
        const primary = results.find((r) => r.planned.primary) ?? results[0]!;
        const gaps = unreviewedFiles(primary.output ?? '', coverage);
        if (gaps.length) {
          const retried = await this.coverageFollowUp(task, def, stage, repo, control, primary, gaps);
          if (retried.kind === 'stopped') return { kind: 'stopped', stageId: stage.id, reason: retried.reason };
          if (retried.kind === 'limit') return this.parkAtLimit(task, def, stage, rows, [], results, retried.message);
          if (retried.kind === 'failed') return this.d.runners.failStage(stage, retried.errorClass, retried.message);
          // The stage's report carries the follow-up, as a single reviewer's second report replaces its first.
          primary.output = retried.output;
          await this.writeAggregate(task, def, stage, results, lead);
          const again = parseVerdict(retried.output);
          if (!again) return this.d.runners.failStage(stage, 'UNKNOWN', `${primary.planned.title} did not end its follow-up with a VERDICT line`);
          if (again === 'FAIL') {
            verdict = 'FAIL';
            failedBy.push(primary.planned.title);
          } else {
            const still = unreviewedFiles(retried.output, coverage);
            if (still.length) return this.d.runners.failStage(stage, 'REVIEW_INCOMPLETE', `${def.name} (primary reviewer) gave PASS twice without reviewing ${still.length} changed file${still.length === 1 ? '' : 's'} the diff did not show: ${still.slice(0, 20).join(', ')}${still.length > 20 ? ', …' : ''}`);
          }
        }
      }
    }

    const time = this.agentTime(task, stage);
    const teamData = {
      workers: results.length,
      reused: results.filter((r) => r.unit.status === 'REUSED').length,
      wallMs: Date.now() - startedMs,
      agentMs: time.worker ?? 0,
      decomposeMs: time.decomposer ?? null,
      integrationMs: time.integration ?? null,
      integrated: integratedUnits,
    };
    return this.d.runners.completeAgentStage(task, def, stage, this.stageSummary(results, lead), verdict, teamData.wallMs, { team: teamData }, failedBy);
  }

  // ---------------------------------------------------------------------------
  // Variants (docs/plans/stage-team-variants.md)
  // ---------------------------------------------------------------------------

  /**
   * Every variant ran: keep one. A lone survivor wins as it is; otherwise a
   * read-only judge compares them. Only the winner reaches the task (write) or
   * becomes the stage's report (read); the others stay as their units' reports
   * and hidden refs, marked not chosen.
   */
  private async finishVariants(
    task: TaskRecord,
    def: StageDefinition,
    stage: StageInstance,
    repo: RepositoryRecord,
    control: RunControl,
    rows: Map<string, StageWorkUnit>,
    results: UnitResult[],
    bases: Map<string, { base: WaveBase; wave: number }>,
    write: boolean,
    startedMs: number,
  ): Promise<StageOutcome> {
    const candidates = results.filter((r) => !r.failure);
    const failed = results.filter((r) => r.failure);
    if (!candidates.length) {
      await this.writeAggregate(task, def, stage, results);
      return this.failTeam(stage, failed, results.length, write);
    }
    let winner: UnitResult;
    let judge: LeadReport | null = null;
    if (candidates.length === 1) {
      winner = candidates[0]!;
      this.d.publisher.event(task.id, 'STAGE_TEAM', `${def.name}: only ${winner.planned.title} finished, so it is kept without judging`, { winner: winner.planned.key, failed: failed.map((f) => f.planned.key) }, stage.id);
    } else {
      const judged = await this.judgeVariants(task, def, stage, repo, control, candidates, bases, write);
      if (judged.kind === 'stopped') return { kind: 'stopped', stageId: stage.id, reason: judged.reason };
      if (judged.kind === 'limit') return this.parkAtLimit(task, def, stage, rows, [], results, judged.message);
      if (judged.kind === 'failed') {
        await this.writeAggregate(task, def, stage, results);
        return this.d.runners.failStage(stage, judged.errorClass, `Judge: ${judged.message}`);
      }
      winner = judged.winner;
      judge = judged.lead;
    }
    if (write) {
      const at = bases.get(winner.planned.key);
      const integration = at ? await this.integrate(task, def, stage, [winner], at.wave, at.base) : { kind: 'failed' as const, message: `${winner.planned.title} has no recorded starting point` };
      if (integration.kind === 'failed') {
        await this.writeAggregate(task, def, stage, results);
        return this.d.runners.failStage(stage, 'UNKNOWN', integration.message);
      }
    }
    for (const r of candidates) {
      if (r === winner) continue;
      const row = this.d.store.getWorkUnit(r.unit.id);
      this.publish(this.d.store.updateWorkUnit(r.unit.id, { summary: clipText(`Not chosen: ${row?.summary ?? 'done'}`, MAX_STAGE_SUMMARY) }));
    }
    await this.writeVariantAggregate(task, def, stage, winner, judge, results);
    const time = this.agentTime(task, stage);
    const teamData = {
      workers: results.length,
      reused: results.filter((r) => r.unit.status === 'REUSED').length,
      wallMs: Date.now() - startedMs,
      agentMs: time.worker ?? 0,
      decomposeMs: null,
      integrationMs: null,
      integrated: write && winner.changes.length ? 1 : 0,
      variants: { chosen: winner.planned.key, finished: candidates.length, judgeMs: time.judge ?? null },
    };
    const summary = clipText(
      `${results.length} variants${failed.length ? ` (${failed.length} failed)` : ''}; kept ${winner.planned.title}: ${clipText(this.d.store.getWorkUnit(winner.unit.id)?.summary ?? summarize(winner.output ?? '') ?? 'done', MAX_UNIT_SUMMARY)}`,
      MAX_STAGE_SUMMARY,
    );
    return this.d.runners.completeAgentStage(task, def, stage, summary, null, teamData.wallMs, { team: teamData });
  }

  /** One read-only (Level 1) judge run over the finished variants; it must name one of them. */
  private async judgeVariants(
    task: TaskRecord,
    def: StageDefinition,
    stage: StageInstance,
    repo: RepositoryRecord,
    control: RunControl,
    candidates: UnitResult[],
    bases: Map<string, { base: WaveBase; wave: number }>,
    write: boolean,
  ): Promise<{ kind: 'ok'; winner: UnitResult; lead: LeadReport } | Exclude<AgentRun, { kind: 'ok' }> | LimitHit> {
    let built;
    try {
      built = await this.d.context.build(this.task(task.id), def, stage);
    } catch (error) {
      return { kind: 'failed', errorClass: 'CONTEXT_FAILURE', message: `Context could not be built: ${(error as Error).message}` };
    }
    const pin = def.team?.judge ?? {};
    const unit = this.d.store.insertWorkUnit({
      ...this.blankUnit(task, def, stage, 'judge', 'judge', 'Judge', JUDGE_FOCUS),
      ...this.assignment(task, def, stage, pin),
      ordinal: candidates.length + 1,
      dependencies: candidates.map((r) => r.planned.key),
    });
    this.publish(unit);
    const limit = this.limitFor(task, def, 1);
    if (limit) {
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'CANCELLED', errorMessage: 'Not started: the task reached its agent run limit', finishedAt: now() }));
      return { kind: 'limit', message: limit };
    }
    const parent = task.git.worktreePath;
    const sections: string[] = [];
    let diffBudget = MAX_JUDGE_DIFF_TOTAL;
    for (const r of candidates) {
      const report = r.output ?? '';
      sections.push(`### Variant \`${r.planned.key}\`: ${r.planned.title}`, '', `- Approach: ${r.planned.focus}`, `- Agent: ${this.agentName(r.unit.agentId)}${r.unit.model ? ` (${r.unit.model})` : ''}`);
      if (write) {
        sections.push(`- Changed files (${r.changes.length}): ${r.changes.slice(0, 50).map((c) => c.path).join(', ') || 'none'}${r.changes.length > 50 ? ', …' : ''}`);
        const at = bases.get(r.planned.key);
        const result = this.d.store.getWorkUnit(r.unit.id)?.resultCommit;
        if (parent && at && result && r.changes.length && diffBudget > 0) {
          const diff = await git(parent, ['diff', '--no-color', '--no-ext-diff', '--stat', '--patch', at.base.commit, result]).then((d) => (d.code === 0 ? redact(d.stdout) : '')).catch(() => '');
          const shown = diff.slice(0, Math.min(MAX_JUDGE_DIFF, diffBudget));
          diffBudget -= shown.length;
          if (shown) sections.push('', '```diff', shown, diff.length > shown.length ? `[diff truncated: ${diff.length - shown.length} more characters]` : '', '```');
        }
      }
      sections.push('', 'Its report:', '', report.length > MAX_JUDGE_REPORT ? `${report.slice(0, MAX_JUDGE_REPORT)}\n[report truncated]` : report || '(no report)', '');
    }
    const prompt = [
      built.prompt.replace(/^Role: [\w-]+$/m, 'Role: judge'),
      '',
      '## Judge the variants (from the orchestrator)',
      '',
      `The Control Center ran this stage as ${candidates.length} competing variants, each doing the whole stage its own way${write ? ' in its own checkout' : ''}. Only the one you choose is kept${write ? ' and written into the task' : ' as the stage\'s result'}; the others are discarded.`,
      '',
      'Do not change any file. Compare the variants against the request, the plan, the repository\'s rules and design standard, and what each one verified. Weigh correctness and completeness first, then quality and fit; a variant that skipped checks or broke a rule loses to one that did not. Open the screenshots listed above when the variants kept any.',
      '',
      ...sections,
      'End with your reasons in a few lines, then exactly one line `WINNER: <key>` naming one of the variants above by its key.',
    ].join('\n');
    await this.savePrompt(task, def, stage, `${this.promptBase(def)}-judge.md`, prompt);
    const release = await this.slots.acquire(() => control.stopReason !== null);
    if (!release) {
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'CANCELLED', finishedAt: now() }));
      return { kind: 'stopped', reason: control.stopReason ?? 'cancel' };
    }
    this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'RUNNING', startedAt: now() }));
    let run: AgentRun;
    try {
      run = await this.d.runners.launchAgent(task, def, stage, repo, control, { prompt, agentId: unit.agentId!, model: unit.model, effort: unit.effort, cwd: agentWorkdir(task, repo), permissionLevel: 1, workUnit: { id: unit.id, key: unit.unitKey, title: unit.title } });
    } finally {
      release();
    }
    if (run.kind !== 'ok') {
      this.settleRow(unit, run);
      this.unitEvent(task, stage, unit, run.kind === 'stopped' ? 'stopped' : `failed: ${redact(run.message).slice(0, 200)}`, run.kind === 'failed' ? { errorClass: run.errorClass } : {});
      return run;
    }
    await this.d.artifacts.write(task.id, { name: `${this.artifactBase(def)}-judge.md`, type: 'stage-output', content: run.output, stageId: stage.id, stageKey: def.key });
    const named = parseWinner(run.output);
    const winner = candidates.find((r) => r.planned.key === named);
    if (!winner) {
      const message = named ? `named "${named}", which is not one of the finished variants (${candidates.map((r) => r.planned.key).join(', ')})` : 'did not end with a "WINNER: <key>" line';
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'FAILED', errorClass: 'UNKNOWN', errorMessage: message, finishedAt: now() }));
      return { kind: 'failed', errorClass: 'UNKNOWN', message: `the judge ${message}` };
    }
    this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'SUCCESS', summary: clipText(`Chose ${winner.planned.title}: ${summarize(run.output) ?? ''}`, MAX_STAGE_SUMMARY), finishedAt: now() }));
    this.unitEvent(task, stage, unit, `chose ${winner.planned.title}`, { winner: winner.planned.key });
    return { kind: 'ok', winner, lead: { output: run.output, agentId: unit.agentId } };
  }

  /** The stage's report: the kept variant's own report, with the judge's reasons and the others named. */
  private async writeVariantAggregate(task: TaskRecord, def: StageDefinition, stage: StageInstance, winner: UnitResult, judge: LeadReport | null, results: UnitResult[]): Promise<void> {
    const others = results.filter((r) => r !== winner).map((r) => `${r.planned.title}${r.failure ? ' (failed)' : ''}`);
    const report = winner.output ?? '';
    const parts = [
      report.length > MAX_WORKER_IN_AGGREGATE ? `${report.slice(0, MAX_WORKER_IN_AGGREGATE)}\n\n[truncated — the full report is ${this.artifactBase(def)}-${winner.planned.key}.md]` : report,
      '',
      `## Variant kept: ${winner.planned.title} (${this.agentName(winner.unit.agentId)})`,
      '',
      `Kept over: ${others.join(', ') || 'none'}. Their reports are ${results.filter((r) => r !== winner).map((r) => `${this.artifactBase(def)}-${r.planned.key}.md`).join(', ') || 'none'}.`,
    ];
    if (judge) parts.push('', `### Judge (${this.agentName(judge.agentId)})`, '', judge.output);
    const artifact = ROLE_ARTIFACT[def.role] ?? { type: 'stage-output' as const, name: `${def.key}.md` };
    await this.d.artifacts.write(task.id, { name: artifact.name, type: artifact.type, content: parts.join('\n'), stageId: stage.id, stageKey: def.key });
  }

  /** What a variant is told: the whole stage, its own approach, and that only one variant is kept. */
  private variantSection(def: StageDefinition, p: PlannedUnit, others: PlannedUnit[], write: boolean): string {
    const lines = ['', '', '## Your variant (Stage Team, from the orchestrator)', ''];
    lines.push(`The Control Center runs this stage as ${others.length + 1} competing variants: each does the whole stage its own way, and a judge keeps only one. Do the complete work, not a part of it.`, '');
    lines.push(`- Unit: ${p.title} (key: ${p.key})`, `- Your approach: ${p.focus}`);
    if (others.length) lines.push(`- Other variants: ${others.map((o) => o.title).join('; ')}`);
    if (write) {
      lines.push(
        '',
        'Rules:',
        '- This working directory is your own checkout of the whole repository; the Control Center writes the chosen variant into the task. Do not commit, push, reset or create branches.',
        '- Installed dependencies are shared with the task: do not install, add or remove packages. If your variant needs a new dependency, say so in your report.',
        '- Run the checks for what you changed and report them plainly: the judge weighs what you verified.',
      );
    }
    lines.push('- Never start other agents or sub-agents.', `- Write your ${ROLE_LABEL[def.role].toLowerCase()} report for your variant.`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  /** Directives change what a worker is told, so a result from before one is not reused. */
  private directiveIds(task: TaskRecord): string[] {
    return this.d.store.listDirectives(task.id).filter((d) => d.state === 'active' && d.kind !== 'routing').map((d) => d.id);
  }

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
  ): Promise<{ kind: 'units'; units: WorkUnitManifestUnit[]; hash: string } | { kind: 'none'; reason: string } | { kind: 'stopped'; reason: StopReason } | LimitHit> {
    if (def.role !== 'fixer') {
      const plan = await this.d.artifacts.latestText(task.id, 'plan');
      if (!plan) return { kind: 'none', reason: 'there is no plan to take work units from' };
      const read = readManifest(plan, def.key);
      return read.ok ? { kind: 'units', units: read.manifest.units, hash: read.hash } : { kind: 'none', reason: read.reason };
    }
    return this.decompose(task, def, stage, repo, control);
  }

  private async decompose(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl): Promise<{ kind: 'units'; units: WorkUnitManifestUnit[]; hash: string } | { kind: 'none'; reason: string } | { kind: 'stopped'; reason: StopReason } | LimitHit> {
    // What the split was asked with: a directive changes it, so a split from before one is not reused.
    const key = stableHash({ stage: def.key, directives: this.directiveIds(task), permissionLevel: def.permissionLevel });
    const split = await this.reusedSplit(task, def, stage, key);
    if (split) return split;
    let built;
    try {
      built = await this.d.context.build(task, def, stage);
    } catch (error) {
      return { kind: 'none', reason: `the failure could not be read for decomposition (${(error as Error).message})` };
    }
    const unit = this.d.store.insertWorkUnit({
      ...this.blankUnit(task, def, stage, 'decompose', 'decomposer', 'Split the fix', DECOMPOSE_FOCUS),
      ...this.assignment(task, def, stage),
      manifestHash: key,
    });
    this.publish(unit);
    const limit = this.limitFor(task, def, 1);
    if (limit) {
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'CANCELLED', errorMessage: 'Not started: the task reached its agent run limit', finishedAt: now() }));
      return { kind: 'limit', message: limit };
    }
    const prompt = [
      built.prompt.replace(/^Role: [\w-]+$/m, 'Role: decomposer'),
      '',
      '## Decomposition only (from the orchestrator)',
      '',
      'Do not change any file. Read the failures above and decide whether they need two or more repairs that are genuinely independent: different files, no shared interface, each verifiable on its own. Prefer ONE unit whenever the repairs touch the same code or depend on each other — splitting is only worth it for truly separate work.',
      '',
      `End your answer with exactly one fenced block tagged \`acc-work-units\` holding JSON: {"version":1,"stage":"${def.key}","units":[{"key":"slug","title":"short title","goal":"what to repair","dependsOn":[],"pathPrefixes":["repository/relative/folder/"],"checks":["test"]}]}. Path prefixes are repository-relative folders or files each unit alone may change; units that may run together must not share any.`,
    ].join('\n');
    await this.savePrompt(task, def, stage, `${def.key}-decomposition-prompt.md`, prompt);
    const release = await this.slots.acquire(() => control.stopReason !== null);
    if (!release) {
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'CANCELLED', finishedAt: now() }));
      return { kind: 'stopped', reason: control.stopReason ?? 'cancel' };
    }
    this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'RUNNING', startedAt: now() }));
    let run: AgentRun;
    try {
      run = await this.d.runners.launchAgent(task, def, stage, repo, control, { prompt, agentId: unit.agentId!, model: unit.model, effort: unit.effort, cwd: agentWorkdir(task, repo), permissionLevel: 1, workUnit: { id: unit.id, key: unit.unitKey, title: unit.title } });
    } finally {
      release();
    }
    if (run.kind !== 'ok') {
      this.settleRow(unit, run);
      this.unitEvent(task, stage, unit, run.kind === 'stopped' ? 'stopped' : `failed: ${redact(run.message).slice(0, 200)}`, run.kind === 'failed' ? { errorClass: run.errorClass } : {});
      return run.kind === 'stopped' ? { kind: 'stopped', reason: run.reason } : { kind: 'none', reason: `the decomposition run failed (${run.message.slice(0, 120)})` };
    }
    await this.d.artifacts.write(task.id, { name: `${def.key}-decomposition.md`, type: 'stage-output', content: run.output, stageId: stage.id, stageKey: def.key });
    const read = readManifest(run.output, def.key);
    const units = read.ok ? read.manifest.units : [];
    this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'SUCCESS', summary: read.ok ? `${units.length} unit(s): ${units.map((u) => u.title).join(', ')}` : read.reason, finishedAt: now() }));
    this.unitEvent(
      task,
      stage,
      unit,
      !read.ok ? `finished · no usable split (${read.reason})` : units.length === 1 ? 'finished · found one repair' : `finished · ${units.length} units: ${units.map((u) => u.title).join(', ')}`,
      { units: units.map((u) => u.key) },
    );
    return read.ok ? { kind: 'units', units, hash: read.hash } : { kind: 'none', reason: read.reason };
  }

  /**
   * The split made by the run of this stage just before this one, when that
   * run was stopped rather than failed (parked at a limit, paused, cut off by
   * a restart) and no other stage ran in between: the failures are the same,
   * and a fresh split would name its units differently, so none of the work
   * that run did could be reused. A failed run's split is not reused — it may
   * be why the run failed.
   */
  private async reusedSplit(task: TaskRecord, def: StageDefinition, stage: StageInstance, key: string): Promise<{ kind: 'units'; units: WorkUnitManifestUnit[]; hash: string } | null> {
    const stages = this.d.store.listStages(task.id);
    const previous = stages[stages.findIndex((s) => s.id === stage.id) - 1];
    if (!previous || previous.stageKey !== def.key || !STOPPED.includes(previous.status)) return null;
    const prev = this.d.store.listWorkUnits(task.id, previous.id).find((u) => u.kind === 'decomposer' && u.manifestHash === key && (u.status === 'SUCCESS' || u.status === 'REUSED'));
    if (!prev) return null;
    const content = await this.stageArtifact(task, previous.id, `${def.key}-decomposition`);
    const read = readManifest(content, def.key);
    if (!read.ok) return null;
    // This run's report is the same split, so every run of the stage has its own `<stage>-decomposition.md`.
    await this.d.artifacts.write(task.id, { name: `${def.key}-decomposition.md`, type: 'stage-output', content, stageId: stage.id, stageKey: def.key });
    const unit = this.d.store.insertWorkUnit({
      ...this.blankUnit(task, def, stage, 'decompose', 'decomposer', 'Split the fix', DECOMPOSE_FOCUS),
      ...this.assignment(task, def, stage),
      manifestHash: key,
    });
    this.markReused(task, stage, unit, prev, 'the same failures, split before the run stopped');
    return { kind: 'units', units: read.manifest.units, hash: read.hash };
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
    variants = false,
  ): Promise<{ results: UnitResult[]; base: null } | LimitHit> {
    const cwd = agentWorkdir(task, repo);
    // Reuse is decided first: only the units that must run count against the task's limits.
    const reused = await Promise.all(batch.map((p) => this.reusedOutput(task, stage, rows.get(p.key)!, hash, earlier)));
    const limit = this.limitFor(task, def, reused.filter((r) => r === null).length);
    if (limit) return { kind: 'limit', message: limit };
    const results = await Promise.all(
      batch.map(async (p, i): Promise<UnitResult> => {
        const unit = rows.get(p.key)!;
        const output = reused[i];
        if (output !== null && output !== undefined) return { unit: this.d.store.getWorkUnit(unit.id)!, planned: p, output, changes: [], failure: null, stopped: null, questions: [] };
        const prompt = basePrompt + (variants ? this.variantSection(def, p, others(p), false) : this.unitSection(def, p, others(p), false));
        const run = await this.runUnit(task, def, stage, repo, control, unit, prompt, cwd, false, `${this.promptBase(def)}-${p.key}.md`);
        return this.settle(task, def, stage, unit, p, run, []);
      }),
    );
    return { results, base: null };
  }

  /**
   * Write workers, each in its own disposable checkout of the wave's base (the
   * task's files as a commit would record them). Their results are captured
   * and checked here; nothing reaches the task until `integrate`. `reserve`
   * runs are kept for what follows this wave (the lead's integration pass).
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
    reserve: number,
    variants = false,
  ): Promise<WriteWave | { outcome: StageOutcome } | LimitHit> {
    const parent = task.git.worktreePath!;
    let base: WaveBase;
    try {
      base = await createWaveBase(parent, `${this.refPrefix(task)}${stage.id}/w${wave}-base`, `${task.id}: ${def.name} team wave ${wave} base`);
    } catch (error) {
      for (const p of batch) this.publish(this.d.store.updateWorkUnit(rows.get(p.key)!.id, { status: 'FAILED', errorClass: 'UNKNOWN', errorMessage: 'The team could not record its starting point', finishedAt: now() }));
      return { outcome: this.d.runners.failStage(stage, 'UNKNOWN', `The team could not record the task's files before starting: ${(error as Error).message}`) };
    }
    // Reuse is decided first: only the units that must run count against the task's limits.
    const interrupted = this.interruptedRun(task, stage);
    const prepared = await Promise.all(
      batch.map(async (p) => {
        const unit = this.d.store.updateWorkUnit(rows.get(p.key)!.id, { baseCommit: base.commit });
        return { p, unit, reused: await this.reusedResult(parent, unit, hash, earlier, base, interrupted, variants) };
      }),
    );
    const limit = this.limitFor(task, def, prepared.filter((x) => !x.reused).length + reserve);
    if (limit) return { kind: 'limit', message: limit };
    const results = await Promise.all(
      prepared.map(async ({ p, unit, reused }): Promise<UnitResult> => {
        if (reused) return { unit: this.d.store.getWorkUnit(unit.id)!, planned: p, output: reused.output, changes: reused.changes, alreadyIntegrated: reused.alreadyIntegrated, failure: null, stopped: null, questions: [] };
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
          // The worker never needs the task's folder or the operator's checkout: every spelling of either names its own checkout.
          const prompt = rewritePaths(basePrompt, [parent, repo.path], dir) + (variants ? this.variantSection(def, p, others(p), true) : this.unitSection(def, p, others(p), true));
          const run = await this.runUnit(task, def, stage, repo, control, unit, prompt, dir, true, `${this.promptBase(def)}-${p.key}.md`);
          if (run.kind !== 'ok') return this.settle(task, def, stage, unit, p, run, []);
          // Capture everything the worker left — new, deleted, binary files included — as a hidden commit, then check its paths.
          const result = await captureResult(dir, `${this.refPrefix(task)}${stage.id}/${p.key}`, `${task.id}: ${def.name} · ${p.title}`);
          const changes = await changedPathsBetween(parent, base.commit, result.commit);
          // A variant owns the whole repository: only one variant is ever integrated.
          const outside = variants ? [] : changes.filter((c) => !pathInScope(c.path, p.pathScope));
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
    return { results, base };
  }

  /** Write every unit of a finished wave into the task's working tree at once — or nothing. A unit already there is not written again. */
  private async integrate(task: TaskRecord, def: StageDefinition, stage: StageInstance, results: UnitResult[], wave: number, base: WaveBase): Promise<{ kind: 'ok'; units: number } | { kind: 'failed'; message: string }> {
    const parent = task.git.worktreePath!;
    const withChanges = results.filter((r) => r.changes.length && !r.alreadyIntegrated);
    if (!withChanges.length) return { kind: 'ok', units: 0 };
    const owners = new Map<string, string>();
    for (const r of withChanges) {
      for (const c of r.changes) {
        const other = owners.get(c.path);
        if (other) return { kind: 'failed', message: `${other} and ${r.planned.title} both changed ${c.path}; nothing from this wave was integrated` };
        owners.set(c.path, r.planned.title);
      }
    }
    try {
      const combined = await combineResults(parent, base.commit, withChanges.map((r) => ({ changes: r.changes })), `${this.refPrefix(task)}${stage.id}/w${wave}-combined`, `${task.id}: ${def.name} team wave ${wave}`);
      // Byte-exact against byte-exact: the task's files now against the same files when the wave started.
      const applied = await applyIfUnchanged(parent, base.exactTree, combined.commit, withChanges.flatMap((r) => r.changes));
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

  /**
   * The lead's short consistency pass over the integrated change, in the
   * task's own working tree. The files before and after it are recorded as
   * the unit's base and result trees (as a commit would record them, so an
   * index refresh or a line-ending rewrite is no change), which is how its
   * own edits are counted and checked against the units' paths.
   */
  private async integrationPass(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl, results: UnitResult[]): Promise<Exclude<AgentRun, { kind: 'ok' }> | LimitHit | { kind: 'ok'; lead: LeadReport }> {
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
    const limit = this.limitFor(task, def, 1);
    if (limit) {
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'CANCELLED', errorMessage: 'Not started: the task reached its agent run limit', finishedAt: now() }));
      return { kind: 'limit', message: limit };
    }
    const prompt = [
      built.prompt,
      '',
      '## Integration pass (Stage Team lead, from the orchestrator)',
      '',
      `The Control Center ran this stage as ${results.length} work units, each in its own checkout, and has already integrated their changes into this working tree:`,
      '',
      ...results.map((r) => `- ${r.planned.title} (${r.planned.pathScope.join(', ')}): ${this.d.store.getWorkUnit(r.unit.id)?.summary ?? 'no summary'}`),
      '',
      'Your job is the final consistency pass: read the integrated diff above and reconcile contracts, types, imports and interfaces between the units. Fix only integration problems; do not redo or extend the units\' work. Run only the targeted checks for the areas touched. Do not commit.',
      '',
      'Then write your report as the template asks, covering the whole combined change: describe it as the work units\' changes — each credited to its unit, from the list above — plus your own reconciliation, and say plainly which edits are yours. Your Summary line is shown as the integration pass\'s own result, so let it say what you reconciled (or that nothing needed it).',
    ].join('\n');
    const cwd = agentWorkdir(task, repo);
    const before = await committableTree(cwd).catch(() => null);
    this.d.store.updateWorkUnit(unit.id, { baseCommit: before });
    const release = await this.slots.acquire(() => control.stopReason !== null);
    if (!release) {
      this.publish(this.d.store.updateWorkUnit(unit.id, { status: 'CANCELLED', finishedAt: now() }));
      return { kind: 'stopped', reason: control.stopReason ?? 'cancel' };
    }
    let run: AgentRun;
    try {
      run = await this.runUnit(task, def, stage, repo, control, unit, prompt, cwd, false, `${this.promptBase(def)}-integration.md`, true);
    } finally {
      release();
    }
    if (run.kind !== 'ok') {
      this.settleRow(unit, run);
      this.unitEvent(task, stage, unit, run.kind === 'stopped' ? 'stopped' : `failed: ${redact(run.message).slice(0, 200)}`, run.kind === 'failed' ? { errorClass: run.errorClass } : {});
      return run;
    }

    const after = await committableTree(cwd).catch(() => null);
    const changed = before && after ? await changedPathsBetween(cwd, before, after).catch(() => null) : null;
    const summary = summarize(run.output);
    this.publish(
      this.d.store.updateWorkUnit(unit.id, {
        status: 'SUCCESS',
        resultCommit: after,
        summary: changed?.length ? `${summary ?? 'Done'} (${changed.length} file${changed.length === 1 ? '' : 's'})` : summary,
        finishedAt: now(),
      }),
    );
    const files = changed === null ? 'changes not recorded' : changed.length ? `${changed.length} file${changed.length === 1 ? '' : 's'} changed` : 'no changes';
    this.unitEvent(task, stage, unit, `finished · ${files}`, { files: changed?.length ?? null });
    // Reconciling across units is the lead's job, so a change outside their paths is reported, not refused.
    const scope = results.filter((r) => r.changes.length).flatMap((r) => r.planned.pathScope);
    const outside = (changed ?? []).filter((c) => !pathInScope(c.path, scope));
    if (outside.length) {
      const names = outside.slice(0, 10).map((c) => c.path).join(', ') + (outside.length > 10 ? ', …' : '');
      this.d.publisher.event(
        task.id,
        'STAGE_TEAM',
        `${def.name}: the integration pass changed ${outside.length} file${outside.length === 1 ? '' : 's'} outside the work units' paths (${names}); kept, and reviewed with the rest of the change`,
        { warning: 'integration_outside_scope', workUnitId: unit.id, paths: outside.map((c) => c.path) },
        stage.id,
      );
    }
    return { kind: 'ok', lead: { output: run.output, agentId: unit.agentId } };
  }

  /** Ask the primary reviewer once more for the files its PASS did not account for (same unit, a second execution). */
  private async coverageFollowUp(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl, primary: UnitResult, missing: string[]): Promise<AgentRun | LimitHit> {
    const limit = this.limitFor(task, def, 1);
    if (limit) return { kind: 'limit', message: limit };
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
    await this.savePrompt(task, def, stage, `${this.promptBase(def)}-${primary.planned.key}-coverage.md`, prompt);
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

  /** Launch one unit's run. Its final prompt is saved first (`promptName`), so every run can be debugged from what it read. */
  private async runUnit(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl, unit: StageWorkUnit, prompt: string, cwd: string, confine: boolean, promptName: string, slotHeld = false): Promise<AgentRun> {
    await this.savePrompt(task, def, stage, promptName, prompt);
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
   * Whether the task's own limits allow `runs` more agent runs now: the same
   * `limitReached` over `task.limits` that the Chairman checks before every
   * stage (and extends when the operator resumes past a limit), with the
   * runs about to start counted in (docs/plans/STAGE_TEAMS_PLAN.md §3.10).
   * Usage is read as the Chairman reads it: the task's agent executions and
   * their time.
   */
  private limitFor(task: TaskRecord, def: StageDefinition, runs: number): string | null {
    if (runs <= 0) return null;
    const current = this.task(task.id);
    if (!current.supervised || !current.limits) return null;
    const executions = this.d.store.listExecutions(task.id);
    const usage = {
      recoveryCycle: current.recoveryCycle,
      agentRuns: executions.filter((e) => e.kind === 'agent').length,
      workMs: executions.reduce((sum, e) => sum + (e.durationMs ?? (e.status === 'running' ? Date.now() - new Date(e.startedAt).getTime() : 0)), 0),
    };
    const reached = limitReached(current.limits, usage);
    if (reached) return reached;
    const { maxAgentRuns } = current.limits;
    if (usage.agentRuns + runs <= maxAgentRuns) return null;
    const left = maxAgentRuns - usage.agentRuns;
    return `Agent run limit reached for ${def.name}: it needs ${runs} more agent run${runs === 1 ? '' : 's'}, and ${left} of ${maxAgentRuns} ${left === 1 ? 'is' : 'are'} left.`;
  }

  /**
   * Stop the team where the task's limit stops it and park the task exactly
   * as the Chairman does before a stage (blocker `limit`, "Paused at a
   * limit"): no further run starts, and a resume extends the limits and runs
   * the stage again, reusing every unit whose result still holds.
   */
  private async parkAtLimit(task: TaskRecord, def: StageDefinition, stage: StageInstance, rows: Map<string, StageWorkUnit>, pending: PlannedUnit[], results: UnitResult[], message: string): Promise<StageOutcome> {
    this.markRemaining(rows, pending, 'CANCELLED', 'Not started: the task reached its agent run limit');
    if (results.length) await this.writeAggregate(task, def, stage, results);
    const summary = `Paused at a limit: ${message}`;
    this.d.publisher.updateStage(stage.id, { status: 'CANCELLED', summary, finishedAt: now() });
    this.d.publisher.event(task.id, 'STAGE_TEAM', `${def.name} stopped starting workers: ${message}`, { limit: true, finished: results.length }, stage.id);
    this.d.publisher.updateTask(task.id, { status: 'WAITING_FOR_USER', blocker: { kind: 'limit', message, stageKey: def.key }, pauseRequested: false, pauseAfterStage: false });
    this.d.publisher.event(task.id, 'TASK_WAITING', summary);
    return { kind: 'blocked', stageId: stage.id };
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

  /** A timeline line for a unit the orchestrator adds (the decomposer, the integration pass), shaped like a worker's. */
  private unitEvent(task: TaskRecord, stage: StageInstance, unit: StageWorkUnit, what: string, data: Record<string, unknown> = {}): void {
    this.d.publisher.event(task.id, 'WORK_UNIT', `${unit.title} ${what}`, { workUnitId: unit.id, workUnitKey: unit.unitKey, ...data }, stage.id);
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
   * instructions: its report stands. A read-only unit records the files it
   * read as its base, as a commit would record them (`committableTree`): a
   * worker's own `git status` refreshing the task's index, or a file whose
   * only change is its line endings, is not different files.
   */
  private async reusedOutput(task: TaskRecord, stage: StageInstance, unit: StageWorkUnit, hash: string, earlier: StageWorkUnit[]): Promise<string | null> {
    const repo = this.d.store.getRepository(task.repositoryId);
    const tree = repo ? await committableTree(agentWorkdir(task, repo)).catch(() => null) : null;
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

  /**
   * An earlier successful write unit whose result still holds. Either its base
   * had exactly these files — its captured result is integrated with this
   * wave — or it ran in `interrupted`, the run of this stage just before this
   * one, which stopped after integrating it: the task's files still hold its
   * result at every path it changed, so it is reused as is and nothing is
   * written again. (A unit that changed nothing has no result to find there
   * and runs again on the new files.) A variant owns the whole repository, so
   * it has no paths to stay within.
   */
  private async reusedResult(parent: string, unit: StageWorkUnit, hash: string, earlier: StageWorkUnit[], base: WaveBase, interrupted: string | null, variants = false): Promise<{ output: string; changes: PathChange[]; alreadyIntegrated: boolean } | null> {
    for (const prev of this.candidates(unit, hash, earlier)) {
      if (!prev.baseCommit || !prev.resultCommit) continue;
      try {
        const changes = await changedPathsBetween(parent, prev.baseCommit, prev.resultCommit);
        if (!variants && changes.some((c) => !pathInScope(c.path, unit.pathScope))) continue;
        const sameBase = (await treeOf(parent, prev.baseCommit)) === base.tree;
        if (!sameBase) {
          if (prev.stageId !== interrupted || !changes.length) continue;
          const paths = new Set(changes.map((c) => c.path));
          if ((await changedPathsBetween(parent, base.commit, prev.resultCommit)).some((c) => paths.has(c.path))) continue;
        }
        const task = this.task(unit.taskId);
        const output = await this.unitOutput(task, prev);
        // An integrated result keeps the base it was made on, so base → result stays the unit's own change.
        this.d.store.updateWorkUnit(unit.id, sameBase ? { resultCommit: prev.resultCommit } : { baseCommit: prev.baseCommit, resultCommit: prev.resultCommit });
        this.markReused(task, this.d.store.getStage(unit.stageId)!, unit, prev, sameBase ? undefined : "already in the task's files");
        return { output: output || prev.summary || 'Reused an earlier result', changes, alreadyIntegrated: !sameBase };
      } catch {
        // A result whose objects are gone (refs cleaned) is simply not reusable.
      }
    }
    return null;
  }

  /** The run of this stage just before `stage`, when it ended without finishing (parked at a limit, paused, failed, cut off by a restart). */
  private interruptedRun(task: TaskRecord, stage: StageInstance): string | null {
    const runs = this.d.store.listStages(task.id).filter((s) => s.stageKey === stage.stageKey);
    const previous = runs[runs.findIndex((s) => s.id === stage.id) - 1];
    return previous && UNFINISHED.includes(previous.status) ? previous.id : null;
  }

  private candidates(unit: StageWorkUnit, hash: string, earlier: StageWorkUnit[]): StageWorkUnit[] {
    return earlier
      .filter((u) => u.unitKey === unit.unitKey && u.kind === 'worker' && u.manifestHash === hash && (u.status === 'SUCCESS' || u.status === 'REUSED') && u.stageId !== unit.stageId)
      .reverse();
  }

  private markReused(task: TaskRecord, stage: StageInstance, unit: StageWorkUnit, prev: StageWorkUnit, why = 'same files, same instructions'): void {
    const row = this.d.store.updateWorkUnit(unit.id, {
      status: 'REUSED',
      reusedFrom: prev.reusedFrom ?? prev.id,
      summary: prev.summary,
      startedAt: now(),
      finishedAt: now(),
    });
    this.publish(row);
    this.d.publisher.event(task.id, 'WORK_UNIT', `${unit.title}: reused its earlier result (${why})`, { workUnitId: unit.id, reusedFrom: row.reusedFrom }, stage.id);
  }

  /** The latest report an earlier unit wrote — for a reused unit, the run it reused (a reused unit writes none): its own artifact `<role>-<unit>.md`, possibly numbered. */
  private async unitOutput(task: TaskRecord, prev: StageWorkUnit): Promise<string> {
    const source = prev.reusedFrom ? (this.d.store.getWorkUnit(prev.reusedFrom) ?? prev) : prev;
    const def = task.workflow.stages.find((s) => s.key === source.stageKey);
    return this.stageArtifact(task, source.stageId, `${def ? this.artifactBase(def) : source.stageKey}-${source.unitKey}`);
  }

  /** The latest `<stem>.md` (or a numbered repeat) one stage run wrote; empty when there is none. */
  private async stageArtifact(task: TaskRecord, stageId: string, stem: string): Promise<string> {
    const found = this.d.store
      .listArtifacts(task.id)
      .filter((a) => a.stageId === stageId && (a.name === `${stem}.md` || (a.name.startsWith(`${stem}-`) && /^-\d+\.md$/.test(a.name.slice(stem.length)))))
      .at(-1);
    if (!found) return '';
    return (await this.d.artifacts.read(found).catch(() => ({ content: '' }))).content;
  }

  // ---------------------------------------------------------------------------
  // Aggregation and outcomes
  // ---------------------------------------------------------------------------

  /** One bounded report for the stage, under the role's usual artifact, so later stages read the team as one. */
  private async writeAggregate(task: TaskRecord, def: StageDefinition, stage: StageInstance, results: UnitResult[], lead: LeadReport | null = null): Promise<string> {
    const withOutput = results.filter((r) => r.output);
    if (!withOutput.length && !lead) return '';
    const parts = [`# ${def.name} — team of ${results.length}`, ''];
    if (lead) parts.push(`## Integration (lead, ${this.agentName(lead.agentId)})`, '', lead.output, '');
    for (const r of withOutput) {
      const text = r.output!.length > MAX_WORKER_IN_AGGREGATE ? `${r.output!.slice(0, MAX_WORKER_IN_AGGREGATE)}\n\n[truncated — the full report is ${this.artifactBase(def)}-${r.planned.key}.md]` : r.output!;
      parts.push(`## ${r.planned.title} (${this.agentName(r.unit.agentId)}${r.planned.primary ? ', primary' : ''}${r.unit.status === 'REUSED' ? ', reused' : ''})`, '', text, '');
    }
    const content = parts.join('\n');
    const artifact = ROLE_ARTIFACT[def.role] ?? { type: 'stage-output' as const, name: `${def.key}.md` };
    await this.d.artifacts.write(task.id, { name: artifact.name, type: artifact.type, content, stageId: stage.id, stageKey: def.key });
    return content;
  }

  /**
   * The stage's one line, composed from the units: each worker's own result,
   * then what the lead reconciled — the integration pass is never credited
   * with the workers' work.
   */
  private stageSummary(results: UnitResult[], lead: LeadReport | null): string {
    const reused = results.filter((r) => r.unit.status === 'REUSED').length;
    const units = results.map((r) => `${r.planned.title}: ${clipText(this.d.store.getWorkUnit(r.unit.id)?.summary ?? summarize(r.output ?? '') ?? 'done', MAX_UNIT_SUMMARY)}`);
    const integration = lead ? `; integration: ${clipText(summarize(lead.output) ?? 'done', MAX_UNIT_SUMMARY)}` : '';
    return clipText(`Team of ${results.length}${reused ? ` (${reused} reused)` : ''}: ${units.join('; ')}${integration}`, MAX_STAGE_SUMMARY);
  }

  /** Agent time this stage instance spent, per kind of unit: its executions' durations (a coverage follow-up counts to its worker). */
  private agentTime(task: TaskRecord, stage: StageInstance): Partial<Record<WorkUnitKind, number>> {
    const kinds = new Map(this.d.store.listWorkUnits(task.id).filter((u) => u.stageId === stage.id).map((u) => [u.id, u.kind]));
    const out: Partial<Record<WorkUnitKind, number>> = {};
    for (const e of this.d.store.listExecutions(task.id)) {
      const kind = e.stageId === stage.id && e.workUnitId ? kinds.get(e.workUnitId) : undefined;
      if (kind) out[kind] = (out[kind] ?? 0) + (e.durationMs ?? 0);
    }
    return out;
  }

  private agentName(agentId: string | null): string {
    return agentId && this.d.agents.has(agentId) ? this.d.agents.adapter(agentId).displayName : (agentId ?? 'agent');
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

  /** The role's prompt artifact name without `.md` (`implementation-prompt`); a unit's prompt is `<base>-<unit>.md`. */
  private promptBase(def: StageDefinition): string {
    return (ROLE_ARTIFACT[def.role]?.prompt ?? `${def.key}-prompt.md`).replace(/\.md$/, '');
  }

  /**
   * What one run actually read, saved before it starts, as a single agent
   * stage saves its prompt (docs/systems/prompts.md); the artifact service
   * numbers repeats. A prompt that cannot be saved never stops the run.
   */
  private async savePrompt(task: TaskRecord, def: StageDefinition, stage: StageInstance, name: string, prompt: string): Promise<void> {
    await this.d.artifacts.write(task.id, { name, type: 'stage-output', content: prompt, stageId: stage.id, stageKey: def.key }).catch(() => undefined);
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
    let removed = 0;
    // Also the data folder's, where checkouts were made before the work root existed (SEC-3).
    for (const root of [this.root(), path.join(this.d.dataDir, 'team-worktrees')]) {
      if (!existsSync(root)) continue;
      for (const taskDir of await readdir(root).catch(() => [] as string[])) {
        for (const child of await readdir(path.join(root, taskDir)).catch(() => [] as string[])) {
          unlinkDependencies(findLinks(path.join(root, taskDir, child)));
          removed++;
        }
        await rm(path.join(root, taskDir), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => undefined);
      }
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

/**
 * Replace every spelling of the given folders (the task's worktree, the
 * operator's checkout) in a prompt with the worker's own checkout. One pass,
 * longest spelling first, so a folder inside another and the replacement
 * itself are never rewritten twice.
 */
export function rewritePaths(prompt: string, from: string | readonly string[], to: string): string {
  const variants = new Set<string>();
  for (const folder of typeof from === 'string' ? [from] : from) {
    if (!folder) continue;
    for (const v of [folder, path.resolve(folder)]) {
      variants.add(v);
      variants.add(v.replace(/\\/g, '/'));
    }
  }
  if (!variants.size) return prompt;
  const pattern = new RegExp([...variants].sort((a, b) => b.length - a.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return prompt.replace(pattern, () => to);
}

/** A worker's focus or a unit's title as a timeline title: at most `max` characters, cut at a word boundary. */
export function clipTitle(text: string, max = MAX_TITLE): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

/** The last `WINNER: <key>` line of a judge's answer (bold, backticks or a list marker allowed). */
export function parseWinner(output: string): string | null {
  const all = [...output.matchAll(/^[\s>*+-]*\**WINNER:?\**:?\s*`?([a-z0-9][a-z0-9-]*)`?\s*\**\s*$/gim)];
  return all.length ? all.at(-1)![1]!.toLowerCase() : null;
}
