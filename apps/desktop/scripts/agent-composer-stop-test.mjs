import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.resolve(scriptDir, '../shared/agentComposerAction.ts');
const helperSource = await fs.readFile(helperPath, 'utf8');
const compiled = ts.transpileModule(helperSource, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ES2020,
    },
    fileName: helperPath,
});
const helperUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`;
const { resolveAgentComposerAction } = await import(helperUrl);

assert.deepEqual(resolveAgentComposerAction({}), {
    mode: 'send', target: null, disabled: false, label: '发送',
});
assert.deepEqual(resolveAgentComposerAction({ activeChatRequestId: 'chat-1' }), {
    mode: 'stop', target: 'chat', disabled: false, label: '停止任务',
});
assert.deepEqual(resolveAgentComposerAction({ activeChatRequestId: 'chat-1', stoppingChatRequestId: 'chat-1' }), {
    mode: 'stopping', target: 'chat', disabled: true, label: '正在停止',
});

for (const runStatus of ['running', 'waiting_approval', 'waiting_user_input']) {
    assert.deepEqual(resolveAgentComposerAction({ runStatus }), {
        mode: 'stop', target: 'run', disabled: false, label: '停止任务',
    });
}
assert.deepEqual(resolveAgentComposerAction({ runStatus: 'cancelling' }), {
    mode: 'stopping', target: 'run', disabled: true, label: '正在停止',
});
assert.deepEqual(resolveAgentComposerAction({ runStatus: 'running', draftOperationStatus: 'committing' }), {
    mode: 'saving', target: 'run', disabled: true, label: '正在保存',
});
assert.equal(
    resolveAgentComposerAction({ activeChatRequestId: 'stale-chat', runStatus: 'running' }).target,
    'run',
    'an active run must win over a stale chat request during handoff',
);
assert.equal(resolveAgentComposerAction({ runStatus: 'completed' }).mode, 'send');
assert.equal(resolveAgentComposerAction({ runStatus: 'failed' }).mode, 'send');

const workspacePath = path.resolve(scriptDir, '../src/components/AgentWorkspace/AgentWorkspace.tsx');
const workspace = await fs.readFile(workspacePath, 'utf8');
assert.match(workspace, /const composerAction = resolveAgentComposerAction\(/);
assert.match(workspace, /const stopActiveTask = \(\) => \{/);
assert.match(workspace, /composerAction\.target === 'run'/);
assert.match(workspace, /composerAction\.target === 'chat'/);
assert.match(workspace, /onClick=\{\(\) => composerTaskActive \? stopActiveTask\(\) : void sendChat\(\)\}/);
assert.match(workspace, /'h-10 w-10 rounded-full p-0'/);
assert.match(workspace, /<Square className="h-3\.5 w-3\.5 fill-current"/);
assert.doesNotMatch(workspace, /title="停止修订"/);
const disconnectFailureStart = workspace.indexOf('const finishDisconnectedRun = useCallback(');
const disconnectFailureEnd = workspace.indexOf('useEffect(() => {', disconnectFailureStart);
assert.ok(disconnectFailureStart >= 0 && disconnectFailureEnd > disconnectFailureStart, 'disconnect terminalizer should exist');
const disconnectFailure = workspace.slice(disconnectFailureStart, disconnectFailureEnd);
assert.match(disconnectFailure, /status: 'failed'/);
assert.match(disconnectFailure, /cancelRequested: false/);
assert.doesNotMatch(disconnectFailure, /failureRevision/);
assert.match(workspace, /finishDisconnectedRun\(payload\.runId, `事件流已断开：/);
assert.match(workspace, /finishDisconnectedRun\(runId, `恢复事件流失败：/);
assert.match(workspace, /disconnectRecoveryRunIdsRef\.current\.has\(activeRun\.runId\)/);
assert.match(workspace, /activeError\.startsWith\('事件流已断开：'\)/);
assert.match(workspace, /finishDisconnectedRun\(activeRun\.runId, activeError\)/);
assert.doesNotMatch(workspace, /任务已中断，可重试/);

console.log('Agent composer unified stop tests passed.');
