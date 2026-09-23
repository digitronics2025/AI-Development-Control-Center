import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateWorkflow, type WorkflowIssue, type WorkflowProfile } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { Store } from '../store/store.js';

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID' | 'READ_ONLY' | 'DUPLICATE',
    readonly issues: WorkflowIssue[] = [],
  ) {
    super(message);
  }
}

function stable(profile: WorkflowProfile): string {
  const { version: _v, builtin: _b, ...rest } = profile;
  return JSON.stringify(rest);
}

/**
 * Workflow profiles are data (PLAN §12–13). Built-ins ship as YAML in
 * `workflows/` and are read-only; users duplicate them to customise. Every
 * task stores a snapshot of its profile, so editing or deleting a profile
 * never changes a task that already exists.
 */
export class WorkflowService {
  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
  ) {}

  loadBuiltins(dir: string): { loaded: string[]; errors: string[] } {
    const loaded: string[] = [];
    const errors: string[] = [];
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    } catch (error) {
      return { loaded, errors: [`Cannot read ${dir}: ${(error as Error).message}`] };
    }
    for (const file of files.sort()) {
      try {
        const raw = parseYaml(readFileSync(path.join(dir, file), 'utf8'));
        const { profile, issues } = validateWorkflow({ ...raw, builtin: true });
        if (!profile) {
          errors.push(`${file}: ${issues.map((i) => i.message).join('; ')}`);
          continue;
        }
        const current = this.store.getWorkflow(profile.id);
        if (current && !current.builtin) {
          errors.push(`${file}: a custom workflow already uses id "${profile.id}"`);
          continue;
        }
        if (!current || stable(current) !== stable(profile)) {
          this.store.saveWorkflow({ ...profile, builtin: true, version: (current?.version ?? 0) + 1 });
        }
        loaded.push(profile.id);
      } catch (error) {
        errors.push(`${file}: ${(error as Error).message}`);
      }
    }
    return { loaded, errors };
  }

  list(): WorkflowProfile[] {
    return this.store.listWorkflows();
  }

  get(id: string): WorkflowProfile {
    const wf = this.store.getWorkflow(id);
    if (!wf) throw new WorkflowError(`Workflow "${id}" not found`, 'NOT_FOUND');
    return wf;
  }

  validate(input: unknown): { profile: WorkflowProfile | null; issues: WorkflowIssue[] } {
    return validateWorkflow(input);
  }

  save(id: string, input: unknown): WorkflowProfile {
    const existing = this.store.getWorkflow(id);
    if (existing?.builtin) {
      throw new WorkflowError('Built-in workflows are read-only. Duplicate it to customise.', 'READ_ONLY');
    }
    const { profile, issues } = validateWorkflow({ ...(input as object), id, builtin: false });
    if (!profile) throw new WorkflowError('The workflow has validation errors', 'INVALID', issues);
    const saved: WorkflowProfile = { ...profile, builtin: false, version: (existing?.version ?? 0) + 1 };
    this.store.saveWorkflow(saved);
    this.bus.publish({ type: 'workflow', workflow: saved });
    return saved;
  }

  duplicate(id: string, name?: string): WorkflowProfile {
    const source = this.get(id);
    const taken = new Set(this.store.listWorkflows().map((w) => w.id));
    let newId = `${source.id}-copy`.slice(0, 60);
    for (let n = 2; taken.has(newId); n++) newId = `${source.id}-copy-${n}`.slice(0, 64);
    const copy: WorkflowProfile = { ...source, id: newId, name: (name ?? `${source.name} (copy)`).slice(0, 60), builtin: false, version: 1 };
    this.store.saveWorkflow(copy);
    this.bus.publish({ type: 'workflow', workflow: copy });
    return copy;
  }

  remove(id: string): void {
    const wf = this.get(id);
    if (wf.builtin) throw new WorkflowError('Built-in workflows cannot be deleted', 'READ_ONLY');
    this.store.deleteWorkflow(id);
    this.bus.publish({ type: 'workflow.deleted', workflowId: id });
  }
}
