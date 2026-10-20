import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2, X } from 'lucide-react';
import AssistantMarkdown from '../AssistantMarkdown';

export type SkillVisibilityTarget = {
  targetType: 'skill' | 'pack'; targetId: string; title: string; builtin?: boolean;
  initialView?: 'detail' | 'visibility'; supportedOperations?: string[]; allowedRoles?: string[];
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '设置暂时无法读取，请重试。';
}

export function SkillVisibilityDialog({target, novelId, isDark, onClose, onChanged, onDelete}: {
  target: SkillVisibilityTarget; novelId?: string; isDark: boolean; onClose: () => void; onChanged: (result?: Record<string, any>) => Promise<void>;
  onDelete?: (target: SkillVisibilityTarget) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const [current, setCurrent] = useState(target);
  const [view, setView] = useState(target.initialView || 'visibility');
  const [scope, setScope] = useState<'novel' | 'user'>('novel');
  const [owner, setOwner] = useState(novelId || '');
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const [details, setDetails] = useState<Array<{title: string; body: string}>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [isolate, setIsolate] = useState(false);
  const [copyOnConflict, setCopyOnConflict] = useState(false);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const button = clsx('rounded-md border px-3 py-2 text-sm disabled:opacity-50', isDark ? 'border-white/15 hover:bg-white/5' : 'border-[var(--ui-border)] hover:bg-[var(--ui-surface-muted)]');

  useEffect(() => {dialog.current?.showModal();}, []);
  useEffect(() => {
    const sequence = ++request.current;
    setReady(false); setLoading(true); setError(''); setDetails([]); setIsolate(false); setCopyOnConflict(false); setPreview(null);
    void (async () => {
      try {
        if (current.builtin) {
          const result = await window.agent.previewSkill({operationId: current.supportedOperations?.[0], roleId: current.allowedRoles?.[0] || 'writer',
            explicitSkills: [{skillId: current.targetId, selectionSource: 'explicit'}], novelId});
          if (request.current === sequence) setDetails(result.compiled.sections.map(s => ({title: current.title, body: s.prompt})));
        } else {
          const result = await window.agent.skillVisibility({targetType: current.targetType, targetId: current.targetId});
          if (request.current !== sequence) return;
          setPreview(result); setScope(result.scope); setOwner(result.ownerNovelId || novelId || '');
          const pack = current.targetType === 'pack' ? await window.agent.skillPack({packId: current.targetId, novelId: result.ownerNovelId || novelId}) : null;
          const refs: any[] = Array.isArray(pack?.members) ? pack.members : [{skillId: current.targetId}];
          const full = await Promise.all(refs.map((r: any) => window.automation.invoke('agent_skill.get', {skillId: r.skillId, revisionId: r.revisionId}, 'desktop-ui')));
          if (request.current === sequence) {setDetails(full.map((s: any) => ({title: s.title, body: s.revision?.instructions || '此版本没有可展示的方法正文。'}))); setReady(true);}
        }
      } catch (err) {if (request.current === sequence) setError(errorText(err));}
      finally {if (request.current === sequence) setLoading(false);}
    })();
    return () => {request.current++;};
  }, [current.targetId, current.targetType, reload, novelId]);

  useEffect(() => {
    if (!ready || current.builtin) return;
    setCopyOnConflict(false);
    const sequence = ++request.current;
    setLoading(true); setError('');
    void window.agent.skillVisibility({targetType: current.targetType, targetId: current.targetId, scope, ...(scope === 'novel' && owner ? {ownerNovelId: owner} : {})})
      .then(result => {if (sequence === request.current) setPreview(result);})
      .catch(err => {if (sequence === request.current) {setPreview(null); setError(errorText(err));}})
      .finally(() => {if (sequence === request.current) setLoading(false);});
  }, [ready, scope, owner, current.targetId, current.targetType]);

  const save = async () => {
    if (!preview || busy || loading) return;
    setBusy(true); setError('');
    try {
      const result = await window.agent.setSkillVisibility({targetType: current.targetType, targetId: current.targetId, scope,
        ...(scope === 'novel' ? {ownerNovelId: owner} : {}), expectedVisibilityVersion: preview.visibilityVersion,
        previewToken: preview.previewToken, isolateSharedMembers: isolate, copyOnConflict});
      window.dispatchEvent(new CustomEvent('agent-skill-visibility-updated', {detail: result}));
      await onChanged(result); onClose();
    } catch (err) {setError(errorText(err));}
    finally {setBusy(false);}
  };
  const narrowing = scope === 'novel' && preview && !preview.unchanged && !copyOnConflict;
  return <dialog ref={dialog} onCancel={e => {e.preventDefault(); if (!busy) onClose();}}
    aria-labelledby="skill-visibility-title" className={clsx('w-[min(560px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/40', isDark ? 'border-white/15 bg-[#202124] text-neutral-100' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)]')}>
    <header className="flex items-start justify-between gap-3"><div><h2 id="skill-visibility-title" className="font-medium">{current.title}</h2><p className="mt-1 text-xs opacity-70">{current.targetType === 'pack' ? '文风包及成员' : 'Skill'} · {current.builtin ? '内置，范围只读' : '可见范围'}</p></div><button type="button" aria-label="关闭 Skill 设置" disabled={busy} onClick={onClose} className={button}><X className="h-4 w-4" /></button></header>
    <div className="my-4 flex gap-2" role="tablist" aria-label="Skill 详情与范围"><button type="button" role="tab" aria-selected={view === 'visibility'} className={button} onClick={() => setView('visibility')}>可见范围</button><button type="button" role="tab" aria-selected={view === 'detail'} className={button} onClick={() => setView('detail')}>查看详情</button></div>
    {!current.builtin && onDelete && <button type="button" disabled={busy} className="mb-3 text-sm text-red-500 hover:underline disabled:opacity-50" onClick={() => onDelete(current)}>删除{current.targetType === 'pack' ? '文风包' : ' Skill'}</button>}
    {loading && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />正在读取…</p>}
    {error && <div role="alert" className="my-3 text-sm text-red-500">{error}<button type="button" disabled={busy} className="ml-2 underline" onClick={() => setReload(n => n + 1)}>重新加载</button></div>}
    {view === 'detail' ? <div className="space-y-4">{details.map((d, i) => <section key={i}><h3 className="mb-2 text-sm font-medium">{d.title}</h3><AssistantMarkdown content={d.body} isDark={isDark} variant="chat" ariaLabel={d.title} /></section>)}</div>
      : current.builtin ? <p className="text-sm">内置 Skill 对所有小说可见，范围由应用管理。</p>
      : preview?.managedBy?.length ? <div className="space-y-2 text-sm"><p>此成员由文风包管理，请统一设置包及成员范围。</p>{preview.managedBy.map((p: any) => <button type="button" key={p.id} className={button} onClick={() => {setReady(false); setCurrent({targetType: 'pack', targetId: p.id, title: p.title});}}>{p.title}</button>)}</div>
      : <><fieldset disabled={busy || loading} className="space-y-3"><legend className="mb-2 text-sm">哪些小说可以选择它？</legend>
        <label className="flex items-center gap-2"><input type="radio" name="skill-visibility-scope" checked={scope === 'novel'} onChange={() => setScope('novel')} />指定小说</label>
        {scope === 'novel' && <label className="block pl-6 text-xs">归属小说<select aria-label="归属小说" className={clsx('mt-1 w-full rounded-md border p-2 text-sm', isDark ? 'border-white/15 bg-[#202124]' : 'border-[var(--ui-border)] bg-white')} value={owner} onChange={e => setOwner(e.target.value)}><option value="">请选择小说</option>{preview?.novels?.map((n: any) => <option key={n.id} value={n.id}>{n.title}{n.id === novelId ? '（当前小说）' : ''}</option>)}</select></label>}
        <label className="flex items-center gap-2"><input type="radio" name="skill-visibility-scope" checked={scope === 'user'} onChange={() => setScope('user')} />所有小说</label>
      </fieldset>
      <p className="mt-3 text-xs opacity-70">所有小说可见时可在其他小说选择使用，不会自动设置默认。{current.targetType === 'pack' && ` 此包的 ${preview?.members?.length || 0} 个成员会一起修改。`}</p>
      {preview && preview.sharedMembers?.length > 0 && !preview.conflicts?.length && !preview.unchanged && <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={isolate} onChange={e => setIsolate(e.target.checked)} /><span>为本包的共享成员创建独立副本，保留其他包原设置。</span></label>}
      {preview && preview.conflicts?.length > 0 && <div className="mt-3 space-y-2 rounded-md border border-amber-400/40 p-3 text-sm"><p>目标范围已有同标识对象：{preview.conflicts.map((c: any) => c.title).join('、')}。</p><label className="flex items-start gap-2"><input type="checkbox" checked={copyOnConflict} onChange={e => setCopyOnConflict(e.target.checked)} />另存为独立副本，保留原对象与引用，不自动设置默认。</label></div>}
      {narrowing && <div role="status" className="mt-3 rounded-md border border-amber-400/40 p-3 text-sm">已启动任务保留原版本；新任务按修改后的范围选择。<p className="mt-1">将取消 {preview.affectedDefaults.length} 本小说的默认引用，调整 {preview.affectedBindingCount} 项绑定。</p>{preview.affectedDefaults.map((n: any) => <p key={n.novelId}>{n.title}</p>)}</div>}
      <footer className="mt-5 flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>取消</button><button type="button" className="rounded-md bg-[#2f80ed] px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy || loading || !preview || scope === 'novel' && !owner || !!preview.conflicts?.length && !copyOnConflict || preview.sharedMembers.length > 0 && !preview.unchanged && !isolate && !copyOnConflict} onClick={() => void save()}>{busy ? '正在保存…' : copyOnConflict ? '另存副本' : narrowing ? '确认修改' : '保存'}</button></footer>
    </>}
  </dialog>;
}
