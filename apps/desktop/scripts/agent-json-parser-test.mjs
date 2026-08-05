import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { jsonrepair } from 'jsonrepair';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentJson.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseFirstJsonObject, parseRepairableJsonObject } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const first = { content: '我先读取章节，再做审计。', shouldPlan: true, toolCalls: [{ name: 'volume.list', args: {} }] };
const second = { content: '重复对象不应进入界面', shouldPlan: false, toolCalls: [] };
assert.deepEqual(parseFirstJsonObject(`${JSON.stringify(first)}\n${JSON.stringify(second)}`), first);
assert.deepEqual(parseFirstJsonObject(`\`\`\`json\n${JSON.stringify(first)}\n\`\`\``), first);
assert.deepEqual(parseFirstJsonObject(`前缀 ${JSON.stringify({ content: '字符串里的 } 和 \\" 都不应截断' })} 后缀`), {
    content: '字符串里的 } 和 \\" 都不应截断',
});
assert.equal(parseFirstJsonObject('not json'), null);

const malformedControlCharacter = '{"content":"第一行\n第二行","conversationSummary":"摘要"}';
assert.equal(parseFirstJsonObject(malformedControlCharacter), null);
assert.deepEqual(parseRepairableJsonObject(malformedControlCharacter, jsonrepair), {
    value: { content: '第一行\n第二行', conversationSummary: '摘要' },
    repaired: true,
});
assert.deepEqual(parseRepairableJsonObject('{content:"报告", conversationSummary:"摘要",}', jsonrepair), {
    value: { content: '报告', conversationSummary: '摘要' },
    repaired: true,
});
assert.deepEqual(parseRepairableJsonObject(JSON.stringify(first), jsonrepair), {
    value: first,
    repaired: false,
});
assert.equal(parseRepairableJsonObject('not json', jsonrepair), null);

console.log('Agent JSON parser tests passed.');
