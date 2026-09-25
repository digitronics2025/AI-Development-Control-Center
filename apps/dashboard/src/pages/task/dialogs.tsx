import { useState } from 'react';
import { Button, Checkbox, ConfirmDialog, Dialog, Field, Input, Select, SlashTextarea, useFeedback } from '@acc/ui';
import { COMMAND_KIND_LABEL, ROLE_LABEL, type CommandKind, type PartialAssignment, type TaskDetail } from '@acc/shared';
import { errorMessage } from '../../api/client';
import { useTaskCommand, useTaskDirectives, useTaskTests } from '../../api/hooks';
import { useConnection } from '../../app/runtime';
import { AssignmentPicker } from '../../components/assignment-picker';
import { RequestedSkills, useSkillPicker } from '../../components/skill-picker';
import { useAgentNames } from '../../components/agents';

/**
 * Add a directive (PLAN §20): persisted immediately, applied at the next safe
 * execution boundary — never injected into a running prompt.
 */
/**
 * Check kinds that failed in this task and are not waived yet: the only ones
 * the "Don't gate this task on" row offers (AUTOPILOT_GATES_PLAN §3.C).
 */
function useWaivableKinds(taskId: string): CommandKind[] {
  const tests = useTaskTests(taskId);
  const directives = useTaskDirectives(taskId);
  const waived = new Set((directives.data ?? []).flatMap((d) => (d.state === 'active' && d.rule?.type === 'waive_check' ? d.rule.kinds : [])));
  return [...new Set((tests.data ?? []).filter((r) => r.status === 'failed' && r.kind !== 'other').map((r) => r.kind))].filter((k) => !waived.has(k));
}

