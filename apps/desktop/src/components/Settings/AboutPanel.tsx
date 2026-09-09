import { BookOpen, Download, ExternalLink, Github, Loader2, MessageCircle, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

interface AboutPanelProps {
    isDark: boolean;
}

const GITHUB_URL = 'https://github.com/XiongJL/Cloud-Dream-Novel-Agent';
const ISSUE_URL = `${GITHUB_URL}/issues`;
const RELEASES_URL = `${GITHUB_URL}/releases`;

type UpdateInfo = Awaited<ReturnType<typeof window.electron.getUpdateInfo>>;

export function AboutPanel({ isDark }: AboutPanelProps) {
    const { t } = useTranslation();
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [isChecking, setIsChecking] = useState(true);

    const openExternal = (url: string) => {
        void window.electron.openExternal(url);
    };

    const checkForUpdate = async () => {
        setIsChecking(true);
        try {
            setUpdateInfo(await window.electron.getUpdateInfo());
        } finally {
            setIsChecking(false);
        }
    };

    useEffect(() => {
        void checkForUpdate();
    }, []);

    const linkRows = [
        {
            icon: Github,
            label: t('settings.about.github'),
            value: 'github.com/XiongJL/Cloud-Dream-Novel-Agent',
            url: GITHUB_URL,
        },
        {
            icon: MessageCircle,
            label: t('settings.about.feedback'),
            value: t('settings.about.feedbackAction'),
            url: ISSUE_URL,
        },
    ];

    return (
        <div className="mx-auto flex w-full max-w-xl flex-col py-1 animate-in fade-in slide-in-from-right-4 duration-300">
            <section className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                    <div className={clsx(
                        'flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border shadow-sm',
                        isDark
                            ? 'border-indigo-400/20 bg-indigo-400/10 text-indigo-300'
                            : 'border-indigo-100 bg-indigo-50 text-indigo-600',
                    )}>
                        <div className="relative">
                            <BookOpen className="h-8 w-8 stroke-[1.7]" />
                            <Sparkles className={clsx(
                                'absolute -right-2 -top-2 h-3.5 w-3.5',
                                isDark ? 'text-violet-200' : 'text-violet-500',
                            )} />
                        </div>
                    </div>
                    <div>
                        <h4 className={clsx('text-xl font-semibold tracking-tight', isDark ? 'text-white' : 'text-gray-900')}>
                            {t('settings.about.productName')}
                        </h4>
                        <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-gray-500')}>
                            {t('settings.about.tagline')}
                        </p>
                    </div>
                </div>

                <div className={clsx(
                    'min-w-[176px] rounded-xl border px-4 py-3',
                    isDark ? 'border-white/10 bg-white/5' : 'border-indigo-100 bg-indigo-50/60',
                )}>
                    <p className={clsx('text-xs font-medium', isDark ? 'text-neutral-500' : 'text-gray-500')}>
                        {t('settings.about.latestVersion')}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                        <span className={clsx('text-base font-semibold', isDark ? 'text-white' : 'text-gray-900')}>
                            v{updateInfo?.currentVersion ?? '…'}
                        </span>
                        {!isChecking && updateInfo?.status === 'up-to-date' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                        {!isChecking && updateInfo?.status === 'available' && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
                        <span className={clsx(
                            'text-xs',
                            updateInfo?.status === 'available'
                                ? (isDark ? 'text-amber-300' : 'text-amber-600')
                                : (isDark ? 'text-emerald-300' : 'text-emerald-600'),
                        )}>
                            {isChecking
                                ? t('settings.about.checking')
                                : updateInfo?.status === 'available'
                                    ? t('settings.about.updateAvailable', { version: updateInfo.latestVersion })
                                    : updateInfo?.status === 'unavailable'
                                        ? t('settings.about.checkUnavailable')
                                        : t('settings.about.upToDate')}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => void checkForUpdate()}
                        disabled={isChecking}
                        className={clsx(
                            'mt-2 flex items-center gap-1 text-xs transition-colors disabled:cursor-wait',
                            isDark ? 'text-neutral-400 hover:text-white' : 'text-gray-500 hover:text-gray-900',
                        )}
                    >
                        {isChecking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        {t('settings.about.checkForUpdates')}
                    </button>
                </div>
            </section>

            <button
                type="button"
                onClick={() => openExternal(updateInfo?.releaseUrl ?? RELEASES_URL)}
                className={clsx(
                    'mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-colors',
                    updateInfo?.updateAvailable
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-500'
                        : (isDark ? 'bg-white/10 text-neutral-200 hover:bg-white/15' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'),
                )}
            >
                <Download className="h-4 w-4" />
                {updateInfo?.updateAvailable ? t('settings.about.downloadUpdate') : t('settings.about.openReleases')}
                <ExternalLink className="h-3.5 w-3.5" />
            </button>

            <section className={clsx(
                'mt-8 overflow-hidden rounded-2xl border',
                isDark ? 'border-white/10 bg-white/[0.035]' : 'border-indigo-100/80 bg-indigo-50/40',
            )}>
                {linkRows.map(({ icon: Icon, label, value, url }, index) => (
                    <button
                        key={label}
                        type="button"
                        onClick={() => openExternal(url)}
                        className={clsx(
                            'group flex w-full items-center gap-4 px-5 py-4 text-left transition-colors',
                            index > 0 && (isDark ? 'border-t border-white/10' : 'border-t border-indigo-100/80'),
                            isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-white/80',
                        )}
                    >
                        <span className={clsx(
                            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                            isDark ? 'bg-white/10 text-indigo-300' : 'bg-white text-indigo-600 shadow-sm',
                        )}>
                            <Icon className="h-4.5 w-4.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className={clsx('block text-sm font-medium', isDark ? 'text-neutral-200' : 'text-gray-800')}>
                                {label}
                            </span>
                            <span className={clsx('mt-0.5 block truncate text-sm', isDark ? 'text-indigo-300' : 'text-indigo-600')}>
                                {value}
                            </span>
                        </span>
                        <ExternalLink className={clsx(
                            'h-4 w-4 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5',
                            isDark ? 'text-neutral-500' : 'text-gray-400',
                        )} />
                    </button>
                ))}
            </section>

            <footer className="mt-10 text-center">
                <p className={clsx('text-sm font-medium', isDark ? 'text-neutral-300' : 'text-gray-600')}>
                    {t('settings.about.motto')}
                </p>
                <p className={clsx('mt-2 text-xs', isDark ? 'text-neutral-600' : 'text-gray-400')}>
                    {t('settings.about.copyright')}
                </p>
            </footer>
        </div>
    );
}
