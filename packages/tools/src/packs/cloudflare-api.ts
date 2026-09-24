import { z } from 'zod';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';
import { limitReadSql, strictReadSql } from '../sql.js';
import { apiBase, pathSegment, restRequest, type RestResponse } from './rest.js';

/**
 * Read-only Cloudflare data through the REST API (docs/systems/ask.md): D1,
 * KV, R2 and Workers. No Wrangler, no working copy, no OAuth fallback: every
 * call needs the brokered `cloudflare` token (a read-only token for Ask) and
 * an account id. Nothing here can write — the SQL path refuses anything but
 * one read statement before a request is made — so every operation is
 * `readOnly`. Reads of stored data are Level 2 like the Wrangler pack's
 * remote reads; the account's data is live data, so they carry the
 * `production` effect.
 */

const CREDENTIALS = ['cloudflare'] as const;
const REAL_API = 'https://api.cloudflare.com/client/v4';
const name = z.string().min(1).max(200).regex(/^[\w.:-]+$/, 'Letters, digits, dot, colon, dash and underscore only');
const objectKey = z.string().min(1).max(1024).refine((k) => !hasControlCharacter(k), 'Control characters are not allowed');
/** Below U+0020: never part of a real key or path. */
function hasControlCharacter(value: string): boolean {
  return [...value].some((c) => c.charCodeAt(0) < 0x20);
}

const LIVE = { level: 2 as const, effects: ['network' as const, 'production' as const], reasons: ['Reads live data on Cloudflare'], writes: false };

const MAX_ROWS = 500;
const MAX_OBJECT_BYTES = 256 * 1024;
const MAX_KV_BYTES = 64 * 1024;
const CATALOG_TTL_MS = 5 * 60_000;

interface Account {
  token: string;
  account: string;
  base: string;
}

function account(ctx: OperationContext): Account | OperationResult {
  const token = ctx.env.CLOUDFLARE_API_TOKEN;
  if (!token) return failure('AUTH_REQUIRED', 'No Cloudflare key is available: add a read-only Cloudflare token in Settings → Ask (or Tools → Credentials).');
  const id = ctx.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id || !/^[0-9a-f]{32}$/i.test(id)) return failure('AUTH_REQUIRED', 'No Cloudflare account id is set: add it in Settings → Ask.');
  return { token, account: id, base: apiBase(ctx, REAL_API, 'ACC_CF_API_BASE') };
}

function isAccount(a: Account | OperationResult): a is Account {
  return 'token' in a;
}

async function cf(ctx: OperationContext, a: Account, route: string, body?: unknown, maxBytes?: number): Promise<RestResponse> {
  return restRequest(ctx, `${a.base}/accounts/${a.account}${route}`, { headers: { authorization: `Bearer ${a.token}` }, body, maxBytes });
}

/** A failed call, in words: auth, not found, or Cloudflare's own first error message. */
function cfFailure(r: RestResponse, what: string): OperationResult {
  const message = (r.json?.errors?.[0]?.message as string | undefined) ?? (r.text.slice(0, 200) || `HTTP ${r.status}`);
  if (r.status === 401 || r.status === 403) return failure('AUTH_REQUIRED', `Cloudflare refused ${what}: ${message}. The key may lack the read permission for it.`);
  if (r.status === 404) return failure('FAILED', `${what}: not found (${message}).`);
  if (r.status === 429 || r.status >= 500) return failure('UNAVAILABLE', `Cloudflare is not answering ${what} right now (HTTP ${r.status}).`);
  return failure('FAILED', `${what} failed: ${message}`);
}

const net = { networkTargets: ['api.cloudflare.com'] };

// ----- catalog --------------------------------------------------------------------------

interface Catalog {
  d1: Array<{ uuid: string; name: string; sizeBytes: number | null; tables: number | null; createdAt: string | null }>;
  kv: Array<{ id: string; title: string }>;
  r2: Array<{ name: string; createdAt: string | null }>;
  workers: Array<{ name: string; modifiedAt: string | null }>;
  errors: string[];
}

