import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-editor-context-assembler-'));
const program = ts.createProgram([path.join(desktopRoot, 'electron', 'ai', 'context', 'AgentContextAssembler.ts')], {
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
const {
    AgentContextAssembler,
    estimateAgentContextTokens,
    resolveAgentContextWindow,
} = require(path.join(tempRoot, 'electron', 'ai', 'context', 'AgentContextAssembler.js'));
const {
    buildDependencyHash,
    buildMessageSourceHash,
    emptySemanticProjection,
} = require(path.join(tempRoot, 'electron', 'ai', 'context', 'AgentConversationSummaryV2.js'));
const { AgentContextTokenCounter } = require(
    path.join(tempRoot, 'electron', 'ai', 'context', 'AgentContextTokenCounter.js'),
);
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));

assert.deepEqual(resolveAgentContextWindow('http', 'gpt-4.1-mini', 0), {
    tokens: 258_000,
    source: 'model-profile',
});
assert.deepEqual(resolveAgentContextWindow('http', 'gpt-5.6', 0), {
    tokens: 258_000,
    source: 'model-profile',
});
assert.deepEqual(resolveAgentContextWindow('http', 'future-vendor-model', 0), {
    tokens: 131_072,
    source: 'compatibility-fallback',
});
assert.deepEqual(resolveAgentContextWindow('mcp-cli', '', 0), {
    tokens: 32_768,
    source: 'model-profile',
});
assert.deepEqual(resolveAgentContextWindow('http', 'custom', 12_000), {
    tokens: 12_000,
    source: 'configured',
});

