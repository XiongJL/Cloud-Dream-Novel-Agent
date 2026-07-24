import React from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Loader2, Sparkles } from 'lucide-react';
import { BaseModal } from '../ui/BaseModal';
import PromptInlinePanel from '../AIPromptPreview/PromptInlinePanel';
import { Idea } from '../../types';
import type { PromptPreviewData } from '../AIPromptPreview/types';

export interface ContinueWritingConfig {
    ideaIds: string[];
    targetLength: string;
    creativityPreset: 'safe' | 'balanced' | 'creative';
    contextChapterCount: number;
    style: string;
    tone: string;
    pace: string;
    userIntent: string;
    currentLocation: string;
}

export interface ContinueWritingModalProps {
    isOpen: boolean;
    onClose: () => void;
    theme: 'light' | 'dark';
    
    // Status & Logic Context
    blocked: boolean;
    onNavigateToOutline: () => void;
    onNavigateToAiWorkbench: () => void;
    
    // Config State
    config: ContinueWritingConfig;
    setConfig: React.Dispatch<React.SetStateAction<ContinueWritingConfig>>;
    normalizeTargetLength: (val: string) => number;
    
    // Data List
    ideas: Idea[];
    
    // Actions
    isContinuing: boolean;
    onStartContinueWriting: () => void;
    
    // Prompt Panel
    promptLoading: boolean;
    promptError: string;
    promptPreview: PromptPreviewData | null;
    promptOverride: string;
    promptDefault: string;
    onPromptOverrideChange: (value: string) => void;
    onRefreshPromptPreview: () => void;
}

