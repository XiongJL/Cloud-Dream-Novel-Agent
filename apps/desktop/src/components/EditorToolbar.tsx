import {
    Type, AlignLeft, Smartphone, Undo2, Redo2,
    Monitor, ArrowUpLeft
} from 'lucide-react';
import { clsx } from 'clsx';
import { EditorPreferences } from '../hooks/useEditorPreferences';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface EditorToolbarProps {
    preferences: EditorPreferences;
    onUpdatePreference: <K extends keyof EditorPreferences>(key: K, value: EditorPreferences[K]) => void;
    onAutoFormat: () => void;
    onUndo?: () => void;
    onRedo?: () => void;
}

export default function EditorToolbar({
    preferences,
    onUpdatePreference,
    onAutoFormat,
    onUndo,
    onRedo
}: EditorToolbarProps) {
    const { t } = useTranslation();
    const [showMobileMenu, setShowMobileMenu] = useState(false);

    const fontFamilies = [
        { id: 'serif', name: t('toolbar.fontSerif'), style: 'font-serif' },
        { id: 'sans', name: t('toolbar.fontSans'), style: 'font-sans' },
        { id: 'kaiti', name: t('toolbar.fontKaiti'), style: "font-['Kaiti']" },
    ];

    const mobileDevices = [
        { id: 'iphone-se', name: 'iPhone SE', width: 375 },
        { id: 'iphone-14', name: 'iPhone 14', width: 390 },
        { id: 'iphone-14-pro-max', name: '14 Pro Max', width: 430 },
    ];

    return (
        <div className="flex items-center gap-2 px-4 py-2 bg-[#0a0a0f]/90 border-b border-white/5 backdrop-blur-sm shadow-sm z-20 overflow-x-auto scrollbar-none">

            {/* Font Family */}
            <div className="flex bg-white/5 rounded-lg p-0.5">
                {fontFamilies.map(font => (
                    <button
                        key={font.id}
                        onClick={() => onUpdatePreference('fontFamily', font.id as any)}
                        className={clsx(
                            "px-3 py-1.5 rounded text-xs transition-colors",
                            preferences.fontFamily === font.id
                                ? "bg-indigo-600 text-white shadow-sm"
                                : "text-neutral-400 hover:text-white hover:bg-white/5"
                        )}
                        style={{ fontFamily: font.id === 'kaiti' ? 'Kaiti' : undefined }}
                    >
                        {font.name}
                    </button>
                ))}
            </div>

            <div className="w-px h-4 bg-white/10 mx-1" />

            {/* Font Size */}
            <div className="flex items-center gap-2 bg-white/5 rounded-lg px-2 py-1">
                <Type className="w-3 h-3 text-neutral-500" />
                <input
                    type="range"
                    min="14"
                    max="32"
                    step="1"
                    value={preferences.fontSize}
                    onChange={(e) => onUpdatePreference('fontSize', parseInt(e.target.value))}
                    className="w-20 accent-indigo-500 h-1 bg-white/10 rounded-full appearance-none cursor-pointer"
                />
                <span className="text-xs text-neutral-400 w-4 text-center">{preferences.fontSize}</span>
            </div>

            <div className="w-px h-4 bg-white/10 mx-1" />

            {/* View Mode */}
            <div className="flex bg-white/5 rounded-lg p-0.5 relative">
                <button
                    onClick={() => onUpdatePreference('maxWidth', 'wide')}
                    className={clsx(
                        "p-1.5 rounded transition-colors relative group",
                        preferences.maxWidth === 'wide' ? "bg-indigo-600 text-white" : "text-neutral-400 hover:text-white"
                    )}
                    title={t('toolbar.wideMode')}
                >
                    <Monitor className="w-4 h-4" />
                </button>

                <div className="relative">
                    <button
                        onClick={() => {
                            if (preferences.maxWidth !== 'mobile') {
                                onUpdatePreference('maxWidth', 'mobile');
                                setShowMobileMenu(true);
                            } else {
                                setShowMobileMenu(!showMobileMenu);
                            }
                        }}
                        className={clsx(
                            "p-1.5 rounded transition-colors relative group",
                            preferences.maxWidth === 'mobile' ? "bg-indigo-600 text-white" : "text-neutral-400 hover:text-white"
                        )}
                        title={t('toolbar.mobileMode')}
                    >
                        <Smartphone className="w-4 h-4" />
                    </button>

                    {/* Mobile Device Selector Dropdown */}
                    <AnimatePresence>
                        {showMobileMenu && preferences.maxWidth === 'mobile' && (
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 10 }}
                                className="absolute top-full left-0 mt-2 w-32 bg-[#1a1a20] border border-white/10 rounded-lg shadow-xl overflow-hidden z-50 flex flex-col py-1"
                            >
                                {mobileDevices.map(device => (
                                    <button
                                        key={device.id}
                                        onClick={() => {
                                            onUpdatePreference('mobileDevice', device.id as any);
                                            setShowMobileMenu(false);
                                        }}
                                        className={clsx(
                                            "px-3 py-2 text-xs text-left hover:bg-white/5 transition-colors",
                                            preferences.mobileDevice === device.id ? "text-indigo-400 bg-indigo-500/10" : "text-neutral-400"
                                        )}
                                    >
                                        {device.name}
                                    </button>
                                ))}
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            <div className="w-px h-4 bg-white/10 mx-1" />

            {/* Formatting Actions */}
            <button
                onClick={() => onUpdatePreference('indentMode', preferences.indentMode === 'enabled' ? 'disabled' : 'enabled')}
                className={clsx(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors bg-white/5 hover:bg-white/10",
                    preferences.indentMode === 'enabled' ? "text-indigo-400 ring-1 ring-indigo-500/50" : "text-neutral-400"
                )}
                title={t('toolbar.indentTip')}
            >
                <ArrowUpLeft className="w-3 h-3" />
                <span>{t('toolbar.indent')}</span>
            </button>

            <button
                onClick={onAutoFormat}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-white transition-colors"
                title={t('toolbar.formatTip')}
            >
                <AlignLeft className="w-3 h-3" />
                <span>{t('toolbar.format')}</span>
            </button>

            <div className="flex-1" />

            {/* History & Search (Placeholders for now, Undo/Redo logic needs to be passed down) */}
            <div className="flex items-center gap-1">
                <button
                    onClick={onUndo}
                    className="p-1.5 hover:bg-white/10 rounded text-neutral-500 hover:text-white transition-colors"
                    title={t('toolbar.undo')}
                >
                    <Undo2 className="w-4 h-4" />
                </button>
                <button
                    onClick={onRedo}
                    className="p-1.5 hover:bg-white/10 rounded text-neutral-500 hover:text-white transition-colors"
                    title={t('toolbar.redo')}
                >
                    <Redo2 className="w-4 h-4" />
                </button>
            </div>

        </div>
    );
}
