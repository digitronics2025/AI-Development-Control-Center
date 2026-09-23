import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router';
import { App, createQueryClient } from './app/App';
import type { HostMessage } from './app/runtime';
import { applyInitialTheme } from './app/theme';
import './styles.css';

interface WebviewBootstrap {
  baseUrl: string;
  token: string;
  initialPath?: string;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    __ACC_WEBVIEW__?: WebviewBootstrap;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const boot = window.__ACC_WEBVIEW__;
const vscode = window.acquireVsCodeApi?.();
applyInitialTheme('vscode');

const pending = new Map<string, (value: string | null) => void>();
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; requestId?: string; path?: string | null; navigate?: string };
  if (data?.type === 'folderPicked' && data.requestId) {
    pending.get(data.requestId)?.(data.path ?? null);
    pending.delete(data.requestId);
  }
});

/** Lets the extension host open a route (e.g. a task from the status bar) without reloading. */
function HostNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; path?: string };
      if (data?.type === 'navigate' && typeof data.path === 'string' && data.path.startsWith('/')) navigate(data.path);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);
  return null;
}

const root = document.getElementById('root')!;
if (!boot?.token || !vscode) {
  root.textContent = 'The Control Center WebView could not start: missing connection details.';
} else {
  const postToHost = (message: HostMessage) => vscode.postMessage(message);
  const pickFolder = () =>
    new Promise<string | null>((resolve) => {
      const requestId = Math.random().toString(36).slice(2);
      pending.set(requestId, resolve);
      postToHost({ type: 'pickRepositoryFolder', requestId });
    });
  createRoot(root).render(
    <StrictMode>
      <MemoryRouter initialEntries={[boot.initialPath ?? '/']}>
        <HostNavigation />
        <App config={{ baseUrl: boot.baseUrl, token: boot.token, host: 'vscode', postToHost, pickFolder }} queryClient={createQueryClient()} />
      </MemoryRouter>
    </StrictMode>,
  );
}
