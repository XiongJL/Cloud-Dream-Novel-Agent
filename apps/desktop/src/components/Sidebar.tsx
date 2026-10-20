import { useState, useEffect, useRef, memo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Book, ChevronRight, ChevronDown, Plus, FileText, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { formatNumber } from '../utils/format';
import { useTranslation } from 'react-i18next';
import { Volume, ChapterMetadata } from '../types';
import { ConfirmModal } from './ui/ConfirmModal';

interface SidebarProps {
    volumes: Volume[];
    currentChapterId: string | null;
    formatting?: string;
    onSelectChapter: (chapterId: string) => void;
    onCreateChapter: (volumeId: string) => void;
    onCreateVolume: () => void;
    onRenameVolume: (id: string, newTitle: string) => void;
    onRenameChapter: (id: string, newTitle: string) => void;
    onDeleteChapter: (id: string) => void;
    theme: 'dark' | 'light';
    lastCreatedVolumeId?: string | null;
    isVisible?: boolean;
}

// --- Memoized Chapter Item ---
const ChapterItem = memo(({
    chapter,
    currentChapterId,
    isDark,
    chapFormat,
    onSelect,
    onRename,
    onDelete
}: {
    chapter: ChapterMetadata;
    currentChapterId: string | null;
    isDark: boolean;
    chapFormat: string;
    onSelect: (id: string) => void;
    onRename: (id: string, newTitle: string) => void;
    onDelete: (chapter: ChapterMetadata) => void;
}) => {
    const { t } = useTranslation();
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState('');

    const startEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsEditing(true);
        setEditValue(chapter.title);
    };

    const saveEdit = () => {
        if (editValue.trim() && editValue !== chapter.title) {
            onRename(chapter.id, editValue);
        }
        setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') saveEdit();
        else if (e.key === 'Escape') setIsEditing(false);
    };

    return (
        <div
            data-chapter-id={chapter.id}
            aria-current={currentChapterId === chapter.id ? 'page' : undefined}
            onClick={() => onSelect(chapter.id)}
            onDoubleClick={startEdit}
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter') onSelect(chapter.id);
            }}
            className={clsx(
                "group flex items-center gap-2 p-2 mt-1 rounded text-sm cursor-pointer transition-colors min-h-[32px] outline-none focus:ring-1 focus:ring-purple-500",
                currentChapterId === chapter.id
                    ? (isDark ? "bg-purple-500/10 text-purple-300" : "bg-purple-500/10 text-purple-700")
                    : (isDark ? "text-neutral-500 hover:text-neutral-300 hover:bg-white/5" : "text-neutral-500 hover:text-neutral-800 hover:bg-black/5")
            )}
        >
            <FileText className="w-3 h-3 flex-shrink-0" />
            {isEditing ? (
                <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={saveEdit}
                    onKeyDown={handleKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    className={clsx(
                        "border rounded px-1 w-full outline-none text-xs",
                        isDark ? "bg-black/50 border-white/20 text-white" : "bg-white border-black/20 text-black"
                    )}
                />
            ) : (
                <span className="truncate w-full" title={t('sidebar.renameTip')}>
                    {formatNumber(chapFormat, chapter.order)}
                    {chapter.title ? <span className={clsx("ml-2", isDark ? "text-neutral-400" : "text-neutral-500")}>{chapter.title}</span> : ''}
                </span>
            )}
            {!isEditing && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete(chapter);
                    }}
                    className={clsx(
                        "opacity-0 group-hover:opacity-100 p-1 rounded transition-opacity",
                        isDark ? "hover:bg-[#20202a] text-neutral-500 hover:text-red-300" : "hover:bg-gray-200 text-neutral-400 hover:text-red-500"
                    )}
                    title={t('sidebar.deleteChapter')}
                    aria-label={t('sidebar.deleteChapter')}
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            )}
        </div>
    );
});

