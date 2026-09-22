import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROLES, type PromptTemplate, type Role } from '@acc/shared';
import type { Store } from '../store/store.js';

/** Used for roles without a template file (e.g. deployer, reporter). */
export const GENERIC_TEMPLATE = `You are the **{{role}}** for task {{task_id}} in the repository "{{repository_name}}" ({{repository_path}}).

## Request

{{request}}

## Plan

{{plan}}

## User directives

{{directives}}

Inspect the repository before acting and never overwrite unrelated uncommitted work. Report what you did in Markdown.`;

/**
 * Versioned prompt templates (PLAN §18). Every edit creates a new version;
 * tasks record which version each role used. Built-in templates are seeded
 * from `prompts/*.md` and refreshed only while the user has not edited them.
 */
export class PromptService {
  constructor(
    private readonly store: Store,
    private readonly dir: string,
  ) {}

  private fileBody(role: Role): string | null {
    const file = path.join(this.dir, `${role}.md`);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  seed(): void {
    for (const role of ROLES) {
      const body = this.fileBody(role);
      if (!body) continue;
      const latest = this.store.latestPrompt(role);
      if (!latest || (latest.builtin && latest.body !== body)) this.store.insertPrompt(role, body, true);
    }
  }

  list(): PromptTemplate[] {
    return this.store.listLatestPrompts();
  }

  get(role: Role): PromptTemplate {
    return this.store.latestPrompt(role) ?? { role, version: 0, body: GENERIC_TEMPLATE, updatedAt: new Date(0).toISOString(), builtin: true };
  }

  update(role: Role, body: string): PromptTemplate {
    return this.store.insertPrompt(role, body, false);
  }

  reset(role: Role): PromptTemplate {
    return this.store.insertPrompt(role, this.fileBody(role) ?? GENERIC_TEMPLATE, true);
  }
}
