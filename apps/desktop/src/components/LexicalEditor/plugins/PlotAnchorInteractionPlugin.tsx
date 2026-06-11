import { CLICK_COMMAND, COMMAND_PRIORITY_NORMAL, $getNearestNodeFromDOMNode } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useEffect } from 'react';
import { $isMarkNode } from '@lexical/mark';
import { $isPlotAnchorNode } from '../nodes/PlotAnchorNode';

interface PlotAnchorInteractionPluginProps {
    onAnchorClick?: (anchorId: string) => void;
}

export default function PlotAnchorInteractionPlugin({ onAnchorClick }: PlotAnchorInteractionPluginProps) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        return editor.registerCommand(
            CLICK_COMMAND,
            (event: MouseEvent) => {
                const target = event.target as HTMLElement;
                if (!target.isConnected) return false;

                // Priority 1: Check data-plot-anchor-id attribute
                const anchorElement = target.closest('[data-plot-anchor-id]');
                if (anchorElement) {
                    const id = anchorElement.getAttribute('data-plot-anchor-id');
                    if (id && onAnchorClick) {
                        onAnchorClick(id);
                        return true; // Stop propagation if handled
                    }
                }

                // Priority 2: Check Lexical node
                try {
                    const node = $getNearestNodeFromDOMNode(target);
                    if (node) {
                        if ($isPlotAnchorNode(node) || $isMarkNode(node)) {
                            // Verify it's actually a plot anchor node if it's a generic MarkNode (though distinct classes should exist)
                            // $isPlotAnchorNode is just checking instanceof PlotAnchorNode
                            // If it's a mark node, we should check if it has plot anchor logic if needed, 
                            // but usually the class/attribute check above catches DOM.
                            // However, let's be safe with node logic.
                            const ids = node.getIDs();
                            // If it's generic mark node, we might not know if it's an anchor unless we check type or something.
                            // But usually PlotAnchorNode handles this.
                            if (ids.length > 0 && onAnchorClick) {
                                // Double check if this node is meant to be handled here?
                                // If IdeaInteractionPlugin also handles MarkNodes, we might have conflict?
                                // No, IdeaInteractionPlugin checks $isIdeaMarkNode.
                                // So we should check $isPlotAnchorNode.
                                if ($isPlotAnchorNode(node)) {
                                    onAnchorClick(ids[0]);
                                    return true;
                                }
                            }
                        }
                        const parent = node.getParent();
                        if (parent && ($isPlotAnchorNode(parent) || $isMarkNode(parent))) {
                            const ids = parent.getIDs();
                            if (ids.length > 0 && onAnchorClick) {
                                if ($isPlotAnchorNode(parent)) {
                                    onAnchorClick(ids[0]);
                                    return true;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('PlotAnchorInteractionPlugin click error:', e);
                }

                return false;
            },
            COMMAND_PRIORITY_NORMAL
        );
    }, [editor, onAnchorClick]);

    return null;
}