// --- Memoized Volume Item ---
const VolumeItem = memo(({
    volume,
    isExpanded,
    currentChapterId,
    isDark,
    volFormat,
    chapFormat,
    onToggle,
    onCreateChapter,
    onRenameVolume,
    onSelectChapter,
    onRenameChapter,
    onDeleteChapter,
    onRevealCurrentChapter
}: {
    volume: Volume;
    isExpanded: boolean;
    currentChapterId: string | null;
    isDark: boolean;
    volFormat: string;
    chapFormat: string;
    onToggle: (id: string) => void;
    onCreateChapter: (id: string) => void;
    onRenameVolume: (id: string, title: string) => void;
    onSelectChapter: (id: string) => void;
    onRenameChapter: (id: string, title: string) => void;
    onDeleteChapter: (chapter: ChapterMetadata) => void;
    onRevealCurrentChapter: () => void;
}) => {
    const { t } = useTranslation();
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState('');

    const startEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsEditing(true);
        setEditValue(volume.title);
    };

    const saveEdit = () => {
        if (editValue.trim() && editValue !== volume.title) {
            onRenameVolume(volume.id, editValue);
        }
        setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') saveEdit();
        else if (e.key === 'Escape') setIsEditing(false);
    };

    return (
        <div className="mb-4" data-volume-id={volume.id}>
            <div
                data-volume-header
                className={clsx(
                    "relative isolate flex items-center justify-between p-2 rounded cursor-pointer group outline-none focus:ring-1 focus:ring-purple-500 sticky top-0 z-10 border-b",
                    isDark
                        ? "bg-[#0F0F13] text-neutral-300 hover:bg-[#16161d] border-white/10"
                        : "bg-gray-50 text-neutral-700 hover:bg-gray-100 border-gray-200"
                )}
                tabIndex={0}
                onDoubleClick={startEdit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') onToggle(volume.id);
                }}
            >
                <span className="flex items-center gap-2 text-sm font-medium flex-1">
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggle(volume.id); }}
                        className={clsx("p-0.5 rounded", isDark ? "hover:bg-[#20202a]" : "hover:bg-gray-200")}
                    >
                        {isExpanded ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                    </button>

                    {isEditing ? (
                        <input
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            onKeyDown={handleKeyDown}
                            onClick={(e) => e.stopPropagation()}
                            className={clsx(
                                "border rounded px-1 min-w-[100px] outline-none text-xs",
                                isDark ? "bg-black/50 border-white/20 text-white" : "bg-white border-black/20 text-black"
                            )}
                        />
                    ) : (
                        <span title={t('sidebar.renameTip')} className="w-full">
                            {formatNumber(volFormat, volume.order)}
                            {volume.title ? <span className={clsx("ml-2", isDark ? "text-neutral-400" : "text-neutral-500")}>{volume.title}</span> : ''}
                        </span>
                    )}
                </span>

                {!isEditing && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onCreateChapter(volume.id);
                        }}
                        className={clsx("opacity-0 group-hover:opacity-100 p-1 rounded transition-opacity", isDark ? "hover:bg-[#20202a]" : "hover:bg-gray-200")}
                        title={t('sidebar.addChapter')}
                    >
                        <Plus className="w-3 h-3" />
                    </button>
                )}
            </div>

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        onAnimationComplete={onRevealCurrentChapter}
                        className="overflow-hidden ml-4 pl-2 border-l border-white/5"
                        // CSS Optimization for large lists (content-visibility)
                        style={{
                            contentVisibility: 'auto',
                            containIntrinsicSize: '0 500px' // Estimate a height
                        }}
                    >
                        {volume.chapters.map(chapter => (
                            <ChapterItem
                                key={chapter.id}
                                chapter={chapter}
                                currentChapterId={currentChapterId}
                                isDark={isDark}
                                chapFormat={chapFormat}
                                onSelect={onSelectChapter}
                                onRename={onRenameChapter}
                                onDelete={onDeleteChapter}
                            />
                        ))}
                        {volume.chapters.length === 0 && (
                            <div className="text-xs text-neutral-700 italic p-2">
                                {t('sidebar.noChapters')}
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
});

