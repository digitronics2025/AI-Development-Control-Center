import os from 'node:os';
import path from 'node:path';
import { redactDeep } from '@acc/security';
import type { ServerMessage, ServerMessageType } from '@acc/shared';

/**
 * Cloud egress policy (docs/systems/remote-node.md §Egress). Everything that
 * leaves this machine for the cloud passes through here: mirrored events,
 * live realtime messages, command results and RPC responses.
 *
 * Three layers, in order:
 *  1. Message-type allowlist: a type not listed never leaves (terminal output
 *     only for a terminal the cloud was granted).
 *  2. Field rules: local paths and executables are removed from the entity
 *     types that carry them; secret-named keys are dropped everywhere.
 *  3. Deep scrub of every remaining string: registered roots become
 *     placeholders, any other absolute path keeps only its last segment, and
 *     the shared redactor removes credential values, environment secrets and
 *     known token formats (the local API token is registered with it).
 */

/** Mirrored in D1 (durable, through the outbox). */
export const MIRRORED_MESSAGE_TYPES: ReadonlySet<ServerMessageType> = new Set<ServerMessageType>([
  'task',
  'task.deleted',
  'event',
  'approval',
  'artifact',
  'repository',
  'repository.deleted',
  'agents',
  'usage',
]);

/** Forwarded live to connected browsers only; never stored in the cloud. */
export const LIVE_MESSAGE_TYPES: ReadonlySet<ServerMessageType> = new Set<ServerMessageType>([
  'stage',
  'execution',
  'logs',
  'directive',
  'testRun',
  'settings',
  'workflow',
  'workflow.deleted',
  'sourceControl',
  'repositoryAutomation',
  'chairman',
  'chairman.message',
  'chairman.decision',
  'chairman.action',
  'checkpoint',
  'tool',
  'toolExecution',
  'taskProcess',
  'terminal',
  'mcpServer',
  'mcpServer.deleted',
  'credential',
  'credential.deleted',
  'recovery',
  'escalation',
]);

/** Keys dropped wherever they appear, whatever their value. */
const SECRET_KEYS = new Set(
  ['env', 'environment', 'token', 'authtoken', 'accesstoken', 'refreshtoken', 'apikey', 'secret', 'password', 'passphrase', 'ciphertext', 'privatekey', 'cookie', 'authorization', 'envcredentials'].map((k) => k.toLowerCase()),
);

export interface EgressRoots {
  /** Registered repositories and their worktrees. */
  repositories: Array<{ path: string; name: string }>;
  dataDir: string;
  homeDir?: string;
}

