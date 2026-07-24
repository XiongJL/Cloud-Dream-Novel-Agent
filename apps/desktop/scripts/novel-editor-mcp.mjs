#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const APP_VERSION = '0.1.8';
const LOG_FILE = process.env.NOVEL_EDITOR_MCP_LOG_FILE || '';
const LOG_ENABLED = process.env.NOVEL_EDITOR_MCP_VERBOSE === '1' && Boolean(LOG_FILE);
const HTTP_INVOKE_TIMEOUT_MS = 95_000;

const TOOL_DEFS = [
  { name: 'novel.list', description: '列出小说。', inputSchema: { type: 'object', properties: {} } },
  { name: 'volume.list', description: '列出卷和章节概要。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' } }, required: ['novelId'] } },
  { name: 'chapter.list', description: '列出卷下章节。', inputSchema: { type: 'object', properties: { volumeId: { type: 'string' } }, required: ['volumeId'] } },
  { name: 'chapter.get', description: '读取章节内容。', inputSchema: { type: 'object', properties: { chapterId: { type: 'string' } }, required: ['chapterId'] } },
  { name: 'chapter.create', description: '创建章节。', inputSchema: { type: 'object', properties: { volumeId: { type: 'string' }, title: { type: 'string' }, order: { type: 'number' } }, required: ['volumeId'] } },
  { name: 'chapter.save', description: '保存章节内容。', inputSchema: { type: 'object', properties: { chapterId: { type: 'string' }, content: { type: 'string' }, source: { type: 'string' } }, required: ['chapterId', 'content'] } },
  { name: 'plotline.list', description: '列出主线和要点。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' } }, required: ['novelId'] } },
  { name: 'character.list', description: '列出角色。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' } }, required: ['novelId'] } },
  { name: 'item.list', description: '列出物品和技能。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' } }, required: ['novelId'] } },
  { name: 'worldsetting.list', description: '列出世界设定。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' } }, required: ['novelId'] } },
  { name: 'worldsetting.create', description: '创建世界设定（仅新增，不含删除）。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' }, type: { type: 'string' }, icon: { type: 'string' }, sortOrder: { type: 'number' } }, required: ['novelId', 'name'] } },
  { name: 'worldsetting.update', description: '更新世界设定（仅修改，不含删除）。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' }, type: { type: 'string' }, icon: { type: 'string' }, sortOrder: { type: 'number' } }, required: ['id'] } },
  { name: 'map.list', description: '列出地图。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' } }, required: ['novelId'] } },
  { name: 'search.query', description: '全文搜索。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, keyword: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['novelId', 'keyword'] } },
  { name: 'creative_assets.generate_draft', description: '调用软件内置 AI 生成创意草稿，结果同时进入右侧草稿区和 MCP JSON。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, brief: { type: 'string' }, locale: { type: 'string' }, overrideUserPrompt: { type: 'string' }, targetSections: { type: 'array', items: { type: 'string' } }, contextChapterCount: { type: 'number' }, includeExistingEntities: { type: 'boolean' }, filterCompletedPlotLines: { type: 'boolean' } }, required: ['novelId', 'brief'] } },
  { name: 'outline.generate_draft', description: '调用软件内置 AI 生成大纲草稿。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, brief: { type: 'string' }, locale: { type: 'string' } }, required: ['novelId', 'brief'] } },
  { name: 'chapter.generate_draft', description: '调用软件内置 AI 生成章节草稿。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, chapterId: { type: 'string' }, currentContent: { type: 'string' }, locale: { type: 'string' }, ideaIds: { type: 'array', items: { type: 'string' } }, contextChapterCount: { type: 'number' }, targetLength: { type: 'number' }, userIntent: { type: 'string' }, currentLocation: { type: 'string' }, overrideUserPrompt: { type: 'string' } }, required: ['novelId', 'chapterId', 'currentContent'] } },
  { name: 'creative_assets.validate_draft', description: '校验创意草稿会话。', inputSchema: { type: 'object', properties: { draftSessionId: { type: 'string' }, version: { type: 'number' } }, required: ['draftSessionId'] } },
  { name: 'draft.list', description: '列出草稿会话。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, workspace: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' }, includeInactive: { type: 'boolean' } } } },
  { name: 'draft.get', description: '读取单个草稿会话。', inputSchema: { type: 'object', properties: { draftSessionId: { type: 'string' } }, required: ['draftSessionId'] } },
  { name: 'draft.get_active', description: '读取当前小说正在编辑的活跃草稿。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, workspace: { type: 'string' }, type: { type: 'string' } }, required: ['novelId'] } },
  { name: 'draft.update', description: '更新草稿内容或勾选状态。', inputSchema: { type: 'object', properties: { draftSessionId: { type: 'string' }, version: { type: 'number' }, payload: { type: 'object' }, selection: { type: 'object' } }, required: ['draftSessionId', 'version'] } },
  { name: 'draft.commit', description: '提交草稿入库。', inputSchema: { type: 'object', properties: { draftSessionId: { type: 'string' }, version: { type: 'number' } }, required: ['draftSessionId', 'version'] } },
  { name: 'draft.discard', description: '丢弃草稿。', inputSchema: { type: 'object', properties: { draftSessionId: { type: 'string' }, version: { type: 'number' } }, required: ['draftSessionId', 'version'] } },
  { name: 'outline.write', description: '将外部生成的大纲直接写入软件。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, plotLines: { type: 'array', items: { type: 'object' } }, plotPoints: { type: 'array', items: { type: 'object' } } }, required: ['novelId'] } },
  { name: 'character.create_batch', description: '将外部生成的角色、物品、技能批量写入软件。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, characters: { type: 'array', items: { type: 'object' } }, items: { type: 'array', items: { type: 'object' } }, skills: { type: 'array', items: { type: 'object' } } }, required: ['novelId'] } },
  { name: 'story_patch.apply', description: '将外部生成的结构化剧情补丁写入软件。', inputSchema: { type: 'object', properties: { novelId: { type: 'string' }, draft: { type: 'object' } }, required: ['novelId', 'draft'] } },
  { name: 'prompt.preview', description: '预览软件内置提示词。', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['creative_assets', 'chapter'] }, payload: { type: 'object' } }, required: ['kind', 'payload'] } },
];

