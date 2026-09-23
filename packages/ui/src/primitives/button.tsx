import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2, type LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Tooltip } from './tooltip.js';

/**
 * design.md §8.1 — four variants, three sizes. Destructive styling is for
 * destructive actions only; never place two primary buttons in one group.
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md border font-semibold',
    'transition-[background-color,border-color,color,box-shadow] duration-[120ms] ease-out',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'pointer-coarse:min-h-11',
  ],
  {
    variants: {
      variant: {
        primary: 'border-transparent bg-accent text-fg-inverse hover:bg-accent-hover',
        secondary: 'border-border-strong bg-surface text-fg hover:bg-elevated',
        ghost: 'border-transparent bg-transparent text-fg-secondary hover:bg-elevated hover:text-fg',
        destructive: 'border-danger bg-danger-muted text-fg hover:bg-danger hover:text-fg-inverse',
      },
      size: {
        compact: 'h-[30px] px-2.5 text-small',
        default: 'h-9 px-3.5 text-body',
        touch: 'h-11 px-4 text-body',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  /** Explanation shown when the button is disabled (e.g. "Reconnect first"). */
  disabledReason?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, icon: Icon, iconRight: IconRight, loading, children, disabled, disabledReason, type = 'button', ...props },
  ref,
) {
  const iconSize = size === 'compact' ? 16 : 18;
  const button = (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 size={iconSize} className="animate-spin" aria-hidden /> : Icon ? <Icon size={iconSize} aria-hidden /> : null}
      {children}
      {IconRight ? <IconRight size={iconSize} aria-hidden /> : null}
    </button>
  );
  if (disabled && disabledReason) {
    // Disabled buttons do not receive pointer events; wrap so the reason is discoverable.
    return (
      <Tooltip content={disabledReason}>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-focus">
          {button}
        </span>
      </Tooltip>
    );
  }
  return button;
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Required accessible name, also shown as a tooltip (design.md §8.9, §11). */
  label: string;
  variant?: 'ghost' | 'secondary';
  size?: 'compact' | 'default';
  tooltip?: boolean;
  children?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'default', tooltip = true, className, type = 'button', ...props },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        buttonVariants({ variant, size }),
        size === 'compact' ? 'w-[30px] px-0' : 'w-9 px-0',
        'pointer-coarse:min-w-11',
        className,
      )}
      {...props}
    >
      <Icon size={size === 'compact' ? 16 : 18} aria-hidden />
    </button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
});
