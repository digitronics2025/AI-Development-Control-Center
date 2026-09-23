import type { CommandKind, DirectiveRule } from '@acc/shared';

/**
 * Machine-checkable forms of directives written in plain language. Only
 * derived from the user's own words — never from agent output — and only for
 * patterns recognised with certainty; everything else stays prose for the
 * agents and reviewers to follow.
 */

const NOUN_PATTERNS: Array<{ words: RegExp; patterns: string[] }> = [
  { words: /\b(database )?migrations?\b/, patterns: ['**/migrations/**', '**/*migration*'] },
  { words: /\b(database|db) schema\b|\bschema\b(?!\.)/, patterns: ['**/schema.*', '**/*.sql', '**/migrations/**', '**/*migration*'] },
  { words: /\block ?files?\b|\bpackage-lock\b|\bpnpm-lock\b/, patterns: ['**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock'] },
  { words: /\b(the )?tests?\b|\btest files?\b|\bspecs?\b/, patterns: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**', '**/e2e/**'] },
  { words: /\bci\b|\bworkflows? files?\b|\bgithub actions?\b/, patterns: ['.github/**'] },
];

const PATH_TOKEN = /(?:^|[\s"'`(])((?:[\w.*-]+\/)+[\w.*-]*|[\w*-]+\.(?:[a-z0-9]{1,8}))(?=$|[\s"'`),.;:])/gi;

/** Path-like tokens in a sentence: `src/db/`, `schema.prisma`, `apps/**`. */
export function pathTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[1]!.replace(/\.$/, '');
    if (/^(e\.g|i\.e|etc)$/i.test(token)) continue;
    found.add(token.endsWith('/') ? `${token}**` : token.includes('/') || token.includes('*') ? token : `**/${token}`);
  }
  return [...found];
}

const NEGATIVE = /^(?:please\s+)?(?:do not|don't|dont|never|avoid|stop)\s+(?:modify|modifying|change|changing|touch|touching|edit|editing|alter|altering|delete|deleting|remove|removing|rewrite|rewriting|weaken|weakening|update|updating)\b/i;

export function deriveRule(text: string): DirectiveRule | null {
  const lower = text.toLowerCase();
  if (NEGATIVE.test(text)) {
    const patterns = new Set(pathTokens(text));
    for (const noun of NOUN_PATTERNS) if (noun.words.test(lower)) for (const p of noun.patterns) patterns.add(p);
    return patterns.size ? { type: 'protect_paths', patterns: [...patterns].slice(0, 20) } : null;
  }
  const kinds = requiredCheckKinds(lower);
  if (kinds.length && /\b(before|prior to)\b.*\b(finish|finishing|complete|completing|completion|done|merging|ending)\b|\bmust (pass|run)\b|\balways run\b/.test(lower)) {
    return { type: 'require_check', kinds };
  }
  return null;
}

/** Command kinds a sentence asks to run: e2e, the full suite, builds. */
export function requiredCheckKinds(lower: string): CommandKind[] {
  const kinds = new Set<CommandKind>();
  if (/\b(e2e|end[- ]to[- ]end|playwright)\b/.test(lower)) kinds.add('e2e');
  if (/\bfull (test|tests|test suite|suite|check|checks)\b|\ball (the )?tests\b/.test(lower)) {
    for (const k of ['lint', 'typecheck', 'test', 'build'] as const) kinds.add(k);
  }
  if (/\bsmoke\b/.test(lower)) kinds.add('smoke');
  return [...kinds];
}

/** Minimal glob: `**` spans directories, `*` and `?` stay within one segment. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function matchesAny(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((p) => globToRegExp(p).test(normalized));
}
