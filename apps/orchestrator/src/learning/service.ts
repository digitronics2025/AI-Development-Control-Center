import os from 'node:os';
import path from 'node:path';
import { redact } from '@acc/security';
import {
  FINDING_KIND_LABEL,
  INSTALLABLE_TOOLS,
  reviewTrigger,
  type LearningFinding,
  type LearningImprovement,
  type LearningOverview,
  type LearningReview,
  type LearningScope,
  type PermissionLevel,
  type StageDefinition,
  type StageInstance,
} from '@acc/shared';
import { policyCeiling, refreshedPath } from '@acc/tools';
import type { Bus } from '../bus.js';
import type { Chairman } from '../chairman/chairman.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { SettingsService } from '../services/settings.js';
import type { SkillCatalog } from '../services/skills.js';
import type { Store, TaskRecord } from '../store/store.js';
import type { ToolService } from '../tools/service.js';
import type { ToolStore } from '../tools/store.js';
import { MAX_LESSONS_PER_SCOPE, deskDecision, trialVerdict } from './policy.js';
import { mergeFindings, parseReview, reviewPrompt, ruleFindings, type ReviewFinding, type SkillCandidate } from './reviewer.js';
import { checkAll, checkLearnedText } from './safety.js';
import { LOG_PATTERNS, collectSignals } from './signals.js';
import { ManagedSkills, type MarketplaceSkill } from './skills.js';
import { LearningStore } from './store.js';

export interface LearningDeps {
  store: Store;
  bus: Bus;
  settings: SettingsService;
  chairman: Chairman;
  artifacts: ArtifactService;
  toolStore: ToolStore;
  tools: ToolService;
  skills: SkillCatalog;
  dataDir: string;
  /** The orchestrator's environment; its PATH is refreshed after an install so new runs find the program. */
  baseEnv: NodeJS.ProcessEnv;
}

const SKILL_KINDS = ['skill_adopted', 'skill_authored'] as const;
const LESSON_KINDS = ['lesson', 'skill_recommendation'] as const;
/** Lines of learned advice one prompt carries. */
const MAX_PROMPT_LINES = 10;
const MAX_CANDIDATE_SKILLS = 25;

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Words worth matching skills on: lowercase, 3+ letters, no filler. */
function words(text: string): Set<string> {
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'task', 'when', 'was', 'were', 'not', 'are', 'has', 'have', 'its', 'use', 'run', 'ran']);
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w)));
}

