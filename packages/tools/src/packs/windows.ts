import { powershellJson } from '@acc/executor';
import { redact } from '@acc/security';
import { z } from 'zod';
import { run } from '../detect.js';
import { failure, missing, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';

/**
 * Structured Windows diagnostics (V2 plan §27) via PowerShell, returning
 * JSON. Stopping a process is low risk only for processes this task started.
 */

async function ps<T>(ctx: OperationContext, script: string, timeoutMs = 30_000): Promise<T> {
  const shell = await ctx.shell('powershell');
  if (!shell) throw new Error('PowerShell is not available');
  return powershellJson<T>(shell, script, { cwd: ctx.cwd, env: ctx.env, timeoutMs, tempDir: ctx.tempDir });
}

function list<T>(value: T | T[] | null): T[] {
  return value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
}

async function guarded(fn: () => Promise<OperationResult>): Promise<OperationResult> {
  try {
    return await fn();
  } catch (error) {
    return failure('FAILED', redact((error as Error).message).slice(0, 500));
  }
}

const name = z.string().min(1).max(200).regex(/^[\w .*?-]+$/, 'Letters, digits, spaces and wildcards only');
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function windowsProvider(): ToolProvider {
  return {
    id: 'windows',
    name: 'Windows diagnostics',
    description: 'Processes, services, ports, system information and scheduled tasks through PowerShell.',
    category: 'windows',
    platforms: ['win32'],
    preference: 10,
    async detect(ctx) {
      const shell = await ctx.shell('powershell');
      return shell
        ? { installed: true, version: null, path: shell.executable, auth: { required: false, state: 'not_required', message: null }, message: shell.flavor === 'pwsh' ? 'via PowerShell 7' : 'via Windows PowerShell' }
        : missing('PowerShell is not available');
    },
    operations: [
      operation({
        id: 'network.port_owner',
        title: 'Who is using a port',
        description: 'The process listening on a local TCP port (or every listening port when none is given).',
        input: z.object({ port: z.number().int().min(1).max(65535).optional() }),
        level: 1,
        run: (input, ctx) =>
          guarded(async () => {
            const filter = input.port ? `-LocalPort ${input.port}` : '';
            const rows = list(
              await ps<Array<{ port: number; address: string; pid: number; process: string | null; path: string | null }> | null>(
                ctx,
                `Get-NetTCPConnection -State Listen ${filter} -ErrorAction SilentlyContinue | Sort-Object LocalPort -Unique | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{ port = $_.LocalPort; address = $_.LocalAddress; pid = $_.OwningProcess; process = $p.ProcessName; path = $p.Path } } | ConvertTo-Json -Compress -Depth 3`,
              ),
            );
            if (input.port && !rows.length) return { ok: true, summary: `Nothing is listening on port ${input.port}`, output: { owners: [] } };
            const owners = rows.map((r) => ({ ...r, state: 'Listen', taskOwned: ctx.processes?.isTaskOwnedPid(r.pid) ?? false }));
            return {
              ok: true,
              summary: input.port ? `Port ${input.port}: ${owners.map((o) => `${o.process ?? '?'} (pid ${o.pid}${o.taskOwned ? ', started by this task' : ''})`).join(', ')}` : `${owners.length} listening port(s)`,
              output: { owners },
            };
          }),
      }),
      operation({
        id: 'windows.processes',
        title: 'List processes',
        description: 'Running processes (optionally by name, wildcards allowed) with memory, CPU time and command line.',
        input: z.object({ name: name.optional(), limit: z.number().int().min(1).max(500).default(50) }),
        level: 1,
        run: (input, ctx) =>
          guarded(async () => {
            const filter = input.name ? `-Filter "Name like '${input.name.replace(/\*/g, '%').replace(/\?/g, '_').replace(/'/g, "''")}%'"` : '';
            const rows = list(
              await ps<any>(
                ctx,
                `Get-CimInstance Win32_Process ${filter} | Sort-Object WorkingSetSize -Descending | Select-Object -First ${input.limit} | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; name = $_.Name; memoryMb = [math]::Round($_.WorkingSetSize / 1MB, 1); started = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }; commandLine = $_.CommandLine } } | ConvertTo-Json -Compress -Depth 3`,
              ),
            ).map((p: any) => ({ ...p, commandLine: p.commandLine ? redact(String(p.commandLine)).slice(0, 500) : null, taskOwned: ctx.processes?.isTaskOwnedPid(p.pid) ?? false }));
            return { ok: true, summary: `${rows.length} process(es)`, output: { processes: rows } };
          }),
      }),
      operation({
        id: 'windows.services',
        title: 'List services',
        description: 'Windows services with status and start type (optionally by name).',
        input: z.object({ name: name.optional() }),
        level: 1,
        run: (input, ctx) =>
          guarded(async () => {
            const rows = list(
              await ps<any>(ctx, `Get-Service ${input.name ? `-Name ${psQuote(input.name)}` : ''} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = $_.Name; displayName = $_.DisplayName; status = [string]$_.Status; startType = [string]$_.StartType } } | ConvertTo-Json -Compress`),
            );
            return { ok: true, summary: `${rows.length} service(s)`, output: { services: rows } };
          }),
      }),
      operation({
        id: 'windows.system_info',
        title: 'System information',
        description: 'Windows version, build, uptime, CPU, memory and disks.',
        input: z.object({}),
        level: 1,
        run: (_input, ctx) =>
          guarded(async () => {
            const info = await ps<any>(
              ctx,
              `$os = Get-CimInstance Win32_OperatingSystem; $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID; sizeGb = [math]::Round($_.Size / 1GB, 1); freeGb = [math]::Round($_.FreeSpace / 1GB, 1) } }; [pscustomobject]@{ os = $os.Caption; version = $os.Version; build = $os.BuildNumber; uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1); cpu = $cpu.Name; cores = $cpu.NumberOfLogicalProcessors; memoryGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1); freeMemoryGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1); disks = @($disks) } | ConvertTo-Json -Compress -Depth 4`,
            );
            return { ok: true, summary: `${info.os} ${info.version} · ${info.cores} cores · ${info.memoryGb} GB`, output: info };
          }),
      }),
      operation({
        id: 'windows.env',
        title: 'Environment variables',
        description: 'Values of named environment variables for this user (secret-looking values are hidden).',
        input: z.object({ names: z.array(z.string().min(1).max(100).regex(/^[\w().-]+$/)).min(1).max(40) }),
        level: 1,
        async run(input, ctx) {
          const values: Record<string, string | null> = {};
          for (const n of input.names) {
            const key = Object.keys(ctx.env).find((k) => k.toUpperCase() === n.toUpperCase());
            const value = key ? (ctx.env[key] ?? null) : null;
            values[n] = value === null ? null : /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|SESSION|COOKIE/i.test(n) ? '[REDACTED]' : redact(value);
          }
          return { ok: true, summary: `${Object.values(values).filter((v) => v !== null).length} of ${input.names.length} set`, output: { values } };
        },
      }),
      operation({
        id: 'windows.scheduled_tasks',
        title: 'Scheduled tasks',
        description: 'Scheduled tasks (optionally under a folder path such as \\MyApp\\) with state and last result.',
        input: z.object({ path: z.string().max(200).regex(/^\\[\w \\.-]*$/).optional() }),
        level: 1,
        run: (input, ctx) =>
          guarded(async () => {
            const rows = list(
              await ps<any>(ctx, `Get-ScheduledTask ${input.path ? `-TaskPath ${psQuote(input.path)}` : ''} -ErrorAction SilentlyContinue | Select-Object -First 200 | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue; [pscustomobject]@{ name = $_.TaskName; path = $_.TaskPath; state = [string]$_.State; lastRun = if ($i.LastRunTime) { $i.LastRunTime.ToString('o') } else { $null }; lastResult = $i.LastTaskResult; nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null } } } | ConvertTo-Json -Compress`, 60_000),
            );
            return { ok: true, summary: `${rows.length} scheduled task(s)`, output: { tasks: rows } };
          }),
      }),
      operation({
        id: 'windows.tool_locations',
        title: 'Where is a program',
        description: 'Every location of a program on PATH (where.exe), to spot duplicate or shadowed installs.',
        input: z.object({ program: z.string().min(1).max(100).regex(/^[\w.-]+$/) }),
        level: 1,
        run: (input, ctx) =>
          guarded(async () => {
            const rows = list(await ps<string[] | string | null>(ctx, `@(Get-Command ${psQuote(input.program)} -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }) | ConvertTo-Json -Compress`));
            return { ok: rows.length > 0, summary: rows.length ? `${input.program}: ${rows.length} location(s)` : `${input.program} is not on PATH`, output: { locations: rows } };
          }),
      }),
      operation({
        id: 'windows.network_config',
        title: 'Network configuration',
        description: 'Adapters, IP addresses, gateways and DNS servers.',
        input: z.object({}),
        level: 1,
        run: (_input, ctx) =>
          guarded(async () => {
            const rows = list(
              await ps<any>(ctx, `Get-NetIPConfiguration | ForEach-Object { [pscustomobject]@{ adapter = $_.InterfaceAlias; ipv4 = @($_.IPv4Address.IPAddress); gateway = @($_.IPv4DefaultGateway.NextHop); dns = @($_.DNSServer.ServerAddresses) } } | ConvertTo-Json -Compress -Depth 4`),
            );
            return { ok: true, summary: `${rows.length} adapter(s)`, output: { adapters: rows } };
          }),
      }),
      operation({
        id: 'windows.kill_process',
        title: 'Stop a process',
        description: "Stop one process by id (and its children). Processes this task started stop at once; anyone else's needs your approval.",
        input: z.object({ pid: z.number().int().min(1) }),
        level: 2,
        classify: (input, ctx) =>
          ctx.isTaskOwnedPid?.(input.pid)
            ? { level: 2, reasons: ['Stops a process this task started'], effects: ['process'] }
            : { level: 4, risk: 'elevated', reasons: ['Stops a process this task did not start'], effects: ['process'] },
        run: (input, ctx) =>
          guarded(async () => {
            if (input.pid === process.pid) return failure('DENIED', 'Refusing to stop the Control Center itself');
            const r = await run('taskkill', ['/PID', String(input.pid), '/T', '/F'], { env: ctx.env, timeoutMs: 20_000 });
            if (r.code !== 0) return failure('FAILED', redact(r.stderr.trim() || r.stdout.trim()).slice(0, 300));
            return { ok: true, summary: `Stopped process ${input.pid} and its children` };
          }),
      }),
    ],
  };
}
