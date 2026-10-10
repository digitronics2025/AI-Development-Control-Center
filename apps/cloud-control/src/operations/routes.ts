import { sha256Hex } from '@acc/shared';
import type { AccessIdentity } from '../auth/access.js';
import type { Env } from '../env.js';
import { clientIp, HttpError, json, readJson } from '../http.js';
import { eventSchema, OPS_LIMITS } from './contracts.js';
import { tickOperations } from './monitor.js';
import { OperationsStore } from './store.js';
import { operationsStatus } from './summary.js';

export async function operationsApi(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
  if (!env.OPS_OWNER_EMAIL || identity.email.toLowerCase()!==env.OPS_OWNER_EMAIL.toLowerCase()) throw new HttpError(403,'OPS_OWNER','Operations access is restricted to its configured owner.');
  const url = new URL(request.url), path = url.pathname, store = new OperationsStore(env.DB);
  const base = '/api/cloud/operations';
  if (request.method !== 'GET' && !(await env.COMMAND_LIMITER.limit({key:`ops-owner:${identity.email}`})).success) throw new HttpError(429,'RATE_LIMITED','Too many operations actions.');
  if (path===`${base}/apps`) {
    if (request.method==='GET') return json({apps:await store.registry.list(identity.email.toLowerCase()),limits:OPS_LIMITS});
    if (request.method==='POST') return json({app:await store.registry.register(await readJson(request,OPS_LIMITS.requestBytes),identity.email.toLowerCase())});
  }
  // An authenticated owner can onboard through the existing Access broker;
  // app-creation clients need not retain the cross-service provisioning key.
  if(path===`${base}/onboard`&&request.method==='POST')return onboardApp(request,env,store,identity.email.toLowerCase());
  const credential = new RegExp(`^${base}/apps/([a-z][a-z0-9_-]{2,63})/credential$`).exec(path);
  if (credential && request.method==='POST') return json({token:await store.registry.rotateCredential(credential[1]!,identity.email.toLowerCase())},200,{'cache-control':'no-store'});
  if (path===`${base}/incidents` && request.method==='GET') {
    const app = url.searchParams.get('appId');
    if (!app) throw new HttpError(400,'OPS_APP_REQUIRED','Choose an app; unbounded incident scans are not supported.');
    await ownedApp(store,app,identity.email.toLowerCase());
    return json(await store.page(app,url.searchParams.get('cursor')??undefined));
  }
  const incident = new RegExp(`^${base}/incidents/(incident_[a-f0-9]{32})$`).exec(path);
  if (incident && request.method==='GET') {
    const row=await store.incident(incident[1]!);
    if(row)await ownedApp(store,row.app_id,identity.email.toLowerCase());
    return json({incident:row});
  }
  if (path===`${base}/status` && request.method==='GET') return json({...await operationsStatus(env,identity.email.toLowerCase()),limits:OPS_LIMITS});
  if (path===`${base}/tick` && request.method==='POST') return json(await tickOperations(env));
  throw new HttpError(404,'NOT_FOUND','Operations route not found.');
}

