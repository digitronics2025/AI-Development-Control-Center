import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AgentInfo, Role, ServerMessage, TaskDetail, TaskSummary } from '@acc/shared';
import { ApiClient, EventStream, defaultDataDir, discover, type Discovery } from './connection';
import { deriveStatus } from './status';
import { handleHostMessage, renderHtml, webviewOptions } from './webview';

/**
 * Thin client (PLAN §25): no workflow logic lives here. Everything is read
 * from and sent to the same orchestrator the standalone dashboard uses.
 */
class ControlCenter implements vscode.Disposable {
  private discovery: Discovery | null = null;
  private api: ApiClient | null = null;
  private stream: EventStream | null = null;
  private connected = false;
  private readonly tasks = new Map<string, TaskSummary>();
  private readonly roles = new Map<string, Role | null>();
  private agents: AgentInfo[] = [];
  private panel: vscode.WebviewPanel | null = null;
  private view: vscode.WebviewView | null = null;
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel('AI Control Center');
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly notified = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem.command = 'acc.openCurrentTask';
    this.statusItem.name = 'AI Control Center';
    this.statusItem.show();
    this.render();
  }

  private config() {
    return vscode.workspace.getConfiguration('acc');
  }

  private dataDir(): string {
    return this.config().get<string>('dataDirectory')?.trim() || defaultDataDir();
  }

  async connect(): Promise<boolean> {
    this.stream?.stop();
    this.discovery = discover(this.dataDir());
    this.api = this.discovery ? new ApiClient(this.discovery) : null;
    if (!this.api || !(await this.api.healthy())) {
      this.connected = false;
      this.render();
      this.scheduleRediscovery();
      return false;
    }
    // Connected: a rediscovery still pending from an earlier attempt would reconnect for nothing.
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stream = new EventStream(this.discovery!, (m) => this.onMessage(m), (connected) => {
      this.connected = connected;
      if (connected) void this.refresh();
      this.render();
    });
    this.stream.start();
    return true;
  }

  /** The orchestrator may start after VS Code; look for it periodically. */
  private scheduleRediscovery(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), 10_000);
  }

  private async refresh(): Promise<void> {
    if (!this.api) return;
    try {
      const [overview, agents] = await Promise.all([
        this.api.request<{ active: TaskSummary[]; attention: TaskSummary[]; recent: TaskSummary[] }>('GET', '/api/overview'),
        this.api.request<AgentInfo[]>('GET', '/api/agents'),
      ]);
      this.agents = agents;
      this.tasks.clear();
      for (const task of [...overview.recent, ...overview.attention, ...overview.active]) this.tasks.set(task.id, task);
      await Promise.all([...this.tasks.values()].filter((t) => t.status === 'RUNNING').map((t) => this.loadRole(t.id)));
      for (const task of this.tasks.values()) this.notified.set(task.id, task.status);
      this.render();
    } catch (error) {
      this.output.appendLine(`Refresh failed: ${(error as Error).message}`);
    }
  }

  private async loadRole(taskId: string): Promise<void> {
    if (!this.api) return;
    try {
      const detail = await this.api.request<TaskDetail>('GET', `/api/tasks/${taskId}`);
      this.roles.set(taskId, detail.workflow.stages.find((s) => s.key === detail.currentStageKey)?.role ?? null);
    } catch {
      this.roles.set(taskId, null);
    }
  }

  private onMessage(message: ServerMessage): void {
    if (message.type === 'task') {
      const previous = this.tasks.get(message.task.id);
      this.tasks.set(message.task.id, message.task);
      if (previous?.currentStageKey !== message.task.currentStageKey) void this.loadRole(message.task.id).then(() => this.render());
      this.maybeNotify(message.task);
      this.render();
    } else if (message.type === 'agents') {
      this.agents = message.agents;
    }
  }

  private maybeNotify(task: TaskSummary): void {
    const last = this.notified.get(task.id);
    this.notified.set(task.id, task.status);
    if (last === task.status || !this.config().get<boolean>('notifications', true)) return;
    const open = (label: string, route: string) =>
      (choice: string | undefined) => {
        if (choice === label) this.openPanel(route);
      };
    if (task.status === 'WAITING_FOR_USER' && task.blocker?.kind === 'approval') {
      void vscode.window.showWarningMessage(`${task.id} needs your approval: ${task.blocker.message}`, 'Review Approval').then(open('Review Approval', `/approvals?task=${task.id}`));
    } else if (task.status === 'FAILED' || task.status === 'WAITING_FOR_USAGE_RESET' || (task.status === 'WAITING_FOR_USER' && task.blocker)) {
      void vscode.window.showErrorMessage(`${task.id} ${task.title}: ${task.blocker?.message ?? task.status}`, 'Open Task').then(open('Open Task', `/tasks/${task.id}`));
    } else if (task.status === 'COMPLETED') {
      void vscode.window
        .showInformationMessage(`${task.id} completed${task.finalStatus === 'READY' ? '' : ' — needs your attention'}: ${task.title}`, 'Open Report')
        .then(open('Open Report', `/tasks/${task.id}`));
    }
  }

  private render(): void {
    if (!this.api || !this.connected) {
      this.statusItem.text = '$(debug-disconnect) AI: Offline';
      this.statusItem.tooltip = 'The Control Center orchestrator is not running or not reachable. Click to start or reconnect.';
      this.statusItem.command = 'acc.startOrchestrator';
      this.statusItem.backgroundColor = undefined;
      return;
    }
    const agentName = (id: string) => this.agents.find((a) => a.id === id)?.name ?? id;
    const status = deriveStatus([...this.tasks.values()], agentName, (t) => this.roles.get(t.id) ?? null);
    const icon = { idle: '$(circle-large-outline)', active: '$(sync~spin)', attention: '$(bell-dot)', error: '$(error)', done: '$(pass)' }[status.severity];
    this.statusItem.text = `${icon} ${status.text}`;
    this.statusItem.tooltip = status.tooltip;
    this.statusItem.command = 'acc.openCurrentTask';
    this.statusItem.backgroundColor =
      status.severity === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : status.severity === 'attention' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  currentTaskId(): string | null {
    const agentName = (id: string) => this.agents.find((a) => a.id === id)?.name ?? id;
    return deriveStatus([...this.tasks.values()], agentName, (t) => this.roles.get(t.id) ?? null).taskId;
  }

  async requireApi(): Promise<ApiClient | null> {
    if (this.api && this.connected) return this.api;
    if (await this.connect()) return this.api;
    const choice = await vscode.window.showWarningMessage('The Control Center orchestrator is not running.', 'Start Orchestrator');
    if (choice === 'Start Orchestrator') await this.startOrchestrator();
    return null;
  }

  openPanel(route = '/'): void {
    if (!this.discovery) {
      void vscode.window.showWarningMessage('Start the Control Center orchestrator first.', 'Start Orchestrator').then((c) => c && void this.startOrchestrator());
      return;
    }
    if (this.panel) {
      // Navigate inside the running app instead of reloading it.
      void this.panel.webview.postMessage({ type: 'navigate', path: route });
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('acc.controlCenter', 'AI Control Center', vscode.ViewColumn.Active, {
      ...webviewOptions(this.context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'activity.svg');
    panel.webview.html = renderHtml(panel.webview, this.context.extensionUri, this.discovery, route);
    panel.webview.onDidReceiveMessage((m) => this.api && void handleHostMessage(panel.webview, this.api, m).catch((e: Error) => vscode.window.showErrorMessage(e.message)));
    panel.onDidDispose(() => (this.panel = null));
    this.panel = panel;
  }

  resolveView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.context.extensionUri);
    const load = () => {
      view.webview.html = this.discovery
        ? renderHtml(view.webview, this.context.extensionUri, this.discovery, '/')
        : `<!doctype html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px"><p>The Control Center orchestrator is not running.</p><p>Run <b>AI Control Center: Start Orchestrator</b> from the Command Palette.</p></body>`;
    };
    load();
    view.webview.onDidReceiveMessage((m) => this.api && void handleHostMessage(view.webview, this.api, m).catch((e: Error) => vscode.window.showErrorMessage(e.message)));
    view.onDidChangeVisibility(() => view.visible && !this.discovery && void this.connect().then(load));
  }

  async startOrchestrator(): Promise<void> {
    if (await this.connect()) {
      void vscode.window.showInformationMessage('The Control Center orchestrator is already running.');
      return;
    }
    const configured = this.config().get<string>('orchestratorPath')?.trim();
    const candidate = configured || path.resolve(this.context.extensionPath, '..', 'orchestrator', 'dist', 'main.js');
    if (!existsSync(candidate)) {
      void vscode.window.showErrorMessage('Orchestrator not found. Build it with `pnpm build` in the repository, or set "acc.orchestratorPath".');
      return;
    }
    // Detached so it keeps running when this window closes; it binds to localhost only.
    const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [candidate], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...(this.config().get<string>('dataDirectory')?.trim() ? { ACC_DATA_DIR: this.dataDir() } : {}) },
    });
    child.on('error', (error) => void vscode.window.showErrorMessage(`Could not start the orchestrator: ${error.message}`));
    child.unref();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Starting AI Control Center…' }, async () => {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await this.connect()) return;
      }
      void vscode.window.showErrorMessage('The orchestrator did not start. Run `pnpm start` in a terminal to see why.');
    });
  }

  dispose(): void {
    this.stream?.stop();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.statusItem.dispose();
    this.output.dispose();
    this.panel?.dispose();
  }
}

