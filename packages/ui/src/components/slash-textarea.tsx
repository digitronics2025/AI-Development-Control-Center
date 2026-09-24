import { slashQueryAt } from '@acc/shared';
import { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';
import { Textarea } from '../primitives/fields.js';

export interface SlashOption {
  /** Inserted after the `/`. */
  value: string;
  label: string;
  description?: string;
  /** Where it comes from, shown at the row's end (e.g. "Repository"). */
  detail?: string;
}

export interface SlashTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Options for the text typed after `/`, already filtered and ordered. */
  suggest: (query: string) => SlashOption[];
  /** How many options exist at all; the list never opens when there are none. */
  total: number;
  loading?: boolean;
  /** Accessible name of the list, e.g. "Skills". */
  listLabel: string;
  loadingText?: string;
  emptyText?: string;
}

/**
 * A text area with a `/` picker (design.md §8.3 "Slash picker"): typing `/` at the
 * start or after a space lists options under the field; arrows move, Enter or Tab
 * inserts `/value `, Escape closes. Focus never leaves the text area, which points
 * at the active row with `aria-activedescendant`.
 */
export const SlashTextarea = forwardRef<HTMLTextAreaElement, SlashTextareaProps>(function SlashTextarea(
  { value, onValueChange, suggest, total, loading = false, listLabel, loadingText = 'Loading…', emptyText = 'No matches', onKeyDown, onBlur, className, ...props },
  forwardedRef,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  /** The `/` the user dismissed with Escape; it stays closed until they start another. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inner.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  const options = useMemo(() => (token ? suggest(token.query) : []), [token, suggest]);
  const open = token !== null && token.start !== dismissed && (loading || total > 0);

  const track = (text: string, caret: number | null) => {
    const next = caret === null ? null : slashQueryAt(text, caret);
    setToken(next);
    setActive(0);
    if (!next) setDismissed(null);
  };

  const choose = (option: SlashOption | undefined) => {
    const el = inner.current;
    if (!option || !token || !el) return;
    const caret = el.selectionStart ?? value.length;
    const insert = `/${option.value} `;
    const after = value.slice(caret).replace(/^[A-Za-z0-9._:-]*/, ''); // the rest of the name being typed, never a closing bracket
    const next = value.slice(0, token.start) + insert + after.replace(/^ /, '');
    onValueChange(next);
    setToken(null);
    const position = token.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(position, position);
    });
  };

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (open && plain) {
      if (event.key === 'ArrowDown' && options.length) {
        event.preventDefault();
        setActive((i) => (i + 1) % options.length);
        return;
      }
      if (event.key === 'ArrowUp' && options.length) {
        event.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && options[active]) {
        event.preventDefault();
        choose(options[active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(token!.start);
        return;
      }
    }
    onKeyDown?.(event);
  };

  const activeId = open && options[active] ? `${listId}-${active}` : undefined;

  return (
    <div className="relative">
      <Textarea
        ref={setRef}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          track(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          setToken(null);
          onBlur?.(e);
        }}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        className={className}
        {...props}
      />
      {open ? (
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border-subtle bg-elevated text-fg shadow-float">
          <ul ref={listRef} id={listId} role="listbox" aria-label={listLabel} className="max-h-72 overflow-y-auto p-1">
            {options.length === 0 ? (
              <li role="presentation" className="px-3 py-2 text-body text-fg-secondary">
                {loading ? loadingText : emptyText}
              </li>
            ) : null}
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
                className={cn('flex cursor-default items-baseline gap-3 rounded-md px-3 py-2 pointer-coarse:min-h-11', index === active && 'bg-muted')}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-body text-fg">{option.label}</span>
                  {option.description ? <span className="truncate text-small text-fg-secondary">{option.description}</span> : null}
                </span>
                {option.detail ? <span className="shrink-0 text-small text-fg-secondary">{option.detail}</span> : null}
              </li>
            ))}
          </ul>
          <p className="sr-only" role="status">
            {loading ? loadingText : `${options.length} ${options.length === 1 ? 'match' : 'matches'}. Up and down arrows to choose, Enter to insert, Escape to close.`}
          </p>
        </div>
      ) : null}
    </div>
  );
});
