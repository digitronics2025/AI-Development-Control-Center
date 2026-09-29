import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { runShell } from '@acc/executor';
import {
  addDetachedWorktree,
  removeWorktree,
  git,
  headCommit,
  changedPaths,
  changesSince,
  commitsInRange,
  fetchBranch,
  isAncestor,
  listRemotes,
  pushRef,
  remoteBranchHead,
  revParse,
  status,
  treeOfCommit,
} from '@acc/git';
import { alwaysRequiresApproval, redact, sanitizeEnv } from '@acc/security';
import {
  PRODUCTION_BRANCH_NAMES,
  RELEASE_STATE_LABEL,
  nonBlockingFailure,
  supersededRun,
  type ActiveReleaseConfig,
  type CloudflareReleaseConfig,
  type EventType,
  type ReleaseEvidence,
  type ReleaseSetupCheck,
  type StageInstance,
  type TaskRelease,
  type TestRun,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import { matchesAny } from '../chairman/rules.js';
import type { ApprovalGate } from '../engine/approvals.js';
import { stageCommandRisk } from '../engine/command-risk.js';
import type { Publisher } from '../engine/publisher.js';
import { taskRepositoryView } from '../engine/task-checks.js';
import { isMultiRepository } from '../engine/task-repositories.js';
import type { EngineTooling } from '../engine/tooling.js';
import type { TaskViews } from '../engine/views.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { RepositoryCoordinator } from '../services/repository-coordinator.js';
import { detectToolingSync, type RepositoryService } from '../services/repositories.js';
import type { SettingsService } from '../services/settings.js';
import { scanOutgoing } from '../source-control/preflight.js';
import { newId, now, type ApprovalRecord, type RepositoryRecord, type Store, type TaskRecord } from '../store/store.js';

/**
 * Releases (docs/plans/RELEASE_STAGE_PLAN.md, docs/systems/release.md): send
 * a task's tested commit live after one typed approval, and say Live only
 * when the hosting provider (or a version URL) shows that exact commit.
 *
 * Nothing is sent before every check in steps 1–3 passes, and the only write
 * is step 4: a fast-forward push of one commit from the repository folder,
 * never forced, that never switches a branch or touches a working tree.
 *
 * A direct Cloudflare release (docs/plans/CLOUDFLARE_DIRECT_RELEASE_PLAN.md)
 * also builds that commit in a throwaway checkout before anything is sent,
 * and after the push uploads the build to a Cloudflare Pages project — created
 * on the first release — through the tool layer, as the approval allowed.
 */

/** What one GET of a public URL returned; never carries a cookie or a token. */
export interface ProbeResult {
  status: number | null;
  body: string;
  error: string | null;
}
export type Probe = (url: string) => Promise<ProbeResult>;

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MAX_BYTES = 64 * 1024;

/** GET without credentials, redirects not followed (a 3xx still says the site answers), body capped. */
export const httpProbe: Probe = async (url) => {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { 'user-agent': 'AI-Development-Control-Center release check', 'cache-control': 'no-cache', pragma: 'no-cache' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    let body = '';
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      for (let read = 0; read < PROBE_MAX_BYTES; ) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        body += decoder.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);
    }
    return { status: res.status, body: body.slice(0, PROBE_MAX_BYTES), error: null };
  } catch (error) {
    return { status: null, body: '', error: (error as Error).name === 'TimeoutError' ? `no answer within ${PROBE_TIMEOUT_MS / 1000}s` : ((error as Error).message || 'request failed') };
  }
};

/** Does a response body name the commit: its full id, or a prefix of 7 or more characters? */
export function bodyNamesCommit(body: string, sha: string): boolean {
  const target = sha.toLowerCase();
  for (const token of body.match(/[0-9a-f]{7,64}/gi) ?? []) if (target.startsWith(token.toLowerCase())) return true;
  return false;
}

/**
 * Trees a task's checks passed on, for one repository (§3.3): for every Test
 * stage that succeeded, the tree its last check ran on, provided each of its
 * checks passed or only failed as it already did before the task
 * (AUTOPILOT_GATES_PLAN §3.B). A check that changed the files records no tree,
 * so a stage ending on one proves nothing about what is committed.
 */
export function testedTrees(store: Store, task: TaskRecord, repositoryId: string): Set<string> {
  const trees = new Set<string>();
  const all = store.listTestRuns(task.id);
  for (const stage of store.listStages(task.id)) {
    if (stage.kind !== 'tests' || stage.status !== 'SUCCESS') continue;
    const rows = all.filter((r) => r.stageId === stage.id && (r.repositoryId ?? task.repositoryId) === repositoryId && !r.summary?.startsWith('Repair: ') && !r.summary?.startsWith('Re-run: ') && !supersededRun(r));
    if (!rows.length) continue;
    const counts = (r: TestRun) => r.status === 'passed' || nonBlockingFailure(r);
    if (!rows.every(counts)) continue;
    const last = [...rows].sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '')).at(-1)!;
    if (last.treeId) trees.add(last.treeId);
  }
  return trees;
}

/**
 * Whether the task's last passing Test stage ran only the unit tests affected by the
 * change in this repository, so the approval can say so (AFFECTED_TESTS_PLAN §3.5).
 */
export function affectedOnly(store: Store, task: TaskRecord, repositoryId: string): boolean {
  const stage = [...store.listStages(task.id)].reverse().find((s) => s.kind === 'tests' && s.status === 'SUCCESS');
  if (!stage) return false;
  const tests = store.listTestRuns(task.id, stage.id).filter((r) => r.kind === 'test' && (r.repositoryId ?? task.repositoryId) === repositoryId && !supersededRun(r) && !r.summary?.startsWith('Re-run: '));
  return tests.length > 0 && tests.every((r) => r.selection === 'changed');
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');
const IN_FLIGHT: ReadonlySet<TaskRelease['state']> = new Set(['publishing', 'proving']);

export interface ReleaseDeps {
  store: Store;
  bus: Bus;
  views: TaskViews;
  publisher: Publisher;
  approvals: ApprovalGate;
  coordinator: RepositoryCoordinator;
  repositories: RepositoryService;
  artifacts: ArtifactService;
  tooling: EngineTooling;
  settings: SettingsService;
  /** The orchestrator's data folder: direct releases build under `<dataDir>/releases`. */
  dataDir: string;
  /** The environment a build runs with, sanitized like every repository command's. */
  baseEnv: NodeJS.ProcessEnv;
  probe?: Probe;
  /** Seconds between two proof reads (15 in production; tests shorten it). */
  pollSeconds?: number;
}

export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID_STATE',
  ) {
    super(message);
  }
}

interface RunOptions {
  via: TaskRelease['via'];
  approvalId: string | null;
  stageId: string;
  /** The engine asked the stage to stop (pause, cancel, shutdown). */
  stopped?: () => boolean;
}

/** A check that stopped the release before anything was sent. */
class Refusal extends Error {}
/** The target branch moved since the task's base: the Release stage may update the task from it (§9). */
class Moved extends Refusal {}

/** How many times one task may be updated from the target branch before the release is left to the operator. */
export const MAX_UPDATES_FROM_TARGET = 3;

export class ReleaseService {
  private readonly running = new Set<string>();
  /** Releases and checks started outside the engine loop (the button, Check again), awaited on shutdown. */
  private readonly background = new Set<Promise<unknown>>();
  private closing = false;
  private readonly probe: Probe;
  private readonly pollMs: number;

  constructor(private readonly d: ReleaseDeps) {
    this.probe = d.probe ?? httpProbe;
    this.pollMs = (d.pollSeconds ?? 15) * 1000;
  }

  /** The repository's release setting, or null when it does not release. */
  config(repo: RepositoryRecord): ActiveReleaseConfig | null {
    return repo.release.method === 'none' ? null : repo.release;
  }

  /** What proves a release live: the same reads for both methods. */
  private proofOf(config: ActiveReleaseConfig, liveUrl: string): ProofConfig {
    return config.method === 'push'
      ? { liveUrl: config.liveUrl, proof: config.proof, timeoutSec: config.timeoutSec }
      : { liveUrl, proof: { cloudflarePages: { project: config.pages.project } }, timeoutSec: config.timeoutSec };
  }

  /** Where a release goes, as its record keeps it. */
  private targetOf(config: ActiveReleaseConfig): TaskRelease['target'] {
    return config.method === 'push'
      ? { remote: config.remote, branch: config.branch, liveUrl: config.liveUrl, method: 'push' }
      : { remote: config.remote, branch: config.branch, liveUrl: this.liveUrlOf(config, null), method: 'cloudflare', project: config.pages.project };
  }