const catalogCache = new Map<string, { at: number; catalog: Catalog }>();

async function pages<T>(ctx: OperationContext, a: Account, route: string, pick: (json: any) => T[], max = 500): Promise<{ items: T[]; error: string | null }> {
  const items: T[] = [];
  for (let page = 1; items.length < max && page <= 10; page++) {
    const r = await cf(ctx, a, `${route}${route.includes('?') ? '&' : '?'}page=${page}&per_page=100`);
    if (!r.ok) return { items, error: cfFailure(r, route.split('?')[0]!).summary };
    const batch = pick(r.json);
    items.push(...batch);
    const info = r.json?.result_info;
    if (!batch.length || !info || (info.total_pages ?? 1) <= page) break;
  }
  return { items, error: null };
}

async function loadCatalog(ctx: OperationContext, a: Account, fresh = false): Promise<Catalog> {
  const key = a.account;
  const hit = catalogCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
  const [d1, kv, r2, workers] = await Promise.all([
    pages(ctx, a, '/d1/database', (j) => ((j?.result ?? []) as any[]).map((d) => ({ uuid: String(d.uuid), name: String(d.name), sizeBytes: typeof d.file_size === 'number' ? d.file_size : null, tables: typeof d.num_tables === 'number' ? d.num_tables : null, createdAt: d.created_at ?? null }))),
    pages(ctx, a, '/storage/kv/namespaces', (j) => ((j?.result ?? []) as any[]).map((n) => ({ id: String(n.id), title: String(n.title) }))),
    (async () => {
      const r = await cf(ctx, a, '/r2/buckets');
      if (!r.ok) return { items: [], error: cfFailure(r, 'R2 buckets').summary };
      return { items: ((r.json?.result?.buckets ?? []) as any[]).map((b) => ({ name: String(b.name), createdAt: b.creation_date ?? null })), error: null };
    })(),
    pages(ctx, a, '/workers/scripts', (j) => ((j?.result ?? []) as any[]).map((w) => ({ name: String(w.id), modifiedAt: w.modified_on ?? null }))),
  ]);
  const catalog: Catalog = { d1: d1.items, kv: kv.items, r2: r2.items, workers: workers.items, errors: [d1.error, kv.error, r2.error, workers.error].filter((e): e is string => Boolean(e)) };
  if (!catalog.errors.length) catalogCache.set(key, { at: Date.now(), catalog });
  return catalog;
}

/** A name or id from the catalog; refreshed once on a miss. */
async function resolve<T>(ctx: OperationContext, a: Account, list: (c: Catalog) => T[], match: (item: T) => boolean, label: string, names: (c: Catalog) => string[]): Promise<T | OperationResult> {
  for (const fresh of [false, true]) {
    const catalog = await loadCatalog(ctx, a, fresh);
    const found = list(catalog).find(match);
    if (found) return found;
    if (fresh) {
      const known = names(catalog);
      return failure('FAILED', `No ${label} with that name. Known: ${known.length ? known.slice(0, 30).join(', ') : 'none visible to this key'}.`);
    }
  }
  return failure('FAILED', `No ${label} with that name.`);
}

function isResult(x: unknown): x is OperationResult {
  return typeof x === 'object' && x !== null && 'ok' in x && 'summary' in x;
}

// ----- D1 -------------------------------------------------------------------------------

