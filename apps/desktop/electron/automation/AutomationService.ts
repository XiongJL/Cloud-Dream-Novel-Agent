import { createHash, randomUUID } from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import type { CreativeAssetsDraft, CreativeAssetsDraftValidationResult, CreativeAssetsGeneratePayload, PromptPreviewResult } from '../ai/types';
import { db } from '@novel-editor/core';
import { AiService } from '../ai/AiService';
import * as searchIndex from '../search/searchIndex';
import { scheduleChapterSummaryRebuild } from '../ai/summary/chapterSummary';
import { devLog, devLogError, redactForLog } from '../debug/devLogger';
import {
    DraftSessionStore,
    type PreparedChapterDraft,
} from './DraftSessionStore';
import {
    canonicalDraftOperationJson,
    DraftOperationStore,
    hashDraftOperationParams,
} from './DraftOperationStore';
import { DraftOperationCoordinator } from './DraftOperationCoordinator';
import type { DraftOperationResultRef } from '../../shared/draftOperation';
import { ReviewCommentStore } from './ReviewCommentStore';
import type {
    AutomationInvokeContext,
    ChapterDraftPayload,
    CreativeDraftSelection,
    DraftCommitResponse,
    DraftBatchCommitPrefixInput,
    DraftBatchCommitPrefixResponse,
    DraftBatchCreateInput,
    DraftBatchInspectReconciliationInput,
    DraftBatchListFilters,
    DraftBatchMarkFailedInput,
    DraftBatchPrepareRegenerationInput,
    DraftBatchPrepareRegenerationResponse,
    DraftBatchReconcileUnknownInput,
    DraftBatchReconciliationInspection,
    DraftBatchRecord,
    DraftBatchUndoInput,
    DraftListFilters,
    DraftSessionRecord,
    DraftUndoResponse,
    PromptPreviewResponse,
} from './types';
import {
    appendPlainTextToLexical,
    createLexicalDocumentFromPlainText,
    ensureLexicalDocument,
    extractReadableText,
    normalizeChapterDraftText,
} from '../../shared/lexicalDocument';
import type { ChapterBeatInput, NarrativeStateDelta } from '../../shared/draftBatch';
import { commitDraftBatchChapters, undoDraftBatchWriteback } from './DraftBatchCommitter';
import { undoCreativeAssetsWriteback } from './CreativeAssetsWriteback';
import { AgentReviewStore } from '../agent/AgentReviewStore';
import type {
    ArtifactReviewSubmitInput,
    RevisionTaskCreatePlanInput,
    RevisionTaskCreatePlanResult,
    RevisionTaskListFilters,
} from '../../shared/expertReport';
import type {
    ReviewCommentDeleteInput,
    ReviewCommentListFilters,
    ReviewCommentMarkSentInput,
    ReviewCommentRecord,
    ReviewCommentSaveInput,
} from '../../shared/reviewComments';
import { AgentAttachmentStore } from '../agent/AgentAttachmentStore';
import { AgentModelResultStore } from './AgentModelResultStore';
import { getAgentStructuredOutputContract, validateAgentStructuredOutput } from './AgentStructuredOutputContracts';
import { parseRepairableJsonObject } from '../../shared/agentJson';
import { AgentSkillStore } from '../agentSkills/AgentSkillStore';

const EMPTY_CREATIVE_DRAFT: CreativeAssetsDraft = {
    plotLines: [],
    plotPoints: [],
    characters: [],
    items: [],
    skills: [],
    worldSettings: [],
    maps: [],
};

const AUTOMATION_TIMEOUT_MS: Record<string, number> = {
    'novel.list': 15000,
    'volume.list': 15000,
    'chapter.list': 15000,
    'chapter.get': 15000,
    'attachment.list': 15000,
    'attachment.get': 15000,
    'attachment.read': 15000,
    'attachment.outline': 15000,
    'attachment.search': 15000,
    'chapter.scope_context.build': 60000,
    'plotline.list': 15000,
    'character.list': 15000,
    'item.list': 15000,
    'worldsetting.list': 15000,
    'worldsetting.create': 30000,
    'worldsetting.update': 30000,
    'map.list': 15000,
    'search.query': 15000,
    'rag.ask': 90000,
    'rag.preview': 30000,
    'rag.rebuild_index': 180000,
    // One normal generation (up to 145s) plus one bounded JSON repair (up to 120s).
    'agent.generate_chat': 300000,
    'agent.generate_plan': 150000,
    'agent.summarize_user_input': 90000,
    'agent.generate_user_input_followup': 120000,
    'agent.revise_plan': 150000,
    'agent.generate_report': 210000,
    'agent.generate_consistency_review': 240000,
    'agent.generate_novel_bootstrap': 240000,
    'agent.generate_style_skill_pack': 420000,
    'agent.generate_skill_draft': 240000,
    'agent.generate_editor_range_review': 240000,
    'agent.generate_writer_range_revision_plan': 240000,
    'agent.generate_reader_chapter_evaluation': 240000,
    'agent.generate_worldbuilding_range_consistency': 240000,
    'agent.extract_research_claims': 240000,
    'agent.generate_research_fact_check': 240000,
    'agent.generate_scope_audit': 240000,
    'agent.generate_plotline_analysis': 240000,
    'agent.detect_creative_direction': 150000,
    'agent.generate_chapter_beats': 180000,
    'agent.repair_structured_output': 180000,
    'agent.reprocess_saved_structured_output': 30000,
    'agent_skill.list': 15000,
    'agent_skill.get': 15000,
    'agent_skill.binding.list': 15000,
    'agent_skill.draft.list': 15000,
    'agent_skill.draft.get': 15000,
    'agent_skill.draft.upsert': 30000,
    'agent_skill.draft.commit': 30000,
    'agent_skill.draft.discard': 15000,
    'artifact.review.submit': 30000,
    'review.comment.list': 15000,
    'review.comment.save': 15000,
    'review.comment.delete': 15000,
    'review.comment.mark_sent': 15000,
    'revision_task.list': 15000,
    'revision_task.create_plan': 150000,
    'revision_task.update_status': 15000,
    'revision_task.sync_run': 15000,
    'draft.list': 15000,
    'draft.get': 15000,
    'draft.get_active': 15000,
    'draft.update': 15000,
    'draft.commit': 30000,
    'draft.undo': 30000,
    'draft.discard': 15000,
    'draft.batch.list': 15000,
    'draft.batch.get': 15000,
    'draft.batch.create': 15000,
    'draft.batch.update_outline': 15000,
    'draft.batch.approve_outline': 15000,
    'draft.batch.attach_child': 15000,
    'draft.batch.mark_stale_after': 15000,
    'draft.batch.prepare_regeneration': 15000,
    'draft.batch.mark_failed': 15000,
    'draft.batch.inspect_reconciliation': 15000,
    'draft.batch.reconcile_unknown': 15000,
    'draft.batch.commit_prefix': 60000,
    'draft.batch.undo': 60000,
    'draft.batch.discard': 15000,
    'outline.write': 30000,
    'character.create_batch': 30000,
    'story_patch.apply': 30000,
    'chapter.create': 30000,
    'chapter.save': 30000,
    'prompt.preview': 30000,
    'creative_assets.validate_draft': 30000,
    'creative_assets.generate_draft': 210000,
    'creative_assets.revise_draft': 300000,
    'outline.generate_draft': 210000,
    'chapter.draft.start': 15000,
    'chapter.draft.get_status': 15000,
    'chapter.draft.cancel': 15000,
    'chapter.draft.retry': 15000,
    'chapter.revise_draft': 360000,
    'chapter.continuation_context.build': 90000,
};
const DEFAULT_AUTOMATION_TIMEOUT_MS = 30000;

type NormalizedPromptPreviewKind = 'creative_assets' | 'chapter';

function createSelectionFromDraft(draft: CreativeAssetsDraft): CreativeDraftSelection {
    return {
        plotLines: (draft.plotLines ?? []).map(() => true),
        plotPoints: (draft.plotPoints ?? []).map(() => true),
        characters: (draft.characters ?? []).map(() => true),
        items: (draft.items ?? []).map(() => true),
        skills: (draft.skills ?? []).map(() => true),
        worldSettings: (draft.worldSettings ?? []).map(() => true),
        maps: (draft.maps ?? []).map(() => true),
    };
}

function normalizeCreativeDraft(input: unknown): CreativeAssetsDraft {
    if (!input || typeof input !== 'object') return { ...EMPTY_CREATIVE_DRAFT };
    const draft = input as CreativeAssetsDraft;
    return {
        plotLines: Array.isArray(draft.plotLines) ? draft.plotLines : [],
        plotPoints: Array.isArray(draft.plotPoints) ? draft.plotPoints : [],
        characters: Array.isArray(draft.characters) ? draft.characters : [],
        items: Array.isArray(draft.items) ? draft.items : [],
        skills: Array.isArray(draft.skills) ? draft.skills : [],
        worldSettings: Array.isArray(draft.worldSettings) ? draft.worldSettings : [],
        maps: Array.isArray(draft.maps) ? draft.maps : [],
    };
}

function summarizeCreativeDraft(draft: CreativeAssetsDraft): string {
    const parts = [
        `主线 ${(draft.plotLines?.length ?? 0)}`,
        `要点 ${(draft.plotPoints?.length ?? 0)}`,
        `角色 ${(draft.characters?.length ?? 0)}`,
        `物品 ${(draft.items?.length ?? 0)}`,
        `技能 ${(draft.skills?.length ?? 0)}`,
        `设定 ${(draft.worldSettings?.length ?? 0)}`,
        `地图 ${(draft.maps?.length ?? 0)}`,
    ];
    return parts.join(' / ');
}

function sanitizeGeneratedDraft(draft: CreativeAssetsDraft): CreativeAssetsDraft {
    const keepNonEmpty = <T extends Record<string, any>>(items: T[] | undefined, requiredKey: keyof T): T[] => {
        const list = Array.isArray(items) ? items : [];
        return list.filter((item) => typeof item === 'object' && item && String(item[requiredKey] || '').trim());
    };
    return {
        plotLines: keepNonEmpty(draft.plotLines, 'name'),
        plotPoints: keepNonEmpty(draft.plotPoints, 'title'),
        characters: keepNonEmpty(draft.characters, 'name'),
        items: keepNonEmpty(draft.items, 'name'),
        skills: keepNonEmpty(draft.skills, 'name'),
        worldSettings: keepNonEmpty(draft.worldSettings, 'name'),
        maps: keepNonEmpty(draft.maps, 'name'),
    };
}

function pickSelectedCreativeDraft(draft: CreativeAssetsDraft, selection?: CreativeDraftSelection): CreativeAssetsDraft {
    if (!selection) return normalizeCreativeDraft(draft);
    return {
        plotLines: (draft.plotLines ?? []).filter((_, index) => selection.plotLines[index]),
        plotPoints: (draft.plotPoints ?? []).filter((_, index) => selection.plotPoints[index]),
        characters: (draft.characters ?? []).filter((_, index) => selection.characters[index]),
        items: (draft.items ?? []).filter((_, index) => selection.items[index]),
        skills: (draft.skills ?? []).filter((_, index) => selection.skills[index]),
        worldSettings: (draft.worldSettings ?? []).filter((_, index) => selection.worldSettings[index]),
        maps: (draft.maps ?? []).filter((_, index) => selection.maps[index]),
    };
}

function buildOutlineDraft(input: { plotLines?: unknown; plotPoints?: unknown }): CreativeAssetsDraft {
    return normalizeCreativeDraft({
        plotLines: input.plotLines,
        plotPoints: input.plotPoints,
    });
}

function buildCharacterBatchDraft(input: { characters?: unknown; items?: unknown; skills?: unknown }): CreativeAssetsDraft {
    return normalizeCreativeDraft({
        characters: input.characters,
        items: input.items,
        skills: input.skills,
    });
}

function createAutomationError(code: string, message: string, details?: unknown): Error & { code: string; details?: unknown } {
    return Object.assign(new Error(message), { code, details });
}

function assertRequiredString(value: unknown, field: string): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
        throw createAutomationError('INVALID_INPUT', `${field} is required`);
    }
    return text;
}

function assertRequiredNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw createAutomationError('INVALID_INPUT', `${field} must be a finite number`);
    }
    return value;
}

