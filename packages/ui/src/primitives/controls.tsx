import { ChevronRight, type LucideIcon } from 'lucide-react';
import { Collapsible as CollapsiblePrimitive, RadioGroup, Switch as SwitchPrimitive, Tabs as TabsPrimitive } from 'radix-ui';
import { forwardRef, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

/**
 * Mutually exclusive short modes (design.md §8.4): Discuss First / Autopilot,
 * Simple / Developer, Light / Dark / System. A radio group underneath, so
 * arrow keys move between options.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
  size = 'default',
  disabled,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentOption<T>[];
  label: string;
  className?: string;
  size?: 'compact' | 'default';
  disabled?: boolean;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      aria-label={label}
      orientation="horizontal"
      disabled={disabled}
      className={cn('inline-flex max-w-full rounded-md border border-border-strong bg-surface p-0.5', className)}
    >
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <RadioGroup.Item
            key={option.value}
            value={option.value}
            className={cn(
              'inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 font-semibold text-fg-secondary',
              'transition-colors duration-[120ms] hover:text-fg',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
              'data-[state=checked]:bg-accent-muted data-[state=checked]:text-fg disabled:opacity-50',
              size === 'compact' ? 'h-[26px] text-small' : 'h-8 text-body',
              'pointer-coarse:min-h-11',
            )}
          >
            {Icon ? <Icon size={16} aria-hidden /> : null}
            {option.label}
          </RadioGroup.Item>
        );
      })}
    </RadioGroup.Root>
  );
}

export const Switch = forwardRef<
  HTMLButtonElement,
  { checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; id?: string; 'aria-label'?: string; 'aria-describedby'?: string }
>(function Switch({ checked, onCheckedChange, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border-strong bg-muted transition-colors duration-[120ms]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50',
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-fg transition-transform duration-[120ms] data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-fg-inverse" />
    </SwitchPrimitive.Root>
  );
});

/** Tabs keep a consistent order and never reset on realtime updates (design.md §7.3). */
export const Tabs = TabsPrimitive.Root;

export function TabList({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <TabsPrimitive.List
      aria-label={label}
      className={cn('flex max-w-full gap-1 overflow-x-auto border-b border-border-subtle [scrollbar-width:none]', className)}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function Tab({ value, children, count, icon: Icon }: { value: string; children: ReactNode; count?: number | null; icon?: LucideIcon }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        '-mb-px inline-flex h-10 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-body font-semibold text-fg-secondary',
        'transition-colors duration-[120ms] hover:text-fg',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
        'data-[state=active]:border-accent data-[state=active]:text-fg',
      )}
    >
      {Icon ? <Icon size={16} aria-hidden /> : null}
      {children}
      {count !== undefined && count !== null ? (
        <span className="tabular rounded-sm bg-muted px-1.5 text-small font-semibold text-fg-secondary">{count}</span>
      ) : null}
    </TabsPrimitive.Trigger>
  );
}

export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <TabsPrimitive.Content value={value} className={cn('min-w-0 pt-4 focus-visible:outline-none', className)}>
      {children}
    </TabsPrimitive.Content>
  );
}

/** Progressive disclosure for advanced options (design.md §2.3). Collapsed by default. */
export function Disclosure({
  title,
  description,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <CollapsiblePrimitive.Root defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange} className={cn('rounded-lg border border-border-subtle', className)}>
      <CollapsiblePrimitive.Trigger className="group flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11">
        <ChevronRight size={16} className="shrink-0 text-fg-secondary transition-transform duration-[160ms] group-data-[state=open]:rotate-90" aria-hidden />
        <span className="flex min-w-0 flex-col">
          <span className="text-body font-semibold text-fg">{title}</span>
          {description ? <span className="text-small text-fg-secondary">{description}</span> : null}
        </span>
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="border-t border-border-subtle px-4 py-4">{children}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3 pointer-coarse:min-h-11', disabled && 'cursor-not-allowed opacity-60')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-(--accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <span className="flex flex-col">
        <span className="text-body text-fg">{label}</span>
        {description ? <span className="text-small text-fg-secondary">{description}</span> : null}
      </span>
    </label>
  );
}
