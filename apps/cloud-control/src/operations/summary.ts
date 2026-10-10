import { REMOTE_MIN_PROTOCOL_VERSION } from '@acc/shared';
import type { Env } from '../env.js';

/** Read-only, bounded owner summary; a historical heartbeat is not connectivity. */
export async function operationsStatus(env: Env, owner: string) {
  const [runtime,probes,nodeRows,notice,budget] = await Promise.all([
    env.DB.prepare("SELECT last_tick_at,last_completed_at,last_result FROM ops_runtime WHERE id='fleet' LIMIT 1").first<{last_tick_at:string|null;last_completed_at:string|null;last_result:string|null}>(),
    env.DB.prepare('SELECT p.app_id,p.state,p.observed_at,p.next_due_at FROM ops_probes p JOIN ops_apps a ON a.id=p.app_id WHERE a.owner_email=? ORDER BY p.app_id LIMIT 64').bind(owner).all(),
    env.DB.prepare('SELECT id,label,last_seen_at,protocol_version FROM nodes WHERE revoked_at IS NULL AND paired_by=? ORDER BY last_seen_at DESC LIMIT 4').bind(owner).all<{id:string;label:string;last_seen_at:string|null;protocol_version:number}>(),
    env.DB.prepare("SELECT d.created_at FROM ops_delivery d JOIN ops_incidents i ON i.id=d.incident_id JOIN ops_apps a ON a.id=i.app_id WHERE d.state='pending' AND a.owner_email=? ORDER BY d.created_at LIMIT 1").bind(owner).first<{created_at:string}>(),
    env.DB.prepare('SELECT units,events,tasks,notifications FROM ops_budget WHERE day=?').bind(new Date().toISOString().slice(0,10)).first(),
  ]);
  const hub=env.HUB.get(env.HUB.idFromName('workspace'));
  const nodes=await Promise.all(nodeRows.results.map(async n=>({...n,connected:await hub.isNodeConnected(n.id),protocolReady:n.protocol_version>=REMOTE_MIN_PROTOCOL_VERSION})));
  const now=Date.now(), completed=Date.parse(runtime?.last_completed_at??''), deployed=Date.parse(env.CF_VERSION_METADATA?.timestamp??'');
  const grace=Number.isFinite(deployed)&&deployed<=now&&now-deployed<20*60000;
  return {runtime,probes:probes.results,nodes,budget,oldestPendingNoticeAt:notice?.created_at??null,
    notificationBacklog:!!notice&&Date.parse(notice.created_at)<=now&&now-Date.parse(notice.created_at)>30*60000,
    monitoring:env.OPS_ENABLED!=='true'?'pending_rollout':!Number.isFinite(completed)||completed>now?'unknown':now-completed>20*60000?'stale':'current',
    deploymentGrace:grace,deployedAt:env.CF_VERSION_METADATA?.timestamp??null,
    flags:{enabled:env.OPS_ENABLED==='true',investigation:env.OPS_INVESTIGATION_ENABLED==='true',recovery:env.OPS_RECOVERY_ENABLED==='true'}};
}
