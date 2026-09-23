import { z } from 'zod';
import type { ServerMessage } from './ws.js';

/**
 * Cloud control plane ↔ execution node protocol (docs/systems/remote-node.md,
 * docs/systems/cloud-control.md). Runtime-neutral: used by the orchestrator
 * (Node.js), the Worker and the Durable Object alike, so it depends on Zod
 * and Web Crypto only.
 */

export const REMOTE_PROTOCOL_VERSION = 1;
/** Oldest node protocol the cloud still sends commands to. */
export const REMOTE_MIN_PROTOCOL_VERSION = 1;

export const REMOTE_LIMITS = {
  /** One WebSocket frame, either direction. */
  frameBytes: 1024 * 1024,
  /** A remote command's JSON body. */
  commandBodyBytes: 256 * 1024,
  /** Events in one `event.batch`, and their serialized size. */
  batchEvents: 200,
  batchBytes: 900 * 1024,
  /** A mirrored TaskDetail snapshot. */
  snapshotBytes: 900 * 1024,
  /** One chunk of a chunked RPC response, and the whole response. */
  rpcChunkBytes: 256 * 1024,
  rpcResponseBytes: 8 * 1024 * 1024,
  /** Artifact and log-chunk objects stored in R2. */
  artifactBytes: 25 * 1024 * 1024,
  logChunkBytes: 1024 * 1024,
  /** Query parameters forwarded with an operation. */
  queryKeys: 30,
  queryValueChars: 2000,
} as const;

/** Error codes the cloud and the node add to the local API's own codes. */
export const REMOTE_ERROR_CODES = [
  'NODE_OFFLINE',
  'NODE_NOT_FOUND',
  'NODE_REQUIRED',
  'NODE_REVOKED',
  'NODE_UPDATE_REQUIRED',
  'REMOTE_COMMAND_EXPIRED',
  'REMOTE_CONFLICT',
  'REMOTE_FORBIDDEN',
  'REMOTE_INVALID',
  'REMOTE_TIMEOUT',
  'REMOTE_UNAVAILABLE',
  'REMOTE_INTERRUPTED',
  'LEASE_CONFLICT',
  'CLOUD_UNAVAILABLE',
  'RATE_LIMITED',
  'UNAUTHORIZED',
] as const;
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level and `undefined` members dropped: equal values → equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return 'null';
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a string or bytes, lowercase hex. Web Crypto: identical in Node.js 22 and Workers. */
export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/, 'Invalid id');
export const nodeIdSchema = z.string().regex(/^node_[A-Za-z0-9_-]{16,64}$/, 'Invalid node id');
const isoSchema = z.string().min(10).max(40);
/** A path parameter: one segment, decoded. `/`, `\`, `?`, `#`, whitespace and dot-segments are refused. */
export const pathParamSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v !== '.' && v !== '..' && !/[/\\?#\s]/.test(v), 'Invalid path parameter');

export const remoteQuerySchema = z
  .record(z.string().min(1).max(60), z.string().max(REMOTE_LIMITS.queryValueChars))
  .refine((q) => Object.keys(q).length <= REMOTE_LIMITS.queryKeys, 'Too many query parameters');

/** A P-256 public key as a JWK; private members are refused. */
export const publicJwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(40).max(64),
    y: z.string().min(40).max(64),
  })
  .strict();
export type PublicJwk = z.infer<typeof publicJwkSchema>;

// ---------------------------------------------------------------------------
// Pairing and sessions (HTTP on the relay hostname)
// ---------------------------------------------------------------------------

export const PAIRING_TOKEN_PREFIX = 'accpair_';
export const pairingTokenSchema = z.string().regex(/^accpair_[A-Za-z0-9_-]{40,64}$/, 'That is not a pairing code');

export const nodeInfoSchema = z.object({
  label: z.string().min(1).max(80),
  os: z.string().max(80),
  appVersion: z.string().max(40),
  protocolVersion: z.number().int().min(1).max(1000),
});
export type NodeInfo = z.infer<typeof nodeInfoSchema>;

export const pairRequestSchema = nodeInfoSchema.extend({ token: pairingTokenSchema, publicKey: publicJwkSchema });
export const pairResponseSchema = z.object({ nodeId: nodeIdSchema, label: z.string() });
export const challengeRequestSchema = z.object({ nodeId: nodeIdSchema });
export const challengeResponseSchema = z.object({ nonce: z.string().min(32).max(128), expiresAt: isoSchema });
export const sessionRequestSchema = z.object({
  nodeId: nodeIdSchema,
  nonce: z.string().min(32).max(128),
  signature: z.string().min(40).max(200),
  protocolVersion: z.number().int().min(1).max(1000),
});
export const sessionResponseSchema = z.object({ session: z.string().min(40).max(400), expiresAt: isoSchema, protocolVersion: z.number().int() });
export const rotateRequestSchema = z.object({ nonce: z.string().min(32).max(128), publicKey: publicJwkSchema, signature: z.string().min(40).max(200) });

