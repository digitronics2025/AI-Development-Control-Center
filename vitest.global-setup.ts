import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Gives each `vitest run` its own temporary folder and deletes it at the end.
 *
 * Tests create real repositories, databases and data folders under
 * `os.tmpdir()`. Pointing TEMP/TMP/TMPDIR at a per-run folder before the test
 * workers start (they inherit this environment, as do the git, agent and
 * wrangler processes they spawn) means one recursive delete cleans up after
 * every test, including those that never remove their own folders. Before
 * this, thousands of folders (~14 GB) accumulated in the real temp folder.
 */
export default function setup(): () => void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acc-vitest-'));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = root;
  process.env.TMP = root;
  process.env.TMPDIR = root;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      // Windows can hold a file briefly after its process exits (SQLite, git); retry.
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.warn(`Could not remove the test temp folder ${root}: ${(error as Error).message}`);
    }
  };
}
