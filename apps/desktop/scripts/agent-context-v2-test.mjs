import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-editor-context-v2-'));
const contextRoot = path.join(desktopRoot, 'electron', 'ai', 'context');
const program = ts.createProgram([
    path.join(contextRoot, 'AgentConversationSummaryV2.ts'),
    path.join(contextRoot, 'ContextAtomicUnitBuilder.ts'),
    path.join(contextRoot, 'AgentContextTokenCounter.ts'),
], {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    skipLibCheck: true,
    rootDir: desktopRoot,
    outDir: tempRoot,
});
assert.equal(program.emit().emitSkipped, false);
fs.writeFileSync(path.join(tempRoot, 'package.json'), '{"type":"commonjs"}', 'utf8');
const require = createRequire(import.meta.url);
const emittedContextRoot = path.join(tempRoot, 'electron', 'ai', 'context');
const summaryModule = require(path.join(emittedContextRoot, 'AgentConversationSummaryV2.js'));
const atomicModule = require(path.join(emittedContextRoot, 'ContextAtomicUnitBuilder.js'));
const tokenModule = require(path.join(emittedContextRoot, 'AgentContextTokenCounter.js'));
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));

const {
    buildMessageSourceHash,
    buildDependencyHash,
    emptySemanticProjection,
    normalizeCompactionResult,
    normalizeAgentConversationSummaryV2,
    validateAgentConversationSummaryCoverageV2,
    validateAndCreateSummaryV2,
} = summaryModule;
const { ContextAtomicUnitBuilder } = atomicModule;
const { AgentContextTokenCounter, estimateContextTokens, resolveAgentModelContextProfile } = tokenModule;

const messages = [
    { messageId: 'm1', sequence: 1, role: 'user', content: '必须保持第一人称。' },
    { messageId: 'm2', sequence: 2, role: 'assistant', content: '收到。' },
    { messageId: 'm3', sequence: 3, role: 'user', content: '她把钥匙藏在钟里。' },
    { messageId: 'm4', sequence: 4, role: 'assistant', content: '我会保留这个伏笔。' },
    { messageId: 'm5', sequence: 5, role: 'user', content: '继续下一幕。' },
    { messageId: 'm6', sequence: 6, role: 'assistant', content: '下一幕草案。' },
];

assert.equal(buildMessageSourceHash(messages), buildMessageSourceHash(messages));
assert.notEqual(buildMessageSourceHash(messages), buildMessageSourceHash([
    messages[1], messages[0], ...messages.slice(2),
]));

const atomicBuilder = new ContextAtomicUnitBuilder();
const atomic = atomicBuilder.build({ messages });
assert.equal(atomic.units.length, 3);
assert.deepEqual(atomic.validBoundaryUnitIds, atomic.units.map((unit) => unit.unitId));
const prefix = atomicBuilder.selectPrefix({
    build: atomic,
    messages,
    minimumRecentUnits: 1,
    minimumRecentTokens: 1,
    countMessageTokens: (items) => items.reduce((total, item) => total + item.content.length, 0),
});
assert.deepEqual(prefix.coveredMessages.map((message) => message.messageId), ['m1', 'm2', 'm3', 'm4']);
assert.deepEqual(prefix.recentTailMessages.map((message) => message.messageId), ['m5', 'm6']);

const openAtomic = atomicBuilder.build({
    messages,
    stateRefs: [{ kind: 'approval', id: 'approval-1', status: 'open', messageIds: ['m3'] }],
});
assert.equal(openAtomic.units[1].status, 'open');
assert.equal(openAtomic.validBoundaryUnitIds.length, 1);
assert.deepEqual(openAtomic.units[1].stateRefs.map((ref) => ref.id), ['approval-1']);

const unanchoredOpenAtomic = atomicBuilder.build({
    messages,
    stateRefs: [{ kind: 'run', id: 'run-open', status: 'open' }],
});
assert.equal(unanchoredOpenAtomic.blockingUnit?.sequenceStart, 0);
assert.equal(unanchoredOpenAtomic.validBoundaryUnitIds.length, 0);

