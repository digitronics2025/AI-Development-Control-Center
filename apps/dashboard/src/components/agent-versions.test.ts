import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '@acc/shared';
import { agentVersionText, testedText } from './agent-versions';

const agent = (detection: Partial<AgentInfo['detection']>, compat: AgentInfo['compat']) =>
  ({ name: 'Codex', detection: { found: true, executablePath: 'codex', version: null, error: null, ...detection }, compat }) as AgentInfo;

describe('installed agent versions (Settings → Agents & Models)', () => {
  it('shows the detected version', () => {
    expect(agentVersionText(agent({ version: '0.157.0' }, null))).toBe('v0.157.0');
    expect(agentVersionText(agent({ version: 'simulated' }, null))).toBe('simulated');
    expect(agentVersionText(agent({ version: null }, null))).toBe('Version unknown');
    expect(agentVersionText(agent({ found: false }, null))).toBe('Not detected');
  });

  it('names the tested versions, and nothing where no verdict applies', () => {
    expect(testedText(agent({ version: '0.157.0' }, { tested: { min: '0.156.1', max: '0.156.1' }, status: 'unverified' }))).toBe('Tested with version 0.156.1.');
    expect(testedText(agent({ version: '2.1.284' }, { tested: { min: '2.1.280', max: '2.1.283' }, status: 'unverified' }))).toBe('Tested with versions 2.1.280 to 2.1.283.');
    expect(testedText(agent({ version: '1.0.0' }, { tested: null, status: 'unverified' }))).toBe('No version of Codex has been tested with the Control Center.');
    expect(testedText(agent({ version: 'simulated' }, null))).toBeNull();
  });
});
