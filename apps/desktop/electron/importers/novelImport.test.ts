import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildLexicalContentFromPlainText,
  readNovelFileAsStructure,
  splitNovelTextIntoStructure,
} from './novelImport.ts';

test('splitNovelTextIntoStructure falls back to a single chapter when no headings exist', () => {
  const text = '这是第一段。\n\n这是第二段。';
  const result = splitNovelTextIntoStructure(text, '示例小说');

  assert.equal(result.title, '示例小说');
  assert.equal(result.volumes.length, 1);
  assert.equal(result.volumes[0].title, '正文');
  assert.equal(result.volumes[0].chapters.length, 1);
  assert.equal(result.volumes[0].chapters[0].title, '开始');
  assert.match(result.volumes[0].chapters[0].plainText, /这是第一段/);
});

test('splitNovelTextIntoStructure splits common Chinese chapter headings', () => {
  const text = [
    '第1章 初见',
    '他站在雨里。',
    '',
    '第二章 再会',
    '她没有回头。',
  ].join('\n');

  const result = splitNovelTextIntoStructure(text, '章节小说');

  assert.equal(result.volumes.length, 1);
  assert.equal(result.volumes[0].chapters.length, 2);
  assert.equal(result.volumes[0].chapters[0].title, '第1章 初见');
  assert.match(result.volumes[0].chapters[0].plainText, /他站在雨里/);
  assert.equal(result.volumes[0].chapters[1].title, '第二章 再会');
  assert.match(result.volumes[0].chapters[1].plainText, /她没有回头/);
});

test('splitNovelTextIntoStructure groups chapters under detected volume headings', () => {
  const text = [
    '第一卷 山中客',
    '第1章 入山',
    '山路很长。',
    '第2章 夜雨',
    '雨下了一夜。',
    '第二卷 江上月',
    '第3章 登船',
    '江风扑面。',
  ].join('\n');

  const result = splitNovelTextIntoStructure(text, '分卷小说');

  assert.equal(result.volumes.length, 2);
  assert.equal(result.volumes[0].title, '第一卷 山中客');
  assert.equal(result.volumes[0].chapters.length, 2);
  assert.equal(result.volumes[1].title, '第二卷 江上月');
  assert.equal(result.volumes[1].chapters.length, 1);
  assert.equal(result.volumes[1].chapters[0].title, '第3章 登船');
});

test('buildLexicalContentFromPlainText preserves paragraphs as lexical JSON', () => {
  const lexical = buildLexicalContentFromPlainText('第一段。\n\n第二段。');
  const parsed = JSON.parse(lexical);

  assert.equal(parsed.root.type, 'root');
  assert.equal(parsed.root.children.length, 2);
  assert.equal(parsed.root.children[0].type, 'paragraph');
  assert.equal(parsed.root.children[0].children[0].text, '第一段。');
  assert.equal(parsed.root.children[1].children[0].text, '第二段。');
});

test('readNovelFileAsStructure imports txt and uses filename as fallback title', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-import-'));
  const filePath = path.join(tempDir, '我的小说.txt');
  await fs.writeFile(filePath, '第1章 开始\n风起了。', 'utf8');

  const result = await readNovelFileAsStructure(filePath);

  assert.equal(result.title, '我的小说');
  assert.equal(result.volumes[0].chapters.length, 1);
  assert.equal(result.volumes[0].chapters[0].title, '第1章 开始');
  assert.match(result.volumes[0].chapters[0].plainText, /风起了/);
});

test('readNovelFileAsStructure decodes gbk txt content before chapter splitting', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-import-'));
  const filePath = path.join(tempDir, '繁体旧稿.txt');
  const gbkHex = 'b5da31d5c220bfaacabc0ab7e7b4b5b9fdc9bdb8daa1a30ab5dab6fed5c220d2b9c9ab0ad2b9c0efd6bbd3d0b3e6c3f9a1a3';
  await fs.writeFile(filePath, Buffer.from(gbkHex, 'hex'));

  const result = await readNovelFileAsStructure(filePath);

  assert.equal(result.volumes[0].chapters.length, 2);
  assert.equal(result.volumes[0].chapters[0].title, '第1章 开始');
  assert.match(result.volumes[0].chapters[0].plainText, /风吹过山岗/);
});

test('readNovelFileAsStructure rejects legacy doc files with a helpful error', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-import-'));
  const filePath = path.join(tempDir, '旧稿.doc');
  await fs.writeFile(filePath, 'binary-ish');

  await assert.rejects(
    readNovelFileAsStructure(filePath),
    /暂不支持旧版 \.doc/
  );
});
