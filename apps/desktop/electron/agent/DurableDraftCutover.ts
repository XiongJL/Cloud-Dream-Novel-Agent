import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DURABLE_DRAFT_CUTOVER_VERSION = 2;

type DeleteManyDelegate = {
    deleteMany: () => Promise<{ count: number }>;
};

type CutoverTransaction = {
    draftOperationOutbox: DeleteManyDelegate;
    draftGenerationAttempt: DeleteManyDelegate;
    draftGenerationOperation: DeleteManyDelegate;
    draftBatchChild: DeleteManyDelegate;
    draftSession: DeleteManyDelegate;
    draftBatch: DeleteManyDelegate;
    agentRunEvent: DeleteManyDelegate;
    agentArtifact: DeleteManyDelegate;
    agentRun: DeleteManyDelegate;
    agentAttachment: DeleteManyDelegate;
    agentMessage: DeleteManyDelegate;
    agentConversation: DeleteManyDelegate;
    agentRevisionTask: DeleteManyDelegate;
    $executeRawUnsafe: (query: string) => Promise<number>;
};

type CutoverDatabase = {
    $transaction: <T>(callback: (transaction: CutoverTransaction) => Promise<T>) => Promise<T>;
    $queryRawUnsafe: <T>(query: string) => Promise<T>;
};

export type DurableDraftCutoverResult = {
    applied: boolean;
    version: number;
    deletedRows: Record<string, number>;
};

function resolveProtectedChild(root: string, ...segments: string[]): string {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, ...segments);
    if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Refusing to delete path outside user data: ${target}`);
    }
    return target;
}

type ProtectedContentSnapshot = {
    novelCount: string;
    volumeCount: string;
    chapterCount: string;
    chapterContentHash: string;
};

async function protectedContentSnapshot(database: CutoverDatabase): Promise<ProtectedContentSnapshot> {
    const counts = await database.$queryRawUnsafe<Array<{
        novelCount: number | bigint;
        volumeCount: number | bigint;
        chapterCount: number | bigint;
    }>>(`
        SELECT
            (SELECT COUNT(*) FROM Novel) AS novelCount,
            (SELECT COUNT(*) FROM Volume) AS volumeCount,
            (SELECT COUNT(*) FROM Chapter) AS chapterCount
    `);
    const chapters = await database.$queryRawUnsafe<Array<{
        id: string;
        content: string;
        deleted: number | boolean;
    }>>('SELECT id, content, deleted FROM Chapter ORDER BY id ASC');
    const count = counts[0] ?? { novelCount: 0, volumeCount: 0, chapterCount: 0 };
    const chapterContentHash = createHash('sha256')
        .update(JSON.stringify(chapters.map((chapter) => [
            chapter.id,
            chapter.content,
            Boolean(chapter.deleted),
        ])))
        .digest('hex');
    return {
        novelCount: String(count.novelCount),
        volumeCount: String(count.volumeCount),
        chapterCount: String(count.chapterCount),
        chapterContentHash,
    };
}

async function readCompletedVersion(markerPath: string): Promise<number> {
    try {
        const parsed = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { version?: unknown };
        return typeof parsed.version === 'number' ? parsed.version : 0;
    } catch (error: any) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return 0;
        throw error;
    }
}

export async function applyDurableDraftCutover(
    userDataPath: string,
    database: CutoverDatabase,
): Promise<DurableDraftCutoverResult> {
    const automationDir = resolveProtectedChild(userDataPath, 'automation');
    const markerPath = resolveProtectedChild(automationDir, `durable-draft-cutover-v${DURABLE_DRAFT_CUTOVER_VERSION}.json`);
    if (await readCompletedVersion(markerPath) >= DURABLE_DRAFT_CUTOVER_VERSION) {
        return { applied: false, version: DURABLE_DRAFT_CUTOVER_VERSION, deletedRows: {} };
    }

    const protectedBefore = await protectedContentSnapshot(database);

    const agentRuntimeDir = resolveProtectedChild(userDataPath, 'agent');
    const legacyDraftPath = resolveProtectedChild(automationDir, 'draft-sessions.json');
    const legacyReviewPath = resolveProtectedChild(automationDir, 'review-comments.json');
    await fs.rm(agentRuntimeDir, { recursive: true, force: true });
    await fs.rm(legacyDraftPath, { force: true });
    await fs.rm(legacyReviewPath, { force: true });

    const deletedRows = await database.$transaction(async (transaction) => {
        const delegates: Array<[string, DeleteManyDelegate]> = [
            ['draftOperationOutbox', transaction.draftOperationOutbox],
            ['draftGenerationAttempt', transaction.draftGenerationAttempt],
            ['draftGenerationOperation', transaction.draftGenerationOperation],
            ['draftBatchChild', transaction.draftBatchChild],
            ['draftSession', transaction.draftSession],
            ['draftBatch', transaction.draftBatch],
            ['agentRunEvent', transaction.agentRunEvent],
            ['agentArtifact', transaction.agentArtifact],
            ['agentRun', transaction.agentRun],
            ['agentAttachment', transaction.agentAttachment],
            ['agentMessage', transaction.agentMessage],
            ['agentConversation', transaction.agentConversation],
            ['agentRevisionTask', transaction.agentRevisionTask],
        ];
        const counts: Record<string, number> = {};
        for (const [name, delegate] of delegates) {
            counts[name] = (await delegate.deleteMany()).count;
        }
        await transaction.$executeRawUnsafe('DROP TABLE IF EXISTS "DraftWorkspaceState"');
        counts.draftWorkspaceState = 0;
        return counts;
    });

    const protectedAfter = await protectedContentSnapshot(database);
    if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)) {
        throw new Error('Durable draft cutover changed protected Novel/Volume/Chapter data');
    }

    await fs.mkdir(automationDir, { recursive: true });
    const temporaryMarker = `${markerPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryMarker, JSON.stringify({
        version: DURABLE_DRAFT_CUTOVER_VERSION,
        completedAt: new Date().toISOString(),
        deletedRows,
        protectedContentSnapshot: protectedAfter,
        preservedDomains: ['Novel', 'Volume', 'Chapter'],
    }, null, 2), 'utf8');
    await fs.rename(temporaryMarker, markerPath);

    return { applied: true, version: DURABLE_DRAFT_CUTOVER_VERSION, deletedRows };
}
