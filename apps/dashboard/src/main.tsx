import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App, createQueryClient } from './app/App';
import { applyInitialTheme } from './app/theme';
import './styles.css';

// The orchestrator injects the local API token into the page it serves.
const token = document.querySelector<HTMLMetaElement>('meta[name="acc-token"]')?.content ?? '';
applyInitialTheme('web');

const root = document.getElementById('root')!;
if (!token) {
  root.innerHTML =
    '<main style="padding:24px;font-family:system-ui"><h1>Control Center token missing</h1><p>Open the dashboard from the orchestrator (http://127.0.0.1:4317) so it can authenticate.</p></main>';
} else {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App config={{ baseUrl: '', token, host: 'web' }} queryClient={createQueryClient()} />
      </BrowserRouter>
    </StrictMode>,
  );
}
