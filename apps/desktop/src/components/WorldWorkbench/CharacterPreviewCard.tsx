import React, { useEffect, useState, useRef } from 'react';
import { Character, Item } from '../../types';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import { X, Edit, User, Box, MapPin, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getAvatarColors } from '../../utils/avatarUtils';
import { useTranslation } from 'react-i18next';

interface CharacterPreviewCardProps {
    id: string;
    type: 'character' | 'item';
    position: { top: number; left: number };
    onClose: () => void;
    theme: 'light' | 'dark';
    onEdit?: () => void; // Optional: Trigger edit mode in workbench
}

export const CharacterPreviewCard: React.FC<CharacterPreviewCardProps> = ({
    id,
    type,
    position,
    onClose,
    theme,
    onEdit
}) => {
    const [data, setData] = useState<Character | Item | null>(null);
    const [loading, setLoading] = useState(true);
    const cardRef = useRef<HTMLDivElement>(null);
    const isDark = theme === 'dark';
    const { t } = useTranslation();

    useEffect(() => {
        let mounted = true;
        setLoading(true);

        const fetchData = async () => {
            try {
                if (type === 'character') {
                    const char = await window.db.getCharacter(id);
                    if (mounted) setData(char);
                } else {
                    const item = await window.db.getItem(id);
                    if (mounted) setData(item);
                }
            } catch (e) {
                console.error('Failed to fetch preview data', e);
            } finally {
                if (mounted) setLoading(false);
            }
        };

        fetchData();
        return () => { mounted = false; };
    }, [id, type]);

    // Handle click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (cardRef.current && !cardRef.current.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    // Calculate position to keep within viewport
    // Ideally we'd use useLayoutEffect or a library like floating-ui, but simple check is fine
    const style = {
        top: position.top,
        left: position.left,
    };

    // Adjust if near right edge (simplified)
    if (window.innerWidth - position.left < 320) {
        style.left = window.innerWidth - 330;
    }

    if (loading) {
        return createPortal(
            <div
                ref={cardRef}
                style={style}
                className={clsx(
                    "fixed z-[10000] w-80 p-4 rounded-xl shadow-2xl border",
                    isDark ? "bg-[#1a1a20] border-white/10" : "bg-white border-gray-200"
                )}
            >
                <div className="animate-pulse flex space-x-4">
                    <div className={clsx("rounded-full h-12 w-12", isDark ? "bg-white/10" : "bg-gray-200")}></div>
                    <div className="flex-1 space-y-4 py-1">
                        <div className={clsx("h-4 rounded w-3/4", isDark ? "bg-white/10" : "bg-gray-200")}></div>
                        <div className={clsx("h-4 rounded w-1/2", isDark ? "bg-white/10" : "bg-gray-200")}></div>
                    </div>
                </div>
            </div>,
            document.body
        );
    }

    if (!data) return null;

    const profile = data.profile ? JSON.parse(data.profile) : {};

    // Icon based on type
    const getIcon = () => {
        if (type === 'character') return <User className="w-5 h-5" />;
        const item = data as Item;
        if (item.type === 'skill') return <Zap className="w-5 h-5" />;
        if (item.type === 'location') return <MapPin className="w-5 h-5" />;
        return <Box className="w-5 h-5" />;
    };

    const getTypeLabel = () => {
        if (type === 'character') return (data as Character).role || t('world.characters');
        const item = data as Item;
        if (item.type === 'skill') return t('world.itemTypes.skill');
        if (item.type === 'location') return t('world.itemTypes.location');
        return t('world.items');
    };

    return createPortal(
        <AnimatePresence>
            <motion.div
                ref={cardRef}
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                style={style}
                className={clsx(
                    "fixed z-[10000] w-80 rounded-xl shadow-2xl border flex flex-col overflow-hidden font-sans",
                    isDark ? "bg-[#1a1a20] border-white/10 text-white" : "bg-white border-gray-200 text-gray-900"
                )}
            >
                {/* Header with Avatar/Icon */}
                <div className={clsx("p-4 border-b flex items-start gap-3", isDark ? "border-white/5" : "border-gray-100")}>
                    <div className={clsx(
                        "w-12 h-12 rounded-full flex items-center justify-center text-xl shadow-sm shrink-0 overflow-hidden bg-gradient-to-br",
                        type === 'character'
                            ? (() => { const c = getAvatarColors(data.id || '', data.name, isDark); return `${c[0]} ${c[1]} ${c[2]}`; })()
                            : "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                    )}>
                        {type === 'character' && (data as any).avatar ? (
                            <img src={`local-resource://${(data as any).avatar}`} alt={data.name} className="w-full h-full object-cover rounded-full" />
                        ) : (
                            data.name[0]?.toUpperCase()
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-lg leading-tight truncate">{data.name}</h3>
                        <div className="flex items-center gap-2 mt-1 text-xs opacity-70">
                            <span className="flex items-center gap-1">
                                {getIcon()}
                                {getTypeLabel()}
                            </span>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className={clsx("p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors")}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body: Description & Attributes */}
                <div className="p-4 max-h-[300px] overflow-y-auto">
                    {data.description && (
                        <p className="text-sm opacity-80 mb-4 whitespace-pre-wrap leading-relaxed">
                            {data.description}
                        </p>
                    )}

                    {/* Custom Attributes */}
                    {Object.keys(profile).length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-xs font-semibold opacity-50 uppercase tracking-wider mb-2">{t('world.customAttrs')}</h4>
                            {Object.entries(profile).map(([key, value]) => (
                                <div key={key} className="flex justify-between text-sm py-1 border-b border-black/5 dark:border-white/5 last:border-0">
                                    <span className="opacity-70">{key}</span>
                                    <span className="font-medium">{String(value)}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Full Body Image Preview (first image for character) */}
                    {type === 'character' && (() => {
                        const char = data as Character;
                        try {
                            const imgs = JSON.parse(char.fullBodyImages || '[]');
                            if (imgs.length > 0) {
                                return (
                                    <div className="mb-4">
                                        <img
                                            src={`local-resource://${imgs[0]}`}
                                            alt={char.name}
                                            className={clsx("w-full max-h-40 object-contain rounded-lg border",
                                                isDark ? "border-white/10" : "border-gray-200"
                                            )}
                                        />
                                    </div>
                                );
                            }
                        } catch { }
                        return null;
                    })()}

                    {/* Items possessed (for Character) */}
                    {type === 'character' && (data as Character).items && (data as Character).items!.length > 0 && (
                        <div className="mt-4">
                            <h4 className="text-xs font-semibold opacity-50 uppercase tracking-wider mb-2">{t('world.inventory')}</h4>
                            <div className="flex flex-wrap gap-2">
                                {(data as Character).items!.map(ownership => (
                                    <span key={ownership.id} className={clsx(
                                        "text-xs px-2 py-1 rounded border flex items-center gap-1",
                                        isDark ? "bg-white/5 border-white/10" : "bg-gray-100 border-gray-200"
                                    )}>
                                        {ownership.item.type === 'skill' ? '⚡' : '📦'} {ownership.item.name}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer: Actions */}
                <div className={clsx("p-3 border-t bg-gray-50/50 dark:bg-white/5 flex justify-end", isDark ? "border-white/5" : "border-gray-100")}>
                    {onEdit && (
                        <button
                            onClick={onEdit}
                            className={clsx(
                                "flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-colors",
                                "hover:bg-indigo-50 text-indigo-600 dark:hover:bg-indigo-900/30 dark:text-indigo-400"
                            )}
                        >
                            <Edit className="w-3.5 h-3.5" />
                            {type === 'character' ? t('world.editCharacter') : t('world.editItem')}
                        </button>
                    )}
                </div>
            </motion.div>
        </AnimatePresence>,
        document.body
    );
};

export default CharacterPreviewCard;
