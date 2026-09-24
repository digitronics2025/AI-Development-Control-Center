import type { SkillCatalogView, SkillInfo } from '@acc/shared';
import { mergeSkills } from '@acc/agent-sdk';
import type { AgentRegistry } from './agents.js';

/** How long a repository's list is reused: the picker opens often, skills change rarely. */
const TTL_MS = 60_000;

/**
 * The skills the enabled agents would load in a repository
 * (docs/systems/agents.md#skills). Feeds the New Task slash picker and the
 * "Requested skills" prompt section. Each agent's list is cached per
 * repository and per its own settings, so switching "Load my CLI
 * customisations" shows the new list at once. An agent that fails to list
 * contributes nothing rather than failing the whole catalog.
 */
export class SkillCatalog {
  private readonly cache = new Map<string, { at: number; skills: Promise<SkillInfo[]> }>();

  constructor(
    private readonly agents: AgentRegistry,
    private readonly ttlMs = TTL_MS,
  ) {}

  async list(repositoryPath: string): Promise<SkillCatalogView> {
    const listed: string[] = [];
    const lists: SkillInfo[][] = [];
    for (const agent of this.agents.list()) {
      if (!agent.settings.enabled) continue;
      const adapter = this.agents.adapter(agent.id);
      if (!adapter.listSkills) continue;
      listed.push(agent.id);
      lists.push(await this.forAgent(agent.id, repositoryPath));
    }
    return { agents: listed, skills: mergeSkills(...lists) };
  }

  /** Names only, for matching `/name` tokens in a task description. */
  async names(repositoryPath: string): Promise<Set<string>> {
    return new Set((await this.list(repositoryPath)).skills.map((s) => s.name));
  }

  private forAgent(agentId: string, repositoryPath: string): Promise<SkillInfo[]> {
    const options = this.agents.runtimeOptions(agentId);
    const key = JSON.stringify([agentId, repositoryPath, options.loadUserConfig !== false, options.executablePath ?? null]);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.skills;
    const skills = this.agents
      .adapter(agentId)
      .listSkills!(options, repositoryPath)
      .catch(() => {
        this.cache.delete(key);
        return [] as SkillInfo[];
      });
    this.cache.set(key, { at: Date.now(), skills });
    return skills;
  }
}
