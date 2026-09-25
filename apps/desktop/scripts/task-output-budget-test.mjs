import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const rawSource = await readFile(new URL('../electron/ai/TaskOutputBudget.ts', import.meta.url), 'utf8');
const aiServiceSource = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const source = rawSource
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^import type .*;\r?\n/gm, '');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const stubs = `
const PRODUCT_OUTPUT_SAFETY_LIMIT = 32768;
function resolveModelOutputCapability(model) {
    return model === 'known-small' ? { maximumTokens: 8192, source: 'test-profile' } : { source: 'unknown' };
}
class AgentContextTokenCounter {
    count(input) { return { providerInputTokens: input.prompt.length + (input.systemPrompt || '').length }; }
}
function resolveAgentModelContextCapability() {
    return { defaultContextWindowTokens: 131072 };
}
`;
const { resolveTaskOutputBudget, capTaskOutputBudget } = await import(
    `data:text/javascript;base64,${Buffer.from(stubs + output).toString('base64')}`
);

const automaticChapter = resolveTaskOutputBudget({
    task: 'chapter_draft', mode: 'auto', providerType: 'http', model: 'deepseek-test',
    manualMaxTokens: 4096, promptInput: 'short', targetLength: 2000,
});
assert.equal(automaticChapter.initialTokens, 18432);
assert.equal(automaticChapter.recoveryTokens, 32768);
assert.equal(automaticChapter.totalTaskTokens, 51200);
assert.equal(automaticChapter.canIncreaseOnce, true);
assert.equal(automaticChapter.userMaximumTokens, undefined);

const legacyManual = resolveTaskOutputBudget({
    task: 'chapter_draft', mode: 'manual', providerType: 'http', model: 'deepseek-test',
    manualMaxTokens: 4096, promptInput: 'short', targetLength: 2000,
});
assert.equal(legacyManual.initialTokens, 4096);
assert.equal(legacyManual.recoveryTokens, 4096);
assert.equal(legacyManual.canIncreaseOnce, false);
assert.equal(legacyManual.userMaximumTokens, 4096);

for (const task of ['chapter_draft', 'creative_assets', 'plan', 'editor_review']) {
    for (const manualMaxTokens of [8_192, 16_384, 32_768]) {
        const manual = resolveTaskOutputBudget({
            task, mode: 'manual', providerType: 'http', model: 'deepseek-test',
            manualMaxTokens, promptInput: 'short',
        });
        assert.equal(manual.initialTokens, manualMaxTokens);
        assert.equal(manual.recoveryTokens, manualMaxTokens);
        assert.equal(manual.canIncreaseOnce, false);
        assert.equal(manual.totalTaskTokens, manualMaxTokens);
    }
}

const modelLimited = resolveTaskOutputBudget({
    task: 'chapter_draft', mode: 'manual', providerType: 'http', model: 'test',
    manualMaxTokens: 65_536, promptInput: 'short',
});
assert.equal(modelLimited.modelMaximumTokens, undefined);
assert.equal(modelLimited.initialTokens, modelLimited.productMaximumTokens);
assert.equal(modelLimited.initialTokens, 32_768);
const knownModel = resolveTaskOutputBudget({
    task: 'chapter_draft', mode: 'auto', providerType: 'http', model: 'known-small',
    manualMaxTokens: 65536, promptInput: 'short',
});
assert.equal(knownModel.initialTokens, 8192);
assert.equal(knownModel.modelMaximumTokens, 8192);
assert.equal(knownModel.canIncreaseOnce, false);

const contextLimited = resolveTaskOutputBudget({
    task: 'chapter_draft', mode: 'manual', providerType: 'http', model: 'test',
    configuredContextWindowTokens: 16_384, manualMaxTokens: 16_384,
    promptInput: 'x'.repeat(6000),
});
assert.equal(contextLimited.initialTokens, 16_384 - 6000 - 512);
assert.equal(contextLimited.canIncreaseOnce, false);

const constrained = resolveTaskOutputBudget({
    task: 'creative_assets', mode: 'auto', providerType: 'http', model: 'test',
    configuredContextWindowTokens: 8192, manualMaxTokens: 4096,
    promptInput: 'x'.repeat(7600), itemCount: 7,
});
assert.ok(constrained.initialTokens <= constrained.contextMaximumTokens);
assert.equal(constrained.canIncreaseOnce, false);

