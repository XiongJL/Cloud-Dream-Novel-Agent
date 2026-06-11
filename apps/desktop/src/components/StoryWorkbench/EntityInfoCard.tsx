import React, { useRef, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { User, Package, X, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface EntityInfoCardProps {
    entity: any; // Character or Item
    type: 'character' | 'item';
    onClose: () => void;
    position: { top: number; left: number };
    isDark: boolean;
}

export const EntityInfoCard: React.FC<EntityInfoCardProps> = ({
    entity,
    type,
    onClose,
    position,
    isDark
}) => {
    const { t } = useTranslation();
    const cardRef = useRef<HTMLDivElement>(null);
    const [adjustedPos, setAdjustedPos] = useState(position);

    useEffect(() => {
        // Delay to allow the card to render and get actual dimensions
        requestAnimationFrame(() => {
            const card = cardRef.current;
            if (!card) return;
            const { offsetWidth: w, offsetHeight: h } = card;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const pad = 10;
            let top = position.top;
            let left = position.left;
            // If card overflows bottom, flip above cursor
            if (top + h + pad > vh) top = Math.max(pad, position.top - h - 20);
            // If card overflows right, shift left
            if (left + w + pad > vw) left = Math.max(pad, vw - w - pad);
            setAdjustedPos({ top, left });
        });
    }, [position]);

    if (!entity) return null;

    return (
        <div
            ref={cardRef}
            className={clsx(
                "fixed z-[100] w-72 rounded-xl border shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200 entity-info-card",
                isDark ? "bg-neutral-900 border-white/10 shadow-black/60" : "bg-white border-gray-200 shadow-gray-300/50"
            )}
            style={{
                top: adjustedPos.top,
                left: adjustedPos.left
            }}
        >
            {/* Header */}
            <div className={clsx(
                "p-4 border-b flex items-center justify-between",
                isDark ? "bg-white/5 border-white/5" : "bg-gray-50 border-gray-100"
            )}>
                <div className="flex items-center gap-3">
                    <div className={clsx(
                        "w-10 h-10 rounded-lg flex items-center justify-center shadow-inner overflow-hidden",
                        type === 'character'
                            ? (isDark ? "bg-indigo-500/20 text-indigo-400" : "bg-indigo-100 text-indigo-600")
                            : (isDark ? "bg-amber-500/20 text-amber-400" : "bg-amber-100 text-amber-600")
                    )}>
                        {type === 'character' && entity.avatar ? (
                            <img src={`local-resource://${entity.avatar}`} alt={entity.name} className="w-full h-full object-cover" />
                        ) : type === 'character' ? <User className="w-5 h-5" /> : <Package className="w-5 h-5" />}
                    </div>
                    <div>
                        <h3 className={clsx("font-bold text-base leading-tight", isDark ? "text-white" : "text-gray-900")}>
                            {entity.name}
                        </h3>
                        <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold mt-0.5">
                            {type === 'character'
                                ? t('world.dossier.characterTitle', 'Character Dossier')
                                : t('world.dossier.itemTitle', 'Object Profile')}
                        </p>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 rounded-full hover:bg-black/10 transition-colors opacity-50 hover:opacity-100"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4 max-h-[350px] overflow-y-auto custom-scrollbar">
                {/* Description */}
                {(entity.description || entity.profile) && (
                    <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 opacity-30">
                            <BookOpen className="w-3 h-3" />
                            <span className="text-[10px] font-bold uppercase tracking-tight">
                                {t('world.dossier.notes', 'Biography / Notes')}
                            </span>
                        </div>
                        <p className={clsx("text-xs leading-relaxed", isDark ? "text-neutral-400" : "text-gray-600")}>
                            {entity.description || entity.profile || t('world.dossier.noData', 'No details recorded.')}
                        </p>
                    </div>
                )}

                {/* Custom Attributes (Profile) */}
                {(() => {
                    let profile = {};
                    try {
                        profile = entity.profile ? JSON.parse(entity.profile) : {};
                    } catch (e) { console.error('Failed to parse profile', e); }

                    const entries = Object.entries(profile);
                    if (entries.length === 0 && !entity.role) return null;

                    return (
                        <div className="grid grid-cols-2 gap-3">
                            {/* Role (for character) */}
                            {type === 'character' && entity.role && (
                                <div className={clsx("p-2 rounded-lg border", isDark ? "bg-white/5 border-white/5" : "bg-gray-50 border-gray-100")}>
                                    <div className="text-[9px] opacity-40 font-bold uppercase mb-1">
                                        {t('world.dossier.role', 'Role')}
                                    </div>
                                    <div className="text-[11px] font-medium truncate" title={entity.role}>{entity.role}</div>
                                </div>
                            )}

                            {/* Profile Entries */}
                            {entries.map(([key, value]) => (
                                <div key={key} className={clsx("p-2 rounded-lg border", isDark ? "bg-white/5 border-white/5" : "bg-gray-50 border-gray-100")}>
                                    <div className="text-[9px] opacity-40 font-bold uppercase mb-1 truncate" title={key}>
                                        {key}
                                    </div>
                                    <div className="text-[11px] font-medium truncate" title={String(value)}>{String(value)}</div>
                                </div>
                            ))}
                        </div>
                    );
                })()}


            </div>
        </div>
    );
};
