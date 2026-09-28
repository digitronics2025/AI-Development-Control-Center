#!/usr/bin/env node
// Test double for the Codex CLI. Behaviour is chosen by environment variables:
//   FAKE_CODEX_AUTH        chatgpt | apikey | none
//   FAKE_CODEX_SCENARIO    ok | usage | limit | auth | model | hang | secret | drift | thread-only
//   FAKE_CODEX_LIMIT_TEXT  the usage-limit message of the limit scenario (default names a 21:00 reset;
//                          the real wording is unconfirmed, docs/systems/agents-codex.md#usage-limits)
//   FAKE_CODEX_MCP_LIST    JSON printed by `mcp list --json` (default []), or `fail`
//   FAKE_CODEX_PLUGIN_MCP  JSON list of MCP servers the account's plugins add (default none)
//   FAKE_MCP_ARGS_FILE     where `mcp list` records its argv and cwd
//   FAKE_ARGS_FILE         where a run writes its launch record (the conformance kit's LaunchRecord)
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const after = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? '');
};

/**
 * What this run was given, and what the real CLI would make of it
 * (packages/agent-sdk/test-kit; docs/systems/agents-codex.md#mcp-servers-in-a-codex-run):
 * the MCP servers it would load and whether it could change files.
 */
function launchRecord(prompt) {
  const files = {};
  for (const arg of args) {
    try {
      if (statSync(arg).isFile()) files[arg] = readFileSync(arg, 'utf8');
    } catch {
      // not a file
    }
  }
  const overrides = args.flatMap((arg, i) => (arg === '-c' ? [args[i + 1] ?? ''] : []));
  const features = args.flatMap((arg, i) => (arg === '--disable' ? [args[i + 1] ?? ''] : []));
  let configured = [];
  try {
    configured = JSON.parse(process.env.FAKE_CODEX_MCP_LIST ?? '[]').map((server) => server.name);
  } catch {
    // an unreadable listing: the adapter refuses before a run
  }
  const off = new Set(overrides.map((o) => /^mcp_servers\.([A-Za-z0-9_-]+)=\{enabled=false,/.exec(o)?.[1]).filter(Boolean));
  const added = overrides.map((o) => /^mcp_servers\.([A-Za-z0-9_-]+)\.command=/.exec(o)?.[1]).filter(Boolean);
  const loaded = [
    ...[...configured, ...added].filter((name) => !off.has(name)),
    // The account's ChatGPT connectors and plugin servers load unless their features are off.
    ...(features.includes('apps') ? [] : ['codex_apps']),
    ...(features.includes('plugins') ? [] : JSON.parse(process.env.FAKE_CODEX_PLUGIN_MCP ?? '[]')),
  ];
  return {
    args,
    cwd: process.cwd(),
    env: Object.keys(process.env),
    stdin: prompt,
    files,
    mcpServers: [...new Set(loaded)],
    // Writes: any sandbox but read-only, or execpolicy rules loaded (an `allow` rule runs a command outside the sandbox).
    canWrite: after('--sandbox') !== 'read-only' || !args.includes('--ignore-rules') || args.includes('--dangerously-bypass-approvals-and-sandbox'),
  };
}

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

if (args[0] === 'mcp' && args[1] === 'list') {
  if (process.env.FAKE_MCP_ARGS_FILE) writeFileSync(process.env.FAKE_MCP_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd() }));
  if (process.env.FAKE_CODEX_MCP_LIST === 'fail') {
    console.error('Error: Unknown feature flag: plugins');
    process.exit(1);
  }
  process.stdout.write(process.env.FAKE_CODEX_MCP_LIST ?? '[]');
  process.exit(0);
}

if (args[0] === 'exec') {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (prompt += chunk));
  process.stdin.on('end', () => {
    const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'ok';
    if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(launchRecord(prompt)));
    if (scenario === 'drift') {
      // A future CLI that renamed its events: an answer, exit 0, none of the events a run always has.
      out({ type: 'session.created', session_id: 'thread-123' });
      out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'PONG' } });
      out({ type: 'response.completed', usage: { input_tokens: 10, output_tokens: 2 } });
      process.exit(0);
    }
    out({ type: 'thread.started', thread_id: 'thread-123' });
    if (scenario === 'thread-only') {
      // A thread, an answer and exit 0, but its turn never completes.
      out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'PONG' } });
      process.exit(0);
    }
    out({ type: 'turn.started' });
    out({ type: 'item.completed', item: { id: 'w', type: 'error', message: 'failed to parse hooks config' } });
    if (scenario === 'usage') {
      out({ type: 'turn.failed', error: { message: 'Your workspace is out of credits. Add credits to continue.' } });
      process.exit(1);
    }
    if (scenario === 'limit') {
      out({ type: 'turn.failed', error: { message: process.env.FAKE_CODEX_LIMIT_TEXT ?? "You've hit your usage limit. Try again at 21:00." } });
      process.exit(1);
    }
    if (scenario === 'auth') {
      // The ChatGPT session was signed out or expired mid-run.
      out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Your authentication token has expired. Please sign in again.' } });
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
