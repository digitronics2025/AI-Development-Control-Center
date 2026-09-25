import { outgoingFiles, outgoingPatch, patchHeaderPath, splitPatch } from '@acc/git';
import { detectSecrets, sensitiveFileReason } from '@acc/security';

/**
 * Secret preflight before a commit or push (release requirement): known
 * sensitive files and high-confidence credential formats in added lines block
 * the action. Findings name the file and the kind of secret, never the value.
 */
export interface PreflightFinding {
  path: string;
  reason: string;
}

const SECRET_LABEL: Record<string, string> = {
  anthropic: 'an Anthropic API key',
  openai: 'an OpenAI API key',
  github: 'a GitHub token',
  gitlab: 'a GitLab token',
  slack: 'a Slack token',
  'aws-access-key': 'an AWS access key',
  'google-api-key': 'a Google API key',
  stripe: 'a Stripe key',
  npm: 'an npm token',
  'url-credentials': 'a password inside a URL',
  'private-key': 'a private key',
};

/** Split a `-U0` patch into per-file added text. */
export function addedLinesByFile(patch: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // A header whose name cannot be read still has its lines checked (audit F-47).
      const file = patchHeaderPath(line) ?? line.slice('diff --git '.length);
      current = files.get(file) ?? [];
      files.set(file, current);
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) current.push(line.slice(1));
  }
  return files;
}

export function preflightFindings(paths: string[], patch: string): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const reason = sensitiveFileReason(p);
    if (reason && !seen.has(p)) {
      seen.add(p);
      findings.push({ path: p, reason: `looks like ${reason}` });
    }
  }
  for (const [file, lines] of addedLinesByFile(patch)) {
    if (seen.has(file)) continue;
    const rules = detectSecrets(lines.join('\n'));
    if (rules.length) findings.push({ path: file, reason: `contains what looks like ${rules.map((r) => SECRET_LABEL[r] ?? r).join(' and ')}` });
  }
  return findings;
}

/** Remove whole file sections for sensitive paths from a unified diff (for AI context). */
export function withoutSensitiveFiles(patch: string): { patch: string; omitted: string[] } {
  const omitted: string[] = [];
  const out: string[] = [];
  let skipping = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const file = patchHeaderPath(line);
      // An unreadable name is left out of AI context rather than guessed at.
      skipping = file === null || Boolean(sensitiveFileReason(file));
      if (skipping) omitted.push(file ?? line.slice('diff --git '.length));
    }
    if (!skipping) out.push(line);
  }
  return { patch: out.join('\n'), omitted };
}

/** The most outgoing patch text a push preflight reads; anything larger is refused, not partly checked. */
export const MAX_PREFLIGHT_BYTES = 20 * 1024 * 1024;

/**
 * Check what a push would send, `tip` minus `exclude` (every remote branch
 * when null), for secret material. Source Control runs it before every push
 * and a release before its push (docs/plans/RELEASE_STAGE_PLAN.md §3.4):
 * `truncated` means the range was too large to check, which callers refuse.
 */
export async function scanOutgoing(root: string, tip: string, exclude: string | null): Promise<{ truncated: boolean; findings: PreflightFinding[] }> {
  const { patch, truncated } = await outgoingPatch(root, { tip, exclude, maxBytes: MAX_PREFLIGHT_BYTES });
  if (truncated) return { truncated: true, findings: [] };
  // File names come from `--name-only -z`: a quoted or binary file is still checked by name (audit F-47).
  const files = [...new Set([...(await outgoingFiles(root, { tip, exclude })), ...splitPatch(patch).files])];
  return { truncated: false, findings: preflightFindings(files, patch) };
}
