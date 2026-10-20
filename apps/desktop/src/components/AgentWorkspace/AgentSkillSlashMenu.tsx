import { useEffect, useRef, useState } from 'react';
import { Ban, Box, BookOpen, Loader2, RefreshCw, Sparkles, UserRound, MoreHorizontal, Check } from 'lucide-react';
import { clsx } from 'clsx';
import {
  filterAgentSkillEntries,
  type AgentSkillMenuItem,
  type AgentSkillMenuSkill,
  type AgentSkillMenuPack,
} from '../../../shared/agentSkillComposer';

type Props = {
  skills: AgentSkillMenuSkill[];
  packs?: AgentSkillMenuPack[];
  selectedSkillIds?: string[];
  query: string;
  activeItem: AgentSkillMenuItem | undefined;
  isDark: boolean;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onSelect: (item: AgentSkillMenuItem) => void;
  onManage?: (item: AgentSkillMenuSkill | AgentSkillMenuPack, view: 'detail' | 'visibility' | 'delete') => void;
};

const GROUPS = [
  { scope: 'builtin' as const, label: '内置 Skill', icon: Box },
  { scope: 'novel' as const, label: '本小说 Skill', icon: BookOpen },
  { scope: 'user' as const, label: '我的 Skill', icon: UserRound },
];

function itemKey(item: AgentSkillMenuItem | undefined): string | null {
  if (!item) return null;
  return item.kind === 'skill' ? item.skill.id : item.kind === 'pack' ? item.pack.id : item.id;
}

