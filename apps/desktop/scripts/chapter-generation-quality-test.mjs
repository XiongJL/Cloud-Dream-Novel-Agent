import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash, randomUUID} from 'node:crypto';

const source = await readFile(new URL('../shared/chapterGenerationQuality.ts', import.meta.url), 'utf8');
const helpers = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
}).outputText).toString('base64')}`);
assert.equal(helpers.isSemanticChapterSummary({provider: 'local', model: 'heuristic-v1'}), false);
assert.equal(helpers.isSemanticChapterSummary({provider: 'local', model: 'extractive-v2'}), false);
assert.equal(helpers.isSemanticChapterSummary({provider: 'http', model: 'model'}), true);
assert.equal(helpers.isSemanticChapterSummary({}), false);
const longChapter = '开场。'.repeat(1000) + '最后已经交出钥匙，离开了车站。';
const excerpt = helpers.chapterMemoryExcerpt(longChapter, 2400);
assert.ok(excerpt.length <= 2400 && excerpt.endsWith('最后已经交出钥匙，离开了车站。'));
assert.equal(helpers.distinctNarrativeMemories([
    {summaryText: '全书摘要（覆盖7章）\n相同内容', keyFacts: []},
    {summaryText: '卷级摘要（覆盖7章）\n相同内容', keyFacts: []},
]).length, 1);
const catalog = Array.from({length: 10}, (_, i) => ({id: `c${i + 1}`, title: `旧章${i + 1}`}));
const target = helpers.newChapterTarget('c10', catalog, 10);
assert.deepEqual(target.newChapterOrders, Array.from({length: 10}, (_, i) => i + 11));
assert.deepEqual(helpers.newChapterTarget('c5', catalog, 2, 'c10').newChapterOrders, [11, 12]);
assert.throws(() => helpers.newChapterTarget('missing', catalog, 1), /CHAPTER_ANCHOR_NOT_FOUND/);
const paragraph = '这是一段已经发生过的原文，人物交出钥匙并离开车站，接下来应当从这件事之后开始，而不是原样重演这次离别。';
assert.equal(helpers.checkChapterText(paragraph, paragraph).status, 'needs_review');
assert.equal(helpers.checkChapterText('新的正文场景。'.repeat(10)).ok, false);
assert.equal(helpers.checkChapterText('新的正文场景。'.repeat(10)).checks.find(c => c.id === 'semantic_continuity').status, 'not_checked');

// Execute the actual context builder against bounded project data. Local summaries
// are fresh by hash but must still be treated as excerpts, with the true ending.
const contextSource = await readFile(new URL('../electron/ai/context/ContextBuilder.ts', import.meta.url), 'utf8');
const contextAst = ts.createSourceFile('ContextBuilder.ts', contextSource, ts.ScriptTarget.Latest, true);
const contextCode = contextAst.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(contextAst)).join('\n');
const contextChapters = [
    {id: 'c1', content: '开场。'.repeat(12000) + '最后他已经归还钥匙。'},
    {id: 'c2', content: '本章经过与结局。'},
    {id: 'c3', content: '最近前章正文。'},
    {id: 'c4', content: '锚点章节结尾。'},
].map((chapter, index) => ({...chapter, title: `章节${index + 1}`, order: index + 1, volumeId: 'v', version: 1, updatedAt: new Date('2026-10-15T00:00:00Z')}));
const contextMod = {exports: {}};
const chapterPromptSource = await readFile(new URL('../shared/chapterWritingPrompt.ts', import.meta.url), 'utf8');
const chapterPrompt = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(chapterPromptSource, {
    compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
}).outputText).toString('base64')}`);
const contextDb = {
    novel: {findUnique: async () => ({formatting: '{}'})},
    volume: {findMany: async () => [{id: 'v', order: 1, chapters: contextChapters}]},
    chapter: {findMany: async input => contextChapters.filter(ch => input.where.id.in.includes(ch.id)),
        findUnique: async () => contextChapters[3]},
    chapterSummary: {findMany: async () => contextChapters.map((chapter, index) => ({
        id: `s${index}`, chapterId: chapter.id, provider: index === 1 ? 'http' : 'local', model: index === 1 ? 'model' : 'heuristic-v1',
        sourceContentHash: createHash('sha256').update(chapter.content).digest('hex'), summaryText: '本地开头不能当情节摘要', compressedMemory: '语义摘要记录的本章事实',
    }))},
    narrativeSummary: {findMany: async () => [
        {id: 'n1', level: 'novel', provider: 'local', summaryText: '全书摘要（覆盖2章）\n相同材料'},
        {id: 'n2', level: 'volume', provider: 'local', summaryText: '卷级摘要（覆盖2章）\n相同材料'},
    ]},
};
for (const name of ['character', 'item', 'worldSetting', 'mapCanvas', 'plotLine']) contextDb[name] = {findMany: async () => []};
vm.runInNewContext(ts.transpileModule(contextCode, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText,
    {exports: contextMod.exports, db: contextDb, createHash, randomUUID, ...helpers, ...chapterPrompt, extractReadableText: value => value,
        novelChapterLength: () => undefined, resolveWritingLength: () => ({target: 2300})});
const actualContext = await new contextMod.exports.ContextBuilder().buildForContinueWriting({
    novelId: 'book', chapterId: 'c4', currentContent: '', contextChapterCount: 3, recentRawChapterCount: 1,
});
assert.equal(actualContext.dynamicContext.recentChapters[0].contentMode, 'excerpt');
assert.ok(actualContext.dynamicContext.recentChapters[0].excerpt.endsWith('最后他已经归还钥匙。'));
assert.equal(actualContext.dynamicContext.recentChapters[1].contentMode, 'summary');
assert.equal(actualContext.dynamicContext.recentChapters[2].contentMode, 'full');
assert.equal(actualContext.dynamicContext.narrativeSummaries.length, 1);
assert.equal(actualContext.snapshot.narrativeSummaryIds.length, 1);
assert.match(actualContext.dynamicContext.narrativeSummaries[0].summaryText, /非完整情节摘要/);

const serviceSource = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AiService.ts', serviceSource, ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AiService');
const names = ['generateChapterBeats', 'generateAgentReport', 'extractNarrativeState', 'generateAgentSkillDocument'];
const methods = names.map(name => service.members.find(m => m.name?.getText(ast) === name).getText(ast)).join('\n');
const mod = {exports: {}};
let dbReads = 0;
vm.runInNewContext(ts.transpileModule(`class Harness {${methods}}; exports.Harness = Harness;`, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: mod.exports, ...helpers,
    trimText: (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '',
    validateChapterBeatCount: count => count, DEFAULT_CHAPTER_LENGTH: 2300, AGENT_OPERATION_IDS: ['chapter.create'],
    AiActionError: class extends Error {constructor(code, message) {super(message); this.code = code;}},
    db: {volume: {findMany: async () => {dbReads++; return [{chapters: catalog}];}}},
    normalizeNarrativeStateDelta: value => value, filterNarrativeStateDeltaEvidence: value => value,
});
let captured, result;
const harness = Object.assign(new mod.exports.Harness(), {
    settingsCache: {http: {temperature: 0.7, timeoutMs: 120000}},
    agentStructuredInvocation: {getStore: () => undefined},
    compactContinueHardContext: value => value, compactContinueDynamicContext: value => value,
    resolveGenerationBudget: task => {if (task === 'narrative_state') assert.equal(task, 'narrative_state'); return {initialTokens: 8192, recoveryTokens: 16384};},
    generateStructuredWithBudgetRecovery: async request => {captured = request; return {text: 'JSON'};},
    checkpointAndParseStructuredResponse: async () => result,
    assembleAgentPrompt: value => JSON.stringify(value),
    generateWithBudgetRecovery: (generate, request) => generate(request),
    getProvider: () => ({generate: async request => {captured = request; return {text: 'state'};}}),
});
const beat = {title: '第10章 新发展', chapterGoal: '离开之后发生的新任务', coreConflict: '新的选择', endingHook: '自然过渡', keyEvents: [], reveals: []};
result = {beats: Array.from({length: 10}, (_, i) => ({...beat, title: `第${i + 1}章 新发展${i}`}))};
const generated = await harness.generateChapterBeats({novelId: 'book', chapterId: 'c10', goal: '新写十章', chapterCount: 10,
    locale: 'zh-CN', context: {dynamicContext: {currentChapterBeforeCursor: '钥匙已经交出。'}, hardContext: {}}});
assert.match(generated.beats[0].title, /^第11章/);
assert.match(generated.beats[9].title, /^第20章/);
assert.match(captured.prompt, /AnchorEnding=钥匙已经交出/);
assert.match(captured.prompt, /anchorGlobalOrder/);
result = {beats: [{...beat, title: '第10章 旧章10'}]};
await assert.rejects(harness.generateChapterBeats({novelId: 'book', chapterId: 'c10', goal: '新一章', chapterCount: 1}), /重复了已有章节标题/);
const beforeRewrite = dbReads;
const rewritten = await harness.generateChapterBeats({novelId: 'book', chapterId: 'c10', goal: '改写', taskMode: 'batch_rewrite', chapterCount: 1});
assert.equal(rewritten.beats[0].title, '第10章 旧章10');
assert.equal(dbReads, beforeRewrite, 'Rewrites do not use new chapter numbering');

result = {characterLocations: [], relationshipChanges: [], knowledgeChanges: [], itemStates: [], resolvedConflicts: [], openedConflicts: [], warnings: []};
await harness.extractNarrativeState({generatedText: '完整正文。'.repeat(50), characters: [], items: []});
assert.equal(captured.maxTokens, 8192, 'State extraction follows the task budget, not a 3200-token clamp');

await harness.generateAgentSkillDocument({goal: '编写已核验的语言成员', contentOnly: true,
    creatorProfile: 'builtin.style-skill-extractor.member', source: {styleSource: {reviewedEvidence: []}}});
assert.match(captured.systemPrompt, /先写清可辨识的正向写法/);
assert.match(captured.systemPrompt, /不以通用禁令清单代替文风/);
assert.match(captured.systemPrompt, /不把编辑示例说成新核验的来源特点/);

result = {content: '模型错误声称没有读取正文。', conversationSummary: '模型错误声称无告警。'};
const report = await harness.generateAgentReport({goal: '写新章', artifacts: [{type: 'chapter_draft_batch', status: 'ready', writingDelivery: {
    generatedCount: 1, contextSources: [{chapterId: 'c10'}], stateVerifiedCount: 0, warnings: ['状态抽取失败'],
}}]});
assert.match(report.conversationSummary, /装载了 1 章上下文/);
assert.match(report.conversationSummary, /状态抽取失败/);
assert.doesNotMatch(report.conversationSummary, /无告警|没有读取正文/);
assert.match(report.conversationSummary, /未附独立的语义连续性与来源文风审核结论/);
console.log('Chapter generation quality passed: 10-chapter positioning, repeat rejection, rewrite isolation, excerpt provenance, scoped checks, state budget and truthful delivery.');
