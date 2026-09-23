import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveShell } from '@acc/executor';
import { PtyManager } from '../src/index.js';

const powershell = await resolveShell('powershell');

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
