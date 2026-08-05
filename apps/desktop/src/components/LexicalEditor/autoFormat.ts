const HORIZONTAL_WHITESPACE = '[ \\t\\u00a0\\u3000]';
const CJK_CHARACTER = '[\\u3400-\\u9fff]';

export function trimParagraphStart(text: string): string {
    return text.replace(new RegExp(`^${HORIZONTAL_WHITESPACE}+`, 'u'), '');
}

export function trimParagraphEnd(text: string): string {
    return text.replace(new RegExp(`${HORIZONTAL_WHITESPACE}+$`, 'u'), '');
}

export function isBlankParagraph(text: string): boolean {
    return text.trim().length === 0;
}

/**
 * Normalizes one text-node segment without trimming its outer spaces. Paragraph
 * boundaries are handled separately so spaces between differently styled nodes
 * are not lost.
 */
export function formatTextContent(text: string, language: string, capitalizeStart = false): string {
    const horizontalWhitespace = new RegExp(`${HORIZONTAL_WHITESPACE}{2,}`, 'gu');
    let result = text
        .replace(horizontalWhitespace, ' ')
        .replace(new RegExp(`${HORIZONTAL_WHITESPACE}+(?=\\n)`, 'gu'), '')
        .replace(new RegExp(`\\n${HORIZONTAL_WHITESPACE}+`, 'gu'), '\n')
        .replace(/\n{2,}/g, '\n');

    if (language.toLowerCase().startsWith('zh')) {
        result = result
            .replace(new RegExp(`,(?=${HORIZONTAL_WHITESPACE}*${CJK_CHARACTER})`, 'gu'), '，')
            .replace(new RegExp(`(${CJK_CHARACTER})${HORIZONTAL_WHITESPACE}*,`, 'gu'), '$1，')
            .replace(/\.{3,}/g, '……')
            .replace(new RegExp(`\\.(?=${HORIZONTAL_WHITESPACE}*${CJK_CHARACTER})`, 'gu'), '。')
            .replace(new RegExp(`(${CJK_CHARACTER})\\.(?!\\d)`, 'gu'), '$1。')
            .replace(/。{2,}/g, '……')
            .replace(new RegExp(`\\?(?=${HORIZONTAL_WHITESPACE}*${CJK_CHARACTER})`, 'gu'), '？')
            .replace(new RegExp(`(${CJK_CHARACTER})\\?`, 'gu'), '$1？')
            .replace(new RegExp(`!(?=${HORIZONTAL_WHITESPACE}*${CJK_CHARACTER})`, 'gu'), '！')
            .replace(new RegExp(`(${CJK_CHARACTER})!`, 'gu'), '$1！')
            .replace(new RegExp(`:(?=${HORIZONTAL_WHITESPACE}*${CJK_CHARACTER})`, 'gu'), '：')
            .replace(new RegExp(`(${CJK_CHARACTER}):`, 'gu'), '$1：')
            .replace(new RegExp(`;(?=${HORIZONTAL_WHITESPACE}*${CJK_CHARACTER})`, 'gu'), '；')
            .replace(new RegExp(`(${CJK_CHARACTER});`, 'gu'), '$1；')
            .replace(new RegExp(`${HORIZONTAL_WHITESPACE}+([，。？！：；、])`, 'gu'), '$1')
            .replace(new RegExp(`([，。？！：；、])${HORIZONTAL_WHITESPACE}+`, 'gu'), '$1');
    } else {
        result = result
            .replace(/，/g, ', ')
            .replace(/。/g, '. ')
            .replace(/……/g, '...')
            .replace(/？/g, '? ')
            .replace(/！/g, '! ')
            .replace(/：/g, ': ')
            .replace(/；/g, '; ')
            .replace(horizontalWhitespace, ' ');
    }

    result = result
        .replace(/，{2,}/g, '，')
        .replace(/。{2,}/g, '。')
        .replace(/？{2,}/g, '？')
        .replace(/！{2,}/g, '！')
        .replace(/,{2,}/g, ',')
        .replace(/\.{4,}/g, '...')
        .replace(/\?{2,}/g, '?')
        .replace(/!{2,}/g, '!')
        .replace(/([.?!。？！][ \\t]*)([a-z])/g, (_match, prefix: string, letter: string) => (
            prefix + letter.toUpperCase()
        ))
        .replace(/(\n[ \\t]*)([a-z])/g, (_match, prefix: string, letter: string) => (
            prefix + letter.toUpperCase()
        ));

    if (capitalizeStart) {
        result = result.replace(/^([ \\t]*)([a-z])/, (_match, prefix: string, letter: string) => (
            prefix + letter.toUpperCase()
        ));
    }

    return result;
}
