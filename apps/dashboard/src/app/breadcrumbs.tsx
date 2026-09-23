import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface Crumb {
  label: string;
  to?: string;
}

const Ctx = createContext<{ crumbs: Crumb[]; setCrumbs: (c: Crumb[]) => void } | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  return <Ctx.Provider value={{ crumbs, setCrumbs }}>{children}</Ctx.Provider>;
}

export function useCrumbs(): Crumb[] {
  return useContext(Ctx)?.crumbs ?? [];
}

/** Pages declare their breadcrumb and document title (stable context, design.md §2.4). */
export function useBreadcrumb(crumbs: Crumb[]): void {
  const ctx = useContext(Ctx);
  const serialized = JSON.stringify(crumbs);
  useEffect(() => {
    const parsed = JSON.parse(serialized) as Crumb[];
    ctx?.setCrumbs(parsed);
    document.title = `${parsed.map((c) => c.label).reverse().join(' · ')} — AI Development Control Center`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized crumbs
  }, [serialized]);
}
