import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '@acc/executor';
import type { AgentCapabilities, ModelDescriptor } from '@acc/shared';
import {
  AGENT_RELAY_ENV,
  AGENT_RELAY_REFUSED_EXIT,
  AgentGuardError,
  CliAgentAdapter,
  relayLaunch,
  relayRefusal,
  runAsRefusal,
  type AgentExecutionInput,
  type AgentHealth,
  type AgentRunAs,
  type ParserContext,
  type StreamParser,
} from '../src/index.js';

/** The agent OS boundary (docs/systems/security.md#agent-os-boundary): launching a run as the agent account. */

const RELAY = path.resolve(import.meta.dirname, '../../../scripts/windows/agent-relay.ps1');
const win = process.platform === 'win32';

/** A CLI adapter whose "CLI" is Node running a script that reports how it was started. */
class ReportingCli extends CliAgentAdapter {
  readonly id = 'reporting';
  readonly displayName = 'Reporting CLI';
  readonly usageCapabilities = { provider: 'simulated', tokenUsage: false, providerCost: false, credit: false, quota: false, rateLimits: false, cacheTokens: false, reasoningTokens: false, resetTime: false };
  protected readonly binaryName = 'node';
  constructor(private readonly script: string) {
    super();
  }
  protected async readVersion(): Promise<string> {
    return '1.0.0';
  }
  protected async probeAuth(): Promise<Omit<AgentHealth, 'checkedAt'>> {
    return { state: 'connected', message: 'ok', authMethod: 'test', billing: 'subscription' };
  }
  protected buildArgs(): string[] {
    return [this.script, 'two words', '{"k":"v w"}'];
  }
  protected createParser({ emit }: ParserContext): StreamParser {
    const out: string[] = [];
    return {
      onStdout: (line) => out.push(line),
      onStderr: (line) => emit('stderr', line),
      finish: () => ({ finalMessage: out.join('\n'), failureMessages: [], sessionId: null, usageLimited: false, guardViolation: null, filesChanged: [], usage: null, capacity: [] }),
    };
  }
  async getCapabilities(): Promise<AgentCapabilities> {
    return { repositoryRead: true, repositoryWrite: true, commandExecution: true, images: false, interactive: false, nonInteractive: true, modelSelection: false, effortSelection: false };
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-runas-'));
  const marker = path.join(dir, 'started');
  const script = path.join(dir, 'cli.js');
  writeFileSync(
    script,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes');
let input = '';
process.stdin.setEncoding('utf8').on('data', (c) => (input += c)).on('end', () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input, relay: process.env.${AGENT_RELAY_ENV} ?? null, runVar: process.env.ACC_TEST_RUN_VAR ?? null }) + '\\n');
});`,
  );
  const input = (over: Partial<AgentExecutionInput> = {}): AgentExecutionInput => ({
    executionId: `exec-${randomBytes(4).toString('hex')}`,
    cwd: dir,
    prompt: 'Réponds — vite → PONG',
    model: 'default',
    effort: 'default',
    permissionLevel: 2,
    timeoutMs: 60_000,
    billingMode: 'subscription',
    baseEnv: { ...process.env, ACC_TEST_RUN_VAR: 'kept' },
    executablePath: process.execPath,
    ...over,
  });
  return { dir, marker, script, input };
}

/** A password record like the privileged helper writes, protected for this Windows user (DPAPI), for a made-up password. */
async function dpapiRecord(dir: string, account: string, password = randomBytes(18).toString('base64')): Promise<string> {
  const out: string[] = [];
  const r = await runProcess({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', 'ConvertFrom-SecureString (ConvertTo-SecureString $env:ACC_TEST_SECRET -AsPlainText -Force)'],
    cwd: dir,
    env: { ...process.env, ACC_TEST_SECRET: password },
    onLine: (stream, line) => stream === 'stdout' && line.trim() && out.push(line.trim()),
  }).done;
  expect(r.exitCode).toBe(0);
  const file = path.join(dir, 'agent-account.json');
  writeFileSync(file, JSON.stringify({ account, sid: 'S-1-5-21-0-0-0-1001', protectedSecret: out.join(''), grants: [] }));
  return file;
}

async function runRelay(runAs: AgentRunAs, cwd: string, prompt: string, extra: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const launch = relayLaunch(runAs, process.execPath, ['-e', 'x', 'two words'], cwd, env);
  const out: string[] = [];
  const err: string[] = [];
  const result = await runProcess({ ...launch, args: [...launch.args, ...extra], cwd, stdin: prompt, timeoutMs: 120_000, onLine: (s, l) => (s === 'stdout' ? out : err).push(l) }).done;
  return { result, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('runAsRefusal', () => {
  it('refuses off Windows, without the relay, and without a password record; lets the relay try otherwise', () => {
    const { dir } = setup();
    const record = path.join(dir, 'agent-account.json');
    writeFileSync(record, '{}');
    const runAs = { account: 'acc-agent', credentialFile: record, relay: RELAY };
    expect(runAsRefusal(runAs, 'linux')).toMatch(/^Agent isolation: .*Windows only/);
    expect(runAsRefusal({ ...runAs, relay: path.join(dir, 'missing.ps1') }, 'win32')).toMatch(/launcher for the agent account is missing/);
    expect(runAsRefusal({ ...runAs, credentialFile: path.join(dir, 'none.json') }, 'win32')).toMatch(/"acc-agent", but it is not set up on this computer/);
    expect(runAsRefusal({ ...runAs, credentialFile: '' }, 'win32')).toMatch(/not set up/);
    expect(runAsRefusal(runAs, 'win32')).toBeNull();
  });
});

describe('relayLaunch', () => {
  it('starts Windows PowerShell on the relay with the run environment and the launch in one variable; the prompt is on neither command line', () => {
    const env = { PATH: 'p', ACC_TOOL_SESSION: 'session-value', PSModulePath: 'm' };
    const launch = relayLaunch({ account: 'acc-agent', credentialFile: 'C:\\data\\agent-account.json', relay: 'C:\\acc\\scripts\\windows\\agent-relay.ps1' }, process.execPath, ['-p', '{"a":"b c"}'], 'C:\\work\\t1', env);
    expect(path.basename(launch.command).toLowerCase()).toBe('powershell.exe');
    expect(launch.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\acc\\scripts\\windows\\agent-relay.ps1']);
    expect(launch.env).toMatchObject(env);
    const spec = JSON.parse(Buffer.from(launch.env[AGENT_RELAY_ENV]!, 'base64').toString('utf8'));
    expect(spec).toMatchObject({ account: 'acc-agent', credentialFile: 'C:\\data\\agent-account.json', cwd: 'C:\\work\\t1', restore: { PSExecutionPolicyPreference: null, PSModulePath: 'm' } });
    // The session token travels in the environment only, never in the launch.
    expect(JSON.stringify(spec)).not.toContain('session-value');
    if (win) expect(spec).toMatchObject({ file: process.execPath, arguments: '-p "{\\"a\\":\\"b c\\"}"' });
  });

  it('reads the relay refusal from the tail only for its own exit code', () => {
    expect(relayRefusal(AGENT_RELAY_REFUSED_EXIT, ['noise', 'Agent isolation: there is no Windows account named x on this computer.'], 'x')).toBe('Agent isolation: there is no Windows account named x on this computer.');
    expect(relayRefusal(AGENT_RELAY_REFUSED_EXIT, [], 'x')).toMatch(/could not start as the Windows account "x"/);
    expect(relayRefusal(1, ['Agent isolation: whatever'], 'x')).toBeNull();
  });
});

describe('CliAgentAdapter launch', () => {
  it('without runAs starts the CLI itself, as before: argv, stdin and the run environment unchanged, no relay', async () => {
    const { input, script } = setup();
    const handle = await new ReportingCli(script).execute(input());
    const result = await handle.done;
    expect(result.status).toBe('succeeded');
    expect(JSON.parse(result.output)).toEqual({ argv: ['two words', '{"k":"v w"}'], input: 'Réponds — vite → PONG', relay: null, runVar: 'kept' });
    expect(handle.commandLine).toBe(`node ${script} two words {"k":"v w"}`);
  });

  it('with runAs but no agent account set up, refuses before anything starts — never as the operator', async () => {
    const { input, script, marker, dir } = setup();
    const run = input({ runAs: { account: 'acc-agent', credentialFile: path.join(dir, 'agent-account.json'), relay: RELAY } });
    const error = await new ReportingCli(script).execute(run).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AgentGuardError);
    expect(error).toMatchObject({ errorClass: 'PERMISSION_DENIED', message: expect.stringMatching(win ? /not set up on this computer/ : /Windows only/) });
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(!win)('with runAs and an account the relay cannot start as, fails with the relay reason and never runs the CLI', async () => {
    const { input, script, marker, dir } = setup();
    const credentialFile = await dpapiRecord(dir, 'acc-nobody-x9');
    const lines: string[] = [];
    const result = await (await new ReportingCli(script).execute(input({ runAs: { account: 'acc-nobody-x9', credentialFile, relay: RELAY }, onLine: (_s, l) => lines.push(l) }))).done;
    expect(result).toMatchObject({ status: 'failed', errorClass: 'PERMISSION_DENIED', errorMessage: expect.stringMatching(/^Agent isolation: there is no Windows account named acc-nobody-x9/) });
    expect(lines).toContain('Running as the Windows account acc-nobody-x9 (agent isolation)');
    expect(existsSync(marker)).toBe(false);
  }, 120_000);
});

describe.skipIf(!win)('agent-relay.ps1 (real Windows PowerShell; never starts anything as another account here)', () => {
  it('dry run: reads the launch and the password record, keeps stdin byte for byte and the run environment, drops its own variable', async () => {
    const { dir } = setup();
    const credentialFile = await dpapiRecord(dir, 'acc-agent');
    const prompt = 'Réponds — vite → PONG\nline two';
    const { result, stdout, stderr } = await runRelay({ account: 'acc-agent', credentialFile, relay: RELAY }, dir, prompt, ['-DryRun'], { ...process.env, ACC_TEST_RUN_VAR: 'kept' });
    expect(result.exitCode, stderr).toBe(0);
    const plan = JSON.parse(stdout) as { account: string; file: string; arguments: string; cwd: string; environment: string[]; stdinBytes: number; stdinSha256: string; job: boolean };
    expect(plan).toMatchObject({ account: 'acc-agent', file: process.execPath, arguments: '-e x "two words"', cwd: dir, job: true });
    const bytes = Buffer.from(prompt, 'utf8');
    expect(plan.stdinBytes).toBe(bytes.length);
    expect(plan.stdinSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(plan.environment).toContain('ACC_TEST_RUN_VAR');
    expect(plan.environment).not.toContain(AGENT_RELAY_ENV);
    expect(stdout).not.toContain('password');
  }, 120_000);

  it('refuses, with its own exit code and one reason line, whatever it cannot start as the agent account', async () => {
    const { dir } = setup();
    const refusal = async (runAs: AgentRunAs, pattern: RegExp) => {
      const { result, stderr } = await runRelay(runAs, dir, 'prompt');
      expect(result.exitCode, stderr).toBe(AGENT_RELAY_REFUSED_EXIT);
      expect(stderr).toMatch(pattern);
    };
    const missing = path.join(dir, 'none.json');
    await refusal({ account: 'acc-agent', credentialFile: missing, relay: RELAY }, /^Agent isolation: the Windows account acc-agent is not set up on this computer/m);
    const garbled = path.join(dir, 'garbled.json');
    writeFileSync(garbled, JSON.stringify({ account: 'acc-agent', protectedSecret: 'not-a-protected-value' }));
    await refusal({ account: 'acc-agent', credentialFile: garbled, relay: RELAY }, /the password of acc-agent could not be read/);
    const record = await dpapiRecord(dir, 'acc-agent');
    await refusal({ account: 'acc-other', credentialFile: record, relay: RELAY }, /set up on this computer is 'acc-agent', not 'acc-other'/);
    await refusal({ account: 'acc-agent', credentialFile: record, relay: RELAY }, /there is no Windows account named acc-agent|acc-agent has never signed in/);
    const own = os.userInfo().username;
    if (/^[A-Za-z][A-Za-z0-9_-]{2,19}$/.test(own)) await refusal({ account: own, credentialFile: await dpapiRecord(dir, own), relay: RELAY }, /is your own Windows account/);
  }, 240_000);
});
