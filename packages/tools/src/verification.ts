import type { CommandKind } from '@acc/shared';

/**
 * The verification matrix (V2 plan §42): which evidence a project type needs
 * before a task can call itself verified. Only relevant checks are required —
 * a library needs no browser, a web app needs no APK.
 */

export const PROJECT_TYPES = ['web', 'worker', 'android', 'python', 'library'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export interface CheckRequirement {
  id: string;
  label: string;
  /** Satisfied by a passing repository command of one of these kinds… */
  commandKinds?: readonly CommandKind[];
  /** …or by orchestrator-observed evidence of this kind. */
  evidence?: 'browser' | 'http' | 'device';
  /** Missing it lowers confidence but does not block READY. */
  advisory?: boolean;
}

export function projectType(tooling: readonly string[]): ProjectType {
  const has = (t: string) => tooling.includes(t);
  if (has('gradle') || has('android')) return 'android';
  if (has('wrangler')) return 'worker';
  if (has('react') || has('vite') || has('next')) return 'web';
  if (has('python')) return 'python';
  return 'library';
}

const MATRIX: Record<ProjectType, CheckRequirement[]> = {
  web: [
    { id: 'lint', label: 'Lint', commandKinds: ['lint'], advisory: true },
    { id: 'typecheck', label: 'Typecheck', commandKinds: ['typecheck'], advisory: true },
    { id: 'tests', label: 'Unit tests', commandKinds: ['test'] },
    { id: 'build', label: 'Build', commandKinds: ['build'] },
    { id: 'browser', label: 'Browser check (console, network, phone width)', commandKinds: ['e2e'], evidence: 'browser' },
  ],
  worker: [
    { id: 'lint', label: 'Lint', commandKinds: ['lint'], advisory: true },
    { id: 'typecheck', label: 'Typecheck', commandKinds: ['typecheck'], advisory: true },
    { id: 'tests', label: 'Tests', commandKinds: ['test'] },
    { id: 'build', label: 'Build', commandKinds: ['build'], advisory: true },
    { id: 'http', label: 'HTTP check against the local Worker', commandKinds: ['smoke', 'e2e'], evidence: 'http' },
  ],
  android: [
    { id: 'lint', label: 'Lint', commandKinds: ['lint'], advisory: true },
    { id: 'tests', label: 'Unit tests', commandKinds: ['test'] },
    { id: 'build', label: 'Gradle build (APK)', commandKinds: ['build'] },
    { id: 'device', label: 'Install and launch on a device', evidence: 'device', advisory: true },
  ],
  python: [
    { id: 'lint', label: 'Lint', commandKinds: ['lint'], advisory: true },
    { id: 'tests', label: 'Tests', commandKinds: ['test'] },
  ],
  library: [
    { id: 'lint', label: 'Lint', commandKinds: ['lint'], advisory: true },
    { id: 'typecheck', label: 'Typecheck', commandKinds: ['typecheck'], advisory: true },
    { id: 'tests', label: 'Tests', commandKinds: ['test'] },
    { id: 'build', label: 'Build', commandKinds: ['build'], advisory: true },
  ],
};

const EXTRA_EVIDENCE: Record<'browser' | 'http' | 'device', CheckRequirement> = {
  browser: { id: 'browser', label: 'Browser check (console, network, phone width)', evidence: 'browser', advisory: true },
  http: { id: 'http', label: 'HTTP check', evidence: 'http', advisory: true },
  device: { id: 'device', label: 'Install and launch on a device', evidence: 'device', advisory: true },
};

export function requiredChecks(type: ProjectType): CheckRequirement[] {
  return MATRIX[type];
}

export interface VerificationEvidence {
  /** Command kinds whose latest run in the last tests stage passed. */
  passedKinds: ReadonlySet<CommandKind>;
  /** Kinds of orchestrator-observed evidence that passed (from verify stages or tool calls). */
  observed: ReadonlySet<'browser' | 'http' | 'device'>;
}

export interface VerificationAssessment {
  type: ProjectType;
  satisfied: CheckRequirement[];
  missing: CheckRequirement[];
  /** Missing non-advisory checks. */
  blocking: CheckRequirement[];
}

export function assessVerification(type: ProjectType, evidence: VerificationEvidence): VerificationAssessment {
  const satisfied: CheckRequirement[] = [];
  const missingChecks: CheckRequirement[] = [];
  for (const check of requiredChecks(type)) {
    const byCommand = check.commandKinds?.some((k) => evidence.passedKinds.has(k)) ?? false;
    const byEvidence = check.evidence ? evidence.observed.has(check.evidence) : false;
    (byCommand || byEvidence ? satisfied : missingChecks).push(check);
  }
  // Evidence the orchestrator observed counts even where the type does not ask for it
  // (a plain Node server has no framework to be detected as "web", yet was checked in a browser).
  for (const kind of evidence.observed) {
    if (!requiredChecks(type).some((c) => c.evidence === kind)) satisfied.push(EXTRA_EVIDENCE[kind]);
  }
  return { type, satisfied, missing: missingChecks, blocking: missingChecks.filter((c) => !c.advisory) };
}
