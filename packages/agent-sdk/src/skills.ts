import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SkillInfo, SkillSource } from '@acc/shared';

/** Only the head of a SKILL.md is read: the frontmatter sits at the top. */
const HEAD_BYTES = 16 * 1024;
/** A directory with more entries than this is not a skills folder anyone curates by hand. */
const MAX_ENTRIES = 2000;
const MAX_DESCRIPTION = 240;
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `name` and `description` from a SKILL.md's YAML frontmatter. Handles plain,
 * quoted and block (`>` / `|`) values; anything else in the frontmatter is
 * ignored. Never throws.
 */
export function readSkillFrontmatter(text: string): { name?: string; description?: string } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a byte-order mark before the frontmatter
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const out: { name?: string; description?: string } = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    const match = /^(name|description):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as 'name' | 'description';
    let value = match[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      // Block scalar: the indented lines that follow.
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && lines[i + 1]!.trim() !== '---') parts.push(lines[++i]!.trim());
      value = parts.join(' ');
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
    }
    value = value.replace(/\s+/g, ' ').trim();
    if (value) out[key] = value;
  }
  return out;
}

async function readHead(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function oneLine(description: string | undefined): string | null {
  if (!description) return null;
  return description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description;
}

/**
 * Skills in a folder laid out as `<dir>/<skill>/SKILL.md` (Claude Code's layout
 * for repository, user and plugin skills). The invoked name is the frontmatter
 * `name` when valid, else the folder name; plugin skills get `<plugin>:` in
 * front. Linked folders (junctions, symlinks) are followed. A missing or
 * unreadable folder lists nothing.
 */
export async function scanSkillDirectory(dir: string, source: SkillSource, plugin: string | null = null): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
  const skills = await Promise.all(
    entries.map(async (entry): Promise<SkillInfo | null> => {
      const folder = path.join(dir, entry);
      try {
        if (!(await stat(folder)).isDirectory()) return null;
      } catch {
        return null;
      }
      const head = await readHead(path.join(folder, 'SKILL.md'));
      if (head === null) return null;
      const meta = readSkillFrontmatter(head);
      const base = meta.name && VALID_NAME.test(meta.name) ? meta.name : entry;
      if (!VALID_NAME.test(base)) return null;
      return { name: plugin ? `${plugin}:${base}` : base, description: oneLine(meta.description), source, plugin };
    }),
  );
  return skills.filter((s): s is SkillInfo => s !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/** First entry per name wins: callers pass sources in precedence order. */
export function mergeSkills(...lists: SkillInfo[][]): SkillInfo[] {
  const seen = new Map<string, SkillInfo>();
  for (const list of lists) for (const skill of list) if (!seen.has(skill.name)) seen.set(skill.name, skill);
  return [...seen.values()];
}
