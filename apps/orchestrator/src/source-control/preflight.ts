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
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = m ? (files.get(m[2]!) ?? []) : null;
      if (m && current) files.set(m[2]!, current);
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
      const file = /^diff --git a\/.+ b\/(.+)$/.exec(line)?.[1] ?? '';
      skipping = Boolean(sensitiveFileReason(file));
      if (skipping) omitted.push(file);
    }
    if (!skipping) out.push(line);
  }
  return { patch: out.join('\n'), omitted };
}
