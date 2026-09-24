import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, RELOAD_GUARD_MS, reloadOnceForNewVersion } from './reload';

function store() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('reloadOnceForNewVersion', () => {
  it('reloads once, then not again inside the guard, then again after it', () => {
    const s = store();
    const reload = vi.fn();
    expect(reloadOnceForNewVersion(s, 1_000_000, reload)).toBe(true);
    expect(reloadOnceForNewVersion(s, 1_000_000 + RELOAD_GUARD_MS - 1, reload)).toBe(false);
    expect(reloadOnceForNewVersion(s, 1_000_000 + RELOAD_GUARD_MS, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads without working storage, so it cannot loop', () => {
    const reload = vi.fn();
    expect(reloadOnceForNewVersion(null, 1, reload)).toBe(false);
    const throwing = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(reloadOnceForNewVersion(throwing, 1, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('isChunkLoadError', () => {
  it('recognises how browsers word a missing chunk', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
