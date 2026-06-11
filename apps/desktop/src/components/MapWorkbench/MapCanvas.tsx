import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Stage, Layer, Image as KonvaImage, Circle, Text, Group } from 'react-konva';
import { Upload, ZoomIn, ZoomOut, RotateCcw, Trash2, User, Search, MapPin, Sparkles } from 'lucide-react';
import { MapCanvas as MapCanvasType, CharacterMapMarker, Character } from '../../types';
import { getAvatarColors } from '../../utils/avatarUtils';
import { formatAiError } from '../../utils/aiError';
import { BaseModal } from '../ui/BaseModal';
import PromptInlinePanel from '../AIPromptPreview/PromptInlinePanel';
import type { PromptPreviewData } from '../AIPromptPreview/types';

interface MapCanvasProps {
    mapId: string;
    novelId: string;
    theme: 'dark' | 'light';
    characters: Character[];
}

interface AiMapImageStats {
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
    rateLimitFailures: number;
    lastFailureCode?: string;
    lastFailureAt?: string;
    updatedAt: string;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const MAP_IMAGE_SIZES = ['2K', '1024x1024', '1536x1024', '1024x1536'] as const;
const MAP_STYLE_OPTIONS: Array<{ value: 'realistic' | 'fantasy' | 'ancient' | 'scifi'; labelKey: string }> = [
    { value: 'fantasy', labelKey: 'map.style.fantasy' },
    { value: 'realistic', labelKey: 'map.style.realistic' },
    { value: 'ancient', labelKey: 'map.style.ancient' },
    { value: 'scifi', labelKey: 'map.style.scifi' },
];

export default function MapCanvasView({ mapId, novelId: _novelId, theme, characters }: MapCanvasProps) {
    const { t } = useTranslation();
    const isDark = theme === 'dark';
    const aiProgressTimerRef = useRef<number | null>(null);
    const aiStageTimerRef = useRef<number | null>(null);
    const aiStartedAtRef = useRef<number | null>(null);

    const containerRef = useRef<HTMLDivElement>(null);
    const [map, setMap] = useState<MapCanvasType | null>(null);
    const [markers, setMarkers] = useState<CharacterMapMarker[]>([]);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);

    // Canvas state
    const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
    const [scale, setScale] = useState(1);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
    const [showCharPanel, setShowCharPanel] = useState(true);
    const [charSearch, setCharSearch] = useState('');
    const [isGeneratingBg, setIsGeneratingBg] = useState(false);
    const [aiMapStatus, setAiMapStatus] = useState('');
    const [aiImageSize, setAiImageSize] = useState<(typeof MAP_IMAGE_SIZES)[number]>('2K');
    const [aiStyleTemplate, setAiStyleTemplate] = useState<'realistic' | 'fantasy' | 'ancient' | 'scifi'>('fantasy');
    const [aiPrompt, setAiPrompt] = useState('');
    const [isAiModalOpen, setIsAiModalOpen] = useState(false);
    const [mapPromptPreview, setMapPromptPreview] = useState<PromptPreviewData | null>(null);
    const [mapPromptPreviewLoading, setMapPromptPreviewLoading] = useState(false);
    const [mapPromptPreviewError, setMapPromptPreviewError] = useState('');
    const [mapPromptOverride, setMapPromptOverride] = useState('');
    const [aiProgressPercent, setAiProgressPercent] = useState(0);
    const [aiProgressStage, setAiProgressStage] = useState<'requesting' | 'generating' | 'downloading' | 'saving'>('requesting');
    const [aiElapsedSeconds, setAiElapsedSeconds] = useState(0);
    const [aiMapStats, setAiMapStats] = useState<AiMapImageStats | null>(null);


    // Reset state when mapId changes
    useEffect(() => {
        setSelectedMarkerId(null);
        setMarkers([]);
        setBgImage(null);
        setMap(null);
        setAiPrompt('');
        setIsAiModalOpen(false);
        setMapPromptPreview(null);
        setMapPromptPreviewError('');
        setMapPromptOverride('');
    }, [mapId]);

