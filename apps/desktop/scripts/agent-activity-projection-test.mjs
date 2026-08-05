import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentActivityProjection.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { projectAgentActivity, projectChatActivity } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const event = (sequence, type, payload = {}, extra = {}) => ({
    eventId: `event-${sequence}`,
    sequence,
    type,
    payload,
    createdAt: `2026-07-14T00:00:0${sequence}.000Z`,
    ...extra,
});

let projection = projectAgentActivity({
    status: 'running',
    events: [
        event(1, 'run_started'),
        event(2, 'step_started', { title: '读取当前大纲' }),
        event(3, 'tool_call', { summary: '正在读取主线', args: { novelId: 'novel-1', token: 'secret' } }, { toolName: 'plotline.list', status: 'running' }),
    ],
});
assert.equal(projection.summary, '正在调用 plotline.list');
assert.equal(projection.details.at(-1)?.metadata[0].value.includes('[已脱敏]'), true);

projection = projectAgentActivity({
    status: 'completed',
    events: [
        event(1, 'run_started'),
        event(2, 'step_started', { title: '读取项目资料' }, { stepId: 'step-1' }),
        event(3, 'tool_call', { summary: '正在调用 search.query', transport: 'fastmcp', args: { keyword: '伏笔' } }, { stepId: 'step-1', toolName: 'search.query', status: 'running' }),
        event(4, 'tool_result', { summary: 'search.query returned 1 items', transport: 'fastmcp', durationMs: 420 }, { stepId: 'step-1', toolName: 'search.query', status: 'completed' }),
        event(5, 'step_completed', { title: '读取项目资料' }, { stepId: 'step-1', status: 'completed' }),
        event(6, 'run_completed'),
    ],
});
assert.equal(projection.details.length, 4);
assert.equal(projection.details[1].title, '读取项目资料');
assert.equal(projection.details[1].status, 'completed');
assert.equal(projection.details[2].title, 'search.query');
assert.equal(projection.details[2].status, 'completed');
assert.equal(projection.details[2].summary, 'search.query returned 1 items');
assert.deepEqual(projection.details[2].metadata.map((item) => item.label), ['传输', '参数', '耗时']);
assert.equal(projection.details[2].metadata[0].value, 'fastmcp');

projection = projectAgentActivity({
    status: 'waiting_approval',
    events: [event(1, 'approval_required', { title: '创作方向', question: '选择哪条路线？' })],
});
assert.equal(projection.summary, '需要你确认：创作方向');

projection = projectAgentActivity({
    status: 'completed',
    events: [
        event(1, 'run_started'),
        event(2, 'tool_result', { summary: '读取完成' }, { toolName: 'chapter.get', status: 'completed' }),
        event(3, 'draft_created'),
        event(4, 'artifact_created', { artifact: { title: '章节修改草稿', summary: '草稿已生成' } }),
        event(5, 'run_completed'),
    ],
});
assert.equal(projection.summary, '已完成 · 调用 1 项工具 · 生成 1 份草稿 · 4 秒');
assert.equal(projection.details.length, 5);
assert.equal(projection.details[3].title, '已生成产物：章节修改草稿');

