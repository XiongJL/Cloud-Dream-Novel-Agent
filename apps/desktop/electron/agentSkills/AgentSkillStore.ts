import { createHash, randomUUID } from 'node:crypto';
import { validateSkillExecutionHints } from '../../shared/skillExecutionHints';
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
    prepareAgentSkillAuthoringDraft,
    readAgentSkillAuthoringState,
    serializeAgentSkillProjection,
    validateAgentSkillWorkspace,
    validatePack,
    type AgentSkillAuthoringDocument,
    type AgentSkillAuthoringState,
    type AgentSkillAuthorRules,
    type AgentSkillAuthoringRepair,
    type AgentSkillAuthoringValidationReport,
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
    publicationScope?: 'user' | 'novel';
    publicationOwnerNovelId?: string;
    publicationVersion?: number;
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
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
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

function requiresStyleQuality(report?: Record<string, unknown>): boolean {
    return report?.qualityRequired === true || (report?.qualityRequired !== false
        && report?.kind === 'style_skill_pack_extraction' && Number(asObject(report.sourceCoverage).chapterCount) > 0);
}

function styleMemberKeys(draft: Record<string, unknown>): string[] {
    const skills = Array.isArray(draft.skills) ? draft.skills.map(asObject) : [];
    const keys = skills.map(skill => String(skill.draftKey || '').replace(/-/g, '_')).filter(Boolean);
    if (keys.length) return keys;
    const paths = readAgentSkillAuthoringState(draft)?.documents.filter(document => !document.deleted).map(document => document.logicalPath) || [];
    const names: Record<string, string> = {'language-style/SKILL.md': 'language_style', 'suspense-release/SKILL.md': 'suspense_release', 'ensemble-progression/SKILL.md': 'ensemble_progression'};
    return paths.map(path => names[path]).filter(Boolean);
}

function assertStyleQuality(report: Record<string, unknown>, inputHash: string, draft: Record<string, unknown>, fidelityRequired = false): void {
    const members = styleMemberKeys(draft);
    const reviews = Array.isArray(report.documentReviews) ? report.documentReviews.map(asObject) : [];
    const trials = asObject(report.trials);
    const trialReviews = asObject(report.trialReviews);
    const criteria = ['task_fit', 'rule_calibration', 'evidence_trace', 'counterexamples', 'contamination', 'binding_fit'];
    const fidelity = fidelityRequired || report.version === 2;
    const trialCriteria = ['task_completion', 'style_application', 'clarity', 'non_mechanical', 'non_contamination', ...(fidelity ? ['source_fidelity', 'rhythm_variation'] : [])];
    const passed = (review: Record<string, unknown>, names: string[]) => review.accepted === true
        && names.every(name => asObject(review.checks)[name] === 'pass')
        && Array.isArray(review.issues) && review.issues.every(issue => asObject(issue).severity === 'advisory');
    const sceneVariants = [...members, 'pack'];
    const requiredVariants = fidelity ? [...sceneVariants, ...sceneVariants.map(key => 'transition.' + key)] : sceneVariants;
    const baselineKeys = fidelity ? ['baseline', 'transition.baseline'] : ['baseline'];
    if ((fidelity && (report.version !== 2 || JSON.stringify(report.sceneKeys) !== JSON.stringify(['interaction', 'transition'])))
        || !members.includes('language_style') || report.status !== 'passed' || report.inputHash !== inputHash || reviews.length < members.length
        || members.some(key => !reviews.some(review => String(review.draftKey || '').replace(/-/g, '_') === key && passed(review, criteria)))
        || reviews.some(review => !passed(review, criteria))
        || [...baselineKeys, ...requiredVariants].some(key => typeof trials[key] !== 'string' || String(trials[key]).length < 200)
        || requiredVariants.some(key => !passed(asObject(trialReviews[key]), trialCriteria))) {
        throw new Error('STYLE_SKILL_QUALITY_REVIEW_REQUIRED');
    }
}

