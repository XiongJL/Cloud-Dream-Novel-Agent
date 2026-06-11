import { useState, useEffect, useRef, useMemo } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { clsx } from 'clsx';
import { PlotPoint, PlotPointAnchor, Volume, PlotLine } from '../../types';
import { SearchableSelect } from './SearchableSelect';
import { formatNumber } from '../../utils/format';
import { BaseModal } from '../ui/BaseModal';
import { ConfirmModal } from '../ui/ConfirmModal';
import { IconPicker } from '../ui/IconPicker';
import { EntityInfoCard } from './EntityInfoCard';

interface PlotPointModalProps {
    isOpen: boolean;
    onClose: () => void;
    point: PlotPoint | null;
    isCreateMode?: boolean;
    initialData?: {
        novelId: string;
        description?: string;
        title?: string;
        chapterId?: string;
        plotLineId?: string;
    };

    onSave: (id: string, data: Partial<PlotPoint>) => Promise<void>;

    onCreate?: (data: Partial<PlotPoint>, initialChapterId?: string) => Promise<void>;

    onAddAnchor: (data: Partial<PlotPointAnchor>) => Promise<any>;
    onRemoveAnchor: (id: string, plotPointId: string) => Promise<void>;
    onDelete?: (id: string) => Promise<void>;
    theme: 'dark' | 'light';
    formatting?: string;
    volumes?: Volume[];
    plotLines?: PlotLine[];
}

