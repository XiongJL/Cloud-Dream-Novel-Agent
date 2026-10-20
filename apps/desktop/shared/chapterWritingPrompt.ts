export const MAX_NEW_CHAPTERS = 10;
export const MAX_REWRITE_CHAPTERS = 5;
export type ChapterWritingMode = 'new_chapter' | 'continue_chapter' | 'rewrite_chapter';

export interface ChapterSourceOptions {
  sourcePolicy?: 'existing_chapters' | 'outline_only';
  /** A standalone task, without prior conversation or revision beats. */
  freshWritingBrief?: string;
  excludedWorldSettingIds?: string[];
}

/** Apply at both the context and provider boundaries; never trust a cached context. */
export function prepareChapterWritingPayload<T extends ChapterSourceOptions & {
  mode?: string; currentContent?: string; userIntent?: string; preparedContext?: unknown;
  batchContext?: unknown; overrideUserPrompt?: string; ideaIds?: string[]; currentLocation?: string;
}>(payload: T): T {
  if (payload.sourcePolicy !== undefined && !['existing_chapters', 'outline_only'].includes(payload.sourcePolicy)) {
    throw new Error('INVALID_INPUT: Unknown chapter source policy');
  }
  if (payload.sourcePolicy !== 'outline_only') return payload;
  if ('draftBatchId' in payload && payload.draftBatchId) {
    throw new Error('INVALID_INPUT: outline_only currently supports a single chapter, not an existing rewrite batch');
  }
  if (payload.mode !== 'rewrite_chapter') throw new Error('INVALID_INPUT: outline_only requires rewrite_chapter');
  const brief = payload.freshWritingBrief?.trim();
  if (!brief || brief.length > 12000) throw new Error('INVALID_INPUT: outline_only requires a standalone freshWritingBrief (1–12000 characters)');
  return {...payload, currentContent: '', userIntent: brief, freshWritingBrief: brief,
    preparedContext: undefined, batchContext: undefined, overrideUserPrompt: undefined,
    ideaIds: [], currentLocation: undefined};
}

export function chapterWritingMode(mode: unknown): ChapterWritingMode {
  return mode === 'new_chapter' || mode === 'rewrite_chapter' ? mode : 'continue_chapter';
}

/** One detailed current beat, plus the global route and future disclosure boundaries. */
export function chapterBatchForPrompt(batch: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!batch) return undefined;
  const current = batch.currentBeat;
  const index = Number(batch.childIndex ?? current?.childIndex ?? 0);
  const beats = Array.isArray(batch.allBeats) ? batch.allBeats : [];
  const {allBeats: _all, currentBeat: _current, recentFullDrafts: recent, requireVerifiedState: _statePolicy, stateLedger, ...metadata} = batch;
  const verifiedOpened = new Set((stateLedger?.stateDeltas || []).flatMap((delta: any) =>
    (delta.openedConflicts || []).map((item: any) => item.conflict)));
  return {...metadata, currentBeat: current,
    ...(stateLedger ? {stateLedger: {...stateLedger,
      unresolvedConflicts: (stateLedger.unresolvedConflicts || []).filter((conflict: string) => verifiedOpened.has(conflict)),
      plannedOrUnverifiedConflicts: (stateLedger.unresolvedConflicts || []).filter((conflict: string) => !verifiedOpened.has(conflict)),
      timeline: (stateLedger.timeline || []).map((entry: any) => {
      const {keyEvents, reveals, ...actual} = entry;
      return {...actual, plannedKeyEvents: keyEvents || [], plannedReveals: reveals || [],
        authority: 'summary_from_actual_draft; planned_events_and_reveals_are_not_verified_facts'};
    }), foreshadowing: (stateLedger.foreshadowing || []).map((entry: any) => ({...entry,
      authority: entry.source === 'state_extraction' ? 'verified_state' : 'planned_hook_not_verified_fact'}))}} : {}),
    otherChapterPlans: beats.filter(beat => Number(beat.childIndex) !== index).map(beat => ({
      childIndex: beat.childIndex, title: beat.title, chapterGoal: beat.chapterGoal, endingHook: beat.endingHook,
      ...(Number(beat.childIndex) > index ? {status: 'future_plan_not_fact', plannedReveals: beat.reveals || []} : {status: 'previous_plan_not_fact'}),
    })),
    ...(Array.isArray(recent) ? {recentFullDrafts: recent.slice(-2)} : {}),
    stateAuthority: '已发生事实以实际草稿及其核对状态为准；未来计划不是已发生事实，不得提前兑现后章揭示。',
  };
}

/** Inspector retains full input; provider receives only the task envelope. */
export function chapterRequestForModel<T extends {params: Record<string, any>}>(structured: T): T {
  const {userIntent: _intent, batchContext: _batch, contextSnapshot: _snapshot, contextPolicy: _policy, ...params} = structured.params;
  return {...structured, params};
}

export function chapterDynamicForPrompt(dynamic: Record<string, any>, batch: Record<string, any> | undefined,
  mode: ChapterWritingMode): Record<string, any> {
  if (mode !== 'new_chapter') return dynamic;
  const {currentChapterBeforeCursor: anchor = '', ...rest} = dynamic;
  const recent = Array.isArray(batch?.recentFullDrafts) ? batch.recentFullDrafts : [];
  const duplicate = recent.find(draft => String(draft.content || '').trim() === String(anchor).trim());
  const seen = new Set([String(anchor).trim(), ...recent.map(draft => String(draft.content || '').trim())].filter(Boolean));
  return {...rest,
    recentChapters: (rest.recentChapters || []).filter((chapter: any) => !seen.has(String(chapter.excerpt || '').trim())),
    ...(anchor ? {anchorChapterReference: duplicate ? {childIndex: duplicate.childIndex, source: 'recentFullDrafts'} : anchor} : {}),
  };
}

export function validateChapterBeatCount(count: unknown, rewrite = false): number {
  const maximum = rewrite ? MAX_REWRITE_CHAPTERS : MAX_NEW_CHAPTERS;
  if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > maximum) {
    throw new Error(`chapterCount must be an integer between 1 and ${maximum}`);
  }
  return Number(count);
}
