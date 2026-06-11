import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { BaseModal } from '../ui/BaseModal';
import { usePlotSystem } from '../../hooks/usePlotSystem';
import { ChevronRight, ChevronDown } from 'lucide-react';

interface PlotAnchorModalProps {
    novelId: string;
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (plotPointId: string, type: 'setup' | 'payoff') => void;
    theme: 'dark' | 'light';
}

export default function PlotAnchorModal({ novelId, isOpen, onClose, onSubmit, theme }: PlotAnchorModalProps) {
    const { t } = useTranslation();
    const { plotLines } = usePlotSystem(novelId);
    const isDark = theme === 'dark';

    const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
    const [anchorType, setAnchorType] = useState<'setup' | 'payoff'>('setup');
    const [expandedLines, setExpandedLines] = useState<Set<string>>(new Set());

    const toggleExpand = (id: string) => {
        const newSet = new Set(expandedLines);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setExpandedLines(newSet);
    };

    const handleSubmit = () => {
        if (selectedPointId) {
            onSubmit(selectedPointId, anchorType);
            onClose();
        }
    };

    return (
        <BaseModal isOpen={isOpen} onClose={onClose} theme={theme} maxWidth="max-w-[500px]" className="p-0 max-h-[80vh] overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-white/10">
                    <h3 className="font-medium text-lg">{t('plot.addAnchor', 'Add Plot Anchor')}</h3>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Data Check */}
                    {plotLines.length === 0 && (
                        <div className="text-center py-8 opacity-50 italic">
                            {t('plot.noLines', 'No plot lines available. Create one in the sidebar first.')}
                        </div>
                    )}

                    {/* Plot Lines List */}
                    <div className="space-y-2">
                        {plotLines.map(line => (
                            <div key={line.id} className="rounded border border-white/5 overflow-hidden">
                                <div
                                    className={clsx("flex items-center p-2 cursor-pointer hover:bg-white/5", expandedLines.has(line.id) && "bg-white/5")}
                                    onClick={() => toggleExpand(line.id)}
                                >
                                    {expandedLines.has(line.id) ? <ChevronDown className="w-4 h-4 mr-2 opacity-50" /> : <ChevronRight className="w-4 h-4 mr-2 opacity-50" />}
                                    <div className="w-1 h-4 rounded-full mr-2" style={{ backgroundColor: line.color }} />
                                    <span className="font-medium text-sm">{line.name}</span>
                                </div>

                                {expandedLines.has(line.id) && (
                                    <div className="pl-9 pr-2 pb-2 space-y-1">
                                        {line.points?.length === 0 && (
                                            <div className="text-xs opacity-50 py-1">{t('plot.noPoints', 'No points')}</div>
                                        )}
                                        {line.points?.map(point => (
                                            <div
                                                key={point.id}
                                                onClick={() => setSelectedPointId(point.id)}
                                                className={clsx(
                                                    "p-2 rounded text-sm cursor-pointer transition-colors border",
                                                    selectedPointId === point.id
                                                        ? "border-purple-500 bg-purple-500/10 text-purple-300"
                                                        : "border-transparent hover:bg-white/5 opacity-80 hover:opacity-100"
                                                )}
                                            >
                                                {point.title}
                                                <div className="text-xs opacity-50 truncate">{point.description}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Type Selection */}
                    <div className="flex gap-4 pt-4 border-t border-white/10">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="anchorType"
                                checked={anchorType === 'setup'}
                                onChange={() => setAnchorType('setup')}
                                className="accent-purple-500"
                            />
                            <span>{t('plot.setup', 'Foreshadowing (Setup)')}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="anchorType"
                                checked={anchorType === 'payoff'}
                                onChange={() => setAnchorType('payoff')}
                                className="accent-purple-500"
                            />
                            <span>{t('plot.payoff', 'Redemption (Payoff)')}</span>
                        </label>
                    </div>
                </div>

                {/* Footer */}
                <div className={clsx("p-4 border-t flex justify-end gap-2", isDark ? "border-white/10 bg-black/20" : "border-neutral-200 bg-gray-50")}>
                    <button onClick={onClose} className="px-4 py-2 rounded text-sm hover:bg-white/10 transition-colors">
                        {t('common.cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={!selectedPointId}
                        className="px-6 py-2 rounded text-sm bg-purple-600 hover:bg-purple-500 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        {t('common.confirm', 'Confirm')}
                    </button>
                </div>
        </BaseModal>
    );
}
