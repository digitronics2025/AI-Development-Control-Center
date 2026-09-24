import { z } from 'zod';

/**
 * Skills an agent CLI can run (docs/systems/agents.md#skills). Names are what the
 * CLI invokes: `fix-bug` for a repository or user skill, `plugin:skill` for a
 * plugin's. Picked skills live in the task description as `/name` text.
 */
export const SKILL_SOURCES = ['project', 'user', 'plugin', 'builtin'] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export interface SkillInfo {
  name: string;
  /** One line from the skill's frontmatter; null when it has none. */
  description: string | null;
  source: SkillSource;
  /** Plugin name for `plugin` skills. */
  plugin: string | null;
}

export interface SkillCatalogView {
  /** Agents whose skills are listed (only agents that can report them). */
  agents: string[];
  skills: SkillInfo[];
}

export const skillQuerySchema = z.object({ repositoryId: z.string().min(1).max(200) });

/** Characters a skill name may contain; a name starts with a letter or digit. */
const NAME = '[A-Za-z0-9][A-Za-z0-9._:-]*';
/** `/name` at the start of the text or after whitespace or an opening bracket. */
const TOKEN = new RegExp(`(?:^|(?<=[\\s(\\[]))\\/(${NAME})`, 'g');

/** Sentence punctuation that may follow a name without being part of it. */
function trimName(raw: string): string {
  return raw.replace(/[.:]+$/, '');
}

/**
 * Skills a text asks for: every `/name` token whose name is a known skill, in
 * order of first appearance. Only known names count, so paths and URLs
 * (`/api/tasks`, `https://x/y`) are never mistaken for skills.
 */
export function requestedSkills(text: string, known: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const end = (match.index ?? 0) + match[0].length;
    if (text[end] === '/') continue; // a path segment: /api/tasks
    const name = trimName(match[1]!);
    if (known.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * The `/query` being typed at the caret, for the slash picker: `start` is the
 * index of the `/`. Null when the caret is not inside such a token.
 */
export function slashQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s([])\/([A-Za-z0-9._:-]*)$/.exec(before);
  if (!match) return null;
  const start = caret - match[1]!.length - 1;
  return { start, query: match[1]! };
}

/** Order for the picker: names starting with the query, then names or descriptions containing it. */
export function filterSkills(skills: readonly SkillInfo[], query: string, limit = 50): SkillInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills.slice(0, limit);
  const starts: SkillInfo[] = [];
  const contains: SkillInfo[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    if (name.startsWith(q) || bare.startsWith(q)) starts.push(skill);
    else if (name.includes(q) || (skill.description ?? '').toLowerCase().includes(q)) contains.push(skill);
  }
  return [...starts, ...contains].slice(0, limit);
}
