export type ReviewCommentAnchorKind =
    | 'paragraph'
    | 'text_range'
    | 'diff_hunk'
    | 'asset_item'
    | 'chapter'
    | 'finding';

export type ReviewCommentStatus = 'local_draft' | 'sent' | 'superseded';
export type ReviewCommentSentMode = 'discuss' | 'regenerate';

export interface ReviewCommentAnchor {
    kind: ReviewCommentAnchorKind;
    targetId: string;
    diffVersion?: number;
    paragraphIndex?: number;
    diffHunkId?: string;
    oldStartLine?: number;
    oldEndLine?: number;
    newStartLine?: number;
    newEndLine?: number;
    side?: 'old' | 'new' | 'both';
    fieldPath?: string;
    startOffset?: number;
    endOffset?: number;
    quote?: string;
    contentHash?: string;
}

export interface ReviewCommentRecord {
    commentId: string;
    novelId: string;
    sourceConversationId: string;
    sourceRunId: string;
    sourceArtifactId?: string;
    reviewVersionId: string;
    draftSessionId?: string;
    draftBatchId?: string;
    childIndex?: number;
    anchor: ReviewCommentAnchor;
    body: string;
    status: ReviewCommentStatus;
    sentMode?: ReviewCommentSentMode;
    createdAt: string;
    updatedAt: string;
    sentAt?: string;
}

export interface ReviewCommentListFilters {
    novelId?: string;
    sourceConversationId?: string;
    reviewVersionId?: string;
    reviewVersionIds?: string[];
    status?: ReviewCommentStatus;
}

export interface ReviewCommentSaveInput {
    commentId?: string;
    novelId: string;
    sourceConversationId: string;
    sourceRunId: string;
    sourceArtifactId?: string;
    reviewVersionId: string;
    draftSessionId?: string;
    draftBatchId?: string;
    childIndex?: number;
    anchor: ReviewCommentAnchor;
    body: string;
}

export interface ReviewCommentDeleteInput {
    commentId: string;
}

export interface ReviewCommentMarkSentInput {
    commentIds: string[];
    mode: ReviewCommentSentMode;
}

export interface ReviewCommentContext {
    novelId: string;
    sourceConversationId: string;
    sourceRunId: string;
    sourceArtifactId?: string;
    reviewVersionId: string;
    draftSessionId?: string;
    draftBatchId?: string;
    childIndex?: number;
}

export function activeReviewComments(comments: ReviewCommentRecord[]): ReviewCommentRecord[] {
    return comments.filter((comment) => comment.status !== 'superseded');
}

export function pendingReviewComments(comments: ReviewCommentRecord[]): ReviewCommentRecord[] {
    return comments.filter((comment) => comment.status === 'local_draft');
}

export function unresolvedReviewComments(comments: ReviewCommentRecord[]): ReviewCommentRecord[] {
    return comments.filter((comment) => (
        comment.status === 'local_draft'
        || (comment.status === 'sent' && comment.sentMode === 'discuss')
    ));
}

export function formatReviewCommentsForConversation(comments: ReviewCommentRecord[]): string {
    const lines = comments.map((comment, index) => {
        const anchorLocation = comment.anchor.kind === 'paragraph' && typeof comment.anchor.paragraphIndex === 'number'
            ? `第 ${comment.anchor.paragraphIndex + 1} 段`
            : comment.anchor.quote
                ? `“${comment.anchor.quote.slice(0, 48)}${comment.anchor.quote.length > 48 ? '...' : ''}”`
                : comment.anchor.targetId;
        const location = typeof comment.childIndex === 'number'
            ? `批次第 ${comment.childIndex + 1} 章 · ${anchorLocation}`
            : anchorLocation;
        return `${index + 1}. ${location}：${comment.body}`;
    });
    return ['审批意见：', ...lines].join('\n');
}