async function pickTask(center: ControlCenter, api: ApiClient, filter: (t: TaskSummary) => boolean, placeholder: string): Promise<TaskSummary | undefined> {
  const { items } = await api.request<{ items: TaskSummary[] }>('GET', '/api/tasks?limit=100');
  const candidates = items.filter(filter);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('No task matches this action right now.');
    return undefined;
  }
  const current = center.currentTaskId();
  if (candidates.length === 1) return candidates[0];
  const picked = await vscode.window.showQuickPick(
    candidates
      .sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : b.updatedAt.localeCompare(a.updatedAt)))
      .map((t) => ({ label: `${t.id} ${t.title}`, description: `${t.status.replace(/_/g, ' ').toLowerCase()} · ${t.currentStageName ?? ''}`, task: t })),
    { placeHolder: placeholder },
  );
  return picked?.task;
}

const RESUMABLE = ['PAUSED', 'INTERRUPTED', 'WAITING_FOR_USAGE_RESET', 'WAITING_FOR_USER', 'FAILED'];
const ACTIVE = (t: TaskSummary) => !['COMPLETED', 'CANCELLED'].includes(t.status);

export function activate(context: vscode.ExtensionContext): void {
  const center = new ControlCenter(context);
  context.subscriptions.push(center);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('acc.controlCenterView', { resolveWebviewView: (view) => center.resolveView(view) }, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  const withTask = (filter: (t: TaskSummary) => boolean, placeholder: string, run: (api: ApiClient, task: TaskSummary) => Promise<void>) => async () => {
    const api = await center.requireApi();
    if (!api) return;
    try {
      const task = await pickTask(center, api, filter, placeholder);
      if (task) await run(api, task);
    } catch (error) {
      void vscode.window.showErrorMessage((error as Error).message);
    }
  };

  // vscode://digitronics2025.acc-vscode/open?route=/tasks/TASK-0001 opens the Control Center at a route.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path !== '/open') return;
        const route = new URLSearchParams(uri.query).get('route') ?? '/';
        center.openPanel(route.startsWith('/') ? route : '/');
      },
    }),
  );

  const register = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register('acc.openControlCenter', () => center.openPanel('/'));
  register('acc.newTask', () => center.openPanel('/tasks/new'));
  register('acc.openApprovals', () => center.openPanel('/approvals'));
  register('acc.openCurrentTask', () => {
    const id = center.currentTaskId();
    center.openPanel(id ? `/tasks/${id}` : '/');
  });
  register('acc.startOrchestrator', () => center.startOrchestrator());
  register('acc.reconnect', async () => {
    if (!(await center.connect())) void vscode.window.showWarningMessage('The orchestrator is still not reachable.');
  });
  register(
    'acc.pauseTask',
    withTask((t) => t.status === 'RUNNING' || t.status === 'QUEUED', 'Pause which task?', async (api, t) => {
      await api.request('POST', `/api/tasks/${t.id}/pause`, {});
      void vscode.window.showInformationMessage(`${t.id} paused.`);
    }),
  );
  register(
    'acc.resumeTask',
    withTask((t) => RESUMABLE.includes(t.status) && t.blocker?.kind !== 'approval', 'Resume which task?', async (api, t) => {
      await api.request('POST', `/api/tasks/${t.id}/resume`, {});
      void vscode.window.showInformationMessage(`${t.id} resumed.`);
    }),
  );
  register(
    'acc.retryStage',
    withTask((t) => RESUMABLE.includes(t.status), 'Retry the current stage of which task?', async (api, t) => {
      await api.request('POST', `/api/tasks/${t.id}/retry`, {});
      void vscode.window.showInformationMessage(`${t.id}: retry requested.`);
    }),
  );
  register(
    'acc.cancelTask',
    withTask(ACTIVE, 'Cancel which task?', async (api, t) => {
      const confirm = `Cancel ${t.id}`;
      const choice = await vscode.window.showWarningMessage(
        `Cancel ${t.id} "${t.title}"? The running stage stops and the task cannot be resumed. Changed files stay for your review.`,
        { modal: true },
        confirm,
      );
      if (choice !== confirm) return;
      await api.request('POST', `/api/tasks/${t.id}/cancel`, {});
      void vscode.window.showInformationMessage(`${t.id} cancelled.`);
    }),
  );
  register(
    'acc.addDirective',
    withTask(ACTIVE, 'Add a directive to which task?', async (api, t) => {
      const text = await vscode.window.showInputBox({
        title: `Directive for ${t.id}`,
        prompt: 'Applied at the next safe boundary: the next agent stage receives it with its instructions.',
        placeHolder: 'e.g. Do not modify the D1 schema.',
        validateInput: (v) => (v.trim() ? null : 'Write the instruction the next stage must follow.'),
      });
      if (!text) return;
      await api.request('POST', `/api/tasks/${t.id}/directives`, { text });
      void vscode.window.showInformationMessage(`Directive queued for ${t.id}.`);
    }),
  );
  register(
    'acc.rerouteStage',
    withTask((t) => ACTIVE(t) && t.status !== 'DRAFT', 'Reroute a stage of which task?', async (api, t) => {
      const [detail, agents] = await Promise.all([api.request<TaskDetail>('GET', `/api/tasks/${t.id}`), api.request<AgentInfo[]>('GET', '/api/agents')]);
      const stage = await vscode.window.showQuickPick(
        detail.workflow.stages
          .filter((s) => s.kind === 'agent')
          .map((s) => ({ label: s.name, description: s.key === detail.currentStageKey ? 'current stage' : '', key: s.key })),
        { placeHolder: 'Which stage?' },
      );
      if (!stage) return;
      const agent = await vscode.window.showQuickPick(
        agents.map((a) => ({ label: a.name, description: a.health.state === 'connected' ? '' : a.health.message, id: a.id })),
        { placeHolder: 'Reroute to which agent?' },
      );
      if (!agent) return;
      const reason = await vscode.window.showInputBox({ prompt: 'Reason (optional)', placeHolder: 'e.g. usage limit reached' });
      await api.request('POST', `/api/tasks/${t.id}/reroute`, { stageKey: stage.key, agentId: agent.id, reason: reason || undefined });
      void vscode.window.showInformationMessage(`${stage.label} rerouted to ${agent.label}.`);
    }),
  );
  for (const [command, tab] of [
    ['acc.openLogs', 'logs'],
    ['acc.openArtifacts', 'artifacts'],
    ['acc.openDiff', 'changes'],
  ] as const) {
    register(
      command,
      withTask(() => true, 'Which task?', async (_api, t) => center.openPanel(`/tasks/${t.id}?tab=${tab}`)),
    );
  }

  void center.connect().then(async (ok) => {
    if (!ok && center && vscode.workspace.getConfiguration('acc').get<boolean>('autoStart')) await center.startOrchestrator();
  });
}

export function deactivate(): void {
  /* disposables are released through context.subscriptions */
}
