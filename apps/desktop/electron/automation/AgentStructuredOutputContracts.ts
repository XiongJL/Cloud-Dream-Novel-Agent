export type AgentStructuredOutputContract = {
    contractId: string;
    version: string;
    schema: Record<string, unknown>;
};

const objectSchema = (
    properties: Record<string, unknown>,
    required: string[] = [],
): Record<string, unknown> => ({
    type: 'object',
    properties,
    required,
    additionalProperties: true,
});

const stringArray = { type: 'array', items: { type: 'string' } };
const nullableObject = { type: ['object', 'null'] };
const nullableString = { type: ['string', 'null'] };

const styleSkillMemberPlanSchema = objectSchema({
    draftKey: { type: 'string', enum: ['language_style', 'suspense_release', 'ensemble_progression'] },
    stableIdCandidate: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$', maxLength: 64 },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: 1000 },
    guidanceMode: { type: 'string', enum: ['adaptive', 'guided', 'strict'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    triggerHints: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    antiTriggerHints: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    supportedOperations: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    constraints: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
    methodDimensions: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 12 },
    evidenceNotes: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    contaminationWarnings: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    evaluationPrompt: { type: 'string', minLength: 1, maxLength: 2000 },
}, [
    'draftKey', 'stableIdCandidate', 'title', 'description', 'guidanceMode', 'confidence',
    'triggerHints', 'antiTriggerHints', 'supportedOperations', 'constraints', 'methodDimensions',
    'evaluationPrompt',
]);

const styleSkillPackPlanBindingSchema = objectSchema({
    operationId: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$', maxLength: 120 },
    roleId: { type: 'string', enum: ['team', 'writer', 'editor', 'reader', 'worldbuilding', 'research_rag'] },
    primaryDraftKey: { type: 'string', enum: ['language_style', 'suspense_release', 'ensemble_progression'] },
    auxiliaryDraftKey: {
        type: ['string', 'null'],
        enum: ['language_style', 'suspense_release', 'ensemble_progression', null],
    },
}, ['operationId', 'roleId', 'primaryDraftKey']);

const styleSkillPackPlanSchema = objectSchema({
    stableIdCandidate: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$', maxLength: 64 },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: 1000 },
    bindings: { type: 'array', items: styleSkillPackPlanBindingSchema, minItems: 1, maxItems: 20 },
}, ['stableIdCandidate', 'title', 'description', 'bindings']);

const agentUserInputOptionSchema = objectSchema({
    optionId: { type: 'string', minLength: 1, maxLength: 80 },
    label: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    evidenceIds: stringArray,
}, ['optionId', 'label', 'description']);

const agentUserInputQuestionSchema = objectSchema({
    questionId: { type: 'string', minLength: 1, maxLength: 80 },
    header: { type: 'string', minLength: 1, maxLength: 24 },
    prompt: { type: 'string', minLength: 1, maxLength: 500 },
    options: { type: 'array', items: agentUserInputOptionSchema, minItems: 2, maxItems: 3 },
    recommendedOptionId: { type: 'string', minLength: 1, maxLength: 80 },
    recommendationReason: { type: 'string', minLength: 1, maxLength: 500 },
    evidenceIds: stringArray,
    allowCustom: { type: 'boolean' },
}, ['questionId', 'header', 'prompt', 'options', 'recommendedOptionId', 'recommendationReason']);

const agentChatInputRequestSchema = {
    ...objectSchema({
        title: { type: 'string', minLength: 1, maxLength: 120 },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
        questions: { type: 'array', items: agentUserInputQuestionSchema, minItems: 1, maxItems: 3 },
    }, ['title', 'reason', 'questions']),
    type: ['object', 'null'],
};

const agentPlanStepSchema = objectSchema({
    agent: { type: 'string', enum: ['supervisor', 'writer', 'editor', 'reader', 'worldbuilding', 'research_rag'] },
    title: { type: 'string', minLength: 1 },
    tools: stringArray,
    toolchain: nullableObject,
}, ['agent', 'title', 'tools']);

const novelBootstrapCharacterSchema = objectSchema({
    name: { type: 'string', minLength: 1, maxLength: 120 },
    role: { type: 'string', minLength: 1, maxLength: 200 },
    desire: { type: 'string', minLength: 1, maxLength: 500 },
    cost: { type: 'string', minLength: 1, maxLength: 500 },
    change: { type: 'string', minLength: 1, maxLength: 500 },
}, ['name', 'role', 'desire', 'cost', 'change']);

const novelBootstrapVolumeSchema = objectSchema({
    title: { type: 'string', minLength: 1, maxLength: 120 },
    dramaticQuestion: { type: 'string', minLength: 1, maxLength: 500 },
    turningPoint: { type: 'string', minLength: 1, maxLength: 500 },
    chapterRange: { type: 'string', minLength: 1, maxLength: 80 },
}, ['title', 'dramaticQuestion', 'turningPoint', 'chapterRange']);

const novelBootstrapChapterSchema = objectSchema({
    chapterNumber: { type: 'integer', minimum: 1, maximum: 999 },
    title: { type: 'string', minLength: 1, maxLength: 160 },
    sceneGoal: { type: 'string', minLength: 1, maxLength: 500 },
    conflict: { type: 'string', minLength: 1, maxLength: 500 },
    hook: { type: 'string', minLength: 1, maxLength: 500 },
}, ['chapterNumber', 'title', 'sceneGoal', 'conflict', 'hook']);

const creativeDirectionOptionSchema = objectSchema({
    optionId: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
}, ['optionId', 'label', 'description']);

const creativeDirectionQuestionSchema = objectSchema({
    questionId: { type: 'string', minLength: 1 },
    header: { type: 'string', minLength: 1 },
    prompt: { type: 'string', minLength: 1 },
    recommendationReason: { type: 'string', minLength: 1 },
    options: { type: 'array', items: creativeDirectionOptionSchema, minItems: 2, maxItems: 3 },
}, ['questionId', 'header', 'prompt', 'recommendationReason', 'options']);

const followupInputRequestSchema = {
    ...objectSchema({
        title: { type: 'string', minLength: 1, maxLength: 120 },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
        questions: { type: 'array', items: creativeDirectionQuestionSchema, minItems: 1, maxItems: 3 },
    }, ['title', 'reason', 'questions']),
    type: ['object', 'null'],
};

const chapterBeatSchema = objectSchema({
    title: { type: 'string', minLength: 1 },
    chapterGoal: { type: 'string', minLength: 1 },
    coreConflict: { type: 'string', minLength: 1 },
    keyEvents: stringArray,
    reveals: stringArray,
    endingHook: { type: 'string', minLength: 1 },
    targetWordCount: { type: 'integer', minimum: 100, maximum: 50000 },
}, ['title', 'chapterGoal', 'coreConflict', 'endingHook', 'targetWordCount']);

const nullableScoreSchema = { type: ['integer', 'null'], minimum: 0, maximum: 100 };
const severitySchema = { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] };
const contextEvidenceSchema = objectSchema({
    sourceType: { type: 'string', minLength: 1 },
    sourceId: nullableString,
    title: { type: 'string' },
    excerpt: { type: 'string' },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    metadata: { type: 'object' },
}, ['sourceType']);
const evidenceArraySchema = { type: 'array', items: contextEvidenceSchema };

