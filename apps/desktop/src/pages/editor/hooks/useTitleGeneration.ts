import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { formatAiErrorFromUnknown } from '../../../utils/aiError';
import type { Chapter } from '../../../types';
import type { TitleGenerationStage } from '../types';

type UseTitleGenerationParams = {
    novelId: string;
    currentChapter: Chapter | null;
    contentRef: MutableRefObject<string>;
    setTitle: (value: string) => void;
    t: (...args: any[]) => any;
};

type TitleCandidate = { title: string; styleTag: string };

export function useTitleGeneration({
    novelId,
    currentChapter,
    contentRef,
    setTitle,
    t,
}: UseTitleGenerationParams) {
    const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
    const [titleGenStage, setTitleGenStage] = useState<TitleGenerationStage | null>(null);
    const [titleGenStatus, setTitleGenStatus] = useState('');
    const [titleCandidates, setTitleCandidates] = useState<TitleCandidate[]>([]);

    const titleGenTimersRef = useRef<number[]>([]);
    const titleGenStatusTimerRef = useRef<number | null>(null);
    const titleGenActiveRef = useRef(false);

    const clearTitleGenTimers = useCallback(() => {
        titleGenTimersRef.current.forEach((id) => window.clearTimeout(id));
        titleGenTimersRef.current = [];
    }, []);

    const clearTitleGenStatusTimer = useCallback(() => {
        if (titleGenStatusTimerRef.current !== null) {
            window.clearTimeout(titleGenStatusTimerRef.current);
            titleGenStatusTimerRef.current = null;
        }
    }, []);

    const handleGenerateTitle = useCallback(async () => {
        if (!currentChapter) return;
        const chapterContent = contentRef.current || '';
        if (!chapterContent.trim()) return;

        setIsGeneratingTitle(true);
        clearTitleGenTimers();
        clearTitleGenStatusTimer();
        titleGenActiveRef.current = true;
        setTitleGenStage('requesting');
        setTitleGenStatus(t('editor.titleGenRequesting', '正在请求模型...'));
        titleGenTimersRef.current.push(window.setTimeout(() => {
            if (!titleGenActiveRef.current) return;
            setTitleGenStage('generating');
            setTitleGenStatus(t('editor.titleGenGenerating', '正在生成标题候选...'));
        }, 500));
        titleGenTimersRef.current.push(window.setTimeout(() => {
            if (!titleGenActiveRef.current) return;
            setTitleGenStage('parsing');
            setTitleGenStatus(t('editor.titleGenParsing', '正在整理结果...'));
        }, 1400));
        try {
            const result = await window.ai.generateTitle({
                novelId,
                chapterId: currentChapter.id,
                content: chapterContent,
                count: 6,
            });

            setTitleGenStage('parsing');
            setTitleGenStatus(t('editor.titleGenParsing', '正在整理结果...'));
            const candidates = (result.candidates || [])
                .map((item) => ({
                    title: String(item?.title || '').trim(),
                    styleTag: String(item?.styleTag || '').trim() || t('editor.aiTitleStyle.stable', '稳健推进'),
                }))
                .filter((item) => Boolean(item.title))
                .slice(0, 10);

            setTitleCandidates(candidates);

            if (candidates[0]) setTitle(candidates[0].title);
            setTitleGenStatus(t('editor.titleGenDone', '标题候选已更新'));
            clearTitleGenStatusTimer();
            titleGenStatusTimerRef.current = window.setTimeout(() => setTitleGenStatus(''), 2600);
        } catch (error) {
            console.error('[Editor] AI title generation failed:', error);
            setTitleGenStatus(formatAiErrorFromUnknown(error, t, t('editor.titleGenFailed', '标题生成失败，请稍后重试')));
            clearTitleGenStatusTimer();
            titleGenStatusTimerRef.current = window.setTimeout(() => setTitleGenStatus(''), 4200);
        } finally {
            titleGenActiveRef.current = false;
            clearTitleGenTimers();
            setTitleGenStage(null);
            setIsGeneratingTitle(false);
        }
    }, [clearTitleGenStatusTimer, clearTitleGenTimers, contentRef, currentChapter, novelId, setTitle, t]);

    useEffect(() => {
        return () => {
            clearTitleGenTimers();
            clearTitleGenStatusTimer();
            titleGenActiveRef.current = false;
        };
    }, [clearTitleGenStatusTimer, clearTitleGenTimers]);

    return {
        isGeneratingTitle,
        titleGenStage,
        titleGenStatus,
        titleCandidates,
        setTitleCandidates,
        handleGenerateTitle,
        clearTitleGenStatusTimer,
        clearTitleGenTimers,
    };
}