// Separators may repeat: text that went through JSON escaping carries `D:\\x\\y`.
const WINDOWS_PATH = /\b[A-Za-z]:[\\/]+(?:[^\\/\s"'<>|:*?]+[\\/]+)*[^\\/\s"'<>|:*?]*/g;
/** Network shares: `\\server\share\…` (also JSON-escaped). */
const UNC_PATH = /\\{2,}[^\\/\s"'<>|:*?]+(?:[\\/]+[^\\/\s"'<>|:*?]+)+/g;
const POSIX_HOME_PATH = /(?<![\w.])\/(?:home|Users|root|var|tmp|private|opt|mnt|srv)\/(?:[^/\s"'<>|:]+\/)*[^/\s"'<>|:]*/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Both separator spellings of a Windows path, case-insensitive. */
function rootPattern(root: string): RegExp {
  const normalized = root.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]+/).map(escapeRegExp);
  return new RegExp(parts.join('[\\\\/]+'), 'gi');
}

export class EgressSanitizer {
  private roots: Array<{ pattern: RegExp; replacement: string; length: number }> = [];

  constructor(roots: EgressRoots) {
    this.setRoots(roots);
  }

  setRoots(roots: EgressRoots): void {
    const entries = [
      ...roots.repositories.filter((r) => r.path).map((r) => ({ root: r.path, replacement: `<repo:${r.name.replace(/[<>]/g, '')}>` })),
      { root: roots.dataDir, replacement: '<acc-data>' },
      { root: roots.homeDir ?? os.homedir(), replacement: '<home>' },
    ].filter((e) => e.root && (path.win32.isAbsolute(e.root) || path.posix.isAbsolute(e.root)));
    // Longest first: a repository under the home folder keeps its own name.
    this.roots = entries
      .map((e) => ({ pattern: rootPattern(e.root), replacement: e.replacement, length: e.root.length }))
      .sort((a, b) => b.length - a.length);
  }

  /** Replace local paths in one string. */
  scrubText(text: string): string {
    let out = text;
    for (const root of this.roots) out = out.replace(root.pattern, root.replacement);
    out = out.replace(WINDOWS_PATH, (match) => `<path>${lastSegment(match)}`);
    out = out.replace(UNC_PATH, (match) => `<path>${lastSegment(match)}`);
    out = out.replace(POSIX_HOME_PATH, (match) => `<path>${lastSegment(match)}`);
    return out;
  }

  /** Drop secret-named keys and scrub every string, then run the shared redactor. */
  scrub<T>(value: T): T {
    return redactDeep(this.walk(value)) as T;
  }

  private walk(value: unknown, depth = 0): unknown {
    if (depth > 40) return null;
    if (typeof value === 'string') return this.scrubText(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEYS.has(k.toLowerCase())) continue;
        out[k] = this.walk(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  /** Entity-specific field rules, then the deep scrub. Returns null when the message must not leave. */
  message(message: ServerMessage, allowTerminal: (terminalId: string) => boolean = () => false): ServerMessage | null {
    if (message.type === 'terminal.output') return allowTerminal(message.terminalId) ? this.scrub(message) : null;
    if (!MIRRORED_MESSAGE_TYPES.has(message.type) && !LIVE_MESSAGE_TYPES.has(message.type)) return null;
    return this.scrub(applyFieldRules(message));
  }

  /** A local API response on its way to the cloud (command result or RPC). */
  response(body: unknown): unknown {
    return this.scrub(stripLocalFields(body));
  }
}

function lastSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? `/${parts.at(-1)}` : '';
}

/**
 * Local-only fields, removed by name from any object at any depth: repository
 * and worktree paths, executables, the data directory, bind address.
 * Applied to messages and to API responses alike.
 */
const LOCAL_FIELDS: Record<string, unknown> = {
  path: undefined,
  worktreePath: null,
  workspacePath: null,
  executablePath: null,
  dataDir: undefined,
  host: undefined,
  port: undefined,
  workdir: null,
  repositoryPath: undefined,
};

/** Keys whose value is a path only in these parents' shapes; elsewhere `path` is a repo-relative file path and stays. */
function isRepositoryLike(o: Record<string, unknown>): boolean {
  return typeof o.gitMode === 'string' && 'commands' in o;
}

function isAttachmentLike(o: Record<string, unknown>): boolean {
  return typeof o.name === 'string' && typeof o.size === 'number' && typeof o.path === 'string' && Object.keys(o).length <= 3;
}

function isHealthLike(o: Record<string, unknown>): boolean {
  return 'simulatedAgents' in o && 'billingMode' in o && 'dataDir' in o;
}

export function stripLocalFields(value: unknown, depth = 0): unknown {
  if (depth > 40) return null;
  if (Array.isArray(value)) return value.map((v) => stripLocalFields(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const repositoryLike = isRepositoryLike(o);
  const attachmentLike = isAttachmentLike(o);
  const healthLike = isHealthLike(o);
  for (const [k, v] of Object.entries(o)) {
    // `path` is removed only where it is a local folder or file; Git file paths are relative and stay.
    if (k === 'path' && !(repositoryLike || attachmentLike)) {
      out[k] = stripLocalFields(v, depth + 1);
      continue;
    }
    if ((k === 'host' || k === 'port' || k === 'dataDir') && !healthLike) {
      out[k] = stripLocalFields(v, depth + 1);
      continue;
    }
    if (k in LOCAL_FIELDS) {
      const replacement = LOCAL_FIELDS[k];
      if (replacement === null) out[k] = null;
      else if (k === 'path' && repositoryLike) out[k] = '';
      continue;
    }
    out[k] = stripLocalFields(v, depth + 1);
  }
  return out;
}

function applyFieldRules(message: ServerMessage): ServerMessage {
  return stripLocalFields(message) as ServerMessage;
}
