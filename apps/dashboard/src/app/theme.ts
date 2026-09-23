import { useEffect } from 'react';
import { useMediaQuery } from '@acc/ui';
import type { ThemePreference } from '@acc/shared';

const STORAGE_KEY = 'acc:resolved-theme';

export type ResolvedTheme = 'dark' | 'light' | 'vscode';

/** Apply the last resolved theme before first render to avoid a flash (dark is the first-launch default). */
export function applyInitialTheme(host: 'web' | 'vscode'): void {
  let theme: ResolvedTheme = host === 'vscode' ? 'vscode' : 'dark';
  if (host === 'web') {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') theme = saved;
    } catch {
      /* storage unavailable */
    }
  }
  document.documentElement.dataset.theme = theme;
}

/** Keep <html data-theme> in sync with the Appearance setting (design.md §4.1, §13). */
export function useThemeController(preference: ThemePreference | undefined, host: 'web' | 'vscode'): ResolvedTheme {
  const prefersLight = useMediaQuery('(prefers-color-scheme: light)');
  const resolved: ResolvedTheme =
    host === 'vscode' ? 'vscode' : preference === 'light' ? 'light' : preference === 'system' ? (prefersLight ? 'light' : 'dark') : 'dark';
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    if (host === 'web') {
      try {
        window.localStorage.setItem(STORAGE_KEY, resolved);
      } catch {
        /* storage unavailable */
      }
    }
  }, [resolved, host]);
  return resolved;
}
