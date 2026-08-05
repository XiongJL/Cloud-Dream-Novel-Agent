import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

function splitSqlStatements(sql) {
    const statements = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    for (const char of sql) {
        if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
        if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
        if (char === ';' && !inSingleQuote && !inDoubleQuote) {
            if (current.trim()) statements.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) statements.push(current.trim());
    return statements;
}

const source = await readFile(new URL('../electron/automation/DraftSessionStore.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /draft-sessions\.json/u);
assert.match(source, /constructor\(database: PrismaClientType\)/u);
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DraftSessionStore } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-draft-sqlite-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());
const dbPath = path.join(tempRoot, 'draft-workspace.db').replaceAll('\\', '/');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}?connection_limit=1` } } });

try {
    const schemaSql = await readFile(
        new URL('../../../packages/core/generated/client/schema-init.sql', import.meta.url),
        'utf8',
    );
    for (const statement of splitSqlStatements(schemaSql)) {
        await client.$executeRawUnsafe(statement);
    }

    let sessionSchemaCreates = 0;
    const instrumentedClient = new Proxy(client, {
        get(target, property, receiver) {
            if (property === '$executeRawUnsafe') {
                return async (...args) => {
                    if (String(args[0]).includes('CREATE TABLE IF NOT EXISTS "DraftSession"')) {
                        sessionSchemaCreates += 1;
                    }
                    return target.$executeRawUnsafe(...args);
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const store = new DraftSessionStore(instrumentedClient);
    await Promise.all(Array.from({ length: 16 }, () => store.list()));
    assert.equal(sessionSchemaCreates, 1);
    const created = await store.create({
        workspace: 'chapter-editor',
        type: 'chapter-draft',
        source: 'internal-ai',
        origin: 'desktop-ui',
        novelId: 'novel-1',
        chapterId: 'chapter-1',
        sourceOperationId: 'operation-1',
        status: 'draft',
        payload: {
            chapterId: 'chapter-1',
            baseContent: '原文。',
            generatedText: 'SQLite 草稿。',
            content: '原文。SQLite 草稿。',
            usedContext: [],
            consistency: { ok: true, issues: [] },
        },
        previewSummary: 'SQLite 草稿',
    });

    const batch = await store.createBatch({
        novelId: 'novel-1',
        volumeId: 'volume-1',
        anchorChapterId: 'chapter-1',
        mode: 'sequence_continuation',
        beats: [{
            title: '下一章',
            chapterGoal: '继续调查',
            coreConflict: '线索中断',
            keyEvents: ['发现暗门'],
            reveals: ['旧信件'],
            endingHook: '门后传来声音',
            targetWordCount: 2000,
        }],
    });
    const approved = await store.approveBatchOutline(
        batch.draftBatchId,
        batch.version,
        batch.outline.revision,
        'test',
    );
    const attached = await store.createBatchChildSession(
        batch.draftBatchId,
        0,
        {
            workspace: 'chapter-editor',
            type: 'chapter-draft',
            source: 'internal-ai',
            origin: 'desktop-ui',
            novelId: 'novel-1',
            chapterId: 'draft-target',
            sourceOperationId: 'operation-batch-1',
            status: 'draft',
            payload: {
                chapterId: 'draft-target',
                baseContent: '',
                generatedText: '批次草稿。',
                content: '批次草稿。',
                usedContext: [],
                consistency: { ok: true, issues: [] },
            },
            previewSummary: '批次草稿',
        },
        {
            title: '下一章',
            coreConflict: '线索中断',
            keyEvents: ['发现暗门'],
            reveals: ['旧信件'],
            endingHook: '门后传来声音',
            summary: '批次草稿。',
        },
        1,
    );

    await assert.rejects(fs.access(path.join(tempRoot, 'automation', 'draft-sessions.json')));
    const restoredStore = new DraftSessionStore(client);
    const restored = await restoredStore.getBySourceOperationId('operation-1');
    assert.equal(restored?.draftSessionId, created.draftSessionId);
    assert.equal(restored?.payload.generatedText, 'SQLite 草稿。');
    const restoredBatch = await restoredStore.getBatchById(batch.draftBatchId);
    assert.equal(restoredBatch?.children[0].draftSessionId, attached.session.draftSessionId);
    assert.equal(restoredBatch?.status, 'ready_for_review');

    const rows = await client.$queryRawUnsafe('SELECT version, payloadJson FROM DraftSession WHERE sourceOperationId = ?', 'operation-1');
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].payloadJson).draftSessionId, created.draftSessionId);
    assert.equal((await client.$queryRawUnsafe('SELECT * FROM DraftBatch')).length, 1);
    assert.equal((await client.$queryRawUnsafe('SELECT * FROM DraftBatchChild')).length, 1);
    const workspaceRows = await client.$queryRawUnsafe(
        'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
        'table',
        'DraftWorkspaceState',
    );
    assert.equal(workspaceRows.length, 0);
} finally {
    await client.$disconnect();
    await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log('Draft session SQLite recovery tests passed.');
