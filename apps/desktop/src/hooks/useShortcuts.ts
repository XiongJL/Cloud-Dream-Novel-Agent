import { useState, useEffect } from 'react';
import i18next from 'i18next';

export type ShortcutAction = 'undo' | 'redo' | 'save' | 'format' | 'enter_focus' | 'toggle_sidebar' | 'create_idea';

export interface KeyBinding {
    key: string;     // e.g. "s", "z", "Enter"
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;  // Command on Mac
}

export type ShortcutMap = Record<ShortcutAction, KeyBinding | null>;

const DEFAULT_SHORTCUTS: ShortcutMap = {
    'undo': { key: 'z', ctrl: true },
    'redo': { key: 'y', ctrl: true }, // Logic: Ctrl+Y or Ctrl+Shift+Z
    'save': { key: 's', ctrl: true },
    'format': { key: 'l', ctrl: true, alt: true }, // Ctrl+Alt+L
    'enter_focus': { key: 'Enter', ctrl: false }, // Special placeholder if we want to config Enter
    'toggle_sidebar': { key: 'b', ctrl: true },
    'create_idea': { key: 'i', ctrl: true } // Ctrl+I
};

// Helper to format binding string like "Ctrl+S"
export function formatShortcut(binding: KeyBinding | null): string {
    if (!binding) return i18next.t('settings.shortcuts.none');
    const parts = [];
    if (binding.ctrl) parts.push('Ctrl');
    if (binding.meta) parts.push('Cmd');
    if (binding.alt) parts.push('Alt');
    if (binding.shift) parts.push('Shift');
    parts.push(binding.key.toUpperCase());
    return parts.join('+');
}

export function useShortcuts() {
    const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS);

    useEffect(() => {
        const saved = localStorage.getItem('user_shortcuts');
        if (saved) {
            try {
                setShortcuts({ ...DEFAULT_SHORTCUTS, ...JSON.parse(saved) });
            } catch (e) { console.error(e) }
        }
    }, []);

    const updateShortcut = (action: ShortcutAction, binding: KeyBinding | null) => {
        setShortcuts(prev => {
            const next = { ...prev, [action]: binding };
            localStorage.setItem('user_shortcuts', JSON.stringify(next));
            return next;
        });
    };

    const isMatch = (e: React.KeyboardEvent | KeyboardEvent, action: ShortcutAction) => {
        const binding = shortcuts[action];
        if (!binding) return false;

        // Redo Special Case: Ctrl+Y OR Ctrl+Shift+Z
        if (action === 'redo' && !binding) {
            // Fallback hardcoded if null/custom removed (not ideal, but keeps logic simple for now)
            // Actually, let's just match the config.
        }

        // Handle Redo dual-binding manually or allow multiple bindings later.
        // For now, if action is redo, we might want to check the default secondary too?
        // Let's stick to strict binding for Custom, but for Redo allow Shift+Z if binding is Y
        if (action === 'redo') {
            // If key is Y and Ctrl is pressed...
            // Just check exact match first
        }

        const isCtrl = e.ctrlKey || e.metaKey; // Treat Cmd/Ctrl as same for simplicity or distinguish
        // Note: e.key for 's' is 's', for 'S' (shift+s) is 'S'. 
        // We compare case-insensitive key usually.

        return (
            e.key.toLowerCase() === binding.key.toLowerCase() &&
            !!binding.ctrl === isCtrl &&
            !!binding.shift === e.shiftKey &&
            !!binding.alt === e.altKey
        );
    };

    return { shortcuts, updateShortcut, isMatch };
}
