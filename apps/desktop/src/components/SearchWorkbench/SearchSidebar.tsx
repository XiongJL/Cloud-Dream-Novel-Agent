import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Search, X, Lightbulb, RefreshCw, Loader2, Library, ChevronRight, ChevronDown, FileText, User, Package, Globe, Map } from 'lucide-react';
import { formatNumber } from '../../utils/format';

// ─── Types ──────────────────────────────────────────
type SearchCategory = 'chapter' | 'idea' | 'character' | 'item' | 'world' | 'map';

interface SearchSidebarProps {
    theme: 'dark' | 'light';
    novelId: string;
    onClose?: () => void;
    onJumpToChapter?: (chapterId: string, keyword: string, context?: string) => void;
    onJumpToIdea?: (ideaId: string) => void;
    onJumpToEntity?: (category: 'character' | 'item' | 'world' | 'map', entityId: string) => void;
    onSearchChange?: (keyword: string) => void;
}

// Frontend-matched entity
interface FrontendMatch {
    id: string;
    name: string;
    snippet: string; // highlighted snippet
    type: string; // sub-type (role, item type, world setting type, etc.)
    category: 'character' | 'item' | 'world' | 'map';
}

// ─── Helpers ────────────────────────────────────────
function highlightKeyword(text: string, keyword: string): string {
    if (!text || !keyword) return text || '';
    const lowerText = text.toLowerCase();
    const lowerKey = keyword.toLowerCase();
    const idx = lowerText.indexOf(lowerKey);
    if (idx === -1) return text;

    // Generate snippet around match
    const contextLen = 40;
    const start = Math.max(0, idx - contextLen);
    const end = Math.min(text.length, idx + keyword.length + contextLen);

    let result = '';
    if (start > 0) result += '...';
    result += text.substring(start, idx);
    result += '<mark>' + text.substring(idx, idx + keyword.length) + '</mark>';
    result += text.substring(idx + keyword.length, end);
    if (end < text.length) result += '...';
    return result;
}

function matchEntity(keyword: string, ...fields: (string | null | undefined)[]): boolean {
    const lk = keyword.toLowerCase();
    return fields.some(f => f && f.toLowerCase().includes(lk));
}

