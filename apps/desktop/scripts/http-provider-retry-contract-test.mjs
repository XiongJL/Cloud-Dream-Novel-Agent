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
assert.match(providerSource, /return net\.fetch\(url, init as any\);/u);
assert.doesNotMatch(providerSource, /return await fetch\(url, init\)/u);
assert.match(providerSource, /status === 408/u);
assert.match(providerSource, /status === 425 \|\| status === 429/u);
assert.match(providerSource, /status >= 500/u);

console.log('HTTP Provider retry contract tests passed.');
