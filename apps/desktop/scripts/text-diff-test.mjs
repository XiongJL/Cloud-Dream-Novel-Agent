import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diffArrays } from 'diff';
import ts from 'typescript';

const source = await readFile(new URL('../shared/textDiff.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(
    "import { diffArrays } from 'diff';",
    'const { diffArrays } = globalThis.__textDiffDeps;',
);
globalThis.__textDiffDeps = { diffArrays };
const { computeTextDiff, computeCoarseTextDiff, splitLogicalParagraphs } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

function reconstruct(projection, side) {
    const lineKey = side === 'old' ? 'oldLine' : 'newLine';
    const textKey = side === 'old' ? 'oldText' : 'newText';
    return projection.rows
        .filter((row) => row[lineKey] !== null)
        .map((row) => row[textKey] ?? '')
        .join('\n');
}

function logical(value) {
    return splitLogicalParagraphs(value).join('\n');
}

function verifyProjection(original, draft, projection) {
    assert.equal(reconstruct(projection, 'old'), logical(original));
    assert.equal(reconstruct(projection, 'new'), logical(draft));
    assert.deepEqual(
        projection.rows.filter((row) => row.oldLine !== null).map((row) => row.oldLine),
        Array.from({ length: splitLogicalParagraphs(original).length }, (_, index) => index + 1),
    );
    assert.deepEqual(
        projection.rows.filter((row) => row.newLine !== null).map((row) => row.newLine),
        Array.from({ length: splitLogicalParagraphs(draft).length }, (_, index) => index + 1),
    );
    for (const row of projection.rows) {
        if (row.oldSpans) assert.equal(row.oldSpans.map((span) => span.value).join(''), row.oldText);
        if (row.newSpans) assert.equal(row.newSpans.map((span) => span.value).join(''), row.newText);
    }
    for (const hunk of projection.hunks) {
        assert.ok(hunk.id.startsWith('diff-v2:'));
        assert.equal(hunk.oldCount, hunk.rows.filter((row) => row.oldLine !== null).length);
        assert.equal(hunk.newCount, hunk.rows.filter((row) => row.newLine !== null).length);
        assert.ok(hunk.rows.every((row) => row.hunkId === hunk.id));
    }
}

const original = '他走进雨里。\n天很冷。';
const draft = '她快步走进雨里。\n天很暖。';
const chinese = computeTextDiff(original, draft);
verifyProjection(original, draft, chinese);
assert.equal(chinese.hunks.length, 1);
assert.ok(chinese.rows.every((row) => row.kind === 'modify'));
assert.ok(chinese.addedCount > 0 && chinese.removedCount > 0);

const inlineOriginal = '雨已经下了四个小时。';
const inlineDraft = '雨已经下了整整四个小时。';
const inline = computeTextDiff(inlineOriginal, inlineDraft);
verifyProjection(inlineOriginal, inlineDraft, inline);
assert.equal(inline.rows[0].kind, 'modify');
assert.ok(inline.rows[0].newSpans.some((span) => span.kind === 'added' && span.value.includes('整整')));

const unchanged = computeTextDiff('完全相同', '完全相同');
verifyProjection('完全相同', '完全相同', unchanged);
assert.equal(unchanged.hunks.length, 0);
assert.equal(unchanged.rows[0].kind, 'context');

const middleInsertion = computeTextDiff('甲。\n乙。', '甲。\n新增。\n乙。');
verifyProjection('甲。\n乙。', '甲。\n新增。\n乙。', middleInsertion);
assert.equal(middleInsertion.hunks[0].oldStart, 2);
assert.equal(middleInsertion.hunks[0].oldCount, 0);
assert.equal(middleInsertion.hunks[0].newStart, 2);

for (const [before, after] of [
    ['', '新增一段'],
    ['删除一段', ''],
    ['甲。\n乙。', '甲。\n新增。\n乙。'],
    ['甲。\r\n\r\n乙。', '甲。\n乙。'],
    ['第一章 雨夜来电\n正文甲\n正文乙', '正文甲\n第一章 雨夜来电\n正文乙'],
    ['甲。乙。', '甲。\n乙。'],
    ['你好，世界！', '你好,世界!'],
]) {
    verifyProjection(before, after, computeTextDiff(before, after));
}

const unrelated = computeTextDiff('月光落在安静的旧书桌上。', '发动机喷出炽热火焰冲向太空。');
verifyProjection('月光落在安静的旧书桌上。', '发动机喷出炽热火焰冲向太空。', unrelated);
assert.ok(!unrelated.rows.some((row) => row.kind === 'modify'), 'unrelated paragraphs must remain delete + insert');

const emojiOriginal = '他看见👨‍👩‍👧‍👦站在门口。\ne\u0301落在纸上。';
const emojiDraft = '他看见👨‍👩‍👧站在门口。\né落在纸上。';
const emoji = computeTextDiff(emojiOriginal, emojiDraft);
verifyProjection(emojiOriginal, emojiDraft, emoji);
const emojiRemoved = emoji.rows.flatMap((row) => row.oldSpans ?? []).filter((span) => span.kind === 'removed').map((span) => span.value);
assert.ok(emojiRemoved.some((value) => value.includes('👨‍👩‍👧‍👦')));

const rewrittenOriginal = [
    '一个女孩站在礁石边回头看着他。',
    '他知道那是自己的记忆，知道少年自己十几岁。',
    '可他突然想不起她的名字。',
].join('\n');
const rewrittenDraft = [
    '第一章 雨夜来电',
    '一个女孩站在礁石边回头看着他。',
    '他知道那是自己的记忆，也知道少年自己只有十几岁。',
    '可他无论如何都想不起她的名字。',
].join('\n\n');
const rewritten = computeTextDiff(rewrittenOriginal, rewrittenDraft);
verifyProjection(rewrittenOriginal, rewrittenDraft, rewritten);
assert.ok(rewritten.rows.some((row) => row.kind === 'insert' && row.newText === '第一章 雨夜来电'));
assert.ok(rewritten.rows.some((row) => row.kind === 'modify'));

const stableOriginal = '开场。\n雨已经下了四个小时。\n结尾。';
const stableA = computeTextDiff(stableOriginal, '开场。\n雨已经下了五个小时。\n结尾。');
const stableB = computeTextDiff(stableOriginal, '新增题记。\n开场。\n雨已经下了整整六个小时。\n结尾。');
const changedA = stableA.hunks.find((hunk) => hunk.oldCount > 0);
const changedB = stableB.hunks.find((hunk) => hunk.oldStart === changedA.oldStart && hunk.oldCount > 0);
assert.equal(changedA.id, changedB.id, 'draft insertions and edits must not invalidate the original-backed hunk id');

const longParagraph = '长句，'.repeat(20_000);
const limited = computeTextDiff(longParagraph, `${longParagraph}结尾`, { maxCharacters: 1_000 });
verifyProjection(longParagraph, `${longParagraph}结尾`, limited);
assert.equal(limited.degraded, true);
assert.equal(limited.fallbackReason, 'input_limit');

const budgeted = computeTextDiff('雨已经下了四个小时。', '雨已经下了整整四个小时。', { maxRefinementTimeMs: -1 });
verifyProjection('雨已经下了四个小时。', '雨已经下了整整四个小时。', budgeted);
assert.equal(budgeted.degraded, true);
assert.equal(budgeted.fallbackReason, 'refinement_budget');

const coarse = computeCoarseTextDiff('共同开头\n旧正文\n共同结尾', '共同开头\n新正文\n共同结尾', 'worker_timeout');
verifyProjection('共同开头\n旧正文\n共同结尾', '共同开头\n新正文\n共同结尾', coarse);
assert.equal(coarse.degraded, true);
assert.equal(coarse.rows[0].kind, 'context');
assert.equal(coarse.rows.at(-1).kind, 'context');

console.log('Paragraph-first Chinese text diff tests passed.');
