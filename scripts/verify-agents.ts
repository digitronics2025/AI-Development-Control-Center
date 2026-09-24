/**
 * Manual provider verification (PLAN §36 Phase 1).
 *
 *   pnpm verify:agents                  detection, version, subscription check (no usage)
 *   pnpm verify:agents --run            also runs a harmless prompt through each CLI
 *   pnpm verify:agents --run --only claude --claude-model haiku --codex-model gpt-5.6-sol
 *   pnpm verify:agents --only claude --claude-model haiku --skills
 *                                       also proves skills run inside a stage's limits
 *
 * The run happens in a new empty temporary folder, with API credentials
 * stripped (Subscription Only), and asks the agent to reply with one word.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '@acc/agent-sdk';
import { ClaudeCodeAdapter } from '@acc/agent-claude';
import { CodexAdapter } from '@acc/agent-codex';
import { detectApiCredentials, Redactor, sanitizeEnv } from '@acc/security';

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

/** Plain next steps for failures caused by the account or CLI rather than this setup. */
const HINTS: Record<string, string> = {
  USAGE_LIMIT:
    '{agent} is installed and signed in correctly, but the account has no allowance left. Add credits or wait for the limit to reset. The Control Center pauses {agent} stages instead of switching to paid usage. To check the other agent only, re-run with --only.',
  MODEL_UNAVAILABLE: 'Update the {agent} CLI, or pass another model with --{id}-model.',
  AUTH_FAILURE: 'Sign in to {agent} with your subscription (not an API key), then re-run.',
};

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
    if (result.errorClass) {
      console.log(`error:      ${result.errorClass} — ${redact.redact(result.errorMessage ?? '')}`);
      const hint = HINTS[result.errorClass];
      if (hint) console.log(`what to do: ${hint.replaceAll('{agent}', adapter.displayName).replaceAll('{id}', adapter.id)}`);
    }
    if (!ok) failures++;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (flag('skills')) await verifySkills();

console.log(failures ? `\n${failures} check(s) did not pass.` : '\nAll checks passed.');

/**
 * Real-CLI proof that skills run inside a stage's limits (docs/plans/agent-skills.md).
 * The adapter's own flags are used, so this tests exactly what ships. Run it after
 * every Claude Code update: the guarantee rests on the CLI's permission semantics.
 */
