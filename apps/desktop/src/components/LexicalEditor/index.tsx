import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { EditorState, LexicalEditor, $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import theme from './theme';
import { IdeaMarkNode } from './nodes/IdeaMarkNode';
import { PlotAnchorNode } from './nodes/PlotAnchorNode';
import { MentionNode } from './nodes/MentionNode';

// Plugins
import ToolbarPlugin from './plugins/ToolbarPlugin';
import StylePlugin from './plugins/StylePlugin';
import ShortcutsPlugin from './plugins/ShortcutsPlugin';
import AutoFormatPlugin from './plugins/AutoFormatPlugin';
import FloatingTextFormatToolbarPlugin from './plugins/FloatingTextFormatToolbarPlugin';
import IdeaInteractionPlugin from './plugins/IdeaInteractionPlugin';
import PlotAnchorInteractionPlugin from './plugins/PlotAnchorInteractionPlugin'; // [NEW]
import PlotContextMenuPlugin, { PlotContextMenuData } from './plugins/PlotContextMenuPlugin';
import EditorSearchToolbar from './ui/EditorSearchToolbar';
import WordCountPlugin from './plugins/WordCountPlugin';
import { EditorPreferences } from '../../hooks/useEditorPreferences';
import { ShortcutMap } from '../../hooks/useShortcuts';
import { RecentFile } from '../../components/RecentFilesDropdown';

// Wrapper to handle initial content properly
function InitialStatePlugin({ content }: { content: string }) {
    const [editor] = useLexicalComposerContext();
    const isLoadedRef = useRef(false);

    useEffect(() => {
        if (isLoadedRef.current) return;
        isLoadedRef.current = true;

        if (!content) return;

        try {
            // Try to parse as JSON first (new format)
            if (content.trim().startsWith('{')) {
                const editorState = editor.parseEditorState(content);
                editor.setEditorState(editorState);
            } else {
                // Fallback to plain text (old format)
                editor.update(() => {
                    const root = $getRoot();
                    root.clear();
                    const p = $createParagraphNode();
                    p.append($createTextNode(content));
                    root.append(p);
                });
            }
        } catch (e) {
            console.warn('Failed to parse editor state, falling back to text', e);
            // Fallback
            editor.update(() => {
                const root = $getRoot();
                root.clear();
                const p = $createParagraphNode();
                p.append($createTextNode(content));
                root.append(p);
            });
        }
    }, [content, editor]);

    return null;
}

// Plugin to expose editor instance
function EditorRefPlugin({ editorRef }: { editorRef: React.MutableRefObject<LexicalEditor | null> }) {
    const [editor] = useLexicalComposerContext();
    useEffect(() => {
        editorRef.current = editor;
        return () => {
            editorRef.current = null;
        };
    }, [editor, editorRef]);
    return null;
}

// iPhone 15 Frame Component
function IPhoneFrame({ children, theme }: { children: React.ReactNode, theme: 'light' | 'dark' }) {
    const isDark = theme === 'dark';
    return (
        <div className="relative mx-auto" style={{ width: '393px' }}>
            {/* Phone Body */}
            <div className="relative bg-black rounded-[3rem] p-3 shadow-2xl border-4 border-neutral-700">
                {/* Dynamic Island */}
                <div className="absolute top-4 left-1/2 -translate-x-1/2 w-28 h-8 bg-black rounded-full z-20" />

                {/* Screen */}
                <div className={`relative rounded-[2.5rem] overflow-hidden ${isDark ? 'bg-[#1a1a20]' : 'bg-white'}`} style={{ minHeight: '750px' }}>
                    {/* Status Bar */}
                    <div className={`h-12 flex items-center justify-between px-8 pt-2 ${isDark ? 'bg-[#1a1a20] text-white' : 'bg-white text-black'}`}>
                        <span className="text-xs font-semibold">9:41</span>
                        <div className="flex items-center gap-1">
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9z" /></svg>
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M2 17h20v2H2zm0-5h20v2H2zm0-5h20v2H2z" /></svg>
                            <div className="w-6 h-3 rounded-sm ml-1" style={{ backgroundColor: 'currentColor' }} />
                        </div>
                    </div>

                    {/* Content Area */}
                    <div className={`px-5 pb-8 pt-2 min-h-[650px] overflow-y-auto ${isDark ? 'text-neutral-300' : 'text-black'}`}>
                        {children}
                    </div>

                    {/* Home Indicator */}
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-32 h-1 bg-black/30 rounded-full" />
                </div>
            </div>
        </div>
    );
}

interface LexicalChapterEditorProps {
    namespace: string;
    initialContent: string;
    onChange: (editorState: EditorState) => void;
    readOnly?: boolean;
    className?: string;
    style?: React.CSSProperties;
    editorRef?: React.MutableRefObject<LexicalEditor | null>;
    preferences: EditorPreferences;
    onUpdatePreference: <K extends keyof EditorPreferences>(key: K, value: EditorPreferences[K]) => void;
    shortcuts: ShortcutMap;
    onSave: () => void;
    onCreateIdea?: () => void; // Callback for Ctrl+I global idea creation
    headerContent?: React.ReactNode;
    toolbarActions?: React.ReactNode;
    saveIndicatorState?: 'idle' | 'saving' | 'saved' | 'error';
    saveIndicatorText?: string;
    language?: string; // 'zh' | 'en'
    onAddIdea: (id: string, quote: string, cursor: string, note: string) => void;
    onIdeaClick?: (ideaId: string) => void;
    recentFiles?: RecentFile[];
    onDeleteRecent?: (id: string) => void;
    onRecentFileSelect?: (id: string) => void;
    onPlotContextMenu?: (data: PlotContextMenuData) => void;
    onPlotAnchorClick?: (anchorId: string) => void;
    novelId?: string;
}

export default function LexicalChapterEditor({
    namespace,
    initialContent,
    onChange,
    readOnly = false,
    className,
    style,
    editorRef,
    preferences,
    onUpdatePreference,
    shortcuts,
    onSave,
    onCreateIdea,
    headerContent,
    toolbarActions,
    saveIndicatorState = 'idle',
    saveIndicatorText = '',
    language = 'zh',
    onAddIdea,
    onIdeaClick,
    recentFiles,
    onDeleteRecent,
    onRecentFileSelect,
    onPlotContextMenu,
    onPlotAnchorClick
}: LexicalChapterEditorProps) {

    const { t } = useTranslation();

    const initialConfig = {
        namespace,
        theme,
        onError: (error: Error) => console.error(error),
        editable: !readOnly,
        nodes: [IdeaMarkNode, PlotAnchorNode, MentionNode]
    };

    const isMobile = preferences.maxWidth === 'mobile';
    const isDark = preferences.theme === 'dark';

    // Editor Content (shared between modes)
    const EditorContent = (
        <>
            {/* Chapter Title */}
            {headerContent && (
                <div className={`mb-6 ${isMobile ? (isDark ? 'text-white' : 'text-black') : ''}`}>
                    {headerContent}
                </div>
            )}

            <div className="relative flex-1">
                <RichTextPlugin
                    contentEditable={
                        <ContentEditable
                            className={`outline-none min-h-[400px] whitespace-pre-wrap break-words ${className} ${isMobile ? (isDark ? 'text-neutral-300' : 'text-black') : ''}`}
                            style={{
                                ...style,
                                wordBreak: 'normal', // 不强制断词
                                overflowWrap: 'break-word', // 仅在必要时换行
                            }}
                        />
                    }
                    placeholder={<div className={`absolute top-0 left-0 pointer-events-none ${isMobile ? 'text-gray-400' : 'text-gray-500'}`}>{t('editor.startWriting')}</div>}
                    ErrorBoundary={LexicalErrorBoundary}
                />
            </div>
        </>
    );

    return (
        <LexicalComposer initialConfig={initialConfig}>
            <div className={`relative h-full flex flex-col ${isDark ? 'bg-neutral-900 text-neutral-200' : 'bg-white text-neutral-900'}`}>
                {/* Full Width Toolbar */}
                <ToolbarPlugin
                    preferences={preferences}
                    onUpdatePreference={onUpdatePreference}
                    recentFiles={recentFiles}
                    onDeleteRecent={onDeleteRecent}
                    onRecentFileSelect={onRecentFileSelect}
                    rightActions={toolbarActions}
                />

                {/* Scrollable Content Area */}
                <div className="relative flex-1 overflow-y-auto py-8">
                    {isMobile ? (
                        /* Mobile Mode: iPhone Frame */
                        <IPhoneFrame theme={preferences.theme}>
                            {/* Title in mobile needs special styling */}
                            {headerContent && (
                                <input
                                    type="text"
                                    value=""
                                    readOnly
                                    className={`w-full bg-transparent text-xl font-bold placeholder-gray-400 outline-none text-center mb-4 pointer-events-none hidden ${isDark ? 'text-white' : 'text-black'}`}
                                />
                            )}
                            {EditorContent}
                        </IPhoneFrame>
                    ) : (
                        /* Wide Mode: Centered Container */
                        <div className="mx-auto max-w-5xl px-8">
                            {EditorContent}
                        </div>
                    )}
                </div>

                <HistoryPlugin />
                <OnChangePlugin onChange={(editorState) => onChange(editorState)} />
                <InitialStatePlugin content={initialContent} />
                {editorRef && <EditorRefPlugin editorRef={editorRef} />}

                <WordCountPlugin
                    isDark={isDark}
                    saveState={saveIndicatorState}
                    saveStatusText={saveIndicatorText}
                />

                {/* Advanced Feature Plugins */}
                <StylePlugin
                    fontSize={preferences.fontSize}
                    lineHeight={preferences.lineHeight}
                    fontFamily={preferences.fontFamily}
                    indentMode={preferences.indentMode}
                />
                <ShortcutsPlugin shortcuts={shortcuts} onSave={onSave} onCreateIdea={onCreateIdea} />
                <AutoFormatPlugin language={language} />

                <FloatingTextFormatToolbarPlugin onAddIdea={onAddIdea} />
                <IdeaInteractionPlugin onIdeaClick={onIdeaClick} />
                {onPlotAnchorClick && <PlotAnchorInteractionPlugin onAnchorClick={onPlotAnchorClick} />}
                {onPlotContextMenu && <PlotContextMenuPlugin onOpenMenu={onPlotContextMenu} />}
                <EditorSearchToolbar />
            </div>
        </LexicalComposer>
    );
}
