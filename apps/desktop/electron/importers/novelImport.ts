import fs from 'node:fs/promises';
import path from 'node:path';

export type ImportedChapterDraft = {
  title: string;
  plainText: string;
  lexicalContent: string;
  wordCount: number;
  order: number;
};

export type ImportedVolumeDraft = {
  title: string;
  order: number;
  chapters: ImportedChapterDraft[];
};

export type ImportedNovelStructure = {
  title: string;
  volumes: ImportedVolumeDraft[];
  wordCount: number;
};

const VOLUME_HEADING_RE = /^(第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[卷册部集篇]|[卷册部集篇]\s*[0-9零〇一二两三四五六七八九十百千]+|第\s*[IVXLC]+\s*卷)(?:\s+.+)?$/iu;
const CHAPTER_HEADING_RE = /^(第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[章节回节篇]|chapter\s*\d+|chap\.\s*\d+|序章|楔子|终章|尾声|后记|番外)(?:\s+.+)?$/iu;

function normalizeLineEndings(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function cleanHeading(line: string): string {
  return line.trim().replace(/[\u3000\t ]+/g, ' ');
}

function normalizePlainText(text: string): string {
  return normalizeLineEndings(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function toWordCount(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function deriveNovelTitleFromPath(filePath: string): string {
  const parsed = path.parse(filePath);
  return parsed.name.trim() || '导入作品';
}

async function extractTextFromTxt(filePath: string): Promise<string> {
  return await fs.readFile(filePath, 'utf8');
}

async function extractTextFromDocx(filePath: string): Promise<string> {
  const mammothModule = await import('mammoth');
  const mammoth = mammothModule.default ?? mammothModule;
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

async function extractTextFromPdf(filePath: string): Promise<string> {
  const pdfParseModule = await import('pdf-parse');
  const { PDFParse } = pdfParseModule as unknown as {
    PDFParse: new (options: { data: Buffer }) => { getText: () => Promise<{ text?: string }>; destroy?: () => Promise<void> };
  };
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy?.();
  }
}

async function extractNovelText(filePath: string): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.txt') {
    return await extractTextFromTxt(filePath);
  }
  if (extension === '.docx') {
    return await extractTextFromDocx(filePath);
  }
  if (extension === '.doc') {
    throw new Error('暂不支持旧版 .doc，请先另存为 .docx 后再导入。');
  }
  if (extension === '.pdf') {
    return await extractTextFromPdf(filePath);
  }

  throw new Error(`不支持的文件类型: ${extension || 'unknown'}`);
}

export async function readNovelFileAsStructure(filePath: string): Promise<ImportedNovelStructure> {
  const rawText = await extractNovelText(filePath);
  const normalized = normalizePlainText(rawText);
  if (!normalized) {
    throw new Error('未从文件中提取到可导入文本。');
  }
  return splitNovelTextIntoStructure(normalized, deriveNovelTitleFromPath(filePath));
}

export function buildLexicalContentFromPlainText(text: string): string {
  const normalized = normalizePlainText(text);
  const paragraphs = normalized ? normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean) : [''];

  return JSON.stringify({
    root: {
      type: 'root',
      format: '',
      indent: 0,
      version: 1,
      children: paragraphs.map((paragraph) => ({
        type: 'paragraph',
        format: '',
        indent: 0,
        version: 1,
        direction: 'ltr',
        textFormat: 0,
        textStyle: '',
        children: [{
          type: 'text',
          detail: 0,
          format: 0,
          mode: 'normal',
          style: '',
          text: paragraph,
          version: 1,
        }],
      })),
      direction: 'ltr',
    },
  });
}

type MutableChapter = { title: string; lines: string[] };
type MutableVolume = { title: string; chapters: MutableChapter[] };

function chapterHasContent(chapter: MutableChapter): boolean {
  return normalizePlainText(chapter.lines.join('\n')).length > 0;
}

function chapterIsPlaceholder(chapter: MutableChapter): boolean {
  return chapter.title === '开始' && !chapterHasContent(chapter);
}

function finalizeStructure(title: string, volumes: MutableVolume[]): ImportedNovelStructure {
  const finalizedVolumes = volumes
    .map((volume, volumeIndex) => ({
      title: volume.title || '正文',
      order: volumeIndex + 1,
      chapters: volume.chapters
        .map((chapter, chapterIndex) => {
          const plainText = normalizePlainText(chapter.lines.join('\n'));
          return {
            title: chapter.title || '开始',
            plainText,
            lexicalContent: buildLexicalContentFromPlainText(plainText),
            wordCount: toWordCount(plainText),
            order: chapterIndex + 1,
          };
        })
        .filter((chapter) => chapter.plainText.length > 0 || chapter.title === '开始'),
    }))
    .filter((volume) => volume.chapters.length > 0);

  const safeVolumes = finalizedVolumes.length
    ? finalizedVolumes
    : [{
        title: '正文',
        order: 1,
        chapters: [{
          title: '开始',
          plainText: '',
          lexicalContent: buildLexicalContentFromPlainText(''),
          wordCount: 0,
          order: 1,
        }],
      }];

  return {
    title,
    volumes: safeVolumes,
    wordCount: safeVolumes.reduce((sum, volume) => sum + volume.chapters.reduce((inner, chapter) => inner + chapter.wordCount, 0), 0),
  };
}

export function splitNovelTextIntoStructure(text: string, fallbackTitle: string): ImportedNovelStructure {
  const normalized = normalizeLineEndings(text);
  const lines = normalized.split('\n');
  const volumes: MutableVolume[] = [];
  let currentVolume: MutableVolume = { title: '正文', chapters: [] };
  let currentChapter: MutableChapter = { title: '开始', lines: [] };

  const pushChapter = () => {
    if (chapterIsPlaceholder(currentChapter)) {
      return;
    }
    currentVolume.chapters.push(currentChapter);
  };

  const pushVolume = () => {
    if (!chapterIsPlaceholder(currentChapter)) {
      pushChapter();
    }
    if (currentVolume.chapters.length > 0) {
      volumes.push(currentVolume);
    }
  };

  for (const rawLine of lines) {
    const line = cleanHeading(rawLine);
    if (!line) {
      currentChapter.lines.push('');
      continue;
    }

    if (VOLUME_HEADING_RE.test(line)) {
      pushVolume();
      currentVolume = { title: line, chapters: [] };
      currentChapter = { title: '开始', lines: [] };
      continue;
    }

    if (CHAPTER_HEADING_RE.test(line)) {
      if (!chapterIsPlaceholder(currentChapter)) {
        pushChapter();
      }
      currentChapter = { title: line, lines: [] };
      continue;
    }

    currentChapter.lines.push(rawLine.trimEnd());
  }

  pushVolume();

  const safeTitle = fallbackTitle.trim() || '导入作品';
  return finalizeStructure(safeTitle, volumes);
}
