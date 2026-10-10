import { actionableIncidentQuery } from './due-incidents.js';
import type { Incident } from './contracts.js';
export interface DueJob {app_id:string;id:string;next_due_at:string;last_success_at:string|null;}
export interface DueNotice {id:string;incident_id:string;body:string;attempts:number;}
export interface DueProbe {app_id:string;state:string;observed_at:string|null;}
const incidentColumns='id app_id fingerprint resource operation signature classification state title detail evidence_uri dependency_id first_seen_at last_seen_at failed_at occurrences recurrence_count recurrence_started_at prevention_required version command_id task_id node_id repair_attempts proof next_action_at resolved_at'.split(' ');
const payload=(columns:string[])=>`json_object(${columns.map(c=>`'${c}',${c}`).join(',')})`;
/** One statement, independently indexed LIMITs before UNION ALL. Maximum ten
 * results; no unbounded queue aggregation or application database queries. */
export function dueWorkQuery(owner:string,now:string,actionsEnabled:boolean) {
  const actions=actionableIncidentQuery(owner,now,actionsEnabled);
  return {sql:[
    `SELECT 'incident' AS kind,${payload(incidentColumns)} AS payload FROM (${actions.sql})`,
    `SELECT 'job',${payload(['app_id','id','next_due_at','last_success_at'])} FROM (SELECT j.app_id,j.id,j.next_due_at,j.last_success_at FROM ops_jobs j JOIN ops_apps a ON a.id=j.app_id WHERE j.enabled=1 AND j.next_due_at<=? AND a.enabled=1 AND a.owner_email=? ORDER BY j.next_due_at LIMIT 4)`,
    `SELECT 'notice',${payload(['id','incident_id','body','attempts'])} FROM (SELECT d.id,d.incident_id,d.body,d.attempts FROM ops_delivery d JOIN ops_incidents i ON i.id=d.incident_id JOIN ops_apps a ON a.id=i.app_id WHERE d.state='pending' AND d.next_due_at<=? AND a.owner_email=? ORDER BY d.next_due_at LIMIT 2)`,
    `SELECT 'probe',${payload(['app_id','state','observed_at'])} FROM (SELECT p.app_id,p.state,p.observed_at FROM ops_probes p JOIN ops_apps a ON a.id=p.app_id WHERE a.enabled=1 AND a.owner_email=? AND p.next_due_at<=? ORDER BY p.next_due_at LIMIT 2)`,
  ].join(' UNION ALL '),params:[...actions.params,now,owner,now,owner,owner,now]};
}
export function parseDueWork(rows:Array<{kind:string;payload:string}>) {
  const take=<T>(kind:string)=>rows.filter(r=>r.kind===kind).map(r=>JSON.parse(r.payload) as T);
  return {incidents:take<Incident>('incident'),jobs:take<DueJob>('job'),notices:take<DueNotice>('notice'),probes:take<DueProbe>('probe')};
}
