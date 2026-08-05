import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/utils/aiError.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

assert.equal(
    module.formatAiErrorFromUnknown(
        new Error("Error invoking remote method 'agent:invoke': Error: 章节目录暂不可用，请重试。"),
    ),
    '章节目录暂不可用，请重试。',
);

assert.equal(
    module.formatAiErrorFromUnknown(
        new Error("Error invoking remote method 'agent:invoke': Error: 妯″瀷闇€瑕佹緞娓咃紝浣嗘病鏈夎繑鍥炴湁鏁堢殑缁撴瀯鍖栭棶棰樸€傝閲嶈瘯銆?"),
        undefined,
        '请求处理失败，请重试。',
    ),
    '请求处理失败，请重试。',
);

console.log('UI error normalization tests passed.');
