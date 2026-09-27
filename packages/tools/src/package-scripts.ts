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
  return expand(repoPath, command, depth, (part, bodies) => `${part} [${bodies.join(' && ')}]`);
}

/**
 * The same invocation with each script body on a line of its own after it
 * (`npm run ship` → `npm run ship` + newline + `git push origin main`), for
 * rules that read a command's words, such as the release gate: in the
 * bracketed form a body's `git` is not the first word of any command. The
 * words after the script's name are appended to its body, as npm, pnpm, yarn
 * and bun run it (`"q": "git push"` run as `npm run q -- origin main` runs
 * `git push origin main`); not to its `pre`/`post` scripts.
 */
export function packageScriptLines(repoPath: string, command: string): string {
  return expand(repoPath, command, 0, (part, bodies) => [part, ...bodies].join('\n'), true);
}

function expand(repoPath: string, command: string, depth: number, join: (part: string, bodies: string[]) => string, passArgs = false): string {
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
    const extra = passArgs ? part.slice(match![0].length).replace(/^\s*--(?=\s|$)/, '').trimEnd() : '';
    const body = typeof scripts[name] === 'string' && extra ? `${scripts[name]} ${extra.trim()}` : scripts[name];
    const pre = scripts[`pre${name}`];
    const post = scripts[`post${name}`];
    const bodies = [pre, body, post].filter((b): b is string => typeof b === 'string');
    if (!bodies.length) return part;
    return join(part, bodies.map((b) => expand(repoPath, b, depth + 1, join, passArgs)));
  });
  return expanded.join(' && ');
}
