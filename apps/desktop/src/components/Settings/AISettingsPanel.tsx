import { type ReactNode, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { formatAiError, formatAiErrorFromUnknown } from '../../utils/aiError';
import { Combobox } from '../ui/Combobox';
import { ModelIdCombobox, type ModelIdOption } from './ModelIdCombobox';
import {
    AGENT_CONTEXT_WINDOW_PRESETS,
    AGENT_TEXT_MODEL_CAPABILITY_CATALOG,
    MAXIMUM_AGENT_CONTEXT_WINDOW_TOKENS,
    MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS,
    resolveAgentModelContextCapability,
} from '../../../shared/agentModelContextCapabilities';

type Props = {
    isDark: boolean;
};

const IMAGE_MODELS = [
    'doubao-seedream-5-0-260128',
    'gpt-image-1',
    'imagen-3.0-generate-002',
];

type CreativityLevel = 'safe' | 'balanced' | 'creative';
type StatusTone = 'neutral' | 'error' | 'success';
type CopyTone = 'neutral' | 'error' | 'success';
type ContextWindowTarget = 'http' | 'mcpCli';

type SettingFieldProps = {
    label: string;
    hint?: string;
    children: ReactNode;
    className?: string;
};

function temperatureToCreativityLevel(value: number): CreativityLevel {
    if (value <= 0.45) return 'safe';
    if (value >= 0.85) return 'creative';
    return 'balanced';
}

function creativityLevelToTemperature(level: CreativityLevel): number {
    if (level === 'safe') return 0.3;
    if (level === 'creative') return 1.0;
    return 0.7;
}

function isCustomContextWindow(tokens: number): boolean {
    return tokens >= MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS
        && !AGENT_CONTEXT_WINDOW_PRESETS.some((preset) => preset.tokens === tokens);
}

function formatContextWindow(tokens: number): string {
    if (tokens === 1_000_000 || tokens === 1_048_576) return '1M';
    if (tokens === 258_000) return '258K';
    if (tokens === 256_000 || tokens === 262_144) return '256K';
    if (tokens === 500_000) return '500K';
    if (tokens === 200_000) return '200K';
    if (tokens === 131_072) return '128K';
    if (tokens === 65_536) return '64K';
    if (tokens === 32_768) return '32K';
    if (tokens === 8_192) return '8K';
    return tokens.toLocaleString();
}

function normalizeCustomContextWindowDraft(value: string, fallback: number): number {
    const parsed = Math.floor(Number(value));
    if (!value.trim() || !Number.isFinite(parsed)) return fallback;
    return Math.min(
        MAXIMUM_AGENT_CONTEXT_WINDOW_TOKENS,
        Math.max(MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS, parsed),
    );
}

const TEXT_MODEL_OPTIONS: ModelIdOption[] = AGENT_TEXT_MODEL_CAPABILITY_CATALOG.map((entry) => ({
    modelId: entry.modelId,
    displayName: entry.displayName,
    providerName: entry.providerName,
    contextLabel: formatContextWindow(entry.contextWindowTokens),
}));

function SettingField({ label, hint, children, className }: SettingFieldProps) {
    return (
        <div className={clsx('space-y-2', className)}>
            <div className="space-y-1">
                <label className="text-xs font-medium opacity-80">{label}</label>
                {hint ? <p className="text-[11px] leading-5 opacity-60">{hint}</p> : null}
            </div>
            {children}
        </div>
    );
}

export function AISettingsPanel({ isDark }: Props) {
    const { t } = useTranslation();
    const [settings, setSettings] = useState<AISettings | null>(null);
    const [status, setStatus] = useState('');
    const [statusTone, setStatusTone] = useState<StatusTone>('neutral');
    const [isSaving, setIsSaving] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [testPrompt, setTestPrompt] = useState(t('settings.ai.defaultTestPrompt'));
    const [creativityLevel, setCreativityLevel] = useState<CreativityLevel>('balanced');
    const [mcpSetup, setMcpSetup] = useState<McpCliSetupPayload | null>(null);
    const [copyStatus, setCopyStatus] = useState('');
    const [copyTone, setCopyTone] = useState<CopyTone>('neutral');
    const [customContextWindow, setCustomContextWindow] = useState<Record<ContextWindowTarget, boolean>>({
        http: false,
        mcpCli: false,
    });
    const [customContextWindowDraft, setCustomContextWindowDraft] = useState<Record<ContextWindowTarget, string>>({
        http: '',
        mcpCli: '',
    });
    const [expandedCards, setExpandedCards] = useState({
        httpAdvanced: false,
        summary: false,
        embedding: false,
        proxy: false,
    });

    useEffect(() => {
        let mounted = true;
        window.ai.getSettings()
            .then((res) => {
                if (!mounted) return;
                const merged = {
                    ...res,
                    summary: {
                        summaryMode: res.summary?.summaryMode ?? 'local',
                        summaryTriggerPolicy: res.summary?.summaryTriggerPolicy ?? 'manual',
                        summaryDebounceMs: res.summary?.summaryDebounceMs ?? 30000,
                        summaryMinIntervalMs: res.summary?.summaryMinIntervalMs ?? 180000,
                        summaryMinWordDelta: res.summary?.summaryMinWordDelta ?? 120,
                        summaryFinalizeStableMs: res.summary?.summaryFinalizeStableMs ?? 600000,
                        summaryFinalizeMinWords: res.summary?.summaryFinalizeMinWords ?? 1200,
                        recentChapterRawCount: res.summary?.recentChapterRawCount ?? 2,
                    },
                    embedding: {
                        enabled: res.embedding?.enabled ?? false,
                        baseUrl: res.embedding?.baseUrl ?? '',
                        apiKey: res.embedding?.apiKey ?? '',
                        model: res.embedding?.model ?? 'bge-large-zh-v1.5',
                        dimensions: res.embedding?.dimensions ?? 1024,
                        batchSize: res.embedding?.batchSize ?? 8,
                        timeoutMs: res.embedding?.timeoutMs ?? 60000,
                        fallbackToHash: res.embedding?.fallbackToHash ?? true,
                    },
                    http: {
                        ...res.http,
                        apiMode: res.http?.apiMode ?? 'chat-completions',
                    },
                } as AISettings;
                setSettings(merged);
                setCreativityLevel(temperatureToCreativityLevel(merged.http.temperature));
                setCustomContextWindow({
                    http: isCustomContextWindow(merged.http.contextWindowTokens),
                    mcpCli: isCustomContextWindow(merged.mcpCli.contextWindowTokens),
                });
                setCustomContextWindowDraft({
                    http: isCustomContextWindow(merged.http.contextWindowTokens)
                        ? String(merged.http.contextWindowTokens)
                        : '',
                    mcpCli: isCustomContextWindow(merged.mcpCli.contextWindowTokens)
                        ? String(merged.mcpCli.contextWindowTokens)
                        : '',
                });
            })
            .catch((error) => {
                console.error('[AISettingsPanel] load failed:', error);
                if (!mounted) return;
                setStatusTone('error');
                setStatus(formatAiErrorFromUnknown(error, t, t('settings.ai.status.loadFailed')));
            });

        return () => {
            mounted = false;
        };
    }, [t]);

    useEffect(() => {
        if (!settings) return;
        if (settings.providerType === 'mcp-cli') {
            setExpandedCards((prev) => ({
                ...prev,
                httpAdvanced: false,
                summary: false,
                embedding: false,
                proxy: false,
            }));
        }
    }, [settings?.providerType]);

    useEffect(() => {
        let mounted = true;
        window.ai.getMcpCliSetup()
            .then((result) => {
                if (!mounted) return;
                setMcpSetup(result);
            })
            .catch((error) => {
                console.error('[AISettingsPanel] load mcp setup failed:', error);
                if (!mounted) return;
                setCopyTone('error');
                setCopyStatus(t('settings.ai.mcpCopy.loadFailed'));
            });

        return () => {
            mounted = false;
        };
    }, [t]);

    const updateProviderType = (providerType: AISettings['providerType']) => {
        if (!settings) return;
        setSettings({ ...settings, providerType });
    };

    const updateCustomContextWindowDraft = (target: ContextWindowTarget, value: string) => {
        if (!/^\d*$/.test(value)) return;
        setCustomContextWindowDraft((current) => ({ ...current, [target]: value }));
        if (!value) return;
        const parsed = Math.floor(Number(value));
        if (!Number.isFinite(parsed)
            || parsed < MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS
            || parsed > MAXIMUM_AGENT_CONTEXT_WINDOW_TOKENS) return;
        setSettings((current) => current ? {
            ...current,
            [target]: {
                ...current[target],
                contextWindowTokens: parsed,
            },
        } : current);
    };

    const commitCustomContextWindowDraft = (target: ContextWindowTarget, fallback: number) => {
        const committed = normalizeCustomContextWindowDraft(customContextWindowDraft[target], fallback);
        setCustomContextWindowDraft((current) => ({ ...current, [target]: String(committed) }));
        setSettings((current) => current ? {
            ...current,
            [target]: {
                ...current[target],
                contextWindowTokens: committed,
            },
        } : current);
    };

    const updateCreativityLevel = (level: CreativityLevel) => {
        if (!settings) return;
        setCreativityLevel(level);
        setSettings({
            ...settings,
            http: {
                ...settings.http,
                temperature: creativityLevelToTemperature(level),
            },
        });
    };

    const applyPreset = (preset: 'doubao-ark' | 'openai-compatible' | 'openai-responses' | 'gemini-openai-compatible') => {
        if (!settings) return;
        setCustomContextWindow((current) => ({ ...current, http: false }));
        setCustomContextWindowDraft((current) => ({ ...current, http: '' }));

        if (preset === 'doubao-ark') {
            setCreativityLevel(temperatureToCreativityLevel(0.7));
            setSettings({
                ...settings,
                providerType: 'http',
                http: {
                    ...settings.http,
                    apiMode: 'chat-completions',
                    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
                    model: 'doubao-seed-2-0-pro-260215',
                    contextWindowTokens: 0,
                    imageModel: 'doubao-seedream-5-0-260128',
                    imageSize: '2K',
                    imageOutputFormat: 'png',
                    imageWatermark: false,
                    timeoutMs: 60000,
                    maxTokens: 4096,
                    temperature: 0.7,
                },
            });
            setStatusTone('success');
            setStatus(t('settings.ai.status.presetDoubao'));
            return;
        }

        if (preset === 'openai-compatible') {
            setCreativityLevel(temperatureToCreativityLevel(0.7));
            setSettings({
                ...settings,
                providerType: 'http',
                http: {
                    ...settings.http,
                    apiMode: 'chat-completions',
                    baseUrl: 'https://api.openai.com/v1',
                    model: 'gpt-4.1-mini',
                    contextWindowTokens: 0,
                    imageModel: 'gpt-image-1',
                    imageSize: '1024x1024',
                    imageOutputFormat: 'png',
                    imageWatermark: true,
                    timeoutMs: 60000,
                    maxTokens: 4096,
                    temperature: 0.7,
                },
            });
            setStatusTone('success');
            setStatus(t('settings.ai.status.presetOpenai'));
            return;
        }

        if (preset === 'openai-responses') {
            setCreativityLevel(temperatureToCreativityLevel(0.7));
            setSettings({
                ...settings,
                providerType: 'http',
                http: {
                    ...settings.http,
                    apiMode: 'responses',
                    baseUrl: 'https://api.openai.com/v1',
                    model: 'gpt-4.1-mini',
                    contextWindowTokens: 0,
                    imageModel: 'gpt-image-1',
                    imageSize: '1024x1024',
                    imageOutputFormat: 'png',
                    imageWatermark: true,
                    timeoutMs: 60000,
                    maxTokens: 4096,
                    temperature: 0.7,
                },
            });
            setStatusTone('success');
            setStatus(t('settings.ai.status.presetOpenaiResponses'));
            return;
        }

        setCreativityLevel(temperatureToCreativityLevel(0.7));
        setSettings({
            ...settings,
            providerType: 'http',
            http: {
                ...settings.http,
                apiMode: 'chat-completions',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
                model: 'gemini-2.5-pro',
                contextWindowTokens: 0,
                imageModel: 'imagen-3.0-generate-002',
                imageSize: '1024x1024',
                imageOutputFormat: 'png',
                imageWatermark: true,
                timeoutMs: 60000,
                maxTokens: 4096,
                temperature: 0.7,
            },
        });
        setStatusTone('success');
        setStatus(t('settings.ai.status.presetGemini'));
    };

    const saveSettings = async () => {
        if (!settings) return;
        setIsSaving(true);
        try {
            const saved = await window.ai.updateSettings(settings);
            setSettings(saved);
            setCreativityLevel(temperatureToCreativityLevel(saved.http.temperature));
            setStatusTone('success');
            setStatus(t('settings.ai.status.saved'));
        } catch (error) {
            console.error('[AISettingsPanel] save failed:', error);
            setStatusTone('error');
            setStatus(formatAiErrorFromUnknown(error, t, t('settings.ai.status.saveFailed')));
        } finally {
            setIsSaving(false);
        }
    };

    const syncSettingsBeforeTest = async (): Promise<AISettings | null> => {
        if (!settings) return null;
        const synced = await window.ai.updateSettings(settings);
        setSettings(synced);
        setCreativityLevel(temperatureToCreativityLevel(synced.http.temperature));
        return synced;
    };

    const runCheck = async (kind: 'connection' | 'mcp' | 'proxy') => {
        if (isTesting) return;
        setIsTesting(true);
        try {
            const synced = await syncSettingsBeforeTest();
            if (!synced) return;
            const result = kind === 'connection' ? await window.ai.testConnection() : kind === 'mcp' ? await window.ai.testMcp() : await window.ai.testProxy();
            setStatusTone(result.ok ? 'success' : 'error');
            setStatus(`${t(`settings.ai.check.${kind}`)}: ${result.ok ? t('settings.ai.status.ok') : t('settings.ai.status.failed')}${result.detail ? ` - ${result.detail}` : ''}`);
        } catch (error) {
            console.error('[AISettingsPanel] test failed:', error);
            setStatusTone('error');
            setStatus(`${t(`settings.ai.check.${kind}`)}: ${formatAiErrorFromUnknown(error, t, t('settings.ai.status.error'))}`);
        } finally {
            setIsTesting(false);
        }
    };

    const runGenerateCheck = async () => {
        if (isTesting) return;
        setIsTesting(true);
        try {
            const synced = await syncSettingsBeforeTest();
            if (!synced) return;
            const result = await window.ai.testGenerate(testPrompt);
            if (result.ok) {
                setStatusTone('success');
                setStatus(`${t('settings.ai.check.generate')}: ${t('settings.ai.status.ok')}${result.text ? ` | ${result.text}` : ''}`);
            } else {
                setStatusTone('error');
                setStatus(`${t('settings.ai.check.generate')}: ${t('settings.ai.status.failed')} | ${formatAiError(undefined, t, result.detail || '')}`);
            }
        } catch (error) {
            console.error('[AISettingsPanel] test generate failed:', error);
            setStatusTone('error');
            setStatus(`${t('settings.ai.check.generate')}: ${formatAiErrorFromUnknown(error, t, t('settings.ai.status.error'))}`);
        } finally {
            setIsTesting(false);
        }
    };

    const copyMcpContent = async (kind: 'codex' | 'claude' | 'json') => {
        if (!mcpSetup) return;
        const content = kind === 'codex'
            ? mcpSetup.codexToml
            : kind === 'claude'
                ? mcpSetup.claudeCommand
                : mcpSetup.jsonConfig;
        try {
            await navigator.clipboard.writeText(content);
            setCopyTone('success');
            setCopyStatus(t(`settings.ai.mcpCopy.copyOk.${kind}`));
        } catch (error) {
            console.error('[AISettingsPanel] copy mcp setup failed:', error);
            setCopyTone('error');
            setCopyStatus(t('settings.ai.mcpCopy.copyFailed'));
        }
    };

    if (!settings) {
        return <div className={clsx('text-sm', isDark ? 'text-neutral-400' : 'text-gray-500')}>{t('common.loading')}</div>;
    }

    const httpContextCapability = resolveAgentModelContextCapability('http', settings.http.model);
    const mcpContextCapability = resolveAgentModelContextCapability('mcp-cli', 'mcp-cli');
    const httpContextWindowMode = customContextWindow.http
        ? 'custom'
        : AGENT_CONTEXT_WINDOW_PRESETS.some((preset) => preset.tokens === settings.http.contextWindowTokens)
            ? String(settings.http.contextWindowTokens)
            : 'auto';
    const mcpContextWindowMode = customContextWindow.mcpCli
        ? 'custom'
        : AGENT_CONTEXT_WINDOW_PRESETS.some((preset) => preset.tokens === settings.mcpCli.contextWindowTokens)
            ? String(settings.mcpCli.contextWindowTokens)
            : 'auto';

    const inputClass = clsx('w-full border rounded-xl px-4 py-3 outline-none focus:border-indigo-500 transition-colors text-sm', isDark ? 'bg-[#0a0a0f] border-white/10 text-white' : 'bg-white border-gray-200 text-gray-900');
    const textareaClass = clsx('w-full border rounded-xl px-4 py-3 outline-none focus:border-indigo-500 transition-colors text-sm resize-y', isDark ? 'bg-[#0a0a0f] border-white/10 text-white placeholder:text-neutral-600' : 'bg-white border-gray-200 text-gray-900 placeholder:text-gray-400');
    const statusClass = statusTone === 'error' ? (isDark ? 'border-rose-400/30 bg-rose-400/10 text-rose-300' : 'border-rose-200 bg-rose-50 text-rose-700') : statusTone === 'success' ? (isDark ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700') : (isDark ? 'border-white/10 bg-white/5 text-neutral-300' : 'border-gray-200 bg-gray-50 text-gray-600');
    const copyStatusClass = copyTone === 'error'
        ? (isDark ? 'text-rose-300' : 'text-rose-700')
        : copyTone === 'success'
            ? (isDark ? 'text-emerald-300' : 'text-emerald-700')
            : (isDark ? 'text-neutral-400' : 'text-gray-500');

    return (
        <div className="space-y-8">
            <div className={clsx('rounded-2xl border px-4 py-3 space-y-2', isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-gray-50')}>
                <p className={clsx('text-sm font-medium', isDark ? 'text-white' : 'text-gray-900')}>{t('settings.ai.localOnlyTitle')}</p>
                <p className={clsx('text-xs leading-6', isDark ? 'text-neutral-400' : 'text-gray-600')}>{t('settings.ai.localOnlyDesc')}</p>
                <p className={clsx('text-xs leading-6', isDark ? 'text-neutral-400' : 'text-gray-600')}>{t('settings.ai.presetDesc')}</p>
            </div>

            <div className="space-y-3">
                <label className={clsx('text-sm font-medium uppercase tracking-widest', isDark ? 'text-neutral-400' : 'text-gray-500')}>{t('settings.ai.provider')}</label>
                <div className="flex gap-3">
                    <button onClick={() => updateProviderType('http')} className={clsx('px-4 py-2 rounded-lg border text-sm transition-colors', settings.providerType === 'http' ? 'bg-indigo-600 text-white border-indigo-500' : (isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-gray-300 text-gray-700 hover:bg-gray-50'))}>{t('settings.ai.providerHttp')}</button>
                    <button onClick={() => updateProviderType('mcp-cli')} className={clsx('px-4 py-2 rounded-lg border text-sm transition-colors', settings.providerType === 'mcp-cli' ? 'bg-indigo-600 text-white border-indigo-500' : (isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-gray-300 text-gray-700 hover:bg-gray-50'))}>{t('settings.ai.providerMcp')}</button>
                </div>
                {settings.providerType === 'http' ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                        <button onClick={() => applyPreset('doubao-ark')} className={clsx('px-3 py-1.5 rounded-lg border text-xs transition-colors', isDark ? 'border-amber-400/30 text-amber-300 hover:bg-white/5' : 'border-amber-300 text-amber-700 hover:bg-amber-50')}>{t('settings.ai.preset.doubao')}</button>
                        <button onClick={() => applyPreset('openai-compatible')} className={clsx('px-3 py-1.5 rounded-lg border text-xs transition-colors', isDark ? 'border-indigo-400/30 text-indigo-300 hover:bg-white/5' : 'border-indigo-200 text-indigo-700 hover:bg-indigo-50')}>{t('settings.ai.preset.openai')}</button>
                        <button onClick={() => applyPreset('openai-responses')} className={clsx('px-3 py-1.5 rounded-lg border text-xs transition-colors', isDark ? 'border-purple-400/30 text-purple-300 hover:bg-white/5' : 'border-purple-200 text-purple-700 hover:bg-purple-50')}>{t('settings.ai.preset.openaiResponses')}</button>
                        <button onClick={() => applyPreset('gemini-openai-compatible')} className={clsx('px-3 py-1.5 rounded-lg border text-xs transition-colors', isDark ? 'border-emerald-400/30 text-emerald-300 hover:bg-white/5' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50')}>{t('settings.ai.preset.gemini')}</button>
                    </div>
                ) : null}
            </div>

            {settings.providerType === 'http' ? (
                <div className="space-y-6">
                    {/* HTTP 基础配置区块 */}
                    <div className="space-y-3">
                        <div className={clsx('text-xs font-medium uppercase tracking-widest', isDark ? 'text-neutral-500' : 'text-gray-500')}>{t('settings.ai.section.httpBase')}</div>
                        <div className={clsx('p-4 rounded-xl border', isDark ? 'bg-white/5 border-white/5' : 'bg-gray-50/50 border-gray-100')}>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <SettingField label={t('settings.ai.apiMode.label')} hint={t('settings.ai.apiMode.hint')} className="md:col-span-2">
                                    <select
                                        value={settings.http.apiMode ?? 'chat-completions'}
                                        onChange={(e) => setSettings({ ...settings, http: { ...settings.http, apiMode: e.target.value as 'chat-completions' | 'responses' } })}
                                        className={inputClass}
                                    >
                                        <option value="chat-completions">{t('settings.ai.apiMode.chatCompletions')}</option>
                                        <option value="responses">{t('settings.ai.apiMode.responses')}</option>
                                    </select>
                                </SettingField>
                                <SettingField label={t('settings.ai.baseUrl')} className="md:col-span-2">
                                    <input value={settings.http.baseUrl} onChange={(e) => setSettings({ ...settings, http: { ...settings.http, baseUrl: e.target.value } })} placeholder="https://api.openai.com/v1" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.apiKey')} className="md:col-span-2">
                                    <input type="password" value={settings.http.apiKey} onChange={(e) => setSettings({ ...settings, http: { ...settings.http, apiKey: e.target.value } })} placeholder="sk-..." className={inputClass} />
                                </SettingField>
                            </div>
                        </div>
                    </div>

                    {/* 文本模型配置区块 */}
                    <div className="space-y-3">
                        <div className={clsx('text-xs font-medium uppercase tracking-widest', isDark ? 'text-neutral-500' : 'text-gray-500')}>{t('settings.ai.section.httpText')}</div>
                        <div className={clsx('p-4 rounded-xl border', isDark ? 'bg-white/5 border-white/5' : 'bg-gray-50/50 border-gray-100')}>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <SettingField label={t('settings.ai.model')} hint={t('settings.ai.modelPresetHint')} className="md:col-span-2">
                                    <ModelIdCombobox
                                        options={TEXT_MODEL_OPTIONS}
                                        value={settings.http.model}
                                        onCommit={(modelId) => {
                                            if (modelId === settings.http.model) return;
                                            setCustomContextWindow((current) => ({ ...current, http: false }));
                                            setCustomContextWindowDraft((current) => ({ ...current, http: '' }));
                                            setSettings({ ...settings, http: { ...settings.http, model: modelId, contextWindowTokens: 0 } });
                                        }}
                                        placeholder="gpt-4.1-mini"
                                        noResultsLabel={t('settings.ai.modelNoResults')}
                                        theme={isDark ? 'dark' : 'light'}
                                    />
                                </SettingField>
                                <SettingField label={t('settings.ai.maxTokens')} hint={t('settings.ai.maxTokensHint')}>
                                    <input type="number" value={settings.http.maxTokens} onChange={(e) => setSettings({ ...settings, http: { ...settings.http, maxTokens: Number(e.target.value) || 4096 } })} placeholder="4096" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.contextWindowTokens')} hint={t('settings.ai.contextWindowTokensHint')} className="md:col-span-2">
                                    <select
                                        value={httpContextWindowMode}
                                        onChange={(event) => {
                                            const value = event.target.value;
                                            if (value === 'custom') {
                                                const initialValue = settings.http.contextWindowTokens >= MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS
                                                    ? settings.http.contextWindowTokens
                                                    : httpContextCapability.defaultContextWindowTokens;
                                                setCustomContextWindow((current) => ({ ...current, http: true }));
                                                setCustomContextWindowDraft((current) => ({ ...current, http: String(initialValue) }));
                                                setSettings({
                                                    ...settings,
                                                    http: { ...settings.http, contextWindowTokens: initialValue },
                                                });
                                                return;
                                            }
                                            setCustomContextWindow((current) => ({ ...current, http: false }));
                                            setCustomContextWindowDraft((current) => ({ ...current, http: '' }));
                                            setSettings({
                                                ...settings,
                                                http: {
                                                    ...settings.http,
                                                    contextWindowTokens: value === 'auto' ? 0 : Number(value),
                                                },
                                            });
                                        }}
                                        className={inputClass}
                                    >
                                        <option value="auto">
                                            {t(httpContextCapability.source === 'compatibility-fallback'
                                                ? 'settings.ai.contextWindowAutoFallback'
                                                : 'settings.ai.contextWindowAutoProfile', {
                                                tokens: formatContextWindow(httpContextCapability.defaultContextWindowTokens),
                                            })}
                                        </option>
                                        {AGENT_CONTEXT_WINDOW_PRESETS.map((preset) => (
                                            <option key={preset.id} value={preset.tokens}>
                                                {t(`settings.ai.contextWindowPreset.${preset.id}`)}
                                            </option>
                                        ))}
                                        <option value="custom">{t('settings.ai.contextWindowCustom')}</option>
                                    </select>
                                    {httpContextWindowMode === 'auto' ? (
                                        <p className={clsx('text-xs px-1', isDark ? 'text-neutral-500' : 'text-gray-500')}>
                                            {t(httpContextCapability.source === 'compatibility-fallback'
                                                ? 'settings.ai.contextWindowDetectionFallback'
                                                : 'settings.ai.contextWindowDetectionProfile', {
                                                model: settings.http.model,
                                                tokens: formatContextWindow(httpContextCapability.defaultContextWindowTokens),
                                            })}
                                        </p>
                                    ) : null}
                                    {customContextWindow.http ? (
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            pattern="[0-9]*"
                                            value={customContextWindowDraft.http}
                                            onChange={(event) => updateCustomContextWindowDraft('http', event.target.value)}
                                            onBlur={() => commitCustomContextWindowDraft(
                                                'http',
                                                settings.http.contextWindowTokens >= MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS
                                                    ? settings.http.contextWindowTokens
                                                    : httpContextCapability.defaultContextWindowTokens,
                                            )}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') event.currentTarget.blur();
                                            }}
                                            placeholder="258000"
                                            className={inputClass}
                                        />
                                    ) : null}
                                </SettingField>
                                <SettingField label={t('settings.ai.creativity.label')}>
                                    <select value={creativityLevel} onChange={(e) => updateCreativityLevel(e.target.value as CreativityLevel)} className={inputClass}>
                                        <option value="safe">{t('settings.ai.creativity.safe')}</option>
                                        <option value="balanced">{t('settings.ai.creativity.balanced')}</option>
                                        <option value="creative">{t('settings.ai.creativity.creative')}</option>
                                    </select>
                                    <p className={clsx('text-xs px-1', isDark ? 'text-neutral-500' : 'text-gray-500')}>{creativityLevel === 'safe' ? t('settings.ai.creativity.safeDesc') : creativityLevel === 'creative' ? t('settings.ai.creativity.creativeDesc') : t('settings.ai.creativity.balancedDesc')}</p>
                                </SettingField>
                            </div>
                        </div>
                    </div>

                    {/* 生图模型配置区块 */}
                    <div className="space-y-3">
                        <div className={clsx('text-xs font-medium uppercase tracking-widest', isDark ? 'text-neutral-500' : 'text-gray-500')}>{t('settings.ai.section.httpImage')}</div>
                        <div className={clsx('p-4 rounded-xl border', isDark ? 'bg-white/5 border-white/5' : 'bg-gray-50/50 border-gray-100')}>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <SettingField label={t('settings.ai.imageModel')} hint={t('settings.ai.imageModelPresetHint')} className="md:col-span-2">
                                    <Combobox
                                        options={IMAGE_MODELS.map(m => ({ id: m, name: m }))}
                                        value={settings.http.imageModel}
                                        onChange={(val) => setSettings({ ...settings, http: { ...settings.http, imageModel: val } })}
                                        placeholder="gpt-image-1"
                                        creatable={true}
                                        theme={isDark ? 'dark' : 'light'}
                                        t={t as any}
                                    />
                                </SettingField>
                                <SettingField label={t('settings.ai.imageSize')}>
                                    <select value={settings.http.imageSize} onChange={(e) => setSettings({ ...settings, http: { ...settings.http, imageSize: e.target.value } })} className={inputClass}>
                                        <option value="2K">2K</option>
                                        <option value="1024x1024">1024x1024</option>
                                        <option value="1536x1024">1536x1024</option>
                                        <option value="1024x1536">1024x1536</option>
                                    </select>
                                </SettingField>
                                <SettingField label={t('settings.ai.imageOutputFormat')}>
                                    <select value={settings.http.imageOutputFormat} onChange={(e) => setSettings({ ...settings, http: { ...settings.http, imageOutputFormat: e.target.value as 'png' | 'jpeg' | 'webp' } })} className={inputClass}>
                                        <option value="png">png</option>
                                        <option value="jpeg">jpeg</option>
                                        <option value="webp">webp</option>
                                    </select>
                                </SettingField>
                                <SettingField label={t('settings.ai.imageWatermark.label')}>
                                    <select value={settings.http.imageWatermark ? 'true' : 'false'} onChange={(e) => setSettings({ ...settings, http: { ...settings.http, imageWatermark: e.target.value === 'true' } })} className={inputClass}>
                                        <option value="false">{t('settings.ai.imageWatermark.off')}</option>
                                        <option value="true">{t('settings.ai.imageWatermark.on')}</option>
                                    </select>
                                </SettingField>
                            </div>
                        </div>
                    </div>

                    {/* 其他高级配置区块 */}
                    <div className="space-y-3">
                        <div className={clsx('rounded-xl border', isDark ? 'bg-white/5 border-white/5' : 'bg-gray-50/50 border-gray-100')}>
                            <button
                                type="button"
                                onClick={() => setExpandedCards((prev) => ({ ...prev, httpAdvanced: !prev.httpAdvanced }))}
                                className="w-full flex items-center justify-between px-4 py-3 text-left"
                            >
                                <div className={clsx('text-xs font-medium uppercase tracking-widest', isDark ? 'text-neutral-300' : 'text-gray-700')}>
                                    {t('settings.ai.section.httpAdvanced')}
                                </div>
                                <span className={clsx('text-xs', isDark ? 'text-neutral-400' : 'text-gray-500')}>
                                    {expandedCards.httpAdvanced ? '▾' : '▸'}
                                </span>
                            </button>
                            <div className={clsx('px-4 pb-4', expandedCards.httpAdvanced ? 'block' : 'hidden')}>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <SettingField label={t('settings.ai.timeoutMs')}>
                                        <input type="number" value={settings.http.timeoutMs} onChange={(e) => setSettings({ ...settings, http: { ...settings.http, timeoutMs: Number(e.target.value) || 60000 } })} placeholder="60000" className={inputClass} />
                                    </SettingField>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="md:col-span-2 rounded-xl border border-amber-300/40 bg-amber-50/50 dark:bg-amber-400/5 dark:border-amber-300/20">
                        <button
                            type="button"
                            onClick={() => setExpandedCards((prev) => ({ ...prev, embedding: !prev.embedding }))}
                            className="w-full flex items-center justify-between px-4 py-3 text-left"
                        >
                            <div className={clsx('text-xs font-medium', isDark ? 'text-sky-200' : 'text-sky-800')}>
                                {t('settings.ai.embedding.title')}
                            </div>
                            <span className={clsx('text-xs', isDark ? 'text-sky-200/80' : 'text-sky-700')}>
                                {expandedCards.embedding ? '▾' : '▸'}
                            </span>
                        </button>
                        <div className={clsx('px-4 pb-4 space-y-3', expandedCards.embedding ? 'block' : 'hidden')}>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <SettingField label={t('settings.ai.embedding.enabled')}>
                                    <select value={settings.embedding.enabled ? 'true' : 'false'} onChange={(e) => setSettings({ ...settings, embedding: { ...settings.embedding, enabled: e.target.value === 'true' } })} className={inputClass}>
                                        <option value="false">{t('common.off')}</option>
                                        <option value="true">{t('common.on')}</option>
                                    </select>
                                </SettingField>
                                <SettingField label={t('settings.ai.embedding.fallbackToHash')}>
                                    <select value={settings.embedding.fallbackToHash ? 'true' : 'false'} onChange={(e) => setSettings({ ...settings, embedding: { ...settings.embedding, fallbackToHash: e.target.value === 'true' } })} className={inputClass}>
                                        <option value="true">{t('common.on')}</option>
                                        <option value="false">{t('common.off')}</option>
                                    </select>
                                </SettingField>
                                <SettingField label={t('settings.ai.embedding.baseUrl')} hint={t('settings.ai.embedding.baseUrlHint')} className="md:col-span-2">
                                    <input value={settings.embedding.baseUrl} onChange={(e) => setSettings({ ...settings, embedding: { ...settings.embedding, baseUrl: e.target.value } })} placeholder="http://127.0.0.1:8000" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.embedding.apiKey')} className="md:col-span-2">
                                    <input type="password" value={settings.embedding.apiKey} onChange={(e) => setSettings({ ...settings, embedding: { ...settings.embedding, apiKey: e.target.value } })} placeholder={t('settings.ai.embedding.apiKeyPlaceholder')} className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.embedding.model')}>
                                    <input value={settings.embedding.model} onChange={(e) => setSettings({ ...settings, embedding: { ...settings.embedding, model: e.target.value } })} placeholder="bge-large-zh-v1.5" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.embedding.dimensions')}>
                                    <input type="number" value={settings.embedding.dimensions ?? 1024} onChange={(e) => setSettings({ ...settings, embedding: { ...settings.embedding, dimensions: Number(e.target.value) || undefined } })} placeholder="1024" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.embedding.batchSize')}>
                                    <input type="number" min={1} max={64} value={settings.embedding.batchSize} onChange={(e) => setSettings({ ...settings, embedding: { ...settings.embedding, batchSize: Math.max(1, Math.min(64, Number(e.target.value) || 8)) } })} placeholder="8" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.embedding.timeoutMs')}>
                                    <input type="number" value={settings.embedding.timeoutMs} onChange={(e) => setSettings({ ...settings, embedding: { ...settings.embedding, timeoutMs: Number(e.target.value) || 60000 } })} placeholder="60000" className={inputClass} />
                                </SettingField>
                            </div>
                            <div className={clsx('rounded-lg border px-3 py-2 space-y-1 text-xs leading-5', isDark ? 'border-sky-300/20 bg-sky-400/5 text-sky-100/85' : 'border-sky-200 bg-sky-50 text-sky-900')}>
                                <p>{t('settings.ai.embedding.notice')}</p>
                                <p>{t('settings.ai.embedding.privacyNotice')}</p>
                            </div>
                        </div>
                    </div>

                    <div className="md:col-span-2 rounded-xl border border-amber-300/40 bg-amber-50/50 dark:bg-amber-400/5 dark:border-amber-300/20">
                        <button
                            type="button"
                            onClick={() => setExpandedCards((prev) => ({ ...prev, summary: !prev.summary }))}
                            className="w-full flex items-center justify-between px-4 py-3 text-left"
                        >
                            <div className={clsx('text-xs font-medium', isDark ? 'text-amber-200' : 'text-amber-800')}>
                                {t('settings.ai.summary.title')}
                            </div>
                            <span className={clsx('text-xs', isDark ? 'text-amber-200/80' : 'text-amber-700')}>
                                {expandedCards.summary ? '▾' : '▸'}
                            </span>
                        </button>
                        <div className={clsx('px-4 pb-4 space-y-3', expandedCards.summary ? 'block' : 'hidden')}>
                            <div className="grid grid-cols-1 gap-3">
                                <SettingField label={t('settings.ai.summary.mode')}>
                                    <select value={settings.summary.summaryMode} onChange={(e) => setSettings({ ...settings, summary: { ...settings.summary, summaryMode: e.target.value as 'local' | 'ai' } })} className={inputClass}>
                                        <option value="local">{t('settings.ai.summary.modeLocal')}</option>
                                        <option value="ai">{t('settings.ai.summary.modeAi')}</option>
                                    </select>
                                </SettingField>
                                <SettingField label={t('settings.ai.summary.trigger')}>
                                    <select value={settings.summary.summaryTriggerPolicy} onChange={(e) => setSettings({ ...settings, summary: { ...settings.summary, summaryTriggerPolicy: e.target.value as 'auto' | 'manual' | 'finalized' } })} className={inputClass}>
                                        <option value="manual">{t('settings.ai.summary.trigger.manual')}</option>
                                        <option value="finalized">{t('settings.ai.summary.trigger.finalized')}</option>
                                        <option value="auto">{t('settings.ai.summary.trigger.auto')}</option>
                                    </select>
                                </SettingField>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                <SettingField label={t('settings.ai.summary.debounceMs')}>
                                    <input type="number" value={settings.summary.summaryDebounceMs} onChange={(e) => setSettings({ ...settings, summary: { ...settings.summary, summaryDebounceMs: Number(e.target.value) || 30000 } })} placeholder="30000" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.summary.minIntervalMs')}>
                                    <input type="number" value={settings.summary.summaryMinIntervalMs} onChange={(e) => setSettings({ ...settings, summary: { ...settings.summary, summaryMinIntervalMs: Number(e.target.value) || 180000 } })} placeholder="180000" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.summary.minWordDelta')}>
                                    <input type="number" value={settings.summary.summaryMinWordDelta} onChange={(e) => setSettings({ ...settings, summary: { ...settings.summary, summaryMinWordDelta: Number(e.target.value) || 120 } })} placeholder="120" className={inputClass} />
                                </SettingField>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                <SettingField label={t('settings.ai.summary.finalizeStableMs')}>
                                    <input type="number" value={settings.summary.summaryFinalizeStableMs} onChange={(e) => setSettings({ ...settings, summary: { ...settings.summary, summaryFinalizeStableMs: Number(e.target.value) || 600000 } })} placeholder="600000" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.summary.finalizeMinWords')}>
                                    <input type="number" value={settings.summary.summaryFinalizeMinWords} onChange={(e) => setSettings({ ...settings, summary: { ...settings.summary, summaryFinalizeMinWords: Number(e.target.value) || 1200 } })} placeholder="1200" className={inputClass} />
                                </SettingField>
                            </div>
                            <SettingField label={t('settings.ai.summary.recentRawCount')}>
                                <input type="number" min={0} max={8} value={settings.summary.recentChapterRawCount} onChange={(e) => setSettings({ ...settings, summary: { ...settings.summary, recentChapterRawCount: Math.max(0, Math.min(8, Number(e.target.value) || 2)) } })} placeholder="2" className={inputClass} />
                            </SettingField>
                            <p className={clsx('text-xs', isDark ? 'text-amber-200/80' : 'text-amber-800')}>{t('settings.ai.summary.notice')}</p>
                            <p className={clsx('text-xs', isDark ? 'text-neutral-400' : 'text-gray-500')}>{t('settings.ai.summary.notice2')}</p>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <div className={clsx('text-xs font-medium uppercase tracking-widest', isDark ? 'text-neutral-500' : 'text-gray-500')}>{t('settings.ai.section.mcp')}</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className={clsx('md:col-span-2 rounded-xl border px-4 py-3 space-y-3', isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-gray-50')}>
                            <div className="space-y-1">
                                <p className={clsx('text-sm font-medium', isDark ? 'text-white' : 'text-gray-900')}>{t('settings.ai.mcpCopy.title')}</p>
                                <p className={clsx('text-xs leading-5', isDark ? 'text-neutral-400' : 'text-gray-600')}>{t('settings.ai.mcpCopy.desc')}</p>
                            </div>
                            <SettingField label={t('settings.ai.contextWindowTokens')} hint={t('settings.ai.contextWindowTokensMcpHint')}>
                                <select
                                    value={mcpContextWindowMode}
                                    onChange={(event) => {
                                    const value = event.target.value;
                                    if (value === 'custom') {
                                        const initialValue = settings.mcpCli.contextWindowTokens >= MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS
                                            ? settings.mcpCli.contextWindowTokens
                                            : mcpContextCapability.defaultContextWindowTokens;
                                        setCustomContextWindow((current) => ({ ...current, mcpCli: true }));
                                        setCustomContextWindowDraft((current) => ({ ...current, mcpCli: String(initialValue) }));
                                        setSettings({
                                            ...settings,
                                            mcpCli: { ...settings.mcpCli, contextWindowTokens: initialValue },
                                        });
                                        return;
                                    }
                                    setCustomContextWindow((current) => ({ ...current, mcpCli: false }));
                                    setCustomContextWindowDraft((current) => ({ ...current, mcpCli: '' }));
                                        setSettings({
                                            ...settings,
                                            mcpCli: {
                                                ...settings.mcpCli,
                                                contextWindowTokens: value === 'auto' ? 0 : Number(value),
                                            },
                                        });
                                    }}
                                    className={inputClass}
                                >
                                    <option value="auto">
                                        {t('settings.ai.contextWindowAutoMcp', {
                                            tokens: formatContextWindow(mcpContextCapability.defaultContextWindowTokens),
                                        })}
                                    </option>
                                    {AGENT_CONTEXT_WINDOW_PRESETS.map((preset) => (
                                        <option key={preset.id} value={preset.tokens}>
                                            {t(`settings.ai.contextWindowPreset.${preset.id}`)}
                                        </option>
                                    ))}
                                    <option value="custom">{t('settings.ai.contextWindowCustom')}</option>
                                </select>
                                {customContextWindow.mcpCli ? (
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        value={customContextWindowDraft.mcpCli}
                                        onChange={(event) => updateCustomContextWindowDraft('mcpCli', event.target.value)}
                                        onBlur={() => commitCustomContextWindowDraft(
                                            'mcpCli',
                                            settings.mcpCli.contextWindowTokens >= MINIMUM_AGENT_CONTEXT_WINDOW_TOKENS
                                                ? settings.mcpCli.contextWindowTokens
                                                : mcpContextCapability.defaultContextWindowTokens,
                                        )}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') event.currentTarget.blur();
                                        }}
                                        placeholder="32768"
                                        className={inputClass}
                                    />
                                ) : null}
                            </SettingField>
                            <SettingField label={t('settings.ai.mcpCopy.codexLabel')} hint={t('settings.ai.mcpCopy.codexHint')}>
                                <textarea value={mcpSetup?.codexToml || ''} readOnly placeholder={t('settings.ai.mcpCopy.loading')} rows={5} className={textareaClass} />
                            </SettingField>
                            <div className="flex flex-wrap gap-2">
                                <button onClick={() => copyMcpContent('codex')} disabled={!mcpSetup} className={clsx('px-3 py-1.5 rounded-lg border text-xs transition-colors', !mcpSetup ? (isDark ? 'border-white/5 text-neutral-600 bg-white/5 cursor-not-allowed' : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed') : (isDark ? 'border-indigo-400/30 text-indigo-300 hover:bg-indigo-400/10' : 'border-indigo-200 text-indigo-700 hover:bg-indigo-50'))}>{t('settings.ai.mcpCopy.copyCodex')}</button>
                            </div>
                            <SettingField label={t('settings.ai.mcpCopy.claudeLabel')} hint={t('settings.ai.mcpCopy.claudeHint')}>
                                <input value={mcpSetup?.claudeCommand || ''} readOnly placeholder={t('settings.ai.mcpCopy.loading')} className={inputClass} />
                            </SettingField>
                            <div className="flex flex-wrap gap-2">
                                <button onClick={() => copyMcpContent('claude')} disabled={!mcpSetup} className={clsx('px-3 py-1.5 rounded-lg border text-xs transition-colors', !mcpSetup ? (isDark ? 'border-white/5 text-neutral-600 bg-white/5 cursor-not-allowed' : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed') : (isDark ? 'border-indigo-400/30 text-indigo-300 hover:bg-indigo-400/10' : 'border-indigo-200 text-indigo-700 hover:bg-indigo-50'))}>{t('settings.ai.mcpCopy.copyClaude')}</button>
                            </div>
                            <SettingField label={t('settings.ai.mcpCopy.jsonLabel')} hint={t('settings.ai.mcpCopy.jsonHint')}>
                                <textarea value={mcpSetup?.jsonConfig || ''} readOnly placeholder={t('settings.ai.mcpCopy.loading')} rows={6} className={textareaClass} />
                            </SettingField>
                            <div className="flex flex-wrap gap-2">
                                <button onClick={() => copyMcpContent('json')} disabled={!mcpSetup} className={clsx('px-3 py-1.5 rounded-lg border text-xs transition-colors', !mcpSetup ? (isDark ? 'border-white/5 text-neutral-600 bg-white/5 cursor-not-allowed' : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed') : (isDark ? 'border-indigo-400/30 text-indigo-300 hover:bg-indigo-400/10' : 'border-indigo-200 text-indigo-700 hover:bg-indigo-50'))}>{t('settings.ai.mcpCopy.copyJson')}</button>
                            </div>
                            {!mcpSetup?.launcherExists ? (
                                <p className={clsx('text-xs', isDark ? 'text-amber-300' : 'text-amber-700')}>{t('settings.ai.mcpCopy.pathMissing')}</p>
                            ) : null}
                            {copyStatus ? <p className={clsx('text-xs', copyStatusClass)}>{copyStatus}</p> : null}
                        </div>
                    </div>
                </div>
            )}

            {settings.providerType === 'http' ? (
                <div className="space-y-3">
                    <div className={clsx('rounded-xl border', isDark ? 'bg-white/5 border-white/5' : 'bg-gray-50/50 border-gray-100')}>
                        <button
                            type="button"
                            onClick={() => setExpandedCards((prev) => ({ ...prev, proxy: !prev.proxy }))}
                            className="w-full flex items-center justify-between px-4 py-3 text-left"
                        >
                            <div className={clsx('text-xs font-medium uppercase tracking-widest', isDark ? 'text-neutral-300' : 'text-gray-700')}>
                                {t('settings.ai.section.proxy')}
                            </div>
                            <span className={clsx('text-xs', isDark ? 'text-neutral-400' : 'text-gray-500')}>
                                {expandedCards.proxy ? '▾' : '▸'}
                            </span>
                        </button>
                        <div className={clsx('px-4 pb-4', expandedCards.proxy ? 'block' : 'hidden')}>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <SettingField label={t('settings.ai.proxy.mode')}>
                                    <select value={settings.proxy.mode} onChange={(e) => setSettings({ ...settings, proxy: { ...settings.proxy, mode: e.target.value as AISettings['proxy']['mode'] } })} className={inputClass}>
                                        <option value="system">{t('settings.ai.proxy.system')}</option>
                                        <option value="off">{t('settings.ai.proxy.off')}</option>
                                        <option value="custom">{t('settings.ai.proxy.custom')}</option>
                                    </select>
                                </SettingField>
                                <SettingField label={t('settings.ai.proxy.all')}>
                                    <input value={settings.proxy.allProxy || ''} onChange={(e) => setSettings({ ...settings, proxy: { ...settings.proxy, allProxy: e.target.value } })} placeholder="socks5://127.0.0.1:7890" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.proxy.http')}>
                                    <input value={settings.proxy.httpProxy || ''} onChange={(e) => setSettings({ ...settings, proxy: { ...settings.proxy, httpProxy: e.target.value } })} placeholder="http://127.0.0.1:7890" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.proxy.https')}>
                                    <input value={settings.proxy.httpsProxy || ''} onChange={(e) => setSettings({ ...settings, proxy: { ...settings.proxy, httpsProxy: e.target.value } })} placeholder="http://127.0.0.1:7890" className={inputClass} />
                                </SettingField>
                                <SettingField label={t('settings.ai.proxy.no')} hint={t('settings.ai.proxy.noHint')} className="md:col-span-2">
                                    <input value={settings.proxy.noProxy || ''} onChange={(e) => setSettings({ ...settings, proxy: { ...settings.proxy, noProxy: e.target.value } })} placeholder="localhost,127.0.0.1" className={inputClass} />
                                </SettingField>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
            <div className="space-y-3">
                <div className={clsx('text-xs font-medium uppercase tracking-widest', isDark ? 'text-neutral-500' : 'text-gray-500')}>{t('settings.ai.section.testAndSave')}</div>
                <div className={clsx('p-4 rounded-xl border space-y-4', isDark ? 'bg-white/5 border-white/5' : 'bg-gray-50/50 border-gray-100')}>
                    <div className="flex flex-wrap gap-3">
                        {settings.providerType === 'http' ? (
                            <>
                                <button onClick={() => runCheck('connection')} disabled={isTesting || isSaving} className={clsx("px-4 py-2 rounded-lg border text-sm transition-colors", isTesting ? (isDark ? 'border-white/5 text-neutral-600 bg-white/5 cursor-not-allowed' : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed') : "border-indigo-400/40 hover:bg-indigo-500/10")}>{isTesting ? t('common.loading') : t('settings.ai.testConnection')}</button>
                                <button onClick={() => runCheck('proxy')} disabled={isTesting || isSaving} className={clsx("px-4 py-2 rounded-lg border text-sm transition-colors", isTesting ? (isDark ? 'border-white/5 text-neutral-600 bg-white/5 cursor-not-allowed' : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed') : "border-indigo-400/40 hover:bg-indigo-500/10")}>{isTesting ? t('common.loading') : t('settings.ai.testProxy')}</button>
                                <button onClick={runGenerateCheck} disabled={isTesting || isSaving} className={clsx("px-4 py-2 rounded-lg border text-sm transition-colors", isTesting ? (isDark ? 'border-white/5 text-neutral-600 bg-white/5 cursor-not-allowed' : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed') : "border-emerald-400/40 hover:bg-emerald-500/10")}>{isTesting ? t('common.loading') : t('settings.ai.testGenerate')}</button>
                            </>
                        ) : (
                            <button onClick={() => runCheck('mcp')} disabled={isTesting || isSaving} className={clsx("px-4 py-2 rounded-lg border text-sm transition-colors", isTesting ? (isDark ? 'border-white/5 text-neutral-600 bg-white/5 cursor-not-allowed' : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed') : "border-indigo-400/40 hover:bg-indigo-500/10")}>{isTesting ? t('common.loading') : t('settings.ai.testMcp')}</button>
                        )}
                        <button onClick={saveSettings} disabled={isSaving} className={clsx('px-4 py-2 rounded-lg text-sm text-white', isSaving ? 'bg-indigo-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500')}>
                            {isSaving ? t('common.loading') : t('common.save')}
                        </button>
                    </div>
                    {status ? <div className={clsx('rounded-xl border px-4 py-3 text-xs leading-6', statusClass)}>{status}</div> : null}
                    {settings.providerType === 'http' ? (
                        <SettingField label={t('settings.ai.testPrompt')}>
                            <textarea value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} rows={2} placeholder={t('settings.ai.testPrompt')} className={clsx(textareaClass, 'text-xs')} />
                        </SettingField>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
