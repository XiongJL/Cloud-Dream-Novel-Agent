export interface SkillExecutionHints {
    version: 1;
    decomposition: 'unknown' | 'none' | 'independent_units' | 'ordered_units' | 'multiple_perspectives';
    preferredUnit: 'chapter' | 'scene' | 'entity' | 'document' | 'none';
    contextRequirement: 'verbatim_samples' | 'summaries_allowed' | 'continuous_full_text';
    crossUnitDependency: 'none' | 'adjacent' | 'ordered_state' | 'global';
    resultComposition: 'evidence_findings' | 'ordered_parts' | 'synthesis';
    coverageRequirement: 'all_units' | 'representative_sample';
}

const fields = {
    decomposition: ['unknown', 'none', 'independent_units', 'ordered_units', 'multiple_perspectives'],
    preferredUnit: ['chapter', 'scene', 'entity', 'document', 'none'],
    contextRequirement: ['verbatim_samples', 'summaries_allowed', 'continuous_full_text'],
    crossUnitDependency: ['none', 'adjacent', 'ordered_state', 'global'],
    resultComposition: ['evidence_findings', 'ordered_parts', 'synthesis'],
    coverageRequirement: ['all_units', 'representative_sample'],
};

export function validateSkillExecutionHints(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('executionHints 必须为对象。');
    const hints = value as Record<string, unknown>;
    if (hints.version !== undefined && hints.version !== 1) throw new Error('executionHints 只支持 version 1。');
    for (const [key, item] of Object.entries(hints)) {
        if (key === 'version') continue;
        const allowed = fields[key as keyof typeof fields];
        if (!allowed || typeof item !== 'string' || !allowed.includes(item)) {
            throw new Error(`executionHints.${key} 不受支持。执行提示不能声明工具链、脚本、权限或并发额度。`);
        }
    }
}
