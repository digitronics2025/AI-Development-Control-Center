import { createHash } from 'node:crypto';
import { manifestBlockPattern, MAX_MANIFEST_CHARS, normalizeManifest, workUnitManifestSchema, type WorkUnitManifest } from '@acc/shared';

/**
 * The execution manifest a plan (or a decomposition run) carries for a
 * Stage Team (docs/plans/STAGE_TEAMS_PLAN.md §3.3). Only the designated
 * fenced block is read; anything that is not exactly a valid manifest for
 * this stage is a reason to run the stage as one agent, never an error.
 */

export type ManifestRead = { ok: true; manifest: WorkUnitManifest; hash: string } | { ok: false; reason: string };

/** The last manifest block in `text` meant for stage `stageKey`. */
export function readManifest(text: string, stageKey: string): ManifestRead {
  const blocks = [...text.matchAll(manifestBlockPattern())].map((m) => m[1]!);
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
    const parsed = workUnitManifestSchema.safeParse(normalizeManifest(raw));
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
