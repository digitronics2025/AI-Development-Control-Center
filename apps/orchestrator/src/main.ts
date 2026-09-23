import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServices } from './app.js';
import { loadConfig } from './config.js';
import { buildServer } from './http/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const services = createServices(config);
  const recovered = services.engine.recover();
  // Filled in once the shutdown routine exists; the HTTP endpoint only exists after listen.
  const lifecycle: { shutdown: (reason: string) => void } = { shutdown: () => undefined };
  const app = await buildServer(services, { logger: true, onShutdownRequest: () => lifecycle.shutdown('shutdown request') });

  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host === '::1' ? '[::1]' : config.host}:${port}`;

  // Discovery file for the VS Code extension and launchers (no secrets: the token has its own file).
  const runtimeFile = path.join(config.dataDir, 'runtime.json');
  writeFileSync(runtimeFile, JSON.stringify({ url, port, pid: process.pid, startedAt: services.startedAt, version: config.version }, null, 2));

  app.log.info(`AI Development Control Center listening on ${url}${config.simulatedAgents ? ' (SIMULATED AGENTS)' : ''}`);
  if (recovered.interruptedTasks.length) app.log.warn(`Marked interrupted after restart: ${recovered.interruptedTasks.join(', ')}`);

  services.engine.schedule();
  void services.agents.refresh().then(
    (agents) => app.log.info(`Agents: ${agents.map((a) => `${a.name}=${a.health.state}`).join(', ')}`),
    (error: unknown) => app.log.error(`Agent refresh failed: ${(error as Error).message}`),
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received: stopping executions and shutting down`);
    const timer = setTimeout(() => process.exit(1), 15_000);
    try {
      await services.close();
      await app.close();
      rmSync(runtimeFile, { force: true });
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  lifecycle.shutdown = (reason) => void shutdown(reason);
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
}

main().catch((error: unknown) => {
  console.error(`Orchestrator failed to start: ${(error as Error).message}`);
  process.exit(1);
});
