import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real chat generator through its provider boundary. Only budgeting,
// storage and generation are stubbed; its prompt/state assembly runs unchanged.
const source = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AiService.ts', source, ts.ScriptTarget.Latest, true);
const service = ast.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'AiService');
const method = service.members.find((member) => ts.isMethodDeclaration(member) && member.name.getText(ast) === 'generateAgentChat');
const compiled = ts.transpileModule(`class ChatHarness { ${method.getText(ast)} }; exports.ChatHarness = ChatHarness;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, {
    exports: module.exports,
    AiActionError: Error,
    trimText: (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '',
    dedupeStrings: (items, max) => [...new Set(items)].slice(0, max),
    canonicalJson: JSON.stringify,
    protectedActiveRun: () => null,
    selectRelatedUserInputResolutions: () => [],
    authoritativeArtifacts: () => [],
    buildAgentContextStateRefs: () => [],
    capTaskOutputBudget: (budget) => budget,
    AGENT_CHAT_MINIMUM_OUTPUT_TOKENS: 256,
    AGENT_CHAT_MINIMUM_DYNAMIC_CONTEXT_TOKENS: 1280,
    AGENT_CHAT_DYNAMIC_CONTEXT_HEADROOM_TOKENS: 128,
    AgentContextTokenCounter: class {
        count() { return { contextTokens: 500 }; }
        adaptOutputReserve() { return { feasible: true, reduced: false, outputReserveTokens: 4096 }; }
    },
});
const reachedProvider = new Error('Provider boundary reached');
const snapshot = {
    authoritativeContext: { currentPlan: null, activeRun: null, pendingUserInput: null },
    messages: [
        { messageId: 'old_notice', role: 'assistant', content: '文风1.0 未通过校验，不能参与任务。', sequence: 1 },
        { messageId: 'rewrite_request', role: 'user', content: '重写本章', sequence: 2 },
    ],
};
const published = {
    mode: 'explicit', explicitlySelected: true, status: 'published', validated: true, enabled: true,
    title: '文风1.0', skillId: 'saved_skill', requestedRevisionId: 'published_revision',
    revisionId: 'published_revision', version: '1.0.0', contentHash: 'a'.repeat(64),
    supportedOperations: ['chapter.rewrite'], allowedRoles: ['writer'],
};
let preparedContext;
let providerRequest;
const harness = Object.assign(new module.exports.ChatHarness(), {
    settingsCache: { providerType: 'http', http: { model: 'test-model', contextWindowTokens: 131072, temperature: 0.3, timeoutMs: 120000 } },
    contextCompressionStore: { readCompressionSnapshot: async () => snapshot },
    agentContextCompressionCoordinator: { prepare: async (input) => {
        preparedContext = input.protectedContext;
        return { snapshot: structuredClone(snapshot), diagnostics: {} };
    } },
    resolveGenerationBudget: () => ({ initialTokens: 4096, recoveryTokens: 4096 }),
    assembleAgentContext: (input) => ({ prompt: JSON.stringify(input) }),
    generateStructuredWithBudgetRecovery: async (request) => { providerRequest = request; throw reachedProvider; },
});

for (const state of [published, { mode: 'disabled', explicitlySelected: false }, undefined]) {
    await assert.rejects(harness.generateAgentChat({
        message: '重写本章', messageId: 'rewrite_request', storageConversationId: 'conversation',
        role: 'team', locale: 'zh-CN', selectionContext: { novelId: 'novel', chapterId: 'chapter' },
        ...(state ? { skillSelectionContext: state } : {}),
    }), (error) => error === reachedProvider);
    const assembled = JSON.parse(providerRequest.prompt);
    const expected = state || { mode: 'auto', explicitlySelected: false };
    assert.deepEqual(JSON.parse(JSON.stringify(preparedContext.skillSelection)), expected);
    assert.deepEqual(assembled.protectedContext.skillSelection, expected, 'Compression snapshot refresh retains the live selected revision');
    assert.equal(assembled.history[0].content, snapshot.messages[0].content, 'Historical notices remain history, not current status');
    assert.equal(assembled.history.some((item) => item.messageId === 'rewrite_request'), false);
    assert.match(providerRequest.systemPrompt, /优先于历史消息和摘要里的草稿状态/);
}
console.log('Agent Skill chat context tests passed (fresh published state survives prompt assembly/compression; disabled and auto remain distinct).');
