import { Terminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Checkbox,
  EmptyState,
  Input,
  KeyValueList,
  LogViewer,
  SegmentedControl,
  Select,
  Skeleton,
  formatDuration,
  formatTime,
  useFeedback,
  useLocalPreference,
} from '@acc/ui';
import type { Execution, TaskDetail } from '@acc/shared';
import { useExecutionLogs, useSettings, useTaskEvents, useTaskExecutions } from '../../api/hooks';
import { useAgentNames } from '../../components/agents';
import { EventTimeline } from './ActivityTab';

type LogMode = 'simple' | 'developer';

function executionLabel(e: Execution, stageName: string, agentName: (id: string | null) => string): string {
  const who = e.kind === 'agent' ? agentName(e.agentId) : e.command.replace(/^\$ /, '');
  return `${formatTime(e.startedAt)} · ${stageName} · ${who} · ${e.status.replace('_', ' ')}`;
}

/**
 * Logs tab (design.md §7.3): Simple by default (human-readable progress);
 * Developer adds monospace output with stdout/stderr, timestamps, execution
 * IDs, command, exit code, copy and filter/search.
 */
export function LogsTab({ task }: { task: TaskDetail }) {
  const settings = useSettings();
  // Developer mode (Settings → Advanced) changes the default; an explicit choice here wins.
  const [storedMode, setMode] = useLocalPreference<LogMode | null>('log-mode', null);
  const mode: LogMode = storedMode ?? (settings.data?.developerMode ? 'developer' : 'simple');
  const executions = useTaskExecutions(task.id);
  const events = useTaskEvents(task.id);
  const agentName = useAgentNames();
  const { toast } = useFeedback();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [streams, setStreams] = useState({ stdout: true, stderr: true, system: true });

  const list = useMemo(() => executions.data ?? [], [executions.data]);
  // Follow the newest execution until the user picks one explicitly.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinned && list.length) setSelectedId(list.at(-1)!.id);
  }, [list, pinned]);
  const selected = list.find((e) => e.id === selectedId) ?? null;
  const logs = useExecutionLogs(mode === 'developer' ? selectedId : null);
  const stageName = useMemo(() => {
    const map = new Map(task.stages.map((s) => [s.id, s.name]));
    return (id: string | null) => (id ? (map.get(id) ?? 'Stage') : 'Task');
  }, [task.stages]);

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl<LogMode>
        label="Log detail"
        value={mode}
        onValueChange={setMode}
        size="compact"
        className="self-start"
        options={[
          { value: 'simple', label: 'Simple' },
          { value: 'developer', label: 'Developer' },
        ]}
      />
      {mode === 'simple' ? (
        events.isLoading ? <Skeleton className="h-40" /> : <EventTimeline events={events.data ?? []} showTechnical={false} />
      ) : executions.isLoading ? (
        <Skeleton className="h-64" />
      ) : list.length === 0 ? (
        <EmptyState icon={Terminal} title="No executions yet" description="Agent runs and repository commands appear here with their full output." />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
            <label className="flex flex-col gap-1.5">
              <span className="text-body font-semibold text-fg">Execution</span>
              <Select
                value={selectedId ?? undefined}
                onValueChange={(v) => {
                  setPinned(true);
                  setSelectedId(v);
                }}
                options={[...list].reverse().map((e) => ({ value: e.id, label: executionLabel(e, stageName(e.stageId), agentName) }))}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-body font-semibold text-fg">Filter output</span>
              <Input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search this log" />
            </label>
          </div>
          <div className="flex flex-wrap gap-4">
            <Checkbox checked={streams.stdout} onCheckedChange={(v) => setStreams((s) => ({ ...s, stdout: v }))} label="stdout" />
            <Checkbox checked={streams.stderr} onCheckedChange={(v) => setStreams((s) => ({ ...s, stderr: v }))} label="stderr" />
            <Checkbox checked={streams.system} onCheckedChange={(v) => setStreams((s) => ({ ...s, system: v }))} label="system" />
          </div>
          {selected ? (
            <KeyValueList
              className="rounded-lg border border-border-subtle bg-surface p-3 text-small"
              items={[
                { label: 'Command', value: <code className="font-mono text-code wrap-anywhere">{selected.command}</code> },
                { label: 'Directory', value: <code className="font-mono text-code">{selected.cwd}</code> },
                { label: 'Status', value: `${selected.status.replace('_', ' ')}${selected.exitCode !== null ? ` · exit code ${selected.exitCode}` : ''}${selected.errorClass ? ` · ${selected.errorClass}` : ''}` },
                { label: 'Duration', value: selected.durationMs !== null ? formatDuration(selected.durationMs) : 'running' },
                { label: 'Error', value: selected.errorMessage, hidden: !selected.errorMessage },
                { label: 'Execution ID', value: <code className="font-mono text-code">{selected.id}</code> },
              ]}
            />
          ) : null}
          {logs.isLoading ? (
            <Skeleton className="h-96" />
          ) : (
            <LogViewer lines={logs.data ?? []} filter={filter} showStreams={streams} height="min(60vh, 560px)" onCopy={() => toast('Output copied')} />
          )}
        </div>
      )}
    </div>
  );
}
