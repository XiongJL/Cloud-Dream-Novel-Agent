import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
    ReviewCommentListFilters,
    ReviewCommentMarkSentInput,
    ReviewCommentRecord,
    ReviewCommentSaveInput,
} from '../../shared/reviewComments';

type ReviewCommentFileShape = {
    comments: ReviewCommentRecord[];
};

const EMPTY_STORE: ReviewCommentFileShape = { comments: [] };

function storeError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

function required(value: unknown, name: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) throw storeError('INVALID_INPUT', `${name} is required`);
    return normalized;
}

export class ReviewCommentStore {
    private readonly getUserDataPath: () => string;
    private cache: ReviewCommentFileShape | null = null;
    private mutationTail: Promise<void> = Promise.resolve();

    constructor(getUserDataPath: () => string) {
        this.getUserDataPath = getUserDataPath;
    }

    private getStoreDir(): string {
        return path.join(this.getUserDataPath(), 'automation');
    }

    private getStorePath(): string {
        return path.join(this.getStoreDir(), 'review-comments.json');
    }

    private async ensureLoaded(): Promise<void> {
        if (this.cache) return;
        try {
            const parsed = JSON.parse(await fs.readFile(this.getStorePath(), 'utf8')) as Partial<ReviewCommentFileShape>;
            this.cache = { comments: Array.isArray(parsed.comments) ? parsed.comments : [] };
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
            this.cache = { comments: [] };
        }
    }

    private async flush(): Promise<void> {
        await fs.mkdir(this.getStoreDir(), { recursive: true });
        const target = this.getStorePath();
        const temporary = `${target}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(this.cache ?? EMPTY_STORE, null, 2), 'utf8');
        await fs.rename(temporary, target);
    }

    private async mutate<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.mutationTail;
        let release!: () => void;
        this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
            await this.ensureLoaded();
            return await operation();
        } finally {
            release();
        }
    }

    async list(filters?: ReviewCommentListFilters): Promise<ReviewCommentRecord[]> {
        await this.ensureLoaded();
        const reviewVersionIds = new Set(
            (filters?.reviewVersionIds ?? []).map((value) => String(value || '').trim()).filter(Boolean),
        );
        return [...(this.cache?.comments ?? [])]
            .filter((comment) => {
                if (filters?.novelId && comment.novelId !== filters.novelId) return false;
                if (filters?.sourceConversationId && comment.sourceConversationId !== filters.sourceConversationId) return false;
                if (filters?.reviewVersionId && comment.reviewVersionId !== filters.reviewVersionId) return false;
                if (reviewVersionIds.size && !reviewVersionIds.has(comment.reviewVersionId)) return false;
                if (filters?.status && comment.status !== filters.status) return false;
                return true;
            })
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    async save(input: ReviewCommentSaveInput): Promise<ReviewCommentRecord> {
        return this.mutate(async () => {
            const novelId = required(input?.novelId, 'novelId');
            const sourceConversationId = required(input?.sourceConversationId, 'sourceConversationId');
            const sourceRunId = required(input?.sourceRunId, 'sourceRunId');
            const reviewVersionId = required(input?.reviewVersionId, 'reviewVersionId');
            const body = required(input?.body, 'body');
            const targetId = required(input?.anchor?.targetId, 'anchor.targetId');
            if (body.length > 4000) throw storeError('INVALID_INPUT', 'Review comment must not exceed 4000 characters');
            const now = new Date().toISOString();
            const comments = this.cache?.comments ?? [];
            const requestedId = String(input?.commentId || '').trim();
            const index = requestedId ? comments.findIndex((comment) => comment.commentId === requestedId) : -1;
            if (requestedId && index < 0) throw storeError('NOT_FOUND', 'Review comment not found');
            const current = index >= 0 ? comments[index] : null;
            if (current && current.status === 'superseded') {
                throw storeError('INVALID_STATE', 'Superseded review comments cannot be edited');
            }
            if (current && current.reviewVersionId !== reviewVersionId) {
                throw storeError('VERSION_CONFLICT', 'Review comment belongs to another review version');
            }
            const record: ReviewCommentRecord = {
                commentId: current?.commentId ?? randomUUID(),
                novelId,
                sourceConversationId,
                sourceRunId,
                ...(input.sourceArtifactId ? { sourceArtifactId: String(input.sourceArtifactId) } : {}),
                reviewVersionId,
                ...(input.draftSessionId ? { draftSessionId: String(input.draftSessionId) } : {}),
                ...(input.draftBatchId ? { draftBatchId: String(input.draftBatchId) } : {}),
                ...(Number.isInteger(input.childIndex) ? { childIndex: input.childIndex } : {}),
                anchor: { ...input.anchor, targetId },
                body,
                status: 'local_draft',
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
            };
            if (index >= 0) comments[index] = record;
            else comments.push(record);
            this.cache = { comments };
            await this.flush();
            return record;
        });
    }

    async delete(commentIdInput: string): Promise<{ commentId: string }> {
        return this.mutate(async () => {
            const commentId = required(commentIdInput, 'commentId');
            const comments = this.cache?.comments ?? [];
            const next = comments.filter((comment) => comment.commentId !== commentId);
            if (next.length === comments.length) throw storeError('NOT_FOUND', 'Review comment not found');
            this.cache = { comments: next };
            await this.flush();
            return { commentId };
        });
    }

    async markSent(input: ReviewCommentMarkSentInput): Promise<ReviewCommentRecord[]> {
        return this.mutate(async () => {
            if (!['discuss', 'regenerate'].includes(input?.mode)) {
                throw storeError('INVALID_INPUT', 'mode must be discuss or regenerate');
            }
            const ids = new Set((input?.commentIds ?? []).map((value) => String(value || '').trim()).filter(Boolean));
            if (!ids.size) throw storeError('INVALID_INPUT', 'commentIds is required');
            const comments = this.cache?.comments ?? [];
            const found = comments.filter((comment) => ids.has(comment.commentId));
            if (found.length !== ids.size) throw storeError('NOT_FOUND', 'One or more review comments were not found');
            const conversations = new Set(found.map((comment) => `${comment.novelId}:${comment.sourceConversationId}`));
            if (conversations.size !== 1) {
                throw storeError('INVALID_INPUT', 'Review comments must belong to one source conversation');
            }
            const now = new Date().toISOString();
            const updated = comments.map((comment) => ids.has(comment.commentId) ? {
                ...comment,
                status: 'sent' as const,
                sentMode: input.mode,
                sentAt: now,
                updatedAt: now,
            } : comment);
            this.cache = { comments: updated };
            await this.flush();
            return updated.filter((comment) => ids.has(comment.commentId));
        });
    }
}
