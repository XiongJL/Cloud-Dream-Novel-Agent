export type AgentModelProviderType = 'http' | 'mcp-cli';

export type AgentModelCapabilitySource =
    | 'model-profile'
    | 'compatibility-fallback';

export interface AgentModelContextCapability {
    profileId: string;
    providerType: AgentModelProviderType;
    modelPattern: RegExp;
    defaultContextWindowTokens: number;
    providerReserveTokens: number;
    fixedProviderWrapperTokens: number;
    nextTurnMessageWrapperTokens: number;
    defaultUserTurnReserveTokens: number;
    supportsConservativeUtf8UpperBound: boolean;
    source: AgentModelCapabilitySource;
}

export const MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS = 8_192;
export const MAXIMUM_AGENT_CONTEXT_WINDOW_TOKENS = 2_000_000;

export const AGENT_CONTEXT_WINDOW_PRESETS = [
    { id: 'basic', tokens: 8_192 },
    { id: 'standard', tokens: 32_768 },
    { id: 'long', tokens: 65_536 },
    { id: 'novel', tokens: 131_072 },
    { id: 'extended', tokens: 258_000 },
    { id: 'million', tokens: 1_000_000 },
] as const;

export interface AgentTextModelCapabilityCatalogEntry {
    providerId: string;
    providerName: string;
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
}

