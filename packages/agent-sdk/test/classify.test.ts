import { describe, expect, it } from 'vitest';
import { classifyFailureText, summarizeFailure, SimulatedAgentAdapter } from '../src/index.js';

describe('classifyFailureText', () => {
  it.each([
    ['Your workspace is out of credits. Add credits to continue.', 'USAGE_LIMIT'],
    ["You've hit your limit · resets 9pm", 'USAGE_LIMIT'],
    ['Error 429 Too Many Requests', 'USAGE_LIMIT'],
    ['Not logged in · Please run /login', 'AUTH_FAILURE'],
    ['OAuth token has expired', 'AUTH_FAILURE'],
    ["The 'gpt-6' model requires a newer version of Codex", 'MODEL_UNAVAILABLE'],
    ['model gpt-foo does not exist', 'MODEL_UNAVAILABLE'],
    ['Prompt is too long', 'CONTEXT_FAILURE'],
    ['EACCES: permission denied, open x', 'PERMISSION_DENIED'],
  ] as const)('%s → %s', (text, expected) => {
    expect(classifyFailureText(text)).toBe(expected);
  });

  it('returns null for unrecognised text', () => {
    expect(classifyFailureText('segmentation fault')).toBeNull();
  });

  it('summarises with the most explanatory line', () => {
    expect(summarizeFailure([], ['noise', 'You have hit your usage limit', 'more noise'])).toBe('You have hit your usage limit');
  });
});

describe('SimulatedAgentAdapter', () => {
  it('returns verdicts and honours scenario markers', async () => {
    SimulatedAgentAdapter.reset();
    const sim = new SimulatedAgentAdapter('sim', undefined, 5);
    const run = async (role: string, extra = '') =>
      (
        await (
          await sim.execute({
            executionId: Math.random().toString(),
            cwd: process.cwd(),
            prompt: `Task: TASK-0009\nRole: ${role}\n${extra}`,
            model: 'default',
            effort: 'default',
            permissionLevel: 1,
            timeoutMs: 1000,
            billingMode: 'subscription',
            baseEnv: {},
          })
        ).done
      );
    expect((await run('reviewer')).output).toContain('VERDICT: PASS');
    expect((await run('reviewer', '[sim:review-fail-once]')).output).toContain('VERDICT: FAIL');
    expect((await run('reviewer', '[sim:review-fail-once]')).output).toContain('VERDICT: PASS');
    expect((await run('planner', '[sim:fail:planner]')).errorClass).toBe('PROCESS_CRASH');
  });
});