    useEffect(() => {
        return () => {
            if (aiProgressTimerRef.current !== null) {
                window.clearInterval(aiProgressTimerRef.current);
                aiProgressTimerRef.current = null;
            }
            if (aiStageTimerRef.current !== null) {
                window.clearInterval(aiStageTimerRef.current);
                aiStageTimerRef.current = null;
            }
        };
    }, []);

    const loadAiMapStats = useCallback(async () => {
        try {
            const stats = await window.ai.getMapImageStats();
            setAiMapStats(stats);
        } catch (e) {
            console.error('Failed to load AI map image stats:', e);
        }
    }, []);
    // Load map data
    const loadMap = useCallback(async () => {
        try {
            const data = await window.db.getMap(mapId);
            if (data) {
                setMap(data);
                setMarkers(data.markers || []);
            }
        } catch (e) {
            console.error('Failed to load map:', e);
        }
    }, [mapId]);
    // Focus on a character's marker position
    const focusCharacter = useCallback((characterId: string) => {
        if (!map) return;
        const marker = markers.find(m => m.characterId === characterId);
        if (!marker) return;

        const absX = marker.x * map.width;
        const absY = marker.y * map.height;
        const targetScale = Math.max(scale, 1.5); // zoom to at least 150%

        setScale(targetScale);
        setPosition({
            x: stageSize.width / 2 - absX * targetScale,
            y: stageSize.height / 2 - absY * targetScale
        });
        setSelectedMarkerId(marker.id);
    }, [map, markers, scale, stageSize]);

    // Load background image when map changes
    useEffect(() => {
        if (!map?.background) {
            setBgImage(null);
            return;
        }
        const img = new window.Image();
        img.src = `local-resource://${map.background}`;
        img.onload = () => setBgImage(img);
        img.onerror = () => {
            console.error('Failed to load map background:', map.background);
            setBgImage(null);
        };
    }, [map?.background]);

    useEffect(() => {
        loadMap();
    }, [loadMap]);

    useEffect(() => {
        void loadAiMapStats();
    }, [loadAiMapStats]);

