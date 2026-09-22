import { PERMISSION_LEVEL_INFO, type ApprovalKind, type CommandRisk, type PermissionLevel } from '@acc/shared';
import { redact } from '@acc/security';
import type { Bus } from '../bus.js';
import { newId, now, type ApprovalRecord, type Store, type TaskRecord } from '../store/store.js';
import type { Publisher } from './publisher.js';
import type { TaskViews } from './views.js';

export interface ApprovalRequest {
  kind: ApprovalKind;
  stageId: string | null;
  stageKey: string | null;
  requestedBy: string;
  action: string;
  command?: string | null;
  permissionLevel: PermissionLevel;
  risk: CommandRisk;
  reason: string;
  riskExplanation: string;
  environment?: string | null;
}

export type GateState = 'approved' | 'pending' | 'denied' | 'none';

/**
 * Human approval gates (PLAN §29, design §7.4). A pending approval stops the
 * task in WAITING_FOR_USER with the approval as its blocker; nothing is ever
 * approved optimistically. Level 5 and dangerous requests carry a typed
 * confirmation phrase.
 */
export class ApprovalGate {
  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly views: TaskViews,
    private readonly publisher: Publisher,
  ) {}

  state(taskId: string, kind: ApprovalKind, match: { stageKey?: string; stageId?: string; command?: string }): GateState {
    const found = this.store.findApproval(taskId, kind, match);
    if (!found || found.status === 'cancelled') return 'none';
    return found.status === 'approved' ? 'approved' : found.status === 'pending' ? 'pending' : 'denied';
  }

  pending(taskId: string, kind: ApprovalKind, match: { stageKey?: string; stageId?: string; command?: string }): ApprovalRecord | null {
    const found = this.store.findApproval(taskId, kind, match);
    return found?.status === 'pending' ? found : null;
  }

  /** Create the approval and park the task on it. */
  request(task: TaskRecord, req: ApprovalRequest): ApprovalRecord {
    const strong = req.permissionLevel === 5 || req.risk === 'dangerous';
    const rec: ApprovalRecord = {
      id: newId(),
      taskId: task.id,
      stageId: req.stageId,
      stageKey: req.stageKey,
      kind: req.kind,
      requestedBy: req.requestedBy,
      action: req.action,
      command: req.command ? redact(req.command) : null,
      permissionLevel: req.permissionLevel,
      risk: req.risk,
      reason: req.reason,
      riskExplanation: req.riskExplanation,
      environment: req.environment ?? null,
      confirmationPhrase: strong ? task.id : null,
      status: 'pending',
      note: null,
      createdAt: now(),
      resolvedAt: null,
    };
    this.store.insertApproval(rec);
    this.bus.publish({ type: 'approval', approval: this.views.approval(rec) });
    this.publisher.updateTask(task.id, {
      status: 'WAITING_FOR_USER',
      blocker: { kind: 'approval', message: `Approval needed: ${req.action}`, approvalId: rec.id, stageKey: req.stageKey ?? undefined },
    });
    const level = PERMISSION_LEVEL_INFO[req.permissionLevel];
    this.publisher.event(task.id, 'APPROVAL_REQUESTED', `Approval requested: ${req.action} (Level ${req.permissionLevel} · ${level.name})`, { approvalId: rec.id, kind: req.kind }, req.stageId);
    return rec;
  }

  /** Re-park a task on an approval that is already pending (e.g. after a restart). */
  park(task: TaskRecord, rec: ApprovalRecord): void {
    this.publisher.updateTask(task.id, {
      status: 'WAITING_FOR_USER',
      blocker: { kind: 'approval', message: `Approval needed: ${rec.action}`, approvalId: rec.id, stageKey: rec.stageKey ?? undefined },
    });
  }
}
