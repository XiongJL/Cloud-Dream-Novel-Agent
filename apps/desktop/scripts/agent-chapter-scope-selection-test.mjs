import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentChapterScopeSelection.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const initial = module.createDefaultChapterScope('chapter-2', 'volume-1');
assert.equal(module.chapterScopeChapterTitle('', 3, 0), '第 3 章（未命名）');
assert.equal(module.chapterScopeChapterTitle('  白色房间  ', 2, 1), '白色房间');
assert.equal(module.chapterScopeChapterTitle('   ', undefined, 4), '第 5 章（未命名）');
assert.equal(module.chapterScopeVolumeTitle('', 1), '第 2 卷（未命名）');
assert.equal(module.chapterScopeVolumeTitle('  征程  ', 0), '征程');
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

const novelScope = module.normalizeChapterScopeSelection({
    ...initial,
    kind: 'novel',
    chapterIds: [],
    anchorChapterId: 'chapter-2',
}, ['chapter-1', 'chapter-2', 'chapter-3'], 'chapter-2', 'volume-1');
assert.equal(novelScope.anchorChapterId, undefined);
assert.equal(novelScope.volumeId, undefined);
assert.equal('anchorChapterId' in module.chapterScopePayload(novelScope), false);

const recovered = module.chapterScopeSelectionFromPlan({
    steps: [{
        toolchain: {
            id: 'chapter.batch_rewrite',
            input: {
                kind: 'selected_chapters',
                volumeId: 'volume-1',
                chapterIds: ['chapter-1', 'chapter-2'],
                chapterCount: 2,
                anchorChapterId: 'chapter-2',
                processingMode: 'detailed',
                experts: ['reader'],
            },
        },
    }],
});
assert.equal(recovered.kind, 'selected_chapters');
assert.deepEqual(recovered.chapterIds, ['chapter-1', 'chapter-2']);
assert.equal(recovered.anchorChapterId, 'chapter-2');
assert.deepEqual(recovered.experts, ['reader']);

const inconsistent = module.chapterScopeSelectionFromPlan({
    steps: [{
        toolchain: {
            id: 'chapter.batch_rewrite',
            input: {
                kind: 'current_chapter',
                chapterIds: ['chapter-2'],
                chapterCount: 2,
            },
        },
    }],
});
assert.equal(inconsistent, null);

console.log('Agent chapter scope selection tests passed.');
