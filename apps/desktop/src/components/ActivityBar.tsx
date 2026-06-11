import { BookOpen, Users, Map as MapIcon, FileText, Settings, Lightbulb, Search, WandSparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

export type ActivityTab = 'explorer' | 'outline' | 'characters' | 'map' | 'ai_workbench' | 'idea' | 'settings' | 'search';

interface ActivityBarProps {
    activeTab: ActivityTab | null;
    onTabChange: (tab: ActivityTab) => void;
    theme: 'dark' | 'light';
}

export default function ActivityBar({ activeTab, onTabChange, theme }: ActivityBarProps) {
    const { t } = useTranslation();

    const items: { id: ActivityTab; icon: React.ElementType; label: string }[] = [
        { id: 'explorer', icon: BookOpen, label: t('sidebar.explorer') },
        { id: 'search', icon: Search, label: t('sidebar.search') },
        { id: 'outline', icon: FileText, label: t('sidebar.outline') },
        { id: 'characters', icon: Users, label: t('sidebar.characters') },
        { id: 'map', icon: MapIcon, label: t('sidebar.map') },
        { id: 'ai_workbench', icon: WandSparkles, label: t('sidebar.aiWorkbench') },
        { id: 'idea', icon: Lightbulb, label: t('sidebar.idea') },
    ];

    const isDark = theme === 'dark';

    return (
        <div className={clsx(
            'w-12 flex flex-col items-center py-4 border-r z-20 transition-colors duration-300',
            isDark ? 'bg-[#0F0F13] border-white/5' : 'bg-gray-100 border-gray-200'
        )}>
            <div className="flex flex-col gap-6 w-full items-center">
                {items.map(item => (
                    <button
                        key={item.id}
                        onClick={() => onTabChange(item.id)}
                        title={item.label}
                        className={clsx(
                            'p-2 rounded-lg transition-all duration-200 relative group',
                            activeTab === item.id
                                ? (isDark ? 'text-indigo-400 bg-white/5' : 'text-indigo-600 bg-black/5')
                                : (isDark ? 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5' : 'text-neutral-500 hover:text-neutral-800 hover:bg-black/5')
                        )}
                    >
                        <item.icon className="w-6 h-6 stroke-[1.5]" />

                        {activeTab === item.id && (
                            <div className="absolute left-0 top-2 bottom-2 w-[3px] bg-indigo-500 rounded-r-full" />
                        )}
                    </button>
                ))}
            </div>

            <div className="mt-auto flex flex-col gap-6 w-full items-center">
                <button
                    onClick={() => onTabChange('settings')}
                    title={t('editor.settings')}
                    className={clsx(
                        'p-2 rounded-lg transition-all duration-200',
                        activeTab === 'settings'
                            ? (isDark ? 'text-indigo-400 bg-white/5' : 'text-indigo-600 bg-black/5')
                            : (isDark ? 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5' : 'text-neutral-500 hover:text-neutral-800 hover:bg-black/5')
                    )}
                >
                    <Settings className="w-6 h-6 stroke-[1.5]" />
                </button>
            </div>
        </div>
    );
}
