#!/usr/bin/env node
// Independent read-only fallback. No app egress, histories, repairs or writes.
import { pathToFileURL } from 'node:url';

function age(value, now) {
  const at=typeof value==='number'?value:Date.parse(value??'');
  return !Number.isFinite(at)||at<=0||at>now?null:now-at;
}
export function assessAvailability(input,now=Date.now()) {
  const issues=[];
  const messenger=age(input.messengerScheduledAt,now);
  if(messenger===null)issues.push('messenger_scheduler_unknown');
  else if(messenger>45*60000)issues.push('messenger_scheduler_stale');
  const grace=age(input.deployedAt,now);
  if(input.supervisorEnabled) {
    const completed=age(input.runtime?.last_completed_at,now);
    if(completed===null)issues.push('supervisor_completion_unknown');
    else if(completed>20*60000 && !(grace!==null&&grace<20*60000))issues.push('supervisor_completion_stale');
    let result;
    try {result=JSON.parse(input.runtime?.last_result??'{}');} catch {issues.push('supervisor_result_unknown');}
    if(result?.budgetLimited)issues.push('supervisor_coverage_limited');
    if(input.oldestPendingNoticeAt) {
      const pending=age(input.oldestPendingNoticeAt,now);
      if(pending===null)issues.push('notice_age_unknown');
      else if(pending>30*60000)issues.push('owner_delivery_pending');
    }
  }
  return {observedAt:new Date(now).toISOString(),state:issues.length?'attention':input.supervisorEnabled?'current':'pending_rollout',issues,
    deploymentGrace:grace!==null&&grace<20*60000,supervisorCompletedAt:input.runtime?.last_completed_at??null,
    messengerScheduledAt:typeof input.messengerScheduledAt==='number'&&Number.isFinite(input.messengerScheduledAt)?new Date(input.messengerScheduledAt).toISOString():null,
    oldestPendingNoticeAt:input.oldestPendingNoticeAt??null,
    evidence:'Scheduler and monitor liveness only. Individual jobs, execution and phone delivery remain separately verified.'};
}
export async function readAvailability() {
  if(!process.env.CLOUDFLARE_ACCOUNT_ID||!process.env.CLOUDFLARE_API_TOKEN)throw new Error('Configured Cloudflare identity is unavailable.');
  if((process.env.HTTPS_PROXY||process.env.HTTP_PROXY)&&process.env.NODE_USE_ENV_PROXY!=='1')throw new Error('Run with NODE_USE_ENV_PROXY=1 to preserve the managed proxy.');
  const base=`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}`;
  async function request(path,body,raw=false) {
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Cloudflare evidence unavailable (HTTP ${response.status}).`);
    if(raw)return response.text();
    const data=await response.json();
    if(!data.success)throw new Error('Cloudflare evidence could not be read.');
    return data.result;
  }
  const [stamp,settings]=await Promise.all([
    request('/storage/kv/namespaces/70bfb7e410c84c459264f4cf89a314c5/values/cron:heartbeat:last-scheduled-ms',undefined,true).catch(()=>null),
    request('/workers/scripts/acc-cloud-control/settings'),
  ]);
  const enabled=settings.bindings?.find(b=>b.type==='plain_text'&&b.name==='OPS_ENABLED')?.text==='true';
  const input={messengerScheduledAt:stamp&&/^\d+$/.test(stamp)?Number(stamp):null,supervisorEnabled:enabled};
  if(enabled) {
    const query=sql=>request('/d1/database/8a7b3714-b772-4009-9f75-74caf13973fa/query',{sql,params:[]});
    const [runtime,notice]=await Promise.all([
      query("SELECT last_tick_at,last_completed_at,last_result FROM ops_runtime WHERE id='fleet' LIMIT 1;"),
      query("SELECT created_at FROM ops_delivery WHERE state='pending' ORDER BY created_at LIMIT 1;"),
    ]);
    input.runtime=runtime[0]?.results?.[0]??null;
    input.oldestPendingNoticeAt=notice[0]?.results?.[0]?.created_at??null;
    const completed=age(input.runtime?.last_completed_at,Date.now());
    if(completed===null||completed>20*60000) {
      const deployments=await request('/workers/scripts/acc-cloud-control/deployments');
      input.deployedAt=deployments.deployments?.[0]?.created_on;
    }
  }
  return assessAvailability(input);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(await readAvailability()));}
  catch(error) {console.log(JSON.stringify({state:'unavailable',observedAt:new Date().toISOString(),reason:error instanceof Error?error.message:'Evidence unavailable.'}));process.exitCode=1;}
}