    // Resize observer
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const observer = new ResizeObserver(entries => {
            const { width, height } = entries[0].contentRect;
            setStageSize({ width, height });
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const rafId = window.requestAnimationFrame(() => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                setStageSize({ width: rect.width, height: rect.height });
            }
        });
        return () => window.cancelAnimationFrame(rafId);
    }, [showCharPanel, map?.background]);

    // Fit to screen on first load
    useEffect(() => {
        if (map && stageSize.width > 0) {
            const scaleX = stageSize.width / map.width;
            const scaleY = stageSize.height / map.height;
            const fitScale = Math.min(scaleX, scaleY, 1);
            setScale(fitScale);
            setPosition({
                x: (stageSize.width - map.width * fitScale) / 2,
                y: (stageSize.height - map.height * fitScale) / 2
            });
        }
    }, [map?.id, map?.width, map?.height, stageSize.width, stageSize.height]); // eslint-disable-line react-hooks/exhaustive-deps

    // Wheel zoom
    const handleWheel = useCallback((e: any) => {
        e.evt.preventDefault();
        const stage = e.target.getStage();
        if (!stage) return;

        const oldScale = scale;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;

        const mousePointTo = {
            x: (pointer.x - position.x) / oldScale,
            y: (pointer.y - position.y) / oldScale,
        };

        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
            e.evt.deltaY < 0 ? oldScale * 1.1 : oldScale / 1.1
        ));

        setScale(newScale);
        setPosition({
            x: pointer.x - mousePointTo.x * newScale,
            y: pointer.y - mousePointTo.y * newScale,
        });
    }, [scale, position]);

    // Upload background
    const handleUploadBg = async () => {
        try {
            const result = await window.db.uploadMapBackground(mapId);
            if (result) {
                setMap(prev => prev ? { ...prev, background: result.path, width: result.width, height: result.height } : prev);
                // bgImage will auto-refresh via the useEffect watching map?.background
            }
        } catch (e) {
            console.error('Failed to upload background:', e);
        }
    };

    const handleGenerateBgByAI = async () => {
        if (!map) return;
        const prompt = aiPrompt.trim();
        if (!prompt) {
            setAiMapStatus(t('map.aiPromptRequired'));
            return;
        }

        setIsGeneratingBg(true);
        setAiMapStatus('');
        setAiProgressPercent(8);
        setAiProgressStage('requesting');
        setAiElapsedSeconds(0);
        aiStartedAtRef.current = Date.now();

        if (aiProgressTimerRef.current !== null) {
            window.clearInterval(aiProgressTimerRef.current);
        }
        aiProgressTimerRef.current = window.setInterval(() => {
            setAiProgressPercent((prev) => Math.min(prev + 4, 92));
            if (aiStartedAtRef.current !== null) {
                setAiElapsedSeconds(Math.floor((Date.now() - aiStartedAtRef.current) / 1000));
            }
        }, 550);

        if (aiStageTimerRef.current !== null) {
            window.clearInterval(aiStageTimerRef.current);
        }
        const stageSequence: Array<'requesting' | 'generating' | 'downloading' | 'saving'> = ['requesting', 'generating', 'downloading', 'saving'];
        let stageIndex = 0;
        aiStageTimerRef.current = window.setInterval(() => {
            stageIndex = Math.min(stageIndex + 1, stageSequence.length - 1);
            setAiProgressStage(stageSequence[stageIndex]);
        }, 1800);

        try {
            const result = await window.ai.generateMapImage({
                novelId: _novelId,
                mapId,
                mapName: map.name,
                mapType: map.type as 'world' | 'region' | 'scene',
                prompt,
                imageSize: aiImageSize,
                styleTemplate: aiStyleTemplate,
                overrideUserPrompt: mapPromptOverride.trim() || undefined,
            });

            if (result.ok) {
                setAiProgressStage('saving');
                setAiProgressPercent(96);
                await loadMap();
                setAiProgressPercent(100);
                setAiMapStatus(t('map.aiGenerateSuccess'));
            } else {
                const detailText = (result.detail || '').toLowerCase();
                const isRateLimit = detailText.includes('429') || detailText.includes('rate limit') || detailText.includes('quota');
                const readable = isRateLimit
                    ? t('map.aiRateLimited')
                    : formatAiError(result.code, t, result.detail);
                setAiMapStatus(`${t('map.aiGenerateFailed')}: ${readable}`);
            }
        } catch (e) {
            console.error('Failed to generate map background by AI:', e);
            setAiMapStatus(`${t('map.aiGenerateFailed')}: ${formatAiError('UNKNOWN', t)}`);
        } finally {
            if (aiProgressTimerRef.current !== null) {
                window.clearInterval(aiProgressTimerRef.current);
                aiProgressTimerRef.current = null;
            }
            if (aiStageTimerRef.current !== null) {
                window.clearInterval(aiStageTimerRef.current);
                aiStageTimerRef.current = null;
            }
            aiStartedAtRef.current = null;
            setIsGeneratingBg(false);
            void loadAiMapStats();
        }
    };

    const handleOpenAiModal = () => {
        setAiMapStatus('');
        setMapPromptOverride('');
        setMapPromptPreview(null);
        setMapPromptPreviewError('');
        setIsAiModalOpen(true);
    };

    const refreshMapPromptPreview = useCallback(async () => {
        if (!isAiModalOpen || !map || !aiPrompt.trim()) {
            if (!aiPrompt.trim()) {
                setMapPromptPreview(null);
            }
            return;
        }
        setMapPromptPreviewLoading(true);
        setMapPromptPreviewError('');
        try {
            const preview = await window.ai.previewMapPrompt({
                novelId: _novelId, mapId,
                mapName: map.name,
                mapType: map.type as 'world' | 'region' | 'scene',
                prompt: aiPrompt,
                imageSize: aiImageSize,
                styleTemplate: aiStyleTemplate,
            });
            setMapPromptPreview(preview as unknown as PromptPreviewData);
            setMapPromptOverride((prev) => prev || preview.editableUserPrompt || '');
        } catch (error) {
            console.error('Failed to preview map prompt:', error);
            setMapPromptPreviewError(t('map.promptPreviewFailed'));
        } finally {
            setMapPromptPreviewLoading(false);
        }
    }, [aiImageSize, aiPrompt, aiStyleTemplate, isAiModalOpen, map, mapId, _novelId, t]);

    useEffect(() => {
        if (!isAiModalOpen) return;
        const timer = window.setTimeout(() => {
            void refreshMapPromptPreview();
        }, 300);
        return () => window.clearTimeout(timer);
    }, [aiImageSize, aiPrompt, aiStyleTemplate, isAiModalOpen, refreshMapPromptPreview]);

    const handleSubmitAiGenerate = () => {
        setIsAiModalOpen(false);
        void handleGenerateBgByAI();
    };

    const aiStageLabel = aiProgressStage === 'requesting'
        ? t('map.aiStage.requesting')
        : aiProgressStage === 'generating'
            ? t('map.aiStage.generating')
            : aiProgressStage === 'downloading'
                ? t('map.aiStage.downloading')
                : t('map.aiStage.saving');

    const generateDisabledReason = !map
        ? t('map.aiDisabled.noMap')
        : isGeneratingBg
            ? t('map.aiDisabled.running')
            : '';

    // Drag character to create marker
    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        const characterId = e.dataTransfer.getData('text/character-id');
        if (!characterId || !map) return;

        // Check if marker already exists
        if (markers.some(m => m.characterId === characterId)) return;

        const stageEl = containerRef.current;
        if (!stageEl) return;

        const rect = stageEl.getBoundingClientRect();
        const dropX = (e.clientX - rect.left - position.x) / scale;
        const dropY = (e.clientY - rect.top - position.y) / scale;

        // Convert to relative 0-1 coordinates
        const relX = dropX / map.width;
        const relY = dropY / map.height;

        if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return;

        try {
            const marker = await window.db.createMapMarker({
                characterId,
                mapId,
                x: relX,
                y: relY
            });
            setMarkers(prev => [...prev, marker]);
        } catch (e) {
            console.error('Failed to create marker:', e);
        }
    };

    // Move marker
    const handleMarkerDragEnd = async (markerId: string, newAbsX: number, newAbsY: number) => {
        if (!map) return;
        const relX = Math.max(0, Math.min(1, newAbsX / map.width));
        const relY = Math.max(0, Math.min(1, newAbsY / map.height));

        setMarkers(prev => prev.map(m => m.id === markerId ? { ...m, x: relX, y: relY } : m));

        try {
            await window.db.updateMapMarker(markerId, { x: relX, y: relY });
        } catch (e) {
            console.error('Failed to update marker:', e);
        }
    };

    // Delete marker
    const handleDeleteMarker = async (markerId: string) => {
        try {
            await window.db.deleteMapMarker(markerId);
            setMarkers(prev => prev.filter(m => m.id !== markerId));
            setSelectedMarkerId(null);
        } catch (e) {
            console.error('Failed to delete marker:', e);
        }
    };

    const resetView = () => {
        if (!map) return;
        const scaleX = stageSize.width / map.width;
        const scaleY = stageSize.height / map.height;
        const fitScale = Math.min(scaleX, scaleY, 1);
        setScale(fitScale);
        setPosition({
            x: (stageSize.width - map.width * fitScale) / 2,
            y: (stageSize.height - map.height * fitScale) / 2
        });
    };

    return (
        <div className={clsx("flex-1 flex flex-col h-full overflow-hidden", isDark ? "bg-[#0d0d15]" : "bg-gray-100")}>

            {/* Top Toolbar */}
            <div className={clsx(
                "flex items-center justify-between px-4 py-2 border-b shrink-0",
                isDark ? "bg-[#0a0a0f]/80 border-white/5" : "bg-white border-gray-200"
            )}>
                <div className="flex items-center gap-2">
                    <h3 className={clsx("text-sm font-medium", isDark ? "text-neutral-200" : "text-neutral-800")}>
                        {map?.name || '...'}
                    </h3>
                    {map?.type && (
                        <span className={clsx("text-[10px] px-1.5 py-0.5 rounded-full",
                            isDark ? "bg-white/5 text-neutral-400" : "bg-gray-100 text-neutral-500"
                        )}>
                            {t(`map.type.${map.type}`, map.type)}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    <button
                        onClick={handleUploadBg}
                        className={clsx(
                            "text-xs flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors",
                            isDark ? "text-indigo-400 hover:bg-white/5" : "text-indigo-600 hover:bg-black/5"
                        )}
                    >
                        <Upload className="w-3.5 h-3.5" />
                        {map?.background ? t('map.changeBg') : t('map.uploadBg')}
                    </button>
                    <button
                        onClick={handleOpenAiModal}
                        disabled={!map || isGeneratingBg}
                        title={generateDisabledReason || t('map.generateBgAI')}
                        className={clsx(
                            "text-xs flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors relative overflow-hidden",
                            isDark ? "text-amber-300 hover:bg-white/5 disabled:opacity-40" : "text-amber-700 hover:bg-black/5 disabled:opacity-40"
                        )}
                    >
                        <Sparkles className={clsx("w-3.5 h-3.5", isGeneratingBg && "animate-pulse")} />
                        {isGeneratingBg ? `${aiStageLabel} ${aiElapsedSeconds}s` : t('map.generateBgAI')}
                        {isGeneratingBg && (
                            <span
                                className={clsx(
                                    "absolute bottom-0 left-0 h-[2px]",
                                    isDark ? "bg-amber-300/80" : "bg-amber-500/80"
                                )}
                                style={{ width: `${aiProgressPercent}%` }}
                            />
                        )}
                    </button>
                    {!isGeneratingBg && generateDisabledReason && (
                        <span className={clsx("text-[11px] px-1", isDark ? "text-neutral-500" : "text-neutral-400")}>
                            {generateDisabledReason}
                        </span>
                    )}

                    <div className={clsx("w-px h-4 mx-1", isDark ? "bg-white/10" : "bg-gray-200")} />

                    <button onClick={() => setScale(s => Math.min(MAX_SCALE, s * 1.2))}
                        className={clsx("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/5 text-neutral-400" : "hover:bg-gray-100 text-neutral-500")}
                        title={t('map.zoomIn')}>
                        <ZoomIn className="w-4 h-4" />
                    </button>
                    <span className={clsx("text-[10px] w-10 text-center", isDark ? "text-neutral-500" : "text-neutral-400")}>
                        {Math.round(scale * 100)}%
                    </span>
                    <button onClick={() => setScale(s => Math.max(MIN_SCALE, s / 1.2))}
                        className={clsx("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/5 text-neutral-400" : "hover:bg-gray-100 text-neutral-500")}
                        title={t('map.zoomOut')}>
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <button onClick={resetView}
                        className={clsx("p-1.5 rounded-lg transition-colors", isDark ? "hover:bg-white/5 text-neutral-400" : "hover:bg-gray-100 text-neutral-500")}
                        title={t('map.resetView')}>
                        <RotateCcw className="w-4 h-4" />
                    </button>

                    <div className={clsx("w-px h-4 mx-1", isDark ? "bg-white/10" : "bg-gray-200")} />

                    <button
                        onClick={() => setShowCharPanel(!showCharPanel)}
                        className={clsx(
                            "p-1.5 rounded-lg transition-colors",
                            showCharPanel
                                ? isDark ? "bg-indigo-500/20 text-indigo-400" : "bg-indigo-50 text-indigo-600"
                                : isDark ? "hover:bg-white/5 text-neutral-400" : "hover:bg-gray-100 text-neutral-500"
                        )}
                        title={t('map.characters')}>
                        <User className="w-4 h-4" />
                    </button>
                </div>
            </div>
            {aiMapStatus && (
                <div className={clsx(
                    "px-4 py-2 text-xs border-b",
                    aiMapStatus.includes(t('map.aiGenerateSuccess'))
                        ? (isDark ? "border-emerald-400/20 text-emerald-300 bg-emerald-500/5" : "border-emerald-200 text-emerald-700 bg-emerald-50")
                        : (isDark ? "border-rose-400/20 text-rose-300 bg-rose-500/5" : "border-rose-200 text-rose-700 bg-rose-50")
                )}>
                    {aiMapStatus}
                </div>
            )}
            <BaseModal
                isOpen={isAiModalOpen}
                onClose={() => setIsAiModalOpen(false)}
                title={t('map.generateBgAI')}
                theme={theme}
                maxWidth="max-w-2xl"
            >
                <div className="space-y-4">
                    <div>
                        <label className={clsx("block text-xs mb-2", isDark ? "text-neutral-300" : "text-neutral-600")}>
                            {t('map.aiPromptLabel')}
                        </label>
                        <textarea
                            value={aiPrompt}
                            onChange={(e) => setAiPrompt(e.target.value)}
                            placeholder={t('map.aiPrompt')}
                            rows={5}
                            className={clsx(
                                "w-full rounded-lg border px-3 py-2 text-sm resize-y",
                                isDark ? "bg-[#0a0a0f] border-white/10 text-neutral-200 placeholder:text-neutral-600" : "bg-white border-gray-200 text-neutral-800 placeholder:text-gray-400"
                            )}
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className={clsx("block text-xs mb-2", isDark ? "text-neutral-300" : "text-neutral-600")}>
                                {t('map.aiSize')}
                            </label>
                            <select
                                value={aiImageSize}
                                onChange={(e) => setAiImageSize(e.target.value as (typeof MAP_IMAGE_SIZES)[number])}
                                className={clsx(
                                    "w-full text-sm px-3 py-2 rounded-lg border",
                                    isDark ? "bg-[#0a0a0f] border-white/10 text-neutral-300" : "bg-white border-gray-200 text-neutral-700"
                                )}
                            >
                                {MAP_IMAGE_SIZES.map((size) => (
                                    <option key={size} value={size}>
                                        {size}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className={clsx("block text-xs mb-2", isDark ? "text-neutral-300" : "text-neutral-600")}>
                                {t('map.aiStyle')}
                            </label>
                            <select
                                value={aiStyleTemplate}
                                onChange={(e) => setAiStyleTemplate(e.target.value as 'realistic' | 'fantasy' | 'ancient' | 'scifi')}
                                className={clsx(
                                    "w-full text-sm px-3 py-2 rounded-lg border",
                                    isDark ? "bg-[#0a0a0f] border-white/10 text-neutral-300" : "bg-white border-gray-200 text-neutral-700"
                                )}
                            >
                                {MAP_STYLE_OPTIONS.map((style) => (
                                    <option key={style.value} value={style.value}>
                                        {t(style.labelKey)}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <PromptInlinePanel
                        theme={theme}
                        title={t('map.promptPreview')}
                        loading={mapPromptPreviewLoading}
                        error={mapPromptPreviewError}
                        data={mapPromptPreview}
                        editablePrompt={mapPromptOverride}
                        onEditablePromptChange={setMapPromptOverride}
                        onRefresh={() => void refreshMapPromptPreview()}
                    />
                    {aiMapStats && (
                        <div className={clsx(
                            "rounded-lg border px-3 py-2 text-xs",
                            isDark ? "border-white/10 bg-white/5 text-neutral-300" : "border-gray-200 bg-gray-50 text-neutral-600"
                        )}>
                            {t('map.aiStats', { total: aiMapStats.totalCalls, success: aiMapStats.successCalls, failed: aiMapStats.failedCalls, rateLimit: aiMapStats.rateLimitFailures })}
                        </div>
                    )}
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            onClick={() => setIsAiModalOpen(false)}
                            className={clsx(
                                "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                                isDark ? "border-white/10 text-neutral-300 hover:bg-white/5" : "border-gray-200 text-neutral-600 hover:bg-gray-50"
                            )}
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={handleSubmitAiGenerate}
                            disabled={isGeneratingBg || !aiPrompt.trim()}
                            className={clsx(
                                "px-3 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-50",
                                isDark ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30" : "bg-amber-100 text-amber-800 hover:bg-amber-200"
                            )}
                        >
                            {t('map.generateBgAI')}
                        </button>
                    </div>
                </div>
            </BaseModal>

            {/* Main Area: Canvas + Character Panel */}
            <div className="flex-1 flex overflow-hidden min-w-0">

                {/* Canvas */}
                <div
                    ref={containerRef}
                    className="flex-1 relative min-w-0"
                    onDragOver={e => e.preventDefault()}
                    onDrop={handleDrop}
                >
                    {!map?.background && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
                            <Upload className={clsx("w-12 h-12 mb-3", isDark ? "text-neutral-700" : "text-neutral-300")} />
                            <p className={clsx("text-sm", isDark ? "text-neutral-600" : "text-neutral-400")}>
                                {t('map.noBg')}
                            </p>
                            <p className={clsx("text-xs mt-1", isDark ? "text-neutral-700" : "text-neutral-400")}>
                                {t('map.noBgHint')}
                            </p>
                        </div>
                    )}

                    {(bgImage || markers.length > 0) && (
                        <Stage
                            width={stageSize.width}
                            height={stageSize.height}
                            scaleX={scale}
                            scaleY={scale}
                            x={position.x}
                            y={position.y}
                            draggable
                            onDragEnd={(e) => {
                                // Only update position if the Stage itself was dragged, not a child (marker)
                                if (e.target === e.target.getStage()) {
                                    setPosition({ x: e.target.x(), y: e.target.y() });
                                }
                            }}
                            onWheel={handleWheel}
                            onClick={(e) => {
                                // Deselect marker if clicking on stage background
                                if (e.target === e.target.getStage()) {
                                    setSelectedMarkerId(null);
                                }
                            }}
                        >
                            {/* Background layer */}
                            <Layer>
                                {bgImage && map && (
                                    <KonvaImage
                                        image={bgImage}
                                        width={map.width}
                                        height={map.height}
                                    />
                                )}
                            </Layer>

                            {/* Markers layer */}
                            <Layer>
                                {markers.map(marker => {
                                    if (!map) return null;
                                    const absX = marker.x * map.width;
                                    const absY = marker.y * map.height;
                                    const isSelected = selectedMarkerId === marker.id;
                                    const charName = marker.character?.name || marker.label || '?';

                                    return (
                                        <Group
                                            key={marker.id}
                                            x={absX}
                                            y={absY}
                                            draggable
                                            onDragEnd={(e) => {
                                                handleMarkerDragEnd(marker.id, e.target.x(), e.target.y());
                                            }}
                                            onClick={() => setSelectedMarkerId(marker.id)}
                                            onTap={() => setSelectedMarkerId(marker.id)}
                                        >
                                            {/* Shadow */}
                                            <Circle
                                                radius={isSelected ? 18 : 14}
                                                fill="rgba(0,0,0,0.3)"
                                                y={2}
                                            />
                                            {/* Main circle */}
                                            <Circle
                                                radius={isSelected ? 18 : 14}
                                                fill={isSelected ? '#6366f1' : '#3b82f6'}
                                                stroke={isSelected ? '#a5b4fc' : '#60a5fa'}
                                                strokeWidth={isSelected ? 3 : 2}
                                            />
                                            {/* Character initial */}
                                            <Text
                                                text={charName.charAt(0)}
                                                fontSize={isSelected ? 16 : 12}
                                                fill="white"
                                                fontStyle="bold"
                                                align="center"
                                                verticalAlign="middle"
                                                width={isSelected ? 36 : 28}
                                                height={isSelected ? 36 : 28}
                                                offsetX={isSelected ? 18 : 14}
                                                offsetY={isSelected ? 18 : 14}
                                            />
                                            {/* Name label */}
                                            <Text
                                                text={charName}
                                                fontSize={12}
                                                fill={'#ffffff'}
                                                fontStyle="bold"
                                                align="center"
                                                y={isSelected ? 24 : 20}
                                                width={80}
                                                offsetX={40}
                                                stroke={'#000000'}
                                                strokeWidth={0.5}
                                                shadowColor="black"
                                                shadowBlur={6}
                                                shadowOpacity={0.8}
                                                shadowOffsetY={1}
                                            />
                                        </Group>
                                    );
                                })}
                            </Layer>
                        </Stage>
                    )}

                    {/* Selected marker actions (floating) */}
                    {selectedMarkerId && markers.some(m => m.id === selectedMarkerId) && (
                        <div className={clsx(
                            "absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-xl shadow-lg border",
                            isDark ? "bg-neutral-900/90 border-white/10" : "bg-white/90 border-gray-200"
                        )}>
                            <span className={clsx("text-xs", isDark ? "text-neutral-300" : "text-neutral-600")}>
                                {markers.find(m => m.id === selectedMarkerId)?.character?.name || '?'}
                            </span>
                            <button
                                onClick={() => handleDeleteMarker(selectedMarkerId)}
                                className={clsx(
                                    "flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-colors",
                                    isDark ? "text-red-400 hover:bg-red-500/10" : "text-red-500 hover:bg-red-50"
                                )}
                            >
                                <Trash2 className="w-3 h-3" />
                                {t('map.removeMarker')}
                            </button>
                        </div>
                    )}
                </div>

                {/* Character Panel (draggable source + click to locate) */}
                {showCharPanel && (
                    <div className={clsx(
                        "w-52 flex flex-col border-l overflow-hidden shrink-0",
                        isDark ? "bg-[#0a0a0f] border-white/5" : "bg-white border-gray-200"
                    )}>
                        <div className={clsx("px-3 py-2 text-xs font-medium border-b",
                            isDark ? "text-neutral-400 border-white/5" : "text-neutral-500 border-gray-100"
                        )}>
                            {t('map.characters')}
                        </div>
                        {/* Search box */}
                        <div className={clsx("px-2 py-1.5 border-b", isDark ? "border-white/5" : "border-gray-100")}>
                            <div className={clsx(
                                "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs",
                                isDark ? "bg-white/5 text-neutral-300" : "bg-gray-50 text-neutral-600"
                            )}>
                                <Search className="w-3 h-3 opacity-40 shrink-0" />
                                <input
                                    value={charSearch}
                                    onChange={e => setCharSearch(e.target.value)}
                                    placeholder={t('common.search') + '...'}
                                    className={clsx(
                                        "flex-1 bg-transparent outline-none text-xs placeholder:opacity-40",
                                        isDark ? "text-neutral-200" : "text-neutral-700"
                                    )}
                                />
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                            {characters
                                .filter(c => !charSearch || c.name.toLowerCase().includes(charSearch.toLowerCase()))
                                .map(char => {
                                    const hasMarker = markers.some(m => m.characterId === char.id);
                                    return (
                                        <div
                                            key={char.id}
                                            draggable={!hasMarker}
                                            onDragStart={(e) => {
                                                if (hasMarker) {
                                                    e.preventDefault();
                                                    return;
                                                }
                                                e.dataTransfer.setData('text/character-id', char.id);
                                                e.dataTransfer.effectAllowed = 'copy';
                                            }}
                                            onClick={() => {
                                                if (hasMarker) focusCharacter(char.id);
                                            }}
                                            className={clsx(
                                                "flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors",
                                                hasMarker
                                                    ? isDark ? "cursor-pointer hover:bg-indigo-500/10 text-neutral-200" : "cursor-pointer hover:bg-indigo-50 text-neutral-700"
                                                    : isDark ? "cursor-grab hover:bg-white/5 text-neutral-200" : "cursor-grab hover:bg-gray-50 text-neutral-700"
                                            )}
                                        >
                                            {(() => {
                                                const colors = getAvatarColors(char.id, char.name, isDark);
                                                return char.avatar ? (
                                                    <img
                                                        src={`local-resource://${char.avatar}`}
                                                        alt={char.name}
                                                        className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                                                    />
                                                ) : (
                                                    <div className={clsx(
                                                        "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium bg-gradient-to-br flex-shrink-0",
                                                        colors[0], colors[1], colors[2]
                                                    )}>
                                                        {char.name.charAt(0)}
                                                    </div>
                                                );
                                            })()}
                                            <span className="truncate flex-1">{char.name}</span>
                                            {hasMarker ? (
                                                <MapPin className={clsx("w-3 h-3 shrink-0", isDark ? "text-indigo-400" : "text-indigo-500")} />
                                            ) : null}
                                        </div>
                                    );
                                })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

