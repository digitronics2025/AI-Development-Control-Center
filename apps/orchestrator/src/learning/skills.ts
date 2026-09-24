import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSkillFrontmatter } from '@acc/agent-sdk';
import type { LearningScope } from '@acc/shared';

/**
 * Skills the learning loop manages (docs/systems/learning.md#skills). They
 * live in the Control Center's own data folder as two Claude Code plugins —
 * `acc-learned` (every repository) and `acc-repo` (one per repository) —
 * handed to runs with `--plugin-dir`. The operator's own Claude configuration
 * is never written. Adopted skills come only from marketplaces the operator
 * already added to Claude Code and whose files are already on this disk.
 */

export const GLOBAL_PLUGIN = 'acc-learned';
export const REPO_PLUGIN = 'acc-repo';
const MAX_FILES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /[^A-Za-z0-9_-]+/g;

export interface MarketplaceSkill {
  /** As the CLI would name it with the plugin installed: `plugin:skill`. */
  name: string;
  /** The skill's own name (frontmatter or folder). */
  skill: string;
  description: string | null;
  plugin: string;
  marketplace: string;
  dir: string;
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function yamlLine(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, ' ').trim());
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** A skill folder's files, refusing links and anything over the caps. */
async function listFiles(dir: string): Promise<{ files: string[]; bytes: number } | { error: string }> {
  const files: string[] = [];
  let bytes = 0;
  const walk = async (current: string): Promise<string | null> => {
    for (const entry of await readdir(current)) {
      const full = path.join(current, entry);
      const info = await lstat(full);
      if (info.isSymbolicLink()) return `${path.relative(dir, full)} is a link`;
      if (info.isDirectory()) {
        const err = await walk(full);
        if (err) return err;
      } else if (info.isFile()) {
        files.push(full);
        bytes += info.size;
        if (files.length > MAX_FILES) return `more than ${MAX_FILES} files`;
        if (bytes > MAX_BYTES) return `larger than ${MAX_BYTES / 1024 / 1024} MB`;
      }
    }
    return null;
  };
  const error = await walk(dir).catch((e: Error) => e.message);
  return error ? { error } : { files, bytes };
}

async function contentHash(dir: string, files: string[]): Promise<string> {
  const h = createHash('sha256');
  for (const f of [...files].sort()) {
    h.update(path.relative(dir, f).replace(/\\/g, '/'));
    h.update('\0');
    h.update(await readFile(f));
  }
  return h.digest('hex').slice(0, 32);
}

export class ManagedSkills {
  readonly root: string;
  private marketplaceCache: { at: number; skills: MarketplaceSkill[] } | null = null;

  constructor(
    dataDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.root = path.join(dataDir, 'learning', 'plugins');
  }

  pluginName(scope: LearningScope): string {
    return scope === 'global' ? GLOBAL_PLUGIN : REPO_PLUGIN;
  }

  dirFor(scope: LearningScope, repositoryId: string | null): string {
    return path.join(this.root, scope === 'global' ? 'global' : `repo-${(repositoryId ?? 'none').replace(SAFE_ID, '_')}`);
  }

  /** The name agents invoke: `acc-learned:<skill>` or `acc-repo:<skill>`. */
  invokedName(scope: LearningScope, skill: string): string {
    return `${this.pluginName(scope)}:${skill}`;
  }

  skillFile(scope: LearningScope, repositoryId: string | null, skill: string): string {
    return path.join(this.dirFor(scope, repositoryId), 'skills', skill, 'SKILL.md');
  }

  private async ensurePlugin(scope: LearningScope, repositoryId: string | null): Promise<string> {
    const dir = this.dirFor(scope, repositoryId);
    await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await mkdir(path.join(dir, 'skills'), { recursive: true });
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    if (!existsSync(manifest)) {
      const description = scope === 'global' ? 'Skills the Control Center learned from earlier tasks' : 'Skills the Control Center learned for one repository';
      await writeFile(manifest, `${JSON.stringify({ name: this.pluginName(scope), version: '1.0.0', description }, null, 2)}\n`, 'utf8');
    }
    return dir;
  }

  /** A skill the Chairman wrote. The frontmatter is ours: name and description only, never tool grants. */
  async writeAuthored(scope: LearningScope, repositoryId: string | null, skill: { name: string; description: string; body: string }): Promise<{ file: string; hash: string }> {
    const dir = await this.ensurePlugin(scope, repositoryId);
    const folder = path.join(dir, 'skills', skill.name);
    if (!inside(path.join(dir, 'skills'), folder)) throw new Error('Invalid skill name');
    if (existsSync(folder)) throw new Error(`A learned skill named ${skill.name} already exists here`);
    await mkdir(folder, { recursive: true });
    const text = `---\nname: ${skill.name}\ndescription: ${yamlLine(skill.description)}\n---\n\n${skill.body.trim()}\n`;
    const file = path.join(folder, 'SKILL.md');
    await writeFile(file, text, 'utf8');
    return { file, hash: createHash('sha256').update(text).digest('hex').slice(0, 32) };
  }

