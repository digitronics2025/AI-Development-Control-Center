/**
 * The adapter conformance kit (docs/systems/agents.md#adapter-conformance-kit).
 *
 * The security-critical behaviour every agent adapter must show, checked
 * against the adapter's fake CLI (tests/fixtures/fake-*.mjs): the prompt only
 * on stdin; no run on API billing in Subscription Only mode; API billing
 * variables stripped; the tool session token only in the environment; no MCP
 * server but the Control Center's; Level 1 cannot change files; usage limits,
 * sign-in and model failures classified; usage `null` when none was reported;
 * the capabilities the Control Center decides by (provider label, permission
 * ceiling, plugin folders) declared, and true.
 * Adapter-specific guards (Claude Code's shell precheck, the Codex sandbox
 * flags) stay in each adapter's own tests.
 *
 * `adapterConformance(target)` registers one test per check. Each check is also
 * a plain function (`runConformanceCheck`) that throws `ConformanceFailure`, so
 * a test can prove a deliberately broken adapter fails it.
 *
 * A fake CLI takes part by writing a `LaunchRecord` to `$FAKE_ARGS_FILE` when a
 * run starts, and by offering the `FakeScenario`s through its environment.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { API_BILLING_ENV_VARS } from '@acc/security';
import { PERMISSION_LEVELS, type ErrorClass } from '@acc/shared';
import { AgentGuardError, type AgentAdapter, type AgentExecutionHandle, type AgentExecutionInput, type AgentExecutionResult } from '../src/index.js';

/** What a fake CLI writes to `$FAKE_ARGS_FILE` when a run starts. */
export interface LaunchRecord {
  args: string[];
  cwd: string;
  /** Names of the variables in the CLI's environment (never their values). */
  env: string[];
  /** Everything that arrived on stdin. */
  stdin: string;
  /** Contents of the files the arguments name, as the CLI found them at launch. */
  files: Record<string, string>;
  /** MCP servers the real CLI would load given these arguments and the fake's configured servers. */
  mcpServers: string[];
  /** Whether the real CLI could change files given these arguments. */
  canWrite: boolean;
}

/** Behaviours the fake CLI offers, each chosen by environment variables. */
export type FakeScenario =
  /** Signed in with an API key instead of the subscription. */
  | 'apiKeyLogin'
  /** The subscription's usage window or credits are exhausted during the run. */
  | 'usageLimit'
  /** The subscription session is signed out or expired during the run. */
  | 'authFailure'
  /** The CLI cannot run the requested model, or is older than the adapter's flags. */
  | 'modelUnavailable'
  /** The run keeps going until it is stopped. */
  | 'hang'
  /** The operator has personal MCP servers (and, where the CLI has them, account plugin servers) configured. */
  | 'personalMcp';

export interface FakeCli {
  /** The fake's executable, as `executablePath` (the `.cmd` shim on Windows). */
  executable: string;
  /** Environment every run gets: a signed-in subscription and a successful run. */
  env?: NodeJS.ProcessEnv;
  scenarios: Record<FakeScenario, NodeJS.ProcessEnv>;
}

export interface ConformanceTarget {
  /** How test names call the adapter. */
  name: string;
  /** A fresh adapter per launch (no shared health cache). */
  makeAdapter: () => AgentAdapter;
  fakeCli: FakeCli;
}