async function d1Query(ctx: OperationContext, a: Account, uuid: string, sql: string): Promise<{ ok: true; rows: Record<string, unknown>[]; meta: Record<string, unknown> } | { ok: false; result: OperationResult }> {
  const r = await cf(ctx, a, `/d1/database/${pathSegment(uuid)}/query`, { sql }, 8 * 1024 * 1024);
  if (!r.ok) return { ok: false, result: cfFailure(r, 'the D1 query') };
  if (r.truncated || r.json === null) return { ok: false, result: failure('FAILED', 'The D1 answer was too large to read. Select fewer columns or aggregate (COUNT, SUM, GROUP BY).') };
  const first = (r.json?.result ?? [])[0] as { results?: Record<string, unknown>[]; meta?: Record<string, unknown>; success?: boolean } | undefined;
  if (!first || first.success === false) return { ok: false, result: failure('FAILED', 'D1 returned no result for the query.') };
  return { ok: true, rows: first.results ?? [], meta: first.meta ?? {} };
}

async function database(ctx: OperationContext, a: Account, value: string) {
  return resolve(ctx, a, (c) => c.d1, (d) => d.name === value || d.uuid === value, 'D1 database', (c) => c.d1.map((d) => d.name));
}

// ----- provider -------------------------------------------------------------------------