projection = projectAgentActivity({
    status: 'completed',
    events: [
        event(1, 'run_started'),
        event(2, 'toolchain_started', { toolchainId: 'chapter.context', title: '章节上下文装配' }, { stepId: 'step-chain' }),
        event(3, 'toolchain_node_started', { toolchainId: 'chapter.context', nodeId: 'chapter.read' }, { stepId: 'step-chain', toolName: 'chapter.get', status: 'running' }),
        event(4, 'tool_call', { nodeId: 'chapter.read', summary: '正在调用 chapter.get', args: { chapterId: 'chapter-1' } }, { stepId: 'step-chain', toolName: 'chapter.get', status: 'running' }),
        event(5, 'tool_result', { nodeId: 'chapter.read', summary: '第一章' }, { stepId: 'step-chain', toolName: 'chapter.get', status: 'completed' }),
        event(6, 'toolchain_node_completed', { toolchainId: 'chapter.context', nodeId: 'chapter.read', summary: '第一章' }, { stepId: 'step-chain', toolName: 'chapter.get', status: 'completed' }),
        event(7, 'toolchain_completed', { toolchainId: 'chapter.context', title: '章节上下文装配' }, { stepId: 'step-chain', status: 'completed' }),
        event(8, 'run_completed'),
    ],
});
assert.equal(projection.details.length, 5);
assert.equal(projection.details[1].title, '章节上下文装配');
assert.equal(projection.details[1].status, 'completed');
assert.equal(projection.details[2].title, 'chapter.read');
assert.equal(projection.details[2].status, 'completed');
assert.equal(projection.details[3].title, 'chapter.get');
assert.equal(projection.details[3].status, 'completed');

projection = projectAgentActivity({
    status: 'failed',
    events: [event(1, 'run_failed', { message: 'HTTP request timeout' })],
});
assert.equal(projection.summary, 'HTTP request timeout');
assert.equal(projection.tone, 'failed');

projection = projectAgentActivity({
    status: 'running',
    events: [
        event(1, 'run_started'),
        event(2, 'request_retry_scheduled', {
            nodeId: 'final_report',
            retryAttempt: 2,
            retryLimit: 3,
            httpStatus: 504,
            diagnosticRef: 'agenterr_1234',
            retryable: true,
        }),
    ],
});
assert.equal(projection.summary, '网络波动，正在重试 2/3');
assert.equal(projection.retry?.phase, 'scheduled');
assert.equal(projection.retry?.stage, '整理最终回答');
assert.deepEqual(projection.details.at(-1)?.metadata.map((item) => item.label), ['重试', 'HTTP 状态', '诊断编号']);

projection = projectAgentActivity({
    status: 'failed',
    events: [
        event(1, 'request_retry_exhausted', {
            nodeId: 'final_report',
            retryAttempt: 3,
            retryLimit: 3,
            httpStatus: 504,
            diagnosticRef: 'agenterr_5678',
            retryable: true,
        }),
        event(2, 'run_failed', { message: '模型服务暂时不可用，已重试 3 次。', failureRevision: 1 }),
    ],
});
assert.equal(projection.summary, '模型服务暂时不可用，已重试 3 次。');
assert.equal(projection.retry?.phase, 'exhausted');
assert.equal(projection.retry?.retryable, true);

projection = projectAgentActivity({
    status: 'running',
    events: [
        event(1, 'run_started', { retryOfRunId: 'run-failed' }),
        event(2, 'run_retry_started', {
            retryOfRunId: 'run-failed',
            retryAttempt: 1,
            resumedFrom: { nodeId: 'final_report' },
        }),
    ],
});
assert.equal(projection.summary, '正在从失败步骤继续');
assert.equal(projection.retry?.phase, 'resuming');

