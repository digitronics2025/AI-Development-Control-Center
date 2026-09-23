import { builtinDetection, collectEnvironment, environmentMarkdown, failure, operation, projectType, type ToolProvider } from '@acc/tools';
import { z } from 'zod';
import type { EngineTooling } from '../engine/tooling.js';
import type { RepositoryService } from '../services/repositories.js';
import type { Store } from '../store/store.js';

/**
 * `environment.discover` (V2 plan §36) as a capability, so agents and the
 * dashboard can ask for the same report the engine collects before a task.
 */
export function environmentProvider(d: { store: Store; repositories: RepositoryService; tooling: EngineTooling }): ToolProvider {
  return {
    id: 'environment',
    name: 'Environment discovery',
    description: 'Machine, repository, toolchain, listening ports and running task processes in one report.',
    category: 'environment',
    builtin: true,
    async detect() {
      return builtinDetection();
    },
    operations: [
      operation({
        id: 'environment.discover',
        title: 'Describe the environment',
        description: 'Operating system, CPU, memory, disk, repository branch and state, installed tools and versions, listening ports and this task’s background processes.',
        input: z.object({}),
        level: 1,
        async run(_input, ctx) {
          const task = ctx.taskId ? d.store.getTask(ctx.taskId) : null;
          if (task) {
            const repo = d.repositories.record(task.repositoryId);
            const markdown = await d.tooling.discoverEnvironment(task, repo);
            return markdown ? { ok: true, summary: 'Environment report', stdout: markdown } : failure('UNAVAILABLE', 'Environment discovery is turned off in Settings → Execution');
          }
          const repo = d.store.listRepositories().find((r) => ctx.cwd.toLowerCase().startsWith(r.path.toLowerCase()));
          const report = await collectEnvironment({
            cwd: ctx.cwd,
            tooling: repo?.tooling ?? [],
            projectType: repo ? projectType(repo.tooling) : undefined,
            tools: d.tooling.tools.registry
              .listProviders({ platform: process.platform })
              .filter((p) => !p.builtin)
              .map((p) => ({ id: p.id, name: p.name, detection: d.tooling.tools.health.get(p.id) })),
          });
          return { ok: true, summary: 'Environment report', stdout: environmentMarkdown(report), output: report };
        },
      }),
    ],
  };
}