const automaticPlan = resolveTaskOutputBudget({
    task: 'plan', mode: 'auto', providerType: 'http', model: 'test',
    manualMaxTokens: 4096, promptInput: 'short',
});
assert.equal(automaticPlan.initialTokens, 4096);
assert.equal(automaticPlan.recoveryTokens, 8192);
for (const [task, initial, recovery] of [
    ['rag_qa', 2048, 4096],
    ['research_report', 8192, 16384],
]) {
    const automatic = resolveTaskOutputBudget({
        task, mode: 'auto', providerType: 'http', model: 'test',
        manualMaxTokens: 4096, promptInput: 'short',
    });
    assert.equal(automatic.initialTokens, initial);
    assert.equal(automatic.recoveryTokens, recovery);
    assert.equal(automatic.canIncreaseOnce, true);
    const manual = capTaskOutputBudget(resolveTaskOutputBudget({
        task, mode: 'manual', providerType: 'http', model: 'test',
        manualMaxTokens: 16384, promptInput: 'short',
    }), recovery);
    assert.equal(manual.initialTokens, recovery);
    assert.equal(manual.canIncreaseOnce, false);
}
const limitedRecovery = capTaskOutputBudget(automaticPlan, 6000);
assert.equal(limitedRecovery.initialTokens, 4096);
assert.equal(limitedRecovery.recoveryTokens, 6000);
assert.equal(limitedRecovery.totalTaskTokens, 10096);
assert.equal(limitedRecovery.canIncreaseOnce, true);
const noRecoverySpace = capTaskOutputBudget(automaticPlan, 3000);
assert.equal(noRecoverySpace.initialTokens, 3000);
assert.equal(noRecoverySpace.recoveryTokens, 3000);
assert.equal(noRecoverySpace.totalTaskTokens, 3000);
assert.equal(noRecoverySpace.canIncreaseOnce, false);

// Execute the production planner method with only its I/O dependencies stubbed.
// This catches a call-site cap even when the budget calculator itself is correct.
const serviceAst = ts.createSourceFile('AiService.ts', aiServiceSource, ts.ScriptTarget.Latest, true);
const serviceClass = serviceAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AiService');
const plannerMethod = serviceClass.members.find(node => node.name?.getText(serviceAst) === 'generateAgentPlan');
const plannerJs = ts.transpileModule(`
const trimText = (value, max) => String(value || '').trim().slice(0, max);
const dedupeStrings = (values, max) => [...new Set(values)].slice(0, max);
export class PlannerHarness { ${plannerMethod.getText(serviceAst)} }
`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { PlannerHarness } = await import(`data:text/javascript;base64,${Buffer.from(plannerJs).toString('base64')}`);
for (const mode of ['manual', 'auto']) {
    const planner = new PlannerHarness();
    planner.settingsCache = { http: { maxTokens: 16384, temperature: 0.2, timeoutMs: 120000 } };
    planner.resolveGenerationBudget = (task, input) => resolveTaskOutputBudget({
        task, mode, providerType: 'http', model: 'test', manualMaxTokens: 16384, ...input,
    });
    let reserve, actual, recovery;
    planner.assembleAgentPrompt = input => { reserve = input.outputTokens; return '{}'; };
    planner.generateStructuredWithBudgetRecovery = async (request, budget, stage) => {
        actual = request.maxTokens;
        recovery = budget.recoveryTokens;
        assert.equal(stage, 'agent.generate_plan');
        return { text: '{"title":"计划","steps":[]}' };
    };
    planner.checkpointAndParseStructuredResponse = async text => JSON.parse(text);
    await planner.generateAgentPlan({ goal: '撰写第一章', availableTools: ['chapter.generate_draft'] });
    assert.equal(actual, mode === 'manual' ? 16384 : 4096);
    assert.equal(recovery, mode === 'manual' ? 16384 : 8192);
    assert.equal(reserve, recovery);
}

assert.match(aiServiceSource, /taskDeadlineAt - Date\.now\(\) >= 1_000/u);
assert.match(aiServiceSource, /remainingTimeoutMs/u);
assert.match(aiServiceSource, /!request\.signal\?\.aborted/u);
assert.match(aiServiceSource, /outer operation retry multiply provider requests[\s\S]*retryable: false/u);
assert.match(aiServiceSource, /resolveGenerationBudget\('editor_review'/u);
assert.match(aiServiceSource, /agent\.generate_consistency_review'\);/u);
assert.match(aiServiceSource, /capTaskOutputBudget\(taskOutputBudget, outputTokens\)/u);
assert.match(aiServiceSource, /agent\.generate_chat'\);/u);
assert.match(aiServiceSource, /resolveGenerationBudget\('research_report'/u);
assert.match(aiServiceSource, /agent\.generate_research_fact_check'\);/u);
assert.match(aiServiceSource, /resolveGenerationBudget\('rag_qa'/u);

console.log('Task output budget tests passed.');
