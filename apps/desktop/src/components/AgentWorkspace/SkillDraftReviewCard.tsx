import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import { createSkillDraftPreparationCoordinator, projectSkillDraftReview, type SkillDraftPrepareResult, type SkillDraftReviewRecord } from '../../../shared/agentSkillDraftReview';
import AssistantMarkdown from '../AssistantMarkdown';
import type { AgentSkillMenuPack } from '../../../shared/agentSkillComposer';

const preparation = createSkillDraftPreparationCoordinator();
type RuleEditing = { draftId: string; path: string; version: number; title: string; description: string; instructions: string; constraintsText: string };

function storedEditing(draftId: string): RuleEditing | null {
  try {
    if (typeof window === 'undefined') return null;
    const value = JSON.parse(window.localStorage.getItem(`agent-skill-rule-edit:${draftId}`) || 'null') as RuleEditing | null;
    return value?.draftId === draftId && typeof value.instructions === 'string' && typeof value.version === 'number' ? value : null;
  } catch { return null; }
}

function readableExample(example: unknown): string {
  if (typeof example === 'string') return example;
  if (!example || typeof example !== 'object') return '';
  const value = example as Record<string, unknown>;
  return [value.title, value.input ? `原文：${String(value.input)}` : '', value.output ? `示范：${String(value.output)}` : '', value.explanation].filter(Boolean).map(String).join('\n');
}

