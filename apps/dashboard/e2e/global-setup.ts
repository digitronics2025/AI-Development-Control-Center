import { existsSync } from 'node:fs';
import path from 'node:path';

/** Wait until scripts/demo.mjs has finished seeding (the server answers /healthz earlier). */
export default async function globalSetup(): Promise<void> {
  const marker = path.join(process.env.ACC_E2E_DATA_ROOT!, 'ready');
  const deadline = Date.now() + 120_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error(`Demo data was not seeded in time (${marker})`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