const reviewDimensionSchema = objectSchema({
    id: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    score: nullableScoreSchema,
    reason: { type: 'string' },
    checkable: { type: 'boolean' },
}, ['id', 'label']);

const consistencyIssueSchema = objectSchema({
    issueId: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    severity: severitySchema,
    title: { type: 'string', minLength: 1 },
    location: { type: 'string' },
    excerpt: { type: 'string' },
    evidence: evidenceArraySchema,
    recommendation: { type: 'string' },
    uncertainty: { type: 'string' },
}, ['issueId', 'type', 'severity', 'title']);

const editorRangeFindingSchema = objectSchema({
    findingId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    category: { type: 'string', minLength: 1 },
    severity: severitySchema,
    chapterIds: stringArray,
    evidenceRefs: stringArray,
    evidence: evidenceArraySchema,
    recommendation: { type: 'string' },
    recommendedRole: { type: 'string', enum: ['writer', 'editor', 'worldbuilding', 'research_rag'] },
    uncertainty: { type: 'string' },
}, ['findingId', 'title', 'summary', 'category', 'severity']);

const readerFindingSchema = objectSchema({
    findingId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    category: { type: 'string', enum: ['confusion', 'emotion', 'suspense', 'immersion', 'drop_risk', 'retention', 'other'] },
    severity: severitySchema,
    chapterIds: stringArray,
    evidenceRefs: stringArray,
    evidence: evidenceArraySchema,
    recommendation: { type: 'string' },
    recommendedRole: { type: 'string', enum: ['writer', 'editor'] },
    uncertainty: { type: 'string' },
}, ['findingId', 'title', 'summary', 'category', 'severity']);