const chatProjection = projectChatActivity([
    {
        eventId: 'chat-1',
        sequence: 1,
        requestId: 'request-1',
        type: 'request_started',
        status: 'running',
        displayName: '正在校验章节范围',
        createdAt: '2026-07-14T00:00:01.000Z',
    },
    {
        eventId: 'chat-2',
        sequence: 2,
        requestId: 'request-1',
        callId: 'tool-call-1',
        type: 'tool_started',
        status: 'running',
        displayName: '正在读取章节',
        toolName: 'chapter.get',
        createdAt: '2026-07-14T00:00:02.000Z',
    },
    {
        eventId: 'chat-3',
        sequence: 3,
        requestId: 'request-1',
        callId: 'tool-call-1',
        type: 'tool_completed',
        status: 'completed',
        displayName: '已读取《第一章》',
        toolName: 'chapter.get',
        elapsedMs: 320,
        createdAt: '2026-07-14T00:00:03.000Z',
    },
    {
        eventId: 'chat-4',
        sequence: 4,
        requestId: 'request-1',
        callId: 'model-call-1',
        type: 'model_started',
        status: 'running',
        displayName: '正在生成读者反馈',
        createdAt: '2026-07-14T00:00:04.000Z',
    },
    {
        eventId: 'chat-5',
        sequence: 5,
        requestId: 'request-1',
        callId: 'model-call-1',
        type: 'model_completed',
        status: 'failed',
        displayName: '模型生成失败',
        elapsedMs: 60012,
        details: { errorCode: 'PROVIDER_UNAVAILABLE' },
        createdAt: '2026-07-14T00:01:01.000Z',
    },
    {
        eventId: 'chat-6',
        sequence: 6,
        requestId: 'request-1',
        type: 'request_completed',
        status: 'completed',
        displayName: '请求处理完成',
        createdAt: '2026-07-14T00:01:02.000Z',
    },
]);
assert.equal(chatProjection.summary, '请求处理完成');
assert.equal(chatProjection.tone, 'completed');
assert.deepEqual(chatProjection.details.map((detail) => detail.kind), ['status', 'tool', 'model', 'status']);
assert.deepEqual(chatProjection.details.map((detail) => detail.status), ['completed', 'completed', 'failed', 'completed']);
assert.equal(chatProjection.details[0].title, '已校验章节范围');
assert.equal(chatProjection.details[1].title, '已读取《第一章》');
assert.deepEqual(chatProjection.details[1].metadata.map((item) => item.label), ['耗时']);
assert.deepEqual(chatProjection.details[2].metadata.map((item) => item.label), ['耗时', '错误码']);
assert.equal(chatProjection.details.some((detail) => detail.status === 'running'), false);

const liveChatProjection = projectChatActivity([
    {
        eventId: 'chat-live',
        sequence: 1,
        requestId: 'request-live',
        callId: 'tool-call-live',
        type: 'tool_started',
        status: 'running',
        displayName: '正在读取章节',
        createdAt: '2026-07-14T00:02:00.000Z',
    },
], true);
assert.equal(liveChatProjection.summary, '正在读取章节');
assert.equal(liveChatProjection.tone, 'running');
assert.equal(liveChatProjection.details[0].status, 'running');

const cancelledChatProjection = projectChatActivity([
    {
        eventId: 'chat-cancelled-1',
        sequence: 1,
        requestId: 'request-cancelled',
        type: 'request_started',
        status: 'running',
        displayName: '正在校验章节范围',
        createdAt: '2026-07-14T00:03:00.000Z',
    },
    {
        eventId: 'chat-cancelled-2',
        sequence: 2,
        requestId: 'request-cancelled',
        type: 'request_cancelled',
        status: 'cancelled',
        displayName: '请求已取消',
        createdAt: '2026-07-14T00:03:01.000Z',
    },
]);
assert.equal(cancelledChatProjection.tone, 'cancelled');
assert.deepEqual(cancelledChatProjection.details.map((detail) => detail.status), ['cancelled', 'cancelled']);
assert.equal(cancelledChatProjection.details[0].title, '校验章节范围已取消');

const durableDraftProjection = projectAgentActivity({
    status: 'running',
    events: [
        event(1, 'draft_operation_started', {
            operationId: 'draft-operation-1',
            operationStatus: 'queued',
            operationVersion: 1,
        }),
        event(2, 'draft_operation_progress', {
            operationId: 'draft-operation-1',
            operationStatus: 'retry_wait',
            phase: 'accepted',
            attempt: 1,
            retryAt: '2026-07-14T00:00:05.000Z',
        }),
    ],
});
assert.equal(durableDraftProjection.summary, '生成暂时中断，后台将自动重试');
assert.equal(durableDraftProjection.details.at(-1)?.title, '草稿任务等待重试');
assert.equal(durableDraftProjection.details.at(-1)?.status, 'running');
assert.equal(durableDraftProjection.details.at(-1)?.metadata[0]?.label, '任务编号');

console.log('Agent activity projection tests passed.');
