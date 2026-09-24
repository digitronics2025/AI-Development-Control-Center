import { useCallback, useMemo } from 'react';
import type { SlashOption } from '@acc/ui';
import { filterSkills, requestedSkills, type SkillInfo } from '@acc/shared';
import { useSkills } from '../api/hooks';

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  project: 'Repository',
  user: 'Yours',
  builtin: 'Claude Code',
  plugin: 'Plugin',
};

/**
 * Everything a text box that reaches agents needs for the `/` skill picker
 * (design.md §8.3): props for `SlashTextarea` and the skills the text requests,
 * using the same parser the orchestrator uses for the prompt.
 */
export function useSkillPicker(repositoryId: string | undefined, text: string) {
  const skills = useSkills(repositoryId);
  const catalog = useMemo(() => skills.data?.skills ?? [], [skills.data]);
  const suggest = useCallback(
    (query: string): SlashOption[] =>
      filterSkills(catalog, query).map((skill) => ({
        value: skill.name,
        label: `/${skill.name}`,
        description: skill.description ?? undefined,
        detail: skill.source === 'plugin' ? (skill.plugin ?? SOURCE_LABEL.plugin) : SOURCE_LABEL[skill.source],
      })),
    [catalog],
  );
  const requested = useMemo(() => requestedSkills(text, new Set(catalog.map((s) => s.name))), [text, catalog]);
  return {
    available: catalog.length > 0,
    requested,
    textareaProps: { suggest, total: catalog.length, loading: skills.isLoading, listLabel: 'Skills', loadingText: 'Loading skills…', emptyText: 'No skill matches' },
  };
}

/** The line under a field naming the skills its text requests, so a typo shows. */
export function RequestedSkills({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <span className="block" data-testid="requested-skills">
      Skills requested: {names.map((name) => `/${name}`).join(', ')}
    </span>
  );
}