const worldbuildingFindingSchema = objectSchema({
    findingId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    category: { type: 'string', enum: ['rule_conflict', 'terminology', 'ability', 'location', 'item', 'state_drift', 'chronology', 'other'] },
    severity: severitySchema,
    chapterIds: stringArray,
    subjectIds: stringArray,
    evidenceRefs: stringArray,
    evidence: evidenceArraySchema,
    recommendation: { type: 'string' },
    recommendedRole: { type: 'string', enum: ['writer', 'editor', 'worldbuilding'] },
    uncertainty: { type: 'string' },
}, ['findingId', 'title', 'summary', 'category', 'severity']);

const worldbuildingEntitySchema = objectSchema({
    entityType: { type: 'string', enum: ['worldsetting', 'character', 'item', 'map', 'term', 'other'] },
    entityId: nullableString,
    name: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['consistent', 'conflict', 'insufficient'] },
    chapterIds: stringArray,
    summary: { type: 'string' },
    evidence: evidenceArraySchema,
    uncertainty: { type: 'string' },
}, ['entityType', 'name']);

const researchCategorySchema = { type: 'string', enum: ['historical', 'scientific', 'medical', 'legal', 'technical', 'geographic', 'cultural', 'economic', 'other'] };
const researchClaimSchema = objectSchema({
    claimId: { type: 'string', minLength: 1 },
    statement: { type: 'string', minLength: 1, maxLength: 1000 },
    chapterId: { type: 'string', minLength: 1 },
    excerpt: { type: 'string', maxLength: 2000 },
    category: researchCategorySchema,
    importance: { type: 'string', enum: ['high', 'medium', 'low'] },
    searchKeyword: { type: 'string', maxLength: 200 },
    needsProjectSearch: { type: 'boolean' },
    requiresExternalEvidence: { type: 'boolean' },
}, ['claimId', 'statement', 'chapterId']);

