import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClientType } from '@novel-editor/core';
import {
    AGENT_SKILL_DOCUMENT_MAX_BYTES,
    AGENT_SKILL_DOCUMENT_MAX_COUNT,
    AGENT_SKILL_DOCUMENT_TOTAL_BYTES,
    assertAgentSkillAuthoringCommitReady,
    buildAgentSkillAuthoringInputHash,
    createAgentSkillAuthoringState,
    hashAgentSkillDocument,
    invalidateAgentSkillAuthoringState,
    isAllowedAgentSkillLogicalPath,
    readAgentSkillAuthoringState,
    serializeAgentSkillProjection,
    validateAgentSkillWorkspace,
    type AgentSkillAuthoringDocument,
    type AgentSkillAuthoringState,
} from './AgentSkillAuthoring';

export type AgentSkillDraftStatus = 'editing' | 'ready_for_review' | 'committed' | 'discarded';

export type AgentSkillDraftRecord = {
    id: string;
    status: AgentSkillDraftStatus;
    action: 'create' | 'update' | 'derive' | 'pack';
    scope: 'user' | 'novel';
    sourceNovelId?: string;
    targetSkillId?: string;
    draft: Record<string, unknown>;
    derivationReport?: Record<string, unknown>;
    expectedCurrentRevisionId?: string;
    committedRevisionId?: string;
    committedPackRevisionId?: string;
    version: number;
    createdAt: string;
    updatedAt: string;
};

export type AgentSkillRevisionRecord = {
    id: string;
    skillId: string;
    version: string;
    manifest: Record<string, unknown>;
    instructions: string;
    constraints: string[];
    examples: unknown[];
    contentHash: string;
    createdAt: string;
};

type DraftRow = {
    id: string;
    status: string;
    action: string;
    scope: string;
    sourceNovelId: string | null;
    targetSkillId: string | null;
    draftJson: string;
    derivationReportJson: string | null;
    expectedCurrentRevisionId: string | null;
    committedRevisionId: string | null;
    committedPackRevisionId: string | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
};

