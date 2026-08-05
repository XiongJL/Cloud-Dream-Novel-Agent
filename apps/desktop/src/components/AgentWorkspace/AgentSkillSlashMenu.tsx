import { Ban, Box, BookOpen, Sparkles, UserRound } from 'lucide-react';
import { clsx } from 'clsx';
import {
  filterAgentSkillEntries,
  type AgentSkillMenuItem,
  type AgentSkillMenuSkill,
} from '../../../shared/agentSkillComposer';

type Props = {
  skills: AgentSkillMenuSkill[];
  query: string;
  activeItem: AgentSkillMenuItem | undefined;
  isDark: boolean;
  onSelect: (item: AgentSkillMenuItem) => void;
};

const GROUPS = [
  { scope: 'builtin' as const, label: '内置 Skill', icon: Box },
  { scope: 'novel' as const, label: '本小说 Skill', icon: BookOpen },
  { scope: 'user' as const, label: '我的 Skill', icon: UserRound },
];

function itemKey(item: AgentSkillMenuItem | undefined): string | null {
  if (!item) return null;
  return item.kind === 'skill' ? item.skill.id : item.id;
}

export function AgentSkillSlashMenu({ skills, query, activeItem, isDark, onSelect }: Props) {
  const filtered = filterAgentSkillEntries(skills, query);
  const activeKey = itemKey(activeItem);
  return (
    <div
      role="listbox"
      aria-label="选择 Skill"
      className={clsx(
        'absolute bottom-[calc(100%+8px)] left-0 right-0 z-40 max-h-[360px] overflow-y-auto rounded-xl border p-2 shadow-2xl',
        isDark ? 'border-white/10 bg-[#202124] text-neutral-100' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)]',
      )}
    >
      <div className={clsx('px-2 pb-1.5 text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]')}>
        选择后会作为结构化 Skill 随本轮请求发送
      </div>
      <button
        type="button"
        role="option"
        aria-selected={activeKey === 'skill.author'}
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
        role="option"
        aria-selected={activeKey === 'skill.none'}
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
      {GROUPS.map(({ scope, label, icon: Icon }) => {
        const entries = filtered.filter((skill) => skill.scope === scope);
        if (entries.length === 0) return null;
        return (
          <section key={scope} className="mt-2">
            <div className={clsx('flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]')}>
              <Icon className="h-3.5 w-3.5" />
              {label}
            </div>
            {entries.map((skill) => (
              <button
                key={skill.id}
                type="button"
                role="option"
                aria-selected={activeKey === skill.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect({ kind: 'skill', skill })}
                className={clsx(
                  'flex w-full items-start justify-between gap-3 rounded-lg px-2.5 py-2 text-left',
                  activeKey === skill.id
                    ? isDark ? 'bg-white/10' : 'bg-[#eef6ff]'
                    : isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{skill.title}</span>
                  <span className={clsx('mt-0.5 block line-clamp-2 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{skill.description}</span>
                </span>
                <span className={clsx('shrink-0 pt-0.5 font-mono text-[10px]', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>v{skill.version}</span>
              </button>
            ))}
          </section>
        );
      })}
      {filtered.length === 0 && query && (
        <div className={clsx('px-3 py-5 text-center text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
          没有匹配“{query}”的 Skill
        </div>
      )}
    </div>
  );
}
