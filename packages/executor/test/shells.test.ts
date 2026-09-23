import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { captureScript, powershellJson, resolveShell, runScript } from '../src/index.js';

/**
 * Real shells on this machine. Each block skips itself when its shell is not
 * installed, so the suite also runs on Linux CI.
 */
const powershell = await resolveShell('powershell');
const cmd = await resolveShell('cmd');
const bash = await resolveShell('bash');

describe.skipIf(!powershell)('PowerShell', () => {
  it('runs multi-line scripts with structured JSON output', async () => {
    const value = await powershellJson<{ sum: number; items: string[] }>(
      powershell!,
      ['$items = @("a", "b")', 'if ($items.Count -eq 2) {', '  $sum = 1 + 2', '}', '[pscustomobject]@{ sum = $sum; items = $items } | ConvertTo-Json -Compress'].join('\n'),
    );
    expect(value).toEqual({ sum: 3, items: ['a', 'b'] });
  });

  it('streams stdout and stderr, passes arguments and reports the exit code', async () => {
    const lines: Array<[string, string]> = [];
    const handle = runScript({
      shell: powershell!,
      script: 'Write-Output "hello $($args[0])"\n[Console]::Error.WriteLine("warn")\nexit 4',
      args: ['world'],
      cwd: os.tmpdir(),
      env: process.env,
      onLine: (s, l) => lines.push([s, l]),
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(4);
    expect(lines).toContainEqual(['stdout', 'hello world']);
    expect(lines).toContainEqual(['stderr', 'warn']);
  });

  it('reads stdin and keeps UTF-8 intact', async () => {
    const run = await captureScript({ shell: powershell!, script: '$in = [Console]::In.ReadToEnd()\nWrite-Output ("got " + $in.Trim() + " é")', stdin: 'piped', cwd: os.tmpdir(), env: process.env });
    expect(run.stdout).toBe('got piped é');
  });

  it('times out and kills the process tree', async () => {
    const started = Date.now();
    const handle = runScript({ shell: powershell!, script: 'Start-Sleep -Seconds 30', cwd: os.tmpdir(), env: process.env, timeoutMs: 1500 });
    const result = await handle.done;
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('cancels on request', async () => {
    const handle = runScript({ shell: powershell!, script: 'Start-Sleep -Seconds 30', cwd: os.tmpdir(), env: process.env });
    setTimeout(() => void handle.cancel(), 800);
    const result = await handle.done;
    expect(result.cancelled).toBe(true);
  }, 20_000);
});

describe.skipIf(!cmd)('CMD', () => {
  it('runs a batch script with arguments', async () => {
    const run = await captureScript({ shell: cmd!, script: 'echo first %1\necho second', args: ['arg'], cwd: os.tmpdir(), env: process.env });
    expect(run.result.exitCode).toBe(0);
    expect(run.stdout.split('\n').map((l) => l.trim())).toEqual(['first arg', 'second']);
  });
});

describe.skipIf(!bash)('Bash', () => {
  it('runs a POSIX script and never resolves to the WSL launcher', async () => {
    expect(bash!.executable.toLowerCase()).not.toMatch(/system32[\\/]bash\.exe$/);
    const run = await captureScript({ shell: bash!, script: 'for i in 1 2; do echo "n=$i"; done\necho "arg=$1"', args: ['x'], cwd: os.tmpdir(), env: process.env });
    expect(run.result.exitCode).toBe(0);
    expect(run.stdout.split('\n')).toEqual(['n=1', 'n=2', 'arg=x']);
  });
});
