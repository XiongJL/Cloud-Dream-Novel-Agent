import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Idea } from '../../types';
import { Lightbulb, FileText, ArrowUpRight, Star, Trash2 } from 'lucide-react';
import TagManager from './TagManager';
import { useEffect, useRef, useState } from 'react';

interface SearchResultsListProps {
    results: {
        ideas: Idea[];
        chapters: any[];
        novels: any[];
    };
    onJump: (item: any, type: 'idea' | 'chapter' | 'novel') => void;
    onUpdateIdea: (id: string, data: Partial<Idea>) => void;
    onDeleteIdea?: (id: string) => void;
    onToggleStar?: (id: string, isStarred: boolean) => void;
    theme: 'dark' | 'light';
    allTags: string[];
    shakingIdeaId?: string | null;
    highlightedIdeaId?: string | null;
}

export default function SearchResultsList({ results, onJump, onUpdateIdea, onDeleteIdea, onToggleStar, theme, allTags, shakingIdeaId, highlightedIdeaId }: SearchResultsListProps) {
    const { t } = useTranslation();
    const isDark = theme === 'dark';
    const scrollRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState('');
    const [activeTagDropdownId, setActiveTagDropdownId] = useState<string | null>(null);

    const startEdit = (idea: Idea) => {
        setEditingId(idea.id);
        setEditContent(idea.content);
    };

    const saveEdit = (id: string) => {
        if (!editingId) return;

        // Find idea to compare? Or just update if changed
        onUpdateIdea(id, { content: editContent });
        setEditingId(null);
    };

    const hasNoResults = results.ideas.length === 0 && results.chapters.length === 0 && results.novels.length === 0;

    // Scroll to shaking or highlighted idea
    useEffect(() => {
        const idToScroll = shakingIdeaId || highlightedIdeaId;
        if (idToScroll && scrollRefs.current[idToScroll]) {
            scrollRefs.current[idToScroll]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [shakingIdeaId, highlightedIdeaId]);

    // Inline style for shake animation
    const shakeStyle = {
        animation: 'shake 0.5s cubic-bezier(.36,.07,.19,.97) both'
    };

    // Inline style for flash animation
    const flashStyle = {
        animation: 'flash 2s ease-out'
    };

    if (hasNoResults) {
        return (
            <div className={clsx("flex flex-col items-center justify-center flex-1 p-8 text-center opacity-50", isDark ? "text-neutral-500" : "text-neutral-400")}>
                <p className="text-sm">{t('search.noResults', '没有找到相关内容')}</p>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">

            {/* Ideas Group */}
            {results.ideas.length > 0 && (
                <div className="mb-4">
                    <div className={clsx(
                        "flex items-center gap-2 px-2 mb-2 text-xs font-bold uppercase tracking-wider",
                        isDark ? "text-neutral-500" : "text-neutral-400"
                    )}>
                        <Lightbulb className="w-3 h-3" />
                        <span>{t('sidebar.idea')} ({results.ideas.length})</span>
                    </div>

                    {results.ideas.map(idea => {
                        const isTagDropdownOpen = activeTagDropdownId === idea.id;
                        return (
                            <div
                                key={idea.id}
                                ref={el => scrollRefs.current[idea.id] = el}
                                className={clsx(
                                    "group relative mb-2 p-3 rounded-lg border transition-all cursor-pointer", // Removed overflow-hidden
                                    isDark
                                        ? "bg-[#1a1a1f] border-white/5 hover:border-white/10"
                                        : "bg-white border-gray-200 hover:border-gray-300",
                                    idea.isStarred && "pt-5", // Add extra top padding if starred to avoid ribbon overlap
                                    isTagDropdownOpen ? "z-50" : "z-0" // Elevate z-index when dropdown is open
                                )}
                                style={
                                    shakingIdeaId === idea.id ? shakeStyle :
                                        highlightedIdeaId === idea.id ? flashStyle : undefined
                                }
                                onClick={() => startEdit(idea)}
                            >
                                {/* Starred Indicator: Corner Ribbon (v3 - Narrower) */}
                                {idea.isStarred && (
                                    <div className="absolute top-0 left-0 w-10 h-10 pointer-events-none z-20 overflow-hidden rounded-tl-lg">
                                        <div className={clsx(
                                            "absolute top-0 left-0 w-[160%] h-3.5 -rotate-45 -translate-x-[40%] translate-y-[20%] flex items-center justify-center shadow-md",
                                            isDark
                                                ? "bg-gradient-to-r from-amber-600 to-amber-500"
                                                : "bg-gradient-to-r from-amber-500 to-amber-400"
                                        )}>
                                            <Star className="w-2 h-2 text-white fill-white" />
                                        </div>
                                    </div>
                                )}

                                {/* Jump Button (Relative Header) */}
                                <div className="flex justify-end mb-1 -mt-2 -mr-2 relative z-20">
                                    <button
                                        className={clsx(
                                            "p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-all",
                                            isDark ? "text-neutral-400 hover:text-white hover:bg-white/10" : "text-neutral-400 hover:text-black hover:bg-black/5"
                                        )}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onJump(idea, 'idea');
                                        }}
                                    >
                                        <ArrowUpRight className="w-4 h-4" />
                                    </button>
                                </div>

                                {editingId === idea.id ? (
                                    <textarea
                                        value={editContent}
                                        onChange={(e) => setEditContent(e.target.value)}
                                        // Stop propagation to prevent container click issues (though container click sets edit again, no big deal)
                                        onClick={(e) => e.stopPropagation()}
                                        onBlur={() => saveEdit(idea.id)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                                saveEdit(idea.id);
                                            }
                                        }}
                                        autoFocus
                                        className={clsx(
                                            "w-full bg-transparent border-none outline-none resize-none text-sm font-medium mb-1",
                                            isDark ? "text-neutral-200" : "text-neutral-800"
                                        )}
                                        rows={3}
                                    />
                                ) : (
                                    <div className={clsx("text-sm font-medium mb-1 line-clamp-2 relative z-10", isDark ? "text-neutral-200" : "text-neutral-800")}>
                                        {idea.content}
                                    </div>
                                )}

                                {idea.quote && (
                                    <div className={clsx(
                                        "text-xs italic truncate mb-1 pl-2 border-l-2 relative z-10",
                                        isDark ? "border-neutral-700 text-neutral-500" : "border-gray-300 text-gray-500"
                                    )}>
                                        "{idea.quote}"
                                    </div>
                                )}

                                <div className="flex items-center gap-2 mb-2 flex-wrap justify-between mt-2 relative z-10">
                                    <div className="flex items-center gap-2">
                                        <div className={clsx("text-[10px]", isDark ? "text-neutral-600" : "text-gray-400")}>
                                            {new Date(idea.timestamp).toLocaleDateString()}
                                        </div>
                                        <TagManager
                                            idea={idea}
                                            onUpdate={onUpdateIdea}
                                            theme={theme}
                                            allTags={allTags}
                                            isOpen={isTagDropdownOpen}
                                            onToggle={(isOpen) => setActiveTagDropdownId(isOpen ? idea.id : null)}
                                        />
                                    </div>

                                    {/* Actions: Star & Delete */}
                                    <div className="flex items-center gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                                        {onToggleStar && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onToggleStar(idea.id, !idea.isStarred);
                                                }}
                                                className={clsx(
                                                    "p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors",
                                                    idea.isStarred ? "text-amber-500" : (isDark ? "text-neutral-500" : "text-gray-400")
                                                )}
                                                title={idea.isStarred ? t('idea.unstar') : t('idea.star')}
                                            >
                                                <Star className={clsx("w-3.5 h-3.5", idea.isStarred && "fill-amber-500")} />
                                            </button>
                                        )}
                                        {onDeleteIdea && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onDeleteIdea(idea.id);
                                                }}
                                                className={clsx(
                                                    "p-1 rounded hover:bg-red-500/10 hover:text-red-500 transition-colors",
                                                    isDark ? "text-neutral-500" : "text-gray-400"
                                                )}
                                                title={t('common.delete')}
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Placeholder for Chapters Group */}
            {results.chapters.length > 0 && (
                <div className="mb-4">
                    <div className={clsx(
                        "flex items-center gap-2 px-2 mb-2 text-xs font-bold uppercase tracking-wider",
                        isDark ? "text-neutral-500" : "text-neutral-400"
                    )}>
                        <FileText className="w-3 h-3" />
                        <span>{t('sidebar.chapters')} ({results.chapters.length})</span>
                    </div>
                    {/* Render Chapters */}
                </div>
            )}

            <style>{`
                @keyframes shake {
                    10%, 90% { transform: translate3d(-1px, 0, 0); }
                    20%, 80% { transform: translate3d(2px, 0, 0); }
                    30%, 50%, 70% { transform: translate3d(-4px, 0, 0); }
                    40%, 60% { transform: translate3d(4px, 0, 0); }
                }
                @keyframes flash {
                    0% { background-color: rgba(168, 85, 247, 0.4); } 
                    100% { background-color: transparent; }
                }
            `}</style>
        </div>
    );
}
