import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentActivityProjection.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { projectAgentActivity } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

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

console.log('Agent activity projection tests passed.');
