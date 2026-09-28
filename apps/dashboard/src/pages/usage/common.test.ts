import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '@acc/shared';
import { providerLabels, providerOptions } from './common';

const agent = (id: string, provider: string, providerLabel: string) => ({ id, provider, capabilities: { providerLabel } }) as AgentInfo;

describe('provider names from the agents (GET /api/agents)', () => {
  const agents = [agent('codex', 'openai', 'OpenAI (Codex)'), agent('claude', 'anthropic', 'Anthropic (Claude Code)'), agent('claude-2', 'anthropic', 'Anthropic, again')];

  it('offers each provider once, named by the first agent that declares it', () => {
    expect(providerOptions(agents)).toEqual([
      { value: 'openai', label: 'OpenAI (Codex)' },
      { value: 'anthropic', label: 'Anthropic (Claude Code)' },
    ]);
    // Not health-checked yet: no declared name, so no choice to offer.
    expect(providerOptions([agent('codex', 'openai', '')])).toEqual([]);
  });

  it('names a provider no agent declares by its key', () => {
    const label = providerLabels(agents);
    expect(label('anthropic')).toBe('Anthropic (Claude Code)');
    expect(label('simulated')).toBe('simulated');
    expect(providerLabels([])('openai')).toBe('openai');
  });
});
