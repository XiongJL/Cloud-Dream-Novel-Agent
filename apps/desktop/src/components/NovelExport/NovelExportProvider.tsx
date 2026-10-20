import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, FolderOpen, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEditorPreferences } from '../../hooks/useEditorPreferences';
import { flushChapterSaves } from '../../../shared/chapterSaveQueue';
import type { NovelExportFormat, NovelExportProgress, NovelExportResult, NovelExportSelection } from '../../../shared/novelExport';
import './novelExport.css';

type Target = { id: string; title: string };
const ExportContext = createContext<{ open(target: Target): void; busy: boolean }>({ open: () => {}, busy: false });
export const useNovelExport = () => useContext(ExportContext);

export function NovelExportProvider({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const { preferences } = useEditorPreferences();
    const [target, setTarget] = useState<Target | null>(null);
    const [format, setFormat] = useState<NovelExportFormat>('txt');
    const [scopeMode, setScopeMode] = useState<NovelExportSelection['mode']>('all');
    const [rangeStart, setRangeStart] = useState('1');
    const [rangeEnd, setRangeEnd] = useState('500');
    const [batchSize, setBatchSize] = useState('500');
    const [chapterCount, setChapterCount] = useState<number | null>(null);
    const [scopeError, setScopeError] = useState('');
    const [busy, setBusy] = useState(false);
    const [frozen, setFrozen] = useState(false);
    const [progress, setProgress] = useState<NovelExportProgress | null>(null);
    const [result, setResult] = useState<NovelExportResult | null>(null);
    const requestRef = useRef<string | null>(null);
    const busyRef = useRef(false);
    const frozenRef = useRef(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    const selecting = !!target && !busy && !result;
    const positive = (value: string) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
    const validScope = scopeMode === 'all' || (chapterCount !== null && chapterCount > 0 && (scopeMode === 'range'
        ? positive(rangeStart) && positive(rangeEnd) && Number(rangeStart) <= Number(rangeEnd) && Number(rangeEnd) <= chapterCount
        : positive(batchSize)));

    useEffect(() => {
        if (!target) return;
        let active = true;
        setChapterCount(null); setScopeError('');
        void window.novelExport.describe(target.id).then(info => {
            if (!active) return;
            setChapterCount(info.chapterCount);
            setRangeEnd(String(Math.max(1, Math.min(500, info.chapterCount))));
        }).catch(() => { if (active) setScopeError(t('novelExport.scopeLoadFailed')); });
        return () => { active = false; };
    }, [target, t]);

    useEffect(() => window.novelExport.onFlush('*', flushChapterSaves), []);
    useEffect(() => window.novelExport.onProgress(event => { if (event.requestId === requestRef.current) setProgress(event); }), []);
    useEffect(() => window.novelExport.onFreeze(value => { frozenRef.current = value; setFrozen(value); }), []);
    useEffect(() => {
        const block = (event: KeyboardEvent) => {
            if (!frozenRef.current || event.isComposing || event.keyCode === 229) return;
            event.preventDefault(); event.stopImmediatePropagation();
        };
        window.addEventListener('keydown', block, true);
        return () => window.removeEventListener('keydown', block, true);
    }, []);
    useEffect(() => {
        if (!selecting) return;
        const previous = document.activeElement;
        returnFocus.current = previous instanceof HTMLElement ? previous : null;
        dialogRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
        return () => { returnFocus.current?.focus(); };
    }, [selecting]);

    const close = () => { if (!busyRef.current) { setTarget(null); setResult(null); } };
    const start = async () => {
        if (!target || busyRef.current || !validScope) return;
        busyRef.current = true; setBusy(true); setProgress(null); setResult(null);
        const requestId = crypto.randomUUID(); requestRef.current = requestId;
        try {
            const selection: NovelExportSelection = scopeMode === 'range' ? { mode: 'range', start: Number(rangeStart), end: Number(rangeEnd) }
                : scopeMode === 'split' ? { mode: 'split', chaptersPerFile: Number(batchSize) } : { mode: 'all' };
            const response = await window.novelExport.start({ requestId, novelId: target.id, format, selection });
            if (response.status === 'cancelled') setTarget(null);
            else setResult(response);
        } catch {
            setResult({ status: 'failed', requestId, code: 'IPC_FAILED', message: t('novelExport.failed') });
        } finally { busyRef.current = false; setBusy(false); }
    };

    return <ExportContext.Provider value={{
        busy,
        open: value => { if (!busyRef.current) { setScopeMode('all'); setTarget({ id: value.id, title: value.title }); setResult(null); setProgress(null); } },
    }}>
        {children}
        {selecting && <div className="novel-export-overlay" data-theme={preferences.theme}>
            <div ref={dialogRef} className="novel-export-dialog" role="dialog" aria-modal="true" aria-labelledby="novel-export-title"
                onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === 'Escape') { event.preventDefault(); close(); }
                    if (event.key === 'Tab') {
                        const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button,input')];
                        const first = nodes[0], last = nodes[nodes.length - 1];
                        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
                    }
                }}>
                <div className="novel-export-heading"><h2 id="novel-export-title">{t('novelExport.title')}</h2><button onClick={close} aria-label={t('common.close')}><X size={18} /></button></div>
                <strong className="novel-export-book">{target.title}</strong>
                <p>{t('novelExport.scope')}</p>
                <fieldset><legend>{t('novelExport.format')}</legend>
                    {(['txt', 'docx'] as const).map(value => <label key={value} className={format === value ? 'selected' : ''}>
                        <input type="radio" name="novel-export-format" value={value} checked={format === value} onChange={() => setFormat(value)} />
                        <span><strong>{value.toUpperCase()}</strong><small>{t(`novelExport.${value}`)}</small></span>
                    </label>)}
                </fieldset>
                <fieldset className="novel-export-scope"><legend>{t('novelExport.rangeLabel')}{chapterCount !== null && ` · ${t('novelExport.chapterCount', { count: chapterCount })}`}</legend>
                    {(['all', 'range', 'split'] as const).map(mode => <label key={mode} className={scopeMode === mode ? 'selected' : ''}>
                        <input type="radio" name="novel-export-scope" checked={scopeMode === mode} onChange={() => setScopeMode(mode)} />
                        <span>{t(`novelExport.scope_${mode}`)}</span>
                    </label>)}
                </fieldset>
                {scopeMode === 'range' && <div className="novel-export-scope-fields">
                    <label>{t('novelExport.startChapter')}<input type="number" min="1" max={chapterCount ?? undefined} step="1" value={rangeStart} onChange={event => setRangeStart(event.target.value)} /></label>
                    <label>{t('novelExport.endChapter')}<input type="number" min={Number(rangeStart) || 1} max={chapterCount ?? undefined} step="1" value={rangeEnd} onChange={event => setRangeEnd(event.target.value)} /></label>
                </div>}
                {scopeMode === 'split' && <div className="novel-export-scope-fields">
                    <label>{t('novelExport.chaptersPerFile')}<input type="number" min="1" step="1" value={batchSize} onChange={event => setBatchSize(event.target.value)} /></label>
                    {validScope && chapterCount !== null && <span>{t('novelExport.fileCount', { count: Math.ceil(chapterCount / Number(batchSize)) })}</span>}
                </div>}
                {scopeMode !== 'all' && <p>{t('novelExport.rangeHint')}</p>}
                {scopeMode === 'split' && <p>{t('novelExport.splitHint')}</p>}
                {scopeError && <p role="alert">{scopeError}</p>}
                {!validScope && !scopeError && <p role="alert">{chapterCount === null ? t('novelExport.scopeLoading') : t('novelExport.invalidRange')}</p>}
                {format === 'docx' && <p>{t('novelExport.tocHint')}</p>}
                <div className="novel-export-actions"><button onClick={close}>{t('common.cancel')}</button><button className="primary" disabled={!validScope} onClick={() => void start()}><Download size={16} />{t(scopeMode === 'split' ? 'novelExport.chooseDirectory' : 'novelExport.choosePath')}</button></div>
            </div>
        </div>}
        {target && (busy || result) && <aside className="novel-export-status" data-theme={preferences.theme} aria-live="polite" aria-atomic="true">
            <div className="novel-export-heading"><strong>{t('novelExport.title')}</strong>{!busy && <button onClick={close} aria-label={t('common.close')}><X size={16} /></button>}</div>
            <span className="novel-export-book">{target.title}</span>
            {busy && <p role="status"><Loader2 size={16} className="animate-spin" />{t(`novelExport.${progress?.phase || 'choosing'}`)}{progress?.parts && progress.parts > 1 ? ` ${t('novelExport.partProgress', { part: progress.part, parts: progress.parts })}` : ''}{progress?.total !== undefined && ` (${progress.completed} / ${progress.total})`}</p>}
            {result?.status === 'success' && <>
                <p>{t('novelExport.success', { title: result.title })}{result.empty && ` · ${t('novelExport.empty')}`}</p>
                {result.directory && <p>{t('novelExport.filesExported', { count: result.files.length })}</p>}
                <p className="novel-export-path">{result.path}</p>
                <button onClick={() => void window.novelExport.openDirectory(result.requestId).catch(() => undefined)}><FolderOpen size={16} />{t('novelExport.openDirectory')}</button>
            </>}
            {result?.status === 'failed' && <><p role="alert">{result.message}</p><button onClick={() => setResult(null)}>{t('novelExport.retry')}</button></>}
        </aside>}
        {frozen && <div className="novel-export-freeze" data-theme={preferences.theme} role="status"><Loader2 className="animate-spin" size={20} />{t('novelExport.saving')}</div>}
    </ExportContext.Provider>;
}