function parseObject(value: string | null): Record<string, unknown> | undefined {
    if (!value) return undefined;
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function toDraft(row: DraftRow): AgentSkillDraftRecord {
    return {
        id: row.id,
        status: row.status as AgentSkillDraftStatus,
        action: row.action as AgentSkillDraftRecord['action'],
        scope: row.scope as AgentSkillDraftRecord['scope'],
        ...(row.sourceNovelId ? { sourceNovelId: row.sourceNovelId } : {}),
        ...(row.targetSkillId ? { targetSkillId: row.targetSkillId } : {}),
        draft: parseObject(row.draftJson) || {},
        ...(row.derivationReportJson ? { derivationReport: parseObject(row.derivationReportJson) } : {}),
        ...(row.expectedCurrentRevisionId ? { expectedCurrentRevisionId: row.expectedCurrentRevisionId } : {}),
        ...(row.committedRevisionId ? { committedRevisionId: row.committedRevisionId } : {}),
        ...(row.committedPackRevisionId ? { committedPackRevisionId: row.committedPackRevisionId } : {}),
        version: Number(row.version),
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
    };
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function contentHash(value: unknown): string {
    return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function assertSafeJson(value: unknown): void {
    const serialized = JSON.stringify(value);
    if (serialized.length > 256_000) throw new Error('AGENT_SKILL_DRAFT_TOO_LARGE');
    if (/(?:api[_-]?key|access[_-]?token|authorization|bearer\s+[a-z0-9._-]{12,})/iu.test(serialized)) {
        throw new Error('AGENT_SKILL_SECRET_DETECTED');
    }
}

function bumpPatchVersion(version: string): string {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) return '1.0.0';
    return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function countOccurrences(contentText: string, oldText: string): number {
    if (!oldText) return 0;
    let count = 0;
    let cursor = 0;
    while (cursor <= contentText.length) {
        const found = contentText.indexOf(oldText, cursor);
        if (found < 0) break;
        count += 1;
        cursor = found + oldText.length;
    }
    return count;
}

function workspaceSummary(draft: AgentSkillDraftRecord): Record<string, unknown> {
    const state = readAgentSkillAuthoringState(draft.draft);
    if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
    return {
        draftId: draft.id,
        version: draft.version,
        status: draft.status,
        action: draft.action,
        scope: draft.scope,
        phase: state.phase,
        authoringInputHash: state.authoringInputHash,
        validatedInputHash: state.validatedInputHash,
        compiledInputHash: state.compiledInputHash,
        validationReport: state.validationReport,
        documents: state.documents.map((document) => ({
            logicalPath: document.logicalPath,
            mediaType: document.mediaType,
            contentHash: document.contentHash,
            deleted: document.deleted,
            byteLength: Buffer.byteLength(document.contentText, 'utf8'),
        })),
    };
}

export class AgentSkillStore {
    private schemaReady: Promise<void> | null = null;

    constructor(private readonly database: PrismaClientType) {}

    async ensureSchema(): Promise<void> {
        if (!this.schemaReady) {
            this.schemaReady = this.initializeSchema().catch((error) => {
                this.schemaReady = null;
                throw error;
            });
        }
        return this.schemaReady;
    }

    private async initializeSchema(): Promise<void> {
        await this.database.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentSkill" (
            "id" TEXT NOT NULL PRIMARY KEY, "stableId" TEXT NOT NULL, "scope" TEXT NOT NULL,
            "ownerNovelId" TEXT, "title" TEXT NOT NULL, "description" TEXT NOT NULL,
            "skillType" TEXT NOT NULL DEFAULT 'prompt_method', "enabled" BOOLEAN NOT NULL DEFAULT true,
            "archivedAt" DATETIME, "currentRevisionId" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "AgentSkill_ownerNovelId_fkey" FOREIGN KEY ("ownerNovelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        )`);
        await this.database.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentSkillRevision" (
            "id" TEXT NOT NULL PRIMARY KEY, "skillId" TEXT NOT NULL, "version" TEXT NOT NULL,
            "manifestJson" TEXT NOT NULL, "instructions" TEXT NOT NULL, "constraintsJson" TEXT NOT NULL DEFAULT '[]',
            "examplesJson" TEXT NOT NULL DEFAULT '[]', "contentHash" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "AgentSkillRevision_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "AgentSkill" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
        )`);
        await this.database.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentSkillDraft" (
            "id" TEXT NOT NULL PRIMARY KEY, "status" TEXT NOT NULL, "action" TEXT NOT NULL, "scope" TEXT NOT NULL,
            "sourceNovelId" TEXT, "targetSkillId" TEXT, "draftJson" TEXT NOT NULL, "derivationReportJson" TEXT,
            "expectedCurrentRevisionId" TEXT, "committedRevisionId" TEXT, "committedPackRevisionId" TEXT,
            "version" INTEGER NOT NULL DEFAULT 1, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "AgentSkillDraft_sourceNovelId_fkey" FOREIGN KEY ("sourceNovelId") REFERENCES "Novel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
            CONSTRAINT "AgentSkillDraft_targetSkillId_fkey" FOREIGN KEY ("targetSkillId") REFERENCES "AgentSkill" ("id") ON DELETE SET NULL ON UPDATE CASCADE
        )`);
        await this.database.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentSkillBinding" (
            "id" TEXT NOT NULL PRIMARY KEY, "skillId" TEXT NOT NULL, "novelId" TEXT, "roleId" TEXT,
            "operationId" TEXT, "presetId" TEXT, "bindingType" TEXT NOT NULL, "priority" INTEGER NOT NULL DEFAULT 0,
            "enabled" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "AgentSkillBinding_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "AgentSkill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "AgentSkillBinding_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        )`);
        await this.database.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentSkillPack" (
            "id" TEXT NOT NULL PRIMARY KEY, "stableId" TEXT NOT NULL, "scope" TEXT NOT NULL, "ownerNovelId" TEXT,
            "title" TEXT NOT NULL, "description" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
            "archivedAt" DATETIME, "currentRevisionId" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "AgentSkillPack_ownerNovelId_fkey" FOREIGN KEY ("ownerNovelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        )`);
        await this.database.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentSkillPackRevision" (
            "id" TEXT NOT NULL PRIMARY KEY, "packId" TEXT NOT NULL, "version" TEXT NOT NULL,
            "bindingsJson" TEXT NOT NULL, "contentHash" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "AgentSkillPackRevision_packId_fkey" FOREIGN KEY ("packId") REFERENCES "AgentSkillPack" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
        )`);
        await this.database.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_skill_scope_owner_stable" ON "AgentSkill"("scope", "ownerNovelId", "stableId")');
        await this.database.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_skill_revision_version" ON "AgentSkillRevision"("skillId", "version")');
        await this.database.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_skill_pack_scope_owner_stable" ON "AgentSkillPack"("scope", "ownerNovelId", "stableId")');
        await this.database.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_skill_pack_revision_version" ON "AgentSkillPackRevision"("packId", "version")');
        await this.database.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "idx_agent_skill_visible" ON "AgentSkill"("scope", "ownerNovelId", "enabled", "updatedAt")');
        await this.database.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "idx_agent_skill_draft_novel_status" ON "AgentSkillDraft"("sourceNovelId", "status", "updatedAt")');
        await this.database.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "idx_agent_skill_binding_resolution" ON "AgentSkillBinding"("novelId", "roleId", "operationId", "enabled")');
        await this.database.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "idx_agent_skill_pack_visible" ON "AgentSkillPack"("scope", "ownerNovelId", "enabled", "updatedAt")');
    }

    async listSkills(filters: { novelId?: string; includeArchived?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
        await this.ensureSchema();
        const skills = await this.database.agentSkill.findMany({
            where: {
                ...(filters.includeArchived ? {} : { archivedAt: null, enabled: true }),
                OR: [
                    { scope: 'user', ownerNovelId: null },
                    ...(filters.novelId ? [{ scope: 'novel', ownerNovelId: filters.novelId }] : []),
                ],
            },
            orderBy: [{ scope: 'asc' }, { title: 'asc' }],
        });
        const revisionIds = skills.map((item) => item.currentRevisionId).filter((item): item is string => Boolean(item));
        const revisions = revisionIds.length
            ? await this.database.agentSkillRevision.findMany({ where: { id: { in: revisionIds } } })
            : [];
        const byId = new Map(revisions.map((item) => [item.id, item]));
        return skills.map((skill) => {
            const revision = skill.currentRevisionId ? byId.get(skill.currentRevisionId) : undefined;
            const manifest = revision ? parseObject(revision.manifestJson) || {} : {};
            return {
                id: skill.id,
                stableId: skill.stableId,
                title: skill.title,
                description: skill.description,
                scope: skill.scope,
                ownerNovelId: skill.ownerNovelId,
                enabled: skill.enabled,
                revisionId: revision?.id,
                version: revision?.version,
                contentHash: revision?.contentHash,
                manifest,
            };
        });
    }

    async getSkill(input: { skillId: string; revisionId?: string }): Promise<Record<string, unknown> | null> {
        await this.ensureSchema();
        const skill = await this.database.agentSkill.findUnique({ where: { id: input.skillId } });
        if (!skill) return null;
        const revisionId = input.revisionId || skill.currentRevisionId;
        const revision = revisionId
            ? await this.database.agentSkillRevision.findFirst({ where: { id: revisionId, skillId: skill.id } })
            : null;
        return {
            id: skill.id,
            stableId: skill.stableId,
            title: skill.title,
            description: skill.description,
            scope: skill.scope,
            ownerNovelId: skill.ownerNovelId,
            enabled: skill.enabled,
            currentRevisionId: skill.currentRevisionId,
            revision: revision ? {
                id: revision.id,
                version: revision.version,
                manifest: parseObject(revision.manifestJson) || {},
                instructions: revision.instructions,
                constraints: JSON.parse(revision.constraintsJson),
                examples: JSON.parse(revision.examplesJson),
                contentHash: revision.contentHash,
                createdAt: revision.createdAt.toISOString(),
            } : null,
        };
    }

    async listBindings(filters: { novelId?: string } = {}): Promise<Array<Record<string, unknown>>> {
        await this.ensureSchema();
        const rows = await this.database.agentSkillBinding.findMany({
            where: {
                enabled: true,
                OR: [
                    { novelId: null },
                    ...(filters.novelId ? [{ novelId: filters.novelId }] : []),
                ],
                skill: { enabled: true, archivedAt: null },
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        });
        return rows.map((row) => ({
            id: row.id,
            skillId: row.skillId,
            novelId: row.novelId,
            roleId: row.roleId,
            operationId: row.operationId,
            presetId: row.presetId,
            bindingType: row.bindingType,
            priority: row.priority,
        }));
    }

    async listDrafts(filters: { sourceNovelId?: string; status?: AgentSkillDraftStatus } = {}): Promise<AgentSkillDraftRecord[]> {
        await this.ensureSchema();
        const rows = await this.database.agentSkillDraft.findMany({
            where: {
                ...(filters.sourceNovelId ? { sourceNovelId: filters.sourceNovelId } : {}),
                ...(filters.status ? { status: filters.status } : {}),
            },
            orderBy: { updatedAt: 'desc' },
        });
        return rows.map((row) => toDraft(row as DraftRow));
    }

    async getDraft(id: string): Promise<AgentSkillDraftRecord | null> {
        await this.ensureSchema();
        const row = await this.database.agentSkillDraft.findUnique({ where: { id } });
        return row ? toDraft(row as DraftRow) : null;
    }

    async upsertDraft(input: {
        id?: string;
        expectedVersion?: number;
        status?: AgentSkillDraftStatus;
        action: AgentSkillDraftRecord['action'];
        scope: AgentSkillDraftRecord['scope'];
        sourceNovelId?: string;
        targetSkillId?: string;
        draft: Record<string, unknown>;
        derivationReport?: Record<string, unknown>;
        expectedCurrentRevisionId?: string;
    }): Promise<AgentSkillDraftRecord> {
        await this.ensureSchema();
        assertSafeJson(input.draft);
        assertSafeJson(input.derivationReport || {});
        const id = input.id || randomUUID();
        const existing = input.id ? await this.database.agentSkillDraft.findUnique({ where: { id } }) : null;
        if (!existing && input.id && input.expectedVersion !== undefined) {
            throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        }
        if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
            throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        }
        const payload = {
            status: input.status || 'editing',
            action: input.action,
            scope: input.scope,
            sourceNovelId: input.sourceNovelId || null,
            targetSkillId: input.targetSkillId || null,
            draftJson: JSON.stringify(input.draft),
            derivationReportJson: input.derivationReport ? JSON.stringify(input.derivationReport) : null,
            expectedCurrentRevisionId: input.expectedCurrentRevisionId || null,
        };
        if (existing) {
            const updated = await this.database.agentSkillDraft.updateMany({
                where: { id, version: input.expectedVersion ?? existing.version },
                data: { ...payload, version: { increment: 1 }, updatedAt: new Date() },
            });
            if (updated.count !== 1) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
            const row = await this.database.agentSkillDraft.findUnique({ where: { id } });
            if (!row) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
            return toDraft(row as DraftRow);
        }
        const row = await this.database.agentSkillDraft.create({ data: { id, ...payload } });
        return toDraft(row as DraftRow);
    }

    async createAuthoringWorkspace(input: {
        action?: AgentSkillDraftRecord['action'];
        scope: AgentSkillDraftRecord['scope'];
        sourceNovelId?: string;
        targetSkillId?: string;
        expectedCurrentRevisionId?: string;
        logicalPath?: string;
        contentText?: string;
        sourceSnapshotRefs?: string[];
        pack?: Record<string, unknown>;
        derivationReport?: Record<string, unknown>;
    }): Promise<Record<string, unknown>> {
        await this.ensureSchema();
        const action = input.action || (input.targetSkillId ? 'update' : 'create');
        if (input.scope === 'novel' && !input.sourceNovelId) throw new Error('AGENT_SKILL_WORKSPACE_NOVEL_REQUIRED');
        if (action === 'pack' && input.targetSkillId) throw new Error('AGENT_SKILL_PACK_UPDATE_UNSUPPORTED');
        let contentText = input.contentText;
        let expectedCurrentRevisionId = input.expectedCurrentRevisionId;
        if (input.targetSkillId) {
            const existing = await this.getSkill({ skillId: input.targetSkillId, revisionId: expectedCurrentRevisionId });
            if (!existing) throw new Error('AGENT_SKILL_NOT_FOUND');
            if (String(existing.scope || '') !== input.scope) throw new Error('AGENT_SKILL_WORKSPACE_SCOPE_MISMATCH');
            const revision = asObject(existing.revision);
            if (!revision.id) throw new Error('AGENT_SKILL_REVISION_NOT_FOUND');
            expectedCurrentRevisionId = String(revision.id);
            if (contentText === undefined) {
                const nextRevision = { ...revision, version: bumpPatchVersion(String(revision.version || '')) };
                contentText = serializeAgentSkillProjection({
                    definition: {
                        stableId: existing.stableId,
                        title: existing.title,
                        description: existing.description,
                    },
                    revision: nextRevision,
                }, input.scope);
            }
        }
        const logicalPath = input.logicalPath || (action === 'pack' ? 'skill/SKILL.md' : 'SKILL.md');
        const authoring = createAgentSkillAuthoringState({
            logicalPath,
            contentText,
            sourceSnapshotRefs: input.sourceSnapshotRefs,
            pack: input.pack,
        });
        const created = await this.upsertDraft({
            action,
            scope: input.scope,
            status: 'editing',
            sourceNovelId: input.sourceNovelId,
            targetSkillId: input.targetSkillId,
            expectedCurrentRevisionId,
            draft: {
                authoring,
                ...(input.pack ? { pack: input.pack } : {}),
            },
            derivationReport: input.derivationReport,
        });
        return workspaceSummary(created);
    }

    async listAuthoringDocuments(input: { draftId: string }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        return workspaceSummary(draft);
    }

    async readAuthoringDocument(input: { draftId: string; logicalPath: string }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        const state = readAgentSkillAuthoringState(draft.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const logicalPath = String(input?.logicalPath || '');
        const document = state.documents.find((item) => item.logicalPath === logicalPath && !item.deleted);
        if (!document) throw new Error('AGENT_SKILL_WORKSPACE_DOCUMENT_NOT_FOUND');
        return {
            draftId: draft.id,
            version: draft.version,
            phase: state.phase,
            logicalPath: document.logicalPath,
            mediaType: document.mediaType,
            contentText: document.contentText,
            contentHash: document.contentHash,
            byteLength: Buffer.byteLength(document.contentText, 'utf8'),
        };
    }

    private async persistAuthoringMutation(
        draft: AgentSkillDraftRecord,
        nextDraft: Record<string, unknown>,
        expectedVersion: number,
        status: AgentSkillDraftStatus = 'editing',
    ): Promise<AgentSkillDraftRecord> {
        return this.upsertDraft({
            id: draft.id,
            expectedVersion,
            status,
            action: draft.action,
            scope: draft.scope,
            sourceNovelId: draft.sourceNovelId,
            targetSkillId: draft.targetSkillId,
            expectedCurrentRevisionId: draft.expectedCurrentRevisionId,
            draft: nextDraft,
            derivationReport: draft.derivationReport,
        });
    }

    async writeAuthoringDocument(input: {
        draftId: string;
        expectedVersion: number;
        logicalPath: string;
        contentText: string;
        mediaType?: 'text/markdown';
    }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        if (draft.status === 'committed' || draft.status === 'discarded') throw new Error('AGENT_SKILL_DRAFT_NOT_EDITABLE');
        const state = readAgentSkillAuthoringState(draft.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const logicalPath = String(input?.logicalPath || '');
        if (!isAllowedAgentSkillLogicalPath(logicalPath)) throw new Error('AGENT_SKILL_WORKSPACE_PATH_INVALID');
        if (input.mediaType && input.mediaType !== 'text/markdown') throw new Error('AGENT_SKILL_WORKSPACE_MEDIA_TYPE_INVALID');
        if (typeof input.contentText !== 'string') throw new Error('AGENT_SKILL_WORKSPACE_CONTENT_REQUIRED');
        if (Buffer.byteLength(input.contentText, 'utf8') > AGENT_SKILL_DOCUMENT_MAX_BYTES) {
            throw new Error('AGENT_SKILL_WORKSPACE_DOCUMENT_TOO_LARGE');
        }
        const documents = [...state.documents];
        const existingIndex = documents.findIndex((document) => document.logicalPath === logicalPath);
        const document: AgentSkillAuthoringDocument = {
            logicalPath,
            mediaType: 'text/markdown',
            contentText: input.contentText,
            contentHash: hashAgentSkillDocument(input.contentText),
            deleted: false,
        };
        if (existingIndex >= 0) documents[existingIndex] = document;
        else documents.push(document);
        if (documents.length > AGENT_SKILL_DOCUMENT_MAX_COUNT) throw new Error('AGENT_SKILL_WORKSPACE_DOCUMENT_COUNT_EXCEEDED');
        const totalBytes = documents.filter((item) => !item.deleted)
            .reduce((sum, item) => sum + Buffer.byteLength(item.contentText, 'utf8'), 0);
        if (totalBytes > AGENT_SKILL_DOCUMENT_TOTAL_BYTES) throw new Error('AGENT_SKILL_WORKSPACE_TOTAL_TOO_LARGE');
        const nextDraft = { ...draft.draft };
        nextDraft.authoring = invalidateAgentSkillAuthoringState({ ...state, documents }, nextDraft.pack);
        const updated = await this.persistAuthoringMutation(draft, nextDraft, input.expectedVersion);
        return workspaceSummary(updated);
    }

    async patchAuthoringDocument(input: {
        draftId: string;
        expectedVersion: number;
        logicalPath: string;
        expectedContentHash: string;
        oldText: string;
        newText: string;
    }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        if (draft.status === 'committed' || draft.status === 'discarded') throw new Error('AGENT_SKILL_DRAFT_NOT_EDITABLE');
        const state = readAgentSkillAuthoringState(draft.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const document = state.documents.find((item) => item.logicalPath === input.logicalPath && !item.deleted);
        if (!document) throw new Error('AGENT_SKILL_WORKSPACE_DOCUMENT_NOT_FOUND');
        if (!input.oldText || typeof input.newText !== 'string') throw new Error('AGENT_SKILL_WORKSPACE_PATCH_INVALID');
        if (document.contentHash !== input.expectedContentHash) throw new Error('AGENT_SKILL_WORKSPACE_CONTENT_CONFLICT');
        if (countOccurrences(document.contentText, input.oldText) !== 1) throw new Error('AGENT_SKILL_WORKSPACE_PATCH_CONFLICT');
        const contentText = document.contentText.replace(input.oldText, input.newText);
        return this.writeAuthoringDocument({
            draftId: draft.id,
            expectedVersion: input.expectedVersion,
            logicalPath: document.logicalPath,
            contentText,
            mediaType: 'text/markdown',
        });
    }

    async removeAuthoringDocument(input: {
        draftId: string;
        expectedVersion: number;
        logicalPath: string;
        expectedContentHash?: string;
    }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        if (draft.status === 'committed' || draft.status === 'discarded') throw new Error('AGENT_SKILL_DRAFT_NOT_EDITABLE');
        const state = readAgentSkillAuthoringState(draft.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const index = state.documents.findIndex((item) => item.logicalPath === input.logicalPath && !item.deleted);
        if (index < 0) throw new Error('AGENT_SKILL_WORKSPACE_DOCUMENT_NOT_FOUND');
        if (input.expectedContentHash && state.documents[index].contentHash !== input.expectedContentHash) {
            throw new Error('AGENT_SKILL_WORKSPACE_CONTENT_CONFLICT');
        }
        const documents = state.documents.map((document, documentIndex) => (
            documentIndex === index ? { ...document, deleted: true } : document
        ));
        const nextDraft = { ...draft.draft };
        nextDraft.authoring = invalidateAgentSkillAuthoringState({ ...state, documents }, nextDraft.pack);
        const updated = await this.persistAuthoringMutation(draft, nextDraft, input.expectedVersion);
        return workspaceSummary(updated);
    }

    async setAuthoringPack(input: {
        draftId: string;
        expectedVersion: number;
        pack: Record<string, unknown>;
    }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        if (draft.action !== 'pack') throw new Error('AGENT_SKILL_WORKSPACE_NOT_PACK');
        if (draft.status === 'committed' || draft.status === 'discarded') throw new Error('AGENT_SKILL_DRAFT_NOT_EDITABLE');
        const state = readAgentSkillAuthoringState(draft.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const pack = asObject(input.pack);
        assertSafeJson(pack);
        const nextDraft: Record<string, unknown> = { ...draft.draft, pack };
        nextDraft.authoring = invalidateAgentSkillAuthoringState(state, pack);
        const updated = await this.persistAuthoringMutation(draft, nextDraft, input.expectedVersion);
        return workspaceSummary(updated);
    }

    async validateAuthoringWorkspace(input: {
        draftId: string;
        expectedVersion: number;
        finalAttempt?: boolean;
    }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        if (draft.status === 'committed' || draft.status === 'discarded') throw new Error('AGENT_SKILL_DRAFT_NOT_EDITABLE');
        const state = readAgentSkillAuthoringState(draft.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const validation = validateAgentSkillWorkspace({ draft: draft.draft, action: draft.action, scope: draft.scope });
        const nextState: AgentSkillAuthoringState = {
            ...state,
            phase: validation.report.ok ? 'validating' : input.finalAttempt ? 'needs_attention' : 'revising',
            validationReport: validation.report,
            validatedInputHash: validation.report.ok ? validation.report.inputHash : undefined,
            compiledInputHash: undefined,
        };
        const nextDraft = { ...draft.draft, authoring: nextState };
        const updated = await this.persistAuthoringMutation(draft, nextDraft, input.expectedVersion);
        return workspaceSummary(updated);
    }

    async compileAuthoringWorkspace(input: {
        draftId: string;
        expectedVersion: number;
    }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        if (draft.status === 'committed' || draft.status === 'discarded') throw new Error('AGENT_SKILL_DRAFT_NOT_EDITABLE');
        const state = readAgentSkillAuthoringState(draft.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const inputHash = buildAgentSkillAuthoringInputHash(state.documents, draft.draft.pack);
        if (state.authoringInputHash !== inputHash || state.validatedInputHash !== inputHash) {
            throw new Error('AGENT_SKILL_WORKSPACE_VALIDATION_REQUIRED');
        }
        const validation = validateAgentSkillWorkspace({ draft: draft.draft, action: draft.action, scope: draft.scope });
        if (!validation.report.ok || !validation.projection) throw new Error('AGENT_SKILL_WORKSPACE_VALIDATION_REQUIRED');
        const nextState: AgentSkillAuthoringState = {
            ...state,
            phase: 'compiled',
            validationReport: validation.report,
            validatedInputHash: inputHash,
            compiledInputHash: inputHash,
        };
        const projection = validation.projection as Record<string, unknown>;
        const nextDraft = { ...draft.draft, ...projection, authoring: nextState };
        const updated = await this.persistAuthoringMutation(draft, nextDraft, input.expectedVersion, 'ready_for_review');
        return workspaceSummary(updated);
    }

    async diffAuthoringWorkspace(input: { draftId: string }): Promise<Record<string, unknown>> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        const state = readAgentSkillAuthoringState(draft.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const activeDocuments = state.documents.filter((document) => !document.deleted);
        let beforeText = '';
        if (draft.targetSkillId) {
            const existing = await this.getSkill({ skillId: draft.targetSkillId, revisionId: draft.expectedCurrentRevisionId });
            const revision = asObject(existing?.revision);
            if (existing && revision.id) {
                beforeText = serializeAgentSkillProjection({
                    definition: {
                        stableId: existing.stableId,
                        title: existing.title,
                        description: existing.description,
                    },
                    revision,
                }, draft.scope);
            }
        }
        const currentHash = buildAgentSkillAuthoringInputHash(state.documents, draft.draft.pack);
        return {
            draftId: draft.id,
            version: draft.version,
            stale: state.compiledInputHash !== currentHash,
            documents: activeDocuments.map((document) => ({
                logicalPath: document.logicalPath,
                changeType: beforeText && document.logicalPath === 'SKILL.md' ? 'modified' : 'added',
                beforeText: document.logicalPath === 'SKILL.md' ? beforeText : '',
                afterText: document.contentText,
                beforeHash: document.logicalPath === 'SKILL.md' && beforeText ? hashAgentSkillDocument(beforeText) : undefined,
                afterHash: document.contentHash,
            })),
        };
    }

    async discardDraft(id: string, expectedVersion?: number): Promise<AgentSkillDraftRecord> {
        const draft = await this.getDraft(id);
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        return this.upsertDraft({
            id,
            expectedVersion: expectedVersion ?? draft.version,
            status: 'discarded',
            action: draft.action,
            scope: draft.scope,
            sourceNovelId: draft.sourceNovelId,
            targetSkillId: draft.targetSkillId,
            draft: draft.draft,
            derivationReport: draft.derivationReport,
            expectedCurrentRevisionId: draft.expectedCurrentRevisionId,
        });
    }

    async commitDraft(input: { draftId: string; expectedVersion: number; confirmed: true }): Promise<any> {
        const candidate = await this.getDraft(input.draftId);
        if (candidate?.action === 'pack') return this.commitPackDraft(input, candidate);
        return this.commitSingleSkillDraft(input, candidate);
    }

    private async commitSingleSkillDraft(input: { draftId: string; expectedVersion: number; confirmed: true }, prefetched?: AgentSkillDraftRecord | null): Promise<{
        draft: AgentSkillDraftRecord;
        revision: AgentSkillRevisionRecord;
    }> {
        await this.ensureSchema();
        if (input.confirmed !== true) throw new Error('AGENT_SKILL_COMMIT_REQUIRES_CONFIRMATION');
        const draft = prefetched ?? await this.getDraft(input.draftId);
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        assertAgentSkillAuthoringCommitReady({
            draft: draft.draft,
            action: draft.action,
            scope: draft.scope,
            status: draft.status,
        });
        if (draft.status !== 'ready_for_review' && draft.status !== 'editing') throw new Error('AGENT_SKILL_DRAFT_NOT_COMMITTABLE');
        const definition = asObject(draft.draft.definition);
        const proposedRevision = asObject(draft.draft.revision);
        const stableId = String(definition.stableId || '').trim();
        const title = String(definition.title || '').trim();
        const description = String(definition.description || '').trim();
        const instructions = String(proposedRevision.instructions || '').trim();
        const version = String(proposedRevision.version || '1.0.0').trim();
        if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(stableId) || !title || !description || !instructions || !/^\d+\.\d+\.\d+$/.test(version)) {
            throw new Error('AGENT_SKILL_DRAFT_INVALID');
        }
        const manifest = asObject(proposedRevision.manifest);
        const constraints = Array.isArray(proposedRevision.constraints) ? proposedRevision.constraints : [];
        const examples = Array.isArray(proposedRevision.examples) ? proposedRevision.examples : [];
        const hashPayload = { stableId, version, manifest, instructions, constraints, examples };
        assertSafeJson(hashPayload);
        const revisionId = randomUUID();
        const skillId = draft.targetSkillId || randomUUID();
        const hash = contentHash(hashPayload);
        const result = await this.database.$transaction(async (tx) => {
            const current = draft.targetSkillId
                ? await tx.agentSkill.findUnique({ where: { id: draft.targetSkillId } })
                : null;
            if (draft.targetSkillId && !current) throw new Error('AGENT_SKILL_NOT_FOUND');
            if (current && (current.currentRevisionId || null) !== (draft.expectedCurrentRevisionId || null)) {
                throw new Error('AGENT_SKILL_CURRENT_REVISION_CONFLICT');
            }
            if (!current) {
                await tx.agentSkill.create({
                    data: {
                        id: skillId,
                        stableId,
                        scope: draft.scope,
                        ownerNovelId: draft.scope === 'novel' ? draft.sourceNovelId || null : null,
                        title,
                        description,
                        skillType: 'prompt_method',
                    },
                });
            }
            const revision = await tx.agentSkillRevision.create({
                data: {
                    id: revisionId,
                    skillId,
                    version,
                    manifestJson: JSON.stringify(manifest),
                    instructions,
                    constraintsJson: JSON.stringify(constraints),
                    examplesJson: JSON.stringify(examples),
                    contentHash: hash,
                },
            });
            await tx.agentSkill.update({
                where: { id: skillId },
                data: { title, description, currentRevisionId: revisionId },
            });
            const updated = await tx.agentSkillDraft.updateMany({
                where: { id: draft.id, version: draft.version },
                data: { status: 'committed', committedRevisionId: revisionId, version: { increment: 1 }, updatedAt: new Date() },
            });
            if (updated.count !== 1) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
            return revision;
        });
        const committed = await this.getDraft(draft.id);
        if (!committed) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        return {
            draft: committed,
            revision: {
                id: result.id,
                skillId: result.skillId,
                version: result.version,
                manifest: parseObject(result.manifestJson) || {},
                instructions: result.instructions,
                constraints: JSON.parse(result.constraintsJson) as string[],
                examples: JSON.parse(result.examplesJson) as unknown[],
                contentHash: result.contentHash,
                createdAt: result.createdAt.toISOString(),
            },
        };
    }

    private async commitPackDraft(
        input: { draftId: string; expectedVersion: number; confirmed: true },
        prefetched?: AgentSkillDraftRecord | null,
    ): Promise<Record<string, unknown>> {
        await this.ensureSchema();
        if (input.confirmed !== true) throw new Error('AGENT_SKILL_COMMIT_REQUIRES_CONFIRMATION');
        const draft = prefetched ?? await this.getDraft(input.draftId);
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        assertAgentSkillAuthoringCommitReady({
            draft: draft.draft,
            action: draft.action,
            scope: draft.scope,
            status: draft.status,
        });
        if (draft.status !== 'ready_for_review' && draft.status !== 'editing') throw new Error('AGENT_SKILL_DRAFT_NOT_COMMITTABLE');
        const rawSkills = Array.isArray(draft.draft.skills) ? draft.draft.skills : [];
        const pack = asObject(draft.draft.pack);
        const packDefinition = asObject(pack.definition);
        const packRevision = asObject(pack.revision);
        if (rawSkills.length < 2 || rawSkills.length > 3) throw new Error('AGENT_SKILL_PACK_DRAFT_INVALID');
        const normalizedSkills = rawSkills.map((raw) => {
            const entry = asObject(raw);
            const draftKey = String(entry.draftKey || '').trim();
            const definition = asObject(entry.definition);
            const revision = asObject(entry.revision);
            const stableId = String(definition.stableId || '').trim();
            const title = String(definition.title || '').trim();
            const description = String(definition.description || '').trim();
            const version = String(revision.version || '1.0.0').trim();
            const instructions = String(revision.instructions || '').trim();
            if (!draftKey || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(stableId)
                || !title || !description || !instructions || !/^\d+\.\d+\.\d+$/.test(version)) {
                throw new Error('AGENT_SKILL_PACK_DRAFT_INVALID');
            }
            const manifest = asObject(revision.manifest);
            const constraints = Array.isArray(revision.constraints) ? revision.constraints : [];
            const examples = Array.isArray(revision.examples) ? revision.examples : [];
            return { draftKey, stableId, title, description, version, instructions, manifest, constraints, examples };
        });
        if (new Set(normalizedSkills.map((item) => item.draftKey)).size !== normalizedSkills.length
            || new Set(normalizedSkills.map((item) => item.stableId)).size !== normalizedSkills.length) {
            throw new Error('AGENT_SKILL_PACK_DRAFT_INVALID');
        }
        const packStableId = String(packDefinition.stableId || '').trim();
        const packTitle = String(packDefinition.title || '').trim();
        const packDescription = String(packDefinition.description || '').trim();
        const packVersion = String(packRevision.version || '1.0.0').trim();
        const bindings = Array.isArray(packRevision.bindings) ? packRevision.bindings.map(asObject) : [];
        const knownKeys = new Set(normalizedSkills.map((item) => item.draftKey));
        if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(packStableId) || !packTitle || !packDescription
            || !/^\d+\.\d+\.\d+$/.test(packVersion) || !bindings.length
            || bindings.some((item) => !String(item.operationId || '').trim() || !String(item.roleId || '').trim()
                || !knownKeys.has(String(item.primaryDraftKey || ''))
                || (item.auxiliaryDraftKey && !knownKeys.has(String(item.auxiliaryDraftKey))))) {
            throw new Error('AGENT_SKILL_PACK_DRAFT_INVALID');
        }
        assertSafeJson({ normalizedSkills, packStableId, packVersion, bindings });
        const ownerNovelId = draft.scope === 'novel' ? draft.sourceNovelId || null : null;
        const result = await this.database.$transaction(async (tx) => {
            const committedSkills: Array<Record<string, unknown>> = [];
            const byDraftKey = new Map<string, { skillId: string; revisionId: string }>();
            for (const item of normalizedSkills) {
                const skillId = randomUUID();
                const revisionId = randomUUID();
                const hashPayload = {
                    stableId: item.stableId, version: item.version, manifest: item.manifest,
                    instructions: item.instructions, constraints: item.constraints, examples: item.examples,
                };
                await tx.agentSkill.create({
                    data: {
                        id: skillId, stableId: item.stableId, scope: draft.scope, ownerNovelId,
                        title: item.title, description: item.description, skillType: 'prompt_method',
                    },
                });
                const revision = await tx.agentSkillRevision.create({
                    data: {
                        id: revisionId, skillId, version: item.version,
                        manifestJson: JSON.stringify(item.manifest), instructions: item.instructions,
                        constraintsJson: JSON.stringify(item.constraints), examplesJson: JSON.stringify(item.examples),
                        contentHash: contentHash(hashPayload),
                    },
                });
                await tx.agentSkill.update({ where: { id: skillId }, data: { currentRevisionId: revisionId } });
                byDraftKey.set(item.draftKey, { skillId, revisionId });
                committedSkills.push({ draftKey: item.draftKey, skillId, revisionId, version: revision.version, contentHash: revision.contentHash });
            }
            const resolvedBindings = bindings.map((binding) => ({
                operationId: String(binding.operationId),
                roleId: String(binding.roleId),
                primary: byDraftKey.get(String(binding.primaryDraftKey))!,
                auxiliary: binding.auxiliaryDraftKey ? byDraftKey.get(String(binding.auxiliaryDraftKey))! : null,
            }));
            const packId = randomUUID();
            const packRevisionId = randomUUID();
            await tx.agentSkillPack.create({
                data: {
                    id: packId, stableId: packStableId, scope: draft.scope, ownerNovelId,
                    title: packTitle, description: packDescription,
                },
            });
            const persistedPackRevision = await tx.agentSkillPackRevision.create({
                data: {
                    id: packRevisionId, packId, version: packVersion,
                    bindingsJson: JSON.stringify(resolvedBindings),
                    contentHash: contentHash({ stableId: packStableId, version: packVersion, bindings: resolvedBindings }),
                },
            });
            await tx.agentSkillPack.update({ where: { id: packId }, data: { currentRevisionId: packRevisionId } });
            for (const binding of resolvedBindings) {
                await tx.agentSkillBinding.create({
                    data: {
                        id: randomUUID(), skillId: binding.primary.skillId, novelId: ownerNovelId,
                        roleId: binding.roleId, operationId: binding.operationId,
                        bindingType: 'pack_primary', priority: 100,
                    },
                });
                if (binding.auxiliary) {
                    await tx.agentSkillBinding.create({
                        data: {
                            id: randomUUID(), skillId: binding.auxiliary.skillId, novelId: ownerNovelId,
                            roleId: binding.roleId, operationId: binding.operationId,
                            bindingType: 'pack_auxiliary', priority: 50,
                        },
                    });
                }
            }
            const updated = await tx.agentSkillDraft.updateMany({
                where: { id: draft.id, version: draft.version },
                data: { status: 'committed', committedPackRevisionId: packRevisionId, version: { increment: 1 }, updatedAt: new Date() },
            });
            if (updated.count !== 1) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
            return {
                pack: { id: packId, stableId: packStableId, title: packTitle, description: packDescription },
                packRevision: {
                    id: persistedPackRevision.id, version: persistedPackRevision.version,
                    contentHash: persistedPackRevision.contentHash, bindings: resolvedBindings,
                },
                skills: committedSkills,
            };
        });
        const committed = await this.getDraft(draft.id);
        if (!committed) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        return { draft: committed, ...result };
    }
}
