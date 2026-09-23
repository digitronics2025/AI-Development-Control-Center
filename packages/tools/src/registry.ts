import type { PermissionLevel } from '@acc/shared';
import type { ToolCategory, ToolOperation, ToolProvider } from './sdk.js';

export interface RegisteredOperation {
  provider: ToolProvider;
  operation: ToolOperation;
}

/** Summary of one capability across the providers that offer it. */
export interface CapabilityInfo {
  id: string;
  title: string;
  description: string;
  category: ToolCategory;
  level: PermissionLevel;
  providers: string[];
}

/**
 * Central registry of providers and the capabilities they offer (V2 plan §8).
 * Pure bookkeeping: detection, health and routing live elsewhere.
 */
export class ToolRegistry {
  private readonly providers = new Map<string, ToolProvider>();
  private readonly byCapability = new Map<string, RegisteredOperation[]>();

  register(provider: ToolProvider): void {
    if (this.providers.has(provider.id)) this.unregister(provider.id);
    this.providers.set(provider.id, provider);
    for (const operation of provider.operations) {
      if (!/^[a-z][a-z0-9_]*(?:\.[a-z0-9_-]+)+$/.test(operation.id)) throw new Error(`Invalid capability id "${operation.id}" in ${provider.id}`);
      const list = this.byCapability.get(operation.id) ?? [];
      list.push({ provider, operation });
      this.byCapability.set(operation.id, list);
    }
  }

  unregister(providerId: string): boolean {
    const provider = this.providers.get(providerId);
    if (!provider) return false;
    this.providers.delete(providerId);
    for (const [id, list] of this.byCapability) {
      const kept = list.filter((r) => r.provider.id !== providerId);
      if (kept.length) this.byCapability.set(id, kept);
      else this.byCapability.delete(id);
    }
    return true;
  }

  provider(id: string): ToolProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(filter: { category?: ToolCategory; platform?: NodeJS.Platform } = {}): ToolProvider[] {
    return [...this.providers.values()].filter(
      (p) => (!filter.category || p.category === filter.category) && (!filter.platform || !p.platforms || p.platforms.includes(filter.platform)),
    );
  }

  /** Every provider/operation pair offering a capability. */
  offering(capabilityId: string): RegisteredOperation[] {
    return this.byCapability.get(capabilityId) ?? [];
  }

  hasCapability(capabilityId: string): boolean {
    return this.byCapability.has(capabilityId);
  }

  capabilities(): CapabilityInfo[] {
    return [...this.byCapability.entries()]
      .map(([id, list]) => {
        const first = list[0]!;
        return {
          id,
          title: first.operation.title,
          description: first.operation.description,
          category: first.provider.category,
          level: Math.min(...list.map((r) => r.operation.level)) as PermissionLevel,
          providers: list.map((r) => r.provider.id),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Capabilities whose id, title or description contain every word of the query. */
  search(query: string, limit = 20): CapabilityInfo[] {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    if (!words.length) return [];
    const scored = this.capabilities()
      .map((c) => {
        const hay = `${c.id} ${c.title} ${c.description}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        const idHits = words.filter((w) => c.id.includes(w)).length;
        return { c, score: hits * 2 + idHits };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id));
    return scored.slice(0, limit).map((s) => s.c);
  }
}
