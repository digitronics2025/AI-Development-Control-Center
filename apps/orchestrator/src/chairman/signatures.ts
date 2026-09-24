import { createHash } from 'node:crypto';
import type { ErrorClass, FailureCategory } from '@acc/shared';

/**
 * Failure signatures (plan §3.7): a normalised, hashable description of a
 * failure, so "the same failure again" and "a new failure" can be told apart
 * without embeddings. Numbers are stripped from the signature and kept
 * separately as `failureCount`, which is what progress is measured on.
 */

export type FailureSource = 'tests' | 'review' | 'verify' | 'worker' | 'gate';

export interface FailureInput {
  source: FailureSource;
  stageKey: string;
  /** One-line failure message (test summary, error message, "Review requested changes"). */
  message: string;
  /** Longer evidence: the reviewer's output or the failing command's last lines. */
  detail?: string | null;
  errorClass?: ErrorClass | null;
  /** Name of the failing command for test failures. */
  commandName?: string | null;
}

export interface FailureSignature {
  source: FailureSource;
  category: FailureCategory;
  signature: string;
  hash: string;
  failureCount: number | null;
  message: string;
}

// eslint-disable-next-line no-control-regex -- terminal colour codes are exactly what is stripped here
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Lowercase, strip volatile parts (ids, paths' line numbers, timings, counts) and collapse whitespace. */
export function normalizeMessage(text: string, max = 200): string {
  return text
    .replace(ANSI, '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[0-9a-f]{12,40}\b/g, '<hash>')
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '<time>')
    .replace(/[a-z]:\\[^\s:'"]+|\/(?:[\w.-]+\/)+[\w.-]+/g, (p) => p.replace(/^.*[\\/]/, ''))
    .replace(/:\d+(:\d+)?\b/g, '')
    .replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds|m|min)\b/g, '<t>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** "2 failed", "3 failures", "Tests: 1 failed" → 2 / 3 / 1. */
export function testFailureCount(text: string): number | null {
  const match = /(\d+)\s+(?:failed|failing|failures?|errors?)\b/i.exec(text.replace(ANSI, ''));
  return match ? Number(match[1]) : null;
}

/** Identifiers of failing tests named in runner output (vitest, jest, mocha, node:test, pytest, TAP). */
export function failingTestIds(detail: string, limit = 5): string[] {
  const ids = new Set<string>();
  for (const raw of detail.replace(ANSI, '').split('\n')) {
    const line = raw.trim();
    const match = /^(?:FAIL|✕|×|✗|not ok\s+\d+\s*-?|FAILED)\s+(.+)$/.exec(line);
    if (match) ids.add(normalizeMessage(match[1]!, 120));
    if (ids.size >= limit) break;
  }
  return [...ids].sort();
}

/** The issue bullets of a review or verification, which identify what was rejected. */
export function reviewIssues(output: string, limit = 3): string[] {
  const issues: string[] = [];
  for (const raw of output.split('\n')) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(.{8,})$/.exec(raw);
    if (!match) continue;
    const text = match[1]!.replace(/\*\*|`/g, '');
    if (/^verdict\b/i.test(text) || /^needs operator\b/i.test(text)) continue;
    issues.push(normalizeMessage(text, 120));
    if (issues.length >= limit) break;
  }
  return issues;
}

const PLAN_WORDS = /\b(requirement|requirements|requested|the plan|plan is|approach|misunderstood|does not address|doesn't address|wrong feature|out of scope|not what was asked|success criteria)\b/i;

/**
 * The explicit `CAUSE: code | plan` line a reviewer or verifier writes with a
 * FAIL (prompts/reviewer.md, prompts/verifier.md); the last one wins. Null when
 * the output has none (an older or user-edited template).
 */
export function causeMarker(text: string): 'code' | 'plan' | null {
  const last = [...text.matchAll(/^[\s>*+-]*\**CAUSE:?\**:?\s*(code|plan)\b/gim)].at(-1)?.[1];
  return last ? (last.toLowerCase() as 'code' | 'plan') : null;
}

/**
 * A verifier/reviewer that says the work misses the request points at the
 * plan, not the code. The explicit marker decides when present; the word list
 * is the fallback, since a verifier naming its "success criteria" is not
 * thereby reporting a plan mismatch.
 */
export function pointsAtPlan(text: string): boolean {
  const marker = causeMarker(text);
  return marker ? marker === 'plan' : PLAN_WORDS.test(text);
}

function categoryOf(input: FailureInput): FailureCategory {
  switch (input.source) {
    case 'tests':
      return 'CODE_OR_TEST';
    case 'review':
    case 'verify':
      return pointsAtPlan(`${input.message}\n${input.detail ?? ''}`) ? 'REQUIREMENT_OR_PLAN' : 'CODE_OR_TEST';
    case 'gate':
      return 'WORKFLOW_STATE';
    case 'worker':
      switch (input.errorClass) {
        case 'USAGE_LIMIT':
        case 'AUTH_FAILURE':
        case 'MODEL_UNAVAILABLE':
          return 'AUTH_OR_EXTERNAL';
        case 'PERMISSION_DENIED':
        case 'COMMAND_FAILURE':
          return 'ENVIRONMENT';
        case 'CONTEXT_FAILURE':
          return 'WORKFLOW_STATE';
        case 'PROCESS_CRASH':
        case 'TIMEOUT':
          return 'WORKER_OR_TOOL';
        default:
          return 'UNKNOWN';
      }
  }
}

export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function signatureOf(input: FailureInput): FailureSignature {
  const detail = input.detail ?? '';
  let parts: string[];
  let failureCount: number | null = null;
  switch (input.source) {
    case 'tests': {
      failureCount = testFailureCount(input.message) ?? testFailureCount(detail);
      const ids = failingTestIds(detail);
      parts = ['TEST', input.stageKey, normalizeMessage(input.commandName ?? ''), ids.length ? ids.join(',') : normalizeMessage(input.message)];
      break;
    }
    case 'review':
    case 'verify': {
      const issues = reviewIssues(detail);
      failureCount = issues.length ? detail.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+.{8,}/.test(l)).length : null;
      parts = [input.source === 'review' ? 'REVIEW' : 'VERIFY', input.stageKey, issues.length ? issues.join(',') : normalizeMessage(input.message)];
      break;
    }
    case 'worker':
      parts = ['WORKER', input.stageKey, input.errorClass ?? 'UNKNOWN', normalizeMessage(input.message)];
      break;
    case 'gate':
      parts = ['GATE', input.stageKey, normalizeMessage(input.message)];
      break;
  }
  const signature = parts.join('|');
  return { source: input.source, category: categoryOf(input), signature, hash: hashOf(signature), failureCount, message: input.message.slice(0, 500) };
}