/** A conformance check that did not hold, with what the adapter did. */
export class ConformanceFailure extends Error {
  override readonly name = 'ConformanceFailure';
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

const CHECK_TIMEOUT_MS = 90_000;
/** A program that exists, for tool bridges and shell guards the fakes never start. */
const EXISTING_PROGRAM = import.meta.filename;

interface Launch {
  adapter: AgentAdapter;
  input: AgentExecutionInput;
  /** The run's parsed log lines. */
  lines: string[];
  /** The fake's launch record; null when the CLI never started a run. */
  record: () => LaunchRecord | null;
}

function prepare(target: ConformanceTarget, overrides: Partial<AgentExecutionInput> = {}, env: NodeJS.ProcessEnv = {}): Launch {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-conformance-'));
  const recordFile = path.join(cwd, 'launch.json');
  const lines: string[] = [];
  const input: AgentExecutionInput = {
    executionId: `conformance-${randomUUID()}`,
    cwd,
    prompt: `Reply with PONG. Conformance run ${randomUUID()}`,
    model: 'default',
    effort: 'default',
    permissionLevel: 1,
    timeoutMs: 30_000,
    billingMode: 'subscription',
    baseEnv: { ...process.env, ...target.fakeCli.env, ...env, FAKE_ARGS_FILE: recordFile },
    executablePath: target.fakeCli.executable,
    onLine: (_stream, text) => lines.push(text),
    ...overrides,
  };
  const record = () => (existsSync(recordFile) ? (JSON.parse(readFileSync(recordFile, 'utf8')) as LaunchRecord) : null);
  return { adapter: target.makeAdapter(), input, lines, record };
}

interface Run extends Launch {
  handle: AgentExecutionHandle;
  result: AgentExecutionResult;
  launched: LaunchRecord;
}

/**
 * `whileRunning` is called as soon as the run has started, before the adapter's
 * end-of-run cleanup can have removed anything it wrote for the CLI.
 */
async function run(target: ConformanceTarget, overrides: Partial<AgentExecutionInput> = {}, env: NodeJS.ProcessEnv = {}, whileRunning?: () => void): Promise<Run> {
  const launch = prepare(target, overrides, env);
  const handle = await launch.adapter.execute(launch.input);
  // Synchronous, so no exit event (and no cleanup after it) can come first.
  whileRunning?.();
  const result = await handle.done;
  const launched = launch.record();
  must(launched, `the fake CLI never started a run (${result.status}${result.errorMessage ? `: ${result.errorMessage}` : ''})`);
  return { ...launch, handle, result, launched };
}

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Any piece of the prompt this long counts as the prompt: a truncated or partial copy leaks it too. */
const PROMPT_PIECE = 12;

/** Whether `text` holds a run of `PROMPT_PIECE` or more consecutive characters of `prompt`. */
function holdsPromptPiece(text: string, prompt: string): boolean {
  for (let i = 0; i + PROMPT_PIECE <= prompt.length; i++) if (text.includes(prompt.slice(i, i + PROMPT_PIECE))) return true;
  return false;
}

/** The temporary folder when a check starts: each entry's modification time. */
interface TempSnapshot {
  root: string;
  entries: Map<string, number>;
}

function snapshotTemp(): TempSnapshot {
  const root = os.tmpdir();
  const entries = new Map<string, number>();
  for (const name of readdirSync(root)) {
    try {
      entries.set(name, lstatSync(path.join(root, name)).mtimeMs);
    } catch {
      // removed meanwhile
    }
  }
  return { root, entries };
}

/**
 * Files under the temporary folder's entries that are new or changed since
 * `before` (a file written again, a folder given a new file), in their folders
 * too, whose text holds `needle`. Symbolic links are not followed; the walk of
 * each entry is bounded, since other tests' folders appear there meanwhile.
 * A folder whose file is only rewritten keeps its time: `withFreshTemp` covers
 * that for every path the adapter takes from `os.tmpdir()` during the run.
 */
function tempFilesHolding(needle: string, before: TempSnapshot): string[] {
  const found: string[] = [];
  let budget = 0;
  const visit = (file: string, depth: number) => {
    if (budget-- <= 0) return;
    try {
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        if (depth < 6) for (const name of readdirSync(file)) visit(path.join(file, name), depth + 1);
      } else if (stat.isFile() && stat.size < 1_000_000 && readFileSync(file, 'utf8').includes(needle)) {
        found.push(file);
      }
    } catch {
      // removed meanwhile, or locked (another test's file)
    }
  };
  for (const name of readdirSync(before.root)) {
    const entry = path.join(before.root, name);
    const was = before.entries.get(name);
    try {
      if (was !== undefined && lstatSync(entry).mtimeMs === was) continue;
    } catch {
      continue; // removed meanwhile
    }
    budget = 2_000;
    visit(entry, 0);
  }
  return found;
}

const TEMP_VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const;

/**
 * Runs `body` with the temporary folder (`os.tmpdir()` here and in the CLI)
 * moved to a new, empty one inside it: whatever the adapter writes there, under
 * a name it reuses every run or not, is new to `tempFilesHolding`.
 */
