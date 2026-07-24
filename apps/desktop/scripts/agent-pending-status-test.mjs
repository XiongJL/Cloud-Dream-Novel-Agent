import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentPendingStatus.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { pendingAgentStatusLabel } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const status = (phase, extras = {}) => ({ conversationId: 'conversation-1', phase, ...extras });

assert.equal(pendingAgentStatusLabel(status('thinking')), '思考中...');
assert.equal(pendingAgentStatusLabel(status('understanding')), '正在理解任务...');
assert.equal(pendingAgentStatusLabel(status('reading')), '正在读取附件...');
assert.equal(pendingAgentStatusLabel(status('reading', { detail: '“第二章”' })), '正在读取 “第二章”...');
assert.equal(pendingAgentStatusLabel(status('extending')), '信息仍不足，正在继续读取...');
assert.equal(pendingAgentStatusLabel(status('finalizing')), '正在汇总已读取内容...');
assert.equal(pendingAgentStatusLabel(status('planning')), '正在整理执行计划...');
assert.equal(pendingAgentStatusLabel(status('revising')), '正在按意见调整计划...');
assert.equal(
    pendingAgentStatusLabel(status('retrying', { retryAttempt: 2, retryLimit: 3 })),
    '网络波动，正在重试 2/3',
);
assert.equal(
    pendingAgentStatusLabel(status('retrying', { retryAttempt: 0, retryLimit: 3 })),
    '网络波动，正在重试...',
);

console.log('Agent pending status projection tests passed.');
