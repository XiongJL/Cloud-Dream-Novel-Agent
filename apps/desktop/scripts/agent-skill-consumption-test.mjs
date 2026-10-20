import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-skill-consumption-'));
const program = ts.createProgram([
    path.join(root, 'electron/ai/context/AgentContextAssembler.ts'),
    path.join(root, 'electron/ai/AgentSkillPrompt.ts'),
    path.join(root, 'shared/writingPolicy.ts'),
    path.join(root, 'shared/chapterWritingPrompt.ts'),
    path.join(root, 'shared/chapterGenerationQuality.ts'),
], { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Node10,
    esModuleInterop: true, skipLibCheck: true, rootDir: root, outDir: temp });
assert.equal(program.emit().emitSkipped, false);
fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"commonjs"}');
process.on('exit', () => {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
});
const require = createRequire(import.meta.url);
const { AgentContextAssembler } = require(path.join(temp, 'electron/ai/context/AgentContextAssembler.js'));
const skillHelpers = require(path.join(temp, 'electron/ai/AgentSkillPrompt.js'));
const writingPolicy = require(path.join(temp, 'shared/writingPolicy.js'));
const chapterPrompt = require(path.join(temp, 'shared/chapterWritingPrompt.js'));
const chapterQuality = require(path.join(temp, 'shared/chapterGenerationQuality.js'));
const source = fs.readFileSync(path.join(root, 'electron/ai/AiService.ts'), 'utf8');
const ast = ts.createSourceFile('AiService.ts', source, ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AiService');
const names = ['assembleAgentContext', 'assembleAgentPrompt', 'assembleDraftGenerationPrompt', 'buildContinuePromptBundle',
    'withAgentStructuredInvocation',
    'continueWriting', 'generateStructured', 'generateChapterBeats', 'generateAgentEditorRangeReview',
    'generateAgentConsistencyReview', 'generateCreativeAssets'];
const methods = names.map(name => service.members.find(member => member.name?.getText(ast) === name).getText(ast)).join('\n');
const compiled = ts.transpileModule(`class Harness { ${methods} }; exports.Harness = Harness;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
const providerBoundary = new Error('Provider boundary reached');
vm.runInNewContext(compiled, {
    exports: module.exports, ...skillHelpers, ...writingPolicy, ...chapterPrompt, ...chapterQuality,
    devLog: () => {}, normalizeAiError: error => error,
    trimText: (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '',
    extractPlainTextFromLexical: value => value || '',
    db: { novel: { findUnique: async () => ({ formatting: '{}' }) }, volume: {findMany: async () => [{chapters: [{id: 'chapter', title: '前一章'}]}]} },
    buildAgentStructuredOutputInstruction: () => 'Preserve the registered JSON output schema.',
    AiActionError: Error, DRAFT_GENERATION_TIMEOUT_MS: 360000,
    DRAFT_FIRST_BYTE_TIMEOUT_MS: 60000, DRAFT_STREAM_IDLE_TIMEOUT_MS: 60000,
});
const skill = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : {
    prompt: '<agent_skill id="user.method" revision="1.0.0">\n[Method]\n' + '保留必要线索，减少无效描述。'.repeat(1400)
        + '\nEND_OF_METHOD\n[Constraints]\nCONSTRAINT_SENTINEL\n[Examples]\nEXAMPLE_SENTINEL\n</agent_skill>',
    sections: [{ skill: { skillId: 'saved', stableId: 'user.method', revisionId: 'locked', version: '1.0.0', contentHash: 'a'.repeat(64), position: 'primary' } }],
};
let invocation, request;
const harness = Object.assign(new module.exports.Harness(), {
    settingsCache: { providerType: 'http', http: { model: 'test-model', contextWindowTokens: 131072,
        maxTokens: 4096, temperature: 0.3, timeoutMs: 120000 } },
    agentStructuredInvocation: { getStore: () => invocation },
    agentContextAssembler: new AgentContextAssembler(),
    resolveGenerationBudget: () => ({ initialTokens: 4096, recoveryTokens: 4096, totalTaskTokens: 8192 }),
    generateWithBudgetRecovery: async (generate, input) => generate(input),
    generateStructuredWithBudgetRecovery: async input => harness.generateStructured(input),
    getProvider: () => ({ generate: async input => { request = input; throw providerBoundary; } }),
    compactContinueHardContext: value => value,
    compactContinueDynamicContext: value => value,
    resolveCreativeTargetSections: () => ['characters'],
    buildCreativeAssetsPromptBundle: async () => ({ systemPrompt: 'Generate JSON assets', structured: { goal: 'Create', params: {}, constraints: [], contextRefs: [] },
        effectiveUserPrompt: 'Ordinary creative prompt', usedContext: [] }),
});
const preparedContext = {
    policy: { version: 'continuation-context-v1' },
    snapshot: { novelId: 'novel', anchorChapterId: 'chapter', chapterSources: [], narrativeSummaryIds: [], estimatedTokens: 10 },
    params: {}, hardContext: {}, dynamicContext: {}, usedContext: [], warnings: [], currentContentSource: 'Source',
};
for (const mode of ['new_chapter', 'continue_chapter', 'rewrite_chapter']) {
    invocation = undefined;
    await assert.rejects(harness.continueWriting({ novelId: 'novel', chapterId: 'chapter', currentContent: 'Source',
        preparedContext, mode, agentSkill: skill, overrideUserPrompt: 'User-edited ordinary prompt' }), error => error === providerBoundary);
    const assembled = JSON.parse(request.prompt);
    assert.equal(assembled.protectedContext.agentSkill.prompt, skill.prompt, 'Complete rules survive overrides and final provider assembly');
    assert.equal(assembled.protectedContext.agentSkill.revisions[0].revisionId, skill.sections[0].skill.revisionId);
}
const tenBeats = Array.from({length: 10}, (_, childIndex) => ({childIndex, title: `Chapter ${childIndex + 1}`,
    chapterGoal: `goal-${childIndex}`, coreConflict: `conflict-${childIndex}`, keyEvents: [`EVENT_${childIndex}`],
    reveals: [`REVEAL_${childIndex}`], endingHook: `hook-${childIndex}`, targetWordCount: 2300}));
const batch = {childIndex: 6, allBeats: tenBeats, currentBeat: tenBeats[6],
    recentFullDrafts: [{childIndex: 4, content: 'DRAFT_FIVE'}, {childIndex: 5, content: 'DRAFT_SIX'}], stateLedger: {knowledgeState: {hero: ['known_fact']}}};
const inspected = await harness.buildContinuePromptBundle({novelId: 'novel', chapterId: 'chapter',
    preparedContext: {...preparedContext, params: {mode: 'continue_chapter'}, dynamicContext: {currentChapterBeforeCursor: 'ANCHOR_TEXT'}},
    mode: 'new_chapter', userIntent: 'Write ten new chapters', batchContext: batch});
const composed = JSON.parse(harness.assembleDraftGenerationPrompt({agentSkill: skill, operation: 'chapter.generate_draft',
    systemPrompt: inspected.systemPrompt, outputTokens: 4096, structured: inspected.structured,
    effectiveUserPrompt: inspected.effectiveUserPrompt, usedContext: []}));
const serialized = JSON.stringify(composed);
assert.equal(serialized.split('EVENT_6').length - 1, 1, 'Detailed current beat has one provider copy');
assert.equal(serialized.split('DRAFT_SIX').length - 1, 1);
assert.match(serialized, /REVEAL_9/); // Preserve distant disclosure boundaries.
assert.match(serialized, /future_plan_not_fact/);
assert.match(serialized, /known_fact/);
assert.equal(composed.currentRequest.params.mode, 'new_chapter');
assert.match(inspected.systemPrompt, /章节创作助手/);
assert.doesNotMatch(inspected.effectiveUserPrompt, /你的任务是续写光标/);
assert.equal(inspected.structured.params.batchContext.currentBeat.keyEvents[0], 'EVENT_6', 'Inspector retains the complete current beat');
assert.equal(inspected.structured.params.batchContext.allBeats.length, 10, 'Inspector retains the full saved batch route');
const ledger = chapterPrompt.chapterBatchForPrompt({...batch, stateLedger: {knowledgeState: {hero: ['verified_fact']},
    timeline: [{childIndex: 0, keyEvents: ['planned_event'], reveals: ['planned_reveal'], summary: 'actual_summary'}], foreshadowing: [{hook: 'planned_hook'}],
    unresolvedConflicts: ['planned_conflict', 'actual_conflict'], stateDeltas: [{openedConflicts: [{conflict: 'actual_conflict'}]}]}}).stateLedger;
assert.equal(ledger.timeline[0].keyEvents, undefined);
assert.equal(ledger.timeline[0].plannedKeyEvents[0], 'planned_event');
assert.equal(ledger.knowledgeState.hero[0], 'verified_fact');
assert.match(ledger.foreshadowing[0].authority, /planned_hook_not_verified_fact/);
assert.deepEqual(ledger.unresolvedConflicts, ['actual_conflict']);
assert.deepEqual(ledger.plannedOrUnverifiedConflicts, ['planned_conflict']);
assert.equal(chapterPrompt.validateChapterBeatCount(10), 10);
assert.throws(() => chapterPrompt.validateChapterBeatCount(11), /between 1 and 10/);
assert.throws(() => chapterPrompt.validateChapterBeatCount(6, true), /between 1 and 5/);
for (const [method, call] of [
    ['agent.generate_chapter_beats', () => harness.generateChapterBeats({ novelId: 'novel', chapterId: 'chapter', goal: 'Rewrite', chapterCount: 1 })],
    ['agent.generate_editor_range_review', () => harness.generateAgentEditorRangeReview({ goal: 'Review', scopeBundle: { chapters: [] } })],
    ['agent.generate_consistency_review', () => harness.generateAgentConsistencyReview({ goal: 'Review', contextBundle: {} })],
    ['creative_assets.generate_draft', () => harness.generateCreativeAssets({ novelId: 'novel', brief: 'Create' })],
]) {
    invocation = { method, requestId: 'request', agentSkill: skill };
    await assert.rejects(call(), error => error === providerBoundary);
    skillHelpers.assertAgentSkillInPrompt(request.prompt, skill);
    assert.match(request.systemPrompt, /registered JSON output schema/);
}
invocation = undefined;
const pressured = harness.assembleAgentPrompt({ operation: 'review', agentSkill: skill, systemPrompt: 'Review', outputTokens: 4096,
    currentRequest: { goal: 'Review' }, sections: [{ id: 'oversized-background', kind: 'retrieval', priority: 'low', value: 'background '.repeat(100000) }] });
assert.equal(JSON.parse(pressured).protectedContext.agentSkill.prompt, skill.prompt, 'Context pressure does not compress rules');
const disabled = harness.assembleAgentPrompt({ operation: 'review', systemPrompt: 'Review', outputTokens: 4096, currentRequest: {} });
assert.equal(JSON.parse(disabled).protectedContext?.agentSkill, undefined);
assert.throws(() => skillHelpers.assertAgentSkillInPrompt('Only a skill title', skill), /missing/);
harness.agentStructuredInvocation = new AsyncLocalStorage();
const concurrentRequests = [];
harness.getProvider = () => ({ generate: async input => { concurrentRequests.push(input); await Promise.resolve(); throw providerBoundary; } });
const secondSkill = { ...skill, prompt: '<agent_skill>SECOND_CONCURRENT_METHOD</agent_skill>' };
await Promise.all([skill, secondSkill, undefined].map((selected, index) => assert.rejects(
    harness.withAgentStructuredInvocation({ method: 'agent.generate_editor_range_review', requestId: `parallel-${index}`, agentSkill: selected },
        () => harness.generateAgentEditorRangeReview({ goal: `Review-${index}`, scopeBundle: {} })),
    error => error === providerBoundary,
)));
assert.deepEqual(concurrentRequests.map(input => JSON.parse(input.prompt).protectedContext?.agentSkill?.prompt),
    [skill.prompt, secondSkill.prompt, undefined], 'Concurrent invocations do not share or leak Skill rules');
const multiSkill = {
    prompt: Array.from({length: 4}, (_, index) => `<agent_skill id="method-${index}">COMPLETE_MULTI_METHOD_${index}</agent_skill>`).join('\n\n'),
    sections: Array.from({length: 4}, (_, index) => ({skill: {skillId: `method-${index}`, revisionId: `locked-${index}`, version: '1.0.0', position: index ? 'auxiliary' : 'primary'}})),
};
await assert.rejects(harness.withAgentStructuredInvocation({method: 'chapter.generate_draft', requestId: 'multiple-methods', agentSkill: multiSkill},
    () => harness.continueWriting({novelId: 'novel', chapterId: 'chapter', preparedContext, mode: 'new_chapter'})), error => error === providerBoundary);
const multiRequest = JSON.parse(concurrentRequests.at(-1).prompt).protectedContext.agentSkill;
assert.equal(multiRequest.prompt, multiSkill.prompt, 'All selected methods survive the final chapter provider boundary');
assert.deepEqual(multiRequest.revisions.map(ref => ref.revisionId), ['locked-0', 'locked-1', 'locked-2', 'locked-3']);
console.log('Skill consumption passed: full rules at provider boundary for chapter modes, beats, reviews and assets; overrides, context pressure and missing-rule rejection.');
