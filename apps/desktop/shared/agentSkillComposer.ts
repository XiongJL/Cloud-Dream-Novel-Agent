export type AgentSkillMenuSkill = {
  id: string;
  stableId: string;
  title: string;
  description: string;
  scope: 'builtin' | 'user' | 'novel';
  version: string;
  revisionId: string;
  enabled: boolean;
  supportedOperations?: string[];
  allowedRoles?: string[];
};

export type AgentSkillMenuPack = AgentSkillMenuSkill & {
  ownerNovelId?: string;
  schemaVersion?: number;
  entryType: 'pack'; available: boolean; unavailableReason?: string;
  members: Array<{memberKey: string; title: string; slot: string}>;
};

export type AgentSkillComposerMode =
  | { kind: 'skill.use'; skill: AgentSkillMenuSkill; additionalSkills?: AgentSkillMenuSkill[]; publicationScope?: 'novel' | 'user' }
  | { kind: 'skill.pack.use'; pack: AgentSkillMenuPack; auxiliaryMode: 'default' | 'none' | 'member'; auxiliaryMemberKey?: string }
  | { kind: 'skill.author'; publicationScope?: 'novel' | 'user' }
  | { kind: 'skill.none' };

export type AgentSkillSlashQuery = {
  start: number;
  end: number;
  query: string;
};

export type AgentSkillMenuItem =
  | { kind: 'skill'; skill: AgentSkillMenuSkill }
  | { kind: 'pack'; pack: AgentSkillMenuPack }
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

export function buildAgentSkillMenuItems<T extends AgentSkillMenuSkill>(skills: T[], query: string, packs: AgentSkillMenuPack[] = []): AgentSkillMenuItem[] {
  return [
    { kind: 'author', id: 'skill.author' },
    { kind: 'none', id: 'skill.none' },
    ...(['builtin', 'novel', 'user'] as const).flatMap(scope => [
      ...filterAgentSkillEntries(packs, query).filter(pack => pack.available && pack.scope === scope).map(pack => ({ kind: 'pack' as const, pack })),
      ...filterAgentSkillEntries(skills, query).filter(skill => skill.scope === scope).map(skill => ({ kind: 'skill' as const, skill })),
    ]),
  ];
}

export function selectedAgentSkills(mode: AgentSkillComposerMode | undefined): AgentSkillMenuSkill[] {
  return mode?.kind === 'skill.use' ? [mode.skill, ...(mode.additionalSkills || [])] : [];
}

export function removeSelectedAgentSkill(mode: AgentSkillComposerMode | undefined, skillId: string): AgentSkillComposerMode | undefined {
  if (mode?.kind !== 'skill.use') return mode;
  const remaining = selectedAgentSkills(mode).filter(skill => skill.id !== skillId);
  return remaining.length ? {...mode, skill: remaining[0], additionalSkills: remaining.slice(1)} : undefined;
}

export function selectAgentSkillMode(mode: AgentSkillComposerMode | undefined, item: AgentSkillMenuItem): AgentSkillComposerMode | undefined {
  if (item.kind === 'none') return {kind: 'skill.none'};
  if (item.kind === 'author') return {kind: 'skill.author'};
  if (item.kind === 'pack') return {kind: 'skill.pack.use', pack: item.pack, auxiliaryMode: 'default'};
  if (selectedAgentSkills(mode).some(skill => skill.id === item.skill.id)) return removeSelectedAgentSkill(mode, item.skill.id);
  const selected = [...selectedAgentSkills(mode), item.skill];
  const publicationScope = mode?.kind === 'skill.use' ? mode.publicationScope : undefined;
  return {kind: 'skill.use', skill: selected[0], additionalSkills: selected.slice(1),
    ...(publicationScope ? {publicationScope} : item.skill.id === 'builtin.style-skill-extractor' ? {publicationScope: 'novel'} : {})};
}

export function agentSkillEntryHint(mode: AgentSkillComposerMode | undefined): Record<string, unknown> | undefined {
  if (!mode) return undefined;
  if (mode.kind === 'skill.pack.use') return { actionId: 'skill.pack.use', kind: 'skill.pack.use', packId: mode.pack.id,
    requestedPackRevisionId: mode.pack.revisionId, auxiliaryMode: mode.auxiliaryMode,
    ...(mode.auxiliaryMemberKey ? { auxiliaryMemberKey: mode.auxiliaryMemberKey } : {}) };
  if (mode.kind === 'skill.author') {
    return { actionId: 'skill.author', kind: 'skill.author', ...(mode.publicationScope ? {publicationScope: mode.publicationScope} : {}) };
  }
  if (mode.kind === 'skill.none') {
    return { actionId: 'skill.none', kind: 'skill.none' };
  }
  if (selectedAgentSkills(mode).length > 1) return {
    actionId: 'skill.use', kind: 'skill.use',
    skills: selectedAgentSkills(mode).map(skill => ({skillId: skill.id, requestedRevisionId: skill.revisionId})),
    ...(mode.publicationScope ? {publicationScope: mode.publicationScope} : {}),
  };
  return {
    actionId: 'skill.use',
    kind: 'skill.use',
    skillId: mode.skill.id,
    requestedRevisionId: mode.skill.revisionId,
    ...(mode.publicationScope ? {publicationScope: mode.publicationScope} : {}),
  };
}
