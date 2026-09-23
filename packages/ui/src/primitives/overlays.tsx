import { X } from 'lucide-react';
import { Dialog as DialogPrimitive, DropdownMenu } from 'radix-ui';
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';
import { Input } from './fields.js';

/**
 * Radix restores focus only to its own Trigger. Controlled overlays opened
 * from elsewhere (a table row button, a menu, the command palette) remember
 * the element focused when they opened and return focus to it on close
 * (design.md §11).
 */
function useReturnFocus(open: boolean | undefined) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return (event: Event) => {
    const target = opener.current;
    if (target && target.isConnected && target !== document.body) {
      event.preventDefault();
      target.focus();
    }
  };
}

const overlay =
  'fixed inset-0 z-40 bg-scrim data-[state=open]:animate-[acc-fade-in_160ms_ease-out] data-[state=closed]:animate-[acc-fade-out_120ms_ease-in]';

/**
 * Modal dialogs only when the user must stop and decide (design.md §8.7).
 * Radix traps focus, closes on Escape and returns focus to the trigger.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  trigger,
  size = 'default',
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  trigger?: ReactElement;
  size?: 'default' | 'wide';
}) {
  const returnFocus = useReturnFocus(open);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlay} />
        <DialogPrimitive.Content
          onCloseAutoFocus={trigger ? undefined : returnFocus}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border-subtle bg-surface shadow-modal',
            'data-[state=open]:animate-[acc-pop-in_180ms_var(--ease-enter)]',
            size === 'wide' ? 'max-w-[760px]' : 'max-w-[480px]',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogPrimitive.Title className="text-h3 text-fg">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="text-body text-fg-secondary">{description}</DialogPrimitive.Description> : null}
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" aria-label="Close" className="-mr-1 rounded-md p-1.5 text-fg-secondary hover:bg-elevated hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
                <X size={18} aria-hidden />
              </button>
            </DialogPrimitive.Close>
          </div>
          {children ? <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div> : null}
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Right-side drawer for contextual, non-blocking detail at reduced widths
 * (design.md §8.8): 360–420px on desktop, full width on mobile.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 400,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const returnFocus = useReturnFocus(open);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlay} />
        <DialogPrimitive.Content
          onCloseAutoFocus={returnFocus}
          style={{ ['--drawer-width' as string]: `${width}px` }}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border-subtle bg-surface shadow-modal sm:w-(--drawer-width) sm:max-w-[calc(100vw-48px)] sm:rounded-l-xl data-[state=open]:animate-[acc-slide-in_200ms_var(--ease-enter)]"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogPrimitive.Title className="text-h3 text-fg">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-small text-fg-secondary">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{typeof title === 'string' ? title : 'Details'}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" aria-label="Close" className="-mr-1 rounded-md p-1.5 text-fg-secondary hover:bg-elevated hover:text-fg focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:p-3">
                <X size={18} aria-hidden />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Explicit, labelled confirmation for destructive or production-impacting
 * actions. With `confirmationPhrase` the user must type it exactly.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Keep it',
  destructive,
  confirmationPhrase,
  onConfirm,
  busy,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  confirmationPhrase?: string | null;
  onConfirm: (typed: string) => void | Promise<void>;
  busy?: boolean;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const ready = !confirmationPhrase || typed.trim() === confirmationPhrase;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('');
        onOpenChange(next);
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'destructive' : 'primary'} disabled={!ready} loading={busy} onClick={() => void onConfirm(typed.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {confirmationPhrase ? (
        <label className="mt-2 flex flex-col gap-1.5">
          <span className="text-body text-fg">
            Type <code className="rounded-sm bg-muted px-1 font-mono text-code text-fg">{confirmationPhrase}</code> to confirm
          </span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      ) : null}
    </Dialog>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: import('lucide-react').LucideIcon;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}

/** Overflow menu for genuinely secondary actions (design.md §7.3). */
export function Menu({ trigger, items, align = 'end' }: { trigger: ReactElement; items: MenuItem[]; align?: 'start' | 'end' }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={4} collisionPadding={8} className="z-50 min-w-48 rounded-lg border border-border-subtle bg-elevated p-1 shadow-float">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label}>
                {item.separatorBefore ? <DropdownMenu.Separator className="my-1 h-px bg-border-subtle" /> : null}
                <DropdownMenu.Item
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                  className={cn(
                    'flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-body outline-none pointer-coarse:min-h-11',
                    'data-disabled:opacity-50 data-highlighted:bg-muted',
                    'text-fg',
                  )}
                >
                  {Icon ? <Icon size={16} className={item.destructive ? 'text-danger' : 'text-fg-secondary'} aria-hidden /> : null}
                  {item.label}
                </DropdownMenu.Item>
              </div>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
