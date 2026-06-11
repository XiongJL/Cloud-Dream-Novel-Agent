import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { EditorState } from 'lexical';
import { MentionNode } from '../LexicalEditor/nodes/MentionNode';
import MentionsPlugin from '../LexicalEditor/plugins/MentionsPlugin';
import { clsx } from 'clsx';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import LexicalErrorBoundary from '@lexical/react/LexicalErrorBoundary';

interface PlotPointEditorProps {
    initialContent: string;
    onChange: (jsonString: string) => void;
    novelId: string;
    theme: 'dark' | 'light';
    placeholder?: string;
    className?: string;
}

// Plugin to initialize content
function InitialStatePlugin({ content }: { content: string }) {
    const [editor] = useLexicalComposerContext();
    const isLoadedRef = useRef(false);

    useEffect(() => {
        if (isLoadedRef.current) return;
        isLoadedRef.current = true;

        if (!content) return;

        try {
            if (content.trim().startsWith('{')) {
                const editorState = editor.parseEditorState(content);
                editor.setEditorState(editorState);
            } else {
                editor.update(() => {
                    const root = $getRoot();
                    root.clear();
                    const p = $createParagraphNode();
                    p.append($createTextNode(content));
                    root.append(p);
                });
            }
        } catch (e) {
            console.warn('Failed to parse plot point content, falling back to text', e);
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

export default function PlotPointEditor({
    initialContent,
    onChange,
    novelId,
    theme,
    placeholder,
    className
}: PlotPointEditorProps) {
    const { t } = useTranslation();
    const isDark = theme === 'dark';

    const initialConfig = {
        namespace: 'PlotPointEditor',
        theme: {
            paragraph: 'mb-1',
            text: {
                bold: 'font-bold',
                italic: 'italic',
                underline: 'underline',
            }
        },
        onError: (error: Error) => console.error(error),
        nodes: [MentionNode]
    };

    return (
        <LexicalComposer initialConfig={initialConfig}>
            <div className={clsx("relative w-full h-full min-h-[120px]", className)}>
                <RichTextPlugin
                    contentEditable={
                        <ContentEditable
                            className={clsx(
                                "w-full h-full p-2 outline-none text-sm min-h-[120px] resize-none overflow-y-auto custom-scrollbar transition-colors",
                                isDark ? "text-neutral-200" : "text-neutral-800",
                                "focus:outline-none"
                            )}
                        />
                    }

                    placeholder={
                        <div className="absolute top-2 left-2 text-sm opacity-40 pointer-events-none select-none">
                            {placeholder || t('plot.descriptionPlaceholder')}
                        </div>
                    }
                    ErrorBoundary={LexicalErrorBoundary as any}
                />
                <HistoryPlugin />
                <MentionsPlugin novelId={novelId} />
                <OnChangePlugin onChange={(editorState: EditorState) => {
                    editorState.read(() => {
                        const jsonString = JSON.stringify(editorState.toJSON());
                        onChange(jsonString);
                    });
                }} />
                <InitialStatePlugin content={initialContent} />
            </div>
        </LexicalComposer>
    );
}
