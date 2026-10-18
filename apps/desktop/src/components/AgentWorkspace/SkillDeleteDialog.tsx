import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2, Trash2, X } from 'lucide-react';
import type { SkillVisibilityTarget } from './SkillVisibilityDialog';

type Preview = {
  targetType: 'skill' | 'pack'; targetId: string; title: string; scope: 'user' | 'novel'; visibilityVersion: number;
  previewToken: string; canDelete: boolean; managedBy: Array<{id: string; title: string}>;
  activeUseCount: number; affectedDefaults: Array<{novelId: string; title: string}>;
  affectedBindingCount: number; retainedMemberCount: number;
};

export function SkillDeleteDialog({target, isDark, onClose, onDeleted}: {
  target: SkillVisibilityTarget; isDark: boolean; onClose: () => void;
  onDeleted: (result: Preview & {deleted: boolean}) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sequence = useRef(0);
  const [current, setCurrent] = useState(target);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const button = clsx('rounded-md border px-3 py-2 text-sm disabled:opacity-50', isDark ? 'border-white/15 hover:bg-white/5' : 'border-[var(--ui-border)] hover:bg-[var(--ui-surface-muted)]');
  useEffect(() => {dialog.current?.showModal();}, []);
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true); setError(''); setPreview(null);
    if (current.builtin) {setLoading(false); setError('内置 Skill 不能删除。'); return;}
    void window.automation.invoke('agent_skill.delete.preview', {targetType: current.targetType, targetId: current.targetId}, 'desktop-ui')
      .then(result => {if (sequence.current === request) setPreview(result as Preview);})
      .catch(err => {if (sequence.current === request) setError(err instanceof Error ? err.message : '读取删除影响失败，请重试。');})
      .finally(() => {if (sequence.current === request) setLoading(false);});
    return () => {sequence.current++;};
  }, [current.targetId, current.targetType, reload]);

  const remove = async () => {
    if (!preview?.canDelete || loading || busy) return;
    setBusy(true); setError('');
    let result: Preview & {deleted: boolean};
    try {
      result = await window.automation.invoke('agent_skill.delete', {
        targetType: current.targetType, targetId: current.targetId,
        expectedVisibilityVersion: preview.visibilityVersion, previewToken: preview.previewToken, confirmed: true,
      }, 'desktop-ui') as Preview & {deleted: boolean};
    } catch (err) {
      setPreview(null); setError(err instanceof Error ? err.message : '删除失败，请重新加载后重试。'); setBusy(false); return;
    }
    // The deletion has committed. A refresh failure must not offer a second delete.
    try {await onDeleted(result);} catch (err) {console.warn('Skill deleted; refreshing the list failed:', err);} finally {setBusy(false); onClose();}
  };

  return <dialog ref={dialog} aria-labelledby="skill-delete-title" onCancel={e => {e.preventDefault(); if (!busy) onClose();}}
    className={clsx('w-[min(520px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/40', isDark ? 'border-white/15 bg-[#202124] text-neutral-100' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)]')}>
    <header className="flex items-start justify-between gap-3"><h2 id="skill-delete-title" className="flex items-center gap-2 font-medium"><Trash2 className="h-4 w-4 text-red-500" />删除{current.targetType === 'pack' ? '文风包' : ' Skill'}</h2><button type="button" aria-label="关闭删除确认" className={button} disabled={busy} onClick={onClose}><X className="h-4 w-4" /></button></header>
    <p className="mt-3 break-words text-sm font-medium">{current.title}</p>
    <p className="mt-2 text-sm opacity-80">删除后将从可选列表移除。历史版本、聊天记录和已生成的草稿会保留。</p>
    {current.targetType === 'pack' && <p className="mt-2 text-sm opacity-80">只删除文风包，独立成员不会一起删除。</p>}
    {loading && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />正在检查引用…</p>}
    {error && <p role="alert" className="mt-4 text-sm text-red-500">{error}<button type="button" className="ml-2 underline" disabled={busy} onClick={() => setReload(n => n + 1)}>重新加载</button></p>}
    {preview && <div className="mt-4 space-y-3 text-sm">
      {preview.scope === 'user' && <p>它对所有小说可见，删除后所有小说都不能再选择它。</p>}
      {preview.activeUseCount > 0 && <p role="alert" className="text-amber-600">正在执行的任务使用它，请先结束任务再删除。</p>}
      {preview.managedBy.length > 0 && <div className="space-y-2"><p>此 Skill 仍被以下文风包引用，暂时不能单独删除。请先处理关联包；删除包后，可再删除这个成员。</p>{preview.managedBy.map(pack => <button type="button" key={pack.id} className={button} onClick={() => setCurrent({targetType: 'pack', targetId: pack.id, title: pack.title})}>处理「{pack.title}」</button>)}</div>}
      {preview.affectedDefaults.length > 0 && <div className="rounded-md border border-amber-400/40 p-3"><p>将取消 {preview.affectedDefaults.length} 本小说的默认文风设置：</p>{preview.affectedDefaults.map(novel => <p key={novel.novelId} className="mt-1 break-words">{novel.title}</p>)}</div>}
      {preview.affectedBindingCount > 0 && <p>将停用 {preview.affectedBindingCount} 项 Skill 绑定。</p>}
    </div>}
    <footer className="mt-5 flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>取消</button><button type="button" className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50" disabled={busy || loading || !preview?.canDelete} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button></footer>
  </dialog>;
}
