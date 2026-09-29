import { classifyCommand } from '@acc/security';
import type { CommandRisk, PermissionLevel } from '@acc/shared';
import { packageScriptLines, withReleaseGate } from '@acc/tools';
import { expandPackageScripts } from './script-resolve.js';

/**
 * The classifier's verdict on a command a stage runs in `workdir`, with the
 * release gate (SEC-1): a command or package script that pushes to one of
 * `releaseBranches` or a production-named branch, or merges a pull request,
 * is Level 5 production, as it is for an agent's tool call — an agent can
 * edit the script a later stage runs.
 */
export function stageCommandRisk(workdir: string, commandLine: string, releaseBranches: readonly string[]): { level: PermissionLevel; risk: CommandRisk; reasons: string[]; production: boolean } {
  const c = classifyCommand(expandPackageScripts(workdir, commandLine));
  const r = withReleaseGate({ level: c.level, risk: c.risk, reasons: c.reasons, production: c.production }, packageScriptLines(workdir, commandLine), { cwd: workdir, releaseBranches });
  return { level: r.level ?? c.level, risk: r.risk ?? c.risk, reasons: r.reasons ?? c.reasons, production: r.production ?? c.production };
}