  /** A direct release's live address: the one set, else the project's own pages.dev address. */
  private liveUrlOf(config: CloudflareReleaseConfig, site: PagesSite | null): string {
    return config.liveUrl ?? `https://${site?.subdomain ?? `${config.pages.project}.pages.dev`}/`;
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Why a Release stage has nothing to do — decided before any approval is asked (§3.5) — or null. */
  skipReason(task: TaskRecord, repo: RepositoryRecord): string | null {
    if (!this.config(repo)) return 'No release set up for this repository';
    if (isMultiRepository(this.d.store, task)) return 'A task across several repositories is not released this way; release each repository yourself';
    if (!task.git.commits.length) return 'Nothing was committed, so there is nothing to release';
    return null;
  }

  /** The approval card: what is sent, where, and how Live will be proved (§3.5). */
  describe(task: TaskRecord, repo: RepositoryRecord): { action: string; reason: string; riskExplanation: string; environment: string } {
    const config = this.config(repo)!;
    const sha = short(task.git.commits.at(-1));
    const affected = affectedOnly(this.d.store, task, repo.id) ? ' Unit tests on this commit covered only the tests affected by the change.' : '';
    if (config.method === 'cloudflare') {
      const project = config.pages.project;
      const where = config.liveUrl ?? `its ${project} address`;
      return {
        action: `Deploy ${sha} to Cloudflare Pages ${project}`,
        reason: `Releasing sends work to your live site. ${repo.name}: push ${sha} to ${config.remote}/${config.branch}, build that exact commit in a clean copy, and upload ${config.pages.outputDir} to Cloudflare Pages ${project} (created on the first release). Live when ${project} serves ${sha} and ${where} answers.${affected}`,
        riskExplanation: `Only the commit that passed this task's checks, built from a clean copy of it; the push is a fast-forward, never forced, and your working folder is not touched. Nothing is sent or uploaded if ${config.branch} has moved, if the live site serves a version this commit does not contain, if the build fails, if a file under ${config.manualPaths.length ? config.manualPaths.join(', ') : 'your manual paths'} changed, or if the commits include secret material.`,
        environment: 'production',
      };
    }
    const proof = [
      ...(config.proof.cloudflarePages ? [`Cloudflare Pages ${config.proof.cloudflarePages.project} builds it; Live when the project serves ${sha}`] : []),
      ...(config.proof.versionUrl ? [`Live when ${config.proof.versionUrl} shows ${sha}`] : []),
    ].join('; and ');
    return {
      action: `Push ${sha} to ${config.remote}/${config.branch}`,
      reason: `Releasing sends work to your live site. ${repo.name}: push ${sha} to ${config.remote}/${config.branch}. ${proof}, and ${config.liveUrl} answers.${affected}`,
      riskExplanation: `Only a fast-forward push of the commit that passed this task's checks; never forced, and your working folder is not touched. Nothing is sent if ${config.branch} has moved, if a file under ${config.manualPaths.length ? config.manualPaths.join(', ') : 'your manual paths'} changed, if the commits include secret material, or if the live site is not answering.`,
      environment: 'production',
    };
  }

  // ===========================================================================
  // The release (steps 1–6)
  // ===========================================================================

  /** Run a release the operator approved. Never throws for a refusal: the record says what happened. */
  async release(taskId: string, opts: RunOptions): Promise<TaskRelease> {
    if (this.running.has(taskId)) throw new ReleaseError('A release of this task is already running', 'INVALID_STATE');
    this.running.add(taskId);
    try {
      return await this.run(taskId, opts);
    } finally {
      this.running.delete(taskId);
    }
  }

  private async run(taskId: string, opts: RunOptions): Promise<TaskRelease> {
    const task = this.task(taskId);
    const repo = this.repo(task);
    const config = this.config(repo);
    const cf = config?.method === 'cloudflare' ? config : null;
    const sha = task.git.commits.at(-1) ?? null;
    let record: TaskRelease = {
      state: 'publishing',
      commit: sha ?? '',
      tree: null,
      target: config ? this.targetOf(config) : { remote: '', branch: '', liveUrl: '' },
      via: opts.via,
      approvalId: opts.approvalId,
      requestedAt: now(),
      publishedAt: null,
      liveConfirmedAt: null,
      evidence: {},
      reason: null,
    };
    const log: string[] = [
      `# Release of ${task.id}`,
      '',
      `- Commit: ${sha ?? '—'}`,
      `- Target: ${record.target.remote}/${record.target.branch}`,
      ...(cf ? [`- Deploy: Cloudflare Pages ${cf.pages.project}, ${cf.pages.outputDir} built from the commit`] : []),
      `- Live URL: ${record.target.liveUrl}`,
      `- Started by: ${opts.via === 'stage' ? 'the Release stage' : 'the Release button'}, approved by you`,
      '',
    ];
    const step = (line: string) => log.push(`- ${line}`);
    this.save(taskId, record);
    this.event(taskId, 'RELEASE_APPROVED', `Release approved: ${short(sha)} to ${record.target.remote}/${record.target.branch}${cf ? ` and Cloudflare Pages ${cf.pages.project}` : ''}`, { commit: sha, target: record.target, approvalId: opts.approvalId, approvedBy: 'operator' }, opts.stageId);

    let unlock: (() => void) | null = null;
    let build: Build | null = null;
    let site: PagesSite | null = null;
    let alreadyLive = false;
    try {
      if (!config) throw new Refusal('No release is set up for this repository any more.');
      if (!sha) throw new Refusal('Nothing was committed, so there is nothing to release.');
      if (isMultiRepository(this.d.store, task)) throw new Refusal('A task across several repositories is not released this way.');

      if (cf) {
        // Before the lock: the project as Cloudflare has it, and the build — minutes of work that must not hold
        // Source Control up. Only a tested commit is built.
        record.tree = await this.testedTree(task, repo, sha);
        site = await this.pagesSite(task, repo, cf.pages.project);
        if (site.exists && site.productionBranch && !isProductionName(site.productionBranch)) {
          throw new Refusal(`Cloudflare Pages ${cf.pages.project} treats "${site.productionBranch}" as its production branch, which is not a production branch name (${PRODUCTION_BRANCH_NAMES.join(', ')}). Rename it on Cloudflare, or release by push.`);
        }
        record = { ...record, target: { ...record.target, liveUrl: this.liveUrlOf(cf, site) } };
        step(
          site.exists
            ? `Cloudflare Pages ${cf.pages.project} exists (production branch ${site.productionBranch ?? '?'}) and serves ${site.live ? short(site.live.commit) : 'nothing yet'}.`
            : `Cloudflare Pages ${cf.pages.project} does not exist yet: this release creates it (production branch ${cf.branch}).`,
        );
        alreadyLive = Boolean(site.live?.commit && sameCommit(site.live.commit, sha) && site.live.stage === 'deploy' && site.live.status === 'success');
        if (alreadyLive) step(`${cf.pages.project} already serves ${short(sha)}: nothing to build or upload.`);
        else build = await this.build(task, repo, cf, sha, step, opts);
      }

      // Steps 1–4 hold the repository's writer lock: no Source Control mutation runs meanwhile.
      unlock = await this.d.coordinator.acquireWriter(repo.id, task.id, 'Release');

      // 1. Resolve: the commit carries every change the task made.
      if (task.status !== 'COMPLETED') {
        const workdir = task.git.worktreePath && existsSync(task.git.worktreePath) ? task.git.worktreePath : task.git.isolated ? null : repo.path;
        const baseline = task.git.baselineSnapshotId ? this.d.store.getSnapshot(task.git.baselineSnapshotId) : null;
        if (workdir && baseline) {
          // Uncommitted now: anything not committed beyond what you already had uncommitted when the task started,
          // plus your files the task changed again (the Git checkpoint leaves those for you).
          const preexisting = new Set(task.git.preexistingChanges);
          const uncommitted = (await status(workdir)).map((e) => e.path).filter((p) => !preexisting.has(p));
          const mixed = preexisting.size ? (await changesSince(workdir, baseline)).filter((f) => f.origin === 'both').map((f) => f.path) : [];
          const pending = [...new Set([...uncommitted, ...mixed])];
          if (pending.length) throw new Refusal(`Some changes were never committed or tested: ${list(pending)}.`);
        }
      }
      step(`Commit ${sha} is the task's last commit.`);

      // 2. Tested: exactly the files the checks passed on.
      const tree = await this.testedTree(task, repo, sha);
      record.tree = tree;
      step(`Its files are exactly the ones this task's checks passed on (tree ${short(tree)}).`);

      // 3. Safe to publish.
      if (!(await listRemotes(repo.path)).includes(config.remote)) throw new Refusal(`${repo.name} has no remote named "${config.remote}".`);
      const fetched = await fetchBranch(repo.path, config.remote, config.branch);
      if (fetched.code !== 0) throw new Refusal(`Could not read ${config.remote}/${config.branch}: ${gitMessage(fetched)}`);
      const remoteSha = await revParse(repo.path, `refs/remotes/${config.remote}/${config.branch}`);
      if (!remoteSha) throw new Refusal(`${config.remote} has no branch ${config.branch}.`);
      const already = remoteSha === sha;
      if (!already) {
        if (!(await isAncestor(repo.path, remoteSha, sha))) throw new Moved(`${config.branch} has moved since this task started. Update the task and re-test first.`);
        const outgoing = await commitsInRange(repo.path, remoteSha, sha);
        const foreign = outgoing.filter((c) => !task.git.commits.includes(c));
        if (foreign.length) {
          throw new Refusal(`${foreign.length} commit${foreign.length === 1 ? '' : 's'} that ${foreign.length === 1 ? 'was' : 'were'} not made by this task would go out with it (${foreign.slice(0, 5).map(short).join(', ')}${foreign.length > 5 ? ', …' : ''}): they were on your branch before the task started and were never sent. Send ${foreign.length === 1 ? 'it' : 'them'} yourself first, then release.`);
        }
        const manual = (await changedPaths(repo.path, remoteSha, sha)).filter((p) => matchesAny(p, config.manualPaths));
        if (manual.length) throw new Refusal(`These need a manual step (for example a database migration): ${list(manual)}.`);
        const scan = await scanOutgoing(repo.path, sha, remoteSha);
        if (scan.truncated) throw new Refusal('The commits to send are too large to check for secrets (over 20 MB).');
        if (scan.findings.length) throw new Refusal(`The commits to send include secret material: ${scan.findings.slice(0, 10).map((f) => `${f.path} (${f.reason})`).join('; ')}. Remove it before releasing.`);
        step(`${config.branch} on ${config.remote} is at ${short(remoteSha)}, an ancestor: ${outgoing.length} commit${outgoing.length === 1 ? '' : 's'} of this task go out, no manual path changed, no secret found.`);
      } else {
        step(`${config.remote}/${config.branch} is already at ${short(sha)}: nothing to push${cf ? '' : ', only the proof runs'}.`);
      }
      if (cf) {
        // An upload replaces what is live: never with a commit that lacks it (another task's, a manual upload's).
        const live = site!.live;
        if (live?.commit && !alreadyLive) {
          const known = await revParse(repo.path, `${live.commit}^{commit}`);
          if (!known || !(known === sha || (await isAncestor(repo.path, known, sha)))) {
            throw new Refusal(`The live site serves ${short(live.commit)}, which this commit does not contain: uploading it would take that version down. Bring ${short(live.commit)} into ${config.branch} first, then release.`);
          }
        }
        record.evidence.before = site!.exists ? { deploymentId: live?.id ?? null, commit: live?.commit ?? null } : null;
        if (live) {
          const up = await this.upCheck(record.target.liveUrl);
          record.evidence.up = up;
          if (!up.ok) throw new Refusal(`The live site isn't answering (${up.note}); nothing was sent.`);
          step(`${record.target.liveUrl} answers (${up.note}); it serves ${short(live.commit)} now.`);
        } else step('Nothing is live on Cloudflare yet: this is the first deployment.');
      } else if (config.method === 'push') {
        const up = await this.upCheck(config.liveUrl);
        record.evidence.up = up;
        if (!up.ok) throw new Refusal(`The live site isn't answering (${up.note}); nothing was sent.`);
        step(`${config.liveUrl} answers (${up.note}).`);
        if (config.proof.cloudflarePages) {
          const before = await this.pagesStatus(task, repo, config.proof.cloudflarePages.project, null);
          record.evidence.before = before.ok ? { deploymentId: before.live?.id ?? null, commit: before.live?.commit ?? null } : null;
          step(before.ok ? `Before: ${config.proof.cloudflarePages.project} served ${short(before.live?.commit)} (deployment ${before.live?.id.slice(0, 8) ?? '—'}).` : `Before: Cloudflare could not be read (${before.note}).`);
        }
      }
      if (opts.stopped?.()) throw new Refusal('Stopped before anything was sent.');

      // 4. Publish: the push, then (direct release) the upload.
      if (!already) {
        const push = await pushRef(repo.path, { sha, remote: config.remote, remoteRef: `refs/heads/${config.branch}`, setUpstream: false });
        if (push.code !== 0) {
          record = { ...record, state: 'failed', reason: `${config.remote} refused the push: ${gitMessage(push)}` };
          step(record.reason!);
          return await this.finish(taskId, record, opts.stageId, log);
        }
      }
      unlock();
      unlock = null;
      this.d.repositories.invalidate(repo.id);
      step(already ? `Already on ${config.remote}/${config.branch}.` : `Pushed ${sha} to ${config.remote}/${config.branch} (fast-forward).`);
      record = { ...record, publishedAt: now() };
      if (cf && build) {
        const deployed = await this.deployPages(task, repo, cf, site!, build, sha);
        record.evidence.deploy = deployed.evidence;
        if (!deployed.ok) {
          record = { ...record, state: 'failed', reason: `Sent ${short(sha)} to ${config.remote}/${config.branch}, but Cloudflare did not take the upload: ${deployed.evidence.note}. The previous version stays live; release again to retry the upload.` };
          step(record.reason!);
          return await this.finish(taskId, record, opts.stageId, log);
        }
        if (deployed.subdomain && !cf.liveUrl) record = { ...record, target: { ...record.target, liveUrl: `https://${deployed.subdomain}/` } };
        step(`Uploaded ${deployed.evidence.files ?? '?'} files from ${cf.pages.outputDir} to Cloudflare Pages ${cf.pages.project}${deployed.evidence.created ? ' (created it)' : ''}${deployed.evidence.url ? `: ${deployed.evidence.url}` : ''}.`);
      }
      record = { ...record, state: 'proving' };
      this.save(taskId, record);
      const sent = already ? `${short(sha)} was already on ${config.remote}/${config.branch}` : `Sent ${short(sha)} to ${config.remote}/${config.branch}`;
      this.event(taskId, 'RELEASE_PUBLISHED', `${sent}${cf && build ? ` and uploaded it to Cloudflare Pages ${cf.pages.project}` : ''}; checking that it is live`, { commit: sha, target: record.target }, opts.stageId);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      record = { ...record, state: 'refused', reason: error.message, refusal: error instanceof Moved ? 'moved' : null };
      step(`Refused: ${error.message} Nothing was sent.`);
      return await this.finish(taskId, record, opts.stageId, log);
    } finally {
      unlock?.();
      if (build) await this.discardBuild(repo, build.dir);
    }

    // 5–6. Prove, outside the lock: Source Control stays usable while the host builds.
    record = await this.prove(taskId, record, this.proofOf(config, record.target.liveUrl), opts);
    step(this.outcomeLine(record));
    return this.finish(taskId, record, opts.stageId, log);
  }

  /** Step 2: the commit's files are the ones a Test stage of this task passed on; its tree, or a refusal. */
  private async testedTree(task: TaskRecord, repo: RepositoryRecord, sha: string): Promise<string> {
    const tree = await treeOfCommit(repo.path, sha);
    if (!tree) throw new Refusal(`Commit ${short(sha)} is not in ${repo.name} any more.`);
    const tested = testedTrees(this.d.store, task, repo.id);
    if (!tested.size) throw new Refusal('No record of which version passed the checks — run the checks again.');
    if (!tested.has(tree)) throw new Refusal('This commit is not the version that passed the checks. Run the checks again on it, then release.');
    return tree;
  }

  // ===========================================================================
  // Direct Cloudflare release: the project, the build, the upload
  // ===========================================================================

  /** The Pages project as Cloudflare has it now (a missing one is `exists: false`); a refusal when it cannot be read. */
  private async pagesSite(task: TaskRecord, repo: RepositoryRecord, project: string): Promise<PagesSite> {
    const outcome = await this.d.tooling.tools.invoke({
      capability: 'cloudflare.pages_status',
      input: { project },
      origin: 'engine',
      scope: { ...this.d.tooling.scope(task, repo, { level: 1, stageId: task.currentStageId }), profile: 'operator' },
      preApproved: true,
      timeoutMs: 60_000,
    });
    const r = outcome.result;
    if (r.ok) {
      const out = r.output as { productionBranch?: string | null; subdomain?: string | null; live?: PagesDeployment | null } | undefined;
      return { exists: true, productionBranch: out?.productionBranch ?? null, subdomain: out?.subdomain ?? null, live: out?.live ?? null };
    }
    if (r.error?.code === 'NOT_FOUND') return { exists: false, productionBranch: null, subdomain: null, live: null };
    throw new Refusal(`Cloudflare could not be read (${redact(r.error?.message ?? r.summary).slice(0, 300)}); nothing was sent.`);
  }

  /** Where direct releases build: `<dataDir>/releases`, emptied at every start. */
  private buildRoot(): string {
    return path.join(this.d.dataDir, 'releases');
  }

  /**
   * Build the commit in a throwaway checkout: dependencies from its lockfile,
   * then the repository's build commands as detected in those very files —
   * only ones that need no approval — and the output folder must hold files.
   * A refusal (nothing is sent yet) for anything that goes wrong.
   */
  private async build(task: TaskRecord, repo: RepositoryRecord, config: CloudflareReleaseConfig, sha: string, step: (line: string) => void, opts: Pick<RunOptions, 'stopped'>): Promise<Build> {
    const slug = `${repo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${repo.id.slice(0, 6)}`;
    const dir = path.join(this.buildRoot(), slug, `${sha.slice(0, 12)}-${randomBytes(3).toString('hex')}`);
    mkdirSync(path.dirname(dir), { recursive: true });
    try {
      await addDetachedWorktree(repo.path, dir, sha);
    } catch (error) {
      throw new Refusal(`A clean copy of ${short(sha)} could not be made to build it: ${redact((error as Error).message).slice(0, 300)}`);
    }
    try {
      const prepared = await this.d.tooling.prepareDetached(task, repo, dir);
      if (!prepared.ok) throw new Refusal(`Its dependencies could not be installed from the lockfile: ${redact(prepared.summary).slice(0, 300)}`);
      const builds = taskRepositoryView(repo, dir).commands.filter((c) => c.enabled && c.kind === 'build');
      const { env } = sanitizeEnv(this.d.baseEnv, this.d.settings.get().billingMode);
      for (const command of builds) {
        const shown = redact(command.command);
        const risk = stageCommandRisk(dir, command.command, [config.branch]);
        if (alwaysRequiresApproval(risk) || risk.level > 4) throw new Refusal(`The build command "${shown}" is Level ${risk.level} (${risk.reasons.join(', ')}): a release runs only a build that needs no approval.`);
        const tail: string[] = [];
        const handle = runShell({
          commandLine: command.command,
          cwd: dir,
          env,
          timeoutMs: command.timeoutSec * 1000,
          onLine: (_stream, line) => {
            tail.push(redact(line));
            if (tail.length > 40) tail.shift();
          },
        });
        const watch = setInterval(() => (this.closing || opts.stopped?.()) && void handle.cancel(), 500);
        const result = await handle.done.finally(() => clearInterval(watch));
        if (result.cancelled) throw new Refusal('Stopped while building; nothing was sent.');
        if (result.spawnError) throw new Refusal(`The build command "${shown}" could not start: ${result.spawnError}`);
        if (result.timedOut) throw new Refusal(`The build command "${shown}" took longer than ${command.timeoutSec}s.`);
        if (result.exitCode !== 0) throw new Refusal(`The build failed ("${shown}", exit ${result.exitCode}): ${tail.slice(-8).join(' | ').slice(0, 600)}`);
        step(`Built with "${shown}" in a clean copy of ${short(sha)}.`);
      }
      const output = path.join(dir, config.pages.outputDir);
      const files = countFiles(output, PAGES_MAX_FILES + 1);
      if (!files) throw new Refusal(builds.length ? `The build left nothing in ${config.pages.outputDir}: nothing to upload.` : `No build command, and ${config.pages.outputDir} is not in the commit: nothing to upload.`);
      if (files > PAGES_MAX_FILES) throw new Refusal(`${config.pages.outputDir} holds more than ${PAGES_MAX_FILES} files, over Cloudflare Pages' limit.`);
      step(`${config.pages.outputDir} holds ${files} file${files === 1 ? '' : 's'} to upload.`);
      return { dir, files };
    } catch (error) {
      await this.discardBuild(repo, dir);
      throw error;
    }
  }

  private async discardBuild(repo: RepositoryRecord, dir: string): Promise<void> {
    await removeWorktree(repo.path, dir, { force: true }).catch(() => false);
    // Only ever a folder under <dataDir>/releases.
    if (existsSync(dir) && isInside(this.buildRoot(), dir)) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => undefined);
  }

