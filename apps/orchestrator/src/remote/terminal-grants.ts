import { alwaysRequiresApproval, classifyCommand, lineContinues, shellHistory } from '@acc/security';
import type { CommandRisk, PermissionLevel } from '@acc/shared';

/**
 * Remote terminal grants (docs/systems/remote-node.md §Terminals). A terminal
 * opened by a cloud command gets a short-lived grant; only granted terminals
 * accept cloud keystrokes or send output to the cloud.
 *
 * Every line is classified before its Enter reaches the shell, exactly as an
 * agent's terminal input is: a line above this machine's auto-approve level,
 * or one that always needs approval (dangerous, production — a push to a
 * release or production branch or a pull-request merge included, judged by
 * `judge` after the lines the terminal ran before, and together with the
 * earlier lines of a command the shell is still reading: an open quote, a
 * trailing `\`), is cancelled with Ctrl+C and a notice. Escape sequences and
 * Tab are dropped, because history
 * recall and completion would change the line without the classifier seeing
 * it; Backspace and Ctrl+C work.
 */

export const TERMINAL_GRANT = { idleMs: 10 * 60_000, maxMs: 30 * 60_000 } as const;

export interface TerminalPort {
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): Promise<void>;
}

interface Grant {
  expiresAt: number;
  lastInputAt: number;
  line: string;
  /** Lines this grant ran, oldest first (`shellHistory`): their checkouts, folders and settings hold for a later push. */
  ran: string[];
  /** The lines of a command the shell is still reading (`lineContinues`), not yet run. */
  pending: string;
}

/** How a line is judged at Enter: its level, risk and whether it touches production. */
export type LineJudge = (terminalId: string, line: string, before: readonly string[]) => { level: PermissionLevel; risk: CommandRisk; reasons: string[]; production: boolean };

export class TerminalGrants {
  private readonly grants = new Map<string, Grant>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly terminals: TerminalPort,
    private readonly maxLevel: () => number,
    private readonly limits: { idleMs: number; maxMs: number } = TERMINAL_GRANT,
    private readonly now: () => number = Date.now,
    /** Shows a message to the remote viewer (never typed into the shell). */
    private readonly notify: (terminalId: string, text: string) => void = () => undefined,
    /** The classifier by default; the service adds the release gate (`TerminalService.judgeLine`). */
    private readonly judge: LineJudge = (_id, line) => classifyCommand(line),
  ) {}

  grant(terminalId: string): void {
    const t = this.now();
    this.grants.set(terminalId, { expiresAt: t + this.limits.maxMs, lastInputAt: t, line: '', ran: [], pending: '' });
    if (!this.timer) {
      this.timer = setInterval(() => void this.sweep(), Math.min(30_000, Math.max(250, this.limits.idleMs / 4)));
      this.timer.unref?.();
    }
  }

  /**
   * Output the cloud is watching counts as activity: a long build watched from
   * the cloud is not idle (audit F-43). Only a live grant is extended, never
   * past its maximum lifetime.
   */
  touch(terminalId: string): void {
    const g = this.grants.get(terminalId);
    if (g && this.valid(g)) g.lastInputAt = this.now();
  }

  has(terminalId: string): boolean {
    const g = this.grants.get(terminalId);
    return Boolean(g && this.valid(g));
  }

  private valid(g: Grant): boolean {
    const t = this.now();
    return t < g.expiresAt && t - g.lastInputAt < this.limits.idleMs;
  }

  /** Close terminals whose grant ran out (idle or maximum lifetime). */
  async sweep(): Promise<string[]> {
    const ended: string[] = [];
    for (const [id, g] of this.grants) {
      if (this.valid(g)) continue;
      this.grants.delete(id);
      ended.push(id);
      await this.terminals.close(id).catch(() => undefined);
    }
    if (!this.grants.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return ended;
  }

  /** Revocation, unpairing or shutdown: every remote terminal ends now. */
  async revokeAll(): Promise<void> {
    const ids = [...this.grants.keys()];
    this.grants.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all(ids.map((id) => this.terminals.close(id).catch(() => undefined)));
  }

  resize(terminalId: string, cols: number, rows: number): void {
    if (!this.has(terminalId) || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
    try {
      this.terminals.resize(terminalId, Math.min(400, Math.max(20, cols)), Math.min(200, Math.max(5, rows)));
    } catch {
      /* closed terminal */
    }
  }

  /** Cloud keystrokes. Returns what was refused, for tests and the audit notice. */
  input(terminalId: string, data: string): { refused: string[] } {
    const g = this.grants.get(terminalId);
    const refused: string[] = [];
    if (!g || !this.valid(g)) return { refused };
    g.lastInputAt = this.now();
    let out = '';
    const flush = () => {
      if (out) this.terminals.write(terminalId, out);
      out = '';
    };
    // Drop escape sequences (arrows, history, function keys) as a whole; matching ESC is the point here.
    // eslint-disable-next-line no-control-regex
    const clean = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|\x1b/g, '').replace(/\t/g, '');
    for (const ch of clean) {
      if (ch === '\r' || ch === '\n') {
        const line = g.line.trim();
        g.line = '';
        const whole = g.pending ? `${g.pending}\n${line}` : line;
        // Judged alone and as part of the command the shell is still reading; either can refuse it.
        const verdicts = [line ? this.judge(terminalId, line, g.ran) : null, g.pending ? this.judge(terminalId, whole, g.ran) : null];
        const tooLong = whole.length > 20_000;
        const c = verdicts.find((v) => v && (alwaysRequiresApproval(v) || v.production || v.level > this.maxLevel()));
        if (c || tooLong) {
          refused.push(line);
          g.pending = '';
          out += '\x03';
          flush();
          const why = c ? `Level ${c.level}${c.risk === 'dangerous' ? ', dangerous' : ''} (${c.reasons.slice(0, 2).join(', ')})` : 'the command is too long to judge';
          this.notify(terminalId, `\r\n[Refused from the cloud: ${why}. Run it on this machine or through a task that asks for approval.]\r\n`);
          continue;
        }
        if (line) g.ran = shellHistory([...g.ran, line], 50);
        g.pending = whole && lineContinues(whole) ? whole : '';
        out += '\r';
        continue;
      }
      if (ch === '\x03') {
        g.line = '';
        g.pending = '';
        out += ch;
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        g.line = Array.from(g.line).slice(0, -1).join(''); // one character, not one UTF-16 unit (emoji)
        out += ch;
        continue;
      }
      if (ch < ' ') continue; // other control characters are not typed remotely
      g.line += ch;
      out += ch;
    }
    flush();
    return { refused };
  }
}
