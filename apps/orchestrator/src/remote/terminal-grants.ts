import { alwaysRequiresApproval, classifyCommand } from '@acc/security';

/**
 * Remote terminal grants (docs/systems/remote-node.md §Terminals). A terminal
 * opened by a cloud command gets a short-lived grant; only granted terminals
 * accept cloud keystrokes or send output to the cloud.
 *
 * Every line is classified before its Enter reaches the shell, exactly as an
 * agent's terminal input is: a line above this machine's auto-approve level,
 * or one that always needs approval (dangerous, production), is cancelled with
 * Ctrl+C and a notice. Escape sequences and Tab are dropped, because history
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
}

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
  ) {}

  grant(terminalId: string): void {
    const t = this.now();
    this.grants.set(terminalId, { expiresAt: t + this.limits.maxMs, lastInputAt: t, line: '' });
    if (!this.timer) {
      this.timer = setInterval(() => void this.sweep(), Math.min(30_000, Math.max(250, this.limits.idleMs / 4)));
      this.timer.unref?.();
    }
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
        const c = line ? classifyCommand(line) : null;
        if (c && (alwaysRequiresApproval(c) || c.level > this.maxLevel())) {
          refused.push(line);
          out += '\x03';
          flush();
          this.notify(terminalId, `\r\n[Refused from the cloud: Level ${c.level}${c.risk === 'dangerous' ? ', dangerous' : ''} (${c.reasons.slice(0, 2).join(', ')}). Run it on this machine or through a task that asks for approval.]\r\n`);
          continue;
        }
        out += '\r';
        continue;
      }
      if (ch === '\x03') {
        g.line = '';
        out += ch;
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        g.line = g.line.slice(0, -1);
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
