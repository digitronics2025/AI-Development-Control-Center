import { classifyCommand } from '@acc/security';

/**
 * SQL classification shared by the SQLite, D1 and Postgres/MySQL packs:
 * read-only statements, ordinary writes, and destructive ones (drop,
 * truncate, delete/update without WHERE).
 */
export interface SqlClass {
  readOnly: boolean;
  destructive: boolean;
  reasons: string[];
}

/**
 * PRAGMAs that only report. Every other PRAGMA — including the function form
 * `PRAGMA writable_schema(1)` — can change the connection or the file and
 * counts as a write.
 */
export const READ_PRAGMAS: ReadonlySet<string> = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'integrity_check',
  'quick_check',
  'database_list',
  'collation_list',
  'function_list',
  'module_list',
  'pragma_list',
  'compile_options',
  'page_count',
  'freelist_count',
]);

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** `PRAGMA name`, `PRAGMA schema.name(arg)`: a read only when the name reports and nothing is assigned. */
function isReadPragma(statement: string): boolean {
  const m = /^PRAGMA\s+(?:\w+\.)?(\w+)\s*(\(\s*[^)]*\))?\s*$/i.exec(statement);
  return Boolean(m && READ_PRAGMAS.has(m[1]!.toLowerCase()));
}

// `replace(x, y, z)` is a read-only string function; `REPLACE INTO` is a write.
const WRITE_WORDS = /\b(?:INSERT|UPDATE|DELETE|REPLACE(?!\s*\()|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|TRUNCATE|GRANT|REVOKE|COPY|MERGE|CALL|LOCK|SET)\b/i;

export function classifySql(sql: string): SqlClass {
  const statements = stripComments(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const reasons: string[] = [];
  let readOnly = statements.length > 0;
  let destructive = false;
  for (const s of statements) {
    const head = s.split(/\s+/)[0]!.toUpperCase();
    const read =
      ['SELECT', 'EXPLAIN', 'VALUES'].includes(head) ||
      (head === 'PRAGMA' && isReadPragma(s)) ||
      (head === 'WITH' && !/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s));
    if (!read) readOnly = false;
    const c = classifyCommand(s);
    if (c.risk === 'dangerous') {
      destructive = true;
      reasons.push(...c.reasons);
    }
    if (/^UPDATE\b/i.test(s) && !/\bWHERE\b/i.test(s)) {
      destructive = true;
      reasons.push('Updates every row of a table');
    }
    if (/^ALTER\s+TABLE\b.*\bDROP\b/i.test(s)) {
      destructive = true;
      reasons.push('Drops a column');
    }
    if (/^DROP\s+TRIGGER\b/i.test(s)) {
      destructive = true;
      reasons.push('Drops a trigger');
    }
  }
  if (readOnly) reasons.push('Read-only query');
  else if (!destructive) reasons.push('Changes data');
  return { readOnly, destructive, reasons: [...new Set(reasons)] };
}

export type StrictReadSql = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * The only SQL a read-only session may send (docs/systems/ask.md): exactly
 * one statement that starts with SELECT, WITH or EXPLAIN and contains no
 * word that writes anywhere in it (string literals included — a false refusal
 * is acceptable, a missed write is not), or one reporting PRAGMA. A trailing
 * semicolon is allowed; anything after it is not.
 */
export function strictReadSql(input: string): StrictReadSql {
  const sql = stripComments(input).trim().replace(/;\s*$/, '').trim();
  if (!sql) return { ok: false, reason: 'Write a query.' };
  if (sql.includes(';')) return { ok: false, reason: 'One statement only.' };
  const head = sql.split(/\s+/)[0]!.toUpperCase();
  if (head === 'PRAGMA') return isReadPragma(sql) ? { ok: true, sql } : { ok: false, reason: `Only these PRAGMAs are allowed: ${[...READ_PRAGMAS].join(', ')}.` };
  if (!['SELECT', 'WITH', 'EXPLAIN'].includes(head)) return { ok: false, reason: 'Only SELECT, WITH and EXPLAIN queries are allowed: this conversation is read-only.' };
  const write = WRITE_WORDS.exec(sql);
  if (write) return { ok: false, reason: `"${write[0].toUpperCase()}" is not allowed: this conversation is read-only.` };
  if (/\bRETURNING\b/i.test(sql)) return { ok: false, reason: '"RETURNING" is not allowed: this conversation is read-only.' };
  return { ok: true, sql };
}

/**
 * Bound a read to `limit` rows (one more is fetched so truncation can be
 * reported). EXPLAIN and PRAGMA are returned unchanged: they cannot be wrapped.
 */
export function limitReadSql(sql: string, limit: number): string {
  const head = sql.split(/\s+/)[0]!.toUpperCase();
  if (head === 'EXPLAIN' || head === 'PRAGMA') return sql;
  return `SELECT * FROM (${sql}) LIMIT ${Math.max(1, Math.floor(limit)) + 1}`;
}
