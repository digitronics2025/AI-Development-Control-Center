import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gitAliasPushes, gitPushTargets, mergesPullRequest } from '@acc/security';
import { PRODUCTION_BRANCH, type ClassifyContext, type ToolRisk } from './sdk.js';

/**
 * A push to the branch a repository releases from, or to a production-named
 * branch (`PRODUCTION_BRANCH`), is a production deploy (SEC-1): Level 5, a
 * typed approval for the operator and never an agent's. So is a pull-request
 * merge, whose base is not on the line. `git.push` judges its branch with
 * `deployingBranch`; every tool that runs a command line (shell.*,
 * process.exec/start, terminal.send and the line a terminal runs at Enter,
 * git.bisect, verify.web, node.run_script's script bodies) judges it with
 * `withReleaseGate`, and so do the engine's stage commands
 * (`stageCommandRisk`). A push whose destination cannot be read before it
 * runs counts as a deploy (fail closed).
 */

/** The context for a command run in `dir` (a tool's `cwd` input, relative to the call's folder): a push of HEAD is read there. */
export function inFolder(ctx: ClassifyContext, dir: string | undefined): ClassifyContext {
  return dir ? { ...ctx, cwd: path.resolve(ctx.cwd, dir) } : ctx;
}

/** Why a push to `branch` deploys the repository, or null. Compared without case: on Windows `Main` and `main` can be one ref. */
export function deployingBranch(branch: string, ctx: Pick<ClassifyContext, 'releaseBranches'>): string | null {
  const name = branch.replace(/^(?:refs\/)?heads\//i, '').toLowerCase();
  if ((ctx.releaseBranches ?? []).some((b) => b.toLowerCase() === name)) return `${branch} is this repository's release branch`;
  if (PRODUCTION_BRANCH.test(name)) return `${branch} is a production branch`;
  return null;
}

/**
 * The branch checked out in the repository holding `dir`, read from its
 * `HEAD` (a worktree's `.git` file names its own Git folder): null when
 * detached or not in a repository, undefined when it cannot be read. A
 * reftable repository (Git 2.45+, the default planned for Git 3) keeps only a
 * stub `ref: refs/heads/.invalid` there, so Git itself is asked; a Git that
 * cannot read the repository cannot say. Synchronous: classification is.
 */
export function checkedOutBranch(dir: string): string | null | undefined {
  let current = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(current, '.git');
    let gitDir: string | null = null;
    try {
      if (statSync(dotGit).isDirectory()) gitDir = dotGit;
      else {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1];
        if (pointer) gitDir = path.resolve(current, pointer);
      }
    } catch {
      /* no .git here */
    }
    if (gitDir) {
      let head: string;
      try {
        head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
      } catch {
        return null;
      }
      const ref = /^ref:\s*(.+?)\s*$/m.exec(head)?.[1];
      if (!ref) return null;
      if (ref === 'refs/heads/.invalid') return headFromGit(current);
      return /^refs\/heads\/(.+)$/.exec(ref)?.[1] ?? null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** The branch Git says is checked out in `dir`: null when detached, undefined when Git cannot say (it cannot read the repository, or is missing). */
function headFromGit(dir: string): string | null | undefined {
  try {
    const name = execFileSync('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return name && name !== '.invalid' ? name : undefined;
  } catch (error) {
    return (error as { status?: unknown }).status === 1 ? null : undefined;
  }
}

/**
 * Every Git alias the repository holding `dir` defines (its config, the
 * user's, the system's), by lowercased name, read with one `git config` call.
 * No Git, or no such folder: no alias runs there.
 */
function gitAliases(dir: string): Map<string, string> {
  let listed: string;
  try {
    listed = execFileSync('git', ['config', '-z', '--get-regexp', String.raw`^alias\.`], { cwd: dir, encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    // Exit 1: no alias is set.
    listed = String((error as { stdout?: unknown }).stdout ?? '');
  }
  const aliases = new Map<string, string>();
  // `-z`: each entry is `key\nvalue\0`, so a value may hold a line break.
  for (const entry of listed.split('\0')) {
    const nl = entry.indexOf('\n');
    if (nl > 'alias.'.length) aliases.set(entry.slice('alias.'.length, nl).toLowerCase(), entry.slice(nl + 1));
  }
  return aliases;
}

/**
 * Whether the Git alias `name`, as `aliases` define it, may push
 * (`gitAliasPushes`), followed through an alias of an alias. An alias that is
 * not set is no push.
 */
function aliasPushes(aliases: ReadonlyMap<string, string>, name: string): boolean {
  let alias = name;
  for (let depth = 0; depth < 8; depth++) {
    const value = aliases.get(alias.toLowerCase());
    if (value === undefined) return false;
    const runs = gitAliasPushes(value);
    if (typeof runs === 'boolean') return runs;
    alias = runs;
  }
  return true;
}

/**
 * Where this repository's settings send a push of `branch` without a
 * refspec, besides `branch` itself: `remote.<name>.push` refspecs, every
 * matching branch (`push.default=matching`), or the upstream
 * (`push.default=upstream`). Read through `git config` so the user's and the
 * system's settings, includes and worktree config count; only when a line
 * pushes without a refspec.
 */
function configuredPushTargets(cwd: string, branch: string | null): { every: boolean; branches: string[] } {
  let listed: string;
  try {
    listed = execFileSync('git', ['config', '--get-regexp', String.raw`^(push\.default|remote\..*\.(push|mirror)|branch\..*\.merge)$`], {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    // Exit 1: none of them is set. Git missing or not a repository: the push would not run either.
    listed = String((error as { stdout?: unknown }).stdout ?? '');
  }
  const out = { every: false, branches: [] as string[] };
  let pushDefault = '';
  const merges = new Map<string, string>();
  for (const line of listed.split(/\r?\n/)) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1).trim();
    if (/^remote\..+\.mirror$/i.test(key) && /^(?:true|yes|on|1)$/i.test(value)) out.every = true;
    else if (/^remote\..+\.push$/i.test(key)) {
      const destination = value.replace(/^\+/, '').split(':').pop() ?? '';
      if (value.replace(/^\+/, '') === ':' || destination.includes('*')) out.every = true;
      else if (destination && !/^(?:HEAD|@)$/i.test(destination) && !/^refs\/(?!heads\/)/i.test(destination)) out.branches.push(destination.replace(/^refs\/heads\//i, ''));
    } else if (/^push\.default$/i.test(key)) pushDefault = value.toLowerCase();
    else if (/^branch\..+\.merge$/i.test(key)) merges.set(key.slice('branch.'.length, -'.merge'.length), value);
  }
  if (pushDefault === 'matching') out.every = true;
  const upstream = branch !== null && (pushDefault === 'upstream' || pushDefault === 'tracking') ? merges.get(branch) : undefined;
  if (upstream) out.branches.push(upstream.replace(/^refs\/heads\//i, ''));
  return out;
}

/**
 * Why a command line deploys, or null: a `git push` (or a `gh api` write) to
 * a named release or production branch, to the branch checked out where it
 * runs (or one its settings send it to), to every branch, or to a
 * destination only known when it runs; a Git alias that pushes; or a
 * pull-request merge. `before` is what ran earlier in the same shell (a
 * terminal's earlier lines): its checkouts, folders and settings hold for
 * this line.
 */
export function pushDeploys(command: string, ctx: ClassifyContext, before?: string): string | null {
  if (mergesPullRequest(command)) return "it merges a pull request, and a pull request's base is usually the branch a repository releases from";
  const targets = gitPushTargets(command, before);
  if (!targets) return null;
  for (const branch of targets.branches) {
    const why = deployingBranch(branch, ctx);
    if (why) return why;
  }
  if (targets.current) {
    // The working folder, and each folder below it the push may run in (`cd web && git push`, `git -C web push`).
    for (const dir of [ctx.cwd, ...(targets.dirs ?? []).map((d) => path.resolve(ctx.cwd, d))]) {
      const why = headDeploys(dir, ctx);
      if (why) return why;
    }
  }
  if (targets.every) return 'it pushes every branch, release and production branches included';
  if (targets.unknown) return 'where it pushes is only known when it runs (a variable, a command run by another, or a branch or setting changed earlier), so it may be a release branch';
  // Each folder's aliases are read once, however many subcommands the line names (a long line is not a long wait).
  const read = new Map<string, Map<string, string>>();
  const aliasesIn = (dir: string) => {
    let aliases = read.get(dir);
    if (!aliases) read.set(dir, (aliases = gitAliases(dir)));
    return aliases;
  };
  for (const alias of targets.aliases ?? []) {
    if (alias.dirs.some((d) => aliasPushes(aliasesIn(path.resolve(ctx.cwd, d)), alias.name))) return `\`git ${alias.name}\` is a Git alias that pushes, and where it pushes is only known when it runs, so it may be a release branch`;
  }
  return null;
}

/** Why a push of HEAD in `dir` deploys: the branch checked out there, or where the repository's push settings send it. */
function headDeploys(dir: string, ctx: ClassifyContext): string | null {
  const branch = checkedOutBranch(dir);
  if (branch === undefined) return 'the branch checked out cannot be read (a reftable repository this Git cannot read), so it may be a release branch';
  const why = branch ? deployingBranch(branch, ctx) : null;
  if (why) return `${why}, and it is checked out`;
  const configured = configuredPushTargets(dir, branch);
  if (configured.every) return "this repository's push settings push every matching branch, release and production branches included";
  for (const target of configured.branches) {
    const via = deployingBranch(target, ctx);
    if (via) return `${via}, and this repository's push settings send the branch there`;
  }
  return null;
}

/** A command's risk, raised to Level 5 production when it deploys (`pushDeploys`). */
export function withReleaseGate(risk: Partial<ToolRisk>, command: string, ctx: ClassifyContext, before?: string): Partial<ToolRisk> {
  const why = pushDeploys(command, ctx, before);
  if (!why) return risk;
  return {
    ...risk,
    level: 5,
    risk: risk.risk === 'dangerous' ? 'dangerous' : 'elevated',
    production: true,
    reasons: [...(risk.reasons ?? []), `Deploys: ${why}`],
    effects: [...new Set([...(risk.effects ?? []), 'production' as const])],
  };
}
