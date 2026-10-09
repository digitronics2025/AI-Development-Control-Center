import { sha256Hex } from '@acc/shared';
import { HttpError, nowIso, randomToken } from '../http.js';
import { appSchema, OPS_LIMITS, type OpsApp } from './contracts.js';

export interface AppRow { id: string; name: string; owner_email: string; repository: string; contract: string; enabled: number }
export class AppRegistry {
  constructor(private readonly db: D1Database) {}
  async register(input: unknown, owner: string): Promise<OpsApp> {
    const parsed = appSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'OPS_INVALID_APP', 'Invalid operations registration.', parsed.error.flatten());
    const a = parsed.data;
    const existing = await this.get(a.id);
    if (existing && existing.owner_email !== owner) throw new HttpError(403, 'OPS_OWNER', 'This app belongs to another owner.');
    const total = await this.db.prepare('SELECT COUNT(*) AS n FROM ops_apps').first<{ n: number }>();
    if (!existing && (total?.n ?? 0) >= OPS_LIMITS.apps) throw new HttpError(409, 'OPS_REGISTRY_FULL', 'App registry limit reached.');
    const known=(await this.db.prepare('SELECT id,owner_email,contract FROM ops_apps LIMIT 64').all<{id:string;owner_email:string;contract:string}>()).results;
    const map=new Map(known.map(x=>[x.id,x])),seen=new Set<string>(),pending=[...a.dependencies];
    while(pending.length) {
      const dep=pending.pop()!;
      if(dep===a.id) throw new HttpError(400,'OPS_DEPENDENCY_CYCLE','Dependencies cannot form a cycle.');
      if(seen.has(dep))continue;
      seen.add(dep);
      const parent=map.get(dep);
      if(!parent||parent.owner_email!==owner)throw new HttpError(400, 'OPS_DEPENDENCY', 'Register own dependencies before consumers.');
      pending.push(...appSchema.parse(JSON.parse(parent.contract)).dependencies);
    }
    const now = nowIso();
    const statements = [...(!existing ? [this.db.prepare("UPDATE ops_registry_capacity SET used=used+1 WHERE id='apps' AND NOT EXISTS (SELECT 1 FROM ops_apps WHERE id=?)").bind(a.id)] : []),this.db.prepare(`INSERT INTO ops_apps(id,name,owner_email,repository,contract,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,repository=excluded.repository,contract=excluded.contract,updated_at=excluded.updated_at
      WHERE ops_apps.owner_email=excluded.owner_email AND ops_apps.contract<>excluded.contract`).bind(a.id,a.name,owner,a.repository,JSON.stringify(a),now)];
    // Preserve successful activity; schedule edits reset the deadline, never rerun the job.
    for (const j of a.jobs.filter(j=>j.heartbeatExpected)) statements.push(this.db.prepare(`INSERT INTO ops_jobs(app_id,id,interval_seconds,grace_seconds,next_due_at,enabled) VALUES(?,?,?,?,?,?)
      ON CONFLICT(app_id,id) DO UPDATE SET interval_seconds=excluded.interval_seconds,grace_seconds=excluded.grace_seconds,
      enabled=excluded.enabled,next_due_at=excluded.next_due_at WHERE ops_jobs.interval_seconds<>excluded.interval_seconds OR ops_jobs.grace_seconds<>excluded.grace_seconds OR ops_jobs.enabled<>excluded.enabled`)
      .bind(a.id,j.id,j.intervalSeconds,j.graceSeconds,new Date(Date.now()+(j.intervalSeconds+j.graceSeconds)*1000).toISOString(),j.heartbeatExpected?1:0));
    const keep = a.jobs.filter(j=>j.heartbeatExpected).map((j) => j.id);
    statements.push(keep.length ? this.db.prepare(`UPDATE ops_jobs SET enabled=0 WHERE app_id=? AND enabled=1 AND id NOT IN (${keep.map(() => '?').join(',')})`).bind(a.id,...keep)
      : this.db.prepare('UPDATE ops_jobs SET enabled=0 WHERE app_id=? AND enabled=1').bind(a.id));
    await this.db.batch(statements);
    return a;
  }
  async bootstrap(input:unknown[],owner:string):Promise<void> {
    const apps=input.map(a=>appSchema.parse(a)),known=(await this.db.prepare('SELECT id,owner_email FROM ops_apps LIMIT 64').all<{id:string;owner_email:string}>()).results;
    const map=new Map(known.map(a=>[a.id,a.owner_email]));
    for(const a of apps) {
      if(map.has(a.id)&&map.get(a.id)!==owner)throw new HttpError(403,'OPS_OWNER','Seed belongs to another owner.');
      map.set(a.id,owner);
    }
    for(const a of apps)for(const dep of a.dependencies)if(map.get(dep)!==owner)throw new HttpError(400,'OPS_DEPENDENCY','Seed dependency not owned.');
    const now=nowIso(),ids=apps.map(a=>a.id);
    // Count only still-missing seed identities inside the same transaction;
    // concurrent onboarding must not inflate the capacity counter.
    const statements=[this.db.prepare(`UPDATE ops_registry_capacity SET used=used+?- (SELECT COUNT(*) FROM ops_apps WHERE id IN (${ids.map(()=>'?').join(',')})) WHERE id='apps'`).bind(ids.length,...ids)];
    for(const a of apps) {
      statements.push(this.db.prepare(`INSERT INTO ops_apps(id,name,owner_email,repository,contract,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,repository=excluded.repository,contract=excluded.contract,updated_at=excluded.updated_at
        WHERE ops_apps.owner_email=excluded.owner_email AND ops_apps.contract<>excluded.contract`).bind(a.id,a.name,owner,a.repository,JSON.stringify(a),now));
      // Seed jobs have no connected receipt yet. Keep that explicit contract
      // metadata without creating due entries or polling application tables.
      if(a.jobs.some(j=>j.heartbeatExpected))throw new HttpError(400,'OPS_SEED_RECEIPT','Seeds cannot invent an enabled receipt. Register verified producers normally.');
    }
    for(const appId of ['messenger','digitronics_website','sales_analyzer','product_hunter','applybridge'])statements.push(this.db.prepare('INSERT INTO ops_probes(app_id,next_due_at) VALUES(?,?) ON CONFLICT(app_id) DO NOTHING').bind(appId,now));
    statements.push(this.db.prepare("UPDATE ops_runtime SET bootstrap_version='1' WHERE id='fleet'"));
    await this.db.batch(statements);
  }
  get(id: string): Promise<AppRow | null> { return this.db.prepare('SELECT id,name,owner_email,repository,contract,enabled FROM ops_apps WHERE id=?').bind(id).first<AppRow>(); }
  async list(owner:string): Promise<OpsApp[]> { const r = await this.db.prepare('SELECT contract FROM ops_apps WHERE owner_email=? ORDER BY id LIMIT ?').bind(owner,OPS_LIMITS.apps).all<{contract:string}>(); return r.results.map((a) => appSchema.parse(JSON.parse(a.contract))); }
  async rotateCredential(id: string, owner: string): Promise<string> {
    const a = await this.get(id);
    if (!a || a.owner_email !== owner) throw new HttpError(404, 'OPS_APP_NOT_FOUND', 'App not found.');
    const token = randomToken(32);
    await this.db.prepare('UPDATE ops_apps SET token_hash=?,updated_at=? WHERE id=? AND owner_email=?').bind(await sha256Hex(token),nowIso(),id,owner).run();
    return token;
  }
  async firstCredential(id: string, owner: string): Promise<string|null> {
    const token=randomToken(32);
    const won=await this.db.prepare('UPDATE ops_apps SET token_hash=? WHERE id=? AND owner_email=? AND token_hash IS NULL RETURNING id')
      .bind(await sha256Hex(token),id,owner).first();
    return won ? token : null;
  }
  async authenticate(request: Request): Promise<AppRow> {
    const actual = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!actual) throw new HttpError(401,'OPS_UNAUTHORIZED','A scoped app credential is required.');
    const app = await this.db.prepare('SELECT id,name,owner_email,repository,contract,enabled FROM ops_apps WHERE token_hash=? AND enabled=1').bind(await sha256Hex(actual)).first<AppRow>();
    if (!app) throw new HttpError(401,'OPS_UNAUTHORIZED','Invalid app credential.');
    return app;
  }
}
