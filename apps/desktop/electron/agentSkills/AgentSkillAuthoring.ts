import { createHash } from 'node:crypto';

export const AGENT_SKILL_AUTHORING_SCHEMA_VERSION = 'agent-skill-authoring-v1' as const;
export const AGENT_SKILL_DOCUMENT_TOTAL_BYTES = 96 * 1024;
export const AGENT_SKILL_DOCUMENT_MAX_BYTES = 32 * 1024;
export const AGENT_SKILL_DOCUMENT_MAX_COUNT = 64;

export type AgentSkillAuthoringPhase =
    | 'collecting_sources'
    | 'authoring'
    | 'validating'
    | 'revising'
    | 'needs_attention'
    | 'compiled';

export type AgentSkillAuthoringDocument = {
    logicalPath: string;
    mediaType: 'text/markdown';
    contentText: string;
    contentHash: string;
    deleted: boolean;
};

export type AgentSkillAuthoringDiagnostic = {
    code: string;
    path: string;
    severity: 'error' | 'warning';
    message: string;
    line?: number;
    column?: number;
    suggestion?: string;
};

export type AgentSkillAuthoringValidationReport = {
    ok: boolean;
    checkedAt: string;
    inputHash: string;
    errorCount: number;
    warningCount: number;
    diagnostics: AgentSkillAuthoringDiagnostic[];
};

export type AgentSkillAuthoringState = {
    schemaVersion: typeof AGENT_SKILL_AUTHORING_SCHEMA_VERSION;
    phase: AgentSkillAuthoringPhase;
    documents: AgentSkillAuthoringDocument[];
    sourceSnapshotRefs: string[];
    validationReport?: AgentSkillAuthoringValidationReport;
    authoringInputHash: string;
    validatedInputHash?: string;
    compiledInputHash?: string;
};

export type AgentSkillCompiledProjection = {
    definition: Record<string, unknown>;
    revision: Record<string, unknown>;
};

export type AgentSkillWorkspaceProjection =
    | AgentSkillCompiledProjection
    | { skills: Array<Record<string, unknown>>; pack: Record<string, unknown> };

type ParsedFrontmatter = {
    values: Record<string, unknown>;
    body: string;
    diagnostics: AgentSkillAuthoringDiagnostic[];
};

const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const ALLOWED_ROLES = new Set(['team', 'writer', 'editor', 'reader', 'worldbuilding', 'research_rag']);
const ALLOWED_CATEGORIES = new Set([
    'style', 'narrative_method', 'generation', 'review', 'character_voice', 'novel_rules', 'other',
]);
const ALLOWED_GUIDANCE_MODES = new Set(['adaptive', 'guided', 'strict']);
const ALLOWED_SEMANTIC_SELECTIONS = new Set(['off', 'suggest', 'auto']);
const ALLOWED_OUTPUT_TYPES = new Set(['none', 'report', 'chapter_draft', 'creative_assets_draft']);
const LIST_FIELDS = new Set([
    'triggerHints', 'antiTriggerHints', 'supportedOperations', 'allowedRoles',
    'recommendedToolchains', 'requiredCapabilities', 'contextNeeds', 'constraints',
]);

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
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

export function hashAgentSkillAuthoringValue(value: unknown): string {
    return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export function hashAgentSkillDocument(contentText: string): string {
    return createHash('sha256').update(contentText, 'utf8').digest('hex');
}

export function isAllowedAgentSkillLogicalPath(logicalPath: string): boolean {
    if (!logicalPath || logicalPath.includes('\\') || logicalPath.startsWith('/')
        || logicalPath.includes('..') || logicalPath.includes('//')) return false;
    const segment = '[a-z0-9][a-z0-9._-]*';
    return new RegExp(`^(?:SKILL\\.md|${segment}/SKILL\\.md|(?:${segment}/)?references/(?:${segment}/)*${segment}\\.md)$`).test(logicalPath);
}

export function buildAgentSkillAuthoringInputHash(
    documents: AgentSkillAuthoringDocument[],
    pack: unknown,
): string {
    return hashAgentSkillAuthoringValue({
        documents: documents
            .filter((document) => !document.deleted)
            .map((document) => ({
                logicalPath: document.logicalPath,
                mediaType: document.mediaType,
                contentHash: document.contentHash,
            }))
            .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath)),
        pack: asObject(pack),
    });
}

