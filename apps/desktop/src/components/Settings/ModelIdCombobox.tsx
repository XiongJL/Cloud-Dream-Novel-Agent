import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';

export interface ModelIdOption {
    modelId: string;
    displayName: string;
    providerName: string;
    contextLabel?: string;
}

interface ModelIdComboboxProps {
    options: ModelIdOption[];
    value: string;
    onCommit: (modelId: string) => void;
    placeholder?: string;
    noResultsLabel: string;
    theme: 'dark' | 'light';
}

export function ModelIdCombobox({
    options,
    value,
    onCommit,
    placeholder,
    noResultsLabel,
    theme,
}: ModelIdComboboxProps) {
    const isDark = theme === 'dark';
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [draft, setDraft] = useState(value);
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);

    useEffect(() => {
        setDraft(value);
    }, [value]);

    const filteredOptions = useMemo(() => {
        const query = draft.trim().toLowerCase().replace(/\s+/g, '');
        if (!query || query === value.trim().toLowerCase().replace(/\s+/g, '')) return options;
        return options.filter((option) => [
            option.modelId,
            option.displayName,
            option.providerName,
        ].some((candidate) => candidate.toLowerCase().replace(/\s+/g, '').includes(query)));
    }, [draft, options, value]);

    const groupedOptions = useMemo(() => {
        const groups = new Map<string, ModelIdOption[]>();
        for (const option of filteredOptions) {
            const group = groups.get(option.providerName) || [];
            group.push(option);
            groups.set(option.providerName, group);
        }
        return [...groups.entries()];
    }, [filteredOptions]);

    const commit = (candidate: string) => {
        const modelId = candidate.trim();
        if (!modelId) {
            setDraft(value);
            setOpen(false);
            setActiveIndex(-1);
            return;
        }
        setDraft(modelId);
        setOpen(false);
        setActiveIndex(-1);
        if (modelId !== value) onCommit(modelId);
    };

    return (
        <div
            ref={containerRef}
            className="relative w-full"
            onBlur={(event) => {
                if (event.relatedTarget && containerRef.current?.contains(event.relatedTarget as Node)) return;
                commit(draft);
            }}
        >
            <div className={clsx(
                'relative w-full overflow-hidden rounded-lg border shadow-sm transition-colors focus-within:border-indigo-500',
                isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white',
            )}>
                <input
                    ref={inputRef}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={open}
                    aria-controls="ai-model-id-options"
                    aria-activedescendant={activeIndex >= 0 ? `ai-model-option-${activeIndex}` : undefined}
                    value={draft}
                    onFocus={() => setOpen(true)}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setOpen(true);
                        setActiveIndex(-1);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setOpen(true);
                            setActiveIndex((current) => Math.min(filteredOptions.length - 1, current + 1));
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setOpen(true);
                            setActiveIndex((current) => Math.max(-1, current - 1));
                        } else if (event.key === 'Enter') {
                            event.preventDefault();
                            const active = activeIndex >= 0 ? filteredOptions[activeIndex] : null;
                            commit(active?.modelId || draft);
                        } else if (event.key === 'Escape') {
                            event.preventDefault();
                            setDraft(value);
                            setOpen(false);
                            setActiveIndex(-1);
                        }
                    }}
                    placeholder={placeholder}
                    className={clsx(
                        'w-full border-none bg-transparent py-3 pl-4 pr-11 text-sm outline-none',
                        isDark ? 'text-white placeholder:text-neutral-600' : 'text-gray-900 placeholder:text-gray-400',
                    )}
                />
                <button
                    type="button"
                    aria-label="Toggle model suggestions"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                        setOpen((current) => !current);
                        inputRef.current?.focus();
                    }}
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center"
                >
                    <ChevronDown className={clsx('h-4 w-4', isDark ? 'text-neutral-400' : 'text-gray-400')} />
                </button>
            </div>

            {open ? (
                <div
                    id="ai-model-id-options"
                    role="listbox"
                    className={clsx(
                        'absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border py-1 text-sm shadow-lg',
                        isDark ? 'border-white/10 bg-[#1a1a1a]' : 'border-gray-200 bg-white',
                    )}
                >
                    {filteredOptions.length === 0 ? (
                        <div className={clsx('px-4 py-3 text-xs', isDark ? 'text-neutral-500' : 'text-gray-500')}>
                            {noResultsLabel}
                        </div>
                    ) : groupedOptions.map(([providerName, providerOptions]) => (
                        <div key={providerName}>
                            <div className={clsx(
                                'sticky top-0 z-10 px-4 py-1.5 text-[11px] font-medium uppercase',
                                isDark ? 'bg-[#1a1a1a] text-neutral-500' : 'bg-white text-gray-500',
                            )}>
                                {providerName}
                            </div>
                            {providerOptions.map((option) => {
                                const optionIndex = filteredOptions.indexOf(option);
                                const selected = option.modelId === value;
                                const active = optionIndex === activeIndex;
                                return (
                                    <button
                                        key={`${option.providerName}:${option.modelId}`}
                                        id={`ai-model-option-${optionIndex}`}
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        tabIndex={-1}
                                        onMouseDown={(event) => event.preventDefault()}
                                        onMouseEnter={() => setActiveIndex(optionIndex)}
                                        onClick={() => commit(option.modelId)}
                                        className={clsx(
                                            'relative flex min-h-12 w-full items-center gap-3 px-4 py-2 pl-10 text-left',
                                            active
                                                ? isDark ? 'bg-indigo-500/15 text-indigo-200' : 'bg-indigo-50 text-indigo-900'
                                                : isDark ? 'text-neutral-200' : 'text-gray-900',
                                        )}
                                    >
                                        {selected ? (
                                            <Check className={clsx(
                                                'absolute left-3 h-4 w-4',
                                                isDark ? 'text-indigo-300' : 'text-indigo-600',
                                            )} />
                                        ) : null}
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-mono text-sm">{option.modelId}</span>
                                            {option.displayName !== option.modelId ? (
                                                <span className={clsx(
                                                    'block truncate text-xs',
                                                    isDark ? 'text-neutral-500' : 'text-gray-500',
                                                )}>
                                                    {option.displayName}
                                                </span>
                                            ) : null}
                                        </span>
                                        {option.contextLabel ? (
                                            <span className={clsx(
                                                'shrink-0 text-xs tabular-nums',
                                                isDark ? 'text-neutral-400' : 'text-gray-500',
                                            )}>
                                                {option.contextLabel}
                                            </span>
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
