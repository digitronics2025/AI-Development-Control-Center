import type { CloudNodeView } from '@acc/shared';

/** Local mode when the orchestrator injected its token into the page; otherwise the cloud. */
export function detectMode(doc: Pick<Document, 'querySelector'>): { mode: 'local'; token: string } | { mode: 'cloud' } {
  const token = doc.querySelector<HTMLMetaElement>('meta[name="acc-token"]')?.content ?? '';
  return token ? { mode: 'local', token } : { mode: 'cloud' };
}

const NODE_KEY = 'acc.selected-node';

/** The execution node the cloud dashboard shows; remembered per browser. */
export class NodeSelection {
  private selected: string | null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
    let stored: string | null;
    try {
      stored = this.storage?.getItem(NODE_KEY) ?? null;
    } catch {
      stored = null;
    }
    this.selected = stored;
  }

  get = (): string | null => this.selected;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  select(nodeId: string | null): void {
    if (nodeId === this.selected) return;
    this.selected = nodeId;
    try {
      if (nodeId) this.storage?.setItem(NODE_KEY, nodeId);
    } catch {
      /* private window: the choice lasts for this page only */
    }
    for (const l of this.listeners) l();
  }
}

/** Keep the stored choice if it still names a usable node; otherwise prefer an online one. */
export function pickNode(nodes: CloudNodeView[], current: string | null): string | null {
  const usable = nodes.filter((n) => n.status !== 'revoked');
  if (current && usable.some((n) => n.id === current)) return current;
  return (usable.find((n) => n.status === 'online') ?? usable[0])?.id ?? null;
}