export function cloudflareApiProvider(): ToolProvider {
  return {
    id: 'cloudflare-api',
    name: 'Cloudflare data (read-only)',
    description: 'Reads D1, KV, R2 and Workers through the Cloudflare API with a brokered token; nothing here can change anything.',
    category: 'cloudflare',
    builtin: true,
    async detect() {
      return builtinDetection();
    },
    operations: [
      operation({
        id: 'cloudflare.catalog',
        title: 'List Cloudflare data stores',
        description: 'D1 databases (name, size, tables), KV namespaces, R2 buckets and Workers on the account. Start here to find the names other cloudflare.* reads take.',
        input: z.object({}),
        level: 2,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => LIVE,
        async run(_input, ctx) {
          const a = account(ctx);
          if (!isAccount(a)) return a;
          const c = await loadCatalog(ctx, a, true);
          const ok = c.errors.length < 4;
          const summary = `${c.d1.length} D1 database(s), ${c.kv.length} KV namespace(s), ${c.r2.length} R2 bucket(s), ${c.workers.length} Worker(s)${c.errors.length ? `; not readable: ${c.errors.join('; ')}` : ''}`;
          return ok ? { ok, summary, output: c, ...net } : failure('AUTH_REQUIRED', summary);
        },
      }),
      operation({
        id: 'cloudflare.d1_schema',
        title: 'Describe a D1 database',
        description: 'Tables of a D1 database with their columns and types, and row counts for up to 30 tables. Use before writing a query.',
        input: z.object({ database: name }),
        level: 2,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => LIVE,
        async run(input, ctx) {
          const a = account(ctx);
          if (!isAccount(a)) return a;
          const db = await database(ctx, a, input.database);
          if (isResult(db)) return db;
          const tables = await d1Query(ctx, a, db.uuid, "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' AND name NOT LIKE '!_cf!_%' ESCAPE '!' ORDER BY name");
          if (!tables.ok) return tables.result;
          const out: Array<{ table: string; columns: string; rows: number | null }> = [];
          for (const t of tables.rows.slice(0, 30)) {
            const tableName = String(t.name);
            const quoted = `"${tableName.replace(/"/g, '""')}"`;
            const count = await d1Query(ctx, a, db.uuid, `SELECT COUNT(*) AS n FROM ${quoted}`);
            out.push({ table: tableName, columns: String(t.sql ?? '').replace(/\s+/g, ' ').slice(0, 1500), rows: count.ok ? Number(count.rows[0]?.n ?? 0) : null });
          }
          return { ok: true, summary: `${db.name}: ${tables.rows.length} table(s)`, output: { database: db.name, tables: out, more: Math.max(0, tables.rows.length - 30) }, ...net };
        },
      }),
      operation({
        id: 'cloudflare.d1_read',
        title: 'Read from a D1 database',
        description: `Run ONE read query (SELECT, WITH or EXPLAIN, or a reporting PRAGMA such as table_info) against a D1 database and get rows back. Writes are refused before anything is sent. At most ${MAX_ROWS} rows; prefer COUNT/SUM/GROUP BY over reading raw rows. \`limit\` defaults to 100.`,
        input: z.object({ database: name, sql: z.string().min(1).max(10_000), limit: z.number().int().min(1).max(MAX_ROWS).default(100) }),
        level: 2,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => ({ ...LIVE, effects: [...LIVE.effects, 'database' as const] }),
        async run(input, ctx) {
          const checked = strictReadSql(input.sql);
          if (!checked.ok) return failure('INVALID_INPUT', checked.reason);
          const a = account(ctx);
          if (!isAccount(a)) return a;
          const db = await database(ctx, a, input.database);
          if (isResult(db)) return db;
          const r = await d1Query(ctx, a, db.uuid, limitReadSql(checked.sql, input.limit));
          if (!r.ok) return r.result;
          const truncated = r.rows.length > input.limit;
          const rows = r.rows.slice(0, input.limit);
          const rowsRead = typeof r.meta.rows_read === 'number' ? r.meta.rows_read : null;
          return {
            ok: true,
            summary: `D1 ${db.name}: ${rows.length}${truncated ? '+' : ''} row(s)${rowsRead !== null ? ` (${rowsRead} read)` : ''}`,
            output: { database: db.name, rows, truncated, rowsRead, durationMs: r.meta.duration ?? null },
            ...net,
          };
        },
      }),
      operation({
        id: 'cloudflare.kv_keys',
        title: 'List keys in a KV namespace',
        description: 'Key names (and expirations) in a KV namespace, by namespace title or id, optionally under a prefix. At most 1000.',
        input: z.object({ namespace: name, prefix: z.string().max(512).optional(), limit: z.number().int().min(10).max(1000).default(100) }),
        level: 2,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => LIVE,
        async run(input, ctx) {
          const a = account(ctx);
          if (!isAccount(a)) return a;
          const ns = await resolve(ctx, a, (c) => c.kv, (n) => n.title === input.namespace || n.id === input.namespace, 'KV namespace', (c) => c.kv.map((n) => n.title));
          if (isResult(ns)) return ns;
          const q = new URLSearchParams({ limit: String(input.limit), ...(input.prefix ? { prefix: input.prefix } : {}) });
          const r = await cf(ctx, a, `/storage/kv/namespaces/${pathSegment(ns.id)}/keys?${q}`);
          if (!r.ok) return cfFailure(r, 'the KV key list');
          const keys = ((r.json?.result ?? []) as any[]).map((k) => ({ name: String(k.name), expiration: k.expiration ?? null }));
          const more = Boolean(r.json?.result_info?.cursor);
          return { ok: true, summary: `KV ${ns.title}: ${keys.length}${more ? '+' : ''} key(s)`, output: { namespace: ns.title, keys, more }, ...net };
        },
      }),
      operation({
        id: 'cloudflare.kv_get',
        title: 'Read a KV value',
        description: `The value stored under one key in a KV namespace, as text (up to ${MAX_KV_BYTES / 1024} KB; binary values report their size only).`,
        input: z.object({ namespace: name, key: objectKey }),
        level: 2,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => LIVE,
        async run(input, ctx) {
          const a = account(ctx);
          if (!isAccount(a)) return a;
          const ns = await resolve(ctx, a, (c) => c.kv, (n) => n.title === input.namespace || n.id === input.namespace, 'KV namespace', (c) => c.kv.map((n) => n.title));
          if (isResult(ns)) return ns;
          const r = await cf(ctx, a, `/storage/kv/namespaces/${pathSegment(ns.id)}/values/${pathSegment(input.key)}`, undefined, MAX_KV_BYTES);
          if (!r.ok) return cfFailure(r, `KV key "${input.key}"`);
          return textBody(r, `KV ${ns.title} › ${input.key}`, { namespace: ns.title, key: input.key });
        },
      }),
      operation({
        id: 'cloudflare.r2_list',
        title: 'List objects in an R2 bucket',
        description: 'Object keys, sizes and dates in an R2 bucket, optionally under a prefix (a folder). At most 1000.',
        input: z.object({ bucket: name, prefix: z.string().max(1024).optional(), limit: z.number().int().min(1).max(1000).default(100) }),
        level: 2,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => LIVE,
        async run(input, ctx) {
          const a = account(ctx);
          if (!isAccount(a)) return a;
          const bucket = await resolve(ctx, a, (c) => c.r2, (b) => b.name === input.bucket, 'R2 bucket', (c) => c.r2.map((b) => b.name));
          if (isResult(bucket)) return bucket;
          const q = new URLSearchParams({ per_page: String(input.limit), ...(input.prefix ? { prefix: input.prefix } : {}) });
          const r = await cf(ctx, a, `/r2/buckets/${pathSegment(bucket.name)}/objects?${q}`);
          if (!r.ok) return cfFailure(r, 'the R2 object list');
          const list = (Array.isArray(r.json?.result) ? r.json.result : (r.json?.result?.objects ?? [])) as any[];
          const objects = list.slice(0, input.limit).map((o) => ({ key: String(o.key), size: typeof o.size === 'number' ? o.size : Number(o.size ?? 0), lastModified: o.last_modified ?? o.uploaded ?? null, contentType: o.http_metadata?.contentType ?? null }));
          const more = Boolean(r.json?.result_info?.cursor) || Boolean(r.json?.result_info?.is_truncated) || list.length > input.limit;
          return { ok: true, summary: `R2 ${bucket.name}: ${objects.length}${more ? '+' : ''} object(s)`, output: { bucket: bucket.name, objects, more }, ...net };
        },
      }),
      operation({
        id: 'cloudflare.r2_get',
        title: 'Read an R2 object',
        description: `The content of one R2 object as text (up to ${MAX_OBJECT_BYTES / 1024} KB; binary objects report their size and type only).`,
        input: z.object({ bucket: name, key: objectKey }),
        level: 2,
        readOnly: true,
        credentials: CREDENTIALS,
        classify: () => LIVE,
        async run(input, ctx) {
          const a = account(ctx);
          if (!isAccount(a)) return a;
          const bucket = await resolve(ctx, a, (c) => c.r2, (b) => b.name === input.bucket, 'R2 bucket', (c) => c.r2.map((b) => b.name));
          if (isResult(bucket)) return bucket;
          const key = input.key.split('/').map(pathSegment).join('/');
          const r = await cf(ctx, a, `/r2/buckets/${pathSegment(bucket.name)}/objects/${key}`, undefined, MAX_OBJECT_BYTES);
          if (!r.ok) return cfFailure(r, `R2 object "${input.key}"`);
          return textBody(r, `R2 ${bucket.name} › ${input.key}`, { bucket: bucket.name, key: input.key });
        },
      }),
    ],
  };
}

/** A stored value as text, or its size and type when it is binary. */
function textBody(r: RestResponse, label: string, where: Record<string, string>): OperationResult {
  const type = r.headers.get('content-type') ?? '';
  const binary = /image|audio|video|octet-stream|zip|pdf|font/i.test(type) || r.text.includes('\u0000');
  const size = Number(r.headers.get('content-length')) || Buffer.byteLength(r.text);
  if (binary) return { ok: true, summary: `${label}: ${size} bytes of ${type || 'binary data'} (not shown)`, output: { ...where, contentType: type || null, size, text: null }, ...net };
  return { ok: true, summary: `${label}: ${size} bytes${r.truncated ? ' (shortened)' : ''}`, output: { ...where, contentType: type || null, size, truncated: r.truncated, text: r.text }, ...net };
}

/** For tests: forget cached catalogs. */
export function resetCloudflareCatalog(): void {
  catalogCache.clear();
}
