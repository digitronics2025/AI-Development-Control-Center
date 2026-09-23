import { Download, Eye, ExternalLink, FileText } from 'lucide-react';
import { useState } from 'react';
import { Button, DataTable, Drawer, EmptyState, IconButton, RelativeTime, Skeleton, formatBytes, useFeedback, type Column } from '@acc/ui';
import type { Artifact, TaskDetail } from '@acc/shared';
import { useArtifactContent, useTaskArtifacts } from '../../api/hooks';
import { useRuntime } from '../../app/runtime';
import { Markdown } from '../../components/markdown';

const TYPE_LABEL: Record<Artifact['type'], string> = {
  request: 'Request',
  investigation: 'Investigation',
  plan: 'Plan',
  'implementation-report': 'Implementation report',
  review: 'Review',
  'fix-report': 'Fix report',
  verification: 'Verification',
  'tests-log': 'Test log',
  'git-diff': 'Git diff',
  'final-report': 'Final report',
  'task-json': 'Task record',
  'stage-output': 'Stage output',
  'staged-diff': 'Staged diff',
  environment: 'Environment',
  screenshot: 'Screenshot',
  'browser-report': 'Browser verification',
  'tool-output': 'Tool output',
};

function ArtifactPreview({ artifact, onClose }: { artifact: Artifact | null; onClose: () => void }) {
  const content = useArtifactContent(artifact?.id ?? null);
  const { api } = useRuntime();
  const { toast } = useFeedback();
  const markdown = artifact?.mime === 'text/markdown';
  return (
    <Drawer
      open={Boolean(artifact)}
      onOpenChange={(open) => !open && onClose()}
      title={artifact?.name ?? 'Artifact'}
      description={artifact ? `${TYPE_LABEL[artifact.type]} · ${formatBytes(artifact.size)}` : undefined}
      width={720}
      footer={
        artifact ? (
          <Button icon={Download} onClick={() => void api.download(`/api/artifacts/${artifact.id}/download`, artifact.name).catch((e: Error) => toast(e.message, 'info'))}>
            Download
          </Button>
        ) : null
      }
    >
      {content.isLoading ? (
        <Skeleton className="h-64" />
      ) : content.data ? (
        <>
          {markdown ? (
            <Markdown>{content.data.content}</Markdown>
          ) : (
            <pre className="overflow-x-auto whitespace-pre rounded-md border border-border-subtle bg-canvas p-3 font-mono text-code text-fg">{content.data.content}</pre>
          )}
          {content.data.truncated ? <p className="mt-2 text-small text-fg-secondary">Preview truncated at 2 MB. Download for the full file.</p> : null}
        </>
      ) : (
        <p className="text-fg-secondary">The artifact could not be loaded.</p>
      )}
    </Drawer>
  );
}

/** Artifacts tab (design.md §7.3): name, type, source stage, created, preview/open/download. */
export function ArtifactsTab({ task }: { task: TaskDetail }) {
  const artifacts = useTaskArtifacts(task.id);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const { host, postToHost, api } = useRuntime();
  const { toast } = useFeedback();
  const stageName = (key: string | null) => (key ? (task.workflow.stages.find((s) => s.key === key)?.name ?? key) : 'Task');

  const columns: Column<Artifact>[] = [
    {
      key: 'name',
      header: 'Name',
      primary: true,
      sortValue: (a) => a.name,
      cell: (a) => (
        <button type="button" onClick={() => setPreview(a)} className="inline-flex items-center gap-2 rounded-sm font-mono text-code text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus">
          <FileText size={16} className="text-fg-secondary" aria-hidden />
          {a.name}
        </button>
      ),
    },
    { key: 'type', header: 'Type', sortValue: (a) => a.type, cell: (a) => <span className="text-fg-secondary">{TYPE_LABEL[a.type]}</span> },
    { key: 'stage', header: 'Source stage', cell: (a) => <span className="text-fg-secondary">{stageName(a.stageKey)}</span> },
    { key: 'created', header: 'Created', sortValue: (a) => a.createdAt, cell: (a) => <RelativeTime iso={a.createdAt} className="text-fg-secondary" /> },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (a) => (
        <div className="flex justify-end gap-1">
          <IconButton icon={Eye} label={`Preview ${a.name}`} size="compact" onClick={() => setPreview(a)} />
          {host === 'vscode' && postToHost ? (
            <IconButton icon={ExternalLink} label={`Open ${a.name} in editor`} size="compact" onClick={() => postToHost({ type: 'openArtifact', artifactId: a.id, name: a.name })} />
          ) : null}
          <IconButton
            icon={Download}
            label={`Download ${a.name}`}
            size="compact"
            onClick={() => void api.download(`/api/artifacts/${a.id}/download`, a.name).catch((e: Error) => toast(e.message, 'info'))}
          />
        </div>
      ),
    },
  ];

  if (artifacts.isLoading) return <Skeleton className="h-48" />;
  return (
    <>
      <DataTable
        caption="Task artifacts"
        columns={columns}
        rows={artifacts.data ?? []}
        rowKey={(a) => a.id}
        initialSort={{ key: 'created', direction: 'asc' }}
        empty={<EmptyState icon={FileText} title="No artifacts yet" description="Investigation, plan, reports and the final report appear here as stages finish." />}
      />
      <ArtifactPreview artifact={preview} onClose={() => setPreview(null)} />
    </>
  );
}
