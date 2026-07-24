import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../electron/ai/context/AgentContextAssembler.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
    AgentContextAssembler,
    estimateAgentContextTokens,
    resolveAgentContextWindow,
} = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

assert.deepEqual(resolveAgentContextWindow('http', 'gpt-4.1-mini', 0), {
    tokens: 262_144,
    source: 'model-profile',
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
assert.ok(constrained.summaryUpdate.coveredMessageIds.length > 0);
assert.ok(constrained.summaryUpdate.userDecisions.some((entry) => entry.sourceMessageIds.includes('message-2')));
assert.equal(constrained.summaryUpdate.artifactRefs[0].artifactId, 'artifact-white-deer-review');

const recalled = assembler.assemble({
    providerType: 'http',
    model: 'custom-small',
    contextWindowTokens: 8192,
    outputTokens: 768,
    systemPrompt: 'You are a novel editor.',
    currentRequest: { message: '回顾之前不要改变叙事视角的决定，以及 artifact-white-deer-review 的结论。' },
    history: longHistory,
    persistentSummary: constrained.summaryUpdate,
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
assert.equal(recalled.diagnostics.persistentSummaryMessageCount, constrained.summaryUpdate.coveredMessageIds.length);
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
    persistentSummary: constrained.summaryUpdate,
});
assert.equal(incremented.summaryUpdate.revision, 2);
assert.ok(incremented.summaryUpdate.coveredMessageIds.length > constrained.summaryUpdate.coveredMessageIds.length);

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

console.log('Agent context assembler tests passed.');
