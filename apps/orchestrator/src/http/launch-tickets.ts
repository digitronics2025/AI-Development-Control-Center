import { randomBytes } from 'node:crypto';

/** How long a launch ticket stays good: a launcher opens the browser with it straight away. */
export const LAUNCH_TICKET_TTL_MS = 60_000;
/** Unused tickets kept at most; the oldest goes first. */
const MAX_OUTSTANDING = 32;

/**
 * Launch tickets (SEC-3, docs/systems/security.md#agent-os-boundary). While
 * agents run as their own Windows account, the dashboard page carries the
 * local token only for a request that brings one of these: random, single
 * use, a minute long, held in memory only (a restart forgets them), and handed
 * out only through the authenticated API — so a program that can reach the
 * port but cannot read the token file gets no token from `GET /`.
 */
export class LaunchTickets {
  private readonly tickets = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(): { ticket: string; expiresAt: string } {
    this.prune();
    while (this.tickets.size >= MAX_OUTSTANDING) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url');
    const expires = this.now() + LAUNCH_TICKET_TTL_MS;
    this.tickets.set(ticket, expires);
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }

  /** True once for a ticket that was issued and has not expired; it is gone either way. */
  consume(ticket: string | null | undefined): boolean {
    if (!ticket) return false;
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return expires !== undefined && expires > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [ticket, expires] of this.tickets) if (expires <= now) this.tickets.delete(ticket);
  }
}
