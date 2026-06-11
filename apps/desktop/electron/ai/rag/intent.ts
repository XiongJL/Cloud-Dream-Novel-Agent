import type { RagDetectionResult, RagIntent } from './types';

const CJK_STOP_WORDS = new Set([
    '当前', '现在', '后续', '之后', '后面', '剧情', '大纲', '应该', '怎么', '是否',
    '还有', '哪些', '这个', '那个', '角色', '状态', '写作', '伏笔', '回收', '冲突',
    '前文', '设定', '什么', '一下', '分析',
]);

const EN_STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are',
    'what', 'where', 'when', 'how', 'does', 'do', 'after', 'next', 'current',
]);

function unique(values: string[]): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const raw of values) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(value);
    }
    return output;
}

export function detectRagIntent(question: string): RagIntent {
    const text = question.toLowerCase();
    if (/冲突|矛盾|一致|合理|consisten|conflict/.test(text)) return 'consistency_check';
    if (/伏笔|坑|悬念|未解|没回收|未回收|unresolved|thread|foreshadow/.test(text)) return 'unresolved_threads';
    if (/大纲|接下来|下一步|后续写|怎么写|outline|next beat|next/.test(text)) return 'outline_next';
    if (/后续|后面|之后|还有戏|还有剧情|未来|安排|future|later/.test(text)) return 'future_plot_for_entity';
    if (/当前|现在|状态|在哪里|位置|持有|关系|current|state|status|where/.test(text)) return 'character_state';
    return 'general_qa';
}

export function extractQuestionKeywords(question: string): string[] {
    const atMentions = Array.from(question.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g))
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);

    const cjkWords = Array.from(question.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g))
        .map((match) => match[0])
        .filter((word) => !CJK_STOP_WORDS.has(word));

    const latinWords = Array.from(question.matchAll(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g))
        .map((match) => match[0])
        .filter((word) => !EN_STOP_WORDS.has(word.toLowerCase()));

    return unique([...atMentions, ...cjkWords, ...latinWords]).slice(0, 8);
}

export function detectRagQuestion(question: string, knownEntityNames: string[]): RagDetectionResult {
    const normalizedQuestion = String(question || '');
    const lowerQuestion = normalizedQuestion.toLowerCase();
    const exactMatches = knownEntityNames
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .filter((name) => lowerQuestion.includes(name.toLowerCase()));
    const atMentions = Array.from(normalizedQuestion.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g))
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);

    return {
        intent: detectRagIntent(normalizedQuestion),
        entityNames: unique([...exactMatches, ...atMentions]).slice(0, 8),
        keywords: extractQuestionKeywords(normalizedQuestion),
    };
}
