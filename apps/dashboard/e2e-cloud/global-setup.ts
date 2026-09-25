import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startCloud } from '../../cloud-control/test/harness';

/**
 * Starts the control plane (wrangler dev, local bindings) and one execution
 * node (scripts/demo.mjs: the real orchestrator with simulated agents and
 * seeded repositories), pairs the node through the relay exactly as a user
 * would (pairing code from the cloud API → Settings → Remote access API), and
 * stores a signed-in browser state (the Access cookie).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = process.env.ACC_CLOUD_E2E_ROOT!;
  const cloudPort = Number(process.env.ACC_CLOUD_E2E_PORT);
  const nodePort = Number(process.env.ACC_CLOUD_E2E_NODE_PORT);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const cloud = await startCloud({ port: cloudPort });
  const demo: ChildProcess = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../../scripts/demo.mjs'), '--port', String(nodePort), '--data', path.join(root, 'node')], {
    env: { ...process.env, ACC_SIM_DELAY_MS: '300' },
    stdio: 'ignore',
  });
  const ready = path.join(root, 'node', 'ready');
  const deadline = Date.now() + 120_000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error('The demo node did not start');
    await new Promise((r) => setTimeout(r, 250));
  }
  const nodeToken = readFileSync(path.join(root, 'node', 'data', 'auth-token'), 'utf8').trim();
  const nodeUrl = `http://127.0.0.1:${nodePort}`;
  const local = (method: string, p: string, body?: unknown) =>
    fetch(`${nodeUrl}${p}`, { method, headers: { authorization: `Bearer ${nodeToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

  const code = (await cloud.api('POST', '/api/cloud/pairing-tokens', { label: 'E2E node' })).body.token as string;
  const paired = await local('POST', '/api/remote/pair', { relayUrl: cloud.url, code, label: 'E2E node' });
  if (!paired.ok) throw new Error(`Pairing failed: ${paired.status} ${await paired.text()}`);
  const { nodeId } = (await paired.json()) as { nodeId: string };
  for (let i = 0; i < 200; i++) {
    const nodes = (await cloud.api('GET', '/api/cloud/nodes')).body as Array<{ id: string; status: string; repositories: unknown[] }>;
    const node = nodes.find((n) => n.id === nodeId);
    if (node?.status === 'online' && node.repositories.length >= 5) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const token = await cloud.signer.token({ exp: Math.floor(Date.now() / 1000) + 6 * 3600 });
  writeFileSync(
    path.join(root, 'storage-state.json'),
    JSON.stringify({ cookies: [{ name: 'CF_Authorization', value: token, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }),
  );
  writeFileSync(path.join(root, 'state.json'), JSON.stringify({ cloudUrl: cloud.url, nodeUrl, nodeToken, nodeId, accessToken: token }));

  return async () => {
    try {
      await local('POST', '/api/service/shutdown', { mode: 'force' });
    } catch {
      /* already stopped */
    }
    if (demo.pid && demo.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(demo.pid), '/T', '/F'], { stdio: 'ignore' });
      else demo.kill();
    }
    writeFileSync(path.join(root, 'wrangler.log'), cloud.logs.join(''));
    await cloud.stop();
  };
}
