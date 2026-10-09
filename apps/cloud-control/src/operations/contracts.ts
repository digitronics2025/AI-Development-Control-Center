import { z } from 'zod';

export const OPS_LIMITS = {
  apps: 64, jobsPerApp: 32, eventsPerDay: 300, tasksPerDay: 4,
  notificationsPerDay: 24, workUnitsPerDay: 6000,
  checksPerTick: 4, incidentsPerTick: 2, deliveriesPerTick: 2,
  retentionDays: 30, tickSeconds: 300, requestBytes: 12 * 1024,
} as const;

const id = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const short = z.string().trim().min(1).max(120);
const proofKind=z.enum(['job_result','backup_artifact_and_mirror','provider_delivered','records_reconciled','production_behavior','current_ark_receipt']);
export const classificationSchema = z.enum(['technical', 'business', 'staff_attention', 'policy_hold', 'uncertain_delivery', 'expected_pause']);
// Evidence references are never fetched. Drop credentials, queries and fragments.
const evidenceUri = z.string().url().max(1000).refine((s) => {
  const u = new URL(s);
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
}, 'Evidence must be HTTPS without credentials, query or fragment');
export const appSchema = z.object({
  id, name: short,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(150),
  services: z.array(z.object({ name: short, kind: z.enum(['worker','pages','desktop','mobile']), release: z.enum(['workers_builds','pages_git','manual','device']), deployed: z.boolean(), crons: z.array(z.string().min(5).max(100)).max(8).optional() }).strict()).min(1).max(32),
  dependencies: z.array(id).max(12).default([]),
  notificationSources: z.array(id).max(12).default([]),
  jobs: z.array(z.object({ id, intervalSeconds: z.number().int().min(300).max(604800), graceSeconds: z.number().int().min(300).max(604800), heartbeatExpected: z.boolean().default(true), proofKind:proofKind.optional(), cron: z.string().max(100).optional() }).strict()).max(OPS_LIMITS.jobsPerApp).default([]),
  // Only deployed adapter implementations can advertise a verified recovery.
  recovery: z.enum(['native_only', 'investigation']).default('native_only'),
}).strict().superRefine((a, c) => {
  if (new Set(a.jobs.map((j) => j.id)).size !== a.jobs.length) c.addIssue({ code: 'custom', message: 'Duplicate job id' });
  if (a.dependencies.includes(a.id)) c.addIssue({ code: 'custom', message: 'An app cannot depend on itself' });
  for(const j of a.jobs)if(j.heartbeatExpected&&!j.proofKind)c.addIssue({code:'custom',message:'Enabled job receipts require an explicit downstream proof kind'});
});
export type OpsApp = z.infer<typeof appSchema>;
export const proofSchema = z.object({
  kind: proofKind,
  observedAt: z.string().datetime(), reference: short,
}).strict();
export const eventSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.:-]{8,160}$/), appId: id,
  resource: short, operation: id, signature: short,
  classification: classificationSchema,
  outcome: z.enum(['failed','unknown','healthy']),
  occurredAt: z.string().datetime(), title: short, detail: z.string().max(1000),
  evidenceUri: evidenceUri.optional(), dependencyId: id.optional(),
  jobId: id.optional(), proof: proofSchema.optional(),
}).strict();
export type OpsEvent = z.infer<typeof eventSchema>;

export function stateFor(classification: OpsEvent['classification']): string {
  return classification === 'technical' ? 'detected' : classification === 'expected_pause' ? 'observing' : 'needs_owner';
}

export function validProof(event: OpsEvent, failedAt: string, now: number): boolean {
  if (event.outcome !== 'healthy' || !event.proof) return false;
  const at = Date.parse(event.proof.observedAt);
  if (at < Date.parse(failedAt) || at > now + 60_000 || now - at > 15 * 60_000) return false;
  const required = event.operation.includes('backup') ? 'backup_artifact_and_mirror'
    : event.operation.includes('ark') ? 'current_ark_receipt'
    : (event.operation.includes('message') || event.operation === 'outbox_reconcile') ? 'provider_delivered'
    : event.operation.includes('sync') ? 'records_reconciled'
    : (event.operation.includes('release') || event.operation==='prevention_review') ? 'production_behavior' : 'job_result';
  return event.proof.kind === required;
}
