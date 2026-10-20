import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function load(relative) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
    return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}
const { reconcileTerminalRunStatus } = await load('../shared/agentTerminalStatus.ts');
const { applyAgentRunEvent } = await load('../shared/agentRunProjection.ts');
const { projectAgentActivity } = await load('../shared/agentActivityProjection.ts');
const live = { runId: 'run-1', status: 'running', events: [], progress: 0, artifacts: [] };
const failure = { code: 'STORAGE_DISK_FULL', message: '释放磁盘空间', retryable: false, persistenceFailed: true };
const failed = reconcileTerminalRunStatus(live, { runId: 'run-1', status: 'failed', failure });
assert.equal(failed.status, 'failed');
assert.equal(failed.failure, failure);
assert.equal(reconcileTerminalRunStatus(failed, { runId: 'run-1', status: 'running' }), failed);
assert.equal(reconcileTerminalRunStatus(live, { runId: 'other-run', status: 'failed' }), live);
assert.equal(reconcileTerminalRunStatus(live, { runId: 'run-1', status: 'running' }), live);
assert.equal(reconcileTerminalRunStatus({ ...live, status: 'waiting_approval' }, { runId: 'run-1', status: 'failed' }).status, 'failed');
const projected = applyAgentRunEvent({ run: live, messages: [], plan: null, error: '' }, {
    eventId: 'failure', runId: 'run-1', sequence: 2, type: 'run_failed', status: 'failed',
    payload: { ...failure, transient: true }, createdAt: '2026-10-11T00:00:00Z',
}, () => { throw new Error('System failure must not generate a conversation message'); });
assert.equal(projected.run.status, 'failed');
assert.equal(projected.run.failure.code, failure.code);
assert.equal(projected.error, failure.message);
const late = applyAgentRunEvent(projected, { eventId: 'late-input', runId: 'run-1', sequence: 1,
    type: 'user_input_resolved', payload: {}, createdAt: '2026-10-11T00:00:00Z' }, () => ({ id: 'unused', createdAt: '' }));
assert.equal(late.run.status, 'failed', 'A delayed SSE event cannot revive a terminal task');
assert.equal(late.run.pendingUserInput, null);
for (const status of ['failed', 'cancelled']) {
    const activity = projectAgentActivity({ status, events: [{ eventId: 'tool-running', runId: 'run-1', sequence: 1,
        type: 'tool_call', toolName: 'style_source.read', status: 'running', payload: {}, createdAt: '2026-10-11T00:00:00Z' }] });
    assert.equal(activity.tone, status);
    assert.ok(activity.details.length > 0);
    assert.ok(activity.details.every((detail) => !['running', 'waiting'].includes(detail.status)), 'Terminal task details must stop spinning');
}
const workspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
assert.match(workspace, /reportPersistenceError\(err\)/);
assert.match(workspace, /reportPersistenceError\(error\)/);
assert.match(workspace, /persistenceError &&[\s\S]*?role="alert"/);
assert.match(workspace, /setInterval\([\s\S]*?5000\)/);
assert.match(workspace, /status\.failure\?\.message/);
const preload = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
assert.match(preload, /runStatus:.*invokeAgentWithStructuredError/);
assert.match(preload, /executePlan:.*invokeAgentWithStructuredError/);
console.log('Agent system failure and terminal reconciliation tests passed.');