export function PlotPointModal({
    isOpen,
    onClose,
    point,
    onSave,
    onCreate,
    onAddAnchor,
    onRemoveAnchor,
    onDelete,
    theme,
    isCreateMode,
    initialData,
    formatting,
    volumes = [],
    plotLines: externalPlotLines = []
}: PlotPointModalProps) {
    const { t } = useTranslation();
    const isDark = theme === 'dark';

    const titleRef = useRef<HTMLInputElement>(null);
    const descriptionRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (isOpen && point) {
            setType(point.type || 'foreshadowing');
            setStatus(point.status || 'active');
            setDescription(point.description || '');
        } else if (isOpen && initialData) {
            setDescription(initialData.description || '');
            if (initialData.title && titleRef.current) titleRef.current.value = initialData.title;
        }
    }, [isOpen, point, initialData]);
    const [type, setType] = useState('foreshadowing');
    const [status, setStatus] = useState('active');
    const [icon, setIcon] = useState<string | null>(null);
    const [description, setDescription] = useState('');
    const [selectedPlotLineId, setSelectedPlotLineId] = useState<string>('');

    // Mention system states
    type MentionItemType = 'character' | 'item' | 'world' | 'map';
    const [mentionSearch, setMentionSearch] = useState<string | null>(null);
    const [mentionPosition, setMentionPosition] = useState<{ top: number; left: number } | null>(null);
    const [mentionList, setMentionList] = useState<{ id: string; name: string; type: MentionItemType }[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [mentionFilter, setMentionFilter] = useState<'all' | MentionItemType>('all');

    // Entity Dossier States
    const [activeEntity, setActiveEntity] = useState<any>(null);
    const [entityType, setEntityType] = useState<'character' | 'item'>('character');
    const [entityPosition, setEntityPosition] = useState<{ top: number; left: number } | null>(null);

    // Fetch characters, items, world settings, and maps for mentions
    const [allMentionables, setAllMentionables] = useState<{ id: string; name: string; type: MentionItemType }[]>([]);

    const MENTION_ICON_MAP: Record<MentionItemType, string> = {
        character: '👤',
        item: '📦',
        world: '🌐',
        map: '🗺️',
    };

    const MENTION_FILTER_TABS: { key: 'all' | MentionItemType; label: string }[] = [
        { key: 'all', label: t('search.category.all', '全部') },
        { key: 'character', label: t('search.category.character', '角色') },
        { key: 'item', label: t('search.category.item', '物品') },
        { key: 'world', label: t('search.category.world', '世界观') },
        { key: 'map', label: t('search.category.map', '地图') },
    ];

    useEffect(() => {
        if (!isOpen) return;
        const load = async () => {
            try {
                const novelId = initialData?.novelId || point?.novelId || '';
                const [chars, items, worldSettings, maps] = await Promise.all([
                    window.db.getCharacters(novelId),
                    window.db.getItems(novelId),
                    window.db.getWorldSettings(novelId),
                    window.db.getMaps(novelId),
                ]);
                setAllMentionables([
                    ...chars.map((c: any) => ({ id: c.id, name: c.name, type: 'character' as const })),
                    ...items.map((i: any) => ({ id: i.id, name: i.name, type: 'item' as const })),
                    ...worldSettings.map((ws: any) => ({ id: ws.id, name: ws.name, type: 'world' as const })),
                    ...maps.map((m: any) => ({ id: m.id, name: m.name, type: 'map' as const })),
                ]);
            } catch (err) {
                console.error('Failed to load mentionables:', err);
            }
        };
        load();
    }, [isOpen, initialData?.novelId, point?.novelId]);

    useEffect(() => {
        if (mentionSearch === null) {
            setMentionList([]);
            return;
        }
        const query = mentionSearch.toLowerCase();

        // 性能优化：限制展示数量，匹配优先级排序
        const filtered = allMentionables
            .filter(item => {
                const nameMatch = item.name.toLowerCase().includes(query);
                const filterMatch = mentionFilter === 'all' || item.type === mentionFilter;
                return nameMatch && filterMatch;
            })
            .sort((a, b) => {
                const aName = a.name.toLowerCase();
                const bName = b.name.toLowerCase();
                // 完全匹配优先
                if (aName === query) return -1;
                if (bName === query) return 1;
                // 前缀匹配优先
                if (aName.startsWith(query) && !bName.startsWith(query)) return -1;
                if (bName.startsWith(query) && !aName.startsWith(query)) return 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 10);

        setMentionList(filtered);
        setSelectedIndex(0);
    }, [mentionSearch, allMentionables, mentionFilter]);

    const handleTextareaInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
        const textarea = e.currentTarget;
        const val = textarea.value;
        setDescription(val);
        const pos = textarea.selectionStart;

        const textBefore = val.slice(0, pos);
        const lastAtMatch = textBefore.match(/@([^\s@]*)$/);

        if (lastAtMatch) {
            const query = lastAtMatch[1];
            setMentionSearch(query);
            setMentionFilter('all');

            // --- 精准坐标计算 (Mirror Div) ---
            const rect = textarea.getBoundingClientRect();
            const div = document.createElement('div');
            const style = window.getComputedStyle(textarea);

            const stylesToCopy = [
                'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'padding',
                'borderWidth', 'boxSizing', 'width', 'letterSpacing', 'wordBreak'
            ];
            stylesToCopy.forEach(key => (div.style[key as any] = style[key as any]));

            div.style.position = 'absolute';
            div.style.visibility = 'hidden';
            div.style.whiteSpace = 'pre-wrap';

            div.textContent = textBefore;
            const span = document.createElement('span');
            span.textContent = lastAtMatch[0] || '@';
            div.appendChild(span);

            document.body.appendChild(div);
            const { offsetTop, offsetLeft } = span;
            document.body.removeChild(div);

            setMentionPosition({
                top: rect.top + offsetTop + parseInt(style.fontSize) - textarea.scrollTop,
                left: rect.left + offsetLeft
            });
        } else {
            setMentionSearch(null);
            setMentionPosition(null);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (mentionSearch !== null && mentionList.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex(prev => (prev + 1) % mentionList.length);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex(prev => (prev - 1 + mentionList.length) % mentionList.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(mentionList[selectedIndex]);
            } else if (e.key === 'Escape') {
                setMentionSearch(null);
                setMentionPosition(null);
            }
        }
    };

    const insertMention = (item: { name: string }) => {
        const textarea = descriptionRef.current;
        if (!textarea) return;

        const val = textarea.value;
        const pos = textarea.selectionStart;
        const textBefore = val.slice(0, pos);
        const textAfter = val.slice(pos);

        const lastAtIndex = textBefore.lastIndexOf('@');
        const newVal = textBefore.slice(0, lastAtIndex) + `@${item.name} ` + textAfter;

        textarea.value = newVal;
        setDescription(newVal);
        setMentionSearch(null);
        setMentionPosition(null);

        // Restore focus and cursor
        const newPos = lastAtIndex + item.name.length + 2;
        textarea.focus();
        // 触发 input 事件以同步状态
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        setTimeout(() => {
            textarea.setSelectionRange(newPos, newPos);
        }, 0);
    };

    const handleTextareaClick = async (e: React.MouseEvent<HTMLTextAreaElement>) => {
        const textarea = e.currentTarget;
        const pos = textarea.selectionStart;
        const val = textarea.value;

        // 识别点击位点所在的单词是否是 @Mention
        const mentionRegex = /@([^\s@]+)/g;
        let match;
        let hitMention = false;
        while ((match = mentionRegex.exec(val)) !== null) {
            const start = match.index;
            const end = start + match[0].length;

            if (pos >= start && pos <= end) {
                const name = match[1];
                const item = allMentionables.find(m => m.name === name);
                if (item) {
                    hitMention = true;
                    // Only show entity card for character and item types
                    if (item.type === 'character' || item.type === 'item') {
                        try {
                            let fullData;
                            if (item.type === 'character') {
                                fullData = await window.db.getCharacter(item.id);
                            } else {
                                fullData = await window.db.getItem(item.id);
                            }

                            setActiveEntity(fullData);
                            setEntityType(item.type);
                            setEntityPosition({ top: e.clientY + 10, left: e.clientX + 10 });
                        } catch (err) {
                            console.error('Failed to fetch entity details:', err);
                        }
                    }
                }
                break;
            }
        }

        if (!hitMention) {
            setActiveEntity(null);
        }
    };

    // 背景渲染层逻辑：实现原生输入框的高亮
    const renderBackdrop = (text: string) => {
        const mentionRegex = /(@[^\s@]+)/g;
        const parts = text.split(mentionRegex);
        return (
            <div
                className={clsx(
                    "whitespace-pre-wrap break-words text-sm leading-relaxed p-2 pointer-events-none select-none",
                    isDark ? "text-neutral-300" : "text-gray-800"
                )}
                style={{ fontFamily: 'inherit' }}
            >
                {parts.map((part, i) => {
                    if (part.startsWith('@')) {
                        return (
                            <span key={i} className={clsx(
                                "rounded-[3px] transition-colors font-medium",
                                isDark
                                    ? "bg-indigo-500/25 text-indigo-300"
                                    : "bg-indigo-100 text-indigo-700 shadow-[0_0_0_1px_rgba(99,102,241,0.1)]"
                            )}>
                                {part}
                            </span>
                        );
                    }
                    return <span key={i}>{part}</span>;
                })}
                {/* 最后一个空字符，确保换行对齐 */}
                {text.endsWith('\n') && <br />}
            </div>
        );
    };

    // Auto-close EntityInfoCard when clicking elsewhere
    useEffect(() => {
        if (!activeEntity) return;
        const handleCardBlur = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            // 如果点击的不是卡片内部，也不是 textarea，则关闭
            if (!target.closest('.entity-info-card') && !target.closest('textarea')) {
                setActiveEntity(null);
            }
        };
        document.addEventListener('mousedown', handleCardBlur);
        return () => document.removeEventListener('mousedown', handleCardBlur);
    }, [activeEntity]);

    const [selectedChapterId, setSelectedChapterId] = useState<string>('');
    const [originalAnchorId, setOriginalAnchorId] = useState<string | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const formattedChapters = useMemo(() => {
        if (!isOpen) return [];

        const flatChapters: { id: string, title: string, order: number, group: string }[] = [];
        const formatConfig = formatting ? JSON.parse(formatting) : {};
        const chapFormat = formatConfig.chapter || t('common.chapterPrefix', '第') + '{n}' + t('common.chapterSuffix', '章');
        const volFormat = formatConfig.volume || t('common.volumePrefix', '第') + '{n}' + t('common.volumeSuffix', '卷');

        volumes.forEach(v => {
            const volumeTitle = `${formatNumber(volFormat, v.order)} ${v.title || ''}`.trim();
            v.chapters.forEach(c => {
                const chapterTitle = `${formatNumber(chapFormat, c.order)} ${c.title}`;
                flatChapters.push({
                    id: c.id,
                    title: chapterTitle,
                    order: c.order,
                    group: volumeTitle
                });
            });
        });
        return flatChapters;
    }, [volumes, formatting, t, isOpen]);

    const memoizedPlotLines = useMemo(() => {
        return externalPlotLines.map(l => ({ id: l.id, name: l.name, color: l.color }));
    }, [externalPlotLines]);

    useEffect(() => {
        if (!isOpen) return;

        requestAnimationFrame(() => {
            if (isCreateMode && initialData) {
                if (titleRef.current) titleRef.current.value = initialData.title || t('plot.defaultTitle', 'Plot Point Title');
                if (descriptionRef.current) descriptionRef.current.value = initialData.description || '';

                setType('foreshadowing');
                setStatus('active');
                setSelectedChapterId(initialData.chapterId || '');
                setSelectedPlotLineId(initialData.plotLineId || (memoizedPlotLines[0]?.id || ''));
                setOriginalAnchorId(null);
            } else if (point) {
                if (titleRef.current) titleRef.current.value = point.title || '';
                if (descriptionRef.current) descriptionRef.current.value = point.description || '';

                setType(point.type || 'foreshadowing');
                setStatus(point.status || 'active');
                setIcon(point.icon || null);

                const anchor = point.anchors?.find(a => a.chapterId);
                if (anchor) {
                    setSelectedChapterId(anchor.chapterId);
                    setOriginalAnchorId(anchor.id);
                } else {
                    setSelectedChapterId('');
                    setOriginalAnchorId(null);
                }
            }

            titleRef.current?.focus();
        });
    }, [isOpen, isCreateMode, point, initialData, memoizedPlotLines, t]);

    const handleSave = async () => {
        const currentTitle = titleRef.current?.value || '';

        if (isCreateMode) {
            if (!onCreate) return;
            if (!selectedPlotLineId) return;

            await onCreate({
                plotLineId: selectedPlotLineId,
                title: currentTitle,
                description: description,
                type,
                status,
                icon: icon || undefined
            }, selectedChapterId);
        } else {
            if (!point) return;
            const data = {
                title: currentTitle,
                description: description,
                type,
                status,
                icon
            };
            await onSave(point.id, data);

            if (selectedChapterId) {
                if (!originalAnchorId) {
                    await onAddAnchor({ plotPointId: point.id, chapterId: selectedChapterId, type: 'setup' });
                } else {
                    const oldAnchor = point.anchors?.find(a => a.id === originalAnchorId);
                    if (oldAnchor && oldAnchor.chapterId !== selectedChapterId) {
                        await onRemoveAnchor(originalAnchorId, point.id);
                        await onAddAnchor({ plotPointId: point.id, chapterId: selectedChapterId, type: 'setup' });
                    }
                }
            } else {
                if (originalAnchorId) {
                    await onRemoveAnchor(originalAnchorId, point.id);
                }
            }
        }
        toast.success(t('plot.saveSuccess'));
        onClose();
    };

    const backdropRef = useRef<HTMLDivElement>(null);

    const handleScroll = () => {
        if (descriptionRef.current && backdropRef.current) {
            backdropRef.current.scrollTop = descriptionRef.current.scrollTop;
        }
    };

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            theme={theme}
            title={isCreateMode ? t('plot.addPoint') : t('plot.editPoint')}
        >
            <div className="flex-1 overflow-y-auto pr-1 space-y-4 custom-scrollbar">
                {isCreateMode && (
                    <div>
                        <label className="block text-xs font-medium uppercase opacity-50 mb-1">{t('plot.plotLine')}</label>
                        <select
                            value={selectedPlotLineId}
                            onChange={(e) => setSelectedPlotLineId(e.target.value)}
                            className={clsx(
                                "w-full p-2 rounded-lg text-sm outline-none border transition-colors focus:border-indigo-500",
                                isDark ? "bg-black/50 border-white/10" : "bg-gray-50 border-gray-200"
                            )}
                        >
                            {memoizedPlotLines.map(l => (
                                <option key={l.id} value={l.id}>{l.name}</option>
                            ))}
                            {memoizedPlotLines.length === 0 && <option value="">{t('plot.noPlotLines', 'No Plot Lines')}</option>}
                        </select>
                    </div>
                )}



                <div className="flex gap-4">
                    <div className="flex-shrink-0">
                        <label className="block text-xs font-medium uppercase opacity-50 mb-1">{t('common.icon', 'Icon')}</label>
                        <IconPicker
                            value={icon}
                            onChange={setIcon}
                            theme={theme}
                        />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-medium uppercase opacity-50 mb-1">{t('common.title')}</label>
                        <input
                            ref={titleRef}
                            spellCheck={false}
                            className={clsx(
                                "w-full p-2 rounded-lg text-sm outline-none border transition-colors focus:border-indigo-500",
                                isDark ? "bg-black/50 border-white/10" : "bg-gray-50 border-gray-200"
                            )}
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-xs font-medium uppercase opacity-50 mb-1">{t('common.chapter')}</label>
                    <SearchableSelect
                        options={formattedChapters}
                        value={selectedChapterId}
                        onChange={setSelectedChapterId}
                        placeholder={t('plot.selectChapter', 'Select Chapter...')}
                        searchPlaceholder={t('common.search', 'Search...')}
                        theme={theme}
                    />
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-medium uppercase opacity-50 mb-1">{t('plot.type')}</label>
                        <select
                            value={type}
                            onChange={(e) => setType(e.target.value)}
                            className={clsx(
                                "w-full p-2 rounded-lg text-sm outline-none border transition-colors focus:border-indigo-500",
                                isDark ? "bg-black/50 border-white/10" : "bg-gray-50 border-gray-200"
                            )}
                        >
                            <option value="foreshadowing">{t('plot.types.foreshadowing')}</option>
                            <option value="mystery">{t('plot.types.mystery')}</option>
                            <option value="promise">{t('plot.types.promise')}</option>
                            <option value="event">{t('plot.types.event')}</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-xs font-medium uppercase opacity-50 mb-1">{t('plot.status')}</label>
                        <div className={clsx("flex rounded-lg p-1 border", isDark ? "bg-black/50 border-white/5" : "bg-gray-50 border-gray-200")}>
                            <button
                                onClick={() => setStatus('active')}
                                className={clsx(
                                    "flex-1 text-xs py-1.5 rounded-md transition-all font-medium",
                                    status === 'active' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "opacity-50 hover:opacity-100"
                                )}
                            >
                                {t('plot.statuses.active')}
                            </button>
                            <button
                                onClick={() => setStatus('resolved')}
                                className={clsx(
                                    "flex-1 text-xs py-1.5 rounded-md transition-all font-medium",
                                    status === 'resolved' ? "bg-green-600 text-white shadow-lg shadow-green-500/20" : "opacity-50 hover:opacity-100"
                                )}
                            >
                                {t('plot.statuses.resolved')}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="relative">
                    <label className="block text-xs font-medium uppercase opacity-50 mb-1">{t('common.description')}</label>
                    <div className="relative w-full rounded-lg border overflow-hidden transition-colors focus-within:border-indigo-500 min-h-[120px]">
                        {/* 背景高亮层 */}
                        <div
                            ref={backdropRef}
                            className="absolute inset-0 pointer-events-none overflow-hidden pb-8"
                        >
                            {renderBackdrop(description)}
                        </div>

                        {/* 真正的输入框 */}
                        <textarea
                            ref={descriptionRef}
                            rows={5}
                            spellCheck={false}
                            value={description}
                            onInput={handleTextareaInput}
                            onKeyDown={handleKeyDown}
                            onClick={handleTextareaClick}
                            onScroll={handleScroll}
                            className={clsx(
                                "relative w-full p-2 pb-8 text-sm leading-relaxed outline-none border-none resize-none min-h-[120px] bg-transparent flex-1",
                                "text-transparent caret-indigo-500", // 让原生文字透明，但保留光标可见
                                isDark ? "placeholder:text-white/20" : "placeholder:text-gray-400"
                            )}
                            placeholder={t('plot.descriptionPlaceholder')}
                        />
                    </div>

                    {activeEntity && entityPosition && (
                        <EntityInfoCard
                            entity={activeEntity}
                            type={entityType}
                            isDark={isDark}
                            position={entityPosition}
                            onClose={() => setActiveEntity(null)}
                        />
                    )}

                    {mentionSearch !== null && mentionPosition && (
                        <div
                            className={clsx(
                                "fixed z-[60] min-w-[200px] max-w-[300px] max-h-[280px] overflow-y-auto rounded-lg border shadow-xl custom-scrollbar",
                                isDark ? "bg-neutral-900 border-white/10 shadow-black/50" : "bg-white border-gray-200 shadow-gray-200/50"
                            )}
                            style={{
                                top: mentionPosition.top,
                                left: Math.min(mentionPosition.left, window.innerWidth - 220)
                            }}
                        >
                            {/* Category filter tabs */}
                            <div className={clsx(
                                "flex gap-1 px-2 py-1.5 border-b flex-wrap",
                                isDark ? "border-white/8" : "border-gray-100"
                            )}>
                                {MENTION_FILTER_TABS.map(tab => (
                                    <button
                                        key={tab.key}
                                        onMouseDown={(e) => { e.preventDefault(); setMentionFilter(tab.key); }}
                                        className={clsx(
                                            "px-2 py-0.5 text-[10px] rounded-md font-medium transition-colors",
                                            mentionFilter === tab.key
                                                ? "bg-indigo-600 text-white"
                                                : (isDark ? "text-neutral-500 hover:bg-white/5" : "text-neutral-400 hover:bg-gray-100")
                                        )}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                            {/* Results */}
                            <div className="py-1">
                                {mentionList.length === 0 ? (
                                    <div className={clsx("px-3 py-3 text-center text-xs", isDark ? "text-neutral-600" : "text-neutral-400")}>
                                        {t('common.noResults', '无匹配结果')}
                                    </div>
                                ) : (
                                    mentionList.map((item, idx) => (
                                        <button
                                            key={item.id}
                                            onClick={() => insertMention(item)}
                                            className={clsx(
                                                "w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors",
                                                idx === selectedIndex
                                                    ? (isDark ? "bg-indigo-500/20 text-indigo-300" : "bg-indigo-50 text-indigo-600")
                                                    : (isDark ? "hover:bg-white/5 text-neutral-400" : "hover:bg-gray-50 text-gray-700")
                                            )}
                                        >
                                            <span className="opacity-60">{MENTION_ICON_MAP[item.type]}</span>
                                            <span className="truncate">{item.name}</span>
                                        </button>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>



            <div className={clsx("mt-6 flex items-center pt-4 border-t", isDark ? "border-white/5" : "border-gray-100", (!isCreateMode && point) ? "justify-between" : "justify-end")}>
                {!isCreateMode && point && (
                    <button
                        onClick={() => setShowDeleteConfirm(true)}
                        className={clsx(
                            "flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors",
                            isDark ? "text-red-400 hover:bg-red-500/10" : "text-red-500 hover:bg-red-50"
                        )}
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        {t('common.delete')}
                    </button>
                )}

                <div className="flex gap-2">
                    <button
                        onClick={onClose}
                        className={clsx(
                            "text-xs px-4 py-1.5 rounded-lg transition-colors font-medium",
                            isDark ? "text-neutral-400 hover:bg-white/5" : "text-neutral-500 hover:bg-gray-100"
                        )}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex items-center gap-1.5 text-xs px-6 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 transition-all text-white font-medium shadow-md shadow-indigo-500/20 active:scale-95"
                    >
                        <Check className="w-4 h-4" />
                        {t('common.save')}
                    </button>
                </div>
            </div>

            <ConfirmModal
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={async () => {
                    if (point && onDelete) {
                        await onDelete(point.id);
                        onClose();
                    }
                }}
                title={t('plot.deletePoint')}
                message={t('plot.confirmDeletePoint')}
                theme={isDark ? 'dark' : 'light'}
            />
        </BaseModal >
    );
}
