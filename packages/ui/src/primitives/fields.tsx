import { AlertCircle } from 'lucide-react';
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../lib/cn.js';

const control = [
  'w-full rounded-md border bg-surface text-body text-fg placeholder:text-fg-tertiary',
  'transition-[border-color,box-shadow] duration-[120ms]',
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:opacity-60',
  'aria-[invalid=true]:border-danger',
];

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, 'h-9 border-border-strong px-3 pointer-coarse:h-11', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(control, 'min-h-[140px] resize-y border-border-strong px-3 py-2 leading-5', className)} {...props} />;
});

export interface FieldProps {
  label: ReactNode;
  /** Visible helper text; linked to the control with aria-describedby. */
  helper?: ReactNode;
  /** Inline validation message; marks the control invalid and is announced. */
  error?: string | null;
  /** The control. It receives id, aria-describedby and aria-invalid. */
  children: ReactElement<Record<string, unknown>>;
  className?: string;
  optional?: boolean;
  /** Put the label beside the control on wide screens (settings rows). */
  inline?: boolean;
  id?: string;
  /** Beside the control (e.g. a Browse… button); keeps the label on the control itself. */
  addon?: ReactNode;
}

/**
 * Visible label, helper text and inline error, associated with the control
 * (design.md §8.2). No placeholder-only labels.
 */
export function Field({ label, helper, error, children, className, optional, inline, id: givenId, addon }: FieldProps) {
  const autoId = useId();
  const id = givenId ?? (children.props.id as string | undefined) ?? autoId;
  const helperId = helper ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })
    : children;
  return (
    <div className={cn(inline ? 'grid gap-2 md:grid-cols-[220px_minmax(0,1fr)] md:items-start md:gap-4' : 'flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className={cn('text-body font-semibold text-fg', inline && 'md:pt-2')}>
        {label}
        {optional ? <span className="ml-1.5 font-normal text-fg-secondary">(optional)</span> : null}
      </label>
      <div className="flex min-w-0 flex-col gap-1.5">
        {addon ? (
          <div className="flex gap-2">
            {control}
            {addon}
          </div>
        ) : (
          control
        )}
        {helper ? (
          <p id={helperId} className="text-small text-fg-secondary">
            {helper}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="flex items-center gap-1.5 text-small text-danger">
            <AlertCircle size={14} aria-hidden />
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A labelled group of controls (radio groups, segmented controls). */
export function FieldGroup({
  label,
  helper,
  children,
  className,
  inline,
}: {
  label: ReactNode;
  helper?: ReactNode;
  children: ReactNode;
  className?: string;
  inline?: boolean;
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={helper ? `${id}-help` : undefined}
      className={cn(inline ? 'grid gap-2 md:grid-cols-[220px_minmax(0,1fr)] md:items-start md:gap-4' : 'flex flex-col gap-1.5', className)}
    >
      <span id={`${id}-label`} className={cn('text-body font-semibold text-fg', inline && 'md:pt-2')}>
        {label}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        {children}
        {helper ? (
          <p id={`${id}-help`} className="text-small text-fg-secondary">
            {helper}
          </p>
        ) : null}
      </div>
    </div>
  );
}
