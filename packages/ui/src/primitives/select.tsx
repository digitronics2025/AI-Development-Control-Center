import { Check, ChevronDown, Search } from 'lucide-react';
import { Popover as PopoverPrimitive, Select as SelectPrimitive } from 'radix-ui';
import { forwardRef, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface SelectOption {
  value: string;
  label: string;
  /** One-line intent shown under the label (design.md §7.2 workflow profiles). */
  description?: string;
  disabled?: boolean;
}

const trigger = [
  'inline-flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-3 text-left text-body text-fg',
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger',
  'data-placeholder:text-fg-tertiary pointer-coarse:h-11',
];

const content = 'z-50 overflow-hidden rounded-lg border border-border-subtle bg-elevated text-fg shadow-float';

/** Short fixed choices (design.md §8.3). Keyboard and screen-reader behaviour from Radix. */
export const Select = forwardRef<
  HTMLButtonElement,
  {
    value: string | undefined;
    onValueChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    className?: string;
    'aria-label'?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }
>(function Select({ value, onValueChange, options, placeholder = 'Select…', disabled, className, ...aria }, ref) {
  const selected = options.find((o) => o.value === value);
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger ref={ref} className={cn(trigger, className)} {...aria}>
        <span className="truncate">
          <SelectPrimitive.Value placeholder={placeholder}>{selected?.label}</SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown size={16} className="text-fg-secondary" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className={cn(content, 'max-h-[min(360px,var(--radix-select-content-available-height))] min-w-(--radix-select-trigger-width)')}>
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex cursor-default select-none flex-col rounded-md py-2 pl-8 pr-3 outline-none data-disabled:opacity-50 data-highlighted:bg-muted"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2 top-2.5">
                  <Check size={16} className="text-accent" aria-hidden />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                {option.description ? <span className="text-small text-fg-secondary">{option.description}</span> : null}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
});

/**
 * Searchable combobox for repositories and model lists (design.md §8.3).
 * Implements the ARIA combobox pattern: text input + listbox, arrow keys move
 * the active option, Enter selects, Escape closes.
 */
export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  disabled,
  id,
  className,
  footer,
  ...aria
}: {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  footer?: ReactNode;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => `${o.label} ${o.description ?? ''} ${o.value}`.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const choose = (option: SelectOption | undefined) => {
    if (!option || option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(filtered[active]);
    } else if (event.key === 'Home') {
      setActive(0);
    } else if (event.key === 'End') {
      setActive(filtered.length - 1);
    }
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setActive(Math.max(0, filtered.findIndex((o) => o.value === value)));
        else setQuery('');
      }}
    >
      <PopoverPrimitive.Trigger asChild disabled={disabled}>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          className={cn(trigger, !selected && 'text-fg-tertiary', className)}
          {...aria}
        >
          <span className="min-w-0 truncate">{selected ? selected.label : placeholder}</span>
          <ChevronDown size={16} className="shrink-0 text-fg-secondary" aria-hidden />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className={cn(content, 'w-[max(var(--radix-popover-trigger-width),16rem)] max-w-[calc(100vw-32px)]')}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector('input')?.focus();
          }}
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-3">
            <Search size={16} className="text-fg-secondary" aria-hidden />
            <input
              role="searchbox"
              aria-label={searchPlaceholder}
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
              value={query}
              placeholder={searchPlaceholder}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="h-10 w-full bg-transparent text-body text-fg outline-none placeholder:text-fg-secondary"
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? <li className="px-3 py-2 text-body text-fg-secondary">{emptyText}</li> : null}
            {filtered.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
                className={cn(
                  'relative flex cursor-default flex-col rounded-md py-2 pl-8 pr-3',
                  index === active && 'bg-muted',
                  option.disabled && 'opacity-50',
                )}
              >
                {option.value === value ? <Check size={16} className="absolute left-2 top-2.5 text-accent" aria-hidden /> : null}
                <span className="truncate text-body text-fg">{option.label}</span>
                {option.description ? <span className="truncate text-small text-fg-secondary">{option.description}</span> : null}
              </li>
            ))}
          </ul>
          {footer ? <div className="border-t border-border-subtle p-1">{footer}</div> : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
