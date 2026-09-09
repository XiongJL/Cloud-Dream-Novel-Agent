export const DEFAULT_CHAPTER_LENGTH = 2300;
export const DEFAULT_CONTINUATION_LENGTH = 500;

export interface WritingLengthTarget {
    target: number;
    min: number;
    max: number;
    source: 'request' | 'explicit' | 'novel' | 'default';
}

export function normalizeWritingLength(value: unknown, fallback = DEFAULT_CHAPTER_LENGTH): number {
    const number = Number(value);
    return Number.isFinite(number) && number >= 100 ? Math.min(50000, Math.round(number)) : fallback;
}

export function novelChapterLength(formatting: string | null | undefined): number | undefined {
    try {
        const value = JSON.parse(formatting || '{}')?.writing?.chapterTargetLength;
        return Number.isFinite(Number(value)) && Number(value) >= 100
            ? normalizeWritingLength(value) : undefined;
    } catch { return undefined; }
}

function parseLengthNumber(raw: string): number {
    if (/^[\d.]+[k千]$/i.test(raw)) return Number(raw.slice(0, -1)) * 1000;
    if (/^[\d.]+万$/.test(raw)) return Number(raw.slice(0, -1)) * 10000;
    if (/^\d+$/.test(raw)) return Number(raw);
    const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
    let total = 0, section = 0, digit = 0;
    for (const char of raw) {
        if (char in digits) digit = digits[char];
        else if (char === '万') { total += (section + digit || 1) * 10000; section = 0; digit = 0; }
        else if (char in units) { section += (digit || 1) * units[char]; digit = 0; }
        else return NaN;
    }
    return total + section + digit;
}

export function resolveWritingLength(input: {
    userIntent?: string; targetLength?: number; mode?: string; novelDefault?: number;
}): WritingLengthTarget {
    const request = (input.userIntent || '').split('会话背景（仅用于理解当前任务）', 1)[0];
    const number = '(?:\\d+(?:\\.\\d+)?[kK千万]?|[零一二两三四五六七八九十百千万]+)';
    const expression = new RegExp(`(${number})\\s*(?:[—–~～至到-]\\s*(${number}))?\\s*(?:个)?(?:汉字|中文字|字|words\\b)`, 'gi');
    const matches = [...request.matchAll(expression)].filter(match => {
        // Historical measurements and requested increments are not final targets.
        const prefix = request.slice(Math.max(0, (match.index || 0) - 12), match.index);
        return !/(?:实测|当前仅|现有|增加|减少|补充|删去|删减|扩充)(?:约|了|仅|只有)?\s*$/.test(prefix);
    });
    for (const match of matches.reverse()) {
        const min = parseLengthNumber(match[1]);
        const max = match[2] ? parseLengthNumber(match[2]) : min;
        if (min >= 100 && max >= min && max <= 50000) {
            const target = Math.round((min + max) / 2);
            return { target, min: match[2] ? min : Math.ceil(target * 0.9), max: match[2] ? max : Math.floor(target * 1.1), source: 'request' };
        }
    }
    const completeChapter = input.mode === 'new_chapter' || input.mode === 'rewrite_chapter'
        || /整章|完整.{0,8}(?:章节|正文)|(?:章节|正文).{0,8}完整|首章|完整替换|complete chapter|full chapter/i.test(request);
    const explicit = Number(input.targetLength) >= 100;
    const hasNovelDefault = completeChapter && Number(input.novelDefault) >= 100;
    const target = normalizeWritingLength(explicit ? input.targetLength : hasNovelDefault ? input.novelDefault
        : completeChapter ? DEFAULT_CHAPTER_LENGTH : DEFAULT_CONTINUATION_LENGTH);
    return { target, min: Math.ceil(target * 0.9), max: Math.floor(target * 1.1), source: explicit ? 'explicit' : hasNovelDefault ? 'novel' : 'default' };
}

export function countWritingUnits(text: string, locale = 'zh-CN'): number {
    return /^zh/i.test(locale) ? (text.match(/\p{Script=Han}/gu) || []).length
        : (text.trim().match(/\S+/gu) || []).length;
}