// Curated model metadata is exact and intentionally separate from compatibility fallback.
// Values shared by multiple gateways use the lowest known window for a safe automatic default.
export const AGENT_TEXT_MODEL_CAPABILITY_CATALOG: readonly AgentTextModelCapabilityCatalogEntry[] = [
    { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5.4', displayName: 'GPT-5.4', contextWindowTokens: 258_000 },
    { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5.6', displayName: 'GPT-5.6', contextWindowTokens: 258_000 },
    { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4.1', displayName: 'GPT-4.1', contextWindowTokens: 258_000 },
    { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', contextWindowTokens: 258_000 },
    { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o-mini', displayName: 'GPT-4o Mini', contextWindowTokens: 128_000 },
    { providerId: 'volcengine', providerName: 'Volcengine', modelId: 'ark-code-latest', displayName: 'Ark Code Latest', contextWindowTokens: 256_000 },
    { providerId: 'volcengine', providerName: 'Volcengine', modelId: 'doubao-seed-2-1-pro-260628', displayName: 'Doubao Seed 2.1 Pro', contextWindowTokens: 262_144 },
    { providerId: 'volcengine', providerName: 'Volcengine', modelId: 'doubao-seed-2-0-pro-260215', displayName: 'Doubao Seed 2.0 Pro', contextWindowTokens: 131_072 },
    { providerId: 'volcengine', providerName: 'Volcengine', modelId: 'doubao-1-5-pro-32k-250115', displayName: 'Doubao 1.5 Pro', contextWindowTokens: 32_768 },
    { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', contextWindowTokens: 1_000_000 },
    { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', contextWindowTokens: 1_000_000 },
    { providerId: 'zhipu', providerName: 'Zhipu', modelId: 'glm-5.2', displayName: 'GLM-5.2', contextWindowTokens: 200_000 },
    { providerId: 'zhipu', providerName: 'Zhipu', modelId: 'glm-5.1', displayName: 'GLM-5.1', contextWindowTokens: 200_000 },
    { providerId: 'baidu', providerName: 'Baidu Qianfan', modelId: 'qianfan-code-latest', displayName: 'Qianfan Code Latest', contextWindowTokens: 131_072 },
    { providerId: 'alibaba', providerName: 'Alibaba Bailian', modelId: 'qwen3-coder-plus', displayName: 'Qwen3 Coder Plus', contextWindowTokens: 1_048_576 },
    { providerId: 'moonshot', providerName: 'Moonshot', modelId: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', contextWindowTokens: 262_144 },
    { providerId: 'moonshot', providerName: 'Moonshot', modelId: 'kimi-k3', displayName: 'Kimi K3', contextWindowTokens: 1_048_576 },
    { providerId: 'moonshot', providerName: 'Moonshot', modelId: 'kimi-for-coding', displayName: 'Kimi For Coding', contextWindowTokens: 262_144 },
    { providerId: 'stepfun', providerName: 'StepFun', modelId: 'step-3.7-flash', displayName: 'Step 3.7 Flash', contextWindowTokens: 262_144 },
    { providerId: 'stepfun', providerName: 'StepFun', modelId: 'step-3.5-flash-2603', displayName: 'Step 3.5 Flash 2603', contextWindowTokens: 262_144 },
    { providerId: 'stepfun', providerName: 'StepFun', modelId: 'step-3.5-flash', displayName: 'Step 3.5 Flash', contextWindowTokens: 262_144 },
    { providerId: 'meituan', providerName: 'LongCat', modelId: 'longcat-2.0', displayName: 'LongCat 2.0', contextWindowTokens: 1_048_576 },
    { providerId: 'minimax', providerName: 'MiniMax', modelId: 'minimax-m3', displayName: 'MiniMax M3', contextWindowTokens: 1_000_000 },
    { providerId: 'minimax', providerName: 'MiniMax', modelId: 'minimax-m2.7', displayName: 'MiniMax M2.7', contextWindowTokens: 200_000 },
    { providerId: 'antgroup', providerName: 'BaiLing', modelId: 'ling-2.6-1t', displayName: 'Ling 2.6 1T', contextWindowTokens: 262_144 },
    { providerId: 'xiaomi', providerName: 'Xiaomi', modelId: 'mimo-v2.5-pro', displayName: 'MiMo V2.5 Pro', contextWindowTokens: 1_048_576 },
    { providerId: 'xiaomi', providerName: 'Xiaomi', modelId: 'mimo-v2.5', displayName: 'MiMo V2.5', contextWindowTokens: 1_048_576 },
    { providerId: 'xai', providerName: 'xAI', modelId: 'grok-4.5', displayName: 'Grok 4.5', contextWindowTokens: 500_000 },
    { providerId: 'nvidia', providerName: 'NVIDIA NIM', modelId: 'moonshotai/kimi-k2.5', displayName: 'Kimi K2.5', contextWindowTokens: 262_144 },
    { providerId: 'google', providerName: 'Google', modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextWindowTokens: 262_144 },
    { providerId: 'google', providerName: 'Google', modelId: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', contextWindowTokens: 262_144 },
] as const;

function normalizeModelId(model: string): string {
    return String(model || '').trim().replace(/^models\//i, '').toLowerCase();
}

function catalogEntryForModel(model: string): AgentTextModelCapabilityCatalogEntry | undefined {
    const normalized = normalizeModelId(model);
    if (!normalized) return undefined;
    const tail = normalized.split('/').pop() || normalized;
    return AGENT_TEXT_MODEL_CAPABILITY_CATALOG.find((entry) => {
        const entryId = normalizeModelId(entry.modelId);
        const entryTail = entryId.split('/').pop() || entryId;
        return entryId === normalized || entryTail === tail;
    });
}

const HTTP_MODEL_PROFILES: AgentModelContextCapability[] = [
    {
        profileId: 'openai-gpt-5.4-5.6-258k:utf8-upper-v2',
        providerType: 'http',
        modelPattern: /(?:^|[/:_-])gpt-(?:5\.4|5\.6)(?:$|[/:_-])/i,
        defaultContextWindowTokens: 258_000,
        providerReserveTokens: 256,
        fixedProviderWrapperTokens: 32,
        nextTurnMessageWrapperTokens: 16,
        defaultUserTurnReserveTokens: 1024,
        supportsConservativeUtf8UpperBound: true,
        source: 'model-profile',
    },
    {
        profileId: 'openai-gpt-4.1:utf8-upper-v2',
        providerType: 'http',
        modelPattern: /(?:^|[/:_-])gpt-4\.1(?:$|[/:_-])/i,
        defaultContextWindowTokens: 258_000,
        providerReserveTokens: 256,
        fixedProviderWrapperTokens: 32,
        nextTurnMessageWrapperTokens: 16,
        defaultUserTurnReserveTokens: 1024,
        supportsConservativeUtf8UpperBound: true,
        source: 'model-profile',
    },
    {
        profileId: 'openai-gpt-4o-o-series:utf8-upper-v2',
        providerType: 'http',
        modelPattern: /(?:gpt-4o|(?:^|[/:_-])o[134](?:$|[/:_-]))/i,
        defaultContextWindowTokens: 128_000,
        providerReserveTokens: 256,
        fixedProviderWrapperTokens: 32,
        nextTurnMessageWrapperTokens: 16,
        defaultUserTurnReserveTokens: 1024,
        supportsConservativeUtf8UpperBound: true,
        source: 'model-profile',
    },
    {
        profileId: 'anthropic-claude:utf8-upper-v2',
        providerType: 'http',
        modelPattern: /claude/i,
        defaultContextWindowTokens: 180_000,
        providerReserveTokens: 512,
        fixedProviderWrapperTokens: 64,
        nextTurnMessageWrapperTokens: 24,
        defaultUserTurnReserveTokens: 1024,
        supportsConservativeUtf8UpperBound: true,
        source: 'model-profile',
    },
    {
        profileId: 'google-gemini:utf8-upper-v2',
        providerType: 'http',
        modelPattern: /gemini/i,
        defaultContextWindowTokens: 262_144,
        providerReserveTokens: 512,
        fixedProviderWrapperTokens: 64,
        nextTurnMessageWrapperTokens: 24,
        defaultUserTurnReserveTokens: 1024,
        supportsConservativeUtf8UpperBound: true,
        source: 'model-profile',
    },
    {
        profileId: 'openai-gpt-compatible-128k:utf8-upper-v2',
        providerType: 'http',
        modelPattern: /(?:^|[/:_-])gpt-[a-z0-9]/i,
        defaultContextWindowTokens: 131_072,
        providerReserveTokens: 512,
        fixedProviderWrapperTokens: 64,
        nextTurnMessageWrapperTokens: 24,
        defaultUserTurnReserveTokens: 1024,
        supportsConservativeUtf8UpperBound: true,
        source: 'compatibility-fallback',
    },
];

const GENERIC_HTTP_CAPABILITY: AgentModelContextCapability = {
    profileId: 'http-generic-conservative-128k:utf8-upper-v2',
    providerType: 'http',
    modelPattern: /.*/,
    defaultContextWindowTokens: 131_072,
    providerReserveTokens: 1024,
    fixedProviderWrapperTokens: 128,
    nextTurnMessageWrapperTokens: 32,
    defaultUserTurnReserveTokens: 1024,
    supportsConservativeUtf8UpperBound: true,
    source: 'compatibility-fallback',
};

const MCP_CLI_CAPABILITY: AgentModelContextCapability = {
    profileId: 'mcp-cli-prompt:utf8-upper-v2',
    providerType: 'mcp-cli',
    modelPattern: /.*/,
    defaultContextWindowTokens: 32_768,
    providerReserveTokens: 256,
    fixedProviderWrapperTokens: 32,
    nextTurnMessageWrapperTokens: 16,
    defaultUserTurnReserveTokens: 768,
    supportsConservativeUtf8UpperBound: true,
    source: 'model-profile',
};

export function resolveAgentModelContextCapability(
    providerType: AgentModelProviderType,
    model: string,
): AgentModelContextCapability {
    if (providerType === 'mcp-cli') return MCP_CLI_CAPABILITY;
    const normalizedModel = String(model || '').trim();
    const explicitProfile = HTTP_MODEL_PROFILES.find((profile) => profile.modelPattern.test(normalizedModel));
    if (explicitProfile) return explicitProfile;
    const catalogEntry = catalogEntryForModel(normalizedModel);
    if (!catalogEntry) return GENERIC_HTTP_CAPABILITY;
    return {
        ...GENERIC_HTTP_CAPABILITY,
        profileId: `${catalogEntry.providerId}:${normalizeModelId(catalogEntry.modelId)}:utf8-upper-v2`,
        modelPattern: new RegExp(`^${catalogEntry.modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        defaultContextWindowTokens: catalogEntry.contextWindowTokens,
        source: 'model-profile',
    };
}
