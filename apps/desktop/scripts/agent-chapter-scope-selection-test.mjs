import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentChapterScopeSelection.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const initial = module.createDefaultChapterScope('chapter-2', 'volume-1');
assert.equal(module.chapterScopeLabel(initial), '当前章');
assert.deepEqual(initial.experts, ['editor', 'reader', 'worldbuilding']);
assert.equal(module.isChapterScopeSelectionValid(initial), true);
assert.equal(module.isChapterScopeSelectionValid({ ...initial, kind: 'chapter_range', chapterIds: ['chapter-1'] }), false);

const normalized = module.normalizeChapterScopeSelection({
    ...initial,
    kind: 'selected_chapters',
    chapterIds: ['chapter-3', 'missing', 'chapter-1', 'chapter-3'],
    anchorChapterId: 'missing',
    experts: [],
}, ['chapter-1', 'chapter-2', 'chapter-3'], 'chapter-2', 'volume-1');
assert.deepEqual(normalized.chapterIds, ['chapter-3', 'chapter-1']);
assert.equal(normalized.anchorChapterId, 'chapter-1');
assert.equal(module.chapterScopeLabel(normalized), '已选 2 章');
assert.deepEqual(normalized.experts, ['editor', 'reader', 'worldbuilding']);

const payload = module.chapterScopePayload(normalized);
assert.equal(payload.kind, 'selected_chapters');
assert.deepEqual(payload.chapterIds, ['chapter-3', 'chapter-1']);
assert.equal(payload.anchorChapterId, 'chapter-1');

console.log('Agent chapter scope selection tests passed.');
