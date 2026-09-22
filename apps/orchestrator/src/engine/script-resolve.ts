import { readFileSync } from 'node:fs';
import path from 'node:path';

const RUNNER = /^\s*(?:npm|pnpm|yarn|bun)(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:run(?:-script)?\s+)?([\w:.@/-]+)/;
const BUILTIN_SCRIPT = new Set(['test', 'start', 'stop', 'restart']);
const NOT_SCRIPTS = new Set(['install', 'i', 'ci', 'add', 'remove', 'exec', 'dlx', 'x', 'publish', 'unpublish', 'update', 'audit', 'why', 'list', 'ls']);

/**
 * `npm run build` hides what actually runs. For classification, expand a
 * package-manager script invocation into the script body (following nested
 * `npm run` calls a few levels deep) so a dangerous command inside a script
 * is judged by what it does, not by its name.
 */
export function expandPackageScripts(repoPath: string, command: string, depth = 0): string {
  if (depth > 3) return command;
  let scripts: Record<string, string>;
  try {
    scripts = JSON.parse(readFileSync(path.join(repoPath, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return command;
  }
  const parts = command.split(/&&|\|\||;/);
  const expanded = parts.map((part) => {
    const match = RUNNER.exec(part);
    const name = match?.[1];
    if (!name || NOT_SCRIPTS.has(name)) return part;
    const hasRun = /\brun(?:-script)?\s/.test(part);
    if (!hasRun && !BUILTIN_SCRIPT.has(name) && !/^\s*(?:yarn|bun)\b/.test(part)) return part;
    const body = scripts[name];
    const pre = scripts[`pre${name}`];
    const post = scripts[`post${name}`];
    const bodies = [pre, body, post].filter((b): b is string => typeof b === 'string');
    if (!bodies.length) return part;
    return `${part} [${bodies.map((b) => expandPackageScripts(repoPath, b, depth + 1)).join(' && ')}]`;
  });
  return expanded.join(' && ');
}
