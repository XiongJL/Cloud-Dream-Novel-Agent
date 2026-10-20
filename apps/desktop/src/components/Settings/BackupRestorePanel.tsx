import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowDownToLine, ArrowUpFromLine, ShieldCheck, Clock3, History, Pin, FolderOpen, CheckCircle2, AlertCircle, Copy, Replace, ChevronRight, FileText, Image, MessagesSquare, Layers, Loader2 } from 'lucide-react';
import { ConfirmModal } from '../ui/ConfirmModal';
import { toast } from 'sonner';
import { useEditorPreferences } from '../../hooks/useEditorPreferences';
import type { BackupAutoInfo, BackupInspection, BackupMode, BackupPolicy, BackupReport } from '../../../shared/backup';
import './backup.css';

function formatDate(value: string | number) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '暂无记录' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatSize(bytes: number) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function BackupRestorePanel() {
    const { preferences } = useEditorPreferences();
    const [password, setPassword] = useState('');
    const [repeat, setRepeat] = useState('');
    const [encrypted, setEncrypted] = useState(false);
    const [importPassword, setImportPassword] = useState('');
    const [files, setFiles] = useState<BackupAutoInfo[]>([]);
    const [policy, setPolicy] = useState<BackupPolicy | null>(null);
    const [report, setReport] = useState<BackupReport | null>(null);
    const [inspection, setInspection] = useState<BackupInspection | null>(null);
    const [mode, setMode] = useState<BackupMode>('copy');
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [policyUpdating, setPolicyUpdating] = useState(false);
    const [pinning, setPinning] = useState<string | null>(null);
    const errorRef = useRef<HTMLDivElement>(null);
    useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [error]);
    const load = async () => { const [backups, settings, lastReport] = await Promise.all([window.backup.getAutoBackups(), window.backup.getPolicy(), window.backup.getLastReport()]); setFiles(backups); setPolicy(settings); setReport(lastReport); };
    useEffect(() => { void load().catch(() => setError('无法加载备份状态。')); const timer = setInterval(() => { void load().catch(() => undefined); }, 60000); const unsubscribe = window.backup.onProgress(value => { if (value.phase === 'completed') void load().catch(() => undefined); }); return () => { clearInterval(timer); unsubscribe(); }; }, []);
    const create = async () => {
        if (encrypted && (!password || password !== repeat)) { setError('请输入并确认相同的备份密码。'); return; }
        setBusy(true); setError('');
        try { const result = await window.backup.export(encrypted ? password : undefined); if (result.success) { toast.success('完整备份已创建'); setPassword(''); setRepeat(''); } else if (result.code !== 'CANCELLED') setError(result.message || '备份失败'); }
        catch (e: any) { setError(e.message || '备份失败'); } finally { setBusy(false); }
    };
    const inspect = async (filename?: string) => {
        setBusy(true); setError(''); setInspection(null);
        try { const result = await window.backup.inspect(importPassword || undefined, filename); if (result.inspection) { setInspection(result.inspection); setMode('copy'); setImportPassword(''); } else if (result.code !== 'CANCELLED') setError(result.message || '备份校验失败'); }
        catch (e: any) { setError(e.message || '备份校验失败'); } finally { setBusy(false); }
    };
    const restore = async () => {
        if (!inspection) return;
        setConfirm(false); setBusy(true); setError('');
        try { const result = await window.backup.restore(inspection.inspectionId, mode); if (result.success) toast.success('恢复已完成，应用即将重新启动'); else { setError(result.message || '恢复失败，原资料未被替换'); if (result.code === 'PLAN_STALE') setInspection(null); setBusy(false); } }
        catch (e: any) { setError(e.message || '恢复失败'); setBusy(false); }
    };
    const updateProtection = async (enabled: boolean) => {
        setPolicyUpdating(true);
        try { setPolicy(await window.backup.updatePolicy(enabled)); }
        catch { setError('自动备份设置保存失败。'); }
        finally { setPolicyUpdating(false); }
    };
    const pin = async (file: BackupAutoInfo) => {
        setPinning(file.filename);
        try { await window.backup.pin(file.filename, !file.pinned); await load(); }
        catch { setError('固定备份失败。'); }
        finally { setPinning(null); }
    };
    return <div className="backup-ui backup-panel" data-theme={preferences.theme} aria-busy={busy}>
        <div className="backup-intro">
            <div className="backup-intro-title"><span className="backup-card-icon"><ShieldCheck size={22} /></span><div><h2>让每一份创作都可找回</h2><p>完整保存作品与历史，安心继续写作。</p></div></div>
            <div className="backup-coverage"><span><FileText size={13} />正文与设定</span><span><Image size={13} />图片</span><span><MessagesSquare size={13} />历史会话</span><span><Layers size={13} />草稿与审核</span></div>
        </div>
        {error && <div ref={errorRef} role="alert" className="backup-alert backup-alert-error"><AlertCircle size={17} /><span>{error}</span></div>}
        <div className="backup-action-grid">
            <section className="backup-card backup-action-card">
                <div className="backup-card-heading"><span className="backup-card-icon"><ArrowDownToLine size={19} /></span><div><h3>创建完整备份</h3><p>将全部作品资料保存为 .nebak 文件。</p></div></div>
                <form noValidate onSubmit={event => { event.preventDefault(); void create(); }}>
                    <label className="backup-encryption"><input type="checkbox" checked={encrypted} onChange={e => setEncrypted(e.target.checked)} disabled={busy} /><span><strong>密码保护</strong><small>正文与图片一并加密</small></span><ShieldCheck size={16} /></label>
                    {encrypted && <div className="backup-passwords"><label>备份密码<input type="password" autoComplete="new-password" className="backup-input" value={password} onChange={e => setPassword(e.target.value)} placeholder="输入备份密码" disabled={busy} /></label><label>确认密码<input type="password" autoComplete="new-password" className="backup-input" value={repeat} onChange={e => setRepeat(e.target.value)} placeholder="再次输入密码" disabled={busy} /></label></div>}
                    <button type="submit" className="backup-button backup-button-primary backup-action-button" disabled={busy}><ArrowDownToLine size={15} />创建 .nebak 备份</button>
                </form>
                <p className="backup-card-footnote">包含附件提取内容；原附件未保存时不包含。执行中的 Agent 任务需先完成或停止。</p>
            </section>
            <section className="backup-card backup-action-card">
                <div className="backup-card-heading"><span className="backup-card-icon"><ArrowUpFromLine size={19} /></span><div><h3>恢复作品资料</h3><p>先校验并预览，再选择恢复方式。</p></div></div>
                <form noValidate onSubmit={event => { event.preventDefault(); void inspect(); }}>
                    <label className="backup-field">备份密码 <span className="backup-muted">选填</span><input type="password" autoComplete="off" className="backup-input" value={importPassword} onChange={e => setImportPassword(e.target.value)} placeholder="未加密的备份可留空" disabled={busy} /></label>
                    <button type="submit" className="backup-button backup-button-secondary backup-action-button" disabled={busy}><FolderOpen size={15} />选择备份并预览</button>
                </form>
                <p className="backup-card-footnote">默认恢复为副本，保留现有作品。历史 Agent 任务不会自动执行。</p>
            </section>
        </div>
        {inspection && <section className="backup-card backup-preview">
            <div className="backup-section-heading"><h3><Archive size={17} />备份预览</h3><span className={`backup-badge ${inspection.completeness === 'complete' ? 'backup-badge-success' : 'backup-badge-warning'}`}>{inspection.completeness === 'complete' ? '完整备份' : '旧版不完整备份'}</span></div>
            <dl className="backup-stat-grid"><div><dt>作品</dt><dd>{inspection.novels.length}<small>部</small></dd></div><div><dt>资料记录</dt><dd>{inspection.records.toLocaleString()}<small>条</small></dd></div><div><dt>图片资源</dt><dd>{inspection.resources.toLocaleString()}<small>项</small></dd></div></dl>
            <ul className="backup-novel-list">{inspection.novels.map(novel => <li key={novel.id}><span><FileText size={14} />{novel.title}</span><small>{novel.chapters.toLocaleString()} 章</small></li>)}</ul>
            {inspection.warnings.length > 0 && <details className="backup-notices" open={inspection.completeness === 'legacy_incomplete'}><summary>恢复前须知 · {inspection.warnings.length} 项</summary><ul>{inspection.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
            <fieldset className="backup-mode-group"><legend>恢复方式</legend>
                <label className={`backup-mode ${mode === 'copy' ? 'is-selected' : ''}`}><input type="radio" name="backup-restore-mode" checked={mode === 'copy'} onChange={() => setMode('copy')} disabled={busy} /><Copy size={18} /><span><strong>恢复为副本 <small>推荐</small></strong><span>导入备份中的作品与历史，保留现有资料。</span></span></label>
                {inspection.allowedModes.includes('replace_all') && <label className={`backup-mode backup-mode-danger ${mode === 'replace_all' ? 'is-selected' : ''}`}><input type="radio" name="backup-restore-mode" checked={mode === 'replace_all'} onChange={() => setMode('replace_all')} disabled={busy} /><Replace size={18} /><span><strong>替换全部作品资料</strong><span>先建立安全快照，再替换当前所有作品。</span></span></label>}
            </fieldset>
            <div className="backup-preview-footer"><span className="backup-muted">完成恢复后，应用将重新启动。</span><button className={`backup-button ${mode === 'replace_all' ? 'backup-button-danger' : 'backup-button-primary'}`} onClick={() => setConfirm(true)} disabled={busy}>开始恢复<ChevronRight size={15} /></button></div>
        </section>}
        <section className="backup-card">
            <div className="backup-protection-row"><span className="backup-card-icon"><Clock3 size={19} /></span><div className="backup-protection-copy"><h3>自动保护 <span className={`backup-badge ${policy?.enabled ? 'backup-badge-success' : ''}`}>{policy ? policy.enabled ? '已开启' : '已关闭' : '加载中'}</span></h3><p>有变化时每 15 分钟检查，空闲后自动备份。</p></div>{policy && <label className="backup-switch"><input type="checkbox" role="switch" aria-label="启用本机周期备份" checked={policy.enabled} disabled={busy || policyUpdating} onChange={e => { void updateProtection(e.target.checked); }} /><span /></label>}</div>
            <div className="backup-protection-meta"><span><CheckCircle2 size={13} />最近成功：{policy?.lastSuccess ? formatDate(policy.lastSuccess) : '尚无'}</span><span>本机自动备份不加密</span></div>
            {policy?.lastError && <p role="alert" className="backup-inline-warning backup-error-text">上次自动备份失败：{policy.lastError}</p>}
            {policy?.warning && <p role="status" className="backup-inline-warning">{policy.warning}</p>}
        </section>
        <section className="backup-card backup-history">
            <div className="backup-section-heading"><h3><History size={17} />本机自动备份 <small>{files.length} 份</small></h3><button className="backup-button backup-button-quiet" disabled={busy} onClick={() => { void window.backup.openDirectory().catch(() => setError('无法打开备份目录。')); }}><FolderOpen size={14} />打开目录</button></div>
            {files.length === 0 ? <div className="backup-empty"><Archive size={26} /><strong>还没有自动备份</strong><p>开启自动保护后，有变化且空闲时将自动生成。</p></div> : <ul className="backup-file-list">{files.map(file => <li key={file.filename}>
                <span className="backup-file-icon"><Archive size={17} /></span><div className="backup-file-copy"><strong>{formatDate(file.createdAt)}<span className={`backup-badge ${file.valid ? 'backup-badge-success' : 'backup-badge-warning'}`}>{file.valid ? '已校验' : '需预检'}</span></strong><span>{formatSize(file.size)}{file.pinned ? ' · 固定保留' : ''}</span></div>
                <button className={`backup-icon-button ${file.pinned ? 'is-pinned' : ''}`} aria-label={file.pinned ? '取消固定保留' : '固定保留'} aria-pressed={file.pinned} title={file.pinned ? '取消固定保留' : '固定保留'} disabled={busy || pinning === file.filename} onClick={() => { void pin(file); }}>{pinning === file.filename ? <Loader2 size={15} className="backup-spin" /> : <Pin size={15} />}</button><button className="backup-button backup-button-secondary" disabled={busy} onClick={() => { void inspect(file.filename); }}>预览恢复</button>
            </li>)}</ul>}
            <p className="backup-card-footnote">固定的备份不参与轮替。恢复前的安全快照独立保留，可在目录中查看。</p>
        </section>
        {report && <section className="backup-card">
            <div className="backup-section-heading"><h3><CheckCircle2 size={17} />最近恢复</h3><span className="backup-muted">{formatDate(report.createdAt)}</span></div>
            <p className="backup-report-summary">{report.mode === 'copy' ? '恢复为副本' : '全量替换'} · {report.records.toLocaleString()} 条记录 · {report.resources.toLocaleString()} 项图片</p>
            <p className="backup-muted">{report.indexesRebuiltAt ? '全文检索与 RAG 本地索引已就绪。' : '索引将在本机重建，作品正文可正常读取。'}</p>
            {report.warnings.length > 0 && <details className="backup-notices"><summary>查看恢复说明</summary><ul>{report.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
        </section>}
        <p className="backup-bottom-note"><ShieldCheck size={14} />AI 密钥保留在当前设备，RAG 与全文索引在恢复后本地重建。</p>
        <ConfirmModal theme={preferences.theme} isOpen={confirm} onClose={() => setConfirm(false)} onConfirm={restore} title={mode === 'copy' ? '恢复为作品副本？' : '替换全部作品资料？'} message={mode === 'copy' ? '将导入备份中的作品、资料与历史，完成后重新启动应用。现有作品保留。' : '将用备份替换当前所有作品、设定、会话与草稿。软件会先创建完整安全快照；任何预检失败均不替换当前资料。完成后重新启动应用。'} confirmText="确认恢复" />
    </div>;
}