export function createAgentSkillAuthoringState(input: {
    logicalPath?: string;
    contentText?: string;
    sourceSnapshotRefs?: string[];
    pack?: unknown;
} = {}): AgentSkillAuthoringState {
    const logicalPath = input.logicalPath || 'SKILL.md';
    if (!isAllowedAgentSkillLogicalPath(logicalPath) || !logicalPath.endsWith('/SKILL.md') && logicalPath !== 'SKILL.md') {
        throw new Error('AGENT_SKILL_WORKSPACE_PATH_INVALID');
    }
    const contentText = input.contentText || '';
    const documents: AgentSkillAuthoringDocument[] = [{
        logicalPath,
        mediaType: 'text/markdown',
        contentText,
        contentHash: hashAgentSkillDocument(contentText),
        deleted: false,
    }];
    return {
        schemaVersion: AGENT_SKILL_AUTHORING_SCHEMA_VERSION,
        phase: 'authoring',
        documents,
        sourceSnapshotRefs: [...new Set(input.sourceSnapshotRefs || [])].slice(0, 64),
        authoringInputHash: buildAgentSkillAuthoringInputHash(documents, input.pack),
    };
}

export function readAgentSkillAuthoringState(draft: Record<string, unknown>): AgentSkillAuthoringState | null {
    const raw = asObject(draft.authoring);
    if (raw.schemaVersion !== AGENT_SKILL_AUTHORING_SCHEMA_VERSION || !Array.isArray(raw.documents)) return null;
    const documents = raw.documents.map((item) => {
        const document = asObject(item);
        return {
            logicalPath: String(document.logicalPath || ''),
            mediaType: String(document.mediaType || '') as 'text/markdown',
            contentText: String(document.contentText || ''),
            contentHash: String(document.contentHash || ''),
            deleted: Boolean(document.deleted),
        };
    });
    return {
        schemaVersion: AGENT_SKILL_AUTHORING_SCHEMA_VERSION,
        phase: String(raw.phase || 'authoring') as AgentSkillAuthoringPhase,
        documents,
        sourceSnapshotRefs: Array.isArray(raw.sourceSnapshotRefs)
            ? raw.sourceSnapshotRefs.map(String).slice(0, 64)
            : [],
        ...(raw.validationReport ? { validationReport: raw.validationReport as AgentSkillAuthoringValidationReport } : {}),
        authoringInputHash: String(raw.authoringInputHash || ''),
        ...(raw.validatedInputHash ? { validatedInputHash: String(raw.validatedInputHash) } : {}),
        ...(raw.compiledInputHash ? { compiledInputHash: String(raw.compiledInputHash) } : {}),
    };
}

export function invalidateAgentSkillAuthoringState(
    state: AgentSkillAuthoringState,
    pack: unknown,
): AgentSkillAuthoringState {
    const documents = state.documents.map((document) => ({
        ...document,
        contentHash: hashAgentSkillDocument(document.contentText),
    }));
    return {
        ...state,
        phase: 'authoring',
        documents,
        authoringInputHash: buildAgentSkillAuthoringInputHash(documents, pack),
        validationReport: undefined,
        validatedInputHash: undefined,
        compiledInputHash: undefined,
    };
}

function parseScalar(rawValue: string): unknown {
    const value = rawValue.trim();
    if (!value) return '';
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(',').map((item) => String(parseScalar(item)).trim());
    }
    if (value.startsWith('"') && value.endsWith('"')) {
        try { return JSON.parse(value) as unknown; } catch { return value.slice(1, -1); }
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    return value;
}

