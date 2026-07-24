import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/narrativeState.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
const { normalizeNarrativeStateDelta, filterNarrativeStateDeltaEvidence } = await import(moduleUrl);

const generatedText = '顾野抵达旧站，把铜钥匙交给林薇。他终于得知信号来自地下。';
const normalized = normalizeNarrativeStateDelta({
    characterLocations: [
        { characterKey: '顾野', location: '旧站', evidenceExcerpt: '顾野抵达旧站' },
        { characterKey: '林薇', location: '地下室', evidenceExcerpt: '不存在的原文' },
    ],
    relationshipChanges: [{
        sourceCharacterKey: '顾野',
        targetCharacterKey: '林薇',
        change: '交付关键物品，信任增强',
        evidenceExcerpt: '把铜钥匙交给林薇',
    }],
    knowledgeChanges: [{
        characterKey: '顾野',
        learned: ['信号来自地下'],
        forgotten: [],
        evidenceExcerpt: '他终于得知信号来自地下',
    }],
    itemStates: [{
        itemKey: '铜钥匙',
        state: '由林薇持有',
        holderKey: '林薇',
        evidenceExcerpt: '把铜钥匙交给林薇',
    }],
    resolvedConflicts: [],
    openedConflicts: [{ conflict: '地下信号来源不明', evidenceExcerpt: '信号来自地下' }],
    warnings: ['仅记录有原文证据的变化'],
});
const filtered = filterNarrativeStateDeltaEvidence(normalized, generatedText);

assert.equal(filtered.characterLocations.length, 1);
assert.equal(filtered.characterLocations[0].location, '旧站');
assert.equal(filtered.relationshipChanges.length, 1);
assert.deepEqual(filtered.knowledgeChanges[0].learned, ['信号来自地下']);
assert.equal(filtered.itemStates[0].holderKey, '林薇');
assert.equal(filtered.openedConflicts.length, 1);
assert.deepEqual(filtered.warnings, ['仅记录有原文证据的变化']);
console.log('Narrative state normalization and evidence-boundary tests passed.');
