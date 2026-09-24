import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApiClient, Discovery } from './connection';
import { registeredFile, registeredRoot } from './paths';

type HostMessage =
  | { type: 'openFile'; repositoryPath: string; path: string }
  | { type: 'openDiff'; taskId: string; path: string; repositoryId?: string }
  | { type: 'openSourceControlDiff'; repositoryId: string; path: string; mode: 'staged' | 'unstaged' }
  | { type: 'openCommitDiff'; repositoryId: string; sha: string; path: string }
  | { type: 'revealRepository'; repositoryPath: string }
  | { type: 'openArtifact'; artifactId: string; name: string }
  | { type: 'openExternal'; url: string }
  | { type: 'pickRepositoryFolder'; requestId: string };

/**
 * Page for the shared dashboard bundle (design.md §13). The CSP allows only
 * this extension's assets, one nonce'd bootstrap script, and connections to
 * the loopback orchestrator.
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, discovery: Discovery, initialPath: string): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  const origin = new URL(discovery.url);
  const csp = [
    "default-src 'none'",
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `connect-src ${origin.origin} ws://${origin.host}`,
  ].join('; ');
  const boot = JSON.stringify({ baseUrl: discovery.url, token: discovery.token, initialPath }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en" data-theme="vscode">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('webview.css')}">
<title>AI Development Control Center</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">window.__ACC_WEBVIEW__ = ${boot};</script>
<script nonce="${nonce}" type="module" src="${media('webview.js')}"></script>
</body>
</html>`;
}

function untitled(content: string, language: string): Thenable<vscode.TextEditor> {
  return vscode.workspace.openTextDocument({ content, language }).then((doc) => vscode.window.showTextDocument(doc, { preview: true }));
}

/** Handle requests from the WebView to use real editor features. */
export async function handleHostMessage(webview: vscode.Webview, api: ApiClient, message: HostMessage): Promise<void> {
  switch (message.type) {
    case 'openFile': {
      // The WebView names both the folder and the file, so the folder must be one the
      // orchestrator registered, and the file must stay inside it (audit F-48).
      const target = await registeredFile(api, message.repositoryPath, message.path);
      if (target) await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
      return;
    }
    case 'openDiff': {
      const repository = message.repositoryId ? `&repositoryId=${encodeURIComponent(message.repositoryId)}` : '';
      const { diff } = await api.request<{ diff: string }>('GET', `/api/tasks/${encodeURIComponent(message.taskId)}/diff?path=${encodeURIComponent(message.path)}${repository}`);
      await untitled(diff || 'No changes in this file.', 'diff');
      return;
    }
    case 'openSourceControlDiff': {
      // The orchestrator stays the source of truth: the editor shows its (redacted, bounded) diff.
      const base = `/api/repositories/${encodeURIComponent(message.repositoryId)}/source-control`;
      const mode = message.mode === 'staged' ? 'staged' : 'unstaged';
      const { diff } = await api.request<{ diff: string }>('GET', `${base}/diff?path=${encodeURIComponent(message.path)}&mode=${mode}`);
      await untitled(diff || 'No changes in this file.', 'diff');
      return;
    }
    case 'openCommitDiff': {
      if (!/^[0-9a-f]{7,64}$/.test(message.sha)) return;
      const base = `/api/repositories/${encodeURIComponent(message.repositoryId)}/source-control`;
      const { diff } = await api.request<{ diff: string }>('GET', `${base}/commits/${message.sha}/diff?path=${encodeURIComponent(message.path)}`);
      await untitled(diff || 'No changes in this file.', 'diff');
      return;
    }
    case 'revealRepository': {
      const root = await registeredRoot(api, message.repositoryPath);
      if (root) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root));
      return;
    }
    case 'openArtifact': {
      const { content } = await api.request<{ content: string }>('GET', `/api/artifacts/${encodeURIComponent(message.artifactId)}/content`);
      await untitled(content, message.name.endsWith('.md') ? 'markdown' : message.name.endsWith('.json') ? 'json' : message.name.endsWith('.patch') ? 'diff' : 'plaintext');
      return;
    }
    case 'openExternal':
      if (/^https?:\/\//.test(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    case 'pickRepositoryFolder': {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use this repository' });
      await webview.postMessage({ type: 'folderPicked', requestId: message.requestId, path: picked?.[0]?.fsPath ?? null });
      return;
    }
  }
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
}
