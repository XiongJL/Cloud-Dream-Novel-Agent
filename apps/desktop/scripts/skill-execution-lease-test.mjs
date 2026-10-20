import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const load = source => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`);
async function methods(path, className, names) {
    const raw = await readFile(new URL(path, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true);
    const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
    return names.map(name => cls.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n');
}
const aiMethods = await methods('../electron/ai/AiService.ts', 'AiService', [
    'withAgentStructuredInvocation', 'generateStructured', 'generateWithBudgetRecovery',
    'generateStructuredWithBudgetRecovery', 'repairAgentStructuredOutput',
]);
const automationMethod = await methods('../electron/automation/AutomationService.ts', 'AutomationService', ['invokeAgentStructured']);
const { AiHarness, AutomationHarness } = await load(`
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
class AiActionError extends Error {
    constructor(code, message, detail, details) { super(message); Object.assign(this, { code, detail, details }); }
}
const normalizeAiError = value => value;
const getAgentStructuredOutputContract = method => ({ contractId: method, version: 2, schema: {} });
const validateAgentStructuredOutput = () => [];
const buildAgentStructuredOutputInstruction = () => 'registered contract';
const assertAgentSkillInPrompt = () => {};
const devLog = () => {};
const createAutomationError = (code, message, details) => new AiActionError(code, message, undefined, details);
class AgentContextTokenCounter {
    budget(input) { return { hardContextBudget: 50000 - input.outputReserveTokens - Buffer.byteLength(input.systemPrompt, 'utf8') }; }
}
export class AiHarness {
    agentStructuredInvocation = new AsyncLocalStorage();
    settingsCache = { providerType: 'http', http: { model: 'test', maxTokens: 32768, timeoutMs: 120000 } };
    ${aiMethods}
}
export class AutomationHarness { ${automationMethod} }
`);
const harness = new AiHarness();
const lease = { maxCalls: 3, maxOutputTokens: 2048, calls: 0, attempts: [] };
const inv = { method: 'agent.analyze_skill_work_unit', requestId: 'stable', executionLease: lease };
const requests = [];
let truncated = true;
harness.getProvider = () => ({ generate: async request => {
    requests.push(request);
    if (truncated) {
        truncated = false;
        const failure = new Error('truncated');
        Object.assign(failure, { code: 'MODEL_OUTPUT_TRUNCATED', details: {
            safeToRetryBeforePublish: true, usage: { input_tokens: 20, output_tokens: 100 },
        } });
        throw failure;
    }
    return { text: '{"summary":"ok"}', usage: { input_tokens: 20, output_tokens: 80 } };
} });
harness.checkpointAndParseStructuredResponse = async text => JSON.parse(text);
const result = await harness.withAgentStructuredInvocation(inv, async () => {
    await harness.generateStructuredWithBudgetRecovery({ systemPrompt: 'system', prompt: 'source', timeoutMs: 20000 },
        { initialTokens: 1024, recoveryTokens: 2048, totalTaskTokens: 3072, canIncreaseOnce: true }, 'analysis');
    // A nested schema repair shares exactly the same lease and call ledger.
    return harness.withAgentStructuredInvocation({ ...inv, requestId: 'repair' }, () => harness.repairAgentStructuredOutput({
        rawText: '{}', contract: { contractId: 'analysis', version: 2, schema: {} }, validationIssues: [],
    }));
});
assert.equal(result._executionUsage.calls, 3);
assert.deepEqual(requests.map(item => item.maxTokens), [1024, 2048, 2048]);
assert.equal(lease.attempts[0].status, 'failed_or_unknown');
assert.equal(lease.attempts[0].usage.output_tokens, 100);
assert.ok(lease.attempts.slice(1).every(item => item.status === 'completed'));
await assert.rejects(() => harness.withAgentStructuredInvocation(inv, () => harness.generateStructured({
    systemPrompt: 'system', prompt: 'source', maxTokens: 1024,
})), error => error.code === 'CONTEXT_BUDGET_UNSATISFIABLE');
assert.equal(requests.length, 3, 'Exhausted leases cannot call the provider');

const tinyLease = { maxCalls: 1, maxOutputTokens: 2048, calls: 0, attempts: [] };
await assert.rejects(() => harness.withAgentStructuredInvocation({ ...inv, executionLease: tinyLease }, () => harness.generateStructured({
    systemPrompt: 'system', prompt: '原'.repeat(20000), maxTokens: 2048,
})), error => error.code === 'CONTEXT_BUDGET_UNSATISFIABLE');
assert.equal(tinyLease.calls, 0, 'Window rejection occurs before paid dispatch');
const legacy = await harness.withAgentStructuredInvocation({ ...inv, executionLease: undefined }, async () => {
    await harness.generateStructured({ systemPrompt: 'system', prompt: 'source', maxTokens: 12345 });
    return { summary: 'legacy' };
});
assert.equal(requests.at(-1).maxTokens, 12345);
assert.equal(legacy._executionUsage, undefined, 'Ordinary invocations retain their contract and output budget');

// The actual Automation wrapper forwards one lease into its automatic repair.
const automation = new AutomationHarness();
automation.aiService = { withAgentStructuredInvocation: async (context, task) => {
    assert.equal(context.executionLease, lease);
    if (context.autoRepair) return context.autoRepair({ checkpoint: { modelResultRef: 'stable' },
        contract: { contractId: 'analysis', version: 2 }, validationIssues: [] });
    return task();
} };
automation.repairStructuredOutput = async params => {
    assert.equal(params.executionLease, lease);
    return { repairedPayload: { summary: 'fixed' } };
};
assert.deepEqual(await automation.invokeAgentStructured('agent.analyze_skill_work_unit', { requestId: 'stable' },
    async () => ({}), { autoRepair: true, executionLease: lease }), { summary: 'fixed' });
console.log('Skill lease recovery, nested repair, usage, pre-dispatch window and legacy isolation tests passed.');
