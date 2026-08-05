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
    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
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

const stateSource = await readFile(new URL('../shared/draftOperation.ts', import.meta.url), 'utf8');
const stateOutput = ts.transpileModule(stateSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const stateUrl = `data:text/javascript;base64,${Buffer.from(stateOutput).toString('base64')}`;

const storeSource = await readFile(new URL('../electron/automation/DraftOperationStore.ts', import.meta.url), 'utf8');
const coreModuleUrl = new URL('../../../packages/core/dist/index.js', import.meta.url).href;
const storeOutput = ts.transpileModule(storeSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
    .replace("from '@novel-editor/core'", `from '${coreModuleUrl}'`)
    .replace("from '../../shared/draftOperation'", `from '${stateUrl}'`);
const {
    DraftOperationStore,
    buildDraftOperationKey,
    hashDraftOperationParams,
} = await import(`data:text/javascript;base64,${Buffer.from(storeOutput).toString('base64')}`);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-draft-operation-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());
const dbPath = path.join(tempRoot, 'draft-operation.db').replaceAll('\\', '/');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

try {
    const schemaSql = await readFile(
        new URL('../../../packages/core/generated/client/schema-init.sql', import.meta.url),
        'utf8',
    );
    for (const statement of splitSqlStatements(schemaSql)) {
        await client.$executeRawUnsafe(statement);
    }

    let operationSchemaCreates = 0;
    const instrumentedClient = new Proxy(client, {
        get(target, property, receiver) {
            if (property === '$executeRawUnsafe') {
                return async (...args) => {
                    if (String(args[0]).includes('CREATE TABLE IF NOT EXISTS "DraftGenerationOperation"')) {
                        operationSchemaCreates += 1;
                    }
                    return target.$executeRawUnsafe(...args);
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const store = new DraftOperationStore(instrumentedClient);
    await Promise.all(Array.from({ length: 16 }, () => store.ensureSchema()));
    assert.equal(operationSchemaCreates, 1);
    const payload = {
        novelId: 'novel_1',
        chapterId: 'chapter_1',
        generationRevision: 1,
        prompt: '继续写作',
        options: { tone: '克制', targetLength: 3000 },
    };
    const paramsHash = hashDraftOperationParams(payload);
    assert.equal(paramsHash, hashDraftOperationParams({
        options: { targetLength: 3000, tone: '克制' },
        prompt: '继续写作',
        generationRevision: 1,
        chapterId: 'chapter_1',
        novelId: 'novel_1',
    }));
    const operationKey = buildDraftOperationKey({
        novelId: 'novel_1',
        chapterId: 'chapter_1',
        generationRevision: 1,
        paramsHash,
    });
    const createInput = {
        operationKey,
        paramsHash,
        requestJson: JSON.stringify(payload),
        novelId: 'novel_1',
        chapterId: 'chapter_1',
        generationRevision: 1,
        sourceChapterVersion: 2,
        sourceContentHash: 'source_hash',
        operationDeadlineAt: '2099-07-29T01:00:00.000Z',
        sourceRunId: 'run_1',
        sourceStepId: 'step_1',
    };

    const created = await store.createOrGet(createInput);
    assert.equal(created.existing, false);
    assert.equal(created.operation.status, 'queued');

    const reused = await store.createOrGet(createInput);
    assert.equal(reused.existing, true);
    assert.equal(reused.operation.operationId, created.operation.operationId);

    await assert.rejects(
        store.createOrGet({ ...createInput, paramsHash: 'different_hash' }),
        (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );

    const concurrentInput = {
        ...createInput,
        operationKey: `${operationKey}:concurrent`,
        paramsHash: 'concurrent_hash',
        requestJson: '{"kind":"concurrent"}',
    };
    const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => store.createOrGet(concurrentInput)),
    );
    assert.equal(new Set(concurrent.map((item) => item.operation.operationId)).size, 1);
    assert.equal(concurrent.filter((item) => !item.existing).length, 1);

    let operation = await store.transition(created.operation.operationId, created.operation.version, {
        type: 'CLAIM',
        now: '2026-07-29T00:00:00.000Z',
        workerId: 'worker_1',
        leaseExpiresAt: '2026-07-29T00:01:00.000Z',
    });
    assert.equal(operation.status, 'running_generation');
    assert.equal(operation.version, 2);

    await store.startAttempt({
        operationId: operation.operationId,
        attemptNumber: operation.attemptCount,
        requestId: 'request_1',
        providerType: 'http',
        model: 'gpt-test',
    });
    await store.markAttemptActivity(operation.operationId, operation.attemptCount, 'first_byte');
    await store.completeAttempt({
        operationId: operation.operationId,
        attemptNumber: operation.attemptCount,
        status: 'succeeded',
        outputTokens: 321,
    });

    operation = await store.transition(operation.operationId, operation.version, {
        type: 'GENERATION_SUCCEEDED',
        now: '2026-07-29T00:00:30.000Z',
        generatedPayloadJson: '{"text":"draft"}',
    });
    operation = await store.transition(operation.operationId, operation.version, {
        type: 'POSTPROCESS_COMPLETED',
        now: '2026-07-29T00:00:31.000Z',
        warningJson: '[]',
    });
    await assert.rejects(
        store.transition(operation.operationId, operation.version, {
            type: 'COMMIT_SUCCEEDED',
            now: '2026-07-29T00:00:31.500Z',
            draftSessionId: 'draft_missing',
            resultJson: '{"draftSessionId":"draft_missing"}',
        }),
        (error) => error?.code === 'DRAFT_RESULT_NOT_COMMITTED',
    );
    assert.equal((await store.get(operation.operationId)).status, 'committing');
    await client.draftSession.create({
        data: {
            draftSessionId: 'draft_1',
            workspace: 'chapter-editor',
            type: 'chapter-draft',
            source: 'internal-ai',
            origin: 'desktop-ui',
            novelId: operation.novelId,
            chapterId: operation.chapterId,
            sourceOperationId: operation.operationId,
            generationRevision: operation.generationRevision,
            status: 'draft',
            payloadJson: '{}',
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
    });
    operation = await store.transition(operation.operationId, operation.version, {
        type: 'COMMIT_SUCCEEDED',
        now: '2026-07-29T00:00:32.000Z',
        draftSessionId: 'draft_1',
        resultJson: '{"draftSessionId":"draft_1"}',
    });
    assert.equal(operation.status, 'succeeded');
    assert.equal(operation.resultDraftSessionId, 'draft_1');

    const outbox = await store.listPendingOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].operationId, operation.operationId);
    await store.markOutboxDelivered(outbox[0].outboxId);
    assert.equal((await store.listPendingOutbox()).length, 0);

    await assert.rejects(
        store.transition(operation.operationId, operation.version - 1, {
            type: 'COMMIT_SUCCEEDED',
            now: '2026-07-29T00:00:32.000Z',
            draftSessionId: 'draft_1',
            resultJson: '{}',
        }),
        (error) => error?.code === 'VERSION_CONFLICT',
    );

    const restored = await store.get(operation.operationId);
    assert.equal(restored.status, 'succeeded');
    assert.equal(restored.resultDraftSessionId, 'draft_1');

    const retryCreated = await store.createOrGet({
        ...createInput,
        operationKey: `${operationKey}:retry-wait`,
        paramsHash: 'retry_wait_hash',
        requestJson: '{"kind":"retry-wait"}',
    });
    let retryOperation = await store.transition(retryCreated.operation.operationId, retryCreated.operation.version, {
        type: 'CLAIM',
        now: '2026-07-29T00:00:00.000Z',
        workerId: 'old-worker',
        leaseExpiresAt: '2099-07-29T00:00:00.000Z',
    });
    retryOperation = await store.transition(retryOperation.operationId, retryOperation.version, {
        type: 'RETRYABLE_FAILURE',
        now: '2026-07-29T00:00:01.000Z',
        retryAt: '2099-07-29T00:00:00.000Z',
        errorCode: 'NETWORK_ERROR',
        errorJson: '{"code":"NETWORK_ERROR"}',
    });

    const runningCreated = await store.createOrGet({
        ...createInput,
        operationKey: `${operationKey}:running`,
        paramsHash: 'running_hash',
        requestJson: '{"kind":"running"}',
    });
    const runningOperation = await store.transition(
        runningCreated.operation.operationId,
        runningCreated.operation.version,
        {
            type: 'CLAIM',
            now: '2026-07-29T00:00:00.000Z',
            workerId: 'dead-worker',
            leaseExpiresAt: '2099-07-29T00:00:00.000Z',
        },
    );
    const recoverableIds = new Set((await store.listRecoverable()).map((item) => item.operationId));
    assert.equal(recoverableIds.has(retryOperation.operationId), true);
    assert.equal(recoverableIds.has(runningOperation.operationId), true);
} finally {
    await client.$disconnect();
    await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log('Draft operation SQLite store tests passed.');
