import { z } from 'zod';
import { COMMAND_KINDS, type Role } from './constants.js';
import { slugSchema, type StageDefinition, type StageSpecialist } from './schemas.js';

/**
 * Stage Teams (docs/plans/STAGE_TEAMS_PLAN.md): the execution manifest a
 * planner may add to its plan, the work units the orchestrator persists, and
 * the path-ownership rules both sides share. Everything here is pure, so the
 * dashboard can use it too.
 */

/** Units one manifest may describe; more is never a real plan for one stage. */
export const MAX_MANIFEST_UNITS = 6;
/** A manifest block is small; anything larger is refused before it is parsed. */
export const MAX_MANIFEST_CHARS = 20_000;
/** The fenced block a plan carries its manifest in: ```acc-work-units … ``` */
export const MANIFEST_FENCE = 'acc-work-units';
/** Every manifest block in a text, its JSON in group 1 (a new RegExp per use: it is global). */
export const manifestBlockPattern = (): RegExp => new RegExp('```' + MANIFEST_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```', 'g');

/**
 * Forgive what real planners write without changing what a manifest means
 * (seen in a live run: `api_discount` keys, `node --test …` as checks): a key,
 * its dependencies and a specialty label are folded to slugs, and a check that
 * is not a known check kind is dropped — checks are a hint to the worker and
 * are never run. Everything else is validated as written. The orchestrator and
 * plan review read a block the same way.
 */
export function normalizeManifest(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { units?: unknown }).units)) return raw;
  const slug = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : v);
  const kinds = new Set<string>(COMMAND_KINDS);
  return {
    ...(raw as object),
    units: (raw as { units: unknown[] }).units.map((u) => {
      if (!u || typeof u !== 'object') return u;
      const unit = u as Record<string, unknown>;
      return {
        ...unit,
        key: slug(unit.key),
        // A specialty is matched as a slug (`Frontend` is `frontend`): DESIGNER_ROUTING_PLAN §6.
        ...(typeof unit.specialty === 'string' ? { specialty: slug(unit.specialty) } : {}),
        ...(Array.isArray(unit.dependsOn) ? { dependsOn: unit.dependsOn.map(slug) } : {}),
        ...(Array.isArray(unit.checks) ? { checks: unit.checks.filter((c) => typeof c === 'string' && kinds.has(c)) } : {}),
      };
    }),
  };
}

/**
 * A repository-relative path or folder a unit owns: forward slashes, no
 * leading slash, no drive, no `..`, no `.git`, no shell text. A trailing `/`
 * marks a folder; without one the prefix is a file or a folder name.
 */
export const pathPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._@+\-/]+$/, 'Use repository-relative paths with letters, digits, . _ @ + - and /')
  .refine((p) => !p.startsWith('/') && !p.startsWith('./'), 'Paths are relative to the repository root')
  .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.'), 'Paths may not contain . or .. segments')
  .refine((p) => !/(^|\/)\.git(\/|$)/.test(p), 'Paths inside .git are never owned')
  .refine((p) => !p.includes('//'), 'Paths may not contain empty segments');

export const workUnitManifestUnitSchema = z.object({
  key: slugSchema.max(40),
  title: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(2000),
  /**
   * The specialist that does this unit, when the stage lists specialists (`team.specialists`, DESIGNER_ROUTING_PLAN §6):
   * it chooses the worker's role, instructions and tools, never its agent. Matched as a slug (`normalizeSpecialty`).
   */
  specialty: z.string().trim().max(40).optional(),
  dependsOn: z.array(slugSchema).max(MAX_MANIFEST_UNITS).default([]),
  pathPrefixes: z.array(pathPrefixSchema).min(1).max(20),
  /** Check kinds the unit's own targeted verification should cover; the Test stage still decides. */
  checks: z.array(z.enum(COMMAND_KINDS)).max(8).default([]),
});
export type WorkUnitManifestUnit = z.infer<typeof workUnitManifestUnitSchema>;

export const workUnitManifestSchema = z
  .object({
    version: z.literal(1),
    stage: slugSchema,
    units: z.array(workUnitManifestUnitSchema).min(1).max(MAX_MANIFEST_UNITS),
  })
  .superRefine((m, ctx) => {
    const keys = new Set<string>();
    m.units.forEach((u, i) => {
      if (keys.has(u.key)) ctx.addIssue({ code: 'custom', path: ['units', i, 'key'], message: `Unit key "${u.key}" is used twice` });
      keys.add(u.key);
    });
    m.units.forEach((u, i) => {
      for (const dep of u.dependsOn) {
        if (dep === u.key) ctx.addIssue({ code: 'custom', path: ['units', i, 'dependsOn'], message: `Unit "${u.key}" depends on itself` });
        else if (!keys.has(dep)) ctx.addIssue({ code: 'custom', path: ['units', i, 'dependsOn'], message: `Unit "${u.key}" depends on unknown unit "${dep}"` });
      }
    });
    if (hasDependencyCycle(m.units)) ctx.addIssue({ code: 'custom', path: ['units'], message: 'The units depend on each other in a cycle' });
  });
export type WorkUnitManifest = z.infer<typeof workUnitManifestSchema>;

function hasDependencyCycle(units: ReadonlyArray<{ key: string; dependsOn: readonly string[] }>): boolean {
  const byKey = new Map(units.map((u) => [u.key, u]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string): boolean => {
    const mark = state.get(key);
    if (mark === 'done') return false;
    if (mark === 'visiting') return true;
    state.set(key, 'visiting');
    for (const dep of byKey.get(key)?.dependsOn ?? []) if (byKey.has(dep) && visit(dep)) return true;
    state.set(key, 'done');
    return false;
  };
  return units.some((u) => visit(u.key));
}

/** A planner's label as a specialty key: `Frontend`, ` front end ` → `frontend`, `front-end`; empty → null. */
export function normalizeSpecialty(label: string | null | undefined): string | null {
  const slug = (label ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

/**
 * The stage as a specialist runs it: the specialist's role, instructions and tool profile; the stage's key, level,
 * timeout, retries, transitions and agent pin. Built field by field, never by spreading the stage, so a team, a
 * verdict or the stage's own instructions never leak into it.
 */
export function routedStage(stage: StageDefinition, specialist: StageSpecialist): StageDefinition {
  return {
    key: stage.key,
    name: stage.name,
    role: specialist.role,
    kind: stage.kind,
    agentId: stage.agentId,
    model: stage.model,
    effort: stage.effort,
    permissionLevel: stage.permissionLevel,
    timeoutSec: stage.timeoutSec,
    retry: stage.retry,
    requiresApproval: stage.requiresApproval,
    next: stage.next,
    onFail: stage.onFail,
    verdict: false,
    optional: false,
    description: stage.description,
    instructions: specialist.instructions,
    toolProfile: specialist.toolProfile ?? stage.toolProfile,
  };
}

/** Text safe to place in Markdown as it is: `**`, `_`, backticks, brackets and the rest shown, not read. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);
}

/**
 * A plan shown to a person (plan review): each `acc-work-units` block becomes a short list — each unit's title,
 * goal, who does it and the paths it owns — instead of raw JSON, read exactly as the orchestrator reads it
 * (`normalizeManifest`). A block it cannot read is left as written. `roleOf` names the specialist for a label
 * (`frontend` → "designer"), or null for the stage's own role. A specialist is promised only when every unit has
 * it (the whole stage runs as that specialist); a mixed plan names the specialist conditionally, since such units
 * reach it only when they run as their own unit (DESIGNER_ROUTING_PLAN §6).
 */
export function readableWorkUnits(plan: string, roleOf: (stage: string, specialty: string | null) => string | null): string {
  return plan.replace(manifestBlockPattern(), (block, body: string) => {
    if (body.length > MAX_MANIFEST_CHARS) return block;
    let parsed: ReturnType<typeof workUnitManifestSchema.safeParse>;
    try {
      parsed = workUnitManifestSchema.safeParse(normalizeManifest(JSON.parse(body)));
    } catch {
      return block;
    }
    if (!parsed.success) return block;
    const m = parsed.data;
    const who = m.units.map((u) => ({ specialty: normalizeSpecialty(u.specialty), role: roleOf(m.stage, normalizeSpecialty(u.specialty)) }));
    const whole = who[0]?.role && who.every((w) => w.specialty === who[0]!.specialty) ? who[0].role : null;
    const lines = m.units.flatMap((u, i) => {
      const w = who[i]!;
      const by = whole ? ` — by the ${whole}` : w.role ? ` — ${w.specialty} work: the ${w.role} when it runs as its own unit` : '';
      const after = u.dependsOn.length ? `, after ${u.dependsOn.map((d) => `\`${d}\``).join(', ')}` : '';
      const goal = u.goal.length > 240 ? `${u.goal.slice(0, 239)}…` : u.goal;
      return [`- **${escapeMarkdown(u.title)}**${by}${after} (${u.pathPrefixes.map((p) => `\`${p}\``).join(', ')})`, `  ${escapeMarkdown(goal)}`];
    });
    return [`**Work units for ${m.stage}:**`, '', ...lines].join('\n');
  });
}

const trimSlash = (p: string) => p.replace(/\/+$/, '');

/** Whether `path` (repository-relative, `/`-separated) lies under one of `prefixes`. */
export function pathInScope(path: string, prefixes: readonly string[]): boolean {
  const file = path.replace(/\\/g, '/');
  return prefixes.some((raw) => {
    const prefix = trimSlash(raw);
    return file === prefix || file.startsWith(`${prefix}/`);
  });
}

/** Whether two prefix lists could claim the same file. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => pathInScope(trimSlash(x), [y]) || pathInScope(trimSlash(y), [x])));
}

/** Every unit `key` depends on, directly or through others. */
export function transitiveDependencies(units: ReadonlyArray<{ key: string; dependsOn: readonly string[] }>, key: string): Set<string> {
  const byKey = new Map(units.map((u) => [u.key, u]));
  const out = new Set<string>();
  const walk = (k: string) => {
    for (const dep of byKey.get(k)?.dependsOn ?? []) {
      if (out.has(dep)) continue;
      out.add(dep);
      walk(dep);
    }
  };
  walk(key);
  return out;
}

/**
 * Pairs of units that could run at the same time (neither depends on the
 * other) and claim overlapping paths: such a manifest cannot be written in
 * parallel safely.
 */
export function independentOverlaps(units: ReadonlyArray<{ key: string; dependsOn: readonly string[]; pathPrefixes: readonly string[] }>): Array<[string, string]> {
  const deps = new Map(units.map((u) => [u.key, transitiveDependencies(units, u.key)]));
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i]!;
      const b = units[j]!;
      if (deps.get(a.key)!.has(b.key) || deps.get(b.key)!.has(a.key)) continue;
      if (scopesOverlap(a.pathPrefixes, b.pathPrefixes)) pairs.push([a.key, b.key]);
    }
  }
  return pairs;
}

export const WORK_UNIT_STATUSES = ['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED', 'REUSED'] as const;
export type WorkUnitStatus = (typeof WORK_UNIT_STATUSES)[number];

/** worker: one unit of the team; decomposer: the read-only run that splits a Fix; integration: the lead's consistency pass. */
export const WORK_UNIT_KINDS = ['worker', 'decomposer', 'integration', 'judge'] as const;
export type WorkUnitKind = (typeof WORK_UNIT_KINDS)[number];

/** One persisted unit of a Stage Team run (table `stage_work_units`). */
export interface StageWorkUnit {
  id: string;
  taskId: string;
  /** The parent stage instance. */
  stageId: string;
  stageKey: string;
  unitKey: string;
  kind: WorkUnitKind;
  title: string;
  focus: string;
  status: WorkUnitStatus;
  ordinal: number;
  dependencies: string[];
  /** Paths the unit owns (write units); empty for read-only units. */
  pathScope: string[];
  primary: boolean;
  manifestHash: string | null;
  /** Write units: the hidden checkpoint commit they started from. Read-only units: the tree of the files they read. */
  baseCommit: string | null;
  /** Hidden commit capturing the unit's result (write units). */
  resultCommit: string | null;
  agentId: string | null;
  model: string | null;
  effort: string | null;
  /** The specialist role the unit ran as (DESIGNER_ROUTING_PLAN §6); null = the stage's own role. */
  role?: Role | null;
  /** The plan's label for the unit, normalised; kept whether or not a specialist matched it. */
  specialty?: string | null;
  attempt: number;
  /** The earlier unit whose proven result this one reused. */
  reusedFrom: string | null;
  summary: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}
