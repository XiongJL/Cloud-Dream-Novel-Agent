export type AgentAttachmentBlockType = 'heading' | 'paragraph' | 'list_item' | 'table' | 'page_break';

export type AgentAttachmentBlock = {
    blockId: string;
    type: AgentAttachmentBlockType;
    text: string;
    page?: number;
    headingPath?: string[];
    startOffset: number;
    endOffset: number;
};

export type AgentAttachmentWarning = {
    code: string;
    message: string;
};

export type ExtractedDocument = {
    title?: string;
    plainText: string;
    blocks: AgentAttachmentBlock[];
    metadata: {
        pageCount?: number;
        author?: string;
        language?: string;
        encoding?: string;
        warnings: AgentAttachmentWarning[];
    };
};

export type AgentAttachmentRecord = {
    id: string;
    novelId: string;
    conversationId: string;
    messageId?: string | null;
    originalFileName: string;
    extension: string;
    mimeType?: string | null;
    sizeBytes: number;
    characterCount: number;
    contentHash: string;
    extractorVersion: string;
    status: 'ready' | 'failed';
    errorCode?: string | null;
    errorMessage?: string | null;
    title?: string | null;
    pageCount?: number | null;
    warnings: AgentAttachmentWarning[];
    createdAt: string;
    updatedAt: string;
};

export type AgentAttachmentContent = AgentAttachmentRecord & {
    plainText: string;
    blocks: AgentAttachmentBlock[];
};

export type AgentAttachmentWindow = {
    attachmentId: string;
    originalFileName: string;
    offset: number;
    limit: number;
    totalCharacters: number;
    text: string;
    nextOffset: number | null;
    blockIds: string[];
    warnings: AgentAttachmentWarning[];
};

export type AgentAttachmentReadSelector =
    | { kind: 'section'; title: string; occurrence?: number; includeSubsections?: boolean }
    | { kind: 'offset_range'; startOffset: number; endOffset: number }
    | { kind: 'page_range'; startPage: number; endPage: number }
    | { kind: 'block_range'; startBlockId: string; endBlockId?: string };

export type AgentAttachmentReadResult = {
    attachmentId: string;
    originalFileName: string;
    status: 'resolved' | 'ambiguous' | 'not_found';
    selector: AgentAttachmentReadSelector;
    actualRange?: { startOffset: number; endOffset: number };
    totalCharacters: number;
    text: string;
    truncated: boolean;
    nextSelector: AgentAttachmentReadSelector | null;
    blockIds: string[];
    pages: number[];
    headings: string[];
    candidates: Array<{
        title: string;
        startOffset: number;
        endOffset: number;
        blockId?: string;
        page?: number;
    }>;
    warnings: AgentAttachmentWarning[];
};

export type AgentAttachmentOutline = {
    attachmentId: string;
    originalFileName: string;
    totalCharacters: number;
    pageCount?: number | null;
    entries: Array<{
        blockId: string;
        type: AgentAttachmentBlockType;
        text: string;
        page?: number;
        headingPath?: string[];
        startOffset: number;
        endOffset: number;
    }>;
    warnings: AgentAttachmentWarning[];
};

export type AgentAttachmentSearchResult = {
    query: string;
    searchedAttachmentCount: number;
    hasMore: boolean;
    matches: Array<{
        attachmentId: string;
        originalFileName: string;
        blockId?: string;
        page?: number;
        headingPath?: string[];
        startOffset: number;
        endOffset: number;
        snippetStartOffset: number;
        snippetEndOffset: number;
        snippet: string;
    }>;
};