function resolveAutomationTimeout(method: string): number {
    return AUTOMATION_TIMEOUT_MS[method] ?? DEFAULT_AUTOMATION_TIMEOUT_MS;
}

function normalizePromptPreviewKind(kind: unknown): NormalizedPromptPreviewKind {
    const normalized = String(kind || '').trim().toLowerCase();
    if (['creative_assets', 'creative-assets', 'outline-generate', 'outline_generate', 'outline'].includes(normalized)) {
        return 'creative_assets';
    }
    if (['chapter', 'chapter-generate', 'chapter_generate', 'continue-writing', 'continue_writing'].includes(normalized)) {
        return 'chapter';
    }
    throw createAutomationError('INVALID_INPUT', `Unsupported prompt preview kind: ${String(kind || '')}`);
}

type ChapterDraftGenerationPayload = {
    novelId: string;
    chapterId: string;
    currentContent: string;
    presentation?: 'silent' | 'toast' | 'modal';
    locale?: string;
    mode?: 'new_chapter' | 'continue_chapter' | 'rewrite_chapter';
    ideaIds?: string[];
    contextChapterCount?: number;
    recentRawChapterCount?: number;
    targetLength?: number;
    style?: string;
    tone?: string;
    pace?: string;
    temperature?: number;
    userIntent?: string;
    currentLocation?: string;
    overrideUserPrompt?: string;
    preparedContext?: import('../ai/context/ContextBuilder').ContinueWritingContext;
    sourceOperationId?: string;
    draftBatchId?: string;
    childIndex?: number;
    generationRevision?: number;
    batchTitle?: string;
    batchContext?: Record<string, unknown>;
    batchMode?: 'sequence_continuation' | 'batch_rewrite';
    targetChapterId?: string;
};

export class AutomationService {
    private readonly aiService: AiService;
    private readonly draftStore: DraftSessionStore;
    private readonly draftOperationStore: DraftOperationStore;
    private readonly draftOperationCoordinator: DraftOperationCoordinator;
    private readonly reviewStore: AgentReviewStore;
    private readonly reviewCommentStore: ReviewCommentStore;
    private readonly attachmentStore: AgentAttachmentStore;
    private readonly modelResultStore: AgentModelResultStore;
    private readonly agentSkillStore: AgentSkillStore;
    private draftBatchCommitTail: Promise<void> = Promise.resolve();

    constructor(
        aiService: AiService,
        getUserDataPath: () => string,
        attachmentStore = new AgentAttachmentStore(db),
        deliverDraftCompletion?: (event: {
            outboxId: string;
            operationId: string;
            eventType: string;
            payload: Record<string, unknown>;
        }) => Promise<void>,
    ) {
        this.aiService = aiService;
        this.modelResultStore = new AgentModelResultStore(db);
        this.agentSkillStore = new AgentSkillStore(db);
        this.draftStore = new DraftSessionStore(db);
        this.draftOperationStore = new DraftOperationStore(db);
        this.draftOperationCoordinator = new DraftOperationCoordinator(this.draftOperationStore, {
            execute: async (operation, payload, signal) => {
                return this.createChapterDraftSession({
                    ...payload,
                    sourceOperationId: operation.operationId,
                } as Parameters<AutomationService['createChapterDraftSession']>[0], {
                    source: 'http',
                    origin: 'desktop-ui',
                    requestId: `draft-operation:${operation.operationId}:${operation.attemptCount}`,
                    deadlineAt: operation.operationDeadlineAt,
                    onProviderActivity: (kind) => {
                        void this.draftOperationStore.markAttemptActivity(
                            operation.operationId,
                            operation.attemptCount,
                            kind,
                        ).catch((error) => {
                            devLog('WARN', 'DraftOperation.activity', 'Failed to record provider activity', {
                                operationId: operation.operationId,
                                attempt: operation.attemptCount,
                                kind,
                                error: String(error),
                            });
                        });
                    },
                    signal,
                }, { deferPersistence: true });
            },
            commitPrepared: async (operation, prepared) => {
                const updated = await this.draftOperationStore.commitSucceeded(
                    operation.operationId,
                    operation.version,
                    (tx, current) => this.draftStore.persistPreparedChapterDraft(
                        tx,
                        current,
                        prepared as PreparedChapterDraft,
                    ),
                );
                this.draftStore.invalidateCache();
                return updated;
            },
            findExistingResult: async (operationId): Promise<DraftOperationResultRef | null> => {
                const session = await this.draftStore.getBySourceOperationId(operationId);
                if (!session) return null;
                return {
                    draftSessionId: session.draftSessionId,
                    ...(session.draftBatchId ? { draftBatchId: session.draftBatchId } : {}),
                    ...(typeof session.childIndex === 'number' ? { childIndex: session.childIndex } : {}),
                    generationRevision: session.generationRevision ?? 1,
                };
            },
            getProvider: () => {
                const settings = this.aiService.getSettings();
                return {
                    providerType: settings.providerType,
                    model: settings.providerType === 'http' ? settings.http.model : 'mcp-cli',
                };
            },
            onStateChange: (operation) => {
                devLog('INFO', 'DraftOperation.state', 'Draft operation state changed', {
                    operationId: operation.operationId,
                    status: operation.status,
                    phase: operation.phase,
                    version: operation.version,
                    attempt: operation.attempt,
                });
            },
            deliverCompletion: deliverDraftCompletion,
        });
        this.reviewStore = new AgentReviewStore(db);
        this.reviewCommentStore = new ReviewCommentStore(getUserDataPath);
        this.attachmentStore = attachmentStore;
    }

    async initialize(): Promise<void> {
        await this.draftOperationCoordinator.initialize();
    }

    async shutdown(): Promise<void> {
        await this.draftOperationCoordinator.shutdown();
    }

    private async resolveChapterDraftTitle(input: {
        chapterId?: string;
        targetChapterId?: string;
        draftBatchId?: string;
        childIndex?: number;
        batchTitle?: string;
        batchContext?: Record<string, unknown>;
    }): Promise<string> {
        if (input.draftBatchId && Number.isInteger(input.childIndex)) {
            const currentBeat = input.batchContext?.currentBeat && typeof input.batchContext.currentBeat === 'object'
                ? input.batchContext.currentBeat as Record<string, unknown>
                : {};
            const beatTitle = String(currentBeat.title || input.batchTitle || '').trim();
            if (beatTitle) return beatTitle;
        }

        const chapterId = String(
            input.targetChapterId
            || input.chapterId
            || '',
        ).trim();
        if (!chapterId || chapterId.startsWith('draft-batch:')) return '';
        const chapter = await db.chapter.findUnique({
            where: { id: chapterId },
            select: { title: true },
        });
        return String(chapter?.title || '').trim();
    }

    private async startChapterDraftOperation(input: any): Promise<unknown> {
        const operationKey = assertRequiredString(input?.operationKey, 'operationKey');
        const payload = input?.payload && typeof input.payload === 'object'
            ? input.payload as Record<string, unknown>
            : null;
        if (!payload) throw createAutomationError('INVALID_INPUT', 'payload is required');
        const novelId = assertRequiredString(payload.novelId, 'payload.novelId');
        const chapterId = assertRequiredString(payload.chapterId, 'payload.chapterId');
        const generationRevision = Number(input?.generationRevision ?? payload.generationRevision ?? 1);
        if (!Number.isInteger(generationRevision) || generationRevision < 1) {
            throw createAutomationError('INVALID_INPUT', 'generationRevision must be a positive integer');
        }
        const targetChapterId = typeof payload.targetChapterId === 'string' && payload.targetChapterId.trim()
            ? payload.targetChapterId.trim()
            : chapterId;
        const sourceChapter = await db.chapter.findUnique({
            where: { id: targetChapterId },
            select: {
                id: true,
                version: true,
                content: true,
                deleted: true,
                volumeId: true,
                volume: { select: { novelId: true } },
            },
        });
        if (!sourceChapter || sourceChapter.deleted || sourceChapter.volume.novelId !== novelId) {
            throw createAutomationError('NOT_FOUND', 'Chapter source is unavailable');
        }
        const operationDeadlineAt = typeof input?.operationDeadlineAt === 'string'
            ? new Date(input.operationDeadlineAt)
            : new Date(Date.now() + 10 * 60_000);
        if (!Number.isFinite(operationDeadlineAt.getTime()) || operationDeadlineAt.getTime() <= Date.now()) {
            throw createAutomationError('INVALID_INPUT', 'operationDeadlineAt must be a future ISO timestamp');
        }
        const requestJson = canonicalDraftOperationJson(payload);
        const paramsHash = hashDraftOperationParams(payload);
        const owner = input?.owner && typeof input.owner === 'object' ? input.owner as Record<string, unknown> : {};
        const started = await this.draftOperationCoordinator.start({
            operationKey,
            paramsHash,
            requestJson,
            novelId,
            volumeId: sourceChapter.volumeId,
            chapterId,
            draftBatchId: typeof payload.draftBatchId === 'string' ? payload.draftBatchId : undefined,
            childIndex: typeof payload.childIndex === 'number' ? payload.childIndex : undefined,
            generationRevision,
            sourceChapterVersion: sourceChapter.version,
            sourceContentHash: createHash('sha256').update(sourceChapter.content || '', 'utf8').digest('hex'),
            maxAttempts: typeof input?.maxAttempts === 'number' ? input.maxAttempts : 4,
            operationDeadlineAt: operationDeadlineAt.toISOString(),
            sourceConversationId: typeof owner.conversationId === 'string' ? owner.conversationId : undefined,
            sourceRunId: typeof owner.runId === 'string' ? owner.runId : undefined,
            sourceStepId: typeof owner.stepId === 'string' ? owner.stepId : undefined,
        });
        return {
            ...started.operation,
            existing: started.existing,
            acceptedAt: started.operation.createdAt,
            pollAfterMs: 1000,
        };
    }

    private async createRevisionTaskPlan(
        input: RevisionTaskCreatePlanInput,
        context: AutomationInvokeContext,
    ): Promise<RevisionTaskCreatePlanResult> {
        const revisionTaskId = assertRequiredString(input?.revisionTaskId, 'revisionTaskId');
        const availableTools = Array.isArray(input?.availableTools)
            ? input.availableTools.map((tool) => String(tool || '').trim()).filter(Boolean)
            : [];
        if (!availableTools.length) {
            throw createAutomationError('INVALID_INPUT', 'availableTools is required');
        }
        const task = await this.reviewStore.getRevisionTask(revisionTaskId);
        if (task.status !== 'open') {
            throw createAutomationError('INVALID_TASK_STATUS', `Revision task cannot create a plan from status ${task.status}`);
        }
        await this.reviewStore.assertRevisionTaskFresh(task);
        const preferredRole = input.role || task.recommendedRole;
        const goal = [
            `根据已审核问题创建修订计划：${task.title}`,
            task.description,
            task.targetChapterIds.length ? `目标章节：${task.targetChapterIds.join('、')}` : '',
            `来源专家：${task.sourceExpert}；严重度：${task.severity}`,
            task.note ? `审核备注：${task.note}` : '',
            '只生成可审核计划，不直接修改或写回正文。',
        ].filter(Boolean).join('\n');
        const generated = await this.aiService.generateAgentPlan({
            goal,
            role: preferredRole,
            locale: input.locale || 'zh-CN',
            availableTools,
            availableToolchains: Array.isArray(input.availableToolchains) ? input.availableToolchains : [],
        }, context.signal);
        const planId = `plan_${randomUUID().replace(/-/g, '')}`;
        const threadId = input.threadId?.trim() || `thread_revision_${randomUUID().replace(/-/g, '')}`;
        const plan: RevisionTaskCreatePlanResult['plan'] = {
            planId,
            threadId,
            title: generated.title,
            goal,
            requiresApproval: true,
            preferredRole,
            ...(generated.deliverable ? { deliverable: generated.deliverable } : {}),
            steps: generated.steps.map((step) => ({
                stepId: `step_${randomUUID().replace(/-/g, '')}`,
                agent: step.agent,
                title: step.title,
                tools: Array.isArray(step.tools) ? step.tools : [],
                ...(step.toolchain ? { toolchain: step.toolchain } : {}),
                status: 'pending',
            })),
        };
        const updatedTask = await this.reviewStore.attachPlan(revisionTaskId, plan as unknown as Record<string, unknown> & { planId: string });
        return { task: updatedTask, plan };
    }

