import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const rawSource = await readFile(new URL('../electron/ai/TaskOutputBudget.ts', import.meta.url), 'utf8');
const aiServiceSource = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const operationIdsSource = await readFile(new URL('../shared/agentOperationIds.ts', import.meta.url), 'utf8');
const source = rawSource
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^import type .*;\r?\n/gm, '');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const stubs = `
const PRODUCT_OUTPUT_SAFETY_LIMIT = 32768;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
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

const automaticState = resolveTaskOutputBudget({
    task: 'narrative_state', mode: 'auto', providerType: 'http', model: 'deepseek-test',
    manualMaxTokens: 3200, promptInput: 'short',
});
assert.equal(automaticState.initialTokens, 8192);
assert.equal(automaticState.recoveryTokens, 16384);
assert.equal(automaticState.canIncreaseOnce, true);

const legacyManual = resolveTaskOutputBudget({
    task: 'chapter_draft', mode: 'manual', providerType: 'http', model: 'deepseek-test',
    manualMaxTokens: 4096, promptInput: 'short', targetLength: 2000,
});
assert.equal(legacyManual.initialTokens, 4096);
assert.equal(legacyManual.recoveryTokens, 4096);
assert.equal(legacyManual.canIncreaseOnce, false);
assert.equal(legacyManual.userMaximumTokens, 4096);

for (const task of ['chapter_draft', 'creative_assets', 'plan', 'editor_review', 'narrative_state']) {
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
    ['skill_plan', 16384, 32768],
    ['skill_document', 16384, 32768],
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
    assert.equal(manual.initialTokens, Math.min(16384, recovery));
    assert.equal(manual.canIncreaseOnce, false);
}
const fallbackManual = resolveTaskOutputBudget({
    task: 'skill_plan', mode: 'manual', providerType: 'http', model: 'test',
    manualMaxTokens: 0, promptInput: 'short',
});
assert.equal(fallbackManual.initialTokens, 32768);

for (const task of ['skill_plan', 'skill_document']) {
    const smallModel = resolveTaskOutputBudget({
        task, mode: 'auto', providerType: 'http', model: 'known-small',
        manualMaxTokens: 32768, promptInput: 'short',
    });
    assert.equal(smallModel.initialTokens, 8192);
    assert.equal(smallModel.canIncreaseOnce, false);
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

// Exercise the actual Skill call sites: both must reserve recovery space and
// pass the uncapped task budget through to the provider wrapper.
const skillMethodNames = ['planAgentStyleSkillPack', 'generateAgentSkillDocument'];
const skillMethods = [...skillMethodNames, 'evaluateStyleQuality'].map(name => serviceClass.members.find(node => node.name?.getText(serviceAst) === name));
const skillJs = ts.transpileModule(`
${operationIdsSource}
const capTaskOutputBudget = ${capTaskOutputBudget.toString()};
const trimText = (value, max) => String(value || '').trim().slice(0, max);
export class SkillHarness { ${skillMethods.map(method => method.getText(serviceAst)).join('\n')} }
`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { SkillHarness } = await import(`data:text/javascript;base64,${Buffer.from(skillJs).toString('base64')}`);
for (const mode of ['manual', 'auto']) {
    for (const method of skillMethodNames) {
        const harness = new SkillHarness();
        harness.settingsCache = { http: { maxTokens: 32768, temperature: 0.2, timeoutMs: 120000 } };
        harness.resolveGenerationBudget = (task, input) => resolveTaskOutputBudget({
            task, mode, providerType: 'http', model: 'test', manualMaxTokens: 32768, ...input,
        });
        let reserve, actual, recovery;
        harness.assembleAgentPrompt = input => { reserve = input.outputTokens; return '{}'; };
        const generate = async (request, budget) => {
            actual = request.maxTokens;
            recovery = budget.recoveryTokens;
            return { text: method === 'planAgentStyleSkillPack'
                ? '{"skills":[{},{}],"pack":{}}' : '---\nname: test\n---\nMethod' };
        };
        harness.generateStructuredWithBudgetRecovery = generate;
        harness.generateWithBudgetRecovery = async (_provider, request, budget) => generate(request, budget);
        harness.checkpointAndParseStructuredResponse = async text => JSON.parse(text);
        await harness[method]({ goal: 'Extract a reusable method', source: { chapters: [] } });
        assert.equal(actual, mode === 'manual' ? 32768 : 16384);
        assert.equal(recovery, 32768);
        assert.equal(reserve, recovery);
    }
}

// The failing real request was manual 32768, not a default 8192 call.
// Exercise the quality call site under both modes and stage/model caps.
for (const mode of ['manual', 'auto']) {
    for (const ceiling of [8192, 32768]) {
        const harness = new SkillHarness();
        harness.settingsCache = { http: { maxTokens: 32768, timeoutMs: 120000 } };
        harness.resolveGenerationBudget = (task, input) => resolveTaskOutputBudget({
            task, mode, providerType: 'http', model: 'test', manualMaxTokens: 32768, ...input,
        });
        const candidates = Array.from({ length: 8 }, (_, i) => ({ findingRef: String(i) }));
        let reserve;
        harness.assembleAgentPrompt = input => {
            reserve = input.outputTokens;
            assert.deepEqual(input.sections[0].value.candidates, candidates);
            return '{}';
        };
        harness.generateStructuredWithBudgetRecovery = async (request, budget, stage) => {
            assert.equal(stage, 'agent.style_quality');
            assert.equal(request.maxTokens, mode === 'manual' ? ceiling : 8192);
            assert.equal(budget.recoveryTokens, Math.min(mode === 'manual' ? 32768 : 16384, ceiling));
            assert.equal(reserve, budget.recoveryTokens);
            return { text: '{"phase":"evidence","decisions":[]}' };
        };
        harness.checkpointAndParseStructuredResponse = text => JSON.parse(text);
        await harness.evaluateStyleQuality({ phase: 'evidence', source: { candidates },
            executionBudget: { initialTokens: ceiling, recoveryTokens: ceiling } });
    }
}

const recoveryMethod = serviceClass.members.find(node => node.name?.getText(serviceAst) === 'generateWithBudgetRecovery');
const recoveryJs = ts.transpileModule(`
const normalizeAiError = error => error;
const devLog = () => {};
export class RecoveryHarness { ${recoveryMethod.getText(serviceAst)} }
`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { RecoveryHarness } = await import(`data:text/javascript;base64,${Buffer.from(recoveryJs).toString('base64')}`);
for (const task of ['skill_plan', 'skill_document']) {
    for (const mode of ['auto', 'manual']) {
        const harness = new RecoveryHarness();
        const budget = resolveTaskOutputBudget({
            task, mode, providerType: 'http', model: 'test', manualMaxTokens: 16384, promptInput: 'short',
        });
        const failure = Object.assign(new Error('truncated'), {
            code: 'MODEL_OUTPUT_TRUNCATED', details: { safeToRetryBeforePublish: true },
        });
        const attempts = [];
        const generate = async request => {
            attempts.push(request.maxTokens);
            if (attempts.length === 1) throw failure;
            return { text: 'complete' };
        };
        const invoke = () => harness.generateWithBudgetRecovery(generate, { timeoutMs: 210000 }, budget, task);
        if (mode === 'auto') {
            const result = await invoke();
            assert.deepEqual(attempts, [16384, 32768]);
            assert.equal(result.attemptCount, 2);
        } else {
            await assert.rejects(invoke, error => error === failure);
            assert.deepEqual(attempts, [16384]);
        }
    }
}

console.log('Task output budget tests passed.');
