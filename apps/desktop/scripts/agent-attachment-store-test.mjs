import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

const source = await readFile(new URL('../electron/agent/AgentAttachmentStore.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { AgentAttachmentStore } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-attachment-store-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());
const dbPath = path.join(tempRoot, 'attachments.db').replaceAll('\\', '/');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

try {
    await client.$executeRawUnsafe(`
        CREATE TABLE Novel (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, coverUrl TEXT,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
            wordCount INTEGER NOT NULL DEFAULT 0, formatting TEXT NOT NULL DEFAULT '{}'
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE AgentConversation (
            id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe("INSERT INTO Novel (id, title) VALUES ('novel-a', 'A'), ('novel-b', 'B')");
    await client.$executeRawUnsafe("INSERT INTO AgentConversation (id, novelId, title, role) VALUES ('conv-a', 'novel-a', 'A', 'team'), ('conv-b', 'novel-b', 'B', 'team')");

    const store = new AgentAttachmentStore(client);
    await store.ensureSchema();
    assert.deepEqual(await store.list('novel-a', 'unpersisted-conversation'), []);
    await assert.rejects(
        store.list('novel-a', 'conv-b'),
        (error) => error?.code === 'ATTACHMENT_SCOPE_MISMATCH',
    );
    const created = await store.create({
        id: 'attachment-a',
        novelId: 'novel-a',
        conversationId: 'conv-a',
        originalFileName: 'outline.md',
        extension: '.md',
        mimeType: 'text/markdown',
        sizeBytes: 32,
        contentHash: 'hash-a',
        extractorVersion: '1.0.0',
        document: {
            title: 'Outline',
            plainText: 'Outline\n\nFirst beat and first echo',
            blocks: [
                { blockId: 'b1', type: 'heading', text: 'Outline', startOffset: 0, endOffset: 7, headingPath: ['Outline'] },
                { blockId: 'b2', type: 'paragraph', text: 'First beat and first echo', startOffset: 9, endOffset: 34, headingPath: ['Outline'] },
            ],
            metadata: { warnings: [] },
        },
    });
    assert.equal(created.messageId, null);
    assert.equal((await store.list('novel-a', 'conv-a')).length, 1);
    assert.deepEqual((await store.outline('novel-a', 'conv-a', 'attachment-a')).entries.map((item) => item.blockId), ['b1']);
    assert.equal((await store.readWindow({ novelId: 'novel-a', conversationId: 'conv-a', attachmentId: 'attachment-a', offset: 9, limit: 5 })).text, 'First');
    assert.deepEqual((await store.search({ novelId: 'novel-a', conversationId: 'conv-a', query: 'first' })).matches, []);
    await assert.rejects(
        store.search({ novelId: 'novel-a', conversationId: 'conv-a', attachmentId: 'attachment-a', query: 'first' }),
        (error) => error?.code === 'ATTACHMENT_NOT_SENT',
    );

    const bound = await store.bindToMessage('novel-a', 'conv-a', 'message-a', ['attachment-a']);
    assert.equal(bound[0].messageId, 'message-a');
    const search = await store.search({ novelId: 'novel-a', conversationId: 'conv-a', query: 'FIRST', limit: 1 });
    assert.equal(search.searchedAttachmentCount, 1);
    assert.equal(search.hasMore, true);
    assert.equal(search.matches.length, 1);
    assert.deepEqual(
        { attachmentId: search.matches[0].attachmentId, blockId: search.matches[0].blockId, startOffset: search.matches[0].startOffset, endOffset: search.matches[0].endOffset },
        { attachmentId: 'attachment-a', blockId: 'b2', startOffset: 9, endOffset: 14 },
    );
    assert.match(search.matches[0].snippet, /First beat/);

    const sectionLines = ['第一章', '甲', '第二章（上）', '乙', '第二章（下）', '丙', '第三章', '丁'];
    const sectionText = sectionLines.join('\n');
    let cursor = 0;
    const sectionBlocks = sectionLines.map((text, index) => {
        const startOffset = cursor;
        const endOffset = startOffset + text.length;
        cursor = endOffset + 1;
        return {
            blockId: `s${index + 1}`,
            type: index % 2 === 0 ? 'heading' : 'paragraph',
            text,
            page: index < 4 ? 1 : 2,
            startOffset,
            endOffset,
            ...(index % 2 === 0 ? { headingPath: [text] } : {}),
        };
    });
    await store.create({
        id: 'attachment-sections', novelId: 'novel-a', conversationId: 'conv-a',
        originalFileName: 'novel.txt', extension: '.txt', mimeType: 'text/plain', sizeBytes: sectionText.length,
        contentHash: 'hash-sections', extractorVersion: '1.0.0',
        document: { plainText: sectionText, blocks: sectionBlocks, metadata: { pageCount: 2, warnings: [] } },
    });
    const section = await store.read({
        novelId: 'novel-a', conversationId: 'conv-a', attachmentId: 'attachment-sections',
        selector: { kind: 'section', title: '第二章' },
    });
    assert.equal(section.status, 'resolved');
    assert.match(section.text, /^第二章（上）/);
    assert.match(section.text, /第二章（下）/);
    assert.doesNotMatch(section.text, /第三章/);
    assert.equal(section.truncated, false);
    assert.deepEqual(section.pages, [1, 2]);

    const page = await store.read({
        novelId: 'novel-a', conversationId: 'conv-a', attachmentId: 'attachment-sections',
        selector: { kind: 'page_range', startPage: 2, endPage: 2 },
    });
    assert.deepEqual(page.pages, [2]);
    assert.match(page.text, /第二章（下）/);
    const blockRange = await store.read({
        novelId: 'novel-a', conversationId: 'conv-a', attachmentId: 'attachment-sections',
        selector: { kind: 'block_range', startBlockId: 's2', endBlockId: 's4' },
    });
    assert.equal(blockRange.text, sectionText.slice(sectionBlocks[1].startOffset, sectionBlocks[3].endOffset));
    await assert.rejects(
        store.read({
            novelId: 'novel-a', conversationId: 'conv-a', attachmentId: 'attachment-sections',
            selector: { kind: 'offset_range', startOffset: 10, endOffset: 2 },
        }),
        (error) => error?.code === 'INVALID_INPUT',
    );

    const longText = `长章\n${'段落内容。'.repeat(3000)}\n下一章`;
    await store.create({
        id: 'attachment-long', novelId: 'novel-a', conversationId: 'conv-a',
        originalFileName: 'long.txt', extension: '.txt', sizeBytes: longText.length,
        contentHash: 'hash-long', extractorVersion: '1.0.0',
        document: {
            plainText: longText,
            blocks: [
                { blockId: 'long-heading', type: 'heading', text: '长章', startOffset: 0, endOffset: 2, headingPath: ['长章'] },
                { blockId: 'long-body', type: 'paragraph', text: longText.slice(3, -4), startOffset: 3, endOffset: longText.length - 4, headingPath: ['长章'] },
                { blockId: 'next-heading', type: 'heading', text: '下一章', startOffset: longText.length - 3, endOffset: longText.length, headingPath: ['下一章'] },
            ],
            metadata: { warnings: [] },
        },
    });
    const longRead = await store.read({
        novelId: 'novel-a', conversationId: 'conv-a', attachmentId: 'attachment-long',
        selector: { kind: 'section', title: '长章' },
    });
    assert.equal(longRead.text.length > 7000 && longRead.text.length <= 8000, true);
    assert.equal(longRead.truncated, true);
    assert.equal(longRead.nextSelector?.kind, 'offset_range');
    await assert.rejects(
        store.getContent('novel-b', 'conv-b', 'attachment-a'),
        (error) => error?.code === 'ATTACHMENT_SCOPE_MISMATCH',
    );
    await assert.rejects(
        store.removePending('novel-a', 'conv-a', 'attachment-a'),
        (error) => error?.code === 'ATTACHMENT_ALREADY_BOUND',
    );
} finally {
    await client.$disconnect();
    await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log('agent attachment store tests passed');
