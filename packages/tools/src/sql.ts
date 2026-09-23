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

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

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
    const read = ['SELECT', 'EXPLAIN', 'PRAGMA', 'VALUES'].includes(head) || (head === 'WITH' && !/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s));
    // PRAGMA with an assignment changes settings.
    if (!read || (head === 'PRAGMA' && /=/.test(s))) readOnly = false;
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
  }
  if (readOnly) reasons.push('Read-only query');
  else if (!destructive) reasons.push('Changes data');
  return { readOnly, destructive, reasons: [...new Set(reasons)] };
}