const researchFindingSchema = objectSchema({
    findingId: { type: 'string', minLength: 1 },
    claimId: { type: 'string', minLength: 1 },
    statement: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    verdict: { type: 'string', enum: ['supported', 'contradicted', 'mixed', 'unverified', 'not_applicable'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    category: researchCategorySchema,
    severity: severitySchema,
    chapterIds: stringArray,
    evidenceRefs: stringArray,
    evidence: evidenceArraySchema,
    recommendation: { type: 'string' },
    recommendedRole: { type: 'string', enum: ['writer', 'editor', 'research_rag'] },
    uncertainty: { type: 'string' },
}, ['findingId', 'claimId', 'statement', 'summary', 'verdict', 'severity']);

const scopeAuditExpertSchema = objectSchema({
    expert: { type: 'string', enum: ['editor', 'reader', 'worldbuilding', 'research_rag'] },
    artifactId: { type: 'string', minLength: 1 },
    artifactType: { type: 'string', enum: ['chapter_range_review', 'reader_journey', 'worldbuilding_consistency', 'research_fact_check'] },
    summary: { type: 'string' },
    findingCount: { type: 'integer', minimum: 0 },
}, ['expert', 'artifactId', 'artifactType']);

const scopeAuditFindingSchema = objectSchema({
    findingId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    category: { type: 'string', minLength: 1 },
    severity: severitySchema,
    chapterIds: stringArray,
    sourceFindingIds: stringArray,
    sourceExperts: { type: 'array', items: { type: 'string', enum: ['editor', 'reader', 'worldbuilding', 'research_rag'] } },
    relationship: { type: 'string', enum: ['consensus', 'single', 'conflict'] },
    evidenceRefs: stringArray,
    evidence: evidenceArraySchema,
    recommendation: { type: 'string' },
    recommendedRole: { type: 'string', enum: ['writer', 'editor', 'worldbuilding', 'research_rag'] },
    uncertainty: { type: 'string' },
}, ['findingId', 'title', 'summary', 'category', 'severity']);

const scopeAuditConflictSchema = objectSchema({
    conflictId: { type: 'string', minLength: 1 },
    topic: { type: 'string', minLength: 1 },
    sourceFindingIds: stringArray,
    experts: { type: 'array', items: { type: 'string', enum: ['editor', 'reader', 'worldbuilding', 'research_rag'] } },
    summary: { type: 'string', minLength: 1 },
    resolution: { type: 'string' },
}, ['conflictId', 'topic', 'summary']);

const plotlineThreadSchema = objectSchema({
    plotlineId: nullableString,
    name: { type: 'string', minLength: 1 },
    role: { type: 'string', enum: ['main', 'subplot', 'unknown'] },
    status: { type: 'string' },
    progressionScore: nullableScoreSchema,
    lastProgressLocation: { type: 'string' },
    coveredChapterIds: stringArray,
    findings: stringArray,
    evidence: evidenceArraySchema,
    recommendations: stringArray,
    uncertainty: { type: 'string' },
}, ['name']);

const plotlineIssueSchema = objectSchema({
    issueId: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: ['stalled', 'unresolved_foreshadowing', 'pacing', 'continuity', 'coverage', 'other'] },
    severity: severitySchema,
    title: { type: 'string', minLength: 1 },
    plotlineIds: stringArray,
    chapterIds: stringArray,
    evidence: evidenceArraySchema,
    recommendation: { type: 'string' },
    uncertainty: { type: 'string' },
}, ['issueId', 'type', 'severity', 'title']);

const creativeNamedItemSchema = objectSchema({
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string' },
    role: { type: 'string' },
    type: { type: 'string' },
    content: { type: 'string' },
    color: { type: 'string' },
    icon: { type: 'string' },
    imagePrompt: { type: 'string' },
    imageUrl: { type: 'string' },
    imageBase64: { type: 'string' },
    mimeType: { type: 'string' },
    profile: { type: 'object' },
    points: { type: 'array', items: objectSchema({
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string' },
        type: { type: 'string' },
        status: { type: 'string' },
    }, ['title']) },
}, ['name']);

const creativePlotPointSchema = objectSchema({
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string' },
    type: { type: 'string' },
    status: { type: 'string' },
    plotLineName: { type: 'string' },
}, ['title']);

const creativeAssetsDraftSchema = objectSchema({
    plotLines: { type: 'array', items: creativeNamedItemSchema },
    plotPoints: { type: 'array', items: creativePlotPointSchema },
    characters: { type: 'array', items: creativeNamedItemSchema },
    items: { type: 'array', items: creativeNamedItemSchema },
    skills: { type: 'array', items: creativeNamedItemSchema },
    worldSettings: { type: 'array', items: creativeNamedItemSchema },
    maps: { type: 'array', items: creativeNamedItemSchema },
});

const CONTRACTS: Record<string, AgentStructuredOutputContract> = {
    'creative_assets.generate_draft': {
        contractId: 'creative_assets.draft.response', version: '1.0.0',
        schema: creativeAssetsDraftSchema,
    },
    'creative_assets.revise_draft': {
        contractId: 'creative_assets.revised_draft.response', version: '1.0.0',
        schema: creativeAssetsDraftSchema,
    },
    'outline.generate_draft': {
        contractId: 'creative_assets.outline_draft.response', version: '1.0.0',
        schema: objectSchema({
            plotLines: { type: 'array', items: creativeNamedItemSchema },
            plotPoints: { type: 'array', items: creativePlotPointSchema },
        }, ['plotLines', 'plotPoints']),
    },
    'agent.generate_chat': {
        contractId: 'agent.chat.response', version: '1.0.0',
        schema: objectSchema({
            content: { type: 'string', minLength: 1 }, shouldPlan: { type: 'boolean' },
            needsClarification: { type: 'boolean' },
            requestedOperations: stringArray,
            deliverable: { type: 'string', enum: ['none', 'report', 'expert_report', 'chapter_draft', 'chapter_draft_batch', 'creative_assets_draft'] },
            suggestedRole: { type: 'string', enum: ['team', 'writer', 'editor', 'reader', 'worldbuilding', 'research_rag'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            toolCalls: { type: 'array', items: objectSchema({
                name: { type: 'string', minLength: 1 }, args: { type: 'object' },
            }, ['name', 'args']) },
            inputRequest: agentChatInputRequestSchema,
        }, ['content', 'shouldPlan', 'requestedOperations', 'toolCalls', 'inputRequest']),
    },
    'agent.generate_plan': {
        contractId: 'agent.plan.response', version: '1.0.0',
        schema: objectSchema({
            title: { type: 'string', minLength: 1 },
            deliverable: { type: 'string', enum: ['report', 'expert_report', 'chapter_draft', 'chapter_draft_batch', 'creative_assets_draft'] },
            steps: { type: 'array', items: agentPlanStepSchema, minItems: 1, maxItems: 8 },
        }, ['title', 'steps']),
    },
    'agent.summarize_user_input': {
        contractId: 'agent.user_input_summary.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' } }, ['summary']),
    },
    'agent.generate_user_input_followup': {
        contractId: 'agent.user_input_followup.response', version: '1.0.0',
        schema: objectSchema({
            needsFollowUp: { type: 'boolean' },
            inputRequest: followupInputRequestSchema,
        }, ['needsFollowUp']),
    },
    'agent.revise_plan': {
        contractId: 'agent.plan_revision.response', version: '1.0.0',
        schema: objectSchema({
            title: { type: 'string', minLength: 1 },
            deliverable: { type: 'string', enum: ['report', 'expert_report', 'chapter_draft', 'chapter_draft_batch', 'creative_assets_draft'] },
            steps: { type: 'array', items: agentPlanStepSchema, minItems: 1, maxItems: 8 },
        }, ['title', 'steps']),
    },
    'agent.generate_report': {
        contractId: 'agent.final_report.response', version: '1.0.0',
        schema: objectSchema({ content: { type: 'string' }, conversationSummary: { type: 'string' } }, ['content', 'conversationSummary']),
    },
    'agent.generate_consistency_review': {
        contractId: 'agent.consistency_review.response', version: '1.0.0',
        schema: objectSchema({
            overallScore: nullableScoreSchema,
            summary: { type: 'string', minLength: 1 },
            dimensions: { type: 'array', items: reviewDimensionSchema },
            issues: { type: 'array', items: consistencyIssueSchema },
            uncheckableDimensions: { type: 'array', items: objectSchema({
                dimension: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 },
            }, ['dimension', 'reason']) },
            warnings: stringArray,
        }, ['summary', 'dimensions', 'issues']),
    },
    'agent.generate_novel_bootstrap': {
        contractId: 'agent.novel_bootstrap.response', version: '1.0.0',
        schema: objectSchema({
            titleCandidates: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
            genrePromise: { type: 'string', minLength: 1, maxLength: 1000 },
            readerPromise: { type: 'string', minLength: 1, maxLength: 1000 },
            corePremise: { type: 'string', minLength: 1, maxLength: 2000 },
            centralQuestion: { type: 'string', minLength: 1, maxLength: 1000 },
            narrativeShape: { type: 'string', minLength: 1, maxLength: 1000 },
            characters: { type: 'array', items: novelBootstrapCharacterSchema, minItems: 1, maxItems: 12 },
            worldRules: { type: 'array', items: { type: 'string' }, maxItems: 20 },
            conflictEscalation: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 12 },
            suspenseStrategy: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
            openingBeats: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 12 },
            volumePlan: { type: 'array', items: novelBootstrapVolumeSchema, minItems: 1, maxItems: 6 },
            chapterPlan: { type: 'array', items: novelBootstrapChapterSchema, minItems: 3, maxItems: 24 },
            writingModeRecommendation: { type: 'string', minLength: 1, maxLength: 500 },
            targetChapterCount: { type: 'integer', minimum: 3, maximum: 999 },
            targetWordsPerChapter: { type: 'integer', minimum: 500, maximum: 20000 },
            validationChecklist: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 12 },
            userDecisionSummary: { type: 'string', minLength: 1, maxLength: 2000 },
            assumptions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
            warnings: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        }, ['titleCandidates', 'genrePromise', 'readerPromise', 'corePremise', 'centralQuestion', 'narrativeShape', 'characters', 'conflictEscalation', 'suspenseStrategy', 'openingBeats', 'volumePlan', 'chapterPlan', 'writingModeRecommendation', 'targetChapterCount', 'targetWordsPerChapter', 'validationChecklist', 'userDecisionSummary']),
    },
    'agent.plan_style_skill_pack': {
        contractId: 'agent.style_skill_pack_plan.response', version: '1.0.0',
        schema: objectSchema({
            summary: { type: 'string', minLength: 1, maxLength: 2000 },
            sourceCoverage: { type: 'object' },
            skills: { type: 'array', items: styleSkillMemberPlanSchema, minItems: 2, maxItems: 3 },
            pack: styleSkillPackPlanSchema,
            omittedDimensions: { type: 'array', items: { type: 'string' }, maxItems: 10 },
            warnings: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        }, ['summary', 'sourceCoverage', 'skills', 'pack']),
    },
    'agent.generate_editor_range_review': {
        contractId: 'agent.editor_range_review.response', version: '1.0.0',
        schema: objectSchema({
            overallScore: nullableScoreSchema,
            summary: { type: 'string', minLength: 1 },
            dimensions: { type: 'array', items: reviewDimensionSchema },
            findings: { type: 'array', items: editorRangeFindingSchema },
            recommendations: stringArray,
            warnings: stringArray,
        }, ['summary', 'dimensions', 'findings']),
    },
    'agent.generate_writer_range_revision_plan': {
        contractId: 'agent.writer_range_revision.response', version: '1.0.0',
        schema: objectSchema({
            overallScore: nullableScoreSchema,
            summary: { type: 'string', minLength: 1 },
            dimensions: { type: 'array', items: reviewDimensionSchema },
            findings: { type: 'array', items: editorRangeFindingSchema },
            rewriteOrder: stringArray,
            continuationReadiness: { type: 'string' },
            recommendations: stringArray,
            warnings: stringArray,
        }, ['summary', 'dimensions', 'findings']),
    },
    'agent.generate_reader_chapter_evaluation': {
        contractId: 'agent.reader_chapter_evaluation.response', version: '1.0.0',
        schema: objectSchema({
            chapterId: { type: 'string', minLength: 1 },
            chapterTitle: { type: 'string' },
            scoreScale: { type: 'integer', enum: [100] },
            clarityScore: { type: 'integer', minimum: 0, maximum: 100 },
            emotionalIntensity: { type: 'integer', minimum: 0, maximum: 100 },
            suspenseScore: { type: 'integer', minimum: 0, maximum: 100 },
            retentionScore: { type: 'integer', minimum: 0, maximum: 100 },
            dominantEmotion: { type: 'string' },
            confusionPoints: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            immersionBreaks: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            effectiveHooks: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            expectations: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            dropRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
            summary: { type: 'string', minLength: 1 },
            readerStateSummary: { type: 'string', minLength: 1, maxLength: 2000 },
            findings: { type: 'array', items: readerFindingSchema, maxItems: 4 },
            warnings: stringArray,
        }, [
            'chapterId', 'scoreScale', 'clarityScore', 'emotionalIntensity', 'suspenseScore',
            'retentionScore', 'summary', 'readerStateSummary', 'findings',
        ]),
    },
    'agent.generate_worldbuilding_range_consistency': {
        contractId: 'agent.worldbuilding_consistency.response', version: '1.0.0',
        schema: objectSchema({
            consistencyScore: nullableScoreSchema,
            summary: { type: 'string', minLength: 1 },
            dimensions: { type: 'array', items: reviewDimensionSchema },
            findings: { type: 'array', items: worldbuildingFindingSchema },
            entityAssessments: { type: 'array', items: worldbuildingEntitySchema },
            recommendations: stringArray,
            warnings: stringArray,
        }, ['summary', 'dimensions', 'findings', 'entityAssessments']),
    },
    'agent.extract_research_claims': {
        contractId: 'agent.research_claims.response', version: '1.0.0',
        schema: objectSchema({
            claims: { type: 'array', items: researchClaimSchema, maxItems: 12 },
            warnings: stringArray,
        }, ['claims']),
    },
    'agent.generate_research_fact_check': {
        contractId: 'agent.research_fact_check.response', version: '1.0.0',
        schema: objectSchema({
            overallReliabilityScore: nullableScoreSchema,
            summary: { type: 'string', minLength: 1 },
            claims: { type: 'array', items: researchClaimSchema },
            findings: { type: 'array', items: researchFindingSchema },
            recommendations: stringArray,
            warnings: stringArray,
            searchStats: { type: 'object' },
        }, ['summary', 'findings']),
    },
    'agent.generate_scope_audit': {
        contractId: 'agent.scope_audit.response', version: '1.0.0',
        schema: objectSchema({
            summary: { type: 'string' },
            experts: {
                type: 'array',
                items: scopeAuditExpertSchema,
            },
            findings: { type: 'array', items: scopeAuditFindingSchema },
            conflicts: { type: 'array', items: scopeAuditConflictSchema },
            recommendations: stringArray,
            warnings: stringArray,
        }, ['summary', 'findings', 'conflicts']),
    },
    'agent.generate_plotline_analysis': {
        contractId: 'agent.plotline_analysis.response', version: '1.0.0',
        schema: objectSchema({
            overallScore: nullableScoreSchema,
            summary: { type: 'string', minLength: 1 },
            threads: { type: 'array', items: plotlineThreadSchema },
            issues: { type: 'array', items: plotlineIssueSchema },
            recommendations: stringArray,
            warnings: stringArray,
        }, ['summary', 'threads', 'issues']),
    },
    'agent.detect_creative_direction': {
        contractId: 'agent.creative_direction.response', version: '1.0.0',
        schema: objectSchema({
            requiresDecision: { type: 'boolean' },
            title: { type: 'string', maxLength: 120 },
            reason: { type: 'string', maxLength: 1000 },
            questions: { type: 'array', items: creativeDirectionQuestionSchema, minItems: 1, maxItems: 3 },
        }, ['requiresDecision']),
    },
    'agent.generate_chapter_beats': {
        contractId: 'agent.chapter_beats.response', version: '1.0.0',
        schema: objectSchema({ beats: { type: 'array', items: chapterBeatSchema, minItems: 1, maxItems: 5 } }, ['beats']),
    },
};

