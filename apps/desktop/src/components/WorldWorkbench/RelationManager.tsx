import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Plus, Trash2, Users, Link2 } from 'lucide-react';
import { ConfirmModal } from '../ui/ConfirmModal';
import { Combobox } from '../ui/Combobox';
import { Relationship, Character } from '../../types';

interface RelationManagerProps {
    characterId: string;
    novelId: string;
    theme: 'dark' | 'light';
}

export default function RelationManager({ characterId, novelId, theme }: RelationManagerProps) {
    const { t } = useTranslation();
    const isDark = theme === 'dark';

    const [relations, setRelations] = useState<Relationship[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [isAdding, setIsAdding] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

    // New relation form
    const [targetId, setTargetId] = useState('');
    const [relationName, setRelationName] = useState('');
    const [relationDesc, setRelationDesc] = useState('');

    const loadRelations = useCallback(async () => {
        try {
            const data = await window.db.getRelationships(characterId);
            setRelations(data);
        } catch (e) {
            console.error('Failed to load relationships:', e);
        }
    }, [characterId]);

    const loadCharacters = useCallback(async () => {
        try {
            const data = await window.db.getCharacters(novelId);
            setCharacters(data.filter(c => c.id !== characterId));
        } catch (e) {
            console.error('Failed to load characters:', e);
        }
    }, [novelId, characterId]);

    useEffect(() => {
        loadRelations();
        loadCharacters();
    }, [loadRelations, loadCharacters]);

    const handleAdd = async () => {
        if (!targetId || !relationName.trim()) return;
        try {
            const newRel = await window.db.createRelationship({
                sourceId: characterId,
                targetId,
                relation: relationName.trim(),
                description: relationDesc.trim() || undefined
            });
            setRelations(prev => [...prev, newRel]);
            setIsAdding(false);
            setTargetId('');
            setRelationName('');
            setRelationDesc('');
        } catch (e) {
            console.error('Failed to create relationship:', e);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await window.db.deleteRelationship(id);
            setRelations(prev => prev.filter(r => r.id !== id));
        } catch (e) {
            console.error('Failed to delete relationship:', e);
        }
    };

    const getRelatedCharacter = (rel: Relationship) => {
        if (rel.sourceId === characterId) {
            return rel.target || { name: t('world.unknownCharacter'), id: rel.targetId };
        }
        return rel.source || { name: t('world.unknownCharacter'), id: rel.sourceId };
    };

    const getDirection = (rel: Relationship) => {
        return rel.sourceId === characterId ? '→' : '←';
    };

    const inputClass = clsx(
        "px-3 py-2 rounded-lg text-sm border outline-none transition-colors",
        isDark
            ? "bg-white/5 border-white/10 text-white placeholder-neutral-500 focus:border-indigo-500/50"
            : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-indigo-500"
    );

    return (
        <div className="min-h-full">
            {/* Sticky Header */}
            <div className={clsx(
                "sticky top-0 z-10 px-6 py-3 border-b flex justify-end",
                isDark ? "bg-[#1a1a20] border-white/5" : "bg-white border-gray-100"
            )}>
                <button
                    onClick={() => setIsAdding(!isAdding)}
                    className={clsx(
                        "text-xs flex items-center gap-1 px-2.5 py-1.5 rounded-lg transition-colors",
                        isDark ? "text-indigo-400 hover:bg-white/5" : "text-indigo-600 hover:bg-black/5"
                    )}
                >
                    <Plus className="w-3 h-3" />
                    {t('world.addRelation')}
                </button>
            </div>

            <div className="p-6 space-y-3">
                {/* Add Form */}
                {isAdding && (
                    <div className={clsx(
                        "p-3 rounded-lg border space-y-3",
                        isDark ? "bg-white/[0.02] border-white/10" : "bg-gray-50 border-gray-200"
                    )}>
                        <div>
                            <label className={clsx("text-xs font-medium mb-1 block", isDark ? "text-neutral-400" : "text-neutral-500")}>
                                {t('world.selectTarget')}
                            </label>
                            <Combobox
                                options={characters}
                                value={targetId}
                                onChange={setTargetId}
                                placeholder={t('world.selectTarget')}
                                theme={theme}
                                className="relative z-20" // Ensure dropdown is above other elements
                                renderOption={(c) => (
                                    <div className="flex items-center gap-2">
                                        <div className={clsx(
                                            "w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold",
                                            isDark
                                                ? "bg-gradient-to-br from-indigo-500/30 to-purple-500/30 text-indigo-300"
                                                : "bg-gradient-to-br from-indigo-100 to-purple-100 text-indigo-600"
                                        )}>
                                            {c.avatar ? (
                                                <img src={c.avatar} alt={c.name} className="w-full h-full rounded-full object-cover" />
                                            ) : (
                                                <span>{c.name.charAt(0)}</span>
                                            )}
                                        </div>
                                        <span className="truncate">{c.name}</span>
                                        {c.role && <span className="text-xs opacity-50 truncate">({c.role})</span>}
                                    </div>
                                )}
                            />
                        </div>

                        {/* Relation Name */}
                        <div>
                            <label className={clsx("text-xs font-medium mb-1 block", isDark ? "text-neutral-400" : "text-neutral-500")}>
                                {t('world.relationName')}
                            </label>
                            <input
                                value={relationName}
                                onChange={e => setRelationName(e.target.value)}
                                className={clsx(inputClass, "w-full")}
                                placeholder={t('world.relationNamePlaceholder')}
                            />
                        </div>

                        {/* Description */}
                        <div>
                            <label className={clsx("text-xs font-medium mb-1 block", isDark ? "text-neutral-400" : "text-neutral-500")}>
                                {t('world.relationDesc')}
                            </label>
                            <textarea
                                value={relationDesc}
                                onChange={e => setRelationDesc(e.target.value)}
                                rows={2}
                                className={clsx(inputClass, "w-full resize-none")}
                                placeholder={t('world.relationDescPlaceholder')}
                            />
                        </div>

                        {/* Form Actions */}
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => { setIsAdding(false); setTargetId(''); setRelationName(''); setRelationDesc(''); }}
                                className={clsx("text-xs px-3 py-1.5 rounded-lg transition-colors", isDark ? "text-neutral-400 hover:bg-white/5" : "text-neutral-500 hover:bg-gray-100")}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                onClick={handleAdd}
                                disabled={!targetId || !relationName.trim()}
                                className={clsx(
                                    "text-xs px-3 py-1.5 rounded-lg transition-colors font-medium",
                                    targetId && relationName.trim()
                                        ? "bg-indigo-500 text-white hover:bg-indigo-600"
                                        : (isDark ? "bg-white/5 text-neutral-600" : "bg-gray-100 text-neutral-300")
                                )}
                            >
                                {t('common.confirm')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Relation List */}
                {relations.length === 0 && !isAdding ? (
                    <div className={clsx("text-center py-8", isDark ? "text-neutral-600" : "text-neutral-400")}>
                        <Users className="w-7 h-7 mx-auto mb-2 opacity-50" />
                        <p className="text-xs">{t('world.noRelations')}</p>
                        <p className="text-[10px] mt-1 opacity-60">{t('world.addRelationHint')}</p>
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        {relations.map(rel => {
                            const related = getRelatedCharacter(rel);
                            const dir = getDirection(rel);
                            return (
                                <div
                                    key={rel.id}
                                    className={clsx(
                                        "group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors",
                                        isDark ? "hover:bg-white/5" : "hover:bg-black/5"
                                    )}
                                >
                                    <Link2 className={clsx("w-3.5 h-3.5 flex-shrink-0", isDark ? "text-indigo-400" : "text-indigo-500")} />
                                    <div className="flex-1 min-w-0">
                                        <div className={clsx("text-sm", isDark ? "text-neutral-200" : "text-neutral-800")}>
                                            <span className="font-medium">{(related as any).name}</span>
                                            <span className={clsx("mx-1.5 text-xs", isDark ? "text-neutral-500" : "text-neutral-400")}>{dir}</span>
                                            <span className={clsx("text-xs px-1.5 py-0.5 rounded", isDark ? "bg-indigo-500/15 text-indigo-300" : "bg-indigo-50 text-indigo-600")}>
                                                {rel.relation}
                                            </span>
                                        </div>
                                        {rel.description && (
                                            <p className={clsx("text-[11px] mt-0.5 truncate", isDark ? "text-neutral-500" : "text-neutral-400")}>
                                                {rel.description}
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => setDeleteTarget(rel.id)}
                                        className={clsx("p-1 rounded transition-colors opacity-0 group-hover:opacity-100", isDark ? "hover:bg-red-500/20 text-neutral-500" : "hover:bg-red-50 text-neutral-400")}
                                    >
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                <ConfirmModal
                    isOpen={!!deleteTarget}
                    onClose={() => setDeleteTarget(null)}
                    onConfirm={() => { if (deleteTarget) { handleDelete(deleteTarget); setDeleteTarget(null); } }}
                    title={t('common.delete')}
                    message={t('world.confirmDeleteRelation')}
                    theme={theme}
                />
            </div>
        </div>
    );
}
