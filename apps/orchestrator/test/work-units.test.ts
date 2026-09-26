import { describe, expect, it } from 'vitest';
import { readManifest } from '../src/engine/work-units.js';

const block = (json: unknown) => `## Plan\n\nText.\n\n\`\`\`acc-work-units\n${JSON.stringify(json)}\n\`\`\`\n`;
const unit = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key, goal: `Do ${key}`, pathPrefixes: [`${key}/`], ...extra });

describe('readManifest (docs/plans/STAGE_TEAMS_PLAN.md §3.3)', () => {
  it('reads the last block meant for the stage and hashes it stably', () => {
    const plan = block({ version: 1, stage: 'other', units: [unit('x')] }) + block({ version: 1, stage: 'implement', units: [unit('api'), unit('web')] });
    const read = readManifest(plan, 'implement');
    expect(read.ok && read.manifest.units.map((u) => u.key)).toEqual(['api', 'web']);
    const again = readManifest(block({ units: [unit('api'), unit('web')], stage: 'implement', version: 1 }), 'implement');
    expect(read.ok && again.ok && read.hash === again.hash).toBe(true);
  });

  it('forgives what a real planner wrote: underscore keys and commands as checks (seen live 2026-09-26)', () => {
    const read = readManifest(
      block({
        version: 1,
        stage: 'implement',
        units: [
          unit('api_discount', { pathPrefixes: ['api/'], checks: ['node --test api/orders.test.js', 'test'] }),
          unit('web_quantity', { pathPrefixes: ['web/'], dependsOn: ['api_discount'], checks: ['node --test web/format.test.js'] }),
        ],
      }),
      'implement',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.manifest.units.map((u) => [u.key, u.dependsOn, u.checks])).toEqual([
      ['api-discount', [], ['test']],
      ['web-quantity', ['api-discount'], []],
    ]);
  });

  it('still refuses anything unsafe or ambiguous', () => {
    expect(readManifest('no block', 'implement')).toEqual({ ok: false, reason: 'the plan has no work-unit manifest' });
    expect(readManifest('```acc-work-units\n{not json}\n```', 'implement')).toMatchObject({ ok: false, reason: 'the work-unit manifest is not valid JSON' });
    expect(readManifest(block({ version: 1, stage: 'implement', units: [unit('a', { pathPrefixes: ['../x/'] })] }), 'implement').ok).toBe(false);
    expect(readManifest(block({ version: 1, stage: 'implement', units: [unit('a', { pathPrefixes: ['C:/Windows/'] })] }), 'implement').ok).toBe(false);
    expect(readManifest(block({ version: 1, stage: 'fix', units: [unit('a')] }), 'implement')).toMatchObject({ ok: false, reason: 'the work-unit manifest is for stage "fix", not "implement"' });
    expect(readManifest('```acc-work-units\n' + 'x'.repeat(21_000) + '\n```', 'implement')).toMatchObject({ ok: false });
  });
});