const missingAnchorAtomic = atomicBuilder.build({
    messages,
    stateRefs: [{ kind: 'input_resolution', id: 'answer-1', status: 'closed', messageIds: ['missing-message'] }],
});
assert.equal(missingAnchorAtomic.blockingUnit?.status, 'invalid');
assert.equal(missingAnchorAtomic.blockingUnit?.sequenceStart, 0);
assert.equal(missingAnchorAtomic.validBoundaryUnitIds.length, 0);

const anchoredEvidenceAtomic = atomicBuilder.build({
    messages,
    stateRefs: [
        { kind: 'tool_result', id: 'tool-result-1', status: 'closed', messageIds: ['m4'] },
        { kind: 'attachment', id: 'attachment-1', status: 'closed', messageIds: ['m3'] },
    ],
});
assert.deepEqual(
    anchoredEvidenceAtomic.units[1].stateRefs.map((ref) => ref.id),
    ['attachment-1', 'tool-result-1'],
);

const mergedAtomic = atomicBuilder.build({
    messages,
    stateRefs: [{ kind: 'run', id: 'run-spanning-turns', status: 'closed', messageIds: ['m2', 'm5'] }],
});
assert.equal(mergedAtomic.units.length, 1);
assert.equal(mergedAtomic.units[0].kind, 'structured_interaction');
assert.deepEqual(mergedAtomic.units[0].messageIds, messages.map((message) => message.messageId));
assert.deepEqual(mergedAtomic.validBoundaryUnitIds, [mergedAtomic.units[0].unitId]);
const duplicateAtomic = atomicBuilder.build({ messages: [messages[0], { ...messages[1], sequence: 1 }] });
assert.equal(duplicateAtomic.blockingUnit?.status, 'invalid');

const sameTimestampMessages = messages.map((message) => ({
    ...message,
    createdAt: '2026-07-30T00:00:00.000Z',
}));
const stableAtomicBeforeReload = atomicBuilder.build({ messages: sameTimestampMessages });
const stableAtomicAfterReload = atomicBuilder.build({ messages: structuredClone(sameTimestampMessages) });
assert.deepEqual(stableAtomicAfterReload, stableAtomicBeforeReload);

const projection = emptySemanticProjection();
projection.hardConstraints.push({
    id: 'constraint-1',
    text: '保持第一人称。',
    sourceMessageIds: ['m1'],
    authority: 'user',
    status: 'active',
});
projection.creativeContinuity.push({
    id: 'continuity-1',
    text: '钥匙藏在钟里。',
    sourceMessageIds: ['m3'],
    authority: 'user',
    status: 'active',
});
projection.completedOutcomes.push({
    id: 'outcome-1',
    text: '助手确认会保留伏笔。',
    sourceMessageIds: ['m4'],
    authority: 'assistant',
    status: 'active',
});
const firstSummary = validateAndCreateSummaryV2({
    previous: null,
    result: {
        mode: 'incremental',
        semanticProjection: projection,
        userMessageLedgerDelta: [
            { messageId: 'm1', gist: '第一人称约束', classification: 'semantic' },
            { messageId: 'm3', gist: '钥匙藏在钟里', classification: 'semantic' },
        ],
        referencedSources: [],
    },
    coveredMessages: messages.slice(0, 4),
    newlyCoveredMessages: messages.slice(0, 4),
    availableProjectSources: [],
    providerType: 'http',
    model: 'gpt-4.1-mini',
    promptVersion: 'test-v1',
    updatedAt: '2026-07-30T00:00:00.000Z',
});
assert.equal(firstSummary.revision, 1);
assert.equal(firstSummary.previousRevision, 0);
assert.equal(firstSummary.generation, 1);
assert.equal(firstSummary.coverage.endMessageId, 'm4');
assert.equal(firstSummary.sourceIndex.userMessageLedger.length, 2);
assert.deepEqual(normalizeAgentConversationSummaryV2(firstSummary), firstSummary);
assert.equal(validateAgentConversationSummaryCoverageV2(firstSummary, messages.slice(0, 4)), true);
const missingLedgerSummary = structuredClone(firstSummary);
missingLedgerSummary.sourceIndex.userMessageLedger.pop();
assert.equal(validateAgentConversationSummaryCoverageV2(missingLedgerSummary, messages.slice(0, 4)), false);
const wrongAuthoritySummary = structuredClone(firstSummary);
wrongAuthoritySummary.semanticProjection.hardConstraints[0].sourceMessageIds = ['m2'];
assert.equal(validateAgentConversationSummaryCoverageV2(wrongAuthoritySummary, messages.slice(0, 4)), false);
const wrongDependencyHashSummary = structuredClone(firstSummary);
wrongDependencyHashSummary.sourceIndex.dependencyHash = 'forged-dependency-hash';
assert.equal(validateAgentConversationSummaryCoverageV2(wrongDependencyHashSummary, messages.slice(0, 4)), false);
const transientSemanticSummary = structuredClone(firstSummary);
transientSemanticSummary.sourceIndex.userMessageLedger[0].classification = 'transient';
assert.equal(validateAgentConversationSummaryCoverageV2(transientSemanticSummary, messages.slice(0, 4)), false);