// ─── Component ──────────────────────────────────────
export default function SearchSidebar({
    theme,
    novelId,
    onClose,
    onJumpToChapter,
    onJumpToIdea,
    onJumpToEntity,
    onSearchChange
}: SearchSidebarProps) {
    const { t } = useTranslation();
    const isDark = theme === 'dark';

    const [searchQuery, setSearchQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [frontendResults, setFrontendResults] = useState<FrontendMatch[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isRebuilding, setIsRebuilding] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [offset, setOffset] = useState(0);
    const [tooltipData, setTooltipData] = useState<{ content: string; x: number; y: number } | null>(null);
    const [novelFormatting, setNovelFormatting] = useState<string>('');
    const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set());
    const [collapsedChapters, setCollapsedChapters] = useState<Set<string>>(new Set());
    const [collapsedChapterGroup, setCollapsedChapterGroup] = useState(false);
    const [collapsedIdeas, setCollapsedIdeas] = useState(false);
    const [collapsedCharacters, setCollapsedCharacters] = useState(false);
    const [collapsedItems, setCollapsedItems] = useState(false);
    const [collapsedWorld, setCollapsedWorld] = useState(false);
    const [collapsedMaps, setCollapsedMaps] = useState(false);

    // Category filter
    const [activeCategories, setActiveCategories] = useState<Set<SearchCategory>>(
        new Set(['chapter', 'idea', 'character', 'item', 'world', 'map'])
    );

    const debounceRef = useRef<NodeJS.Timeout | null>(null);
    const LIMIT = 20;

    // Reset state when novelId changes
    useEffect(() => {
        setSearchQuery('');
        setResults([]);
        setFrontendResults([]);
        setOffset(0);
        setHasMore(false);
        setCollapsedVolumes(new Set());
        setCollapsedChapters(new Set());
        setCollapsedChapterGroup(false);
        setCollapsedIdeas(false);
        setCollapsedCharacters(false);
        setCollapsedItems(false);
        setCollapsedWorld(false);

        const fetchNovel = async () => {
            if (!novelId) return;
            try {
                const novels = await window.db.getNovels();
                const currentNovel = novels.find(n => n.id === novelId);
                if (currentNovel) setNovelFormatting(currentNovel.formatting || '');
            } catch (e) {
                console.error('Failed to fetch novel formatting:', e);
            }
        };
        fetchNovel();
    }, [novelId]);

    // Check index status on mount
    useEffect(() => {
        const checkIndex = async () => {
            if (!novelId) return;
            try {
                const status = await window.db.checkIndexStatus(novelId);
                if (status.totalChapters > 0 && status.indexedChapters === 0) {

                    setIsRebuilding(true);
                    await window.db.rebuildSearchIndex(novelId);
                    setIsRebuilding(false);
                    if (searchQuery.trim()) performSearch(searchQuery, true);
                }
            } catch (e) {
                console.error('Failed to check index status:', e);
            }
        };
        checkIndex();
    }, [novelId, searchQuery]);

    // --- Frontend search for characters, items, worldSettings ---
    const searchFrontendEntities = useCallback(async (keyword: string) => {
        if (!keyword.trim() || !novelId) {
            setFrontendResults([]);
            return;
        }

        const matches: FrontendMatch[] = [];

        try {
            const [characters, items, worldSettings, maps] = await Promise.all([
                window.db.getCharacters(novelId),
                window.db.getItems(novelId),
                window.db.getWorldSettings(novelId),
                window.db.getMaps(novelId),
            ]);

            // Search characters: match name, role, description, profile values
            for (const c of characters) {
                let profileText = '';
                try {
                    const parsed = JSON.parse(c.profile || '{}');
                    profileText = Object.values(parsed).join(' ');
                } catch { /* ignore */ }

                if (matchEntity(keyword, c.name, c.role, c.description, profileText)) {
                    const snippetSource = c.description || c.role || c.name;
                    matches.push({
                        id: c.id,
                        name: c.name,
                        snippet: highlightKeyword(snippetSource, keyword),
                        type: c.role || '',
                        category: 'character',
                    });
                }
            }

            // Search items
            for (const item of items) {
                let profileText = '';
                try {
                    const parsed = JSON.parse(item.profile || '{}');
                    profileText = Object.values(parsed).join(' ');
                } catch { /* ignore */ }

                if (matchEntity(keyword, item.name, item.description, item.type, profileText)) {
                    const snippetSource = item.description || item.name;
                    matches.push({
                        id: item.id,
                        name: item.name,
                        snippet: highlightKeyword(snippetSource, keyword),
                        type: item.type || '',
                        category: 'item',
                    });
                }
            }

            // Search world settings
            for (const ws of worldSettings) {
                if (matchEntity(keyword, ws.name, ws.content, ws.type)) {
                    const snippetSource = ws.content || ws.name;
                    matches.push({
                        id: ws.id,
                        name: ws.name,
                        snippet: highlightKeyword(snippetSource, keyword),
                        type: ws.type || '',
                        category: 'world',
                    });
                }
            }

            // Search maps
            for (const map of maps) {
                if (matchEntity(keyword, map.name, map.description, map.type)) {
                    const snippetSource = map.description || map.name;
                    matches.push({
                        id: map.id,
                        name: map.name,
                        snippet: highlightKeyword(snippetSource, keyword),
                        type: map.type || '',
                        category: 'map',
                    });
                }
            }
        } catch (e) {
            console.error('[SearchSidebar] Frontend search failed:', e);
        }

        setFrontendResults(matches);
    }, [novelId]);

    // --- FTS5 search ---
    const performSearch = useCallback(async (query: string, newSearch: boolean = true) => {
        if (!query.trim()) {
            setResults([]);
            setFrontendResults([]);
            setHasMore(false);
            return;
        }

        if (newSearch) {
            setCollapsedVolumes(new Set());
            setCollapsedChapters(new Set());
            setCollapsedChapterGroup(false);
            setCollapsedIdeas(false);
            setCollapsedCharacters(false);
            setCollapsedItems(false);
            setCollapsedWorld(false);
        }

        const currentOffset = newSearch ? 0 : offset;
        setIsLoading(true);

        try {
            const [searchResults] = await Promise.all([
                window.db.search({ novelId, keyword: query.trim(), limit: LIMIT, offset: currentOffset }),
                newSearch ? searchFrontendEntities(query) : Promise.resolve(),
            ]);

            if (newSearch) {
                setResults(searchResults);
                setOffset(LIMIT);
            } else {
                setResults(prev => [...prev, ...searchResults]);
                setOffset(prev => prev + LIMIT);
            }

            setHasMore(searchResults.length === LIMIT);
        } catch (error) {
            console.error('Search failed:', error);
        } finally {
            setIsLoading(false);
        }
    }, [novelId, offset, searchFrontendEntities]);

    useEffect(() => {
        const unsubscribeAutomation = window.automation?.onDataChanged?.(({ method }) => {
            if (!searchQuery.trim()) return;
            if (
                method === 'outline.write' ||
                method === 'character.create_batch' ||
                method === 'story_patch.apply' ||
                method === 'chapter.create' ||
                method === 'chapter.save' ||
                method === 'draft.commit'
            ) {
                void searchFrontendEntities(searchQuery);
                void performSearch(searchQuery, true);
            }
        });
        return () => unsubscribeAutomation?.();
    }, [performSearch, searchFrontendEntities, searchQuery]);

    // Debounced input
    const handleInputChange = useCallback((value: string) => {
        setSearchQuery(value);
        onSearchChange?.(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => performSearch(value, true), 300);
    }, [performSearch, onSearchChange]);

    // Rebuild index
    const handleRebuildIndex = async () => {
        setIsRebuilding(true);
        try {
            await window.db.rebuildSearchIndex(novelId);
            if (searchQuery.trim()) await performSearch(searchQuery, true);
        } catch (error) {
            console.error('Rebuild failed:', error);
        } finally {
            setIsRebuilding(false);
        }
    };

    // Toggle category filter
    const toggleCategory = (cat: SearchCategory) => {
        setActiveCategories(prev => {
            const next = new Set(prev);
            if (next.has(cat)) {
                // Don't allow deselecting all
                if (next.size > 1) next.delete(cat);
            } else {
                next.add(cat);
            }
            return next;
        });
    };

    // Volume/chapter collapse toggles
    const toggleVolumeCollapse = (volId: string) => {
        setCollapsedVolumes(prev => {
            const next = new Set(prev);
            if (next.has(volId)) next.delete(volId); else next.add(volId);
            return next;
        });
    };

    const toggleChapterCollapse = (chapId: string) => {
        setCollapsedChapters(prev => {
            const next = new Set(prev);
            if (next.has(chapId)) next.delete(chapId); else next.add(chapId);
            return next;
        });
    };

    // ─── Group FTS results ──────────────────────────
    const groupedResults = useMemo(() => {
        const ideas = results.filter(r => r.entityType === 'idea');
        const chapterRelated = results.filter(r => r.entityType === 'chapter');

        const nestedMap = chapterRelated.reduce((acc, curr) => {
            const volId = curr.volumeId || 'default';
            if (!acc[volId]) {
                acc[volId] = {
                    volumeId: curr.volumeId,
                    volumeTitle: curr.volumeTitle,
                    volumeOrder: curr.volumeOrder,
                    isVolumeMatch: false,
                    chapters: {}
                };
            }

            if (curr.matchType === 'volume') {
                acc[volId].isVolumeMatch = true;
                return acc;
            }

            if (!acc[volId].chapters[curr.chapterId]) {
                acc[volId].chapters[curr.chapterId] = {
                    chapterId: curr.chapterId,
                    title: curr.title,
                    chapterOrder: curr.chapterOrder,
                    isTitleMatch: false,
                    matches: []
                };
            }

            if (curr.matchType === 'title') {
                acc[volId].chapters[curr.chapterId].isTitleMatch = true;
                return acc;
            }

            acc[volId].chapters[curr.chapterId].matches.push(curr);
            return acc;
        }, {} as any);

        const sortedVolumes = Object.values(nestedMap).sort((a: any, b: any) => (a.volumeOrder || 0) - (b.volumeOrder || 0));
        sortedVolumes.forEach((v: any) => {
            v.sortedChapterList = Object.values(v.chapters).sort((a: any, b: any) => (a.chapterOrder || 0) - (b.chapterOrder || 0));
        });

        return { volumes: sortedVolumes, ideas };
    }, [results]);

    // ─── Group frontend results ─────────────────────
    const frontendGrouped = useMemo(() => {
        const characters = frontendResults.filter(r => r.category === 'character');
        const items = frontendResults.filter(r => r.category === 'item');
        const world = frontendResults.filter(r => r.category === 'world');
        const maps = frontendResults.filter(r => r.category === 'map');
        return { characters, items, world, maps };
    }, [frontendResults]);

    const totalChaptersFound: number = groupedResults.volumes.reduce((acc: number, vol: any) => acc + vol.sortedChapterList.length, 0);

    // Result click handler
    const handleResultClick = (result: SearchResult) => {
        if (result.entityType === 'chapter' && onJumpToChapter) {
            const context = result.snippet ? result.snippet.replace(/<[^>]+>/g, '') : undefined;
            onJumpToChapter(result.chapterId, result.keyword, context);
        } else if (result.entityType === 'idea' && onJumpToIdea) {
            onJumpToIdea(result.entityId);
        }
    };

    // Tooltip handlers
    const handleMouseEnter = (e: React.MouseEvent, content: string) => {
        if (!content) return;
        setTooltipData({ content: content.replace(/<[^>]+>/g, ''), x: e.clientX + 10, y: e.clientY + 10 });
    };
    const handleMouseMove = (e: React.MouseEvent) => {
        if (tooltipData) setTooltipData(prev => prev ? { ...prev, x: e.clientX + 10, y: e.clientY + 10 } : null);
    };
    const handleMouseLeave = () => setTooltipData(null);

    // Render snippet with highlighting
    const renderSnippet = (snippet: string) => (
        <span
            dangerouslySetInnerHTML={{ __html: snippet }}
            className={clsx(
                isDark ? "text-neutral-400" : "text-neutral-600",
                "[&>mark]:bg-yellow-500/30 [&>mark]:text-current [&>mark]:rounded-sm [&>mark]:px-0.5"
            )}
        />
    );

    // Category filter items
    const categories: { id: SearchCategory; icon: React.ElementType; count: number }[] = [
        { id: 'chapter', icon: FileText, count: totalChaptersFound },
        { id: 'idea', icon: Lightbulb, count: groupedResults.ideas.length },
        { id: 'character', icon: User, count: frontendGrouped.characters.length },
        { id: 'item', icon: Package, count: frontendGrouped.items.length },
        { id: 'world', icon: Globe, count: frontendGrouped.world.length },
        { id: 'map', icon: Map, count: frontendGrouped.maps.length },
    ];

    const hasAnyResults = results.length > 0 || frontendResults.length > 0;

    // ─── Render ─────────────────────────────────────
    return (
        <div className={clsx("flex flex-col h-full w-full", isDark ? "bg-[#0F0F13]" : "bg-gray-50")}>
            {/* Header */}
            <div className={clsx("p-4 border-b flex items-center justify-between", isDark ? "border-white/5" : "border-gray-200")}>
                <span className={clsx("text-xs font-bold uppercase tracking-wider", isDark ? "text-neutral-500" : "text-neutral-400")}>
                    {t('sidebar.search')}
                </span>
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleRebuildIndex}
                        disabled={isRebuilding}
                        className={clsx(
                            "p-1 rounded transition-colors",
                            isDark ? "hover:bg-white/10 text-neutral-400" : "hover:bg-black/5 text-neutral-500",
                            isRebuilding && "opacity-50 cursor-not-allowed"
                        )}
                        title={t('search.rebuildIndex')}
                    >
                        <RefreshCw className={clsx("w-4 h-4", isRebuilding && "animate-spin")} />
                    </button>
                    {onClose && (
                        <button onClick={onClose} className={clsx("p-1 rounded", isDark ? "hover:bg-white/10" : "hover:bg-black/5")}>
                            <X className="w-4 h-4 opacity-50" />
                        </button>
                    )}
                </div>
            </div>

            {/* Search Input */}
            <div className="px-4 pt-4 pb-2">
                <div className={clsx(
                    "flex items-center gap-2 px-3 py-2 rounded-lg transition-colors border",
                    isDark
                        ? "bg-black/20 border-white/10 text-white focus-within:border-white/20"
                        : "bg-white border-gray-200 text-neutral-900 focus-within:border-gray-300"
                )}>
                    <Search className={clsx("w-4 h-4", isDark ? "text-neutral-500" : "text-neutral-400")} />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => handleInputChange(e.target.value)}
                        placeholder={t('search.placeholder')}
                        className="bg-transparent border-none outline-none w-full text-sm placeholder-opacity-50"
                        autoFocus
                    />
                    {isLoading && <Loader2 className="w-4 h-4 animate-spin opacity-50" />}
                </div>
            </div>

            {/* Category Filter Buttons */}
            {searchQuery.trim() && hasAnyResults && (
                <div className="flex px-4 pb-3 gap-1.5 overflow-x-auto scrollbar-none">
                    {categories.map(cat => {
                        const isActive = activeCategories.has(cat.id);
                        return (
                            <button
                                key={cat.id}
                                onClick={() => toggleCategory(cat.id)}
                                className={clsx(
                                    "flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-all border",
                                    isActive
                                        ? (isDark
                                            ? "bg-purple-600/80 text-white border-purple-500/50"
                                            : "bg-purple-600 text-white border-purple-600")
                                        : (isDark
                                            ? "bg-white/5 text-neutral-500 border-white/5 hover:bg-white/10 hover:text-neutral-300"
                                            : "bg-gray-100 text-neutral-400 border-gray-200 hover:bg-gray-200 hover:text-neutral-600")
                                )}
                            >
                                <cat.icon className="w-3 h-3" />
                                <span>{t(`search.category.${cat.id}`)}</span>
                                {cat.count > 0 && (
                                    <span className={clsx(
                                        "text-[10px] px-1 rounded-full min-w-[16px] text-center",
                                        isActive
                                            ? "bg-white/20"
                                            : (isDark ? "bg-white/10" : "bg-gray-300/50")
                                    )}>
                                        {cat.count}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
                {/* No results */}
                {searchQuery.trim() && !isLoading && !hasAnyResults && (
                    <div className={clsx("text-center py-8 text-sm", isDark ? "text-neutral-500" : "text-neutral-400")}>
                        {t('search.noResults')}
                    </div>
                )}

                {/* ═══ Chapters Group ═══ */}
                {activeCategories.has('chapter') && groupedResults.volumes.length > 0 && (
                    <div className="pt-2">
                        <div
                            className={clsx(
                                "flex items-center gap-2 text-xs font-bold uppercase tracking-wider mb-3 cursor-pointer group hover:opacity-80 transition-colors select-none",
                                isDark ? "text-neutral-500" : "text-neutral-400"
                            )}
                            onClick={() => setCollapsedChapterGroup(!collapsedChapterGroup)}
                        >
                            <ChevronDown className={clsx("w-3 h-3 transition-transform opacity-50", collapsedChapterGroup && "-rotate-90")} />
                            <FileText className="w-3.5 h-3.5" />
                            <span>{t('search.chapters')} ({totalChaptersFound})</span>
                        </div>

                        {!collapsedChapterGroup && (
                            <div className="space-y-6">
                                {groupedResults.volumes.map((vol: any) => {
                                    const formatConfig = novelFormatting ? JSON.parse(novelFormatting) : {};
                                    const volFormat = formatConfig.volume || t('search.defaultVolumeFormat');
                                    const chapFormat = formatConfig.chapter || t('search.defaultChapterFormat');
                                    const volId = vol.volumeId || 'default';
                                    const isVolCollapsed = collapsedVolumes.has(volId);

                                    return (
                                        <div key={volId} className="space-y-3">
                                            <div
                                                className={clsx(
                                                    "flex items-center gap-2 text-xs font-bold mb-1 p-1 rounded-md transition-colors cursor-pointer group select-none",
                                                    isDark ? "text-amber-500/80 hover:bg-white/5" : "text-amber-700/80 hover:bg-black/5",
                                                    vol.isVolumeMatch && (isDark ? "bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/30" : "bg-amber-50 text-amber-900 ring-1 ring-amber-200")
                                                )}
                                                onClick={() => toggleVolumeCollapse(volId)}
                                            >
                                                <button className="p-0.5 rounded hover:bg-black/10">
                                                    {isVolCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                                </button>
                                                <Library className="w-3.5 h-3.5" />
                                                <span className="flex-1 truncate">
                                                    {vol.volumeOrder ? formatNumber(volFormat, vol.volumeOrder) : ''}
                                                    {vol.volumeTitle ? ` ${vol.volumeTitle}` : ''}
                                                </span>
                                            </div>

                                            {!isVolCollapsed && (
                                                <div className="space-y-3 pl-2 border-l border-white/5">
                                                    {vol.sortedChapterList.map((chap: any) => {
                                                        const isChapCollapsed = collapsedChapters.has(chap.chapterId);
                                                        return (
                                                            <div key={chap.chapterId} className={clsx(
                                                                "rounded-lg overflow-hidden border transition-all",
                                                                isDark ? "border-white/5 bg-white/5" : "border-gray-200 bg-white",
                                                                chap.isTitleMatch && (isDark ? "ring-1 ring-amber-500/30 bg-amber-500/5" : "ring-1 ring-amber-200 bg-amber-50")
                                                            )}>
                                                                <div
                                                                    className={clsx(
                                                                        "px-3 py-2 text-xs font-semibold border-b flex items-center gap-2 cursor-pointer group hover:bg-opacity-80 transition-colors select-none",
                                                                        isDark ? "border-white/5 text-neutral-300 hover:bg-white/5" : "border-gray-100 text-neutral-700 hover:bg-gray-50",
                                                                        chap.isTitleMatch && (isDark ? "text-amber-400" : "text-amber-900")
                                                                    )}
                                                                    onClick={() => toggleChapterCollapse(chap.chapterId)}
                                                                >
                                                                    <ChevronDown className={clsx("w-3 h-3 transition-transform opacity-50", isChapCollapsed && "-rotate-90")} />
                                                                    <span className="opacity-70">
                                                                        {chap.chapterOrder ? formatNumber(chapFormat, chap.chapterOrder) : ''}
                                                                    </span>
                                                                    <span className="truncate flex-1">
                                                                        {chap.title || t('search.untitled')}
                                                                    </span>
                                                                    <span className="text-[10px] opacity-40 font-normal">{chap.matches.length}</span>
                                                                </div>

                                                                {!isChapCollapsed && chap.matches.length > 0 && (
                                                                    <div className="divide-y divide-gray-100/10">
                                                                        {chap.matches.map((result: SearchResult, idx: number) => (
                                                                            <button
                                                                                key={`${result.entityId}-${idx}`}
                                                                                onClick={() => handleResultClick(result)}
                                                                                className={clsx("w-full text-left px-3 py-2 transition-colors", isDark ? "hover:bg-white/5" : "hover:bg-gray-50")}
                                                                                onMouseEnter={(e) => handleMouseEnter(e, result.preview || result.snippet)}
                                                                                onMouseMove={handleMouseMove}
                                                                                onMouseLeave={handleMouseLeave}
                                                                            >
                                                                                <div className={clsx("line-clamp-2 leading-relaxed text-[10.5px]", isDark ? "text-neutral-400" : "text-neutral-500")}>
                                                                                    {renderSnippet(result.snippet)}
                                                                                </div>
                                                                            </button>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ Ideas Group ═══ */}
                {activeCategories.has('idea') && groupedResults.ideas.length > 0 && (
                    <div className="pt-2">
                        <div
                            className={clsx(
                                "flex items-center gap-2 text-xs font-bold uppercase tracking-wider mb-2 cursor-pointer group hover:opacity-80 transition-colors select-none",
                                isDark ? "text-neutral-500" : "text-neutral-400"
                            )}
                            onClick={() => setCollapsedIdeas(!collapsedIdeas)}
                        >
                            <ChevronDown className={clsx("w-3 h-3 transition-transform opacity-50", collapsedIdeas && "-rotate-90")} />
                            <Lightbulb className="w-3.5 h-3.5" />
                            <span>{t('search.ideas')} ({groupedResults.ideas.length})</span>
                        </div>

                        {!collapsedIdeas && (
                            <div className="space-y-1">
                                {groupedResults.ideas.map((result: any) => (
                                    <button
                                        key={result.entityId}
                                        onClick={() => handleResultClick(result)}
                                        className={clsx(
                                            "w-full text-left p-3 rounded-lg transition-all border",
                                            isDark ? "bg-purple-500/10 hover:bg-purple-500/20 border-purple-500/20" : "bg-purple-50 hover:bg-purple-100 border-purple-200"
                                        )}
                                        onMouseEnter={(e) => handleMouseEnter(e, result.preview || result.snippet)}
                                        onMouseMove={handleMouseMove}
                                        onMouseLeave={handleMouseLeave}
                                    >
                                        <div className={clsx("line-clamp-2 text-[10.5px]", isDark ? "text-neutral-300" : "text-neutral-600")}>
                                            {renderSnippet(result.snippet)}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ Characters Group ═══ */}
                {activeCategories.has('character') && frontendGrouped.characters.length > 0 && (
                    <div className="pt-2">
                        <div
                            className={clsx(
                                "flex items-center gap-2 text-xs font-bold uppercase tracking-wider mb-2 cursor-pointer group hover:opacity-80 transition-colors select-none",
                                isDark ? "text-neutral-500" : "text-neutral-400"
                            )}
                            onClick={() => setCollapsedCharacters(!collapsedCharacters)}
                        >
                            <ChevronDown className={clsx("w-3 h-3 transition-transform opacity-50", collapsedCharacters && "-rotate-90")} />
                            <User className="w-3.5 h-3.5" />
                            <span>{t('search.characters')} ({frontendGrouped.characters.length})</span>
                        </div>

                        {!collapsedCharacters && (
                            <div className="space-y-1">
                                {frontendGrouped.characters.map(c => (
                                    <div
                                        key={c.id}
                                        className={clsx(
                                            "p-3 rounded-lg border transition-all cursor-pointer",
                                            isDark ? "bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/15" : "bg-emerald-50 border-emerald-200 hover:bg-emerald-100"
                                        )}
                                        onClick={() => onJumpToEntity?.('character', c.id)}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className={clsx("text-xs font-semibold", isDark ? "text-emerald-300" : "text-emerald-700")}>{c.name}</span>
                                            {c.type && (
                                                <span className={clsx("text-[10px] px-1.5 py-0.5 rounded-full", isDark ? "bg-white/10 text-neutral-400" : "bg-gray-200 text-neutral-500")}>
                                                    {c.type}
                                                </span>
                                            )}
                                        </div>
                                        <div className={clsx("line-clamp-2 text-[10.5px]", isDark ? "text-neutral-400" : "text-neutral-500")}>
                                            {renderSnippet(c.snippet)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ Items Group ═══ */}
                {activeCategories.has('item') && frontendGrouped.items.length > 0 && (
                    <div className="pt-2">
                        <div
                            className={clsx(
                                "flex items-center gap-2 text-xs font-bold uppercase tracking-wider mb-2 cursor-pointer group hover:opacity-80 transition-colors select-none",
                                isDark ? "text-neutral-500" : "text-neutral-400"
                            )}
                            onClick={() => setCollapsedItems(!collapsedItems)}
                        >
                            <ChevronDown className={clsx("w-3 h-3 transition-transform opacity-50", collapsedItems && "-rotate-90")} />
                            <Package className="w-3.5 h-3.5" />
                            <span>{t('search.items')} ({frontendGrouped.items.length})</span>
                        </div>

                        {!collapsedItems && (
                            <div className="space-y-1">
                                {frontendGrouped.items.map(item => (
                                    <div
                                        key={item.id}
                                        className={clsx(
                                            "p-3 rounded-lg border transition-all cursor-pointer",
                                            isDark ? "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15" : "bg-amber-50 border-amber-200 hover:bg-amber-100"
                                        )}
                                        onClick={() => onJumpToEntity?.('item', item.id)}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className={clsx("text-xs font-semibold", isDark ? "text-amber-300" : "text-amber-700")}>{item.name}</span>
                                            {item.type && (
                                                <span className={clsx("text-[10px] px-1.5 py-0.5 rounded-full", isDark ? "bg-white/10 text-neutral-400" : "bg-gray-200 text-neutral-500")}>
                                                    {t(`world.itemTypes.${item.type}`, item.type)}
                                                </span>
                                            )}
                                        </div>
                                        <div className={clsx("line-clamp-2 text-[10.5px]", isDark ? "text-neutral-400" : "text-neutral-500")}>
                                            {renderSnippet(item.snippet)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ World Settings Group ═══ */}
                {activeCategories.has('world') && frontendGrouped.world.length > 0 && (
                    <div className="pt-2">
                        <div
                            className={clsx(
                                "flex items-center gap-2 text-xs font-bold uppercase tracking-wider mb-2 cursor-pointer group hover:opacity-80 transition-colors select-none",
                                isDark ? "text-neutral-500" : "text-neutral-400"
                            )}
                            onClick={() => setCollapsedWorld(!collapsedWorld)}
                        >
                            <ChevronDown className={clsx("w-3 h-3 transition-transform opacity-50", collapsedWorld && "-rotate-90")} />
                            <Globe className="w-3.5 h-3.5" />
                            <span>{t('search.worldSettings')} ({frontendGrouped.world.length})</span>
                        </div>

                        {!collapsedWorld && (
                            <div className="space-y-1">
                                {frontendGrouped.world.map(ws => (
                                    <div
                                        key={ws.id}
                                        className={clsx(
                                            "p-3 rounded-lg border transition-all cursor-pointer",
                                            isDark ? "bg-sky-500/10 border-sky-500/20 hover:bg-sky-500/15" : "bg-sky-50 border-sky-200 hover:bg-sky-100"
                                        )}
                                        onClick={() => onJumpToEntity?.('world', ws.id)}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className={clsx("text-xs font-semibold", isDark ? "text-sky-300" : "text-sky-700")}>{ws.name}</span>
                                            {ws.type && (
                                                <span className={clsx("text-[10px] px-1.5 py-0.5 rounded-full", isDark ? "bg-white/10 text-neutral-400" : "bg-gray-200 text-neutral-500")}>
                                                    {t(`world.settingType.${ws.type}`, ws.type)}
                                                </span>
                                            )}
                                        </div>
                                        <div className={clsx("line-clamp-2 text-[10.5px]", isDark ? "text-neutral-400" : "text-neutral-500")}>
                                            {renderSnippet(ws.snippet)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ Maps Group ═══ */}
                {activeCategories.has('map') && frontendGrouped.maps.length > 0 && (
                    <div className="pt-2">
                        <div
                            className={clsx(
                                "flex items-center gap-2 text-xs font-bold uppercase tracking-wider mb-2 cursor-pointer group hover:opacity-80 transition-colors select-none",
                                isDark ? "text-neutral-500" : "text-neutral-400"
                            )}
                            onClick={() => setCollapsedMaps(!collapsedMaps)}
                        >
                            <ChevronDown className={clsx("w-3 h-3 transition-transform opacity-50", collapsedMaps && "-rotate-90")} />
                            <Map className="w-3.5 h-3.5" />
                            <span>{t('search.maps')} ({frontendGrouped.maps.length})</span>
                        </div>

                        {!collapsedMaps && (
                            <div className="space-y-1">
                                {frontendGrouped.maps.map(map => (
                                    <div
                                        key={map.id}
                                        className={clsx(
                                            "p-3 rounded-lg border transition-all cursor-pointer",
                                            isDark ? "bg-cyan-500/10 border-cyan-500/20 hover:bg-cyan-500/15" : "bg-cyan-50 border-cyan-200 hover:bg-cyan-100"
                                        )}
                                        onClick={() => onJumpToEntity?.('map', map.id)}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className={clsx("text-xs font-semibold", isDark ? "text-cyan-300" : "text-cyan-700")}>{map.name}</span>
                                            {map.type && (
                                                <span className={clsx("text-[10px] px-1.5 py-0.5 rounded-full", isDark ? "bg-white/10 text-neutral-400" : "bg-gray-200 text-neutral-500")}>
                                                    {map.type}
                                                </span>
                                            )}
                                        </div>
                                        <div className={clsx("line-clamp-2 text-[10.5px]", isDark ? "text-neutral-400" : "text-neutral-500")}>
                                            {renderSnippet(map.snippet)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Load More (FTS5 only) */}
                {hasMore && (
                    <button
                        onClick={() => performSearch(searchQuery, false)}
                        disabled={isLoading}
                        className={clsx(
                            "w-full py-2 text-sm rounded-lg transition-colors",
                            isDark ? "text-neutral-400 hover:text-white hover:bg-white/5" : "text-neutral-500 hover:text-neutral-900 hover:bg-gray-100"
                        )}
                    >
                        {isLoading ? t('common.loading') : t('search.loadMore')}
                    </button>
                )}

                {/* Empty state */}
                {!searchQuery.trim() && (
                    <div className={clsx("flex flex-col items-center justify-center py-12 text-center space-y-2", isDark ? "text-neutral-500" : "text-neutral-400")}>
                        <Search className="w-8 h-8 opacity-30" />
                        <p className="text-sm">{t('search.hint')}</p>
                    </div>
                )}
            </div>

            {/* Portal Tooltip */}
            {tooltipData && createPortal(
                <div
                    className={clsx(
                        "fixed z-[9999] px-3 py-2 rounded shadow-lg max-w-xs text-xs pointer-events-none transition-opacity",
                        isDark ? "bg-neutral-800 text-neutral-200 border border-white/10" : "bg-white text-neutral-700 border border-gray-200"
                    )}
                    style={{
                        top: tooltipData.y,
                        left: Math.min(tooltipData.x, window.innerWidth - 320)
                    }}
                >
                    <div className="leading-relaxed whitespace-pre-wrap">{tooltipData.content}</div>
                </div>,
                document.body
            )}
        </div>
    );
}
