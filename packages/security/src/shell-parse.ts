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

/**
 * The words of one command segment: split on whitespace outside quotes, with
 * the quotes removed (`-F "f=@.env"` → `-F`, `f=@.env`). Enough to find
 * options and the files they name; not a full parser for any shell.
 */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted = false;
  let quote: '"' | "'" | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || quoted) words.push(current);
      current = '';
      quoted = false;
      continue;
    }
    current += ch;
  }
  if (current || quoted) words.push(current);
  return words;
}

/**
 * A word quoted so `shellWords` reads it back unchanged as one word: for a
 * command line built from an argv that no shell parses (`process.exec`), so a
 * name holding a space or a quote (`C:\Program Files\Git\cmd\git.exe`,
 * a branch named `x'`) is not split or merged with its neighbours.
 */
export function quoteWord(word: string): string {
  if (word && !/[\s'"]/.test(word)) return word;
  return word.split('"').map((part) => (part ? `"${part}"` : '')).join(`'"'`) || '""';
}

/**
 * A POSIX shell's `-c` argument as that shell reads it, when it is one
 * quoted word: inside double quotes a backslash escapes a backslash, a
 * double quote, `$` or a backtick, and `'\''` is a single quote inside single
 * quotes — so a nested `bash -c "bash -c \"git push\""` unwraps to
 * `git push`. Anything else loses one layer of outer quotes (`unquote`).
 */
function unquotePosix(text: string): string {
  const t = text.trim();
  const doubled = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(t);
  if (doubled) return doubled[1]!.replace(/\\([\\"$`\n])/g, '$1');
  if (/^'[^']*'(?:\\''[^']*')*$/.test(t)) return t.slice(1, -1).replace(/'\\''/g, "'");
  return unquote(t);
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
 * `powershell|pwsh [-flags] -Command|-c …`, `bash|sh|zsh -c …` (`-lc` too)
 * and `wsl [-e|--] …`.
 */
export function unwrapInterpreter(segment: string): string | null {
  const t = segment.trim();
  const cmd = /^(?:"?[^"\s]*[\\/])?cmd(?:\.exe)?"?\s+\/[ck]\s+([\s\S]+)$/i.exec(t);
  if (cmd) return unquote(cmd[1]!);
  const ps = /^(?:"?[^"\s]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-[A-Za-z]+(?:\s+(?!-)[^\s-][^\s]*)?\s+)*?-(?:c|command)\s+([\s\S]+)$/i.exec(t);
  if (ps) return unquote(ps[1]!);
  // `-c` alone or in a cluster of flags (`bash -lc "…"`, `sh -ec "…"`).
  const sh = /^(?:"?[^"\s]*[\\/])?(?:ba|z|da)?sh(?:\.exe)?"?\s+(?:-[a-z]*\s+)*-(?=[a-z]*c)[a-z]+\s+([\s\S]+)$/i.exec(t);
  if (sh) return unquotePosix(sh[1]!);
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

/** Scripts a literal base64 payload decodes to when it is piped through `base64 -d` (`echo aGk= | base64 -d | sh`). */
export function decodeBase64Pipes(text: string): string[] {
  const out: string[] = [];
  const pattern = /\b(?:echo|printf)\s+(?:-[a-z]+\s+)*["']?([A-Za-z0-9+/=]{8,})["']?\s*\|\s*base64\s+(?:-d|-D|--decode)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
    if (decoded && /[a-z]/i.test(decoded) && plausibleText(decoded)) out.push(decoded);
  }
  return out;
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

/**
 * A shell reading `text` line by line would wait for more before running
 * it: a quote still open, a line ending in `\` (POSIX), a backtick
 * (PowerShell) or `^` (cmd), a pipe or `&&`/`||` with nothing after it, an
 * unclosed `(` or `{`, or a heredoc (`<<EOF`) or PowerShell here-string
 * (`@'`…`'@`) not closed yet. `#` comments are skipped. It errs towards
 * "continues": a line judged with the lines before it is judged alone too.
 */
export function lineContinues(text: string): boolean {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  const heredocs: string[] = [];
  let hereString: string | null = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (heredocs.length) {
      if (line.replace(/^\t+/, '').trimEnd() === heredocs[0]) heredocs.shift();
      continue;
    }
    if (hereString) {
      if (line.startsWith(hereString)) hereString = null;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (ch === '\\' || ch === '`') {
        i++;
        continue;
      }
      if (quote === '"') {
        if (ch === '"') quote = null;
        continue;
      }
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) break;
      if (ch === '@' && (line[i + 1] === '"' || line[i + 1] === "'") && line.slice(i + 2).trim() === '') {
        hereString = `${line[i + 1]}@`;
        break;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '{') depth++;
      else if ((ch === ')' || ch === '}') && depth > 0) depth--;
      else if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        const heredoc = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(line.slice(i));
        if (heredoc) {
          heredocs.push(heredoc[2]!);
          i += heredoc[0].length - 1;
        }
      }
    }
  }
  return Boolean(quote || hereString || heredocs.length || depth > 0 || /(?:[\\`^|]|&&)$/.test((lines.at(-1) ?? '').trimEnd()));
}

/**
 * Bash or zsh would rewrite this interactive line from its history before
 * running it: an event designator (`!!`, `!$`, `!^`, `!*`, `!-2`, `!12`,
 * `!git`, `!?x?`, `!#`) outside single quotes and not escaped, or a quick
 * substitution (`^old^new`) at its start. What runs is then not the line
 * that was judged. `!` before a blank, `=` or `(`, or a closing double quote,
 * and `[!…]`, `${!name}` and `$!` are not expanded.
 */
export function expandsHistory(line: string): boolean {
  if (/^\s*\^/.test(line)) return true;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') {
      quote = quote ? null : '"';
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch !== '!') continue;
    const next = line[i + 1];
    if (next === undefined || /[\s=(]/.test(next) || (next === '"' && quote === '"')) continue;
    const before = line[i - 1];
    if (before === '[' || before === '$' || (before === '{' && line[i - 2] === '$')) continue;
    return true;
  }
  return false;
}
