import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * On Windows, Playwright stops scripts/demo.mjs but not the orchestrator it
 * spawned, which then keeps the port and fails the next run. Ask it to shut
 * down through its own authenticated endpoint.
 */
export default async function globalTeardown(): Promise<void> {
  const dataRoot = process.env.ACC_E2E_DATA_ROOT;
  const port = process.env.ACC_E2E_PORT ?? '4391';
  const tokenFile = dataRoot ? path.join(dataRoot, 'data', 'auth-token') : null;
  if (!tokenFile || !existsSync(tokenFile)) return;
  try {
    await fetch(`http://127.0.0.1:${port}/api/service/shutdown`, {
      method: 'POST',
      // The suite is over: stop now, even with simulated tasks still running.
      headers: { authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'force' }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* already stopped */
  }
}
