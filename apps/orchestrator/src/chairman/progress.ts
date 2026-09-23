import type { ChairmanHealth } from '@acc/shared';
import type { FailureSource } from './signatures.js';

export interface FailurePoint {
  source: FailureSource;
  hash: string;
  failureCount: number | null;
}

/**
 * Progress classification (plan §3.8) from objective before/after evidence —
 * never a made-up percentage. `failures` are the current strategy's failures
 * in order; `resolved` means the most recent check of that kind passed.
 */
export function classifyProgress(failures: FailurePoint[], resolved = false): ChairmanHealth {
  if (resolved) return failures.length ? 'PROGRESSING' : 'STABLE';
  if (failures.length === 0) return 'UNKNOWN';
  const last = failures.at(-1)!;
  const sameSource = failures.filter((f) => f.source === last.source);
  if (sameSource.length < 2) return 'UNKNOWN';
  const previous = sameSource.at(-2)!;

  if (last.failureCount !== null && previous.failureCount !== null) {
    if (last.failureCount < previous.failureCount) return 'PROGRESSING';
    // More failures than before and the old failure is still among them: the last change broke something.
    if (last.failureCount > previous.failureCount) return 'REGRESSING';
  }
  // Review and verification rejecting the same thing twice is already a stall; tests get three tries.
  const stallAfter = last.source === 'verify' || last.source === 'review' ? 2 : 3;
  const recent = sameSource.slice(-stallAfter);
  if (recent.length === stallAfter && recent.every((f) => f.hash === last.hash)) return 'STALLED';
  return 'STABLE';
}
