import { X, Book, type LucideIcon, Settings as SettingsIcon, Keyboard, Bot, CircleHelp } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { BaseModal } from './ui/BaseModal';
import { formatShortcut, useShortcuts, KeyBinding, ShortcutAction } from '../hooks/useShortcuts';

import { useEditorPreferences } from '../hooks/useEditorPreferences';
import { BackupRestorePanel } from './Settings/BackupRestorePanel';
import { AISettingsPanel } from './Settings/AISettingsPanel';
import { AboutPanel } from './Settings/AboutPanel';
import { Database } from 'lucide-react';
import { DEFAULT_CHAPTER_LENGTH, novelChapterLength, normalizeWritingLength } from '../../shared/writingPolicy';


interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialTab?: TabId;
    // Optional context for Novel settings (if opened from Editor)
    novelContext?: {
        initialFormatting: string;
        onSaveFormatting: (val: string) => Promise<void>;
    };
    // Optional context for Global settings (if opened from Home)
    // currently we share the modal for both, but some tabs might be hidden
}

type TabId = 'general' | 'novel' | 'shortcuts' | 'backup' | 'ai' | 'about';

export default function SettingsModal({ isOpen, onClose, novelContext, initialTab }: SettingsModalProps) {
    const { t, i18n } = useTranslation();
    const [activeTab, setActiveTab] = useState<TabId>('general');
    const { preferences, updatePreference } = useEditorPreferences();

    // Novel Formatting State
    const [config, setConfig] = useState({ volume: '', chapter: '' });
    const [chapterTargetLength, setChapterTargetLength] = useState(String(DEFAULT_CHAPTER_LENGTH));

    // Shortcuts State
    const { shortcuts, updateShortcut } = useShortcuts();
    const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);

    useEffect(() => {
        if (isOpen && novelContext) {
            setChapterTargetLength(String(novelChapterLength(novelContext.initialFormatting) ?? DEFAULT_CHAPTER_LENGTH));
            try {
                const parsed = JSON.parse(novelContext.initialFormatting || '{}');
                setConfig({
                    volume: parsed.volume || '第 {n} 卷',
                    chapter: parsed.chapter || '第 {n} 章'
                });
            } catch (e) {
                setConfig({ volume: '第 {n} 卷', chapter: '第 {n} 章' });
            }
        }
    }, [isOpen, novelContext]);

    useEffect(() => {
        if (!isOpen) return;
        if (initialTab) {
            setActiveTab(initialTab);
            return;
        }
        setActiveTab('general');
    }, [isOpen, initialTab]);

    const handleSaveFormatting = async () => {
        if (novelContext) {
            let previous: Record<string, any> = {};
            try {
                const parsed = JSON.parse(novelContext.initialFormatting || '{}');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
            } catch { /* Legacy malformed settings use defaults. */ }
            await novelContext.onSaveFormatting(JSON.stringify({
                ...previous, ...config,
                writing: { ...previous.writing, chapterTargetLength: normalizeWritingLength(chapterTargetLength) },
            }));
            onClose();
        }
    };

    const changeLanguage = (lng: string) => {
        i18n.changeLanguage(lng);
        localStorage.setItem('language', lng);
    };

    // Listen for key recording
    useEffect(() => {
        if (!recordingAction) return;

        const handler = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            // Ignore modifier-only presses
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

            const binding: KeyBinding = {
                key: e.key,
                ctrl: e.ctrlKey || e.metaKey,
                shift: e.shiftKey,
                alt: e.altKey
            };

            updateShortcut(recordingAction, binding);
            setRecordingAction(null);
        };

        window.addEventListener('keydown', handler, { capture: true });
        return () => window.removeEventListener('keydown', handler, { capture: true });
    }, [recordingAction, updateShortcut]);


    const tabs: { id: TabId; label: string; icon: LucideIcon }[] = [
        { id: 'general', label: t('settings.general.title'), icon: SettingsIcon },
        { id: 'shortcuts', label: t('settings.shortcuts.title'), icon: Keyboard },
        { id: 'backup', label: t('backup.title'), icon: Database },
        { id: 'ai', label: t('settings.ai.title', 'AI'), icon: Bot },
        { id: 'about', label: t('settings.about.title'), icon: CircleHelp },
    ];

    if (novelContext) {
        tabs.splice(1, 0, { id: 'novel', label: t('settings.novel.title'), icon: Book });
    }

    const isDark = preferences.theme === 'dark';

    return (
        <BaseModal isOpen={isOpen} onClose={onClose} theme={preferences.theme} maxWidth="max-w-4xl" className="!p-0 h-[600px] overflow-hidden !flex !flex-row rounded-2xl">
                {/* Sidebar */}
                <div className={clsx(
                    "w-64 shrink-0 border-r flex flex-col",
                    isDark ? "bg-[#14141a] border-white/5" : "bg-gray-50 border-gray-200"
                )}>
                    <div className="p-6">
                        <h2 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                            {t('settings.title')}
                        </h2>
                    </div>
                    <nav className="flex-1 px-4 space-y-2">
                        {tabs.map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={clsx(
                                    "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 text-sm font-medium",
                                    activeTab === tab.id
                                        ? "bg-indigo-600 shadow-lg shadow-indigo-500/20 text-white"
                                        : (isDark ? "text-neutral-400 hover:bg-white/5 hover:text-white" : "text-gray-500 hover:bg-black/5 hover:text-gray-900")
                                )}
                            >
                                <tab.icon className="w-5 h-5" />
                                {tab.label}
                            </button>
                        ))}
                    </nav>
                </div>

                {/* Content */}
                <div className="flex-1 flex flex-col min-w-0 min-h-0">
                    <div className={clsx(
                        "flex items-center justify-between p-6 border-b",
                        isDark ? "border-white/5" : "border-gray-200"
                    )}>
                        <h3 className={clsx("text-lg font-medium", isDark ? "text-white" : "text-gray-900")}>
                            {tabs.find(t => t.id === activeTab)?.label}
                        </h3>
                        <button onClick={onClose} className={clsx(
                            "p-2 rounded-full transition-colors",
                            isDark ? "hover:bg-white/10" : "hover:bg-black/5"
                        )}>
                            <X className={clsx("w-5 h-5", isDark ? "text-neutral-400" : "text-gray-500")} />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-8">
                        {activeTab === 'general' && (
                            <div className="space-y-8">
                                <div className="space-y-4">
                                    <label className={clsx("text-sm font-medium uppercase tracking-widest", isDark ? "text-neutral-400" : "text-gray-500")}>
                                        {t('settings.general.theme')}
                                    </label>
                                    <div className="grid grid-cols-2 gap-4">
                                        <button
                                            onClick={() => updatePreference('theme', 'dark')}
                                            className={clsx(
                                                "p-4 rounded-xl border-2 transition-all duration-200 text-left",
                                                preferences.theme === 'dark'
                                                    ? "border-indigo-500 bg-indigo-500/10"
                                                    : (isDark ? "border-white/5 bg-white/5 hover:border-white/10" : "border-gray-200 bg-gray-50 hover:border-gray-300")
                                            )}
                                        >
                                            <div className={clsx("font-medium", isDark ? "text-white" : "text-gray-900")}>{t('settings.general.dark')}</div>
                                            <div className={clsx("text-xs mt-1", isDark ? "text-neutral-500" : "text-gray-400")}>{t('settings.general.darkDesc')}</div>
                                        </button>
                                        <button
                                            onClick={() => updatePreference('theme', 'light')}
                                            className={clsx(
                                                "p-4 rounded-xl border-2 transition-all duration-200 text-left",
                                                preferences.theme === 'light'
                                                    ? "border-indigo-500 bg-indigo-500/10"
                                                    : (isDark ? "border-white/5 bg-white/5 hover:border-white/10" : "border-gray-200 bg-gray-50 hover:border-gray-300")
                                            )}
                                        >
                                            <div className={clsx("font-medium", isDark ? "text-white" : "text-gray-900")}>{t('settings.general.light')}</div>
                                            <div className={clsx("text-xs mt-1", isDark ? "text-neutral-500" : "text-gray-400")}>{t('settings.general.lightDesc')}</div>
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <label className={clsx("text-sm font-medium uppercase tracking-widest", isDark ? "text-neutral-400" : "text-gray-500")}>
                                        {t('settings.general.language')}
                                    </label>
                                    <div className="grid grid-cols-2 gap-4">
                                        <button
                                            onClick={() => changeLanguage('zh')}
                                            className={clsx(
                                                "p-4 rounded-xl border-2 transition-all duration-200 text-left",
                                                i18n.language === 'zh'
                                                    ? "border-indigo-500 bg-indigo-500/10"
                                                    : (isDark ? "border-white/5 bg-white/5 hover:border-white/10" : "border-gray-200 bg-gray-50 hover:border-gray-300")
                                            )}
                                        >
                                            <div className={clsx("font-medium", isDark ? "text-white" : "text-gray-900")}>中文</div>
                                            <div className={clsx("text-xs mt-1", isDark ? "text-neutral-500" : "text-gray-400")}>简体中文</div>
                                        </button>
                                        <button
                                            onClick={() => changeLanguage('en')}
                                            className={clsx(
                                                "p-4 rounded-xl border-2 transition-all duration-200 text-left",
                                                i18n.language === 'en'
                                                    ? "border-indigo-500 bg-indigo-500/10"
                                                    : (isDark ? "border-white/5 bg-white/5 hover:border-white/10" : "border-gray-200 bg-gray-50 hover:border-gray-300")
                                            )}
                                        >
                                            <div className={clsx("font-medium", isDark ? "text-white" : "text-gray-900")}>English</div>
                                            <div className={clsx("text-xs mt-1", isDark ? "text-neutral-500" : "text-gray-400")}>English (US)</div>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeTab === 'shortcuts' && (
                            <div className="space-y-6">
                                <div className="space-y-2">
                                    <p className={clsx("text-sm", isDark ? "text-neutral-400" : "text-gray-500")}>
                                        {t('settings.shortcuts.recordTip')}
                                    </p>
                                </div>
                                <div className="space-y-2">
                                    {/* @ts-ignore */}
                                    {Object.entries(shortcuts).map(([action, binding]) => (
                                        <div key={action} className={clsx(
                                            "flex items-center justify-between p-4 rounded-xl border",
                                            isDark ? "bg-white/5 border-white/5" : "bg-gray-50 border-gray-200"
                                        )}>
                                            <div>
                                                <div className={clsx("text-base font-medium capitalize", isDark ? "text-neutral-200" : "text-gray-900")}>
                                                    {action.replace('_', ' ')}
                                                </div>
                                                <div className={clsx("text-xs", isDark ? "text-neutral-500" : "text-gray-400")}>
                                                    {t(`settings.shortcuts.actions.${action}`)}
                                                </div>
                                            </div>
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => setRecordingAction(action as ShortcutAction)}
                                                    className={clsx(
                                                        "min-w-[100px] px-4 py-2 rounded-lg text-sm font-mono border transition-all",
                                                        recordingAction === action
                                                            ? "bg-indigo-600 border-indigo-500 text-white animate-pulse"
                                                            : (isDark ? "bg-[#0a0a0f] border-white/10 text-neutral-300 hover:border-white/30" : "bg-white border-gray-300 text-gray-700 hover:border-gray-400")
                                                    )}
                                                >
                                                    {recordingAction === action ? t('settings.shortcuts.recording') : formatShortcut(binding)}
                                                </button>
                                                <button
                                                    onClick={() => updateShortcut(action as ShortcutAction, null)}
                                                    className={clsx(
                                                        "p-2 rounded-lg transition-colors",
                                                        isDark ? "hover:bg-white/10 text-neutral-500 hover:text-red-400" : "hover:bg-black/5 text-gray-400 hover:text-red-500"
                                                    )}
                                                    title={t('settings.shortcuts.unbind')}
                                                >
                                                    <X className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {activeTab === 'backup' && (
                            <BackupRestorePanel />
                        )}

                        {activeTab === 'ai' && (
                            <AISettingsPanel isDark={isDark} />
                        )}

                        {activeTab === 'about' && (
                            <AboutPanel isDark={isDark} />
                        )}

                        {activeTab === 'novel' && novelContext && (
                            <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
                                <label className="block space-y-2">
                                    <span className="text-sm font-medium">{t('settings.novel.chapterTargetLength')}</span>
                                    <input type="number" min={100} max={50000} step={100}
                                        value={chapterTargetLength} onChange={event => setChapterTargetLength(event.target.value)}
                                        onBlur={() => setChapterTargetLength(String(normalizeWritingLength(chapterTargetLength)))}
                                        className={clsx('w-full border rounded-xl px-4 py-3', isDark ? 'bg-[#0a0a0f] border-white/10 text-white' : 'bg-white border-gray-200 text-gray-900')} />
                                    <span className="block text-xs text-gray-500">{t('settings.novel.chapterTargetLengthHint')}</span>
                                </label>
                                <div className="space-y-6">
                                    <div className="space-y-4">
                                        <label className={clsx("text-sm font-medium uppercase tracking-widest", isDark ? "text-neutral-400" : "text-gray-500")}>
                                            {t('settings.novel.volumeFormat')}
                                        </label>
                                        <div className="flex gap-4">
                                            <input
                                                type="text"
                                                value={config.volume}
                                                onChange={(e) => setConfig({ ...config, volume: e.target.value })}
                                                className={clsx(
                                                    "flex-1 border rounded-xl px-4 py-3 outline-none focus:border-indigo-500 transition-colors",
                                                    isDark ? "bg-[#0a0a0f] border-white/10 text-white" : "bg-white border-gray-200 text-gray-900"
                                                )}
                                                placeholder="Example: Volume {n}"
                                            />
                                            <div className={clsx(
                                                "px-4 py-3 rounded-xl border min-w-[120px] text-center",
                                                isDark ? "bg-white/5 border-white/5 text-neutral-400" : "bg-gray-50 border-gray-200 text-gray-500"
                                            )}>
                                                {config.volume.replace('{n}', '1')}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="space-y-4">
                                        <label className={clsx("text-sm font-medium uppercase tracking-widest", isDark ? "text-neutral-400" : "text-gray-500")}>
                                            {t('settings.novel.chapterFormat')}
                                        </label>
                                        <div className="flex gap-4">
                                            <input
                                                type="text"
                                                value={config.chapter}
                                                onChange={(e) => setConfig({ ...config, chapter: e.target.value })}
                                                className={clsx(
                                                    "flex-1 border rounded-xl px-4 py-3 outline-none focus:border-indigo-500 transition-colors",
                                                    isDark ? "bg-[#0a0a0f] border-white/10 text-white" : "bg-white border-gray-200 text-gray-900"
                                                )}
                                                placeholder="Example: Chapter {n}"
                                            />
                                            <div className={clsx(
                                                "px-4 py-3 rounded-xl border min-w-[120px] text-center",
                                                isDark ? "bg-white/5 border-white/5 text-neutral-400" : "bg-gray-50 border-gray-200 text-gray-500"
                                            )}>
                                                {config.chapter.replace('{n}', '1')}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className={clsx("pt-8 border-t flex justify-end", isDark ? "border-white/5" : "border-gray-100")}>
                                    <button
                                        onClick={handleSaveFormatting}
                                        className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors shadow-lg shadow-indigo-500/20"
                                    >
                                        {t('common.confirm')}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
        </BaseModal>
    );
}
