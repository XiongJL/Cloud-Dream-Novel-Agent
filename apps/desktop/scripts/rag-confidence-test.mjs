import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(resolve('electron/ai/rag/NovelRagService.ts'), 'utf8');
const start = source.indexOf('function parseConfidence(');
const end = source.indexOf('function extractCitations(', start);
assert.ok(start >= 0 && end > start, 'confidence parser exists');
const js = ts.transpileModule(`${source.slice(start, end)}\nglobalThis.parseConfidence = parseConfidence;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const context = {};
runInNewContext(js, context);
const parse = context.parseConfidence;

assert.equal(parse('## 置信度\n**高**——主判断可靠；其他事实证据不足。', 6), 'high');
assert.equal(parse('## 置信度\n**低**——资料不足以判断。', 6), 'low');
assert.equal(parse('Confidence: medium\nSome details are not enough to decide.', 4), 'medium');
assert.equal(parse('资料不足以判断。', 6), 'low');
console.log('RAG confidence parsing passed');
