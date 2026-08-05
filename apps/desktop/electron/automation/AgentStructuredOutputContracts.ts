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
const objectArray = { type: 'array', items: { type: 'object' } };
const nullableObject = { type: ['object', 'null'] };

const CONTRACTS: Record<string, AgentStructuredOutputContract> = {
    'agent.generate_chat': {
        contractId: 'agent.chat.response', version: '1.0.0',
        schema: objectSchema({
            content: { type: 'string', minLength: 1 }, shouldPlan: { type: 'boolean' },
            requestedOperations: stringArray, toolCalls: objectArray, inputRequest: nullableObject,
        }, ['content', 'shouldPlan', 'requestedOperations', 'toolCalls', 'inputRequest']),
    },
    'agent.generate_plan': {
        contractId: 'agent.plan.response', version: '1.0.0',
        schema: objectSchema({ title: { type: 'string' }, deliverable: { type: 'string' }, steps: objectArray }, ['steps']),
    },
    'agent.summarize_user_input': {
        contractId: 'agent.user_input_summary.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' } }, ['summary']),
    },
    'agent.generate_user_input_followup': {
        contractId: 'agent.user_input_followup.response', version: '1.0.0',
        schema: objectSchema({ needsFollowUp: { type: 'boolean' }, inputRequest: nullableObject }, ['needsFollowUp']),
    },
    'agent.revise_plan': {
        contractId: 'agent.plan_revision.response', version: '1.0.0',
        schema: objectSchema({ title: { type: 'string' }, deliverable: { type: 'string' }, steps: objectArray }, ['steps']),
    },
    'agent.generate_report': {
        contractId: 'agent.final_report.response', version: '1.0.0',
        schema: objectSchema({ content: { type: 'string' }, conversationSummary: { type: 'string' } }, ['content', 'conversationSummary']),
    },
    'agent.generate_consistency_review': {
        contractId: 'agent.consistency_review.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' }, dimensions: objectArray, issues: objectArray }, ['dimensions', 'issues']),
    },
    'agent.generate_novel_bootstrap': {
        contractId: 'agent.novel_bootstrap.response', version: '1.0.0',
        schema: objectSchema({
            titleCandidates: stringArray, genrePromise: { type: 'string' }, readerPromise: { type: 'string' },
            corePremise: { type: 'string' }, centralQuestion: { type: 'string' }, narrativeShape: { type: 'string' },
            characters: objectArray, worldRules: stringArray, conflictEscalation: stringArray,
            suspenseStrategy: stringArray, openingBeats: stringArray, volumePlan: objectArray, chapterPlan: objectArray,
            writingModeRecommendation: { type: 'string' }, targetChapterCount: { type: 'integer' }, targetWordsPerChapter: { type: 'integer' }, validationChecklist: stringArray, userDecisionSummary: { type: 'string' },
            assumptions: stringArray, warnings: stringArray,
        }, ['titleCandidates', 'genrePromise', 'readerPromise', 'corePremise', 'centralQuestion', 'narrativeShape', 'characters', 'conflictEscalation', 'suspenseStrategy', 'openingBeats', 'volumePlan', 'chapterPlan', 'writingModeRecommendation', 'targetChapterCount', 'targetWordsPerChapter', 'validationChecklist', 'userDecisionSummary']),
    },
    'agent.generate_style_skill_pack': {
        contractId: 'agent.style_skill_pack.response', version: '1.0.0',
        schema: objectSchema({
            summary: { type: 'string' }, sourceCoverage: { type: 'object' }, skills: objectArray,
            pack: { type: 'object' }, omittedDimensions: stringArray, warnings: stringArray,
        }, ['summary', 'sourceCoverage', 'skills', 'pack']),
    },
    'agent.generate_skill_draft': {
        contractId: 'agent.skill_author.response', version: '1.0.0',
        schema: objectSchema({
            definition: { type: 'object' }, revision: { type: 'object' },
            rationale: stringArray, warnings: stringArray,
        }, ['definition', 'revision', 'rationale', 'warnings']),
    },
    'agent.generate_editor_range_review': {
        contractId: 'agent.editor_range_review.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' }, dimensions: objectArray, findings: objectArray, recommendations: stringArray }, ['dimensions', 'findings']),
    },
    'agent.generate_writer_range_revision_plan': {
        contractId: 'agent.writer_range_revision.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' }, dimensions: objectArray, findings: objectArray, recommendations: stringArray }, ['dimensions', 'findings']),
    },
    'agent.generate_reader_chapter_evaluation': {
        contractId: 'agent.reader_chapter_evaluation.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' }, readerStateSummary: { type: 'string' }, dimensions: objectArray, findings: objectArray }, ['summary', 'readerStateSummary']),
    },
    'agent.generate_worldbuilding_range_consistency': {
        contractId: 'agent.worldbuilding_consistency.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' }, dimensions: objectArray, findings: objectArray, recommendations: stringArray }, ['summary', 'dimensions']),
    },
    'agent.extract_research_claims': {
        contractId: 'agent.research_claims.response', version: '1.0.0',
        schema: objectSchema({ claims: objectArray }, ['claims']),
    },
    'agent.generate_research_fact_check': {
        contractId: 'agent.research_fact_check.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' }, findings: objectArray, recommendations: stringArray }, ['summary', 'findings']),
    },
    'agent.generate_scope_audit': {
        contractId: 'agent.scope_audit.response', version: '1.0.0',
        schema: objectSchema({
            summary: { type: 'string' },
            experts: {
                type: 'array',
                items: objectSchema({
                    expert: { type: 'string' }, artifactId: { type: 'string' },
                    artifactType: { type: 'string' }, summary: { type: 'string' }, findingCount: { type: 'integer' },
                }, ['expert', 'artifactId', 'artifactType']),
            },
            findings: objectArray, conflicts: objectArray, recommendations: stringArray, warnings: stringArray,
        }, ['summary', 'findings', 'conflicts']),
    },
    'agent.generate_plotline_analysis': {
        contractId: 'agent.plotline_analysis.response', version: '1.0.0',
        schema: objectSchema({ summary: { type: 'string' }, threads: objectArray, issues: objectArray, recommendations: stringArray }, ['threads', 'issues']),
    },
    'agent.detect_creative_direction': {
        contractId: 'agent.creative_direction.response', version: '1.0.0',
        schema: objectSchema({ requiresDecision: { type: 'boolean' } }, ['requiresDecision']),
    },
    'agent.generate_chapter_beats': {
        contractId: 'agent.chapter_beats.response', version: '1.0.0',
        schema: objectSchema({ beats: objectArray }, ['beats']),
    },
};

export function getAgentStructuredOutputContract(method: string): AgentStructuredOutputContract | null {
    return CONTRACTS[method] ?? null;
}

export type AgentStructuredOutputIssue = { path: string; message: string };

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
            actualType === 'string'
            && typeof schema.minLength === 'number'
            && (candidate as string).length < schema.minLength
        ) {
            issues.push({ path, message: `Expected at least ${schema.minLength} character(s)` });
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
            const items = schema.items;
            if (items) (candidate as unknown[]).forEach((item, index) => visit(item, items, `${path}[${index}]`));
        }
    };

    visit(value, contract.schema, '$');
    return issues;
}
