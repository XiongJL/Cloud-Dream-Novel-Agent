import { useState, useEffect, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, HelpCircle, Flag, Sparkles, CircleDot } from 'lucide-react';
import { clsx } from 'clsx';
import { PlotPoint } from '../../types';
import { ConfirmModal } from '../ui/ConfirmModal';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

interface PlotPointItemProps {
    point: PlotPoint;
    isDark: boolean;
    onClick?: () => void;
    onDelete?: () => void;
    isHighlighted?: boolean;
    onJump?: (point: PlotPoint) => boolean; // Return true if jump successful (has anchors)
}

// Helper to get icon for point type
const getTypeIcon = (type: string, t: TFunction) => {
    switch (type) {
        case 'mystery':
        case t('plot.types.mystery'):
            return <HelpCircle className="w-3 h-3" />;
        case 'promise':
        case t('plot.types.promise'):
            return <Flag className="w-3 h-3" />;
        case 'foreshadowing':
        case t('plot.types.foreshadowing'):
            return <Sparkles className="w-3 h-3" />;
        case 'event':
        case t('plot.types.event'):
        default:
            return <CircleDot className="w-3 h-3" />;
    }
};

export function PlotPointItem({ point, isDark, onClick, onDelete, isHighlighted, onJump }: PlotPointItemProps) {
    const { t } = useTranslation();
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isShaking, setIsShaking] = useState(false);

    // Auto scroll into view when highlighted
    const itemRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (isHighlighted && itemRef.current) {
            itemRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [isHighlighted]);

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: point.id, data: { type: 'PlotPoint', point } });

    // Fuse refs
    const setRefs = (element: HTMLElement | null) => {
        setNodeRef(element);
        (itemRef as any).current = element;
    };

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        animation: isShaking ? 'shake 0.5s cubic-bezier(.36,.07,.19,.97) both' : undefined
    };

    const handleDeleteClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        setShowDeleteConfirm(true);
    };

    const handleJumpClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        // Check if point has anchors
        const hasAnchors = point.anchors && point.anchors.length > 0;

        if (hasAnchors && onJump) {
            const success = onJump(point);
            if (!success) {
                triggerShake();
            }
        } else {
            triggerShake();
        }
    };

    const triggerShake = () => {
        setIsShaking(true);
        setTimeout(() => setIsShaking(false), 500);
    };

    return (
        <>
            <div
                ref={setRefs}
                style={style}
                {...attributes}
                className={clsx(
                    "group/point flex items-center text-xs p-1 rounded cursor-pointer select-none transition-all duration-300 relative border",
                    isDragging ? (isDark ? "bg-purple-500/20 ring-1 ring-purple-500/50 border-transparent" : "bg-purple-100 ring-1 ring-purple-300 border-transparent") :
                        isHighlighted ? (isDark ? "bg-yellow-500/20 border-yellow-500/50 text-yellow-200" : "bg-yellow-100 border-yellow-400 text-yellow-800") :
                            (isDark ? "text-neutral-300 hover:bg-white/5 border-transparent" : "text-neutral-700 hover:bg-black/5 border-transparent")
                )}
                onClick={onClick}
            >
                <div
                    {...listeners}
                    className="mr-1 opacity-0 group-hover/point:opacity-50 hover:!opacity-100 cursor-grab active:cursor-grabbing"
                >
                    <GripVertical className="w-3 h-3" />
                </div>

                {/* Type Icon */}
                <div className={clsx(
                    "flex items-center justify-center w-5 h-5 rounded-full shrink-0 mr-1.5",
                    isDark ? "bg-white/10 text-white/80" : "bg-gray-100 text-gray-600"
                )}>
                    {getTypeIcon(point.type, t)}
                </div>

                <span className="truncate flex-1">{point.title}</span>

                <div className="flex items-center gap-1">
                    {/* Status Indicator */}
                    {point.status === 'resolved' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" title="Resolved" />
                    )}

                    {/* Jump Button */}
                    <button
                        onClick={handleJumpClick}
                        className={clsx(
                            "p-1 opacity-0 group-hover/point:opacity-100 transition-all ml-1 rounded",
                            isDark ? "hover:bg-white/10 hover:text-white" : "hover:bg-black/5 hover:text-black",
                            (!point.anchors || point.anchors.length === 0) && "opacity-30 cursor-not-allowed group-hover/point:opacity-50"
                        )}
                        title={t('plot.jumpToText')}
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <circle cx="12" cy="12" r="3" />
                            <line x1="12" y1="2" x2="12" y2="4" />
                            <line x1="12" y1="20" x2="12" y2="22" />
                            <line x1="2" y1="12" x2="4" y2="12" />
                            <line x1="20" y1="12" x2="22" y2="12" />
                        </svg>
                    </button>

                    {/* Delete Button */}
                    <button
                        onClick={handleDeleteClick}
                        className="p-1 opacity-0 group-hover/point:opacity-100 hover:text-red-400 transition-all rounded hover:bg-red-500/10"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

            <ConfirmModal
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={() => onDelete?.()}
                title={t('plot.deletePoint')}
                message={t('plot.confirmDeletePoint')}
                theme={isDark ? 'dark' : 'light'}
            />
            <style>{`
                @keyframes shake {
                    10%, 90% { transform: translate3d(-1px, 0, 0); }
                    20%, 80% { transform: translate3d(2px, 0, 0); }
                    30%, 50%, 70% { transform: translate3d(-4px, 0, 0); }
                    40%, 60% { transform: translate3d(4px, 0, 0); }
                }
            `}</style>
        </>
    );
}