export function AgentSkillSlashMenu({ skills, packs = [], selectedSkillIds = [], query, activeItem, isDark, loading, error, onRetry, onSelect, onManage }: Props) {
  const [actions, setActions] = useState<string | null>(null);
  const filtered = [...filterAgentSkillEntries(packs, query), ...filterAgentSkillEntries(skills, query)];
  const activeKey = itemKey(activeItem);
  const skillListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeKey || activeKey === 'skill.author' || activeKey === 'skill.none') return;
    const activeNode = Array.from(
      skillListRef.current?.querySelectorAll<HTMLElement>('[data-skill-menu-key]') ?? [],
    ).find((node) => node.dataset.skillMenuKey === activeKey);
    activeNode?.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  return (
    <div
      role="group"
      aria-label="选择 Skill"
      className={clsx(
        'absolute bottom-[calc(100%+8px)] left-0 right-0 z-40 flex h-[min(360px,calc(100vh-180px))] flex-col overflow-hidden rounded-xl border p-2 shadow-2xl',
        isDark ? 'border-white/10 bg-[#202124] text-neutral-100' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)]',
      )}
    >
      <div className={clsx('shrink-0 px-2 pb-1.5 text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]')}>
        可选择多个 Skill；再次点击已选项可移除。文风包按包内组合使用。
      </div>
      <div className="shrink-0">
        <button
          type="button"
          aria-current={activeKey === 'skill.author' ? 'true' : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect({ kind: 'author', id: 'skill.author' })}
          className={clsx(
            'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left',
            activeKey === 'skill.author'
              ? isDark ? 'bg-white/10' : 'bg-[#eef6ff]'
              : isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]',
          )}
        >
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[#2f80ed]" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">创建 Skill</span>
            <span className={clsx('block text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>用自然语言描述能力，先生成可审核草稿</span>
          </span>
        </button>
        <button
          type="button"
          aria-current={activeKey === 'skill.none' ? 'true' : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect({ kind: 'none', id: 'skill.none' })}
          className={clsx(
            'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left',
            activeKey === 'skill.none'
              ? isDark ? 'bg-white/10' : 'bg-[#eef6ff]'
              : isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]',
          )}
        >
          <Ban className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">本次不使用 Skill</span>
            <span className={clsx('block text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>关闭角色默认与自动选择，仅影响本轮</span>
          </span>
        </button>
      </div>
      <div
        ref={skillListRef}
        className={clsx(
          'mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain border-t pr-0.5',
          isDark ? 'border-white/10' : 'border-[var(--ui-border)]',
        )}
      >
        {loading && <div role="status" className="flex items-center gap-2 px-3 py-3 text-xs text-neutral-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载 Skill…</div>}
        {error && <div role="alert" className="flex items-center justify-between gap-3 px-3 py-3 text-xs"><span>{error}</span><button type="button" onMouseDown={event => event.preventDefault()} onClick={onRetry} disabled={loading} className="flex shrink-0 items-center gap-1 text-[#2f80ed] disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />重试</button></div>}
        {GROUPS.map(({ scope, label, icon: Icon }) => {
          const entries = filtered.filter((skill) => skill.scope === scope);
          if (entries.length === 0) return null;
          return (
            <section key={scope} className="mt-2">
              <div className={clsx('sticky top-0 z-10 flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium backdrop-blur-sm', isDark ? 'bg-[#202124]/95 text-neutral-500' : 'bg-white/95 text-[var(--ui-text-disabled)]')}>
                <Icon className="h-3.5 w-3.5" />
                {label}
              </div>
              {entries.map((skill) => <div key={skill.id}>
                <div className="flex items-center gap-1">
                <button
                  key={skill.id}
                  data-skill-menu-key={skill.id}
                  type="button"
                  aria-current={activeKey === skill.id ? 'true' : undefined}
                  aria-pressed={'entryType' in skill ? undefined : selectedSkillIds.includes(skill.id)}
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={'entryType' in skill && !(skill as AgentSkillMenuPack).available}
                  onClick={() => onSelect('entryType' in skill ? { kind: 'pack', pack: skill as AgentSkillMenuPack } : { kind: 'skill', skill })}
                  className={clsx(
                    'flex min-w-0 flex-1 items-start justify-between gap-3 rounded-lg px-2.5 py-2 text-left',
                    activeKey === skill.id || selectedSkillIds.includes(skill.id)
                      ? isDark ? 'bg-white/10' : 'bg-[#eef6ff]'
                      : isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]',
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1 text-sm font-medium">{selectedSkillIds.includes(skill.id) && <Check className="h-3.5 w-3.5 shrink-0" />}<span className="truncate">{'entryType' in skill ? '文风包 · ' : ''}{skill.title}</span></span>
                    <span className={clsx('mt-0.5 block line-clamp-2 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{skill.description}</span>
                    {'entryType' in skill && !(skill as AgentSkillMenuPack).available && <span className="block text-xs text-amber-600">暂不可用，请检查包版本和成员启用状态或重新加载。</span>}
                  </span>
                  <span className={clsx('shrink-0 pt-0.5 text-[11px]', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{skill.scope === 'novel' ? '当前小说' : skill.scope === 'user' ? '所有小说' : '内置'} · v{skill.version}</span>
                </button>
                {onManage && <button type="button" aria-label={`${skill.title}的更多操作`} aria-expanded={actions === skill.id} onMouseDown={e => e.preventDefault()}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md hover:bg-black/5" onClick={() => setActions(actions === skill.id ? null : skill.id)} onKeyDown={e => {if (e.key === 'Escape') {e.stopPropagation(); setActions(null);}}}><MoreHorizontal className="h-4 w-4" /></button>}
                </div>
                {actions === skill.id && onManage && <div className="mb-2 flex flex-wrap gap-2 px-3 text-xs" role="group" aria-label={`${skill.title}的操作`}>
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => {setActions(null); onManage(skill, 'detail');}} className="rounded border px-2 py-1">查看详情</button>
                  {skill.scope !== 'builtin' && <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => {setActions(null); onManage(skill, 'visibility');}} className="rounded border px-2 py-1">设置可见范围</button>}
                  {skill.scope !== 'builtin' && <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => {setActions(null); onManage(skill, 'delete');}} className="rounded border border-red-500/30 px-2 py-1 text-red-500 hover:bg-red-500/10">删除</button>}
                </div>}
              </div>)}
            </section>
          );
        })}
        {!loading && !error && filtered.length === 0 && (
          <div className={clsx('px-3 py-5 text-center text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
            {query ? `没有匹配“${query}”的 Skill` : '暂无可用 Skill'}
          </div>
        )}
      </div>
    </div>
  );
}