function parseFrontmatter(logicalPath: string, contentText: string): ParsedFrontmatter {
    const normalized = contentText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const diagnostics: AgentSkillAuthoringDiagnostic[] = [];
    if (lines[0]?.trim() !== '---') {
        return {
            values: {}, body: normalized,
            diagnostics: [{
                code: 'SKILL_FRONTMATTER_MISSING', path: logicalPath, severity: 'error', line: 1, column: 1,
                message: 'SKILL.md 必须以 --- 开始 Frontmatter。',
                suggestion: '补充 novel-editor.agent-skill.v1 Frontmatter。',
            }],
        };
    }
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 0) {
        return {
            values: {}, body: '',
            diagnostics: [{
                code: 'SKILL_FRONTMATTER_UNCLOSED', path: logicalPath, severity: 'error', line: 1, column: 1,
                message: 'Frontmatter 缺少结束分隔符 ---。',
            }],
        };
    }
    const values: Record<string, unknown> = {};
    for (let index = 1; index < end;) {
        const line = lines[index];
        if (!line.trim() || line.trimStart().startsWith('#')) {
            index += 1;
            continue;
        }
        const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
        if (!match) {
            diagnostics.push({
                code: 'SKILL_FRONTMATTER_SYNTAX_INVALID', path: logicalPath, severity: 'error',
                line: index + 1, column: 1, message: 'Frontmatter 顶层字段格式无效。',
            });
            index += 1;
            continue;
        }
        const [, key, tail = ''] = match;
        if (Object.prototype.hasOwnProperty.call(values, key)) {
            diagnostics.push({
                code: 'SKILL_FRONTMATTER_DUPLICATE_FIELD', path: logicalPath, severity: 'error',
                line: index + 1, column: 1, message: `Frontmatter 字段 ${key} 重复。`,
            });
        }
        if (tail.trim()) {
            values[key] = parseScalar(tail);
            index += 1;
            continue;
        }
        const items: string[] = [];
        let cursor = index + 1;
        while (cursor < end && /^\s+/.test(lines[cursor])) {
            const itemMatch = /^\s+-\s*(.*)$/.exec(lines[cursor]);
            if (itemMatch) items.push(String(parseScalar(itemMatch[1])));
            cursor += 1;
        }
        if (LIST_FIELDS.has(key)) values[key] = items;
        else if (!Object.prototype.hasOwnProperty.call(values, key)) values[key] = '';
        index = cursor;
    }
    return { values, body: lines.slice(end + 1).join('\n').trim(), diagnostics };
}

function stringValue(values: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        if (typeof values[key] === 'string' && String(values[key]).trim()) return String(values[key]).trim();
    }
    return '';
}

