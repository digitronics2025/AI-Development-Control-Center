import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The agent OS boundary (SEC-3, docs/systems/security.md#agent-os-boundary):
 * where its pieces are, and what the agent account must be able to read.
 */

/** The agent account's record — its password, protected for the operator's Windows user — written by the privileged helper. */
export function agentAccountFile(dataDir: string): string {
  return path.join(dataDir, 'agent-account.json');
}

/** The launcher that starts a run as the agent account. */
export function agentRelayScript(resourcesDir: string): string {
  return path.join(resourcesDir, 'scripts', 'windows', 'agent-relay.ps1');
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Folders the agent account is given read access to when it is set up: those
 * of the programs a run starts that sit inside the operator's own user folder,
 * which a separate account cannot open — the orchestrator's build (the shell
 * precheck hook and the MCP bridge), Node, and each agent CLI. A folder
 * elsewhere (`C:\Program Files\nodejs`) is readable by every user already,
 * and one that does not exist (no build yet) is left out. The helper refuses
 * anything that is not a plain program folder.
 */
export function agentAccountGrants(opts: { home: string; buildDir: string; nodePath: string; executables: Array<string | null | undefined> }): string[] {
  const folders = [opts.buildDir, path.dirname(opts.nodePath), ...opts.executables.filter((e): e is string => Boolean(e)).map((e) => path.dirname(e))];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const folder of folders.map((f) => path.resolve(f))) {
    const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
    if (seen.has(key) || !inside(folder, opts.home) || path.resolve(opts.home) === folder || !existsSync(folder)) continue;
    seen.add(key);
    out.push(folder);
  }
  return out;
}
