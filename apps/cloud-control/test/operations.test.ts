import { execFileSync } from 'node:child_process';
import { addRepo, createTestApp, makeRepo, simAdapters, waitFor } from '../../orchestrator/test/helpers.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCloud, httpJson, USER, type Cloud } from './harness.js';
import { OPS_LIMITS, validProof, type OpsEvent } from '../src/operations/contracts.js';

let cloud: Cloud;
let token: string;
const source = 'ops_test_app';
const app = {id:source,name:'Operations test app',repository:'example/operations',services:[{name:'test-worker',kind:'worker',release:'workers_builds',deployed:true}],dependencies:[],notificationSources:['test_bot'],jobs:[{id:'nightly_backup',intervalSeconds:86400,graceSeconds:7200}]};
const makeEvent = (id: string,extra: Record<string,unknown> = {}) => ({id,appId:source,resource:'database',operation:'database_backup',signature:'mirror_missing',classification:'technical',outcome:'failed',occurredAt:new Date().toISOString(),title:'Backup mirror is missing',detail:'Dump exists, off-provider mirror not verified.',...extra});
const send = (event: unknown, credential = token) => httpJson(cloud.url,'POST','/ops/v1/events',event,{authorization:`Bearer ${credential}`});
beforeAll(async () => {
  cloud = await startCloud({vars:{OPS_ENABLED:'true',OPS_INVESTIGATION_ENABLED:'true',OPS_OWNER_EMAIL:USER}});
});
afterAll(async () => { if (cloud) await cloud.stop(); });

