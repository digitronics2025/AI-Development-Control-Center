/**
 * Entry of the built hook (`apps/orchestrator/dist/acc-shell-guard.mjs`,
 * `SHELL_GUARD_SCRIPT`): reads the call from stdin, prints the outcome and
 * exits with its code. Everything that can go wrong here — an exception, a
 * stdin that never ends, a call too large — ends in a refusal (exit 2), never
 * in the exit code 1 a crash would give, which the CLI would let through.
 */
import { refusal, runShellGuard, SHELL_GUARD_DEADLINE_MS, SHELL_GUARD_MAX_INPUT, type GuardOutcome } from './shell-guard.js';

let finished = false;
function finish(outcome: GuardOutcome): void {
  if (finished) return;
  finished = true;
  process.exitCode = outcome.exitCode;
  // Exit only once both streams have taken the text: a pipe on Windows is written asynchronously.
  const write = (stream: NodeJS.WriteStream, text: string, then: () => void) => (text ? stream.write(text, () => then()) : then());
  write(process.stdout, outcome.stdout, () => write(process.stderr, outcome.stderr, () => process.exit(outcome.exitCode)));
}

process.exitCode = 2;
process.on('uncaughtException', () => finish(refusal('its check failed.')));
process.on('unhandledRejection', () => finish(refusal('its check failed.')));
// Past the check's own deadline nothing is waited for: stdin that never closes included.
setTimeout(() => finish(refusal('the check took too long.')), SHELL_GUARD_DEADLINE_MS + 3_000);

const chunks: Buffer[] = [];
let size = 0;
process.stdin.on('data', (chunk: Buffer) => {
  size += chunk.length;
  if (size > SHELL_GUARD_MAX_INPUT) return finish(refusal('the call is too large to check.'));
  chunks.push(chunk);
});
process.stdin.on('error', () => finish(refusal('the call could not be read.')));
process.stdin.on('end', () => {
  if (finished) return;
  runShellGuard(Buffer.concat(chunks).toString('utf8'), process.env).then(finish, () => finish(refusal('its check failed.')));
});