const assembler = new AgentContextAssembler();
// Exercise the actual generation prompt path: long blueprints must not become
// unresolvable "context-builder" excerpts before the model can read them.
const aiSource = fs.readFileSync(path.join(desktopRoot, 'electron', 'ai', 'AiService.ts'), 'utf8');
const aiAst = ts.createSourceFile('AiService.ts', aiSource, ts.ScriptTarget.Latest, true);
const aiClass = aiAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AiService');
const draftPromptMethod = aiClass.members.find(node => node.name?.getText(aiAst) === 'assembleDraftGenerationPrompt').getText(aiAst);
const harnessJs = ts.transpileModule(`class PromptHarness { ${draftPromptMethod} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const PromptHarness = new Function(`${harnessJs}; return PromptHarness;`)();
const promptHarness = new PromptHarness();
promptHarness.assembleAgentPrompt = input => assembler.assemble({
    ...input, providerType: 'http', model: 'custom-model', contextWindowTokens: 131072,
}).prompt;
const longBlueprint = `${'前期设定。'.repeat(1800)}中段角色必须保留：陈修平、林晓、老郑。${'后期章纲。'.repeat(1800)}`;
const blueprintPrompt = promptHarness.assembleDraftGenerationPrompt({
    operation: 'creative_assets.generate_draft', systemPrompt: 'Return JSON.', outputTokens: 16384,
    structured: { goal: 'Initialize approved blueprint' }, effectiveUserPrompt: longBlueprint, usedContext: [],
});
assert.ok(blueprintPrompt.includes(longBlueprint), 'Generation must preserve the complete source when it fits');
assert.doesNotMatch(blueprintPrompt, /reference excerpt omitted/);
const smallWindowSystemPrompt = 's'.repeat(5_394);
const smallWindowCounter = new AgentContextTokenCounter();
const smallWindowSelection = {
    novelId: 'novel-small-window',
    novelTitle: '七夜',
    volumeId: 'volume-small-window',
    chapterId: 'chapter-small-window',
    chapterTitle: '白色房间',
    chapterScope: {
        kind: 'current_chapter',
        volumeId: 'volume-small-window',
        chapterIds: ['chapter-small-window'],
        anchorChapterId: 'chapter-small-window',
        processingMode: 'detailed',
        experts: ['editor', 'reader', 'worldbuilding'],
    },
};
const smallWindowCurrentRequest = {
    messageId: 'small-window-request',
    content: '你好',
    role: 'team',
    workMode: 'review_required',
    selectionRef: 'protectedContext.selectionContext',
};
const smallWindowProtectedContext = {
    storageConversationId: 'small-window-conversation',
    selectionContext: smallWindowSelection,
    currentPlan: null,
    activeRun: null,
    conversationPendingUserInput: null,
    relatedUserInputResolutions: [],
    relatedApprovalResponses: [],
};
const smallWindowRequiredSections = [
    {
        id: 'intent-preflight',
        kind: 'decision',
        priority: 'required',
        value: { source: 'chat', reasonCodes: ['CURRENT_SELECTION'] },
    },
    {
        id: 'current-selection',
        kind: 'metadata',
        priority: 'required',
        sourceRef: 'renderer-current-selection',
        value: {
            contextPath: 'protectedContext.selectionContext',
            novelId: smallWindowSelection.novelId,
            volumeId: smallWindowSelection.volumeId,
            chapterId: smallWindowSelection.chapterId,
        },
    },
];
const smallWindowMinimumCount = smallWindowCounter.count({
    providerType: 'http',
    model: 'gpt-5.4',
    configuredContextWindowTokens: 8_192,
    prompt: JSON.stringify({
        contextVersion: 'agent-context-v2',
        currentRequest: smallWindowCurrentRequest,
        protectedContext: smallWindowProtectedContext,
        persistentConstraints: [],
        persistentSummary: null,
        recalledMessages: [],
        recalledArtifacts: [],
        rollingSummary: [],
        recentHistory: [],
        sections: smallWindowRequiredSections,
    }),
});
const smallWindowBudget = smallWindowCounter.adaptOutputReserve({
    providerType: 'http',
    model: 'gpt-5.4',
    configuredContextWindowTokens: 8_192,
    requestedOutputTokens: 2_600,
    systemPrompt: smallWindowSystemPrompt,
    minimumOutputTokens: 256,
    minimumDynamicContextTokens: Math.max(1_280, smallWindowMinimumCount.contextTokens + 128),
});
const smallWindowChat = assembler.assemble({
    providerType: 'http',
    model: 'gpt-5.4',
    contextWindowTokens: 8_192,
    outputTokens: smallWindowBudget.outputReserveTokens,
    systemPrompt: smallWindowSystemPrompt,
    currentRequest: smallWindowCurrentRequest,
    protectedContext: smallWindowProtectedContext,
    sections: [
        ...smallWindowRequiredSections,
        { id: 'available-operations', kind: 'metadata', priority: 'high', value: 'operation '.repeat(1_700) },
        { id: 'available-read-tools', kind: 'metadata', priority: 'low', value: 'tool '.repeat(800) },
    ],
    requireHardTokenCount: true,
});
assert.equal(smallWindowBudget.feasible, true);
assert.equal(smallWindowBudget.reduced, true);
assert.ok(smallWindowBudget.outputReserveTokens >= 256);
assert.ok(smallWindowBudget.outputReserveTokens < 1_024);
assert.equal(smallWindowChat.diagnostics.outputTokens, smallWindowBudget.outputReserveTokens);
assert.ok(smallWindowChat.diagnostics.contextTokens <= smallWindowChat.diagnostics.hardContextBudget);
assert.ok(
    smallWindowChat.diagnostics.providerInputTokens
        + smallWindowChat.diagnostics.outputTokens
        + smallWindowChat.diagnostics.safetyTokens
        + smallWindowChat.diagnostics.providerReserveTokens
        <= smallWindowChat.diagnostics.contextWindowTokens,
);
assert.ok(smallWindowChat.diagnostics.omittedSectionIds.includes('available-read-tools'));
const shortHistory = Array.from({ length: 36 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 0 ? '必须保持第一人称视角。' : `短消息 ${index}`,
    createdAt: `2026-07-15T00:${String(index).padStart(2, '0')}:00.000Z`,
}));
const roomy = assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    systemPrompt: 'Return JSON.',
    currentRequest: { message: '继续上面的任务' },
    history: shortHistory,
});
assert.equal(roomy.diagnostics.historyMessagesTotal, 36);
assert.equal(roomy.diagnostics.historyMessagesKept, 36);
assert.equal(roomy.diagnostics.historyMessagesOmitted, 0);
assert.equal(roomy.diagnostics.compressionApplied, false);
assert.equal(roomy.diagnostics.historySources.length, 1);
assert.deepEqual(roomy.diagnostics.historySources[0], {
    mode: 'raw', startMessageIndex: 0, endMessageIndex: 35,
});
assert.match(JSON.stringify(roomy.payload.persistentConstraints), /第一人称/);

const currentRequestDedup = assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    systemPrompt: 'Return JSON.',
    currentRequest: { messageId: 'current-request', content: '当前请求只应出现一次。' },
    history: [
        { messageId: 'older-user', role: 'user', content: '较早请求。' },
        { messageId: 'older-assistant', role: 'assistant', content: '较早回复。' },
        { messageId: 'current-request', role: 'user', content: '当前请求只应出现一次。' },
    ],
});
assert.equal(currentRequestDedup.diagnostics.historyMessagesTotal, 2);
assert.equal(JSON.stringify(currentRequestDedup.payload).match(/current-request/g)?.length, 1);
assert.equal(
    currentRequestDedup.payload.recentHistory.some((message) => message.messageId === 'current-request'),
    false,
);
assert.throws(() => assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    systemPrompt: 'Return JSON.',
    currentRequest: { messageId: 'current-request', content: '当前请求只应出现一次。' },
    history: [{ messageId: 'current-request', role: 'user', content: '不一致正文。' }],
}), (error) => error?.code === 'CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH');

const longHistory = Array.from({ length: 84 }, (_, index) => ({
    messageId: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 2
        ? `不要改变叙事视角。${'这是必须长期保留的用户约束。'.repeat(20)}`
        : `第 ${index} 条会话内容：${'围绕人物动机、冲突与章节推进展开讨论。'.repeat(16)}`,
}));
const constrained = assembler.assemble({
    providerType: 'http',
    model: 'custom-small',
    contextWindowTokens: 8192,
    outputTokens: 768,
    systemPrompt: 'You are a novel editor. '.repeat(20),
    currentRequest: { message: '根据之前所有约束继续。' },
    history: longHistory,
    artifacts: [{
        artifactId: 'artifact-white-deer-review',
        runId: 'run-plot-review',
        type: 'plotline_analysis',
        title: '白鹿信号审核',
        status: 'ready',
        summary: '白鹿信号伏笔在覆盖范围内长期未回收。',
        content: '审核正文：建议在下一结构节点确认信号来源或代价。',
        reference: { runId: 'run-plot-review' },
    }],
    sections: [
        {
            id: 'current-plan',
            kind: 'plan',
            priority: 'required',
            value: { title: '重构主线', steps: ['读取章节', '核对设定', '生成草稿'] },
        },
        ...Array.from({ length: 80 }, (_, index) => ({
            id: `low-${index}`,
            kind: 'metadata',
            priority: 'low',
            value: `低优先级资料 ${index} ${'可省略内容'.repeat(300)}`,
        })),
    ],
});
assert.ok(constrained.diagnostics.historyMessagesKept > 0);
assert.ok(constrained.diagnostics.historyMessagesSummarized > 0);
assert.ok(constrained.diagnostics.historyMessagesKept < longHistory.length);
assert.equal(constrained.diagnostics.compressionApplied, true);
assert.match(JSON.stringify(constrained.payload.persistentConstraints), /不要改变叙事视角/);
assert.match(JSON.stringify(constrained.payload.sections), /current-plan/);
assert.ok(constrained.diagnostics.omittedSectionIds.length > 0);
assert.ok(constrained.diagnostics.historySources.some((source) => source.mode === 'summary'));
assert.ok(constrained.diagnostics.sectionSources.some((source) => source.id === 'current-plan' && source.mode === 'raw'));
assert.ok(constrained.diagnostics.sectionSources.some((source) => source.mode === 'omitted'));
assert.ok(constrained.diagnostics.estimatedInputTokens <= constrained.diagnostics.inputBudgetTokens);
assert.equal(estimateAgentContextTokens(constrained.prompt), constrained.diagnostics.estimatedInputTokens);
assert.equal(JSON.parse(constrained.prompt).contextVersion, 'agent-context-v1');
assert.equal(constrained.summaryUpdate.version, 'agent-conversation-summary-v1');
assert.equal(constrained.summaryUpdate.revision, 1);
assert.deepEqual(constrained.summaryUpdate.coveredMessageIds, []);
assert.deepEqual(constrained.summaryUpdate.userDecisions, []);
assert.equal(constrained.summaryUpdate.artifactRefs[0].artifactId, 'artifact-white-deer-review');

const legacyV1Summary = {
    ...constrained.summaryUpdate,
    coveredMessageIds: ['message-0', 'message-1', 'message-2'],
    coverage: {
        startMessageId: 'message-0',
        endMessageId: 'message-2',
        messageCount: 3,
    },
    userDecisions: [{
        id: 'legacy-decision',
        text: longHistory[2].content,
        sourceMessageIds: ['message-2'],
        sourceRole: 'user',
    }],
};

const recalled = assembler.assemble({
    providerType: 'http',
    model: 'custom-small',
    contextWindowTokens: 8192,
    outputTokens: 768,
    systemPrompt: 'You are a novel editor.',
    currentRequest: { message: '回顾之前不要改变叙事视角的决定，以及 artifact-white-deer-review 的结论。' },
    history: longHistory,
    persistentSummary: legacyV1Summary,
    artifacts: [{
        artifactId: 'artifact-white-deer-review',
        runId: 'run-plot-review',
        type: 'plotline_analysis',
        title: '白鹿信号审核',
        status: 'ready',
        summary: '白鹿信号伏笔在覆盖范围内长期未回收。',
        content: '审核正文：建议在下一结构节点确认信号来源或代价。',
        reference: { runId: 'run-plot-review' },
    }],
});
assert.equal(recalled.diagnostics.persistentSummaryRevision, 1);
assert.equal(recalled.diagnostics.persistentSummaryMessageCount, legacyV1Summary.coveredMessageIds.length);
assert.ok(recalled.diagnostics.recalledMessageIds.includes('message-2'));
assert.deepEqual(recalled.diagnostics.recalledArtifactIds, ['artifact-white-deer-review']);
assert.match(JSON.stringify(recalled.payload.recalledMessages), /不要改变叙事视角/);
assert.match(JSON.stringify(recalled.payload.recalledArtifacts), /下一结构节点/);

const extendedHistory = [
    ...longHistory,
    ...Array.from({ length: 18 }, (_, offset) => ({
        messageId: `message-${84 + offset}`,
        role: offset % 2 === 0 ? 'user' : 'assistant',
        content: `新增长会话 ${offset}：${'继续讨论主线推进与角色动机。'.repeat(24)}`,
    })),
];
const incremented = assembler.assemble({
    providerType: 'http',
    model: 'custom-small',
    contextWindowTokens: 8192,
    outputTokens: 768,
    systemPrompt: 'You are a novel editor.',
    currentRequest: { message: '继续。' },
    history: extendedHistory,
    persistentSummary: legacyV1Summary,
});
assert.equal(incremented.summaryUpdate, undefined);

const legacyCoverageDoesNotFilter = assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    currentRequest: { message: '继续' },
    history: longHistory.slice(0, 4),
    persistentSummary: legacyV1Summary,
});
assert.equal(legacyCoverageDoesNotFilter.diagnostics.historyMessagesKept, 4);
assert.ok(legacyCoverageDoesNotFilter.diagnostics.historySources.every((source) => source.mode === 'raw'));

const recallHistory = [
    { messageId: 'recall-1', sequence: 1, role: 'user', content: '银戒指埋在旧井第三块青砖下面。' },
    { messageId: 'recall-2', sequence: 2, role: 'assistant', content: '我会保留这个线索。' },
    { messageId: 'recall-3', sequence: 3, role: 'user', content: '当前任务改为推进宴会冲突。' },
    { messageId: 'recall-4', sequence: 4, role: 'assistant', content: '开始推进宴会冲突。' },
    { messageId: 'recall-5', sequence: 5, role: 'user', content: '继续下一段。' },
    { messageId: 'recall-6', sequence: 6, role: 'assistant', content: '下一段已准备。' },
];
const recallProjection = emptySemanticProjection();
recallProjection.activeIntent.push({
    id: 'current-intent',
    text: '推进宴会冲突。',
    sourceMessageIds: ['recall-3'],
    authority: 'user',
    status: 'active',
});
const recallSummaryV2 = {
    version: 'agent-conversation-summary-v2',
    revision: 1,
    previousRevision: 0,
    generation: 1,
    coverage: {
        startMessageId: 'recall-1',
        endMessageId: 'recall-4',
        messageCount: 4,
        sourceHash: buildMessageSourceHash(recallHistory.slice(0, 4)),
    },
    semanticProjection: recallProjection,
    sourceIndex: {
        userMessageLedger: [
            { messageId: 'recall-1', gist: '银戒指埋在旧井第三块青砖下', classification: 'semantic' },
            { messageId: 'recall-3', gist: '改为推进宴会冲突', classification: 'semantic' },
        ],
        sourceFingerprints: [],
        dependencyHash: buildDependencyHash([]),
    },
    updatedAt: '2026-07-30T00:00:00.000Z',
    compactor: { providerType: 'http', model: 'gpt-4.1-mini', promptVersion: 'test' },
};
const recalledEvictedSemantic = assembler.assemble({
    providerType: 'http',
    model: 'gpt-4.1-mini',
    contextWindowTokens: 32_768,
    outputTokens: 1_024,
    currentRequest: { message: '旧井里的银戒指放在哪里？' },
    history: recallHistory,
    persistentSummary: recallSummaryV2,
});
assert.equal(recalledEvictedSemantic.diagnostics.contextVersion, 'agent-context-v2');
assert.ok(recalledEvictedSemantic.diagnostics.recalledMessageIds.includes('recall-1'));
assert.match(JSON.stringify(recalledEvictedSemantic.payload.recalledMessages), /第三块青砖/);
assert.equal(JSON.stringify(recallProjection).includes('银戒指'), false);
const vagueRecall = assembler.assemble({
    providerType: 'http',
    model: 'gpt-4.1-mini',
    contextWindowTokens: 32_768,
    outputTokens: 1_024,
    currentRequest: { message: '按之前那个设定继续。' },
    history: recallHistory,
    persistentSummary: recallSummaryV2,
});
assert.ok(vagueRecall.diagnostics.recalledMessageIds.length > 0);
assert.ok(vagueRecall.diagnostics.recalledMessageIds.every((id) => recallHistory.some((message) => message.messageId === id)));
const invalidLedgerSummary = structuredClone(recallSummaryV2);
invalidLedgerSummary.sourceIndex.userMessageLedger = invalidLedgerSummary.sourceIndex.userMessageLedger.slice(1);
const invalidCoverageFallsBack = assembler.assemble({
    providerType: 'http',
    model: 'gpt-4.1-mini',
    contextWindowTokens: 32_768,
    outputTokens: 1_024,
    currentRequest: { message: '继续' },
    history: recallHistory,
    persistentSummary: invalidLedgerSummary,
});
assert.equal(invalidCoverageFallsBack.diagnostics.contextVersion, 'agent-context-v1');
assert.equal(invalidCoverageFallsBack.diagnostics.historyMessagesKept, recallHistory.length);
assert.match(invalidCoverageFallsBack.diagnostics.warnings.join('\n'), /failed source, ledger, or authority validation/);

const exactLongMessage = `保留原文：${'甲乙丙丁'.repeat(2300)}`;
const longCurrentRequest = assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    currentRequest: { message: exactLongMessage },
    protectedContext: {
        storageConversationId: 'conversation-protected',
        currentPlan: { planId: 'plan-1', goal: '完整保留计划' },
        conversationPendingUserInput: { requestId: 'input-1', question: '选择视角' },
    },
});
assert.equal(longCurrentRequest.payload.currentRequest.message, exactLongMessage);
assert.equal(longCurrentRequest.diagnostics.currentRequestMode, 'raw');
assert.match(JSON.stringify(longCurrentRequest.payload.protectedContext), /完整保留计划/);

assert.throws(() => assembler.assemble({
    providerType: 'http',
    model: 'custom-small',
    contextWindowTokens: 8192,
    outputTokens: 1024,
    currentRequest: { message: '超限'.repeat(10000) },
}), (error) => error?.code === 'CONTEXT_INPUT_TOO_LARGE');

assert.throws(() => assembler.assemble({
    providerType: 'http',
    model: 'custom-small',
    contextWindowTokens: 8192,
    outputTokens: 1024,
    currentRequest: { message: '继续' },
    protectedContext: { plan: '必要状态'.repeat(10000) },
}), (error) => error?.code === 'CONTEXT_PROTECTED_INPUT_TOO_LARGE');

const hiddenCreativeFactHistory = Array.from({ length: 90 }, (_, index) => ({
    messageId: `creative-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 0
        ? `她把钥匙藏在钟里。${'这句话不命中旧事实正则。'.repeat(20)}`
        : `创作讨论 ${index} ${'人物行动与场景细节。'.repeat(30)}`,
}));
const hiddenCreativeFact = assembler.assemble({
    providerType: 'http',
    model: 'custom-small',
    contextWindowTokens: 8192,
    outputTokens: 1024,
    currentRequest: { message: '继续创作' },
    history: hiddenCreativeFactHistory,
});
assert.ok(hiddenCreativeFact.diagnostics.historyMessagesOmitted > 0);
assert.equal(hiddenCreativeFact.summaryUpdate, undefined);

