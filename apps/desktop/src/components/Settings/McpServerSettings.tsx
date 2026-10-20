import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import type { McpServerStatus } from '../../../shared/mcpServer';

export function McpServerSettings({ isDark, stdio }: { isDark: boolean; stdio: McpCliSetupPayload | null }) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<McpServerStatus | null>(null);
    const [port, setPort] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [loadError, setLoadError] = useState('');
    const mutating = useRef(false);
    const mounted = useRef(true);
    const key = 'settings.ai.mcpServer.';
    useEffect(() => {
        mounted.current = true;
        const refresh = async () => {
            try {
                const next = await window.ai.getMcpServerStatus();
                if (mounted.current && !mutating.current) { setStatus(next); setLoadError(''); }
            } catch (reason) { if (mounted.current) setLoadError(String(reason)); }
        };
        void refresh();
        const timer = setInterval(refresh, 1500);
        return () => { mounted.current = false; clearInterval(timer); };
    }, []);
    useEffect(() => { if (status) setPort(String(status.port)); }, [status?.port]);

    const configure = async (enabled: boolean, nextPort?: number) => {
        mutating.current = true;
        setBusy(true); setError(''); setMessage('');
        try {
            const next = await window.ai.configureMcpServer(enabled, nextPort);
            if (mounted.current) { setStatus(next); setMessage(t(key + 'saved')); }
        } catch (reason) { if (mounted.current) setError(String(reason)); }
        finally { mutating.current = false; if (mounted.current) setBusy(false); }
    };
    const copy = async (value: string) => {
        try { await navigator.clipboard.writeText(value); setMessage(t(key + 'copied')); setError(''); }
        catch { setError(t('settings.ai.mcpCopy.copyFailed')); }
    };
    const ready = status?.state === 'running' && Boolean(status.token);
    const config = ready ? { url: status.url, headers: { Authorization: `Bearer ${status.token}` } } : null;
    const instruction = config ? t(key + 'instruction', { url: config.url, token: status?.token }) : '';
    const testConnection = async () => {
        setBusy(true); setError(''); setMessage('');
        try {
            const result = await window.ai.testMcp();
            if (result.ok) setMessage(result.detail || t(key + 'running'));
            else setError(result.detail || t(key + 'error'));
        } catch (reason) { setError(String(reason)); }
        finally { if (mounted.current) setBusy(false); }
    };
    const inputClass = clsx('w-full rounded-xl border px-3 py-2 text-sm', isDark ? 'border-white/10 bg-[#0a0a0f] text-white' : 'border-gray-200 bg-white text-gray-900');
    const buttonClass = 'rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40';
    return (
        <section aria-label={t(key + 'title')} className={clsx('space-y-4 rounded-2xl border p-4', isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-gray-50')}>
            <div className="flex items-center justify-between gap-4">
                <div>
                    <h3 className="text-sm font-medium">{t(key + 'title')}</h3>
                    <p className="mt-1 text-xs leading-5 opacity-70">{t(key + 'description')}</p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-sm">
                    <input type="checkbox" role="switch" aria-label={t(key + 'enable')} checked={status?.enabled ?? false}
                        disabled={!status || busy} onChange={event => void configure(event.target.checked)} className="h-5 w-5 accent-indigo-600" />
                    {t(key + 'enable')}
                </label>
            </div>
            <p role="status" className="text-xs">{t(key + (busy ? 'applying' : status?.state ?? 'loading'))}</p>
            <label className="block space-y-2 text-xs">
                <span>{t(key + 'address')}</span>
                <input aria-label={t(key + 'address')} value={status?.url ?? ''} readOnly className={inputClass} />
            </label>
            {ready ? (
                <>
                    <label className="block space-y-2 text-xs">
                        <span>{t('settings.ai.mcpCopy.instructionLabel')}</span>
                        <textarea aria-label={t('settings.ai.mcpCopy.instructionLabel')} readOnly value={instruction} rows={4} className={inputClass} />
                    </label>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={busy} onClick={() => void copy(instruction)} className={buttonClass}>{t('settings.ai.mcpCopy.copyInstruction')}</button>
                        <button type="button" disabled={busy} onClick={() => void copy(JSON.stringify({ mcpServers: { novel_editor: config } }, null, 2))} className={buttonClass}>{t(key + 'copyConfig')}</button>
                        <button type="button" disabled={busy} onClick={() => void testConnection()} className={buttonClass}>{t('settings.ai.testMcp')}</button>
                    </div>
                </>
            ) : null}
            <p className="text-xs leading-5 opacity-70">{t(key + 'hint')}</p>
            {status?.state === 'error' ? <button type="button" disabled={busy} className={buttonClass} onClick={() => void configure(true)}>{t(key + 'retry')}</button> : null}
            <details className="rounded-xl border border-current/10 px-3 py-2">
                <summary className="cursor-pointer text-xs">{t(key + 'advanced')}</summary>
                <div className="mt-3 space-y-3">
                    <label className="block space-y-2 text-xs">
                        <span>{t(key + 'port')}</span>
                        <input aria-label={t(key + 'port')} type="number" min={1024} max={65535} value={port} onChange={event => setPort(event.target.value)} className={inputClass} />
                    </label>
                    <button type="button" disabled={!status || busy || !/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535}
                        onClick={() => void configure(status!.enabled, Number(port))} className={buttonClass}>{t(key + 'applyPort')}</button>
                    <p className="text-xs opacity-70">{t(key + 'stdioHint')}</p>
                    <textarea aria-label="stdio" readOnly value={stdio?.jsonConfig ?? ''} rows={6} className={inputClass} />
                    <button type="button" disabled={!stdio?.launcherExists || !status?.enabled || busy}
                        onClick={() => void copy(stdio!.jsonConfig)} className={buttonClass}>{t(key + 'copyStdio')}</button>
                </div>
            </details>
            {error || loadError || status?.error ? <p role="alert" className="whitespace-pre-wrap break-words text-xs text-rose-500">{error || loadError || status?.error}</p> : null}
            {message ? <p role="status" className="text-xs text-emerald-600">{message}</p> : null}
        </section>
    );
}