export function DirectiveForm({ task, onDone, autoFocus }: { task: TaskDetail; onDone?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const waivable = useWaivableKinds(task.id);
  const [waive, setWaive] = useState<CommandKind[]>([]);
  const skillPicker = useSkillPicker(task.repositoryId, text);
  const [pause, setPause] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = useTaskCommand(task.id);
  const connection = useConnection();
  const { toast } = useFeedback();
  const running = task.status === 'RUNNING';
  // The task stopped on a stage's question: the directive is the answer, and it continues the task.
  const answering = task.status === 'WAITING_FOR_USER' && task.blocker?.kind === 'decision';
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const kinds = waive.filter((k) => waivable.includes(k));
        // The checkboxes carry the rule; the text stays free, and says what was decided when left empty.
        const body = text.trim() || (kinds.length ? `Don't gate this task on ${kinds.map((k) => COMMAND_KIND_LABEL[k].toLowerCase()).join(', ')}.` : '');
        if (!body) {
          setError('Write the instruction the next stage must follow.');
          return;
        }
        command.mutate(
          { command: 'directives', body: { text: body, pause, ...(kinds.length ? { rule: { type: 'waive_check', kinds } } : {}) } },
          {
            onSuccess: () => {
              toast(kinds.length ? `No longer gating this task on ${kinds.map((k) => COMMAND_KIND_LABEL[k].toLowerCase()).join(', ')}` : answering ? 'Answer recorded; the task continues' : pause ? 'Directive queued; pausing the task' : 'Directive queued for the next stage');
              setText('');
              setWaive([]);
              setPause(false);
              setError(null);
              onDone?.();
            },
            onError: (err) => setError(errorMessage(err)),
          },
        );
      }}
    >
      {answering ? (
        <div className="rounded-md border border-border-subtle bg-muted p-3 text-body">
          <p className="font-semibold text-fg">The question</p>
          <p className="mt-1 whitespace-pre-wrap text-fg-secondary">{task.blocker!.message}</p>
        </div>
      ) : null}
      <Field
        label={answering ? 'Your answer' : 'Directive'}
        error={error}
        helper={
          <>
            {answering ? 'Added as a directive; the stage runs again with it straight away.' : 'Applied at the next safe boundary: the next agent stage receives it with its instructions.'}
            {skillPicker.available ? ' Type / to add a skill.' : null}
            <RequestedSkills names={skillPicker.requested} />
          </>
        }
      >
        <SlashTextarea
          autoFocus={autoFocus}
          value={text}
          onValueChange={setText}
          className="min-h-24"
          placeholder={answering ? 'e.g. Round halves up everywhere; the accounts test is wrong.' : 'e.g. Do not modify the D1 schema.'}
          {...skillPicker.textareaProps}
        />
      </Field>
      {waivable.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-semibold text-fg">Don't gate this task on</legend>
          <p className="text-small text-fg-secondary">Checks that failed in this task. A ticked check stops blocking this task only; other tasks in this repository still run it. The report says you waived it.</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {waivable.map((kind) => (
              <Checkbox
                key={kind}
                checked={waive.includes(kind)}
                onCheckedChange={(on) => setWaive((current) => (on ? [...current, kind] : current.filter((k) => k !== kind)))}
                label={COMMAND_KIND_LABEL[kind]}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      {running ? (
        <Checkbox checked={pause} onCheckedChange={setPause} label="Pause the current stage now" description="Stops the running stage; it runs again with this directive when you resume." />
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" loading={command.isPending} disabled={!connection.online} disabledReason="Reconnect to the orchestrator first">
          {answering ? 'Answer and continue' : 'Add directive'}
        </Button>
      </div>
    </form>
  );
}

export function DirectiveDialog({ task, open, onOpenChange }: { task: TaskDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={task.blocker?.kind === 'decision' && task.status === 'WAITING_FOR_USER' ? 'Answer the question' : 'Add directive'} description={`${task.id} · ${task.title}`}>
      <DirectiveForm task={task} autoFocus onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

/** Reroute a stage to another agent without restarting the task (PLAN §21). */
export function RerouteDialog({ task, open, onOpenChange, stageKey }: { task: TaskDetail; open: boolean; onOpenChange: (open: boolean) => void; stageKey?: string }) {
  const agentStages = task.workflow.stages.filter((s) => s.kind === 'agent');
  const initialKey = stageKey ?? (agentStages.some((s) => s.key === task.currentStageKey) ? task.currentStageKey! : agentStages[0]?.key);
  const [key, setKey] = useState<string | undefined>(initialKey);
  const current = key ? task.assignments[key] : undefined;
  const [assignment, setAssignment] = useState<PartialAssignment>({});
  const [reason, setReason] = useState('');
  const [applyToRole, setApplyToRole] = useState(false);
  // A provider that is out of credits or signed out would stop every one of its stages in turn.
  const [applyToAgent, setApplyToAgent] = useState(task.blocker?.kind === 'usage' || task.blocker?.kind === 'auth');
  const [error, setError] = useState<string | null>(null);
  const command = useTaskCommand(task.id);
  const names = useAgentNames();
  const { toast } = useFeedback();
  const def = agentStages.find((s) => s.key === key);
  const target = assignment.agentId ? names(assignment.agentId) : null;
  const sameAgentStages =
    current && assignment.agentId && assignment.agentId !== current.agentId
      ? agentStages.filter((s) => s.key !== key && task.assignments[s.key]?.agentId === current.agentId)
      : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setAssignment({});
          setReason('');
          setError(null);
        }
        onOpenChange(next);
      }}
      title="Reroute stage"
      description="The replacement agent receives the task, investigation, plan, current diff, failed tests, logs and your directives."
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep current agent
          </Button>
          <Button
            variant="primary"
            disabled={!assignment.agentId || !key}
            loading={command.isPending}
            onClick={() =>
              command.mutate(
                { command: 'reroute', body: { stageKey: key, agentId: assignment.agentId, model: assignment.model, effort: assignment.effort, reason: reason.trim() || undefined, applyToRole, applyToAgent: applyToAgent && sameAgentStages.length > 0 } },
                {
                  onSuccess: () => {
                    toast(`${def?.name ?? 'Stage'} rerouted to ${target}`);
                    onOpenChange(false);
                  },
                  onError: (err) => setError(errorMessage(err)),
                },
              )
            }
          >
            {target ? `Reroute to ${target}` : 'Reroute'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Stage">
          <Select value={key} onValueChange={setKey} options={agentStages.map((s) => ({ value: s.key, label: s.name, description: ROLE_LABEL[s.role] }))} />
        </Field>
        {current ? (
          <p className="text-body text-fg-secondary">
            Currently: <span className="text-fg">{names(current.agentId)}</span> · {current.model === 'default' ? 'CLI default model' : current.model} · {current.effort}
          </p>
        ) : null}
        <Field label="New assignment">
          <AssignmentPicker label="Reroute" value={assignment} onChange={setAssignment} />
        </Field>
        <Field label="Reason" optional>
          <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. usage limit reached" />
        </Field>
        {def ? (
          <Checkbox checked={applyToRole} onCheckedChange={setApplyToRole} label={`Also use it for later ${ROLE_LABEL[def.role]} stages`} />
        ) : null}
        {current && sameAgentStages.length ? (
          <Checkbox
            checked={applyToAgent}
            onCheckedChange={setApplyToAgent}
            label={`Also move this task's other ${names(current.agentId)} stages (${sameAgentStages.map((s) => s.name).join(', ')})`}
          />
        ) : null}
        {error ? <p role="alert" className="text-body text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

/** Change a future stage's agent/model/effort (PLAN §12 live intervention). */
export function AssignmentDialog({ task, stageKey, open, onOpenChange }: { task: TaskDetail; stageKey: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const def = task.workflow.stages.find((s) => s.key === stageKey);
  const current = stageKey ? task.assignments[stageKey] : undefined;
  const [value, setValue] = useState<PartialAssignment>(current ?? {});
  const [error, setError] = useState<string | null>(null);
  const command = useTaskCommand(task.id);
  const { toast } = useFeedback();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && current) setValue(current);
        setError(null);
        onOpenChange(next);
      }}
      title={`Change ${def?.name ?? 'stage'} assignment`}
      description="Applies to this task only, from the next time this stage starts."
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={command.isPending}
            disabled={!value.agentId}
            onClick={() =>
              command.mutate(
                { command: 'assignments', body: { stageKey, ...value } },
                {
                  onSuccess: () => {
                    toast(`${def?.name} assignment updated`);
                    onOpenChange(false);
                  },
                  onError: (err) => setError(errorMessage(err)),
                },
              )
            }
          >
            Save assignment
          </Button>
        </>
      }
    >
      <AssignmentPicker label={def?.name ?? 'Stage'} value={value} onChange={setValue} />
      {error ? <p role="alert" className="mt-3 text-body text-danger">{error}</p> : null}
    </Dialog>
  );
}

export function CancelTaskDialog({ task, open, onOpenChange }: { task: TaskDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const command = useTaskCommand(task.id);
  const { toast } = useFeedback();
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title={`Cancel ${task.id}?`}
      description="The running stage is stopped and the task cannot be resumed. Files already changed stay in the working tree for you to review."
      confirmLabel={`Cancel ${task.id}`}
      cancelLabel="Keep running"
      busy={command.isPending}
      onConfirm={() =>
        command.mutate(
          { command: 'cancel' },
          {
            onSuccess: () => {
              toast(`${task.id} cancelled`, 'info');
              onOpenChange(false);
            },
            onError: (err) => setError(errorMessage(err)),
          },
        )
      }
    >
      {error ? <p role="alert" className="text-body text-danger">{error}</p> : null}
    </ConfirmDialog>
  );
}
