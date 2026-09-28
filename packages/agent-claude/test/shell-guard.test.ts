import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runShellGuard } from '../src/shell-guard.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const call = (command: string, tool = 'Bash') => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command, description: 'd' }, cwd: ROOT });
const fileCall = (tool: string, toolInput: unknown) => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd: ROOT });

/** A stand-in orchestrator: its answer for each call is chosen by the command, or by the file tool's path. */
let server: Server;
let url = '';
const seen: Array<{ authorization: string | undefined; body: string }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body });
      const asked = JSON.parse(body) as { command?: string; input?: { file_path?: string; path?: string } };
      const command = asked.command ?? asked.input?.file_path ?? asked.input?.path;
      if (req.url !== '/api/tool-session/precheck' || req.method !== 'POST') return res.writeHead(404).end();
      if (command === 'allowed') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ decision: 'allow' }));
      if (command === 'denied') return res.writeHead(200).end(JSON.stringify({ decision: 'deny', reason: 'Reaches the Control Center itself.' }));
      if (command === 'fails') return res.writeHead(500).end(JSON.stringify({ decision: 'allow' }));
      if (command === 'garbled') return res.writeHead(200).end('<html>allow</html>');
      if (command === 'vague') return res.writeHead(200).end(JSON.stringify({ decision: 'maybe' }));
      if (command === 'slow') return void setTimeout(() => res.writeHead(200).end(JSON.stringify({ decision: 'allow' })), 2_000);
      res.writeHead(403).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const env = () => ({ ACC_TOOL_URL: url, ACC_TOOL_SESSION: 'session-token' });

