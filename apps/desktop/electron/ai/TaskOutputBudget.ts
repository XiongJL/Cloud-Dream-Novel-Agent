import { AgentContextTokenCounter } from './context/AgentContextTokenCounter';
import { resolveAgentModelContextCapability } from '../../shared/agentModelContextCapabilities';
import { resolveModelOutputCapability, PRODUCT_OUTPUT_SAFETY_LIMIT } from '../../shared/modelOutputCapabilities';
import type { AiHttpApiMode, AiProviderType } from './types';

export type OutputBudgetMode = 'auto' | 'manual';
export type OutputBudgetTask = 'title' | 'intent' | 'plan' | 'chapter_draft' | 'editor_review' | 'creative_assets';

export interface TaskOutputBudget {
    mode: OutputBudgetMode;
    task: OutputBudgetTask;
    requestedTokens: number;
    initialTokens: number;
    recoveryTokens: number;
    totalTaskTokens: number;
    modelMaximumTokens?: number;
    modelCapabilitySource: string;
    productMaximumTokens: number;
    contextMaximumTokens: number;
    userMaximumTokens?: number;
    canIncreaseOnce: boolean;
}

// Context assembly may lower the available reserve. Apply that limit to both
// attempts so an automatic recovery cannot exceed the assembled prompt budget.
export function capTaskOutputBudget(budget: TaskOutputBudget, reserveTokens: number): TaskOutputBudget {
    const initialTokens = Math.min(budget.initialTokens, reserveTokens);
    const recoveryTokens = Math.min(budget.recoveryTokens, reserveTokens);
    const canIncreaseOnce = budget.canIncreaseOnce && recoveryTokens > initialTokens;
    return {
        ...budget,
        initialTokens,
        recoveryTokens,
        totalTaskTokens: initialTokens + (canIncreaseOnce ? recoveryTokens : 0),
        canIncreaseOnce,
    };
}

function taskRequestedTokens(task: OutputBudgetTask, targetLength?: number, itemCount?: number): number {
    switch (task) {
        case 'title': return 1_024;
        case 'intent': return 4_096;
        case 'plan': return 4_096;
        case 'editor_review': return 8_192;
        case 'creative_assets': return Math.min(16_384, Math.max(8_192, (itemCount || 1) * 2_048));
        case 'chapter_draft':
            void targetLength;
            return 18_432;
    }
}

export function resolveTaskOutputBudget(input: {
    task: OutputBudgetTask;
    mode: OutputBudgetMode;
    providerType: AiProviderType;
    apiMode?: AiHttpApiMode;
    model: string;
    configuredContextWindowTokens?: number;
    manualMaxTokens: number;
    systemPrompt?: string;
    promptInput?: string;
    targetLength?: number;
    itemCount?: number;
}): TaskOutputBudget {
    void input.apiMode;
    const counter = new AgentContextTokenCounter();
    const requestedTokens = taskRequestedTokens(input.task, input.targetLength, input.itemCount);
    const outputCapability = resolveModelOutputCapability(input.model);
    const modelMaximumTokens = outputCapability.maximumTokens;
    const productMaximumTokens = PRODUCT_OUTPUT_SAFETY_LIMIT;
    const profile = resolveAgentModelContextCapability(input.providerType, input.model);
    const configuredWindow = Math.floor(Number(input.configuredContextWindowTokens) || 0);
    const contextWindow = configuredWindow > 0 ? configuredWindow : profile.defaultContextWindowTokens;
    const count = counter.count({
        providerType: input.providerType,
        model: input.model,
        configuredContextWindowTokens: configuredWindow,
        systemPrompt: input.systemPrompt,
        prompt: input.promptInput || '',
    });
    const safety = Math.max(512, Math.min(4_096, Math.floor(contextWindow * 0.03)));
    const contextMaximumTokens = Math.max(128, contextWindow - (count?.providerInputTokens || 0) - safety);
    const userMaximumTokens = input.mode === 'manual'
        ? Math.max(128, Math.floor(input.manualMaxTokens || 4_096))
        : undefined;
    const hardMaximum = Math.max(128, Math.min(
        modelMaximumTokens ?? Number.MAX_SAFE_INTEGER,
        productMaximumTokens,
        contextMaximumTokens,
        userMaximumTokens ?? Number.MAX_SAFE_INTEGER,
    ));
    const desired = Math.min(userMaximumTokens ?? requestedTokens, hardMaximum);
    const initialTokens = Math.max(
        128,
        input.mode === 'auto' && input.task === 'creative_assets'
            ? Math.min(8_192, desired)
            : desired,
    );
    const recoveryTokens = input.mode === 'auto'
        ? Math.max(initialTokens, Math.min(hardMaximum, Math.max(requestedTokens, initialTokens * 2)))
        : initialTokens;
    return {
        mode: input.mode,
        task: input.task,
        requestedTokens,
        initialTokens,
        recoveryTokens,
        totalTaskTokens: initialTokens + (recoveryTokens > initialTokens ? recoveryTokens : 0),
        modelMaximumTokens,
        modelCapabilitySource: outputCapability.source,
        productMaximumTokens,
        contextMaximumTokens,
        userMaximumTokens,
        canIncreaseOnce: input.mode === 'auto' && recoveryTokens > initialTokens,
    };
}
