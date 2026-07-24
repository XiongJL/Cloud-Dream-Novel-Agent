import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../electron/automation/DraftSessionStore.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DraftSessionStore } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-draft-recovery-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());

try {
    await fs.mkdir(path.join(tempRoot, 'automation'), { recursive: true });
    await fs.writeFile(
        path.join(tempRoot, 'automation', 'draft-sessions.json'),
        JSON.stringify({ sessions: [] }),
        'utf8',
    );

    const store = new DraftSessionStore(() => tempRoot);
    const created = await store.create({
        workspace: 'chapter-editor',
        type: 'chapter-draft',
        source: 'internal-ai',
        origin: 'desktop-ui',
        novelId: 'novel-1',
        chapterId: 'chapter-1',
        status: 'draft',
        payload: {
            chapterId: 'chapter-1',
            baseContent: '原文。',
            generatedText: '初稿。',
            content: '原文。初稿。',
            usedContext: [],
            consistency: { ok: true, issues: [] },
        },
        previewSummary: '章节草稿 3 字符',
    });
    assert.equal(created.version, 1);

    const edited = await store.update(created.draftSessionId, created.version, (current) => ({
        ...current,
        payload: { ...current.payload, generatedText: '审核后草稿。', content: '原文。审核后草稿。' },
    }));
    assert.equal(edited.version, 2);

    const afterRefresh = new DraftSessionStore(() => tempRoot);
    const restored = await afterRefresh.getById(created.draftSessionId);
    assert.equal(restored?.version, 2);
    assert.equal(restored?.payload.generatedText, '审核后草稿。');

    await assert.rejects(
        () => afterRefresh.update(created.draftSessionId, 1, (current) => current),
        (error) => error?.code === 'VERSION_CONFLICT',
    );

    const committed = await afterRefresh.update(created.draftSessionId, 2, (current) => ({
        ...current,
        status: 'committed',
    }));
    assert.equal(committed.status, 'committed');

    const finalReload = new DraftSessionStore(() => tempRoot);
    assert.equal((await finalReload.getById(created.draftSessionId))?.status, 'committed');
    assert.deepEqual(await finalReload.list({ novelId: 'novel-1' }), []);
    assert.equal((await finalReload.list({ novelId: 'novel-1', includeInactive: true })).length, 1);

    const historyInput = {
        workspace: 'chapter-editor',
        type: 'chapter-draft',
        source: 'internal-ai',
        origin: 'desktop-ui',
        novelId: 'novel-history',
        chapterId: 'chapter-history',
        status: 'draft',
        payload: {
            chapterId: 'chapter-history',
            baseContent: '历史原文。',
            generatedText: '第一版。',
            content: '历史原文。第一版。',
            usedContext: [],
            consistency: { ok: true, issues: [] },
        },
        previewSummary: '历史草稿第一版',
    };
    const historyFirst = await finalReload.create(historyInput);
    const historySecond = await finalReload.create({
        ...historyInput,
        revisionOfDraftSessionId: historyFirst.draftSessionId,
        reviewRequestId: 'review-request-1',
        payload: { ...historyInput.payload, generatedText: '第二版。', content: '历史原文。第二版。' },
        previewSummary: '历史草稿第二版',
    });
    assert.equal((await finalReload.getById(historyFirst.draftSessionId))?.status, 'stale');
    assert.equal((await finalReload.getById(historySecond.draftSessionId))?.status, 'draft');
    assert.equal(historySecond.revisionOfDraftSessionId, historyFirst.draftSessionId);
    assert.equal((await finalReload.list({ novelId: 'novel-history', includeInactive: true })).length, 2);

    const beat = (title) => ({
        title,
        chapterGoal: `${title}目标`,
        coreConflict: `${title}冲突`,
        keyEvents: [`${title}事件`],
        reveals: [`${title}揭示`],
        endingHook: `${title}钩子`,
        targetWordCount: 2400,
    });
    const batch = await finalReload.createBatch({
        novelId: 'novel-1',
        volumeId: 'volume-1',
        anchorChapterId: 'chapter-1',
        mode: 'sequence_continuation',
        insertionMode: 'after_anchor',
        beats: [beat('第三章'), beat('第四章'), beat('第五章')],
        sourceSnapshot: [{ chapterId: 'chapter-1', version: 7, contentHash: 'hash-7' }],
    });
    assert.equal(batch.status, 'outline_draft');
    assert.equal(batch.children.length, 3);

    await assert.rejects(
        () => finalReload.createBatch({
            novelId: 'novel-1',
            volumeId: 'volume-1',
            anchorChapterId: 'chapter-1',
            mode: 'batch_rewrite',
            beats: [beat('改写第一章')],
            targetChapterIds: ['chapter-1'],
            sourceSnapshot: [],
        }),
        (error) => error?.code === 'INVALID_INPUT' && /source snapshot/.test(error.message),
    );
    await assert.rejects(
        () => finalReload.createBatch({
            novelId: 'novel-1',
            volumeId: 'volume-1',
            anchorChapterId: 'chapter-1',
            mode: 'batch_rewrite',
            beats: [beat('改写第一章'), beat('再次改写第一章')],
            targetChapterIds: ['chapter-1', 'chapter-1'],
            sourceSnapshot: [{ chapterId: 'chapter-1', version: 7, contentHash: 'hash-7' }],
        }),
        (error) => error?.code === 'INVALID_INPUT' && /must be unique/.test(error.message),
    );
    const rewriteBatch = await finalReload.createBatch({
        novelId: 'novel-1',
        volumeId: 'volume-1',
        anchorChapterId: 'chapter-1',
        mode: 'batch_rewrite',
        beats: [beat('改写第一章')],
        targetChapterIds: ['chapter-1'],
        sourceSnapshot: [{ chapterId: 'chapter-1', version: 7, contentHash: 'hash-7' }],
    });
    assert.equal(rewriteBatch.children[0].targetChapterId, 'chapter-1');
    await finalReload.discardBatch(rewriteBatch.draftBatchId, rewriteBatch.version);

    const revisedBatch = await finalReload.updateBatchOutline(
        batch.draftBatchId,
        batch.version,
        [beat('第三章（修订）'), beat('第四章'), beat('第五章')],
    );
    assert.equal(revisedBatch.outline.revision, 2);
    assert.equal(revisedBatch.children[0].title, '第三章（修订）');
    await assert.rejects(
        () => finalReload.approveBatchOutline(
            revisedBatch.draftBatchId,
            revisedBatch.version,
            1,
            'test-user',
        ),
        (error) => error?.code === 'VERSION_CONFLICT',
    );

    const approved = await finalReload.approveBatchOutline(
        revisedBatch.draftBatchId,
        revisedBatch.version,
        revisedBatch.outline.revision,
        'test-user',
    );
    assert.equal(approved.status, 'ready_to_generate');
    assert.equal(approved.outline.status, 'approved');

    const stateDelta = (index) => ({
        characterLocations: [{
            characterKey: '顾野',
            location: `地点-${index}`,
            evidenceExcerpt: `第 ${index + 3} 章草稿。`,
        }],
        relationshipChanges: index === 1 ? [{
            sourceCharacterKey: '顾野',
            targetCharacterKey: '林薇',
            change: '开始互相信任',
            evidenceExcerpt: `第 ${index + 3} 章草稿。`,
        }] : [],
        knowledgeChanges: [{
            characterKey: '顾野',
            learned: [`事实-${index}`],
            forgotten: [],
            evidenceExcerpt: `第 ${index + 3} 章草稿。`,
        }],
        itemStates: [{
            itemKey: '铜钥匙',
            state: `状态-${index}`,
            holderKey: '顾野',
            evidenceExcerpt: `第 ${index + 3} 章草稿。`,
        }],
        resolvedConflicts: [],
        openedConflicts: [{
            conflict: `新增冲突-${index}`,
            evidenceExcerpt: `第 ${index + 3} 章草稿。`,
        }],
        warnings: [],
    });
    const createChildInput = (index) => ({
        workspace: 'chapter-editor',
        type: 'chapter-draft',
        source: 'internal-ai',
        origin: 'desktop-ui',
        novelId: 'will-be-normalized',
        chapterId: `future-chapter-${index}`,
        status: 'draft',
        payload: {
            chapterId: `future-chapter-${index}`,
            baseContent: '',
            generatedText: `第 ${index + 3} 章草稿。`,
            content: `第 ${index + 3} 章草稿。`,
            usedContext: [],
            consistency: { ok: true, issues: [] },
            narrativeStateDelta: stateDelta(index),
        },
        previewSummary: `章节草稿 ${index + 3}`,
    });

    let currentBatch = approved;
    const childSessions = [];
    for (let index = 0; index < 3; index += 1) {
        const attached = await finalReload.createBatchChildSession(
            currentBatch.draftBatchId,
            index,
            createChildInput(index),
            {
                title: `第 ${index + 3} 章`,
                coreConflict: `冲突 ${index + 1}`,
                keyEvents: [`事件 ${index + 1}`],
                reveals: [`揭示 ${index + 1}`],
                endingHook: `钩子 ${index + 1}`,
                summary: `摘要 ${index + 1}`,
                stateDelta: stateDelta(index),
            },
        );
        currentBatch = attached.batch;
        childSessions.push(attached.session);
    }
    assert.equal(currentBatch.status, 'ready_for_review');
    assert.equal(currentBatch.stateLedger.timeline.length, 3);
    assert.equal(currentBatch.stateLedger.foreshadowing.length, 3);
    assert.equal(currentBatch.stateLedger.stateDeltas.length, 3);
    assert.equal(currentBatch.stateLedger.characterLocations['顾野'], '地点-2');
    assert.deepEqual(currentBatch.stateLedger.knowledgeState['顾野'], ['事实-0', '事实-1', '事实-2']);
    assert.equal(currentBatch.stateLedger.itemStates['铜钥匙'], '状态-2');
    assert.equal(currentBatch.stateLedger.relationshipChanges.length, 1);
    assert.equal((await finalReload.list({ novelId: 'novel-1' })).length, 0);
    assert.equal((await finalReload.list({ novelId: 'novel-1', includeBatchChildren: true })).length, 3);
    assert.equal((await finalReload.list({ draftBatchId: currentBatch.draftBatchId })).length, 3);
    assert.equal(childSessions[1].dependsOnDraftSessionId, childSessions[0].draftSessionId);

    const staleBatch = await finalReload.markBatchChildrenStale(
        currentBatch.draftBatchId,
        currentBatch.version,
        0,
    );
    assert.deepEqual(staleBatch.children.map((child) => child.status), ['draft', 'stale', 'stale']);
    assert.equal(staleBatch.stateLedger.timeline.length, 0);
    assert.equal(staleBatch.stateLedger.stateDeltas.length, 0);

    const batchReload = new DraftSessionStore(() => tempRoot);
    const restoredBatch = await batchReload.getBatchById(batch.draftBatchId);
    assert.equal(restoredBatch?.status, 'stale');
    assert.equal(restoredBatch?.stateLedger.timeline.length, 0);
    assert.equal((await batchReload.getById(childSessions[1].draftSessionId))?.status, 'stale');
    assert.equal((await batchReload.listBatches({ novelId: 'novel-1' })).length, 1);

    const prepared = await batchReload.prepareBatchRegeneration(
        restoredBatch.draftBatchId,
        restoredBatch.version,
        1,
        'run-regenerate-1',
    );
    assert.equal(prepared.fromChildIndex, 1);
    assert.deepEqual(prepared.batch.children.map((child) => child.status), ['draft', 'pending', 'pending']);
    assert.deepEqual(prepared.batch.children.map((child) => child.generationRevision), [1, 2, 2]);
    assert.equal(prepared.batch.stateLedger.timeline.length, 0);
    assert.equal(prepared.batch.stateLedger.foreshadowing.length, 0);
    assert.equal(prepared.batch.stateLedger.stateDeltas.length, 0);
    assert.equal(prepared.batch.stateLedger.characterLocations['顾野'], undefined);
    assert.equal(prepared.batch.stateLedger.knowledgeState['顾野'], undefined);
    assert.equal(prepared.batch.stateLedger.itemStates['铜钥匙'], undefined);
    assert.equal(prepared.batch.stateLedger.relationshipChanges.length, 0);
    assert.deepEqual(prepared.batch.linkedRunIds, ['run-regenerate-1']);
    assert.deepEqual(prepared.preservedDrafts.map((session) => session.draftSessionId), [childSessions[0].draftSessionId]);

    const regeneratedSecond = await batchReload.createBatchChildSession(
        prepared.batch.draftBatchId,
        1,
        createChildInput(1),
        {
            title: '第四章',
            coreConflict: '重生成冲突 2',
            keyEvents: ['重生成事件 2'],
            reveals: ['重生成揭示 2'],
            endingHook: '重生成钩子 2',
            summary: '重生成摘要 2',
        },
        2,
    );
    await assert.rejects(
        () => batchReload.createBatchChildSession(
            regeneratedSecond.batch.draftBatchId,
            2,
            createChildInput(2),
            undefined,
            1,
        ),
        (error) => error?.code === 'VERSION_CONFLICT',
    );
    const failedThird = await batchReload.markBatchChildFailed({
        draftBatchId: regeneratedSecond.batch.draftBatchId,
        version: regeneratedSecond.batch.version,
        childIndex: 2,
        generationRevision: 2,
        error: { code: 'GENERATION_FAILED', message: 'provider rejected request' },
    });
    assert.equal(failedThird.status, 'partially_failed');
    assert.deepEqual(failedThird.children.map((child) => child.status), ['draft', 'draft', 'failed']);

    const preparedAgain = await batchReload.prepareBatchRegeneration(
        failedThird.draftBatchId,
        failedThird.version,
        undefined,
        'run-regenerate-2',
    );
    assert.equal(preparedAgain.fromChildIndex, 2);
    assert.equal(preparedAgain.batch.children[2].generationRevision, 3);
    assert.deepEqual(preparedAgain.preservedDrafts.map((session) => session.draftSessionId), [
        childSessions[0].draftSessionId,
        regeneratedSecond.session.draftSessionId,
    ]);

    const discarded = await batchReload.discardBatch(preparedAgain.batch.draftBatchId, preparedAgain.batch.version);
    assert.equal(discarded.status, 'discarded');
    assert.equal((await batchReload.getById(childSessions[0].draftSessionId))?.status, 'discarded');
    assert.equal((await batchReload.listBatches({ novelId: 'novel-1' })).length, 0);
    const inactiveBatches = await batchReload.listBatches({ novelId: 'novel-1', includeInactive: true });
    assert.equal(inactiveBatches.find((item) => item.draftBatchId === discarded.draftBatchId)?.status, 'discarded');
    assert.equal(inactiveBatches.find((item) => item.draftBatchId === rewriteBatch.draftBatchId)?.status, 'discarded');

    let commitBatch = await batchReload.createBatch({
        novelId: 'novel-1',
        volumeId: 'volume-1',
        anchorChapterId: 'chapter-1',
        mode: 'sequence_continuation',
        beats: [beat('提交第一章'), beat('提交第二章')],
        sourceSnapshot: [{ chapterId: 'chapter-1', version: 7, contentHash: 'hash-7' }],
    });
    commitBatch = await batchReload.approveBatchOutline(
        commitBatch.draftBatchId,
        commitBatch.version,
        commitBatch.outline.revision,
        'test-user',
    );
    const commitSessions = [];
    for (let index = 0; index < 2; index += 1) {
        const attached = await batchReload.createBatchChildSession(
            commitBatch.draftBatchId,
            index,
            createChildInput(index),
        );
        commitBatch = attached.batch;
        commitSessions.push(attached.session);
    }
    const firstPrefix = await batchReload.commitBatchPrefix(
        commitBatch.draftBatchId,
        commitBatch.version,
        1,
        'after_anchor',
        [{
            childIndex: 0,
            chapterId: 'created-chapter-1',
            volumeId: 'volume-1',
            title: '提交第一章',
            order: 2,
            version: 1,
            content: '第一章正式正文。',
        }],
    );
    assert.equal(firstPrefix.batch.status, 'ready_for_review');
    assert.deepEqual(firstPrefix.batch.children.map((child) => child.status), ['committed', 'draft']);
    assert.equal(firstPrefix.sessions[0].chapterId, 'created-chapter-1');
    assert.equal(firstPrefix.sessions[0].payload.content, '第一章正式正文。');
    await assert.rejects(
        () => batchReload.commitBatchPrefix(
            firstPrefix.batch.draftBatchId,
            firstPrefix.batch.version,
            1,
            'after_anchor',
            [],
        ),
        (error) => error?.code === 'INVALID_STATE',
    );
    const secondPrefix = await batchReload.commitBatchPrefix(
        firstPrefix.batch.draftBatchId,
        firstPrefix.batch.version,
        2,
        'after_anchor',
        [{
            childIndex: 1,
            chapterId: 'created-chapter-2',
            volumeId: 'volume-1',
            title: '提交第二章',
            order: 3,
            version: 1,
            content: '第二章正式正文。',
        }],
    );
    assert.equal(secondPrefix.batch.status, 'committed');
    assert.deepEqual(secondPrefix.batch.children.map((child) => child.status), ['committed', 'committed']);
    assert.equal((await batchReload.getById(commitSessions[1].draftSessionId))?.chapterId, 'created-chapter-2');

    let reversibleBatch = await batchReload.createBatch({
        novelId: 'novel-1',
        volumeId: 'volume-1',
        anchorChapterId: 'chapter-1',
        mode: 'batch_rewrite',
        beats: [beat('可撤销修订章')],
        targetChapterIds: ['chapter-1'],
        sourceSnapshot: [{ chapterId: 'chapter-1', version: 7, contentHash: 'old-content-hash' }],
    });
    reversibleBatch = await batchReload.approveBatchOutline(
        reversibleBatch.draftBatchId,
        reversibleBatch.version,
        reversibleBatch.outline.revision,
        'test-user',
    );
    const reversibleAttached = await batchReload.createBatchChildSession(
        reversibleBatch.draftBatchId,
        0,
        createChildInput(0),
    );
    reversibleBatch = reversibleAttached.batch;
    const committedAt = '2026-07-21T10:00:00.000Z';
    const writeback = {
        writebackId: 'writeback-1',
        mode: 'batch_rewrite',
        status: 'committed',
        committedAt,
        chapters: [{
            childIndex: 0,
            chapterId: 'chapter-1',
            volumeId: 'volume-1',
            title: '可撤销修订章',
            order: 1,
            beforeContent: '旧正文',
            beforeWordCount: 3,
            beforeVersion: 7,
            afterContentHash: 'new-content-hash',
            afterVersion: 8,
        }],
    };
    const reversibleCommitted = await batchReload.commitBatchPrefix(
        reversibleBatch.draftBatchId,
        reversibleBatch.version,
        1,
        undefined,
        [{
            childIndex: 0,
            chapterId: 'chapter-1',
            volumeId: 'volume-1',
            title: '可撤销修订章',
            order: 1,
            version: 8,
            content: '新正文',
        }],
        writeback,
    );
    assert.equal(reversibleCommitted.batch.writebacks?.[0].writebackId, 'writeback-1');
    const reversibleUndone = await batchReload.undoBatchWriteback(
        reversibleCommitted.batch.draftBatchId,
        reversibleCommitted.batch.version,
        'writeback-1',
        [{
            childIndex: 0,
            chapterId: 'chapter-1',
            volumeId: 'volume-1',
            title: '可撤销修订章',
            order: 1,
            version: 9,
            content: '旧正文',
        }],
    );
    assert.equal(reversibleUndone.batch.status, 'ready_for_review');
    assert.equal(reversibleUndone.batch.children[0].status, 'draft');
    assert.equal(reversibleUndone.batch.sourceSnapshot[0].version, 9);
    assert.equal(reversibleUndone.writeback.status, 'undone');
    assert.equal((await batchReload.getById(reversibleAttached.session.draftSessionId))?.status, 'draft');
    const writebackReload = new DraftSessionStore(() => tempRoot);
    assert.equal((await writebackReload.getBatchById(reversibleBatch.draftBatchId))?.writebacks?.[0].status, 'undone');

    let unknownBatch = await batchReload.createBatch({
        novelId: 'novel-1',
        volumeId: 'volume-1',
        anchorChapterId: 'chapter-1',
        mode: 'sequence_continuation',
        beats: [beat('未知结果章')],
    });
    unknownBatch = await batchReload.approveBatchOutline(
        unknownBatch.draftBatchId,
        unknownBatch.version,
        unknownBatch.outline.revision,
        'test-user',
    );
    unknownBatch = await batchReload.markBatchChildFailed({
        draftBatchId: unknownBatch.draftBatchId,
        version: unknownBatch.version,
        childIndex: 0,
        generationRevision: 1,
        error: {
            code: 'SIDE_EFFECT_UNKNOWN',
            message: 'request timed out',
            sideEffectUnknown: true,
            invocationKey: 'invocation-unknown-1',
            requestId: 'request-unknown-1',
            method: 'chapter.generate_draft',
        },
    });
    assert.equal(unknownBatch.children[0].reconciliation?.resolution, 'pending');
    assert.equal((await batchReload.inspectBatchReconciliation({
        draftBatchId: unknownBatch.draftBatchId,
        childIndex: 0,
        generationRevision: 1,
    })).candidates.length, 0);
    const orphanCandidate = await batchReload.create({
        ...createChildInput(0),
        draftBatchId: unknownBatch.draftBatchId,
        childIndex: 0,
        generationRevision: 1,
    });
    const candidateInspection = await batchReload.inspectBatchReconciliation({
        draftBatchId: unknownBatch.draftBatchId,
        childIndex: 0,
        generationRevision: 1,
    });
    assert.deepEqual(candidateInspection.candidates.map((item) => item.draftSessionId), [orphanCandidate.draftSessionId]);
    unknownBatch = await batchReload.reconcileBatchUnknown({
        draftBatchId: unknownBatch.draftBatchId,
        version: unknownBatch.version,
        childIndex: 0,
        generationRevision: 1,
        invocationKey: 'invocation-unknown-1',
        resolution: 'reconciled_succeeded',
        confirmation: true,
        candidateDraftSessionId: orphanCandidate.draftSessionId,
        note: 'matched exact batch child and generation revision',
    });
    assert.equal(unknownBatch.status, 'ready_for_review');
    assert.equal(unknownBatch.children[0].status, 'draft');
    assert.equal(unknownBatch.children[0].draftSessionId, orphanCandidate.draftSessionId);
    assert.equal(unknownBatch.children[0].reconciliation?.resolution, 'reconciled_succeeded');

    let absentBatch = await batchReload.createBatch({
        novelId: 'novel-1',
        volumeId: 'volume-1',
        anchorChapterId: 'chapter-1',
        mode: 'sequence_continuation',
        beats: [beat('确认未创建章')],
    });
    absentBatch = await batchReload.approveBatchOutline(
        absentBatch.draftBatchId,
        absentBatch.version,
        absentBatch.outline.revision,
        'test-user',
    );
    absentBatch = await batchReload.markBatchChildFailed({
        draftBatchId: absentBatch.draftBatchId,
        version: absentBatch.version,
        childIndex: 0,
        generationRevision: 1,
        error: {
            code: 'SIDE_EFFECT_UNKNOWN',
            message: 'connection lost',
            sideEffectUnknown: true,
            invocationKey: 'invocation-unknown-2',
            method: 'chapter.generate_draft',
        },
    });
    await assert.rejects(
        () => batchReload.prepareBatchRegeneration(absentBatch.draftBatchId, absentBatch.version, 0, 'blocked-run'),
        (error) => error?.code === 'SIDE_EFFECT_UNKNOWN',
    );
    absentBatch = await batchReload.reconcileBatchUnknown({
        draftBatchId: absentBatch.draftBatchId,
        version: absentBatch.version,
        childIndex: 0,
        generationRevision: 1,
        invocationKey: 'invocation-unknown-2',
        resolution: 'reconciled_absent',
        confirmation: true,
    });
    assert.equal(absentBatch.children[0].error?.sideEffectUnknown, undefined);
    assert.equal(absentBatch.children[0].reconciliation?.resolution, 'reconciled_absent');
    const afterAbsentRegeneration = await batchReload.prepareBatchRegeneration(
        absentBatch.draftBatchId,
        absentBatch.version,
        0,
        'allowed-run',
    );
    assert.equal(afterAbsentRegeneration.batch.children[0].status, 'pending');
    assert.equal(afterAbsentRegeneration.batch.children[0].generationRevision, 2);
    assert.equal(afterAbsentRegeneration.batch.children[0].reconciliation, undefined);

    const persisted = JSON.parse(await fs.readFile(path.join(tempRoot, 'automation', 'draft-sessions.json'), 'utf8'));
    assert.ok(Array.isArray(persisted.sessions));
    assert.ok(Array.isArray(persisted.batches));
    console.log('Draft session and draft batch persistence/recovery tests passed.');
} finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
}
