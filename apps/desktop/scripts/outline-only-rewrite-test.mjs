import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const compile = (code, module = ts.ModuleKind.CommonJS) => ts.transpileModule(code,
    {compilerOptions: {module, target: ts.ScriptTarget.ES2022}}).outputText;
const load = async path => import(`data:text/javascript;base64,${Buffer.from(compile(await read(path), ts.ModuleKind.ESNext)).toString('base64')}`);
const prompts = await load('../shared/chapterWritingPrompt.ts');
const policy = await load('../shared/writingPolicy.ts');
const quality = await load('../shared/chapterGenerationQuality.ts');
const lexical = await load('../shared/lexicalDocument.ts');
const poison = 'OLD_PROSE_OR_HISTORY_MUST_NOT_REACH_PROVIDER';
const dbReads = [];
const db = {
    chapter: {findUnique: async q => {dbReads.push(q);
        if (!q.select.content) assert.deepEqual(Object.keys(q.select).sort(), ['deleted', 'id', 'volume']);
        return {id: 'c1', version: 7, content: poison, deleted: false, volume: {novelId: 'book'}};}},
    novel: {findUnique: async () => ({formatting: '{}'})},
    worldSetting: {findMany: async q => {assert.deepEqual(Array.from(q.where.id.notIn), ['legacy-style']);
        return [{id: 'rule', name: '轮班', type: 'other', content: '交接需要登记'}];}},
    plotLine: {findMany: async q => {assert.equal(q.select.points.select.anchors, undefined);
        assert.equal(q.select.points.select.status, undefined);
        return [{name: '主线', points: [{title: '后章计划', description: '不能提前兑现'}]}];}},
    character: {findMany: async () => [{id: 'person', name: '沈砚', role: '主角', description: '新值守人'}]},
    item: {findMany: async () => []}, mapCanvas: {findMany: async () => []},
    chapterSummary: {findMany: () => {throw new Error('Read old chapter summary');}},
    narrativeSummary: {findMany: () => {throw new Error('Read old narrative summary');}},
    volume: {findMany: () => {throw new Error('Read old chapter catalog');}},
};
const sandbox = {exports: {}, db, createHash, randomUUID, ...prompts, ...policy, ...quality,
    extractReadableText: value => value, extractPlainTextFromLexical: value => value || '',
    trimText: (value, max) => String(value || '').trim().slice(0, max), dedupeStrings: value => [...new Set(value)],
    devLog: () => {}, devLogError: () => {}, normalizeAiError: value => value,
    assertRequiredString: (value, name) => {if (!value) throw new Error(name); return value;},
    createAutomationError: (code, message) => Object.assign(new Error(message), {code}),
    normalizeChapterDraftText: value => value,
    appendPlainTextToLexical: (a, b) => `${a}${b}`,
    ensureLexicalDocument: lexical.ensureLexicalDocument,
    assertAgentSkillInPrompt: () => {},
    DRAFT_GENERATION_TIMEOUT_MS: 360000, DRAFT_FIRST_BYTE_TIMEOUT_MS: 60000, DRAFT_STREAM_IDLE_TIMEOUT_MS: 60000,
};
const contextRaw = await read('../electron/ai/context/ContextBuilder.ts');
const contextAst = ts.createSourceFile('context.ts', contextRaw, ts.ScriptTarget.Latest, true);
vm.runInNewContext(compile(contextAst.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(contextAst)).join('\n')), sandbox);
const builder = new sandbox.exports.ContextBuilder();
const raw = {novelId: 'book', chapterId: 'c1', mode: 'rewrite_chapter', sourcePolicy: 'outline_only',
    currentContent: poison, userIntent: poison, overrideUserPrompt: poison, currentLocation: poison, ideaIds: [poison],
    preparedContext: {policy: {version: 'continuation-context-v1'}, snapshot: {novelId: 'book', anchorChapterId: 'c1'}, hardContext: {worldSettings: [poison]}},
    batchContext: {currentBeat: poison, recentFullDrafts: [poison], stateLedger: poison},
    freshWritingBrief: '依据设定重新写交接场景，1800—2400汉字。', excludedWorldSettingIds: ['legacy-style']};
const context = await builder.buildForContinueWriting(raw);
assert.equal(context.currentContentSource, '');
assert.equal(context.policy.sourcePolicy, 'outline_only');
assert.equal(context.snapshot.chapterSources.length, 0);
assert.equal(context.snapshot.narrativeSummaryIds.length, 0);
assert.equal(context.dynamicContext.recentChapters.length, 0);
assert.equal(context.hardContext.plotLines[0].points[0].status, 'planned');
assert.ok(!JSON.stringify(context).includes(poison));
assert.equal(dbReads.length, 1);
assert.equal(dbReads[0].select.content, undefined);
assert.equal(raw.currentContent, poison, 'Do not mutate caller state');
assert.throws(() => prompts.prepareChapterWritingPayload({...raw, freshWritingBrief: ''}), /freshWritingBrief/);
assert.throws(() => prompts.prepareChapterWritingPayload({...raw, mode: 'continue_chapter'}), /rewrite_chapter/);
assert.throws(() => prompts.prepareChapterWritingPayload({...raw, draftBatchId: 'old-batch'}), /single chapter/);
assert.throws(() => prompts.prepareChapterWritingPayload({...raw, sourcePolicy: 'typo'}), /Unknown/);
const legacy = {mode: 'rewrite_chapter', currentContent: poison};
assert.equal(prompts.prepareChapterWritingPayload(legacy), legacy);

