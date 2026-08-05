import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LexicalEditor } from 'lexical';

type UseFlowModeControllerParams = {
    editorRef: RefObject<LexicalEditor | null>;
    isSidePanelOpen: boolean;
    setIsSidePanelOpen: (value: boolean) => void;
};

export function useFlowModeController({
    editorRef,
    isSidePanelOpen,
    setIsSidePanelOpen,
}: UseFlowModeControllerParams) {
    const [isFlowMode, setIsFlowMode] = useState(false);
    const [isFlowEntering, setIsFlowEntering] = useState(false);
    const [isFlowSwitching, setIsFlowSwitching] = useState(false);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const isWindowFullScreenRef = useRef(false);

    const toggleFlowMode = useCallback(async () => {
        setIsFlowSwitching(true);
        const nextState = !isFlowMode;

        window.setTimeout(async () => {
            try {
                if (nextState) {
                    document.body.classList.add('flow-mode-active');
                    setIsSidePanelOpen(false);
                    setIsFlowEntering(true);
                    window.setTimeout(() => setIsFlowEntering(false), 1500);
                } else {
                    document.body.classList.remove('flow-mode-active');
                    setIsSidePanelOpen(true);
                }
                setIsFlowMode(nextState);
            } catch (err) {
                console.error('FlowMode toggle error:', err);
            }

            try {
                if (window.electron?.toggleFullScreen) {
                    const fullScreen = await window.electron.toggleFullScreen();
                    isWindowFullScreenRef.current = fullScreen;
                    setIsFullScreen(fullScreen);
                }
            } catch {
                // ignore fullscreen toggle failures
            }

            window.setTimeout(() => {
                editorRef.current?.focus();
            }, 500);

            window.setTimeout(() => {
                setIsFlowSwitching(false);
            }, 400);
        }, 100);
    }, [editorRef, isFlowMode, setIsSidePanelOpen]);

    useEffect(() => {
        if (!window.electron?.onFullScreenChange) return;

        const unsubscribe = window.electron.onFullScreenChange((fullScreen: boolean) => {
            isWindowFullScreenRef.current = fullScreen;
            setIsFullScreen(fullScreen);
            if (!fullScreen && isFlowMode) {
                document.body.classList.remove('flow-mode-active');
                setIsFlowMode(false);
                setIsFlowEntering(false);
                setIsFlowSwitching(false);
                setIsSidePanelOpen(true);
            }
        });

        return () => unsubscribe();
    }, [isFlowMode, setIsSidePanelOpen]);

    useEffect(() => {
        if (!isFlowMode) return;

        const handleEscExitFlow = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();

            if (isSidePanelOpen) {
                setIsSidePanelOpen(false);
                return;
            }

            document.body.classList.remove('flow-mode-active');
            setIsFlowMode(false);
            setIsFlowEntering(false);
            setIsFlowSwitching(false);
            setIsSidePanelOpen(true);

            if (isWindowFullScreenRef.current && window.electron?.toggleFullScreen) {
                window.electron.toggleFullScreen().catch((error: unknown) => {
                    console.warn('[Editor] failed to exit fullscreen on ESC fallback:', error);
                });
            }
        };

        window.addEventListener('keydown', handleEscExitFlow, { capture: true });
        return () => window.removeEventListener('keydown', handleEscExitFlow, { capture: true } as EventListenerOptions);
    }, [isFlowMode, isSidePanelOpen, setIsSidePanelOpen]);

    return {
        isFlowMode,
        isFullScreen,
        isFlowEntering,
        isFlowSwitching,
        toggleFlowMode,
    };
}
