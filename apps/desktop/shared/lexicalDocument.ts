type LexicalNode = {
    type?: string;
    text?: string;
    children?: LexicalNode[];
    [key: string]: unknown;
};

type LexicalDocument = {
    root: LexicalNode;
    [key: string]: unknown;
};

function findJsonObjectEnd(value: string): number {
    if (!value.startsWith('{')) return -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
        } else if (character === '{') {
            depth += 1;
        } else if (character === '}') {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
    }
    return -1;
}

function parseLexicalPrefix(value: string): { document: LexicalDocument | null; trailingText: string } {
    const normalized = value.trim();
    const jsonEnd = findJsonObjectEnd(normalized);
    if (jsonEnd < 0) return { document: null, trailingText: normalized };

    try {
        const parsed = JSON.parse(normalized.slice(0, jsonEnd)) as Partial<LexicalDocument>;
        if (!parsed.root || typeof parsed.root !== 'object') {
            return { document: null, trailingText: normalized };
        }
        return {
            document: parsed as LexicalDocument,
            trailingText: normalized.slice(jsonEnd).trim(),
        };
    } catch {
        return { document: null, trailingText: normalized };
    }
}

function nodeText(node: LexicalNode): string {
    if (node.type === 'linebreak') return '\n';
    if (typeof node.text === 'string') return node.text;
    if (!Array.isArray(node.children)) return '';

    const content = node.children.map(nodeText).join('');
    if (['paragraph', 'heading', 'quote', 'listitem'].includes(node.type ?? '')) {
        return `${content}\n`;
    }
    return content;
}

function normalizeReadableText(value: string): string {
    return value
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesChapterHeading(line: string, chapterTitle: string): boolean {
    const trimmedLine = line.trim();
    const trimmedTitle = chapterTitle.trim();
    if (!trimmedLine || !trimmedTitle) return false;
    if (trimmedLine === trimmedTitle) return true;
    const escapedTitle = escapeRegExp(trimmedTitle);
    const headingPattern = new RegExp(
        `^第\\s*[0-9一二三四五六七八九十百千万零〇两]+\\s*[章节卷回幕部篇]\\s*[:：、\\-—\\s]*${escapedTitle}$`,
        'u',
    );
    return headingPattern.test(trimmedLine);
}

export function normalizeChapterDraftText(content: string, chapterTitle?: string): string {
    const normalized = String(content || '').replace(/\r\n/g, '\n').trim();
    const trimmedTitle = String(chapterTitle || '').trim();
    if (!normalized || !trimmedTitle) return normalized;

    const lines = normalized.split('\n');
    let index = 0;
    while (index < lines.length && !lines[index].trim()) index += 1;
    if (index >= lines.length) return '';

    if (matchesChapterHeading(lines[index], trimmedTitle)) {
        index += 1;
        while (index < lines.length && !lines[index].trim()) index += 1;
        return lines.slice(index).join('\n').trim();
    }
    return normalized;
}

export function extractReadableText(content: string): string {
    if (!content?.trim()) return '';
    const { document, trailingText } = parseLexicalPrefix(content);
    if (!document) return normalizeReadableText(trailingText);

    const lexicalText = normalizeReadableText(nodeText(document.root));
    return [lexicalText, normalizeReadableText(trailingText)].filter(Boolean).join('\n\n');
}

function comparableReadableText(value: string): string {
    return value.normalize('NFKC').replace(/\s+/gu, '');
}

function logicalParagraphCount(value: string): number {
    return value.split(/\r?\n/u).filter((line) => line.trim()).length;
}

/**
 * Restores paragraph boundaries from an authoritative structured source without
 * changing the snapshot's words. Older rewrite drafts flattened Lexical blocks
 * into spaces before storing baseContent; this keeps those drafts reviewable
 * while refusing to substitute content that has since changed.
 */
export function restoreReadableTextStructure(snapshotContent: string, structuredSource: string): string {
    const snapshotText = extractReadableText(snapshotContent);
    const structuredText = extractReadableText(structuredSource);
    if (!snapshotText || !structuredText) return snapshotText;
    if (comparableReadableText(snapshotText) !== comparableReadableText(structuredText)) return snapshotText;
    return logicalParagraphCount(structuredText) > logicalParagraphCount(snapshotText)
        ? structuredText
        : snapshotText;
}

function createTextNode(text: string): LexicalNode {
    return {
        detail: 0,
        format: 0,
        mode: 'normal',
        style: '',
        text,
        type: 'text',
        version: 1,
    };
}

function createParagraphNode(text: string): LexicalNode {
    const lines = text.split('\n');
    const children: LexicalNode[] = [];
    lines.forEach((line, index) => {
        if (line) children.push(createTextNode(line));
        if (index < lines.length - 1) children.push({ type: 'linebreak', version: 1 });
    });
    return {
        children,
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
        textFormat: 0,
        textStyle: '',
    };
}

function paragraphsFromText(value: string): LexicalNode[] {
    return normalizeReadableText(value)
        .split(/\n{2,}/)
        .filter(Boolean)
        .map(createParagraphNode);
}

export function appendPlainTextToLexical(baseContent: string, generatedText: string): string {
    const generated = normalizeReadableText(generatedText);
    const { document, trailingText } = parseLexicalPrefix(baseContent);
    if (!document) {
        return [normalizeReadableText(baseContent), generated].filter(Boolean).join('\n\n');
    }

    const next = JSON.parse(JSON.stringify(document)) as LexicalDocument;
    if (!Array.isArray(next.root.children)) next.root.children = [];
    next.root.children.push(...paragraphsFromText(trailingText), ...paragraphsFromText(generated));
    return JSON.stringify(next);
}

export function createLexicalDocumentFromPlainText(content: string): string {
    const document: LexicalDocument = {
        root: {
            children: paragraphsFromText(content),
            direction: null,
            format: '',
            indent: 0,
            type: 'root',
            version: 1,
        },
    };
    return JSON.stringify(document);
}

export function ensureLexicalDocument(content: string): string {
    const { document, trailingText } = parseLexicalPrefix(content);
    if (!document) return createLexicalDocumentFromPlainText(trailingText);
    if (!trailingText) return JSON.stringify(document);
    return appendPlainTextToLexical(JSON.stringify(document), trailingText);
}