assert.throws(() => validateAndCreateSummaryV2({
    previous: firstSummary,
    result: {
        mode: 'incremental',
        semanticProjection: structuredClone(firstSummary.semanticProjection),
        userMessageLedgerDelta: [],
        referencedSources: [],
    },
    coveredMessages: messages.slice(0, 4),
    newlyCoveredMessages: [],
    availableProjectSources: [],
    providerType: 'http',
    model: 'gpt-4.1-mini',
    promptVersion: 'test-refresh',
}), /Coverage must advance/);
const dependencyRefreshSummary = validateAndCreateSummaryV2({
    previous: firstSummary,
    result: {
        mode: 'incremental',
        semanticProjection: structuredClone(firstSummary.semanticProjection),
        userMessageLedgerDelta: [],
        referencedSources: [],
    },
    coveredMessages: messages.slice(0, 4),
    newlyCoveredMessages: [],
    availableProjectSources: [],
    providerType: 'http',
    model: 'gpt-4.1-mini',
    promptVersion: 'test-refresh',
    dependencyRefresh: true,
});
assert.equal(dependencyRefreshSummary.revision, 2);
assert.equal(dependencyRefreshSummary.generation, 1);
assert.deepEqual(dependencyRefreshSummary.coverage, firstSummary.coverage);
assert.deepEqual(dependencyRefreshSummary.sourceIndex.userMessageLedger, firstSummary.sourceIndex.userMessageLedger);

const secondProjection = structuredClone(projection);
secondProjection.activeIntent.push({
    id: 'intent-1',
    text: '继续下一幕。',
    sourceMessageIds: ['m5'],
    authority: 'user',
    status: 'active',
});
const secondSummary = validateAndCreateSummaryV2({
    previous: firstSummary,
    result: {
        mode: 'incremental',
        semanticProjection: secondProjection,
        userMessageLedgerDelta: [
            { messageId: 'm5', gist: '继续下一幕', classification: 'semantic' },
        ],
        referencedSources: [],
    },
    coveredMessages: messages,
    newlyCoveredMessages: messages.slice(4),
    availableProjectSources: [],
    providerType: 'http',
    model: 'gpt-4.1-mini',
    promptVersion: 'test-v1',
});
assert.equal(secondSummary.revision, 2);
assert.equal(secondSummary.generation, 1);
assert.equal(secondSummary.rebuild, undefined);
assert.deepEqual(
    secondSummary.sourceIndex.userMessageLedger.slice(0, 2),
    firstSummary.sourceIndex.userMessageLedger,
);

