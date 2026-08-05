import type { AiProviderType } from '../types';
import {
    MAXIMUM_AGENT_CONTEXT_WINDOW_TOKENS,
    MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS,
    resolveAgentModelContextCapability,
    type AgentModelContextCapability,
} from '../../../shared/agentModelContextCapabilities';

export type AgentTokenCountMethod =
    | 'provider_exact'
    | 'tokenizer_exact'
    | 'conservative_upper_bound'
    | 'estimated';

export type AgentModelContextProfile = AgentModelContextCapability;

export interface AgentContextBudget {
    profile: AgentModelContextProfile;
    contextWindowTokens: number;
    outputReserveTokens: number;
    safetyReserveTokens: number;
    providerReserveTokens: number;
    fixedProviderInputTokens: number;
    hardProviderInputLimit: number;
    hardContextBudget: number;
    triggerReserveTokens: number;
    triggerContextBudget: number;
    targetGapTokens: number;
    targetContextBudget: number;
    nextTurnReserveTokens: number;
}

export interface AgentContextTokenCount {
    contextTokens: number;
    providerInputTokens: number;
    systemTokens: number;
    toolSchemaTokens: number;
    method: AgentTokenCountMethod;
    profileId: string;
}

export interface AgentAdaptiveOutputBudget {
    requestedOutputTokens: number;
    outputReserveTokens: number;
    maximumOutputTokens: number;
    minimumOutputTokens: number;
    minimumDynamicContextTokens: number;
    feasible: boolean;
    reduced: boolean;
    budget: AgentContextBudget;
}

function upperBoundUtf8Tokens(value: string): number {
    if (!value) return 0;
    // Supported profiles tokenize non-empty byte sequences; one token per UTF-8 byte is therefore an upper bound.
    return Buffer.byteLength(value, 'utf8');
}

export function estimateContextTokens(value: string): number {
    if (!value) return 0;
    let cjk = 0;
    let other = 0;
    for (const character of value) {
        if (/[^\u0000-\u00ff]/.test(character)) cjk += 1;
        else other += 1;
    }
    return Math.max(1, cjk + Math.ceil(other / 4));
}

export function resolveAgentModelContextProfile(
    providerType: AiProviderType,
    model: string,
    configuredContextWindowTokens = 0,
): AgentModelContextProfile {
    void configuredContextWindowTokens;
    return resolveAgentModelContextCapability(providerType, model);
}

export class AgentContextTokenCounter {
    count(input: {
        providerType: AiProviderType;
        model: string;
        systemPrompt?: string;
        prompt: string;
        toolSchema?: string;
        configuredContextWindowTokens?: number;
    }): AgentContextTokenCount | null {
        const profile = resolveAgentModelContextProfile(
            input.providerType,
            input.model,
            Math.floor(Number(input.configuredContextWindowTokens) || 0),
        );
        if (!profile?.supportsConservativeUtf8UpperBound) return null;
        const systemTokens = upperBoundUtf8Tokens(input.systemPrompt || '');
        const toolSchemaTokens = upperBoundUtf8Tokens(input.toolSchema || '');
        const contextTokens = upperBoundUtf8Tokens(input.prompt) + profile.nextTurnMessageWrapperTokens;
        return {
            contextTokens,
            providerInputTokens: contextTokens + systemTokens + toolSchemaTokens + profile.fixedProviderWrapperTokens,
            systemTokens,
            toolSchemaTokens,
            method: 'conservative_upper_bound',
            profileId: profile.profileId,
        };
    }

