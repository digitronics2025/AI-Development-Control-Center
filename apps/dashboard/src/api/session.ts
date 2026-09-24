/**
 * Cloud mode: tells an expired Cloudflare Access sign-in apart from a network fault
 * (docs/systems/dashboard.md "Installable app"). An installed app stays open for days,
 * and once Access stops accepting its cookie every request fails the same way a dead
 * network does. A failed call or socket asks for a check; the check reads only the
 * status and type of one session request — never a cookie or token.
 */
export type SessionState = 'ok' | 'expired';

/** At most one session check per this interval, however many calls fail. */
export const SESSION_CHECK_INTERVAL_MS = 15_000;

export async function probeCloudSession(fetchImpl: typeof fetch = fetch): Promise<SessionState> {
  let response: Response;
  try {
    // `manual`: Access answers an expired session with a redirect to its sign-in page.
    response = await fetchImpl('/api/cloud/session', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
  } catch {
    return 'ok'; // the network itself is down: not a sign-in problem
  }
  if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) return 'expired';
  // A sign-in page served in place of the API.
  if (response.ok && !(response.headers.get('content-type') ?? '').includes('application/json')) return 'expired';
  return 'ok';
}

export class SessionWatch {
  private state: SessionState = 'ok';
  private checking = false;
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly probe: () => Promise<SessionState> = () => probeCloudSession(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  get = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Something failed in a way an expired sign-in would cause: check, unless a check ran moments ago. */
  check = (): void => {
    if (this.state === 'expired' || this.checking || this.now() - this.lastCheckAt < SESSION_CHECK_INTERVAL_MS) return;
    this.checking = true;
    this.lastCheckAt = this.now();
    void this.probe()
      .catch((): SessionState => 'ok')
      .then((state) => {
        this.checking = false;
        if (state === 'expired') {
          this.state = 'expired';
          for (const l of this.listeners) l();
        }
      });
  };
}
