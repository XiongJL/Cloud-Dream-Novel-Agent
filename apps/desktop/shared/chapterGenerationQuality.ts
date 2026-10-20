export interface ChapterConsistencyResult {
    ok: boolean;
    issues: string[];
    status?: 'not_reviewed' | 'needs_review';
    checks?: Array<{id: string; status: 'passed' | 'warning' | 'not_checked'; detail: string}>;
}

export function isSemanticChapterSummary(summary: {provider?: string; model?: string} | undefined): boolean {
    return Boolean(summary?.provider && summary.provider !== 'local' && summary.model !== 'heuristic-v1');
}

/** Excerpts preserve source order and explicitly retain the end state, without inventing facts. */
export function chapterMemoryExcerpt(text: string, maximum = 2400): string {
    if (text.length <= maximum) return text;
    const marker = '\n[中段省略；以下为本章末段原文，不能视为完整情节摘要]\n';
    const available = Math.max(0, maximum - marker.length);
    const head = Math.floor(available * 0.3);
    return text.slice(0, head) + marker + text.slice(-(available - head));
}

export function distinctNarrativeMemories<T extends {summaryText: string; keyFacts: string[]}>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter(item => {
        // Local roll-ups differ only in their novel/volume header.
        const key = item.summaryText.replace(/(?:^|\n)(?:全书|卷级)摘要[^\n]*\n/u, '').replace(/\s+/gu, '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function chapterTitleWithoutNumber(title: string): string {
    return title.replace(/^\s*(?:第[\d零〇一二两三四五六七八九十百千万]+[章节回]\s*|chapter\s+\d+\s*[:：.\-]?\s*)/iu, '').trim();
}

export function newChapterTarget(anchorChapterId: string, chapters: Array<{id: string; title?: string}>, count: number, insertionAfterId = anchorChapterId) {
    const index = chapters.findIndex(chapter => chapter.id === anchorChapterId);
    const insertionIndex = chapters.findIndex(chapter => chapter.id === insertionAfterId);
    if (index < 0 || insertionIndex < 0) throw new Error('CHAPTER_ANCHOR_NOT_FOUND: 新增章节的锚点不存在。');
    return {mode: 'new_chapter', anchorChapterId, anchorTitle: chapters[index].title || '',
        anchorGlobalOrder: index + 1, insertionAfterId, insertionAfterTitle: chapters[insertionIndex].title || '',
        newChapterOrders: Array.from({length: count}, (_, offset) => insertionIndex + offset + 2),
        authority: '既有章节均已发生；大纲为规划，不能重做已完成章目标。新增章从锚点结束状态之后开始。'};
}

export function checkChapterText(text: string, anchorText = ''): ChapterConsistencyResult {
    const paragraphs = text.split(/\n+/u).map(value => value.trim()).filter(Boolean);
    const repeated = paragraphs.filter(value => value.length >= 45 && anchorText.includes(value));
    const issues = text.trim().length < 20 ? ['生成正文过短，需要检查。'] : [];
    if (repeated.length) issues.push(`发现 ${repeated.length} 段与锚点原文完全重复，请核对是否重复推进。`);
    return {ok: false, status: issues.length ? 'needs_review' : 'not_reviewed', issues,
        checks: [
            {id: 'text_structure', status: text.trim().length < 20 ? 'warning' : 'passed', detail: '仅检查正文非空和最小长度。'},
            {id: 'anchor_repetition', status: repeated.length ? 'warning' : anchorText ? 'passed' : 'not_checked', detail: '仅比对与锚点原文完全重复的长段，不代表语义不重复。'},
            {id: 'semantic_continuity', status: 'not_checked', detail: '人物知识、物品状态、时间线及因果尚未经过独立语义审核。'},
            {id: 'style_fidelity', status: 'not_checked', detail: '来源文风复现尚未经过对照审核。'},
        ]};
}

/** A completion receipt is derived from recorded delivery, never from model guesses. */
export function writingDeliveryNotice(artifacts: Array<Record<string, any>>, locale = 'zh-CN'): string | undefined {
    const deliveries = artifacts.filter(item => item.writingDelivery && item.status === 'ready');
    if (!deliveries.length) return undefined;
    const count = deliveries.reduce((sum, item) => sum + Number(item.writingDelivery.generatedCount || 0), 0);
    const sources = new Set(deliveries.flatMap(item => item.writingDelivery.contextSources || []).map(source => source.chapterId));
    const warnings = [...new Set<string>(deliveries.flatMap(item => item.writingDelivery.warnings || []))];
    const verified = deliveries.reduce((sum, item) => sum + Number(item.writingDelivery.stateVerifiedCount || 0), 0);
    const zh = /^zh/iu.test(locale);
    return [zh ? `已生成 ${count} 章草稿，等待审核，尚未写回正文。` : `${count} chapter drafts are ready for review and have not been committed.`,
        sources.size ? (zh ? `本次装载了 ${sources.size} 章上下文（含正文、摘要或摘录，具体覆盖见产物）。` : `Context from ${sources.size} chapters was loaded; see the artifact for coverage.`)
            : (zh ? '交付记录未提供完整上下文覆盖，不能据此断言没有读取正文。' : 'Context coverage was not recorded; this does not establish that no chapter text was read.'),
        zh ? `实际状态已核验 ${verified}/${count} 章；写作交付记录未附独立的语义连续性与来源文风审核结论，基础检查不等同于审核通过。` : `Actual state verified for ${verified}/${count} chapters; the writing delivery records do not include independent semantic or source-style review conclusions. Basic checks do not establish review approval.`,
        ...(warnings.length ? [(zh ? '待处理：' : 'Warnings: ') + warnings.join('；')] : []),
    ].join('\n\n');
}
