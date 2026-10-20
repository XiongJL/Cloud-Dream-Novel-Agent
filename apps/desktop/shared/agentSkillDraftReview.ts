export type SkillDraftReviewRecord = {
  id: string;
  version: number;
  status: 'editing' | 'ready_for_review' | 'committed' | 'discarded';
  action?: 'create' | 'update' | 'derive' | 'pack';
  scope?: 'user' | 'novel';
  sourceNovelId?: string;
  committedPackRevisionId?: string;
  committedSkillId?: string;
  committedPackId?: string;
  publicationScope?: 'novel' | 'user';
  publicationOwnerNovelId?: string;
  publicationVersion?: number;
  currentVisibility?: {scope: 'novel' | 'user'; ownerNovelId?: string | null; visibilityVersion: number};
  draft?: Record<string, unknown>;
  derivationReport?: Record<string, unknown>;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Notices predating the review card contain only this ID. Recover their persisted documents too.
export function skillDraftIdFromNotice(message: { role: string; kind?: string; content: string; skillDraftId?: string }): string | null {
  if (message.role !== 'assistant' || message.kind !== 'workflow_notice') return null;
  if (message.skillDraftId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(message.skillDraftId)) return message.skillDraftId;
  if (!/Skill/iu.test(message.content)) return null;
  return /草稿\s*ID\s*[：:]\s*`?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/iu.exec(message.content)?.[1] ?? null;
}

function frontmatterParts(content: string): { fields: string[]; body: string } {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { fields: [], body: content };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return { fields: lines.slice(1, end < 0 ? undefined : end), body: end < 0 ? '' : lines.slice(end + 1).join('\n').trim() };
}

function scalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return String(JSON.parse(value)); } catch { return value.slice(1, -1); }
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}

function frontmatterText(content: string, field: string): string {
  const match = frontmatterParts(content).fields.find((line) => line.startsWith(`${field}:`));
  const value = match?.slice(field.length + 1).trim() || '';
  return scalar(value);
}

function frontmatterList(content: string, field: string): string[] | undefined {
  const fields = frontmatterParts(content).fields;
  const index = fields.findIndex((line) => line.startsWith(`${field}:`));
  if (index < 0) return undefined;
  const inline = fields[index].slice(field.length + 1).trim();
  if (inline.startsWith('[') && inline.endsWith(']')) {
    try { return (JSON.parse(inline) as unknown[]).map(String); } catch { return inline.slice(1, -1).split(',').map((value) => scalar(value.trim())).filter(Boolean); }
  }
  const values: string[] = [];
  for (let cursor = index + 1; cursor < fields.length && /^\s/.test(fields[cursor]); cursor += 1) {
    const match = /^\s+-\s*(.*)$/.exec(fields[cursor]);
    if (match) values.push(scalar(match[1].trim()));
  }
  return values;
}

const CATEGORY_LABELS: Record<string, string> = { style: '文风', narrative_method: '叙事方法', generation: '内容生成', review: '审校', character_voice: '人物声音', novel_rules: '小说规则', other: '其他' };
const OPERATION_LABELS: Record<string, string> = {
  'project.lookup': '查询小说资料', 'novel.bootstrap': '新建小说方案', 'novel.project_initialize': '初始化小说项目',
  'agent_skill.style_extract': '提炼文风', 'chapter.context': '整理章节上下文', 'chapter.scope_context': '整理多章上下文',
  'chapter.consistency_review': '检查章节一致性', 'writer.range_revision_plan': '制定多章修订计划', 'editor.range_review': '审校多章',
  'chapter.continuation': '续写章节', 'chapter.sequence_continuation': '连续续写多章', 'chapter.create': '新增章节',
  'chapter.batch_rewrite': '批量改写多章', 'chapter.rewrite': '改写章节', 'creative_asset.draft': '生成创作素材',
  'plotline.analysis': '分析情节与伏笔', 'reader.feedback': '读者反馈', 'reader.journey_review': '读者顺序盲测',
  'worldbuilding.range_consistency': '检查世界观一致性', 'research.fact_check': '事实核查', 'research.range_fact_check': '多章事实核查',
  'novel.scope_audit': '综合审查小说',
};

export function projectSkillDraftReview(record: SkillDraftReviewRecord) {
  const draft = object(record.draft);
  const definition = object(draft.definition);
  const revision = object(draft.revision);
  const manifest = object(revision.manifest);
  const pack = object(draft.pack);
  const packDefinition = object(pack.definition);
  const authoring = object(draft.authoring);
  const validation = object(authoring.validationReport);
  const documents = (Array.isArray(authoring.documents) ? authoring.documents : [])
    .map(object)
    .filter((document) => !document.deleted && typeof document.contentText === 'string')
    .map((document) => ({ path: String(document.logicalPath || 'SKILL.md'), content: String(document.contentText) }));
  const mainDocument = documents.find((document) => document.path === 'SKILL.md')?.content || '';
  const projections = Array.isArray(draft.skills) ? draft.skills.map(object) : [];
  const ruleDocuments = documents.filter((document) => /(^|\/)SKILL\.md$/.test(document.path));
  const rules = ruleDocuments.map((document) => {
    const projection = projections.find((skill) => skill.draftKey === document.path.split('/')[0]);
    const memberRevision = record.action === 'pack' ? object(projection?.revision) : revision;
    const memberManifest = object(memberRevision.manifest);
    const operations = frontmatterList(document.content, 'supportedOperations')
      ?? (Array.isArray(memberManifest.supportedOperations) ? memberManifest.supportedOperations.map(String) : []);
    return {
      path: document.path,
      title: frontmatterText(document.content, 'title') || frontmatterText(document.content, 'name') || String(object(projection?.definition).title || definition.title || '未命名 Skill'),
      description: frontmatterText(document.content, 'description') || String(object(projection?.definition).description || definition.description || ''),
      instructions: frontmatterParts(document.content).body,
      constraints: frontmatterList(document.content, 'constraints') ?? (Array.isArray(memberRevision.constraints) ? memberRevision.constraints.map(String) : []),
      examples: Array.isArray(memberRevision.examples) ? memberRevision.examples : [],
      categoryLabel: CATEGORY_LABELS[frontmatterText(document.content, 'category') || String(memberManifest.category || '')] || '其他',
      operationLabels: [...new Set(operations.map((operation) => OPERATION_LABELS[operation] || '其他任务'))],
    };
  });
  if (rules.length === 0 && record.action !== 'pack') rules.push({
    path: 'SKILL.md', title: String(definition.title || '未命名 Skill'), description: String(definition.description || ''),
    instructions: String(revision.instructions || ''), constraints: Array.isArray(revision.constraints) ? revision.constraints.map(String) : [],
    examples: Array.isArray(revision.examples) ? revision.examples : [], categoryLabel: CATEGORY_LABELS[String(manifest.category || '')] || '其他',
    operationLabels: [...new Set((Array.isArray(manifest.supportedOperations) ? manifest.supportedOperations.map(String) : []).map((operation) => OPERATION_LABELS[operation] || '其他任务'))],
  });
  const diagnostics = (Array.isArray(validation.diagnostics) ? validation.diagnostics : []).map(object).map((item) => ({
    code: String(item.code || ''),
    severity: item.severity === 'warning' ? 'warning' as const : 'error' as const,
    path: String(item.path || ''),
    message: String(item.message || '校验未通过'),
    line: typeof item.line === 'number' ? item.line : undefined,
    suggestion: typeof item.suggestion === 'string' ? item.suggestion : undefined,
  }));
  const hasAuthoring = Object.keys(authoring).length > 0;
  const editable = record.status === 'editing' || record.status === 'ready_for_review';
  const hashesMatch = typeof authoring.authoringInputHash === 'string'
    && Boolean(authoring.authoringInputHash)
    && authoring.authoringInputHash === authoring.validatedInputHash
    && authoring.authoringInputHash === authoring.compiledInputHash;
  const derivation = object(record.derivationReport);
  const qualityRequired = derivation.qualityRequired === true || (derivation.qualityRequired !== false
    && derivation.kind === 'style_skill_pack_extraction' && Number(object(derivation.sourceCoverage).chapterCount) > 0);
  const qualityReview = object(draft.styleQualityReview);
  const qualityPassed = !qualityRequired || (qualityReview.status === 'passed' && qualityReview.inputHash === authoring.authoringInputHash);
  const canPublish = editable && qualityPassed && (!hasAuthoring || (
    record.status === 'ready_for_review' && authoring.phase === 'compiled'
    && validation.ok === true && diagnostics.every((item) => item.severity !== 'error') && hashesMatch
  ));
  return {
    qualityRequired,
    qualityPassed,
    title: String(record.action === 'pack' ? packDefinition.title || pack.title || 'Skill 草稿'
      : frontmatterText(mainDocument, 'title') || frontmatterText(mainDocument, 'name') || definition.title || 'Skill 草稿'),
    description: String(record.action === 'pack' ? packDefinition.description || pack.description || ''
      : frontmatterText(mainDocument, 'description') || definition.description || ''),
    instructions: rules[0]?.instructions || '',
    constraints: rules[0]?.constraints || [],
    examples: rules[0]?.examples || [],
    rules,
    references: documents.filter((document) => !/(^|\/)SKILL\.md$/.test(document.path)),
    scopeLabel: record.scope === 'novel' ? '当前小说专属' : '我的技能库',
    categoryLabel: record.action === 'pack' ? 'Skill 组合' : rules[0]?.categoryLabel || '其他',
    operationLabels: [...new Set(rules.flatMap((rule) => rule.operationLabels))],
    formatRepaired: Array.isArray(authoring.repairs) && authoring.repairs.length > 0,
    authorQuestions: diagnostics.filter((item) => item.severity === 'error').flatMap((item) => {
      if (/TITLE/.test(item.code)) return ['请为这套规则填写一个简短名称。'];
      if (/DESCRIPTION/.test(item.code)) return ['请补充一句说明，描述这套规则的用途。'];
      if (/INSTRUCTIONS/.test(item.code)) return ['请补充技能内容，例如规则、步骤或方法，正文需控制在约三万字以内。'];
      if (/CONSTRAINTS/.test(item.code)) return ['请将附加限制整理为最多 24 项。'];
      if (/OPERATIONS|PACK_BINDING/.test(item.code)) return ['请补充这套规则用于什么任务，例如续写、改写或审校。'];
      return [];
    }),
    documents,
    diagnostics,
    hasAuthoring,
    editable,
    canPublish,
    validationOk: validation.ok === true,
    isPack: record.action === 'pack',
  };
}

export type SkillDraftPrepareResult = {
  draft: SkillDraftReviewRecord;
  validationReport?: Record<string, unknown>;
  repairs?: Array<{ code: string; path: string; message: string }>;
};

// Shared by the chat and artifact cards. Remember the returned version even when content
// still needs attention, so reloads never turn preparation into an automatic loop.
export function createSkillDraftPreparationCoordinator() {
  const attempted = new Set<string>();
  const inFlight = new Map<string, Promise<SkillDraftPrepareResult>>();
  const completed = new Map<string, SkillDraftPrepareResult>();
  const key = (draft: SkillDraftReviewRecord) => `${draft.id}:${draft.version}`;
  return {
    remember(draft: SkillDraftReviewRecord) { attempted.add(key(draft)); },
    prepare(draft: SkillDraftReviewRecord, invoke: () => Promise<SkillDraftPrepareResult>, force = false): Promise<SkillDraftPrepareResult | null> {
      const draftKey = key(draft);
      const view = projectSkillDraftReview(draft);
      if (!view.editable) return Promise.resolve(null);
      const existing = inFlight.get(draftKey);
      if (existing) return existing;
      const previous = completed.get(draftKey);
      if (previous && !force) return Promise.resolve(previous);
      if (!force && (attempted.has(draftKey) || (draft.status !== 'editing' && view.canPublish))) return Promise.resolve(null);
      attempted.add(draftKey);
      const promise = Promise.resolve().then(invoke).then((result) => {
        attempted.add(key(result.draft)); completed.set(draftKey, result); inFlight.delete(draftKey); return result;
      }, (error) => { inFlight.delete(draftKey); throw error; });
      inFlight.set(draftKey, promise);
      return promise;
    },
  };
}
