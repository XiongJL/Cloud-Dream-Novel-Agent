import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { PromptPreviewData } from '../../../components/AIPromptPreview/types';
import type { ContinueWritingConfig } from '../../../components/Editor/ContinueWritingModal';
import type { Chapter } from '../../../types';
import { formatAiErrorFromUnknown } from '../../../utils/aiError';
import { DEFAULT_CHAPTER_LENGTH, DEFAULT_CONTINUATION_LENGTH, normalizeWritingLength, novelChapterLength } from '../../../../shared/writingPolicy';

type UseContinueWritingParams = {
    novelId: string;
    novelFormatting?: string;
    currentChapter: Chapter | null;
    plotLines: Array<{ points?: unknown[] }>;
    contentRef: MutableRefObject<string>;
    language: string;
    t: (...args: any[]) => any;
    extractPlainTextFromLexical: (content: string) => string;
    stripRepeatedPrefixFromGeneration: (existing: string, generated: string) => string;
};

export function useContinueWriting({
    novelId,
    novelFormatting,
    currentChapter,
    plotLines,
    contentRef,
    language,
    t,
    extractPlainTextFromLexical,
    stripRepeatedPrefixFromGeneration,
}: UseContinueWritingParams) {
    const [isContinueModalOpen, setIsContinueModalOpen] = useState(false);
    const previousModalOpen = useRef(false);
    const [isContinuing, setIsContinuing] = useState(false);
    const [continueStatus, setContinueStatus] = useState('');
    const [isContinuePreviewOpen, setIsContinuePreviewOpen] = useState(false);
    const [continuePreviewText, setContinuePreviewText] = useState('');
    const [continuePreviewBaseTail, setContinuePreviewBaseTail] = useState('');
    const [continuePromptPreview, setContinuePromptPreview] = useState<PromptPreviewData | null>(null);
    const [continuePromptLoading, setContinuePromptLoading] = useState(false);
    const [continuePromptError, setContinuePromptError] = useState('');
    const [continuePromptOverride, setContinuePromptOverride] = useState('');
    const [continuePromptDefault, setContinuePromptDefault] = useState('');
    const [continuePromptDirty, setContinuePromptDirty] = useState(false);
    const [continueConfig, setContinueConfig] = useState<ContinueWritingConfig>({
        ideaIds: [],
        targetLength: '500',
        creativityPreset: 'balanced',
        contextChapterCount: 8,
        style: 'default',
        tone: 'balanced',
        pace: 'medium',
        userIntent: '',
        currentLocation: '',
    });

    const continuePromptTimerRef = useRef<number | null>(null);

    const normalizeContinueTargetLength = useCallback((value: string) => {
        return normalizeWritingLength(value, DEFAULT_CONTINUATION_LENGTH);
    }, []);

    useEffect(() => {
        if (isContinueModalOpen && !previousModalOpen.current) {
            const empty = !extractPlainTextFromLexical(contentRef.current || '').trim();
            setContinueConfig(current => ({ ...current, targetLength: String(empty
                ? novelChapterLength(novelFormatting) ?? DEFAULT_CHAPTER_LENGTH : DEFAULT_CONTINUATION_LENGTH) }));
        }
        previousModalOpen.current = isContinueModalOpen;
    }, [isContinueModalOpen, novelFormatting, contentRef, extractPlainTextFromLexical]);

    const resetContinuePromptPreview = useCallback(() => {
        setContinuePromptPreview(null);
        setContinuePromptDefault('');
        setContinuePromptDirty(false);
        setContinuePromptOverride('');
        setContinuePromptError('');
        setContinuePromptLoading(false);
    }, []);

    const closeContinueModal = useCallback(() => {
        setIsContinueModalOpen(false);
        resetContinuePromptPreview();
        setContinueConfig((prev) => ({ ...prev, userIntent: '', currentLocation: '' }));
    }, [resetContinuePromptPreview]);

    const refreshContinuePromptPreview = useCallback(async () => {
        if (!currentChapter || !isContinueModalOpen) return;
        const currentText = extractPlainTextFromLexical(contentRef.current || '');
        const mode: 'new_chapter' | 'continue_chapter' = currentText.trim().length === 0 ? 'new_chapter' : 'continue_chapter';
        const temperature = continueConfig.creativityPreset === 'safe'
            ? 0.4
            : continueConfig.creativityPreset === 'creative'
                ? 0.95
                : 0.7;

        setContinuePromptLoading(true);
        setContinuePromptError('');
        try {
            const preview = await window.ai.previewContinuePrompt({
                locale: language,
                mode,
                novelId,
                chapterId: currentChapter.id,
                currentContent: contentRef.current || '',
                ideaIds: continueConfig.ideaIds,
                contextChapterCount: continueConfig.contextChapterCount,
                targetLength: normalizeContinueTargetLength(continueConfig.targetLength),
                style: continueConfig.style,
                tone: continueConfig.tone,
                pace: continueConfig.pace,
                temperature,
                userIntent: continueConfig.userIntent,
                currentLocation: continueConfig.currentLocation,
            });
            setContinuePromptPreview(preview as unknown as PromptPreviewData);
            const nextDefault = preview.editableUserPrompt || '';
            setContinuePromptDefault(nextDefault);
            if (!continuePromptDirty) {
                setContinuePromptOverride(nextDefault);
            }
        } catch (error) {
            setContinuePromptError(formatAiErrorFromUnknown(error, t, t('editor.promptPreviewFailed')));
        } finally {
            setContinuePromptLoading(false);
        }
    }, [contentRef, continueConfig, continuePromptDirty, currentChapter, extractPlainTextFromLexical, isContinueModalOpen, language, normalizeContinueTargetLength, novelId, t]);

    useEffect(() => {
        if (!isContinueModalOpen || !currentChapter) return;
        if (continuePromptTimerRef.current !== null) {
            window.clearTimeout(continuePromptTimerRef.current);
        }
        continuePromptTimerRef.current = window.setTimeout(() => {
            void refreshContinuePromptPreview();
        }, 800);

        return () => {
            if (continuePromptTimerRef.current !== null) {
                window.clearTimeout(continuePromptTimerRef.current);
                continuePromptTimerRef.current = null;
            }
        };
    }, [
        continueConfig.ideaIds,
        continueConfig.targetLength,
        continueConfig.creativityPreset,
        continueConfig.contextChapterCount,
        continueConfig.style,
        continueConfig.tone,
        continueConfig.pace,
        currentChapter,
        isContinueModalOpen,
        refreshContinuePromptPreview,
    ]);

    useEffect(() => {
        return () => {
            if (continuePromptTimerRef.current !== null) {
                window.clearTimeout(continuePromptTimerRef.current);
                continuePromptTimerRef.current = null;
            }
        };
    }, []);

    const handleStartContinueWriting = useCallback(async () => {
        if (!currentChapter || isContinuing) return;
        const currentText = extractPlainTextFromLexical(contentRef.current || '');
        const hasOutline = plotLines.some((line) => (line.points?.length || 0) > 0) || plotLines.length > 0;
        const isFirstChapter = currentChapter.order === 1;
        const isBlocked = isFirstChapter && !hasOutline && currentText.length < 120;

        if (isBlocked) {
            setContinueStatus(t('editor.continueBlocked'));
            return;
        }

        const targetLength = normalizeContinueTargetLength(continueConfig.targetLength);
        const temperature = continueConfig.creativityPreset === 'safe'
            ? 0.4
            : continueConfig.creativityPreset === 'creative'
                ? 0.95
                : 0.7;

        closeContinueModal();
        setIsContinuing(true);
        setContinueStatus(t('editor.continueGenerating'));

        try {
            const mode: 'new_chapter' | 'continue_chapter' = currentText.trim().length === 0 ? 'new_chapter' : 'continue_chapter';
            const result = await window.ai.executeAction('chapter.generate', {
                locale: language,
                mode,
                novelId,
                chapterId: currentChapter.id,
                currentContent: contentRef.current || '',
                ideaIds: continueConfig.ideaIds,
                contextChapterCount: continueConfig.contextChapterCount,
                targetLength,
                style: continueConfig.style,
                tone: continueConfig.tone,
                pace: continueConfig.pace,
                temperature,
                userIntent: continueConfig.userIntent,
                currentLocation: continueConfig.currentLocation,
                overrideUserPrompt: continuePromptOverride.trim() || undefined,
            }) as {
                text: string;
                warnings?: string[];
                consistency: { ok: boolean; issues: string[] };
            };

            const dedupedText = stripRepeatedPrefixFromGeneration(currentText, result.text || '');
            if (!dedupedText.trim()) {
                setContinueStatus(t('editor.continueNoNewText'));
                return;
            }

            setContinuePreviewText(dedupedText);
            setContinuePreviewBaseTail(currentText.slice(-600));
            setIsContinuePreviewOpen(true);

            if (result.consistency?.ok === false && result.consistency.issues?.length) {
                setContinueStatus(`${t('editor.continueDoneWithIssues')}: ${result.consistency.issues[0]}`);
            } else {
                setContinueStatus(t('editor.continueNeedConfirm'));
            }
        } catch (error) {
            console.error('[Editor] continue writing failed:', error);
            setContinueStatus(formatAiErrorFromUnknown(error, t, t('editor.continueFailed')));
        } finally {
            setIsContinuing(false);
            window.setTimeout(() => setContinueStatus(''), 6000);
        }
    }, [
        closeContinueModal,
        contentRef,
        continueConfig,
        continuePromptOverride,
        currentChapter,
        extractPlainTextFromLexical,
        isContinuing,
        language,
        normalizeContinueTargetLength,
        novelId,
        plotLines,
        stripRepeatedPrefixFromGeneration,
        t,
    ]);

    return {
        isContinueModalOpen,
        setIsContinueModalOpen,
        isContinuing,
        continueStatus,
        setContinueStatus,
        isContinuePreviewOpen,
        setIsContinuePreviewOpen,
        continuePreviewText,
        setContinuePreviewText,
        continuePreviewBaseTail,
        setContinuePreviewBaseTail,
        continuePromptPreview,
        continuePromptLoading,
        continuePromptError,
        continuePromptOverride,
        setContinuePromptOverride,
        continuePromptDefault,
        continuePromptDirty,
        setContinuePromptDirty,
        continueConfig,
        setContinueConfig,
        normalizeContinueTargetLength,
        closeContinueModal,
        refreshContinuePromptPreview,
        handleStartContinueWriting,
    };
}
