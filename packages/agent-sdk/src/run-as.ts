import { existsSync } from 'node:fs';
import path from 'node:path';
import { windowsLaunch } from '@acc/executor';
import type { AgentRunAs } from './contract.js';

/**
 * The agent OS boundary (SEC-3, docs/systems/security.md#agent-os-boundary):
 * a run started as the Control Center's separate Windows account, through
 * scripts/windows/agent-relay.ps1. These are the Node side's parts of it.
 */

/** The relay's exit code when it refused to start a run (keep in step with agent-relay.ps1). */
export const AGENT_RELAY_REFUSED_EXIT = 31436;
/** The start of the one stderr line the relay writes when it refuses. */
export const AGENT_RELAY_PREFIX = 'Agent isolation:';
/** The environment variable that carries the launch to the relay (removed before the program starts). */
export const AGENT_RELAY_ENV = 'ACC_AGENT_RELAY';

/**
 * Why a run cannot start as the agent account at all, or null when the relay
 * may try. Decided before anything starts, so a run the relay could never start
 * fails with a reason rather than a crash — and never falls back to the operator.
 */
export function runAsRefusal(runAs: AgentRunAs, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return `${AGENT_RELAY_PREFIX} running agents as a separate account works on Windows only. Turn agent isolation off in Settings to run them here.`;
  if (!runAs.relay || !existsSync(runAs.relay)) return `${AGENT_RELAY_PREFIX} the Control Center's launcher for the agent account is missing${runAs.relay ? ` (${runAs.relay})` : ''}.`;
  if (!runAs.credentialFile || !existsSync(runAs.credentialFile)) {
    return `${AGENT_RELAY_PREFIX} agent runs are set to start as the Windows account "${runAs.account}", but it is not set up on this computer. Set it up with the privileged helper's agent_account_create, or turn agent isolation off in Settings.`;
  }
  return null;
}

/**
 * How to start `executable args` as the agent account: Windows PowerShell
 * running the relay, with the run's environment plus the launch in
 * `ACC_AGENT_RELAY` (base64 JSON: the account, its password record, the program
 * and the command line `runProcess` would have used, the folder). The prompt
 * still travels on stdin, which the relay copies to the program; nothing
 * secret is on either command line. `PSExecutionPolicyPreference` and
 * `PSModulePath`, which Windows PowerShell changes in its own environment, are
 * carried so the program gets the run's values back. The relay itself starts
 * without `PSModulePath` (`windowsPowerShellEnv`).
 */
export function relayLaunch(runAs: AgentRunAs, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const { file, commandLine } = windowsLaunch(executable, args, env);
  const restore = { PSExecutionPolicyPreference: env.PSExecutionPolicyPreference ?? null, PSModulePath: env.PSModulePath ?? null };
  const spec = { account: runAs.account, credentialFile: runAs.credentialFile, file, arguments: commandLine, cwd, restore };
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return {
    command: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runAs.relay],
    env: { ...windowsPowerShellEnv(env), [AGENT_RELAY_ENV]: Buffer.from(JSON.stringify(spec), 'utf8').toString('base64') },
  };
}

/**
 * An environment for Windows PowerShell 5.1 without `PSModulePath`, which it then builds for itself. Started from
 * PowerShell 7 (as GitHub's Windows runners run every step), it inherits 7's module folders first and cannot load
 * its own `Microsoft.PowerShell.Security` — no `ConvertTo-SecureString`, so no DPAPI password record (CI,
 * 2026-09-28). Windows variable names ignore case, so every spelling goes.
 */
export function windowsPowerShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
}

/** The relay's own refusal, from the tail of a run it ended with `AGENT_RELAY_REFUSED_EXIT`. */
export function relayRefusal(exitCode: number | null, tail: readonly string[], account: string): string | null {
  if (exitCode !== AGENT_RELAY_REFUSED_EXIT) return null;
  return [...tail].reverse().find((line) => line.startsWith(AGENT_RELAY_PREFIX)) ?? `${AGENT_RELAY_PREFIX} the run could not start as the Windows account "${account}".`;
}
