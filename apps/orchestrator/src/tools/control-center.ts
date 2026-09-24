import { builtinDetection, failure, operation, type ToolProvider } from '@acc/tools';
import { APPROVAL_STATUSES, TASK_STATUSES, type TaskStatus, type UsageTotals } from '@acc/shared';
import { z } from 'zod';
import type { Chairman } from '../chairman/chairman.js';
import type { TaskViews } from '../engine/views.js';
import type { LearningService } from '../learning/service.js';
import type { Store } from '../store/store.js';
import type { UsageService } from '../usage/service.js';

/**
 * The Control Center's own records as read-only capabilities
 * (docs/systems/ask.md): tasks, one task, usage and costs, approvals and what
 * the learning loop changed. Everything is read from the orchestrator's
 * services in process — the same views the dashboard shows — so answers match
 * the screens. Nothing here writes.
 */

const READ = { level: 1 as const, effects: [], reasons: ['Reads Control Center records'], writes: false };
const DAY = 86_400_000;

/** Money in dollars, for a model that should not have to divide by 10^9. */
function dollars(nanos: number | null | undefined): number | null {
  return typeof nanos === 'number' ? Math.round(nanos / 1e5) / 1e4 : null;
}

function totals(t: UsageTotals) {
  return { requests: t.requests, succeeded: t.succeeded, failed: t.failed, costUsd: dollars(t.costNanos), unknownCostRequests: t.unknownCostRequests, inputTokens: t.inputTokens, outputTokens: t.outputTokens, totalTokens: t.totalTokens };
}

export function controlCenterProvider(d: { store: Store; views: TaskViews; chairman: Chairman; usage: UsageService; learning: LearningService }): ToolProvider {
  return {
    id: 'control-center',
    name: 'Control Center records',
    description: 'Tasks, usage and costs, approvals and learning, as the dashboard shows them.',
    category: 'environment',
    builtin: true,
    async detect() {
      return builtinDetection();
    },
    operations: [
      operation({
        id: 'controlcenter.tasks',
        title: 'Find tasks',
        description: 'Tasks on this machine, newest activity first: id, title, status, repository, stage, agent and when they changed. Filter by status (e.g. FAILED, COMPLETED, RUNNING), repository id, text in the title or id, or a start date.',
        input: z.object({
          status: z.array(z.enum(TASK_STATUSES)).max(12).optional(),
          repositoryId: z.string().max(100).optional(),
          q: z.string().max(200).optional(),
          since: z.string().datetime({ offset: true }).optional(),
          limit: z.number().int().min(1).max(200).default(30),
        }),
        level: 1,
        readOnly: true,
        classify: () => READ,
        async run(input) {
          const tasks = d.store
            .listTasks({ statuses: input.status as TaskStatus[] | undefined, repositoryId: input.repositoryId, search: input.q, limit: input.limit })
            .filter((t) => !input.since || t.updatedAt >= input.since)
            .map((t) => d.views.summary(t))
            .map((t) => ({ id: t.id, title: t.title, status: t.status, repository: t.repositoryName, stage: t.currentStageName, createdAt: t.createdAt, updatedAt: t.updatedAt }));
          return { ok: true, summary: `${tasks.length} task(s)`, output: { tasks } };
        },
      }),
      operation({
        id: 'controlcenter.task',
        title: 'Look at one task',
        description: 'One task in detail: goal, status, current stage, blocker, directives, latest review/verification/test results, recent events and retry state (the same record the Chairman reads).',
        input: z.object({ id: z.string().regex(/^TASK-\d{1,6}$/i) }),
        level: 1,
        readOnly: true,
        classify: () => READ,
        async run(input) {
          const id = `TASK-${input.id.split('-')[1]!.padStart(4, '0')}`;
          if (!d.store.getTask(id)) return failure('FAILED', `${id} does not exist.`);
          const snapshot = d.chairman.snapshots.build(id);
          return { ok: true, summary: `${id}: ${snapshot.title} (${snapshot.status})`, output: { description: d.chairman.snapshots.describe(snapshot), snapshot } };
        },
      }),
      operation({
        id: 'controlcenter.usage',
        title: 'Usage and costs',
        description: 'What agent runs used and cost over a period (default the last 7 days, at most 90): totals, and a breakdown by provider, model, agent, role, project (repository), taskType or effort. Costs are in US dollars; attempts whose cost is unknown are counted separately.',
        input: z.object({
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          groupBy: z.enum(['provider', 'model', 'agent', 'role', 'project', 'taskType', 'effort']).default('model'),
        }),
        level: 1,
        readOnly: true,
        classify: () => READ,
        async run(input) {
          const to = input.to ?? new Date().toISOString();
          const from = input.from ?? new Date(Date.parse(to) - 7 * DAY).toISOString();
          if (!(Date.parse(from) < Date.parse(to)) || Date.parse(to) - Date.parse(from) > 90 * DAY) return failure('INVALID_INPUT', 'Choose a start before the end, at most 90 days apart.');
          const filter = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
          const overview = d.usage.overview(filter);
          const rows = d.usage.breakdown(filter, input.groupBy).map((r) => ({ key: r.label || r.key, ...totals(r.totals), tasks: r.tasks, shareOfCost: r.shareOfCost }));
          return {
            ok: true,
            summary: `Usage ${filter.from.slice(0, 10)} to ${filter.to.slice(0, 10)}: ${overview.totals.requests} run(s), $${(overview.totals.costNanos / 1e9).toFixed(2)}`,
            output: { range: filter, totals: totals(overview.totals), successfulTasks: overview.successfulTasks, failedTasks: overview.failedTasks, groupBy: input.groupBy, rows, billingNote: overview.billingNote },
          };
        },
      }),
      operation({
        id: 'controlcenter.approvals',
        title: 'Approvals',
        description: 'Approval requests (pending by default): what was asked, for which task, and how it was decided.',
        input: z.object({ status: z.enum(APPROVAL_STATUSES).optional(), limit: z.number().int().min(1).max(200).default(30) }),
        level: 1,
        readOnly: true,
        classify: () => READ,
        async run(input) {
          const approvals = d.store.listApprovals({ status: input.status ?? 'pending', limit: input.limit });
          return { ok: true, summary: `${approvals.length} approval(s)`, output: { approvals } };
        },
      }),
      operation({
        id: 'controlcenter.learning',
        title: 'What the learning loop changed',
        description: 'Improvements the Chairman adopted from finished tasks, open findings and recent reviews.',
        input: z.object({}),
        level: 1,
        readOnly: true,
        classify: () => READ,
        async run() {
          const o = d.learning.overview();
          return {
            ok: true,
            summary: `${o.counts.improvementsLive} improvement(s) live, ${o.counts.findingsOpen} finding(s) open`,
            output: { counts: o.counts, improvements: o.improvements.slice(0, 30), findings: o.findings.slice(0, 30), reviews: o.reviews.slice(0, 15) },
          };
        },
      }),
    ],
  };
}

/** Every capability the Control Center provider offers (Ask's always-on source). */
export const CONTROL_CENTER_CAPABILITIES = ['controlcenter.tasks', 'controlcenter.task', 'controlcenter.usage', 'controlcenter.approvals', 'controlcenter.learning'] as const;
