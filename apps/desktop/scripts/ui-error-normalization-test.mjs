import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const storageSource = await readFile(new URL('../shared/systemErrors.ts', import.meta.url), 'utf8');
const storageOutput = ts.transpileModule(storageSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const storageUrl = `data:text/javascript;base64,${Buffer.from(storageOutput).toString('base64')}`;
const source = (await readFile(new URL('../src/utils/aiError.ts', import.meta.url), 'utf8'))
    .replace('../../shared/systemErrors', storageUrl);
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

const fullError = new Error('Invalid prisma.agentConversation.upsert() invocation: database or disk is full');
assert.equal(module.inferAiErrorCode(fullError), 'PERSISTENCE_ERROR');
assert.match(module.formatAiErrorFromUnknown(fullError), /磁盘空间不足/);
assert.match(module.formatAiErrorFromUnknown({ code: 'STORAGE_DISK_FULL', message: 'full' }), /不要直接重复启动/);
assert.match(module.formatAiErrorFromUnknown(new Error('database is locked')), /数据库读写繁忙/);
assert.match(module.formatAiErrorFromUnknown(new Error('database is locked')), /恢复入口/);
assert.match(module.formatAiErrorFromUnknown(new Error('readonly database')), /目录权限/);
assert.match(module.formatAiErrorFromUnknown(new Error('database disk image is malformed')), /恢复备份/);
console.log('UI error normalization tests passed.');
