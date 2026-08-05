import {
    $createParagraphNode,
    $isElementNode,
    $isParagraphNode,
    $isTextNode,
    type RootNode,
} from 'lexical';
import {
    formatTextContent,
    isBlankParagraph,
    trimParagraphEnd,
    trimParagraphStart,
} from './autoFormat.ts';

export function formatEditorRoot(root: RootNode, language: string): void {
    root.getChildren().forEach((block) => {
        if (!$isElementNode(block)) return;

        const firstDescendant = block.getFirstDescendant();
        const lastDescendant = block.getLastDescendant();
        const firstTextKey = $isTextNode(firstDescendant) ? firstDescendant.getKey() : null;
        const lastTextKey = $isTextNode(lastDescendant) ? lastDescendant.getKey() : null;

        block.getAllTextNodes().forEach((textNode) => {
            const originalText = textNode.getTextContent();
            const isFirstText = textNode.getKey() === firstTextKey;
            const isLastText = textNode.getKey() === lastTextKey;
            let formattedText = formatTextContent(originalText, language, isFirstText);

            if (isFirstText) formattedText = trimParagraphStart(formattedText);
            if (isLastText) formattedText = trimParagraphEnd(formattedText);

            if (originalText !== formattedText) {
                textNode.setTextContent(formattedText);
            }
        });
    });

    root.getChildren().forEach((block) => {
        if ($isParagraphNode(block) && isBlankParagraph(block.getTextContent())) {
            block.remove();
        }
    });

    if (root.isEmpty()) {
        root.append($createParagraphNode());
    }
}
