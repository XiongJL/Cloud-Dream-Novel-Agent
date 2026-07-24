import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  CircleEllipsis,
  Clock3,
  Filter,
  Loader2,
  PanelLeftOpen,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import type { Volume } from '../../types';
import type {
  AgentRevisionTask,
  AgentRevisionTaskStatus,
} from '../../../shared/expertReport';

type Props = {
  novelId: string;
  volumes: Volume[];
  isDark: boolean;
  refreshKey: number;
  onContinue: (task: AgentRevisionTask) => Promise<void> | void;
  onReturnToConversation: () => void;
  onOpenNavigation: () => void;
  onPendingCountChange: (count: number) => void;
};

type TaskView = 'pending' | 'in_progress' | 'completed' | 'stale';

const VIEW_OPTIONS: Array<{ id: TaskView; label: string }> = [
  { id: 'pending', label: '待处理' },
  { id: 'in_progress', label: '处理中' },
  { id: 'completed', label: '已完成' },
  { id: 'stale', label: '已失效' },
];

const EXPERT_LABELS: Record<AgentRevisionTask['sourceExpert'], string> = {
  writer: '作者审核',
  editor: '编辑审核',
  reader: '读者审核',
  worldbuilding: '世界观审核',
  research_rag: '考据审核',
  supervisor: '团队审核',
};

function taskView(status: AgentRevisionTaskStatus): TaskView | 'hidden' {
  if (status === 'resolved') return 'completed';
  if (status === 'stale') return 'stale';
  if (status === 'planned') return 'in_progress';
  if (status === 'closed') return 'hidden';
  return 'pending';
}

function entryReason(task: AgentRevisionTask): string {
  if (task.entryReason === 'deferred') return '稍后处理';
  if (task.entryReason === 'failed') return '执行失败';
  if (task.entryReason === 'cancelled') return '用户停止';
  if (task.entryReason === 'interrupted') return '执行中断';
  if (task.entryReason === 'accepted') return '审核建议';
  return '历史记录';
}

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return '刚刚';
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

