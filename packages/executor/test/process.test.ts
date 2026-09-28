import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { quoteWindowsArg, runProcess, runShell, which, windowsLaunch } from '../src/index.js';

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

  it('keeps a line whole across many chunks when the limit allows, including a split CRLF', async () => {
    const lines: string[] = [];
    const script =
      'const t="a".repeat(200000)+"\\r\\nb\\r\\n";let o=0;' +
      'const w=()=>{if(o>=t.length)return;const p=t.slice(o,o+4095);o+=p.length;process.stdout.write(p,w)};w()';
    await runProcess({
      command: node,
      args: ['-e', script],
      cwd: os.tmpdir(),
      env: process.env,
      maxLineLength: 1024 * 1024,
      onLine: (_s, l) => lines.push(l),
    }).done;
    expect(lines.map((l) => l.length)).toEqual([200000, 1]);
    expect(lines[1]).toBe('b');
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

describe('windows command lines (the agent relay, docs/systems/security.md#agent-os-boundary)', () => {
  const bs = '\\';
  const tricky = ['plain', '', 'two words', 'say "hi"', `C:${bs}dir with space${bs}`, `a${bs}${bs}"b`, '{"disableAllHooks":false,"hooks":{"x":"\\"C:/n.exe\\" \\"C:/h.js\\""}}', `trail${bs}`, 'tab\there', 'é — →'];

  it('quotes only what needs it, doubling backslashes before quotes', () => {
    expect(quoteWindowsArg('plain')).toBe('plain');
    expect(quoteWindowsArg('')).toBe('""');
    expect(quoteWindowsArg('two words')).toBe('"two words"');
    expect(quoteWindowsArg('say "hi"')).toBe(`"say ${bs}"hi${bs}""`);
    expect(quoteWindowsArg(`C:${bs}dir with space${bs}`)).toBe(`"C:${bs}dir with space${bs}${bs}"`);
    expect(quoteWindowsArg(`C:${bs}no${bs}space`)).toBe(`C:${bs}no${bs}space`);
    expect(quoteWindowsArg(`a${bs}${bs}"b`)).toBe(`"a${bs.repeat(5)}"b"`);
  });

  it.skipIf(process.platform !== 'win32')('reads back unchanged in the program that receives it', async () => {
    const out: string[] = [];
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    // Verbatim: the line is exactly what quoteWindowsArg wrote, as the relay hands it to Windows.
    const child = spawn(node, ['-e', script, ...tricky].map(quoteWindowsArg), { argv0: quoteWindowsArg(node), windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    await new Promise((resolve) => child.on('close', resolve));
    expect(JSON.parse(out.join(''))).toEqual(tricky);
  });

  it.skipIf(process.platform !== 'win32')('starts what runProcess starts: a program directly, a .cmd shim through cmd.exe verbatim', () => {
    const direct = windowsLaunch(node, ['-e', 'x y'], process.env);
    expect(direct).toEqual({ file: node, commandLine: '-e "x y"' });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-cmd-'));
    const shim = path.join(dir, 'tool.cmd');
    writeFileSync(shim, '@echo off\r\n');
    const viaCmd = windowsLaunch(shim, ['a b', '{"k":"v"}'], process.env);
    expect(path.basename(viaCmd.file).toLowerCase()).toBe('cmd.exe');
    expect(viaCmd.commandLine.startsWith('/d /s /c "')).toBe(true);
    expect(viaCmd.commandLine).toContain('tool.cmd');
  });
});