  /**
   * The upload (step 4, after the push): create the project on the first
   * release, then upload the build to its production branch with the commit
   * recorded on the deployment. Both calls go through the tool layer with the
   * repository's Cloudflare key, confined to the build folder; the typed
   * approval of this release is the approval they need.
   */
  private async deployPages(task: TaskRecord, repo: RepositoryRecord, config: CloudflareReleaseConfig, site: PagesSite, build: Build, sha: string): Promise<{ ok: boolean; subdomain: string | null; evidence: NonNullable<ReleaseEvidence['deploy']> }> {
    const project = config.pages.project;
    const { repositories: _r, ...base } = this.d.tooling.scope(task, repo, { level: 5, stageId: task.currentStageId, cwd: build.dir, profile: 'operator' });
    const scope = { ...base, roots: [build.dir], protectedPaths: [] };
    const evidence = (note: string, extra: Partial<NonNullable<ReleaseEvidence['deploy']>> = {}): NonNullable<ReleaseEvidence['deploy']> => ({ project, created: false, files: build.files, url: null, note: redact(note).slice(0, 400), ...extra });
    let created = false;
    let branch = site.productionBranch ?? config.branch;
    if (!site.exists) {
      const made = await this.d.tooling.tools.invoke({ capability: 'cloudflare.pages_project_create', input: { project, productionBranch: config.branch }, origin: 'engine', scope, preApproved: true, timeoutMs: 180_000 });
      if (!made.result.ok) return { ok: false, subdomain: null, evidence: evidence(`the project could not be created: ${made.result.error?.message ?? made.result.summary}`) };
      created = true;
      branch = config.branch;
    }
    const up = await this.d.tooling.tools.invoke({ capability: 'cloudflare.pages_deploy', input: { directory: config.pages.outputDir, project, branch, commitHash: sha }, origin: 'engine', scope, preApproved: true, timeoutMs: 15 * 60_000 });
    const out = up.result.output as { url?: string | null; files?: number | null } | undefined;
    if (!up.result.ok) return { ok: false, subdomain: null, evidence: evidence(up.result.error?.message ?? up.result.summary, { created }) };
    // A new project's address is known only once it exists (`<name>-xyz.pages.dev` when the plain name was taken).
    const after = created ? await this.pagesSite(task, repo, project).catch(() => null) : site;
    return { ok: true, subdomain: after?.subdomain ?? null, evidence: evidence(up.result.summary, { created, files: out?.files ?? build.files, url: out?.url ?? null }) };
  }

