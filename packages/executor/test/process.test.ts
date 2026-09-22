import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { runProcess, runShell, which } from '../src/index.js';

const node = process.execPath;

describe('runProcess', () => {
  it('captures stdout, stderr, exit code and respects cwd', async () => {
    const lines: Array<[string, string]> = [];
    const cwd = os.tmpdir();
    const handle = runProcess({
      command: node,
      args: ['-e', 'console.log(process.cwd()); console.error("oops"); process.exit(3)'],
      cwd,
      env: process.env,
      onLine: (stream, line) => lines.push([stream, line]),
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(3);
    expect(lines).toContainEqual(['stderr', 'oops']);
    const reported = lines.find(([s]) => s === 'stdout')![1];
    expect(reported.toLowerCase()).toBe(cwd.toLowerCase().replace(/[\\/]$/, ''));
  });

  it('passes stdin without a shell', async () => {
    const lines: string[] = [];
    const handle = runProcess({
      command: node,
      args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d.toUpperCase()))'],
      cwd: os.tmpdir(),
      env: process.env,
      stdin: 'hello & "quotes" | pipes',
      onLine: (_s, line) => lines.push(line),
    });
    await handle.done;
    expect(lines).toEqual(['HELLO & "QUOTES" | PIPES']);
  });

  it('cancels a running process tree', async () => {
    const handle = runProcess({
      command: node,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: os.tmpdir(),
      env: process.env,
    });
    setTimeout(() => void handle.cancel(), 200);
    const result = await handle.done;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('times out', async () => {
    const handle = runProcess({
      command: node,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: os.tmpdir(),
      env: process.env,
      timeoutMs: 300,
    });
    const result = await handle.done;
    expect(result.timedOut).toBe(true);
  });

  it('reports spawn errors for missing executables', async () => {
    const result = await runProcess({ command: 'definitely-not-a-real-binary-xyz', cwd: os.tmpdir(), env: process.env }).done;
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    expect(result.spawnError !== null || result.exitCode !== 0).toBe(true);
  });

  it('splits very long lines', async () => {
    const lines: string[] = [];
    await runProcess({
      command: node,
      args: ['-e', 'process.stdout.write("x".repeat(25))'],
      cwd: os.tmpdir(),
      env: process.env,
      maxLineLength: 10,
      onLine: (_s, l) => lines.push(l),
    }).done;
    expect(lines).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });
});

describe('runShell', () => {
  it('runs a user command line through the platform shell', async () => {
    const lines: string[] = [];
    const result = await runShell({ commandLine: 'echo shell-ok', cwd: os.tmpdir(), env: process.env, onLine: (_s, l) => lines.push(l) })
      .done;
    expect(result.exitCode).toBe(0);
    expect(lines.join('\n')).toContain('shell-ok');
  });
});

describe('which', () => {
  it('finds node on PATH and returns null for unknown binaries', async () => {
    expect(await which('node')).toBeTruthy();
    expect(await which('definitely-not-a-real-binary-xyz')).toBeNull();
  });
});
