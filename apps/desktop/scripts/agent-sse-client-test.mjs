import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = new URL('../', import.meta.url);

async function importTypeScriptModule(relativePath, replacements = []) {
    const source = await readFile(new URL(relativePath, root), 'utf8');
    let output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            verbatimModuleSyntax: true,
        },
    }).outputText;
    for (const [from, to] of replacements) output = output.replace(from, to);
    return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

const protocolSource = await readFile(new URL('shared/agentSseProtocol.ts', root), 'utf8');
const protocolJs = ts.transpileModule(protocolSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const protocolUrl = `data:text/javascript;base64,${Buffer.from(protocolJs).toString('base64')}`;
const client = await importTypeScriptModule('electron/agent/agentSseClient.ts', [
    ["'../../shared/agentSseProtocol'", `'${protocolUrl}'`],
]);

const requests = [];
const firstEvent = {
    eventId: 'event-1', sequence: 1, runId: 'run/socket test', type: 'step_started', payload: {},
};
const terminalEvent = {
    eventId: 'event-2', sequence: 2, runId: 'run/socket test', type: 'run_completed', payload: {},
};

const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = requests.length === 1 ? firstEvent : terminalEvent;
    const frame = `event: agent_run_event\ndata: ${JSON.stringify(event)}\n\n`;
    response.write(frame.slice(0, 17));
    setTimeout(() => {
        response.write(frame.slice(17));
        if (requests.length === 1) {
            setTimeout(() => response.destroy(new Error('simulated disconnect')), 10);
        }
    }, 5);
});

await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
assert.ok(address && typeof address !== 'string');
const events = [];
const disconnects = [];

try {
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('first disconnect timed out')), 2000);
        client.subscribeAgentRunEventsHttp({
            port: address.port,
            token: 'secret',
            runId: firstEvent.runId,
            afterSequence: 0,
            onEvent: (event) => events.push(event),
            onDisconnect: (payload) => {
                disconnects.push(payload);
                clearTimeout(timeout);
                setTimeout(resolve, 30);
            },
        });
    });

    assert.deepEqual(events, [firstEvent]);
    assert.equal(disconnects.length, 1, 'one socket failure must emit one disconnect notification');
    assert.equal(requests[0], '/events/run%2Fsocket%20test?afterSequence=0');

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('terminal replay timed out')), 2000);
        client.subscribeAgentRunEventsHttp({
            port: address.port,
            token: 'secret',
            runId: firstEvent.runId,
            afterSequence: 1,
            onEvent: (event) => {
                events.push(event);
                if (event.type === 'run_completed') {
                    clearTimeout(timeout);
                    setTimeout(resolve, 30);
                }
            },
            onDisconnect: (payload) => disconnects.push(payload),
        });
    });

    assert.deepEqual(events, [firstEvent, terminalEvent]);
    assert.equal(disconnects.length, 1, 'terminal close must not be reported as a disconnect');
    assert.equal(requests[1], '/events/run%2Fsocket%20test?afterSequence=1');
    console.log('Agent SSE HTTP client disconnect/reconnect tests passed.');
} finally {
    await new Promise((resolve) => server.close(resolve));
}