const correctionMessages = [
    ...messages,
    { messageId: 'm7', sequence: 7, role: 'user', content: '纠正：改为第三人称，不再使用第一人称。' },
    { messageId: 'm8', sequence: 8, role: 'assistant', content: '已改为第三人称。' },
];
const correctionProjection = structuredClone(secondProjection);
correctionProjection.hardConstraints[0] = {
    ...correctionProjection.hardConstraints[0],
    status: 'superseded',
    supersededBy: 'constraint-2',
};
correctionProjection.hardConstraints.push({
    id: 'constraint-2',
    text: '使用第三人称，不再使用第一人称。',
    sourceMessageIds: ['m7'],
    authority: 'user',
    status: 'active',
});
const correctionSummary = validateAndCreateSummaryV2({
    previous: secondSummary,
    result: {
        mode: 'incremental',
        semanticProjection: correctionProjection,
        userMessageLedgerDelta: [{
            messageId: 'm7',
            gist: '纠正为第三人称',
            classification: 'semantic',
            supersedesMessageIds: ['m1'],
        }],
        referencedSources: [],
    },
    coveredMessages: correctionMessages,
    newlyCoveredMessages: correctionMessages.slice(6),
    availableProjectSources: [],
    providerType: 'http',
    model: 'gpt-4.1-mini',
    promptVersion: 'test-v2',
});
assert.equal(correctionSummary.generation, 1);
assert.deepEqual(correctionSummary.sourceIndex.userMessageLedger[3].supersedesMessageIds, ['m1']);
assert.deepEqual(correctionSummary.sourceIndex.userMessageLedger.slice(0, 3), secondSummary.sourceIndex.userMessageLedger);

const editedMessages = correctionMessages.map((message) => (
    message.messageId === 'm1' ? { ...message, content: '最初曾要求第一人称。' } : message
));
const rebuiltProjection = emptySemanticProjection();
rebuiltProjection.hardConstraints.push({
    id: 'constraint-current',
    text: '当前使用第三人称。',
    sourceMessageIds: ['m7'],
    authority: 'user',
    status: 'active',
});
const rebuiltSummary = validateAndCreateSummaryV2({
    previous: correctionSummary,
    result: {
        mode: 'rebuild_chunk',
        semanticProjection: rebuiltProjection,
        userMessageLedgerDelta: [
            { messageId: 'm1', gist: '最初曾要求第一人称', classification: 'semantic' },
            { messageId: 'm3', gist: '钥匙藏在钟里', classification: 'semantic' },
            { messageId: 'm5', gist: '继续下一幕', classification: 'semantic' },
            {
                messageId: 'm7',
                gist: '纠正为第三人称',
                classification: 'semantic',
                supersedesMessageIds: ['m1'],
            },
        ],
        referencedSources: [],
    },
    coveredMessages: editedMessages,
    newlyCoveredMessages: editedMessages,
    availableProjectSources: [],
    providerType: 'http',
    model: 'gpt-4.1-mini',
    promptVersion: 'test-v2',
    rebuildReason: 'source_changed',
});
assert.equal(rebuiltSummary.revision, 4);
assert.equal(rebuiltSummary.generation, 2);
assert.deepEqual(rebuiltSummary.rebuild, { previousGeneration: 1, reason: 'source_changed' });
assert.equal(rebuiltSummary.semanticProjection.creativeContinuity.length, 0);
assert.equal(rebuiltSummary.sourceIndex.userMessageLedger.some((entry) => entry.messageId === 'm3'), true);
assert.deepEqual(normalizeAgentConversationSummaryV2(rebuiltSummary), rebuiltSummary);

const legacyV2 = structuredClone(firstSummary);
delete legacyV2.generation;
assert.equal(normalizeAgentConversationSummaryV2(legacyV2).generation, 1);
assert.equal(normalizeAgentConversationSummaryV2({ ...firstSummary, version: 'agent-conversation-summary-v3' }), null);
assert.equal(normalizeAgentConversationSummaryV2({ ...firstSummary, previousRevision: 1 }), null);
assert.equal(normalizeAgentConversationSummaryV2({
    ...firstSummary,
    compactor: { ...firstSummary.compactor, promptVersion: '' },
}), null);

