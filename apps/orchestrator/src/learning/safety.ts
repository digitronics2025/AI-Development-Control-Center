import { classifyCommand, redact } from '@acc/security';

/**
 * The scan every piece of text the learning loop would put in front of later
 * agents must pass (docs/systems/learning.md#safety). Lessons and written
 * skills are derived from untrusted evidence — agent reports, logs — so a
 * planted instruction must not become standing advice. Fails closed: any
 * rule that matches rejects the whole text, with the reasons.
 */

interface Rule {
  test: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  { test: /\b(?:https?|ftp|file):\/\/|\bwww\.[a-z0-9-]+\./i, reason: 'contains a web address' },
  { test: /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|earlier|all|system|safety)\b.{0,20}\b(?:instructions?|rules?|prompts?|polic(?:y|ies)|guidelines?)\b/i, reason: 'tries to override instructions' },
  { test: /\byou are (?:now|no longer)\b|\bnew (?:system )?(?:instructions?|role)\b|\bsystem prompt\b|<\/?(?:system|untrusted_evidence)\b/i, reason: 'claims a role or system instructions' },
  { test: /--no-verify\b|\bskip(?:ping)?\s+(?:the\s+)?(?:tests?|checks?|review|verification|hooks?|ci)\b|\b(?:delete|remove|disable|comment out|weaken)\s+(?:the\s+|failing\s+)?(?:tests?|checks?|assertions?|hooks?|lint)\b|\bit\.skip\b|\bdescribe\.skip\b|\.only\(/i, reason: 'weakens tests, checks, review or hooks' },
  { test: /\b(?:exfiltrat|upload (?:the )?(?:secrets?|credentials?|tokens?|keys?)|send (?:the )?(?:secrets?|credentials?|tokens?|keys?)|print (?:the )?(?:secrets?|tokens?|env(?:ironment)?))/i, reason: 'moves secrets' },
  { test: /\b(?:api[_ -]?key|access[_ -]?token|password|passwd|secret)\s*[:=]\s*\S{6,}/i, reason: 'contains a credential-shaped value' },
  { test: /\b(?:force[- ]push|push\s+(?:-f\b|--force))|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*[fdx])/i, reason: 'rewrites or discards Git history' },
  { test: /\b(?:disable|turn off|bypass)\b.{0,30}\b(?:guard|policy|sandbox|approvals?|permissions?|firewall|antivirus|defender|uac)\b/i, reason: 'bypasses a safety control' },
];

/** Lines that look like commands, so the command classifier can judge them. */
function commandLines(text: string): string[] {
  const lines: string[] = [];
  for (const m of text.matchAll(/`([^`\n]{2,300})`/g)) lines.push(m[1]!);
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence && line.trim()) lines.push(line.trim());
    else if (/^\s*(?:\$|>|PS>)\s+\S/.test(line)) lines.push(line.replace(/^\s*(?:\$|>|PS>)\s+/, ''));
  }
  return lines;
}

export interface SafetyResult {
  ok: boolean;
  reasons: string[];
}

export function checkLearnedText(text: string): SafetyResult {
  const reasons = new Set<string>();
  if (redact(text) !== text) reasons.add('contains something that looks like a secret');
  for (const rule of RULES) if (rule.test.test(text)) reasons.add(rule.reason);
  for (const line of commandLines(text)) {
    const c = classifyCommand(line);
    if (c.risk === 'dangerous' || c.level >= 4 || c.production) reasons.add(`suggests a Level ${c.level} command (${c.reasons[0] ?? line.slice(0, 60)})`);
    if (c.effects.includes('network') && /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\b/i.test(line) && /\|\s*(?:sh|bash|iex|pwsh|powershell|python|node)\b|Invoke-Expression/i.test(line)) reasons.add('downloads and runs code');
  }
  return { ok: reasons.size === 0, reasons: [...reasons] };
}

/** Several texts judged together (a skill's name, description and body). */
export function checkAll(...texts: string[]): SafetyResult {
  const reasons = new Set<string>();
  for (const t of texts) for (const r of checkLearnedText(t).reasons) reasons.add(r);
  return { ok: reasons.size === 0, reasons: [...reasons] };
}
