import type { RegisteredOperation, ToolRegistry } from './registry.js';
import type { ToolDetection } from './sdk.js';

export interface RouteRequest {
  capability: string;
  platform?: NodeJS.Platform;
  /** Detection results by provider id (cached health). */
  detection: (providerId: string) => ToolDetection | undefined;
  /** Provider the caller asked for (e.g. `shell: 'bash'`), honoured when it can serve. */
  prefer?: string | null;
  /** Recent failures per provider in this task: a provider that keeps failing is tried last. */
  failures?: ReadonlyMap<string, number>;
}

export type RouteDecision =
  | { ok: true; route: RegisteredOperation; reason: string; alternatives: string[] }
  | { ok: false; code: 'UNKNOWN_CAPABILITY' | 'NOT_INSTALLED' | 'PLATFORM'; reason: string; alternatives: string[] };

/**
 * The Tool Router (V2 plan §9): maps a capability to the provider that should
 * serve it here and now, and says why. Agents never need to know which
 * executable implements `network.port_owner` on this machine.
 */
export class ToolRouter {
  constructor(private readonly registry: ToolRegistry) {}

  route(request: RouteRequest): RouteDecision {
    const platform = request.platform ?? process.platform;
    const offered = this.registry.offering(request.capability);
    if (!offered.length) {
      const similar = this.registry.search(request.capability.replace(/[._]/g, ' '), 5).map((c) => c.id);
      return {
        ok: false,
        code: 'UNKNOWN_CAPABILITY',
        reason: `No tool provides "${request.capability}".${similar.length ? ` Similar: ${similar.join(', ')}.` : ''}`,
        alternatives: similar,
      };
    }
    const onPlatform = offered.filter((r) => !r.provider.platforms || r.provider.platforms.includes(platform));
    if (!onPlatform.length) {
      return {
        ok: false,
        code: 'PLATFORM',
        reason: `"${request.capability}" is only available on ${[...new Set(offered.flatMap((r) => r.provider.platforms ?? []))].join(', ')}.`,
        alternatives: [],
      };
    }
    const installed = onPlatform.filter((r) => r.provider.builtin || request.detection(r.provider.id)?.installed);
    if (!installed.length) {
      const names = onPlatform.map((r) => `${r.provider.name}${request.detection(r.provider.id)?.message ? ` (${request.detection(r.provider.id)!.message})` : ''}`);
      return { ok: false, code: 'NOT_INSTALLED', reason: `"${request.capability}" needs ${names.join(' or ')}, which is not installed.`, alternatives: [] };
    }
    const failures = request.failures ?? new Map<string, number>();
    const ranked = [...installed].sort(
      (a, b) =>
        Number(b.provider.id === request.prefer) - Number(a.provider.id === request.prefer) ||
        (failures.get(a.provider.id) ?? 0) - (failures.get(b.provider.id) ?? 0) ||
        (a.provider.preference ?? 50) - (b.provider.preference ?? 50) ||
        a.provider.id.localeCompare(b.provider.id),
    );
    const chosen = ranked[0]!;
    const version = request.detection(chosen.provider.id)?.version;
    const why: string[] = [];
    if (request.prefer && chosen.provider.id === request.prefer) why.push('requested');
    else if (installed.length === 1) why.push(onPlatform.length > 1 ? 'the only installed provider' : 'the only provider');
    else why.push('preferred provider');
    if ((failures.get(chosen.provider.id) ?? 0) === 0 && [...failures.values()].some((n) => n > 0)) why.push('others failed earlier in this task');
    if (request.prefer && chosen.provider.id !== request.prefer) why.push(`${request.prefer} is not available`);
    return {
      ok: true,
      route: chosen,
      reason: `${chosen.provider.name}${version ? ` ${version}` : ''} for ${request.capability}: ${why.join(', ')}${platform === 'win32' ? ' on Windows' : ''}`,
      alternatives: ranked.slice(1).map((r) => r.provider.id),
    };
  }
}
