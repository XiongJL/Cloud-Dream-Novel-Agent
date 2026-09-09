import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Bot, CircleAlert, CircleHelp, ClipboardCheck, FileCheck2, PanelLeftClose, PanelLeftOpen, Settings, ChevronRight, LayoutGrid, FileText, Sparkles, ScrollText, Loader2 } from 'lucide-react';
import NarrativeMatrix from '../../components/StoryWorkbench/NarrativeMatrix';
import Sidebar from '../../components/Sidebar';
import ActivityBar, { ActivityTab } from '../../components/ActivityBar';
import SettingsModal from '../../components/SettingsModal';
import MapSidebar from '../../components/MapWorkbench/MapSidebar';
import MapCanvasView from '../../components/MapWorkbench/MapCanvas';
import { useTranslation } from 'react-i18next';
import { useEditorPreferences } from '../../hooks/useEditorPreferences';
import { useShortcuts } from '../../hooks/useShortcuts';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import LexicalChapterEditor from '../../components/LexicalEditor';
import { LexicalEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import UnifiedSearchWorkbench from '../../components/SearchWorkbench/UnifiedSearchWorkbench';
import SearchSidebar from '../../components/SearchWorkbench/SearchSidebar';
import { FlowModeButton } from '../../components/FlowModeButton';
import { GlobalIdeaModal } from '../../components/GlobalIdeaModal';
import WorldWorkbench from '../../components/WorldWorkbench/WorldWorkbench';
import AIWorkbenchShell from '../../components/AIWorkbench/AIWorkbenchShell';
import AIWorkbenchDraftDock from '../../components/AIWorkbench/AIWorkbenchDraftDock';
import AgentWorkspace, { type AgentChapterContext, type AgentEditorContentSnapshot } from '../../components/AgentWorkspace/AgentWorkspace';
import type { AgentWorkspaceAttentionSummary } from '../../../shared/agentWorkspaceAttention';
import type { DraftSessionRecord } from '../../components/AIWorkbench/types';
import PlotSidebar from '../../components/StoryWorkbench/PlotSidebar';
import PlotContextMenu from '../../components/StoryWorkbench/PlotContextMenu';
import PlotAnchorModal from '../../components/StoryWorkbench/PlotAnchorModal';
import { usePlotSystem } from '../../hooks/usePlotSystem';
import { PlotPointModal } from '../../components/StoryWorkbench/PlotPointModal';
import { Idea } from '../../types';
import { formatAiErrorFromUnknown } from '../../utils/aiError';
import type { EditorProps } from './types';
import { useCreativeDraftSync } from './hooks/useCreativeDraftSync';
import { useFlowModeController } from './hooks/useFlowModeController';
import { useTitleGeneration } from './hooks/useTitleGeneration';
import { useChapterLifecycle } from './hooks/useChapterLifecycle';
import { useContinueWriting } from './hooks/useContinueWriting';
import { useEditorKeyboard } from './hooks/useEditorKeyboard';
import { useIdeaInteractions } from './hooks/useIdeaInteractions';
import { usePlotInteractions } from './hooks/usePlotInteractions';


import { ContinueWritingModal } from '../../components/Editor/ContinueWritingModal';

type ProductMode = 'writing' | 'agent';

const IDLE_AGENT_ATTENTION: AgentWorkspaceAttentionSummary = {
    kind: 'idle',
    count: 0,
    counts: { failed: 0, waiting_user_input: 0, waiting_approval: 0, review_ready: 0, running: 0 },
    targetConversationId: null,
    label: '空闲',
    title: 'Agent 模式',
};

function extractPlainTextFromLexical(content: string): string {
    if (!content?.trim()) return '';
    try {
        const parsed = JSON.parse(content);
        const texts: string[] = [];
        const walk = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (typeof node.text === 'string') {
                texts.push(node.text);
            }
            if (Array.isArray(node.children)) {
                node.children.forEach(walk);
            }
        };
        walk(parsed?.root || parsed);
        return texts.join(' ').replace(/\s+/g, ' ').trim();
    } catch {
        return content.replace(/\s+/g, ' ').trim();
    }
}

function stripRepeatedPrefixFromGeneration(existing: string, generated: string): string {
    const existingRaw = (existing || '').trim();
    const generatedRaw = (generated || '').trimStart();
    if (!generatedRaw) return '';
    if (!existingRaw) return generatedRaw;

    // Safety rule: only trim GENERATED prefix overlap; never mutate existing user text.
    if (generatedRaw.startsWith(existingRaw)) {
        return generatedRaw.slice(existingRaw.length).trimStart();
    }

    const maxOverlap = Math.min(existingRaw.length, generatedRaw.length, 2400);
    for (let len = maxOverlap; len >= 80; len -= 1) {
        if (existingRaw.slice(-len) === generatedRaw.slice(0, len)) {
            return generatedRaw.slice(len).trimStart();
        }
    }
    return generatedRaw;
}