export const ContinueWritingModal: React.FC<ContinueWritingModalProps> = ({
    isOpen,
    onClose,
    theme,
    blocked,
    onNavigateToOutline,
    onNavigateToAiWorkbench,
    config,
    setConfig,
    normalizeTargetLength,
    ideas,
    isContinuing,
    onStartContinueWriting,
    promptLoading,
    promptError,
    promptPreview,
    promptOverride,
    promptDefault,
    onPromptOverrideChange,
    onRefreshPromptPreview,
}) => {
    const { t } = useTranslation();

    return (
        <BaseModal isOpen={isOpen} onClose={onClose} theme={theme} maxWidth="max-w-2xl" className="p-0">
                <div className={clsx(
                    "px-5 py-4 border-b flex items-center justify-between",
                    theme === 'dark' ? 'border-white/10' : 'border-gray-100'
                )}>
                    <div>
                        <h3 className={clsx("text-sm font-semibold", theme === 'dark' ? 'text-neutral-100' : 'text-gray-900')}>
                            {t('editor.continueModalTitle')}
                        </h3>
                        <p className={clsx("text-xs mt-1", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                            {t('editor.continueModalDesc')}
                        </p>
                    </div>
                </div>

                <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
                    {blocked && (
                        <div className={clsx(
                            "rounded-xl border px-3 py-3",
                            theme === 'dark' ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800'
                        )}>
                            <div className="text-sm font-medium">
                                {t('editor.continueBlocked')}
                            </div>
                            <div className="text-xs mt-1 opacity-90">
                                {t('editor.continueBlockedHint')}
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                                <button
                                    onClick={onNavigateToOutline}
                                    className={clsx("text-xs px-2 py-1 rounded border", theme === 'dark' ? 'border-amber-300/40' : 'border-amber-300')}
                                >
                                    {t('editor.gotoOutline')}
                                </button>
                                <button
                                    onClick={onClose}
                                    className={clsx("text-xs px-2 py-1 rounded border", theme === 'dark' ? 'border-amber-300/40' : 'border-amber-300')}
                                >
                                    {t('editor.writeManually')}
                                </button>
                                <button
                                    onClick={onNavigateToAiWorkbench}
                                    className={clsx("text-xs px-2 py-1 rounded border", theme === 'dark' ? 'border-amber-300/40' : 'border-amber-300')}
                                >
                                    {t('editor.gotoAiOutlineGenerator')}
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <label className="text-xs">
                            <div className={clsx("mb-1", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                                {t('editor.continueLength')}
                            </div>
                            <input
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={config.targetLength}
                                onChange={(e) => {
                                    const nextValue = e.target.value.replace(/[^\d]/g, '');
                                    setConfig((prev) => ({ ...prev, targetLength: nextValue }));
                                }}
                                onBlur={() => {
                                    setConfig((prev) => ({
                                        ...prev,
                                        targetLength: String(normalizeTargetLength(prev.targetLength)),
                                    }));
                                }}
                                placeholder="500"
                                className={clsx("w-full rounded-lg border px-2 py-2", theme === 'dark' ? 'bg-transparent border-white/10 text-neutral-200' : 'border-gray-200')}
                            />
                        </label>
                        <label className="text-xs">
                            <div className={clsx("mb-1", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                                {t('editor.continueCreativity')}
                            </div>
                            <select
                                value={config.creativityPreset}
                                onChange={(e) => setConfig((prev) => ({ ...prev, creativityPreset: e.target.value as 'safe' | 'balanced' | 'creative' }))}
                                className={clsx("w-full rounded-lg border px-2 py-2", theme === 'dark' ? 'bg-transparent border-white/10 text-neutral-200' : 'border-gray-200')}
                            >
                                <option value="safe">{t('editor.creativeSafe')}</option>
                                <option value="balanced">{t('editor.creativeBalanced')}</option>
                                <option value="creative">{t('editor.creativeCreative')}</option>
                            </select>
                        </label>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <label className="text-xs">
                            <div className={clsx("mb-1", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                                {t('editor.continueStyle')}
                            </div>
                            <select
                                value={config.style}
                                onChange={(e) => setConfig((prev) => ({ ...prev, style: e.target.value }))}
                                className={clsx("w-full rounded-lg border px-2 py-2", theme === 'dark' ? 'bg-transparent border-white/10 text-neutral-200' : 'border-gray-200')}
                            >
                                <option value="default">{t('editor.styleDefault')}</option>
                                <option value="tight">{t('editor.styleTight')}</option>
                                <option value="lyrical">{t('editor.styleLyrical')}</option>
                                <option value="cinematic">{t('editor.styleCinematic')}</option>
                            </select>
                        </label>
                        <label className="text-xs">
                            <div className={clsx("mb-1", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                                {t('editor.continueTone')}
                            </div>
                            <select
                                value={config.tone}
                                onChange={(e) => setConfig((prev) => ({ ...prev, tone: e.target.value }))}
                                className={clsx("w-full rounded-lg border px-2 py-2", theme === 'dark' ? 'bg-transparent border-white/10 text-neutral-200' : 'border-gray-200')}
                            >
                                <option value="balanced">{t('editor.toneBalanced')}</option>
                                <option value="calm">{t('editor.toneCalm')}</option>
                                <option value="tense">{t('editor.toneTense')}</option>
                                <option value="warm">{t('editor.toneWarm')}</option>
                            </select>
                        </label>
                    </div>

                    <label className="text-xs block">
                        <div className={clsx("mb-1", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                            {t('editor.contextChapterCount')}
                        </div>
                        <input
                            type="number"
                            min={1}
                            max={20}
                            value={config.contextChapterCount}
                            onChange={(e) => setConfig((prev) => ({ ...prev, contextChapterCount: Math.max(1, Math.min(20, Number(e.target.value) || 8)) }))}
                            className={clsx("w-full rounded-lg border px-2 py-2", theme === 'dark' ? 'bg-transparent border-white/10 text-neutral-200' : 'border-gray-200')}
                        />
                    </label>

                    <div>
                        <div className={clsx("text-xs mb-2", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                            {t('editor.selectIdeas')}
                        </div>
                        <div className={clsx(
                            "max-h-44 overflow-y-auto rounded-lg border p-2 space-y-1",
                            theme === 'dark' ? 'border-white/10' : 'border-gray-200'
                        )}>
                            {ideas.length === 0 && (
                                <div className={clsx("text-xs", theme === 'dark' ? 'text-neutral-500' : 'text-gray-400')}>
                                    {t('editor.noIdeas')}
                                </div>
                            )}
                            {ideas.map((idea) => (
                                <label key={idea.id} className={clsx(
                                    "flex items-start gap-2 rounded px-2 py-1 text-xs",
                                    theme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-gray-50'
                                )}>
                                    <input
                                        type="checkbox"
                                        checked={config.ideaIds.includes(idea.id)}
                                        onChange={(e) => {
                                            setConfig((prev) => ({
                                                ...prev,
                                                ideaIds: e.target.checked
                                                    ? [...prev.ideaIds, idea.id]
                                                    : prev.ideaIds.filter((id) => id !== idea.id),
                                            }));
                                        }}
                                    />
                                    <span className={clsx("line-clamp-2", theme === 'dark' ? 'text-neutral-300' : 'text-gray-700')}>
                                        {idea.content}
                                    </span>
                                </label>
                            ))}
                        </div>
                    </div>
                    <label className="text-xs block">
                        <div className={clsx("mb-1", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                            {t('editor.continueUserIntentLabel')}
                        </div>
                        <textarea
                            value={config.userIntent}
                            onChange={(e) => setConfig((prev) => ({ ...prev, userIntent: e.target.value }))}
                            onBlur={onRefreshPromptPreview}
                            rows={3}
                            placeholder={t('editor.continueUserIntentPlaceholder')}
                            className={clsx(
                                "w-full rounded-lg border px-2 py-2 text-xs resize-y",
                                theme === 'dark' ? 'bg-transparent border-white/10 text-neutral-200 placeholder:text-neutral-500' : 'border-gray-200 text-gray-700 placeholder:text-gray-400'
                            )}
                        />
                        <div className={clsx("mt-1", theme === 'dark' ? 'text-neutral-500' : 'text-gray-400')}>
                            {t('editor.continueUserIntentHint')}
                        </div>
                    </label>
                    <label className="text-xs block">
                        <div className={clsx("mb-1", theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                            {t('editor.continueCurrentLocationLabel')}
                        </div>
                        <input
                            value={config.currentLocation}
                            onChange={(e) => setConfig((prev) => ({ ...prev, currentLocation: e.target.value }))}
                            placeholder={t('editor.continueCurrentLocationPlaceholder')}
                            className={clsx(
                                "w-full rounded-lg border px-2 py-2 text-xs",
                                theme === 'dark' ? 'bg-transparent border-white/10 text-neutral-200 placeholder:text-neutral-500' : 'border-gray-200 text-gray-700 placeholder:text-gray-400'
                            )}
                        />
                        <div className={clsx("mt-1", theme === 'dark' ? 'text-neutral-500' : 'text-gray-400')}>
                            {t('editor.continueCurrentLocationHint')}
                        </div>
                    </label>
                    <PromptInlinePanel
                        theme={theme}
                        title={t('editor.promptPreview')}
                        loading={promptLoading}
                        error={promptError}
                        data={promptPreview}
                        editablePrompt={promptOverride}
                        baselinePrompt={promptDefault}
                        onEditablePromptChange={onPromptOverrideChange}
                        onRefresh={onRefreshPromptPreview}
                    />
                </div>

                <div className={clsx(
                    "px-5 py-3 border-t flex items-center justify-end gap-2",
                    theme === 'dark' ? 'border-white/10' : 'border-gray-100'
                )}>
                    <button
                        onClick={onClose}
                        className={clsx("text-xs px-3 py-1.5 rounded border", theme === 'dark' ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        onClick={onStartContinueWriting}
                        disabled={isContinuing}
                        className={clsx(
                            "text-xs px-4 py-1.5 rounded-lg inline-flex items-center justify-center gap-1.5 font-medium transition-colors shadow-md shadow-indigo-500/20 border border-transparent bg-indigo-600 hover:bg-indigo-500 text-white",
                            "disabled:opacity-40 disabled:cursor-not-allowed"
                        )}
                    >
                        {isContinuing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                        {t('editor.startContinue')}
                    </button>
                </div>
        </BaseModal>
    );
};
