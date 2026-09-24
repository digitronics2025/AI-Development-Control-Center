/**
 * Pre-commit secret scan (audit F-19), run by `.githooks/pre-commit`.
 *
 * The same checks as the Source Control preflight, for every commit made in
 * this repository however it is made (terminal, VS Code, GitHub Desktop):
 * staged files whose names mark them as secret material, and staged added
 * lines that match a high-confidence credential format from `detectSecrets`.
 * Findings name the file and the kind of secret, never the value.
 *
 * A line that must carry a credential-shaped example (a redaction test, say)
 * opts out with the marker `secret-scan: allow` on that line. Prefer building
 * such values at runtime instead (AGENTS.md).
 *
 * Exit codes: 0 clean, 1 findings, 2 the scan could not run (fails closed).
 */
import { execFileSync } from 'node:child_process';
import { detectSecrets, sensitiveFileReason } from '@acc/security';

const ALLOW = /secret-scan:\s*allow/;
const DIFF = ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', '--literal-pathspecs', ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function addedLines(patch: string): string[] {
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++') && !ALLOW.test(l))
    .map((l) => l.slice(1));
}

function scan(): string[] {
  const findings: string[] = [];
  // Names from -z: never quoted, never split (audit F-47).
  const names = git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMRT']).split('\0').filter(Boolean);
  const byName = new Set<string>();
  for (const name of names) {
    const reason = sensitiveFileReason(name);
    if (reason) {
      byName.add(name);
      findings.push(`${name}: looks like ${reason}`);
    }
  }
  // One diff for the whole commit; files are attributed only when something matched.
  if (!detectSecrets(addedLines(git(DIFF)).join('\n')).length) return findings;
  for (const name of names) {
    if (byName.has(name)) continue;
    const rules = detectSecrets(addedLines(git([...DIFF, '--', name])).join('\n'));
    if (rules.length) findings.push(`${name}: contains what looks like ${rules.join(' and ')}`);
  }
  return findings;
}

try {
  const findings = scan();
  if (findings.length) {
    process.stderr.write(
      [
        'secret-scan: this commit was stopped because the staged changes look like they contain secret material:',
        ...findings.map((f) => `  - ${f}`),
        'Remove the secret (keep it in Tools → Credentials or MyVault), or build test values at runtime.',
        'A line that must stay as it is can carry the marker "secret-scan: allow".',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`secret-scan: could not check this commit for secrets (${(error as Error).message.split('\n')[0]}). Nothing was committed.\n`);
  process.exit(2);
}
