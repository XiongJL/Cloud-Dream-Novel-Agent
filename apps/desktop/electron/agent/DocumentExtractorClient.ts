import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentAttachmentBlock, ExtractedDocument } from '../../shared/agentAttachment';

const PROTOCOL_VERSION = 'document-extractor-v1';
const EXTRACTOR_VERSION = '1.0.0';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CHARACTERS = 2_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.docx', '.pdf']);

const MIME_TYPES: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf': 'application/pdf',
};

type ExtractorEnvelope = {
    protocolVersion: string;
    jobId: string;
    ok: boolean;
    document?: ExtractedDocument;
    error?: { code?: string; message?: string };
};

export class DocumentExtractorError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'DocumentExtractorError';
        this.code = code;
    }
}

function isValidBlock(block: unknown, plainText: string): block is AgentAttachmentBlock {
    if (!block || typeof block !== 'object') return false;
    const value = block as Partial<AgentAttachmentBlock>;
    return typeof value.blockId === 'string'
        && ['heading', 'paragraph', 'list_item', 'table', 'page_break'].includes(String(value.type))
        && typeof value.text === 'string'
        && Number.isInteger(value.startOffset)
        && Number.isInteger(value.endOffset)
        && Number(value.startOffset) >= 0
        && Number(value.endOffset) >= Number(value.startOffset)
        && Number(value.endOffset) <= plainText.length
        && plainText.slice(Number(value.startOffset), Number(value.endOffset)) === value.text;
}

function validateDocument(value: unknown): ExtractedDocument {
    if (!value || typeof value !== 'object') {
        throw new DocumentExtractorError('EXTRACTOR_PROTOCOL_ERROR', 'Extractor returned no document');
    }
    const document = value as Partial<ExtractedDocument>;
    if (typeof document.plainText !== 'string' || !document.plainText.trim()) {
        throw new DocumentExtractorError('EMPTY_DOCUMENT', 'The document contains no readable text');
    }
    if (document.plainText.length > MAX_CHARACTERS || !Array.isArray(document.blocks)) {
        throw new DocumentExtractorError('EXTRACTOR_PROTOCOL_ERROR', 'Extractor returned invalid document content');
    }
    if (!document.blocks.every((block) => isValidBlock(block, document.plainText as string))) {
        throw new DocumentExtractorError('EXTRACTOR_PROTOCOL_ERROR', 'Extractor returned invalid block offsets');
    }
    const metadata = document.metadata && typeof document.metadata === 'object' ? document.metadata : { warnings: [] };
    return {
        ...(typeof document.title === 'string' && document.title.trim() ? { title: document.title.trim() } : {}),
        plainText: document.plainText,
        blocks: document.blocks,
        metadata: {
            ...(typeof metadata.pageCount === 'number' ? { pageCount: metadata.pageCount } : {}),
            ...(typeof metadata.author === 'string' ? { author: metadata.author } : {}),
            ...(typeof metadata.language === 'string' ? { language: metadata.language } : {}),
            ...(typeof metadata.encoding === 'string' ? { encoding: metadata.encoding } : {}),
            warnings: Array.isArray(metadata.warnings)
                ? metadata.warnings.filter((warning) => (
                    warning && typeof warning.code === 'string' && typeof warning.message === 'string'
                ))
                : [],
        },
    };
}

function resolveDevRuntimeRoot(): string {
    return path.resolve(app.getAppPath(), '..', '..', 'agent_runtime');
}

function assertFileSignature(extension: string, bytes: Buffer): void {
    if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new DocumentExtractorError('UNSUPPORTED_FILE_TYPE', '文件内容不是有效的 PDF。');
    }
    if (extension === '.docx' && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
        throw new DocumentExtractorError('UNSUPPORTED_FILE_TYPE', '文件内容不是有效的 DOCX。');
    }
}