function assertStylePackCombinations(report: Record<string, unknown>, pack: Record<string, unknown>): void {
    const revision = asObject(pack.revision);
    if (!revision.coreDraftKey) return;
    const bindings = Array.isArray(revision.bindings) ? revision.bindings.map(asObject) : [];
    const verified = report.verifiedCombinations;
    const pairs = Array.isArray(verified) ? verified.map(asObject) : [];
    const normalKey = (value: unknown) => String(value || '').replace(/_/g, '-');
    const quality = report;
    const acceptedPair = (p: Record<string, unknown>) => {
        const reviewed = asObject(asObject(quality.trialReviews)[String(p.trialKey || '')]);
        const checks = asObject(reviewed.checks);
        const transition = asObject(asObject(quality.trialReviews)['transition.' + String(p.trialKey || '')]);
        const fidelityPass = report.version !== 2 || [reviewed, transition].every(review => review.accepted === true
            && ['task_completion','style_application','clarity','non_mechanical','non_contamination','source_fidelity','rhythm_variation'].every(key => asObject(review.checks)[key] === 'pass')
            && Array.isArray(review.issues) && review.issues.every(issue => asObject(issue).severity === 'advisory'));
        return fidelityPass && p.accepted === true && reviewed.accepted === true &&
            ['task_completion','style_application','clarity','non_mechanical','non_contamination'].every(key => checks[key] === 'pass') &&
            Array.isArray(reviewed.issues) && reviewed.issues.every(issue => asObject(issue).severity === 'advisory');
    };
    for (const binding of bindings.filter(b => b.roleId === 'writer' && ['chapter.create','chapter.continuation','chapter.sequence_continuation','chapter.rewrite','chapter.batch_rewrite'].includes(String(b.operationId)))) {
        const choices = [binding.auxiliaryDraftKey || '', ...(Array.isArray(binding.allowedAuxiliaryDraftKeys) ? binding.allowedAuxiliaryDraftKeys : [])];
        if (choices.some(auxiliary => !pairs.some(p => acceptedPair(p) && normalKey(p.primaryDraftKey) === binding.primaryDraftKey && normalKey(p.auxiliaryDraftKey) === normalKey(auxiliary))))
            throw new Error('STYLE_SKILL_PACK_COMBINATION_REVIEW_REQUIRED');
    }
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
        qualityReview: draft.draft.styleQualityReview,
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
        await this.database.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentSkillPackPreference" (
            "id" TEXT NOT NULL PRIMARY KEY, "novelId" TEXT NOT NULL UNIQUE,
            "packId" TEXT NOT NULL, "packRevisionId" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
            "enabled" BOOLEAN NOT NULL DEFAULT true, "source" TEXT NOT NULL DEFAULT 'explicit',
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE,
            FOREIGN KEY ("packId") REFERENCES "AgentSkillPack"("id") ON DELETE CASCADE,
            FOREIGN KEY ("packRevisionId") REFERENCES "AgentSkillPackRevision"("id") ON DELETE CASCADE
        )`);
        // Additive metadata migration: preserve the installed Prisma engine and all revisions.
        for (const table of ['AgentSkill', 'AgentSkillPack', 'AgentSkillDraft']) {
            const columns = await this.database.$queryRawUnsafe<Array<{name: string}>>(`PRAGMA table_info("${table}")`);
            const additions = table === 'AgentSkillDraft'
                ? {publicationScope: 'TEXT', publicationOwnerNovelId: 'TEXT', publicationVersion: 'INTEGER NOT NULL DEFAULT 1'}
                : {visibilityVersion: 'INTEGER NOT NULL DEFAULT 1'};
            for (const [name, declaration] of Object.entries(additions)) {
                if (!columns.some(c => c.name === name)) await this.database.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${declaration}`);
            }
        }
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
            ? await this.database.agentSkillRevision.findMany({ where: { id: { in: revisionIds } },
                select: { id: true, version: true, contentHash: true, manifestJson: true } })
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

    async getSkill(input: { skillId: string; revisionId?: string }, schemaEnsured = false): Promise<Record<string, unknown> | null> {
        if (!schemaEnsured) await this.ensureSchema();
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
            archivedAt: skill.archivedAt,
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

    async getPack(input: { packId?: string; revisionId?: string; novelId?: string }, schemaEnsured = false,
        catalog?: { packs: Map<string, any>; revisions: Map<string, any>; skills: Map<string, any>; skillRevisions: Map<string, any> }): Promise<Record<string, any>> {
        if (!schemaEnsured) await this.ensureSchema();
        const hintedRevision = !input.packId && input.revisionId ? await this.database.agentSkillPackRevision.findUnique({where: {id: input.revisionId}}) : null;
        const packId = input.packId || hintedRevision?.packId || '';
        const pack = catalog ? catalog.packs.get(packId) : await this.database.agentSkillPack.findUnique({ where: { id: packId } });
        if (!pack || pack.archivedAt || (pack.scope === 'novel' && pack.ownerNovelId !== input.novelId))
            throw new Error('AGENT_SKILL_PACK_NOT_VISIBLE');
        const revisionId = input.revisionId || pack.currentRevisionId || '';
        const revision = catalog ? catalog.revisions.get(revisionId) : await this.database.agentSkillPackRevision.findUnique({ where: { id: revisionId } });
        if (!revision || revision.packId !== pack.id) throw new Error('AGENT_SKILL_PACK_VERSION_UNAVAILABLE');
        const raw = JSON.parse(revision.bindingsJson);
        const modern = !Array.isArray(raw);
        if (modern && raw.schemaVersion !== 'novel-editor.agent-skill-pack.v2') throw new Error('AGENT_SKILL_PACK_SCHEMA_INVALID');
        const bindings = modern ? raw.bindings : raw;
        if (!Array.isArray(bindings) || !bindings.length) throw new Error('AGENT_SKILL_PACK_BINDING_INVALID');
        const refs: Array<Record<string, any>> = modern ? raw.members : bindings.flatMap(b => [b.primary, b.auxiliary].filter(Boolean));
        if (!Array.isArray(refs)) throw new Error('AGENT_SKILL_PACK_SCHEMA_INVALID');
        const members: Array<Record<string, any>> = [];
        for (const ref of refs) {
            if (!ref?.skillId || !ref.revisionId) throw new Error('AGENT_SKILL_PACK_MEMBER_INVALID');
            if (members.some(m => m.skillId === ref.skillId && m.revisionId === ref.revisionId)) continue;
            let skill: Record<string, any> | null;
            if (catalog) {
                const definition = catalog.skills.get(ref.skillId);
                const memberRevision = catalog.skillRevisions.get(ref.revisionId);
                skill = definition ? { ...definition, revision: memberRevision?.skillId === ref.skillId
                    ? { ...memberRevision, manifest: parseObject(memberRevision.manifestJson) || {} } : null } : null;
            } else skill = await this.getSkill({ skillId: ref.skillId, revisionId: ref.revisionId }, true) as Record<string, any> | null;
            if (!skill?.revision || (skill.scope === 'novel' && skill.ownerNovelId !== input.novelId))
                throw new Error('AGENT_SKILL_PACK_MEMBER_UNAVAILABLE');
            if (ref.contentHash && skill.revision.contentHash !== ref.contentHash) throw new Error('AGENT_SKILL_PACK_HASH_MISMATCH');
            members.push({ memberKey: ref.memberKey || ref.skillId, skillId: ref.skillId, revisionId: ref.revisionId,
                stableId: skill.stableId, scope: skill.scope,
                contentHash: skill.revision.contentHash, version: skill.revision.version, title: skill.title,
                slot: ref.slot || 'legacy', enabled: skill.enabled && !skill.archivedAt,
                supportedOperations: skill.revision.manifest.supportedOperations || [], allowedRoles: skill.revision.manifest.allowedRoles || [] });
        }
        const resolve = (key: string) => {
            const member = members.find(m => m.memberKey === key);
            if (!member) throw new Error('AGENT_SKILL_PACK_BINDING_INVALID');
            return member;
        };
        const normalized = bindings.map(b => {
            const primary = modern ? resolve(b.primaryMemberKey) : resolve(b.primary.skillId);
            const auxiliary = modern ? (b.auxiliaryMemberKey ? resolve(b.auxiliaryMemberKey) : null) : (b.auxiliary ? resolve(b.auxiliary.skillId) : null);
            const allowed = modern ? (b.allowedAuxiliaryMemberKeys || (auxiliary ? [auxiliary.memberKey] : [])) : (auxiliary ? [auxiliary.memberKey] : []);
            for (const member of [primary, auxiliary, ...allowed.map(resolve)].filter(Boolean)) {
                if (!member.supportedOperations.includes(b.operationId) || (member.allowedRoles.length && !member.allowedRoles.includes(b.roleId)))
                    throw new Error('AGENT_SKILL_PACK_MEMBER_INCOMPATIBLE');
            }
            if (primary.skillId === auxiliary?.skillId || allowed.includes(primary.memberKey)) throw new Error('AGENT_SKILL_PACK_BINDING_INVALID');
            return { operationId: b.operationId, roleId: b.roleId, primary, auxiliary, allowedAuxiliaryMemberKeys: allowed };
        });
        if (modern && raw.kind === 'style') {
            const core = members.filter(m => m.slot === 'core');
            if (core.length !== 1 || normalized.some(b => b.roleId === 'writer' && ['chapter.create','chapter.continuation','chapter.sequence_continuation','chapter.rewrite','chapter.batch_rewrite'].includes(b.operationId) && b.primary.skillId !== core[0].skillId))
                throw new Error('AGENT_SKILL_PACK_CORE_INVALID');
        }
        if (new Set(normalized.map(b => `${b.operationId}:${b.roleId}`)).size !== normalized.length) throw new Error('AGENT_SKILL_PACK_BINDING_INVALID');
        // Immutable legacy hashes retain their original encoding.
        if (revision.contentHash !== contentHash({ stableId: pack.stableId, version: revision.version, bindings: raw }))
            throw new Error('AGENT_SKILL_PACK_HASH_MISMATCH');
        return { id: pack.id, stableId: pack.stableId, title: pack.title, description: pack.description, scope: pack.scope,
            ownerNovelId: pack.ownerNovelId, enabled: pack.enabled, revisionId: revision.id, version: revision.version,
            contentHash: revision.contentHash, schemaVersion: modern ? 2 : 1, members, bindings: normalized,
            available: pack.enabled && members.every(m => m.enabled) };
    }

    async listPacks(input: { novelId?: string } = {}): Promise<Array<Record<string, any>>> {
        await this.ensureSchema();
        const rows = await this.database.agentSkillPack.findMany({ where: { archivedAt: null, enabled: true,
            OR: [{ scope: 'user', ownerNovelId: null }, ...(input.novelId ? [{ scope: 'novel', ownerNovelId: input.novelId }] : [])] }, orderBy: { title: 'asc' } });
        if (!rows.length) return [];
        const revisionIds = rows.map(row => row.currentRevisionId).filter((id): id is string => Boolean(id));
        const revisions = await this.database.agentSkillPackRevision.findMany({where: {id: {in: revisionIds}}});
        const skillIds = new Set<string>();
        const memberRevisionIds = new Set<string>();
        for (const revision of revisions) {
            try {
                const raw = JSON.parse(revision.bindingsJson);
                const refs = Array.isArray(raw) ? raw.flatMap(b => [b.primary, b.auxiliary].filter(Boolean)) : raw.members;
                for (const ref of Array.isArray(refs) ? refs : []) {
                    if (typeof ref?.skillId === 'string') skillIds.add(ref.skillId);
                    if (typeof ref?.revisionId === 'string') memberRevisionIds.add(ref.revisionId);
                }
            } catch { /* getPack reports the specific validation error for this row. */ }
        }
        // Catalog hydration uses metadata only; full immutable bodies load at selection/execution.
        const [skills, skillRevisions] = await Promise.all([
            this.database.agentSkill.findMany({where: {id: {in: [...skillIds]}}, select: {
                id: true, stableId: true, title: true, scope: true, ownerNovelId: true, enabled: true, archivedAt: true,
            }}),
            this.database.agentSkillRevision.findMany({where: {id: {in: [...memberRevisionIds]}}, select: {
                id: true, skillId: true, version: true, contentHash: true, manifestJson: true,
            }}),
        ]);
        const catalog = {packs: new Map(rows.map(row => [row.id, row])),
            revisions: new Map(revisions.map(row => [row.id, row])),
            skills: new Map(skills.map(row => [row.id, row])),
            skillRevisions: new Map(skillRevisions.map(row => [row.id, row]))};
        const result = [];
        for (const row of rows) {
            try { result.push(await this.getPack({ packId: row.id, novelId: input.novelId }, true, catalog)); }
            catch (error) { result.push({ ...row, revisionId: row.currentRevisionId, version: '?', members: [], bindings: [], available: false,
                unavailableReason: error instanceof Error ? error.message : 'AGENT_SKILL_PACK_UNAVAILABLE' }); }
        }
        return result;
    }

    async getPackDefault(input: { novelId: string }): Promise<Record<string, any>> {
        await this.ensureSchema();
        const rows = await this.database.$queryRawUnsafe<Array<Record<string, any>>>('SELECT * FROM "AgentSkillPackPreference" WHERE "novelId" = ?', input.novelId);
        if (rows.length) {
            const revision = await this.database.agentSkillPackRevision.findUnique({where: {id: String(rows[0].packRevisionId)}});
            let operationPairs: Array<{operationId: string; roleId: string}> | null = null;
            try { const raw = JSON.parse(revision?.bindingsJson || 'null'); const bindings = Array.isArray(raw) ? raw : raw.bindings;
                operationPairs = bindings.map((b: any) => ({operationId: String(b.operationId), roleId: String(b.roleId)})); } catch { /* Broken revision is reported when a task needs it. */ }
            return { ...rows[0], operationPairs, ...(rows[0].source === 'cleared' ? {packId: null, packRevisionId: null} : {}), enabled: Boolean(rows[0].enabled) };
        }
        // Preserve legacy behavior unless exactly one complete novel-scoped
        // published pack accounts for every enabled binding without competitors.
        const legacy = await this.listBindings({ novelId: input.novelId });
        if (!legacy.length || legacy.some(b => b.novelId !== input.novelId || !String(b.bindingType).startsWith('pack_')))
            return { novelId: input.novelId, version: 0, packId: null, legacyBindings: legacy.some(b => String(b.bindingType).startsWith('pack_')) };
        const identity = (operation: unknown, role: unknown, skill: unknown, type: unknown) => JSON.stringify([operation, role, skill, type]);
        const existing = legacy.map(b => identity(b.operationId, b.roleId, b.skillId, b.bindingType)).sort();
        const candidates = (await this.listPacks(input)).filter(p => p.scope === 'novel' && p.available &&
            JSON.stringify(p.bindings.flatMap((b: any) => [identity(b.operationId, b.roleId, b.primary.skillId, 'pack_primary'),
                ...(b.auxiliary ? [identity(b.operationId, b.roleId, b.auxiliary.skillId, 'pack_auxiliary')] : [])]).sort()) === JSON.stringify(existing));
        if (candidates.length === 1) {
            try { return await this.setPackDefault({ novelId: input.novelId, packId: candidates[0].id,
                revisionId: candidates[0].revisionId, expectedVersion: 0, source: 'legacy_migration' }); }
            catch (error) { if (!(error instanceof Error) || error.message !== 'AGENT_SKILL_PACK_DEFAULT_CONFLICT') throw error;
                return this.getPackDefault(input); }
        }
        return { novelId: input.novelId, version: 0, packId: null, legacyBindings: true };
    }

    async setPackDefault(input: { novelId: string; packId: string | null; revisionId?: string; expectedVersion: number; source?: string }): Promise<Record<string, any>> {
        await this.ensureSchema();
        if (!input.novelId || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('AGENT_SKILL_PACK_DEFAULT_INVALID');
        const pack = input.packId ? await this.getPack({ packId: input.packId, revisionId: input.revisionId, novelId: input.novelId }) : null;
        const source = input.source === 'legacy_migration' ? 'legacy_migration' : 'explicit';
        if (pack && !pack.available) throw new Error('AGENT_SKILL_PACK_UNAVAILABLE');
        return this.database.$transaction(async tx => {
            const previous = await tx.$queryRawUnsafe<Array<Record<string, any>>>('SELECT * FROM "AgentSkillPackPreference" WHERE "novelId" = ?', input.novelId);
            if (Number(previous[0]?.version || 0) !== input.expectedVersion) throw new Error('AGENT_SKILL_PACK_DEFAULT_CONFLICT');
            if (pack) {
                if (previous.length) await tx.$executeRawUnsafe('UPDATE "AgentSkillPackPreference" SET "packId"=?, "packRevisionId"=?, "version"="version"+1, "enabled"=1, "source"=?, "updatedAt"=CURRENT_TIMESTAMP WHERE "novelId"=?', pack.id, pack.revisionId, source, input.novelId);
                else await tx.$executeRawUnsafe('INSERT INTO "AgentSkillPackPreference" ("id","novelId","packId","packRevisionId","source") VALUES (?,?,?,?,?)', randomUUID(), input.novelId, pack.id, pack.revisionId, source);
            } else if (previous.length) await tx.$executeRawUnsafe('UPDATE "AgentSkillPackPreference" SET "enabled"=0, "source"=\'cleared\', "version"="version"+1, "updatedAt"=CURRENT_TIMESTAMP WHERE "novelId"=?', input.novelId);
            // An explicit choice supersedes old novel-scoped flat pack defaults.
            await tx.agentSkillBinding.updateMany({ where: { novelId: input.novelId, bindingType: { in: ['pack_primary', 'pack_auxiliary'] } }, data: { enabled: false } });
            return { novelId: input.novelId, packId: pack?.id || null, packRevisionId: pack?.revisionId || null,
                enabled: Boolean(pack), version: pack || previous.length ? input.expectedVersion + 1 : 0 };
        });
    }

    private async visibilityState(db: any, input: {
        targetType: 'skill' | 'pack'; targetId: string; scope?: 'user' | 'novel'; ownerNovelId?: string;
    }): Promise<Record<string, any>> {
        if (!['skill', 'pack'].includes(input.targetType) || !input.targetId) throw new Error('请选择有效的 Skill 或文风包。');
        const table = input.targetType === 'pack' ? 'AgentSkillPack' : 'AgentSkill';
        const rows = await db.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "id"=?`, input.targetId);
        const target = rows[0];
        if (!target || target.archivedAt) throw new Error('Skill 已删除或归档，请重新加载。');
        if (!['user', 'novel'].includes(target.scope)) throw new Error('内置 Skill 的可见范围不能修改。');
        const scope = input.scope ?? target.scope;
        const ownerNovelId = scope === 'novel' ? (input.ownerNovelId ?? target.ownerNovelId) : null;
        if (!['user', 'novel'].includes(scope) || scope === 'novel' && !ownerNovelId) throw new Error('请为小说专属 Skill 选择归属小说。');
        const novels = await db.novel.findMany({select: {id: true, title: true}});
        if (ownerNovelId && !novels.some((n: any) => n.id === ownerNovelId)) throw new Error('归属小说已不存在，请重新选择。');
        const packs = await db.agentSkillPack.findMany({where: {archivedAt: null}});
        const memberships: Array<{id: string; title: string; revisionId: string; memberIds: string[]; defaultNovelId?: string}> = [];
        for (const pack of packs) {
            const revision = pack.currentRevisionId ? await db.agentSkillPackRevision.findUnique({where: {id: pack.currentRevisionId}}) : null;
            if (!revision) continue;
            try {
                const raw = JSON.parse(revision.bindingsJson);
                const refs = Array.isArray(raw) ? raw.flatMap(b => [b.primary, b.auxiliary].filter(Boolean)) : raw.members;
                memberships.push({id: pack.id, title: pack.title, revisionId: revision.id, memberIds: [...new Set<string>((refs || []).map((r: any) => String(r.skillId)))]});
            } catch { if (pack.id === target.id && input.targetType === 'pack') throw new Error('文风包结构损坏，不能修改范围。'); }
        }
        // Defaults can pin an older revision whose members no longer occur in
        // the current pack. Those references still participate in isolation.
        const allPreferences = await db.$queryRawUnsafe('SELECT * FROM "AgentSkillPackPreference" WHERE "enabled"=1');
        for (const preference of allPreferences) {
            const revision = await db.agentSkillPackRevision.findUnique({where: {id: preference.packRevisionId}});
            if (!revision) continue;
            try {
                const raw = JSON.parse(revision.bindingsJson);
                const refs = Array.isArray(raw) ? raw.flatMap(b => [b.primary, b.auxiliary].filter(Boolean)) : raw.members;
                memberships.push({id: preference.packId, title: packs.find((p: any) => p.id === preference.packId)?.title || '文风包',
                    revisionId: revision.id, defaultNovelId: preference.novelId, memberIds: [...new Set<string>((refs || []).map((r: any) => String(r.skillId)))]});
            } catch { /* An already invalid default is not used to rewrite members. */ }
        }
        const managedBy = input.targetType === 'skill' ? memberships.filter(p => !p.defaultNovelId && p.memberIds.includes(target.id)) : [];
        const selectedPack = input.targetType === 'pack' ? memberships.find(p => p.id === target.id && !p.defaultNovelId) : null;
        if (input.targetType === 'pack' && !selectedPack) throw new Error('文风包版本不可用，请重新加载。');
        const memberIds = selectedPack?.memberIds || [target.id];
        const members = await db.$queryRawUnsafe(`SELECT * FROM "AgentSkill" WHERE "id" IN (${memberIds.map(() => '?').join(',')})`, ...memberIds);
        if (members.length !== memberIds.length) throw new Error('文风包成员缺失，不能修改范围。');
        const sharedMembers = input.targetType === 'pack' ? members.filter((m: any) => (m.scope !== scope || (m.ownerNovelId || null) !== (ownerNovelId || null)) && memberships.some(p => p.id !== target.id && p.memberIds.includes(m.id))) : [];
        const unchanged = scope === target.scope && (ownerNovelId || null) === (target.ownerNovelId || null)
            && members.every((m: any) => m.scope === scope && (m.ownerNovelId || null) === (ownerNovelId || null));
        // Shared members are isolated on request; unrelated packs are never moved.
        const movingIds = memberIds.filter((id: string) => !sharedMembers.some((m: any) => m.id === id));
        const bindings = movingIds.length ? await db.agentSkillBinding.findMany({where: {skillId: {in: movingIds}, enabled: true}}) : [];
        const affectedBindings = scope === 'novel' && !unchanged ? bindings.filter((b: any) => b.novelId !== ownerNovelId) : [];
        const preferences = allPreferences.filter((p: any) => input.targetType === 'pack' && p.packId === target.id
            || memberships.some(m => m.id === p.packId && m.revisionId === p.packRevisionId && m.memberIds.some(id => movingIds.includes(id))));
        const affectedDefaults = scope === 'novel' && !unchanged ? preferences.filter((p: any) => p.novelId !== ownerNovelId) : [];
        const conflicts = [];
        for (const member of members) {
            const found = await db.agentSkill.findFirst({where: {id: {not: member.id}, stableId: member.stableId, scope, ownerNovelId}});
            if (found) conflicts.push({targetType: 'skill', id: found.id, title: found.title});
        }
        if (input.targetType === 'pack') {
            const found = await db.agentSkillPack.findFirst({where: {id: {not: target.id}, stableId: target.stableId, scope, ownerNovelId}});
            if (found) conflicts.push({targetType: 'pack', id: found.id, title: found.title});
        }
        const previewToken = contentHash({target, members, memberships: memberships.filter(p => p.id === target.id || p.memberIds.some(id => memberIds.includes(id))), bindings, preferences, conflicts, scope, ownerNovelId});
        return {targetType: input.targetType, targetId: target.id, title: target.title, scope: target.scope,
            ownerNovelId: target.ownerNovelId, visibilityVersion: Number(target.visibilityVersion),
            requestedScope: scope, requestedOwnerNovelId: ownerNovelId, unchanged, previewToken,
            novels, managedBy: managedBy.map(p => ({id: p.id, title: p.title})),
            members: members.map((m: any) => ({id: m.id, title: m.title, visibilityVersion: Number(m.visibilityVersion)})),
            sharedMembers: sharedMembers.map((m: any) => ({id: m.id, title: m.title})),
            affectedDefaults: affectedDefaults.map((p: any) => ({novelId: p.novelId, title: novels.find((n: any) => n.id === p.novelId)?.title || p.novelId})),
            affectedBindingCount: affectedBindings.length, affectedBindings, affectedDefaultsRaw: affectedDefaults, movingIds, conflicts};
    }

    async previewVisibility(input: {targetType: 'skill' | 'pack'; targetId: string; scope?: 'user' | 'novel'; ownerNovelId?: string}): Promise<Record<string, any>> {
        await this.ensureSchema();
        const {affectedBindings, affectedDefaultsRaw, movingIds, ...result} = await this.visibilityState(this.database, input);
        return result;
    }

    private async deletionState(db: any, input: {targetType: 'skill' | 'pack'; targetId: string}): Promise<Record<string, any>> {
        if (!['skill', 'pack'].includes(input.targetType) || !input.targetId) throw new Error('请选择有效的 Skill 或文风包。');
        const table = input.targetType === 'pack' ? 'AgentSkillPack' : 'AgentSkill';
        const targets = await db.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "id"=?`, input.targetId);
        const target = targets[0];
        if (!target || target.archivedAt) throw new Error('Skill 已删除，请重新加载列表。');
        if (!['user', 'novel'].includes(target.scope)) throw new Error('内置 Skill 不能删除。');
        const refs = (revision: any): string[] => {
            if (!revision) return [];
            let raw: any;
            try {raw = JSON.parse(revision.bindingsJson);} catch {return [];}
            const members = Array.isArray(raw) ? raw.flatMap(b => [b?.primary, b?.auxiliary].filter(Boolean)) : raw?.members;
            if (!Array.isArray(members)) return [];
            return [...new Set<string>(members.map(m => String(m?.skillId || '')).filter(Boolean))];
        };
        const packs = await db.agentSkillPack.findMany({where: {archivedAt: null}});
        const preferences = await db.$queryRawUnsafe("SELECT * FROM \"AgentSkillPackPreference\" WHERE \"source\"!='cleared'");
        const memberships: Array<{id: string; title: string; revisionId: string}> = [];
        let memberIds: string[] = [];
        for (const pack of packs) {
            const revision = pack.currentRevisionId ? await db.agentSkillPackRevision.findUnique({where: {id: pack.currentRevisionId}}) : null;
            const ids = refs(revision);
            if (input.targetType === 'pack' && pack.id === target.id) memberIds = ids;
            if (input.targetType === 'skill' && ids.includes(target.id)) memberships.push({id: pack.id, title: pack.title, revisionId: revision.id});
        }
        // A default may still pin a member removed from the pack's latest revision.
        for (const preference of preferences) {
            if (input.targetType !== 'skill') break;
            const revision = await db.agentSkillPackRevision.findUnique({where: {id: preference.packRevisionId}});
            if (refs(revision).includes(target.id) && !memberships.some(p => p.id === preference.packId)) {
                const pack = packs.find((p: any) => p.id === preference.packId);
                if (pack) memberships.push({id: pack.id, title: pack.title, revisionId: revision.id});
            }
        }
        const affectedDefaults = input.targetType === 'pack' ? preferences.filter((p: any) => p.packId === target.id) : [];
        const bindings = input.targetType === 'skill' ? await db.agentSkillBinding.findMany({where: {skillId: target.id, enabled: true}}) : [];
        const tables: Array<{name: string}> = await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('AgentRun','DraftGenerationOperation')");
        const uses = (value: unknown, skillIds: string[], packId?: string): boolean => {
            if (Array.isArray(value)) return value.some(item => uses(item, skillIds, packId));
            if (!value || typeof value !== 'object') return false;
            const object = value as Record<string, unknown>;
            if (typeof object.skillId === 'string' && skillIds.includes(object.skillId) || packId && object.packId === packId) return true;
            return Object.values(object).some(item => uses(item, skillIds, packId));
        };
        const active: Array<{id: string; status: string}> = [];
        const skillIds = input.targetType === 'skill' ? [target.id] : memberIds;
        if (tables.some(t => t.name === 'AgentRun')) {
            const runs = await db.$queryRawUnsafe("SELECT runId, status, planJson FROM AgentRun WHERE status IN ('queued','pending','running','cancelling','waiting_approval','waiting_user_input')");
            for (const run of runs) {
                const plan = run.planJson ? JSON.parse(run.planJson) : null;
                if (uses(plan, input.targetType === 'skill' ? skillIds : [], input.targetType === 'pack' ? target.id : undefined)) active.push({id: run.runId, status: run.status});
            }
        }
        if (tables.some(t => t.name === 'DraftGenerationOperation')) {
            const operations = await db.$queryRawUnsafe("SELECT operationId, status, requestJson FROM DraftGenerationOperation WHERE status IN ('queued','running')");
            for (const operation of operations) if (uses(JSON.parse(operation.requestJson), skillIds)) active.push({id: operation.operationId, status: operation.status});
        }
        const novels = affectedDefaults.length ? await db.novel.findMany({select: {id: true, title: true}}) : [];
        const previewToken = contentHash({target, memberships, affectedDefaults, bindings, active, memberIds});
        return {targetType: input.targetType, targetId: target.id, title: target.title,
            scope: target.scope, visibilityVersion: Number(target.visibilityVersion), previewToken, canDelete: !memberships.length && !active.length,
            managedBy: memberships.map(({id, title}) => ({id, title})), activeUseCount: active.length,
            affectedDefaults: affectedDefaults.map((p: any) => ({novelId: p.novelId, title: novels.find((n: any) => n.id === p.novelId)?.title || p.novelId})),
            affectedBindingCount: bindings.length, retainedMemberCount: memberIds.length};
    }

    async previewDeletion(input: {targetType: 'skill' | 'pack'; targetId: string}): Promise<Record<string, any>> {
        await this.ensureSchema();
        return this.deletionState(this.database, input);
    }

    async deleteTarget(input: {targetType: 'skill' | 'pack'; targetId: string; expectedVisibilityVersion: number; previewToken: string; confirmed: true}): Promise<Record<string, any>> {
        await this.ensureSchema();
        if (input.confirmed !== true) throw new Error('请先确认删除。');
        return this.database.$transaction(async tx => {
            const state = await this.deletionState(tx, input);
            if (state.visibilityVersion !== input.expectedVisibilityVersion || state.previewToken !== input.previewToken)
                throw new Error('Skill 或关联已变化，请重新预览后删除。');
            if (state.activeUseCount) throw new Error('正在执行的任务使用此 Skill，请先结束任务再删除。');
            if (state.managedBy.length) throw new Error('此 Skill 仍被文风包引用，请先处理关联文风包。');
            const change = {where: {id: input.targetId, archivedAt: null}, data: {archivedAt: new Date(), enabled: false}};
            const updated = input.targetType === 'pack'
                ? await tx.agentSkillPack.updateMany(change) : await tx.agentSkill.updateMany(change);
            if (updated.count !== 1) throw new Error('Skill 已变化，请重新加载。');
            const table = input.targetType === 'pack' ? 'AgentSkillPack' : 'AgentSkill';
            await tx.$executeRawUnsafe(`UPDATE "${table}" SET "visibilityVersion"="visibilityVersion"+1 WHERE "id"=?`, input.targetId);
            if (input.targetType === 'pack') await tx.$executeRawUnsafe('UPDATE "AgentSkillPackPreference" SET "enabled"=0, "source"=\'cleared\', "version"="version"+1, "updatedAt"=CURRENT_TIMESTAMP WHERE "packId"=? AND "source"!=\'cleared\'', input.targetId);
            else await tx.agentSkillBinding.updateMany({where: {skillId: input.targetId, enabled: true}, data: {enabled: false}});
            return {...state, deleted: true};
        });
    }

    async setVisibility(input: {targetType: 'skill' | 'pack'; targetId: string; scope: 'user' | 'novel'; ownerNovelId?: string;
        expectedVisibilityVersion: number; previewToken: string; isolateSharedMembers?: boolean; copyOnConflict?: boolean}): Promise<Record<string, any>> {
        await this.ensureSchema();
        return this.database.$transaction(async tx => {
            const state = await this.visibilityState(tx, input);
            if (state.visibilityVersion !== input.expectedVisibilityVersion || state.previewToken !== input.previewToken)
                throw new Error('可见范围或关联已变化，请重新预览后保存。');
            if (state.managedBy.length) throw new Error('此成员由文风包管理，请修改所属文风包的范围。');
            if (state.unchanged) {
                const {affectedBindings, affectedDefaultsRaw, movingIds, ...result} = state;
                return {changed: false, ...result};
            }
            if (state.conflicts.length && input.copyOnConflict === true) return this.copyVisibilityTarget(tx, state);
            if (state.conflicts.length) throw new Error('目标范围已有同标识对象，请选择另存独立副本。');
            if (state.sharedMembers.length && !input.isolateSharedMembers) throw new Error('成员被其他包共享，请选择建立独立成员副本。');
            const ownerNovelId = state.requestedOwnerNovelId;
            const movedIds: string[] = [...state.movingIds];
            if (state.sharedMembers.length) {
                const pack = await tx.agentSkillPack.findUniqueOrThrow({where: {id: input.targetId}});
                const previous = await tx.agentSkillPackRevision.findUniqueOrThrow({where: {id: pack.currentRevisionId!}});
                if (previous.contentHash !== contentHash({stableId: pack.stableId, version: previous.version, bindings: JSON.parse(previous.bindingsJson)}))
                    throw new Error('文风包签名不匹配，不能复制成员。');
                const raw = JSON.parse(previous.bindingsJson);
                const refs = Array.isArray(raw) ? raw.flatMap(b => [b.primary, b.auxiliary].filter(Boolean)) : raw.members;
                const cloned = new Map<string, {skillId: string; revisionId: string; contentHash: string}>();
                for (const member of state.sharedMembers) {
                    const source = await tx.agentSkill.findUniqueOrThrow({where: {id: member.id}});
                    const ref = refs.find((r: any) => r.skillId === source.id);
                    const revision = await tx.agentSkillRevision.findFirstOrThrow({where: {id: ref.revisionId, skillId: source.id}});
                    const originalHash = contentHash({stableId: source.stableId, version: revision.version, manifest: JSON.parse(revision.manifestJson),
                        instructions: revision.instructions, constraints: JSON.parse(revision.constraintsJson), examples: JSON.parse(revision.examplesJson)});
                    if (revision.contentHash !== originalHash || ref.contentHash && ref.contentHash !== originalHash) throw new Error('共享成员签名不匹配，不能复制。');
                    const {id: oldId, currentRevisionId, createdAt, updatedAt, ...definition} = source;
                    const id = randomUUID(), revisionId = randomUUID();
                    const stableId = `${source.stableId.slice(0, 45)}.copy-${id.slice(0, 8)}`;
                    const hash = contentHash({stableId, version: revision.version, manifest: JSON.parse(revision.manifestJson),
                        instructions: revision.instructions, constraints: JSON.parse(revision.constraintsJson), examples: JSON.parse(revision.examplesJson)});
                    await tx.agentSkill.create({data: {...definition, id, stableId, scope: input.scope, ownerNovelId, currentRevisionId: revisionId}});
                    await tx.agentSkillRevision.create({data: {id: revisionId, skillId: id, version: revision.version,
                        manifestJson: revision.manifestJson, instructions: revision.instructions, constraintsJson: revision.constraintsJson,
                        examplesJson: revision.examplesJson, contentHash: hash}});
                    cloned.set(source.id, {skillId: id, revisionId, contentHash: hash});
                    movedIds.push(id);
                }
                for (const ref of refs) {const copy = cloned.get(ref.skillId); if (copy) {const copySource = {...ref}; Object.assign(ref, copy, {copySource});}}
                const parts = previous.version.split('.').map(Number);
                if (parts.length !== 3 || parts.some(n => !Number.isInteger(n))) throw new Error('文风包版本格式不合法。');
                let version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
                while (await tx.agentSkillPackRevision.findFirst({where: {packId: pack.id, version}})) version = `${parts[0]}.${parts[1]}.${++parts[2] + 1}`;
                const id = randomUUID();
                await tx.agentSkillPackRevision.create({data: {id, packId: pack.id, version, bindingsJson: JSON.stringify(raw),
                    contentHash: contentHash({stableId: pack.stableId, version, bindings: raw})}});
                await tx.agentSkillPack.update({where: {id: pack.id}, data: {currentRevisionId: id}});
                // Only retained preferences follow the explicitly confirmed new member identity.
                await tx.$executeRawUnsafe('UPDATE "AgentSkillPackPreference" SET "packRevisionId"=?, "version"="version"+1 WHERE "packId"=? AND "enabled"=1 AND "novelId"=?', id, pack.id, ownerNovelId || '');
            }
            for (const id of movedIds) {
                const duplicates = await tx.agentSkill.findMany({where: {id: {not: id}, scope: input.scope, ownerNovelId,
                    stableId: (await tx.agentSkill.findUniqueOrThrow({where: {id}})).stableId}});
                if (duplicates.length) throw new Error('目标范围已有同名标识的 Skill，请先修改标识或另存副本。');
                await tx.$executeRawUnsafe('UPDATE "AgentSkill" SET "scope"=?, "ownerNovelId"=?, "visibilityVersion"="visibilityVersion"+1, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=?', input.scope, ownerNovelId, id);
            }
            if (input.targetType === 'pack') {
                const current = await tx.agentSkillPack.findUniqueOrThrow({where: {id: input.targetId}});
                if (await tx.agentSkillPack.findFirst({where: {id: {not: current.id}, stableId: current.stableId, scope: input.scope, ownerNovelId}}))
                    throw new Error('目标范围已有同名标识的文风包，请先另存副本。');
                await tx.$executeRawUnsafe('UPDATE "AgentSkillPack" SET "scope"=?, "ownerNovelId"=?, "visibilityVersion"="visibilityVersion"+1, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=?', input.scope, ownerNovelId, input.targetId);
            }
            for (const binding of state.affectedBindings) {
                if (!binding.novelId) await tx.agentSkillBinding.update({where: {id: binding.id}, data: {novelId: ownerNovelId}});
                else await tx.agentSkillBinding.update({where: {id: binding.id}, data: {enabled: false}});
            }
            for (const preference of state.affectedDefaultsRaw) await tx.$executeRawUnsafe('UPDATE "AgentSkillPackPreference" SET "source"=\'cleared\', "enabled"=0, "version"="version"+1 WHERE "id"=?', preference.id);
            const {affectedBindings, affectedDefaultsRaw, movingIds, ...result} = state;
            return {...result, changed: true, scope: input.scope, ownerNovelId, visibilityVersion: state.visibilityVersion + 1};
        }, {timeout: 30000});
    }

    private async copyVisibilityTarget(tx: any, state: Record<string, any>): Promise<Record<string, any>> {
        let raw: any, originalPack: any;
        const copies = new Map<string, {skillId: string; revisionId: string; contentHash: string}>();
        const origins = new Map<string, Record<string, unknown>>();
        if (state.targetType === 'pack') {
            originalPack = await tx.agentSkillPack.findUniqueOrThrow({where: {id: state.targetId}});
            const revision = await tx.agentSkillPackRevision.findUniqueOrThrow({where: {id: originalPack.currentRevisionId}});
            raw = JSON.parse(revision.bindingsJson);
            if (revision.contentHash !== contentHash({stableId: originalPack.stableId, version: revision.version, bindings: raw})) throw new Error('来源文风包签名不匹配，不能另存。');
        }
        const refs: any[] = state.targetType === 'pack' ? (Array.isArray(raw) ? raw.flatMap(b => [b.primary, b.auxiliary].filter(Boolean)) : raw.members)
            : [{skillId: state.targetId, revisionId: (await tx.agentSkill.findUniqueOrThrow({where: {id: state.targetId}})).currentRevisionId}];
        for (const ref of refs) {
            const key = `${ref.skillId}:${ref.revisionId}`;
            let copy = copies.get(key);
            if (!copy) {
                const source = await tx.agentSkill.findUniqueOrThrow({where: {id: ref.skillId}});
                const revision = await tx.agentSkillRevision.findFirstOrThrow({where: {id: ref.revisionId, skillId: source.id}});
                const payload = {stableId: source.stableId, version: revision.version, manifest: JSON.parse(revision.manifestJson), instructions: revision.instructions, constraints: JSON.parse(revision.constraintsJson), examples: JSON.parse(revision.examplesJson)};
                if (revision.contentHash !== contentHash(payload) || ref.contentHash && ref.contentHash !== revision.contentHash) throw new Error('来源成员签名不匹配，不能另存。');
                origins.set(key, {skillId: source.id, stableId: source.stableId, revisionId: revision.id, contentHash: revision.contentHash});
                const id = randomUUID(), revisionId = randomUUID(), stableId = `${source.stableId.slice(0, 45)}.copy-${id.slice(0, 8)}`;
                const {id: sourceId, currentRevisionId, createdAt, updatedAt, ...definition} = source;
                const hash = contentHash({...payload, stableId});
                await tx.agentSkill.create({data: {...definition, id, stableId, title: `${source.title}（副本）`, scope: state.requestedScope, ownerNovelId: state.requestedOwnerNovelId, currentRevisionId: revisionId}});
                await tx.agentSkillRevision.create({data: {id: revisionId, skillId: id, version: revision.version, manifestJson: revision.manifestJson, instructions: revision.instructions, constraintsJson: revision.constraintsJson, examplesJson: revision.examplesJson, contentHash: hash}});
                copy = {skillId: id, revisionId, contentHash: hash}; copies.set(key, copy);
            }
            const copySource = {...ref, ...origins.get(key)}; Object.assign(ref, copy, {copySource});
        }
        let targetId: string, committedRevisionId: string | undefined, committedPackRevisionId: string | undefined;
        if (originalPack) {
            const id = randomUUID(), revisionId = randomUUID(), stableId = `${originalPack.stableId.slice(0, 45)}.copy-${id.slice(0, 8)}`;
            const originalRevision = await tx.agentSkillPackRevision.findUniqueOrThrow({where: {id: originalPack.currentRevisionId}});
            await tx.agentSkillPack.create({data: {id, stableId, scope: state.requestedScope, ownerNovelId: state.requestedOwnerNovelId, title: `${originalPack.title}（副本）`, description: originalPack.description, enabled: originalPack.enabled, currentRevisionId: revisionId}});
            await tx.agentSkillPackRevision.create({data: {id: revisionId, packId: id, version: originalRevision.version, bindingsJson: JSON.stringify(raw), contentHash: contentHash({stableId, version: originalRevision.version, bindings: raw})}});
            targetId = id; committedPackRevisionId = revisionId;
        } else {const copy = [...copies.values()][0]; targetId = copy.skillId; committedRevisionId = copy.revisionId;}
        await tx.agentSkillDraft.create({data: {id: randomUUID(), action: originalPack ? 'pack' : 'derive', status: 'committed', scope: state.requestedScope,
            committedRevisionId, committedPackRevisionId, draftJson: JSON.stringify({kind: 'visibility_copy', copySource: {targetType: state.targetType, targetId: state.targetId, revisionId: originalPack?.currentRevisionId, visibilityVersion: state.visibilityVersion}, sourceReferences: refs.map(r => r.copySource), members: [...copies.values()]}),
            derivationReportJson: JSON.stringify({kind: 'visibility_copy', sourceTargetId: state.targetId, contentUnchanged: true})}});
        return {targetType: state.targetType, targetId, title: `${state.title}（副本）`, copied: true, changed: true,
            scope: state.requestedScope, ownerNovelId: state.requestedOwnerNovelId, visibilityVersion: 1};
    }

    async checkVisibility(input: {novelId?: string; skills: Array<{skillId: string; revisionId: string; contentHash: string}>}): Promise<Record<string, any>[]> {
        await this.ensureSchema();
        const result = [];
        for (const ref of input.skills || []) {
            const skill = await this.getSkill(ref, true) as any;
            if (!skill?.enabled || skill.archivedAt || !skill.revision || skill.revision.contentHash !== ref.contentHash
                || skill.scope === 'novel' && skill.ownerNovelId !== input.novelId) throw new Error('Skill 可见范围或状态已变化，请重新选择。');
            const rows = await this.database.$queryRawUnsafe<Array<{visibilityVersion: number}>>('SELECT "visibilityVersion" FROM "AgentSkill" WHERE "id"=?', ref.skillId);
            result.push({...ref, scope: skill.scope, ownerNovelId: skill.ownerNovelId, novelId: input.novelId,
                visibilityVersion: Number(rows[0].visibilityVersion)});
        }
        return result;
    }

    async setDraftPublication(input: {draftId: string; scope: 'user' | 'novel'; ownerNovelId?: string; expectedPublicationVersion: number}): Promise<Record<string, any>> {
        await this.ensureSchema();
        if (!['user', 'novel'].includes(input.scope)) throw new Error('可见范围不合法。');
        const owner = input.scope === 'novel' ? input.ownerNovelId : null;
        if (input.scope === 'novel' && (!owner || !await this.database.novel.findUnique({where: {id: owner}, select: {id: true}}))) throw new Error('请选择有效的归属小说。');
        return this.database.$transaction(async tx => {
            const draft = await tx.agentSkillDraft.findUniqueOrThrow({where: {id: input.draftId}});
            if (draft.status === 'committed' || draft.status === 'discarded' || draft.action === 'update') throw new Error('此草稿不能修改发布范围。');
            const changed = await tx.$executeRawUnsafe('UPDATE "AgentSkillDraft" SET "publicationScope"=?, "publicationOwnerNovelId"=?, "publicationVersion"="publicationVersion"+1 WHERE "id"=? AND "publicationVersion"=?', input.scope, owner, input.draftId, input.expectedPublicationVersion);
            if (!changed) throw new Error('发布范围已变化，请重新加载后修改。');
            return {scope: input.scope, ownerNovelId: owner, publicationVersion: input.expectedPublicationVersion + 1};
        });
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
        if (!row) return null;
        const settings = await this.database.$queryRawUnsafe<Array<{publicationScope: string | null; publicationOwnerNovelId: string | null; publicationVersion: number}>>('SELECT "publicationScope", "publicationOwnerNovelId", "publicationVersion" FROM "AgentSkillDraft" WHERE "id"=?', id);
        const committedSkill = row.committedRevisionId ? await this.database.agentSkillRevision.findUnique({where: {id: row.committedRevisionId}}) : null;
        const committedPack = row.committedPackRevisionId ? await this.database.agentSkillPackRevision.findUnique({where: {id: row.committedPackRevisionId}}) : null;
        const targetId = committedPack?.packId || committedSkill?.skillId;
        const current = targetId ? await this.database.$queryRawUnsafe<Array<{scope: string; ownerNovelId: string | null; visibilityVersion: number}>>(`SELECT "scope", "ownerNovelId", "visibilityVersion" FROM "${committedPack ? 'AgentSkillPack' : 'AgentSkill'}" WHERE "id"=?`, targetId) : [];
        return {...toDraft(row as DraftRow), ...(current[0] ? {currentVisibility: {...current[0], visibilityVersion: Number(current[0].visibilityVersion)}} : {}), ...(committedSkill ? {committedSkillId: committedSkill.skillId} : {}), ...(committedPack ? {committedPackId: committedPack.packId} : {}), publicationScope: settings[0].publicationScope as 'user' | 'novel' || undefined,
            publicationOwnerNovelId: settings[0].publicationOwnerNovelId || undefined, publicationVersion: Number(settings[0].publicationVersion)};
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
        const prepared = prepareAgentSkillAuthoringDraft({
            draft: draft.draft, draftId: draft.id, action: draft.action, scope: draft.scope, sourceNovelId: draft.sourceNovelId,
            systemIdentity: await this.getAuthoringSystemIdentity(draft),
        });
        const state = readAgentSkillAuthoringState(prepared.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const validation = validateAgentSkillWorkspace({ draft: prepared.draft, action: draft.action, scope: draft.scope });
        const nextState: AgentSkillAuthoringState = {
            ...state,
            phase: validation.report.ok ? 'validating' : input.finalAttempt ? 'needs_attention' : 'revising',
            validationReport: validation.report,
            validatedInputHash: validation.report.ok ? validation.report.inputHash : undefined,
            compiledInputHash: undefined,
        };
        const nextDraft = { ...prepared.draft, authoring: nextState };
        const updated = await this.persistAuthoringMutation(draft, nextDraft, input.expectedVersion);
        return { ...workspaceSummary(updated), repairs: prepared.repairs };
    }

    private async getAuthoringSystemIdentity(draft: AgentSkillDraftRecord): Promise<{ stableId?: string; version?: string }> {
        if (draft.action !== 'update' || !draft.targetSkillId) return {};
        const existing = await this.getSkill({ skillId: draft.targetSkillId });
        if (!existing || existing.scope !== draft.scope
            || draft.scope === 'novel' && existing.ownerNovelId !== draft.sourceNovelId) return {};
        const revision = asObject(existing.revision);
        const version = String(revision.version || '');
        return {
            stableId: String(existing.stableId || ''),
            ...(/^\d+\.\d+\.\d+$/.test(version) ? { version: bumpPatchVersion(version) } : {}),
        };
    }

    async prepareAuthoringWorkspace(input: {
        draftId: string;
        expectedVersion: number;
        logicalPath?: string;
        rules?: AgentSkillAuthorRules;
    }): Promise<{
        draft: AgentSkillDraftRecord;
        validationReport: AgentSkillAuthoringValidationReport;
        repairs: AgentSkillAuthoringRepair[];
    }> {
        const draft = await this.getDraft(String(input?.draftId || ''));
        if (!draft) throw new Error('AGENT_SKILL_DRAFT_NOT_FOUND');
        if (draft.version !== input.expectedVersion) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
        if (draft.status === 'committed' || draft.status === 'discarded') throw new Error('AGENT_SKILL_DRAFT_NOT_EDITABLE');
        const prepared = prepareAgentSkillAuthoringDraft({
            draft: draft.draft,
            draftId: draft.id,
            action: draft.action,
            scope: draft.scope,
            sourceNovelId: draft.sourceNovelId,
            systemIdentity: await this.getAuthoringSystemIdentity(draft),
            logicalPath: input.logicalPath,
            rules: input.rules,
        });
        const state = readAgentSkillAuthoringState(prepared.draft);
        if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
        const validation = validateAgentSkillWorkspace({ draft: prepared.draft, action: draft.action, scope: draft.scope });
        let qualityReady = !requiresStyleQuality(draft.derivationReport);
        if (!qualityReady) {
            try {
                assertStyleQuality(asObject(prepared.draft.styleQualityReview), validation.report.inputHash, prepared.draft, asObject(draft.derivationReport?.sourceCoverage).fidelityMode === 2);
                assertStylePackCombinations(asObject(prepared.draft.styleQualityReview), asObject(prepared.draft.pack));
                qualityReady = true;
            } catch { /* Formatting preparation cannot substitute for semantic/trial acceptance. */ }
        }
        const ready = validation.report.ok && Boolean(validation.projection) && qualityReady;
        const nextState: AgentSkillAuthoringState = {
            ...state,
            phase: ready ? 'compiled' : 'needs_attention',
            validationReport: validation.report,
            validatedInputHash: validation.report.ok ? validation.report.inputHash : undefined,
            compiledInputHash: ready ? validation.report.inputHash : undefined,
        };
        const nextDraft: Record<string, unknown> = { ...prepared.draft, authoring: nextState };
        // Any old compiled projection belongs to the previous document hash.
        delete nextDraft.definition;
        delete nextDraft.revision;
        delete nextDraft.skills;
        if (ready) Object.assign(nextDraft, validation.projection);
        const updated = await this.persistAuthoringMutation(
            draft, nextDraft, input.expectedVersion, ready ? 'ready_for_review' : 'editing',
        );
        return { draft: updated, validationReport: validation.report, repairs: prepared.repairs };
    }

    async compileAuthoringWorkspace(input: {
        draftId: string;
        expectedVersion: number;
        qualityReview?: Record<string, unknown>;
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
        const qualityRequired = requiresStyleQuality(draft.derivationReport);
        const qualityReview = input.qualityReview || asObject(draft.draft.styleQualityReview);
        if (qualityRequired) { assertStyleQuality(qualityReview, inputHash, draft.draft, asObject(draft.derivationReport?.sourceCoverage).fidelityMode === 2); assertStylePackCombinations(qualityReview, asObject(draft.draft.pack)); }
        const nextState: AgentSkillAuthoringState = {
            ...state,
            phase: 'compiled',
            validationReport: validation.report,
            validatedInputHash: inputHash,
            compiledInputHash: inputHash,
        };
        const projection = validation.projection as Record<string, unknown>;
        const nextDraft = { ...draft.draft, ...projection, authoring: nextState,
            ...(qualityRequired ? { styleQualityReview: qualityReview } : {}) };
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
        let candidate = await this.getDraft(input.draftId);
        if (candidate && candidate.publicationScope && candidate.action !== 'update') candidate = await this.applyPublication(candidate);
        if (candidate?.action === 'pack') return this.commitPackDraft(input, candidate);
        return this.commitSingleSkillDraft(input, candidate);
    }

    private async applyPublication(draft: AgentSkillDraftRecord): Promise<AgentSkillDraftRecord> {
        const scope = draft.publicationScope!;
        const owner = scope === 'novel' ? draft.publicationOwnerNovelId : undefined;
        if (scope === 'novel' && (!owner || !await this.database.novel.findUnique({where: {id: owner}, select: {id: true}}))) throw new Error('归属小说已不存在，请重新设置发布范围。');
        assertAgentSkillAuthoringCommitReady({draft: draft.draft, action: draft.action, scope: draft.scope, status: draft.status});
        if (requiresStyleQuality(draft.derivationReport)) {
            assertStyleQuality(asObject(draft.draft.styleQualityReview), readAgentSkillAuthoringState(draft.draft)?.authoringInputHash || '', draft.draft, asObject(draft.derivationReport?.sourceCoverage).fidelityMode === 2);
            assertStylePackCombinations(asObject(draft.draft.styleQualityReview), asObject(draft.draft.pack));
        }
        const oldState = readAgentSkillAuthoringState(draft.draft);
        let contents = draft.draft;
        if (oldState) {
            contents = prepareAgentSkillAuthoringDraft({draft: contents, draftId: draft.id, action: draft.action, scope, sourceNovelId: owner}).draft;
            const state = readAgentSkillAuthoringState(contents)!;
            const validated = validateAgentSkillWorkspace({draft: contents, action: draft.action, scope});
            if (!validated.report.ok || !validated.projection) throw new Error('发布范围元数据校验失败，草稿已保留。');
            const prior = draft.action === 'pack' ? {skills: draft.draft.skills, pack: draft.draft.pack} : {definition: draft.draft.definition, revision: draft.draft.revision};
            if (canonical(prior) !== canonical(validated.projection)) throw new Error('范围修改改变了方法内容，请重新审核。');
            const hash = buildAgentSkillAuthoringInputHash(state.documents, contents.pack);
            contents = {...contents, authoring: {...state, phase: 'compiled', validationReport: validated.report,
                authoringInputHash: hash, validatedInputHash: hash, compiledInputHash: hash}};
            if (requiresStyleQuality(draft.derivationReport)) contents = {...contents, styleQualityReview: {
                ...asObject(contents.styleQualityReview), inputHash: hash,
                visibilityOnlyRevalidation: {previousInputHash: oldState.authoringInputHash, inputHash: hash, scope, ownerNovelId: owner || null},
            }};
        }
        return {...draft, scope, draft: {...contents, publicationOwnerNovelId: owner || null}};
    }

    private async assertPublicationUnchanged(tx: any, draft: AgentSkillDraftRecord): Promise<void> {
        if (!draft.publicationVersion) return;
        const rows = await tx.$queryRawUnsafe('SELECT "publicationVersion" FROM "AgentSkillDraft" WHERE "id"=?', draft.id);
        if (Number(rows[0]?.publicationVersion) !== draft.publicationVersion) throw new Error('发布范围在保存期间变化，请重新确认保存。');
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
        if (manifest.executionHints !== undefined) validateSkillExecutionHints(manifest.executionHints);
        const constraints = Array.isArray(proposedRevision.constraints) ? proposedRevision.constraints : [];
        const examples = Array.isArray(proposedRevision.examples) ? proposedRevision.examples : [];
        const hashPayload = { stableId, version, manifest, instructions, constraints, examples };
        assertSafeJson(hashPayload);
        const revisionId = randomUUID();
        const skillId = draft.targetSkillId || randomUUID();
        const hash = contentHash(hashPayload);
        const result = await this.database.$transaction(async (tx) => {
            await this.assertPublicationUnchanged(tx, draft);
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
                        ownerNovelId: draft.scope === 'novel' ? String(draft.draft.publicationOwnerNovelId || draft.sourceNovelId || '') || null : null,
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
                data: { status: 'committed', scope: draft.scope, draftJson: JSON.stringify(draft.draft), committedRevisionId: revisionId, version: { increment: 1 }, updatedAt: new Date() },
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
        if (requiresStyleQuality(draft.derivationReport)) assertStyleQuality(asObject(draft.draft.styleQualityReview),
            readAgentSkillAuthoringState(draft.draft)?.authoringInputHash || '', draft.draft, asObject(draft.derivationReport?.sourceCoverage).fidelityMode === 2);
        const rawSkills = Array.isArray(draft.draft.skills) ? draft.draft.skills : [];
        const pack = asObject(draft.draft.pack);
        const packDefinition = asObject(pack.definition);
        const packRevision = asObject(pack.revision);
        if (rawSkills.length < 1 || rawSkills.length > 3) throw new Error('AGENT_SKILL_PACK_DRAFT_INVALID');
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
            if (manifest.executionHints !== undefined) validateSkillExecutionHints(manifest.executionHints);
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
        if (validatePack(pack, normalizedSkills.map(item => ({ key: item.draftKey, manifest: item.manifest })))
            .some(item => item.severity === 'error')) throw new Error('AGENT_SKILL_PACK_BINDING_INVALID');
        const bindings = Array.isArray(packRevision.bindings) ? packRevision.bindings.map(asObject) : [];
        if (requiresStyleQuality(draft.derivationReport)) assertStylePackCombinations(asObject(draft.draft.styleQualityReview), pack);
        const knownKeys = new Set(normalizedSkills.map((item) => item.draftKey));
        if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(packStableId) || !packTitle || !packDescription
            || !/^\d+\.\d+\.\d+$/.test(packVersion) || !bindings.length
            || bindings.some((item) => !String(item.operationId || '').trim() || !String(item.roleId || '').trim()
                || !knownKeys.has(String(item.primaryDraftKey || ''))
                || (item.auxiliaryDraftKey && !knownKeys.has(String(item.auxiliaryDraftKey))))) {
            throw new Error('AGENT_SKILL_PACK_DRAFT_INVALID');
        }
        assertSafeJson({ normalizedSkills, packStableId, packVersion, bindings });
        const ownerNovelId = draft.scope === 'novel' ? String(draft.draft.publicationOwnerNovelId || draft.sourceNovelId || '') || null : null;
        const result = await this.database.$transaction(async (tx) => {
            const committedSkills: Array<Record<string, unknown>> = [];
            const byDraftKey = new Map<string, { skillId: string; revisionId: string; contentHash: string }>();
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
                byDraftKey.set(item.draftKey, { skillId, revisionId, contentHash: revision.contentHash });
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
            const coreKey = String(packRevision.coreDraftKey || '');
            const encodedBindings = coreKey ? {
                schemaVersion: 'novel-editor.agent-skill-pack.v2', kind: 'style',
                members: normalizedSkills.map(item => ({ memberKey: item.draftKey, ...byDraftKey.get(item.draftKey)!, slot: item.draftKey === coreKey ? 'core' : 'auxiliary' })),
                bindings: bindings.map(binding => ({ operationId: String(binding.operationId), roleId: String(binding.roleId),
                    primaryMemberKey: String(binding.primaryDraftKey), ...(binding.auxiliaryDraftKey ? {auxiliaryMemberKey: binding.auxiliaryDraftKey} : {}),
                    allowedAuxiliaryMemberKeys: binding.allowedAuxiliaryDraftKeys || (binding.auxiliaryDraftKey ? [binding.auxiliaryDraftKey] : []) })),
            } : resolvedBindings;
            if (coreKey && !byDraftKey.has(coreKey)) throw new Error('AGENT_SKILL_PACK_CORE_INVALID');
            await tx.agentSkillPack.create({
                data: {
                    id: packId, stableId: packStableId, scope: draft.scope, ownerNovelId,
                    title: packTitle, description: packDescription,
                },
            });
            const persistedPackRevision = await tx.agentSkillPackRevision.create({
                data: {
                    id: packRevisionId, packId, version: packVersion,
                    bindingsJson: JSON.stringify(encodedBindings),
                    contentHash: contentHash({ stableId: packStableId, version: packVersion, bindings: encodedBindings }),
                },
            });
            await this.assertPublicationUnchanged(tx, draft);
            await tx.agentSkillPack.update({ where: { id: packId }, data: { currentRevisionId: packRevisionId } });
            // Publishing a pack does not opt the novel into using it.
            const updated = await tx.agentSkillDraft.updateMany({
                where: { id: draft.id, version: draft.version },
                data: { status: 'committed', scope: draft.scope, draftJson: JSON.stringify(draft.draft), committedPackRevisionId: packRevisionId, version: { increment: 1 }, updatedAt: new Date() },
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
