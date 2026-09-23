import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type { ToolDetection } from './sdk.js';

/**
 * Environment discovery (V2 plan §36): the facts an agent needs before a
 * substantial task — machine, repository, toolchain, what is listening —
 * gathered cheaply from cached tool health instead of probing every binary.
 */

export interface EnvironmentReport {
  collectedAt: string;
  machine: { os: string; release: string; arch: string; cpus: number; cpuModel: string | null; memoryGb: number; freeMemoryGb: number; diskFreeGb: number | null; hostname: string };
  repository: { path: string; branch: string | null; dirtyFiles: number | null; packageManager: string | null; frameworks: string[]; projectType: string } | null;
  tools: Array<{ id: string; name: string; installed: boolean; version: string | null; auth: string | null }>;
  listeningPorts: Array<{ port: number; process: string | null; pid: number | null }>;
  taskProcesses: Array<{ name: string; port: number | null; status: string }>;
  agents: Array<{ id: string; state: string }>;
  mcpServers: Array<{ name: string; state: string; tools: number }>;
}

export interface EnvironmentInput {
  cwd: string | null;
  branch?: string | null;
  dirtyFiles?: number | null;
  tooling?: readonly string[];
  projectType?: string;
  tools: Array<{ id: string; name: string; detection: ToolDetection | undefined }>;
  listeningPorts?: EnvironmentReport['listeningPorts'];
  taskProcesses?: EnvironmentReport['taskProcesses'];
  agents?: EnvironmentReport['agents'];
  mcpServers?: EnvironmentReport['mcpServers'];
}

const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 10) / 10;

export async function collectEnvironment(input: EnvironmentInput): Promise<EnvironmentReport> {
  let diskFreeGb: number | null = null;
  try {
    const s = await statfs(input.cwd ?? os.homedir());
    diskFreeGb = round((s.bavail * s.bsize) / GB);
  } catch {
    /* statfs unsupported for this path */
  }
  const tooling = input.tooling ?? [];
  const pm = ['pnpm', 'npm', 'yarn', 'bun'].find((p) => tooling.includes(p)) ?? null;
  const frameworks = tooling.filter((t) => !['node', 'pnpm', 'npm', 'yarn', 'bun', 'typescript'].includes(t));
  return {
    collectedAt: new Date().toISOString(),
    machine: {
      os: os.type(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model?.trim() ?? null,
      memoryGb: round(os.totalmem() / GB),
      freeMemoryGb: round(os.freemem() / GB),
      diskFreeGb,
      hostname: os.hostname(),
    },
    repository: input.cwd
      ? { path: input.cwd, branch: input.branch ?? null, dirtyFiles: input.dirtyFiles ?? null, packageManager: pm, frameworks, projectType: input.projectType ?? 'unknown' }
      : null,
    tools: input.tools.map((t) => ({
      id: t.id,
      name: t.name,
      installed: Boolean(t.detection?.installed),
      version: t.detection?.version ?? null,
      auth: t.detection?.auth.required ? t.detection.auth.state : null,
    })),
    listeningPorts: input.listeningPorts ?? [],
    taskProcesses: input.taskProcesses ?? [],
    agents: input.agents ?? [],
    mcpServers: input.mcpServers ?? [],
  };
}

/** Compact Markdown for prompts and the environment artifact. */
export function environmentMarkdown(report: EnvironmentReport): string {
  const m = report.machine;
  const lines = [
    `- Machine: ${m.os} ${m.release} (${m.arch}), ${m.cpus} CPUs, ${m.memoryGb} GB RAM (${m.freeMemoryGb} free)${m.diskFreeGb !== null ? `, ${m.diskFreeGb} GB disk free` : ''}`,
  ];
  if (report.repository) {
    const r = report.repository;
    lines.push(`- Repository: ${r.path} · branch ${r.branch ?? 'unknown'}${r.dirtyFiles !== null ? ` · ${r.dirtyFiles} uncommitted file(s)` : ''} · ${r.projectType}${r.packageManager ? ` · ${r.packageManager}` : ''}${r.frameworks.length ? ` · ${r.frameworks.join(', ')}` : ''}`);
  }
  const installed = report.tools.filter((t) => t.installed).map((t) => `${t.name}${t.version ? ` ${t.version}` : ''}${t.auth && t.auth !== 'ok' ? ` (auth: ${t.auth})` : ''}`);
  const absent = report.tools.filter((t) => !t.installed).map((t) => t.name);
  if (installed.length) lines.push(`- Tools available: ${installed.join(', ')}`);
  if (absent.length) lines.push(`- Not installed: ${absent.join(', ')}`);
  if (report.listeningPorts.length) lines.push(`- Listening ports: ${report.listeningPorts.slice(0, 20).map((p) => `${p.port}${p.process ? ` (${p.process})` : ''}`).join(', ')}`);
  if (report.taskProcesses.length) lines.push(`- Task processes: ${report.taskProcesses.map((p) => `${p.name}${p.port ? ` :${p.port}` : ''} ${p.status}`).join(', ')}`);
  if (report.agents.length) lines.push(`- Agents: ${report.agents.map((a) => `${a.id} ${a.state}`).join(', ')}`);
  if (report.mcpServers.length) lines.push(`- MCP servers: ${report.mcpServers.map((s) => `${s.name} ${s.state} (${s.tools} tools)`).join(', ')}`);
  return lines.join('\n');
}