const chapterGenerateDraftTool = TOOL_DEFS.find((tool) => tool.name === 'chapter.generate_draft');
if (chapterGenerateDraftTool?.inputSchema?.properties) {
  chapterGenerateDraftTool.inputSchema.properties.presentation = {
    type: 'string',
    enum: ['silent', 'toast', 'modal'],
  };
}

function getAppDataPath() {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return path.join(os.homedir(), '.config');
}

function resolveRuntimeCandidates() {
  if (process.env.NOVEL_EDITOR_RUNTIME_FILE) {
    return [process.env.NOVEL_EDITOR_RUNTIME_FILE];
  }
  const appData = getAppDataPath();
  const explicitUserData = process.env.NOVEL_EDITOR_USER_DATA;
  const candidates = [];
  if (explicitUserData) {
    candidates.push(path.join(explicitUserData, 'automation', 'runtime.json'));
  }
  candidates.push(path.join(appData, '云梦小说智能体', 'automation', 'runtime.json'));
  candidates.push(path.join(appData, '云梦小说编辑器', 'automation', 'runtime.json'));
  candidates.push(path.join(appData, '@novel-editor', 'desktop-dev', 'automation', 'runtime.json'));
  return candidates;
}

function findRuntimeFile() {
  const existing = resolveRuntimeCandidates()
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return existing[0]?.candidate ?? null;
}

function readRuntime() {
  const runtimeFile = findRuntimeFile();
  if (!runtimeFile) {
    throw Object.assign(new Error('桌面应用未运行，或 automation runtime 文件不存在。'), { code: 'APP_NOT_RUNNING' });
  }
  return JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
}

