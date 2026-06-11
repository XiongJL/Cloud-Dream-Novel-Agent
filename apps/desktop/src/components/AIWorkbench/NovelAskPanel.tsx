import type { TFunction } from 'i18next';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Copy, Loader2, MessageSquareText, RefreshCcw, Search } from 'lucide-react';
import PromptInlinePanel from '../AIPromptPreview/PromptInlinePanel';
import type { PromptPreviewData } from '../AIPromptPreview/types';

type Props = {
  novelId: string;
  theme: 'dark' | 'light';
  currentChapterId?: string | null;
  currentContent?: string;
};

function toPromptPreviewData(result: RagAskResult | null, t: TFunction): PromptPreviewData | null {
  if (!result) return null;
  return {
    structured: {
      goal: t('aiWorkbench.rag.previewGoal'),
      contextRefs: (result.usedContext || []).map((item) => t(`aiWorkbench.rag.contextRef.${item}`, { defaultValue: item })),
      params: {
        intent: result.intent,
        confidence: result.confidence,
        evidenceCount: result.evidence.length,
      },
      constraints: [
        t('aiWorkbench.rag.constraintEvidenceOnly'),
        t('aiWorkbench.rag.constraintCiteEvidence'),
        t('aiWorkbench.rag.constraintInsufficientEvidence'),
      ],
    },
    rawPrompt: result.rawPrompt || '',
    editableUserPrompt: result.editableUserPrompt || '',
    usedContext: result.usedContext,
    warnings: result.warnings,
  };
}

