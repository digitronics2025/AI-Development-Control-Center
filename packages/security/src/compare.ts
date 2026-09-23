import { timingSafeEqual } from 'node:crypto';

/** Compare secrets (tokens) without leaking where they differ through timing. */
export function constantTimeEqual(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
