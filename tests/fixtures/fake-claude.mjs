#!/usr/bin/env node
// Test double for the Claude Code CLI. Behaviour is chosen by environment variables:
//   FAKE_CLAUDE_AUTH            subscription | apikey | none
//   FAKE_CLAUDE_APIKEY_SOURCE   apiKeySource in the init event ("none" for a subscription login). Unset: the
//                               event has none. Anything but "none" keeps the run going until it is stopped.
//   FAKE_CLAUDE_INIT_SUBTYPE    subtype of the run's first system event (default init; anything else: a run without one)
//   FAKE_CLAUDE_SCENARIO        ok | usage | auth | model | hang | error | long | crash | skill | silent (exit 0, no output)
//   FAKE_CLAUDE_SKILLS_JSON     file with { skills, plugins } for the `/skills` lookup (default none)
//   FAKE_CLAUDE_MCP_SERVERS     JSON list of the operator's own MCP servers (default none)
//   FAKE_ARGS_FILE              where a run writes its launch record (the conformance kit's LaunchRecord)
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const isOption = (arg) => arg.length > 1 && arg.startsWith('-');
/**
 * Every value of a variadic option (commander `<values...>`, as 2.1.283 declares
 * --tools, --disallowedTools and --mcp-config): the next argument and each one
 * up to the next option, or `--flag=value`; a repeated flag adds to the earlier
 * ones. Null when the option is absent.
 */
const variadic = (...flags) => {
  let values = null;
  for (let i = 0; i < args.length; i++) {
    const inline = flags.find((flag) => args[i].startsWith(`${flag}=`));
    if (inline) (values ??= []).push(args[i].slice(inline.length + 1));
    else if (flags.includes(args[i]) && i + 1 < args.length) {
      (values ??= []).push(args[++i]);
      while (i + 1 < args.length && !isOption(args[i + 1])) values.push(args[++i]);
    }
  }
  return values;
};
/** Tool names, comma or space separated. */
const toolNames = (values) => (values ?? []).flatMap((value) => value.split(/[\s,]+/)).filter(Boolean);

/**
 * What this run was given, and what the real CLI would make of it
 * (packages/agent-sdk/test-kit): the MCP servers it would load and whether it
 * could change files.
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
  // The operator's own servers join unless --strict-mcp-config; each --mcp-config value (inline JSON or a file) adds its own.
  const named = (variadic('--mcp-config') ?? []).flatMap((config) =>
    Object.keys(JSON.parse(config.trim().startsWith('{') ? config : readFileSync(config, 'utf8')).mcpServers ?? {}),
  );
  const personal = args.includes('--strict-mcp-config') ? [] : JSON.parse(process.env.FAKE_CLAUDE_MCP_SERVERS ?? '[]');
  // Tools that change files: without --tools (or with "default") every tool exists; a --disallowedTools entry naming the tool itself removes it.
  const writers = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
  const given = variadic('--tools');
  const tools = given === null || toolNames(given).includes('default') ? writers : toolNames(given);
  const denied = toolNames(variadic('--disallowedTools', '--disallowed-tools'));
  return {
    args,
    cwd: process.cwd(),
    env: Object.keys(process.env),
    stdin: prompt,
    files,
    mcpServers: [...new Set([...personal, ...named])],
    canWrite: tools.some((tool) => writers.includes(tool) && !denied.includes(tool)),
  };
}

if (args[0] === '--version') {
  // FAKE_CLAUDE_VERSION: an installed version to compare with agents.compat.json.
  console.log(`${process.env.FAKE_CLAUDE_VERSION ?? '9.9.9'} (Claude Code)`);
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
    if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(launchRecord(prompt)));
    if (scenario === 'model') {
      // A CLI older than the adapter's flags refuses them before it starts (MODEL_UNAVAILABLE: update the CLI).
      console.error("error: unknown option '--tools'");
      process.exit(1);
    }
    if (scenario === 'silent') process.exit(0);
    if (prompt.trim() === '/skills') {
      // The local /skills command: an init event naming skills and plugin folders, then a 0-turn result (as 2.1.280 does).
      const listed = process.env.FAKE_CLAUDE_SKILLS_JSON ? JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SKILLS_JSON, 'utf8')) : { skills: [], plugins: [] };
      out({ type: 'system', subtype: 'init', session_id: 'sess-skills', model: 'claude-test', apiKeySource: 'none', claude_code_version: '9.9.9', ...listed });
      // FAKE_CLAUDE_SKILLS_SPENDS=1: a CLI that sent /skills to the model.
      const spent = process.env.FAKE_CLAUDE_SKILLS_SPENDS === '1';
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: spent ? 1 : 0, total_cost_usd: spent ? 0.001 : 0, result: '' });
      process.exit(0);
    }
    const source = process.env.FAKE_CLAUDE_APIKEY_SOURCE;
    out({
      type: 'system',
      subtype: process.env.FAKE_CLAUDE_INIT_SUBTYPE ?? 'init',
      session_id: 'sess-1',
      model: 'claude-test',
      permissionMode: args[args.indexOf('--permission-mode') + 1],
      ...(source === undefined ? {} : { apiKeySource: source }),
      claude_code_version: '9.9.9',
      ...(scenario === 'skill' ? { skills: ['docs-systems', 'fix-bug', 'ship-it'] } : {}),
    });
    if (scenario === 'hang' || source !== 'none') {
      setInterval(() => {}, 1000);
      return; // inside the stdin callback
    }
    if (scenario === 'auth') {
      // The subscription session was signed out or expired mid-run.
      out({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 401,
        result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
      });
      process.exit(1);
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
    if (scenario === 'crash') {
      // Observed 2026-09-24: the CLI read a file, then died (0xC0000409) with no result event.
      // What it read mentions credits and has a line 429; neither is why it failed.
      out({ type: 'user', message: { content: [{ type: 'tool_result', content: "429\tif (/out of credits/.test(text)) return 'USAGE_LIMIT';" }] } });
      process.exit(3);
    }
    if (scenario === 'skill') {
      // One skill runs; one is refused by the stage policy. Skill args are free text and must never be logged.
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'fix-bug', args: 'private-args-text' } }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Launching skill: fix-bug' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Done', permission_denials: [{ tool_name: 'Skill', tool_input: { skill: 'ship-it', args: 'private-args-text' } }] });
      process.exit(0);
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
      result: `PONG cwd=${process.cwd()} ENV_HAS_ANTHROPIC_KEY=${key} prompt=${prompt.trim().length} TOOL_SESSION=${process.env.ACC_TOOL_SESSION ?? 'none'}`,
    });
    process.exit(0);
  });
} else {
  console.error(`fake-claude: unsupported args ${args.join(' ')}`);
  process.exit(2);
}
