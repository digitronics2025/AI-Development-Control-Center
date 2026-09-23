/**
 * Shell-aware helpers for command classification. This is not a full parser
 * for any shell: it splits a command line into the commands it runs (outside
 * quotes), unwraps nested interpreters (`cmd /c`, `powershell -Command`,
 * `bash -c`, `wsl`), decodes PowerShell's `-EncodedCommand`, and expands
 * PowerShell aliases, so risk rules see what actually runs.
 */

export interface Segment {
  /** The command text of this segment, trimmed. */
  text: string;
  /** Operator that joined this segment to the previous one. */
  joinedBy: ';' | '&&' | '||' | '|' | '&' | '\n' | null;
}

/**
 * Split on command separators that are not inside quotes. Handles '…' and
 * "…" (both shells), backtick escapes (PowerShell) and backslash escapes
 * outside single quotes (POSIX). `2>&1`-style redirections are kept intact.
 */
export function splitCommands(command: string): Segment[] {
  const segments: Segment[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let joinedBy: Segment['joinedBy'] = null;
  const push = (next: Segment['joinedBy']) => {
    if (current.trim()) segments.push({ text: current.trim(), joinedBy });
    current = '';
    joinedBy = next;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      current += ch;
      if ((ch === '`' || (ch === '\\' && quote === '"')) && next !== undefined) {
        current += next;
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === '`' || ch === '\\') && next !== undefined && next !== '\n') {
      current += ch + next;
      i++;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      push('\n');
      continue;
    }
    if (ch === ';') {
      push(';');
      continue;
    }
    if (ch === '&' && next === '&') {
      push('&&');
      i++;
      continue;
    }
    if (ch === '|' && next === '|') {
      push('||');
      i++;
      continue;
    }
    if (ch === '|') {
      push('|');
      continue;
    }
    // `&` alone separates commands in cmd.exe; `2>&1` and `&>` are redirections.
    if (ch === '&' && !/[<>]$/.test(current) && next !== '>') {
      // PowerShell's call operator `& 'x'` at the start of a segment is not a separator.
      if (current.trim() === '') {
        current += ch;
        continue;
      }
      push('&');
      continue;
    }
    current += ch;
  }
  push(null);
  return segments;
}

/** Remove one layer of matching outer quotes. */
export function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** First word of a command, without a path or `.exe`, lowercased. */
export function commandWord(segment: string): string {
  const t = segment.trim().replace(/^[&.]\s+/, '');
  const first = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(t);
  const raw = first?.[1] ?? first?.[2] ?? first?.[3] ?? '';
  const base = raw.split(/[\\/]/).pop() ?? raw;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

/** PowerShell aliases that matter for risk, mapped to the cmdlet they run. */
export const POWERSHELL_ALIASES: Readonly<Record<string, string>> = {
  iex: 'Invoke-Expression',
  iwr: 'Invoke-WebRequest',
  irm: 'Invoke-RestMethod',
  wget: 'Invoke-WebRequest',
  curl: 'Invoke-WebRequest',
  saps: 'Start-Process',
  start: 'Start-Process',
  ri: 'Remove-Item',
  rm: 'Remove-Item',
  rmdir: 'Remove-Item',
  rd: 'Remove-Item',
  del: 'Remove-Item',
  erase: 'Remove-Item',
  kill: 'Stop-Process',
  spps: 'Stop-Process',
  sc: 'Set-Content',
  sp: 'Set-ItemProperty',
  rp: 'Remove-ItemProperty',
  ni: 'New-Item',
  icm: 'Invoke-Command',
  sajb: 'Start-Job',
  gc: 'Get-Content',
  cat: 'Get-Content',
  type: 'Get-Content',
  gci: 'Get-ChildItem',
  ls: 'Get-ChildItem',
  dir: 'Get-ChildItem',
  gps: 'Get-Process',
  ps: 'Get-Process',
  gsv: 'Get-Service',
  mi: 'Move-Item',
  move: 'Move-Item',
  mv: 'Move-Item',
  cpi: 'Copy-Item',
  copy: 'Copy-Item',
  cp: 'Copy-Item',
};

/** The segment with a leading PowerShell alias replaced by its cmdlet name, or null. */
export function expandAlias(segment: string): string | null {
  const word = commandWord(segment);
  const cmdlet = POWERSHELL_ALIASES[word];
  if (!cmdlet) return null;
  return segment.trim().replace(/^(?:[&.]\s+)?\S+/, cmdlet);
}

/**
 * The script a nested interpreter would run, or null. Covers `cmd /c`,
 * `powershell|pwsh [-flags] -Command|-c …`, `bash|sh|zsh -c …` and
 * `wsl [-e|--] …`.
 */
export function unwrapInterpreter(segment: string): string | null {
  const t = segment.trim();
  const cmd = /^(?:"?[^"\s]*[\\/])?cmd(?:\.exe)?"?\s+\/[ck]\s+([\s\S]+)$/i.exec(t);
  if (cmd) return unquote(cmd[1]!);
  const ps = /^(?:"?[^"\s]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-[A-Za-z]+(?:\s+(?!-)[^\s-][^\s]*)?\s+)*?-(?:c|command)\s+([\s\S]+)$/i.exec(t);
  if (ps) return unquote(ps[1]!);
  const sh = /^(?:"?[^"\s]*[\\/])?(?:ba|z|da)?sh(?:\.exe)?"?\s+(?:-[a-z]*\s+)*-c\s+([\s\S]+)$/i.exec(t);
  if (sh) return unquote(sh[1]!);
  const wsl = /^(?:"?[^"\s]*[\\/])?wsl(?:\.exe)?"?\s+(?:(?:-d|--distribution|-u|--user)\s+\S+\s+)*(?:-e|--exec|--)?\s*([\s\S]+)$/i.exec(t);
  if (wsl && wsl[1] && !/^-/.test(wsl[1])) return wsl[1];
  return null;
}

/** Tabs, newlines and printable characters only (random base64 rarely decodes to that). */
function plausibleText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 9 && code !== 10 && code !== 13 && (code < 32 || code === 127)) return false;
  }
  return true;
}

/** Decoded `-EncodedCommand` payloads (base64 of UTF-16LE) found in the text. */
export function decodeEncodedCommands(text: string): string[] {
  const out: string[] = [];
  const pattern = /(?:^|\s)-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\s+["']?([A-Za-z0-9+/=]{8,})["']?/gi;
  for (const match of text.matchAll(pattern)) {
    try {
      const decoded = Buffer.from(match[1]!, 'base64').toString('utf16le');
      // Reject decodes that are not plausible text (random base64 that is not a script).
      if (decoded && /[a-z]/i.test(decoded) && plausibleText(decoded)) out.push(decoded);
    } catch {
      /* not base64 */
    }
  }
  return out;
}
