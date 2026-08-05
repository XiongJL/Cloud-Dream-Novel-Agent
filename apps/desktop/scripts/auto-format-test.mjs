import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    createEditor,
} from 'lexical';
import { formatEditorRoot } from '../src/components/LexicalEditor/editorAutoFormat.ts';

const source = await readFile(new URL('../src/components/LexicalEditor/autoFormat.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
    formatTextContent,
    isBlankParagraph,
    trimParagraphEnd,
    trimParagraphStart,
} = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

assert.equal(formatTextContent('雨夜,   很冷...', 'zh'), '雨夜，很冷……');
assert.equal(formatTextContent('门外 ?  谁', 'zh-CN'), '门外？谁');
assert.equal(trimParagraphStart('　　段首'), '段首');
assert.equal(trimParagraphEnd('段尾 　'), '段尾');
assert.equal(isBlankParagraph(' \t\n　'), true);
assert.equal(isBlankParagraph('正文'), false);

const firstStyledSegment = formatTextContent('  hello ', 'en', true);
const secondStyledSegment = formatTextContent('world  ', 'en', false);
assert.equal(trimParagraphStart(firstStyledSegment) + trimParagraphEnd(secondStyledSegment), 'Hello world');

const editor = createEditor({
    namespace: 'auto-format-test',
    onError: (error) => {
        throw error;
    },
});

editor.update(() => {
    const root = $getRoot();
    const firstParagraph = $createParagraphNode().append($createTextNode('　　雨夜,   很冷...  '));
    const blankParagraph = $createParagraphNode().append($createTextNode(' 　'));
    const styledParagraph = $createParagraphNode().append(
        $createTextNode('hello ').toggleFormat('bold'),
        $createTextNode('world  '),
    );
    root.append(firstParagraph, blankParagraph, styledParagraph);
    formatEditorRoot(root, 'zh');
}, { discrete: true });

editor.getEditorState().read(() => {
    const blocks = $getRoot().getChildren();
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].getTextContent(), '雨夜，很冷……');
    assert.equal(blocks[1].getTextContent(), 'Hello world');
    assert.equal(blocks[1].getAllTextNodes()[0].hasFormat('bold'), true);
});

console.log('Auto-format text normalization tests passed.');
