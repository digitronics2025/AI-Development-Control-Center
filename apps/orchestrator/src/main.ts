import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServices } from './app.js';
import { loadConfig } from './config.js';
import { buildServer } from './http/server.js';
import { reconcileGitOperations } from './source-control/reconcile.js';
import { detectAmbientCredentials, setSelfReferences } from '@acc/security';

async function main(): Promise<void> {
  const config = loadConfig();
  const services = createServices(config);
  const recovered = await services.recover();
  // Filled in once the shutdown routine exists; the HTTP endpoint only exists after listen.
  const lifecycle: { shutdown: (reason: string) => void } = { shutdown: () => undefined };
  const app = await buildServer(services, { logger: true, onShutdownRequest: () => lifecycle.shutdown('shutdown request') });

  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host === '::1' ? '[::1]' : config.host}:${port}`;

  // Commands and tool calls that name this data folder or this port are Level 5 (audit F-02).
  setSelfReferences({ dataDir: config.dataDir, port });
  // Agent stages reach the tool layer's MCP bridge through this address.
  services.tooling.setListenUrl(url);
  // Tool health is cached for hours; detect only what is stale, in the background.
  void services.tools.refreshStale();
  void services.credentials.primeRedactor().catch((error: unknown) => app.log.warn(`Credential key unavailable: ${(error as Error).message}`));

  // Discovery file for the VS Code extension and launchers (no secrets: the token has its own file).
  const runtimeFile = path.join(config.dataDir, 'runtime.json');
  writeFileSync(runtimeFile, JSON.stringify({ url, port, pid: process.pid, startedAt: services.startedAt, version: config.version }, null, 2));

  app.log.info(`AI Development Control Center listening on ${url}${config.simulatedAgents ? ' (SIMULATED AGENTS)' : ''}`);
  const ambient = detectAmbientCredentials(process.env);
  if (ambient.length) app.log.warn(`Provider credentials in this process's environment are withheld from every agent, tool and Git hook: ${ambient.join(', ')}. Store the ones tasks need under Tools → Credentials.`);
  if (recovered.interruptedTasks.length) app.log.warn(`Marked interrupted after restart: ${recovered.interruptedTasks.join(', ')}`);

  services.engine.schedule();
  // Settle Source Control operations a crash left open, from what Git and the
  // remote show. Runs in the background with its own time budget.
  // Repository automation (discovery + background sync) starts once recovery has settled the journal.
  void reconcileGitOperations({ operations: services.gitOperations, repositories: services.repositories })
    .then(
      (report) => {
        if (report.resolved.length) app.log.warn(`Source Control recovery: ${report.resolved.map((r) => `${r.kind} ${r.id} → ${r.status}`).join(', ')}`);
        for (const repo of services.store.listRepositories()) services.sourceControl.invalidate(repo.id);
      },
      (error: unknown) => app.log.error(`Source Control recovery failed: ${(error as Error).message}`),
    )
    .finally(() => {
      if (config.repositoryAutomation) services.repositoryAutomation.start();
      else app.log.info('Repository automation is off (ACC_REPOSITORY_AUTOMATION=0)');
    });
  services.watchdog.start();
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