export function getAgentStructuredOutputContract(method: string): AgentStructuredOutputContract | null {
    return CONTRACTS[method] ?? null;
}

export function listAgentStructuredOutputMethods(): string[] {
    return Object.keys(CONTRACTS).sort();
}

export function buildAgentStructuredOutputInstruction(method: string): string {
    const contract = getAgentStructuredOutputContract(method);
    if (!contract) return '';
    return [
        `OutputContract=${contract.contractId}@${contract.version}`,
        'Return exactly one JSON object that conforms to the following JSON Schema.',
        'Do not include Markdown fences, comments, explanations, or fields with incompatible types.',
        `JSONSchema=${JSON.stringify(contract.schema)}`,
    ].join('\n');
}

export type AgentStructuredOutputIssue = { path: string; message: string };

export function mergeAgentStructuredOutputIssues(
    ...groups: AgentStructuredOutputIssue[][]
): AgentStructuredOutputIssue[] {
    const merged: AgentStructuredOutputIssue[] = [];
    const seen = new Set<string>();
    for (const issue of groups.flat()) {
        const path = String(issue?.path || '');
        const message = String(issue?.message || '');
        const key = `${path}\u0000${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ path, message });
        if (merged.length >= 20) break;
    }
    return merged;
}

export function validateAgentStructuredOutput(
    value: unknown,
    contract: AgentStructuredOutputContract,
): AgentStructuredOutputIssue[] {
    const issues: AgentStructuredOutputIssue[] = [];

    const visit = (candidate: unknown, rawSchema: unknown, path: string): void => {
        if (issues.length >= 20 || !rawSchema || typeof rawSchema !== 'object' || Array.isArray(rawSchema)) return;
        const schema = rawSchema as Record<string, unknown>;
        const expectedTypes = typeof schema.type === 'string'
            ? [schema.type]
            : Array.isArray(schema.type)
                ? schema.type.filter((item): item is string => typeof item === 'string')
                : [];
        const actualType = Array.isArray(candidate)
            ? 'array'
            : candidate === null
                ? 'null'
                : Number.isInteger(candidate)
                    ? 'integer'
                    : typeof candidate;
        const matchesExpectedType = expectedTypes.length === 0
            || expectedTypes.includes(actualType)
            || (actualType === 'integer' && expectedTypes.includes('number'));
        if (!matchesExpectedType) {
            issues.push({ path, message: `Expected ${expectedTypes.join(' or ')}, received ${actualType}` });
            return;
        }
        if (
            Array.isArray(schema.enum)
            && !schema.enum.some((allowed) => Object.is(allowed, candidate))
        ) {
            issues.push({ path, message: `Expected one of ${schema.enum.map(String).join(', ')}` });
            return;
        }
        if (
            actualType === 'string'
            && typeof schema.minLength === 'number'
            && (candidate as string).length < schema.minLength
        ) {
            issues.push({ path, message: `Expected at least ${schema.minLength} character(s)` });
            return;
        }
        if (
            actualType === 'string'
            && typeof schema.maxLength === 'number'
            && (candidate as string).length > schema.maxLength
        ) {
            issues.push({ path, message: `Expected at most ${schema.maxLength} character(s)` });
            return;
        }
        if (
            actualType === 'string'
            && typeof schema.pattern === 'string'
            && !(new RegExp(schema.pattern).test(candidate as string))
        ) {
            issues.push({ path, message: `Expected string to match pattern ${schema.pattern}` });
            return;
        }
        if (
            (actualType === 'integer' || actualType === 'number')
            && typeof schema.minimum === 'number'
            && (candidate as number) < schema.minimum
        ) {
            issues.push({ path, message: `Expected number greater than or equal to ${schema.minimum}` });
            return;
        }
        if (
            (actualType === 'integer' || actualType === 'number')
            && typeof schema.maximum === 'number'
            && (candidate as number) > schema.maximum
        ) {
            issues.push({ path, message: `Expected number less than or equal to ${schema.maximum}` });
            return;
        }
        if (actualType === 'object' && expectedTypes.includes('object')) {
            const objectValue = candidate as Record<string, unknown>;
            const required = Array.isArray(schema.required)
                ? schema.required.filter((item): item is string => typeof item === 'string')
                : [];
            for (const key of required) {
                if (!(key in objectValue)) issues.push({ path: `${path}.${key}`, message: 'Required property is missing' });
            }
            const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
                ? schema.properties as Record<string, unknown>
                : {};
            for (const [key, childSchema] of Object.entries(properties)) {
                if (key in objectValue) visit(objectValue[key], childSchema, `${path}.${key}`);
            }
            return;
        }
        if (actualType === 'array' && expectedTypes.includes('array')) {
            if (typeof schema.minItems === 'number' && (candidate as unknown[]).length < schema.minItems) {
                issues.push({ path, message: `Expected at least ${schema.minItems} item(s)` });
                return;
            }
            if (typeof schema.maxItems === 'number' && (candidate as unknown[]).length > schema.maxItems) {
                issues.push({ path, message: `Expected at most ${schema.maxItems} item(s)` });
                return;
            }
            const items = schema.items;
            if (items) (candidate as unknown[]).forEach((item, index) => visit(item, items, `${path}[${index}]`));
        }
    };

    visit(value, contract.schema, '$');
    return issues;
}