// --- Main Sidebar Component ---
const Sidebar = memo(({
    volumes,
    currentChapterId,
    formatting,
    onSelectChapter,
    onCreateChapter,
    onCreateVolume,
    onRenameVolume,
    onRenameChapter,
    onDeleteChapter,
    theme,
    lastCreatedVolumeId,
    isVisible = true
}: SidebarProps) => {
    const { t } = useTranslation();
    const [expandedVolumes, setExpandedVolumes] = useState<Record<string, boolean>>({});
    const [pendingDeleteChapter, setPendingDeleteChapter] = useState<ChapterMetadata | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const revealChapterRef = useRef<string | null>(null);
    const revealFrameRef = useRef<number | null>(null);
    const currentVolumeId = volumes.find(volume => volume.chapters.some(chapter => chapter.id === currentChapterId))?.id;

    const revealCurrentChapter = useCallback(() => {
        if (!revealChapterRef.current || revealFrameRef.current !== null) return;
        revealFrameRef.current = requestAnimationFrame(() => {
            revealFrameRef.current = null;
            const container = scrollContainerRef.current;
            const row = container?.querySelector<HTMLElement>('[aria-current="page"]');
            if (!container || !row || row.dataset.chapterId !== revealChapterRef.current || !container.clientHeight) return;
            const bounds = container.getBoundingClientRect();
            const header = row.closest('[data-volume-id]')?.querySelector<HTMLElement>('[data-volume-header]');
            const top = bounds.top + container.clientTop + (header?.offsetHeight ?? 0) + 8;
            const bottom = bounds.top + container.clientTop + container.clientHeight - 8;
            const target = row.getBoundingClientRect();
            if (target.top < top) container.scrollTop += target.top - top;
            else if (target.bottom > bottom) container.scrollTop += target.bottom - bottom;
            const visible = row.getBoundingClientRect();
            // Expansion can temporarily clamp scrollTop. Keep the request until
            // the volume's animation completes, then try against its final size.
            if (visible.height > 0 && visible.top >= top - 1 && visible.bottom <= bottom + 1) {
                revealChapterRef.current = null;
            }
        });
    }, []);

    const isDark = theme === 'dark';

    const formatConfig = formatting ? JSON.parse(formatting) : {};
    const volFormat = formatConfig.volume || '第 {n} 卷';
    const chapFormat = formatConfig.chapter || '第 {n} 章';

    // Reveal on selection/visibility changes, not on every metadata refresh or
    // manual scroll. The sidebar remounts when returning from Agent mode.
    useEffect(() => {
        revealChapterRef.current = isVisible && currentVolumeId ? currentChapterId : null;
        if (revealChapterRef.current && currentVolumeId) {
            setExpandedVolumes(prev => prev[currentVolumeId] ? prev : { ...prev, [currentVolumeId]: true });
            revealCurrentChapter();
        }
        return () => {
            revealChapterRef.current = null;
            if (revealFrameRef.current !== null) cancelAnimationFrame(revealFrameRef.current);
            revealFrameRef.current = null;
        };
    }, [currentChapterId, currentVolumeId, isVisible, revealCurrentChapter]);

    // Auto-expand when lastCreatedVolumeId changes
    useEffect(() => {
        if (lastCreatedVolumeId && !expandedVolumes[lastCreatedVolumeId]) {
            setExpandedVolumes(prev => ({
                ...prev,
                [lastCreatedVolumeId]: true
            }));
        }
    }, [lastCreatedVolumeId]);

    const toggleVolume = useCallback((id: string) => {
        setExpandedVolumes(prev => ({
            ...prev,
            [id]: !prev[id]
        }));
    }, []);

    const totalChapterCount = volumes.reduce((count, volume) => count + volume.chapters.length, 0);
    const pendingChapterLabel = pendingDeleteChapter
        ? `${formatNumber(chapFormat, pendingDeleteChapter.order)}${pendingDeleteChapter.title ? ` ${pendingDeleteChapter.title}` : ''}`
        : '';
    const isDeletingLastChapter = totalChapterCount === 1;

    return (
        <>
            <div className={clsx(
                "w-64 border-r flex flex-col h-full transition-colors duration-300",
                isDark ? "bg-[#0F0F13] border-white/5" : "bg-gray-50 border-gray-200"
            )}>
                <div className={clsx("p-4 border-b flex items-center justify-between", isDark ? "border-white/5" : "border-gray-200")}>
                    <h2 className={clsx("text-sm font-medium uppercase tracking-wider flex items-center gap-2", isDark ? "text-neutral-400" : "text-neutral-500")}>
                        <Book className="w-4 h-4" />
                        {t('sidebar.explorer')}
                    </h2>
                    <button
                        onClick={onCreateVolume}
                        className={clsx("p-1 rounded transition-colors", isDark ? "hover:bg-white/10 text-neutral-400 hover:text-white" : "hover:bg-black/5 text-neutral-500 hover:text-black")}
                        title={t('sidebar.newVolume')}
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>

                <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                    {volumes.map(volume => (
                        <VolumeItem
                            key={volume.id}
                            volume={volume}
                            isExpanded={!!expandedVolumes[volume.id]}
                            currentChapterId={currentChapterId}
                            isDark={isDark}
                            volFormat={volFormat}
                            chapFormat={chapFormat}
                            onToggle={toggleVolume}
                            onCreateChapter={onCreateChapter}
                            onRenameVolume={onRenameVolume}
                            onRenameChapter={onRenameChapter}
                            onDeleteChapter={setPendingDeleteChapter}
                            onSelectChapter={onSelectChapter}
                            onRevealCurrentChapter={revealCurrentChapter}
                        />
                    ))}
                </div>
            </div>
            <ConfirmModal
                isOpen={!!pendingDeleteChapter}
                onClose={() => setPendingDeleteChapter(null)}
                onConfirm={() => {
                    if (pendingDeleteChapter) {
                        onDeleteChapter(pendingDeleteChapter.id);
                    }
                }}
                title={t('sidebar.deleteChapter')}
                message={
                    isDeletingLastChapter
                        ? t('sidebar.deleteLastChapterConfirm')
                        : t('sidebar.deleteChapterConfirm', { title: pendingChapterLabel || t('search.untitled') })
                }
                confirmText={t('sidebar.deleteChapterAction')}
                theme={theme}
            />
        </>
    );
});

export default Sidebar;
