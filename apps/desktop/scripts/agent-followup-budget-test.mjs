import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AiService.ts', source, ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AiService');
const method = service.members.find(node => node.name?.getText(ast) === 'generateAgentUserInputFollowup').getText(ast);
const blueprint = service.members.find(node => node.name?.getText(ast) === 'generateAgentNovelBootstrap').getText(ast);
const report = service.members.find(node => node.name?.getText(ast) === 'generateAgentReport').getText(ast);
const beats = service.members.find(node => node.name?.getText(ast) === 'generateChapterBeats').getText(ast);
const output = ts.transpileModule(`
const trimText = (value, max) => String(value || '').trim().slice(0, max);
const db = { novel: { findUnique: async () => ({ title: 'Test', description: '' }) } };
class AiActionError extends Error {}
const DEFAULT_CHAPTER_LENGTH = 2300;
export class Harness { ${method} ${blueprint} ${report} ${beats} }
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { Harness } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

for (const initialTokens of [4096, 16384]) {
    const instance = new Harness();
    instance.settingsCache = { http: { maxTokens: initialTokens, temperature: 0.2, timeoutMs: 60000 } };
    const budget = { initialTokens, recoveryTokens: initialTokens === 4096 ? 8192 : 16384 };
    instance.resolveGenerationBudget = (task, input) => {
        assert.equal(task, 'intent');
        assert.match(input.promptInput, /Goal=Initialize novel/);
        return budget;
    };
    const controller = new AbortController();
    let calls = 0;
    instance.generateStructuredWithBudgetRecovery = async (request, actualBudget, stage) => {
        calls++;
        assert.equal(request.maxTokens, initialTokens, 'Must not silently cap the follow-up at 1800');
        assert.equal(actualBudget, budget);
        assert.equal(stage, 'agent.generate_user_input_followup');
        assert.equal(request.signal, controller.signal);
        assert.equal(request.timeoutMs, 90000);
        return { text: '{"needsFollowUp":false}' };
    };
    instance.checkpointAndParseStructuredResponse = async text => JSON.parse(text);
    assert.deepEqual(await instance.generateAgentUserInputFollowup({
        goal: 'Initialize novel', answers: [{ value: 'Mystery' }], workflow: 'novel_bootstrap', novelId: 'test',
    }, controller.signal), { needsFollowUp: false });
    assert.equal(calls, 1);
    instance.resolveGenerationBudget = (task) => {
        assert.equal(task, 'creative_assets');
        return budget;
    };
    instance.assembleAgentPrompt = input => {
        assert.equal(input.outputTokens, budget.recoveryTokens);
        return 'blueprint prompt';
    };
    instance.generateStructuredWithBudgetRecovery = async (request, actualBudget, stage) => {
        assert.equal(request.maxTokens, initialTokens, 'Blueprint must respect the selected budget');
        assert.equal(actualBudget, budget);
        assert.equal(stage, 'agent.generate_novel_bootstrap');
        assert.equal(request.signal, controller.signal);
        return { text: '{"titleCandidates":["Test"],"characters":[],"openingBeats":[]}' };
    };
    const result = await instance.generateAgentNovelBootstrap({ goal: 'Initialize novel' }, controller.signal);
    assert.deepEqual(result.titleCandidates, ['Test']);
    instance.resolveGenerationBudget = task => {
        assert.equal(task, 'plan');
        return budget;
    };
    instance.generateStructuredWithBudgetRecovery = async (request, actualBudget, stage) => {
        assert.equal(request.maxTokens, initialTokens, 'Report must not silently cap manual output at 4000');
        assert.equal(actualBudget, budget);
        assert.equal(stage, 'agent.generate_report');
        assert.equal(request.signal, controller.signal);
        assert.equal(request.timeoutMs, 180000);
        return { text: '{"content":"Draft preserved","conversationSummary":"Ready for review"}' };
    };
    assert.deepEqual(await instance.generateAgentReport({ goal: 'Initialize novel' }, controller.signal), {
        content: 'Draft preserved', conversationSummary: 'Ready for review',
    });
    instance.resolveGenerationBudget = (task, input) => {
        assert.equal(task, 'plan');
        assert.match(input.promptInput, /AnchorChapterId=chapter-2/);
        return budget;
    };
    instance.generateStructuredWithBudgetRecovery = async (request, actualBudget, stage) => {
        assert.equal(request.maxTokens, initialTokens, 'Chapter beats must not cap manual output at 3200');
        assert.equal(actualBudget, budget);
        assert.equal(stage, 'agent.generate_chapter_beats');
        assert.equal(request.signal, controller.signal);
        return { text: JSON.stringify({ beats: Array.from({ length: 4 }, (_, index) => ({
            title: `Chapter ${index + 3}`, chapterGoal: 'Goal', coreConflict: 'Conflict',
            keyEvents: ['Event'], reveals: [], endingHook: 'Hook', targetWordCount: 2300,
        })) }) };
    };
    const beatResult = await instance.generateChapterBeats({
        novelId: 'novel', chapterId: 'chapter-2', goal: 'Write four chapters',
        chapterCount: 4, locale: 'zh', context: {},
    }, controller.signal);
    assert.equal(beatResult.beats.length, 4);
}
console.log('Agent follow-up budget integration tests passed.');
