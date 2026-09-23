import os from 'node:os';
import {
  cloudFramePayloadSchemas,
  cloudFrameSchema,
  defaultArtifactSensitivity,
  frame,
  nodeIdSchema,
  remotePairInputSchema,
  remotePermissionsSchema,
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  ACTIVE_TASK_STATUSES,
  type CloudFrame,
  type NodeCapabilities,
  type NodeFrame,
  type NodeRepository,
  type RemoteLinkState,
  type RemoteNodeStatus,
  type ServerMessage,
} from '@acc/shared';
import { registerSecretValues } from '@acc/security';
import type { z } from 'zod';
import type { Bus } from '../bus.js';
import type { OrchestratorConfig } from '../config.js';
import type { Db } from '../db/database.js';
import type { TaskViews } from '../engine/views.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { AgentRegistry } from '../services/agents.js';
import type { RepositoryService } from '../services/repositories.js';
import type { SettingsService } from '../services/settings.js';
import type { Store } from '../store/store.js';
import type { CredentialBroker } from '../tools/credentials.js';
import type { ToolService } from '../tools/service.js';
import type { UsageService } from '../usage/service.js';
import type { TerminalService } from '../tools/terminals.js';
import { RemoteConnection } from './connection.js';
import { RemoteDispatcher, type CommandReport, type LocalHttp } from './dispatcher.js';
import { EgressSanitizer, MIRRORED_MESSAGE_TYPES } from './egress.js';
import { repositoryFingerprint } from './fingerprint.js';
import { generateNodeKeyPair } from './identity.js';
import { normalizeRelayUrl, RelayClient, RelayError } from './relay-client.js';
import { RemoteStore } from './store.js';
import { TerminalGrants, TERMINAL_GRANT } from './terminal-grants.js';
import { UploadQueue } from './uploads.js';

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_PAIRED' | 'ALREADY_PAIRED' | 'INVALID' | 'CLOUD_UNAVAILABLE' | 'REFUSED' | 'LOCAL_ONLY',
  ) {
    super(message);
  }
}

export interface RemoteNodeDeps {
  db: Db;
  bus: Bus;
  config: OrchestratorConfig;
  store: Store;
  views: TaskViews;
  settings: SettingsService;
  agents: AgentRegistry;
  repositories: RepositoryService;
  tools: ToolService;
  credentials: CredentialBroker;
  usage: UsageService;
  terminals: TerminalService;
  artifacts: ArtifactService;
  /** Tests shorten timers. */
  timings?: Partial<typeof DEFAULT_TIMINGS>;
}

export const DEFAULT_TIMINGS = {
  flushMs: 250,
  detailDebounceMs: 2_000,
  heartbeatMs: 30_000,
  /** Refresh the repository snapshot (fingerprints) at most this often. */
  snapshotMs: 5 * 60_000,
  terminalIdleMs: TERMINAL_GRANT.idleMs,
  terminalMaxMs: TERMINAL_GRANT.maxMs,
  uploadMs: 20_000,
};

/** Seal binding for the node private key: purpose + node id. */
const identityBinding = (nodeId: string) => `remote-node-identity:${nodeId}`;
/** Batches the node keeps in flight before waiting for acknowledgements. */
const MAX_INFLIGHT_BATCHES = 4;
const RESYNC_TASKS = 500;
const RESYNC_DETAILS = 100;
const USAGE_BACKFILL_DAYS = 30;

function entityKey(message: ServerMessage): string {
  switch (message.type) {
    case 'task':
      return `task:${message.task.id}`;
    case 'task.deleted':
      return `task:${message.taskId}`;
    case 'event':
      return `event:${message.event.id}`;
    case 'approval':
      return `approval:${message.approval.id}`;
    case 'artifact':
      return `artifact:${message.artifact.id}`;
    case 'repository':
      return `repository:${message.repository.id}`;
    case 'repository.deleted':
      return `repository:${message.repositoryId}`;
    case 'agents':
      return 'agents';
    case 'usage':
      return `usage:${message.event.id}`;
    default:
      return `${message.type}:${Date.now()}`;
  }
}

