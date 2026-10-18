export interface CompiledAgentSkill {
    prompt: string;
    sections?: Array<{ skill?: {
        skillId?: string;
        stableId?: string;
        revisionId?: string;
        version?: string;
        contentHash?: string;
        position?: string;
    } }>;
    estimatedTokens?: number;
}

/** Keep the compiler's complete method, constraints and examples together. */
export function agentSkillContext(skill?: CompiledAgentSkill): Record<string, unknown> | undefined {
    if (!skill) return undefined;
    if (typeof skill.prompt !== 'string' || !skill.prompt.trim()) {
        throw new Error('Compiled Agent Skill must contain a complete prompt');
    }
    return {
        prompt: skill.prompt,
        revisions: (skill.sections || []).map((section) => section.skill || {}),
    };
}

export function agentSkillRequestMetadata(skill?: CompiledAgentSkill): Record<string, unknown> | undefined {
    const context = agentSkillContext(skill);
    return context ? {
        revisions: context.revisions,
        promptCharacters: skill!.prompt.length,
        estimatedTokens: skill!.estimatedTokens,
    } : undefined;
}

/** Fail before generation if assembly ever drops or compresses the selected rules. */
export function assertAgentSkillInPrompt(prompt: string, skill?: CompiledAgentSkill): void {
    if (!skill) return;
    agentSkillContext(skill);
    const encoded = JSON.stringify(skill.prompt).slice(1, -1);
    if (!prompt.includes(skill.prompt) && !prompt.includes(encoded)) {
        throw new Error('Complete Agent Skill rules are missing from the model prompt');
    }
}
