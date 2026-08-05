import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentConversationTimeline.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { agentDateTimestamp, buildAgentConversationTimeline, mergeAgentRunHistory } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const plan = (planId, title) => ({
    planId,
    threadId: `thread-${planId}`,
    title,
    goal: title,
    requiresApproval: true,
    steps: [],
});
const run = (runId, planSnapshot, startedAt) => ({
    runId,
    status: 'completed',
    planSnapshot,
    events: [{ type: 'run_started', createdAt: startedAt }],
});

const firstPlan = plan('plan-1', '第一轮任务');
const firstRun = run('run-1', firstPlan, '2026-07-13T01:00:02.000Z');
const timeline = buildAgentConversationTimeline({
    messages: [
        { id: 'before', role: 'user', content: '开始第一轮', createdAt: '2026-07-13T01:00:00.000Z' },
        { id: 'compression', role: 'system', content: '{"kind":"agent_context_compression_v1"}', createdAt: '2026-07-13T01:00:04.000Z' },
        { id: 'report', role: 'assistant', content: '第一轮完成', createdAt: '2026-07-13T01:00:05.000Z' },
        { id: 'follow-up', role: 'user', content: '继续处理', createdAt: '2026-07-13T01:00:06.000Z' },
    ],
    runs: [firstRun],
    currentRun: null,
    currentPlan: null,
    updatedAt: '2026-07-13T01:00:06.000Z',
});
assert.deepEqual(timeline.map((entry) => entry.key), [
    'message:before',
    'run:run-1',
    'message:compression',
    'message:report',
    'message:follow-up',
]);

const secondPlan = plan('plan-2', '第二轮任务');
const secondRun = run('run-2', secondPlan, '2026-07-13T01:00:08.000Z');
const twoRounds = buildAgentConversationTimeline({
    messages: timeline.filter((entry) => entry.kind === 'message').map((entry) => entry.message),
    runs: [firstRun, secondRun],
    currentRun: secondRun,
    currentPlan: secondPlan,
    updatedAt: '2026-07-13T01:00:08.000Z',
});
assert.deepEqual(twoRounds.filter((entry) => entry.kind === 'task').map((entry) => entry.key), [
    'run:run-1',
    'run:run-2',
]);
assert.equal(twoRounds.filter((entry) => entry.key === 'run:run-2').length, 1);
assert.deepEqual(mergeAgentRunHistory([firstRun, secondRun], { ...firstRun, status: 'failed' }).map((item) => item.runId), [
    'run-1',
    'run-2',
]);
assert.equal(agentDateTimestamp('2026-07-13T01:00:02.000Z', 0), Date.parse('2026-07-13T01:00:02.000Z'));
assert.equal(agentDateTimestamp(new Date('2026-07-13T01:00:02.000Z'), 0), Date.parse('2026-07-13T01:00:02.000Z'));
assert.equal(agentDateTimestamp(123456, 0), 123456);
assert.equal(agentDateTimestamp({ invalid: true }, 42), 42);

const executionResolution = {
    requestId: 'request-execution-1',
    phase: 'execution',
    resolvedAt: '2026-07-13T01:00:03.000Z',
    request: { runId: 'run-1' },
    run: { runId: 'run-1' },
};
const prePlanResolution = {
    requestId: 'request-plan-2',
    phase: 'pre_plan',
    resolvedAt: '2026-07-13T01:00:07.000Z',
    plan: { planId: 'plan-2' },
};
const unresolvedTaskResolution = {
    requestId: 'request-chat-only',
    phase: 'pre_plan',
    resolvedAt: '2026-07-13T01:00:09.000Z',
};
const timelineWithResolutions = buildAgentConversationTimeline({
    messages: [],
    runs: [firstRun, secondRun],
    currentRun: secondRun,
    currentPlan: secondPlan,
    resolutions: [unresolvedTaskResolution, prePlanResolution, executionResolution],
    updatedAt: '2026-07-13T01:00:09.000Z',
});
const firstTask = timelineWithResolutions.find((entry) => entry.key === 'run:run-1');
const secondTask = timelineWithResolutions.find((entry) => entry.key === 'run:run-2');
assert.equal(firstTask?.kind, 'task');
assert.equal(secondTask?.kind, 'task');
assert.deepEqual(firstTask.resolutions.map((item) => item.requestId), ['request-execution-1']);
assert.deepEqual(secondTask.resolutions.map((item) => item.requestId), ['request-plan-2']);
assert.equal(timelineWithResolutions.filter((entry) => entry.key === 'resolution:request-execution-1').length, 0);
assert.equal(timelineWithResolutions.find((entry) => entry.key === 'resolution:request-chat-only')?.kind, 'resolution');

console.log('Agent conversation chronological timeline tests passed.');