const findings = Array.from({ length: 20 }, (_, index) => ({
    id: `finding-${index}`,
    detail: `证据 ${index} ${'长工具结果'.repeat(120)}`,
}));
const reportContext = assembler.assemble({
    providerType: 'http',
    model: 'custom-small',
    contextWindowTokens: 8192,
    outputTokens: 1024,
    systemPrompt: 'Write a report.',
    currentRequest: '汇总工具结果',
    sections: [{ id: 'tool-findings', kind: 'retrieval', priority: 'required', value: findings }],
});
const serializedReportSections = JSON.stringify(reportContext.payload.sections);
assert.match(serializedReportSections, /finding-0/);
assert.match(serializedReportSections, /finding-19/);

const microcompressedSources = assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    currentRequest: { message: '比较章节、附件与产物中的长内容。' },
    sections: [{
        id: 'tool-observations',
        kind: 'tool',
        priority: 'high',
        sourceRef: 'current-exploration-turn',
        value: [{
            toolName: 'chapter.get',
            args: { chapterId: 'chapter-long' },
            result: {
                chapterId: 'chapter-long',
                title: '长章节',
                content: '章节正文'.repeat(3000),
            },
        }, {
            toolName: 'attachment.read',
            args: { attachmentId: 'attachment-long' },
            result: {
                attachmentId: 'attachment-long',
                fileName: '设定集.txt',
                text: '附件正文'.repeat(3000),
            },
        }, {
            toolName: 'artifact.read',
            args: { artifactId: 'artifact-long' },
            result: {
                artifactId: 'artifact-long',
                title: '长报告',
                content: '报告正文'.repeat(3000),
            },
        }],
    }],
});
const microcompressedPayload = JSON.stringify(microcompressedSources.payload.sections);
assert.match(microcompressedPayload, /stable_reference/);
assert.match(microcompressedPayload, /chapter:chapter-long:content/);
assert.match(microcompressedPayload, /attachment:attachment-long:text/);
assert.match(microcompressedPayload, /agent-artifact:artifact-long:content/);
assert.match(microcompressedPayload, /contentHash/);
assert.ok(microcompressedSources.diagnostics.compressedSectionIds.includes('tool-observations'));
assert.equal(microcompressedPayload.includes('章节正文'.repeat(3000)), false);

