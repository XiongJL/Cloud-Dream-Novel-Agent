import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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
const { computeTextDiff, splitLogicalParagraphs } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

function fixture(paragraphCount) {
    const original = Array.from({ length: paragraphCount }, (_, index) => (
        `第${index + 1}段，旧版本中的人物走进雨夜，抬头看见远处灯光，随后继续向前。`
    )).join('\n');
    const draft = Array.from({ length: paragraphCount }, (_, index) => (
        `第${index + 1}段，新版本中的人物走进雪夜，回头看见远处月光，随后继续向前。`
    )).join('\n\n');
    return { original, draft };
}

function reconstruct(projection, side) {
    const lineKey = side === 'old' ? 'oldLine' : 'newLine';
    const textKey = side === 'old' ? 'oldText' : 'newText';
    return projection.rows.filter((row) => row[lineKey] !== null).map((row) => row[textKey] ?? '').join('\n');
}

computeTextDiff(...Object.values(fixture(20)));

for (const paragraphCount of [100, 400, 1000]) {
    const { original, draft } = fixture(paragraphCount);
    const samples = [];
    let projection;
    for (let iteration = 0; iteration < 3; iteration += 1) {
        const startedAt = performance.now();
        projection = computeTextDiff(original, draft, { maxRefinementTimeMs: 10_000 });
        samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    const durationMs = samples[1];
    assert.equal(reconstruct(projection, 'old'), splitLogicalParagraphs(original).join('\n'));
    assert.equal(reconstruct(projection, 'new'), splitLogicalParagraphs(draft).join('\n'));
    const deterministicComparisonLimit = (paragraphCount * ((8 * 2) + 1)) + 4_096;
    assert.ok(
        projection.stats.candidateComparisonCount <= deterministicComparisonLimit,
        `candidate comparisons ${projection.stats.candidateComparisonCount} exceeded ${deterministicComparisonLimit}`,
    );
    console.log(JSON.stringify({
        case: 'all-similar-paragraphs-modified',
        paragraphCount,
        characterCount: original.length + draft.length,
        durationMs: Number(durationMs.toFixed(2)),
        candidateComparisonCount: projection.stats.candidateComparisonCount,
        degraded: projection.degraded,
    }));
}

console.log('Text diff performance samples recorded (wall-clock time is informational only).');