async function invokeDesktop(method, params) {
  const runtime = readRuntime();
  const requestId = randomUUID();
  const startedAt = Date.now();
  debugLog('invoke-start', JSON.stringify({
    requestId,
    method,
    paramKeys: params && typeof params === 'object' ? Object.keys(params) : [],
    port: runtime.port,
    timeoutMs: HTTP_INVOKE_TIMEOUT_MS,
  }));
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/invoke`, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_INVOKE_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runtime.token}`,
      },
      body: JSON.stringify({
        requestId,
        method,
        params,
        origin: 'mcp-bridge',
      }),
    });
    const payload = await response.json();
    if (!payload.ok) {
      debugLog('invoke-error', JSON.stringify({
        requestId,
        method,
        elapsedMs: Date.now() - startedAt,
        code: payload.code || 'INTERNAL_ERROR',
        message: payload.message || 'Automation invoke failed',
      }));
      const error = new Error(payload.message || 'Automation invoke failed');
      error.code = payload.code || 'INTERNAL_ERROR';
      error.details = payload.data;
      throw error;
    }
    debugLog('invoke-success', JSON.stringify({
      requestId,
      method,
      elapsedMs: Date.now() - startedAt,
      hasData: payload.data !== undefined,
      dataKeys: payload.data && typeof payload.data === 'object' ? Object.keys(payload.data) : [],
    }));
    return payload.data;
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      debugLog('invoke-timeout', JSON.stringify({
        requestId,
        method,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: HTTP_INVOKE_TIMEOUT_MS,
      }));
      const timeoutError = new Error(`Automation invoke timed out after ${HTTP_INVOKE_TIMEOUT_MS}ms`);
      timeoutError.code = 'UPSTREAM_TIMEOUT';
      throw timeoutError;
    }
    debugLog('invoke-failure', JSON.stringify({
      requestId,
      method,
      elapsedMs: Date.now() - startedAt,
      name: error?.name || 'Error',
      message: error?.message || String(error),
      cause: error?.cause?.message || null,
    }));
    throw error;
  }
}

let buffer = Buffer.alloc(0);
let loggedInputPreview = false;
let outputMode = 'content-length';
let logQueue = [];
let logFlushScheduled = false;
let logDirectoryReady = false;

function debugLog(...parts) {
  if (!LOG_ENABLED) return;
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  logQueue.push(line);
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  setImmediate(() => {
    logFlushScheduled = false;
    if (logQueue.length === 0) return;
    const payload = logQueue.join('');
    logQueue = [];
    try {
      if (!logDirectoryReady) {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        logDirectoryReady = true;
      }
    } catch {}
    fs.appendFile(LOG_FILE, payload, 'utf8', () => {});
  });
}

function logInputPreview(chunk) {
  if (loggedInputPreview || !LOG_FILE) return;
  loggedInputPreview = true;
  const hexPreview = chunk.subarray(0, 96).toString('hex');
  const utf8Preview = chunk.subarray(0, 160).toString('utf8').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const utf16Preview = chunk.subarray(0, 160).toString('utf16le').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  debugLog('stdin-preview', JSON.stringify({ hexPreview, utf8Preview, utf16Preview }));
}

function summarizeBuffer(sourceBuffer) {
  return {
    bytes: sourceBuffer.length,
    hexPreview: sourceBuffer.subarray(0, Math.min(sourceBuffer.length, 96)).toString('hex'),
    utf8Preview: sourceBuffer
      .subarray(0, Math.min(sourceBuffer.length, 160))
      .toString('utf8')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n'),
  };
}

function findSeparator(sourceBuffer) {
  const separators = [
    { marker: Buffer.from('\r\n\r\n', 'utf8'), encoding: 'utf8', separatorLength: 4 },
    { marker: Buffer.from('\n\n', 'utf8'), encoding: 'utf8', separatorLength: 2 },
    { marker: Buffer.from('\r\n\r\n', 'utf16le'), encoding: 'utf16le', separatorLength: 8 },
    { marker: Buffer.from('\n\n', 'utf16le'), encoding: 'utf16le', separatorLength: 4 },
  ];
  for (const separator of separators) {
    const headerEnd = sourceBuffer.indexOf(separator.marker);
    if (headerEnd >= 0) {
      return { ...separator, headerEnd };
    }
  }
  return null;
}

