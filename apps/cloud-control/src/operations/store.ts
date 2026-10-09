import { sha256Hex } from '@acc/shared';
import { HttpError, nowIso } from '../http.js';
import { eventSchema, OPS_LIMITS, stateFor, validProof, type OpsEvent } from './contracts.js';
import { AppRegistry } from './registry.js';

export interface Incident {
  id: string; app_id: string; fingerprint: string; resource: string; operation: string; signature: string;
  classification: string; state: string; title: string; detail: string; evidence_uri: string | null;
  dependency_id: string | null; first_seen_at: string; last_seen_at: string; failed_at: string;
  occurrences: number; recurrence_count: number; recurrence_started_at: string; prevention_required: number;
  version: number; command_id: string | null; task_id: string | null; node_id: string | null;
  repair_attempts: number; proof: string | null; next_action_at: string; resolved_at: string | null;
}
export class OperationsStore {
  readonly registry: AppRegistry;
  constructor(readonly db: D1Database) { this.registry = new AppRegistry(db); }
  async reserve(kind: 'events'|'tasks'|'notifications'|'checks', units: number, now = Date.now()): Promise<boolean> {
    const day = new Date(now).toISOString().slice(0,10);
    const column = kind === 'checks' ? null : kind;
    const cap = kind === 'events' ? OPS_LIMITS.eventsPerDay : kind === 'tasks' ? OPS_LIMITS.tasksPerDay : OPS_LIMITS.notificationsPerDay;
    const result = await this.db.prepare(`INSERT INTO ops_budget(day,units,events,tasks,notifications) VALUES(?,?,${kind === 'events' ? 1 : 0},${kind === 'tasks' ? 1 : 0},${kind === 'notifications' ? 1 : 0})
      ON CONFLICT(day) DO UPDATE SET units=units+excluded.units${column ? `,${column}=${column}+1` : ''}
      WHERE units+excluded.units<=?${column ? ` AND ${column}<?` : ''} RETURNING day`)
      .bind(...[day,units,OPS_LIMITS.workUnitsPerDay,...(column ? [cap] : [])]).first();
    return result !== null;
  }
  async ingest(raw: unknown, credentialAppId: string, allowProof = true): Promise<{ duplicate: boolean; incidentId: string | null }> {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400,'OPS_INVALID_EVENT','Invalid operations event.',parsed.error.flatten());
    const e = parsed.data;
    if (e.appId !== credentialAppId) throw new HttpError(403,'OPS_SOURCE','An app cannot impersonate another app.');
    const app = await this.registry.get(e.appId);
    if (!app || !app.enabled) throw new HttpError(404,'OPS_APP_NOT_FOUND','App not registered.');
    const now = Date.now(), at = Date.parse(e.occurredAt);
    if (at > now + 60_000 || now - at > 7 * 86400_000) throw new HttpError(400,'OPS_STALE_EVENT','Event timestamp is out of range.');
    if (e.jobId && !await this.db.prepare('SELECT id FROM ops_jobs WHERE app_id=? AND id=? AND enabled=1').bind(e.appId,e.jobId).first()) throw new HttpError(400,'OPS_JOB_NOT_FOUND','Unknown or disabled job.');
    if (e.dependencyId && !JSON.parse(app.contract).dependencies.includes(e.dependencyId)) throw new HttpError(400,'OPS_DEPENDENCY','Dependency is not registered for this app.');
    if (!allowProof && (e.proof || e.outcome === 'healthy')) throw new HttpError(403,'OPS_PROOF_SOURCE','Notification text cannot establish recovery.');
    const hash = await sha256Hex(JSON.stringify(e));
    const previous = await this.db.prepare('SELECT payload_hash,incident_id FROM ops_events WHERE app_id=? AND id=?').bind(e.appId,e.id).first<{payload_hash:string;incident_id:string|null}>();
    if (previous) {
      if (previous.payload_hash !== hash) throw new HttpError(422,'OPS_IDEMPOTENCY_MISMATCH','Event id reused for different content.');
      return {duplicate:true,incidentId:previous.incident_id};
    }
    if (!(await this.reserve('events',12,now))) throw new HttpError(429,'OPS_BUDGET','Daily monitoring budget reached. Events must remain in the sender outbox.');
    const fingerprint = await sha256Hex(JSON.stringify([e.appId,e.resource,e.operation,e.signature]));
    const incidentId = `incident_${fingerprint.slice(0,32)}`;
    const old = await this.incident(incidentId);
    const preventionSignature=old?.recurrence_started_at??e.occurredAt;
    const preventionFingerprint=await sha256Hex(JSON.stringify([e.appId,incidentId,'prevention_review',preventionSignature]));
    const preventionId=`incident_${preventionFingerprint.slice(0,32)}`;
    const nonce = crypto.randomUUID(), received = nowIso();
    const guard = 'EXISTS (SELECT 1 FROM ops_events WHERE app_id=? AND id=? AND ingestion_nonce=?)';
    const g = [e.appId,e.id,nonce];
    const statements = [this.db.prepare('INSERT INTO ops_events(app_id,id,payload_hash,received_at,ingestion_nonce,incident_id) VALUES(?,?,?,?,?,?) ON CONFLICT(app_id,id) DO NOTHING')
      .bind(e.appId,e.id,hash,received,nonce,e.outcome === 'healthy' && !old ? null : incidentId)];
    if (e.jobId && e.outcome === 'healthy' && e.proof && validProof(e,'1970-01-01T00:00:00.000Z',now)) {
      statements.push(this.db.prepare(`UPDATE ops_jobs SET last_success_at=?,next_due_at=strftime('%Y-%m-%dT%H:%M:%fZ',?, '+'||(interval_seconds+grace_seconds)||' seconds')
        WHERE app_id=? AND id=? AND enabled=1 AND (last_success_at IS NULL OR last_success_at<?) AND ${guard}`)
        .bind(e.proof.observedAt,e.proof.observedAt,e.appId,e.jobId,e.proof.observedAt,...g));
    }
    // A recovered outage can still need prevention. Give it a distinct durable
    // incident, so a rapid healthy receipt cannot erase the investigation.
    statements.push(this.db.prepare(`INSERT INTO ops_incidents(id,app_id,fingerprint,resource,operation,signature,classification,state,title,detail,evidence_uri,dependency_id,first_seen_at,last_seen_at,failed_at,recurrence_started_at,next_action_at)
      SELECT ?,app_id,?,id,'prevention_review',?,'technical','detected',substr('Prevent recurrence: '||title,1,120),
        substr('At least three recurrences in seven days. Investigate the recurring cause; routine recovery alone does not prove prevention. Parent: '||id||'. '||detail,1,1000),
        evidence_uri,dependency_id,?,?,?, ?,?
      FROM ops_incidents WHERE id=? AND classification='technical' AND prevention_required=1 AND recurrence_count>=3 AND ${guard}
      ON CONFLICT(fingerprint) DO NOTHING`).bind(preventionId,preventionFingerprint,preventionSignature,received,received,received,received,received,incidentId,...g));
    statements.push(this.db.prepare(`INSERT INTO ops_delivery(id,incident_id,version,body,next_due_at)
      SELECT id||':'||version,id,version,json_object('title',title,'detail',detail,'appId',app_id,'state',state,'incidentId',id),?
      FROM ops_incidents WHERE id=? AND version=1 AND ${guard} ON CONFLICT(incident_id,version) DO NOTHING`).bind(received,preventionId,...g));
    if (e.outcome === 'healthy') {
      if (old && old.classification === 'technical' && validProof(e,old.failed_at,now)) statements.push(this.db.prepare(`UPDATE ops_incidents SET state='resolved',resolved_at=?,proof=?,version=version+1,next_action_at=?
        WHERE id=? AND state<>'resolved' AND failed_at<=? AND ${guard}`).bind(received,JSON.stringify(e.proof),received,incidentId,e.proof!.observedAt,...g));
    } else {
      const cutoff = new Date(now-7*86400_000).toISOString();
      statements.push(this.db.prepare(`INSERT INTO ops_incidents(id,app_id,fingerprint,resource,operation,signature,classification,state,title,detail,evidence_uri,dependency_id,first_seen_at,last_seen_at,failed_at,recurrence_started_at,next_action_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
        ON CONFLICT(fingerprint) DO UPDATE SET
          occurrences=occurrences+1,last_seen_at=MAX(last_seen_at,excluded.last_seen_at),failed_at=MAX(failed_at,excluded.failed_at),
          title=CASE WHEN excluded.last_seen_at>=last_seen_at THEN excluded.title ELSE title END,
          detail=CASE WHEN excluded.last_seen_at>=last_seen_at THEN excluded.detail ELSE detail END,
          evidence_uri=COALESCE(excluded.evidence_uri,evidence_uri),
          state=CASE WHEN state='resolved' AND excluded.failed_at>resolved_at THEN excluded.state ELSE state END,
          command_id=CASE WHEN state='resolved' AND excluded.failed_at>resolved_at THEN NULL ELSE command_id END,
          task_id=CASE WHEN state='resolved' AND excluded.failed_at>resolved_at THEN NULL ELSE task_id END,
          node_id=CASE WHEN state='resolved' AND excluded.failed_at>resolved_at THEN NULL ELSE node_id END,
          recurrence_count=CASE WHEN recurrence_started_at<? THEN 1 WHEN state='resolved' AND excluded.failed_at>resolved_at THEN recurrence_count+1 ELSE recurrence_count END,
          recurrence_started_at=CASE WHEN recurrence_started_at<? THEN excluded.recurrence_started_at ELSE recurrence_started_at END,
          prevention_required=CASE WHEN recurrence_started_at>=? AND state='resolved' AND excluded.failed_at>resolved_at AND recurrence_count>=2 THEN 1 ELSE prevention_required END,
          resolved_at=CASE WHEN state='resolved' AND excluded.failed_at>resolved_at THEN NULL ELSE resolved_at END,
          proof=CASE WHEN state='resolved' AND excluded.failed_at>resolved_at THEN NULL ELSE proof END,
          next_action_at=MIN(next_action_at,excluded.next_action_at),version=version+1`)
        .bind(incidentId,e.appId,fingerprint,e.resource,e.operation,e.signature,e.classification,stateFor(e.classification),e.title,e.detail,e.evidenceUri??null,e.dependencyId??null,e.occurredAt,e.occurredAt,e.occurredAt,e.occurredAt,received,...g,cutoff,cutoff,cutoff));
    }
    // Persist delivery with the same transaction, only for a new/reopened/resolved incident.
    statements.push(this.db.prepare(`INSERT INTO ops_delivery(id,incident_id,version,body,next_due_at)
      SELECT id||':'||version,id,version,json_object('title',title,'detail',detail,'appId',app_id,'state',state,'incidentId',id),?
      FROM ops_incidents WHERE id=? AND ${guard} AND (version=1 OR (state='resolved' AND resolved_at=?) OR (recurrence_count>1 AND first_seen_at<>failed_at AND failed_at=?))
      ON CONFLICT(incident_id,version) DO NOTHING`).bind(received,incidentId,...g,received,e.occurredAt));
    await this.db.batch(statements);
    const receipt = await this.db.prepare('SELECT ingestion_nonce,payload_hash,incident_id FROM ops_events WHERE app_id=? AND id=?').bind(e.appId,e.id).first<{ingestion_nonce:string;payload_hash:string;incident_id:string|null}>();
    if (receipt!.payload_hash!==hash) throw new HttpError(422,'OPS_IDEMPOTENCY_MISMATCH','Event id reused for different content.');
    return {duplicate:receipt!.ingestion_nonce!==nonce,incidentId:receipt!.incident_id};
  }
  incident(id: string): Promise<Incident|null> { return this.db.prepare('SELECT * FROM ops_incidents WHERE id=?').bind(id).first<Incident>(); }
  async list(appId: string, limit = 25): Promise<Incident[]> {
    return (await this.db.prepare('SELECT * FROM ops_incidents WHERE app_id=? ORDER BY last_seen_at DESC,id LIMIT ?').bind(appId,Math.min(50,Math.max(1,limit))).all<Incident>()).results;
  }
  async page(appId: string,cursor?: string): Promise<{incidents:Incident[];nextCursor:string|null}> {
    let at: string|null=null,id: string|null=null;
    if (cursor) {
      try {
        const c=JSON.parse(atob(cursor)) as unknown;
        if (!Array.isArray(c)||c.length!==3||c[0]!==appId||typeof c[1]!=='string'||!Number.isFinite(Date.parse(c[1]))||typeof c[2]!=='string'||!/^incident_[a-f0-9]{32}$/.test(c[2])) throw new Error('cursor');
        at=c[1];id=c[2];
      } catch {throw new HttpError(400,'OPS_CURSOR','Invalid incident cursor.');}
    }
    const rows=(await this.db.prepare(`SELECT * FROM ops_incidents WHERE app_id=? ${at?'AND (last_seen_at<? OR (last_seen_at=? AND id>?))':''} ORDER BY last_seen_at DESC,id LIMIT 26`)
      .bind(appId,...(at?[at,at,id]:[])).all<Incident>()).results;
    const incidents=rows.slice(0,25),last=incidents.at(-1);
    return {incidents,nextCursor:rows.length>25&&last?btoa(JSON.stringify([appId,last.last_seen_at,last.id])):null};
  }
  async setState(i: Incident, state: string, detail: string, next: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare('UPDATE ops_incidents SET state=?,detail=?,next_action_at=?,version=version+1 WHERE id=? AND version=? AND state<>\'resolved\'')
        .bind(state,detail.slice(0,1000),next,i.id,i.version),
      this.db.prepare(`INSERT INTO ops_delivery(id,incident_id,version,body,next_due_at)
        SELECT id||':'||version,id,version,json_object('title',title,'detail',detail,'appId',app_id,'state',state,'incidentId',id),?
        FROM ops_incidents WHERE id=? AND version=? AND state=? AND state<>'resolved'
        ON CONFLICT(incident_id,version) DO NOTHING`).bind(nowIso(),i.id,i.version+1,state),
    ]);
    return results[0]!.meta.changes>0;
  }
  async enqueue(id: string): Promise<void> {
    await this.db.prepare(`INSERT INTO ops_delivery(id,incident_id,version,body,next_due_at)
      SELECT id||':'||version,id,version,json_object('title',title,'detail',detail,'appId',app_id,'state',state,'incidentId',id),? FROM ops_incidents WHERE id=?
      ON CONFLICT(incident_id,version) DO NOTHING`).bind(nowIso(),id).run();
  }
  async prune(): Promise<void> {
    const before = new Date(Date.now()-OPS_LIMITS.retentionDays*86400_000).toISOString();
    await this.db.batch([
      this.db.prepare('DELETE FROM ops_events WHERE rowid IN (SELECT rowid FROM ops_events WHERE received_at<? LIMIT 200)').bind(before),
      this.db.prepare("DELETE FROM ops_delivery WHERE id IN (SELECT id FROM ops_delivery WHERE state='sent' AND sent_at<? LIMIT 100)").bind(before),
      this.db.prepare("DELETE FROM ops_incidents WHERE id IN (SELECT id FROM ops_incidents WHERE state='resolved' AND resolved_at<? AND NOT EXISTS (SELECT 1 FROM ops_delivery WHERE incident_id=ops_incidents.id) LIMIT 100)").bind(before),
      this.db.prepare('DELETE FROM ops_budget WHERE day<?').bind(before.slice(0,10)),
    ]);
  }
}

export function failureDescription(e: OpsEvent): string { return `${e.title}\n${e.detail}`; }
