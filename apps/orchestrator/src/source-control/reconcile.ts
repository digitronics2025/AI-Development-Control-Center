import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { commitsSince, fetchRemote, headCommit, isAncestor, revParse } from '@acc/git';
import type { RepositoryService } from '../services/repositories.js';
import type { GitOperationRecord, GitOperationStore } from '../store/git-operations.js';
import { now } from '../store/store.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Bound on the whole startup pass; a slow remote must not hold anything up. */
const RECONCILE_BUDGET_MS = 60_000;

export interface ReconcileReport {
  checked: number;
  resolved: Array<{ id: string; kind: string; status: string }>;
}

/**
 * Restart recovery (plan §3.10). Journal entries a crash left `started` —
 * and pushes left `uncertain` — are settled from what the repository and the
 * remote actually show. Nothing is re-run: a commit is never repeated, a push
 * never retried, an index never "restored" from an old assumption.
 */
export async function reconcileGitOperations(deps: { operations: GitOperationStore; repositories: RepositoryService }): Promise<ReconcileReport> {
  const deadline = Date.now() + RECONCILE_BUDGET_MS;
  const report: ReconcileReport = { checked: 0, resolved: [] };
  for (const op of deps.operations.open()) {
    if (Date.now() > deadline) break;
    // Uncertain entries are re-checked only when there is something to check (a push).
    if (op.status === 'uncertain' && !op.metadata.pushedSha) continue;
    report.checked++;
    let root: string;
    try {
      root = deps.repositories.record(op.repositoryId).path;
    } catch {
      continue;
    }
    const settle = (status: 'succeeded' | 'failed' | 'uncertain', summary: string, extra: { commitSha?: string | null; postHead?: string | null } = {}) => {
      deps.operations.finish(op.id, {
        status,
        finishedAt: now(),
        errorCode: status === 'succeeded' ? null : 'INTERRUPTED',
        errorSummary: status === 'succeeded' ? null : summary,
        metadata: { message: summary },
        ...extra,
      });
      report.resolved.push({ id: op.id, kind: op.kind, status });
    };
    if (!existsSync(root)) {
      settle('uncertain', 'Interrupted by an orchestrator restart, and the repository folder is gone.');
      continue;
    }
    try {
      await reconcileOne(root, op, settle);
    } catch (error) {
      settle('uncertain', `Interrupted by an orchestrator restart; recovery could not check it: ${(error as Error).message.slice(0, 300)}`);
    }
  }
  return report;
}

async function reconcileOne(
  root: string,
  op: GitOperationRecord,
  settle: (status: 'succeeded' | 'failed' | 'uncertain', summary: string, extra?: { commitSha?: string | null; postHead?: string | null }) => void,
): Promise<void> {
  const head = await headCommit(root);
  switch (op.kind) {
    case 'commit': {
      if (head === op.preHead) return settle('failed', 'The commit did not happen before the orchestrator stopped. The staged changes are as Git shows them.');
      const candidates = head ? await commitsSince(root, op.preHead, head, 50) : [];
      const match = candidates.find(
        (c) => (op.preHead ? c.parents[0] === op.preHead : c.parents.length === 0) && (!op.metadata.messageHash || sha256(c.message) === op.metadata.messageHash),
      );
      if (match) return settle('succeeded', `Committed as ${match.sha.slice(0, 10)} (confirmed after restart)`, { commitSha: match.sha, postHead: head });
      return settle('uncertain', 'HEAD moved while the orchestrator was stopped, but not to a commit this action made. Check the history before committing again.', { postHead: head });
    }
    case 'push':
    case 'publish':
    case 'sync': {
      const pushed = op.metadata.pushedSha;
      if (pushed) {
        const remote = op.remote ?? (op.ref?.split('/')[0] || null);
        const target = op.kind === 'sync' ? '@{upstream}' : op.ref ? `${op.remote}/${op.ref.replace(/^refs\/heads\//, '')}` : null;
        if (!remote || !target) return settle('uncertain', 'The push was interrupted and its target is unknown. Fetch and check the remote branch.');
        const fetched = await fetchRemote(root, remote, { unattended: true });
        if (fetched.code !== 0) return settle('uncertain', 'The push was interrupted and the remote could not be reached to confirm it. Fetch later to check.');
        const remoteSha = await revParse(root, target);
        if (remoteSha && (remoteSha === pushed || (await isAncestor(root, pushed, remoteSha)))) {
          return settle('succeeded', `The remote has ${pushed.slice(0, 10)}: the push completed (confirmed after restart)`, { postHead: head });
        }
        return settle('failed', `The remote does not have ${pushed.slice(0, 10)}: the push did not complete. Sync again when ready.`, { postHead: head });
      }
      const target = op.metadata.fastForwardTo;
      if (target) {
        if (head === target) return settle('succeeded', `Fast-forwarded to ${target.slice(0, 10)} (confirmed after restart)`, { postHead: head });
        if (head === op.preHead) return settle('failed', 'The fast-forward did not happen before the orchestrator stopped.', { postHead: head });
        return settle('uncertain', 'HEAD moved while the orchestrator was stopped. Check the branch before syncing again.', { postHead: head });
      }
      return settle('failed', 'Interrupted by an orchestrator restart before anything was sent; only a fetch may have run.', { postHead: head });
    }
    case 'fast_forward': {
      const target = op.metadata.fastForwardTo;
      if (target && head === target) return settle('succeeded', `Fast-forwarded to ${target.slice(0, 10)} (confirmed after restart)`, { postHead: head });
      if (head === op.preHead) return settle('failed', 'The fast-forward did not happen before the orchestrator stopped.', { postHead: head });
      return settle('uncertain', 'Interrupted by an orchestrator restart. The branch is shown as Git reports it.', { postHead: head });
    }
    case 'fetch':
      return settle('failed', 'Interrupted by an orchestrator restart. Fetching again is safe.', { postHead: head });
    default:
      // stage / unstage: the index is whatever Git now reports; never undo on assumption.
      return settle('uncertain', 'Interrupted by an orchestrator restart. Whether it applied is shown by the current status.', { postHead: head });
  }
}
