import { describe, expect, it } from 'vitest';
import { isUiPath, stageConditionHolds, validateWorkflow, type WorkflowProfileInput } from '../src/index.js';

/** docs/plans/DESIGNER_ROUTING_PLAN.md §5: what counts as user-interface work, and where a condition may stand. */

describe('isUiPath', () => {
  it('counts markup, styles, components, images, fonts, the design standard and theme config', () => {
    for (const p of [
      'apps/dashboard/src/pages/TaskDetailPage.tsx',
      'src/App.vue',
      'src/routes/+page.svelte',
      'site/index.html',
      'styles/main.scss',
      'packages/ui/src/styles/tokens.css',
      'public/hero.webp',
      'public/logo.svg',
      'assets/fonts/inter.woff2',
      'design.md',
      'DESIGN.md',
      'docs/design.md',
      'design/brief.md',
      'tailwind.config.ts',
      'postcss.config.mjs',
      'packages/ui/src/tokens/status.ts',
      'src/components/button/index.ts',
      'src/theme/colors.js',
    ]) {
      expect(isUiPath(p), p).toBe(true);
    }
  });

  it('leaves out backend code, tests, generated output and other documents', () => {
    for (const p of [
      'apps/orchestrator/src/engine/engine.ts',
      'packages/shared/src/schemas.ts',
      'src/api/routes.py',
      'src/components/Button.test.tsx',
      'src/components/__tests__/Button.tsx',
      'apps/dashboard/e2e/journey.spec.ts',
      'tests/fixtures/page.html',
      'dist/index.html',
      'README.md',
      'docs/systems/engine.md',
      'pnpm-lock.yaml',
      'src/ui.d.ts',
      'migrations/0004_orders.sql',
    ]) {
      expect(isUiPath(p), p).toBe(false);
    }
  });

  it('reads Windows separators and ignores a leading ./', () => {
    expect(isUiPath('src\\components\\Card.tsx')).toBe(true);
    expect(isUiPath('./src/styles/app.css')).toBe(true);
    expect(isUiPath('')).toBe(false);
    expect(isUiPath('src/components/')).toBe(false);
  });
});

describe('stageConditionHolds', () => {
  it('holds without a condition, and on unknown facts (fail closed)', () => {
    expect(stageConditionHolds(undefined, { uiChanged: false })).toBe(true);
    expect(stageConditionHolds('ui-changed', { uiChanged: true })).toBe(true);
    expect(stageConditionHolds('ui-changed', { uiChanged: null })).toBe(true);
    expect(stageConditionHolds('ui-changed', { uiChanged: false })).toBe(false);
  });
});

const base = (critique: Record<string, unknown>, extra: Array<Record<string, unknown>> = []): WorkflowProfileInput =>
  ({
    id: 'custom',
    name: 'Custom',
    stages: [
      { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'critique' },
      { key: 'critique', name: 'Visual critique', role: 'visual-critic', permissionLevel: 1, verdict: true, when: 'ui-changed', next: 'review', onFail: 'implement', ...critique },
      { key: 'review', name: 'Review', role: 'reviewer', permissionLevel: 1, verdict: true, next: 'complete', onFail: 'implement' },
      ...extra,
    ],
  }) as WorkflowProfileInput;

describe('validateWorkflow: conditions and paid design stages', () => {
  it('accepts a conditional visual critique after a stage that changes files', () => {
    expect(validateWorkflow(base({})).issues).toEqual([]);
  });

  it('refuses a condition on code review, verification, a write stage or a non-verdict stage', () => {
    const on = (patch: Record<string, unknown>) => validateWorkflow(base(patch)).issues.filter((i) => i.field === 'when').map((i) => i.message);
    expect(on({ role: 'reviewer' })[0]).toMatch(/Only a visual critique/);
    expect(on({ role: 'verifier' })[0]).toMatch(/Only a visual critique/);
    expect(on({ verdict: false, onFail: undefined })[0]).toMatch(/Only a visual critique/);
    expect(on({ permissionLevel: 2 })[0]).toMatch(/read-only/);
    const writer = validateWorkflow({
      id: 'custom',
      name: 'Custom',
      stages: [{ key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, when: 'ui-changed', next: 'complete' }],
    } as WorkflowProfileInput);
    expect(writer.issues.map((i) => i.field)).toContain('when');
  });

  it('refuses a condition before any stage that changes files, or off the main path', () => {
    const first = validateWorkflow({
      id: 'custom',
      name: 'Custom',
      stages: [
        { key: 'critique', name: 'Visual critique', role: 'visual-critic', permissionLevel: 1, verdict: true, when: 'ui-changed', next: 'implement' },
        { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'complete' },
      ],
    } as WorkflowProfileInput);
    expect(first.issues.find((i) => i.field === 'when')?.message).toMatch(/after a stage that changes files/);
  });

  it('requires approval on every attempt, and one attempt, for a design stage that could spend', () => {
    const paid = (patch: Record<string, unknown>) =>
      validateWorkflow({
        id: 'custom',
        name: 'Custom',
        stages: [{ key: 'assets', name: 'Assets', role: 'designer', permissionLevel: 3, next: 'complete', ...patch }],
      } as WorkflowProfileInput).issues.map((i) => i.field);
    expect(paid({})).toEqual(['permissionLevel']);
    expect(paid({ requiresApproval: true, retry: { maxAttempts: 2 } })).toEqual(['retry']);
    expect(paid({ requiresApproval: true })).toEqual([]);
    // Any role on the frontend-design profile counts; Level 2 never can spend.
    expect(paid({ role: 'implementer', toolProfile: 'frontend-design' })).toEqual(['permissionLevel']);
    expect(paid({ permissionLevel: 2 })).toEqual([]);
  });
});
