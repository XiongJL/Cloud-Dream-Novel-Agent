import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Check, ChevronDown, ChevronUp, Loader2, Settings2, Sparkles } from 'lucide-react';
import type { ConfirmResult, CreativeAssetsDraft, CreativeDraftIssue, CreativeSection, DraftSelection, DraftSessionRecord, ValidationResult } from './types';
import PromptInlinePanel from '../AIPromptPreview/PromptInlinePanel';
import type { PromptPreviewData } from '../AIPromptPreview/types';

type Props = {
  novelId: string;
  theme: 'dark' | 'light';
  draft: CreativeAssetsDraft;
  selection: DraftSelection;
  draftSession: DraftSessionRecord | null;
  onDraftChange: (next: CreativeAssetsDraft) => void;
  onSelectionChange: (next: DraftSelection) => void;
  onDraftSessionChange: (next: DraftSessionRecord | null) => void;
  onDraftGenerated?: () => void;
};

type FlowStage = 'idle' | 'generating' | 'generated' | 'validating' | 'persisting' | 'success' | 'error';
type StatusLevel = 'info' | 'success' | 'warning' | 'error';

const EMPTY_DRAFT: CreativeAssetsDraft = {
  plotLines: [],
  plotPoints: [],
  characters: [],
  items: [],
  skills: [],
  worldSettings: [],
  maps: [],
};

const ALL_SECTIONS: CreativeSection[] = ['plotLines', 'plotPoints', 'characters', 'items', 'skills', 'worldSettings', 'maps'];

function normalizeDraft(input: unknown): CreativeAssetsDraft {
  if (!input || typeof input !== 'object') return { ...EMPTY_DRAFT };
  const asDraft = input as CreativeAssetsDraft;
  return {
    plotLines: Array.isArray(asDraft.plotLines) ? asDraft.plotLines : [],
    plotPoints: Array.isArray(asDraft.plotPoints) ? asDraft.plotPoints : [],
    characters: Array.isArray(asDraft.characters) ? asDraft.characters : [],
    items: Array.isArray(asDraft.items) ? asDraft.items : [],
    skills: Array.isArray(asDraft.skills) ? asDraft.skills : [],
    worldSettings: Array.isArray(asDraft.worldSettings) ? asDraft.worldSettings : [],
    maps: Array.isArray(asDraft.maps) ? asDraft.maps : [],
  };
}

function createSelection(draft: CreativeAssetsDraft): DraftSelection {
  return {
    plotLines: (draft.plotLines ?? []).map(() => true),
    plotPoints: (draft.plotPoints ?? []).map(() => true),
    characters: (draft.characters ?? []).map(() => true),
    items: (draft.items ?? []).map(() => true),
    skills: (draft.skills ?? []).map(() => true),
    worldSettings: (draft.worldSettings ?? []).map(() => true),
    maps: (draft.maps ?? []).map(() => true),
  };
}

function sanitizeGeneratedDraft(
  draft: CreativeAssetsDraft,
): { draft: CreativeAssetsDraft; dropped: number } {
  const keepNonEmpty = <T extends Record<string, any>>(items: T[] | undefined, requiredKey: keyof T): T[] => {
    const list = Array.isArray(items) ? items : [];
    return list.filter((item) => typeof item === 'object' && item && String(item[requiredKey] || '').trim());
  };
  const clean: CreativeAssetsDraft = {
    plotLines: keepNonEmpty(draft.plotLines, 'name'),
    plotPoints: keepNonEmpty(draft.plotPoints, 'title'),
    characters: keepNonEmpty(draft.characters, 'name'),
    items: keepNonEmpty(draft.items, 'name'),
    skills: keepNonEmpty(draft.skills, 'name'),
    worldSettings: keepNonEmpty(draft.worldSettings, 'name'),
    maps: keepNonEmpty(draft.maps, 'name'),
  };
  const beforeCount = (draft.plotLines?.length ?? 0)
    + (draft.plotPoints?.length ?? 0)
    + (draft.characters?.length ?? 0)
    + (draft.items?.length ?? 0)
    + (draft.skills?.length ?? 0)
    + (draft.worldSettings?.length ?? 0)
    + (draft.maps?.length ?? 0);
  const afterCount = (clean.plotLines?.length ?? 0)
    + (clean.plotPoints?.length ?? 0)
    + (clean.characters?.length ?? 0)
    + (clean.items?.length ?? 0)
    + (clean.skills?.length ?? 0)
    + (clean.worldSettings?.length ?? 0)
    + (clean.maps?.length ?? 0);
  return { draft: clean, dropped: Math.max(0, beforeCount - afterCount) };
}