const volatileToolResult = '尚未持久化的工具结果'.repeat(1200);
const volatileToolContext = assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    currentRequest: { message: '检查当前工具结果。' },
    sections: [{
        id: 'volatile-tool-output',
        kind: 'tool',
        priority: 'required',
        sourceRef: 'current-exploration-working-memory',
        value: [{ toolName: 'custom.inspect', args: {}, result: volatileToolResult }],
    }],
});
assert.match(JSON.stringify(volatileToolContext.payload.sections), /尚未持久化的工具结果/);
assert.doesNotMatch(JSON.stringify(volatileToolContext.payload.sections), /stable_reference/);

const persistedToolContext = assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    currentRequest: { message: '检查已持久化工具结果。' },
    sections: [{
        id: 'persisted-tool-output',
        kind: 'tool',
        priority: 'high',
        sourceRef: 'evidence-snapshot:evidence-long',
        value: [{ toolName: 'custom.inspect', args: { scope: 'chapter' }, result: volatileToolResult }],
    }],
});
const persistedToolPayload = JSON.stringify(persistedToolContext.payload.sections);
assert.match(persistedToolPayload, /stable_reference/);
assert.match(persistedToolPayload, /evidence-snapshot:evidence-long:tool-result:custom\.inspect:/);

const unsavedEditorContent = 'unsaved editor text '.repeat(500);
const unsavedEditor = assembler.assemble({
    providerType: 'http',
    model: 'custom-model',
    contextWindowTokens: 32_768,
    outputTokens: 1024,
    currentRequest: { message: '检查当前未保存正文。' },
    sections: [{
        id: 'current-editor-content',
        kind: 'retrieval',
        priority: 'high',
        sourceRef: 'chapter:chapter-long:editor-buffer',
        value: unsavedEditorContent,
    }],
});
assert.equal(unsavedEditor.payload.sections[0].value, unsavedEditorContent);
assert.doesNotMatch(JSON.stringify(unsavedEditor.payload.sections), /stable_reference/);

