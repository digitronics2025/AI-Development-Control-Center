import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentGuardError, type AgentExecutionInput } from '@acc/agent-sdk';
import { CodexAdapter } from '../src/index.js';

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