describe('the native shell precheck hook (SEC-3)', () => {
  it('lets a command run only on an explicit allow, asking with the run session', async () => {
    seen.length = 0;
    expect(await runShellGuard(call('allowed'), env())).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(seen).toEqual([{ authorization: 'Bearer session-token', body: JSON.stringify({ command: 'allowed', cwd: ROOT }) }]);
  });

  it("refuses with the Control Center's reason, on stderr and as the deny decision", async () => {
    const out = await runShellGuard(call('denied'), env());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('Refused by the AI Development Control Center: Reaches the Control Center itself.');
    expect(JSON.parse(out.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.stderr } });
  });

  it.each([
    ['an error status, whatever its body says', 'fails', /HTTP 500/],
    ['an answer that is not JSON', 'garbled', /no decision/],
    ['an answer without a decision', 'vague', /no decision/],
    ['a refusal of the session (a stage that is not running)', 'anything-else', /HTTP 403/],
  ])('refuses on %s', async (_label, command, reason) => {
    const out = await runShellGuard(call(command), env());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toMatch(reason);
  });

  it('refuses when the orchestrator does not answer in time, or cannot be reached', async () => {
    const started = Date.now();
    const late = await runShellGuard(call('slow'), env(), { deadlineMs: 300 });
    expect(late.exitCode).toBe(2);
    expect(late.stderr).toMatch(/did not answer within/);
    expect(Date.now() - started).toBeLessThan(1_500);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = await runShellGuard(call('allowed'), { ACC_TOOL_URL: `http://127.0.0.1:${port}`, ACC_TOOL_SESSION: 'x' });
    expect(unreachable.exitCode).toBe(2);
    expect(unreachable.stderr).toMatch(/could not be reached/);
  });

  it('refuses without a session, a readable call, or a call to a tool it guards', async () => {
    for (const bad of [{}, { ACC_TOOL_URL: url }, { ACC_TOOL_SESSION: 'x' }, { ACC_TOOL_URL: 'not a url', ACC_TOOL_SESSION: 'x' }]) {
      expect((await runShellGuard(call('allowed'), bad)).exitCode).toBe(2);
      expect((await runShellGuard(fileCall('Read', { file_path: 'allowed' }), bad)).exitCode).toBe(2);
    }
    seen.length = 0;
    for (const stdin of ['', 'not json', 'null', JSON.stringify({ tool_name: 'Bash', tool_input: {} }), call('allowed', 'Edit'), fileCall('WebFetch', { url: 'allowed' }), fileCall('Read', 'allowed'), fileCall('Grep', ['allowed']), fileCall('Glob', null)]) {
      const out = await runShellGuard(stdin, env());
      expect(out.exitCode, stdin).toBe(2);
      expect(out.stderr, stdin).toMatch(/could not be read/);
    }
    // None of them was even asked about.
    expect(seen).toEqual([]);
  });

  it("asks about a native file read with the tool, its input and the CLI's folder, and refuses with the Control Center's reason", async () => {
    seen.length = 0;
    const read = { file_path: 'allowed', offset: 10, limit: 20 };
    expect(await runShellGuard(fileCall('Read', read), env())).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(seen).toEqual([{ authorization: 'Bearer session-token', body: JSON.stringify({ tool: 'Read', input: read, cwd: ROOT }) }]);
    expect((await runShellGuard(fileCall('Grep', { pattern: 'auth-token', path: 'allowed' }), env())).exitCode).toBe(0);
    expect((await runShellGuard(fileCall('Glob', { pattern: '**/*.md', path: 'allowed' }), env())).exitCode).toBe(0);
    for (const [tool, input] of [['Read', { file_path: 'denied' }], ['Grep', { pattern: '.', path: 'denied' }], ['Glob', { pattern: '*', path: 'denied' }]] as const) {
      const out = await runShellGuard(fileCall(tool, input), env());
      expect(out.exitCode, tool).toBe(2);
      expect(out.stderr, tool).toBe('Refused by the AI Development Control Center: Reaches the Control Center itself.');
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, tool).toBe('deny');
    }
    for (const [label, input, reason] of [
      ['an error status', { file_path: 'fails' }, /HTTP 500/],
      ['an answer without a decision', { file_path: 'vague' }, /no decision/],
      ['a refusal of the session', { file_path: 'anything-else' }, /HTTP 403/],
    ] as const) {
      const out = await runShellGuard(fileCall('Read', input), env());
      expect(out.exitCode, label).toBe(2);
      expect(out.stderr, label).toMatch(reason);
    }
  });

  it('refuses a native file read when the orchestrator cannot be reached or answers late', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    for (const tool of ['Read', 'Grep', 'Glob']) {
      const out = await runShellGuard(fileCall(tool, { file_path: 'allowed', path: 'allowed', pattern: '*' }), { ACC_TOOL_URL: `http://127.0.0.1:${port}`, ACC_TOOL_SESSION: 'x' });
      expect(out.exitCode, tool).toBe(2);
      expect(out.stderr, tool).toMatch(/could not be reached/);
    }
    const late = await runShellGuard(fileCall('Read', { file_path: 'slow' }), env(), { deadlineMs: 300 });
    expect(late.exitCode).toBe(2);
    expect(late.stderr).toMatch(/did not answer within/);
  });

  // The built entry is this file bundled: run from source here, as the CLI would run it.
  const runHook = (stdin: string, hookEnv: Record<string, string>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'packages', 'agent-claude', 'src', 'shell-guard-hook.ts')], { cwd: ROOT, env: { ...process.env, ...hookEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });

  it('exits 2 with the reason, or 0 with nothing, as a process', async () => {
    const allowed = await runHook(call('allowed'), env());
    expect(allowed).toEqual({ code: 0, stdout: '', stderr: '' });
    const denied = await runHook(call('denied'), env());
    expect(denied.code).toBe(2);
    expect(denied.stderr).toContain('Reaches the Control Center itself.');
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    // No session in the environment: refused, never the exit code 1 of a crash.
    const bare = await runHook(call('allowed'), { ACC_TOOL_URL: '', ACC_TOOL_SESSION: '' });
    expect(bare.code).toBe(2);
    expect(bare.stderr).toMatch(/no Control Center session/);
  }, 60_000);
});
