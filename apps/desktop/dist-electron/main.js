var za = Object.defineProperty;
var Wa = (n, e, t) => e in n ? za(n, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : n[e] = t;
var H = (n, e, t) => (Wa(n, typeof e != "symbol" ? e + "" : e, t), t);
import { net as qr, app as j, dialog as ht, ipcMain as b, nativeImage as Xa, BrowserWindow as ea, protocol as Ga, session as $t } from "electron";
import { db as S, initDb as Yr, ensureDbSchema as Ka } from "@novel-editor/core";
import { fileURLToPath as Za } from "node:url";
import D from "node:path";
import { createHash as be, randomUUID as le } from "node:crypto";
import ar from "node:http";
import { execSync as Ya } from "child_process";
import z from "fs";
import re from "node:fs";
import { spawn as jr } from "node:child_process";
import Te from "node:fs/promises";
import Qa from "node:net";
import Ke from "path";
import ta from "zlib";
import vt from "crypto";
const es = [
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
async function Qr() {
  await S.$executeRaw`
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
async function ts() {
  return (await S.$queryRawUnsafe("PRAGMA table_info(search_index);")).map((e) => e.name);
}
async function en() {
  const n = await S.novel.findMany({
    where: { deleted: !1 },
    select: { id: !0 }
  });
  for (const e of n)
    await na(e.id);
}
async function rs() {
  try {
    if ((await S.$queryRaw`
            SELECT name FROM sqlite_master WHERE type='table' AND name='search_index';
        `).length === 0)
      await Qr(), console.log("[SearchIndex] FTS5 table created successfully"), await en(), console.log("[SearchIndex] FTS5 index rebuilt from source data");
    else {
      const e = await ts(), t = es.filter((r) => !e.includes(r));
      t.length > 0 && (console.warn(`[SearchIndex] Schema mismatch detected. Rebuilding FTS5 table. Missing columns: ${t.join(", ")}`), await S.$executeRawUnsafe("DROP TABLE IF EXISTS search_index;"), await Qr(), await en(), console.log("[SearchIndex] FTS5 table rebuilt successfully"));
    }
  } catch (n) {
    console.error("[SearchIndex] Failed to initialize FTS5 table:", n);
  }
}
function ns(n) {
  if (!n)
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (a) => {
      a.type === "text" && a.text && t.push(a.text), a.children && Array.isArray(a.children) && (a.children.forEach(r), a.type !== "root" && a.type !== "list" && a.type !== "listitem" && t.push(" "));
    };
    return e.root && r(e.root), t.join("").trim();
  } catch {
    return n;
  }
}
async function Fe(n) {
  const e = ns(n.content);
  let t = n.novelId, r = n.volumeTitle, a = n.order, s = n.volumeOrder;
  if (!t || !r || a === void 0 || s === void 0) {
    const i = await S.chapter.findUnique({
      where: { id: n.id },
      select: {
        order: !0,
        volume: { select: { id: !0, novelId: !0, title: !0, order: !0 } }
      }
    });
    i && (a === void 0 && (a = i.order), i.volume && (t || (t = i.volume.novelId), r || (r = i.volume.title), s === void 0 && (s = i.volume.order)));
  }
  if (t)
    try {
      await S.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'chapter' AND entity_id = ${n.id};
        `, await S.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${e}, 'chapter', ${n.id}, ${t}, ${n.id}, ${n.title}, ${r || ""}, ${a || 0}, ${s || 0}, ${n.volumeId});
        `;
    } catch (i) {
      console.error("[SearchIndex] Failed to index chapter:", i);
    }
}
async function Vr(n) {
  const e = [n.content, n.quote].filter(Boolean).join(" ");
  try {
    await S.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'idea' AND entity_id = ${n.id};
        `, await S.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${e}, 'idea', ${n.id}, ${n.novelId}, ${n.chapterId || ""}, ${n.content.substring(0, 50)}, '', 0, 0, '');
        `;
  } catch (t) {
    console.error("[SearchIndex] Failed to index idea:", t);
  }
}
async function ra(n, e) {
  try {
    await S.$executeRaw`
            DELETE FROM search_index WHERE entity_type = ${n} AND entity_id = ${e};
        `;
  } catch (t) {
    console.error("[SearchIndex] Failed to remove from index:", t);
  }
}
async function Jr(n, e, t = 20, r = 0) {
  if (!e.trim())
    return [];
  try {
    const s = `%${e.replace(/[%_]/g, "\\$&")}%`, i = await S.$queryRaw`
            SELECT entity_type, entity_id, chapter_id, novel_id, title, volume_title, content, chapter_order, volume_order, volume_id
            FROM search_index
            WHERE novel_id = ${n}
            AND (content LIKE ${s} OR title LIKE ${s} OR volume_title LIKE ${s})
            ORDER BY volume_order ASC, chapter_order ASC
            LIMIT ${t} OFFSET ${r};
        `, o = [], c = e.toLowerCase(), d = /* @__PURE__ */ new Set();
    for (const l of i) {
      const m = l.content || "", h = l.title || "", p = l.volume_title || "", f = Number(l.chapter_order || 0), I = Number(l.volume_order || 0);
      l.entity_type === "chapter" && p && p.toLowerCase().includes(c) && (d.has(p) || (o.push({
        entityType: "chapter",
        entityId: l.entity_id,
        chapterId: l.chapter_id,
        novelId: l.novel_id,
        title: l.title,
        snippet: `Volume match: <mark>${p}</mark>`,
        preview: `Found in Volume: ${p}`,
        keyword: e,
        matchType: "volume",
        chapterOrder: f,
        volumeTitle: p,
        volumeOrder: I,
        volumeId: l.volume_id
      }), d.add(p))), l.entity_type === "chapter" && h.toLowerCase().includes(c) && o.push({
        entityType: "chapter",
        entityId: l.entity_id,
        chapterId: l.chapter_id,
        novelId: l.novel_id,
        title: l.title,
        snippet: `Title match: <mark>${h}</mark>`,
        preview: `Found in Title: ${h}`,
        keyword: e,
        matchType: "title",
        chapterOrder: f,
        volumeTitle: p,
        volumeOrder: I,
        volumeId: l.volume_id
      });
      const y = m.toLowerCase(), g = [];
      let u = 0;
      for (; u < y.length && g.length < 200; ) {
        const A = y.indexOf(c, u);
        if (A === -1)
          break;
        g.push(A), u = A + c.length;
      }
      const v = 60, w = [];
      for (const A of g)
        (w.length === 0 || A - w[w.length - 1] > v) && w.push(A);
      for (const A of w)
        o.push({
          entityType: l.entity_type,
          entityId: l.entity_id,
          chapterId: l.chapter_id,
          novelId: l.novel_id,
          title: l.title,
          snippet: tn(m, e, A, 10, !0),
          preview: tn(m, e, A, 25, !1),
          keyword: e,
          matchType: "content",
          chapterOrder: f,
          volumeTitle: p,
          volumeOrder: I,
          volumeId: l.volume_id
        });
    }
    return o;
  } catch (a) {
    return console.error("[SearchIndex] Search failed:", a), [];
  }
}
function tn(n, e, t, r = 30, a = !0) {
  if (!n)
    return "";
  const s = Math.max(0, t - r), i = Math.min(n.length, t + e.length + r * 2);
  let o = "";
  s > 0 && (o += "...");
  const c = n.substring(s, t), d = n.substring(t, t + e.length), l = n.substring(t + e.length, i);
  return a ? o += c + "<mark>" + d + "</mark>" + l : o += c + d + l, i < n.length && (o += "..."), o;
}
async function na(n) {
  var r, a;
  let e = 0, t = 0;
  try {
    await S.$executeRaw`DELETE FROM search_index WHERE novel_id = ${n};`;
    const s = await S.chapter.findMany({
      where: { volume: { novelId: n } },
      select: {
        id: !0,
        title: !0,
        content: !0,
        volumeId: !0,
        order: !0,
        volume: { select: { title: !0, order: !0 } }
      }
    });
    for (const o of s)
      await Fe({
        ...o,
        novelId: n,
        volumeTitle: (r = o.volume) == null ? void 0 : r.title,
        volumeOrder: (a = o.volume) == null ? void 0 : a.order
      }), e++;
    const i = await S.idea.findMany({
      where: { novelId: n },
      select: { id: !0, content: !0, quote: !0, novelId: !0, chapterId: !0 }
    });
    for (const o of i)
      await Vr(o), t++;
  } catch (s) {
    console.error("[SearchIndex] Rebuild failed:", s);
  }
  return { chapters: e, ideas: t };
}
async function as(n) {
  try {
    const e = await S.$queryRaw`
            SELECT entity_type, COUNT(*) as count FROM search_index WHERE novel_id = ${n} GROUP BY entity_type;
        `;
    let t = 0, r = 0;
    return e.forEach((a) => {
      a.entity_type === "chapter" && (t = Number(a.count)), a.entity_type === "idea" && (r = Number(a.count));
    }), { chapters: t, ideas: r };
  } catch (e) {
    return console.error("[SearchIndex] Failed to get stats:", e), { chapters: 0, ideas: 0 };
  }
}
class k extends Error {
  constructor(t, r, a, s) {
    super(r);
    H(this, "code");
    H(this, "detail");
    H(this, "details");
    this.code = t, this.detail = a, this.details = s, this.name = "AiActionError";
  }
}
function ss(n) {
  const e = n.toLowerCase();
  return e.includes("cancelled") || e.includes("canceled") ? new k("CANCELLED", n) : e.includes("timed out") || e.includes("timeout") || e.includes("aborterror") || e.includes("aborted") ? new k("PROVIDER_TIMEOUT", n) : e.includes("401") || e.includes("403") || e.includes("unauthorized") || e.includes("forbidden") || e.includes("api key") ? new k("PROVIDER_AUTH", n) : e.includes("content_filter") || e.includes("safety") || e.includes("filtered") ? new k("PROVIDER_FILTERED", n) : e.includes("429") || e.includes("503") || e.includes("model") || e.includes("unavailable") ? new k("PROVIDER_UNAVAILABLE", n) : e.includes("fetch") || e.includes("network") || e.includes("econn") ? new k("NETWORK_ERROR", n) : new k("UNKNOWN", n);
}
function He(n) {
  if (n instanceof k)
    return n;
  const e = n instanceof Error ? n.message : String(n ?? "unknown error");
  return ss(e);
}
function At(n, e) {
  switch (n) {
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
    case "PROVIDER_RATE_LIMITED":
      return "模型服务请求较多，请稍后重试。";
    case "PROVIDER_UNAVAILABLE":
      return "模型暂不可用，请稍后重试或切换模型。";
    case "PROVIDER_FILTERED":
      return "请求触发内容策略限制，请调整提示词。";
    case "NETWORK_ERROR":
      return "网络连接失败，请检查网络或代理设置。";
    case "PERSISTENCE_ERROR":
      return "写入失败，数据未成功保存。";
    case "CANCELLED":
      return "请求已取消。";
    case "UNKNOWN":
    default:
      return e || "未知错误，请稍后重试。";
  }
}
const os = "debug-dev.log", is = 15 * 1024 * 1024, cs = "***REDACTED***", ds = /* @__PURE__ */ new Set([
  "authorization",
  "apikey",
  "api_key",
  "api key",
  "token",
  "access_token",
  "refresh_token"
]);
let Ze = null;
function Hr() {
  return process.env.NODE_ENV !== "production";
}
function rn(n) {
  Hr() && (Ze = D.join(n, os), aa());
}
function ve(n) {
  return Rr(n, /* @__PURE__ */ new WeakSet());
}
function $(n, e, t, r) {
  if (!Hr())
    return;
  const a = [
    `[${(/* @__PURE__ */ new Date()).toISOString()}] [${n}] [${e}]`,
    `message=${t}`,
    r === void 0 ? "" : `extra=${us(ve(r))}`,
    ""
  ].filter(Boolean);
  ls(a.join(`
`));
}
function Se(n, e, t) {
  const r = sa(e);
  $("ERROR", n, r.message, {
    error: r,
    ...t === void 0 ? {} : { extra: t }
  });
}
function aa() {
  if (!Ze)
    return;
  const n = D.dirname(Ze);
  re.existsSync(n) || re.mkdirSync(n, { recursive: !0 }), re.existsSync(Ze) || re.writeFileSync(Ze, "", "utf8");
}
function ls(n) {
  if (Ze)
    try {
      aa(), (re.existsSync(Ze) ? re.statSync(Ze).size : 0) >= is && re.writeFileSync(Ze, "", "utf8"), re.appendFileSync(Ze, `${n}
`, "utf8");
    } catch {
    }
}
function us(n) {
  try {
    return JSON.stringify(n, null, 2);
  } catch {
    return String(n);
  }
}
function sa(n) {
  return n instanceof Error ? {
    name: n.name,
    message: n.message,
    stack: n.stack
  } : {
    name: typeof n,
    message: String(n)
  };
}
function Rr(n, e) {
  if (n == null || typeof n == "string" || typeof n == "number" || typeof n == "boolean")
    return n;
  if (typeof n == "bigint")
    return n.toString();
  if (n instanceof Error)
    return sa(n);
  if (Array.isArray(n))
    return n.map((t) => Rr(t, e));
  if (typeof n == "object") {
    const t = n;
    if (e.has(t))
      return "[Circular]";
    e.add(t);
    const r = {};
    for (const [a, s] of Object.entries(t)) {
      if (ds.has(a.toLowerCase())) {
        r[a] = cs;
        continue;
      }
      r[a] = Rr(s, e);
    }
    return e.delete(t), r;
  }
  return String(n);
}
function oa(n) {
  if (typeof (n == null ? void 0 : n.output_text) == "string")
    return n.output_text;
  if (!Array.isArray(n == null ? void 0 : n.output))
    return "";
  const e = [];
  for (const t of n.output) {
    if (typeof (t == null ? void 0 : t.content) == "string") {
      e.push(t.content);
      continue;
    }
    if (Array.isArray(t == null ? void 0 : t.content))
      for (const r of t.content)
        typeof (r == null ? void 0 : r.text) == "string" ? e.push(r.text) : typeof (r == null ? void 0 : r.content) == "string" && e.push(r.content);
  }
  return e.join(`
`).trim();
}
function nn(n) {
  var e, t, r, a, s;
  return String(
    ((e = n == null ? void 0 : n.error) == null ? void 0 : e.message) || ((r = (t = n == null ? void 0 : n.response) == null ? void 0 : t.error) == null ? void 0 : r.message) || (n == null ? void 0 : n.message) || ((s = (a = n == null ? void 0 : n.response) == null ? void 0 : a.incomplete_details) == null ? void 0 : s.reason) || "Responses stream failed"
  );
}
async function hs(n) {
  if (!n.body)
    throw new Error("Responses stream body is unavailable");
  const e = n.body.getReader(), t = new TextDecoder();
  let r = "", a = "", s = "", i = null, o = 0;
  const c = (l) => {
    var f, I, y, g;
    const m = l.split(`
`).filter((u) => u.startsWith("data:")).map((u) => u.slice(5).trimStart()).join(`
`).trim();
    if (!m || m === "[DONE]")
      return;
    let h;
    try {
      h = JSON.parse(m);
    } catch {
      throw new Error("Responses stream returned an invalid JSON event");
    }
    if (o += 1, (h == null ? void 0 : h.type) === "response.output_text.delta" && typeof h.delta == "string") {
      a += h.delta;
      return;
    }
    if ((h == null ? void 0 : h.type) === "response.output_text.done" && typeof h.text == "string") {
      s = h.text;
      return;
    }
    if ((h == null ? void 0 : h.type) === "response.completed") {
      if (i = h.response, (f = h.response) != null && f.status && h.response.status !== "completed")
        throw new Error(nn(h));
      return;
    }
    if ((h == null ? void 0 : h.type) === "response.failed" || (h == null ? void 0 : h.type) === "response.incomplete" || (h == null ? void 0 : h.type) === "error")
      throw new Error(nn(h));
    const p = (g = (y = (I = h == null ? void 0 : h.choices) == null ? void 0 : I[0]) == null ? void 0 : y.delta) == null ? void 0 : g.content;
    typeof p == "string" && (a += p);
  }, d = () => {
    r = r.replace(/\r\n/gu, `
`);
    let l = r.indexOf(`

`);
    for (; l >= 0; ) {
      const m = r.slice(0, l);
      r = r.slice(l + 2), c(m), l = r.indexOf(`

`);
    }
  };
  try {
    for (; ; ) {
      const { done: l, value: m } = await e.read();
      if (l)
        break;
      r += t.decode(m, { stream: !0 }), d();
    }
    r += t.decode(), d(), r.trim() && c(r.replace(/\r\n/gu, `
`));
  } catch (l) {
    throw await e.cancel(l).catch(() => {
    }), l;
  } finally {
    e.releaseLock();
  }
  return {
    text: (a || s || oa(i)).trim(),
    model: typeof (i == null ? void 0 : i.model) == "string" ? i.model : void 0,
    responseId: typeof (i == null ? void 0 : i.id) == "string" ? i.id : void 0,
    eventCount: o
  };
}
function ia(n, e) {
  return `${n.replace(/\/+$/, "")}/${e.replace(/^\/+/, "")}`;
}
function an(n, e) {
  const t = n.trim().replace(/\/+$/, "");
  return e === "responses" && /\/responses$/u.test(t) || e === "chat/completions" && /\/chat\/completions$/u.test(t) || e === "images/generations" && /\/images\/generations$/u.test(t) ? t : ia(t, e);
}
function ms(n) {
  const t = n.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/u, "").replace(/\/responses$/u, "").replace(/\/images\/generations$/u, "");
  return ia(t, "models");
}
function sn(n) {
  try {
    return JSON.parse(n);
  } catch {
    return null;
  }
}
function on(n) {
  var s, i;
  const e = String((n == null ? void 0 : n.message) || "unknown error"), t = ((s = n == null ? void 0 : n.cause) == null ? void 0 : s.code) || (n == null ? void 0 : n.code), r = (i = n == null ? void 0 : n.cause) == null ? void 0 : i.message, a = [e];
  return t && a.push(`code=${t}`), r && r !== e && a.push(`cause=${r}`), a.join(" | ");
}
function cn(n) {
  const e = { ...n };
  return typeof e.instructions == "string" && (e.instructions = `[${e.instructions.length} chars]`), typeof e.input == "string" && (e.input = `[${e.input.length} chars]`), Array.isArray(e.messages) && (e.messages = e.messages.map((t) => ({
    role: t == null ? void 0 : t.role,
    contentChars: typeof (t == null ? void 0 : t.content) == "string" ? t.content.length : void 0
  }))), e;
}
function fs(n, e, t) {
  var s, i, o;
  if (typeof ((s = t == null ? void 0 : t.error) == null ? void 0 : s.message) == "string" && t.error.message.trim())
    return t.error.message.trim();
  const r = (o = (i = e.match(/<title[^>]*>([^<]+)<\/title>/iu)) == null ? void 0 : i[1]) == null ? void 0 : o.replace(/\s+/gu, " ").trim();
  if (r)
    return `HTTP ${n.status}: ${r}`;
  const a = e.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 240);
  return `HTTP ${n.status}${a ? `: ${a}` : n.statusText ? `: ${n.statusText}` : ""}`;
}
async function hr(n, e) {
  return qr.fetch(n, e);
}
function ps(n) {
  const e = n.status;
  let t = "INVALID_INPUT", r = !1;
  return e === 401 || e === 403 ? t = "PROVIDER_AUTH" : e === 408 ? (t = "PROVIDER_TIMEOUT", r = !0) : e === 425 || e === 429 ? (t = "PROVIDER_RATE_LIMITED", r = !0) : e >= 500 && (t = "PROVIDER_UNAVAILABLE", r = !0), new k(
    t,
    r ? "模型服务暂时不可用。" : "模型服务拒绝了当前请求。",
    void 0,
    { httpStatus: e, retryable: r }
  );
}
class ca {
  constructor(e) {
    H(this, "name", "http");
    this.settings = e;
  }
  async healthCheck() {
    const { baseUrl: e, apiKey: t, timeoutMs: r } = this.settings.http;
    if (!e.trim())
      return { ok: !1, detail: "HTTP baseUrl is empty" };
    try {
      new URL(e);
    } catch {
      return { ok: !1, detail: "HTTP baseUrl is invalid" };
    }
    if (!t.trim())
      return { ok: !1, detail: "API key is empty" };
    const a = new AbortController();
    let s = !1;
    const i = Math.max(1e3, r), o = setTimeout(() => {
      s = !0, a.abort();
    }, i), c = ms(e), d = Date.now();
    try {
      $("INFO", "HttpProvider.healthCheck.request", "HTTP health check request", {
        url: c,
        timeoutMs: i,
        headers: { Authorization: `Bearer ${t}` }
      });
      const l = await hr(c, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${t}`
        },
        signal: a.signal
      });
      return l.ok ? ($("INFO", "HttpProvider.healthCheck.response", "HTTP health check ok", {
        url: c,
        status: l.status,
        elapsedMs: Date.now() - d
      }), { ok: !0, detail: "HTTP provider is reachable" }) : ($("WARN", "HttpProvider.healthCheck.response", "HTTP health check rejected", {
        url: c,
        status: l.status,
        elapsedMs: Date.now() - d
      }), (this.settings.http.apiMode ?? "chat-completions") === "responses" && (l.status === 404 || l.status === 405) ? {
        ok: !0,
        detail: `Models endpoint is unavailable (${l.status}); use test generate to verify the Responses endpoint.`
      } : { ok: !1, detail: `HTTP provider rejected: ${l.status}` });
    } catch (l) {
      return Se("HttpProvider.healthCheck.error", l, {
        url: c,
        elapsedMs: Date.now() - d,
        didTimeout: s
      }), s ? { ok: !1, detail: `HTTP health check timed out after ${i}ms` } : { ok: !1, detail: `HTTP health check failed: ${on(l)} | url=${c}` };
    } finally {
      clearTimeout(o);
    }
  }
  async generate(e) {
    var h, p, f, I, y, g, u, v, w;
    const t = e.prompt.trim();
    if (!t)
      return { text: "", model: this.settings.http.model };
    const r = new AbortController(), a = () => {
      var A;
      return r.abort((A = e.signal) == null ? void 0 : A.reason);
    };
    (h = e.signal) != null && h.aborted ? a() : (p = e.signal) == null || p.addEventListener("abort", a, { once: !0 });
    let s = !1;
    const i = Math.max(1e3, e.timeoutMs ?? this.settings.http.timeoutMs), o = setTimeout(() => {
      s = !0, r.abort();
    }, i), c = this.settings.http.apiMode ?? "chat-completions", d = c === "responses" ? {
      model: this.settings.http.model,
      ...e.systemPrompt ? { instructions: e.systemPrompt } : {},
      input: t,
      max_output_tokens: e.maxTokens ?? this.settings.http.maxTokens,
      temperature: e.temperature ?? this.settings.http.temperature,
      stream: !0
    } : {
      model: this.settings.http.model,
      messages: [
        ...e.systemPrompt ? [{ role: "system", content: e.systemPrompt }] : [],
        { role: "user", content: t }
      ],
      max_tokens: e.maxTokens ?? this.settings.http.maxTokens,
      temperature: e.temperature ?? this.settings.http.temperature
    }, l = an(
      this.settings.http.baseUrl,
      c === "responses" ? "responses" : "chat/completions"
    ), m = Date.now();
    try {
      $("INFO", "HttpProvider.generate.request", "AI text generation request", {
        url: l,
        timeoutMs: i,
        body: ve(cn(d))
      });
      const A = await hr(l, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.http.apiKey}`,
          "Content-Type": "application/json",
          ...c === "responses" ? { Accept: "text/event-stream" } : {}
        },
        body: JSON.stringify(d),
        signal: r.signal
      }), T = A.headers.get("content-type") || "";
      if (A.ok && c === "responses" && T.includes("text/event-stream")) {
        const L = await hs(A);
        if ($("INFO", "HttpProvider.generate.response", "AI text generation stream completed", {
          url: l,
          status: A.status,
          elapsedMs: Date.now() - m,
          responseId: L.responseId,
          model: L.model,
          eventCount: L.eventCount,
          outputChars: L.text.length
        }), !L.text)
          throw new Error("Responses stream completed without output text");
        return {
          text: L.text,
          model: L.model || this.settings.http.model
        };
      }
      const E = await A.text(), C = sn(E);
      if ($("INFO", "HttpProvider.generate.response", "AI text generation response", {
        url: l,
        status: A.status,
        elapsedMs: Date.now() - m,
        contentType: T,
        outputChars: E.length,
        responsePreview: E.slice(0, 1e3)
      }), !A.ok) {
        const L = fs(A, E, C);
        throw $("WARN", "HttpProvider.generate.rejected", "AI text generation rejected", {
          url: l,
          status: A.status,
          diagnosticMessage: L
        }), ps(A);
      }
      const _ = ((y = (I = (f = C == null ? void 0 : C.choices) == null ? void 0 : f[0]) == null ? void 0 : I.message) == null ? void 0 : y.content) || (C == null ? void 0 : C.output_text) || oa(C) || ((u = (g = C == null ? void 0 : C.content) == null ? void 0 : g[0]) == null ? void 0 : u.text) || "";
      return {
        text: typeof _ == "string" ? _ : JSON.stringify(_),
        model: (C == null ? void 0 : C.model) || this.settings.http.model
      };
    } catch (A) {
      throw Se("HttpProvider.generate.error", A, {
        url: l,
        elapsedMs: Date.now() - m,
        didTimeout: s,
        requestBody: ve(cn(d))
      }), (v = e.signal) != null && v.aborted && !s ? new k("CANCELLED", "AI request cancelled", void 0, { retryable: !1 }) : s || (A == null ? void 0 : A.name) === "AbortError" ? new k(
        "PROVIDER_TIMEOUT",
        "模型请求超时。",
        void 0,
        { retryable: !0, timeoutMs: i }
      ) : A instanceof k ? A : new k(
        "NETWORK_ERROR",
        "无法连接模型服务。",
        void 0,
        { retryable: !0 }
      );
    } finally {
      clearTimeout(o), (w = e.signal) == null || w.removeEventListener("abort", a);
    }
  }
  async generateImage(e) {
    var l, m;
    const t = e.prompt.trim();
    if (!t)
      return {};
    const r = new AbortController();
    let a = !1;
    const s = Math.max(1e3, this.settings.http.timeoutMs), i = setTimeout(() => {
      a = !0, r.abort();
    }, s), o = {
      model: e.model || this.settings.http.model,
      prompt: t,
      size: e.size || "1024x1024",
      output_format: e.outputFormat || "png",
      watermark: e.watermark ?? !0
    }, c = an(this.settings.http.baseUrl, "images/generations"), d = Date.now();
    try {
      $("INFO", "HttpProvider.generateImage.request", "AI image generation request", {
        url: c,
        timeoutMs: s,
        body: ve(o)
      });
      const h = await hr(c, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.http.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(o),
        signal: r.signal
      }), p = await h.text(), f = sn(p);
      if ($("INFO", "HttpProvider.generateImage.response", "AI image generation response", {
        url: c,
        status: h.status,
        elapsedMs: Date.now() - d,
        text: p
      }), !h.ok)
        throw new Error(((l = f == null ? void 0 : f.error) == null ? void 0 : l.message) || `HTTP ${h.status}: ${p.slice(0, 300)}`);
      const I = ((m = f == null ? void 0 : f.data) == null ? void 0 : m[0]) || {};
      return {
        imageUrl: I.url,
        imageBase64: I.b64_json,
        mimeType: "image/png"
      };
    } catch (h) {
      throw Se("HttpProvider.generateImage.error", h, {
        url: c,
        elapsedMs: Date.now() - d,
        didTimeout: a,
        requestBody: ve(o)
      }), a || (h == null ? void 0 : h.name) === "AbortError" ? new Error(`HTTP request timeout after ${s}ms`) : new Error(`HTTP request failed: ${on(h)} | url=${c}`);
    } finally {
      clearTimeout(i);
    }
  }
}
const ae = "[Summary]", da = {
  summaryMode: "local",
  summaryTriggerPolicy: "manual",
  summaryDebounceMs: 3e4,
  summaryMinIntervalMs: 18e4,
  summaryMinWordDelta: 120,
  summaryFinalizeStableMs: 6e5,
  summaryFinalizeMinWords: 1200,
  recentChapterRawCount: 2
}, pt = {
  providerType: "http",
  http: {
    apiMode: "chat-completions",
    baseUrl: "",
    apiKey: "",
    model: "gpt-4.1-mini",
    imageModel: "doubao-seedream-5-0-260128",
    imageSize: "2K",
    imageOutputFormat: "png",
    imageWatermark: !1,
    timeoutMs: 6e4,
    maxTokens: 4096,
    contextWindowTokens: 0,
    temperature: 0.7
  },
  mcpCli: {
    cliPath: "",
    argsTemplate: "",
    workingDir: "",
    envJson: "{}",
    startupTimeoutMs: 6e4,
    contextWindowTokens: 0
  },
  proxy: {
    mode: "system",
    httpProxy: "",
    httpsProxy: "",
    allProxy: "",
    noProxy: ""
  },
  summary: da,
  embedding: {
    enabled: !1,
    baseUrl: "",
    apiKey: "",
    model: "bge-large-zh-v1.5",
    dimensions: 1024,
    batchSize: 8,
    timeoutMs: 6e4,
    fallbackToHash: !0
  }
}, mr = /* @__PURE__ */ new Map(), xt = /* @__PURE__ */ new Map(), fr = /* @__PURE__ */ new Map(), pr = /* @__PURE__ */ new Map();
let dn = !1, Kt = null;
function gs(n) {
  Kt = n;
}
function Dr(n, e, t) {
  try {
    Kt == null || Kt(n, e, t);
  } catch (r) {
    console.warn(`${ae} failed to notify RAG summary index refresh:`, r);
  }
}
function Is(n) {
  if (!(n != null && n.trim()))
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (a) => {
      !a || typeof a != "object" || (typeof a.text == "string" && t.push(a.text), Array.isArray(a.children) && a.children.forEach(r));
    };
    return r((e == null ? void 0 : e.root) || e), t.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return n.replace(/\s+/g, " ").trim();
  }
}
function vs(n) {
  return n ? n.split(/[。！？!?]/).map((t) => t.trim()).filter(Boolean).slice(0, 5).map((t, r) => `fact_${r + 1}: ${t.slice(0, 80)}`) : [];
}
function ys(n) {
  return n ? n.split(/[。！？!?]/).map((e) => e.trim()).filter((e) => e.includes("？") || e.includes("?")).slice(0, 5) : [];
}
function ws(n, e, t, r) {
  const a = Number.isFinite(e) ? `第${e}章` : "章节", s = r.length > 0 ? r.join(" | ") : "无明显关键事实";
  return `${a}《${n || "未命名章节"}》摘要：${t}
关键事实：${s}`;
}
function ln(n) {
  if (typeof n != "string" || !n.trim())
    return [];
  try {
    const e = JSON.parse(n);
    return Array.isArray(e) ? e.map((t) => String(t || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function Ss(n) {
  return be("sha256").update(n.join("|")).digest("hex");
}
function As(n, e, t) {
  const r = n === "volume" ? `卷级摘要（覆盖${e}章）` : `全书摘要（覆盖${e}章）`, a = t.map((s, i) => `${i + 1}. ${s}`).join(`
`);
  return `${r}
${a}`.slice(0, 2400);
}
function Es() {
  return D.join(j.getPath("userData"), "ai-settings.json");
}
function la() {
  try {
    const n = Es();
    if (!re.existsSync(n))
      return pt;
    const e = re.readFileSync(n, "utf8"), t = JSON.parse(e);
    return {
      ...pt,
      ...t,
      http: { ...pt.http, ...t.http ?? {} },
      mcpCli: { ...pt.mcpCli, ...t.mcpCli ?? {} },
      proxy: { ...pt.proxy, ...t.proxy ?? {} },
      summary: { ...da, ...t.summary ?? {} }
    };
  } catch (n) {
    return console.warn(`${ae} failed to load ai-settings.json, fallback to defaults:`, n), pt;
  }
}
async function un(n, e) {
  return {
    summaryText: n.slice(0, 220) || "章节内容为空，暂无可提炼摘要。",
    keyFacts: vs(n),
    openQuestions: ys(n),
    timelineHints: [`chapter_order:${e ?? "unknown"}`],
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
async function Ts(n, e, t, r) {
  var m, h;
  if (!(t.providerType === "http" && !!((m = t.http.baseUrl) != null && m.trim()) && !!((h = t.http.apiKey) != null && h.trim())))
    throw new Error("AI summary mode requires HTTP provider with baseUrl and apiKey");
  console.log(`${ae} [${n}] AI summary start (model=${t.http.model})`);
  const s = new ca(t), i = Date.now(), o = await s.generate({
    systemPrompt: [
      "You summarize novel chapters for continuity memory.",
      "Return strict JSON only.",
      'Schema: {"summaryText":"...","keyFacts":["..."],"openQuestions":["..."],"timelineHints":["..."]}'
    ].join(" "),
    prompt: JSON.stringify({
      task: "chapter_memory_summary",
      chapterOrder: r,
      content: e.slice(0, 8e3),
      constraints: [
        "summaryText should be concise and neutral",
        "keyFacts at most 6 items",
        "openQuestions at most 4 items"
      ]
    }),
    maxTokens: Math.min(1024, t.http.maxTokens),
    temperature: Math.min(0.3, t.http.temperature)
  }), c = JSON.parse(o.text || "{}"), d = String(c.summaryText || "").trim();
  if (!d)
    throw new Error("AI summary returned empty summaryText");
  const l = Date.now() - i;
  return console.log(`${ae} [${n}] AI summary success (${l}ms)`), {
    summaryText: d.slice(0, 400),
    keyFacts: Array.isArray(c.keyFacts) ? c.keyFacts.map((p) => String(p).trim()).filter(Boolean).slice(0, 6) : [],
    openQuestions: Array.isArray(c.openQuestions) ? c.openQuestions.map((p) => String(p).trim()).filter(Boolean).slice(0, 4) : [],
    timelineHints: Array.isArray(c.timelineHints) ? c.timelineHints.map((p) => String(p).trim()).filter(Boolean).slice(0, 6) : [`chapter_order:${r ?? "unknown"}`],
    provider: "http",
    model: t.http.model,
    promptVersion: "chapter-summary-ai-v1",
    temperature: Math.min(0.3, t.http.temperature),
    maxTokens: Math.min(1024, t.http.maxTokens),
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: l
  };
}
async function hn(n, e, t) {
  const r = n === "volume" ? { novelId: e, volumeId: t || "", isLatest: !0, status: "active" } : { novelId: e, isLatest: !0, status: "active" }, a = await S.chapterSummary.findMany({
    where: r,
    select: {
      id: !0,
      chapterId: !0,
      chapterOrder: !0,
      updatedAt: !0,
      summaryText: !0,
      keyFacts: !0,
      openQuestions: !0
    },
    orderBy: [
      { chapterOrder: "asc" },
      { updatedAt: "asc" }
    ],
    take: n === "volume" ? 120 : 300
  });
  if (a.length === 0)
    return null;
  const s = a.map((y) => y.chapterId), i = a.map((y) => Number(y.chapterOrder)).filter((y) => Number.isFinite(y)), o = i.length > 0 ? Math.min(...i) : null, c = i.length > 0 ? Math.max(...i) : null, d = a.map((y) => String(y.summaryText || "").trim()).filter(Boolean).slice(-10), l = [...new Set(
    a.flatMap((y) => ln(y.keyFacts))
  )].map((y) => String(y || "").slice(0, 120)).filter(Boolean).slice(0, 24), m = [...new Set(
    a.flatMap((y) => ln(y.openQuestions))
  )].map((y) => String(y || "").slice(0, 120)).filter(Boolean).slice(0, 20), h = [
    n === "volume" ? "保持本卷叙事风格一致" : "保持全书叙事风格一致",
    "优先遵循现有大纲与关键事实"
  ], p = [
    "不得与已确认关键事实冲突",
    "保持角色动机与关系连续"
  ], f = Ss(
    a.map((y) => `${y.id}:${new Date(y.updatedAt).toISOString()}`)
  );
  let I = null;
  if (n === "volume" && t) {
    const y = await S.volume.findUnique({
      where: { id: t },
      select: { title: !0 }
    });
    I = (y == null ? void 0 : y.title) || null;
  }
  return {
    title: I,
    summaryText: As(n, s.length, d),
    keyFacts: l,
    unresolvedThreads: m,
    styleGuide: h,
    hardConstraints: p,
    coverageChapterIds: s,
    chapterRangeStart: o,
    chapterRangeEnd: c,
    sourceFingerprint: f
  };
}
async function mn(n, e, t, r) {
  return S.$transaction(async (a) => {
    await a.narrativeSummary.updateMany({
      where: {
        novelId: e,
        level: n,
        volumeId: n === "volume" && r || null,
        isLatest: !0
      },
      data: {
        isLatest: !1,
        status: "stale"
      }
    });
    const s = await a.narrativeSummary.findFirst({
      where: {
        novelId: e,
        level: n,
        volumeId: n === "volume" && r || null,
        sourceFingerprint: t.sourceFingerprint
      }
    }), i = {
      novelId: e,
      volumeId: n === "volume" && r || null,
      level: n,
      title: t.title || null,
      summaryText: t.summaryText,
      keyFacts: JSON.stringify(t.keyFacts),
      unresolvedThreads: JSON.stringify(t.unresolvedThreads),
      styleGuide: JSON.stringify(t.styleGuide),
      hardConstraints: JSON.stringify(t.hardConstraints),
      coverageChapterIds: JSON.stringify(t.coverageChapterIds),
      chapterRangeStart: t.chapterRangeStart,
      chapterRangeEnd: t.chapterRangeEnd,
      sourceFingerprint: t.sourceFingerprint,
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
      isLatest: !0
    };
    return s != null && s.id ? (await a.narrativeSummary.update({
      where: { id: s.id },
      data: i
    })).id : (await a.narrativeSummary.create({ data: i })).id;
  });
}
async function Cs(n, e) {
  try {
    const [t, r] = await Promise.all([
      hn("volume", n, e),
      hn("novel", n, null)
    ]);
    if (t) {
      const a = await mn("volume", n, t, e);
      console.log(`${ae} [novel=${n}] narrative summary updated (level=volume, volume=${e})`), a && Dr("narrativeSummary", a, "narrative-summary-volume");
    }
    if (r) {
      const a = await mn("novel", n, r, null);
      console.log(`${ae} [novel=${n}] narrative summary updated (level=novel)`), a && Dr("narrativeSummary", a, "narrative-summary-novel");
    }
  } catch (t) {
    console.error(`${ae} [novel=${n}] narrative summary rebuild failed:`, t);
  }
}
function Ns(n, e) {
  const t = `${n}:${e}`, r = pr.get(t);
  r && clearTimeout(r);
  const a = setTimeout(() => {
    pr.delete(t), Cs(n, e);
  }, 15e3);
  pr.set(t, a);
}
async function gr(n, e) {
  var v;
  const t = la(), r = !!(e != null && e.force), a = (e == null ? void 0 : e.reason) || "save", s = t.summary.summaryMode === "ai", i = s ? Math.max(18e5, t.summary.summaryMinIntervalMs) : t.summary.summaryMinIntervalMs, o = s ? Math.max(800, t.summary.summaryMinWordDelta) : t.summary.summaryMinWordDelta, c = await S.chapter.findUnique({
    where: { id: n },
    select: {
      id: !0,
      title: !0,
      content: !0,
      wordCount: !0,
      order: !0,
      updatedAt: !0,
      volumeId: !0,
      volume: { select: { novelId: !0 } }
    }
  });
  if (!((v = c == null ? void 0 : c.volume) != null && v.novelId)) {
    console.log(`${ae} [${n}] skip: chapter or novel relation missing`);
    return;
  }
  if (!dn)
    try {
      const w = await S.$queryRawUnsafe("PRAGMA database_list;"), A = Array.isArray(w) ? w.find((T) => (T == null ? void 0 : T.name) === "main") : null;
      console.log(`${ae} sqlite main db path: ${(A == null ? void 0 : A.file) || "unknown"}`);
    } catch {
      console.warn(`${ae} failed to read sqlite db path via PRAGMA database_list`);
    } finally {
      dn = !0;
    }
  const d = c.content || "", l = be("sha256").update(d).digest("hex"), m = Date.now(), h = await S.chapterSummary.findFirst({
    where: {
      chapterId: c.id,
      isLatest: !0,
      status: "active",
      summaryType: "standard"
    },
    orderBy: { updatedAt: "desc" }
  });
  if (!r && (h == null ? void 0 : h.sourceContentHash) === l) {
    console.log(`${ae} [${n}] skip: same content hash`);
    return;
  }
  const p = Math.abs((c.wordCount || 0) - Number((h == null ? void 0 : h.sourceWordCount) || 0)), f = h != null && h.updatedAt ? new Date(h.updatedAt).getTime() : 0, I = f > 0 ? m - f : Number.MAX_SAFE_INTEGER;
  if (!r && f > 0 && I < i && p < o) {
    console.log(
      `${ae} [${n}] skip: throttled (deltaWords=${p}, sinceLastMs=${I}, minIntervalMs=${i}, minWordDelta=${o})`
    );
    return;
  }
  const y = Is(d);
  console.log(
    `${ae} [${n}] start rebuild (reason=${a}, mode=${t.summary.summaryMode}, words=${c.wordCount || y.length}, deltaWords=${p}, force=${r})`
  );
  let g = await un(y, c.order ?? null);
  if (t.summary.summaryMode === "ai")
    try {
      g = await Ts(n, y, t, c.order ?? null);
    } catch (w) {
      console.warn(`${ae} [${n}] AI summary failed, fallback to local: ${(w == null ? void 0 : w.message) || "unknown error"}`), g = {
        ...await un(y, c.order ?? null),
        errorCode: "AI_SUMMARY_FALLBACK",
        errorDetail: (w == null ? void 0 : w.message) || "unknown ai summary error"
      };
    }
  const u = await S.$transaction(async (w) => {
    await w.chapterSummary.updateMany({
      where: { chapterId: c.id, isLatest: !0 },
      data: { isLatest: !1, status: "stale" }
    });
    const A = await w.chapterSummary.findFirst({
      where: {
        chapterId: c.id,
        sourceContentHash: l,
        summaryType: "standard"
      }
    }), T = {
      novelId: c.volume.novelId,
      volumeId: c.volumeId,
      chapterId: c.id,
      summaryType: "standard",
      summaryText: g.summaryText,
      compressedMemory: ws(c.title || "", c.order ?? null, g.summaryText, g.keyFacts),
      keyFacts: JSON.stringify(g.keyFacts),
      entitiesSnapshot: JSON.stringify({}),
      timelineHints: JSON.stringify(g.timelineHints),
      openQuestions: JSON.stringify(g.openQuestions),
      sourceContentHash: l,
      sourceWordCount: c.wordCount || y.length,
      sourceUpdatedAt: c.updatedAt,
      chapterOrder: c.order ?? null,
      provider: g.provider,
      model: g.model,
      promptVersion: g.promptVersion,
      temperature: g.temperature,
      maxTokens: g.maxTokens,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      latencyMs: g.latencyMs,
      qualityScore: null,
      status: "active",
      errorCode: g.errorCode || null,
      errorDetail: g.errorDetail || null,
      isLatest: !0
    };
    if (A != null && A.id) {
      const C = await w.chapterSummary.update({
        where: { id: A.id },
        data: T
      });
      return console.log(`${ae} [${n}] done: updated existing summary`), C.id;
    }
    const E = await w.chapterSummary.create({
      data: T
    });
    return console.log(`${ae} [${n}] done: created new summary`), E.id;
  });
  u && Dr("chapterSummary", u, "chapter-summary"), Ns(c.volume.novelId, c.volumeId);
}
function st(n, e = "save") {
  const t = la();
  if (e === "manual") {
    console.log(`${ae} [${n}] manual trigger received`), gr(n, { force: !0, reason: "manual" }).catch((o) => {
      console.error(`${ae} [${n}] manual rebuild failed:`, o);
    });
    return;
  }
  if (t.summary.summaryMode === "ai" && t.summary.summaryTriggerPolicy === "manual") {
    console.log(`${ae} [${n}] skip scheduling: ai mode manual-only policy`);
    return;
  }
  if (t.summary.summaryMode === "ai" && t.summary.summaryTriggerPolicy === "finalized") {
    const o = Math.max(6e4, t.summary.summaryFinalizeStableMs), c = fr.get(n);
    c && clearTimeout(c);
    const d = setTimeout(async () => {
      fr.delete(n);
      const l = await S.chapter.findUnique({
        where: { id: n },
        select: { wordCount: !0 }
      }), m = (l == null ? void 0 : l.wordCount) || 0;
      if (m < t.summary.summaryFinalizeMinWords) {
        console.log(
          `${ae} [${n}] finalized trigger skipped (wordCount=${m}, min=${t.summary.summaryFinalizeMinWords})`
        );
        return;
      }
      console.log(`${ae} [${n}] finalized trigger fired after stable window ${o}ms`), gr(n, { force: !0, reason: "finalized" }).catch((h) => {
        console.error(`${ae} [${n}] finalized rebuild failed:`, h);
      });
    }, o);
    fr.set(n, d), console.log(`${ae} [${n}] finalized trigger scheduled (${o}ms stable window)`);
    return;
  }
  const r = t.summary.summaryMode === "ai", a = Math.max(r ? 3e5 : 1e3, t.summary.summaryDebounceMs), s = mr.get(n);
  if (r) {
    if (s) {
      const o = (xt.get(n) || 0) + 1;
      xt.set(n, o), o % 10 === 0 && console.log(`${ae} [${n}] ai mode coalescing saves (${o} updates queued, timer unchanged)`);
      return;
    }
    xt.set(n, 1), console.log(`${ae} [${n}] ai mode scheduled (${a}ms, fixed window)`);
  } else
    s ? (clearTimeout(s), console.log(`${ae} [${n}] debounce reset (${a}ms)`)) : console.log(`${ae} [${n}] debounce scheduled (${a}ms)`);
  const i = setTimeout(() => {
    mr.delete(n);
    const o = xt.get(n) || 0;
    xt.delete(n), console.log(r ? `${ae} [${n}] ai mode fired after coalescing ${o} saves` : `${ae} [${n}] debounce fired, evaluating rebuild`), gr(n).catch((c) => {
      console.error(`${ae} [${n}] rebuild failed:`, c);
    });
  }, a);
  mr.set(n, i);
}
function bs(n) {
  return [
    {
      actionId: "novel.list",
      title: "List novels",
      description: "Return novels sorted by update time.",
      permission: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "array" },
      handler: async () => S.novel.findMany({ orderBy: { updatedAt: "desc" } })
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId))
          throw new k("INVALID_INPUT", "novelId is required");
        return S.volume.findMany({
          where: { novelId: t.novelId },
          include: {
            chapters: {
              select: { id: !0, title: !0, order: !0, wordCount: !0, updatedAt: !0 },
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
      handler: async (e) => {
        var a;
        const t = e, r = ((a = t == null ? void 0 : t.title) == null ? void 0 : a.trim()) || `新作品 ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`;
        return S.novel.create({
          data: {
            title: r,
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
          volumeId: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
          includeContent: { type: "boolean" }
        },
        required: ["volumeId"]
      },
      outputSchema: { type: "array" },
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.volumeId))
          throw new k("INVALID_INPUT", "volumeId is required");
        if (!(Number.isFinite(t.offset) || Number.isFinite(t.limit) || t.includeContent === !1))
          return S.chapter.findMany({
            where: { volumeId: t.volumeId },
            orderBy: { order: "asc" }
          });
        const a = Math.max(0, Math.floor(t.offset ?? 0)), s = Math.max(1, Math.min(20, Math.floor(t.limit ?? 20)));
        return t.includeContent === !1 ? S.chapter.findMany({
          where: { volumeId: t.volumeId },
          select: {
            id: !0,
            volumeId: !0,
            title: !0,
            order: !0,
            wordCount: !0,
            updatedAt: !0
          },
          orderBy: { order: "asc" },
          skip: a,
          take: s
        }) : S.chapter.findMany({
          where: { volumeId: t.volumeId },
          orderBy: { order: "asc" },
          skip: a,
          take: s
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
      handler: async (e) => {
        var a;
        const t = e;
        if (!(t != null && t.volumeId))
          throw new k("INVALID_INPUT", "volumeId is required");
        let r = t.order;
        if (!Number.isFinite(r)) {
          const s = await S.chapter.findFirst({
            where: { volumeId: t.volumeId },
            orderBy: { order: "desc" }
          });
          r = ((s == null ? void 0 : s.order) || 0) + 1;
        }
        return S.chapter.create({
          data: {
            volumeId: t.volumeId,
            title: ((a = t.title) == null ? void 0 : a.trim()) || "",
            order: r,
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.chapterId))
          throw new k("INVALID_INPUT", "chapterId is required");
        return S.chapter.findUnique({
          where: { id: t.chapterId },
          include: { volume: { select: { novelId: !0 } } }
        });
      }
    },
    {
      actionId: "chapter.scope_context.build",
      title: "Build chapter scope context",
      description: "Resolve an approved chapter scope and return an ordered, versioned context bundle.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          scopeId: { type: "string" },
          novelId: { type: "string" },
          kind: {
            type: "string",
            enum: ["current_chapter", "selected_chapters", "chapter_range", "current_volume", "novel"]
          },
          volumeId: { type: "string" },
          chapterId: { type: "string" },
          chapterIds: { type: "array", items: { type: "string" } },
          anchorChapterId: { type: "string" },
          processingMode: { type: "string", enum: ["detailed", "batched"] },
          currentContent: { type: "string" },
          goal: { type: "string" },
          locale: { type: "string" },
          batchSize: { type: "number", minimum: 1, maximum: 10 },
          maxDetailedChapters: { type: "number", minimum: 1, maximum: 20 },
          maxEstimatedTokens: { type: "number", minimum: 4e3, maximum: 2e5 }
        },
        required: ["novelId"]
      },
      outputSchema: { type: "object" },
      handler: async (e) => n.buildChapterScopeContext(e)
    },
    {
      actionId: "chapter.continuation_context.build",
      title: "Build continuation context",
      description: "Build the ordered, layered and versioned context used by chapter continuation.",
      permission: "read",
      inputSchema: {
        type: "object",
        properties: {
          novelId: { type: "string" },
          chapterId: { type: "string" },
          currentContent: { type: "string" },
          ideaIds: { type: "array", items: { type: "string" } },
          contextChapterCount: { type: "number", minimum: 1, maximum: 20 },
          recentRawChapterCount: { type: "number", minimum: 1, maximum: 3 },
          targetLength: { type: "number", minimum: 100 },
          style: { type: "string" },
          tone: { type: "string" },
          pace: { type: "string" },
          userIntent: { type: "string" },
          currentLocation: { type: "string" },
          locale: { type: "string" }
        },
        required: ["novelId", "chapterId"]
      },
      outputSchema: { type: "object" },
      handler: async (e) => n.buildContinuationContext(e)
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.chapterId))
          throw new k("INVALID_INPUT", "chapterId is required");
        if (typeof t.content != "string")
          throw new k("INVALID_INPUT", "content is required");
        const r = t.source === "ai_ui" ? "ai_ui" : "ai_agent", a = await S.chapter.findUnique({
          where: { id: t.chapterId },
          select: { id: !0, content: !0, updatedAt: !0, wordCount: !0, volume: { select: { novelId: !0 } } }
        });
        if (!a || !a.volume)
          throw new k("NOT_FOUND", "Chapter or volume not found");
        const s = t.content.length, i = s - a.wordCount;
        try {
          const [, o] = await S.$transaction([
            S.novel.update({
              where: { id: a.volume.novelId },
              data: { wordCount: { increment: i }, updatedAt: /* @__PURE__ */ new Date() }
            }),
            S.chapter.update({
              where: { id: t.chapterId },
              data: { content: t.content, wordCount: s, updatedAt: /* @__PURE__ */ new Date() }
            })
          ]);
          return st(t.chapterId), {
            chapter: o,
            saveMeta: {
              source: r,
              rollbackPoint: {
                chapterId: a.id,
                content: a.content,
                updatedAt: a.updatedAt
              }
            }
          };
        } catch (o) {
          const c = He(o);
          throw new k("PERSISTENCE_ERROR", c.message);
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId) || !t.chapterId || typeof t.currentContent != "string")
          throw new k("INVALID_INPUT", "novelId, chapterId, currentContent are required");
        try {
          return await n.continueWriting({
            locale: t.locale,
            mode: t.mode,
            novelId: t.novelId,
            chapterId: t.chapterId,
            currentContent: t.currentContent,
            ideaIds: Array.isArray(t.ideaIds) ? t.ideaIds : void 0,
            contextChapterCount: t.contextChapterCount,
            recentRawChapterCount: t.recentRawChapterCount,
            targetLength: t.targetLength,
            style: t.style,
            tone: t.tone,
            pace: t.pace,
            temperature: t.temperature,
            userIntent: t.userIntent,
            currentLocation: t.currentLocation,
            overrideUserPrompt: t.overrideUserPrompt
          });
        } catch (r) {
          throw He(r);
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId))
          throw new k("INVALID_INPUT", "novelId is required");
        return S.plotLine.findMany({
          where: { novelId: t.novelId },
          include: {
            points: {
              include: { anchors: !0 },
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId))
          throw new k("INVALID_INPUT", "novelId is required");
        return S.worldSetting.findMany({
          where: { novelId: t.novelId },
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
      handler: async (e) => {
        const t = e, r = String((t == null ? void 0 : t.novelId) || "").trim(), a = String((t == null ? void 0 : t.name) || "").trim();
        if (!r)
          throw new k("INVALID_INPUT", "novelId is required");
        if (!a)
          throw new k("INVALID_INPUT", "name is required");
        let s = t == null ? void 0 : t.sortOrder;
        if (typeof s != "number" || !Number.isFinite(s)) {
          const d = await S.worldSetting.findFirst({
            where: { novelId: r },
            orderBy: { sortOrder: "desc" }
          });
          s = ((d == null ? void 0 : d.sortOrder) || 0) + 1;
        }
        const i = typeof (t == null ? void 0 : t.content) == "string" ? t.content : "", o = typeof (t == null ? void 0 : t.type) == "string" && t.type.trim() ? t.type.trim() : "other", c = typeof (t == null ? void 0 : t.icon) == "string" && t.icon.trim() ? t.icon.trim() : null;
        return S.worldSetting.create({
          data: {
            novelId: r,
            name: a,
            content: i,
            type: o,
            icon: c,
            sortOrder: s
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
      handler: async (e) => {
        const t = e, r = String((t == null ? void 0 : t.id) || "").trim();
        if (!r)
          throw new k("INVALID_INPUT", "id is required");
        const a = {};
        if (Object.prototype.hasOwnProperty.call(t, "name")) {
          const s = String((t == null ? void 0 : t.name) || "").trim();
          if (!s)
            throw new k("INVALID_INPUT", "name cannot be empty");
          a.name = s;
        }
        if (Object.prototype.hasOwnProperty.call(t, "content") && (a.content = typeof (t == null ? void 0 : t.content) == "string" ? t.content : ""), Object.prototype.hasOwnProperty.call(t, "type") && (a.type = typeof (t == null ? void 0 : t.type) == "string" && t.type.trim() ? t.type.trim() : "other"), Object.prototype.hasOwnProperty.call(t, "icon") && ((t == null ? void 0 : t.icon) === null ? a.icon = null : a.icon = typeof (t == null ? void 0 : t.icon) == "string" && t.icon.trim() ? t.icon.trim() : null), Object.prototype.hasOwnProperty.call(t, "sortOrder")) {
          if (typeof (t == null ? void 0 : t.sortOrder) != "number" || !Number.isFinite(t.sortOrder))
            throw new k("INVALID_INPUT", "sortOrder must be a finite number");
          a.sortOrder = t.sortOrder;
        }
        if (Object.keys(a).length === 0)
          throw new k("INVALID_INPUT", "At least one updatable field is required");
        return S.worldSetting.update({
          where: { id: r },
          data: a
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId))
          throw new k("INVALID_INPUT", "novelId is required");
        return S.character.findMany({
          where: { novelId: t.novelId },
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId))
          throw new k("INVALID_INPUT", "novelId is required");
        return S.item.findMany({
          where: { novelId: t.novelId },
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId))
          throw new Error("novelId is required");
        return S.mapCanvas.findMany({
          where: { novelId: t.novelId },
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId) || !(t != null && t.keyword))
          throw new k("INVALID_INPUT", "novelId and keyword are required");
        return Jr(t.novelId, t.keyword, t.limit ?? 20, t.offset ?? 0);
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
      handler: async (e) => {
        var r;
        const t = e;
        if (!(t != null && t.novelId) || !((r = t.question) != null && r.trim()))
          throw new k("INVALID_INPUT", "novelId and question are required");
        try {
          return await n.askNovel({
            novelId: t.novelId,
            question: t.question,
            chapterId: t.chapterId,
            currentContent: t.currentContent,
            selectedText: t.selectedText,
            currentLocation: t.currentLocation,
            locale: t.locale,
            maxEvidenceItems: t.maxEvidenceItems,
            overrideUserPrompt: t.overrideUserPrompt
          });
        } catch (a) {
          throw He(a);
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
      handler: async (e) => {
        const t = e;
        if (!(t != null && t.novelId))
          throw new k("INVALID_INPUT", "novelId is required");
        return n.rebuildRagIndex(t.novelId);
      }
    }
  ];
}
function xs(n) {
  return n.trim() ? (n.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^['"]|['"]$/g, "")) : [];
}
class fn {
  constructor(e) {
    H(this, "name", "mcp-cli");
    this.settings = e;
  }
  async healthCheck() {
    const { cliPath: e } = this.settings.mcpCli;
    if (!e.trim())
      return { ok: !1, detail: "MCP CLI path is empty" };
    if (!re.existsSync(e))
      return { ok: !1, detail: "MCP CLI path does not exist" };
    try {
      $("INFO", "McpCliProvider.healthCheck.request", "MCP CLI health check request", {
        cliPath: e,
        timeoutMs: this.settings.mcpCli.startupTimeoutMs
      });
      const { stdout: t } = await this.runProcess(["--version"], "", this.settings.mcpCli.startupTimeoutMs);
      return $("INFO", "McpCliProvider.healthCheck.response", "MCP CLI health check response", {
        cliPath: e,
        stdout: t
      }), { ok: !0, detail: (t || "MCP CLI is executable").slice(0, 200) };
    } catch (t) {
      return Se("McpCliProvider.healthCheck.error", t, { cliPath: e }), { ok: !1, detail: `MCP CLI check failed: ${(t == null ? void 0 : t.message) || "unknown error"}` };
    }
  }
  async generate(e) {
    const t = e.prompt.trim();
    if (!t)
      return { text: "", model: "mcp-cli" };
    const r = this.settings.mcpCli.argsTemplate || "", a = r.includes("{prompt}"), s = xs(r.replace("{prompt}", t));
    $("INFO", "McpCliProvider.generate.request", "MCP CLI generate request", {
      cliPath: this.settings.mcpCli.cliPath,
      args: s,
      prompt: a ? "" : t,
      promptEmbeddedInArgs: a
    });
    const { stdout: i } = await this.runProcess(s, a ? "" : t, this.settings.mcpCli.startupTimeoutMs, e.signal);
    return $("INFO", "McpCliProvider.generate.response", "MCP CLI generate response", {
      cliPath: this.settings.mcpCli.cliPath,
      stdout: i
    }), {
      text: i.trim(),
      model: "mcp-cli"
    };
  }
  async runProcess(e, t, r, a) {
    const { cliPath: s, workingDir: i, envJson: o } = this.settings.mcpCli, c = this.parseEnvJson(o), d = Date.now();
    return new Promise((l, m) => {
      const h = jr(s, e, {
        cwd: i || process.cwd(),
        env: { ...process.env, ...c },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: !0
      });
      let p = "", f = "", I = !1;
      const y = () => a == null ? void 0 : a.removeEventListener("abort", g), g = () => {
        I || (I = !0, clearTimeout(u), h.kill("SIGTERM"), y(), m(new Error("AI request cancelled")));
      }, u = setTimeout(() => {
        I || (I = !0, h.kill("SIGTERM"), y(), $("ERROR", "McpCliProvider.runProcess.timeout", "MCP CLI process timeout", {
          cliPath: s,
          args: e,
          elapsedMs: Date.now() - d
        }), m(new Error("MCP CLI process timeout")));
      }, Math.max(1e3, r));
      a != null && a.aborted ? g() : a == null || a.addEventListener("abort", g, { once: !0 }), h.stdout.on("data", (v) => {
        p += v.toString();
      }), h.stderr.on("data", (v) => {
        f += v.toString();
      }), h.on("error", (v) => {
        I || (I = !0, clearTimeout(u), y(), Se("McpCliProvider.runProcess.error", v, {
          cliPath: s,
          args: e,
          elapsedMs: Date.now() - d,
          env: ve(c)
        }), m(v));
      }), h.on("close", (v) => {
        if (!I) {
          if (I = !0, clearTimeout(u), y(), v !== 0) {
            $("ERROR", "McpCliProvider.runProcess.exit", "MCP CLI exited with non-zero code", {
              cliPath: s,
              args: e,
              code: v,
              elapsedMs: Date.now() - d,
              stderr: f
            }), m(new Error(`MCP CLI exited with code ${v}: ${f.slice(0, 300)}`));
            return;
          }
          $("INFO", "McpCliProvider.runProcess.exit", "MCP CLI process completed", {
            cliPath: s,
            args: e,
            code: v,
            elapsedMs: Date.now() - d,
            stderr: f
          }), l({ stdout: p, stderr: f });
        }
      }), t && h.stdin.write(t), h.stdin.end();
    });
  }
  parseEnvJson(e) {
    if (!e.trim())
      return {};
    try {
      const t = JSON.parse(e);
      if (!t || typeof t != "object")
        return {};
      const r = {};
      for (const [a, s] of Object.entries(t))
        r[a] = String(s ?? "");
      return r;
    } catch {
      return {};
    }
  }
}
function Ne(n) {
  const e = String(n || "").trim();
  if (!e)
    return null;
  try {
    const t = JSON.parse(e);
    if (t && typeof t == "object" && !Array.isArray(t))
      return t;
  } catch {
  }
  for (let t = e.indexOf("{"); t >= 0; t = e.indexOf("{", t + 1)) {
    let r = 0, a = !1, s = !1;
    for (let i = t; i < e.length; i += 1) {
      const o = e[i];
      if (a) {
        s ? s = !1 : o === "\\" ? s = !0 : o === '"' && (a = !1);
        continue;
      }
      if (o === '"') {
        a = !0;
        continue;
      }
      if (o === "{" && (r += 1), o === "}" && (r -= 1, r === 0))
        try {
          const c = JSON.parse(e.slice(t, i + 1));
          if (c && typeof c == "object" && !Array.isArray(c))
            return c;
        } catch {
          break;
        }
    }
  }
  return null;
}
const zr = {
  plotLine: {
    id: !0,
    novelId: !0,
    name: !0,
    description: !0,
    color: !0,
    sortOrder: !0,
    createdAt: !0,
    updatedAt: !0
  },
  plotPoint: {
    id: !0,
    novelId: !0,
    plotLineId: !0,
    title: !0,
    description: !0,
    type: !0,
    status: !0,
    icon: !0,
    order: !0,
    createdAt: !0,
    updatedAt: !0
  },
  character: {
    id: !0,
    novelId: !0,
    name: !0,
    role: !0,
    avatar: !0,
    fullBodyImages: !0,
    description: !0,
    profile: !0,
    sortOrder: !0,
    isStarred: !0,
    createdAt: !0,
    updatedAt: !0
  },
  item: {
    id: !0,
    novelId: !0,
    name: !0,
    type: !0,
    icon: !0,
    description: !0,
    profile: !0,
    sortOrder: !0,
    createdAt: !0,
    updatedAt: !0
  },
  mapCanvas: {
    id: !0,
    novelId: !0,
    name: !0,
    type: !0,
    description: !0,
    background: !0,
    width: !0,
    height: !0,
    sortOrder: !0,
    createdAt: !0,
    updatedAt: !0
  }
};
function Or(n) {
  return n instanceof Date ? n.toISOString() : Array.isArray(n) ? n.map(Or) : !n || typeof n != "object" ? n : Object.fromEntries(
    Object.entries(n).sort(([e], [t]) => e.localeCompare(t)).map(([e, t]) => [e, Or(t)])
  );
}
function ua(n, e) {
  const t = Object.fromEntries(
    Object.keys(zr[n]).map((r) => [r, e[r] ?? null])
  );
  return be("sha256").update(JSON.stringify(Or(t)), "utf8").digest("hex");
}
function tt(n, e) {
  return {
    kind: n,
    entityId: String(e.id || ""),
    afterHash: ua(n, e),
    ...n === "mapCanvas" && typeof e.background == "string" && e.background ? { backgroundPath: e.background } : {}
  };
}
function ha(n, e) {
  return Object.assign(new Error(n), { code: "VERSION_CONFLICT", details: e });
}
function Ye(n, e) {
  return n.filter((t) => t.kind === e).map((t) => t.entityId);
}
async function _s(n, e, t, r) {
  const a = t.filter((o) => o.kind === r);
  if (!a.length)
    return [];
  const s = await n[r].findMany({
    where: { id: { in: a.map((o) => o.entityId) }, novelId: e },
    select: zr[r]
  }), i = new Map(
    s.map((o) => [String(o.id), o])
  );
  for (const o of a) {
    const c = i.get(o.entityId);
    if (!c || ua(r, c) !== o.afterHash)
      throw ha("素材已在入库后发生变化，无法安全撤销", {
        kind: r,
        entityId: o.entityId
      });
  }
  return s;
}
async function Rs(n, e) {
  const t = Ye(e, "plotLine"), r = Ye(e, "plotPoint"), a = Ye(e, "character"), s = Ye(e, "item"), i = Ye(e, "mapCanvas"), o = new Set(r), [c, d, l, m, h, p, f] = await Promise.all([
    t.length ? n.plotPoint.findMany({ where: { plotLineId: { in: t } }, select: { id: !0 } }) : [],
    r.length ? n.plotPointAnchor.count({ where: { plotPointId: { in: r } } }) : 0,
    a.length ? n.itemOwnership.count({ where: { characterId: { in: a } } }) : 0,
    s.length ? n.itemOwnership.count({ where: { itemId: { in: s } } }) : 0,
    a.length ? n.relationship.count({
      where: {
        OR: [
          { sourceId: { in: a } },
          { targetId: { in: a } }
        ]
      }
    }) : 0,
    a.length || i.length ? n.characterMapMarker.count({
      where: {
        OR: [
          ...a.length ? [{ characterId: { in: a } }] : [],
          ...i.length ? [{ mapId: { in: i } }] : []
        ]
      }
    }) : 0,
    i.length ? n.mapElement.count({ where: { mapId: { in: i } } }) : 0
  ]);
  if (c.some((y) => !o.has(y.id)) || d > 0 || l > 0 || m > 0 || h > 0 || p > 0 || f > 0)
    throw ha("素材已在入库后建立新的关联，无法安全撤销");
}
async function Ds(n, e, t) {
  if (t.mode !== "creative_assets" || t.status !== "committed" || !t.creativeAssets)
    throw Object.assign(new Error("Creative assets writeback is not undoable"), { code: "INVALID_STATE" });
  const r = t.creativeAssets.entities;
  if (!r.length)
    throw Object.assign(new Error("Creative assets writeback has no entity snapshots"), { code: "INVALID_STATE" });
  if (new Set(r.map((l) => `${l.kind}:${l.entityId}`)).size !== r.length || r.some((l) => !l.entityId || !l.afterHash))
    throw Object.assign(new Error("Creative assets writeback snapshots are invalid"), { code: "INVALID_STATE" });
  await Promise.all(Object.keys(zr).map((l) => _s(n, e, r, l))), await Rs(n, r);
  const s = Ye(r, "plotPoint"), i = Ye(r, "plotLine"), o = Ye(r, "character"), c = Ye(r, "item"), d = Ye(r, "mapCanvas");
  return s.length && await n.plotPoint.deleteMany({ where: { id: { in: s }, novelId: e } }), i.length && await n.plotLine.deleteMany({ where: { id: { in: i }, novelId: e } }), o.length && await n.character.deleteMany({ where: { id: { in: o }, novelId: e } }), c.length && await n.item.deleteMany({ where: { id: { in: c }, novelId: e } }), d.length && await n.mapCanvas.deleteMany({ where: { id: { in: d }, novelId: e } }), {
    backgroundPaths: r.flatMap((l) => l.backgroundPath ? [l.backgroundPath] : [])
  };
}
function Bt(n) {
  const e = /* @__PURE__ */ new Set(), t = [];
  for (const r of n) {
    const a = String(r || "").trim();
    if (!a)
      continue;
    const s = a.toLowerCase();
    e.has(s) || (e.add(s), t.push(a));
  }
  return t;
}
function Ft(n) {
  if (!(n != null && n.trim()))
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (a) => {
      !a || typeof a != "object" || (typeof a.text == "string" && t.push(a.text), Array.isArray(a.children) && a.children.forEach(r));
    };
    return r((e == null ? void 0 : e.root) || e), t.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return n.replace(/\s+/g, " ").trim();
  }
}
function Ir(n) {
  const e = (n.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length, t = n.length - e;
  return Math.ceil(e * 1.5 + t * 0.4);
}
function Os(n) {
  return be("sha256").update(n || "", "utf8").digest("hex");
}
function qt(n, e = 50) {
  if (Array.isArray(n))
    return n.slice(0, e);
  if (typeof n != "string" || !n.trim())
    return [];
  try {
    const t = JSON.parse(n);
    return Array.isArray(t) ? t.slice(0, e) : [];
  } catch {
    return [];
  }
}
function ks(n) {
  if (n && typeof n == "object" && !Array.isArray(n))
    return n;
  if (typeof n != "string" || !n.trim())
    return {};
  try {
    const e = JSON.parse(n);
    return e && typeof e == "object" && !Array.isArray(e) ? e : {};
  } catch {
    return {};
  }
}
function pn(n, e = 1600) {
  if (n.length <= e)
    return n;
  const t = Math.floor((e - 5) / 2);
  return `${n.slice(0, t)}
...
${n.slice(-t)}`;
}
class Ls {
  async buildForChapterScope(e) {
    const t = String(e.novelId || "").trim();
    if (!t)
      throw new Error("novelId is required");
    const a = e.kind || "current_chapter", s = Math.max(1, Math.min(10, Math.floor(e.batchSize ?? 4))), i = Math.max(1, Math.min(20, Math.floor(e.maxDetailedChapters ?? 20))), o = Math.max(4e3, Math.min(2e5, Math.floor(e.maxEstimatedTokens ?? 6e4))), d = (await S.volume.findMany({
      where: { novelId: t },
      select: {
        id: !0,
        order: !0,
        chapters: {
          where: { deleted: !1 },
          select: { id: !0, volumeId: !0, title: !0, order: !0 },
          orderBy: { order: "asc" }
        }
      },
      orderBy: { order: "asc" }
    })).flatMap(
      (R) => (R.chapters || []).map((K) => ({
        ...K,
        volumeOrder: Number(R.order || 0)
      }))
    );
    if (d.length === 0)
      throw new Error("No chapters found for novel");
    const l = Bt([
      ...Array.isArray(e.chapterIds) ? e.chapterIds : [],
      ...a === "current_chapter" && e.chapterId ? [e.chapterId] : []
    ]), m = String(
      e.anchorChapterId || (a === "current_chapter" ? e.chapterId : void 0) || l.at(-1) || ""
    ).trim() || void 0, h = new Set(d.map((R) => String(R.id))), p = l.filter((R) => !h.has(R));
    if (p.length > 0)
      throw new Error(`Chapters do not belong to novel: ${p.join(", ")}`);
    if (m && !h.has(m))
      throw new Error(`Anchor chapter does not belong to novel: ${m}`);
    let f = [];
    if (a === "current_chapter") {
      if (!m || !h.has(m))
        throw new Error("anchorChapterId is required");
      f = d.filter((R) => R.id === m);
    } else if (a === "selected_chapters") {
      if (l.length === 0)
        throw new Error("chapterIds is required for selected_chapters");
      const R = new Set(l);
      f = d.filter((K) => R.has(K.id));
    } else if (a === "chapter_range") {
      if (l.length < 2)
        throw new Error("chapter_range requires at least two chapterIds");
      const R = l.map((K) => d.findIndex((Ce) => Ce.id === K));
      f = d.slice(Math.min(...R), Math.max(...R) + 1);
    } else if (a === "current_volume") {
      const R = String(e.volumeId || "").trim();
      if (!R)
        throw new Error("volumeId is required for current_volume");
      f = d.filter((K) => K.volumeId === R);
    } else
      f = d;
    if (f.length === 0)
      throw new Error("Resolved chapter scope is empty");
    const I = f.map((R) => String(R.id)), y = new Set(I);
    let g = f;
    if (a === "selected_chapters" && f.length > 1) {
      const R = f.map(
        (K) => d.findIndex((Ce) => Ce.id === K.id)
      );
      g = d.slice(Math.min(...R), Math.max(...R) + 1);
    }
    const u = g.map((R) => String(R.id)), v = u.length > i ? "batched" : e.processingMode || "detailed", w = await S.chapter.findMany({
      where: { id: { in: u }, deleted: !1 },
      select: {
        id: !0,
        volumeId: !0,
        title: !0,
        order: !0,
        content: !0,
        wordCount: !0,
        version: !0,
        updatedAt: !0
      }
    }), A = new Map(w.map((R) => [String(R.id), R])), T = await S.chapterSummary.findMany({
      where: { chapterId: { in: u }, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" }
    }), E = /* @__PURE__ */ new Map();
    for (const R of T)
      E.has(String(R.chapterId)) || E.set(String(R.chapterId), R);
    const C = [], _ = [], L = [];
    let V = 0, B = 0;
    for (const R of g) {
      const K = A.get(String(R.id));
      if (!K) {
        C.push(`章节 ${R.title || R.id} 无法读取，已从上下文省略。`);
        continue;
      }
      const Ce = K.id === m && typeof e.currentContent == "string" && e.currentContent.length > 0, Re = Ce ? e.currentContent : String(K.content || ""), ot = Ft(Re), mt = Os(Re), $e = E.get(String(K.id)), Nt = !!$e && String($e.sourceContentHash || "") === mt;
      let ft, M;
      v === "detailed" ? (ft = ot.length > 3e4 ? "truncated" : "full", M = ot.slice(0, 3e4)) : Nt ? (ft = "summary", M = String($e.compressedMemory || $e.summaryText || "").slice(0, 2400)) : (ft = "excerpt", M = pn(ot), $e ? V += 1 : B += 1);
      const Z = K.updatedAt instanceof Date ? K.updatedAt.toISOString() : new Date(K.updatedAt).toISOString();
      _.push({
        chapterId: K.id,
        version: Number(K.version || 1),
        contentHash: mt,
        updatedAt: Z,
        source: Ce ? "editor_buffer" : "database"
      }), L.push({
        chapterId: K.id,
        volumeId: K.volumeId,
        title: String(K.title || ""),
        order: Number(K.order || 0),
        volumeOrder: Number(R.volumeOrder || 0),
        version: Number(K.version || 1),
        updatedAt: Z,
        contentHash: mt,
        contentMode: ft,
        content: M,
        ...$e != null && $e.id ? { summaryId: String($e.id) } : {},
        ...Nt ? {
          summaryContent: String($e.compressedMemory || $e.summaryText || "").slice(0, 2400)
        } : {},
        summaryFresh: Nt,
        target: y.has(String(K.id))
      });
    }
    V > 0 && C.push(`${V} 个章节摘要已过期，已使用原文摘录。`), B > 0 && C.push(`${B} 个章节缺少摘要，已使用原文摘录。`), u.length > i && C.push(`范围上下文包含 ${u.length} 章，超过详细处理上限 ${i}，已切换分批摘要模式。`);
    const se = Bt(L.map((R) => R.volumeId)), [W, Q, N, X, J, Y] = await Promise.all([
      S.narrativeSummary.findMany({
        where: {
          novelId: t,
          isLatest: !0,
          status: "active",
          OR: [
            { level: "novel", volumeId: null },
            ...se.length > 0 ? [{ level: "volume", volumeId: { in: se } }] : []
          ]
        },
        orderBy: { updatedAt: "desc" },
        take: Math.max(2, se.length + 1)
      }),
      S.character.findMany({ where: { novelId: t }, orderBy: { updatedAt: "desc" }, take: 100 }),
      S.item.findMany({ where: { novelId: t }, orderBy: { updatedAt: "desc" }, take: 100 }),
      S.worldSetting.findMany({ where: { novelId: t }, orderBy: { sortOrder: "asc" } }),
      S.mapCanvas.findMany({ where: { novelId: t }, orderBy: { updatedAt: "desc" }, take: 50 }),
      S.plotLine.findMany({
        where: { novelId: t },
        include: { points: { include: { anchors: !0 }, orderBy: { order: "asc" } } },
        orderBy: { sortOrder: "asc" }
      })
    ]), ne = W.map((R) => ({
      id: String(R.id),
      level: R.level === "volume" ? "volume" : "novel",
      ...R.volumeId ? { volumeId: String(R.volumeId) } : {},
      title: String(R.title || ""),
      summaryText: String(R.summaryText || "").slice(0, 4e3),
      keyFacts: qt(R.keyFacts, 20).map(String),
      unresolvedThreads: qt(R.unresolvedThreads, 20).map(String),
      sourceFingerprint: String(R.sourceFingerprint || "")
    })), de = {
      entities: {},
      timelineHints: [],
      openQuestions: [],
      unresolvedThreads: ne.flatMap((R) => R.unresolvedThreads).slice(0, 100)
    }, Pe = new Set(
      L.filter((R) => R.summaryFresh && R.summaryId).map((R) => R.summaryId)
    );
    for (const R of T)
      Pe.has(String(R.id)) && (Object.assign(de.entities, ks(R.entitiesSnapshot)), de.timelineHints.push(...qt(R.timelineHints, 20)), de.openQuestions.push(...qt(R.openQuestions, 20)));
    de.timelineHints = de.timelineHints.slice(0, 100), de.openQuestions = de.openQuestions.slice(0, 100);
    const qe = Array.from({ length: Math.ceil(I.length / s) }, (R, K) => ({
      index: K,
      chapterIds: I.slice(K * s, (K + 1) * s)
    })), je = {
      totalChapterCount: I.length,
      contextChapterCount: L.length,
      readonlyChapterCount: L.filter((R) => !R.target).length,
      detailedChapterCount: L.filter((R) => R.target && (R.contentMode === "full" || R.contentMode === "truncated")).length,
      summarizedChapterCount: L.filter((R) => R.target && R.contentMode === "summary").length,
      excerptChapterCount: L.filter((R) => R.target && R.contentMode === "excerpt").length,
      omittedChapterCount: Math.max(0, I.length - L.filter((R) => R.target).length),
      batchSize: s,
      batchCount: qe.length,
      batches: qe
    }, ze = {
      scope: {
        scopeId: String(e.scopeId || le()),
        novelId: t,
        kind: a,
        ...e.volumeId ? { volumeId: e.volumeId } : {},
        chapterIds: I,
        ...m ? { anchorChapterId: m } : {},
        processingMode: v,
        snapshot: _.filter((R) => y.has(R.chapterId))
      },
      chapters: L,
      narrativeSummaries: ne,
      entityContext: { characters: Q, items: N, worldSettings: X, maps: J },
      plotContext: { plotlines: Y },
      evidence: [],
      stateLedger: de,
      coverage: je,
      sourceSnapshot: _,
      warnings: C
    }, O = Ir(JSON.stringify(ze));
    return O > o && C.push(`范围上下文估算 ${O} tokens，超过目标预算 ${o}；下游必须按批次与角色投影继续裁剪。`), { ...ze, estimatedTokens: O };
  }
  async buildForCreativeAssets(e) {
    const t = e.includeExistingEntities !== !1, r = Math.max(0, Math.min(8, e.contextChapterCount ?? 0)), a = e.filterCompletedPlotLines !== !1, s = [], [i, o, c, d, l, m] = await Promise.all([
      t ? S.character.findMany({
        where: { novelId: e.novelId },
        select: { name: !0, role: !0, description: !0 },
        orderBy: { updatedAt: "desc" },
        take: 30
      }) : [],
      t ? S.item.findMany({
        where: { novelId: e.novelId },
        select: { name: !0, type: !0, description: !0 },
        orderBy: { updatedAt: "desc" },
        take: 30
      }) : [],
      t ? S.plotLine.findMany({
        where: { novelId: e.novelId },
        include: {
          points: {
            select: { title: !0, status: !0, description: !0 },
            orderBy: { order: "asc" }
          }
        },
        orderBy: { sortOrder: "asc" }
      }) : [],
      // 世界观始终全量传递
      S.worldSetting.findMany({
        where: { novelId: e.novelId },
        select: { name: !0, content: !0, type: !0 },
        orderBy: { sortOrder: "asc" }
      }),
      r > 0 ? S.chapter.findMany({
        where: { volume: { novelId: e.novelId } },
        select: { id: !0, title: !0, content: !0, updatedAt: !0 },
        orderBy: { updatedAt: "desc" },
        take: r
      }) : [],
      S.narrativeSummary.findMany({
        where: {
          novelId: e.novelId,
          isLatest: !0,
          status: "active",
          level: "novel"
        },
        orderBy: { updatedAt: "desc" },
        take: 1
      })
    ]), h = c.map((E) => {
      const C = Array.isArray(E.points) ? E.points : [], _ = a ? C.filter((L) => L.status !== "resolved") : C;
      return {
        name: String(E.name || ""),
        description: E.description ? String(E.description) : void 0,
        points: _.map((L) => ({
          title: String(L.title || ""),
          status: String(L.status || "active")
        }))
      };
    }), p = l.map((E) => E.id), f = p.length > 0 ? await S.chapterSummary.findMany({
      where: {
        chapterId: { in: p },
        isLatest: !0,
        status: "active"
      },
      orderBy: { updatedAt: "desc" }
    }) : [], I = /* @__PURE__ */ new Map();
    for (const E of f)
      I.has(E.chapterId) || I.set(E.chapterId, E);
    let y = 0;
    const g = l.map((E) => {
      const C = I.get(E.id), _ = (C == null ? void 0 : C.compressedMemory) || (C == null ? void 0 : C.summaryText);
      return typeof _ == "string" && _.trim() ? { chapterId: E.id, title: E.title || "", summary: _.slice(0, 800) } : (y++, {
        chapterId: E.id,
        title: E.title || "",
        summary: Ft(E.content || "").slice(0, 600)
      });
    });
    y > 0 && s.push(`${y} 个章节缺少摘要，已使用原文摘录替代。`);
    const u = m.map((E) => {
      let C = [];
      if (typeof E.keyFacts == "string" && E.keyFacts.trim())
        try {
          const _ = JSON.parse(E.keyFacts);
          Array.isArray(_) && (C = Bt(
            _.map((L) => String(L || "").trim()).filter(Boolean).slice(0, 12)
          ).slice(0, 8));
        } catch {
        }
      return {
        level: E.level === "volume" ? "volume" : "novel",
        title: String(E.title || ""),
        summaryText: String(E.summaryText || "").slice(0, 1500),
        keyFacts: C
      };
    }), v = {
      characters: i.map((E) => ({
        name: String(E.name || ""),
        role: E.role ? String(E.role) : void 0,
        description: E.description ? String(E.description).slice(0, 200) : void 0
      })),
      items: o.map((E) => ({
        name: String(E.name || ""),
        type: E.type ? String(E.type) : void 0,
        description: E.description ? String(E.description).slice(0, 200) : void 0
      })),
      plotLines: h,
      worldSettings: d.map((E) => ({
        name: String(E.name || ""),
        content: String(E.content || ""),
        type: String(E.type || "other")
      }))
    }, w = JSON.stringify({ existingEntities: v, recentSummaries: g, narrativeSummaries: u }), A = Ir(w), T = [];
    return v.characters.length > 0 && T.push(`characters_${v.characters.length}`), v.items.length > 0 && T.push(`items_${v.items.length}`), v.plotLines.length > 0 && T.push(`plotLines_${v.plotLines.length}`), T.push(`worldSettings_${v.worldSettings.length}`), g.length > 0 && T.push(`recentChapterSummaries_${g.length}`), u.length > 0 && T.push(`narrativeSummaries_${u.length}`), T.push(`estimatedTokens_${A}`), {
      existingEntities: v,
      recentSummaries: g,
      narrativeSummaries: u,
      usedContext: T,
      warnings: s,
      estimatedTokens: A
    };
  }
  async buildForContinueWriting(e) {
    var ze;
    const t = Math.max(1, Math.min(20, e.contextChapterCount ?? 8)), r = Math.max(1, Math.min(3, e.recentRawChapterCount ?? 2)), a = t + r, s = {
      version: "continuation-context-v1",
      summaryChapterCount: t,
      fullTextChapterCount: r,
      maxFullTextChars: 12e3,
      maxSummaryChars: 2400,
      maxCurrentContentChars: 12e3
    }, o = (await S.volume.findMany({
      where: { novelId: e.novelId, deleted: !1 },
      select: {
        id: !0,
        order: !0,
        chapters: {
          where: { deleted: !1 },
          select: { id: !0, volumeId: !0, title: !0, order: !0 },
          orderBy: { order: "asc" }
        }
      },
      orderBy: { order: "asc" }
    })).flatMap(
      (O) => (O.chapters || []).map((R) => ({
        ...R,
        volumeOrder: Number(O.order || 0)
      }))
    ), c = o.findIndex((O) => String(O.id) === e.chapterId);
    if (c < 0)
      throw new Error("Current chapter does not belong to novel");
    const d = o.slice(Math.max(0, c - a), c), l = [...d.map((O) => String(O.id)), e.chapterId], m = await this.buildForChapterScope({
      novelId: e.novelId,
      kind: "selected_chapters",
      chapterIds: l,
      anchorChapterId: e.chapterId,
      processingMode: "detailed",
      currentContent: e.currentContent,
      maxDetailedChapters: 20,
      maxEstimatedTokens: 12e4
    }), h = e.currentContent || String(((ze = await S.chapter.findUnique({
      where: { id: e.chapterId },
      select: { content: !0 }
    })) == null ? void 0 : ze.content) || ""), p = d.slice(-r).map((O) => String(O.id)), f = p.length > 0 ? await S.chapter.findMany({
      where: { id: { in: p }, deleted: !1 },
      select: { id: !0, content: !0 }
    }) : [], I = new Map(
      f.map((O) => [String(O.id), Ft(String(O.content || ""))])
    ), y = m.entityContext.worldSettings, g = m.plotContext.plotlines, u = m.entityContext.characters, v = m.entityContext.items, w = m.entityContext.maps, A = Array.isArray(e.ideaIds) ? e.ideaIds.map((O) => String(O)).filter(Boolean) : [], T = A.length > 0 ? await S.idea.findMany({
      where: {
        novelId: e.novelId,
        id: { in: A }
      },
      include: { tags: !0 },
      orderBy: { updatedAt: "desc" },
      take: 20
    }) : [], E = m.narrativeSummaries.map((O) => ({
      level: O.level,
      title: O.title,
      summaryText: O.summaryText.slice(0, 1200),
      keyFacts: O.keyFacts.slice(0, 5)
    })), C = m.chapters.filter((O) => O.chapterId !== e.chapterId), _ = Math.max(0, C.length - r);
    let L = 0;
    const V = C.map((O, R) => {
      var Ce;
      if (R >= _) {
        const Re = I.get(O.chapterId) || O.content, ot = Re.length > s.maxFullTextChars;
        return {
          chapterId: O.chapterId,
          title: O.title,
          excerpt: Re.slice(-s.maxFullTextChars),
          contentMode: ot ? "truncated" : "full"
        };
      }
      return O.summaryFresh && ((Ce = O.summaryContent) != null && Ce.trim()) ? {
        chapterId: O.chapterId,
        title: O.title,
        excerpt: O.summaryContent.slice(0, s.maxSummaryChars),
        contentMode: "summary"
      } : (L += 1, {
        chapterId: O.chapterId,
        title: O.title,
        excerpt: pn(O.content, s.maxSummaryChars),
        contentMode: "excerpt"
      });
    }), B = m.chapters.find((O) => O.chapterId === e.chapterId), se = Ft(h || (B == null ? void 0 : B.content) || "").slice(-s.maxCurrentContentChars), W = T.map((O) => ({
      ideaId: O.id,
      content: (O.content || "").slice(0, 800),
      quote: typeof O.quote == "string" ? O.quote.slice(0, 300) : void 0,
      tags: Array.isArray(O.tags) ? O.tags.map((R) => String(R.name || "").trim()).filter(Boolean).slice(0, 12) : []
    })), Q = {
      characters: new Set(
        u.map((O) => String((O == null ? void 0 : O.name) || "").trim()).filter(Boolean)
      ),
      items: new Set(
        v.map((O) => String((O == null ? void 0 : O.name) || "").trim()).filter(Boolean)
      ),
      worldSettings: new Set(
        y.map((O) => String((O == null ? void 0 : O.name) || "").trim()).filter(Boolean)
      )
    }, N = [], X = /@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g;
    for (const O of W) {
      const R = `${O.content || ""}
${O.quote || ""}`, K = Array.from(R.matchAll(X));
      for (const Ce of K) {
        const Re = String(Ce[1] || "").trim();
        Re && (Q.characters.has(Re) ? N.push({ name: Re, kind: "character" }) : Q.items.has(Re) ? N.push({ name: Re, kind: "item" }) : Q.worldSettings.has(Re) && N.push({ name: Re, kind: "worldSetting" }));
      }
    }
    const J = Bt(N.map((O) => `${O.kind}:${O.name}`)).map((O) => {
      const [R, ...K] = O.split(":");
      return {
        name: K.join(":"),
        kind: R === "character" || R === "item" || R === "worldSetting" ? R : "character"
      };
    }).slice(0, 20), Y = String(e.currentLocation || "").trim().slice(0, 120), ne = Math.max(0, A.length - W.length), de = [...m.warnings];
    L > 0 && de.push(`${L} chapter summaries missing or stale; fell back to chapter text excerpts.`), ne > 0 && de.push(`${ne} selected ideas not found; ignored.`);
    const Pe = new Map(m.sourceSnapshot.map((O) => [O.chapterId, O])), qe = new Map(m.chapters.map((O) => [O.chapterId, O])), je = new Map(V.map((O) => [O.chapterId, O.contentMode])), Ue = {
      policy: s,
      scopeId: m.scope.scopeId,
      novelId: e.novelId,
      anchorChapterId: e.chapterId,
      chapterSources: l.flatMap((O) => {
        const R = Pe.get(O), K = qe.get(O);
        if (!R || !K)
          return [];
        const Ce = O === e.chapterId;
        return [{
          ...R,
          volumeId: K.volumeId,
          title: K.title,
          order: K.order,
          volumeOrder: K.volumeOrder,
          contentMode: Ce ? K.contentMode : je.get(O) || "excerpt",
          ...K.summaryId ? { summaryId: K.summaryId } : {},
          summaryFresh: K.summaryFresh
        }];
      }),
      narrativeSummaryIds: m.narrativeSummaries.map((O) => O.id),
      estimatedTokens: Ir(JSON.stringify({
        recentChapterItems: V,
        currentChapterBeforeCursor: se,
        narrativeSummaries: E,
        hardContext: { worldSettings: y, plotLines: g, characters: u, items: v, maps: w }
      })),
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return {
      currentContentSource: h,
      hardContext: {
        worldSettings: y,
        plotLines: g,
        characters: u,
        items: v,
        maps: w
      },
      dynamicContext: {
        recentChapters: V,
        selectedIdeas: W,
        selectedIdeaEntities: J,
        currentChapterBeforeCursor: se,
        ...Y ? { currentLocation: Y } : {},
        narrativeSummaries: E
      },
      params: {
        mode: e.mode === "new_chapter" ? "new_chapter" : "continue_chapter",
        contextChapterCount: t,
        style: e.style || "default",
        tone: e.tone || "balanced",
        pace: e.pace || "medium",
        targetLength: Math.max(100, Math.min(4e3, e.targetLength ?? 500))
      },
      policy: s,
      snapshot: Ue,
      usedContext: [
        "world_settings_full",
        "plot_outline_full",
        "characters_items_maps_snapshot",
        `ordered_previous_chapters_${V.length}`,
        `previous_chapter_summaries_${V.filter((O) => O.contentMode === "summary").length}`,
        `previous_chapter_full_text_${V.filter((O) => O.contentMode === "full" || O.contentMode === "truncated").length}`,
        E.length > 0 ? `narrative_summaries_${E.length}` : "narrative_summaries_0",
        W.length > 0 ? `selected_ideas_${W.length}` : "selected_ideas_0",
        J.length > 0 ? `selected_idea_entities_${J.length}` : "selected_idea_entities_0",
        ...Y ? ["current_location"] : [],
        "current_chapter_before_cursor",
        s.version
      ],
      warnings: de
    };
  }
}
const gn = /(?:必须|不要|不能|禁止|只允许|仅限|请保持|需要保持|务必|记住|风格|视角|篇幅|长度|must\b|do not\b|don't\b|never\b|only\b|keep\b|remember\b|style\b|perspective\b|length\b)/i, Ms = /(?:决定|采用|选择|确认|就按|改为|保持|不要|不能|禁止|必须|只允许|仅限|务必|decide|choose|confirm|use\b|keep\b|must\b|never\b|do not\b)/i, Ps = /(?:当前|目前|已经|已有|设定|角色|章节|大纲|世界观|主线|支线|事实|状态|现有|current|already|existing|fact|state|chapter|character|outline)/i, vr = /[?？]\s*$|(?:请问|是否|能否|哪一|哪个|什么|如何|怎么|为什么|吗[？?]?\s*$|呢[？?]?\s*$)/i, kr = /(?:上面|之前|此前|刚才|前面|继续|总结|结论|那个|这些|那些|above|previous|earlier|continue|summary|that)/i, In = {
  required: 0,
  high: 1,
  normal: 2,
  low: 3
};
function ye(n) {
  if (!n)
    return 0;
  let e = 0, t = 0;
  for (const r of n)
    /[^\u0000-\u00ff]/.test(r) ? e += 1 : t += 1;
  return Math.max(1, e + Math.ceil(t / 4));
}
function Us(n, e = "", t = 0) {
  if (Number.isFinite(t) && t >= 8192)
    return {
      tokens: Math.min(2e6, Math.floor(t)),
      source: "configured"
    };
  const r = e.trim().toLowerCase();
  let a = n === "mcp-cli" ? 32768 : 65536;
  return /gemini|qwen-long/.test(r) ? a = 262144 : /claude/.test(r) ? a = 18e4 : /gpt-5|gpt-4\.1/.test(r) ? a = 262144 : /gpt-4o|\bo[134](?:-|$)/.test(r) ? a = 98304 : /deepseek|qwen|glm|doubao/.test(r) && (a = 65536), { tokens: a, source: "model-profile" };
}
function Ie(n) {
  try {
    const e = JSON.stringify(n);
    return e === void 0 ? String(n ?? "") : e;
  } catch {
    return String(n ?? "");
  }
}
function Me(n, e) {
  const t = n.trim();
  if (!t || e <= 0)
    return "";
  if (ye(t) <= e)
    return t;
  let r = 0, a = t.length;
  for (; r < a; ) {
    const i = Math.ceil((r + a) / 2);
    ye(t.slice(0, i)) <= Math.max(1, e - 12) ? r = i : a = i - 1;
  }
  const s = Math.max(0, t.length - r);
  return `${t.slice(0, r).trimEnd()}
[compressed: ${s} chars omitted]`;
}
function Qe(n, e) {
  const t = Ie(n);
  if (ye(t) <= e)
    return n;
  if (Array.isArray(n) && n.length > 0) {
    const r = (i) => {
      const o = Math.ceil(i / 2), c = Math.floor(i / 2), d = Math.max(24, Math.floor((e - 40) / Math.max(1, i)));
      return {
        compressed: !0,
        totalItems: n.length,
        head: n.slice(0, o).map((l) => Qe(l, d)),
        tail: c > 0 ? n.slice(Math.max(o, n.length - c)).map((l) => Qe(l, d)) : []
      };
    }, a = r(Math.min(6, n.length));
    if (ye(Ie(a)) <= e)
      return a;
    const s = r(Math.min(2, n.length));
    if (ye(Ie(s)) <= e)
      return s;
  }
  return {
    compressed: !0,
    excerpt: Me(t, Math.max(32, e - 16))
  };
}
function yr(n) {
  return !!(n && typeof n == "object" && n.compressed === !0);
}
function Wr(n) {
  let e = 2166136261;
  for (let t = 0; t < n.length; t += 1)
    e ^= n.charCodeAt(t), e = Math.imul(e, 16777619);
  return (e >>> 0).toString(36);
}
function ma(n) {
  return Array.isArray(n) ? n.flatMap((e, t) => {
    const r = String((e == null ? void 0 : e.content) || "").trim();
    if (!r || e.role !== "user" && e.role !== "assistant")
      return [];
    const a = e.createdAt ? String(e.createdAt) : void 0, s = String(e.messageId || "").trim() || `legacy_${Wr(`${t}\0${e.role}\0${a || ""}\0${r}`)}`;
    return [{
      role: e.role,
      content: r,
      messageId: s,
      sourceMessageIndex: t,
      ...a ? { createdAt: a } : {}
    }];
  }) : [];
}
function $s(n) {
  if (!n || typeof n != "object")
    return null;
  const e = n, t = String(e.text || "").trim(), r = Array.isArray(e.sourceMessageIds) ? [...new Set(e.sourceMessageIds.map((s) => String(s || "").trim()).filter(Boolean))].slice(0, 12) : [];
  if (!t || !r.length)
    return null;
  const a = e.sourceRole === "assistant" ? "assistant" : "user";
  return {
    id: String(e.id || `summary_${Wr(`${a}\0${t}\0${r.join("|")}`)}`),
    text: Me(t, 180),
    sourceMessageIds: r,
    sourceRole: a,
    ...e.createdAt ? { createdAt: String(e.createdAt) } : {}
  };
}
function Bs(n) {
  if (!n || typeof n != "object")
    return null;
  const e = n, t = String(e.artifactId || "").trim();
  return t ? {
    artifactId: t,
    ...e.runId ? { runId: String(e.runId) } : {},
    ...e.type ? { type: String(e.type) } : {},
    title: Me(String(e.title || e.type || t), 80),
    ...e.status ? { status: String(e.status) } : {},
    ...e.summary ? { summary: Me(String(e.summary), 160) } : {},
    ...e.createdAt ? { createdAt: String(e.createdAt) } : {}
  } : null;
}
function fa(n) {
  if (!n || typeof n != "object")
    return null;
  const e = n;
  if (e.version !== "agent-conversation-summary-v1")
    return null;
  const t = Array.isArray(e.coveredMessageIds) ? [...new Set(e.coveredMessageIds.map((i) => String(i || "").trim()).filter(Boolean))] : [], r = (i) => (Array.isArray(e[i]) ? e[i] : []).map($s).filter((o) => !!o), a = (Array.isArray(e.artifactRefs) ? e.artifactRefs : []).map(Bs).filter((i) => !!i), s = e.coverage && typeof e.coverage == "object" ? e.coverage : {};
  return {
    version: "agent-conversation-summary-v1",
    revision: Math.max(1, Math.floor(Number(e.revision) || 1)),
    coveredMessageIds: t,
    coverage: {
      ...s.startMessageId ? { startMessageId: String(s.startMessageId) } : {},
      ...s.endMessageId ? { endMessageId: String(s.endMessageId) } : {},
      messageCount: t.length
    },
    facts: r("facts").slice(-40),
    userDecisions: r("userDecisions").slice(-32),
    unresolvedQuestions: r("unresolvedQuestions").slice(-16),
    outcomes: r("outcomes").slice(-32),
    artifactRefs: a.slice(-64),
    updatedAt: String(e.updatedAt || (/* @__PURE__ */ new Date(0)).toISOString())
  };
}
function pa(n) {
  if (!Array.isArray(n))
    return [];
  const e = /* @__PURE__ */ new Map();
  for (const t of n) {
    const r = String((t == null ? void 0 : t.artifactId) || "").trim();
    r && e.set(r, {
      artifactId: r,
      ...t.runId ? { runId: String(t.runId) } : {},
      ...t.type ? { type: String(t.type) } : {},
      ...t.title ? { title: String(t.title) } : {},
      ...t.status ? { status: String(t.status) } : {},
      ...t.summary ? { summary: String(t.summary) } : {},
      ...t.content ? { content: String(t.content) } : {},
      ...t.reference ? { reference: t.reference } : {},
      ...t.metadata ? { metadata: t.metadata } : {},
      ...t.createdAt ? { createdAt: String(t.createdAt) } : {}
    });
  }
  return [...e.values()];
}
function jt(n, e) {
  const t = String(e.messageId || "");
  return {
    id: `${n}_${Wr(`${t}\0${e.content}`)}`,
    text: Me(e.content, 180),
    sourceMessageIds: [t],
    sourceRole: e.role,
    ...e.createdAt ? { createdAt: e.createdAt } : {}
  };
}
function Vt(n, e, t) {
  const r = new Map(n.map((a) => [a.id, a]));
  for (const a of e)
    r.set(a.id, a);
  return [...r.values()].slice(-t);
}
function Lr(n) {
  return {
    artifactId: n.artifactId,
    ...n.runId ? { runId: n.runId } : {},
    ...n.type ? { type: n.type } : {},
    title: Me(String(n.title || n.type || n.artifactId), 80),
    ...n.status ? { status: n.status } : {},
    ...n.summary ? { summary: Me(String(n.summary), 160) } : {},
    ...n.createdAt ? { createdAt: n.createdAt } : {}
  };
}
function Fs(n) {
  const e = ma(n.history), t = fa(n.previous), r = new Set((t == null ? void 0 : t.coveredMessageIds) || []), a = new Set((n.newlyCoveredMessageIds || []).map(String)), s = e.filter((v) => a.has(String(v.messageId)) && !r.has(String(v.messageId))), i = pa(n.artifacts), o = new Map(((t == null ? void 0 : t.artifactRefs) || []).map((v) => [v.artifactId, v])), c = i.some((v) => {
    const w = o.get(v.artifactId);
    return Ie(w || null) !== Ie(Lr(v));
  });
  if (!s.length && !c)
    return;
  const d = [...(t == null ? void 0 : t.coveredMessageIds) || []];
  for (const v of s) {
    const w = String(v.messageId || "");
    w && !r.has(w) && (d.push(w), r.add(w));
  }
  const l = s.filter((v) => v.role === "user" && Ps.test(v.content) && !vr.test(v.content)).map((v) => jt("fact", v)), m = s.filter((v) => v.role === "user" && Ms.test(v.content)).map((v) => jt("decision", v)), h = s.filter((v) => v.role === "assistant" && !vr.test(v.content)).map((v) => jt("outcome", v)), p = new Map(e.map((v, w) => [String(v.messageId), w])), f = s.filter((v) => {
    if (v.role !== "assistant" || !vr.test(v.content))
      return !1;
    const w = p.get(String(v.messageId)) ?? -1;
    return !e.slice(w + 1).some((A) => A.role === "user");
  }).map((v) => jt("question", v)), I = ((t == null ? void 0 : t.unresolvedQuestions) || []).filter((v) => {
    const w = Math.max(...v.sourceMessageIds.map((A) => p.get(A) ?? -1));
    return w < 0 || !e.slice(w + 1).some((A) => A.role === "user");
  }), y = new Map(((t == null ? void 0 : t.artifactRefs) || []).map((v) => [v.artifactId, v]));
  for (const v of i)
    y.set(v.artifactId, Lr(v));
  const g = d[0], u = d[d.length - 1];
  return {
    version: "agent-conversation-summary-v1",
    revision: ((t == null ? void 0 : t.revision) || 0) + 1,
    coveredMessageIds: d,
    coverage: {
      ...g ? { startMessageId: g } : {},
      ...u ? { endMessageId: u } : {},
      messageCount: d.length
    },
    facts: Vt((t == null ? void 0 : t.facts) || [], l, 40),
    userDecisions: Vt((t == null ? void 0 : t.userDecisions) || [], m, 32),
    unresolvedQuestions: Vt(I, f, 16),
    outcomes: Vt((t == null ? void 0 : t.outcomes) || [], h, 32),
    artifactRefs: [...y.values()].slice(-64),
    updatedAt: n.updatedAt || (/* @__PURE__ */ new Date()).toISOString()
  };
}
function qs(n, e) {
  const t = [], r = /* @__PURE__ */ new Set();
  let a = 0;
  const s = Math.max(180, Math.min(1024, Math.floor(e / 4)));
  for (let i = n.length - 1; i >= 0; i -= 1) {
    const o = n[i];
    if (o.role !== "user" || !gn.test(o.content))
      continue;
    const c = o.content.split(new RegExp("(?<=[。！？!?；;\\n])")).map((p) => p.trim()).filter((p) => p && gn.test(p)), d = Me(c.join(" ") || o.content, s), l = d.toLowerCase();
    if (!d || r.has(l))
      continue;
    const m = { sourceMessageIndex: i, excerpt: d }, h = ye(Ie(m));
    a + h > e || (t.unshift(m), r.add(l), a += h);
  }
  return t;
}
function ga(n) {
  const e = n.toLowerCase(), t = /* @__PURE__ */ new Set();
  for (const r of e.match(/[a-z0-9_.:-]{3,}/g) || [])
    t.add(r);
  for (const r of e.match(/[\u3400-\u9fff]{2,}/g) || []) {
    r.length <= 8 && t.add(r);
    for (let a = 0; a < r.length - 1; a += 1)
      t.add(r.slice(a, a + 2));
  }
  return [...t].slice(0, 80);
}
function Ia(n, e, t, r) {
  const a = t.toLowerCase();
  let s = r.some((i) => n.includes(i.toLowerCase())) ? 100 : 0;
  for (const i of e)
    a.includes(i) && (s += i.length >= 4 ? 3 : 1);
  return s;
}
function js(n, e, t) {
  if (!n)
    return [];
  const r = Ie(t).toLowerCase(), a = ga(r), s = [
    ...n.userDecisions,
    ...n.unresolvedQuestions,
    ...n.facts,
    ...n.outcomes
  ], i = s.map((m, h) => ({
    entry: m,
    index: h,
    score: Ia(r, a, m.text, [m.id, ...m.sourceMessageIds])
  })).filter((m) => m.score > 0);
  if (!i.length && kr.test(r))
    for (let m = Math.max(0, s.length - 3); m < s.length; m += 1)
      i.push({ entry: s[m], index: m, score: 1 });
  i.sort((m, h) => h.score - m.score || h.index - m.index);
  const o = n.coveredMessageIds.filter((m) => r.includes(m.toLowerCase())), c = !i.length && kr.test(r) ? n.coveredMessageIds.slice(-3) : [], d = [.../* @__PURE__ */ new Set([
    ...o,
    ...i.slice(0, 4).flatMap((m) => m.entry.sourceMessageIds),
    ...c
  ])].slice(0, 6), l = new Map(e.map((m) => [String(m.messageId), m]));
  return d.flatMap((m) => {
    const h = l.get(m);
    return h ? [{
      messageId: m,
      role: h.role,
      content: Me(h.content, 420),
      ...h.createdAt ? { createdAt: h.createdAt } : {},
      sourceRef: `agent-message:${m}`
    }] : [];
  });
}
function Vs(n, e, t) {
  if (!e.length)
    return [];
  const r = Ie(t).toLowerCase(), a = ga(r), s = new Map(((n == null ? void 0 : n.artifactRefs) || []).map((o) => [o.artifactId, o]));
  for (const o of e)
    s.has(o.artifactId) || s.set(o.artifactId, Lr(o));
  const i = e.flatMap((o, c) => {
    const d = s.get(o.artifactId);
    if (!d)
      return [];
    const l = [d.title, d.summary, d.type].filter(Boolean).join(" "), m = Ia(r, a, l, [d.artifactId]);
    return m > 0 ? [{ artifact: o, ref: d, index: c, score: m }] : [];
  });
  if (!i.length && kr.test(r) && /(?:草稿|报告|审核|产物|artifact|draft|report|review)/i.test(r)) {
    const o = e.filter((c) => s.has(c.artifactId));
    for (let c = Math.max(0, o.length - 2); c < o.length; c += 1) {
      const d = o[c];
      i.push({ artifact: d, ref: s.get(d.artifactId), index: c, score: 1 });
    }
  }
  return i.sort((o, c) => c.score - o.score || c.index - o.index), i.slice(0, 3).map(({ artifact: o, ref: c }) => ({
    artifactId: o.artifactId,
    ...o.runId ? { runId: o.runId } : {},
    type: o.type || c.type,
    title: o.title || c.title,
    summary: Me(String(o.summary || c.summary || ""), 180),
    contentExcerpt: Me(String(o.content || Ie(o.metadata || {})), 520),
    reference: Qe(o.reference || {}, 120),
    sourceRef: `agent-artifact:${o.artifactId}`
  }));
}
function Js(n, e, t) {
  var i, o;
  const r = n.slice(e, t + 1), a = r.map((c, d) => ({
    message: c,
    sourceMessageIndex: Number(c.sourceMessageIndex ?? e + d),
    sourceMessageId: c.messageId
  })).filter(({ message: c }) => c.role === "user").slice(-2).map(({ message: c, sourceMessageIndex: d, sourceMessageId: l }) => ({
    sourceMessageIndex: d,
    sourceMessageId: l,
    excerpt: Me(c.content, 100)
  })), s = r.map((c, d) => ({
    message: c,
    sourceMessageIndex: Number(c.sourceMessageIndex ?? e + d),
    sourceMessageId: c.messageId
  })).filter(({ message: c }) => c.role === "assistant").slice(-1).map(({ message: c, sourceMessageIndex: d, sourceMessageId: l }) => ({
    sourceMessageIndex: d,
    sourceMessageId: l,
    excerpt: Me(c.content, 120)
  }));
  return {
    sourceRange: {
      startMessageIndex: Number(((i = r[0]) == null ? void 0 : i.sourceMessageIndex) ?? e),
      endMessageIndex: Number(((o = r[r.length - 1]) == null ? void 0 : o.sourceMessageIndex) ?? t)
    },
    sourceMessageIds: r.map((c) => c.messageId).filter(Boolean),
    userRequests: a,
    assistantOutcome: s
  };
}
function Hs(n, e) {
  if (!n.length || e < 64)
    return { recentHistory: [], rollingSummary: [], summarizedCount: 0, omittedCount: n.length };
  const t = Math.max(64, Math.floor(e * 0.68)), r = [];
  let a = 0, s = n.length;
  for (let h = n.length - 1; h >= 0; h -= 1) {
    const p = n[h], f = { sourceMessageIndex: Number(p.sourceMessageIndex ?? h), ...p }, I = ye(Ie(f));
    if (a + I > t) {
      if (!r.length) {
        const y = {
          sourceMessageIndex: Number(p.sourceMessageIndex ?? h),
          role: p.role,
          content: Me(p.content, Math.max(32, t - 24)),
          messageId: p.messageId,
          ...p.createdAt ? { createdAt: p.createdAt } : {},
          compressed: !0
        };
        r.unshift(y), s = h;
      }
      break;
    }
    r.unshift(f), s = h, a += I;
  }
  const i = Math.max(0, e - ye(Ie(r))), o = [];
  for (let h = s - 1; h >= 0; h -= 6) {
    const p = Math.max(0, h - 5);
    o.unshift({ start: p, end: h, summary: Js(n, p, h) });
  }
  const c = [];
  let d = 0, l = 0;
  for (let h = o.length - 1; h >= 0; h -= 1) {
    const p = o[h], f = ye(Ie(p.summary));
    d + f > i || (c.unshift(p.summary), d += f, l += p.end - p.start + 1);
  }
  const m = Math.max(0, s);
  return {
    recentHistory: r,
    rollingSummary: c,
    summarizedCount: l,
    omittedCount: Math.max(0, m - l)
  };
}
function Jt(n, e) {
  const t = [...new Set(n.filter(Number.isFinite))].sort((i, o) => i - o);
  if (!t.length)
    return [];
  const r = [];
  let a = t[0], s = t[0];
  for (const i of t.slice(1)) {
    if (i === s + 1) {
      s = i;
      continue;
    }
    r.push({ mode: e, startMessageIndex: a, endMessageIndex: s }), a = i, s = i;
  }
  return r.push({ mode: e, startMessageIndex: a, endMessageIndex: s }), r;
}
class zs {
  assemble(e) {
    const t = String(e.model || (e.providerType === "mcp-cli" ? "mcp-cli" : "unknown-model")), r = Us(e.providerType, t, e.contextWindowTokens), a = Math.max(128, Math.floor(e.outputTokens || 0)), s = Number.isFinite(e.safetyTokens) && Number(e.safetyTokens) > 0 ? Math.floor(Number(e.safetyTokens)) : Math.max(2048, Math.min(16384, Math.floor(r.tokens * 0.1))), i = ye(String(e.systemPrompt || "")), o = Math.max(128, r.tokens - a - s - i), c = [];
    r.tokens <= a + s + i && c.push("Configured context window is smaller than the reserved system, output, and safety budgets.");
    const d = ma(e.history), l = fa(e.persistentSummary), m = pa(e.artifacts), h = new Set((l == null ? void 0 : l.coveredMessageIds) || []), p = d.filter((M) => !h.has(String(M.messageId))), f = js(l, d, e.currentRequest), I = Vs(l, m, e.currentRequest), y = Math.max(256, Math.floor(o * 0.28)), g = qs(
      d,
      Math.max(128, Math.floor(o * 0.12))
    ), u = (e.sections || []).filter((M) => M && String(M.id || "").trim()).map((M) => ({ ...M, id: String(M.id), priority: M.priority || "normal" })).sort((M, Z) => In[M.priority] - In[Z.priority]), v = {
      contextVersion: "agent-context-v1",
      currentRequest: Qe(e.currentRequest, y),
      persistentConstraints: g,
      persistentSummary: l ? Qe(l, Math.max(256, Math.floor(o * 0.18))) : null,
      recalledMessages: Qe(f, Math.max(128, Math.floor(o * 0.1))),
      recalledArtifacts: Qe(I, Math.max(128, Math.floor(o * 0.12))),
      rollingSummary: [],
      recentHistory: [],
      sections: []
    }, w = [], A = [], T = Math.max(128, Math.floor(o * 0.42));
    let E = 0;
    for (let M = 0; M < u.length; M += 1) {
      const Z = u[M], Ve = u.length - M, it = Math.max(96, Math.floor((T - E) / Math.max(1, Ve))), bt = Math.max(64, Math.min(Z.maxTokens || it, T - E));
      if (bt < 64 && Z.priority !== "required") {
        w.push(Z.id);
        continue;
      }
      const Kr = {
        id: Z.id,
        kind: Z.kind,
        priority: Z.priority,
        ...Z.sourceRef ? { sourceRef: Z.sourceRef } : {},
        value: Qe(Z.value, Math.max(32, bt - 24))
      }, Zr = ye(Ie(Kr));
      if (E + Zr > T && Z.priority !== "required") {
        w.push(Z.id);
        continue;
      }
      A.push(Kr), E += Zr;
    }
    v.sections = A;
    const C = ye(Ie(v)), _ = Math.max(0, o - C - 32), L = Hs(p, _);
    v.rollingSummary = L.rollingSummary, v.recentHistory = L.recentHistory;
    let V = Ie(v), B = ye(V);
    const se = v.rollingSummary, W = v.recentHistory;
    for (; B > o && se.length; )
      se.shift(), V = Ie(v), B = ye(V);
    for (; B > o && W.length > 1; )
      W.shift(), V = Ie(v), B = ye(V);
    for (; B > o && A.some((M) => M.priority !== "required"); ) {
      let M = A.length - 1;
      for (; M >= 0 && A[M].priority === "required"; )
        M -= 1;
      const [Z] = A.splice(M, 1);
      w.push(String(Z.id)), V = Ie(v), B = ye(V);
    }
    for (; B > o && g.length; )
      g.shift(), V = Ie(v), B = ye(V);
    B > o && (v.currentRequest = Qe(e.currentRequest, Math.max(64, Math.floor(y / 2))), V = Ie(v), B = ye(V));
    const Q = new Map(d.map((M, Z) => [
      String(M.messageId),
      Number(M.sourceMessageIndex ?? Z)
    ])), N = /* @__PURE__ */ new Set();
    for (const M of (l == null ? void 0 : l.coveredMessageIds) || []) {
      const Z = Q.get(M);
      typeof Z == "number" && N.add(Z);
    }
    for (const M of se) {
      const Z = Array.isArray(M.sourceMessageIds) ? M.sourceMessageIds.map(String) : [];
      if (Z.length) {
        for (const it of Z) {
          const bt = Q.get(it);
          typeof bt == "number" && N.add(bt);
        }
        continue;
      }
      const Ve = M.sourceRange;
      if (!(!Ve || typeof Ve.startMessageIndex != "number" || typeof Ve.endMessageIndex != "number"))
        for (let it = Ve.startMessageIndex; it <= Ve.endMessageIndex; it += 1)
          N.add(it);
    }
    const X = N.size, J = new Set(W.map((M) => Number(M.sourceMessageIndex))), Y = [...J].filter(Number.isFinite).length, ne = /* @__PURE__ */ new Set([...J, ...N]), Pe = d.map((M, Z) => Number(M.sourceMessageIndex ?? Z)).filter((M) => !ne.has(M)), qe = Pe.length, je = W.filter((M) => M.compressed === !0).length, Ue = yr(v.currentRequest), ze = A.filter((M) => yr(M.value)).map((M) => String(M.id)), O = Ue || X > 0 || qe > 0 || je > 0 || ze.length > 0 || w.length > 0;
    l && l.coveredMessageIds.length ? c.push("Older conversation messages were represented by a persisted, traceable summary.") : X > 0 && c.push("Older conversation messages were represented by traceable rolling summaries."), qe > 0 && c.push(`${qe} older conversation messages could not fit in this model request.`), w.length && c.push("Lower-priority context sections were omitted to fit the model budget.");
    const R = [], K = [];
    for (const M of W) {
      const Z = Number(M.sourceMessageIndex);
      Number.isFinite(Z) && (M.compressed === !0 ? K : R).push(Z);
    }
    const Ce = [
      ...Jt(R, "raw"),
      ...Jt(K, "compressed"),
      ...Jt([...N], "summary"),
      ...Jt(Pe, "omitted")
    ].sort((M, Z) => M.startMessageIndex - Z.startMessageIndex), Re = new Map(d.map((M, Z) => [
      Number(M.sourceMessageIndex ?? Z),
      M
    ])), ot = [...new Set([...N, ...Pe].sort((M, Z) => M - Z).flatMap((M) => {
      var Ve;
      const Z = (Ve = Re.get(M)) == null ? void 0 : Ve.messageId;
      return Z ? [String(Z)] : [];
    }))], mt = Fs({
      previous: l,
      history: d,
      newlyCoveredMessageIds: ot,
      artifacts: m
    }), $e = new Set(w), Nt = new Map(A.map((M) => [String(M.id), M])), ft = u.map((M) => {
      const Z = Nt.get(M.id), Ve = $e.has(M.id) || !Z ? "omitted" : yr(Z.value) ? "compressed" : "raw";
      return {
        id: M.id,
        kind: M.kind,
        priority: M.priority,
        mode: Ve,
        ...M.sourceRef ? { sourceRef: M.sourceRef } : {},
        estimatedTokens: Z ? ye(Ie(Z)) : 0
      };
    });
    return {
      prompt: V,
      payload: v,
      ...mt ? { summaryUpdate: mt } : {},
      diagnostics: {
        contextVersion: "agent-context-v1",
        providerType: e.providerType,
        model: t,
        contextWindowTokens: r.tokens,
        contextWindowSource: r.source,
        outputTokens: a,
        safetyTokens: s,
        systemTokens: i,
        inputBudgetTokens: o,
        estimatedInputTokens: B,
        compressionApplied: O,
        currentRequestCompressed: Ue,
        historyMessagesTotal: d.length,
        historyMessagesKept: Y,
        historyMessagesSummarized: X,
        historyMessagesOmitted: qe,
        historyMessagesCompacted: je,
        persistentConstraintsCount: g.length,
        persistentSummaryRevision: (l == null ? void 0 : l.revision) || 0,
        persistentSummaryMessageCount: (l == null ? void 0 : l.coveredMessageIds.length) || 0,
        recalledMessageIds: f.map((M) => String(M.messageId || "")).filter(Boolean),
        recalledArtifactIds: I.map((M) => String(M.artifactId || "")).filter(Boolean),
        currentRequestMode: Ue ? "compressed" : "raw",
        historySources: Ce,
        sectionSources: ft,
        compressedSectionIds: ze,
        omittedSectionIds: [...new Set(w)],
        warnings: c
      }
    };
  }
}
const Ws = /* @__PURE__ */ new Set([
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
]), Xs = /* @__PURE__ */ new Set([
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
function va(n) {
  const e = /* @__PURE__ */ new Set(), t = [];
  for (const r of n) {
    const a = String(r || "").trim();
    if (!a)
      continue;
    const s = a.toLowerCase();
    e.has(s) || (e.add(s), t.push(a));
  }
  return t;
}
function Gs(n) {
  const e = n.toLowerCase();
  return /冲突|矛盾|一致|合理|consisten|conflict/.test(e) ? "consistency_check" : /伏笔|坑|悬念|未解|没回收|未回收|unresolved|thread|foreshadow/.test(e) ? "unresolved_threads" : /大纲|接下来|下一步|后续写|怎么写|outline|next beat|next/.test(e) ? "outline_next" : /后续|后面|之后|还有戏|还有剧情|未来|安排|future|later/.test(e) ? "future_plot_for_entity" : /当前|现在|状态|在哪里|位置|持有|关系|current|state|status|where/.test(e) ? "character_state" : "general_qa";
}
function Ks(n) {
  const e = Array.from(n.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g)).map((a) => String(a[1] || "").trim()).filter(Boolean), t = Array.from(n.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g)).map((a) => a[0]).filter((a) => !Ws.has(a)), r = Array.from(n.matchAll(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g)).map((a) => a[0]).filter((a) => !Xs.has(a.toLowerCase()));
  return va([...e, ...t, ...r]).slice(0, 8);
}
function Zs(n, e) {
  const t = String(n || ""), r = t.toLowerCase(), a = e.map((i) => String(i || "").trim()).filter(Boolean).filter((i) => r.includes(i.toLowerCase())), s = Array.from(t.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g)).map((i) => String(i[1] || "").trim()).filter(Boolean);
  return {
    intent: Gs(t),
    entityNames: va([...a, ...s]).slice(0, 8),
    keywords: Ks(t)
  };
}
function vn(n, e) {
  return `${n.replace(/\/+$/, "")}/${e.replace(/^\/+/, "")}`;
}
async function Ys(n, e) {
  try {
    return await qr.fetch(n, e);
  } catch {
    return await fetch(n, e);
  }
}
function Qs(n) {
  return Array.isArray(n) ? n.map((e) => Number(e)).filter((e) => Number.isFinite(e)) : [];
}
function eo(n) {
  const e = n.trim().replace(/\/+$/, "");
  return e.endsWith("/embeddings") ? e : e.endsWith("/v1") ? vn(e, "embeddings") : vn(e, "v1/embeddings");
}
class to {
  constructor(e) {
    this.settings = e;
  }
  isEnabled() {
    return !!(this.settings.enabled && this.settings.baseUrl.trim() && this.settings.model.trim());
  }
  async embed(e) {
    var l, m;
    if (!this.isEnabled())
      throw new Error("Embedding API is disabled or incomplete.");
    const t = e.map((h) => String(h || "").trim()).filter(Boolean);
    if (t.length === 0)
      return {
        embeddings: [],
        model: this.settings.model,
        dimensions: this.settings.dimensions || 0,
        provider: "openai-compatible"
      };
    const r = new AbortController(), a = Math.max(1e3, this.settings.timeoutMs || 6e4);
    let s = !1;
    const i = setTimeout(() => {
      s = !0, r.abort();
    }, a), o = eo(this.settings.baseUrl), c = {
      model: this.settings.model,
      input: t
    };
    this.settings.dimensions && Number.isFinite(this.settings.dimensions) && (c.dimensions = this.settings.dimensions);
    const d = Date.now();
    try {
      $("INFO", "EmbeddingClient.embed.request", "Embedding request", {
        url: o,
        timeoutMs: a,
        body: ve(c),
        inputCount: t.length
      });
      const h = await Ys(o, {
        method: "POST",
        headers: {
          ...this.settings.apiKey.trim() ? { Authorization: `Bearer ${this.settings.apiKey}` } : {},
          "Content-Type": "application/json"
        },
        body: JSON.stringify(c),
        signal: r.signal
      }), p = await h.text();
      let f = null;
      try {
        f = JSON.parse(p);
      } catch {
        f = null;
      }
      if (!h.ok)
        throw new Error(((l = f == null ? void 0 : f.error) == null ? void 0 : l.message) || `Embedding API rejected: ${h.status} ${p.slice(0, 240)}`);
      const y = (Array.isArray(f == null ? void 0 : f.data) ? f.data : []).sort((u, v) => Number((u == null ? void 0 : u.index) || 0) - Number((v == null ? void 0 : v.index) || 0)).map((u) => Qs(u == null ? void 0 : u.embedding)).filter((u) => u.length > 0), g = ((m = y[0]) == null ? void 0 : m.length) || this.settings.dimensions || 0;
      if (y.length !== t.length)
        throw new Error(`Embedding API returned ${y.length} vectors for ${t.length} inputs.`);
      return $("INFO", "EmbeddingClient.embed.response", "Embedding response ok", {
        url: o,
        elapsedMs: Date.now() - d,
        inputCount: t.length,
        dimensions: g,
        model: (f == null ? void 0 : f.model) || this.settings.model
      }), {
        embeddings: y,
        model: (f == null ? void 0 : f.model) || this.settings.model,
        dimensions: g,
        provider: "openai-compatible"
      };
    } catch (h) {
      throw Se("EmbeddingClient.embed.error", h, {
        url: o,
        elapsedMs: Date.now() - d,
        didTimeout: s,
        requestBody: ve(c)
      }), s ? new Error(`Embedding API timeout after ${a}ms`) : h;
    } finally {
      clearTimeout(i);
    }
  }
}
const Lt = 384, yn = 900, ro = 120, no = 0.08;
function wn(n) {
  return be("sha256").update(n).digest("hex");
}
function ya(n) {
  if (!(n != null && n.trim()))
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (a) => {
      !a || typeof a != "object" || (typeof a.text == "string" && t.push(a.text), Array.isArray(a.children) && a.children.forEach(r));
    };
    return r((e == null ? void 0 : e.root) || e), t.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return n.replace(/\s+/g, " ").trim();
  }
}
function Je(n) {
  if (typeof n != "string" || !n.trim())
    return [];
  try {
    const e = JSON.parse(n);
    return Array.isArray(e) ? e.map((t) => String(t || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function tr(n) {
  if (typeof n != "string" || !n.trim() || n.trim() === "{}")
    return "";
  try {
    const e = JSON.parse(n);
    return !e || typeof e != "object" ? "" : Object.entries(e).map(([t, r]) => `${t}: ${String(r || "")}`).filter((t) => !t.endsWith(": ")).join("; ");
  } catch {
    return n;
  }
}
function wa(n) {
  const e = n.toLowerCase(), t = Array.from(e.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)).map((s) => s[0]), r = Array.from(e.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)).map((s) => s[0]), a = [];
  for (const s of r) {
    if (s.length === 1) {
      a.push(s);
      continue;
    }
    for (let i = 0; i < s.length - 1; i += 1)
      a.push(s.slice(i, i + 2));
    s.length <= 4 && a.push(s);
  }
  return [...t, ...a].filter(Boolean);
}
function ao(n) {
  const e = be("sha1").update(n).digest();
  return {
    index: e.readUInt32BE(0) % Lt,
    sign: (e[4] & 1) === 1 ? 1 : -1
  };
}
function rr(n) {
  const e = new Array(Lt).fill(0), t = /* @__PURE__ */ new Map();
  for (const a of wa(n))
    t.set(a, (t.get(a) || 0) + 1);
  for (const [a, s] of t) {
    const { index: i, sign: o } = ao(a);
    e[i] += o * Math.log1p(s);
  }
  const r = Math.sqrt(e.reduce((a, s) => a + s * s, 0));
  return r <= 0 ? e : e.map((a) => Number((a / r).toFixed(6)));
}
function so(n) {
  const e = Buffer.alloc(n.length * 4);
  for (let t = 0; t < n.length; t += 1)
    e.writeFloatLE(Number.isFinite(n[t]) ? n[t] : 0, t * 4);
  return e;
}
function oo(n, e) {
  if (!n)
    return [];
  const t = Buffer.isBuffer(n) ? n : Buffer.from(n), r = Math.floor(t.length / 4), a = e && e > 0 ? Math.min(e, r) : r, s = [];
  for (let i = 0; i < a; i += 1)
    s.push(t.readFloatLE(i * 4));
  return s;
}
function io(n, e) {
  const t = Math.min(n.length, e.length);
  let r = 0;
  for (let a = 0; a < t; a += 1)
    r += n[a] * e[a];
  return r;
}
function co(n, e) {
  const t = Array.from(new Set(wa(n)));
  if (t.length === 0)
    return 0;
  const r = e.toLowerCase();
  let a = 0;
  for (const s of t)
    r.includes(s) && (a += 1);
  return a / t.length;
}
function lo(n) {
  const e = n.replace(/\s+/g, " ").trim();
  if (!e)
    return [];
  if (e.length <= yn)
    return [e];
  const t = [];
  let r = 0;
  for (; r < e.length; ) {
    const a = Math.min(e.length, r + yn);
    if (t.push(e.slice(r, a)), a >= e.length)
      break;
    r = Math.max(0, a - ro);
  }
  return t;
}
async function Pt() {
  await S.$executeRawUnsafe(`
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
  const n = await S.$queryRawUnsafe("PRAGMA table_info(rag_vector_chunks);"), e = new Set(n.map((r) => r.name)), t = [
    ["embedding_blob", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_blob BLOB;"],
    ["embedding_dim", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_dim INTEGER;"],
    ["embedding_provider", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_provider TEXT NOT NULL DEFAULT 'hash';"],
    ["embedding_model", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'local-hash-v1';"]
  ];
  for (const [r, a] of t)
    e.has(r) || await S.$executeRawUnsafe(a);
  await S.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_novel ON rag_vector_chunks(novel_id);"), await S.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_source ON rag_vector_chunks(source_type, source_id);");
}
async function Sn(n) {
  var t;
  await Pt();
  const e = await S.$queryRaw`
        SELECT COUNT(*) as count FROM rag_vector_chunks WHERE novel_id = ${n};
    `;
  return Number(((t = e[0]) == null ? void 0 : t.count) || 0);
}
async function uo(n) {
  var d;
  const [e, t, r, a, s, i, o] = await Promise.all([
    S.character.findMany({
      where: { novelId: n },
      include: { items: { include: { item: !0 } } },
      orderBy: { sortOrder: "asc" }
    }),
    S.item.findMany({ where: { novelId: n }, orderBy: { sortOrder: "asc" } }),
    S.worldSetting.findMany({ where: { novelId: n }, orderBy: { sortOrder: "asc" } }),
    S.plotLine.findMany({
      where: { novelId: n },
      include: { points: { orderBy: { order: "asc" } } },
      orderBy: { sortOrder: "asc" }
    }),
    S.chapter.findMany({
      where: { volume: { novelId: n } },
      select: { id: !0, title: !0, content: !0, order: !0, volume: { select: { title: !0, order: !0 } } },
      orderBy: [{ volume: { order: "asc" } }, { order: "asc" }]
    }),
    S.chapterSummary.findMany({
      where: { novelId: n, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" }
    }),
    S.narrativeSummary.findMany({
      where: { novelId: n, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" }
    })
  ]), c = [];
  for (const l of e) {
    const m = tr(l.profile), h = Array.isArray(l.items) ? l.items.map((p) => {
      var f;
      return `${((f = p.item) == null ? void 0 : f.name) || ""}${p.note ? ` ${p.note}` : ""}`;
    }).filter(Boolean).join("; ") : "";
    c.push({
      novelId: n,
      sourceType: "character",
      sourceId: l.id,
      title: `Character: ${l.name}`,
      content: [
        l.name,
        l.role,
        l.description,
        m,
        h ? `Owned items: ${h}` : "",
        l.isStarred ? "starred important" : ""
      ].filter(Boolean).join(`
`)
    });
  }
  for (const l of t)
    c.push({
      novelId: n,
      sourceType: "item",
      sourceId: l.id,
      title: `${l.type || "Item"}: ${l.name}`,
      content: [l.name, l.type, l.description, tr(l.profile)].filter(Boolean).join(`
`)
    });
  for (const l of r)
    c.push({
      novelId: n,
      sourceType: "worldSetting",
      sourceId: l.id,
      title: `World: ${l.name}`,
      content: [l.name, l.type, l.content].filter(Boolean).join(`
`)
    });
  for (const l of a) {
    c.push({
      novelId: n,
      sourceType: "plotLine",
      sourceId: l.id,
      title: `Plot line: ${l.name}`,
      content: [l.name, l.description].filter(Boolean).join(`
`)
    });
    for (const m of l.points || [])
      c.push({
        novelId: n,
        sourceType: "plotPoint",
        sourceId: m.id,
        title: `Plot point: ${m.title}`,
        content: [l.name, m.title, m.type, m.status, m.description].filter(Boolean).join(`
`)
      });
  }
  for (const l of s) {
    const m = ya(l.content || "");
    m && c.push({
      novelId: n,
      sourceType: "chapter",
      sourceId: l.id,
      title: `${((d = l.volume) == null ? void 0 : d.title) || ""} ${l.title || ""}`.trim() || "Chapter",
      content: m
    });
  }
  for (const l of i)
    c.push({
      novelId: n,
      sourceType: "chapterSummary",
      sourceId: l.id,
      title: `Chapter summary: ${l.chapterId}`,
      content: [
        l.compressedMemory || l.summaryText,
        ...Je(l.keyFacts),
        ...Je(l.timelineHints),
        ...Je(l.openQuestions)
      ].filter(Boolean).join(`
`)
    });
  for (const l of o)
    c.push({
      novelId: n,
      sourceType: "narrativeSummary",
      sourceId: l.id,
      title: `${l.level || "novel"} summary: ${l.title || "latest"}`,
      content: [
        l.summaryText,
        ...Je(l.keyFacts),
        ...Je(l.unresolvedThreads),
        ...Je(l.hardConstraints)
      ].filter(Boolean).join(`
`)
    });
  return c;
}
async function ho(n) {
  const e = await S.chapter.findUnique({
    where: { id: n },
    select: {
      id: !0,
      title: !0,
      content: !0,
      volume: { select: { novelId: !0, title: !0 } }
    }
  });
  if (!(e != null && e.volume))
    return null;
  const t = ya(e.content || "");
  return t ? {
    novelId: e.volume.novelId,
    sourceType: "chapter",
    sourceId: e.id,
    title: `${e.volume.title || ""} ${e.title || ""}`.trim() || "Chapter",
    content: t
  } : {
    novelId: e.volume.novelId,
    sourceType: "chapter",
    sourceId: e.id,
    title: `${e.volume.title || ""} ${e.title || ""}`.trim() || "Chapter",
    content: ""
  };
}
async function Sa(n, e) {
  var t;
  switch (n) {
    case "chapter":
      return ho(e);
    case "character": {
      const r = await S.character.findUnique({
        where: { id: e },
        include: { items: { include: { item: !0 } } }
      });
      if (!r)
        return null;
      const a = tr(r.profile), s = Array.isArray(r.items) ? r.items.map((i) => {
        var o;
        return `${((o = i.item) == null ? void 0 : o.name) || ""}${i.note ? ` ${i.note}` : ""}`;
      }).filter(Boolean).join("; ") : "";
      return {
        novelId: r.novelId,
        sourceType: "character",
        sourceId: r.id,
        title: `Character: ${r.name}`,
        content: [
          r.name,
          r.role,
          r.description,
          a,
          s ? `Owned items: ${s}` : "",
          r.isStarred ? "starred important" : ""
        ].filter(Boolean).join(`
`)
      };
    }
    case "item": {
      const r = await S.item.findUnique({ where: { id: e } });
      return r ? {
        novelId: r.novelId,
        sourceType: "item",
        sourceId: r.id,
        title: `${r.type || "Item"}: ${r.name}`,
        content: [r.name, r.type, r.description, tr(r.profile)].filter(Boolean).join(`
`)
      } : null;
    }
    case "worldSetting": {
      const r = await S.worldSetting.findUnique({ where: { id: e } });
      return r ? {
        novelId: r.novelId,
        sourceType: "worldSetting",
        sourceId: r.id,
        title: `World: ${r.name}`,
        content: [r.name, r.type, r.content].filter(Boolean).join(`
`)
      } : null;
    }
    case "plotLine": {
      const r = await S.plotLine.findUnique({ where: { id: e } });
      return r ? {
        novelId: r.novelId,
        sourceType: "plotLine",
        sourceId: r.id,
        title: `Plot line: ${r.name}`,
        content: [r.name, r.description].filter(Boolean).join(`
`)
      } : null;
    }
    case "plotPoint": {
      const r = await S.plotPoint.findUnique({
        where: { id: e },
        include: { plotLine: { select: { name: !0 } } }
      });
      return r ? {
        novelId: r.novelId,
        sourceType: "plotPoint",
        sourceId: r.id,
        title: `Plot point: ${r.title}`,
        content: [(t = r.plotLine) == null ? void 0 : t.name, r.title, r.type, r.status, r.description].filter(Boolean).join(`
`)
      } : null;
    }
    case "chapterSummary": {
      const r = await S.chapterSummary.findUnique({ where: { id: e } });
      return !r || r.status !== "active" ? null : {
        novelId: r.novelId,
        sourceType: "chapterSummary",
        sourceId: r.id,
        title: `Chapter summary: ${r.chapterId}`,
        content: [
          r.compressedMemory || r.summaryText,
          ...Je(r.keyFacts),
          ...Je(r.timelineHints),
          ...Je(r.openQuestions)
        ].filter(Boolean).join(`
`)
      };
    }
    case "narrativeSummary": {
      const r = await S.narrativeSummary.findUnique({ where: { id: e } });
      return !r || r.status !== "active" ? null : {
        novelId: r.novelId,
        sourceType: "narrativeSummary",
        sourceId: r.id,
        title: `${r.level || "novel"} summary: ${r.title || "latest"}`,
        content: [
          r.summaryText,
          ...Je(r.keyFacts),
          ...Je(r.unresolvedThreads),
          ...Je(r.hardConstraints)
        ].filter(Boolean).join(`
`)
      };
    }
    default:
      return null;
  }
}
async function mo(n) {
  const e = n.settings;
  if (e != null && e.enabled && e.baseUrl.trim())
    try {
      const r = new to(e), a = Math.max(1, Math.min(64, e.batchSize || 8)), s = [];
      let i = e.model, o = e.dimensions || 0;
      for (let c = 0; c < n.texts.length; c += a) {
        const d = n.texts.slice(c, c + a), l = await r.embed(d);
        s.push(...l.embeddings), i = l.model, o = l.dimensions;
      }
      return { vectors: s, provider: "openai-compatible", model: i, dimensions: o, fallbackUsed: !1 };
    } catch (r) {
      if (!e.fallbackToHash)
        throw r;
      console.warn("[RAG] Embedding API failed; falling back to local hash vectors:", r);
      const a = r instanceof Error ? r.message : String(r);
      return { vectors: n.texts.map((i) => rr(i)), provider: "hash", model: "local-hash-v1", dimensions: Lt, fallbackUsed: !0, fallbackError: a };
    }
  return { vectors: n.texts.map((r) => rr(r)), provider: "hash", model: "local-hash-v1", dimensions: Lt, fallbackUsed: !!(e != null && e.enabled) };
}
async function Aa(n, e) {
  const t = [];
  for (const s of n) {
    const i = lo(s.content);
    for (let o = 0; o < i.length; o += 1)
      t.push({ doc: s, index: o, content: i[o] });
  }
  const r = await mo({
    texts: t.map((s) => `${s.doc.title}
${s.content}`),
    settings: e
  }), a = (/* @__PURE__ */ new Date()).toISOString();
  for (let s = 0; s < t.length; s += 1) {
    const i = t[s], o = r.vectors[s] || rr(`${i.doc.title}
${i.content}`), c = wn(`${i.doc.sourceType}:${i.doc.sourceId}:${i.index}:${i.content}`), d = wn(`${i.doc.novelId}:${i.doc.sourceType}:${i.doc.sourceId}:${i.index}`), l = r.provider === "hash" ? JSON.stringify(o) : "[]", m = so(o), h = o.length;
    await S.$executeRaw`
            INSERT INTO rag_vector_chunks (id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim, embedding_provider, embedding_model, content_hash, updated_at)
            VALUES (${d}, ${i.doc.novelId}, ${i.doc.sourceType}, ${i.doc.sourceId}, ${i.doc.title}, ${i.content}, ${l}, ${m}, ${h}, ${r.provider}, ${r.model}, ${c}, ${a});
        `;
  }
  return { chunks: t.length, sources: n.length, provider: r.provider, model: r.model, dimensions: r.dimensions, fallbackUsed: r.fallbackUsed, fallbackError: r.fallbackError };
}
async function fo(n, e) {
  await Pt();
  const t = await uo(n);
  return await S.$executeRaw`DELETE FROM rag_vector_chunks WHERE novel_id = ${n};`, Aa(t, e);
}
async function Mr(n) {
  if (await Pt(), n.novelId) {
    const t = await S.$executeRaw`
            DELETE FROM rag_vector_chunks
            WHERE novel_id = ${n.novelId}
              AND source_type = ${n.sourceType}
              AND source_id = ${n.sourceId};
        `;
    return { deleted: Number(t || 0) };
  }
  const e = await S.$executeRaw`
        DELETE FROM rag_vector_chunks
        WHERE source_type = ${n.sourceType}
          AND source_id = ${n.sourceId};
    `;
  return { deleted: Number(e || 0) };
}
async function po(n, e) {
  return await Pt(), await Mr({
    novelId: n.novelId,
    sourceType: n.sourceType,
    sourceId: n.sourceId
  }), n.content.trim() ? Aa([n], e) : {
    chunks: 0,
    sources: 1,
    provider: "none",
    model: "empty-source",
    dimensions: 0,
    fallbackUsed: !1
  };
}
async function Ea(n, e, t) {
  const r = await Sa(n, e);
  return r ? { ...await po(r, t), novelId: r.novelId, sourceType: r.sourceType, sourceId: r.sourceId } : {
    chunks: 0,
    sources: 0,
    provider: "none",
    model: "missing-source",
    dimensions: 0,
    fallbackUsed: !1,
    sourceType: n,
    sourceId: e
  };
}
async function go(n, e) {
  const t = await Ea("chapter", n, e);
  return { ...t, sourceId: t.sourceId };
}
async function Io(n) {
  var s;
  await Pt();
  const e = await S.$queryRaw`
        SELECT id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim
        FROM rag_vector_chunks
        WHERE novel_id = ${n.novelId};
    `;
  if (e.length === 0)
    return [];
  const t = rr(n.query), r = ((s = e.find((i) => Number(i.embedding_dim || 0) > 0)) == null ? void 0 : s.embedding_dim) || 0, a = r === 0 || r === Lt;
  return e.map((i) => {
    let o = co(n.query, `${i.title}
${i.content}`), c = "local_vector_lexical";
    if (a) {
      let d = oo(i.embedding_blob, i.embedding_dim);
      if (d.length === 0 && i.embedding_json)
        try {
          const l = JSON.parse(i.embedding_json);
          d = Array.isArray(l) ? l.map((m) => Number(m) || 0) : [];
        } catch {
          d = [];
        }
      d.length > 0 && (o = Math.max(o, io(t, d)), c = "local_vector_hash");
    }
    return {
      id: i.id,
      sourceType: i.source_type,
      sourceId: i.source_id,
      title: i.title,
      excerpt: i.content,
      metadata: { vectorSimilarity: Number(o.toFixed(4)), retrieval: c },
      score: Math.round(o * 100)
    };
  }).filter((i) => {
    var o;
    return Number(((o = i.metadata) == null ? void 0 : o.vectorSimilarity) || 0) >= no;
  }).sort((i, o) => (o.score || 0) - (i.score || 0)).slice(0, Math.max(1, Math.min(16, n.limit ?? 8)));
}
function vo(n, e) {
  const t = typeof n == "string" ? n.replace(/\s+/g, " ").trim() : "";
  return t ? t.length > e ? `${t.slice(0, e)}...` : t : "";
}
function gt(n) {
  if (typeof n != "string" || !n.trim())
    return [];
  try {
    const e = JSON.parse(n);
    return Array.isArray(e) ? e.map((t) => String(t || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function An(n) {
  if (typeof n != "string" || !n.trim() || n.trim() === "{}")
    return "";
  try {
    const e = JSON.parse(n);
    return !e || typeof e != "object" ? "" : Object.entries(e).map(([t, r]) => `${t}: ${String(r || "")}`).filter((t) => !t.endsWith(": ")).join("; ");
  } catch {
    return n;
  }
}
function De(n, e) {
  const t = String(n || "").toLowerCase();
  return e.some((r) => t.includes(r.toLowerCase()));
}
function rt(n, e, t) {
  return e === "future_plot_for_entity" && t === "plotPoint" ? n + 40 : e === "outline_next" && (t === "plotPoint" || t === "plotLine") ? n + 35 : e === "character_state" && (t === "character" || t === "relationship" || t === "item" || t === "map") ? n + 30 : e === "unresolved_threads" && (t === "narrativeSummary" || t === "chapterSummary" || t === "plotPoint") ? n + 25 : n;
}
function Oe(n, e) {
  const t = `E${n.length + 1}`, r = vo(e.excerpt, 900);
  r && n.push({ id: t, ...e, excerpt: r });
}
async function yo(n) {
  const [e, t, r] = await Promise.all([
    S.character.findMany({ where: { novelId: n }, select: { name: !0 } }),
    S.item.findMany({ where: { novelId: n }, select: { name: !0 } }),
    S.worldSetting.findMany({ where: { novelId: n }, select: { name: !0 } })
  ]), a = [...e, ...t, ...r].map((s) => String((s == null ? void 0 : s.name) || "").trim()).filter(Boolean);
  return Array.from(new Set(a));
}
async function wo(n) {
  var C, _, L, V, B, se, W, Q;
  const e = Math.max(4, Math.min(24, n.maxEvidenceItems ?? 12)), t = n.detection.entityNames, r = n.detection.keywords, a = n.detection.intent, s = [], i = [], o = /* @__PURE__ */ new Set(), c = (n.locale || "zh").startsWith("zh"), [d, l, m, h, p, f, I] = await Promise.all([
    S.character.findMany({
      where: { novelId: n.novelId },
      include: {
        items: { include: { item: !0 } },
        relationsAsSource: { include: { target: !0 } },
        relationsAsTarget: { include: { source: !0 } },
        mapMarkers: { include: { map: !0 } }
      },
      orderBy: [{ isStarred: "desc" }, { sortOrder: "asc" }],
      take: 100
    }),
    S.item.findMany({
      where: { novelId: n.novelId },
      include: { owners: { include: { character: !0 } } },
      orderBy: { sortOrder: "asc" },
      take: 120
    }),
    S.worldSetting.findMany({
      where: { novelId: n.novelId },
      orderBy: { sortOrder: "asc" },
      take: 80
    }),
    S.plotLine.findMany({
      where: { novelId: n.novelId },
      include: {
        points: {
          include: {
            anchors: { include: { chapter: { select: { title: !0, order: !0, volume: { select: { title: !0, order: !0 } } } } } }
          },
          orderBy: { order: "asc" }
        }
      },
      orderBy: { sortOrder: "asc" }
    }),
    S.narrativeSummary.findMany({
      where: { novelId: n.novelId, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: 3
    }),
    S.chapterSummary.findMany({
      where: { novelId: n.novelId, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: 100
    }),
    n.chapterId ? S.chapter.findUnique({
      where: { id: n.chapterId },
      select: { id: !0, title: !0, order: !0, volumeId: !0, volume: { select: { title: !0, order: !0 } } }
    }) : null
  ]);
  (C = n.selectedText) != null && C.trim() && (Oe(s, {
    sourceType: "currentContext",
    sourceId: n.chapterId || "selectedText",
    title: "Selected text",
    excerpt: n.selectedText,
    score: 95
  }), o.add("selected_text")), (_ = n.currentContent) != null && _.trim() && (Oe(s, {
    sourceType: "currentContext",
    sourceId: n.chapterId || "currentContent",
    title: I != null && I.title ? `Current chapter: ${I.title}` : "Current chapter context",
    excerpt: n.currentContent.slice(-1600),
    metadata: I ? { chapterOrder: I.order, volumeTitle: (L = I.volume) == null ? void 0 : L.title } : void 0,
    score: 55
  }), o.add("current_chapter_context")), (V = n.currentLocation) != null && V.trim() && (Oe(s, {
    sourceType: "currentContext",
    sourceId: "currentLocation",
    title: "Current location",
    excerpt: n.currentLocation,
    score: 50
  }), o.add("current_location"));
  const y = await Io({
    novelId: n.novelId,
    query: n.question,
    limit: Math.min(8, e),
    settings: n.embeddingSettings
  });
  for (const N of y)
    Oe(s, {
      ...N,
      score: 90 + Math.max(0, N.score || 0)
    });
  y.length > 0 && o.add("vector_chunks");
  const g = d.filter((N) => t.length === 0 ? r.some((X) => De(`${N.name} ${N.role} ${N.description} ${N.profile}`, [X])) : De(N.name, t));
  for (const N of g.slice(0, 8)) {
    const X = An(N.profile), J = Array.isArray(N.items) ? N.items.map((Y) => {
      var ne;
      return `${((ne = Y.item) == null ? void 0 : ne.name) || ""}${Y.note ? `(${Y.note})` : ""}`;
    }).filter(Boolean).join(", ") : "";
    Oe(s, {
      sourceType: "character",
      sourceId: N.id,
      title: `Character: ${N.name}`,
      excerpt: [
        N.role ? `Role: ${N.role}` : "",
        N.description ? `Description: ${N.description}` : "",
        X ? `Profile: ${X}` : "",
        J ? `Owned items: ${J}` : ""
      ].filter(Boolean).join(`
`),
      metadata: { name: N.name, isStarred: N.isStarred },
      score: rt(100 + (N.isStarred ? 10 : 0), a, "character")
    }), o.add("characters");
    for (const Y of [...N.relationsAsSource || [], ...N.relationsAsTarget || []].slice(0, 8)) {
      const ne = ((B = Y.target) == null ? void 0 : B.name) || ((se = Y.source) == null ? void 0 : se.name) || "";
      Oe(s, {
        sourceType: "relationship",
        sourceId: Y.id,
        title: `Relationship: ${N.name} - ${ne}`,
        excerpt: `${Y.relation || ""}${Y.description ? `: ${Y.description}` : ""}`,
        metadata: { characterName: N.name, relatedName: ne },
        score: rt(80, a, "relationship")
      });
    }
    for (const Y of (N.mapMarkers || []).slice(0, 6))
      Oe(s, {
        sourceType: "map",
        sourceId: Y.id,
        title: `Map: ${((W = Y.map) == null ? void 0 : W.name) || Y.mapId}`,
        excerpt: `${N.name} marker${Y.label ? `: ${Y.label}` : ""}`,
        metadata: { characterName: N.name, mapId: Y.mapId, mapType: (Q = Y.map) == null ? void 0 : Q.type },
        score: rt(70, a, "map")
      });
  }
  for (const N of l) {
    const X = `${N.name} ${N.type} ${N.description} ${N.profile}`;
    if (t.length > 0 && !De(X, t) || t.length === 0 && !r.some((ne) => De(X, [ne])))
      continue;
    const J = An(N.profile), Y = Array.isArray(N.owners) ? N.owners.map((ne) => {
      var de;
      return `${((de = ne.character) == null ? void 0 : de.name) || ""}${ne.note ? `(${ne.note})` : ""}`;
    }).filter(Boolean).join(", ") : "";
    Oe(s, {
      sourceType: "item",
      sourceId: N.id,
      title: `${N.type || "Item"}: ${N.name}`,
      excerpt: [
        N.description ? `Description: ${N.description}` : "",
        J ? `Profile: ${J}` : "",
        Y ? `Owners: ${Y}` : ""
      ].filter(Boolean).join(`
`),
      score: rt(78, a, "item")
    }), o.add("items");
  }
  for (const N of m) {
    const X = `${N.name} ${N.content} ${N.type}`;
    t.length > 0 && !De(X, t) || t.length === 0 && !r.some((J) => De(X, [J])) || (Oe(s, {
      sourceType: "worldSetting",
      sourceId: N.id,
      title: `World: ${N.name}`,
      excerpt: N.content,
      metadata: { type: N.type },
      score: 65
    }), o.add("world_settings"));
  }
  for (const N of h) {
    const X = t.length === 0 ? r.some((J) => De(`${N.name} ${N.description}`, [J])) : De(`${N.name} ${N.description}`, t);
    (X || a === "outline_next" || a === "unresolved_threads") && (Oe(s, {
      sourceType: "plotLine",
      sourceId: N.id,
      title: `Plot line: ${N.name}`,
      excerpt: N.description || N.name,
      score: rt(X ? 85 : 45, a, "plotLine")
    }), o.add("plot_outline"));
    for (const J of N.points || []) {
      const Y = `${N.name} ${N.description || ""} ${J.title} ${J.description || ""}`, ne = t.length === 0 ? r.some((je) => De(Y, [je])) : De(Y, t), de = a === "outline_next" && J.status !== "resolved", Pe = a === "unresolved_threads" && J.status !== "resolved";
      if (!ne && !de && !Pe)
        continue;
      const qe = Array.isArray(J.anchors) ? J.anchors.map((je) => {
        var ze;
        const Ue = je.chapter;
        return `${je.type}: ${((ze = Ue == null ? void 0 : Ue.volume) == null ? void 0 : ze.title) || ""} ${(Ue == null ? void 0 : Ue.title) || je.chapterId}`.trim();
      }).join("; ") : "";
      Oe(s, {
        sourceType: "plotPoint",
        sourceId: J.id,
        title: `Plot point: ${J.title}`,
        excerpt: [
          `Line: ${N.name}`,
          `Status: ${J.status || "active"}`,
          J.description ? `Description: ${J.description}` : "",
          qe ? `Anchors: ${qe}` : ""
        ].filter(Boolean).join(`
`),
        metadata: { plotLineId: N.id, status: J.status, type: J.type },
        score: rt((ne ? 105 : 70) + (J.status === "resolved" ? -20 : 20), a, "plotPoint")
      }), o.add("plot_points");
    }
  }
  const u = n.analysisScope || "current_chapter", v = u === "volume_structure" || u === "compare_two_paths";
  for (const N of v ? p : []) {
    const X = gt(N.unresolvedThreads), J = gt(N.keyFacts), Y = gt(N.hardConstraints), ne = [
      N.summaryText,
      J.length ? `Key facts: ${J.join("; ")}` : "",
      X.length ? `Unresolved threads: ${X.join("; ")}` : "",
      Y.length ? `Hard constraints: ${Y.join("; ")}` : ""
    ].filter(Boolean).join(`
`), de = t.length === 0 ? r.some((Pe) => De(ne, [Pe])) : De(ne, t);
    !de && !["outline_next", "unresolved_threads", "general_qa"].includes(a) || (Oe(s, {
      sourceType: "narrativeSummary",
      sourceId: N.id,
      title: `${N.level || "novel"} summary: ${N.title || "latest"}`,
      excerpt: ne,
      score: rt(de ? 90 : 55, a, "narrativeSummary")
    }), o.add("narrative_summaries"));
  }
  const w = f.filter((N) => I ? u === "current_chapter" ? N.chapterId === I.id : u === "nearby_chapters" ? typeof N.chapterOrder == "number" && Math.abs(N.chapterOrder - I.order) <= 3 : u === "volume_structure" ? N.volumeId === I.volumeId : !0 : u !== "current_chapter" || N.chapterId === n.chapterId);
  for (const N of w) {
    const X = gt(N.openQuestions), J = gt(N.timelineHints), Y = gt(N.keyFacts), ne = [
      N.compressedMemory || N.summaryText,
      Y.length ? `Key facts: ${Y.join("; ")}` : "",
      J.length ? `Timeline hints: ${J.join("; ")}` : "",
      X.length ? `Open questions: ${X.join("; ")}` : ""
    ].filter(Boolean).join(`
`), de = t.length === 0 ? r.some((Pe) => De(ne, [Pe])) : De(ne, t);
    !de && a !== "unresolved_threads" || (Oe(s, {
      sourceType: "chapterSummary",
      sourceId: N.id,
      title: `Chapter summary: ${N.chapterId}`,
      excerpt: ne,
      metadata: { chapterId: N.chapterId, chapterOrder: N.chapterOrder },
      score: rt(de ? 85 : 60, a, "chapterSummary")
    }), o.add("chapter_summaries"));
  }
  const A = Array.from(/* @__PURE__ */ new Set([...t, ...r])).slice(0, 6);
  for (const N of A) {
    const X = await Jr(n.novelId, N, 5, 0);
    for (const J of X.slice(0, 4))
      Oe(s, {
        sourceType: J.entityType === "idea" ? "idea" : "searchHit",
        sourceId: J.entityId,
        title: J.title || N,
        excerpt: J.preview || J.snippet,
        metadata: {
          keyword: N,
          chapterId: J.chapterId,
          volumeTitle: J.volumeTitle,
          matchType: J.matchType
        },
        score: J.matchType === "title" ? 62 : 42
      }), o.add("search_hits");
  }
  const T = /* @__PURE__ */ new Map();
  for (const N of s) {
    const X = `${N.sourceType}:${N.sourceId}:${N.title}`, J = T.get(X);
    (!J || (N.score || 0) > (J.score || 0)) && T.set(X, N);
  }
  const E = Array.from(T.values()).sort((N, X) => (X.score || 0) - (N.score || 0)).slice(0, e).map((N, X) => ({ ...N, id: `E${X + 1}` }));
  return E.length === 0 && i.push(c ? "未找到相关证据，本次回答应视为低置信度。" : "No relevant evidence found. The answer should be treated as low confidence."), {
    evidence: E,
    warnings: i,
    usedContext: Array.from(o)
  };
}
function En(n, e) {
  const t = [];
  return n != null && n.trim() && t.push(`[System Prompt]
${n.trim()}`), t.push(`[User Prompt]
${e.trim()}`), t.join(`

`);
}
function So(n, e) {
  const t = n.toLowerCase();
  return /不足以判断|资料不足|无法判断|insufficient|not enough/.test(t) ? "low" : /confidence\s*[:：]\s*high|置信度\s*[:：]\s*高/.test(t) ? "high" : /confidence\s*[:：]\s*low|置信度\s*[:：]\s*低/.test(t) ? "low" : e >= 5 ? "high" : e >= 2 ? "medium" : "low";
}
function Ao(n, e) {
  const t = /* @__PURE__ */ new Set();
  for (const r of n.matchAll(/\[?(E\d+)\]?/g)) {
    const a = r[1];
    e.includes(a) && t.add(a);
  }
  return Array.from(t).map((r) => ({ evidenceId: r, label: `[${r}]` }));
}
class Eo {
  async buildPromptBundle(e, t) {
    var h, p, f, I;
    const r = String(e.question || "").trim();
    if (!((h = e.novelId) != null && h.trim()))
      throw new Error("novelId is required");
    if (!r)
      throw new Error("question is required");
    const a = await yo(e.novelId), s = Zs(r, a), i = await wo({
      novelId: e.novelId,
      chapterId: e.chapterId,
      currentContent: e.currentContent,
      selectedText: e.selectedText,
      currentLocation: e.currentLocation,
      detection: s,
      question: r,
      maxEvidenceItems: e.maxEvidenceItems,
      analysisScope: e.analysisScope,
      locale: e.locale,
      embeddingSettings: t
    }), o = i.evidence.map((y) => `[${y.id}] ${y.sourceType} | ${y.title}
${y.excerpt}`).join(`

`), c = (e.locale || "zh").startsWith("zh"), d = c ? "你是云梦小说智能体中的 RAG 问答助手。你只能基于 Evidence 中提供的资料回答。如果资料不足，请明确说明不足以判断。请区分“已写事实”“大纲计划”“写作建议”。涉及剧情判断时必须引用证据标签，例如 [E1]。不要编造未提供的设定、章节或人物状态。" : "You are a RAG Q&A assistant inside CloudDream Novel Agent. Answer only from the provided Evidence. If evidence is insufficient, say so clearly. Separate written facts, outline plans, and writing suggestions. Cite evidence labels such as [E1]. Do not invent missing lore, chapters, or character state.", l = [
      `Question=${r}`,
      `Intent=${s.intent}`,
      `AnalysisScope=${e.analysisScope || "current_chapter"}`,
      s.entityNames.length ? `DetectedEntities=${s.entityNames.join(", ")}` : "DetectedEntities=none",
      s.keywords.length ? `Keywords=${s.keywords.join(", ")}` : "Keywords=none",
      (p = e.selectedText) != null && p.trim() ? "SelectedTextProvided=true" : "SelectedTextProvided=false",
      (f = e.currentLocation) != null && f.trim() ? `CurrentLocation=${e.currentLocation.trim()}` : "",
      "Evidence=",
      o || "(no relevant evidence found)",
      c ? "Output=用简洁中文回答。若能回答，请按“已写事实 / 大纲计划 / 写作建议 / 置信度”组织；没有对应内容可省略该小节。必须引用证据标签。" : "Output=Answer concisely. Organize as Written facts / Outline plans / Writing suggestions / Confidence when applicable. Omit empty sections. Cite evidence labels."
    ].filter(Boolean).join(`

`), m = (I = e.overrideUserPrompt) != null && I.trim() ? e.overrideUserPrompt.trim() : l;
    return {
      systemPrompt: d,
      defaultUserPrompt: l,
      effectiveUserPrompt: m,
      intent: s.intent,
      evidence: i.evidence,
      citations: i.evidence.map((y) => ({ evidenceId: y.id, label: `[${y.id}]` })),
      warnings: i.warnings,
      usedContext: i.usedContext
    };
  }
  async preview(e, t) {
    const r = await this.buildPromptBundle(e, t);
    return {
      ok: !0,
      question: e.question,
      intent: r.intent,
      answer: "",
      confidence: r.evidence.length > 0 ? "medium" : "low",
      evidence: r.evidence,
      citations: r.citations,
      warnings: r.warnings,
      usedContext: r.usedContext,
      rawPrompt: En(r.systemPrompt, r.effectiveUserPrompt),
      editableUserPrompt: r.defaultUserPrompt
    };
  }
  async ask(e, t, r) {
    const a = await this.buildPromptBundle(e, r.embeddingSettings), s = await t.generate({
      systemPrompt: a.systemPrompt,
      prompt: a.effectiveUserPrompt,
      maxTokens: r.maxTokens,
      temperature: r.temperature ?? 0.2,
      signal: r.signal
    }), i = a.evidence.map((c) => c.id), o = Ao(s.text, i);
    return {
      ok: !0,
      question: e.question,
      intent: a.intent,
      answer: s.text,
      confidence: So(s.text, a.evidence.length),
      evidence: a.evidence,
      citations: o.length > 0 ? o : a.citations.slice(0, 3),
      warnings: a.warnings,
      usedContext: a.usedContext,
      rawPrompt: En(a.systemPrompt, a.effectiveUserPrompt),
      editableUserPrompt: a.defaultUserPrompt
    };
  }
}
const To = {
  characterLocations: [],
  relationshipChanges: [],
  knowledgeChanges: [],
  itemStates: [],
  resolvedConflicts: [],
  openedConflicts: [],
  warnings: []
};
function ct(n) {
  return n && typeof n == "object" && !Array.isArray(n) ? n : {};
}
function ge(n, e) {
  return String(n ?? "").trim().slice(0, e);
}
function wr(n, e, t) {
  return Array.isArray(n) ? [...new Set(n.map((r) => ge(r, t)).filter(Boolean))].slice(0, e) : [];
}
function Co(n) {
  const e = ct(n);
  return {
    characterLocations: (Array.isArray(e.characterLocations) ? e.characterLocations : []).slice(0, 30).map(ct).map((t) => ({
      characterKey: ge(t.characterKey, 160),
      location: ge(t.location, 300),
      evidenceExcerpt: ge(t.evidenceExcerpt, 500)
    })).filter((t) => t.characterKey && t.location && t.evidenceExcerpt),
    relationshipChanges: (Array.isArray(e.relationshipChanges) ? e.relationshipChanges : []).slice(0, 30).map(ct).map((t) => ({
      sourceCharacterKey: ge(t.sourceCharacterKey, 160),
      targetCharacterKey: ge(t.targetCharacterKey, 160),
      change: ge(t.change, 500),
      evidenceExcerpt: ge(t.evidenceExcerpt, 500)
    })).filter((t) => t.sourceCharacterKey && t.targetCharacterKey && t.change && t.evidenceExcerpt),
    knowledgeChanges: (Array.isArray(e.knowledgeChanges) ? e.knowledgeChanges : []).slice(0, 30).map(ct).map((t) => ({
      characterKey: ge(t.characterKey, 160),
      learned: wr(t.learned, 20, 500),
      forgotten: wr(t.forgotten, 20, 500),
      evidenceExcerpt: ge(t.evidenceExcerpt, 500)
    })).filter((t) => t.characterKey && (t.learned.length > 0 || t.forgotten.length > 0) && t.evidenceExcerpt),
    itemStates: (Array.isArray(e.itemStates) ? e.itemStates : []).slice(0, 30).map(ct).map((t) => ({
      itemKey: ge(t.itemKey, 160),
      state: ge(t.state, 500),
      ...ge(t.holderKey, 160) ? { holderKey: ge(t.holderKey, 160) } : {},
      ...ge(t.location, 300) ? { location: ge(t.location, 300) } : {},
      evidenceExcerpt: ge(t.evidenceExcerpt, 500)
    })).filter((t) => t.itemKey && t.state && t.evidenceExcerpt),
    resolvedConflicts: (Array.isArray(e.resolvedConflicts) ? e.resolvedConflicts : []).slice(0, 20).map(ct).map((t) => ({ conflict: ge(t.conflict, 500), evidenceExcerpt: ge(t.evidenceExcerpt, 500) })).filter((t) => t.conflict && t.evidenceExcerpt),
    openedConflicts: (Array.isArray(e.openedConflicts) ? e.openedConflicts : []).slice(0, 20).map(ct).map((t) => ({ conflict: ge(t.conflict, 500), evidenceExcerpt: ge(t.evidenceExcerpt, 500) })).filter((t) => t.conflict && t.evidenceExcerpt),
    warnings: wr(e.warnings, 20, 500)
  };
}
function No(n, e) {
  const t = (r) => e.includes(r);
  return {
    ...To,
    characterLocations: n.characterLocations.filter((r) => t(r.evidenceExcerpt)),
    relationshipChanges: n.relationshipChanges.filter((r) => t(r.evidenceExcerpt)),
    knowledgeChanges: n.knowledgeChanges.filter((r) => t(r.evidenceExcerpt)),
    itemStates: n.itemStates.filter((r) => t(r.evidenceExcerpt)),
    resolvedConflicts: n.resolvedConflicts.filter((r) => t(r.evidenceExcerpt)),
    openedConflicts: n.openedConflicts.filter((r) => t(r.evidenceExcerpt)),
    warnings: n.warnings
  };
}
const Sr = 10 * 1024 * 1024, bo = 2e3, Tn = /* @__PURE__ */ new Set(["foreshadowing", "mystery", "promise", "event"]), Cn = /* @__PURE__ */ new Set(["active", "resolved"]), xo = /* @__PURE__ */ new Set(["item", "skill", "location"]), _o = /* @__PURE__ */ new Set(["world", "region", "scene"]), Ht = ["plotLines", "plotPoints", "characters", "items", "skills", "maps"], Ro = {
  plotLines: ["主线", "支线", "故事线", "剧情线", "plot line", "story line"],
  plotPoints: ["要点", "情节点", "剧情点", "事件", "桥段", "转折", "冲突", "plot point", "scene beat"],
  characters: ["角色", "龙套", "配角", "人物", "反派", "主角", "npc", "character"],
  items: ["物品", "道具", "装备", "宝物", "武器", "法宝", "artifact", "item"],
  skills: ["技能", "招式", "能力", "法术", "功法", "绝招", "spell", "skill"],
  maps: ["地图", "场景", "地点", "区域", "城市", "宗门地图", "world map", "map", "location"]
}, Ar = [
  "novel.list",
  "volume.list",
  "chapter.list",
  "chapter.create",
  "chapter.save",
  "chapter.generate"
], Do = [
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
], nt = {
  providerType: "http",
  http: {
    apiMode: "chat-completions",
    baseUrl: "",
    apiKey: "",
    model: "gpt-4.1-mini",
    imageModel: "doubao-seedream-5-0-260128",
    imageSize: "2K",
    imageOutputFormat: "png",
    imageWatermark: !1,
    timeoutMs: 6e4,
    maxTokens: 4096,
    contextWindowTokens: 0,
    temperature: 0.7
  },
  mcpCli: {
    cliPath: "",
    argsTemplate: "",
    workingDir: "",
    envJson: "{}",
    startupTimeoutMs: 6e4,
    contextWindowTokens: 0
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
    enabled: !1,
    baseUrl: "",
    apiKey: "",
    model: "bge-large-zh-v1.5",
    dimensions: 1024,
    batchSize: 8,
    timeoutMs: 6e4,
    fallbackToHash: !0
  }
};
function Er(n) {
  return JSON.stringify(n ?? {});
}
function Oo(n) {
  const e = (n || "").toLowerCase();
  return e.includes("jpeg") || e.includes("jpg") ? "jpg" : e.includes("webp") ? "webp" : e.includes("gif") ? "gif" : e.includes("bmp") ? "bmp" : "png";
}
function ko(n) {
  return n.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function Nn(n) {
  if (!(n != null && n.trim()))
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (a) => {
      !a || typeof a != "object" || (typeof a.text == "string" && t.push(a.text), Array.isArray(a.children) && a.children.forEach(r));
    };
    return r((e == null ? void 0 : e.root) || e), t.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return n.replace(/\s+/g, " ").trim();
  }
}
function Lo(n) {
  switch (n) {
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
function bn(n, e) {
  const t = [];
  return n != null && n.trim() && t.push(`[System Prompt]
${n.trim()}`), t.push(`[User Prompt]
${e.trim()}`), t.join(`

`);
}
function x(n, e) {
  const t = typeof n == "string" ? n.trim() : "";
  return t ? t.length > e ? t.slice(0, e) : t : "";
}
function It(n, e) {
  const t = /* @__PURE__ */ new Set(), r = [];
  for (const a of n) {
    const s = String(a || "").trim();
    if (!s)
      continue;
    const i = s.toLowerCase();
    if (!t.has(i) && (t.add(i), r.push(s), r.length >= e))
      break;
  }
  return r;
}
function Mo(n) {
  if (!n || typeof n != "object")
    return [];
  const e = n, t = [
    ...e.activeRun && typeof e.activeRun == "object" ? [e.activeRun] : [],
    ...Array.isArray(e.priorRuns) ? e.priorRuns : []
  ], r = /* @__PURE__ */ new Map();
  for (const a of t) {
    if (!a || typeof a != "object")
      continue;
    const s = a;
    for (const i of Array.isArray(s.artifacts) ? s.artifacts : []) {
      if (!i || typeof i != "object")
        continue;
      const o = i, c = x(o.artifactId, 160);
      c && r.set(c, {
        artifactId: c,
        ...o.runId || s.runId ? { runId: x(o.runId || s.runId, 160) } : {},
        ...o.type ? { type: x(o.type, 80) } : {},
        ...o.title ? { title: x(o.title, 240) } : {},
        ...o.status ? { status: x(o.status, 80) } : {},
        ...o.summary ? { summary: x(o.summary, 4e3) } : {},
        ...o.content ? { content: x(o.content, 4e4) } : {},
        ...o.reference && typeof o.reference == "object" ? { reference: o.reference } : {},
        ...o.metadata && typeof o.metadata == "object" ? { metadata: o.metadata } : {},
        ...o.createdAt ? { createdAt: x(o.createdAt, 80) } : {}
      });
    }
  }
  return [...r.values()];
}
function Po(n) {
  if (!n || typeof n != "object")
    return {};
  const e = n, t = (r) => {
    if (!r || typeof r != "object")
      return r;
    const a = r;
    return {
      ...a,
      artifacts: (Array.isArray(a.artifacts) ? a.artifacts : []).flatMap((s) => {
        if (!s || typeof s != "object")
          return [];
        const i = s;
        return [{
          artifactId: i.artifactId,
          runId: i.runId || a.runId,
          type: i.type,
          title: i.title,
          status: i.status,
          summary: x(i.summary, 800),
          reference: i.reference,
          createdAt: i.createdAt
        }];
      })
    };
  };
  return {
    ...e,
    activeRun: t(e.activeRun),
    priorRuns: Array.isArray(e.priorRuns) ? e.priorRuns.map(t) : []
  };
}
class Uo {
  constructor(e) {
    H(this, "userDataPath");
    H(this, "settingsFilePath");
    H(this, "mapImageStatsPath");
    H(this, "settingsCache");
    H(this, "mapImageStatsCache");
    H(this, "capabilityDefinitions");
    H(this, "capabilityRegistry");
    H(this, "contextBuilder");
    H(this, "agentContextAssembler");
    H(this, "novelRagService");
    this.userDataPath = e(), this.settingsFilePath = D.join(this.userDataPath, "ai-settings.json"), this.mapImageStatsPath = D.join(this.userDataPath, "ai-map-image-stats.json"), this.settingsCache = this.loadSettings(), this.mapImageStatsCache = this.loadMapImageStats(), this.contextBuilder = new Ls(), this.agentContextAssembler = new zs(), this.novelRagService = new Eo(), this.capabilityDefinitions = bs({
      buildChapterScopeContext: (t) => this.contextBuilder.buildForChapterScope(t),
      buildContinuationContext: (t) => this.contextBuilder.buildForContinueWriting(t),
      continueWriting: (t) => this.continueWriting(t),
      askNovel: (t) => this.askNovel(t),
      rebuildRagIndex: (t) => this.rebuildRagIndex(t)
    }), this.capabilityRegistry = new Map(
      this.capabilityDefinitions.map((t) => [t.actionId, t.handler])
    );
  }
  listActions() {
    return this.capabilityDefinitions.map((e) => ({
      actionId: e.actionId,
      title: e.title,
      description: e.description,
      permission: e.permission,
      inputSchema: e.inputSchema,
      outputSchema: e.outputSchema
    }));
  }
  getCapabilityCoverage() {
    const e = new Set(this.capabilityDefinitions.map((i) => i.actionId)), t = Do.map((i) => {
      const o = i.requiredActions.filter((l) => !e.has(l)), c = i.requiredActions.filter((l) => e.has(l)), d = i.requiredActions.length === 0 ? 0 : Math.round(c.length / i.requiredActions.length * 100);
      return {
        moduleId: i.moduleId,
        title: i.title,
        requiredActions: [...i.requiredActions],
        supportedActions: c,
        missingActions: o,
        coverage: d
      };
    }), r = t.reduce((i, o) => i + o.requiredActions.length, 0), a = t.reduce((i, o) => i + o.supportedActions.length, 0);
    return {
      overallCoverage: r === 0 ? 0 : Math.round(a / r * 100),
      totalRequired: r,
      totalSupported: a,
      modules: t
    };
  }
  getMcpToolsManifest() {
    return { tools: this.capabilityDefinitions.map((t) => ({
      name: t.actionId,
      description: `${t.title}. ${t.description}`,
      inputSchema: t.inputSchema
    })) };
  }
  getOpenClawManifest() {
    return {
      schemaVersion: "openclaw.tool.v1",
      tools: this.capabilityDefinitions.map((t) => ({
        name: t.actionId,
        description: `${t.title}. ${t.description}`,
        parameters: t.inputSchema
      }))
    };
  }
  getOpenClawSkillManifest() {
    return {
      schemaVersion: "openclaw.skill.v1",
      skills: this.capabilityDefinitions.map((t) => ({
        name: t.actionId,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema
      }))
    };
  }
  getSettings() {
    return this.settingsCache;
  }
  getMapImageStats() {
    return this.mapImageStatsCache;
  }
  updateSettings(e) {
    return this.settingsCache = {
      ...this.settingsCache,
      ...e,
      http: { ...this.settingsCache.http, ...e.http ?? {} },
      mcpCli: { ...this.settingsCache.mcpCli, ...e.mcpCli ?? {} },
      proxy: { ...this.settingsCache.proxy, ...e.proxy ?? {} },
      summary: { ...this.settingsCache.summary, ...e.summary ?? {} },
      embedding: { ...this.settingsCache.embedding, ...e.embedding ?? {} }
    }, this.persistSettings(), this.settingsCache;
  }
  async testConnection() {
    return this.getProvider().healthCheck();
  }
  async testMcp() {
    return new fn(this.settingsCache).healthCheck();
  }
  async testOpenClawMcp() {
    const e = await this.testOpenClawSmoke({ kind: "mcp" });
    return { ok: e.ok, detail: e.detail };
  }
  async testOpenClawSkill() {
    const e = await this.testOpenClawSmoke({ kind: "skill" });
    return { ok: e.ok, detail: e.detail };
  }
  async testOpenClawSmoke(e) {
    var y, g;
    const t = e.kind === "skill" ? "skill" : "mcp", r = t === "mcp" ? this.getOpenClawManifest().tools.map((u) => u.name) : this.getOpenClawSkillManifest().skills.map((u) => u.name);
    if (!r.length)
      return {
        ok: !1,
        kind: t,
        detail: t === "mcp" ? "No OpenClaw MCP tools available" : "No OpenClaw skills available",
        missingActions: [...Ar],
        checks: []
      };
    const a = Ar.filter((u) => !r.includes(u)), s = [], i = (u, v, w, A) => {
      s.push({ actionId: u, ok: v, detail: w, ...A ? { skipped: !0 } : {} });
    };
    a.length ? i("manifest.coverage", !1, `Missing required actions: ${a.join(", ")}`) : i("manifest.coverage", !0, `All required actions are covered (${Ar.length})`);
    const o = (u, v) => t === "mcp" ? this.invokeOpenClawTool({ name: u, arguments: v }) : this.invokeOpenClawSkill({ name: u, input: v }), c = await o("novel.list");
    if (!c.ok)
      return i("novel.list", !1, c.error || "invoke failed"), {
        ok: !1,
        kind: t,
        detail: `OpenClaw ${t.toUpperCase()} smoke failed at novel.list: ${c.error || "unknown error"}`,
        missingActions: a,
        checks: s
      };
    i("novel.list", !0, "invoke ok");
    const l = (y = (Array.isArray(c.data) ? c.data : []).find((u) => typeof (u == null ? void 0 : u.id) == "string")) == null ? void 0 : y.id;
    if (!l) {
      i("volume.list", !0, "no novels in database; skipped", !0), i("chapter.list", !0, "no novels in database; skipped", !0);
      const u = a.length === 0;
      return {
        ok: u,
        kind: t,
        detail: u ? `OpenClaw ${t.toUpperCase()} smoke passed (manifest coverage ok, invoke ok, nested checks skipped due to empty data)` : `OpenClaw ${t.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${a.join(", ")})`,
        missingActions: a,
        checks: s
      };
    }
    const m = await o("volume.list", { novelId: l });
    if (!m.ok)
      return i("volume.list", !1, m.error || "invoke failed"), {
        ok: !1,
        kind: t,
        detail: `OpenClaw ${t.toUpperCase()} smoke failed at volume.list: ${m.error || "unknown error"}`,
        missingActions: a,
        checks: s
      };
    i("volume.list", !0, "invoke ok");
    const p = (g = (Array.isArray(m.data) ? m.data : []).find((u) => typeof (u == null ? void 0 : u.id) == "string")) == null ? void 0 : g.id;
    if (!p) {
      i("chapter.list", !0, "no volumes under first novel; skipped", !0);
      const u = a.length === 0;
      return {
        ok: u,
        kind: t,
        detail: u ? `OpenClaw ${t.toUpperCase()} smoke passed (manifest coverage ok, read-chain invoke ok)` : `OpenClaw ${t.toUpperCase()} smoke partial pass (read-chain ok, but manifest missing required actions: ${a.join(", ")})`,
        missingActions: a,
        checks: s
      };
    }
    const f = await o("chapter.list", { volumeId: p });
    if (!f.ok)
      return i("chapter.list", !1, f.error || "invoke failed"), {
        ok: !1,
        kind: t,
        detail: `OpenClaw ${t.toUpperCase()} smoke failed at chapter.list: ${f.error || "unknown error"}`,
        missingActions: a,
        checks: s
      };
    i("chapter.list", !0, "invoke ok");
    const I = a.length === 0;
    return {
      ok: I,
      kind: t,
      detail: I ? `OpenClaw ${t.toUpperCase()} smoke passed (manifest coverage + read-chain invoke all ok)` : `OpenClaw ${t.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${a.join(", ")})`,
      missingActions: a,
      checks: s
    };
  }
  async testProxy() {
    const e = this.settingsCache.proxy;
    return e.mode !== "custom" ? { ok: !0, detail: `Proxy mode is ${e.mode}` } : !(e.httpProxy || e.httpsProxy || e.allProxy) ? { ok: !1, detail: "Custom proxy mode requires at least one proxy value" } : { ok: !0, detail: "Custom proxy configuration looks valid" };
  }
  async testGenerate(e) {
    var t;
    try {
      return { ok: !0, text: ((t = (await this.getProvider().generate({
        systemPrompt: "You are a concise assistant.",
        prompt: (e || "请用一句话回复：AI 生成测试成功").trim(),
        maxTokens: 128,
        temperature: 0.2
      })).text) == null ? void 0 : t.slice(0, 500)) || "" };
    } catch (r) {
      return { ok: !1, detail: (r == null ? void 0 : r.message) || "test generate failed" };
    }
  }
  assembleAgentContext(e) {
    const t = this.settingsCache.providerType, r = t === "http" ? this.settingsCache.http.model : "mcp-cli", a = t === "http" ? this.settingsCache.http.contextWindowTokens : this.settingsCache.mcpCli.contextWindowTokens, s = this.agentContextAssembler.assemble({
      providerType: t,
      model: r,
      contextWindowTokens: a,
      outputTokens: e.outputTokens,
      systemPrompt: e.systemPrompt,
      currentRequest: e.currentRequest,
      history: e.history,
      sections: e.sections,
      persistentSummary: e.persistentSummary,
      artifacts: e.artifacts
    });
    return $("INFO", "AiService.agentContext.assembled", "Agent model context assembled", {
      operation: e.operation,
      ...s.diagnostics
    }), s;
  }
  assembleAgentPrompt(e) {
    return this.assembleAgentContext(e).prompt;
  }
  assembleDraftGenerationPrompt(e) {
    return this.assembleAgentPrompt({
      operation: e.operation,
      systemPrompt: e.systemPrompt,
      outputTokens: e.outputTokens,
      currentRequest: e.structured,
      sections: [
        {
          id: "draft-generation-context",
          kind: "artifact",
          priority: "required",
          value: e.effectiveUserPrompt,
          sourceRef: "context-builder"
        },
        {
          id: "context-references",
          kind: "metadata",
          priority: "low",
          value: e.usedContext
        }
      ]
    });
  }
  async generateAgentChat(e, t) {
    const r = x(e.message, 8e3);
    if (!r)
      throw new k("INVALID_INPUT", "message is required");
    const a = (e.locale || "zh-CN").startsWith("zh"), s = {
      team: a ? "创作团队统筹" : "creative team supervisor",
      writer: a ? "小说作者" : "novel writer",
      editor: a ? "小说编辑" : "novel editor",
      reader: a ? "普通读者评审" : "reader reviewer",
      worldbuilding: a ? "世界观编辑" : "worldbuilding editor",
      research_rag: a ? "考据与证据整理员" : "research assistant"
    }, i = s[e.role] || s.team, o = (e.history || []).map((N) => ({
      role: N.role,
      content: String(N.content || "").trim(),
      ...N.createdAt ? { createdAt: String(N.createdAt) } : {},
      ...N.messageId ? { messageId: String(N.messageId) } : {}
    })).filter((N) => N.content), c = It(e.availableReadTools || [], 20), d = (e.availableReadToolDefinitions || []).filter((N) => N && c.includes(String(N.name || ""))).slice(0, 20).map((N) => ({
      name: x(N.name, 80),
      description: x(N.description, 800),
      inputSchema: N.inputSchema && typeof N.inputSchema == "object" ? N.inputSchema : {}
    })), l = (e.explorationNotes || []).map((N) => x(N, 3e3)).filter(Boolean).slice(-8), m = Array.isArray(e.availableOperations) ? e.availableOperations.slice(0, 30) : [], h = new Set(m.flatMap((N) => typeof (N == null ? void 0 : N.id) == "string" ? [N.id] : [])), p = (e.toolObservations || []).map((N) => ({
      toolName: x(N.toolName, 80),
      args: N.args,
      result: N.result ?? null,
      error: x(N.error, 1e3),
      ok: N.ok !== !1
    })), f = e.selectionContext && typeof e.selectionContext == "object" ? e.selectionContext : {}, I = f.chapterScope && typeof f.chapterScope == "object" ? f.chapterScope : null, y = {
      novelId: x(f.novelId, 160),
      novelTitle: x(f.novelTitle, 300),
      volumeId: x(f.volumeId, 160),
      chapterId: x(f.chapterId, 160),
      chapterTitle: x(f.chapterTitle, 300),
      ...f.attachmentScope && typeof f.attachmentScope == "object" ? {
        attachmentScope: f.attachmentScope
      } : {},
      ...Array.isArray(f.attachments) ? {
        attachments: f.attachments.slice(0, 10).map((N) => ({
          attachmentId: x(N == null ? void 0 : N.attachmentId, 160),
          fileName: x(N == null ? void 0 : N.fileName, 300),
          characterCount: Math.max(0, Number(N == null ? void 0 : N.characterCount) || 0)
        })).filter((N) => N.attachmentId)
      } : {},
      ...I ? {
        chapterScope: {
          kind: x(I.kind, 40),
          volumeId: x(I.volumeId, 160),
          chapterIds: It(Array.isArray(I.chapterIds) ? I.chapterIds : [], 20),
          anchorChapterId: x(I.anchorChapterId, 160),
          processingMode: x(I.processingMode, 20),
          experts: It(Array.isArray(I.experts) ? I.experts : [], 4)
        }
      } : {}
    }, g = x(f.currentContent, 12e4), u = a ? [
      `你是云梦小说智能体中的${i}。`,
      "自然、具体地回答创作问题。只有 ToolObservations 或 CurrentEditorContent 中存在结果时，才能声称已经读取对应的项目内容。",
      "PersistentSummary 是带来源 ID 的会话压缩投影，RecalledMessages/RecalledArtifacts 是按引用召回的原来源摘录；优先采用召回原文与工具证据，不得把旧助手结论当成项目事实。",
      "判断用户是在普通讨论，还是提出了需要读取项目上下文、检索、生成草稿或修改数据的明确任务。",
      "SelectionContext 是当前编辑器显式选中的项目范围。存在 chapterId 时，“这篇文章”“本章”“当前章”等指代必须直接绑定该章节，不得再次询问用户选择章节，也不得为定位它调用 novel.list、volume.list 或 chapter.list。需要持久化章节资料时直接使用该 chapterId 调用 chapter.get；CurrentEditorContent 是用户当前可见正文，优先于数据库中的旧正文。",
      "你可以从 AvailableReadTools 主动选择只读工具。回答依赖项目事实且 ToolObservations 不足时，先返回 toolCalls；每轮最多 3 个，不得调用名单外工具。",
      "AvailableReadToolDefinitions 是工具的真实参数结构，必须严格按其中的 inputSchema 调用；读取附件标题、页码、块或字符范围时优先使用 attachment.read。",
      "附件范围较长且返回 nextSelector 时，在 content 中保留截至当前块、不超过约 800 tokens 的累计发现，再继续读取；ExplorationNotes 会在下一轮带回这些发现。",
      "仅当 SelectionContext 没有可用目标，或用户明确要求跨章节、当前卷或全书范围时，才用 `volume.list` 发现真实 volumeId/chapterId；`chapter.list` 需要真实 volumeId，`chapter.get` 需要一个真实 chapterId。禁止虚构 ALL、ALL_IF_SUPPORTED 等占位 ID。",
      "收到 ToolObservations 后先综合结果；信息仍不足可继续调用只读工具，否则给出回答并将 toolCalls 设为空数组。",
      ...e.forceFinalization ? ["当前是强制总结轮，不得调用任何工具；必须基于已读证据作答，并明确覆盖范围和可能遗漏。"] : [],
      "从 AvailableOperations 中选择有序的 requestedOperations；复合任务必须保留用户要求的先后顺序，不得创造 Operation ID。",
      "requestedOperations 只包含用户当前明确要求执行的动作。问题、缺口、建议和可能的后续步骤不是执行授权：“检查需要补充说明之处”只请求审核，不请求生成素材；“给出润色建议”不请求改写；“评估续写准备度”不请求续写。只有用户明确要求起草、生成、续写或改写时，才选择 draft_write Operation。",
      "Role 只决定分析视角、能力范围和默认负责人，不得改变用户请求的 Operation、deliverable 或副作用等级。世界观角色下的只读检查仍然只能建议 report，不得因为角色擅长设定而追加 creative_asset.draft。",
      "尊重否定和交互约束。用户说“不要生成”“先别改”“只讨论”时，不得选择对应草稿 Operation；如果用户明确说“先检查，再起草”，则保留两个有序 Operation。",
      "同时建议 deliverable（none、report、expert_report、chapter_draft、chapter_draft_batch、creative_assets_draft）和 suggestedRole；结构化专家审核使用 expert_report，多章连续续写使用 chapter_draft_batch。这些只是语义建议，Runtime 会重新校验。",
      '只返回严格 JSON：{"content":"回复或当前意图","shouldPlan":true或false,"needsClarification":true或false,"requestedOperations":["chapter.consistency_review"],"deliverable":"report","suggestedRole":"editor","confidence":0.9,"toolCalls":[{"name":"plotline.list","args":{}}]}。',
      "项目中已有的大纲、章节、角色、设定和当前进度属于执行阶段可通过工具读取的信息；不要要求用户重复提供，也不要为读取这些信息而澄清，直接设置 shouldPlan=true。",
      "只有缺少无法通过项目工具获得、且会实质改变目标的用户偏好或创作决策时，才提出一个聚焦的澄清问题，设置 needsClarification=true 且 shouldPlan=false。",
      "在用户回答澄清问题之前不得生成计划；信息足以形成计划时，设置 needsClarification=false。",
      "明确且信息充分的任务 shouldPlan=true；寒暄、能力咨询和无需项目数据的轻量讨论 shouldPlan=false。"
    ].join(" ") : [
      `You are the ${i} inside CloudDream Novel Agent.`,
      "Answer naturally and specifically. Claim to have read project data only when ToolObservations or CurrentEditorContent contain the corresponding material.",
      "PersistentSummary is a traceable conversation projection. Prefer RecalledMessages, RecalledArtifacts, and tool evidence over summarized assistant outcomes, which are not project facts.",
      'SelectionContext is the explicit editor selection. When it includes chapterId, references such as "this article", "this chapter", or "current chapter" bind to it. Do not ask the user to select the chapter again and do not call novel.list, volume.list, or chapter.list merely to locate it. Use chapter.get with that exact ID when persisted data is needed. CurrentEditorContent is the visible editor text and takes precedence over an older saved body.',
      "When an answer depends on project facts and observations are insufficient, choose up to three tools from AvailableReadTools. After observations arrive, continue reading or answer with an empty toolCalls array.",
      "AvailableReadToolDefinitions contains the authoritative input schemas. Follow them exactly and prefer attachment.read for title, page, block, or offset ranges. Preserve no more than about 800 tokens of cumulative findings in content before requesting the next long-document chunk; ExplorationNotes will carry them forward.",
      "Use `volume.list` to discover IDs only when SelectionContext has no usable target or the user explicitly requests a multi-chapter, volume, or novel scope. `chapter.list` requires a real volumeId and `chapter.get` requires one real chapterId. Never invent placeholder IDs such as ALL or ALL_IF_SUPPORTED.",
      "Select ordered requestedOperations only from AvailableOperations. Preserve the requested order for compound tasks and never invent operation IDs.",
      "Include only actions the user explicitly asks to perform now. Findings, gaps, advice, and plausible next steps are not authorization. A request to identify missing explanations is review-only; polishing advice is not a rewrite; continuation readiness is not continuation. Select a draft_write operation only when the user explicitly requests drafting, generation, continuation, or rewriting.",
      "Role affects perspective, capability scope, and default ownership only. It must not change the requested operations, deliverable, or effect level. A read-only review remains read-only in the worldbuilding role.",
      'Respect negation and interaction constraints such as "do not generate", "do not rewrite", and "just discuss". Preserve both operations only when the user explicitly requests an ordered compound task such as review first, then draft.',
      "Suggest deliverable, suggestedRole, and confidence. They are untrusted semantic hints that the Runtime validates.",
      'Return strict JSON only: {"content":"reply or current intent","shouldPlan":boolean,"needsClarification":boolean,"requestedOperations":["chapter.consistency_review"],"deliverable":"report","suggestedRole":"editor","confidence":0.9,"toolCalls":[{"name":"plotline.list","args":{}}]}.',
      "Existing outlines, chapters, characters, lore, and project progress are available to approved execution tools. Do not ask the user to repeat them; set shouldPlan=true so the plan can read them.",
      "Ask one focused clarification question only when a user preference or creative decision unavailable from project tools would materially change the goal.",
      "Do not propose a plan until the user answers. Set needsClarification=false once enough information is available.",
      "Set shouldPlan=true only for sufficiently specified tasks that require project context, retrieval, draft generation, or data changes.",
      ...e.forceFinalization ? ["This is a forced finalization turn. Call no tools; answer from the evidence already read and state coverage and possible omissions."] : []
    ].join(" "), v = Math.min(this.settingsCache.http.maxTokens, 1600), w = [
      {
        id: "available-read-tools",
        kind: "metadata",
        priority: "low",
        value: d.length ? d : c
      },
      {
        id: "available-operations",
        kind: "metadata",
        priority: "high",
        value: m
      }
    ];
    e.intentPreflight && w.push({
      id: "intent-preflight",
      kind: "decision",
      priority: "required",
      value: e.intentPreflight
    }), (y.novelId || y.volumeId || y.chapterId) && w.push({
      id: "current-selection",
      kind: "metadata",
      priority: "required",
      value: y,
      sourceRef: "renderer-current-selection"
    }), g && w.push({
      id: "current-editor-content",
      kind: "retrieval",
      priority: "high",
      value: g,
      sourceRef: y.chapterId ? `chapter:${y.chapterId}:editor-buffer` : "renderer-editor-buffer",
      maxTokens: 12e3
    }), p.length && w.push({
      id: "tool-observations",
      kind: "tool",
      priority: "high",
      value: p,
      sourceRef: "current-exploration-turn"
    }), l.length && w.push({
      id: "exploration-notes",
      kind: "tool",
      priority: "high",
      value: l,
      sourceRef: "current-exploration-working-memory",
      maxTokens: 6e3
    });
    const A = Mo(e.conversationContext);
    e.conversationContext && Object.keys(e.conversationContext).length && w.push({
      id: "conversation-state",
      kind: "plan",
      priority: "high",
      value: Po(e.conversationContext),
      sourceRef: "persisted-agent-conversation"
    });
    const T = this.assembleAgentContext({
      operation: "agent.generate_chat",
      systemPrompt: u,
      outputTokens: v,
      currentRequest: {
        message: r,
        role: e.role || "team",
        workMode: e.approvalMode || "review_required",
        selection: y
      },
      history: o,
      sections: w,
      persistentSummary: e.persistentSummary,
      artifacts: A
    }), E = await this.getProvider().generate({
      systemPrompt: u,
      prompt: T.prompt,
      maxTokens: v,
      temperature: Math.min(this.settingsCache.http.temperature, 0.5),
      timeoutMs: e.forceFinalization ? Math.min(Math.max(this.settingsCache.http.timeoutMs, 15e3), 45e3) : Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), C = Ne(E.text), _ = x(C == null ? void 0 : C.content, 12e3) || x(E.text, 12e3);
    if (!_)
      throw new k("UNKNOWN", "Agent chat returned empty content");
    const L = Array.isArray(C == null ? void 0 : C.toolCalls) ? C.toolCalls.slice(0, 3).flatMap((N) => {
      if (!N || typeof N != "object")
        return [];
      const X = N, J = x(X.name, 80);
      return !J || !c.includes(J) ? [] : [{
        name: J,
        args: X.args && typeof X.args == "object" && !Array.isArray(X.args) ? X.args : {}
      }];
    }) : [], V = Array.isArray(C == null ? void 0 : C.requestedOperations) ? C.requestedOperations.slice(0, 8).flatMap((N) => {
      const X = x(N, 120);
      return X && h.has(X) ? [X] : [];
    }) : [], B = ["none", "report", "expert_report", "chapter_draft", "chapter_draft_batch", "creative_assets_draft"].includes(x(C == null ? void 0 : C.deliverable, 40)) ? x(C == null ? void 0 : C.deliverable, 40) : void 0, se = ["team", "writer", "editor", "reader", "worldbuilding", "research_rag"].includes(x(C == null ? void 0 : C.suggestedRole, 40)) ? x(C == null ? void 0 : C.suggestedRole, 40) : void 0, W = typeof (C == null ? void 0 : C.confidence) == "number" ? C.confidence : 0.5, Q = T.diagnostics;
    return {
      content: _,
      shouldPlan: (C == null ? void 0 : C.shouldPlan) === !0,
      needsClarification: (C == null ? void 0 : C.needsClarification) === !0,
      requestedOperations: V,
      deliverable: B,
      suggestedRole: se,
      confidence: Math.max(0, Math.min(1, W)),
      toolCalls: L,
      contextDiagnostics: Q,
      ...T.summaryUpdate ? { conversationSummary: T.summaryUpdate } : {},
      ...Q.compressionApplied ? {
        contextCompression: {
          applied: !0,
          model: Q.model,
          contextWindowTokens: Q.contextWindowTokens,
          inputBudgetTokens: Q.inputBudgetTokens,
          estimatedInputTokens: Q.estimatedInputTokens,
          historyMessagesTotal: Q.historyMessagesTotal,
          historyMessagesKept: Q.historyMessagesKept,
          historyMessagesSummarized: Q.historyMessagesSummarized,
          historyMessagesOmitted: Q.historyMessagesOmitted,
          historyMessagesCompacted: Q.historyMessagesCompacted,
          persistentSummaryRevision: Q.persistentSummaryRevision,
          persistentSummaryMessageCount: Q.persistentSummaryMessageCount,
          recalledMessageCount: Q.recalledMessageIds.length,
          recalledArtifactCount: Q.recalledArtifactIds.length,
          compressedSectionIds: Q.compressedSectionIds,
          omittedSectionIds: Q.omittedSectionIds
        }
      } : {}
    };
  }
  async generateChapterBeats(e, t) {
    const r = x(e.novelId, 160), a = x(e.chapterId, 160), s = x(e.goal, 4e3), i = Math.max(1, Math.min(5, Math.trunc(Number(e.chapterCount) || 0)));
    if (!r || !a || !s || !Number.isFinite(Number(e.chapterCount)))
      throw new k("INVALID_INPUT", "novelId, chapterId, goal and chapterCount are required");
    const o = (e.locale || "zh-CN").startsWith("zh"), d = e.taskMode === "batch_rewrite" ? o ? [
      "你是小说多章节改写节拍设计师。根据每个目标章节原文、共享范围上下文和用户目标，为明确选择的已有章节设计逐章修订节拍。",
      `必须返回严格 JSON，beats 必须恰好 ${i} 项，并与 TargetChapterIds 顺序一一对应。`,
      "每项字段为 title、chapterGoal、coreConflict、keyEvents、reveals、endingHook、targetWordCount。",
      "节拍必须说明该章要保留和强化的叙事功能，不得把改写任务变成新增后续章节，不得改变目标章节数量。",
      "只输出 JSON，不要输出 Markdown。"
    ].join(" ") : [
      "Design one rewrite beat for each explicitly selected existing chapter, in TargetChapterIds order.",
      `Return strict JSON with exactly ${i} beats. Do not turn rewrites into new continuation chapters.`,
      "Output JSON only."
    ].join(" ") : o ? [
      "你是小说多章节节拍设计师。根据已有上下文和用户目标，为连续新增章节设计可执行节拍。",
      `必须返回严格 JSON，beats 必须恰好 ${i} 项。`,
      "每项字段为 title、chapterGoal、coreConflict、keyEvents、reveals、endingHook、targetWordCount。",
      "keyEvents 和 reveals 必须是字符串数组；targetWordCount 为 100 到 50000 的整数。",
      "各章节需要前后依赖、逐步推进，不得重复同一事件，不得虚构与上下文明显冲突的既有事实。",
      "只输出 JSON，不要输出 Markdown。"
    ].join(" ") : [
      "Design an ordered batch of executable chapter beats from the supplied novel context.",
      `Return strict JSON with exactly ${i} beats.`,
      "Each beat requires title, chapterGoal, coreConflict, keyEvents, reveals, endingHook, and targetWordCount.",
      "Output JSON only."
    ].join(" "), l = JSON.stringify(e.context ?? {}).slice(0, 6e4), m = await this.getProvider().generate({
      systemPrompt: d,
      prompt: `Goal=${s}

AnchorChapterId=${a}

TargetChapterIds=${JSON.stringify(e.targetChapterIds || [])}

Context=${l}`,
      maxTokens: Math.min(this.settingsCache.http.maxTokens, 3200),
      temperature: Math.min(this.settingsCache.http.temperature, 0.55),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), h = Ne(m.text), p = Array.isArray(h == null ? void 0 : h.beats) ? h.beats : [];
    if (p.length !== i)
      throw new k("UNKNOWN", `Chapter beat generation returned ${p.length}/${i} beats`);
    return { beats: p.map((I, y) => {
      const g = x(I == null ? void 0 : I.title, 120), u = x(I == null ? void 0 : I.chapterGoal, 800), v = x(I == null ? void 0 : I.coreConflict, 800), w = x(I == null ? void 0 : I.endingHook, 800);
      if (!g || !u || !v || !w)
        throw new k("UNKNOWN", `Chapter beat ${y + 1} is incomplete`);
      const A = Math.max(100, Math.min(5e4, Math.trunc(Number(I == null ? void 0 : I.targetWordCount) || 2e3)));
      return {
        title: g,
        chapterGoal: u,
        coreConflict: v,
        keyEvents: Array.isArray(I == null ? void 0 : I.keyEvents) ? I.keyEvents.map((T) => x(T, 500)).filter(Boolean).slice(0, 12) : [],
        reveals: Array.isArray(I == null ? void 0 : I.reveals) ? I.reveals.map((T) => x(T, 500)).filter(Boolean).slice(0, 12) : [],
        endingHook: w,
        targetWordCount: A
      };
    }) };
  }
  async extractNarrativeState(e, t) {
    const r = x(e.generatedText, 8e4);
    if (!r)
      throw new k("INVALID_INPUT", "generatedText is required");
    const a = (e.locale || "zh-CN").startsWith("zh"), s = Array.isArray(e.characters) ? e.characters.slice(0, 100) : [], i = Array.isArray(e.items) ? e.items.slice(0, 100) : [], o = a ? [
      "你是小说章节状态增量提取器。只提取本章正文明确发生或明确揭示的变化，不做文学评价。",
      "所有 evidenceExcerpt 必须是本章正文中的连续原文短句；没有直接原文证据的变化必须省略。",
      "characterKey 和 itemKey 优先使用提供的实体 key；正文中新出现且没有登记 key 的实体使用正文中的明确名称。",
      "knowledgeChanges 只记录角色在本章实际得知或明确遗忘的信息，不得把读者知道的信息自动算作角色知道。",
      "关系变化必须是本章发生的信任、敌意、结盟、决裂等实际变化，普通对话不算变化。",
      "resolvedConflicts/openedConflicts 也必须有正文证据，不得仅根据节拍推断已经完成。",
      "只返回严格 JSON，不要 Markdown。",
      '格式：{"characterLocations":[{"characterKey":"角色key或名称","location":"章末位置","evidenceExcerpt":"正文原句"}],"relationshipChanges":[{"sourceCharacterKey":"角色","targetCharacterKey":"角色","change":"变化","evidenceExcerpt":"正文原句"}],"knowledgeChanges":[{"characterKey":"角色","learned":["得知事实"],"forgotten":[],"evidenceExcerpt":"正文原句"}],"itemStates":[{"itemKey":"物品","state":"章末状态","holderKey":"可选持有者","location":"可选位置","evidenceExcerpt":"正文原句"}],"resolvedConflicts":[{"conflict":"已解决冲突","evidenceExcerpt":"正文原句"}],"openedConflicts":[{"conflict":"新增冲突","evidenceExcerpt":"正文原句"}],"warnings":[]}。'
    ].join(" ") : [
      "Extract only explicit end-of-chapter narrative state changes from the supplied generated chapter.",
      "Every evidenceExcerpt must be an exact contiguous quote from the chapter. Omit unsupported inferences.",
      "Distinguish character knowledge from reader knowledge and report only actual relationship changes.",
      "Return strict JSON with characterLocations, relationshipChanges, knowledgeChanges, itemStates, resolvedConflicts, openedConflicts, and warnings."
    ].join(" "), c = await this.getProvider().generate({
      systemPrompt: o,
      prompt: [
        `KnownCharacters=${JSON.stringify(s)}`,
        `KnownItems=${JSON.stringify(i)}`,
        `CurrentBeat=${JSON.stringify(e.currentBeat || {}).slice(0, 8e3)}`,
        `PriorStateLedger=${JSON.stringify(e.priorStateLedger || {}).slice(0, 16e3)}`,
        `GeneratedChapter=${r}`
      ].join(`

`),
      maxTokens: Math.min(this.settingsCache.http.maxTokens, 3200),
      temperature: Math.min(this.settingsCache.http.temperature, 0.1),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), d = Ne(c.text);
    if (!d)
      throw new k("UNKNOWN", "Narrative state extraction returned invalid JSON");
    const l = Co(d), m = No(l, r), h = new Set(s.flatMap((g) => [g.key, g.name]).filter(Boolean)), p = new Set(i.flatMap((g) => [g.key, g.name]).filter(Boolean)), f = (g) => h.has(g) || r.includes(g), I = (g) => p.has(g) || r.includes(g);
    return { delta: {
      ...m,
      characterLocations: m.characterLocations.filter((g) => f(g.characterKey)),
      relationshipChanges: m.relationshipChanges.filter((g) => f(g.sourceCharacterKey) && f(g.targetCharacterKey)),
      knowledgeChanges: m.knowledgeChanges.filter((g) => f(g.characterKey)),
      itemStates: m.itemStates.filter((g) => I(g.itemKey) && (!g.holderKey || f(g.holderKey)))
    } };
  }
  async generateAgentPlan(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    const a = It(e.availableTools || [], 50), s = Array.isArray(e.availableToolchains) ? e.availableToolchains.slice(0, 20) : [];
    if (!a.length)
      throw new k("INVALID_INPUT", "availableTools is required");
    const i = (e.locale || "zh-CN").startsWith("zh"), o = i ? [
      "你是小说创作 Agent 的计划器，只负责拆解计划，不执行工具。",
      "返回 1 到 8 个可审核步骤，每步指定一个 agent 和零到多个工具。",
      "agent 只能是 supervisor、writer、editor、reader、worldbuilding、research_rag。",
      "PreferredRole 不是 team 时，它是主视角和最终产出负责人；只在任务确有需要时加入辅助 agent，除非用户要求，否则不要加入 reader 评估。",
      "必须声明 deliverable：普通分析为 report；带逐条 finding、证据与审批的作者/编辑/读者/世界观/考据/团队审核为 expert_report；单章正文续写或改写为 chapter_draft；连续生成多章为 chapter_draft_batch；大纲、剧情线、角色、世界观或创作素材的新增与修改为 creative_assets_draft。",
      "草稿产物必须有且仅有一个生产者：优先选择能产生目标草稿的 AvailableToolchain；没有匹配链时，chapter_draft 才使用 chapter.generate_draft，creative_assets_draft 才使用 creative_assets.generate_draft。",
      "tools 只能从 AvailableTools 中选择；不要添加写回正文步骤，草稿必须停在审核阶段。",
      "AvailableToolchains 是经过校验的稳定流程。上下文装配、一致性审校、章节续写和创作素材生成等匹配任务应优先选择对应 Toolchain，不要重新拼装同一批原子 tools。",
      "IntentDecision 是 Runtime 校验后的高优先级任务提示。严格保持 operations 顺序、deliverable 和建议 Toolchain；能力不可用时才回退到 AvailableTools。",
      '使用 Toolchain 的步骤必须令 tools=[]，并填写 toolchain={"id":"稳定ID","version":"版本","input":{}}；不得猜测未列出的 ID 或版本。',
      '只返回严格 JSON：{"title":"计划标题","deliverable":"report|expert_report|chapter_draft|chapter_draft_batch|creative_assets_draft","steps":[{"agent":"editor","title":"步骤","tools":[],"toolchain":{"id":"chapter.consistency_review","version":"1.0.0","input":{}}}]}。'
    ].join(" ") : [
      "You plan tasks for a novel-writing agent. Plan only; do not execute tools.",
      "Return 1-8 reviewable steps as strict JSON with title and steps.",
      "Agents: supervisor, writer, editor, reader, worldbuilding, research_rag.",
      "When PreferredRole is not team, keep it as the primary perspective and deliverable owner. Do not add reader evaluation unless the user requests it.",
      "Declare deliverable as report, expert_report, chapter_draft, chapter_draft_batch, or creative_assets_draft. Use expert_report for structured expert findings and review. Use chapter_draft_batch for multi-chapter continuation. A draft deliverable must have exactly one producer.",
      "Use only AvailableTools. Generated changes must stop at draft review and never write directly.",
      "Prefer a matching AvailableToolchain for context assembly, consistency review, chapter continuation, or creative-asset drafting. A Toolchain step must have tools=[] and a listed id/version.",
      "IntentDecision is a validated high-priority planning hint. Preserve operation order and deliverable, using suggested Toolchains when available."
    ].join(" "), c = Math.min(this.settingsCache.http.maxTokens, 2400), d = this.assembleAgentPrompt({
      operation: "agent.generate_plan",
      systemPrompt: o,
      outputTokens: c,
      currentRequest: {
        goal: r,
        preferredRole: e.role || "team",
        intentDecision: e.intentDecision || null
      },
      sections: [{
        id: "available-tools",
        kind: "metadata",
        priority: "high",
        value: a
      }, {
        id: "available-toolchains",
        kind: "metadata",
        priority: "high",
        value: s
      }, {
        id: "intent-decision",
        kind: "decision",
        priority: e.intentDecision ? "required" : "low",
        value: e.intentDecision || null
      }]
    }), l = await this.getProvider().generate({
      systemPrompt: o,
      prompt: d,
      maxTokens: c,
      temperature: Math.min(this.settingsCache.http.temperature, 0.35),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), m = Ne(l.text);
    if (!m || !Array.isArray(m.steps))
      throw new k("UNKNOWN", "Agent planner did not return valid JSON steps");
    return {
      title: x(m.title, 120) || (i ? "创作任务计划" : "Writing task plan"),
      deliverable: x(m.deliverable, 40),
      steps: m.steps
    };
  }
  async reviseAgentPlan(e, t) {
    var f;
    const r = x(e.goal, 12e3), a = x(e.revision, 8e3);
    if (!r || !a)
      throw new k("INVALID_INPUT", "goal and revision are required");
    const s = It(e.availableTools || [], 50), i = Array.isArray(e.availableToolchains) ? e.availableToolchains.slice(0, 20) : [];
    if (!s.length)
      throw new k("INVALID_INPUT", "availableTools is required");
    const o = Array.isArray((f = e.currentPlan) == null ? void 0 : f.steps) ? e.currentPlan.steps.slice(0, 8) : [];
    if (!o.length)
      throw new k("INVALID_INPUT", "currentPlan.steps is required");
    const d = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说创作 Agent 的计划修订器，只修改结构化计划，不执行工具。",
      "根据 Revision 精确增删、重排或修改步骤，不要忽略用户意见。",
      "未改变的步骤保留原 stepId；新增步骤不要填写 stepId。",
      "agent 只能是 supervisor、writer、editor、reader、worldbuilding、research_rag。",
      "tools 只能从 AvailableTools 中选择；任何生成内容必须停在草稿审核，禁止直接写回。",
      "保留仍适用的 Toolchain 调用；新选 Toolchain 只能来自 AvailableToolchains，且该步骤 tools 必须为空。",
      "保留或按用户意见更新 currentPlan.deliverable；草稿产物必须保留对应的 generate_draft 工具。",
      '只返回严格 JSON：{"title":"计划标题","deliverable":"report|expert_report|chapter_draft|chapter_draft_batch|creative_assets_draft","steps":[{"stepId":"可选原ID","agent":"editor","title":"步骤","tools":[]}]}。'
    ].join(" ") : [
      "Revise a structured novel-agent plan without executing it.",
      "Apply the revision precisely. Preserve stepId for unchanged steps and omit it for new steps.",
      "Use only the allowed agents and AvailableTools. Generated changes must stop at draft review.",
      "Return strict JSON with title and steps only."
    ].join(" "), l = Math.min(this.settingsCache.http.maxTokens, 2400), m = this.assembleAgentPrompt({
      operation: "agent.revise_plan",
      systemPrompt: d,
      outputTokens: l,
      currentRequest: {
        goal: r,
        revision: a,
        preferredRole: e.role || "team"
      },
      sections: [
        {
          id: "current-plan",
          kind: "plan",
          priority: "required",
          value: { title: e.currentPlan.title, deliverable: e.currentPlan.deliverable, steps: o }
        },
        {
          id: "available-tools",
          kind: "metadata",
          priority: "high",
          value: s
        },
        {
          id: "available-toolchains",
          kind: "metadata",
          priority: "high",
          value: i
        }
      ]
    }), h = await this.getProvider().generate({
      systemPrompt: d,
      prompt: m,
      maxTokens: l,
      temperature: Math.min(this.settingsCache.http.temperature, 0.25),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), p = Ne(h.text);
    if (!p || !Array.isArray(p.steps))
      throw new k("UNKNOWN", "Agent plan revision did not return valid JSON steps");
    return {
      title: x(p.title, 120) || e.currentPlan.title,
      deliverable: x(p.deliverable, 40),
      steps: p.steps
    };
  }
  async generateAgentConsistencyReview(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    if (!e.contextBundle || typeof e.contextBundle != "object")
      throw new k("INVALID_INPUT", "contextBundle is required");
    const s = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说章节一致性审核器，只能依据 ContextBundle 中的章节与项目证据作判断。",
      "分别检查人物行为与状态、情节线与时间顺序、世界规则、地点、物品和技能。",
      "没有项目证据时不得把推测写成事实：evidence 必须为空，并在 uncertainty 中明确需要人工确认。",
      "同一问题只输出一次。每条 evidence 只能引用 ContextBundle 中实际存在的来源，不得伪造 ID、标题或原文。",
      "无法检查的维度放入 uncheckableDimensions，不要为了凑分数编造结论。",
      "只返回一个严格 JSON 对象，不要 Markdown 或代码围栏。",
      '格式：{"overallScore":0,"summary":"摘要","dimensions":[{"id":"character","label":"人物","score":0,"reason":"依据","checkable":true}],"issues":[{"issueId":"issue-1","type":"character_state","severity":"critical|high|medium|low|info","title":"问题","location":"章节位置","excerpt":"章节短引文","evidence":[{"sourceType":"character","sourceId":"可选","title":"来源","excerpt":"证据","confidence":0.8,"metadata":{}}],"recommendation":"建议","uncertainty":"不确定性"}],"uncheckableDimensions":[{"dimension":"维度","reason":"原因"}],"warnings":[]}。'
    ].join(" ") : [
      "Review chapter consistency using only the supplied ContextBundle.",
      "Check character state, plot and timeline, world rules, locations, items, and skills.",
      "Never state an unsupported inference as fact. Leave evidence empty and explain uncertainty when project evidence is missing.",
      "Deduplicate issues and list uncheckable dimensions explicitly.",
      "Return one strict JSON object only, with overallScore, summary, dimensions, issues, uncheckableDimensions, and warnings."
    ].join(" "), i = Math.min(this.settingsCache.http.maxTokens, 4200), o = this.assembleAgentPrompt({
      operation: "agent.generate_consistency_review",
      systemPrompt: s,
      outputTokens: i,
      currentRequest: {
        goal: r,
        dimensions: Array.isArray(e.dimensions) ? e.dimensions.slice(0, 12) : []
      },
      sections: [{
        id: "context-bundle",
        kind: "retrieval",
        priority: "required",
        value: e.contextBundle,
        sourceRef: "chapter.context@1.0.0"
      }]
    }), c = await this.getProvider().generate({
      systemPrompt: s,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 18e4),
      signal: t
    }), d = Ne(c.text);
    if (!d || !Array.isArray(d.dimensions) || !Array.isArray(d.issues))
      throw new k("UNKNOWN", "Consistency reviewer did not return valid structured JSON");
    return d;
  }
  async generateAgentWriterRangeRevisionPlan(e, t) {
    var m, h;
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new k("INVALID_INPUT", "scopeBundle is required");
    const s = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说作者的多章节修订规划器，只能依据 ChapterScopeBundle 中已批准范围、正文/摘要、项目资料和检索证据作判断。",
      "评估文风漂移、场景强弱、章节作用、改写优先级和继续创作前的准备度；这是修订计划，不直接改写正文。",
      "finding.chapterIds 和 rewriteOrder 只能使用 scope.chapterIds 中的真实 ID。evidence.sourceId 和 evidenceRefs 只能引用 bundle 中真实存在的来源。",
      "不得伪造章节、引文、证据 ID 或已经发生的修改。证据不足时 evidence 与 evidenceRefs 置空，并在 uncertainty 中说明。",
      "rewriteOrder 只列确有必要改写的章节，按优先级排序；continuationReadiness 说明继续写之前需要先处理什么。",
      "recommendedRole 只能是 writer、editor、worldbuilding、research_rag。只返回严格 JSON 对象，不要 Markdown 或代码围栏。",
      '格式：{"overallScore":0,"summary":"摘要","dimensions":[{"id":"style_drift","label":"文风稳定性","score":0,"reason":"依据","checkable":true}],"findings":[{"findingId":"finding-1","title":"修订项","summary":"判断","category":"style_drift|scene_strength|rewrite_priority|continuation_readiness|other","severity":"critical|high|medium|low|info","chapterIds":["真实章节ID"],"evidenceRefs":["真实来源ID"],"evidence":[{"sourceType":"chapter|character|plotline|rag","sourceId":"真实ID","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendation":"可执行修订建议","recommendedRole":"writer|editor|worldbuilding|research_rag","uncertainty":"不确定性"}],"rewriteOrder":["真实章节ID"],"continuationReadiness":"续写准备判断","recommendations":["总体建议"],"warnings":[]}。'
    ].join(" ") : [
      "Plan revisions for an approved multi-chapter range as a fiction writer using only the supplied ChapterScopeBundle.",
      "Assess style drift, scene strength, chapter function, rewrite priority, and readiness for continued writing. Do not rewrite prose.",
      "Use only real target chapter IDs and real evidence source IDs from the bundle. Never fabricate text, IDs, evidence, or completed changes.",
      "Order only chapters that genuinely need rewriting and explain continuation readiness. Return one strict JSON object only."
    ].join(" "), i = Array.isArray((h = (m = e.scopeBundle) == null ? void 0 : m.scope) == null ? void 0 : h.chapterIds) ? e.scopeBundle.scope.chapterIds.length : 1, o = Math.min(
      this.settingsCache.http.maxTokens,
      Math.min(6e3, Math.max(2800, 2200 + i * 240))
    ), c = this.assembleAgentPrompt({
      operation: "agent.generate_writer_range_revision_plan",
      systemPrompt: s,
      outputTokens: o,
      currentRequest: {
        goal: r,
        dimensions: Array.isArray(e.dimensions) ? e.dimensions.slice(0, 12) : []
      },
      sections: [{
        id: "chapter-scope-bundle",
        kind: "retrieval",
        priority: "required",
        value: e.scopeBundle,
        sourceRef: "writer.range_revision_plan@1.0.0"
      }]
    }), d = await this.getProvider().generate({
      systemPrompt: s,
      prompt: c,
      maxTokens: o,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), l = Ne(d.text);
    if (!l || !Array.isArray(l.dimensions) || !Array.isArray(l.findings))
      throw new k("UNKNOWN", "Writer revision planner did not return valid structured JSON");
    return l;
  }
  async generateAgentEditorRangeReview(e, t) {
    var m, h;
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new k("INVALID_INPUT", "scopeBundle is required");
    const s = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说编辑的多章节范围审核器，只能依据 ChapterScopeBundle 中已批准范围、正文/摘要、项目资料和检索证据作判断。",
      "从结构、节奏、人物动机、文字质量和跨章连续性审核；只做编辑分析，不做读者体验、世界观专审或事实考据报告。",
      "finding.chapterIds 只能使用 scope.chapterIds 中的真实 ID。evidence.sourceId 和 evidenceRefs 只能引用 chapters、entityContext、plotContext、narrativeSummaries 或 evidence 中真实存在的 ID。",
      "不得伪造章节、引文、证据 ID 或已经发生的修改。证据不足时 evidence 与 evidenceRefs 置空，并在 uncertainty 中说明。",
      "问题要去重并可执行。recommendedRole 只能是 writer、editor、worldbuilding、research_rag。",
      "只返回严格 JSON 对象，不要 Markdown 或代码围栏。",
      '格式：{"overallScore":0,"summary":"摘要","dimensions":[{"id":"structure","label":"结构","score":0,"reason":"依据","checkable":true}],"findings":[{"findingId":"finding-1","title":"问题","summary":"判断","category":"structure|pacing|motivation|prose|continuity|other","severity":"critical|high|medium|low|info","chapterIds":["真实章节ID"],"evidenceRefs":["真实来源ID"],"evidence":[{"sourceType":"chapter|character|plotline|rag","sourceId":"真实ID","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendation":"修订建议","recommendedRole":"writer|editor|worldbuilding|research_rag","uncertainty":"不确定性"}],"recommendations":["总体建议"],"warnings":[]}。'
    ].join(" ") : [
      "Review an approved multi-chapter range as a novel editor using only the supplied ChapterScopeBundle.",
      "Assess structure, pacing, character motivation, prose quality, and cross-chapter continuity. Do not produce reader, worldbuilding, or fact-check reports.",
      "Use only real target chapter IDs and real evidence source IDs from the bundle. Never fabricate text, IDs, evidence, or project changes.",
      "Leave evidence empty and explain uncertainty when support is insufficient. Deduplicate findings and make recommendations actionable.",
      "Return one strict JSON object with overallScore, summary, dimensions, findings, recommendations, and warnings."
    ].join(" "), i = Array.isArray((h = (m = e.scopeBundle) == null ? void 0 : m.scope) == null ? void 0 : h.chapterIds) ? e.scopeBundle.scope.chapterIds.length : 1, o = Math.min(
      this.settingsCache.http.maxTokens,
      Math.min(6e3, Math.max(2800, 2200 + i * 240))
    ), c = this.assembleAgentPrompt({
      operation: "agent.generate_editor_range_review",
      systemPrompt: s,
      outputTokens: o,
      currentRequest: {
        goal: r,
        dimensions: Array.isArray(e.dimensions) ? e.dimensions.slice(0, 12) : []
      },
      sections: [{
        id: "chapter-scope-bundle",
        kind: "retrieval",
        priority: "required",
        value: e.scopeBundle,
        sourceRef: "editor.range_review@1.0.0"
      }]
    }), d = await this.getProvider().generate({
      systemPrompt: s,
      prompt: c,
      maxTokens: o,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), l = Ne(d.text);
    if (!l || !Array.isArray(l.dimensions) || !Array.isArray(l.findings))
      throw new k("UNKNOWN", "Editor range reviewer did not return valid structured JSON");
    return l;
  }
  async generateAgentReaderChapterEvaluation(e, t) {
    var h, p;
    const r = x((h = e.chapter) == null ? void 0 : h.chapterId, 200), a = x((p = e.chapter) == null ? void 0 : p.content, 8e4);
    if (!r || !a)
      throw new k("INVALID_INPUT", "chapter.chapterId and chapter.content are required");
    const s = x(e.priorReaderState, 2e3), o = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是首次阅读小说的普通读者评估器，必须严格按章节顺序盲读。",
      "你只能知道本次输入的当前章节，以及 priorReaderState 中前序章节留下的读者记忆。不得使用未来章节、世界观后台资料、人物卡、情节线、检索资料或其他专家结论。",
      "不要把猜测当作事实；只评估当前章造成的困惑、情绪、悬念、沉浸感、弃读风险与追更动力。",
      "findings 中 chapterIds、evidenceRefs 和 evidence.sourceId 只能使用当前 chapterId，evidence.sourceType 只能是 chapter。",
      "readerStateSummary 必须是供下一章读者继承的简洁已知状态，只记录读者已看到的事实、未解疑问、情绪和期待，不得补入后台答案。",
      "只返回严格 JSON 对象，不要 Markdown 或代码围栏。",
      '格式：{"chapterId":"当前ID","chapterTitle":"标题","clarityScore":0,"emotionalIntensity":0,"suspenseScore":0,"retentionScore":0,"dominantEmotion":"情绪","confusionPoints":[],"immersionBreaks":[],"effectiveHooks":[],"expectations":[],"dropRisk":"low|medium|high","summary":"本章读者反馈","readerStateSummary":"传递给下一章的读者已知状态","findings":[{"findingId":"finding-1","title":"问题","summary":"判断","category":"confusion|emotion|suspense|immersion|drop_risk|retention|other","severity":"critical|high|medium|low|info","chapterIds":["当前ID"],"evidenceRefs":["当前ID"],"evidence":[{"sourceType":"chapter","sourceId":"当前ID","title":"当前章","excerpt":"短证据"}],"recommendation":"建议","recommendedRole":"writer|editor","uncertainty":"不确定性"}],"warnings":[]}。'
    ].join(" ") : [
      "Act as a first-time fiction reader and evaluate chapters in strict reading order.",
      "You may use only the current chapter and priorReaderState from earlier chapters. Never use future chapters, backstage worldbuilding, character sheets, plotlines, retrieval evidence, or other expert conclusions.",
      "Evaluate confusion, emotion, suspense, immersion, drop risk, and retention without presenting guesses as facts.",
      "All finding and evidence references must use only the current chapter ID.",
      "readerStateSummary must contain only what the reader now knows, wonders, feels, and expects for the next chapter.",
      "Return one strict JSON object with scores, feedback lists, dropRisk, summary, readerStateSummary, findings, and warnings."
    ].join(" "), c = Math.min(this.settingsCache.http.maxTokens, 4200), d = this.assembleAgentPrompt({
      operation: "agent.generate_reader_chapter_evaluation",
      systemPrompt: o,
      outputTokens: c,
      currentRequest: {
        priorReaderState: s,
        position: e.position || {}
      },
      sections: [{
        id: "current-reader-chapter",
        kind: "retrieval",
        priority: "required",
        value: {
          chapterId: r,
          title: x(e.chapter.title, 300),
          contentMode: x(e.chapter.contentMode, 40) || "full",
          content: a
        },
        sourceRef: "reader.journey_review@1.0.0"
      }]
    }), l = await this.getProvider().generate({
      systemPrompt: o,
      prompt: d,
      maxTokens: c,
      temperature: Math.min(this.settingsCache.http.temperature, 0.35),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), m = Ne(l.text);
    if (!m || typeof m.summary != "string" || typeof m.readerStateSummary != "string" || !Array.isArray(m.findings))
      throw new k("UNKNOWN", "Reader journey evaluator did not return valid structured JSON");
    return m;
  }
  async generateAgentWorldbuildingRangeConsistency(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new k("INVALID_INPUT", "scopeBundle is required");
    const s = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说世界观编辑的多章节一致性审核器，只能依据已批准的 ChapterScopeBundle、已登记项目实体和实际检索证据作判断。",
      "检查规则、术语、角色能力、地点空间、物品属性和跨章状态漂移；不要输出读者体验、文风评价或外部现实考据。",
      "必须区分“明确冲突”“正文尚未解释”和“覆盖不足无法判断”。未提及某条设定不等于违反设定，不得把缺少说明直接判定为冲突。",
      "finding.chapterIds 只能使用 scope.chapterIds 中的目标章节 ID；subjectIds 只能使用 entityContext 中真实存在的角色、物品、世界设定或地图 ID。",
      "evidence.sourceId 与 evidenceRefs 只能引用 chapters、entityContext、plotContext、narrativeSummaries 或 evidence 中真实存在的 ID。不得伪造规则、引文、实体、章节或已完成的修改。",
      "证据不足时 evidence 和 evidenceRefs 置空，并在 uncertainty 中说明。重复冲突只输出一次。recommendedRole 只能是 writer、editor、worldbuilding。",
      "只返回严格 JSON 对象，不要 Markdown 或代码围栏。",
      '格式：{"consistencyScore":0,"summary":"摘要","dimensions":[{"id":"rules","label":"规则","score":0,"reason":"依据","checkable":true}],"findings":[{"findingId":"finding-1","title":"冲突","summary":"判断","category":"rule_conflict|terminology|ability|location|item|state_drift|chronology|other","severity":"critical|high|medium|low|info","chapterIds":["真实章节ID"],"subjectIds":["真实实体ID"],"evidenceRefs":["真实来源ID"],"evidence":[{"sourceType":"chapter|character|worldsetting|item|map|plotline|rag","sourceId":"真实ID","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendation":"修订建议","recommendedRole":"writer|editor|worldbuilding","uncertainty":"不确定性"}],"entityAssessments":[{"entityType":"worldsetting|character|item|map|term|other","entityId":"可选真实实体ID","name":"名称","status":"consistent|conflict|insufficient","chapterIds":["真实章节ID"],"summary":"状态判断","evidence":[],"uncertainty":"不确定性"}],"recommendations":["总体建议"],"warnings":[]}。'
    ].join(" ") : [
      "Review worldbuilding consistency across an approved ChapterScopeBundle using only registered project entities and supplied retrieval evidence.",
      "Check rules, terminology, character abilities, locations, items, and cross-chapter state drift. Do not perform reader, prose, or real-world fact review.",
      "Distinguish an explicit contradiction from an unexplained detail or insufficient coverage. An omitted rule is not automatically a conflict.",
      "Use only real target chapter IDs, entity IDs, and evidence source IDs from the bundle. Never fabricate lore, quotes, IDs, or project changes.",
      "Leave evidence empty and explain uncertainty when support is insufficient. Deduplicate findings.",
      "Return one strict JSON object with consistencyScore, summary, dimensions, findings, entityAssessments, recommendations, and warnings."
    ].join(" "), i = Math.min(this.settingsCache.http.maxTokens, 6e3), o = this.assembleAgentPrompt({
      operation: "agent.generate_worldbuilding_range_consistency",
      systemPrompt: s,
      outputTokens: i,
      currentRequest: {
        goal: r,
        dimensions: Array.isArray(e.dimensions) ? e.dimensions.slice(0, 12) : []
      },
      sections: [{
        id: "chapter-scope-bundle",
        kind: "retrieval",
        priority: "required",
        value: e.scopeBundle,
        sourceRef: "worldbuilding.range_consistency@1.0.0"
      }]
    }), c = await this.getProvider().generate({
      systemPrompt: s,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), d = Ne(c.text);
    if (!d || typeof d.summary != "string" || !Array.isArray(d.dimensions) || !Array.isArray(d.findings) || !Array.isArray(d.entityAssessments))
      throw new k("UNKNOWN", "Worldbuilding consistency reviewer did not return valid structured JSON");
    return d;
  }
  async extractAgentResearchClaims(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new k("INVALID_INPUT", "scopeBundle is required");
    const a = Math.max(1, Math.min(12, Number(e.maxClaims || 8))), i = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说考据流程的声明抽取器，只从 ChapterScopeBundle 的目标章节中提取可被证据核验的现实事实、历史、科学、医学、法律、技术、地理、文化或经济陈述。",
      "不要提取纯虚构世界规则、人物情绪、审美评价、剧情预测或无法形成明确陈述的句子。",
      "chapterId 必须是 scope.chapterIds 中真实存在的目标章节 ID；excerpt 必须是当前输入中的短摘录，不得改写成不存在的原文。",
      "searchKeyword 用于当前小说项目全文检索，应简短且有辨识度。requiresExternalEvidence 表示仅靠项目内容和已导入资料通常无法可靠核验。",
      `最多返回 ${a} 条，按对作品可信度的影响排序并去重。只返回严格 JSON，不要 Markdown。`,
      '格式：{"claims":[{"claimId":"claim-1","statement":"可核验陈述","chapterId":"真实章节ID","excerpt":"短摘录","category":"historical|scientific|medical|legal|technical|geographic|cultural|economic|other","importance":"high|medium|low","searchKeyword":"项目检索词","needsProjectSearch":true,"requiresExternalEvidence":false}],"warnings":[]}。'
    ].join(" ") : [
      "Extract evidence-checkable real-world claims only from target chapters in the supplied ChapterScopeBundle.",
      "Exclude fictional lore, emotions, aesthetic opinions, plot predictions, and vague statements.",
      "Use only real target chapter IDs and excerpts present in the input. Produce short project-search keywords and flag claims that require external evidence.",
      `Return at most ${a} deduplicated claims in strict JSON with claims and warnings.`
    ].join(" "), o = Math.min(this.settingsCache.http.maxTokens, 3200), c = this.assembleAgentPrompt({
      operation: "agent.extract_research_claims",
      systemPrompt: i,
      outputTokens: o,
      currentRequest: { goal: r, maxClaims: a },
      sections: [{
        id: "chapter-scope-bundle",
        kind: "retrieval",
        priority: "required",
        value: e.scopeBundle,
        sourceRef: "research.range_fact_check@1.0.0"
      }]
    }), d = await this.getProvider().generate({
      systemPrompt: i,
      prompt: c,
      maxTokens: o,
      temperature: Math.min(this.settingsCache.http.temperature, 0.1),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), l = Ne(d.text);
    if (!l || !Array.isArray(l.claims))
      throw new k("UNKNOWN", "Research claim extractor did not return valid structured JSON");
    return l;
  }
  async generateAgentResearchFactCheck(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new k("INVALID_INPUT", "scopeBundle is required");
    if (!Array.isArray(e.claims))
      throw new k("INVALID_INPUT", "claims is required");
    const s = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说考据与事实核查器，只能核验输入 claims 中已经抽取的声明，不得新增声明。",
      "证据仅来自 ChapterScopeBundle、已导入 RAG evidence 和 projectSearchEvidence。search.query 是小说项目全文搜索，不是互联网搜索；externalSearchAvailable=false。",
      "不得生成网址、书名、作者、机构、引文、来源 ID 或查询结果中不存在的证据。需要外部资料但当前证据不足时，verdict 必须是 unverified，并说明应补充何种可靠来源。",
      "supported 表示现有可追溯证据支持；contradicted 表示证据明确相反；mixed 表示来源或条件冲突；not_applicable 表示抽取项并非可核验事实。",
      "claimId 只能来自输入 claims；chapterIds 固定为该声明章节。evidence.sourceId 与 evidenceRefs 只能使用输入中真实存在的章节、项目实体、RAG 或项目搜索来源 ID。",
      "confidence 范围 0 到 1；没有证据时不得高于 0.3。只返回严格 JSON，不要 Markdown 或代码围栏。",
      '格式：{"overallReliabilityScore":0,"summary":"摘要","claims":[],"findings":[{"findingId":"finding-1","claimId":"真实claimId","statement":"原声明","summary":"核验判断","verdict":"supported|contradicted|mixed|unverified|not_applicable","confidence":0.8,"category":"historical|scientific|medical|legal|technical|geographic|cultural|economic|other","severity":"critical|high|medium|low|info","chapterIds":["真实章节ID"],"evidenceRefs":["真实来源ID"],"evidence":[{"sourceType":"chapter|rag|project_search","sourceId":"真实ID","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendation":"修订或补证建议","recommendedRole":"writer|editor|research_rag","uncertainty":"不确定性"}],"recommendations":[],"warnings":[],"searchStats":{}}。'
    ].join(" ") : [
      "Fact-check only the supplied claims using the ChapterScopeBundle, imported RAG evidence, and actual projectSearchEvidence.",
      "Project search is internal novel search, not internet search, and externalSearchAvailable is false. Never fabricate URLs, publications, authors, institutions, quotes, IDs, or sources.",
      "Claims requiring unavailable external evidence must remain unverified. Use only real claim, chapter, and evidence IDs from the input.",
      "Return strict JSON with overallReliabilityScore, summary, findings, recommendations, warnings, and searchStats."
    ].join(" "), i = Math.min(this.settingsCache.http.maxTokens, 6e3), o = this.assembleAgentPrompt({
      operation: "agent.generate_research_fact_check",
      systemPrompt: s,
      outputTokens: i,
      currentRequest: {
        goal: r,
        claims: e.claims,
        projectSearchEvidence: e.projectSearchEvidence || {},
        externalSearchAvailable: !1
      },
      sections: [{
        id: "chapter-scope-bundle",
        kind: "retrieval",
        priority: "required",
        value: e.scopeBundle,
        sourceRef: "research.range_fact_check@1.0.0"
      }]
    }), c = await this.getProvider().generate({
      systemPrompt: s,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.1),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), d = Ne(c.text);
    if (!d || typeof d.summary != "string" || !Array.isArray(d.findings))
      throw new k("UNKNOWN", "Research fact-check reviewer did not return valid structured JSON");
    return d;
  }
  async generateAgentScopeAudit(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    const a = Array.isArray(e.childReports) ? e.childReports : [];
    if (!a.length)
      throw new k("INVALID_INPUT", "childReports is required");
    const i = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说团队审计 Supervisor，只能汇总输入中实际执行的专家子报告。不得读取正文、补做专家分析或伪造未执行专家意见。",
      "综合 finding 必须通过 sourceFindingIds 引用子报告中真实 findingId；sourceExperts 只能来自对应子报告 expert。",
      "相同问题要去重：多个专家支持同一判断标为 consensus；只有一个来源标为 single；专家判断实质冲突时标为 conflict，并在 conflicts 中保留双方来源。",
      "不得改变来源证据含义，不得生成新的 evidence sourceId、章节 ID、事实或已经发生的修改。",
      "建议按严重度、影响范围和专家共识排序。只返回严格 JSON，不要 Markdown 或代码围栏。",
      '格式：{"summary":"综合摘要","experts":[],"findings":[{"findingId":"audit-1","title":"问题","summary":"综合判断","category":"分类","severity":"critical|high|medium|low|info","chapterIds":["来源中的真实章节ID"],"sourceFindingIds":["真实findingId"],"sourceExperts":["editor|reader|worldbuilding|research_rag"],"relationship":"consensus|single|conflict","evidenceRefs":["来源中的真实证据ID"],"evidence":[],"recommendation":"建议","recommendedRole":"writer|editor|worldbuilding|research_rag","uncertainty":"不确定性"}],"conflicts":[{"conflictId":"conflict-1","topic":"分歧主题","sourceFindingIds":["至少两个真实findingId"],"experts":["至少两个专家"],"summary":"分歧","resolution":"处理建议"}],"recommendations":[],"warnings":[]}。'
    ].join(" ") : [
      "Act as a fiction audit supervisor and aggregate only the expert child reports actually provided.",
      "Never invent an unexecuted expert opinion, new finding, chapter, evidence source, fact, or project change.",
      "Every aggregate finding must cite real sourceFindingIds. Mark multi-expert agreement as consensus, one source as single, and substantive disagreement as conflict.",
      "Return strict JSON with summary, findings, conflicts, recommendations, and warnings."
    ].join(" "), o = Math.min(this.settingsCache.http.maxTokens, 6e3), c = this.assembleAgentPrompt({
      operation: "agent.generate_scope_audit",
      systemPrompt: i,
      outputTokens: o,
      currentRequest: { goal: r },
      sections: [{
        id: "executed-expert-reports",
        kind: "artifact",
        priority: "required",
        value: a,
        sourceRef: "novel.scope_audit@1.0.0"
      }]
    }), d = await this.getProvider().generate({
      systemPrompt: i,
      prompt: c,
      maxTokens: o,
      temperature: Math.min(this.settingsCache.http.temperature, 0.15),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), l = Ne(d.text);
    if (!l || typeof l.summary != "string" || !Array.isArray(l.findings) || !Array.isArray(l.conflicts))
      throw new k("UNKNOWN", "Scope audit supervisor did not return valid structured JSON");
    return l;
  }
  async generateAgentPlotlineAnalysis(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    if (!e.context || typeof e.context != "object")
      throw new k("INVALID_INPUT", "context is required");
    const s = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说情节线结构分析器，只能依据 PlotlineAnalysisContext 中已登记的情节线、章节摘录和检索证据作判断。",
      "分析主线与支线的推进程度、伏笔是否得到回收、长时间未推进的线索、节奏和连续性风险。",
      "不要续写正文，不要生成草稿，也不要声称已经修改作品。",
      "每条 evidence 只能引用输入中真实存在的 plotlineId 或 chapterId；不得伪造 ID、标题、章节内容或证据。",
      "范围未覆盖到的章节不能推断为没有发生；证据不足时 evidence 置空，并在 uncertainty 中说明。",
      "同一问题只输出一次。recommendation 必须是可执行的编辑建议，不得把猜测包装成事实。",
      "只返回一个严格 JSON 对象，不要 Markdown 或代码围栏。",
      '格式：{"overallScore":0,"summary":"摘要","threads":[{"plotlineId":"可选真实ID","name":"情节线","role":"main|subplot|unknown","status":"状态","progressionScore":0,"lastProgressLocation":"位置","coveredChapterIds":["真实chapterId"],"findings":["发现"],"evidence":[{"sourceType":"chapter|plotline|rag","sourceId":"真实ID或空","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendations":["建议"],"uncertainty":"不确定性"}],"issues":[{"issueId":"issue-1","type":"stalled|unresolved_foreshadowing|pacing|continuity|coverage|other","severity":"critical|high|medium|low|info","title":"问题","plotlineIds":["真实ID"],"chapterIds":["真实ID"],"evidence":[],"recommendation":"建议","uncertainty":"不确定性"}],"recommendations":["总体建议"],"warnings":[]}。'
    ].join(" ") : [
      "Analyze plotline structure using only the supplied PlotlineAnalysisContext.",
      "Assess main and subplots, foreshadowing resolution, stalled threads, pacing, and continuity.",
      "Do not draft prose or claim any project change. Never fabricate IDs, chapter text, or evidence.",
      "Treat uncovered chapters as unknown. When evidence is missing, leave evidence empty and explain uncertainty.",
      "Return one strict JSON object with overallScore, summary, threads, issues, recommendations, and warnings."
    ].join(" "), i = Math.min(this.settingsCache.http.maxTokens, 5200), o = this.assembleAgentPrompt({
      operation: "agent.generate_plotline_analysis",
      systemPrompt: s,
      outputTokens: i,
      currentRequest: {
        novelId: x(e.novelId, 200),
        goal: r,
        scope: e.scope || "novel"
      },
      sections: [{
        id: "plotline-analysis-context",
        kind: "retrieval",
        priority: "required",
        value: e.context,
        sourceRef: "plotline.analysis@1.0.0"
      }]
    }), c = await this.getProvider().generate({
      systemPrompt: s,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), d = Ne(c.text);
    if (!d || !Array.isArray(d.threads) || !Array.isArray(d.issues))
      throw new k("UNKNOWN", "Plotline analyzer did not return valid structured JSON");
    return d;
  }
  async generateAgentReport(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    const s = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说创作 Agent 的最终报告撰写器。",
      "根据已执行计划、工具结果和用户确认，直接回答原始任务。",
      "必须给出具体发现、判断依据和可执行建议；读者任务要明确困惑点、期待点、弃读风险和追更动力。",
      "只能使用输入中提供的事实，不得声称执行了未列出的工具，不得编造正文细节。",
      "PreferredRole 是报告主视角。不得添加 Steps 中未执行 agent 的专属评估章节；例如没有 reader 步骤时，不得输出“读者视角评估”。",
      "如果证据不足，要明确指出缺口。若已生成草稿，说明草稿已进入审核，不要声称已经写回正文。",
      "一次生成两个版本：content 是供“产物”面板保存的完整 Markdown 报告；conversationSummary 是显示在会话中的精炼交付说明。",
      "conversationSummary 要像任务完成回执：先直接说明完成结果，再概括最重要的结论、变更或建议；控制在 2 至 5 个短段落或不超过 5 个要点，不要复制完整报告。",
      "若有完整报告，conversationSummary 可提示用户在“产物”中查看详情，但不要虚构产物名称或数量。",
      '只返回严格 JSON：{"content":"完整 Markdown 报告","conversationSummary":"精炼 Markdown 交付说明"}，不要复述内部事件名称。'
    ].join(" ") : [
      "Write the final report for a novel-writing agent run.",
      "Answer the original goal using only the supplied plan, findings, and user decisions.",
      "Give concrete findings, rationale, and actionable recommendations. State evidence gaps clearly.",
      "Use PreferredRole as the primary perspective. Do not add role-specific sections for agents absent from Steps.",
      "If a draft exists, say it is ready for review; never claim it was committed.",
      "Produce two versions: content is the complete Markdown report saved as an artifact; conversationSummary is a concise completion handoff shown in chat.",
      "The conversationSummary must lead with the outcome, capture only the most important conclusions, changes, or next actions in 2-5 short paragraphs or at most 5 bullets, and must not duplicate the full report.",
      "It may direct the user to the artifact for details, but must not invent artifact names or counts.",
      'Return strict JSON only: {"content":"complete Markdown report","conversationSummary":"concise Markdown completion handoff"}. Do not mention internal event names.'
    ].join(" "), i = Math.min(this.settingsCache.http.maxTokens, 4e3), o = this.assembleAgentPrompt({
      operation: "agent.generate_report",
      systemPrompt: s,
      outputTokens: i,
      currentRequest: {
        goal: r,
        preferredRole: e.role || "team",
        deliverable: x(e.deliverable, 40)
      },
      sections: [
        {
          id: "executed-plan",
          kind: "plan",
          priority: "high",
          value: {
            title: x(e.planTitle, 200),
            steps: e.steps || []
          }
        },
        {
          id: "tool-findings",
          kind: "retrieval",
          priority: "required",
          value: e.findings || [],
          sourceRef: "executed-agent-tools"
        },
        {
          id: "approval-responses",
          kind: "decision",
          priority: "high",
          value: e.approvalResponses || [],
          sourceRef: "user-approvals"
        },
        {
          id: "draft-artifact",
          kind: "artifact",
          priority: "high",
          value: { draftSessionId: x(e.draftSessionId, 200) }
        }
      ]
    }), c = await this.getProvider().generate({
      systemPrompt: s,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.45),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 18e4),
      signal: t
    }), d = Ne(c.text), l = x(d == null ? void 0 : d.content, 2e4), m = x(d == null ? void 0 : d.conversationSummary, 4e3);
    if (!l)
      throw new k("UNKNOWN", "Agent final report returned empty content");
    if (!m)
      throw new k("UNKNOWN", "Agent final report returned empty conversation summary");
    return { content: l, conversationSummary: m };
  }
  async detectAgentCreativeDirection(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new k("INVALID_INPUT", "goal is required");
    const s = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说创作 Agent 的执行前决策分析器，不生成正文，也不调用工具。",
      "判断任务在生成草稿前是否存在两个或以上互斥且会显著改变成稿的创作方向。",
      "普通细节差异、可以同时满足的要求、证据不足都不属于创作方向分歧。",
      "只有必须由用户选择时 requiresDecision=true，并给出 2 到 4 个具体、互斥、可执行的选项。",
      '只返回严格 JSON：{"requiresDecision":false}，或 {"requiresDecision":true,"title":"方向确认","question":"...","reason":"...","options":[{"id":"可选","label":"...","description":"..."}]}。'
    ].join(" ") : [
      "You detect mutually exclusive creative directions before a novel draft is generated.",
      "Do not write prose or call tools. Minor details, compatible requirements, and evidence quality are not direction conflicts.",
      "Return strict JSON. Set requiresDecision=true only when the user must choose among 2-4 concrete, exclusive directions."
    ].join(" "), i = Math.min(this.settingsCache.http.maxTokens, 1200), o = this.assembleAgentPrompt({
      operation: "agent.detect_creative_direction",
      systemPrompt: s,
      outputTokens: i,
      currentRequest: {
        goal: r,
        planTitle: x(e.planTitle, 200),
        stepTitle: x(e.stepTitle, 200)
      },
      sections: [{
        id: "analysis-summary",
        kind: "retrieval",
        priority: "high",
        value: x(e.analysisSummary, 2e3)
      }]
    }), c = await this.getProvider().generate({
      systemPrompt: s,
      prompt: o,
      maxTokens: i,
      temperature: 0.1,
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), d = Ne(c.text);
    if (!d || typeof d.requiresDecision != "boolean")
      throw new k("UNKNOWN", "Creative direction detector returned invalid JSON");
    return d.requiresDecision ? {
      requiresDecision: !0,
      title: x(d.title, 120),
      question: x(d.question, 500),
      reason: x(d.reason, 1e3),
      options: Array.isArray(d.options) ? d.options : []
    } : { requiresDecision: !1 };
  }
  async generateTitle(e) {
    var y, g;
    $("INFO", "AiService.generateTitle.start", "Generate title start", {
      chapterId: e.chapterId,
      novelId: e.novelId,
      providerType: this.settingsCache.providerType
    });
    const t = this.getProvider(), r = Math.max(5, Math.min(10, e.count ?? 6)), s = Nn(e.content).slice(0, 4e3), i = await S.novel.findUnique({
      where: { id: e.novelId },
      select: { title: !0, description: !0 }
    }), o = await S.chapter.findUnique({
      where: { id: e.chapterId },
      select: {
        id: !0,
        title: !0,
        order: !0,
        volumeId: !0,
        volume: {
          select: {
            id: !0,
            title: !0,
            order: !0
          }
        }
      }
    }), d = (await S.chapter.findMany({
      where: {
        volume: { novelId: e.novelId },
        id: { not: e.chapterId }
      },
      select: {
        title: !0,
        order: !0,
        volume: {
          select: {
            title: !0,
            order: !0
          }
        }
      },
      orderBy: [
        { volume: { order: "desc" } },
        { order: "desc" }
      ],
      take: 30
    })).map((u, v) => {
      var w, A;
      return {
        index: v + 1,
        volumeTitle: ((w = u.volume) == null ? void 0 : w.title) || "",
        volumeOrder: ((A = u.volume) == null ? void 0 : A.order) || 0,
        chapterOrder: u.order || 0,
        title: u.title || `Chapter-${v + 1}`
      };
    }), l = [
      "You are a Chinese novel title assistant.",
      "Generate concise chapter title candidates based on provided context.",
      "Return STRICT JSON only. No markdown.",
      'JSON shape: {"candidates":[{"title":"...","styleTag":"..."}]}',
      "Each styleTag must be short Chinese phrase like: 稳健推进, 悬念强化, 意象抒情."
    ].join(" "), m = await t.generate({
      systemPrompt: l,
      prompt: JSON.stringify({
        task: "chapter_title_generation",
        count: r,
        novel: {
          title: (i == null ? void 0 : i.title) || "",
          description: (i == null ? void 0 : i.description) || ""
        },
        chapter: {
          title: (o == null ? void 0 : o.title) || "",
          order: (o == null ? void 0 : o.order) || 0,
          volumeTitle: ((y = o == null ? void 0 : o.volume) == null ? void 0 : y.title) || "",
          volumeOrder: ((g = o == null ? void 0 : o.volume) == null ? void 0 : g.order) || 0
        },
        recentChapterTitles: d,
        currentChapterFullText: s,
        constraints: [
          "title length <= 16 Chinese characters preferred",
          "avoid spoilers and proper nouns overuse",
          "output 5-10 candidates"
        ]
      }),
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: this.settingsCache.http.temperature
    }), h = (() => {
      try {
        return JSON.parse(m.text);
      } catch {
        return null;
      }
    })(), p = Array.isArray(h == null ? void 0 : h.candidates) ? h.candidates.map((u) => ({
      title: String((u == null ? void 0 : u.title) || "").trim(),
      styleTag: String((u == null ? void 0 : u.styleTag) || "").trim() || "稳健推进"
    })).filter((u) => !!u.title).slice(0, r) : [];
    if (p.length > 0)
      return $("INFO", "AiService.generateTitle.success", "Generate title success", {
        chapterId: e.chapterId,
        candidateCount: p.length
      }), { candidates: p };
    const f = m.text.split(`
`).map((u) => u.replace(/^[-\d.\s]+/, "").trim()).filter(Boolean).slice(0, r).map((u) => ({ title: u, styleTag: "稳健推进" }));
    if (f.length > 0)
      return $("INFO", "AiService.generateTitle.success", "Generate title success", {
        chapterId: e.chapterId,
        candidateCount: f.length
      }), { candidates: f };
    const I = ((o == null ? void 0 : o.title) || s.slice(0, 12) || "新章节").trim();
    return $("INFO", "AiService.generateTitle.success", "Generate title success", {
      chapterId: e.chapterId,
      candidateCount: r
    }), {
      candidates: Array.from({ length: r }, (u, v) => ({
        title: `${I} · ${v + 1}`,
        styleTag: "稳健推进"
      }))
    };
  }
  async previewContinuePrompt(e) {
    $("INFO", "AiService.previewContinuePrompt.start", "Preview continue prompt start", {
      chapterId: e.chapterId,
      novelId: e.novelId,
      contextChapterCount: e.contextChapterCount
    });
    const t = await this.buildContinuePromptBundle(e), r = this.assembleDraftGenerationPrompt({
      operation: "chapter.preview_generation_context",
      systemPrompt: t.systemPrompt,
      outputTokens: this.settingsCache.http.maxTokens,
      structured: t.structured,
      effectiveUserPrompt: t.effectiveUserPrompt,
      usedContext: t.usedContext
    });
    return $("INFO", "AiService.previewContinuePrompt.success", "Preview continue prompt success", {
      chapterId: e.chapterId
    }), {
      structured: t.structured,
      rawPrompt: bn(t.systemPrompt, r),
      editableUserPrompt: t.defaultUserPrompt,
      usedContext: t.usedContext,
      warnings: t.warnings
    };
  }
  async continueWriting(e, t) {
    $("INFO", "AiService.continueWriting.start", "Continue writing start", {
      chapterId: e.chapterId,
      novelId: e.novelId,
      providerType: this.settingsCache.providerType,
      targetLength: e.targetLength,
      contextChapterCount: e.contextChapterCount
    });
    const r = this.getProvider(), a = await this.buildContinuePromptBundle(e), s = Number.isFinite(e.temperature) ? Math.max(0, Math.min(2, Number(e.temperature))) : this.settingsCache.http.temperature, i = this.assembleDraftGenerationPrompt({
      operation: "chapter.generate_draft",
      systemPrompt: a.systemPrompt,
      outputTokens: this.settingsCache.http.maxTokens,
      structured: a.structured,
      effectiveUserPrompt: a.effectiveUserPrompt,
      usedContext: a.usedContext
    }), o = await r.generate({
      systemPrompt: a.systemPrompt,
      prompt: i,
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: s,
      signal: t
    });
    t == null || t.throwIfAborted();
    const c = await this.checkConsistency({
      novelId: e.novelId,
      text: o.text
    }), d = {
      text: o.text,
      usedContext: a.usedContext,
      warnings: a.warnings,
      contextPolicy: a.contextPolicy,
      contextSnapshot: a.contextSnapshot,
      consistency: c
    };
    return $("INFO", "AiService.continueWriting.success", "Continue writing success", {
      chapterId: e.chapterId,
      warningCount: a.warnings.length,
      generatedLength: d.text.length
    }), d;
  }
  async checkConsistency(e) {
    const t = [];
    return (await S.worldSetting.findMany({ where: { novelId: e.novelId } })).length === 0 && t.push("No world settings found for consistency baseline."), e.text.length < 20 && t.push("Generated text is too short."), { ok: t.length === 0, issues: t };
  }
  async previewNovelAskPrompt(e) {
    var r;
    $("INFO", "AiService.previewNovelAskPrompt.start", "Preview novel RAG prompt start", {
      novelId: e.novelId,
      questionLength: ((r = e.question) == null ? void 0 : r.length) ?? 0
    });
    const t = await this.novelRagService.preview(e, this.settingsCache.embedding);
    return $("INFO", "AiService.previewNovelAskPrompt.success", "Preview novel RAG prompt success", {
      novelId: e.novelId,
      intent: t.intent,
      evidenceCount: t.evidence.length
    }), t;
  }
  async askNovel(e, t) {
    var s;
    $("INFO", "AiService.askNovel.start", "Novel RAG ask start", {
      novelId: e.novelId,
      questionLength: ((s = e.question) == null ? void 0 : s.length) ?? 0,
      providerType: this.settingsCache.providerType
    });
    const r = this.getProvider(), a = await this.novelRagService.ask(e, r, {
      maxTokens: Math.min(2048, this.settingsCache.http.maxTokens || 2048),
      temperature: 0.2,
      embeddingSettings: this.settingsCache.embedding,
      signal: t
    });
    return $("INFO", "AiService.askNovel.success", "Novel RAG ask success", {
      novelId: e.novelId,
      intent: a.intent,
      confidence: a.confidence,
      evidenceCount: a.evidence.length
    }), a;
  }
  async rebuildRagIndex(e) {
    return fo(e, this.settingsCache.embedding);
  }
  async upsertRagChapterIndex(e, t) {
    var r;
    if (t != null && t.skipIfNovelNotIndexed) {
      const a = await S.chapter.findUnique({
        where: { id: e },
        select: { volume: { select: { novelId: !0 } } }
      }), s = (r = a == null ? void 0 : a.volume) == null ? void 0 : r.novelId;
      if (!s || await Sn(s) === 0)
        return {
          chunks: 0,
          sources: 0,
          provider: "none",
          model: "not-indexed",
          dimensions: 0,
          fallbackUsed: !1,
          sourceId: e,
          novelId: s,
          skipped: !0
        };
    }
    return go(e, this.settingsCache.embedding);
  }
  async upsertRagSourceIndex(e, t, r) {
    if (e === "chapter")
      return { ...await this.upsertRagChapterIndex(t, r), sourceType: e };
    if (r != null && r.skipIfNovelNotIndexed) {
      const a = await Sa(e, t), s = a == null ? void 0 : a.novelId;
      if (!s || await Sn(s) === 0)
        return {
          chunks: 0,
          sources: 0,
          provider: "none",
          model: "not-indexed",
          dimensions: 0,
          fallbackUsed: !1,
          sourceType: e,
          sourceId: t,
          novelId: s,
          skipped: !0
        };
    }
    return Ea(e, t, this.settingsCache.embedding);
  }
  async deleteRagChapterIndex(e, t) {
    return Mr({
      novelId: e,
      sourceType: "chapter",
      sourceId: t
    });
  }
  async deleteRagSourceIndex(e, t, r) {
    return Mr({ novelId: e, sourceType: t, sourceId: r });
  }
  deleteGeneratedMapAsset(e) {
    const t = String(e || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!t.startsWith("maps/"))
      return !1;
    const r = D.resolve(this.userDataPath, "maps"), a = D.resolve(this.userDataPath, t);
    return a !== r && !a.startsWith(`${r}${D.sep}`) || !re.existsSync(a) ? !1 : (re.unlinkSync(a), !0);
  }
  refreshRagSourceIndexInBackground(e, t, r) {
    this.upsertRagSourceIndex(e, t, { skipIfNovelNotIndexed: !0 }).catch((a) => {
      console.warn("[RAG] Failed to refresh source index:", { sourceType: e, sourceId: t, reason: r, error: a });
    });
  }
  async refreshLatestCreativeAssetIndexes(e, t) {
    var m;
    const r = async (h, p) => p.length === 0 ? [] : h.findMany({
      where: { novelId: e, name: { in: p } },
      select: { id: !0 }
    }), a = (t.plotLines ?? []).map((h) => h.name).filter(Boolean), s = (t.characters ?? []).map((h) => h.name).filter(Boolean), i = [
      ...(t.items ?? []).map((h) => h.name),
      ...(t.skills ?? []).map((h) => h.name)
    ].filter(Boolean), [o, c, d] = await Promise.all([
      r(S.plotLine, a),
      r(S.character, s),
      r(S.item, i)
    ]);
    for (const h of o)
      this.refreshRagSourceIndexInBackground("plotLine", h.id, "confirm-creative-assets");
    for (const h of c)
      this.refreshRagSourceIndexInBackground("character", h.id, "confirm-creative-assets");
    for (const h of d)
      this.refreshRagSourceIndexInBackground("item", h.id, "confirm-creative-assets");
    const l = await S.plotPoint.findMany({
      where: { novelId: e },
      orderBy: { createdAt: "desc" },
      take: Math.max(0, (((m = t.plotPoints) == null ? void 0 : m.length) ?? 0) + (t.plotLines ?? []).reduce((h, p) => {
        var f;
        return h + (((f = p.points) == null ? void 0 : f.length) ?? 0);
      }, 0)),
      select: { id: !0 }
    });
    for (const h of l)
      this.refreshRagSourceIndexInBackground("plotPoint", h.id, "confirm-creative-assets");
  }
  refreshRagAfterAction(e, t) {
    const r = t && typeof t == "object" ? t : null, a = typeof (r == null ? void 0 : r.id) == "string" ? r.id : "";
    a && (e === "worldsetting.create" || e === "worldsetting.update") && this.refreshRagSourceIndexInBackground("worldSetting", a, e);
  }
  async previewCreativeAssetsPrompt(e) {
    var a;
    $("INFO", "AiService.previewCreativeAssetsPrompt.start", "Preview creative assets prompt start", {
      novelId: e.novelId,
      briefLength: ((a = e.brief) == null ? void 0 : a.length) ?? 0,
      targetSections: e.targetSections
    });
    const t = await this.buildCreativeAssetsPromptBundle(e), r = this.assembleDraftGenerationPrompt({
      operation: "creative_assets.preview_generation_context",
      systemPrompt: t.systemPrompt,
      outputTokens: this.settingsCache.http.maxTokens,
      structured: t.structured,
      effectiveUserPrompt: t.effectiveUserPrompt,
      usedContext: t.usedContext
    });
    return $("INFO", "AiService.previewCreativeAssetsPrompt.success", "Preview creative assets prompt success", {
      novelId: e.novelId
    }), {
      structured: t.structured,
      rawPrompt: bn(t.systemPrompt, r),
      editableUserPrompt: t.defaultUserPrompt,
      usedContext: t.usedContext
    };
  }
  inferCreativeTargetSections(e) {
    const t = String(e || "").trim().toLowerCase();
    if (!t)
      return [...Ht];
    const r = [];
    for (const a of Ht)
      Ro[a].some((i) => t.includes(i.toLowerCase())) && r.push(a);
    return r.length > 0 ? r : [...Ht];
  }
  resolveCreativeTargetSections(e) {
    const r = (Array.isArray(e.targetSections) ? e.targetSections : []).filter((a) => Ht.includes(a));
    return r.length > 0 ? r : this.inferCreativeTargetSections(e.brief);
  }
  buildEmptyCreativeDraft(e) {
    const t = {};
    for (const r of e)
      t[r] = [];
    return t;
  }
  async generateCreativeAssets(e, t) {
    var m, h, p, f, I, y, g, u, v, w, A, T, E;
    $("INFO", "AiService.generateCreativeAssets.start", "Generate creative assets start", {
      novelId: e.novelId,
      briefLength: ((m = e.brief) == null ? void 0 : m.length) ?? 0,
      providerType: this.settingsCache.providerType,
      targetSections: e.targetSections
    });
    const r = this.getProvider(), a = await this.buildCreativeAssetsPromptBundle(e), s = this.resolveCreativeTargetSections(e), i = this.assembleDraftGenerationPrompt({
      operation: "creative_assets.generate_draft",
      systemPrompt: a.systemPrompt,
      outputTokens: this.settingsCache.http.maxTokens,
      structured: a.structured,
      effectiveUserPrompt: a.effectiveUserPrompt,
      usedContext: a.usedContext
    }), o = await r.generate({
      systemPrompt: a.systemPrompt,
      prompt: i,
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: this.settingsCache.http.temperature,
      // 创作工坊需要生成多个板块的结构化 JSON，内容量大，使用更宽裕的超时
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 18e4),
      signal: t
    });
    try {
      const C = JSON.parse(o.text);
      if (C && typeof C == "object") {
        const _ = this.buildEmptyCreativeDraft(s);
        for (const L of s) {
          const V = C == null ? void 0 : C[L];
          _[L] = Array.isArray(V) ? V : [];
        }
        return $("INFO", "AiService.generateCreativeAssets.success", "Generate creative assets success", {
          novelId: e.novelId,
          counts: {
            plotLines: ((h = _.plotLines) == null ? void 0 : h.length) ?? 0,
            plotPoints: ((p = _.plotPoints) == null ? void 0 : p.length) ?? 0,
            characters: ((f = _.characters) == null ? void 0 : f.length) ?? 0,
            items: ((I = _.items) == null ? void 0 : I.length) ?? 0,
            skills: ((y = _.skills) == null ? void 0 : y.length) ?? 0,
            maps: ((g = _.maps) == null ? void 0 : g.length) ?? 0
          }
        }), { draft: _ };
      }
    } catch {
    }
    const c = le().slice(0, 6), d = {
      plotLines: [{
        name: `主线-${c}`,
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
      characters: [{ name: `角色-${c}`, role: "protagonist", description: "AI 生成角色草稿", profile: { goal: "完成使命" } }],
      items: [{ name: `物品-${c}`, type: "item", description: "AI 生成物品草稿", profile: { rarity: "rare" } }],
      skills: [{ name: `技能-${c}`, description: "AI 生成技能草稿", profile: { rank: "A" } }],
      maps: [{ name: `世界地图-${c}`, type: "world", description: "AI 生成地图草稿", imagePrompt: "fantasy world map" }]
    }, l = this.buildEmptyCreativeDraft(s);
    for (const C of s)
      l[C] = d[C] ?? [];
    return $("INFO", "AiService.generateCreativeAssets.success", "Generate creative assets success", {
      novelId: e.novelId,
      counts: {
        plotLines: ((u = l.plotLines) == null ? void 0 : u.length) ?? 0,
        plotPoints: ((v = l.plotPoints) == null ? void 0 : v.length) ?? 0,
        characters: ((w = l.characters) == null ? void 0 : w.length) ?? 0,
        items: ((A = l.items) == null ? void 0 : A.length) ?? 0,
        skills: ((T = l.skills) == null ? void 0 : T.length) ?? 0,
        maps: ((E = l.maps) == null ? void 0 : E.length) ?? 0
      }
    }), {
      draft: l
    };
  }
  async validateCreativeAssetsDraft(e) {
    var I, y;
    const t = [], r = [], a = (g) => t.push(g), s = (g, u, v = bo) => {
      const w = typeof g == "string" ? g.trim() : "";
      return w ? w.length <= v ? w : (r.push(`${u} exceeds ${v} chars and was truncated`), w.slice(0, v)) : "";
    }, i = (g, u) => {
      if (!g || typeof g != "object" || Array.isArray(g))
        return {};
      const v = {};
      for (const [w, A] of Object.entries(g)) {
        const T = s(w, `${u}.key`, 64), E = s(A, `${u}.${w}`, 500);
        T && E && (v[T] = E);
      }
      return v;
    }, o = {
      plotLines: (e.draft.plotLines ?? []).map((g, u) => ({
        name: s(g.name, `plotLines[${u}].name`, 120),
        description: s(g.description, `plotLines[${u}].description`),
        color: s(g.color, `plotLines[${u}].color`, 16) || "#6366f1",
        points: (g.points ?? []).map((v, w) => {
          const A = s(v.type, `plotLines[${u}].points[${w}].type`, 32) || "event", T = s(v.status, `plotLines[${u}].points[${w}].status`, 32) || "active";
          return {
            title: s(v.title, `plotLines[${u}].points[${w}].title`, 120),
            description: s(v.description, `plotLines[${u}].points[${w}].description`),
            type: Tn.has(A) ? A : "event",
            status: Cn.has(T) ? T : "active"
          };
        })
      })),
      plotPoints: (e.draft.plotPoints ?? []).map((g, u) => {
        const v = s(g.type, `plotPoints[${u}].type`, 32) || "event", w = s(g.status, `plotPoints[${u}].status`, 32) || "active";
        return {
          title: s(g.title, `plotPoints[${u}].title`, 120),
          description: s(g.description, `plotPoints[${u}].description`),
          type: Tn.has(v) ? v : "event",
          status: Cn.has(w) ? w : "active",
          plotLineName: s(g.plotLineName, `plotPoints[${u}].plotLineName`, 120)
        };
      }),
      characters: (e.draft.characters ?? []).map((g, u) => ({
        name: s(g.name, `characters[${u}].name`, 120),
        role: s(g.role, `characters[${u}].role`, 64),
        description: s(g.description, `characters[${u}].description`),
        profile: i(g.profile, `characters[${u}].profile`)
      })),
      items: (e.draft.items ?? []).map((g, u) => {
        const v = s(g.type, `items[${u}].type`, 32) || "item";
        return {
          name: s(g.name, `items[${u}].name`, 120),
          type: xo.has(v) ? v : "item",
          description: s(g.description, `items[${u}].description`),
          profile: i(g.profile, `items[${u}].profile`)
        };
      }),
      skills: (e.draft.skills ?? []).map((g, u) => ({
        name: s(g.name, `skills[${u}].name`, 120),
        description: s(g.description, `skills[${u}].description`),
        profile: i(g.profile, `skills[${u}].profile`)
      })),
      maps: (e.draft.maps ?? []).map((g, u) => {
        const v = s(g.type, `maps[${u}].type`, 32) || "world";
        return {
          name: s(g.name, `maps[${u}].name`, 120),
          type: _o.has(v) ? v : "world",
          description: s(g.description, `maps[${u}].description`),
          imagePrompt: s(g.imagePrompt, `maps[${u}].imagePrompt`),
          imageUrl: s(g.imageUrl, `maps[${u}].imageUrl`, 2048),
          imageBase64: s(g.imageBase64, `maps[${u}].imageBase64`, 4194304),
          mimeType: s(g.mimeType, `maps[${u}].mimeType`, 64)
        };
      })
    };
    for (const [g, u] of (o.plotLines ?? []).entries()) {
      u.name || a({ scope: `plotLines[${g}]`, code: "INVALID_INPUT", detail: "Plot line name is required" });
      for (const [v, w] of (u.points ?? []).entries())
        w.title || a({ scope: `plotLines[${g}].points[${v}]`, code: "INVALID_INPUT", detail: "Plot point title is required" });
    }
    for (const [g, u] of (o.plotPoints ?? []).entries())
      u.title || a({ scope: `plotPoints[${g}]`, code: "INVALID_INPUT", detail: "Plot point title is required" });
    for (const [g, u] of (o.characters ?? []).entries())
      u.name || a({ scope: `characters[${g}]`, code: "INVALID_INPUT", detail: "Character name is required" });
    for (const [g, u] of (o.items ?? []).entries())
      u.name || a({ scope: `items[${g}]`, code: "INVALID_INPUT", detail: "Item name is required" });
    for (const [g, u] of (o.skills ?? []).entries())
      u.name || a({ scope: `skills[${g}]`, code: "INVALID_INPUT", detail: "Skill name is required" });
    for (const [g, u] of (o.maps ?? []).entries())
      if (u.name || a({ scope: `maps[${g}]`, code: "INVALID_INPUT", detail: "Map name is required" }), +!!u.imageBase64 + +!!u.imageUrl + +!!u.imagePrompt > 1 && a({
        scope: `maps[${g}]`,
        name: u.name,
        code: "INVALID_INPUT",
        detail: "Map image input must use only one source: imageBase64, imageUrl, or imagePrompt"
      }), u.imageUrl && !/^https?:\/\//i.test(u.imageUrl) && a({
        scope: `maps[${g}].imageUrl`,
        name: u.name,
        code: "INVALID_INPUT",
        detail: "Map imageUrl must start with http:// or https://"
      }), u.imageBase64)
        try {
          const w = Buffer.from(u.imageBase64, "base64").length;
          w === 0 && a({
            scope: `maps[${g}].imageBase64`,
            name: u.name,
            code: "INVALID_INPUT",
            detail: "Map imageBase64 is invalid"
          }), w > Sr && a({
            scope: `maps[${g}].imageBase64`,
            name: u.name,
            code: "INVALID_INPUT",
            detail: `Map imageBase64 exceeds ${Sr} bytes`
          });
        } catch {
          a({
            scope: `maps[${g}].imageBase64`,
            name: u.name,
            code: "INVALID_INPUT",
            detail: "Map imageBase64 is invalid"
          });
        }
    const c = (g, u) => {
      const v = /* @__PURE__ */ new Set();
      for (const w of g) {
        const A = (w.name || "").trim().toLowerCase();
        if (A) {
          if (v.has(A)) {
            a({
              scope: u,
              name: w.name,
              code: "CONFLICT",
              detail: `Duplicate name in current draft: ${w.name}`
            });
            continue;
          }
          v.add(A);
        }
      }
    };
    c(o.plotLines ?? [], "plotLines"), c(o.characters ?? [], "characters"), c(o.items ?? [], "items"), c(o.skills ?? [], "skills"), c(o.maps ?? [], "maps");
    const [d, l, m, h] = await Promise.all([
      S.plotLine.findMany({ where: { novelId: e.novelId }, select: { name: !0 } }),
      S.character.findMany({ where: { novelId: e.novelId }, select: { name: !0 } }),
      S.item.findMany({ where: { novelId: e.novelId }, select: { name: !0 } }),
      S.mapCanvas.findMany({ where: { novelId: e.novelId }, select: { name: !0 } })
    ]), p = {
      plotLines: new Set(d.map((g) => g.name.trim().toLowerCase())),
      characters: new Set(l.map((g) => g.name.trim().toLowerCase())),
      items: new Set(m.map((g) => g.name.trim().toLowerCase())),
      maps: new Set(h.map((g) => g.name.trim().toLowerCase()))
    }, f = (g, u, v) => {
      for (const w of g) {
        const A = (w.name || "").trim().toLowerCase();
        A && p[u].has(A) && a({
          scope: v,
          name: w.name,
          code: "CONFLICT",
          detail: `Name already exists in novel: ${w.name}`
        });
      }
    };
    return f(o.plotLines ?? [], "plotLines", "plotLines"), f(o.characters ?? [], "characters", "characters"), f(o.items ?? [], "items", "items"), f(o.skills ?? [], "items", "skills"), f(o.maps ?? [], "maps", "maps"), (((I = o.plotPoints) == null ? void 0 : I.length) ?? 0) > 0 && (((y = o.plotLines) == null ? void 0 : y.length) ?? 0) === 0 && r.push("Draft has plotPoints but no plotLines. System will create a default plot line when persisting."), {
      ok: t.length === 0,
      errors: t,
      warnings: r,
      normalizedDraft: o
    };
  }
  async confirmCreativeAssets(e) {
    var d, l, m, h, p, f;
    $("INFO", "AiService.confirmCreativeAssets.start", "Confirm creative assets start", {
      novelId: e.novelId,
      draftCounts: ve({
        plotLines: ((d = e.draft.plotLines) == null ? void 0 : d.length) ?? 0,
        plotPoints: ((l = e.draft.plotPoints) == null ? void 0 : l.length) ?? 0,
        characters: ((m = e.draft.characters) == null ? void 0 : m.length) ?? 0,
        items: ((h = e.draft.items) == null ? void 0 : h.length) ?? 0,
        skills: ((p = e.draft.skills) == null ? void 0 : p.length) ?? 0,
        maps: ((f = e.draft.maps) == null ? void 0 : f.length) ?? 0
      })
    });
    const t = await this.validateCreativeAssetsDraft(e), r = {
      plotLines: 0,
      plotPoints: 0,
      characters: 0,
      items: 0,
      skills: 0,
      maps: 0,
      mapImages: 0
    };
    if (!t.ok)
      return $("WARN", "AiService.confirmCreativeAssets.validationFailed", "Confirm creative assets validation failed", {
        novelId: e.novelId,
        errors: t.errors,
        warnings: t.warnings
      }), {
        success: !1,
        created: r,
        warnings: t.warnings,
        errors: t.errors,
        transactionMode: "atomic"
      };
    const a = t.normalizedDraft, s = this.getProvider(), i = [], o = [];
    let c = { ...r };
    try {
      await S.$transaction(async (y) => {
        const g = { ...r }, u = /* @__PURE__ */ new Map();
        for (const w of a.plotLines ?? []) {
          const A = await y.plotLine.create({
            data: {
              novelId: e.novelId,
              name: w.name,
              description: w.description || null,
              color: w.color || "#6366f1",
              sortOrder: Date.now() + g.plotLines
            }
          });
          o.push(tt("plotLine", A)), u.set(w.name.toLowerCase(), A.id), g.plotLines += 1;
          for (const T of w.points ?? []) {
            const E = await y.plotPoint.create({
              data: {
                novelId: e.novelId,
                plotLineId: A.id,
                title: T.title,
                description: T.description || null,
                type: T.type || "event",
                status: T.status || "active",
                order: Date.now() + g.plotPoints
              }
            });
            o.push(tt("plotPoint", E)), g.plotPoints += 1;
          }
        }
        const v = async (w) => {
          const A = (w || "").trim().toLowerCase();
          if (A && u.has(A))
            return u.get(A);
          const T = u.values().next().value;
          if (T)
            return T;
          const E = "AI 主线", C = await y.plotLine.create({
            data: {
              novelId: e.novelId,
              name: E,
              description: "Auto-created for loose plot points",
              color: "#6366f1",
              sortOrder: Date.now() + g.plotLines
            }
          });
          return o.push(tt("plotLine", C)), u.set(E.toLowerCase(), C.id), g.plotLines += 1, C.id;
        };
        for (const w of a.plotPoints ?? []) {
          const A = await v(w.plotLineName), T = await y.plotPoint.create({
            data: {
              novelId: e.novelId,
              plotLineId: A,
              title: w.title,
              description: w.description || null,
              type: w.type || "event",
              status: w.status || "active",
              order: Date.now() + g.plotPoints
            }
          });
          o.push(tt("plotPoint", T)), g.plotPoints += 1;
        }
        for (const w of a.characters ?? []) {
          const A = await y.character.create({
            data: {
              novelId: e.novelId,
              name: w.name,
              role: w.role || null,
              description: w.description || null,
              profile: Er(w.profile),
              sortOrder: Date.now() + g.characters
            }
          });
          o.push(tt("character", A)), g.characters += 1;
        }
        for (const w of a.items ?? []) {
          const A = await y.item.create({
            data: {
              novelId: e.novelId,
              name: w.name,
              type: w.type || "item",
              description: w.description || null,
              profile: Er(w.profile),
              sortOrder: Date.now() + g.items
            }
          });
          o.push(tt("item", A)), g.items += 1;
        }
        for (const w of a.skills ?? []) {
          const A = await y.item.create({
            data: {
              novelId: e.novelId,
              name: w.name,
              type: "skill",
              description: w.description || null,
              profile: Er(w.profile),
              sortOrder: Date.now() + g.items + g.skills
            }
          });
          o.push(tt("item", A)), g.skills += 1;
        }
        for (const w of a.maps ?? []) {
          const A = await y.mapCanvas.create({
            data: {
              novelId: e.novelId,
              name: w.name,
              type: w.type || "world",
              description: w.description || null,
              sortOrder: Date.now() + g.maps
            }
          });
          let T = A;
          g.maps += 1;
          let E = null;
          if (w.imageBase64 || w.imageUrl)
            E = {
              imageBase64: w.imageBase64,
              imageUrl: w.imageUrl,
              mimeType: w.mimeType
            };
          else if (w.imagePrompt) {
            if (!s.generateImage)
              throw new k("INVALID_INPUT", `Provider ${s.name} does not support image generation`);
            const C = await s.generateImage({ prompt: w.imagePrompt });
            if (!(C != null && C.imageBase64) && !(C != null && C.imageUrl))
              throw new k("PROVIDER_UNAVAILABLE", `Map image generation returned empty data for ${w.name}`);
            E = {
              imageBase64: C.imageBase64,
              imageUrl: C.imageUrl,
              mimeType: C.mimeType
            };
          }
          if (E) {
            const C = await this.saveImageAsset(e.novelId, A.id, E);
            i.push(C.absolutePath), T = await y.mapCanvas.update({
              where: { id: A.id },
              data: { background: C.relativePath }
            }), g.mapImages += 1;
          }
          o.push(tt("mapCanvas", T));
        }
        c = g;
      });
      const I = {
        success: !0,
        created: c,
        createdEntities: o,
        warnings: t.warnings,
        transactionMode: "atomic"
      };
      return this.refreshLatestCreativeAssetIndexes(e.novelId, a).catch((y) => {
        console.warn("[RAG] Failed to refresh creative asset indexes:", y);
      }), $("INFO", "AiService.confirmCreativeAssets.success", "Confirm creative assets success", {
        novelId: e.novelId,
        created: c,
        warningCount: t.warnings.length
      }), I;
    } catch (I) {
      Se("AiService.confirmCreativeAssets.error", I, {
        novelId: e.novelId
      });
      for (const u of i)
        try {
          re.existsSync(u) && re.unlinkSync(u);
        } catch {
        }
      const y = He(I), g = y.code === "INVALID_INPUT" ? "INVALID_INPUT" : y.code === "CONFLICT" ? "CONFLICT" : y.code === "UNKNOWN" ? "UNKNOWN" : "PERSISTENCE_ERROR";
      return {
        success: !1,
        created: r,
        warnings: t.warnings,
        errors: [
          {
            scope: "confirmCreativeAssets",
            code: g,
            detail: y.message || "Creative assets persistence failed"
          }
        ],
        transactionMode: "atomic"
      };
    }
  }
  async previewMapPrompt(e) {
    var r;
    $("INFO", "AiService.previewMapPrompt.start", "Preview map prompt start", {
      novelId: e.novelId,
      mapId: e.mapId,
      promptLength: ((r = e.prompt) == null ? void 0 : r.length) ?? 0
    });
    const t = await this.buildMapPromptBundle(e);
    return $("INFO", "AiService.previewMapPrompt.success", "Preview map prompt success", {
      novelId: e.novelId,
      mapId: e.mapId
    }), {
      structured: t.structured,
      rawPrompt: t.effectiveUserPrompt,
      editableUserPrompt: t.defaultUserPrompt,
      usedWorldLore: t.usedWorldLore
    };
  }
  async generateMapImage(e) {
    var a, s, i, o;
    $("INFO", "AiService.generateMapImage.start", "Generate map image start", {
      novelId: e.novelId,
      mapId: e.mapId,
      promptLength: ((a = e.prompt) == null ? void 0 : a.length) ?? 0,
      providerType: this.settingsCache.providerType
    });
    const t = Date.now(), r = (c) => (this.recordMapImageCall({
      ok: c.ok,
      code: c.code,
      detail: c.detail,
      latencyMs: Date.now() - t
    }), c);
    try {
      const c = !!((s = e.prompt) != null && s.trim()), d = !!((i = e.overrideUserPrompt) != null && i.trim());
      if (!c && !d)
        return r({ ok: !1, code: "INVALID_INPUT", detail: "Map prompt is empty" });
      const l = this.getProvider();
      if (!l.generateImage)
        return r({ ok: !1, code: "INVALID_INPUT", detail: `Provider ${l.name} does not support image generation` });
      const m = await this.buildMapPromptBundle(e), h = await l.generateImage({
        prompt: m.effectiveUserPrompt,
        model: this.settingsCache.http.imageModel || void 0,
        size: e.imageSize || this.settingsCache.http.imageSize || void 0,
        outputFormat: this.settingsCache.http.imageOutputFormat || void 0,
        watermark: this.settingsCache.http.imageWatermark
      });
      if (!h.imageBase64 && !h.imageUrl)
        return r({ ok: !1, code: "PROVIDER_UNAVAILABLE", detail: "Provider did not return any image data" });
      let p = e.mapId;
      if (p || (p = (await S.mapCanvas.create({
        data: {
          novelId: e.novelId,
          name: ((o = e.mapName) == null ? void 0 : o.trim()) || `AI 地图 ${(/* @__PURE__ */ new Date()).toLocaleString()}`,
          type: e.mapType || "world",
          description: `Generated by AI with prompt: ${e.prompt}`,
          sortOrder: Date.now()
        }
      })).id), !p)
        throw new k("PERSISTENCE_ERROR", "Map id is missing after map creation");
      const f = await this.saveImageAsset(e.novelId, p, {
        imageBase64: h.imageBase64,
        imageUrl: h.imageUrl,
        mimeType: h.mimeType
      });
      await S.mapCanvas.update({
        where: { id: p },
        data: { background: f.relativePath }
      });
      const I = r({
        ok: !0,
        detail: "Map image generated and stored successfully",
        mapId: p,
        path: f.relativePath
      });
      return $("INFO", "AiService.generateMapImage.success", "Generate map image success", {
        novelId: e.novelId,
        mapId: p,
        imagePath: f.relativePath
      }), I;
    } catch (c) {
      Se("AiService.generateMapImage.error", c, {
        novelId: e.novelId,
        mapId: e.mapId
      });
      const d = He(c);
      return r({
        ok: !1,
        code: d.code,
        detail: d.message || "Map generation failed"
      });
    }
  }
  async executeAction(e) {
    const t = this.capabilityRegistry.get(e.actionId);
    if (!t)
      throw new k("INVALID_INPUT", `Unknown actionId: ${e.actionId}`);
    try {
      const r = await t(e.payload);
      return this.refreshRagAfterAction(e.actionId, r), r;
    } catch (r) {
      throw He(r);
    }
  }
  async invokeOpenClawTool(e) {
    try {
      return { ok: !0, data: await this.executeAction({
        actionId: e.name,
        payload: e.arguments
      }) };
    } catch (t) {
      const r = He(t);
      return {
        ok: !1,
        error: At(r.code, r.message || "OpenClaw invoke failed"),
        code: r.code
      };
    }
  }
  async invokeOpenClawSkill(e) {
    try {
      return { ok: !0, data: await this.executeAction({
        actionId: e.name,
        payload: e.input
      }) };
    } catch (t) {
      const r = He(t);
      return {
        ok: !1,
        error: At(r.code, r.message || "OpenClaw skill invoke failed"),
        code: r.code
      };
    }
  }
  compactContinueHardContext(e) {
    const t = Array.isArray(e.worldSettings) ? e.worldSettings : [], r = Array.isArray(e.plotLines) ? e.plotLines : [], a = Array.isArray(e.characters) ? e.characters : [], s = Array.isArray(e.items) ? e.items : [], i = Array.isArray(e.maps) ? e.maps : [];
    return {
      worldSettings: t.slice(0, 60).map((o) => ({
        name: x(o == null ? void 0 : o.name, 80),
        type: x(o == null ? void 0 : o.type, 32) || "other",
        content: x(o == null ? void 0 : o.content, 300) || x(o == null ? void 0 : o.description, 300)
      })).filter((o) => o.content),
      plotLines: r.slice(0, 40).map((o) => ({
        name: x(o == null ? void 0 : o.name, 100),
        description: x(o == null ? void 0 : o.description, 260),
        points: Array.isArray(o == null ? void 0 : o.points) ? o.points.filter((c) => String((c == null ? void 0 : c.status) || "").trim().toLowerCase() !== "resolved").slice(0, 12).map((c) => ({
          title: x(c == null ? void 0 : c.title, 100),
          description: x(c == null ? void 0 : c.description, 220),
          type: x(c == null ? void 0 : c.type, 24) || "event",
          status: x(c == null ? void 0 : c.status, 24) || "active"
        })).filter((c) => c.title || c.description) : []
      })).filter((o) => {
        var c;
        return o.name || (((c = o.points) == null ? void 0 : c.length) ?? 0) > 0;
      }),
      characters: a.slice(0, 120).map((o) => ({
        name: x(o == null ? void 0 : o.name, 80),
        role: x(o == null ? void 0 : o.role, 32),
        description: x(o == null ? void 0 : o.description, 220)
      })).filter((o) => o.name && (o.role || o.description)),
      items: s.slice(0, 120).map((o) => ({
        name: x(o == null ? void 0 : o.name, 80),
        type: x(o == null ? void 0 : o.type, 32) || "item",
        description: x(o == null ? void 0 : o.description, 220)
      })).filter((o) => o.name && o.description),
      maps: i.slice(0, 60).map((o) => ({
        name: x(o == null ? void 0 : o.name, 80),
        type: x(o == null ? void 0 : o.type, 24) || "world",
        description: x(o == null ? void 0 : o.description, 220)
      })).filter((o) => o.name && o.description)
    };
  }
  compactContinueDynamicContext(e) {
    const t = Array.isArray(e.recentChapters) ? e.recentChapters : [], r = Array.isArray(e.selectedIdeas) ? e.selectedIdeas : [], a = Array.isArray(e.selectedIdeaEntities) ? e.selectedIdeaEntities : [], s = Array.isArray(e.narrativeSummaries) ? e.narrativeSummaries : [], i = x(e.currentLocation, 120);
    return {
      recentChapters: t.slice(0, 20).map((o) => ({
        title: x(o == null ? void 0 : o.title, 120),
        contentMode: x(o == null ? void 0 : o.contentMode, 24),
        excerpt: x(o == null ? void 0 : o.excerpt, (o == null ? void 0 : o.contentMode) === "summary" || (o == null ? void 0 : o.contentMode) === "excerpt" ? 2400 : 12e3)
      })).filter((o) => o.title || o.excerpt),
      selectedIdeas: r.slice(0, 20).map((o) => ({
        content: x(o == null ? void 0 : o.content, 800),
        quote: x(o == null ? void 0 : o.quote, 300),
        tags: Array.isArray(o == null ? void 0 : o.tags) ? o.tags.slice(0, 12).map((c) => x(c, 32)).filter(Boolean) : []
      })).filter((o) => o.content || o.quote),
      selectedIdeaEntities: a.slice(0, 20).map((o) => ({
        name: x(o == null ? void 0 : o.name, 80),
        kind: x(o == null ? void 0 : o.kind, 24)
      })).filter((o) => o.name && o.kind),
      currentChapterBeforeCursor: x(e.currentChapterBeforeCursor, 12e3),
      ...i ? { currentLocation: i } : {},
      narrativeSummaries: s.slice(0, 4).map((o) => ({
        level: (o == null ? void 0 : o.level) === "volume" ? "volume" : "novel",
        title: x(o == null ? void 0 : o.title, 100),
        summaryText: x(o == null ? void 0 : o.summaryText, 1200),
        keyFacts: Array.isArray(o == null ? void 0 : o.keyFacts) ? It(o.keyFacts.map((c) => x(c, 160)).filter(Boolean), 5) : []
      }))
    };
  }
  async buildContinuePromptBundle(e) {
    var v, w, A, T;
    const t = /^zh/i.test(String(e.locale || "").trim()), r = e.mode === "new_chapter" ? "new_chapter" : e.mode === "rewrite_chapter" ? "rewrite_chapter" : "continue_chapter", a = e.preparedContext, i = ((v = a == null ? void 0 : a.policy) == null ? void 0 : v.version) === "continuation-context-v1" && ((w = a.snapshot) == null ? void 0 : w.novelId) === e.novelId && ((A = a.snapshot) == null ? void 0 : A.anchorChapterId) === e.chapterId ? a : await this.contextBuilder.buildForContinueWriting({
      ...e,
      mode: r === "new_chapter" ? "new_chapter" : "continue_chapter",
      recentRawChapterCount: e.recentRawChapterCount ?? this.settingsCache.summary.recentChapterRawCount
    }), o = this.compactContinueHardContext(i.hardContext), c = r === "rewrite_chapter" ? {
      ...i.dynamicContext,
      currentChapterBeforeCursor: Nn(e.currentContent || i.currentContentSource)
    } : i.dynamicContext, d = this.compactContinueDynamicContext(c), l = x(e.userIntent, 800), m = x(e.currentLocation, 120), h = e.batchContext && typeof e.batchContext == "object" ? e.batchContext : void 0, p = {
      ...i.params,
      targetLength: t ? `约${Math.max(100, Math.min(4e3, Number(i.params.targetLength || 500)))}汉字` : `about ${Math.max(100, Math.min(4e3, Number(i.params.targetLength || 500)))} Chinese characters`
    }, f = r === "rewrite_chapter" ? t ? "你是中文小说章节改写助手。输出完整替换正文，严格遵守世界观、大纲与跨章连续性。" : "Rewrite the complete fiction chapter with strict consistency to world settings, outline, and cross-chapter continuity." : t ? "你是中文小说续写助手。严格遵守世界观和大纲，不得破坏既有设定与人物行为逻辑。" : "Continue writing with strict consistency to world settings and plot outline. Do not break established lore.", y = [
      `WriteMode=${r}`,
      `HardContext=
${JSON.stringify(o, null, 2).slice(0, 18e3)}`,
      `DynamicContext=
${JSON.stringify(d, null, 2).slice(0, 6e4)}`,
      `ContinuationContextPolicy=
${JSON.stringify(i.policy, null, 2)}`,
      ...h ? [`ChapterBatchContext=
${JSON.stringify(h, null, 2).slice(0, 42e3)}`] : [],
      `WriteParams=
${JSON.stringify(p, null, 2)}`,
      ...l ? [`UserIntent=${l}`] : [],
      ...m ? [`CurrentLocation=${m}`] : [],
      r === "rewrite_chapter" ? t ? "Constraint=输出目标章节的完整替换正文；保留应保留的事实与功能，但不得在原文后追加续写，不要解释修改过程。" : "Constraint=Output a complete replacement chapter. Preserve required facts and function; do not append to the original or explain edits." : r === "new_chapter" ? t ? "Constraint=基于大纲与世界观写出新章节开场，不得复述已有段落。" : "Constraint=Start a fresh chapter opening based on outline and world context. Do not echo prior chapter paragraphs." : t ? "Constraint=仅输出新增续写内容，不得重复当前章节或上下文已出现段落。" : "Constraint=Output must be NEW continuation content only. Do not restate prior paragraphs from current chapter or context.",
      t ? "Constraint=@实体名 表示对上下文中同名角色/物品/地点/设定的引用，续写时应保持实体设定一致。" : "Constraint=@EntityName means referencing the same named entity from context; keep entity traits consistent.",
      ...l ? [t ? "Constraint=尽量满足用户意图，但不得违反世界观与主线大纲。" : "Constraint=Prioritize the user intent when possible, but never violate established world settings and plot outline."] : [],
      t ? "Constraint=请严格遵守 HardContext 中的世界观、角色性格和物品设定；情节推进需与已有情节点保持一致。" : "Constraint=Strictly follow HardContext lore, character traits, and item settings; keep progression aligned with existing plot points.",
      r === "rewrite_chapter" ? t ? "Constraint=currentChapterBeforeCursor 是待改写原文，只用于保留事实、人物状态和章节功能；输出必须是完整新版本。" : "Constraint=currentChapterBeforeCursor is the source chapter. Preserve required facts, state, and function while outputting a complete new version." : t ? "Constraint=你的任务是续写光标后的新内容，不要重复 currentChapterBeforeCursor 里的任何句子。" : "Constraint=Write only the continuation after cursor; do not repeat any sentence from currentChapterBeforeCursor."
    ].join(`

`), g = (T = e.overrideUserPrompt) != null && T.trim() ? e.overrideUserPrompt.trim() : y, u = {
      ...i.params,
      contextPolicy: i.policy,
      contextSnapshot: {
        scopeId: i.snapshot.scopeId,
        anchorChapterId: i.snapshot.anchorChapterId,
        chapterSources: i.snapshot.chapterSources.map((E) => ({
          chapterId: E.chapterId,
          title: E.title,
          contentMode: E.contentMode,
          version: E.version,
          contentHash: E.contentHash,
          source: E.source,
          summaryFresh: E.summaryFresh
        })),
        narrativeSummaryIds: i.snapshot.narrativeSummaryIds,
        estimatedTokens: i.snapshot.estimatedTokens
      },
      ...l ? { userIntent: l } : {},
      ...m ? { currentLocation: m } : {},
      ...h ? { batchContext: h } : {}
    };
    return {
      systemPrompt: f,
      defaultUserPrompt: y,
      effectiveUserPrompt: g,
      structured: {
        goal: r === "rewrite_chapter" ? t ? "生成目标章节的完整替换正文。" : "Generate a complete replacement for the target chapter." : r === "new_chapter" ? t ? "生成新章节开场内容。" : "Generate opening content for a new chapter." : t ? "仅生成续写新增内容。" : "Generate continuation content only.",
        contextRefs: i.usedContext,
        params: u,
        constraints: [
          ...t ? ["严格遵守世界观与大纲一致性。"] : ["Keep strict consistency with world settings and outline."],
          ...l ? [t ? "在不冲突时优先满足用户意图。" : "Respect user intent when it does not conflict with hard context."] : [],
          ...r === "rewrite_chapter" ? t ? ["输出完整替换正文。", "不得追加在原文之后或解释修改过程。"] : ["Output a complete replacement chapter.", "Do not append to the original or explain edits."] : t ? ["不得重复已有段落。", "只输出生成的续写正文。"] : ["Do not repeat existing paragraphs.", "Output only generated chapter text."]
        ]
      },
      usedContext: i.usedContext,
      warnings: i.warnings,
      contextPolicy: i.policy,
      contextSnapshot: i.snapshot
    };
  }
  async buildCreativeAssetsPromptBundle(e) {
    var I;
    const t = this.resolveCreativeTargetSections(e), r = (e.locale || "zh").startsWith("zh"), a = await S.novel.findUnique({
      where: { id: e.novelId },
      select: { id: !0, title: !0, description: !0 }
    }), s = await this.contextBuilder.buildForCreativeAssets(e), i = r ? "你是一位小说创作助手，擅长根据用户的创意需求和已有小说内容生成结构化的创作素材。请严格以 JSON 格式输出，只输出 JSON，不要添加任何其他文字。所有生成的名称、描述等文本内容必须使用中文。生成的内容应与小说已有的角色、情节、世界观保持一致和关联。" : "You are a novel creation assistant. Generate structured creative assets in strict JSON format based on existing novel content. Output only JSON, no extra text. Generated content should be consistent with existing characters, plot, and world settings.", o = {
      plotLines: [{ name: "string", description: "string?" }],
      plotPoints: [{ title: "string", description: "string?", plotLineName: "string?" }],
      characters: [{ name: "string", role: "string?", description: "string?" }],
      items: [{ name: "string", type: "item|skill|location", description: "string?" }],
      skills: [{ name: "string", description: "string?" }],
      maps: [{ name: "string", type: "world|region|scene", description: "string?", imagePrompt: "string?" }]
    }, c = r ? [
      "仅返回严格的 JSON，不要包含 markdown 代码块标记或其他文字",
      "必须为所有请求的 section 生成内容，不得遗漏任何一个板块",
      `请求的 section 列表: ${t.join(", ")}`,
      "未请求的 section 必须设为空数组",
      "生成内容必须与已有小说内容（角色、情节、世界观）保持一致和关联",
      "避免与已存在的实体重名",
      "所有字段内容简洁、可直接使用",
      "所有名称和描述必须使用中文"
    ] : [
      "return strict JSON only, no markdown code fences or extra text",
      "generate content for ALL requested sections, do not leave any empty",
      `requested sections: ${t.join(", ")}`,
      "all unrequested sections must be empty arrays",
      "generated content must be consistent and related to existing novel content",
      "avoid duplicate names against existing entities",
      "fields should be concise and directly usable"
    ], d = {
      task: "creative_assets_generation",
      language: r ? "Chinese" : "English",
      brief: e.brief,
      novel: {
        title: (a == null ? void 0 : a.title) || "",
        description: (a == null ? void 0 : a.description) || ""
      },
      targetSections: t,
      outputShape: t,
      outputSchema: o,
      constraints: c
    };
    s.existingEntities.characters.length > 0 && (d.existingCharacters = s.existingEntities.characters), s.existingEntities.items.length > 0 && (d.existingItems = s.existingEntities.items), s.existingEntities.plotLines.length > 0 && (d.existingPlotLines = s.existingEntities.plotLines), s.existingEntities.worldSettings.length > 0 && (d.worldSettings = s.existingEntities.worldSettings), s.recentSummaries.length > 0 && (d.recentChapterSummaries = s.recentSummaries), s.narrativeSummaries.length > 0 && (d.narrativeSummary = s.narrativeSummaries[0]);
    const l = JSON.stringify(d), m = (I = e.overrideUserPrompt) != null && I.trim() ? e.overrideUserPrompt.trim() : l, h = [
      `Novel: ${(a == null ? void 0 : a.title) || e.novelId}`,
      ...s.usedContext
    ], p = r ? "根据用户创意简述和已有小说内容，生成可编辑的草稿素材。" : "Generate editable draft assets based on user brief and existing novel content.", f = r ? ["仅输出严格 JSON", "返回所有请求的板块", "与已有内容关联", "内容简洁可用", "避免重名", "使用中文"] : ["Output strict JSON.", "Return ALL selected sections.", "Stay consistent with existing content.", "Prefer concise fields.", "Avoid name conflicts."];
    return {
      systemPrompt: i,
      defaultUserPrompt: l,
      effectiveUserPrompt: m,
      structured: {
        goal: p,
        contextRefs: h,
        params: {
          briefLength: e.brief.trim().length,
          sections: t,
          locale: e.locale || "zh",
          estimatedContextTokens: s.estimatedTokens
        },
        constraints: f
      },
      usedContext: h,
      estimatedTokens: s.estimatedTokens
    };
  }
  async buildMapPromptBundle(e) {
    var c;
    const r = (await S.worldSetting.findMany({
      where: { novelId: e.novelId },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: !0, name: !0, content: !0 }
    })).map((d) => ({
      id: d.id,
      title: String(d.name || "Untitled"),
      excerpt: String(d.content || "").slice(0, 180)
    })), a = Lo(e.styleTemplate), s = r.length > 0 ? r.map((d, l) => `${l + 1}. ${d.title}: ${d.excerpt}`).join(`
`) : "No explicit world lore provided.", i = [
      a || "Style: follow user requested style.",
      `ImageSize=${e.imageSize || this.settingsCache.http.imageSize || "2K"}`,
      "Task: Generate a clean map background image.",
      `UserRequest=${e.prompt}`,
      "WorldLore:",
      s,
      "Constraints:",
      "- avoid text labels or UI marks",
      "- keep high readability for map canvas editing",
      "- preserve coherence with world lore"
    ].join(`
`), o = (c = e.overrideUserPrompt) != null && c.trim() ? e.overrideUserPrompt.trim() : i;
    return {
      defaultUserPrompt: i,
      effectiveUserPrompt: o,
      structured: {
        goal: "Generate map background image aligned with world lore.",
        contextRefs: [
          `Map type: ${e.mapType || "world"}`,
          `Map name: ${e.mapName || "(new map)"}`,
          `World lore refs: ${r.length}`
        ],
        params: {
          imageSize: e.imageSize || this.settingsCache.http.imageSize || "2K",
          styleTemplate: e.styleTemplate || "default"
        },
        constraints: [
          "No labels or UI overlays in generated image.",
          "Map should be readable for later annotation.",
          "Use world lore when available."
        ]
      },
      usedWorldLore: r
    };
  }
  getProvider() {
    return this.settingsCache.providerType === "mcp-cli" ? new fn(this.settingsCache) : new ca(this.settingsCache);
  }
  async saveImageAsset(e, t, r) {
    let a = r.mimeType || "image/png", s;
    if (r.imageBase64)
      s = Buffer.from(r.imageBase64, "base64");
    else if (r.imageUrl) {
      const l = await fetch(r.imageUrl);
      if (!l.ok)
        throw new Error(`Image download failed: ${l.status}`);
      const m = l.headers.get("content-type") || "";
      m && (a = m);
      const h = await l.arrayBuffer();
      s = Buffer.from(h);
    } else
      throw new Error("No image data provided");
    if (s.length === 0)
      throw new Error("Image data is empty");
    if (s.length > Sr)
      throw new Error("Image exceeds maximum size limit");
    if (!a.startsWith("image/"))
      throw new Error(`Invalid mime type: ${a}`);
    const i = Oo(a), o = D.join(this.userDataPath, "maps", e);
    re.existsSync(o) || re.mkdirSync(o, { recursive: !0 });
    const c = ko(`ai-${t}-${Date.now()}.${i}`), d = D.join(o, c);
    return re.writeFileSync(d, s), {
      relativePath: `maps/${e}/${c}`,
      absolutePath: d
    };
  }
  loadSettings() {
    try {
      if (!re.existsSync(this.settingsFilePath))
        return nt;
      const e = re.readFileSync(this.settingsFilePath, "utf8"), t = JSON.parse(e);
      return {
        ...nt,
        ...t,
        http: { ...nt.http, ...t.http ?? {} },
        mcpCli: { ...nt.mcpCli, ...t.mcpCli ?? {} },
        proxy: { ...nt.proxy, ...t.proxy ?? {} },
        summary: { ...nt.summary, ...t.summary ?? {} },
        embedding: { ...nt.embedding, ...t.embedding ?? {} }
      };
    } catch (e) {
      return console.error("[AI] Failed to load settings, fallback to defaults:", e), nt;
    }
  }
  persistSettings() {
    try {
      const e = D.dirname(this.settingsFilePath);
      re.existsSync(e) || re.mkdirSync(e, { recursive: !0 }), re.writeFileSync(this.settingsFilePath, JSON.stringify(this.settingsCache, null, 2), "utf8");
    } catch (e) {
      console.error("[AI] Failed to persist settings:", e);
    }
  }
  loadMapImageStats() {
    const e = {
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      rateLimitFailures: 0,
      updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
    };
    try {
      if (!re.existsSync(this.mapImageStatsPath))
        return e;
      const t = re.readFileSync(this.mapImageStatsPath, "utf8"), r = JSON.parse(t);
      return {
        totalCalls: r.totalCalls ?? 0,
        successCalls: r.successCalls ?? 0,
        failedCalls: r.failedCalls ?? 0,
        rateLimitFailures: r.rateLimitFailures ?? 0,
        lastFailureCode: r.lastFailureCode || void 0,
        lastFailureAt: r.lastFailureAt || void 0,
        updatedAt: r.updatedAt || e.updatedAt
      };
    } catch (t) {
      return console.warn("[AI] Failed to load map image stats, fallback to defaults:", t), e;
    }
  }
  persistMapImageStats() {
    try {
      const e = D.dirname(this.mapImageStatsPath);
      re.existsSync(e) || re.mkdirSync(e, { recursive: !0 }), re.writeFileSync(this.mapImageStatsPath, JSON.stringify(this.mapImageStatsCache, null, 2), "utf8");
    } catch (e) {
      console.warn("[AI] Failed to persist map image stats:", e);
    }
  }
  recordMapImageCall(e) {
    const t = (e.code || "").toLowerCase(), r = (e.detail || "").toLowerCase(), a = t.includes("rate") || t.includes("429") || r.includes("429") || r.includes("rate limit") || r.includes("quota");
    this.mapImageStatsCache = {
      ...this.mapImageStatsCache,
      totalCalls: this.mapImageStatsCache.totalCalls + 1,
      successCalls: this.mapImageStatsCache.successCalls + (e.ok ? 1 : 0),
      failedCalls: this.mapImageStatsCache.failedCalls + (e.ok ? 0 : 1),
      rateLimitFailures: this.mapImageStatsCache.rateLimitFailures + (!e.ok && a ? 1 : 0),
      lastFailureCode: e.ok ? this.mapImageStatsCache.lastFailureCode : e.code || "UNKNOWN",
      lastFailureAt: e.ok ? this.mapImageStatsCache.lastFailureAt : (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }, this.persistMapImageStats();
  }
}
const Tr = {
  sessions: [],
  batches: []
};
function U(n, e) {
  return Object.assign(new Error(e), { code: n });
}
function $o(n, e) {
  const t = String((n == null ? void 0 : n.title) ?? "").trim(), r = String((n == null ? void 0 : n.chapterGoal) ?? "").trim(), a = String((n == null ? void 0 : n.coreConflict) ?? "").trim(), s = String((n == null ? void 0 : n.endingHook) ?? "").trim(), i = Number(n == null ? void 0 : n.targetWordCount);
  if (!t || !r || !a || !s)
    throw U("INVALID_INPUT", `Chapter beat ${e + 1} is incomplete`);
  if (!Number.isInteger(i) || i < 100 || i > 5e4)
    throw U("INVALID_INPUT", `Chapter beat ${e + 1} targetWordCount must be between 100 and 50000`);
  return {
    beatId: le(),
    childIndex: e,
    title: t,
    chapterGoal: r,
    coreConflict: a,
    keyEvents: Array.isArray(n.keyEvents) ? n.keyEvents.map(String).map((o) => o.trim()).filter(Boolean) : [],
    reveals: Array.isArray(n.reveals) ? n.reveals.map(String).map((o) => o.trim()).filter(Boolean) : [],
    endingHook: s,
    targetWordCount: i
  };
}
function xn(n) {
  if (!Array.isArray(n) || n.length < 1 || n.length > 5)
    throw U("INVALID_INPUT", "A chapter draft batch must contain between 1 and 5 beats");
  return n.map($o);
}
function Bo() {
  return {
    characterLocations: {},
    relationshipChanges: [],
    knowledgeState: {},
    foreshadowing: [],
    timeline: [],
    itemStates: {},
    unresolvedConflicts: [],
    stateDeltas: []
  };
}
function _n(n, e, t, r, a = 1) {
  if (!r)
    return n;
  const s = r.coreConflict.trim(), i = {
    ...n,
    timeline: [
      ...n.timeline,
      {
        childIndex: e,
        draftSessionId: t,
        title: r.title,
        keyEvents: r.keyEvents,
        reveals: r.reveals,
        summary: r.summary
      }
    ],
    foreshadowing: [
      ...n.foreshadowing,
      ...r.endingHook.trim() ? [{ childIndex: e, hook: r.endingHook.trim(), status: "open" }] : []
    ],
    unresolvedConflicts: s && !n.unresolvedConflicts.includes(s) ? [...n.unresolvedConflicts, s] : n.unresolvedConflicts,
    stateDeltas: n.stateDeltas ?? []
  };
  return r.stateDelta ? Ta(i, r.stateDelta, { childIndex: e, draftSessionId: t, generationRevision: a }) : i;
}
function Ta(n, e, t) {
  const r = { ...n.characterLocations };
  for (const d of e.characterLocations)
    r[d.characterKey] = d.location;
  const a = Object.fromEntries(
    Object.entries(n.knowledgeState).map(([d, l]) => [d, [...l]])
  );
  for (const d of e.knowledgeChanges) {
    const l = new Set(a[d.characterKey] ?? []);
    for (const m of d.forgotten)
      l.delete(m);
    for (const m of d.learned)
      l.add(m);
    a[d.characterKey] = [...l];
  }
  const s = { ...n.itemStates };
  for (const d of e.itemStates)
    s[d.itemKey] = d.state;
  const i = new Set(e.resolvedConflicts.map((d) => d.conflict)), o = n.unresolvedConflicts.filter((d) => !i.has(d));
  for (const d of e.openedConflicts)
    o.includes(d.conflict) || o.push(d.conflict);
  const c = (n.stateDeltas ?? []).filter((d) => !(d.childIndex === t.childIndex && d.draftSessionId === t.draftSessionId));
  return c.push({
    ...e,
    childIndex: t.childIndex,
    generationRevision: t.generationRevision ?? 1,
    draftSessionId: t.draftSessionId
  }), {
    ...n,
    characterLocations: r,
    relationshipChanges: [
      ...n.relationshipChanges.filter((d) => !(d.source === "state_extraction" && d.childIndex === t.childIndex && d.draftSessionId === t.draftSessionId)),
      ...e.relationshipChanges.map((d) => ({
        ...d,
        source: "state_extraction",
        childIndex: t.childIndex,
        draftSessionId: t.draftSessionId,
        generationRevision: t.generationRevision ?? 1
      }))
    ],
    knowledgeState: a,
    itemStates: s,
    unresolvedConflicts: o,
    stateDeltas: c
  };
}
function Rn(n, e) {
  const t = (s) => typeof s.childIndex != "number" || s.childIndex < e, r = (n.stateLedger.stateDeltas ?? []).filter((s) => s.childIndex < e);
  let a = {
    ...n.stateLedger,
    characterLocations: {},
    relationshipChanges: n.stateLedger.relationshipChanges.filter((s) => s.source !== "state_extraction" && t(s)),
    knowledgeState: {},
    foreshadowing: n.stateLedger.foreshadowing.filter(t),
    timeline: n.stateLedger.timeline.filter(t),
    itemStates: {},
    unresolvedConflicts: n.outline.beats.filter((s) => s.childIndex < e).map((s) => s.coreConflict.trim()).filter(Boolean),
    stateDeltas: []
  };
  for (const s of r)
    a = Ta(a, s, {
      childIndex: s.childIndex,
      draftSessionId: s.draftSessionId,
      generationRevision: s.generationRevision
    });
  return a;
}
class Fo {
  constructor(e) {
    H(this, "getUserDataPath");
    H(this, "cache", null);
    this.getUserDataPath = e;
  }
  getStoreDir() {
    return D.join(this.getUserDataPath(), "automation");
  }
  getStorePath() {
    return D.join(this.getStoreDir(), "draft-sessions.json");
  }
  async ensureLoaded() {
    if (this.cache)
      return;
    const e = this.getStorePath();
    try {
      const t = await Te.readFile(e, "utf8"), r = JSON.parse(t);
      this.cache = {
        sessions: Array.isArray(r.sessions) ? r.sessions : [],
        batches: Array.isArray(r.batches) ? r.batches : []
      };
    } catch (t) {
      if ((t == null ? void 0 : t.code) !== "ENOENT")
        throw t;
      this.cache = {
        sessions: [...Tr.sessions],
        batches: [...Tr.batches]
      };
    }
  }
  async flush() {
    await Te.mkdir(this.getStoreDir(), { recursive: !0 }), await Te.writeFile(this.getStorePath(), JSON.stringify(this.cache ?? Tr, null, 2), "utf8");
  }
  createSessionRecord(e) {
    const t = (/* @__PURE__ */ new Date()).toISOString();
    return {
      ...e,
      draftSessionId: le(),
      version: 1,
      createdAt: t,
      updatedAt: t
    };
  }
  async list(e) {
    var t;
    return await this.ensureLoaded(), [...((t = this.cache) == null ? void 0 : t.sessions) ?? []].filter((r) => !(e != null && e.novelId && r.novelId !== e.novelId || e != null && e.draftBatchId && r.draftBatchId !== e.draftBatchId || !(e != null && e.draftBatchId) && !(e != null && e.includeBatchChildren) && r.draftBatchId || e != null && e.workspace && r.workspace !== e.workspace || e != null && e.type && r.type !== e.type || e != null && e.status && r.status !== e.status || !(e != null && e.includeInactive) && r.status !== "draft")).sort((r, a) => a.updatedAt.localeCompare(r.updatedAt));
  }
  async getById(e) {
    var t;
    return await this.ensureLoaded(), ((t = this.cache) == null ? void 0 : t.sessions.find((r) => r.draftSessionId === e)) ?? null;
  }
  async getLatest(e) {
    return (await this.list(e))[0] ?? null;
  }
  async create(e) {
    var s, i;
    await this.ensureLoaded();
    const t = this.createSessionRecord(e), r = ((s = this.cache) == null ? void 0 : s.sessions) ?? [], a = e.draftBatchId ? r : r.map((o) => !o.draftBatchId && o.novelId === t.novelId && o.workspace === t.workspace && o.type === t.type && o.status === "draft" ? {
      ...o,
      status: "stale",
      version: o.version + 1,
      updatedAt: t.createdAt
    } : o);
    return this.cache = {
      sessions: [t, ...a],
      batches: ((i = this.cache) == null ? void 0 : i.batches) ?? []
    }, await this.flush(), t;
  }
  async update(e, t, r) {
    var d;
    await this.ensureLoaded();
    const a = ((d = this.cache) == null ? void 0 : d.sessions) ?? [], s = a.findIndex((l) => l.draftSessionId === e);
    if (s < 0)
      throw U("NOT_FOUND", "Draft session not found");
    const i = a[s];
    if (typeof t == "number" && i.version !== t)
      throw U("VERSION_CONFLICT", "Draft session version conflict");
    const c = {
      ...r(i),
      draftSessionId: i.draftSessionId,
      createdAt: i.createdAt,
      version: i.version + 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return a[s] = c, await this.flush(), c;
  }
  async listBatches(e) {
    var t;
    return await this.ensureLoaded(), [...((t = this.cache) == null ? void 0 : t.batches) ?? []].filter((r) => !(e != null && e.novelId && r.novelId !== e.novelId || e != null && e.volumeId && r.volumeId !== e.volumeId || e != null && e.status && r.status !== e.status || !(e != null && e.includeInactive) && ["committed", "discarded", "failed"].includes(r.status))).sort((r, a) => a.updatedAt.localeCompare(r.updatedAt));
  }
  async getBatchById(e) {
    var t;
    return await this.ensureLoaded(), ((t = this.cache) == null ? void 0 : t.batches.find((r) => r.draftBatchId === e)) ?? null;
  }
  async createBatch(e) {
    var l, m;
    await this.ensureLoaded();
    const t = String((e == null ? void 0 : e.novelId) ?? "").trim(), r = String((e == null ? void 0 : e.volumeId) ?? "").trim(), a = String((e == null ? void 0 : e.anchorChapterId) ?? "").trim();
    if (!t || !r || !a)
      throw U("INVALID_INPUT", "novelId, volumeId and anchorChapterId are required");
    if (e.mode !== "sequence_continuation" && e.mode !== "batch_rewrite")
      throw U("INVALID_INPUT", "Unsupported draft batch mode");
    const s = xn(e.beats), i = Array.isArray(e.targetChapterIds) ? e.targetChapterIds.map((h) => String(h || "").trim()).filter(Boolean) : [];
    if (e.mode === "batch_rewrite" && i.length !== s.length)
      throw U("INVALID_INPUT", "batch_rewrite requires one targetChapterId per beat");
    if (e.mode === "batch_rewrite" && new Set(i).size !== i.length)
      throw U("INVALID_INPUT", "batch_rewrite targetChapterIds must be unique");
    const o = Array.isArray(e.sourceSnapshot) ? e.sourceSnapshot : [];
    if (e.mode === "batch_rewrite") {
      const h = new Map(o.map((f) => [f.chapterId, f])), p = i.filter((f) => {
        const I = h.get(f);
        return !I || !Number.isInteger(I.version) || I.version < 1 || !String(I.contentHash || "").trim();
      });
      if (p.length > 0)
        throw U(
          "INVALID_INPUT",
          `batch_rewrite requires a versioned source snapshot for every target chapter: ${p.join(", ")}`
        );
    }
    const c = (/* @__PURE__ */ new Date()).toISOString(), d = {
      draftBatchId: le(),
      novelId: t,
      volumeId: r,
      anchorChapterId: a,
      mode: e.mode,
      insertionMode: e.insertionMode,
      status: "outline_draft",
      outline: {
        revision: 1,
        status: "draft",
        beats: s
      },
      children: s.map((h, p) => ({
        childIndex: p,
        title: h.title,
        status: "pending",
        generationRevision: 1,
        targetChapterId: i[p] || void 0,
        dependsOnChildIndex: p > 0 ? p - 1 : void 0
      })),
      stateLedger: Bo(),
      sourceSnapshot: o,
      runId: e.runId,
      linkedRunIds: e.runId ? [e.runId] : [],
      version: 1,
      createdAt: c,
      updatedAt: c
    };
    return this.cache = {
      sessions: ((l = this.cache) == null ? void 0 : l.sessions) ?? [],
      batches: [d, ...((m = this.cache) == null ? void 0 : m.batches) ?? []]
    }, await this.flush(), d;
  }
  async updateBatchOutline(e, t, r) {
    var l;
    await this.ensureLoaded();
    const a = ((l = this.cache) == null ? void 0 : l.batches) ?? [], s = a.findIndex((m) => m.draftBatchId === e);
    if (s < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const i = a[s];
    if (i.version !== t)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    if (i.children.some((m) => !!m.draftSessionId))
      throw U("INVALID_STATE", "Cannot change chapter beats after draft generation has started");
    const o = xn(r);
    if (i.mode === "batch_rewrite" && o.length !== i.children.length)
      throw U("INVALID_INPUT", "A rewrite batch cannot change its target chapter count");
    const c = i.children.map((m) => m.targetChapterId), d = {
      ...i,
      status: "outline_draft",
      outline: {
        revision: i.outline.revision + 1,
        status: "draft",
        beats: o
      },
      children: o.map((m, h) => ({
        childIndex: h,
        title: m.title,
        status: "pending",
        generationRevision: 1,
        targetChapterId: c[h],
        dependsOnChildIndex: h > 0 ? h - 1 : void 0
      })),
      version: i.version + 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return a[s] = d, await this.flush(), d;
  }
  async approveBatchOutline(e, t, r, a) {
    var l;
    await this.ensureLoaded();
    const s = ((l = this.cache) == null ? void 0 : l.batches) ?? [], i = s.findIndex((m) => m.draftBatchId === e);
    if (i < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const o = s[i];
    if (o.version !== t)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    if (o.outline.revision !== r)
      throw U("VERSION_CONFLICT", "Draft batch outline revision conflict");
    if (o.status !== "outline_draft")
      throw U("INVALID_STATE", "Draft batch outline is not awaiting approval");
    const c = (/* @__PURE__ */ new Date()).toISOString(), d = {
      ...o,
      status: "ready_to_generate",
      outline: {
        ...o.outline,
        status: "approved",
        approvedAt: c,
        approvedBy: a.trim() || "unknown"
      },
      version: o.version + 1,
      updatedAt: c
    };
    return s[i] = d, await this.flush(), d;
  }
  async createBatchChildSession(e, t, r, a, s) {
    var I, y, g, u;
    await this.ensureLoaded();
    const i = ((I = this.cache) == null ? void 0 : I.batches) ?? [], o = i.findIndex((v) => v.draftBatchId === e);
    if (o < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const c = i[o];
    if (!["ready_to_generate", "generating"].includes(c.status))
      throw U("INVALID_STATE", "Draft batch is not ready to generate");
    const d = c.children[t];
    if (!d || d.childIndex !== t)
      throw U("NOT_FOUND", "Draft batch child not found");
    if (d.draftSessionId)
      throw U("INVALID_STATE", "Draft batch child already has a draft session");
    if (typeof s == "number" && d.generationRevision !== s)
      throw U("VERSION_CONFLICT", "Draft batch child generation revision conflict");
    if (t > 0 && !["draft", "committed"].includes(((y = c.children[t - 1]) == null ? void 0 : y.status) ?? ""))
      throw U("INVALID_STATE", "The previous chapter draft must complete first");
    const l = t > 0 ? (g = c.children[t - 1]) == null ? void 0 : g.draftSessionId : void 0, m = this.createSessionRecord({
      ...r,
      novelId: c.novelId,
      draftBatchId: e,
      childIndex: t,
      generationRevision: d.generationRevision,
      dependsOnDraftSessionId: l,
      status: "draft"
    }), h = c.children.map((v) => v.childIndex === t ? { ...v, status: "draft", draftSessionId: m.draftSessionId } : v), p = h.every((v) => v.status === "draft" || v.status === "committed"), f = {
      ...c,
      status: p ? "ready_for_review" : "generating",
      children: h,
      stateLedger: _n(
        c.stateLedger,
        t,
        m.draftSessionId,
        a,
        d.generationRevision
      ),
      version: c.version + 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return i[o] = f, this.cache = {
      sessions: [m, ...((u = this.cache) == null ? void 0 : u.sessions) ?? []],
      batches: i
    }, await this.flush(), { batch: f, session: m };
  }
  async prepareBatchRegeneration(e, t, r, a) {
    var A, T;
    await this.ensureLoaded();
    const s = ((A = this.cache) == null ? void 0 : A.batches) ?? [], i = s.findIndex((E) => E.draftBatchId === e);
    if (i < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const o = s[i];
    if (o.version !== t)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    if (o.status === "committed" || o.status === "discarded")
      throw U("INVALID_STATE", `Cannot regenerate a ${o.status} draft batch`);
    const c = o.children.findIndex((E) => E.status === "stale" || E.status === "failed" || E.status === "pending" || E.status === "generating"), d = r ?? c;
    if (!Number.isInteger(d) || d < 0 || d >= o.children.length)
      throw U(
        "INVALID_INPUT",
        "fromChildIndex is required when the batch has no failed, stale or pending child"
      );
    if (o.children.slice(d).some((E) => E.status === "committed"))
      throw U("INVALID_STATE", "Committed batch children cannot be regenerated");
    const l = o.children.slice(0, d).find((E) => E.status !== "draft" && E.status !== "committed");
    if (l)
      throw U(
        "INVALID_STATE",
        `Draft batch child ${l.childIndex + 1} must be resolved before regenerating a later child`
      );
    const m = o.children.slice(d).find((E) => {
      var C;
      return (C = E.error) == null ? void 0 : C.sideEffectUnknown;
    });
    if (m)
      throw U(
        "SIDE_EFFECT_UNKNOWN",
        `Draft batch child ${m.childIndex + 1} has an unknown generation result and must be reconciled first`
      );
    const h = new Set(
      o.children.slice(d).flatMap((E) => E.draftSessionId ? [E.draftSessionId] : [])
    ), p = ((T = this.cache) == null ? void 0 : T.sessions) ?? [], f = new Map(p.map((E) => [E.draftSessionId, E])), I = o.children.slice(0, d).flatMap((E) => E.draftSessionId ? [f.get(E.draftSessionId)] : []).filter((E) => !!E);
    if (I.length !== d)
      throw U("INVALID_STATE", "Preserved draft prefix is missing one or more DraftSessions");
    const y = (/* @__PURE__ */ new Date()).toISOString(), g = p.map((E) => !h.has(E.draftSessionId) || E.status === "stale" ? E : {
      ...E,
      status: "stale",
      version: E.version + 1,
      updatedAt: y
    }), u = o.children.map((E) => E.childIndex < d ? E : {
      ...E,
      status: "pending",
      generationRevision: E.generationRevision + 1,
      draftSessionId: void 0,
      error: void 0,
      reconciliation: void 0
    }), v = a && !o.linkedRunIds.includes(a) ? [...o.linkedRunIds, a] : o.linkedRunIds, w = {
      ...o,
      status: "ready_to_generate",
      children: u,
      stateLedger: Rn(o, d),
      linkedRunIds: v,
      version: o.version + 1,
      updatedAt: y
    };
    return s[i] = w, this.cache = { sessions: g, batches: s }, await this.flush(), { batch: w, fromChildIndex: d, preservedDrafts: I };
  }
  async markBatchChildFailed(e) {
    var l, m, h, p, f, I, y;
    await this.ensureLoaded();
    const t = ((l = this.cache) == null ? void 0 : l.batches) ?? [], r = t.findIndex((g) => g.draftBatchId === e.draftBatchId);
    if (r < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const a = t[r];
    if (a.version !== e.version)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    const s = a.children[e.childIndex];
    if (!s || s.childIndex !== e.childIndex)
      throw U("NOT_FOUND", "Draft batch child not found");
    if (s.generationRevision !== e.generationRevision)
      throw U("VERSION_CONFLICT", "Draft batch child generation revision conflict");
    if (s.draftSessionId || s.status === "committed" || s.status === "discarded")
      throw U("INVALID_STATE", "Draft batch child already has a terminal result");
    const i = {
      code: String(((m = e.error) == null ? void 0 : m.code) || "GENERATION_FAILED"),
      message: String(((h = e.error) == null ? void 0 : h.message) || "Draft generation failed"),
      ...(p = e.error) != null && p.sideEffectUnknown ? { sideEffectUnknown: !0 } : {},
      ...(f = e.error) != null && f.invocationKey ? { invocationKey: String(e.error.invocationKey) } : {},
      ...(I = e.error) != null && I.requestId ? { requestId: String(e.error.requestId) } : {},
      ...(y = e.error) != null && y.method ? { method: String(e.error.method) } : {}
    }, o = a.children.map((g) => g.childIndex === e.childIndex ? {
      ...g,
      status: "failed",
      error: i,
      ...i.sideEffectUnknown && i.invocationKey ? {
        reconciliation: {
          resolution: "pending",
          invocationKey: i.invocationKey,
          ...i.requestId ? { requestId: i.requestId } : {},
          method: i.method || "chapter.generate_draft"
        }
      } : {}
    } : g), c = (/* @__PURE__ */ new Date()).toISOString(), d = {
      ...a,
      status: o.slice(0, e.childIndex).some((g) => g.status === "draft" || g.status === "committed") ? "partially_failed" : "failed",
      children: o,
      version: a.version + 1,
      updatedAt: c
    };
    return t[r] = d, await this.flush(), d;
  }
  async inspectBatchReconciliation(e) {
    var s, i;
    await this.ensureLoaded();
    const t = (((s = this.cache) == null ? void 0 : s.batches) ?? []).find((o) => o.draftBatchId === e.draftBatchId);
    if (!t)
      throw U("NOT_FOUND", "Draft batch not found");
    const r = t.children[e.childIndex];
    if (!r || r.childIndex !== e.childIndex)
      throw U("NOT_FOUND", "Draft batch child not found");
    if (r.generationRevision !== e.generationRevision)
      throw U("VERSION_CONFLICT", "Draft batch child generation revision conflict");
    const a = (((i = this.cache) == null ? void 0 : i.sessions) ?? []).filter((o) => o.draftBatchId === t.draftBatchId && o.childIndex === r.childIndex && o.generationRevision === r.generationRevision && o.type === "chapter-draft" && o.status === "draft").map((o) => ({
      draftSessionId: o.draftSessionId,
      draftBatchId: t.draftBatchId,
      childIndex: r.childIndex,
      generationRevision: r.generationRevision,
      status: o.status,
      previewSummary: o.previewSummary,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt
    }));
    return { batch: t, child: r, candidates: a };
  }
  async reconcileBatchUnknown(e) {
    var v, w, A, T, E, C, _, L, V;
    await this.ensureLoaded();
    const t = ((v = this.cache) == null ? void 0 : v.batches) ?? [], r = t.findIndex((B) => B.draftBatchId === e.draftBatchId);
    if (r < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const a = t[r], s = a.children[e.childIndex];
    if (!s || s.childIndex !== e.childIndex)
      throw U("NOT_FOUND", "Draft batch child not found");
    if (((w = s.reconciliation) == null ? void 0 : w.resolution) === e.resolution && s.reconciliation.invocationKey === e.invocationKey)
      return a;
    if (a.version !== e.version)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    if (s.generationRevision !== e.generationRevision)
      throw U("VERSION_CONFLICT", "Draft batch child generation revision conflict");
    if (!e.confirmation)
      throw U("CONFIRMATION_REQUIRED", "Explicit reconciliation confirmation is required");
    if (!((A = s.error) != null && A.sideEffectUnknown) || s.status !== "failed")
      throw U("INVALID_STATE", "Draft batch child is not awaiting side-effect reconciliation");
    const i = ((T = s.reconciliation) == null ? void 0 : T.invocationKey) || s.error.invocationKey;
    if (!i || i !== e.invocationKey)
      throw U("VERSION_CONFLICT", "Invocation key does not match the unknown batch child");
    const o = (/* @__PURE__ */ new Date()).toISOString();
    let c;
    if (e.resolution === "reconciled_succeeded") {
      const B = String(e.candidateDraftSessionId || "").trim();
      if (!B)
        throw U("INVALID_INPUT", "candidateDraftSessionId is required");
      if (c = (((E = this.cache) == null ? void 0 : E.sessions) ?? []).find((W) => W.draftSessionId === B && W.draftBatchId === a.draftBatchId && W.childIndex === s.childIndex && W.generationRevision === s.generationRevision && W.type === "chapter-draft" && W.status === "draft"), !c)
        throw U("CANDIDATE_NOT_FOUND", "No matching draft candidate was found");
      if (a.children.some((W) => W.childIndex !== s.childIndex && W.draftSessionId === (c == null ? void 0 : c.draftSessionId)))
        throw U("INVALID_STATE", "Draft candidate is already attached to another child");
    } else if (e.resolution !== "reconciled_absent")
      throw U("INVALID_INPUT", `Unsupported reconciliation resolution: ${String(e.resolution)}`);
    const d = {
      resolution: e.resolution,
      invocationKey: e.invocationKey,
      ...(C = s.reconciliation) != null && C.requestId || s.error.requestId ? {
        requestId: ((_ = s.reconciliation) == null ? void 0 : _.requestId) || s.error.requestId
      } : {},
      method: ((L = s.reconciliation) == null ? void 0 : L.method) || s.error.method || "chapter.generate_draft",
      ...c ? { candidateDraftSessionId: c.draftSessionId } : {},
      ...(V = e.note) != null && V.trim() ? { note: e.note.trim() } : {},
      reconciledAt: o
    }, l = a.children.map((B) => B.childIndex !== s.childIndex ? B : c ? {
      ...B,
      status: "draft",
      draftSessionId: c.draftSessionId,
      error: void 0,
      reconciliation: d
    } : {
      ...B,
      status: "failed",
      error: {
        code: "RECONCILED_ABSENT",
        message: "用户已确认没有可用草稿，可以重新生成。"
      },
      reconciliation: d
    }), m = l.every((B) => B.status === "draft" || B.status === "committed"), h = l.some((B) => B.status === "failed"), p = l.some((B) => B.status === "draft" || B.status === "committed"), f = m ? "ready_for_review" : h ? p ? "partially_failed" : "failed" : "generating", I = a.outline.beats[s.childIndex], y = c != null && c.payload && typeof c.payload == "object" ? c.payload : {}, g = y.narrativeStateDelta && typeof y.narrativeStateDelta == "object" ? y.narrativeStateDelta : void 0, u = {
      ...a,
      status: f,
      children: l,
      stateLedger: c && I ? _n(a.stateLedger, s.childIndex, c.draftSessionId, {
        title: I.title,
        coreConflict: I.coreConflict,
        keyEvents: I.keyEvents,
        reveals: I.reveals,
        endingHook: I.endingHook,
        summary: c.previewSummary,
        stateDelta: g
      }, c.generationRevision) : a.stateLedger,
      version: a.version + 1,
      updatedAt: o
    };
    return t[r] = u, await this.flush(), u;
  }
  async markBatchChildrenStale(e, t, r) {
    var h, p;
    await this.ensureLoaded();
    const a = ((h = this.cache) == null ? void 0 : h.batches) ?? [], s = a.findIndex((f) => f.draftBatchId === e);
    if (s < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const i = a[s];
    if (i.version !== t)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    if (!Number.isInteger(r) || r < 0 || r >= i.children.length)
      throw U("INVALID_INPUT", "afterChildIndex is outside the draft batch");
    const o = /* @__PURE__ */ new Set(), c = i.children.map((f) => f.childIndex <= r || ["committed", "discarded"].includes(f.status) ? f : (f.draftSessionId && o.add(f.draftSessionId), { ...f, status: "stale" })), d = (/* @__PURE__ */ new Date()).toISOString(), l = (((p = this.cache) == null ? void 0 : p.sessions) ?? []).map((f) => o.has(f.draftSessionId) ? { ...f, status: "stale", version: f.version + 1, updatedAt: d } : f), m = {
      ...i,
      status: "stale",
      children: c,
      stateLedger: Rn(i, r),
      version: i.version + 1,
      updatedAt: d
    };
    return a[s] = m, this.cache = { sessions: l, batches: a }, await this.flush(), m;
  }
  async commitBatchPrefix(e, t, r, a, s, i) {
    var A, T;
    await this.ensureLoaded();
    const o = ((A = this.cache) == null ? void 0 : A.batches) ?? [], c = o.findIndex((E) => E.draftBatchId === e);
    if (c < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const d = o[c];
    if (d.version !== t)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    if (!Number.isInteger(r) || r < 1 || r > d.children.length)
      throw U("INVALID_INPUT", "prefixLength is outside the draft batch");
    const l = d.children.findIndex((E) => E.status !== "committed"), m = l < 0 ? d.children.length : l;
    if (d.children.slice(m).some((E) => E.status === "committed"))
      throw U("INVALID_STATE", "Draft batch contains a non-contiguous committed child");
    if (r <= m)
      throw U("INVALID_STATE", "Requested prefix is already committed");
    const h = Array.from(
      { length: r - m },
      (E, C) => m + C
    );
    if (s.length !== h.length || s.some((E, C) => E.childIndex !== h[C]))
      throw U("INVALID_INPUT", "Committed chapter mapping does not match the requested prefix");
    if (d.mode === "batch_rewrite" && (!i || i.mode !== "batch_rewrite"))
      throw U("INVALID_INPUT", "Rewrite commits require a reversible writeback record");
    const p = ((T = this.cache) == null ? void 0 : T.sessions) ?? [], f = new Map(p.map((E) => [E.draftSessionId, E])), I = new Map(s.map((E) => [E.childIndex, E]));
    for (const E of h) {
      const C = d.children[E], _ = C != null && C.draftSessionId ? f.get(C.draftSessionId) : void 0;
      if (!C || C.status !== "draft" || !_ || _.status !== "draft")
        throw U("INVALID_STATE", `Draft batch child ${E + 1} is not ready to commit`);
      if (_.draftBatchId !== e || _.childIndex !== E)
        throw U("INVALID_STATE", `Draft batch child ${E + 1} session linkage is invalid`);
    }
    const y = (/* @__PURE__ */ new Date()).toISOString(), g = p.map((E) => {
      const C = typeof E.childIndex == "number" ? I.get(E.childIndex) : void 0;
      return E.draftBatchId !== e || !C ? E : {
        ...E,
        chapterId: C.chapterId,
        status: "committed",
        payload: {
          ...E.payload,
          chapterId: C.chapterId,
          content: C.content
        },
        version: E.version + 1,
        updatedAt: y
      };
    }), u = d.children.map((E) => {
      const C = I.get(E.childIndex);
      return C ? { ...E, status: "committed", targetChapterId: C.chapterId } : E;
    }), v = u.every((E) => E.status === "committed"), w = {
      ...d,
      insertionMode: a,
      status: v ? "committed" : u.some((E) => E.status === "failed") ? "partially_failed" : u.some((E) => E.status === "stale") ? "stale" : "ready_for_review",
      children: u,
      writebacks: i ? [...d.writebacks ?? [], i] : d.writebacks,
      version: d.version + 1,
      updatedAt: y
    };
    return o[c] = w, this.cache = { sessions: g, batches: o }, await this.flush(), {
      batch: w,
      sessions: g.filter((E) => E.draftBatchId === e && typeof E.childIndex == "number" && E.childIndex < r).sort((E, C) => (E.childIndex ?? 0) - (C.childIndex ?? 0))
    };
  }
  async undoBatchWriteback(e, t, r, a) {
    var u, v;
    await this.ensureLoaded();
    const s = ((u = this.cache) == null ? void 0 : u.batches) ?? [], i = s.findIndex((w) => w.draftBatchId === e);
    if (i < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const o = s[i];
    if (o.version !== t)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    const c = [...o.writebacks ?? []].reverse().find((w) => w.status === "committed");
    if (!c || c.writebackId !== r)
      throw U("INVALID_STATE", "Only the latest writeback can be undone");
    const d = new Map(a.map((w) => [w.childIndex, w]));
    if (a.length !== c.chapters.length || c.chapters.some((w) => {
      var A;
      return typeof w.childIndex != "number" || ((A = d.get(w.childIndex)) == null ? void 0 : A.chapterId) !== w.chapterId;
    }))
      throw U("INVALID_INPUT", "Restored chapter mapping does not match the writeback");
    const l = (/* @__PURE__ */ new Date()).toISOString(), m = new Set(a.map((w) => w.childIndex)), h = o.children.map((w) => m.has(w.childIndex) ? { ...w, status: "draft" } : w), p = (((v = this.cache) == null ? void 0 : v.sessions) ?? []).map((w) => w.draftBatchId === e && typeof w.childIndex == "number" && m.has(w.childIndex) ? {
      ...w,
      status: "draft",
      version: w.version + 1,
      updatedAt: l
    } : w), f = new Map(a.map((w) => [w.chapterId, w])), I = o.sourceSnapshot.map((w) => {
      const A = f.get(w.chapterId);
      return A ? {
        chapterId: A.chapterId,
        version: A.version,
        contentHash: be("sha256").update(A.content || "", "utf8").digest("hex")
      } : w;
    }), y = {
      ...c,
      status: "undone",
      undoneAt: l
    }, g = {
      ...o,
      status: h.every((w) => w.status === "committed") ? "committed" : "ready_for_review",
      children: h,
      sourceSnapshot: I,
      writebacks: (o.writebacks ?? []).map((w) => w.writebackId === r ? y : w),
      version: o.version + 1,
      updatedAt: l
    };
    return s[i] = g, this.cache = { sessions: p, batches: s }, await this.flush(), {
      batch: g,
      sessions: p.filter((w) => w.draftBatchId === e),
      writeback: y
    };
  }
  async discardBatch(e, t) {
    var l, m;
    await this.ensureLoaded();
    const r = ((l = this.cache) == null ? void 0 : l.batches) ?? [], a = r.findIndex((h) => h.draftBatchId === e);
    if (a < 0)
      throw U("NOT_FOUND", "Draft batch not found");
    const s = r[a];
    if (s.version !== t)
      throw U("VERSION_CONFLICT", "Draft batch version conflict");
    if (s.status === "committed")
      throw U("INVALID_STATE", "A committed draft batch cannot be discarded");
    const i = new Set(s.children.flatMap((h) => h.draftSessionId ? [h.draftSessionId] : [])), o = (/* @__PURE__ */ new Date()).toISOString(), c = (((m = this.cache) == null ? void 0 : m.sessions) ?? []).map((h) => i.has(h.draftSessionId) ? { ...h, status: "discarded", version: h.version + 1, updatedAt: o } : h), d = {
      ...s,
      status: "discarded",
      children: s.children.map((h) => ({ ...h, status: "discarded" })),
      version: s.version + 1,
      updatedAt: o
    };
    return r[a] = d, this.cache = { sessions: c, batches: r }, await this.flush(), d;
  }
}
const qo = { comments: [] };
function Ge(n, e) {
  return Object.assign(new Error(e), { code: n });
}
function dt(n, e) {
  const t = String(n ?? "").trim();
  if (!t)
    throw Ge("INVALID_INPUT", `${e} is required`);
  return t;
}
class jo {
  constructor(e) {
    H(this, "getUserDataPath");
    H(this, "cache", null);
    H(this, "mutationTail", Promise.resolve());
    this.getUserDataPath = e;
  }
  getStoreDir() {
    return D.join(this.getUserDataPath(), "automation");
  }
  getStorePath() {
    return D.join(this.getStoreDir(), "review-comments.json");
  }
  async ensureLoaded() {
    if (!this.cache)
      try {
        const e = JSON.parse(await Te.readFile(this.getStorePath(), "utf8"));
        this.cache = { comments: Array.isArray(e.comments) ? e.comments : [] };
      } catch (e) {
        if ((e == null ? void 0 : e.code) !== "ENOENT")
          throw e;
        this.cache = { comments: [] };
      }
  }
  async flush() {
    await Te.mkdir(this.getStoreDir(), { recursive: !0 });
    const e = this.getStorePath(), t = `${e}.${process.pid}.tmp`;
    await Te.writeFile(t, JSON.stringify(this.cache ?? qo, null, 2), "utf8"), await Te.rename(t, e);
  }
  async mutate(e) {
    const t = this.mutationTail;
    let r;
    this.mutationTail = new Promise((a) => {
      r = a;
    }), await t;
    try {
      return await this.ensureLoaded(), await e();
    } finally {
      r();
    }
  }
  async list(e) {
    var r;
    await this.ensureLoaded();
    const t = new Set(
      ((e == null ? void 0 : e.reviewVersionIds) ?? []).map((a) => String(a || "").trim()).filter(Boolean)
    );
    return [...((r = this.cache) == null ? void 0 : r.comments) ?? []].filter((a) => !(e != null && e.novelId && a.novelId !== e.novelId || e != null && e.sourceConversationId && a.sourceConversationId !== e.sourceConversationId || e != null && e.reviewVersionId && a.reviewVersionId !== e.reviewVersionId || t.size && !t.has(a.reviewVersionId) || e != null && e.status && a.status !== e.status)).sort((a, s) => a.createdAt.localeCompare(s.createdAt));
  }
  async save(e) {
    return this.mutate(async () => {
      var f, I;
      const t = dt(e == null ? void 0 : e.novelId, "novelId"), r = dt(e == null ? void 0 : e.sourceConversationId, "sourceConversationId"), a = dt(e == null ? void 0 : e.sourceRunId, "sourceRunId"), s = dt(e == null ? void 0 : e.reviewVersionId, "reviewVersionId"), i = dt(e == null ? void 0 : e.body, "body"), o = dt((f = e == null ? void 0 : e.anchor) == null ? void 0 : f.targetId, "anchor.targetId");
      if (i.length > 4e3)
        throw Ge("INVALID_INPUT", "Review comment must not exceed 4000 characters");
      const c = (/* @__PURE__ */ new Date()).toISOString(), d = ((I = this.cache) == null ? void 0 : I.comments) ?? [], l = String((e == null ? void 0 : e.commentId) || "").trim(), m = l ? d.findIndex((y) => y.commentId === l) : -1;
      if (l && m < 0)
        throw Ge("NOT_FOUND", "Review comment not found");
      const h = m >= 0 ? d[m] : null;
      if (h && h.status === "superseded")
        throw Ge("INVALID_STATE", "Superseded review comments cannot be edited");
      if (h && h.reviewVersionId !== s)
        throw Ge("VERSION_CONFLICT", "Review comment belongs to another review version");
      const p = {
        commentId: (h == null ? void 0 : h.commentId) ?? le(),
        novelId: t,
        sourceConversationId: r,
        sourceRunId: a,
        ...e.sourceArtifactId ? { sourceArtifactId: String(e.sourceArtifactId) } : {},
        reviewVersionId: s,
        ...e.draftSessionId ? { draftSessionId: String(e.draftSessionId) } : {},
        ...e.draftBatchId ? { draftBatchId: String(e.draftBatchId) } : {},
        ...Number.isInteger(e.childIndex) ? { childIndex: e.childIndex } : {},
        anchor: { ...e.anchor, targetId: o },
        body: i,
        status: "local_draft",
        createdAt: (h == null ? void 0 : h.createdAt) ?? c,
        updatedAt: c
      };
      return m >= 0 ? d[m] = p : d.push(p), this.cache = { comments: d }, await this.flush(), p;
    });
  }
  async delete(e) {
    return this.mutate(async () => {
      var s;
      const t = dt(e, "commentId"), r = ((s = this.cache) == null ? void 0 : s.comments) ?? [], a = r.filter((i) => i.commentId !== t);
      if (a.length === r.length)
        throw Ge("NOT_FOUND", "Review comment not found");
      return this.cache = { comments: a }, await this.flush(), { commentId: t };
    });
  }
  async markSent(e) {
    return this.mutate(async () => {
      var c;
      if (!["discuss", "regenerate"].includes(e == null ? void 0 : e.mode))
        throw Ge("INVALID_INPUT", "mode must be discuss or regenerate");
      const t = new Set(((e == null ? void 0 : e.commentIds) ?? []).map((d) => String(d || "").trim()).filter(Boolean));
      if (!t.size)
        throw Ge("INVALID_INPUT", "commentIds is required");
      const r = ((c = this.cache) == null ? void 0 : c.comments) ?? [], a = r.filter((d) => t.has(d.commentId));
      if (a.length !== t.size)
        throw Ge("NOT_FOUND", "One or more review comments were not found");
      if (new Set(a.map((d) => `${d.novelId}:${d.sourceConversationId}`)).size !== 1)
        throw Ge("INVALID_INPUT", "Review comments must belong to one source conversation");
      const i = (/* @__PURE__ */ new Date()).toISOString(), o = r.map((d) => t.has(d.commentId) ? {
        ...d,
        status: "sent",
        sentMode: e.mode,
        sentAt: i,
        updatedAt: i
      } : d);
      return this.cache = { comments: o }, await this.flush(), o.filter((d) => t.has(d.commentId));
    });
  }
}
function Vo(n) {
  if (!n.startsWith("{"))
    return -1;
  let e = 0, t = !1, r = !1;
  for (let a = 0; a < n.length; a += 1) {
    const s = n[a];
    if (t) {
      r ? r = !1 : s === "\\" ? r = !0 : s === '"' && (t = !1);
      continue;
    }
    if (s === '"')
      t = !0;
    else if (s === "{")
      e += 1;
    else if (s === "}" && (e -= 1, e === 0))
      return a + 1;
  }
  return -1;
}
function Xr(n) {
  const e = n.trim(), t = Vo(e);
  if (t < 0)
    return { document: null, trailingText: e };
  try {
    const r = JSON.parse(e.slice(0, t));
    return !r.root || typeof r.root != "object" ? { document: null, trailingText: e } : {
      document: r,
      trailingText: e.slice(t).trim()
    };
  } catch {
    return { document: null, trailingText: e };
  }
}
function Ca(n) {
  if (n.type === "linebreak")
    return `
`;
  if (typeof n.text == "string")
    return n.text;
  if (!Array.isArray(n.children))
    return "";
  const e = n.children.map(Ca).join("");
  return ["paragraph", "heading", "quote", "listitem"].includes(n.type ?? "") ? `${e}
` : e;
}
function wt(n) {
  return n.replace(/[ \t]+\n/g, `
`).replace(/\n[ \t]+/g, `
`).replace(/\n{3,}/g, `

`).trim();
}
function Cr(n) {
  if (!(n != null && n.trim()))
    return "";
  const { document: e, trailingText: t } = Xr(n);
  return e ? [wt(Ca(e.root)), wt(t)].filter(Boolean).join(`

`) : wt(t);
}
function Jo(n) {
  return {
    detail: 0,
    format: 0,
    mode: "normal",
    style: "",
    text: n,
    type: "text",
    version: 1
  };
}
function Ho(n) {
  const e = n.split(`
`), t = [];
  return e.forEach((r, a) => {
    r && t.push(Jo(r)), a < e.length - 1 && t.push({ type: "linebreak", version: 1 });
  }), {
    children: t,
    direction: null,
    format: "",
    indent: 0,
    type: "paragraph",
    version: 1,
    textFormat: 0,
    textStyle: ""
  };
}
function Pr(n) {
  return wt(n).split(/\n{2,}/).filter(Boolean).map(Ho);
}
function Zt(n, e) {
  const t = wt(e), { document: r, trailingText: a } = Xr(n);
  if (!r)
    return [wt(n), t].filter(Boolean).join(`

`);
  const s = JSON.parse(JSON.stringify(r));
  return Array.isArray(s.root.children) || (s.root.children = []), s.root.children.push(...Pr(a), ...Pr(t)), JSON.stringify(s);
}
function Na(n) {
  const e = {
    root: {
      children: Pr(n),
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1
    }
  };
  return JSON.stringify(e);
}
function zo(n) {
  const { document: e, trailingText: t } = Xr(n);
  return e ? t ? Zt(JSON.stringify(e), t) : JSON.stringify(e) : Na(t);
}
function ke(n, e, t) {
  return Object.assign(new Error(e), { code: n, details: t });
}
function Ur(n) {
  return be("sha256").update(n || "", "utf8").digest("hex");
}
function Wo(n) {
  const e = Array.from(
    { length: n.prefixLength - n.committedPrefixLength },
    (t, r) => n.committedPrefixLength + r
  );
  if (e.length < 1 || n.drafts.length !== e.length || n.drafts.some((t, r) => t.childIndex !== e[r]))
    throw ke("INVALID_INPUT", "Draft chapter writes do not match the requested prefix");
}
async function Xo(n, e) {
  Wo(e);
  const { batch: t } = e;
  return n.$transaction(async (r) => {
    const a = await r.volume.findUnique({
      where: { id: t.volumeId },
      select: { id: !0, novelId: !0 }
    });
    if (!a || a.novelId !== t.novelId)
      throw ke("NOT_FOUND", "Draft batch volume does not belong to the expected novel");
    const s = await r.chapter.findUnique({
      where: { id: t.anchorChapterId },
      select: { id: !0, volumeId: !0, order: !0, deleted: !0 }
    });
    if (!s || s.deleted || s.volumeId !== t.volumeId)
      throw ke("VERSION_CONFLICT", "Draft batch anchor chapter changed or was removed");
    const i = new Set(
      t.children.slice(0, e.committedPrefixLength).map((I) => I.targetChapterId).filter((I) => !!I)
    ), o = t.sourceSnapshot.filter(
      (I) => !i.has(I.chapterId)
    );
    if (o.length > 0) {
      const I = await r.chapter.findMany({
        where: { id: { in: o.map((u) => u.chapterId) } },
        select: { id: !0, version: !0, content: !0, deleted: !0 }
      }), y = new Map(I.map((u) => [u.id, u])), g = o.flatMap((u) => {
        const v = y.get(u.chapterId);
        return !v || v.deleted || v.version !== u.version || Ur(v.content) !== u.contentHash ? [{
          chapterId: u.chapterId,
          expectedVersion: u.version,
          actualVersion: v == null ? void 0 : v.version
        }] : [];
      });
      if (g.length > 0)
        throw ke(
          "VERSION_CONFLICT",
          "One or more source chapters changed after draft generation",
          { conflicts: g }
        );
    }
    if (t.mode === "batch_rewrite") {
      const I = e.drafts.map((T) => T.targetChapterId).filter((T) => !!T).filter((T) => !t.sourceSnapshot.some((E) => E.chapterId === T));
      if (I.length > 0 || e.drafts.some((T) => !T.targetChapterId))
        throw ke(
          "INVALID_STATE",
          "Rewrite targets require versioned source snapshots",
          { chapterIds: I }
        );
      const y = e.drafts.map((T) => T.targetChapterId), g = await r.chapter.findMany({
        where: { id: { in: y } },
        select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0, wordCount: !0, version: !0, deleted: !0 }
      }), u = new Map(g.map((T) => [T.id, T]));
      if (g.length !== y.length || g.some((T) => T.deleted || T.volumeId !== t.volumeId))
        throw ke("VERSION_CONFLICT", "One or more rewrite targets changed or were removed");
      let v = 0;
      const w = [], A = [];
      for (const T of e.drafts) {
        const E = T.targetChapterId, C = u.get(E);
        if (!C)
          throw ke("VERSION_CONFLICT", `Rewrite target ${E} is unavailable`);
        const _ = await r.chapter.update({
          where: { id: E },
          data: {
            content: T.content,
            wordCount: T.wordCount,
            version: { increment: 1 },
            updatedAt: /* @__PURE__ */ new Date()
          }
        });
        v += T.wordCount - C.wordCount, A.push({
          childIndex: T.childIndex,
          chapterId: _.id,
          volumeId: _.volumeId,
          title: _.title,
          order: _.order,
          beforeContent: C.content,
          beforeWordCount: C.wordCount,
          beforeVersion: C.version,
          afterContentHash: Ur(_.content),
          afterVersion: _.version
        }), w.push({
          childIndex: T.childIndex,
          chapterId: _.id,
          volumeId: _.volumeId,
          title: _.title,
          order: _.order,
          version: _.version,
          content: _.content
        });
      }
      return v !== 0 && await r.novel.update({
        where: { id: t.novelId },
        data: { wordCount: { increment: v }, updatedAt: /* @__PURE__ */ new Date() }
      }), {
        chapters: w,
        insertionMode: t.insertionMode ?? e.insertionMode ?? "after_anchor",
        reorderedChapterIds: [],
        writeback: {
          writebackId: le(),
          mode: "batch_rewrite",
          status: "committed",
          chapters: A,
          committedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      };
    }
    const c = await r.chapter.findMany({
      where: { volumeId: t.volumeId, deleted: !1 },
      select: { id: !0, order: !0 },
      orderBy: { order: "asc" }
    }), d = c.reduce((I, y) => Math.max(I, y.order), 0);
    if (e.committedPrefixLength === 0 && s.order < d && !e.insertionMode)
      throw ke(
        "INSERTION_MODE_REQUIRED",
        "The anchor is not the final chapter; choose after_anchor or volume_end before committing",
        { anchorChapterId: s.id, anchorOrder: s.order, finalOrder: d }
      );
    let l, m;
    if (e.committedPrefixLength > 0) {
      if (!t.insertionMode)
        throw ke("INVALID_STATE", "Partially committed batch has no fixed insertion mode");
      if (e.insertionMode && e.insertionMode !== t.insertionMode)
        throw ke("VERSION_CONFLICT", "Insertion mode cannot change after the first prefix commit");
      const I = t.children[e.committedPrefixLength - 1], y = I != null && I.targetChapterId ? await r.chapter.findUnique({
        where: { id: I.targetChapterId },
        select: { id: !0, volumeId: !0, order: !0, deleted: !0 }
      }) : null;
      if (!y || y.deleted || y.volumeId !== t.volumeId)
        throw ke("VERSION_CONFLICT", "The previously committed prefix chapter changed or was removed");
      l = t.insertionMode, m = y.order;
    } else
      l = e.insertionMode ?? t.insertionMode ?? "volume_end", m = l === "after_anchor" ? s.order : d;
    await r.chapter.updateMany({
      where: { volumeId: t.volumeId, deleted: !1, order: { gt: m } },
      data: { order: { increment: e.drafts.length }, version: { increment: 1 }, updatedAt: /* @__PURE__ */ new Date() }
    });
    const h = c.filter((I) => I.order > m).map((I) => I.id), p = [];
    let f = 0;
    for (const [I, y] of e.drafts.entries()) {
      const g = await r.chapter.create({
        data: {
          volumeId: t.volumeId,
          title: y.title,
          order: m + I + 1,
          content: y.content,
          wordCount: y.wordCount
        }
      });
      f += y.wordCount, p.push({
        childIndex: y.childIndex,
        chapterId: g.id,
        volumeId: g.volumeId,
        title: g.title,
        order: g.order,
        version: g.version,
        content: g.content
      });
    }
    return await r.novel.update({
      where: { id: t.novelId },
      data: { wordCount: { increment: f }, updatedAt: /* @__PURE__ */ new Date() }
    }), await r.volume.update({
      where: { id: t.volumeId },
      data: { version: { increment: 1 }, updatedAt: /* @__PURE__ */ new Date() }
    }), { chapters: p, insertionMode: l, reorderedChapterIds: h };
  });
}
async function Go(n, e, t) {
  if (e.mode !== "batch_rewrite" || t.mode !== "batch_rewrite" || t.status !== "committed")
    throw ke("INVALID_STATE", "Only an active batch rewrite can be undone");
  if (t.chapters.length < 1 || t.chapters.some((r) => !Number.isInteger(r.childIndex)))
    throw ke("INVALID_STATE", "The writeback record has no restorable chapters");
  return n.$transaction(async (r) => {
    const a = await r.chapter.findMany({
      where: { id: { in: t.chapters.map((d) => d.chapterId) } },
      select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0, wordCount: !0, version: !0, deleted: !0 }
    }), s = new Map(a.map((d) => [d.id, d])), i = t.chapters.flatMap((d) => {
      const l = s.get(d.chapterId);
      return !l || l.deleted || l.volumeId !== d.volumeId || l.version !== d.afterVersion || Ur(l.content) !== d.afterContentHash ? [{
        chapterId: d.chapterId,
        expectedVersion: d.afterVersion,
        actualVersion: l == null ? void 0 : l.version
      }] : [];
    });
    if (i.length > 0)
      throw ke(
        "VERSION_CONFLICT",
        "正文已在写回后再次修改，无法安全撤销",
        { conflicts: i }
      );
    let o = 0;
    const c = [];
    for (const d of t.chapters) {
      const l = s.get(d.chapterId), m = await r.chapter.update({
        where: { id: d.chapterId },
        data: {
          content: d.beforeContent,
          wordCount: d.beforeWordCount,
          version: { increment: 1 },
          updatedAt: /* @__PURE__ */ new Date()
        }
      });
      o += d.beforeWordCount - l.wordCount, c.push({
        childIndex: d.childIndex,
        chapterId: m.id,
        volumeId: m.volumeId,
        title: m.title,
        order: m.order,
        version: m.version,
        content: m.content
      });
    }
    return o !== 0 && await r.novel.update({
      where: { id: e.novelId },
      data: { wordCount: { increment: o }, updatedAt: /* @__PURE__ */ new Date() }
    }), c;
  });
}
function ie(n, e, t) {
  return Object.assign(new Error(e), { code: n, ...t === void 0 ? {} : { details: t } });
}
function St(n, e) {
  if (!n)
    return e;
  try {
    return JSON.parse(n);
  } catch {
    return e;
  }
}
function Ko(n) {
  return be("sha256").update(n || "", "utf8").digest("hex");
}
function Dn(n) {
  if (n instanceof Date)
    return n.toISOString();
  const e = new Date(n);
  return Number.isNaN(e.getTime()) ? n : e.toISOString();
}
function _t(n) {
  return {
    revisionTaskId: n.revisionTaskId,
    novelId: n.novelId,
    sourceArtifactId: n.sourceArtifactId,
    sourceFindingId: n.sourceFindingId,
    title: n.title,
    description: n.description,
    targetChapterIds: St(n.targetChapterIdsJson, []),
    sourceExpert: n.sourceExpert,
    severity: n.severity,
    recommendedRole: n.recommendedRole,
    status: n.status,
    sourceSnapshot: St(n.sourceSnapshotJson, []),
    ...n.note ? { note: n.note } : {},
    ...n.planId ? { planId: n.planId } : {},
    ...n.planJson ? { plan: St(n.planJson, {}) } : {},
    ...n.sourceConversationId ? { sourceConversationId: n.sourceConversationId } : {},
    ...n.sourceRunId ? { sourceRunId: n.sourceRunId } : {},
    entryReason: n.entryReason || "legacy",
    createdAt: Dn(n.createdAt),
    updatedAt: Dn(n.updatedAt)
  };
}
function On(n) {
  const e = St(n.metadataJson, {}), t = St(n.referenceJson, {}), r = e.expertReport ?? t.expertReport ?? e.report ?? t.report ?? e;
  if (!r || typeof r != "object")
    throw ie("INVALID_REPORT", "Artifact does not contain an expert report payload");
  const a = r;
  if (!Array.isArray(a.findings) || !Array.isArray(a.sourceSnapshot))
    throw ie("INVALID_REPORT", "Expert report findings and sourceSnapshot are required");
  const s = /* @__PURE__ */ new Set();
  for (const i of a.findings) {
    const o = typeof (i == null ? void 0 : i.findingId) == "string" ? i.findingId.trim() : "";
    if (!o || s.has(o))
      throw ie("INVALID_REPORT", "Expert report findingId values must be non-empty and unique");
    s.add(o);
  }
  return {
    ...a,
    artifactId: a.artifactId || n.artifactId,
    novelId: a.novelId || n.novelId
  };
}
class Zo {
  constructor(e = S) {
    H(this, "schemaReady", null);
    this.client = e;
  }
  async ensureSchema() {
    return this.schemaReady || (this.schemaReady = this.initializeSchema().catch((e) => {
      throw this.schemaReady = null, e;
    })), this.schemaReady;
  }
  async initializeSchema() {
    const e = await this.client.$queryRawUnsafe("PRAGMA table_info(AgentArtifact)");
    if (!e.length)
      throw ie("ARTIFACT_STORE_UNAVAILABLE", "AgentArtifact store has not been initialized");
    const t = new Set(e.map((s) => s.name));
    t.has("reviewStatus") || await this.client.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewStatus TEXT NOT NULL DEFAULT 'unreviewed'"), t.has("reviewRevision") || await this.client.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewRevision INTEGER NOT NULL DEFAULT 0"), t.has("reviewDecisionsJson") || await this.client.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewDecisionsJson TEXT"), t.has("reviewStaleChapterIdsJson") || await this.client.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewStaleChapterIdsJson TEXT"), t.has("reviewedAt") || await this.client.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewedAt DATETIME"), await this.client.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentRevisionTask (
                revisionTaskId TEXT PRIMARY KEY,
                novelId TEXT NOT NULL,
                sourceArtifactId TEXT NOT NULL,
                sourceFindingId TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                targetChapterIdsJson TEXT NOT NULL,
                sourceExpert TEXT NOT NULL,
                severity TEXT NOT NULL,
                recommendedRole TEXT NOT NULL,
                status TEXT NOT NULL,
                sourceSnapshotJson TEXT NOT NULL,
                note TEXT,
                planId TEXT,
                planJson TEXT,
                sourceConversationId TEXT,
                sourceRunId TEXT,
                entryReason TEXT NOT NULL DEFAULT 'legacy',
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(sourceArtifactId, sourceFindingId),
                FOREIGN KEY (sourceArtifactId) REFERENCES AgentArtifact(artifactId) ON DELETE CASCADE,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
    const r = await this.client.$queryRawUnsafe("PRAGMA table_info(AgentRevisionTask)"), a = new Set(r.map((s) => s.name));
    a.has("sourceConversationId") || await this.client.$executeRawUnsafe("ALTER TABLE AgentRevisionTask ADD COLUMN sourceConversationId TEXT"), a.has("sourceRunId") || await this.client.$executeRawUnsafe("ALTER TABLE AgentRevisionTask ADD COLUMN sourceRunId TEXT"), a.has("entryReason") || await this.client.$executeRawUnsafe("ALTER TABLE AgentRevisionTask ADD COLUMN entryReason TEXT NOT NULL DEFAULT 'legacy'"), await this.client.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_revision_task_novel_status ON AgentRevisionTask(novelId, status, updatedAt)"), await this.client.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_revision_task_artifact ON AgentRevisionTask(sourceArtifactId, sourceFindingId)");
  }
  async findStaleChapterIds(e, t, r) {
    if (!r.length)
      return [];
    const a = [...new Set(r.map((c) => c.chapterId).filter(Boolean))], s = a.map(() => "?").join(", "), i = await e.$queryRawUnsafe(`
            SELECT c.id AS chapterId, c.version AS version, c.content AS content
            FROM Chapter c
            INNER JOIN Volume v ON v.id = c.volumeId
            WHERE v.novelId = ? AND c.deleted = 0 AND c.id IN (${s})
        `, t, ...a), o = new Map(i.map((c) => [c.chapterId, c]));
    return r.flatMap((c) => {
      const d = o.get(c.chapterId);
      return !d || Number(d.version) !== Number(c.version) || Ko(d.content) !== c.contentHash ? [c.chapterId] : [];
    });
  }
  async submitArtifactReview(e) {
    var t;
    if (await this.ensureSchema(), !((t = e == null ? void 0 : e.artifactId) != null && t.trim()))
      throw ie("INVALID_INPUT", "artifactId is required");
    if (!Number.isInteger(e.expectedReviewRevision) || e.expectedReviewRevision < 0)
      throw ie("INVALID_INPUT", "expectedReviewRevision must be a non-negative integer");
    if (!Array.isArray(e.decisions) || e.decisions.length === 0)
      throw ie("INVALID_INPUT", "decisions is required");
    return this.client.$transaction(async (r) => {
      const s = (await r.$queryRawUnsafe(`
                SELECT artifactId, novelId, conversationId, runId, metadataJson, referenceJson, reviewStatus, reviewRevision,
                       reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt
                FROM AgentArtifact WHERE artifactId = ?
            `, e.artifactId))[0];
      if (!s)
        throw ie("NOT_FOUND", `Artifact not found: ${e.artifactId}`);
      if (Number(s.reviewRevision) !== e.expectedReviewRevision)
        throw ie("VERSION_CONFLICT", "Artifact review was changed by another operation", {
          expectedReviewRevision: e.expectedReviewRevision,
          actualReviewRevision: Number(s.reviewRevision)
        });
      const i = On(s), o = new Map(i.findings.map((u) => [u.findingId, u])), c = /* @__PURE__ */ new Map();
      for (const u of e.decisions) {
        if (!o.has(u.findingId))
          throw ie("INVALID_INPUT", `Unknown findingId: ${u.findingId}`);
        if (!["accepted", "rejected", "deferred"].includes(u.status))
          throw ie("INVALID_INPUT", `Unsupported finding decision: ${String(u.status)}`);
        if (c.has(u.findingId))
          throw ie("INVALID_INPUT", `Duplicate finding decision: ${u.findingId}`);
        c.set(u.findingId, u);
      }
      const d = St(s.reviewDecisionsJson, []), l = new Map(d.map((u) => [u.findingId, u]));
      for (const u of c.values())
        l.set(u.findingId, u);
      const m = i.findings.flatMap((u) => {
        const v = l.get(u.findingId);
        return v ? [v] : [];
      }), h = await this.findStaleChapterIds(r, s.novelId, i.sourceSnapshot), p = h.length ? "stale" : m.length === i.findings.length ? "reviewed" : "in_review", f = Number(s.reviewRevision) + 1, I = (/* @__PURE__ */ new Date()).toISOString();
      await r.$executeRawUnsafe(
        `
                UPDATE AgentArtifact
                SET reviewStatus = ?, reviewRevision = ?, reviewDecisionsJson = ?,
                    reviewStaleChapterIdsJson = ?, reviewedAt = ?, updatedAt = ?
                WHERE artifactId = ?
            `,
        p,
        f,
        JSON.stringify(m),
        JSON.stringify(h),
        I,
        I,
        s.artifactId
      );
      const y = async (u, v, w) => {
        await r.$executeRawUnsafe(
          `
                        INSERT INTO AgentRevisionTask (
                            revisionTaskId, novelId, sourceArtifactId, sourceFindingId, title, description,
                            targetChapterIdsJson, sourceExpert, severity, recommendedRole, status,
                            sourceSnapshotJson, note, sourceConversationId, sourceRunId, entryReason, createdAt, updatedAt
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(sourceArtifactId, sourceFindingId) DO UPDATE SET
                            title = excluded.title, description = excluded.description,
                            targetChapterIdsJson = excluded.targetChapterIdsJson,
                            sourceExpert = excluded.sourceExpert, severity = excluded.severity,
                            recommendedRole = excluded.recommendedRole,
                            status = CASE
                                WHEN AgentRevisionTask.status IN ('planned', 'resolved') THEN AgentRevisionTask.status
                                ELSE excluded.status
                            END,
                            sourceSnapshotJson = excluded.sourceSnapshotJson,
                            note = excluded.note,
                            sourceConversationId = excluded.sourceConversationId,
                            sourceRunId = excluded.sourceRunId,
                            entryReason = excluded.entryReason,
                            updatedAt = excluded.updatedAt
                `,
          `revision_${le().replace(/-/g, "")}`,
          s.novelId,
          s.artifactId,
          u.findingId,
          u.title,
          u.recommendation || u.summary,
          JSON.stringify(u.chapterIds || []),
          u.expert || i.expert,
          u.severity,
          u.recommendedRole || "editor",
          w,
          JSON.stringify(i.sourceSnapshot),
          v.note || null,
          s.conversationId,
          s.runId,
          v.status === "deferred" ? "deferred" : "accepted",
          I,
          I
        );
      };
      for (const u of c.values()) {
        const v = o.get(u.findingId);
        if (u.status === "accepted" && e.createRevisionTasks !== !1) {
          const w = h.length ? "stale" : "open";
          await y(v, u, w);
        } else if (u.status === "deferred") {
          const w = h.length ? "stale" : "deferred";
          await y(v, u, w);
        } else
          await r.$executeRawUnsafe(`
                        UPDATE AgentRevisionTask SET status = ?, note = ?, updatedAt = ?
                        WHERE sourceArtifactId = ? AND sourceFindingId = ? AND status != 'resolved'
                    `, "closed", u.note || null, I, s.artifactId, v.findingId);
      }
      const g = await r.$queryRawUnsafe(`
                SELECT * FROM AgentRevisionTask WHERE sourceArtifactId = ? ORDER BY datetime(createdAt) ASC
            `, s.artifactId);
      return {
        review: {
          artifactId: s.artifactId,
          reviewStatus: p,
          reviewRevision: f,
          decisions: m,
          staleChapterIds: h,
          reviewedAt: I
        },
        revisionTasks: g.map(_t)
      };
    });
  }
  async listRevisionTasks(e) {
    var s;
    if (await this.ensureSchema(), !((s = e == null ? void 0 : e.novelId) != null && s.trim()))
      throw ie("INVALID_INPUT", "novelId is required");
    const t = ["task.novelId = ?"], r = [e.novelId];
    return e.expert && (t.push("task.sourceExpert = ?"), r.push(e.expert)), e.severity && (t.push("task.severity = ?"), r.push(e.severity)), e.status && (t.push("task.status = ?"), r.push(e.status)), e.chapterId && (t.push("EXISTS (SELECT 1 FROM json_each(task.targetChapterIdsJson) WHERE json_each.value = ?)"), r.push(e.chapterId)), (await this.client.$queryRawUnsafe(`
            SELECT task.*,
                   COALESCE(task.sourceConversationId, artifact.conversationId) AS sourceConversationId,
                   COALESCE(task.sourceRunId, artifact.runId) AS sourceRunId
            FROM AgentRevisionTask task
            LEFT JOIN AgentArtifact artifact ON artifact.artifactId = task.sourceArtifactId
            WHERE ${t.join(" AND ")}
            ORDER BY CASE task.severity
                WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                WHEN 'low' THEN 3 ELSE 4 END, datetime(task.updatedAt) DESC
        `, ...r)).map(_t);
  }
  async getRevisionTask(e) {
    await this.ensureSchema();
    const t = await this.client.$queryRawUnsafe(
      `SELECT task.*,
                    COALESCE(task.sourceConversationId, artifact.conversationId) AS sourceConversationId,
                    COALESCE(task.sourceRunId, artifact.runId) AS sourceRunId
             FROM AgentRevisionTask task
             LEFT JOIN AgentArtifact artifact ON artifact.artifactId = task.sourceArtifactId
             WHERE task.revisionTaskId = ?`,
      e
    );
    if (!t[0])
      throw ie("NOT_FOUND", `Revision task not found: ${e}`);
    return _t(t[0]);
  }
  async updateRevisionTaskStatus(e) {
    await this.ensureSchema();
    const t = String((e == null ? void 0 : e.revisionTaskId) || "").trim(), r = String((e == null ? void 0 : e.expectedUpdatedAt) || "").trim();
    if (!t)
      throw ie("INVALID_INPUT", "revisionTaskId is required");
    if (!r)
      throw ie("INVALID_INPUT", "expectedUpdatedAt is required");
    const s = (await this.client.$queryRawUnsafe(
      "SELECT * FROM AgentRevisionTask WHERE revisionTaskId = ?",
      t
    ))[0];
    if (!s)
      throw ie("NOT_FOUND", `Revision task not found: ${t}`);
    const i = _t(s);
    if (i.updatedAt !== r)
      throw ie("VERSION_CONFLICT", "Revision task changed since it was loaded");
    if (i.status === e.status)
      return i;
    if (!{
      open: ["deferred", "closed"],
      planned: ["resolved", "closed"],
      deferred: ["open", "closed"],
      resolved: ["closed"],
      closed: [],
      stale: ["closed"]
    }[i.status].includes(e.status))
      throw ie("INVALID_TASK_STATUS", `Revision task cannot change from ${i.status} to ${e.status}`);
    const c = new Date(i.updatedAt).getTime(), d = new Date(Math.max(Date.now(), c + 1)).toISOString();
    if (!await this.client.$executeRawUnsafe(
      `UPDATE AgentRevisionTask SET status = ?, updatedAt = ?
             WHERE revisionTaskId = ?
               AND strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt) = ?`,
      e.status,
      d,
      t,
      r
    ))
      throw ie("VERSION_CONFLICT", "Revision task changed since it was loaded");
    return this.getRevisionTask(t);
  }
  async assertRevisionTaskFresh(e) {
    await this.ensureSchema();
    const t = await this.findStaleChapterIds(this.client, e.novelId, e.sourceSnapshot);
    if (!t.length)
      return;
    const r = (/* @__PURE__ */ new Date()).toISOString();
    throw await this.client.$transaction([
      this.client.$executeRawUnsafe(
        "UPDATE AgentRevisionTask SET status = 'stale', updatedAt = ? WHERE revisionTaskId = ?",
        r,
        e.revisionTaskId
      ),
      this.client.$executeRawUnsafe(
        "UPDATE AgentArtifact SET reviewStatus = 'stale', reviewStaleChapterIdsJson = ?, updatedAt = ? WHERE artifactId = ?",
        JSON.stringify(t),
        r,
        e.sourceArtifactId
      )
    ]), ie("REPORT_STALE", "Source chapters changed after the report was generated", { staleChapterIds: t });
  }
  async attachPlan(e, t) {
    await this.ensureSchema();
    const r = (/* @__PURE__ */ new Date()).toISOString();
    if (!await this.client.$executeRawUnsafe(`
            UPDATE AgentRevisionTask SET status = 'planned', planId = ?, planJson = ?, updatedAt = ?
            WHERE revisionTaskId = ? AND status = 'open'
        `, t.planId, JSON.stringify(t), r, e)) {
      const s = await this.getRevisionTask(e);
      throw ie("INVALID_TASK_STATUS", `Revision task cannot create a plan from status ${s.status}`);
    }
    return this.getRevisionTask(e);
  }
  async syncRevisionTasksFromRun(e) {
    await this.ensureSchema();
    const t = String((e == null ? void 0 : e.novelId) || "").trim(), r = String((e == null ? void 0 : e.sourceArtifactId) || "").trim(), a = String((e == null ? void 0 : e.sourceConversationId) || "").trim(), s = String((e == null ? void 0 : e.sourceRunId) || "").trim(), i = [...new Set(((e == null ? void 0 : e.findingIds) ?? []).map((I) => String(I || "").trim()).filter(Boolean))], o = new Set(((e == null ? void 0 : e.completedFindingIds) ?? []).map((I) => String(I || "").trim()).filter(Boolean));
    if (!t || !r || !a || !i.length)
      throw ie("INVALID_INPUT", "novelId, sourceArtifactId, sourceConversationId and findingIds are required");
    if (!["completed", "committed", "failed", "cancelled", "interrupted"].includes(e.outcome))
      throw ie("INVALID_INPUT", `Unsupported revision run outcome: ${String(e.outcome)}`);
    const d = (await this.client.$queryRawUnsafe(`
            SELECT artifactId, novelId, conversationId, runId, metadataJson, referenceJson, reviewStatus, reviewRevision,
                   reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt
            FROM AgentArtifact WHERE artifactId = ? AND novelId = ?
        `, r, t))[0];
    if (!d)
      throw ie("NOT_FOUND", `Artifact not found: ${r}`);
    const l = On(d), m = new Map(l.findings.map((I) => [I.findingId, I]));
    for (const I of i)
      if (!m.has(I))
        throw ie("INVALID_INPUT", `Unknown findingId: ${I}`);
    const h = (/* @__PURE__ */ new Date()).toISOString(), p = i.map(() => "?").join(", ");
    if (e.outcome === "completed")
      await this.client.$executeRawUnsafe(`
                UPDATE AgentRevisionTask
                SET status = 'planned', sourceConversationId = ?, sourceRunId = ?, updatedAt = ?
                WHERE sourceArtifactId = ? AND sourceFindingId IN (${p})
                  AND status NOT IN ('resolved', 'stale')
            `, a, s || null, h, r, ...i);
    else if (e.outcome === "committed")
      await this.client.$executeRawUnsafe(`
                UPDATE AgentRevisionTask
                SET status = 'resolved', sourceConversationId = ?, sourceRunId = ?, updatedAt = ?
                WHERE sourceArtifactId = ? AND sourceFindingId IN (${p})
                  AND status NOT IN ('resolved', 'stale')
            `, a, s || null, h, r, ...i);
    else {
      const I = i.filter((g) => !o.has(g)), y = await this.findStaleChapterIds(this.client, t, l.sourceSnapshot);
      for (const g of I) {
        const u = m.get(g), v = y.length ? "stale" : "open";
        await this.client.$executeRawUnsafe(
          `
                    INSERT INTO AgentRevisionTask (
                        revisionTaskId, novelId, sourceArtifactId, sourceFindingId, title, description,
                        targetChapterIdsJson, sourceExpert, severity, recommendedRole, status,
                        sourceSnapshotJson, sourceConversationId, sourceRunId, entryReason, createdAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(sourceArtifactId, sourceFindingId) DO UPDATE SET
                        title = excluded.title,
                        description = excluded.description,
                        targetChapterIdsJson = excluded.targetChapterIdsJson,
                        sourceExpert = excluded.sourceExpert,
                        severity = excluded.severity,
                        recommendedRole = excluded.recommendedRole,
                        status = CASE
                            WHEN AgentRevisionTask.status IN ('resolved', 'stale') THEN AgentRevisionTask.status
                            ELSE excluded.status
                        END,
                        sourceSnapshotJson = excluded.sourceSnapshotJson,
                        sourceConversationId = excluded.sourceConversationId,
                        sourceRunId = excluded.sourceRunId,
                        entryReason = excluded.entryReason,
                        planId = NULL,
                        planJson = NULL,
                        updatedAt = excluded.updatedAt
                `,
          `revision_${le().replace(/-/g, "")}`,
          t,
          r,
          u.findingId,
          u.title,
          u.recommendation || u.summary,
          JSON.stringify(u.chapterIds || []),
          u.expert || l.expert,
          u.severity,
          u.recommendedRole || "editor",
          v,
          JSON.stringify(l.sourceSnapshot),
          a,
          s || null,
          e.outcome,
          h,
          h
        );
      }
    }
    return { revisionTasks: (await this.client.$queryRawUnsafe(`
            SELECT task.*,
                   COALESCE(task.sourceConversationId, artifact.conversationId) AS sourceConversationId,
                   COALESCE(task.sourceRunId, artifact.runId) AS sourceRunId
            FROM AgentRevisionTask task
            LEFT JOIN AgentArtifact artifact ON artifact.artifactId = task.sourceArtifactId
            WHERE task.sourceArtifactId = ? AND task.sourceFindingId IN (${p})
            ORDER BY datetime(task.updatedAt) DESC
        `, r, ...i)).map(_t) };
  }
}
const zt = 12e3, Yo = 8e3, Qo = 20, ei = 10, kn = 120;
class Ae extends Error {
  constructor(t, r) {
    super(r);
    H(this, "code");
    this.name = "AgentAttachmentStoreError", this.code = t;
  }
}
function ba(n, e) {
  try {
    return JSON.parse(n);
  } catch {
    return e;
  }
}
function Yt(n) {
  return ba(n.extractionMetaJson, { warnings: [] });
}
function Rt(n) {
  const e = ba(n.extractedContentJson, {});
  return Array.isArray(e.blocks) ? e.blocks : [];
}
function ti(n) {
  return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function $r(n) {
  return n.trim().replace(/[\s　]+/g, "").replace(/[：:。．.、_-]+$/u, "").toLocaleLowerCase();
}
function Qt(n, e) {
  const t = $r(n), r = $r(e);
  return !t || !r ? !1 : t === r ? !0 : t.replace(/[（(]?([上中下前后])[）)]?$/u, "") === r;
}
function Wt(n) {
  var e;
  return ((e = $r(n).match(/[（(]?([上中下前后])[）)]?$/u)) == null ? void 0 : e[1]) || "";
}
function ri(n) {
  var e;
  return ((e = n.headingPath) == null ? void 0 : e.at(-1)) || (n.type === "heading" ? n.text : "");
}
function ni(n, e = "") {
  const t = [], r = /(^|\n)([^\n\r]{1,100})(?=\r?\n|$)/gu;
  let a = r.exec(n), s = 0;
  for (; a; ) {
    const i = a[2].trim();
    if (Qt(i, e) || /^(第.{1,24}[章节卷部篇回]|chapter\s+\S+)/iu.test(i)) {
      const o = a[1] ? a[1].length : 0, c = a.index + o;
      t.push({
        blockId: `fallback-heading-${s++}`,
        type: "heading",
        text: i,
        startOffset: c,
        endOffset: c + a[2].length
      });
    }
    a = r.exec(n);
  }
  return t;
}
function ai(n, e, t, r) {
  const a = n.filter((o) => o.endOffset > e && o.endOffset <= t).map((o) => o.endOffset), s = a.length ? Math.max(...a) : t, i = e + Math.floor((t - e) * 0.6);
  return Math.min(r, s >= i ? s : t);
}
function si(n, e) {
  const t = Math.max(0, Math.min(e, n.length));
  if (t > 0 && t < n.length) {
    const r = n.charCodeAt(t - 1), a = n.charCodeAt(t);
    if (r >= 55296 && r <= 56319 && a >= 56320 && a <= 57343)
      return t - 1;
  }
  return t;
}
function oi(n, e) {
  const t = Math.max(0, Math.min(e, n.length));
  if (t > 0 && t < n.length) {
    const r = n.charCodeAt(t - 1), a = n.charCodeAt(t);
    if (r >= 55296 && r <= 56319 && a >= 56320 && a <= 57343)
      return t + 1;
  }
  return t;
}
function Nr(n) {
  const e = Yt(n);
  return {
    id: n.id,
    novelId: n.novelId,
    conversationId: n.conversationId,
    messageId: n.messageId,
    originalFileName: n.originalFileName,
    extension: n.extension,
    mimeType: n.mimeType,
    sizeBytes: Number(n.sizeBytes),
    characterCount: Number(n.characterCount),
    contentHash: n.contentHash,
    extractorVersion: n.extractorVersion,
    status: n.status === "failed" ? "failed" : "ready",
    errorCode: n.errorCode,
    errorMessage: n.errorMessage,
    title: e.title ?? null,
    pageCount: e.pageCount ?? null,
    warnings: Array.isArray(e.warnings) ? e.warnings : [],
    createdAt: n.createdAt,
    updatedAt: n.updatedAt
  };
}
class xa {
  constructor(e) {
    this.db = e;
  }
  async ensureSchema() {
    await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentAttachment (
                id TEXT PRIMARY KEY, novelId TEXT NOT NULL, conversationId TEXT NOT NULL,
                messageId TEXT, originalFileName TEXT NOT NULL, extension TEXT NOT NULL,
                mimeType TEXT, sizeBytes INTEGER NOT NULL, characterCount INTEGER NOT NULL,
                contentHash TEXT NOT NULL, plainText TEXT NOT NULL, extractedContentJson TEXT NOT NULL,
                extractionMetaJson TEXT NOT NULL DEFAULT '{}', extractorVersion TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'ready', errorCode TEXT, errorMessage TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE
            )
        `), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_attachment_conversation_created ON AgentAttachment(conversationId, createdAt)"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_attachment_novel_hash ON AgentAttachment(novelId, contentHash)"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_attachment_message ON AgentAttachment(messageId)");
  }
  async assertConversationScope(e, t) {
    const r = await this.db.$queryRawUnsafe(
      "SELECT novelId FROM AgentConversation WHERE id = ? LIMIT 1",
      t
    );
    if (!r.length)
      throw new Ae("CONVERSATION_NOT_FOUND", "Agent conversation was not found");
    if (r[0].novelId !== e)
      throw new Ae("ATTACHMENT_SCOPE_MISMATCH", "Conversation does not belong to the current novel");
  }
  async findScoped(e, t, r) {
    await this.ensureSchema();
    const a = await this.db.$queryRawUnsafe(
      "SELECT * FROM AgentAttachment WHERE id = ? LIMIT 1",
      r
    );
    if (!a.length)
      throw new Ae("ATTACHMENT_NOT_FOUND", "Attachment was not found");
    const s = a[0];
    if (s.novelId !== e || s.conversationId !== t)
      throw new Ae("ATTACHMENT_SCOPE_MISMATCH", "Attachment does not belong to the current conversation");
    if (s.status !== "ready")
      throw new Ae("ATTACHMENT_NOT_READY", "Attachment is not ready");
    return s;
  }
  async create(e) {
    await this.ensureSchema(), await this.assertConversationScope(e.novelId, e.conversationId);
    const t = (/* @__PURE__ */ new Date()).toISOString(), r = { ...e.document.metadata, ...e.document.title ? { title: e.document.title } : {} };
    return await this.db.$executeRawUnsafe(
      `
            INSERT INTO AgentAttachment (
                id, novelId, conversationId, messageId, originalFileName, extension, mimeType,
                sizeBytes, characterCount, contentHash, plainText, extractedContentJson,
                extractionMetaJson, extractorVersion, status, createdAt, updatedAt
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        `,
      e.id,
      e.novelId,
      e.conversationId,
      e.originalFileName,
      e.extension,
      e.mimeType ?? null,
      e.sizeBytes,
      e.document.plainText.length,
      e.contentHash,
      e.document.plainText,
      JSON.stringify({ blocks: e.document.blocks }),
      JSON.stringify(r),
      e.extractorVersion,
      t,
      t
    ), this.getMetadata(e.novelId, e.conversationId, e.id);
  }
  async list(e, t) {
    await this.ensureSchema();
    try {
      await this.assertConversationScope(e, t);
    } catch (a) {
      if (a instanceof Ae && a.code === "CONVERSATION_NOT_FOUND")
        return [];
      throw a;
    }
    return (await this.db.$queryRawUnsafe(
      "SELECT * FROM AgentAttachment WHERE novelId = ? AND conversationId = ? ORDER BY datetime(createdAt) ASC",
      e,
      t
    )).map(Nr);
  }
  async getMetadata(e, t, r) {
    return Nr(await this.findScoped(e, t, r));
  }
  async getContent(e, t, r) {
    const a = await this.findScoped(e, t, r);
    return { ...Nr(a), plainText: a.plainText, blocks: Rt(a) };
  }
  async readWindow(e) {
    const t = await this.findScoped(e.novelId, e.conversationId, e.attachmentId), r = Math.max(0, Math.min(Number(e.offset) || 0, t.plainText.length)), a = Math.max(1, Math.min(Number(e.limit) || zt, zt)), s = Math.min(t.plainText.length, r + a), i = Rt(t).filter((c) => c.endOffset > r && c.startOffset < s), o = Yt(t);
    return {
      attachmentId: t.id,
      originalFileName: t.originalFileName,
      offset: r,
      limit: a,
      totalCharacters: t.plainText.length,
      text: t.plainText.slice(r, s),
      nextOffset: s < t.plainText.length ? s : null,
      blockIds: i.map((c) => c.blockId),
      warnings: Array.isArray(o.warnings) ? o.warnings : []
    };
  }
  async read(e) {
    const t = await this.findScoped(e.novelId, e.conversationId, e.attachmentId), r = Rt(t), a = Yt(t), s = e.selector;
    let i = 0, o = t.plainText.length, c = "resolved", d = [];
    if (!s || typeof s != "object")
      throw new Ae("INVALID_INPUT", "Attachment read selector is required");
    if (s.kind === "offset_range") {
      if (i = Number(s.startOffset), o = Number(s.endOffset), !Number.isInteger(i) || !Number.isInteger(o) || i < 0 || o < i)
        throw new Ae("INVALID_INPUT", "offset_range requires 0 <= startOffset <= endOffset");
      i = Math.min(i, t.plainText.length), o = Math.min(o, t.plainText.length);
    } else if (s.kind === "page_range") {
      const y = Number(s.startPage), g = Number(s.endPage);
      if (!Number.isInteger(y) || !Number.isInteger(g) || y < 1 || g < y)
        throw new Ae("INVALID_INPUT", "page_range requires 1 <= startPage <= endPage");
      const u = r.filter((v) => typeof v.page == "number" && v.page >= y && v.page <= g);
      u.length ? (i = Math.min(...u.map((v) => v.startOffset)), o = Math.max(...u.map((v) => v.endOffset))) : c = "not_found";
    } else if (s.kind === "block_range") {
      const y = r.findIndex((u) => u.blockId === s.startBlockId), g = s.endBlockId ? r.findIndex((u) => u.blockId === s.endBlockId) : y;
      y < 0 || g < y ? c = "not_found" : (i = r[y].startOffset, o = r[g].endOffset);
    } else if (s.kind === "section") {
      const y = String(s.title || "").trim();
      if (!y)
        throw new Ae("INVALID_INPUT", "section.title is required");
      let g = r.filter((T) => T.type === "heading"), u = g.filter((T) => Qt(T.text, y));
      u.length || (g = ni(t.plainText, y), u = g.filter((T) => Qt(T.text, y)));
      const v = u.map((T) => {
        var L, V;
        const E = g.indexOf(T), C = ((L = T.headingPath) == null ? void 0 : L.length) || 1, _ = g.slice(E + 1).find((B) => {
          var se;
          return !Qt(B.text, y) && (s.includeSubsections === !1 || (((se = B.headingPath) == null ? void 0 : se.length) || 1) <= C);
        });
        return {
          title: T.text.trim(),
          startOffset: T.startOffset,
          endOffset: (_ == null ? void 0 : _.startOffset) ?? t.plainText.length,
          blockId: (V = r.find((B) => B.startOffset === T.startOffset)) == null ? void 0 : V.blockId,
          ...typeof T.page == "number" ? { page: T.page } : {}
        };
      });
      d = v.filter((T, E) => {
        if (E === 0)
          return !0;
        const C = v[E - 1];
        return !(C.endOffset === T.endOffset && Wt(C.title) && Wt(T.title) && Wt(C.title) !== Wt(T.title));
      });
      const w = Number(s.occurrence || 1);
      if (!Number.isInteger(w) || w < 1)
        throw new Ae("INVALID_INPUT", "section.occurrence must be a positive integer");
      const A = d[w - 1];
      A ? (c = d.length > 1 && s.occurrence == null ? "ambiguous" : "resolved", i = A.startOffset, o = A.endOffset) : c = "not_found";
    } else
      throw new Ae("INVALID_INPUT", `Unsupported attachment selector: ${s.kind || ""}`);
    if (c === "not_found")
      return {
        attachmentId: t.id,
        originalFileName: t.originalFileName,
        status: c,
        selector: s,
        totalCharacters: t.plainText.length,
        text: "",
        truncated: !1,
        nextSelector: null,
        blockIds: [],
        pages: [],
        headings: [],
        candidates: d,
        warnings: a.warnings || []
      };
    const m = Math.max(0, o - i) > zt ? Yo : zt, h = Math.min(o, i + m), p = h < o ? ai(r, i, h, o) : o, f = r.filter((y) => y.endOffset > i && y.startOffset < p), I = p < o;
    return {
      attachmentId: t.id,
      originalFileName: t.originalFileName,
      status: c,
      selector: s,
      actualRange: { startOffset: i, endOffset: p },
      totalCharacters: t.plainText.length,
      text: t.plainText.slice(i, p),
      truncated: I,
      nextSelector: I ? { kind: "offset_range", startOffset: p, endOffset: o } : null,
      blockIds: f.map((y) => y.blockId),
      pages: [...new Set(f.flatMap((y) => typeof y.page == "number" ? [y.page] : []))],
      headings: [...new Set(f.map(ri).filter(Boolean))],
      candidates: d,
      warnings: Array.isArray(a.warnings) ? a.warnings : []
    };
  }
  async outline(e, t, r) {
    const a = await this.findScoped(e, t, r), s = Yt(a), i = Rt(a), o = i.filter((d) => d.type === "heading" || typeof d.page == "number"), c = (o.length ? o : i.slice(0, 100)).map((d) => {
      var l;
      return {
        blockId: d.blockId,
        type: d.type,
        text: d.text.slice(0, 240),
        ...d.page ? { page: d.page } : {},
        ...(l = d.headingPath) != null && l.length ? { headingPath: d.headingPath } : {},
        startOffset: d.startOffset,
        endOffset: d.endOffset
      };
    });
    return {
      attachmentId: a.id,
      originalFileName: a.originalFileName,
      totalCharacters: a.plainText.length,
      pageCount: s.pageCount ?? null,
      entries: c,
      warnings: Array.isArray(s.warnings) ? s.warnings : []
    };
  }
  async search(e) {
    var o;
    await this.ensureSchema(), await this.assertConversationScope(e.novelId, e.conversationId);
    const t = String(e.query || "").trim();
    if (!t)
      throw new Ae("INVALID_INPUT", "Attachment search query is required");
    if (t.length > 200)
      throw new Ae("INVALID_INPUT", "Attachment search query is too long");
    const r = Math.max(1, Math.min(Number(e.limit) || ei, Qo));
    let a;
    if (e.attachmentId) {
      const c = await this.findScoped(e.novelId, e.conversationId, e.attachmentId);
      if (!c.messageId)
        throw new Ae("ATTACHMENT_NOT_SENT", "Attachment has not been sent in this conversation");
      a = [c];
    } else
      a = await this.db.$queryRawUnsafe(
        `SELECT * FROM AgentAttachment
                 WHERE novelId = ? AND conversationId = ? AND messageId IS NOT NULL
                 ORDER BY datetime(createdAt) ASC`,
        e.novelId,
        e.conversationId
      );
    const s = new RegExp(ti(t), "giu"), i = [];
    for (const c of a) {
      s.lastIndex = 0;
      const d = Rt(c);
      let l = s.exec(c.plainText);
      for (; l; ) {
        const m = l.index, h = m + l[0].length, p = d.find((y) => y.endOffset > m && y.startOffset < h), f = si(c.plainText, m - kn), I = oi(c.plainText, h + kn);
        if (i.push({
          attachmentId: c.id,
          originalFileName: c.originalFileName,
          ...p ? { blockId: p.blockId } : {},
          ...typeof (p == null ? void 0 : p.page) == "number" ? { page: p.page } : {},
          ...(o = p == null ? void 0 : p.headingPath) != null && o.length ? { headingPath: p.headingPath } : {},
          startOffset: m,
          endOffset: h,
          snippetStartOffset: f,
          snippetEndOffset: I,
          snippet: c.plainText.slice(f, I)
        }), i.length > r)
          return { query: t, searchedAttachmentCount: a.length, hasMore: !0, matches: i.slice(0, r) };
        l = s.exec(c.plainText);
      }
    }
    return { query: t, searchedAttachmentCount: a.length, hasMore: !1, matches: i };
  }
  async bindToMessage(e, t, r, a) {
    await this.assertConversationScope(e, t);
    const s = [...new Set(a)];
    for (const i of s) {
      const o = await this.findScoped(e, t, i);
      if (o.messageId && o.messageId !== r)
        throw new Ae("ATTACHMENT_ALREADY_BOUND", "Attachment is already bound to another message");
    }
    if (s.length) {
      const i = s.map(() => "?").join(", ");
      await this.db.$executeRawUnsafe(
        `UPDATE AgentAttachment SET messageId = ?, updatedAt = ? WHERE id IN (${i})`,
        r,
        (/* @__PURE__ */ new Date()).toISOString(),
        ...s
      );
    }
    return Promise.all(s.map((i) => this.getMetadata(e, t, i)));
  }
  async removePending(e, t, r) {
    if ((await this.findScoped(e, t, r)).messageId)
      throw new Ae("ATTACHMENT_ALREADY_BOUND", "Sent attachments cannot be removed");
    return await this.db.$executeRawUnsafe("DELETE FROM AgentAttachment WHERE id = ?", r), { ok: !0 };
  }
}
const ii = {
  plotLines: [],
  plotPoints: [],
  characters: [],
  items: [],
  skills: [],
  maps: []
}, ci = {
  "novel.list": 15e3,
  "volume.list": 15e3,
  "chapter.list": 15e3,
  "chapter.get": 15e3,
  "attachment.list": 15e3,
  "attachment.get": 15e3,
  "attachment.read": 15e3,
  "attachment.outline": 15e3,
  "attachment.search": 15e3,
  "chapter.scope_context.build": 6e4,
  "plotline.list": 15e3,
  "character.list": 15e3,
  "item.list": 15e3,
  "worldsetting.list": 15e3,
  "worldsetting.create": 3e4,
  "worldsetting.update": 3e4,
  "map.list": 15e3,
  "search.query": 15e3,
  "rag.ask": 9e4,
  "rag.preview": 3e4,
  "rag.rebuild_index": 18e4,
  "agent.generate_chat": 15e4,
  "agent.generate_plan": 15e4,
  "agent.revise_plan": 15e4,
  "agent.generate_report": 21e4,
  "agent.generate_consistency_review": 24e4,
  "agent.generate_editor_range_review": 24e4,
  "agent.generate_writer_range_revision_plan": 24e4,
  "agent.generate_reader_chapter_evaluation": 24e4,
  "agent.generate_worldbuilding_range_consistency": 24e4,
  "agent.extract_research_claims": 24e4,
  "agent.generate_research_fact_check": 24e4,
  "agent.generate_scope_audit": 24e4,
  "agent.generate_plotline_analysis": 24e4,
  "agent.detect_creative_direction": 15e4,
  "agent.generate_chapter_beats": 18e4,
  "artifact.review.submit": 3e4,
  "review.comment.list": 15e3,
  "review.comment.save": 15e3,
  "review.comment.delete": 15e3,
  "review.comment.mark_sent": 15e3,
  "revision_task.list": 15e3,
  "revision_task.create_plan": 15e4,
  "revision_task.update_status": 15e3,
  "revision_task.sync_run": 15e3,
  "draft.list": 15e3,
  "draft.get": 15e3,
  "draft.get_active": 15e3,
  "draft.update": 15e3,
  "draft.commit": 3e4,
  "draft.undo": 3e4,
  "draft.discard": 15e3,
  "draft.batch.list": 15e3,
  "draft.batch.get": 15e3,
  "draft.batch.create": 15e3,
  "draft.batch.update_outline": 15e3,
  "draft.batch.approve_outline": 15e3,
  "draft.batch.attach_child": 15e3,
  "draft.batch.mark_stale_after": 15e3,
  "draft.batch.prepare_regeneration": 15e3,
  "draft.batch.mark_failed": 15e3,
  "draft.batch.inspect_reconciliation": 15e3,
  "draft.batch.reconcile_unknown": 15e3,
  "draft.batch.commit_prefix": 6e4,
  "draft.batch.undo": 6e4,
  "draft.batch.discard": 15e3,
  "outline.write": 3e4,
  "character.create_batch": 3e4,
  "story_patch.apply": 3e4,
  "chapter.create": 3e4,
  "chapter.save": 3e4,
  "prompt.preview": 3e4,
  "creative_assets.validate_draft": 3e4,
  "creative_assets.generate_draft": 21e4,
  "creative_assets.revise_draft": 3e5,
  "outline.generate_draft": 21e4,
  "chapter.generate_draft": 36e4,
  "chapter.revise_draft": 36e4,
  "chapter.continuation_context.build": 9e4
}, di = 3e4;
function Xt(n) {
  return {
    plotLines: (n.plotLines ?? []).map(() => !0),
    plotPoints: (n.plotPoints ?? []).map(() => !0),
    characters: (n.characters ?? []).map(() => !0),
    items: (n.items ?? []).map(() => !0),
    skills: (n.skills ?? []).map(() => !0),
    maps: (n.maps ?? []).map(() => !0)
  };
}
function Xe(n) {
  if (!n || typeof n != "object")
    return { ...ii };
  const e = n;
  return {
    plotLines: Array.isArray(e.plotLines) ? e.plotLines : [],
    plotPoints: Array.isArray(e.plotPoints) ? e.plotPoints : [],
    characters: Array.isArray(e.characters) ? e.characters : [],
    items: Array.isArray(e.items) ? e.items : [],
    skills: Array.isArray(e.skills) ? e.skills : [],
    maps: Array.isArray(e.maps) ? e.maps : []
  };
}
function Dt(n) {
  var t, r, a, s, i, o;
  return [
    `主线 ${((t = n.plotLines) == null ? void 0 : t.length) ?? 0}`,
    `要点 ${((r = n.plotPoints) == null ? void 0 : r.length) ?? 0}`,
    `角色 ${((a = n.characters) == null ? void 0 : a.length) ?? 0}`,
    `物品 ${((s = n.items) == null ? void 0 : s.length) ?? 0}`,
    `技能 ${((i = n.skills) == null ? void 0 : i.length) ?? 0}`,
    `地图 ${((o = n.maps) == null ? void 0 : o.length) ?? 0}`
  ].join(" / ");
}
function br(n) {
  const e = (t, r) => (Array.isArray(t) ? t : []).filter((s) => typeof s == "object" && s && String(s[r] || "").trim());
  return {
    plotLines: e(n.plotLines, "name"),
    plotPoints: e(n.plotPoints, "title"),
    characters: e(n.characters, "name"),
    items: e(n.items, "name"),
    skills: e(n.skills, "name"),
    maps: e(n.maps, "name")
  };
}
function Ln(n, e) {
  return e ? {
    plotLines: (n.plotLines ?? []).filter((t, r) => e.plotLines[r]),
    plotPoints: (n.plotPoints ?? []).filter((t, r) => e.plotPoints[r]),
    characters: (n.characters ?? []).filter((t, r) => e.characters[r]),
    items: (n.items ?? []).filter((t, r) => e.items[r]),
    skills: (n.skills ?? []).filter((t, r) => e.skills[r]),
    maps: (n.maps ?? []).filter((t, r) => e.maps[r])
  } : Xe(n);
}
function li(n) {
  return Xe({
    plotLines: n.plotLines,
    plotPoints: n.plotPoints
  });
}
function ui(n) {
  return Xe({
    characters: n.characters,
    items: n.items,
    skills: n.skills
  });
}
function G(n, e, t) {
  return Object.assign(new Error(e), { code: n, details: t });
}
function F(n, e) {
  const t = typeof n == "string" ? n.trim() : "";
  if (!t)
    throw G("INVALID_INPUT", `${e} is required`);
  return t;
}
function ce(n, e) {
  if (typeof n != "number" || !Number.isFinite(n))
    throw G("INVALID_INPUT", `${e} must be a finite number`);
  return n;
}
function hi(n) {
  return ci[n] ?? di;
}
function mi(n) {
  const e = String(n || "").trim().toLowerCase();
  if (["creative_assets", "creative-assets", "outline-generate", "outline_generate", "outline"].includes(e))
    return "creative_assets";
  if (["chapter", "chapter-generate", "chapter_generate", "continue-writing", "continue_writing"].includes(e))
    return "chapter";
  throw G("INVALID_INPUT", `Unsupported prompt preview kind: ${String(n || "")}`);
}
class fi {
  constructor(e, t, r = new xa(S)) {
    H(this, "aiService");
    H(this, "draftStore");
    H(this, "reviewStore");
    H(this, "reviewCommentStore");
    H(this, "attachmentStore");
    H(this, "draftBatchCommitTail", Promise.resolve());
    this.aiService = e, this.draftStore = new Fo(t), this.reviewStore = new Zo(S), this.reviewCommentStore = new jo(t), this.attachmentStore = r;
  }
  async createRevisionTaskPlan(e, t) {
    var p;
    const r = F(e == null ? void 0 : e.revisionTaskId, "revisionTaskId"), a = Array.isArray(e == null ? void 0 : e.availableTools) ? e.availableTools.map((f) => String(f || "").trim()).filter(Boolean) : [];
    if (!a.length)
      throw G("INVALID_INPUT", "availableTools is required");
    const s = await this.reviewStore.getRevisionTask(r);
    if (s.status !== "open")
      throw G("INVALID_TASK_STATUS", `Revision task cannot create a plan from status ${s.status}`);
    await this.reviewStore.assertRevisionTaskFresh(s);
    const i = e.role || s.recommendedRole, o = [
      `根据已审核问题创建修订计划：${s.title}`,
      s.description,
      s.targetChapterIds.length ? `目标章节：${s.targetChapterIds.join("、")}` : "",
      `来源专家：${s.sourceExpert}；严重度：${s.severity}`,
      s.note ? `审核备注：${s.note}` : "",
      "只生成可审核计划，不直接修改或写回正文。"
    ].filter(Boolean).join(`
`), c = await this.aiService.generateAgentPlan({
      goal: o,
      role: i,
      locale: e.locale || "zh-CN",
      availableTools: a,
      availableToolchains: Array.isArray(e.availableToolchains) ? e.availableToolchains : []
    }, t.signal), d = `plan_${le().replace(/-/g, "")}`, l = ((p = e.threadId) == null ? void 0 : p.trim()) || `thread_revision_${le().replace(/-/g, "")}`, m = {
      planId: d,
      threadId: l,
      title: c.title,
      goal: o,
      requiresApproval: !0,
      preferredRole: i,
      ...c.deliverable ? { deliverable: c.deliverable } : {},
      steps: c.steps.map((f) => ({
        stepId: `step_${le().replace(/-/g, "")}`,
        agent: f.agent,
        title: f.title,
        tools: Array.isArray(f.tools) ? f.tools : [],
        ...f.toolchain ? { toolchain: f.toolchain } : {},
        status: "pending"
      }))
    };
    return { task: await this.reviewStore.attachPlan(r, m), plan: m };
  }
  async serializeDraftBatchCommit(e) {
    const t = this.draftBatchCommitTail;
    let r;
    this.draftBatchCommitTail = new Promise((a) => {
      r = a;
    }), await t;
    try {
      return await e();
    } finally {
      r();
    }
  }
  logInvokeStart(e, t, r, a) {
    $("INFO", "AutomationService.invoke.start", "Automation invoke start", {
      requestId: r.requestId,
      method: e,
      source: r.source,
      origin: r.origin,
      timeoutMs: a,
      params: ve(t)
    });
  }
  logInvokeSuccess(e, t, r, a) {
    $("INFO", "AutomationService.invoke.success", "Automation invoke success", {
      requestId: t.requestId,
      method: e,
      elapsedMs: Date.now() - r,
      result: ve(a)
    });
  }
  logInvokeError(e, t, r, a) {
    Se("AutomationService.invoke.error", a, {
      requestId: t.requestId,
      method: e,
      elapsedMs: Date.now() - r
    });
  }
  async withTimeout(e, t, r, a) {
    var d;
    const s = hi(e), i = Date.now();
    this.logInvokeStart(e, t, r, s);
    let o;
    const c = new Promise((l, m) => {
      var h;
      o = setTimeout(() => {
        m(G("UPSTREAM_TIMEOUT", `Automation method ${e} timed out after ${s}ms`, {
          method: e,
          timeoutMs: s,
          requestId: r.requestId
        }));
      }, s), (h = o.unref) == null || h.call(o);
    });
    try {
      const l = await Promise.race([a(), c]);
      return o && clearTimeout(o), this.logInvokeSuccess(e, r, i, l), l;
    } catch (l) {
      throw o && clearTimeout(o), this.logInvokeError(e, r, i, l), (d = r.signal) != null && d.aborted ? G("CANCELLED", `Automation method ${e} was cancelled`, {
        method: e,
        requestId: r.requestId
      }) : l;
    }
  }
  buildPromptPreviewPayload(e, t) {
    if (e === "creative_assets") {
      const r = F(t.novelId, "payload.novelId"), a = F(t.brief, "payload.brief"), s = Array.isArray(t.targetSections) ? t.targetSections : String(t.kind || "").toLowerCase().includes("outline") ? ["plotLines", "plotPoints"] : void 0;
      return {
        ...t,
        novelId: r,
        brief: a,
        ...s ? { targetSections: s } : {}
      };
    }
    return {
      ...t,
      novelId: F(t.novelId, "payload.novelId"),
      chapterId: F(t.chapterId, "payload.chapterId"),
      currentContent: F(t.currentContent, "payload.currentContent")
    };
  }
  async listDrafts(e) {
    return this.draftStore.list(e);
  }
  async getDraft(e) {
    return this.draftStore.getById(e);
  }
  async getActiveDraft(e) {
    return F(e == null ? void 0 : e.novelId, "novelId"), this.draftStore.getLatest({
      novelId: e.novelId,
      workspace: e.workspace,
      type: e.type,
      status: "draft"
    });
  }
  async listDraftBatches(e) {
    return this.draftStore.listBatches(e);
  }
  async getDraftBatch(e) {
    return this.draftStore.getBatchById(e);
  }
  async createDraftBatch(e) {
    return F(e == null ? void 0 : e.novelId, "novelId"), F(e == null ? void 0 : e.volumeId, "volumeId"), F(e == null ? void 0 : e.anchorChapterId, "anchorChapterId"), this.draftStore.createBatch(e);
  }
  async updateDraftBatchOutline(e) {
    return this.draftStore.updateBatchOutline(
      F(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version"),
      e == null ? void 0 : e.beats
    );
  }
  async approveDraftBatchOutline(e) {
    return this.draftStore.approveBatchOutline(
      F(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version"),
      ce(e == null ? void 0 : e.outlineRevision, "outlineRevision"),
      typeof (e == null ? void 0 : e.approvedBy) == "string" ? e.approvedBy : "desktop-ui"
    );
  }
  async attachDraftBatchChild(e) {
    return this.draftStore.createBatchChildSession(
      F(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.childIndex, "childIndex"),
      e == null ? void 0 : e.session
    );
  }
  async markDraftBatchStaleAfter(e) {
    return this.draftStore.markBatchChildrenStale(
      F(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version"),
      ce(e == null ? void 0 : e.afterChildIndex, "afterChildIndex")
    );
  }
  async prepareDraftBatchRegeneration(e) {
    const t = e == null ? void 0 : e.fromChildIndex;
    if (t !== void 0 && (!Number.isInteger(t) || t < 0))
      throw G("INVALID_INPUT", "fromChildIndex must be a non-negative integer");
    return this.draftStore.prepareBatchRegeneration(
      F(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version"),
      t,
      F(e == null ? void 0 : e.runId, "runId")
    );
  }
  async markDraftBatchChildFailed(e) {
    if (F(e == null ? void 0 : e.draftBatchId, "draftBatchId"), ce(e == null ? void 0 : e.version, "version"), ce(e == null ? void 0 : e.childIndex, "childIndex"), ce(e == null ? void 0 : e.generationRevision, "generationRevision"), !Number.isInteger(e.childIndex) || e.childIndex < 0)
      throw G("INVALID_INPUT", "childIndex must be a non-negative integer");
    if (!Number.isInteger(e.generationRevision) || e.generationRevision < 1)
      throw G("INVALID_INPUT", "generationRevision must be a positive integer");
    return this.draftStore.markBatchChildFailed(e);
  }
  async inspectDraftBatchReconciliation(e) {
    const t = ce(e == null ? void 0 : e.childIndex, "childIndex"), r = ce(e == null ? void 0 : e.generationRevision, "generationRevision");
    if (!Number.isInteger(t) || t < 0)
      throw G("INVALID_INPUT", "childIndex must be a non-negative integer");
    if (!Number.isInteger(r) || r < 1)
      throw G("INVALID_INPUT", "generationRevision must be a positive integer");
    return this.draftStore.inspectBatchReconciliation({
      draftBatchId: F(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      childIndex: t,
      generationRevision: r
    });
  }
  async reconcileDraftBatchUnknown(e) {
    if (F(e == null ? void 0 : e.invocationKey, "invocationKey"), (e == null ? void 0 : e.resolution) !== "reconciled_succeeded" && (e == null ? void 0 : e.resolution) !== "reconciled_absent")
      throw G("INVALID_INPUT", "resolution must be reconciled_succeeded or reconciled_absent");
    return this.draftStore.reconcileBatchUnknown({
      ...e,
      draftBatchId: F(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      version: ce(e == null ? void 0 : e.version, "version"),
      childIndex: ce(e == null ? void 0 : e.childIndex, "childIndex"),
      generationRevision: ce(e == null ? void 0 : e.generationRevision, "generationRevision"),
      invocationKey: F(e == null ? void 0 : e.invocationKey, "invocationKey")
    });
  }
  async discardDraftBatch(e) {
    return this.draftStore.discardBatch(
      F(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version")
    );
  }
  async commitDraftBatchPrefix(e) {
    return this.serializeDraftBatchCommit(async () => {
      const t = F(e == null ? void 0 : e.draftBatchId, "draftBatchId"), r = ce(e == null ? void 0 : e.version, "version"), a = ce(e == null ? void 0 : e.prefixLength, "prefixLength");
      if (!Number.isInteger(a))
        throw G("INVALID_INPUT", "prefixLength must be an integer");
      const s = e == null ? void 0 : e.insertionMode;
      if (s !== void 0 && s !== "after_anchor" && s !== "volume_end")
        throw G("INVALID_INPUT", "insertionMode must be after_anchor or volume_end");
      const i = await this.draftStore.getBatchById(t);
      if (!i)
        throw G("NOT_FOUND", "Draft batch not found");
      if (i.version !== r)
        throw G("VERSION_CONFLICT", "Draft batch version conflict");
      if (!Number.isInteger(a) || a < 1 || a > i.children.length)
        throw G("INVALID_INPUT", "prefixLength is outside the draft batch");
      if (i.status === "discarded" || i.status === "failed")
        throw G("INVALID_STATE", `Draft batch cannot be committed from ${i.status}`);
      const o = i.children.findIndex((f) => f.status !== "committed"), c = o < 0 ? i.children.length : o;
      if (i.children.slice(c).some((f) => f.status === "committed"))
        throw G("INVALID_STATE", "Draft batch contains a non-contiguous committed child");
      if (a <= c)
        throw G("INVALID_STATE", "Requested prefix is already committed");
      const d = await this.draftStore.list({ draftBatchId: t, includeInactive: !0 }), l = new Map(d.map((f) => [f.draftSessionId, f])), m = i.children.slice(c, a).map((f) => {
        const I = f.draftSessionId ? l.get(f.draftSessionId) : void 0;
        if (!I || f.status !== "draft" || I.status !== "draft" || I.type !== "chapter-draft")
          throw G(
            "INVALID_STATE",
            `Draft batch child ${f.childIndex + 1} is not ready to commit`
          );
        if (I.draftBatchId !== t || I.childIndex !== f.childIndex)
          throw G(
            "INVALID_STATE",
            `Draft batch child ${f.childIndex + 1} session linkage is invalid`
          );
        const y = I.payload, g = String(y.generatedText || "").trim(), u = i.mode === "sequence_continuation" ? Na(g) : zo(String(y.content || g));
        if (!Cr(u))
          throw G(
            "INVALID_STATE",
            `Draft batch child ${f.childIndex + 1} has no reviewable content`
          );
        return {
          childIndex: f.childIndex,
          targetChapterId: f.targetChapterId,
          title: f.title.trim() || `第 ${f.childIndex + 1} 章`,
          content: u,
          wordCount: Cr(u).length
        };
      }), h = await Xo(S, {
        batch: i,
        committedPrefixLength: c,
        prefixLength: a,
        insertionMode: s,
        drafts: m
      }), p = await this.draftStore.commitBatchPrefix(
        t,
        r,
        a,
        h.insertionMode,
        h.chapters,
        h.writeback
      );
      for (const f of h.chapters)
        await Fe({
          id: f.chapterId,
          title: f.title,
          content: f.content,
          volumeId: f.volumeId,
          order: f.order,
          novelId: i.novelId
        }), st(f.chapterId);
      if (h.reorderedChapterIds.length > 0) {
        const f = await S.chapter.findMany({
          where: { id: { in: h.reorderedChapterIds } },
          select: { id: !0, title: !0, content: !0, volumeId: !0 }
        });
        for (const I of f)
          await Fe({ ...I, novelId: i.novelId });
      }
      return {
        batch: p.batch,
        sessions: p.sessions,
        chapters: h.chapters,
        committedPrefixLength: a,
        insertionMode: h.insertionMode,
        writeback: h.writeback
      };
    });
  }
  async undoDraftBatch(e) {
    return this.serializeDraftBatchCommit(async () => {
      const t = F(e == null ? void 0 : e.draftBatchId, "draftBatchId"), r = ce(e == null ? void 0 : e.version, "version"), a = F(e == null ? void 0 : e.writebackId, "writebackId"), s = await this.draftStore.getBatchById(t);
      if (!s)
        throw G("NOT_FOUND", "Draft batch not found");
      if (s.version !== r)
        throw G("VERSION_CONFLICT", "Draft batch version conflict");
      const i = [...s.writebacks ?? []].reverse().find((d) => d.status === "committed");
      if (!i || i.writebackId !== a)
        throw G("INVALID_STATE", "Only the latest writeback can be undone");
      const o = await Go(S, s, i), c = await this.draftStore.undoBatchWriteback(
        t,
        r,
        a,
        o
      );
      for (const d of o)
        await Fe({
          id: d.chapterId,
          title: d.title,
          content: d.content,
          volumeId: d.volumeId,
          order: d.order,
          novelId: s.novelId
        }), st(d.chapterId);
      return {
        batch: c.batch,
        writeback: c.writeback
      };
    });
  }
  async generateCreativeAssetsDraft(e, t, r = "creative-assets") {
    F(e == null ? void 0 : e.novelId, "novelId"), F(e == null ? void 0 : e.brief, "brief");
    const a = await this.aiService.generateCreativeAssets(e, t.signal), s = br(Xe(a.draft));
    return this.draftStore.create({
      workspace: "ai-workbench",
      type: r,
      source: "internal-ai",
      origin: t.origin ?? "unknown",
      novelId: e.novelId,
      status: "draft",
      payload: s,
      selection: Xt(s),
      previewSummary: Dt(s),
      validation: null
    });
  }
  async createChapterDraftSession(e, t) {
    var C, _, L, V, B, se;
    F(e == null ? void 0 : e.novelId, "novelId"), F(e == null ? void 0 : e.chapterId, "chapterId"), F(e == null ? void 0 : e.currentContent, "currentContent");
    const r = typeof e.presentation == "string" ? e.presentation.trim().toLowerCase() : "", a = r === "silent" || r === "toast" || r === "modal" ? r : void 0, s = typeof e.draftBatchId == "string" ? e.draftBatchId.trim() : "", i = e.childIndex;
    if (s && !Number.isInteger(i) || !s && i !== void 0)
      throw G("INVALID_INPUT", "draftBatchId and integer childIndex must be supplied together");
    let o;
    if (!s) {
      const W = await S.chapter.findUnique({
        where: { id: e.chapterId },
        select: { id: !0, version: !0, content: !0, deleted: !0, volume: { select: { novelId: !0 } } }
      });
      if (!W || W.deleted || W.volume.novelId !== e.novelId)
        throw G("NOT_FOUND", "Chapter source is unavailable");
      o = {
        chapterId: W.id,
        version: W.version,
        contentHash: be("sha256").update(W.content || "", "utf8").digest("hex")
      };
    }
    const {
      presentation: c,
      draftBatchId: d,
      childIndex: l,
      batchTitle: m,
      generationRevision: h,
      batchMode: p,
      targetChapterId: f,
      ...I
    } = e, y = await this.aiService.continueWriting(I, t.signal);
    let g, u = "";
    if (s && Number.isInteger(i)) {
      const W = (C = e.preparedContext) == null ? void 0 : C.hardContext, Q = (N) => (N ?? []).map((X) => ({
        key: String(X.id || X.name || "").trim(),
        name: String(X.name || "").trim()
      })).filter((X) => X.key && X.name);
      try {
        g = (await this.aiService.extractNarrativeState({
          locale: e.locale,
          generatedText: y.text,
          currentBeat: (_ = e.batchContext) != null && _.currentBeat && typeof e.batchContext.currentBeat == "object" ? e.batchContext.currentBeat : {},
          priorStateLedger: (L = e.batchContext) != null && L.stateLedger && typeof e.batchContext.stateLedger == "object" ? e.batchContext.stateLedger : {},
          characters: Q(W == null ? void 0 : W.characters),
          items: Q(W == null ? void 0 : W.items)
        }, t.signal)).delta;
      } catch (N) {
        if ((V = t.signal) != null && V.aborted)
          throw N;
        u = "章节状态抽取失败，已使用节拍台账继续生成。", Se("AutomationService.chapter.state-extraction", N, {
          draftBatchId: s,
          childIndex: i,
          generationRevision: e.generationRevision
        });
      }
    }
    const v = s && e.batchMode === "batch_rewrite", w = v ? F(e.targetChapterId, "targetChapterId") : s ? `draft-batch:${s}:${i}` : e.chapterId, A = v ? e.currentContent : s ? "" : e.currentContent, T = {
      chapterId: w,
      baseContent: A,
      generatedText: y.text,
      content: v ? y.text : Zt(A, y.text),
      presentation: a,
      usedContext: y.usedContext,
      warnings: [
        ...y.warnings ?? [],
        ...u ? [u] : []
      ],
      narrativeStateDelta: g,
      contextPolicy: y.contextPolicy,
      contextSnapshot: y.contextSnapshot,
      sourceSnapshot: o,
      consistency: y.consistency
    }, E = {
      workspace: "chapter-editor",
      type: "chapter-draft",
      source: "internal-ai",
      origin: t.origin ?? "unknown",
      novelId: e.novelId,
      chapterId: w,
      status: "draft",
      payload: T,
      previewSummary: `${((B = e.batchTitle) == null ? void 0 : B.trim()) || "章节草稿"} ${y.text.length} 字符`
    };
    if (s && Number.isInteger(i)) {
      const W = (se = e.batchContext) != null && se.currentBeat && typeof e.batchContext.currentBeat == "object" ? e.batchContext.currentBeat : {};
      return (await this.draftStore.createBatchChildSession(
        s,
        i,
        E,
        {
          title: String(W.title || e.batchTitle || "").trim(),
          coreConflict: String(W.coreConflict || "").trim(),
          keyEvents: Array.isArray(W.keyEvents) ? W.keyEvents.map(String) : [],
          reveals: Array.isArray(W.reveals) ? W.reveals.map(String) : [],
          endingHook: String(W.endingHook || "").trim(),
          summary: y.text.length > 700 ? `${y.text.slice(0, 350)} ... ${y.text.slice(-250)}` : y.text,
          stateDelta: g
        },
        e.generationRevision
      )).session;
    }
    return this.draftStore.create(E);
  }
  async reviseChapterDraftSession(e, t) {
    var d, l;
    const r = F(e == null ? void 0 : e.sourceDraftSessionId, "sourceDraftSessionId");
    if (ce(e == null ? void 0 : e.sourceDraftVersion, "sourceDraftVersion"), !Array.isArray(e == null ? void 0 : e.comments) || e.comments.length === 0)
      throw G("INVALID_INPUT", "At least one review comment is required");
    const a = await this.draftStore.getById(r);
    if (!a)
      throw G("NOT_FOUND", "Source draft session not found");
    if (a.version !== e.sourceDraftVersion)
      throw G("VERSION_CONFLICT", "Source draft changed after the review comments were loaded");
    if (a.type !== "chapter-draft" || a.draftBatchId)
      throw G("INVALID_DRAFT_TYPE", "Only a standalone chapter draft can use chapter.revise_draft");
    if (a.status !== "draft")
      throw G("INVALID_STATE", "Only the current reviewable draft can be regenerated");
    const s = a.payload, i = e.comments.map((m, h) => {
      var I;
      const p = typeof m.anchor.paragraphIndex == "number" ? `第 ${m.anchor.paragraphIndex + 1} 段` : m.anchor.targetId, f = (I = m.anchor.quote) != null && I.trim() ? `
原文摘录：${m.anchor.quote.trim().slice(0, 500)}` : "";
      return `${h + 1}. ${p}：${m.body.trim()}${f}`;
    }).join(`
`), o = await this.aiService.continueWriting({
      novelId: a.novelId,
      chapterId: ((d = s.sourceSnapshot) == null ? void 0 : d.chapterId) || s.chapterId,
      currentContent: s.generatedText,
      locale: e.locale || "zh-CN",
      mode: "rewrite_chapter",
      userIntent: [
        "根据以下审批意见重写当前待审核草稿。",
        "只调整被指出的内容；没有审批意见的情节、事实、人物状态、伏笔和文风应尽量保持。",
        "输出完整的新草稿正文，不要解释修改过程。",
        i
      ].join(`
`),
      presentation: "silent"
    }, t.signal), c = o.text.trim();
    if (!c)
      throw G("EMPTY_RESULT", "Agent returned an empty revised draft");
    return this.draftStore.create({
      workspace: a.workspace,
      type: "chapter-draft",
      source: "internal-ai",
      origin: t.origin ?? "desktop-ui",
      novelId: a.novelId,
      chapterId: a.chapterId,
      revisionOfDraftSessionId: a.draftSessionId,
      reviewRequestId: ((l = e.reviewRequestId) == null ? void 0 : l.trim()) || le(),
      status: "draft",
      payload: {
        ...s,
        generatedText: c,
        content: Zt(s.baseContent, c),
        usedContext: o.usedContext,
        warnings: o.warnings,
        contextPolicy: o.contextPolicy,
        contextSnapshot: o.contextSnapshot,
        consistency: o.consistency
      },
      previewSummary: `审批意见修订草稿 ${c.length} 字符`
    });
  }
  async reviseCreativeAssetsDraftSession(e, t) {
    var h;
    const r = F(e == null ? void 0 : e.sourceDraftSessionId, "sourceDraftSessionId");
    if (ce(e == null ? void 0 : e.sourceDraftVersion, "sourceDraftVersion"), !Array.isArray(e == null ? void 0 : e.comments) || e.comments.length === 0)
      throw G("INVALID_INPUT", "At least one review comment is required");
    const a = await this.draftStore.getById(r);
    if (!a)
      throw G("NOT_FOUND", "Source draft session not found");
    if (a.version !== e.sourceDraftVersion)
      throw G("VERSION_CONFLICT", "Source draft changed after the review comments were loaded");
    if (a.type !== "creative-assets")
      throw G("INVALID_DRAFT_TYPE", "Only a creative assets draft can use creative_assets.revise_draft");
    if (a.status !== "draft")
      throw G("INVALID_STATE", "Only the current reviewable draft can be regenerated");
    if (e.comments.some((p) => p.reviewVersionId !== a.draftSessionId))
      throw G("VERSION_CONFLICT", "Review comments belong to another creative assets version");
    const s = br(Xe(a.payload)), i = Object.keys(s).filter((p) => {
      var f;
      return Array.isArray(s[p]) && (((f = s[p]) == null ? void 0 : f.length) ?? 0) > 0;
    }), o = e.comments.map((p, f) => {
      var g;
      const I = p.anchor.fieldPath || p.anchor.targetId, y = (g = p.anchor.quote) != null && g.trim() ? `
条目摘录：${p.anchor.quote.trim().slice(0, 500)}` : "";
      return `${f + 1}. ${I}：${p.body.trim()}${y}`;
    }).join(`
`), c = JSON.stringify(s, (p, f) => p === "imageBase64" ? "[保留原图片数据]" : f, 2), d = await this.aiService.generateCreativeAssets({
      novelId: a.novelId,
      locale: e.locale || "zh-CN",
      brief: "根据审批意见重写当前创作素材审核包。",
      targetSections: i,
      includeExistingEntities: !1,
      filterCompletedPlotLines: !1,
      overrideUserPrompt: [
        "你正在修订一个待审核的创作素材包。",
        "必须返回完整 JSON 素材包，结构与原素材包一致。",
        "只修改审批意见指出的条目或字段；其余情节、角色、设定、物品、技能和地图保持不变。",
        "不要解释修改过程，不要省略未修改条目。",
        "原素材包：",
        c,
        "审批意见：",
        o
      ].join(`
`)
    }, t.signal), l = br(Xe(d.draft));
    if (Object.values(l).reduce((p, f) => p + ((f == null ? void 0 : f.length) ?? 0), 0) === 0)
      throw G("EMPTY_RESULT", "Agent returned an empty creative assets revision");
    return this.draftStore.create({
      workspace: a.workspace,
      type: "creative-assets",
      source: "internal-ai",
      origin: t.origin ?? "desktop-ui",
      novelId: a.novelId,
      revisionOfDraftSessionId: a.draftSessionId,
      reviewRequestId: ((h = e.reviewRequestId) == null ? void 0 : h.trim()) || le(),
      status: "draft",
      payload: l,
      selection: Xt(l),
      validation: null,
      previewSummary: Dt(l)
    });
  }
  async updateDraft(e) {
    F(e == null ? void 0 : e.draftSessionId, "draftSessionId"), ce(e == null ? void 0 : e.version, "version");
    const t = await this.draftStore.getById(e.draftSessionId);
    if (!t)
      throw G("NOT_FOUND", "Draft session not found");
    if (t.status !== "draft")
      throw G("INVALID_STATE", "Only an active draft can be edited");
    const r = await this.draftStore.update(e.draftSessionId, e.version, (a) => {
      var s;
      return {
        ...a,
        payload: e.payload ?? a.payload,
        selection: e.selection ?? a.selection,
        validation: e.validation === void 0 ? a.validation : e.validation,
        previewSummary: a.type === "chapter-draft" ? `章节草稿 ${((s = (e.payload ?? a.payload).generatedText) == null ? void 0 : s.length) ?? 0} 字符` : Dt(Xe(e.payload ?? a.payload))
      };
    });
    if (t.draftBatchId && typeof t.childIndex == "number") {
      const a = await this.draftStore.getBatchById(t.draftBatchId), s = a == null ? void 0 : a.children[t.childIndex];
      a && (s == null ? void 0 : s.draftSessionId) === t.draftSessionId && t.childIndex < a.children.length - 1 && await this.draftStore.markBatchChildrenStale(
        a.draftBatchId,
        a.version,
        t.childIndex
      );
    }
    return r;
  }
  async discardDraft(e) {
    return F(e == null ? void 0 : e.draftSessionId, "draftSessionId"), ce(e == null ? void 0 : e.version, "version"), this.draftStore.update(e.draftSessionId, e.version, (t) => ({
      ...t,
      status: "discarded"
    }));
  }
  async validateCreativeDraftSession(e) {
    F(e == null ? void 0 : e.draftSessionId, "draftSessionId");
    const t = await this.draftStore.getById(e.draftSessionId);
    if (!t)
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    if (typeof e.version == "number" && t.version !== e.version)
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    if (t.type !== "creative-assets" && t.type !== "outline-draft")
      throw Object.assign(new Error("Only creative draft sessions can be validated"), { code: "INVALID_INPUT" });
    const r = await this.aiService.validateCreativeAssetsDraft({
      novelId: t.novelId,
      draft: Ln(Xe(t.payload), t.selection)
    });
    return {
      session: await this.draftStore.update(t.draftSessionId, t.version, (s) => ({
        ...s,
        validation: r,
        payload: r.normalizedDraft,
        selection: Xt(r.normalizedDraft),
        previewSummary: Dt(r.normalizedDraft)
      })),
      validation: r
    };
  }
  async commitDraft(e) {
    return this.serializeDraftBatchCommit(() => this.commitDraftSerialized(e));
  }
  async commitDraftSerialized(e) {
    var r;
    F(e == null ? void 0 : e.draftSessionId, "draftSessionId"), ce(e == null ? void 0 : e.version, "version");
    const t = await this.draftStore.getById(e.draftSessionId);
    if (!t)
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    if (t.version !== e.version)
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    if (t.type === "creative-assets" || t.type === "outline-draft") {
      const a = await this.aiService.validateCreativeAssetsDraft({
        novelId: t.novelId,
        draft: Ln(Xe(t.payload), t.selection)
      }), s = a.normalizedDraft, i = await this.draftStore.update(t.draftSessionId, t.version, (l) => ({
        ...l,
        payload: s,
        selection: Xt(s),
        validation: a,
        previewSummary: Dt(s)
      }));
      if (!a.ok)
        return {
          session: i,
          validation: a
        };
      const o = await this.aiService.confirmCreativeAssets({
        novelId: t.novelId,
        draft: s
      }), c = o.success && ((r = o.createdEntities) != null && r.length) ? {
        writebackId: le(),
        mode: "creative_assets",
        status: "committed",
        chapters: [],
        creativeAssets: {
          entities: o.createdEntities,
          created: o.created
        },
        committedAt: (/* @__PURE__ */ new Date()).toISOString()
      } : null;
      return {
        session: await this.draftStore.update(i.draftSessionId, i.version, (l) => ({
          ...l,
          status: o.success ? "committed" : "failed",
          validation: a,
          writebacks: c ? [...l.writebacks ?? [], c] : l.writebacks
        })),
        validation: a,
        confirmResult: o
      };
    }
    if (t.type === "chapter-draft") {
      if (t.draftBatchId)
        throw G(
          "INVALID_STATE",
          "Batch child drafts must be committed through draft.batch.commit_prefix",
          { draftBatchId: t.draftBatchId }
        );
      const a = t.payload, s = Zt(a.baseContent, a.generatedText), i = a.sourceSnapshot, o = (i == null ? void 0 : i.contentHash) ?? be("sha256").update(a.baseContent || "", "utf8").digest("hex"), c = Cr(s).length, { sourceChapter: d, updatedChapter: l } = await S.$transaction(async (p) => {
        const f = await p.chapter.findUnique({
          where: { id: a.chapterId },
          select: {
            id: !0,
            title: !0,
            content: !0,
            wordCount: !0,
            version: !0,
            deleted: !0,
            order: !0,
            volumeId: !0,
            volume: { select: { novelId: !0 } }
          }
        }), I = f ? be("sha256").update(f.content || "", "utf8").digest("hex") : "";
        if (!f || f.deleted || f.volume.novelId !== t.novelId || i && f.version !== i.version || I !== o)
          throw G(
            "VERSION_CONFLICT",
            "正文在草稿生成后已发生变化，请基于最新正文重新生成",
            { chapterId: a.chapterId }
          );
        const y = await p.chapter.update({
          where: { id: f.id },
          data: {
            content: s,
            wordCount: c,
            version: { increment: 1 },
            updatedAt: /* @__PURE__ */ new Date()
          }
        }), g = c - f.wordCount;
        return g !== 0 && await p.novel.update({
          where: { id: t.novelId },
          data: { wordCount: { increment: g }, updatedAt: /* @__PURE__ */ new Date() }
        }), { sourceChapter: f, updatedChapter: y };
      }), m = {
        writebackId: le(),
        mode: "single_chapter",
        status: "committed",
        chapters: [{
          chapterId: d.id,
          volumeId: d.volumeId,
          title: d.title,
          order: d.order,
          beforeContent: d.content,
          beforeWordCount: d.wordCount,
          beforeVersion: d.version,
          afterContentHash: be("sha256").update(l.content || "", "utf8").digest("hex"),
          afterVersion: l.version
        }],
        committedAt: (/* @__PURE__ */ new Date()).toISOString()
      }, h = await this.draftStore.update(t.draftSessionId, t.version, (p) => ({
        ...p,
        status: "committed",
        writebacks: [...p.writebacks ?? [], m],
        payload: {
          ...p.payload,
          content: s
        }
      }));
      return await Fe({
        id: l.id,
        title: l.title,
        content: l.content,
        volumeId: l.volumeId,
        order: l.order,
        novelId: t.novelId
      }), st(l.id), {
        session: h,
        saveResult: l
      };
    }
    throw Object.assign(new Error(`Unsupported draft type: ${t.type}`), { code: "INVALID_INPUT" });
  }
  async undoDraft(e) {
    return this.serializeDraftBatchCommit(async () => {
      var h;
      const t = F(e == null ? void 0 : e.draftSessionId, "draftSessionId"), r = ce(e == null ? void 0 : e.version, "version"), a = F(e == null ? void 0 : e.writebackId, "writebackId"), s = await this.draftStore.getById(t);
      if (!s)
        throw G("NOT_FOUND", "Draft session not found");
      if (s.version !== r)
        throw G("VERSION_CONFLICT", "Draft session version conflict");
      const i = [...s.writebacks ?? []].reverse().find((p) => p.status === "committed");
      if (!i || i.writebackId !== a)
        throw G("INVALID_STATE", "Only the latest writeback can be undone");
      if (i.mode === "creative_assets") {
        if (s.type !== "creative-assets" && s.type !== "outline-draft")
          throw G("INVALID_STATE", "Creative assets writeback belongs to another draft type");
        const { backgroundPaths: p } = await S.$transaction((g) => Ds(g, s.novelId, i)), f = (/* @__PURE__ */ new Date()).toISOString(), I = { ...i, status: "undone", undoneAt: f }, y = await this.draftStore.update(s.draftSessionId, s.version, (g) => ({
          ...g,
          status: "draft",
          writebacks: (g.writebacks ?? []).map((u) => u.writebackId === a ? I : u)
        }));
        for (const g of p)
          try {
            this.aiService.deleteGeneratedMapAsset(g);
          } catch (u) {
            Se("AutomationService.undoCreativeAssets.mapCleanup", u, {
              draftSessionId: t,
              backgroundPath: g
            });
          }
        return await Promise.allSettled((((h = i.creativeAssets) == null ? void 0 : h.entities) ?? []).flatMap((g) => g.kind === "mapCanvas" ? [] : [this.aiService.deleteRagSourceIndex(s.novelId, g.kind, g.entityId)])), { session: y, writeback: I };
      }
      if (i.mode !== "single_chapter")
        throw G("INVALID_STATE", "This writeback must be undone through its batch workflow");
      const o = i.chapters[0];
      if (!o)
        throw G("INVALID_STATE", "The writeback has no chapter snapshot");
      const c = await S.$transaction(async (p) => {
        const f = await p.chapter.findUnique({
          where: { id: o.chapterId },
          select: { id: !0, content: !0, wordCount: !0, version: !0, deleted: !0 }
        }), I = f ? be("sha256").update(f.content || "", "utf8").digest("hex") : "";
        if (!f || f.deleted || f.version !== o.afterVersion || I !== o.afterContentHash)
          throw G(
            "VERSION_CONFLICT",
            "正文已在写回后再次修改，无法安全撤销",
            { chapterId: o.chapterId }
          );
        const y = await p.chapter.update({
          where: { id: o.chapterId },
          data: {
            content: o.beforeContent,
            wordCount: o.beforeWordCount,
            version: { increment: 1 },
            updatedAt: /* @__PURE__ */ new Date()
          }
        }), g = o.beforeWordCount - f.wordCount;
        return g !== 0 && await p.novel.update({
          where: { id: s.novelId },
          data: { wordCount: { increment: g }, updatedAt: /* @__PURE__ */ new Date() }
        }), y;
      }), d = (/* @__PURE__ */ new Date()).toISOString(), l = { ...i, status: "undone", undoneAt: d }, m = await this.draftStore.update(s.draftSessionId, s.version, (p) => ({
        ...p,
        status: "draft",
        writebacks: (p.writebacks ?? []).map((f) => f.writebackId === a ? l : f),
        payload: p.type === "chapter-draft" ? {
          ...p.payload,
          sourceSnapshot: {
            chapterId: c.id,
            version: c.version,
            contentHash: be("sha256").update(c.content || "", "utf8").digest("hex")
          }
        } : p.payload
      }));
      return await Fe({
        id: c.id,
        title: c.title,
        content: c.content,
        volumeId: c.volumeId,
        order: c.order,
        novelId: s.novelId
      }), st(c.id), { session: m, writeback: l };
    });
  }
  async previewPrompt(e) {
    const t = mi(e == null ? void 0 : e.kind), r = this.buildPromptPreviewPayload(t, (e == null ? void 0 : e.payload) ?? {});
    let a;
    return t === "creative_assets" ? a = await this.aiService.previewCreativeAssetsPrompt(r) : a = await this.aiService.previewContinuePrompt(r), {
      kind: t,
      preview: a
    };
  }
  async applyPartialCreativeDraft(e) {
    F(e == null ? void 0 : e.novelId, "novelId");
    const t = await this.aiService.validateCreativeAssetsDraft({
      novelId: e.novelId,
      draft: Xe(e.draft)
    });
    if (!t.ok)
      return { validation: t };
    const r = await this.aiService.confirmCreativeAssets({
      novelId: e.novelId,
      draft: t.normalizedDraft
    });
    return { validation: t, confirmResult: r };
  }
  async invoke(e, t, r) {
    return this.withTimeout(e, t, r, async () => {
      switch (e) {
        case "agent.generate_chat":
          return this.aiService.generateAgentChat(t, r.signal);
        case "agent.generate_plan":
          return this.aiService.generateAgentPlan(t, r.signal);
        case "agent.revise_plan":
          return this.aiService.reviseAgentPlan(t, r.signal);
        case "agent.generate_report":
          return this.aiService.generateAgentReport(t, r.signal);
        case "agent.generate_consistency_review":
          return this.aiService.generateAgentConsistencyReview(t, r.signal);
        case "agent.generate_editor_range_review":
          return this.aiService.generateAgentEditorRangeReview(t, r.signal);
        case "agent.generate_writer_range_revision_plan":
          return this.aiService.generateAgentWriterRangeRevisionPlan(t, r.signal);
        case "agent.generate_reader_chapter_evaluation":
          return this.aiService.generateAgentReaderChapterEvaluation(t, r.signal);
        case "agent.generate_worldbuilding_range_consistency":
          return this.aiService.generateAgentWorldbuildingRangeConsistency(t, r.signal);
        case "agent.extract_research_claims":
          return this.aiService.extractAgentResearchClaims(t, r.signal);
        case "agent.generate_research_fact_check":
          return this.aiService.generateAgentResearchFactCheck(t, r.signal);
        case "agent.generate_scope_audit":
          return this.aiService.generateAgentScopeAudit(t, r.signal);
        case "agent.generate_plotline_analysis":
          return this.aiService.generateAgentPlotlineAnalysis(t, r.signal);
        case "agent.detect_creative_direction":
          return this.aiService.detectAgentCreativeDirection(t, r.signal);
        case "agent.generate_chapter_beats":
          return this.aiService.generateChapterBeats(t, r.signal);
        case "artifact.review.submit":
          return this.reviewStore.submitArtifactReview(t);
        case "review.comment.list":
          return this.reviewCommentStore.list(t);
        case "review.comment.save":
          return this.reviewCommentStore.save(t);
        case "review.comment.delete":
          return this.reviewCommentStore.delete(t == null ? void 0 : t.commentId);
        case "review.comment.mark_sent":
          return this.reviewCommentStore.markSent(t);
        case "revision_task.list":
          return this.reviewStore.listRevisionTasks(t);
        case "revision_task.create_plan":
          return this.createRevisionTaskPlan(t, r);
        case "revision_task.update_status":
          return this.reviewStore.updateRevisionTaskStatus(t);
        case "revision_task.sync_run":
          return this.reviewStore.syncRevisionTasksFromRun(t);
        case "rag.ask":
          return this.aiService.askNovel(t, r.signal);
        case "attachment.list":
          return (await this.attachmentStore.list(
            F(t == null ? void 0 : t.novelId, "novelId"),
            F(t == null ? void 0 : t.conversationId, "conversationId")
          )).filter((a) => !!a.messageId);
        case "attachment.get":
          return this.attachmentStore.readWindow({
            novelId: F(t == null ? void 0 : t.novelId, "novelId"),
            conversationId: F(t == null ? void 0 : t.conversationId, "conversationId"),
            attachmentId: F(t == null ? void 0 : t.attachmentId, "attachmentId"),
            offset: t == null ? void 0 : t.offset,
            limit: t == null ? void 0 : t.limit
          });
        case "attachment.read":
          return this.attachmentStore.read({
            novelId: F(t == null ? void 0 : t.novelId, "novelId"),
            conversationId: F(t == null ? void 0 : t.conversationId, "conversationId"),
            attachmentId: F(t == null ? void 0 : t.attachmentId, "attachmentId"),
            selector: t == null ? void 0 : t.selector
          });
        case "attachment.outline":
          return this.attachmentStore.outline(
            F(t == null ? void 0 : t.novelId, "novelId"),
            F(t == null ? void 0 : t.conversationId, "conversationId"),
            F(t == null ? void 0 : t.attachmentId, "attachmentId")
          );
        case "attachment.search":
          return this.attachmentStore.search({
            novelId: F(t == null ? void 0 : t.novelId, "novelId"),
            conversationId: F(t == null ? void 0 : t.conversationId, "conversationId"),
            query: F(t == null ? void 0 : t.query, "query"),
            attachmentId: typeof (t == null ? void 0 : t.attachmentId) == "string" ? t.attachmentId : void 0,
            limit: t == null ? void 0 : t.limit
          });
        case "draft.list":
          return this.listDrafts(t);
        case "draft.get":
          return this.getDraft(F(t == null ? void 0 : t.draftSessionId, "draftSessionId"));
        case "draft.get_active":
          return this.getActiveDraft(t);
        case "draft.update":
          return this.updateDraft(t);
        case "draft.commit":
          return this.commitDraft(t);
        case "draft.undo":
          return this.undoDraft(t);
        case "draft.discard":
          return this.discardDraft(t);
        case "draft.batch.list":
          return this.listDraftBatches(t);
        case "draft.batch.get":
          return this.getDraftBatch(F(t == null ? void 0 : t.draftBatchId, "draftBatchId"));
        case "draft.batch.create":
          return this.createDraftBatch(t);
        case "draft.batch.update_outline":
          return this.updateDraftBatchOutline(t);
        case "draft.batch.approve_outline":
          return this.approveDraftBatchOutline(t);
        case "draft.batch.attach_child":
          return this.attachDraftBatchChild(t);
        case "draft.batch.mark_stale_after":
          return this.markDraftBatchStaleAfter(t);
        case "draft.batch.prepare_regeneration":
          return this.prepareDraftBatchRegeneration(t);
        case "draft.batch.mark_failed":
          return this.markDraftBatchChildFailed(t);
        case "draft.batch.inspect_reconciliation":
          return this.inspectDraftBatchReconciliation(t);
        case "draft.batch.reconcile_unknown":
          return this.reconcileDraftBatchUnknown(t);
        case "draft.batch.commit_prefix":
          return this.commitDraftBatchPrefix(t);
        case "draft.batch.undo":
          return this.undoDraftBatch(t);
        case "draft.batch.discard":
          return this.discardDraftBatch(t);
        case "creative_assets.generate_draft":
          return this.generateCreativeAssetsDraft(t, r, "creative-assets");
        case "creative_assets.revise_draft":
          return this.reviseCreativeAssetsDraftSession(t, r);
        case "outline.generate_draft":
          return this.generateCreativeAssetsDraft({
            ...t,
            targetSections: ["plotLines", "plotPoints"]
          }, r, "outline-draft");
        case "chapter.generate_draft":
          return this.createChapterDraftSession(t, r);
        case "chapter.revise_draft":
          return this.reviseChapterDraftSession(t, r);
        case "creative_assets.validate_draft":
          return this.validateCreativeDraftSession(t);
        case "outline.write":
          return this.applyPartialCreativeDraft({
            novelId: F(t == null ? void 0 : t.novelId, "novelId"),
            draft: li(t)
          });
        case "character.create_batch":
          return this.applyPartialCreativeDraft({
            novelId: F(t == null ? void 0 : t.novelId, "novelId"),
            draft: ui(t)
          });
        case "story_patch.apply":
          return this.applyPartialCreativeDraft({
            novelId: F(t == null ? void 0 : t.novelId, "novelId"),
            draft: Xe(t == null ? void 0 : t.draft)
          });
        case "prompt.preview":
          return this.previewPrompt(t);
        default:
          return this.aiService.executeAction({
            actionId: e,
            payload: t
          });
      }
    });
  }
}
class pi {
  constructor(e, t, r) {
    H(this, "automationService");
    H(this, "getUserDataPath");
    H(this, "onDataChanged");
    H(this, "server", null);
    H(this, "runtime", null);
    H(this, "activeRequests", /* @__PURE__ */ new Map());
    this.automationService = e, this.getUserDataPath = t, this.onDataChanged = r;
  }
  notifyDataChanged(e) {
    var r;
    (/* @__PURE__ */ new Set([
      "outline.write",
      "character.create_batch",
      "story_patch.apply",
      "worldsetting.create",
      "worldsetting.update",
      "chapter.create",
      "chapter.save",
      "creative_assets.generate_draft",
      "creative_assets.revise_draft",
      "creative_assets.validate_draft",
      "outline.generate_draft",
      "chapter.generate_draft",
      "chapter.revise_draft",
      "draft.update",
      "draft.commit",
      "draft.undo",
      "draft.discard",
      "draft.batch.create",
      "draft.batch.update_outline",
      "draft.batch.approve_outline",
      "draft.batch.attach_child",
      "draft.batch.mark_stale_after",
      "draft.batch.prepare_regeneration",
      "draft.batch.mark_failed",
      "draft.batch.reconcile_unknown",
      "draft.batch.commit_prefix",
      "draft.batch.undo",
      "draft.batch.discard",
      "artifact.review.submit",
      "revision_task.create_plan"
    ])).has(e) && ((r = this.onDataChanged) == null || r.call(this, e));
  }
  getAutomationDir() {
    return D.join(this.getUserDataPath(), "automation");
  }
  getRuntimePath() {
    return D.join(this.getAutomationDir(), "runtime.json");
  }
  async writeRuntime() {
    this.runtime && (await Te.mkdir(this.getAutomationDir(), { recursive: !0 }), await Te.writeFile(this.getRuntimePath(), JSON.stringify(this.runtime, null, 2), "utf8"));
  }
  async removeRuntime() {
    try {
      await Te.unlink(this.getRuntimePath());
    } catch (e) {
      if ((e == null ? void 0 : e.code) !== "ENOENT")
        throw e;
    }
  }
  sendJson(e, t, r) {
    const a = JSON.stringify(r);
    e.writeHead(t, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(a, "utf8")
    }), e.end(a);
  }
  async readJson(e) {
    const t = [];
    for await (const a of e)
      t.push(Buffer.isBuffer(a) ? a : Buffer.from(a));
    const r = Buffer.concat(t).toString("utf8");
    return r ? JSON.parse(r) : {};
  }
  normalizeError(e) {
    return {
      code: (e == null ? void 0 : e.code) || "INTERNAL_ERROR",
      message: (e == null ? void 0 : e.message) || "Internal automation error",
      details: e == null ? void 0 : e.details
    };
  }
  isAuthorized(e) {
    return this.runtime ? (e.headers.authorization || "") === `Bearer ${this.runtime.token}` : !1;
  }
  async start() {
    if (this.server)
      return;
    this.runtime = {
      version: 1,
      port: 0,
      token: le(),
      pid: process.pid,
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    }, this.server = ar.createServer(async (t, r) => {
      try {
        if (t.url === "/health") {
          this.sendJson(r, 200, { ok: !0, code: "OK", message: "healthy", data: { pid: process.pid } });
          return;
        }
        if (!this.isAuthorized(t)) {
          this.sendJson(r, 401, { ok: !1, code: "UNAUTHORIZED", message: "Unauthorized" });
          return;
        }
        if (t.method === "POST" && t.url === "/invoke") {
          const a = await this.readJson(t), s = typeof a.requestId == "string" && a.requestId.trim() ? a.requestId.trim() : le(), i = Date.now();
          $("INFO", "AutomationServer.invoke.start", "Automation HTTP invoke start", {
            requestId: s,
            method: a.method,
            origin: a.origin ?? "mcp-bridge",
            params: ve(a.params)
          });
          const o = new AbortController();
          this.activeRequests.set(s, o);
          let c;
          try {
            c = await this.automationService.invoke(a.method, a.params, {
              source: "http",
              origin: a.origin ?? "mcp-bridge",
              requestId: s,
              signal: o.signal
            });
          } finally {
            this.activeRequests.get(s) === o && this.activeRequests.delete(s);
          }
          $("INFO", "AutomationServer.invoke.success", "Automation HTTP invoke success", {
            requestId: s,
            method: a.method,
            elapsedMs: Date.now() - i,
            result: ve(c)
          }), this.notifyDataChanged(String(a.method || "")), this.sendJson(r, 200, { ok: !0, code: "OK", message: "ok", data: c });
          return;
        }
        if (t.method === "POST" && t.url === "/cancel") {
          const a = await this.readJson(t), s = typeof a.requestId == "string" ? a.requestId.trim() : "";
          if (!s) {
            this.sendJson(r, 400, { ok: !1, code: "INVALID_INPUT", message: "requestId is required" });
            return;
          }
          const i = this.activeRequests.get(s);
          i == null || i.abort(new Error("Automation request cancelled")), this.sendJson(r, 200, {
            ok: !0,
            code: "OK",
            message: i ? "cancelled" : "request not active",
            data: { requestId: s, cancelled: !!i }
          });
          return;
        }
        this.sendJson(r, 404, { ok: !1, code: "NOT_FOUND", message: "Not found" });
      } catch (a) {
        const s = this.normalizeError(a);
        Se("AutomationServer.invoke.error", a, {
          url: t.url,
          method: t.method
        }), this.sendJson(r, 500, {
          ok: !1,
          code: s.code,
          message: s.message,
          data: s.details
        });
      }
    }), await new Promise((t, r) => {
      this.server.once("error", r), this.server.listen(0, "127.0.0.1", () => t());
    });
    const e = this.server.address();
    if (!e || typeof e == "string")
      throw new Error("Failed to resolve automation server port");
    this.runtime.port = e.port, await this.writeRuntime();
  }
  async stop() {
    for (const e of this.activeRequests.values())
      e.abort(new Error("Automation server stopped"));
    this.activeRequests.clear(), await this.removeRuntime(), this.server && (await new Promise((e, t) => {
      this.server.close((r) => {
        r ? t(r) : e();
      });
    }), this.server = null, this.runtime = null);
  }
}
const gi = /* @__PURE__ */ new Set(["run_completed", "run_failed", "run_cancelled"]);
function Ii(n) {
  const e = n.split(/\r?\n/);
  let t = "message";
  const r = [];
  for (const a of e)
    if (!(!a || a.startsWith(":"))) {
      if (a.startsWith("event:")) {
        t = a.slice(6).trim();
        continue;
      }
      a.startsWith("data:") && r.push(a.slice(5).trimStart());
    }
  return r.length === 0 ? null : { eventName: t, data: r.join(`
`) };
}
function vi(n, e) {
  const r = `${n}${e}`.replace(/\r\n/g, `
`).split(`

`);
  return {
    buffer: r.pop() || "",
    frames: r.map(Ii).filter((s) => s !== null)
  };
}
function yi(n) {
  return gi.has(n);
}
function wi(n) {
  const e = Number.isFinite(n.afterSequence) ? Number(n.afterSequence) : 0, t = `/events/${encodeURIComponent(n.runId)}?afterSequence=${encodeURIComponent(String(e))}`;
  let r = !1, a = !1, s = null;
  const i = (o) => {
    r || a || (a = !0, n.onDisconnect({ runId: n.runId, message: o }));
  };
  return s = ar.request(
    {
      hostname: "127.0.0.1",
      port: n.port,
      path: t,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${n.token}`
      }
    },
    (o) => {
      if (o.statusCode && o.statusCode >= 400) {
        const d = `Agent event stream failed with status ${o.statusCode}`;
        i(d), o.resume();
        return;
      }
      o.setEncoding("utf8");
      let c = "";
      o.on("data", (d) => {
        var m;
        const l = vi(c, d);
        c = l.buffer;
        for (const h of l.frames)
          if (h.eventName === "agent_run_event")
            try {
              const p = JSON.parse(h.data);
              n.onEvent(p), yi(p.type) && (r = !0, s == null || s.destroy());
            } catch (p) {
              (m = n.onParseError) == null || m.call(n, p);
            }
      }), o.on("end", () => {
        i("Agent event stream ended");
      }), o.on("error", (d) => {
        i(d.message || "Agent event stream error");
      });
    }
  ), s.on("error", (o) => {
    i(o.message || "Agent event stream error");
  }), s.end(), () => {
    r = !0, s == null || s.destroy();
  };
}
const Si = 3, Mn = 1e3;
function Ai(n) {
  const e = n.consecutiveFailures + 1, t = e >= Si && n.activeInvocations === 0 && !n.autoRestartAttempted;
  return {
    availability: t ? "recovering" : "slow",
    consecutiveFailures: e,
    shouldAutoRestart: t
  };
}
const Gt = 6e4, Ei = 500, Pn = 15e3, Un = "@@NOVEL_AGENT_PROGRESS@@", Ti = /* @__PURE__ */ new Set([
  "idle",
  "starting_python",
  "loading_modules",
  "loading_web_server",
  "loading_graph_engine",
  "loading_tool_protocol",
  "loading_runtime",
  "initializing_state",
  "loading_tools",
  "restoring_state",
  "starting_server",
  "ready",
  "failed"
]);
function $n() {
  return process.env.APP_ROOT ? D.resolve(process.env.APP_ROOT, "../..") : process.cwd();
}
function Ci() {
  return new Promise((n, e) => {
    const t = Qa.createServer();
    t.once("error", e), t.listen(0, "127.0.0.1", () => {
      const r = t.address();
      t.close(() => {
        if (!r || typeof r == "string") {
          e(new Error("Failed to resolve free port"));
          return;
        }
        n(r.port);
      });
    });
  });
}
function Ni(n) {
  return Object.assign(new Error(`Agent runtime port unavailable: ${n}`), {
    code: "AGENT_RUNTIME_PORT_UNAVAILABLE"
  });
}
function _a(n) {
  if (!Number.isInteger(n) || n <= 0)
    throw Ni(n);
}
function Ot(n, e, t, r, a = 8e3) {
  _a(n);
  const s = r ? JSON.stringify(r) : "";
  return new Promise((i, o) => {
    const c = ar.request(
      {
        hostname: "127.0.0.1",
        port: n,
        path: e,
        method: r ? "POST" : "GET",
        headers: {
          ...r ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(s, "utf8")
          } : {},
          ...t ? { Authorization: `Bearer ${t}` } : {}
        }
      },
      (d) => {
        const l = [];
        d.on("data", (m) => l.push(Buffer.isBuffer(m) ? m : Buffer.from(m))), d.on("end", () => {
          const m = Buffer.concat(l).toString("utf8");
          try {
            i(m ? JSON.parse(m) : { ok: !1, code: "EMPTY_RESPONSE", message: "Empty response" });
          } catch (h) {
            o(new Error(`Agent response parse failed: ${(h == null ? void 0 : h.message) || "unknown error"}`));
          }
        });
      }
    );
    c.setTimeout(a, () => c.destroy(new Error("Agent runtime request timeout"))), c.on("error", o), s && c.write(s), c.end();
  });
}
function bi(n) {
  const e = typeof n == "object" && n !== null && "code" in n ? String(n.code || "") : "";
  return ["ECONNREFUSED", "ECONNRESET", "EPIPE", "AGENT_RUNTIME_PORT_UNAVAILABLE"].includes(e);
}
function xi(n) {
  if (typeof n != "object" || n === null || !("port" in n))
    return 0;
  const e = Number(n.port);
  return Number.isInteger(e) && e > 0 ? e : 0;
}
class _i {
  constructor(e) {
    H(this, "getUserDataPath");
    H(this, "getAutomationRuntimePath");
    H(this, "isPackaged");
    H(this, "process", null);
    H(this, "port", 0);
    H(this, "token", "");
    H(this, "startPromise", null);
    H(this, "recoveryPromise", null);
    H(this, "disabledReason", null);
    H(this, "phase", "idle");
    H(this, "availability", "starting");
    H(this, "consecutiveHealthFailures", 0);
    H(this, "activeInvocations", 0);
    H(this, "autoRestartAttempted", !1);
    H(this, "startupStartedAt", 0);
    H(this, "phaseChangedAt", Date.now());
    H(this, "lastStartupError", "");
    this.getUserDataPath = e.getUserDataPath, this.getAutomationRuntimePath = e.getAutomationRuntimePath, this.isPackaged = e.isPackaged;
  }
  prewarm() {
    $("INFO", "PythonRuntimeClient.prewarm", "Prewarming Python Agent runtime in background"), this.startInBackground();
  }
  async health() {
    if (this.recoveryPromise || this.startPromise)
      return this.statusSnapshot();
    if (this.availability === "failed")
      return this.statusSnapshot();
    if (this.phase !== "ready" || !this.process || this.port <= 0)
      return this.startInBackground(), this.statusSnapshot();
    try {
      const e = await Ot(this.port, "/health", this.token, void 0, 2e3);
      if (!e.ok)
        throw Object.assign(new Error(e.message || "Agent runtime health check failed"), {
          code: e.code || "AGENT_RUNTIME_HEALTH_FAILED"
        });
      return this.markHealthy(), {
        ...e,
        data: {
          ...e.data && typeof e.data == "object" ? e.data : {},
          ...this.statusData()
        }
      };
    } catch (e) {
      return this.recordHealthProbeFailure(e);
    }
  }
  startInBackground() {
    this.availability !== "failed" && (this.startPromise || this.recoveryPromise || this.beginRecovery({ kind: "initial", forceRestart: !1, allowAutomaticRetry: !0 }));
  }
  recordHealthProbeFailure(e) {
    const t = e instanceof Error ? e.message : String(e);
    this.lastStartupError = t;
    const r = Ai({
      consecutiveFailures: this.consecutiveHealthFailures,
      activeInvocations: this.activeInvocations,
      autoRestartAttempted: this.autoRestartAttempted
    });
    return this.consecutiveHealthFailures = r.consecutiveFailures, this.availability = r.availability, $("WARN", "PythonRuntimeClient.health.slow", "Agent runtime health probe failed", {
      consecutiveFailures: this.consecutiveHealthFailures,
      activeInvocations: this.activeInvocations,
      shouldAutoRestart: r.shouldAutoRestart,
      error: t
    }), r.shouldAutoRestart && (this.autoRestartAttempted = !0, this.beginRecovery({
      kind: "automatic",
      forceRestart: !0,
      allowAutomaticRetry: !1,
      delayMs: Mn
    })), this.statusSnapshot();
  }
  statusData() {
    const e = Date.now();
    return {
      phase: this.phase,
      elapsedMs: this.startupStartedAt > 0 ? Math.max(0, e - this.startupStartedAt) : 0,
      phaseElapsedMs: Math.max(0, e - this.phaseChangedAt),
      port: this.phase === "ready" ? this.port : void 0,
      availability: this.availability,
      consecutiveHealthFailures: this.consecutiveHealthFailures,
      activeInvocations: this.activeInvocations,
      autoRestartAttempted: this.autoRestartAttempted,
      recovering: this.availability === "recovering",
      canManualRetry: this.availability === "failed"
    };
  }
  statusSnapshot() {
    const e = this.availability === "ready" || this.availability === "slow";
    let t, r;
    switch (this.availability) {
      case "ready":
        r = "Agent runtime is ready";
        break;
      case "slow":
        t = "AGENT_RUNTIME_SLOW", r = this.lastStartupError || "Agent runtime is responding slowly";
        break;
      case "recovering":
        t = "AGENT_RUNTIME_RECOVERING", r = "Agent runtime is recovering";
        break;
      case "failed":
        t = "AGENT_RUNTIME_UNAVAILABLE", r = this.lastStartupError || this.disabledReason || "Agent runtime unavailable";
        break;
      default:
        t = "AGENT_RUNTIME_STARTING", r = "Agent runtime is starting";
    }
    return {
      ok: e,
      ...t ? { code: t } : {},
      message: r,
      data: this.statusData()
    };
  }
  markHealthy() {
    this.availability = "ready", this.consecutiveHealthFailures = 0, this.autoRestartAttempted = !1, this.disabledReason = null, this.lastStartupError = "", this.phase !== "ready" && this.setPhase("ready");
  }
  setPhase(e, t = "") {
    if (e === "starting_python" && this.phase !== "starting_python" && (this.startupStartedAt = Date.now(), this.lastStartupError = ""), e === "failed" && (this.availability = "failed"), this.phase !== e) {
      const r = this.phase;
      this.phase = e, this.phaseChangedAt = Date.now(), $(
        e === "failed" ? "ERROR" : "INFO",
        "PythonRuntimeClient.phase",
        "Agent runtime phase changed",
        {
          previousPhase: r,
          phase: e,
          elapsedMs: this.startupStartedAt > 0 ? Date.now() - this.startupStartedAt : 0
        }
      );
    }
    t ? (this.lastStartupError = t, this.disabledReason = t) : e === "ready" && (this.availability = "ready", this.consecutiveHealthFailures = 0, this.autoRestartAttempted = !1, this.disabledReason = null, this.lastStartupError = "");
  }
  applyProgressLine(e) {
    if (!e.startsWith(Un))
      return !1;
    try {
      const t = JSON.parse(e.slice(Un.length)), r = String(t.phase || "");
      Ti.has(r) && this.setPhase(r);
    } catch (t) {
      $("WARN", "PythonRuntimeClient.progress.parse", "Failed to parse Agent runtime startup progress", {
        line: e,
        error: t instanceof Error ? t.message : String(t)
      });
    }
    return !0;
  }
  async invoke(e, t) {
    this.activeInvocations += 1;
    try {
      const r = await this.ensureReady();
      if (!r.ok)
        throw Object.assign(new Error(r.message || "Agent runtime unavailable"), {
          code: r.code || "AGENT_RUNTIME_UNAVAILABLE",
          details: r.data
        });
      try {
        return await this.invokeOnce(e, t);
      } catch (a) {
        if (!bi(a))
          throw a;
        const s = xi(a);
        $("WARN", "PythonRuntimeClient.invoke.retry", "Agent runtime connection failed; recovering once", {
          error: a instanceof Error ? a.message : String(a),
          port: this.port,
          failedPort: s
        });
        const i = await this.beginRecovery({
          kind: "connection",
          forceRestart: !0,
          allowAutomaticRetry: !1,
          failedPort: s
        });
        if (!i.ok)
          throw Object.assign(new Error(i.message || "Agent runtime recovery failed"), {
            code: i.code || "AGENT_RUNTIME_UNAVAILABLE",
            details: i.data
          });
        return this.invokeOnce(e, t);
      }
    } finally {
      this.activeInvocations = Math.max(0, this.activeInvocations - 1);
    }
  }
  async invokeOnce(e, t) {
    const r = this.port, a = this.token, s = e.requestId || le();
    let i = 0, o = !1;
    const c = async () => {
      var l;
      if (!(!t || o)) {
        o = !0;
        try {
          const h = ((l = (await Ot(r, `/progress/${encodeURIComponent(s)}?afterSequence=${i}`, a, void 0, 2e3)).data) == null ? void 0 : l.events) || [];
          for (const p of h)
            Number(p.sequence) > i && (i = Number(p.sequence), t(p));
        } catch {
        } finally {
          o = !1;
        }
      }
    }, d = t ? setInterval(() => void c(), 300) : void 0;
    try {
      const l = await Ot(
        r,
        "/invoke",
        a,
        {
          requestId: s,
          method: e.method,
          params: e.params || {},
          context: e.context || {}
        },
        18e4
      );
      for (d && clearInterval(d); o; )
        await new Promise((m) => setTimeout(m, 10));
      if (await c(), this.markHealthy(), !l.ok)
        throw Object.assign(new Error(l.message || "Agent runtime failed"), {
          code: l.code || "AGENT_RUNTIME_ERROR",
          details: l.data
        });
      return l.data;
    } finally {
      d && clearInterval(d);
    }
  }
  async cancelRequest(e) {
    var a;
    const t = String(e || "").trim();
    if (!t || this.port <= 0)
      return !1;
    const r = await Ot(
      this.port,
      "/cancel",
      this.token,
      { requestId: t },
      1e4
    );
    return !!(r.ok && ((a = r.data) != null && a.cancelled));
  }
  async subscribeRunEvents(e, t, r, a) {
    const s = await this.ensureReady();
    if (!s.ok)
      throw Object.assign(new Error(s.message || "Agent runtime unavailable"), {
        code: s.code || "AGENT_RUNTIME_UNAVAILABLE",
        details: s.data
      });
    const i = this.port, o = this.token;
    _a(i), this.activeInvocations += 1;
    let c = !1;
    const d = () => {
      c || (c = !0, this.activeInvocations = Math.max(0, this.activeInvocations - 1));
    };
    try {
      const l = wi({
        port: i,
        token: o,
        runId: e,
        afterSequence: t.afterSequence,
        onEvent: r,
        onDisconnect: (m) => {
          d(), a(m);
        },
        onParseError: (m) => {
          $("WARN", "PythonRuntimeClient.sse.parse", "Failed to parse Agent SSE event", {
            runId: e,
            error: m instanceof Error ? m.message : String(m)
          });
        }
      });
      return this.markHealthy(), () => {
        d(), l();
      };
    } catch (l) {
      throw d(), l;
    }
  }
  async stop() {
    if (this.port = 0, this.token = "", !this.process)
      return;
    const e = this.process;
    this.process = null, e.kill();
  }
  async ensureReady() {
    return this.recoveryPromise ? this.recoveryPromise : this.phase === "ready" && this.process && this.port > 0 && (this.availability === "ready" || this.availability === "slow") ? this.statusSnapshot() : this.beginRecovery({
      kind: "request",
      forceRestart: !!(this.process || this.port > 0 || this.availability === "failed"),
      allowAutomaticRetry: !1
    });
  }
  async restart() {
    return this.beginRecovery({
      kind: "manual",
      forceRestart: !0,
      allowAutomaticRetry: !1
    });
  }
  beginRecovery(e) {
    if (this.recoveryPromise)
      return this.recoveryPromise;
    const t = (async () => {
      const r = e.kind === "initial" && !e.forceRestart;
      this.availability = r ? "starting" : "recovering", $("INFO", "PythonRuntimeClient.recovery.start", "Agent runtime recovery started", {
        kind: e.kind,
        forceRestart: e.forceRestart,
        activeInvocations: this.activeInvocations,
        consecutiveHealthFailures: this.consecutiveHealthFailures
      });
      try {
        if (e.delayMs && await new Promise((a) => setTimeout(a, e.delayMs)), e.kind === "automatic" && this.activeInvocations > 0)
          return this.availability = "slow", this.autoRestartAttempted = !1, $("INFO", "PythonRuntimeClient.recovery.deferred", "Skipped automatic restart while calls are active", {
            activeInvocations: this.activeInvocations
          }), this.statusSnapshot();
        if (e.failedPort && this.port > 0 && this.port !== e.failedPort && this.phase === "ready" && this.process)
          return this.markHealthy(), this.statusSnapshot();
        e.forceRestart && await this.stop();
        try {
          await this.ensureStarted();
        } catch (a) {
          if (!e.allowAutomaticRetry || this.autoRestartAttempted)
            throw a;
          this.autoRestartAttempted = !0, this.availability = "recovering", await new Promise((s) => setTimeout(s, Mn)), await this.stop(), await this.ensureStarted();
        }
        return this.markHealthy(), $("INFO", "PythonRuntimeClient.recovery.ready", "Agent runtime recovery completed", {
          kind: e.kind,
          port: this.port
        }), this.statusSnapshot();
      } catch (a) {
        const s = a instanceof Error ? a.message : String(a);
        return this.setPhase("failed", s), Se("PythonRuntimeClient.recovery.failed", a, { kind: e.kind }), this.statusSnapshot();
      }
    })();
    return this.recoveryPromise = t, t.then(
      () => {
        this.recoveryPromise === t && (this.recoveryPromise = null);
      },
      () => {
        this.recoveryPromise === t && (this.recoveryPromise = null);
      }
    ), t;
  }
  async ensureStarted() {
    if (this.startPromise)
      return this.startPromise;
    if (!(this.process && this.port > 0 && this.phase === "ready")) {
      (this.process || this.port > 0) && await this.stop(), this.startPromise = this.start();
      try {
        await this.startPromise;
      } finally {
        this.startPromise = null;
      }
    }
  }
  resolvePythonCommand() {
    const e = process.env.NOVEL_AGENT_PYTHON;
    if (e && re.existsSync(e))
      return { command: e, argsPrefix: ["-m", "novel_agent_runtime"] };
    if (this.isPackaged) {
      const a = process.platform === "win32" ? "novel-agent-runtime.exe" : "novel-agent-runtime", s = D.join(process.resourcesPath, "agent-runtime", a);
      if (re.existsSync(s))
        return { command: s, argsPrefix: [] };
      throw new Error(`Packaged Agent runtime missing: ${s}`);
    }
    const t = $n(), r = D.join(t, "agent_runtime", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    return re.existsSync(r) ? { command: r, argsPrefix: ["-m", "novel_agent_runtime"] } : { command: process.platform === "win32" ? "python" : "python3", argsPrefix: ["-m", "novel_agent_runtime"] };
  }
  async start() {
    this.setPhase("starting_python");
    const e = await Ci(), t = le();
    this.port = e, this.token = t;
    const r = D.join(this.getUserDataPath(), "agent");
    re.mkdirSync(r, { recursive: !0 });
    const { command: a, argsPrefix: s } = this.resolvePythonCommand(), i = [
      ...s,
      "--port",
      String(e),
      "--token",
      t,
      "--automation-runtime",
      this.getAutomationRuntimePath(),
      "--state-dir",
      r
    ];
    $("INFO", "PythonRuntimeClient.start", "Starting Python Agent runtime", {
      command: a,
      args: ve(i),
      port: e
    });
    const o = jr(a, i, {
      cwd: this.isPackaged ? D.dirname(a) : D.join($n(), "agent_runtime"),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        LANGGRAPH_STRICT_MSGPACK: "true"
      },
      windowsHide: !0
    });
    this.process = o, this.setPhase("loading_modules");
    let c = null, d = null, l = "";
    $("INFO", "PythonRuntimeClient.start.spawned", "Python Agent runtime process spawned", {
      pid: o.pid,
      port: e
    }), o.stdout.on("data", (m) => {
      l += String(m);
      const h = l.split(/\r?\n/u);
      l = h.pop() || "";
      for (const p of h)
        !p || this.applyProgressLine(p) || $("INFO", "PythonRuntimeClient.stdout", "Agent runtime stdout", { text: p.slice(0, 1e3) });
    }), o.stderr.on("data", (m) => {
      $("WARN", "PythonRuntimeClient.stderr", "Agent runtime stderr", { text: String(m).slice(0, 1e3) });
    }), o.on("exit", (m, h) => {
      c = { code: m, signal: h }, $("WARN", "PythonRuntimeClient.exit", "Agent runtime exited", { code: m, signal: h, pid: o.pid, port: e }), this.process === o && (this.process = null, this.port = 0, this.token = "", this.availability = "starting", this.setPhase("idle"));
    }), o.on("error", (m) => {
      if (d = m, this.disabledReason = m.message, this.process !== o) {
        Se("PythonRuntimeClient.process.error", m);
        return;
      }
      this.process = null, this.port = 0, this.token = "", this.setPhase("failed", m.message), Se("PythonRuntimeClient.process.error", m);
    });
    try {
      await this.waitForHealth(e, t, () => c, () => d), this.markHealthy();
    } catch (m) {
      throw this.setPhase("failed", m instanceof Error ? m.message : String(m)), this.process === o ? await this.stop() : o.kill(), m;
    }
  }
  async waitForHealth(e, t, r, a) {
    const s = Date.now();
    let i = Pn, o;
    for (; Date.now() - s < Gt; ) {
      const d = a == null ? void 0 : a();
      if (d)
        throw d;
      const l = r == null ? void 0 : r();
      if (l)
        throw Object.assign(
          new Error(`Agent runtime exited before health check passed: code=${l.code ?? "null"} signal=${l.signal ?? "null"}`),
          { code: "AGENT_RUNTIME_EXITED_DURING_STARTUP", details: l }
        );
      try {
        const h = await Ot(e, "/health", t, void 0, 2e3);
        if (h.ok)
          return;
        o = new Error(h.message || "Agent runtime health failed");
      } catch (h) {
        o = h;
      }
      const m = Date.now() - s;
      m >= i && ($("WARN", "PythonRuntimeClient.start.waiting", "Python Agent runtime is still starting", {
        port: e,
        elapsedMs: m,
        timeoutMs: Gt,
        lastError: o instanceof Error ? o.message : String(o || "")
      }), i += Pn), await new Promise((h) => setTimeout(h, Ei));
    }
    const c = o instanceof Error ? o.message : String(o || "unknown error");
    throw Object.assign(
      new Error(`Agent runtime did not become healthy within ${Gt / 1e3}s. Last health error: ${c}`),
      {
        code: "AGENT_RUNTIME_STARTUP_TIMEOUT",
        details: { port: e, timeoutMs: Gt, lastMessage: c }
      }
    );
  }
}
function Be(n) {
  if (!n)
    return null;
  try {
    return JSON.parse(n);
  } catch {
    return null;
  }
}
function Ri(n, e, t) {
  return {
    runId: n.runId,
    threadId: n.threadId,
    planId: n.planId,
    status: n.status,
    currentStepId: n.currentStepId,
    progress: Number(n.progress || 0),
    draftSessionId: n.draftSessionId,
    cancelRequested: !!n.cancelRequested,
    pendingApproval: Be(n.pendingApprovalJson) || null,
    approvalResponses: Be(n.approvalResponsesJson) || [],
    planSnapshot: Be(n.planJson) || void 0,
    artifacts: t.map((r) => ({
      artifactId: r.artifactId,
      runId: r.runId,
      planId: r.planId,
      type: r.type,
      title: r.title,
      status: r.status,
      summary: r.summary,
      content: r.content,
      reference: Be(r.referenceJson) || {},
      metadata: Be(r.metadataJson) || {},
      reviewStatus: r.reviewStatus || "unreviewed",
      reviewRevision: Number(r.reviewRevision || 0),
      reviewDecisions: Be(r.reviewDecisionsJson) || [],
      reviewStaleChapterIds: Be(r.reviewStaleChapterIdsJson) || [],
      reviewedAt: r.reviewedAt,
      createdAt: r.createdAt
    })),
    events: e.map((r) => ({
      eventId: r.eventId,
      sequence: Number(r.sequence || 0),
      runId: r.runId,
      planId: r.planId,
      threadId: r.threadId,
      stepId: r.stepId,
      type: r.type,
      agent: r.agent,
      toolName: r.toolName,
      status: r.status,
      payload: Be(r.payloadJson) || {},
      createdAt: r.createdAt
    }))
  };
}
function Di(n, e) {
  const t = /* @__PURE__ */ new Set();
  for (const r of e) {
    const a = r.planSnapshot;
    if (!a || typeof a != "object")
      continue;
    const s = a.steps;
    if (Array.isArray(s))
      for (const i of s) {
        if (!i || typeof i != "object")
          continue;
        const o = i.title;
        typeof o == "string" && o.trim() && t.add(o.trim());
      }
  }
  return t.size === 0 ? n : n.filter((r) => r.role !== "assistant" || !t.has(r.content.trim()));
}
class Oi {
  constructor(e) {
    H(this, "db");
    H(this, "writeQueues", /* @__PURE__ */ new Map());
    H(this, "legacyStepMessagesCleaned", !1);
    this.db = e;
  }
  async ensureSchema() {
    await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentConversation (
                id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL,
                description TEXT, role TEXT NOT NULL, runtimeConversationId TEXT,
                suggestedGoal TEXT, planJson TEXT, runJson TEXT, contextSummaryJson TEXT, error TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `), (await this.db.$queryRawUnsafe("PRAGMA table_info(AgentConversation)")).some((o) => o.name === "contextSummaryJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentConversation ADD COLUMN contextSummaryJson TEXT"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_conversation_novel_updated ON AgentConversation(novelId, updatedAt)"), await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentMessage (
                id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, metadataJson TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE
            )
        `), (await this.db.$queryRawUnsafe("PRAGMA table_info(AgentMessage)")).some((o) => o.name === "metadataJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentMessage ADD COLUMN metadataJson TEXT"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_message_conversation_created ON AgentMessage(conversationId, createdAt)"), await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentRun (
                runId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, novelId TEXT NOT NULL,
                threadId TEXT NOT NULL, planId TEXT NOT NULL, status TEXT NOT NULL,
                currentStepId TEXT, progress REAL NOT NULL DEFAULT 0, draftSessionId TEXT,
                cancelRequested INTEGER NOT NULL DEFAULT 0, pendingApprovalJson TEXT,
                approvalResponsesJson TEXT, planJson TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
    const r = await this.db.$queryRawUnsafe("PRAGMA table_info(AgentRun)"), a = new Set(r.map((o) => o.name));
    a.has("pendingApprovalJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentRun ADD COLUMN pendingApprovalJson TEXT"), a.has("approvalResponsesJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentRun ADD COLUMN approvalResponsesJson TEXT"), a.has("planJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentRun ADD COLUMN planJson TEXT"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_run_conversation_updated ON AgentRun(conversationId, updatedAt)"), await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentRunEvent (
                eventId TEXT PRIMARY KEY, sequence INTEGER NOT NULL, runId TEXT NOT NULL,
                planId TEXT, threadId TEXT, stepId TEXT, type TEXT NOT NULL, agent TEXT,
                toolName TEXT, status TEXT, payloadJson TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (runId) REFERENCES AgentRun(runId) ON DELETE CASCADE
            )
        `), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_run_event_run_sequence ON AgentRunEvent(runId, sequence)"), await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentArtifact (
                artifactId TEXT PRIMARY KEY, conversationId TEXT NOT NULL,
                runId TEXT NOT NULL, novelId TEXT NOT NULL, planId TEXT NOT NULL,
                type TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
                summary TEXT, content TEXT, referenceJson TEXT, metadataJson TEXT,
                reviewStatus TEXT NOT NULL DEFAULT 'unreviewed',
                reviewRevision INTEGER NOT NULL DEFAULT 0,
                reviewDecisionsJson TEXT, reviewStaleChapterIdsJson TEXT, reviewedAt DATETIME,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE,
                FOREIGN KEY (runId) REFERENCES AgentRun(runId) ON DELETE CASCADE,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
    const s = await this.db.$queryRawUnsafe("PRAGMA table_info(AgentArtifact)"), i = new Set(s.map((o) => o.name));
    i.has("reviewStatus") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewStatus TEXT NOT NULL DEFAULT 'unreviewed'"), i.has("reviewRevision") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewRevision INTEGER NOT NULL DEFAULT 0"), i.has("reviewDecisionsJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewDecisionsJson TEXT"), i.has("reviewStaleChapterIdsJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewStaleChapterIdsJson TEXT"), i.has("reviewedAt") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewedAt DATETIME"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_artifact_conversation_created ON AgentArtifact(conversationId, createdAt)"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_artifact_run_created ON AgentArtifact(runId, createdAt)"), this.legacyStepMessagesCleaned || (await this.cleanupLegacyStepMessages(), this.legacyStepMessagesCleaned = !0);
  }
  async list(e) {
    await this.ensureSchema();
    const t = await this.db.$queryRawUnsafe(`
            SELECT id, novelId, title, description, role, runtimeConversationId,
                   updatedAt, suggestedGoal, planJson, runJson, contextSummaryJson, error
            FROM AgentConversation WHERE novelId = ? ORDER BY datetime(updatedAt) DESC
        `, e), r = [];
    for (const a of t) {
      const s = await this.db.$queryRawUnsafe(`
                SELECT id, conversationId, role, content, metadataJson, createdAt FROM AgentMessage
                WHERE conversationId = ? ORDER BY datetime(createdAt) ASC
            `, a.id), i = await this.db.$queryRawUnsafe(`
                SELECT runId, conversationId, novelId, threadId, planId, status,
                       currentStepId, progress, draftSessionId, cancelRequested,
                       pendingApprovalJson, approvalResponsesJson, planJson
                FROM AgentRun WHERE conversationId = ? ORDER BY datetime(updatedAt) DESC
            `, a.id), o = [];
      for (const p of i) {
        const f = await this.db.$queryRawUnsafe(`
                    SELECT eventId, sequence, runId, planId, threadId, stepId, type,
                           agent, toolName, status, payloadJson, createdAt
                    FROM AgentRunEvent WHERE runId = ? ORDER BY sequence ASC
                `, p.runId), I = await this.db.$queryRawUnsafe(`
                    SELECT artifactId, runId, planId, type, title, status, summary,
                           content, referenceJson, metadataJson, reviewStatus, reviewRevision,
                           reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt, createdAt
                    FROM AgentArtifact WHERE runId = ? ORDER BY datetime(createdAt) ASC
                `, p.runId);
        o.push(Ri(p, f, I));
      }
      const c = Be(a.runJson), d = !!(c && typeof c == "object" && Object.prototype.hasOwnProperty.call(c, "runId")), l = d ? c.runId : void 0, m = d ? typeof l == "string" ? o.find((p) => p.runId === l) ?? null : null : o[0] || null, h = Di(s, o);
      r.push({
        id: a.id,
        novelId: a.novelId,
        title: a.title,
        description: a.description || "",
        role: a.role,
        runtimeConversationId: a.runtimeConversationId,
        updatedAt: a.updatedAt,
        suggestedGoal: a.suggestedGoal,
        plan: Be(a.planJson),
        run: m,
        runs: o,
        contextSummary: Be(a.contextSummaryJson) || null,
        error: a.error || "",
        messages: h.map(({ id: p, role: f, content: I, metadataJson: y, createdAt: g }) => {
          const u = Be(y), v = u && typeof u == "object" ? u : {};
          return {
            id: p,
            role: f,
            content: I,
            createdAt: g,
            ...Array.isArray(v.contextReads) ? { contextReads: v.contextReads } : {},
            ...v.contextDiagnostics && typeof v.contextDiagnostics == "object" ? { contextDiagnostics: v.contextDiagnostics } : {},
            ...Array.isArray(v.attachmentIds) ? { attachmentIds: v.attachmentIds.filter((w) => typeof w == "string") } : {}
          };
        })
      });
    }
    return r;
  }
  async upsert(e) {
    return this.enqueue(e.id, async () => {
      var s, i, o;
      await this.ensureSchema();
      const t = (/* @__PURE__ */ new Date()).toISOString(), r = e.updatedAt || t;
      await this.db.$executeRawUnsafe(
        `
                INSERT INTO AgentConversation (
                    id, novelId, title, description, role, runtimeConversationId,
                    suggestedGoal, planJson, runJson, contextSummaryJson, error, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    novelId = excluded.novelId, title = excluded.title,
                    description = excluded.description, role = excluded.role,
                    runtimeConversationId = excluded.runtimeConversationId,
                    suggestedGoal = excluded.suggestedGoal, planJson = excluded.planJson,
                    runJson = excluded.runJson, contextSummaryJson = excluded.contextSummaryJson,
                    error = excluded.error, updatedAt = excluded.updatedAt
            `,
        e.id,
        e.novelId,
        e.title,
        e.description || "",
        e.role,
        e.runtimeConversationId || null,
        e.suggestedGoal || null,
        e.plan ? JSON.stringify(e.plan) : null,
        JSON.stringify({ runId: ((s = e.run) == null ? void 0 : s.runId) ?? null }),
        e.contextSummary ? JSON.stringify(e.contextSummary) : null,
        e.error || "",
        t,
        r
      ), await this.db.$executeRawUnsafe("DELETE FROM AgentMessage WHERE conversationId = ?", e.id);
      for (const c of e.messages || []) {
        const d = {
          ...(i = c.contextReads) != null && i.length ? { contextReads: c.contextReads } : {},
          ...c.contextDiagnostics ? { contextDiagnostics: c.contextDiagnostics } : {},
          ...(o = c.attachmentIds) != null && o.length ? { attachmentIds: c.attachmentIds } : {}
        };
        await this.db.$executeRawUnsafe(
          `
                    INSERT INTO AgentMessage (id, conversationId, role, content, metadataJson, createdAt) VALUES (?, ?, ?, ?, ?, ?)
                `,
          c.id,
          e.id,
          c.role,
          c.content,
          Object.keys(d).length ? JSON.stringify(d) : null,
          c.createdAt || t
        );
      }
      const a = e.run;
      if (a != null && a.runId) {
        await this.db.$executeRawUnsafe(
          `
                    INSERT INTO AgentRun (
                        runId, conversationId, novelId, threadId, planId, status,
                        currentStepId, progress, draftSessionId, cancelRequested,
                        pendingApprovalJson, approvalResponsesJson, planJson, createdAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(runId) DO UPDATE SET
                        conversationId = excluded.conversationId, novelId = excluded.novelId,
                        threadId = excluded.threadId, planId = excluded.planId, status = excluded.status,
                        currentStepId = excluded.currentStepId, progress = excluded.progress,
                        draftSessionId = excluded.draftSessionId, cancelRequested = excluded.cancelRequested,
                        pendingApprovalJson = excluded.pendingApprovalJson,
                        approvalResponsesJson = excluded.approvalResponsesJson,
                        planJson = excluded.planJson, updatedAt = excluded.updatedAt
                `,
          a.runId,
          e.id,
          e.novelId,
          a.threadId,
          a.planId,
          a.status,
          a.currentStepId || null,
          Number(a.progress || 0),
          a.draftSessionId || null,
          a.cancelRequested ? 1 : 0,
          a.pendingApproval ? JSON.stringify(a.pendingApproval) : null,
          JSON.stringify(a.approvalResponses || []),
          a.planSnapshot ? JSON.stringify(a.planSnapshot) : null,
          t,
          r
        );
        for (const c of a.events || [])
          await this.db.$executeRawUnsafe(
            `
                        INSERT INTO AgentRunEvent (
                            eventId, sequence, runId, planId, threadId, stepId,
                            type, agent, toolName, status, payloadJson, createdAt
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(eventId) DO UPDATE SET
                            sequence = excluded.sequence, planId = excluded.planId,
                            threadId = excluded.threadId, stepId = excluded.stepId,
                            type = excluded.type, agent = excluded.agent, toolName = excluded.toolName,
                            status = excluded.status, payloadJson = excluded.payloadJson,
                            createdAt = excluded.createdAt
                    `,
            c.eventId,
            Number(c.sequence || 0),
            a.runId,
            c.planId || null,
            c.threadId || null,
            c.stepId || null,
            c.type,
            c.agent || null,
            c.toolName || null,
            c.status || null,
            JSON.stringify(c.payload || {}),
            c.createdAt || t
          );
        for (const c of a.artifacts || [])
          await this.db.$executeRawUnsafe(
            `
                        INSERT INTO AgentArtifact (
                            artifactId, conversationId, runId, novelId, planId, type,
                            title, status, summary, content, referenceJson, metadataJson,
                            reviewStatus, reviewRevision, reviewDecisionsJson,
                            reviewStaleChapterIdsJson, reviewedAt, createdAt, updatedAt
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(artifactId) DO UPDATE SET
                            title = excluded.title, status = excluded.status,
                            summary = excluded.summary, content = excluded.content,
                            referenceJson = excluded.referenceJson,
                            metadataJson = excluded.metadataJson, updatedAt = excluded.updatedAt
                    `,
            c.artifactId,
            e.id,
            a.runId,
            e.novelId,
            c.planId || a.planId,
            c.type,
            c.title,
            c.status,
            c.summary || null,
            c.content || null,
            JSON.stringify(c.reference || {}),
            JSON.stringify(c.metadata || {}),
            c.reviewStatus || "unreviewed",
            Number(c.reviewRevision || 0),
            JSON.stringify(c.reviewDecisions || []),
            JSON.stringify(c.reviewStaleChapterIds || []),
            c.reviewedAt || null,
            c.createdAt || t,
            r
          );
      }
      return { ok: !0 };
    });
  }
  async delete(e) {
    return this.enqueue(e, async () => {
      await this.ensureSchema();
      const t = await this.db.$queryRawUnsafe("SELECT runId FROM AgentRun WHERE conversationId = ?", e);
      for (const r of t)
        await this.db.$executeRawUnsafe("DELETE FROM AgentArtifact WHERE runId = ?", r.runId), await this.db.$executeRawUnsafe("DELETE FROM AgentRunEvent WHERE runId = ?", r.runId);
      return await this.db.$executeRawUnsafe("DELETE FROM AgentRun WHERE conversationId = ?", e), await this.db.$executeRawUnsafe("DELETE FROM AgentMessage WHERE conversationId = ?", e), await this.db.$executeRawUnsafe("DELETE FROM AgentConversation WHERE id = ?", e), { ok: !0 };
    });
  }
  async cleanupLegacyStepMessages() {
    var a;
    const e = await this.db.$queryRawUnsafe(`
            SELECT conversationId, planJson FROM AgentRun WHERE planJson IS NOT NULL
        `), t = /* @__PURE__ */ new Map();
    for (const s of e) {
      const i = Be(s.planJson);
      if (!i || typeof i != "object")
        continue;
      const o = i.steps;
      if (!Array.isArray(o))
        continue;
      const c = t.get(s.conversationId) ?? /* @__PURE__ */ new Set();
      for (const d of o) {
        if (!d || typeof d != "object")
          continue;
        const l = d.title;
        typeof l == "string" && l.trim() && c.add(l.trim());
      }
      t.set(s.conversationId, c);
    }
    if (t.size === 0)
      return;
    const r = await this.db.$queryRawUnsafe(`
            SELECT id, conversationId, content FROM AgentMessage WHERE role = 'assistant'
        `);
    for (const s of r)
      (a = t.get(s.conversationId)) != null && a.has(s.content.trim()) && await this.db.$executeRawUnsafe(
        "DELETE FROM AgentMessage WHERE id = ? AND conversationId = ?",
        s.id,
        s.conversationId
      );
  }
  async enqueue(e, t) {
    const a = (this.writeQueues.get(e) ?? Promise.resolve()).catch(() => {
    }).then(t), s = a.then(() => {
    }, () => {
    });
    this.writeQueues.set(e, s);
    try {
      return await a;
    } finally {
      this.writeQueues.get(e) === s && this.writeQueues.delete(e);
    }
  }
}
const Bn = "document-extractor-v1", ki = "1.0.0", Li = 50 * 1024 * 1024, Ra = 2e6, Mi = 6e4, Pi = 32 * 1024 * 1024, Ui = /* @__PURE__ */ new Set([".txt", ".md", ".markdown", ".docx", ".pdf"]), Fn = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf"
};
class Le extends Error {
  constructor(t, r) {
    super(r);
    H(this, "code");
    this.name = "DocumentExtractorError", this.code = t;
  }
}
function $i(n, e) {
  if (!n || typeof n != "object")
    return !1;
  const t = n;
  return typeof t.blockId == "string" && ["heading", "paragraph", "list_item", "table", "page_break"].includes(String(t.type)) && typeof t.text == "string" && Number.isInteger(t.startOffset) && Number.isInteger(t.endOffset) && Number(t.startOffset) >= 0 && Number(t.endOffset) >= Number(t.startOffset) && Number(t.endOffset) <= e.length && e.slice(Number(t.startOffset), Number(t.endOffset)) === t.text;
}
function Bi(n) {
  if (!n || typeof n != "object")
    throw new Le("EXTRACTOR_PROTOCOL_ERROR", "Extractor returned no document");
  const e = n;
  if (typeof e.plainText != "string" || !e.plainText.trim())
    throw new Le("EMPTY_DOCUMENT", "The document contains no readable text");
  if (e.plainText.length > Ra || !Array.isArray(e.blocks))
    throw new Le("EXTRACTOR_PROTOCOL_ERROR", "Extractor returned invalid document content");
  if (!e.blocks.every((r) => $i(r, e.plainText)))
    throw new Le("EXTRACTOR_PROTOCOL_ERROR", "Extractor returned invalid block offsets");
  const t = e.metadata && typeof e.metadata == "object" ? e.metadata : { warnings: [] };
  return {
    ...typeof e.title == "string" && e.title.trim() ? { title: e.title.trim() } : {},
    plainText: e.plainText,
    blocks: e.blocks,
    metadata: {
      ...typeof t.pageCount == "number" ? { pageCount: t.pageCount } : {},
      ...typeof t.author == "string" ? { author: t.author } : {},
      ...typeof t.language == "string" ? { language: t.language } : {},
      ...typeof t.encoding == "string" ? { encoding: t.encoding } : {},
      warnings: Array.isArray(t.warnings) ? t.warnings.filter((r) => r && typeof r.code == "string" && typeof r.message == "string") : []
    }
  };
}
function Fi() {
  return D.resolve(j.getAppPath(), "..", "..", "agent_runtime");
}
function qi(n, e) {
  if (n === ".pdf" && e.subarray(0, 5).toString("ascii") !== "%PDF-")
    throw new Le("UNSUPPORTED_FILE_TYPE", "文件内容不是有效的 PDF。");
  if (n === ".docx" && !(e[0] === 80 && e[1] === 75))
    throw new Le("UNSUPPORTED_FILE_TYPE", "文件内容不是有效的 DOCX。");
}
function ji() {
  if (j.isPackaged) {
    const r = process.platform === "win32" ? "document-extractor.exe" : "document-extractor", a = D.join(process.resourcesPath, "agent-runtime", "document-extractor");
    return { command: D.join(a, r), args: [], cwd: a };
  }
  const n = Fi(), e = process.env.NOVEL_DOCUMENT_EXTRACTOR_PYTHON, t = D.join(n, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return {
    command: e || t,
    args: ["-m", "document_extractor"],
    cwd: n
  };
}
class Vi {
  async extractFile(e, t = Mi) {
    var c, d;
    const r = D.extname(e).toLowerCase();
    if (!Ui.has(r))
      throw new Le("UNSUPPORTED_FILE_TYPE", "仅支持 TXT、Markdown、DOCX 和文本型 PDF。");
    const a = await Te.stat(e).catch(() => null);
    if (!(a != null && a.isFile()))
      throw new Le("FILE_READ_FAILED", "无法读取所选文件。");
    if (a.size > Li)
      throw new Le("FILE_TOO_LARGE", "文件不能超过 50 MiB。");
    const s = await Te.mkdtemp(D.join(j.getPath("temp"), "cloud-dream-document-")), i = D.join(s, `input${r}`), o = le();
    try {
      await Te.copyFile(e, i);
      const l = await Te.readFile(i);
      qi(r, l);
      const m = be("sha256").update(l).digest("hex"), h = {
        protocolVersion: Bn,
        jobId: o,
        temporaryFilePath: i,
        originalFileName: D.basename(e),
        extension: r,
        mimeType: Fn[r],
        limits: { maxCharacters: Ra, timeoutMs: t }
      }, p = await this.invoke(h, t);
      if (!p.ok)
        throw new Le(
          ((c = p.error) == null ? void 0 : c.code) || "TEXT_EXTRACTION_FAILED",
          ((d = p.error) == null ? void 0 : d.message) || "文档内容提取失败。"
        );
      return {
        originalFileName: D.basename(e),
        extension: r,
        mimeType: Fn[r],
        sizeBytes: a.size,
        contentHash: m,
        extractorVersion: ki,
        document: Bi(p.document)
      };
    } finally {
      await Te.rm(s, { recursive: !0, force: !0 }).catch(() => {
      });
    }
  }
  invoke(e, t) {
    const r = ji();
    return new Promise((a, s) => {
      const i = jr(r.command, r.args, {
        cwd: r.cwd,
        windowsHide: !0,
        stdio: ["pipe", "pipe", "pipe"]
      }), o = [];
      let c = 0, d = !1;
      const l = (h) => {
        d || (d = !0, clearTimeout(m), h());
      }, m = setTimeout(() => {
        i.kill(), l(() => s(new Le("EXTRACTOR_TIMEOUT", "文档读取超时。")));
      }, t);
      i.stdout.on("data", (h) => {
        if (c += h.length, c > Pi) {
          i.kill(), l(() => s(new Le("EXTRACTOR_PROTOCOL_ERROR", "提取结果超过安全限制。")));
          return;
        }
        o.push(h);
      }), i.stderr.resume(), i.on("error", () => l(() => s(
        new Le("EXTRACTOR_UNAVAILABLE", "文档提取组件不可用。")
      ))), i.on("close", () => l(() => {
        try {
          const h = JSON.parse(Buffer.concat(o).toString("utf8"));
          if (h.protocolVersion !== Bn || h.jobId !== e.jobId)
            throw new Error("Protocol mismatch");
          a(h);
        } catch {
          s(new Le("EXTRACTOR_PROTOCOL_ERROR", "文档提取组件返回了无效结果。"));
        }
      })), i.stdin.end(JSON.stringify(e));
    });
  }
}
const Ji = /^(第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[卷册部集篇]|[卷册部集篇]\s*[0-9零〇一二两三四五六七八九十百千]+|第\s*[IVXLC]+\s*卷)(?:\s+.+)?$/iu, Hi = /^(第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[章节回节篇]|chapter\s*\d+|chap\.\s*\d+|序章|楔子|终章|尾声|后记|番外)(?:\s+.+)?$/iu;
function Da(n) {
  return n.replace(/^\uFEFF/, "").replace(/\r\n?/g, `
`);
}
function zi(n) {
  return n.trim().replace(/[\u3000\t ]+/g, " ");
}
function sr(n) {
  return Da(n).split(`
`).map((e) => e.trimEnd()).join(`
`).trim();
}
function Wi(n) {
  return n.replace(/\s+/g, "").length;
}
function Xi(n) {
  return D.parse(n).name.trim() || "导入作品";
}
function qn(n) {
  return n ? (n.match(/�/g) || []).length > 0 ? !0 : (n.match(/[�]/g) || []).length > 0 : !1;
}
function Gi(n) {
  const e = new TextDecoder("utf-8").decode(n);
  if (!qn(e))
    return e;
  for (const t of ["gb18030", "gbk", "big5"])
    try {
      const r = new TextDecoder(t).decode(n);
      if (!qn(r))
        return r;
    } catch {
    }
  return e;
}
async function Ki(n) {
  const e = await Te.readFile(n);
  return Gi(e);
}
async function Zi(n) {
  const e = await import("mammoth");
  return (await (e.default ?? e).extractRawText({ path: n })).value || "";
}
async function Yi(n) {
  var s;
  const e = await import("pdf-parse"), { PDFParse: t } = e, r = await Te.readFile(n), a = new t({ data: r });
  try {
    return (await a.getText()).text || "";
  } finally {
    await ((s = a.destroy) == null ? void 0 : s.call(a));
  }
}
async function Qi(n) {
  const e = D.extname(n).toLowerCase();
  if (e === ".txt")
    return await Ki(n);
  if (e === ".docx")
    return await Zi(n);
  if (e === ".doc")
    throw new Error("暂不支持旧版 .doc，请先另存为 .docx 后再导入。");
  if (e === ".pdf")
    return await Yi(n);
  throw new Error(`不支持的文件类型: ${e || "unknown"}`);
}
async function ec(n) {
  const e = await Qi(n), t = sr(e);
  if (!t)
    throw new Error("未从文件中提取到可导入文本。");
  return nc(t, Xi(n));
}
function jn(n) {
  const e = sr(n), t = e ? e.split(/\n{2,}/).map((r) => r.trim()).filter(Boolean) : [""];
  return JSON.stringify({
    root: {
      type: "root",
      format: "",
      indent: 0,
      version: 1,
      children: t.map((r) => ({
        type: "paragraph",
        format: "",
        indent: 0,
        version: 1,
        direction: "ltr",
        textFormat: 0,
        textStyle: "",
        children: [{
          type: "text",
          detail: 0,
          format: 0,
          mode: "normal",
          style: "",
          text: r,
          version: 1
        }]
      })),
      direction: "ltr"
    }
  });
}
function tc(n) {
  return sr(n.lines.join(`
`)).length > 0;
}
function xr(n) {
  return n.title === "开始" && !tc(n);
}
function rc(n, e) {
  const t = e.map((a, s) => ({
    title: a.title || "正文",
    order: s + 1,
    chapters: a.chapters.map((i, o) => {
      const c = sr(i.lines.join(`
`));
      return {
        title: i.title || "开始",
        plainText: c,
        lexicalContent: jn(c),
        wordCount: Wi(c),
        order: o + 1
      };
    }).filter((i) => i.plainText.length > 0 || i.title === "开始")
  })).filter((a) => a.chapters.length > 0), r = t.length ? t : [{
    title: "正文",
    order: 1,
    chapters: [{
      title: "开始",
      plainText: "",
      lexicalContent: jn(""),
      wordCount: 0,
      order: 1
    }]
  }];
  return {
    title: n,
    volumes: r,
    wordCount: r.reduce((a, s) => a + s.chapters.reduce((i, o) => i + o.wordCount, 0), 0)
  };
}
function nc(n, e) {
  const r = Da(n).split(`
`), a = [];
  let s = { title: "正文", chapters: [] }, i = { title: "开始", lines: [] };
  const o = () => {
    xr(i) || s.chapters.push(i);
  }, c = () => {
    xr(i) || o(), s.chapters.length > 0 && a.push(s);
  };
  for (const l of r) {
    const m = zi(l);
    if (!m) {
      i.lines.push("");
      continue;
    }
    if (Ji.test(m)) {
      c(), s = { title: m, chapters: [] }, i = { title: "开始", lines: [] };
      continue;
    }
    if (Hi.test(m)) {
      xr(i) || o(), i = { title: m, lines: [] };
      continue;
    }
    i.lines.push(l.trimEnd());
  }
  c();
  const d = e.trim() || "导入作品";
  return rc(d, a);
}
const Vn = "http://localhost:8080/api/sync";
class ac {
  // Get the global sync cursor
  async getCursor() {
    const e = await S.syncState.findUnique({ where: { id: "global" } });
    return e ? Number(e.cursor) : 0;
  }
  async setCursor(e) {
    await S.syncState.upsert({
      where: { id: "global" },
      create: { id: "global", cursor: BigInt(e) },
      update: { cursor: BigInt(e) }
    });
  }
  async pull() {
    var t, r;
    const e = await this.getCursor();
    console.log("[Sync] Pulling from cursor:", e);
    try {
      const a = await fetch(`${Vn}/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastSyncCursor: e })
      });
      if (!a.ok)
        throw new Error(`Pull failed: ${a.statusText}`);
      const s = await a.json(), { newSyncCursor: i, data: o } = s;
      return await S.$transaction(async (c) => {
        var d, l, m;
        if ((d = o.novels) != null && d.length)
          for (const h of o.novels)
            await c.novel.upsert({
              where: { id: h.id },
              create: { ...h, updatedAt: new Date(h.updatedAt), createdAt: new Date(h.createdAt) },
              update: { ...h, updatedAt: new Date(h.updatedAt), createdAt: new Date(h.createdAt) }
            });
        if ((l = o.volumes) != null && l.length)
          for (const h of o.volumes)
            await c.volume.upsert({
              where: { id: h.id },
              create: { ...h, updatedAt: new Date(h.updatedAt), createdAt: new Date(h.createdAt) },
              update: { ...h, updatedAt: new Date(h.updatedAt), createdAt: new Date(h.createdAt) }
            });
        if ((m = o.chapters) != null && m.length)
          for (const h of o.chapters)
            await c.chapter.upsert({
              where: { id: h.id },
              create: { ...h, updatedAt: new Date(h.updatedAt), createdAt: new Date(h.createdAt) },
              update: { ...h, updatedAt: new Date(h.updatedAt), createdAt: new Date(h.createdAt) }
            });
      }), await this.setCursor(i), console.log("[Sync] Pull complete. New cursor:", i), { success: !0, count: (((t = o.novels) == null ? void 0 : t.length) || 0) + (((r = o.chapters) == null ? void 0 : r.length) || 0) };
    } catch (a) {
      throw console.error("[Sync] Pull error:", a), a;
    }
  }
  async push() {
    const e = await this.getCursor(), t = {
      novels: await S.novel.findMany({ where: { updatedAt: { gt: new Date(e) } } }),
      volumes: await S.volume.findMany({ where: { updatedAt: { gt: new Date(e) } } }),
      chapters: await S.chapter.findMany({ where: { updatedAt: { gt: new Date(e) } } })
    };
    if (t.novels.length === 0 && t.volumes.length === 0 && t.chapters.length === 0)
      return { success: !0, count: 0 };
    console.log("[Sync] Pushing changes...");
    const r = JSON.stringify({
      lastSyncCursor: e,
      changes: t
    }, (s, i) => typeof i == "bigint" ? i.toString() : i), a = await fetch(`${Vn}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: r
    });
    if (!a.ok)
      throw new Error(`Push failed: ${a.statusText}`);
    return console.log("[Sync] Push success"), await a.json();
  }
}
function sc(n) {
  return n && n.__esModule && Object.prototype.hasOwnProperty.call(n, "default") ? n.default : n;
}
var Et = { exports: {} }, Oa = {
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
}, or = {};
(function(n) {
  const e = {
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
  function t(r) {
    return function(...a) {
      return a.length && (r = r.replace(/\{(\d)\}/g, (s, i) => a[i] || "")), new Error("ADM-ZIP: " + r);
    };
  }
  for (const r of Object.keys(e))
    n[r] = t(e[r]);
})(or);
const oc = z, we = Ke, Jn = Oa, ic = or, cc = typeof process == "object" && process.platform === "win32", Hn = (n) => typeof n == "object" && n !== null, ka = new Uint32Array(256).map((n, e) => {
  for (let t = 0; t < 8; t++)
    e & 1 ? e = 3988292384 ^ e >>> 1 : e >>>= 1;
  return e >>> 0;
});
function pe(n) {
  this.sep = we.sep, this.fs = oc, Hn(n) && Hn(n.fs) && typeof n.fs.statSync == "function" && (this.fs = n.fs);
}
var dc = pe;
pe.prototype.makeDir = function(n) {
  const e = this;
  function t(r) {
    let a = r.split(e.sep)[0];
    r.split(e.sep).forEach(function(s) {
      if (!(!s || s.substr(-1, 1) === ":")) {
        a += e.sep + s;
        var i;
        try {
          i = e.fs.statSync(a);
        } catch {
          e.fs.mkdirSync(a);
        }
        if (i && i.isFile())
          throw ic.FILE_IN_THE_WAY(`"${a}"`);
      }
    });
  }
  t(n);
};
pe.prototype.writeFileTo = function(n, e, t, r) {
  const a = this;
  if (a.fs.existsSync(n)) {
    if (!t)
      return !1;
    var s = a.fs.statSync(n);
    if (s.isDirectory())
      return !1;
  }
  var i = we.dirname(n);
  a.fs.existsSync(i) || a.makeDir(i);
  var o;
  try {
    o = a.fs.openSync(n, "w", 438);
  } catch {
    a.fs.chmodSync(n, 438), o = a.fs.openSync(n, "w", 438);
  }
  if (o)
    try {
      a.fs.writeSync(o, e, 0, e.length, 0);
    } finally {
      a.fs.closeSync(o);
    }
  return a.fs.chmodSync(n, r || 438), !0;
};
pe.prototype.writeFileToAsync = function(n, e, t, r, a) {
  typeof r == "function" && (a = r, r = void 0);
  const s = this;
  s.fs.exists(n, function(i) {
    if (i && !t)
      return a(!1);
    s.fs.stat(n, function(o, c) {
      if (i && c.isDirectory())
        return a(!1);
      var d = we.dirname(n);
      s.fs.exists(d, function(l) {
        l || s.makeDir(d), s.fs.open(n, "w", 438, function(m, h) {
          m ? s.fs.chmod(n, 438, function() {
            s.fs.open(n, "w", 438, function(p, f) {
              s.fs.write(f, e, 0, e.length, 0, function() {
                s.fs.close(f, function() {
                  s.fs.chmod(n, r || 438, function() {
                    a(!0);
                  });
                });
              });
            });
          }) : h ? s.fs.write(h, e, 0, e.length, 0, function() {
            s.fs.close(h, function() {
              s.fs.chmod(n, r || 438, function() {
                a(!0);
              });
            });
          }) : s.fs.chmod(n, r || 438, function() {
            a(!0);
          });
        });
      });
    });
  });
};
pe.prototype.findFiles = function(n) {
  const e = this;
  function t(r, a, s) {
    let i = [];
    return e.fs.readdirSync(r).forEach(function(o) {
      const c = we.join(r, o), d = e.fs.statSync(c);
      i.push(we.normalize(c) + (d.isDirectory() ? e.sep : "")), d.isDirectory() && s && (i = i.concat(t(c, a, s)));
    }), i;
  }
  return t(n, void 0, !0);
};
pe.prototype.findFilesAsync = function(n, e) {
  const t = this;
  let r = [];
  t.fs.readdir(n, function(a, s) {
    if (a)
      return e(a);
    let i = s.length;
    if (!i)
      return e(null, r);
    s.forEach(function(o) {
      o = we.join(n, o), t.fs.stat(o, function(c, d) {
        if (c)
          return e(c);
        d && (r.push(we.normalize(o) + (d.isDirectory() ? t.sep : "")), d.isDirectory() ? t.findFilesAsync(o, function(l, m) {
          if (l)
            return e(l);
          r = r.concat(m), --i || e(null, r);
        }) : --i || e(null, r));
      });
    });
  });
};
pe.prototype.getAttributes = function() {
};
pe.prototype.setAttributes = function() {
};
pe.crc32update = function(n, e) {
  return ka[(n ^ e) & 255] ^ n >>> 8;
};
pe.crc32 = function(n) {
  typeof n == "string" && (n = Buffer.from(n, "utf8"));
  let e = n.length, t = -1;
  for (let r = 0; r < e; )
    t = pe.crc32update(t, n[r++]);
  return ~t >>> 0;
};
pe.methodToString = function(n) {
  switch (n) {
    case Jn.STORED:
      return "STORED (" + n + ")";
    case Jn.DEFLATED:
      return "DEFLATED (" + n + ")";
    default:
      return "UNSUPPORTED (" + n + ")";
  }
};
pe.canonical = function(n) {
  if (!n)
    return "";
  const e = we.posix.normalize("/" + n.split("\\").join("/"));
  return we.join(".", e);
};
pe.zipnamefix = function(n) {
  if (!n)
    return "";
  const e = we.posix.normalize("/" + n.split("\\").join("/"));
  return we.posix.join(".", e);
};
pe.findLast = function(n, e) {
  if (!Array.isArray(n))
    throw new TypeError("arr is not array");
  const t = n.length >>> 0;
  for (let r = t - 1; r >= 0; r--)
    if (e(n[r], r, n))
      return n[r];
};
pe.sanitize = function(n, e) {
  n = we.resolve(we.normalize(n));
  for (var t = e.split("/"), r = 0, a = t.length; r < a; r++) {
    var s = we.normalize(we.join(n, t.slice(r, a).join(we.sep)));
    if (s.indexOf(n) === 0)
      return s;
  }
  return we.normalize(we.join(n, we.basename(e)));
};
pe.toBuffer = function(e, t) {
  return Buffer.isBuffer(e) ? e : e instanceof Uint8Array ? Buffer.from(e) : typeof e == "string" ? t(e) : Buffer.alloc(0);
};
pe.readBigUInt64LE = function(n, e) {
  var t = Buffer.from(n.slice(e, e + 8));
  return t.swap64(), parseInt(`0x${t.toString("hex")}`);
};
pe.fromDOS2Date = function(n) {
  return new Date((n >> 25 & 127) + 1980, Math.max((n >> 21 & 15) - 1, 0), Math.max(n >> 16 & 31, 1), n >> 11 & 31, n >> 5 & 63, (n & 31) << 1);
};
pe.fromDate2DOS = function(n) {
  let e = 0, t = 0;
  return n.getFullYear() > 1979 && (e = (n.getFullYear() - 1980 & 127) << 9 | n.getMonth() + 1 << 5 | n.getDate(), t = n.getHours() << 11 | n.getMinutes() << 5 | n.getSeconds() >> 1), e << 16 | t;
};
pe.isWin = cc;
pe.crcTable = ka;
const lc = Ke;
var uc = function(n, { fs: e }) {
  var t = n || "", r = s(), a = null;
  function s() {
    return {
      directory: !1,
      readonly: !1,
      hidden: !1,
      executable: !1,
      mtime: 0,
      atime: 0
    };
  }
  return t && e.existsSync(t) ? (a = e.statSync(t), r.directory = a.isDirectory(), r.mtime = a.mtime, r.atime = a.atime, r.executable = (73 & a.mode) !== 0, r.readonly = (128 & a.mode) === 0, r.hidden = lc.basename(t)[0] === ".") : console.warn("Invalid path: " + t), {
    get directory() {
      return r.directory;
    },
    get readOnly() {
      return r.readonly;
    },
    get hidden() {
      return r.hidden;
    },
    get mtime() {
      return r.mtime;
    },
    get atime() {
      return r.atime;
    },
    get executable() {
      return r.executable;
    },
    decodeAttributes: function() {
    },
    encodeAttributes: function() {
    },
    toJSON: function() {
      return {
        path: t,
        isDirectory: r.directory,
        isReadOnly: r.readonly,
        isHidden: r.hidden,
        isExecutable: r.executable,
        mTime: r.mtime,
        aTime: r.atime
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
}, hc = {
  efs: !0,
  encode: (n) => Buffer.from(n, "utf8"),
  decode: (n) => n.toString("utf8")
};
Et.exports = dc;
Et.exports.Constants = Oa;
Et.exports.Errors = or;
Et.exports.FileAttr = uc;
Et.exports.decoder = hc;
var Ut = Et.exports, ir = {}, at = Ut, P = at.Constants, mc = function() {
  var n = 20, e = 10, t = 0, r = 0, a = 0, s = 0, i = 0, o = 0, c = 0, d = 0, l = 0, m = 0, h = 0, p = 0, f = 0;
  n |= at.isWin ? 2560 : 768, t |= P.FLG_EFS;
  const I = {
    extraLen: 0
  }, y = (u) => Math.max(0, u) >>> 0, g = (u) => Math.max(0, u) & 255;
  return a = at.fromDate2DOS(/* @__PURE__ */ new Date()), {
    get made() {
      return n;
    },
    set made(u) {
      n = u;
    },
    get version() {
      return e;
    },
    set version(u) {
      e = u;
    },
    get flags() {
      return t;
    },
    set flags(u) {
      t = u;
    },
    get flags_efs() {
      return (t & P.FLG_EFS) > 0;
    },
    set flags_efs(u) {
      u ? t |= P.FLG_EFS : t &= ~P.FLG_EFS;
    },
    get flags_desc() {
      return (t & P.FLG_DESC) > 0;
    },
    set flags_desc(u) {
      u ? t |= P.FLG_DESC : t &= ~P.FLG_DESC;
    },
    get method() {
      return r;
    },
    set method(u) {
      switch (u) {
        case P.STORED:
          this.version = 10;
        case P.DEFLATED:
        default:
          this.version = 20;
      }
      r = u;
    },
    get time() {
      return at.fromDOS2Date(this.timeval);
    },
    set time(u) {
      this.timeval = at.fromDate2DOS(u);
    },
    get timeval() {
      return a;
    },
    set timeval(u) {
      a = y(u);
    },
    get timeHighByte() {
      return g(a >>> 8);
    },
    get crc() {
      return s;
    },
    set crc(u) {
      s = y(u);
    },
    get compressedSize() {
      return i;
    },
    set compressedSize(u) {
      i = y(u);
    },
    get size() {
      return o;
    },
    set size(u) {
      o = y(u);
    },
    get fileNameLength() {
      return c;
    },
    set fileNameLength(u) {
      c = u;
    },
    get extraLength() {
      return d;
    },
    set extraLength(u) {
      d = u;
    },
    get extraLocalLength() {
      return I.extraLen;
    },
    set extraLocalLength(u) {
      I.extraLen = u;
    },
    get commentLength() {
      return l;
    },
    set commentLength(u) {
      l = u;
    },
    get diskNumStart() {
      return m;
    },
    set diskNumStart(u) {
      m = y(u);
    },
    get inAttr() {
      return h;
    },
    set inAttr(u) {
      h = y(u);
    },
    get attr() {
      return p;
    },
    set attr(u) {
      p = y(u);
    },
    // get Unix file permissions
    get fileAttr() {
      return (p || 0) >> 16 & 4095;
    },
    get offset() {
      return f;
    },
    set offset(u) {
      f = y(u);
    },
    get encrypted() {
      return (t & P.FLG_ENC) === P.FLG_ENC;
    },
    get centralHeaderSize() {
      return P.CENHDR + c + d + l;
    },
    get realDataOffset() {
      return f + P.LOCHDR + I.fnameLen + I.extraLen;
    },
    get localHeader() {
      return I;
    },
    loadLocalHeaderFromBinary: function(u) {
      var v = u.slice(f, f + P.LOCHDR);
      if (v.readUInt32LE(0) !== P.LOCSIG)
        throw at.Errors.INVALID_LOC();
      I.version = v.readUInt16LE(P.LOCVER), I.flags = v.readUInt16LE(P.LOCFLG), I.method = v.readUInt16LE(P.LOCHOW), I.time = v.readUInt32LE(P.LOCTIM), I.crc = v.readUInt32LE(P.LOCCRC), I.compressedSize = v.readUInt32LE(P.LOCSIZ), I.size = v.readUInt32LE(P.LOCLEN), I.fnameLen = v.readUInt16LE(P.LOCNAM), I.extraLen = v.readUInt16LE(P.LOCEXT);
      const w = f + P.LOCHDR + I.fnameLen, A = w + I.extraLen;
      return u.slice(w, A);
    },
    loadFromBinary: function(u) {
      if (u.length !== P.CENHDR || u.readUInt32LE(0) !== P.CENSIG)
        throw at.Errors.INVALID_CEN();
      n = u.readUInt16LE(P.CENVEM), e = u.readUInt16LE(P.CENVER), t = u.readUInt16LE(P.CENFLG), r = u.readUInt16LE(P.CENHOW), a = u.readUInt32LE(P.CENTIM), s = u.readUInt32LE(P.CENCRC), i = u.readUInt32LE(P.CENSIZ), o = u.readUInt32LE(P.CENLEN), c = u.readUInt16LE(P.CENNAM), d = u.readUInt16LE(P.CENEXT), l = u.readUInt16LE(P.CENCOM), m = u.readUInt16LE(P.CENDSK), h = u.readUInt16LE(P.CENATT), p = u.readUInt32LE(P.CENATX), f = u.readUInt32LE(P.CENOFF);
    },
    localHeaderToBinary: function() {
      var u = Buffer.alloc(P.LOCHDR);
      return u.writeUInt32LE(P.LOCSIG, 0), u.writeUInt16LE(e, P.LOCVER), u.writeUInt16LE(t, P.LOCFLG), u.writeUInt16LE(r, P.LOCHOW), u.writeUInt32LE(a, P.LOCTIM), u.writeUInt32LE(s, P.LOCCRC), u.writeUInt32LE(i, P.LOCSIZ), u.writeUInt32LE(o, P.LOCLEN), u.writeUInt16LE(c, P.LOCNAM), u.writeUInt16LE(I.extraLen, P.LOCEXT), u;
    },
    centralHeaderToBinary: function() {
      var u = Buffer.alloc(P.CENHDR + c + d + l);
      return u.writeUInt32LE(P.CENSIG, 0), u.writeUInt16LE(n, P.CENVEM), u.writeUInt16LE(e, P.CENVER), u.writeUInt16LE(t, P.CENFLG), u.writeUInt16LE(r, P.CENHOW), u.writeUInt32LE(a, P.CENTIM), u.writeUInt32LE(s, P.CENCRC), u.writeUInt32LE(i, P.CENSIZ), u.writeUInt32LE(o, P.CENLEN), u.writeUInt16LE(c, P.CENNAM), u.writeUInt16LE(d, P.CENEXT), u.writeUInt16LE(l, P.CENCOM), u.writeUInt16LE(m, P.CENDSK), u.writeUInt16LE(h, P.CENATT), u.writeUInt32LE(p, P.CENATX), u.writeUInt32LE(f, P.CENOFF), u;
    },
    toJSON: function() {
      const u = function(v) {
        return v + " bytes";
      };
      return {
        made: n,
        version: e,
        flags: t,
        method: at.methodToString(r),
        time: this.time,
        crc: "0x" + s.toString(16).toUpperCase(),
        compressedSize: u(i),
        size: u(o),
        fileNameLength: u(c),
        extraLength: u(d),
        commentLength: u(l),
        diskNumStart: m,
        inAttr: h,
        attr: p,
        offset: f,
        centralHeaderSize: u(P.CENHDR + c + d + l)
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
}, yt = Ut, ue = yt.Constants, fc = function() {
  var n = 0, e = 0, t = 0, r = 0, a = 0;
  return {
    get diskEntries() {
      return n;
    },
    set diskEntries(s) {
      n = e = s;
    },
    get totalEntries() {
      return e;
    },
    set totalEntries(s) {
      e = n = s;
    },
    get size() {
      return t;
    },
    set size(s) {
      t = s;
    },
    get offset() {
      return r;
    },
    set offset(s) {
      r = s;
    },
    get commentLength() {
      return a;
    },
    set commentLength(s) {
      a = s;
    },
    get mainHeaderSize() {
      return ue.ENDHDR + a;
    },
    loadFromBinary: function(s) {
      if ((s.length !== ue.ENDHDR || s.readUInt32LE(0) !== ue.ENDSIG) && (s.length < ue.ZIP64HDR || s.readUInt32LE(0) !== ue.ZIP64SIG))
        throw yt.Errors.INVALID_END();
      s.readUInt32LE(0) === ue.ENDSIG ? (n = s.readUInt16LE(ue.ENDSUB), e = s.readUInt16LE(ue.ENDTOT), t = s.readUInt32LE(ue.ENDSIZ), r = s.readUInt32LE(ue.ENDOFF), a = s.readUInt16LE(ue.ENDCOM)) : (n = yt.readBigUInt64LE(s, ue.ZIP64SUB), e = yt.readBigUInt64LE(s, ue.ZIP64TOT), t = yt.readBigUInt64LE(s, ue.ZIP64SIZE), r = yt.readBigUInt64LE(s, ue.ZIP64OFF), a = 0);
    },
    toBinary: function() {
      var s = Buffer.alloc(ue.ENDHDR + a);
      return s.writeUInt32LE(ue.ENDSIG, 0), s.writeUInt32LE(0, 4), s.writeUInt16LE(n, ue.ENDSUB), s.writeUInt16LE(e, ue.ENDTOT), s.writeUInt32LE(t, ue.ENDSIZ), s.writeUInt32LE(r, ue.ENDOFF), s.writeUInt16LE(a, ue.ENDCOM), s.fill(" ", ue.ENDHDR), s;
    },
    toJSON: function() {
      const s = function(i, o) {
        let c = i.toString(16).toUpperCase();
        for (; c.length < o; )
          c = "0" + c;
        return "0x" + c;
      };
      return {
        diskEntries: n,
        totalEntries: e,
        size: t + " bytes",
        offset: s(r, 4),
        commentLength: a
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
ir.EntryHeader = mc;
ir.MainHeader = fc;
var cr = {}, pc = function(n) {
  var e = ta, t = { chunkSize: (parseInt(n.length / 1024) + 1) * 1024 };
  return {
    deflate: function() {
      return e.deflateRawSync(n, t);
    },
    deflateAsync: function(r) {
      var a = e.createDeflateRaw(t), s = [], i = 0;
      a.on("data", function(o) {
        s.push(o), i += o.length;
      }), a.on("end", function() {
        var o = Buffer.alloc(i), c = 0;
        o.fill(0);
        for (var d = 0; d < s.length; d++) {
          var l = s[d];
          l.copy(o, c), c += l.length;
        }
        r && r(o);
      }), a.end(n);
    }
  };
};
const gc = +(process.versions ? process.versions.node : "").split(".")[0] || 0;
var Ic = function(n, e) {
  var t = ta;
  const r = gc >= 15 && e > 0 ? { maxOutputLength: e } : {};
  return {
    inflate: function() {
      return t.inflateRawSync(n, r);
    },
    inflateAsync: function(a) {
      var s = t.createInflateRaw(r), i = [], o = 0;
      s.on("data", function(c) {
        i.push(c), o += c.length;
      }), s.on("end", function() {
        var c = Buffer.alloc(o), d = 0;
        c.fill(0);
        for (var l = 0; l < i.length; l++) {
          var m = i[l];
          m.copy(c, d), d += m.length;
        }
        a && a(c);
      }), s.end(n);
    }
  };
};
const { randomFillSync: zn } = vt, vc = or, yc = new Uint32Array(256).map((n, e) => {
  for (let t = 0; t < 8; t++)
    e & 1 ? e = e >>> 1 ^ 3988292384 : e >>>= 1;
  return e >>> 0;
}), La = (n, e) => Math.imul(n, e) >>> 0, Wn = (n, e) => yc[(n ^ e) & 255] ^ n >>> 8, Mt = () => typeof zn == "function" ? zn(Buffer.alloc(12)) : Mt.node();
Mt.node = () => {
  const n = Buffer.alloc(12), e = n.length;
  for (let t = 0; t < e; t++)
    n[t] = Math.random() * 256 & 255;
  return n;
};
const er = {
  genSalt: Mt
};
function dr(n) {
  const e = Buffer.isBuffer(n) ? n : Buffer.from(n);
  this.keys = new Uint32Array([305419896, 591751049, 878082192]);
  for (let t = 0; t < e.length; t++)
    this.updateKeys(e[t]);
}
dr.prototype.updateKeys = function(n) {
  const e = this.keys;
  return e[0] = Wn(e[0], n), e[1] += e[0] & 255, e[1] = La(e[1], 134775813) + 1, e[2] = Wn(e[2], e[1] >>> 24), n;
};
dr.prototype.next = function() {
  const n = (this.keys[2] | 2) >>> 0;
  return La(n, n ^ 1) >> 8 & 255;
};
function wc(n) {
  const e = new dr(n);
  return function(t) {
    const r = Buffer.alloc(t.length);
    let a = 0;
    for (let s of t)
      r[a++] = e.updateKeys(s ^ e.next());
    return r;
  };
}
function Sc(n) {
  const e = new dr(n);
  return function(t, r, a = 0) {
    r || (r = Buffer.alloc(t.length));
    for (let s of t) {
      const i = e.next();
      r[a++] = s ^ i, e.updateKeys(s);
    }
    return r;
  };
}
function Ac(n, e, t) {
  if (!n || !Buffer.isBuffer(n) || n.length < 12)
    return Buffer.alloc(0);
  const r = wc(t), a = r(n.slice(0, 12)), s = (e.flags & 8) === 8 ? e.timeHighByte : e.crc >>> 24;
  if (a[11] !== s)
    throw vc.WRONG_PASSWORD();
  return r(n.slice(12));
}
function Ec(n) {
  Buffer.isBuffer(n) && n.length >= 12 ? er.genSalt = function() {
    return n.slice(0, 12);
  } : n === "node" ? er.genSalt = Mt.node : er.genSalt = Mt;
}
function Tc(n, e, t, r = !1) {
  n == null && (n = Buffer.alloc(0)), Buffer.isBuffer(n) || (n = Buffer.from(n.toString()));
  const a = Sc(t), s = er.genSalt();
  s[11] = e.crc >>> 24 & 255, r && (s[10] = e.crc >>> 16 & 255);
  const i = Buffer.alloc(n.length + 12);
  return a(s, i), a(n, i, 12);
}
var Cc = { decrypt: Ac, encrypt: Tc, _salter: Ec };
cr.Deflater = pc;
cr.Inflater = Ic;
cr.ZipCrypto = Cc;
var oe = Ut, Nc = ir, me = oe.Constants, _r = cr, Ma = function(n, e) {
  var t = new Nc.EntryHeader(), r = Buffer.alloc(0), a = Buffer.alloc(0), s = !1, i = null, o = Buffer.alloc(0), c = Buffer.alloc(0), d = !0;
  const l = n, m = typeof l.decoder == "object" ? l.decoder : oe.decoder;
  d = m.hasOwnProperty("efs") ? m.efs : !1;
  function h() {
    return !e || !(e instanceof Uint8Array) ? Buffer.alloc(0) : (c = t.loadLocalHeaderFromBinary(e), e.slice(t.realDataOffset, t.realDataOffset + t.compressedSize));
  }
  function p(v) {
    if (t.flags_desc) {
      const w = {}, A = t.realDataOffset + t.compressedSize;
      if (e.readUInt32LE(A) == me.LOCSIG || e.readUInt32LE(A) == me.CENSIG)
        throw oe.Errors.DESCRIPTOR_NOT_EXIST();
      if (e.readUInt32LE(A) == me.EXTSIG)
        w.crc = e.readUInt32LE(A + me.EXTCRC), w.compressedSize = e.readUInt32LE(A + me.EXTSIZ), w.size = e.readUInt32LE(A + me.EXTLEN);
      else if (e.readUInt16LE(A + 12) === 19280)
        w.crc = e.readUInt32LE(A + me.EXTCRC - 4), w.compressedSize = e.readUInt32LE(A + me.EXTSIZ - 4), w.size = e.readUInt32LE(A + me.EXTLEN - 4);
      else
        throw oe.Errors.DESCRIPTOR_UNKNOWN();
      if (w.compressedSize !== t.compressedSize || w.size !== t.size || w.crc !== t.crc)
        throw oe.Errors.DESCRIPTOR_FAULTY();
      if (oe.crc32(v) !== w.crc)
        return !1;
    } else if (oe.crc32(v) !== t.localHeader.crc)
      return !1;
    return !0;
  }
  function f(v, w, A) {
    if (typeof w > "u" && typeof v == "string" && (A = v, v = void 0), s)
      return v && w && w(Buffer.alloc(0), oe.Errors.DIRECTORY_CONTENT_ERROR()), Buffer.alloc(0);
    var T = h();
    if (T.length === 0)
      return v && w && w(T), T;
    if (t.encrypted) {
      if (typeof A != "string" && !Buffer.isBuffer(A))
        throw oe.Errors.INVALID_PASS_PARAM();
      T = _r.ZipCrypto.decrypt(T, t, A);
    }
    var E = Buffer.alloc(t.size);
    switch (t.method) {
      case oe.Constants.STORED:
        if (T.copy(E), p(E))
          return v && w && w(E), E;
        throw v && w && w(E, oe.Errors.BAD_CRC()), oe.Errors.BAD_CRC();
      case oe.Constants.DEFLATED:
        var C = new _r.Inflater(T, t.size);
        if (v)
          C.inflateAsync(function(_) {
            _.copy(_, 0), w && (p(_) ? w(_) : w(_, oe.Errors.BAD_CRC()));
          });
        else {
          if (C.inflate(E).copy(E, 0), !p(E))
            throw oe.Errors.BAD_CRC(`"${m.decode(r)}"`);
          return E;
        }
        break;
      default:
        throw v && w && w(Buffer.alloc(0), oe.Errors.UNKNOWN_METHOD()), oe.Errors.UNKNOWN_METHOD();
    }
  }
  function I(v, w) {
    if ((!i || !i.length) && Buffer.isBuffer(e))
      return v && w && w(h()), h();
    if (i.length && !s) {
      var A;
      switch (t.method) {
        case oe.Constants.STORED:
          return t.compressedSize = t.size, A = Buffer.alloc(i.length), i.copy(A), v && w && w(A), A;
        default:
        case oe.Constants.DEFLATED:
          var T = new _r.Deflater(i);
          if (v)
            T.deflateAsync(function(C) {
              A = Buffer.alloc(C.length), t.compressedSize = C.length, C.copy(A), w && w(A);
            });
          else {
            var E = T.deflate();
            return t.compressedSize = E.length, E;
          }
          T = null;
          break;
      }
    } else if (v && w)
      w(Buffer.alloc(0));
    else
      return Buffer.alloc(0);
  }
  function y(v, w) {
    return (v.readUInt32LE(w + 4) << 4) + v.readUInt32LE(w);
  }
  function g(v) {
    try {
      for (var w = 0, A, T, E; w + 4 < v.length; )
        A = v.readUInt16LE(w), w += 2, T = v.readUInt16LE(w), w += 2, E = v.slice(w, w + T), w += T, me.ID_ZIP64 === A && u(E);
    } catch {
      throw oe.Errors.EXTRA_FIELD_PARSE_ERROR();
    }
  }
  function u(v) {
    var w, A, T, E;
    v.length >= me.EF_ZIP64_SCOMP && (w = y(v, me.EF_ZIP64_SUNCOMP), t.size === me.EF_ZIP64_OR_32 && (t.size = w)), v.length >= me.EF_ZIP64_RHO && (A = y(v, me.EF_ZIP64_SCOMP), t.compressedSize === me.EF_ZIP64_OR_32 && (t.compressedSize = A)), v.length >= me.EF_ZIP64_DSN && (T = y(v, me.EF_ZIP64_RHO), t.offset === me.EF_ZIP64_OR_32 && (t.offset = T)), v.length >= me.EF_ZIP64_DSN + 4 && (E = v.readUInt32LE(me.EF_ZIP64_DSN), t.diskNumStart === me.EF_ZIP64_OR_16 && (t.diskNumStart = E));
  }
  return {
    get entryName() {
      return m.decode(r);
    },
    get rawEntryName() {
      return r;
    },
    set entryName(v) {
      r = oe.toBuffer(v, m.encode);
      var w = r[r.length - 1];
      s = w === 47 || w === 92, t.fileNameLength = r.length;
    },
    get efs() {
      return typeof d == "function" ? d(this.entryName) : d;
    },
    get extra() {
      return o;
    },
    set extra(v) {
      o = v, t.extraLength = v.length, g(v);
    },
    get comment() {
      return m.decode(a);
    },
    set comment(v) {
      if (a = oe.toBuffer(v, m.encode), t.commentLength = a.length, a.length > 65535)
        throw oe.Errors.COMMENT_TOO_LONG();
    },
    get name() {
      var v = m.decode(r);
      return s ? v.substr(v.length - 1).split("/").pop() : v.split("/").pop();
    },
    get isDirectory() {
      return s;
    },
    getCompressedData: function() {
      return I(!1, null);
    },
    getCompressedDataAsync: function(v) {
      I(!0, v);
    },
    setData: function(v) {
      i = oe.toBuffer(v, oe.decoder.encode), !s && i.length ? (t.size = i.length, t.method = oe.Constants.DEFLATED, t.crc = oe.crc32(v), t.changed = !0) : t.method = oe.Constants.STORED;
    },
    getData: function(v) {
      return t.changed ? i : f(!1, null, v);
    },
    getDataAsync: function(v, w) {
      t.changed ? v(i) : f(!0, v, w);
    },
    set attr(v) {
      t.attr = v;
    },
    get attr() {
      return t.attr;
    },
    set header(v) {
      t.loadFromBinary(v);
    },
    get header() {
      return t;
    },
    packCentralHeader: function() {
      t.flags_efs = this.efs, t.extraLength = o.length;
      var v = t.centralHeaderToBinary(), w = oe.Constants.CENHDR;
      return r.copy(v, w), w += r.length, o.copy(v, w), w += t.extraLength, a.copy(v, w), v;
    },
    packLocalHeader: function() {
      let v = 0;
      t.flags_efs = this.efs, t.extraLocalLength = c.length;
      const w = t.localHeaderToBinary(), A = Buffer.alloc(w.length + r.length + t.extraLocalLength);
      return w.copy(A, v), v += w.length, r.copy(A, v), v += r.length, c.copy(A, v), v += c.length, A;
    },
    toJSON: function() {
      const v = function(w) {
        return "<" + (w && w.length + " bytes buffer" || "null") + ">";
      };
      return {
        entryName: this.entryName,
        name: this.name,
        comment: this.comment,
        isDirectory: this.isDirectory,
        header: t.toJSON(),
        compressedData: v(e),
        data: v(i)
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
const Xn = Ma, bc = ir, Ee = Ut;
var xc = function(n, e) {
  var t = [], r = {}, a = Buffer.alloc(0), s = new bc.MainHeader(), i = !1;
  const o = /* @__PURE__ */ new Set(), c = e, { noSort: d, decoder: l } = c;
  n ? p(c.readEntries) : i = !0;
  function m() {
    const I = /* @__PURE__ */ new Set();
    for (const y of Object.keys(r)) {
      const g = y.split("/");
      if (g.pop(), !!g.length)
        for (let u = 0; u < g.length; u++) {
          const v = g.slice(0, u + 1).join("/") + "/";
          I.add(v);
        }
    }
    for (const y of I)
      if (!(y in r)) {
        const g = new Xn(c);
        g.entryName = y, g.attr = 16, g.temporary = !0, t.push(g), r[g.entryName] = g, o.add(g);
      }
  }
  function h() {
    if (i = !0, r = {}, s.diskEntries > (n.length - s.offset) / Ee.Constants.CENHDR)
      throw Ee.Errors.DISK_ENTRY_TOO_LARGE();
    t = new Array(s.diskEntries);
    for (var I = s.offset, y = 0; y < t.length; y++) {
      var g = I, u = new Xn(c, n);
      u.header = n.slice(g, g += Ee.Constants.CENHDR), u.entryName = n.slice(g, g += u.header.fileNameLength), u.header.extraLength && (u.extra = n.slice(g, g += u.header.extraLength)), u.header.commentLength && (u.comment = n.slice(g, g + u.header.commentLength)), I += u.header.centralHeaderSize, t[y] = u, r[u.entryName] = u;
    }
    o.clear(), m();
  }
  function p(I) {
    var y = n.length - Ee.Constants.ENDHDR, g = Math.max(0, y - 65535), u = g, v = n.length, w = -1, A = 0;
    for ((typeof c.trailingSpace == "boolean" ? c.trailingSpace : !1) && (g = 0), y; y >= u; y--)
      if (n[y] === 80) {
        if (n.readUInt32LE(y) === Ee.Constants.ENDSIG) {
          w = y, A = y, v = y + Ee.Constants.ENDHDR, u = y - Ee.Constants.END64HDR;
          continue;
        }
        if (n.readUInt32LE(y) === Ee.Constants.END64SIG) {
          u = g;
          continue;
        }
        if (n.readUInt32LE(y) === Ee.Constants.ZIP64SIG) {
          w = y, v = y + Ee.readBigUInt64LE(n, y + Ee.Constants.ZIP64SIZE) + Ee.Constants.ZIP64LEAD;
          break;
        }
      }
    if (w == -1)
      throw Ee.Errors.INVALID_FORMAT();
    s.loadFromBinary(n.slice(w, v)), s.commentLength && (a = n.slice(A + Ee.Constants.ENDHDR)), I && h();
  }
  function f() {
    t.length > 1 && !d && t.sort((I, y) => I.entryName.toLowerCase().localeCompare(y.entryName.toLowerCase()));
  }
  return {
    /**
     * Returns an array of ZipEntry objects existent in the current opened archive
     * @return Array
     */
    get entries() {
      return i || h(), t.filter((I) => !o.has(I));
    },
    /**
     * Archive comment
     * @return {String}
     */
    get comment() {
      return l.decode(a);
    },
    set comment(I) {
      a = Ee.toBuffer(I, l.encode), s.commentLength = a.length;
    },
    getEntryCount: function() {
      return i ? t.length : s.diskEntries;
    },
    forEach: function(I) {
      this.entries.forEach(I);
    },
    /**
     * Returns a reference to the entry with the given name or null if entry is inexistent
     *
     * @param entryName
     * @return ZipEntry
     */
    getEntry: function(I) {
      return i || h(), r[I] || null;
    },
    /**
     * Adds the given entry to the entry list
     *
     * @param entry
     */
    setEntry: function(I) {
      i || h(), t.push(I), r[I.entryName] = I, s.totalEntries = t.length;
    },
    /**
     * Removes the file with the given name from the entry list.
     *
     * If the entry is a directory, then all nested files and directories will be removed
     * @param entryName
     * @returns {void}
     */
    deleteFile: function(I, y = !0) {
      i || h();
      const g = r[I];
      this.getEntryChildren(g, y).map((v) => v.entryName).forEach(this.deleteEntry);
    },
    /**
     * Removes the entry with the given name from the entry list.
     *
     * @param {string} entryName
     * @returns {void}
     */
    deleteEntry: function(I) {
      i || h();
      const y = r[I], g = t.indexOf(y);
      g >= 0 && (t.splice(g, 1), delete r[I], s.totalEntries = t.length);
    },
    /**
     *  Iterates and returns all nested files and directories of the given entry
     *
     * @param entry
     * @return Array
     */
    getEntryChildren: function(I, y = !0) {
      if (i || h(), typeof I == "object")
        if (I.isDirectory && y) {
          const g = [], u = I.entryName;
          for (const v of t)
            v.entryName.startsWith(u) && g.push(v);
          return g;
        } else
          return [I];
      return [];
    },
    /**
     *  How many child elements entry has
     *
     * @param {ZipEntry} entry
     * @return {integer}
     */
    getChildCount: function(I) {
      if (I && I.isDirectory) {
        const y = this.getEntryChildren(I);
        return y.includes(I) ? y.length - 1 : y.length;
      }
      return 0;
    },
    /**
     * Returns the zip file
     *
     * @return Buffer
     */
    compressToBuffer: function() {
      i || h(), f();
      const I = [], y = [];
      let g = 0, u = 0;
      s.size = 0, s.offset = 0;
      let v = 0;
      for (const T of this.entries) {
        const E = T.getCompressedData();
        T.header.offset = u;
        const C = T.packLocalHeader(), _ = C.length + E.length;
        u += _, I.push(C), I.push(E);
        const L = T.packCentralHeader();
        y.push(L), s.size += L.length, g += _ + L.length, v++;
      }
      g += s.mainHeaderSize, s.offset = u, s.totalEntries = v, u = 0;
      const w = Buffer.alloc(g);
      for (const T of I)
        T.copy(w, u), u += T.length;
      for (const T of y)
        T.copy(w, u), u += T.length;
      const A = s.toBinary();
      return a && a.copy(A, Ee.Constants.ENDHDR), A.copy(w, u), n = w, i = !1, w;
    },
    toAsyncBuffer: function(I, y, g, u) {
      try {
        i || h(), f();
        const v = [], w = [];
        let A = 0, T = 0, E = 0;
        s.size = 0, s.offset = 0;
        const C = function(_) {
          if (_.length > 0) {
            const L = _.shift(), V = L.entryName + L.extra.toString();
            g && g(V), L.getCompressedDataAsync(function(B) {
              u && u(V), L.header.offset = T;
              const se = L.packLocalHeader(), W = se.length + B.length;
              T += W, v.push(se), v.push(B);
              const Q = L.packCentralHeader();
              w.push(Q), s.size += Q.length, A += W + Q.length, E++, C(_);
            });
          } else {
            A += s.mainHeaderSize, s.offset = T, s.totalEntries = E, T = 0;
            const L = Buffer.alloc(A);
            v.forEach(function(B) {
              B.copy(L, T), T += B.length;
            }), w.forEach(function(B) {
              B.copy(L, T), T += B.length;
            });
            const V = s.toBinary();
            a && a.copy(V, Ee.Constants.ENDHDR), V.copy(L, T), n = L, i = !1, I(L);
          }
        };
        C(Array.from(this.entries));
      } catch (v) {
        y(v);
      }
    }
  };
};
const he = Ut, fe = Ke, _c = Ma, Rc = xc, lt = (...n) => he.findLast(n, (e) => typeof e == "boolean"), Gn = (...n) => he.findLast(n, (e) => typeof e == "string"), Dc = (...n) => he.findLast(n, (e) => typeof e == "function"), Oc = {
  // option "noSort" : if true it disables files sorting
  noSort: !1,
  // read entries during load (initial loading may be slower)
  readEntries: !1,
  // default method is none
  method: he.Constants.NONE,
  // file system
  fs: null
};
var kc = function(n, e) {
  let t = null;
  const r = Object.assign(/* @__PURE__ */ Object.create(null), Oc);
  n && typeof n == "object" && (n instanceof Uint8Array || (Object.assign(r, n), n = r.input ? r.input : void 0, r.input && delete r.input), Buffer.isBuffer(n) && (t = n, r.method = he.Constants.BUFFER, n = void 0)), Object.assign(r, e);
  const a = new he(r);
  if ((typeof r.decoder != "object" || typeof r.decoder.encode != "function" || typeof r.decoder.decode != "function") && (r.decoder = he.decoder), n && typeof n == "string")
    if (a.fs.existsSync(n))
      r.method = he.Constants.FILE, r.filename = n, t = a.fs.readFileSync(n);
    else
      throw he.Errors.INVALID_FILENAME();
  const s = new Rc(t, r), { canonical: i, sanitize: o, zipnamefix: c } = he;
  function d(p) {
    if (p && s) {
      var f;
      if (typeof p == "string" && (f = s.getEntry(fe.posix.normalize(p))), typeof p == "object" && typeof p.entryName < "u" && typeof p.header < "u" && (f = s.getEntry(p.entryName)), f)
        return f;
    }
    return null;
  }
  function l(p) {
    const { join: f, normalize: I, sep: y } = fe.posix;
    return f(".", I(y + p.split("\\").join(y) + y));
  }
  function m(p) {
    return p instanceof RegExp ? /* @__PURE__ */ function(f) {
      return function(I) {
        return f.test(I);
      };
    }(p) : typeof p != "function" ? () => !0 : p;
  }
  const h = (p, f) => {
    let I = f.slice(-1);
    return I = I === a.sep ? a.sep : "", fe.relative(p, f) + I;
  };
  return {
    /**
     * Extracts the given entry from the archive and returns the content as a Buffer object
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {Buffer|string} [pass] - password
     * @return Buffer or Null in case of error
     */
    readFile: function(p, f) {
      var I = d(p);
      return I && I.getData(f) || null;
    },
    /**
     * Returns how many child elements has on entry (directories) on files it is always 0
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @returns {integer}
     */
    childCount: function(p) {
      const f = d(p);
      if (f)
        return s.getChildCount(f);
    },
    /**
     * Asynchronous readFile
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {callback} callback
     *
     * @return Buffer or Null in case of error
     */
    readFileAsync: function(p, f) {
      var I = d(p);
      I ? I.getDataAsync(f) : f(null, "getEntry failed for:" + p);
    },
    /**
     * Extracts the given entry from the archive and returns the content as plain text in the given encoding
     * @param {ZipEntry|string} entry - ZipEntry object or String with the full path of the entry
     * @param {string} encoding - Optional. If no encoding is specified utf8 is used
     *
     * @return String
     */
    readAsText: function(p, f) {
      var I = d(p);
      if (I) {
        var y = I.getData();
        if (y && y.length)
          return y.toString(f || "utf8");
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
    readAsTextAsync: function(p, f, I) {
      var y = d(p);
      y ? y.getDataAsync(function(g, u) {
        if (u) {
          f(g, u);
          return;
        }
        g && g.length ? f(g.toString(I || "utf8")) : f("");
      }) : f("");
    },
    /**
     * Remove the entry from the file or the entry and all it's nested directories and files if the given entry is a directory
     *
     * @param {ZipEntry|string} entry
     * @returns {void}
     */
    deleteFile: function(p, f = !0) {
      var I = d(p);
      I && s.deleteFile(I.entryName, f);
    },
    /**
     * Remove the entry from the file or directory without affecting any nested entries
     *
     * @param {ZipEntry|string} entry
     * @returns {void}
     */
    deleteEntry: function(p) {
      var f = d(p);
      f && s.deleteEntry(f.entryName);
    },
    /**
     * Adds a comment to the zip. The zip must be rewritten after adding the comment.
     *
     * @param {string} comment
     */
    addZipComment: function(p) {
      s.comment = p;
    },
    /**
     * Returns the zip comment
     *
     * @return String
     */
    getZipComment: function() {
      return s.comment || "";
    },
    /**
     * Adds a comment to a specified zipEntry. The zip must be rewritten after adding the comment
     * The comment cannot exceed 65535 characters in length
     *
     * @param {ZipEntry} entry
     * @param {string} comment
     */
    addZipEntryComment: function(p, f) {
      var I = d(p);
      I && (I.comment = f);
    },
    /**
     * Returns the comment of the specified entry
     *
     * @param {ZipEntry} entry
     * @return String
     */
    getZipEntryComment: function(p) {
      var f = d(p);
      return f && f.comment || "";
    },
    /**
     * Updates the content of an existing entry inside the archive. The zip must be rewritten after updating the content
     *
     * @param {ZipEntry} entry
     * @param {Buffer} content
     */
    updateFile: function(p, f) {
      var I = d(p);
      I && I.setData(f);
    },
    /**
     * Adds a file from the disk to the archive
     *
     * @param {string} localPath File to add to zip
     * @param {string} [zipPath] Optional path inside the zip
     * @param {string} [zipName] Optional name for the file
     * @param {string} [comment] Optional file comment
     */
    addLocalFile: function(p, f, I, y) {
      if (a.fs.existsSync(p)) {
        f = f ? l(f) : "";
        const g = fe.win32.basename(fe.win32.normalize(p));
        f += I || g;
        const u = a.fs.statSync(p), v = u.isFile() ? a.fs.readFileSync(p) : Buffer.alloc(0);
        u.isDirectory() && (f += a.sep), this.addFile(f, v, y, u);
      } else
        throw he.Errors.FILE_NOT_FOUND(p);
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
    addLocalFileAsync: function(p, f) {
      p = typeof p == "object" ? p : { localPath: p };
      const I = fe.resolve(p.localPath), { comment: y } = p;
      let { zipPath: g, zipName: u } = p;
      const v = this;
      a.fs.stat(I, function(w, A) {
        if (w)
          return f(w, !1);
        g = g ? l(g) : "";
        const T = fe.win32.basename(fe.win32.normalize(I));
        if (g += u || T, A.isFile())
          a.fs.readFile(I, function(E, C) {
            return E ? f(E, !1) : (v.addFile(g, C, y, A), setImmediate(f, void 0, !0));
          });
        else if (A.isDirectory())
          return g += a.sep, v.addFile(g, Buffer.alloc(0), y, A), setImmediate(f, void 0, !0);
      });
    },
    /**
     * Adds a local directory and all its nested files and directories to the archive
     *
     * @param {string} localPath - local path to the folder
     * @param {string} [zipPath] - optional path inside zip
     * @param {(RegExp|function)} [filter] - optional RegExp or Function if files match will be included.
     */
    addLocalFolder: function(p, f, I) {
      if (I = m(I), f = f ? l(f) : "", p = fe.normalize(p), a.fs.existsSync(p)) {
        const y = a.findFiles(p), g = this;
        if (y.length)
          for (const u of y) {
            const v = fe.join(f, h(p, u));
            I(v) && g.addLocalFile(u, fe.dirname(v));
          }
      } else
        throw he.Errors.FILE_NOT_FOUND(p);
    },
    /**
     * Asynchronous addLocalFolder
     * @param {string} localPath
     * @param {callback} callback
     * @param {string} [zipPath] optional path inside zip
     * @param {RegExp|function} [filter] optional RegExp or Function if files match will
     *               be included.
     */
    addLocalFolderAsync: function(p, f, I, y) {
      y = m(y), I = I ? l(I) : "", p = fe.normalize(p);
      var g = this;
      a.fs.open(p, "r", function(u) {
        if (u && u.code === "ENOENT")
          f(void 0, he.Errors.FILE_NOT_FOUND(p));
        else if (u)
          f(void 0, u);
        else {
          var v = a.findFiles(p), w = -1, A = function() {
            if (w += 1, w < v.length) {
              var T = v[w], E = h(p, T).split("\\").join("/");
              E = E.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, ""), y(E) ? a.fs.stat(T, function(C, _) {
                C && f(void 0, C), _.isFile() ? a.fs.readFile(T, function(L, V) {
                  L ? f(void 0, L) : (g.addFile(I + E, V, "", _), A());
                }) : (g.addFile(I + E + "/", Buffer.alloc(0), "", _), A());
              }) : process.nextTick(() => {
                A();
              });
            } else
              f(!0, void 0);
          };
          A();
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
    addLocalFolderAsync2: function(p, f) {
      const I = this;
      p = typeof p == "object" ? p : { localPath: p }, localPath = fe.resolve(l(p.localPath));
      let { zipPath: y, filter: g, namefix: u } = p;
      g instanceof RegExp ? g = /* @__PURE__ */ function(A) {
        return function(T) {
          return A.test(T);
        };
      }(g) : typeof g != "function" && (g = function() {
        return !0;
      }), y = y ? l(y) : "", u == "latin1" && (u = (A) => A.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "")), typeof u != "function" && (u = (A) => A);
      const v = (A) => fe.join(y, u(h(localPath, A))), w = (A) => fe.win32.basename(fe.win32.normalize(u(A)));
      a.fs.open(localPath, "r", function(A) {
        A && A.code === "ENOENT" ? f(void 0, he.Errors.FILE_NOT_FOUND(localPath)) : A ? f(void 0, A) : a.findFilesAsync(localPath, function(T, E) {
          if (T)
            return f(T);
          E = E.filter((C) => g(v(C))), E.length || f(void 0, !1), setImmediate(
            E.reverse().reduce(function(C, _) {
              return function(L, V) {
                if (L || V === !1)
                  return setImmediate(C, L, !1);
                I.addLocalFileAsync(
                  {
                    localPath: _,
                    zipPath: fe.dirname(v(_)),
                    zipName: w(_)
                  },
                  C
                );
              };
            }, f)
          );
        });
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
    addLocalFolderPromise: function(p, f) {
      return new Promise((I, y) => {
        this.addLocalFolderAsync2(Object.assign({ localPath: p }, f), (g, u) => {
          g && y(g), u && I(this);
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
    addFile: function(p, f, I, y) {
      p = c(p);
      let g = d(p);
      const u = g != null;
      u || (g = new _c(r), g.entryName = p), g.comment = I || "";
      const v = typeof y == "object" && y instanceof a.fs.Stats;
      v && (g.header.time = y.mtime);
      var w = g.isDirectory ? 16 : 0;
      let A = g.isDirectory ? 16384 : 32768;
      return v ? A |= 4095 & y.mode : typeof y == "number" ? A |= 4095 & y : A |= g.isDirectory ? 493 : 420, w = (w | A << 16) >>> 0, g.attr = w, g.setData(f), u || s.setEntry(g), g;
    },
    /**
     * Returns an array of ZipEntry objects representing the files and folders inside the archive
     *
     * @param {string} [password]
     * @returns Array
     */
    getEntries: function(p) {
      return s.password = p, s ? s.entries : [];
    },
    /**
     * Returns a ZipEntry object representing the file or folder specified by ``name``.
     *
     * @param {string} name
     * @return ZipEntry
     */
    getEntry: function(p) {
      return d(p);
    },
    getEntryCount: function() {
      return s.getEntryCount();
    },
    forEach: function(p) {
      return s.forEach(p);
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
    extractEntryTo: function(p, f, I, y, g, u) {
      y = lt(!1, y), g = lt(!1, g), I = lt(!0, I), u = Gn(g, u);
      var v = d(p);
      if (!v)
        throw he.Errors.NO_ENTRY();
      var w = i(v.entryName), A = o(f, u && !v.isDirectory ? u : I ? w : fe.basename(w));
      if (v.isDirectory) {
        var T = s.getEntryChildren(v);
        return T.forEach(function(_) {
          if (_.isDirectory)
            return;
          var L = _.getData();
          if (!L)
            throw he.Errors.CANT_EXTRACT_FILE();
          var V = i(_.entryName), B = o(f, I ? V : fe.basename(V));
          const se = g ? _.header.fileAttr : void 0;
          a.writeFileTo(B, L, y, se);
        }), !0;
      }
      var E = v.getData(s.password);
      if (!E)
        throw he.Errors.CANT_EXTRACT_FILE();
      if (a.fs.existsSync(A) && !y)
        throw he.Errors.CANT_OVERRIDE();
      const C = g ? p.header.fileAttr : void 0;
      return a.writeFileTo(A, E, y, C), !0;
    },
    /**
     * Test the archive
     * @param {string} [pass]
     */
    test: function(p) {
      if (!s)
        return !1;
      for (var f in s.entries)
        try {
          if (f.isDirectory)
            continue;
          var I = s.entries[f].getData(p);
          if (!I)
            return !1;
        } catch {
          return !1;
        }
      return !0;
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
    extractAllTo: function(p, f, I, y) {
      if (I = lt(!1, I), y = Gn(I, y), f = lt(!1, f), !s)
        throw he.Errors.NO_ZIP();
      s.entries.forEach(function(g) {
        var u = o(p, i(g.entryName));
        if (g.isDirectory) {
          a.makeDir(u);
          return;
        }
        var v = g.getData(y);
        if (!v)
          throw he.Errors.CANT_EXTRACT_FILE();
        const w = I ? g.header.fileAttr : void 0;
        a.writeFileTo(u, v, f, w);
        try {
          a.fs.utimesSync(u, g.header.time, g.header.time);
        } catch {
          throw he.Errors.CANT_EXTRACT_FILE();
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
    extractAllToAsync: function(p, f, I, y) {
      if (y = Dc(f, I, y), I = lt(!1, I), f = lt(!1, f), !y)
        return new Promise((A, T) => {
          this.extractAllToAsync(p, f, I, function(E) {
            E ? T(E) : A(this);
          });
        });
      if (!s) {
        y(he.Errors.NO_ZIP());
        return;
      }
      p = fe.resolve(p);
      const g = (A) => o(p, fe.normalize(i(A.entryName))), u = (A, T) => new Error(A + ': "' + T + '"'), v = [], w = [];
      s.entries.forEach((A) => {
        A.isDirectory ? v.push(A) : w.push(A);
      });
      for (const A of v) {
        const T = g(A), E = I ? A.header.fileAttr : void 0;
        try {
          a.makeDir(T), E && a.fs.chmodSync(T, E), a.fs.utimesSync(T, A.header.time, A.header.time);
        } catch {
          y(u("Unable to create folder", T));
        }
      }
      w.reverse().reduce(function(A, T) {
        return function(E) {
          if (E)
            A(E);
          else {
            const C = fe.normalize(i(T.entryName)), _ = o(p, C);
            T.getDataAsync(function(L, V) {
              if (V)
                A(V);
              else if (!L)
                A(he.Errors.CANT_EXTRACT_FILE());
              else {
                const B = I ? T.header.fileAttr : void 0;
                a.writeFileToAsync(_, L, f, B, function(se) {
                  se || A(u("Unable to write file", _)), a.fs.utimes(_, T.header.time, T.header.time, function(W) {
                    W ? A(u("Unable to set times", _)) : A();
                  });
                });
              }
            });
          }
        };
      }, y)();
    },
    /**
     * Writes the newly created zip file to disk at the specified location or if a zip was opened and no ``targetFileName`` is provided, it will overwrite the opened zip
     *
     * @param {string} targetFileName
     * @param {function} callback
     */
    writeZip: function(p, f) {
      if (arguments.length === 1 && typeof p == "function" && (f = p, p = ""), !p && r.filename && (p = r.filename), !!p) {
        var I = s.compressToBuffer();
        if (I) {
          var y = a.writeFileTo(p, I, !0);
          typeof f == "function" && f(y ? null : new Error("failed"), "");
        }
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
    writeZipPromise: function(p, f) {
      const { overwrite: I, perm: y } = Object.assign({ overwrite: !0 }, f);
      return new Promise((g, u) => {
        !p && r.filename && (p = r.filename), p || u("ADM-ZIP: ZIP File Name Missing"), this.toBufferPromise().then((v) => {
          const w = (A) => A ? g(A) : u("ADM-ZIP: Wasn't able to write zip file");
          a.writeFileToAsync(p, v, I, y, w);
        }, u);
      });
    },
    /**
     * @returns {Promise<Buffer>} A promise to the Buffer.
     */
    toBufferPromise: function() {
      return new Promise((p, f) => {
        s.toAsyncBuffer(p, f);
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
    toBuffer: function(p, f, I, y) {
      return typeof p == "function" ? (s.toAsyncBuffer(p, f, I, y), null) : s.compressToBuffer();
    }
  };
};
const Kn = /* @__PURE__ */ sc(kc);
class Lc {
  getBackupDir() {
    return Ke.join(j.getPath("userData"), "backups");
  }
  getAutoBackupDir() {
    return Ke.join(this.getBackupDir(), "auto");
  }
  ensureBackupDirs() {
    const e = this.getBackupDir(), t = this.getAutoBackupDir();
    z.existsSync(e) || z.mkdirSync(e, { recursive: !0 }), z.existsSync(t) || z.mkdirSync(t, { recursive: !0 });
  }
  // --- Encryption Helpers ---
  deriveKey(e, t) {
    return vt.pbkdf2Sync(e, t, 1e5, 32, "sha256");
  }
  encryptData(e, t) {
    const r = vt.randomBytes(16), a = vt.randomBytes(12), s = this.deriveKey(t, r), i = vt.createCipheriv("aes-256-gcm", s, a), o = Buffer.concat([i.update(e), i.final()]), c = i.getAuthTag();
    return {
      encryptedData: o,
      salt: r.toString("hex"),
      iv: a.toString("hex"),
      authTag: c.toString("hex")
    };
  }
  decryptData(e, t, r) {
    const a = Buffer.from(r.salt, "hex"), s = Buffer.from(r.iv, "hex"), i = Buffer.from(r.authTag, "hex"), o = this.deriveKey(t, a), c = vt.createDecipheriv("aes-256-gcm", o, s);
    return c.setAuthTag(i), Buffer.concat([c.update(e), c.final()]);
  }
  // --- Core Logic ---
  // 1. Export Data
  async exportData(e, t) {
    const [r, a, s, i, o, c, d, l, m] = await Promise.all([
      S.novel.findMany(),
      S.volume.findMany(),
      S.chapter.findMany(),
      S.character.findMany(),
      S.idea.findMany(),
      S.tag.findMany(),
      S.agentConversation.findMany(),
      S.agentMessage.findMany(),
      S.agentAttachment.findMany()
    ]), h = {
      novels: r,
      volumes: a,
      chapters: s,
      characters: i,
      ideas: o,
      tags: c,
      agentConversations: d,
      agentMessages: l,
      agentAttachments: m
    }, p = Buffer.from(JSON.stringify(h)), f = new Kn(), I = {
      version: 1,
      appVersion: j.getVersion(),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      platform: process.platform,
      encrypted: !!t
    };
    if (t) {
      const { encryptedData: y, salt: g, iv: u, authTag: v } = this.encryptData(p, t);
      I.encryption = { algo: "aes-256-gcm", salt: g, iv: u, authTag: v }, f.addFile("data.bin", y);
    } else
      f.addFile("data.json", p);
    if (f.addFile("manifest.json", Buffer.from(JSON.stringify(I, null, 2))), !e) {
      const { filePath: y } = await ht.showSaveDialog({
        title: "Export Backup",
        defaultPath: `NovelData_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")}.nebak`,
        filters: [{ name: "CloudDream Novel Agent Backup", extensions: ["nebak"] }]
      });
      if (!y)
        throw new Error("Export cancelled");
      e = y;
    }
    return f.writeZip(e), e;
  }
  // 2. Import Data (Restore)
  async importData(e, t) {
    const r = new Kn(e), a = r.getEntry("manifest.json");
    if (!a)
      throw new Error("Invalid backup file: manifest.json missing");
    const s = JSON.parse(a.getData().toString("utf8"));
    let i;
    if (s.encrypted) {
      if (!t)
        throw new Error("PASSWORD_REQUIRED");
      const o = r.getEntry("data.bin");
      if (!o)
        throw new Error("Invalid backup file: data.bin missing");
      if (!s.encryption)
        throw new Error("Invalid backup file: encryption metadata missing");
      try {
        const c = this.decryptData(o.getData(), t, s.encryption);
        i = JSON.parse(c.toString("utf8"));
      } catch {
        throw new Error("PASSWORD_INVALID");
      }
    } else {
      const o = r.getEntry("data.json");
      if (!o)
        throw new Error("Invalid backup file: data.json missing");
      i = JSON.parse(o.getData().toString("utf8"));
    }
    await this.performRestore(i);
  }
  // Helper: Perform Restore (Transactional)
  async performRestore(e) {
    await this.createAutoBackup(), await S.$transaction(async (t) => {
      var r, a, s, i, o, c, d, l, m;
      if (await t.agentAttachment.deleteMany(), await t.agentMessage.deleteMany(), await t.agentConversation.deleteMany(), await t.tag.deleteMany(), await t.idea.deleteMany(), await t.character.deleteMany(), await t.chapter.deleteMany(), await t.volume.deleteMany(), await t.novel.deleteMany(), (r = e.novels) != null && r.length)
        for (const h of e.novels)
          await t.novel.create({ data: h });
      if ((a = e.volumes) != null && a.length)
        for (const h of e.volumes)
          await t.volume.create({ data: h });
      if ((s = e.chapters) != null && s.length)
        for (const h of e.chapters)
          await t.chapter.create({ data: h });
      if ((i = e.characters) != null && i.length)
        for (const h of e.characters)
          await t.character.create({ data: h });
      if ((o = e.ideas) != null && o.length)
        for (const h of e.ideas)
          await t.idea.create({ data: h });
      if ((c = e.tags) != null && c.length)
        for (const h of e.tags)
          await t.tag.create({ data: h });
      if ((d = e.agentConversations) != null && d.length)
        for (const h of e.agentConversations)
          await t.agentConversation.create({ data: h });
      if ((l = e.agentMessages) != null && l.length)
        for (const h of e.agentMessages)
          await t.agentMessage.create({ data: h });
      if ((m = e.agentAttachments) != null && m.length)
        for (const h of e.agentAttachments)
          await t.agentAttachment.create({ data: h });
    }, {
      maxWait: 1e4,
      timeout: 2e4
    });
  }
  // 3. Auto Backup Logic
  async createAutoBackup() {
    try {
      this.ensureBackupDirs();
      const t = `auto_backup_${Date.now()}.nebak`, r = Ke.join(this.getAutoBackupDir(), t);
      await this.exportData(r), console.log("[BackupService] Auto-backup created:", t), await this.rotateAutoBackups();
    } catch (e) {
      console.error("[BackupService] Failed to create auto-backup:", e);
    }
  }
  async rotateAutoBackups() {
    this.ensureBackupDirs();
    const e = this.getAutoBackupDir(), r = z.readdirSync(e).filter((a) => a.endsWith(".nebak")).map((a) => ({
      name: a,
      time: z.statSync(Ke.join(e, a)).mtime.getTime()
    })).sort((a, s) => s.time - a.time).slice(3);
    for (const a of r)
      z.unlinkSync(Ke.join(e, a.name)), console.log("[BackupService] Rotated auto-backup:", a.name);
  }
  // 4. List Auto Backups
  async getAutoBackups() {
    this.ensureBackupDirs();
    const e = this.getAutoBackupDir();
    return z.readdirSync(e).filter((t) => t.endsWith(".nebak")).map((t) => {
      const r = z.statSync(Ke.join(e, t));
      return {
        filename: t,
        createdAt: r.mtime.getTime(),
        size: r.size
      };
    }).sort((t, r) => r.createdAt - t.createdAt);
  }
  // 5. Restore from Auto Backup
  async restoreAutoBackup(e) {
    this.ensureBackupDirs();
    const t = Ke.join(this.getAutoBackupDir(), e);
    if (!z.existsSync(t))
      throw new Error("Backup file not found");
    await this.importData(t);
  }
}
const lr = new Lc(), kt = D.dirname(Za(import.meta.url));
process.env.APP_ROOT = D.join(kt, "..");
const Br = process.env.VITE_DEV_SERVER_URL, fd = D.join(process.env.APP_ROOT, "dist-electron"), Pa = D.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = Br ? D.join(process.env.APP_ROOT, "public") : Pa;
process.on("uncaughtException", (n) => {
  Se("Main.uncaughtException", n), console.error("[Main] Uncaught Exception:", n), j.quit(), process.exit(1);
});
process.on("unhandledRejection", (n, e) => {
  Se("Main.unhandledRejection", n, { promise: String(e) }), console.error("[Main] Unhandled Rejection at:", e, "reason:", n), j.quit(), process.exit(1);
});
let q, Zn = !1;
const Ua = "云梦小说智能体", Mc = "云梦小说编辑器", Pc = "CloudDream Novel Agent Dev";
function Uc() {
  return j.isPackaged && process.platform === "win32" ? process.execPath : "com.noveleditor.app";
}
function Gr() {
  return j.isPackaged && typeof process.env.PORTABLE_EXECUTABLE_DIR == "string" && process.env.PORTABLE_EXECUTABLE_DIR.length > 0;
}
function $a() {
  return D.join(D.dirname(j.getPath("exe")), "data");
}
function $c() {
  const n = process.env.PORTABLE_EXECUTABLE_DIR;
  return n ? D.join(n, "data") : $a();
}
function Ba(n, e) {
  if (!z.existsSync(n))
    return;
  z.existsSync(e) || z.mkdirSync(e, { recursive: !0 });
  const t = z.readdirSync(n, { withFileTypes: !0 });
  for (const r of t) {
    const a = D.join(n, r.name), s = D.join(e, r.name);
    if (!z.existsSync(s)) {
      if (r.isDirectory()) {
        z.cpSync(a, s, { recursive: !0 });
        continue;
      }
      z.copyFileSync(a, s);
    }
  }
}
function Bc() {
  if (!j.isPackaged || Gr())
    return;
  const n = $a(), e = j.getPath("userData"), t = D.join(n, "novel_editor.db"), r = D.join(e, "novel_editor.db");
  !z.existsSync(t) || z.existsSync(r) || (Ba(n, e), console.log("[Main] Migrated legacy packaged data from exe/data to userData."));
}
function Fc() {
  if (!j.isPackaged || Gr())
    return;
  const n = j.getPath("appData"), e = D.join(n, Mc), t = j.getPath("userData"), r = D.join(e, "novel_editor.db"), a = D.join(t, "novel_editor.db");
  !z.existsSync(r) || z.existsSync(a) || (Ba(e, t), console.log("[Main] Migrated legacy product data from old app name to current userData."));
}
function qc() {
  if (j.isPackaged) {
    const t = D.join(process.resourcesPath, "icon_ink_pen_256.ico");
    return z.existsSync(t) ? t : void 0;
  }
  const n = D.join(process.env.APP_ROOT || "", "build", "icon_ink_pen_256.ico");
  if (z.existsSync(n))
    return n;
  const e = D.join(process.env.VITE_PUBLIC || "", "electron-vite.svg");
  return z.existsSync(e) ? e : void 0;
}
function jc() {
  const n = j.getPath("appData");
  return j.isPackaged ? D.join(n, Ua) : D.join(n, "@novel-editor", "desktop-dev");
}
function Yn(n) {
  return n ? /[ \t"]/u.test(n) ? `"${n.replace(/"/gu, '\\"')}"` : n : '""';
}
function Vc() {
  return j.isPackaged ? process.platform === "win32" ? D.join(process.resourcesPath, "mcp", "novel-editor-mcp.cmd") : D.join(process.resourcesPath, "mcp", "novel-editor-mcp.mjs") : process.platform === "win32" ? D.join(process.env.APP_ROOT || "", "scripts", "novel-editor-mcp.cmd") : D.join(process.env.APP_ROOT || "", "scripts", "novel-editor-mcp.mjs");
}
function Fa() {
  const n = Vc(), e = z.existsSync(n), t = "novel_editor", r = 60, a = 120, s = process.platform === "win32" ? "cmd" : "node", i = process.platform === "win32" ? ["/c", n] : [n], o = process.platform === "win32" ? [
    `[mcp_servers.${t}]`,
    'command = "cmd"',
    `args = ["/c", "${n.replace(/\\/gu, "\\\\")}"]`,
    `startup_timeout_sec = ${r}`,
    `tool_timeout_sec = ${a}`
  ].join(`
`) : [
    `[mcp_servers.${t}]`,
    'command = "node"',
    `args = ["${n}"]`,
    `startup_timeout_sec = ${r}`,
    `tool_timeout_sec = ${a}`
  ].join(`
`), c = process.platform === "win32" ? `claude mcp add novel-editor --scope local -- cmd /c ${Yn(n)}` : `claude mcp add novel-editor --scope local -- node ${Yn(n)}`, d = JSON.stringify(
    {
      mcpServers: {
        [t]: {
          command: s,
          args: i
        }
      }
    },
    null,
    2
  );
  return {
    commandPath: n,
    launcherExists: e,
    command: s,
    args: i,
    codexToml: o,
    claudeCommand: c,
    jsonConfig: d
  };
}
function qa() {
  return D.join(j.getPath("userData"), "automation", "runtime.json");
}
function Jc() {
  const n = qa();
  if (!z.existsSync(n))
    throw new Error(`Automation runtime file not found: ${n}`);
  let e;
  try {
    e = JSON.parse(z.readFileSync(n, "utf8"));
  } catch (r) {
    throw new Error(`Failed to parse automation runtime: ${(r == null ? void 0 : r.message) || "unknown error"}`);
  }
  const t = e;
  if (!t || typeof t != "object")
    throw new Error("Automation runtime is empty");
  if (!Number.isFinite(t.port) || !t.port || t.port <= 0)
    throw new Error("Automation runtime port is invalid");
  if (typeof t.token != "string" || !t.token.trim())
    throw new Error("Automation runtime token is invalid");
  return {
    version: Number(t.version || 1),
    port: Number(t.port),
    token: t.token,
    pid: Number(t.pid || 0),
    startedAt: String(t.startedAt || "")
  };
}
async function Hc(n) {
  const t = JSON.stringify({
    method: "novel.list",
    params: {},
    origin: "desktop-ui"
  });
  return await new Promise((r, a) => {
    const s = ar.request(
      {
        hostname: "127.0.0.1",
        port: n.port,
        path: "/invoke",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(t, "utf8"),
          Authorization: `Bearer ${n.token}`
        }
      },
      (i) => {
        const o = [];
        i.on("data", (c) => o.push(Buffer.isBuffer(c) ? c : Buffer.from(c))), i.on("end", () => {
          const c = Buffer.concat(o).toString("utf8");
          try {
            r(JSON.parse(c));
          } catch (d) {
            a(new Error(`Automation health response parse failed: ${(d == null ? void 0 : d.message) || "unknown error"}`));
          }
        });
      }
    );
    s.setTimeout(8e3, () => {
      s.destroy(new Error("Automation health request timeout"));
    }), s.on("error", (i) => a(i)), s.write(t), s.end();
  });
}
async function zc() {
  const n = Fa();
  if (!n.launcherExists)
    return { ok: !1, detail: `MCP launcher missing: ${n.commandPath}` };
  let e;
  try {
    e = Jc();
  } catch (t) {
    return { ok: !1, detail: (t == null ? void 0 : t.message) || "Automation runtime unavailable" };
  }
  try {
    const t = await Hc(e);
    return t != null && t.ok ? {
      ok: !0,
      detail: `MCP bridge ready. launcher=ok runtime=ok invoke=ok novels=${Array.isArray(t.data) ? t.data.length : 0}`
    } : {
      ok: !1,
      detail: `Automation invoke failed: ${(t == null ? void 0 : t.code) || "UNKNOWN"} ${(t == null ? void 0 : t.message) || ""}`.trim()
    };
  } catch (t) {
    return { ok: !1, detail: `Automation invoke error: ${(t == null ? void 0 : t.message) || "unknown error"}` };
  }
}
function Wc(n) {
  const e = n.indexOf("--ai-diag");
  if (e < 0)
    return {};
  const t = n.slice(e + 1);
  if (t.length === 0)
    return { error: "Missing diagnostic action. Use: --ai-diag smoke <mcp|skill> [--json] [--db <path>] [--user-data <path>] or --ai-diag coverage [--json] [--db <path>] [--user-data <path>]" };
  const r = [];
  let a = !1, s, i;
  for (let d = 0; d < t.length; d += 1) {
    const l = t[d];
    if (l === "--json") {
      a = !0;
      continue;
    }
    if (l === "--db") {
      const m = t[d + 1];
      if (!m)
        return { error: "Missing value for --db" };
      s = m, d += 1;
      continue;
    }
    if (l === "--user-data") {
      const m = t[d + 1];
      if (!m)
        return { error: "Missing value for --user-data" };
      i = m, d += 1;
      continue;
    }
    if (l.startsWith("--"))
      return { error: `Unknown option: ${l}` };
    r.push(l);
  }
  const [o, c] = r;
  return o === "coverage" ? { command: { action: "coverage", json: a, dbPath: s, userDataPath: i } } : o === "smoke" ? c !== "mcp" && c !== "skill" ? { error: "Smoke mode requires kind: mcp | skill" } : { command: { action: "smoke", kind: c, json: a, dbPath: s, userDataPath: i } } : { error: `Unknown diagnostic action: ${o}` };
}
function Xc(n, e) {
  if (e.action === "coverage") {
    const a = n;
    return [
      `[AI-Diag] Coverage ${a.overallCoverage}% (${a.totalSupported}/${a.totalRequired})`,
      ...a.modules.map((i) => {
        const o = i.missingActions.length ? ` missing=[${i.missingActions.join(", ")}]` : "";
        return `- ${i.title}: ${i.coverage}% (${i.supportedActions.length}/${i.requiredActions.length})${o}`;
      })
    ].join(`
`);
  }
  const t = n;
  return [
    `[AI-Diag] Smoke ${t.kind.toUpperCase()} ${t.ok ? "PASSED" : "FAILED"}`,
    `detail: ${t.detail}`,
    t.missingActions.length ? `missingActions: ${t.missingActions.join(", ")}` : "missingActions: none",
    ...t.checks.map((a) => `- [${a.skipped ? "SKIPPED" : a.ok ? "OK" : "FAILED"}] ${a.actionId}: ${a.detail}`)
  ].join(`
`);
}
async function Gc(n, e) {
  const t = e.action === "coverage" ? n.getCapabilityCoverage() : await n.testOpenClawSmoke({ kind: e.kind });
  return e.json ? console.log(JSON.stringify(t, null, 2)) : console.log(Xc(t, e)), e.action === "smoke" && !t.ok ? 1 : 0;
}
function Qn() {
  if (!Hr() || Zn)
    return;
  Zn = !0;
  const n = console.error.bind(console), e = console.warn.bind(console);
  console.error = (...t) => {
    $("ERROR", "console.error", "console.error called", { args: ve(t) }), n(...t);
  }, console.warn = (...t) => {
    $("WARN", "console.warn", "console.warn called", { args: ve(t) }), e(...t);
  };
}
function te(n, e, t) {
  const r = He(t);
  Se(`Main.${n}`, t, {
    payload: ve(e),
    normalizedError: r,
    displayMessage: At(r.code, r.message)
  });
}
const We = Wc(process.argv);
async function ja(n) {
  const e = n == null ? void 0 : n.proxy;
  if (!e || !$t.defaultSession)
    return;
  const t = () => {
    delete process.env.HTTP_PROXY, delete process.env.http_proxy, delete process.env.HTTPS_PROXY, delete process.env.https_proxy, delete process.env.ALL_PROXY, delete process.env.all_proxy, delete process.env.NO_PROXY, delete process.env.no_proxy;
  }, r = () => {
    e.httpProxy && (process.env.HTTP_PROXY = e.httpProxy, process.env.http_proxy = e.httpProxy), e.httpsProxy && (process.env.HTTPS_PROXY = e.httpsProxy, process.env.https_proxy = e.httpsProxy), e.allProxy && (process.env.ALL_PROXY = e.allProxy, process.env.all_proxy = e.allProxy), e.noProxy && (process.env.NO_PROXY = e.noProxy, process.env.no_proxy = e.noProxy);
  };
  if (e.mode === "off") {
    await $t.defaultSession.setProxy({ mode: "direct" }), t();
    return;
  }
  if (e.mode === "custom") {
    const a = [e.allProxy, e.httpsProxy, e.httpProxy].filter((s) => !!s).join(";");
    await $t.defaultSession.setProxy({
      mode: a ? "fixed_servers" : "direct",
      proxyRules: a,
      proxyBypassRules: e.noProxy || ""
    }), t(), r();
    return;
  }
  await $t.defaultSession.setProxy({ mode: "system" }), t();
}
function Va() {
  const n = !j.isPackaged, e = qc();
  q = new ea({
    width: 1200,
    height: 800,
    ...e ? { icon: e } : {},
    webPreferences: {
      preload: D.join(kt, "preload.mjs"),
      devTools: n
    },
    // Win11 style & White Screen Fix
    frame: !0,
    titleBarStyle: "default",
    backgroundColor: "#0a0a0f",
    // Match App Theme
    show: !1,
    // Wait for ready-to-show
    autoHideMenuBar: !0
    // Hide default menu bar
  }), q.once("ready-to-show", () => {
    q == null || q.show();
  }), q.webContents.on("did-finish-load", () => {
    q == null || q.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), q.webContents.on("devtools-opened", () => {
    n || q == null || q.webContents.closeDevTools();
  }), q.webContents.on("before-input-event", (t, r) => {
    r.key === "F11" && (q == null || q.setFullScreen(!q.isFullScreen()), t.preventDefault()), n && (r.key === "F12" || r.control && r.shift && r.key.toLowerCase() === "i") && (q != null && q.webContents.isDevToolsOpened() ? q.webContents.closeDevTools() : q == null || q.webContents.openDevTools(), t.preventDefault());
  }), Br ? q.loadURL(Br) : q.loadFile(D.join(Pa, "index.html")), q.on("enter-full-screen", () => {
    q == null || q.webContents.send("app:fullscreen-change", !0);
  }), q.on("leave-full-screen", () => {
    q == null || q.webContents.send("app:fullscreen-change", !1);
  });
}
b.handle("app:toggle-fullscreen", () => {
  if (q) {
    const n = q.isFullScreen();
    return q.setFullScreen(!n), !n;
  }
  return !1;
});
b.handle("app:get-user-data-path", () => j.getPath("userData"));
b.handle("db:get-novels", async () => {
  console.log("[Main] Received db:get-novels");
  try {
    return await S.novel.findMany({
      orderBy: { updatedAt: "desc" }
    });
  } catch (n) {
    throw console.error("[Main] db:get-novels failed:", n), n;
  }
});
b.handle("db:update-novel", async (n, { id: e, data: t }) => {
  console.log("[Main] Updating novel:", e, t);
  try {
    return await S.novel.update({
      where: { id: e },
      data: {
        ...t,
        updatedAt: /* @__PURE__ */ new Date()
      }
    });
  } catch (r) {
    throw console.error("[Main] db:update-novel failed:", r), r;
  }
});
b.handle("db:delete-novel", async (n, e) => {
  var t;
  console.log("[Main] Received db:delete-novel:", e);
  try {
    const r = await S.novel.findUnique({
      where: { id: e },
      select: { coverUrl: !0 }
    });
    if ((t = r == null ? void 0 : r.coverUrl) != null && t.startsWith("covers/")) {
      const a = D.join(j.getPath("userData"), r.coverUrl);
      z.existsSync(a) && z.unlinkSync(a);
    }
    return await S.novel.delete({
      where: { id: e }
    }), { ok: !0 };
  } catch (r) {
    throw console.error("[Main] db:delete-novel failed:", r), r;
  }
});
b.handle("db:upload-novel-cover", async (n, e) => {
  var t;
  try {
    const r = await ht.showOpenDialog(q, {
      title: "Select Cover Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (r.canceled || r.filePaths.length === 0)
      return null;
    const a = r.filePaths[0], s = D.extname(a), i = D.join(j.getPath("userData"), "covers");
    z.existsSync(i) || z.mkdirSync(i, { recursive: !0 });
    const o = await S.novel.findUnique({ where: { id: e }, select: { coverUrl: !0 } });
    if ((t = o == null ? void 0 : o.coverUrl) != null && t.startsWith("covers/")) {
      const m = D.join(j.getPath("userData"), o.coverUrl);
      z.existsSync(m) && z.unlinkSync(m);
    }
    const c = `${e}${s}`, d = D.join(i, c);
    z.copyFileSync(a, d);
    const l = `covers/${c}`;
    return await S.novel.update({
      where: { id: e },
      data: { coverUrl: l }
    }), { path: l };
  } catch (r) {
    throw console.error("[Main] db:upload-novel-cover failed:", r), r;
  }
});
b.handle("db:get-volumes", async (n, e) => {
  try {
    return await S.volume.findMany({
      where: { novelId: e },
      select: {
        id: !0,
        title: !0,
        order: !0,
        novelId: !0,
        version: !0,
        deleted: !0,
        createdAt: !0,
        updatedAt: !0,
        chapters: {
          select: {
            id: !0,
            title: !0,
            order: !0,
            wordCount: !0,
            updatedAt: !0
          },
          orderBy: { order: "asc" }
        }
      },
      orderBy: { order: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-volumes failed:", t), t;
  }
});
b.handle("db:get-agent-conversations", async (n, e) => {
  try {
    return await ur.list(e);
  } catch (t) {
    throw console.error("[Main] db:get-agent-conversations failed:", t), t;
  }
});
b.handle("db:upsert-agent-conversation", async (n, e) => {
  try {
    return await ur.upsert(e);
  } catch (t) {
    throw console.error("[Main] db:upsert-agent-conversation failed:", t), t;
  }
});
b.handle("db:delete-agent-conversation", async (n, e) => {
  try {
    return await ur.delete(e);
  } catch (t) {
    throw console.error("[Main] db:delete-agent-conversation failed:", t), t;
  }
});
b.handle("agent-attachment:select", async (n, e) => {
  const t = await ht.showOpenDialog({
    title: "添加文档",
    properties: ["openFile"],
    filters: [
      { name: "支持的文档", extensions: ["txt", "md", "markdown", "docx", "pdf"] },
      { name: "文本", extensions: ["txt", "md", "markdown"] },
      { name: "Word 文档", extensions: ["docx"] },
      { name: "PDF 文档", extensions: ["pdf"] }
    ]
  });
  if (t.canceled || !t.filePaths[0])
    return null;
  const r = await Kc.extractFile(t.filePaths[0]);
  return ut.create({
    id: `attachment_${le().replace(/-/g, "")}`,
    novelId: e.novelId,
    conversationId: e.conversationId,
    ...r
  });
});
b.handle("agent-attachment:list", async (n, e) => ut.list(e.novelId, e.conversationId));
b.handle("agent-attachment:get", async (n, e) => ut.getContent(e.novelId, e.conversationId, e.attachmentId));
b.handle("agent-attachment:bind", async (n, e) => ut.bindToMessage(
  e.novelId,
  e.conversationId,
  e.messageId,
  e.attachmentIds
));
b.handle("agent-attachment:remove-pending", async (n, e) => ut.removePending(e.novelId, e.conversationId, e.attachmentId));
b.handle("db:create-volume", async (n, { novelId: e, title: t }) => {
  try {
    const r = await S.volume.findFirst({
      where: { novelId: e },
      orderBy: { order: "desc" }
    }), a = ((r == null ? void 0 : r.order) || 0) + 1;
    return await S.volume.create({
      data: { novelId: e, title: t, order: a }
    });
  } catch (r) {
    throw console.error("[Main] db:create-volume failed:", r), r;
  }
});
b.handle("db:create-chapter", async (n, { volumeId: e, title: t, order: r }) => {
  try {
    const a = await S.chapter.create({
      data: {
        volumeId: e,
        title: t,
        order: r,
        content: "",
        wordCount: 0
      },
      include: { volume: { select: { novelId: !0 } } }
    });
    return await Fe({ ...a, novelId: a.volume.novelId }), Tt(a.id, "create-chapter"), a;
  } catch (a) {
    throw console.error("[Main] db:create-chapter failed:", a), a;
  }
});
b.handle("db:get-chapter", async (n, e) => {
  try {
    return await S.chapter.findUnique({
      where: { id: e },
      include: { volume: { select: { novelId: !0 } } }
    });
  } catch (t) {
    throw console.error("[Main] db:get-chapter failed:", t), t;
  }
});
b.handle("db:rename-volume", async (n, { volumeId: e, title: t }) => {
  try {
    const r = await S.volume.update({
      where: { id: e },
      data: { title: t }
    }), a = await S.chapter.findMany({
      where: { volumeId: e },
      include: { volume: { select: { novelId: !0, title: !0, order: !0 } } }
    });
    for (const s of a)
      await Fe({
        ...s,
        novelId: s.volume.novelId,
        volumeTitle: s.volume.title,
        volumeOrder: s.volume.order
      }), Tt(s.id, "rename-volume");
    return r;
  } catch (r) {
    throw console.error("[Main] db:rename-volume failed:", r), r;
  }
});
b.handle("db:rename-chapter", async (n, { chapterId: e, title: t }) => {
  try {
    const r = await S.chapter.update({
      where: { id: e },
      data: { title: t }
    }), a = await S.chapter.findUnique({
      where: { id: e },
      select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0, volume: { select: { novelId: !0 } } }
    });
    return a && a.volume && (await Fe({ ...a, novelId: a.volume.novelId }), Tt(e, "rename-chapter")), r;
  } catch (r) {
    throw console.error("[Main] db:rename-chapter failed:", r), r;
  }
});
b.handle("db:delete-chapter", async (n, { chapterId: e }) => {
  var t, r, a, s;
  try {
    const i = await S.chapter.findUnique({
      where: { id: e },
      select: {
        id: !0,
        title: !0,
        content: !0,
        wordCount: !0,
        order: !0,
        volumeId: !0,
        volume: {
          select: {
            novelId: !0,
            title: !0,
            order: !0
          }
        }
      }
    });
    if (!(i != null && i.volume))
      throw new Error("Chapter not found");
    const o = i.volume.novelId, c = await S.chapter.findMany({
      where: { volume: { novelId: o } },
      select: {
        id: !0,
        title: !0,
        content: !0,
        order: !0,
        volumeId: !0,
        volume: {
          select: {
            title: !0,
            order: !0
          }
        }
      },
      orderBy: [
        { volume: { order: "asc" } },
        { order: "asc" }
      ]
    }), d = c.findIndex((f) => f.id === e);
    if (d === -1)
      throw new Error("Chapter not found");
    if (c.length === 1) {
      const [, f] = await S.$transaction([
        S.novel.update({
          where: { id: o },
          data: {
            wordCount: 0,
            updatedAt: /* @__PURE__ */ new Date()
          }
        }),
        S.chapter.update({
          where: { id: e },
          data: {
            title: "",
            content: "",
            wordCount: 0,
            updatedAt: /* @__PURE__ */ new Date()
          },
          include: {
            volume: {
              select: {
                novelId: !0
              }
            }
          }
        })
      ]);
      return await Fe({
        ...f,
        novelId: o,
        volumeTitle: i.volume.title,
        volumeOrder: i.volume.order
      }), Tt(e, "reset-only-chapter"), {
        mode: "reset",
        chapterId: e,
        fallbackChapterId: e,
        chapter: f
      };
    }
    const l = ((t = c[d + 1]) == null ? void 0 : t.id) ?? ((r = c[d - 1]) == null ? void 0 : r.id) ?? null, p = c.filter((f) => f.volumeId === i.volumeId && f.id !== e).map((f, I) => ({
      ...f,
      nextOrder: I + 1
    })).filter((f) => f.order !== f.nextOrder);
    await S.$transaction([
      S.novel.update({
        where: { id: o },
        data: {
          wordCount: { decrement: i.wordCount },
          updatedAt: /* @__PURE__ */ new Date()
        }
      }),
      S.chapter.delete({
        where: { id: e }
      }),
      ...p.map((f) => S.chapter.update({
        where: { id: f.id },
        data: {
          order: f.nextOrder,
          updatedAt: /* @__PURE__ */ new Date()
        }
      }))
    ]), await ra("chapter", e), Zc(o, e, "delete-chapter");
    for (const f of p)
      await Fe({
        id: f.id,
        title: f.title,
        content: f.content,
        volumeId: f.volumeId,
        novelId: o,
        volumeTitle: (a = f.volume) == null ? void 0 : a.title,
        order: f.nextOrder,
        volumeOrder: (s = f.volume) == null ? void 0 : s.order
      });
    return {
      mode: "deleted",
      chapterId: e,
      fallbackChapterId: l
    };
  } catch (i) {
    throw console.error("[Main] db:delete-chapter failed:", i), i;
  }
});
b.handle("db:create-novel", async (n, e) => {
  console.log("[Main] Received db:create-novel:", e);
  try {
    return await S.novel.create({
      data: {
        title: e,
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
  } catch (t) {
    throw console.error("[Main] db:create-novel failed:", t), t;
  }
});
b.handle("db:import-novel-file", async () => {
  try {
    const n = await ht.showOpenDialog(q, {
      title: "Import Novel File",
      filters: [
        { name: "Novel Files", extensions: ["txt", "docx", "pdf"] },
        { name: "Text", extensions: ["txt"] },
        { name: "Word", extensions: ["docx"] },
        { name: "PDF", extensions: ["pdf"] }
      ],
      properties: ["openFile"]
    });
    if (n.canceled || n.filePaths.length === 0)
      return null;
    const e = n.filePaths[0], t = await ec(e), r = t.volumes.reduce((o, c) => o + c.chapters.length, 0), a = (/* @__PURE__ */ new Date()).toISOString(), s = JSON.stringify({
      importSource: D.basename(e),
      importExtension: D.extname(e).replace(/^\./, "").toLowerCase(),
      importedAt: a
    }), i = await S.$transaction(async (o) => {
      const c = await o.novel.create({
        data: {
          title: t.title,
          wordCount: t.wordCount,
          formatting: s
        }
      });
      for (const d of t.volumes) {
        const l = await o.volume.create({
          data: {
            novelId: c.id,
            title: d.title,
            order: d.order
          }
        });
        for (const m of d.chapters)
          await o.chapter.create({
            data: {
              volumeId: l.id,
              title: m.title,
              content: m.lexicalContent,
              wordCount: m.wordCount,
              order: m.order
            }
          });
      }
      return c;
    });
    return (async () => {
      try {
        const o = await S.chapter.findMany({
          where: { volume: { novelId: i.id } },
          include: {
            volume: { select: { novelId: !0, title: !0, order: !0 } }
          },
          orderBy: [{ volume: { order: "asc" } }, { order: "asc" }]
        });
        for (const c of o)
          await Fe({
            ...c,
            novelId: c.volume.novelId,
            volumeTitle: c.volume.title,
            volumeOrder: c.volume.order
          }), Tt(c.id, "import-novel-file"), st(c.id);
      } catch (o) {
        console.error("[Main] import post-processing failed:", o);
      }
    })(), {
      novelId: i.id,
      title: i.title,
      volumeCount: t.volumes.length,
      chapterCount: r
    };
  } catch (n) {
    throw console.error("[Main] db:import-novel-file failed:", n), n;
  }
});
b.handle("db:save-chapter", async (n, { chapterId: e, content: t }) => {
  try {
    console.log("[Main] Saving chapter:", e);
    const r = await S.chapter.findUnique({
      where: { id: e },
      select: {
        wordCount: !0,
        volume: { select: { novelId: !0 } }
      }
    });
    if (!r || !r.volume)
      throw new Error("Chapter or Volume not found");
    const a = r.volume.novelId, s = Ha(t).length, i = s - r.wordCount, [, o] = await S.$transaction([
      // 1. Update Novel WordCount
      S.novel.update({
        where: { id: a },
        data: {
          wordCount: { increment: i },
          updatedAt: /* @__PURE__ */ new Date()
        }
      }),
      // 2. Update Chapter
      S.chapter.update({
        where: { id: e },
        data: {
          content: t,
          wordCount: s,
          updatedAt: /* @__PURE__ */ new Date()
        }
      })
    ]), c = await S.chapter.findUnique({
      where: { id: e },
      select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0 }
    });
    return c && (await Fe({ ...c, novelId: a }), Tt(e, "save-chapter")), st(e), o;
  } catch (r) {
    throw console.error("[Main] db:save-chapter failed:", r), r;
  }
});
b.handle("db:create-idea", async (n, e) => {
  try {
    const { timestamp: t, tags: r, ...a } = e, s = a.novelId, i = await S.idea.create({
      data: {
        ...a,
        tags: {
          connectOrCreate: (r || []).map((c) => ({
            where: { name_novelId: { name: c, novelId: s } },
            create: { name: c, novelId: s }
          }))
        }
      },
      include: { tags: !0 }
    }), o = {
      ...i,
      tags: i.tags.map((c) => c.name),
      timestamp: i.createdAt.getTime()
    };
    return await Vr({
      id: i.id,
      content: i.content,
      quote: i.quote,
      novelId: i.novelId,
      chapterId: i.chapterId
    }), o;
  } catch (t) {
    throw console.error("[Main] db:create-idea failed:", t), t;
  }
});
b.handle("db:get-ideas", async (n, e) => {
  try {
    return (await S.idea.findMany({
      where: { novelId: e },
      include: { tags: !0 },
      orderBy: [
        { isStarred: "desc" },
        { updatedAt: "desc" }
      ]
    })).map((r) => ({
      ...r,
      tags: r.tags.map((a) => a.name),
      timestamp: r.createdAt.getTime()
    }));
  } catch (t) {
    throw console.error("[Main] db:get-ideas failed:", t), t;
  }
});
b.handle("db:update-idea", async (n, e, t) => {
  try {
    const { timestamp: r, tags: a, ...s } = t, i = { ...s };
    if (a !== void 0) {
      const d = await S.idea.findUnique({ where: { id: e }, select: { novelId: !0 } });
      if (d) {
        const l = d.novelId;
        i.tags = {
          set: [],
          // Disconnect all existing
          connectOrCreate: (a || []).map((m) => ({
            where: { name_novelId: { name: m, novelId: l } },
            create: { name: m, novelId: l }
          }))
        };
      }
    }
    const o = await S.idea.update({
      where: { id: e },
      data: {
        ...i,
        updatedAt: /* @__PURE__ */ new Date()
      },
      include: { tags: !0 }
    }), c = {
      ...o,
      tags: o.tags.map((d) => d.name),
      timestamp: o.createdAt.getTime()
    };
    return await Vr({
      id: o.id,
      content: o.content,
      quote: o.quote,
      novelId: o.novelId,
      chapterId: o.chapterId
    }), c;
  } catch (r) {
    throw console.error("[Main] db:update-idea failed:", r), r;
  }
});
b.handle("db:delete-idea", async (n, e) => {
  try {
    const t = await S.idea.delete({ where: { id: e } });
    return await ra("idea", e), t;
  } catch (t) {
    throw console.error("[Main] db:delete-idea failed:", t), t;
  }
});
b.handle("db:check-index-status", async (n, e) => {
  try {
    const t = await as(e), r = await S.chapter.count({
      where: { volume: { novelId: e } }
    }), a = await S.idea.count({
      where: { novelId: e }
    });
    return {
      indexedChapters: t.chapters,
      totalChapters: r,
      indexedIdeas: t.ideas,
      totalIdeas: a
    };
  } catch (t) {
    throw console.error("[Main] db:check-index-status failed:", t), t;
  }
});
const Ja = new ac();
let ee, Fr, nr = null, xe = null;
const ur = new Oi(S), ut = new xa(S), Kc = new Vi(), et = /* @__PURE__ */ new Map();
async function Tt(n, e) {
  return _e("chapter", n, e);
}
async function _e(n, e, t) {
  try {
    const r = await ee.upsertRagSourceIndex(n, e, { skipIfNovelNotIndexed: !0 });
    if (r.skipped)
      return;
    console.log("[RAG] Source index refreshed:", { sourceType: n, sourceId: e, reason: t, chunks: r.chunks, provider: r.provider, model: r.model });
  } catch (r) {
    console.warn("[RAG] Failed to refresh source index:", { sourceType: n, sourceId: e, reason: t, error: r });
  }
}
async function Zc(n, e, t) {
  return Ct(n, "chapter", e, t);
}
async function Ct(n, e, t, r) {
  try {
    const a = await ee.deleteRagSourceIndex(n, e, t);
    console.log("[RAG] Source index removed:", { novelId: n, sourceType: e, sourceId: t, reason: r, deleted: a.deleted });
  } catch (a) {
    console.warn("[RAG] Failed to remove source index:", { novelId: n, sourceType: e, sourceId: t, reason: r, error: a });
  }
}
b.handle("ai:get-settings", async () => {
  try {
    return ee.getSettings();
  } catch (n) {
    throw te("ai:get-settings", void 0, n), console.error("[Main] ai:get-settings failed:", n), n;
  }
});
b.handle("ai:get-map-image-stats", async () => {
  try {
    return ee.getMapImageStats();
  } catch (n) {
    throw te("ai:get-map-image-stats", void 0, n), console.error("[Main] ai:get-map-image-stats failed:", n), n;
  }
});
b.handle("ai:list-actions", async () => {
  try {
    return ee.listActions();
  } catch (n) {
    throw te("ai:list-actions", void 0, n), console.error("[Main] ai:list-actions failed:", n), n;
  }
});
b.handle("ai:get-capability-coverage", async () => {
  try {
    return ee.getCapabilityCoverage();
  } catch (n) {
    throw te("ai:get-capability-coverage", void 0, n), console.error("[Main] ai:get-capability-coverage failed:", n), n;
  }
});
b.handle("ai:get-mcp-manifest", async () => {
  try {
    return ee.getMcpToolsManifest();
  } catch (n) {
    throw te("ai:get-mcp-manifest", void 0, n), console.error("[Main] ai:get-mcp-manifest failed:", n), n;
  }
});
b.handle("ai:get-mcp-cli-setup", async () => {
  try {
    return Fa();
  } catch (n) {
    throw te("ai:get-mcp-cli-setup", void 0, n), console.error("[Main] ai:get-mcp-cli-setup failed:", n), n;
  }
});
b.handle("ai:get-openclaw-manifest", async () => {
  try {
    return ee.getOpenClawManifest();
  } catch (n) {
    throw te("ai:get-openclaw-manifest", void 0, n), console.error("[Main] ai:get-openclaw-manifest failed:", n), n;
  }
});
b.handle("ai:get-openclaw-skill-manifest", async () => {
  try {
    return ee.getOpenClawSkillManifest();
  } catch (n) {
    throw te("ai:get-openclaw-skill-manifest", void 0, n), console.error("[Main] ai:get-openclaw-skill-manifest failed:", n), n;
  }
});
b.handle("ai:update-settings", async (n, e) => {
  try {
    const t = ee.updateSettings(e || {});
    return await ja(t), t;
  } catch (t) {
    throw te("ai:update-settings", e, t), console.error("[Main] ai:update-settings failed:", t), t;
  }
});
b.handle("ai:test-connection", async () => {
  try {
    return await ee.testConnection();
  } catch (n) {
    throw te("ai:test-connection", void 0, n), console.error("[Main] ai:test-connection failed:", n), n;
  }
});
b.handle("ai:test-mcp", async () => {
  try {
    return await zc();
  } catch (n) {
    throw te("ai:test-mcp", void 0, n), console.error("[Main] ai:test-mcp failed:", n), n;
  }
});
b.handle("ai:test-openclaw-mcp", async () => {
  try {
    return await ee.testOpenClawMcp();
  } catch (n) {
    throw te("ai:test-openclaw-mcp", void 0, n), console.error("[Main] ai:test-openclaw-mcp failed:", n), n;
  }
});
b.handle("ai:test-openclaw-skill", async () => {
  try {
    return await ee.testOpenClawSkill();
  } catch (n) {
    throw te("ai:test-openclaw-skill", void 0, n), console.error("[Main] ai:test-openclaw-skill failed:", n), n;
  }
});
b.handle("ai:test-openclaw-smoke", async (n, e) => {
  try {
    const t = (e == null ? void 0 : e.kind) === "skill" ? "skill" : "mcp";
    return await ee.testOpenClawSmoke({ kind: t });
  } catch (t) {
    throw te("ai:test-openclaw-smoke", e, t), console.error("[Main] ai:test-openclaw-smoke failed:", t), t;
  }
});
b.handle("ai:test-proxy", async () => {
  try {
    return await ee.testProxy();
  } catch (n) {
    throw te("ai:test-proxy", void 0, n), console.error("[Main] ai:test-proxy failed:", n), n;
  }
});
b.handle("ai:test-generate", async (n, e) => {
  try {
    return await ee.testGenerate(e == null ? void 0 : e.prompt);
  } catch (t) {
    throw te("ai:test-generate", e, t), console.error("[Main] ai:test-generate failed:", t), t;
  }
});
b.handle("ai:generate-title", async (n, e) => {
  try {
    return await ee.generateTitle(e);
  } catch (t) {
    throw te("ai:generate-title", e, t), console.error("[Main] ai:generate-title failed:", t), t;
  }
});
b.handle("ai:continue-writing", async (n, e) => {
  try {
    return await ee.continueWriting(e);
  } catch (t) {
    throw te("ai:continue-writing", e, t), console.error("[Main] ai:continue-writing failed:", t), t;
  }
});
b.handle("ai:preview-continue-prompt", async (n, e) => {
  try {
    return await ee.previewContinuePrompt(e);
  } catch (t) {
    throw te("ai:preview-continue-prompt", e, t), console.error("[Main] ai:preview-continue-prompt failed:", t), t;
  }
});
b.handle("ai:check-consistency", async (n, e) => {
  try {
    return await ee.checkConsistency(e);
  } catch (t) {
    throw te("ai:check-consistency", e, t), console.error("[Main] ai:check-consistency failed:", t), t;
  }
});
b.handle("ai:ask-novel", async (n, e) => {
  try {
    return await ee.askNovel(e);
  } catch (t) {
    throw te("ai:ask-novel", e, t), console.error("[Main] ai:ask-novel failed:", t), t;
  }
});
b.handle("ai:preview-novel-ask-prompt", async (n, e) => {
  try {
    return await ee.previewNovelAskPrompt(e);
  } catch (t) {
    throw te("ai:preview-novel-ask-prompt", e, t), console.error("[Main] ai:preview-novel-ask-prompt failed:", t), t;
  }
});
b.handle("ai:generate-creative-assets", async (n, e) => {
  try {
    return await ee.generateCreativeAssets(e);
  } catch (t) {
    throw te("ai:generate-creative-assets", e, t), console.error("[Main] ai:generate-creative-assets failed:", t), t;
  }
});
b.handle("ai:preview-creative-assets-prompt", async (n, e) => {
  try {
    return await ee.previewCreativeAssetsPrompt(e);
  } catch (t) {
    throw te("ai:preview-creative-assets-prompt", e, t), console.error("[Main] ai:preview-creative-assets-prompt failed:", t), t;
  }
});
b.handle("ai:validate-creative-assets", async (n, e) => {
  try {
    return await ee.validateCreativeAssetsDraft(e);
  } catch (t) {
    throw te("ai:validate-creative-assets", e, t), console.error("[Main] ai:validate-creative-assets failed:", t), t;
  }
});
b.handle("ai:confirm-creative-assets", async (n, e) => {
  try {
    return await ee.confirmCreativeAssets(e);
  } catch (t) {
    throw te("ai:confirm-creative-assets", e, t), console.error("[Main] ai:confirm-creative-assets failed:", t), t;
  }
});
b.handle("ai:generate-map-image", async (n, e) => {
  try {
    return await ee.generateMapImage(e);
  } catch (t) {
    return te("ai:generate-map-image", e, t), console.error("[Main] ai:generate-map-image failed:", t), { ok: !1, code: "UNKNOWN", detail: t instanceof Error ? t.message : String(t) };
  }
});
b.handle("ai:preview-map-prompt", async (n, e) => {
  try {
    return await ee.previewMapPrompt(e);
  } catch (t) {
    throw te("ai:preview-map-prompt", e, t), console.error("[Main] ai:preview-map-prompt failed:", t), t;
  }
});
b.handle("ai:rebuild-chapter-summary", async (n, e) => {
  try {
    return e != null && e.chapterId ? (st(e.chapterId, "manual"), { ok: !0, detail: "summary rebuild scheduled" }) : { ok: !1, detail: "chapterId is required" };
  } catch (t) {
    return te("ai:rebuild-chapter-summary", e, t), console.error("[Main] ai:rebuild-chapter-summary failed:", t), { ok: !1, detail: t instanceof Error ? t.message : String(t) };
  }
});
b.handle("ai:execute-action", async (n, e) => {
  try {
    return await ee.executeAction(e);
  } catch (t) {
    throw te("ai:execute-action", e, t), console.error("[Main] ai:execute-action failed:", t), t;
  }
});
b.handle("ai:openclaw-invoke", async (n, e) => {
  try {
    return await ee.invokeOpenClawTool(e);
  } catch (t) {
    te("ai:openclaw-invoke", e, t), console.error("[Main] ai:openclaw-invoke failed:", t);
    const r = He(t);
    return {
      ok: !1,
      code: r.code,
      error: At(r.code, r.message)
    };
  }
});
b.handle("ai:openclaw-mcp-invoke", async (n, e) => {
  try {
    return await ee.invokeOpenClawTool(e);
  } catch (t) {
    te("ai:openclaw-mcp-invoke", e, t), console.error("[Main] ai:openclaw-mcp-invoke failed:", t);
    const r = He(t);
    return {
      ok: !1,
      code: r.code,
      error: At(r.code, r.message)
    };
  }
});
b.handle("ai:openclaw-skill-invoke", async (n, e) => {
  try {
    return await ee.invokeOpenClawSkill(e);
  } catch (t) {
    te("ai:openclaw-skill-invoke", e, t), console.error("[Main] ai:openclaw-skill-invoke failed:", t);
    const r = He(t);
    return {
      ok: !1,
      code: r.code,
      error: At(r.code, r.message)
    };
  }
});
b.handle("automation:invoke", async (n, e) => {
  const t = le(), r = Date.now();
  try {
    $("INFO", "Main.automation:invoke.start", "Renderer automation invoke start", {
      requestId: t,
      method: e.method,
      origin: e.origin ?? "desktop-ui",
      params: ve(e.params)
    });
    const a = await Fr.invoke(e.method, e.params, {
      source: "renderer",
      origin: e.origin ?? "desktop-ui",
      requestId: t
    });
    return $("INFO", "Main.automation:invoke.success", "Renderer automation invoke success", {
      requestId: t,
      method: e.method,
      elapsedMs: Date.now() - r,
      result: ve(a)
    }), (/* @__PURE__ */ new Set([
      "outline.write",
      "character.create_batch",
      "story_patch.apply",
      "worldsetting.create",
      "worldsetting.update",
      "chapter.create",
      "chapter.save",
      "creative_assets.generate_draft",
      "creative_assets.revise_draft",
      "creative_assets.validate_draft",
      "outline.generate_draft",
      "chapter.generate_draft",
      "chapter.revise_draft",
      "draft.update",
      "draft.commit",
      "draft.undo",
      "draft.discard",
      "draft.batch.create",
      "draft.batch.update_outline",
      "draft.batch.approve_outline",
      "draft.batch.attach_child",
      "draft.batch.mark_stale_after",
      "draft.batch.prepare_regeneration",
      "draft.batch.mark_failed",
      "draft.batch.reconcile_unknown",
      "draft.batch.commit_prefix",
      "draft.batch.undo",
      "draft.batch.discard",
      "artifact.review.submit",
      "review.comment.save",
      "review.comment.delete",
      "review.comment.mark_sent",
      "revision_task.create_plan",
      "revision_task.update_status"
    ])).has(e.method) && (q == null || q.webContents.send("automation:data-changed", { method: e.method })), a;
  } catch (a) {
    throw Se("Main.automation:invoke.error", a, {
      requestId: t,
      method: e.method,
      elapsedMs: Date.now() - r,
      payload: ve(e)
    }), te("automation:invoke", e, a), a;
  }
});
b.handle("agent:health", async () => xe ? xe.health() : { ok: !1, code: "AGENT_RUNTIME_NOT_INITIALIZED", message: "Agent runtime client is not initialized" });
b.handle("agent:ensure-ready", async () => xe ? xe.ensureReady() : { ok: !1, code: "AGENT_RUNTIME_NOT_INITIALIZED", message: "Agent runtime client is not initialized" });
b.handle("agent:restart", async () => xe ? xe.restart() : { ok: !1, code: "AGENT_RUNTIME_NOT_INITIALIZED", message: "Agent runtime client is not initialized" });
b.handle("agent:invoke", async (n, e) => {
  if (!xe)
    throw Object.assign(new Error("Agent runtime client is not initialized"), { code: "AGENT_RUNTIME_NOT_INITIALIZED" });
  const t = String(e.requestId || "").trim() || le();
  return xe.invoke({
    requestId: t,
    method: e.method,
    params: e.params || {},
    context: e.context || {}
  }, e.method === "agent.chat" ? (r) => {
    q == null || q.webContents.send("agent:chat-progress", { requestId: t, ...r });
  } : void 0);
});
b.handle("agent:cancel-chat", async (n, e) => {
  if (!xe)
    throw Object.assign(new Error("Agent runtime client is not initialized"), { code: "AGENT_RUNTIME_NOT_INITIALIZED" });
  const t = String((e == null ? void 0 : e.requestId) || "").trim();
  if (!t)
    throw Object.assign(new Error("requestId is required"), { code: "INVALID_INPUT" });
  return { ok: !0, cancelled: await xe.cancelRequest(t) };
});
b.handle("agent:subscribe-run", async (n, e) => {
  var a;
  if (!xe)
    throw Object.assign(new Error("Agent runtime client is not initialized"), { code: "AGENT_RUNTIME_NOT_INITIALIZED" });
  const t = String((e == null ? void 0 : e.runId) || "").trim();
  if (!t)
    throw Object.assign(new Error("runId is required"), { code: "INVALID_INPUT" });
  (a = et.get(t)) == null || a();
  const r = await xe.subscribeRunEvents(
    t,
    { afterSequence: e.afterSequence },
    (s) => {
      var i;
      $("INFO", "Main.agent.runEvent", "Agent run event", {
        runId: s.runId,
        sequence: s.sequence,
        type: s.type,
        toolName: s.toolName,
        status: s.status,
        payload: ve(s.payload)
      }), q == null || q.webContents.send("agent:run-event", s), ["run_completed", "run_failed", "run_cancelled"].includes(s.type) && ((i = et.get(t)) == null || i(), et.delete(t));
    },
    (s) => {
      $("WARN", "Main.agent.runDisconnected", "Agent run event stream disconnected", s), q == null || q.webContents.send("agent:run-disconnected", s), et.delete(t);
    }
  );
  return et.set(t, r), { ok: !0 };
});
b.handle("agent:unsubscribe-run", async (n, e) => {
  var r;
  const t = String((e == null ? void 0 : e.runId) || "").trim();
  return t ? ((r = et.get(t)) == null || r(), et.delete(t), { ok: !0 }) : { ok: !0 };
});
b.handle("sync:pull", async () => {
  try {
    return await Ja.pull();
  } catch (n) {
    throw console.error("[Main] sync:pull failed:", n), n;
  }
});
b.handle("backup:export", async (n, e) => {
  try {
    return await lr.exportData(void 0, e);
  } catch (t) {
    throw console.error("[Main] backup:export failed:", t), t;
  }
});
b.handle("backup:import", async (n, { filePath: e, password: t }) => {
  try {
    if (!e) {
      const r = await ht.showOpenDialog({
        title: "Import Backup",
        filters: [{ name: "CloudDream Novel Agent Backup", extensions: ["nebak"] }],
        properties: ["openFile"]
      });
      if (r.canceled || r.filePaths.length === 0)
        return { success: !1, code: "CANCELLED" };
      e = r.filePaths[0];
    }
    return await lr.importData(e, t), { success: !0 };
  } catch (r) {
    console.error("[Main] backup:import failed:", r);
    const a = r.message || r.toString();
    return a.includes("PASSWORD_REQUIRED") ? { success: !1, code: "PASSWORD_REQUIRED", filePath: e } : a.includes("PASSWORD_INVALID") ? { success: !1, code: "PASSWORD_INVALID", filePath: e } : { success: !1, message: a };
  }
});
b.handle("backup:get-auto", async () => {
  try {
    return await lr.getAutoBackups();
  } catch (n) {
    throw console.error("[Main] backup:get-auto failed:", n), n;
  }
});
b.handle("backup:restore-auto", async (n, e) => {
  try {
    return await lr.restoreAutoBackup(e), !0;
  } catch (t) {
    throw console.error("[Main] backup:restore-auto failed:", t), t;
  }
});
b.handle("sync:push", async () => {
  try {
    return await Ja.push();
  } catch (n) {
    throw console.error("[Main] sync:push failed:", n), n;
  }
});
b.handle("db:search", async (n, { novelId: e, keyword: t, limit: r = 20, offset: a = 0 }) => {
  try {
    return await Jr(e, t, r, a);
  } catch (s) {
    throw console.error("[Main] db:search failed:", s), s;
  }
});
b.handle("db:rebuild-search-index", async (n, e) => {
  try {
    return await na(e);
  } catch (t) {
    throw console.error("[Main] db:rebuild-search-index failed:", t), t;
  }
});
b.handle("db:get-all-tags", async (n, e) => {
  try {
    return e ? (await S.tag.findMany({
      where: { novelId: e },
      orderBy: { name: "asc" },
      select: { name: !0 }
    })).map((r) => r.name) : [];
  } catch (t) {
    throw console.error("[Main] db:get-all-tags failed:", t), t;
  }
});
b.handle("db:get-plot-lines", async (n, e) => {
  try {
    return await S.plotLine.findMany({
      where: { novelId: e },
      include: {
        points: {
          include: { anchors: !0 },
          orderBy: { order: "asc" }
        }
      },
      orderBy: { sortOrder: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-plot-lines failed:", t), t;
  }
});
b.handle("db:create-plot-line", async (n, e) => {
  try {
    const r = ((await S.plotLine.aggregate({
      where: { novelId: e.novelId },
      _max: { sortOrder: !0 }
    }))._max.sortOrder || 0) + 1, a = await S.plotLine.create({
      data: { ...e, sortOrder: r }
    });
    return _e("plotLine", a.id, "create-plot-line"), a;
  } catch (t) {
    throw console.error("[Main] db:create-plot-line failed. Data:", e, "Error:", t), t;
  }
});
b.handle("db:update-plot-line", async (n, e) => {
  try {
    const t = await S.plotLine.update({
      where: { id: e.id },
      data: e.data
    });
    return _e("plotLine", t.id, "update-plot-line"), t;
  } catch (t) {
    throw console.error("[Main] db:update-plot-line failed. ID:", e.id, "Error:", t), t;
  }
});
b.handle("db:delete-plot-line", async (n, e) => {
  try {
    const t = await S.plotLine.findUnique({ where: { id: e }, select: { novelId: !0 } }), r = await S.plotLine.delete({ where: { id: e } });
    return t != null && t.novelId && Ct(t.novelId, "plotLine", e, "delete-plot-line"), r;
  } catch (t) {
    throw console.error("[Main] db:delete-plot-line failed. ID:", e, "Error:", t), t;
  }
});
b.handle("db:create-plot-point", async (n, e) => {
  try {
    const { plotLineId: t } = e, a = ((await S.plotPoint.aggregate({
      where: { plotLineId: t },
      _max: { order: !0 }
    }))._max.order || 0) + 1, s = await S.plotPoint.create({
      data: { ...e, order: a }
    });
    return _e("plotPoint", s.id, "create-plot-point"), s;
  } catch (t) {
    throw console.error("[Main] db:create-plot-point failed. Data:", e, "Error:", t), t;
  }
});
b.handle("db:update-plot-point", async (n, e) => {
  try {
    const t = await S.plotPoint.update({
      where: { id: e.id },
      data: e.data
    });
    return _e("plotPoint", t.id, "update-plot-point"), t;
  } catch (t) {
    throw console.error("[Main] db:update-plot-point failed. ID:", e.id, "Error:", t), t;
  }
});
b.handle("db:delete-plot-point", async (n, e) => {
  try {
    const t = await S.plotPoint.findUnique({ where: { id: e }, select: { novelId: !0 } }), r = await S.plotPoint.delete({ where: { id: e } });
    return t != null && t.novelId && Ct(t.novelId, "plotPoint", e, "delete-plot-point"), r;
  } catch (t) {
    throw console.error("[Main] db:delete-plot-point failed. ID:", e, "Error:", t), t;
  }
});
b.handle("db:create-plot-point-anchor", async (n, e) => {
  try {
    return await S.plotPointAnchor.create({ data: e });
  } catch (t) {
    throw console.error("[Main] db:create-plot-point-anchor failed. Data:", e, "Error:", t), t;
  }
});
b.handle("db:delete-plot-point-anchor", async (n, e) => {
  try {
    return await S.plotPointAnchor.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-plot-point-anchor failed. ID:", e, "Error:", t), t;
  }
});
b.handle("db:reorder-plot-lines", async (n, { lineIds: e }) => {
  try {
    const t = e.map(
      (r, a) => S.plotLine.update({
        where: { id: r },
        data: { sortOrder: a }
      })
    );
    return await S.$transaction(t), { success: !0 };
  } catch (t) {
    throw console.error("[Main] db:reorder-plot-lines failed:", t), t;
  }
});
b.handle("db:reorder-plot-points", async (n, { plotLineId: e, pointIds: t }) => {
  try {
    const r = t.map(
      (a, s) => S.plotPoint.update({
        where: { id: a },
        data: { order: s, plotLineId: e }
      })
    );
    await S.$transaction(r);
    for (const a of t)
      _e("plotPoint", a, "reorder-plot-points");
    return { success: !0 };
  } catch (r) {
    throw console.error("[Main] db:reorder-plot-points failed:", r), r;
  }
});
b.handle("db:upload-character-image", async (n, { characterId: e, type: t }) => {
  try {
    const r = await ht.showOpenDialog(q, {
      title: t === "avatar" ? "Select Avatar Image" : "Select Full Body Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (r.canceled || r.filePaths.length === 0)
      return null;
    const a = r.filePaths[0], s = D.extname(a), i = D.join(j.getPath("userData"), "characters", e);
    if (z.existsSync(i) || z.mkdirSync(i, { recursive: !0 }), t === "avatar") {
      const o = `avatar${s}`, c = D.join(i, o);
      z.readdirSync(i).filter((m) => m.startsWith("avatar.")).forEach((m) => {
        try {
          z.unlinkSync(D.join(i, m));
        } catch {
        }
      }), z.copyFileSync(a, c);
      const l = `characters/${e}/${o}`;
      return await S.character.update({
        where: { id: e },
        data: { avatar: l }
      }), { path: l };
    } else {
      const c = `fullbody_${Date.now()}${s}`, d = D.join(i, c);
      z.copyFileSync(a, d);
      const l = `characters/${e}/${c}`, m = await S.character.findUnique({ where: { id: e }, select: { fullBodyImages: !0 } });
      let h = [];
      try {
        h = JSON.parse((m == null ? void 0 : m.fullBodyImages) || "[]");
      } catch {
      }
      return h.push(l), await S.character.update({
        where: { id: e },
        data: { fullBodyImages: JSON.stringify(h) }
      }), { path: l, images: h };
    }
  } catch (r) {
    throw console.error("[Main] db:upload-character-image failed:", r), r;
  }
});
b.handle("db:delete-character-image", async (n, { characterId: e, imagePath: t, type: r }) => {
  try {
    const a = j.getPath("userData"), s = D.resolve(D.join(a, t));
    if (!s.startsWith(a + D.sep))
      throw new Error("Invalid image path: path traversal detected");
    if (z.existsSync(s) && z.unlinkSync(s), r === "avatar")
      await S.character.update({
        where: { id: e },
        data: { avatar: null }
      });
    else {
      const i = await S.character.findUnique({ where: { id: e }, select: { fullBodyImages: !0 } });
      let o = [];
      try {
        o = JSON.parse((i == null ? void 0 : i.fullBodyImages) || "[]");
      } catch {
      }
      o = o.filter((c) => c !== t), await S.character.update({
        where: { id: e },
        data: { fullBodyImages: JSON.stringify(o) }
      });
    }
  } catch (a) {
    throw console.error("[Main] db:delete-character-image failed:", a), a;
  }
});
b.handle("db:get-character-map-locations", async (n, e) => {
  try {
    return (await S.characterMapMarker.findMany({
      where: { characterId: e },
      include: {
        map: { select: { id: !0, name: !0, type: !0 } }
      }
    })).map((r) => ({
      mapId: r.map.id,
      mapName: r.map.name,
      mapType: r.map.type
    }));
  } catch (t) {
    return console.error("[Main] db:get-character-map-locations failed:", t), [];
  }
});
b.handle("db:get-characters", async (n, e) => {
  try {
    return await S.character.findMany({
      where: { novelId: e },
      include: {
        items: {
          include: { item: !0 }
        }
      },
      orderBy: [
        { isStarred: "desc" },
        { sortOrder: "asc" }
      ]
    });
  } catch (t) {
    throw console.error("[Main] db:get-characters failed:", t), t;
  }
});
b.handle("db:get-character", async (n, e) => {
  try {
    return await S.character.findUnique({
      where: { id: e },
      include: {
        items: {
          include: { item: !0 }
        }
      }
    });
  } catch (t) {
    throw console.error("[Main] db:get-character failed:", t), t;
  }
});
b.handle("db:create-character", async (n, e) => {
  try {
    const t = typeof e.profile == "object" ? JSON.stringify(e.profile) : e.profile, r = await S.character.create({
      data: { ...e, profile: t }
    });
    return _e("character", r.id, "create-character"), r;
  } catch (t) {
    throw console.error("[Main] db:create-character failed:", t), t;
  }
});
b.handle("db:update-character", async (n, { id: e, data: t }) => {
  try {
    const r = typeof t.profile == "object" ? JSON.stringify(t.profile) : t.profile, a = await S.character.update({
      where: { id: e },
      data: { ...t, profile: r }
    });
    return _e("character", e, "update-character"), a;
  } catch (r) {
    throw console.error("[Main] db:update-character failed:", r), r;
  }
});
b.handle("db:delete-character", async (n, e) => {
  try {
    const t = await S.character.findUnique({ where: { id: e }, select: { novelId: !0 } });
    await S.character.delete({ where: { id: e } }), t != null && t.novelId && Ct(t.novelId, "character", e, "delete-character");
  } catch (t) {
    throw console.error("[Main] db:delete-character failed:", t), t;
  }
});
b.handle("db:get-items", async (n, e) => {
  try {
    return await S.item.findMany({
      where: { novelId: e },
      orderBy: { sortOrder: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-items failed:", t), t;
  }
});
b.handle("db:get-item", async (n, e) => {
  try {
    return await S.item.findUnique({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:get-item failed:", t), t;
  }
});
b.handle("db:create-item", async (n, e) => {
  try {
    const r = ((await S.item.aggregate({
      where: { novelId: e.novelId },
      _max: { sortOrder: !0 }
    }))._max.sortOrder || 0) + 1, a = await S.item.create({
      data: { ...e, sortOrder: r }
    });
    return _e("item", a.id, "create-item"), a;
  } catch (t) {
    throw console.error("[Main] db:create-item failed:", t), t;
  }
});
b.handle("db:update-item", async (n, { id: e, data: t }) => {
  try {
    const r = await S.item.update({
      where: { id: e },
      data: { ...t, updatedAt: /* @__PURE__ */ new Date() }
    });
    return _e("item", e, "update-item"), r;
  } catch (r) {
    throw console.error("[Main] db:update-item failed:", r), r;
  }
});
b.handle("db:delete-item", async (n, e) => {
  try {
    const t = await S.item.findUnique({ where: { id: e }, select: { novelId: !0 } }), r = await S.item.delete({ where: { id: e } });
    return t != null && t.novelId && Ct(t.novelId, "item", e, "delete-item"), r;
  } catch (t) {
    throw console.error("[Main] db:delete-item failed:", t), t;
  }
});
b.handle("db:get-mentionables", async (n, e) => {
  try {
    const [t, r, a, s] = await Promise.all([
      S.character.findMany({
        where: { novelId: e },
        select: { id: !0, name: !0, avatar: !0, role: !0, isStarred: !0 },
        orderBy: [
          { isStarred: "desc" },
          { name: "asc" }
        ]
      }),
      S.item.findMany({
        where: { novelId: e },
        select: { id: !0, name: !0, icon: !0 },
        orderBy: { name: "asc" }
      }),
      S.worldSetting.findMany({
        where: { novelId: e },
        select: { id: !0, name: !0, icon: !0, type: !0 },
        orderBy: { name: "asc" }
      }),
      S.mapCanvas.findMany({
        where: { novelId: e },
        select: { id: !0, name: !0, type: !0 },
        orderBy: { name: "asc" }
      })
    ]);
    return [
      ...t.map((i) => ({ ...i, type: "character" })),
      ...r.map((i) => ({ ...i, type: "item" })),
      ...a.map((i) => ({ id: i.id, name: i.name, icon: i.icon, type: "world", role: i.type })),
      ...s.map((i) => ({ id: i.id, name: i.name, type: "map", role: i.type }))
    ];
  } catch (t) {
    throw console.error("[Main] db:get-mentionables failed:", t), t;
  }
});
b.handle("db:get-world-settings", async (n, e) => {
  try {
    return await S.worldSetting.findMany({
      where: { novelId: e },
      orderBy: { sortOrder: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-world-settings failed:", t), t;
  }
});
b.handle("db:create-world-setting", async (n, e) => {
  try {
    const t = await S.worldSetting.findFirst({
      where: { novelId: e.novelId },
      orderBy: { sortOrder: "desc" }
    }), r = await S.worldSetting.create({
      data: {
        novelId: e.novelId,
        name: e.name,
        type: e.type || "other",
        sortOrder: ((t == null ? void 0 : t.sortOrder) || 0) + 1
      }
    });
    return _e("worldSetting", r.id, "create-world-setting"), r;
  } catch (t) {
    throw console.error("[Main] db:create-world-setting failed:", t), t;
  }
});
b.handle("db:update-world-setting", async (n, e, t) => {
  try {
    const r = await S.worldSetting.update({
      where: { id: e },
      data: t
    });
    return _e("worldSetting", e, "update-world-setting"), r;
  } catch (r) {
    throw console.error("[Main] db:update-world-setting failed:", r), r;
  }
});
b.handle("db:delete-world-setting", async (n, e) => {
  try {
    const t = await S.worldSetting.findUnique({ where: { id: e }, select: { novelId: !0 } }), r = await S.worldSetting.delete({ where: { id: e } });
    return t != null && t.novelId && Ct(t.novelId, "worldSetting", e, "delete-world-setting"), r;
  } catch (t) {
    throw console.error("[Main] db:delete-world-setting failed:", t), t;
  }
});
b.handle("db:get-maps", async (n, e) => {
  try {
    return await S.mapCanvas.findMany({
      where: { novelId: e },
      orderBy: { sortOrder: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-maps failed:", t), t;
  }
});
b.handle("db:get-map", async (n, e) => {
  try {
    return await S.mapCanvas.findUnique({
      where: { id: e },
      include: {
        markers: { include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } } },
        elements: { orderBy: { z: "asc" } }
      }
    });
  } catch (t) {
    throw console.error("[Main] db:get-map failed:", t), t;
  }
});
b.handle("db:create-map", async (n, e) => {
  try {
    return await S.mapCanvas.create({ data: e });
  } catch (t) {
    throw console.error("[Main] db:create-map failed:", t), t;
  }
});
b.handle("db:update-map", async (n, { id: e, data: t }) => {
  try {
    const { markers: r, elements: a, createdAt: s, updatedAt: i, ...o } = t;
    return await S.mapCanvas.update({ where: { id: e }, data: o });
  } catch (r) {
    throw console.error("[Main] db:update-map failed:", r), r;
  }
});
b.handle("db:delete-map", async (n, e) => {
  try {
    const t = await S.mapCanvas.findUnique({ where: { id: e }, select: { background: !0, novelId: !0 } });
    if (t != null && t.background) {
      const r = D.join(j.getPath("userData"), t.background);
      z.existsSync(r) && z.unlinkSync(r);
    }
    return await S.mapCanvas.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-map failed:", t), t;
  }
});
b.handle("db:upload-map-bg", async (n, e) => {
  try {
    const t = await S.mapCanvas.findUnique({ where: { id: e }, select: { novelId: !0, background: !0 } });
    if (!t)
      return null;
    const r = await ht.showOpenDialog(q, {
      title: "Select Map Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (r.canceled || r.filePaths.length === 0)
      return null;
    const a = r.filePaths[0], s = D.extname(a), i = D.join(j.getPath("userData"), "maps", t.novelId);
    if (z.existsSync(i) || z.mkdirSync(i, { recursive: !0 }), t.background) {
      const f = D.join(j.getPath("userData"), t.background);
      z.existsSync(f) && z.unlinkSync(f);
    }
    const o = `${e}${s}`, c = D.join(i, o);
    z.copyFileSync(a, c);
    const d = `maps/${t.novelId}/${o}`, m = Xa.createFromPath(c).getSize(), h = m.width || 1200, p = m.height || 800;
    return await S.mapCanvas.update({
      where: { id: e },
      data: { background: d, width: h, height: p }
    }), { path: d, width: h, height: p };
  } catch (t) {
    throw console.error("[Main] db:upload-map-bg failed:", t), t;
  }
});
b.handle("db:get-map-markers", async (n, e) => {
  try {
    return await S.characterMapMarker.findMany({
      where: { mapId: e },
      include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
    });
  } catch (t) {
    throw console.error("[Main] db:get-map-markers failed:", t), t;
  }
});
b.handle("db:create-map-marker", async (n, e) => {
  try {
    return await S.characterMapMarker.create({
      data: e,
      include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
    });
  } catch (t) {
    throw console.error("[Main] db:create-map-marker failed:", t), t;
  }
});
b.handle("db:update-map-marker", async (n, { id: e, data: t }) => {
  try {
    return await S.characterMapMarker.update({
      where: { id: e },
      data: t,
      include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
    });
  } catch (r) {
    throw console.error("[Main] db:update-map-marker failed:", r), r;
  }
});
b.handle("db:delete-map-marker", async (n, e) => {
  try {
    return await S.characterMapMarker.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-map-marker failed:", t), t;
  }
});
b.handle("db:get-map-elements", async (n, e) => {
  try {
    return await S.mapElement.findMany({
      where: { mapId: e },
      orderBy: { z: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-map-elements failed:", t), t;
  }
});
b.handle("db:create-map-element", async (n, e) => {
  try {
    return await S.mapElement.create({ data: e });
  } catch (t) {
    throw console.error("[Main] db:create-map-element failed:", t), t;
  }
});
b.handle("db:update-map-element", async (n, { id: e, data: t }) => {
  try {
    const { createdAt: r, updatedAt: a, map: s, ...i } = t;
    return await S.mapElement.update({ where: { id: e }, data: i });
  } catch (r) {
    throw console.error("[Main] db:update-map-element failed:", r), r;
  }
});
b.handle("db:delete-map-element", async (n, e) => {
  try {
    return await S.mapElement.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-map-element failed:", t), t;
  }
});
b.handle("db:get-relationships", async (n, e) => {
  try {
    const [t, r] = await Promise.all([
      S.relationship.findMany({
        where: { sourceId: e },
        include: { target: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
      }),
      S.relationship.findMany({
        where: { targetId: e },
        include: { source: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
      })
    ]);
    return [...t, ...r];
  } catch (t) {
    throw console.error("[Main] db:get-relationships failed:", t), t;
  }
});
b.handle("db:create-relationship", async (n, e) => {
  try {
    return await S.relationship.create({
      data: e,
      include: {
        source: { select: { id: !0, name: !0, avatar: !0, role: !0 } },
        target: { select: { id: !0, name: !0, avatar: !0, role: !0 } }
      }
    });
  } catch (t) {
    throw console.error("[Main] db:create-relationship failed:", t), t;
  }
});
b.handle("db:delete-relationship", async (n, e) => {
  try {
    return await S.relationship.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-relationship failed:", t), t;
  }
});
b.handle("db:get-character-items", async (n, e) => {
  try {
    return await S.itemOwnership.findMany({
      where: { characterId: e },
      include: { item: !0 }
    });
  } catch (t) {
    throw console.error("[Main] db:get-character-items failed:", t), t;
  }
});
b.handle("db:add-item-to-character", async (n, e) => {
  try {
    const t = await S.itemOwnership.create({
      data: e,
      include: { item: !0 }
    });
    return _e("character", e.characterId, "add-item-to-character"), t;
  } catch (t) {
    throw console.error("[Main] db:add-item-to-character failed:", t), t;
  }
});
b.handle("db:remove-item-from-character", async (n, e) => {
  try {
    const t = await S.itemOwnership.findUnique({ where: { id: e }, select: { characterId: !0 } }), r = await S.itemOwnership.delete({ where: { id: e } });
    return t != null && t.characterId && _e("character", t.characterId, "remove-item-from-character"), r;
  } catch (t) {
    throw console.error("[Main] db:remove-item-from-character failed:", t), t;
  }
});
b.handle("db:update-item-ownership", async (n, e, t) => {
  try {
    const r = await S.itemOwnership.update({
      where: { id: e },
      data: t,
      include: { item: !0 }
    });
    return _e("character", r.characterId, "update-item-ownership"), r;
  } catch (r) {
    throw console.error("[Main] db:update-item-ownership failed:", r), r;
  }
});
b.handle("db:get-character-timeline", async (n, e) => {
  try {
    const t = await S.character.findUnique({ where: { id: e }, select: { name: !0, novelId: !0 } });
    if (!t)
      return [];
    const r = await S.plotPointAnchor.findMany({
      where: {
        plotPoint: {
          novelId: t.novelId,
          description: { contains: `@${t.name}` }
        }
      },
      include: {
        plotPoint: { select: { title: !0, description: !0, plotLine: { select: { name: !0 } } } },
        chapter: { select: { id: !0, title: !0, order: !0, volume: { select: { title: !0, order: !0 } } } }
      },
      orderBy: [{ chapter: { volume: { order: "asc" } } }, { chapter: { order: "asc" } }]
    }), a = /* @__PURE__ */ new Set();
    return r.filter((s) => s.chapter && !a.has(s.chapter.id) && a.add(s.chapter.id)).map((s) => {
      var i;
      return {
        chapterId: s.chapter.id,
        chapterTitle: s.chapter.title,
        volumeTitle: s.chapter.volume.title,
        order: s.chapter.order,
        volumeOrder: s.chapter.volume.order,
        snippet: ((i = s.plotPoint.description) == null ? void 0 : i.substring(0, 100)) || s.plotPoint.title
      };
    });
  } catch (t) {
    throw console.error("[Main] db:get-character-timeline failed:", t), t;
  }
});
function Ha(n) {
  if (!n)
    return "";
  try {
    const e = JSON.parse(n);
    if (!e.root)
      return n;
    const t = [], r = (a) => {
      a.text && t.push(a.text), a.children && Array.isArray(a.children) && a.children.forEach(r), (a.type === "paragraph" || a.type === "heading" || a.type === "quote") && t.push(" ");
    };
    return r(e.root), t.join("").replace(/\s+/g, " ").trim();
  } catch {
    return n;
  }
}
b.handle("db:get-character-chapter-appearances", async (n, e) => {
  try {
    const t = await S.character.findUnique({ where: { id: e }, select: { name: !0, novelId: !0 } });
    return t ? (await S.chapter.findMany({
      where: {
        volume: { novelId: t.novelId },
        // Use LIKE for rough match on JSON string (imperfect but fast first filter)
        content: { contains: t.name }
      },
      select: {
        id: !0,
        title: !0,
        order: !0,
        content: !0,
        volume: { select: { title: !0, order: !0 } }
      },
      orderBy: [{ volume: { order: "asc" } }, { order: "asc" }]
    })).map((a) => {
      const s = Ha(a.content || "");
      let i = "";
      const o = s.indexOf(t.name);
      if (o >= 0) {
        const c = Math.max(0, o - 30), d = Math.min(s.length, o + t.name.length + 50);
        i = (c > 0 ? "..." : "") + s.substring(c, d) + (d < s.length ? "..." : "");
      }
      return {
        chapterId: a.id,
        chapterTitle: a.title,
        volumeTitle: a.volume.title,
        order: a.order,
        volumeOrder: a.volume.order,
        snippet: i
      };
    }).filter((a) => a.snippet !== "") : [];
  } catch (t) {
    throw console.error("[Main] db:get-character-chapter-appearances failed:", t), t;
  }
});
b.handle("db:get-recent-chapters", async (n, e, t, r = 5) => {
  try {
    return await S.chapter.findMany({
      where: {
        volume: { novelId: t },
        content: { contains: `@${e}` }
      },
      select: {
        id: !0,
        title: !0,
        order: !0,
        wordCount: !0,
        updatedAt: !0
      },
      orderBy: { updatedAt: "desc" },
      take: r
    });
  } catch (a) {
    throw console.error("[Main] db:get-recent-chapters failed:", a), a;
  }
});
j.on("window-all-closed", () => {
  process.platform !== "darwin" && (j.quit(), q = null);
});
j.on("before-quit", () => {
  for (const n of et.values())
    n();
  et.clear(), nr && nr.stop().catch((n) => {
    console.error("[Main] Failed to stop automation server:", n);
  }), xe && xe.stop().catch((n) => {
    console.error("[Main] Failed to stop agent runtime:", n);
  });
});
j.on("activate", () => {
  ea.getAllWindows().length === 0 && Va();
});
j.whenReady().then(async () => {
  var s, i, o;
  if (We.error) {
    rn(j.getPath("userData")), Qn(), console.error(`[AI-Diag] Invalid arguments: ${We.error}`), j.exit(2);
    return;
  }
  j.setAppUserModelId(Uc()), j.setName(j.isPackaged ? Ua : Pc);
  const n = (s = We.command) != null && s.userDataPath ? D.resolve(We.command.userDataPath) : jc();
  if (j.setPath("userData", n), rn(j.getPath("userData")), Qn(), console.log("[Main] App Ready. Starting DB Setup..."), console.log("[Main] User Data Path:", j.getPath("userData")), We.command || (xe = new _i({
    getUserDataPath: () => j.getPath("userData"),
    getAutomationRuntimePath: qa,
    isPackaged: j.isPackaged
  }), xe.prewarm()), We.command && j.isPackaged) {
    console.error("[AI-Diag] --ai-diag is only available in development mode."), j.exit(1);
    return;
  }
  (i = We.command) != null && i.userDataPath && console.log("[AI-Diag] userData override:", n);
  const e = D.resolve(j.getPath("userData"));
  Ga.handle("local-resource", (c) => {
    const d = decodeURIComponent(c.url.replace("local-resource://", "")), l = D.resolve(D.join(e, d));
    return !l.startsWith(e + D.sep) && l !== e ? new Response("Forbidden", { status: 403 }) : qr.fetch("file:///" + l.replace(/\\/g, "/"));
  });
  let t;
  j.isPackaged && Gr() ? t = $c() : t = j.getPath("userData"), Bc(), Fc();
  const r = (o = We.command) != null && o.dbPath ? D.resolve(We.command.dbPath) : D.join(t, "novel_editor.db"), a = `file:${r}`;
  if (console.log("[Main] Database Path:", r), z.existsSync(D.dirname(r)) || z.mkdirSync(D.dirname(r), { recursive: !0 }), !j.isPackaged) {
    const c = D.resolve(kt, "../../../packages/core/prisma/schema.prisma");
    if (console.log("[Main] Development mode detected (unpackaged). Checking schema at:", c), z.existsSync(c)) {
      const d = D.dirname(r);
      z.existsSync(d) || z.mkdirSync(d, { recursive: !0 }), console.log("[Main] Schema found."), console.log("[Main] Cleaning up FTS tables before migration..."), Yr(a);
      try {
        await S.$executeRawUnsafe("DROP TABLE IF EXISTS search_index;"), console.log("[Main] FTS tables dropped successfully.");
      } catch (m) {
        console.warn("[Main] Failed to drop FTS table (non-critical):", m);
      }
      await S.$disconnect(), console.log("[Main] Attempting synchronous DB push to:", r);
      const l = D.resolve(kt, "../../../packages/core/node_modules/.bin/prisma.cmd");
      if (console.log("[Main] Using Prisma binary at:", l), !z.existsSync(l))
        console.error("[Main] Prisma binary NOT found at:", l);
      else
        try {
          const m = `"${l}" db push --schema="${c}" --accept-data-loss --skip-generate`;
          console.log("[Main] Executing command:", m);
          const h = Ya(m, {
            env: { ...process.env, DATABASE_URL: a },
            cwd: D.resolve(kt, "../../../packages/core"),
            stdio: "pipe",
            // Avoid inherit to prevent encoding issues
            windowsHide: !0
          });
          console.log("[Main] DB Push output:", h.toString()), console.log("[Main] DB Push completed successfully.");
        } catch (m) {
          console.error("[Main] DB Push failed."), m.stdout && console.log("[Main] stdout:", m.stdout.toString()), m.stderr && console.error("[Main] stderr:", m.stderr.toString());
        }
    } else
      console.warn("[Main] Schema file NOT found at:", c);
  }
  Yr(a);
  try {
    await Ka() && console.log("[Main] Bundled database schema applied successfully."), await ur.ensureSchema(), await ut.ensureSchema();
  } catch (c) {
    throw console.error("[Main] Failed to ensure bundled database schema:", c), c;
  }
  if (ee = new Uo(() => j.getPath("userData")), gs((c, d, l) => {
    _e(c, d, l);
  }), Fr = new fi(ee, () => j.getPath("userData"), ut), nr = new pi(
    Fr,
    () => j.getPath("userData"),
    (c) => {
      q == null || q.webContents.send("automation:data-changed", { method: c });
    }
  ), await nr.start(), We.command)
    try {
      const c = await Gc(ee, We.command);
      await S.$disconnect(), j.exit(c);
      return;
    } catch (c) {
      console.error("[AI-Diag] Execution failed:", c), await S.$disconnect(), j.exit(1);
      return;
    }
  await rs(), console.log("[Main] Search index initialized");
  try {
    await ja(ee.getSettings());
  } catch (c) {
    console.warn("[Main] Failed to apply AI proxy settings:", c);
  }
  Va();
});
export {
  fd as MAIN_DIST,
  Pa as RENDERER_DIST,
  Br as VITE_DEV_SERVER_URL
};
