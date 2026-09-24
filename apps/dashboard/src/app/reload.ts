/**
 * Release skew (docs/systems/dashboard.md "Installable app"): a page left open across a
 * release still points at the previous build's route chunks, which the new release no
 * longer serves. The first failed chunk reloads the page once; a second failure inside
 * RELOAD_GUARD_MS is shown instead, so a broken release can never cause a reload loop.
 */
const KEY = 'acc.reloaded-for-chunk';
export const RELOAD_GUARD_MS = 60_000;

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStore(): SessionStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Reloads unless this tab already reloaded for the same reason moments ago. Returns whether it reloaded. */
export function reloadOnceForNewVersion(storage: SessionStore | null = sessionStore(), now = Date.now(), reload: () => void = () => window.location.reload()): boolean {
  // Without storage there is no loop guard, so never reload automatically.
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(KEY) ?? '');
    if (Number.isFinite(last) && now - last < RELOAD_GUARD_MS) return false;
    storage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

/** The ways browsers word a failed dynamic import or chunk preload. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to fetch/i.test(message);
}
