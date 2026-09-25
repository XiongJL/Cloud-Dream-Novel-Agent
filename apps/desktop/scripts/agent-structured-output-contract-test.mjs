import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { jsonrepair } from 'jsonrepair';
import ts from 'typescript';

const source = await readFile(new URL('../electron/automation/AgentStructuredOutputContracts.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const contracts = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const parserSource = await readFile(new URL('../shared/agentJson.ts', import.meta.url), 'utf8');
const parserOutput = ts.transpileModule(parserSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseRepairableJsonObject } = await import(
    `data:text/javascript;base64,${Buffer.from(parserOutput).toString('base64')}`
);

const automationServiceSource = await readFile(
    new URL('../electron/automation/AutomationService.ts', import.meta.url),
    'utf8',
);
const invokedStructuredMethods = [...automationServiceSource.matchAll(
    /case '([^']+)':\s*\r?\n\s*return invokeStructured\(/g,
)].map((match) => match[1]).sort();
const registeredStructuredMethods = contracts.listAgentStructuredOutputMethods();
assert.equal(registeredStructuredMethods.length, 22, 'The SO-1 coverage baseline must remain explicit');
assert.deepEqual(
    invokedStructuredMethods,
    registeredStructuredMethods.filter((method) => ![
        'creative_assets.generate_draft',
        'creative_assets.revise_draft',
        'outline.generate_draft',
    ].includes(method)),
);
assert.match(automationServiceSource, /structuredMethod = type === 'outline-draft'[\s\S]*this\.invokeAgentStructured\([\s\S]*\{ autoRepair: true \}/u);
assert.match(automationServiceSource, /this\.invokeAgentStructured\(\s*'creative_assets\.revise_draft'[\s\S]*\{ autoRepair: true \}/u);
assert.ok(!registeredStructuredMethods.includes('agent.generate_skill_draft'));
assert.ok(!registeredStructuredMethods.includes('agent.generate_style_skill_pack'));
for (const method of ['creative_assets.generate_draft', 'creative_assets.revise_draft', 'outline.generate_draft']) {
    assert.ok(registeredStructuredMethods.includes(method));
}
const contractIdentities = registeredStructuredMethods.map((method) => {
    const contract = contracts.getAgentStructuredOutputContract(method);
    assert.ok(contract, `Missing contract for ${method}`);
    assert.match(contracts.buildAgentStructuredOutputInstruction(method), /JSONSchema=/);
    return `${contract.contractId}@${contract.version}`;
});
assert.equal(new Set(contractIdentities).size, contractIdentities.length, 'Contract identities must be unique');

const aiServiceSource = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
assert.doesNotMatch(aiServiceSource, /generateAgentSkillDraft|generateAgentStyleSkillPack/);
assert.doesNotMatch(aiServiceSource, /角色-\$\{suffix\}|完成使命/u);
assert.doesNotMatch(aiServiceSource, /你是 Agent Skill Creator。把用户自然语言需求整理成|你是创作 Skill 提炼器。只从输入中获准/);
const structuredGenerateCallCount = [...aiServiceSource.matchAll(/this\.generateStructured\(/g)].length;
const budgetRecoveryCallCount = [...aiServiceSource.matchAll(/this\.generateStructuredWithBudgetRecovery\(/g)].length;
assert.equal(
    structuredGenerateCallCount + budgetRecoveryCallCount,
    registeredStructuredMethods.length,
    'Each structured generator must use a direct contract-aware call or the budget-recovery wrapper',
);
assert.match(aiServiceSource, /generateStructuredWithBudgetRecovery\([\s\S]*agent\.generate_consistency_review'\)/u);
assert.match(
    aiServiceSource,
    /const budgetedSystemPrompt = structuredOutputInstruction[\s\S]*systemPrompt: budgetedSystemPrompt/,
    'Structured output instructions must count toward the context budget',
);
assert.match(aiServiceSource, /产品内置 Agent Skill Creator 的文档作者/);
assert.match(aiServiceSource, /不要创建包打天下的通用助手/);
assert.match(aiServiceSource, /只做解决对应诊断所需的最小修订/);
assert.match(aiServiceSource, /builtin\.style-skill-extractor\.member/);

const shallowObjectArrayPaths = [];
const visitSchema = (schema, path) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
    if (
        schema.type === 'array'
        && schema.items
        && schema.items.type === 'object'
        && !schema.items.properties
    ) {
        shallowObjectArrayPaths.push(`${path}[]`);
    }
    if (schema.properties) {
        for (const [key, child] of Object.entries(schema.properties)) visitSchema(child, `${path}.${key}`);
    }
    if (schema.items) visitSchema(schema.items, `${path}[]`);
};
for (const method of registeredStructuredMethods) {
    visitSchema(contracts.getAgentStructuredOutputContract(method).schema, method);
}
assert.deepEqual(shallowObjectArrayPaths, []);

const scopeContract = contracts.getAgentStructuredOutputContract('agent.generate_scope_audit');
assert.ok(scopeContract);

const invalidIssues = contracts.validateAgentStructuredOutput({
    summary: '综合结论',
    experts: ['editor', 'worldbuilding'],
    findings: [],
    conflicts: [],
    recommendations: [{ priority: 'high', item: '修订第二章' }],
}, scopeContract);
assert.ok(invalidIssues.some((issue) => issue.path === '$.experts[0]' && issue.message.includes('object')));
assert.ok(invalidIssues.some((issue) => issue.path === '$.recommendations[0]' && issue.message.includes('string')));

const missingIssues = contracts.validateAgentStructuredOutput({ summary: '缺少字段' }, scopeContract);
assert.ok(missingIssues.some((issue) => issue.path === '$.findings'));
assert.ok(missingIssues.some((issue) => issue.path === '$.conflicts'));

const validIssues = contracts.validateAgentStructuredOutput({
    summary: '综合结论',
    experts: [{ expert: 'editor', artifactId: 'artifact-1', artifactType: 'chapter_range_review' }],
    findings: [],
    conflicts: [],
    recommendations: ['修订第二章'],
    warnings: [],
}, scopeContract);
assert.deepEqual(validIssues, []);

const chatContract = contracts.getAgentStructuredOutputContract('agent.generate_chat');
assert.ok(chatContract);
assert.deepEqual(contracts.validateAgentStructuredOutput({
    content: '普通对话回答',
    shouldPlan: false,
    requestedOperations: [],
    toolCalls: [],
    inputRequest: null,
}, chatContract), []);
const invalidChatIssues = contracts.validateAgentStructuredOutput({
    content: '错误的澄清请求',
    shouldPlan: false,
    requestedOperations: [],
    toolCalls: [],
    inputRequest: 'not-an-object',
}, chatContract);
assert.ok(invalidChatIssues.some((issue) => (
    issue.path === '$.inputRequest'
    && issue.message.includes('object or null')
)));
assert.ok(contracts.validateAgentStructuredOutput({
    content: '',
    shouldPlan: false,
    requestedOperations: [],
    toolCalls: [],
    inputRequest: null,
}, chatContract).some((issue) => issue.path === '$.content' && issue.message.includes('at least 1')));

const creativeContract = contracts.getAgentStructuredOutputContract('creative_assets.generate_draft');
assert.ok(creativeContract);
assert.deepEqual(contracts.validateAgentStructuredOutput({
    characters: [{ name: '林雾', role: 'protagonist' }],
}, creativeContract), []);
assert.ok(contracts.validateAgentStructuredOutput({
    characters: [{ role: 'protagonist' }],
}, creativeContract).some((issue) => issue.path === '$.characters[0].name'));

const followupContract = contracts.getAgentStructuredOutputContract('agent.generate_user_input_followup');
assert.ok(followupContract);
assert.deepEqual(contracts.validateAgentStructuredOutput({
    needsFollowUp: false,
    inputRequest: null,
}, followupContract), []);

const reportContract = contracts.getAgentStructuredOutputContract('agent.generate_report');
assert.ok(reportContract);
const repairedReport = parseRepairableJsonObject(
    '{"content":"第一行\n第二行","conversationSummary":"摘要",}',
    jsonrepair,
);
assert.equal(repairedReport?.repaired, true);
assert.deepEqual(contracts.validateAgentStructuredOutput(repairedReport.value, reportContract), []);

const repairedButContractInvalid = parseRepairableJsonObject(
    '{"content":"报告","conversationSummary":3,}',
    jsonrepair,
);
assert.equal(repairedButContractInvalid?.repaired, true);
assert.ok(contracts.validateAgentStructuredOutput(
    repairedButContractInvalid.value,
    reportContract,
).some((issue) => issue.path === '$.conversationSummary'));

assert.equal(contracts.buildAgentStructuredOutputInstruction('agent.not_registered'), '');
const validStylePlan = {
    summary: '已规划两个 Skill 文档。',
    sourceCoverage: { chapterCount: 1 },
    skills: ['language_style', 'suspense_release'].map((draftKey) => ({
        draftKey,
        stableIdCandidate: `style.${draftKey.replaceAll('_', '-')}`,
        title: draftKey,
        description: '可复用的写作方法',
        guidanceMode: 'guided',
        confidence: 'medium',
        triggerHints: ['需要对应写作能力'],
        antiTriggerHints: ['不适用于事实核查'],
        supportedOperations: ['chapter.write'],
        constraints: ['不得复制原文长句'],
        methodDimensions: ['节奏', '叙述距离', '信息释放'],
        evidenceNotes: [],
        contaminationWarnings: [],
        evaluationPrompt: '检查结果是否符合提炼的方法。',
    })),
    pack: {
        stableIdCandidate: 'style.sample-pack',
        title: '示例文风包',
        description: '组合语言风格与悬念释放能力。',
        bindings: [{
            operationId: 'chapter.write',
            roleId: 'writer',
            primaryDraftKey: 'language_style',
            auxiliaryDraftKey: 'suspense_release',
        }],
    },
    omittedDimensions: ['ensemble_progression：缺少群像样本'],
    warnings: [],
};

const stylePlanContract = contracts.getAgentStructuredOutputContract('agent.plan_style_skill_pack');
assert.ok(stylePlanContract);
assert.ok(contracts.listAgentStructuredOutputMethods().includes('agent.plan_style_skill_pack'));
assert.match(
    contracts.buildAgentStructuredOutputInstruction('agent.plan_style_skill_pack'),
    /OutputContract=agent\.style_skill_pack_plan\.response@1\.0\.0/,
);
assert.deepEqual(contracts.validateAgentStructuredOutput(validStylePlan, stylePlanContract), []);
const invalidStylePlan = structuredClone(validStylePlan);
invalidStylePlan.skills[0].stableIdCandidate = 'Bad ID';
invalidStylePlan.skills[0].methodDimensions = ['只有一项'];
invalidStylePlan.pack.bindings[0].roleId = 'unknown';
const invalidStylePlanIssues = contracts.validateAgentStructuredOutput(invalidStylePlan, stylePlanContract);
assert.ok(invalidStylePlanIssues.some((issue) => issue.path === '$.skills[0].stableIdCandidate'));
assert.ok(invalidStylePlanIssues.some((issue) => issue.path === '$.skills[0].methodDimensions'));
assert.ok(invalidStylePlanIssues.some((issue) => issue.path === '$.pack.bindings[0].roleId'));

assert.deepEqual(contracts.mergeAgentStructuredOutputIssues(
    [],
    [{ path: 'skills.0.instructions', message: 'Input should be a valid string' }],
), [{ path: 'skills.0.instructions', message: 'Input should be a valid string' }]);
assert.deepEqual(contracts.mergeAgentStructuredOutputIssues(
    [{ path: '$.skills[0].instructions', message: 'Expected string, received array' }],
    [
        { path: '$.skills[0].instructions', message: 'Expected string, received array' },
        { path: 'skills.0.guidanceMode', message: 'Input should be guided' },
    ],
), [
    { path: '$.skills[0].instructions', message: 'Expected string, received array' },
    { path: 'skills.0.guidanceMode', message: 'Input should be guided' },
]);

const planContract = contracts.getAgentStructuredOutputContract('agent.generate_plan');
assert.ok(contracts.validateAgentStructuredOutput({
    title: '计划',
    deliverable: 'report',
    steps: [{ agent: 'editor', title: '检查', tools: { name: 'chapter.get' } }],
}, planContract).some((issue) => issue.path === '$.steps[0].tools'));

const bootstrapContract = contracts.getAgentStructuredOutputContract('agent.generate_novel_bootstrap');
const invalidBootstrap = {
    titleCandidates: ['示例'], genrePromise: '类型承诺', readerPromise: '读者承诺',
    corePremise: '核心前提', centralQuestion: '中心问题', narrativeShape: '叙事形态',
    characters: [{ name: '主角', role: '主角', cost: '代价', change: '变化' }],
    worldRules: [], conflictEscalation: ['一', '二', '三'], suspenseStrategy: ['悬念'],
    openingBeats: ['一', '二', '三'],
    volumePlan: [{ title: '第一卷', dramaticQuestion: '问题', turningPoint: '转折', chapterRange: '1-10' }],
    chapterPlan: [1, 2, 3].map((chapterNumber) => ({ chapterNumber, title: `第${chapterNumber}章`, sceneGoal: '目标', conflict: '冲突', hook: '钩子' })),
    writingModeRecommendation: '推荐', targetChapterCount: 10, targetWordsPerChapter: 2500,
    validationChecklist: ['一', '二', '三'], userDecisionSummary: '用户决定', assumptions: [], warnings: [],
};
assert.ok(contracts.validateAgentStructuredOutput(
    invalidBootstrap,
    bootstrapContract,
).some((issue) => issue.path === '$.characters[0].desire'));

const readerContract = contracts.getAgentStructuredOutputContract('agent.generate_reader_chapter_evaluation');
assert.ok(contracts.validateAgentStructuredOutput({
    chapterId: 'chapter-1', scoreScale: 10, clarityScore: 120, emotionalIntensity: 50,
    suspenseScore: 50, retentionScore: 50, summary: '摘要', readerStateSummary: '状态', findings: [],
}, readerContract).some((issue) => issue.path === '$.scoreScale'));

const beatsContract = contracts.getAgentStructuredOutputContract('agent.generate_chapter_beats');
assert.ok(contracts.validateAgentStructuredOutput({
    beats: [{ title: '第一章', chapterGoal: '目标', coreConflict: '冲突', endingHook: '钩子', targetWordCount: '2500' }],
}, beatsContract).some((issue) => issue.path === '$.beats[0].targetWordCount'));

console.log('agent structured output contract tests passed');