function stringList(values: Record<string, unknown>, key: string): string[] {
    const value = values[key];
    if (!Array.isArray(value)) return [];
    return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function fieldError(
    diagnostics: AgentSkillAuthoringDiagnostic[],
    path: string,
    code: string,
    message: string,
): void {
    diagnostics.push({ code, path, severity: 'error', message });
}

export function compileAgentSkillMarkdown(input: {
    logicalPath: string;
    contentText: string;
    expectedScope: 'user' | 'novel';
    origin: 'authored' | 'derived' | 'imported';
}): { projection?: AgentSkillCompiledProjection; diagnostics: AgentSkillAuthoringDiagnostic[] } {
    const parsed = parseFrontmatter(input.logicalPath, input.contentText);
    const { values } = parsed;
    const diagnostics = [...parsed.diagnostics];
    const schemaVersion = stringValue(values, 'schemaVersion');
    const stableId = stringValue(values, 'stableId', 'id');
    const title = stringValue(values, 'title', 'name');
    const description = stringValue(values, 'description');
    const version = stringValue(values, 'version') || '1.0.0';
    const scope = stringValue(values, 'scope');
    const category = stringValue(values, 'category') || 'other';
    const guidanceMode = stringValue(values, 'guidanceMode') || 'guided';
    const semanticSelection = stringValue(values, 'semanticSelection') || 'suggest';
    const outputType = stringValue(values, 'outputType') || 'none';
    const triggerHints = stringList(values, 'triggerHints');
    const antiTriggerHints = stringList(values, 'antiTriggerHints');
    const supportedOperations = stringList(values, 'supportedOperations');
    const allowedRoles = stringList(values, 'allowedRoles');
    const recommendedToolchains = stringList(values, 'recommendedToolchains');
    const requiredCapabilities = stringList(values, 'requiredCapabilities');
    const contextNeeds = stringList(values, 'contextNeeds');
    const constraints = stringList(values, 'constraints');

    if (schemaVersion !== 'novel-editor.agent-skill.v1') {
        fieldError(diagnostics, input.logicalPath, 'SKILL_SCHEMA_VERSION_INVALID', 'schemaVersion 必须为 novel-editor.agent-skill.v1。');
    }
    if (!STABLE_ID_PATTERN.test(stableId) || stableId.length > 64) {
        fieldError(diagnostics, input.logicalPath, 'SKILL_STABLE_ID_INVALID', 'id/stableId 必须是最长 64 字符的小写 ASCII 点号或连字符标识。');
    }
    if (!title || title.length > 120) fieldError(diagnostics, input.logicalPath, 'SKILL_TITLE_INVALID', 'name/title 必填且最长 120 字符。');
    if (!description || description.length > 1_000) fieldError(diagnostics, input.logicalPath, 'SKILL_DESCRIPTION_INVALID', 'description 必填且最长 1000 字符。');
    if (!VERSION_PATTERN.test(version)) fieldError(diagnostics, input.logicalPath, 'SKILL_VERSION_INVALID', 'version 必须是 x.y.z。');
    if (scope !== input.expectedScope) fieldError(diagnostics, input.logicalPath, 'SKILL_SCOPE_MISMATCH', `scope 必须与工作区一致：${input.expectedScope}。`);
    if (stringValue(values, 'skillType') && stringValue(values, 'skillType') !== 'prompt_method') {
        fieldError(diagnostics, input.logicalPath, 'SKILL_TYPE_INVALID', 'skillType 只能是 prompt_method。');
    }
    if (!ALLOWED_CATEGORIES.has(category)) fieldError(diagnostics, input.logicalPath, 'SKILL_CATEGORY_INVALID', `不支持 category：${category}。`);
    if (!ALLOWED_GUIDANCE_MODES.has(guidanceMode)) fieldError(diagnostics, input.logicalPath, 'SKILL_GUIDANCE_MODE_INVALID', `不支持 guidanceMode：${guidanceMode}。`);
    if (!ALLOWED_SEMANTIC_SELECTIONS.has(semanticSelection)) fieldError(diagnostics, input.logicalPath, 'SKILL_SEMANTIC_SELECTION_INVALID', `不支持 semanticSelection：${semanticSelection}。`);
    if (!ALLOWED_OUTPUT_TYPES.has(outputType)) fieldError(diagnostics, input.logicalPath, 'SKILL_OUTPUT_TYPE_INVALID', `不支持 outputType：${outputType}。`);
    if (!triggerHints.length || triggerHints.length > 8) fieldError(diagnostics, input.logicalPath, 'SKILL_TRIGGER_HINTS_INVALID', 'triggerHints 必须包含 1 到 8 项。');
    if (!antiTriggerHints.length || antiTriggerHints.length > 8) fieldError(diagnostics, input.logicalPath, 'SKILL_ANTI_TRIGGER_HINTS_INVALID', 'antiTriggerHints 必须包含 1 到 8 项。');
    if (!supportedOperations.length || supportedOperations.length > 12
        || supportedOperations.some((item) => !OPERATION_ID_PATTERN.test(item))) {
        fieldError(diagnostics, input.logicalPath, 'SKILL_OPERATIONS_INVALID', 'supportedOperations 必须包含 1 到 12 个合法 Operation ID。');
    }
    const unknownRoles = allowedRoles.filter((item) => !ALLOWED_ROLES.has(item));
    if (allowedRoles.length > 8 || unknownRoles.length) fieldError(diagnostics, input.logicalPath, 'SKILL_ROLES_INVALID', `allowedRoles 包含不支持的角色：${unknownRoles.join(', ')}。`);
    if (semanticSelection === 'auto' && (!triggerHints.length || !antiTriggerHints.length)) {
        fieldError(diagnostics, input.logicalPath, 'SKILL_AUTO_SELECTION_HINTS_REQUIRED', 'semanticSelection=auto 时必须同时提供正反触发提示。');
    }
    if (!parsed.body || parsed.body.length > 32_000) {
        fieldError(diagnostics, input.logicalPath, 'SKILL_INSTRUCTIONS_INVALID', 'Markdown 正文必填且最长 32000 字符。');
    }
    if (constraints.length > 24) fieldError(diagnostics, input.logicalPath, 'SKILL_CONSTRAINTS_INVALID', 'constraints 最多 24 项。');

    if (diagnostics.some((item) => item.severity === 'error')) return { diagnostics };
    return {
        diagnostics,
        projection: {
            definition: { stableId, title, description },
            revision: {
                version,
                instructions: parsed.body,
                constraints,
                examples: [],
                manifest: {
                    category,
                    origin: input.origin,
                    guidanceMode,
                    semanticSelection,
                    triggerHints,
                    antiTriggerHints,
                    allowedRoles,
                    supportedOperations,
                    recommendedToolchains,
                    requiredCapabilities,
                    contextNeeds,
                    outputType,
                },
            },
        },
    };
}

function validateDocumentEnvelope(documents: AgentSkillAuthoringDocument[]): AgentSkillAuthoringDiagnostic[] {
    const diagnostics: AgentSkillAuthoringDiagnostic[] = [];
    if (documents.length > AGENT_SKILL_DOCUMENT_MAX_COUNT) {
        fieldError(diagnostics, '', 'SKILL_WORKSPACE_DOCUMENT_COUNT_EXCEEDED', `工作区文档不能超过 ${AGENT_SKILL_DOCUMENT_MAX_COUNT} 个。`);
    }
    const active = documents.filter((document) => !document.deleted);
    const duplicates = active.filter((document, index) => active.findIndex((item) => item.logicalPath === document.logicalPath) !== index);
    for (const document of active) {
        if (!isAllowedAgentSkillLogicalPath(document.logicalPath)) {
            fieldError(diagnostics, document.logicalPath, 'SKILL_WORKSPACE_PATH_INVALID', '逻辑路径不在 Skill 工作区白名单内。');
        }
        if (document.mediaType !== 'text/markdown') {
            fieldError(diagnostics, document.logicalPath, 'SKILL_WORKSPACE_MEDIA_TYPE_INVALID', '首期只支持 text/markdown。');
        }
        const actualHash = hashAgentSkillDocument(document.contentText);
        if (document.contentHash !== actualHash) {
            fieldError(diagnostics, document.logicalPath, 'SKILL_WORKSPACE_CONTENT_HASH_MISMATCH', '文档内容哈希不一致，需要重新写入。');
        }
        if (Buffer.byteLength(document.contentText, 'utf8') > AGENT_SKILL_DOCUMENT_MAX_BYTES) {
            fieldError(diagnostics, document.logicalPath, 'SKILL_WORKSPACE_DOCUMENT_TOO_LARGE', '单个工作区文档不能超过 32 KiB。');
        }
    }
    for (const duplicate of duplicates) fieldError(diagnostics, duplicate.logicalPath, 'SKILL_WORKSPACE_DUPLICATE_PATH', '工作区存在重复逻辑路径。');
    const totalBytes = active.reduce((sum, document) => sum + Buffer.byteLength(document.contentText, 'utf8'), 0);
    if (totalBytes > AGENT_SKILL_DOCUMENT_TOTAL_BYTES) {
        fieldError(diagnostics, '', 'SKILL_WORKSPACE_TOTAL_TOO_LARGE', '工作区文档正文合计不能超过 96 KiB。');
    }
    return diagnostics;
}

function validatePack(pack: Record<string, unknown>, memberKeys: string[]): AgentSkillAuthoringDiagnostic[] {
    const diagnostics: AgentSkillAuthoringDiagnostic[] = [];
    const definition = asObject(pack.definition);
    const revision = asObject(pack.revision);
    const stableId = String(definition.stableId || '').trim();
    const title = String(definition.title || '').trim();
    const description = String(definition.description || '').trim();
    const version = String(revision.version || '').trim();
    const bindings = Array.isArray(revision.bindings) ? revision.bindings.map(asObject) : [];
    if (!STABLE_ID_PATTERN.test(stableId) || stableId.length > 64) fieldError(diagnostics, '', 'SKILL_PACK_STABLE_ID_INVALID', 'Pack stableId 无效。');
    if (!title || title.length > 120) fieldError(diagnostics, '', 'SKILL_PACK_TITLE_INVALID', 'Pack title 必填且最长 120 字符。');
    if (!description || description.length > 1_000) fieldError(diagnostics, '', 'SKILL_PACK_DESCRIPTION_INVALID', 'Pack description 必填且最长 1000 字符。');
    if (!VERSION_PATTERN.test(version)) fieldError(diagnostics, '', 'SKILL_PACK_VERSION_INVALID', 'Pack version 必须是 x.y.z。');
    const knownKeys = new Set(memberKeys);
    if (!bindings.length) fieldError(diagnostics, '', 'SKILL_PACK_BINDINGS_REQUIRED', 'Pack 至少需要一个绑定。');
    for (const binding of bindings) {
        const operationId = String(binding.operationId || '').trim();
        const roleId = String(binding.roleId || '').trim();
        const primaryDraftKey = String(binding.primaryDraftKey || '').trim();
        const auxiliaryDraftKey = String(binding.auxiliaryDraftKey || '').trim();
        if (!OPERATION_ID_PATTERN.test(operationId) || !ALLOWED_ROLES.has(roleId)
            || !knownKeys.has(primaryDraftKey) || (auxiliaryDraftKey && !knownKeys.has(auxiliaryDraftKey))) {
            fieldError(diagnostics, '', 'SKILL_PACK_BINDING_INVALID', 'Pack 绑定的 Operation、Role 或成员引用无效。');
        }
    }
    return diagnostics;
}

export function validateAgentSkillWorkspace(input: {
    draft: Record<string, unknown>;
    action: 'create' | 'update' | 'derive' | 'pack';
    scope: 'user' | 'novel';
}): { report: AgentSkillAuthoringValidationReport; projection?: AgentSkillWorkspaceProjection } {
    const state = readAgentSkillAuthoringState(input.draft);
    if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
    const diagnostics = validateDocumentEnvelope(state.documents);
    const expectedInputHash = buildAgentSkillAuthoringInputHash(state.documents, input.draft.pack);
    if (state.authoringInputHash !== expectedInputHash) {
        fieldError(diagnostics, '', 'SKILL_WORKSPACE_INPUT_HASH_MISMATCH', '工作区输入哈希已过期，需要重新写入或校验。');
    }
    const skillDocuments = state.documents
        .filter((document) => !document.deleted && (document.logicalPath === 'SKILL.md' || document.logicalPath.endsWith('/SKILL.md')))
        .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
    const projections: Array<{ key: string; projection: AgentSkillCompiledProjection }> = [];
    if (input.action === 'pack') {
        if (skillDocuments.length < 2 || skillDocuments.length > 3 || skillDocuments.some((document) => document.logicalPath === 'SKILL.md')) {
            fieldError(diagnostics, '', 'SKILL_PACK_MEMBERS_INVALID', 'Pack 必须包含 2 到 3 个一级成员目录中的 SKILL.md。');
        }
    } else if (skillDocuments.length !== 1 || skillDocuments[0]?.logicalPath !== 'SKILL.md') {
        fieldError(diagnostics, '', 'SKILL_SINGLE_DOCUMENT_REQUIRED', '单 Skill 工作区必须且只能包含根 SKILL.md。');
    }
    for (const document of skillDocuments) {
        const compiled = compileAgentSkillMarkdown({
            logicalPath: document.logicalPath,
            contentText: document.contentText,
            expectedScope: input.scope,
            origin: input.action === 'derive' || input.action === 'pack' ? 'derived' : 'authored',
        });
        diagnostics.push(...compiled.diagnostics);
        if (compiled.projection) {
            projections.push({
                key: document.logicalPath === 'SKILL.md' ? 'skill' : document.logicalPath.split('/')[0],
                projection: compiled.projection,
            });
        }
    }
    let projection: AgentSkillWorkspaceProjection | undefined;
    if (!diagnostics.some((item) => item.severity === 'error')) {
        if (input.action === 'pack') {
            const memberKeys = projections.map((item) => item.key);
            diagnostics.push(...validatePack(asObject(input.draft.pack), memberKeys));
            if (!diagnostics.some((item) => item.severity === 'error')) {
                projection = {
                    skills: projections.map((item) => ({ draftKey: item.key, ...item.projection })),
                    pack: asObject(input.draft.pack),
                };
            }
        } else {
            projection = projections[0]?.projection;
        }
    }
    const report: AgentSkillAuthoringValidationReport = {
        ok: !diagnostics.some((item) => item.severity === 'error'),
        checkedAt: new Date().toISOString(),
        inputHash: expectedInputHash,
        errorCount: diagnostics.filter((item) => item.severity === 'error').length,
        warningCount: diagnostics.filter((item) => item.severity === 'warning').length,
        diagnostics,
    };
    return { report, ...(projection ? { projection } : {}) };
}

function quoteYaml(value: string): string {
    return JSON.stringify(value);
}

function yamlList(key: string, values: unknown): string[] {
    const items = Array.isArray(values) ? values.map(String).filter(Boolean) : [];
    return [
        `${key}:`,
        ...items.map((item) => `  - ${quoteYaml(item)}`),
    ];
}

export function serializeAgentSkillProjection(projection: AgentSkillCompiledProjection, scope: 'user' | 'novel'): string {
    const definition = asObject(projection.definition);
    const revision = asObject(projection.revision);
    const manifest = asObject(revision.manifest);
    const lines = [
        '---',
        'schemaVersion: novel-editor.agent-skill.v1',
        `stableId: ${quoteYaml(String(definition.stableId || ''))}`,
        `version: ${quoteYaml(String(revision.version || '1.0.0'))}`,
        `name: ${quoteYaml(String(definition.title || ''))}`,
        `description: ${quoteYaml(String(definition.description || ''))}`,
        `scope: ${scope}`,
        'skillType: prompt_method',
        `category: ${String(manifest.category || 'other')}`,
        `guidanceMode: ${String(manifest.guidanceMode || 'guided')}`,
        `semanticSelection: ${String(manifest.semanticSelection || 'suggest')}`,
        ...yamlList('triggerHints', manifest.triggerHints),
        ...yamlList('antiTriggerHints', manifest.antiTriggerHints),
        ...yamlList('supportedOperations', manifest.supportedOperations),
        ...yamlList('allowedRoles', manifest.allowedRoles),
        ...yamlList('recommendedToolchains', manifest.recommendedToolchains),
        ...yamlList('requiredCapabilities', manifest.requiredCapabilities),
        ...yamlList('contextNeeds', manifest.contextNeeds),
        `outputType: ${String(manifest.outputType || 'none')}`,
        ...yamlList('constraints', revision.constraints),
        '---',
        '',
        String(revision.instructions || '').trim(),
        '',
    ];
    return lines.join('\n');
}

export function assertAgentSkillAuthoringCommitReady(input: {
    draft: Record<string, unknown>;
    action: 'create' | 'update' | 'derive' | 'pack';
    scope: 'user' | 'novel';
    status: string;
}): void {
    const state = readAgentSkillAuthoringState(input.draft);
    if (!state) return;
    const actualInputHash = buildAgentSkillAuthoringInputHash(state.documents, input.draft.pack);
    if (input.status !== 'ready_for_review' || state.phase !== 'compiled'
        || !actualInputHash || state.authoringInputHash !== actualInputHash
        || state.validatedInputHash !== actualInputHash || state.compiledInputHash !== actualInputHash) {
        throw new Error('AGENT_SKILL_WORKSPACE_STALE');
    }
    const validated = validateAgentSkillWorkspace(input);
    if (!validated.report.ok || !validated.projection) throw new Error('AGENT_SKILL_WORKSPACE_VALIDATION_REQUIRED');
    if (input.action === 'pack') {
        const projection = validated.projection as { skills: Array<Record<string, unknown>>; pack: Record<string, unknown> };
        if (canonical(input.draft.skills) !== canonical(projection.skills)
            || canonical(input.draft.pack) !== canonical(projection.pack)) {
            throw new Error('AGENT_SKILL_WORKSPACE_COMPILED_PROJECTION_STALE');
        }
    } else {
        const projection = validated.projection as AgentSkillCompiledProjection;
        if (canonical(input.draft.definition) !== canonical(projection.definition)
            || canonical(input.draft.revision) !== canonical(projection.revision)) {
            throw new Error('AGENT_SKILL_WORKSPACE_COMPILED_PROJECTION_STALE');
        }
    }
}