    private async serializeDraftBatchCommit<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.draftBatchCommitTail;
        let release!: () => void;
        this.draftBatchCommitTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await task();
        } finally {
            release();
        }
    }

    private invokeAgentStructured<T>(
        method: string,
        context: AutomationInvokeContext,
        task: () => Promise<T>,
        checkpointOptions: {
            repairAttemptId?: string;
            repairedFromRevision?: number;
            modelResultRef?: string;
            autoRepair?: boolean;
        } = {},
    ): Promise<T> {
        const resultRequestId = checkpointOptions.modelResultRef || context.requestId || randomUUID();
        return this.aiService.withAgentStructuredInvocation({
            requestId: resultRequestId,
            method,
            checkpoint: async (rawText, contract) => {
                const record = await this.modelResultStore.save(
                    resultRequestId,
                    method,
                    contract,
                    rawText,
                    {
                        repairAttemptId: checkpointOptions.repairAttemptId,
                        repairedFromRevision: checkpointOptions.repairedFromRevision,
                    },
                );
                return {
                    modelResultRef: record.modelResultRef,
                    revision: record.revision,
                    resultHash: record.resultHash,
                };
            },
            ...(checkpointOptions.autoRepair ? {
                autoRepair: async ({ checkpoint, contract, validationIssues }) => {
                    const repairAttemptId = createHash('sha256')
                        .update(`${checkpoint.modelResultRef}|${method}|repair|1`)
                        .digest('hex');
                    try {
                        const result = await this.repairStructuredOutput({
                            modelResultRef: checkpoint.modelResultRef,
                            sourceMethod: method,
                            contractId: contract.contractId,
                            contractVersion: contract.version,
                            validationIssues,
                            repairAttempt: 1,
                            repairAttemptId,
                        }, context);
                        const repairedPayload = result.repairedPayload;
                        if (!repairedPayload || typeof repairedPayload !== 'object' || Array.isArray(repairedPayload)) {
                            throw createAutomationError('MODEL_OUTPUT_INVALID', 'The automatic structured repair returned no usable payload');
                        }
                        return repairedPayload as Record<string, unknown>;
                    } catch (error) {
                        const repairFailureCode = String((error as { code?: unknown })?.code || 'MODEL_REPAIR_FAILED');
                        if (repairFailureCode === 'CANCELLED') throw error;
                        const repairDetails = error && typeof error === 'object'
                            && (error as { details?: unknown }).details
                            && typeof (error as { details?: unknown }).details === 'object'
                            && !Array.isArray((error as { details?: unknown }).details)
                            ? (error as { details: Record<string, unknown> }).details
                            : {};
                        throw createAutomationError('MODEL_OUTPUT_INVALID', 'The automatic structured repair did not produce a valid payload', {
                            modelResultRef: checkpoint.modelResultRef,
                            sourceMethod: method,
                            contractId: contract.contractId,
                            contractVersion: contract.version,
                            validationIssues: Array.isArray(repairDetails.validationIssues)
                                ? repairDetails.validationIssues
                                : validationIssues,
                            automaticRepairAttempts: 1,
                            repairFailureCode,
                        });
                    }
                },
            } : {}),
        }, task);
    }

    private async reprocessSavedStructuredOutput(params: any): Promise<Record<string, unknown>> {
        const modelResultRef = assertRequiredString(params?.modelResultRef, 'modelResultRef');
        const sourceMethod = assertRequiredString(params?.sourceMethod, 'sourceMethod');
        const contract = getAgentStructuredOutputContract(sourceMethod);
        if (!contract) {
            throw createAutomationError('OUTPUT_CONTRACT_MISMATCH', 'The structured output contract is unavailable');
        }
        const source = await this.modelResultStore.getLatest(modelResultRef);
        if (!source || source.sourceMethod !== sourceMethod) {
            throw createAutomationError('MODEL_RESULT_NOT_FOUND', 'The saved model result is unavailable');
        }
        if (source.contractId !== contract.contractId || source.contractVersion !== contract.version) {
            throw createAutomationError('OUTPUT_CONTRACT_MISMATCH', 'The saved model result uses a stale contract');
        }
        const parseResult = parseRepairableJsonObject(source.rawText, jsonrepair);
        const payload = parseResult?.value ?? null;
        const validationIssues = payload ? validateAgentStructuredOutput(payload, contract) : [];
        if (!payload || validationIssues.length > 0) {
            throw createAutomationError('MODEL_OUTPUT_INVALID', 'The saved model result cannot be reprocessed locally', {
                contractId: contract.contractId,
                contractVersion: contract.version,
                validationIssues,
            });
        }
        return {
            modelResultRef,
            revision: source.revision,
            payload,
            resultHash: source.resultHash,
        };
    }

    private async repairStructuredOutput(params: any, context: AutomationInvokeContext): Promise<Record<string, unknown>> {
        const modelResultRef = assertRequiredString(params?.modelResultRef, 'modelResultRef');
        const sourceMethod = assertRequiredString(params?.sourceMethod, 'sourceMethod');
        const repairAttemptId = assertRequiredString(params?.repairAttemptId, 'repairAttemptId');
        const repairAttempt = Number(params?.repairAttempt);
        if (repairAttempt !== 1 && repairAttempt !== 2) {
            throw createAutomationError('INVALID_INPUT', 'repairAttempt must be 1 or 2');
        }
        const contract = getAgentStructuredOutputContract(sourceMethod);
        const contractId = typeof params?.contractId === 'string' && params.contractId.trim()
            ? params.contractId.trim()
            : contract?.contractId || '';
        const contractVersion = typeof params?.contractVersion === 'string' && params.contractVersion.trim()
            ? params.contractVersion.trim()
            : contract?.version || '';
        if (!contract || contract.contractId !== contractId || contract.version !== contractVersion) {
            throw createAutomationError('OUTPUT_CONTRACT_MISMATCH', 'The requested output contract is unavailable or stale', {
                sourceMethod,
                contractId,
                contractVersion,
            });
        }
        const source = await this.modelResultStore.getLatest(modelResultRef);
        if (!source || source.sourceMethod !== sourceMethod) {
            throw createAutomationError('MODEL_RESULT_NOT_FOUND', 'The saved model result is unavailable', {
                modelResultRef,
                sourceMethod,
            });
        }
        if (source.contractId !== contractId || source.contractVersion !== contractVersion) {
            throw createAutomationError('OUTPUT_CONTRACT_MISMATCH', 'The saved model result uses a different output contract');
        }
        if (source.rawText.length > 200_000) {
            throw createAutomationError('MODEL_REPAIR_INPUT_TOO_LARGE', 'The saved model result is too large for structured repair');
        }
        const localParseResult = parseRepairableJsonObject(source.rawText, jsonrepair);
        const localPayload = localParseResult?.value ?? null;
        const localValidationIssues = localPayload
            ? validateAgentStructuredOutput(localPayload, contract)
            : [];
        if (localPayload && localValidationIssues.length === 0) {
            devLog('INFO', 'AutomationService.structuredOutput.localRepair', 'Saved structured JSON repaired locally', {
                modelResultRef,
                sourceMethod,
                revision: source.revision,
                repaired: localParseResult?.repaired === true,
                rawLength: source.rawText.length,
            });
            return {
                modelResultRef,
                revision: source.revision,
                repairedPayload: localPayload,
                resultHash: source.resultHash,
                repairKind: 'local',
            };
        }
        const claim = await this.modelResultStore.claimRepairAttempt(
            repairAttemptId,
            modelResultRef,
            repairAttempt as 1 | 2,
        );
        if (claim.status === 'completed' && claim.result) {
            const repairedPayload = parseRepairableJsonObject(claim.result.rawText, jsonrepair)?.value ?? null;
            const persistedIssues = repairedPayload ? validateAgentStructuredOutput(repairedPayload, contract) : [];
            if (!repairedPayload || persistedIssues.length > 0) {
                throw createAutomationError('MODEL_OUTPUT_INVALID', 'The persisted repair attempt is still invalid', {
                    modelResultRef,
                    repairAttemptId,
                    contractId,
                    contractVersion,
                    validationIssues: persistedIssues,
                });
            }
            return {
                modelResultRef,
                revision: claim.result.revision,
                repairedPayload,
                resultHash: claim.result.resultHash,
            };
        }
        if (claim.status !== 'claimed') {
            throw createAutomationError(
                claim.status === 'in_progress' ? 'MODEL_REPAIR_IN_PROGRESS' : 'MODEL_REPAIR_ATTEMPT_EXHAUSTED',
                claim.status === 'in_progress'
                    ? 'The structured output repair attempt is already running'
                    : 'The structured output repair attempt cannot be repeated',
                { modelResultRef, repairAttemptId },
            );
        }
        const requestedValidationIssues = Array.isArray(params?.validationIssues)
            ? params.validationIssues.slice(0, 20).map((issue: unknown) => {
                const value = issue && typeof issue === 'object' ? issue as Record<string, unknown> : {};
                return {
                    path: String(value.path || '').slice(0, 500),
                    message: String(value.message || '').slice(0, 1000),
                };
            })
            : [];
        const validationIssues = localValidationIssues.length > 0
            ? localValidationIssues.slice(0, 20)
            : requestedValidationIssues;
        try {
            const repairedPayload = await this.invokeAgentStructured(
                sourceMethod,
                context,
                () => this.aiService.repairAgentStructuredOutput({
                    rawText: source.rawText,
                    contract,
                    validationIssues,
                }, context.signal),
                {
                    modelResultRef,
                    repairAttemptId,
                    repairedFromRevision: source.revision,
                },
            );
            const repaired = await this.modelResultStore.findByRepairAttempt(repairAttemptId);
            if (!repaired) {
                throw createAutomationError('PERSISTENCE_ERROR', 'The repaired model result was not checkpointed');
            }
            await this.modelResultStore.completeRepairAttempt(repairAttemptId, repaired.revision);
            return {
                modelResultRef,
                revision: repaired.revision,
                repairedPayload,
                resultHash: repaired.resultHash,
            };
        } catch (error) {
            await this.modelResultStore.failRepairAttempt(
                repairAttemptId,
                String((error as { code?: unknown })?.code || 'MODEL_REPAIR_FAILED'),
            );
            throw error;
        }
    }

    private logInvokeStart(method: string, params: unknown, context: AutomationInvokeContext, timeoutMs: number): void {
        devLog('INFO', 'AutomationService.invoke.start', 'Automation invoke start', {
            requestId: context.requestId,
            method,
            source: context.source,
            origin: context.origin,
            timeoutMs,
            params: redactForLog(params),
        });
    }

    private logInvokeSuccess(method: string, context: AutomationInvokeContext, startedAt: number, result: unknown): void {
        devLog('INFO', 'AutomationService.invoke.success', 'Automation invoke success', {
            requestId: context.requestId,
            method,
            elapsedMs: Date.now() - startedAt,
            result: redactForLog(result),
        });
    }

    private logInvokeError(method: string, context: AutomationInvokeContext, startedAt: number, error: unknown): void {
        devLogError('AutomationService.invoke.error', error, {
            requestId: context.requestId,
            method,
            elapsedMs: Date.now() - startedAt,
        });
    }

    private async withTimeout<T>(method: string, params: unknown, context: AutomationInvokeContext, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const deadlineRemainingMs = context.deadlineAt ? Date.parse(context.deadlineAt) - Date.now() : Number.POSITIVE_INFINITY;
        const timeoutMs = Math.max(1, Math.min(resolveAutomationTimeout(method), deadlineRemainingMs - 1_000));
        const startedAt = Date.now();
        this.logInvokeStart(method, params, context, timeoutMs);
        const controller = new AbortController();
        const abortFromParent = () => controller.abort(context.signal?.reason);
        if (context.signal?.aborted) abortFromParent();
        else context.signal?.addEventListener('abort', abortFromParent, { once: true });
        if (controller.signal.aborted) {
            context.signal?.removeEventListener('abort', abortFromParent);
            throw createAutomationError('CANCELLED', `Automation method ${method} was cancelled`, {
                method,
                requestId: context.requestId,
            });
        }
        let timer: NodeJS.Timeout | undefined;
        let timedOut = false;
        const abortPromise = new Promise<never>((_, reject) => {
            const rejectCancelled = () => {
                if (!timedOut) {
                    reject(createAutomationError('CANCELLED', `Automation method ${method} was cancelled`, {
                        method,
                        requestId: context.requestId,
                    }));
                }
            };
            if (controller.signal.aborted) rejectCancelled();
            else controller.signal.addEventListener('abort', rejectCancelled, { once: true });
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort(createAutomationError('UPSTREAM_TIMEOUT', `Automation method ${method} timed out`));
                reject(createAutomationError('UPSTREAM_TIMEOUT', `Automation method ${method} timed out after ${timeoutMs}ms`, {
                    method,
                    timeoutMs,
                    requestId: context.requestId,
                }));
            }, timeoutMs);
            timer.unref?.();
        });

        const taskPromise = task(controller.signal);
        try {
            const result = await Promise.race([taskPromise, timeoutPromise, abortPromise]);
            if (timer) clearTimeout(timer);
            this.logInvokeSuccess(method, context, startedAt, result);
            return result;
        } catch (error) {
            if (timer) clearTimeout(timer);
            if (controller.signal.aborted) {
                await Promise.race([
                    taskPromise.then(() => undefined, () => undefined),
                    new Promise<void>((resolve) => {
                        const settleTimer = setTimeout(resolve, 5_000);
                        settleTimer.unref?.();
                    }),
                ]);
            }
            this.logInvokeError(method, context, startedAt, error);
            if (context.signal?.aborted) {
                throw createAutomationError('CANCELLED', `Automation method ${method} was cancelled`, {
                    method,
                    requestId: context.requestId,
                });
            }
            throw error;
        } finally {
            context.signal?.removeEventListener('abort', abortFromParent);
        }
    }

    private buildPromptPreviewPayload(kind: NormalizedPromptPreviewKind, payload: Record<string, unknown>): Record<string, unknown> {
        if (kind === 'creative_assets') {
            const novelId = assertRequiredString(payload.novelId, 'payload.novelId');
            const brief = assertRequiredString(payload.brief, 'payload.brief');
            const targetSections = Array.isArray(payload.targetSections)
                ? payload.targetSections
                : (String(payload.kind || '').toLowerCase().includes('outline') ? ['plotLines', 'plotPoints'] : undefined);
            return {
                ...payload,
                novelId,
                brief,
                ...(targetSections ? { targetSections } : {}),
            };
        }

        return {
            ...payload,
            novelId: assertRequiredString(payload.novelId, 'payload.novelId'),
            chapterId: assertRequiredString(payload.chapterId, 'payload.chapterId'),
            currentContent: assertRequiredString(payload.currentContent, 'payload.currentContent'),
        };
    }

    async listDrafts(filters?: DraftListFilters): Promise<DraftSessionRecord[]> {
        return this.draftStore.list(filters);
    }

    async getDraft(draftSessionId: string): Promise<DraftSessionRecord | null> {
        return this.draftStore.getById(draftSessionId);
    }

    async getActiveDraft(input: { novelId: string; workspace?: DraftSessionRecord['workspace']; type?: DraftSessionRecord['type'] }): Promise<DraftSessionRecord | null> {
        assertRequiredString(input?.novelId, 'novelId');
        return this.draftStore.getLatest({
            novelId: input.novelId,
            workspace: input.workspace,
            type: input.type,
            status: 'draft',
        });
    }

    async listDraftBatches(filters?: DraftBatchListFilters): Promise<DraftBatchRecord[]> {
        return this.draftStore.listBatches(filters);
    }

    async getDraftBatch(draftBatchId: string): Promise<DraftBatchRecord | null> {
        return this.draftStore.getBatchById(draftBatchId);
    }

    async createDraftBatch(input: DraftBatchCreateInput): Promise<DraftBatchRecord> {
        assertRequiredString(input?.novelId, 'novelId');
        assertRequiredString(input?.volumeId, 'volumeId');
        assertRequiredString(input?.anchorChapterId, 'anchorChapterId');
        return this.draftStore.createBatch(input);
    }

    async updateDraftBatchOutline(input: {
        draftBatchId: string;
        version: number;
        beats: ChapterBeatInput[];
    }): Promise<DraftBatchRecord> {
        return this.draftStore.updateBatchOutline(
            assertRequiredString(input?.draftBatchId, 'draftBatchId'),
            assertRequiredNumber(input?.version, 'version'),
            input?.beats,
        );
    }

    async approveDraftBatchOutline(input: {
        draftBatchId: string;
        version: number;
        outlineRevision: number;
        approvedBy?: string;
    }): Promise<DraftBatchRecord> {
        return this.draftStore.approveBatchOutline(
            assertRequiredString(input?.draftBatchId, 'draftBatchId'),
            assertRequiredNumber(input?.version, 'version'),
            assertRequiredNumber(input?.outlineRevision, 'outlineRevision'),
            typeof input?.approvedBy === 'string' ? input.approvedBy : 'desktop-ui',
        );
    }

    async attachDraftBatchChild(input: {
        draftBatchId: string;
        childIndex: number;
        session: Omit<DraftSessionRecord, 'draftSessionId' | 'version' | 'createdAt' | 'updatedAt' | 'draftBatchId' | 'childIndex' | 'generationRevision' | 'dependsOnDraftSessionId'>;
    }): Promise<{ batch: DraftBatchRecord; session: DraftSessionRecord }> {
        return this.draftStore.createBatchChildSession(
            assertRequiredString(input?.draftBatchId, 'draftBatchId'),
            assertRequiredNumber(input?.childIndex, 'childIndex'),
            input?.session,
        );
    }

    async markDraftBatchStaleAfter(input: {
        draftBatchId: string;
        version: number;
        afterChildIndex: number;
    }): Promise<DraftBatchRecord> {
        return this.draftStore.markBatchChildrenStale(
            assertRequiredString(input?.draftBatchId, 'draftBatchId'),
            assertRequiredNumber(input?.version, 'version'),
            assertRequiredNumber(input?.afterChildIndex, 'afterChildIndex'),
        );
    }

    async prepareDraftBatchRegeneration(
        input: DraftBatchPrepareRegenerationInput,
    ): Promise<DraftBatchPrepareRegenerationResponse> {
        const fromChildIndex = input?.fromChildIndex;
        if (fromChildIndex !== undefined && (!Number.isInteger(fromChildIndex) || fromChildIndex < 0)) {
            throw createAutomationError('INVALID_INPUT', 'fromChildIndex must be a non-negative integer');
        }
        return this.draftStore.prepareBatchRegeneration(
            assertRequiredString(input?.draftBatchId, 'draftBatchId'),
            assertRequiredNumber(input?.version, 'version'),
            fromChildIndex,
            assertRequiredString(input?.runId, 'runId'),
        );
    }

    async markDraftBatchChildFailed(input: DraftBatchMarkFailedInput): Promise<DraftBatchRecord> {
        assertRequiredString(input?.draftBatchId, 'draftBatchId');
        assertRequiredNumber(input?.version, 'version');
        assertRequiredNumber(input?.childIndex, 'childIndex');
        assertRequiredNumber(input?.generationRevision, 'generationRevision');
        if (!Number.isInteger(input.childIndex) || input.childIndex < 0) {
            throw createAutomationError('INVALID_INPUT', 'childIndex must be a non-negative integer');
        }
        if (!Number.isInteger(input.generationRevision) || input.generationRevision < 1) {
            throw createAutomationError('INVALID_INPUT', 'generationRevision must be a positive integer');
        }
        return this.draftStore.markBatchChildFailed(input);
    }

    async inspectDraftBatchReconciliation(
        input: DraftBatchInspectReconciliationInput,
    ): Promise<DraftBatchReconciliationInspection> {
        const childIndex = assertRequiredNumber(input?.childIndex, 'childIndex');
        const generationRevision = assertRequiredNumber(input?.generationRevision, 'generationRevision');
        if (!Number.isInteger(childIndex) || childIndex < 0) {
            throw createAutomationError('INVALID_INPUT', 'childIndex must be a non-negative integer');
        }
        if (!Number.isInteger(generationRevision) || generationRevision < 1) {
            throw createAutomationError('INVALID_INPUT', 'generationRevision must be a positive integer');
        }
        return this.draftStore.inspectBatchReconciliation({
            draftBatchId: assertRequiredString(input?.draftBatchId, 'draftBatchId'),
            childIndex,
            generationRevision,
        });
    }

    async reconcileDraftBatchUnknown(input: DraftBatchReconcileUnknownInput): Promise<DraftBatchRecord> {
        assertRequiredString(input?.invocationKey, 'invocationKey');
        if (input?.resolution !== 'reconciled_succeeded' && input?.resolution !== 'reconciled_absent') {
            throw createAutomationError('INVALID_INPUT', 'resolution must be reconciled_succeeded or reconciled_absent');
        }
        return this.draftStore.reconcileBatchUnknown({
            ...input,
            draftBatchId: assertRequiredString(input?.draftBatchId, 'draftBatchId'),
            version: assertRequiredNumber(input?.version, 'version'),
            childIndex: assertRequiredNumber(input?.childIndex, 'childIndex'),
            generationRevision: assertRequiredNumber(input?.generationRevision, 'generationRevision'),
            invocationKey: assertRequiredString(input?.invocationKey, 'invocationKey'),
        });
    }

    async discardDraftBatch(input: { draftBatchId: string; version: number }): Promise<DraftBatchRecord> {
        return this.draftStore.discardBatch(
            assertRequiredString(input?.draftBatchId, 'draftBatchId'),
            assertRequiredNumber(input?.version, 'version'),
        );
    }

    async commitDraftBatchPrefix(input: DraftBatchCommitPrefixInput): Promise<DraftBatchCommitPrefixResponse> {
        return this.serializeDraftBatchCommit(async () => {
            const draftBatchId = assertRequiredString(input?.draftBatchId, 'draftBatchId');
            const version = assertRequiredNumber(input?.version, 'version');
            const prefixLength = assertRequiredNumber(input?.prefixLength, 'prefixLength');
            if (!Number.isInteger(prefixLength)) {
                throw createAutomationError('INVALID_INPUT', 'prefixLength must be an integer');
            }
            const insertionMode = input?.insertionMode;
            if (insertionMode !== undefined && insertionMode !== 'after_anchor' && insertionMode !== 'volume_end') {
                throw createAutomationError('INVALID_INPUT', 'insertionMode must be after_anchor or volume_end');
            }

            const batch = await this.draftStore.getBatchById(draftBatchId);
            if (!batch) throw createAutomationError('NOT_FOUND', 'Draft batch not found');
            if (batch.version !== version) throw createAutomationError('VERSION_CONFLICT', 'Draft batch version conflict');
            if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > batch.children.length) {
                throw createAutomationError('INVALID_INPUT', 'prefixLength is outside the draft batch');
            }
            if (batch.status === 'discarded' || batch.status === 'failed') {
                throw createAutomationError('INVALID_STATE', `Draft batch cannot be committed from ${batch.status}`);
            }

            const firstUncommittedIndex = batch.children.findIndex((child) => child.status !== 'committed');
            const committedPrefixLength = firstUncommittedIndex < 0 ? batch.children.length : firstUncommittedIndex;
            if (batch.children.slice(committedPrefixLength).some((child) => child.status === 'committed')) {
                throw createAutomationError('INVALID_STATE', 'Draft batch contains a non-contiguous committed child');
            }
            if (prefixLength <= committedPrefixLength) {
                throw createAutomationError('INVALID_STATE', 'Requested prefix is already committed');
            }

            const sessions = await this.draftStore.list({ draftBatchId, includeInactive: true });
            const sessionById = new Map(sessions.map((session) => [session.draftSessionId, session]));
            const drafts = batch.children
                .slice(committedPrefixLength, prefixLength)
                .map((child) => {
                    const session = child.draftSessionId ? sessionById.get(child.draftSessionId) : undefined;
                    if (!session || child.status !== 'draft' || session.status !== 'draft' || session.type !== 'chapter-draft') {
                        throw createAutomationError(
                            'INVALID_STATE',
                            `Draft batch child ${child.childIndex + 1} is not ready to commit`,
                        );
                    }
                    if (session.draftBatchId !== draftBatchId || session.childIndex !== child.childIndex) {
                        throw createAutomationError(
                            'INVALID_STATE',
                            `Draft batch child ${child.childIndex + 1} session linkage is invalid`,
                        );
                    }
                    const payload = session.payload as ChapterDraftPayload;
                    const generatedText = String(payload.generatedText || '').trim();
                    const content = batch.mode === 'sequence_continuation'
                        ? createLexicalDocumentFromPlainText(generatedText)
                        : ensureLexicalDocument(String(payload.content || generatedText));
                    if (!extractReadableText(content)) {
                        throw createAutomationError(
                            'INVALID_STATE',
                            `Draft batch child ${child.childIndex + 1} has no reviewable content`,
                        );
                    }
                    return {
                        childIndex: child.childIndex,
                        targetChapterId: child.targetChapterId,
                        title: child.title.trim() || `第 ${child.childIndex + 1} 章`,
                        content,
                        wordCount: extractReadableText(content).length,
                    };
                });

            const committed = await commitDraftBatchChapters(db, {
                batch,
                committedPrefixLength,
                prefixLength,
                insertionMode,
                drafts,
            });
            const stored = await this.draftStore.commitBatchPrefix(
                draftBatchId,
                version,
                prefixLength,
                committed.insertionMode,
                committed.chapters,
                committed.writeback,
            );

            for (const chapter of committed.chapters) {
                await searchIndex.indexChapter({
                    id: chapter.chapterId,
                    title: chapter.title,
                    content: chapter.content,
                    volumeId: chapter.volumeId,
                    order: chapter.order,
                    novelId: batch.novelId,
                });
                scheduleChapterSummaryRebuild(chapter.chapterId);
            }
            if (committed.reorderedChapterIds.length > 0) {
                const reorderedChapters = await db.chapter.findMany({
                    where: { id: { in: committed.reorderedChapterIds } },
                    select: { id: true, title: true, content: true, volumeId: true },
                });
                for (const chapter of reorderedChapters) {
                    await searchIndex.indexChapter({ ...chapter, novelId: batch.novelId });
                }
            }

            return {
                batch: stored.batch,
                sessions: stored.sessions,
                chapters: committed.chapters,
                committedPrefixLength: prefixLength,
                insertionMode: committed.insertionMode,
                writeback: committed.writeback,
            };
        });
    }

    async undoDraftBatch(input: DraftBatchUndoInput): Promise<DraftUndoResponse> {
        return this.serializeDraftBatchCommit(async () => {
            const draftBatchId = assertRequiredString(input?.draftBatchId, 'draftBatchId');
            const version = assertRequiredNumber(input?.version, 'version');
            const writebackId = assertRequiredString(input?.writebackId, 'writebackId');
            const batch = await this.draftStore.getBatchById(draftBatchId);
            if (!batch) throw createAutomationError('NOT_FOUND', 'Draft batch not found');
            if (batch.version !== version) throw createAutomationError('VERSION_CONFLICT', 'Draft batch version conflict');
            const latestWriteback = [...(batch.writebacks ?? [])].reverse().find((item) => item.status === 'committed');
            if (!latestWriteback || latestWriteback.writebackId !== writebackId) {
                throw createAutomationError('INVALID_STATE', 'Only the latest writeback can be undone');
            }

            const restoredChapters = await undoDraftBatchWriteback(db, batch, latestWriteback);
            const stored = await this.draftStore.undoBatchWriteback(
                draftBatchId,
                version,
                writebackId,
                restoredChapters,
            );
            for (const chapter of restoredChapters) {
                await searchIndex.indexChapter({
                    id: chapter.chapterId,
                    title: chapter.title,
                    content: chapter.content,
                    volumeId: chapter.volumeId,
                    order: chapter.order,
                    novelId: batch.novelId,
                });
                scheduleChapterSummaryRebuild(chapter.chapterId);
            }
            return {
                batch: stored.batch,
                writeback: stored.writeback,
            };
        });
    }

    async generateCreativeAssetsDraft(
        payload: CreativeAssetsGeneratePayload,
        context: AutomationInvokeContext,
        type: DraftSessionRecord['type'] = 'creative-assets',
    ): Promise<DraftSessionRecord> {
        assertRequiredString(payload?.novelId, 'novelId');
        assertRequiredString(payload?.brief, 'brief');
        const result = await this.aiService.generateCreativeAssets(payload, context.signal);
        const sanitizedDraft = sanitizeGeneratedDraft(normalizeCreativeDraft(result.draft));
        return this.draftStore.create({
            workspace: 'ai-workbench',
            type,
            source: 'internal-ai',
            origin: context.origin ?? 'unknown',
            novelId: payload.novelId,
            status: 'draft',
            payload: sanitizedDraft,
            selection: createSelectionFromDraft(sanitizedDraft),
            previewSummary: summarizeCreativeDraft(sanitizedDraft),
            validation: null,
        });
    }

    async createChapterDraftSession(
        payload: ChapterDraftGenerationPayload,
        context: AutomationInvokeContext,
    ): Promise<DraftSessionRecord>;
    async createChapterDraftSession(
        payload: ChapterDraftGenerationPayload,
        context: AutomationInvokeContext,
        options: { deferPersistence: true },
    ): Promise<PreparedChapterDraft>;
    async createChapterDraftSession(
        payload: ChapterDraftGenerationPayload,
        context: AutomationInvokeContext,
        options?: { deferPersistence?: boolean },
    ): Promise<DraftSessionRecord | PreparedChapterDraft> {
        assertRequiredString(payload?.novelId, 'novelId');
        assertRequiredString(payload?.chapterId, 'chapterId');
        if (payload?.mode === 'new_chapter') {
            if (typeof payload.currentContent !== 'string') {
                throw createAutomationError('INVALID_INPUT', 'currentContent must be a string');
            }
        } else {
            assertRequiredString(payload?.currentContent, 'currentContent');
        }
        const sourceOperationId = typeof payload.sourceOperationId === 'string' ? payload.sourceOperationId.trim() : '';
        if (sourceOperationId) {
            const existing = await this.draftStore.getBySourceOperationId(sourceOperationId);
            if (existing) {
                if (options?.deferPersistence) {
                    return {
                        kind: 'existing',
                        result: {
                            draftSessionId: existing.draftSessionId,
                            ...(existing.draftBatchId ? { draftBatchId: existing.draftBatchId } : {}),
                            ...(typeof existing.childIndex === 'number' ? { childIndex: existing.childIndex } : {}),
                            generationRevision: existing.generationRevision ?? payload.generationRevision ?? 1,
                        },
                    };
                }
                return existing;
            }
        }
        const requestedPresentation = typeof payload.presentation === 'string' ? payload.presentation.trim().toLowerCase() : '';
        const normalizedPresentation = requestedPresentation === 'silent' || requestedPresentation === 'toast' || requestedPresentation === 'modal'
            ? requestedPresentation
            : undefined;
        const draftBatchId = typeof payload.draftBatchId === 'string' ? payload.draftBatchId.trim() : '';
        const childIndex = payload.childIndex;
        if ((draftBatchId && !Number.isInteger(childIndex)) || (!draftBatchId && childIndex !== undefined)) {
            throw createAutomationError('INVALID_INPUT', 'draftBatchId and integer childIndex must be supplied together');
        }
        let sourceSnapshot: ChapterDraftPayload['sourceSnapshot'];
        if (!draftBatchId) {
            const sourceChapter = await db.chapter.findUnique({
                where: { id: payload.chapterId },
                select: { id: true, version: true, content: true, deleted: true, volume: { select: { novelId: true } } },
            });
            if (!sourceChapter || sourceChapter.deleted || sourceChapter.volume.novelId !== payload.novelId) {
                throw createAutomationError('NOT_FOUND', 'Chapter source is unavailable');
            }
            sourceSnapshot = {
                chapterId: sourceChapter.id,
                version: sourceChapter.version,
                contentHash: createHash('sha256').update(sourceChapter.content || '', 'utf8').digest('hex'),
            };
        }
        const {
            presentation: _presentation,
            sourceOperationId: _sourceOperationId,
            draftBatchId: _draftBatchId,
            childIndex: _childIndex,
            batchTitle: _batchTitle,
            generationRevision: _generationRevision,
            batchMode: _batchMode,
            targetChapterId: _targetChapterId,
            ...chapterGeneratePayload
        } = payload;
        const result = await this.aiService.continueWriting(
            chapterGeneratePayload,
            context.signal,
            context.onProviderActivity,
        ) as {
            text: string;
            usedContext: string[];
            warnings?: string[];
            contextPolicy?: import('../../shared/agentChapterScope').ContinuationContextPolicy;
            contextSnapshot?: import('../../shared/agentChapterScope').ContinuationContextSnapshot;
            consistency: { ok: boolean; issues: string[] };
        };

        const draftHeadingTitle = await this.resolveChapterDraftTitle({
            chapterId: payload.chapterId,
            targetChapterId: payload.targetChapterId,
            draftBatchId,
            childIndex,
            batchTitle: payload.batchTitle,
            batchContext: payload.batchContext,
        });
        const generatedText = normalizeChapterDraftText(String(result.text || '').trim(), draftHeadingTitle);
        if (!generatedText) {
            throw createAutomationError('EMPTY_RESULT', 'Agent returned an empty draft after chapter title normalization');
        }

        let narrativeStateDelta: NarrativeStateDelta | undefined;
        let stateExtractionWarning = '';
        if (draftBatchId && Number.isInteger(childIndex)) {
            const hardContext = payload.preparedContext?.hardContext;
            const entityRefs = (values: Array<Record<string, unknown>> | undefined) => (values ?? [])
                .map((item) => ({
                    key: String(item.id || item.name || '').trim(),
                    name: String(item.name || '').trim(),
                }))
                .filter((item) => item.key && item.name);
            try {
                const extracted = await this.aiService.extractNarrativeState({
                    locale: payload.locale,
                    generatedText,
                    currentBeat: payload.batchContext?.currentBeat && typeof payload.batchContext.currentBeat === 'object'
                        ? payload.batchContext.currentBeat as Record<string, unknown>
                        : {},
                    priorStateLedger: payload.batchContext?.stateLedger && typeof payload.batchContext.stateLedger === 'object'
                        ? payload.batchContext.stateLedger as Record<string, unknown>
                        : {},
                    characters: entityRefs(hardContext?.characters),
                    items: entityRefs(hardContext?.items),
                }, context.signal);
                narrativeStateDelta = extracted.delta;
            } catch (error) {
                if (context.signal?.aborted) throw error;
                stateExtractionWarning = '章节状态抽取失败，已使用节拍台账继续生成。';
                devLogError('AutomationService.chapter.state-extraction', error, {
                    draftBatchId,
                    childIndex,
                    generationRevision: payload.generationRevision,
                });
            }
        }

        const isRewriteBatch = draftBatchId && payload.batchMode === 'batch_rewrite';
        const targetChapterId = isRewriteBatch
            ? assertRequiredString(payload.targetChapterId, 'targetChapterId')
            : draftBatchId
                ? `draft-batch:${draftBatchId}:${childIndex}`
                : payload.chapterId;
        const baseContent = isRewriteBatch ? payload.currentContent : draftBatchId ? '' : payload.currentContent;
        const chapterPayload: ChapterDraftPayload = {
            chapterId: targetChapterId,
            baseContent,
            generatedText,
            content: isRewriteBatch ? generatedText : appendPlainTextToLexical(baseContent, generatedText),
            presentation: normalizedPresentation,
            usedContext: result.usedContext,
            warnings: [
                ...(result.warnings ?? []),
                ...(stateExtractionWarning ? [stateExtractionWarning] : []),
            ],
            narrativeStateDelta,
            contextPolicy: result.contextPolicy,
            contextSnapshot: result.contextSnapshot,
            sourceSnapshot,
            consistency: result.consistency,
        };

        const sessionInput = {
            workspace: 'chapter-editor',
            type: 'chapter-draft',
            source: 'internal-ai',
            origin: context.origin ?? 'unknown',
            novelId: payload.novelId,
            chapterId: targetChapterId,
            sourceOperationId: sourceOperationId || undefined,
            generationRevision: payload.generationRevision ?? 1,
            status: 'draft',
            payload: chapterPayload,
            previewSummary: `${payload.batchTitle?.trim() || '章节草稿'} ${generatedText.length} 字符`,
        } as const;
        if (draftBatchId && Number.isInteger(childIndex)) {
            const currentBeat = payload.batchContext?.currentBeat && typeof payload.batchContext.currentBeat === 'object'
                ? payload.batchContext.currentBeat as Record<string, unknown>
                : {};
            const progress = {
                title: String(currentBeat.title || payload.batchTitle || '').trim(),
                coreConflict: String(currentBeat.coreConflict || '').trim(),
                keyEvents: Array.isArray(currentBeat.keyEvents) ? currentBeat.keyEvents.map(String) : [],
                reveals: Array.isArray(currentBeat.reveals) ? currentBeat.reveals.map(String) : [],
                endingHook: String(currentBeat.endingHook || '').trim(),
                summary: generatedText.length > 700
                    ? `${generatedText.slice(0, 350)} ... ${generatedText.slice(-250)}`
                    : generatedText,
                stateDelta: narrativeStateDelta,
            };
            if (options?.deferPersistence) {
                return {
                    kind: 'create',
                    sessionInput,
                    draftBatchId,
                    childIndex: childIndex as number,
                    progress,
                    expectedGenerationRevision: payload.generationRevision,
                };
            }
            const attached = await this.draftStore.createBatchChildSession(
                draftBatchId,
                childIndex as number,
                sessionInput,
                progress,
                payload.generationRevision,
            );
            return attached.session;
        }
        if (options?.deferPersistence) {
            return {
                kind: 'create',
                sessionInput,
                expectedGenerationRevision: payload.generationRevision,
            };
        }
        return this.draftStore.create(sessionInput);
    }

    async reviseChapterDraftSession(
        input: {
            sourceDraftSessionId: string;
            sourceDraftVersion: number;
            reviewRequestId?: string;
            comments: ReviewCommentRecord[];
            locale?: string;
        },
        context: AutomationInvokeContext,
    ): Promise<DraftSessionRecord> {
        const sourceDraftSessionId = assertRequiredString(input?.sourceDraftSessionId, 'sourceDraftSessionId');
        assertRequiredNumber(input?.sourceDraftVersion, 'sourceDraftVersion');
        if (!Array.isArray(input?.comments) || input.comments.length === 0) {
            throw createAutomationError('INVALID_INPUT', 'At least one review comment is required');
        }
        const source = await this.draftStore.getById(sourceDraftSessionId);
        if (!source) throw createAutomationError('NOT_FOUND', 'Source draft session not found');
        if (source.version !== input.sourceDraftVersion) {
            throw createAutomationError('VERSION_CONFLICT', 'Source draft changed after the review comments were loaded');
        }
        if (source.type !== 'chapter-draft' || source.draftBatchId) {
            throw createAutomationError('INVALID_DRAFT_TYPE', 'Only a standalone chapter draft can use chapter.revise_draft');
        }
        if (source.status !== 'draft') {
            throw createAutomationError('INVALID_STATE', 'Only the current reviewable draft can be regenerated');
        }
        const sourcePayload = source.payload as ChapterDraftPayload;
        const revisedTitle = await this.resolveChapterDraftTitle({
            chapterId: sourcePayload.sourceSnapshot?.chapterId || sourcePayload.chapterId,
        });
        const instructions = input.comments.map((comment, index) => {
            const location = typeof comment.anchor.paragraphIndex === 'number'
                ? `第 ${comment.anchor.paragraphIndex + 1} 段`
                : comment.anchor.targetId;
            const quote = comment.anchor.quote?.trim()
                ? `\n原文摘录：${comment.anchor.quote.trim().slice(0, 500)}`
                : '';
            return `${index + 1}. ${location}：${comment.body.trim()}${quote}`;
        }).join('\n');
        const result = await this.aiService.continueWriting({
            novelId: source.novelId,
            chapterId: sourcePayload.sourceSnapshot?.chapterId || sourcePayload.chapterId,
            currentContent: normalizeChapterDraftText(sourcePayload.generatedText, revisedTitle),
            locale: input.locale || 'zh-CN',
            mode: 'rewrite_chapter',
            userIntent: [
                '根据以下审批意见重写当前待审核草稿。',
                '只调整被指出的内容；没有审批意见的情节、事实、人物状态、伏笔和文风应尽量保持。',
                '输出完整的新草稿正文，不要解释修改过程。',
                instructions,
            ].join('\n'),
            presentation: 'silent',
        }, context.signal) as {
            text: string;
            usedContext: string[];
            warnings?: string[];
            contextPolicy?: import('../../shared/agentChapterScope').ContinuationContextPolicy;
            contextSnapshot?: import('../../shared/agentChapterScope').ContinuationContextSnapshot;
            consistency: { ok: boolean; issues: string[] };
        };
        const generatedText = normalizeChapterDraftText(String(result.text || '').trim(), revisedTitle);
        if (!generatedText) {
            throw createAutomationError('EMPTY_RESULT', 'Agent returned an empty revised draft after chapter title normalization');
        }
        return this.draftStore.create({
            workspace: source.workspace,
            type: 'chapter-draft',
            source: 'internal-ai',
            origin: context.origin ?? 'desktop-ui',
            novelId: source.novelId,
            chapterId: source.chapterId,
            revisionOfDraftSessionId: source.draftSessionId,
            reviewRequestId: input.reviewRequestId?.trim() || randomUUID(),
            status: 'draft',
            payload: {
                ...sourcePayload,
                generatedText,
                content: appendPlainTextToLexical(sourcePayload.baseContent, generatedText),
                usedContext: result.usedContext,
                warnings: result.warnings,
                contextPolicy: result.contextPolicy,
                contextSnapshot: result.contextSnapshot,
                consistency: result.consistency,
            },
            previewSummary: `审批意见修订草稿 ${generatedText.length} 字符`,
        });
    }

    async reviseCreativeAssetsDraftSession(
        input: {
            sourceDraftSessionId: string;
            sourceDraftVersion: number;
            reviewRequestId?: string;
            comments: ReviewCommentRecord[];
            locale?: string;
        },
        context: AutomationInvokeContext,
    ): Promise<DraftSessionRecord> {
        const sourceDraftSessionId = assertRequiredString(input?.sourceDraftSessionId, 'sourceDraftSessionId');
        assertRequiredNumber(input?.sourceDraftVersion, 'sourceDraftVersion');
        if (!Array.isArray(input?.comments) || input.comments.length === 0) {
            throw createAutomationError('INVALID_INPUT', 'At least one review comment is required');
        }
        const source = await this.draftStore.getById(sourceDraftSessionId);
        if (!source) throw createAutomationError('NOT_FOUND', 'Source draft session not found');
        if (source.version !== input.sourceDraftVersion) {
            throw createAutomationError('VERSION_CONFLICT', 'Source draft changed after the review comments were loaded');
        }
        if (source.type !== 'creative-assets') {
            throw createAutomationError('INVALID_DRAFT_TYPE', 'Only a creative assets draft can use creative_assets.revise_draft');
        }
        if (source.status !== 'draft') {
            throw createAutomationError('INVALID_STATE', 'Only the current reviewable draft can be regenerated');
        }
        if (input.comments.some((comment) => comment.reviewVersionId !== source.draftSessionId)) {
            throw createAutomationError('VERSION_CONFLICT', 'Review comments belong to another creative assets version');
        }

        const sourceDraft = sanitizeGeneratedDraft(normalizeCreativeDraft(source.payload));
        const targetSections = (Object.keys(sourceDraft) as Array<keyof CreativeAssetsDraft>)
            .filter((section) => Array.isArray(sourceDraft[section]) && (sourceDraft[section]?.length ?? 0) > 0);
        const instructions = input.comments.map((comment, index) => {
            const location = comment.anchor.fieldPath || comment.anchor.targetId;
            const quote = comment.anchor.quote?.trim()
                ? `\n条目摘录：${comment.anchor.quote.trim().slice(0, 500)}`
                : '';
            return `${index + 1}. ${location}：${comment.body.trim()}${quote}`;
        }).join('\n');
        const promptDraft = JSON.stringify(sourceDraft, (key, value) => (
            key === 'imageBase64' ? '[保留原图片数据]' : value
        ), 2);
        const result = await this.aiService.generateCreativeAssets({
            novelId: source.novelId,
            locale: input.locale || 'zh-CN',
            brief: '根据审批意见重写当前创作素材审核包。',
            targetSections,
            includeExistingEntities: false,
            filterCompletedPlotLines: false,
            overrideUserPrompt: [
                '你正在修订一个待审核的创作素材包。',
                '必须返回完整 JSON 素材包，结构与原素材包一致。',
                '只修改审批意见指出的条目或字段；其余情节、角色、设定、物品、技能和地图保持不变。',
                '不要解释修改过程，不要省略未修改条目。',
                '原素材包：',
                promptDraft,
                '审批意见：',
                instructions,
            ].join('\n'),
        }, context.signal);
        const revisedDraft = sanitizeGeneratedDraft(normalizeCreativeDraft(result.draft));
        const revisedCount = Object.values(revisedDraft).reduce((total, items) => total + (items?.length ?? 0), 0);
        if (revisedCount === 0) throw createAutomationError('EMPTY_RESULT', 'Agent returned an empty creative assets revision');

        return this.draftStore.create({
            workspace: source.workspace,
            type: 'creative-assets',
            source: 'internal-ai',
            origin: context.origin ?? 'desktop-ui',
            novelId: source.novelId,
            revisionOfDraftSessionId: source.draftSessionId,
            reviewRequestId: input.reviewRequestId?.trim() || randomUUID(),
            status: 'draft',
            payload: revisedDraft,
            selection: createSelectionFromDraft(revisedDraft),
            validation: null,
            previewSummary: summarizeCreativeDraft(revisedDraft),
        });
    }

    async updateDraft(input: {
        draftSessionId: string;
        version: number;
        payload?: CreativeAssetsDraft | ChapterDraftPayload;
        selection?: CreativeDraftSelection;
        validation?: CreativeAssetsDraftValidationResult | null;
    }): Promise<DraftSessionRecord> {
        assertRequiredString(input?.draftSessionId, 'draftSessionId');
        assertRequiredNumber(input?.version, 'version');
        const beforeUpdate = await this.draftStore.getById(input.draftSessionId);
        if (!beforeUpdate) throw createAutomationError('NOT_FOUND', 'Draft session not found');
        if (beforeUpdate.status !== 'draft') {
            throw createAutomationError('INVALID_STATE', 'Only an active draft can be edited');
        }
        const updated = await this.draftStore.update(input.draftSessionId, input.version, (current) => ({
            ...current,
            payload: input.payload ?? current.payload,
            selection: input.selection ?? current.selection,
            validation: input.validation === undefined ? current.validation : input.validation,
            previewSummary: current.type === 'chapter-draft'
                ? `章节草稿 ${((input.payload ?? current.payload) as ChapterDraftPayload).generatedText?.length ?? 0} 字符`
                : summarizeCreativeDraft(normalizeCreativeDraft(input.payload ?? current.payload)),
        }));
        if (beforeUpdate.draftBatchId && typeof beforeUpdate.childIndex === 'number') {
            const batch = await this.draftStore.getBatchById(beforeUpdate.draftBatchId);
            const child = batch?.children[beforeUpdate.childIndex];
            if (
                batch
                && child?.draftSessionId === beforeUpdate.draftSessionId
                && beforeUpdate.childIndex < batch.children.length - 1
            ) {
                await this.draftStore.markBatchChildrenStale(
                    batch.draftBatchId,
                    batch.version,
                    beforeUpdate.childIndex,
                );
            }
        }
        return updated;
    }

    async discardDraft(input: { draftSessionId: string; version: number }): Promise<DraftSessionRecord> {
        assertRequiredString(input?.draftSessionId, 'draftSessionId');
        assertRequiredNumber(input?.version, 'version');
        return this.draftStore.update(input.draftSessionId, input.version, (current) => ({
            ...current,
            status: 'discarded',
        }));
    }

    async validateCreativeDraftSession(input: { draftSessionId: string; version?: number }): Promise<{ session: DraftSessionRecord; validation: CreativeAssetsDraftValidationResult }> {
        assertRequiredString(input?.draftSessionId, 'draftSessionId');
        const session = await this.draftStore.getById(input.draftSessionId);
        if (!session) {
            throw Object.assign(new Error('Draft session not found'), { code: 'NOT_FOUND' });
        }
        if (typeof input.version === 'number' && session.version !== input.version) {
            throw Object.assign(new Error('Draft session version conflict'), { code: 'VERSION_CONFLICT' });
        }
        if (session.type !== 'creative-assets' && session.type !== 'outline-draft') {
            throw Object.assign(new Error('Only creative draft sessions can be validated'), { code: 'INVALID_INPUT' });
        }
        const validation = await this.aiService.validateCreativeAssetsDraft({
            novelId: session.novelId,
            draft: pickSelectedCreativeDraft(normalizeCreativeDraft(session.payload), session.selection),
        });
        const updated = await this.draftStore.update(session.draftSessionId, session.version, (current) => ({
            ...current,
            validation,
            payload: validation.normalizedDraft,
            selection: createSelectionFromDraft(validation.normalizedDraft),
            previewSummary: summarizeCreativeDraft(validation.normalizedDraft),
        }));
        return {
            session: updated,
            validation,
        };
    }

    async commitDraft(input: { draftSessionId: string; version: number }): Promise<DraftCommitResponse> {
        return this.serializeDraftBatchCommit(() => this.commitDraftSerialized(input));
    }

    private async commitDraftSerialized(input: { draftSessionId: string; version: number }): Promise<DraftCommitResponse> {
        assertRequiredString(input?.draftSessionId, 'draftSessionId');
        assertRequiredNumber(input?.version, 'version');
        const session = await this.draftStore.getById(input.draftSessionId);
        if (!session) {
            throw Object.assign(new Error('Draft session not found'), { code: 'NOT_FOUND' });
        }
        if (session.version !== input.version) {
            throw Object.assign(new Error('Draft session version conflict'), { code: 'VERSION_CONFLICT' });
        }
        if (session.type === 'creative-assets' || session.type === 'outline-draft') {
            const validation = await this.aiService.validateCreativeAssetsDraft({
                novelId: session.novelId,
                draft: pickSelectedCreativeDraft(normalizeCreativeDraft(session.payload), session.selection),
            });
            const normalizedDraft = validation.normalizedDraft;
            const updatedForValidation = await this.draftStore.update(session.draftSessionId, session.version, (current) => ({
                ...current,
                payload: normalizedDraft,
                selection: createSelectionFromDraft(normalizedDraft),
                validation,
                previewSummary: summarizeCreativeDraft(normalizedDraft),
            }));
            if (!validation.ok) {
                return {
                    session: updatedForValidation,
                    validation,
                };
            }
            const confirmResult = await this.aiService.confirmCreativeAssets({
                novelId: session.novelId,
                draft: normalizedDraft,
            });
            const writeback = confirmResult.success && confirmResult.createdEntities?.length
                ? {
                    writebackId: randomUUID(),
                    mode: 'creative_assets' as const,
                    status: 'committed' as const,
                    chapters: [],
                    creativeAssets: {
                        entities: confirmResult.createdEntities,
                        created: confirmResult.created,
                    },
                    committedAt: new Date().toISOString(),
                }
                : null;
            const committed = await this.draftStore.update(updatedForValidation.draftSessionId, updatedForValidation.version, (current) => ({
                ...current,
                status: confirmResult.success ? 'committed' : 'failed',
                validation,
                writebacks: writeback ? [...(current.writebacks ?? []), writeback] : current.writebacks,
            }));
            return {
                session: committed,
                validation,
                confirmResult,
            };
        }

        if (session.type === 'chapter-draft') {
            if (session.draftBatchId) {
                throw createAutomationError(
                    'INVALID_STATE',
                    'Batch child drafts must be committed through draft.batch.commit_prefix',
                    { draftBatchId: session.draftBatchId },
                );
            }
            const chapterPayload = session.payload as ChapterDraftPayload;
            const normalizedContent = appendPlainTextToLexical(chapterPayload.baseContent, chapterPayload.generatedText);
            const sourceSnapshot = chapterPayload.sourceSnapshot;
            const expectedHash = sourceSnapshot?.contentHash
                ?? createHash('sha256').update(chapterPayload.baseContent || '', 'utf8').digest('hex');
            const newWordCount = extractReadableText(normalizedContent).length;
            const { sourceChapter, updatedChapter } = await db.$transaction(async (tx) => {
                const sourceChapter = await tx.chapter.findUnique({
                    where: { id: chapterPayload.chapterId },
                    select: {
                        id: true,
                        title: true,
                        content: true,
                        wordCount: true,
                        version: true,
                        deleted: true,
                        order: true,
                        volumeId: true,
                        volume: { select: { novelId: true } },
                    },
                });
                const currentHash = sourceChapter
                    ? createHash('sha256').update(sourceChapter.content || '', 'utf8').digest('hex')
                    : '';
                if (
                    !sourceChapter
                    || sourceChapter.deleted
                    || sourceChapter.volume.novelId !== session.novelId
                    || (sourceSnapshot && sourceChapter.version !== sourceSnapshot.version)
                    || currentHash !== expectedHash
                ) {
                    throw createAutomationError(
                        'VERSION_CONFLICT',
                        '正文在草稿生成后已发生变化，请基于最新正文重新生成',
                        { chapterId: chapterPayload.chapterId },
                    );
                }
                const updated = await tx.chapter.update({
                    where: { id: sourceChapter.id },
                    data: {
                        content: normalizedContent,
                        wordCount: newWordCount,
                        version: { increment: 1 },
                        updatedAt: new Date(),
                    },
                });
                const wordCountDelta = newWordCount - sourceChapter.wordCount;
                if (wordCountDelta !== 0) {
                    await tx.novel.update({
                        where: { id: session.novelId },
                        data: { wordCount: { increment: wordCountDelta }, updatedAt: new Date() },
                    });
                }
                return { sourceChapter, updatedChapter: updated };
            });
            const writeback = {
                writebackId: randomUUID(),
                mode: 'single_chapter' as const,
                status: 'committed' as const,
                chapters: [{
                    chapterId: sourceChapter.id,
                    volumeId: sourceChapter.volumeId,
                    title: sourceChapter.title,
                    order: sourceChapter.order,
                    beforeContent: sourceChapter.content,
                    beforeWordCount: sourceChapter.wordCount,
                    beforeVersion: sourceChapter.version,
                    afterContentHash: createHash('sha256').update(updatedChapter.content || '', 'utf8').digest('hex'),
                    afterVersion: updatedChapter.version,
                }],
                committedAt: new Date().toISOString(),
            };
            const committed = await this.draftStore.update(session.draftSessionId, session.version, (current) => ({
                ...current,
                status: 'committed',
                writebacks: [...(current.writebacks ?? []), writeback],
                payload: {
                    ...(current.payload as ChapterDraftPayload),
                    content: normalizedContent,
                },
            }));
            await searchIndex.indexChapter({
                id: updatedChapter.id,
                title: updatedChapter.title,
                content: updatedChapter.content,
                volumeId: updatedChapter.volumeId,
                order: updatedChapter.order,
                novelId: session.novelId,
            });
            scheduleChapterSummaryRebuild(updatedChapter.id);
            return {
                session: committed,
                saveResult: updatedChapter,
            };
        }

        throw Object.assign(new Error(`Unsupported draft type: ${session.type}`), { code: 'INVALID_INPUT' });
    }

    async undoDraft(input: { draftSessionId: string; version: number; writebackId: string }): Promise<DraftUndoResponse> {
        return this.serializeDraftBatchCommit(async () => {
            const draftSessionId = assertRequiredString(input?.draftSessionId, 'draftSessionId');
            const version = assertRequiredNumber(input?.version, 'version');
            const writebackId = assertRequiredString(input?.writebackId, 'writebackId');
            const session = await this.draftStore.getById(draftSessionId);
            if (!session) throw createAutomationError('NOT_FOUND', 'Draft session not found');
            if (session.version !== version) throw createAutomationError('VERSION_CONFLICT', 'Draft session version conflict');
            const latestWriteback = [...(session.writebacks ?? [])].reverse().find((item) => item.status === 'committed');
            if (!latestWriteback || latestWriteback.writebackId !== writebackId) {
                throw createAutomationError('INVALID_STATE', 'Only the latest writeback can be undone');
            }
            if (latestWriteback.mode === 'creative_assets') {
                if (session.type !== 'creative-assets' && session.type !== 'outline-draft') {
                    throw createAutomationError('INVALID_STATE', 'Creative assets writeback belongs to another draft type');
                }
                const { backgroundPaths } = await db.$transaction((tx) => (
                    undoCreativeAssetsWriteback(tx as any, session.novelId, latestWriteback)
                ));
                const now = new Date().toISOString();
                const undoneWriteback = { ...latestWriteback, status: 'undone' as const, undoneAt: now };
                const updatedSession = await this.draftStore.update(session.draftSessionId, session.version, (record) => ({
                    ...record,
                    status: 'draft',
                    writebacks: (record.writebacks ?? []).map((item) => (
                        item.writebackId === writebackId ? undoneWriteback : item
                    )),
                }));
                for (const backgroundPath of backgroundPaths) {
                    try {
                        this.aiService.deleteGeneratedMapAsset(backgroundPath);
                    } catch (error) {
                        devLogError('AutomationService.undoCreativeAssets.mapCleanup', error, {
                            draftSessionId,
                            backgroundPath,
                        });
                    }
                }
                await Promise.allSettled((latestWriteback.creativeAssets?.entities ?? []).flatMap((entity) => {
                    if (entity.kind === 'mapCanvas') return [];
                    return [this.aiService.deleteRagSourceIndex(session.novelId, entity.kind, entity.entityId)];
                }));
                return { session: updatedSession, writeback: undoneWriteback };
            }
            if (latestWriteback.mode !== 'single_chapter') {
                throw createAutomationError('INVALID_STATE', 'This writeback must be undone through its batch workflow');
            }
            const snapshot = latestWriteback.chapters[0];
            if (!snapshot) throw createAutomationError('INVALID_STATE', 'The writeback has no chapter snapshot');
            const committedPayloadContent = session.type === 'chapter-draft'
                ? String((session.payload as ChapterDraftPayload).content || '')
                : '';
            const restoredChapter = await db.$transaction(async (tx) => {
                const current = await tx.chapter.findUnique({
                    where: { id: snapshot.chapterId },
                    select: { id: true, content: true, wordCount: true, version: true, deleted: true },
                });
                const currentHash = current
                    ? createHash('sha256').update(current.content || '', 'utf8').digest('hex')
                    : '';
                const readableContentUnchanged = Boolean(
                    current
                    && committedPayloadContent
                    && current.version === snapshot.afterVersion
                    && extractReadableText(current.content || '') === extractReadableText(committedPayloadContent),
                );
                if (
                    !current
                    || current.deleted
                    || current.version !== snapshot.afterVersion
                    || (currentHash !== snapshot.afterContentHash && !readableContentUnchanged)
                ) {
                    throw createAutomationError(
                        'VERSION_CONFLICT',
                        '正文已在写回后再次修改，无法安全撤销',
                        { chapterId: snapshot.chapterId },
                    );
                }
                const restored = await tx.chapter.update({
                    where: { id: snapshot.chapterId },
                    data: {
                        content: snapshot.beforeContent,
                        wordCount: snapshot.beforeWordCount,
                        version: { increment: 1 },
                        updatedAt: new Date(),
                    },
                });
                const wordCountDelta = snapshot.beforeWordCount - current.wordCount;
                if (wordCountDelta !== 0) {
                    await tx.novel.update({
                        where: { id: session.novelId },
                        data: { wordCount: { increment: wordCountDelta }, updatedAt: new Date() },
                    });
                }
                return restored;
            });
            const now = new Date().toISOString();
            const undoneWriteback = { ...latestWriteback, status: 'undone' as const, undoneAt: now };
            const updatedSession = await this.draftStore.update(session.draftSessionId, session.version, (record) => ({
                ...record,
                status: 'draft',
                writebacks: (record.writebacks ?? []).map((item) => (
                    item.writebackId === writebackId ? undoneWriteback : item
                )),
                payload: record.type === 'chapter-draft' ? {
                    ...(record.payload as ChapterDraftPayload),
                    sourceSnapshot: {
                        chapterId: restoredChapter.id,
                        version: restoredChapter.version,
                        contentHash: createHash('sha256').update(restoredChapter.content || '', 'utf8').digest('hex'),
                    },
                } : record.payload,
            }));
            await searchIndex.indexChapter({
                id: restoredChapter.id,
                title: restoredChapter.title,
                content: restoredChapter.content,
                volumeId: restoredChapter.volumeId,
                order: restoredChapter.order,
                novelId: session.novelId,
            });
            scheduleChapterSummaryRebuild(restoredChapter.id);
            return { session: updatedSession, writeback: undoneWriteback };
        });
    }

    async previewPrompt(input: {
        kind: string;
        payload: Record<string, unknown>;
    }): Promise<PromptPreviewResponse> {
        const normalizedKind = normalizePromptPreviewKind(input?.kind);
        const normalizedPayload = this.buildPromptPreviewPayload(normalizedKind, (input?.payload ?? {}) as Record<string, unknown>);
        let preview: PromptPreviewResult;
        if (normalizedKind === 'creative_assets') {
            preview = await this.aiService.previewCreativeAssetsPrompt(normalizedPayload as any);
        } else {
            preview = await this.aiService.previewContinuePrompt(normalizedPayload as any);
        }
        return {
            kind: normalizedKind,
            preview,
        };
    }

    async applyPartialCreativeDraft(input: { novelId: string; draft: CreativeAssetsDraft }): Promise<{
        validation: CreativeAssetsDraftValidationResult;
        confirmResult?: unknown;
    }> {
        assertRequiredString(input?.novelId, 'novelId');
        const validation = await this.aiService.validateCreativeAssetsDraft({
            novelId: input.novelId,
            draft: normalizeCreativeDraft(input.draft),
        });
        if (!validation.ok) {
            return { validation };
        }
        const confirmResult = await this.aiService.confirmCreativeAssets({
            novelId: input.novelId,
            draft: validation.normalizedDraft,
        });
        return { validation, confirmResult };
    }

    async invoke(method: string, params: any, context: AutomationInvokeContext): Promise<unknown> {
        return this.withTimeout(method, params, context, async (signal) => {
            const activeContext = { ...context, signal };
            const invokeStructured = <T>(task: () => Promise<T>, autoRepair = false): Promise<T> => (
                this.invokeAgentStructured(method, activeContext, task, { autoRepair })
            );
            switch (method) {
                case 'agent.generate_chat':
                    return invokeStructured(() => this.aiService.generateAgentChat(params, signal), true);
                case 'agent.generate_plan':
                    return invokeStructured(() => this.aiService.generateAgentPlan(params, signal));
                case 'agent.summarize_user_input':
                    return invokeStructured(() => this.aiService.summarizeAgentUserInput(params, signal));
                case 'agent.generate_user_input_followup':
                    return invokeStructured(() => this.aiService.generateAgentUserInputFollowup(params, signal));
                case 'agent.revise_plan':
                    return invokeStructured(() => this.aiService.reviseAgentPlan(params, signal));
                case 'agent.generate_report':
                    return invokeStructured(() => this.aiService.generateAgentReport(params, signal));
                case 'agent.generate_consistency_review':
                    return invokeStructured(() => this.aiService.generateAgentConsistencyReview(params, signal));
                case 'agent.generate_novel_bootstrap':
                    return invokeStructured(() => this.aiService.generateAgentNovelBootstrap(params, signal));
                case 'agent.generate_style_skill_pack':
                    return invokeStructured(() => this.aiService.generateAgentStyleSkillPack(params, signal));
                case 'agent.generate_skill_draft':
                    return invokeStructured(() => this.aiService.generateAgentSkillDraft(params, signal));
                case 'agent.generate_editor_range_review':
                    return invokeStructured(() => this.aiService.generateAgentEditorRangeReview(params, signal));
                case 'agent.generate_writer_range_revision_plan':
                    return invokeStructured(() => this.aiService.generateAgentWriterRangeRevisionPlan(params, signal));
                case 'agent.generate_reader_chapter_evaluation':
                    return invokeStructured(() => this.aiService.generateAgentReaderChapterEvaluation(params, signal));
                case 'agent.generate_worldbuilding_range_consistency':
                    return invokeStructured(() => this.aiService.generateAgentWorldbuildingRangeConsistency(params, signal));
                case 'agent.extract_research_claims':
                    return invokeStructured(() => this.aiService.extractAgentResearchClaims(params, signal));
                case 'agent.generate_research_fact_check':
                    return invokeStructured(() => this.aiService.generateAgentResearchFactCheck(params, signal));
                case 'agent.generate_scope_audit':
                    return invokeStructured(() => this.aiService.generateAgentScopeAudit(params, signal));
                case 'agent.generate_plotline_analysis':
                    return invokeStructured(() => this.aiService.generateAgentPlotlineAnalysis(params, signal));
                case 'agent.detect_creative_direction':
                    return invokeStructured(() => this.aiService.detectAgentCreativeDirection(params, signal));
                case 'agent.generate_chapter_beats':
                    return invokeStructured(() => this.aiService.generateChapterBeats(params, signal));
                case 'agent.repair_structured_output':
                    return this.repairStructuredOutput(params, activeContext);
                case 'agent.reprocess_saved_structured_output':
                    return this.reprocessSavedStructuredOutput(params);
                case 'agent_skill.list':
                    return this.agentSkillStore.listSkills(params || {});
                case 'agent_skill.get':
                    return this.agentSkillStore.getSkill(params);
                case 'agent_skill.binding.list':
                    return this.agentSkillStore.listBindings(params || {});
                case 'agent_skill.draft.list':
                    return this.agentSkillStore.listDrafts(params || {});
                case 'agent_skill.draft.get':
                    return this.agentSkillStore.getDraft(String(params?.draftId || params?.id || ''));
                case 'agent_skill.draft.upsert':
                    return this.agentSkillStore.upsertDraft(params);
                case 'agent_skill.draft.commit':
                    return this.agentSkillStore.commitDraft(params);
                case 'agent_skill.draft.discard':
                    return this.agentSkillStore.discardDraft(String(params?.draftId || params?.id || ''), params?.expectedVersion);
                case 'artifact.review.submit':
                    return this.reviewStore.submitArtifactReview(params as ArtifactReviewSubmitInput);
                case 'review.comment.list':
                    return this.reviewCommentStore.list(params as ReviewCommentListFilters);
                case 'review.comment.save':
                    return this.reviewCommentStore.save(params as ReviewCommentSaveInput);
                case 'review.comment.delete':
                    return this.reviewCommentStore.delete((params as ReviewCommentDeleteInput)?.commentId);
                case 'review.comment.mark_sent':
                    return this.reviewCommentStore.markSent(params as ReviewCommentMarkSentInput);
                case 'revision_task.list':
                    return this.reviewStore.listRevisionTasks(params as RevisionTaskListFilters);
                case 'revision_task.create_plan':
                    return this.createRevisionTaskPlan(params as RevisionTaskCreatePlanInput, activeContext);
                case 'revision_task.update_status':
                    return this.reviewStore.updateRevisionTaskStatus(params as import('../../shared/expertReport').RevisionTaskUpdateStatusInput);
                case 'revision_task.sync_run':
                    return this.reviewStore.syncRevisionTasksFromRun(params as import('../../shared/expertReport').RevisionTaskSyncRunInput);
                case 'rag.ask':
                    return this.aiService.askNovel(params, signal);
                case 'attachment.list':
                    return (await this.attachmentStore.list(
                        assertRequiredString(params?.novelId, 'novelId'),
                        assertRequiredString(params?.conversationId, 'conversationId'),
                    )).filter((attachment) => Boolean(attachment.messageId));
                case 'attachment.get':
                    return this.attachmentStore.readWindow({
                        novelId: assertRequiredString(params?.novelId, 'novelId'),
                        conversationId: assertRequiredString(params?.conversationId, 'conversationId'),
                        attachmentId: assertRequiredString(params?.attachmentId, 'attachmentId'),
                        offset: params?.offset,
                        limit: params?.limit,
                    });
                case 'attachment.read':
                    return this.attachmentStore.read({
                        novelId: assertRequiredString(params?.novelId, 'novelId'),
                        conversationId: assertRequiredString(params?.conversationId, 'conversationId'),
                        attachmentId: assertRequiredString(params?.attachmentId, 'attachmentId'),
                        selector: params?.selector,
                    });
                case 'attachment.outline':
                    return this.attachmentStore.outline(
                        assertRequiredString(params?.novelId, 'novelId'),
                        assertRequiredString(params?.conversationId, 'conversationId'),
                        assertRequiredString(params?.attachmentId, 'attachmentId'),
                    );
                case 'attachment.search':
                    return this.attachmentStore.search({
                        novelId: assertRequiredString(params?.novelId, 'novelId'),
                        conversationId: assertRequiredString(params?.conversationId, 'conversationId'),
                        query: assertRequiredString(params?.query, 'query'),
                        attachmentId: typeof params?.attachmentId === 'string' ? params.attachmentId : undefined,
                        limit: params?.limit,
                    });
                case 'draft.list':
                    return this.listDrafts(params);
                case 'draft.get':
                    return this.getDraft(assertRequiredString(params?.draftSessionId, 'draftSessionId'));
                case 'draft.get_active':
                    return this.getActiveDraft(params);
                case 'draft.update':
                    return this.updateDraft(params);
                case 'draft.commit':
                    return this.commitDraft(params);
                case 'draft.undo':
                    return this.undoDraft(params);
                case 'draft.discard':
                    return this.discardDraft(params);
                case 'draft.batch.list':
                    return this.listDraftBatches(params);
                case 'draft.batch.get':
                    return this.getDraftBatch(assertRequiredString(params?.draftBatchId, 'draftBatchId'));
                case 'draft.batch.create':
                    return this.createDraftBatch(params);
                case 'draft.batch.update_outline':
                    return this.updateDraftBatchOutline(params);
                case 'draft.batch.approve_outline':
                    return this.approveDraftBatchOutline(params);
                case 'draft.batch.attach_child':
                    return this.attachDraftBatchChild(params);
                case 'draft.batch.mark_stale_after':
                    return this.markDraftBatchStaleAfter(params);
                case 'draft.batch.prepare_regeneration':
                    return this.prepareDraftBatchRegeneration(params);
                case 'draft.batch.mark_failed':
                    return this.markDraftBatchChildFailed(params);
                case 'draft.batch.inspect_reconciliation':
                    return this.inspectDraftBatchReconciliation(params);
                case 'draft.batch.reconcile_unknown':
                    return this.reconcileDraftBatchUnknown(params);
                case 'draft.batch.commit_prefix':
                    return this.commitDraftBatchPrefix(params);
                case 'draft.batch.undo':
                    return this.undoDraftBatch(params);
                case 'draft.batch.discard':
                    return this.discardDraftBatch(params);
                case 'creative_assets.generate_draft':
                    return this.generateCreativeAssetsDraft(params, activeContext, 'creative-assets');
                case 'creative_assets.revise_draft':
                    return this.reviseCreativeAssetsDraftSession(params, activeContext);
                case 'outline.generate_draft':
                    return this.generateCreativeAssetsDraft({
                        ...params,
                        targetSections: ['plotLines', 'plotPoints'],
                    }, activeContext, 'outline-draft');
                case 'chapter.draft.start':
                    return this.startChapterDraftOperation(params);
                case 'chapter.draft.get_status':
                    return this.draftOperationCoordinator.get(assertRequiredString(params?.operationId, 'operationId'));
                case 'chapter.draft.cancel':
                    return this.draftOperationCoordinator.cancel(
                        assertRequiredString(params?.operationId, 'operationId'),
                        typeof params?.expectedVersion === 'number' ? params.expectedVersion : undefined,
                    );
                case 'chapter.draft.retry':
                    return this.draftOperationCoordinator.retry(
                        assertRequiredString(params?.operationId, 'operationId'),
                        typeof params?.expectedVersion === 'number' ? params.expectedVersion : undefined,
                    );
                case 'chapter.revise_draft':
                    return this.reviseChapterDraftSession(params, activeContext);
                case 'creative_assets.validate_draft':
                    return this.validateCreativeDraftSession(params);
                case 'outline.write':
                    return this.applyPartialCreativeDraft({
                        novelId: assertRequiredString(params?.novelId, 'novelId'),
                        draft: buildOutlineDraft(params),
                    });
                case 'character.create_batch':
                    return this.applyPartialCreativeDraft({
                        novelId: assertRequiredString(params?.novelId, 'novelId'),
                        draft: buildCharacterBatchDraft(params),
                    });
                case 'story_patch.apply':
                    return this.applyPartialCreativeDraft({
                        novelId: assertRequiredString(params?.novelId, 'novelId'),
                        draft: normalizeCreativeDraft(params?.draft),
                    });
                case 'prompt.preview':
                    return this.previewPrompt(params);
                default:
                    return this.aiService.executeAction({
                        actionId: method,
                        payload: params,
                    });
            }
        });
    }
}