async function withFreshTemp<T>(body: () => Promise<T>): Promise<T> {
  const fresh = mkdtempSync(path.join(os.tmpdir(), 'acc-conformance-temp-'));
  const saved = TEMP_VARIABLES.map((name) => [name, process.env[name]] as const);
  for (const name of TEMP_VARIABLES) process.env[name] = fresh;
  try {
    return await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

function bridgeFor(session: string): NonNullable<AgentExecutionInput['toolBridge']> {
  return { name: 'acc', command: process.execPath, args: [EXISTING_PROGRAM], env: { ACC_TOOL_URL: 'http://127.0.0.1:9', ACC_TOOL_SESSION: session } };
}

export interface ConformanceCheck {
  title: string;
  run: (target: ConformanceTarget) => Promise<void>;
}

export const CONFORMANCE_CHECKS = {
  promptOnStdin: {
    title: 'sends the prompt on stdin, never in the arguments or the displayed command line',
    async run(target) {
      const r = await run(target);
      const { prompt } = r.input;
      must(r.launched.stdin.trim() === prompt, 'control: the prompt did not arrive on stdin');
      const inArgs = r.launched.args.filter((arg) => holdsPromptPiece(arg, prompt));
      must(!inArgs.length, `the prompt is in the CLI's arguments: ${clip(inArgs.join(' '))}`);
      must(!holdsPromptPiece(r.handle.commandLine, prompt), `the prompt is in the displayed command line: ${clip(r.handle.commandLine)}`);
    },
  },
  apiBillingBlocked: {
    title: 'refuses to run a CLI signed in with API billing in Subscription Only mode, before it starts',
    async run(target) {
      const launch = prepare(target, {}, target.fakeCli.scenarios.apiKeyLogin);
      const health = await launch.adapter.healthCheck(launch.input);
      must(health.state === 'api_billing_blocked', `health is ${health.state} (billing ${health.billing}) for an API-key sign-in in Subscription Only mode`);
      let refusal: unknown = null;
      try {
        const handle = await launch.adapter.execute(launch.input);
        await launch.adapter.cancel(launch.input.executionId);
        await handle.done;
      } catch (error) {
        refusal = error;
      }
      must(refusal, 'it started a run signed in with an API key in Subscription Only mode');
      must(refusal instanceof AgentGuardError && refusal.errorClass === 'AUTH_FAILURE', `the refusal is not an AUTH_FAILURE guard error: ${String(refusal)}`);
      must(launch.record() === null, 'the CLI started a run before the refusal');
      // The mode decides, not the sign-in: API billing mode may use the key.
      const api = await target.makeAdapter().healthCheck({ ...launch.input, billingMode: 'api' });
      must(api.state === 'connected', `control: API billing mode is not connected either (${api.state})`);
    },
  },
  billingEnvStripped: {
    title: 'strips every API billing variable from the CLI environment in Subscription Only mode',
    async run(target) {
      const planted = Object.fromEntries(API_BILLING_ENV_VARS.map((name) => [name, 'acc-conformance-planted']));
      const r = await run(target, {}, { ...planted, ACC_CONFORMANCE_MARK: '1' });
      const names = new Set(r.launched.env.map((name) => name.toUpperCase()));
      must(names.has('ACC_CONFORMANCE_MARK'), 'control: an ordinary variable did not reach the CLI, so its environment was not seen');
      const leaked = API_BILLING_ENV_VARS.filter((name) => names.has(name.toUpperCase()));
      must(!leaked.length, `API billing variables reached the CLI in Subscription Only mode: ${leaked.join(', ')}`);
    },
  },
  sessionTokenPrivate: {
    title: "keeps the tool session token in the CLI environment, out of its arguments and every file it is given",
    async run(target) {
      const token = `acc-conformance-session-${randomUUID()}`;
      const before = snapshotTemp();
      // Looked for while the run is on too: a file removed when it ends was still there for the CLI and anyone else to read.
      let during: string[] = [];
      const r = await withFreshTemp(() =>
        run(
          target,
          {
            permissionLevel: 2,
            toolBridge: bridgeFor(token),
            shellGuard: { command: process.execPath, args: [EXISTING_PROGRAM], env: { ACC_TOOL_SESSION: token } },
          },
          {},
          () => (during = tempFilesHolding(token, before)),
        ),
      );
      must(r.launched.env.some((name) => name.toUpperCase() === 'ACC_TOOL_SESSION'), 'control: the tool session did not reach the CLI through its environment');
      must(!r.launched.args.some((arg) => arg.includes(token)), "the session token is in the CLI's arguments");
      must(!r.handle.commandLine.includes(token), 'the session token is in the displayed command line');
      const given = Object.entries(r.launched.files).filter(([, content]) => content.includes(token)).map(([file]) => file);
      must(!given.length, `a file the CLI was given holds the session token: ${given.join(', ')}`);
      const held = [...new Set([...during, ...tempFilesHolding(token, before)])];
      must(!held.length, `a temporary file holds the session token: ${held.join(', ')}`);
    },
  },
  strictMcp: {
    title: "lets no MCP server but the Control Center's join a run",
    async run(target) {
      const personal = target.fakeCli.scenarios.personalMcp;
      const bridged = await run(target, { permissionLevel: 2, toolBridge: bridgeFor('conformance-session') }, personal);
      const withBridge = [...bridged.launched.mcpServers].sort();
      must(withBridge.length === 1 && withBridge[0] === 'acc', `a run with the Control Center bridge loads MCP servers ${JSON.stringify(withBridge)}, not only "acc"`);
      const plain = await run(target, { permissionLevel: 1 }, personal);
      must(!plain.launched.mcpServers.length, `a run without the bridge loads MCP servers ${JSON.stringify(plain.launched.mcpServers)}`);
    },
  },
  levelOneReadOnly: {
    title: 'gives a Level 1 run no way to change files, whatever the user config',
    async run(target) {
      for (const loadUserConfig of [false, true]) {
        const r = await run(target, { permissionLevel: 1, loadUserConfig });
        must(!r.launched.canWrite, `a Level 1 run (user config ${loadUserConfig ? 'on' : 'off'}) can change files: ${clip(r.launched.args.join(' '))}`);
      }
      const control = await run(target, { permissionLevel: 2 });
      must(control.launched.canWrite, 'control: a Level 2 run cannot change files either, so the fake CLI does not tell writing apart');
    },
  },
  failureClasses: {
    title: 'classifies a usage limit, a sign-in failure and an unavailable model',
    async run(target) {
      const cases: Array<[FakeScenario, ErrorClass]> = [
        ['usageLimit', 'USAGE_LIMIT'],
        ['authFailure', 'AUTH_FAILURE'],
        ['modelUnavailable', 'MODEL_UNAVAILABLE'],
      ];
      for (const [scenario, expected] of cases) {
        const { result } = await run(target, {}, target.fakeCli.scenarios[scenario]);
        must(
          result.status === 'failed' && result.errorClass === expected,
          `${scenario} ended ${result.status} ${result.errorClass ?? '(no class)'}, not failed ${expected}${result.errorMessage ? ` — ${clip(result.errorMessage, 200)}` : ''}`,
        );
      }
    },
  },
  usageNullNotZero: {
    title: 'reports usage as null, never zero, when the CLI reported none',
    async run(target) {
      const ok = await run(target);
      must(ok.result.status === 'succeeded' && ok.result.usage && ok.result.usage.lines.length > 0, `control: a successful run reported no usage (${ok.result.status})`);
      const limited = await run(target, {}, target.fakeCli.scenarios.usageLimit);
      must(limited.result.usage === null, `a run that reported no usage says ${clip(JSON.stringify(limited.result.usage))} instead of null`);
      // Stopped before any summary: nothing was reported, so nothing is claimed.
      const launch = prepare(target, {}, target.fakeCli.scenarios.hang);
      const handle = await launch.adapter.execute(launch.input);
      await until(() => launch.lines.length > 0, 10_000);
      await launch.adapter.cancel(launch.input.executionId);
      const cancelled = await handle.done;
      must(cancelled.status === 'cancelled', `control: the stopped run ended ${cancelled.status}`);
      must(cancelled.usage === null, `a run stopped before its summary says ${clip(JSON.stringify(cancelled.usage))} instead of null`);
    },
  },
  declaredCapabilities: {
    title: 'declares a provider label and a permission ceiling, and loads the plugin folders it says it loads',
    async run(target) {
      const caps = await target.makeAdapter().getCapabilities();
      must(typeof caps.providerLabel === 'string' && caps.providerLabel.trim() !== '', `the provider label is ${JSON.stringify(caps.providerLabel)}`);
      // The launch refusal compares levels with it: anything but a Level 1–5 would let a run past or stop every one.
      must((PERMISSION_LEVELS as readonly unknown[]).includes(caps.maxPermissionLevel), `the permission ceiling is ${JSON.stringify(caps.maxPermissionLevel)}, not one of Levels 1–5`);
      // A run is told a learned skill "is loaded" on the strength of this declaration alone.
      if (caps.pluginDirs) {
        const folder = mkdtempSync(path.join(os.tmpdir(), 'acc-conformance-plugin-'));
        const r = await run(target, { permissionLevel: 2, pluginDirs: [folder] });
        must(r.launched.args.includes(folder), `it declares pluginDirs, but the CLI was not given the plugin folder: ${clip(r.launched.args.join(' '))}`);
      }
    },
  },
} satisfies Record<string, ConformanceCheck>;

export type ConformanceCheckId = keyof typeof CONFORMANCE_CHECKS;

/** Run one check; it throws `ConformanceFailure` when the adapter does not hold it. */
export function runConformanceCheck(id: ConformanceCheckId, target: ConformanceTarget): Promise<void> {
  return CONFORMANCE_CHECKS[id].run(target);
}

/** Register every conformance check as a test of `target`. */
export function adapterConformance(target: ConformanceTarget): void {
  describe(`${target.name} adapter conformance`, () => {
    for (const check of Object.values(CONFORMANCE_CHECKS)) it(check.title, () => check.run(target), CHECK_TIMEOUT_MS);
  });
}