function countSelected(selection: boolean[]): number {
  return selection.filter(Boolean).length;
}

export default function AIWorkbenchPanel({
  novelId,
  theme,
  draft,
  selection,
  draftSession,
  onDraftChange,
  onSelectionChange,
  onDraftSessionChange,
  onDraftGenerated,
}: Props) {
  const { t, i18n } = useTranslation();
  const isDark = theme === 'dark';
  const [brief, setBrief] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [flowStage, setFlowStage] = useState<FlowStage>('idle');
  const [statusLevel, setStatusLevel] = useState<StatusLevel>('info');
  const [statusText, setStatusText] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [errors, setErrors] = useState<CreativeDraftIssue[]>([]);
  const [created, setCreated] = useState<Record<string, number> | null>(null);
  const [showIssueDetails, setShowIssueDetails] = useState(false);
  const [promptPreview, setPromptPreview] = useState<PromptPreviewData | null>(null);
  const [promptPreviewLoading, setPromptPreviewLoading] = useState(false);
  const [promptPreviewError, setPromptPreviewError] = useState('');
  const [promptOverride, setPromptOverride] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [generationMode, setGenerationMode] = useState<'auto' | 'manual'>('auto');
  const [targetSections, setTargetSections] = useState<CreativeSection[]>([...ALL_SECTIONS]);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [contextChapterCount, setContextChapterCount] = useState(0);
  const [includeExistingEntities, setIncludeExistingEntities] = useState(true);
  const [filterCompletedPlotLines, setFilterCompletedPlotLines] = useState(true);
  const [estimatedTokens, setEstimatedTokens] = useState(0);

  const selectedCounts = useMemo(
    () => ({
      plotLines: countSelected(selection.plotLines),
      plotPoints: countSelected(selection.plotPoints),
      characters: countSelected(selection.characters),
      items: countSelected(selection.items),
      skills: countSelected(selection.skills),
      worldSettings: countSelected(selection.worldSettings),
      maps: countSelected(selection.maps),
    }),
    [selection],
  );

  const totalSelected = Object.values(selectedCounts).reduce((acc, current) => acc + current, 0);
  const totalDraftCount = useMemo(
    () => (draft.plotLines?.length ?? 0)
      + (draft.plotPoints?.length ?? 0)
      + (draft.characters?.length ?? 0)
      + (draft.items?.length ?? 0)
      + (draft.skills?.length ?? 0)
      + (draft.worldSettings?.length ?? 0)
      + (draft.maps?.length ?? 0),
    [draft],
  );
  const selectedSummaryEntries = useMemo(
    () => [
      { key: 'plotLines', label: t('aiWorkbench.countPlotLines'), value: selectedCounts.plotLines },
      { key: 'plotPoints', label: t('aiWorkbench.countPlotPoints'), value: selectedCounts.plotPoints },
      { key: 'characters', label: t('aiWorkbench.countCharacters'), value: selectedCounts.characters },
      { key: 'items', label: t('aiWorkbench.countItems'), value: selectedCounts.items },
      { key: 'skills', label: t('aiWorkbench.countSkills'), value: selectedCounts.skills },
      { key: 'worldSettings', label: t('aiWorkbench.countWorldSettings'), value: selectedCounts.worldSettings },
      { key: 'maps', label: t('aiWorkbench.countMaps'), value: selectedCounts.maps },
    ],
    [selectedCounts, t],
  );

  const progressMeta = useMemo(() => {
    if (flowStage === 'generating') return { visible: true, value: 33, text: t('aiWorkbench.stageGenerating') };
    if (flowStage === 'validating') return { visible: true, value: 66, text: t('aiWorkbench.stageValidating') };
    if (flowStage === 'persisting') return { visible: true, value: 100, text: t('aiWorkbench.stagePersisting') };
    return { visible: false, value: 0, text: '' };
  }, [flowStage, t]);

  const statusClassName = useMemo(() => {
    if (statusLevel === 'success') {
      return isDark ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100' : 'border-emerald-300 bg-emerald-50 text-emerald-800';
    }
    if (statusLevel === 'warning') {
      return isDark ? 'border-amber-300/30 bg-amber-500/10 text-amber-100' : 'border-amber-300 bg-amber-50 text-amber-800';
    }
    if (statusLevel === 'error') {
      return isDark ? 'border-rose-300/30 bg-rose-500/10 text-rose-100' : 'border-rose-300 bg-rose-50 text-rose-800';
    }
    return isDark ? 'border-white/10 bg-white/5 text-neutral-300' : 'border-gray-200 bg-gray-50 text-gray-700';
  }, [isDark, statusLevel]);

  const setFlowStatus = (stage: FlowStage, level: StatusLevel, text: string) => {
    setFlowStage(stage);
    setStatusLevel(level);
    setStatusText(text);
  };

  const clearIssues = () => {
    setWarnings([]);
    setErrors([]);
    setShowIssueDetails(false);
  };

  const formatIssueCode = (code: string): string => {
    if (code === 'INVALID_INPUT') return t('aiWorkbench.codeInvalidInput');
    if (code === 'CONFLICT') return t('aiWorkbench.codeConflict');
    if (code === 'PERSISTENCE_ERROR') return t('aiWorkbench.codePersistence');
    return t('aiWorkbench.codeUnknown');
  };

  const firstIssueSummary = useMemo(() => {
    if (errors.length === 0) return '';
    const first = errors[0];
    const codeLabel = formatIssueCode(first.code);
    return first.detail ? `${codeLabel}: ${first.detail}` : codeLabel;
  }, [errors]);

  const hasAtomicRollbackHint = useMemo(
    () => errors.some((issue) => issue.code === 'PERSISTENCE_ERROR'),
    [errors],
  );
  const toggleTargetSection = (section: CreativeSection) => {
    setTargetSections((prev) => {
      if (prev.includes(section)) {
        if (prev.length === 1) return prev;
        return prev.filter((item) => item !== section);
      }
      return [...prev, section];
    });
  };

  const handleGenerate = async () => {
    if (!brief.trim()) {
      setFlowStatus('error', 'warning', t('aiWorkbench.needBrief'));
      return;
    }
    if (generationMode === 'manual' && targetSections.length === 0) {
      setFlowStatus('error', 'warning', t('aiWorkbench.needTargetSections'));
      return;
    }

    setIsGenerating(true);
    clearIssues();
    setCreated(null);
    setFlowStatus('generating', 'info', t('aiWorkbench.statusGenerating'));

    try {
      const session = await window.automation.invoke('creative_assets.generate_draft', {
        novelId,
        brief,
        locale: i18n.language,
        overrideUserPrompt: promptDirty && promptOverride.trim() ? promptOverride.trim() : undefined,
        targetSections: generationMode === 'manual' ? targetSections : undefined,
        contextChapterCount,
        includeExistingEntities,
        filterCompletedPlotLines,
      }, 'desktop-ui') as DraftSessionRecord;
      const normalized = normalizeDraft(session?.payload);
      const sanitized = sanitizeGeneratedDraft(normalized);
      onDraftSessionChange({
        ...session,
        payload: sanitized.draft,
        selection: session.selection ?? createSelection(sanitized.draft),
      });
      onDraftChange(sanitized.draft);
      onSelectionChange(session.selection ?? createSelection(sanitized.draft));
      if (sanitized.dropped > 0) {
        setWarnings((prev) => [t('aiWorkbench.filteredInvalidCount', { count: sanitized.dropped }), ...prev]);
      }
      onDraftGenerated?.();
      const generatedCount = (sanitized.draft.plotLines?.length ?? 0)
        + (sanitized.draft.plotPoints?.length ?? 0)
        + (sanitized.draft.characters?.length ?? 0)
        + (sanitized.draft.items?.length ?? 0)
        + (sanitized.draft.skills?.length ?? 0)
        + (sanitized.draft.maps?.length ?? 0);
      setFlowStatus(
        generatedCount > 0 ? 'generated' : 'error',
        generatedCount > 0 ? 'success' : 'warning',
        generatedCount > 0 ? t('aiWorkbench.generatedOpenRightHint') : t('aiWorkbench.emptyGeneratedHint'),
      );
    } catch (error) {
      console.error('[AIWorkbenchPanel] generate failed:', error);
      setFlowStatus('error', 'error', t('aiWorkbench.generateFailed'));
    } finally {
      setIsGenerating(false);
    }
  };

  const refreshPromptPreview = async () => {
    if (!brief.trim()) {
      setPromptPreview(null);
      setPromptPreviewError('');
      setPromptPreviewLoading(false);
      return;
    }
    setPromptPreviewLoading(true);
    setPromptPreviewError('');
    try {
      const preview = await window.ai.previewCreativeAssetsPrompt({
        novelId,
        brief,
        locale: i18n.language,
        targetSections: generationMode === 'manual' ? targetSections : undefined,
        contextChapterCount,
        includeExistingEntities,
        filterCompletedPlotLines,
      });
      setPromptPreview(preview as unknown as PromptPreviewData);
      setPromptOverride((prev) => prev || preview.editableUserPrompt || '');
      const tokens = (preview as any)?.structured?.params?.estimatedContextTokens;
      if (typeof tokens === 'number') setEstimatedTokens(tokens);
    } catch (error) {
      console.error('[AIWorkbenchPanel] prompt preview failed:', error);
      setPromptPreviewError(t('aiWorkbench.promptPreviewFailed'));
    } finally {
      setPromptPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!novelId) return;
    const timer = window.setTimeout(() => void refreshPromptPreview(), 300);
    return () => window.clearTimeout(timer);
  }, [brief, novelId, targetSections, generationMode]);

  useEffect(() => {
    setPromptPreview(null);
    setPromptPreviewError('');
    setPromptOverride('');
  }, [novelId]);

  const handleConfirm = async () => {
    if (isConfirming) return;
    if (totalSelected <= 0) {
      setFlowStatus('error', 'warning', t('aiWorkbench.selectAtLeastOne'));
      return;
    }

    setIsConfirming(true);
    clearIssues();
    setCreated(null);

    try {
      if (!draftSession?.draftSessionId || typeof draftSession.version !== 'number') {
        setFlowStatus('error', 'warning', t('aiWorkbench.selectAtLeastOne'));
        return;
      }

      setFlowStatus('validating', 'info', t('aiWorkbench.statusValidating'));
      const syncedSession = await window.automation.invoke('draft.update', {
        draftSessionId: draftSession.draftSessionId,
        version: draftSession.version,
        payload: draft,
        selection,
      }, 'desktop-ui') as DraftSessionRecord;
      onDraftSessionChange(syncedSession);

      const response = await window.automation.invoke('draft.commit', {
        draftSessionId: syncedSession.draftSessionId,
        version: syncedSession.version,
      }, 'desktop-ui') as {
        session: DraftSessionRecord;
        validation?: ValidationResult;
        confirmResult?: ConfirmResult;
      };

      onDraftSessionChange(response.session);
      const validation = response.validation;
      if (validation) {
        setWarnings(validation.warnings || []);
        setErrors(validation.errors || []);
      }

      if (validation && !validation.ok) {
        setFlowStatus('error', 'error', t('aiWorkbench.validationFailed'));
        return;
      }

      setFlowStatus('persisting', 'info', t('aiWorkbench.statusPersisting'));
      const result = response.confirmResult;
      if (!result) {
        setFlowStatus('error', 'error', t('aiWorkbench.persistFailedAtomic'));
        return;
      }

      setCreated(result.created || null);
      setWarnings(result.warnings || []);
      setErrors(result.errors || []);
      if (!result.success) {
        setFlowStatus('error', 'error', t('aiWorkbench.persistFailedAtomic'));
        return;
      }

      const createdCounts = result.created || {};
      const hasWorldUpdates = (createdCounts.characters || 0) > 0 || (createdCounts.items || 0) > 0 || (createdCounts.skills || 0) > 0 || (createdCounts.worldSettings || 0) > 0;
      const hasMapUpdates = (createdCounts.maps || 0) > 0 || (createdCounts.mapImages || 0) > 0;
      const hasPlotUpdates = (createdCounts.plotLines || 0) > 0 || (createdCounts.plotPoints || 0) > 0;

      window.dispatchEvent(new CustomEvent('creative-assets-persisted', {
        detail: { novelId, created: createdCounts },
      }));
      if (hasWorldUpdates) {
        window.dispatchEvent(new CustomEvent('world-assets-updated', { detail: { novelId } }));
      }
      if (hasMapUpdates) {
        window.dispatchEvent(new CustomEvent('map-assets-updated', { detail: { novelId } }));
      }
      if (hasPlotUpdates) {
        window.dispatchEvent(new Event('plot-update'));
      }

      // 入库成功后清空草稿
      onDraftSessionChange(null);
      onDraftChange({ plotLines: [], plotPoints: [], characters: [], items: [], skills: [], worldSettings: [], maps: [] });
      onSelectionChange({ plotLines: [], plotPoints: [], characters: [], items: [], skills: [], worldSettings: [], maps: [] });

      setFlowStatus('success', 'success', t('aiWorkbench.persistSuccess'));
    } catch (error) {
      console.error('[AIWorkbenchPanel] confirm failed:', error);
      setFlowStatus('error', 'error', t('aiWorkbench.persistException'));
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <div className={clsx('h-full min-h-0 flex flex-col', isDark ? 'bg-[#0F0F13]' : 'bg-gray-50')}>
      <div className={clsx('p-4 border-b flex items-center justify-between', isDark ? 'border-white/5' : 'border-gray-200')}>
        <h2 className={clsx('text-sm font-medium uppercase tracking-wider', isDark ? 'text-neutral-400' : 'text-neutral-500')}>
          {t('aiWorkbench.title')}
        </h2>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">

        <textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          rows={4}
          placeholder={t('aiWorkbench.briefPlaceholder')}
          className={clsx(
            'block w-full min-h-[128px] rounded-xl border px-4 py-3 text-sm leading-7 resize-y outline-none',
            isDark
              ? 'bg-black/20 border-white/10 text-neutral-200 placeholder:text-neutral-500'
              : 'bg-white border-gray-200 text-gray-800 placeholder:text-gray-400',
          )}
        />
        <div className={clsx('rounded-lg border p-2 space-y-2', isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white')}>
          <button
            type="button"
            onClick={() => setShowAdvancedSettings((prev) => !prev)}
            className={clsx('w-full flex items-center justify-between text-xs', isDark ? 'text-neutral-200' : 'text-gray-800')}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Settings2 className="w-3.5 h-3.5 shrink-0" />
              <span>{t('aiWorkbench.advancedSettings')}</span>
              <span
                className={clsx(
                  'shrink-0 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px]',
                  isDark ? 'border-white/10 bg-white/5 text-neutral-300' : 'border-gray-200 bg-gray-50 text-gray-600',
                )}
              >
                {generationMode === 'auto' ? t('aiWorkbench.generationModeAuto') : t('aiWorkbench.generationModeManual')}
              </span>
              {generationMode === 'manual' && (
                <span className={clsx('text-[10px]', isDark ? 'text-neutral-500' : 'text-gray-500')}>
                  {t('aiWorkbench.manualModeSummary', { count: targetSections.length })}
                </span>
              )}
            </span>
            {showAdvancedSettings ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <div className={clsx('text-[11px] leading-5', isDark ? 'text-neutral-400' : 'text-gray-600')}>
            {generationMode === 'auto' ? t('aiWorkbench.autoModeHintShort') : t('aiWorkbench.manualModeHintShort')}
          </div>
          {showAdvancedSettings && (
            <div className="space-y-2">
              <div className={clsx('text-[11px] leading-5', isDark ? 'text-neutral-500' : 'text-gray-500')}>
                {generationMode === 'auto' ? t('aiWorkbench.autoModeHint') : t('aiWorkbench.manualModeHint')}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setGenerationMode('auto')}
                  className={clsx(
                    'px-2 py-1 rounded-md text-[11px] border transition-colors',
                    generationMode === 'auto'
                      ? (isDark ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-100' : 'border-indigo-400 bg-indigo-50 text-indigo-700')
                      : (isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-gray-200 text-gray-600 hover:bg-gray-100'),
                  )}
                >
                  {t('aiWorkbench.generationModeAuto')}
                </button>
                <button
                  type="button"
                  onClick={() => setGenerationMode('manual')}
                  className={clsx(
                    'px-2 py-1 rounded-md text-[11px] border transition-colors',
                    generationMode === 'manual'
                      ? (isDark ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-100' : 'border-indigo-400 bg-indigo-50 text-indigo-700')
                      : (isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-gray-200 text-gray-600 hover:bg-gray-100'),
                  )}
                >
                  {t('aiWorkbench.generationModeManual')}
                </button>
              </div>
              {generationMode === 'manual' && (
                <div className="space-y-1">
                  <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-300' : 'text-gray-700')}>
                    {t('aiWorkbench.targetSections')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ALL_SECTIONS.map((section) => {
                      const active = targetSections.includes(section);
                      return (
                        <button
                          key={section}
                          type="button"
                          onClick={() => toggleTargetSection(section)}
                          className={clsx(
                            'px-2 py-1 rounded-md text-[11px] border transition-colors',
                            active
                              ? (isDark ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-100' : 'border-indigo-400 bg-indigo-50 text-indigo-700')
                              : (isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-gray-200 text-gray-600 hover:bg-gray-100'),
                          )}
                        >
                          {t(`aiWorkbench.sectionToggle.${section}`)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 上下文配置 */}
              <div className="space-y-2 pt-1">
                <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-300' : 'text-gray-700')}>
                  {t('aiWorkbench.contextSettings', '上下文配置')}
                </div>

                {/* 包含已有实体 */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeExistingEntities}
                    onChange={(e) => setIncludeExistingEntities(e.target.checked)}
                    className="rounded"
                  />
                  <span className={clsx('text-[11px]', isDark ? 'text-neutral-300' : 'text-gray-700')}>
                    {t('aiWorkbench.includeExistingEntities', '包含已有角色/物品/情节线')}
                  </span>
                </label>

                {/* 过滤已完成情节 */}
                {includeExistingEntities && (
                  <label className="flex items-center gap-2 cursor-pointer ml-4">
                    <input
                      type="checkbox"
                      checked={filterCompletedPlotLines}
                      onChange={(e) => setFilterCompletedPlotLines(e.target.checked)}
                      className="rounded"
                    />
                    <span className={clsx('text-[11px]', isDark ? 'text-neutral-400' : 'text-gray-600')}>
                      {t('aiWorkbench.filterCompletedPlotLines', '过滤已完成的情节点')}
                    </span>
                  </label>
                )}

                {/* 参考章节数 */}
                <div className="flex items-center gap-2">
                  <span className={clsx('text-[11px]', isDark ? 'text-neutral-300' : 'text-gray-700')}>
                    {t('aiWorkbench.contextChapterCount', '参考章节摘要数')}
                  </span>
                  <select
                    value={contextChapterCount}
                    onChange={(e) => setContextChapterCount(Number(e.target.value))}
                    className={clsx(
                      'text-[11px] rounded px-1.5 py-0.5 border',
                      isDark ? 'bg-white/5 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700',
                    )}
                  >
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <option key={n} value={n}>{n === 0 ? t('aiWorkbench.contextChapterNone', '不参考') : n}</option>
                    ))}
                  </select>
                </div>

                {/* Token 预估 */}
                {estimatedTokens > 0 && (
                  <div className={clsx('text-[10px] flex items-center gap-1', isDark ? 'text-neutral-500' : 'text-gray-400')}>
                    {t('aiWorkbench.estimatedContextTokens', '预估上下文 Token')}: ~{estimatedTokens.toLocaleString()}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => void handleGenerate()}
            disabled={isGenerating || isConfirming}
            className={clsx('px-2.5 py-2 text-xs rounded-lg border inline-flex items-center justify-center gap-1.5', isDark ? 'border-white/20 text-neutral-100 hover:bg-white/10 disabled:opacity-40' : 'border-gray-300 text-gray-800 hover:bg-gray-100 disabled:opacity-40')}
          >
            {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {t('aiWorkbench.generateDraft')}
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={isConfirming || isGenerating || totalSelected <= 0}
            className={clsx('px-2.5 py-2 text-xs rounded-lg border inline-flex items-center justify-center gap-1.5', isDark ? 'border-emerald-300/30 text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40' : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40')}
          >
            {isConfirming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {t('aiWorkbench.confirmPersist')}
          </button>
        </div>

        <PromptInlinePanel
          theme={theme}
          title={t('aiWorkbench.promptPreview')}
          loading={promptPreviewLoading}
          error={promptPreviewError}
          data={promptPreview}
          editablePrompt={promptOverride}
          onEditablePromptChange={(val) => { setPromptOverride(val); setPromptDirty(true); }}
          onRefresh={() => void refreshPromptPreview()}
        />

        <div className={clsx('rounded-lg border px-2.5 py-2 space-y-1', isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white')}>
          <div className="flex items-center justify-between gap-2">
            <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-200' : 'text-gray-800')}>
              {t('aiWorkbench.currentSelectionTitle')}
            </div>
            <div className={clsx('text-[11px]', isDark ? 'text-neutral-400' : 'text-gray-500')}>
              {t('aiWorkbench.totalSelectedShort', { count: totalSelected })}
            </div>
          </div>
          {totalSelected > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {selectedSummaryEntries
                .filter((entry) => entry.value > 0)
                .map((entry) => (
                  <span
                    key={entry.key}
                    className={clsx(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]',
                      isDark ? 'border-white/10 bg-white/5 text-neutral-300' : 'border-gray-200 bg-gray-50 text-gray-700',
                    )}
                  >
                    <span>{entry.label}</span>
                    <span className={clsx('font-medium', isDark ? 'text-neutral-100' : 'text-gray-900')}>{entry.value}</span>
                  </span>
                ))}
            </div>
          ) : (
            <div className={clsx('text-[11px] leading-5', isDark ? 'text-neutral-500' : 'text-gray-500')}>
              {t('aiWorkbench.noSelectionYet')}
            </div>
          )}
        </div>



        {progressMeta.visible && (
          <div className="space-y-1">
            <div className={clsx('text-[11px]', isDark ? 'text-neutral-400' : 'text-gray-600')}>{progressMeta.text}</div>
            <div className={clsx('h-1.5 rounded-full overflow-hidden', isDark ? 'bg-white/10' : 'bg-gray-200')}>
              <div className={clsx('h-full transition-all duration-300 rounded-full', isDark ? 'bg-neutral-300/80' : 'bg-gray-600')} style={{ width: `${progressMeta.value}%` }} />
            </div>
          </div>
        )}

        {statusText && !progressMeta.visible && <div className={clsx('rounded-lg border px-2 py-1.5 text-[11px]', statusClassName)}>{statusText}</div>}

        {created && (
          <div className={clsx('rounded-lg border p-2 space-y-1', flowStage === 'success' ? (isDark ? 'border-emerald-300/30 bg-emerald-500/10' : 'border-emerald-300 bg-emerald-50') : (isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-gray-50'))}>
            <div className={clsx('text-xs font-medium', isDark ? 'text-neutral-200' : 'text-gray-800')}>
              {t('aiWorkbench.persistResultTitle')}
            </div>
            <div className={clsx('grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]', isDark ? 'text-neutral-300' : 'text-gray-700')}>
              <span>{t('aiWorkbench.countPlotLines')}: {created.plotLines || 0}</span>
              <span>{t('aiWorkbench.countPlotPoints')}: {created.plotPoints || 0}</span>
              <span>{t('aiWorkbench.countCharacters')}: {created.characters || 0}</span>
              <span>{t('aiWorkbench.countItems')}: {created.items || 0}</span>
              <span>{t('aiWorkbench.countSkills')}: {created.skills || 0}</span>
              <span>{t('aiWorkbench.countWorldSettings')}: {created.worldSettings || 0}</span>
              <span>{t('aiWorkbench.countMaps')}: {created.maps || 0}</span>
              <span>{t('aiWorkbench.countMapImages')}: {created.mapImages || 0}</span>
            </div>
          </div>
        )}

        {warnings.length > 0 && (
          <div className={clsx('rounded-lg border p-2 space-y-1', isDark ? 'border-amber-300/30 bg-amber-500/10' : 'border-amber-300 bg-amber-50')}>
            <div className={clsx('text-xs font-medium', isDark ? 'text-amber-200' : 'text-amber-800')}>{t('aiWorkbench.warningsTitle')}</div>
            {warnings.map((warning, index) => (
              <div key={`${warning}-${index}`} className={clsx('text-[11px]', isDark ? 'text-amber-100' : 'text-amber-700')}>
                {warning}
              </div>
            ))}
          </div>
        )}

        {errors.length > 0 && (
          <div className={clsx('rounded-lg border p-2 space-y-1.5', isDark ? 'border-rose-300/30 bg-rose-500/10' : 'border-rose-300 bg-rose-50')}>
            <div className={clsx('text-xs font-medium', isDark ? 'text-rose-200' : 'text-rose-800')}>{t('aiWorkbench.errorsTitle')}</div>
            <div className={clsx('text-[11px]', isDark ? 'text-rose-100' : 'text-rose-700')}>
              {t('aiWorkbench.errorSummary', { count: errors.length, first: firstIssueSummary })}
            </div>
            {hasAtomicRollbackHint && (
              <div className={clsx('text-[11px]', isDark ? 'text-rose-100' : 'text-rose-700')}>
                {t('aiWorkbench.atomicRollbackHint')}
              </div>
            )}
            <button
              onClick={() => setShowIssueDetails((prev) => !prev)}
              className={clsx('text-[11px] inline-flex items-center gap-1 rounded border px-2 py-1', isDark ? 'border-rose-300/40 text-rose-100' : 'border-rose-300 text-rose-700')}
            >
              {showIssueDetails ? t('aiWorkbench.hideIssueDetails') : t('aiWorkbench.showIssueDetails')}
              {showIssueDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            {showIssueDetails &&
              errors.map((issue, index) => (
                <div key={`${issue.scope}-${index}`} className={clsx('text-[11px]', isDark ? 'text-rose-100' : 'text-rose-700')}>
                  [{issue.code}] {issue.scope}: {issue.detail}
                </div>
              ))}
          </div>
        )}

        <div className={clsx('shrink-0 rounded-xl border p-3 overflow-hidden', isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white')}>
          <div className={clsx('text-xs font-medium', isDark ? 'text-neutral-100' : 'text-gray-900')}>
            {t('aiWorkbench.workspaceOverviewTitle')}
          </div>

          <div className={clsx('mt-2 text-[11px] leading-5', isDark ? 'text-neutral-400' : 'text-gray-500')}>
            {totalDraftCount > 0 ? t('aiWorkbench.workspaceOverviewWithDraft') : t('aiWorkbench.workspaceOverviewEmpty')}
          </div>

          <div className="mt-3 space-y-2">
            {[1, 2, 3].map((step) => (
              <div
                key={step}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px]',
                  isDark ? 'border-white/10 bg-white/[0.03] text-neutral-300' : 'border-gray-200 bg-gray-50 text-gray-700',
                )}
              >
                <span className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium', isDark ? 'bg-white/10 text-neutral-200' : 'bg-white border border-gray-200 text-gray-700')}>
                  {step}
                </span>
                <span className="min-w-0">{t(`aiWorkbench.workflowStep${step}Title`)}</span>
              </div>
            ))}
          </div>

          <div className={clsx('mt-3 rounded-lg border px-2.5 py-2 text-[11px] leading-5', isDark ? 'border-white/10 bg-white/[0.03] text-neutral-400' : 'border-gray-200 bg-gray-50 text-gray-600')}>
            {t('aiWorkbench.workflowCompactHint')}
          </div>

          <div className={clsx('mt-3 text-[11px] leading-5', isDark ? 'text-neutral-500' : 'text-gray-500')}>
            {t('aiWorkbench.editInRightDockHint')}
          </div>
        </div>
      </div>
    </div>
  );
}
