import { useEffect } from 'react';
import { useMediaQuery } from '@acc/ui';
import type { ThemePreference } from '@acc/shared';

const STORAGE_KEY = 'acc:resolved-theme';

export type ResolvedTheme = 'dark' | 'light' | 'vscode';

/**
 * The browser and installed-app chrome (the phone's status bar, the title bar) in the
 * canvas colour of the theme actually shown: `--bg-canvas` in packages/ui tokens.css.
 * It follows the app's own theme, not the phone's light/dark setting, which may differ.
 */
const CHROME_COLOR: Record<'dark' | 'light', string> = { dark: '#090b0f', light: '#f5f7fa' };

function applyChromeColor(theme: ResolvedTheme): void {
  if (theme === 'vscode') return;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME_COLOR[theme]);
}

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
  applyChromeColor(theme);
}

/** Keep <html data-theme> in sync with the Appearance setting (design.md §4.1, §13). */
export function useThemeController(preference: ThemePreference | undefined, host: 'web' | 'vscode'): ResolvedTheme {
  const prefersLight = useMediaQuery('(prefers-color-scheme: light)');
  const resolved: ResolvedTheme =
    host === 'vscode' ? 'vscode' : preference === 'light' ? 'light' : preference === 'system' ? (prefersLight ? 'light' : 'dark') : 'dark';
  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.theme !== resolved) {
      // Suspend transitions until the new palette has been painted (see styles/index.css).
      root.dataset.themeSwitching = '';
      root.dataset.theme = resolved;
      requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.themeSwitching));
    }
    applyChromeColor(resolved);
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
