import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter, Novel, Volume } from '../../../types';
import type { RecentFile } from '../../../components/RecentFilesDropdown';
import { chapterSaveQueue } from '../../../../shared/chapterSaveQueue';

type UseChapterLifecycleParams = {
    novelId: string;
    t: (...args: any[]) => any;
    onActiveChapterMetadataChange?: (meta: { id: string; title: string } | null) => void;
    onClearTitleCandidates?: () => void;
    onBeforeSelectChapter?: () => void;
    getLatestContent?: () => Promise<string | undefined>;
};

export function useChapterLifecycle({
    novelId,
    t,
    onActiveChapterMetadataChange,
    onClearTitleCandidates,
    onBeforeSelectChapter,
    getLatestContent,
}: UseChapterLifecycleParams) {
    const [novel, setNovel] = useState<Novel | null>(null);
    const [volumes, setVolumes] = useState<Volume[]>([]);
    const [currentChapter, setCurrentChapter] = useState<Chapter | null>(null);
    const [title, setTitleState] = useState('');
    const [content, setContentState] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
    const [lastCreatedVolumeId, setLastCreatedVolumeId] = useState<string | null>(null);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [saveStatusText, setSaveStatusText] = useState('');

    const contentRef = useRef(content);
    const titleRef = useRef(title);
    const chapterRef = useRef(currentChapter);
    const isSwitchingChapterRef = useRef(false);
    const isCreatingChapterRef = useRef(false);
    const activeChapterIdRef = useRef<string | null>(null);
    const chapterCacheRef = useRef(new Map<string, Chapter>());
    const saveQueue = chapterSaveQueue(novelId);
    const saveStatusTimerRef = useRef<number | null>(null);
    const setTitle = useCallback((value: React.SetStateAction<string>) => {
        titleRef.current = typeof value === 'function' ? value(titleRef.current) : value;
        setTitleState(titleRef.current);
    }, []);
    const setContent = useCallback((value: React.SetStateAction<string>) => {
        contentRef.current = typeof value === 'function' ? value(contentRef.current) : value;
        setContentState(contentRef.current);
    }, []);

    useEffect(() => {
        chapterRef.current = currentChapter;
        onActiveChapterMetadataChange?.(currentChapter ? { id: currentChapter.id, title: currentChapter.title } : null);
    }, [content, currentChapter, onActiveChapterMetadataChange, title]);

    const clearSaveStatusTimer = useCallback(() => {
        if (saveStatusTimerRef.current !== null) {
            window.clearTimeout(saveStatusTimerRef.current);
            saveStatusTimerRef.current = null;
        }
    }, []);

    const scheduleSaveStatusReset = useCallback((delay = 2200) => {
        clearSaveStatusTimer();
        saveStatusTimerRef.current = window.setTimeout(() => {
            setSaveState('idle');
            setSaveStatusText('');
            saveStatusTimerRef.current = null;
        }, delay);
    }, [clearSaveStatusTimer]);

    useEffect(() => {
        return () => {
            clearSaveStatusTimer();
        };
    }, [clearSaveStatusTimer]);

    useEffect(() => {
        if (!novelId) return;
        window.db.getNovels().then((novels) => {
            const found = novels.find((item) => item.id === novelId);
            if (found) setNovel(found);
        });
    }, [novelId]);

    useEffect(() => {
        if (!novelId) return;
        try {
            const stored = localStorage.getItem(`recent_files_${novelId}`);
            if (stored) {
                setRecentFiles(JSON.parse(stored));
            } else {
                setRecentFiles([]);
            }
        } catch {
            setRecentFiles([]);
        }
    }, [novelId]);

    const addToRecentFiles = useCallback((chapter: Chapter) => {
        setRecentFiles((prev) => {
            const filtered = prev.filter((file) => file.id !== chapter.id);
            const newFile: RecentFile = {
                id: chapter.id,
                title: chapter.title,
                timestamp: Date.now(),
                initialData: {
                    novelId,
                    chapterId: chapter.id,
                },
            };
            const updated = [newFile, ...filtered].slice(0, 25);
            localStorage.setItem(`recent_files_${novelId}`, JSON.stringify(updated));
            return updated;
        });
    }, [novelId]);

    const handleDeleteRecent = useCallback((id: string) => {
        setRecentFiles((prev) => {
            const updated = prev.filter((file) => file.id !== id);
            localStorage.setItem(`recent_files_${novelId}`, JSON.stringify(updated));
            return updated;
        });
    }, [novelId]);

    const syncChapterIntoEditor = useCallback((chapter: Chapter) => {
        chapterCacheRef.current.set(chapter.id, chapter);
        activeChapterIdRef.current = chapter.id;
        isSwitchingChapterRef.current = false;
        chapterRef.current = chapter;
        titleRef.current = chapter.title;
        contentRef.current = chapter.content;
        setCurrentChapter(chapter);
        setTitle(chapter.title);
        setContent(chapter.content);
        setIsLoading(false);
        onActiveChapterMetadataChange?.({ id: chapter.id, title: chapter.title });
        onClearTitleCandidates?.();
        localStorage.setItem(`last_chapter_${novelId}`, chapter.id);
        addToRecentFiles(chapter);
    }, [addToRecentFiles, novelId, onActiveChapterMetadataChange, onClearTitleCandidates]);

    const clearEditorChapterState = useCallback(() => {
        activeChapterIdRef.current = null;
        isSwitchingChapterRef.current = false;
        chapterRef.current = null;
        titleRef.current = '';
        contentRef.current = '';
        setCurrentChapter(null);
        setTitle('');
        setContent('');
        setIsLoading(false);
        onActiveChapterMetadataChange?.(null);
        onClearTitleCandidates?.();
        localStorage.removeItem(`last_chapter_${novelId}`);
    }, [novelId, onActiveChapterMetadataChange, onClearTitleCandidates]);

    const loadVolumes = useCallback(async () => {
        try {
            const data = await window.db.getVolumes(novelId);
            setVolumes(data);
            if (!currentChapter && data.length > 0) {
                const lastChapterId = localStorage.getItem(`last_chapter_${novelId}`);
                let targetChapterId = lastChapterId;
                const exists = data.some((volume) => volume.chapters.some((chapter) => chapter.id === lastChapterId));
                if (!exists) {
                    targetChapterId = data[0].chapters[0]?.id ?? null;
                }
                if (targetChapterId) {
                    const targetChapter = data.flatMap((volume) => volume.chapters).find((chapter) => chapter.id === targetChapterId);
                    if (targetChapter) {
                        onActiveChapterMetadataChange?.({ id: targetChapter.id, title: targetChapter.title });
                    }
                    void handleSelectChapter(targetChapterId);
                }
            }
        } catch (error) {
            console.error('Failed to load volumes:', error);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentChapter, novelId, onActiveChapterMetadataChange]);

    const saveChanges = useCallback(async (trigger: 'manual' | 'auto' | 'lifecycle' = 'manual') => {
        const current = chapterRef.current;
        if (!current) return;
        const contentToSave = contentRef.current;
        const titleToSave = titleRef.current;
        if (contentToSave === current.content && titleToSave === current.title) {
            if (trigger === 'manual') {
                setSaveState('saved'); setSaveStatusText(t('editor.saveUpToDate')); scheduleSaveStatusReset();
            }
            return;
        }
        const runSave = async () => {

            const hasContentChanges = contentToSave !== current.content;
            const hasTitleChanges = titleToSave !== current.title;

            if (!hasContentChanges && !hasTitleChanges) {
                if (trigger === 'manual') {
                    setSaveState('saved');
                    setSaveStatusText(t('editor.saveUpToDate'));
                    scheduleSaveStatusReset();
                }
                return;
            }

            clearSaveStatusTimer();
            if (trigger !== 'auto') {
                setSaveState('saving');
                setSaveStatusText(t('editor.saveSaving'));
            }

            let chapterUpdated = false;

            try {
                if (hasContentChanges) {
                    await window.db.saveChapter({
                        chapterId: current.id,
                        content: contentToSave,
                    });
                    chapterUpdated = true;
                }

                if (hasTitleChanges) {
                    await window.db.renameChapter({
                        chapterId: current.id,
                        title: titleToSave,
                    });
                    await loadVolumes();
                    chapterUpdated = true;
                }

                if (chapterUpdated) {
                    const updatedChapter = {
                        ...current,
                        content: contentToSave,
                        title: titleToSave,
                    };
                    const cached = chapterCacheRef.current.get(current.id);
                    if (!cached || cached === current || (cached.content === contentToSave && cached.title === titleToSave)) {
                        chapterCacheRef.current.set(current.id, updatedChapter);
                    }
                    if (chapterRef.current?.id === current.id) {
                        chapterRef.current = updatedChapter;
                        setCurrentChapter(updatedChapter);
                    }
                    addToRecentFiles(updatedChapter);
                }

                if (trigger === 'auto') {
                    setSaveState('idle');
                    setSaveStatusText('');
                } else {
                    setSaveState('saved');
                    setSaveStatusText(t('editor.saveSaved'));
                    scheduleSaveStatusReset();
                }
            } catch (error) {
                console.error('[Editor] saveChanges failed:', error);
                setSaveState('error');
                setSaveStatusText(t('editor.saveFailed'));
                scheduleSaveStatusReset(3200);
                throw error;
            }
        };

        return saveQueue.enqueue(current.id, runSave);
    }, [addToRecentFiles, clearSaveStatusTimer, loadVolumes, saveQueue, scheduleSaveStatusReset, t]);

    const flushEdits = useCallback(async () => {
        const chapterId = chapterRef.current?.id;
        const latest = await getLatestContent?.();
        if (latest !== undefined && chapterRef.current?.id === chapterId) setContent(latest);
        // Do not re-enqueue stale current content ahead of a failed older write.
        await saveQueue.flush();
        await saveChanges('lifecycle');
        await saveQueue.flush();
    }, [getLatestContent, saveChanges, saveQueue, setContent]);

    useEffect(() => window.backup.onFlush(flushEdits), [flushEdits]);
    useEffect(() => window.novelExport.onFlush(novelId, flushEdits), [flushEdits, novelId]);

    useEffect(() => window.backup.onFlush(() => saveChanges('lifecycle')), [saveChanges]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            if (!currentChapter) return;
            if (content !== currentChapter.content || title !== currentChapter.title) {
                void saveChanges('auto').catch(() => undefined);
            }
        }, 1000);
        return () => window.clearTimeout(timer);
    }, [content, currentChapter, saveChanges, title]);

    useEffect(() => {
        const handleUnload = () => {
            if (!chapterRef.current) return;
            if (contentRef.current !== chapterRef.current.content || titleRef.current !== chapterRef.current.title) {
                void saveChanges('lifecycle').catch(() => undefined);
            }
        };
        window.addEventListener('beforeunload', handleUnload);
        return () => {
            window.removeEventListener('beforeunload', handleUnload);
            handleUnload();
        };
    }, [saveChanges]);

    const handleSelectChapter = useCallback(async (chapterId: string) => {
        if (isSwitchingChapterRef.current && activeChapterIdRef.current === chapterId) return;
        if (chapterRef.current?.id === chapterId) return;

        isSwitchingChapterRef.current = true;
        onActiveChapterMetadataChange?.({ id: chapterId, title: 'Loading...' });
        activeChapterIdRef.current = chapterId;
        onBeforeSelectChapter?.();

        const oldChapter = chapterRef.current;
        const oldContent = contentRef.current;
        const oldTitle = titleRef.current;

        if (oldChapter) {
            const updatedOldChapter = {
                ...oldChapter,
                content: oldContent,
                title: oldTitle,
            };

            // Keep the in-memory chapter cache ahead of the async persistence queue.
            // This preserves the pre-refactor behavior where switching away and back
            // immediately still shows the latest edits.
            chapterCacheRef.current.set(oldChapter.id, updatedOldChapter);

            const savePromise = async () => {
                if (oldContent !== oldChapter.content) {
                    await window.db.saveChapter({ chapterId: oldChapter.id, content: oldContent });
                }
                if (oldTitle !== oldChapter.title) {
                    await window.db.renameChapter({ chapterId: oldChapter.id, title: oldTitle });
                    await loadVolumes();
                }
            };
            if (oldContent !== oldChapter.content || oldTitle !== oldChapter.title) {
                void saveQueue.enqueue(oldChapter.id, savePromise).catch((error) => console.error('[Editor] Background save failed', error));
            }
        }

        const cached = chapterCacheRef.current.get(chapterId);
        if (cached) {
            chapterRef.current = cached;
            onActiveChapterMetadataChange?.({ id: cached.id, title: cached.title });
            setTitle(cached.title);
            setContent(cached.content);
            setCurrentChapter(cached);
            setIsLoading(false);
        } else {
            chapterRef.current = null;
            setCurrentChapter(null);
            setIsLoading(true);
        }

        try {
            const stored = await window.db.getChapter(chapterId);
            const chapter = saveQueue.has(chapterId) ? chapterCacheRef.current.get(chapterId) || stored : stored;
            if (activeChapterIdRef.current !== chapterId) return;
            if (chapter) {
                chapterRef.current = chapter;
                chapterCacheRef.current.set(chapterId, chapter);
                onActiveChapterMetadataChange?.({ id: chapter.id, title: chapter.title });
                setTitle(chapter.title);
                setContent(chapter.content);
                setCurrentChapter(chapter);
                onClearTitleCandidates?.();
                localStorage.setItem(`last_chapter_${novelId}`, chapterId);
                addToRecentFiles(chapter);
            }
        } catch (error) {
            console.error('Failed to load chapter:', error);
        } finally {
            if (activeChapterIdRef.current === chapterId) {
                setIsLoading(false);
                window.setTimeout(() => {
                    isSwitchingChapterRef.current = false;
                }, 300);
            }
        }
    }, [
        addToRecentFiles,
        currentChapter,
        loadVolumes,
        novelId,
        onActiveChapterMetadataChange,
        onBeforeSelectChapter,
        onClearTitleCandidates,
        saveQueue,
    ]);

    const handleDeleteChapter = useCallback(async (chapterId: string) => {
        const isDeletingCurrent = chapterRef.current?.id === chapterId;

        try {
            const result = await window.db.deleteChapter({ chapterId });
            saveQueue.discard(chapterId);
            saveQueue.discard(`rename-chapter:${chapterId}`);
            chapterCacheRef.current.delete(chapterId);
            handleDeleteRecent(chapterId);

            const refreshedVolumes = await window.db.getVolumes(novelId);
            setVolumes(refreshedVolumes);

            if (result.mode === 'reset') {
                const resetChapter = result.chapter ?? await window.db.getChapter(chapterId);
                if (resetChapter) {
                    syncChapterIntoEditor(resetChapter);
                } else {
                    clearEditorChapterState();
                }
                return;
            }

            if (!isDeletingCurrent) {
                return;
            }

            clearEditorChapterState();

            if (!result.fallbackChapterId) {
                return;
            }

            const fallbackChapter = await window.db.getChapter(result.fallbackChapterId);
            if (fallbackChapter) {
                syncChapterIntoEditor(fallbackChapter);
            }
        } catch (error) {
            console.error('Failed to delete chapter:', error);
        }
    }, [clearEditorChapterState, handleDeleteRecent, novelId, saveQueue, syncChapterIntoEditor]);

    const handleCreateChapter = useCallback(async (volumeId: string) => {
        if (isCreatingChapterRef.current) return;
        isCreatingChapterRef.current = true;
        const volume = volumes.find((item) => item.id === volumeId);
        try {
            const order = volume ? Math.max(0, ...volume.chapters.map((chapter) => chapter.order)) + 1 : 1;
            const newChapter = await window.db.createChapter({ volumeId, title: '', order });
            await loadVolumes();
            await handleSelectChapter(newChapter.id);
        } catch (error) {
            console.error('Failed to create chapter:', error);
        } finally {
            isCreatingChapterRef.current = false;
        }
    }, [handleSelectChapter, loadVolumes, volumes]);

    const handleCreateVolume = useCallback(async () => {
        try {
            const newVolume = await window.db.createVolume({ novelId, title: '' });
            await loadVolumes();
            setLastCreatedVolumeId(newVolume.id);
        } catch (error) {
            console.error('Failed to create volume:', error);
        }
    }, [loadVolumes, novelId]);

    const handleRenameVolume = useCallback(async (volumeId: string, newTitle: string) => {
        try {
            await saveQueue.enqueue(`rename-volume:${volumeId}`, async () => { await window.db.renameVolume({ volumeId, title: newTitle }); });
            await loadVolumes();
        } catch (error) {
            console.error('Failed to rename volume:', error);
        }
    }, [loadVolumes, saveQueue]);

    const handleRenameChapter = useCallback(async (chapterId: string, newTitle: string) => {
        try {
            await saveQueue.enqueue(`rename-chapter:${chapterId}`, async () => { await window.db.renameChapter({ chapterId, title: newTitle }); });
            if (currentChapter?.id === chapterId) {
                setTitle(newTitle);
            }
            await loadVolumes();
        } catch (error) {
            console.error('Failed to rename chapter:', error);
        }
    }, [currentChapter?.id, loadVolumes, saveQueue, setTitle]);

    useEffect(() => {
        void loadVolumes();
    }, [loadVolumes]);

    return {
        novel,
        setNovel,
        volumes,
        setVolumes,
        currentChapter,
        setCurrentChapter,
        title,
        setTitle,
        content,
        setContent,
        isLoading,
        setIsLoading,
        recentFiles,
        setRecentFiles,
        lastCreatedVolumeId,
        setLastCreatedVolumeId,
        saveState,
        setSaveState,
        saveStatusText,
        setSaveStatusText,
        contentRef,
        titleRef,
        chapterRef,
        isSwitchingChapterRef,
        activeChapterIdRef,
        clearSaveStatusTimer,
        scheduleSaveStatusReset,
        addToRecentFiles,
        handleDeleteRecent,
        loadVolumes,
        saveChanges,
        handleSelectChapter,
        handleDeleteChapter,
        handleCreateChapter,
        handleCreateVolume,
        handleRenameVolume,
        handleRenameChapter,
    };
}