/** Machine ingress has a separate relay-host namespace; it never bypasses Access on /api. */
export async function operationsIngress(request: Request, env: Env): Promise<Response> {
  const rate = await env.AUTH_LIMITER.limit({key:`ops:${clientIp(request)}`});
  if (!rate.success) throw new HttpError(429,'RATE_LIMITED','Too many operations requests.');
  const path = new URL(request.url).pathname, store = new OperationsStore(env.DB);
  if (path==='/ops/v1/apps' && request.method==='POST') {
    await authenticateBridge(request,env.OPS_REGISTRATION_TOKEN);
    if(!env.OPS_OWNER_EMAIL)throw new HttpError(503,'OPS_NOT_CONFIGURED','App onboarding is not configured.');
    return onboardApp(request,env,store,env.OPS_OWNER_EMAIL);
  }
  if (path==='/ops/v1/events' && request.method==='POST') {
    const app = await store.registry.authenticate(request);
    if(app.owner_email!==env.OPS_OWNER_EMAIL)throw new HttpError(403,'OPS_OWNER','App is outside the current owner scope.');
    return json(await store.ingest(await readJson(request,OPS_LIMITS.requestBytes),app.id));
  }
  if (path==='/ops/v1/notification-events' && request.method==='POST') {
    await authenticateBridge(request,env.OPS_BRIDGE_TOKEN);
    const raw = await readJson(request,OPS_LIMITS.requestBytes) as Record<string,unknown>;
    if (raw.ownerEmail!==env.OPS_OWNER_EMAIL) throw new HttpError(403,'OPS_OWNER','Notification is not for the configured owner.');
    const e = eventSchema.safeParse(raw.event);
    if (!e.success) throw new HttpError(400,'OPS_INVALID_EVENT','Invalid notification event.');
    await ownedApp(store,e.data.appId,env.OPS_OWNER_EMAIL!);
    return json(await store.ingest(e.data,e.data.appId,false));
  }
  if (path==='/ops/v1/summary' && request.method==='GET') {
    await authenticateBridge(request,env.OPS_READER_TOKEN);
    const appId = new URL(request.url).searchParams.get('appId');
    if(!env.OPS_OWNER_EMAIL)throw new HttpError(503,'OPS_NOT_CONFIGURED','Operations owner is missing.');
    if(appId)await ownedApp(store,appId,env.OPS_OWNER_EMAIL);
    return json(appId ? await store.page(appId,new URL(request.url).searchParams.get('cursor')??undefined) : {
      apps:await store.registry.list(env.OPS_OWNER_EMAIL),...await operationsStatus(env,env.OPS_OWNER_EMAIL),limits:OPS_LIMITS});
  }
  throw new HttpError(404,'NOT_FOUND','Not found.');
}
async function onboardApp(request:Request,env:Env,store:OperationsStore,owner:string):Promise<Response>{
  if(!env.OPS_MESSENGER||!env.OPS_REGISTRATION_TOKEN)throw new HttpError(503,'OPS_NOT_CONFIGURED','App onboarding is not configured.');
    const raw=await readJson(request,OPS_LIMITS.requestBytes) as Record<string,unknown>;
    if (!raw || typeof raw!=='object' || Array.isArray(raw) || typeof raw.id!=='string'||!/^[a-z][a-z0-9_]{2,39}$/.test(raw.id)) throw new HttpError(400,'OPS_SOURCE_ID','Notification app identities use 3–40 lowercase letters, numbers and underscores.');
    const app=await store.registry.register(raw,owner);
    const response=await env.OPS_MESSENGER.fetch(new Request('https://messenger.digitronics.app/api/v1/internal/notifications/register',{
      method:'POST',headers:{authorization:`Bearer ${env.OPS_REGISTRATION_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({id:app.id,displayName:`${app.name} Bot`.slice(0,80)}),signal:AbortSignal.timeout(8000)}));
    if (!response.ok) throw new HttpError(503,'OPS_ONBOARDING_PENDING','App registry saved; notification provisioning is pending. Retry the same registration.');
    const source=await response.json() as {id:string;created:boolean;token:string|null};
    if (source.id!==app.id || typeof source.created!=='boolean' || (source.token!==null&&typeof source.token!=='string')) throw new HttpError(502,'OPS_PROVISIONING_RESPONSE','Invalid notification provisioner response.');
    const eventToken=await store.registry.firstCredential(app.id,owner);
    return json({app,notificationSource:source,eventToken,credentialNotice:'New credentials are returned once. Store them in the app secret manager; never in chat or Git. Repeated registration does not rotate credentials.'},201,{'cache-control':'no-store'});
}
async function ownedApp(store:OperationsStore,id:string,owner:string):Promise<void>{
  const app=await store.registry.get(id);
  if(!app||app.owner_email!==owner)throw new HttpError(404,'OPS_APP_NOT_FOUND','App not found.');
}
async function authenticateBridge(request: Request, expected: string|undefined): Promise<void> {
  const supplied = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!expected || !supplied || await sha256Hex(supplied)!==await sha256Hex(expected)) throw new HttpError(401,'OPS_UNAUTHORIZED','Integration credential required.');
}
