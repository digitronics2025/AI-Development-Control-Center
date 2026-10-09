#!/usr/bin/env node
// First-time bridge setup. Values stay in memory and Cloudflare; never stdout.
// Existing/partial installations fail closed rather than rotating live senders.
import {randomBytes} from 'node:crypto';
const account=process.env.CLOUDFLARE_ACCOUNT_ID,credential=process.env.CLOUDFLARE_API_TOKEN;
if(!account||!credential)throw new Error('Cloudflare owner credentials must be supplied by the existing broker.');
const base=`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/`;
const purposes=['OPS_BRIDGE_TOKEN','OPS_READER_TOKEN','OPS_REGISTRATION_TOKEN','OPS_HEALTH_TOKEN','OPS_RECOVERY_TOKEN','OPS_NOTIFICATION_TOKEN'];
const required={'acc-cloud-control':purposes,'whatsapp-inbox-saas':purposes,'acc-cloud-control-staging':['OPS_HEALTH_TOKEN','OPS_READER_TOKEN']};
async function api(worker,path,body){
  const response=await fetch(`${base}${worker}/${path}`,{method:body?'PUT':'GET',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  const result=await response.json();
  if(!response.ok||result.success!==true)throw new Error(`Cloudflare request refused for ${worker}/${path} (HTTP ${response.status}); no secret values printed.`);
  return result.result;
}
const before={};
for(const [worker,names] of Object.entries(required)){
  const found=new Set((await api(worker,'secrets')).map(s=>s.name));
  before[worker]=names.filter(n=>found.has(n));
}
if(Object.entries(required).every(([w,n])=>before[w].length===n.length)){
  console.log('All operational secret bindings already exist; no rotation attempted. Verify the actual service handshake before claiming readiness.');
  process.exit(0);
}
if(Object.values(before).some(n=>n.length))throw new Error('Partial operational installation exists. Perform explicit owner credential recovery; no automatic rotation.');
// Record old deployed version IDs before changing any binding.
for(const worker of Object.keys(required)){
  const d=await api(worker,'deployments');
  console.log(JSON.stringify({worker,beforeVersions:d.deployments?.[0]?.versions?.map(v=>v.version_id)??[]}));
}
for(const name of purposes){
  const text=randomBytes(32).toString('base64url');
  for(const worker of ['acc-cloud-control','whatsapp-inbox-saas',...(name==='OPS_HEALTH_TOKEN'?['acc-cloud-control-staging']:[])])await api(worker,'secrets',{name,text,type:'secret_text'});
}
// Staging summary credentials cannot authenticate to production.
await api('acc-cloud-control-staging','secrets',{name:'OPS_READER_TOKEN',text:randomBytes(32).toString('base64url'),type:'secret_text'});
for(const [worker,names]of Object.entries(required)){
  const found=new Set((await api(worker,'secrets')).map(s=>s.name));
  if(names.some(n=>!found.has(n)))throw new Error(`Secret binding verification failed for ${worker}; release remains blocked.`);
  console.log(JSON.stringify({worker,boundPurposes:names.length}));
}
console.log('Scoped bindings installed. This does not establish a successful release or native recovery. Legacy credentials are untouched.');