export default function Editor({ novelId, onBack }: EditorProps) {
    const { t, i18n } = useTranslation();
    const { preferences, updatePreference } = useEditorPreferences();
    const { shortcuts, isMatch } = useShortcuts();

    const [viewMode, setViewMode] = useState<'editor' | 'matrix' | 'map'>('editor');
    const [activeMapId, setActiveMapId] = useState<string | null>(null);
    const [mapCharacters, setMapCharacters] = useState<import('../../types').Character[]>([]);
    const editorRef = useRef<LexicalEditor | null>(null);
    const agentModeStorageKey = `novel_editor_last_mode:${novelId}`;

    // --- 1. Core Data State ---
    const [activeChapterMeta, setActiveChapterMeta] = useState<{ id: string; title: string } | null>(null);
    const {
        novel,
        setNovel,
        volumes,
        setVolumes,
        currentChapter,
        setCurrentChapter,
        title,
        setTitle,
        content,
        setContent,
        isLoading,
        recentFiles,
        lastCreatedVolumeId,
        saveState,
        saveStatusText,
        contentRef,
        titleRef,
        chapterRef,
        isSwitchingChapterRef,
        handleDeleteRecent,
        saveChanges,
        handleSelectChapter,
        handleCreateChapter,
        handleCreateVolume,
        handleRenameVolume,
        handleRenameChapter,
        handleDeleteChapter,
    } = useChapterLifecycle({
        novelId,
        t,
        onActiveChapterMetadataChange: setActiveChapterMeta,
        onBeforeSelectChapter: () => {
            if (viewMode === 'map') {
                setViewMode('editor');
            }
        },
    });
    const [ideas, setIdeas] = useState<Idea[]>([]);
    const [isRebuildingSummary, setIsRebuildingSummary] = useState(false);
    const [summaryStatus, setSummaryStatus] = useState('');

    // --- 2. Story / Plot System ---
    const { addAnchor, removeAnchor, createPlotPoint, updatePlotPoint, deletePlotPoint, plotLines, isLoading: isPlotLoading } = usePlotSystem(novelId);
    const {
        isContinueModalOpen,
        setIsContinueModalOpen,
        isContinuing,
        continueStatus,
        setContinueStatus,
        isContinuePreviewOpen,
        setIsContinuePreviewOpen,
        continuePreviewText,
        setContinuePreviewText,
        continuePreviewBaseTail,
        setContinuePreviewBaseTail,
        continuePromptPreview,
        continuePromptLoading,
        continuePromptError,
        continuePromptOverride,
        setContinuePromptOverride,
        continuePromptDefault,
        setContinuePromptDirty,
        continueConfig,
        setContinueConfig,
        normalizeContinueTargetLength,
        closeContinueModal,
        refreshContinuePromptPreview,
        handleStartContinueWriting,
    } = useContinueWriting({
        novelId,
        novelFormatting: novel?.formatting,
        currentChapter,
        plotLines,
        contentRef,
        language: i18n.language,
        t,
        extractPlainTextFromLexical,
        stripRepeatedPrefixFromGeneration,
    });

    // --- 3. UI Control State ---
    const [activeTab, setActiveTab] = useState<ActivityTab>('explorer');
    const [productMode, setProductMode] = useState<ProductMode>(() => {
        try {
            return localStorage.getItem(`novel_editor_last_mode:${novelId}`) === 'agent' ? 'agent' : 'writing';
        } catch {
            return 'writing';
        }
    });
    const [agentAttention, setAgentAttention] = useState<AgentWorkspaceAttentionSummary>(IDLE_AGENT_ATTENTION);
    const [agentAttentionRequestId, setAgentAttentionRequestId] = useState(0);
    const [pendingAgentGoal, setPendingAgentGoal] = useState('');
    const [isSidePanelOpen, setIsSidePanelOpen] = useState(true);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'novel' | 'shortcuts' | 'backup' | 'ai' | undefined>(undefined);
    const [isGlobalIdeaModalOpen, setIsGlobalIdeaModalOpen] = useState(false);
    const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
    const [editorRefreshToken, setEditorRefreshToken] = useState(0);
    const {
        creativeDraft,
        creativeSelection,
        creativeDraftSession,
        isDraftDockOpen,
        setIsDraftDockOpen,
        handleCreativeDraftChange,
        handleCreativeSelectionChange,
        handleCreativeDraftAndSelectionChange,
        handleCreativeDraftSessionChange,
        refreshCreativeDraftSession,
    } = useCreativeDraftSync({ novelId });
    const {
        highlightedPlotPointId,
        plotContextMenuData,
        isPlotAnchorModalOpen,
        isPlotPointModalOpen,
        plotPointCreateData,
        editingPlotPoint,
        isPlotPointCreateMode,
        setPlotContextMenuData,
        setIsPlotAnchorModalOpen,
        setIsPlotPointModalOpen,
        handlePlotContextMenu,
        handleAddAnchorClick,
        handleRemoveAnchor,
        handleSubmitAnchor,
        handleCreatePointFromSelection,
        handleCreatePlotPoint,
        handleSavePlotPoint,
        handleViewDetails,
        handlePlotAnchorClick,
        handleJumpToPlotPoint,
        handleDeletePlotPoint,
    } = usePlotInteractions({
        novelId,
        currentChapter,
        plotLines,
        addAnchor,
        removeAnchor,
        createPlotPoint,
        updatePlotPoint,
        deletePlotPoint,
        editorRef,
        activeChapterMeta,
        setActiveTab,
        setIsSidePanelOpen,
        isDarkTheme: preferences.theme === 'dark',
    });

    useEffect(() => {
        const onResize = () => setViewportWidth(window.innerWidth);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(agentModeStorageKey, productMode);
        } catch (error) {
            console.warn('[Editor] failed to persist product mode:', error);
        }
    }, [agentModeStorageKey, productMode]);

    useEffect(() => {
        setAgentAttention(IDLE_AGENT_ATTENTION);
    }, [novelId]);

    useEffect(() => {
        const reloadMapCharacters = async () => {
            try {
                const next = await window.db.getCharacters(novelId);
                setMapCharacters(next);
            } catch (error) {
                console.error('[Editor] failed to refresh map characters:', error);
            }
        };
        const unsubscribeAutomation = window.automation?.onDataChanged?.(({ method }) => {
            if (
                method === 'character.create_batch' ||
                method === 'story_patch.apply' ||
                method === 'draft.commit'
            ) {
                void reloadMapCharacters();
            }
            if (
                method === 'creative_assets.generate_draft' ||
                method === 'outline.generate_draft' ||
                method === 'draft.update' ||
                method === 'draft.commit' ||
                method === 'draft.discard'
            ) {
                void (async () => {
                    try {
                        await refreshCreativeDraftSession();

                        if (method === 'creative_assets.generate_draft' || method === 'outline.generate_draft') {
                            setIsDraftDockOpen(true);
                            setViewMode('editor');
                        }
                    } catch (error) {
                        console.error('[Editor] failed to refresh creative draft session:', error);
                    }
                })();
            }
            if (
                method === 'chapter.create' ||
                method === 'chapter.save' ||
                method === 'draft.commit' ||
                method === 'draft.undo' ||
                method === 'draft.batch.commit_prefix' ||
                method === 'draft.batch.undo'
            ) {
                void (async () => {
                    try {
                        const refreshedVolumes = await window.db.getVolumes(novelId);
                        setVolumes(refreshedVolumes);

                        const current = chapterRef.current;
                        if (!current) return;
                        const latest = await window.db.getChapter(current.id);
                        if (!latest) return;
                        const shouldRefreshEditor =
                            latest.content !== contentRef.current ||
                            latest.title !== titleRef.current;

                        if (shouldRefreshEditor) {
                            isSwitchingChapterRef.current = true;
                        }
                        setCurrentChapter(latest);
                        setTitle(latest.title);
                        setContent(latest.content);
                        contentRef.current = latest.content;
                        titleRef.current = latest.title;
                        if (shouldRefreshEditor) {
                            setEditorRefreshToken((prev) => prev + 1);
                            window.setTimeout(() => {
                                isSwitchingChapterRef.current = false;
                            }, 300);
                        }
                    } catch (error) {
                        isSwitchingChapterRef.current = false;
                        console.error('[Editor] failed to refresh chapter after automation update:', error);
                    }
                })();
            }
            if (method === 'chapter.generate_draft') {
                if (!chapterRef.current) return;
                void (async () => {
                    try {
                        const current = chapterRef.current;
                        if (!current) return;
                        const session = await window.automation.invoke('draft.get_active', {
                            novelId,
                            workspace: 'chapter-editor',
                            type: 'chapter-draft',
                        }, 'desktop-ui') as DraftSessionRecord | null;
                        if (!session || session.status !== 'draft' || session.chapterId !== current.id) {
                            return;
                        }
                        const payload = session.payload as ChapterDraftPayload;
                        const generatedText = (payload.generatedText || '').trim();
                        if (!generatedText) return;

                        setContinuePreviewText(generatedText);
                        setContinuePreviewBaseTail((payload.baseContent || '').slice(-600));

                        const requestedPresentation = payload.presentation;
                        const normalizedPresentation = requestedPresentation === 'silent' || requestedPresentation === 'toast' || requestedPresentation === 'modal'
                            ? requestedPresentation
                            : undefined;
                        const defaultPresentation = session.origin === 'mcp-bridge' ? 'toast' : 'modal';
                        const presentation = normalizedPresentation ?? defaultPresentation;

                        if (presentation === 'modal') {
                            setIsContinuePreviewOpen(true);
                            setContinueStatus(t('editor.continueNeedConfirm'));
                            return;
                        }

                        if (presentation === 'toast') {
                            setContinueStatus(t('editor.continueDraftReadyToast'));
                            toast.message(
                                t('editor.continueDraftReadyTitle'),
                                {
                                    description: t('editor.continueDraftReadyDescription'),
                                    action: {
                                        label: t('editor.continueDraftReadyAction'),
                                        onClick: () => setIsContinuePreviewOpen(true),
                                    },
                                },
                            );
                            window.setTimeout(() => setContinueStatus(''), 4000);
                            return;
                        }

                        setContinueStatus(t('editor.continueDraftReadySilent'));
                        window.setTimeout(() => setContinueStatus(''), 3000);
                    } catch (error) {
                        console.error('[Editor] failed to refresh chapter draft preview:', error);
                    }
                })();
                return;
            }
            if (false && method === 'chapter.generate_draft') {
                if (!chapterRef.current) return;
                void (async () => {
                    try {
                        const current = chapterRef.current;
                        if (!current) return;
                        const session = await window.automation.invoke('draft.get_active', {
                            novelId,
                            workspace: 'chapter-editor',
                            type: 'chapter-draft',
                        }, 'desktop-ui') as DraftSessionRecord | null;
                        if (!session || session.status !== 'draft' || session.chapterId !== current.id) {
                            return;
                        }
                        const payload = session.payload as ChapterDraftPayload;
                        const generatedText = (payload.generatedText || '').trim();
                        if (!generatedText) return;
                        setContinuePreviewText(generatedText);
                        setContinuePreviewBaseTail((payload.baseContent || '').slice(-600));
                        setIsContinuePreviewOpen(true);
                        setContinueStatus(t('editor.continueNeedConfirm'));
                    } catch (error) {
                        console.error('[Editor] failed to refresh chapter draft preview:', error);
                    }
                })();
            }
        });
        return () => unsubscribeAutomation?.();
    }, [novelId, refreshCreativeDraftSession, t]);

    useEffect(() => {
        window.db.getIdeas(novelId).then(setIdeas).catch(console.error);
    }, [novelId]);

    const {
        shakingIdeaId,
        highlightedIdeaId,
        handleAddIdea,
        handleCreateGlobalIdea,
        handleDeleteIdea,
        handleToggleStar,
        handleJumpToIdea,
        handleJumpToChapter,
        handleIdeaClick,
        handleUpdateIdea,
    } = useIdeaInteractions({
        novelId,
        ideas,
        setIdeas,
        currentChapter,
        editorRef,
        handleSelectChapter,
        setActiveTab,
        setIsSidePanelOpen,
        setIsGlobalIdeaModalOpen,
    });

    const hasContinuePreviewDraft = continuePreviewText.trim().length > 0;

    // --- 5. Flow / Title ---
    const { isFlowMode, isFullScreen, isFlowEntering, isFlowSwitching, toggleFlowMode } = useFlowModeController({
        editorRef,
        isSidePanelOpen,
        setIsSidePanelOpen,
    });
    const {
        isGeneratingTitle,
        titleGenStage,
        titleGenStatus,
        titleCandidates,
        setTitleCandidates,
        handleGenerateTitle,
    } = useTitleGeneration({
        novelId,
        currentChapter,
        contentRef,
        setTitle,
        t,
    });

    // --- 7. UI Actions ---

    const clearSearchHighlights = () => {
        if ('highlights' in CSS) {
            (CSS as any).highlights.delete('search-results');
        }
    };

    const handleTabChange = (tab: ActivityTab) => {
        if (tab === 'settings') {
            setSettingsInitialTab('general');
            setIsSettingsOpen(true);
            return;
        }
        if (activeTab === tab) {
            setIsSidePanelOpen(!isSidePanelOpen);
        } else {
            if (activeTab === 'search') clearSearchHighlights();
            setActiveTab(tab);
            setIsSidePanelOpen(true);
        }
    };

    useEditorKeyboard({
        setActiveTab,
        setIsSidePanelOpen,
        isMatch,
        onCreateGlobalIdea: handleCreateGlobalIdea,
    });
    const handleRebuildChapterSummary = useCallback(async () => {
        if (!currentChapter) return;
        setIsRebuildingSummary(true);
        try {
            const result = await window.ai.rebuildChapterSummary(currentChapter.id);
            if (result.ok) {
                setSummaryStatus(t('editor.summaryRebuildQueued'));
            } else {
                setSummaryStatus(`${t('editor.summaryRebuildFailed')}: ${result.detail || ''}`);
            }
        } catch (error) {
            console.error('[Editor] chapter summary rebuild failed:', error);
            setSummaryStatus(formatAiErrorFromUnknown(error, t, t('editor.summaryRebuildFailed')));
        } finally {
            setIsRebuildingSummary(false);
            window.setTimeout(() => setSummaryStatus(''), 4000);
        }
    }, [currentChapter, t]);

    const getAgentContentSnapshot = useCallback((): AgentEditorContentSnapshot => ({
        novelId,
        chapterId: chapterRef.current?.id ?? null,
        content: contentRef.current || '',
        capturedAt: new Date().toISOString(),
    }), [chapterRef, contentRef, novelId]);

    const agentChapterContext = useMemo<AgentChapterContext | null>(() => currentChapter ? ({
        id: currentChapter.id,
        title: currentChapter.title,
        volumeId: currentChapter.volumeId,
        wordCount: currentChapter.wordCount,
    }) : null, [currentChapter?.id, currentChapter?.title, currentChapter?.volumeId, currentChapter?.wordCount]);

    const handleAgentAttentionChange = useCallback((summary: AgentWorkspaceAttentionSummary) => {
        setAgentAttention((current) => (
            current.kind === summary.kind
            && current.count === summary.count
            && current.targetConversationId === summary.targetConversationId
            && current.title === summary.title
                ? current
                : summary
        ));
    }, []);

    const openAgentMode = useCallback(() => {
        if (productMode !== 'agent' && agentAttention.targetConversationId) {
            setAgentAttentionRequestId((current) => current + 1);
        }
        setProductMode('agent');
    }, [agentAttention.targetConversationId, productMode]);

    const sendCurrentChapterToAgent = useCallback((goal: string) => {
        if (!currentChapter) return;
        setPendingAgentGoal(goal);
        setProductMode('agent');
    }, [currentChapter]);

    const handleInitialAgentGoalConsumed = useCallback(() => {
        setPendingAgentGoal('');
    }, []);

    const appendGeneratedTextToEditor = useCallback((generated: string, existingPlainText?: string) => {
        if (!generated.trim()) return;
        const deduped = stripRepeatedPrefixFromGeneration(existingPlainText || '', generated);
        if (!deduped.trim()) return;
        const editor = editorRef.current;
        if (!editor) return;
        editor.update(() => {
            const root = $getRoot();
            const normalized = deduped.replace(/\r\n/g, '\n').trim();
            // Split by newlines, one block per paragraph; CSS text-indent handles first-line indent
            // Strip leading full-width/half-width spaces (indent is controlled by CSS text-indent)
            const blocks = normalized.split(/\n+/).map((block) => block.replace(/^[\s\u3000]+/, '').trim()).filter(Boolean);
            if (blocks.length === 0) return;
            blocks.forEach((block) => {
                const paragraph = $createParagraphNode();
                paragraph.append($createTextNode(block));
                root.append(paragraph);
            });
        });
    }, []);

    const handleConfirmContinueInsert = useCallback(() => {
        if (!continuePreviewText.trim()) {
            setIsContinuePreviewOpen(false);
            return;
        }
        appendGeneratedTextToEditor(continuePreviewText);
        setIsContinuePreviewOpen(false);
        setContinuePreviewText('');
        setContinuePreviewBaseTail('');
        setContinueStatus(t('editor.continueDone'));
        window.setTimeout(() => setContinueStatus(''), 5000);
    }, [appendGeneratedTextToEditor, continuePreviewText, t]);
    // Style Calculation
    const getEditorContentClass = () => {
        const base = "w-full resize-none outline-none selection:bg-purple-500/30 transition-all duration-300";
        // Wide (Default) or Mobile container sizing is now handled by LexicalChapterEditor wrapper
        // But for specific text content styling:

        let fontClass = 'font-serif';
        if (preferences.fontFamily === 'sans') fontClass = 'font-sans';
        if (preferences.fontFamily === 'kaiti') fontClass = "font-['Kaiti']";

        const isDark = preferences.theme === 'dark';
        return clsx(base, fontClass, "bg-transparent", isDark ? "text-neutral-300 placeholder-white/10" : "text-neutral-900 placeholder-black/30");
    };


    const draftCount = useMemo(() => (
        (creativeDraft.plotLines?.length ?? 0)
        + (creativeDraft.plotPoints?.length ?? 0)
        + (creativeDraft.characters?.length ?? 0)
        + (creativeDraft.items?.length ?? 0)
        + (creativeDraft.skills?.length ?? 0)
        + (creativeDraft.maps?.length ?? 0)
    ), [creativeDraft]);
    const isCompactDraftDock = viewportWidth < 1700;
    const isNarrowViewport = viewportWidth < 640;

    return (
        <motion.div
            data-theme={preferences.theme}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className={`fixed inset-0 z-50 flex ${preferences.theme === 'dark' ? 'bg-[#0a0a0f] text-neutral-200' : 'bg-[var(--ui-canvas)] text-[var(--ui-text-primary)]'}`}
        >
            {/* Activity Bar (Leftmost) */}
            {productMode === 'writing' && !isNarrowViewport && (
                <ActivityBar
                    activeTab={isSidePanelOpen ? activeTab : null}
                    onTabChange={handleTabChange}
                    theme={preferences.theme}
                />
            )}

            {/* Side Panel */}
            <AnimatePresence mode='wait'>
                {productMode === 'writing' && !isNarrowViewport && isSidePanelOpen && (
                    <motion.div
                        id="sidebar-root"
                        initial={{ x: -100, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: -100, opacity: 0 }}
                        transition={{ duration: 0.2, ease: "circOut" }}
                        className={clsx(
                            "h-full flex flex-col border-r w-64", // Fixed width
                            isFlowMode ? "absolute left-12 z-40 shadow-2xl" : "flex-shrink-0 relative transition-all duration-300",
                            preferences.theme === 'dark' ? 'border-[#1f2533] bg-[#0F0F13]' : 'border-gray-200 bg-gray-50',
                            isSidePanelOpen && "sidebar-open"
                        )}
                    >
                        {/* Dynamic Content based on Active Tab - Implemented with Keep-Alive for heavy components */}

                        {/* Explorer (Keep Alive) */}
                        <div className={clsx("flex-1 h-full flex flex-col min-h-0", activeTab !== 'explorer' && "hidden")}>
                            <Sidebar
                                volumes={volumes}
                                currentChapterId={currentChapter?.id || null}
                                formatting={novel?.formatting}
                                onSelectChapter={handleSelectChapter}
                                onCreateChapter={handleCreateChapter}
                                onCreateVolume={handleCreateVolume}
                                onRenameVolume={handleRenameVolume}
                                onRenameChapter={handleRenameChapter}
                                onDeleteChapter={handleDeleteChapter}
                                theme={preferences.theme}
                                lastCreatedVolumeId={lastCreatedVolumeId}
                            />
                        </div>

                        {/* Idea (Keep Alive) */}
                        <div className={clsx("flex-1 h-full flex flex-col min-h-0", activeTab !== 'idea' && "hidden")}>
                            <UnifiedSearchWorkbench
                                ideas={ideas}
                                novelId={novelId}
                                onJump={handleJumpToIdea}
                                onUpdateIdea={handleUpdateIdea}
                                onDeleteIdea={handleDeleteIdea}
                                onToggleStar={handleToggleStar}
                                onCreateIdea={handleCreateGlobalIdea}
                                theme={preferences.theme}
                                onClose={() => setIsSidePanelOpen(false)}
                                shakingIdeaId={shakingIdeaId}
                                highlightedIdeaId={highlightedIdeaId}
                            />
                        </div>

                        {/* Search (Keep Alive) */}
                        <div className={clsx("flex-1 h-full flex flex-col min-h-0", activeTab !== 'search' && "hidden")}>
                            <SearchSidebar
                                theme={preferences.theme}
                                novelId={novelId}
                                onClose={() => {
                                    clearSearchHighlights();
                                    setIsSidePanelOpen(false);
                                }}
                                onJumpToChapter={handleJumpToChapter}
                                onJumpToIdea={(ideaId) => {
                                    const idea = ideas.find(i => i.id === ideaId);
                                    if (idea) handleJumpToIdea(idea);
                                }}
                                onJumpToEntity={(category, entityId) => {
                                    if (category === 'map') {
                                        // Switch to maps tab and select the map
                                        setActiveTab('map');
                                        setIsSidePanelOpen(true);
                                        setTimeout(() => {
                                            window.dispatchEvent(new CustomEvent('navigate-to-map', {
                                                detail: { mapId: entityId }
                                            }));
                                        }, 100);
                                    } else {
                                        // Switch to WorldWorkbench tab and dispatch event
                                        setActiveTab('characters');
                                        setIsSidePanelOpen(true);
                                        setTimeout(() => {
                                            window.dispatchEvent(new CustomEvent('navigate-to-world-entity', {
                                                detail: { category, entityId }
                                            }));
                                        }, 100);
                                    }
                                }}
                                onSearchChange={(keyword) => {
                                    if (!keyword.trim()) {
                                        clearSearchHighlights();
                                    }
                                }}
                            />
                        </div>

                        {/* Placeholders (Conditional) */}
                        {/* Plot Sidebar (Keep Alive) */}
                        <div className={clsx("flex-1 h-full flex flex-col min-h-0", activeTab !== 'outline' && "hidden")}>
                            <PlotSidebar
                                novelId={novelId}
                                theme={preferences.theme}
                                onClose={() => setIsSidePanelOpen(false)}
                                highlightedPointId={highlightedPlotPointId}
                                onDeletePoint={handleDeletePlotPoint}
                                onJump={handleJumpToPlotPoint}
                            />
                        </div>

                        {/* World Workbench (Keep Alive) */}
                        <div className={clsx("flex-1 h-full flex flex-col min-h-0", activeTab !== 'characters' && "hidden")}>
                            <WorldWorkbench
                                novelId={novelId}
                                theme={preferences.theme}
                            />
                        </div>

                        {/* AI Workbench */}
                        <div className={clsx("flex-1 h-full flex flex-col min-h-0", activeTab !== 'ai_workbench' && "hidden")}>
                            <AIWorkbenchShell
                                novelId={novelId}
                                theme={preferences.theme}
                                draft={creativeDraft}
                                selection={creativeSelection}
                                draftSession={creativeDraftSession}
                                currentChapterId={currentChapter?.id || null}
                                currentContent={content}
                                onDraftChange={handleCreativeDraftChange}
                                onSelectionChange={handleCreativeSelectionChange}
                                onDraftSessionChange={handleCreativeDraftSessionChange}
                                onDraftGenerated={() => {
                                    setIsDraftDockOpen(true);
                                    setViewMode('editor');
                                }}
                            />
                        </div>

                        {activeTab === 'map' && (
                            <div className="flex-1 flex flex-col min-h-0">
                                <MapSidebar
                                    novelId={novelId}
                                    theme={preferences.theme}
                                    activeMapId={activeMapId}
                                    onSelectMap={(mapId) => {
                                        if (mapId) {
                                            setActiveMapId(mapId);
                                            setViewMode('map');
                                            // Always reload characters to stay current
                                            window.db.getCharacters(novelId).then(setMapCharacters).catch(console.error);
                                        } else {
                                            setActiveMapId(null);
                                            setViewMode('editor');
                                        }
                                    }}
                                />
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Main Content */}
            <div className={`flex-1 flex flex-col h-full relative transition-all min-w-0 overflow-hidden ${preferences.theme === 'dark' ? 'bg-[#0a0a0f]' : 'bg-[var(--ui-surface-subtle)]'}`}>

                {/* Header */}
                {/* Header */}
                {/* Header - Robust 3-Column Layout */}
                <div
                    className={clsx(
                        "flex items-center justify-between relative border-b",
                        preferences.theme === 'dark' ? 'border-white/5 bg-[#0a0a0f] text-neutral-400' : 'border-[var(--ui-border)] bg-[var(--ui-canvas)] text-[var(--ui-text-muted)]',
                        "h-[70px] px-2 sm:px-4 shrink-0"
                    )}
                    style={{ zIndex: 40 }}
                >
                    {/* Left: Navigation (Width fixed to ensure center alignment) */}
                    <div className="flex w-auto shrink-0 items-center gap-2 sm:w-[180px]">
                        <button onClick={onBack} className={`p-2 rounded-full transition-colors ${preferences.theme === 'dark' ? 'hover:bg-white/10 hover:text-white' : 'hover:bg-black/5 hover:text-black'}`}>
                            <ArrowLeft className="w-5 h-5" />
                        </button>
                        {productMode === 'writing' && !isNarrowViewport && (
                            <button onClick={() => setIsSidePanelOpen(!isSidePanelOpen)} className={`p-2 rounded-full transition-colors ${preferences.theme === 'dark' ? 'hover:bg-white/10 hover:text-white' : 'hover:bg-black/5 hover:text-black'}`}>
                                {isSidePanelOpen ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeftOpen className="w-5 h-5" />}
                            </button>
                        )}
                    </div>

                    {/* Center: Title & View Switcher (Flex-1 to take available space) */}
                    <div className="flex min-w-0 flex-1 items-center justify-center gap-1 sm:gap-4">
                        {currentChapter && (
                            <span className={clsx("text-xs font-mono uppercase tracking-widest hidden lg:block whitespace-nowrap overflow-hidden text-ellipsis max-w-[200px]", preferences.theme === 'dark' ? 'text-neutral-600' : 'text-neutral-400')}>
                                {isLoading ? t('common.loading') : t('editor.editing')}
                            </span>
                        )}

                        {/* Product Mode Toggle */}
                        <div className={clsx(
                            "flex items-center p-1 rounded-full border shadow-sm shrink-0",
                            preferences.theme === 'dark' ? "border-white/20 bg-black/40" : "border-[var(--ui-border-strong)] bg-[var(--ui-surface-raised)]"
                        )}>
                            <button
                                onClick={() => setProductMode('writing')}
                                className={clsx("px-3 py-2 rounded-full transition-all flex items-center gap-2 text-xs", productMode === 'writing' ? (preferences.theme === 'dark' ? "bg-white/20 text-white" : "bg-[var(--ui-surface-muted)] text-[var(--ui-text-primary)]") : "opacity-60 hover:opacity-100")}
                                title="写作模式"
                            >
                                写作
                            </button>
                            <button
                                onClick={openAgentMode}
                                className={clsx(
                                    "relative w-[82px] px-3 py-2 rounded-full transition-all flex items-center justify-center gap-1.5 text-xs",
                                    productMode === 'agent'
                                        ? (preferences.theme === 'dark' ? "bg-white/20 text-white" : "bg-[var(--ui-surface-muted)] text-[var(--ui-text-primary)]")
                                        : agentAttention.kind === 'idle' ? "opacity-60 hover:opacity-100" : "opacity-100",
                                )}
                                title={agentAttention.title}
                                aria-label={agentAttention.title}
                            >
                                Agent
                                {productMode === 'writing' && agentAttention.kind !== 'idle' && (
                                    <span
                                        aria-hidden="true"
                                        className={clsx(
                                            "relative grid h-4 w-4 shrink-0 place-items-center",
                                            agentAttention.kind === 'failed' && "text-red-600 dark:text-red-400",
                                            (agentAttention.kind === 'waiting_user_input' || agentAttention.kind === 'waiting_approval') && "text-amber-600 dark:text-amber-400",
                                            agentAttention.kind === 'review_ready' && "text-indigo-600 dark:text-indigo-400",
                                            agentAttention.kind === 'running' && "text-blue-600 dark:text-blue-400",
                                        )}
                                    >
                                        {agentAttention.kind === 'failed' ? <CircleAlert className="h-3.5 w-3.5" />
                                            : agentAttention.kind === 'waiting_user_input' ? <CircleHelp className="h-3.5 w-3.5" />
                                                : agentAttention.kind === 'waiting_approval' ? <ClipboardCheck className="h-3.5 w-3.5" />
                                                    : agentAttention.kind === 'review_ready' ? <FileCheck2 className="h-3.5 w-3.5" />
                                                        : <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                                        {agentAttention.kind !== 'running' && agentAttention.count > 0 && (
                                            <span className={clsx(
                                                "absolute -right-2.5 -top-2 min-w-4 h-4 rounded-full px-1 text-[9px] leading-4 text-center text-white",
                                                agentAttention.kind === 'failed' ? "bg-red-600"
                                                    : agentAttention.kind === 'review_ready' ? "bg-indigo-600"
                                                        : "bg-amber-600",
                                            )}>
                                                {agentAttention.count > 9 ? '9+' : agentAttention.count}
                                            </span>
                                        )}
                                    </span>
                                )}
                            </button>
                        </div>

                        {/* View Mode Toggle */}
                        {productMode === 'writing' && (
                        <div className={clsx(
                            "hidden items-center p-1 rounded-full border shadow-sm shrink-0 sm:flex",
                            preferences.theme === 'dark' ? "border-white/20 bg-black/40" : "border-gray-300 bg-white"
                        )}>
                            <button
                                onClick={() => setViewMode('editor')}
                                className={clsx("p-2 rounded-full transition-all flex items-center gap-2", viewMode === 'editor' ? (preferences.theme === 'dark' ? "bg-white/20 text-white" : "bg-gray-200 text-black") : "opacity-60 hover:opacity-100")}
                                title={t('editor.mode.editor')}
                            >
                                <FileText className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => setViewMode('matrix')}
                                className={clsx("p-2 rounded-full transition-all flex items-center gap-2", viewMode === 'matrix' ? (preferences.theme === 'dark' ? "bg-white/20 text-white" : "bg-gray-200 text-black") : "opacity-60 hover:opacity-100")}
                                title={t('editor.mode.matrix')}
                            >
                                <LayoutGrid className="w-4 h-4" />
                            </button>
                            <button
                                    onClick={() => {
                                        setViewMode('editor');
                                        setIsDraftDockOpen((prev) => !prev);
                                    }}
                                    className={clsx(
                                        "relative p-2 rounded-full transition-all flex items-center gap-2",
                                        isDraftDockOpen && viewMode === 'editor'
                                            ? (preferences.theme === 'dark' ? "bg-white/20 text-white" : "bg-gray-200 text-black")
                                            : "opacity-60 hover:opacity-100",
                                    )}
                                    title={isDraftDockOpen ? t('aiWorkbench.closeDraftDock') : t('aiWorkbench.openDraftDock')}
                                >
                                    <Sparkles className="w-4 h-4" />
                                    {draftCount > 0 && (
                                        <span className={clsx(
                                            "absolute -right-1 -top-1 min-w-4 h-4 px-1 rounded-full text-[10px] leading-4 text-center",
                                            preferences.theme === 'dark' ? "bg-indigo-500 text-white" : "bg-indigo-600 text-white",
                                        )}>
                                            {draftCount}
                                        </span>
                                    )}
                                </button>
                        </div>
                        )}
                    </div>

                    {/* Right: Actions (Width fixed to match left) */}
                    <div className="flex items-center gap-2 justify-end min-w-fit shrink-0">
                        <div className="mr-1 hidden shrink-0 sm:block">
                            <FlowModeButton
                                isActive={isFlowMode}
                                onClick={toggleFlowMode}
                                className="shrink-0"
                            />
                        </div>
                        <button
                            onClick={() => {
                                setSettingsInitialTab('general');
                                setIsSettingsOpen(true);
                            }}
                            className={`shrink-0 p-2 rounded-full transition-colors ${preferences.theme === 'dark' ? 'hover:bg-white/10 hover:text-white' : 'hover:bg-black/5 hover:text-black'}`}
                            title={t('editor.settings')}
                        >
                            <Settings className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* The controller stays mounted; AgentWorkspace suspends its heavy view while hidden. */}
                <div className={clsx('flex-1 min-h-0', productMode !== 'agent' && 'hidden')} aria-hidden={productMode !== 'agent'}>
                    <AgentWorkspace
                        novel={novel}
                        novelId={novelId}
                        currentChapter={agentChapterContext}
                        getCurrentContentSnapshot={getAgentContentSnapshot}
                        locale={i18n.language}
                        theme={preferences.theme}
                        isVisible={productMode === 'agent'}
                        isFullScreen={isFullScreen}
                        attentionRequestId={agentAttentionRequestId}
                        attentionTargetConversationId={agentAttention.targetConversationId}
                        onAttentionChange={handleAgentAttentionChange}
                        initialGoal={pendingAgentGoal}
                        onInitialGoalConsumed={handleInitialAgentGoalConsumed}
                    />
                </div>
                {productMode === 'writing' && (viewMode === 'map' && activeMapId ? (
                    <MapCanvasView
                        mapId={activeMapId}
                        novelId={novelId}
                        theme={preferences.theme}
                        characters={mapCharacters}
                    />
                ) : viewMode === 'matrix' ? (
                    <NarrativeMatrix
                        novelId={novelId}
                        theme={preferences.theme}
                        activeChapterId={currentChapter?.id}
                        volumes={volumes}
                        formatting={novel?.formatting}
                        recentFiles={recentFiles}
                        plotLines={plotLines}
                        isPlotLoading={isPlotLoading}
                    />
                ) : (
                    isLoading && !currentChapter ? (
                        <div className={clsx(
                            "flex-1 flex flex-col items-center justify-start pt-20 gap-6 animate-pulse select-none",
                            preferences.theme === 'dark' ? 'bg-[#0a0a0f]' : 'bg-white'
                        )}>
                            <div className={clsx("h-10 w-1/3 rounded", preferences.theme === 'dark' ? "bg-white/5" : "bg-gray-200")} />
                            <div className="w-full max-w-3xl px-12 flex flex-col gap-4 mt-8">
                                <div className={clsx("h-4 w-full rounded", preferences.theme === 'dark' ? "bg-white/5" : "bg-gray-200")} />
                                <div className={clsx("h-4 w-5/6 rounded", preferences.theme === 'dark' ? "bg-white/5" : "bg-gray-200")} />
                                <div className={clsx("h-4 w-full rounded", preferences.theme === 'dark' ? "bg-white/5" : "bg-gray-200")} />
                                <div className={clsx("h-4 w-4/5 rounded", preferences.theme === 'dark' ? "bg-white/5" : "bg-gray-200")} />
                            </div>
                        </div>
                    ) : currentChapter ? (
                        <div className={clsx(
                            "flex-1 min-h-0 editor-shell layout-transition relative flex",
                            preferences.theme === 'dark' ? 'bg-[#0a0a0f]' : 'bg-white'
                        )}>
                            <div className="flex-1 min-w-0 relative">
                                <LexicalChapterEditor
                                    key={`${currentChapter.id}:${editorRefreshToken}`}
                                    namespace={currentChapter.id}
                                    initialContent={content}
                                    onChange={(editorState) => {
                                        if (isSwitchingChapterRef.current) return;
                                        editorState.read(() => {
                                            const jsonString = JSON.stringify(editorState.toJSON());
                                            setContent(jsonString);
                                        });
                                    }}
                                    className={getEditorContentClass()}
                                    editorRef={editorRef}
                                    preferences={preferences}
                                    onUpdatePreference={updatePreference}
                                    shortcuts={shortcuts}
                                    onSave={saveChanges}
                                    onCreateIdea={handleCreateGlobalIdea}
                                    language={i18n.language}
                                    saveIndicatorState={saveState}
                                    saveIndicatorText={saveStatusText}
                                    toolbarActions={
                                        <>
                                            <button
                                                onClick={() => sendCurrentChapterToAgent(`请基于当前章节《${currentChapter.title}》生成执行计划。`)}
                                                disabled={!currentChapter}
                                                title="发送当前章给 Agent"
                                                className={clsx(
                                                    "shrink-0 px-2.5 py-2 rounded-lg border transition-colors inline-flex items-center gap-1.5 text-xs",
                                                    preferences.theme === 'dark'
                                                        ? "border-white/10 text-neutral-300 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        : "border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                )}
                                            >
                                                <Bot className="w-4 h-4" />
                                                <span>发送给 Agent</span>
                                            </button>
                                            <button
                                                onClick={() => sendCurrentChapterToAgent(`请质检当前章节《${currentChapter.title}》，重点检查节奏、人物一致性和追更欲望。`)}
                                                disabled={!currentChapter}
                                                title="质检当前章节"
                                                className={clsx(
                                                    "shrink-0 px-2.5 py-2 rounded-lg border transition-colors inline-flex items-center gap-1.5 text-xs",
                                                    preferences.theme === 'dark'
                                                        ? "border-white/10 text-neutral-300 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        : "border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                )}
                                            >
                                                <FileText className="w-4 h-4" />
                                                <span>质检章节</span>
                                            </button>
                                            <button
                                                onClick={() => sendCurrentChapterToAgent(`请为当前章节《${currentChapter.title}》生成下一段续写草稿。`)}
                                                disabled={!currentChapter}
                                                title="生成下一段"
                                                className={clsx(
                                                    "shrink-0 px-2.5 py-2 rounded-lg border transition-colors inline-flex items-center gap-1.5 text-xs",
                                                    preferences.theme === 'dark'
                                                        ? "border-white/10 text-neutral-300 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        : "border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                )}
                                            >
                                                <Sparkles className="w-4 h-4" />
                                                <span>下一段</span>
                                            </button>
                                            <button
                                                onClick={() => setIsContinueModalOpen(true)}
                                                disabled={!currentChapter || isContinuing}
                                                title={t('editor.continueWriting')}
                                                className={clsx(
                                                    "shrink-0 px-2.5 py-2 rounded-lg border transition-colors inline-flex items-center gap-1.5 text-xs",
                                                    preferences.theme === 'dark'
                                                        ? "border-white/10 text-neutral-300 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        : "border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                )}
                                            >
                                                {isContinuing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                                <span>{t('editor.continueWriting')}</span>
                                            </button>
                                            {hasContinuePreviewDraft && (
                                                <button
                                                    onClick={() => setIsContinuePreviewOpen(true)}
                                                    title={t('editor.continueViewDraft')}
                                                    className={clsx(
                                                        "shrink-0 px-2.5 py-2 rounded-lg border transition-colors inline-flex items-center gap-1.5 text-xs",
                                                        preferences.theme === 'dark'
                                                            ? "border-white/10 text-neutral-300 hover:bg-white/5"
                                                            : "border-gray-200 text-gray-600 hover:bg-gray-50"
                                                    )}
                                                >
                                                    <FileText className="w-4 h-4" />
                                                    <span>{t('editor.continueViewDraft')}</span>
                                                </button>
                                            )}
                                            <button
                                                onClick={() => void handleRebuildChapterSummary()}
                                                disabled={isRebuildingSummary || !currentChapter}
                                                title={t('editor.rebuildSummary')}
                                                className={clsx(
                                                    "shrink-0 p-2 rounded-lg border transition-colors",
                                                    preferences.theme === 'dark'
                                                        ? "border-white/10 text-neutral-300 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        : "border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                )}
                                            >
                                                <ScrollText className={clsx("w-4 h-4", isRebuildingSummary && "animate-pulse")} />
                                            </button>
                                        </>
                                    }
                                    headerContent={
                                        <div className="w-full mb-4 relative">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <input
                                                type="text"
                                                value={title}
                                                onChange={(e) => setTitle(e.target.value)}
                                                placeholder={t('editor.chapterTitle')}
                                                className={`flex-1 min-w-[260px] bg-transparent text-2xl md:text-3xl font-bold outline-none text-left md:text-center font-serif ${preferences.theme === 'dark' ? 'text-neutral-100 placeholder-neutral-600' : 'text-neutral-900 placeholder-neutral-300'}`}
                                            />
                                            <button
                                                onClick={() => void handleGenerateTitle()}
                                                disabled={isGeneratingTitle || !currentChapter || !content.trim()}
                                                title={t('editor.aiTitle')}
                                                className={clsx(
                                                    "shrink-0 p-2 rounded-lg border transition-colors",
                                                    preferences.theme === 'dark'
                                                        ? "border-white/10 text-neutral-300 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        : "border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                )}
                                            >
                                                <Sparkles className={clsx("w-4 h-4", isGeneratingTitle && "animate-pulse")} />
                                            </button>
                                        </div>
                                        {summaryStatus && (
                                            <p className={clsx(
                                                "mt-2 text-xs text-right",
                                                preferences.theme === 'dark' ? 'text-neutral-400' : 'text-gray-500'
                                            )}>
                                                {summaryStatus}
                                            </p>
                                        )}
                                        {continueStatus && (
                                            <p className={clsx(
                                                "mt-1 text-xs text-right",
                                                preferences.theme === 'dark' ? 'text-neutral-400' : 'text-gray-500'
                                            )}>
                                                {continueStatus}
                                            </p>
                                        )}
                                        {titleGenStatus && (
                                            <div className="mt-1">
                                                <p className={clsx(
                                                    "text-xs text-right",
                                                    preferences.theme === 'dark' ? 'text-neutral-400' : 'text-gray-500'
                                                )}>
                                                    {titleGenStatus}
                                                </p>
                                                {titleGenStage && (
                                                    <div className={clsx(
                                                        "mt-1 h-1.5 w-full rounded-full overflow-hidden",
                                                        preferences.theme === 'dark' ? 'bg-white/10' : 'bg-gray-100'
                                                    )}>
                                                        <div
                                                            className={clsx(
                                                                "h-full rounded-full transition-all duration-300",
                                                                preferences.theme === 'dark' ? 'bg-neutral-300/80' : 'bg-gray-500'
                                                            )}
                                                            style={{
                                                                width: titleGenStage === 'requesting'
                                                                    ? '33%'
                                                                    : titleGenStage === 'generating'
                                                                        ? '66%'
                                                                        : '100%',
                                                            }}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {titleCandidates.length > 0 && (
                                            <div
                                                className={clsx(
                                                    "absolute right-0 top-full mt-2 z-20 w-[360px] max-h-56 overflow-y-auto rounded-xl border shadow-xl",
                                                    preferences.theme === 'dark'
                                                        ? "bg-[#121218] border-white/10"
                                                        : "bg-white border-gray-200"
                                                )}
                                            >
                                                <div className={clsx(
                                                    "flex items-center justify-between px-3 py-2 border-b text-xs",
                                                    preferences.theme === 'dark' ? "border-white/10 text-neutral-400" : "border-gray-100 text-gray-500"
                                                )}>
                                                    <span>{t('editor.aiTitleCandidates')}</span>
                                                    <button
                                                        onClick={() => void handleGenerateTitle()}
                                                        disabled={isGeneratingTitle}
                                                        className={clsx(
                                                            "px-2 py-1 rounded-md border transition-colors",
                                                            preferences.theme === 'dark'
                                                                ? "border-white/10 hover:bg-white/5 disabled:opacity-40"
                                                                : "border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                                                        )}
                                                    >
                                                        {t('editor.regenerate')}
                                                    </button>
                                                </div>
                                                {titleCandidates.map((candidate, index) => (
                                                    <button
                                                        key={`${candidate.title}-${index}`}
                                                        onClick={() => {
                                                            setTitle(candidate.title);
                                                            setTitleCandidates([]);
                                                        }}
                                                        className={clsx(
                                                            "w-full text-left px-3 py-2 transition-colors border-b last:border-b-0",
                                                            preferences.theme === 'dark'
                                                                ? "border-white/5 text-neutral-200 hover:bg-white/5"
                                                                : "border-gray-100 text-gray-700 hover:bg-gray-50"
                                                        )}
                                                    >
                                                        <div className="text-sm">{candidate.title}</div>
                                                        <div className={clsx(
                                                            "mt-1 inline-block text-[11px] px-1.5 py-0.5 rounded-full",
                                                            preferences.theme === 'dark'
                                                                ? "bg-white/5 text-neutral-400"
                                                                : "bg-gray-100 text-gray-500"
                                                        )}>
                                                            {candidate.styleTag}
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                }
                                    onAddIdea={handleAddIdea}
                                    onIdeaClick={handleIdeaClick}
                                    recentFiles={recentFiles}
                                    onDeleteRecent={handleDeleteRecent}
                                    onRecentFileSelect={handleSelectChapter}
                                    onPlotContextMenu={handlePlotContextMenu}
                                    onPlotAnchorClick={handlePlotAnchorClick}
                                    novelId={novelId}
                                />
                                {/* Floating Elements */}
                                {plotContextMenuData && (
                                    <PlotContextMenu
                                        data={plotContextMenuData}
                                        onClose={() => setPlotContextMenuData(null)}
                                        onAddAnchor={handleAddAnchorClick}
                                        onRemoveAnchor={handleRemoveAnchor}
                                        onViewDetails={handleViewDetails}
                                        onCreatePoint={handleCreatePointFromSelection}
                                        theme={preferences.theme}
                                    />
                                )}

                                <PlotAnchorModal
                                    novelId={novelId}
                                    isOpen={isPlotAnchorModalOpen}
                                    onClose={() => setIsPlotAnchorModalOpen(false)}
                                    onSubmit={handleSubmitAnchor}
                                    theme={preferences.theme}
                                />
                            </div>
                            {isDraftDockOpen && !isCompactDraftDock && (
                                <div className={clsx(
                                    "w-[420px] min-w-[360px] max-w-[520px] shrink-0 border-l",
                                    preferences.theme === 'dark' ? 'border-white/10 bg-[#0F0F13]' : 'border-gray-200 bg-gray-50',
                                )}>
                                    <AIWorkbenchDraftDock
                                        theme={preferences.theme}
                                        draft={creativeDraft}
                                        selection={creativeSelection}
                                        onDraftChange={handleCreativeDraftChange}
                                        onSelectionChange={handleCreativeSelectionChange}
                                        onDraftAndSelectionChange={handleCreativeDraftAndSelectionChange}
                                    />
                                </div>
                            )}
                            {isDraftDockOpen && isCompactDraftDock && (
                                <>
                                    <button
                                        type="button"
                                        className="absolute inset-0 z-20 bg-black/20"
                                        onClick={() => setIsDraftDockOpen(false)}
                                        aria-label="Close draft dock overlay"
                                    />
                                    <div
                                        className={clsx(
                                            "absolute right-0 top-0 bottom-0 z-30 w-[min(92vw,420px)] border-l shadow-2xl",
                                            preferences.theme === 'dark' ? 'border-white/10 bg-[#0F0F13]' : 'border-gray-200 bg-gray-50',
                                        )}
                                    >
                                        <AIWorkbenchDraftDock
                                            theme={preferences.theme}
                                            draft={creativeDraft}
                                            selection={creativeSelection}
                                            onDraftChange={handleCreativeDraftChange}
                                            onSelectionChange={handleCreativeSelectionChange}
                                            onDraftAndSelectionChange={handleCreativeDraftAndSelectionChange}
                                        />
                                    </div>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-neutral-600 flex-col gap-4">
                            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center">
                                <ArrowLeft className="w-6 h-6 opacity-50" />
                            </div>
                            <p>{t('editor.selectChapter')}</p>
                        </div>
                    )
                ))}

            </div>
            {
                novel && (
                    <SettingsModal
                        isOpen={isSettingsOpen}
                        onClose={() => {
                            setIsSettingsOpen(false);
                            setSettingsInitialTab(undefined);
                        }}
                        initialTab={settingsInitialTab}
                        novelContext={{
                            initialFormatting: novel.formatting || '{}',
                            onSaveFormatting: async (newFormatting) => {
                                await window.db.updateNovel({
                                    id: novelId,
                                    data: { formatting: newFormatting }
                                });
                                setNovel(prev => prev ? ({ ...prev, formatting: newFormatting }) : null);
                            }
                        }}
                    />
                )
            }

            {/* Global Idea Modal */}
            <GlobalIdeaModal
                isOpen={isGlobalIdeaModalOpen}
                onClose={() => setIsGlobalIdeaModalOpen(false)}
                onSave={async (content) => {
                    const newIdea: Idea = {
                        id: crypto.randomUUID(),
                        novelId,
                        chapterId: currentChapter?.id || '',
                        content,
                        timestamp: Date.now(),
                        isStarred: false
                    };

                    setIdeas(prev => [newIdea, ...prev]);
                    setActiveTab('idea');
                    setIsSidePanelOpen(true);

                    try {
                        await window.db.createIdea(newIdea);
                    } catch (e) {
                        console.error('Failed to create global idea:', e);
                    }
                }}
                theme={preferences.theme}
            />

            {isContinueModalOpen && currentChapter && (
                <ContinueWritingModal
                    isOpen={isContinueModalOpen}
                    theme={preferences.theme}
                    onClose={closeContinueModal}
                    blocked={
                        currentChapter.order === 1 && 
                        !plotLines.some((line) => (line.points?.length || 0) > 0) && plotLines.length === 0 &&
                        extractPlainTextFromLexical(contentRef.current || '').length < 120
                    }
                    onNavigateToOutline={() => {
                        setActiveTab('outline');
                        setIsSidePanelOpen(true);
                        closeContinueModal();
                    }}
                    onNavigateToAiWorkbench={() => {
                        setActiveTab('ai_workbench');
                        setIsSidePanelOpen(true);
                        closeContinueModal();
                    }}
                    config={continueConfig}
                    setConfig={setContinueConfig}
                    normalizeTargetLength={normalizeContinueTargetLength}
                    ideas={ideas}
                    isContinuing={isContinuing}
                    onStartContinueWriting={() => void handleStartContinueWriting()}
                    promptLoading={continuePromptLoading}
                    promptError={continuePromptError || ''}
                    promptPreview={continuePromptPreview}
                    promptOverride={continuePromptOverride}
                    promptDefault={continuePromptDefault}
                    onPromptOverrideChange={(value) => {
                        setContinuePromptOverride(value);
                        setContinuePromptDirty(value.trim() !== continuePromptDefault.trim());
                    }}
                    onRefreshPromptPreview={() => void refreshContinuePromptPreview()}
                />
            )}

            {isContinuePreviewOpen && (
                <div className="fixed inset-0 z-[121] flex items-center justify-center bg-black/55 px-4">
                    <div className={clsx(
                        "w-full max-w-4xl rounded-2xl border shadow-2xl",
                        preferences.theme === 'dark' ? 'bg-[#11131a] border-white/10' : 'bg-white border-gray-200'
                    )}>
                        <div className={clsx(
                            "px-5 py-4 border-b flex items-center justify-between",
                            preferences.theme === 'dark' ? 'border-white/10' : 'border-gray-100'
                        )}>
                            <h3 className={clsx("text-sm font-semibold", preferences.theme === 'dark' ? 'text-neutral-100' : 'text-gray-900')}>
                                {t('editor.continuePreviewTitle')}
                            </h3>
                            <button
                                onClick={() => {
                                    setIsContinuePreviewOpen(false);
                                }}
                                className={clsx("text-xs px-2 py-1 rounded border", preferences.theme === 'dark' ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}
                            >
                                {t('common.close', 'Close')}
                            </button>
                        </div>

                        <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[70vh] overflow-y-auto">
                            <div>
                                <div className={clsx("text-xs mb-2", preferences.theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                                    {t('editor.continuePreviewContext')}
                                </div>
                                <pre className={clsx(
                                    "whitespace-pre-wrap rounded-lg border p-3 text-xs leading-relaxed",
                                    preferences.theme === 'dark' ? 'border-white/10 bg-black/20 text-neutral-300' : 'border-gray-200 bg-gray-50 text-gray-700'
                                )}>
                                    {continuePreviewBaseTail || '...'}
                                </pre>
                            </div>
                            <div>
                                <div className={clsx("text-xs mb-2", preferences.theme === 'dark' ? 'text-neutral-400' : 'text-gray-500')}>
                                    {t('editor.continuePreviewInsert')}
                                </div>
                                <pre className={clsx(
                                    "whitespace-pre-wrap rounded-lg border p-3 text-xs leading-relaxed",
                                    preferences.theme === 'dark' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                )}>
                                    {continuePreviewText}
                                </pre>
                            </div>
                        </div>

                        <div className={clsx(
                            "px-5 py-3 border-t flex items-center justify-end gap-2",
                            preferences.theme === 'dark' ? 'border-white/10' : 'border-gray-100'
                        )}>
                            <button
                                onClick={() => {
                                    setIsContinuePreviewOpen(false);
                                    setContinuePreviewText('');
                                    setContinuePreviewBaseTail('');
                                }}
                                className={clsx("text-xs px-3 py-1.5 rounded border", preferences.theme === 'dark' ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}
                            >
                                {t('editor.discardGenerated')}
                            </button>
                            <button
                                onClick={handleConfirmContinueInsert}
                                className={clsx(
                                    "text-xs px-3 py-1.5 rounded border",
                                    preferences.theme === 'dark' ? 'border-white/20 text-neutral-100 hover:bg-white/10' : 'border-gray-300 text-gray-800 hover:bg-gray-50'
                                )}
                            >
                                {t('editor.confirmInsert')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* --- Flow Mode Specific Overlays --- */}
            <div className={clsx("flow-curtain", isFlowSwitching && "active")} />
            <div className={clsx("flow-vignette", isFlowEntering && "active")} />

            {/* Hover Trigger for Exit Hint */}
            {isFlowMode && (
                <>
                    <div className="flow-top-trigger" />
                    <div className="flow-exit-hint" onClick={toggleFlowMode}>
                        {t('common.exitFlow')}
                    </div>
                </>
            )}

            <div
                className={clsx("flow-sidebar-backdrop", isFlowMode && isSidePanelOpen && "active")}
                onClick={() => setIsSidePanelOpen(false)}
            />

            <div
                className="flow-edge-trigger"
                onClick={() => setIsSidePanelOpen(true)}
                title={t('editor.openSidebar')}
            >
                <ChevronRight className="w-5 h-5 trigger-icon" />
            </div>

            <PlotPointModal
                isOpen={isPlotPointModalOpen}
                onClose={() => setIsPlotPointModalOpen(false)}
                point={editingPlotPoint}
                isCreateMode={isPlotPointCreateMode}
                initialData={plotPointCreateData}
                theme={preferences.theme}
                onSave={handleSavePlotPoint}
                onCreate={handleCreatePlotPoint}
                onDelete={handleDeletePlotPoint}
                onAddAnchor={addAnchor}
                onRemoveAnchor={removeAnchor}
                formatting={novel?.formatting}
                volumes={volumes}
                plotLines={plotLines}
            />

        </motion.div>
    );
}