function parseHeaders(headerBuffer, encoding) {
  const headerText = headerBuffer.toString(encoding);
  const lines = headerText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const contentLengthHeader = lines.find((line) => line.toLowerCase().startsWith('content-length:'));
  if (!contentLengthHeader) return null;
  const contentLength = Number(contentLengthHeader.split(':')[1]?.trim() || '0');
  if (!Number.isFinite(contentLength) || contentLength <= 0) return null;
  return { contentLength, headerText };
}

function findJsonObjectBoundary(text) {
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  if (text[index] !== '{') {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
  }

  return null;
}

function tryParseBareJson(sourceBuffer) {
  const utf8Text = sourceBuffer.toString('utf8');
  const boundary = findJsonObjectBoundary(utf8Text);
  if (boundary === null) {
    return null;
  }

  const jsonText = utf8Text.slice(0, boundary);
  const trailingText = utf8Text.slice(boundary);
  const trailingWhitespaceLength = trailingText.match(/^\s*/)?.[0]?.length || 0;
  const consumedText = utf8Text.slice(0, boundary + trailingWhitespaceLength);

  try {
    return {
      message: JSON.parse(jsonText),
      bytesConsumed: Buffer.byteLength(consumedText, 'utf8'),
    };
  } catch (error) {
    debugLog('frame-bare-json-parse-error', JSON.stringify({
      ...summarizeBuffer(sourceBuffer),
      boundary,
      message: error?.message || String(error),
    }));
    return null;
  }
}

function toStructuredContent(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return { items: data };
  }
  return { value: data };
}

function stringifyToolPayload(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return JSON.stringify({ value: String(data) });
  }
}

function summarizeToolResult(toolName, data) {
  if (Array.isArray(data)) {
    return `${toolName} ok (${data.length} items)`;
  }
  if (data && typeof data === 'object') {
    if (typeof data.previewSummary === 'string' && data.previewSummary) {
      return `${toolName} ok: ${data.previewSummary}`;
    }
    if (typeof data.draftSessionId === 'string' && data.draftSessionId) {
      return `${toolName} ok: draftSessionId=${data.draftSessionId}`;
    }
    const keys = Object.keys(data);
    if (keys.length === 0) {
      return `${toolName} ok`;
    }
    return `${toolName} ok: ${keys.slice(0, 6).join(', ')}`;
  }
  if (typeof data === 'string' && data) {
    return `${toolName} ok: ${data}`;
  }
  return `${toolName} ok`;
}

function sendMessage(message) {
  const json = JSON.stringify(message);
  debugLog('send', JSON.stringify({
    id: message.id ?? null,
    method: message.method ?? null,
    hasResult: Object.prototype.hasOwnProperty.call(message, 'result'),
    hasError: Object.prototype.hasOwnProperty.call(message, 'error'),
    outputMode,
  }));
  if (outputMode === 'bare-json') {
    process.stdout.write(json);
    process.stdout.write('\n');
    return;
  }
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
  process.stdout.write(header);
  process.stdout.write(json);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  debugLog('recv', JSON.stringify({
    id: id ?? null,
    method: method ?? null,
    keys: params && typeof params === 'object' ? Object.keys(params) : [],
    toolName: method === 'tools/call' ? params?.name ?? null : null,
  }));
  if (method === 'notifications/initialized') {
    return;
  }
  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'novel-editor-mcp',
        version: APP_VERSION,
      },
    });
    return;
  }
  if (method === 'ping') {
    sendResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: TOOL_DEFS });
    return;
  }
  if (method === 'resources/list') {
    sendResult(id, { resources: [] });
    return;
  }
  if (method === 'resources/templates/list') {
    sendResult(id, { resourceTemplates: [] });
    return;
  }
  if (method === 'tools/call') {
    try {
      const data = await invokeDesktop(params?.name, params?.arguments || {});
      const structuredContent = toStructuredContent(data);
      const contentText = summarizeToolResult(params?.name ?? 'tool', data);
      debugLog('tool-result', JSON.stringify({
        toolName: params?.name ?? null,
        contentTextBytes: Buffer.byteLength(contentText, 'utf8'),
        structuredContentBytes: Buffer.byteLength(stringifyToolPayload(structuredContent), 'utf8'),
      }));
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: contentText,
          },
        ],
        structuredContent,
      });
    } catch (error) {
      debugLog('tool-error-result', JSON.stringify({
        toolName: params?.name ?? null,
        code: error.code || 'INTERNAL_ERROR',
        message: error.message || 'Automation invoke failed',
      }));
      sendResult(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: error.code || 'INTERNAL_ERROR',
              message: error.message || 'Automation invoke failed',
              details: error.details,
            }, null, 2),
          },
        ],
      });
    }
    return;
  }
  sendError(id, -32601, `Method not found: ${method}`);
}

