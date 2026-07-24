import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(scriptDir, '../shared/agentSseProtocol.ts');
const source = await fs.readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ES2020,
    },
    fileName: sourcePath,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`;
const protocol = await import(moduleUrl);

const stream = [
    ': keepalive\r\n\r\n',
    'event: agent_run_event\r\n',
    'data: {"eventId":"evt_1","sequence":1,\r\n',
    'data: "runId":"run_1","type":"message"}\r\n\r\n',
    'event: agent_run_event\n',
    'data: {"eventId":"evt_2","sequence":2,"runId":"run_1","type":"run_completed"}\n\n',
].join('');

let buffer = '';
const frames = [];
for (const character of stream) {
    const consumed = protocol.consumeSseChunk(buffer, character);
    buffer = consumed.buffer;
    frames.push(...consumed.frames);
}

assert.equal(buffer, '');
assert.equal(frames.length, 2);
assert.equal(frames[0].eventName, 'agent_run_event');
assert.deepEqual(JSON.parse(frames[0].data), {
    eventId: 'evt_1',
    sequence: 1,
    runId: 'run_1',
    type: 'message',
});
assert.equal(JSON.parse(frames[1].data).type, 'run_completed');

assert.equal(protocol.isTerminalRunEvent('run_completed'), true);
assert.equal(protocol.isTerminalRunEvent('run_failed'), true);
assert.equal(protocol.isTerminalRunEvent('run_cancelled'), true);
assert.equal(protocol.isTerminalRunEvent('message'), false);

assert.equal(protocol.shouldApplyRunSequence(8, 7), true);
assert.equal(protocol.shouldApplyRunSequence(7, 7), false);
assert.equal(protocol.shouldApplyRunSequence(6, 7), false);

assert.equal(protocol.shouldResubscribeRun('running', 12, 12), true);
assert.equal(protocol.shouldResubscribeRun('waiting_approval', 12, 12), true);
assert.equal(protocol.shouldResubscribeRun('completed', 11, 12), true);
assert.equal(protocol.shouldResubscribeRun('failed', 11, 12), true);
assert.equal(protocol.shouldResubscribeRun('completed', 12, 12), false);
assert.equal(protocol.shouldResubscribeRun('cancelled', 12, 12), false);

console.log('Agent SSE protocol tests passed.');