const mcpBudget = assembler.assemble({
    providerType: 'mcp-cli',
    outputTokens: 1024,
    systemPrompt: 'System',
    currentRequest: 'continue',
    history: longHistory,
}).diagnostics.inputBudgetTokens;
const geminiBudget = assembler.assemble({
    providerType: 'http',
    model: 'gemini-2.5-pro',
    outputTokens: 1024,
    systemPrompt: 'System',
    currentRequest: 'continue',
    history: longHistory,
}).diagnostics.inputBudgetTokens;
assert.ok(geminiBudget > mcpBudget);

const scaleHistory = Array.from({ length: 180 }, (_, index) => ({
    messageId: `scale-${index + 1}`,
    sequence: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `长会话第 ${index + 1} 条：${'人物关系、叙事视角、伏笔位置与当前任务状态。'.repeat(60)}`,
}));
for (const contextWindowTokens of [8_192, 32_768, 131_072]) {
    const currentMessage = `窗口 ${contextWindowTokens} 下必须逐字保留的当前请求。`;
    const scaled = assembler.assemble({
        providerType: 'http',
        model: 'custom-scale-model',
        contextWindowTokens,
        outputTokens: 1_024,
        systemPrompt: 'You are a novel editor. '.repeat(12),
        toolSchema: JSON.stringify({ tools: [{ name: 'chapter.read', input: { chapterId: 'string' } }] }),
        currentRequest: { message: currentMessage },
        protectedContext: { storageConversationId: `scale-${contextWindowTokens}`, currentPlan: { goal: '保持连续性' } },
        history: scaleHistory,
        requireHardTokenCount: true,
    });
    assert.equal(scaled.payload.currentRequest.message, currentMessage);
    assert.equal(scaled.diagnostics.currentRequestMode, 'raw');
    assert.equal(scaled.diagnostics.hardTokenCountMethod, 'conservative_upper_bound');
    assert.ok(scaled.diagnostics.contextTokens <= scaled.diagnostics.hardContextBudget);
    assert.ok(scaled.diagnostics.providerInputTokens <= scaled.diagnostics.hardProviderInputLimit);
    assert.equal(
        scaled.diagnostics.projectedNextTurnContextTokens,
        scaled.diagnostics.contextTokens + scaled.diagnostics.nextTurnReserveTokens,
    );
    assert.equal(
        scaled.diagnostics.wouldRetriggerNextTurn,
        scaled.diagnostics.projectedNextTurnContextTokens >= scaled.diagnostics.triggerContextBudget,
    );
}

const summaryBeforeModelSwitch = JSON.stringify(recallSummaryV2);
for (const contextWindowTokens of [131_072, 8_192, 131_072]) {
    const switched = assembler.assemble({
        providerType: 'http',
        model: 'custom-switch-model',
        contextWindowTokens,
        outputTokens: 1_024,
        systemPrompt: 'Continue the same novel collaboration.',
        currentRequest: { message: '切换模型后继续，并保留之前确认的约束。' },
        history: recallHistory,
        persistentSummary: recallSummaryV2,
        requireHardTokenCount: true,
    });
    assert.equal(switched.diagnostics.contextVersion, 'agent-context-v2');
    assert.equal(switched.diagnostics.persistentSummaryRevision, recallSummaryV2.revision);
    assert.equal(switched.payload.currentRequest.message, '切换模型后继续，并保留之前确认的约束。');
    assert.ok(switched.diagnostics.contextTokens <= switched.diagnostics.hardContextBudget);
}
assert.equal(JSON.stringify(recallSummaryV2), summaryBeforeModelSwitch);

console.log('Agent context assembler tests passed.');
