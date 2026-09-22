import { Redactor } from '@acc/security';
import type { LogLine } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { Store } from '../store/store.js';

const FLUSH_MS = 150;
const FLUSH_LINES = 250;
/** Lines beyond this per execution are counted but not stored, bounding the database. */
export const MAX_LINES_PER_EXECUTION = 50_000;

/**
 * Buffers an execution's output, redacts every line (stateful, so multi-line
 * private keys are suppressed), assigns sequence numbers, persists in
 * batches and publishes each batch — bursts never become one message per line.
 */
export class LogSink {
  private seq = 0;
  private buffer: LogLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private dropped = 0;
  private readonly redactLine: (line: string) => string;
  private readonly tail: string[] = [];

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly taskId: string,
    readonly executionId: string,
    redactor: Redactor = Redactor.fromEnv(),
  ) {
    this.redactLine = redactor.lineRedactor();
  }

  push = (stream: LogLine['stream'], text: string): void => {
    const clean = this.redactLine(text);
    this.tail.push(clean);
    if (this.tail.length > 400) this.tail.shift();
    if (this.seq >= MAX_LINES_PER_EXECUTION) {
      this.dropped++;
      return;
    }
    this.buffer.push({ executionId: this.executionId, seq: this.seq++, stream, text: clean, at: new Date().toISOString() });
    if (this.buffer.length >= FLUSH_LINES) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  };

  /** Most recent redacted lines, for summaries and error context. */
  recent(count = 60): string[] {
    return this.tail.slice(-count);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dropped > 0 && this.seq === MAX_LINES_PER_EXECUTION) {
      this.buffer.push({
        executionId: this.executionId,
        seq: this.seq++,
        stream: 'system',
        text: `Output limit reached; further lines are not stored.`,
        at: new Date().toISOString(),
      });
    }
    if (!this.buffer.length) return;
    const lines = this.buffer;
    this.buffer = [];
    this.store.insertLogLines(lines);
    this.bus.publish({ type: 'logs', taskId: this.taskId, executionId: this.executionId, lines });
  }
}
