var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
import { net, app, dialog, ipcMain, nativeImage, BrowserWindow, protocol, session } from "electron";
import { db, initDb, ensureDbSchema } from "@novel-editor/core";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { execSync } from "child_process";
import fs$2 from "fs";
import fs from "node:fs";
import { spawn } from "node:child_process";
import fs$1 from "node:fs/promises";
import path$1 from "path";
import require$$0 from "zlib";
import crypto from "crypto";
const SEARCH_INDEX_REQUIRED_COLUMNS = [
  "content",
  "entity_type",
  "entity_id",
  "novel_id",
  "chapter_id",
  "title",
  "volume_title",
  "chapter_order",
  "volume_order",
  "volume_id"
];
async function createSearchIndexTable() {
  await db.$executeRaw`
        CREATE VIRTUAL TABLE search_index USING fts5(
            content,
            entity_type,
            entity_id UNINDEXED,
            novel_id UNINDEXED,
            chapter_id UNINDEXED,
            title,
            volume_title,
            chapter_order UNINDEXED,
            volume_order UNINDEXED,
            volume_id UNINDEXED,
            tokenize='unicode61'
        );
    `;
}
async function getSearchIndexColumns() {
  const rows = await db.$queryRawUnsafe("PRAGMA table_info(search_index);");
  return rows.map((row) => row.name);
}
async function rebuildAllIndexes() {
  const novels = await db.novel.findMany({
    where: { deleted: false },
    select: { id: true }
  });
  for (const novel of novels) {
    await rebuildIndex(novel.id);
  }
}
async function initSearchIndex() {
  try {
    const tableExists = await db.$queryRaw`
            SELECT name FROM sqlite_master WHERE type='table' AND name='search_index';
        `;
    if (tableExists.length === 0) {
      await createSearchIndexTable();
      console.log("[SearchIndex] FTS5 table created successfully");
      await rebuildAllIndexes();
      console.log("[SearchIndex] FTS5 index rebuilt from source data");
    } else {
      const existingColumns = await getSearchIndexColumns();
      const missingColumns = SEARCH_INDEX_REQUIRED_COLUMNS.filter((column) => !existingColumns.includes(column));
      if (missingColumns.length > 0) {
        console.warn(`[SearchIndex] Schema mismatch detected. Rebuilding FTS5 table. Missing columns: ${missingColumns.join(", ")}`);
        await db.$executeRawUnsafe("DROP TABLE IF EXISTS search_index;");
        await createSearchIndexTable();
        await rebuildAllIndexes();
        console.log("[SearchIndex] FTS5 table rebuilt successfully");
      }
    }
  } catch (error) {
    console.error("[SearchIndex] Failed to initialize FTS5 table:", error);
  }
}
function extractPlainText(lexicalJson) {
  if (!lexicalJson)
    return "";
  try {
    const state = JSON.parse(lexicalJson);
    const textParts = [];
    const traverse = (node) => {
      if (node.type === "text" && node.text) {
        textParts.push(node.text);
      }
      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(traverse);
        if (node.type !== "root" && node.type !== "list" && node.type !== "listitem") {
          textParts.push(" ");
        }
      }
    };
    if (state.root) {
      traverse(state.root);
    }
    return textParts.join("").trim();
  } catch {
    return lexicalJson;
  }
}
async function indexChapter(chapter) {
  const plainText = extractPlainText(chapter.content);
  let novelId = chapter.novelId;
  let volumeTitle = chapter.volumeTitle;
  let order = chapter.order;
  let volumeOrder = chapter.volumeOrder;
  if (!novelId || !volumeTitle || order === void 0 || volumeOrder === void 0) {
    const chapterWithVol = await db.chapter.findUnique({
      where: { id: chapter.id },
      select: {
        order: true,
        volume: { select: { id: true, novelId: true, title: true, order: true } }
      }
    });
    if (chapterWithVol) {
      if (order === void 0)
        order = chapterWithVol.order;
      if (chapterWithVol.volume) {
        if (!novelId)
          novelId = chapterWithVol.volume.novelId;
        if (!volumeTitle)
          volumeTitle = chapterWithVol.volume.title;
        if (volumeOrder === void 0)
          volumeOrder = chapterWithVol.volume.order;
      }
    }
  }
  if (!novelId)
    return;
  try {
    await db.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'chapter' AND entity_id = ${chapter.id};
        `;
    await db.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${plainText}, 'chapter', ${chapter.id}, ${novelId}, ${chapter.id}, ${chapter.title}, ${volumeTitle || ""}, ${order || 0}, ${volumeOrder || 0}, ${chapter.volumeId});
        `;
  } catch (error) {
    console.error("[SearchIndex] Failed to index chapter:", error);
  }
}
async function indexIdea(idea) {
  const searchContent = [idea.content, idea.quote].filter(Boolean).join(" ");
  try {
    await db.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'idea' AND entity_id = ${idea.id};
        `;
    await db.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${searchContent}, 'idea', ${idea.id}, ${idea.novelId}, ${idea.chapterId || ""}, ${idea.content.substring(0, 50)}, '', 0, 0, '');
        `;
  } catch (error) {
    console.error("[SearchIndex] Failed to index idea:", error);
  }
}
async function removeFromIndex(entityType, entityId) {
  try {
    await db.$executeRaw`
            DELETE FROM search_index WHERE entity_type = ${entityType} AND entity_id = ${entityId};
        `;
  } catch (error) {
    console.error("[SearchIndex] Failed to remove from index:", error);
  }
}
async function search(novelId, keyword, limit = 20, offset = 0) {
  if (!keyword.trim())
    return [];
  try {
    const escapedKeyword = keyword.replace(/[%_]/g, "\\$&");
    const likePattern = `%${escapedKeyword}%`;
    const results = await db.$queryRaw`
            SELECT entity_type, entity_id, chapter_id, novel_id, title, volume_title, content, chapter_order, volume_order, volume_id
            FROM search_index
            WHERE novel_id = ${novelId} 
            AND (content LIKE ${likePattern} OR title LIKE ${likePattern} OR volume_title LIKE ${likePattern})
            ORDER BY volume_order ASC, chapter_order ASC
            LIMIT ${limit} OFFSET ${offset};
        `;
    const allResults = [];
    const lowerKeyword = keyword.toLowerCase();
    const matchedVolumes = /* @__PURE__ */ new Set();
    for (const r of results) {
      const docContent = r.content || "";
      const title = r.title || "";
      const volumeTitle = r.volume_title || "";
      const chapterOrder = Number(r.chapter_order || 0);
      const volumeOrder = Number(r.volume_order || 0);
      if (r.entity_type === "chapter" && volumeTitle && volumeTitle.toLowerCase().includes(lowerKeyword)) {
        if (!matchedVolumes.has(volumeTitle)) {
          allResults.push({
            entityType: "chapter",
            entityId: r.entity_id,
            chapterId: r.chapter_id,
            novelId: r.novel_id,
            title: r.title,
            snippet: `Volume match: <mark>${volumeTitle}</mark>`,
            preview: `Found in Volume: ${volumeTitle}`,
            keyword,
            matchType: "volume",
            chapterOrder,
            volumeTitle,
            volumeOrder,
            volumeId: r.volume_id
          });
          matchedVolumes.add(volumeTitle);
        }
      }
      if (r.entity_type === "chapter" && title.toLowerCase().includes(lowerKeyword)) {
        allResults.push({
          entityType: "chapter",
          entityId: r.entity_id,
          chapterId: r.chapter_id,
          novelId: r.novel_id,
          title: r.title,
          snippet: `Title match: <mark>${title}</mark>`,
          preview: `Found in Title: ${title}`,
          keyword,
          matchType: "title",
          chapterOrder,
          volumeTitle,
          volumeOrder,
          volumeId: r.volume_id
        });
      }
      const lowerContent = docContent.toLowerCase();
      const indices = [];
      let pos = 0;
      while (pos < lowerContent.length && indices.length < 200) {
        const idx = lowerContent.indexOf(lowerKeyword, pos);
        if (idx === -1)
          break;
        indices.push(idx);
        pos = idx + lowerKeyword.length;
      }
      const SNIPPET_WINDOW = 60;
      const mergedIndices = [];
      for (const index of indices) {
        if (mergedIndices.length === 0 || index - mergedIndices[mergedIndices.length - 1] > SNIPPET_WINDOW) {
          mergedIndices.push(index);
        }
      }
      for (const index of mergedIndices) {
        allResults.push({
          entityType: r.entity_type,
          entityId: r.entity_id,
          chapterId: r.chapter_id,
          novelId: r.novel_id,
          title: r.title,
          snippet: generateSnippetAtIndex(docContent, keyword, index, 10, true),
          preview: generateSnippetAtIndex(docContent, keyword, index, 25, false),
          keyword,
          matchType: "content",
          chapterOrder,
          volumeTitle,
          volumeOrder,
          volumeId: r.volume_id
        });
      }
    }
    return allResults;
  } catch (error) {
    console.error("[SearchIndex] Search failed:", error);
    return [];
  }
}
function generateSnippetAtIndex(content, keyword, index, contextLength = 30, useMark = true) {
  if (!content)
    return "";
  const start = Math.max(0, index - contextLength);
  const end = Math.min(content.length, index + keyword.length + contextLength * 2);
  let snippet = "";
  if (start > 0)
    snippet += "...";
  const before = content.substring(start, index);
  const match = content.substring(index, index + keyword.length);
  const after = content.substring(index + keyword.length, end);
  if (useMark) {
    snippet += before + "<mark>" + match + "</mark>" + after;
  } else {
    snippet += before + match + after;
  }
  if (end < content.length)
    snippet += "...";
  return snippet;
}
async function rebuildIndex(novelId) {
  var _a, _b;
  let chaptersIndexed = 0;
  let ideasIndexed = 0;
  try {
    await db.$executeRaw`DELETE FROM search_index WHERE novel_id = ${novelId};`;
    const chapters = await db.chapter.findMany({
      where: { volume: { novelId } },
      select: {
        id: true,
        title: true,
        content: true,
        volumeId: true,
        order: true,
        volume: { select: { title: true, order: true } }
      }
    });
    for (const chapter of chapters) {
      await indexChapter({
        ...chapter,
        novelId,
        volumeTitle: (_a = chapter.volume) == null ? void 0 : _a.title,
        volumeOrder: (_b = chapter.volume) == null ? void 0 : _b.order
      });
      chaptersIndexed++;
    }
    const ideas = await db.idea.findMany({
      where: { novelId },
      select: { id: true, content: true, quote: true, novelId: true, chapterId: true }
    });
    for (const idea of ideas) {
      await indexIdea(idea);
      ideasIndexed++;
    }
  } catch (error) {
    console.error("[SearchIndex] Rebuild failed:", error);
  }
  return { chapters: chaptersIndexed, ideas: ideasIndexed };
}
async function getIndexStats(novelId) {
  try {
    const result = await db.$queryRaw`
            SELECT entity_type, COUNT(*) as count FROM search_index WHERE novel_id = ${novelId} GROUP BY entity_type;
        `;
    let chapters = 0;
    let ideas = 0;
    result.forEach((r) => {
      if (r.entity_type === "chapter")
        chapters = Number(r.count);
      if (r.entity_type === "idea")
        ideas = Number(r.count);
    });
    return { chapters, ideas };
  } catch (error) {
    console.error("[SearchIndex] Failed to get stats:", error);
    return { chapters: 0, ideas: 0 };
  }
}
class AiActionError extends Error {
  constructor(code, message, detail) {
    super(message);
    __publicField(this, "code");
    __publicField(this, "detail");
    this.code = code;
    this.detail = detail;
    this.name = "AiActionError";
  }
}
function fromMessage(message) {
  const text = message.toLowerCase();
  if (text.includes("timed out") || text.includes("timeout") || text.includes("aborterror") || text.includes("aborted")) {
    return new AiActionError("PROVIDER_TIMEOUT", message);
  }
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized") || text.includes("forbidden") || text.includes("api key")) {
    return new AiActionError("PROVIDER_AUTH", message);
  }
  if (text.includes("content_filter") || text.includes("safety") || text.includes("filtered")) {
    return new AiActionError("PROVIDER_FILTERED", message);
  }
  if (text.includes("429") || text.includes("503") || text.includes("model") || text.includes("unavailable")) {
    return new AiActionError("PROVIDER_UNAVAILABLE", message);
  }
  if (text.includes("fetch") || text.includes("network") || text.includes("econn")) {
    return new AiActionError("NETWORK_ERROR", message);
  }
  return new AiActionError("UNKNOWN", message);
}
function normalizeAiError(error) {
  if (error instanceof AiActionError) {
    return error;
  }
  const msg = error instanceof Error ? error.message : String(error ?? "unknown error");
  return fromMessage(msg);
}
function formatAiErrorForDisplay(code, fallback) {
  switch (code) {
    case "INVALID_INPUT":
      return "参数不完整或格式错误，请检查输入。";
    case "NOT_FOUND":
      return "目标数据不存在，可能已被删除。";
    case "CONFLICT":
      return "当前操作与现有数据冲突，请调整后重试。";
    case "PROVIDER_AUTH":
      return "模型鉴权失败，请检查 API Key 或权限。";
    case "PROVIDER_TIMEOUT":
      return "模型请求超时，请稍后重试。";
    case "PROVIDER_UNAVAILABLE":
      return "模型暂不可用，请稍后重试或切换模型。";
    case "PROVIDER_FILTERED":
      return "请求触发内容策略限制，请调整提示词。";
    case "NETWORK_ERROR":
      return "网络连接失败，请检查网络或代理设置。";
    case "PERSISTENCE_ERROR":
      return "写入失败，数据未成功保存。";
    case "UNKNOWN":
    default:
      return fallback || "未知错误，请稍后重试。";
  }
}
const DEV_LOG_FILE_NAME = "debug-dev.log";
const DEV_LOG_MAX_BYTES = 15 * 1024 * 1024;
const REDACTED_VALUE = "***REDACTED***";
const SENSITIVE_KEYS = /* @__PURE__ */ new Set([
  "authorization",
  "apikey",
  "api_key",
  "api key",
  "token",
  "access_token",
  "refresh_token"
]);
let logFilePath = null;
function isDevDebugEnabled() {
  return process.env.NODE_ENV !== "production";
}
function initDevLogger(userDataPath) {
  if (!isDevDebugEnabled())
    return;
  logFilePath = path.join(userDataPath, DEV_LOG_FILE_NAME);
  ensureLogFileReady();
}
function redactForLog(value) {
  return sanitizeValue(value, /* @__PURE__ */ new WeakSet());
}
function devLog(level, scope, message, extra) {
  if (!isDevDebugEnabled())
    return;
  const lines = [
    `[${(/* @__PURE__ */ new Date()).toISOString()}] [${level}] [${scope}]`,
    `message=${message}`,
    extra === void 0 ? "" : `extra=${safeStringify(redactForLog(extra))}`,
    ""
  ].filter(Boolean);
  writeLog(lines.join("\n"));
}
function devLogError(scope, error, extra) {
  const normalizedError = normalizeError(error);
  devLog("ERROR", scope, normalizedError.message, {
    error: normalizedError,
    ...extra === void 0 ? {} : { extra }
  });
}
function ensureLogFileReady() {
  if (!logFilePath)
    return;
  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, "", "utf8");
  }
}
function writeLog(content) {
  if (!logFilePath)
    return;
  try {
    ensureLogFileReady();
    const currentBytes = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
    if (currentBytes >= DEV_LOG_MAX_BYTES) {
      fs.writeFileSync(logFilePath, "", "utf8");
    }
    fs.appendFileSync(logFilePath, `${content}
`, "utf8");
  } catch {
  }
}
function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function normalizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return {
    name: typeof error,
    message: String(error)
  };
}
function sanitizeValue(value, seen) {
  if (value === null || value === void 0)
    return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value === "bigint")
    return value.toString();
  if (value instanceof Error) {
    return normalizeError(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }
  if (typeof value === "object") {
    const objectValue = value;
    if (seen.has(objectValue)) {
      return "[Circular]";
    }
    seen.add(objectValue);
    const result = {};
    for (const [key, rawValue] of Object.entries(objectValue)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = REDACTED_VALUE;
        continue;
      }
      result[key] = sanitizeValue(rawValue, seen);
    }
    seen.delete(objectValue);
    return result;
  }
  return String(value);
}
function joinUrl$1(baseUrl, path2) {
  return `${baseUrl.replace(/\/+$/, "")}/${path2.replace(/^\/+/, "")}`;
}
function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function describeNetworkError(error) {
  var _a, _b;
  const message = String((error == null ? void 0 : error.message) || "unknown error");
  const causeCode = ((_a = error == null ? void 0 : error.cause) == null ? void 0 : _a.code) || (error == null ? void 0 : error.code);
  const causeMessage = (_b = error == null ? void 0 : error.cause) == null ? void 0 : _b.message;
  const parts = [message];
  if (causeCode) {
    parts.push(`code=${causeCode}`);
  }
  if (causeMessage && causeMessage !== message) {
    parts.push(`cause=${causeMessage}`);
  }
  return parts.join(" | ");
}
async function transportFetch$1(url, init) {
  try {
    return await net.fetch(url, init);
  } catch {
    return await fetch(url, init);
  }
}
class HttpProvider {
  constructor(settings) {
    __publicField(this, "name", "http");
    this.settings = settings;
  }
  async healthCheck() {
    const { baseUrl, apiKey, timeoutMs } = this.settings.http;
    if (!baseUrl.trim()) {
      return { ok: false, detail: "HTTP baseUrl is empty" };
    }
    try {
      new URL(baseUrl);
    } catch {
      return { ok: false, detail: "HTTP baseUrl is invalid" };
    }
    if (!apiKey.trim()) {
      return { ok: false, detail: "API key is empty" };
    }
    const controller = new AbortController();
    let didTimeout = false;
    const effectiveTimeout = Math.max(1e3, timeoutMs);
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, effectiveTimeout);
    const url = joinUrl$1(baseUrl, "models");
    const startedAt = Date.now();
    try {
      devLog("INFO", "HttpProvider.healthCheck.request", "HTTP health check request", {
        url,
        timeoutMs: effectiveTimeout,
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const res = await transportFetch$1(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal
      });
      if (!res.ok) {
        devLog("WARN", "HttpProvider.healthCheck.response", "HTTP health check rejected", {
          url,
          status: res.status,
          elapsedMs: Date.now() - startedAt
        });
        return { ok: false, detail: `HTTP provider rejected: ${res.status}` };
      }
      devLog("INFO", "HttpProvider.healthCheck.response", "HTTP health check ok", {
        url,
        status: res.status,
        elapsedMs: Date.now() - startedAt
      });
      return { ok: true, detail: "HTTP provider is reachable" };
    } catch (error) {
      devLogError("HttpProvider.healthCheck.error", error, {
        url,
        elapsedMs: Date.now() - startedAt,
        didTimeout
      });
      if (didTimeout) {
        return { ok: false, detail: `HTTP health check timed out after ${effectiveTimeout}ms` };
      }
      return { ok: false, detail: `HTTP health check failed: ${describeNetworkError(error)} | url=${url}` };
    } finally {
      clearTimeout(timer);
    }
  }
  async generate(req) {
    var _a, _b, _c, _d, _e, _f;
    const prompt = req.prompt.trim();
    if (!prompt) {
      return { text: "", model: this.settings.http.model };
    }
    const controller = new AbortController();
    let didTimeout = false;
    const timeout = Math.max(1e3, req.timeoutMs ?? this.settings.http.timeoutMs);
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeout);
    const body = {
      model: this.settings.http.model,
      messages: [
        ...req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : [],
        { role: "user", content: prompt }
      ],
      max_tokens: req.maxTokens ?? this.settings.http.maxTokens,
      temperature: req.temperature ?? this.settings.http.temperature
    };
    const url = joinUrl$1(this.settings.http.baseUrl, "chat/completions");
    const startedAt = Date.now();
    try {
      devLog("INFO", "HttpProvider.generate.request", "AI text generation request", {
        url,
        timeoutMs: timeout,
        body: redactForLog(body)
      });
      const res = await transportFetch$1(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.http.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      const json = parseJsonSafe(text);
      devLog("INFO", "HttpProvider.generate.response", "AI text generation response", {
        url,
        status: res.status,
        elapsedMs: Date.now() - startedAt,
        text
      });
      if (!res.ok) {
        throw new Error(((_a = json == null ? void 0 : json.error) == null ? void 0 : _a.message) || `HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const output = ((_d = (_c = (_b = json == null ? void 0 : json.choices) == null ? void 0 : _b[0]) == null ? void 0 : _c.message) == null ? void 0 : _d.content) || (json == null ? void 0 : json.output_text) || ((_f = (_e = json == null ? void 0 : json.content) == null ? void 0 : _e[0]) == null ? void 0 : _f.text) || "";
      return {
        text: typeof output === "string" ? output : JSON.stringify(output),
        model: (json == null ? void 0 : json.model) || this.settings.http.model
      };
    } catch (error) {
      devLogError("HttpProvider.generate.error", error, {
        url,
        elapsedMs: Date.now() - startedAt,
        didTimeout,
        requestBody: redactForLog(body)
      });
      if (didTimeout || (error == null ? void 0 : error.name) === "AbortError") {
        throw new Error(`HTTP request timeout after ${timeout}ms`);
      }
      throw new Error(`HTTP request failed: ${describeNetworkError(error)} | url=${url}`);
    } finally {
      clearTimeout(timer);
    }
  }
  async generateImage(req) {
    var _a, _b;
    const prompt = req.prompt.trim();
    if (!prompt) {
      return {};
    }
    const controller = new AbortController();
    let didTimeout = false;
    const timeout = Math.max(1e3, this.settings.http.timeoutMs);
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeout);
    const body = {
      model: req.model || this.settings.http.model,
      prompt,
      size: req.size || "1024x1024",
      output_format: req.outputFormat || "png",
      watermark: req.watermark ?? true
    };
    const url = joinUrl$1(this.settings.http.baseUrl, "images/generations");
    const startedAt = Date.now();
    try {
      devLog("INFO", "HttpProvider.generateImage.request", "AI image generation request", {
        url,
        timeoutMs: timeout,
        body: redactForLog(body)
      });
      const res = await transportFetch$1(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.http.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      const json = parseJsonSafe(text);
      devLog("INFO", "HttpProvider.generateImage.response", "AI image generation response", {
        url,
        status: res.status,
        elapsedMs: Date.now() - startedAt,
        text
      });
      if (!res.ok) {
        throw new Error(((_a = json == null ? void 0 : json.error) == null ? void 0 : _a.message) || `HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const first = ((_b = json == null ? void 0 : json.data) == null ? void 0 : _b[0]) || {};
      return {
        imageUrl: first.url,
        imageBase64: first.b64_json,
        mimeType: "image/png"
      };
    } catch (error) {
      devLogError("HttpProvider.generateImage.error", error, {
        url,
        elapsedMs: Date.now() - startedAt,
        didTimeout,
        requestBody: redactForLog(body)
      });
      if (didTimeout || (error == null ? void 0 : error.name) === "AbortError") {
        throw new Error(`HTTP request timeout after ${timeout}ms`);
      }
      throw new Error(`HTTP request failed: ${describeNetworkError(error)} | url=${url}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
const LOG_PREFIX = "[Summary]";
const DEFAULT_SUMMARY_SETTINGS = {
  summaryMode: "local",
  summaryTriggerPolicy: "manual",
  summaryDebounceMs: 3e4,
  summaryMinIntervalMs: 18e4,
  summaryMinWordDelta: 120,
  summaryFinalizeStableMs: 6e5,
  summaryFinalizeMinWords: 1200,
  recentChapterRawCount: 2
};
const DEFAULT_AI_SETTINGS$1 = {
  providerType: "http",
  http: {
    baseUrl: "",
    apiKey: "",
    model: "gpt-4.1-mini",
    imageModel: "doubao-seedream-5-0-260128",
    imageSize: "2K",
    imageOutputFormat: "png",
    imageWatermark: false,
    timeoutMs: 6e4,
    maxTokens: 4096,
    temperature: 0.7
  },
  mcpCli: {
    cliPath: "",
    argsTemplate: "",
    workingDir: "",
    envJson: "{}",
    startupTimeoutMs: 6e4
  },
  proxy: {
    mode: "system",
    httpProxy: "",
    httpsProxy: "",
    allProxy: "",
    noProxy: ""
  },
  summary: DEFAULT_SUMMARY_SETTINGS,
  embedding: {
    enabled: false,
    baseUrl: "",
    apiKey: "",
    model: "bge-large-zh-v1.5",
    dimensions: 1024,
    batchSize: 8,
    timeoutMs: 6e4,
    fallbackToHash: true
  }
};
const pendingTimers = /* @__PURE__ */ new Map();
const aiPendingCounters = /* @__PURE__ */ new Map();
const finalizeTimers = /* @__PURE__ */ new Map();
const narrativeTimers = /* @__PURE__ */ new Map();
let dbPathLogged = false;
function extractPlainTextFromLexical$3(content) {
  if (!(content == null ? void 0 : content.trim()))
    return "";
  try {
    const parsed = JSON.parse(content);
    const texts = [];
    const walk = (node) => {
      if (!node || typeof node !== "object")
        return;
      if (typeof node.text === "string") {
        texts.push(node.text);
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(walk);
      }
    };
    walk((parsed == null ? void 0 : parsed.root) || parsed);
    return texts.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return content.replace(/\s+/g, " ").trim();
  }
}
function buildKeyFacts(plainText) {
  if (!plainText)
    return [];
  const sentences = plainText.split(/[。！？!?]/).map((item) => item.trim()).filter(Boolean);
  return sentences.slice(0, 5).map((item, index) => `fact_${index + 1}: ${item.slice(0, 80)}`);
}
function buildOpenQuestions(plainText) {
  if (!plainText)
    return [];
  return plainText.split(/[。！？!?]/).map((item) => item.trim()).filter((item) => item.includes("？") || item.includes("?")).slice(0, 5);
}
function buildCompressedMemory(title, chapterOrder, summaryText, keyFacts) {
  const orderPart = Number.isFinite(chapterOrder) ? `第${chapterOrder}章` : "章节";
  const factPart = keyFacts.length > 0 ? keyFacts.join(" | ") : "无明显关键事实";
  return `${orderPart}《${title || "未命名章节"}》摘要：${summaryText}
关键事实：${factPart}`;
}
function safeParseJsonArray(value) {
  if (typeof value !== "string" || !value.trim())
    return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed))
      return [];
    return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function computeNarrativeFingerprint(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
function buildNarrativeSummaryText(scope, itemCount, summarySnippets) {
  const header = scope === "volume" ? `卷级摘要（覆盖${itemCount}章）` : `全书摘要（覆盖${itemCount}章）`;
  const merged = summarySnippets.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return `${header}
${merged}`.slice(0, 2400);
}
function getAiSettingsFilePath() {
  return path.join(app.getPath("userData"), "ai-settings.json");
}
function loadAiSettings() {
  try {
    const filePath = getAiSettingsFilePath();
    if (!fs.existsSync(filePath))
      return DEFAULT_AI_SETTINGS$1;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_AI_SETTINGS$1,
      ...parsed,
      http: { ...DEFAULT_AI_SETTINGS$1.http, ...parsed.http ?? {} },
      mcpCli: { ...DEFAULT_AI_SETTINGS$1.mcpCli, ...parsed.mcpCli ?? {} },
      proxy: { ...DEFAULT_AI_SETTINGS$1.proxy, ...parsed.proxy ?? {} },
      summary: { ...DEFAULT_SUMMARY_SETTINGS, ...parsed.summary ?? {} }
    };
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to load ai-settings.json, fallback to defaults:`, error);
    return DEFAULT_AI_SETTINGS$1;
  }
}
async function buildLocalSummary(plainText, chapterOrder) {
  const summaryText = plainText.slice(0, 220) || "章节内容为空，暂无可提炼摘要。";
  return {
    summaryText,
    keyFacts: buildKeyFacts(plainText),
    openQuestions: buildOpenQuestions(plainText),
    timelineHints: [`chapter_order:${chapterOrder ?? "unknown"}`],
    provider: "local",
    model: "heuristic-v1",
    promptVersion: "chapter-summary-v1",
    temperature: 0,
    maxTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0
  };
}
async function buildAiSummary(chapterId, plainText, settings, chapterOrder) {
  var _a, _b;
  const canUseHttp = settings.providerType === "http" && Boolean((_a = settings.http.baseUrl) == null ? void 0 : _a.trim()) && Boolean((_b = settings.http.apiKey) == null ? void 0 : _b.trim());
  if (!canUseHttp) {
    throw new Error("AI summary mode requires HTTP provider with baseUrl and apiKey");
  }
  console.log(`${LOG_PREFIX} [${chapterId}] AI summary start (model=${settings.http.model})`);
  const provider = new HttpProvider(settings);
  const startedAt = Date.now();
  const response = await provider.generate({
    systemPrompt: [
      "You summarize novel chapters for continuity memory.",
      "Return strict JSON only.",
      'Schema: {"summaryText":"...","keyFacts":["..."],"openQuestions":["..."],"timelineHints":["..."]}'
    ].join(" "),
    prompt: JSON.stringify({
      task: "chapter_memory_summary",
      chapterOrder,
      content: plainText.slice(0, 8e3),
      constraints: [
        "summaryText should be concise and neutral",
        "keyFacts at most 6 items",
        "openQuestions at most 4 items"
      ]
    }),
    maxTokens: Math.min(1024, settings.http.maxTokens),
    temperature: Math.min(0.3, settings.http.temperature)
  });
  const parsed = JSON.parse(response.text || "{}");
  const summaryText = String(parsed.summaryText || "").trim();
  if (!summaryText) {
    throw new Error("AI summary returned empty summaryText");
  }
  const latencyMs = Date.now() - startedAt;
  console.log(`${LOG_PREFIX} [${chapterId}] AI summary success (${latencyMs}ms)`);
  return {
    summaryText: summaryText.slice(0, 400),
    keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts.map((item) => String(item).trim()).filter(Boolean).slice(0, 6) : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map((item) => String(item).trim()).filter(Boolean).slice(0, 4) : [],
    timelineHints: Array.isArray(parsed.timelineHints) ? parsed.timelineHints.map((item) => String(item).trim()).filter(Boolean).slice(0, 6) : [`chapter_order:${chapterOrder ?? "unknown"}`],
    provider: "http",
    model: settings.http.model,
    promptVersion: "chapter-summary-ai-v1",
    temperature: Math.min(0.3, settings.http.temperature),
    maxTokens: Math.min(1024, settings.http.maxTokens),
    inputTokens: 0,
    outputTokens: 0,
    latencyMs
  };
}
async function collectNarrativePayload(scope, novelId, volumeId) {
  const where = scope === "volume" ? { novelId, volumeId: volumeId || "", isLatest: true, status: "active" } : { novelId, isLatest: true, status: "active" };
  const chapterSummaries = await db.chapterSummary.findMany({
    where,
    select: {
      id: true,
      chapterId: true,
      chapterOrder: true,
      updatedAt: true,
      summaryText: true,
      keyFacts: true,
      openQuestions: true
    },
    orderBy: [
      { chapterOrder: "asc" },
      { updatedAt: "asc" }
    ],
    take: scope === "volume" ? 120 : 300
  });
  if (chapterSummaries.length === 0) {
    return null;
  }
  const coverageChapterIds = chapterSummaries.map((item) => item.chapterId);
  const chapterOrders = chapterSummaries.map((item) => Number(item.chapterOrder)).filter((item) => Number.isFinite(item));
  const chapterRangeStart = chapterOrders.length > 0 ? Math.min(...chapterOrders) : null;
  const chapterRangeEnd = chapterOrders.length > 0 ? Math.max(...chapterOrders) : null;
  const summarySnippets = chapterSummaries.map((item) => String(item.summaryText || "").trim()).filter(Boolean).slice(-10);
  const keyFacts = [...new Set(
    chapterSummaries.flatMap((item) => safeParseJsonArray(item.keyFacts))
  )].map((item) => String(item || "").slice(0, 120)).filter(Boolean).slice(0, 24);
  const unresolvedThreads = [...new Set(
    chapterSummaries.flatMap((item) => safeParseJsonArray(item.openQuestions))
  )].map((item) => String(item || "").slice(0, 120)).filter(Boolean).slice(0, 20);
  const styleGuide = [
    scope === "volume" ? "保持本卷叙事风格一致" : "保持全书叙事风格一致",
    "优先遵循现有大纲与关键事实"
  ];
  const hardConstraints = [
    "不得与已确认关键事实冲突",
    "保持角色动机与关系连续"
  ];
  const sourceFingerprint = computeNarrativeFingerprint(
    chapterSummaries.map((item) => `${item.id}:${new Date(item.updatedAt).toISOString()}`)
  );
  let title = null;
  if (scope === "volume" && volumeId) {
    const volume = await db.volume.findUnique({
      where: { id: volumeId },
      select: { title: true }
    });
    title = (volume == null ? void 0 : volume.title) || null;
  }
  return {
    title,
    summaryText: buildNarrativeSummaryText(scope, coverageChapterIds.length, summarySnippets),
    keyFacts,
    unresolvedThreads,
    styleGuide,
    hardConstraints,
    coverageChapterIds,
    chapterRangeStart,
    chapterRangeEnd,
    sourceFingerprint
  };
}
async function upsertNarrativeSummary(scope, novelId, payload, volumeId) {
  await db.$transaction(async (tx) => {
    await tx.narrativeSummary.updateMany({
      where: {
        novelId,
        level: scope,
        volumeId: scope === "volume" ? volumeId || null : null,
        isLatest: true
      },
      data: {
        isLatest: false,
        status: "stale"
      }
    });
    const existing = await tx.narrativeSummary.findFirst({
      where: {
        novelId,
        level: scope,
        volumeId: scope === "volume" ? volumeId || null : null,
        sourceFingerprint: payload.sourceFingerprint
      }
    });
    const data = {
      novelId,
      volumeId: scope === "volume" ? volumeId || null : null,
      level: scope,
      title: payload.title || null,
      summaryText: payload.summaryText,
      keyFacts: JSON.stringify(payload.keyFacts),
      unresolvedThreads: JSON.stringify(payload.unresolvedThreads),
      styleGuide: JSON.stringify(payload.styleGuide),
      hardConstraints: JSON.stringify(payload.hardConstraints),
      coverageChapterIds: JSON.stringify(payload.coverageChapterIds),
      chapterRangeStart: payload.chapterRangeStart,
      chapterRangeEnd: payload.chapterRangeEnd,
      sourceFingerprint: payload.sourceFingerprint,
      provider: "local",
      model: "heuristic-v1",
      promptVersion: "narrative-summary-v1",
      temperature: 0,
      maxTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      qualityScore: null,
      status: "active",
      errorCode: null,
      errorDetail: null,
      isLatest: true
    };
    if (existing == null ? void 0 : existing.id) {
      await tx.narrativeSummary.update({
        where: { id: existing.id },
        data
      });
    } else {
      await tx.narrativeSummary.create({ data });
    }
  });
}
async function rebuildNarrativeSummaries(novelId, volumeId) {
  try {
    const [volumePayload, novelPayload] = await Promise.all([
      collectNarrativePayload("volume", novelId, volumeId),
      collectNarrativePayload("novel", novelId, null)
    ]);
    if (volumePayload) {
      await upsertNarrativeSummary("volume", novelId, volumePayload, volumeId);
      console.log(`${LOG_PREFIX} [novel=${novelId}] narrative summary updated (level=volume, volume=${volumeId})`);
    }
    if (novelPayload) {
      await upsertNarrativeSummary("novel", novelId, novelPayload, null);
      console.log(`${LOG_PREFIX} [novel=${novelId}] narrative summary updated (level=novel)`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} [novel=${novelId}] narrative summary rebuild failed:`, error);
  }
}
function scheduleNarrativeSummaryRebuild(novelId, volumeId) {
  const key = `${novelId}:${volumeId}`;
  const existing = narrativeTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    narrativeTimers.delete(key);
    void rebuildNarrativeSummaries(novelId, volumeId);
  }, 15e3);
  narrativeTimers.set(key, timer);
}
async function rebuildChapterSummary(chapterId, options) {
  var _a;
  const settings = loadAiSettings();
  const force = Boolean(options == null ? void 0 : options.force);
  const reason = (options == null ? void 0 : options.reason) || "save";
  const isAiMode = settings.summary.summaryMode === "ai";
  const effectiveMinIntervalMs = isAiMode ? Math.max(18e5, settings.summary.summaryMinIntervalMs) : settings.summary.summaryMinIntervalMs;
  const effectiveMinWordDelta = isAiMode ? Math.max(800, settings.summary.summaryMinWordDelta) : settings.summary.summaryMinWordDelta;
  const chapter = await db.chapter.findUnique({
    where: { id: chapterId },
    select: {
      id: true,
      title: true,
      content: true,
      wordCount: true,
      order: true,
      updatedAt: true,
      volumeId: true,
      volume: { select: { novelId: true } }
    }
  });
  if (!((_a = chapter == null ? void 0 : chapter.volume) == null ? void 0 : _a.novelId)) {
    console.log(`${LOG_PREFIX} [${chapterId}] skip: chapter or novel relation missing`);
    return;
  }
  if (!dbPathLogged) {
    try {
      const rows = await db.$queryRawUnsafe("PRAGMA database_list;");
      const mainDb = Array.isArray(rows) ? rows.find((row) => (row == null ? void 0 : row.name) === "main") : null;
      console.log(`${LOG_PREFIX} sqlite main db path: ${(mainDb == null ? void 0 : mainDb.file) || "unknown"}`);
    } catch (e) {
      console.warn(`${LOG_PREFIX} failed to read sqlite db path via PRAGMA database_list`);
    } finally {
      dbPathLogged = true;
    }
  }
  const sourceContent = chapter.content || "";
  const sourceContentHash = createHash("sha256").update(sourceContent).digest("hex");
  const now = Date.now();
  const latest = await db.chapterSummary.findFirst({
    where: {
      chapterId: chapter.id,
      isLatest: true,
      status: "active",
      summaryType: "standard"
    },
    orderBy: { updatedAt: "desc" }
  });
  if (!force && (latest == null ? void 0 : latest.sourceContentHash) === sourceContentHash) {
    console.log(`${LOG_PREFIX} [${chapterId}] skip: same content hash`);
    return;
  }
  const wordDelta = Math.abs((chapter.wordCount || 0) - Number((latest == null ? void 0 : latest.sourceWordCount) || 0));
  const latestTime = (latest == null ? void 0 : latest.updatedAt) ? new Date(latest.updatedAt).getTime() : 0;
  const sinceLastMs = latestTime > 0 ? now - latestTime : Number.MAX_SAFE_INTEGER;
  if (!force && latestTime > 0 && sinceLastMs < effectiveMinIntervalMs && wordDelta < effectiveMinWordDelta) {
    console.log(
      `${LOG_PREFIX} [${chapterId}] skip: throttled (deltaWords=${wordDelta}, sinceLastMs=${sinceLastMs}, minIntervalMs=${effectiveMinIntervalMs}, minWordDelta=${effectiveMinWordDelta})`
    );
    return;
  }
  const plainText = extractPlainTextFromLexical$3(sourceContent);
  console.log(
    `${LOG_PREFIX} [${chapterId}] start rebuild (reason=${reason}, mode=${settings.summary.summaryMode}, words=${chapter.wordCount || plainText.length}, deltaWords=${wordDelta}, force=${force})`
  );
  let summary = await buildLocalSummary(plainText, chapter.order ?? null);
  if (settings.summary.summaryMode === "ai") {
    try {
      summary = await buildAiSummary(chapterId, plainText, settings, chapter.order ?? null);
    } catch (error) {
      console.warn(`${LOG_PREFIX} [${chapterId}] AI summary failed, fallback to local: ${(error == null ? void 0 : error.message) || "unknown error"}`);
      const fallback = await buildLocalSummary(plainText, chapter.order ?? null);
      summary = {
        ...fallback,
        errorCode: "AI_SUMMARY_FALLBACK",
        errorDetail: (error == null ? void 0 : error.message) || "unknown ai summary error"
      };
    }
  }
  await db.$transaction(async (tx) => {
    await tx.chapterSummary.updateMany({
      where: { chapterId: chapter.id, isLatest: true },
      data: { isLatest: false, status: "stale" }
    });
    const existing = await tx.chapterSummary.findFirst({
      where: {
        chapterId: chapter.id,
        sourceContentHash,
        summaryType: "standard"
      }
    });
    const payload = {
      novelId: chapter.volume.novelId,
      volumeId: chapter.volumeId,
      chapterId: chapter.id,
      summaryType: "standard",
      summaryText: summary.summaryText,
      compressedMemory: buildCompressedMemory(chapter.title || "", chapter.order ?? null, summary.summaryText, summary.keyFacts),
      keyFacts: JSON.stringify(summary.keyFacts),
      entitiesSnapshot: JSON.stringify({}),
      timelineHints: JSON.stringify(summary.timelineHints),
      openQuestions: JSON.stringify(summary.openQuestions),
      sourceContentHash,
      sourceWordCount: chapter.wordCount || plainText.length,
      sourceUpdatedAt: chapter.updatedAt,
      chapterOrder: chapter.order ?? null,
      provider: summary.provider,
      model: summary.model,
      promptVersion: summary.promptVersion,
      temperature: summary.temperature,
      maxTokens: summary.maxTokens,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      latencyMs: summary.latencyMs,
      qualityScore: null,
      status: "active",
      errorCode: summary.errorCode || null,
      errorDetail: summary.errorDetail || null,
      isLatest: true
    };
    if (existing == null ? void 0 : existing.id) {
      await tx.chapterSummary.update({
        where: { id: existing.id },
        data: payload
      });
      console.log(`${LOG_PREFIX} [${chapterId}] done: updated existing summary`);
      return;
    }
    await tx.chapterSummary.create({
      data: payload
    });
    console.log(`${LOG_PREFIX} [${chapterId}] done: created new summary`);
  });
  scheduleNarrativeSummaryRebuild(chapter.volume.novelId, chapter.volumeId);
}
function scheduleChapterSummaryRebuild(chapterId, reason = "save") {
  const settings = loadAiSettings();
  if (reason === "manual") {
    console.log(`${LOG_PREFIX} [${chapterId}] manual trigger received`);
    void rebuildChapterSummary(chapterId, { force: true, reason: "manual" }).catch((error) => {
      console.error(`${LOG_PREFIX} [${chapterId}] manual rebuild failed:`, error);
    });
    return;
  }
  if (settings.summary.summaryMode === "ai" && settings.summary.summaryTriggerPolicy === "manual") {
    console.log(`${LOG_PREFIX} [${chapterId}] skip scheduling: ai mode manual-only policy`);
    return;
  }
  if (settings.summary.summaryMode === "ai" && settings.summary.summaryTriggerPolicy === "finalized") {
    const stableDelay = Math.max(6e4, settings.summary.summaryFinalizeStableMs);
    const existingFinalize = finalizeTimers.get(chapterId);
    if (existingFinalize)
      clearTimeout(existingFinalize);
    const timer2 = setTimeout(async () => {
      finalizeTimers.delete(chapterId);
      const chapter = await db.chapter.findUnique({
        where: { id: chapterId },
        select: { wordCount: true }
      });
      const wordCount = (chapter == null ? void 0 : chapter.wordCount) || 0;
      if (wordCount < settings.summary.summaryFinalizeMinWords) {
        console.log(
          `${LOG_PREFIX} [${chapterId}] finalized trigger skipped (wordCount=${wordCount}, min=${settings.summary.summaryFinalizeMinWords})`
        );
        return;
      }
      console.log(`${LOG_PREFIX} [${chapterId}] finalized trigger fired after stable window ${stableDelay}ms`);
      void rebuildChapterSummary(chapterId, { force: true, reason: "finalized" }).catch((error) => {
        console.error(`${LOG_PREFIX} [${chapterId}] finalized rebuild failed:`, error);
      });
    }, stableDelay);
    finalizeTimers.set(chapterId, timer2);
    console.log(`${LOG_PREFIX} [${chapterId}] finalized trigger scheduled (${stableDelay}ms stable window)`);
    return;
  }
  const isAiMode = settings.summary.summaryMode === "ai";
  const delay = isAiMode ? Math.max(3e5, settings.summary.summaryDebounceMs) : Math.max(1e3, settings.summary.summaryDebounceMs);
  const existing = pendingTimers.get(chapterId);
  if (isAiMode) {
    if (existing) {
      const count = (aiPendingCounters.get(chapterId) || 0) + 1;
      aiPendingCounters.set(chapterId, count);
      if (count % 10 === 0) {
        console.log(`${LOG_PREFIX} [${chapterId}] ai mode coalescing saves (${count} updates queued, timer unchanged)`);
      }
      return;
    }
    aiPendingCounters.set(chapterId, 1);
    console.log(`${LOG_PREFIX} [${chapterId}] ai mode scheduled (${delay}ms, fixed window)`);
  } else {
    if (existing) {
      clearTimeout(existing);
      console.log(`${LOG_PREFIX} [${chapterId}] debounce reset (${delay}ms)`);
    } else {
      console.log(`${LOG_PREFIX} [${chapterId}] debounce scheduled (${delay}ms)`);
    }
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(chapterId);
    const queuedCount = aiPendingCounters.get(chapterId) || 0;
    aiPendingCounters.delete(chapterId);
    if (isAiMode) {
      console.log(`${LOG_PREFIX} [${chapterId}] ai mode fired after coalescing ${queuedCount} saves`);
    } else {
      console.log(`${LOG_PREFIX} [${chapterId}] debounce fired, evaluating rebuild`);
    }
    void rebuildChapterSummary(chapterId).catch((error) => {
      console.error(`${LOG_PREFIX} [${chapterId}] rebuild failed:`, error);
    });
  }, delay);
  pendingTimers.set(chapterId, timer);
}
function createCapabilityDefinitions(deps) {
  return [
    {
      actionId: "novel.list",
      title: "List novels",
      description: "Return novels sorted by update time.",
      permission: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "array" },
      handler: async () => db.novel.findMany({ orderBy: { updatedAt: "desc" } })
    },
    {
      actionId: "volume.list",
      title: "List volumes",
      description: "Return all volumes and chapter summaries under a novel.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" }
        },
        required: ["novelId"]
      },
      outputSchema: { type: "array" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId)) {
          throw new AiActionError("INVALID_INPUT", "novelId is required");
        }
        return db.volume.findMany({
          where: { novelId: input.novelId },
          include: {
            chapters: {
              select: { id: true, title: true, order: true, wordCount: true, updatedAt: true },
              orderBy: { order: "asc" }
            }
          },
          orderBy: { order: "asc" }
        });
      }
    },
    {
      actionId: "novel.create",
      title: "Create novel",
      description: "Create a novel with default volume/chapter.",
      permission: "write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" }
        },
        required: []
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        var _a;
        const input = payload;
        const title = ((_a = input == null ? void 0 : input.title) == null ? void 0 : _a.trim()) || `新作品 ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`;
        return db.novel.create({
          data: {
            title,
            wordCount: 0,
            volumes: {
              create: {
                title: "",
                order: 1,
                chapters: {
                  create: {
                    title: "",
                    content: "",
                    order: 1,
                    wordCount: 0
                  }
                }
              }
            }
          }
        });
      }
    },
    {
      actionId: "chapter.list",
      title: "List chapters",
      description: "Return chapters under a volume in ascending order.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          volumeId: { type: "string" }
        },
        required: ["volumeId"]
      },
      outputSchema: { type: "array" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.volumeId)) {
          throw new AiActionError("INVALID_INPUT", "volumeId is required");
        }
        return db.chapter.findMany({
          where: { volumeId: input.volumeId },
          orderBy: { order: "asc" }
        });
      }
    },
    {
      actionId: "chapter.create",
      title: "Create chapter",
      description: "Create a chapter under volume with auto order fallback.",
      permission: "write",
      inputSchema: {
        type: "object",
        properties: {
          volumeId: { type: "string" },
          title: { type: "string" },
          order: { type: "number" }
        },
        required: ["volumeId"]
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        var _a;
        const input = payload;
        if (!(input == null ? void 0 : input.volumeId)) {
          throw new AiActionError("INVALID_INPUT", "volumeId is required");
        }
        let finalOrder = input.order;
        if (!Number.isFinite(finalOrder)) {
          const lastChapter = await db.chapter.findFirst({
            where: { volumeId: input.volumeId },
            orderBy: { order: "desc" }
          });
          finalOrder = ((lastChapter == null ? void 0 : lastChapter.order) || 0) + 1;
        }
        return db.chapter.create({
          data: {
            volumeId: input.volumeId,
            title: ((_a = input.title) == null ? void 0 : _a.trim()) || "",
            order: finalOrder,
            content: "",
            wordCount: 0
          }
        });
      }
    },
    {
      actionId: "chapter.get",
      title: "Get chapter",
      description: "Return chapter content by chapter id.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          chapterId: { type: "string" }
        },
        required: ["chapterId"]
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.chapterId)) {
          throw new AiActionError("INVALID_INPUT", "chapterId is required");
        }
        return db.chapter.findUnique({
          where: { id: input.chapterId },
          include: { volume: { select: { novelId: true } } }
        });
      }
    },
    {
      actionId: "chapter.save",
      title: "Save chapter content",
      description: "Persist chapter content and keep novel word count in sync.",
      permission: "write",
      inputSchema: {
        type: "object",
        properties: {
          chapterId: { type: "string" },
          content: { type: "string" },
          source: {
            type: "string",
            enum: ["ai_agent", "ai_ui"]
          }
        },
        required: ["chapterId", "content"]
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.chapterId)) {
          throw new AiActionError("INVALID_INPUT", "chapterId is required");
        }
        if (typeof input.content !== "string") {
          throw new AiActionError("INVALID_INPUT", "content is required");
        }
        const saveSource = input.source === "ai_ui" ? "ai_ui" : "ai_agent";
        const chapter = await db.chapter.findUnique({
          where: { id: input.chapterId },
          select: { id: true, content: true, updatedAt: true, wordCount: true, volume: { select: { novelId: true } } }
        });
        if (!chapter || !chapter.volume) {
          throw new AiActionError("NOT_FOUND", "Chapter or volume not found");
        }
        const newWordCount = input.content.length;
        const delta = newWordCount - chapter.wordCount;
        try {
          const [, updatedChapter] = await db.$transaction([
            db.novel.update({
              where: { id: chapter.volume.novelId },
              data: { wordCount: { increment: delta }, updatedAt: /* @__PURE__ */ new Date() }
            }),
            db.chapter.update({
              where: { id: input.chapterId },
              data: { content: input.content, wordCount: newWordCount, updatedAt: /* @__PURE__ */ new Date() }
            })
          ]);
          scheduleChapterSummaryRebuild(input.chapterId);
          return {
            chapter: updatedChapter,
            saveMeta: {
              source: saveSource,
              rollbackPoint: {
                chapterId: chapter.id,
                content: chapter.content,
                updatedAt: chapter.updatedAt
              }
            }
          };
        } catch (error) {
          const normalized = normalizeAiError(error);
          throw new AiActionError("PERSISTENCE_ERROR", normalized.message);
        }
      }
    },
    {
      actionId: "chapter.generate",
      title: "Generate chapter draft",
      description: "Generate chapter continuation with strict lore/outline context via configured model provider.",
      permission: "write",
      inputSchema: {
        type: "object",
        properties: {
          locale: { type: "string" },
          mode: {
            type: "string",
            enum: ["new_chapter", "continue_chapter"]
          },
          novelId: { type: "string" },
          chapterId: { type: "string" },
          currentContent: { type: "string" },
          ideaIds: {
            type: "array",
            items: { type: "string" }
          },
          contextChapterCount: { type: "number" },
          recentRawChapterCount: { type: "number" },
          targetLength: { type: "number" },
          style: { type: "string" },
          tone: { type: "string" },
          pace: { type: "string" },
          temperature: { type: "number" },
          userIntent: { type: "string" },
          currentLocation: { type: "string" },
          overrideUserPrompt: { type: "string" }
        },
        required: ["novelId", "chapterId", "currentContent"]
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId) || !input.chapterId || typeof input.currentContent !== "string") {
          throw new AiActionError("INVALID_INPUT", "novelId, chapterId, currentContent are required");
        }
        try {
          return await deps.continueWriting({
            locale: input.locale,
            mode: input.mode,
            novelId: input.novelId,
            chapterId: input.chapterId,
            currentContent: input.currentContent,
            ideaIds: Array.isArray(input.ideaIds) ? input.ideaIds : void 0,
            contextChapterCount: input.contextChapterCount,
            recentRawChapterCount: input.recentRawChapterCount,
            targetLength: input.targetLength,
            style: input.style,
            tone: input.tone,
            pace: input.pace,
            temperature: input.temperature,
            userIntent: input.userIntent,
            currentLocation: input.currentLocation,
            overrideUserPrompt: input.overrideUserPrompt
          });
        } catch (error) {
          throw normalizeAiError(error);
        }
      }
    },
    {
      actionId: "plotline.list",
      title: "List plot lines",
      description: "Return all plot lines and points for a novel.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" }
        },
        required: ["novelId"]
      },
      outputSchema: { type: "array" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId)) {
          throw new AiActionError("INVALID_INPUT", "novelId is required");
        }
        return db.plotLine.findMany({
          where: { novelId: input.novelId },
          include: {
            points: {
              include: { anchors: true },
              orderBy: { order: "asc" }
            }
          },
          orderBy: { sortOrder: "asc" }
        });
      }
    },
    {
      actionId: "worldsetting.list",
      title: "List world settings",
      description: "Return all world settings under a novel.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" }
        },
        required: ["novelId"]
      },
      outputSchema: { type: "array" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId)) {
          throw new AiActionError("INVALID_INPUT", "novelId is required");
        }
        return db.worldSetting.findMany({
          where: { novelId: input.novelId },
          orderBy: { sortOrder: "asc" }
        });
      }
    },
    {
      actionId: "worldsetting.create",
      title: "Create world setting",
      description: "Create a world setting under a novel.",
      permission: "write",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" },
          name: { type: "string" },
          content: { type: "string" },
          type: { type: "string" },
          icon: { type: "string" },
          sortOrder: { type: "number" }
        },
        required: ["novelId", "name"]
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        const input = payload;
        const novelId = String((input == null ? void 0 : input.novelId) || "").trim();
        const name = String((input == null ? void 0 : input.name) || "").trim();
        if (!novelId) {
          throw new AiActionError("INVALID_INPUT", "novelId is required");
        }
        if (!name) {
          throw new AiActionError("INVALID_INPUT", "name is required");
        }
        let sortOrder = input == null ? void 0 : input.sortOrder;
        if (typeof sortOrder !== "number" || !Number.isFinite(sortOrder)) {
          const last = await db.worldSetting.findFirst({
            where: { novelId },
            orderBy: { sortOrder: "desc" }
          });
          sortOrder = ((last == null ? void 0 : last.sortOrder) || 0) + 1;
        }
        const content = typeof (input == null ? void 0 : input.content) === "string" ? input.content : "";
        const type = typeof (input == null ? void 0 : input.type) === "string" && input.type.trim() ? input.type.trim() : "other";
        const icon = typeof (input == null ? void 0 : input.icon) === "string" && input.icon.trim() ? input.icon.trim() : null;
        return db.worldSetting.create({
          data: {
            novelId,
            name,
            content,
            type,
            icon,
            sortOrder
          }
        });
      }
    },
    {
      actionId: "worldsetting.update",
      title: "Update world setting",
      description: "Update a world setting by id.",
      permission: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          content: { type: "string" },
          type: { type: "string" },
          icon: { type: "string" },
          sortOrder: { type: "number" }
        },
        required: ["id"]
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        const input = payload;
        const id = String((input == null ? void 0 : input.id) || "").trim();
        if (!id) {
          throw new AiActionError("INVALID_INPUT", "id is required");
        }
        const data = {};
        if (Object.prototype.hasOwnProperty.call(input, "name")) {
          const nextName = String((input == null ? void 0 : input.name) || "").trim();
          if (!nextName) {
            throw new AiActionError("INVALID_INPUT", "name cannot be empty");
          }
          data.name = nextName;
        }
        if (Object.prototype.hasOwnProperty.call(input, "content")) {
          data.content = typeof (input == null ? void 0 : input.content) === "string" ? input.content : "";
        }
        if (Object.prototype.hasOwnProperty.call(input, "type")) {
          data.type = typeof (input == null ? void 0 : input.type) === "string" && input.type.trim() ? input.type.trim() : "other";
        }
        if (Object.prototype.hasOwnProperty.call(input, "icon")) {
          if ((input == null ? void 0 : input.icon) === null) {
            data.icon = null;
          } else {
            data.icon = typeof (input == null ? void 0 : input.icon) === "string" && input.icon.trim() ? input.icon.trim() : null;
          }
        }
        if (Object.prototype.hasOwnProperty.call(input, "sortOrder")) {
          if (typeof (input == null ? void 0 : input.sortOrder) !== "number" || !Number.isFinite(input.sortOrder)) {
            throw new AiActionError("INVALID_INPUT", "sortOrder must be a finite number");
          }
          data.sortOrder = input.sortOrder;
        }
        if (Object.keys(data).length === 0) {
          throw new AiActionError("INVALID_INPUT", "At least one updatable field is required");
        }
        return db.worldSetting.update({
          where: { id },
          data
        });
      }
    },
    {
      actionId: "character.list",
      title: "List characters",
      description: "Return all characters under a novel.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" }
        },
        required: ["novelId"]
      },
      outputSchema: { type: "array" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId)) {
          throw new AiActionError("INVALID_INPUT", "novelId is required");
        }
        return db.character.findMany({
          where: { novelId: input.novelId },
          orderBy: { sortOrder: "asc" }
        });
      }
    },
    {
      actionId: "item.list",
      title: "List items",
      description: "Return all items and skills under a novel.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" }
        },
        required: ["novelId"]
      },
      outputSchema: { type: "array" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId)) {
          throw new AiActionError("INVALID_INPUT", "novelId is required");
        }
        return db.item.findMany({
          where: { novelId: input.novelId },
          orderBy: { sortOrder: "asc" }
        });
      }
    },
    {
      actionId: "map.list",
      title: "List maps",
      description: "Return all maps under a novel.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" }
        },
        required: ["novelId"]
      },
      outputSchema: { type: "array" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId)) {
          throw new Error("novelId is required");
        }
        return db.mapCanvas.findMany({
          where: { novelId: input.novelId },
          orderBy: { sortOrder: "asc" }
        });
      }
    },
    {
      actionId: "search.query",
      title: "Search novel content",
      description: "Run global search against chapter and idea index.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" },
          keyword: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" }
        },
        required: ["novelId", "keyword"]
      },
      outputSchema: { type: "array" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId) || !(input == null ? void 0 : input.keyword)) {
          throw new AiActionError("INVALID_INPUT", "novelId and keyword are required");
        }
        return search(input.novelId, input.keyword, input.limit ?? 20, input.offset ?? 0);
      }
    },
    {
      actionId: "rag.ask",
      title: "Ask novel RAG",
      description: "Answer a novel-aware question using structured story data, summaries, and search evidence.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" },
          question: { type: "string" },
          chapterId: { type: "string" },
          currentContent: { type: "string" },
          selectedText: { type: "string" },
          currentLocation: { type: "string" },
          locale: { type: "string" },
          maxEvidenceItems: { type: "number" },
          overrideUserPrompt: { type: "string" }
        },
        required: ["novelId", "question"]
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        var _a;
        const input = payload;
        if (!(input == null ? void 0 : input.novelId) || !((_a = input.question) == null ? void 0 : _a.trim())) {
          throw new AiActionError("INVALID_INPUT", "novelId and question are required");
        }
        try {
          return await deps.askNovel({
            novelId: input.novelId,
            question: input.question,
            chapterId: input.chapterId,
            currentContent: input.currentContent,
            selectedText: input.selectedText,
            currentLocation: input.currentLocation,
            locale: input.locale,
            maxEvidenceItems: input.maxEvidenceItems,
            overrideUserPrompt: input.overrideUserPrompt
          });
        } catch (error) {
          throw normalizeAiError(error);
        }
      }
    },
    {
      actionId: "rag.rebuild_index",
      title: "Rebuild RAG vector index",
      description: "Rebuild the local vector chunk index for a novel.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" }
        },
        required: ["novelId"]
      },
      outputSchema: { type: "object" },
      handler: async (payload) => {
        const input = payload;
        if (!(input == null ? void 0 : input.novelId)) {
          throw new AiActionError("INVALID_INPUT", "novelId is required");
        }
        return deps.rebuildRagIndex(input.novelId);
      }
    }
  ];
}
function splitArgs(raw) {
  if (!raw.trim())
    return [];
  const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}
class McpCliProvider {
  constructor(settings) {
    __publicField(this, "name", "mcp-cli");
    this.settings = settings;
  }
  async healthCheck() {
    const { cliPath } = this.settings.mcpCli;
    if (!cliPath.trim()) {
      return { ok: false, detail: "MCP CLI path is empty" };
    }
    if (!fs.existsSync(cliPath)) {
      return { ok: false, detail: "MCP CLI path does not exist" };
    }
    try {
      devLog("INFO", "McpCliProvider.healthCheck.request", "MCP CLI health check request", {
        cliPath,
        timeoutMs: this.settings.mcpCli.startupTimeoutMs
      });
      const { stdout } = await this.runProcess(["--version"], "", this.settings.mcpCli.startupTimeoutMs);
      devLog("INFO", "McpCliProvider.healthCheck.response", "MCP CLI health check response", {
        cliPath,
        stdout
      });
      return { ok: true, detail: (stdout || "MCP CLI is executable").slice(0, 200) };
    } catch (error) {
      devLogError("McpCliProvider.healthCheck.error", error, { cliPath });
      return { ok: false, detail: `MCP CLI check failed: ${(error == null ? void 0 : error.message) || "unknown error"}` };
    }
  }
  async generate(req) {
    const prompt = req.prompt.trim();
    if (!prompt) {
      return { text: "", model: "mcp-cli" };
    }
    const argsTemplate = this.settings.mcpCli.argsTemplate || "";
    const hasPromptPlaceholder = argsTemplate.includes("{prompt}");
    const parsedArgs = splitArgs(argsTemplate.replace("{prompt}", prompt));
    devLog("INFO", "McpCliProvider.generate.request", "MCP CLI generate request", {
      cliPath: this.settings.mcpCli.cliPath,
      args: parsedArgs,
      prompt: hasPromptPlaceholder ? "" : prompt,
      promptEmbeddedInArgs: hasPromptPlaceholder
    });
    const { stdout } = await this.runProcess(parsedArgs, hasPromptPlaceholder ? "" : prompt, this.settings.mcpCli.startupTimeoutMs);
    devLog("INFO", "McpCliProvider.generate.response", "MCP CLI generate response", {
      cliPath: this.settings.mcpCli.cliPath,
      stdout
    });
    return {
      text: stdout.trim(),
      model: "mcp-cli"
    };
  }
  async runProcess(args, stdinText, timeoutMs) {
    const { cliPath, workingDir, envJson } = this.settings.mcpCli;
    const extraEnv = this.parseEnvJson(envJson);
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(cliPath, args, {
        cwd: workingDir || process.cwd(),
        env: { ...process.env, ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      let done = false;
      const timer = setTimeout(() => {
        if (done)
          return;
        done = true;
        child.kill("SIGTERM");
        devLog("ERROR", "McpCliProvider.runProcess.timeout", "MCP CLI process timeout", {
          cliPath,
          args,
          elapsedMs: Date.now() - startedAt
        });
        reject(new Error("MCP CLI process timeout"));
      }, Math.max(1e3, timeoutMs));
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        if (done)
          return;
        done = true;
        clearTimeout(timer);
        devLogError("McpCliProvider.runProcess.error", error, {
          cliPath,
          args,
          elapsedMs: Date.now() - startedAt,
          env: redactForLog(extraEnv)
        });
        reject(error);
      });
      child.on("close", (code) => {
        if (done)
          return;
        done = true;
        clearTimeout(timer);
        if (code !== 0) {
          devLog("ERROR", "McpCliProvider.runProcess.exit", "MCP CLI exited with non-zero code", {
            cliPath,
            args,
            code,
            elapsedMs: Date.now() - startedAt,
            stderr
          });
          reject(new Error(`MCP CLI exited with code ${code}: ${stderr.slice(0, 300)}`));
          return;
        }
        devLog("INFO", "McpCliProvider.runProcess.exit", "MCP CLI process completed", {
          cliPath,
          args,
          code,
          elapsedMs: Date.now() - startedAt,
          stderr
        });
        resolve({ stdout, stderr });
      });
      if (stdinText) {
        child.stdin.write(stdinText);
      }
      child.stdin.end();
    });
  }
  parseEnvJson(raw) {
    if (!raw.trim())
      return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object")
        return {};
      const result = {};
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = String(value ?? "");
      }
      return result;
    } catch {
      return {};
    }
  }
}
function uniqueArray(values) {
  const seen = /* @__PURE__ */ new Set();
  const output = [];
  for (const raw of values) {
    const item = String(raw || "").trim();
    if (!item)
      continue;
    const key = item.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}
function extractPlainTextFromLexical$2(content) {
  if (!(content == null ? void 0 : content.trim()))
    return "";
  try {
    const parsed = JSON.parse(content);
    const texts = [];
    const walk = (node) => {
      if (!node || typeof node !== "object")
        return;
      if (typeof node.text === "string") {
        texts.push(node.text);
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(walk);
      }
    };
    walk((parsed == null ? void 0 : parsed.root) || parsed);
    return texts.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return content.replace(/\s+/g, " ").trim();
  }
}
function estimateTokenCount(text) {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 1.5 + otherChars * 0.4);
}
class ContextBuilder {
  async buildForCreativeAssets(payload) {
    const includeEntities = payload.includeExistingEntities !== false;
    const contextChapterCount = Math.max(0, Math.min(8, payload.contextChapterCount ?? 0));
    const filterCompleted = payload.filterCompletedPlotLines !== false;
    const warnings = [];
    const [characters, items, plotLines, worldSettings, recentChapters, narrativeSummariesRaw] = await Promise.all([
      includeEntities ? db.character.findMany({
        where: { novelId: payload.novelId },
        select: { name: true, role: true, description: true },
        orderBy: { updatedAt: "desc" },
        take: 30
      }) : [],
      includeEntities ? db.item.findMany({
        where: { novelId: payload.novelId },
        select: { name: true, type: true, description: true },
        orderBy: { updatedAt: "desc" },
        take: 30
      }) : [],
      includeEntities ? db.plotLine.findMany({
        where: { novelId: payload.novelId },
        include: {
          points: {
            select: { title: true, status: true, description: true },
            orderBy: { order: "asc" }
          }
        },
        orderBy: { sortOrder: "asc" }
      }) : [],
      // 世界观始终全量传递
      db.worldSetting.findMany({
        where: { novelId: payload.novelId },
        select: { name: true, content: true, type: true },
        orderBy: { sortOrder: "asc" }
      }),
      contextChapterCount > 0 ? db.chapter.findMany({
        where: { volume: { novelId: payload.novelId } },
        select: { id: true, title: true, content: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: contextChapterCount
      }) : [],
      db.narrativeSummary.findMany({
        where: {
          novelId: payload.novelId,
          isLatest: true,
          status: "active",
          level: "novel"
        },
        orderBy: { updatedAt: "desc" },
        take: 1
      })
    ]);
    const processedPlotLines = plotLines.map((pl) => {
      const points = Array.isArray(pl.points) ? pl.points : [];
      const filteredPoints = filterCompleted ? points.filter((p) => p.status !== "resolved") : points;
      return {
        name: String(pl.name || ""),
        description: pl.description ? String(pl.description) : void 0,
        points: filteredPoints.map((p) => ({
          title: String(p.title || ""),
          status: String(p.status || "active")
        }))
      };
    });
    const recentChapterIds = recentChapters.map((ch) => ch.id);
    const chapterSummaries = recentChapterIds.length > 0 ? await db.chapterSummary.findMany({
      where: {
        chapterId: { in: recentChapterIds },
        isLatest: true,
        status: "active"
      },
      orderBy: { updatedAt: "desc" }
    }) : [];
    const summaryByChapterId = /* @__PURE__ */ new Map();
    for (const s of chapterSummaries) {
      if (!summaryByChapterId.has(s.chapterId)) {
        summaryByChapterId.set(s.chapterId, s);
      }
    }
    let fallbackCount = 0;
    const recentSummaries = recentChapters.map((ch) => {
      const summary = summaryByChapterId.get(ch.id);
      const summaryText = (summary == null ? void 0 : summary.compressedMemory) || (summary == null ? void 0 : summary.summaryText);
      if (typeof summaryText === "string" && summaryText.trim()) {
        return { chapterId: ch.id, title: ch.title || "", summary: summaryText.slice(0, 800) };
      }
      fallbackCount++;
      return {
        chapterId: ch.id,
        title: ch.title || "",
        summary: extractPlainTextFromLexical$2(ch.content || "").slice(0, 600)
      };
    });
    if (fallbackCount > 0) {
      warnings.push(`${fallbackCount} 个章节缺少摘要，已使用原文摘录替代。`);
    }
    const narrativeSummaries = narrativeSummariesRaw.map((item) => {
      let keyFacts = [];
      if (typeof item.keyFacts === "string" && item.keyFacts.trim()) {
        try {
          const parsed = JSON.parse(item.keyFacts);
          if (Array.isArray(parsed)) {
            keyFacts = uniqueArray(
              parsed.map((f) => String(f || "").trim()).filter(Boolean).slice(0, 12)
            ).slice(0, 8);
          }
        } catch {
        }
      }
      return {
        level: item.level === "volume" ? "volume" : "novel",
        title: String(item.title || ""),
        summaryText: String(item.summaryText || "").slice(0, 1500),
        keyFacts
      };
    });
    const existingEntities = {
      characters: characters.map((c) => ({
        name: String(c.name || ""),
        role: c.role ? String(c.role) : void 0,
        description: c.description ? String(c.description).slice(0, 200) : void 0
      })),
      items: items.map((i) => ({
        name: String(i.name || ""),
        type: i.type ? String(i.type) : void 0,
        description: i.description ? String(i.description).slice(0, 200) : void 0
      })),
      plotLines: processedPlotLines,
      worldSettings: worldSettings.map((w) => ({
        name: String(w.name || ""),
        content: String(w.content || ""),
        type: String(w.type || "other")
      }))
    };
    const contextJson = JSON.stringify({ existingEntities, recentSummaries, narrativeSummaries });
    const estimatedTokens = estimateTokenCount(contextJson);
    const usedContext = [];
    if (existingEntities.characters.length > 0)
      usedContext.push(`characters_${existingEntities.characters.length}`);
    if (existingEntities.items.length > 0)
      usedContext.push(`items_${existingEntities.items.length}`);
    if (existingEntities.plotLines.length > 0)
      usedContext.push(`plotLines_${existingEntities.plotLines.length}`);
    usedContext.push(`worldSettings_${existingEntities.worldSettings.length}`);
    if (recentSummaries.length > 0)
      usedContext.push(`recentChapterSummaries_${recentSummaries.length}`);
    if (narrativeSummaries.length > 0)
      usedContext.push(`narrativeSummaries_${narrativeSummaries.length}`);
    usedContext.push(`estimatedTokens_${estimatedTokens}`);
    return {
      existingEntities,
      recentSummaries,
      narrativeSummaries,
      usedContext,
      warnings,
      estimatedTokens
    };
  }
  async buildForContinueWriting(payload) {
    const contextChapterCount = Math.max(1, Math.min(8, payload.contextChapterCount ?? 3));
    const recentRawChapterCount = Math.max(0, Math.min(contextChapterCount, payload.recentRawChapterCount ?? 2));
    const [worldSettings, plotLines, characters, items, maps, recentChapters, currentChapter] = await Promise.all([
      db.worldSetting.findMany({
        where: { novelId: payload.novelId },
        orderBy: { updatedAt: "desc" }
      }),
      db.plotLine.findMany({
        where: { novelId: payload.novelId },
        include: { points: { include: { anchors: true } } },
        orderBy: { sortOrder: "asc" }
      }),
      db.character.findMany({
        where: { novelId: payload.novelId },
        select: { name: true, role: true, description: true },
        orderBy: { updatedAt: "desc" },
        take: 100
      }),
      db.item.findMany({
        where: { novelId: payload.novelId },
        select: { name: true, type: true, description: true },
        orderBy: { updatedAt: "desc" },
        take: 100
      }),
      db.mapCanvas.findMany({
        where: { novelId: payload.novelId },
        select: { name: true, type: true, description: true },
        orderBy: { updatedAt: "desc" },
        take: 50
      }),
      db.chapter.findMany({
        where: {
          id: { not: payload.chapterId },
          volume: { novelId: payload.novelId }
        },
        select: {
          id: true,
          title: true,
          content: true,
          updatedAt: true
        },
        orderBy: { updatedAt: "desc" },
        take: contextChapterCount
      }),
      db.chapter.findUnique({
        where: { id: payload.chapterId },
        select: { volumeId: true }
      })
    ]);
    const requestedIdeaIds = Array.isArray(payload.ideaIds) ? payload.ideaIds.map((id) => String(id)).filter(Boolean) : [];
    const selectedIdeasRaw = requestedIdeaIds.length > 0 ? await db.idea.findMany({
      where: {
        novelId: payload.novelId,
        id: { in: requestedIdeaIds }
      },
      include: { tags: true },
      orderBy: { updatedAt: "desc" },
      take: 20
    }) : [];
    const recentChapterIds = recentChapters.map((chapter) => chapter.id);
    const latestSummaries = recentChapterIds.length > 0 ? await db.chapterSummary.findMany({
      where: {
        chapterId: { in: recentChapterIds },
        isLatest: true,
        status: "active"
      },
      orderBy: { updatedAt: "desc" }
    }) : [];
    const summaryByChapterId = /* @__PURE__ */ new Map();
    for (const summary of latestSummaries) {
      if (!summaryByChapterId.has(summary.chapterId)) {
        summaryByChapterId.set(summary.chapterId, summary);
      }
    }
    const fallbackCount = { value: 0 };
    const latestNarrativeSummaries = await db.narrativeSummary.findMany({
      where: {
        novelId: payload.novelId,
        isLatest: true,
        status: "active",
        OR: [
          { level: "novel", volumeId: null },
          ...(currentChapter == null ? void 0 : currentChapter.volumeId) ? [{ level: "volume", volumeId: currentChapter.volumeId }] : []
        ]
      },
      orderBy: { updatedAt: "desc" },
      take: 2
    });
    const narrativeSummaries = latestNarrativeSummaries.map((item) => {
      let keyFacts = [];
      if (typeof item.keyFacts === "string" && item.keyFacts.trim()) {
        try {
          const parsed = JSON.parse(item.keyFacts);
          if (Array.isArray(parsed)) {
            keyFacts = uniqueArray(
              parsed.map((fact) => String(fact || "").trim()).filter(Boolean).slice(0, 12)
            ).slice(0, 5);
          }
        } catch {
          keyFacts = [];
        }
      }
      return {
        level: item.level === "volume" ? "volume" : "novel",
        title: String(item.title || ""),
        summaryText: String(item.summaryText || "").slice(0, 1200),
        keyFacts
      };
    });
    const recentChapterItems = recentChapters.map((chapter, index) => ({
      chapterId: chapter.id,
      title: chapter.title || "",
      excerpt: (() => {
        if (index < recentRawChapterCount) {
          return extractPlainTextFromLexical$2(chapter.content || "").slice(-1200);
        }
        const summary = summaryByChapterId.get(chapter.id);
        const summaryText = (summary == null ? void 0 : summary.compressedMemory) || (summary == null ? void 0 : summary.summaryText);
        if (typeof summaryText === "string" && summaryText.trim()) {
          return summaryText.slice(-1200);
        }
        fallbackCount.value += 1;
        return extractPlainTextFromLexical$2(chapter.content || "").slice(-1200);
      })()
    }));
    const currentChapterBeforeCursor = extractPlainTextFromLexical$2(payload.currentContent || "").slice(-2400);
    const selectedIdeas = selectedIdeasRaw.map((idea) => ({
      ideaId: idea.id,
      content: (idea.content || "").slice(0, 800),
      quote: typeof idea.quote === "string" ? idea.quote.slice(0, 300) : void 0,
      tags: Array.isArray(idea.tags) ? idea.tags.map((tag) => String(tag.name || "").trim()).filter(Boolean).slice(0, 12) : []
    }));
    const entityIndex = {
      characters: new Set(
        characters.map((item) => String((item == null ? void 0 : item.name) || "").trim()).filter(Boolean)
      ),
      items: new Set(
        items.map((item) => String((item == null ? void 0 : item.name) || "").trim()).filter(Boolean)
      ),
      worldSettings: new Set(
        worldSettings.map((item) => String((item == null ? void 0 : item.name) || "").trim()).filter(Boolean)
      )
    };
    const entityMatches = [];
    const mentionRegex = /@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g;
    for (const idea of selectedIdeas) {
      const text = `${idea.content || ""}
${idea.quote || ""}`;
      const hits = Array.from(text.matchAll(mentionRegex));
      for (const hit of hits) {
        const name = String(hit[1] || "").trim();
        if (!name)
          continue;
        if (entityIndex.characters.has(name)) {
          entityMatches.push({ name, kind: "character" });
        } else if (entityIndex.items.has(name)) {
          entityMatches.push({ name, kind: "item" });
        } else if (entityIndex.worldSettings.has(name)) {
          entityMatches.push({ name, kind: "worldSetting" });
        }
      }
    }
    const selectedIdeaEntities = uniqueArray(entityMatches.map((item) => `${item.kind}:${item.name}`)).map((encoded) => {
      const [kind, ...nameRest] = encoded.split(":");
      const name = nameRest.join(":");
      return {
        name,
        kind: kind === "character" || kind === "item" || kind === "worldSetting" ? kind : "character"
      };
    }).slice(0, 20);
    const currentLocation = String(payload.currentLocation || "").trim().slice(0, 120);
    const missingIdeaCount = Math.max(0, requestedIdeaIds.length - selectedIdeas.length);
    const warnings = [];
    if (fallbackCount.value > 0) {
      warnings.push(`${fallbackCount.value} chapter summaries missing; fell back to chapter text excerpts.`);
    }
    if (missingIdeaCount > 0) {
      warnings.push(`${missingIdeaCount} selected ideas not found; ignored.`);
    }
    return {
      hardContext: {
        worldSettings,
        plotLines,
        characters,
        items,
        maps
      },
      dynamicContext: {
        recentChapters: recentChapterItems,
        selectedIdeas,
        selectedIdeaEntities,
        currentChapterBeforeCursor,
        ...currentLocation ? { currentLocation } : {},
        narrativeSummaries
      },
      params: {
        mode: payload.mode === "new_chapter" ? "new_chapter" : "continue_chapter",
        contextChapterCount,
        style: payload.style || "default",
        tone: payload.tone || "balanced",
        pace: payload.pace || "medium",
        targetLength: Math.max(100, Math.min(4e3, payload.targetLength ?? 500))
      },
      usedContext: [
        "world_settings_full",
        "plot_outline_full",
        "characters_items_maps_snapshot",
        `recent_chapter_summary_memory_preferred_${contextChapterCount}`,
        `recent_chapter_raw_text_${recentRawChapterCount}`,
        narrativeSummaries.length > 0 ? `narrative_summaries_${narrativeSummaries.length}` : "narrative_summaries_0",
        selectedIdeas.length > 0 ? `selected_ideas_${selectedIdeas.length}` : "selected_ideas_0",
        selectedIdeaEntities.length > 0 ? `selected_idea_entities_${selectedIdeaEntities.length}` : "selected_idea_entities_0",
        ...currentLocation ? ["current_location"] : [],
        "current_chapter_before_cursor"
      ],
      warnings
    };
  }
}
const CJK_STOP_WORDS = /* @__PURE__ */ new Set([
  "当前",
  "现在",
  "后续",
  "之后",
  "后面",
  "剧情",
  "大纲",
  "应该",
  "怎么",
  "是否",
  "还有",
  "哪些",
  "这个",
  "那个",
  "角色",
  "状态",
  "写作",
  "伏笔",
  "回收",
  "冲突",
  "前文",
  "设定",
  "什么",
  "一下",
  "分析"
]);
const EN_STOP_WORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "is",
  "are",
  "what",
  "where",
  "when",
  "how",
  "does",
  "do",
  "after",
  "next",
  "current"
]);
function unique(values) {
  const seen = /* @__PURE__ */ new Set();
  const output = [];
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value)
      continue;
    const key = value.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}
function detectRagIntent(question) {
  const text = question.toLowerCase();
  if (/冲突|矛盾|一致|合理|consisten|conflict/.test(text))
    return "consistency_check";
  if (/伏笔|坑|悬念|未解|没回收|未回收|unresolved|thread|foreshadow/.test(text))
    return "unresolved_threads";
  if (/大纲|接下来|下一步|后续写|怎么写|outline|next beat|next/.test(text))
    return "outline_next";
  if (/后续|后面|之后|还有戏|还有剧情|未来|安排|future|later/.test(text))
    return "future_plot_for_entity";
  if (/当前|现在|状态|在哪里|位置|持有|关系|current|state|status|where/.test(text))
    return "character_state";
  return "general_qa";
}
function extractQuestionKeywords(question) {
  const atMentions = Array.from(question.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g)).map((match) => String(match[1] || "").trim()).filter(Boolean);
  const cjkWords = Array.from(question.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g)).map((match) => match[0]).filter((word) => !CJK_STOP_WORDS.has(word));
  const latinWords = Array.from(question.matchAll(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g)).map((match) => match[0]).filter((word) => !EN_STOP_WORDS.has(word.toLowerCase()));
  return unique([...atMentions, ...cjkWords, ...latinWords]).slice(0, 8);
}
function detectRagQuestion(question, knownEntityNames) {
  const normalizedQuestion = String(question || "");
  const lowerQuestion = normalizedQuestion.toLowerCase();
  const exactMatches = knownEntityNames.map((name) => String(name || "").trim()).filter(Boolean).filter((name) => lowerQuestion.includes(name.toLowerCase()));
  const atMentions = Array.from(normalizedQuestion.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g)).map((match) => String(match[1] || "").trim()).filter(Boolean);
  return {
    intent: detectRagIntent(normalizedQuestion),
    entityNames: unique([...exactMatches, ...atMentions]).slice(0, 8),
    keywords: extractQuestionKeywords(normalizedQuestion)
  };
}
function joinUrl(baseUrl, path2) {
  return `${baseUrl.replace(/\/+$/, "")}/${path2.replace(/^\/+/, "")}`;
}
async function transportFetch(url, init) {
  try {
    return await net.fetch(url, init);
  } catch {
    return await fetch(url, init);
  }
}
function normalizeEmbedding(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}
function resolveEmbeddingUrl(baseUrl) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/embeddings"))
    return normalized;
  if (normalized.endsWith("/v1"))
    return joinUrl(normalized, "embeddings");
  return joinUrl(normalized, "v1/embeddings");
}
class EmbeddingClient {
  constructor(settings) {
    this.settings = settings;
  }
  isEnabled() {
    return Boolean(this.settings.enabled && this.settings.baseUrl.trim() && this.settings.model.trim());
  }
  async embed(input) {
    var _a, _b;
    if (!this.isEnabled()) {
      throw new Error("Embedding API is disabled or incomplete.");
    }
    const texts = input.map((item) => String(item || "").trim()).filter(Boolean);
    if (texts.length === 0) {
      return {
        embeddings: [],
        model: this.settings.model,
        dimensions: this.settings.dimensions || 0,
        provider: "openai-compatible"
      };
    }
    const controller = new AbortController();
    const timeout = Math.max(1e3, this.settings.timeoutMs || 6e4);
    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeout);
    const url = resolveEmbeddingUrl(this.settings.baseUrl);
    const body = {
      model: this.settings.model,
      input: texts
    };
    if (this.settings.dimensions && Number.isFinite(this.settings.dimensions)) {
      body.dimensions = this.settings.dimensions;
    }
    const startedAt = Date.now();
    try {
      devLog("INFO", "EmbeddingClient.embed.request", "Embedding request", {
        url,
        timeoutMs: timeout,
        body: redactForLog(body),
        inputCount: texts.length
      });
      const res = await transportFetch(url, {
        method: "POST",
        headers: {
          ...this.settings.apiKey.trim() ? { Authorization: `Bearer ${this.settings.apiKey}` } : {},
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const raw = await res.text();
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      if (!res.ok) {
        throw new Error(((_a = json == null ? void 0 : json.error) == null ? void 0 : _a.message) || `Embedding API rejected: ${res.status} ${raw.slice(0, 240)}`);
      }
      const data = Array.isArray(json == null ? void 0 : json.data) ? json.data : [];
      const embeddings = data.sort((a, b) => Number((a == null ? void 0 : a.index) || 0) - Number((b == null ? void 0 : b.index) || 0)).map((item) => normalizeEmbedding(item == null ? void 0 : item.embedding)).filter((item) => item.length > 0);
      const dimensions = ((_b = embeddings[0]) == null ? void 0 : _b.length) || this.settings.dimensions || 0;
      if (embeddings.length !== texts.length) {
        throw new Error(`Embedding API returned ${embeddings.length} vectors for ${texts.length} inputs.`);
      }
      devLog("INFO", "EmbeddingClient.embed.response", "Embedding response ok", {
        url,
        elapsedMs: Date.now() - startedAt,
        inputCount: texts.length,
        dimensions,
        model: (json == null ? void 0 : json.model) || this.settings.model
      });
      return {
        embeddings,
        model: (json == null ? void 0 : json.model) || this.settings.model,
        dimensions,
        provider: "openai-compatible"
      };
    } catch (error) {
      devLogError("EmbeddingClient.embed.error", error, {
        url,
        elapsedMs: Date.now() - startedAt,
        didTimeout,
        requestBody: redactForLog(body)
      });
      if (didTimeout) {
        throw new Error(`Embedding API timeout after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
const VECTOR_DIM = 384;
const MAX_CHUNK_CHARS = 900;
const CHUNK_OVERLAP_CHARS = 120;
const MIN_SIMILARITY = 0.08;
function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}
function extractPlainTextFromLexical$1(content) {
  if (!(content == null ? void 0 : content.trim()))
    return "";
  try {
    const parsed = JSON.parse(content);
    const texts = [];
    const walk = (node) => {
      if (!node || typeof node !== "object")
        return;
      if (typeof node.text === "string")
        texts.push(node.text);
      if (Array.isArray(node.children))
        node.children.forEach(walk);
    };
    walk((parsed == null ? void 0 : parsed.root) || parsed);
    return texts.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return content.replace(/\s+/g, " ").trim();
  }
}
function parseJsonArray$1(value) {
  if (typeof value !== "string" || !value.trim())
    return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function parseProfile$1(value) {
  if (typeof value !== "string" || !value.trim() || value.trim() === "{}")
    return "";
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object")
      return "";
    return Object.entries(parsed).map(([key, val]) => `${key}: ${String(val || "")}`).filter((line) => !line.endsWith(": ")).join("; ");
  } catch {
    return value;
  }
}
function tokenize(text) {
  const normalized = text.toLowerCase();
  const latin = Array.from(normalized.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)).map((match) => match[0]);
  const cjkRuns = Array.from(normalized.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)).map((match) => match[0]);
  const cjkTokens = [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      cjkTokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      cjkTokens.push(run.slice(i, i + 2));
    }
    if (run.length <= 4)
      cjkTokens.push(run);
  }
  return [...latin, ...cjkTokens].filter(Boolean);
}
function hashToken(token) {
  const digest = createHash("sha1").update(token).digest();
  const value = digest.readUInt32BE(0);
  return {
    index: value % VECTOR_DIM,
    sign: (digest[4] & 1) === 1 ? 1 : -1
  };
}
function embedText(text) {
  const vector = new Array(VECTOR_DIM).fill(0);
  const counts = /* @__PURE__ */ new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  for (const [token, count] of counts) {
    const { index, sign } = hashToken(token);
    vector[index] += sign * Math.log1p(count);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0)
    return vector;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}
function vectorToBlob(vector) {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) {
    buffer.writeFloatLE(Number.isFinite(vector[i]) ? vector[i] : 0, i * 4);
  }
  return buffer;
}
function blobToVector(blob, dim) {
  if (!blob)
    return [];
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const count = Math.floor(buffer.length / 4);
  const limit = dim && dim > 0 ? Math.min(dim, count) : count;
  const vector = [];
  for (let i = 0; i < limit; i += 1) {
    vector.push(buffer.readFloatLE(i * 4));
  }
  return vector;
}
function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1)
    sum += a[i] * b[i];
  return sum;
}
function chunkText(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized)
    return [];
  if (normalized.length <= MAX_CHUNK_CHARS)
    return [normalized];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + MAX_CHUNK_CHARS);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length)
      break;
    start = Math.max(0, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}
async function ensureRagVectorIndex() {
  await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS rag_vector_chunks (
            id TEXT PRIMARY KEY,
            novel_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            embedding_json TEXT NOT NULL,
            embedding_blob BLOB,
            embedding_dim INTEGER,
            embedding_provider TEXT NOT NULL DEFAULT 'hash',
            embedding_model TEXT NOT NULL DEFAULT 'local-hash-v1',
            content_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
  const columns = await db.$queryRawUnsafe("PRAGMA table_info(rag_vector_chunks);");
  const columnNames = new Set(columns.map((column) => column.name));
  const migrations = [
    ["embedding_blob", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_blob BLOB;"],
    ["embedding_dim", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_dim INTEGER;"],
    ["embedding_provider", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_provider TEXT NOT NULL DEFAULT 'hash';"],
    ["embedding_model", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'local-hash-v1';"]
  ];
  for (const [name, sql] of migrations) {
    if (!columnNames.has(name)) {
      await db.$executeRawUnsafe(sql);
    }
  }
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_novel ON rag_vector_chunks(novel_id);");
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_source ON rag_vector_chunks(source_type, source_id);");
}
async function buildVectorDocuments(novelId) {
  var _a;
  const [characters, items, worldSettings, plotLines, chapters, chapterSummaries, narrativeSummaries] = await Promise.all([
    db.character.findMany({
      where: { novelId },
      include: { items: { include: { item: true } } },
      orderBy: { sortOrder: "asc" }
    }),
    db.item.findMany({ where: { novelId }, orderBy: { sortOrder: "asc" } }),
    db.worldSetting.findMany({ where: { novelId }, orderBy: { sortOrder: "asc" } }),
    db.plotLine.findMany({
      where: { novelId },
      include: { points: { orderBy: { order: "asc" } } },
      orderBy: { sortOrder: "asc" }
    }),
    db.chapter.findMany({
      where: { volume: { novelId } },
      select: { id: true, title: true, content: true, order: true, volume: { select: { title: true, order: true } } },
      orderBy: [{ volume: { order: "asc" } }, { order: "asc" }]
    }),
    db.chapterSummary.findMany({
      where: { novelId, isLatest: true, status: "active" },
      orderBy: { updatedAt: "desc" }
    }),
    db.narrativeSummary.findMany({
      where: { novelId, isLatest: true, status: "active" },
      orderBy: { updatedAt: "desc" }
    })
  ]);
  const docs = [];
  for (const character of characters) {
    const profile = parseProfile$1(character.profile);
    const ownedItems = Array.isArray(character.items) ? character.items.map((owner) => {
      var _a2;
      return `${((_a2 = owner.item) == null ? void 0 : _a2.name) || ""}${owner.note ? ` ${owner.note}` : ""}`;
    }).filter(Boolean).join("; ") : "";
    docs.push({
      novelId,
      sourceType: "character",
      sourceId: character.id,
      title: `Character: ${character.name}`,
      content: [
        character.name,
        character.role,
        character.description,
        profile,
        ownedItems ? `Owned items: ${ownedItems}` : "",
        character.isStarred ? "starred important" : ""
      ].filter(Boolean).join("\n")
    });
  }
  for (const item of items) {
    docs.push({
      novelId,
      sourceType: "item",
      sourceId: item.id,
      title: `${item.type || "Item"}: ${item.name}`,
      content: [item.name, item.type, item.description, parseProfile$1(item.profile)].filter(Boolean).join("\n")
    });
  }
  for (const world of worldSettings) {
    docs.push({
      novelId,
      sourceType: "worldSetting",
      sourceId: world.id,
      title: `World: ${world.name}`,
      content: [world.name, world.type, world.content].filter(Boolean).join("\n")
    });
  }
  for (const line of plotLines) {
    docs.push({
      novelId,
      sourceType: "plotLine",
      sourceId: line.id,
      title: `Plot line: ${line.name}`,
      content: [line.name, line.description].filter(Boolean).join("\n")
    });
    for (const point of line.points || []) {
      docs.push({
        novelId,
        sourceType: "plotPoint",
        sourceId: point.id,
        title: `Plot point: ${point.title}`,
        content: [line.name, point.title, point.type, point.status, point.description].filter(Boolean).join("\n")
      });
    }
  }
  for (const chapter of chapters) {
    const plain = extractPlainTextFromLexical$1(chapter.content || "");
    if (!plain)
      continue;
    docs.push({
      novelId,
      sourceType: "chapter",
      sourceId: chapter.id,
      title: `${((_a = chapter.volume) == null ? void 0 : _a.title) || ""} ${chapter.title || ""}`.trim() || "Chapter",
      content: plain
    });
  }
  for (const summary of chapterSummaries) {
    docs.push({
      novelId,
      sourceType: "chapterSummary",
      sourceId: summary.id,
      title: `Chapter summary: ${summary.chapterId}`,
      content: [
        summary.compressedMemory || summary.summaryText,
        ...parseJsonArray$1(summary.keyFacts),
        ...parseJsonArray$1(summary.timelineHints),
        ...parseJsonArray$1(summary.openQuestions)
      ].filter(Boolean).join("\n")
    });
  }
  for (const summary of narrativeSummaries) {
    docs.push({
      novelId,
      sourceType: "narrativeSummary",
      sourceId: summary.id,
      title: `${summary.level || "novel"} summary: ${summary.title || "latest"}`,
      content: [
        summary.summaryText,
        ...parseJsonArray$1(summary.keyFacts),
        ...parseJsonArray$1(summary.unresolvedThreads),
        ...parseJsonArray$1(summary.hardConstraints)
      ].filter(Boolean).join("\n")
    });
  }
  return docs;
}
async function embedChunks(input) {
  const settings = input.settings;
  if ((settings == null ? void 0 : settings.enabled) && settings.baseUrl.trim()) {
    try {
      const client = new EmbeddingClient(settings);
      const batchSize = Math.max(1, Math.min(64, settings.batchSize || 8));
      const vectors2 = [];
      let model = settings.model;
      let dimensions = settings.dimensions || 0;
      for (let start = 0; start < input.texts.length; start += batchSize) {
        const batch = input.texts.slice(start, start + batchSize);
        const result = await client.embed(batch);
        vectors2.push(...result.embeddings);
        model = result.model;
        dimensions = result.dimensions;
      }
      return { vectors: vectors2, provider: "openai-compatible", model, dimensions, fallbackUsed: false };
    } catch (error) {
      if (!settings.fallbackToHash)
        throw error;
      console.warn("[RAG] Embedding API failed; falling back to local hash vectors:", error);
      const fallbackError = error instanceof Error ? error.message : String(error);
      const vectors2 = input.texts.map((text) => embedText(text));
      return { vectors: vectors2, provider: "hash", model: "local-hash-v1", dimensions: VECTOR_DIM, fallbackUsed: true, fallbackError };
    }
  }
  const vectors = input.texts.map((text) => embedText(text));
  return { vectors, provider: "hash", model: "local-hash-v1", dimensions: VECTOR_DIM, fallbackUsed: Boolean(settings == null ? void 0 : settings.enabled) };
}
async function rebuildRagVectorIndex(novelId, settings) {
  await ensureRagVectorIndex();
  const docs = await buildVectorDocuments(novelId);
  await db.$executeRaw`DELETE FROM rag_vector_chunks WHERE novel_id = ${novelId};`;
  const chunkRows = [];
  for (const doc of docs) {
    const parts = chunkText(doc.content);
    for (let index = 0; index < parts.length; index += 1) {
      chunkRows.push({ doc, index, content: parts[index] });
    }
  }
  const embedded = await embedChunks({
    texts: chunkRows.map((row) => `${row.doc.title}
${row.content}`),
    settings
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (let rowIndex = 0; rowIndex < chunkRows.length; rowIndex += 1) {
    const row = chunkRows[rowIndex];
    const vector = embedded.vectors[rowIndex] || embedText(`${row.doc.title}
${row.content}`);
    const contentHash = hashText(`${row.doc.sourceType}:${row.doc.sourceId}:${row.index}:${row.content}`);
    const id = hashText(`${row.doc.novelId}:${row.doc.sourceType}:${row.doc.sourceId}:${row.index}`);
    const embeddingJson = embedded.provider === "hash" ? JSON.stringify(vector) : "[]";
    const embeddingBlob = vectorToBlob(vector);
    const dim = vector.length;
    await db.$executeRaw`
            INSERT INTO rag_vector_chunks (id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim, embedding_provider, embedding_model, content_hash, updated_at)
            VALUES (${id}, ${row.doc.novelId}, ${row.doc.sourceType}, ${row.doc.sourceId}, ${row.doc.title}, ${row.content}, ${embeddingJson}, ${embeddingBlob}, ${dim}, ${embedded.provider}, ${embedded.model}, ${contentHash}, ${now});
        `;
  }
  return { chunks: chunkRows.length, sources: docs.length, provider: embedded.provider, model: embedded.model, dimensions: embedded.dimensions, fallbackUsed: embedded.fallbackUsed, fallbackError: embedded.fallbackError };
}
async function ensureRagVectorIndexForNovel(novelId, settings) {
  var _a;
  await ensureRagVectorIndex();
  const existing = await db.$queryRaw`
        SELECT COUNT(*) as count FROM rag_vector_chunks WHERE novel_id = ${novelId};
    `;
  const count = Number(((_a = existing[0]) == null ? void 0 : _a.count) || 0);
  if (count > 0)
    return { rebuilt: false, chunks: count };
  const result = await rebuildRagVectorIndex(novelId, settings);
  return { rebuilt: true, chunks: result.chunks, sources: result.sources };
}
async function queryRagVectorIndex(input) {
  var _a, _b;
  await ensureRagVectorIndexForNovel(input.novelId, input.settings);
  const rows = await db.$queryRaw`
        SELECT id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim
        FROM rag_vector_chunks
        WHERE novel_id = ${input.novelId};
    `;
  let queryVector = embedText(input.query);
  const firstDim = ((_a = rows.find((row) => Number(row.embedding_dim || 0) > 0)) == null ? void 0 : _a.embedding_dim) || 0;
  const firstHasBlob = rows.some((row) => row.embedding_blob);
  if (((_b = input.settings) == null ? void 0 : _b.enabled) && input.settings.baseUrl.trim() && firstHasBlob && firstDim !== VECTOR_DIM) {
    try {
      const client = new EmbeddingClient(input.settings);
      const result = await client.embed([input.query]);
      queryVector = result.embeddings[0] || queryVector;
    } catch (error) {
      if (!input.settings.fallbackToHash)
        throw error;
      console.warn("[RAG] Query embedding API failed; falling back to local hash vector:", error);
    }
  }
  return rows.map((row) => {
    let vector = blobToVector(row.embedding_blob, row.embedding_dim);
    if (vector.length === 0 && row.embedding_json) {
      try {
        const parsed = JSON.parse(row.embedding_json);
        vector = Array.isArray(parsed) ? parsed.map((value) => Number(value) || 0) : [];
      } catch {
        vector = [];
      }
    }
    const similarity = cosine(queryVector, vector);
    return {
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      title: row.title,
      excerpt: row.content,
      metadata: { vectorSimilarity: Number(similarity.toFixed(4)), retrieval: "local_vector_hash" },
      score: Math.round(similarity * 100)
    };
  }).filter((item) => {
    var _a2;
    return Number(((_a2 = item.metadata) == null ? void 0 : _a2.vectorSimilarity) || 0) >= MIN_SIMILARITY;
  }).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, Math.max(1, Math.min(16, input.limit ?? 8)));
}
function trimText$1(value, maxLen) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text)
    return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
function parseJsonArray(value) {
  if (typeof value !== "string" || !value.trim())
    return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed))
      return [];
    return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function parseProfile(value) {
  if (typeof value !== "string" || !value.trim() || value.trim() === "{}")
    return "";
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object")
      return "";
    return Object.entries(parsed).map(([key, val]) => `${key}: ${String(val || "")}`).filter((line) => !line.endsWith(": ")).join("; ");
  } catch {
    return value;
  }
}
function hasEntityMatch(text, entityNames) {
  const haystack = String(text || "").toLowerCase();
  return entityNames.some((name) => haystack.includes(name.toLowerCase()));
}
function scoreForIntent(base, intent, sourceType) {
  if (intent === "future_plot_for_entity" && sourceType === "plotPoint")
    return base + 40;
  if (intent === "outline_next" && (sourceType === "plotPoint" || sourceType === "plotLine"))
    return base + 35;
  if (intent === "character_state" && (sourceType === "character" || sourceType === "relationship" || sourceType === "item" || sourceType === "map"))
    return base + 30;
  if (intent === "unresolved_threads" && (sourceType === "narrativeSummary" || sourceType === "chapterSummary" || sourceType === "plotPoint"))
    return base + 25;
  return base;
}
function addEvidence(items, input) {
  const id = `E${items.length + 1}`;
  const excerpt = trimText$1(input.excerpt, 900);
  if (!excerpt)
    return;
  items.push({ id, ...input, excerpt });
}
async function getKnownRagEntityNames(novelId) {
  const [characters, items, worldSettings] = await Promise.all([
    db.character.findMany({ where: { novelId }, select: { name: true } }),
    db.item.findMany({ where: { novelId }, select: { name: true } }),
    db.worldSetting.findMany({ where: { novelId }, select: { name: true } })
  ]);
  const names = [...characters, ...items, ...worldSettings].map((item) => String((item == null ? void 0 : item.name) || "").trim()).filter(Boolean);
  return Array.from(new Set(names));
}
async function collectRagEvidence(input) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  const maxEvidenceItems = Math.max(4, Math.min(24, input.maxEvidenceItems ?? 12));
  const entityNames = input.detection.entityNames;
  const keywords = input.detection.keywords;
  const intent = input.detection.intent;
  const evidence = [];
  const warnings = [];
  const usedContext = /* @__PURE__ */ new Set();
  const isZh = (input.locale || "zh").startsWith("zh");
  const [characters, items, worldSettings, plotLines, narrativeSummaries, chapterSummaries, currentChapter] = await Promise.all([
    db.character.findMany({
      where: { novelId: input.novelId },
      include: {
        items: { include: { item: true } },
        relationsAsSource: { include: { target: true } },
        relationsAsTarget: { include: { source: true } },
        mapMarkers: { include: { map: true } }
      },
      orderBy: [{ isStarred: "desc" }, { sortOrder: "asc" }],
      take: 100
    }),
    db.item.findMany({
      where: { novelId: input.novelId },
      include: { owners: { include: { character: true } } },
      orderBy: { sortOrder: "asc" },
      take: 120
    }),
    db.worldSetting.findMany({
      where: { novelId: input.novelId },
      orderBy: { sortOrder: "asc" },
      take: 80
    }),
    db.plotLine.findMany({
      where: { novelId: input.novelId },
      include: {
        points: {
          include: {
            anchors: { include: { chapter: { select: { title: true, order: true, volume: { select: { title: true, order: true } } } } } }
          },
          orderBy: { order: "asc" }
        }
      },
      orderBy: { sortOrder: "asc" }
    }),
    db.narrativeSummary.findMany({
      where: { novelId: input.novelId, isLatest: true, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: 3
    }),
    db.chapterSummary.findMany({
      where: { novelId: input.novelId, isLatest: true, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: 12
    }),
    input.chapterId ? db.chapter.findUnique({
      where: { id: input.chapterId },
      select: { id: true, title: true, order: true, volume: { select: { title: true, order: true } } }
    }) : null
  ]);
  if ((_a = input.selectedText) == null ? void 0 : _a.trim()) {
    addEvidence(evidence, {
      sourceType: "currentContext",
      sourceId: input.chapterId || "selectedText",
      title: "Selected text",
      excerpt: input.selectedText,
      score: 95
    });
    usedContext.add("selected_text");
  }
  if ((_b = input.currentContent) == null ? void 0 : _b.trim()) {
    addEvidence(evidence, {
      sourceType: "currentContext",
      sourceId: input.chapterId || "currentContent",
      title: (currentChapter == null ? void 0 : currentChapter.title) ? `Current chapter: ${currentChapter.title}` : "Current chapter context",
      excerpt: input.currentContent.slice(-1600),
      metadata: currentChapter ? { chapterOrder: currentChapter.order, volumeTitle: (_c = currentChapter.volume) == null ? void 0 : _c.title } : void 0,
      score: 55
    });
    usedContext.add("current_chapter_context");
  }
  if ((_d = input.currentLocation) == null ? void 0 : _d.trim()) {
    addEvidence(evidence, {
      sourceType: "currentContext",
      sourceId: "currentLocation",
      title: "Current location",
      excerpt: input.currentLocation,
      score: 50
    });
    usedContext.add("current_location");
  }
  const vectorEvidence = await queryRagVectorIndex({
    novelId: input.novelId,
    query: input.question,
    limit: Math.min(8, maxEvidenceItems),
    settings: input.embeddingSettings
  });
  for (const item of vectorEvidence) {
    addEvidence(evidence, {
      ...item,
      score: 90 + Math.max(0, item.score || 0)
    });
  }
  if (vectorEvidence.length > 0) {
    usedContext.add("vector_chunks");
  }
  const relevantCharacters = characters.filter((character) => entityNames.length === 0 ? keywords.some((keyword) => hasEntityMatch(`${character.name} ${character.role} ${character.description} ${character.profile}`, [keyword])) : hasEntityMatch(character.name, entityNames));
  for (const character of relevantCharacters.slice(0, 8)) {
    const profile = parseProfile(character.profile);
    const ownedItems = Array.isArray(character.items) ? character.items.map((owner) => {
      var _a2;
      return `${((_a2 = owner.item) == null ? void 0 : _a2.name) || ""}${owner.note ? `(${owner.note})` : ""}`;
    }).filter(Boolean).join(", ") : "";
    addEvidence(evidence, {
      sourceType: "character",
      sourceId: character.id,
      title: `Character: ${character.name}`,
      excerpt: [
        character.role ? `Role: ${character.role}` : "",
        character.description ? `Description: ${character.description}` : "",
        profile ? `Profile: ${profile}` : "",
        ownedItems ? `Owned items: ${ownedItems}` : ""
      ].filter(Boolean).join("\n"),
      metadata: { name: character.name, isStarred: character.isStarred },
      score: scoreForIntent(100 + (character.isStarred ? 10 : 0), intent, "character")
    });
    usedContext.add("characters");
    for (const relation of [...character.relationsAsSource || [], ...character.relationsAsTarget || []].slice(0, 8)) {
      const other = ((_e = relation.target) == null ? void 0 : _e.name) || ((_f = relation.source) == null ? void 0 : _f.name) || "";
      addEvidence(evidence, {
        sourceType: "relationship",
        sourceId: relation.id,
        title: `Relationship: ${character.name} - ${other}`,
        excerpt: `${relation.relation || ""}${relation.description ? `: ${relation.description}` : ""}`,
        metadata: { characterName: character.name, relatedName: other },
        score: scoreForIntent(80, intent, "relationship")
      });
    }
    for (const marker of (character.mapMarkers || []).slice(0, 6)) {
      addEvidence(evidence, {
        sourceType: "map",
        sourceId: marker.id,
        title: `Map: ${((_g = marker.map) == null ? void 0 : _g.name) || marker.mapId}`,
        excerpt: `${character.name} marker${marker.label ? `: ${marker.label}` : ""}`,
        metadata: { characterName: character.name, mapId: marker.mapId, mapType: (_h = marker.map) == null ? void 0 : _h.type },
        score: scoreForIntent(70, intent, "map")
      });
    }
  }
  for (const item of items) {
    const itemText = `${item.name} ${item.type} ${item.description} ${item.profile}`;
    if (entityNames.length > 0 && !hasEntityMatch(itemText, entityNames))
      continue;
    if (entityNames.length === 0 && !keywords.some((keyword) => hasEntityMatch(itemText, [keyword])))
      continue;
    const profile = parseProfile(item.profile);
    const owners = Array.isArray(item.owners) ? item.owners.map((owner) => {
      var _a2;
      return `${((_a2 = owner.character) == null ? void 0 : _a2.name) || ""}${owner.note ? `(${owner.note})` : ""}`;
    }).filter(Boolean).join(", ") : "";
    addEvidence(evidence, {
      sourceType: "item",
      sourceId: item.id,
      title: `${item.type || "Item"}: ${item.name}`,
      excerpt: [
        item.description ? `Description: ${item.description}` : "",
        profile ? `Profile: ${profile}` : "",
        owners ? `Owners: ${owners}` : ""
      ].filter(Boolean).join("\n"),
      score: scoreForIntent(78, intent, "item")
    });
    usedContext.add("items");
  }
  for (const world of worldSettings) {
    const worldText = `${world.name} ${world.content} ${world.type}`;
    if (entityNames.length > 0 && !hasEntityMatch(worldText, entityNames))
      continue;
    if (entityNames.length === 0 && !keywords.some((keyword) => hasEntityMatch(worldText, [keyword])))
      continue;
    addEvidence(evidence, {
      sourceType: "worldSetting",
      sourceId: world.id,
      title: `World: ${world.name}`,
      excerpt: world.content,
      metadata: { type: world.type },
      score: 65
    });
    usedContext.add("world_settings");
  }
  for (const line of plotLines) {
    const lineMatches = entityNames.length === 0 ? keywords.some((keyword) => hasEntityMatch(`${line.name} ${line.description}`, [keyword])) : hasEntityMatch(`${line.name} ${line.description}`, entityNames);
    if (lineMatches || intent === "outline_next" || intent === "unresolved_threads") {
      addEvidence(evidence, {
        sourceType: "plotLine",
        sourceId: line.id,
        title: `Plot line: ${line.name}`,
        excerpt: line.description || line.name,
        score: scoreForIntent(lineMatches ? 85 : 45, intent, "plotLine")
      });
      usedContext.add("plot_outline");
    }
    for (const point of line.points || []) {
      const pointText = `${line.name} ${line.description || ""} ${point.title} ${point.description || ""}`;
      const matches = entityNames.length === 0 ? keywords.some((keyword) => hasEntityMatch(pointText, [keyword])) : hasEntityMatch(pointText, entityNames);
      const includeForOutline = intent === "outline_next" && point.status !== "resolved";
      const includeForThreads = intent === "unresolved_threads" && point.status !== "resolved";
      if (!matches && !includeForOutline && !includeForThreads)
        continue;
      const anchors = Array.isArray(point.anchors) ? point.anchors.map((anchor) => {
        var _a2;
        const chapter = anchor.chapter;
        return `${anchor.type}: ${((_a2 = chapter == null ? void 0 : chapter.volume) == null ? void 0 : _a2.title) || ""} ${(chapter == null ? void 0 : chapter.title) || anchor.chapterId}`.trim();
      }).join("; ") : "";
      addEvidence(evidence, {
        sourceType: "plotPoint",
        sourceId: point.id,
        title: `Plot point: ${point.title}`,
        excerpt: [
          `Line: ${line.name}`,
          `Status: ${point.status || "active"}`,
          point.description ? `Description: ${point.description}` : "",
          anchors ? `Anchors: ${anchors}` : ""
        ].filter(Boolean).join("\n"),
        metadata: { plotLineId: line.id, status: point.status, type: point.type },
        score: scoreForIntent((matches ? 105 : 70) + (point.status === "resolved" ? -20 : 20), intent, "plotPoint")
      });
      usedContext.add("plot_points");
    }
  }
  for (const summary of narrativeSummaries) {
    const unresolvedThreads = parseJsonArray(summary.unresolvedThreads);
    const keyFacts = parseJsonArray(summary.keyFacts);
    const hardConstraints = parseJsonArray(summary.hardConstraints);
    const summaryText = [
      summary.summaryText,
      keyFacts.length ? `Key facts: ${keyFacts.join("; ")}` : "",
      unresolvedThreads.length ? `Unresolved threads: ${unresolvedThreads.join("; ")}` : "",
      hardConstraints.length ? `Hard constraints: ${hardConstraints.join("; ")}` : ""
    ].filter(Boolean).join("\n");
    const matches = entityNames.length === 0 ? keywords.some((keyword) => hasEntityMatch(summaryText, [keyword])) : hasEntityMatch(summaryText, entityNames);
    if (!matches && !["outline_next", "unresolved_threads", "general_qa"].includes(intent))
      continue;
    addEvidence(evidence, {
      sourceType: "narrativeSummary",
      sourceId: summary.id,
      title: `${summary.level || "novel"} summary: ${summary.title || "latest"}`,
      excerpt: summaryText,
      score: scoreForIntent(matches ? 90 : 55, intent, "narrativeSummary")
    });
    usedContext.add("narrative_summaries");
  }
  for (const summary of chapterSummaries) {
    const openQuestions = parseJsonArray(summary.openQuestions);
    const timelineHints = parseJsonArray(summary.timelineHints);
    const keyFacts = parseJsonArray(summary.keyFacts);
    const summaryText = [
      summary.compressedMemory || summary.summaryText,
      keyFacts.length ? `Key facts: ${keyFacts.join("; ")}` : "",
      timelineHints.length ? `Timeline hints: ${timelineHints.join("; ")}` : "",
      openQuestions.length ? `Open questions: ${openQuestions.join("; ")}` : ""
    ].filter(Boolean).join("\n");
    const matches = entityNames.length === 0 ? keywords.some((keyword) => hasEntityMatch(summaryText, [keyword])) : hasEntityMatch(summaryText, entityNames);
    if (!matches && intent !== "unresolved_threads")
      continue;
    addEvidence(evidence, {
      sourceType: "chapterSummary",
      sourceId: summary.id,
      title: `Chapter summary: ${summary.chapterId}`,
      excerpt: summaryText,
      metadata: { chapterId: summary.chapterId, chapterOrder: summary.chapterOrder },
      score: scoreForIntent(matches ? 85 : 60, intent, "chapterSummary")
    });
    usedContext.add("chapter_summaries");
  }
  const searchTerms = Array.from(/* @__PURE__ */ new Set([...entityNames, ...keywords])).slice(0, 6);
  for (const term of searchTerms) {
    const hits = await search(input.novelId, term, 5, 0);
    for (const hit of hits.slice(0, 4)) {
      addEvidence(evidence, {
        sourceType: hit.entityType === "idea" ? "idea" : "searchHit",
        sourceId: hit.entityId,
        title: hit.title || term,
        excerpt: hit.preview || hit.snippet,
        metadata: {
          keyword: term,
          chapterId: hit.chapterId,
          volumeTitle: hit.volumeTitle,
          matchType: hit.matchType
        },
        score: hit.matchType === "title" ? 62 : 42
      });
      usedContext.add("search_hits");
    }
  }
  const deduped = /* @__PURE__ */ new Map();
  for (const item of evidence) {
    const key = `${item.sourceType}:${item.sourceId}:${item.title}`;
    const existing = deduped.get(key);
    if (!existing || (item.score || 0) > (existing.score || 0)) {
      deduped.set(key, item);
    }
  }
  const ranked = Array.from(deduped.values()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, maxEvidenceItems).map((item, index) => ({ ...item, id: `E${index + 1}` }));
  if (ranked.length === 0) {
    warnings.push(isZh ? "未找到相关证据，本次回答应视为低置信度。" : "No relevant evidence found. The answer should be treated as low confidence.");
  }
  return {
    evidence: ranked,
    warnings,
    usedContext: Array.from(usedContext)
  };
}
function buildRawPromptPreview$1(systemPrompt, userPrompt) {
  const sections = [];
  if (systemPrompt == null ? void 0 : systemPrompt.trim()) {
    sections.push(`[System Prompt]
${systemPrompt.trim()}`);
  }
  sections.push(`[User Prompt]
${userPrompt.trim()}`);
  return sections.join("\n\n");
}
function parseConfidence(text, evidenceCount) {
  const lower = text.toLowerCase();
  if (/不足以判断|资料不足|无法判断|insufficient|not enough/.test(lower))
    return "low";
  if (/confidence\s*[:：]\s*high|置信度\s*[:：]\s*高/.test(lower))
    return "high";
  if (/confidence\s*[:：]\s*low|置信度\s*[:：]\s*低/.test(lower))
    return "low";
  if (evidenceCount >= 5)
    return "high";
  if (evidenceCount >= 2)
    return "medium";
  return "low";
}
function extractCitations(answer, evidenceIds) {
  const found = /* @__PURE__ */ new Set();
  for (const match of answer.matchAll(/\[?(E\d+)\]?/g)) {
    const id = match[1];
    if (evidenceIds.includes(id))
      found.add(id);
  }
  return Array.from(found).map((id) => ({ evidenceId: id, label: `[${id}]` }));
}
class NovelRagService {
  async buildPromptBundle(payload, embeddingSettings) {
    var _a, _b, _c, _d;
    const question = String(payload.question || "").trim();
    if (!((_a = payload.novelId) == null ? void 0 : _a.trim())) {
      throw new Error("novelId is required");
    }
    if (!question) {
      throw new Error("question is required");
    }
    const knownEntityNames = await getKnownRagEntityNames(payload.novelId);
    const detection = detectRagQuestion(question, knownEntityNames);
    const collected = await collectRagEvidence({
      novelId: payload.novelId,
      chapterId: payload.chapterId,
      currentContent: payload.currentContent,
      selectedText: payload.selectedText,
      currentLocation: payload.currentLocation,
      detection,
      question,
      maxEvidenceItems: payload.maxEvidenceItems,
      locale: payload.locale,
      embeddingSettings
    });
    const evidenceBlock = collected.evidence.map((item) => `[${item.id}] ${item.sourceType} | ${item.title}
${item.excerpt}`).join("\n\n");
    const isZh = (payload.locale || "zh").startsWith("zh");
    const systemPrompt = isZh ? "你是小说编辑器中的 RAG 问答助手。你只能基于 Evidence 中提供的资料回答。如果资料不足，请明确说明不足以判断。请区分“已写事实”“大纲计划”“写作建议”。涉及剧情判断时必须引用证据标签，例如 [E1]。不要编造未提供的设定、章节或人物状态。" : "You are a RAG Q&A assistant inside a novel editor. Answer only from the provided Evidence. If evidence is insufficient, say so clearly. Separate written facts, outline plans, and writing suggestions. Cite evidence labels such as [E1]. Do not invent missing lore, chapters, or character state.";
    const defaultUserPrompt = [
      `Question=${question}`,
      `Intent=${detection.intent}`,
      detection.entityNames.length ? `DetectedEntities=${detection.entityNames.join(", ")}` : "DetectedEntities=none",
      detection.keywords.length ? `Keywords=${detection.keywords.join(", ")}` : "Keywords=none",
      ((_b = payload.selectedText) == null ? void 0 : _b.trim()) ? `SelectedTextProvided=true` : "SelectedTextProvided=false",
      ((_c = payload.currentLocation) == null ? void 0 : _c.trim()) ? `CurrentLocation=${payload.currentLocation.trim()}` : "",
      "Evidence=",
      evidenceBlock || "(no relevant evidence found)",
      isZh ? "Output=用简洁中文回答。若能回答，请按“已写事实 / 大纲计划 / 写作建议 / 置信度”组织；没有对应内容可省略该小节。必须引用证据标签。" : "Output=Answer concisely. Organize as Written facts / Outline plans / Writing suggestions / Confidence when applicable. Omit empty sections. Cite evidence labels."
    ].filter(Boolean).join("\n\n");
    const effectiveUserPrompt = ((_d = payload.overrideUserPrompt) == null ? void 0 : _d.trim()) ? payload.overrideUserPrompt.trim() : defaultUserPrompt;
    return {
      systemPrompt,
      defaultUserPrompt,
      effectiveUserPrompt,
      intent: detection.intent,
      evidence: collected.evidence,
      citations: collected.evidence.map((item) => ({ evidenceId: item.id, label: `[${item.id}]` })),
      warnings: collected.warnings,
      usedContext: collected.usedContext
    };
  }
  async preview(payload, embeddingSettings) {
    const bundle = await this.buildPromptBundle(payload, embeddingSettings);
    return {
      ok: true,
      question: payload.question,
      intent: bundle.intent,
      answer: "",
      confidence: bundle.evidence.length > 0 ? "medium" : "low",
      evidence: bundle.evidence,
      citations: bundle.citations,
      warnings: bundle.warnings,
      usedContext: bundle.usedContext,
      rawPrompt: buildRawPromptPreview$1(bundle.systemPrompt, bundle.effectiveUserPrompt),
      editableUserPrompt: bundle.defaultUserPrompt
    };
  }
  async ask(payload, provider, settings) {
    const bundle = await this.buildPromptBundle(payload, settings.embeddingSettings);
    const response = await provider.generate({
      systemPrompt: bundle.systemPrompt,
      prompt: bundle.effectiveUserPrompt,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature ?? 0.2
    });
    const evidenceIds = bundle.evidence.map((item) => item.id);
    const citations = extractCitations(response.text, evidenceIds);
    return {
      ok: true,
      question: payload.question,
      intent: bundle.intent,
      answer: response.text,
      confidence: parseConfidence(response.text, bundle.evidence.length),
      evidence: bundle.evidence,
      citations: citations.length > 0 ? citations : bundle.citations.slice(0, 3),
      warnings: bundle.warnings,
      usedContext: bundle.usedContext,
      rawPrompt: buildRawPromptPreview$1(bundle.systemPrompt, bundle.effectiveUserPrompt),
      editableUserPrompt: bundle.defaultUserPrompt
    };
  }
}
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const DRAFT_MAX_FIELD_LENGTH = 2e3;
const VALID_PLOT_POINT_TYPES = /* @__PURE__ */ new Set(["foreshadowing", "mystery", "promise", "event"]);
const VALID_PLOT_POINT_STATUS = /* @__PURE__ */ new Set(["active", "resolved"]);
const VALID_ITEM_TYPES = /* @__PURE__ */ new Set(["item", "skill", "location"]);
const VALID_MAP_TYPES = /* @__PURE__ */ new Set(["world", "region", "scene"]);
const CREATIVE_ASSET_SECTIONS = ["plotLines", "plotPoints", "characters", "items", "skills", "maps"];
const CREATIVE_SECTION_KEYWORDS = {
  plotLines: ["主线", "支线", "故事线", "剧情线", "plot line", "story line"],
  plotPoints: ["要点", "情节点", "剧情点", "事件", "桥段", "转折", "冲突", "plot point", "scene beat"],
  characters: ["角色", "龙套", "配角", "人物", "反派", "主角", "npc", "character"],
  items: ["物品", "道具", "装备", "宝物", "武器", "法宝", "artifact", "item"],
  skills: ["技能", "招式", "能力", "法术", "功法", "绝招", "spell", "skill"],
  maps: ["地图", "场景", "地点", "区域", "城市", "宗门地图", "world map", "map", "location"]
};
const OPENCLAW_REQUIRED_ACTIONS = [
  "novel.list",
  "volume.list",
  "chapter.list",
  "chapter.create",
  "chapter.save",
  "chapter.generate"
];
const CAPABILITY_COVERAGE_BASELINE = [
  {
    moduleId: "novel_volume_chapter",
    title: "小说/卷章管理",
    requiredActions: [
      "novel.list",
      "novel.create",
      "volume.list",
      "chapter.list",
      "chapter.get",
      "chapter.create",
      "chapter.save"
    ]
  },
  {
    moduleId: "editor_ops",
    title: "编辑器操作（标题/续写/总结）",
    requiredActions: [
      "chapter.generate"
    ]
  },
  {
    moduleId: "global_search",
    title: "全局搜索与跳转",
    requiredActions: [
      "search.query"
    ]
  },
  {
    moduleId: "outline_storyline_anchor",
    title: "大纲/故事线/锚点",
    requiredActions: [
      "plotline.list"
    ]
  },
  {
    moduleId: "world_item_map",
    title: "角色/物品/世界观/地图",
    requiredActions: [
      "character.list",
      "item.list",
      "worldsetting.list",
      "map.list"
    ]
  },
  {
    moduleId: "backup_restore",
    title: "备份恢复",
    requiredActions: []
  }
];
const DEFAULT_AI_SETTINGS = {
  providerType: "http",
  http: {
    baseUrl: "",
    apiKey: "",
    model: "gpt-4.1-mini",
    imageModel: "doubao-seedream-5-0-260128",
    imageSize: "2K",
    imageOutputFormat: "png",
    imageWatermark: false,
    timeoutMs: 6e4,
    maxTokens: 4096,
    temperature: 0.7
  },
  mcpCli: {
    cliPath: "",
    argsTemplate: "",
    workingDir: "",
    envJson: "{}",
    startupTimeoutMs: 6e4
  },
  proxy: {
    mode: "system",
    httpProxy: "",
    httpsProxy: "",
    allProxy: "",
    noProxy: ""
  },
  summary: {
    summaryMode: "local",
    summaryTriggerPolicy: "manual",
    summaryDebounceMs: 3e4,
    summaryMinIntervalMs: 18e4,
    summaryMinWordDelta: 120,
    summaryFinalizeStableMs: 6e5,
    summaryFinalizeMinWords: 1200,
    recentChapterRawCount: 2
  },
  embedding: {
    enabled: false,
    baseUrl: "",
    apiKey: "",
    model: "bge-large-zh-v1.5",
    dimensions: 1024,
    batchSize: 8,
    timeoutMs: 6e4,
    fallbackToHash: true
  }
};
function toProfileJson(profile) {
  return JSON.stringify(profile ?? {});
}
function mimeToExt(mimeType) {
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg"))
    return "jpg";
  if (mime.includes("webp"))
    return "webp";
  if (mime.includes("gif"))
    return "gif";
  if (mime.includes("bmp"))
    return "bmp";
  return "png";
}
function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function extractPlainTextFromLexical(content) {
  if (!(content == null ? void 0 : content.trim()))
    return "";
  try {
    const parsed = JSON.parse(content);
    const texts = [];
    const walk = (node) => {
      if (!node || typeof node !== "object")
        return;
      if (typeof node.text === "string") {
        texts.push(node.text);
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(walk);
      }
    };
    walk((parsed == null ? void 0 : parsed.root) || parsed);
    return texts.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return content.replace(/\s+/g, " ").trim();
  }
}
function resolveMapStylePrompt(style) {
  switch (style) {
    case "realistic":
      return "Style: realistic cartography, natural terrain textures, high geographic plausibility.";
    case "fantasy":
      return "Style: epic fantasy world map, dramatic terrain, mystical landmarks, rich parchment aesthetics.";
    case "ancient":
      return "Style: ancient oriental ink-and-parchment map, hand-drawn strokes, classical motifs.";
    case "scifi":
      return "Style: sci-fi strategic map, futuristic terrain overlays, advanced civilization markers.";
    default:
      return "";
  }
}
function buildRawPromptPreview(systemPrompt, userPrompt) {
  const sections = [];
  if (systemPrompt == null ? void 0 : systemPrompt.trim()) {
    sections.push(`[System Prompt]
${systemPrompt.trim()}`);
  }
  sections.push(`[User Prompt]
${userPrompt.trim()}`);
  return sections.join("\n\n");
}
function trimText(value, maxLen) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text)
    return "";
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function dedupeStrings(values, maxCount) {
  const seen = /* @__PURE__ */ new Set();
  const output = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text)
      continue;
    const key = text.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    output.push(text);
    if (output.length >= maxCount)
      break;
  }
  return output;
}
class AiService {
  constructor(userDataPathGetter) {
    __publicField(this, "userDataPath");
    __publicField(this, "settingsFilePath");
    __publicField(this, "mapImageStatsPath");
    __publicField(this, "settingsCache");
    __publicField(this, "mapImageStatsCache");
    __publicField(this, "capabilityDefinitions");
    __publicField(this, "capabilityRegistry");
    __publicField(this, "contextBuilder");
    __publicField(this, "novelRagService");
    this.userDataPath = userDataPathGetter();
    this.settingsFilePath = path.join(this.userDataPath, "ai-settings.json");
    this.mapImageStatsPath = path.join(this.userDataPath, "ai-map-image-stats.json");
    this.settingsCache = this.loadSettings();
    this.mapImageStatsCache = this.loadMapImageStats();
    this.contextBuilder = new ContextBuilder();
    this.novelRagService = new NovelRagService();
    this.capabilityDefinitions = createCapabilityDefinitions({
      continueWriting: (payload) => this.continueWriting(payload),
      askNovel: (payload) => this.askNovel(payload),
      rebuildRagIndex: (novelId) => this.rebuildRagIndex(novelId)
    });
    this.capabilityRegistry = new Map(
      this.capabilityDefinitions.map((definition) => [definition.actionId, definition.handler])
    );
  }
  listActions() {
    return this.capabilityDefinitions.map((definition) => ({
      actionId: definition.actionId,
      title: definition.title,
      description: definition.description,
      permission: definition.permission,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema
    }));
  }
  getCapabilityCoverage() {
    const supportedActionSet = new Set(this.capabilityDefinitions.map((definition) => definition.actionId));
    const modules = CAPABILITY_COVERAGE_BASELINE.map((module) => {
      const missingActions = module.requiredActions.filter((actionId) => !supportedActionSet.has(actionId));
      const supportedActions = module.requiredActions.filter((actionId) => supportedActionSet.has(actionId));
      const coverage = module.requiredActions.length === 0 ? 0 : Math.round(supportedActions.length / module.requiredActions.length * 100);
      return {
        moduleId: module.moduleId,
        title: module.title,
        requiredActions: [...module.requiredActions],
        supportedActions,
        missingActions,
        coverage
      };
    });
    const totalRequired = modules.reduce((acc, item) => acc + item.requiredActions.length, 0);
    const totalSupported = modules.reduce((acc, item) => acc + item.supportedActions.length, 0);
    const overallCoverage = totalRequired === 0 ? 0 : Math.round(totalSupported / totalRequired * 100);
    return {
      overallCoverage,
      totalRequired,
      totalSupported,
      modules
    };
  }
  getMcpToolsManifest() {
    const tools = this.capabilityDefinitions.map((definition) => ({
      name: definition.actionId,
      description: `${definition.title}. ${definition.description}`,
      inputSchema: definition.inputSchema
    }));
    return { tools };
  }
  getOpenClawManifest() {
    const tools = this.capabilityDefinitions.map((definition) => ({
      name: definition.actionId,
      description: `${definition.title}. ${definition.description}`,
      parameters: definition.inputSchema
    }));
    return {
      schemaVersion: "openclaw.tool.v1",
      tools
    };
  }
  getOpenClawSkillManifest() {
    const skills = this.capabilityDefinitions.map((definition) => ({
      name: definition.actionId,
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema
    }));
    return {
      schemaVersion: "openclaw.skill.v1",
      skills
    };
  }
  getSettings() {
    return this.settingsCache;
  }
  getMapImageStats() {
    return this.mapImageStatsCache;
  }
  updateSettings(partial) {
    this.settingsCache = {
      ...this.settingsCache,
      ...partial,
      http: { ...this.settingsCache.http, ...partial.http ?? {} },
      mcpCli: { ...this.settingsCache.mcpCli, ...partial.mcpCli ?? {} },
      proxy: { ...this.settingsCache.proxy, ...partial.proxy ?? {} },
      summary: { ...this.settingsCache.summary, ...partial.summary ?? {} },
      embedding: { ...this.settingsCache.embedding, ...partial.embedding ?? {} }
    };
    this.persistSettings();
    return this.settingsCache;
  }
  async testConnection() {
    return this.getProvider().healthCheck();
  }
  async testMcp() {
    const provider = new McpCliProvider(this.settingsCache);
    return provider.healthCheck();
  }
  async testOpenClawMcp() {
    const result = await this.testOpenClawSmoke({ kind: "mcp" });
    return { ok: result.ok, detail: result.detail };
  }
  async testOpenClawSkill() {
    const result = await this.testOpenClawSmoke({ kind: "skill" });
    return { ok: result.ok, detail: result.detail };
  }
  async testOpenClawSmoke(payload) {
    var _a, _b;
    const kind = payload.kind === "skill" ? "skill" : "mcp";
    const actionNames = kind === "mcp" ? this.getOpenClawManifest().tools.map((tool) => tool.name) : this.getOpenClawSkillManifest().skills.map((skill) => skill.name);
    if (!actionNames.length) {
      return {
        ok: false,
        kind,
        detail: kind === "mcp" ? "No OpenClaw MCP tools available" : "No OpenClaw skills available",
        missingActions: [...OPENCLAW_REQUIRED_ACTIONS],
        checks: []
      };
    }
    const missingActions = OPENCLAW_REQUIRED_ACTIONS.filter((actionId) => !actionNames.includes(actionId));
    const checks = [];
    const pushCheck = (actionId, ok2, detail, skipped) => {
      checks.push({ actionId, ok: ok2, detail, ...skipped ? { skipped: true } : {} });
    };
    if (missingActions.length) {
      pushCheck("manifest.coverage", false, `Missing required actions: ${missingActions.join(", ")}`);
    } else {
      pushCheck("manifest.coverage", true, `All required actions are covered (${OPENCLAW_REQUIRED_ACTIONS.length})`);
    }
    const invoke = (actionId, input) => kind === "mcp" ? this.invokeOpenClawTool({ name: actionId, arguments: input }) : this.invokeOpenClawSkill({ name: actionId, input });
    const novelResult = await invoke("novel.list");
    if (!novelResult.ok) {
      pushCheck("novel.list", false, novelResult.error || "invoke failed");
      return {
        ok: false,
        kind,
        detail: `OpenClaw ${kind.toUpperCase()} smoke failed at novel.list: ${novelResult.error || "unknown error"}`,
        missingActions,
        checks
      };
    }
    pushCheck("novel.list", true, "invoke ok");
    const novels = Array.isArray(novelResult.data) ? novelResult.data : [];
    const firstNovelId = (_a = novels.find((item) => typeof (item == null ? void 0 : item.id) === "string")) == null ? void 0 : _a.id;
    if (!firstNovelId) {
      pushCheck("volume.list", true, "no novels in database; skipped", true);
      pushCheck("chapter.list", true, "no novels in database; skipped", true);
      const ok2 = missingActions.length === 0;
      return {
        ok: ok2,
        kind,
        detail: ok2 ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage ok, invoke ok, nested checks skipped due to empty data)` : `OpenClaw ${kind.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${missingActions.join(", ")})`,
        missingActions,
        checks
      };
    }
    const volumeResult = await invoke("volume.list", { novelId: firstNovelId });
    if (!volumeResult.ok) {
      pushCheck("volume.list", false, volumeResult.error || "invoke failed");
      return {
        ok: false,
        kind,
        detail: `OpenClaw ${kind.toUpperCase()} smoke failed at volume.list: ${volumeResult.error || "unknown error"}`,
        missingActions,
        checks
      };
    }
    pushCheck("volume.list", true, "invoke ok");
    const volumes = Array.isArray(volumeResult.data) ? volumeResult.data : [];
    const firstVolumeId = (_b = volumes.find((item) => typeof (item == null ? void 0 : item.id) === "string")) == null ? void 0 : _b.id;
    if (!firstVolumeId) {
      pushCheck("chapter.list", true, "no volumes under first novel; skipped", true);
      const ok2 = missingActions.length === 0;
      return {
        ok: ok2,
        kind,
        detail: ok2 ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage ok, read-chain invoke ok)` : `OpenClaw ${kind.toUpperCase()} smoke partial pass (read-chain ok, but manifest missing required actions: ${missingActions.join(", ")})`,
        missingActions,
        checks
      };
    }
    const chapterResult = await invoke("chapter.list", { volumeId: firstVolumeId });
    if (!chapterResult.ok) {
      pushCheck("chapter.list", false, chapterResult.error || "invoke failed");
      return {
        ok: false,
        kind,
        detail: `OpenClaw ${kind.toUpperCase()} smoke failed at chapter.list: ${chapterResult.error || "unknown error"}`,
        missingActions,
        checks
      };
    }
    pushCheck("chapter.list", true, "invoke ok");
    const ok = missingActions.length === 0;
    return {
      ok,
      kind,
      detail: ok ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage + read-chain invoke all ok)` : `OpenClaw ${kind.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${missingActions.join(", ")})`,
      missingActions,
      checks
    };
  }
  async testProxy() {
    const proxy = this.settingsCache.proxy;
    if (proxy.mode !== "custom") {
      return { ok: true, detail: `Proxy mode is ${proxy.mode}` };
    }
    const hasAnyProxy = Boolean(proxy.httpProxy || proxy.httpsProxy || proxy.allProxy);
    if (!hasAnyProxy) {
      return { ok: false, detail: "Custom proxy mode requires at least one proxy value" };
    }
    return { ok: true, detail: "Custom proxy configuration looks valid" };
  }
  async testGenerate(prompt) {
    var _a;
    try {
      const provider = this.getProvider();
      const result = await provider.generate({
        systemPrompt: "You are a concise assistant.",
        prompt: (prompt || "请用一句话回复：AI 生成测试成功").trim(),
        maxTokens: 128,
        temperature: 0.2
      });
      return { ok: true, text: ((_a = result.text) == null ? void 0 : _a.slice(0, 500)) || "" };
    } catch (error) {
      return { ok: false, detail: (error == null ? void 0 : error.message) || "test generate failed" };
    }
  }
  async generateTitle(payload) {
    var _a, _b;
    devLog("INFO", "AiService.generateTitle.start", "Generate title start", {
      chapterId: payload.chapterId,
      novelId: payload.novelId,
      providerType: this.settingsCache.providerType
    });
    const provider = this.getProvider();
    const count = Math.max(5, Math.min(10, payload.count ?? 6));
    const currentPlain = extractPlainTextFromLexical(payload.content);
    const currentChapterFullText = currentPlain.slice(0, 4e3);
    const novel = await db.novel.findUnique({
      where: { id: payload.novelId },
      select: { title: true, description: true }
    });
    const chapter = await db.chapter.findUnique({
      where: { id: payload.chapterId },
      select: {
        id: true,
        title: true,
        order: true,
        volumeId: true,
        volume: {
          select: {
            id: true,
            title: true,
            order: true
          }
        }
      }
    });
    const recentChapters = await db.chapter.findMany({
      where: {
        volume: { novelId: payload.novelId },
        id: { not: payload.chapterId }
      },
      select: {
        title: true,
        order: true,
        volume: {
          select: {
            title: true,
            order: true
          }
        }
      },
      orderBy: [
        { volume: { order: "desc" } },
        { order: "desc" }
      ],
      take: 30
    });
    const recentChapterTitles = recentChapters.map((item, index) => {
      var _a2, _b2;
      return {
        index: index + 1,
        volumeTitle: ((_a2 = item.volume) == null ? void 0 : _a2.title) || "",
        volumeOrder: ((_b2 = item.volume) == null ? void 0 : _b2.order) || 0,
        chapterOrder: item.order || 0,
        title: item.title || `Chapter-${index + 1}`
      };
    });
    const systemPrompt = [
      "You are a Chinese novel title assistant.",
      "Generate concise chapter title candidates based on provided context.",
      "Return STRICT JSON only. No markdown.",
      'JSON shape: {"candidates":[{"title":"...","styleTag":"..."}]}',
      "Each styleTag must be short Chinese phrase like: 稳健推进, 悬念强化, 意象抒情."
    ].join(" ");
    const response = await provider.generate({
      systemPrompt,
      prompt: JSON.stringify({
        task: "chapter_title_generation",
        count,
        novel: {
          title: (novel == null ? void 0 : novel.title) || "",
          description: (novel == null ? void 0 : novel.description) || ""
        },
        chapter: {
          title: (chapter == null ? void 0 : chapter.title) || "",
          order: (chapter == null ? void 0 : chapter.order) || 0,
          volumeTitle: ((_a = chapter == null ? void 0 : chapter.volume) == null ? void 0 : _a.title) || "",
          volumeOrder: ((_b = chapter == null ? void 0 : chapter.volume) == null ? void 0 : _b.order) || 0
        },
        recentChapterTitles,
        currentChapterFullText,
        constraints: [
          "title length <= 16 Chinese characters preferred",
          "avoid spoilers and proper nouns overuse",
          "output 5-10 candidates"
        ]
      }),
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: this.settingsCache.http.temperature
    });
    const parsed = (() => {
      try {
        return JSON.parse(response.text);
      } catch {
        return null;
      }
    })();
    const normalizedFromJson = Array.isArray(parsed == null ? void 0 : parsed.candidates) ? parsed.candidates.map((item) => ({
      title: String((item == null ? void 0 : item.title) || "").trim(),
      styleTag: String((item == null ? void 0 : item.styleTag) || "").trim() || "稳健推进"
    })).filter((item) => Boolean(item.title)).slice(0, count) : [];
    if (normalizedFromJson.length > 0) {
      devLog("INFO", "AiService.generateTitle.success", "Generate title success", {
        chapterId: payload.chapterId,
        candidateCount: normalizedFromJson.length
      });
      return { candidates: normalizedFromJson };
    }
    const normalizedFromLines = response.text.split("\n").map((line) => line.replace(/^[-\d.\s]+/, "").trim()).filter(Boolean).slice(0, count).map((title) => ({ title, styleTag: "稳健推进" }));
    if (normalizedFromLines.length > 0) {
      devLog("INFO", "AiService.generateTitle.success", "Generate title success", {
        chapterId: payload.chapterId,
        candidateCount: normalizedFromLines.length
      });
      return { candidates: normalizedFromLines };
    }
    const fallbackBase = ((chapter == null ? void 0 : chapter.title) || currentChapterFullText.slice(0, 12) || "新章节").trim();
    devLog("INFO", "AiService.generateTitle.success", "Generate title success", {
      chapterId: payload.chapterId,
      candidateCount: count
    });
    return {
      candidates: Array.from({ length: count }, (_, i) => ({
        title: `${fallbackBase} · ${i + 1}`,
        styleTag: "稳健推进"
      }))
    };
  }
  async previewContinuePrompt(payload) {
    devLog("INFO", "AiService.previewContinuePrompt.start", "Preview continue prompt start", {
      chapterId: payload.chapterId,
      novelId: payload.novelId,
      contextChapterCount: payload.contextChapterCount
    });
    const bundle = await this.buildContinuePromptBundle(payload);
    devLog("INFO", "AiService.previewContinuePrompt.success", "Preview continue prompt success", {
      chapterId: payload.chapterId
    });
    return {
      structured: bundle.structured,
      rawPrompt: buildRawPromptPreview(bundle.systemPrompt, bundle.effectiveUserPrompt),
      editableUserPrompt: bundle.defaultUserPrompt,
      usedContext: bundle.usedContext,
      warnings: bundle.warnings
    };
  }
  async continueWriting(payload) {
    devLog("INFO", "AiService.continueWriting.start", "Continue writing start", {
      chapterId: payload.chapterId,
      novelId: payload.novelId,
      providerType: this.settingsCache.providerType,
      targetLength: payload.targetLength,
      contextChapterCount: payload.contextChapterCount
    });
    const provider = this.getProvider();
    const bundle = await this.buildContinuePromptBundle(payload);
    const generationTemperature = Number.isFinite(payload.temperature) ? Math.max(0, Math.min(2, Number(payload.temperature))) : this.settingsCache.http.temperature;
    const response = await provider.generate({
      systemPrompt: bundle.systemPrompt,
      prompt: bundle.effectiveUserPrompt,
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: generationTemperature
    });
    const consistency = await this.checkConsistency({
      novelId: payload.novelId,
      text: response.text
    });
    const result = {
      text: response.text,
      usedContext: bundle.usedContext,
      warnings: bundle.warnings,
      consistency
    };
    devLog("INFO", "AiService.continueWriting.success", "Continue writing success", {
      chapterId: payload.chapterId,
      warningCount: bundle.warnings.length,
      generatedLength: result.text.length
    });
    return result;
  }
  async checkConsistency(payload) {
    const issues = [];
    const worldSettings = await db.worldSetting.findMany({ where: { novelId: payload.novelId } });
    if (worldSettings.length === 0) {
      issues.push("No world settings found for consistency baseline.");
    }
    if (payload.text.length < 20) {
      issues.push("Generated text is too short.");
    }
    return { ok: issues.length === 0, issues };
  }
  async previewNovelAskPrompt(payload) {
    var _a;
    devLog("INFO", "AiService.previewNovelAskPrompt.start", "Preview novel RAG prompt start", {
      novelId: payload.novelId,
      questionLength: ((_a = payload.question) == null ? void 0 : _a.length) ?? 0
    });
    const result = await this.novelRagService.preview(payload, this.settingsCache.embedding);
    devLog("INFO", "AiService.previewNovelAskPrompt.success", "Preview novel RAG prompt success", {
      novelId: payload.novelId,
      intent: result.intent,
      evidenceCount: result.evidence.length
    });
    return result;
  }
  async askNovel(payload) {
    var _a;
    devLog("INFO", "AiService.askNovel.start", "Novel RAG ask start", {
      novelId: payload.novelId,
      questionLength: ((_a = payload.question) == null ? void 0 : _a.length) ?? 0,
      providerType: this.settingsCache.providerType
    });
    const provider = this.getProvider();
    const result = await this.novelRagService.ask(payload, provider, {
      maxTokens: Math.min(2048, this.settingsCache.http.maxTokens || 2048),
      temperature: 0.2,
      embeddingSettings: this.settingsCache.embedding
    });
    devLog("INFO", "AiService.askNovel.success", "Novel RAG ask success", {
      novelId: payload.novelId,
      intent: result.intent,
      confidence: result.confidence,
      evidenceCount: result.evidence.length
    });
    return result;
  }
  async rebuildRagIndex(novelId) {
    return rebuildRagVectorIndex(novelId, this.settingsCache.embedding);
  }
  async previewCreativeAssetsPrompt(payload) {
    var _a;
    devLog("INFO", "AiService.previewCreativeAssetsPrompt.start", "Preview creative assets prompt start", {
      novelId: payload.novelId,
      briefLength: ((_a = payload.brief) == null ? void 0 : _a.length) ?? 0,
      targetSections: payload.targetSections
    });
    const bundle = await this.buildCreativeAssetsPromptBundle(payload);
    devLog("INFO", "AiService.previewCreativeAssetsPrompt.success", "Preview creative assets prompt success", {
      novelId: payload.novelId
    });
    return {
      structured: bundle.structured,
      rawPrompt: buildRawPromptPreview(bundle.systemPrompt, bundle.effectiveUserPrompt),
      editableUserPrompt: bundle.defaultUserPrompt,
      usedContext: bundle.usedContext
    };
  }
  inferCreativeTargetSections(brief) {
    const normalized = String(brief || "").trim().toLowerCase();
    if (!normalized)
      return [...CREATIVE_ASSET_SECTIONS];
    const picked = [];
    for (const section of CREATIVE_ASSET_SECTIONS) {
      const keywords = CREATIVE_SECTION_KEYWORDS[section];
      if (keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
        picked.push(section);
      }
    }
    return picked.length > 0 ? picked : [...CREATIVE_ASSET_SECTIONS];
  }
  resolveCreativeTargetSections(payload) {
    const requested = Array.isArray(payload.targetSections) ? payload.targetSections : [];
    const picked = requested.filter((value) => CREATIVE_ASSET_SECTIONS.includes(value));
    return picked.length > 0 ? picked : this.inferCreativeTargetSections(payload.brief);
  }
  buildEmptyCreativeDraft(targetSections) {
    const output = {};
    for (const key of targetSections) {
      output[key] = [];
    }
    return output;
  }
  async generateCreativeAssets(payload) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
    devLog("INFO", "AiService.generateCreativeAssets.start", "Generate creative assets start", {
      novelId: payload.novelId,
      briefLength: ((_a = payload.brief) == null ? void 0 : _a.length) ?? 0,
      providerType: this.settingsCache.providerType,
      targetSections: payload.targetSections
    });
    const provider = this.getProvider();
    const bundle = await this.buildCreativeAssetsPromptBundle(payload);
    const targetSections = this.resolveCreativeTargetSections(payload);
    const response = await provider.generate({
      systemPrompt: bundle.systemPrompt,
      prompt: bundle.effectiveUserPrompt,
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: this.settingsCache.http.temperature,
      // 创作工坊需要生成多个板块的结构化 JSON，内容量大，使用更宽裕的超时
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 18e4)
    });
    try {
      const parsed = JSON.parse(response.text);
      if (parsed && typeof parsed === "object") {
        const filtered = this.buildEmptyCreativeDraft(targetSections);
        for (const section of targetSections) {
          const list = parsed == null ? void 0 : parsed[section];
          filtered[section] = Array.isArray(list) ? list : [];
        }
        devLog("INFO", "AiService.generateCreativeAssets.success", "Generate creative assets success", {
          novelId: payload.novelId,
          counts: {
            plotLines: ((_b = filtered.plotLines) == null ? void 0 : _b.length) ?? 0,
            plotPoints: ((_c = filtered.plotPoints) == null ? void 0 : _c.length) ?? 0,
            characters: ((_d = filtered.characters) == null ? void 0 : _d.length) ?? 0,
            items: ((_e = filtered.items) == null ? void 0 : _e.length) ?? 0,
            skills: ((_f = filtered.skills) == null ? void 0 : _f.length) ?? 0,
            maps: ((_g = filtered.maps) == null ? void 0 : _g.length) ?? 0
          }
        });
        return { draft: filtered };
      }
    } catch {
    }
    const suffix = randomUUID().slice(0, 6);
    const fallbackDraft = {
      plotLines: [{
        name: `主线-${suffix}`,
        description: "AI 生成的主线草稿",
        color: "#6366f1",
        points: [{ title: "开端事件", description: "引发主线的关键事件", type: "event", status: "active" }]
      }],
      plotPoints: [{
        title: "中段转折",
        description: "推动章节冲突升级",
        type: "event",
        status: "active"
      }],
      characters: [{ name: `角色-${suffix}`, role: "protagonist", description: "AI 生成角色草稿", profile: { goal: "完成使命" } }],
      items: [{ name: `物品-${suffix}`, type: "item", description: "AI 生成物品草稿", profile: { rarity: "rare" } }],
      skills: [{ name: `技能-${suffix}`, description: "AI 生成技能草稿", profile: { rank: "A" } }],
      maps: [{ name: `世界地图-${suffix}`, type: "world", description: "AI 生成地图草稿", imagePrompt: "fantasy world map" }]
    };
    const filteredFallback = this.buildEmptyCreativeDraft(targetSections);
    for (const section of targetSections) {
      filteredFallback[section] = fallbackDraft[section] ?? [];
    }
    devLog("INFO", "AiService.generateCreativeAssets.success", "Generate creative assets success", {
      novelId: payload.novelId,
      counts: {
        plotLines: ((_h = filteredFallback.plotLines) == null ? void 0 : _h.length) ?? 0,
        plotPoints: ((_i = filteredFallback.plotPoints) == null ? void 0 : _i.length) ?? 0,
        characters: ((_j = filteredFallback.characters) == null ? void 0 : _j.length) ?? 0,
        items: ((_k = filteredFallback.items) == null ? void 0 : _k.length) ?? 0,
        skills: ((_l = filteredFallback.skills) == null ? void 0 : _l.length) ?? 0,
        maps: ((_m = filteredFallback.maps) == null ? void 0 : _m.length) ?? 0
      }
    });
    return {
      draft: filteredFallback
    };
  }
  async validateCreativeAssetsDraft(payload) {
    var _a, _b;
    const errors2 = [];
    const warnings = [];
    const pushError = (issue) => errors2.push(issue);
    const sanitizeText = (value, scope, maxLen = DRAFT_MAX_FIELD_LENGTH) => {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text)
        return "";
      if (text.length <= maxLen)
        return text;
      warnings.push(`${scope} exceeds ${maxLen} chars and was truncated`);
      return text.slice(0, maxLen);
    };
    const sanitizeProfile = (value, scope) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
      const output = {};
      for (const [key, val] of Object.entries(value)) {
        const safeKey = sanitizeText(key, `${scope}.key`, 64);
        const safeVal = sanitizeText(val, `${scope}.${key}`, 500);
        if (safeKey && safeVal)
          output[safeKey] = safeVal;
      }
      return output;
    };
    const normalized = {
      plotLines: (payload.draft.plotLines ?? []).map((line, index) => ({
        name: sanitizeText(line.name, `plotLines[${index}].name`, 120),
        description: sanitizeText(line.description, `plotLines[${index}].description`),
        color: sanitizeText(line.color, `plotLines[${index}].color`, 16) || "#6366f1",
        points: (line.points ?? []).map((point, pointIndex) => {
          const type = sanitizeText(point.type, `plotLines[${index}].points[${pointIndex}].type`, 32) || "event";
          const status = sanitizeText(point.status, `plotLines[${index}].points[${pointIndex}].status`, 32) || "active";
          return {
            title: sanitizeText(point.title, `plotLines[${index}].points[${pointIndex}].title`, 120),
            description: sanitizeText(point.description, `plotLines[${index}].points[${pointIndex}].description`),
            type: VALID_PLOT_POINT_TYPES.has(type) ? type : "event",
            status: VALID_PLOT_POINT_STATUS.has(status) ? status : "active"
          };
        })
      })),
      plotPoints: (payload.draft.plotPoints ?? []).map((point, index) => {
        const type = sanitizeText(point.type, `plotPoints[${index}].type`, 32) || "event";
        const status = sanitizeText(point.status, `plotPoints[${index}].status`, 32) || "active";
        return {
          title: sanitizeText(point.title, `plotPoints[${index}].title`, 120),
          description: sanitizeText(point.description, `plotPoints[${index}].description`),
          type: VALID_PLOT_POINT_TYPES.has(type) ? type : "event",
          status: VALID_PLOT_POINT_STATUS.has(status) ? status : "active",
          plotLineName: sanitizeText(point.plotLineName, `plotPoints[${index}].plotLineName`, 120)
        };
      }),
      characters: (payload.draft.characters ?? []).map((item, index) => ({
        name: sanitizeText(item.name, `characters[${index}].name`, 120),
        role: sanitizeText(item.role, `characters[${index}].role`, 64),
        description: sanitizeText(item.description, `characters[${index}].description`),
        profile: sanitizeProfile(item.profile, `characters[${index}].profile`)
      })),
      items: (payload.draft.items ?? []).map((item, index) => {
        const itemType = sanitizeText(item.type, `items[${index}].type`, 32) || "item";
        return {
          name: sanitizeText(item.name, `items[${index}].name`, 120),
          type: VALID_ITEM_TYPES.has(itemType) ? itemType : "item",
          description: sanitizeText(item.description, `items[${index}].description`),
          profile: sanitizeProfile(item.profile, `items[${index}].profile`)
        };
      }),
      skills: (payload.draft.skills ?? []).map((skill, index) => ({
        name: sanitizeText(skill.name, `skills[${index}].name`, 120),
        description: sanitizeText(skill.description, `skills[${index}].description`),
        profile: sanitizeProfile(skill.profile, `skills[${index}].profile`)
      })),
      maps: (payload.draft.maps ?? []).map((map, index) => {
        const mapType = sanitizeText(map.type, `maps[${index}].type`, 32) || "world";
        return {
          name: sanitizeText(map.name, `maps[${index}].name`, 120),
          type: VALID_MAP_TYPES.has(mapType) ? mapType : "world",
          description: sanitizeText(map.description, `maps[${index}].description`),
          imagePrompt: sanitizeText(map.imagePrompt, `maps[${index}].imagePrompt`),
          imageUrl: sanitizeText(map.imageUrl, `maps[${index}].imageUrl`, 2048),
          imageBase64: sanitizeText(map.imageBase64, `maps[${index}].imageBase64`, 4 * 1024 * 1024),
          mimeType: sanitizeText(map.mimeType, `maps[${index}].mimeType`, 64)
        };
      })
    };
    for (const [index, line] of (normalized.plotLines ?? []).entries()) {
      if (!line.name) {
        pushError({ scope: `plotLines[${index}]`, code: "INVALID_INPUT", detail: "Plot line name is required" });
      }
      for (const [pointIndex, point] of (line.points ?? []).entries()) {
        if (!point.title) {
          pushError({ scope: `plotLines[${index}].points[${pointIndex}]`, code: "INVALID_INPUT", detail: "Plot point title is required" });
        }
      }
    }
    for (const [index, point] of (normalized.plotPoints ?? []).entries()) {
      if (!point.title) {
        pushError({ scope: `plotPoints[${index}]`, code: "INVALID_INPUT", detail: "Plot point title is required" });
      }
    }
    for (const [index, character] of (normalized.characters ?? []).entries()) {
      if (!character.name) {
        pushError({ scope: `characters[${index}]`, code: "INVALID_INPUT", detail: "Character name is required" });
      }
    }
    for (const [index, item] of (normalized.items ?? []).entries()) {
      if (!item.name) {
        pushError({ scope: `items[${index}]`, code: "INVALID_INPUT", detail: "Item name is required" });
      }
    }
    for (const [index, skill] of (normalized.skills ?? []).entries()) {
      if (!skill.name) {
        pushError({ scope: `skills[${index}]`, code: "INVALID_INPUT", detail: "Skill name is required" });
      }
    }
    for (const [index, map] of (normalized.maps ?? []).entries()) {
      if (!map.name) {
        pushError({ scope: `maps[${index}]`, code: "INVALID_INPUT", detail: "Map name is required" });
      }
      const sourceCount = Number(Boolean(map.imageBase64)) + Number(Boolean(map.imageUrl)) + Number(Boolean(map.imagePrompt));
      if (sourceCount > 1) {
        pushError({
          scope: `maps[${index}]`,
          name: map.name,
          code: "INVALID_INPUT",
          detail: "Map image input must use only one source: imageBase64, imageUrl, or imagePrompt"
        });
      }
      if (map.imageUrl && !/^https?:\/\//i.test(map.imageUrl)) {
        pushError({
          scope: `maps[${index}].imageUrl`,
          name: map.name,
          code: "INVALID_INPUT",
          detail: "Map imageUrl must start with http:// or https://"
        });
      }
      if (map.imageBase64) {
        try {
          const size = Buffer.from(map.imageBase64, "base64").length;
          if (size === 0) {
            pushError({
              scope: `maps[${index}].imageBase64`,
              name: map.name,
              code: "INVALID_INPUT",
              detail: "Map imageBase64 is invalid"
            });
          }
          if (size > MAX_IMAGE_SIZE_BYTES) {
            pushError({
              scope: `maps[${index}].imageBase64`,
              name: map.name,
              code: "INVALID_INPUT",
              detail: `Map imageBase64 exceeds ${MAX_IMAGE_SIZE_BYTES} bytes`
            });
          }
        } catch {
          pushError({
            scope: `maps[${index}].imageBase64`,
            name: map.name,
            code: "INVALID_INPUT",
            detail: "Map imageBase64 is invalid"
          });
        }
      }
    }
    const checkDraftDuplicates = (items, scope) => {
      const seen = /* @__PURE__ */ new Set();
      for (const item of items) {
        const normalizedName = (item.name || "").trim().toLowerCase();
        if (!normalizedName)
          continue;
        if (seen.has(normalizedName)) {
          pushError({
            scope,
            name: item.name,
            code: "CONFLICT",
            detail: `Duplicate name in current draft: ${item.name}`
          });
          continue;
        }
        seen.add(normalizedName);
      }
    };
    checkDraftDuplicates(normalized.plotLines ?? [], "plotLines");
    checkDraftDuplicates(normalized.characters ?? [], "characters");
    checkDraftDuplicates(normalized.items ?? [], "items");
    checkDraftDuplicates(normalized.skills ?? [], "skills");
    checkDraftDuplicates(normalized.maps ?? [], "maps");
    const [existingPlotLines, existingCharacters, existingItems, existingMaps] = await Promise.all([
      db.plotLine.findMany({ where: { novelId: payload.novelId }, select: { name: true } }),
      db.character.findMany({ where: { novelId: payload.novelId }, select: { name: true } }),
      db.item.findMany({ where: { novelId: payload.novelId }, select: { name: true } }),
      db.mapCanvas.findMany({ where: { novelId: payload.novelId }, select: { name: true } })
    ]);
    const existingNameSets = {
      plotLines: new Set(existingPlotLines.map((row) => row.name.trim().toLowerCase())),
      characters: new Set(existingCharacters.map((row) => row.name.trim().toLowerCase())),
      items: new Set(existingItems.map((row) => row.name.trim().toLowerCase())),
      maps: new Set(existingMaps.map((row) => row.name.trim().toLowerCase()))
    };
    const checkExistingConflicts = (items, category, scope) => {
      for (const item of items) {
        const normalizedName = (item.name || "").trim().toLowerCase();
        if (!normalizedName)
          continue;
        if (existingNameSets[category].has(normalizedName)) {
          pushError({
            scope,
            name: item.name,
            code: "CONFLICT",
            detail: `Name already exists in novel: ${item.name}`
          });
        }
      }
    };
    checkExistingConflicts(normalized.plotLines ?? [], "plotLines", "plotLines");
    checkExistingConflicts(normalized.characters ?? [], "characters", "characters");
    checkExistingConflicts(normalized.items ?? [], "items", "items");
    checkExistingConflicts(normalized.skills ?? [], "items", "skills");
    checkExistingConflicts(normalized.maps ?? [], "maps", "maps");
    if ((((_a = normalized.plotPoints) == null ? void 0 : _a.length) ?? 0) > 0 && (((_b = normalized.plotLines) == null ? void 0 : _b.length) ?? 0) === 0) {
      warnings.push("Draft has plotPoints but no plotLines. System will create a default plot line when persisting.");
    }
    return {
      ok: errors2.length === 0,
      errors: errors2,
      warnings,
      normalizedDraft: normalized
    };
  }
  async confirmCreativeAssets(payload) {
    var _a, _b, _c, _d, _e, _f;
    devLog("INFO", "AiService.confirmCreativeAssets.start", "Confirm creative assets start", {
      novelId: payload.novelId,
      draftCounts: redactForLog({
        plotLines: ((_a = payload.draft.plotLines) == null ? void 0 : _a.length) ?? 0,
        plotPoints: ((_b = payload.draft.plotPoints) == null ? void 0 : _b.length) ?? 0,
        characters: ((_c = payload.draft.characters) == null ? void 0 : _c.length) ?? 0,
        items: ((_d = payload.draft.items) == null ? void 0 : _d.length) ?? 0,
        skills: ((_e = payload.draft.skills) == null ? void 0 : _e.length) ?? 0,
        maps: ((_f = payload.draft.maps) == null ? void 0 : _f.length) ?? 0
      })
    });
    const validation = await this.validateCreativeAssetsDraft(payload);
    const zeroCreated = {
      plotLines: 0,
      plotPoints: 0,
      characters: 0,
      items: 0,
      skills: 0,
      maps: 0,
      mapImages: 0
    };
    if (!validation.ok) {
      devLog("WARN", "AiService.confirmCreativeAssets.validationFailed", "Confirm creative assets validation failed", {
        novelId: payload.novelId,
        errors: validation.errors,
        warnings: validation.warnings
      });
      return {
        success: false,
        created: zeroCreated,
        warnings: validation.warnings,
        errors: validation.errors,
        transactionMode: "atomic"
      };
    }
    const draft = validation.normalizedDraft;
    const provider = this.getProvider();
    const createdFiles = [];
    let committedCreated = { ...zeroCreated };
    try {
      await db.$transaction(async (tx) => {
        const localCreated = { ...zeroCreated };
        const plotLineIdByName = /* @__PURE__ */ new Map();
        for (const plotLine of draft.plotLines ?? []) {
          const createdLine = await tx.plotLine.create({
            data: {
              novelId: payload.novelId,
              name: plotLine.name,
              description: plotLine.description || null,
              color: plotLine.color || "#6366f1",
              sortOrder: Date.now() + localCreated.plotLines
            }
          });
          plotLineIdByName.set(plotLine.name.toLowerCase(), createdLine.id);
          localCreated.plotLines += 1;
          for (const point of plotLine.points ?? []) {
            await tx.plotPoint.create({
              data: {
                novelId: payload.novelId,
                plotLineId: createdLine.id,
                title: point.title,
                description: point.description || null,
                type: point.type || "event",
                status: point.status || "active",
                order: Date.now() + localCreated.plotPoints
              }
            });
            localCreated.plotPoints += 1;
          }
        }
        const resolvePlotLineIdForLoosePoint = async (plotLineName) => {
          const lookupName = (plotLineName || "").trim().toLowerCase();
          if (lookupName && plotLineIdByName.has(lookupName)) {
            return plotLineIdByName.get(lookupName);
          }
          const firstLineId = plotLineIdByName.values().next().value;
          if (firstLineId)
            return firstLineId;
          const defaultName = "AI 主线";
          const autoLine = await tx.plotLine.create({
            data: {
              novelId: payload.novelId,
              name: defaultName,
              description: "Auto-created for loose plot points",
              color: "#6366f1",
              sortOrder: Date.now() + localCreated.plotLines
            }
          });
          plotLineIdByName.set(defaultName.toLowerCase(), autoLine.id);
          localCreated.plotLines += 1;
          return autoLine.id;
        };
        for (const point of draft.plotPoints ?? []) {
          const lineId = await resolvePlotLineIdForLoosePoint(point.plotLineName);
          await tx.plotPoint.create({
            data: {
              novelId: payload.novelId,
              plotLineId: lineId,
              title: point.title,
              description: point.description || null,
              type: point.type || "event",
              status: point.status || "active",
              order: Date.now() + localCreated.plotPoints
            }
          });
          localCreated.plotPoints += 1;
        }
        for (const character of draft.characters ?? []) {
          await tx.character.create({
            data: {
              novelId: payload.novelId,
              name: character.name,
              role: character.role || null,
              description: character.description || null,
              profile: toProfileJson(character.profile),
              sortOrder: Date.now() + localCreated.characters
            }
          });
          localCreated.characters += 1;
        }
        for (const item of draft.items ?? []) {
          await tx.item.create({
            data: {
              novelId: payload.novelId,
              name: item.name,
              type: item.type || "item",
              description: item.description || null,
              profile: toProfileJson(item.profile),
              sortOrder: Date.now() + localCreated.items
            }
          });
          localCreated.items += 1;
        }
        for (const skill of draft.skills ?? []) {
          await tx.item.create({
            data: {
              novelId: payload.novelId,
              name: skill.name,
              type: "skill",
              description: skill.description || null,
              profile: toProfileJson(skill.profile),
              sortOrder: Date.now() + localCreated.items + localCreated.skills
            }
          });
          localCreated.skills += 1;
        }
        for (const mapDraft of draft.maps ?? []) {
          const map = await tx.mapCanvas.create({
            data: {
              novelId: payload.novelId,
              name: mapDraft.name,
              type: mapDraft.type || "world",
              description: mapDraft.description || null,
              sortOrder: Date.now() + localCreated.maps
            }
          });
          localCreated.maps += 1;
          let imageInput = null;
          if (mapDraft.imageBase64 || mapDraft.imageUrl) {
            imageInput = {
              imageBase64: mapDraft.imageBase64,
              imageUrl: mapDraft.imageUrl,
              mimeType: mapDraft.mimeType
            };
          } else if (mapDraft.imagePrompt) {
            if (!provider.generateImage) {
              throw new AiActionError("INVALID_INPUT", `Provider ${provider.name} does not support image generation`);
            }
            const generated = await provider.generateImage({ prompt: mapDraft.imagePrompt });
            if (!(generated == null ? void 0 : generated.imageBase64) && !(generated == null ? void 0 : generated.imageUrl)) {
              throw new AiActionError("PROVIDER_UNAVAILABLE", `Map image generation returned empty data for ${mapDraft.name}`);
            }
            imageInput = {
              imageBase64: generated.imageBase64,
              imageUrl: generated.imageUrl,
              mimeType: generated.mimeType
            };
          }
          if (imageInput) {
            const saved = await this.saveImageAsset(payload.novelId, map.id, imageInput);
            createdFiles.push(saved.absolutePath);
            await tx.mapCanvas.update({
              where: { id: map.id },
              data: { background: saved.relativePath }
            });
            localCreated.mapImages += 1;
          }
        }
        committedCreated = localCreated;
      });
      const result = {
        success: true,
        created: committedCreated,
        warnings: validation.warnings,
        transactionMode: "atomic"
      };
      devLog("INFO", "AiService.confirmCreativeAssets.success", "Confirm creative assets success", {
        novelId: payload.novelId,
        created: committedCreated,
        warningCount: validation.warnings.length
      });
      return result;
    } catch (error) {
      devLogError("AiService.confirmCreativeAssets.error", error, {
        novelId: payload.novelId
      });
      for (const file of createdFiles) {
        try {
          if (fs.existsSync(file))
            fs.unlinkSync(file);
        } catch {
        }
      }
      const normalized = normalizeAiError(error);
      const issueCode = normalized.code === "INVALID_INPUT" ? "INVALID_INPUT" : normalized.code === "CONFLICT" ? "CONFLICT" : normalized.code === "UNKNOWN" ? "UNKNOWN" : "PERSISTENCE_ERROR";
      return {
        success: false,
        created: zeroCreated,
        warnings: validation.warnings,
        errors: [
          {
            scope: "confirmCreativeAssets",
            code: issueCode,
            detail: normalized.message || "Creative assets persistence failed"
          }
        ],
        transactionMode: "atomic"
      };
    }
  }
  async previewMapPrompt(payload) {
    var _a;
    devLog("INFO", "AiService.previewMapPrompt.start", "Preview map prompt start", {
      novelId: payload.novelId,
      mapId: payload.mapId,
      promptLength: ((_a = payload.prompt) == null ? void 0 : _a.length) ?? 0
    });
    const bundle = await this.buildMapPromptBundle(payload);
    devLog("INFO", "AiService.previewMapPrompt.success", "Preview map prompt success", {
      novelId: payload.novelId,
      mapId: payload.mapId
    });
    return {
      structured: bundle.structured,
      rawPrompt: bundle.effectiveUserPrompt,
      editableUserPrompt: bundle.defaultUserPrompt,
      usedWorldLore: bundle.usedWorldLore
    };
  }
  async generateMapImage(payload) {
    var _a, _b, _c, _d;
    devLog("INFO", "AiService.generateMapImage.start", "Generate map image start", {
      novelId: payload.novelId,
      mapId: payload.mapId,
      promptLength: ((_a = payload.prompt) == null ? void 0 : _a.length) ?? 0,
      providerType: this.settingsCache.providerType
    });
    const startTime = Date.now();
    const finalize = (result) => {
      this.recordMapImageCall({
        ok: result.ok,
        code: result.code,
        detail: result.detail,
        latencyMs: Date.now() - startTime
      });
      return result;
    };
    try {
      const hasBasePrompt = Boolean((_b = payload.prompt) == null ? void 0 : _b.trim());
      const hasOverridePrompt = Boolean((_c = payload.overrideUserPrompt) == null ? void 0 : _c.trim());
      if (!hasBasePrompt && !hasOverridePrompt) {
        return finalize({ ok: false, code: "INVALID_INPUT", detail: "Map prompt is empty" });
      }
      const provider = this.getProvider();
      if (!provider.generateImage) {
        return finalize({ ok: false, code: "INVALID_INPUT", detail: `Provider ${provider.name} does not support image generation` });
      }
      const bundle = await this.buildMapPromptBundle(payload);
      const generated = await provider.generateImage({
        prompt: bundle.effectiveUserPrompt,
        model: this.settingsCache.http.imageModel || void 0,
        size: payload.imageSize || this.settingsCache.http.imageSize || void 0,
        outputFormat: this.settingsCache.http.imageOutputFormat || void 0,
        watermark: this.settingsCache.http.imageWatermark
      });
      if (!generated.imageBase64 && !generated.imageUrl) {
        return finalize({ ok: false, code: "PROVIDER_UNAVAILABLE", detail: "Provider did not return any image data" });
      }
      let mapId = payload.mapId;
      if (!mapId) {
        const createdMap = await db.mapCanvas.create({
          data: {
            novelId: payload.novelId,
            name: ((_d = payload.mapName) == null ? void 0 : _d.trim()) || `AI 地图 ${(/* @__PURE__ */ new Date()).toLocaleString()}`,
            type: payload.mapType || "world",
            description: `Generated by AI with prompt: ${payload.prompt}`,
            sortOrder: Date.now()
          }
        });
        mapId = createdMap.id;
      }
      if (!mapId) {
        throw new AiActionError("PERSISTENCE_ERROR", "Map id is missing after map creation");
      }
      const saved = await this.saveImageAsset(payload.novelId, mapId, {
        imageBase64: generated.imageBase64,
        imageUrl: generated.imageUrl,
        mimeType: generated.mimeType
      });
      await db.mapCanvas.update({
        where: { id: mapId },
        data: { background: saved.relativePath }
      });
      const successResult = finalize({
        ok: true,
        detail: "Map image generated and stored successfully",
        mapId,
        path: saved.relativePath
      });
      devLog("INFO", "AiService.generateMapImage.success", "Generate map image success", {
        novelId: payload.novelId,
        mapId,
        imagePath: saved.relativePath
      });
      return successResult;
    } catch (error) {
      devLogError("AiService.generateMapImage.error", error, {
        novelId: payload.novelId,
        mapId: payload.mapId
      });
      const normalized = normalizeAiError(error);
      return finalize({
        ok: false,
        code: normalized.code,
        detail: normalized.message || "Map generation failed"
      });
    }
  }
  async executeAction(input) {
    const handler = this.capabilityRegistry.get(input.actionId);
    if (!handler) {
      throw new AiActionError("INVALID_INPUT", `Unknown actionId: ${input.actionId}`);
    }
    try {
      return await handler(input.payload);
    } catch (error) {
      throw normalizeAiError(error);
    }
  }
  async invokeOpenClawTool(input) {
    try {
      const data = await this.executeAction({
        actionId: input.name,
        payload: input.arguments
      });
      return { ok: true, data };
    } catch (error) {
      const normalized = normalizeAiError(error);
      return {
        ok: false,
        error: formatAiErrorForDisplay(normalized.code, normalized.message || "OpenClaw invoke failed"),
        code: normalized.code
      };
    }
  }
  async invokeOpenClawSkill(input) {
    try {
      const data = await this.executeAction({
        actionId: input.name,
        payload: input.input
      });
      return { ok: true, data };
    } catch (error) {
      const normalized = normalizeAiError(error);
      return {
        ok: false,
        error: formatAiErrorForDisplay(normalized.code, normalized.message || "OpenClaw skill invoke failed"),
        code: normalized.code
      };
    }
  }
  compactContinueHardContext(input) {
    const worldSettings = Array.isArray(input.worldSettings) ? input.worldSettings : [];
    const plotLines = Array.isArray(input.plotLines) ? input.plotLines : [];
    const characters = Array.isArray(input.characters) ? input.characters : [];
    const items = Array.isArray(input.items) ? input.items : [];
    const maps = Array.isArray(input.maps) ? input.maps : [];
    return {
      worldSettings: worldSettings.slice(0, 60).map((item) => ({
        name: trimText(item == null ? void 0 : item.name, 80),
        type: trimText(item == null ? void 0 : item.type, 32) || "other",
        content: trimText(item == null ? void 0 : item.content, 300) || trimText(item == null ? void 0 : item.description, 300)
      })).filter((item) => item.content),
      plotLines: plotLines.slice(0, 40).map((line) => ({
        name: trimText(line == null ? void 0 : line.name, 100),
        description: trimText(line == null ? void 0 : line.description, 260),
        points: Array.isArray(line == null ? void 0 : line.points) ? line.points.filter((point) => String((point == null ? void 0 : point.status) || "").trim().toLowerCase() !== "resolved").slice(0, 12).map((point) => ({
          title: trimText(point == null ? void 0 : point.title, 100),
          description: trimText(point == null ? void 0 : point.description, 220),
          type: trimText(point == null ? void 0 : point.type, 24) || "event",
          status: trimText(point == null ? void 0 : point.status, 24) || "active"
        })).filter((point) => point.title || point.description) : []
      })).filter((line) => {
        var _a;
        return line.name || (((_a = line.points) == null ? void 0 : _a.length) ?? 0) > 0;
      }),
      characters: characters.slice(0, 120).map((item) => ({
        name: trimText(item == null ? void 0 : item.name, 80),
        role: trimText(item == null ? void 0 : item.role, 32),
        description: trimText(item == null ? void 0 : item.description, 220)
      })).filter((item) => item.name && (item.role || item.description)),
      items: items.slice(0, 120).map((item) => ({
        name: trimText(item == null ? void 0 : item.name, 80),
        type: trimText(item == null ? void 0 : item.type, 32) || "item",
        description: trimText(item == null ? void 0 : item.description, 220)
      })).filter((item) => item.name && item.description),
      maps: maps.slice(0, 60).map((item) => ({
        name: trimText(item == null ? void 0 : item.name, 80),
        type: trimText(item == null ? void 0 : item.type, 24) || "world",
        description: trimText(item == null ? void 0 : item.description, 220)
      })).filter((item) => item.name && item.description)
    };
  }
  compactContinueDynamicContext(input) {
    const recentChapters = Array.isArray(input.recentChapters) ? input.recentChapters : [];
    const selectedIdeas = Array.isArray(input.selectedIdeas) ? input.selectedIdeas : [];
    const selectedIdeaEntities = Array.isArray(input.selectedIdeaEntities) ? input.selectedIdeaEntities : [];
    const narrativeSummaries = Array.isArray(input.narrativeSummaries) ? input.narrativeSummaries : [];
    const currentLocation = trimText(input.currentLocation, 120);
    return {
      recentChapters: recentChapters.slice(0, 8).map((chapter) => ({
        title: trimText(chapter == null ? void 0 : chapter.title, 120),
        excerpt: trimText(chapter == null ? void 0 : chapter.excerpt, 1200)
      })).filter((chapter) => chapter.title || chapter.excerpt),
      selectedIdeas: selectedIdeas.slice(0, 20).map((idea) => ({
        content: trimText(idea == null ? void 0 : idea.content, 800),
        quote: trimText(idea == null ? void 0 : idea.quote, 300),
        tags: Array.isArray(idea == null ? void 0 : idea.tags) ? idea.tags.slice(0, 12).map((tag) => trimText(tag, 32)).filter(Boolean) : []
      })).filter((idea) => idea.content || idea.quote),
      selectedIdeaEntities: selectedIdeaEntities.slice(0, 20).map((entity) => ({
        name: trimText(entity == null ? void 0 : entity.name, 80),
        kind: trimText(entity == null ? void 0 : entity.kind, 24)
      })).filter((entity) => entity.name && entity.kind),
      currentChapterBeforeCursor: trimText(input.currentChapterBeforeCursor, 2600),
      ...currentLocation ? { currentLocation } : {},
      narrativeSummaries: narrativeSummaries.slice(0, 4).map((item) => ({
        level: (item == null ? void 0 : item.level) === "volume" ? "volume" : "novel",
        title: trimText(item == null ? void 0 : item.title, 100),
        summaryText: trimText(item == null ? void 0 : item.summaryText, 1200),
        keyFacts: Array.isArray(item == null ? void 0 : item.keyFacts) ? dedupeStrings(item.keyFacts.map((fact) => trimText(fact, 160)).filter(Boolean), 5) : []
      }))
    };
  }
  async buildContinuePromptBundle(payload) {
    var _a;
    const isZh = /^zh/i.test(String(payload.locale || "").trim());
    const writeMode = payload.mode === "new_chapter" ? "new_chapter" : "continue_chapter";
    const context = await this.contextBuilder.buildForContinueWriting({
      ...payload,
      mode: writeMode,
      recentRawChapterCount: payload.recentRawChapterCount ?? this.settingsCache.summary.recentChapterRawCount
    });
    const compactHardContext = this.compactContinueHardContext(context.hardContext);
    const compactDynamicContext = this.compactContinueDynamicContext(context.dynamicContext);
    const normalizedUserIntent = trimText(payload.userIntent, 800);
    const normalizedCurrentLocation = trimText(payload.currentLocation, 120);
    const writeParamsForPrompt = {
      ...context.params,
      targetLength: isZh ? `约${Math.max(100, Math.min(4e3, Number(context.params.targetLength || 500)))}汉字` : `about ${Math.max(100, Math.min(4e3, Number(context.params.targetLength || 500)))} Chinese characters`
    };
    const systemPrompt = isZh ? "你是中文小说续写助手。严格遵守世界观和大纲，不得破坏既有设定与人物行为逻辑。" : "Continue writing with strict consistency to world settings and plot outline. Do not break established lore.";
    const promptSections = [
      `WriteMode=${writeMode}`,
      `HardContext=
${JSON.stringify(compactHardContext, null, 2).slice(0, 18e3)}`,
      `DynamicContext=
${JSON.stringify(compactDynamicContext, null, 2).slice(0, 12e3)}`,
      `WriteParams=
${JSON.stringify(writeParamsForPrompt, null, 2)}`,
      ...normalizedUserIntent ? [`UserIntent=${normalizedUserIntent}`] : [],
      ...normalizedCurrentLocation ? [`CurrentLocation=${normalizedCurrentLocation}`] : [],
      writeMode === "new_chapter" ? isZh ? "Constraint=基于大纲与世界观写出新章节开场，不得复述已有段落。" : "Constraint=Start a fresh chapter opening based on outline and world context. Do not echo prior chapter paragraphs." : isZh ? "Constraint=仅输出新增续写内容，不得重复当前章节或上下文已出现段落。" : "Constraint=Output must be NEW continuation content only. Do not restate prior paragraphs from current chapter or context.",
      isZh ? "Constraint=@实体名 表示对上下文中同名角色/物品/地点/设定的引用，续写时应保持实体设定一致。" : "Constraint=@EntityName means referencing the same named entity from context; keep entity traits consistent.",
      ...normalizedUserIntent ? [isZh ? "Constraint=尽量满足用户意图，但不得违反世界观与主线大纲。" : "Constraint=Prioritize the user intent when possible, but never violate established world settings and plot outline."] : [],
      isZh ? "Constraint=请严格遵守 HardContext 中的世界观、角色性格和物品设定；情节推进需与已有情节点保持一致。" : "Constraint=Strictly follow HardContext lore, character traits, and item settings; keep progression aligned with existing plot points.",
      isZh ? "Constraint=你的任务是续写光标后的新内容，不要重复 currentChapterBeforeCursor 里的任何句子。" : "Constraint=Write only the continuation after cursor; do not repeat any sentence from currentChapterBeforeCursor."
    ];
    const defaultUserPrompt = promptSections.join("\n\n");
    const effectiveUserPrompt = ((_a = payload.overrideUserPrompt) == null ? void 0 : _a.trim()) ? payload.overrideUserPrompt.trim() : defaultUserPrompt;
    const structuredParams = {
      ...context.params,
      ...normalizedUserIntent ? { userIntent: normalizedUserIntent } : {},
      ...normalizedCurrentLocation ? { currentLocation: normalizedCurrentLocation } : {}
    };
    return {
      systemPrompt,
      defaultUserPrompt,
      effectiveUserPrompt,
      structured: {
        goal: writeMode === "new_chapter" ? isZh ? "生成新章节开场内容。" : "Generate opening content for a new chapter." : isZh ? "仅生成续写新增内容。" : "Generate continuation content only.",
        contextRefs: context.usedContext,
        params: structuredParams,
        constraints: [
          ...isZh ? ["严格遵守世界观与大纲一致性。"] : ["Keep strict consistency with world settings and outline."],
          ...normalizedUserIntent ? [isZh ? "在不冲突时优先满足用户意图。" : "Respect user intent when it does not conflict with hard context."] : [],
          ...isZh ? ["不得重复已有段落。", "只输出生成的续写正文。"] : ["Do not repeat existing paragraphs.", "Output only generated chapter text."]
        ]
      },
      usedContext: context.usedContext,
      warnings: context.warnings
    };
  }
  async buildCreativeAssetsPromptBundle(payload) {
    var _a;
    const targetSections = this.resolveCreativeTargetSections(payload);
    const isZh = (payload.locale || "zh").startsWith("zh");
    const novel = await db.novel.findUnique({
      where: { id: payload.novelId },
      select: { id: true, title: true, description: true }
    });
    const context = await this.contextBuilder.buildForCreativeAssets(payload);
    const systemPrompt = isZh ? "你是一位小说创作助手，擅长根据用户的创意需求和已有小说内容生成结构化的创作素材。请严格以 JSON 格式输出，只输出 JSON，不要添加任何其他文字。所有生成的名称、描述等文本内容必须使用中文。生成的内容应与小说已有的角色、情节、世界观保持一致和关联。" : "You are a novel creation assistant. Generate structured creative assets in strict JSON format based on existing novel content. Output only JSON, no extra text. Generated content should be consistent with existing characters, plot, and world settings.";
    const outputSchema = {
      plotLines: [{ name: "string", description: "string?" }],
      plotPoints: [{ title: "string", description: "string?", plotLineName: "string?" }],
      characters: [{ name: "string", role: "string?", description: "string?" }],
      items: [{ name: "string", type: "item|skill|location", description: "string?" }],
      skills: [{ name: "string", description: "string?" }],
      maps: [{ name: "string", type: "world|region|scene", description: "string?", imagePrompt: "string?" }]
    };
    const constraints = isZh ? [
      "仅返回严格的 JSON，不要包含 markdown 代码块标记或其他文字",
      "必须为所有请求的 section 生成内容，不得遗漏任何一个板块",
      `请求的 section 列表: ${targetSections.join(", ")}`,
      "未请求的 section 必须设为空数组",
      "生成内容必须与已有小说内容（角色、情节、世界观）保持一致和关联",
      "避免与已存在的实体重名",
      "所有字段内容简洁、可直接使用",
      "所有名称和描述必须使用中文"
    ] : [
      "return strict JSON only, no markdown code fences or extra text",
      "generate content for ALL requested sections, do not leave any empty",
      `requested sections: ${targetSections.join(", ")}`,
      "all unrequested sections must be empty arrays",
      "generated content must be consistent and related to existing novel content",
      "avoid duplicate names against existing entities",
      "fields should be concise and directly usable"
    ];
    const promptData = {
      task: "creative_assets_generation",
      language: isZh ? "Chinese" : "English",
      brief: payload.brief,
      novel: {
        title: (novel == null ? void 0 : novel.title) || "",
        description: (novel == null ? void 0 : novel.description) || ""
      },
      targetSections,
      outputShape: targetSections,
      outputSchema,
      constraints
    };
    if (context.existingEntities.characters.length > 0) {
      promptData.existingCharacters = context.existingEntities.characters;
    }
    if (context.existingEntities.items.length > 0) {
      promptData.existingItems = context.existingEntities.items;
    }
    if (context.existingEntities.plotLines.length > 0) {
      promptData.existingPlotLines = context.existingEntities.plotLines;
    }
    if (context.existingEntities.worldSettings.length > 0) {
      promptData.worldSettings = context.existingEntities.worldSettings;
    }
    if (context.recentSummaries.length > 0) {
      promptData.recentChapterSummaries = context.recentSummaries;
    }
    if (context.narrativeSummaries.length > 0) {
      promptData.narrativeSummary = context.narrativeSummaries[0];
    }
    const defaultUserPrompt = JSON.stringify(promptData);
    const effectiveUserPrompt = ((_a = payload.overrideUserPrompt) == null ? void 0 : _a.trim()) ? payload.overrideUserPrompt.trim() : defaultUserPrompt;
    const usedContext = [
      `Novel: ${(novel == null ? void 0 : novel.title) || payload.novelId}`,
      ...context.usedContext
    ];
    const goalText = isZh ? "根据用户创意简述和已有小说内容，生成可编辑的草稿素材。" : "Generate editable draft assets based on user brief and existing novel content.";
    const constraintsSummary = isZh ? ["仅输出严格 JSON", "返回所有请求的板块", "与已有内容关联", "内容简洁可用", "避免重名", "使用中文"] : ["Output strict JSON.", "Return ALL selected sections.", "Stay consistent with existing content.", "Prefer concise fields.", "Avoid name conflicts."];
    return {
      systemPrompt,
      defaultUserPrompt,
      effectiveUserPrompt,
      structured: {
        goal: goalText,
        contextRefs: usedContext,
        params: {
          briefLength: payload.brief.trim().length,
          sections: targetSections,
          locale: payload.locale || "zh",
          estimatedContextTokens: context.estimatedTokens
        },
        constraints: constraintsSummary
      },
      usedContext,
      estimatedTokens: context.estimatedTokens
    };
  }
  async buildMapPromptBundle(payload) {
    var _a;
    const worldSettings = await db.worldSetting.findMany({
      where: { novelId: payload.novelId },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, name: true, content: true }
    });
    const usedWorldLore = worldSettings.map((item) => ({
      id: item.id,
      title: String(item.name || "Untitled"),
      excerpt: String(item.content || "").slice(0, 180)
    }));
    const stylePrompt = resolveMapStylePrompt(payload.styleTemplate);
    const loreBlock = usedWorldLore.length > 0 ? usedWorldLore.map((item, index) => `${index + 1}. ${item.title}: ${item.excerpt}`).join("\n") : "No explicit world lore provided.";
    const defaultUserPrompt = [
      stylePrompt || "Style: follow user requested style.",
      `ImageSize=${payload.imageSize || this.settingsCache.http.imageSize || "2K"}`,
      "Task: Generate a clean map background image.",
      `UserRequest=${payload.prompt}`,
      "WorldLore:",
      loreBlock,
      "Constraints:",
      "- avoid text labels or UI marks",
      "- keep high readability for map canvas editing",
      "- preserve coherence with world lore"
    ].join("\n");
    const effectiveUserPrompt = ((_a = payload.overrideUserPrompt) == null ? void 0 : _a.trim()) ? payload.overrideUserPrompt.trim() : defaultUserPrompt;
    return {
      defaultUserPrompt,
      effectiveUserPrompt,
      structured: {
        goal: "Generate map background image aligned with world lore.",
        contextRefs: [
          `Map type: ${payload.mapType || "world"}`,
          `Map name: ${payload.mapName || "(new map)"}`,
          `World lore refs: ${usedWorldLore.length}`
        ],
        params: {
          imageSize: payload.imageSize || this.settingsCache.http.imageSize || "2K",
          styleTemplate: payload.styleTemplate || "default"
        },
        constraints: [
          "No labels or UI overlays in generated image.",
          "Map should be readable for later annotation.",
          "Use world lore when available."
        ]
      },
      usedWorldLore
    };
  }
  getProvider() {
    return this.settingsCache.providerType === "mcp-cli" ? new McpCliProvider(this.settingsCache) : new HttpProvider(this.settingsCache);
  }
  async saveImageAsset(novelId, mapId, input) {
    let mimeType = input.mimeType || "image/png";
    let buffer;
    if (input.imageBase64) {
      buffer = Buffer.from(input.imageBase64, "base64");
    } else if (input.imageUrl) {
      const res = await fetch(input.imageUrl);
      if (!res.ok) {
        throw new Error(`Image download failed: ${res.status}`);
      }
      const headerMime = res.headers.get("content-type") || "";
      if (headerMime)
        mimeType = headerMime;
      const arrayBuffer = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      throw new Error("No image data provided");
    }
    if (buffer.length === 0) {
      throw new Error("Image data is empty");
    }
    if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
      throw new Error("Image exceeds maximum size limit");
    }
    if (!mimeType.startsWith("image/")) {
      throw new Error(`Invalid mime type: ${mimeType}`);
    }
    const ext = mimeToExt(mimeType);
    const mapsDir = path.join(this.userDataPath, "maps", novelId);
    if (!fs.existsSync(mapsDir)) {
      fs.mkdirSync(mapsDir, { recursive: true });
    }
    const filename = sanitizeFileName(`ai-${mapId}-${Date.now()}.${ext}`);
    const absolutePath = path.join(mapsDir, filename);
    fs.writeFileSync(absolutePath, buffer);
    return {
      relativePath: `maps/${novelId}/${filename}`,
      absolutePath
    };
  }
  loadSettings() {
    try {
      if (!fs.existsSync(this.settingsFilePath)) {
        return DEFAULT_AI_SETTINGS;
      }
      const raw = fs.readFileSync(this.settingsFilePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_AI_SETTINGS,
        ...parsed,
        http: { ...DEFAULT_AI_SETTINGS.http, ...parsed.http ?? {} },
        mcpCli: { ...DEFAULT_AI_SETTINGS.mcpCli, ...parsed.mcpCli ?? {} },
        proxy: { ...DEFAULT_AI_SETTINGS.proxy, ...parsed.proxy ?? {} },
        summary: { ...DEFAULT_AI_SETTINGS.summary, ...parsed.summary ?? {} },
        embedding: { ...DEFAULT_AI_SETTINGS.embedding, ...parsed.embedding ?? {} }
      };
    } catch (error) {
      console.error("[AI] Failed to load settings, fallback to defaults:", error);
      return DEFAULT_AI_SETTINGS;
    }
  }
  persistSettings() {
    try {
      const dir = path.dirname(this.settingsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(this.settingsCache, null, 2), "utf8");
    } catch (error) {
      console.error("[AI] Failed to persist settings:", error);
    }
  }
  loadMapImageStats() {
    const fallback = {
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      rateLimitFailures: 0,
      updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
    };
    try {
      if (!fs.existsSync(this.mapImageStatsPath)) {
        return fallback;
      }
      const raw = fs.readFileSync(this.mapImageStatsPath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        totalCalls: parsed.totalCalls ?? 0,
        successCalls: parsed.successCalls ?? 0,
        failedCalls: parsed.failedCalls ?? 0,
        rateLimitFailures: parsed.rateLimitFailures ?? 0,
        lastFailureCode: parsed.lastFailureCode || void 0,
        lastFailureAt: parsed.lastFailureAt || void 0,
        updatedAt: parsed.updatedAt || fallback.updatedAt
      };
    } catch (error) {
      console.warn("[AI] Failed to load map image stats, fallback to defaults:", error);
      return fallback;
    }
  }
  persistMapImageStats() {
    try {
      const dir = path.dirname(this.mapImageStatsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.mapImageStatsPath, JSON.stringify(this.mapImageStatsCache, null, 2), "utf8");
    } catch (error) {
      console.warn("[AI] Failed to persist map image stats:", error);
    }
  }
  recordMapImageCall(input) {
    const codeText = (input.code || "").toLowerCase();
    const detailText = (input.detail || "").toLowerCase();
    const isRateLimit = codeText.includes("rate") || codeText.includes("429") || detailText.includes("429") || detailText.includes("rate limit") || detailText.includes("quota");
    this.mapImageStatsCache = {
      ...this.mapImageStatsCache,
      totalCalls: this.mapImageStatsCache.totalCalls + 1,
      successCalls: this.mapImageStatsCache.successCalls + (input.ok ? 1 : 0),
      failedCalls: this.mapImageStatsCache.failedCalls + (input.ok ? 0 : 1),
      rateLimitFailures: this.mapImageStatsCache.rateLimitFailures + (!input.ok && isRateLimit ? 1 : 0),
      lastFailureCode: input.ok ? this.mapImageStatsCache.lastFailureCode : input.code || "UNKNOWN",
      lastFailureAt: input.ok ? this.mapImageStatsCache.lastFailureAt : (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.persistMapImageStats();
  }
}
const EMPTY_STORE = {
  sessions: []
};
class DraftSessionStore {
  constructor(getUserDataPath) {
    __publicField(this, "getUserDataPath");
    __publicField(this, "cache", null);
    this.getUserDataPath = getUserDataPath;
  }
  getStoreDir() {
    return path.join(this.getUserDataPath(), "automation");
  }
  getStorePath() {
    return path.join(this.getStoreDir(), "draft-sessions.json");
  }
  async ensureLoaded() {
    if (this.cache)
      return;
    const filePath = this.getStorePath();
    try {
      const raw = await fs$1.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch (error) {
      if ((error == null ? void 0 : error.code) !== "ENOENT") {
        throw error;
      }
      this.cache = [...EMPTY_STORE.sessions];
    }
  }
  async flush() {
    await fs$1.mkdir(this.getStoreDir(), { recursive: true });
    const filePath = this.getStorePath();
    const payload = {
      sessions: this.cache ?? []
    };
    await fs$1.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
  async list(filters) {
    await this.ensureLoaded();
    const sessions = [...this.cache ?? []];
    return sessions.filter((session2) => {
      if ((filters == null ? void 0 : filters.novelId) && session2.novelId !== filters.novelId)
        return false;
      if ((filters == null ? void 0 : filters.workspace) && session2.workspace !== filters.workspace)
        return false;
      if ((filters == null ? void 0 : filters.type) && session2.type !== filters.type)
        return false;
      if ((filters == null ? void 0 : filters.status) && session2.status !== filters.status)
        return false;
      if (!(filters == null ? void 0 : filters.includeInactive) && session2.status !== "draft")
        return false;
      return true;
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  async getById(draftSessionId) {
    await this.ensureLoaded();
    return (this.cache ?? []).find((session2) => session2.draftSessionId === draftSessionId) ?? null;
  }
  async getLatest(filters) {
    const sessions = await this.list(filters);
    return sessions[0] ?? null;
  }
  async create(input) {
    await this.ensureLoaded();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const session2 = {
      ...input,
      draftSessionId: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.cache = [session2, ...(this.cache ?? []).filter((item) => item.novelId !== session2.novelId || item.workspace !== session2.workspace || item.type !== session2.type || item.status !== "draft")];
    await this.flush();
    return session2;
  }
  async update(draftSessionId, expectedVersion, updater) {
    await this.ensureLoaded();
    const sessions = this.cache ?? [];
    const index = sessions.findIndex((session2) => session2.draftSessionId === draftSessionId);
    if (index < 0) {
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    }
    const current = sessions[index];
    if (typeof expectedVersion === "number" && current.version !== expectedVersion) {
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    }
    const next = updater(current);
    const updated = {
      ...next,
      draftSessionId: current.draftSessionId,
      createdAt: current.createdAt,
      version: current.version + 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    sessions[index] = updated;
    this.cache = sessions;
    await this.flush();
    return updated;
  }
}
const EMPTY_CREATIVE_DRAFT = {
  plotLines: [],
  plotPoints: [],
  characters: [],
  items: [],
  skills: [],
  maps: []
};
const AUTOMATION_TIMEOUT_MS = {
  "novel.list": 15e3,
  "volume.list": 15e3,
  "chapter.list": 15e3,
  "chapter.get": 15e3,
  "plotline.list": 15e3,
  "character.list": 15e3,
  "item.list": 15e3,
  "worldsetting.list": 15e3,
  "worldsetting.create": 3e4,
  "worldsetting.update": 3e4,
  "map.list": 15e3,
  "search.query": 15e3,
  "draft.list": 15e3,
  "draft.get": 15e3,
  "draft.get_active": 15e3,
  "draft.update": 15e3,
  "draft.commit": 3e4,
  "draft.discard": 15e3,
  "outline.write": 3e4,
  "character.create_batch": 3e4,
  "story_patch.apply": 3e4,
  "chapter.create": 3e4,
  "chapter.save": 3e4,
  "prompt.preview": 3e4,
  "creative_assets.validate_draft": 3e4,
  "creative_assets.generate_draft": 9e4,
  "outline.generate_draft": 9e4,
  "chapter.generate_draft": 9e4
};
const DEFAULT_AUTOMATION_TIMEOUT_MS = 3e4;
function createSelectionFromDraft(draft) {
  return {
    plotLines: (draft.plotLines ?? []).map(() => true),
    plotPoints: (draft.plotPoints ?? []).map(() => true),
    characters: (draft.characters ?? []).map(() => true),
    items: (draft.items ?? []).map(() => true),
    skills: (draft.skills ?? []).map(() => true),
    maps: (draft.maps ?? []).map(() => true)
  };
}
function normalizeCreativeDraft(input) {
  if (!input || typeof input !== "object")
    return { ...EMPTY_CREATIVE_DRAFT };
  const draft = input;
  return {
    plotLines: Array.isArray(draft.plotLines) ? draft.plotLines : [],
    plotPoints: Array.isArray(draft.plotPoints) ? draft.plotPoints : [],
    characters: Array.isArray(draft.characters) ? draft.characters : [],
    items: Array.isArray(draft.items) ? draft.items : [],
    skills: Array.isArray(draft.skills) ? draft.skills : [],
    maps: Array.isArray(draft.maps) ? draft.maps : []
  };
}
function summarizeCreativeDraft(draft) {
  var _a, _b, _c, _d, _e, _f;
  const parts = [
    `主线 ${((_a = draft.plotLines) == null ? void 0 : _a.length) ?? 0}`,
    `要点 ${((_b = draft.plotPoints) == null ? void 0 : _b.length) ?? 0}`,
    `角色 ${((_c = draft.characters) == null ? void 0 : _c.length) ?? 0}`,
    `物品 ${((_d = draft.items) == null ? void 0 : _d.length) ?? 0}`,
    `技能 ${((_e = draft.skills) == null ? void 0 : _e.length) ?? 0}`,
    `地图 ${((_f = draft.maps) == null ? void 0 : _f.length) ?? 0}`
  ];
  return parts.join(" / ");
}
function sanitizeGeneratedDraft(draft) {
  const keepNonEmpty = (items, requiredKey) => {
    const list = Array.isArray(items) ? items : [];
    return list.filter((item) => typeof item === "object" && item && String(item[requiredKey] || "").trim());
  };
  return {
    plotLines: keepNonEmpty(draft.plotLines, "name"),
    plotPoints: keepNonEmpty(draft.plotPoints, "title"),
    characters: keepNonEmpty(draft.characters, "name"),
    items: keepNonEmpty(draft.items, "name"),
    skills: keepNonEmpty(draft.skills, "name"),
    maps: keepNonEmpty(draft.maps, "name")
  };
}
function pickSelectedCreativeDraft(draft, selection) {
  if (!selection)
    return normalizeCreativeDraft(draft);
  return {
    plotLines: (draft.plotLines ?? []).filter((_, index) => selection.plotLines[index]),
    plotPoints: (draft.plotPoints ?? []).filter((_, index) => selection.plotPoints[index]),
    characters: (draft.characters ?? []).filter((_, index) => selection.characters[index]),
    items: (draft.items ?? []).filter((_, index) => selection.items[index]),
    skills: (draft.skills ?? []).filter((_, index) => selection.skills[index]),
    maps: (draft.maps ?? []).filter((_, index) => selection.maps[index])
  };
}
function buildOutlineDraft(input) {
  return normalizeCreativeDraft({
    plotLines: input.plotLines,
    plotPoints: input.plotPoints
  });
}
function buildCharacterBatchDraft(input) {
  return normalizeCreativeDraft({
    characters: input.characters,
    items: input.items,
    skills: input.skills
  });
}
function createAutomationError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}
function assertRequiredString(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw createAutomationError("INVALID_INPUT", `${field} is required`);
  }
  return text;
}
function assertRequiredNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw createAutomationError("INVALID_INPUT", `${field} must be a finite number`);
  }
  return value;
}
function resolveAutomationTimeout(method) {
  return AUTOMATION_TIMEOUT_MS[method] ?? DEFAULT_AUTOMATION_TIMEOUT_MS;
}
function normalizePromptPreviewKind(kind) {
  const normalized = String(kind || "").trim().toLowerCase();
  if (["creative_assets", "creative-assets", "outline-generate", "outline_generate", "outline"].includes(normalized)) {
    return "creative_assets";
  }
  if (["chapter", "chapter-generate", "chapter_generate", "continue-writing", "continue_writing"].includes(normalized)) {
    return "chapter";
  }
  throw createAutomationError("INVALID_INPUT", `Unsupported prompt preview kind: ${String(kind || "")}`);
}
class AutomationService {
  constructor(aiService2, getUserDataPath) {
    __publicField(this, "aiService");
    __publicField(this, "draftStore");
    this.aiService = aiService2;
    this.draftStore = new DraftSessionStore(getUserDataPath);
  }
  logInvokeStart(method, params, context, timeoutMs) {
    devLog("INFO", "AutomationService.invoke.start", "Automation invoke start", {
      requestId: context.requestId,
      method,
      source: context.source,
      origin: context.origin,
      timeoutMs,
      params: redactForLog(params)
    });
  }
  logInvokeSuccess(method, context, startedAt, result) {
    devLog("INFO", "AutomationService.invoke.success", "Automation invoke success", {
      requestId: context.requestId,
      method,
      elapsedMs: Date.now() - startedAt,
      result: redactForLog(result)
    });
  }
  logInvokeError(method, context, startedAt, error) {
    devLogError("AutomationService.invoke.error", error, {
      requestId: context.requestId,
      method,
      elapsedMs: Date.now() - startedAt
    });
  }
  async withTimeout(method, params, context, task) {
    const timeoutMs = resolveAutomationTimeout(method);
    const startedAt = Date.now();
    this.logInvokeStart(method, params, context, timeoutMs);
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      var _a;
      timer = setTimeout(() => {
        reject(createAutomationError("UPSTREAM_TIMEOUT", `Automation method ${method} timed out after ${timeoutMs}ms`, {
          method,
          timeoutMs,
          requestId: context.requestId
        }));
      }, timeoutMs);
      (_a = timer.unref) == null ? void 0 : _a.call(timer);
    });
    try {
      const result = await Promise.race([task(), timeoutPromise]);
      if (timer)
        clearTimeout(timer);
      this.logInvokeSuccess(method, context, startedAt, result);
      return result;
    } catch (error) {
      if (timer)
        clearTimeout(timer);
      this.logInvokeError(method, context, startedAt, error);
      throw error;
    }
  }
  buildPromptPreviewPayload(kind, payload) {
    if (kind === "creative_assets") {
      const novelId = assertRequiredString(payload.novelId, "payload.novelId");
      const brief = assertRequiredString(payload.brief, "payload.brief");
      const targetSections = Array.isArray(payload.targetSections) ? payload.targetSections : String(payload.kind || "").toLowerCase().includes("outline") ? ["plotLines", "plotPoints"] : void 0;
      return {
        ...payload,
        novelId,
        brief,
        ...targetSections ? { targetSections } : {}
      };
    }
    return {
      ...payload,
      novelId: assertRequiredString(payload.novelId, "payload.novelId"),
      chapterId: assertRequiredString(payload.chapterId, "payload.chapterId"),
      currentContent: assertRequiredString(payload.currentContent, "payload.currentContent")
    };
  }
  async listDrafts(filters) {
    return this.draftStore.list(filters);
  }
  async getDraft(draftSessionId) {
    return this.draftStore.getById(draftSessionId);
  }
  async getActiveDraft(input) {
    assertRequiredString(input == null ? void 0 : input.novelId, "novelId");
    return this.draftStore.getLatest({
      novelId: input.novelId,
      workspace: input.workspace,
      type: input.type,
      status: "draft"
    });
  }
  async generateCreativeAssetsDraft(payload, context, type = "creative-assets") {
    assertRequiredString(payload == null ? void 0 : payload.novelId, "novelId");
    assertRequiredString(payload == null ? void 0 : payload.brief, "brief");
    const result = await this.aiService.generateCreativeAssets(payload);
    const sanitizedDraft = sanitizeGeneratedDraft(normalizeCreativeDraft(result.draft));
    return this.draftStore.create({
      workspace: "ai-workbench",
      type,
      source: "internal-ai",
      origin: context.origin ?? "unknown",
      novelId: payload.novelId,
      status: "draft",
      payload: sanitizedDraft,
      selection: createSelectionFromDraft(sanitizedDraft),
      previewSummary: summarizeCreativeDraft(sanitizedDraft),
      validation: null
    });
  }
  async createChapterDraftSession(payload, context) {
    assertRequiredString(payload == null ? void 0 : payload.novelId, "novelId");
    assertRequiredString(payload == null ? void 0 : payload.chapterId, "chapterId");
    assertRequiredString(payload == null ? void 0 : payload.currentContent, "currentContent");
    const requestedPresentation = typeof payload.presentation === "string" ? payload.presentation.trim().toLowerCase() : "";
    const normalizedPresentation = requestedPresentation === "silent" || requestedPresentation === "toast" || requestedPresentation === "modal" ? requestedPresentation : void 0;
    const { presentation: _presentation, ...chapterGeneratePayload } = payload;
    const result = await this.aiService.executeAction({
      actionId: "chapter.generate",
      payload: chapterGeneratePayload
    });
    const chapterPayload = {
      chapterId: payload.chapterId,
      baseContent: payload.currentContent,
      generatedText: result.text,
      content: `${payload.currentContent}${result.text}`,
      presentation: normalizedPresentation,
      usedContext: result.usedContext,
      warnings: result.warnings,
      consistency: result.consistency
    };
    return this.draftStore.create({
      workspace: "chapter-editor",
      type: "chapter-draft",
      source: "internal-ai",
      origin: context.origin ?? "unknown",
      novelId: payload.novelId,
      chapterId: payload.chapterId,
      status: "draft",
      payload: chapterPayload,
      previewSummary: `章节草稿 ${result.text.length} 字符`
    });
  }
  async updateDraft(input) {
    assertRequiredString(input == null ? void 0 : input.draftSessionId, "draftSessionId");
    assertRequiredNumber(input == null ? void 0 : input.version, "version");
    return this.draftStore.update(input.draftSessionId, input.version, (current) => {
      var _a;
      return {
        ...current,
        payload: input.payload ?? current.payload,
        selection: input.selection ?? current.selection,
        validation: input.validation === void 0 ? current.validation : input.validation,
        previewSummary: current.type === "chapter-draft" ? `章节草稿 ${((_a = (input.payload ?? current.payload).generatedText) == null ? void 0 : _a.length) ?? 0} 字符` : summarizeCreativeDraft(normalizeCreativeDraft(input.payload ?? current.payload))
      };
    });
  }
  async discardDraft(input) {
    assertRequiredString(input == null ? void 0 : input.draftSessionId, "draftSessionId");
    assertRequiredNumber(input == null ? void 0 : input.version, "version");
    return this.draftStore.update(input.draftSessionId, input.version, (current) => ({
      ...current,
      status: "discarded"
    }));
  }
  async validateCreativeDraftSession(input) {
    assertRequiredString(input == null ? void 0 : input.draftSessionId, "draftSessionId");
    const session2 = await this.draftStore.getById(input.draftSessionId);
    if (!session2) {
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    }
    if (typeof input.version === "number" && session2.version !== input.version) {
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    }
    if (session2.type !== "creative-assets" && session2.type !== "outline-draft") {
      throw Object.assign(new Error("Only creative draft sessions can be validated"), { code: "INVALID_INPUT" });
    }
    const validation = await this.aiService.validateCreativeAssetsDraft({
      novelId: session2.novelId,
      draft: pickSelectedCreativeDraft(normalizeCreativeDraft(session2.payload), session2.selection)
    });
    const updated = await this.draftStore.update(session2.draftSessionId, session2.version, (current) => ({
      ...current,
      validation,
      payload: validation.normalizedDraft,
      selection: createSelectionFromDraft(validation.normalizedDraft),
      previewSummary: summarizeCreativeDraft(validation.normalizedDraft)
    }));
    return {
      session: updated,
      validation
    };
  }
  async commitDraft(input) {
    assertRequiredString(input == null ? void 0 : input.draftSessionId, "draftSessionId");
    assertRequiredNumber(input == null ? void 0 : input.version, "version");
    const session2 = await this.draftStore.getById(input.draftSessionId);
    if (!session2) {
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    }
    if (session2.version !== input.version) {
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    }
    if (session2.type === "creative-assets" || session2.type === "outline-draft") {
      const validation = await this.aiService.validateCreativeAssetsDraft({
        novelId: session2.novelId,
        draft: pickSelectedCreativeDraft(normalizeCreativeDraft(session2.payload), session2.selection)
      });
      const normalizedDraft = validation.normalizedDraft;
      const updatedForValidation = await this.draftStore.update(session2.draftSessionId, session2.version, (current) => ({
        ...current,
        payload: normalizedDraft,
        selection: createSelectionFromDraft(normalizedDraft),
        validation,
        previewSummary: summarizeCreativeDraft(normalizedDraft)
      }));
      if (!validation.ok) {
        return {
          session: updatedForValidation,
          validation
        };
      }
      const confirmResult = await this.aiService.confirmCreativeAssets({
        novelId: session2.novelId,
        draft: normalizedDraft
      });
      const committed = await this.draftStore.update(updatedForValidation.draftSessionId, updatedForValidation.version, (current) => ({
        ...current,
        status: confirmResult.success ? "committed" : "failed",
        validation
      }));
      return {
        session: committed,
        validation,
        confirmResult
      };
    }
    if (session2.type === "chapter-draft") {
      const chapterPayload = session2.payload;
      const saveResult = await this.aiService.executeAction({
        actionId: "chapter.save",
        payload: {
          chapterId: chapterPayload.chapterId,
          content: chapterPayload.content,
          source: "ai_agent"
        }
      });
      const committed = await this.draftStore.update(session2.draftSessionId, session2.version, (current) => ({
        ...current,
        status: "committed"
      }));
      return {
        session: committed,
        saveResult
      };
    }
    throw Object.assign(new Error(`Unsupported draft type: ${session2.type}`), { code: "INVALID_INPUT" });
  }
  async previewPrompt(input) {
    const normalizedKind = normalizePromptPreviewKind(input == null ? void 0 : input.kind);
    const normalizedPayload = this.buildPromptPreviewPayload(normalizedKind, (input == null ? void 0 : input.payload) ?? {});
    let preview;
    if (normalizedKind === "creative_assets") {
      preview = await this.aiService.previewCreativeAssetsPrompt(normalizedPayload);
    } else {
      preview = await this.aiService.previewContinuePrompt(normalizedPayload);
    }
    return {
      kind: normalizedKind,
      preview
    };
  }
  async applyPartialCreativeDraft(input) {
    assertRequiredString(input == null ? void 0 : input.novelId, "novelId");
    const validation = await this.aiService.validateCreativeAssetsDraft({
      novelId: input.novelId,
      draft: normalizeCreativeDraft(input.draft)
    });
    if (!validation.ok) {
      return { validation };
    }
    const confirmResult = await this.aiService.confirmCreativeAssets({
      novelId: input.novelId,
      draft: validation.normalizedDraft
    });
    return { validation, confirmResult };
  }
  async invoke(method, params, context) {
    return this.withTimeout(method, params, context, async () => {
      switch (method) {
        case "draft.list":
          return this.listDrafts(params);
        case "draft.get":
          return this.getDraft(assertRequiredString(params == null ? void 0 : params.draftSessionId, "draftSessionId"));
        case "draft.get_active":
          return this.getActiveDraft(params);
        case "draft.update":
          return this.updateDraft(params);
        case "draft.commit":
          return this.commitDraft(params);
        case "draft.discard":
          return this.discardDraft(params);
        case "creative_assets.generate_draft":
          return this.generateCreativeAssetsDraft(params, context, "creative-assets");
        case "outline.generate_draft":
          return this.generateCreativeAssetsDraft({
            ...params,
            targetSections: ["plotLines", "plotPoints"]
          }, context, "outline-draft");
        case "chapter.generate_draft":
          return this.createChapterDraftSession(params, context);
        case "creative_assets.validate_draft":
          return this.validateCreativeDraftSession(params);
        case "outline.write":
          return this.applyPartialCreativeDraft({
            novelId: assertRequiredString(params == null ? void 0 : params.novelId, "novelId"),
            draft: buildOutlineDraft(params)
          });
        case "character.create_batch":
          return this.applyPartialCreativeDraft({
            novelId: assertRequiredString(params == null ? void 0 : params.novelId, "novelId"),
            draft: buildCharacterBatchDraft(params)
          });
        case "story_patch.apply":
          return this.applyPartialCreativeDraft({
            novelId: assertRequiredString(params == null ? void 0 : params.novelId, "novelId"),
            draft: normalizeCreativeDraft(params == null ? void 0 : params.draft)
          });
        case "prompt.preview":
          return this.previewPrompt(params);
        default:
          return this.aiService.executeAction({
            actionId: method,
            payload: params
          });
      }
    });
  }
}
class AutomationServer {
  constructor(automationService2, getUserDataPath, onDataChanged) {
    __publicField(this, "automationService");
    __publicField(this, "getUserDataPath");
    __publicField(this, "onDataChanged");
    __publicField(this, "server", null);
    __publicField(this, "runtime", null);
    this.automationService = automationService2;
    this.getUserDataPath = getUserDataPath;
    this.onDataChanged = onDataChanged;
  }
  notifyDataChanged(method) {
    var _a;
    const dataChangingMethods = /* @__PURE__ */ new Set([
      "outline.write",
      "character.create_batch",
      "story_patch.apply",
      "worldsetting.create",
      "worldsetting.update",
      "chapter.create",
      "chapter.save",
      "creative_assets.generate_draft",
      "outline.generate_draft",
      "chapter.generate_draft",
      "draft.update",
      "draft.commit",
      "draft.discard"
    ]);
    if (dataChangingMethods.has(method)) {
      (_a = this.onDataChanged) == null ? void 0 : _a.call(this, method);
    }
  }
  getAutomationDir() {
    return path.join(this.getUserDataPath(), "automation");
  }
  getRuntimePath() {
    return path.join(this.getAutomationDir(), "runtime.json");
  }
  async writeRuntime() {
    if (!this.runtime)
      return;
    await fs$1.mkdir(this.getAutomationDir(), { recursive: true });
    await fs$1.writeFile(this.getRuntimePath(), JSON.stringify(this.runtime, null, 2), "utf8");
  }
  async removeRuntime() {
    try {
      await fs$1.unlink(this.getRuntimePath());
    } catch (error) {
      if ((error == null ? void 0 : error.code) !== "ENOENT") {
        throw error;
      }
    }
  }
  sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body, "utf8")
    });
    res.end(body);
  }
  async readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return body ? JSON.parse(body) : {};
  }
  normalizeError(error) {
    return {
      code: (error == null ? void 0 : error.code) || "INTERNAL_ERROR",
      message: (error == null ? void 0 : error.message) || "Internal automation error",
      details: error == null ? void 0 : error.details
    };
  }
  isAuthorized(req) {
    if (!this.runtime)
      return false;
    const auth = req.headers.authorization || "";
    return auth === `Bearer ${this.runtime.token}`;
  }
  async start() {
    if (this.server)
      return;
    this.runtime = {
      version: 1,
      port: 0,
      token: randomUUID(),
      pid: process.pid,
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.server = http.createServer(async (req, res) => {
      try {
        if (req.url === "/health") {
          this.sendJson(res, 200, { ok: true, code: "OK", message: "healthy", data: { pid: process.pid } });
          return;
        }
        if (!this.isAuthorized(req)) {
          this.sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Unauthorized" });
          return;
        }
        if (req.method === "POST" && req.url === "/invoke") {
          const payload = await this.readJson(req);
          const requestId = typeof payload.requestId === "string" && payload.requestId.trim() ? payload.requestId.trim() : randomUUID();
          const startedAt = Date.now();
          devLog("INFO", "AutomationServer.invoke.start", "Automation HTTP invoke start", {
            requestId,
            method: payload.method,
            origin: payload.origin ?? "mcp-bridge",
            params: redactForLog(payload.params)
          });
          const data = await this.automationService.invoke(payload.method, payload.params, {
            source: "http",
            origin: payload.origin ?? "mcp-bridge",
            requestId
          });
          devLog("INFO", "AutomationServer.invoke.success", "Automation HTTP invoke success", {
            requestId,
            method: payload.method,
            elapsedMs: Date.now() - startedAt,
            result: redactForLog(data)
          });
          this.notifyDataChanged(String(payload.method || ""));
          this.sendJson(res, 200, { ok: true, code: "OK", message: "ok", data });
          return;
        }
        this.sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "Not found" });
      } catch (error) {
        const normalized = this.normalizeError(error);
        devLogError("AutomationServer.invoke.error", error, {
          url: req.url,
          method: req.method
        });
        this.sendJson(res, 500, {
          ok: false,
          code: normalized.code,
          message: normalized.message,
          data: normalized.details
        });
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve automation server port");
    }
    this.runtime.port = address.port;
    await this.writeRuntime();
  }
  async stop() {
    await this.removeRuntime();
    if (!this.server)
      return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error)
          reject(error);
        else
          resolve();
      });
    });
    this.server = null;
    this.runtime = null;
  }
}
const API_BASE = "http://localhost:8080/api/sync";
class SyncManager {
  // Get the global sync cursor
  async getCursor() {
    const state = await db.syncState.findUnique({ where: { id: "global" } });
    return state ? Number(state.cursor) : 0;
  }
  async setCursor(val) {
    await db.syncState.upsert({
      where: { id: "global" },
      create: { id: "global", cursor: BigInt(val) },
      update: { cursor: BigInt(val) }
    });
  }
  async pull() {
    var _a, _b;
    const cursor = await this.getCursor();
    console.log("[Sync] Pulling from cursor:", cursor);
    try {
      const response = await fetch(`${API_BASE}/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastSyncCursor: cursor })
      });
      if (!response.ok)
        throw new Error(`Pull failed: ${response.statusText}`);
      const result = await response.json();
      const { newSyncCursor, data } = result;
      await db.$transaction(async (tx) => {
        var _a2, _b2, _c;
        if ((_a2 = data.novels) == null ? void 0 : _a2.length) {
          for (const novel of data.novels) {
            await tx.novel.upsert({
              where: { id: novel.id },
              create: { ...novel, updatedAt: new Date(novel.updatedAt), createdAt: new Date(novel.createdAt) },
              update: { ...novel, updatedAt: new Date(novel.updatedAt), createdAt: new Date(novel.createdAt) }
            });
          }
        }
        if ((_b2 = data.volumes) == null ? void 0 : _b2.length) {
          for (const vol of data.volumes) {
            await tx.volume.upsert({
              where: { id: vol.id },
              create: { ...vol, updatedAt: new Date(vol.updatedAt), createdAt: new Date(vol.createdAt) },
              update: { ...vol, updatedAt: new Date(vol.updatedAt), createdAt: new Date(vol.createdAt) }
            });
          }
        }
        if ((_c = data.chapters) == null ? void 0 : _c.length) {
          for (const ch of data.chapters) {
            await tx.chapter.upsert({
              where: { id: ch.id },
              create: { ...ch, updatedAt: new Date(ch.updatedAt), createdAt: new Date(ch.createdAt) },
              update: { ...ch, updatedAt: new Date(ch.updatedAt), createdAt: new Date(ch.createdAt) }
            });
          }
        }
      });
      await this.setCursor(newSyncCursor);
      console.log("[Sync] Pull complete. New cursor:", newSyncCursor);
      return { success: true, count: (((_a = data.novels) == null ? void 0 : _a.length) || 0) + (((_b = data.chapters) == null ? void 0 : _b.length) || 0) };
    } catch (e) {
      console.error("[Sync] Pull error:", e);
      throw e;
    }
  }
  async push() {
    const cursor = await this.getCursor();
    const changes = {
      novels: await db.novel.findMany({ where: { updatedAt: { gt: new Date(cursor) } } }),
      volumes: await db.volume.findMany({ where: { updatedAt: { gt: new Date(cursor) } } }),
      chapters: await db.chapter.findMany({ where: { updatedAt: { gt: new Date(cursor) } } })
    };
    if (changes.novels.length === 0 && changes.volumes.length === 0 && changes.chapters.length === 0) {
      return { success: true, count: 0 };
    }
    console.log("[Sync] Pushing changes...");
    const payload = JSON.stringify({
      lastSyncCursor: cursor,
      changes
    }, (_, v) => typeof v === "bigint" ? v.toString() : v);
    const response = await fetch(`${API_BASE}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    if (!response.ok)
      throw new Error(`Push failed: ${response.statusText}`);
    console.log("[Sync] Push success");
    return await response.json();
  }
}
function getDefaultExportFromCjs(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var util = { exports: {} };
var constants = {
  /* The local file header */
  LOCHDR: 30,
  // LOC header size
  LOCSIG: 67324752,
  // "PK\003\004"
  LOCVER: 4,
  // version needed to extract
  LOCFLG: 6,
  // general purpose bit flag
  LOCHOW: 8,
  // compression method
  LOCTIM: 10,
  // modification time (2 bytes time, 2 bytes date)
  LOCCRC: 14,
  // uncompressed file crc-32 value
  LOCSIZ: 18,
  // compressed size
  LOCLEN: 22,
  // uncompressed size
  LOCNAM: 26,
  // filename length
  LOCEXT: 28,
  // extra field length
  /* The Data descriptor */
  EXTSIG: 134695760,
  // "PK\007\008"
  EXTHDR: 16,
  // EXT header size
  EXTCRC: 4,
  // uncompressed file crc-32 value
  EXTSIZ: 8,
  // compressed size
  EXTLEN: 12,
  // uncompressed size
  /* The central directory file header */
  CENHDR: 46,
  // CEN header size
  CENSIG: 33639248,
  // "PK\001\002"
  CENVEM: 4,
  // version made by
  CENVER: 6,
  // version needed to extract
  CENFLG: 8,
  // encrypt, decrypt flags
  CENHOW: 10,
  // compression method
  CENTIM: 12,
  // modification time (2 bytes time, 2 bytes date)
  CENCRC: 16,
  // uncompressed file crc-32 value
  CENSIZ: 20,
  // compressed size
  CENLEN: 24,
  // uncompressed size
  CENNAM: 28,
  // filename length
  CENEXT: 30,
  // extra field length
  CENCOM: 32,
  // file comment length
  CENDSK: 34,
  // volume number start
  CENATT: 36,
  // internal file attributes
  CENATX: 38,
  // external file attributes (host system dependent)
  CENOFF: 42,
  // LOC header offset
  /* The entries in the end of central directory */
  ENDHDR: 22,
  // END header size
  ENDSIG: 101010256,
  // "PK\005\006"
  ENDSUB: 8,
  // number of entries on this disk
  ENDTOT: 10,
  // total number of entries
  ENDSIZ: 12,
  // central directory size in bytes
  ENDOFF: 16,
  // offset of first CEN header
  ENDCOM: 20,
  // zip file comment length
  END64HDR: 20,
  // zip64 END header size
  END64SIG: 117853008,
  // zip64 Locator signature, "PK\006\007"
  END64START: 4,
  // number of the disk with the start of the zip64
  END64OFF: 8,
  // relative offset of the zip64 end of central directory
  END64NUMDISKS: 16,
  // total number of disks
  ZIP64SIG: 101075792,
  // zip64 signature, "PK\006\006"
  ZIP64HDR: 56,
  // zip64 record minimum size
  ZIP64LEAD: 12,
  // leading bytes at the start of the record, not counted by the value stored in ZIP64SIZE
  ZIP64SIZE: 4,
  // zip64 size of the central directory record
  ZIP64VEM: 12,
  // zip64 version made by
  ZIP64VER: 14,
  // zip64 version needed to extract
  ZIP64DSK: 16,
  // zip64 number of this disk
  ZIP64DSKDIR: 20,
  // number of the disk with the start of the record directory
  ZIP64SUB: 24,
  // number of entries on this disk
  ZIP64TOT: 32,
  // total number of entries
  ZIP64SIZB: 40,
  // zip64 central directory size in bytes
  ZIP64OFF: 48,
  // offset of start of central directory with respect to the starting disk number
  ZIP64EXTRA: 56,
  // extensible data sector
  /* Compression methods */
  STORED: 0,
  // no compression
  SHRUNK: 1,
  // shrunk
  REDUCED1: 2,
  // reduced with compression factor 1
  REDUCED2: 3,
  // reduced with compression factor 2
  REDUCED3: 4,
  // reduced with compression factor 3
  REDUCED4: 5,
  // reduced with compression factor 4
  IMPLODED: 6,
  // imploded
  // 7 reserved for Tokenizing compression algorithm
  DEFLATED: 8,
  // deflated
  ENHANCED_DEFLATED: 9,
  // enhanced deflated
  PKWARE: 10,
  // PKWare DCL imploded
  // 11 reserved by PKWARE
  BZIP2: 12,
  //  compressed using BZIP2
  // 13 reserved by PKWARE
  LZMA: 14,
  // LZMA
  // 15-17 reserved by PKWARE
  IBM_TERSE: 18,
  // compressed using IBM TERSE
  IBM_LZ77: 19,
  // IBM LZ77 z
  AES_ENCRYPT: 99,
  // WinZIP AES encryption method
  /* General purpose bit flag */
  // values can obtained with expression 2**bitnr
  FLG_ENC: 1,
  // Bit 0: encrypted file
  FLG_COMP1: 2,
  // Bit 1, compression option
  FLG_COMP2: 4,
  // Bit 2, compression option
  FLG_DESC: 8,
  // Bit 3, data descriptor
  FLG_ENH: 16,
  // Bit 4, enhanced deflating
  FLG_PATCH: 32,
  // Bit 5, indicates that the file is compressed patched data.
  FLG_STR: 64,
  // Bit 6, strong encryption (patented)
  // Bits 7-10: Currently unused.
  FLG_EFS: 2048,
  // Bit 11: Language encoding flag (EFS)
  // Bit 12: Reserved by PKWARE for enhanced compression.
  // Bit 13: encrypted the Central Directory (patented).
  // Bits 14-15: Reserved by PKWARE.
  FLG_MSK: 4096,
  // mask header values
  /* Load type */
  FILE: 2,
  BUFFER: 1,
  NONE: 0,
  /* 4.5 Extensible data fields */
  EF_ID: 0,
  EF_SIZE: 2,
  /* Header IDs */
  ID_ZIP64: 1,
  ID_AVINFO: 7,
  ID_PFS: 8,
  ID_OS2: 9,
  ID_NTFS: 10,
  ID_OPENVMS: 12,
  ID_UNIX: 13,
  ID_FORK: 14,
  ID_PATCH: 15,
  ID_X509_PKCS7: 20,
  ID_X509_CERTID_F: 21,
  ID_X509_CERTID_C: 22,
  ID_STRONGENC: 23,
  ID_RECORD_MGT: 24,
  ID_X509_PKCS7_RL: 25,
  ID_IBM1: 101,
  ID_IBM2: 102,
  ID_POSZIP: 18064,
  EF_ZIP64_OR_32: 4294967295,
  EF_ZIP64_OR_16: 65535,
  EF_ZIP64_SUNCOMP: 0,
  EF_ZIP64_SCOMP: 8,
  EF_ZIP64_RHO: 16,
  EF_ZIP64_DSN: 24
};
var errors = {};
(function(exports$1) {
  const errors2 = {
    /* Header error messages */
    INVALID_LOC: "Invalid LOC header (bad signature)",
    INVALID_CEN: "Invalid CEN header (bad signature)",
    INVALID_END: "Invalid END header (bad signature)",
    /* Descriptor */
    DESCRIPTOR_NOT_EXIST: "No descriptor present",
    DESCRIPTOR_UNKNOWN: "Unknown descriptor format",
    DESCRIPTOR_FAULTY: "Descriptor data is malformed",
    /* ZipEntry error messages*/
    NO_DATA: "Nothing to decompress",
    BAD_CRC: "CRC32 checksum failed {0}",
    FILE_IN_THE_WAY: "There is a file in the way: {0}",
    UNKNOWN_METHOD: "Invalid/unsupported compression method",
    /* Inflater error messages */
    AVAIL_DATA: "inflate::Available inflate data did not terminate",
    INVALID_DISTANCE: "inflate::Invalid literal/length or distance code in fixed or dynamic block",
    TO_MANY_CODES: "inflate::Dynamic block code description: too many length or distance codes",
    INVALID_REPEAT_LEN: "inflate::Dynamic block code description: repeat more than specified lengths",
    INVALID_REPEAT_FIRST: "inflate::Dynamic block code description: repeat lengths with no first length",
    INCOMPLETE_CODES: "inflate::Dynamic block code description: code lengths codes incomplete",
    INVALID_DYN_DISTANCE: "inflate::Dynamic block code description: invalid distance code lengths",
    INVALID_CODES_LEN: "inflate::Dynamic block code description: invalid literal/length code lengths",
    INVALID_STORE_BLOCK: "inflate::Stored block length did not match one's complement",
    INVALID_BLOCK_TYPE: "inflate::Invalid block type (type == 3)",
    /* ADM-ZIP error messages */
    CANT_EXTRACT_FILE: "Could not extract the file",
    CANT_OVERRIDE: "Target file already exists",
    DISK_ENTRY_TOO_LARGE: "Number of disk entries is too large",
    NO_ZIP: "No zip file was loaded",
    NO_ENTRY: "Entry doesn't exist",
    DIRECTORY_CONTENT_ERROR: "A directory cannot have content",
    FILE_NOT_FOUND: 'File not found: "{0}"',
    NOT_IMPLEMENTED: "Not implemented",
    INVALID_FILENAME: "Invalid filename",
    INVALID_FORMAT: "Invalid or unsupported zip format. No END header found",
    INVALID_PASS_PARAM: "Incompatible password parameter",
    WRONG_PASSWORD: "Wrong Password",
    /* ADM-ZIP */
    COMMENT_TOO_LONG: "Comment is too long",
    // Comment can be max 65535 bytes long (NOTE: some non-US characters may take more space)
    EXTRA_FIELD_PARSE_ERROR: "Extra field parsing error"
  };
  function E(message) {
    return function(...args) {
      if (args.length) {
        message = message.replace(/\{(\d)\}/g, (_, n) => args[n] || "");
      }
      return new Error("ADM-ZIP: " + message);
    };
  }
  for (const msg of Object.keys(errors2)) {
    exports$1[msg] = E(errors2[msg]);
  }
})(errors);
const fsystem = fs$2;
const pth$2 = path$1;
const Constants$3 = constants;
const Errors$1 = errors;
const isWin = typeof process === "object" && "win32" === process.platform;
const is_Obj = (obj) => typeof obj === "object" && obj !== null;
const crcTable = new Uint32Array(256).map((t, c) => {
  for (let k = 0; k < 8; k++) {
    if ((c & 1) !== 0) {
      c = 3988292384 ^ c >>> 1;
    } else {
      c >>>= 1;
    }
  }
  return c >>> 0;
});
function Utils$5(opts) {
  this.sep = pth$2.sep;
  this.fs = fsystem;
  if (is_Obj(opts)) {
    if (is_Obj(opts.fs) && typeof opts.fs.statSync === "function") {
      this.fs = opts.fs;
    }
  }
}
var utils = Utils$5;
Utils$5.prototype.makeDir = function(folder) {
  const self = this;
  function mkdirSync(fpath) {
    let resolvedPath = fpath.split(self.sep)[0];
    fpath.split(self.sep).forEach(function(name) {
      if (!name || name.substr(-1, 1) === ":")
        return;
      resolvedPath += self.sep + name;
      var stat;
      try {
        stat = self.fs.statSync(resolvedPath);
      } catch (e) {
        self.fs.mkdirSync(resolvedPath);
      }
      if (stat && stat.isFile())
        throw Errors$1.FILE_IN_THE_WAY(`"${resolvedPath}"`);
    });
  }
  mkdirSync(folder);
};
Utils$5.prototype.writeFileTo = function(path2, content, overwrite, attr) {
  const self = this;
  if (self.fs.existsSync(path2)) {
    if (!overwrite)
      return false;
    var stat = self.fs.statSync(path2);
    if (stat.isDirectory()) {
      return false;
    }
  }
  var folder = pth$2.dirname(path2);
  if (!self.fs.existsSync(folder)) {
    self.makeDir(folder);
  }
  var fd;
  try {
    fd = self.fs.openSync(path2, "w", 438);
  } catch (e) {
    self.fs.chmodSync(path2, 438);
    fd = self.fs.openSync(path2, "w", 438);
  }
  if (fd) {
    try {
      self.fs.writeSync(fd, content, 0, content.length, 0);
    } finally {
      self.fs.closeSync(fd);
    }
  }
  self.fs.chmodSync(path2, attr || 438);
  return true;
};
Utils$5.prototype.writeFileToAsync = function(path2, content, overwrite, attr, callback) {
  if (typeof attr === "function") {
    callback = attr;
    attr = void 0;
  }
  const self = this;
  self.fs.exists(path2, function(exist) {
    if (exist && !overwrite)
      return callback(false);
    self.fs.stat(path2, function(err, stat) {
      if (exist && stat.isDirectory()) {
        return callback(false);
      }
      var folder = pth$2.dirname(path2);
      self.fs.exists(folder, function(exists) {
        if (!exists)
          self.makeDir(folder);
        self.fs.open(path2, "w", 438, function(err2, fd) {
          if (err2) {
            self.fs.chmod(path2, 438, function() {
              self.fs.open(path2, "w", 438, function(err3, fd2) {
                self.fs.write(fd2, content, 0, content.length, 0, function() {
                  self.fs.close(fd2, function() {
                    self.fs.chmod(path2, attr || 438, function() {
                      callback(true);
                    });
                  });
                });
              });
            });
          } else if (fd) {
            self.fs.write(fd, content, 0, content.length, 0, function() {
              self.fs.close(fd, function() {
                self.fs.chmod(path2, attr || 438, function() {
                  callback(true);
                });
              });
            });
          } else {
            self.fs.chmod(path2, attr || 438, function() {
              callback(true);
            });
          }
        });
      });
    });
  });
};
Utils$5.prototype.findFiles = function(path2) {
  const self = this;
  function findSync(dir, pattern, recursive) {
    let files = [];
    self.fs.readdirSync(dir).forEach(function(file) {
      const path3 = pth$2.join(dir, file);
      const stat = self.fs.statSync(path3);
      {
        files.push(pth$2.normalize(path3) + (stat.isDirectory() ? self.sep : ""));
      }
      if (stat.isDirectory() && recursive)
        files = files.concat(findSync(path3, pattern, recursive));
    });
    return files;
  }
  return findSync(path2, void 0, true);
};
Utils$5.prototype.findFilesAsync = function(dir, cb) {
  const self = this;
  let results = [];
  self.fs.readdir(dir, function(err, list) {
    if (err)
      return cb(err);
    let list_length = list.length;
    if (!list_length)
      return cb(null, results);
    list.forEach(function(file) {
      file = pth$2.join(dir, file);
      self.fs.stat(file, function(err2, stat) {
        if (err2)
          return cb(err2);
        if (stat) {
          results.push(pth$2.normalize(file) + (stat.isDirectory() ? self.sep : ""));
          if (stat.isDirectory()) {
            self.findFilesAsync(file, function(err3, res) {
              if (err3)
                return cb(err3);
              results = results.concat(res);
              if (!--list_length)
                cb(null, results);
            });
          } else {
            if (!--list_length)
              cb(null, results);
          }
        }
      });
    });
  });
};
Utils$5.prototype.getAttributes = function() {
};
Utils$5.prototype.setAttributes = function() {
};
Utils$5.crc32update = function(crc, byte) {
  return crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
};
Utils$5.crc32 = function(buf) {
  if (typeof buf === "string") {
    buf = Buffer.from(buf, "utf8");
  }
  let len = buf.length;
  let crc = -1;
  for (let off = 0; off < len; )
    crc = Utils$5.crc32update(crc, buf[off++]);
  return ~crc >>> 0;
};
Utils$5.methodToString = function(method) {
  switch (method) {
    case Constants$3.STORED:
      return "STORED (" + method + ")";
    case Constants$3.DEFLATED:
      return "DEFLATED (" + method + ")";
    default:
      return "UNSUPPORTED (" + method + ")";
  }
};
Utils$5.canonical = function(path2) {
  if (!path2)
    return "";
  const safeSuffix = pth$2.posix.normalize("/" + path2.split("\\").join("/"));
  return pth$2.join(".", safeSuffix);
};
Utils$5.zipnamefix = function(path2) {
  if (!path2)
    return "";
  const safeSuffix = pth$2.posix.normalize("/" + path2.split("\\").join("/"));
  return pth$2.posix.join(".", safeSuffix);
};
Utils$5.findLast = function(arr, callback) {
  if (!Array.isArray(arr))
    throw new TypeError("arr is not array");
  const len = arr.length >>> 0;
  for (let i = len - 1; i >= 0; i--) {
    if (callback(arr[i], i, arr)) {
      return arr[i];
    }
  }
  return void 0;
};
Utils$5.sanitize = function(prefix, name) {
  prefix = pth$2.resolve(pth$2.normalize(prefix));
  var parts = name.split("/");
  for (var i = 0, l = parts.length; i < l; i++) {
    var path2 = pth$2.normalize(pth$2.join(prefix, parts.slice(i, l).join(pth$2.sep)));
    if (path2.indexOf(prefix) === 0) {
      return path2;
    }
  }
  return pth$2.normalize(pth$2.join(prefix, pth$2.basename(name)));
};
Utils$5.toBuffer = function toBuffer(input, encoder) {
  if (Buffer.isBuffer(input)) {
    return input;
  } else if (input instanceof Uint8Array) {
    return Buffer.from(input);
  } else {
    return typeof input === "string" ? encoder(input) : Buffer.alloc(0);
  }
};
Utils$5.readBigUInt64LE = function(buffer, index) {
  var slice = Buffer.from(buffer.slice(index, index + 8));
  slice.swap64();
  return parseInt(`0x${slice.toString("hex")}`);
};
Utils$5.fromDOS2Date = function(val) {
  return new Date((val >> 25 & 127) + 1980, Math.max((val >> 21 & 15) - 1, 0), Math.max(val >> 16 & 31, 1), val >> 11 & 31, val >> 5 & 63, (val & 31) << 1);
};
Utils$5.fromDate2DOS = function(val) {
  let date = 0;
  let time = 0;
  if (val.getFullYear() > 1979) {
    date = (val.getFullYear() - 1980 & 127) << 9 | val.getMonth() + 1 << 5 | val.getDate();
    time = val.getHours() << 11 | val.getMinutes() << 5 | val.getSeconds() >> 1;
  }
  return date << 16 | time;
};
Utils$5.isWin = isWin;
Utils$5.crcTable = crcTable;
const pth$1 = path$1;
var fattr = function(path2, { fs: fs2 }) {
  var _path = path2 || "", _obj = newAttr(), _stat = null;
  function newAttr() {
    return {
      directory: false,
      readonly: false,
      hidden: false,
      executable: false,
      mtime: 0,
      atime: 0
    };
  }
  if (_path && fs2.existsSync(_path)) {
    _stat = fs2.statSync(_path);
    _obj.directory = _stat.isDirectory();
    _obj.mtime = _stat.mtime;
    _obj.atime = _stat.atime;
    _obj.executable = (73 & _stat.mode) !== 0;
    _obj.readonly = (128 & _stat.mode) === 0;
    _obj.hidden = pth$1.basename(_path)[0] === ".";
  } else {
    console.warn("Invalid path: " + _path);
  }
  return {
    get directory() {
      return _obj.directory;
    },
    get readOnly() {
      return _obj.readonly;
    },
    get hidden() {
      return _obj.hidden;
    },
    get mtime() {
      return _obj.mtime;
    },
    get atime() {
      return _obj.atime;
    },
    get executable() {
      return _obj.executable;
    },
    decodeAttributes: function() {
    },
    encodeAttributes: function() {
    },
    toJSON: function() {
      return {
        path: _path,
        isDirectory: _obj.directory,
        isReadOnly: _obj.readonly,
        isHidden: _obj.hidden,
        isExecutable: _obj.executable,
        mTime: _obj.mtime,
        aTime: _obj.atime
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
var decoder = {
  efs: true,
  encode: (data) => Buffer.from(data, "utf8"),
  decode: (data) => data.toString("utf8")
};
util.exports = utils;
util.exports.Constants = constants;
util.exports.Errors = errors;
util.exports.FileAttr = fattr;
util.exports.decoder = decoder;
var utilExports = util.exports;
var headers = {};
var Utils$4 = utilExports, Constants$2 = Utils$4.Constants;
var entryHeader = function() {
  var _verMade = 20, _version = 10, _flags = 0, _method = 0, _time = 0, _crc = 0, _compressedSize = 0, _size = 0, _fnameLen = 0, _extraLen = 0, _comLen = 0, _diskStart = 0, _inattr = 0, _attr = 0, _offset = 0;
  _verMade |= Utils$4.isWin ? 2560 : 768;
  _flags |= Constants$2.FLG_EFS;
  const _localHeader = {
    extraLen: 0
  };
  const uint32 = (val) => Math.max(0, val) >>> 0;
  const uint8 = (val) => Math.max(0, val) & 255;
  _time = Utils$4.fromDate2DOS(/* @__PURE__ */ new Date());
  return {
    get made() {
      return _verMade;
    },
    set made(val) {
      _verMade = val;
    },
    get version() {
      return _version;
    },
    set version(val) {
      _version = val;
    },
    get flags() {
      return _flags;
    },
    set flags(val) {
      _flags = val;
    },
    get flags_efs() {
      return (_flags & Constants$2.FLG_EFS) > 0;
    },
    set flags_efs(val) {
      if (val) {
        _flags |= Constants$2.FLG_EFS;
      } else {
        _flags &= ~Constants$2.FLG_EFS;
      }
    },
    get flags_desc() {
      return (_flags & Constants$2.FLG_DESC) > 0;
    },
    set flags_desc(val) {
      if (val) {
        _flags |= Constants$2.FLG_DESC;
      } else {
        _flags &= ~Constants$2.FLG_DESC;
      }
    },
    get method() {
      return _method;
    },
    set method(val) {
      switch (val) {
        case Constants$2.STORED:
          this.version = 10;
        case Constants$2.DEFLATED:
        default:
          this.version = 20;
      }
      _method = val;
    },
    get time() {
      return Utils$4.fromDOS2Date(this.timeval);
    },
    set time(val) {
      this.timeval = Utils$4.fromDate2DOS(val);
    },
    get timeval() {
      return _time;
    },
    set timeval(val) {
      _time = uint32(val);
    },
    get timeHighByte() {
      return uint8(_time >>> 8);
    },
    get crc() {
      return _crc;
    },
    set crc(val) {
      _crc = uint32(val);
    },
    get compressedSize() {
      return _compressedSize;
    },
    set compressedSize(val) {
      _compressedSize = uint32(val);
    },
    get size() {
      return _size;
    },
    set size(val) {
      _size = uint32(val);
    },
    get fileNameLength() {
      return _fnameLen;
    },
    set fileNameLength(val) {
      _fnameLen = val;
    },
    get extraLength() {
      return _extraLen;
    },
    set extraLength(val) {
      _extraLen = val;
    },
    get extraLocalLength() {
      return _localHeader.extraLen;
    },
    set extraLocalLength(val) {
      _localHeader.extraLen = val;
    },
    get commentLength() {
      return _comLen;
    },
    set commentLength(val) {
      _comLen = val;
    },
    get diskNumStart() {
      return _diskStart;
    },
    set diskNumStart(val) {
      _diskStart = uint32(val);
    },
    get inAttr() {
      return _inattr;
    },
    set inAttr(val) {
      _inattr = uint32(val);
    },
    get attr() {
      return _attr;
    },
    set attr(val) {
      _attr = uint32(val);
    },
    // get Unix file permissions
    get fileAttr() {
      return (_attr || 0) >> 16 & 4095;
    },
    get offset() {
      return _offset;
    },
    set offset(val) {
      _offset = uint32(val);
    },
    get encrypted() {
      return (_flags & Constants$2.FLG_ENC) === Constants$2.FLG_ENC;
    },
    get centralHeaderSize() {
      return Constants$2.CENHDR + _fnameLen + _extraLen + _comLen;
    },
    get realDataOffset() {
      return _offset + Constants$2.LOCHDR + _localHeader.fnameLen + _localHeader.extraLen;
    },
    get localHeader() {
      return _localHeader;
    },
    loadLocalHeaderFromBinary: function(input) {
      var data = input.slice(_offset, _offset + Constants$2.LOCHDR);
      if (data.readUInt32LE(0) !== Constants$2.LOCSIG) {
        throw Utils$4.Errors.INVALID_LOC();
      }
      _localHeader.version = data.readUInt16LE(Constants$2.LOCVER);
      _localHeader.flags = data.readUInt16LE(Constants$2.LOCFLG);
      _localHeader.method = data.readUInt16LE(Constants$2.LOCHOW);
      _localHeader.time = data.readUInt32LE(Constants$2.LOCTIM);
      _localHeader.crc = data.readUInt32LE(Constants$2.LOCCRC);
      _localHeader.compressedSize = data.readUInt32LE(Constants$2.LOCSIZ);
      _localHeader.size = data.readUInt32LE(Constants$2.LOCLEN);
      _localHeader.fnameLen = data.readUInt16LE(Constants$2.LOCNAM);
      _localHeader.extraLen = data.readUInt16LE(Constants$2.LOCEXT);
      const extraStart = _offset + Constants$2.LOCHDR + _localHeader.fnameLen;
      const extraEnd = extraStart + _localHeader.extraLen;
      return input.slice(extraStart, extraEnd);
    },
    loadFromBinary: function(data) {
      if (data.length !== Constants$2.CENHDR || data.readUInt32LE(0) !== Constants$2.CENSIG) {
        throw Utils$4.Errors.INVALID_CEN();
      }
      _verMade = data.readUInt16LE(Constants$2.CENVEM);
      _version = data.readUInt16LE(Constants$2.CENVER);
      _flags = data.readUInt16LE(Constants$2.CENFLG);
      _method = data.readUInt16LE(Constants$2.CENHOW);
      _time = data.readUInt32LE(Constants$2.CENTIM);
      _crc = data.readUInt32LE(Constants$2.CENCRC);
      _compressedSize = data.readUInt32LE(Constants$2.CENSIZ);
      _size = data.readUInt32LE(Constants$2.CENLEN);
      _fnameLen = data.readUInt16LE(Constants$2.CENNAM);
      _extraLen = data.readUInt16LE(Constants$2.CENEXT);
      _comLen = data.readUInt16LE(Constants$2.CENCOM);
      _diskStart = data.readUInt16LE(Constants$2.CENDSK);
      _inattr = data.readUInt16LE(Constants$2.CENATT);
      _attr = data.readUInt32LE(Constants$2.CENATX);
      _offset = data.readUInt32LE(Constants$2.CENOFF);
    },
    localHeaderToBinary: function() {
      var data = Buffer.alloc(Constants$2.LOCHDR);
      data.writeUInt32LE(Constants$2.LOCSIG, 0);
      data.writeUInt16LE(_version, Constants$2.LOCVER);
      data.writeUInt16LE(_flags, Constants$2.LOCFLG);
      data.writeUInt16LE(_method, Constants$2.LOCHOW);
      data.writeUInt32LE(_time, Constants$2.LOCTIM);
      data.writeUInt32LE(_crc, Constants$2.LOCCRC);
      data.writeUInt32LE(_compressedSize, Constants$2.LOCSIZ);
      data.writeUInt32LE(_size, Constants$2.LOCLEN);
      data.writeUInt16LE(_fnameLen, Constants$2.LOCNAM);
      data.writeUInt16LE(_localHeader.extraLen, Constants$2.LOCEXT);
      return data;
    },
    centralHeaderToBinary: function() {
      var data = Buffer.alloc(Constants$2.CENHDR + _fnameLen + _extraLen + _comLen);
      data.writeUInt32LE(Constants$2.CENSIG, 0);
      data.writeUInt16LE(_verMade, Constants$2.CENVEM);
      data.writeUInt16LE(_version, Constants$2.CENVER);
      data.writeUInt16LE(_flags, Constants$2.CENFLG);
      data.writeUInt16LE(_method, Constants$2.CENHOW);
      data.writeUInt32LE(_time, Constants$2.CENTIM);
      data.writeUInt32LE(_crc, Constants$2.CENCRC);
      data.writeUInt32LE(_compressedSize, Constants$2.CENSIZ);
      data.writeUInt32LE(_size, Constants$2.CENLEN);
      data.writeUInt16LE(_fnameLen, Constants$2.CENNAM);
      data.writeUInt16LE(_extraLen, Constants$2.CENEXT);
      data.writeUInt16LE(_comLen, Constants$2.CENCOM);
      data.writeUInt16LE(_diskStart, Constants$2.CENDSK);
      data.writeUInt16LE(_inattr, Constants$2.CENATT);
      data.writeUInt32LE(_attr, Constants$2.CENATX);
      data.writeUInt32LE(_offset, Constants$2.CENOFF);
      return data;
    },
    toJSON: function() {
      const bytes = function(nr) {
        return nr + " bytes";
      };
      return {
        made: _verMade,
        version: _version,
        flags: _flags,
        method: Utils$4.methodToString(_method),
        time: this.time,
        crc: "0x" + _crc.toString(16).toUpperCase(),
        compressedSize: bytes(_compressedSize),
        size: bytes(_size),
        fileNameLength: bytes(_fnameLen),
        extraLength: bytes(_extraLen),
        commentLength: bytes(_comLen),
        diskNumStart: _diskStart,
        inAttr: _inattr,
        attr: _attr,
        offset: _offset,
        centralHeaderSize: bytes(Constants$2.CENHDR + _fnameLen + _extraLen + _comLen)
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
var Utils$3 = utilExports, Constants$1 = Utils$3.Constants;
var mainHeader = function() {
  var _volumeEntries = 0, _totalEntries = 0, _size = 0, _offset = 0, _commentLength = 0;
  return {
    get diskEntries() {
      return _volumeEntries;
    },
    set diskEntries(val) {
      _volumeEntries = _totalEntries = val;
    },
    get totalEntries() {
      return _totalEntries;
    },
    set totalEntries(val) {
      _totalEntries = _volumeEntries = val;
    },
    get size() {
      return _size;
    },
    set size(val) {
      _size = val;
    },
    get offset() {
      return _offset;
    },
    set offset(val) {
      _offset = val;
    },
    get commentLength() {
      return _commentLength;
    },
    set commentLength(val) {
      _commentLength = val;
    },
    get mainHeaderSize() {
      return Constants$1.ENDHDR + _commentLength;
    },
    loadFromBinary: function(data) {
      if ((data.length !== Constants$1.ENDHDR || data.readUInt32LE(0) !== Constants$1.ENDSIG) && (data.length < Constants$1.ZIP64HDR || data.readUInt32LE(0) !== Constants$1.ZIP64SIG)) {
        throw Utils$3.Errors.INVALID_END();
      }
      if (data.readUInt32LE(0) === Constants$1.ENDSIG) {
        _volumeEntries = data.readUInt16LE(Constants$1.ENDSUB);
        _totalEntries = data.readUInt16LE(Constants$1.ENDTOT);
        _size = data.readUInt32LE(Constants$1.ENDSIZ);
        _offset = data.readUInt32LE(Constants$1.ENDOFF);
        _commentLength = data.readUInt16LE(Constants$1.ENDCOM);
      } else {
        _volumeEntries = Utils$3.readBigUInt64LE(data, Constants$1.ZIP64SUB);
        _totalEntries = Utils$3.readBigUInt64LE(data, Constants$1.ZIP64TOT);
        _size = Utils$3.readBigUInt64LE(data, Constants$1.ZIP64SIZE);
        _offset = Utils$3.readBigUInt64LE(data, Constants$1.ZIP64OFF);
        _commentLength = 0;
      }
    },
    toBinary: function() {
      var b = Buffer.alloc(Constants$1.ENDHDR + _commentLength);
      b.writeUInt32LE(Constants$1.ENDSIG, 0);
      b.writeUInt32LE(0, 4);
      b.writeUInt16LE(_volumeEntries, Constants$1.ENDSUB);
      b.writeUInt16LE(_totalEntries, Constants$1.ENDTOT);
      b.writeUInt32LE(_size, Constants$1.ENDSIZ);
      b.writeUInt32LE(_offset, Constants$1.ENDOFF);
      b.writeUInt16LE(_commentLength, Constants$1.ENDCOM);
      b.fill(" ", Constants$1.ENDHDR);
      return b;
    },
    toJSON: function() {
      const offset = function(nr, len) {
        let offs = nr.toString(16).toUpperCase();
        while (offs.length < len)
          offs = "0" + offs;
        return "0x" + offs;
      };
      return {
        diskEntries: _volumeEntries,
        totalEntries: _totalEntries,
        size: _size + " bytes",
        offset: offset(_offset, 4),
        commentLength: _commentLength
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
headers.EntryHeader = entryHeader;
headers.MainHeader = mainHeader;
var methods = {};
var deflater = function(inbuf) {
  var zlib = require$$0;
  var opts = { chunkSize: (parseInt(inbuf.length / 1024) + 1) * 1024 };
  return {
    deflate: function() {
      return zlib.deflateRawSync(inbuf, opts);
    },
    deflateAsync: function(callback) {
      var tmp = zlib.createDeflateRaw(opts), parts = [], total = 0;
      tmp.on("data", function(data) {
        parts.push(data);
        total += data.length;
      });
      tmp.on("end", function() {
        var buf = Buffer.alloc(total), written = 0;
        buf.fill(0);
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          part.copy(buf, written);
          written += part.length;
        }
        callback && callback(buf);
      });
      tmp.end(inbuf);
    }
  };
};
const version = +(process.versions ? process.versions.node : "").split(".")[0] || 0;
var inflater = function(inbuf, expectedLength) {
  var zlib = require$$0;
  const option = version >= 15 && expectedLength > 0 ? { maxOutputLength: expectedLength } : {};
  return {
    inflate: function() {
      return zlib.inflateRawSync(inbuf, option);
    },
    inflateAsync: function(callback) {
      var tmp = zlib.createInflateRaw(option), parts = [], total = 0;
      tmp.on("data", function(data) {
        parts.push(data);
        total += data.length;
      });
      tmp.on("end", function() {
        var buf = Buffer.alloc(total), written = 0;
        buf.fill(0);
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          part.copy(buf, written);
          written += part.length;
        }
        callback && callback(buf);
      });
      tmp.end(inbuf);
    }
  };
};
const { randomFillSync } = crypto;
const Errors = errors;
const crctable = new Uint32Array(256).map((t, crc) => {
  for (let j = 0; j < 8; j++) {
    if (0 !== (crc & 1)) {
      crc = crc >>> 1 ^ 3988292384;
    } else {
      crc >>>= 1;
    }
  }
  return crc >>> 0;
});
const uMul = (a, b) => Math.imul(a, b) >>> 0;
const crc32update = (pCrc32, bval) => {
  return crctable[(pCrc32 ^ bval) & 255] ^ pCrc32 >>> 8;
};
const genSalt = () => {
  if ("function" === typeof randomFillSync) {
    return randomFillSync(Buffer.alloc(12));
  } else {
    return genSalt.node();
  }
};
genSalt.node = () => {
  const salt = Buffer.alloc(12);
  const len = salt.length;
  for (let i = 0; i < len; i++)
    salt[i] = Math.random() * 256 & 255;
  return salt;
};
const config = {
  genSalt
};
function Initkeys(pw) {
  const pass = Buffer.isBuffer(pw) ? pw : Buffer.from(pw);
  this.keys = new Uint32Array([305419896, 591751049, 878082192]);
  for (let i = 0; i < pass.length; i++) {
    this.updateKeys(pass[i]);
  }
}
Initkeys.prototype.updateKeys = function(byteValue) {
  const keys = this.keys;
  keys[0] = crc32update(keys[0], byteValue);
  keys[1] += keys[0] & 255;
  keys[1] = uMul(keys[1], 134775813) + 1;
  keys[2] = crc32update(keys[2], keys[1] >>> 24);
  return byteValue;
};
Initkeys.prototype.next = function() {
  const k = (this.keys[2] | 2) >>> 0;
  return uMul(k, k ^ 1) >> 8 & 255;
};
function make_decrypter(pwd) {
  const keys = new Initkeys(pwd);
  return function(data) {
    const result = Buffer.alloc(data.length);
    let pos = 0;
    for (let c of data) {
      result[pos++] = keys.updateKeys(c ^ keys.next());
    }
    return result;
  };
}
function make_encrypter(pwd) {
  const keys = new Initkeys(pwd);
  return function(data, result, pos = 0) {
    if (!result)
      result = Buffer.alloc(data.length);
    for (let c of data) {
      const k = keys.next();
      result[pos++] = c ^ k;
      keys.updateKeys(c);
    }
    return result;
  };
}
function decrypt(data, header, pwd) {
  if (!data || !Buffer.isBuffer(data) || data.length < 12) {
    return Buffer.alloc(0);
  }
  const decrypter = make_decrypter(pwd);
  const salt = decrypter(data.slice(0, 12));
  const verifyByte = (header.flags & 8) === 8 ? header.timeHighByte : header.crc >>> 24;
  if (salt[11] !== verifyByte) {
    throw Errors.WRONG_PASSWORD();
  }
  return decrypter(data.slice(12));
}
function _salter(data) {
  if (Buffer.isBuffer(data) && data.length >= 12) {
    config.genSalt = function() {
      return data.slice(0, 12);
    };
  } else if (data === "node") {
    config.genSalt = genSalt.node;
  } else {
    config.genSalt = genSalt;
  }
}
function encrypt(data, header, pwd, oldlike = false) {
  if (data == null)
    data = Buffer.alloc(0);
  if (!Buffer.isBuffer(data))
    data = Buffer.from(data.toString());
  const encrypter = make_encrypter(pwd);
  const salt = config.genSalt();
  salt[11] = header.crc >>> 24 & 255;
  if (oldlike)
    salt[10] = header.crc >>> 16 & 255;
  const result = Buffer.alloc(data.length + 12);
  encrypter(salt, result);
  return encrypter(data, result, 12);
}
var zipcrypto = { decrypt, encrypt, _salter };
methods.Deflater = deflater;
methods.Inflater = inflater;
methods.ZipCrypto = zipcrypto;
var Utils$2 = utilExports, Headers$1 = headers, Constants = Utils$2.Constants, Methods = methods;
var zipEntry = function(options, input) {
  var _centralHeader = new Headers$1.EntryHeader(), _entryName = Buffer.alloc(0), _comment = Buffer.alloc(0), _isDirectory = false, uncompressedData = null, _extra = Buffer.alloc(0), _extralocal = Buffer.alloc(0), _efs = true;
  const opts = options;
  const decoder2 = typeof opts.decoder === "object" ? opts.decoder : Utils$2.decoder;
  _efs = decoder2.hasOwnProperty("efs") ? decoder2.efs : false;
  function getCompressedDataFromZip() {
    if (!input || !(input instanceof Uint8Array)) {
      return Buffer.alloc(0);
    }
    _extralocal = _centralHeader.loadLocalHeaderFromBinary(input);
    return input.slice(_centralHeader.realDataOffset, _centralHeader.realDataOffset + _centralHeader.compressedSize);
  }
  function crc32OK(data) {
    if (!_centralHeader.flags_desc) {
      if (Utils$2.crc32(data) !== _centralHeader.localHeader.crc) {
        return false;
      }
    } else {
      const descriptor = {};
      const dataEndOffset = _centralHeader.realDataOffset + _centralHeader.compressedSize;
      if (input.readUInt32LE(dataEndOffset) == Constants.LOCSIG || input.readUInt32LE(dataEndOffset) == Constants.CENSIG) {
        throw Utils$2.Errors.DESCRIPTOR_NOT_EXIST();
      }
      if (input.readUInt32LE(dataEndOffset) == Constants.EXTSIG) {
        descriptor.crc = input.readUInt32LE(dataEndOffset + Constants.EXTCRC);
        descriptor.compressedSize = input.readUInt32LE(dataEndOffset + Constants.EXTSIZ);
        descriptor.size = input.readUInt32LE(dataEndOffset + Constants.EXTLEN);
      } else if (input.readUInt16LE(dataEndOffset + 12) === 19280) {
        descriptor.crc = input.readUInt32LE(dataEndOffset + Constants.EXTCRC - 4);
        descriptor.compressedSize = input.readUInt32LE(dataEndOffset + Constants.EXTSIZ - 4);
        descriptor.size = input.readUInt32LE(dataEndOffset + Constants.EXTLEN - 4);
      } else {
        throw Utils$2.Errors.DESCRIPTOR_UNKNOWN();
      }
      if (descriptor.compressedSize !== _centralHeader.compressedSize || descriptor.size !== _centralHeader.size || descriptor.crc !== _centralHeader.crc) {
        throw Utils$2.Errors.DESCRIPTOR_FAULTY();
      }
      if (Utils$2.crc32(data) !== descriptor.crc) {
        return false;
      }
    }
    return true;
  }
  function decompress(async, callback, pass) {
    if (typeof callback === "undefined" && typeof async === "string") {
      pass = async;
      async = void 0;
    }
    if (_isDirectory) {
      if (async && callback) {
        callback(Buffer.alloc(0), Utils$2.Errors.DIRECTORY_CONTENT_ERROR());
      }
      return Buffer.alloc(0);
    }
    var compressedData = getCompressedDataFromZip();
    if (compressedData.length === 0) {
      if (async && callback)
        callback(compressedData);
      return compressedData;
    }
    if (_centralHeader.encrypted) {
      if ("string" !== typeof pass && !Buffer.isBuffer(pass)) {
        throw Utils$2.Errors.INVALID_PASS_PARAM();
      }
      compressedData = Methods.ZipCrypto.decrypt(compressedData, _centralHeader, pass);
    }
    var data = Buffer.alloc(_centralHeader.size);
    switch (_centralHeader.method) {
      case Utils$2.Constants.STORED:
        compressedData.copy(data);
        if (!crc32OK(data)) {
          if (async && callback)
            callback(data, Utils$2.Errors.BAD_CRC());
          throw Utils$2.Errors.BAD_CRC();
        } else {
          if (async && callback)
            callback(data);
          return data;
        }
      case Utils$2.Constants.DEFLATED:
        var inflater2 = new Methods.Inflater(compressedData, _centralHeader.size);
        if (!async) {
          const result = inflater2.inflate(data);
          result.copy(data, 0);
          if (!crc32OK(data)) {
            throw Utils$2.Errors.BAD_CRC(`"${decoder2.decode(_entryName)}"`);
          }
          return data;
        } else {
          inflater2.inflateAsync(function(result) {
            result.copy(result, 0);
            if (callback) {
              if (!crc32OK(result)) {
                callback(result, Utils$2.Errors.BAD_CRC());
              } else {
                callback(result);
              }
            }
          });
        }
        break;
      default:
        if (async && callback)
          callback(Buffer.alloc(0), Utils$2.Errors.UNKNOWN_METHOD());
        throw Utils$2.Errors.UNKNOWN_METHOD();
    }
  }
  function compress(async, callback) {
    if ((!uncompressedData || !uncompressedData.length) && Buffer.isBuffer(input)) {
      if (async && callback)
        callback(getCompressedDataFromZip());
      return getCompressedDataFromZip();
    }
    if (uncompressedData.length && !_isDirectory) {
      var compressedData;
      switch (_centralHeader.method) {
        case Utils$2.Constants.STORED:
          _centralHeader.compressedSize = _centralHeader.size;
          compressedData = Buffer.alloc(uncompressedData.length);
          uncompressedData.copy(compressedData);
          if (async && callback)
            callback(compressedData);
          return compressedData;
        default:
        case Utils$2.Constants.DEFLATED:
          var deflater2 = new Methods.Deflater(uncompressedData);
          if (!async) {
            var deflated = deflater2.deflate();
            _centralHeader.compressedSize = deflated.length;
            return deflated;
          } else {
            deflater2.deflateAsync(function(data) {
              compressedData = Buffer.alloc(data.length);
              _centralHeader.compressedSize = data.length;
              data.copy(compressedData);
              callback && callback(compressedData);
            });
          }
          deflater2 = null;
          break;
      }
    } else if (async && callback) {
      callback(Buffer.alloc(0));
    } else {
      return Buffer.alloc(0);
    }
  }
  function readUInt64LE(buffer, offset) {
    return (buffer.readUInt32LE(offset + 4) << 4) + buffer.readUInt32LE(offset);
  }
  function parseExtra(data) {
    try {
      var offset = 0;
      var signature, size, part;
      while (offset + 4 < data.length) {
        signature = data.readUInt16LE(offset);
        offset += 2;
        size = data.readUInt16LE(offset);
        offset += 2;
        part = data.slice(offset, offset + size);
        offset += size;
        if (Constants.ID_ZIP64 === signature) {
          parseZip64ExtendedInformation(part);
        }
      }
    } catch (error) {
      throw Utils$2.Errors.EXTRA_FIELD_PARSE_ERROR();
    }
  }
  function parseZip64ExtendedInformation(data) {
    var size, compressedSize, offset, diskNumStart;
    if (data.length >= Constants.EF_ZIP64_SCOMP) {
      size = readUInt64LE(data, Constants.EF_ZIP64_SUNCOMP);
      if (_centralHeader.size === Constants.EF_ZIP64_OR_32) {
        _centralHeader.size = size;
      }
    }
    if (data.length >= Constants.EF_ZIP64_RHO) {
      compressedSize = readUInt64LE(data, Constants.EF_ZIP64_SCOMP);
      if (_centralHeader.compressedSize === Constants.EF_ZIP64_OR_32) {
        _centralHeader.compressedSize = compressedSize;
      }
    }
    if (data.length >= Constants.EF_ZIP64_DSN) {
      offset = readUInt64LE(data, Constants.EF_ZIP64_RHO);
      if (_centralHeader.offset === Constants.EF_ZIP64_OR_32) {
        _centralHeader.offset = offset;
      }
    }
    if (data.length >= Constants.EF_ZIP64_DSN + 4) {
      diskNumStart = data.readUInt32LE(Constants.EF_ZIP64_DSN);
      if (_centralHeader.diskNumStart === Constants.EF_ZIP64_OR_16) {
        _centralHeader.diskNumStart = diskNumStart;
      }
    }
  }
  return {
    get entryName() {
      return decoder2.decode(_entryName);
    },
    get rawEntryName() {
      return _entryName;
    },
    set entryName(val) {
      _entryName = Utils$2.toBuffer(val, decoder2.encode);
      var lastChar = _entryName[_entryName.length - 1];
      _isDirectory = lastChar === 47 || lastChar === 92;
      _centralHeader.fileNameLength = _entryName.length;
    },
    get efs() {
      if (typeof _efs === "function") {
        return _efs(this.entryName);
      } else {
        return _efs;
      }
    },
    get extra() {
      return _extra;
    },
    set extra(val) {
      _extra = val;
      _centralHeader.extraLength = val.length;
      parseExtra(val);
    },
    get comment() {
      return decoder2.decode(_comment);
    },
    set comment(val) {
      _comment = Utils$2.toBuffer(val, decoder2.encode);
      _centralHeader.commentLength = _comment.length;
      if (_comment.length > 65535)
        throw Utils$2.Errors.COMMENT_TOO_LONG();
    },
    get name() {
      var n = decoder2.decode(_entryName);
      return _isDirectory ? n.substr(n.length - 1).split("/").pop() : n.split("/").pop();
    },
    get isDirectory() {
      return _isDirectory;
    },
    getCompressedData: function() {
      return compress(false, null);
    },
    getCompressedDataAsync: function(callback) {
      compress(true, callback);
    },
    setData: function(value) {
      uncompressedData = Utils$2.toBuffer(value, Utils$2.decoder.encode);
      if (!_isDirectory && uncompressedData.length) {
        _centralHeader.size = uncompressedData.length;
        _centralHeader.method = Utils$2.Constants.DEFLATED;
        _centralHeader.crc = Utils$2.crc32(value);
        _centralHeader.changed = true;
      } else {
        _centralHeader.method = Utils$2.Constants.STORED;
      }
    },
    getData: function(pass) {
      if (_centralHeader.changed) {
        return uncompressedData;
      } else {
        return decompress(false, null, pass);
      }
    },
    getDataAsync: function(callback, pass) {
      if (_centralHeader.changed) {
        callback(uncompressedData);
      } else {
        decompress(true, callback, pass);
      }
    },
    set attr(attr) {
      _centralHeader.attr = attr;
    },
    get attr() {
      return _centralHeader.attr;
    },
    set header(data) {
      _centralHeader.loadFromBinary(data);
    },
    get header() {
      return _centralHeader;
    },
    packCentralHeader: function() {
      _centralHeader.flags_efs = this.efs;
      _centralHeader.extraLength = _extra.length;
      var header = _centralHeader.centralHeaderToBinary();
      var addpos = Utils$2.Constants.CENHDR;
      _entryName.copy(header, addpos);
      addpos += _entryName.length;
      _extra.copy(header, addpos);
      addpos += _centralHeader.extraLength;
      _comment.copy(header, addpos);
      return header;
    },
    packLocalHeader: function() {
      let addpos = 0;
      _centralHeader.flags_efs = this.efs;
      _centralHeader.extraLocalLength = _extralocal.length;
      const localHeaderBuf = _centralHeader.localHeaderToBinary();
      const localHeader = Buffer.alloc(localHeaderBuf.length + _entryName.length + _centralHeader.extraLocalLength);
      localHeaderBuf.copy(localHeader, addpos);
      addpos += localHeaderBuf.length;
      _entryName.copy(localHeader, addpos);
      addpos += _entryName.length;
      _extralocal.copy(localHeader, addpos);
      addpos += _extralocal.length;
      return localHeader;
    },
    toJSON: function() {
      const bytes = function(nr) {
        return "<" + (nr && nr.length + " bytes buffer" || "null") + ">";
      };
      return {
        entryName: this.entryName,
        name: this.name,
        comment: this.comment,
        isDirectory: this.isDirectory,
        header: _centralHeader.toJSON(),
        compressedData: bytes(input),
        data: bytes(uncompressedData)
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
const ZipEntry$1 = zipEntry;
const Headers = headers;
const Utils$1 = utilExports;
var zipFile = function(inBuffer, options) {
  var entryList = [], entryTable = {}, _comment = Buffer.alloc(0), mainHeader2 = new Headers.MainHeader(), loadedEntries = false;
  const temporary = /* @__PURE__ */ new Set();
  const opts = options;
  const { noSort, decoder: decoder2 } = opts;
  if (inBuffer) {
    readMainHeader(opts.readEntries);
  } else {
    loadedEntries = true;
  }
  function makeTemporaryFolders() {
    const foldersList = /* @__PURE__ */ new Set();
    for (const elem of Object.keys(entryTable)) {
      const elements = elem.split("/");
      elements.pop();
      if (!elements.length)
        continue;
      for (let i = 0; i < elements.length; i++) {
        const sub = elements.slice(0, i + 1).join("/") + "/";
        foldersList.add(sub);
      }
    }
    for (const elem of foldersList) {
      if (!(elem in entryTable)) {
        const tempfolder = new ZipEntry$1(opts);
        tempfolder.entryName = elem;
        tempfolder.attr = 16;
        tempfolder.temporary = true;
        entryList.push(tempfolder);
        entryTable[tempfolder.entryName] = tempfolder;
        temporary.add(tempfolder);
      }
    }
  }
  function readEntries() {
    loadedEntries = true;
    entryTable = {};
    if (mainHeader2.diskEntries > (inBuffer.length - mainHeader2.offset) / Utils$1.Constants.CENHDR) {
      throw Utils$1.Errors.DISK_ENTRY_TOO_LARGE();
    }
    entryList = new Array(mainHeader2.diskEntries);
    var index = mainHeader2.offset;
    for (var i = 0; i < entryList.length; i++) {
      var tmp = index, entry = new ZipEntry$1(opts, inBuffer);
      entry.header = inBuffer.slice(tmp, tmp += Utils$1.Constants.CENHDR);
      entry.entryName = inBuffer.slice(tmp, tmp += entry.header.fileNameLength);
      if (entry.header.extraLength) {
        entry.extra = inBuffer.slice(tmp, tmp += entry.header.extraLength);
      }
      if (entry.header.commentLength)
        entry.comment = inBuffer.slice(tmp, tmp + entry.header.commentLength);
      index += entry.header.centralHeaderSize;
      entryList[i] = entry;
      entryTable[entry.entryName] = entry;
    }
    temporary.clear();
    makeTemporaryFolders();
  }
  function readMainHeader(readNow) {
    var i = inBuffer.length - Utils$1.Constants.ENDHDR, max = Math.max(0, i - 65535), n = max, endStart = inBuffer.length, endOffset = -1, commentEnd = 0;
    const trailingSpace = typeof opts.trailingSpace === "boolean" ? opts.trailingSpace : false;
    if (trailingSpace)
      max = 0;
    for (i; i >= n; i--) {
      if (inBuffer[i] !== 80)
        continue;
      if (inBuffer.readUInt32LE(i) === Utils$1.Constants.ENDSIG) {
        endOffset = i;
        commentEnd = i;
        endStart = i + Utils$1.Constants.ENDHDR;
        n = i - Utils$1.Constants.END64HDR;
        continue;
      }
      if (inBuffer.readUInt32LE(i) === Utils$1.Constants.END64SIG) {
        n = max;
        continue;
      }
      if (inBuffer.readUInt32LE(i) === Utils$1.Constants.ZIP64SIG) {
        endOffset = i;
        endStart = i + Utils$1.readBigUInt64LE(inBuffer, i + Utils$1.Constants.ZIP64SIZE) + Utils$1.Constants.ZIP64LEAD;
        break;
      }
    }
    if (endOffset == -1)
      throw Utils$1.Errors.INVALID_FORMAT();
    mainHeader2.loadFromBinary(inBuffer.slice(endOffset, endStart));
    if (mainHeader2.commentLength) {
      _comment = inBuffer.slice(commentEnd + Utils$1.Constants.ENDHDR);
    }
    if (readNow)
      readEntries();
  }
  function sortEntries() {
    if (entryList.length > 1 && !noSort) {
      entryList.sort((a, b) => a.entryName.toLowerCase().localeCompare(b.entryName.toLowerCase()));
    }
  }
  return {
    /**
     * Returns an array of ZipEntry objects existent in the current opened archive
     * @return Array
     */
    get entries() {
      if (!loadedEntries) {
        readEntries();
      }
      return entryList.filter((e) => !temporary.has(e));
    },
    /**
     * Archive comment
     * @return {String}
     */
    get comment() {
      return decoder2.decode(_comment);
    },
    set comment(val) {
      _comment = Utils$1.toBuffer(val, decoder2.encode);
      mainHeader2.commentLength = _comment.length;
    },
    getEntryCount: function() {
      if (!loadedEntries) {
        return mainHeader2.diskEntries;
      }
      return entryList.length;
    },
    forEach: function(callback) {
      this.entries.forEach(callback);
    },
    /**
     * Returns a reference to the entry with the given name or null if entry is inexistent
     *
     * @param entryName
     * @return ZipEntry
     */
    getEntry: function(entryName) {
      if (!loadedEntries) {
        readEntries();
      }
      return entryTable[entryName] || null;
    },
    /**
     * Adds the given entry to the entry list
     *
     * @param entry
     */
    setEntry: function(entry) {
      if (!loadedEntries) {
        readEntries();
      }
      entryList.push(entry);
      entryTable[entry.entryName] = entry;
      mainHeader2.totalEntries = entryList.length;
    },
    /**
     * Removes the file with the given name from the entry list.
     *
     * If the entry is a directory, then all nested files and directories will be removed
     * @param entryName
     * @returns {void}
     */
    deleteFile: function(entryName, withsubfolders = true) {
      if (!loadedEntries) {
        readEntries();
      }
      const entry = entryTable[entryName];
      const list = this.getEntryChildren(entry, withsubfolders).map((child) => child.entryName);
      list.forEach(this.deleteEntry);
    },
    /**
     * Removes the entry with the given name from the entry list.
     *
     * @param {string} entryName
     * @returns {void}
     */
    deleteEntry: function(entryName) {
      if (!loadedEntries) {
        readEntries();
      }
      const entry = entryTable[entryName];
      const index = entryList.indexOf(entry);
      if (index >= 0) {
        entryList.splice(index, 1);
        delete entryTable[entryName];
        mainHeader2.totalEntries = entryList.length;
      }
    },
    /**
     *  Iterates and returns all nested files and directories of the given entry
     *
     * @param entry
     * @return Array
     */
    getEntryChildren: function(entry, subfolders = true) {
      if (!loadedEntries) {
        readEntries();
      }
      if (typeof entry === "object") {
        if (entry.isDirectory && subfolders) {
          const list = [];
          const name = entry.entryName;
          for (const zipEntry2 of entryList) {
            if (zipEntry2.entryName.startsWith(name)) {
              list.push(zipEntry2);
            }
          }
          return list;
        } else {
          return [entry];
        }
      }
      return [];
    },
    /**
     *  How many child elements entry has
     *
     * @param {ZipEntry} entry
     * @return {integer}
     */
    getChildCount: function(entry) {
      if (entry && entry.isDirectory) {
        const list = this.getEntryChildren(entry);
        return list.includes(entry) ? list.length - 1 : list.length;
      }
      return 0;
    },
    /**
     * Returns the zip file
     *
     * @return Buffer
     */
    compressToBuffer: function() {
      if (!loadedEntries) {
        readEntries();
      }
      sortEntries();
      const dataBlock = [];
      const headerBlocks = [];
      let totalSize = 0;
      let dindex = 0;
      mainHeader2.size = 0;
      mainHeader2.offset = 0;
      let totalEntries = 0;
      for (const entry of this.entries) {
        const compressedData = entry.getCompressedData();
        entry.header.offset = dindex;
        const localHeader = entry.packLocalHeader();
        const dataLength = localHeader.length + compressedData.length;
        dindex += dataLength;
        dataBlock.push(localHeader);
        dataBlock.push(compressedData);
        const centralHeader = entry.packCentralHeader();
        headerBlocks.push(centralHeader);
        mainHeader2.size += centralHeader.length;
        totalSize += dataLength + centralHeader.length;
        totalEntries++;
      }
      totalSize += mainHeader2.mainHeaderSize;
      mainHeader2.offset = dindex;
      mainHeader2.totalEntries = totalEntries;
      dindex = 0;
      const outBuffer = Buffer.alloc(totalSize);
      for (const content of dataBlock) {
        content.copy(outBuffer, dindex);
        dindex += content.length;
      }
      for (const content of headerBlocks) {
        content.copy(outBuffer, dindex);
        dindex += content.length;
      }
      const mh = mainHeader2.toBinary();
      if (_comment) {
        _comment.copy(mh, Utils$1.Constants.ENDHDR);
      }
      mh.copy(outBuffer, dindex);
      inBuffer = outBuffer;
      loadedEntries = false;
      return outBuffer;
    },
    toAsyncBuffer: function(onSuccess, onFail, onItemStart, onItemEnd) {
      try {
        if (!loadedEntries) {
          readEntries();
        }
        sortEntries();
        const dataBlock = [];
        const centralHeaders = [];
        let totalSize = 0;
        let dindex = 0;
        let totalEntries = 0;
        mainHeader2.size = 0;
        mainHeader2.offset = 0;
        const compress2Buffer = function(entryLists) {
          if (entryLists.length > 0) {
            const entry = entryLists.shift();
            const name = entry.entryName + entry.extra.toString();
            if (onItemStart)
              onItemStart(name);
            entry.getCompressedDataAsync(function(compressedData) {
              if (onItemEnd)
                onItemEnd(name);
              entry.header.offset = dindex;
              const localHeader = entry.packLocalHeader();
              const dataLength = localHeader.length + compressedData.length;
              dindex += dataLength;
              dataBlock.push(localHeader);
              dataBlock.push(compressedData);
              const centalHeader = entry.packCentralHeader();
              centralHeaders.push(centalHeader);
              mainHeader2.size += centalHeader.length;
              totalSize += dataLength + centalHeader.length;
              totalEntries++;
              compress2Buffer(entryLists);
            });
          } else {
            totalSize += mainHeader2.mainHeaderSize;
            mainHeader2.offset = dindex;
            mainHeader2.totalEntries = totalEntries;
            dindex = 0;
            const outBuffer = Buffer.alloc(totalSize);
            dataBlock.forEach(function(content) {
              content.copy(outBuffer, dindex);
              dindex += content.length;
            });
            centralHeaders.forEach(function(content) {
              content.copy(outBuffer, dindex);
              dindex += content.length;
            });
            const mh = mainHeader2.toBinary();
            if (_comment) {
              _comment.copy(mh, Utils$1.Constants.ENDHDR);
            }
            mh.copy(outBuffer, dindex);
            inBuffer = outBuffer;
            loadedEntries = false;
            onSuccess(outBuffer);
          }
        };
        compress2Buffer(Array.from(this.entries));
      } catch (e) {
        onFail(e);
      }
    }
  };
};
const Utils = utilExports;
const pth = path$1;
const ZipEntry = zipEntry;
const ZipFile = zipFile;
const get_Bool = (...val) => Utils.findLast(val, (c) => typeof c === "boolean");
const get_Str = (...val) => Utils.findLast(val, (c) => typeof c === "string");
const get_Fun = (...val) => Utils.findLast(val, (c) => typeof c === "function");
const defaultOptions = {
  // option "noSort" : if true it disables files sorting
  noSort: false,
  // read entries during load (initial loading may be slower)
  readEntries: false,
  // default method is none
  method: Utils.Constants.NONE,
  // file system
  fs: null
};
var admZip = function(input, options) {
  let inBuffer = null;
  const opts = Object.assign(/* @__PURE__ */ Object.create(null), defaultOptions);
  if (input && "object" === typeof input) {
    if (!(input instanceof Uint8Array)) {
      Object.assign(opts, input);
      input = opts.input ? opts.input : void 0;
      if (opts.input)
        delete opts.input;
    }
    if (Buffer.isBuffer(input)) {
      inBuffer = input;
      opts.method = Utils.Constants.BUFFER;
      input = void 0;
    }
  }
  Object.assign(opts, options);
  const filetools = new Utils(opts);
  if (typeof opts.decoder !== "object" || typeof opts.decoder.encode !== "function" || typeof opts.decoder.decode !== "function") {
    opts.decoder = Utils.decoder;
  }
  if (input && "string" === typeof input) {
    if (filetools.fs.existsSync(input)) {
      opts.method = Utils.Constants.FILE;
      opts.filename = input;
      inBuffer = filetools.fs.readFileSync(input);
    } else {
      throw Utils.Errors.INVALID_FILENAME();
    }
  }
  const _zip = new ZipFile(inBuffer, opts);
  const { canonical, sanitize, zipnamefix } = Utils;
  function getEntry(entry) {
    if (entry && _zip) {
      var item;
      if (typeof entry === "string")
        item = _zip.getEntry(pth.posix.normalize(entry));
      if (typeof entry === "object" && typeof entry.entryName !== "undefined" && typeof entry.header !== "undefined")
        item = _zip.getEntry(entry.entryName);
      if (item) {
        return item;
      }
    }
    return null;
  }
  function fixPath(zipPath) {
    const { join, normalize, sep } = pth.posix;
    return join(".", normalize(sep + zipPath.split("\\").join(sep) + sep));
  }
  function filenameFilter(filterfn) {
    if (filterfn instanceof RegExp) {
      return /* @__PURE__ */ function(rx) {
        return function(filename) {
          return rx.test(filename);
        };
      }(filterfn);
    } else if ("function" !== typeof filterfn) {
      return () => true;
    }
    return filterfn;
  }
  const relativePath = (local, entry) => {
    let lastChar = entry.slice(-1);
    lastChar = lastChar === filetools.sep ? filetools.sep : "";
    return pth.relative(local, entry) + lastChar;
  };
  return {
    /**
     * Extracts the given entry from the archive and returns the content as a Buffer object
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {Buffer|string} [pass] - password
     * @return Buffer or Null in case of error
     */
    readFile: function(entry, pass) {
      var item = getEntry(entry);
      return item && item.getData(pass) || null;
    },
    /**
     * Returns how many child elements has on entry (directories) on files it is always 0
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @returns {integer}
     */
    childCount: function(entry) {
      const item = getEntry(entry);
      if (item) {
        return _zip.getChildCount(item);
      }
    },
    /**
     * Asynchronous readFile
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {callback} callback
     *
     * @return Buffer or Null in case of error
     */
    readFileAsync: function(entry, callback) {
      var item = getEntry(entry);
      if (item) {
        item.getDataAsync(callback);
      } else {
        callback(null, "getEntry failed for:" + entry);
      }
    },
    /**
     * Extracts the given entry from the archive and returns the content as plain text in the given encoding
     * @param {ZipEntry|string} entry - ZipEntry object or String with the full path of the entry
     * @param {string} encoding - Optional. If no encoding is specified utf8 is used
     *
     * @return String
     */
    readAsText: function(entry, encoding) {
      var item = getEntry(entry);
      if (item) {
        var data = item.getData();
        if (data && data.length) {
          return data.toString(encoding || "utf8");
        }
      }
      return "";
    },
    /**
     * Asynchronous readAsText
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {callback} callback
     * @param {string} [encoding] - Optional. If no encoding is specified utf8 is used
     *
     * @return String
     */
    readAsTextAsync: function(entry, callback, encoding) {
      var item = getEntry(entry);
      if (item) {
        item.getDataAsync(function(data, err) {
          if (err) {
            callback(data, err);
            return;
          }
          if (data && data.length) {
            callback(data.toString(encoding || "utf8"));
          } else {
            callback("");
          }
        });
      } else {
        callback("");
      }
    },
    /**
     * Remove the entry from the file or the entry and all it's nested directories and files if the given entry is a directory
     *
     * @param {ZipEntry|string} entry
     * @returns {void}
     */
    deleteFile: function(entry, withsubfolders = true) {
      var item = getEntry(entry);
      if (item) {
        _zip.deleteFile(item.entryName, withsubfolders);
      }
    },
    /**
     * Remove the entry from the file or directory without affecting any nested entries
     *
     * @param {ZipEntry|string} entry
     * @returns {void}
     */
    deleteEntry: function(entry) {
      var item = getEntry(entry);
      if (item) {
        _zip.deleteEntry(item.entryName);
      }
    },
    /**
     * Adds a comment to the zip. The zip must be rewritten after adding the comment.
     *
     * @param {string} comment
     */
    addZipComment: function(comment) {
      _zip.comment = comment;
    },
    /**
     * Returns the zip comment
     *
     * @return String
     */
    getZipComment: function() {
      return _zip.comment || "";
    },
    /**
     * Adds a comment to a specified zipEntry. The zip must be rewritten after adding the comment
     * The comment cannot exceed 65535 characters in length
     *
     * @param {ZipEntry} entry
     * @param {string} comment
     */
    addZipEntryComment: function(entry, comment) {
      var item = getEntry(entry);
      if (item) {
        item.comment = comment;
      }
    },
    /**
     * Returns the comment of the specified entry
     *
     * @param {ZipEntry} entry
     * @return String
     */
    getZipEntryComment: function(entry) {
      var item = getEntry(entry);
      if (item) {
        return item.comment || "";
      }
      return "";
    },
    /**
     * Updates the content of an existing entry inside the archive. The zip must be rewritten after updating the content
     *
     * @param {ZipEntry} entry
     * @param {Buffer} content
     */
    updateFile: function(entry, content) {
      var item = getEntry(entry);
      if (item) {
        item.setData(content);
      }
    },
    /**
     * Adds a file from the disk to the archive
     *
     * @param {string} localPath File to add to zip
     * @param {string} [zipPath] Optional path inside the zip
     * @param {string} [zipName] Optional name for the file
     * @param {string} [comment] Optional file comment
     */
    addLocalFile: function(localPath2, zipPath, zipName, comment) {
      if (filetools.fs.existsSync(localPath2)) {
        zipPath = zipPath ? fixPath(zipPath) : "";
        const p = pth.win32.basename(pth.win32.normalize(localPath2));
        zipPath += zipName ? zipName : p;
        const _attr = filetools.fs.statSync(localPath2);
        const data = _attr.isFile() ? filetools.fs.readFileSync(localPath2) : Buffer.alloc(0);
        if (_attr.isDirectory())
          zipPath += filetools.sep;
        this.addFile(zipPath, data, comment, _attr);
      } else {
        throw Utils.Errors.FILE_NOT_FOUND(localPath2);
      }
    },
    /**
     * Callback for showing if everything was done.
     *
     * @callback doneCallback
     * @param {Error} err - Error object
     * @param {boolean} done - was request fully completed
     */
    /**
     * Adds a file from the disk to the archive
     *
     * @param {(object|string)} options - options object, if it is string it us used as localPath.
     * @param {string} options.localPath - Local path to the file.
     * @param {string} [options.comment] - Optional file comment.
     * @param {string} [options.zipPath] - Optional path inside the zip
     * @param {string} [options.zipName] - Optional name for the file
     * @param {doneCallback} callback - The callback that handles the response.
     */
    addLocalFileAsync: function(options2, callback) {
      options2 = typeof options2 === "object" ? options2 : { localPath: options2 };
      const localPath2 = pth.resolve(options2.localPath);
      const { comment } = options2;
      let { zipPath, zipName } = options2;
      const self = this;
      filetools.fs.stat(localPath2, function(err, stats) {
        if (err)
          return callback(err, false);
        zipPath = zipPath ? fixPath(zipPath) : "";
        const p = pth.win32.basename(pth.win32.normalize(localPath2));
        zipPath += zipName ? zipName : p;
        if (stats.isFile()) {
          filetools.fs.readFile(localPath2, function(err2, data) {
            if (err2)
              return callback(err2, false);
            self.addFile(zipPath, data, comment, stats);
            return setImmediate(callback, void 0, true);
          });
        } else if (stats.isDirectory()) {
          zipPath += filetools.sep;
          self.addFile(zipPath, Buffer.alloc(0), comment, stats);
          return setImmediate(callback, void 0, true);
        }
      });
    },
    /**
     * Adds a local directory and all its nested files and directories to the archive
     *
     * @param {string} localPath - local path to the folder
     * @param {string} [zipPath] - optional path inside zip
     * @param {(RegExp|function)} [filter] - optional RegExp or Function if files match will be included.
     */
    addLocalFolder: function(localPath2, zipPath, filter) {
      filter = filenameFilter(filter);
      zipPath = zipPath ? fixPath(zipPath) : "";
      localPath2 = pth.normalize(localPath2);
      if (filetools.fs.existsSync(localPath2)) {
        const items = filetools.findFiles(localPath2);
        const self = this;
        if (items.length) {
          for (const filepath of items) {
            const p = pth.join(zipPath, relativePath(localPath2, filepath));
            if (filter(p)) {
              self.addLocalFile(filepath, pth.dirname(p));
            }
          }
        }
      } else {
        throw Utils.Errors.FILE_NOT_FOUND(localPath2);
      }
    },
    /**
     * Asynchronous addLocalFolder
     * @param {string} localPath
     * @param {callback} callback
     * @param {string} [zipPath] optional path inside zip
     * @param {RegExp|function} [filter] optional RegExp or Function if files match will
     *               be included.
     */
    addLocalFolderAsync: function(localPath2, callback, zipPath, filter) {
      filter = filenameFilter(filter);
      zipPath = zipPath ? fixPath(zipPath) : "";
      localPath2 = pth.normalize(localPath2);
      var self = this;
      filetools.fs.open(localPath2, "r", function(err) {
        if (err && err.code === "ENOENT") {
          callback(void 0, Utils.Errors.FILE_NOT_FOUND(localPath2));
        } else if (err) {
          callback(void 0, err);
        } else {
          var items = filetools.findFiles(localPath2);
          var i = -1;
          var next = function() {
            i += 1;
            if (i < items.length) {
              var filepath = items[i];
              var p = relativePath(localPath2, filepath).split("\\").join("/");
              p = p.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
              if (filter(p)) {
                filetools.fs.stat(filepath, function(er0, stats) {
                  if (er0)
                    callback(void 0, er0);
                  if (stats.isFile()) {
                    filetools.fs.readFile(filepath, function(er1, data) {
                      if (er1) {
                        callback(void 0, er1);
                      } else {
                        self.addFile(zipPath + p, data, "", stats);
                        next();
                      }
                    });
                  } else {
                    self.addFile(zipPath + p + "/", Buffer.alloc(0), "", stats);
                    next();
                  }
                });
              } else {
                process.nextTick(() => {
                  next();
                });
              }
            } else {
              callback(true, void 0);
            }
          };
          next();
        }
      });
    },
    /**
     * Adds a local directory and all its nested files and directories to the archive
     *
     * @param {object | string} options - options object, if it is string it us used as localPath.
     * @param {string} options.localPath - Local path to the folder.
     * @param {string} [options.zipPath] - optional path inside zip.
     * @param {RegExp|function} [options.filter] - optional RegExp or Function if files match will be included.
     * @param {function|string} [options.namefix] - optional function to help fix filename
     * @param {doneCallback} callback - The callback that handles the response.
     *
     */
    addLocalFolderAsync2: function(options2, callback) {
      const self = this;
      options2 = typeof options2 === "object" ? options2 : { localPath: options2 };
      localPath = pth.resolve(fixPath(options2.localPath));
      let { zipPath, filter, namefix } = options2;
      if (filter instanceof RegExp) {
        filter = /* @__PURE__ */ function(rx) {
          return function(filename) {
            return rx.test(filename);
          };
        }(filter);
      } else if ("function" !== typeof filter) {
        filter = function() {
          return true;
        };
      }
      zipPath = zipPath ? fixPath(zipPath) : "";
      if (namefix == "latin1") {
        namefix = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
      }
      if (typeof namefix !== "function")
        namefix = (str) => str;
      const relPathFix = (entry) => pth.join(zipPath, namefix(relativePath(localPath, entry)));
      const fileNameFix = (entry) => pth.win32.basename(pth.win32.normalize(namefix(entry)));
      filetools.fs.open(localPath, "r", function(err) {
        if (err && err.code === "ENOENT") {
          callback(void 0, Utils.Errors.FILE_NOT_FOUND(localPath));
        } else if (err) {
          callback(void 0, err);
        } else {
          filetools.findFilesAsync(localPath, function(err2, fileEntries) {
            if (err2)
              return callback(err2);
            fileEntries = fileEntries.filter((dir) => filter(relPathFix(dir)));
            if (!fileEntries.length)
              callback(void 0, false);
            setImmediate(
              fileEntries.reverse().reduce(function(next, entry) {
                return function(err3, done) {
                  if (err3 || done === false)
                    return setImmediate(next, err3, false);
                  self.addLocalFileAsync(
                    {
                      localPath: entry,
                      zipPath: pth.dirname(relPathFix(entry)),
                      zipName: fileNameFix(entry)
                    },
                    next
                  );
                };
              }, callback)
            );
          });
        }
      });
    },
    /**
     * Adds a local directory and all its nested files and directories to the archive
     *
     * @param {string} localPath - path where files will be extracted
     * @param {object} props - optional properties
     * @param {string} [props.zipPath] - optional path inside zip
     * @param {RegExp|function} [props.filter] - optional RegExp or Function if files match will be included.
     * @param {function|string} [props.namefix] - optional function to help fix filename
     */
    addLocalFolderPromise: function(localPath2, props) {
      return new Promise((resolve, reject) => {
        this.addLocalFolderAsync2(Object.assign({ localPath: localPath2 }, props), (err, done) => {
          if (err)
            reject(err);
          if (done)
            resolve(this);
        });
      });
    },
    /**
     * Allows you to create a entry (file or directory) in the zip file.
     * If you want to create a directory the entryName must end in / and a null buffer should be provided.
     * Comment and attributes are optional
     *
     * @param {string} entryName
     * @param {Buffer | string} content - file content as buffer or utf8 coded string
     * @param {string} [comment] - file comment
     * @param {number | object} [attr] - number as unix file permissions, object as filesystem Stats object
     */
    addFile: function(entryName, content, comment, attr) {
      entryName = zipnamefix(entryName);
      let entry = getEntry(entryName);
      const update = entry != null;
      if (!update) {
        entry = new ZipEntry(opts);
        entry.entryName = entryName;
      }
      entry.comment = comment || "";
      const isStat = "object" === typeof attr && attr instanceof filetools.fs.Stats;
      if (isStat) {
        entry.header.time = attr.mtime;
      }
      var fileattr = entry.isDirectory ? 16 : 0;
      let unix = entry.isDirectory ? 16384 : 32768;
      if (isStat) {
        unix |= 4095 & attr.mode;
      } else if ("number" === typeof attr) {
        unix |= 4095 & attr;
      } else {
        unix |= entry.isDirectory ? 493 : 420;
      }
      fileattr = (fileattr | unix << 16) >>> 0;
      entry.attr = fileattr;
      entry.setData(content);
      if (!update)
        _zip.setEntry(entry);
      return entry;
    },
    /**
     * Returns an array of ZipEntry objects representing the files and folders inside the archive
     *
     * @param {string} [password]
     * @returns Array
     */
    getEntries: function(password) {
      _zip.password = password;
      return _zip ? _zip.entries : [];
    },
    /**
     * Returns a ZipEntry object representing the file or folder specified by ``name``.
     *
     * @param {string} name
     * @return ZipEntry
     */
    getEntry: function(name) {
      return getEntry(name);
    },
    getEntryCount: function() {
      return _zip.getEntryCount();
    },
    forEach: function(callback) {
      return _zip.forEach(callback);
    },
    /**
     * Extracts the given entry to the given targetPath
     * If the entry is a directory inside the archive, the entire directory and it's subdirectories will be extracted
     *
     * @param {string|ZipEntry} entry - ZipEntry object or String with the full path of the entry
     * @param {string} targetPath - Target folder where to write the file
     * @param {boolean} [maintainEntryPath=true] - If maintainEntryPath is true and the entry is inside a folder, the entry folder will be created in targetPath as well. Default is TRUE
     * @param {boolean} [overwrite=false] - If the file already exists at the target path, the file will be overwriten if this is true.
     * @param {boolean} [keepOriginalPermission=false] - The file will be set as the permission from the entry if this is true.
     * @param {string} [outFileName] - String If set will override the filename of the extracted file (Only works if the entry is a file)
     *
     * @return Boolean
     */
    extractEntryTo: function(entry, targetPath, maintainEntryPath, overwrite, keepOriginalPermission, outFileName) {
      overwrite = get_Bool(false, overwrite);
      keepOriginalPermission = get_Bool(false, keepOriginalPermission);
      maintainEntryPath = get_Bool(true, maintainEntryPath);
      outFileName = get_Str(keepOriginalPermission, outFileName);
      var item = getEntry(entry);
      if (!item) {
        throw Utils.Errors.NO_ENTRY();
      }
      var entryName = canonical(item.entryName);
      var target = sanitize(targetPath, outFileName && !item.isDirectory ? outFileName : maintainEntryPath ? entryName : pth.basename(entryName));
      if (item.isDirectory) {
        var children = _zip.getEntryChildren(item);
        children.forEach(function(child) {
          if (child.isDirectory)
            return;
          var content2 = child.getData();
          if (!content2) {
            throw Utils.Errors.CANT_EXTRACT_FILE();
          }
          var name = canonical(child.entryName);
          var childName = sanitize(targetPath, maintainEntryPath ? name : pth.basename(name));
          const fileAttr2 = keepOriginalPermission ? child.header.fileAttr : void 0;
          filetools.writeFileTo(childName, content2, overwrite, fileAttr2);
        });
        return true;
      }
      var content = item.getData(_zip.password);
      if (!content)
        throw Utils.Errors.CANT_EXTRACT_FILE();
      if (filetools.fs.existsSync(target) && !overwrite) {
        throw Utils.Errors.CANT_OVERRIDE();
      }
      const fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
      filetools.writeFileTo(target, content, overwrite, fileAttr);
      return true;
    },
    /**
     * Test the archive
     * @param {string} [pass]
     */
    test: function(pass) {
      if (!_zip) {
        return false;
      }
      for (var entry in _zip.entries) {
        try {
          if (entry.isDirectory) {
            continue;
          }
          var content = _zip.entries[entry].getData(pass);
          if (!content) {
            return false;
          }
        } catch (err) {
          return false;
        }
      }
      return true;
    },
    /**
     * Extracts the entire archive to the given location
     *
     * @param {string} targetPath Target location
     * @param {boolean} [overwrite=false] If the file already exists at the target path, the file will be overwriten if this is true.
     *                  Default is FALSE
     * @param {boolean} [keepOriginalPermission=false] The file will be set as the permission from the entry if this is true.
     *                  Default is FALSE
     * @param {string|Buffer} [pass] password
     */
    extractAllTo: function(targetPath, overwrite, keepOriginalPermission, pass) {
      keepOriginalPermission = get_Bool(false, keepOriginalPermission);
      pass = get_Str(keepOriginalPermission, pass);
      overwrite = get_Bool(false, overwrite);
      if (!_zip)
        throw Utils.Errors.NO_ZIP();
      _zip.entries.forEach(function(entry) {
        var entryName = sanitize(targetPath, canonical(entry.entryName));
        if (entry.isDirectory) {
          filetools.makeDir(entryName);
          return;
        }
        var content = entry.getData(pass);
        if (!content) {
          throw Utils.Errors.CANT_EXTRACT_FILE();
        }
        const fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
        filetools.writeFileTo(entryName, content, overwrite, fileAttr);
        try {
          filetools.fs.utimesSync(entryName, entry.header.time, entry.header.time);
        } catch (err) {
          throw Utils.Errors.CANT_EXTRACT_FILE();
        }
      });
    },
    /**
     * Asynchronous extractAllTo
     *
     * @param {string} targetPath Target location
     * @param {boolean} [overwrite=false] If the file already exists at the target path, the file will be overwriten if this is true.
     *                  Default is FALSE
     * @param {boolean} [keepOriginalPermission=false] The file will be set as the permission from the entry if this is true.
     *                  Default is FALSE
     * @param {function} callback The callback will be executed when all entries are extracted successfully or any error is thrown.
     */
    extractAllToAsync: function(targetPath, overwrite, keepOriginalPermission, callback) {
      callback = get_Fun(overwrite, keepOriginalPermission, callback);
      keepOriginalPermission = get_Bool(false, keepOriginalPermission);
      overwrite = get_Bool(false, overwrite);
      if (!callback) {
        return new Promise((resolve, reject) => {
          this.extractAllToAsync(targetPath, overwrite, keepOriginalPermission, function(err) {
            if (err) {
              reject(err);
            } else {
              resolve(this);
            }
          });
        });
      }
      if (!_zip) {
        callback(Utils.Errors.NO_ZIP());
        return;
      }
      targetPath = pth.resolve(targetPath);
      const getPath = (entry) => sanitize(targetPath, pth.normalize(canonical(entry.entryName)));
      const getError = (msg, file) => new Error(msg + ': "' + file + '"');
      const dirEntries = [];
      const fileEntries = [];
      _zip.entries.forEach((e) => {
        if (e.isDirectory) {
          dirEntries.push(e);
        } else {
          fileEntries.push(e);
        }
      });
      for (const entry of dirEntries) {
        const dirPath = getPath(entry);
        const dirAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
        try {
          filetools.makeDir(dirPath);
          if (dirAttr)
            filetools.fs.chmodSync(dirPath, dirAttr);
          filetools.fs.utimesSync(dirPath, entry.header.time, entry.header.time);
        } catch (er) {
          callback(getError("Unable to create folder", dirPath));
        }
      }
      fileEntries.reverse().reduce(function(next, entry) {
        return function(err) {
          if (err) {
            next(err);
          } else {
            const entryName = pth.normalize(canonical(entry.entryName));
            const filePath = sanitize(targetPath, entryName);
            entry.getDataAsync(function(content, err_1) {
              if (err_1) {
                next(err_1);
              } else if (!content) {
                next(Utils.Errors.CANT_EXTRACT_FILE());
              } else {
                const fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
                filetools.writeFileToAsync(filePath, content, overwrite, fileAttr, function(succ) {
                  if (!succ) {
                    next(getError("Unable to write file", filePath));
                  }
                  filetools.fs.utimes(filePath, entry.header.time, entry.header.time, function(err_2) {
                    if (err_2) {
                      next(getError("Unable to set times", filePath));
                    } else {
                      next();
                    }
                  });
                });
              }
            });
          }
        };
      }, callback)();
    },
    /**
     * Writes the newly created zip file to disk at the specified location or if a zip was opened and no ``targetFileName`` is provided, it will overwrite the opened zip
     *
     * @param {string} targetFileName
     * @param {function} callback
     */
    writeZip: function(targetFileName, callback) {
      if (arguments.length === 1) {
        if (typeof targetFileName === "function") {
          callback = targetFileName;
          targetFileName = "";
        }
      }
      if (!targetFileName && opts.filename) {
        targetFileName = opts.filename;
      }
      if (!targetFileName)
        return;
      var zipData = _zip.compressToBuffer();
      if (zipData) {
        var ok = filetools.writeFileTo(targetFileName, zipData, true);
        if (typeof callback === "function")
          callback(!ok ? new Error("failed") : null, "");
      }
    },
    /**
             *
             * @param {string} targetFileName
             * @param {object} [props]
             * @param {boolean} [props.overwrite=true] If the file already exists at the target path, the file will be overwriten if this is true.
             * @param {boolean} [props.perm] The file will be set as the permission from the entry if this is true.
    
             * @returns {Promise<void>}
             */
    writeZipPromise: function(targetFileName, props) {
      const { overwrite, perm } = Object.assign({ overwrite: true }, props);
      return new Promise((resolve, reject) => {
        if (!targetFileName && opts.filename)
          targetFileName = opts.filename;
        if (!targetFileName)
          reject("ADM-ZIP: ZIP File Name Missing");
        this.toBufferPromise().then((zipData) => {
          const ret = (done) => done ? resolve(done) : reject("ADM-ZIP: Wasn't able to write zip file");
          filetools.writeFileToAsync(targetFileName, zipData, overwrite, perm, ret);
        }, reject);
      });
    },
    /**
     * @returns {Promise<Buffer>} A promise to the Buffer.
     */
    toBufferPromise: function() {
      return new Promise((resolve, reject) => {
        _zip.toAsyncBuffer(resolve, reject);
      });
    },
    /**
     * Returns the content of the entire zip file as a Buffer object
     *
     * @prop {function} [onSuccess]
     * @prop {function} [onFail]
     * @prop {function} [onItemStart]
     * @prop {function} [onItemEnd]
     * @returns {Buffer}
     */
    toBuffer: function(onSuccess, onFail, onItemStart, onItemEnd) {
      if (typeof onSuccess === "function") {
        _zip.toAsyncBuffer(onSuccess, onFail, onItemStart, onItemEnd);
        return null;
      }
      return _zip.compressToBuffer();
    }
  };
};
const AdmZip = /* @__PURE__ */ getDefaultExportFromCjs(admZip);
class BackupService {
  getBackupDir() {
    return path$1.join(app.getPath("userData"), "backups");
  }
  getAutoBackupDir() {
    return path$1.join(this.getBackupDir(), "auto");
  }
  ensureBackupDirs() {
    const backupDir = this.getBackupDir();
    const autoBackupDir = this.getAutoBackupDir();
    if (!fs$2.existsSync(backupDir))
      fs$2.mkdirSync(backupDir, { recursive: true });
    if (!fs$2.existsSync(autoBackupDir))
      fs$2.mkdirSync(autoBackupDir, { recursive: true });
  }
  // --- Encryption Helpers ---
  deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 1e5, 32, "sha256");
  }
  encryptData(data, password) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = this.deriveKey(password, salt);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      encryptedData: encrypted,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex")
    };
  }
  decryptData(encryptedData, password, encryption) {
    const salt = Buffer.from(encryption.salt, "hex");
    const iv = Buffer.from(encryption.iv, "hex");
    const authTag = Buffer.from(encryption.authTag, "hex");
    const key = this.deriveKey(password, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  }
  // --- Core Logic ---
  // 1. Export Data
  async exportData(targetPath, password) {
    const [novels, volumes, chapters, characters, ideas, tags] = await Promise.all([
      db.novel.findMany(),
      db.volume.findMany(),
      db.chapter.findMany(),
      db.character.findMany(),
      db.idea.findMany(),
      db.tag.findMany()
    ]);
    const fullData = { novels, volumes, chapters, characters, ideas, tags };
    const dataBuffer = Buffer.from(JSON.stringify(fullData));
    const zip = new AdmZip();
    const manifest = {
      version: 1,
      appVersion: app.getVersion(),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      platform: process.platform,
      encrypted: !!password
    };
    if (password) {
      const { encryptedData, salt, iv, authTag } = this.encryptData(dataBuffer, password);
      manifest.encryption = { algo: "aes-256-gcm", salt, iv, authTag };
      zip.addFile("data.bin", encryptedData);
    } else {
      zip.addFile("data.json", dataBuffer);
    }
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
    if (!targetPath) {
      const { filePath } = await dialog.showSaveDialog({
        title: "Export Backup",
        defaultPath: `NovelData_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")}.nebak`,
        filters: [{ name: "Novel Editor Backup", extensions: ["nebak"] }]
      });
      if (!filePath)
        throw new Error("Export cancelled");
      targetPath = filePath;
    }
    zip.writeZip(targetPath);
    return targetPath;
  }
  // 2. Import Data (Restore)
  async importData(filePath, password) {
    const zip = new AdmZip(filePath);
    const manifestEntry = zip.getEntry("manifest.json");
    if (!manifestEntry)
      throw new Error("Invalid backup file: manifest.json missing");
    const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    let dataJson;
    if (manifest.encrypted) {
      if (!password)
        throw new Error("PASSWORD_REQUIRED");
      const dataEntry = zip.getEntry("data.bin");
      if (!dataEntry)
        throw new Error("Invalid backup file: data.bin missing");
      if (!manifest.encryption)
        throw new Error("Invalid backup file: encryption metadata missing");
      try {
        const decrypted = this.decryptData(dataEntry.getData(), password, manifest.encryption);
        dataJson = JSON.parse(decrypted.toString("utf8"));
      } catch (e) {
        throw new Error("PASSWORD_INVALID");
      }
    } else {
      const dataEntry = zip.getEntry("data.json");
      if (!dataEntry)
        throw new Error("Invalid backup file: data.json missing");
      dataJson = JSON.parse(dataEntry.getData().toString("utf8"));
    }
    await this.performRestore(dataJson);
  }
  // Helper: Perform Restore (Transactional)
  async performRestore(data) {
    await this.createAutoBackup();
    await db.$transaction(async (tx) => {
      var _a, _b, _c, _d, _e, _f;
      await tx.tag.deleteMany();
      await tx.idea.deleteMany();
      await tx.character.deleteMany();
      await tx.chapter.deleteMany();
      await tx.volume.deleteMany();
      await tx.novel.deleteMany();
      if ((_a = data.novels) == null ? void 0 : _a.length)
        for (const item of data.novels)
          await tx.novel.create({ data: item });
      if ((_b = data.volumes) == null ? void 0 : _b.length)
        for (const item of data.volumes)
          await tx.volume.create({ data: item });
      if ((_c = data.chapters) == null ? void 0 : _c.length)
        for (const item of data.chapters)
          await tx.chapter.create({ data: item });
      if ((_d = data.characters) == null ? void 0 : _d.length)
        for (const item of data.characters)
          await tx.character.create({ data: item });
      if ((_e = data.ideas) == null ? void 0 : _e.length)
        for (const item of data.ideas)
          await tx.idea.create({ data: item });
      if ((_f = data.tags) == null ? void 0 : _f.length)
        for (const item of data.tags)
          await tx.tag.create({ data: item });
    }, {
      maxWait: 1e4,
      timeout: 2e4
    });
  }
  // 3. Auto Backup Logic
  async createAutoBackup() {
    try {
      this.ensureBackupDirs();
      const timestamp = Date.now();
      const filename = `auto_backup_${timestamp}.nebak`;
      const filePath = path$1.join(this.getAutoBackupDir(), filename);
      await this.exportData(filePath);
      console.log("[BackupService] Auto-backup created:", filename);
      await this.rotateAutoBackups();
    } catch (e) {
      console.error("[BackupService] Failed to create auto-backup:", e);
    }
  }
  async rotateAutoBackups() {
    this.ensureBackupDirs();
    const autoBackupDir = this.getAutoBackupDir();
    const files = fs$2.readdirSync(autoBackupDir).filter((f) => f.endsWith(".nebak")).map((f) => ({
      name: f,
      time: fs$2.statSync(path$1.join(autoBackupDir, f)).mtime.getTime()
    })).sort((a, b) => b.time - a.time);
    const toDelete = files.slice(3);
    for (const file of toDelete) {
      fs$2.unlinkSync(path$1.join(autoBackupDir, file.name));
      console.log("[BackupService] Rotated auto-backup:", file.name);
    }
  }
  // 4. List Auto Backups
  async getAutoBackups() {
    this.ensureBackupDirs();
    const autoBackupDir = this.getAutoBackupDir();
    return fs$2.readdirSync(autoBackupDir).filter((f) => f.endsWith(".nebak")).map((f) => {
      const stats = fs$2.statSync(path$1.join(autoBackupDir, f));
      return {
        filename: f,
        createdAt: stats.mtime.getTime(),
        size: stats.size
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }
  // 5. Restore from Auto Backup
  async restoreAutoBackup(filename) {
    this.ensureBackupDirs();
    const filePath = path$1.join(this.getAutoBackupDir(), filename);
    if (!fs$2.existsSync(filePath))
      throw new Error("Backup file not found");
    await this.importData(filePath);
  }
}
const backupService = new BackupService();
const __dirname$1 = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname$1, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
process.on("uncaughtException", (error) => {
  devLogError("Main.uncaughtException", error);
  console.error("[Main] Uncaught Exception:", error);
  app.quit();
  process.exit(1);
});
process.on("unhandledRejection", (reason, promise) => {
  devLogError("Main.unhandledRejection", reason, { promise: String(promise) });
  console.error("[Main] Unhandled Rejection at:", promise, "reason:", reason);
  app.quit();
  process.exit(1);
});
let win;
let consolePatched = false;
const PACKAGED_APP_NAME = "云梦小说编辑器";
const DEV_APP_NAME = "Novel Editor Dev";
function resolveWindowsAppUserModelId() {
  if (app.isPackaged && process.platform === "win32") {
    return process.execPath;
  }
  return "com.noveleditor.app";
}
function isPortableMode() {
  return app.isPackaged && typeof process.env.PORTABLE_EXECUTABLE_DIR === "string" && process.env.PORTABLE_EXECUTABLE_DIR.length > 0;
}
function getLegacyPackagedDataDir() {
  return path.join(path.dirname(app.getPath("exe")), "data");
}
function getPortableDataDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (!portableDir) {
    return getLegacyPackagedDataDir();
  }
  return path.join(portableDir, "data");
}
function copyDirectoryContentsIfMissing(sourceDir, targetDir) {
  if (!fs$2.existsSync(sourceDir))
    return;
  if (!fs$2.existsSync(targetDir)) {
    fs$2.mkdirSync(targetDir, { recursive: true });
  }
  const entries = fs$2.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (fs$2.existsSync(targetPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      fs$2.cpSync(sourcePath, targetPath, { recursive: true });
      continue;
    }
    fs$2.copyFileSync(sourcePath, targetPath);
  }
}
function migrateLegacyInstalledDataToUserData() {
  if (!app.isPackaged || isPortableMode()) {
    return;
  }
  const legacyDataDir = getLegacyPackagedDataDir();
  const targetDataDir = app.getPath("userData");
  const legacyDbPath = path.join(legacyDataDir, "novel_editor.db");
  const targetDbPath = path.join(targetDataDir, "novel_editor.db");
  if (!fs$2.existsSync(legacyDbPath) || fs$2.existsSync(targetDbPath)) {
    return;
  }
  copyDirectoryContentsIfMissing(legacyDataDir, targetDataDir);
  console.log("[Main] Migrated legacy packaged data from exe/data to userData.");
}
function resolveWindowIcon() {
  if (app.isPackaged) {
    const packagedIcon = path.join(process.resourcesPath, "icon_ink_pen_256.ico");
    return fs$2.existsSync(packagedIcon) ? packagedIcon : void 0;
  }
  const devIcon = path.join(process.env.APP_ROOT || "", "build", "icon_ink_pen_256.ico");
  if (fs$2.existsSync(devIcon)) {
    return devIcon;
  }
  const fallbackIcon = path.join(process.env.VITE_PUBLIC || "", "electron-vite.svg");
  return fs$2.existsSync(fallbackIcon) ? fallbackIcon : void 0;
}
function resolveDefaultUserDataPath() {
  const appDataPath = app.getPath("appData");
  if (app.isPackaged) {
    return path.join(appDataPath, PACKAGED_APP_NAME);
  }
  return path.join(appDataPath, "@novel-editor", "desktop-dev");
}
function quoteWindowsArg(value) {
  if (!value)
    return '""';
  if (!/[ \t"]/u.test(value))
    return value;
  return `"${value.replace(/"/gu, '\\"')}"`;
}
function resolveMcpLauncherPath() {
  if (app.isPackaged) {
    if (process.platform === "win32") {
      return path.join(process.resourcesPath, "mcp", "novel-editor-mcp.cmd");
    }
    return path.join(process.resourcesPath, "mcp", "novel-editor-mcp.mjs");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APP_ROOT || "", "scripts", "novel-editor-mcp.cmd");
  }
  return path.join(process.env.APP_ROOT || "", "scripts", "novel-editor-mcp.mjs");
}
function buildMcpCliSetupPayload() {
  const commandPath = resolveMcpLauncherPath();
  const launcherExists = fs$2.existsSync(commandPath);
  const serverName = "novel_editor";
  const startupTimeoutSec = 60;
  const toolTimeoutSec = 120;
  const command = process.platform === "win32" ? "cmd" : "node";
  const args = process.platform === "win32" ? ["/c", commandPath] : [commandPath];
  const codexToml = process.platform === "win32" ? [
    `[mcp_servers.${serverName}]`,
    'command = "cmd"',
    `args = ["/c", "${commandPath.replace(/\\/gu, "\\\\")}"]`,
    `startup_timeout_sec = ${startupTimeoutSec}`,
    `tool_timeout_sec = ${toolTimeoutSec}`
  ].join("\n") : [
    `[mcp_servers.${serverName}]`,
    'command = "node"',
    `args = ["${commandPath}"]`,
    `startup_timeout_sec = ${startupTimeoutSec}`,
    `tool_timeout_sec = ${toolTimeoutSec}`
  ].join("\n");
  const claudeCommand = process.platform === "win32" ? `claude mcp add novel-editor --scope local -- cmd /c ${quoteWindowsArg(commandPath)}` : `claude mcp add novel-editor --scope local -- node ${quoteWindowsArg(commandPath)}`;
  const jsonConfig = JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          command,
          args
        }
      }
    },
    null,
    2
  );
  return {
    commandPath,
    launcherExists,
    command,
    args,
    codexToml,
    claudeCommand,
    jsonConfig
  };
}
function getAutomationRuntimePath() {
  return path.join(app.getPath("userData"), "automation", "runtime.json");
}
function readAutomationRuntimeDescriptor() {
  const runtimePath = getAutomationRuntimePath();
  if (!fs$2.existsSync(runtimePath)) {
    throw new Error(`Automation runtime file not found: ${runtimePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs$2.readFileSync(runtimePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse automation runtime: ${(error == null ? void 0 : error.message) || "unknown error"}`);
  }
  const runtime = parsed;
  if (!runtime || typeof runtime !== "object") {
    throw new Error("Automation runtime is empty");
  }
  if (!Number.isFinite(runtime.port) || !runtime.port || runtime.port <= 0) {
    throw new Error("Automation runtime port is invalid");
  }
  if (typeof runtime.token !== "string" || !runtime.token.trim()) {
    throw new Error("Automation runtime token is invalid");
  }
  return {
    version: Number(runtime.version || 1),
    port: Number(runtime.port),
    token: runtime.token,
    pid: Number(runtime.pid || 0),
    startedAt: String(runtime.startedAt || "")
  };
}
async function invokeAutomationForHealth(runtime) {
  const payload = {
    method: "novel.list",
    params: {},
    origin: "desktop-ui"
  };
  const body = JSON.stringify(payload);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: runtime.port,
        path: "/invoke",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body, "utf8"),
          Authorization: `Bearer ${runtime.token}`
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(new Error(`Automation health response parse failed: ${(error == null ? void 0 : error.message) || "unknown error"}`));
          }
        });
      }
    );
    request.setTimeout(8e3, () => {
      request.destroy(new Error("Automation health request timeout"));
    });
    request.on("error", (error) => reject(error));
    request.write(body);
    request.end();
  });
}
async function testNovelEditorMcpBridge() {
  const setup = buildMcpCliSetupPayload();
  if (!setup.launcherExists) {
    return { ok: false, detail: `MCP launcher missing: ${setup.commandPath}` };
  }
  let runtime;
  try {
    runtime = readAutomationRuntimeDescriptor();
  } catch (error) {
    return { ok: false, detail: (error == null ? void 0 : error.message) || "Automation runtime unavailable" };
  }
  try {
    const response = await invokeAutomationForHealth(runtime);
    if (!(response == null ? void 0 : response.ok)) {
      return {
        ok: false,
        detail: `Automation invoke failed: ${(response == null ? void 0 : response.code) || "UNKNOWN"} ${(response == null ? void 0 : response.message) || ""}`.trim()
      };
    }
    const count = Array.isArray(response.data) ? response.data.length : 0;
    return {
      ok: true,
      detail: `MCP bridge ready. launcher=ok runtime=ok invoke=ok novels=${count}`
    };
  } catch (error) {
    return { ok: false, detail: `Automation invoke error: ${(error == null ? void 0 : error.message) || "unknown error"}` };
  }
}
function parseAiDiagCommand(argv) {
  const markerIndex = argv.indexOf("--ai-diag");
  if (markerIndex < 0)
    return {};
  const tokens = argv.slice(markerIndex + 1);
  if (tokens.length === 0) {
    return { error: "Missing diagnostic action. Use: --ai-diag smoke <mcp|skill> [--json] [--db <path>] [--user-data <path>] or --ai-diag coverage [--json] [--db <path>] [--user-data <path>]" };
  }
  const positionals = [];
  let json = false;
  let dbPath;
  let userDataPath;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--db") {
      const value = tokens[index + 1];
      if (!value)
        return { error: "Missing value for --db" };
      dbPath = value;
      index += 1;
      continue;
    }
    if (token === "--user-data") {
      const value = tokens[index + 1];
      if (!value)
        return { error: "Missing value for --user-data" };
      userDataPath = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      return { error: `Unknown option: ${token}` };
    }
    positionals.push(token);
  }
  const [action, kind] = positionals;
  if (action === "coverage") {
    return { command: { action: "coverage", json, dbPath, userDataPath } };
  }
  if (action === "smoke") {
    if (kind !== "mcp" && kind !== "skill") {
      return { error: "Smoke mode requires kind: mcp | skill" };
    }
    return { command: { action: "smoke", kind, json, dbPath, userDataPath } };
  }
  return { error: `Unknown diagnostic action: ${action}` };
}
function formatAiDiagReadable(result, command) {
  if (command.action === "coverage") {
    const output2 = result;
    const lines2 = [
      `[AI-Diag] Coverage ${output2.overallCoverage}% (${output2.totalSupported}/${output2.totalRequired})`,
      ...output2.modules.map((module) => {
        const missing = module.missingActions.length ? ` missing=[${module.missingActions.join(", ")}]` : "";
        return `- ${module.title}: ${module.coverage}% (${module.supportedActions.length}/${module.requiredActions.length})${missing}`;
      })
    ];
    return lines2.join("\n");
  }
  const output = result;
  const lines = [
    `[AI-Diag] Smoke ${output.kind.toUpperCase()} ${output.ok ? "PASSED" : "FAILED"}`,
    `detail: ${output.detail}`,
    output.missingActions.length ? `missingActions: ${output.missingActions.join(", ")}` : "missingActions: none",
    ...output.checks.map((check) => {
      const tag = check.skipped ? "SKIPPED" : check.ok ? "OK" : "FAILED";
      return `- [${tag}] ${check.actionId}: ${check.detail}`;
    })
  ];
  return lines.join("\n");
}
async function runAiDiagCommand(aiService2, command) {
  const result = command.action === "coverage" ? aiService2.getCapabilityCoverage() : await aiService2.testOpenClawSmoke({ kind: command.kind });
  if (command.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAiDiagReadable(result, command));
  }
  if (command.action === "smoke" && !result.ok) {
    return 1;
  }
  return 0;
}
function patchDevConsoleLogging() {
  if (!isDevDebugEnabled() || consolePatched)
    return;
  consolePatched = true;
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args) => {
    devLog("ERROR", "console.error", "console.error called", { args: redactForLog(args) });
    originalError(...args);
  };
  console.warn = (...args) => {
    devLog("WARN", "console.warn", "console.warn called", { args: redactForLog(args) });
    originalWarn(...args);
  };
}
function logAiIpcError(channel, payload, error) {
  const normalized = normalizeAiError(error);
  devLogError(`Main.${channel}`, error, {
    payload: redactForLog(payload),
    normalizedError: normalized,
    displayMessage: formatAiErrorForDisplay(normalized.code, normalized.message)
  });
}
const aiDiagParse = parseAiDiagCommand(process.argv);
async function applyProxySettings(settings) {
  const proxy = settings == null ? void 0 : settings.proxy;
  if (!proxy || !session.defaultSession)
    return;
  const clearEnvProxy = () => {
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  };
  const setEnvProxy = () => {
    if (proxy.httpProxy) {
      process.env.HTTP_PROXY = proxy.httpProxy;
      process.env.http_proxy = proxy.httpProxy;
    }
    if (proxy.httpsProxy) {
      process.env.HTTPS_PROXY = proxy.httpsProxy;
      process.env.https_proxy = proxy.httpsProxy;
    }
    if (proxy.allProxy) {
      process.env.ALL_PROXY = proxy.allProxy;
      process.env.all_proxy = proxy.allProxy;
    }
    if (proxy.noProxy) {
      process.env.NO_PROXY = proxy.noProxy;
      process.env.no_proxy = proxy.noProxy;
    }
  };
  if (proxy.mode === "off") {
    await session.defaultSession.setProxy({ mode: "direct" });
    clearEnvProxy();
    return;
  }
  if (proxy.mode === "custom") {
    const rules = [proxy.allProxy, proxy.httpsProxy, proxy.httpProxy].filter((value) => Boolean(value)).join(";");
    await session.defaultSession.setProxy({
      mode: rules ? "fixed_servers" : "direct",
      proxyRules: rules,
      proxyBypassRules: proxy.noProxy || ""
    });
    clearEnvProxy();
    setEnvProxy();
    return;
  }
  await session.defaultSession.setProxy({ mode: "system" });
  clearEnvProxy();
}
function createWindow() {
  const isDevMode = !app.isPackaged;
  const icon = resolveWindowIcon();
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...icon ? { icon } : {},
    webPreferences: {
      preload: path.join(__dirname$1, "preload.mjs"),
      devTools: isDevMode
    },
    // Win11 style & White Screen Fix
    frame: true,
    titleBarStyle: "default",
    backgroundColor: "#0a0a0f",
    // Match App Theme
    show: false,
    // Wait for ready-to-show
    autoHideMenuBar: true
    // Hide default menu bar
  });
  win.once("ready-to-show", () => {
    win == null ? void 0 : win.show();
  });
  win.webContents.on("did-finish-load", () => {
    win == null ? void 0 : win.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  });
  win.webContents.on("devtools-opened", () => {
    if (!isDevMode) {
      win == null ? void 0 : win.webContents.closeDevTools();
    }
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F11") {
      win == null ? void 0 : win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
    if (!isDevMode) {
      return;
    }
    if (input.key === "F12" || input.control && input.shift && input.key.toLowerCase() === "i") {
      if (win == null ? void 0 : win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win == null ? void 0 : win.webContents.openDevTools();
      }
      event.preventDefault();
    }
  });
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
  win.on("enter-full-screen", () => {
    win == null ? void 0 : win.webContents.send("app:fullscreen-change", true);
  });
  win.on("leave-full-screen", () => {
    win == null ? void 0 : win.webContents.send("app:fullscreen-change", false);
  });
}
ipcMain.handle("app:toggle-fullscreen", () => {
  if (win) {
    const isFullScreen = win.isFullScreen();
    win.setFullScreen(!isFullScreen);
    return !isFullScreen;
  }
  return false;
});
ipcMain.handle("app:get-user-data-path", () => {
  return app.getPath("userData");
});
ipcMain.handle("db:get-novels", async () => {
  console.log("[Main] Received db:get-novels");
  try {
    const novels = await db.novel.findMany({
      include: {
        volumes: {
          select: {
            chapters: { select: { content: true } }
          }
        }
      },
      orderBy: { updatedAt: "desc" }
    });
    return novels.map((n) => {
      const totalWords = n.volumes.reduce(
        (acc, v) => acc + v.chapters.reduce((cAcc, c) => cAcc + extractTextFromLexical(c.content || "").length, 0),
        0
      );
      const { volumes, ...rest } = n;
      return {
        ...rest,
        wordCount: totalWords
      };
    });
  } catch (e) {
    console.error("[Main] db:get-novels failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-novel", async (_, { id, data }) => {
  console.log("[Main] Updating novel:", id, data);
  try {
    return await db.novel.update({
      where: { id },
      data: {
        ...data,
        updatedAt: /* @__PURE__ */ new Date()
      }
    });
  } catch (e) {
    console.error("[Main] db:update-novel failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-novel", async (_, novelId) => {
  var _a;
  console.log("[Main] Received db:delete-novel:", novelId);
  try {
    const novel = await db.novel.findUnique({
      where: { id: novelId },
      select: { coverUrl: true }
    });
    if ((_a = novel == null ? void 0 : novel.coverUrl) == null ? void 0 : _a.startsWith("covers/")) {
      const coverPath = path.join(app.getPath("userData"), novel.coverUrl);
      if (fs$2.existsSync(coverPath)) {
        fs$2.unlinkSync(coverPath);
      }
    }
    await db.novel.delete({
      where: { id: novelId }
    });
    return { ok: true };
  } catch (e) {
    console.error("[Main] db:delete-novel failed:", e);
    throw e;
  }
});
ipcMain.handle("db:upload-novel-cover", async (_, novelId) => {
  var _a;
  try {
    const result = await dialog.showOpenDialog(win, {
      title: "Select Cover Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0)
      return null;
    const srcPath = result.filePaths[0];
    const ext = path.extname(srcPath);
    const coversDir = path.join(app.getPath("userData"), "covers");
    if (!fs$2.existsSync(coversDir))
      fs$2.mkdirSync(coversDir, { recursive: true });
    const novel = await db.novel.findUnique({ where: { id: novelId }, select: { coverUrl: true } });
    if ((_a = novel == null ? void 0 : novel.coverUrl) == null ? void 0 : _a.startsWith("covers/")) {
      const oldPath = path.join(app.getPath("userData"), novel.coverUrl);
      if (fs$2.existsSync(oldPath))
        fs$2.unlinkSync(oldPath);
    }
    const fileName = `${novelId}${ext}`;
    const destPath = path.join(coversDir, fileName);
    fs$2.copyFileSync(srcPath, destPath);
    const relativePath = `covers/${fileName}`;
    await db.novel.update({
      where: { id: novelId },
      data: { coverUrl: relativePath }
    });
    return { path: relativePath };
  } catch (e) {
    console.error("[Main] db:upload-novel-cover failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-volumes", async (_, novelId) => {
  try {
    return await db.volume.findMany({
      where: { novelId },
      include: {
        chapters: { orderBy: { order: "asc" } }
      },
      orderBy: { order: "asc" }
    });
  } catch (e) {
    console.error("[Main] db:get-volumes failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-volume", async (_, { novelId, title }) => {
  try {
    const lastVol = await db.volume.findFirst({
      where: { novelId },
      orderBy: { order: "desc" }
    });
    const order = ((lastVol == null ? void 0 : lastVol.order) || 0) + 1;
    return await db.volume.create({
      data: { novelId, title, order }
    });
  } catch (e) {
    console.error("[Main] db:create-volume failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-chapter", async (_, { volumeId, title, order }) => {
  try {
    const chapter = await db.chapter.create({
      data: {
        volumeId,
        title,
        order,
        content: "",
        wordCount: 0
      },
      include: { volume: { select: { novelId: true } } }
    });
    await indexChapter({ ...chapter, novelId: chapter.volume.novelId });
    return chapter;
  } catch (e) {
    console.error("[Main] db:create-chapter failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-chapter", async (_, id) => {
  try {
    return await db.chapter.findUnique({
      where: { id },
      include: { volume: { select: { novelId: true } } }
    });
  } catch (e) {
    console.error("[Main] db:get-chapter failed:", e);
    throw e;
  }
});
ipcMain.handle("db:rename-volume", async (_, { volumeId, title }) => {
  try {
    const updated = await db.volume.update({
      where: { id: volumeId },
      data: { title }
    });
    const chapters = await db.chapter.findMany({
      where: { volumeId },
      include: { volume: { select: { novelId: true, title: true, order: true } } }
    });
    for (const chapter of chapters) {
      await indexChapter({
        ...chapter,
        novelId: chapter.volume.novelId,
        volumeTitle: chapter.volume.title,
        volumeOrder: chapter.volume.order
      });
    }
    return updated;
  } catch (e) {
    console.error("[Main] db:rename-volume failed:", e);
    throw e;
  }
});
ipcMain.handle("db:rename-chapter", async (_, { chapterId, title }) => {
  try {
    const updated = await db.chapter.update({
      where: { id: chapterId },
      data: { title }
    });
    const chapterData = await db.chapter.findUnique({
      where: { id: chapterId },
      select: { id: true, title: true, content: true, volumeId: true, order: true, volume: { select: { novelId: true } } }
    });
    if (chapterData && chapterData.volume) {
      await indexChapter({ ...chapterData, novelId: chapterData.volume.novelId });
    }
    return updated;
  } catch (e) {
    console.error("[Main] db:rename-chapter failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-chapter", async (_, { chapterId }) => {
  var _a, _b, _c, _d;
  try {
    const chapter = await db.chapter.findUnique({
      where: { id: chapterId },
      select: {
        id: true,
        title: true,
        content: true,
        wordCount: true,
        order: true,
        volumeId: true,
        volume: {
          select: {
            novelId: true,
            title: true,
            order: true
          }
        }
      }
    });
    if (!(chapter == null ? void 0 : chapter.volume)) {
      throw new Error("Chapter not found");
    }
    const novelId = chapter.volume.novelId;
    const chaptersInNovel = await db.chapter.findMany({
      where: { volume: { novelId } },
      select: {
        id: true,
        title: true,
        content: true,
        order: true,
        volumeId: true,
        volume: {
          select: {
            title: true,
            order: true
          }
        }
      },
      orderBy: [
        { volume: { order: "asc" } },
        { order: "asc" }
      ]
    });
    const targetIndex = chaptersInNovel.findIndex((item) => item.id === chapterId);
    if (targetIndex === -1) {
      throw new Error("Chapter not found");
    }
    if (chaptersInNovel.length === 1) {
      const [, resetChapter] = await db.$transaction([
        db.novel.update({
          where: { id: novelId },
          data: {
            wordCount: 0,
            updatedAt: /* @__PURE__ */ new Date()
          }
        }),
        db.chapter.update({
          where: { id: chapterId },
          data: {
            title: "",
            content: "",
            wordCount: 0,
            updatedAt: /* @__PURE__ */ new Date()
          },
          include: {
            volume: {
              select: {
                novelId: true
              }
            }
          }
        })
      ]);
      await indexChapter({
        ...resetChapter,
        novelId,
        volumeTitle: chapter.volume.title,
        volumeOrder: chapter.volume.order
      });
      return {
        mode: "reset",
        chapterId,
        fallbackChapterId: chapterId,
        chapter: resetChapter
      };
    }
    const fallbackChapterId = ((_a = chaptersInNovel[targetIndex + 1]) == null ? void 0 : _a.id) ?? ((_b = chaptersInNovel[targetIndex - 1]) == null ? void 0 : _b.id) ?? null;
    const siblingChapters = chaptersInNovel.filter((item) => item.volumeId === chapter.volumeId && item.id !== chapterId);
    const reorderedSiblings = siblingChapters.map((item, index) => ({
      ...item,
      nextOrder: index + 1
    }));
    const siblingsNeedingReorder = reorderedSiblings.filter((item) => item.order !== item.nextOrder);
    await db.$transaction([
      db.novel.update({
        where: { id: novelId },
        data: {
          wordCount: { decrement: chapter.wordCount },
          updatedAt: /* @__PURE__ */ new Date()
        }
      }),
      db.chapter.delete({
        where: { id: chapterId }
      }),
      ...siblingsNeedingReorder.map((item) => db.chapter.update({
        where: { id: item.id },
        data: {
          order: item.nextOrder,
          updatedAt: /* @__PURE__ */ new Date()
        }
      }))
    ]);
    await removeFromIndex("chapter", chapterId);
    for (const item of siblingsNeedingReorder) {
      await indexChapter({
        id: item.id,
        title: item.title,
        content: item.content,
        volumeId: item.volumeId,
        novelId,
        volumeTitle: (_c = item.volume) == null ? void 0 : _c.title,
        order: item.nextOrder,
        volumeOrder: (_d = item.volume) == null ? void 0 : _d.order
      });
    }
    return {
      mode: "deleted",
      chapterId,
      fallbackChapterId
    };
  } catch (e) {
    console.error("[Main] db:delete-chapter failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-novel", async (_, title) => {
  console.log("[Main] Received db:create-novel:", title);
  try {
    const novel = await db.novel.create({
      data: {
        title,
        wordCount: 0,
        volumes: {
          create: {
            title: "",
            // Default empty
            order: 1,
            chapters: {
              create: {
                title: "",
                // Default empty
                content: "",
                order: 1,
                wordCount: 0
              }
            }
          }
        }
      }
    });
    return novel;
  } catch (e) {
    console.error("[Main] db:create-novel failed:", e);
    throw e;
  }
});
ipcMain.handle("db:save-chapter", async (_, { chapterId, content }) => {
  try {
    console.log("[Main] Saving chapter:", chapterId);
    const chapter = await db.chapter.findUnique({
      where: { id: chapterId },
      select: {
        wordCount: true,
        volume: { select: { novelId: true } }
      }
    });
    if (!chapter || !chapter.volume)
      throw new Error("Chapter or Volume not found");
    const novelId = chapter.volume.novelId;
    const newWordCount = extractTextFromLexical(content).length;
    const delta = newWordCount - chapter.wordCount;
    const [, updatedChapter] = await db.$transaction([
      // 1. Update Novel WordCount
      db.novel.update({
        where: { id: novelId },
        data: {
          wordCount: { increment: delta },
          updatedAt: /* @__PURE__ */ new Date()
        }
      }),
      // 2. Update Chapter
      db.chapter.update({
        where: { id: chapterId },
        data: {
          content,
          wordCount: newWordCount,
          updatedAt: /* @__PURE__ */ new Date()
        }
      })
    ]);
    const chapterData = await db.chapter.findUnique({
      where: { id: chapterId },
      select: { id: true, title: true, content: true, volumeId: true, order: true }
    });
    if (chapterData) {
      await indexChapter({ ...chapterData, novelId });
    }
    scheduleChapterSummaryRebuild(chapterId);
    return updatedChapter;
  } catch (e) {
    console.error("[Main] db:save-chapter failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-idea", async (_, data) => {
  try {
    const { timestamp, tags, ...prismaData } = data;
    const novelId = prismaData.novelId;
    const result = await db.idea.create({
      data: {
        ...prismaData,
        tags: {
          connectOrCreate: (tags || []).map((tag) => ({
            where: { name_novelId: { name: tag, novelId } },
            create: { name: tag, novelId }
          }))
        }
      },
      include: { tags: true }
    });
    const mappedResult = {
      ...result,
      tags: result.tags.map((t) => t.name),
      timestamp: result.createdAt.getTime()
    };
    await indexIdea({
      id: result.id,
      content: result.content,
      quote: result.quote,
      novelId: result.novelId,
      chapterId: result.chapterId
    });
    return mappedResult;
  } catch (e) {
    console.error("[Main] db:create-idea failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-ideas", async (_, novelId) => {
  try {
    const ideas = await db.idea.findMany({
      where: { novelId },
      include: { tags: true },
      orderBy: [
        { isStarred: "desc" },
        { updatedAt: "desc" }
      ]
    });
    return ideas.map((idea) => ({
      ...idea,
      tags: idea.tags.map((t) => t.name),
      timestamp: idea.createdAt.getTime()
    }));
  } catch (e) {
    console.error("[Main] db:get-ideas failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-idea", async (_, id, data) => {
  try {
    const { timestamp, tags, ...updateData } = data;
    const finalData = { ...updateData };
    if (tags !== void 0) {
      const currentIdea = await db.idea.findUnique({ where: { id }, select: { novelId: true } });
      if (currentIdea) {
        const novelId = currentIdea.novelId;
        finalData.tags = {
          set: [],
          // Disconnect all existing
          connectOrCreate: (tags || []).map((tag) => ({
            where: { name_novelId: { name: tag, novelId } },
            create: { name: tag, novelId }
          }))
        };
      }
    }
    const result = await db.idea.update({
      where: { id },
      data: {
        ...finalData,
        updatedAt: /* @__PURE__ */ new Date()
      },
      include: { tags: true }
    });
    const mappedResult = {
      ...result,
      tags: result.tags.map((t) => t.name),
      timestamp: result.createdAt.getTime()
    };
    await indexIdea({
      id: result.id,
      content: result.content,
      quote: result.quote,
      novelId: result.novelId,
      chapterId: result.chapterId
    });
    return mappedResult;
  } catch (e) {
    console.error("[Main] db:update-idea failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-idea", async (_, id) => {
  try {
    const result = await db.idea.delete({ where: { id } });
    await removeFromIndex("idea", id);
    return result;
  } catch (e) {
    console.error("[Main] db:delete-idea failed:", e);
    throw e;
  }
});
ipcMain.handle("db:check-index-status", async (_, novelId) => {
  try {
    const stats = await getIndexStats(novelId);
    const chapterCount = await db.chapter.count({
      where: { volume: { novelId } }
    });
    const ideaCount = await db.idea.count({
      where: { novelId }
    });
    return {
      indexedChapters: stats.chapters,
      totalChapters: chapterCount,
      indexedIdeas: stats.ideas,
      totalIdeas: ideaCount
    };
  } catch (e) {
    console.error("[Main] db:check-index-status failed:", e);
    throw e;
  }
});
const syncManager = new SyncManager();
let aiService;
let automationService;
let automationServer = null;
ipcMain.handle("ai:get-settings", async () => {
  try {
    return aiService.getSettings();
  } catch (e) {
    logAiIpcError("ai:get-settings", void 0, e);
    console.error("[Main] ai:get-settings failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:get-map-image-stats", async () => {
  try {
    return aiService.getMapImageStats();
  } catch (e) {
    logAiIpcError("ai:get-map-image-stats", void 0, e);
    console.error("[Main] ai:get-map-image-stats failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:list-actions", async () => {
  try {
    return aiService.listActions();
  } catch (e) {
    logAiIpcError("ai:list-actions", void 0, e);
    console.error("[Main] ai:list-actions failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:get-capability-coverage", async () => {
  try {
    return aiService.getCapabilityCoverage();
  } catch (e) {
    logAiIpcError("ai:get-capability-coverage", void 0, e);
    console.error("[Main] ai:get-capability-coverage failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:get-mcp-manifest", async () => {
  try {
    return aiService.getMcpToolsManifest();
  } catch (e) {
    logAiIpcError("ai:get-mcp-manifest", void 0, e);
    console.error("[Main] ai:get-mcp-manifest failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:get-mcp-cli-setup", async () => {
  try {
    return buildMcpCliSetupPayload();
  } catch (e) {
    logAiIpcError("ai:get-mcp-cli-setup", void 0, e);
    console.error("[Main] ai:get-mcp-cli-setup failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:get-openclaw-manifest", async () => {
  try {
    return aiService.getOpenClawManifest();
  } catch (e) {
    logAiIpcError("ai:get-openclaw-manifest", void 0, e);
    console.error("[Main] ai:get-openclaw-manifest failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:get-openclaw-skill-manifest", async () => {
  try {
    return aiService.getOpenClawSkillManifest();
  } catch (e) {
    logAiIpcError("ai:get-openclaw-skill-manifest", void 0, e);
    console.error("[Main] ai:get-openclaw-skill-manifest failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:update-settings", async (_, partial) => {
  try {
    const updated = aiService.updateSettings(partial || {});
    await applyProxySettings(updated);
    return updated;
  } catch (e) {
    logAiIpcError("ai:update-settings", partial, e);
    console.error("[Main] ai:update-settings failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:test-connection", async () => {
  try {
    return await aiService.testConnection();
  } catch (e) {
    logAiIpcError("ai:test-connection", void 0, e);
    console.error("[Main] ai:test-connection failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:test-mcp", async () => {
  try {
    return await testNovelEditorMcpBridge();
  } catch (e) {
    logAiIpcError("ai:test-mcp", void 0, e);
    console.error("[Main] ai:test-mcp failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:test-openclaw-mcp", async () => {
  try {
    return await aiService.testOpenClawMcp();
  } catch (e) {
    logAiIpcError("ai:test-openclaw-mcp", void 0, e);
    console.error("[Main] ai:test-openclaw-mcp failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:test-openclaw-skill", async () => {
  try {
    return await aiService.testOpenClawSkill();
  } catch (e) {
    logAiIpcError("ai:test-openclaw-skill", void 0, e);
    console.error("[Main] ai:test-openclaw-skill failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:test-openclaw-smoke", async (_, payload) => {
  try {
    const kind = (payload == null ? void 0 : payload.kind) === "skill" ? "skill" : "mcp";
    return await aiService.testOpenClawSmoke({ kind });
  } catch (e) {
    logAiIpcError("ai:test-openclaw-smoke", payload, e);
    console.error("[Main] ai:test-openclaw-smoke failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:test-proxy", async () => {
  try {
    return await aiService.testProxy();
  } catch (e) {
    logAiIpcError("ai:test-proxy", void 0, e);
    console.error("[Main] ai:test-proxy failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:test-generate", async (_, payload) => {
  try {
    return await aiService.testGenerate(payload == null ? void 0 : payload.prompt);
  } catch (e) {
    logAiIpcError("ai:test-generate", payload, e);
    console.error("[Main] ai:test-generate failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:generate-title", async (_, payload) => {
  try {
    return await aiService.generateTitle(payload);
  } catch (e) {
    logAiIpcError("ai:generate-title", payload, e);
    console.error("[Main] ai:generate-title failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:continue-writing", async (_, payload) => {
  try {
    return await aiService.continueWriting(payload);
  } catch (e) {
    logAiIpcError("ai:continue-writing", payload, e);
    console.error("[Main] ai:continue-writing failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:preview-continue-prompt", async (_, payload) => {
  try {
    return await aiService.previewContinuePrompt(payload);
  } catch (e) {
    logAiIpcError("ai:preview-continue-prompt", payload, e);
    console.error("[Main] ai:preview-continue-prompt failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:check-consistency", async (_, payload) => {
  try {
    return await aiService.checkConsistency(payload);
  } catch (e) {
    logAiIpcError("ai:check-consistency", payload, e);
    console.error("[Main] ai:check-consistency failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:ask-novel", async (_, payload) => {
  try {
    return await aiService.askNovel(payload);
  } catch (e) {
    logAiIpcError("ai:ask-novel", payload, e);
    console.error("[Main] ai:ask-novel failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:preview-novel-ask-prompt", async (_, payload) => {
  try {
    return await aiService.previewNovelAskPrompt(payload);
  } catch (e) {
    logAiIpcError("ai:preview-novel-ask-prompt", payload, e);
    console.error("[Main] ai:preview-novel-ask-prompt failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:generate-creative-assets", async (_, payload) => {
  try {
    return await aiService.generateCreativeAssets(payload);
  } catch (e) {
    logAiIpcError("ai:generate-creative-assets", payload, e);
    console.error("[Main] ai:generate-creative-assets failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:preview-creative-assets-prompt", async (_, payload) => {
  try {
    return await aiService.previewCreativeAssetsPrompt(payload);
  } catch (e) {
    logAiIpcError("ai:preview-creative-assets-prompt", payload, e);
    console.error("[Main] ai:preview-creative-assets-prompt failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:validate-creative-assets", async (_, payload) => {
  try {
    return await aiService.validateCreativeAssetsDraft(payload);
  } catch (e) {
    logAiIpcError("ai:validate-creative-assets", payload, e);
    console.error("[Main] ai:validate-creative-assets failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:confirm-creative-assets", async (_, payload) => {
  try {
    return await aiService.confirmCreativeAssets(payload);
  } catch (e) {
    logAiIpcError("ai:confirm-creative-assets", payload, e);
    console.error("[Main] ai:confirm-creative-assets failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:generate-map-image", async (_, payload) => {
  try {
    return await aiService.generateMapImage(payload);
  } catch (e) {
    logAiIpcError("ai:generate-map-image", payload, e);
    console.error("[Main] ai:generate-map-image failed:", e);
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "UNKNOWN", detail: message };
  }
});
ipcMain.handle("ai:preview-map-prompt", async (_, payload) => {
  try {
    return await aiService.previewMapPrompt(payload);
  } catch (e) {
    logAiIpcError("ai:preview-map-prompt", payload, e);
    console.error("[Main] ai:preview-map-prompt failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:rebuild-chapter-summary", async (_, payload) => {
  try {
    if (!(payload == null ? void 0 : payload.chapterId)) {
      return { ok: false, detail: "chapterId is required" };
    }
    scheduleChapterSummaryRebuild(payload.chapterId, "manual");
    return { ok: true, detail: "summary rebuild scheduled" };
  } catch (e) {
    logAiIpcError("ai:rebuild-chapter-summary", payload, e);
    console.error("[Main] ai:rebuild-chapter-summary failed:", e);
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
});
ipcMain.handle("ai:execute-action", async (_, payload) => {
  try {
    return await aiService.executeAction(payload);
  } catch (e) {
    logAiIpcError("ai:execute-action", payload, e);
    console.error("[Main] ai:execute-action failed:", e);
    throw e;
  }
});
ipcMain.handle("ai:openclaw-invoke", async (_, payload) => {
  try {
    return await aiService.invokeOpenClawTool(payload);
  } catch (e) {
    logAiIpcError("ai:openclaw-invoke", payload, e);
    console.error("[Main] ai:openclaw-invoke failed:", e);
    const normalized = normalizeAiError(e);
    return {
      ok: false,
      code: normalized.code,
      error: formatAiErrorForDisplay(normalized.code, normalized.message)
    };
  }
});
ipcMain.handle("ai:openclaw-mcp-invoke", async (_, payload) => {
  try {
    return await aiService.invokeOpenClawTool(payload);
  } catch (e) {
    logAiIpcError("ai:openclaw-mcp-invoke", payload, e);
    console.error("[Main] ai:openclaw-mcp-invoke failed:", e);
    const normalized = normalizeAiError(e);
    return {
      ok: false,
      code: normalized.code,
      error: formatAiErrorForDisplay(normalized.code, normalized.message)
    };
  }
});
ipcMain.handle("ai:openclaw-skill-invoke", async (_, payload) => {
  try {
    return await aiService.invokeOpenClawSkill(payload);
  } catch (e) {
    logAiIpcError("ai:openclaw-skill-invoke", payload, e);
    console.error("[Main] ai:openclaw-skill-invoke failed:", e);
    const normalized = normalizeAiError(e);
    return {
      ok: false,
      code: normalized.code,
      error: formatAiErrorForDisplay(normalized.code, normalized.message)
    };
  }
});
ipcMain.handle("automation:invoke", async (_, payload) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  try {
    devLog("INFO", "Main.automation:invoke.start", "Renderer automation invoke start", {
      requestId,
      method: payload.method,
      origin: payload.origin ?? "desktop-ui",
      params: redactForLog(payload.params)
    });
    const result = await automationService.invoke(payload.method, payload.params, {
      source: "renderer",
      origin: payload.origin ?? "desktop-ui",
      requestId
    });
    devLog("INFO", "Main.automation:invoke.success", "Renderer automation invoke success", {
      requestId,
      method: payload.method,
      elapsedMs: Date.now() - startedAt,
      result: redactForLog(result)
    });
    const dataChangingMethods = /* @__PURE__ */ new Set([
      "outline.write",
      "character.create_batch",
      "story_patch.apply",
      "worldsetting.create",
      "worldsetting.update",
      "chapter.create",
      "chapter.save",
      "creative_assets.generate_draft",
      "outline.generate_draft",
      "chapter.generate_draft",
      "draft.update",
      "draft.commit",
      "draft.discard"
    ]);
    if (dataChangingMethods.has(payload.method)) {
      win == null ? void 0 : win.webContents.send("automation:data-changed", { method: payload.method });
    }
    return result;
  } catch (e) {
    devLogError("Main.automation:invoke.error", e, {
      requestId,
      method: payload.method,
      elapsedMs: Date.now() - startedAt,
      payload: redactForLog(payload)
    });
    logAiIpcError("automation:invoke", payload, e);
    throw e;
  }
});
ipcMain.handle("sync:pull", async () => {
  try {
    return await syncManager.pull();
  } catch (e) {
    console.error("[Main] sync:pull failed:", e);
    throw e;
  }
});
ipcMain.handle("backup:export", async (_, password) => {
  try {
    return await backupService.exportData(void 0, password);
  } catch (e) {
    console.error("[Main] backup:export failed:", e);
    throw e;
  }
});
ipcMain.handle("backup:import", async (_, { filePath, password }) => {
  try {
    if (!filePath) {
      const result = await dialog.showOpenDialog({
        title: "Import Backup",
        filters: [{ name: "Novel Editor Backup", extensions: ["nebak"] }],
        properties: ["openFile"]
      });
      if (result.canceled || result.filePaths.length === 0)
        return { success: false, code: "CANCELLED" };
      filePath = result.filePaths[0];
    }
    await backupService.importData(filePath, password);
    return { success: true };
  } catch (e) {
    console.error("[Main] backup:import failed:", e);
    const msg = e.message || e.toString();
    if (msg.includes("PASSWORD_REQUIRED")) {
      return { success: false, code: "PASSWORD_REQUIRED", filePath };
    }
    if (msg.includes("PASSWORD_INVALID")) {
      return { success: false, code: "PASSWORD_INVALID", filePath };
    }
    return { success: false, message: msg };
  }
});
ipcMain.handle("backup:get-auto", async () => {
  try {
    return await backupService.getAutoBackups();
  } catch (e) {
    console.error("[Main] backup:get-auto failed:", e);
    throw e;
  }
});
ipcMain.handle("backup:restore-auto", async (_, filename) => {
  try {
    await backupService.restoreAutoBackup(filename);
    return true;
  } catch (e) {
    console.error("[Main] backup:restore-auto failed:", e);
    throw e;
  }
});
ipcMain.handle("sync:push", async () => {
  try {
    return await syncManager.push();
  } catch (e) {
    console.error("[Main] sync:push failed:", e);
    throw e;
  }
});
ipcMain.handle("db:search", async (_, { novelId, keyword, limit = 20, offset = 0 }) => {
  try {
    return await search(novelId, keyword, limit, offset);
  } catch (e) {
    console.error("[Main] db:search failed:", e);
    throw e;
  }
});
ipcMain.handle("db:rebuild-search-index", async (_, novelId) => {
  try {
    return await rebuildIndex(novelId);
  } catch (e) {
    console.error("[Main] db:rebuild-search-index failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-all-tags", async (_, novelId) => {
  try {
    if (!novelId)
      return [];
    const tags = await db.tag.findMany({
      where: { novelId },
      orderBy: { name: "asc" },
      select: { name: true }
    });
    return tags.map((t) => t.name);
  } catch (e) {
    console.error("[Main] db:get-all-tags failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-plot-lines", async (_, novelId) => {
  try {
    return await db.plotLine.findMany({
      where: { novelId },
      include: {
        points: {
          include: { anchors: true },
          orderBy: { order: "asc" }
        }
      },
      orderBy: { sortOrder: "asc" }
    });
  } catch (e) {
    console.error("[Main] db:get-plot-lines failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-plot-line", async (_, data) => {
  try {
    const maxOrder = await db.plotLine.aggregate({
      where: { novelId: data.novelId },
      _max: { sortOrder: true }
    });
    const order = (maxOrder._max.sortOrder || 0) + 1;
    return await db.plotLine.create({
      data: { ...data, sortOrder: order }
    });
  } catch (e) {
    console.error("[Main] db:create-plot-line failed. Data:", data, "Error:", e);
    throw e;
  }
});
ipcMain.handle("db:update-plot-line", async (_, data) => {
  try {
    return await db.plotLine.update({
      where: { id: data.id },
      data: data.data
    });
  } catch (e) {
    console.error("[Main] db:update-plot-line failed. ID:", data.id, "Error:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-plot-line", async (_, id) => {
  try {
    return await db.plotLine.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-plot-line failed. ID:", id, "Error:", e);
    throw e;
  }
});
ipcMain.handle("db:create-plot-point", async (_, data) => {
  try {
    const { plotLineId } = data;
    const maxOrder = await db.plotPoint.aggregate({
      where: { plotLineId },
      _max: { order: true }
    });
    const order = (maxOrder._max.order || 0) + 1;
    return await db.plotPoint.create({
      data: { ...data, order }
    });
  } catch (e) {
    console.error("[Main] db:create-plot-point failed. Data:", data, "Error:", e);
    throw e;
  }
});
ipcMain.handle("db:update-plot-point", async (_, data) => {
  try {
    return await db.plotPoint.update({
      where: { id: data.id },
      data: data.data
    });
  } catch (e) {
    console.error("[Main] db:update-plot-point failed. ID:", data.id, "Error:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-plot-point", async (_, id) => {
  try {
    return await db.plotPoint.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-plot-point failed. ID:", id, "Error:", e);
    throw e;
  }
});
ipcMain.handle("db:create-plot-point-anchor", async (_, data) => {
  try {
    return await db.plotPointAnchor.create({ data });
  } catch (e) {
    console.error("[Main] db:create-plot-point-anchor failed. Data:", data, "Error:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-plot-point-anchor", async (_, id) => {
  try {
    return await db.plotPointAnchor.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-plot-point-anchor failed. ID:", id, "Error:", e);
    throw e;
  }
});
ipcMain.handle("db:reorder-plot-lines", async (_, { lineIds }) => {
  try {
    const updates = lineIds.map(
      (id, index) => db.plotLine.update({
        where: { id },
        data: { sortOrder: index }
      })
    );
    await db.$transaction(updates);
    return { success: true };
  } catch (e) {
    console.error("[Main] db:reorder-plot-lines failed:", e);
    throw e;
  }
});
ipcMain.handle("db:reorder-plot-points", async (_, { plotLineId, pointIds }) => {
  try {
    const updates = pointIds.map(
      (id, index) => db.plotPoint.update({
        where: { id },
        data: { order: index, plotLineId }
      })
    );
    await db.$transaction(updates);
    return { success: true };
  } catch (e) {
    console.error("[Main] db:reorder-plot-points failed:", e);
    throw e;
  }
});
ipcMain.handle("db:upload-character-image", async (_, { characterId, type }) => {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: type === "avatar" ? "Select Avatar Image" : "Select Full Body Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0)
      return null;
    const srcPath = result.filePaths[0];
    const ext = path.extname(srcPath);
    const charDir = path.join(app.getPath("userData"), "characters", characterId);
    if (!fs$2.existsSync(charDir))
      fs$2.mkdirSync(charDir, { recursive: true });
    if (type === "avatar") {
      const fileName = `avatar${ext}`;
      const destPath = path.join(charDir, fileName);
      const existingFiles = fs$2.readdirSync(charDir).filter((f) => f.startsWith("avatar."));
      existingFiles.forEach((f) => {
        try {
          fs$2.unlinkSync(path.join(charDir, f));
        } catch {
        }
      });
      fs$2.copyFileSync(srcPath, destPath);
      const relativePath = `characters/${characterId}/${fileName}`;
      await db.character.update({
        where: { id: characterId },
        data: { avatar: relativePath }
      });
      return { path: relativePath };
    } else {
      const timestamp = Date.now();
      const fileName = `fullbody_${timestamp}${ext}`;
      const destPath = path.join(charDir, fileName);
      fs$2.copyFileSync(srcPath, destPath);
      const relativePath = `characters/${characterId}/${fileName}`;
      const char = await db.character.findUnique({ where: { id: characterId }, select: { fullBodyImages: true } });
      let images = [];
      try {
        images = JSON.parse((char == null ? void 0 : char.fullBodyImages) || "[]");
      } catch {
      }
      images.push(relativePath);
      await db.character.update({
        where: { id: characterId },
        data: { fullBodyImages: JSON.stringify(images) }
      });
      return { path: relativePath, images };
    }
  } catch (e) {
    console.error("[Main] db:upload-character-image failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-character-image", async (_, { characterId, imagePath, type }) => {
  try {
    const userDataDir = app.getPath("userData");
    const fullPath = path.resolve(path.join(userDataDir, imagePath));
    if (!fullPath.startsWith(userDataDir + path.sep)) {
      throw new Error("Invalid image path: path traversal detected");
    }
    if (fs$2.existsSync(fullPath))
      fs$2.unlinkSync(fullPath);
    if (type === "avatar") {
      await db.character.update({
        where: { id: characterId },
        data: { avatar: null }
      });
    } else {
      const char = await db.character.findUnique({ where: { id: characterId }, select: { fullBodyImages: true } });
      let images = [];
      try {
        images = JSON.parse((char == null ? void 0 : char.fullBodyImages) || "[]");
      } catch {
      }
      images = images.filter((p) => p !== imagePath);
      await db.character.update({
        where: { id: characterId },
        data: { fullBodyImages: JSON.stringify(images) }
      });
    }
  } catch (e) {
    console.error("[Main] db:delete-character-image failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-character-map-locations", async (_, characterId) => {
  try {
    const markers = await db.characterMapMarker.findMany({
      where: { characterId },
      include: {
        map: { select: { id: true, name: true, type: true } }
      }
    });
    return markers.map((m) => ({
      mapId: m.map.id,
      mapName: m.map.name,
      mapType: m.map.type
    }));
  } catch (e) {
    console.error("[Main] db:get-character-map-locations failed:", e);
    return [];
  }
});
ipcMain.handle("db:get-characters", async (_, novelId) => {
  try {
    return await db.character.findMany({
      where: { novelId },
      include: {
        items: {
          include: { item: true }
        }
      },
      orderBy: [
        { isStarred: "desc" },
        { sortOrder: "asc" }
      ]
    });
  } catch (e) {
    console.error("[Main] db:get-characters failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-character", async (_, id) => {
  try {
    return await db.character.findUnique({
      where: { id },
      include: {
        items: {
          include: { item: true }
        }
      }
    });
  } catch (e) {
    console.error("[Main] db:get-character failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-character", async (_, data) => {
  try {
    const profileData = typeof data.profile === "object" ? JSON.stringify(data.profile) : data.profile;
    return await db.character.create({
      data: { ...data, profile: profileData }
    });
  } catch (e) {
    console.error("[Main] db:create-character failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-character", async (_, { id, data }) => {
  try {
    const profileData = typeof data.profile === "object" ? JSON.stringify(data.profile) : data.profile;
    return await db.character.update({
      where: { id },
      data: { ...data, profile: profileData }
    });
  } catch (e) {
    console.error("[Main] db:update-character failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-character", async (_, id) => {
  try {
    await db.character.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-character failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-items", async (_, novelId) => {
  try {
    return await db.item.findMany({
      where: { novelId },
      orderBy: { sortOrder: "asc" }
    });
  } catch (e) {
    console.error("[Main] db:get-items failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-item", async (_, id) => {
  try {
    return await db.item.findUnique({ where: { id } });
  } catch (e) {
    console.error("[Main] db:get-item failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-item", async (_, data) => {
  try {
    const maxOrder = await db.item.aggregate({
      where: { novelId: data.novelId },
      _max: { sortOrder: true }
    });
    const sortOrder = (maxOrder._max.sortOrder || 0) + 1;
    return await db.item.create({
      data: { ...data, sortOrder }
    });
  } catch (e) {
    console.error("[Main] db:create-item failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-item", async (_, { id, data }) => {
  try {
    return await db.item.update({
      where: { id },
      data: { ...data, updatedAt: /* @__PURE__ */ new Date() }
    });
  } catch (e) {
    console.error("[Main] db:update-item failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-item", async (_, id) => {
  try {
    return await db.item.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-item failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-mentionables", async (_, novelId) => {
  try {
    const [characters, items, worldSettings, maps] = await Promise.all([
      db.character.findMany({
        where: { novelId },
        select: { id: true, name: true, avatar: true, role: true, isStarred: true },
        orderBy: [
          { isStarred: "desc" },
          { name: "asc" }
        ]
      }),
      db.item.findMany({
        where: { novelId },
        select: { id: true, name: true, icon: true },
        orderBy: { name: "asc" }
      }),
      db.worldSetting.findMany({
        where: { novelId },
        select: { id: true, name: true, icon: true, type: true },
        orderBy: { name: "asc" }
      }),
      db.mapCanvas.findMany({
        where: { novelId },
        select: { id: true, name: true, type: true },
        orderBy: { name: "asc" }
      })
    ]);
    return [
      ...characters.map((c) => ({ ...c, type: "character" })),
      ...items.map((i) => ({ ...i, type: "item" })),
      ...worldSettings.map((ws) => ({ id: ws.id, name: ws.name, icon: ws.icon, type: "world", role: ws.type })),
      ...maps.map((m) => ({ id: m.id, name: m.name, type: "map", role: m.type }))
    ];
  } catch (e) {
    console.error("[Main] db:get-mentionables failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-world-settings", async (_, novelId) => {
  try {
    return await db.worldSetting.findMany({
      where: { novelId },
      orderBy: { sortOrder: "asc" }
    });
  } catch (e) {
    console.error("[Main] db:get-world-settings failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-world-setting", async (_, data) => {
  try {
    const last = await db.worldSetting.findFirst({
      where: { novelId: data.novelId },
      orderBy: { sortOrder: "desc" }
    });
    return await db.worldSetting.create({
      data: {
        novelId: data.novelId,
        name: data.name,
        type: data.type || "other",
        sortOrder: ((last == null ? void 0 : last.sortOrder) || 0) + 1
      }
    });
  } catch (e) {
    console.error("[Main] db:create-world-setting failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-world-setting", async (_, id, data) => {
  try {
    return await db.worldSetting.update({
      where: { id },
      data
    });
  } catch (e) {
    console.error("[Main] db:update-world-setting failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-world-setting", async (_, id) => {
  try {
    return await db.worldSetting.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-world-setting failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-maps", async (_, novelId) => {
  try {
    return await db.mapCanvas.findMany({
      where: { novelId },
      orderBy: { sortOrder: "asc" }
    });
  } catch (e) {
    console.error("[Main] db:get-maps failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-map", async (_, id) => {
  try {
    return await db.mapCanvas.findUnique({
      where: { id },
      include: {
        markers: { include: { character: { select: { id: true, name: true, avatar: true, role: true } } } },
        elements: { orderBy: { z: "asc" } }
      }
    });
  } catch (e) {
    console.error("[Main] db:get-map failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-map", async (_, data) => {
  try {
    return await db.mapCanvas.create({ data });
  } catch (e) {
    console.error("[Main] db:create-map failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-map", async (_, { id, data }) => {
  try {
    const { markers, elements, createdAt, updatedAt, ...updateData } = data;
    return await db.mapCanvas.update({ where: { id }, data: updateData });
  } catch (e) {
    console.error("[Main] db:update-map failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-map", async (_, id) => {
  try {
    const map = await db.mapCanvas.findUnique({ where: { id }, select: { background: true, novelId: true } });
    if (map == null ? void 0 : map.background) {
      const bgPath = path.join(app.getPath("userData"), map.background);
      if (fs$2.existsSync(bgPath))
        fs$2.unlinkSync(bgPath);
    }
    return await db.mapCanvas.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-map failed:", e);
    throw e;
  }
});
ipcMain.handle("db:upload-map-bg", async (_, mapId) => {
  try {
    const map = await db.mapCanvas.findUnique({ where: { id: mapId }, select: { novelId: true, background: true } });
    if (!map)
      return null;
    const result = await dialog.showOpenDialog(win, {
      title: "Select Map Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0)
      return null;
    const srcPath = result.filePaths[0];
    const ext = path.extname(srcPath);
    const mapsDir = path.join(app.getPath("userData"), "maps", map.novelId);
    if (!fs$2.existsSync(mapsDir))
      fs$2.mkdirSync(mapsDir, { recursive: true });
    if (map.background) {
      const oldPath = path.join(app.getPath("userData"), map.background);
      if (fs$2.existsSync(oldPath))
        fs$2.unlinkSync(oldPath);
    }
    const fileName = `${mapId}${ext}`;
    const destPath = path.join(mapsDir, fileName);
    fs$2.copyFileSync(srcPath, destPath);
    const relativePath = `maps/${map.novelId}/${fileName}`;
    const img = nativeImage.createFromPath(destPath);
    const imgSize = img.getSize();
    const width = imgSize.width || 1200;
    const height = imgSize.height || 800;
    await db.mapCanvas.update({
      where: { id: mapId },
      data: { background: relativePath, width, height }
    });
    return { path: relativePath, width, height };
  } catch (e) {
    console.error("[Main] db:upload-map-bg failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-map-markers", async (_, mapId) => {
  try {
    return await db.characterMapMarker.findMany({
      where: { mapId },
      include: { character: { select: { id: true, name: true, avatar: true, role: true } } }
    });
  } catch (e) {
    console.error("[Main] db:get-map-markers failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-map-marker", async (_, data) => {
  try {
    return await db.characterMapMarker.create({
      data,
      include: { character: { select: { id: true, name: true, avatar: true, role: true } } }
    });
  } catch (e) {
    console.error("[Main] db:create-map-marker failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-map-marker", async (_, { id, data }) => {
  try {
    return await db.characterMapMarker.update({
      where: { id },
      data,
      include: { character: { select: { id: true, name: true, avatar: true, role: true } } }
    });
  } catch (e) {
    console.error("[Main] db:update-map-marker failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-map-marker", async (_, id) => {
  try {
    return await db.characterMapMarker.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-map-marker failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-map-elements", async (_, mapId) => {
  try {
    return await db.mapElement.findMany({
      where: { mapId },
      orderBy: { z: "asc" }
    });
  } catch (e) {
    console.error("[Main] db:get-map-elements failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-map-element", async (_, data) => {
  try {
    return await db.mapElement.create({ data });
  } catch (e) {
    console.error("[Main] db:create-map-element failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-map-element", async (_, { id, data }) => {
  try {
    const { createdAt, updatedAt, map, ...updateData } = data;
    return await db.mapElement.update({ where: { id }, data: updateData });
  } catch (e) {
    console.error("[Main] db:update-map-element failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-map-element", async (_, id) => {
  try {
    return await db.mapElement.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-map-element failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-relationships", async (_, characterId) => {
  try {
    const [asSource, asTarget] = await Promise.all([
      db.relationship.findMany({
        where: { sourceId: characterId },
        include: { target: { select: { id: true, name: true, avatar: true, role: true } } }
      }),
      db.relationship.findMany({
        where: { targetId: characterId },
        include: { source: { select: { id: true, name: true, avatar: true, role: true } } }
      })
    ]);
    return [...asSource, ...asTarget];
  } catch (e) {
    console.error("[Main] db:get-relationships failed:", e);
    throw e;
  }
});
ipcMain.handle("db:create-relationship", async (_, data) => {
  try {
    return await db.relationship.create({
      data,
      include: {
        source: { select: { id: true, name: true, avatar: true, role: true } },
        target: { select: { id: true, name: true, avatar: true, role: true } }
      }
    });
  } catch (e) {
    console.error("[Main] db:create-relationship failed:", e);
    throw e;
  }
});
ipcMain.handle("db:delete-relationship", async (_, id) => {
  try {
    return await db.relationship.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:delete-relationship failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-character-items", async (_, characterId) => {
  try {
    return await db.itemOwnership.findMany({
      where: { characterId },
      include: { item: true }
    });
  } catch (e) {
    console.error("[Main] db:get-character-items failed:", e);
    throw e;
  }
});
ipcMain.handle("db:add-item-to-character", async (_, data) => {
  try {
    return await db.itemOwnership.create({
      data,
      include: { item: true }
    });
  } catch (e) {
    console.error("[Main] db:add-item-to-character failed:", e);
    throw e;
  }
});
ipcMain.handle("db:remove-item-from-character", async (_, id) => {
  try {
    return await db.itemOwnership.delete({ where: { id } });
  } catch (e) {
    console.error("[Main] db:remove-item-from-character failed:", e);
    throw e;
  }
});
ipcMain.handle("db:update-item-ownership", async (_, id, data) => {
  try {
    return await db.itemOwnership.update({
      where: { id },
      data,
      include: { item: true }
    });
  } catch (e) {
    console.error("[Main] db:update-item-ownership failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-character-timeline", async (_, characterId) => {
  try {
    const character = await db.character.findUnique({ where: { id: characterId }, select: { name: true, novelId: true } });
    if (!character)
      return [];
    const anchors = await db.plotPointAnchor.findMany({
      where: {
        plotPoint: {
          novelId: character.novelId,
          description: { contains: `@${character.name}` }
        }
      },
      include: {
        plotPoint: { select: { title: true, description: true, plotLine: { select: { name: true } } } },
        chapter: { select: { id: true, title: true, order: true, volume: { select: { title: true, order: true } } } }
      },
      orderBy: [{ chapter: { volume: { order: "asc" } } }, { chapter: { order: "asc" } }]
    });
    const seen = /* @__PURE__ */ new Set();
    return anchors.filter((a) => a.chapter && !seen.has(a.chapter.id) && seen.add(a.chapter.id)).map((a) => {
      var _a;
      return {
        chapterId: a.chapter.id,
        chapterTitle: a.chapter.title,
        volumeTitle: a.chapter.volume.title,
        order: a.chapter.order,
        volumeOrder: a.chapter.volume.order,
        snippet: ((_a = a.plotPoint.description) == null ? void 0 : _a.substring(0, 100)) || a.plotPoint.title
      };
    });
  } catch (e) {
    console.error("[Main] db:get-character-timeline failed:", e);
    throw e;
  }
});
function extractTextFromLexical(jsonString) {
  if (!jsonString)
    return "";
  try {
    const content = JSON.parse(jsonString);
    if (!content.root)
      return jsonString;
    const texts = [];
    const traverse = (node) => {
      if (node.text) {
        texts.push(node.text);
      }
      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(traverse);
      }
      if (node.type === "paragraph" || node.type === "heading" || node.type === "quote") {
        texts.push(" ");
      }
    };
    traverse(content.root);
    return texts.join("").replace(/\s+/g, " ").trim();
  } catch (e) {
    return jsonString;
  }
}
ipcMain.handle("db:get-character-chapter-appearances", async (_, characterId) => {
  try {
    const character = await db.character.findUnique({ where: { id: characterId }, select: { name: true, novelId: true } });
    if (!character)
      return [];
    const chapters = await db.chapter.findMany({
      where: {
        volume: { novelId: character.novelId },
        // Use LIKE for rough match on JSON string (imperfect but fast first filter)
        content: { contains: character.name }
      },
      select: {
        id: true,
        title: true,
        order: true,
        content: true,
        volume: { select: { title: true, order: true } }
      },
      orderBy: [{ volume: { order: "asc" } }, { order: "asc" }]
    });
    return chapters.map((ch) => {
      const plainText = extractTextFromLexical(ch.content || "");
      let snippet = "";
      const idx = plainText.indexOf(character.name);
      if (idx >= 0) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(plainText.length, idx + character.name.length + 50);
        snippet = (start > 0 ? "..." : "") + plainText.substring(start, end) + (end < plainText.length ? "..." : "");
      } else {
      }
      return {
        chapterId: ch.id,
        chapterTitle: ch.title,
        volumeTitle: ch.volume.title,
        order: ch.order,
        volumeOrder: ch.volume.order,
        snippet
      };
    }).filter((item) => item.snippet !== "");
  } catch (e) {
    console.error("[Main] db:get-character-chapter-appearances failed:", e);
    throw e;
  }
});
ipcMain.handle("db:get-recent-chapters", async (_, characterName, novelId, limit = 5) => {
  try {
    return await db.chapter.findMany({
      where: {
        volume: { novelId },
        content: { contains: `@${characterName}` }
      },
      select: {
        id: true,
        title: true,
        order: true,
        wordCount: true,
        updatedAt: true
      },
      orderBy: { updatedAt: "desc" },
      take: limit
    });
  } catch (e) {
    console.error("[Main] db:get-recent-chapters failed:", e);
    throw e;
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});
app.on("before-quit", () => {
  if (automationServer) {
    void automationServer.stop().catch((error) => {
      console.error("[Main] Failed to stop automation server:", error);
    });
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
app.whenReady().then(async () => {
  var _a, _b, _c;
  if (aiDiagParse.error) {
    initDevLogger(app.getPath("userData"));
    patchDevConsoleLogging();
    console.error(`[AI-Diag] Invalid arguments: ${aiDiagParse.error}`);
    app.exit(2);
    return;
  }
  app.setAppUserModelId(resolveWindowsAppUserModelId());
  app.setName(app.isPackaged ? PACKAGED_APP_NAME : DEV_APP_NAME);
  const resolvedUserDataPath = ((_a = aiDiagParse.command) == null ? void 0 : _a.userDataPath) ? path.resolve(aiDiagParse.command.userDataPath) : resolveDefaultUserDataPath();
  app.setPath("userData", resolvedUserDataPath);
  initDevLogger(app.getPath("userData"));
  patchDevConsoleLogging();
  console.log("[Main] App Ready. Starting DB Setup...");
  console.log("[Main] User Data Path:", app.getPath("userData"));
  if (aiDiagParse.command && app.isPackaged) {
    console.error("[AI-Diag] --ai-diag is only available in development mode.");
    app.exit(1);
    return;
  }
  if ((_b = aiDiagParse.command) == null ? void 0 : _b.userDataPath) {
    console.log("[AI-Diag] userData override:", resolvedUserDataPath);
  }
  const userDataRoot = path.resolve(app.getPath("userData"));
  protocol.handle("local-resource", (request) => {
    const relativePath = decodeURIComponent(request.url.replace("local-resource://", ""));
    const fullPath = path.resolve(path.join(userDataRoot, relativePath));
    if (!fullPath.startsWith(userDataRoot + path.sep) && fullPath !== userDataRoot) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch("file:///" + fullPath.replace(/\\/g, "/"));
  });
  let dataPath;
  if (app.isPackaged && isPortableMode()) {
    dataPath = getPortableDataDir();
  } else {
    dataPath = app.getPath("userData");
  }
  migrateLegacyInstalledDataToUserData();
  const dbPath = ((_c = aiDiagParse.command) == null ? void 0 : _c.dbPath) ? path.resolve(aiDiagParse.command.dbPath) : path.join(dataPath, "novel_editor.db");
  const dbUrl = `file:${dbPath}`;
  console.log("[Main] Database Path:", dbPath);
  if (!fs$2.existsSync(path.dirname(dbPath))) {
    fs$2.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  if (!app.isPackaged) {
    const schemaPath = path.resolve(__dirname$1, "../../../packages/core/prisma/schema.prisma");
    console.log("[Main] Development mode detected (unpackaged). Checking schema at:", schemaPath);
    if (fs$2.existsSync(schemaPath)) {
      const dbFolder = path.dirname(dbPath);
      if (!fs$2.existsSync(dbFolder)) {
        fs$2.mkdirSync(dbFolder, { recursive: true });
      }
      console.log("[Main] Schema found.");
      console.log("[Main] Cleaning up FTS tables before migration...");
      initDb(dbUrl);
      try {
        await db.$executeRawUnsafe("DROP TABLE IF EXISTS search_index;");
        console.log("[Main] FTS tables dropped successfully.");
      } catch (e) {
        console.warn("[Main] Failed to drop FTS table (non-critical):", e);
      }
      await db.$disconnect();
      console.log("[Main] Attempting synchronous DB push to:", dbPath);
      const prismaPath = path.resolve(__dirname$1, "../../../packages/core/node_modules/.bin/prisma.cmd");
      console.log("[Main] Using Prisma binary at:", prismaPath);
      if (!fs$2.existsSync(prismaPath)) {
        console.error("[Main] Prisma binary NOT found at:", prismaPath);
      } else {
        try {
          const command = `"${prismaPath}" db push --schema="${schemaPath}" --accept-data-loss`;
          console.log("[Main] Executing command:", command);
          const output = execSync(command, {
            env: { ...process.env, DATABASE_URL: dbUrl },
            cwd: path.resolve(__dirname$1, "../../../packages/core"),
            stdio: "pipe",
            // Avoid inherit to prevent encoding issues
            windowsHide: true
          });
          console.log("[Main] DB Push output:", output.toString());
          console.log("[Main] DB Push completed successfully.");
        } catch (error) {
          console.error("[Main] DB Push failed.");
          if (error.stdout)
            console.log("[Main] stdout:", error.stdout.toString());
          if (error.stderr)
            console.error("[Main] stderr:", error.stderr.toString());
        }
      }
    } else {
      console.warn("[Main] Schema file NOT found at:", schemaPath);
    }
  }
  initDb(dbUrl);
  try {
    const schemaApplied = await ensureDbSchema();
    if (schemaApplied) {
      console.log("[Main] Bundled database schema applied successfully.");
    }
  } catch (error) {
    console.error("[Main] Failed to ensure bundled database schema:", error);
    throw error;
  }
  aiService = new AiService(() => app.getPath("userData"));
  automationService = new AutomationService(aiService, () => app.getPath("userData"));
  automationServer = new AutomationServer(
    automationService,
    () => app.getPath("userData"),
    (method) => {
      win == null ? void 0 : win.webContents.send("automation:data-changed", { method });
    }
  );
  await automationServer.start();
  if (aiDiagParse.command) {
    try {
      const exitCode = await runAiDiagCommand(aiService, aiDiagParse.command);
      await db.$disconnect();
      app.exit(exitCode);
      return;
    } catch (error) {
      console.error("[AI-Diag] Execution failed:", error);
      await db.$disconnect();
      app.exit(1);
      return;
    }
  }
  await initSearchIndex();
  console.log("[Main] Search index initialized");
  try {
    await applyProxySettings(aiService.getSettings());
  } catch (e) {
    console.warn("[Main] Failed to apply AI proxy settings:", e);
  }
  createWindow();
});
export {
  MAIN_DIST,
  RENDERER_DIST,
  VITE_DEV_SERVER_URL
};
