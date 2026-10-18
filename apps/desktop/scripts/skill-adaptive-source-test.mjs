import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const transpile = source => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const load = source => import(`data:text/javascript;base64,${Buffer.from(transpile(source)).toString('base64')}`);
const raw = await readFile(new URL('../electron/ai/context/ContextBuilder.ts', import.meta.url), 'utf8');
const quality = await readFile(new URL('../shared/chapterGenerationQuality.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ContextBuilder.ts', raw, ts.ScriptTarget.Latest, true);
const source = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
const catalog = Array.from({ length: 500 }, (_, index) => ({
    id: `chapter-${index}`, volumeId: 'volume-1', title: `Chapter ${index}`, order: index,
    version: 1, updatedAt: new Date('2026-10-09T00:00:00Z'), content: '原文🙂\n'.repeat(12000),
}));
const reads = [];
globalThis.__adaptiveSourceDb = {
    volume: { findMany: async () => [{ id: 'volume-1', order: 1, chapters: catalog.map(({ content, ...row }) => row) }] },
    chapter: { findMany: async input => {
        reads.push(input);
        return catalog.filter(row => input.where.id.in.includes(row.id))
            .map(row => Object.fromEntries(Object.keys(input.select).map(key => [key, row[key]])));
    } },
    chapterSummary: { findMany: async () => [] },
};
const { ContextBuilder } = await load(`
import { createHash, randomUUID } from 'node:crypto';
const db = globalThis.__adaptiveSourceDb;
const extractReadableText = value => value;
${quality}
${source}`);
const builder = new ContextBuilder();
const initial = await builder.buildForChapterScope({ novelId: 'novel', kind: 'novel', representation: 'catalog' });
assert.equal(initial.chapters.length, 500);
assert.equal(initial.chapters.filter(row => row.contentMode === 'catalog' && row.content === '').length, 500);
assert.equal(reads[0].select.content, undefined, 'Catalogs must not select chapter prose');
assert.equal(initial.entityContext.characters.length, 0);
const volumeCatalog = await builder.buildForChapterScope({ novelId: 'novel', kind: 'current_volume', volumeId: 'volume-1', representation: 'catalog' });
assert.equal(volumeCatalog.scope.volumeId, 'volume-1', 'Catalog revalidation must retain volume identity');
assert.equal(volumeCatalog.chapters.length, 500);
const selectedCatalog = await builder.buildForChapterScope({ novelId: 'novel', kind: 'selected_chapters', chapterIds: ['chapter-0', 'chapter-2'], representation: 'catalog' });
assert.deepEqual(selectedCatalog.scope.chapterIds, ['chapter-0', 'chapter-2']);
assert.equal(selectedCatalog.chapters.length, 2, 'Catalogs must not promote intervening chapters to approved targets');
const exact = await builder.buildForChapterScope({ novelId: 'novel', kind: 'current_chapter', chapterId: 'chapter-0', representation: 'verbatim' });
assert.equal(exact.chapters[0].content, catalog[0].content, 'Raw reads must not truncate at the old 30000-character cap');
assert.equal(exact.chapters[0].contentMode, 'full');
await assert.rejects(() => builder.buildForChapterScope({ novelId: 'novel', kind: 'novel', representation: 'verbatim' }), /exactly one/);
await assert.rejects(() => builder.buildForChapterScope({ novelId: 'novel', kind: 'current_chapter', chapterId: 'foreign', representation: 'verbatim' }), error => /not belong/.test(error.message));

const hintsSource = await readFile(new URL('../shared/skillExecutionHints.ts', import.meta.url), 'utf8');
const hintsUrl = `data:text/javascript;base64,${Buffer.from(transpile(hintsSource)).toString('base64')}`;
const operationsSource = await readFile(new URL('../shared/agentOperationIds.ts', import.meta.url), 'utf8');
const operationsUrl = `data:text/javascript;base64,${Buffer.from(transpile(operationsSource)).toString('base64')}`;
const authoringRaw = (await readFile(new URL('../electron/agentSkills/AgentSkillAuthoring.ts', import.meta.url), 'utf8'))
    .replace("'../../shared/skillExecutionHints'", JSON.stringify(hintsUrl))
    .replace("'../../shared/agentOperationIds'", JSON.stringify(operationsUrl));
const { compileAgentSkillMarkdown, serializeAgentSkillProjection, validatePack } = await load(authoringRaw);
for (const operationId of ['draft.chapter', 'rewrite.scene', 'edit.prose', 'plan.outline', 'edit.pacing', 'review.continuity', 'reader.simulate']) {
    const diagnostics = validatePack({ definition: { stableId: 'test-pack', title: 'Pack', description: 'Pack' },
        revision: { version: '1.0.0', bindings: [{ operationId, roleId: 'writer', primaryDraftKey: 'language' }] } },
        [{ key: 'language', manifest: { supportedOperations: ['chapter.continuation'], allowedRoles: ['writer'] } }]);
    assert(diagnostics.some(item => item.code === 'SKILL_PACK_BINDING_INVALID'), `Reject the real invalid binding ${operationId}`);
}
const hints = { version: 1, decomposition: 'independent_units', preferredUnit: 'chapter',
    crossUnitDependency: 'none', resultComposition: 'evidence_findings', contextRequirement: 'verbatim_samples', coverageRequirement: 'all_units' };
const projection = { definition: { stableId: 'user.analysis', title: '章节方法', description: '按章节分析证据' },
    revision: { version: '1.0.0', instructions: '从原文记录证据，区分推断与事实。', constraints: [],
        manifest: { category: 'review', origin: 'authored', guidanceMode: 'guided', semanticSelection: 'suggest',
            triggerHints: ['分析章节'], antiTriggerHints: ['生成正文'], supportedOperations: ['editor.range_review'],
            allowedRoles: ['editor'], outputType: 'report', executionHints: hints } } };
const document = serializeAgentSkillProjection(projection, 'user');
const compiled = compileAgentSkillMarkdown({ logicalPath: 'SKILL.md', contentText: document, expectedScope: 'user', origin: 'authored' });
assert.equal(compiled.diagnostics.filter(item => item.severity === 'error').length, 0);
assert.deepEqual(compiled.projection.revision.manifest.executionHints, hints);
const invalid = document.replace(JSON.stringify(JSON.stringify(hints)), JSON.stringify(JSON.stringify({ ...hints, maxConcurrency: 100 })));
assert.ok(compileAgentSkillMarkdown({ logicalPath: 'SKILL.md', contentText: invalid, expectedScope: 'user', origin: 'authored' }).diagnostics
    .some(item => item.code === 'SKILL_EXECUTION_HINTS_INVALID'));
delete projection.revision.manifest.executionHints;
assert.equal(compileAgentSkillMarkdown({ logicalPath: 'SKILL.md', contentText: serializeAgentSkillProjection(projection, 'user'), expectedScope: 'user', origin: 'authored' })
    .diagnostics.filter(item => item.severity === 'error').length, 0, 'Old Skills need no execution hint');
delete globalThis.__adaptiveSourceDb;
// Exercise the production policy and request builder. Raw sources must stay in
// protected current input; model windows and loaded methods reduce unit size.
const serviceRaw = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const serviceAst = ts.createSourceFile('AiService.ts', serviceRaw, ts.ScriptTarget.Latest, true);
const serviceClass = serviceAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AiService');
const methodNames = ['getSkillExecutionPolicy', 'buildSkillAnalysisRequest', 'analyzeSkillWorkUnit', 'mergeSkillAnalysis', 'planSkillExecution'];
const methods = methodNames.map(name => serviceClass.members.find(node => node.name?.getText(serviceAst) === name).getText(serviceAst));
const budgetRaw = await readFile(new URL('../electron/ai/TaskOutputBudget.ts', import.meta.url), 'utf8');
const budgetAst = ts.createSourceFile('TaskOutputBudget.ts', budgetRaw, ts.ScriptTarget.Latest, true);
const capMethod = budgetAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'capTaskOutputBudget');
const { AnalysisHarness } = await load(`
import { Buffer } from 'node:buffer';
const trimText = (value, max) => String(value || '').trim().slice(0, max);
class AiActionError extends Error { constructor(code, message) { super(message); this.code = code; } }
class AgentContextTokenCounter { count(input) { return { providerInputTokens: Buffer.byteLength(input.systemPrompt + input.prompt, 'utf8') }; } }
${capMethod.getText(budgetAst)}
export class AnalysisHarness { ${methods.join('\n')} }
`);
const harness = new AnalysisHarness();
harness.settingsCache = { providerType: 'http', http: { model: 'test', temperature: 0.5, timeoutMs: 120000 } };
let window = 60000;
harness.resolveGenerationBudget = () => ({ contextMaximumTokens: window, initialTokens: 16384, recoveryTokens: 32768, totalTaskTokens: 49152 });
let promptInput;
harness.assembleAgentPrompt = input => { promptInput = input; return JSON.stringify(input.currentRequest); };
const small = harness.getSkillExecutionPolicy({ goal: '提炼', skillPrompt: '方法' });
assert.ok(small.maxInputBytes < 48000);
assert.equal(small.version, 2);
assert.ok(small.stages.expert.maxInputBytes < small.stages.analyze.maxInputBytes);
assert.ok(harness.getSkillExecutionPolicy({ goal: '提炼', skillPrompt: '方法'.repeat(500) }).maxInputBytes < small.maxInputBytes);
window = 40000;
assert.ok(harness.getSkillExecutionPolicy().maxInputBytes > 4096, 'A 40K window must not lose all input to a 32K output reserve');
window = 10000;
assert.throws(() => harness.getSkillExecutionPolicy(), error => error.code === 'CONTEXT_BUDGET_UNSATISFIABLE');
window = 200000;
assert.equal(harness.getSkillExecutionPolicy().maxInputBytes, 48000);
const rawSource = { samples: [{ sourceId: 'c', content: '必须完整保留原文。'.repeat(500) }] };
let calls = 0;
harness.generateStructuredWithBudgetRecovery = async (request, budget, stage) => {
    calls++;
    assert.equal(request.maxTokens, budget.initialTokens);
    assert.equal(promptInput.outputTokens, budget.recoveryTokens);
    assert.deepEqual(promptInput.currentRequest.source, rawSource);
    assert.equal(promptInput.sections, undefined);
    return { text: JSON.stringify(stage === 'agent.plan_skill_execution'
        ? { executionMode: 'partitioned', dependency: 'ordered', reason: '依赖前章' }
        : { summary: '分析结果', findings: [], warnings: [] }) };
};
harness.checkpointAndParseStructuredResponse = async text => JSON.parse(text);
await harness.analyzeSkillWorkUnit({ goal: '分析', source: rawSource });
await harness.mergeSkillAnalysis({ goal: '汇总', source: rawSource });
await harness.planSkillExecution({ goal: '路由', source: rawSource });
assert.equal(calls, 3);
assert.throws(() => harness.buildSkillAnalysisRequest({ goal: '分析', source: { content: '原'.repeat(20000) } }), error => error.code === 'CONTEXT_INPUT_TOO_LARGE');
console.log('Adaptive Skill source, hint round-trip, policy and protected model-input tests passed.');
