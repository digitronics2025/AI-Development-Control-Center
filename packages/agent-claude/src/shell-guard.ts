/**
 * The native tool precheck (SEC-3), as the command hook Claude Code runs
 * before each Bash, Read, Grep and Glob call of a Control Center run
 * (`shellGuardSettings`). The call arrives on stdin; the hook asks the
 * orchestrator (`POST /api/tool-session/precheck`, authenticated by the run's
 * tool session from its environment) with the command, or with a file tool's
 * name, input and folder, and lets the call run only on an explicit allow.
 *
 * The CLI lets a call through when a hook exits with any code but 2, fails to
 * start or times out, so every other outcome is a refusal: no session in the
 * environment, a call it cannot read (a tool it does not guard included), an
 * orchestrator that does not answer, answers late, fails, or answers anything
 * but a decision, and any error of its own. A refusal exits 2 with the reason
 * on stderr (Claude sees it) and the deny decision on stdout as well.
 */

/** The hook's own deadline for the whole check, well below the CLI's hook timeout (60 s). */
export const SHELL_GUARD_DEADLINE_MS = 15_000;
/** A call larger than this is not read (the precheck route takes commands up to 200 000 characters). */
export const SHELL_GUARD_MAX_INPUT = 1024 * 1024;
/** Claude Code's native file-reading tools the hook guards beside Bash; the precheck judges each by the paths it reads. */
export const GUARDED_FILE_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export type GuardedFileTool = (typeof GUARDED_FILE_TOOLS)[number];

export interface GuardOutcome {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

export const ALLOW: GuardOutcome = { exitCode: 0, stdout: '', stderr: '' };

export function refusal(reason: string): GuardOutcome {
  const text = `Refused by the AI Development Control Center: ${reason}`;
  return {
    exitCode: 2,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } }),
    stderr: text,
  };
}

/** Judge one call (`stdin`, the hook's input) by asking the orchestrator named in `env`. Never throws. */
export async function runShellGuard(stdin: string, env: NodeJS.ProcessEnv, opts: { fetch?: typeof fetch; deadlineMs?: number } = {}): Promise<GuardOutcome> {
  const base = env.ACC_TOOL_URL;
  const token = env.ACC_TOOL_SESSION;
  if (!base || !token) return refusal('this run has no Control Center session, so its tool calls cannot be checked.');
  let body: Record<string, unknown>;
  try {
    const call = JSON.parse(stdin) as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown } | null;
    const input = call?.tool_input;
    const object = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
    if (call?.tool_name === 'Bash' && typeof object?.command === 'string') body = { command: object.command, ...(typeof call.cwd === 'string' ? { cwd: call.cwd } : {}) };
    else if ((GUARDED_FILE_TOOLS as readonly unknown[]).includes(call?.tool_name) && object) body = { tool: call!.tool_name, input: object, ...(typeof call!.cwd === 'string' ? { cwd: call!.cwd } : {}) };
    else return refusal('the call could not be read.');
  } catch {
    return refusal('the call could not be read.');
  }
  const deadline = opts.deadlineMs ?? SHELL_GUARD_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  let status: number;
  let text: string;
  try {
    const res = await (opts.fetch ?? fetch)(new URL('/api/tool-session/precheck', base), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
  } catch {
    return refusal(controller.signal.aborted ? `the Control Center did not answer within ${Math.round(deadline / 1000)} s.` : 'the Control Center could not be reached to check this call.');
  } finally {
    clearTimeout(timer);
  }
  if (status < 200 || status > 299) return refusal(`the Control Center did not check this call (HTTP ${status}).`);
  type Answer = { decision?: unknown; reason?: unknown } | null;
  let answer: Answer = null;
  try {
    answer = JSON.parse(text) as Answer;
  } catch {
    /* not a decision */
  }
  if (answer?.decision === 'allow') return ALLOW;
  if (answer?.decision === 'deny' && typeof answer.reason === 'string' && answer.reason) return refusal(answer.reason);
  return refusal('the Control Center gave no decision for this call.');
}
