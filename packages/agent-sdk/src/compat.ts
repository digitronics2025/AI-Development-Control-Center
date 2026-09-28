/**
 * Tested CLI versions (docs/systems/agents-contract.md#tested-cli-versions): each
 * adapter names, in agents.compat.json, the CLI versions it was verified
 * against. An installed version outside that range still runs — the adapter's
 * fail-closed checks (billing tripwire, PROTOCOL_DRIFT) guard it — but the
 * dashboard marks it unverified so a CLI update is noticed before it misleads.
 */
import type { AgentCompat } from '@acc/shared';
import compat from '../agents.compat.json' with { type: 'json' };

export interface TestedVersions {
  min: string;
  max: string;
}

/** The tested range per agent id, as agents.compat.json declares it. */
export const TESTED_CLI_VERSIONS: Readonly<Record<string, TestedVersions>> = compat.tested;

/** `[major, minor, patch]` of a plain `x.y.z` version; null for anything else (a pre-release or build suffix included). */
function parts(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The installed `version` against the agent's tested range. Anything that
 * cannot be shown inside the range — no range declared, a version that is
 * not plain `x.y.z` — is `unverified`.
 */
export function cliCompat(agentId: string, version: string, tested: Readonly<Record<string, TestedVersions>> = TESTED_CLI_VERSIONS): AgentCompat {
  const range = Object.hasOwn(tested, agentId) ? tested[agentId]! : null;
  if (!range) return { tested: null, status: 'unverified' };
  const installed = parts(version);
  const min = parts(range.min);
  const max = parts(range.max);
  const inside = Boolean(installed && min && max && compare(installed, min) >= 0 && compare(installed, max) <= 0);
  return { tested: { min: range.min, max: range.max }, status: inside ? 'tested' : 'unverified' };
}
