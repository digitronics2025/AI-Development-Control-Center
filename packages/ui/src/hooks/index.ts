import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

/** Subscribe to a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** design.md §6 breakpoints. */
export const BREAKPOINTS = { mobile: 600, tablet: 900, compact: 1200, wide: 1440 } as const;

export function useBreakpoint() {
  const tablet = useMediaQuery(`(min-width: ${BREAKPOINTS.mobile}px)`);
  const compact = useMediaQuery(`(min-width: ${BREAKPOINTS.tablet}px)`);
  const desktop = useMediaQuery(`(min-width: ${BREAKPOINTS.compact}px)`);
  const wide = useMediaQuery(`(min-width: ${BREAKPOINTS.wide}px)`);
  return { isMobile: !tablet, isTabletUp: tablet, isCompactUp: compact, isDesktopUp: desktop, isWide: wide };
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** A clock that re-renders every `intervalMs`, for elapsed times. Pauses when disabled. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

export interface HotkeyOptions {
  /** Require Ctrl (Windows/Linux) or Cmd (macOS). */
  mod?: boolean;
  shift?: boolean;
  /** Also fire while focus is in a text field. */
  allowInInputs?: boolean;
  enabled?: boolean;
}

/** Global keyboard shortcut (design.md §11). Does not override unrelated browser shortcuts. */
export function useHotkey(key: string, handler: (event: KeyboardEvent) => void, options: HotkeyOptions = {}): void {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  const { mod = false, shift = false, allowInInputs = false, enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      const modPressed = event.ctrlKey || event.metaKey;
      if (mod !== modPressed || shift !== event.shiftKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (typing && !allowInInputs) return;
      ref.current(event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, mod, shift, allowInInputs, enabled]);
}

/**
 * Auto-follow for streaming output (design.md §9.3): follow while the reader
 * is at the bottom; stop as soon as they scroll up; never force-scroll.
 */
export function useAutoFollow(threshold = 24) {
  const [following, setFollowing] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const followingRef = useRef(true);

  const onScroll = useCallback(
    (element: HTMLElement) => {
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
      followingRef.current = atBottom;
      setFollowing(atBottom);
      if (atBottom) setHasNewOutput(false);
    },
    [threshold],
  );

  const notifyNewContent = useCallback((scrollToBottom: () => void) => {
    if (followingRef.current) scrollToBottom();
    else setHasNewOutput(true);
  }, []);

  const jumpToLatest = useCallback((scrollToBottom: () => void) => {
    followingRef.current = true;
    setFollowing(true);
    setHasNewOutput(false);
    scrollToBottom();
  }, []);

  return { following, hasNewOutput, onScroll, notifyNewContent, jumpToLatest };
}

/**
 * Per-viewer convenience state (remembered tab, collapsed panel). Never used
 * for workflow state — the orchestrator owns that (design.md §14).
 */
export function useLocalPreference<T>(key: string, initial: T): [T, (value: T) => void] {
  const storageKey = `acc:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage unavailable: the preference lasts for this session only */
      }
    },
    [storageKey],
  );
  return [value, update];
}

/** Returns the previous render's value. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}
