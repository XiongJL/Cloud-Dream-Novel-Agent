import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, ChevronLeft, ChevronRight, Plus, Search, Settings, Trash2, Upload, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import Editor from './Editor';
import SettingsModal from '../components/SettingsModal';
import { useEditorPreferences } from '../hooks/useEditorPreferences';

const ACTIVE_NOVEL_STORAGE_KEY = 'novel_editor_active_novel_id';
const VISIBLE_STACK_COUNT = 5;
const WHEEL_THRESHOLD = 90;
const ANIMATION_DURATION_MS = 700;
const DELETE_DROP_DURATION_MS = 800;
const BASE_CARD_WIDTH = 290;
const BASE_CARD_HEIGHT = 400;
const BASE_CARD_PADDING = 35;

type StackState = {
    x: number;
    y: number;
    scale: number;
    rotateX: number;
    rotateZ: number;
    opacity: number;
    zIndex: number;
    blur: number;
};

type HomeLayoutPreset = {
    tier: 'wide' | 'medium' | 'compact';
    shellPadding: number;
    sectionMaxWidth: number;
    sectionMaxHeight: number;
    sectionPaddingX: number;
    leftColumnWidth: number;
    headlineSize: number;
    headlineBottom: number;
    metaBottom: number;
    summaryMaxHeight: number;
    stageScale: number;
    stagePerspective: number;
    navBottom: string;
    navRight: number;
    actionCompact: boolean;
};

const STACK_SLOTS: StackState[] = [
    { x: 0, y: 0, scale: 1, rotateX: 0, rotateZ: 0, opacity: 1, zIndex: 120, blur: 0 },
    { x: 90, y: -40, scale: 0.92, rotateX: 6, rotateZ: -4, opacity: 0.94, zIndex: 80, blur: 0 },
    { x: 170, y: -85, scale: 0.84, rotateX: 10, rotateZ: -7, opacity: 0.85, zIndex: 50, blur: 0 },
    { x: 230, y: -130, scale: 0.76, rotateX: 13, rotateZ: -9, opacity: 0.65, zIndex: 25, blur: 0 },
    { x: 280, y: -175, scale: 0.68, rotateX: 15, rotateZ: -11, opacity: 0.45, zIndex: 10, blur: 0 }
];

const OFFSCREEN_RIGHT: StackState = {
    x: 350,
    y: -220,
    scale: 0.6,
    rotateX: 20,
    rotateZ: -15,
    opacity: 0,
    zIndex: 0,
    blur: 0
};

const OFFSCREEN_LEFT: StackState = {
    x: -120,
    y: 120,
    scale: 1.2,
    rotateX: -10,
    rotateZ: 5,
    opacity: 0,
    zIndex: 150,
    blur: 0
};

function normalizeIndex(index: number, total: number): number {
    if (total <= 0) return 0;
    return ((index % total) + total) % total;
}

function lerp(from: number, to: number, progress: number) {
    return from + (to - from) * progress;
}

function easeOutQuart(progress: number) {
    return 1 - Math.pow(1 - progress, 4);
}

function stringToColor(text: string) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hex = (hash & 0x00ffffff).toString(16).toUpperCase();
    return `#${'00000'.substring(0, 6 - hex.length)}${hex}`;
}

function generateGradient(seed: string) {
    const c1 = stringToColor(seed);
    const c2 = stringToColor(seed.split('').reverse().join(''));
    return `linear-gradient(155deg, ${c1}, ${c2})`;
}

function uniqueIndices(first: number[], second: number[]) {
    return [...new Set([...first, ...second])];
}

