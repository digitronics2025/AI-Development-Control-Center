import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Command } from '@acc/ui';

interface CommandRegistry {
  pageCommands: Command[];
  register: (owner: symbol, commands: Command[]) => void;
  unregister: (owner: symbol) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

const Ctx = createContext<CommandRegistry | null>(null);

export function CommandProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Map<symbol, Command[]>>(new Map());
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Stable identities: consumers depend on these in effects, so they must
  // never change when the registry itself changes (that would loop).
  const register = useCallback((owner: symbol, commands: Command[]) => setEntries((m) => new Map(m).set(owner, commands)), []);
  const unregister = useCallback(
    (owner: symbol) =>
      setEntries((m) => {
        if (!m.has(owner)) return m;
        const next = new Map(m);
        next.delete(owner);
        return next;
      }),
    [],
  );
  const pageCommands = useMemo(() => [...entries.values()].flat(), [entries]);
  const value = useMemo<CommandRegistry>(
    () => ({ pageCommands, register, unregister, paletteOpen, setPaletteOpen }),
    [pageCommands, register, unregister, paletteOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCommandRegistry(): CommandRegistry {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCommandRegistry must be used inside <CommandProvider>');
  return ctx;
}

/**
 * Pages add context commands (e.g. "Pause current task") to the palette
 * while mounted, so commands are filtered by context (design.md §15).
 */
export function usePageCommands(commands: Command[]): void {
  const { register, unregister } = useCommandRegistry();
  const owner = useRef(Symbol('page-commands'));
  const latest = useRef(commands);
  useEffect(() => {
    latest.current = commands;
  });
  // Re-register only when the set of commands changes, not on every render.
  const signature = commands.map((c) => `${c.id}:${c.label}`).join('|');
  useEffect(() => {
    const id = owner.current;
    register(
      id,
      latest.current.map((c) => ({ ...c, onSelect: () => latest.current.find((x) => x.id === c.id)?.onSelect() })),
    );
    return () => unregister(id);
  }, [signature, register, unregister]);
}
