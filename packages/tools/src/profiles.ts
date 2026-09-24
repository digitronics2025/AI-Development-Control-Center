/**
 * Capability profiles (V2 plan §5.3, §37): which capabilities an agent sees
 * for a kind of task. Many tools exist; a stage is shown only the relevant
 * few, and anything else it asks for goes through escalation.
 */

export const PROFILE_IDS = ['analysis', 'general', 'web-development', 'cloudflare-worker', 'android-development', 'python', 'operator'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export interface CapabilityProfile {
  id: ProfileId;
  title: string;
  description: string;
  /** Capability patterns: exact ids or `area.*`. Order matters: the profile's speciality comes first, and a list over the cap keeps the front. */
  include: string[];
}

const CORE = ['fs.*', 'git.status', 'git.diff', 'git.log', 'git.show', 'git.branch_list', 'environment.*', 'checkpoint.list', 'tools.*'];
const INSPECT = ['network.*', 'windows.processes', 'windows.port_owner', 'windows.system_info', 'windows.services', 'process.list', 'process.logs', 'http.*', 'web.*'];
/** Looking at pages without changing them: open, look, read logs, close. */
const LOOK = ['browser.check_page', 'browser.screenshot', 'browser.open', 'browser.snapshot', 'browser.logs', 'browser.close'];
const DEVELOP = ['shell.*', 'process.*', 'terminal.*', 'node.*', 'checkpoint.*', 'git.*', 'editor.*'];

export const PROFILES: Record<ProfileId, CapabilityProfile> = {
  analysis: {
    id: 'analysis',
    title: 'Analysis',
    description: 'Read the repository and inspect the environment; nothing that changes state.',
    include: [...CORE, ...INSPECT, 'github.pr_list', 'github.pr_view', 'github.issue_list', 'github.issue_view', 'github.run_list', ...LOOK],
  },
  general: {
    id: 'general',
    title: 'General development',
    description: 'Files, Git, shells and local processes for any repository.',
    include: [...CORE, ...INSPECT, ...DEVELOP, ...LOOK, 'github.*', 'python.*'],
  },
  'web-development': {
    id: 'web-development',
    title: 'Web development',
    description: 'Node tooling, local servers, browser checks and HTTP tests.',
    include: ['browser.*', 'verify.*', ...CORE, ...INSPECT, ...DEVELOP, 'github.*'],
  },
  'cloudflare-worker': {
    id: 'cloudflare-worker',
    title: 'Cloudflare Worker',
    description: 'Node tooling plus Wrangler, D1, R2 and HTTP checks.',
    include: ['cloudflare.*', 'credential.generate', 'database.*', 'browser.*', 'verify.*', ...CORE, ...INSPECT, ...DEVELOP, 'github.*'],
  },
  'android-development': {
    id: 'android-development',
    title: 'Android development',
    description: 'Gradle, ADB, logcat and device screenshots.',
    include: ['android.*', ...CORE, ...INSPECT, ...DEVELOP, 'github.*'],
  },
  python: {
    id: 'python',
    title: 'Python',
    description: 'Python and pip/uv tooling with the usual file and Git tools.',
    include: ['python.*', 'database.*', ...CORE, ...INSPECT, ...DEVELOP, 'github.*'],
  },
  operator: {
    id: 'operator',
    title: 'Operator (everything)',
    description: 'Every capability; still subject to permission levels and approvals.',
    include: ['*'],
  },
};

export function matchesPattern(capability: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return capability.startsWith(pattern.slice(0, -1));
  return capability === pattern;
}

export function profileIncludes(profile: CapabilityProfile | ProfileId, capability: string): boolean {
  const p = typeof profile === 'string' ? PROFILES[profile] : profile;
  // MCP capabilities are opted in per server, never by a wildcard profile entry other than operator.
  if (capability.startsWith('mcp.') && p.id !== 'operator') return p.include.some((pattern) => pattern.startsWith('mcp.') && matchesPattern(capability, pattern));
  return p.include.some((pattern) => matchesPattern(capability, pattern));
}

/**
 * Where a capability sits in a profile's listing order: the index of the first
 * pattern that includes it, or the end of the list when it is not included
 * (an escalated capability). Lower comes first.
 */
export function profileRank(profile: CapabilityProfile | ProfileId, capability: string): number {
  const p = typeof profile === 'string' ? PROFILES[profile] : profile;
  if (!profileIncludes(p, capability)) return p.include.length;
  const i = p.include.findIndex((pattern) => matchesPattern(capability, pattern));
  return i === -1 ? p.include.length : i;
}

/**
 * Pick a profile from what the repository contains. Stage permission levels
 * still decide what may run; a Level 1 stage uses `analysis` regardless.
 */
export function profileForRepository(tooling: readonly string[], permissionLevel: number): ProfileId {
  if (permissionLevel <= 1) return 'analysis';
  const has = (t: string) => tooling.includes(t);
  if (has('wrangler')) return 'cloudflare-worker';
  if (has('gradle') || has('android')) return 'android-development';
  if (has('react') || has('vite') || has('next') || has('@playwright/test')) return 'web-development';
  if (has('python')) return 'python';
  return 'general';
}