const invalidProjection = emptySemanticProjection();
invalidProjection.canonFacts.push({
    id: 'bad-canon',
    text: '助手建议被误作事实。',
    sourceMessageIds: ['m2'],
    authority: 'assistant',
    status: 'active',
});
assert.throws(() => validateAndCreateSummaryV2({
    previous: null,
    result: {
        mode: 'incremental',
        semanticProjection: invalidProjection,
        userMessageLedgerDelta: [
            { messageId: 'm1', gist: '第一人称约束', classification: 'transient' },
        ],
        referencedSources: [],
    },
    coveredMessages: messages.slice(0, 2),
    newlyCoveredMessages: messages.slice(0, 2),
    availableProjectSources: [],
    providerType: 'http',
    model: 'gpt-4.1-mini',
    promptVersion: 'test-v1',
}), /Assistant-only canon fact|Semantic user message marked transient/);

const projectSources = [{
    sourceType: 'chapter', sourceId: 'chapter-1', sourceVersion: '3', contentHash: 'hash-3',
}];
assert.equal(buildDependencyHash(projectSources), buildDependencyHash([...projectSources]));
assert.notEqual(buildDependencyHash(projectSources), buildDependencyHash([{ ...projectSources[0], contentHash: 'hash-4' }]));

const counter = new AgentContextTokenCounter();
const count = counter.count({
    providerType: 'http',
    model: 'gpt-4.1-mini',
    systemPrompt: 'System',
    prompt: JSON.stringify({ message: '她把钥匙藏在钟里。' }),
});
assert.equal(count.method, 'conservative_upper_bound');
assert.ok(count.contextTokens >= estimateContextTokens('她把钥匙藏在钟里。'));
for (const model of ['gpt-5.4', 'gpt-5.6', 'gpt-fable', 'future-vendor-model']) {
    const compatibleCount = counter.count({ providerType: 'http', model, prompt: 'test' });
    assert.equal(compatibleCount.method, 'conservative_upper_bound');
}
assert.equal(resolveAgentModelContextProfile('http', 'gpt-5.4').defaultContextWindowTokens, 258_000);
assert.equal(resolveAgentModelContextProfile('http', 'gpt-5.6').defaultContextWindowTokens, 258_000);
assert.equal(resolveAgentModelContextProfile('http', 'gpt-fable').defaultContextWindowTokens, 131_072);
assert.equal(resolveAgentModelContextProfile('http', 'future-vendor-model').defaultContextWindowTokens, 131_072);
assert.equal(resolveAgentModelContextProfile('http', 'deepseek-1m').defaultContextWindowTokens, 131_072);
assert.equal(resolveAgentModelContextProfile('http', 'deepseek-v4-pro').defaultContextWindowTokens, 1_000_000);
assert.equal(resolveAgentModelContextProfile('http', 'qwen3-coder-plus').defaultContextWindowTokens, 1_048_576);
assert.equal(resolveAgentModelContextProfile('http', 'glm-5.2').defaultContextWindowTokens, 200_000);
assert.equal(counter.budget({
    providerType: 'http',
    model: 'deepseek-1m',
    configuredContextWindowTokens: 1_000_000,
    outputReserveTokens: 8_192,
}).contextWindowTokens, 1_000_000);

const smallWindowOutput = counter.adaptOutputReserve({
    providerType: 'http',
    model: 'gpt-5.4',
    configuredContextWindowTokens: 8_192,
    requestedOutputTokens: 2_600,
    systemPrompt: 's'.repeat(5_394),
    minimumOutputTokens: 256,
    minimumDynamicContextTokens: 1_280,
});
assert.equal(smallWindowOutput.feasible, true);
assert.equal(smallWindowOutput.reduced, true);
assert.equal(smallWindowOutput.outputReserveTokens, 974);
assert.equal(smallWindowOutput.budget.outputReserveTokens, smallWindowOutput.outputReserveTokens);
assert.equal(smallWindowOutput.budget.hardContextBudget, 1_280);
assert.ok(
    smallWindowOutput.budget.fixedProviderInputTokens
        + smallWindowOutput.outputReserveTokens
        + smallWindowOutput.budget.safetyReserveTokens
        + smallWindowOutput.budget.providerReserveTokens
        + smallWindowOutput.minimumDynamicContextTokens
        <= smallWindowOutput.budget.contextWindowTokens,
);

