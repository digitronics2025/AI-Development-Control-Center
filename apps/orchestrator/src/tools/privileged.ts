import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '@acc/executor';
import type { PrivilegedHost } from '@acc/tools';

/**
 * Client of the privileged helper (V2 plan §35, scripts/windows/privileged-helper.ps1).
 * Writes one signed request, starts the helper through UAC (`-Verb RunAs`),
 * waits for its result file. The helper re-validates everything itself, so
 * this side only packages the request.
 */
export class PrivilegedHelper implements PrivilegedHost {
  constructor(
    private readonly dataDir: string,
    private readonly scriptPath: string,
  ) {}

  private key(): Buffer {
    const file = path.join(this.dataDir, 'privileged-key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  }

  /** Sign a request and write it to disk; returns its path. */
  prepare(operation: string, params: Record<string, unknown>): string {
    const dir = path.join(this.dataDir, 'privileged');
    mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ id: randomUUID(), operation, params, issuedAt: new Date().toISOString() });
    const signature = createHmac('sha256', this.key()).update(payload, 'utf8').digest('base64');
    const file = path.join(dir, `request-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(file, JSON.stringify({ operation, payload, signature }), { mode: 0o600 });
    return file;
  }

  private async execute(file: string, validateOnly: boolean, elevate: boolean): Promise<{ ok: boolean; message: string }> {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helperArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-RequestFile', file, ...(validateOnly ? ['-ValidateOnly'] : [])];
    const quoted = helperArgs.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const args = elevate
      ? ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath '${powershell}' -ArgumentList @(${quoted}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`]
      : helperArgs;
    const r = await runProcess({ command: powershell, args, cwd: this.dataDir, env: { ...process.env, ACC_DATA_DIR: this.dataDir }, timeoutMs: 15 * 60_000 }).done;
    const resultFile = `${file}.result.json`;
    try {
      if (!existsSync(resultFile)) return { ok: false, message: r.exitCode === 1 && elevate ? 'The administrator prompt was declined or failed' : `The helper did not report a result (exit ${r.exitCode})` };
      const text = readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(text) as { ok: boolean; message: string };
      return { ok: Boolean(parsed.ok), message: String(parsed.message) };
    } finally {
      rmSync(resultFile, { force: true });
      rmSync(file, { force: true });
    }
  }

  /** Check a request with the helper's own validation, without elevation or effects. */
  validate(operation: string, params: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') return Promise.resolve({ ok: false, message: 'The privileged helper exists on Windows only' });
    return this.execute(this.prepare(operation, params), true, false);
  }

  run(operation: string, params: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') return Promise.resolve({ ok: false, message: 'The privileged helper exists on Windows only' });
    return this.execute(this.prepare(operation, params), false, true);
  }
}
