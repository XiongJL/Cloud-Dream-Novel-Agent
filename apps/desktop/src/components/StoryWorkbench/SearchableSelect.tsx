import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronDown, Search, X } from 'lucide-react';

interface Option {
    id: string;
    title: string;
    group?: string;
    [key: string]: any;
}

interface SearchableSelectProps {
    options: Option[];
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    searchPlaceholder?: string;
    theme?: 'dark' | 'light';
    className?: string;
}

export function SearchableSelect({
    options,
    value,
    onChange,
    placeholder,
    searchPlaceholder,
    theme = 'light',
    className
}: SearchableSelectProps) {
    const { t } = useTranslation();
    const isDark = theme === 'dark';
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Filter options based on search query
    const filteredOptions = useMemo(() => {
        if (!searchQuery) return options;
        const query = searchQuery.toLowerCase();
        return options.filter(opt =>
            opt.title.toLowerCase().includes(query) ||
            (opt.order !== undefined && String(opt.order).includes(query))
        );
    }, [options, searchQuery]);

    const selectedOption = options.find(o => o.id === value);

    const handleSelect = (id: string) => {
        onChange(id);
        setIsOpen(false);
        setSearchQuery('');
    };

    const handleClear = (e: React.MouseEvent) => {
        e.stopPropagation();
        onChange('');
        setSearchQuery('');
    };

    // When opening, verify focus on input
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    return (
        <div className={clsx("relative", className)} ref={containerRef}>
            {/* Trigger / Display */}
            <div
                onClick={() => setIsOpen(!isOpen)}
                className={clsx(
                    "w-full px-3 py-2 rounded text-sm border flex items-center justify-between cursor-pointer transition-colors",
                    isDark
                        ? "bg-black/20 border-white/10 hover:border-white/20"
                        : "bg-gray-50 border-gray-200 hover:border-gray-300",
                    isOpen && "ring-2 ring-purple-500/50 border-purple-500"
                )}
            >
                <span className={clsx("truncate pr-2", !selectedOption && "opacity-50")}>
                    {selectedOption ? selectedOption.title : (placeholder || t('common.select', 'Select...'))}
                </span>

                <div className="flex items-center gap-1">
                    {value && (
                        <div
                            onClick={handleClear}
                            className="p-0.5 rounded-full hover:bg-neutral-500/20 opacity-50 hover:opacity-100 transition-colors"
                        >
                            <X className="w-3 h-3" />
                        </div>
                    )}
                    <ChevronDown className={clsx("w-4 h-4 opacity-50 transition-transform", isOpen && "rotate-180")} />
                </div>
            </div>

            {/* Dropdown */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 5 }}
                        transition={{ duration: 0.1 }}
                        className={clsx(
                            "absolute z-50 w-full mt-1 rounded-lg border shadow-xl overflow-hidden flex flex-col max-h-60",
                            isDark ? "bg-neutral-800 border-white/10" : "bg-white border-gray-200"
                        )}
                    >
                        {/* Search Input */}
                        <div className={clsx("p-2 border-b", isDark ? "border-white/5" : "border-gray-100")}>
                            <div className="relative">
                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 opacity-50" />
                                <input
                                    ref={inputRef}
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder={searchPlaceholder || t('common.search', 'Search...')}
                                    className={clsx(
                                        "w-full pl-8 pr-2 py-1.5 text-xs rounded outline-none bg-transparent",
                                        isDark ? "text-white placeholder-white/30" : "text-black placeholder-gray-400"
                                    )}
                                    onClick={(e) => e.stopPropagation()}
                                />
                            </div>
                        </div>

                        {/* Options List */}
                        {filteredOptions.length === 0 ? (
                            <div className="p-4 text-center text-xs opacity-50">
                                {t('search.noResults', 'No results found')}
                            </div>
                        ) : (
                            <VirtualizedList
                                options={filteredOptions}
                                onSelect={handleSelect}
                                value={value}
                                isDark={isDark}
                            />
                        )}

                    </motion.div>
                )}
            </AnimatePresence>
        </div >
    );
}

// Virtualized List Helper
const VirtualizedList = ({ options, onSelect, value, isDark }: {
    options: Option[],
    onSelect: (id: string) => void,
    value: string,
    isDark: boolean
}) => {
    const { t } = useTranslation();
    // Flatten options with headers
    const flatItems = useMemo(() => {
        const items: ({ type: 'header', title: string } | { type: 'option', data: Option })[] = [];
        options.forEach((opt, index) => {
            if (opt.group && (index === 0 || opt.group !== options[index - 1].group)) {
                items.push({ type: 'header', title: opt.group });
            }
            items.push({ type: 'option', data: opt });
        });
        return items;
    }, [options]);



    // We use a simple fixed height estimation for virtualization to keep it lightweight
    // Ideally we would use a dynamic size map, but for now we assume average height or just fixed
    // Actually, distinct heights make simple math hard.
    // Let's assume fixed height for simplicity for this "lite" version, or use a map.
    // To be robust without deps, let's use a simple "render all but hidden" approach or just pagination.
    // User requested optimization for 3000 items. Pagination is safest without `react-window`.
    // Let's implement "Load More" / Infinite Scroll which is easier than full virtualization from scratch.

    const [visibleCount, setVisibleCount] = useState(50);
    const visibleItems = flatItems.slice(0, visibleCount);

    const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
        if (scrollHeight - scrollTop - clientHeight < 100) {
            setVisibleCount(prev => Math.min(prev + 50, flatItems.length));
        }
    };

    return (
        <div
            className="overflow-y-auto overflow-x-hidden flex-1 p-1 max-h-60"
            onScroll={onScroll}
        >
            {visibleItems.map((item, index) => {
                if (item.type === 'header') {
                    return (
                        <div key={`group-${item.title}-${index}`} className={clsx(
                            "px-2 py-1 text-xs font-bold sticky top-0 z-10 shadow-sm",
                            isDark ? "bg-[#1f1f24] text-neutral-400 border-b border-white/5" : "bg-gray-50 text-neutral-500 border-b border-gray-100"
                        )}>
                            {item.title}
                        </div>
                    );
                }
                const opt = item.data;
                return (
                    <div
                        key={opt.id}
                        onClick={() => onSelect(opt.id)}
                        className={clsx(
                            "px-3 py-2 text-sm rounded cursor-pointer flex items-center justify-between group transition-colors",
                            value === opt.id
                                ? (isDark ? "bg-purple-500/20 text-purple-300" : "bg-purple-50 text-purple-700")
                                : "hover:bg-neutral-500/10"
                        )}
                    >
                        <span className="truncate">{opt.title}</span>
                        {value === opt.id && <Check className="w-3.5 h-3.5 shrink-0" />}
                    </div>
                );
            })}
            {visibleCount < flatItems.length && (
                <div className="p-2 text-center text-xs opacity-50">{t('common.loading')}</div>
            )}
        </div>
    );
};


// Add display name
SearchableSelect.displayName = 'SearchableSelect';
