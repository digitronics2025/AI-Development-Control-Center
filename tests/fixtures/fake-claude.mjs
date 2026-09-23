#!/usr/bin/env node
// Test double for the Claude Code CLI. Behaviour is chosen by environment variables:
//   FAKE_CLAUDE_AUTH            subscription | apikey | none
//   FAKE_CLAUDE_APIKEY_SOURCE   value reported in the init event (default "none")
//   FAKE_CLAUDE_SCENARIO        ok | usage | hang | error | long
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');

if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? 'subscription';
  if (auth === 'none') {
    console.log(JSON.stringify({ loggedIn: false }));
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      auth === 'subscription'
        ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }
        : { loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' },
    ),
  );
  process.exit(0);
}

if (args[0] === '-p') {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (prompt += chunk));
  process.stdin.on('end', () => {
    const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'ok';
    if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd() }));
    out({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-test',
      permissionMode: args[args.indexOf('--permission-mode') + 1],
      apiKeySource: process.env.FAKE_CLAUDE_APIKEY_SOURCE ?? 'none',
      claude_code_version: '9.9.9',
    });
    if (scenario === 'hang' || (process.env.FAKE_CLAUDE_APIKEY_SOURCE ?? 'none') !== 'none') {
      setInterval(() => {}, 1000);
      return; // inside the stdin callback
    }
    if (scenario === 'long') {
      // Real sessions emit single JSON lines far past any display limit: a
      // large file read, then a long final answer. Written in small pieces so
      // each line reaches the reader across many chunks.
      const lines = [
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'r'.repeat(120_000) }] } },
        { type: 'result', subtype: 'success', is_error: false, result: `## Findings\n${'f'.repeat(30_000)}\nEND` },
      ].map((event) => JSON.stringify(event) + '\r\n');
      const text = lines.join('');
      let offset = 0;
      const writeNext = () => {
        if (offset >= text.length) return process.exit(0);
        const piece = text.slice(offset, offset + 4096);
        offset += piece.length;
        process.stdout.write(piece, writeNext);
      };
      writeNext();
      return;
    }
    if (scenario === 'usage') {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790122800, rateLimitType: 'five_hour' } });
      out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 9pm" });
      process.exit(1);
    }
    // Shapes observed from Claude Code 2.1.280 (tests/fixtures/claude-2.1.280-usage.jsonl).
    out({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1790184000,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'out_of_credits',
        unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1790184000 }, seven_day: { utilization: 0.46, resetsAt: 1790596800 } },
      },
    });
    out({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/b.ts' } },
          { type: 'text', text: 'Working on it' },
        ],
      },
    });
    const key = process.env.ANTHROPIC_API_KEY ? "yes" : "no";
    if (scenario === 'error') {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Something broke' });
      process.exit(1);
    }
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'sess-1',
      num_turns: 1,
      duration_api_ms: 2021,
      total_cost_usd: 0.0331379,
      usage: { input_tokens: 9, cache_creation_input_tokens: 14666, cache_read_input_tokens: 26009, output_tokens: 47, cache_creation: { ephemeral_1h_input_tokens: 14666, ephemeral_5m_input_tokens: 0 } },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 910,
          outputTokens: 59,
          cacheReadInputTokens: 26009,
          cacheCreationInputTokens: 14666,
          costUSD: 0.0331379,
          thinkingTokens: 38,
          canonicalModel: 'claude-haiku-4-5',
        },
      },
      result: `PONG cwd=${process.cwd()} ENV_HAS_ANTHROPIC_KEY=${key} prompt=${prompt.trim().length}`,
    });
    process.exit(0);
  });
} else {
  console.error(`fake-claude: unsupported args ${args.join(' ')}`);
  process.exit(2);
}
