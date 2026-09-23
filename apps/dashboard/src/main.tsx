import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App, createQueryClient } from './app/App';
import { detectMode, type RuntimeConfig } from './app/runtime';
import { applyInitialTheme } from './app/theme';
import './styles.css';

applyInitialTheme('web');
const root = document.getElementById('root')!;

function render(config: RuntimeConfig): void {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App config={config} queryClient={createQueryClient()} />
      </BrowserRouter>
    </StrictMode>,
  );
}

function fail(title: string, text: string): void {
  const main = document.createElement('main');
  main.style.cssText = 'padding:24px;font-family:system-ui;max-width:640px';
  const h1 = document.createElement('h1');
  h1.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  main.append(h1, p);
  root.replaceChildren(main);
}

// The orchestrator injects its token into the page it serves: that is local mode.
// Without it the page came from the cloud control plane, which authenticates through
// Cloudflare Access; the session check below confirms it before the app starts.
const detected = detectMode(document);
if (detected.mode === 'local') {
  render({ baseUrl: '', mode: 'local', token: detected.token, host: 'web' });
} else {
  fetch('/api/cloud/session', { credentials: 'same-origin' })
    .then((response) => {
      if (response.ok) render({ baseUrl: '', mode: 'cloud', host: 'web' });
      else if (response.status === 401 || response.status === 403) fail('Sign in required', 'Your sign-in expired or this account is not allowed. Reload the page to sign in again.');
      else fail('Control Center unavailable', 'The page could not reach its control plane. If you opened a local copy, open the dashboard from the orchestrator at http://127.0.0.1:4317 instead.');
    })
    .catch(() => fail('Control Center unavailable', 'The control plane did not answer. Check your connection and reload.'));
}