export function RevisionTaskWorkspace({
  novelId,
  volumes,
  isDark,
  refreshKey,
  onContinue,
  onReturnToConversation,
  onOpenNavigation,
  onPendingCountChange,
}: Props) {
  const [tasks, setTasks] = useState<AgentRevisionTask[]>([]);
  const [selectedView, setSelectedView] = useState<TaskView>('pending');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [highImpactOnly, setHighImpactOnly] = useState(false);
  const [interruptedOnly, setInterruptedOnly] = useState(false);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);

  const chapterById = useMemo(() => new Map(
    volumes.flatMap((volume) => volume.chapters.map((chapter) => [chapter.id, chapter.title] as const)),
  ), [volumes]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.automation.invoke('revision_task.list', { novelId }, 'desktop-ui');
      const nextTasks = Array.isArray(result) ? result as AgentRevisionTask[] : [];
      setTasks(nextTasks);
      onPendingCountChange(nextTasks.filter((task) => taskView(task.status) === 'pending').length);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [novelId, onPendingCountChange]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, refreshKey]);

  const counts = useMemo(() => {
    const next: Record<TaskView, number> = { pending: 0, in_progress: 0, completed: 0, stale: 0 };
    for (const task of tasks) {
      const view = taskView(task.status);
      if (view !== 'hidden') next[view] += 1;
    }
    return next;
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (taskView(task.status) !== selectedView) return false;
      if (highImpactOnly && !['critical', 'high'].includes(task.severity)) return false;
      if (interruptedOnly && !['failed', 'cancelled', 'interrupted'].includes(task.entryReason)) return false;
      if (!normalizedQuery) return true;
      const chapterTitles = task.targetChapterIds.map((id) => chapterById.get(id) || id).join(' ');
      return `${task.title} ${task.description} ${chapterTitles} ${EXPERT_LABELS[task.sourceExpert]}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [chapterById, highImpactOnly, interruptedOnly, query, selectedView, tasks]);

  const continueTask = async (task: AgentRevisionTask) => {
    setActionTaskId(task.revisionTaskId);
    try {
      await onContinue(task);
    } catch (continueError) {
      toast.error(continueError instanceof Error ? continueError.message : String(continueError));
    } finally {
      setActionTaskId(null);
    }
  };

  const removeTask = async (task: AgentRevisionTask) => {
    setActionTaskId(task.revisionTaskId);
    setMenuTaskId(null);
    try {
      const updated = await window.automation.invoke('revision_task.update_status', {
        revisionTaskId: task.revisionTaskId,
        expectedUpdatedAt: task.updatedAt,
        status: 'closed',
      }, 'desktop-ui') as AgentRevisionTask;
      setTasks((current) => current.map((item) => item.revisionTaskId === updated.revisionTaskId ? updated : item));
      toast.success('已移出待改清单');
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setActionTaskId(null);
    }
  };

  const activeFilterCount = Number(highImpactOnly) + Number(interruptedOnly);
  const pendingSummary = `${counts.pending} 项待处理 · ${counts.in_progress} 项处理中`;
  const panel = isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-white';
  const muted = isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]';

  return (
    <section className="col-start-2 min-h-0 min-w-0 flex flex-col max-[1180px]:col-start-1">
      <header className={clsx('shrink-0 border-b px-7 py-4 max-[720px]:px-4', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
        <div className="mx-auto w-full max-w-[960px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <button
              type="button"
              onClick={onOpenNavigation}
              className={clsx('hidden h-8 w-8 shrink-0 place-items-center rounded-md max-[1180px]:grid', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}
              title="打开会话导航"
              aria-label="打开会话导航"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-lg font-semibold">待改清单</h2>
                <span className={clsx('text-xs', muted)}>{pendingSummary}</span>
              </div>
              <p className={clsx('mt-1 text-sm', muted)}>稍后处理和未完成的修订</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void loadTasks()}
              disabled={loading}
              className={clsx('grid h-8 w-8 place-items-center rounded-md border', panel)}
              title="刷新待改清单"
              aria-label="刷新待改清单"
            >
              <RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={onReturnToConversation}
              className={clsx('h-8 rounded-md border px-3 text-xs', panel)}
            >
              返回当前对话
            </button>
          </div>
        </div>

        <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className={clsx('grid min-w-0 grid-cols-4 rounded-md p-1 max-[640px]:w-full', isDark ? 'bg-white/5' : 'bg-[var(--ui-surface-muted)]')}>
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setSelectedView(option.id)}
                className={clsx(
                  'h-8 min-w-[84px] rounded px-3 text-xs max-[640px]:min-w-0 max-[640px]:px-1',
                  selectedView === option.id
                    ? (isDark ? 'bg-white/10 text-white' : 'bg-white text-[var(--ui-text-primary)] shadow-[0_1px_3px_rgba(0,0,0,0.06)]')
                    : muted,
                )}
              >
                {option.label}{counts[option.id] > 0 ? ` ${counts[option.id]}` : ''}
              </button>
            ))}
          </div>
          <div className="relative flex min-w-[260px] flex-1 justify-end max-[720px]:min-w-0 max-[720px]:w-full">
            <div className={clsx('flex h-9 w-full max-w-[430px] items-center gap-2 rounded-md border px-2 max-[720px]:max-w-none', panel)}>
              <Search className={clsx('h-4 w-4 shrink-0', muted)} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索待改内容"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
              <button
                type="button"
                onClick={() => setFilterOpen((current) => !current)}
                className={clsx('relative grid h-7 w-7 shrink-0 place-items-center rounded', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')}
                title="筛选待改内容"
                aria-label="筛选待改内容"
                aria-expanded={filterOpen}
              >
                <Filter className="h-4 w-4" />
                {activeFilterCount > 0 && <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-[#2f80ed]" />}
              </button>
            </div>
            {filterOpen && (
              <div className={clsx('absolute right-0 top-11 z-20 w-52 rounded-md border p-2 shadow-lg', isDark ? 'border-white/10 bg-[#17171d]' : 'border-[var(--ui-border)] bg-white')}>
                <FilterOption checked={highImpactOnly} label="只看高影响建议" onChange={setHighImpactOnly} isDark={isDark} />
                <FilterOption checked={interruptedOnly} label="只看中断恢复" onChange={setInterruptedOnly} isDark={isDark} />
                {activeFilterCount > 0 && (
                  <button type="button" onClick={() => { setHighImpactOnly(false); setInterruptedOnly(false); }} className={clsx('mt-1 h-8 w-full rounded px-2 text-left text-xs', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')}>清除筛选</button>
                )}
              </div>
            )}
          </div>
        </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-2 max-[720px]:px-4">
        <div className="mx-auto w-full max-w-[960px]">
        {error && (
          <div className={clsx('mb-3 flex items-center justify-between gap-3 border-b px-1 py-3 text-sm', isDark ? 'border-red-500/20 text-red-200' : 'border-red-200 text-red-700')}>
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} title="关闭错误" aria-label="关闭错误"><X className="h-4 w-4" /></button>
          </div>
        )}
        {loading && tasks.length === 0 ? (
          <div className={clsx('grid h-40 place-items-center text-sm', muted)}><span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />正在加载待改内容</span></div>
        ) : visibleTasks.length === 0 ? (
          <div className={clsx('grid h-40 place-items-center border-b text-sm', isDark ? 'border-white/10 text-neutral-500' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)]')}>当前没有{VIEW_OPTIONS.find((option) => option.id === selectedView)?.label}的内容。</div>
        ) : (
          <div className={clsx('divide-y', isDark ? 'divide-white/10' : 'divide-[var(--ui-border)]')}>
            {visibleTasks.map((task) => {
              const view = taskView(task.status);
              const chapterTitles = task.targetChapterIds.map((id) => chapterById.get(id) || id);
              const expanded = expandedTaskId === task.revisionTaskId;
              const runningAction = actionTaskId === task.revisionTaskId;
              return (
                <article key={task.revisionTaskId} className={clsx('py-3.5', view === 'completed' && 'opacity-60')}>
                  <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 max-[720px]:grid-cols-[20px_minmax(0,1fr)]">
                    <TaskStatusIcon view={view === 'hidden' ? 'pending' : view} />
                    <div className="min-w-0">
                      <div className="flex min-h-6 items-center">
                        <h3 className="min-w-0 text-sm font-medium leading-6">{task.title}</h3>
                      </div>
                      <div className={clsx('mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs leading-5', muted)}>
                        <span>{chapterTitles.length ? chapterTitles.join('、') : '未指定章节'}</span>
                        <span>·</span>
                        <span>{EXPERT_LABELS[task.sourceExpert]}</span>
                        <span>·</span>
                        <span>{entryReason(task)}</span>
                        <span>·</span>
                        <span>{formatRelativeTime(task.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 max-[720px]:col-start-2 max-[720px]:justify-start">
                      <button
                        type="button"
                        onClick={() => setExpandedTaskId((current) => current === task.revisionTaskId ? null : task.revisionTaskId)}
                        className={clsx('inline-flex h-8 items-center gap-1 rounded px-2 text-xs', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')}
                        aria-expanded={expanded}
                      >
                        查看依据
                        <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void continueTask(task)}
                        disabled={runningAction}
                        className={clsx(
                          'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium disabled:opacity-50',
                          isDark
                            ? 'border-white/15 text-neutral-300 hover:bg-white/5'
                            : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-muted)]',
                        )}
                      >
                        {runningAction && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {view === 'pending' ? '继续处理' : view === 'in_progress' ? '返回对话' : '回到对话'}
                      </button>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setMenuTaskId((current) => current === task.revisionTaskId ? null : task.revisionTaskId)}
                          className={clsx('grid h-8 w-8 place-items-center rounded-md', isDark ? 'text-neutral-500 hover:bg-white/5' : 'text-[var(--ui-text-disabled)] hover:bg-[var(--ui-surface-muted)]')}
                          title="更多操作"
                          aria-label={`更多操作：${task.title}`}
                        >
                          <CircleEllipsis className="h-4 w-4" />
                        </button>
                        {menuTaskId === task.revisionTaskId && (
                          <div className={clsx('absolute right-0 top-9 z-10 w-32 rounded-md border p-1 shadow-lg', isDark ? 'border-white/10 bg-[#17171d]' : 'border-[var(--ui-border)] bg-white')}>
                            <button type="button" disabled={runningAction} onClick={() => void removeTask(task)} className={clsx('h-8 w-full rounded px-2 text-left text-xs disabled:opacity-50', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')}>移出清单</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {expanded && (
                    <div className={clsx('ml-8 mt-3 border-l-2 py-1 pl-4 text-sm leading-6', isDark ? 'border-white/15 text-neutral-400' : 'border-[#d6e0f8] text-[var(--ui-text-muted)]')}>
                      <div><span className={isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]'}>修改依据：</span>{task.description}</div>
                      {task.note && <div className="mt-1">作者备注：{task.note}</div>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        </div>
      </div>
    </section>
  );
}

function FilterOption({ checked, label, onChange, isDark }: { checked: boolean; label: string; onChange: (value: boolean) => void; isDark: boolean }) {
  return (
    <label className={clsx('flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-xs', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5 accent-[#2f80ed]" />
      {label}
    </label>
  );
}

function TaskStatusIcon({ view }: { view: TaskView }) {
  const label = view === 'pending' ? '待处理' : view === 'in_progress' ? '处理中' : view === 'completed' ? '已完成' : '已失效';
  return (
    <span className="mt-1 grid h-4 w-4 place-items-center" title={label} aria-label={label}>
      {view === 'in_progress' ? <Loader2 className="h-4 w-4 animate-spin text-[#2f80ed] motion-reduce:animate-none" aria-hidden="true" />
        : view === 'completed' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          : view === 'stale' ? <RefreshCw className="h-4 w-4 text-[var(--ui-text-disabled)]" aria-hidden="true" />
            : <Clock3 className="h-4 w-4 text-[var(--ui-text-muted)]" aria-hidden="true" />}
    </span>
  );
}
