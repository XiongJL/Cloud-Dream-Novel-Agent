import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const preload = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');

assert.match(preload, /ensureReady: \(\) => ipcRenderer\.invoke\('agent:ensure-ready'\)/);
assert.match(preload, /restart: \(\) => ipcRenderer\.invoke\('agent:restart'\)/);
assert.match(main, /ipcMain\.handle\('agent:ensure-ready'/);
assert.match(main, /ipcMain\.handle\('agent:restart'/);

const sendStart = workspace.indexOf('const sendChat = async (messageOverride?: string) => {');
const sendEnd = workspace.indexOf('const submitApproval = async', sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, 'sendChat block should exist');
const sendChat = workspace.slice(sendStart, sendEnd);
const ensureIndex = sendChat.indexOf('await ensureRuntimeReady()');
const clearIndex = sendChat.indexOf("if (messageOverride === undefined) setInput('')");
const appendIndex = sendChat.indexOf('appendMessage(');
assert.ok(ensureIndex >= 0, 'sendChat should ensure Runtime readiness');
assert.ok(clearIndex > ensureIndex, 'input must only clear after Runtime recovery succeeds');
assert.ok(appendIndex > ensureIndex, 'user message must only be appended after Runtime recovery succeeds');
assert.match(sendChat.slice(ensureIndex, clearIndex), /if \(!runtime\.ok\)[\s\S]*?return;/);

assert.match(workspace, /Runtime 响应较慢/);
assert.match(workspace, /正在恢复 Runtime/);
assert.match(workspace, /Runtime 不可用/);
assert.match(workspace, /title="重试 Runtime"/);
assert.match(workspace, /setInput\(initialGoal\)[\s\S]*?Runtime 不可用，请重试后发送/);

console.log('Agent Runtime Renderer contract tests passed.');