  /** Copy one marketplace skill folder (files only, no links, capped) into the managed plugin. */
  async adopt(scope: LearningScope, repositoryId: string | null, source: MarketplaceSkill): Promise<{ skill: string; file: string; hash: string }> {
    const listed = await listFiles(source.dir);
    if ('error' in listed) throw new Error(`The skill folder cannot be copied: ${listed.error}`);
    const dir = await this.ensurePlugin(scope, repositoryId);
    const target = path.join(dir, 'skills', source.skill);
    if (!inside(path.join(dir, 'skills'), target)) throw new Error('Invalid skill name');
    if (existsSync(target)) throw new Error(`A learned skill named ${source.skill} already exists here`);
    await cp(source.dir, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const copied = await listFiles(target);
    if ('error' in copied) {
      await rm(target, { recursive: true, force: true });
      throw new Error(`The copied skill was rejected: ${copied.error}`);
    }
    return { skill: source.skill, file: path.join(target, 'SKILL.md'), hash: await contentHash(target, copied.files) };
  }

  /** Delete one managed skill folder; never anything outside the managed plugin. */
  async remove(scope: LearningScope, repositoryId: string | null, skill: string): Promise<void> {
    const skills = path.join(this.dirFor(scope, repositoryId), 'skills');
    const folder = path.join(skills, skill);
    if (!inside(skills, folder)) throw new Error('Invalid skill name');
    await rm(folder, { recursive: true, force: true });
  }

  exists(scope: LearningScope, repositoryId: string | null, skill: string): boolean {
    return existsSync(this.skillFile(scope, repositoryId, skill));
  }

  /** Plugin folders for a run in this repository, only those holding at least one skill. */
  async pluginDirs(repositoryId: string | null): Promise<string[]> {
    const out: string[] = [];
    for (const dir of [this.dirFor('global', null), ...(repositoryId ? [this.dirFor('repository', repositoryId)] : [])]) {
      const entries = await readdir(path.join(dir, 'skills')).catch(() => [] as string[]);
      if (entries.some((e) => existsSync(path.join(dir, 'skills', e, 'SKILL.md')))) out.push(dir);
    }
    return out;
  }

  private configDir(): string {
    return this.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  }

  /**
   * Skills in plugins of the marketplaces the operator added to Claude Code,
   * limited to plugins whose files are already in the local marketplace copy
   * (a `./path` source) and not on the CLI's blocklist. Nothing is fetched.
   */
  async marketplaceSkills(): Promise<MarketplaceSkill[]> {
    if (this.marketplaceCache && Date.now() - this.marketplaceCache.at < 10 * 60_000) return this.marketplaceCache.skills;
    const plugins = path.join(this.configDir(), 'plugins');
    const known = (await readJson<Record<string, { installLocation?: string }>>(path.join(plugins, 'known_marketplaces.json'))) ?? {};
    const blocked = new Set(((await readJson<{ plugins?: Array<{ plugin?: string }> }>(path.join(plugins, 'blocklist.json')))?.plugins ?? []).map((p) => p.plugin ?? ''));
    const skills: MarketplaceSkill[] = [];
    for (const [marketplace, entry] of Object.entries(known)) {
      const root = entry.installLocation;
      if (!root) continue;
      const manifest = await readJson<{ plugins?: Array<{ name?: string; source?: unknown }> }>(path.join(root, '.claude-plugin', 'marketplace.json'));
      for (const plugin of manifest?.plugins ?? []) {
        if (!plugin.name || typeof plugin.source !== 'string' || blocked.has(`${plugin.name}@${marketplace}`)) continue;
        const pluginRoot = path.resolve(root, plugin.source);
        if (pluginRoot !== path.resolve(root) && !inside(path.resolve(root), pluginRoot)) continue;
        const declared = (await readJson<{ skills?: string | string[] }>(path.join(pluginRoot, '.claude-plugin', 'plugin.json')))?.skills;
        const folders = [...new Set(['skills', ...(Array.isArray(declared) ? declared : declared ? [declared] : [])])].map((d) => path.resolve(pluginRoot, d)).filter((d) => d === pluginRoot || inside(pluginRoot, d));
        for (const folder of folders) {
          for (const entryName of await readdir(folder).catch(() => [] as string[])) {
            const dir = path.join(folder, entryName);
            const head = await readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => null);
            if (head === null) continue;
            const meta = readSkillFrontmatter(head.slice(0, 16 * 1024));
            const skill = meta.name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(meta.name) ? meta.name : entryName;
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill)) continue;
            skills.push({ name: `${plugin.name}:${skill}`, skill, description: meta.description?.slice(0, 240) ?? null, plugin: plugin.name, marketplace, dir });
          }
        }
      }
    }
    this.marketplaceCache = { at: Date.now(), skills };
    return skills;
  }
}