/** Skills whose name or description share the most words with the task and its signals. */
export function rankSkills(query: string, skills: SkillCandidate[], limit = MAX_CANDIDATE_SKILLS): SkillCandidate[] {
  const q = words(query);
  if (!q.size) return [];
  const scored = skills
    .map((s) => {
      const w = words(`${s.name.replace(/[:_-]/g, ' ')} ${s.description ?? ''}`);
      let score = 0;
      for (const x of q) if (w.has(x)) score++;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map((x) => x.s);
}

/**
 * The learning loop (docs/systems/learning.md): reviews every completed task,
 * aggregates what it finds across tasks, and — as the system-wide Chairman —
 * adopts improvements on its own within the desk's rules, tries each on the
 * next tasks, and undoes what does not help. Reviews run one at a time in the
 * background and never hold up the engine.
 */
export class LearningService {
  readonly store: LearningStore;
  readonly managed: ManagedSkills;
  private chain: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly d: LearningDeps) {
    this.store = new LearningStore(d.store.db);
    this.managed = new ManagedSkills(d.dataDir, d.baseEnv);
  }

  private settings() {
    return this.d.settings.get().learning;
  }

  private publish(change: 'review' | 'finding' | 'improvement', taskId: string | null): void {
    this.d.bus.publish({ type: 'learning', change, taskId });
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /** Review tasks as they complete, and finish reviews a restart interrupted. */
  start(): void {
    if (this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = this.d.bus.subscribe((m) => {
      if (m.type !== 'task') return;
      const trigger = reviewTrigger(m.task);
      if (!trigger) return;
      const previous = this.store.review(m.task.id);
      if (!previous) this.enqueue(m.task.id);
      // Reviewed while stuck, then finished: look again at the whole run (it still counts once towards trials).
      else if (trigger === 'completed' && previous.finishedAt && m.task.finishedAt && previous.finishedAt < m.task.finishedAt && !this.queued.has(m.task.id)) this.enqueue(m.task.id, true);
    });
    for (const r of this.store.reviewsWithStatus(['pending', 'running'])) this.enqueue(r.taskId, true);
  }

  /**
   * Stop taking new reviews. A review already talking to the model is given a
   * few seconds; if it is still running it stays `running` in the database
   * and is picked up again after the next start.
   */
  async stop(graceMs = 3_000): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.idle(), new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))]);
    clearTimeout(timer);
  }

  /** Resolves when every queued review has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Queue a task's review. `force` re-reviews a task already reviewed. */
  enqueue(taskId: string, force = false): LearningReview | null {
    if (this.queued.has(taskId)) return this.store.review(taskId);
    const task = this.d.store.getTask(taskId);
    if (!task || !reviewTrigger(task)) return null;
    if (!force && this.store.review(taskId)) return this.store.review(taskId);
    if (!this.settings().enabled && !force) return null;
    // A task counts once towards an improvement's trial, however often it is reviewed.
    const previous = this.store.review(taskId);
    const countTrials = !previous || (previous.status !== 'done' && previous.status !== 'skipped');
    const review = this.store.queueReview(taskId, task.repositoryId);
    this.queued.add(taskId);
    this.publish('review', taskId);
    this.chain = this.chain
      .then(async () => {
        if (this.stopped) return;
        await this.review(taskId, countTrials);
      })
      .catch((error: Error) => {
        if (this.stopped) return; // the database may be closing; the row is resumed after the next start
        try {
          this.store.updateReview(taskId, { status: 'failed', error: redact(error.message).slice(0, 500), finishedAt: new Date().toISOString() });
          this.publish('review', taskId);
        } catch {
          /* the task was deleted meanwhile */
        }
      })
      .finally(() => this.queued.delete(taskId));
    return review;
  }

  // ===========================================================================
  // Review
  // ===========================================================================

  private async review(taskId: string, countTrials: boolean): Promise<void> {
    const task = this.d.store.getTask(taskId);
    if (!task) return;
    const repo = this.d.store.getRepository(task.repositoryId);
    this.store.updateReview(taskId, { status: 'running' });
    this.publish('review', taskId);

    const stages = this.d.store.listStages(taskId);
    const executions = this.d.store.listExecutions(taskId);
    const signals = collectSignals({
      task,
      stages,
      toolCalls: this.d.toolStore.listExecutions({ taskId, limit: 1000 }),
      logLines: this.logLines(executions.map((e) => ({ id: e.id, stageId: e.stageId }))),
      strategies: this.d.chairman.store.listStrategyRuns(taskId, 200),
      failedTestRuns: this.d.store.listTestRuns(taskId).filter((r) => r.status === 'failed').length,
      providersFor: (capability) => this.d.tools.registry.offering(capability).map((o) => o.provider.id),
    });

    const now = () => new Date().toISOString();
    if (!signals.length) {
      this.store.updateReview(taskId, { status: 'skipped', reviewer: 'rules', signals: [], findingIds: [], summary: 'Nothing slowed this task down; no review needed.', finishedAt: now() });
      this.store.log({ kind: 'review', taskId, findingId: null, improvementId: null, message: `${task.title}: clean run, nothing to learn.` });
      if (countTrials) this.advanceTrials(task, new Set());
      this.publish('review', taskId);
      return;
    }

    const rules = ruleFindings(signals, task.repositoryId);
    let reviewer: 'model' | 'rules' = 'rules';
    let summary = `${signals.length} signal${signals.length === 1 ? '' : 's'} recorded; reviewed by rules.`;
    let error: string | null = null;
    let model: ReviewFinding[] = [];
    const cfg = this.settings();
    const unavailable = cfg.reviewWithModel ? this.d.chairman.reasoner.unavailableReason() : 'Model reviews are turned off in Settings.';
    if (!unavailable) {
      const existing = this.store.listFindings({ repositoryId: task.repositoryId, statuses: ['open', 'adopted', 'needs_you'], limit: 30 });
      const lessons = this.store.liveFor(task.repositoryId, LESSON_KINDS);
      const skills = await this.skillCandidates(repo?.path ?? null, `${task.title} ${task.description.slice(0, 2000)} ${signals.map((s) => `${s.key} ${s.summary}`).join(' ')}`);
      const context = {
        taskId,
        title: task.title,
        workflow: task.workflow.name,
        repositoryName: repo?.name ?? task.repositoryId,
        repositoryId: task.repositoryId,
        finalStatus: task.status === 'COMPLETED' ? task.finalStatus : `stuck — ${task.blocker?.message ?? task.status}`,
        signals,
        finalReport: await this.reportText(taskId),
        existing,
        lessons,
        skills,
      };
      const result = await this.d.chairman.reasoner.review(taskId, reviewPrompt(context), (raw) => parseReview(raw, context));
      if (result.ok) {
        reviewer = 'model';
        model = result.value.findings;
        summary = result.value.summary;
        if (result.value.dropped.length) error = `Dropped: ${result.value.dropped.join('; ')}`.slice(0, 500);
      } else {
        error = `Model review unavailable (${result.reason.slice(0, 200)}); used the rules.`;
      }
    } else {
      error = unavailable;
    }

    const findings = mergeFindings(rules, model);
    const touched: LearningFinding[] = [];
    for (const f of findings) {
      const { finding, newTask } = this.store.observe(f, taskId, f.signalIds);
      touched.push(finding);
      if (newTask && finding.occurrences === 1) {
        this.store.log({ kind: 'finding', taskId, findingId: finding.id, improvementId: null, message: `${FINDING_KIND_LABEL[finding.kind]}: ${finding.title}` });
      }
    }
    this.store.updateReview(taskId, { status: 'done', reviewer, signals, findingIds: touched.map((f) => f.id), summary: redact(summary).slice(0, 600), error, finishedAt: now() });
    this.store.log({ kind: 'review', taskId, findingId: null, improvementId: null, message: `${task.title}: ${touched.length} finding${touched.length === 1 ? '' : 's'} (${reviewer}).` });
    if (countTrials) this.advanceTrials(task, new Set(touched.map((f) => f.id)));
    this.publish('review', taskId);
    for (const finding of touched) await this.consider(finding.id, taskId);
    // Findings that were waiting (for a second task, or for tomorrow's budget) get another look.
    const seen = new Set(touched.map((f) => f.id));
    for (const waiting of this.store.listFindings({ statuses: ['open'], limit: 20 }).filter((f) => f.proposal && !seen.has(f.id))) await this.consider(waiting.id, null);
  }

  /** The final report; for a stuck task, the latest review, verification or implementation report instead. */
  private async reportText(taskId: string): Promise<string> {
    for (const type of ['final-report', 'review', 'verification', 'implementation-report'] as const) {
      const text = await this.d.artifacts.latestText(taskId, type, 20_000).catch(() => null);
      if (text) return type === 'final-report' ? text : `(${type.replace('-', ' ')} — the task has not finished)

${text}`;
    }
    return '';
  }

  /** Agent log lines that may show a missing command or a refused skill, bounded. */
  private logLines(executions: Array<{ id: string; stageId: string | null }>): Array<{ stageId: string | null; text: string }> {
    if (!executions.length) return [];
    const byId = new Map(executions.map((e) => [e.id, e.stageId]));
    const ids = [...byId.keys()];
    const rows = this.d.store.db
      .prepare(`SELECT execution_id, text FROM execution_logs WHERE execution_id IN (${ids.map(() => '?').join(',')}) AND (${LOG_PATTERNS.map(() => 'text LIKE ?').join(' OR ')}) LIMIT 500`)
      .all(...ids, ...LOG_PATTERNS) as Array<{ execution_id: string; text: string }>;
    return rows.map((r) => ({ stageId: byId.get(r.execution_id) ?? null, text: r.text }));
  }

  private async skillCandidates(repoPath: string | null, query: string): Promise<SkillCandidate[]> {
    const installed: SkillCandidate[] = repoPath ? (await this.d.skills.list(repoPath).catch(() => ({ skills: [] }))).skills.map((s) => ({ name: s.name, description: s.description, origin: 'installed' as const })) : [];
    const names = new Set(installed.map((s) => s.name));
    const market: SkillCandidate[] = (await this.managed.marketplaceSkills().catch(() => [])).filter((s) => !names.has(s.name)).map((s) => ({ name: s.name, description: s.description, origin: 'marketplace' as const }));
    return rankSkills(query, [...installed, ...market]);
  }

  // ===========================================================================
  // Trials
  // ===========================================================================

  /**
   * Every live improvement that reaches this task counts it once: a
   * recurrence when this review saw its finding again. Only tasks created
   * after the improvement count — earlier ones never received it.
   */
  private advanceTrials(task: TaskRecord, seenFindings: Set<string>): void {
    for (const imp of this.store.liveFor(task.repositoryId)) {
      if (imp.status !== 'trial' || task.createdAt <= imp.createdAt) continue;
      const recurred = imp.findingId ? seenFindings.has(imp.findingId) : false;
      const trial = { ...imp.trial, seen: imp.trial.seen + 1, recurrences: imp.trial.recurrences + (recurred ? 1 : 0) };
      const verdict = trialVerdict(trial);
      if (verdict === 'continue') {
        this.store.updateImprovement(imp.id, { seen: trial.seen, recurrences: trial.recurrences });
      } else if (verdict === 'keep') {
        this.store.updateImprovement(imp.id, { status: 'active', seen: trial.seen, recurrences: trial.recurrences, reason: `Kept: tried on ${trial.seen} tasks, the problem came back in ${trial.recurrences}.` });
        this.store.log({ kind: 'trial', taskId: task.id, findingId: imp.findingId, improvementId: imp.id, message: `Kept "${imp.title}" after ${trial.seen} tasks (${trial.recurrences} recurrence${trial.recurrences === 1 ? '' : 's'}).` });
      } else {
        this.store.updateImprovement(imp.id, { seen: trial.seen, recurrences: trial.recurrences });
        void this.undo(imp.id, 'chairman', `Did not help: the problem came back in ${trial.recurrences} of ${trial.seen} tasks.`);
      }
      this.publish('improvement', task.id);
    }
  }

  // ===========================================================================
  // The desk
  // ===========================================================================

  private scopeCounts(scope: LearningScope, repositoryId: string | null): { lessons: number; skills: number } {
    const live = this.store.liveFor(scope === 'global' ? null : repositoryId).filter((i) => i.scope === scope);
    return { lessons: live.filter((i) => (LESSON_KINDS as readonly string[]).includes(i.kind)).length, skills: live.filter((i) => (SKILL_KINDS as readonly string[]).includes(i.kind)).length };
  }

  /** Decide on one finding after a review saw it; act when the desk's rules allow. */
  private async consider(findingId: string, taskId: string | null): Promise<void> {
    const finding = this.store.finding(findingId);
    if (!finding || finding.status !== 'open') return;
    const counts = this.scopeCounts(finding.scope, finding.repositoryId);
    const decision = deskDecision(finding, {
      settings: this.settings(),
      actionsToday: this.store.actionsSince(startOfToday()),
      lessonsInScope: counts.lessons,
      skillsInScope: counts.skills,
      undoneBefore: this.store.wasUndone(finding.fingerprint),
    });
    if (!decision.act) {
      if (decision.wait) {
        if (finding.statusReason !== decision.reason) this.store.setFindingStatus(finding.id, 'open', decision.reason);
      } else {
        this.store.setFindingStatus(finding.id, 'needs_you', decision.reason);
        this.store.log({ kind: 'needs_you', taskId, findingId: finding.id, improvementId: null, message: `${finding.title}: ${decision.reason}` });
      }
      this.publish('finding', taskId);
      return;
    }
    await this.act(finding, { taskId, operator: false });
  }

  /**
   * Carry out a finding's proposal. The operator may ask for it directly
   * (from the page), which skips the evidence threshold, the autonomy
   * setting and the daily budget — never the safety scan or the catalog.
   */
  async act(finding: LearningFinding, opts: { taskId: string | null; operator: boolean }): Promise<LearningImprovement | null> {
    const p = finding.proposal;
    if (!p) return null;
    const cfg = this.settings();
    const needsYou = (reason: string, status: 'needs_you' | 'failed' = 'needs_you') => {
      this.store.setFindingStatus(finding.id, status, reason);
      this.store.log({ kind: status === 'failed' ? 'failed' : 'needs_you', taskId: opts.taskId, findingId: finding.id, improvementId: null, message: `${finding.title}: ${reason}` });
      this.publish('finding', opts.taskId);
      return null;
    };
    const adopt = (kind: LearningImprovement['kind'], fields: { title: string; content: string; source: string; contentHash: string | null; status?: LearningImprovement['status'] }) => {
      const imp = this.store.insertImprovement({
        findingId: finding.id,
        fingerprint: finding.fingerprint,
        kind,
        scope: finding.scope,
        repositoryId: finding.scope === 'global' ? null : finding.repositoryId,
        title: redact(fields.title).slice(0, 300),
        content: fields.content,
        source: fields.source,
        contentHash: fields.contentHash,
        status: fields.status ?? 'trial',
        trialTarget: cfg.trialTasks,
        reason: `${opts.operator ? 'Adopted at your request' : 'Adopted by the Chairman'}: ${finding.detail}`.slice(0, 600),
      });
      this.store.setFindingStatus(finding.id, 'adopted', null, imp.id);
      this.store.log({ kind: 'adopted', taskId: opts.taskId, findingId: finding.id, improvementId: imp.id, message: `${imp.title} (${opts.operator ? 'at your request' : 'on its own'}; on trial for the next ${cfg.trialTasks} tasks).` });
      this.publish('improvement', opts.taskId);
      return imp;
    };

    switch (p.type) {
      case 'ADD_LESSON': {
        const safety = checkLearnedText(p.text);
        if (!safety.ok) return needsYou(`The lesson was not adopted: it ${safety.reasons.join(', ')}.`, 'failed');
        return adopt('lesson', { title: p.text, content: p.text, source: 'chairman', contentHash: null });
      }
      case 'USE_SKILL': {
        const safety = checkLearnedText(p.when);
        if (!safety.ok) return needsYou(`The recommendation was not adopted: it ${safety.reasons.join(', ')}.`, 'failed');
        const repo = finding.repositoryId ? this.d.store.getRepository(finding.repositoryId) : null;
        const installed = repo ? await this.d.skills.names(repo.path).catch(() => new Set<string>()) : new Set<string>();
        if (installed.has(p.skill)) {
          const text = `Use the /${p.skill} skill when ${p.when.replace(/\.$/, '')}.`;
          return adopt('skill_recommendation', { title: text, content: text, source: 'installed', contentHash: null });
        }
        const market = (await this.managed.marketplaceSkills().catch(() => [] as MarketplaceSkill[])).find((s) => s.name === p.skill);
        if (!market) return needsYou(`No skill named ${p.skill} is available on this machine or in a marketplace you added.`);
        if (this.managed.exists(finding.scope, finding.repositoryId, market.skill)) return needsYou(`A learned skill named ${market.skill} already exists here.`);
        try {
          const copied = await this.managed.adopt(finding.scope, finding.repositoryId, market);
          const invoked = this.managed.invokedName(finding.scope, copied.skill);
          return adopt('skill_adopted', { title: `/${invoked} — ${p.when}`, content: copied.skill, source: `marketplace:${market.marketplace}/${market.plugin}`, contentHash: copied.hash });
        } catch (error) {
          return needsYou(`The skill could not be added: ${redact((error as Error).message).slice(0, 200)}`, 'failed');
        }
      }
      case 'AUTHOR_SKILL': {
        const safety = checkAll(p.name, p.description, p.body);
        if (!safety.ok) return needsYou(`The skill was not written: it ${safety.reasons.join(', ')}.`, 'failed');
        if (this.managed.exists(finding.scope, finding.repositoryId, p.name)) return needsYou(`A learned skill named ${p.name} already exists here.`);
        try {
          const written = await this.managed.writeAuthored(finding.scope, finding.repositoryId, p);
          const invoked = this.managed.invokedName(finding.scope, p.name);
          return adopt('skill_authored', { title: `/${invoked} — ${p.description}`, content: p.name, source: 'chairman', contentHash: written.hash });
        } catch (error) {
          return needsYou(`The skill could not be written: ${redact((error as Error).message).slice(0, 200)}`, 'failed');
        }
      }
      case 'INSTALL_TOOL':
        return this.install(finding, p.toolId, opts, adopt, needsYou);
    }
  }

  private async install(
    finding: LearningFinding,
    toolId: string,
    opts: { taskId: string | null; operator: boolean },
    adopt: (kind: 'tool_installed', f: { title: string; content: string; source: string; contentHash: null; status?: LearningImprovement['status'] }) => LearningImprovement,
    needsYou: (reason: string, status?: 'needs_you' | 'failed') => null,
  ): Promise<LearningImprovement | null> {
    const tool = INSTALLABLE_TOOLS.find((t) => t.id === toolId);
    if (!tool) return needsYou(`${toolId} is not in the reviewed catalog.`);
    const settings = this.d.settings.get();
    const mode = settings.execution.policyMode;
    const scope = {
      taskId: null,
      stageId: null,
      sessionId: null,
      repositoryId: null,
      cwd: os.homedir(),
      roots: [],
      stageLevel: 5 as PermissionLevel,
      autoApproveUpToLevel: policyCeiling(mode, settings.autoApproveUpToLevel as PermissionLevel),
      mode,
      profile: 'operator' as const,
      escalated: new Set<string>(),
      protectedPaths: [],
    };
    // The operator asking from the page is a person's decision, like a typed confirmation elsewhere.
    const outcome = await this.d.tools.invoke({ capability: 'software.install', input: { toolId }, origin: 'chairman', scope, preApproved: opts.operator, timeoutMs: 15 * 60_000 });
    if (outcome.decision === 'approval') return needsYou(`Installing ${tool.name} needs your approval under the current execution policy. Use "Do it now" to install it.`);
    if (!outcome.result.ok) return needsYou(`Installing ${tool.name} failed: ${outcome.result.summary.slice(0, 300)}`, 'failed');
    await this.refreshPath();
    if (tool.providerId) await this.d.tools.health.check(tool.providerId, { force: true }).catch(() => undefined);
    const source = tool.method.kind === 'winget' ? `winget:${tool.method.packageId}` : `npm:${tool.method.packageName}`;
    return adopt('tool_installed', { title: `Installed ${tool.name}`, content: tool.id, source, contentHash: null });
  }

  /** New processes started by the orchestrator see a program installed after it started. */
  private async refreshPath(): Promise<void> {
    const env = this.d.baseEnv;
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const fresh = await refreshedPath(env).catch(() => null);
    if (fresh && fresh !== env[key]) env[key] = fresh;
  }

  // ===========================================================================
  // Operator actions
  // ===========================================================================

  /** Undo an improvement: a lesson stops being sent, a learned skill folder is deleted. */
  async undo(improvementId: string, by: 'chairman' | 'user', reason: string): Promise<LearningImprovement | null> {
    const imp = this.store.improvement(improvementId);
    if (!imp || !['trial', 'active'].includes(imp.status)) return imp;
    if ((SKILL_KINDS as readonly string[]).includes(imp.kind)) await this.managed.remove(imp.scope, imp.repositoryId, imp.content).catch(() => undefined);
    const note = imp.kind === 'tool_installed' ? ' The program stays installed; remove it from Windows Settings → Apps if you do not want it.' : '';
    const updated = this.store.updateImprovement(imp.id, { status: by === 'chairman' ? 'ineffective' : 'reverted', reason: `${reason}${note}`, revertedBy: by });
    if (imp.findingId) this.store.setFindingStatus(imp.findingId, by === 'chairman' ? 'failed' : 'dismissed', by === 'chairman' ? reason : 'Undone by you.');
    this.store.log({ kind: 'reverted', taskId: null, findingId: imp.findingId, improvementId: imp.id, message: `${by === 'chairman' ? 'The Chairman undid' : 'You undid'} "${imp.title}". ${reason}` });
    this.publish('improvement', null);
    return updated;
  }

  dismiss(findingId: string): LearningFinding | null {
    const finding = this.store.finding(findingId);
    if (!finding || finding.status === 'adopted') return finding;
    const updated = this.store.setFindingStatus(findingId, 'dismissed', 'Dismissed by you.');
    this.store.log({ kind: 'dismissed', taskId: null, findingId, improvementId: null, message: `You dismissed "${finding.title}".` });
    this.publish('finding', null);
    return updated;
  }

  /** "Do it now" from the page: the operator's decision replaces the threshold and the autonomy setting. */
  async actNow(findingId: string): Promise<{ finding: LearningFinding | null; improvement: LearningImprovement | null }> {
    const finding = this.store.finding(findingId);
    if (!finding) return { finding: null, improvement: null };
    if (!finding.proposal || finding.status === 'adopted') return { finding, improvement: null };
    // Reopen so a finding that was waiting or needed you can be carried out.
    this.store.setFindingStatus(findingId, 'open', null);
    const improvement = await this.act({ ...finding, status: 'open' }, { taskId: null, operator: true });
    return { finding: this.store.finding(findingId), improvement };
  }

  // ===========================================================================
  // What later runs receive
  // ===========================================================================

  /**
   * The "Lessons from earlier tasks" section for a stage prompt. Claude Code
   * runs load learned skills through `--plugin-dir`; other agents get the
   * file to read. Empty when nothing is live for the repository.
   */
  promptSection(task: TaskRecord, _def: StageDefinition, stage: StageInstance): string {
    const live = this.store.liveFor(task.repositoryId);
    const lessons = live.filter((i) => (LESSON_KINDS as readonly string[]).includes(i.kind)).slice(0, MAX_LESSONS_PER_SCOPE);
    const skills = live.filter((i) => (SKILL_KINDS as readonly string[]).includes(i.kind) && this.managed.exists(i.scope, i.repositoryId, i.content));
    if (!lessons.length && !skills.length) return '';
    const loads = stage.agentId === 'claude';
    const lines = [
      ...lessons.map((l) => `- ${l.content}`),
      ...skills.map((s) => {
        const invoked = this.managed.invokedName(s.scope, s.content);
        const what = s.title.includes(' — ') ? s.title.slice(s.title.indexOf(' — ') + 3) : s.title;
        return loads ? `- Skill /${invoked} is loaded for this run: ${what}` : `- Playbook for ${what}: read ${path.resolve(this.managed.skillFile(s.scope, s.repositoryId, s.content))}`;
      }),
    ].slice(0, MAX_PROMPT_LINES);
    return [
      '',
      '## Lessons from earlier tasks',
      '',
      'The Chairman learned these from earlier tasks here. They are advice: this task\'s request, the operator\'s directives and your permission limits always come first.',
      '',
      ...lines,
      '',
    ].join('\n');
  }

  /** Managed plugin folders for a stage run in this task's repository. */
  pluginDirs(task: TaskRecord): Promise<string[]> {
    return this.managed.pluginDirs(task.repositoryId);
  }

  // ===========================================================================
  // Views
  // ===========================================================================

  overview(): LearningOverview {
    const improvements = this.store.listImprovements({ limit: 200 });
    const findings = this.store.listFindings({ limit: 200 });
    const reviews = this.store.listReviews(50).map((r) => ({ ...r, taskTitle: this.d.store.getTask(r.taskId)?.title ?? null }));
    const cfg = this.settings();
    return {
      settings: cfg,
      counts: {
        improvementsLive: improvements.filter((i) => i.status === 'trial' || i.status === 'active').length,
        findingsOpen: findings.filter((f) => f.status === 'open').length,
        needsYou: findings.filter((f) => f.status === 'needs_you').length,
        reviewed: this.store.reviewCount(),
        actionsToday: this.store.actionsSince(startOfToday()),
      },
      improvements,
      findings,
      reviews,
      log: this.store.listLog(100),
      reviewerUnavailable: cfg.reviewWithModel ? this.d.chairman.reasoner.unavailableReason() : 'Model reviews are turned off in Settings; the rules still review.',
    };
  }

  taskView(taskId: string): { review: LearningReview | null; findings: LearningFinding[] } {
    const review = this.store.review(taskId);
    return { review, findings: (review?.findingIds ?? []).map((id) => this.store.finding(id)).filter((f): f is LearningFinding => f !== null) };
  }
}