describe('fleet operations real Workers runtime and D1', () => {
  it('keeps machine ingress separate from Access and restricts owner registration', async () => {
    expect((await httpJson(cloud.url,'POST','/api/cloud/operations/apps',app)).status).toBe(401);
    expect((await cloud.api('POST','/api/cloud/operations/apps',app,{'cf-access-jwt-assertion':await cloud.signer.token({email:'other@example.com'})})).status).toBe(403);
    expect((await cloud.api('POST','/api/cloud/operations/onboard',app,{'cf-access-jwt-assertion':await cloud.signer.token({email:'other@example.com'})})).status).toBe(403);
    expect((await cloud.api('POST','/api/cloud/operations/onboard',app)).status).toBe(503);
    expect((await cloud.api('POST','/api/cloud/operations/apps',app)).status).toBe(200);
    token = (await cloud.api('POST',`/api/cloud/operations/apps/${source}/credential`,{})).body.token;
    expect(token.length).toBeGreaterThan(40);
    const data = (await cloud.api('GET','/api/cloud/operations/apps')).body;
    expect(data.apps[0].jobs[0].intervalSeconds).toBe(86400);
    expect(JSON.stringify(data)).not.toContain(token);
    expect((await send(makeEvent('invalid_auth_001'),'invalid')).status).toBe(401);
    expect((await send(makeEvent('wrong_source_001',{appId:'another_app'}))).status).toBe(403);
    expect((await cloud.api('POST','/api/cloud/operations/apps',{...app,id:'bad_dependent',dependencies:['absent_app']})).status).toBe(400);
  });
  it('deduplicates concurrent delivery atomically and rejects changed idempotency payload', async () => {
    const e = makeEvent('backup_event_001');
    const responses = await Promise.all([send(e),send(e),send(e)]);
    expect(responses.every((r) => r.status===200)).toBe(true);
    const rows = await cloud.d1("SELECT occurrences FROM ops_incidents WHERE operation='database_backup'");
    expect(rows).toEqual([{occurrences:1}]);
    expect((await send({...e,title:'Different'})).status).toBe(422);
    expect((await cloud.d1('SELECT COUNT(*) n FROM ops_delivery'))[0].n).toBe(1);
  });
  it('keeps financial and uncertain-send alerts decision-only, with no command', async () => {
    await send(makeEvent('finance_event_001',{resource:'cheques',operation:'coverage_check',signature:'insufficient',classification:'business'}));
    await send(makeEvent('message_event_001',{resource:'outbox',operation:'message_send',signature:'unknown_provider_result',classification:'uncertain_delivery'}));
    expect((await cloud.d1("SELECT DISTINCT state FROM ops_incidents WHERE classification<>'technical'"))).toEqual([{state:'needs_owner'}]);
    expect((await cloud.d1('SELECT COUNT(*) n FROM remote_commands'))[0].n).toBe(0);
  });
  it('requires fresh downstream proof and the right backup evidence before resolution', async () => {
    const e = makeEvent('backup_healthy_001',{outcome:'healthy',proof:{kind:'job_result',observedAt:new Date().toISOString(),reference:'retry accepted'}});
    await send(e);
    expect((await cloud.d1("SELECT state FROM ops_incidents WHERE operation='database_backup'"))[0].state).toBe('detected');
    await send(makeEvent('backup_healthy_002',{outcome:'healthy',proof:{kind:'backup_artifact_and_mirror',observedAt:'2026-01-01T00:00:00.000Z',reference:'old dump'}}));
    expect((await cloud.d1("SELECT state FROM ops_incidents WHERE operation='database_backup'"))[0].state).toBe('detected');
    await send(makeEvent('backup_healthy_003',{outcome:'healthy',proof:{kind:'backup_artifact_and_mirror',observedAt:new Date().toISOString(),reference:'current dump and off-provider mirror receipt'}}));
    expect((await cloud.d1("SELECT state FROM ops_incidents WHERE operation='database_backup'"))[0].state).toBe('resolved');
  });
  it('survives Worker restart, checks due jobs, and leaves offline investigations pending', async () => {
    await cloud.restart();
    expect((await cloud.api('GET',`/api/cloud/operations/incidents?appId=${source}`)).body.incidents).toHaveLength(3);
    await cloud.d1("UPDATE ops_jobs SET next_due_at='2026-01-01T00:00:00.000Z'; UPDATE ops_runtime SET next_tick_at='1970-01-01T00:00:00.000Z'");
    const r = await cloud.api('POST','/api/cloud/operations/tick',{});
    expect(r.status).toBe(200);
    expect(r.body.missed).toBe(1);
    expect(r.body.statements).toBeLessThanOrEqual(48);
    // Bootstrap and detection can consume this tick's allowance. The pending
    // investigation resumes next tick within the D1 Free query ceiling.
    await cloud.d1("UPDATE ops_runtime SET next_tick_at='1970-01-01T00:00:00.000Z'");
    expect((await cloud.api('POST','/api/cloud/operations/tick',{})).body.statements).toBeLessThanOrEqual(48);
    expect((await cloud.d1("SELECT state FROM ops_incidents WHERE operation='job_health'"))[0].state).toBe('waiting_execution');
    expect((await cloud.d1('SELECT COUNT(*) n FROM remote_commands'))[0].n).toBe(0);
    expect((await cloud.api('POST','/api/cloud/operations/tick',{})).body.skipped).toBe(1);
  });
  it('creates exactly one typed investigation on a real test node and preserves task policy and isolation', async () => {
    const dir=await makeRepo();
    execFileSync('git',['remote','add','origin','https://github.com/example/operations.git'],{cwd:dir});
    const node=await createTestApp({adapters:simAdapters(10)});
    try {
      await addRepo(node,dir);
      const code=(await cloud.api('POST','/api/cloud/pairing-tokens',{label:'Operations test node'})).body.token;
      await node.services.remote.pair({relayUrl:cloud.url,code,label:'Operations test node'});
      await waitFor(()=>node.services.remote.status().state,s=>s==='connected',30000);
      await waitFor(async()=>(await cloud.d1('SELECT COUNT(*) n FROM node_repositories'))[0].n,n=>n>0,20000);
      await send(makeEvent('investigation_event_001',{operation:'ai_failure',resource:'AI helper',signature:'unavailable_provider'}));
      await cloud.d1("UPDATE ops_runtime SET next_tick_at='1970-01-01'; UPDATE ops_incidents SET next_action_at='1970-01-01' WHERE operation='ai_failure'");
      expect((await cloud.api('POST','/api/cloud/operations/tick',{})).status).toBe(200);
      const command=await waitFor(async()=>(await cloud.d1("SELECT status,task_id,body FROM remote_commands WHERE idempotency_key LIKE 'ops:%' LIMIT 1"))[0],r=>r?.task_id,20000);
      const body=JSON.parse(command.body);
      expect(body).toMatchObject({workflowId:'full-autopilot',maxFixCycles:2,worktree:true,supervised:true});
      expect(body.autoApproveUpToLevel).toBeUndefined();
      expect(body.policyMode).toBeUndefined();
      expect(node.services.store.getTask(command.task_id)).toBeTruthy();
      await cloud.d1("UPDATE ops_runtime SET next_tick_at='1970-01-01'; UPDATE ops_incidents SET next_action_at='1970-01-01' WHERE operation='ai_failure'");
      await cloud.api('POST','/api/cloud/operations/tick',{});
      expect((await cloud.d1("SELECT COUNT(*) n FROM remote_commands WHERE idempotency_key LIKE 'ops:%'"))[0].n).toBe(1);
    } finally {await node.close();}
  });
  it('opens a separate prevention investigation after three recurrences even when the outage recovers', async () => {
    for(let n=0;n<3;n++) {
      await send(makeEvent(`recurrence_failed_${n}`,{resource:'recurring backup'}));
      await send(makeEvent(`recurrence_proved_${n}`,{resource:'recurring backup',outcome:'healthy',proof:{kind:'backup_artifact_and_mirror',observedAt:new Date().toISOString(),reference:'current artifact and mirror'}}));
    }
    const parent=(await cloud.d1("SELECT recurrence_count,state FROM ops_incidents WHERE resource='recurring backup'"))[0];
    expect(parent).toMatchObject({recurrence_count:3,state:'resolved'});
    expect((await cloud.d1("SELECT state FROM ops_incidents WHERE operation='prevention_review'"))).toHaveLength(1);
  });
  it('rejects simultaneous conflicting event identities and prevents dependency cycles', async () => {
    const event=makeEvent('simultaneous_content_collision',{resource:'collision'});
    const responses=await Promise.all([send(event),send({...event,detail:'different content'})]);
    expect(responses.map(x=>x.status).sort()).toEqual([200,422]);
    await cloud.api('POST','/api/cloud/operations/apps',{...app,id:'dep_child',jobs:[],dependencies:[source]});
    expect((await cloud.api('POST','/api/cloud/operations/apps',{...app,dependencies:['dep_child']})).status).toBe(400);
  });
  it('uses indexes for due work and refuses work beyond the daily cost budget', async () => {
    const jobs = await cloud.d1("EXPLAIN QUERY PLAN SELECT * FROM ops_jobs WHERE enabled=1 AND next_due_at<'2030' ORDER BY next_due_at LIMIT 4");
    expect(JSON.stringify(jobs)).toContain('idx_ops_jobs_due');
    const incidents = await cloud.d1("EXPLAIN QUERY PLAN SELECT * FROM ops_incidents WHERE state IN ('detected','waiting_execution') AND next_action_at<'2030' ORDER BY next_action_at LIMIT 2");
    expect(JSON.stringify(incidents)).toContain('idx_ops_incidents_due');
    await cloud.d1(`UPDATE ops_budget SET units=${OPS_LIMITS.workUnitsPerDay}`);
    expect((await send(makeEvent('limited_event_001'))).status).toBe(429);
    expect((await cloud.d1("SELECT COUNT(*) n FROM ops_events WHERE id='limited_event_001'"))[0].n).toBe(0);
  });
  it('rotates source credentials without exposing or retaining the old bearer', async () => {
    const rotated = (await cloud.api('POST',`/api/cloud/operations/apps/${source}/credential`,{})).body.token;
    expect(rotated).not.toBe(token);
    expect((await send(makeEvent('old_token_event_001'))).status).toBe(401);
    expect((await cloud.api('GET','/api/cloud/operations/incidents')).status).toBe(400);
  });
});

it('does not confuse API acceptance with delivery, or old ARK proof with a new copy', () => {
  const now = Date.now(), failedAt = new Date(now-10000).toISOString();
  const e = makeEvent('proof_test_event_001',{operation:'message_send',outcome:'healthy',proof:{kind:'job_result',observedAt:new Date(now).toISOString(),reference:'HTTP 200'}}) as OpsEvent;
  expect(validProof(e,failedAt,now)).toBe(false);
  expect(validProof({...e,proof:{kind:'provider_delivered',observedAt:new Date(now).toISOString(),reference:'provider delivery receipt'}},failedAt,now)).toBe(true);
  expect(validProof({...e,operation:'ark_copy',proof:{kind:'current_ark_receipt',observedAt:new Date(now-20000).toISOString(),reference:'old'}},failedAt,now)).toBe(false);
});
