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
let activityCount = 0;
const result = await consumeResponsesStream(response, {
    onActivity: () => { activityCount += 1; },
});
assert.equal(result.text, '{"summary":"完成"}');
assert.equal(result.model, 'gpt-test');
assert.equal(result.responseId, 'resp_1');
assert.equal(result.eventCount, 4);
assert.equal(activityCount, 5);

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

for (const chunks of [
    [],
    [eventData({ type: 'response.output_text.delta', delta: 'partial chapter' })],
    [eventData({ type: 'response.output_text.done', text: 'partial chapter' }), 'data: [DONE]\n\n'],
    [eventData({ type: 'response.created', response: { id: 'resp_early', status: 'in_progress' } })],
]) {
    await assert.rejects(consumeResponsesStream(streamResponse(chunks)), (error) => {
        assert.equal(error.kind, 'stream_incomplete');
        assert.equal(error.terminationReason, 'missing_completion_event');
        return true;
    });
}
await assert.rejects(consumeResponsesStream(streamResponse([
    eventData({ type: 'response.in_progress', response: { id: 'resp_early', model: 'test', status: 'in_progress' } }),
    eventData({ type: 'response.output_text.delta', delta: 'unfinished' }),
])), (error) => {
    assert.equal(error.kind, 'stream_incomplete');
    assert.equal(error.partialText, 'unfinished');
    assert.equal(error.responseId, 'resp_early');
    assert.equal(error.model, 'test');
    assert.equal(error.usage, undefined);
    return true;
});

// A transport read failure must remain a failure, even after visible text arrived.
let readCount = 0;
const readFailure = new Error('socket disconnected');
await assert.rejects(consumeResponsesStream(new Response(new ReadableStream({
    pull(controller) {
        if (readCount++ === 0) {
            controller.enqueue(new TextEncoder().encode(eventData({ type: 'response.output_text.delta', delta: 'partial' })));
        } else {
            controller.error(readFailure);
        }
    },
}))), (error) => error === readFailure);

let truncatedError;
try {
    await consumeResponsesStream(streamResponse([
        eventData({ type: 'response.output_text.delta', delta: '{"chapter":"partial' }),
        eventData({
            type: 'response.incomplete',
            response: {
                id: 'resp_truncated',
                status: 'incomplete',
                model: 'deepseek-test',
                incomplete_details: { reason: 'max_output_tokens' },
                usage: { input_tokens: 120, output_tokens: 4096, output_tokens_details: { reasoning_tokens: 800 } },
            },
        }),
    ]));
} catch (error) {
    truncatedError = error;
}
assert.equal(truncatedError?.name, 'ResponsesStreamError');
assert.equal(truncatedError?.kind, 'output_truncated');
assert.equal(truncatedError?.terminationReason, 'max_output_tokens');
assert.equal(truncatedError?.responseId, 'resp_truncated');
assert.equal(truncatedError?.partialText, '{"chapter":"partial');
assert.deepEqual(truncatedError?.usage, {
    input_tokens: 120,
    output_tokens: 4096,
    output_tokens_details: { reasoning_tokens: 800 },
});

let invalidEventError;
try {
    await consumeResponsesStream(streamResponse([
        eventData({ type: 'response.output_text.delta', delta: 'partial' }),
        'data: {not-json}\n\n',
    ]));
} catch (error) {
    invalidEventError = error;
}
assert.equal(invalidEventError?.kind, 'invalid_event');
assert.equal(invalidEventError?.partialText, 'partial');

await assert.rejects(
    consumeResponsesStream(streamResponse([
        eventData({ type: 'response.failed', response: { error: { message: 'upstream failed' } } }),
    ])),
    /upstream failed/u,
);

console.log('HTTP Responses stream parser tests passed.');
