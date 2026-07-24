import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../electron/ai/providers/responsesStream.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { consumeResponsesStream } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

function streamResponse(chunks) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
}

function eventData(value, newline = '\n') {
    return `data: ${JSON.stringify(value)}${newline}${newline}`;
}

const response = streamResponse([
    'event: response.created\r\ndata: {"type":"response.created","response":{"id":"resp_1"}}\r\n\r\n',
    eventData({ type: 'response.output_text.delta', delta: '{"summary":"' }),
    eventData({ type: 'response.output_text.delta', delta: '完成"}' }),
    eventData({
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', model: 'gpt-test', output: [] },
    }),
    'data: [DONE]\n\n',
]);
const result = await consumeResponsesStream(response);
assert.equal(result.text, '{"summary":"完成"}');
assert.equal(result.model, 'gpt-test');
assert.equal(result.responseId, 'resp_1');
assert.equal(result.eventCount, 4);

const completedOnly = await consumeResponsesStream(streamResponse([
    eventData({
        type: 'response.completed',
        response: {
            id: 'resp_2',
            status: 'completed',
            model: 'gpt-test',
            output: [{ content: [{ text: 'fallback text' }] }],
        },
    }),
]));
assert.equal(completedOnly.text, 'fallback text');

await assert.rejects(
    consumeResponsesStream(streamResponse([
        eventData({ type: 'response.failed', response: { error: { message: 'upstream failed' } } }),
    ])),
    /upstream failed/u,
);

console.log('HTTP Responses stream parser tests passed.');
