/**
 * The secret preflight lives in @acc/git (packages/git/src/preflight.ts) so
 * the `git.push` tool runs the same check as Source Control and a release.
 */
export { addedLinesByFile, MAX_PREFLIGHT_BYTES, preflightFindings, scanOutgoing, withoutSensitiveFiles, type PreflightFinding } from '@acc/git';
