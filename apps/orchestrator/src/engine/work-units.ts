import { createHash } from 'node:crypto';
import { COMMAND_KINDS, MANIFEST_FENCE, MAX_MANIFEST_CHARS, workUnitManifestSchema, type WorkUnitManifest } from '@acc/shared';

/**
 * The execution manifest a plan (or a decomposition run) carries for a
 * Stage Team (docs/plans/STAGE_TEAMS_PLAN.md §3.3). Only the designated
 * fenced block is read; anything that is not exactly a valid manifest for
 * this stage is a reason to run the stage as one agent, never an error.
 */

export type ManifestRead = { ok: true; manifest: WorkUnitManifest; hash: string } | { ok: false; reason: string };

const FENCE = new RegExp('```' + MANIFEST_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```', 'g');

/** The last manifest block in `text` meant for stage `stageKey`. */
export function readManifest(text: string, stageKey: string): ManifestRead {
  const blocks = [...text.matchAll(FENCE)].map((m) => m[1]!);
  if (!blocks.length) return { ok: false, reason: 'the plan has no work-unit manifest' };
  let lastReason = 'the plan has no work-unit manifest';
  for (const block of blocks.reverse()) {
    if (block.length > MAX_MANIFEST_CHARS) {
      lastReason = `the work-unit manifest is larger than ${MAX_MANIFEST_CHARS} characters`;
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(block);
    } catch {
      lastReason = 'the work-unit manifest is not valid JSON';
      continue;
    }
    const parsed = workUnitManifestSchema.safeParse(normalize(raw));
    if (!parsed.success) {
      lastReason = `the work-unit manifest is not valid: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
      continue;
    }
    if (parsed.data.stage !== stageKey) {
      lastReason = `the work-unit manifest is for stage "${parsed.data.stage}", not "${stageKey}"`;
      continue;
    }
    return { ok: true, manifest: parsed.data, hash: manifestHash(parsed.data) };
  }
  return { ok: false, reason: lastReason };
}

/**
 * Forgive what real planners write without changing what a manifest means
 * (seen in a live run: `api_discount` keys, `node --test …` as checks): a key
 * is folded to a slug, and a check that is not a known check kind is dropped —
 * checks are a hint to the worker and are never run. Everything else is
 * validated as written.
 */
function normalize(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { units?: unknown }).units)) return raw;
  const slug = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : v);
  const kinds = new Set<string>(COMMAND_KINDS);
  return {
    ...(raw as object),
    units: ((raw as { units: unknown[] }).units).map((u) => {
      if (!u || typeof u !== 'object') return u;
      const unit = u as Record<string, unknown>;
      return {
        ...unit,
        key: slug(unit.key),
        ...(Array.isArray(unit.dependsOn) ? { dependsOn: unit.dependsOn.map(slug) } : {}),
        ...(Array.isArray(unit.checks) ? { checks: unit.checks.filter((c) => typeof c === 'string' && kinds.has(c)) } : {}),
      };
    }),
  };
}

/** A stable fingerprint of anything JSON: object keys sorted, so equal content hashes equal. */
export function stableHash(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

export function manifestHash(manifest: WorkUnitManifest): string {
  return stableHash(manifest);
}
