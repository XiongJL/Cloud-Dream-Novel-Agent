import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { $convertFromMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $getRoot } from 'lexical';
import { memo, useCallback, useEffect, useId, useMemo, useState, type MouseEvent } from 'react';
import clsx from 'clsx';

export type AssistantMarkdownProps = {
    content: string;
    isDark: boolean;
    variant: 'chat' | 'document';
    ariaLabel: string;
    className?: string;
};

function createMarkdownTheme(variant: AssistantMarkdownProps['variant'], isDark: boolean) {
    const commonTheme = {
        text: {
            bold: 'font-semibold',
            code: clsx('rounded px-1 py-0.5 font-mono text-[0.9em]', isDark ? 'bg-white/10' : 'bg-black/5'),
            italic: 'italic',
            strikethrough: 'line-through',
            underline: 'underline',
        },
        link: 'cursor-pointer text-[#2f80ed] underline decoration-[#2f80ed]/40 underline-offset-2',
    };

    if (variant === 'chat') {
        return {
            ...commonTheme,
            paragraph: 'mb-3 last:mb-0',
            heading: {
                h1: 'mb-2 mt-4 text-base font-semibold leading-6 first:mt-0',
                h2: 'mb-2 mt-4 text-[15px] font-semibold leading-6 first:mt-0',
                h3: 'mb-1.5 mt-3 text-sm font-semibold leading-6 first:mt-0',
                h4: 'mb-1.5 mt-3 text-sm font-medium leading-6 first:mt-0',
                h5: 'mb-1.5 mt-3 text-sm font-medium leading-6 first:mt-0',
                h6: 'mb-1.5 mt-3 text-xs font-medium leading-5 first:mt-0',
            },
            list: {
                listitem: 'mb-1 ml-5',
                nested: { listitem: 'list-none' },
                ol: 'mb-3 list-decimal space-y-1 pl-2',
                ul: 'mb-3 list-disc space-y-1 pl-2',
            },
            quote: 'my-3 border-l-2 border-[#2f80ed]/50 pl-3 italic opacity-80',
            code: clsx('my-3 block overflow-x-auto rounded-md p-3 font-mono text-[13px]', isDark ? 'bg-white/5' : 'bg-black/5'),
        };
    }

    return {
        ...commonTheme,
        paragraph: 'mb-4 last:mb-0',
        heading: {
            h1: 'mb-5 mt-1 text-2xl font-semibold leading-tight',
            h2: 'mb-3 mt-7 text-xl font-semibold leading-tight',
            h3: 'mb-2 mt-5 text-base font-semibold leading-tight',
            h4: 'mb-2 mt-4 text-sm font-semibold leading-tight',
            h5: 'mb-2 mt-4 text-sm font-medium leading-tight',
            h6: 'mb-2 mt-4 text-xs font-medium uppercase tracking-wide',
        },
        list: {
            listitem: 'mb-1 ml-5',
            nested: { listitem: 'list-none' },
            ol: 'mb-4 list-decimal space-y-1 pl-2',
            ul: 'mb-4 list-disc space-y-1 pl-2',
        },
        quote: 'my-4 border-l-2 border-[#2f80ed]/50 pl-4 italic opacity-80',
        code: clsx('my-4 block overflow-x-auto rounded-md p-3 font-mono text-[13px]', isDark ? 'bg-white/5' : 'bg-black/5'),
    };
}

function MarkdownImportPlugin({ content }: { content: string }) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        editor.update(() => {
            const root = $getRoot();
            root.clear();
            $convertFromMarkdownString(content, TRANSFORMERS, root);
        });
    }, [content, editor]);

    return null;
}

function AssistantMarkdown({
    content,
    isDark,
    variant,
    ariaLabel,
    className,
}: AssistantMarkdownProps) {
    const instanceId = useId();
    const [renderFailed, setRenderFailed] = useState(false);

    useEffect(() => {
        setRenderFailed(false);
    }, [content]);

    const handleError = useCallback((error: Error) => {
        console.error('[AssistantMarkdown]', error);
        setRenderFailed(true);
    }, []);

    const initialConfig = useMemo(() => ({
        namespace: `AssistantMarkdown:${variant}:${instanceId}`,
        editable: false,
        theme: createMarkdownTheme(variant, isDark),
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode],
        onError: handleError,
    }), [handleError, instanceId, isDark, variant]);

    const handleLink = useCallback((event: MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target.closest('a') : null;
        if (!target) return;
        if (event.type === 'auxclick' && event.button !== 1) return;

        event.preventDefault();
        const href = target.getAttribute('href');
        if (href) void window.electron.openExternal(href);
    }, []);

    const wrapperClass = clsx(
        'min-w-0 break-words',
        variant === 'chat' ? 'text-sm leading-6' : 'text-[15px] leading-7',
        isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]',
        className,
    );

    if (renderFailed) {
        return (
            <div className={clsx(wrapperClass, 'whitespace-pre-wrap')} role="document" aria-label={ariaLabel}>
                {content}
            </div>
        );
    }

    return (
        <LexicalComposer key={`${variant}:${isDark ? 'dark' : 'light'}`} initialConfig={initialConfig}>
            <div className={wrapperClass} onClick={handleLink} onAuxClick={handleLink}>
                <RichTextPlugin
                    contentEditable={(
                        <ContentEditable
                            className="min-h-0 break-words outline-none"
                            aria-label={ariaLabel}
                            aria-readonly="true"
                        />
                    )}
                    placeholder={null}
                    ErrorBoundary={LexicalErrorBoundary}
                />
                <MarkdownImportPlugin content={content} />
            </div>
        </LexicalComposer>
    );
}

export default memo(AssistantMarkdown);
