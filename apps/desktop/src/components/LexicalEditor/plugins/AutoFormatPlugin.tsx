import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useEffect } from 'react';
import {
    createCommand,
    COMMAND_PRIORITY_EDITOR,
    $getRoot,
} from 'lexical';
import { formatEditorRoot } from '../editorAutoFormat';

export const FORMAT_CONTENT_COMMAND = createCommand<void>('FORMAT_CONTENT_COMMAND');

interface AutoFormatPluginProps {
    language: string;
}

export default function AutoFormatPlugin({ language }: AutoFormatPluginProps) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        return editor.registerCommand(
            FORMAT_CONTENT_COMMAND,
            () => {
                editor.update(() => {
                    formatEditorRoot($getRoot(), language);
                });

                return true;
            },
            COMMAND_PRIORITY_EDITOR
        );
    }, [editor, language]);

    return null;
}
