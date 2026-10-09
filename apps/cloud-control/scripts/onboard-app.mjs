#!/usr/bin/env node
// Owner app-creation workflow. Provisioner authority stays with the owner;
// producers receive only their individual source/event tokens, never this key.
import {readFile} from 'node:fs/promises';
const [contractFile,workerName]=process.argv.slice(2);
if(!contractFile||!workerName||!/^[a-z0-9][a-z0-9-]{1,62}$/.test(workerName))throw new Error('Usage: node onboard-app.mjs <contract.json> <deployed-worker-name>');
const contract=JSON.parse(await readFile(contractFile,'utf8'));
if(!contract.services?.some(s=>s.name===workerName&&s.kind==='worker'&&s.deployed===true))throw new Error('Worker must be a deployed service in this contract.');
const secret=process.env.OPS_REGISTRATION_TOKEN,access=process.env.OPS_ACCESS_JWT,apiToken=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;
if((!secret&&!access)||!apiToken||!account)throw new Error('Owner credential broker must supply registration and Cloudflare credentials; never paste them in chat.');
const origin='https://acc.dr-badawi-abdalsalam.com';
const target=access?`${origin}/api/cloud/operations/onboard`:'https://acc-relay.dr-badawi-abdalsalam.com/ops/v1/apps';
const headers=access?{'cf-access-jwt-assertion':access,origin,'content-type':'application/json'}:{authorization:`Bearer ${secret}`,'content-type':'application/json'};
const response=await fetch(target,{method:'POST',headers,body:JSON.stringify(contract),signal:AbortSignal.timeout(20000)});
if(!response.ok)throw new Error(`Onboarding pending (HTTP ${response.status}); retry the same identity. No credentials printed.`);
const result=await response.json();
for(const [name,text]of [['FLEET_EVENT_TOKEN',result.eventToken],['FLEET_NOTIFICATIONS_TOKEN',result.notificationSource?.token]]) {
 if(!text)continue;
 const saved=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${workerName}/secrets`,{method:'PUT',headers:{authorization:`Bearer ${apiToken}`,'content-type':'application/json'},body:JSON.stringify({name,text,type:'secret_text'}),signal:AbortSignal.timeout(20000)});
 const receipt=await saved.json();
 if(!saved.ok||receipt.success!==true)throw new Error(`Secret installation failed for ${name}. Do not repeat sends or silently rotate credentials; perform an owner-authorized credential recovery.`);
}
const verification=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${workerName}/secrets`,{headers:{authorization:`Bearer ${apiToken}`},signal:AbortSignal.timeout(20000)});
const verified=await verification.json(),names=new Set((verified.result??[]).map(s=>s.name));
const expected=['FLEET_EVENT_TOKEN',...(result.notificationSource?.legacy?[]:['FLEET_NOTIFICATIONS_TOKEN'])];
if(!verification.ok||verified.success!==true||expected.some(name=>!names.has(name)))throw new Error('Onboarding metadata exists but producer credentials are missing. Explicit owner credential recovery is required; no automatic rotation.');
console.log(`Registered ${result.app.id}; required individual credential bindings exist. Reader discovery requires the bot's first message; job monitoring requires real receipts.`);
