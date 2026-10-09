import { sha256Hex } from '@acc/shared';
import type { Env } from '../env.js';
import { nowIso } from '../http.js';
import { OperationsStore, type Incident } from './store.js';

const next = (seconds: number) => new Date(Date.now()+seconds*1000).toISOString();
/** Fixed services and paths, never a URL or command supplied by an alert. */
export async function probeServices(env: Env, ops: OperationsStore): Promise<number> {
  const due = (await ops.db.prepare('SELECT p.app_id,p.state FROM ops_probes p JOIN ops_apps a ON a.id=p.app_id WHERE a.enabled=1 AND a.owner_email=? AND p.next_due_at<=? ORDER BY p.next_due_at LIMIT 2')
    .bind(env.OPS_OWNER_EMAIL??'',nowIso()).all<{app_id:string;state:string}>()).results;
  let checked = 0;
  for (const p of due) {
    if((env.OPS_QUERY_BUDGET?.remaining??Infinity)<24)break;
    if (!(await ops.reserve('checks',12))) break;
    // Rihla's current health endpoint scans its cost ledger; do not poll it.
    const binding = p.app_id==='messenger' ? env.OPS_MESSENGER : p.app_id==='digitronics_website' ? env.OPS_WEBSITE : p.app_id==='sales_analyzer' ? env.OPS_SALES : p.app_id==='product_hunter' ? env.OPS_PRODUCT_HUNTER : p.app_id==='applybridge' ? env.OPS_APPLYBRIDGE : null;
    if (!binding) {
      await ops.db.prepare('UPDATE ops_probes SET next_due_at=? WHERE app_id=?').bind(next(3600),p.app_id).run();
      continue;
    }
    let state='unknown', detail='Monitoring unavailable: no verified service response.', backlog=false,ambiguous=false;
    const now=nowIso();
    try {
      const url=p.app_id==='messenger' ? 'https://messenger.digitronics.app/api/v1/internal/operations/health'
        : p.app_id==='digitronics_website' ? 'https://digitronics.ma/api/health' : p.app_id==='sales_analyzer' ? 'https://sales.digitronics.app/exec' : p.app_id==='product_hunter' ? 'https://product-hunter.example/v1/health' : 'https://applybridge.example/health';
      const r=await binding.fetch(new Request(url,{headers:p.app_id==='messenger'?{authorization:`Bearer ${env.OPS_HEALTH_TOKEN ?? env.OPS_RECOVERY_TOKEN ?? ''}`}:{},signal:AbortSignal.timeout(8000)}));
      const raw: unknown=r.ok?await r.json():null;
      if (raw&&typeof raw==='object') {
        const b=raw as Record<string,unknown>;
        if (p.app_id==='messenger') { state=b.ready===true&&b.cron==='healthy'?'healthy':'unknown';backlog=typeof b.unattemptedQueued==='number'&&b.unattemptedQueued>0;ambiguous=typeof b.ambiguousQueued==='number'&&b.ambiguousQueued>0; }
        else if (p.app_id==='digitronics_website') state=b.status==='ok'?'healthy':b.status==='degraded'?'failed':'unknown';
        // /exec is a liveness check only; never establishes inventory or shipping health.
        else state=(b.ok===true||b.status==='ok')?'healthy':'unknown';
        detail=state==='healthy'?'Verified service response. This does not verify backups, business records or delivery.':'Service or scheduler readiness could not be established.';
      }
    } catch { /* A network failure is unknown health, never an empty successful check. */ }
    if (state!==p.state) {
      await ops.ingest({id:`probe:${p.app_id}:${now}`,appId:p.app_id,resource:'service',operation:'service_health',signature:'unavailable',classification:'technical',outcome:state==='healthy'?'healthy':'unknown',occurredAt:now,
        title:`${p.app_id} service monitoring`,detail,...(state==='healthy'?{proof:{kind:'job_result',observedAt:now,reference:'service adapter response'}}:{})},p.app_id);
    }
    // Prioritize ambiguous evidence without spending another probe's statement
    // allowance. A later probe handles safe queued candidates independently.
    if(ambiguous)await ops.ingest({id:`ambiguous:${now}`,appId:'messenger',resource:'contradictory_outbox',operation:'message_send',signature:'contradictory_provider_evidence',classification:'uncertain_delivery',outcome:'unknown',occurredAt:now,
      title:'Queued message status contradicts provider evidence',detail:'Bounded native outbox candidates have established provider evidence or a non-queued message status. No automatic resend is permitted.'},'messenger');
    else if (backlog) await ops.ingest({id:`queue:${now}`,appId:'messenger',resource:'unattempted_outbox',operation:'outbox_reconcile',signature:'stuck_queued',classification:'technical',outcome:'failed',occurredAt:now,
      title:'Unattempted messages remain queued',detail:'The owner workspace has stale queued messages with zero retries and no ad-opening marker. Native dispatcher policy must recheck every send.'},'messenger');
    await ops.db.prepare('UPDATE ops_probes SET state=?,observed_at=?,next_due_at=? WHERE app_id=?').bind(state,now,next(['messenger','digitronics_website'].includes(p.app_id)?900:p.app_id==='sales_analyzer'?1800:3600),p.app_id).run();
    checked++;
  }
  return checked;
}

