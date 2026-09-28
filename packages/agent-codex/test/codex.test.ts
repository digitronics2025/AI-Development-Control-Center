import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentGuardError, type AgentExecutionInput } from '@acc/agent-sdk';
import { CodexAdapter, codexMcpIsolationArgs, codexProtocolDrift } from '../src/index.js';

const fixture = path.resolve(import.meta.dirname, '../../../tests/fixtures', process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex');

function input(overrides: Partial<AgentExecutionInput> & { env?: NodeJS.ProcessEnv } = {}): AgentExecutionInput {
  const { env, ...rest } = overrides;
  return {
    executionId: `exec-${Math.random().toString(36).slice(2)}`,
    cwd: os.tmpdir(),
    prompt: 'Reply PONG',
    model: 'default',
    effort: 'default',
    permissionLevel: 1,
    timeoutMs: 20_000,
    billingMode: 'subscription',
    baseEnv: { ...process.env, ...env },
    executablePath: fixture,
    ...rest,
  };
}

describe('CodexAdapter', () => {
  it('detects the executable and version', async () => {
    const adapter = new CodexAdapter();
    const detection = await adapter.detect(input());
    expect(detection).toMatchObject({ found: true, version: '9.9.9' });
    const missing = await adapter.detect(input({ executablePath: path.join(os.tmpdir(), 'nope', 'codex') }));
    expect(missing.found).toBe(false);
  });

  it('reports a ChatGPT session as subscription billing', async () => {
    const health = await new CodexAdapter().healthCheck(input());
    expect(health).toMatchObject({ state: 'connected', billing: 'subscription', authMethod: 'chatgpt' });
  });

  it('blocks API-key sign-in in subscription mode and refuses to run', async () => {
    const adapter = new CodexAdapter();
    const run = input({ env: { FAKE_CODEX_AUTH: 'apikey' } });
    const health = await adapter.healthCheck(run);
    expect(health.state).toBe('api_billing_blocked');
    await expect(adapter.execute(run)).rejects.toBeInstanceOf(AgentGuardError);
    // Explicit API mode allows it.
    const api = await adapter.healthCheck({ ...run, billingMode: 'api' });
    expect(api.state).toBe('connected');
  });

  it('reports a signed-out CLI as auth_required', async () => {
    const health = await new CodexAdapter().healthCheck(input({ env: { FAKE_CODEX_AUTH: 'none' } }));
    expect(health.state).toBe('auth_required');
  });

  it('runs a task in the selected directory, prompt via stdin, API key stripped', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-codex-'));
    const argsFile = path.join(cwd, 'args.json');
    const lines: string[] = [];
    const handle = await new CodexAdapter().execute(
      input({
        cwd,
        model: 'gpt-test',
        effort: 'high',
        permissionLevel: 2,
        env: { OPENAI_API_KEY: ['sk', 'fake', 'value'].join('-'), FAKE_ARGS_FILE: argsFile },
        onLine: (_s, text) => lines.push(text),
      }),
    );
    const result = await handle.done;
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('PONG');
    expect(result.output).toContain('ENV_HAS_OPENAI_KEY=no');
    expect(result.output.toLowerCase()).toContain(`cwd=${cwd.toLowerCase()}`);
    expect(result.sessionId).toBe('thread-123');
    expect(result.filesChanged).toEqual(['src/a.ts']);
    expect(lines).toContain('$ git status');
    const { args } = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] };
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '-m', 'gpt-test', '--sandbox', 'workspace-write', '-']));
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args.join(' ')).not.toContain('Reply PONG');
  });

  it('uses a read-only sandbox for level 1 stages', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-codex-'));
    const argsFile = path.join(cwd, 'args.json');
    await (await new CodexAdapter().execute(input({ cwd, env: { FAKE_ARGS_FILE: argsFile } }))).done;
    const { args } = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] };
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).not.toContain('-m');
  });

  it("never loads execpolicy rules, whose allow decisions would run a command outside the stage's sandbox", async () => {
    const argsOf = async (overrides: Partial<AgentExecutionInput>) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-codex-'));
      const argsFile = path.join(cwd, 'args.json');
      await (await new CodexAdapter().execute(input({ cwd, ...overrides, env: { FAKE_ARGS_FILE: argsFile } }))).done;
      return (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
    };
    for (const overrides of [{ permissionLevel: 1 }, { permissionLevel: 2, loadUserConfig: true }, { permissionLevel: 4, loadUserConfig: false }] as const) {
      const args = await argsOf(overrides);
      expect(args).toContain('--ignore-rules');
      expect(args.indexOf('--ignore-rules')).toBeLessThan(args.indexOf('-'));
    }
  });

  describe('MCP servers in a run', () => {
    const configured = JSON.stringify([
      { name: 'playwright', enabled: true, transport: { type: 'stdio', command: 'npx' } },
      { name: 'tiktok-ads', enabled: true, transport: { type: 'streamable_http', url: 'https://example.com/mcp' } },
      { name: 'acc', enabled: true, transport: { type: 'stdio', command: 'node' } },
    ]);
    const bridge = { name: 'acc', command: 'node', args: ['C:\\acc\\acc-mcp.js'], env: { ACC_TOOL_URL: 'http://127.0.0.1:4317', ACC_TOOL_SESSION: 'session' } };
    const runWith = async (overrides: Partial<AgentExecutionInput> & { env?: NodeJS.ProcessEnv }) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-codex-mcp-'));
      const argsFile = path.join(cwd, 'args.json');
      const mcpFile = path.join(cwd, 'mcp.json');
      const run = input({ cwd, ...overrides, env: { FAKE_ARGS_FILE: argsFile, FAKE_MCP_ARGS_FILE: mcpFile, ...overrides.env } });
      const read = (file: string) => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { args: string[]; cwd: string }) : null);
      return { cwd, run, exec: () => read(argsFile), list: () => read(mcpFile) };
    };

    it('switches off every configured server but the Control Center bridge, and the features that add their own', async () => {
      const t = await runWith({ toolBridge: bridge, env: { FAKE_CODEX_MCP_LIST: configured } });
      await (await new CodexAdapter().execute(t.run)).done;
      const { args } = t.exec()!;
      const pairs = args.flatMap((a, i) => (a === '--disable' ? [args[i + 1]] : []));
      expect(pairs).toEqual(['apps', 'plugins', 'skill_mcp_dependency_install']);
      expect(args).toContain('mcp_servers.playwright={enabled=false,command="acc-disabled"}');
      expect(args).toContain('mcp_servers.tiktok-ads={enabled=false,url="http://127.0.0.1/acc-disabled"}');
      expect(args.some((a) => a.startsWith('mcp_servers.acc={'))).toBe(false);
      expect(args).toContain("mcp_servers.acc.command='node'");
      // The listing ran in the run's folder (trusted-project layers) with the same features off.
      const list = t.list()!;
      expect(list.args).toEqual(['mcp', 'list', '--json', '--disable', 'apps', '--disable', 'plugins', '--disable', 'skill_mcp_dependency_install']);
      expect(list.cwd.toLowerCase()).toBe(t.cwd.toLowerCase());
    });

    it('switches off a configured server named like the bridge when the run has no bridge', async () => {
      const t = await runWith({ env: { FAKE_CODEX_MCP_LIST: configured } });
      await (await new CodexAdapter().execute(t.run)).done;
      expect(t.exec()!.args).toContain('mcp_servers.acc={enabled=false,command="acc-disabled"}');
    });

    it('still lists and switches off servers when the user config is not loaded', async () => {
      const t = await runWith({ loadUserConfig: false, env: { FAKE_CODEX_MCP_LIST: configured } });
      await (await new CodexAdapter().execute(t.run)).done;
      const { args } = t.exec()!;
      expect(args).toContain('--ignore-user-config');
      expect(args).toContain('mcp_servers.playwright={enabled=false,command="acc-disabled"}');
    });

    it('refuses to run when the servers cannot be listed, and says to update an old CLI', async () => {
      const t = await runWith({ env: { FAKE_CODEX_MCP_LIST: 'fail' } });
      const error = await new CodexAdapter().execute(t.run).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AgentGuardError);
      expect(error).toMatchObject({ errorClass: 'MODEL_UNAVAILABLE' });
      expect((error as Error).message).toMatch(/Unknown feature flag/);
      expect(t.exec()).toBeNull();
    });

    it.each([
      ['unreadable output', 'not json'],
      ['a transport it cannot restate', JSON.stringify([{ name: 'odd', transport: { type: 'sse' } }])],
      ['a name a -c key cannot address', JSON.stringify([{ name: 'a.b', transport: { type: 'stdio' } }])],
    ])('refuses to run on %s', async (_label, listing) => {
      const t = await runWith({ env: { FAKE_CODEX_MCP_LIST: listing } });
      await expect(new CodexAdapter().execute(t.run)).rejects.toBeInstanceOf(AgentGuardError);
      expect(t.exec()).toBeNull();
    });

    it('builds the overrides for any server set', () => {
      expect(codexMcpIsolationArgs([], 'acc')).toEqual([]);
      expect(
        codexMcpIsolationArgs(
          [
            { name: 'acc', transport: { type: 'stdio' } },
            { name: 'node_repl', transport: { type: 'stdio' } },
          ],
          'acc',
        ),
      ).toEqual(['-c', 'mcp_servers.node_repl={enabled=false,command="acc-disabled"}']);
    });
  });

  it('classifies "out of credits" as USAGE_LIMIT', async () => {
    const result = await (await new CodexAdapter().execute(input({ env: { FAKE_CODEX_SCENARIO: 'usage' } }))).done;
    expect(result).toMatchObject({ status: 'failed', errorClass: 'USAGE_LIMIT' });
    expect(result.errorMessage).toMatch(/out of credits/);
  });

  it('classifies an unsupported model as MODEL_UNAVAILABLE', async () => {
    const result = await (await new CodexAdapter().execute(input({ env: { FAKE_CODEX_SCENARIO: 'model' } }))).done;
    expect(result).toMatchObject({ status: 'failed', errorClass: 'MODEL_UNAVAILABLE' });
    expect(result.errorMessage).toMatch(/requires a newer version/);
  });

  it('records an exit-0 run without a completed turn as PROTOCOL_DRIFT, not a success', async () => {
    // Renamed events: no thread.started, no turn.completed — an answer and exit 0 are not enough.
    const renamed = await (await new CodexAdapter().execute(input({ env: { FAKE_CODEX_SCENARIO: 'drift' } }))).done;
    expect(renamed).toMatchObject({ status: 'failed', exitCode: 0, errorClass: 'PROTOCOL_DRIFT', usage: null });
    expect(renamed.errorMessage).toMatch(/without reporting a completed turn \(neither thread\.started nor turn\.completed was seen\)/);
    // A thread whose turn never completes holds no turn either.
    const turnless = await (await new CodexAdapter().execute(input({ env: { FAKE_CODEX_SCENARIO: 'thread-only' } }))).done;
    expect(turnless).toMatchObject({ status: 'failed', errorClass: 'PROTOCOL_DRIFT', sessionId: 'thread-123' });
    expect(turnless.errorMessage).toMatch(/started a thread but no turn\.completed event followed/);
    // A completed turn is a success (and a failed turn keeps its own class: the USAGE_LIMIT and MODEL_UNAVAILABLE tests).
    expect((await (await new CodexAdapter().execute(input())).done).status).toBe('succeeded');
    expect(codexProtocolDrift(true, true)).toBeNull();
    expect(codexProtocolDrift(false, true)).toBeNull();
    expect(codexProtocolDrift(true, false)).toMatch(/Settings → Agents & Models/);
  });

  it('cancels a running execution', async () => {
    const adapter = new CodexAdapter();
    const run = input({ env: { FAKE_CODEX_SCENARIO: 'hang' } });
    const handle = await adapter.execute(run);
    setTimeout(() => void adapter.cancel(run.executionId), 500);
    const result = await handle.done;
    expect(result.status).toBe('cancelled');
  });

  it('times out a hung execution', async () => {
    const result = await (await new CodexAdapter().execute(input({ timeoutMs: 800, env: { FAKE_CODEX_SCENARIO: 'hang' } }))).done;
    expect(result).toMatchObject({ status: 'timed_out', errorClass: 'TIMEOUT' });
  });

  it('discovers visible models from the local catalog', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'acc-codex-home-'));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'b-model', display_name: 'B', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }] },
          { slug: 'hidden', visibility: 'hide', priority: 1 },
          { slug: 'a-model', display_name: 'A', visibility: 'list', priority: 1, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'ultra' }] },
        ],
      }),
    );
    const models = await new CodexAdapter().listModels(input({ env: { CODEX_HOME: home } }));
    expect(models.map((m) => m.modelId)).toEqual(['a-model', 'b-model']);
    expect(models[0]).toMatchObject({ efforts: ['medium', 'ultra'], defaultEffort: 'medium', source: 'discovered' });
  });
});
