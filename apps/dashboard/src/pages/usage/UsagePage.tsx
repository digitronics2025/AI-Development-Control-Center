import { Download, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Input, Menu, PageHeader, SegmentedControl, Tab, TabList, TabPanel, Tabs, useFeedback } from '@acc/ui';
import { errorMessage } from '../../api/client';
import { keys } from '../../api/keys';
import { query } from '../../api/usage';
import { useApi } from '../../app/runtime';
import { useBreadcrumb } from '../../app/breadcrumbs';
import { BreakdownTab } from './BreakdownTab';
import { BudgetsTab } from './BudgetsTab';
import { EventsTab } from './EventsTab';
import { OverviewTab } from './OverviewTab';
import { ProvidersTab } from './ProvidersTab';
import { TasksTab } from './TasksTab';
import { localDate, useUsageState, type RangeKey } from './common';

const TABS = ['overview', 'tasks', 'models', 'agents', 'providers', 'budgets', 'events'] as const;
type TabKey = (typeof TABS)[number];

/** design.md §7.10 — Usage & Costs. */
export function UsagePage() {
  useBreadcrumb([{ label: 'Usage & Costs' }]);
  const state = useUsageState();
  const { params, rangeKey, fromDate, toDate, update } = state;
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabKey) : 'overview';
  const api = useApi();
  const qc = useQueryClient();
  const { toast } = useFeedback();

  const download = async (dataset: 'events' | 'tasks' | 'models', format: 'csv' | 'json') => {
    try {
      await api.download(`/api/usage/export?${query(state.query, { dataset, format })}`, `usage-${dataset}.${format}`);
      toast(`Exported ${dataset} as ${format.toUpperCase()}`, 'success');
    } catch (error) {
      toast(errorMessage(error), 'info');
    }
  };

  const setRange = (key: RangeKey) => {
    if (key !== 'custom') return update({ range: key === '7d' ? null : key, from: null, to: null });
    const today = new Date();
    update({ range: 'custom', from: fromDate ?? localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)), to: toDate ?? localDate(today) });
  };

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5 md:px-6 xl:px-8">
      <PageHeader
        title="Usage & Costs"
        description="What agents used, what it cost, what remains, and where it was wasted — from the recorded runs only."
        actions={
          <>
            <Menu
              trigger={
                <Button icon={Download} aria-label="Export">
                  Export
                </Button>
              }
              items={[
                { label: 'Attempts (CSV)', onSelect: () => void download('events', 'csv') },
                { label: 'Attempts (JSON)', onSelect: () => void download('events', 'json') },
                { label: 'Tasks (CSV)', onSelect: () => void download('tasks', 'csv') },
                { label: 'Models (CSV)', onSelect: () => void download('models', 'csv') },
              ]}
            />
            <Button icon={RefreshCw} onClick={() => void qc.invalidateQueries({ queryKey: keys.usageRoot })}>
              Refresh
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl<RangeKey>
          label="Date range"
          value={rangeKey}
          onValueChange={setRange}
          className="overflow-x-auto"
          options={[
            { value: 'today', label: 'Today' },
            { value: '7d', label: '7 days' },
            { value: 'month', label: 'This month' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        {rangeKey === 'custom' ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-small text-fg-secondary">
              From
              <Input type="date" className="w-40" value={fromDate ?? ''} max={toDate ?? undefined} onChange={(e) => update({ from: e.target.value || null })} />
            </label>
            <label className="flex items-center gap-2 text-small text-fg-secondary">
              To
              <Input type="date" className="w-40" value={toDate ?? ''} min={fromDate ?? undefined} onChange={(e) => update({ to: e.target.value || null })} />
            </label>
          </div>
        ) : null}
      </div>
      <Tabs value={tab} onValueChange={(v) => update({ tab: v === 'overview' ? null : v })}>
        <TabList label="Usage views" className="overflow-x-auto">
          <Tab value="overview">Overview</Tab>
          <Tab value="tasks">Tasks</Tab>
          <Tab value="models">Models</Tab>
          <Tab value="agents">Agents</Tab>
          <Tab value="providers">Providers</Tab>
          <Tab value="budgets">Budgets</Tab>
          <Tab value="events">Attempts</Tab>
        </TabList>
        <TabPanel value="overview">{tab === 'overview' ? <OverviewTab state={state} /> : null}</TabPanel>
        <TabPanel value="tasks">{tab === 'tasks' ? <TasksTab state={state} /> : null}</TabPanel>
        <TabPanel value="models">{tab === 'models' ? <BreakdownTab state={state} dimension="model" /> : null}</TabPanel>
        <TabPanel value="agents">{tab === 'agents' ? <BreakdownTab state={state} dimension="role" /> : null}</TabPanel>
        <TabPanel value="providers">{tab === 'providers' ? <ProvidersTab state={state} /> : null}</TabPanel>
        <TabPanel value="budgets">{tab === 'budgets' ? <BudgetsTab /> : null}</TabPanel>
        <TabPanel value="events">{tab === 'events' ? <EventsTab state={state} /> : null}</TabPanel>
      </Tabs>
    </div>
  );
}
