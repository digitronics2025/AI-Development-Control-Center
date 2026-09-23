#!/usr/bin/env node
// Test double for the Codex CLI. Behaviour is chosen by environment variables:
//   FAKE_CODEX_AUTH      chatgpt | apikey | none
//   FAKE_CODEX_SCENARIO  ok | usage | model | hang | secret
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');

if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}

if (args[0] === 'login' && args[1] === 'status') {
  const auth = process.env.FAKE_CODEX_AUTH ?? 'chatgpt';
  if (auth === 'chatgpt') console.log('Logged in using ChatGPT');
  else if (auth === 'apikey') console.log(`Logged in using an API key - ${['sk', 'proj', 'x'.repeat(20)].join('-')}`);
  else {
    console.log('Not logged in');
    process.exit(1);
  }
  process.exit(0);
}

if (args[0] === 'exec') {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (prompt += chunk));
  process.stdin.on('end', () => {
    const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'ok';
    if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd() }));
    out({ type: 'thread.started', thread_id: 'thread-123' });
    out({ type: 'turn.started' });
    out({ type: 'item.completed', item: { id: 'w', type: 'error', message: 'failed to parse hooks config' } });
    if (scenario === 'usage') {
      out({ type: 'turn.failed', error: { message: 'Your workspace is out of credits. Add credits to continue.' } });
      process.exit(1);
    }
    if (scenario === 'model') {
      out({
        type: 'turn.failed',
        error: { message: JSON.stringify({ error: { message: "The 'gpt-x' model requires a newer version of Codex." } }) },
      });
      process.exit(1);
    }
    if (scenario === 'hang') {
      out({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'sleep 999' } });
      setInterval(() => {}, 1000);
      return; // inside the stdin callback
    }
    out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'git status' } });
    out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'git status', exit_code: 0 } });
    out({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] } });
    const key = process.env.OPENAI_API_KEY ? "yes" : "no";
    const extra = scenario === 'secret' ? ` token ${['sk', 'ant', 'api03', 'X'.repeat(24)].join('-')}` : '';
    out({
      type: 'item.completed',
      item: { id: 'm', type: 'agent_message', text: `PONG cwd=${process.cwd()} ENV_HAS_OPENAI_KEY=${key} prompt=${prompt.trim().length}${extra}` },
    });
    out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80, reasoning_output_tokens: 30 } });
    process.exit(0);
  });
} else {
  console.error(`fake-codex: unsupported args ${args.join(' ')}`);
  process.exit(2);
}