async function verifySkills() {
  const adapter = adapters.find((a) => a.adapter.id === 'claude');
  if (!adapter) return;
  console.log('\n== Claude Code skills ==');
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-verify-skills-'));
  const skill = (name: string, frontmatter: string, body: string) => {
    mkdirSync(path.join(cwd, '.claude', 'skills', name), { recursive: true });
    writeFileSync(path.join(cwd, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Control Center probe. Invoke only when asked to run ${name}.\n${frontmatter}---\n${body}\n`);
  };
  skill('acc-probe-plain', '', 'Reply with exactly PROBE-PLAIN-OK and nothing else.');
  skill('acc-probe-tools', 'allowed-tools: Read\n', 'Reply with exactly PROBE-TOOLS-OK and nothing else.');
  skill(
    'acc-probe-grant',
    'allowed-tools: WebFetch, Bash, Write\n',
    [
      'Attempt every step, even if an earlier one fails.',
      '1. Use the WebFetch tool on https://example.com.',
      `2. Run the Bash command: node -e "require('fs').writeFileSync('bash-marker.txt','x')"`,
      '3. Use the Write tool to create write-marker.txt containing x.',
      '4. Reply with which steps succeeded.',
    ].join('\n'),
  );
  const run = async (name: string, level: 1 | 2) => {
    for (const marker of ['bash-marker.txt', 'write-marker.txt']) rmSync(path.join(cwd, marker), { force: true });
    const lines: string[] = [];
    const handle = await adapter.adapter.execute({
      ...options,
      executionId: randomUUID(),
      cwd,
      prompt: `Use the Skill tool to run the skill named ${name}, then follow its instructions exactly.`,
      model: adapter.model,
      effort: 'low',
      permissionLevel: level,
      timeoutMs: 240_000,
      onLine: (_stream, text) => lines.push(text),
    });
    const result = await handle.done;
    const written = (marker: string) => existsSync(path.join(cwd, marker));
    return { result, lines, written };
  };
  // A WebFetch call may be attempted, but it must never have run: the tool does not exist in the run.
  const fetched = (lines: string[]) => {
    const at = lines.findIndex((l) => l.startsWith('[tool] WebFetch'));
    return at !== -1 && !lines.slice(at + 1).some((l) => /^tool error: .*(no such tool|not available|denied)/i.test(l));
  };
  const expect = (label: string, ok: boolean, detail: string) => {
    console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${ok ? '' : ` — ${redact.redact(detail).slice(0, 300)}`}`);
    if (!ok) failures++;
  };
  try {
    const plain = await run('acc-probe-plain', 1);
    expect('a plain skill runs at Level 1', plain.result.status === 'succeeded' && /PROBE-PLAIN-OK/.test(plain.result.output), plain.lines.join(' | '));
    const tools = await run('acc-probe-tools', 2);
    expect(
      'a skill that declares allowed-tools runs at Level 2',
      tools.result.status === 'succeeded' && /PROBE-TOOLS-OK/.test(tools.result.output) && !tools.lines.some((l) => l.startsWith('permission denied: Skill')),
      tools.lines.join(' | '),
    );
    const l1 = await run('acc-probe-grant', 1);
    expect("a skill's allowed-tools cannot write at Level 1", !l1.written('bash-marker.txt') && !l1.written('write-marker.txt'), l1.lines.join(' | '));
    expect("a skill's allowed-tools cannot reach WebFetch at Level 1", !fetched(l1.lines), l1.lines.join(' | '));
    const l2 = await run('acc-probe-grant', 2);
    expect("a skill's allowed-tools cannot reach WebFetch at Level 2", !fetched(l2.lines), l2.lines.join(' | '));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  await verifySkillCatalog(adapter.adapter);
}

/**
 * The slash picker's list against the CLI's own: every name the Control Center
 * offers must be one Claude Code actually loads in this repository (it reports
 * them in its init event). Uses the operator's real configuration.
 */
async function verifySkillCatalog(adapter: AgentAdapter) {
  const repo = process.cwd();
  const listed = await adapter.listSkills!({ ...options, loadUserConfig: true }, repo);
  const executable = (await adapter.detect(options)).executablePath;
  if (!executable) return;
  const reported = await new Promise<string[] | null>((resolve) => {
    const child = spawn(executable, ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', 'haiku', '--tools', '', '--strict-mcp-config'], {
      cwd: repo,
      env: sanitizeEnv(process.env, 'subscription').env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(null), 60_000);
    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split('\n').slice(0, -1)) {
        try {
          const event = JSON.parse(line) as { type?: string; subtype?: string; skills?: string[] };
          if (event.type === 'system' && event.subtype === 'init') return finish(Array.isArray(event.skills) ? event.skills : null);
        } catch {
          /* not JSON */
        }
      }
    });
    child.on('exit', () => finish(null));
    child.stdin.end('Reply with OK.');
  });
  if (!reported) {
    console.log('FAIL  the CLI reported no skill list to compare with');
    failures++;
    return;
  }
  const cli = new Set(reported);
  const phantom = listed.filter((s) => !cli.has(s.name)).map((s) => s.name);
  const unlisted = reported.filter((name) => !listed.some((s) => s.name === name));
  console.log(`info  picker lists ${listed.length} skills; Claude Code reports ${reported.length} in ${repo}`);
  if (unlisted.length) console.log(`info  loaded by the CLI but not listed (${unlisted.length}): ${unlisted.slice(0, 15).join(', ')}${unlisted.length > 15 ? ', …' : ''}`);
  const ok = phantom.length === 0;
  console.log(`${ok ? 'pass' : 'FAIL'}  every skill the picker offers is one the CLI loads${ok ? '' : ` — not loaded: ${phantom.slice(0, 15).join(', ')}`}`);
  if (!ok) failures++;
  console.log(`info  ${listed.filter((s) => s.description).length} of ${listed.length} listed skills have a description`);

  // The listing itself must stay free: `/skills` is answered locally, with no model turn.
  const free = await new Promise<{ turns: unknown; cost: unknown } | null>((resolve) => {
    const child = spawn(executable, ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true })], {
      cwd: repo,
      env: sanitizeEnv(process.env, 'subscription').env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let text = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    child.on('exit', () => {
      clearTimeout(timer);
      const result = text
        .split('\n')
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; num_turns?: unknown; total_cost_usd?: unknown };
          } catch {
            return null;
          }
        })
        .find((event) => event?.type === 'result');
      resolve(result ? { turns: result.num_turns, cost: result.total_cost_usd } : null);
    });
    child.stdin.end('/skills');
  });
  const freeOk = free?.turns === 0 && free?.cost === 0;
  console.log(`${freeOk ? 'pass' : 'FAIL'}  the /skills lookup uses no model turn${freeOk ? '' : ` — ${JSON.stringify(free)}`}`);
  if (!freeOk) failures++;
}
process.exit(failures ? 1 : 0);