async function classMethods(file, name, methods) {
    const source = await read(file), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === name);
    return methods.map(method => cls.members.find(n => n.name?.getText(ast) === method && n.body).getText(ast)).join('\n');
}
vm.runInNewContext(compile(`class AiHarness {${await classMethods('../electron/ai/AiService.ts', 'AiService',
    ['buildContinuePromptBundle', 'compactContinueHardContext', 'compactContinueDynamicContext', 'continueWriting'])}}; exports.AiHarness = AiHarness;`), sandbox);
let providerInput;
const boundary = new Error('Provider reached');
const ai = Object.assign(new sandbox.exports.AiHarness(), {
    contextBuilder: builder, settingsCache: {providerType: 'http', summary: {recentChapterRawCount: 2}, http: {temperature: .7, timeoutMs: 120000}},
    resolveGenerationBudget: () => ({initialTokens: 8000, recoveryTokens: 12000}),
    assembleDraftGenerationPrompt: input => JSON.stringify(input),
    generateWithBudgetRecovery: (generate, request) => generate(request),
    getProvider: () => ({generate: async input => {providerInput = input; throw boundary;}}),
});
await assert.rejects(ai.continueWriting(raw), error => error === boundary);
assert.ok(providerInput.prompt.includes(raw.freshWritingBrief));
assert.ok(!JSON.stringify(providerInput).includes(poison), 'Poison cannot reenter from cached context, intent, override, location or beats');
assert.ok(!providerInput.prompt.includes('是待改写原文'));

vm.runInNewContext(compile(`class DraftHarness {${await classMethods('../electron/automation/AutomationService.ts', 'AutomationService',
    ['createChapterDraftSession', 'buildPromptPreviewPayload', 'commitDraftSerialized'])}}; exports.DraftHarness = DraftHarness;`), sandbox);
let received;
const draft = Object.assign(new sandbox.exports.DraftHarness(), {
    aiService: {continueWriting: async input => {received = input;
        return {text: '全新正文。', usedContext: context.usedContext, contextPolicy: context.policy, consistency: {ok: true, issues: []}};}},
    resolveChapterDraftTitle: async () => '第一章',
});
const result = await draft.createChapterDraftSession(raw, {}, {deferPersistence: true});
const previewPayload = draft.buildPromptPreviewPayload('chapter', {...raw, currentContent: ''});
assert.equal(previewPayload.currentContent, '');
assert.equal(previewPayload.userIntent, raw.freshWritingBrief);
assert.equal(received.currentContent, '');
assert.equal(received.preparedContext, undefined);
assert.equal(lexical.extractReadableText(result.sessionInput.payload.content), '全新正文。', 'Replace rather than append');
assert.equal(result.sessionInput.payload.writeMode, 'replace');
assert.equal(result.sessionInput.payload.baseContent, poison, 'Keep old prose only for editor comparison');
assert.equal(result.sessionInput.payload.sourceSnapshot.version, 7, 'Retain optimistic commit conflict protection');
let session = {...result.sessionInput, draftSessionId: 'fresh', version: 1};
let storedChapter = {id: 'c1', title: '第一章', volumeId: 'volume', order: 1, content: poison,
    wordCount: poison.length, version: 7, deleted: false, volume: {novelId: 'book'}};
Object.assign(sandbox, {assertRequiredNumber: value => value, extractReadableText: lexical.extractReadableText,
    searchIndex: {indexChapter: async () => {}}, scheduleChapterSummaryRebuild: () => {}});
db.$transaction = async callback => callback({
    chapter: {findUnique: async () => storedChapter, update: async ({data}) => {
        storedChapter = {...storedChapter, ...data, version: storedChapter.version + 1}; return storedChapter;
    }}, novel: {update: async () => {}},
});
draft.draftStore = {getById: async () => session, update: async (id, version, update) => {
    assert.equal(version, session.version); session = {...update(session), version: version + 1}; return session;
}};
const committed = await draft.commitDraftSerialized({draftSessionId: 'fresh', version: 1});
assert.equal(lexical.extractReadableText(storedChapter.content), '全新正文。', 'Commit replaces, not just preview');
assert.equal(committed.session.writebacks[0].chapters[0].beforeContent, poison, 'Undo retains original content');
assert.equal(storedChapter.version, 8);
session = {...result.sessionInput, draftSessionId: 'stale', version: 1};
await assert.rejects(draft.commitDraftSerialized({draftSessionId: 'stale', version: 1}), error => error.code === 'VERSION_CONFLICT');
assert.equal(storedChapter.version, 8, 'Stale generation cannot overwrite a newer chapter');
console.log('outline-only-rewrite: PASS (context/provider isolation; replacement preview and commit; undo snapshot; stale version rejected)');
