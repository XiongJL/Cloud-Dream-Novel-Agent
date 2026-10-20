import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@novel-editor/core';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-export-test-'));
const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(path.join(desktopRoot, 'node_modules/.cache'), { recursive: true });
const compile = await fs.mkdtemp(path.join(desktopRoot, 'node_modules/.cache/export-test-'));
const load = async (relative, name, plugins = []) => {
    const output = path.join(compile, `${name}.cjs`);
    await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: output, plugins });
    return require(output);
};
const { NovelExportService, exportFilename, prepareExportSnapshot } = await load('../electron/services/NovelExportService.ts', 'service');
const { ChapterSaveQueue } = await load('../shared/chapterSaveQueue.ts', 'queue');
const { planExportParts } = await load('../shared/novelExportScope.ts', 'scope');
const { extractChapterParagraphs, extractReadableText } = await load('../shared/lexicalDocument.ts', 'lexical');
const { DocumentExporterClient } = await load('../electron/agent/DocumentExporterClient.ts', 'client', [{
    name: 'electron-app-fixture',
    setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(desktopRoot)} };` }));
    },
}]);
const database = new PrismaClient({ datasources: { db: { url: `file:${path.join(root, 'fixture.db')}` } } });
const lexical = text => JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [
    { type: 'text', text }, { type: 'mention', mentionName: '故人', mentionId: 'private-id' }, { type: 'linebreak' },
    { type: 'plot-anchor', ids: ['private-anchor'], children: [{ type: 'text', text: '尾声' }] },
] }, { type: 'paragraph', children: [] }] } });
const client = new DocumentExporterClient();

try {
    assert.deepEqual(extractChapterParagraphs(lexical('　　雨夜😀  ')), ['　　雨夜😀  故人\n尾声', '']);
    assert.deepEqual(extractChapterParagraphs(lexical('首行\r\n次行\r末行')), ['首行\n次行\n末行故人\n尾声', '']);
    assert.equal(extractReadableText(lexical('雨夜')), '雨夜\n尾声'); // Existing callers retain their defaults.
    assert.deepEqual(extractChapterParagraphs('  {普通文字}\r\n\r\n　　末行  \r'), ['  {普通文字}', '', '　　末行  ', '']);
    assert.deepEqual(extractChapterParagraphs('{"root":{"value":1}}'), ['{"root":{"value":1}}']);
    assert.deepEqual(extractChapterParagraphs('{"root":{"type":"root","children":[]}}'), []);
    assert.throws(() => extractChapterParagraphs('{"root":{"children":['), /损坏/);
    assert.throws(() => extractChapterParagraphs('{"root":{"type":"root","children":[{"type":"image"}]}}'), /不支持/);
    assert.equal(exportFilename('CON.txt'), '_CON.txt');
    assert.equal(exportFilename('书名<>.  '), '书名__');
    const legacy = prepareExportSnapshot({ title: '书名', formatting: '{invalid', volumes: [{ id: 'v', order: 1, title: '', chapters: [] }] });
    assert.equal(legacy.volumes[0].title, '第 1 卷');
    const invalidTemplate = prepareExportSnapshot({ title: '书名', formatting: '{"volume":42}', volumes: [{ id: 'v', order: 1, title: '第 1 卷 已有编号', chapters: [] }] });
    assert.equal(invalidTemplate.volumes[0].title, '第 1 卷 已有编号');
    const scopeFixture = { title: 'book', volumes: [
        { id: 'a', chapters: [{ id: 'a1' }, { id: 'a2' }] }, { id: 'empty', chapters: [] },
        { id: 'b', chapters: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] },
    ] };
    assert.deepEqual(planExportParts(scopeFixture, { mode: 'range', start: 2, end: 4 })[0].source.volumes.map(v => [v.id, v.chapters.map(c => c.id)]), [['a', ['a2']], ['b', ['b1', 'b2']]]);
    assert.deepEqual(planExportParts(scopeFixture, { mode: 'split', chaptersPerFile: 2 }).map(p => [p.start, p.end]), [[1, 2], [3, 4], [5, 5]]);
    assert.equal(scopeFixture.volumes[0].chapters.length, 2);
    assert.throws(() => planExportParts(scopeFixture, { mode: 'range', start: 1, end: 6 }), /只有 5 章/);
    assert.throws(() => planExportParts(scopeFixture, { mode: 'split', chaptersPerFile: 0 }), /正整数/);
    assert.throws(() => planExportParts({ volumes: [] }, { mode: 'split', chaptersPerFile: 500 }), /没有章节/);
    const manyChapters = { volumes: [{ chapters: Array.from({ length: 521 }, (_, id) => ({ id })) }, { chapters: Array.from({ length: 480 }, (_, id) => ({ id: id + 521 })) }] };
    const manyParts = planExportParts(manyChapters, { mode: 'split', chaptersPerFile: 500 });
    assert.deepEqual(manyParts.map(part => [part.start, part.end]), [[1, 500], [501, 1000], [1001, 1001]]);
    assert.deepEqual(manyParts.flatMap(part => part.source.volumes.flatMap(volume => volume.chapters.map(chapter => chapter.id))), Array.from({ length: 1001 }, (_, id) => id));

    const queue = new ChapterSaveQueue();
    let available = false;
    await assert.rejects(queue.enqueue('A', async () => { if (!available) throw new Error('disk'); }), /disk/);
    await assert.rejects(queue.flush(), /disk/);
    available = true;
    await queue.flush();
    assert.equal(queue.has('A'), false);
    await assert.rejects(queue.enqueue('deleted-chapter', async () => { throw new Error('deleted'); }));
    queue.discard('deleted-chapter');
    await queue.flush();

    const schema = await fs.readFile(new URL('../../../packages/core/generated/client/schema-init.sql', import.meta.url), 'utf8');
    for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await database.$executeRawUnsafe(sql);
    await database.novel.create({ data: { id: 'n', title: '测试小说😀', description: '第一段简介\n\n第二段简介', formatting: JSON.stringify({ author: '行舟', volume: '卷{n:zh}', chapter: '章{n:00}' }) } });
    await database.novel.create({ data: { id: 'other', title: '其他作品' } });
    for (const [id, order, deleted] of [['v2', 2, false], ['v1', 1, false], ['vd', 3, true]]) {
        await database.volume.create({ data: { id, order, deleted, title: id, novelId: 'n' } });
    }
    for (const [id, order, volumeId, deleted] of [['c2', 2, 'v1', false], ['c1', 1, 'v1', false], ['c0', 0, 'v1', true], ['cd', 1, 'vd', false]]) {
        await database.chapter.create({ data: { id, order, volumeId, deleted, title: id, content: id === 'c1' ? '旧正文' : '' } });
    }
    let selected = path.join(root, 'book.txt');
    let freeze = false;
    let dataset = 'one';
    let afterSnapshot = async () => {};
    let generate = (...args) => client.generate(...args);
    const progress = [];
    const deps = {
        database, choosePath: async () => selected, chooseDirectory: async () => root, confirmOverwrite: async () => false,
        flush: () => queue.flush(), freeze: value => { freeze = value; },
        read: operation => operation(), datasetId: () => dataset,
        generate: async (...args) => { assert.equal(freeze, false); await afterSnapshot(); return generate(...args); },
    };
    const service = new NovelExportService(deps);
    const run = (id, format = 'txt', selection) => service.start({ requestId: id, novelId: 'n', format, selection }, e => progress.push(e));
    assert.deepEqual(await service.describe('n'), { chapterCount: 2 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const saving = queue.enqueue('c1', async () => { await gate; await database.chapter.update({ where: { id: 'c1' }, data: { content: lexical('最后一次修改😀') } }); });
    const pending = run('first');
    while (!freeze) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await run('duplicate')).code, 'BUSY');
    afterSnapshot = async () => { await database.chapter.update({ where: { id: 'c1' }, data: { content: '快照之后的新修改' } }); };
    release(); await saving;
    const success = await pending;
    assert.equal(success.status, 'success', JSON.stringify(success));
    assert.equal(success.chapters, 2); assert.equal(success.volumes, 2);
    const txt = await fs.readFile(selected, 'utf8');
    assert.ok(txt.includes('最后一次修改😀故人\r\n尾声'));
    assert.ok(!txt.includes('快照之后') && !txt.includes('其他作品') && !txt.includes('private-id'));
    assert.ok(txt.indexOf('卷一 v1') < txt.indexOf('卷二 v2'));
    assert.ok(txt.indexOf('章01 c1') < txt.indexOf('章02 c2'));
    assert.ok(!txt.includes('章00 c0') && !txt.includes('卷三 vd'));
    assert.equal(progress[0].phase, 'saving'); assert.equal(progress.at(-1).phase, 'writing');
    afterSnapshot = async () => {};
    selected = path.join(root, 'book.docx');
    assert.equal((await run('docx', 'docx')).status, 'success');

    const original = await fs.readFile(selected);
    generate = async directory => { await fs.writeFile(path.join(directory, 'output.docx'), 'partial'); throw new Error('worker failed'); };
    const failed = await run('failure', 'docx');
    assert.equal(failed.status, 'failed'); assert.ok(failed.message.includes('worker failed'));
    assert.deepEqual(await fs.readFile(selected), original);
    assert.equal(freeze, false);
    assert.ok(!(await fs.readdir(root)).some(name => name.startsWith('.novel-export-')));

    selected = null;
    assert.equal((await run('cancel')).status, 'cancelled');
    selected = path.join(root, 'book.bad');
    assert.equal((await run('overwrite-declined', 'docx')).status, 'cancelled');
    selected = path.join(root, 'retry.txt');
    generate = (...args) => client.generate(...args);
    await database.chapter.update({ where: { id: 'c1' }, data: { content: '重试时的最新内容' } });
    assert.equal((await run('retry')).status, 'success');
    assert.ok((await fs.readFile(selected, 'utf8')).includes('重试时的最新内容'));

    selected = path.join(root, 'range.txt');
    const ranged = await run('range', 'txt', { mode: 'range', start: 2, end: 2 });
    assert.equal(ranged.status, 'success'); assert.equal(ranged.chapters, 1);
    assert.ok((await fs.readFile(selected, 'utf8')).includes('章02 c2'));
    assert.ok(!(await fs.readFile(selected, 'utf8')).includes('章01 c1'));
    const selectedBytes = await fs.readFile(selected);
    assert.equal((await run('too-far', 'txt', { mode: 'range', start: 1, end: 3 })).status, 'failed');
    assert.deepEqual(await fs.readFile(selected), selectedBytes);
    assert.equal((await run('bad-range', 'txt', { mode: 'range', start: 0, end: 1 })).code, 'INVALID_RANGE');

    await database.chapter.update({ where: { id: 'c2' }, data: { content: '分批开始时的第二章' } });
    afterSnapshot = async () => { await database.chapter.update({ where: { id: 'c2' }, data: { content: '分批期间的新修改' } }); };
    const split = await run('split', 'txt', { mode: 'split', chaptersPerFile: 1 });
    afterSnapshot = async () => {};
    assert.equal(split.status, 'success', JSON.stringify(split));
    assert.equal(split.directory, true); assert.equal(split.files.length, 2); assert.equal(split.chapters, 2);
    assert.ok(split.files[0].endsWith('_第1-1章.txt') && split.files[1].endsWith('_第2-2章.txt'));
    const texts = await Promise.all(split.files.map(file => fs.readFile(file, 'utf8')));
    assert.ok(texts.every(text => text.includes('作者：行舟') && text.includes('第一段简介')));
    assert.ok(texts[0].includes('章01 c1') && !texts[0].includes('章02 c2'));
    assert.ok(texts[1].includes('章02 c2') && !texts[1].includes('章01 c1'));
    assert.ok(texts[1].includes('分批开始时的第二章') && !texts[1].includes('分批期间的新修改'));
    assert.ok(progress.some(event => event.part === 2 && event.parts === 2));
    const splitDocx = await run('split-docx', 'docx', { mode: 'split', chaptersPerFile: 1 });
    assert.equal(splitDocx.status, 'success'); assert.equal(splitDocx.files.length, 2);
    const beforeFailure = (await fs.readdir(root)).sort();
    let calls = 0;
    generate = (...args) => { if (++calls === 2) throw new Error('second part failed'); return client.generate(...args); };
    const failedSplit = await run('split-failure', 'docx', { mode: 'split', chaptersPerFile: 1 });
    assert.equal(failedSplit.status, 'failed'); assert.ok(failedSplit.message.includes('second part failed'));
    assert.deepEqual((await fs.readdir(root)).sort(), beforeFailure);
    generate = (...args) => client.generate(...args);
    deps.chooseDirectory = async () => null;
    assert.equal((await run('cancel-batch', 'docx', { mode: 'split', chaptersPerFile: 500 })).status, 'cancelled');

    deps.flush = async () => { throw new Error('保存失败'); };
    assert.equal((await run('save-failed')).status, 'failed');
    assert.equal(freeze, false);
    deps.flush = async () => { dataset = 'two'; };
    assert.equal((await run('dataset-changed')).status, 'failed');
    assert.equal(freeze, false);
    console.log('Novel export: shared text conversion, save queue, real SQLite snapshots, Python TXT/DOCX, safe replacement and recovery passed.');
} finally {
    await database.$disconnect();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(compile, { recursive: true, force: true });
}
