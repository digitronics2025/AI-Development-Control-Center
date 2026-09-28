import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveShell, type ShellInfo } from '@acc/executor';
import type { IPty } from 'node-pty';
import { PtyManager, PtySession } from '../src/index.js';

const powershell = await resolveShell('powershell');

// Fake credentials are assembled at runtime so no credential-shaped literal lives in the repository.
const fake = (...parts: string[]) => parts.join('');

/** A pseudo-terminal whose output the test writes chunk by chunk. */
function standIn(): { session: PtySession; output: (chunk: string) => void; exit: (code: number) => void } {
  let onData: (data: string) => void = () => undefined;
  let onExit: (e: { exitCode: number }) => void = () => undefined;
  const pty = {
    pid: 1,
    onData: (listener: (data: string) => void) => ((onData = listener), { dispose: () => undefined }),
    onExit: (listener: (e: { exitCode: number }) => void) => ((onExit = listener), { dispose: () => undefined }),
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
  } as unknown as IPty;
  const shell = { kind: 'bash', flavor: 'bash', executable: 'bash' } as unknown as ShellInfo;
  const session = new PtySession(pty, { shell, cwd: os.tmpdir(), env: {}, owner: { taskId: null, kind: 'agent' } });
  return { session, output: (chunk) => onData(chunk), exit: (code) => onExit({ exitCode: code }) };
}

describe('PtySession redaction across chunks', () => {
  const token = fake('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789');

  it('redacts a secret the terminal splits across two chunks', async () => {
    const { session, output } = standIn();
    output(`token: ${token.slice(0, 14)}`);
    output(`${token.slice(14)} done\r\n`);
    const text = session.read().output;
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(token.slice(0, 14));
    expect(text).not.toContain(token.slice(14));
    expect(text).toContain('done');
  });

  it('holds only the line in progress, and shows it after a moment (a prompt)', async () => {
    const { session, output } = standIn();
    output('first line\r\nName: ');
    expect(session.read().output).toBe('first line\r\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(session.read().output).toBe('first line\r\nName: ');
  });

  it('without the hold, each half would have been shown as it came', async () => {
    // The same split, the second half arriving after the hold ran out: each half is judged alone.
    const { session, output } = standIn();
    output(`token: ${token.slice(0, 14)}`);
    await new Promise((r) => setTimeout(r, 150));
    output(`${token.slice(14)}\r\n`);
    expect(session.read().output).toContain(token.slice(14));
  });

  it('keeps a private key hidden when it spans chunks, and shows the last line at exit', () => {
    const { session, output, exit } = standIn();
    const marker = (edge: string) => fake('-----', edge, ' RSA PRIVATE', ' KEY-----');
    output(`${marker('BEGIN')}\r\nkey-line-one\r\n`);
    output(`key-line-two\r\n${marker('END')}\r\nafter\r\nprompt> `);
    exit(0);
    const text = session.read().output;
    expect(text).not.toMatch(/key-line-(one|two)/);
    expect(text).toContain('after\r\n');
    expect(text.endsWith('prompt> ')).toBe(true);
    expect(session.read().exited).toBe(true);
  });
});

async function until(fn: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!powershell)('PtyManager (real ConPTY)', () => {
  it('runs an interactive shell: input, streamed output, cursor reads, resize and exit', async () => {
    const manager = new PtyManager();
    const session = await manager.create({ shell: powershell!, cwd: os.tmpdir(), env: process.env, owner: { taskId: 'TASK-1', kind: 'agent' } });
    const events: string[] = [];
    session.onEvent((e) => events.push(e.type));
    session.write('Write-Output ("pty-" + (6 * 7))\r');
    await until(() => session.read().output.includes('pty-42'));
    const first = session.read();
    session.write('$x = Read-Host "Name"\r');
    await until(() => session.read(first.cursor).output.includes('Name'));
    session.write('Ada\r');
    session.write('Write-Output "hello $x"\r');
    await until(() => session.read(first.cursor).output.includes('hello Ada'));
    session.resize(100, 40);
    expect(session.snapshot()).toMatchObject({ cols: 100, rows: 40, taskId: 'TASK-1', ownerKind: 'agent' });
    session.write('exit 3\r');
    await until(() => session.exited);
    expect(session.read().exitCode).toBe(3);
    expect(events).toContain('exit');
  }, 60_000);

  it('kills the whole tree on close and for a finished task', async () => {
    const manager = new PtyManager({ maxSessions: 2 });
    const a = await manager.create({ shell: powershell!, cwd: os.tmpdir(), env: process.env, owner: { taskId: 'TASK-2', kind: 'agent' } });
    await manager.create({ shell: powershell!, cwd: os.tmpdir(), env: process.env, owner: { taskId: 'TASK-3', kind: 'operator' } });
    await expect(manager.create({ shell: powershell!, cwd: os.tmpdir(), env: process.env, owner: { taskId: null, kind: 'operator' } })).rejects.toThrow(/At most 2/);
    a.write('Start-Sleep -Seconds 60\r');
    expect(await manager.killForTask('TASK-2')).toBe(1);
    await until(() => a.exited);
    await manager.killAll();
    expect(manager.list().every((s) => s.exited)).toBe(true);
  }, 60_000);

  it('keeps a bounded history and reports truncation', async () => {
    const manager = new PtyManager();
    const s = await manager.create({ shell: powershell!, cwd: os.tmpdir(), env: process.env, historyChars: 2000, owner: { taskId: null, kind: 'operator' } });
    s.write('1..400 | ForEach-Object { "line $_ of output" }\r');
    await until(() => s.read().output.includes('line 400 of output'));
    const all = s.read(0);
    expect(all.truncated).toBe(true);
    expect(all.output.length).toBeLessThan(6000);
    await s.kill();
  }, 60_000);
});