const impossibleOutput = counter.adaptOutputReserve({
    providerType: 'http',
    model: 'gpt-5.4',
    configuredContextWindowTokens: 8_192,
    requestedOutputTokens: 2_600,
    systemPrompt: 's'.repeat(7_500),
    minimumOutputTokens: 256,
    minimumDynamicContextTokens: 1_280,
});
assert.equal(impossibleOutput.feasible, false);
assert.equal(impossibleOutput.outputReserveTokens, 0);

const validCompactionResult = {
    mode: 'incremental',
    semanticProjection: emptySemanticProjection(),
    userMessageLedgerDelta: [{ messageId: 'm1', gist: '有效摘要', classification: 'semantic' }],
    referencedSources: [],
};
assert.ok(normalizeCompactionResult(validCompactionResult));

const tooManyEntries = structuredClone(validCompactionResult);
tooManyEntries.semanticProjection.activeIntent = Array.from({ length: 97 }, (_, index) => ({
    id: `entry-${index}`,
    text: '有效文本',
    sourceMessageIds: ['m1'],
    authority: 'user',
    status: 'active',
}));
assert.equal(normalizeCompactionResult(tooManyEntries), null);

const tooManyArtifacts = structuredClone(validCompactionResult);
tooManyArtifacts.semanticProjection.artifactRefs = Array.from({ length: 33 }, (_, index) => ({
    artifactId: `artifact-${index}`,
    type: 'report',
    title: `产物 ${index}`,
    contentHash: `hash-${index}`,
    summary: '有效摘要',
}));
assert.equal(normalizeCompactionResult(tooManyArtifacts), null);

const tooLongEntry = structuredClone(validCompactionResult);
tooLongEntry.semanticProjection.activeIntent = [{
    id: 'long-entry',
    text: '字'.repeat(1_201),
    sourceMessageIds: ['m1'],
    authority: 'user',
    status: 'active',
}];
assert.equal(normalizeCompactionResult(tooLongEntry), null);

const tooManySourceRefs = structuredClone(validCompactionResult);
tooManySourceRefs.semanticProjection.activeIntent = [{
    id: 'many-sources',
    text: '有效文本',
    sourceMessageIds: Array.from({ length: 17 }, (_, index) => `m-${index}`),
    authority: 'user',
    status: 'active',
}];
assert.equal(normalizeCompactionResult(tooManySourceRefs), null);

const tooLongGist = structuredClone(validCompactionResult);
tooLongGist.userMessageLedgerDelta[0].gist = '字'.repeat(281);
assert.equal(normalizeCompactionResult(tooLongGist), null);

for (const contextWindowTokens of [8192, 32_768, 131_072]) {
    const budget = counter.budget({
        providerType: 'http',
        model: 'gpt-4.1-mini',
        configuredContextWindowTokens: contextWindowTokens,
        outputReserveTokens: 1024,
        systemPrompt: 'System prompt',
    });
    assert.ok(budget.hardContextBudget < budget.hardProviderInputLimit);
    assert.ok(budget.targetContextBudget < budget.triggerContextBudget);
    assert.ok(budget.triggerContextBudget < budget.hardContextBudget);
    const health = counter.wouldRetriggerNextTurn(budget.targetContextBudget, budget);
    assert.equal(
        health.wouldRetriggerNextTurn,
        health.projectedNextTurnContextTokens >= budget.triggerContextBudget,
    );
}

console.log('Agent context v2 foundation tests passed.');
