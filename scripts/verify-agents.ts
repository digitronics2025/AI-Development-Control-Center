/**
 * Manual provider verification (PLAN §36 Phase 1).
 *
 *   pnpm verify:agents                  detection, version, subscription check (no usage)
 *   pnpm verify:agents --run            also runs a harmless prompt through each CLI
 *   pnpm verify:agents --run --only claude --claude-model haiku --codex-model gpt-5.6-sol
 *
 * The run happens in a new empty temporary folder, with API credentials
 * stripped (Subscription Only), and asks the agent to reply with one word.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '@acc/agent-sdk';
import { ClaudeCodeAdapter } from '@acc/agent-claude';
import { CodexAdapter } from '@acc/agent-codex';
import { detectApiCredentials, Redactor } from '@acc/security';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const adapters: Array<{ adapter: AgentAdapter; model: string }> = [
  { adapter: new CodexAdapter(), model: value('codex-model', 'default') },
  { adapter: new ClaudeCodeAdapter(), model: value('claude-model', 'default') },
].filter(({ adapter }) => !args.includes('--only') || value('only', '') === adapter.id);

const redact = Redactor.fromEnv();
const options = { billingMode: 'subscription' as const, baseEnv: process.env, loadUserConfig: false };
let failures = 0;

const present = detectApiCredentials(process.env);
console.log(
  present.length
    ? `API credentials in this shell (removed from every agent run): ${present.join(', ')}`
    : 'No API billing credentials found in this shell.',
);

for (const { adapter, model } of adapters) {
  console.log(`\n== ${adapter.displayName} ==`);
  const detection = await adapter.detect(options);
  console.log(`executable: ${detection.found ? `${detection.executablePath} (v${detection.version ?? '?'})` : `NOT FOUND — ${detection.error}`}`);
  const health = await adapter.healthCheck(options);
  console.log(`health:     ${health.state} · billing=${health.billing} · ${health.message}`);
  if (health.state !== 'connected') failures++;
  if (!flag('run') || health.state !== 'connected') continue;

  const cwd = mkdtempSync(path.join(os.tmpdir(), `acc-verify-${adapter.id}-`));
  const started = Date.now();
  try {
    const handle = await adapter.execute({
      ...options,
      executionId: randomUUID(),
      cwd,
      prompt: 'Reply with exactly the word PONG and nothing else. Do not run any commands or read any files.',
      model,
      effort: 'low',
      permissionLevel: 1,
      timeoutMs: 180_000,
    });
    console.log(`command:    ${redact.redact(handle.commandLine)}`);
    const result = await handle.done;
    const ok = result.status === 'succeeded' && /PONG/i.test(result.output);
    console.log(`result:     ${result.status} · exit ${result.exitCode} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`output:     ${redact.redact(result.output).slice(0, 200) || '(empty)'}`);
    if (result.errorClass) console.log(`error:      ${result.errorClass} — ${redact.redact(result.errorMessage ?? '')}`);
    if (!ok) failures++;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} check(s) did not pass.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