function pumpBuffer() {
  while (true) {
    const separator = findSeparator(buffer);
    if (!separator) {
      const bareJson = tryParseBareJson(buffer);
      if (!bareJson) {
        if (buffer.length > 0) {
          debugLog('frame-pending', JSON.stringify(summarizeBuffer(buffer)));
        }
        return;
      }
      buffer = buffer.slice(bareJson.bytesConsumed);
      outputMode = 'bare-json';
      debugLog('frame-bare-json', `bytes=${bareJson.bytesConsumed}`);
      void handleRequest(bareJson.message);
      continue;
    }
    const headerBuffer = buffer.slice(0, separator.headerEnd);
    const parsedHeaders = parseHeaders(headerBuffer, separator.encoding);
    if (!parsedHeaders) {
      debugLog('frame-invalid-headers', JSON.stringify({ encoding: separator.encoding }));
      buffer = Buffer.alloc(0);
      return;
    }
    const multiplier = separator.encoding === 'utf16le' ? 2 : 1;
    const messageStart = separator.headerEnd + separator.separatorLength;
    const messageEnd = messageStart + (parsedHeaders.contentLength * multiplier);
    if (buffer.length < messageEnd) {
      debugLog('frame-incomplete', JSON.stringify({
        encoding: separator.encoding,
        expectedBytes: parsedHeaders.contentLength * multiplier,
        bufferedBytes: buffer.length - messageStart,
      }));
      return;
    }
    const messageText = buffer.slice(messageStart, messageEnd).toString(separator.encoding);
    buffer = buffer.slice(messageEnd);
    outputMode = 'content-length';
    debugLog('frame', JSON.stringify({
      encoding: separator.encoding,
      contentLength: parsedHeaders.contentLength,
    }));
    const message = JSON.parse(messageText);
    void handleRequest(message);
  }
}

debugLog('startup', JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  argv: process.argv,
  runtimeCandidates: resolveRuntimeCandidates(),
}));

process.stdin.on('data', (rawChunk) => {
  try {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk), 'utf8');
    debugLog('stdin', `bytes=${chunk.length} rawType=${typeof rawChunk} ctor=${rawChunk?.constructor?.name || 'unknown'}`);
    buffer = Buffer.concat([buffer, chunk]);
    pumpBuffer();
  } catch (error) {
    debugLog('stdin-handler-error', JSON.stringify({
      message: error?.message || String(error),
      stack: error?.stack || '',
      rawType: typeof rawChunk,
      ctor: rawChunk?.constructor?.name || 'unknown',
      rawLength: rawChunk?.length ?? null,
    }));
  }
});

process.stdin.on('error', (error) => {
  debugLog('stdin-error', JSON.stringify({ message: error.message }));
  console.error('[novel-editor-mcp] stdin error:', error);
});

process.on('uncaughtException', (error) => {
  debugLog('uncaughtException', JSON.stringify({ message: error.message, stack: error.stack }));
});

process.on('unhandledRejection', (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : '';
  debugLog('unhandledRejection', JSON.stringify({ message, stack }));
});
