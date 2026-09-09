import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const policySource = await readFile(new URL('../shared/writingPolicy.ts', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const automationSource = await readFile(new URL('../electron/automation/AutomationService.ts', import.meta.url), 'utf8');
const automationAst = ts.createSourceFile('AutomationService.ts', automationSource, ts.ScriptTarget.Latest, true);
const automationClass = automationAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AutomationService');
const reviseMethod = automationClass.members.find(node => node.name?.getText(automationAst) === 'reviseChapterDraftSession').getText(automationAst);
const ast = ts.createSourceFile('AiService.ts', serviceSource, ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AiService');
const methods = ['continueWriting', 'buildContinuePromptBundle', 'generateWithBudgetRecovery'].map(name =>
    service.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n');
const harnessSource = `${policySource}
const trimText = (value, max) => String(value || '').trim().slice(0, max);
const extractPlainTextFromLexical = text => text || '';
const assertRequiredString = value => value;
const assertRequiredNumber = value => value;
const normalizeChapterDraftText = value => value;
const appendPlainTextToLexical = (base, text) => base + text;
const devLog = () => {};
const normalizeAiError = error => error;
const db = { novel: { findUnique: async () => ({ formatting: '{"writing":{"chapterTargetLength":2700}}' }) } };
const DRAFT_GENERATION_TIMEOUT_MS = 360000, DRAFT_FIRST_BYTE_TIMEOUT_MS = 60000, DRAFT_STREAM_IDLE_TIMEOUT_MS = 60000;
class AiActionError extends Error { constructor(code, message, detail, details) { super(message); this.code = code; this.details = details; } }
export class Harness { ${methods} }
export class RevisionHarness { ${reviseMethod} }
`;
const js = ts.transpileModule(harnessSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { Harness, RevisionHarness, resolveWritingLength, countWritingUnits, novelChapterLength } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
assert.equal(resolveWritingLength({ mode: 'new_chapter' }).target, 2300);
assert.equal(resolveWritingLength({ mode: 'continue_chapter' }).target, 500);
assert.equal(resolveWritingLength({ mode: 'rewrite_chapter', novelDefault: 3000 }).target, 3000);
assert.equal(resolveWritingLength({ mode: 'new_chapter', novelDefault: 3000, targetLength: 2500 }).target, 2500);
assert.deepEqual(resolveWritingLength({ userIntent: '首章正文1800—2200个汉字', targetLength: 500 }), { target: 2000, min: 1800, max: 2200, source: 'request' });
assert.equal(resolveWritingLength({ userIntent: '写两千三百字' }).target, 2300);
assert.equal(resolveWritingLength({ userIntent: '完整正文2.3千字' }).target, 2300);
assert.equal(resolveWritingLength({ userIntent: '当前实测仅1371个汉字，请输出约2300字，增加约650汉字的行动。' }).target, 2300);
assert.equal(resolveWritingLength({ userIntent: '正文2300字\n会话背景（仅用于理解当前任务）以前写500字' }).target, 2300);
assert.equal(countWritingUnits('甲乙，丙。\n123 abc'), 3);
assert.equal(novelChapterLength('{"writing":{"chapterTargetLength":2800}}'), 2800);
assert.equal(novelChapterLength('bad'), undefined);

const context = {
    params: { targetLength: 500, novelChapterLength: 2800 }, policy: { version: 'continuation-context-v1' },
    snapshot: { novelId: 'n', anchorChapterId: 'c', chapterSources: [], narrativeSummaryIds: [] },
    hardContext: {}, dynamicContext: {}, usedContext: [], warnings: [], currentContentSource: '',
};
const budget = { initialTokens: 18432, recoveryTokens: 32768, totalTaskTokens: 51200, canIncreaseOnce: true };
function harness(outputs) {
    const instance = new Harness();
    const requests = [];
    const provider = { generate: async request => {
        requests.push(request);
        const next = outputs.shift();
        if (next instanceof Error) throw next;
        if (typeof next === 'function') return next(request);
        return { text: next, finishReason: 'completed', requestedMaxTokens: request.maxTokens };
    } };
    instance.settingsCache = { http: { temperature: 0.5, timeoutMs: 360000 }, summary: { recentChapterRawCount: 2 } };
    instance.getProvider = () => provider;
    instance.contextBuilder = { buildForContinueWriting: async () => structuredClone(context) };
    instance.compactContinueHardContext = value => value;
    instance.compactContinueDynamicContext = value => value;
    instance.resolveGenerationBudget = () => budget;
    instance.assembleDraftGenerationPrompt = value => JSON.stringify(value);
    instance.checkConsistency = async () => ({ ok: true, issues: [] });
    return { instance, requests };
}
const payload = { novelId: 'n', chapterId: 'c', mode: 'new_chapter', userIntent: '写2300字左右的完整章节', locale: 'zh-CN' };
const success = harness(['文'.repeat(2300)]);
const result = await success.instance.continueWriting(payload);
assert.equal(success.requests.length, 1);
assert.equal(result.generation.lengthValidation.withinRange, true);
const prompt = JSON.parse(success.requests[0].prompt);
assert.equal(prompt.outputTokens, 32768, 'Context must reserve enough room for the bounded recovery');
assert.equal(prompt.structured.params.targetLength, 2300);
assert.match(prompt.effectiveUserPrompt, /2300汉字/);
assert.doesNotMatch(prompt.effectiveUserPrompt, /约500汉字/);
assert.doesNotMatch(prompt.effectiveUserPrompt, /写出新章节开场/);
const prepared = harness(['文'.repeat(2700)]);
const preparedResult = await prepared.instance.continueWriting({ novelId: 'n', chapterId: 'c', mode: 'new_chapter', preparedContext: context });
assert.equal(preparedResult.generation.lengthValidation.target, 2700, 'Prepared context must use the current novel preference');
assert.match(JSON.parse(prepared.requests[0].prompt).effectiveUserPrompt, /2700汉字/);
const short = harness(['文'.repeat(1200), '文'.repeat(2300)]);
const repaired = await short.instance.continueWriting(payload);
assert.equal(short.requests.length, 2);
assert.equal(repaired.generation.lengthValidation.withinRange, true);
assert.equal(repaired.generation.lengthValidation.repairAttempted, true);
assert.ok(short.requests[1].timeoutMs <= short.requests[0].timeoutMs);
assert.equal(short.requests[1].maxTokens, 18432);
const stillShort = harness(['文'.repeat(1200), '文'.repeat(1300)]);
const stillShortResult = await stillShort.instance.continueWriting(payload);
assert.equal(stillShort.requests.length, 2);
assert.equal(stillShortResult.generation.lengthValidation.withinRange, false);
assert.ok(stillShortResult.warnings.some(w => w.includes('篇幅待审核')));
const failure = harness(['文'.repeat(1200), Object.assign(new Error('provider unavailable'), { code: 'NETWORK_ERROR' })]);
const preserved = await failure.instance.continueWriting(payload);
assert.equal(preserved.text, '文'.repeat(1200));
assert.equal(preserved.generation.attemptCount, 2);
assert.ok(preserved.warnings.some(w => w.includes('此前完整草稿')));
const controller = new AbortController();
const cancelled = harness(['文'.repeat(1200), () => { controller.abort(); throw controller.signal.reason; }]);
await assert.rejects(cancelled.instance.continueWriting(payload, controller.signal));
const revision = new RevisionHarness();
revision.draftStore = {
    getById: async () => ({ draftSessionId: 'draft', version: 1, type: 'chapter-draft', status: 'draft', novelId: 'n', chapterId: 'c', payload: {
        chapterId: 'c', generatedText: '原稿', baseContent: '', generation: { lengthValidation: { target: 2150, min: 2000, max: 2300 } },
    } }),
    create: async value => value,
};
revision.resolveChapterDraftTitle = async () => '章节';
let revisionRequest;
revision.aiService = { continueWriting: async value => { revisionRequest = value; return { text: '修订稿', usedContext: [], consistency: { ok: true, issues: [] } }; } };
const reviseInput = { sourceDraftSessionId: 'draft', sourceDraftVersion: 1, reviewRequestId: 'review', comments: [{ reviewVersionId: 'draft', anchor: { targetId: 'c' }, body: '改正时间线' }] };
await revision.reviseChapterDraftSession(reviseInput, {});
assert.deepEqual(resolveWritingLength(revisionRequest), { target: 2150, min: 2000, max: 2300, source: 'request' });
await revision.reviseChapterDraftSession({ ...reviseInput, comments: [{ ...reviseInput.comments[0], body: '扩写为3000字' }] }, {});
assert.equal(resolveWritingLength(revisionRequest).target, 3000, 'A new review length request overrides the original range');
console.log('Writing policy and generation length recovery tests passed.');
