import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash, randomUUID} from 'node:crypto';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../electron/automation/AutomationService.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AutomationService.ts', source, ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AutomationService');
const method = service.members.find(node => node.name?.getText(ast) === 'createChapterDraftSession' && node.body);
const compiled = ts.transpileModule(`class Harness {${method.getText(ast)}}; exports.Harness = Harness;`, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const mod = {exports: {}};
const chapterPromptSource = fs.readFileSync(new URL('../shared/chapterWritingPrompt.ts', import.meta.url), 'utf8');
const chapterPrompt = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(chapterPromptSource, {
    compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
}).outputText).toString('base64')}`);
vm.runInNewContext(compiled, {exports: mod.exports, createHash, randomUUID, ...chapterPrompt,
    assertRequiredString: value => {if (!value) throw new Error('missing value'); return value;},
    createAutomationError: (code, message, details) => Object.assign(new Error(message), {code, details}),
    normalizeAiError: error => error, devLogError: () => {}, normalizeChapterDraftText: text => text,
    appendPlainTextToLexical: (a, b) => a + b,
    INCOMPLETE_CHAPTER_TEXT_CONTRACT: {contractId: 'chapter.draft.incomplete_text', version: '1.0.0'},
    CHAPTER_STATE_PENDING_CONTRACT: {contractId: 'chapter.draft.state_pending', version: '1.0.0'},
});
const harness = new mod.exports.Harness();
let generationCalls = 0, extractionCalls = 0, failExtraction = true;
const checkpoints = new Map();
harness.modelResultStore = {
    getLatest: async ref => checkpoints.get(ref) || null,
    save: async (ref, method, contract, rawText) => {const record = {modelResultRef: ref, sourceMethod: method, contractId: contract.contractId, rawText}; checkpoints.set(ref, record); return record;},
};
harness.aiService = {
    continueWriting: async () => {generationCalls++; return {text: '完整章节正文。', usedContext: [], consistency: {ok: true, issues: []}};},
    extractNarrativeState: async () => {extractionCalls++; if (failExtraction) throw Object.assign(new Error('network interrupted'), {code: 'NETWORK_ERROR'}); return {delta: {knowledgeChanges: [], warnings: []}};},
};
harness.resolveChapterDraftTitle = async () => '第八章';
const payload = {novelId: 'book', chapterId: 'anchor', currentContent: '前章正文', mode: 'new_chapter',
    draftBatchId: 'batch', childIndex: 7, generationRevision: 1,
    batchContext: {requireVerifiedState: true, currentBeat: {title: '第八章'}, stateLedger: {}}, preparedContext: {hardContext: {}}};
await assert.rejects(harness.createChapterDraftSession(payload, {}, {deferPersistence: true}), error => {
    assert.equal(error.code, 'NARRATIVE_STATE_EXTRACTION_FAILED');
    assert.equal(error.details.textPersisted, true);
    assert.equal(checkpoints.has(error.details.generationCheckpointRef), true);
    return true;
});
assert.equal(generationCalls, 1);
failExtraction = false;
const resumed = await harness.createChapterDraftSession(payload, {}, {deferPersistence: true});
assert.equal(generationCalls, 1, 'Resume must reuse complete prose and only extract state again');
assert.equal(extractionCalls, 2);
assert.equal(resumed.sessionInput.payload.generatedText, '完整章节正文。');
assert.ok(resumed.progress.stateDelta);
// Old batches preserve their warning policy; the warning no longer presents plans as facts.
failExtraction = true;
const legacy = await harness.createChapterDraftSession({...payload, childIndex: 1,
    batchContext: {...payload.batchContext, requireVerifiedState: false}}, {}, {deferPersistence: true});
assert.equal(generationCalls, 2);
assert.match(legacy.sessionInput.payload.warnings[0], /实际状态未验证/);
// Corrupt saved results must fail visibly, never trigger another paid prose request.
const record = [...checkpoints.values()][0];
record.rawText = 'bad JSON';
await assert.rejects(harness.createChapterDraftSession(payload, {}, {deferPersistence: true}), error => error.code === 'PERSISTENCE_ERROR');
assert.equal(generationCalls, 2);
console.log('Chapter state checkpoint tests passed.');