function resolveCommand(): { command: string; args: string[]; cwd: string } {
    if (app.isPackaged) {
        const binary = process.platform === 'win32' ? 'document-extractor.exe' : 'document-extractor';
        const cwd = path.join(process.resourcesPath, 'agent-runtime', 'document-extractor');
        return { command: path.join(cwd, binary), args: [], cwd };
    }
    const runtimeRoot = resolveDevRuntimeRoot();
    const explicit = process.env.NOVEL_DOCUMENT_EXTRACTOR_PYTHON;
    const venvPython = path.join(runtimeRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    return {
        command: explicit || venvPython,
        args: ['-m', 'document_extractor'],
        cwd: runtimeRoot,
    };
}

export type ExtractedFileResult = {
    originalFileName: string;
    extension: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    extractorVersion: string;
    document: ExtractedDocument;
};

export class DocumentExtractorClient {
    async extractFile(sourcePath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ExtractedFileResult> {
        const extension = path.extname(sourcePath).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(extension)) {
            throw new DocumentExtractorError('UNSUPPORTED_FILE_TYPE', '仅支持 TXT、Markdown、DOCX 和文本型 PDF。');
        }
        const stat = await fs.stat(sourcePath).catch(() => null);
        if (!stat?.isFile()) throw new DocumentExtractorError('FILE_READ_FAILED', '无法读取所选文件。');
        if (stat.size > MAX_FILE_BYTES) throw new DocumentExtractorError('FILE_TOO_LARGE', '文件不能超过 50 MiB。');

        const taskDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'cloud-dream-document-'));
        const temporaryPath = path.join(taskDir, `input${extension}`);
        const jobId = randomUUID();
        try {
            await fs.copyFile(sourcePath, temporaryPath);
            const bytes = await fs.readFile(temporaryPath);
            assertFileSignature(extension, bytes);
            const contentHash = createHash('sha256').update(bytes).digest('hex');
            const request = {
                protocolVersion: PROTOCOL_VERSION,
                jobId,
                temporaryFilePath: temporaryPath,
                originalFileName: path.basename(sourcePath),
                extension,
                mimeType: MIME_TYPES[extension],
                limits: { maxCharacters: MAX_CHARACTERS, timeoutMs },
            };
            const envelope = await this.invoke(request, timeoutMs);
            if (!envelope.ok) {
                throw new DocumentExtractorError(
                    envelope.error?.code || 'TEXT_EXTRACTION_FAILED',
                    envelope.error?.message || '文档内容提取失败。',
                );
            }
            return {
                originalFileName: path.basename(sourcePath),
                extension,
                mimeType: MIME_TYPES[extension],
                sizeBytes: stat.size,
                contentHash,
                extractorVersion: EXTRACTOR_VERSION,
                document: validateDocument(envelope.document),
            };
        } finally {
            await fs.rm(taskDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    private invoke(request: Record<string, unknown>, timeoutMs: number): Promise<ExtractorEnvelope> {
        const command = resolveCommand();
        return new Promise((resolve, reject) => {
            const child = spawn(command.command, command.args, {
                cwd: command.cwd,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const stdout: Buffer[] = [];
            let stdoutBytes = 0;
            let settled = false;
            const finish = (callback: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };
            const timer = setTimeout(() => {
                child.kill();
                finish(() => reject(new DocumentExtractorError('EXTRACTOR_TIMEOUT', '文档读取超时。')));
            }, timeoutMs);
            child.stdout.on('data', (chunk: Buffer) => {
                stdoutBytes += chunk.length;
                if (stdoutBytes > MAX_STDOUT_BYTES) {
                    child.kill();
                    finish(() => reject(new DocumentExtractorError('EXTRACTOR_PROTOCOL_ERROR', '提取结果超过安全限制。')));
                    return;
                }
                stdout.push(chunk);
            });
            child.stderr.resume();
            child.on('error', () => finish(() => reject(
                new DocumentExtractorError('EXTRACTOR_UNAVAILABLE', '文档提取组件不可用。'),
            )));
            child.on('close', () => finish(() => {
                try {
                    const envelope = JSON.parse(Buffer.concat(stdout).toString('utf8')) as ExtractorEnvelope;
                    if (envelope.protocolVersion !== PROTOCOL_VERSION || envelope.jobId !== request.jobId) {
                        throw new Error('Protocol mismatch');
                    }
                    resolve(envelope);
                } catch {
                    reject(new DocumentExtractorError('EXTRACTOR_PROTOCOL_ERROR', '文档提取组件返回了无效结果。'));
                }
            }));
            child.stdin.end(JSON.stringify(request));
        });
    }
}
