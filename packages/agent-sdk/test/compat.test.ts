import { describe, expect, it } from 'vitest';
import { cliCompat, TESTED_CLI_VERSIONS } from '../src/compat.js';

const RANGES = { claude: { min: '2.1.280', max: '2.1.283' }, solo: { min: '0.156.1', max: '0.156.1' } };

describe('tested CLI versions (agents.compat.json)', () => {
  it('calls a version inside the inclusive range tested', () => {
    for (const version of ['2.1.280', '2.1.281', '2.1.283']) expect(cliCompat('claude', version, RANGES)).toEqual({ tested: RANGES.claude, status: 'tested' });
    expect(cliCompat('solo', '0.156.1', RANGES).status).toBe('tested');
  });

  it('calls a version outside the range unverified, compared by number rather than text', () => {
    for (const version of ['2.1.279', '2.1.284', '2.2.0', '3.0.0', '1.9.999', '2.1.2830']) expect(cliCompat('claude', version, RANGES)).toEqual({ tested: RANGES.claude, status: 'unverified' });
    // '0.156.10' sorts before '0.156.2' as text; as a version it is newer than anything tested.
    expect(cliCompat('solo', '0.156.10', RANGES).status).toBe('unverified');
    expect(cliCompat('solo', '0.156.0', RANGES).status).toBe('unverified');
  });

  it('fails closed on what it cannot place: a suffixed or odd version, or an agent with no range', () => {
    for (const version of ['2.1.283-beta.1', '2.1.283+build', 'v2.1.283', '2.1', '', 'simulated']) expect(cliCompat('claude', version, RANGES).status).toBe('unverified');
    expect(cliCompat('gemini', '1.0.0', RANGES)).toEqual({ tested: null, status: 'unverified' });
    // Inherited object keys are not agent ids.
    expect(cliCompat('toString', '1.0.0', RANGES)).toEqual({ tested: null, status: 'unverified' });
  });

  it('declares a plain x.y.z range for both CLI adapters', () => {
    for (const id of ['claude', 'codex']) {
      const range = TESTED_CLI_VERSIONS[id]!;
      expect(range.min).toMatch(/^\d+\.\d+\.\d+$/);
      expect(range.max).toMatch(/^\d+\.\d+\.\d+$/);
      expect(cliCompat(id, range.min).status).toBe('tested');
      expect(cliCompat(id, range.max).status).toBe('tested');
    }
  });
});