  /**
   * Step 5: poll until every configured proof holds, the provider reports the
   * build failed, the time runs out, or the engine asks the stage to stop.
   */
  private async prove(taskId: string, start: TaskRelease, config: ProofConfig, given: Pick<RunOptions, 'stopped'>): Promise<TaskRelease> {
    // A shutdown stops the proof too: the release is left Sent — not confirmed, and Check again picks it up.
    const opts = { stopped: () => this.closing || (given.stopped?.() ?? false) };
    let record = start;
    const deadline = Date.now() + config.timeoutSec * 1000;
    for (;;) {
      const task = this.task(taskId);
      const repo = this.repo(task);
      const evidence = await this.gather(task, repo, config, record.commit, record.evidence.before ?? null);
      // What the upload reported stays with the proof reads.
      record = { ...record, evidence: { ...evidence, ...(record.evidence.deploy ? { deploy: record.evidence.deploy } : {}) } };
      const pages = evidence.cloudflarePages;
      const failedBuild = pages?.candidate && ['failure', 'failed', 'canceled', 'cancelled'].includes(pages.candidate.status ?? '') && !pages.ok;
      const allOk = (!config.proof.cloudflarePages || pages?.ok) && (!config.proof.versionUrl || evidence.versionUrl?.ok) && evidence.up?.ok;
      if (allOk) return { ...record, state: 'live', liveConfirmedAt: now(), reason: null };
      if (failedBuild) return { ...record, state: 'failed', reason: `Cloudflare Pages reported the build of ${short(record.commit)} ${pages!.candidate!.stage ?? ''} ${pages!.candidate!.status}; the previous version stays live.${pages!.candidate!.url ? ` Build: ${pages!.candidate!.url}` : ''}`.replace(/\s+/g, ' ') };
      // A provider that cannot be read at all (no key, wrong account) will not start answering by waiting.
      const unreadable = config.proof.cloudflarePages && pages?.permanent && !config.proof.versionUrl;
      if (unreadable) return { ...record, state: 'published_unconfirmed', reason: `Sent, but Cloudflare could not be read to confirm it: ${pages!.note}` };
      this.save(taskId, record);
      if (opts.stopped?.()) return { ...record, state: 'published_unconfirmed', reason: `Sent; checking was stopped before it was confirmed live. Use Check again. Last seen: ${this.pending(record)}` };
      if (Date.now() >= deadline) return { ...record, state: 'published_unconfirmed', reason: `Sent, but not confirmed live within ${Math.round(config.timeoutSec / 60)} min. Last seen: ${this.pending(record)}` };
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())), opts.stopped);
    }
  }

  /** One read of every configured proof. */
  private async gather(task: TaskRecord, repo: RepositoryRecord, config: ProofConfig, sha: string, before: ReleaseEvidence['before']): Promise<ReleaseEvidence & { cloudflarePages?: (NonNullable<ReleaseEvidence['cloudflarePages']> & { permanent?: boolean }) | null }> {
    const evidence: ReleaseEvidence & { cloudflarePages?: (NonNullable<ReleaseEvidence['cloudflarePages']> & { permanent?: boolean }) | null } = { before, checkedAt: now() };
    if (config.proof.cloudflarePages) {
      const project = config.proof.cloudflarePages.project;
      const status = await this.pagesStatus(task, repo, project, sha);
      const live = status.live;
      const matches = Boolean(live && live.commit && sameCommit(live.commit, sha));
      const ok = status.ok && matches && live!.stage === 'deploy' && live!.status === 'success';
      const candidate = status.candidate && status.candidate.id !== live?.id ? { deploymentId: status.candidate.id, stage: status.candidate.stage, status: status.candidate.status, url: status.candidate.url } : null;
      evidence.cloudflarePages = {
        project,
        ok,
        deploymentId: live?.id ?? null,
        commit: live?.commit ?? null,
        stage: live?.stage ?? null,
        status: live?.status ?? null,
        url: live?.url ?? null,
        candidate,
        note: !status.ok
          ? status.note
          : ok
            ? `serves ${short(sha)} (deployment ${live!.id.slice(0, 8)}, deploy success)`
            : matches
              ? `the live deployment is ${short(sha)} but its ${live!.stage ?? 'stage'} is ${live!.status ?? 'unknown'}`
              : candidate
                ? `still serves ${short(live?.commit)}; the build of ${short(sha)} is at ${candidate.stage ?? '?'} ${candidate.status ?? '?'}`
                : `still serves ${short(live?.commit)}; no build of ${short(sha)} yet`,
        permanent: !status.ok && status.permanent,
      };
    }
    if (config.proof.versionUrl) {
      const r = await this.probe(config.proof.versionUrl);
      const ok = r.status !== null && r.status < 400 && bodyNamesCommit(r.body, sha);
      evidence.versionUrl = {
        url: config.proof.versionUrl,
        ok,
        status: r.status,
        excerpt: r.body ? redact(r.body.replace(/\s+/g, ' ').slice(0, 200)) : null,
        note: r.error ? `no answer: ${redact(r.error)}` : ok ? `shows ${short(sha)}` : `HTTP ${r.status}, does not show ${short(sha)}`,
      };
    }
    evidence.up = await this.upCheck(config.liveUrl);
    return evidence;
  }

  private async upCheck(url: string): Promise<NonNullable<ReleaseEvidence['up']>> {
    const r = await this.probe(url);
    const ok = r.status !== null && r.status < 500;
    return { url, ok, status: r.status, note: r.error ? `no answer: ${redact(r.error)}` : `HTTP ${r.status}` };
  }

  /** Read a Pages project's live deployment through the tool layer (Level 1, read-only, the repository's `cloudflare` key). */
  private async pagesStatus(
    task: TaskRecord,
    repo: RepositoryRecord,
    project: string,
    commit: string | null,
  ): Promise<{ ok: true; live: PagesDeployment | null; candidate: PagesDeployment | null; note: string } | { ok: false; live: null; candidate: null; note: string; permanent: boolean }> {
    try {
      const outcome = await this.d.tooling.tools.invoke({
        capability: 'cloudflare.pages_status',
        input: { project, ...(commit ? { commit } : {}) },
        origin: 'engine',
        // The operator approved this release; the read is Level 1 and needs no stage profile.
        scope: { ...this.d.tooling.scope(task, repo, { level: 1, stageId: task.currentStageId }), profile: 'operator' },
        preApproved: true,
        timeoutMs: 60_000,
      });
      const r = outcome.result;
      if (!r.ok) {
        const code = r.error?.code ?? 'FAILED';
        return { ok: false, live: null, candidate: null, note: redact(r.error?.message ?? r.summary).slice(0, 300), permanent: ['AUTH_REQUIRED', 'INVALID_INPUT', 'DENIED', 'UNKNOWN_CAPABILITY', 'NOT_INSTALLED', 'NOT_FOUND'].includes(code) || /No Cloudflare key|sees \d+ accounts/.test(r.summary) };
      }
      const out = r.output as { live?: PagesDeployment | null; candidate?: PagesDeployment | null } | undefined;
      return { ok: true, live: out?.live ?? null, candidate: out?.candidate ?? null, note: r.summary };
    } catch (error) {
      return { ok: false, live: null, candidate: null, note: redact((error as Error).message).slice(0, 300), permanent: false };
    }
  }

  private pending(record: TaskRelease): string {
    const e = record.evidence;
    return [e.cloudflarePages ? `Pages ${e.cloudflarePages.note}` : null, e.versionUrl ? `version URL ${e.versionUrl.note}` : null, e.up ? `site ${e.up.note}` : null].filter(Boolean).join('; ');
  }

  private outcomeLine(record: TaskRelease): string {
    switch (record.state) {
      case 'live':
        return `Live: ${this.pending(record)}.`;
      case 'failed':
        return `Failed: ${record.reason}`;
      default:
        return `Not confirmed: ${record.reason}`;
    }
  }

  /** Save the outcome, write the release log, and say it in the timeline. */
  private async finish(taskId: string, record: TaskRelease, stageId: string, log: string[]): Promise<TaskRelease> {
    const sha = short(record.commit);
    const where = `${record.target.remote}/${record.target.branch}`;
    const data = { commit: record.commit, target: record.target, state: record.state, evidence: record.evidence, reason: record.reason };
    const events: Record<Exclude<TaskRelease['state'], 'publishing' | 'proving'>, [EventType, string]> = {
      live: ['RELEASE_LIVE', `Live: ${record.target.liveUrl} serves ${sha}`],
      published_unconfirmed: ['RELEASE_UNCONFIRMED', `Sent ${sha} to ${where}, not confirmed live: ${record.reason ?? ''}`],
      failed: ['RELEASE_FAILED', `Release of ${sha} failed: ${record.reason ?? ''}`],
      refused: ['RELEASE_REFUSED', `Release refused, nothing sent: ${record.reason ?? ''}`],
    };
    const [type, message] = events[record.state as keyof typeof events] ?? ['RELEASE_UNCONFIRMED', `Release of ${sha}: ${record.state}`];
    this.event(taskId, type, message, data, stageId);
    const evidence = record.evidence;
    const lines = [
      ...log,
      '',
      `## Outcome: ${stateLabel(record.state)}`,
      '',
      ...(record.reason ? [record.reason, ''] : []),
      '## Evidence',
      '',
      ...(evidence.before ? [`- Before: deployment ${evidence.before.deploymentId ?? '—'} served ${evidence.before.commit ?? '—'}`] : []),
      ...(evidence.cloudflarePages ? [`- Cloudflare Pages ${evidence.cloudflarePages.project}: ${evidence.cloudflarePages.note}${evidence.cloudflarePages.url ? ` (${evidence.cloudflarePages.url})` : ''}`] : []),
      ...(evidence.deploy ? [`- Upload to Cloudflare Pages ${evidence.deploy.project}${evidence.deploy.created ? ' (created by this release)' : ''}: ${evidence.deploy.note}${evidence.deploy.url ? ` (${evidence.deploy.url})` : ''}`] : []),
      ...(evidence.versionUrl ? [`- Version URL ${evidence.versionUrl.url}: ${evidence.versionUrl.note}${evidence.versionUrl.excerpt ? ` — "${evidence.versionUrl.excerpt}"` : ''}`] : []),
      ...(evidence.up ? [`- Live URL ${evidence.up.url}: ${evidence.up.note}`] : []),
      ...(evidence.checkedAt ? [`- Checked at ${evidence.checkedAt}`] : []),
      ...(record.liveConfirmedAt ? [`- Live since ${record.liveConfirmedAt}`] : []),
      '',
    ];
    await this.d.artifacts.write(taskId, { name: 'release.md', type: 'stage-output', content: redact(lines.join('\n')), stageId, stageKey: 'release' }).catch(() => undefined);
    // Saved last: once the state reads final, the run is over (only its running mark is cleared, with no wait), so
    // Check again is accepted at once instead of answering "being checked now" while the report is written.
    this.save(taskId, record);
    return record;
  }

  // ===========================================================================
  // Update from the target branch (RELEASE_STAGE_PLAN §9)
  // ===========================================================================

  /**
   * The target branch moved while the task ran: merge it into the task's own
   * branch, in the task's isolated worktree, and move the task's baseline to
   * it, so the checks run again on what would really be sent and reviews see
   * only the task's changes. Never in the operator's folder, never with a
   * conflict (the merge is aborted and the files are named), at most
   * MAX_UPDATES_FROM_TARGET times per task.
   */
  async updateFromTarget(taskId: string, stageId: string): Promise<{ ok: true; commit: string; target: string } | { ok: false; reason: string }> {
    const task = this.task(taskId);
    const repo = this.repo(task);
    const config = this.config(repo);
    const wt = task.git.worktreePath;
    if (!config) return { ok: false, reason: 'No release is set up for this repository any more.' };
    if (!task.git.isolated || !wt || !existsSync(wt)) return { ok: false, reason: `${config.branch} has moved, and this task has no isolated worktree to update. Update the task and re-test first.` };
    const done = this.d.store.listEvents(taskId, { limit: 5000 }).filter((e) => e.type === 'GIT_COMMIT' && e.data?.updateFromTarget === true).length;
    if (done >= MAX_UPDATES_FROM_TARGET) return { ok: false, reason: `${config.branch} has moved again after ${done} updates of this task; release it when ${config.branch} is quieter.` };
    const ref = `refs/remotes/${config.remote}/${config.branch}`;
    let unlock: (() => void) | null = null;
    try {
      unlock = await this.d.coordinator.acquireWriter(repo.id, task.id, 'Update from target');
      const fetched = await fetchBranch(repo.path, config.remote, config.branch);
      if (fetched.code !== 0) return { ok: false, reason: `Could not read ${config.remote}/${config.branch}: ${gitMessage(fetched)}` };
      const target = await revParse(repo.path, ref);
      if (!target) return { ok: false, reason: `${config.remote} has no branch ${config.branch}.` };
      if ((await status(wt)).length) return { ok: false, reason: 'The task has uncommitted changes, so it cannot be updated safely. Update the task and re-test first.' };
      const message = `${task.id}: update from ${config.remote}/${config.branch}\n\nThe target branch moved while the task ran; merged so the checks run on what a release would send (AI Development Control Center).`;
      const merge = await git(wt, ['merge', '--no-edit', '--no-ff', '-m', message, target], { timeoutMs: 120_000 });
      if (merge.code !== 0) {
        const conflicted = await git(wt, ['diff', '--name-only', '--diff-filter=U']);
        await git(wt, ['merge', '--abort']);
        const files = conflicted.stdout.split('\n').filter(Boolean);
        return { ok: false, reason: files.length ? `${config.branch} moved and conflicts with this task in: ${files.slice(0, 20).join(', ')}. Resolve it in the task, then release.` : `Could not merge ${config.branch} into the task: ${gitMessage(merge)}` };
      }
      const commit = await headCommit(wt);
      if (!commit) return { ok: false, reason: 'The merge left no commit.' };
      const fresh = this.task(taskId);
      const snapshotId = newId();
      this.d.store.insertSnapshot({ id: snapshotId, taskId, stageId, kind: 'baseline', branch: fresh.git.taskBranch, head: target, files: [], createdAt: now() });
      this.d.publisher.updateTask(taskId, { git: { ...fresh.git, commits: [...fresh.git.commits, commit], baselineCommit: target, baselineSnapshotId: snapshotId } });
      this.event(taskId, 'GIT_COMMIT', `Updated from ${config.remote}/${config.branch} (${short(target)}): merged as ${short(commit)}; the task's baseline is now ${short(target)} and the checks run again`, { commit, target, updateFromTarget: true }, stageId);
      return { ok: true, commit, target };
    } finally {
      unlock?.();
      this.d.repositories.invalidate(repo.id);
    }
  }

  // ===========================================================================
  // Check again (step 5 only), the Release button, recovery, setup check
  // ===========================================================================

  /**
   * Re-run only the proof of a release that was sent (§3.5 "Check again"):
   * reads, never writes. Runs in the background; the record says the result.
   */
  checkAgain(taskId: string): TaskRelease {
    const task = this.task(taskId);
    const record = task.git.release;
    if (!record) throw new ReleaseError('This task was never released', 'INVALID_STATE');
    if (!record.publishedAt) throw new ReleaseError('Nothing was sent for this release, so there is nothing to check. Release it again instead.', 'INVALID_STATE');
    if (this.running.has(taskId)) throw new ReleaseError('This release is being checked now', 'INVALID_STATE');
    const config = this.config(this.repo(task));
    if (!config) throw new ReleaseError('No release is set up for this repository any more', 'INVALID_STATE');
    const proving: TaskRelease = { ...record, state: 'proving', reason: null };
    this.save(taskId, proving);
    this.running.add(taskId);
    const stage = this.syntheticStage(task, 'Check again');
    this.track(this.prove(taskId, proving, this.proofOf(config, record.target.liveUrl), {})
      .then((done) => this.finish(taskId, done, stage.id, [`# Check again: ${task.id}`, '', `- Commit: ${done.commit}`, `- Target: ${done.target.remote}/${done.target.branch}`, '', `- Only the proof ran; nothing was sent.`, `- ${this.outcomeLine(done)}`]))
      // Not running once the result is saved: closing the synthetic stage does not hold up another Check again.
      .finally(() => this.running.delete(taskId))
      .then((done) => this.closeStage(stage.id, done))
      .catch((error: unknown) => this.crashed(taskId, stage.id, error)));
    return proving;
  }

  /**
   * The Release button on a completed task (§3.6): the cheap checks run first,
   * so a release that would be refused is refused with its reason instead of
   * asking for an approval; otherwise a Level 5 approval with a typed task id.
   */
  async requestRelease(taskId: string): Promise<{ approval: ApprovalRecord | null; release: TaskRelease | null }> {
    const task = this.task(taskId);
    const repo = this.repo(task);
    if (task.status !== 'COMPLETED') throw new ReleaseError('Only a completed task can be released with the button; a running task releases in its Release stage', 'INVALID_STATE');
    const skip = this.skipReason(task, repo);
    if (skip) throw new ReleaseError(skip, 'INVALID_STATE');
    if (this.running.has(taskId) || (task.git.release && IN_FLIGHT.has(task.git.release.state))) throw new ReleaseError('This task is being released now', 'INVALID_STATE');
    if (task.git.release?.state === 'live' && task.git.release.commit === task.git.commits.at(-1)) throw new ReleaseError('This task is already live', 'INVALID_STATE');
    const pending = this.d.store.findApproval(taskId, 'release', {});
    if (pending?.status === 'pending') return { approval: pending, release: task.git.release ?? null };
    const refusal = await this.precheck(task, repo);
    if (refusal) {
      const record: TaskRelease = {
        state: 'refused',
        commit: task.git.commits.at(-1)!,
        tree: null,
        target: this.targetOf(this.config(repo)!),
        via: 'button',
        approvalId: null,
        requestedAt: now(),
        publishedAt: null,
        liveConfirmedAt: null,
        evidence: {},
        reason: refusal,
      };
      this.save(taskId, record);
      this.event(taskId, 'RELEASE_REFUSED', `Release refused, nothing sent: ${refusal}`, { commit: record.commit, target: record.target, reason: refusal });
      return { approval: null, release: record };
    }
    const card = this.describe(task, repo);
    const approval = this.d.approvals.requestDetached(task, {
      kind: 'release',
      stageId: null,
      stageKey: 'release',
      requestedBy: 'you (Release button)',
      action: card.action,
      permissionLevel: 5,
      risk: 'dangerous',
      reason: card.reason,
      riskExplanation: card.riskExplanation,
      environment: card.environment,
    });
    this.event(taskId, 'RELEASE_REQUESTED', `Release requested: ${card.action} — waiting for your typed approval`, { approvalId: approval.id, commit: task.git.commits.at(-1), via: 'button' });
    return { approval, release: task.git.release ?? null };
  }

  /** A decision on a Release-button approval (engine.resolveApproval hands it over). */
  onButtonDecision(approval: ApprovalRecord, decision: 'approve' | 'deny'): void {
    const task = this.task(approval.taskId);
    if (decision === 'deny') {
      this.event(task.id, 'RELEASE_DECLINED', 'Release declined; nothing was sent', { approvalId: approval.id });
      return;
    }
    const stage = this.syntheticStage(task, 'Release');
    this.track(
      this.release(task.id, { via: 'button', approvalId: approval.id, stageId: stage.id, stopped: () => this.closing })
        .then((record) => this.closeStage(stage.id, record))
        .catch((error: unknown) => this.crashed(task.id, stage.id, error)),
    );
  }

  /** The read-only part of steps 1–3, for the button: no lock, no push, no provider call. */
  private async precheck(task: TaskRecord, repo: RepositoryRecord): Promise<string | null> {
    const config = this.config(repo)!;
    const sha = task.git.commits.at(-1)!;
    const tree = await treeOfCommit(repo.path, sha);
    if (!tree) return `Commit ${short(sha)} is not in ${repo.name} any more.`;
    const tested = testedTrees(this.d.store, task, repo.id);
    if (!tested.size) return 'No record of which version passed the checks — run the checks again.';
    if (!tested.has(tree)) return 'This commit is not the version that passed the checks. Run the checks again on it, then release.';
    if (!(await listRemotes(repo.path)).includes(config.remote)) return `${repo.name} has no remote named "${config.remote}".`;
    const fetched = await fetchBranch(repo.path, config.remote, config.branch);
    if (fetched.code !== 0) return `Could not read ${config.remote}/${config.branch}: ${gitMessage(fetched)}`;
    const remoteSha = await revParse(repo.path, `refs/remotes/${config.remote}/${config.branch}`);
    if (!remoteSha) return `${config.remote} has no branch ${config.branch}.`;
    if (remoteSha !== sha && !(await isAncestor(repo.path, remoteSha, sha))) return `${config.branch} has moved since this task started. Update the task and re-test first.`;
    return null;
  }

  /**
   * After a restart (§5): a release left publishing or proving is resolved
   * without ever pushing again — published_unconfirmed when the remote branch
   * now contains the commit (or that cannot be told), failed when it does not.
   */
  async recover(): Promise<number> {
    await this.sweepBuilds();
    let resolved = 0;
    for (const task of this.d.store.listTasks({ limit: 10_000 })) {
      const record = task.git.release;
      if (!record || !IN_FLIGHT.has(record.state) || this.running.has(task.id)) continue;
      const repo = this.d.store.getRepository(task.repositoryId);
      let contains: boolean | null = null;
      if (repo && record.commit) {
        const head = await remoteBranchHead(repo.path, record.target.remote, record.target.branch).catch(() => null);
        if (head?.ok && head.sha) {
          contains = head.sha === record.commit || ((await revParse(repo.path, head.sha)) !== null && (await isAncestor(repo.path, record.commit, head.sha)));
        } else if (head?.ok) contains = false;
      }
      const next: TaskRelease =
        contains === false
          ? { ...record, state: 'failed', reason: 'The orchestrator restarted before the push reached the remote; nothing was sent. Release again.' }
          : { ...record, state: 'published_unconfirmed', publishedAt: record.publishedAt ?? now(), reason: contains ? 'The orchestrator restarted while checking that it is live. Use Check again.' : 'The orchestrator restarted during the release and the remote could not be read to tell whether it was sent. Use Check again.' };
      this.save(task.id, next);
      this.event(task.id, next.state === 'failed' ? 'RELEASE_FAILED' : 'RELEASE_UNCONFIRMED', next.reason!, { commit: record.commit, target: record.target, recovered: true });
      resolved++;
    }
    return resolved;
  }

  /**
   * Remove the build folders an interrupted direct release left (nothing
   * builds at startup), then let each repository forget those worktrees. Only
   * paths under `<dataDir>/releases` are ever deleted.
   */
  private async sweepBuilds(): Promise<number> {
    const root = this.buildRoot();
    if (!existsSync(root)) return 0;
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const name of entries) await rm(path.join(root, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => undefined);
    if (entries.length) for (const repo of this.d.store.listRepositories()) if (existsSync(repo.path)) await git(repo.path, ['worktree', 'prune']).catch(() => null);
    return entries.length;
  }

  /**
   * Check setup (§3.2): only the read-only parts — the remote and branch
   * exist, the live URL answers, the provider project can be read. Sends nothing.
   */
  async checkSetup(repo: RepositoryRecord): Promise<ReleaseSetupCheck> {
    const config = this.config(repo);
    if (!config) return { ok: false, checks: [{ name: 'Release', ok: false, detail: 'No release is set up: choose Push to a branch or Deploy to Cloudflare to set one up.' }] };
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const remotes = await listRemotes(repo.path);
    const hasRemote = remotes.includes(config.remote);
    checks.push({ name: 'Remote', ok: hasRemote, detail: hasRemote ? `${config.remote} exists` : `No remote named "${config.remote}" (remotes: ${remotes.join(', ') || 'none'})` });
    if (hasRemote) {
      const head = await remoteBranchHead(repo.path, config.remote, config.branch).catch((error: unknown) => ({ ok: false as const, result: { code: null, stdout: '', stderr: (error as Error).message } }));
      checks.push(
        head.ok
          ? { name: 'Branch', ok: head.sha !== null, detail: head.sha ? `${config.remote}/${config.branch} is at ${short(head.sha)}` : `${config.remote} has no branch ${config.branch}` }
          : { name: 'Branch', ok: false, detail: `Could not read ${config.remote}: ${gitMessage(head.result)}` },
      );
    }
    if (config.method === 'cloudflare') {
      checks.push(...(await this.checkCloudflareSetup(repo, config)));
      return { ok: checks.every((c) => c.ok), checks };
    }
    const up = await this.upCheck(config.liveUrl);
    checks.push({ name: 'Live URL', ok: up.ok, detail: `${config.liveUrl}: ${up.note}` });
    if (config.proof.cloudflarePages) {
      const project = config.proof.cloudflarePages.project;
      const status = await this.pagesStatusForRepo(repo, project);
      checks.push({ name: 'Cloudflare Pages', ok: status.ok, detail: status.ok ? status.note : `${project}: ${status.note}` });
    }
    if (config.proof.versionUrl) {
      const r = await this.probe(config.proof.versionUrl);
      const ok = r.status !== null && r.status < 400;
      checks.push({ name: 'Version URL', ok, detail: r.error ? `no answer: ${redact(r.error)}` : `HTTP ${r.status}${ok && /[0-9a-f]{7,40}/i.test(r.body) ? ', shows a commit id' : ok ? ', but no commit id in the answer' : ''}` });
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  /**
   * Check setup of a direct release: Wrangler can act for the repository's
   * Cloudflare key, the project exists or will be created, something is
   * there to build or upload, and the live site answers once there is one.
   */
  private async checkCloudflareSetup(repo: RepositoryRecord, config: CloudflareReleaseConfig): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const project = config.pages.project;
    const who = await this.readForRepo(repo, 'cloudflare.whoami', {});
    checks.push({ name: 'Wrangler', ok: who.ok, detail: who.ok ? `signed in through the repository's Cloudflare key (${who.note})` : who.note });
    const status = await this.readForRepo(repo, 'cloudflare.pages_status', { project });
    const out = status.output as { productionBranch?: string | null; subdomain?: string | null; live?: PagesDeployment | null } | undefined;
    if (status.ok) {
      const branch = out?.productionBranch ?? null;
      const named = !branch || isProductionName(branch);
      checks.push({ name: 'Cloudflare Pages', ok: named, detail: named ? `${project} exists (production branch ${branch ?? '?'}); it serves ${out?.live ? short(out.live.commit) : 'nothing yet'}` : `${project}'s production branch on Cloudflare is "${branch}", not a production branch name (${PRODUCTION_BRANCH_NAMES.join(', ')})` });
    } else if (status.code === 'NOT_FOUND') {
      checks.push({ name: 'Cloudflare Pages', ok: true, detail: `${project} does not exist yet: the first release creates it (production branch ${config.branch})` });
    } else {
      checks.push({ name: 'Cloudflare Pages', ok: false, detail: `${project}: ${status.note}` });
    }
    const detected = detectToolingSync(repo.path);
    const build = [...repo.commands.filter((c) => c.enabled && c.kind === 'build'), ...detected.commands.filter((c) => c.kind === 'build')][0] ?? null;
    const committed = countFiles(path.join(repo.path, config.pages.outputDir), 1) > 0;
    checks.push({ name: 'Build', ok: Boolean(build) || committed, detail: build ? `"${redact(build.command)}" builds ${config.pages.outputDir} from a clean copy of the commit` : committed ? `no build command: ${config.pages.outputDir} is uploaded as committed` : `no build command, and there is no ${config.pages.outputDir} folder: add a build script that writes ${config.pages.outputDir}` });
    if (config.liveUrl || out?.live) {
      const url = this.liveUrlOf(config, status.ok ? { exists: true, productionBranch: out?.productionBranch ?? null, subdomain: out?.subdomain ?? null, live: out?.live ?? null } : null);
      const up = await this.upCheck(url);
      checks.push({ name: 'Live URL', ok: up.ok, detail: `${url}: ${up.note}` });
    }
    return checks;
  }

  /** A read-only tool call with a repository scope only (no task), for Check setup. */
  private async readForRepo(repo: RepositoryRecord, capability: string, input: Record<string, unknown>): Promise<{ ok: boolean; note: string; code: string | null; output: unknown }> {
    try {
      const outcome = await this.d.tooling.tools.invoke({ capability, input, origin: 'operator', scope: this.d.tooling.repositoryScope(repo, 1), preApproved: true, timeoutMs: 60_000 });
      const r = outcome.result;
      return { ok: r.ok, note: redact(r.ok ? r.summary : (r.error?.message ?? r.summary)).slice(0, 300), code: r.error?.code ?? null, output: r.output };
    } catch (error) {
      return { ok: false, note: redact((error as Error).message).slice(0, 300), code: null, output: undefined };
    }
  }

  /** A Pages read with a repository scope only (no task), for Check setup. */
  private async pagesStatusForRepo(repo: RepositoryRecord, project: string): Promise<{ ok: boolean; note: string }> {
    const r = await this.readForRepo(repo, 'cloudflare.pages_status', { project });
    return { ok: r.ok, note: r.note };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** A stage record for a release run outside the workflow (the button, Check again), so the timeline shows it. */
  private syntheticStage(task: TaskRecord, name: string): StageInstance {
    const previous = this.d.store.listStages(task.id).filter((s) => s.stageKey === 'release');
    const stage: StageInstance = {
      id: newId(),
      taskId: task.id,
      stageKey: 'release',
      name,
      role: 'deployer',
      kind: 'release',
      status: 'RUNNING',
      agentId: null,
      model: null,
      effort: null,
      permissionLevel: 5,
      attempt: previous.length + 1,
      cycle: task.fixCycles,
      verdict: null,
      summary: null,
      errorClass: null,
      errorMessage: null,
      startedAt: now(),
      finishedAt: null,
      createdAt: now(),
    };
    this.d.store.insertStage(stage);
    this.d.publisher.stage(stage);
    return stage;
  }

  private closeStage(stageId: string, record: TaskRelease): void {
    const line = summaryLine(record);
    this.d.publisher.updateStage(stageId, { status: record.state === 'live' ? 'SUCCESS' : 'FAILED', summary: line, errorMessage: record.state === 'live' ? null : line, finishedAt: now() });
  }

  private crashed(taskId: string, stageId: string, error: unknown): void {
    const message = redact((error as Error)?.message ?? String(error)).slice(0, 300);
    try {
      const record = this.d.store.getTask(taskId)?.git.release;
      if (record && IN_FLIGHT.has(record.state)) {
        const next: TaskRelease = record.publishedAt ? { ...record, state: 'published_unconfirmed', reason: `Sent, but checking stopped on an error: ${message}. Use Check again.` } : { ...record, state: 'failed', reason: `The release stopped on an error before anything was sent: ${message}` };
        this.save(taskId, next);
        this.event(taskId, next.state === 'failed' ? 'RELEASE_FAILED' : 'RELEASE_UNCONFIRMED', next.reason!, { error: message }, stageId);
      }
      this.d.publisher.updateStage(stageId, { status: 'FAILED', errorMessage: message, summary: message, finishedAt: now() });
    } catch {
      // The database is gone (shutdown): a restart resolves the release from the remote (recover()).
    }
  }

  private track(work: Promise<unknown>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  /** Shutdown: stop polling and wait until every background release has saved where it stands. Nothing is ever cut mid-push. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.background]);
  }

  private sleep(ms: number, stopped?: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const until = Date.now() + ms;
      const tick = () => (Date.now() >= until || stopped?.() ? resolve() : setTimeout(tick, Math.min(250, Math.max(1, until - Date.now()))));
      tick();
    });
  }

  private save(taskId: string, record: TaskRelease): void {
    const task = this.task(taskId);
    this.d.publisher.updateTask(taskId, { git: { ...task.git, release: record } });
  }

  private event(taskId: string, type: EventType, message: string, data: Record<string, unknown>, stageId: string | null = null): void {
    this.d.publisher.event(taskId, type, message, data, stageId);
  }

  private task(id: string): TaskRecord {
    const task = this.d.store.getTask(id);
    if (!task) throw new ReleaseError(`Task ${id} not found`, 'NOT_FOUND');
    return task;
  }

  private repo(task: TaskRecord): RepositoryRecord {
    const repo = this.d.store.getRepository(task.repositoryId);
    if (!repo) throw new ReleaseError('The task repository is not registered any more', 'NOT_FOUND');
    return repo;
  }
}

/** What proves a release live: the reads both methods share. */
interface ProofConfig {
  liveUrl: string;
  proof: { cloudflarePages?: { project: string }; versionUrl?: string };
  timeoutSec: number;
}

/** A Pages project as Cloudflare has it now. */
interface PagesSite {
  exists: boolean;
  productionBranch: string | null;
  /** Its own address, e.g. `app-xyz.pages.dev`. */
  subdomain: string | null;
  live: PagesDeployment | null;
}

/** A commit built in a throwaway checkout under `<dataDir>/releases`. */
interface Build {
  dir: string;
  files: number;
}

/** Cloudflare Pages takes at most this many files in one deployment. */
const PAGES_MAX_FILES = 20_000;

function isProductionName(branch: string): boolean {
  return (PRODUCTION_BRANCH_NAMES as readonly string[]).includes(branch.toLowerCase());
}

function isInside(root: string, dir: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Files under `dir`, not following links, counting up to `max`; 0 when it is missing. */
function countFiles(dir: string, max: number): number {
  let count = 0;
  const walk = (at: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= max) return;
      if (e.isDirectory()) walk(path.join(at, e.name));
      else if (e.isFile()) count++;
    }
  };
  walk(dir);
  return count;
}

interface PagesDeployment {
  id: string;
  commit: string | null;
  stage: string | null;
  status: string | null;
  url: string | null;
}

function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

function list(paths: string[]): string {
  return paths.slice(0, 20).join(', ') + (paths.length > 20 ? `, and ${paths.length - 20} more` : '');
}

function gitMessage(result: { stdout: string; stderr: string }): string {
  return redact((result.stderr || result.stdout).trim().split('\n').filter(Boolean).slice(-3).join(' ')).slice(0, 300) || 'no message';
}

export function stateLabel(state: TaskRelease['state']): string {
  return RELEASE_STATE_LABEL[state];
}

/** One line for a stage summary and the report. */
export function summaryLine(record: TaskRelease): string {
  const sha = record.commit.slice(0, 7);
  switch (record.state) {
    case 'live':
      return `Live on ${record.target.liveUrl} since ${record.liveConfirmedAt ?? ''} — commit ${sha}`.replace(' since  —', ' —');
    case 'published_unconfirmed':
      return `Sent ${sha} to ${record.target.remote}/${record.target.branch} — not confirmed live: ${record.reason ?? ''}`;
    case 'failed':
      return `Release of ${sha} failed: ${record.reason ?? ''}`;
    case 'refused':
      return `Not released, nothing sent: ${record.reason ?? ''}`;
    default:
      return `Release of ${sha}: ${stateLabel(record.state)}`;
  }
}
