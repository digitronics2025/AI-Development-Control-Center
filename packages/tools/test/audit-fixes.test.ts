import { describe, expect, it } from 'vitest';
import { builtinProviders, decide, type ToolOperation } from '../src/index.js';

/**
 * Regression tests for the 2026-09-24 pre-release audit
 * (docs/security/prerelease-audit-2026-09-24.md). Each test names its finding.
 */

function op(id: string): ToolOperation {
  const found = builtinProviders()
    .flatMap((p) => p.operations)
    .find((o) => o.id === id);
  if (!found) throw new Error(`no operation ${id}`);
  return found as ToolOperation;
}

function risk(id: string, input: unknown) {
  const o = op(id);
  const parsed = o.input.parse(input);
  return { level: o.level, risk: 'normal' as const, reasons: [], effects: [], production: false, ...o.classify?.(parsed, { cwd: process.cwd(), isTaskOwnedPid: () => false }) };
}

const agentAt = (r: ReturnType<typeof risk>, stageLevel: 1 | 2 | 3 | 4 = 2) =>
  decide({ risk: r, mode: 'full', autoApproveUpToLevel: 4, stageLevel, inProfile: true, origin: 'agent' }).decision;

describe('F-04: verify.web classifies its start command', () => {
  it('rates a harmless dev server at Level 2 and a destructive one like the command itself', () => {
    expect(risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'pnpm dev' }).level).toBe(2);
    const bad = risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'git push --force origin main' });
    expect(bad.level).toBe(5);
    expect(agentAt(bad)).toBe('deny');
    const deploy = risk('verify.web', { url: 'http://127.0.0.1:5173', startCommand: 'npx wrangler deploy --env production' });
    expect(deploy.production).toBe(true);
    expect(agentAt(deploy)).toBe('deny');
  });

  it('stays Level 1 with no start command', () => {
    expect(risk('verify.web', { url: 'http://127.0.0.1:5173' }).level).toBe(1);
  });
});
