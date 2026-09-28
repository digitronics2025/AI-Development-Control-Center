import { TriangleAlert } from 'lucide-react';
import { Badge, Skeleton } from '@acc/ui';
import type { AgentInfo } from '@acc/shared';
import { useAgents } from '../api/hooks';

/** The installed CLI version as the list shows it. */
export function agentVersionText(agent: AgentInfo): string {
  const { found, version } = agent.detection;
  if (!found) return 'Not detected';
  if (!version) return 'Version unknown';
  return /^\d/.test(version) ? `v${version}` : version;
}

/** Which versions the Control Center was tested with; null when no verdict applies (simulated, not detected). */
export function testedText(agent: AgentInfo): string | null {
  if (!agent.compat) return null;
  const { tested } = agent.compat;
  if (!tested) return `No version of ${agent.name} has been tested with the Control Center.`;
  return tested.min === tested.max ? `Tested with version ${tested.min}.` : `Tested with versions ${tested.min} to ${tested.max}.`;
}

/**
 * Settings → Agents & Models: each agent's installed CLI version, with an
 * Unverified badge when it is outside the versions the Control Center was
 * tested with (GET /api/agents → `compat`).
 */
export function AgentVersions() {
  const agents = useAgents();
  if (agents.isLoading) return <Skeleton className="h-16" />;
  const list = agents.data ?? [];
  if (!list.length) return null;
  return (
    <section aria-labelledby="agent-versions" className="flex flex-col gap-2">
      <h3 id="agent-versions" className="text-h3 text-fg">
        Installed versions
      </h3>
      <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
        {list.map((a) => {
          const unverified = a.compat?.status === 'unverified';
          return (
            <li key={a.id} className="flex min-w-0 flex-col gap-1 px-3 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-body font-semibold text-fg">{a.name}</span>
                <span className="font-mono text-small text-fg-secondary wrap-anywhere">{agentVersionText(a)}</span>
                {unverified ? (
                  <Badge title={testedText(a) ?? undefined}>
                    <TriangleAlert size={12} className="shrink-0 text-warning" aria-hidden />
                    Unverified
                  </Badge>
                ) : a.compat ? (
                  <span className="text-small text-fg-secondary">Tested</span>
                ) : null}
              </div>
              {unverified ? (
                <p className="max-w-prose text-small text-fg-secondary">
                  {testedText(a)} Runs still go ahead, and stop rather than guess when its output is not what the Control Center expects.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