function parseFormatting(formatting?: string): Record<string, any> {
    if (!formatting) return {};
    try {
        const parsed = JSON.parse(formatting);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

function readNovelAuthor(novel?: any): string {
    if (!novel) return '';
    const formatting = parseFormatting(novel.formatting);
    return typeof formatting.author === 'string' ? formatting.author : '';
}

export default function Home() {
    const { t } = useTranslation();
    const { preferences } = useEditorPreferences();
    const isDarkTheme = preferences.theme === 'dark';
    const [viewportSize, setViewportSize] = useState(() => ({
        width: typeof window === 'undefined' ? 1500 : window.innerWidth,
        height: typeof window === 'undefined' ? 900 : window.innerHeight
    }));

    const [selectedNovelId, setSelectedNovelId] = useState<string | null>(() => {
        try {
            return sessionStorage.getItem(ACTIVE_NOVEL_STORAGE_KEY);
        } catch {
            return null;
        }
    });
    const [novels, setNovels] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeDeckIndex, setActiveDeckIndex] = useState(0);
    const [isDeckAnimating, setIsDeckAnimating] = useState(false);
    const [visibleIndices, setVisibleIndices] = useState<number[]>([]);
    const [cardStateMap, setCardStateMap] = useState<Record<number, StackState>>({});

    const [isGlobalSettingsOpen, setIsGlobalSettingsOpen] = useState(false);
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [isLibrarySearchOpen, setIsLibrarySearchOpen] = useState(false);
    const [librarySearchQuery, setLibrarySearchQuery] = useState('');
    const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
    const [pendingDeleteNovelId, setPendingDeleteNovelId] = useState<string | null>(null);
    const [isDeletingNovel, setIsDeletingNovel] = useState(false);
    const [droppingNovelId, setDroppingNovelId] = useState<string | null>(null);
    const [editForm, setEditForm] = useState({ title: '', coverUrl: '', description: '', author: '' });

    const animationFrameRef = useRef<number | null>(null);
    const wheelAccumulatorRef = useRef(0);
    const librarySearchInputRef = useRef<HTMLInputElement | null>(null);

    const activeNovel = useMemo(() => {
        if (!novels.length) return null;
        return novels[normalizeIndex(activeDeckIndex, novels.length)];
    }, [activeDeckIndex, novels]);
    const pendingDeleteNovel = useMemo(() => {
        if (!pendingDeleteNovelId) return null;
        return novels.find((novel) => novel.id === pendingDeleteNovelId) || null;
    }, [novels, pendingDeleteNovelId]);
    const filteredNovels = useMemo(() => {
        const keyword = librarySearchQuery.trim().toLowerCase();
        if (!keyword) {
            return novels.map((novel, index) => ({ novel, index }));
        }
        return novels
            .map((novel, index) => ({ novel, index }))
            .filter(({ novel }) => {
                const title = String(novel.title || '').toLowerCase();
                const author = readNovelAuthor(novel).toLowerCase();
                const description = String(novel.description || '').toLowerCase();
                return title.includes(keyword) || author.includes(keyword) || description.includes(keyword);
            });
    }, [librarySearchQuery, novels]);

    const orderedVisibleIndices = useMemo(() => {
        return [...visibleIndices].sort((a, b) => (cardStateMap[a]?.zIndex ?? 0) - (cardStateMap[b]?.zIndex ?? 0));
    }, [cardStateMap, visibleIndices]);

    const displayTitle = isEditorOpen ? editForm.title.trim() || activeNovel?.title || '-' : activeNovel?.title || '-';
    const displayAuthor = isEditorOpen
        ? editForm.author.trim() || t('home.authorFallback', { defaultValue: '-' })
        : readNovelAuthor(activeNovel) || t('home.authorFallback', { defaultValue: '-' });
    const displayWordCount = useMemo(() => {
        const raw = Number(activeNovel?.wordCount ?? 0);
        if (!Number.isFinite(raw) || raw < 0) return 0;
        return Math.round(raw);
    }, [activeNovel?.wordCount]);
    const displayDescription = isEditorOpen
        ? editForm.description.trim() || t('home.deckDescriptionFallback', { title: displayTitle })
        : activeNovel?.description?.trim() || t('home.deckDescriptionFallback', { title: displayTitle });

    const layoutPreset = useMemo<HomeLayoutPreset>(() => {
        const { width, height } = viewportSize;
        if (width >= 1500) {
            return {
                tier: 'wide',
                shellPadding: 40,
                sectionMaxWidth: 1400,
                sectionMaxHeight: 860,
                sectionPaddingX: 100,
                leftColumnWidth: 420,
                headlineSize: 82,
                headlineBottom: 40,
                metaBottom: 40,
                summaryMaxHeight: 260,
                stageScale: height < 860 ? Math.max(0.84, height / 860) : 1,
                stagePerspective: 2500,
                navBottom: '10%',
                navRight: 0,
                actionCompact: false
            };
        }
        if (width >= 1280) {
            return {
                tier: 'medium',
                shellPadding: 30,
                sectionMaxWidth: 1280,
                sectionMaxHeight: 790,
                sectionPaddingX: 72,
                leftColumnWidth: 380,
                headlineSize: 68,
                headlineBottom: 32,
                metaBottom: 28,
                summaryMaxHeight: 210,
                stageScale: height < 760 ? Math.max(0.78, height / 760) : 0.9,
                stagePerspective: 2200,
                navBottom: '8%',
                navRight: -8,
                actionCompact: false
            };
        }
        return {
            tier: 'compact',
            shellPadding: 20,
            sectionMaxWidth: 1160,
            sectionMaxHeight: 730,
            sectionPaddingX: 44,
            leftColumnWidth: 340,
            headlineSize: 56,
            headlineBottom: 24,
            metaBottom: 22,
            summaryMaxHeight: 160,
            stageScale: height < 700 ? Math.max(0.7, height / 700) : 0.78,
            stagePerspective: 1900,
            navBottom: '7%',
            navRight: -12,
            actionCompact: true
        };
    }, [viewportSize]);

    const cardWidth = Math.round(BASE_CARD_WIDTH * layoutPreset.stageScale);
    const cardHeight = Math.round(BASE_CARD_HEIGHT * layoutPreset.stageScale);
    const cardPadding = Math.max(22, Math.round(BASE_CARD_PADDING * layoutPreset.stageScale));
    const cardTitleSize = Math.max(30, Math.round(48 * layoutPreset.stageScale));

    const getVisibleIndices = useCallback((startIndex: number) => {
        if (!novels.length) return [];
        const count = Math.min(VISIBLE_STACK_COUNT, novels.length);
        const result: number[] = [];
        for (let i = 0; i < count; i++) {
            result.push(normalizeIndex(startIndex + i, novels.length));
        }
        return result;
    }, [novels.length]);

    const buildIdleStateMap = useCallback((startIndex: number) => {
        const indices = getVisibleIndices(startIndex);
        const map: Record<number, StackState> = {};
        indices.forEach((index, slotPos) => {
            map[index] = { ...STACK_SLOTS[slotPos] };
        });
        return { indices, map };
    }, [getVisibleIndices]);

    const cancelAnimation = useCallback(() => {
        if (animationFrameRef.current) {
            window.cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
    }, []);

    const applyIdleScene = useCallback((index: number) => {
        if (!novels.length) {
            setVisibleIndices([]);
            setCardStateMap({});
            return;
        }
        const normalized = normalizeIndex(index, novels.length);
        const { indices, map } = buildIdleStateMap(normalized);
        setVisibleIndices(indices);
        setCardStateMap(map);
    }, [buildIdleStateMap, novels.length]);

    const animateDirectTo = useCallback((targetIndex: number) => {
        if (!novels.length || isDeckAnimating) return;

        const normalizedTarget = normalizeIndex(targetIndex, novels.length);
        if (normalizedTarget === activeDeckIndex) return;

        cancelAnimation();
        setIsDeckAnimating(true);

        const currentVisible = getVisibleIndices(activeDeckIndex);
        const targetVisible = getVisibleIndices(normalizedTarget);
        const allIndices = uniqueIndices(currentVisible, targetVisible);
        const startStates: Record<number, StackState> = {};
        const endStates: Record<number, StackState> = {};

        const delta = normalizedTarget - activeDeckIndex;
        const isNext = delta === 1 || delta < -1;

        for (const index of allIndices) {
            const fromPos = currentVisible.indexOf(index);
            const toPos = targetVisible.indexOf(index);

            startStates[index] = fromPos !== -1
                ? { ...STACK_SLOTS[fromPos] }
                : { ...(isNext ? OFFSCREEN_RIGHT : OFFSCREEN_LEFT) };

            endStates[index] = toPos !== -1
                ? { ...STACK_SLOTS[toPos] }
                : { ...(isNext ? OFFSCREEN_LEFT : OFFSCREEN_RIGHT) };
        }

        setVisibleIndices(allIndices);
        setCardStateMap(startStates);

        let startTime: number | null = null;
        const frame = (timestamp: number) => {
            if (!startTime) startTime = timestamp;
            const raw = Math.min((timestamp - startTime) / ANIMATION_DURATION_MS, 1);
            const eased = easeOutQuart(raw);

            const nextMap: Record<number, StackState> = {};
            for (const index of allIndices) {
                const fromState = startStates[index];
                const toState = endStates[index];
                nextMap[index] = {
                    x: lerp(fromState.x, toState.x, eased),
                    y: lerp(fromState.y, toState.y, eased),
                    scale: lerp(fromState.scale, toState.scale, eased),
                    rotateX: lerp(fromState.rotateX, toState.rotateX, eased),
                    rotateZ: lerp(fromState.rotateZ, toState.rotateZ, eased),
                    opacity: lerp(fromState.opacity, toState.opacity, eased),
                    zIndex: Math.round(lerp(fromState.zIndex, toState.zIndex, eased)),
                    blur: lerp(fromState.blur, toState.blur, eased)
                };
            }

            setCardStateMap(nextMap);

            if (raw < 1) {
                animationFrameRef.current = window.requestAnimationFrame(frame);
                return;
            }

            animationFrameRef.current = null;
            setActiveDeckIndex(normalizedTarget);
            const { indices, map } = buildIdleStateMap(normalizedTarget);
            setVisibleIndices(indices);
            setCardStateMap(map);
            setIsDeckAnimating(false);
        };

        animationFrameRef.current = window.requestAnimationFrame(frame);
    }, [activeDeckIndex, buildIdleStateMap, cancelAnimation, getVisibleIndices, isDeckAnimating, novels.length]);

    const goNext = useCallback(() => {
        if (!novels.length || isDeletingNovel) return;
        animateDirectTo(activeDeckIndex + 1);
    }, [activeDeckIndex, animateDirectTo, isDeletingNovel, novels.length]);

    const goPrev = useCallback(() => {
        if (!novels.length || isDeletingNovel) return;
        animateDirectTo(activeDeckIndex - 1);
    }, [activeDeckIndex, animateDirectTo, isDeletingNovel, novels.length]);

    const startOpenNovel = useCallback(() => {
        if (!activeNovel || isDeckAnimating || isEditorOpen || isLibrarySearchOpen || isDeleteConfirmOpen || isDeletingNovel) return;
        setSelectedNovelId(activeNovel.id);
    }, [activeNovel, isDeckAnimating, isDeleteConfirmOpen, isDeletingNovel, isEditorOpen, isLibrarySearchOpen]);

    const openEditorForActiveNovel = useCallback(() => {
        if (!activeNovel) return;
        setEditForm({
            title: activeNovel.title || '',
            coverUrl: activeNovel.coverUrl || '',
            description: activeNovel.description || '',
            author: readNovelAuthor(activeNovel)
        });
        setPendingDeleteNovelId(activeNovel.id);
        setIsEditorOpen(true);
    }, [activeNovel]);

    const closeEditor = useCallback(() => {
        setIsEditorOpen(false);
        setIsDeleteConfirmOpen(false);
        setPendingDeleteNovelId(null);
    }, []);

    const openLibrarySearch = useCallback(() => {
        if (!novels.length || isDeletingNovel) return;
        setLibrarySearchQuery('');
        setIsLibrarySearchOpen(true);
    }, [isDeletingNovel, novels.length]);

    const closeLibrarySearch = useCallback(() => {
        setIsLibrarySearchOpen(false);
    }, []);

    const selectNovelFromSearch = useCallback((index: number) => {
        setIsLibrarySearchOpen(false);
        setLibrarySearchQuery('');
        animateDirectTo(index);
    }, [animateDirectTo]);

    async function loadNovels(options?: { preserveFrontNovelId?: string }) {
        try {
            const data = await window.db.getNovels();
            setNovels(data);
            if (!selectedNovelId && options?.preserveFrontNovelId) {
                const nextFrontIndex = data.findIndex((novel) => novel.id === options.preserveFrontNovelId);
                if (nextFrontIndex >= 0) {
                    setActiveDeckIndex(nextFrontIndex);
                }
            }
            if (selectedNovelId && !data.some((novel) => novel.id === selectedNovelId)) {
                setSelectedNovelId(null);
            }
        } catch (error) {
            console.error('[Home] Failed to load novels', error);
        } finally {
            setLoading(false);
        }
    }

    async function handleCreateNovel() {
        const title = `${t('home.newNovelPrefix', { defaultValue: '新作品' })} ${new Date().toLocaleTimeString()}`;
        try {
            const createdNovel = await window.db.createNovel(title);
            await loadNovels({ preserveFrontNovelId: createdNovel.id });
        } catch (error) {
            console.error('[Home] create novel failed:', error);
            const fallback = t('common.unknownError', { defaultValue: 'Unknown error' });
            alert(`${t('home.createFailed', { defaultValue: 'Create failed' })}: ${getErrorMessage(error, fallback)}`);
        }
    }

    async function handleImportNovel() {
        try {
            const imported = await window.db.importNovelFile();
            if (!imported?.novelId) return;
            await loadNovels({ preserveFrontNovelId: imported.novelId });
            setSelectedNovelId(imported.novelId);
        } catch (error) {
            console.error('[Home] import novel failed:', error);
            const fallback = t('common.unknownError', { defaultValue: 'Unknown error' });
            alert(`${t('home.importFailed', { defaultValue: 'Import failed' })}: ${getErrorMessage(error, fallback)}`);
        }
    }

    async function saveEdit() {
        if (!activeNovel || isDeletingNovel) return;
        const editingNovelId = activeNovel.id;
        try {
            const nextFormatting = parseFormatting(activeNovel.formatting);
            const nextAuthor = editForm.author.trim();
            if (nextAuthor) {
                nextFormatting.author = nextAuthor;
            } else {
                delete nextFormatting.author;
            }
            const patchData: { title?: string; coverUrl?: string; description?: string; formatting?: string } = {
                title: editForm.title.trim() || activeNovel.title,
                coverUrl: editForm.coverUrl.trim() || undefined,
                formatting: JSON.stringify(nextFormatting)
            };
            const nextDescription = editForm.description.trim();
            if (nextDescription) {
                patchData.description = nextDescription;
            }
            await window.db.updateNovel({
                id: activeNovel.id,
                data: patchData
            });
            setIsEditorOpen(false);
            await loadNovels({ preserveFrontNovelId: editingNovelId });
        } catch (error) {
            const fallback = t('common.unknownError', { defaultValue: 'Unknown error' });
            alert(`${t('home.saveFailed', { defaultValue: 'Save failed' })}: ${getErrorMessage(error, fallback)}`);
        }
    }

    async function uploadCoverForActiveNovel() {
        if (!activeNovel) return;
        const result = await window.db.uploadNovelCover(activeNovel.id);
        if (result?.path) {
            setEditForm((prev) => ({ ...prev, coverUrl: result.path }));
        }
    }

    const openDeleteConfirm = useCallback(() => {
        if (!activeNovel || isDeletingNovel) return;
        setPendingDeleteNovelId(activeNovel.id);
        setIsDeleteConfirmOpen(true);
    }, [activeNovel, isDeletingNovel]);

    const closeDeleteConfirm = useCallback(() => {
        if (isDeletingNovel) return;
        setIsDeleteConfirmOpen(false);
    }, [isDeletingNovel]);

    const confirmDeleteNovel = useCallback(async () => {
        if (isDeletingNovel) return;
        const targetNovelId = pendingDeleteNovelId || activeNovel?.id;
        if (!targetNovelId) return;

        const removingIndex = novels.findIndex((novel) => novel.id === targetNovelId);
        if (removingIndex < 0) {
            setIsDeleteConfirmOpen(false);
            setPendingDeleteNovelId(null);
            return;
        }

        try {
            cancelAnimation();
            setIsDeleteConfirmOpen(false);
            setIsEditorOpen(false);
            setIsDeckAnimating(true);
            setIsDeletingNovel(true);
            setDroppingNovelId(targetNovelId);

            await new Promise<void>((resolve) => {
                window.setTimeout(() => resolve(), DELETE_DROP_DURATION_MS);
            });

            await window.db.deleteNovel(targetNovelId);
            const data = await window.db.getNovels();
            setNovels(data);

            if (!data.length) {
                setActiveDeckIndex(0);
            } else {
                setActiveDeckIndex(Math.min(removingIndex, data.length - 1));
            }
        } catch (error) {
            console.error('[Home] delete novel failed:', error);
            const fallback = t('common.unknownError', { defaultValue: 'Unknown error' });
            alert(`${t('home.deleteNovelFailed', { defaultValue: 'Delete failed' })}: ${getErrorMessage(error, fallback)}`);
        } finally {
            setDroppingNovelId(null);
            setPendingDeleteNovelId(null);
            setIsDeletingNovel(false);
            setIsDeckAnimating(false);
        }
    }, [activeNovel?.id, cancelAnimation, isDeletingNovel, novels, pendingDeleteNovelId, t]);

    useEffect(() => {
        loadNovels();
    }, []);

    useEffect(() => {
        const handleResize = () => {
            setViewportSize({ width: window.innerWidth, height: window.innerHeight });
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    useEffect(() => {
        try {
            if (selectedNovelId) {
                sessionStorage.setItem(ACTIVE_NOVEL_STORAGE_KEY, selectedNovelId);
            } else {
                sessionStorage.removeItem(ACTIVE_NOVEL_STORAGE_KEY);
            }
        } catch (error) {
            console.warn('[Home] failed to persist active novel id', error);
        }
    }, [selectedNovelId]);

    useEffect(() => {
        if (!selectedNovelId) {
            loadNovels();
        }
    }, [selectedNovelId]);

    useEffect(() => {
        if (!isLibrarySearchOpen) return;
        const timer = window.setTimeout(() => {
            librarySearchInputRef.current?.focus();
        }, 40);
        return () => window.clearTimeout(timer);
    }, [isLibrarySearchOpen]);

    useEffect(() => {
        if (selectedNovelId) {
            setIsEditorOpen(false);
            setIsLibrarySearchOpen(false);
            setLibrarySearchQuery('');
            setIsDeleteConfirmOpen(false);
            setPendingDeleteNovelId(null);
            setIsDeletingNovel(false);
            setDroppingNovelId(null);
        }
    }, [selectedNovelId]);

    useEffect(() => {
        if (!novels.length) {
            setActiveDeckIndex(0);
            setVisibleIndices([]);
            setCardStateMap({});
            return;
        }
        const normalized = normalizeIndex(activeDeckIndex, novels.length);
        if (normalized !== activeDeckIndex) {
            setActiveDeckIndex(normalized);
            return;
        }
        if (!selectedNovelId && !isDeckAnimating) {
            applyIdleScene(normalized);
        }
    }, [activeDeckIndex, applyIdleScene, isDeckAnimating, novels.length, selectedNovelId]);

    useEffect(() => {
        if (selectedNovelId || !novels.length) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (isDeleteConfirmOpen) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeDeleteConfirm();
                } else if (event.key === 'Enter') {
                    event.preventDefault();
                    void confirmDeleteNovel();
                }
                return;
            }

            if (isLibrarySearchOpen) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeLibrarySearch();
                } else if (event.key === 'Enter' && filteredNovels.length === 1) {
                    event.preventDefault();
                    selectNovelFromSearch(filteredNovels[0].index);
                }
                return;
            }

            if (event.key === 'Escape') {
                if (isEditorOpen) {
                    event.preventDefault();
                    closeEditor();
                }
                return;
            }

            if (event.key === 'Enter') {
                if (isEditorOpen) {
                    const target = event.target as HTMLElement | null;
                    const isTextarea = target?.tagName === 'TEXTAREA';
                    const canSave = !isTextarea || event.ctrlKey || event.metaKey;
                    if (!canSave) return;
                    event.preventDefault();
                    void saveEdit();
                } else {
                    event.preventDefault();
                    startOpenNovel();
                }
                return;
            }

            if (isEditorOpen || isDeckAnimating) return;

            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                goPrev();
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                goNext();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [closeDeleteConfirm, closeEditor, closeLibrarySearch, confirmDeleteNovel, filteredNovels, goNext, goPrev, isDeleteConfirmOpen, isDeckAnimating, isEditorOpen, isLibrarySearchOpen, novels.length, saveEdit, selectNovelFromSearch, selectedNovelId, startOpenNovel]);

    useEffect(() => {
        if (selectedNovelId || !novels.length || isEditorOpen || isLibrarySearchOpen || isDeleteConfirmOpen || isDeletingNovel) return;

        const handleWheel = (event: WheelEvent) => {
            if (isDeckAnimating) return;
            wheelAccumulatorRef.current += event.deltaY;
            if (wheelAccumulatorRef.current >= WHEEL_THRESHOLD) {
                wheelAccumulatorRef.current = 0;
                goNext();
            } else if (wheelAccumulatorRef.current <= -WHEEL_THRESHOLD) {
                wheelAccumulatorRef.current = 0;
                goPrev();
            }
        };

        window.addEventListener('wheel', handleWheel, { passive: true });
        return () => window.removeEventListener('wheel', handleWheel);
    }, [goNext, goPrev, isDeckAnimating, isDeleteConfirmOpen, isDeletingNovel, isEditorOpen, isLibrarySearchOpen, novels.length, selectedNovelId]);

    useEffect(() => {
        return () => {
            cancelAnimation();
        };
    }, [cancelAnimation]);

    return (
        <div className={clsx(
            'relative h-screen w-full overflow-hidden transition-colors',
            isDarkTheme ? 'dark bg-[#0b0b10] text-white' : 'bg-[#f2f2f2] text-black'
        )}>
            {isDarkTheme && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0"
                    style={{
                        background:
                            'radial-gradient(circle at 14% 18%, rgba(99,102,241,0.11), transparent 26%), radial-gradient(circle at 82% 24%, rgba(168,85,247,0.08), transparent 24%), radial-gradient(circle at 78% 78%, rgba(59,130,246,0.08), transparent 22%)'
                    }}
                />
            )}
            <AnimatePresence mode="wait">
                {!selectedNovelId ? (
                    <motion.div
                        key="home-shell"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.35 }}
                        className="flex h-screen w-full items-center justify-center"
                        style={{ padding: layoutPreset.shellPadding }}
                    >
                        <section
                            className={clsx(
                                'relative flex h-full w-full items-center rounded-[40px] transition-[opacity,background-color,border-color,box-shadow] duration-500',
                                isDarkTheme
                                    ? 'overflow-hidden bg-[linear-gradient(180deg,#16161d_0%,#121219_60%,#101016_100%)] shadow-[0_50px_120px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.03)]'
                                    : 'bg-white shadow-[0_40px_100px_rgba(0,0,0,0.05)]',
                                isEditorOpen && 'pointer-events-none opacity-15'
                            )}
                            style={{
                                maxWidth: layoutPreset.sectionMaxWidth,
                                maxHeight: layoutPreset.sectionMaxHeight,
                                paddingLeft: layoutPreset.sectionPaddingX,
                                paddingRight: layoutPreset.sectionPaddingX
                            }}
                        >
                            {isDarkTheme && (
                                <>
                                    <div
                                        aria-hidden="true"
                                        className="pointer-events-none absolute inset-0"
                                        style={{
                                            background:
                                                'radial-gradient(circle at 18% 22%, rgba(99,102,241,0.08), transparent 24%), radial-gradient(circle at 82% 30%, rgba(59,130,246,0.06), transparent 26%), linear-gradient(90deg, rgba(255,255,255,0.015), transparent 24%, transparent 76%, rgba(255,255,255,0.01))'
                                        }}
                                    />
                                    <div className="pointer-events-none absolute inset-y-16 left-[48%] w-px bg-gradient-to-b from-transparent via-white/6 to-transparent" />
                                </>
                            )}
                            <div className="flex h-[78%] min-h-0 shrink-0 flex-col" style={{ width: layoutPreset.leftColumnWidth }}>
                                <div className={clsx(
                                    'mb-6 inline-flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.2em]',
                                    isDarkTheme ? 'text-neutral-400' : 'text-neutral-500'
                                )}>
                                    <span className={clsx('h-px w-9', isDarkTheme ? 'bg-gradient-to-r from-white/80 to-white/10' : 'bg-black')} />
                                    {t('home.deckStudioLabel', { defaultValue: 'Archive Studio' })}
                                </div>

                                <h1
                                    className="leading-[1.05] font-black tracking-[-0.04em]"
                                    style={{
                                        fontSize: `clamp(44px, ${layoutPreset.headlineSize / 14}vw, ${layoutPreset.headlineSize}px)`,
                                        marginBottom: layoutPreset.headlineBottom
                                    }}
                                >
                                    {t('home.deckHeadline')}
                                </h1>

                                <div className="grid grid-cols-3 gap-4" style={{ marginBottom: layoutPreset.metaBottom }}>
                                    <div className={clsx(
                                        'rounded-2xl px-4 py-3',
                                        isDarkTheme ? 'bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]' : ''
                                    )}>
                                          <span className={clsx('mb-2 block text-[10px] font-bold uppercase tracking-[0.18em]', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>{t('home.title')}</span>
                                          <span className={clsx('block text-base font-bold leading-tight', isDarkTheme ? 'text-neutral-50' : 'text-black')}>{displayTitle}</span>
                                      </div>
                                      <div className={clsx(
                                        'rounded-2xl px-4 py-3',
                                        isDarkTheme ? 'bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]' : ''
                                    )}>
                                          <span className={clsx('mb-2 block text-[10px] font-bold uppercase tracking-[0.18em]', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>{t('home.author')}</span>
                                          <span className={clsx('block truncate text-base font-bold leading-tight', isDarkTheme ? 'text-neutral-50' : 'text-black')}>{displayAuthor}</span>
                                    </div>
                                    <div className={clsx(
                                        'rounded-2xl px-4 py-3',
                                        isDarkTheme ? 'bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]' : ''
                                    )}>
                                          <span className={clsx('mb-2 block text-[10px] font-bold uppercase tracking-[0.18em]', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>{t('home.words')}</span>
                                          <span className={clsx('block text-base font-bold leading-tight', isDarkTheme ? 'text-neutral-200' : 'text-neutral-700')}>
                                              {displayWordCount.toLocaleString()} {t('home.words')}
                                          </span>
                                    </div>
                                </div>

                                <div
                                      className={clsx(
                                          'relative min-h-0 flex-1 overflow-y-auto rounded-[26px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                                          isDarkTheme
                                              ? 'bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] px-6 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
                                              : 'border border-[#f0f0f0] pl-6'
                                      )}
                                      style={{ maxHeight: layoutPreset.summaryMaxHeight }}
                                  >
                                      {isDarkTheme && (
                                          <div className="pointer-events-none absolute inset-y-5 left-6 w-px bg-gradient-to-b from-transparent via-indigo-300/45 to-transparent" />
                                      )}
                                      <span className={clsx('mb-2 block text-[10px] font-bold uppercase', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>
                                          {t('home.deckSummaryLabel', { defaultValue: 'Summary' })}
                                      </span>
                                      <div className={clsx('scroll-smooth text-sm leading-7', isDarkTheme ? 'pl-5 text-neutral-300/95' : 'text-neutral-600')}>
                                          {displayDescription}
                                      </div>
                                  </div>

                                <div className={clsx('mt-5 gap-3', layoutPreset.actionCompact ? 'grid grid-cols-3' : 'flex flex-wrap')}>
                                    <button
                                        type="button"
                                        onClick={startOpenNovel}
                                        className={clsx(
                                            'inline-flex items-center gap-2 rounded-xl px-6 py-3.5 text-sm font-bold transition',
                                            layoutPreset.actionCompact && 'col-span-3 justify-center py-3 text-[15px]',
                                            isDarkTheme
                                                ? 'bg-[linear-gradient(135deg,#6366f1,#4f46e5_52%,#7c3aed)] text-white shadow-[0_16px_36px_rgba(79,70,229,0.32),inset_0_1px_0_rgba(255,255,255,0.18)] hover:translate-y-[-1px] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60'
                                                : 'bg-black text-white hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-60'
                                        )}
                                        disabled={!activeNovel || isDeletingNovel || isDeleteConfirmOpen}
                                    >
                                        <BookOpen className={clsx(layoutPreset.actionCompact ? 'h-4.5 w-4.5' : 'h-4 w-4')} />
                                        {t('home.continue')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleCreateNovel}
                                        disabled={isDeletingNovel || isDeleteConfirmOpen}
                                        className={clsx(
                                            'inline-flex rounded-xl text-sm font-bold transition',
                                            layoutPreset.actionCompact
                                                ? 'h-[96px] flex-col items-center justify-center gap-2 px-3 text-center text-[15px]'
                                                : 'items-center justify-center gap-2 px-4 py-3.5',
                                            isDarkTheme
                                                ? 'bg-white/[0.04] text-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60'
                                                : 'bg-[#f5f5f5] hover:bg-[#ececec] disabled:cursor-not-allowed disabled:opacity-60'
                                        )}
                                    >
                                        <Plus className={clsx(layoutPreset.actionCompact ? 'h-4.5 w-4.5' : 'h-4 w-4')} />
                                        <span className={clsx(layoutPreset.actionCompact ? 'whitespace-nowrap leading-none' : '')}>
                                            {t(layoutPreset.actionCompact ? 'home.createShort' : 'home.create')}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleImportNovel}
                                        disabled={isDeletingNovel || isDeleteConfirmOpen}
                                        className={clsx(
                                            'inline-flex rounded-xl text-sm font-bold transition',
                                            layoutPreset.actionCompact
                                                ? 'h-[96px] flex-col items-center justify-center gap-2 px-3 text-center text-[15px]'
                                                : 'items-center justify-center gap-2 px-4 py-3.5',
                                            isDarkTheme
                                                ? 'bg-white/[0.04] text-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60'
                                                : 'bg-[#f5f5f5] hover:bg-[#ececec] disabled:cursor-not-allowed disabled:opacity-60'
                                        )}
                                    >
                                        <Upload className={clsx(layoutPreset.actionCompact ? 'h-4.5 w-4.5' : 'h-4 w-4')} />
                                        <span className={clsx(layoutPreset.actionCompact ? 'whitespace-nowrap leading-none' : '')}>
                                            {t('home.importNovel', { defaultValue: '导入小说' })}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={openEditorForActiveNovel}
                                        disabled={!activeNovel || isDeletingNovel || isDeleteConfirmOpen}
                                        className={clsx(
                                            'inline-flex rounded-xl text-sm font-bold transition',
                                            layoutPreset.actionCompact
                                                ? 'h-[96px] flex-col items-center justify-center gap-2 px-3 text-center text-[15px]'
                                                : 'items-center justify-center px-4 py-3.5',
                                            activeNovel && !isDeletingNovel && !isDeleteConfirmOpen
                                                ? (isDarkTheme ? 'bg-white/[0.04] text-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:bg-white/[0.08]' : 'bg-[#f5f5f5] hover:bg-[#ececec]')
                                                : (isDarkTheme ? 'cursor-not-allowed bg-white/[0.025] text-neutral-500' : 'cursor-not-allowed bg-neutral-200 text-neutral-400')
                                        )}
                                    >
                                        <Settings className={clsx(layoutPreset.actionCompact ? 'h-4.5 w-4.5' : 'hidden')} />
                                        <span className={clsx(layoutPreset.actionCompact ? 'whitespace-nowrap leading-none' : '')}>
                                            {t(layoutPreset.actionCompact ? 'home.editNovelShort' : 'home.editNovel')}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={openLibrarySearch}
                                        disabled={!novels.length || isDeletingNovel || isDeleteConfirmOpen}
                                        className={clsx(
                                            'inline-flex rounded-xl text-sm font-bold transition',
                                            layoutPreset.actionCompact
                                                ? 'h-[96px] flex-col items-center justify-center gap-2 px-3 text-center text-[15px]'
                                                : 'items-center justify-center gap-2 px-4 py-3.5',
                                            novels.length && !isDeletingNovel && !isDeleteConfirmOpen
                                                ? (isDarkTheme ? 'bg-white/[0.04] text-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:bg-white/[0.08]' : 'bg-[#f5f5f5] hover:bg-[#ececec]')
                                                : (isDarkTheme ? 'cursor-not-allowed bg-white/[0.025] text-neutral-500' : 'cursor-not-allowed bg-neutral-200 text-neutral-400')
                                        )}
                                    >
                                        <Search className={clsx(layoutPreset.actionCompact ? 'h-4.5 w-4.5' : 'h-4 w-4')} />
                                        <span className={clsx(layoutPreset.actionCompact ? 'whitespace-nowrap leading-none' : '')}>
                                            {t('home.searchAllNovels')}
                                        </span>
                                    </button>
                                </div>
                            </div>

                            <div className="relative h-full min-w-0 grow" style={{ perspective: layoutPreset.stagePerspective }}>
                                {isDarkTheme && (
                                    <div
                                        aria-hidden="true"
                                        className="pointer-events-none absolute left-[58%] top-[52%] h-[380px] w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
                                        style={{
                                            background: 'radial-gradient(circle, rgba(99,102,241,0.14) 0%, rgba(99,102,241,0.06) 38%, transparent 72%)'
                                        }}
                                    />
                                )}
                                <div className="absolute inset-0 [transform-style:preserve-3d]">
                                    {orderedVisibleIndices.map((index) => {
                                        const novel = novels[index];
                                        const state = cardStateMap[index];
                                        if (!novel || !state) return null;

                                        const isFront = index === normalizeIndex(activeDeckIndex, novels.length);
                                        const hasCover = Boolean(novel.coverUrl);
                                        const cardTitle = isEditorOpen && isFront
                                            ? editForm.title.trim() || (novel.title || '').trim() || '-'
                                            : (novel.title || '').trim() || '-';
                                        return (
                                            <button
                                                key={novel.id}
                                                type="button"
                                                onClick={() => {
                                                    if (isDeckAnimating || isEditorOpen || isLibrarySearchOpen || isDeletingNovel || isDeleteConfirmOpen) return;
                                                    if (isFront) {
                                                        startOpenNovel();
                                                        return;
                                                    }
                                                    animateDirectTo(index);
                                                }}
                                                className={clsx(
                                                    'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[20px]',
                                                    isDarkTheme
                                                        ? 'border border-white/[0.08] text-left shadow-[0_32px_70px_rgba(0,0,0,0.38)]'
                                                        : 'border border-black/10 text-left shadow-[0_20px_50px_rgba(0,0,0,0.15)]',
                                                    isFront && (isDarkTheme ? 'ring-1 ring-white/[0.08]' : 'ring-1 ring-black/20'),
                                                    droppingNovelId === novel.id && 'pointer-events-none'
                                                )}
                                                style={{
                                                    opacity: droppingNovelId === novel.id ? 0 : state.opacity,
                                                    zIndex: droppingNovelId === novel.id ? 300 : state.zIndex,
                                                    filter: `blur(${state.blur}px)`,
                                                    transformStyle: 'preserve-3d',
                                                    transition: 'opacity 300ms, transform 800ms cubic-bezier(0.16, 1, 0.3, 1)',
                                                    width: cardWidth,
                                                    height: cardHeight,
                                                    transform: droppingNovelId === novel.id
                                                        ? `translate3d(calc(-50% + ${state.x * layoutPreset.stageScale}px), calc(-50% + ${(state.y + 820) * layoutPreset.stageScale}px), -200px) rotateX(-30deg) rotateZ(15deg) scale(${Math.max(0.65, state.scale * 0.8)})`
                                                        : `translate3d(calc(-50% + ${state.x * layoutPreset.stageScale}px), calc(-50% + ${state.y * layoutPreset.stageScale}px), ${state.zIndex}px) rotateX(${state.rotateX}deg) rotateZ(${state.rotateZ}deg) scale(${state.scale})`
                                                }}
                                            >
                                                <div
                                                    className="absolute inset-0"
                                                    style={hasCover ? undefined : { background: generateGradient(cardTitle) }}
                                                />
                                                {hasCover && (
                                                    <img
                                                        src={novel.coverUrl.startsWith('covers/') ? `local-resource://${novel.coverUrl}` : novel.coverUrl}
                                                        alt={cardTitle}
                                                        className="absolute inset-0 h-full w-full object-cover"
                                                    />
                                                )}
                                                <div className={clsx('relative z-10 h-full', hasCover && 'opacity-0')} style={{ padding: cardPadding }}>
                                                    <div
                                                        className="h-full overflow-hidden font-black tracking-[-0.02em] break-words"
                                                        style={{ fontSize: cardTitleSize, lineHeight: 1.08 }}
                                                    >
                                                        {cardTitle}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="absolute z-20 flex gap-3" style={{ bottom: layoutPreset.navBottom, right: layoutPreset.navRight }}>
                                    <button
                                        type="button"
                                        onClick={goPrev}
                                        className={clsx(
                                            'flex h-[46px] w-[46px] items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-45',
                                            isDarkTheme
                                                ? 'bg-black/28 text-neutral-300 shadow-[0_8px_24px_rgba(0,0,0,0.24)] backdrop-blur-xl hover:bg-black/40 hover:text-white'
                                                : 'bg-white shadow-[0_4px_12px_rgba(0,0,0,0.1)] hover:bg-black hover:text-white'
                                        )}
                                        disabled={isLibrarySearchOpen || isDeletingNovel || isDeleteConfirmOpen}
                                    >
                                        <ChevronLeft className="h-5 w-5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={goNext}
                                        className={clsx(
                                            'flex h-[46px] w-[46px] items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-45',
                                            isDarkTheme
                                                ? 'bg-black/28 text-neutral-300 shadow-[0_8px_24px_rgba(0,0,0,0.24)] backdrop-blur-xl hover:bg-black/40 hover:text-white'
                                                : 'bg-white shadow-[0_4px_12px_rgba(0,0,0,0.1)] hover:bg-black hover:text-white'
                                        )}
                                        disabled={isLibrarySearchOpen || isDeletingNovel || isDeleteConfirmOpen}
                                    >
                                        <ChevronRight className="h-5 w-5" />
                                    </button>
                                </div>
                            </div>
                        </section>

                        {!selectedNovelId && (
                            <div className="fixed right-12 top-12 z-50">
                                <button
                                    onClick={() => setIsGlobalSettingsOpen(true)}
                                    className={clsx(
                                        'rounded-full p-3 transition disabled:cursor-not-allowed disabled:opacity-50',
                                        isDarkTheme
                                            ? 'bg-black/28 text-neutral-300 shadow-[0_10px_28px_rgba(0,0,0,0.24)] backdrop-blur-xl hover:bg-black/40 hover:text-white'
                                            : 'bg-white text-black shadow-[0_4px_12px_rgba(0,0,0,0.1)] hover:bg-black hover:text-white'
                                    )}
                                    disabled={isDeletingNovel}
                                >
                                    <Settings className="h-5 w-5" />
                                </button>
                            </div>
                        )}

                        {loading && (
                            <div className={clsx(
                                'fixed bottom-8 left-1/2 z-40 -translate-x-1/2 rounded-full px-4 py-2 text-sm shadow',
                                isDarkTheme ? 'border border-white/10 bg-[#17171f]/90 text-neutral-300' : 'bg-white/85 text-neutral-600'
                            )}>
                                {t('common.loading')}
                            </div>
                        )}
                    </motion.div>
                ) : (
                    <Editor
                        key="editor-page"
                        novelId={selectedNovelId}
                        onBack={() => setSelectedNovelId(null)}
                    />
                )}
            </AnimatePresence>

            <div
                className={clsx(
                    'fixed inset-0 z-[9500] overflow-y-auto p-10 backdrop-blur-sm transition duration-300',
                    isDarkTheme ? 'bg-[#09090dcc]/95' : 'bg-white/95',
                    isLibrarySearchOpen ? 'pointer-events-auto opacity-100 scale-100' : 'pointer-events-none opacity-0 scale-[1.02]'
                )}
            >
                <div className="mx-auto w-full max-w-[1360px]">
                    <div className="mb-8 flex items-start justify-between gap-6">
                        <div>
                            <h3 className={clsx('text-3xl font-black tracking-tight', isDarkTheme ? 'text-white' : 'text-black')}>
                                {t('home.searchAllTitle')}
                            </h3>
                            <p className={clsx('mt-2 text-sm', isDarkTheme ? 'text-neutral-400' : 'text-neutral-500')}>
                                {t('home.searchAllHint')}
                            </p>
                            <p className={clsx('mt-1 text-xs', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>
                                {t('home.searchAllEscHint')}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={closeLibrarySearch}
                            className={clsx(
                                'flex h-11 w-11 items-center justify-center rounded-full transition',
                                isDarkTheme
                                    ? 'border border-white/10 bg-[#17171f] text-neutral-200 shadow-[0_5px_15px_rgba(0,0,0,0.35)] hover:bg-white hover:text-black'
                                    : 'bg-white shadow-[0_5px_15px_rgba(0,0,0,0.08)] hover:bg-black hover:text-white'
                            )}
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>

                    <div className="mb-8 flex items-center gap-3">
                        <div className="relative w-full max-w-[460px]">
                            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                            <input
                                ref={librarySearchInputRef}
                                value={librarySearchQuery}
                                onChange={(event) => setLibrarySearchQuery(event.target.value)}
                                placeholder={t('home.searchAllPlaceholder')}
                                className={clsx(
                                    'h-12 w-full rounded-xl border pl-11 pr-4 text-sm font-medium outline-none transition',
                                    isDarkTheme
                                        ? 'border-white/10 bg-[#13131a] text-neutral-100 placeholder:text-neutral-500 focus:border-white/30'
                                        : 'border-neutral-200 bg-white text-neutral-900 focus:border-black'
                                )}
                            />
                        </div>
                        <div className={clsx('text-sm font-semibold', isDarkTheme ? 'text-neutral-400' : 'text-neutral-500')}>
                            {t('home.searchAllResultCount', { count: filteredNovels.length })}
                        </div>
                    </div>

                    {filteredNovels.length ? (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-8 pb-10">
                            {filteredNovels.map(({ novel, index }) => {
                                const hasCover = Boolean(novel.coverUrl);
                                const title = (novel.title || '-').trim();
                                return (
                                    <button
                                        key={novel.id}
                                        type="button"
                                        onClick={() => selectNovelFromSearch(index)}
                                        className={clsx(
                                            'group aspect-[3/4] overflow-hidden rounded-2xl text-left transition hover:-translate-y-2',
                                            isDarkTheme
                                                ? 'border border-white/8 bg-[#13131a] shadow-[0_10px_30px_rgba(0,0,0,0.35)]'
                                                : 'border border-black/5 bg-white shadow-[0_10px_30px_rgba(0,0,0,0.05)]'
                                        )}
                                    >
                                        <div className="relative h-full w-full">
                                            <div
                                                className="absolute inset-0"
                                                style={hasCover ? undefined : { background: generateGradient(title) }}
                                            />
                                            {hasCover && (
                                                <img
                                                    src={novel.coverUrl.startsWith('covers/') ? `local-resource://${novel.coverUrl}` : novel.coverUrl}
                                                    alt={title}
                                                    className="absolute inset-0 h-full w-full object-cover"
                                                />
                                            )}
                                            <div
                                                className={clsx(
                                                    'relative z-10 flex h-full flex-col justify-end p-4 transition',
                                                    hasCover ? 'text-white' : 'text-white',
                                                    hasCover && 'bg-gradient-to-t from-black/65 via-black/20 to-transparent'
                                                )}
                                            >
                                                <div className="line-clamp-2 text-base font-black leading-tight tracking-tight">
                                                    {title}
                                                </div>
                                                <div className="mt-1 text-xs font-semibold opacity-85">
                                                    {readNovelAuthor(novel) || t('home.authorFallback', { defaultValue: '-' })}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className={clsx(
                            'rounded-2xl border border-dashed px-6 py-12 text-center',
                            isDarkTheme ? 'border-white/10 bg-[#13131a]/80 text-neutral-500' : 'border-neutral-300 bg-white/80 text-neutral-500'
                        )}>
                            {t('home.searchAllEmpty')}
                        </div>
                    )}
                </div>
            </div>

            <aside
                className={clsx(
                    'fixed right-0 top-0 z-[9999] flex h-full w-[500px] flex-col p-[60px] transition-transform duration-700',
                    isDarkTheme ? 'bg-[#13131a] text-white shadow-[-30px_0_90px_rgba(0,0,0,0.35)]' : 'bg-white shadow-[-30px_0_90px_rgba(0,0,0,0.1)]',
                    '[transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
                    isEditorOpen ? 'translate-x-0' : 'translate-x-full'
                )}
            >
                <div className="mb-8 flex items-center justify-between">
                    <h3 className={clsx('text-2xl font-black', isDarkTheme ? 'text-white' : 'text-black')}>{t('home.editNovel')}</h3>
                    <button
                        type="button"
                        onClick={closeEditor}
                        className={clsx(
                            'flex h-9 w-9 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50',
                            isDarkTheme ? 'bg-white/5 text-neutral-300 hover:bg-white hover:text-black' : 'bg-[#f4f4f4] hover:bg-black hover:text-white'
                        )}
                        disabled={isDeletingNovel}
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <label className={clsx('mb-2 block text-[10px] font-bold uppercase', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>
                    {t('home.coverUrl')}
                </label>
                <button
                    type="button"
                    onClick={uploadCoverForActiveNovel}
                    className={clsx(
                        'relative mb-7 flex h-[140px] w-full flex-col items-center justify-center overflow-hidden rounded-xl border-2 border-dashed transition disabled:cursor-not-allowed disabled:opacity-60',
                        isDarkTheme ? 'border-white/10 hover:border-white/20' : 'border-neutral-200 hover:border-neutral-300'
                    )}
                    disabled={isDeletingNovel}
                >
                    {editForm.coverUrl ? (
                        <img
                            src={editForm.coverUrl.startsWith('covers/') ? `local-resource://${editForm.coverUrl}` : editForm.coverUrl}
                            alt="cover preview"
                            className="absolute inset-0 h-full w-full object-cover"
                        />
                    ) : (
                        <>
                              <Upload className={clsx('mb-2 h-5 w-5', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')} />
                              <span className={clsx('text-xs', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>{t('home.uploadCover', { defaultValue: 'Upload cover image' })}</span>
                        </>
                    )}
                </button>

                <div className="mb-6">
                    <label className={clsx('mb-2 block text-[10px] font-bold uppercase', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>{t('home.title')}</label>
                    <input
                        value={editForm.title}
                        onChange={(event) => setEditForm((prev) => ({ ...prev, title: event.target.value }))}
                        className={clsx(
                            'w-full border-0 border-b py-2 text-base font-semibold outline-none transition',
                            isDarkTheme ? 'border-white/10 bg-transparent text-white focus:border-white/30' : 'border-neutral-200 focus:border-neutral-900'
                        )}
                        disabled={isDeletingNovel}
                    />
                </div>

                <div className="mb-6">
                    <label className={clsx('mb-2 block text-[10px] font-bold uppercase', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>{t('home.author')}</label>
                    <input
                        value={editForm.author}
                        onChange={(event) => setEditForm((prev) => ({ ...prev, author: event.target.value }))}
                        className={clsx(
                            'w-full border-0 border-b py-2 text-base font-semibold outline-none transition',
                            isDarkTheme ? 'border-white/10 bg-transparent text-white focus:border-white/30' : 'border-neutral-200 focus:border-neutral-900'
                        )}
                        disabled={isDeletingNovel}
                    />
                </div>

                <div className="mb-6">
                    <label className={clsx('mb-2 block text-[10px] font-bold uppercase', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>
                        {t('home.deckSummaryLabel', { defaultValue: 'Summary' })}
                    </label>
                    <textarea
                        value={editForm.description}
                        onChange={(event) => setEditForm((prev) => ({ ...prev, description: event.target.value }))}
                        className={clsx(
                            'h-24 w-full resize-none border-0 border-b py-2 text-base font-semibold outline-none transition',
                            isDarkTheme ? 'border-white/10 bg-transparent text-white focus:border-white/30' : 'border-neutral-200 focus:border-neutral-900'
                        )}
                        disabled={isDeletingNovel}
                    />
                </div>

                <div className="mt-auto flex items-center gap-3">
                    <button
                        type="button"
                        onClick={saveEdit}
                        className={clsx(
                            'rounded-xl px-5 py-3 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-60',
                            isDarkTheme ? 'bg-white text-black hover:bg-white/85' : 'bg-black text-white hover:bg-black/85'
                        )}
                        disabled={isDeletingNovel}
                    >
                        {t('common.save')}
                    </button>
                    <button
                        type="button"
                        onClick={closeEditor}
                        className={clsx(
                            'rounded-xl px-5 py-3 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-60',
                            isDarkTheme ? 'bg-white/5 text-neutral-200 hover:bg-white/10' : 'bg-[#f4f4f4] hover:bg-[#ececec]'
                        )}
                        disabled={isDeletingNovel}
                    >
                        {t('common.cancel')}
                    </button>
                </div>

                <div className={clsx('mt-4 text-[11px]', isDarkTheme ? 'text-neutral-500' : 'text-neutral-400')}>
                    {t('home.enterToSaveHint', { defaultValue: 'Press Enter to save. In summary field, use Ctrl/Cmd + Enter.' })}
                </div>

                <div className={clsx('mt-5 border-t pt-5', isDarkTheme ? 'border-white/5' : 'border-neutral-100')}>
                    <button
                        type="button"
                        onClick={openDeleteConfirm}
                        className="inline-flex items-center gap-2 text-xs font-bold text-red-500 opacity-60 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                        disabled={!activeNovel || isDeletingNovel}
                    >
                        <Trash2 className="h-4 w-4" />
                        {t('home.deleteNovelTrigger', { defaultValue: 'Delete novel...' })}
                    </button>
                </div>
            </aside>

            <div
                className={clsx(
                    'fixed inset-0 z-[10000] flex items-center justify-center backdrop-blur-xl transition',
                    isDarkTheme ? 'bg-black/60' : 'bg-white/85',
                    isDeleteConfirmOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
                )}
                onClick={closeDeleteConfirm}
            >
                <div
                    className="w-full max-w-[360px] px-6 text-center"
                    onClick={(event) => event.stopPropagation()}
                >
                    <h3 className={clsx('mb-3 text-2xl font-black', isDarkTheme ? 'text-white' : 'text-black')}>
                        {t('home.deleteNovelConfirmTitle', { defaultValue: 'Permanently delete this novel?' })}
                    </h3>
                    <p className={clsx('mb-7 text-sm leading-6', isDarkTheme ? 'text-neutral-400' : 'text-neutral-500')}>
                        {t('home.deleteNovelConfirmDescription', {
                            defaultValue: 'This action cannot be undone. All chapters and related materials under "{{title}}" will be removed.',
                            title: pendingDeleteNovel?.title || activeNovel?.title || '-'
                        })}
                    </p>
                    <div className="flex items-center justify-center gap-3">
                        <button
                            type="button"
                            onClick={closeDeleteConfirm}
                            className={clsx(
                                'rounded-xl px-5 py-2.5 text-sm font-bold transition',
                                isDarkTheme ? 'bg-white/5 text-neutral-200 hover:bg-white/10' : 'bg-[#f4f4f4] hover:bg-[#ececec]'
                            )}
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={() => void confirmDeleteNovel()}
                            className="rounded-xl bg-red-500 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-red-600"
                        >
                            {t('home.deleteNovelConfirmAction', { defaultValue: 'Delete' })}
                        </button>
                    </div>
                </div>
            </div>

            <SettingsModal isOpen={isGlobalSettingsOpen} onClose={() => setIsGlobalSettingsOpen(false)} />
        </div>
    );
}
