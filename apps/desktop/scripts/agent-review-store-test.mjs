import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

const expertReportSource = await readFile(new URL('../shared/expertReport.ts', import.meta.url), 'utf8');
const expertReportOutput = ts.transpileModule(expertReportSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const expertReportModule = await import(`data:text/javascript;base64,${Buffer.from(expertReportOutput).toString('base64')}`);
globalThis.__normalizeExpertReportFindingIds = expertReportModule.normalizeExpertReportFindingIds;

const source = await readFile(new URL('../electron/agent/AgentReviewStore.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
    .replace("import { db } from '@novel-editor/core';", 'const db = undefined;')
    .replace(
        /import \{ normalizeExpertReportFindingIds \} from ['"]\.\.\/\.\.\/shared\/expertReport['"];/,
        'const normalizeExpertReportFindingIds = globalThis.__normalizeExpertReportFindingIds;',
    );
const { AgentReviewStore } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-agent-review-'));
const dbPath = path.join(tempRoot, 'agent-review.db').replaceAll('\\', '/');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
const hash = (content) => createHash('sha256').update(content, 'utf8').digest('hex');
const now = '2026-07-18T00:00:00.000Z';
const chapterContent = '第一章原始正文。';

try {
    await client.$executeRawUnsafe(`
        CREATE TABLE Novel (
            id TEXT PRIMARY KEY, title TEXT NOT NULL,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE Volume (
            id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL, "order" INTEGER NOT NULL,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE Chapter (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, wordCount INTEGER NOT NULL DEFAULT 0,
            "order" INTEGER NOT NULL, volumeId TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
            deleted INTEGER NOT NULL DEFAULT 0,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE AgentArtifact (
            artifactId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, runId TEXT NOT NULL,
            novelId TEXT NOT NULL, planId TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
            status TEXT NOT NULL, summary TEXT, content TEXT, referenceJson TEXT, metadataJson TEXT,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe("INSERT INTO Novel (id, title) VALUES ('novel-1', '测试小说')");
    await client.$executeRawUnsafe("INSERT INTO Volume (id, novelId, title, \"order\") VALUES ('volume-1', 'novel-1', '第一卷', 1)");
    await client.$executeRawUnsafe(
        'INSERT INTO Chapter (id, title, content, "order", volumeId, version) VALUES (?, ?, ?, ?, ?, ?)',
        'chapter-1', '第一章', chapterContent, 1, 'volume-1', 1,
    );

    const snapshot = [{
        chapterId: 'chapter-1', version: 1, contentHash: hash(chapterContent), updatedAt: now, source: 'database',
    }];
    const report = {
        artifactId: 'artifact-1', novelId: 'novel-1', runId: 'run-1', planId: 'plan-1',
        type: 'chapter_range_review', title: '章节范围审核', expert: 'editor',
        scope: {
            scopeId: 'scope-1', novelId: 'novel-1', kind: 'current_chapter', chapterIds: ['chapter-1'],
            anchorChapterId: 'chapter-1', processingMode: 'detailed', snapshot,
        },
        findings: [{
            findingId: 'finding-1', title: '动机断层', summary: '人物行动缺少铺垫', category: 'motivation',
            severity: 'high', chapterIds: ['chapter-1'], expert: 'editor', evidenceRefs: ['chapter-1'],
            recommendation: '补充行动前的犹豫与触发事件', recommendedRole: 'writer',
        }],
        sourceSnapshot: snapshot,
        generatedAt: now,
    };
    await client.$executeRawUnsafe(`
        INSERT INTO AgentArtifact (
            artifactId, conversationId, runId, novelId, planId, type, title, status, metadataJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 'artifact-1', 'conversation-1', 'run-1', 'novel-1', 'plan-1', report.type, report.title, 'ready',
    JSON.stringify({ expertReport: report }));

    const store = new AgentReviewStore(client);
    const currentConversation = await store.submitArtifactReview({
        artifactId: 'artifact-1', expectedReviewRevision: 0, createRevisionTasks: false,
        decisions: [{ findingId: 'finding-1', status: 'accepted', note: '在当前对话立即修订' }],
    });
    assert.equal(currentConversation.review.reviewRevision, 1);
    assert.equal(currentConversation.revisionTasks.length, 0);

    const first = await store.submitArtifactReview({
        artifactId: 'artifact-1', expectedReviewRevision: 1,
        decisions: [{ findingId: 'finding-1', status: 'accepted', note: '进入修订池' }],
    });
    assert.equal(first.review.reviewStatus, 'reviewed');
    assert.equal(first.review.reviewRevision, 2);
    assert.equal(first.revisionTasks.length, 1);
    assert.equal(first.revisionTasks[0].status, 'open');
    const revisionTaskId = first.revisionTasks[0].revisionTaskId;

    const retry = await store.submitArtifactReview({
        artifactId: 'artifact-1', expectedReviewRevision: 2,
        decisions: [{ findingId: 'finding-1', status: 'accepted', note: '重复提交仍应幂等' }],
    });
    assert.equal(retry.review.reviewRevision, 3);
    assert.equal(retry.revisionTasks.length, 1);
    assert.equal(retry.revisionTasks[0].revisionTaskId, revisionTaskId);
    assert.equal((await store.listRevisionTasks({ novelId: 'novel-1', chapterId: 'chapter-1' })).length, 1);

    const legacyDuplicateReport = {
        ...report,
        artifactId: 'artifact-legacy-duplicates',
        findings: [
            report.findings[0],
            { ...report.findings[0], findingId: 'finding-1', title: '第二条旧建议' },
        ],
    };
    await client.$executeRawUnsafe(`
        INSERT INTO AgentArtifact (
            artifactId, conversationId, runId, novelId, planId, type, title, status, metadataJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 'artifact-legacy-duplicates', 'conversation-1', 'run-1', 'novel-1', 'plan-1', report.type, report.title, 'ready',
    JSON.stringify({ expertReport: legacyDuplicateReport }));
    const legacyDuplicateReview = await store.submitArtifactReview({
        artifactId: 'artifact-legacy-duplicates', expectedReviewRevision: 0, createRevisionTasks: false,
        decisions: [
            { findingId: 'finding-1', status: 'accepted' },
            { findingId: 'finding-1__2', status: 'accepted' },
        ],
    });
    assert.deepEqual(
        legacyDuplicateReview.review.decisions.map((decision) => decision.findingId),
        ['finding-1', 'finding-1__2'],
    );

    const deferredReport = {
        ...report,
        artifactId: 'artifact-2',
        findings: [{ ...report.findings[0], findingId: 'finding-2', title: '节奏松散' }],
    };
    await client.$executeRawUnsafe(`
        INSERT INTO AgentArtifact (
            artifactId, conversationId, runId, novelId, planId, type, title, status, metadataJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 'artifact-2', 'conversation-1', 'run-1', 'novel-1', 'plan-1', report.type, report.title, 'ready',
    JSON.stringify({ expertReport: deferredReport }));
    const deferredReview = await store.submitArtifactReview({
        artifactId: 'artifact-2', expectedReviewRevision: 0,
        decisions: [{ findingId: 'finding-2', status: 'deferred' }],
    });
    assert.equal(deferredReview.revisionTasks.length, 1);
    assert.equal(deferredReview.revisionTasks[0].status, 'deferred');

    const recoveryReport = {
        ...report,
        artifactId: 'artifact-3',
        runId: 'report-run-3',
        findings: [{ ...report.findings[0], findingId: 'finding-3', title: '动机恢复项' }],
    };
    await client.$executeRawUnsafe(`
        INSERT INTO AgentArtifact (
            artifactId, conversationId, runId, novelId, planId, type, title, status, metadataJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 'artifact-3', 'conversation-3', 'report-run-3', 'novel-1', 'plan-3', report.type, report.title, 'ready',
    JSON.stringify({ expertReport: recoveryReport }));
    const immediateReview = await store.submitArtifactReview({
        artifactId: 'artifact-3', expectedReviewRevision: 0, createRevisionTasks: false,
        decisions: [{ findingId: 'finding-3', status: 'accepted' }],
    });
    assert.equal(immediateReview.revisionTasks.length, 0);
    const recovered = await store.syncRevisionTasksFromRun({
        novelId: 'novel-1', sourceArtifactId: 'artifact-3', sourceConversationId: 'conversation-3',
        sourceRunId: 'revision-run-3', findingIds: ['finding-3'], outcome: 'failed',
    });
    assert.equal(recovered.revisionTasks.length, 1);
    assert.equal(recovered.revisionTasks[0].status, 'open');
    assert.equal(recovered.revisionTasks[0].entryReason, 'failed');
    assert.equal(recovered.revisionTasks[0].sourceConversationId, 'conversation-3');
    assert.equal(recovered.revisionTasks[0].sourceRunId, 'revision-run-3');
    const recoveredTaskId = recovered.revisionTasks[0].revisionTaskId;
    const repeatedRecovery = await store.syncRevisionTasksFromRun({
        novelId: 'novel-1', sourceArtifactId: 'artifact-3', sourceConversationId: 'conversation-3',
        sourceRunId: 'revision-run-3', findingIds: ['finding-3'], outcome: 'failed',
    });
    assert.equal(repeatedRecovery.revisionTasks[0].revisionTaskId, recoveredTaskId);
    const completedRecovery = await store.syncRevisionTasksFromRun({
        novelId: 'novel-1', sourceArtifactId: 'artifact-3', sourceConversationId: 'conversation-3',
        sourceRunId: 'revision-run-4', findingIds: ['finding-3'], outcome: 'completed',
    });
    assert.equal(completedRecovery.revisionTasks[0].status, 'planned');
    const committedRecovery = await store.syncRevisionTasksFromRun({
        novelId: 'novel-1', sourceArtifactId: 'artifact-3', sourceConversationId: 'conversation-3',
        sourceRunId: 'revision-run-4', findingIds: ['finding-3'], outcome: 'committed',
    });
    assert.equal(committedRecovery.revisionTasks[0].status, 'resolved');
    const lateFailure = await store.syncRevisionTasksFromRun({
        novelId: 'novel-1', sourceArtifactId: 'artifact-3', sourceConversationId: 'conversation-3',
        sourceRunId: 'revision-run-4', findingIds: ['finding-3'], outcome: 'failed',
    });
    assert.equal(lateFailure.revisionTasks[0].status, 'resolved');

    await assert.rejects(
        () => store.submitArtifactReview({
            artifactId: 'artifact-1', expectedReviewRevision: 0,
            decisions: [{ findingId: 'finding-1', status: 'accepted' }],
        }),
        (error) => error?.code === 'VERSION_CONFLICT',
    );

    const openTask = await store.getRevisionTask(revisionTaskId);
    const deferred = await store.updateRevisionTaskStatus({
        revisionTaskId,
        expectedUpdatedAt: openTask.updatedAt,
        status: 'deferred',
    });
    assert.equal(deferred.status, 'deferred');
    await assert.rejects(
        () => store.updateRevisionTaskStatus({
            revisionTaskId,
            expectedUpdatedAt: openTask.updatedAt,
            status: 'open',
        }),
        (error) => error?.code === 'VERSION_CONFLICT',
    );
    const reopened = await store.updateRevisionTaskStatus({
        revisionTaskId,
        expectedUpdatedAt: deferred.updatedAt,
        status: 'open',
    });
    assert.equal(reopened.status, 'open');

    const planned = await store.attachPlan(revisionTaskId, { planId: 'plan-revision-1', title: '修订计划' });
    assert.equal(planned.status, 'planned');
    assert.equal(planned.planId, 'plan-revision-1');

    await client.$executeRawUnsafe(
        'UPDATE Chapter SET content = ?, version = version + 1 WHERE id = ?',
        '第一章已被用户修改。', 'chapter-1',
    );
    await assert.rejects(
        () => store.assertRevisionTaskFresh(planned),
        (error) => error?.code === 'REPORT_STALE' && error?.details?.staleChapterIds?.[0] === 'chapter-1',
    );
    assert.equal((await store.getRevisionTask(revisionTaskId)).status, 'stale');
    const artifactRows = await client.$queryRawUnsafe(
        'SELECT reviewStatus, reviewStaleChapterIdsJson FROM AgentArtifact WHERE artifactId = ?', 'artifact-1',
    );
    assert.equal(artifactRows[0].reviewStatus, 'stale');
    assert.deepEqual(JSON.parse(artifactRows[0].reviewStaleChapterIdsJson), ['chapter-1']);

    console.log('Agent expert report review, recovery sync, idempotency, and staleness tests passed.');
} finally {
    await client.$disconnect().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
}
