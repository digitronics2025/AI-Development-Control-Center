import { describe, expect, it } from 'vitest';
import { classifyFailureText, describeExit, isProtocolEvent, summarizeFailure, SimulatedAgentAdapter } from '../src/index.js';

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

describe('crash evidence', () => {
  it('recognises agent protocol events, including lines the tail truncated', () => {
    expect(isProtocolEvent('{"type":"user","message":{"content":[{"type":"tool_result","content":"429\\tconst x')).toBe(true);
    expect(isProtocolEvent('  { "type": "turn.failed", "error": {} }')).toBe(true);
    expect(isProtocolEvent('Error: connect ECONNREFUSED')).toBe(false);
    expect(isProtocolEvent('{"error":"plain JSON on stderr"}')).toBe(false);
  });

  it('describes a crash without output in words, not as an unexplained number', () => {
    expect(describeExit('Claude Code', 3221226505)).toBe('Claude Code crashed (fatal internal error) · Windows status 0xC0000409');
    expect(describeExit('Codex', 0xc0000123)).toBe('Codex crashed · Windows status 0xC0000123');
    expect(describeExit('Codex', 1)).toBe('Codex exited with code 1 without reporting an error');
    expect(describeExit('Codex', null)).toBe('Codex stopped without an exit code');
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
