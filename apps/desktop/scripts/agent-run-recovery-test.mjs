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
    event(11, 'run_failed', {
        message: '生成结果已保存，但格式检查未通过。可直接修复结果并继续。',
        failureRevision: 2,
        completionKind: 'partial',
        recovery: {
            failureKind: 'model_output_invalid',
            failedAtPhase: 'normalizing',
            retryStrategy: 'repair_model_output',
            canRecover: true,
            recoveryRevision: 2,
            actionLabel: '修复结果并继续',
            completedArtifactIds: [],
            affectedArtifactIds: [],
            diagnosticRef: 'diagnostic-run-recovery',
        },
    }, 'step-1'),
    () => ({ id: 'unused', createdAt: '2026-07-11T00:00:11.000Z' }),
);
assert.equal(failedState.run.status, 'failed');
assert.equal(failedState.run.failureRevision, 2);
assert.equal(failedState.run.completionKind, 'partial');
assert.equal(failedState.run.recovery.retryStrategy, 'repair_model_output');
assert.equal(failedState.run.recovery.actionLabel, '修复结果并继续');

const restored = JSON.parse(JSON.stringify(state));
const snapshot = projection.getRunRecoverySnapshot(restored.run);
assert.deepEqual(snapshot, {
    runId: 'run-recovery',
    lastSequence: 10,
    isLive: false,
    draftSessionId: 'draft-session-1',
    pendingApproval: null,
    pendingUserInput: null,
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

const inputRequest = {
    schemaVersion: 'agent-user-input-v1',
    requestId: 'input-1',
    conversationId: 'thread-1',
    phase: 'execution',
    title: '确认两个方向',
    reason: '答案会改变后续执行。',
    questions: [{
        questionId: 'direction',
        header: '方向',
        prompt: '请选择方向。',
        options: [
            { optionId: 'first', label: '第一项', description: '推荐方向。' },
            { optionId: 'second', label: '第二项', description: '备选方向。' },
        ],
        recommendedOptionId: 'first',
        recommendationReason: '第一项更稳。',
        allowCustom: true,
    }],
};
let inputState = {
    run: {
        runId: 'run-recovery', threadId: 'thread-1', planId: 'plan-1', status: 'running',
        currentStepId: 'step-1', progress: 0.5, events: [], pendingUserInput: null,
    },
    plan: { steps: [{ stepId: 'step-1', status: 'running' }] },
    messages: [],
    error: '',
};
inputState = projection.applyAgentRunEvent(inputState, event(12, 'user_input_required', inputRequest, 'step-1'), () => ({ id: 'unused' }));
assert.equal(inputState.run.status, 'waiting_user_input');
assert.equal(projection.getActiveRunUserInput(inputState.run)?.questions.length, 1);
assert.equal(projection.getRunRecoverySnapshot(inputState.run).pendingUserInput?.requestId, 'input-1');
inputState = projection.applyAgentRunEvent(
    inputState,
    event(13, 'user_input_resolved', { requestId: 'input-1', understandingSummary: '采用第一项。' }, 'step-1'),
    () => ({ id: 'unused' }),
);
assert.equal(inputState.run.status, 'running');
assert.equal(inputState.run.pendingUserInput, null);

const beat = (title, revision) => ({
    title,
    chapterGoal: `目标 ${revision}`,
    coreConflict: `冲突 ${revision}`,
    keyEvents: [`事件 ${revision}`],
    reveals: [`揭示 ${revision}`],
    endingHook: `钩子 ${revision}`,
    targetWordCount: 2000,
    beatId: `beat-${revision}`,
    childIndex: 0,
});
const beatCheckpoint = (revision, extra = {}) => ({
    checkpointId: `batch-beats:batch-1:${revision}`,
    checkpointType: 'chapter_beats',
    title: '确认 1 章节拍',
    question: '确认后生成正文',
    reason: '正文依赖节拍。',
    options: [{ id: 'approve_beats', label: '确认并生成' }],
    allowFreeText: true,
    freeTextPlaceholder: '告诉我如何调整这些章节节拍……',
    draftBatchId: 'batch-1',
    outlineRevision: revision,
    revisionCount: revision - 1,
    maxRevisionCount: 10,
    beats: [beat(`第 ${revision} 版`, revision)],
    ...extra,
});
const beatEvents = [
    event(20, 'tool_result', { summary: '初始节拍已生成' }, 'step-1'),
    event(21, 'approval_required', beatCheckpoint(1), 'step-1'),
    event(22, 'message', {
        kind: 'approval_submitted',
        response: {
            checkpointId: 'batch-beats:batch-1:1',
            checkpointType: 'chapter_beats',
            selectedOptionIds: [],
            freeText: '加强第二幕冲突',
            summary: '加强第二幕冲突',
        },
    }, 'step-1'),
    event(23, 'tool_call', { summary: '正在修订' }, 'step-1'),
    event(24, 'tool_result', { summary: '修订完成' }, 'step-1'),
    event(25, 'approval_required', beatCheckpoint(2), 'step-1'),
    event(26, 'tool_result', { summary: 'Provider 暂时不可用' }, 'step-1'),
    event(27, 'approval_required', beatCheckpoint(2, { revisionError: 'Provider 暂时不可用' }), 'step-1'),
];
const beatTimeline = projection.projectChapterBeatTimeline({
    runId: 'run-beats',
    threadId: 'thread-1',
    planId: 'plan-1',
    status: 'waiting_approval',
    progress: 0.5,
    events: beatEvents,
    pendingApproval: projection.approvalFromRunEvent(beatEvents.at(-1)),
});
assert.deepEqual(beatTimeline.map((item) => item.kind), ['activity', 'checkpoint', 'revision', 'activity', 'checkpoint']);
const checkpoints = beatTimeline.filter((item) => item.kind === 'checkpoint');
assert.deepEqual(checkpoints.map((item) => item.approval.outlineRevision), [1, 2]);
assert.equal(checkpoints.at(-1).active, true);
assert.equal(checkpoints.at(-1).approval.revisionError, 'Provider 暂时不可用');
assert.equal(checkpoints.at(-1).approval.beats[0].title, '第 2 版');

console.log('Agent run projection and refresh recovery tests passed.');
