import { X, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentSkillMenuSkill } from '../../../shared/agentSkillComposer';

export function SelectedSkillChips({skills, isDark, disabled, onRemove, onAdd, onManage}: {
  skills: AgentSkillMenuSkill[]; isDark: boolean; disabled?: boolean;
  onRemove: (id: string) => void; onAdd: () => void; onManage?: (skill: AgentSkillMenuSkill) => void;
}) {
  return <div role="group" aria-label="已选 Skill" className="mb-1.5 px-1">
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {skills.map(skill => <div key={skill.id} className={clsx('inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs',
        isDark ? 'border-[#2f80ed]/30 bg-[#2f80ed]/10 text-[#9cc8ff]' : 'border-[#b8d7ff] bg-[#eef6ff] text-[#1f6fca]')}>
        <span className="min-w-0 max-w-64 truncate" title={`${skill.title} · v${skill.version}`}>{skill.title}</span>
        {onManage && <button type="button" disabled={disabled} aria-label={`${skill.title}的设置`} onClick={() => onManage(skill)} className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-black/10 disabled:opacity-50">⋯</button>}
        <button type="button" disabled={disabled} aria-label={`移除 ${skill.title}`} onClick={() => onRemove(skill.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-black/10 disabled:opacity-50"><X className="h-3 w-3" /></button>
      </div>)}
      <button type="button" disabled={disabled} onClick={onAdd} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-[#2f80ed] hover:bg-[#2f80ed]/10 disabled:opacity-50"><Plus className="h-3.5 w-3.5" />添加 Skill</button>
    </div>
    <p className="mt-1 text-[11px] opacity-60">已选 {skills.length} 个 · 随本次请求发送，按任务步骤应用</p>
  </div>;
}
