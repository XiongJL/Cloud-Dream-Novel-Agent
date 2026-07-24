import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentRunProjection.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const projection = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const event = (sequence, type, payload = {}, stepId) => ({
    eventId: `event-${sequence}`,
    sequence,
    runId: 'run-recovery',
    stepId,
    type,
    payload,
    createdAt: `2026-07-11T00:00:0${sequence}.000Z`,
});

let state = {
    run: {
        runId: 'run-recovery',
        threadId: 'thread-1',
        planId: 'plan-1',
        status: 'running',
        currentStepId: 'step-1',
        progress: 0,
        events: [],
        pendingApproval: null,
    },
    plan: { steps: [{ stepId: 'step-1', status: 'pending' }] },
    messages: [],
    error: '',
};

const apply = (nextEvent) => {
    state = projection.applyAgentRunEvent(
        state,
        nextEvent,
        () => ({ id: `message-${nextEvent.sequence}`, createdAt: nextEvent.createdAt }),
    );
};

apply(event(1, 'step_started', {}, 'step-1'));
apply(event(2, 'message', { content: '读取当前章节上下文' }, 'step-1'));
assert.equal(state.messages.length, 0);
apply(event(3, 'approval_required', {
    checkpointId: 'checkpoint-1',
    checkpointType: 'creative_direction',
    title: '选择创作方向',
    question: '采用哪个方向？',
    options: [{ id: 'fast', label: '加快节奏' }],
    allowFreeText: true,
}, 'step-1'));

assert.equal(state.run.status, 'waiting_approval');
assert.equal(projection.getActiveRunApproval(state.run)?.checkpointId, 'checkpoint-1');

apply(event(4, 'message', { kind: 'approval_submitted', content: '已选择：加快节奏' }, 'step-1'));
assert.equal(state.run.status, 'running');
assert.equal(state.run.pendingApproval, null);
assert.equal(state.messages.length, 0);

apply(event(5, 'step_completed', {}, 'step-1'));
apply(event(6, 'draft_created', { draftSessionId: 'draft-session-1' }, 'step-1'));
apply(event(7, 'artifact_created', {
    artifact: {
        artifactId: 'artifact-1',
        runId: 'run-recovery',
        planId: 'plan-1',
        type: 'chapter_draft',
        title: '章节修改草稿',
        status: 'ready',
        summary: '新增章末钩子',
        reference: { draftSessionId: 'draft-session-1' },
        metadata: { toolName: 'chapter.generate_draft' },
        createdAt: '2026-07-11T00:00:07.000Z',
    },
}, 'step-1'));
apply(event(8, 'artifact_created', {
    artifact: {
        artifactId: 'artifact-plotline-1',
        runId: 'run-recovery',
        planId: 'plan-1',
        type: 'plotline_analysis',
        title: '情节线分析',
        status: 'ready',
        summary: '主线推进正常，一条伏笔待回收',
        reference: { scope: 'volume', volumeId: 'volume-1' },
        metadata: { analysis: { scope: 'volume', threads: [], issues: [] } },
        createdAt: '2026-07-11T00:00:08.000Z',
    },
}, 'step-1'));
apply(event(9, 'message', { kind: 'final_report', content: '最终报告内容' }));
assert.equal(state.messages.at(-1)?.content, '最终报告内容');
apply(event(10, 'run_completed'));

assert.equal(state.plan.steps[0].status, 'completed');
assert.equal(state.run.status, 'completed');
assert.equal(state.run.progress, 1);
assert.equal(state.run.currentStepId, undefined);
assert.equal(state.run.draftSessionId, 'draft-session-1');
assert.equal(state.run.artifacts.length, 2);
assert.equal(state.run.artifacts[0].artifactId, 'artifact-1');
assert.equal(state.run.artifacts[0].reference.draftSessionId, 'draft-session-1');
assert.equal(state.run.artifacts[1].type, 'plotline_analysis');
assert.equal(state.run.artifacts[1].metadata.analysis.scope, 'volume');

let failedState = {
    run: {
        runId: 'run-recovery',
        threadId: 'thread-1',
        planId: 'plan-1',
        status: 'running',
        currentStepId: 'step-1',
        progress: 0.75,
        events: [],
    },
    plan: { steps: [{ stepId: 'step-1', status: 'running' }] },
    messages: [],
    error: '',
};
failedState = projection.applyAgentRunEvent(
    failedState,
    event(11, 'run_failed', { message: '模型服务暂时不可用，已重试 3 次。', failureRevision: 2 }, 'step-1'),
    () => ({ id: 'unused', createdAt: '2026-07-11T00:00:11.000Z' }),
);
assert.equal(failedState.run.status, 'failed');
assert.equal(failedState.run.failureRevision, 2);

const restored = JSON.parse(JSON.stringify(state));
const snapshot = projection.getRunRecoverySnapshot(restored.run);
assert.deepEqual(snapshot, {
    runId: 'run-recovery',
    lastSequence: 10,
    isLive: false,
    draftSessionId: 'draft-session-1',
    pendingApproval: null,
});

const waitingRestored = JSON.parse(JSON.stringify({
    ...state.run,
    status: 'waiting_approval',
    pendingApproval: null,
    events: state.run.events.slice(0, 3),
    draftSessionId: undefined,
}));
const waitingSnapshot = projection.getRunRecoverySnapshot(waitingRestored);
assert.equal(waitingSnapshot.isLive, true);
assert.equal(waitingSnapshot.lastSequence, 3);
assert.equal(waitingSnapshot.pendingApproval?.checkpointId, 'checkpoint-1');

console.log('Agent run projection and refresh recovery tests passed.');