/** One bounded native recovery, followed by independent downstream verification. */
export async function recoverNative(env: Env, ops: OperationsStore, i: Incident): Promise<boolean> {
  if (env.OPS_RECOVERY_ENABLED!=='true'||i.app_id!=='messenger'||i.operation!=='outbox_reconcile'||i.classification!=='technical'||!env.OPS_MESSENGER||!env.OPS_RECOVERY_TOKEN) return false;
  const receipt=await ops.db.prepare('SELECT id,state,created_at,verify_after FROM ops_recoveries WHERE incident_id=? AND recurrence=?').bind(i.id,i.recurrence_count).first<{id:string;state:string;created_at:string;verify_after:string}>();
  if (receipt) {
    if (receipt.verify_after>nowIso()) return true;
    try {
      const response=await env.OPS_MESSENGER.fetch(new Request(`https://messenger.digitronics.app/api/v1/internal/operations/verify/${receipt.id}`,{headers:{authorization:`Bearer ${env.OPS_RECOVERY_TOKEN}`},signal:AbortSignal.timeout(8000)}));
      const proof: unknown=response.ok?await response.json():null;
      if (proof&&typeof proof==='object'&&'verified' in proof&&proof.verified===true&&'observedAt' in proof&&typeof proof.observedAt==='string') {
        // Read from actual provider-delivered message rows, not the retry response.
        await ops.ingest({id:`verified:${receipt.id}`,appId:i.app_id,resource:i.resource,operation:i.operation,signature:i.signature,classification:'technical',outcome:'healthy',occurredAt:proof.observedAt,
          title:i.title,detail:'Native recovery verified from provider-delivered/read message records.',proof:{kind:'provider_delivered',observedAt:proof.observedAt,reference:receipt.id}},i.app_id);
        await ops.db.prepare("UPDATE ops_recoveries SET state='verified' WHERE id=?").bind(receipt.id).run(); return true;
      }
    } catch { /* A lost verification response cannot resolve the incident or repeat the send. */ }
    // Native retries continue independently; escalate investigation after one hour without proof.
    await ops.db.prepare('UPDATE ops_recoveries SET verify_after=? WHERE id=?').bind(next(900),receipt.id).run();
    return Date.now()-Date.parse(receipt.created_at)<3600000;
  }
  if (!(await ops.reserve('checks',50))) return true;
  const id=`recovery_${(await sha256Hex(`${i.id}:${i.recurrence_count}`)).slice(0,32)}_1`;
  const claimed=await ops.db.prepare("INSERT INTO ops_recoveries(id,incident_id,recurrence,state,created_at,verify_after) VALUES(?,?,?,'claimed',?,?) ON CONFLICT(incident_id,recurrence) DO NOTHING RETURNING id")
    .bind(id,i.id,i.recurrence_count,nowIso(),next(300)).first();
  if (!claimed) return true;
  // Store action identity first. Ambiguous responses enter verification, never a new attempt.
  const active = await ops.setState(i,'recovering','Requesting the native dispatcher to requeue at most five stale, unattempted messages. Current policy and budgets still apply.',next(300));
  if (!active) { await ops.db.prepare("UPDATE ops_recoveries SET state='cancelled' WHERE id=?").bind(id).run(); return true; }
  try {
    const response=await env.OPS_MESSENGER.fetch(new Request('https://messenger.digitronics.app/api/v1/internal/operations/recover',{method:'POST',headers:{authorization:`Bearer ${env.OPS_RECOVERY_TOKEN}`,'content-type':'application/json'},
      body:JSON.stringify({requestId:id,recipe:'unattempted_outbox'}),signal:AbortSignal.timeout(8000)}));
    await ops.db.prepare('UPDATE ops_recoveries SET state=? WHERE id=?').bind(response.ok?'verifying':'unavailable',id).run();
  } catch { await ops.db.prepare("UPDATE ops_recoveries SET state='unknown' WHERE id=?").bind(id).run(); }
  const fresh=await ops.incident(i.id);
  if (fresh) await ops.setState(fresh,'verifying','Native recovery request recorded. Provider delivery is not yet verified. An uncertain response is never retried as a new send.',next(300));
  return true;
}
