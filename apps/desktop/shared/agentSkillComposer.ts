export type AgentSkillMenuSkill = {
  id: string;
  stableId: string;
  title: string;
  description: string;
  scope: 'builtin' | 'user' | 'novel';
  version: string;
  revisionId: string;
  enabled: boolean;
};

export type AgentSkillComposerMode =
  | { kind: 'skill.use'; skill: AgentSkillMenuSkill }
  | { kind: 'skill.author' }
  | { kind: 'skill.none' };

export type AgentSkillSlashQuery = {
  start: number;
  end: number;
  query: string;
};

export type AgentSkillMenuItem =
  | { kind: 'skill'; skill: AgentSkillMenuSkill }
  | { kind: 'author'; id: 'skill.author' }
  | { kind: 'none'; id: 'skill.none' };

export function findAgentSkillSlashQuery(input: string, cursor = input.length): AgentSkillSlashQuery | null {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  const prefix = input.slice(0, safeCursor);
  const match = prefix.match(/(?:^|\s)\/([^\s/]*)$/u);
  if (!match || match.index === undefined) return null;
  const slashOffset = match[0].lastIndexOf('/');
  return {
    start: match.index + slashOffset,
    end: safeCursor,
    query: match[1] ?? '',
  };
}

export function removeAgentSkillSlashQuery(input: string, query: AgentSkillSlashQuery): string {
  return `${input.slice(0, query.start)}${input.slice(query.end)}`;
}

export function shouldOpenAgentSkillSlashMenu(
  query: AgentSkillSlashQuery | null,
  dismissedQuery: AgentSkillSlashQuery | null,
): boolean {
  return Boolean(query && query !== dismissedQuery);
}

export function agentSkillShortcutSeed(skillId: string): string {
  if (skillId === 'builtin.novel-bootstrap') return '新建小说';
  if (skillId === 'builtin.style-skill-extractor') return '根据当前选择的小说样本，提炼文风 Skill Pack';
  return '';
}

export function filterAgentSkillEntries<T extends AgentSkillMenuSkill>(skills: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return skills
    .filter((skill) => skill.enabled)
    .filter((skill) => {
      if (!normalizedQuery) return true;
      return [skill.title, skill.description, skill.stableId]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => {
      const scopeRank = { builtin: 0, novel: 1, user: 2 } as const;
      return scopeRank[left.scope] - scopeRank[right.scope]
        || left.title.localeCompare(right.title, 'zh-CN');
    });
}

export function buildAgentSkillMenuItems<T extends AgentSkillMenuSkill>(skills: T[], query: string): AgentSkillMenuItem[] {
  return [
    { kind: 'author', id: 'skill.author' },
    { kind: 'none', id: 'skill.none' },
    ...filterAgentSkillEntries(skills, query).map((skill) => ({ kind: 'skill' as const, skill })),
  ];
}

export function agentSkillEntryHint(mode: AgentSkillComposerMode | undefined): Record<string, string> | undefined {
  if (!mode) return undefined;
  if (mode.kind === 'skill.author') {
    return { actionId: 'skill.author', kind: 'skill.author' };
  }
  if (mode.kind === 'skill.none') {
    return { actionId: 'skill.none', kind: 'skill.none' };
  }
  return {
    actionId: 'skill.use',
    kind: 'skill.use',
    skillId: mode.skill.id,
    requestedRevisionId: mode.skill.revisionId,
  };
}