    budget(input: {
        providerType: AiProviderType;
        model: string;
        configuredContextWindowTokens?: number;
        outputReserveTokens: number;
        systemPrompt?: string;
        toolSchema?: string;
        safetyReserveTokens?: number;
    }): AgentContextBudget | null {
        const profile = resolveAgentModelContextProfile(
            input.providerType,
            input.model,
            Math.floor(Number(input.configuredContextWindowTokens) || 0),
        );
        if (!profile?.supportsConservativeUtf8UpperBound) return null;
        const configured = Math.floor(Number(input.configuredContextWindowTokens) || 0);
        const contextWindowTokens = configured >= MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS
            ? Math.min(MAXIMUM_AGENT_CONTEXT_WINDOW_TOKENS, configured)
            : profile.defaultContextWindowTokens;
        const outputReserveTokens = Math.max(128, Math.floor(input.outputReserveTokens));
        const safetyReserveTokens = Math.max(
            256,
            Math.floor(input.safetyReserveTokens || Math.min(4096, contextWindowTokens * 0.03)),
        );
        const fixedProviderInputTokens = upperBoundUtf8Tokens(input.systemPrompt || '')
            + upperBoundUtf8Tokens(input.toolSchema || '')
            + profile.fixedProviderWrapperTokens;
        const hardProviderInputLimit = Math.max(0, contextWindowTokens - outputReserveTokens - safetyReserveTokens);
        const hardContextBudget = Math.max(
            0,
            hardProviderInputLimit - fixedProviderInputTokens - profile.providerReserveTokens,
        );
        const triggerReserveTokens = Math.max(1024, Math.min(13_000, Math.floor(contextWindowTokens * 0.08)));
        const triggerContextBudget = Math.max(0, hardContextBudget - triggerReserveTokens);
        const targetGapTokens = Math.max(512, Math.min(4096, Math.floor(triggerContextBudget * 0.25)));
        const targetContextBudget = Math.max(0, triggerContextBudget - targetGapTokens);
        const nextTurnReserveTokens = outputReserveTokens
            + profile.defaultUserTurnReserveTokens
            + profile.nextTurnMessageWrapperTokens;
        return {
            profile,
            contextWindowTokens,
            outputReserveTokens,
            safetyReserveTokens,
            providerReserveTokens: profile.providerReserveTokens,
            fixedProviderInputTokens,
            hardProviderInputLimit,
            hardContextBudget,
            triggerReserveTokens,
            triggerContextBudget,
            targetGapTokens,
            targetContextBudget,
            nextTurnReserveTokens,
        };
    }

    adaptOutputReserve(input: {
        providerType: AiProviderType;
        model: string;
        configuredContextWindowTokens?: number;
        requestedOutputTokens: number;
        systemPrompt?: string;
        toolSchema?: string;
        safetyReserveTokens?: number;
        minimumOutputTokens?: number;
        minimumDynamicContextTokens?: number;
    }): AgentAdaptiveOutputBudget | null {
        const minimumOutputTokens = Math.max(128, Math.floor(input.minimumOutputTokens || 256));
        const minimumDynamicContextTokens = Math.max(
            256,
            Math.floor(input.minimumDynamicContextTokens || 1_280),
        );
        const requestedOutputTokens = Math.max(
            minimumOutputTokens,
            Math.floor(input.requestedOutputTokens || 0),
        );
        const minimumBudget = this.budget({
            providerType: input.providerType,
            model: input.model,
            configuredContextWindowTokens: input.configuredContextWindowTokens,
            outputReserveTokens: minimumOutputTokens,
            systemPrompt: input.systemPrompt,
            toolSchema: input.toolSchema,
            safetyReserveTokens: input.safetyReserveTokens,
        });
        if (!minimumBudget) return null;

        const maximumOutputTokens = Math.max(0, Math.floor(
            minimumBudget.contextWindowTokens
            - minimumBudget.fixedProviderInputTokens
            - minimumBudget.safetyReserveTokens
            - minimumBudget.providerReserveTokens
            - minimumDynamicContextTokens,
        ));
        const feasible = maximumOutputTokens >= minimumOutputTokens;
        const outputReserveTokens = feasible
            ? Math.min(requestedOutputTokens, maximumOutputTokens)
            : 0;
        const budget = feasible && outputReserveTokens !== minimumOutputTokens
            ? this.budget({
                providerType: input.providerType,
                model: input.model,
                configuredContextWindowTokens: input.configuredContextWindowTokens,
                outputReserveTokens,
                systemPrompt: input.systemPrompt,
                toolSchema: input.toolSchema,
                safetyReserveTokens: input.safetyReserveTokens,
            }) || minimumBudget
            : minimumBudget;
        return {
            requestedOutputTokens,
            outputReserveTokens,
            maximumOutputTokens,
            minimumOutputTokens,
            minimumDynamicContextTokens,
            feasible,
            reduced: feasible && outputReserveTokens < requestedOutputTokens,
            budget,
        };
    }

    wouldRetriggerNextTurn(finalContextTokens: number, budget: AgentContextBudget): {
        projectedNextTurnContextTokens: number;
        wouldRetriggerNextTurn: boolean;
    } {
        const projectedNextTurnContextTokens = finalContextTokens + budget.nextTurnReserveTokens;
        return {
            projectedNextTurnContextTokens,
            wouldRetriggerNextTurn: projectedNextTurnContextTokens >= budget.triggerContextBudget,
        };
    }
}
