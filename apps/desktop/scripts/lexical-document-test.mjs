import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/lexicalDocument.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
    appendPlainTextToLexical,
    createLexicalDocumentFromPlainText,
    ensureLexicalDocument,
    extractReadableText,
} = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const lexical = JSON.stringify({
    root: {
        children: [
            { type: 'paragraph', children: [{ type: 'text', text: '第一段。' }] },
            { type: 'paragraph', children: [{ type: 'text', text: '第二段。' }] },
        ],
        type: 'root',
        version: 1,
    },
});

assert.equal(extractReadableText(lexical), '第一段。\n第二段。');
assert.equal(extractReadableText(`${lexical}旧的尾部正文。`), '第一段。\n第二段。\n\n旧的尾部正文。');

const appended = appendPlainTextToLexical(`${lexical}旧的尾部正文。`, '新增第一段。\n\n新增第二段。');
const parsed = JSON.parse(appended);
assert.equal(parsed.root.children.length, 5);
assert.equal(extractReadableText(appended), '第一段。\n第二段。\n旧的尾部正文。\n新增第一段。\n新增第二段。');

assert.equal(appendPlainTextToLexical('纯文本原文。', '新增正文。'), '纯文本原文。\n\n新增正文。');

const created = createLexicalDocumentFromPlainText('新章第一段。\n\n新章第二段。');
assert.equal(extractReadableText(created), '新章第一段。\n新章第二段。');
assert.equal(extractReadableText(ensureLexicalDocument('待规范化纯文本。')), '待规范化纯文本。');
assert.equal(ensureLexicalDocument(created), created);

console.log('Lexical document parsing and append tests passed.');
