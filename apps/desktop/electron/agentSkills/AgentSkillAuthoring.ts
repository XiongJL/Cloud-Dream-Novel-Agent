import { createHash } from 'node:crypto';
import { validateSkillExecutionHints } from '../../shared/skillExecutionHints';
import { REGISTERED_AGENT_OPERATIONS } from '../../shared/agentOperationIds';

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

export type AgentSkillAuthorRules = {
    title?: string;
    description?: string;
    instructions?: string;
    constraints?: string[];
};

export type AgentSkillAuthoringRepair = { code: string; path: string; message: string };

export type AgentSkillAuthoringState = {
    schemaVersion: typeof AGENT_SKILL_AUTHORING_SCHEMA_VERSION;
    phase: AgentSkillAuthoringPhase;
    documents: AgentSkillAuthoringDocument[];
    sourceSnapshotRefs: string[];
    validationReport?: AgentSkillAuthoringValidationReport;
    repairs?: AgentSkillAuthoringRepair[];
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
        ...(Array.isArray(raw.repairs) ? { repairs: raw.repairs.slice(-64) as AgentSkillAuthoringRepair[] } : {}),
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

/** Author input only changes author-owned fields. Unknown metadata stays byte-for-byte in the header. */
export function prepareAgentSkillAuthoringDraft(input: {
    draft: Record<string, unknown>;
    draftId: string;
    action: 'create' | 'update' | 'derive' | 'pack';
    scope: 'user' | 'novel';
    sourceNovelId?: string;
    systemIdentity?: { stableId?: string; version?: string };
    logicalPath?: string;
    rules?: AgentSkillAuthorRules;
}): { draft: Record<string, unknown>; repairs: AgentSkillAuthoringRepair[] } {
    const state = readAgentSkillAuthoringState(input.draft);
    if (!state) throw new Error('AGENT_SKILL_WORKSPACE_NOT_FOUND');
    const selectedPath = input.logicalPath || 'SKILL.md';
    if (input.logicalPath && (!isAllowedAgentSkillLogicalPath(selectedPath)
        || selectedPath !== 'SKILL.md' && !selectedPath.endsWith('/SKILL.md'))) {
        throw new Error('AGENT_SKILL_WORKSPACE_PATH_INVALID');
    }
    if (input.rules !== undefined) {
        const rules = asObject(input.rules);
        if (!input.rules || Array.isArray(input.rules) || typeof input.rules !== 'object'
            || Object.keys(rules).some((key) => !['title', 'description', 'instructions', 'constraints'].includes(key))
            || ['title', 'description', 'instructions'].some((key) => rules[key] !== undefined && typeof rules[key] !== 'string')
            || rules.constraints !== undefined && (!Array.isArray(rules.constraints)
                || rules.constraints.some((item) => typeof item !== 'string'))) {
            throw new Error('AGENT_SKILL_WORKSPACE_AUTHOR_RULES_INVALID');
        }
        if (!state.documents.some((document) => document.logicalPath === selectedPath && !document.deleted)) {
            throw new Error('AGENT_SKILL_WORKSPACE_DOCUMENT_NOT_FOUND');
        }
    }
    const repairs: AgentSkillAuthoringRepair[] = [];
    const documents = state.documents.map((document) => {
        if (document.deleted || document.mediaType !== 'text/markdown'
            || !isAllowedAgentSkillLogicalPath(document.logicalPath)
            || document.logicalPath !== 'SKILL.md' && !document.logicalPath.endsWith('/SKILL.md')
            || document.contentHash !== hashAgentSkillDocument(document.contentText)) return document;
        let contentText = document.contentText;
        const repair = (code: string, message: string) => repairs.push({ code, path: document.logicalPath, message });
        // Only unwrap an entire Markdown document, never an embedded example/code block.
        const fenced = /^\s*```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(contentText);
        if (fenced && fenced[1].replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').startsWith('---\n')
            && !parseFrontmatter(document.logicalPath, fenced[1]).diagnostics.length) {
            contentText = fenced[1];
            repair('SKILL_DOCUMENT_FENCE_REMOVED', '已移除整个技能文档外层的 Markdown 围栏。');
        }
        const normalized = contentText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        const lines = normalized.split('\n');
        const headerEnd = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
        if (lines[0]?.trim() !== '---' || headerEnd < 0) return { ...document, contentText, contentHash: hashAgentSkillDocument(contentText) };
        const header = lines.slice(1, headerEnd);
        const parsed = parseFrontmatter(document.logicalPath, contentText);
        const rules = document.logicalPath === selectedPath ? input.rules : undefined;
        let headerChanged = false;
        const setField = (key: string, value: string | string[], code?: string, message?: string) => {
            const matches = header.map((line, index) => line.startsWith(`${key}:`) ? index : -1).filter((index) => index >= 0);
            // A duplicate field has no unique interpretation. Leave it for diagnostics.
            if (matches.length > 1) return;
            const replacement = Array.isArray(value) ? yamlList(key, value) : [`${key}: ${quoteYaml(value)}`];
            const start = matches[0] ?? header.length;
            let end = start + (matches.length ? 1 : 0);
            while (end < header.length && /^\s+/.test(header[end])) end += 1;
            if (header.slice(start, end).join('\n') === replacement.join('\n')) return;
            header.splice(start, end - start, ...replacement);
            headerChanged = true;
            if (code && message) repair(code, message);
        };
        const hasField = (key: string) => Object.prototype.hasOwnProperty.call(parsed.values, key);
        if (!hasField('schemaVersion')) setField('schemaVersion', 'novel-editor.agent-skill.v1',
            'SKILL_SCHEMA_VERSION_ADDED', '已补齐软件管理的技能文档格式标识。');
        if (!hasField('skillType')) setField('skillType', 'prompt_method',
            'SKILL_TYPE_ADDED', '已补齐声明式创作技能类型。');
        const memberSuffix = document.logicalPath === 'SKILL.md' ? '' : `-${document.logicalPath.split('/')[0]}`;
        const fallbackId = `${input.scope}.skill-${input.draftId}${memberSuffix}`;
        const stableId = input.systemIdentity?.stableId
            || (input.action !== 'update' && fallbackId.length <= 64 && STABLE_ID_PATTERN.test(fallbackId) ? fallbackId : undefined);
        if (!stringValue(parsed.values, 'stableId', 'id') && stableId) setField('stableId', stableId,
            'SKILL_ID_ADDED', '已补齐软件管理的稳定技能标识。');
        const version = input.systemIdentity?.version || (input.action !== 'update' ? '1.0.0' : undefined);
        if (!stringValue(parsed.values, 'version') && version) setField('version', version,
            'SKILL_VERSION_ADDED', '已补齐软件管理的技能版本。');
        if (stringValue(parsed.values, 'scope') !== input.scope) setField('scope', input.scope,
            'SKILL_SCOPE_NORMALIZED', '已根据实际保存位置整理技能归属。');
        if (input.scope === 'novel' && input.sourceNovelId
            && stringValue(parsed.values, 'ownerNovelId') !== input.sourceNovelId) {
            setField('ownerNovelId', input.sourceNovelId, 'SKILL_OWNER_NORMALIZED', '已关联草稿所属小说。');
        }
        if (input.scope === 'user' && hasField('ownerNovelId')) {
            const ownerIndex = header.findIndex(line => /^ownerNovelId:/.test(line));
            if (ownerIndex >= 0) {header.splice(ownerIndex, 1); headerChanged = true;}
        }
        if (stringValue(parsed.values, 'category') === 'style'
            && ['markdown', 'text'].includes(stringValue(parsed.values, 'outputType'))) {
            setField('outputType', 'none', 'SKILL_STYLE_OUTPUT_TYPE_NORMALIZED', '已将文风的文本格式说明整理为合法输出类型。');
        }
        if (rules?.title !== undefined) setField(hasField('title') ? 'title' : 'name', rules.title);
        if (rules?.description !== undefined) setField('description', rules.description);
        if (rules?.constraints !== undefined) setField('constraints', rules.constraints);
        const body = rules?.instructions !== undefined ? `\n${rules.instructions.trim()}\n` : lines.slice(headerEnd + 1).join('\n');
        if (headerChanged || rules?.instructions !== undefined) contentText = ['---', ...header, '---', body].join('\n');
        return contentText === document.contentText ? document : {
            ...document, contentText, contentHash: hashAgentSkillDocument(contentText),
        };
    });
    if (documents.every((document, index) => document === state.documents[index])) return { draft: input.draft, repairs };
    const authoring: AgentSkillAuthoringState = {
        ...state, documents, phase: 'authoring',
        repairs: [...(state.repairs || []), ...repairs].slice(-64),
        authoringInputHash: buildAgentSkillAuthoringInputHash(documents, input.draft.pack),
        validationReport: undefined, validatedInputHash: undefined, compiledInputHash: undefined,
    };
    return { draft: { ...input.draft, authoring }, repairs };
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
    if (diagnostics.some(item => ['SKILL_FRONTMATTER_MISSING', 'SKILL_FRONTMATTER_UNCLOSED'].includes(item.code))) {
        // No fields can be parsed yet. Report the framing problem once instead
        // of manufacturing missing-field errors for every downstream property.
        return { diagnostics };
    }
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
        || supportedOperations.some((item) => !REGISTERED_AGENT_OPERATIONS.has(item))) {
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

    let executionHints: Record<string, unknown> | undefined;
    if (values.executionHints !== undefined) {
        try {
            executionHints = typeof values.executionHints === 'string'
                ? JSON.parse(values.executionHints) : values.executionHints as Record<string, unknown>;
            validateSkillExecutionHints(executionHints);
        } catch (error) {
            fieldError(diagnostics, input.logicalPath, 'SKILL_EXECUTION_HINTS_INVALID', String(error));
        }
    }
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
                    ...(executionHints ? { executionHints } : {}),
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

export function validatePack(pack: Record<string, unknown>, members: Array<{ key: string; manifest: Record<string, unknown> }>): AgentSkillAuthoringDiagnostic[] {
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
    const knownKeys = new Set(members.map(member => member.key));
    const core = String(revision.coreDraftKey || '');
    if (core && !knownKeys.has(core)) fieldError(diagnostics, '', 'SKILL_PACK_CORE_INVALID', '文风核心成员不存在。');
    const seenBindings = new Set<string>();
    if (!bindings.length) fieldError(diagnostics, '', 'SKILL_PACK_BINDINGS_REQUIRED', 'Pack 至少需要一个绑定。');
    for (const binding of bindings) {
        const operationId = String(binding.operationId || '').trim();
        const roleId = String(binding.roleId || '').trim();
        const primaryDraftKey = String(binding.primaryDraftKey || '').trim();
        const auxiliaryDraftKey = String(binding.auxiliaryDraftKey || '').trim();
        const choices = Array.isArray(binding.allowedAuxiliaryDraftKeys) ? binding.allowedAuxiliaryDraftKeys.map(String) : [];
        if (choices.some(key => !knownKeys.has(key) || key === primaryDraftKey)) fieldError(diagnostics, '', 'SKILL_PACK_AUXILIARY_INVALID', '辅助候选必须是包内不同成员。');
        if (core && roleId === 'writer' && ['chapter.create','chapter.continuation','chapter.sequence_continuation','chapter.rewrite','chapter.batch_rewrite'].includes(operationId) && primaryDraftKey !== core)
            fieldError(diagnostics, '', 'SKILL_PACK_CORE_REQUIRED', '写作操作必须保留语言核心。');
        if (!REGISTERED_AGENT_OPERATIONS.has(operationId) || !ALLOWED_ROLES.has(roleId)
            || !knownKeys.has(primaryDraftKey) || (auxiliaryDraftKey && !knownKeys.has(auxiliaryDraftKey))) {
            fieldError(diagnostics, '', 'SKILL_PACK_BINDING_INVALID', `Pack 绑定无效或操作未注册：${operationId}/${roleId}。`);
        }
        const identity = `${operationId}/${roleId}`;
        if (seenBindings.has(identity) || primaryDraftKey === auxiliaryDraftKey) {
            fieldError(diagnostics, '', 'SKILL_PACK_BINDING_CONFLICT', `Pack 绑定重复或主辅成员相同：${identity}。`);
        }
        seenBindings.add(identity);
        for (const key of [primaryDraftKey, auxiliaryDraftKey, ...choices].filter(Boolean)) {
            const manifest = members.find(member => member.key === key)?.manifest;
            if (!manifest) continue;
            const operations = Array.isArray(manifest.supportedOperations) ? manifest.supportedOperations : [];
            const roles = Array.isArray(manifest.allowedRoles) ? manifest.allowedRoles : [];
            if (!operations.includes(operationId) || (roles.length && !roles.includes(roleId))) {
                fieldError(diagnostics, `${key}/SKILL.md`, 'SKILL_PACK_MEMBER_INCOMPATIBLE',
                    `成员 ${key} 不支持绑定 ${identity}；请调整绑定或在方法适用时修正成员声明。`);
            }
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
        if (skillDocuments.length < 1 || skillDocuments.length > 3 || skillDocuments.some((document) => document.logicalPath === 'SKILL.md')) {
            fieldError(diagnostics, '', 'SKILL_PACK_MEMBERS_INVALID', 'Pack 必须包含 1 到 3 个一级成员目录中的 SKILL.md。');
        }
    } else if (skillDocuments.length !== 1 || skillDocuments[0]?.logicalPath !== 'SKILL.md') {
        fieldError(diagnostics, '', 'SKILL_SINGLE_DOCUMENT_REQUIRED', '单 Skill 工作区必须且只能包含根 SKILL.md。');
    }
    for (const document of skillDocuments) {
        if (input.action === 'update' && !stringValue(parseFrontmatter(document.logicalPath, document.contentText).values, 'version')) {
            fieldError(diagnostics, document.logicalPath, 'SKILL_VERSION_INVALID', '更新版本缺失，须先恢复目标技能的明确版本信息。');
        }
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
            diagnostics.push(...validatePack(asObject(input.draft.pack), projections.map(item => ({
                key: item.key, manifest: asObject(item.projection.revision.manifest),
            }))));
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
        ...(manifest.executionHints ? [`executionHints: ${JSON.stringify(JSON.stringify(manifest.executionHints))}`] : []),
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
