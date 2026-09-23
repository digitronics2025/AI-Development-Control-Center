import {
  Bot,
  ChevronsLeft,
  Coins,
  ChevronsRight,
  FolderGit2,
  GitBranch,
  House,
  ListChecks,
  Menu as MenuIcon,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { Suspense, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router';
import {
  Banner,
  Button,
  CommandPalette,
  Drawer,
  IconButton,
  Kbd,
  Skeleton,
  Tooltip,
  cn,
  useBreakpoint,
  useHotkey,
  useLocalPreference,
  type Command,
} from '@acc/ui';
import { useApprovals, useHealth, useSettings } from '../api/hooks';
import { useCrumbs } from './breadcrumbs';
import { useCommandRegistry } from './commands';
import { useConnection, useRuntime } from './runtime';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

/** design.md §3 — primary navigation, in this order. */
const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/tasks', label: 'Tasks', icon: ListChecks },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/repositories', label: 'Repositories', icon: FolderGit2 },
  { to: '/source-control', label: 'Source Control', icon: GitBranch },
  { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
  { to: '/usage', label: 'Usage & Costs', icon: Coins },
];

function ProductMark({ collapsed }: { collapsed: boolean }) {
  return (
    <Link to="/" className="flex h-14 shrink-0 items-center gap-2.5 rounded-md px-2 focus-visible:outline-2 focus-visible:outline-focus" aria-label="AI Development Control Center — Home">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border-strong bg-elevated font-mono text-small font-semibold text-fg">
        AC
      </span>
      {!collapsed ? (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-body font-semibold text-fg">Control Center</span>
          <span className="truncate text-small text-fg-secondary">AI development</span>
        </span>
      ) : null}
    </Link>
  );
}

function NavEntry({ item, collapsed, badge, onNavigate }: { item: NavItem; collapsed: boolean; badge?: number; onNavigate?: () => void }) {
  const Icon = item.icon;
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      aria-label={collapsed ? `${item.label}${badge ? `, ${badge} waiting` : ''}` : undefined}
      className={({ isActive }) =>
        cn(
          'relative flex h-10 items-center gap-3 rounded-md px-3 text-body font-semibold transition-colors duration-[120ms] pointer-coarse:h-11',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
          collapsed && 'justify-center px-0',
          isActive ? 'bg-accent-muted text-fg' : 'text-fg-secondary hover:bg-elevated hover:text-fg',
        )
      }
    >
      <Icon size={20} aria-hidden className="shrink-0" />
      {!collapsed ? <span className="min-w-0 flex-1 truncate">{item.label}</span> : null}
      {badge ? (
        <span
          className={cn(
            'tabular inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-warning-muted px-1 text-small font-semibold text-fg',
            collapsed && 'absolute right-1.5 top-1',
          )}
        >
          {badge}
          {!collapsed ? <span className="sr-only"> waiting</span> : null}
        </span>
      ) : null}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function ServiceStatus({ collapsed }: { collapsed: boolean }) {
  const connection = useConnection();
  const health = useHealth();
  const label = connection.online ? 'Orchestrator connected' : connection.status === 'connecting' ? 'Connecting…' : 'Orchestrator disconnected';
  const dot = (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', connection.online ? 'bg-success' : connection.status === 'connecting' ? 'bg-warning' : 'bg-danger')}
    />
  );
  const content = (
    <div role="status" className={cn('flex items-center gap-2 rounded-md px-3 py-2', collapsed && 'justify-center px-0')}>
      {dot}
      {collapsed ? <span className="sr-only">{label}</span> : (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-small font-semibold text-fg">{label}</span>
          {health.data ? <span className="truncate text-small text-fg-tertiary">v{health.data.version} · localhost:{health.data.port}</span> : null}
        </span>
      )}
    </div>
  );
  return collapsed ? <Tooltip content={label} side="right">{content}</Tooltip> : content;
}

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const approvals = useApprovals('pending');
  const pending = approvals.data?.length ?? 0;
  return (
    <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-1">
      {NAV.map((item) => (
        <NavEntry key={item.to} item={item} collapsed={collapsed} badge={item.to === '/approvals' ? pending : undefined} onNavigate={onNavigate} />
      ))}
      <div className="flex-1" />
      <NavEntry item={{ to: '/settings', label: 'Settings', icon: SettingsIcon }} collapsed={collapsed} onNavigate={onNavigate} />
      <ServiceStatus collapsed={collapsed} />
    </nav>
  );
}

function Sidebar({ collapsed, onToggle, canExpand }: { collapsed: boolean; onToggle: () => void; canExpand: boolean }) {
  return (
    <aside
      className={cn(
        'sticky top-0 flex h-dvh shrink-0 flex-col gap-2 border-r border-border-subtle bg-surface px-3 pb-3 transition-[width] duration-[180ms]',
        collapsed ? 'w-(--sidebar-width-collapsed)' : 'w-(--sidebar-width)',
      )}
    >
      <ProductMark collapsed={collapsed} />
      <NavList collapsed={collapsed} />
      {canExpand ? (
        <IconButton
          icon={collapsed ? ChevronsRight : ChevronsLeft}
          label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          onClick={onToggle}
          className={cn(collapsed ? 'self-center' : 'self-end')}
        />
      ) : null}
    </aside>
  );
}

function TopBar({ onOpenNav, showMenu }: { onOpenNav: () => void; showMenu: boolean }) {
  const crumbs = useCrumbs();
  const navigate = useNavigate();
  const connection = useConnection();
  const settings = useSettings();
  const health = useHealth();
  const { setPaletteOpen } = useCommandRegistry();
  const { isTabletUp } = useBreakpoint();
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border-subtle bg-canvas px-4 sm:px-5 md:px-6 xl:px-8">
      {showMenu ? <IconButton icon={MenuIcon} label="Open navigation" onClick={onOpenNav} /> : null}
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-body">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${crumb.label}-${i}`} className={cn('flex min-w-0 items-center gap-1.5', !last && 'hidden sm:flex')}>
                {i > 0 ? <span aria-hidden className={cn('text-fg-tertiary', last && 'hidden sm:inline')}>/</span> : null}
                {crumb.to && !last ? (
                  <Link to={crumb.to} className="truncate rounded-sm text-fg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current={last ? 'page' : undefined} className="truncate font-semibold text-fg">
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {settings.data?.billingMode === 'api' ? (
        <Tooltip content="Explicit API Mode is on: agents may use metered API billing. Change it in Settings → Billing.">
          <Link to="/settings/billing" className="hidden h-7 items-center rounded-sm border border-warning px-2 text-small font-semibold text-fg md:inline-flex">
            API billing on
          </Link>
        </Tooltip>
      ) : null}
      {health.data?.simulatedAgents ? (
        <Tooltip content="The orchestrator was started with simulated agents for testing. No provider is contacted.">
          <span className="hidden h-7 items-center rounded-sm border border-info px-2 text-small font-semibold text-fg md:inline-flex">Simulated agents</span>
        </Tooltip>
      ) : null}
      {isTabletUp ? (
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="hidden h-9 w-64 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-left text-body text-fg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-focus lg:flex"
        >
          <Search size={16} aria-hidden />
          <span className="min-w-0 flex-1 truncate whitespace-nowrap">Search or run a command</span>
          <Kbd>Ctrl K</Kbd>
        </button>
      ) : null}
      <IconButton icon={Search} label="Search or run a command (Ctrl+K)" onClick={() => setPaletteOpen(true)} className="lg:hidden" />
      <span className="sr-only" role="status">
        {connection.online ? '' : 'Orchestrator disconnected'}
      </span>
      <Button variant="primary" icon={Plus} onClick={() => navigate('/tasks/new')} disabled={!connection.online} disabledReason="Reconnect to the orchestrator to create tasks">
        <span className="hidden sm:inline">New Task</span>
        <span className="sr-only sm:hidden">New Task</span>
      </Button>
    </header>
  );
}

function ConnectionBanner() {
  const connection = useConnection();
  if (connection.online || (!connection.everConnected && connection.attempts < 2)) return null;
  return (
    <div className="px-4 pt-3 sm:px-5 md:px-6 xl:px-8">
      <Banner
        tone="danger"
        role="alert"
        title={connection.everConnected ? 'Orchestrator disconnected. Showing last known state.' : 'Cannot reach the orchestrator.'}
        actions={
          <Button size="compact" onClick={connection.reconnect} loading={connection.status === 'connecting'}>
            Reconnect
          </Button>
        }
      >
        Actions that change tasks are disabled until the connection is back. {connection.everConnected ? 'Nothing you see has been lost.' : 'Start it with `pnpm start` in the repository.'}
      </Banner>
    </div>
  );
}

function GlobalCommands() {
  const navigate = useNavigate();
  const { pageCommands, paletteOpen, setPaletteOpen } = useCommandRegistry();
  useHotkey('k', (e) => {
    e.preventDefault();
    setPaletteOpen(!paletteOpen);
  }, { mod: true, allowInInputs: true });
  const commands = useMemo<Command[]>(
    () => [
      ...pageCommands,
      { id: 'new-task', label: 'New Task', group: 'Create', icon: Plus, onSelect: () => navigate('/tasks/new') },
      { id: 'open-task', label: 'Open Task…', group: 'Go to', icon: ListChecks, onSelect: () => navigate('/tasks') },
      { id: 'open-repo', label: 'Open Repository…', group: 'Go to', icon: FolderGit2, onSelect: () => navigate('/repositories') },
      { id: 'go-source-control', label: 'Go to Source Control', group: 'Go to', icon: GitBranch, onSelect: () => navigate('/source-control') },
      { id: 'go-agents', label: 'Go to Agents', group: 'Go to', icon: Bot, onSelect: () => navigate('/agents') },
      { id: 'go-workflows', label: 'Go to Workflows', group: 'Go to', icon: Workflow, onSelect: () => navigate('/workflows') },
      { id: 'go-approvals', label: 'Go to Approvals', group: 'Go to', icon: ShieldCheck, onSelect: () => navigate('/approvals') },
      { id: 'go-usage', label: 'Go to Usage & Costs', group: 'Go to', icon: Coins, onSelect: () => navigate('/usage') },
      { id: 'go-home', label: 'Go to Home', group: 'Go to', icon: House, onSelect: () => navigate('/') },
      { id: 'open-settings', label: 'Open Settings', group: 'Go to', icon: SettingsIcon, onSelect: () => navigate('/settings') },
    ],
    [pageCommands, navigate],
  );
  return <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />;
}

export function PageFallback() {
  return (
    <div className="flex flex-col gap-4 p-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** design.md §3.1 global shell with the §6 responsive recomposition. */
export function Shell({ children }: { children: ReactNode }) {
  const { isTabletUp, isCompactUp } = useBreakpoint();
  const { host } = useRuntime();
  const [preferCollapsed, setPreferCollapsed] = useLocalPreference('sidebar-collapsed', false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();
  // Narrow VS Code panels and tablets get the compact rail; phones get a drawer.
  const collapsed = host === 'vscode' ? true : !isCompactUp || preferCollapsed;
  const showSidebar = isTabletUp && host !== 'vscode' ? true : isTabletUp;

  return (
    <div className="flex min-h-dvh bg-canvas">
      <a href="#main" className="sr-only-focusable fixed left-2 top-2 z-[70] rounded-md bg-accent px-3 py-2 font-semibold text-fg-inverse">
        Skip to content
      </a>
      {showSidebar ? <Sidebar collapsed={collapsed} canExpand={isCompactUp && host !== 'vscode'} onToggle={() => setPreferCollapsed(!preferCollapsed)} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar showMenu={!showSidebar} onOpenNav={() => setMobileNavOpen(true)} />
        <ConnectionBanner />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          <Suspense key={location.pathname} fallback={<PageFallback />}>
            {children}
          </Suspense>
        </main>
      </div>
      {!showSidebar ? (
        <Drawer open={mobileNavOpen} onOpenChange={setMobileNavOpen} title="Navigation" width={300}>
          <div className="flex h-full flex-col">
            <NavList collapsed={false} onNavigate={() => setMobileNavOpen(false)} />
          </div>
        </Drawer>
      ) : null}
      <GlobalCommands />
    </div>
  );
}