/** The bytes a node signs to prove it holds its key; bound to purpose, node and nonce. */
export function sessionProofMessage(purpose: 'session' | 'rotate', nodeId: string, nonce: string): string {
  return `acc-node-${purpose}:v${REMOTE_PROTOCOL_VERSION}:${nodeId}:${nonce}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** What the node checks immediately before executing, beyond the operation's own validation. */
export const commandPreconditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('taskVersion'), taskId: idSchema, version: z.number().int().min(0) }),
  z.object({ kind: z.literal('approval'), approvalId: idSchema, hash: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
export type CommandPrecondition = z.infer<typeof commandPreconditionSchema>;

export const remoteCommandSchema = z.object({
  id: idSchema,
  nodeId: nodeIdSchema,
  op: z.string().min(3).max(60),
  params: z.record(z.string(), pathParamSchema),
  query: remoteQuerySchema,
  body: z.unknown().optional(),
  idempotencyKey: z.string().min(8).max(120),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  precondition: commandPreconditionSchema.nullable(),
  createdBy: z.string().max(200),
  createdAt: isoSchema,
  expiresAt: isoSchema,
});
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

/** The hash binds everything the node acts on; a changed field is a different command. */
export function commandPayloadHash(c: Pick<RemoteCommand, 'nodeId' | 'op' | 'params' | 'query' | 'body' | 'precondition' | 'expiresAt'>): Promise<string> {
  return sha256Hex(canonicalJson({ nodeId: c.nodeId, op: c.op, params: c.params, query: c.query, body: c.body ?? null, precondition: c.precondition, expiresAt: c.expiresAt }));
}

export const COMMAND_STATUSES = ['pending', 'delivered', 'claimed', 'succeeded', 'failed', 'expired', 'rejected'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];
export const TERMINAL_COMMAND_STATUSES: readonly CommandStatus[] = ['succeeded', 'failed', 'expired', 'rejected'];

/** Legal transitions; anything else is refused by the cloud store. */
export const COMMAND_TRANSITIONS: Readonly<Record<CommandStatus, readonly CommandStatus[]>> = {
  pending: ['delivered', 'claimed', 'succeeded', 'failed', 'expired', 'rejected'],
  delivered: ['claimed', 'succeeded', 'failed', 'expired', 'rejected'],
  claimed: ['succeeded', 'failed', 'rejected'],
  succeeded: [],
  failed: [],
  expired: [],
  rejected: [],
};

export function canTransition(from: CommandStatus, to: CommandStatus): boolean {
  return COMMAND_TRANSITIONS[from].includes(to);
}

/** What the node ran and what the local API answered (sanitized). */
export const commandOutcomeSchema = z.object({
  httpStatus: z.number().int().min(100).max(599),
  body: z.unknown(),
});
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;

// ---------------------------------------------------------------------------
// Artifact sync policy
// ---------------------------------------------------------------------------

export const ARTIFACT_SENSITIVITIES = ['safe_sync', 'local_only', 'user_shared'] as const;
export type ArtifactSensitivity = (typeof ARTIFACT_SENSITIVITIES)[number];

/**
 * Default cloud policy per artifact type. Generated, redacted reports and logs
 * may sync; anything carrying repository content (diffs), machine details
 * (environment) or raw tool data stays on the node unless the user shares it
 * from that machine.
 */
const LOCAL_ONLY_ARTIFACTS: ReadonlySet<string> = new Set(['git-diff', 'staged-diff', 'environment', 'task-json', 'tool-output']);

export function defaultArtifactSensitivity(type: string): ArtifactSensitivity {
  return LOCAL_ONLY_ARTIFACTS.has(type) ? 'local_only' : 'safe_sync';
}

/** Fields of an approval the cloud binds a remote decision to (hashed over the node's sanitized view). */
export function approvalBindingHash(a: { id: string; taskId: string; kind: string; action: string; command: string | null; permissionLevel: number; risk: string; confirmationPhrase: string | null; stageId: string | null }): Promise<string> {
  return sha256Hex(canonicalJson({ id: a.id, taskId: a.taskId, kind: a.kind, action: a.action, command: a.command, permissionLevel: a.permissionLevel, risk: a.risk, confirmationPhrase: a.confirmationPhrase, stageId: a.stageId }));
}

// ---------------------------------------------------------------------------
// Node views shown to the dashboard
// ---------------------------------------------------------------------------

export const NODE_STATUSES = ['online', 'degraded', 'offline', 'revoked'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const nodeRepositorySchema = z.object({
  localId: idSchema,
  name: z.string().max(200),
  /** SHA-256 of the normalized remote identity (credentials stripped), or of node + local id without a remote. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  remoteHost: z.string().max(200).nullable(),
  defaultBranch: z.string().max(200).nullable(),
});
export type NodeRepository = z.infer<typeof nodeRepositorySchema>;

export const nodeCapabilitiesSchema = z.object({
  agents: z
    .array(z.object({ id: idSchema, name: z.string().max(100), state: z.string().max(40), billing: z.string().max(20) }))
    .max(20),
  tools: z.array(z.object({ id: idSchema, state: z.string().max(40) })).max(200),
  features: z.object({ remoteTerminals: z.boolean(), remoteTools: z.boolean(), simulatedAgents: z.boolean() }),
});
export type NodeCapabilities = z.infer<typeof nodeCapabilitiesSchema>;

export interface CloudNodeView {
  id: string;
  label: string;
  status: NodeStatus;
  os: string | null;
  appVersion: string | null;
  protocolVersion: number | null;
  /** The node speaks a protocol older than the cloud accepts commands from. */
  updateRequired: boolean;
  capabilities: NodeCapabilities | null;
  repositories: NodeRepository[];
  keyVersion: number;
  createdAt: string;
  lastSeenAt: string | null;
  connectedAt: string | null;
  revokedAt: string | null;
}

export interface CloudCommandView {
  id: string;
  nodeId: string;
  op: string;
  status: CommandStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  finishedAt: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  taskId: string | null;
}

export interface CloudPairingToken {
  id: string;
  label: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface CloudSession {
  user: { email: string };
  /** The address a node pairs with (the relay hostname). */
  relayUrl: string;
  protocolVersion: number;
  minProtocolVersion: number;
  environment: string;
  nodes: CloudNodeView[];
}

/** Messages only the cloud sends to browsers, alongside the node's own ServerMessages. */
export type CloudServerMessage =
  | { type: 'remote.node'; node: CloudNodeView }
  | { type: 'remote.command'; command: CloudCommandView };

/** A ServerMessage relayed by the cloud carries the node it came from. */
export type RelayedServerMessage = (ServerMessage | CloudServerMessage) & { nodeId?: string };

// ---------------------------------------------------------------------------
// The node's own remote-access state (local dashboard only; never relayed)
// ---------------------------------------------------------------------------

export const REMOTE_LINK_STATES = ['unpaired', 'disabled', 'connecting', 'connected', 'offline', 'revoked', 'update-required'] as const;
export type RemoteLinkState = (typeof REMOTE_LINK_STATES)[number];

export interface RemoteNodeStatus {
  paired: boolean;
  state: RemoteLinkState;
  nodeId: string | null;
  label: string | null;
  relayUrl: string | null;
  enabled: boolean;
  remoteTerminals: boolean;
  remoteTools: boolean;
  keyVersion: number | null;
  pairedAt: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  outboxDepth: number;
  protocolVersion: number;
}

export const remotePairInputSchema = z.object({
  relayUrl: z.string().min(8).max(300),
  code: pairingTokenSchema,
  label: z.string().trim().min(1).max(80),
});
export const remotePermissionsSchema = z
  .object({ enabled: z.boolean(), remoteTerminals: z.boolean(), remoteTools: z.boolean(), label: z.string().trim().min(1).max(80) })
  .partial();

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

const envelope = { v: z.number().int().min(1).max(1000), id: z.string().min(8).max(120), at: isoSchema };

const outboxEventSchema = z.object({
  seq: z.number().int().min(1),
  /** A relayed realtime message, or a snapshot the cloud mirrors. */
  kind: z.enum(['message', 'taskDetail']),
  payload: z.unknown(),
});
export type OutboxEvent = z.infer<typeof outboxEventSchema>;

/** Node → cloud. */
export const nodeFrameSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('node.hello'), payload: nodeInfoSchema.extend({ lastIssuedSeq: z.number().int().min(0) }) }),
  z.object({ ...envelope, type: z.literal('node.capabilities'), payload: nodeCapabilitiesSchema }),
  z.object({ ...envelope, type: z.literal('node.snapshot'), payload: z.object({ repositories: z.array(nodeRepositorySchema).max(1000), activeTasks: z.number().int().min(0) }) }),
  z.object({ ...envelope, type: z.literal('node.heartbeat'), payload: z.object({ activeTasks: z.number().int().min(0), outboxDepth: z.number().int().min(0) }) }),
  z.object({ ...envelope, type: z.literal('event.batch'), payload: z.object({ events: z.array(outboxEventSchema).min(1).max(REMOTE_LIMITS.batchEvents) }) }),
  /** Realtime-only messages (not mirrored): stage progress, logs for subscribed executions, tool activity. */
  z.object({ ...envelope, type: z.literal('event.live'), payload: z.object({ message: z.unknown() }) }),
  z.object({ ...envelope, type: z.literal('command.claim'), payload: z.object({ commandId: idSchema }) }),
  z.object({ ...envelope, type: z.literal('command.result'), payload: z.object({ commandId: idSchema, outcome: commandOutcomeSchema, replayed: z.boolean() }) }),
  z.object({ ...envelope, type: z.literal('command.failed'), payload: z.object({ commandId: idSchema, code: z.string().max(60), message: z.string().max(2000), status: z.enum(['failed', 'rejected', 'expired']) }) }),
  z.object({ ...envelope, type: z.literal('sync.request'), payload: z.object({ want: z.literal('pendingCommands') }) }),
  z.object({
    ...envelope,
    type: z.literal('rpc.response'),
    payload: z.object({
      requestId: idSchema,
      httpStatus: z.number().int().min(100).max(599),
      contentType: z.string().max(200),
      /** Response text (JSON, or base64 when `encoding` says so), split when large. */
      chunk: z.string(),
      index: z.number().int().min(0),
      total: z.number().int().min(1).max(64),
      encoding: z.enum(['utf8', 'base64']),
    }),
  }),
  z.object({ ...envelope, type: z.literal('artifact.manifest'), payload: z.object({ artifactId: idSchema, taskId: idSchema, name: z.string().max(200), mime: z.string().max(100), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), sensitivity: z.enum(['safe_sync', 'local_only', 'user_shared']), status: z.enum(['pending', 'uploaded', 'failed', 'local_only']), error: z.string().max(500).nullable() }) }),
  z.object({ ...envelope, type: z.literal('log.chunk.manifest'), payload: z.object({ executionId: idSchema, taskId: idSchema, chunkIndex: z.number().int().min(0), firstSeq: z.number().int(), lastSeq: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0) }) }),
]);
export type NodeFrame = z.infer<typeof nodeFrameSchema>;
export type NodeFrameType = NodeFrame['type'];

/** Cloud → node. */
export type CloudFrame =
  | { v: number; id: string; at: string; type: 'session.welcome'; payload: { nodeId: string; protocolVersion: number; minProtocolVersion: number; ackedSeq: number; serverTime: string } }
  | { v: number; id: string; at: string; type: 'command.available'; payload: { command: RemoteCommand } }
  | { v: number; id: string; at: string; type: 'sync.ack'; payload: { upToSeq: number } }
  /** The cloud stored this command's result; the node stops replaying it. */
  | { v: number; id: string; at: string; type: 'command.ack'; payload: { commandId: string } }
  | { v: number; id: string; at: string; type: 'sync.complete'; payload: { pending: number } }
  | { v: number; id: string; at: string; type: 'rpc.request'; payload: { requestId: string; op: string; params: Record<string, string>; query: Record<string, string>; body?: unknown; deadline: string } }
  | { v: number; id: string; at: string; type: 'subscriptions'; payload: { logs: string[]; terminals: string[] } }
  | { v: number; id: string; at: string; type: 'terminal.input'; payload: { terminalId: string; data: string } }
  | { v: number; id: string; at: string; type: 'terminal.resize'; payload: { terminalId: string; cols: number; rows: number } }
  | { v: number; id: string; at: string; type: 'node.rotate'; payload: { requestedBy: string } }
  | { v: number; id: string; at: string; type: 'node.revoked'; payload: { reason: string } };

export const cloudFrameSchema = z.object({ v: z.number().int(), id: z.string().max(120), at: isoSchema, type: z.string().max(60), payload: z.unknown() });

export function frame<T extends { type: string; payload: unknown }>(message: T, id: string = crypto.randomUUID()): T & { v: number; id: string; at: string } {
  return { v: REMOTE_PROTOCOL_VERSION, id, at: new Date().toISOString(), ...message };
}

/** Parse a node frame, rejecting oversize text, unknown types and a protocol the cloud cannot speak. */
export function parseNodeFrame(text: string): { ok: true; frame: NodeFrame } | { ok: false; code: RemoteErrorCode; message: string } {
  if (text.length > REMOTE_LIMITS.frameBytes) return { ok: false, code: 'REMOTE_INVALID', message: 'Frame too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: 'REMOTE_INVALID', message: 'Frame is not JSON' };
  }
  const v = (raw as { v?: unknown } | null)?.v;
  if (typeof v === 'number' && v < REMOTE_MIN_PROTOCOL_VERSION) return { ok: false, code: 'NODE_UPDATE_REQUIRED', message: `Protocol ${v} is older than ${REMOTE_MIN_PROTOCOL_VERSION}` };
  const parsed = nodeFrameSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'REMOTE_INVALID', message: parsed.error.issues[0]?.message ?? 'Invalid frame' };
  return { ok: true, frame: parsed.data };
}
