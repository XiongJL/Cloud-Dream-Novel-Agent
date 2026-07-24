import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diffChars } from 'diff';
import ts from 'typescript';

const source = await readFile(new URL('../shared/textDiff.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(
    "import { diffChars } from 'diff';",
    'const { diffChars } = globalThis.__textDiffDeps;',
);
globalThis.__textDiffDeps = { diffChars };
const { projectTextDiff } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

function reconstruct(projection, side) {
    return projection.segments
        .filter((segment) => segment.kind === 'unchanged' || segment.kind === side)
        .map((segment) => segment.value)
        .join('');
}

const original = '他走进雨里。\n天很冷。';
const draft = '她快步走进雨里。\n天很暖。';
const chinese = projectTextDiff(original, draft);
assert.ok(chinese.addedCount > 0);
assert.ok(chinese.removedCount > 0);
assert.ok(chinese.changedBlockCount >= 2);
assert.equal(reconstruct(chinese, 'removed'), original);
assert.equal(reconstruct(chinese, 'added'), draft);

const unchanged = projectTextDiff('完全相同', '完全相同');
assert.equal(unchanged.changedBlockCount, 0);
assert.equal(unchanged.addedCount, 0);
assert.equal(unchanged.removedCount, 0);

const inserted = projectTextDiff('', '新增一段');
assert.equal(inserted.addedCount, 4);
assert.equal(inserted.removedCount, 0);

const removed = projectTextDiff('删除一段', '');
assert.equal(removed.addedCount, 0);
assert.equal(removed.removedCount, 4);

const longPrefix = `${'未改正文。'.repeat(400)}\n`;
const longDiff = projectTextDiff(`${longPrefix}旧结尾`, `${longPrefix}新结尾`);
assert.equal(reconstruct(longDiff, 'removed'), `${longPrefix}旧结尾`);
assert.equal(reconstruct(longDiff, 'added'), `${longPrefix}新结尾`);
assert.equal(longDiff.changedBlockCount, 1);

console.log('Text diff projection tests passed.');
