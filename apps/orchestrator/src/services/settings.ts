import { settingsSchema, updateSettingsSchema, type RoleAssignments, type Settings, type UpdateSettingsInput } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { Store } from '../store/store.js';

/** PLAN §1 example defaults: Codex investigates, plans and reviews; Claude Code implements and fixes. */
export const DEFAULT_ROLE_DEFAULTS: RoleAssignments = {
  investigator: { agentId: 'codex', model: 'default', effort: 'medium' },
  planner: { agentId: 'codex', model: 'default', effort: 'high' },
  implementer: { agentId: 'claude', model: 'default', effort: 'high' },
  tester: { agentId: 'claude', model: 'default', effort: 'medium' },
  reviewer: { agentId: 'codex', model: 'default', effort: 'high' },
  fixer: { agentId: 'claude', model: 'default', effort: 'high' },
  verifier: { agentId: 'codex', model: 'default', effort: 'medium' },
  deployer: { agentId: 'claude', model: 'default', effort: 'medium' },
  reporter: { agentId: 'claude', model: 'default', effort: 'low' },
};

const KEY = 'settings';

export class SettingsService {
  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly roleDefaults: RoleAssignments = DEFAULT_ROLE_DEFAULTS,
  ) {}

  get(): Settings {
    const stored = this.store.getSetting<Partial<Settings>>(KEY) ?? {};
    const parsed = settingsSchema.safeParse({ roleDefaults: this.roleDefaults, ...stored });
    if (parsed.success) {
      // Roles added after the settings were first saved inherit the defaults.
      return { ...parsed.data, roleDefaults: { ...this.roleDefaults, ...parsed.data.roleDefaults } };
    }
    return settingsSchema.parse({ roleDefaults: this.roleDefaults });
  }

  update(patch: UpdateSettingsInput): Settings {
    const valid = updateSettingsSchema.parse(patch);
    const next = settingsSchema.parse({ ...this.get(), ...valid });
    this.store.setSetting(KEY, next);
    this.bus.publish({ type: 'settings', settings: next });
    return next;
  }
}
