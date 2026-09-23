import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Filesystem confinement (V2 plan §13): every path a tool touches must stay
 * inside the roots the call was given. Symlinks and junctions are resolved
 * for the part of the path that exists, so a link inside the repository that
 * points elsewhere is refused.
 */

export class OutsideRootError extends Error {
  constructor(readonly requested: string) {
    super(`"${requested}" is outside the folders this task may touch`);
  }
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function norm(p: string): string {
  const resolved = path.resolve(p);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/** Resolve the deepest existing ancestor through symlinks, then re-append the rest. */
function realish(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(root: string, candidate: string): boolean {
  const r = norm(root);
  const c = norm(candidate);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Resolve `requested` (absolute, or relative to `cwd`) and prove it lies in
 * one of `roots`, both lexically and after following links.
 */
export function resolveInside(roots: readonly string[], cwd: string, requested: string): string {
  if (!requested || requested.includes('\0')) throw new OutsideRootError(requested);
  const absolute = path.resolve(cwd, requested);
  const real = realish(absolute);
  const ok = roots.some((root) => isInside(root, absolute) && isInside(realish(root), real));
  if (!ok) throw new OutsideRootError(requested);
  return absolute;
}

/** Repository-relative form with forward slashes, for display and Git pathspecs. */
export function relativeTo(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}