/**
 * This machine as a remote execution node of the cloud control plane
 * (docs/systems/remote-node.md). It dials out to the relay, mirrors a
 * sanitized subset of state through a durable outbox, answers typed reads and
 * executes typed commands through the local API. It never opens a listening
 * port, and local operation never waits for it.
 */
export class RemoteNodeService {
  readonly store: RemoteStore;
  private readonly egress: EgressSanitizer;
  private readonly dispatcher: RemoteDispatcher;
  private readonly grants: TerminalGrants;
  private readonly uploads: UploadQueue;
  private uploadTimer: NodeJS.Timeout | null = null;
  private readonly timings: typeof DEFAULT_TIMINGS;
  private http: LocalHttp | null = null;
  private connection: RemoteConnection | null = null;
  private state: RemoteLinkState = 'unpaired';
  private lastError: string | null = null;
  private welcomed = false;
  private sentSeq = 0;
  private inflightBatches = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly detailTimers = new Map<string, NodeJS.Timeout>();
  private readonly logSubscriptions = new Set<string>();
  private readonly terminalSubscriptions = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;
  private lastSnapshotAt = 0;
  private snapshotRepoIds = '';
  private snapshotTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly d: RemoteNodeDeps) {
    this.store = new RemoteStore(d.db);
    this.timings = { ...DEFAULT_TIMINGS, ...d.timings };
    this.egress = new EgressSanitizer({ repositories: this.repositoryRoots(), dataDir: d.config.dataDir });
    this.grants = new TerminalGrants(d.terminals, () => d.settings.get().autoApproveUpToLevel, { idleMs: this.timings.terminalIdleMs, maxMs: this.timings.terminalMaxMs }, Date.now, (terminalId, text) =>
      this.send({ type: 'event.live', payload: { message: { type: 'terminal.output', terminalId, data: text, cursor: 0, notice: true } } }),
    );
    this.dispatcher = new RemoteDispatcher({
      store: this.store,
      http: () => this.http,
      token: d.config.token,
      config: () => this.store.config(),
      egress: this.egress,
      guard: () => ({
        settings: d.settings.get(),
        repository: (id) => d.store.getRepository(id) ?? null,
        workflow: (id) => d.store.getWorkflow(id),
      }),
      taskVersion: (taskId) => d.store.getTask(taskId)?.version ?? null,
      approvalView: (approvalId) => {
        const rec = d.store.getApproval(approvalId);
        return rec ? (this.egress.response(d.views.approval(rec)) as ReturnType<TaskViews['approval']>) : null;
      },
      artifactPolicy: (artifactId) => {
        const rec = d.store.getArtifact(artifactId);
        if (!rec) return null;
        return this.store.syncObject(`artifact:${artifactId}`)?.sensitivity ?? defaultArtifactSensitivity(rec.type);
      },
      onTerminalOpened: (terminalId) => this.grants.grant(terminalId),
      terminalGranted: (terminalId) => this.grants.has(terminalId),
    });
    this.uploads = new UploadQueue({
      remote: this.store,
      store: d.store,
      artifacts: d.artifacts,
      egress: this.egress,
      online: () => this.welcomed,
      target: {
        session: async () => {
          const config = this.store.config();
          if (!config) throw new RemoteError('Not paired', 'NOT_PAIRED');
          const pkcs8 = await this.d.credentials.openValue(config.sealedKey, identityBinding(config.nodeId));
          return (await new RelayClient(config.relayUrl).session(config.nodeId, pkcs8)).session;
        },
        upload: (path, session, body, sha, contentType, headers) => new RelayClient(this.store.config()!.relayUrl).upload(path, session, body, sha, contentType, headers),
        manifest: (payload) => void this.send({ type: 'artifact.manifest', payload }),
      },
    });
    // The local API token must never leave this machine, whatever carries it.
    registerSecretValues([d.config.token]);
  }

  /** In-process access to the local API; set once the HTTP server is built. */
  attachHttp(http: LocalHttp): void {
    this.http = http;
  }

  private repositoryRoots(): Array<{ path: string; name: string }> {
    return this.d.store.listRepositories().map((r) => ({ path: r.path, name: r.name }));
  }

  // ----- lifecycle ------------------------------------------------------------

  /** Called after restart recovery. Never throws and never waits for the network. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const interrupted = this.store.interruptRunning();
    if (interrupted) this.lastError = `${interrupted} remote command(s) were interrupted by the restart and will not be re-run.`;
    this.unsubscribe = this.d.bus.subscribe(this.onBusMessage);
    this.connectIfConfigured();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disconnect();
    await this.uploads.stop();
    await this.grants.revokeAll();
    await Promise.allSettled([...this.queues.values()]);
  }

  private connectIfConfigured(): void {
    const config = this.store.config();
    if (!config) return this.setState('unpaired');
    if (!config.enabled) return this.setState('disabled');
    if (this.connection) return;
    const wsUrl = `${config.relayUrl.replace(/^http/, 'ws')}/node/v1/connect`;
    const relay = new RelayClient(config.relayUrl);
    this.setState('connecting');
    this.connection = new RemoteConnection(wsUrl, {
      session: async () => {
        const current = this.store.config();
        if (!current) throw new RemoteError('Not paired', 'NOT_PAIRED');
        const pkcs8 = await this.d.credentials.openValue(current.sealedKey, identityBinding(current.nodeId));
        const { session } = await relay.session(current.nodeId, pkcs8);
        return session;
      },
      onOpen: () => this.onOpen(),
      onText: (text) => this.onText(text),
      onClose: ({ code, reason }) => this.onClose(code, reason),
      onError: (error) => this.onConnectError(error),
    });
    this.connection.start();
  }

  private disconnect(): void {
    this.connection?.stop();
    this.connection = null;
    this.welcomed = false;
    this.inflightBatches = 0;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    this.uploadTimer = null;
    for (const t of this.detailTimers.values()) clearTimeout(t);
    this.detailTimers.clear();
    this.logSubscriptions.clear();
    this.terminalSubscriptions.clear();
  }

  private setState(state: RemoteLinkState, error?: string | null): void {
    const changed = state !== this.state || (error !== undefined && error !== this.lastError);
    this.state = state;
    if (error !== undefined) {
      this.lastError = error;
      this.store.setError(error);
    }
    if (changed) this.d.bus.publish({ type: 'remote.status', status: this.status() });
  }

  status(): RemoteNodeStatus {
    const config = this.store.config();
    const sync = this.store.syncState();
    return {
      paired: Boolean(config),
      state: this.state,
      nodeId: config?.nodeId ?? null,
      label: config?.label ?? null,
      relayUrl: config?.relayUrl ?? null,
      enabled: config?.enabled ?? false,
      remoteTerminals: config?.remoteTerminals ?? false,
      remoteTools: config?.remoteTools ?? false,
      keyVersion: config?.keyVersion ?? null,
      pairedAt: config?.pairedAt ?? null,
      lastConnectedAt: sync.lastConnectedAt,
      lastError: this.lastError ?? sync.lastError,
      outboxDepth: config ? this.store.outboxDepth() : 0,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
    };
  }

  // ----- pairing, rotation, permissions (local routes only) ----------------------

  async pair(raw: z.input<typeof remotePairInputSchema>): Promise<RemoteNodeStatus> {
    const input = remotePairInputSchema.parse(raw);
    if (this.store.config()) throw new RemoteError('This machine is already paired. Unpair it first.', 'ALREADY_PAIRED');
    let relayUrl: string;
    try {
      relayUrl = normalizeRelayUrl(input.relayUrl);
    } catch (error) {
      throw new RemoteError((error as Error).message, 'INVALID');
    }
    const keys = await generateNodeKeyPair();
    let paired: { nodeId: string; label: string };
    try {
      paired = await new RelayClient(relayUrl).pair(input.code, keys.publicKey, this.nodeInfo(input.label));
    } catch (error) {
      throw this.relayFailure(error);
    }
    if (!nodeIdSchema.safeParse(paired.nodeId).success) throw new RemoteError('The relay returned an invalid node id', 'REFUSED');
    const sealedKey = await this.d.credentials.sealValue(keys.privatePkcs8, identityBinding(paired.nodeId));
    this.store.savePairing({ relayUrl, nodeId: paired.nodeId, label: paired.label, publicKey: keys.publicKey, sealedKey });
    this.lastError = null;
    this.connectIfConfigured();
    return this.status();
  }

  async unpair(): Promise<RemoteNodeStatus> {
    this.disconnect();
    await this.grants.revokeAll();
    this.store.clearPairing();
    this.setState('unpaired', null);
    return this.status();
  }

  async updatePermissions(raw: z.input<typeof remotePermissionsSchema>): Promise<RemoteNodeStatus> {
    const patch = remotePermissionsSchema.parse(raw);
    if (!this.store.config()) throw new RemoteError('This machine is not paired', 'NOT_PAIRED');
    this.store.updatePermissions(patch);
    if (patch.remoteTerminals === false || patch.enabled === false) await this.grants.revokeAll();
    if (patch.enabled === false) {
      // Nothing is queued while remote access is off, so the cloud copy goes stale: send everything when it is back on.
      this.store.setResyncRequired(true);
      this.disconnect();
      this.setState('disabled');
    } else if (patch.enabled === true && !this.connection) {
      this.connectIfConfigured();
    } else {
      // Capabilities changed: tell the cloud now.
      if (this.welcomed) this.sendCapabilities();
      this.d.bus.publish({ type: 'remote.status', status: this.status() });
    }
    return this.status();
  }

  /** Replace this node's key pair; the node id and its history stay. */
  async rotate(): Promise<RemoteNodeStatus> {
    const config = this.store.config();
    if (!config) throw new RemoteError('This machine is not paired', 'NOT_PAIRED');
    const relay = new RelayClient(config.relayUrl);
    const keys = await generateNodeKeyPair();
    try {
      const currentKey = await this.d.credentials.openValue(config.sealedKey, identityBinding(config.nodeId));
      const { session } = await relay.session(config.nodeId, currentKey);
      await relay.rotate(config.nodeId, session, keys.publicKey, keys.privatePkcs8);
    } catch (error) {
      throw this.relayFailure(error);
    }
    this.store.rotateKey(keys.publicKey, await this.d.credentials.sealValue(keys.privatePkcs8, identityBinding(config.nodeId)));
    // Reconnect with a session from the new key.
    this.disconnect();
    this.connectIfConfigured();
    return this.status();
  }

  reconnectNow(): RemoteNodeStatus {
    if (this.connection) this.connection.reconnectNow();
    else this.connectIfConfigured();
    return this.status();
  }

  private relayFailure(error: unknown): RemoteError {
    if (error instanceof RelayError) return new RemoteError(error.message, error.status === 0 ? 'CLOUD_UNAVAILABLE' : 'REFUSED');
    return new RemoteError((error as Error).message, 'REFUSED');
  }

  private nodeInfo(label: string) {
    return { label, os: `${os.type()} ${os.release()}`.slice(0, 80), appVersion: this.d.config.version.slice(0, 40), protocolVersion: REMOTE_PROTOCOL_VERSION };
  }

  // ----- connection events ----------------------------------------------------------

  private onConnectError(error: Error): boolean {
    const status = (error as { status?: number }).status ?? (error instanceof RelayError ? error.status : 0);
    const code = error instanceof RelayError ? error.code : '';
    if (code === 'NODE_REVOKED' || code === 'NODE_NOT_FOUND' || status === 403) {
      this.setState('revoked', 'The cloud revoked this node. Pair it again to restore remote control.');
      void this.grants.revokeAll();
      this.connection = null;
      return false;
    }
    if (code === 'NODE_UPDATE_REQUIRED' || status === 426) {
      this.setState('update-required', error.message);
      this.connection = null;
      return false;
    }
    this.setState('offline', `Cloud not reachable: ${error.message}`.slice(0, 500));
    return true;
  }

  private onOpen(): void {
    const config = this.store.config();
    if (!config) return;
    this.send({ type: 'node.hello', payload: { ...this.nodeInfo(config.label), lastIssuedSeq: this.store.lastIssuedSeq() } });
  }

  private onClose(code: number, reason: string): void {
    // One line in the orchestrator log per drop: the close code says who ended it and why.
    console.warn(JSON.stringify({ level: 40, time: Date.now(), msg: 'remote link closed', code, reason: reason.slice(0, 200) }));
    this.welcomed = false;
    this.inflightBatches = 0;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.logSubscriptions.clear();
    this.terminalSubscriptions.clear();
    if (code === 4003) {
      this.setState('revoked', 'The cloud revoked this node. Pair it again to restore remote control.');
      void this.grants.revokeAll();
      this.connection?.stop();
      this.connection = null;
      return;
    }
    if (code === 4026) {
      this.setState('update-required', reason || 'This node must be updated to talk to the cloud.');
      this.connection?.stop();
      this.connection = null;
      return;
    }
    this.setState('offline', reason ? `Disconnected: ${reason}` : null);
  }

  private send(message: Pick<NodeFrame, 'type' | 'payload'>): boolean {
    const text = JSON.stringify(frame(message as { type: string; payload: unknown }));
    if (text.length > REMOTE_LIMITS.frameBytes) return false;
    return this.connection?.send(text) ?? false;
  }

  private onText(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = cloudFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const payloadSchema = cloudFramePayloadSchemas[parsed.data.type as CloudFrame['type']];
    const payload = payloadSchema?.safeParse(parsed.data.payload);
    if (!payload?.success) return; // unknown or malformed: ignored, never a crash
    const message = { ...parsed.data, payload: payload.data } as unknown as CloudFrame;
    try {
      this.handleCloudFrame(message);
    } catch (error) {
      console.warn('[remote] could not handle a cloud message', message.type, (error as Error).message);
    }
  }

  private handleCloudFrame(message: CloudFrame): void {
    switch (message.type) {
      case 'session.welcome':
        return void this.onWelcome(message.payload).catch((error: unknown) => console.warn('[remote] welcome failed', (error as Error).message));
      case 'sync.ack':
        this.store.acknowledge(Math.min(message.payload.upToSeq, this.store.lastIssuedSeq()));
        this.inflightBatches = Math.max(0, this.inflightBatches - 1);
        this.d.bus.publish({ type: 'remote.status', status: this.status() });
        return this.scheduleFlush(0);
      case 'command.available':
        return void this.enqueueCommand(message.payload.command);
      case 'command.ack':
        return this.store.markReported(message.payload.commandId);
      case 'rpc.request':
        return void this.answerRpc(message.payload).catch((error: unknown) => console.warn('[remote] read failed', (error as Error).message));
      case 'subscriptions':
        this.logSubscriptions.clear();
        for (const id of message.payload.logs.slice(0, 100)) this.logSubscriptions.add(id);
        this.terminalSubscriptions.clear();
        for (const id of message.payload.terminals.slice(0, 20)) this.terminalSubscriptions.add(id);
        return;
      case 'node.rotate':
        return void this.rotate().catch((error: unknown) => this.setState(this.state, `Key rotation failed: ${(error as Error).message}`));
      case 'node.revoked':
        this.setState('revoked', 'The cloud revoked this node. Pair it again to restore remote control.');
      void this.grants.revokeAll();
        this.connection?.stop();
        this.connection = null;
        return;
      case 'terminal.input':
        if (this.store.config()?.remoteTerminals) this.grants.input(message.payload.terminalId, message.payload.data);
        return;
      case 'terminal.resize':
        if (this.store.config()?.remoteTerminals) this.grants.resize(message.payload.terminalId, message.payload.cols, message.payload.rows);
        return;
      case 'sync.complete':
        return;
    }
  }

  private async onWelcome(payload: Extract<CloudFrame, { type: 'session.welcome' }>['payload']): Promise<void> {
    if (payload.minProtocolVersion > REMOTE_PROTOCOL_VERSION) {
      this.setState('update-required', `The cloud needs protocol ${payload.minProtocolVersion}; this node speaks ${REMOTE_PROTOCOL_VERSION}. Update the Control Center.`);
      this.connection?.stop();
      this.connection = null;
      return;
    }
    const local = this.store.syncState();
    // The cloud lost events this node already dropped (restored from backup): send everything again.
    if (payload.ackedSeq < local.ackedSeq) this.store.setResyncRequired(true);
    this.store.ensureSequenceAtLeast(payload.ackedSeq);
    this.store.acknowledge(Math.min(payload.ackedSeq, this.store.lastIssuedSeq()));
    this.sentSeq = payload.ackedSeq;
    this.inflightBatches = 0;
    this.welcomed = true;
    this.store.setConnected(new Date().toISOString());
    this.setState('connected', null);
    this.sendCapabilities();
    await this.sendSnapshot(true);
    // The link may have closed (or the service stopped) while the snapshot was being built.
    if (!this.welcomed) return;
    if (this.store.syncState().resyncRequired) await this.enqueueFullResync();
    if (!this.welcomed) return;
    this.scheduleFlush(0);
    // Results the cloud never acknowledged (the connection dropped after the node ran them).
    for (const receipt of this.store.unreported()) {
      const report = this.dispatcher.replay(receipt.commandId);
      if (report) this.report(report);
    }
    this.send({ type: 'sync.request', payload: { want: 'pendingCommands' } });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.timings.heartbeatMs);
    this.heartbeatTimer.unref?.();
    // Artifacts and finished logs go to R2 in the background; a failure never touches the task.
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    this.uploadTimer = setInterval(() => void this.uploads.run(), this.timings.uploadMs);
    this.uploadTimer.unref?.();
    void this.uploads.run();
  }

  private heartbeat(): void {
    if (!this.welcomed) return;
    this.send({ type: 'node.heartbeat', payload: { activeTasks: this.activeTaskCount(), outboxDepth: this.store.outboxDepth() } });
    if (Date.now() - this.lastSnapshotAt > this.timings.snapshotMs) void this.sendSnapshot(false);
  }

  private activeTaskCount(): number {
    return this.d.store.listTasks({ statuses: [...ACTIVE_TASK_STATUSES], limit: 200 }).length;
  }

  private capabilities(): NodeCapabilities {
    const config = this.store.config();
    return {
      agents: this.d.agents.list().map((a) => ({ id: a.id, name: a.name.slice(0, 100), state: a.health.state, billing: a.health.billing })),
      tools: this.d.tools
        .tools()
        .slice(0, 200)
        .map((t) => ({ id: t.id, state: String(t.state).slice(0, 40) })),
      features: { remoteTerminals: config?.remoteTerminals ?? false, remoteTools: config?.remoteTools ?? false, simulatedAgents: this.d.config.simulatedAgents },
    };
  }

  private sendCapabilities(): void {
    this.send({ type: 'node.capabilities', payload: this.capabilities() });
  }

  /** A repository was added or removed: the cloud needs its fingerprint for routing and leases. */
  private scheduleSnapshotIfRepositoriesChanged(): void {
    if (!this.welcomed || this.snapshotTimer) return;
    const ids = this.d.store.listRepositories().map((r) => r.id).sort().join(',');
    if (ids === this.snapshotRepoIds) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.sendSnapshot(true);
    }, 1_000);
    this.snapshotTimer.unref?.();
  }

  private async sendSnapshot(force: boolean): Promise<void> {
    const config = this.store.config();
    if (!config || (!force && Date.now() - this.lastSnapshotAt < this.timings.snapshotMs)) return;
    this.lastSnapshotAt = Date.now();
    const records = this.d.store.listRepositories().slice(0, 1000);
    this.snapshotRepoIds = records.map((r) => r.id).sort().join(',');
    const repositories: NodeRepository[] = [];
    for (const rec of records) {
      const { fingerprint, remoteHost } = await repositoryFingerprint(rec.path, config.nodeId, rec.id);
      repositories.push({ localId: rec.id, name: rec.name.slice(0, 200), fingerprint, remoteHost, defaultBranch: null });
    }
    if (!this.welcomed) return;
    this.send({ type: 'node.snapshot', payload: { repositories, activeTasks: this.activeTaskCount() } });
  }

  // ----- outbox -------------------------------------------------------------------------

  private onBusMessage = (message: ServerMessage): void => {
    if (message.type === 'remote.status') return;
    const config = this.store.config();
    if (!config || !config.enabled) return;
    if (message.type === 'artifact') this.uploads.trackArtifact(message.artifact);
    if (message.type === 'execution') this.uploads.trackExecution(message.execution);
    if (message.type === 'repository' || message.type === 'repository.deleted') {
      this.egress.setRoots({ repositories: this.repositoryRoots(), dataDir: this.d.config.dataDir });
      this.scheduleSnapshotIfRepositoriesChanged();
    }
    const clean = this.egress.message(message, (terminalId) => this.terminalSubscriptions.has(terminalId) && config.remoteTerminals && this.grants.has(terminalId));
    if (!clean) return;
    if (MIRRORED_MESSAGE_TYPES.has(message.type)) {
      this.store.enqueue(entityKey(message), 'message', clean);
      if (message.type === 'task') this.scheduleDetail(message.task.id);
      this.scheduleFlush();
      return;
    }
    if (!this.welcomed) return;
    if (clean.type === 'logs' && !this.logSubscriptions.has(clean.executionId)) return;
    if (this.connection && this.connection.bufferedAmount() > 4 * 1024 * 1024) return; // a slow link drops live noise, never mirrored state
    this.send({ type: 'event.live', payload: { message: clean } });
  };

  private scheduleDetail(taskId: string): void {
    if (this.detailTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.detailTimers.delete(taskId);
      this.enqueueDetail(taskId);
      this.scheduleFlush();
    }, this.timings.detailDebounceMs);
    timer.unref?.();
    this.detailTimers.set(taskId, timer);
  }

  /** The latest redacted TaskDetail, for offline reading in the cloud. */
  private enqueueDetail(taskId: string): void {
    const rec = this.d.store.getTask(taskId);
    if (!rec) return;
    let detail = this.egress.message({ type: 'task', task: this.d.views.detail(rec) }) as { task: Record<string, unknown> } | null;
    if (!detail) return;
    let text = JSON.stringify(detail.task);
    if (text.length > REMOTE_LIMITS.snapshotBytes) {
      const stages = (detail.task.stages as unknown[] | undefined) ?? [];
      detail = { task: { ...detail.task, stages: stages.slice(-100), snapshotTruncated: true } };
      text = JSON.stringify(detail.task);
      if (text.length > REMOTE_LIMITS.snapshotBytes) return;
    }
    this.store.enqueue(`detail:${taskId}`, 'taskDetail', { taskId, detail: detail.task });
  }

  private async enqueueFullResync(): Promise<void> {
    const tasks = this.d.store.listTasks({ limit: RESYNC_TASKS });
    for (const rec of tasks) {
      const clean = this.egress.message({ type: 'task', task: this.d.views.summary(rec) });
      if (clean) this.store.enqueue(`task:${rec.id}`, 'message', clean);
    }
    for (const rec of tasks.slice(0, RESYNC_DETAILS)) this.enqueueDetail(rec.id);
    for (const rec of this.d.store.listApprovals({ status: 'pending', limit: 200 })) {
      const clean = this.egress.message({ type: 'approval', approval: this.d.views.approval(rec) });
      if (clean) this.store.enqueue(`approval:${rec.id}`, 'message', clean);
    }
    const agents = this.egress.message({ type: 'agents', agents: this.d.agents.list() });
    if (agents) this.store.enqueue('agents', 'message', agents);
    // Repositories too, so the cloud can list them (and start queued tasks) while the node is away.
    const repositories = await this.d.repositories.list();
    if (!this.welcomed) return; // stopped meanwhile; the flag stays set for the next welcome
    for (const repository of repositories) {
      const clean = this.egress.message({ type: 'repository', repository });
      if (clean) this.store.enqueue(`repository:${repository.id}`, 'message', clean);
    }
    const to = new Date();
    const from = new Date(to.getTime() - USAGE_BACKFILL_DAYS * 86_400_000);
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = this.d.usage.queries.events({ from: from.toISOString(), to: to.toISOString() }, cursor, 200);
      for (const event of result.items) {
        const clean = this.egress.message({ type: 'usage', event });
        if (clean) this.store.enqueue(`usage:${event.id}`, 'message', clean);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    this.store.setResyncRequired(false);
  }

  private scheduleFlush(delay = this.timings.flushMs): void {
    if (!this.welcomed || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    while (this.welcomed && this.inflightBatches < MAX_INFLIGHT_BATCHES) {
      const rows = this.store.pending(this.sentSeq, REMOTE_LIMITS.batchEvents);
      if (!rows.length) return;
      const events: Array<{ seq: number; kind: 'message' | 'taskDetail'; payload: unknown }> = [];
      let bytes = 0;
      for (const row of rows) {
        const size = JSON.stringify(row.payload).length + 64;
        if (events.length && bytes + size > REMOTE_LIMITS.batchBytes) break;
        events.push({ seq: row.seq, kind: row.kind, payload: row.payload });
        bytes += size;
      }
      if (!this.send({ type: 'event.batch', payload: { events } })) return;
      this.sentSeq = events.at(-1)!.seq;
      this.inflightBatches++;
    }
  }

  // ----- commands and reads -------------------------------------------------------------

  /** Commands for the same target run in order; different targets run side by side. */
  private enqueueCommand(command: unknown): Promise<void> {
    const c = command as { params?: Record<string, string>; op?: string };
    const key = c.params?.id ?? c.op ?? 'default';
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const report = await this.dispatcher.executeCommand(command, {
          admitted: (commandId) => this.send({ type: 'command.claim', payload: { commandId } }),
        });
        if (report) this.report(report);
      });
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  private report(report: CommandReport): void {
    if (report.kind === 'result') this.send({ type: 'command.result', payload: { commandId: report.commandId, outcome: report.outcome, replayed: report.replayed } });
    else this.send({ type: 'command.failed', payload: { commandId: report.commandId, code: String(report.code).slice(0, 60), message: report.message.slice(0, 2000), status: report.status } });
  }

  private async answerRpc(request: Extract<CloudFrame, { type: 'rpc.request' }>['payload']): Promise<void> {
    if (Date.parse(request.deadline) < Date.now()) return;
    const reply = await this.dispatcher.executeRpc(request);
    const size = REMOTE_LIMITS.rpcChunkBytes;
    const total = Math.max(1, Math.ceil(reply.text.length / size));
    for (let index = 0; index < total; index++) {
      this.send({
        type: 'rpc.response',
        payload: { requestId: request.requestId, httpStatus: reply.httpStatus, contentType: reply.contentType.slice(0, 200), chunk: reply.text.slice(index * size, (index + 1) * size), index, total, encoding: reply.encoding },
      });
    }
  }

}
