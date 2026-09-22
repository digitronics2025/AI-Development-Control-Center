#!/usr/bin/env node
// Test double for the Claude Code CLI. Behaviour is chosen by environment variables:
//   FAKE_CLAUDE_AUTH            subscription | apikey | none
//   FAKE_CLAUDE_APIKEY_SOURCE   value reported in the init event (default "none")
//   FAKE_CLAUDE_SCENARIO        ok | usage | hang | error
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
    if (scenario === 'usage') {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790122800, rateLimitType: 'five_hour' } });
      out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 9pm" });
      process.exit(1);
    }
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
      result: `PONG cwd=${process.cwd()} ENV_HAS_ANTHROPIC_KEY=${key} prompt=${prompt.trim().length}`,
    });
    process.exit(0);
  });
} else {
  console.error(`fake-claude: unsupported args ${args.join(' ')}`);
  process.exit(2);
}
