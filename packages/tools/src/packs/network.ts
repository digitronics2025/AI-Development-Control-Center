import dns from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod';
import { run } from '../detect.js';
import { builtinDetection, operation, type OperationContext, type ToolProvider } from '../sdk.js';

/**
 * Network diagnostics (V2 plan §28). DNS, TCP reachability, latency and
 * local port ownership — the questions behind "server failed to start",
 * "port already used" and "endpoint unavailable".
 */

const host = z.string().min(1).max(253).regex(/^[A-Za-z0-9.:[\]-]+$/, 'Not a host name or address');
const port = z.number().int().min(1).max(65535);

export function tcpConnect(hostname: string, portNumber: number, timeoutMs: number): Promise<{ ok: boolean; ms: number; error: string | null }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host: hostname, port: portNumber });
    const done = (ok: boolean, error: string | null) => {
      socket.destroy();
      resolve({ ok, ms: Math.round(performance.now() - started), error });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timed out'));
    socket.once('connect', () => done(true, null));
    socket.once('error', (e: NodeJS.ErrnoException) => done(false, e.code ?? e.message));
  });
}

export interface PortOwner {
  port: number;
  address: string;
  pid: number | null;
  process: string | null;
  state: string;
}

/** Listening sockets from `netstat` (portable fallback for port ownership). */
async function netstatOwners(ctx: OperationContext, portFilter: number | null): Promise<PortOwner[]> {
  if (process.platform === 'win32') {
    const r = await run('netstat', ['-ano', '-p', 'TCP'], { env: ctx.env, timeoutMs: 20_000 });
    const owners: PortOwner[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+(LISTENING)\s+(\d+)/i.exec(line);
      if (!m) continue;
      const p = Number(m[2]);
      if (portFilter !== null && p !== portFilter) continue;
      owners.push({ port: p, address: m[1]!, pid: Number(m[4]), process: null, state: 'Listen' });
    }
    return owners;
  }
  const r = await run('sh', ['-c', 'ss -ltnpH 2>/dev/null || netstat -ltnp 2>/dev/null'], { env: ctx.env, timeoutMs: 20_000 });
  const owners: PortOwner[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /(\S+):(\d+)\s+\S+\s*(?:users:\(\("([^"]+)",pid=(\d+))?/.exec(line.replace(/^LISTEN\s+\d+\s+\d+\s+/, ''));
    if (!m) continue;
    const p = Number(m[2]);
    if (portFilter !== null && p !== portFilter) continue;
    owners.push({ port: p, address: m[1]!, pid: m[4] ? Number(m[4]) : null, process: m[3] ?? null, state: 'Listen' });
  }
  return owners;
}

export function networkProviders(): ToolProvider[] {
  return [
    {
      id: 'network',
      name: 'Network (built-in)',
      description: 'DNS lookups, TCP checks and latency from Node.',
      category: 'network',
      builtin: true,
      async detect() {
        return builtinDetection();
      },
      operations: [
        operation({
          id: 'network.dns_lookup',
          title: 'DNS lookup',
          description: 'Resolve a host name (A/AAAA, and CNAME/TXT/MX when asked).',
          input: z.object({ host, types: z.array(z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'])).max(6).default(['A', 'AAAA']) }),
          level: 1,
          classify: () => ({ effects: ['network'] }),
          async run(input) {
            const records: Record<string, unknown> = {};
            const errors: string[] = [];
            for (const type of input.types) {
              try {
                records[type] = await dns.resolve(input.host, type);
              } catch (error) {
                errors.push(`${type}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
              }
            }
            const found = Object.values(records).some((v) => Array.isArray(v) && v.length);
            return { ok: found, summary: found ? `${input.host} resolves` : `${input.host} did not resolve (${errors.join(', ')})`, output: { records, errors }, networkTargets: [input.host] };
          },
        }),
        operation({
          id: 'network.tcp_check',
          title: 'TCP reachability',
          description: 'Can a TCP connection be opened to host:port? (Is the server up? Is a firewall in the way?)',
          input: z.object({ host: host.default('127.0.0.1'), port, timeoutMs: z.number().int().min(100).max(60_000).default(3000) }),
          level: 1,
          async run(input) {
            const r = await tcpConnect(input.host, input.port, input.timeoutMs);
            return { ok: r.ok, summary: r.ok ? `${input.host}:${input.port} accepts connections (${r.ms}ms)` : `${input.host}:${input.port} unreachable: ${r.error}`, output: r, evidence: [`tcp ${input.host}:${input.port} → ${r.ok ? 'open' : r.error}`] };
          },
        }),
        operation({
          id: 'network.latency',
          title: 'Latency',
          description: 'Median TCP connect time to host:port over several attempts.',
          input: z.object({ host, port: port.default(443), attempts: z.number().int().min(1).max(20).default(5) }),
          level: 1,
          classify: () => ({ effects: ['network'] }),
          async run(input) {
            const times: number[] = [];
            let failures = 0;
            for (let i = 0; i < input.attempts; i++) {
              const r = await tcpConnect(input.host, input.port, 5000);
              if (r.ok) times.push(r.ms);
              else failures++;
            }
            times.sort((a, b) => a - b);
            const median = times.length ? times[Math.floor(times.length / 2)]! : null;
            return { ok: times.length > 0, summary: median !== null ? `${input.host}:${input.port} median ${median}ms (${failures} failed)` : `${input.host}:${input.port} unreachable`, output: { medianMs: median, samples: times, failures } };
          },
        }),
      ],
    },
    {
      id: 'netstat',
      name: 'netstat',
      description: 'Port ownership from netstat/ss (fallback when PowerShell is unavailable).',
      category: 'network',
      preference: 50,
      async detect() {
        return builtinDetection('uses netstat');
      },
      builtin: true,
      operations: [
        operation({
          id: 'network.port_owner',
          title: 'Who is using a port',
          description: 'The process listening on a local TCP port (or every listening port when none is given).',
          input: z.object({ port: port.optional() }),
          level: 1,
          async run(input, ctx) {
            const owners = await netstatOwners(ctx, input.port ?? null);
            if (input.port && !owners.length) return { ok: true, summary: `Nothing is listening on port ${input.port}`, output: { owners } };
            return { ok: true, summary: input.port ? `Port ${input.port}: pid ${owners.map((o) => o.pid).join(', ')}` : `${owners.length} listening port(s)`, output: { owners } };
          },
        }),
      ],
    },
  ];
}

