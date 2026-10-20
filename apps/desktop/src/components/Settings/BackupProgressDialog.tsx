import { useEffect, useRef, useState } from 'react';
import { Archive, Check, CheckCircle2, Clock3, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useEditorPreferences } from '../../hooks/useEditorPreferences';
import type { BackupPhase, BackupProgress } from '../../../shared/backup';
import './backup.css';

type Step = { label: string; phases: BackupPhase[] };
const exportSteps: Step[] = [
    { label: '准备资料', phases: ['preparing'] },
    { label: '生成快照', phases: ['snapshotting'] },
    { label: '打包备份', phases: ['packaging'] },
    { label: '校验备份', phases: ['verifying', 'completed'] },
];
const restoreSteps: Step[] = [
    { label: '准备恢复', phases: ['preparing'] },
    { label: '安全快照', phases: ['snapshotting', 'packaging', 'verifying'] },
    { label: '导入资料', phases: ['staging'] },
    { label: '完成切换', phases: ['committing', 'completed'] },
];
const inspectSteps: Step[] = [
    { label: '准备读取', phases: ['preparing'] },
    { label: '完整性校验', phases: ['inspecting', 'completed'] },
];

export function BackupProgressDialog({ progress }: { progress: BackupProgress | null }) {
    const { preferences } = useEditorPreferences();
    const dialogRef = useRef<HTMLDivElement>(null);
    const started = useRef(Date.now());
    const [elapsed, setElapsed] = useState(0);
    const [cancelling, setCancelling] = useState(false);
    const [cancelUnavailable, setCancelUnavailable] = useState(false);
    const [cancelError, setCancelError] = useState('');
    const phase = progress?.phase ?? 'preparing';
    const finished = phase === 'completed';
    const committing = phase === 'committing' || cancelUnavailable;
    const steps = progress?.operation === 'restore' || phase === 'staging' || phase === 'committing'
        ? restoreSteps : progress?.operation === 'inspect' || phase === 'inspecting' ? inspectSteps : exportSteps;
    const current = Math.max(0, steps.findIndex(step => step.phases.includes(phase)));
    const measurable = Number.isFinite(progress?.total) && (progress?.total ?? 0) > 0 && Number.isFinite(progress?.completed);
    const percent = finished ? 100 : measurable ? Math.round(Math.min(1, Math.max(0, progress!.completed / progress!.total!)) * 100) : undefined;
    const title = finished ? steps === restoreSteps ? '恢复已完成' : steps === inspectSteps ? '校验已完成' : '备份已完成' : progress?.operation === 'restore' || steps === restoreSteps ? '正在恢复作品资料'
        : progress?.operation === 'inspect' || steps === inspectSteps ? '正在校验备份' : progress?.operation === 'export' ? '正在创建完整备份' : '正在保护作品资料';

    useEffect(() => {
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
        if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
        const trapFocus = (event: KeyboardEvent) => {
            if (event.key !== 'Tab') return;
            const controls = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
            event.preventDefault();
            if (controls.length) controls[event.shiftKey ? controls.length - 1 : 0].focus();
            else dialogRef.current?.focus();
        };
        document.addEventListener('keydown', trapFocus, true);
        return () => {
            clearInterval(timer);
            document.removeEventListener('keydown', trapFocus, true);
            requestAnimationFrame(() => { if (!dialogRef.current?.isConnected && previous?.isConnected) previous.focus(); });
        };
    }, []);

    useEffect(() => { if (committing || cancelling || finished) dialogRef.current?.focus(); }, [committing, cancelling, finished]);
    const cancel = async () => {
        setCancelling(true); setCancelError('');
        try {
            if (!await window.backup.cancel()) { setCancelUnavailable(true); setCancelling(false); }
        } catch { setCancelError('取消请求未送达，请重试。'); setCancelling(false); }
    };
    const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${String(elapsed % 60).padStart(2, '0')} 秒` : `${elapsed} 秒`;

    return <div data-backup-overlay data-theme={preferences.theme} className="backup-ui backup-overlay">
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="backup-job-title" aria-describedby="backup-job-detail" tabIndex={-1} className="backup-job-dialog">
            <div className="backup-job-heading">
                <span className="backup-job-icon">{finished ? <CheckCircle2 size={25} /> : <Archive size={25} />}</span>
                <div><span className="backup-eyebrow">作品资料保护</span><h2 id="backup-job-title">{title}</h2></div>
            </div>
            <ol className="backup-steps" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="操作阶段">
                {steps.map((step, index) => <li key={step.label} data-state={finished || index < current ? 'done' : index === current ? 'active' : 'waiting'} aria-current={!finished && index === current ? 'step' : undefined}>
                    <span className="backup-step-dot">{finished || index < current ? <Check size={13} /> : index + 1}</span><span>{step.label}</span>
                </li>)}
            </ol>
            <div className="backup-job-status">
                <div className="backup-progress-heading" role="status" aria-live="polite"><span>{cancelling ? '正在取消，请等待当前步骤结束…' : progress?.message || '正在保存编辑内容，请稍候…'}</span><span className="backup-progress-value" title="当前阶段进度">{percent === undefined ? '处理中' : `${percent}%`}</span></div>
                <div className="backup-progress-track" role="progressbar" aria-label="当前阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent === undefined ? '正在处理，当前阶段没有可计算的总量' : `${percent}%`}>
                    <div className={`backup-progress-fill ${percent === undefined ? 'is-indeterminate' : ''}`} style={percent === undefined ? undefined : { width: `${percent}%` }} />
                </div>
                <div className="backup-progress-meta"><span>{finished ? '所有阶段已完成' : `阶段 ${current + 1} / ${steps.length}`}{measurable && !finished ? ` · 已处理 ${progress!.completed} / ${progress!.total} 项资料` : ''}</span><span><Clock3 size={12} />已用 {elapsedLabel}</span></div>
            </div>
            <div className="backup-job-note" id="backup-job-detail">{committing ? <LockKeyhole size={16} /> : <ShieldCheck size={16} />}<span>{finished ? '资料已校验，操作已完成。' : committing ? '正在完成数据切换，请保持应用打开，完成后将重新启动。' : steps === restoreSteps ? '已保留现有资料，校验通过后才会切换到恢复的数据。' : steps === inspectSteps ? '正在检查备份中的资料与图片，校验完成后可预览恢复。' : '正在为作品建立完整备份，请保持应用打开。'}</span></div>
            {cancelError && <p role="alert" className="backup-error-text">{cancelError}</p>}
            <div className="backup-job-footer"><span className="backup-muted">{finished ? '操作已完成' : committing ? '最后一步 · 暂不能取消' : cancelling ? '取消后将保留现有资料' : '可随时取消当前操作'}</span>{!committing && !finished && <button className="backup-button backup-button-secondary" onClick={cancel} disabled={cancelling}>{cancelling && <Loader2 size={14} className="backup-spin" />}{cancelling ? '正在取消…' : '取消操作'}</button>}</div>
        </div>
    </div>;
}
