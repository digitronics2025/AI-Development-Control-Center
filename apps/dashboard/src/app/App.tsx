import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, useEffect, useRef, useState } from 'react';
import { Route, Routes } from 'react-router';
import { EmptyState, FeedbackProvider, TooltipProvider } from '@acc/ui';
import { TASK_STATUS_LABEL, type TaskStatus } from '@acc/shared';
import { useOverview, useSettings } from '../api/hooks';
import { HomePage } from '../pages/HomePage';
import { BreadcrumbProvider, useBreadcrumb } from './breadcrumbs';
import { CommandProvider } from './commands';
import { RuntimeProvider, useRuntime, type RuntimeConfig } from './runtime';
import { Shell } from './Shell';
import { useThemeController } from './theme';

// Route-level code splitting keeps the shell fast (design.md §21).
const TasksPage = lazy(() => import('../pages/TasksPage').then((m) => ({ default: m.TasksPage })));
const NewTaskPage = lazy(() => import('../pages/NewTaskPage').then((m) => ({ default: m.NewTaskPage })));
const TaskDetailPage = lazy(() => import('../pages/task/TaskDetailPage').then((m) => ({ default: m.TaskDetailPage })));
const ApprovalsPage = lazy(() => import('../pages/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })));
const WorkflowsPage = lazy(() => import('../pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })));
const AgentsPage = lazy(() => import('../pages/AgentsPage').then((m) => ({ default: m.AgentsPage })));
const ToolsPage = lazy(() => import('../pages/ToolsPage').then((m) => ({ default: m.ToolsPage })));
const RepositoriesPage = lazy(() => import('../pages/RepositoriesPage').then((m) => ({ default: m.RepositoriesPage })));
const RepositoryDetailPage = lazy(() => import('../pages/RepositoryDetailPage').then((m) => ({ default: m.RepositoryDetailPage })));
const SourceControlPage = lazy(() => import('../pages/source-control/SourceControlPage').then((m) => ({ default: m.SourceControlPage })));
const UsagePage = lazy(() => import('../pages/usage/UsagePage').then((m) => ({ default: m.UsagePage })));
const UsageTaskPage = lazy(() => import('../pages/usage/UsageTaskPage').then((m) => ({ default: m.UsageTaskPage })));
const SettingsPage = lazy(() => import('../pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

function NotFound() {
  useBreadcrumb([{ label: 'Not found' }]);
  return (
    <div className="px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <EmptyState title="This page does not exist" description="Use the navigation or press Ctrl+K to find what you need." />
    </div>
  );
}

function ThemeSync() {
  const settings = useSettings();
  const { host } = useRuntime();
  useThemeController(settings.data?.theme, host);
  return null;
}

/**
 * Desktop notifications while the page is in the background (web only; the
 * VS Code extension shows its own). Driven by the same server state.
 */
function NotificationBridge() {
  const settings = useSettings();
  const overview = useOverview();
  const { host } = useRuntime();
  const seen = useRef(new Map<string, TaskStatus>());
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    if (!overview.data) return;
    const all = [...overview.data.attention, ...overview.data.active, ...overview.data.recent];
    const prefs = settings.data?.notifications;
    for (const task of all) {
      const before = seen.current.get(task.id);
      seen.current.set(task.id, task.status);
      if (!primed || before === task.status || host !== 'web' || !prefs) continue;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState === 'visible') continue;
      const approval = task.status === 'WAITING_FOR_USER' && task.blocker?.kind === 'approval';
      const failure = task.status === 'FAILED' || (task.status === 'WAITING_FOR_USER' && !approval) || task.status === 'WAITING_FOR_USAGE_RESET';
      if ((approval && prefs.approvals) || (failure && prefs.failures) || (task.status === 'COMPLETED' && prefs.completions)) {
        new Notification(`${task.id}: ${TASK_STATUS_LABEL[task.status]}`, { body: task.blocker?.message ?? task.title, tag: task.id });
      }
    }
    if (!primed) setPrimed(true);
  }, [overview.data, settings.data, host, primed]);
  return null;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Realtime messages keep data fresh; refetch only on reconnect or explicit invalidation.
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => count < 2 && (error as { status?: number }).status !== 404,
      },
    },
  });
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/tasks/new" element={<NewTaskPage />} />
      <Route path="/tasks/:id" element={<TaskDetailPage />} />
      <Route path="/approvals" element={<ApprovalsPage />} />
      <Route path="/workflows" element={<WorkflowsPage />} />
      <Route path="/workflows/:id" element={<WorkflowsPage />} />
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/tools" element={<ToolsPage />} />
      <Route path="/tools/:tab" element={<ToolsPage />} />
      <Route path="/repositories" element={<RepositoriesPage />} />
      <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
      <Route path="/source-control" element={<SourceControlPage />} />
      <Route path="/source-control/:repositoryId" element={<SourceControlPage />} />
      <Route path="/usage" element={<UsagePage />} />
      <Route path="/usage/tasks/:id" element={<UsageTaskPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/settings/:section" element={<SettingsPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/** Providers shared by the standalone dashboard and the VS Code WebView. */
export function App({ config, queryClient }: { config: RuntimeConfig; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <FeedbackProvider>
        <TooltipProvider delayDuration={300}>
          <RuntimeProvider config={config}>
            <BreadcrumbProvider>
              <CommandProvider>
                <ThemeSync />
                <NotificationBridge />
                <Shell>
                  <AppRoutes />
                </Shell>
              </CommandProvider>
            </BreadcrumbProvider>
          </RuntimeProvider>
        </TooltipProvider>
      </FeedbackProvider>
    </QueryClientProvider>
  );
}
