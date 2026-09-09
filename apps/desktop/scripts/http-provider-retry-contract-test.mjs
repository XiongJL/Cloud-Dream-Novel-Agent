import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const errorSource = await readFile(new URL('../electron/ai/errors.ts', import.meta.url), 'utf8');
const errorOutput = ts.transpileModule(errorSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const errors = await import(`data:text/javascript;base64,${Buffer.from(errorOutput).toString('base64')}`);

const rateLimited = new errors.AiActionError(
    'PROVIDER_RATE_LIMITED',
    '模型服务请求较多。',
    undefined,
    { httpStatus: 429, retryable: true },
);
assert.equal(rateLimited.code, 'PROVIDER_RATE_LIMITED');
assert.deepEqual(rateLimited.details, { httpStatus: 429, retryable: true });
assert.equal(errors.formatAiErrorForDisplay(rateLimited.code), '模型服务请求较多，请稍后重试。');

const providerSource = await readFile(new URL('../electron/ai/providers/HttpProvider.ts', import.meta.url), 'utf8');
const automationSource = await readFile(new URL('../electron/automation/AutomationService.ts', import.meta.url), 'utf8');
assert.match(providerSource, /return net\.fetch\(url, init as any\);/u);
assert.doesNotMatch(providerSource, /return await fetch\(url, init\)/u);
assert.match(providerSource, /status === 408/u);
assert.match(providerSource, /status === 425 \|\| status === 429/u);
assert.match(providerSource, /status >= 500/u);
assert.match(providerSource, /firstByteTimeoutMs/u);
assert.match(providerSource, /streamIdleTimeoutMs/u);
assert.match(providerSource, /req\.onActivity\?\.\(receivedFirstByte \? 'chunk' : 'first_byte'\)/u);
assert.match(providerSource, /timeoutKind: timeoutKind \?\? 'operation'/u);
assert.match(providerSource, /'MODEL_OUTPUT_TRUNCATED'/u);
assert.match(providerSource, /finishReason === 'length'/u);
assert.match(providerSource, /safeToRetryBeforePublish: true/u);
assert.match(providerSource, /partialText: input\.partialText/u);
assert.match(providerSource, /responseStatus === 'incomplete'/u);
assert.match(providerSource, /responseStatus === 'failed'/u);
assert.match(providerSource, /Model service returned an invalid JSON response/u);
assert.doesNotMatch(providerSource, /json\?\.status === 'incomplete'\) \{\s*throw outputTruncatedError/u);
// Exercise the provider boundary: an EOF without semantic completion is a
// transport interruption, while a provider-declared length limit is truncation.
const streamSource = await readFile(new URL('../electron/ai/providers/responsesStream.ts', import.meta.url), 'utf8');
const streamOutput = ts.transpileModule(streamSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const providerOutput = ts.transpileModule(providerSource.replace(/^import .*;\r?\n/gm, ''), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const harness = await import(moduleUrl(`
import { AiActionError } from '${moduleUrl(errorOutput)}';
import { consumeResponsesStream, extractResponsesOutput, ResponsesStreamError } from '${moduleUrl(streamOutput)}';
let response;
export function setResponse(value) { response = value; }
const net = { fetch: async () => response };
const devLog = () => {};
const devLogError = () => {};
const redactForLog = (value) => value;
${providerOutput}
`));
const provider = new harness.HttpProvider({ http: {
    baseUrl: 'https://test.invalid', apiMode: 'responses', model: 'test',
    apiKey: 'test-only', maxTokens: 16384, temperature: 0.5, timeoutMs: 1000,
} });
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const events = (values) => new Response(values.map(event).join(''), {
    headers: { 'content-type': 'text/event-stream' },
});
const delta = { type: 'response.output_text.delta', delta: 'unfinished' };
harness.setResponse(events([delta]));
await assert.rejects(provider.generate({ prompt: 'test' }), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.details.terminationReason, 'missing_completion_event');
    assert.equal(error.details.partialText, 'unfinished');
    assert.equal(error.details.safeToRetryBeforePublish, undefined);
    return true;
});
harness.setResponse(events([delta, {
    type: 'response.incomplete',
    response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
}]));
await assert.rejects(provider.generate({ prompt: 'test' }), (error) => {
    assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED');
    return true;
});
harness.setResponse(events([delta, {
    type: 'response.completed', response: { status: 'completed' },
}]));
assert.equal((await provider.generate({ prompt: 'test' })).text, 'unfinished');
assert.equal(
    errors.formatAiErrorForDisplay('MODEL_OUTPUT_TRUNCATED'),
    '生成达到本次输出额度，尚未形成完整草稿。',
);
assert.match(automationSource, /chapter\.draft\.incomplete_text/u);
assert.match(automationSource, /incomplete: true/u);

console.log('HTTP Provider retry contract tests passed.');
