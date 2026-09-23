import { Search, type LucideIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn.js';
import { Kbd } from '../primitives/misc.js';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon?: LucideIcon;
  hint?: string;
  keywords?: string;
  onSelect: () => void;
}

/**
 * Ctrl/Cmd+K command palette (design.md §15). The caller passes only the
 * commands valid in the current context; destructive actions open their
 * normal confirmation instead of running directly.
 */
export function CommandPalette({ open, onOpenChange, commands }: { open: boolean; onOpenChange: (open: boolean) => void; commands: Command[] }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.group} ${c.keywords ?? ''} ${c.hint ?? ''}`.toLowerCase().includes(q));
  }, [commands, query]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onOpenChange(false);
    setQuery('');
    // Let the dialog close and return focus before the command navigates or opens another overlay.
    window.setTimeout(command.onSelect, 0);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(filtered[active]);
    }
  };

  let lastGroup = '';
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
        setActive(0);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-[calc(100vw-32px)] max-w-[600px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-modal">
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Type to filter commands, use the arrow keys to choose, Enter to run.</DialogPrimitive.Description>
          <div className="flex items-center gap-2 border-b border-border-subtle px-4">
            <Search size={18} className="text-fg-secondary" aria-hidden />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? `${listId}-${filtered[active]!.id}` : undefined}
              aria-label="Search commands"
              placeholder="Type a command or search…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="h-12 w-full bg-transparent text-body text-fg outline-none placeholder:text-fg-secondary"
            />
            <Kbd>Esc</Kbd>
          </div>
          <ul id={listId} role="listbox" aria-label="Commands" className="min-h-0 overflow-y-auto p-2">
            {filtered.length === 0 ? <li className="px-3 py-6 text-center text-body text-fg-secondary">No matching commands</li> : null}
            {filtered.map((command, index) => {
              const Icon = command.icon;
              const header = command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              return (
                <li key={command.id} role="presentation">
                  {header ? (
                    <div role="presentation" className="px-3 pb-1 pt-2 text-small font-semibold text-fg-secondary">
                      {header}
                    </div>
                  ) : null}
                  <div
                    id={`${listId}-${command.id}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(command)}
                    className={cn('flex cursor-default items-center gap-3 rounded-md px-3 py-2 pointer-coarse:min-h-11', index === active && 'bg-muted')}
                  >
                    {Icon ? <Icon size={16} className="shrink-0 text-fg-secondary" aria-hidden /> : null}
                    <span className="min-w-0 flex-1 truncate text-body text-fg">{command.label}</span>
                    {command.hint ? <span className="shrink-0 text-small text-fg-secondary">{command.hint}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