export default function NovelAskPanel({ novelId, theme, currentChapterId, currentContent }: Props) {
  const { t, i18n } = useTranslation();
  const isDark = theme === 'dark';
  const [question, setQuestion] = useState('');
  const [includeCurrentContext, setIncludeCurrentContext] = useState(false);
  const [showEvidence, setShowEvidence] = useState(true);
  const [isAsking, setIsAsking] = useState(false);
  const [isRebuildingIndex, setIsRebuildingIndex] = useState(false);
  const [result, setResult] = useState<RagAskResult | null>(null);
  const [error, setError] = useState('');
  const [indexStatus, setIndexStatus] = useState<{ level: 'success' | 'warning'; message: string } | null>(null);
  const [promptPreview, setPromptPreview] = useState<RagAskResult | null>(null);
  const [promptPreviewLoading, setPromptPreviewLoading] = useState(false);
  const [promptPreviewError, setPromptPreviewError] = useState('');
  const [promptOverride, setPromptOverride] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');

  const previewData = useMemo(() => toPromptPreviewData(promptPreview, t), [promptPreview, t]);

  const buildPayload = (): RagAskPayload => ({
    novelId,
    question: question.trim(),
    chapterId: includeCurrentContext ? (currentChapterId || undefined) : undefined,
    locale: i18n.language,
    maxEvidenceItems: 12,
    currentContent: includeCurrentContext ? currentContent : undefined,
    overrideUserPrompt: promptDirty && promptOverride.trim() ? promptOverride.trim() : undefined,
  });

  const handleAsk = async () => {
    if (!question.trim()) {
      setError(t('aiWorkbench.rag.needQuestion'));
      return;
    }
    setIsAsking(true);
    setError('');
    setIndexStatus(null);
    setCopyStatus('');
    try {
      const response = await window.ai.askNovel(buildPayload());
      setResult(response);
      if (!promptOverride && response.editableUserPrompt) {
        setPromptOverride(response.editableUserPrompt);
      }
    } catch (err) {
      console.error('[NovelAskPanel] ask failed:', err);
      setError(t('aiWorkbench.rag.askFailed'));
    } finally {
      setIsAsking(false);
    }
  };

  const refreshPromptPreview = async () => {
    if (!question.trim()) {
      setPromptPreview(null);
      setPromptPreviewError('');
      return;
    }
    setPromptPreviewLoading(true);
    setPromptPreviewError('');
    setIndexStatus(null);
    try {
      const preview = await window.ai.previewNovelAskPrompt(buildPayload());
      setPromptPreview(preview);
      setPromptOverride((prev) => prev || preview.editableUserPrompt || '');
    } catch (err) {
      console.error('[NovelAskPanel] prompt preview failed:', err);
      setPromptPreviewError(t('aiWorkbench.rag.promptPreviewFailed'));
    } finally {
      setPromptPreviewLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!result?.answer) return;
    await navigator.clipboard.writeText(result.answer);
    setCopyStatus(t('aiWorkbench.rag.copied'));
    window.setTimeout(() => setCopyStatus(''), 1600);
  };

  const handleRebuildIndex = async () => {
    setIsRebuildingIndex(true);
    setError('');
    setIndexStatus(null);
    try {
      const response = await window.ai.executeAction('rag.rebuild_index', { novelId }) as RagRebuildIndexResult;
      if (response.fallbackUsed) {
        setIndexStatus({
          level: 'warning',
          message: t('aiWorkbench.rag.rebuildIndexFallback', {
            chunks: response.chunks,
            model: response.model,
            error: response.fallbackError || t('aiWorkbench.rag.unknownEmbeddingError'),
          }),
        });
      } else {
        setIndexStatus({
          level: 'success',
          message: t('aiWorkbench.rag.rebuildIndexSuccess', {
            chunks: response.chunks,
            model: response.model,
            dimensions: response.dimensions,
          }),
        });
      }
    } catch (err) {
      console.error('[NovelAskPanel] rebuild RAG index failed:', err);
      setError(t('aiWorkbench.rag.rebuildIndexFailed'));
    } finally {
      setIsRebuildingIndex(false);
    }
  };

  const confidenceClass = useMemo(() => {
    if (result?.confidence === 'high') {
      return isDark ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100' : 'border-emerald-300 bg-emerald-50 text-emerald-800';
    }
    if (result?.confidence === 'medium') {
      return isDark ? 'border-amber-300/30 bg-amber-500/10 text-amber-100' : 'border-amber-300 bg-amber-50 text-amber-800';
    }
    return isDark ? 'border-rose-300/30 bg-rose-500/10 text-rose-100' : 'border-rose-300 bg-rose-50 text-rose-800';
  }, [isDark, result?.confidence]);

  return (
    <div className={clsx('h-full min-h-0 flex flex-col', isDark ? 'bg-[#0F0F13]' : 'bg-gray-50')}>
      <div className={clsx('p-4 border-b flex items-center justify-between', isDark ? 'border-white/5' : 'border-gray-200')}>
        <h2 className={clsx('text-sm font-medium uppercase tracking-wider', isDark ? 'text-neutral-400' : 'text-neutral-500')}>
          {t('aiWorkbench.rag.title')}
        </h2>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={4}
          placeholder={t('aiWorkbench.rag.questionPlaceholder')}
          className={clsx(
            'block w-full min-h-[128px] rounded-xl border px-4 py-3 text-sm leading-7 resize-y outline-none',
            isDark
              ? 'bg-black/20 border-white/10 text-neutral-200 placeholder:text-neutral-500'
              : 'bg-white border-gray-200 text-gray-800 placeholder:text-gray-400',
          )}
        />

        <div className={clsx('rounded-lg border p-2 space-y-2', isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white')}>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeCurrentContext}
              onChange={(event) => setIncludeCurrentContext(event.target.checked)}
              className="rounded"
            />
            <span className={clsx('text-[11px]', isDark ? 'text-neutral-300' : 'text-gray-700')}>
              {t('aiWorkbench.rag.includeCurrentContext')}
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showEvidence}
              onChange={(event) => setShowEvidence(event.target.checked)}
              className="rounded"
            />
            <span className={clsx('text-[11px]', isDark ? 'text-neutral-300' : 'text-gray-700')}>
              {t('aiWorkbench.rag.showEvidence')}
            </span>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void handleAsk()}
            disabled={isAsking}
            className={clsx('px-2.5 py-2 text-xs rounded-lg border inline-flex items-center justify-center gap-1.5', isDark ? 'border-white/20 text-neutral-100 hover:bg-white/10 disabled:opacity-40' : 'border-gray-300 text-gray-800 hover:bg-gray-100 disabled:opacity-40')}
          >
            {isAsking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquareText className="w-3.5 h-3.5" />}
            {t('aiWorkbench.rag.ask')}
          </button>
          <button
            type="button"
            onClick={() => void refreshPromptPreview()}
            disabled={promptPreviewLoading || !question.trim()}
            className={clsx('px-2.5 py-2 text-xs rounded-lg border inline-flex items-center justify-center gap-1.5', isDark ? 'border-white/20 text-neutral-100 hover:bg-white/10 disabled:opacity-40' : 'border-gray-300 text-gray-800 hover:bg-gray-100 disabled:opacity-40')}
          >
            {promptPreviewLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            {t('aiWorkbench.rag.previewPrompt')}
          </button>
        </div>

        <button
          type="button"
          onClick={() => void handleRebuildIndex()}
          disabled={isRebuildingIndex}
          className={clsx('w-full px-2.5 py-2 text-xs rounded-lg border inline-flex items-center justify-center gap-1.5', isDark ? 'border-white/20 text-neutral-100 hover:bg-white/10 disabled:opacity-40' : 'border-gray-300 text-gray-800 hover:bg-gray-100 disabled:opacity-40')}
        >
          {isRebuildingIndex ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
          {t('aiWorkbench.rag.rebuildIndex')}
        </button>

        <PromptInlinePanel
          theme={theme}
          title={t('aiWorkbench.rag.promptPreview')}
          loading={promptPreviewLoading}
          error={promptPreviewError}
          data={previewData}
          editablePrompt={promptOverride}
          onEditablePromptChange={(value) => { setPromptOverride(value); setPromptDirty(true); }}
          onRefresh={() => void refreshPromptPreview()}
        />

        {error && (
          <div className={clsx('rounded-lg border px-2 py-1.5 text-[11px]', isDark ? 'border-rose-300/30 bg-rose-500/10 text-rose-100' : 'border-rose-300 bg-rose-50 text-rose-800')}>
            {error}
          </div>
        )}

        {indexStatus && (
          <div className={clsx(
            'rounded-lg border px-2 py-1.5 text-[11px]',
            indexStatus.level === 'warning'
              ? (isDark ? 'border-amber-300/30 bg-amber-500/10 text-amber-100' : 'border-amber-300 bg-amber-50 text-amber-800')
              : (isDark ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100' : 'border-emerald-300 bg-emerald-50 text-emerald-800'),
          )}>
            {indexStatus.message}
          </div>
        )}

        {result && (
          <div className={clsx('rounded-xl border p-3 space-y-3', isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white')}>
            <div className="flex items-center justify-between gap-2">
              <div className={clsx('text-xs font-medium', isDark ? 'text-neutral-100' : 'text-gray-900')}>
                {t('aiWorkbench.rag.answerTitle')}
              </div>
              <span className={clsx('rounded-full border px-2 py-0.5 text-[10px]', confidenceClass)}>
                {t(`aiWorkbench.rag.confidence.${result.confidence}`)}
              </span>
            </div>
            <div className={clsx('whitespace-pre-wrap text-sm leading-6', isDark ? 'text-neutral-200' : 'text-gray-800')}>
              {result.answer || t('aiWorkbench.rag.noAnswer')}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleCopy()}
                className={clsx('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]', isDark ? 'border-white/10 text-neutral-200 hover:bg-white/5' : 'border-gray-200 text-gray-700 hover:bg-gray-50')}
              >
                <Copy className="w-3.5 h-3.5" />
                {t('aiWorkbench.rag.copyAnswer')}
              </button>
              {copyStatus && <span className={clsx('text-[11px]', isDark ? 'text-neutral-400' : 'text-gray-500')}>{copyStatus}</span>}
            </div>
          </div>
        )}

        {result?.warnings?.length ? (
          <div className={clsx('rounded-lg border p-2 space-y-1', isDark ? 'border-amber-300/30 bg-amber-500/10' : 'border-amber-300 bg-amber-50')}>
            <div className={clsx('text-xs font-medium', isDark ? 'text-amber-200' : 'text-amber-800')}>{t('aiWorkbench.warningsTitle')}</div>
            {result.warnings.map((warning, index) => (
              <div key={`${warning}-${index}`} className={clsx('text-[11px]', isDark ? 'text-amber-100' : 'text-amber-700')}>
                {warning}
              </div>
            ))}
          </div>
        ) : null}

        {showEvidence && result?.evidence?.length ? (
          <div className={clsx('rounded-xl border p-3 space-y-2', isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white')}>
            <div className={clsx('text-xs font-medium', isDark ? 'text-neutral-100' : 'text-gray-900')}>
              {t('aiWorkbench.rag.evidenceTitle', { count: result.evidence.length })}
            </div>
            <div className="space-y-2">
              {result.evidence.map((item) => (
                <div key={item.id} className={clsx('rounded-lg border px-2.5 py-2', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-gray-200 bg-gray-50')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-200' : 'text-gray-800')}>
                      [{item.id}] {item.title}
                    </span>
                    <span className={clsx('shrink-0 text-[10px]', isDark ? 'text-neutral-500' : 'text-gray-500')}>
                      {t(`aiWorkbench.rag.sourceType.${item.sourceType}`)}
                    </span>
                  </div>
                  <div className={clsx('mt-1 text-[11px] leading-5', isDark ? 'text-neutral-400' : 'text-gray-600')}>
                    {item.excerpt}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