export function SkillDraftReviewCard({ draftId, embedded, novelId, isDark, onPublished }: {
  draftId: string; embedded?: SkillDraftReviewRecord; novelId?: string; isDark: boolean; onPublished: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<SkillDraftReviewRecord | null>(embedded ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prepareError, setPrepareError] = useState('');
  const [repairs, setRepairs] = useState<SkillDraftPrepareResult['repairs']>([]);
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<'commit' | 'discard' | 'save' | 'prepare' | 'revise' | null>(null);
  const [editing, setEditing] = useState<RuleEditing | null>(() => storedEditing(draftId));
  const [aiRequest, setAiRequest] = useState<{ path: string; version: number; goal: string } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [confirmation, setConfirmation] = useState<{ action: 'commit' | 'discard'; version: number } | null>(null);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [publicationError, setPublicationError] = useState('');
  const [publicationNovels, setPublicationNovels] = useState<Array<{id: string; title: string}>>([]);
  useEffect(() => {
    void window.db.getNovels().then(setPublicationNovels).catch(err => {
      setPublicationError(err instanceof Error ? err.message : '小说列表加载失败，请重新打开草稿后重试。');
    });
  }, []);
  useEffect(() => {
    const update = (event: Event) => {const data = (event as CustomEvent).detail; setDraft(current => current && (current.committedSkillId === data?.targetId || current.committedPackId === data?.targetId) ? {...current, currentVisibility: {scope: data.scope, ownerNovelId: data.ownerNovelId, visibilityVersion: data.visibilityVersion}} : current);};
    window.addEventListener('agent-skill-visibility-updated', update);
    return () => window.removeEventListener('agent-skill-visibility-updated', update);
  }, []);

  const changePublication = async (scope: 'user' | 'novel', ownerNovelId?: string) => {
    if (!draft || publicationBusy) return;
    setPublicationBusy(true); setPublicationError('');
    try {
      const result = await window.agent.setSkillDraftPublication({draftId: draft.id, scope, ownerNovelId,
        expectedPublicationVersion: draft.publicationVersion || 1});
      setDraft(current => current ? {...current, publicationScope: scope, publicationOwnerNovelId: ownerNovelId,
        publicationVersion: result.publicationVersion} : current);
    } catch (err) {setPublicationError(err instanceof Error ? err.message : '发布范围未保存，请重新加载。');}
    finally {setPublicationBusy(false);}
  };

  const managePublished = () => {
    const id = draft?.committedPackId || draft?.committedSkillId;
    if (id) window.dispatchEvent(new CustomEvent('agent-skill-manage', {detail: {
      targetType: draft?.committedPackId ? 'pack' : 'skill', targetId: id, title: view?.title || 'Skill', initialView: 'visibility',
    }}));
  };

  useEffect(() => {
    setDraft(embedded?.id === draftId ? embedded : null); setEditing(storedEditing(draftId)); setAiRequest(null);
    setError(''); setPrepareError(''); setRepairs([]); setConfirmation(null);
  }, [draftId, novelId]);

  useEffect(() => {
    try {
      if (editing?.draftId === draftId) window.localStorage.setItem(`agent-skill-rule-edit:${draftId}`, JSON.stringify(editing));
      else if (!editing) window.localStorage.removeItem(`agent-skill-rule-edit:${draftId}`);
    } catch { /* Editing remains in memory when local persistence is unavailable. */ }
  }, [draftId, editing]);

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ draftId: string }>).detail?.draftId !== draftId) return;
      setLoading(true); setReload((value) => value + 1);
    };
    window.addEventListener('agent-skill-draft-changed', refresh);
    return () => window.removeEventListener('agent-skill-draft-changed', refresh);
  }, [draftId]);

  const refreshCards = () => {
    setLoading(true); setReload((value) => value + 1);
    window.dispatchEvent(new CustomEvent('agent-skill-draft-changed', { detail: { draftId } }));
  };
  const acceptPrepared = (result: SkillDraftPrepareResult) => {
    preparation.remember(result.draft); setDraft(result.draft); setRepairs(result.repairs || []); setPrepareError('');
  };

  useEffect(() => {
    if (!draftId) { setDraft(null); setLoading(false); setError('这份产物没有关联可读取的 Skill 草稿。'); return; }
    let active = true;
    setLoading(true); setError('');
    void (async () => {
      try {
        const value = await window.agent.skillDraft({ draftId });
        if (!active) return;
        if (!value) { setDraft(null); setError('这份 Skill 草稿不存在，可能已被删除。'); return; }
        if (novelId && value.scope === 'novel' && value.sourceNovelId !== novelId) { setDraft(null); setError('这份 Skill 草稿属于其他小说。'); return; }
        const saved = value as SkillDraftReviewRecord;
        setDraft(saved);
        if (saved.status === 'committed' || saved.status === 'discarded') { setEditing(null); setAiRequest(null); return; }
        try {
          const result = await preparation.prepare(saved, async () => {
            if (active) setPreparing(true);
            return await window.automation.invoke('agent_skill.workspace.prepare', { draftId, expectedVersion: saved.version }, 'desktop-ui') as SkillDraftPrepareResult;
          });
          if (active && result) acceptPrepared(result);
        } catch { if (active) setPrepareError('格式整理暂未完成。规则已保留，尚未保存为可用技能。'); }
      } catch { if (active) setError('草稿暂时无法读取，请重新加载。'); }
      finally { if (active) { setLoading(false); setPreparing(false); } }
    })();
    return () => { active = false; };
  }, [draftId, novelId, reload]);

  const view = draft ? projectSkillDraftReview(draft) : null;
  const muted = isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]';
  const secondaryButton = clsx('h-8 rounded-md border px-3 text-xs disabled:opacity-50', isDark ? 'border-white/10 hover:bg-white/5' : 'border-[var(--ui-border-strong)] bg-white hover:bg-[var(--ui-surface-subtle)]');
  const inputClass = clsx('w-full rounded border px-3 py-2 text-sm leading-6', isDark ? 'border-white/10 bg-neutral-900' : 'border-[var(--ui-border)] bg-white');
  const busy = Boolean(pending) || preparing || loading || publicationBusy;
  const blocked = busy || Boolean(error);
  const statusLabel = draft?.status === 'committed' ? '已保存' : draft?.status === 'discarded' ? '已放弃'
    : busy ? '规则已保存，正在整理' : prepareError ? '格式整理暂未完成'
      : view?.canPublish ? '可以审核保存' : view?.qualityRequired && !view.qualityPassed ? '需要内容与试写审核' : view?.authorQuestions.length ? '需要补充要求' : '格式整理暂未完成';

  const retryPreparation = async () => {
    if (!draft || blocked) return;
    setPending('prepare'); setPrepareError('');
    try {
      const result = await preparation.prepare(draft, async () => await window.automation.invoke('agent_skill.workspace.prepare', {
        draftId, expectedVersion: draft.version,
      }, 'desktop-ui') as SkillDraftPrepareResult, true);
      if (result) acceptPrepared(result);
    } catch { setPrepareError('格式整理暂未完成。规则已保留，可以稍后重试。'); }
    finally { refreshCards(); setPending(null); }
  };

  const commit = async () => {
    if (!draft || !view?.canPublish || editing || aiRequest || blocked || confirmation?.action !== 'commit') return;
    if (confirmation.version !== draft.version) { setConfirmation(null); toast.error('草稿已更新，请重新预览后确认保存。'); return; }
    setPending('commit');
    try {
      const result = await window.agent.commitSkillDraft({ draftId: draft.id, expectedVersion: draft.version, confirmed: true }) as { draft?: SkillDraftReviewRecord };
      if (result.draft) setDraft(result.draft);
      setConfirmation(null); toast.success('Skill 已保存，可在 / 菜单中选择');
      void Promise.resolve().then(onPublished).catch((error) => console.warn('[SkillDraftReviewCard] Skill list refresh failed:', error));
    } catch { toast.error('保存暂未完成，规则仍在草稿中。请重新加载后再试。'); }
    finally { refreshCards(); setPending(null); }
  };

  const usePublishedPack = async (asDefault: boolean) => {
    if (!draft?.committedPackRevisionId) return;
    try {
      const targetNovel = novelId || draft.sourceNovelId;
      const pack = await window.agent.skillPack({ revisionId: draft.committedPackRevisionId, novelId: targetNovel }) as unknown as AgentSkillMenuPack;
      if (!pack.available) throw new Error('文风包或成员不可用');
      if (asDefault) {
        if (!targetNovel) throw new Error('请先选择小说');
        const preference = await window.agent.skillPackDefault({novelId: targetNovel});
        await window.agent.setSkillPackDefault({novelId: targetNovel, packId: pack.id, revisionId: pack.revisionId, expectedVersion: preference.version});
        toast.success('已设为本书 Agent 默认文风包');
        await onPublished();
      } else window.dispatchEvent(new CustomEvent('agent-skill-pack-selected', {detail: {...pack, entryType: 'pack'}}));
    } catch { toast.error('文风包暂时无法使用，请重新加载并检查版本和默认设置。'); }
  };

  const discard = async () => {
    if (!draft || blocked || confirmation?.action !== 'discard') return;
    if (confirmation.version !== draft.version) { setConfirmation(null); toast.error('草稿已更新，请重新确认放弃。'); return; }
    setPending('discard');
    try {
      setDraft(await window.agent.discardSkillDraft({ draftId: draft.id, expectedVersion: draft.version }) as SkillDraftReviewRecord);
      setEditing(null); setAiRequest(null); setConfirmation(null); toast.success('草稿已放弃');
    } catch { toast.error('暂时无法放弃草稿，请重新加载后再试。'); }
    finally { refreshCards(); setPending(null); }
  };

  const saveRules = async () => {
    if (!draft || !editing || blocked) return;
    setPending('save');
    try {
      const result = await window.automation.invoke('agent_skill.workspace.prepare', {
        draftId: draft.id, expectedVersion: editing.version, logicalPath: editing.path,
        rules: { title: editing.title, description: editing.description, instructions: editing.instructions,
          constraints: editing.constraintsText.split('\n').map((line) => line.trim()).filter(Boolean) },
      }, 'desktop-ui') as SkillDraftPrepareResult;
      acceptPrepared(result); setEditing(null);
      toast.success(projectSkillDraftReview(result.draft).canPublish ? '修改已保留，请预览后保存 Skill' : '修改已保留，请补充下方要求');
    } catch { setPrepareError('修改暂未完成，你输入的规则已保留。草稿可能已在另一处更新，请对照最近保存的内容后重试。'); }
    finally { refreshCards(); setPending(null); }
  };

  const reviseRules = async () => {
    if (!draft || !aiRequest?.goal.trim() || blocked) return;
    setPending('revise');
    try {
      const result = await window.agent.reviseSkill({ draftId, expectedVersion: aiRequest.version, logicalPath: aiRequest.path,
        goal: aiRequest.goal, ...(novelId ? { novelId } : {}), locale: 'zh-CN' }) as SkillDraftPrepareResult;
      acceptPrepared(result); setAiRequest(null); toast.success('已按你的要求调整，请预览后保存 Skill');
    } catch { setPrepareError('AI 修改暂未完成。原规则和你的修改要求已保留，请稍后重试。'); }
    finally { refreshCards(); setPending(null); }
  };

  return (
    <section className={clsx('rounded-lg border p-4', isDark ? 'border-blue-400/20 bg-blue-500/5' : 'border-blue-100 bg-blue-50/50')} aria-label="Skill 草稿">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><div className="text-sm font-semibold">{view?.title || 'Skill 草稿'}</div>
          {view && <p className={clsx('mt-1 text-xs leading-5', muted)}>{view.categoryLabel} · {draft?.currentVisibility ? (draft.currentVisibility.scope === 'user' ? '所有小说可见' : `仅 ${publicationNovels.find(n => n.id === draft.currentVisibility?.ownerNovelId)?.title || '指定小说'} 可见`) : `${draft?.status === 'committed' ? '创建时范围：' : ''}${view.scopeLabel}`} · {view.operationLabels.length ? `适用：${view.operationLabels.join('、')}` : '用途待确认'}</p>}
        </div>
        <span className="shrink-0 rounded bg-neutral-500/10 px-2 py-1 text-xs">{statusLabel}</span>
      </div>
      {busy && <div className={clsx('mt-3 flex items-center gap-2 text-xs', muted)} role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" />{pending === 'revise' ? '正在按你的要求调整规则' : '正在读取并整理规则'}</div>}
      {error && <div className="mt-3 text-sm text-red-600" role="alert">{error}<button type="button" className={clsx('ml-2', secondaryButton)} onClick={refreshCards}>重新加载</button></div>}
      {prepareError && <p className="mt-3 text-xs leading-6 text-amber-700" role="alert">{prepareError}</p>}
      {view && <>
        {view.description && <p className="mt-3 text-sm leading-6">{view.description}</p>}
        {view.qualityRequired && !view.qualityPassed && <p className="mt-3 text-xs leading-6 text-amber-700">文风草稿尚未通过当前版本的内容审核和原创场景试写，不能仅凭格式校验保存。修改正文或绑定后需要重新审核；“重试整理”只处理格式。</p>}
        {!busy && view.editable && !view.canPublish && view.authorQuestions.length > 0 && <div className="mt-3 rounded border border-amber-300/40 p-3 text-xs leading-6">{[...new Set(view.authorQuestions)].map((question) => <p key={question}>{question}</p>)}</div>}
        {repairs?.length || view.formatRepaired ? <p className={clsx('mt-3 text-xs', muted)}>已自动整理保存格式，技能内容已保留。</p> : null}
        {view.rules.map((rule) => <div key={rule.path} className={clsx('mt-4 border-t pt-4', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          {view.isPack && <div className="mb-2 text-sm font-medium">{rule.title} · {rule.categoryLabel}</div>}
          {editing?.path === rule.path ? <div className="space-y-3" aria-label="修改技能内容">
            <label className="block text-xs">名称<input aria-label="规则名称" value={editing.title} disabled={blocked} onChange={(event) => setEditing({ ...editing, title: event.target.value })} className={clsx('mt-1', inputClass)} /></label>
            <label className="block text-xs">说明<input aria-label="规则说明" placeholder="说明这个 Skill 用来做什么。" value={editing.description} disabled={blocked} onChange={(event) => setEditing({ ...editing, description: event.target.value })} className={clsx('mt-1', inputClass)} /></label>
            <label className="block text-xs">技能内容<textarea aria-label="技能内容" placeholder="填写规则、步骤或方法，可使用 Markdown 自由组织标题。" value={editing.instructions} disabled={blocked} onChange={(event) => setEditing({ ...editing, instructions: event.target.value })} className={clsx('mt-1 min-h-64', inputClass)} /></label>
            <label className="block text-xs">附加限制（每行一项）<textarea aria-label="附加限制" value={editing.constraintsText} disabled={blocked} onChange={(event) => setEditing({ ...editing, constraintsText: event.target.value })} className={clsx('mt-1 min-h-24', inputClass)} /></label>
            <p className={clsx('text-xs', muted)}>示例、参考材料、保存位置和适用任务沿用已保存内容。这里的修改先保留为草稿。</p>
            {draft && editing.version !== draft.version && <p className="text-xs leading-6 text-amber-700">草稿已在另一处更新。你的输入仍在；请先对照下面的最近保存内容，确认后继续编辑。</p>}
            <div className="flex flex-wrap gap-2"><button type="button" disabled={blocked} onClick={saveRules} className={secondaryButton}>保留修改并整理</button><button type="button" disabled={busy} onClick={() => setEditing(null)} className={secondaryButton}>取消修改</button>
              {draft && editing.version !== draft.version && <button type="button" disabled={blocked} onClick={() => setEditing({ ...editing, version: draft.version })} className={secondaryButton}>保留我的输入，继续编辑</button>}</div>
            <details className="text-xs"><summary className="cursor-pointer">对照最近保存的规则</summary><p className="mt-2">{rule.title} · {rule.description}</p><AssistantMarkdown content={rule.instructions} isDark={isDark} variant="chat" ariaLabel="最近保存的规则" /><ul>{rule.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></details>
          </div> : <>
            <div className="max-h-96 overflow-y-auto"><AssistantMarkdown content={rule.instructions || '请补充这个 Skill 的规则、步骤或方法。'} isDark={isDark} variant="chat" ariaLabel="技能内容预览" /></div>
            {rule.constraints.length > 0 && <div className="mt-3"><div className="text-xs font-medium">附加限制</div><ul className="mt-1 list-inside list-disc text-sm leading-6">{rule.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></div>}
            {rule.examples.length > 0 && <div className="mt-3"><div className="text-xs font-medium">示例</div>{rule.examples.map((example, index) => <p key={index} className="mt-1 whitespace-pre-wrap text-sm leading-6">{readableExample(example)}</p>)}</div>}
            {view.editable && <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={blocked || Boolean(editing) || Boolean(aiRequest) || Boolean(confirmation)} onClick={() => setEditing({ draftId, path: rule.path, version: draft!.version, title: rule.title, description: rule.description, instructions: rule.instructions, constraintsText: rule.constraints.join('\n') })} className={secondaryButton}>修改规则</button>
              <button type="button" disabled={blocked || Boolean(editing) || Boolean(aiRequest) || Boolean(confirmation)} onClick={() => setAiRequest({ path: rule.path, version: draft!.version, goal: '' })} className={secondaryButton}>让 AI 修改</button></div>}
          </>}
          {aiRequest?.path === rule.path && <div className="mt-3 space-y-2"><p className={clsx('text-xs leading-6', muted)}>AI 调整技能内容。名称、说明和附加限制保持原内容；需要修改这些内容时，请使用“修改规则”。</p><label className="block text-xs">补充你的修改要求<textarea aria-label="AI 修改要求" placeholder="例如：明确执行步骤，补充判断标准，保留已有示例。" value={aiRequest.goal} disabled={blocked} onChange={(event) => setAiRequest({ ...aiRequest, goal: event.target.value })} className={clsx('mt-1 min-h-24', inputClass)} /></label>
            <div className="flex gap-2"><button type="button" disabled={blocked || !aiRequest.goal.trim()} onClick={reviseRules} className={secondaryButton}>按要求修改</button><button type="button" disabled={busy} onClick={() => setAiRequest(null)} className={secondaryButton}>取消</button></div></div>}
        </div>)}
        {view.references.length > 0 && <details className="mt-4 text-xs"><summary className="cursor-pointer">参考材料与示例（{view.references.length}）</summary>{view.references.map((reference) => <div key={reference.path} className="mt-3 max-h-64 overflow-y-auto"><AssistantMarkdown content={reference.content} isDark={isDark} variant="chat" ariaLabel="参考材料" /></div>)}</details>}
        {draft?.status === 'committed' && <div className="mt-4 text-xs leading-6">
          <p>{draft.action === 'pack' ? '已加入技能库。在输入框输入 /，选择文风包即可用于后续任务；保存不会更改本书默认。' : `已加入技能库。在输入框输入 /，选择“${view.title}”即可用于后续任务；本书默认规则保持原设置。`}</p>
          {draft.action === 'pack' && <div className="flex gap-2"><button className={secondaryButton} onClick={() => void usePublishedPack(false)}>本次使用</button><button className={secondaryButton} onClick={() => void usePublishedPack(true)}>设为本书默认</button></div>}
          {(draft.committedSkillId || draft.committedPackId) && <button type="button" className={secondaryButton} onClick={managePublished}>设置可见范围</button>}
        </div>}
        {view.editable && <div className="mt-4 flex flex-wrap gap-2">
          {draft?.action !== 'update' && <div className="w-full space-y-2 text-xs">
            <label>保存范围 <select aria-label="草稿保存范围" disabled={publicationBusy || busy} className={inputClass} value={draft?.publicationScope || draft?.scope || 'novel'}
              onChange={e => void changePublication(e.target.value as 'user' | 'novel', e.target.value === 'novel' ? draft?.publicationOwnerNovelId || novelId || draft?.sourceNovelId : undefined)}><option value="novel">指定小说</option><option value="user">所有小说可见</option></select></label>
            {(draft?.publicationScope || draft?.scope) === 'novel' && <label>归属小说 <select aria-label="草稿归属小说" className={inputClass} disabled={publicationBusy || busy} value={draft?.publicationOwnerNovelId || draft?.sourceNovelId || novelId || ''} onChange={e => void changePublication('novel', e.target.value)}><option value="">请选择小说</option>{publicationNovels.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>}
            {draft?.publicationScope && <p>保存时将应用此可见范围，原文分析输入与方法正文保留。</p>}
            {publicationError && <p role="alert" className="text-red-500">{publicationError}</p>}
          </div>}
          <button type="button" disabled={blocked || Boolean(editing) || Boolean(aiRequest) || Boolean(confirmation) || !view.canPublish} onClick={() => setConfirmation({ action: 'commit', version: draft!.version })} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#2f80ed] px-3 text-xs font-medium text-white hover:bg-[#246fce] disabled:cursor-not-allowed disabled:opacity-50">{pending === 'commit' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}保存 Skill</button>
          {!view.canPublish && <button type="button" disabled={blocked || Boolean(editing) || Boolean(aiRequest) || Boolean(confirmation)} onClick={retryPreparation} className={secondaryButton}>重试整理</button>}
          <button type="button" disabled={blocked || Boolean(confirmation)} onClick={() => setConfirmation({ action: 'discard', version: draft!.version })} className={secondaryButton}>放弃草稿</button>
        </div>}
        {view.editable && confirmation && <div className="mt-3 rounded-md border border-blue-300/40 p-3 text-xs leading-6" role="group" aria-label="Skill 操作确认">
          <p>{confirmation.action === 'commit' ? '保存这个 Skill 吗？保存后可以在 / 菜单中选择，用于后续任务。' : '确定放弃这份草稿吗？规则仍可查看，但不会加入技能库。'}</p>
          <div className="mt-2 flex gap-2"><button type="button" disabled={blocked} onClick={confirmation.action === 'commit' ? commit : discard} className={secondaryButton}>{confirmation.action === 'commit' ? '确认保存' : '确认放弃'}</button><button type="button" disabled={busy} onClick={() => setConfirmation(null)} className={secondaryButton}>取消</button></div>
        </div>}
        <details className={clsx('mt-4 border-t pt-3 text-xs', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')} aria-label="高级格式详情">
          <summary className={clsx('cursor-pointer', muted)}>格式详情（高级，只读）</summary>
          <p className={clsx('mt-2 leading-5', muted)}>这些格式由软件维护，无需修改。草稿保存在应用数据库中。</p>
          {view.documents.map((document) => <details key={document.path} className="mt-2"><summary className="cursor-pointer">{document.path}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{document.content}</pre></details>)}
          {view.diagnostics.length > 0 && <ul className="mt-3 space-y-2" aria-label="技术校验诊断">{view.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}><div>{diagnostic.message}</div><div className={muted}>{diagnostic.path}{diagnostic.line ? ` · 第 ${diagnostic.line} 行` : ''} · {diagnostic.code}</div>{diagnostic.suggestion && <div>{diagnostic.suggestion}</div>}</li>)}</ul>}
          {repairs?.map((repair, index) => <p key={index} className="mt-2">{repair.path} · {repair.message}</p>)}
        </details>
      </>}
    </section>
  );
}
