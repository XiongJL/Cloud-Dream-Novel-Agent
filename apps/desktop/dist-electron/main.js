var Rs = Object.defineProperty;
var Ds = (n, e, t) => e in n ? Rs(n, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : n[e] = t;
var H = (n, e, t) => (Ds(n, typeof e != "symbol" ? e + "" : e, t), t);
import { net as Dr, app as V, dialog as yt, ipcMain as N, nativeImage as ks, BrowserWindow as Fn, protocol as Os, session as Ot } from "electron";
import { db as S, initDb as qr, ensureDbSchema as Ls } from "@novel-editor/core";
import { fileURLToPath as Ms } from "node:url";
import k from "node:path";
import { createHash as Ne, randomUUID as fe } from "node:crypto";
import Kt from "node:http";
import { execSync as Ps } from "child_process";
import q from "fs";
import re from "node:fs";
import { spawn as qn } from "node:child_process";
import Ve from "node:fs/promises";
import Us from "node:net";
import Ge from "path";
import jn from "zlib";
import ft from "crypto";
const $s = [
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
async function jr() {
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
async function Bs() {
  return (await S.$queryRawUnsafe("PRAGMA table_info(search_index);")).map((e) => e.name);
}
async function Vr() {
  const n = await S.novel.findMany({
    where: { deleted: !1 },
    select: { id: !0 }
  });
  for (const e of n)
    await Jn(e.id);
}
async function Fs() {
  try {
    if ((await S.$queryRaw`
            SELECT name FROM sqlite_master WHERE type='table' AND name='search_index';
        `).length === 0)
      await jr(), console.log("[SearchIndex] FTS5 table created successfully"), await Vr(), console.log("[SearchIndex] FTS5 index rebuilt from source data");
    else {
      const e = await Bs(), t = $s.filter((r) => !e.includes(r));
      t.length > 0 && (console.warn(`[SearchIndex] Schema mismatch detected. Rebuilding FTS5 table. Missing columns: ${t.join(", ")}`), await S.$executeRawUnsafe("DROP TABLE IF EXISTS search_index;"), await jr(), await Vr(), console.log("[SearchIndex] FTS5 table rebuilt successfully"));
    }
  } catch (n) {
    console.error("[SearchIndex] Failed to initialize FTS5 table:", n);
  }
}
function qs(n) {
  if (!n)
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (s) => {
      s.type === "text" && s.text && t.push(s.text), s.children && Array.isArray(s.children) && (s.children.forEach(r), s.type !== "root" && s.type !== "list" && s.type !== "listitem" && t.push(" "));
    };
    return e.root && r(e.root), t.join("").trim();
  } catch {
    return n;
  }
}
async function Ue(n) {
  const e = qs(n.content);
  let t = n.novelId, r = n.volumeTitle, s = n.order, a = n.volumeOrder;
  if (!t || !r || s === void 0 || a === void 0) {
    const i = await S.chapter.findUnique({
      where: { id: n.id },
      select: {
        order: !0,
        volume: { select: { id: !0, novelId: !0, title: !0, order: !0 } }
      }
    });
    i && (s === void 0 && (s = i.order), i.volume && (t || (t = i.volume.novelId), r || (r = i.volume.title), a === void 0 && (a = i.volume.order)));
  }
  if (t)
    try {
      await S.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'chapter' AND entity_id = ${n.id};
        `, await S.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${e}, 'chapter', ${n.id}, ${t}, ${n.id}, ${n.title}, ${r || ""}, ${s || 0}, ${a || 0}, ${n.volumeId});
        `;
    } catch (i) {
      console.error("[SearchIndex] Failed to index chapter:", i);
    }
}
async function kr(n) {
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
async function Vn(n, e) {
  try {
    await S.$executeRaw`
            DELETE FROM search_index WHERE entity_type = ${n} AND entity_id = ${e};
        `;
  } catch (t) {
    console.error("[SearchIndex] Failed to remove from index:", t);
  }
}
async function Or(n, e, t = 20, r = 0) {
  if (!e.trim())
    return [];
  try {
    const a = `%${e.replace(/[%_]/g, "\\$&")}%`, i = await S.$queryRaw`
            SELECT entity_type, entity_id, chapter_id, novel_id, title, volume_title, content, chapter_order, volume_order, volume_id
            FROM search_index
            WHERE novel_id = ${n}
            AND (content LIKE ${a} OR title LIKE ${a} OR volume_title LIKE ${a})
            ORDER BY volume_order ASC, chapter_order ASC
            LIMIT ${t} OFFSET ${r};
        `, o = [], c = e.toLowerCase(), d = /* @__PURE__ */ new Set();
    for (const l of i) {
      const m = l.content || "", h = l.title || "", p = l.volume_title || "", f = Number(l.chapter_order || 0), v = Number(l.volume_order || 0);
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
        volumeOrder: v,
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
        volumeOrder: v,
        volumeId: l.volume_id
      });
      const w = m.toLowerCase(), g = [];
      let u = 0;
      for (; u < w.length && g.length < 200; ) {
        const A = w.indexOf(c, u);
        if (A === -1)
          break;
        g.push(A), u = A + c.length;
      }
      const I = 60, y = [];
      for (const A of g)
        (y.length === 0 || A - y[y.length - 1] > I) && y.push(A);
      for (const A of y)
        o.push({
          entityType: l.entity_type,
          entityId: l.entity_id,
          chapterId: l.chapter_id,
          novelId: l.novel_id,
          title: l.title,
          snippet: Jr(m, e, A, 10, !0),
          preview: Jr(m, e, A, 25, !1),
          keyword: e,
          matchType: "content",
          chapterOrder: f,
          volumeTitle: p,
          volumeOrder: v,
          volumeId: l.volume_id
        });
    }
    return o;
  } catch (s) {
    return console.error("[SearchIndex] Search failed:", s), [];
  }
}
function Jr(n, e, t, r = 30, s = !0) {
  if (!n)
    return "";
  const a = Math.max(0, t - r), i = Math.min(n.length, t + e.length + r * 2);
  let o = "";
  a > 0 && (o += "...");
  const c = n.substring(a, t), d = n.substring(t, t + e.length), l = n.substring(t + e.length, i);
  return s ? o += c + "<mark>" + d + "</mark>" + l : o += c + d + l, i < n.length && (o += "..."), o;
}
async function Jn(n) {
  var r, s;
  let e = 0, t = 0;
  try {
    await S.$executeRaw`DELETE FROM search_index WHERE novel_id = ${n};`;
    const a = await S.chapter.findMany({
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
    for (const o of a)
      await Ue({
        ...o,
        novelId: n,
        volumeTitle: (r = o.volume) == null ? void 0 : r.title,
        volumeOrder: (s = o.volume) == null ? void 0 : s.order
      }), e++;
    const i = await S.idea.findMany({
      where: { novelId: n },
      select: { id: !0, content: !0, quote: !0, novelId: !0, chapterId: !0 }
    });
    for (const o of i)
      await kr(o), t++;
  } catch (a) {
    console.error("[SearchIndex] Rebuild failed:", a);
  }
  return { chapters: e, ideas: t };
}
async function js(n) {
  try {
    const e = await S.$queryRaw`
            SELECT entity_type, COUNT(*) as count FROM search_index WHERE novel_id = ${n} GROUP BY entity_type;
        `;
    let t = 0, r = 0;
    return e.forEach((s) => {
      s.entity_type === "chapter" && (t = Number(s.count)), s.entity_type === "idea" && (r = Number(s.count));
    }), { chapters: t, ideas: r };
  } catch (e) {
    return console.error("[SearchIndex] Failed to get stats:", e), { chapters: 0, ideas: 0 };
  }
}
class O extends Error {
  constructor(t, r, s, a) {
    super(r);
    H(this, "code");
    H(this, "detail");
    H(this, "details");
    this.code = t, this.detail = s, this.details = a, this.name = "AiActionError";
  }
}
function Vs(n) {
  const e = n.toLowerCase();
  return e.includes("cancelled") || e.includes("canceled") ? new O("CANCELLED", n) : e.includes("timed out") || e.includes("timeout") || e.includes("aborterror") || e.includes("aborted") ? new O("PROVIDER_TIMEOUT", n) : e.includes("401") || e.includes("403") || e.includes("unauthorized") || e.includes("forbidden") || e.includes("api key") ? new O("PROVIDER_AUTH", n) : e.includes("content_filter") || e.includes("safety") || e.includes("filtered") ? new O("PROVIDER_FILTERED", n) : e.includes("429") || e.includes("503") || e.includes("model") || e.includes("unavailable") ? new O("PROVIDER_UNAVAILABLE", n) : e.includes("fetch") || e.includes("network") || e.includes("econn") ? new O("NETWORK_ERROR", n) : new O("UNKNOWN", n);
}
function je(n) {
  if (n instanceof O)
    return n;
  const e = n instanceof Error ? n.message : String(n ?? "unknown error");
  return Vs(e);
}
function It(n, e) {
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
const Js = "debug-dev.log", Hs = 15 * 1024 * 1024, zs = "***REDACTED***", Ws = /* @__PURE__ */ new Set([
  "authorization",
  "apikey",
  "api_key",
  "api key",
  "token",
  "access_token",
  "refresh_token"
]);
let Ke = null;
function Lr() {
  return process.env.NODE_ENV !== "production";
}
function Hr(n) {
  Lr() && (Ke = k.join(n, Js), Hn());
}
function Ie(n) {
  return Sr(n, /* @__PURE__ */ new WeakSet());
}
function B(n, e, t, r) {
  if (!Lr())
    return;
  const s = [
    `[${(/* @__PURE__ */ new Date()).toISOString()}] [${n}] [${e}]`,
    `message=${t}`,
    r === void 0 ? "" : `extra=${Ks(Ie(r))}`,
    ""
  ].filter(Boolean);
  Gs(s.join(`
`));
}
function Se(n, e, t) {
  const r = zn(e);
  B("ERROR", n, r.message, {
    error: r,
    ...t === void 0 ? {} : { extra: t }
  });
}
function Hn() {
  if (!Ke)
    return;
  const n = k.dirname(Ke);
  re.existsSync(n) || re.mkdirSync(n, { recursive: !0 }), re.existsSync(Ke) || re.writeFileSync(Ke, "", "utf8");
}
function Gs(n) {
  if (Ke)
    try {
      Hn(), (re.existsSync(Ke) ? re.statSync(Ke).size : 0) >= Hs && re.writeFileSync(Ke, "", "utf8"), re.appendFileSync(Ke, `${n}
`, "utf8");
    } catch {
    }
}
function Ks(n) {
  try {
    return JSON.stringify(n, null, 2);
  } catch {
    return String(n);
  }
}
function zn(n) {
  return n instanceof Error ? {
    name: n.name,
    message: n.message,
    stack: n.stack
  } : {
    name: typeof n,
    message: String(n)
  };
}
function Sr(n, e) {
  if (n == null || typeof n == "string" || typeof n == "number" || typeof n == "boolean")
    return n;
  if (typeof n == "bigint")
    return n.toString();
  if (n instanceof Error)
    return zn(n);
  if (Array.isArray(n))
    return n.map((t) => Sr(t, e));
  if (typeof n == "object") {
    const t = n;
    if (e.has(t))
      return "[Circular]";
    e.add(t);
    const r = {};
    for (const [s, a] of Object.entries(t)) {
      if (Ws.has(s.toLowerCase())) {
        r[s] = zs;
        continue;
      }
      r[s] = Sr(a, e);
    }
    return e.delete(t), r;
  }
  return String(n);
}
function Wn(n) {
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
function zr(n) {
  var e, t, r, s, a;
  return String(
    ((e = n == null ? void 0 : n.error) == null ? void 0 : e.message) || ((r = (t = n == null ? void 0 : n.response) == null ? void 0 : t.error) == null ? void 0 : r.message) || (n == null ? void 0 : n.message) || ((a = (s = n == null ? void 0 : n.response) == null ? void 0 : s.incomplete_details) == null ? void 0 : a.reason) || "Responses stream failed"
  );
}
async function Xs(n) {
  if (!n.body)
    throw new Error("Responses stream body is unavailable");
  const e = n.body.getReader(), t = new TextDecoder();
  let r = "", s = "", a = "", i = null, o = 0;
  const c = (l) => {
    var f, v, w, g;
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
      s += h.delta;
      return;
    }
    if ((h == null ? void 0 : h.type) === "response.output_text.done" && typeof h.text == "string") {
      a = h.text;
      return;
    }
    if ((h == null ? void 0 : h.type) === "response.completed") {
      if (i = h.response, (f = h.response) != null && f.status && h.response.status !== "completed")
        throw new Error(zr(h));
      return;
    }
    if ((h == null ? void 0 : h.type) === "response.failed" || (h == null ? void 0 : h.type) === "response.incomplete" || (h == null ? void 0 : h.type) === "error")
      throw new Error(zr(h));
    const p = (g = (w = (v = h == null ? void 0 : h.choices) == null ? void 0 : v[0]) == null ? void 0 : w.delta) == null ? void 0 : g.content;
    typeof p == "string" && (s += p);
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
    text: (s || a || Wn(i)).trim(),
    model: typeof (i == null ? void 0 : i.model) == "string" ? i.model : void 0,
    responseId: typeof (i == null ? void 0 : i.id) == "string" ? i.id : void 0,
    eventCount: o
  };
}
function Gn(n, e) {
  return `${n.replace(/\/+$/, "")}/${e.replace(/^\/+/, "")}`;
}
function Wr(n, e) {
  const t = n.trim().replace(/\/+$/, "");
  return e === "responses" && /\/responses$/u.test(t) || e === "chat/completions" && /\/chat\/completions$/u.test(t) || e === "images/generations" && /\/images\/generations$/u.test(t) ? t : Gn(t, e);
}
function Zs(n) {
  const t = n.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/u, "").replace(/\/responses$/u, "").replace(/\/images\/generations$/u, "");
  return Gn(t, "models");
}
function Gr(n) {
  try {
    return JSON.parse(n);
  } catch {
    return null;
  }
}
function Kr(n) {
  var a, i;
  const e = String((n == null ? void 0 : n.message) || "unknown error"), t = ((a = n == null ? void 0 : n.cause) == null ? void 0 : a.code) || (n == null ? void 0 : n.code), r = (i = n == null ? void 0 : n.cause) == null ? void 0 : i.message, s = [e];
  return t && s.push(`code=${t}`), r && r !== e && s.push(`cause=${r}`), s.join(" | ");
}
function Xr(n) {
  const e = { ...n };
  return typeof e.instructions == "string" && (e.instructions = `[${e.instructions.length} chars]`), typeof e.input == "string" && (e.input = `[${e.input.length} chars]`), Array.isArray(e.messages) && (e.messages = e.messages.map((t) => ({
    role: t == null ? void 0 : t.role,
    contentChars: typeof (t == null ? void 0 : t.content) == "string" ? t.content.length : void 0
  }))), e;
}
function Ys(n, e, t) {
  var a, i, o;
  if (typeof ((a = t == null ? void 0 : t.error) == null ? void 0 : a.message) == "string" && t.error.message.trim())
    return t.error.message.trim();
  const r = (o = (i = e.match(/<title[^>]*>([^<]+)<\/title>/iu)) == null ? void 0 : i[1]) == null ? void 0 : o.replace(/\s+/gu, " ").trim();
  if (r)
    return `HTTP ${n.status}: ${r}`;
  const s = e.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 240);
  return `HTTP ${n.status}${s ? `: ${s}` : n.statusText ? `: ${n.statusText}` : ""}`;
}
async function nr(n, e) {
  return Dr.fetch(n, e);
}
function Qs(n) {
  const e = n.status;
  let t = "INVALID_INPUT", r = !1;
  return e === 401 || e === 403 ? t = "PROVIDER_AUTH" : e === 408 ? (t = "PROVIDER_TIMEOUT", r = !0) : e === 425 || e === 429 ? (t = "PROVIDER_RATE_LIMITED", r = !0) : e >= 500 && (t = "PROVIDER_UNAVAILABLE", r = !0), new O(
    t,
    r ? "模型服务暂时不可用。" : "模型服务拒绝了当前请求。",
    void 0,
    { httpStatus: e, retryable: r }
  );
}
class Kn {
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
    const s = new AbortController();
    let a = !1;
    const i = Math.max(1e3, r), o = setTimeout(() => {
      a = !0, s.abort();
    }, i), c = Zs(e), d = Date.now();
    try {
      B("INFO", "HttpProvider.healthCheck.request", "HTTP health check request", {
        url: c,
        timeoutMs: i,
        headers: { Authorization: `Bearer ${t}` }
      });
      const l = await nr(c, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${t}`
        },
        signal: s.signal
      });
      return l.ok ? (B("INFO", "HttpProvider.healthCheck.response", "HTTP health check ok", {
        url: c,
        status: l.status,
        elapsedMs: Date.now() - d
      }), { ok: !0, detail: "HTTP provider is reachable" }) : (B("WARN", "HttpProvider.healthCheck.response", "HTTP health check rejected", {
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
        didTimeout: a
      }), a ? { ok: !1, detail: `HTTP health check timed out after ${i}ms` } : { ok: !1, detail: `HTTP health check failed: ${Kr(l)} | url=${c}` };
    } finally {
      clearTimeout(o);
    }
  }
  async generate(e) {
    var h, p, f, v, w, g, u, I, y;
    const t = e.prompt.trim();
    if (!t)
      return { text: "", model: this.settings.http.model };
    const r = new AbortController(), s = () => {
      var A;
      return r.abort((A = e.signal) == null ? void 0 : A.reason);
    };
    (h = e.signal) != null && h.aborted ? s() : (p = e.signal) == null || p.addEventListener("abort", s, { once: !0 });
    let a = !1;
    const i = Math.max(1e3, e.timeoutMs ?? this.settings.http.timeoutMs), o = setTimeout(() => {
      a = !0, r.abort();
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
    }, l = Wr(
      this.settings.http.baseUrl,
      c === "responses" ? "responses" : "chat/completions"
    ), m = Date.now();
    try {
      B("INFO", "HttpProvider.generate.request", "AI text generation request", {
        url: l,
        timeoutMs: i,
        body: Ie(Xr(d))
      });
      const A = await nr(l, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.http.apiKey}`,
          "Content-Type": "application/json",
          ...c === "responses" ? { Accept: "text/event-stream" } : {}
        },
        body: JSON.stringify(d),
        signal: r.signal
      }), C = A.headers.get("content-type") || "";
      if (A.ok && c === "responses" && C.includes("text/event-stream")) {
        const M = await Xs(A);
        if (B("INFO", "HttpProvider.generate.response", "AI text generation stream completed", {
          url: l,
          status: A.status,
          elapsedMs: Date.now() - m,
          responseId: M.responseId,
          model: M.model,
          eventCount: M.eventCount,
          outputChars: M.text.length
        }), !M.text)
          throw new Error("Responses stream completed without output text");
        return {
          text: M.text,
          model: M.model || this.settings.http.model
        };
      }
      const E = await A.text(), T = Gr(E);
      if (B("INFO", "HttpProvider.generate.response", "AI text generation response", {
        url: l,
        status: A.status,
        elapsedMs: Date.now() - m,
        contentType: C,
        outputChars: E.length,
        responsePreview: E.slice(0, 1e3)
      }), !A.ok) {
        const M = Ys(A, E, T);
        throw B("WARN", "HttpProvider.generate.rejected", "AI text generation rejected", {
          url: l,
          status: A.status,
          diagnosticMessage: M
        }), Qs(A);
      }
      const R = ((w = (v = (f = T == null ? void 0 : T.choices) == null ? void 0 : f[0]) == null ? void 0 : v.message) == null ? void 0 : w.content) || (T == null ? void 0 : T.output_text) || Wn(T) || ((u = (g = T == null ? void 0 : T.content) == null ? void 0 : g[0]) == null ? void 0 : u.text) || "";
      return {
        text: typeof R == "string" ? R : JSON.stringify(R),
        model: (T == null ? void 0 : T.model) || this.settings.http.model
      };
    } catch (A) {
      throw Se("HttpProvider.generate.error", A, {
        url: l,
        elapsedMs: Date.now() - m,
        didTimeout: a,
        requestBody: Ie(Xr(d))
      }), (I = e.signal) != null && I.aborted && !a ? new O("CANCELLED", "AI request cancelled", void 0, { retryable: !1 }) : a || (A == null ? void 0 : A.name) === "AbortError" ? new O(
        "PROVIDER_TIMEOUT",
        "模型请求超时。",
        void 0,
        { retryable: !0, timeoutMs: i }
      ) : A instanceof O ? A : new O(
        "NETWORK_ERROR",
        "无法连接模型服务。",
        void 0,
        { retryable: !0 }
      );
    } finally {
      clearTimeout(o), (y = e.signal) == null || y.removeEventListener("abort", s);
    }
  }
  async generateImage(e) {
    var l, m;
    const t = e.prompt.trim();
    if (!t)
      return {};
    const r = new AbortController();
    let s = !1;
    const a = Math.max(1e3, this.settings.http.timeoutMs), i = setTimeout(() => {
      s = !0, r.abort();
    }, a), o = {
      model: e.model || this.settings.http.model,
      prompt: t,
      size: e.size || "1024x1024",
      output_format: e.outputFormat || "png",
      watermark: e.watermark ?? !0
    }, c = Wr(this.settings.http.baseUrl, "images/generations"), d = Date.now();
    try {
      B("INFO", "HttpProvider.generateImage.request", "AI image generation request", {
        url: c,
        timeoutMs: a,
        body: Ie(o)
      });
      const h = await nr(c, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.http.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(o),
        signal: r.signal
      }), p = await h.text(), f = Gr(p);
      if (B("INFO", "HttpProvider.generateImage.response", "AI image generation response", {
        url: c,
        status: h.status,
        elapsedMs: Date.now() - d,
        text: p
      }), !h.ok)
        throw new Error(((l = f == null ? void 0 : f.error) == null ? void 0 : l.message) || `HTTP ${h.status}: ${p.slice(0, 300)}`);
      const v = ((m = f == null ? void 0 : f.data) == null ? void 0 : m[0]) || {};
      return {
        imageUrl: v.url,
        imageBase64: v.b64_json,
        mimeType: "image/png"
      };
    } catch (h) {
      throw Se("HttpProvider.generateImage.error", h, {
        url: c,
        elapsedMs: Date.now() - d,
        didTimeout: s,
        requestBody: Ie(o)
      }), s || (h == null ? void 0 : h.name) === "AbortError" ? new Error(`HTTP request timeout after ${a}ms`) : new Error(`HTTP request failed: ${Kr(h)} | url=${c}`);
    } finally {
      clearTimeout(i);
    }
  }
}
const se = "[Summary]", Xn = {
  summaryMode: "local",
  summaryTriggerPolicy: "manual",
  summaryDebounceMs: 3e4,
  summaryMinIntervalMs: 18e4,
  summaryMinWordDelta: 120,
  summaryFinalizeStableMs: 6e5,
  summaryFinalizeMinWords: 1200,
  recentChapterRawCount: 2
}, ut = {
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
  summary: Xn,
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
}, sr = /* @__PURE__ */ new Map(), Tt = /* @__PURE__ */ new Map(), ar = /* @__PURE__ */ new Map(), or = /* @__PURE__ */ new Map();
let Zr = !1, Vt = null;
function ea(n) {
  Vt = n;
}
function Ar(n, e, t) {
  try {
    Vt == null || Vt(n, e, t);
  } catch (r) {
    console.warn(`${se} failed to notify RAG summary index refresh:`, r);
  }
}
function ta(n) {
  if (!(n != null && n.trim()))
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (s) => {
      !s || typeof s != "object" || (typeof s.text == "string" && t.push(s.text), Array.isArray(s.children) && s.children.forEach(r));
    };
    return r((e == null ? void 0 : e.root) || e), t.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return n.replace(/\s+/g, " ").trim();
  }
}
function ra(n) {
  return n ? n.split(/[。！？!?]/).map((t) => t.trim()).filter(Boolean).slice(0, 5).map((t, r) => `fact_${r + 1}: ${t.slice(0, 80)}`) : [];
}
function na(n) {
  return n ? n.split(/[。！？!?]/).map((e) => e.trim()).filter((e) => e.includes("？") || e.includes("?")).slice(0, 5) : [];
}
function sa(n, e, t, r) {
  const s = Number.isFinite(e) ? `第${e}章` : "章节", a = r.length > 0 ? r.join(" | ") : "无明显关键事实";
  return `${s}《${n || "未命名章节"}》摘要：${t}
关键事实：${a}`;
}
function Yr(n) {
  if (typeof n != "string" || !n.trim())
    return [];
  try {
    const e = JSON.parse(n);
    return Array.isArray(e) ? e.map((t) => String(t || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function aa(n) {
  return Ne("sha256").update(n.join("|")).digest("hex");
}
function oa(n, e, t) {
  const r = n === "volume" ? `卷级摘要（覆盖${e}章）` : `全书摘要（覆盖${e}章）`, s = t.map((a, i) => `${i + 1}. ${a}`).join(`
`);
  return `${r}
${s}`.slice(0, 2400);
}
function ia() {
  return k.join(V.getPath("userData"), "ai-settings.json");
}
function Zn() {
  try {
    const n = ia();
    if (!re.existsSync(n))
      return ut;
    const e = re.readFileSync(n, "utf8"), t = JSON.parse(e);
    return {
      ...ut,
      ...t,
      http: { ...ut.http, ...t.http ?? {} },
      mcpCli: { ...ut.mcpCli, ...t.mcpCli ?? {} },
      proxy: { ...ut.proxy, ...t.proxy ?? {} },
      summary: { ...Xn, ...t.summary ?? {} }
    };
  } catch (n) {
    return console.warn(`${se} failed to load ai-settings.json, fallback to defaults:`, n), ut;
  }
}
async function Qr(n, e) {
  return {
    summaryText: n.slice(0, 220) || "章节内容为空，暂无可提炼摘要。",
    keyFacts: ra(n),
    openQuestions: na(n),
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
async function ca(n, e, t, r) {
  var m, h;
  if (!(t.providerType === "http" && !!((m = t.http.baseUrl) != null && m.trim()) && !!((h = t.http.apiKey) != null && h.trim())))
    throw new Error("AI summary mode requires HTTP provider with baseUrl and apiKey");
  console.log(`${se} [${n}] AI summary start (model=${t.http.model})`);
  const a = new Kn(t), i = Date.now(), o = await a.generate({
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
  return console.log(`${se} [${n}] AI summary success (${l}ms)`), {
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
async function en(n, e, t) {
  const r = n === "volume" ? { novelId: e, volumeId: t || "", isLatest: !0, status: "active" } : { novelId: e, isLatest: !0, status: "active" }, s = await S.chapterSummary.findMany({
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
  if (s.length === 0)
    return null;
  const a = s.map((w) => w.chapterId), i = s.map((w) => Number(w.chapterOrder)).filter((w) => Number.isFinite(w)), o = i.length > 0 ? Math.min(...i) : null, c = i.length > 0 ? Math.max(...i) : null, d = s.map((w) => String(w.summaryText || "").trim()).filter(Boolean).slice(-10), l = [...new Set(
    s.flatMap((w) => Yr(w.keyFacts))
  )].map((w) => String(w || "").slice(0, 120)).filter(Boolean).slice(0, 24), m = [...new Set(
    s.flatMap((w) => Yr(w.openQuestions))
  )].map((w) => String(w || "").slice(0, 120)).filter(Boolean).slice(0, 20), h = [
    n === "volume" ? "保持本卷叙事风格一致" : "保持全书叙事风格一致",
    "优先遵循现有大纲与关键事实"
  ], p = [
    "不得与已确认关键事实冲突",
    "保持角色动机与关系连续"
  ], f = aa(
    s.map((w) => `${w.id}:${new Date(w.updatedAt).toISOString()}`)
  );
  let v = null;
  if (n === "volume" && t) {
    const w = await S.volume.findUnique({
      where: { id: t },
      select: { title: !0 }
    });
    v = (w == null ? void 0 : w.title) || null;
  }
  return {
    title: v,
    summaryText: oa(n, a.length, d),
    keyFacts: l,
    unresolvedThreads: m,
    styleGuide: h,
    hardConstraints: p,
    coverageChapterIds: a,
    chapterRangeStart: o,
    chapterRangeEnd: c,
    sourceFingerprint: f
  };
}
async function tn(n, e, t, r) {
  return S.$transaction(async (s) => {
    await s.narrativeSummary.updateMany({
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
    const a = await s.narrativeSummary.findFirst({
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
    return a != null && a.id ? (await s.narrativeSummary.update({
      where: { id: a.id },
      data: i
    })).id : (await s.narrativeSummary.create({ data: i })).id;
  });
}
async function da(n, e) {
  try {
    const [t, r] = await Promise.all([
      en("volume", n, e),
      en("novel", n, null)
    ]);
    if (t) {
      const s = await tn("volume", n, t, e);
      console.log(`${se} [novel=${n}] narrative summary updated (level=volume, volume=${e})`), s && Ar("narrativeSummary", s, "narrative-summary-volume");
    }
    if (r) {
      const s = await tn("novel", n, r, null);
      console.log(`${se} [novel=${n}] narrative summary updated (level=novel)`), s && Ar("narrativeSummary", s, "narrative-summary-novel");
    }
  } catch (t) {
    console.error(`${se} [novel=${n}] narrative summary rebuild failed:`, t);
  }
}
function la(n, e) {
  const t = `${n}:${e}`, r = or.get(t);
  r && clearTimeout(r);
  const s = setTimeout(() => {
    or.delete(t), da(n, e);
  }, 15e3);
  or.set(t, s);
}
async function ir(n, e) {
  var I;
  const t = Zn(), r = !!(e != null && e.force), s = (e == null ? void 0 : e.reason) || "save", a = t.summary.summaryMode === "ai", i = a ? Math.max(18e5, t.summary.summaryMinIntervalMs) : t.summary.summaryMinIntervalMs, o = a ? Math.max(800, t.summary.summaryMinWordDelta) : t.summary.summaryMinWordDelta, c = await S.chapter.findUnique({
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
  if (!((I = c == null ? void 0 : c.volume) != null && I.novelId)) {
    console.log(`${se} [${n}] skip: chapter or novel relation missing`);
    return;
  }
  if (!Zr)
    try {
      const y = await S.$queryRawUnsafe("PRAGMA database_list;"), A = Array.isArray(y) ? y.find((C) => (C == null ? void 0 : C.name) === "main") : null;
      console.log(`${se} sqlite main db path: ${(A == null ? void 0 : A.file) || "unknown"}`);
    } catch {
      console.warn(`${se} failed to read sqlite db path via PRAGMA database_list`);
    } finally {
      Zr = !0;
    }
  const d = c.content || "", l = Ne("sha256").update(d).digest("hex"), m = Date.now(), h = await S.chapterSummary.findFirst({
    where: {
      chapterId: c.id,
      isLatest: !0,
      status: "active",
      summaryType: "standard"
    },
    orderBy: { updatedAt: "desc" }
  });
  if (!r && (h == null ? void 0 : h.sourceContentHash) === l) {
    console.log(`${se} [${n}] skip: same content hash`);
    return;
  }
  const p = Math.abs((c.wordCount || 0) - Number((h == null ? void 0 : h.sourceWordCount) || 0)), f = h != null && h.updatedAt ? new Date(h.updatedAt).getTime() : 0, v = f > 0 ? m - f : Number.MAX_SAFE_INTEGER;
  if (!r && f > 0 && v < i && p < o) {
    console.log(
      `${se} [${n}] skip: throttled (deltaWords=${p}, sinceLastMs=${v}, minIntervalMs=${i}, minWordDelta=${o})`
    );
    return;
  }
  const w = ta(d);
  console.log(
    `${se} [${n}] start rebuild (reason=${s}, mode=${t.summary.summaryMode}, words=${c.wordCount || w.length}, deltaWords=${p}, force=${r})`
  );
  let g = await Qr(w, c.order ?? null);
  if (t.summary.summaryMode === "ai")
    try {
      g = await ca(n, w, t, c.order ?? null);
    } catch (y) {
      console.warn(`${se} [${n}] AI summary failed, fallback to local: ${(y == null ? void 0 : y.message) || "unknown error"}`), g = {
        ...await Qr(w, c.order ?? null),
        errorCode: "AI_SUMMARY_FALLBACK",
        errorDetail: (y == null ? void 0 : y.message) || "unknown ai summary error"
      };
    }
  const u = await S.$transaction(async (y) => {
    await y.chapterSummary.updateMany({
      where: { chapterId: c.id, isLatest: !0 },
      data: { isLatest: !1, status: "stale" }
    });
    const A = await y.chapterSummary.findFirst({
      where: {
        chapterId: c.id,
        sourceContentHash: l,
        summaryType: "standard"
      }
    }), C = {
      novelId: c.volume.novelId,
      volumeId: c.volumeId,
      chapterId: c.id,
      summaryType: "standard",
      summaryText: g.summaryText,
      compressedMemory: sa(c.title || "", c.order ?? null, g.summaryText, g.keyFacts),
      keyFacts: JSON.stringify(g.keyFacts),
      entitiesSnapshot: JSON.stringify({}),
      timelineHints: JSON.stringify(g.timelineHints),
      openQuestions: JSON.stringify(g.openQuestions),
      sourceContentHash: l,
      sourceWordCount: c.wordCount || w.length,
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
      const T = await y.chapterSummary.update({
        where: { id: A.id },
        data: C
      });
      return console.log(`${se} [${n}] done: updated existing summary`), T.id;
    }
    const E = await y.chapterSummary.create({
      data: C
    });
    return console.log(`${se} [${n}] done: created new summary`), E.id;
  });
  u && Ar("chapterSummary", u, "chapter-summary"), la(c.volume.novelId, c.volumeId);
}
function nt(n, e = "save") {
  const t = Zn();
  if (e === "manual") {
    console.log(`${se} [${n}] manual trigger received`), ir(n, { force: !0, reason: "manual" }).catch((o) => {
      console.error(`${se} [${n}] manual rebuild failed:`, o);
    });
    return;
  }
  if (t.summary.summaryMode === "ai" && t.summary.summaryTriggerPolicy === "manual") {
    console.log(`${se} [${n}] skip scheduling: ai mode manual-only policy`);
    return;
  }
  if (t.summary.summaryMode === "ai" && t.summary.summaryTriggerPolicy === "finalized") {
    const o = Math.max(6e4, t.summary.summaryFinalizeStableMs), c = ar.get(n);
    c && clearTimeout(c);
    const d = setTimeout(async () => {
      ar.delete(n);
      const l = await S.chapter.findUnique({
        where: { id: n },
        select: { wordCount: !0 }
      }), m = (l == null ? void 0 : l.wordCount) || 0;
      if (m < t.summary.summaryFinalizeMinWords) {
        console.log(
          `${se} [${n}] finalized trigger skipped (wordCount=${m}, min=${t.summary.summaryFinalizeMinWords})`
        );
        return;
      }
      console.log(`${se} [${n}] finalized trigger fired after stable window ${o}ms`), ir(n, { force: !0, reason: "finalized" }).catch((h) => {
        console.error(`${se} [${n}] finalized rebuild failed:`, h);
      });
    }, o);
    ar.set(n, d), console.log(`${se} [${n}] finalized trigger scheduled (${o}ms stable window)`);
    return;
  }
  const r = t.summary.summaryMode === "ai", s = Math.max(r ? 3e5 : 1e3, t.summary.summaryDebounceMs), a = sr.get(n);
  if (r) {
    if (a) {
      const o = (Tt.get(n) || 0) + 1;
      Tt.set(n, o), o % 10 === 0 && console.log(`${se} [${n}] ai mode coalescing saves (${o} updates queued, timer unchanged)`);
      return;
    }
    Tt.set(n, 1), console.log(`${se} [${n}] ai mode scheduled (${s}ms, fixed window)`);
  } else
    a ? (clearTimeout(a), console.log(`${se} [${n}] debounce reset (${s}ms)`)) : console.log(`${se} [${n}] debounce scheduled (${s}ms)`);
  const i = setTimeout(() => {
    sr.delete(n);
    const o = Tt.get(n) || 0;
    Tt.delete(n), console.log(r ? `${se} [${n}] ai mode fired after coalescing ${o} saves` : `${se} [${n}] debounce fired, evaluating rebuild`), ir(n).catch((c) => {
      console.error(`${se} [${n}] rebuild failed:`, c);
    });
  }, s);
  sr.set(n, i);
}
function ua(n) {
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
          throw new O("INVALID_INPUT", "novelId is required");
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
        var s;
        const t = e, r = ((s = t == null ? void 0 : t.title) == null ? void 0 : s.trim()) || `新作品 ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`;
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
          throw new O("INVALID_INPUT", "volumeId is required");
        if (!(Number.isFinite(t.offset) || Number.isFinite(t.limit) || t.includeContent === !1))
          return S.chapter.findMany({
            where: { volumeId: t.volumeId },
            orderBy: { order: "asc" }
          });
        const s = Math.max(0, Math.floor(t.offset ?? 0)), a = Math.max(1, Math.min(20, Math.floor(t.limit ?? 20)));
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
          skip: s,
          take: a
        }) : S.chapter.findMany({
          where: { volumeId: t.volumeId },
          orderBy: { order: "asc" },
          skip: s,
          take: a
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
        var s;
        const t = e;
        if (!(t != null && t.volumeId))
          throw new O("INVALID_INPUT", "volumeId is required");
        let r = t.order;
        if (!Number.isFinite(r)) {
          const a = await S.chapter.findFirst({
            where: { volumeId: t.volumeId },
            orderBy: { order: "desc" }
          });
          r = ((a == null ? void 0 : a.order) || 0) + 1;
        }
        return S.chapter.create({
          data: {
            volumeId: t.volumeId,
            title: ((s = t.title) == null ? void 0 : s.trim()) || "",
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
          throw new O("INVALID_INPUT", "chapterId is required");
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
          throw new O("INVALID_INPUT", "chapterId is required");
        if (typeof t.content != "string")
          throw new O("INVALID_INPUT", "content is required");
        const r = t.source === "ai_ui" ? "ai_ui" : "ai_agent", s = await S.chapter.findUnique({
          where: { id: t.chapterId },
          select: { id: !0, content: !0, updatedAt: !0, wordCount: !0, volume: { select: { novelId: !0 } } }
        });
        if (!s || !s.volume)
          throw new O("NOT_FOUND", "Chapter or volume not found");
        const a = t.content.length, i = a - s.wordCount;
        try {
          const [, o] = await S.$transaction([
            S.novel.update({
              where: { id: s.volume.novelId },
              data: { wordCount: { increment: i }, updatedAt: /* @__PURE__ */ new Date() }
            }),
            S.chapter.update({
              where: { id: t.chapterId },
              data: { content: t.content, wordCount: a, updatedAt: /* @__PURE__ */ new Date() }
            })
          ]);
          return nt(t.chapterId), {
            chapter: o,
            saveMeta: {
              source: r,
              rollbackPoint: {
                chapterId: s.id,
                content: s.content,
                updatedAt: s.updatedAt
              }
            }
          };
        } catch (o) {
          const c = je(o);
          throw new O("PERSISTENCE_ERROR", c.message);
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
          throw new O("INVALID_INPUT", "novelId, chapterId, currentContent are required");
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
          throw je(r);
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
          throw new O("INVALID_INPUT", "novelId is required");
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
          throw new O("INVALID_INPUT", "novelId is required");
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
        const t = e, r = String((t == null ? void 0 : t.novelId) || "").trim(), s = String((t == null ? void 0 : t.name) || "").trim();
        if (!r)
          throw new O("INVALID_INPUT", "novelId is required");
        if (!s)
          throw new O("INVALID_INPUT", "name is required");
        let a = t == null ? void 0 : t.sortOrder;
        if (typeof a != "number" || !Number.isFinite(a)) {
          const d = await S.worldSetting.findFirst({
            where: { novelId: r },
            orderBy: { sortOrder: "desc" }
          });
          a = ((d == null ? void 0 : d.sortOrder) || 0) + 1;
        }
        const i = typeof (t == null ? void 0 : t.content) == "string" ? t.content : "", o = typeof (t == null ? void 0 : t.type) == "string" && t.type.trim() ? t.type.trim() : "other", c = typeof (t == null ? void 0 : t.icon) == "string" && t.icon.trim() ? t.icon.trim() : null;
        return S.worldSetting.create({
          data: {
            novelId: r,
            name: s,
            content: i,
            type: o,
            icon: c,
            sortOrder: a
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
          throw new O("INVALID_INPUT", "id is required");
        const s = {};
        if (Object.prototype.hasOwnProperty.call(t, "name")) {
          const a = String((t == null ? void 0 : t.name) || "").trim();
          if (!a)
            throw new O("INVALID_INPUT", "name cannot be empty");
          s.name = a;
        }
        if (Object.prototype.hasOwnProperty.call(t, "content") && (s.content = typeof (t == null ? void 0 : t.content) == "string" ? t.content : ""), Object.prototype.hasOwnProperty.call(t, "type") && (s.type = typeof (t == null ? void 0 : t.type) == "string" && t.type.trim() ? t.type.trim() : "other"), Object.prototype.hasOwnProperty.call(t, "icon") && ((t == null ? void 0 : t.icon) === null ? s.icon = null : s.icon = typeof (t == null ? void 0 : t.icon) == "string" && t.icon.trim() ? t.icon.trim() : null), Object.prototype.hasOwnProperty.call(t, "sortOrder")) {
          if (typeof (t == null ? void 0 : t.sortOrder) != "number" || !Number.isFinite(t.sortOrder))
            throw new O("INVALID_INPUT", "sortOrder must be a finite number");
          s.sortOrder = t.sortOrder;
        }
        if (Object.keys(s).length === 0)
          throw new O("INVALID_INPUT", "At least one updatable field is required");
        return S.worldSetting.update({
          where: { id: r },
          data: s
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
          throw new O("INVALID_INPUT", "novelId is required");
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
          throw new O("INVALID_INPUT", "novelId is required");
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
          throw new O("INVALID_INPUT", "novelId and keyword are required");
        return Or(t.novelId, t.keyword, t.limit ?? 20, t.offset ?? 0);
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
          throw new O("INVALID_INPUT", "novelId and question are required");
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
        } catch (s) {
          throw je(s);
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
          throw new O("INVALID_INPUT", "novelId is required");
        return n.rebuildRagIndex(t.novelId);
      }
    }
  ];
}
function ha(n) {
  return n.trim() ? (n.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^['"]|['"]$/g, "")) : [];
}
class rn {
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
      B("INFO", "McpCliProvider.healthCheck.request", "MCP CLI health check request", {
        cliPath: e,
        timeoutMs: this.settings.mcpCli.startupTimeoutMs
      });
      const { stdout: t } = await this.runProcess(["--version"], "", this.settings.mcpCli.startupTimeoutMs);
      return B("INFO", "McpCliProvider.healthCheck.response", "MCP CLI health check response", {
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
    const r = this.settings.mcpCli.argsTemplate || "", s = r.includes("{prompt}"), a = ha(r.replace("{prompt}", t));
    B("INFO", "McpCliProvider.generate.request", "MCP CLI generate request", {
      cliPath: this.settings.mcpCli.cliPath,
      args: a,
      prompt: s ? "" : t,
      promptEmbeddedInArgs: s
    });
    const { stdout: i } = await this.runProcess(a, s ? "" : t, this.settings.mcpCli.startupTimeoutMs, e.signal);
    return B("INFO", "McpCliProvider.generate.response", "MCP CLI generate response", {
      cliPath: this.settings.mcpCli.cliPath,
      stdout: i
    }), {
      text: i.trim(),
      model: "mcp-cli"
    };
  }
  async runProcess(e, t, r, s) {
    const { cliPath: a, workingDir: i, envJson: o } = this.settings.mcpCli, c = this.parseEnvJson(o), d = Date.now();
    return new Promise((l, m) => {
      const h = qn(a, e, {
        cwd: i || process.cwd(),
        env: { ...process.env, ...c },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: !0
      });
      let p = "", f = "", v = !1;
      const w = () => s == null ? void 0 : s.removeEventListener("abort", g), g = () => {
        v || (v = !0, clearTimeout(u), h.kill("SIGTERM"), w(), m(new Error("AI request cancelled")));
      }, u = setTimeout(() => {
        v || (v = !0, h.kill("SIGTERM"), w(), B("ERROR", "McpCliProvider.runProcess.timeout", "MCP CLI process timeout", {
          cliPath: a,
          args: e,
          elapsedMs: Date.now() - d
        }), m(new Error("MCP CLI process timeout")));
      }, Math.max(1e3, r));
      s != null && s.aborted ? g() : s == null || s.addEventListener("abort", g, { once: !0 }), h.stdout.on("data", (I) => {
        p += I.toString();
      }), h.stderr.on("data", (I) => {
        f += I.toString();
      }), h.on("error", (I) => {
        v || (v = !0, clearTimeout(u), w(), Se("McpCliProvider.runProcess.error", I, {
          cliPath: a,
          args: e,
          elapsedMs: Date.now() - d,
          env: Ie(c)
        }), m(I));
      }), h.on("close", (I) => {
        if (!v) {
          if (v = !0, clearTimeout(u), w(), I !== 0) {
            B("ERROR", "McpCliProvider.runProcess.exit", "MCP CLI exited with non-zero code", {
              cliPath: a,
              args: e,
              code: I,
              elapsedMs: Date.now() - d,
              stderr: f
            }), m(new Error(`MCP CLI exited with code ${I}: ${f.slice(0, 300)}`));
            return;
          }
          B("INFO", "McpCliProvider.runProcess.exit", "MCP CLI process completed", {
            cliPath: a,
            args: e,
            code: I,
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
      for (const [s, a] of Object.entries(t))
        r[s] = String(a ?? "");
      return r;
    } catch {
      return {};
    }
  }
}
function Ce(n) {
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
    let r = 0, s = !1, a = !1;
    for (let i = t; i < e.length; i += 1) {
      const o = e[i];
      if (s) {
        a ? a = !1 : o === "\\" ? a = !0 : o === '"' && (s = !1);
        continue;
      }
      if (o === '"') {
        s = !0;
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
const Mr = {
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
function Er(n) {
  return n instanceof Date ? n.toISOString() : Array.isArray(n) ? n.map(Er) : !n || typeof n != "object" ? n : Object.fromEntries(
    Object.entries(n).sort(([e], [t]) => e.localeCompare(t)).map(([e, t]) => [e, Er(t)])
  );
}
function Yn(n, e) {
  const t = Object.fromEntries(
    Object.keys(Mr[n]).map((r) => [r, e[r] ?? null])
  );
  return Ne("sha256").update(JSON.stringify(Er(t)), "utf8").digest("hex");
}
function Qe(n, e) {
  return {
    kind: n,
    entityId: String(e.id || ""),
    afterHash: Yn(n, e),
    ...n === "mapCanvas" && typeof e.background == "string" && e.background ? { backgroundPath: e.background } : {}
  };
}
function Qn(n, e) {
  return Object.assign(new Error(n), { code: "VERSION_CONFLICT", details: e });
}
function Xe(n, e) {
  return n.filter((t) => t.kind === e).map((t) => t.entityId);
}
async function ma(n, e, t, r) {
  const s = t.filter((o) => o.kind === r);
  if (!s.length)
    return [];
  const a = await n[r].findMany({
    where: { id: { in: s.map((o) => o.entityId) }, novelId: e },
    select: Mr[r]
  }), i = new Map(
    a.map((o) => [String(o.id), o])
  );
  for (const o of s) {
    const c = i.get(o.entityId);
    if (!c || Yn(r, c) !== o.afterHash)
      throw Qn("素材已在入库后发生变化，无法安全撤销", {
        kind: r,
        entityId: o.entityId
      });
  }
  return a;
}
async function fa(n, e) {
  const t = Xe(e, "plotLine"), r = Xe(e, "plotPoint"), s = Xe(e, "character"), a = Xe(e, "item"), i = Xe(e, "mapCanvas"), o = new Set(r), [c, d, l, m, h, p, f] = await Promise.all([
    t.length ? n.plotPoint.findMany({ where: { plotLineId: { in: t } }, select: { id: !0 } }) : [],
    r.length ? n.plotPointAnchor.count({ where: { plotPointId: { in: r } } }) : 0,
    s.length ? n.itemOwnership.count({ where: { characterId: { in: s } } }) : 0,
    a.length ? n.itemOwnership.count({ where: { itemId: { in: a } } }) : 0,
    s.length ? n.relationship.count({
      where: {
        OR: [
          { sourceId: { in: s } },
          { targetId: { in: s } }
        ]
      }
    }) : 0,
    s.length || i.length ? n.characterMapMarker.count({
      where: {
        OR: [
          ...s.length ? [{ characterId: { in: s } }] : [],
          ...i.length ? [{ mapId: { in: i } }] : []
        ]
      }
    }) : 0,
    i.length ? n.mapElement.count({ where: { mapId: { in: i } } }) : 0
  ]);
  if (c.some((w) => !o.has(w.id)) || d > 0 || l > 0 || m > 0 || h > 0 || p > 0 || f > 0)
    throw Qn("素材已在入库后建立新的关联，无法安全撤销");
}
async function pa(n, e, t) {
  if (t.mode !== "creative_assets" || t.status !== "committed" || !t.creativeAssets)
    throw Object.assign(new Error("Creative assets writeback is not undoable"), { code: "INVALID_STATE" });
  const r = t.creativeAssets.entities;
  if (!r.length)
    throw Object.assign(new Error("Creative assets writeback has no entity snapshots"), { code: "INVALID_STATE" });
  if (new Set(r.map((l) => `${l.kind}:${l.entityId}`)).size !== r.length || r.some((l) => !l.entityId || !l.afterHash))
    throw Object.assign(new Error("Creative assets writeback snapshots are invalid"), { code: "INVALID_STATE" });
  await Promise.all(Object.keys(Mr).map((l) => ma(n, e, r, l))), await fa(n, r);
  const a = Xe(r, "plotPoint"), i = Xe(r, "plotLine"), o = Xe(r, "character"), c = Xe(r, "item"), d = Xe(r, "mapCanvas");
  return a.length && await n.plotPoint.deleteMany({ where: { id: { in: a }, novelId: e } }), i.length && await n.plotLine.deleteMany({ where: { id: { in: i }, novelId: e } }), o.length && await n.character.deleteMany({ where: { id: { in: o }, novelId: e } }), c.length && await n.item.deleteMany({ where: { id: { in: c }, novelId: e } }), d.length && await n.mapCanvas.deleteMany({ where: { id: { in: d }, novelId: e } }), {
    backgroundPaths: r.flatMap((l) => l.backgroundPath ? [l.backgroundPath] : [])
  };
}
function Lt(n) {
  const e = /* @__PURE__ */ new Set(), t = [];
  for (const r of n) {
    const s = String(r || "").trim();
    if (!s)
      continue;
    const a = s.toLowerCase();
    e.has(a) || (e.add(a), t.push(s));
  }
  return t;
}
function Mt(n) {
  if (!(n != null && n.trim()))
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (s) => {
      !s || typeof s != "object" || (typeof s.text == "string" && t.push(s.text), Array.isArray(s.children) && s.children.forEach(r));
    };
    return r((e == null ? void 0 : e.root) || e), t.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return n.replace(/\s+/g, " ").trim();
  }
}
function cr(n) {
  const e = (n.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length, t = n.length - e;
  return Math.ceil(e * 1.5 + t * 0.4);
}
function ga(n) {
  return Ne("sha256").update(n || "", "utf8").digest("hex");
}
function Pt(n, e = 50) {
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
function va(n) {
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
function nn(n, e = 1600) {
  if (n.length <= e)
    return n;
  const t = Math.floor((e - 5) / 2);
  return `${n.slice(0, t)}
...
${n.slice(-t)}`;
}
class Ia {
  async buildForChapterScope(e) {
    const t = String(e.novelId || "").trim();
    if (!t)
      throw new Error("novelId is required");
    const s = e.kind || "current_chapter", a = Math.max(1, Math.min(10, Math.floor(e.batchSize ?? 4))), i = Math.max(1, Math.min(20, Math.floor(e.maxDetailedChapters ?? 20))), o = Math.max(4e3, Math.min(2e5, Math.floor(e.maxEstimatedTokens ?? 6e4))), d = (await S.volume.findMany({
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
      (_) => (_.chapters || []).map((G) => ({
        ...G,
        volumeOrder: Number(_.order || 0)
      }))
    );
    if (d.length === 0)
      throw new Error("No chapters found for novel");
    const l = Lt([
      ...Array.isArray(e.chapterIds) ? e.chapterIds : [],
      ...s === "current_chapter" && e.chapterId ? [e.chapterId] : []
    ]), m = String(
      e.anchorChapterId || (s === "current_chapter" ? e.chapterId : void 0) || l.at(-1) || ""
    ).trim() || void 0, h = new Set(d.map((_) => String(_.id))), p = l.filter((_) => !h.has(_));
    if (p.length > 0)
      throw new Error(`Chapters do not belong to novel: ${p.join(", ")}`);
    if (m && !h.has(m))
      throw new Error(`Anchor chapter does not belong to novel: ${m}`);
    let f = [];
    if (s === "current_chapter") {
      if (!m || !h.has(m))
        throw new Error("anchorChapterId is required");
      f = d.filter((_) => _.id === m);
    } else if (s === "selected_chapters") {
      if (l.length === 0)
        throw new Error("chapterIds is required for selected_chapters");
      const _ = new Set(l);
      f = d.filter((G) => _.has(G.id));
    } else if (s === "chapter_range") {
      if (l.length < 2)
        throw new Error("chapter_range requires at least two chapterIds");
      const _ = l.map((G) => d.findIndex((Ee) => Ee.id === G));
      f = d.slice(Math.min(..._), Math.max(..._) + 1);
    } else if (s === "current_volume") {
      const _ = String(e.volumeId || "").trim();
      if (!_)
        throw new Error("volumeId is required for current_volume");
      f = d.filter((G) => G.volumeId === _);
    } else
      f = d;
    if (f.length === 0)
      throw new Error("Resolved chapter scope is empty");
    const v = f.map((_) => String(_.id)), w = new Set(v);
    let g = f;
    if (s === "selected_chapters" && f.length > 1) {
      const _ = f.map(
        (G) => d.findIndex((Ee) => Ee.id === G.id)
      );
      g = d.slice(Math.min(..._), Math.max(..._) + 1);
    }
    const u = g.map((_) => String(_.id)), I = u.length > i ? "batched" : e.processingMode || "detailed", y = await S.chapter.findMany({
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
    }), A = new Map(y.map((_) => [String(_.id), _])), C = await S.chapterSummary.findMany({
      where: { chapterId: { in: u }, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" }
    }), E = /* @__PURE__ */ new Map();
    for (const _ of C)
      E.has(String(_.chapterId)) || E.set(String(_.chapterId), _);
    const T = [], R = [], M = [];
    let J = 0, F = 0;
    for (const _ of g) {
      const G = A.get(String(_.id));
      if (!G) {
        T.push(`章节 ${_.title || _.id} 无法读取，已从上下文省略。`);
        continue;
      }
      const Ee = G.id === m && typeof e.currentContent == "string" && e.currentContent.length > 0, be = Ee ? e.currentContent : String(G.content || ""), st = Mt(be), dt = ga(be), Me = E.get(String(G.id)), Et = !!Me && String(Me.sourceContentHash || "") === dt;
      let lt, P;
      I === "detailed" ? (lt = st.length > 3e4 ? "truncated" : "full", P = st.slice(0, 3e4)) : Et ? (lt = "summary", P = String(Me.compressedMemory || Me.summaryText || "").slice(0, 2400)) : (lt = "excerpt", P = nn(st), Me ? J += 1 : F += 1);
      const K = G.updatedAt instanceof Date ? G.updatedAt.toISOString() : new Date(G.updatedAt).toISOString();
      R.push({
        chapterId: G.id,
        version: Number(G.version || 1),
        contentHash: dt,
        updatedAt: K,
        source: Ee ? "editor_buffer" : "database"
      }), M.push({
        chapterId: G.id,
        volumeId: G.volumeId,
        title: String(G.title || ""),
        order: Number(G.order || 0),
        volumeOrder: Number(_.volumeOrder || 0),
        version: Number(G.version || 1),
        updatedAt: K,
        contentHash: dt,
        contentMode: lt,
        content: P,
        ...Me != null && Me.id ? { summaryId: String(Me.id) } : {},
        ...Et ? {
          summaryContent: String(Me.compressedMemory || Me.summaryText || "").slice(0, 2400)
        } : {},
        summaryFresh: Et,
        target: w.has(String(G.id))
      });
    }
    J > 0 && T.push(`${J} 个章节摘要已过期，已使用原文摘录。`), F > 0 && T.push(`${F} 个章节缺少摘要，已使用原文摘录。`), u.length > i && T.push(`范围上下文包含 ${u.length} 章，超过详细处理上限 ${i}，已切换分批摘要模式。`);
    const Y = Lt(M.map((_) => _.volumeId)), [L, ae, b, Z, W, Q] = await Promise.all([
      S.narrativeSummary.findMany({
        where: {
          novelId: t,
          isLatest: !0,
          status: "active",
          OR: [
            { level: "novel", volumeId: null },
            ...Y.length > 0 ? [{ level: "volume", volumeId: { in: Y } }] : []
          ]
        },
        orderBy: { updatedAt: "desc" },
        take: Math.max(2, Y.length + 1)
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
    ]), ne = L.map((_) => ({
      id: String(_.id),
      level: _.level === "volume" ? "volume" : "novel",
      ..._.volumeId ? { volumeId: String(_.volumeId) } : {},
      title: String(_.title || ""),
      summaryText: String(_.summaryText || "").slice(0, 4e3),
      keyFacts: Pt(_.keyFacts, 20).map(String),
      unresolvedThreads: Pt(_.unresolvedThreads, 20).map(String),
      sourceFingerprint: String(_.sourceFingerprint || "")
    })), de = {
      entities: {},
      timelineHints: [],
      openQuestions: [],
      unresolvedThreads: ne.flatMap((_) => _.unresolvedThreads).slice(0, 100)
    }, Oe = new Set(
      M.filter((_) => _.summaryFresh && _.summaryId).map((_) => _.summaryId)
    );
    for (const _ of C)
      Oe.has(String(_.id)) && (Object.assign(de.entities, va(_.entitiesSnapshot)), de.timelineHints.push(...Pt(_.timelineHints, 20)), de.openQuestions.push(...Pt(_.openQuestions, 20)));
    de.timelineHints = de.timelineHints.slice(0, 100), de.openQuestions = de.openQuestions.slice(0, 100);
    const $e = Array.from({ length: Math.ceil(v.length / a) }, (_, G) => ({
      index: G,
      chapterIds: v.slice(G * a, (G + 1) * a)
    })), Be = {
      totalChapterCount: v.length,
      contextChapterCount: M.length,
      readonlyChapterCount: M.filter((_) => !_.target).length,
      detailedChapterCount: M.filter((_) => _.target && (_.contentMode === "full" || _.contentMode === "truncated")).length,
      summarizedChapterCount: M.filter((_) => _.target && _.contentMode === "summary").length,
      excerptChapterCount: M.filter((_) => _.target && _.contentMode === "excerpt").length,
      omittedChapterCount: Math.max(0, v.length - M.filter((_) => _.target).length),
      batchSize: a,
      batchCount: $e.length,
      batches: $e
    }, Je = {
      scope: {
        scopeId: String(e.scopeId || fe()),
        novelId: t,
        kind: s,
        ...e.volumeId ? { volumeId: e.volumeId } : {},
        chapterIds: v,
        ...m ? { anchorChapterId: m } : {},
        processingMode: I,
        snapshot: R.filter((_) => w.has(_.chapterId))
      },
      chapters: M,
      narrativeSummaries: ne,
      entityContext: { characters: ae, items: b, worldSettings: Z, maps: W },
      plotContext: { plotlines: Q },
      evidence: [],
      stateLedger: de,
      coverage: Be,
      sourceSnapshot: R,
      warnings: T
    }, D = cr(JSON.stringify(Je));
    return D > o && T.push(`范围上下文估算 ${D} tokens，超过目标预算 ${o}；下游必须按批次与角色投影继续裁剪。`), { ...Je, estimatedTokens: D };
  }
  async buildForCreativeAssets(e) {
    const t = e.includeExistingEntities !== !1, r = Math.max(0, Math.min(8, e.contextChapterCount ?? 0)), s = e.filterCompletedPlotLines !== !1, a = [], [i, o, c, d, l, m] = await Promise.all([
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
      const T = Array.isArray(E.points) ? E.points : [], R = s ? T.filter((M) => M.status !== "resolved") : T;
      return {
        name: String(E.name || ""),
        description: E.description ? String(E.description) : void 0,
        points: R.map((M) => ({
          title: String(M.title || ""),
          status: String(M.status || "active")
        }))
      };
    }), p = l.map((E) => E.id), f = p.length > 0 ? await S.chapterSummary.findMany({
      where: {
        chapterId: { in: p },
        isLatest: !0,
        status: "active"
      },
      orderBy: { updatedAt: "desc" }
    }) : [], v = /* @__PURE__ */ new Map();
    for (const E of f)
      v.has(E.chapterId) || v.set(E.chapterId, E);
    let w = 0;
    const g = l.map((E) => {
      const T = v.get(E.id), R = (T == null ? void 0 : T.compressedMemory) || (T == null ? void 0 : T.summaryText);
      return typeof R == "string" && R.trim() ? { chapterId: E.id, title: E.title || "", summary: R.slice(0, 800) } : (w++, {
        chapterId: E.id,
        title: E.title || "",
        summary: Mt(E.content || "").slice(0, 600)
      });
    });
    w > 0 && a.push(`${w} 个章节缺少摘要，已使用原文摘录替代。`);
    const u = m.map((E) => {
      let T = [];
      if (typeof E.keyFacts == "string" && E.keyFacts.trim())
        try {
          const R = JSON.parse(E.keyFacts);
          Array.isArray(R) && (T = Lt(
            R.map((M) => String(M || "").trim()).filter(Boolean).slice(0, 12)
          ).slice(0, 8));
        } catch {
        }
      return {
        level: E.level === "volume" ? "volume" : "novel",
        title: String(E.title || ""),
        summaryText: String(E.summaryText || "").slice(0, 1500),
        keyFacts: T
      };
    }), I = {
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
    }, y = JSON.stringify({ existingEntities: I, recentSummaries: g, narrativeSummaries: u }), A = cr(y), C = [];
    return I.characters.length > 0 && C.push(`characters_${I.characters.length}`), I.items.length > 0 && C.push(`items_${I.items.length}`), I.plotLines.length > 0 && C.push(`plotLines_${I.plotLines.length}`), C.push(`worldSettings_${I.worldSettings.length}`), g.length > 0 && C.push(`recentChapterSummaries_${g.length}`), u.length > 0 && C.push(`narrativeSummaries_${u.length}`), C.push(`estimatedTokens_${A}`), {
      existingEntities: I,
      recentSummaries: g,
      narrativeSummaries: u,
      usedContext: C,
      warnings: a,
      estimatedTokens: A
    };
  }
  async buildForContinueWriting(e) {
    var Je;
    const t = Math.max(1, Math.min(20, e.contextChapterCount ?? 8)), r = Math.max(1, Math.min(3, e.recentRawChapterCount ?? 2)), s = t + r, a = {
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
      (D) => (D.chapters || []).map((_) => ({
        ..._,
        volumeOrder: Number(D.order || 0)
      }))
    ), c = o.findIndex((D) => String(D.id) === e.chapterId);
    if (c < 0)
      throw new Error("Current chapter does not belong to novel");
    const d = o.slice(Math.max(0, c - s), c), l = [...d.map((D) => String(D.id)), e.chapterId], m = await this.buildForChapterScope({
      novelId: e.novelId,
      kind: "selected_chapters",
      chapterIds: l,
      anchorChapterId: e.chapterId,
      processingMode: "detailed",
      currentContent: e.currentContent,
      maxDetailedChapters: 20,
      maxEstimatedTokens: 12e4
    }), h = e.currentContent || String(((Je = await S.chapter.findUnique({
      where: { id: e.chapterId },
      select: { content: !0 }
    })) == null ? void 0 : Je.content) || ""), p = d.slice(-r).map((D) => String(D.id)), f = p.length > 0 ? await S.chapter.findMany({
      where: { id: { in: p }, deleted: !1 },
      select: { id: !0, content: !0 }
    }) : [], v = new Map(
      f.map((D) => [String(D.id), Mt(String(D.content || ""))])
    ), w = m.entityContext.worldSettings, g = m.plotContext.plotlines, u = m.entityContext.characters, I = m.entityContext.items, y = m.entityContext.maps, A = Array.isArray(e.ideaIds) ? e.ideaIds.map((D) => String(D)).filter(Boolean) : [], C = A.length > 0 ? await S.idea.findMany({
      where: {
        novelId: e.novelId,
        id: { in: A }
      },
      include: { tags: !0 },
      orderBy: { updatedAt: "desc" },
      take: 20
    }) : [], E = m.narrativeSummaries.map((D) => ({
      level: D.level,
      title: D.title,
      summaryText: D.summaryText.slice(0, 1200),
      keyFacts: D.keyFacts.slice(0, 5)
    })), T = m.chapters.filter((D) => D.chapterId !== e.chapterId), R = Math.max(0, T.length - r);
    let M = 0;
    const J = T.map((D, _) => {
      var Ee;
      if (_ >= R) {
        const be = v.get(D.chapterId) || D.content, st = be.length > a.maxFullTextChars;
        return {
          chapterId: D.chapterId,
          title: D.title,
          excerpt: be.slice(-a.maxFullTextChars),
          contentMode: st ? "truncated" : "full"
        };
      }
      return D.summaryFresh && ((Ee = D.summaryContent) != null && Ee.trim()) ? {
        chapterId: D.chapterId,
        title: D.title,
        excerpt: D.summaryContent.slice(0, a.maxSummaryChars),
        contentMode: "summary"
      } : (M += 1, {
        chapterId: D.chapterId,
        title: D.title,
        excerpt: nn(D.content, a.maxSummaryChars),
        contentMode: "excerpt"
      });
    }), F = m.chapters.find((D) => D.chapterId === e.chapterId), Y = Mt(h || (F == null ? void 0 : F.content) || "").slice(-a.maxCurrentContentChars), L = C.map((D) => ({
      ideaId: D.id,
      content: (D.content || "").slice(0, 800),
      quote: typeof D.quote == "string" ? D.quote.slice(0, 300) : void 0,
      tags: Array.isArray(D.tags) ? D.tags.map((_) => String(_.name || "").trim()).filter(Boolean).slice(0, 12) : []
    })), ae = {
      characters: new Set(
        u.map((D) => String((D == null ? void 0 : D.name) || "").trim()).filter(Boolean)
      ),
      items: new Set(
        I.map((D) => String((D == null ? void 0 : D.name) || "").trim()).filter(Boolean)
      ),
      worldSettings: new Set(
        w.map((D) => String((D == null ? void 0 : D.name) || "").trim()).filter(Boolean)
      )
    }, b = [], Z = /@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g;
    for (const D of L) {
      const _ = `${D.content || ""}
${D.quote || ""}`, G = Array.from(_.matchAll(Z));
      for (const Ee of G) {
        const be = String(Ee[1] || "").trim();
        be && (ae.characters.has(be) ? b.push({ name: be, kind: "character" }) : ae.items.has(be) ? b.push({ name: be, kind: "item" }) : ae.worldSettings.has(be) && b.push({ name: be, kind: "worldSetting" }));
      }
    }
    const W = Lt(b.map((D) => `${D.kind}:${D.name}`)).map((D) => {
      const [_, ...G] = D.split(":");
      return {
        name: G.join(":"),
        kind: _ === "character" || _ === "item" || _ === "worldSetting" ? _ : "character"
      };
    }).slice(0, 20), Q = String(e.currentLocation || "").trim().slice(0, 120), ne = Math.max(0, A.length - L.length), de = [...m.warnings];
    M > 0 && de.push(`${M} chapter summaries missing or stale; fell back to chapter text excerpts.`), ne > 0 && de.push(`${ne} selected ideas not found; ignored.`);
    const Oe = new Map(m.sourceSnapshot.map((D) => [D.chapterId, D])), $e = new Map(m.chapters.map((D) => [D.chapterId, D])), Be = new Map(J.map((D) => [D.chapterId, D.contentMode])), Le = {
      policy: a,
      scopeId: m.scope.scopeId,
      novelId: e.novelId,
      anchorChapterId: e.chapterId,
      chapterSources: l.flatMap((D) => {
        const _ = Oe.get(D), G = $e.get(D);
        if (!_ || !G)
          return [];
        const Ee = D === e.chapterId;
        return [{
          ..._,
          volumeId: G.volumeId,
          title: G.title,
          order: G.order,
          volumeOrder: G.volumeOrder,
          contentMode: Ee ? G.contentMode : Be.get(D) || "excerpt",
          ...G.summaryId ? { summaryId: G.summaryId } : {},
          summaryFresh: G.summaryFresh
        }];
      }),
      narrativeSummaryIds: m.narrativeSummaries.map((D) => D.id),
      estimatedTokens: cr(JSON.stringify({
        recentChapterItems: J,
        currentChapterBeforeCursor: Y,
        narrativeSummaries: E,
        hardContext: { worldSettings: w, plotLines: g, characters: u, items: I, maps: y }
      })),
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return {
      currentContentSource: h,
      hardContext: {
        worldSettings: w,
        plotLines: g,
        characters: u,
        items: I,
        maps: y
      },
      dynamicContext: {
        recentChapters: J,
        selectedIdeas: L,
        selectedIdeaEntities: W,
        currentChapterBeforeCursor: Y,
        ...Q ? { currentLocation: Q } : {},
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
      policy: a,
      snapshot: Le,
      usedContext: [
        "world_settings_full",
        "plot_outline_full",
        "characters_items_maps_snapshot",
        `ordered_previous_chapters_${J.length}`,
        `previous_chapter_summaries_${J.filter((D) => D.contentMode === "summary").length}`,
        `previous_chapter_full_text_${J.filter((D) => D.contentMode === "full" || D.contentMode === "truncated").length}`,
        E.length > 0 ? `narrative_summaries_${E.length}` : "narrative_summaries_0",
        L.length > 0 ? `selected_ideas_${L.length}` : "selected_ideas_0",
        W.length > 0 ? `selected_idea_entities_${W.length}` : "selected_idea_entities_0",
        ...Q ? ["current_location"] : [],
        "current_chapter_before_cursor",
        a.version
      ],
      warnings: de
    };
  }
}
const sn = /(?:必须|不要|不能|禁止|只允许|仅限|请保持|需要保持|务必|记住|风格|视角|篇幅|长度|must\b|do not\b|don't\b|never\b|only\b|keep\b|remember\b|style\b|perspective\b|length\b)/i, ya = /(?:决定|采用|选择|确认|就按|改为|保持|不要|不能|禁止|必须|只允许|仅限|务必|decide|choose|confirm|use\b|keep\b|must\b|never\b|do not\b)/i, wa = /(?:当前|目前|已经|已有|设定|角色|章节|大纲|世界观|主线|支线|事实|状态|现有|current|already|existing|fact|state|chapter|character|outline)/i, dr = /[?？]\s*$|(?:请问|是否|能否|哪一|哪个|什么|如何|怎么|为什么|吗[？?]?\s*$|呢[？?]?\s*$)/i, Cr = /(?:上面|之前|此前|刚才|前面|继续|总结|结论|那个|这些|那些|above|previous|earlier|continue|summary|that)/i, an = {
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
function Sa(n, e = "", t = 0) {
  if (Number.isFinite(t) && t >= 8192)
    return {
      tokens: Math.min(2e6, Math.floor(t)),
      source: "configured"
    };
  const r = e.trim().toLowerCase();
  let s = n === "mcp-cli" ? 32768 : 65536;
  return /gemini|qwen-long/.test(r) ? s = 262144 : /claude/.test(r) ? s = 18e4 : /gpt-5|gpt-4\.1/.test(r) ? s = 262144 : /gpt-4o|\bo[134](?:-|$)/.test(r) ? s = 98304 : /deepseek|qwen|glm|doubao/.test(r) && (s = 65536), { tokens: s, source: "model-profile" };
}
function ve(n) {
  try {
    const e = JSON.stringify(n);
    return e === void 0 ? String(n ?? "") : e;
  } catch {
    return String(n ?? "");
  }
}
function De(n, e) {
  const t = n.trim();
  if (!t || e <= 0)
    return "";
  if (ye(t) <= e)
    return t;
  let r = 0, s = t.length;
  for (; r < s; ) {
    const i = Math.ceil((r + s) / 2);
    ye(t.slice(0, i)) <= Math.max(1, e - 12) ? r = i : s = i - 1;
  }
  const a = Math.max(0, t.length - r);
  return `${t.slice(0, r).trimEnd()}
[compressed: ${a} chars omitted]`;
}
function Ze(n, e) {
  const t = ve(n);
  if (ye(t) <= e)
    return n;
  if (Array.isArray(n) && n.length > 0) {
    const r = (i) => {
      const o = Math.ceil(i / 2), c = Math.floor(i / 2), d = Math.max(24, Math.floor((e - 40) / Math.max(1, i)));
      return {
        compressed: !0,
        totalItems: n.length,
        head: n.slice(0, o).map((l) => Ze(l, d)),
        tail: c > 0 ? n.slice(Math.max(o, n.length - c)).map((l) => Ze(l, d)) : []
      };
    }, s = r(Math.min(6, n.length));
    if (ye(ve(s)) <= e)
      return s;
    const a = r(Math.min(2, n.length));
    if (ye(ve(a)) <= e)
      return a;
  }
  return {
    compressed: !0,
    excerpt: De(t, Math.max(32, e - 16))
  };
}
function lr(n) {
  return !!(n && typeof n == "object" && n.compressed === !0);
}
function Pr(n) {
  let e = 2166136261;
  for (let t = 0; t < n.length; t += 1)
    e ^= n.charCodeAt(t), e = Math.imul(e, 16777619);
  return (e >>> 0).toString(36);
}
function es(n) {
  return Array.isArray(n) ? n.flatMap((e, t) => {
    const r = String((e == null ? void 0 : e.content) || "").trim();
    if (!r || e.role !== "user" && e.role !== "assistant")
      return [];
    const s = e.createdAt ? String(e.createdAt) : void 0, a = String(e.messageId || "").trim() || `legacy_${Pr(`${t}\0${e.role}\0${s || ""}\0${r}`)}`;
    return [{
      role: e.role,
      content: r,
      messageId: a,
      sourceMessageIndex: t,
      ...s ? { createdAt: s } : {}
    }];
  }) : [];
}
function Aa(n) {
  if (!n || typeof n != "object")
    return null;
  const e = n, t = String(e.text || "").trim(), r = Array.isArray(e.sourceMessageIds) ? [...new Set(e.sourceMessageIds.map((a) => String(a || "").trim()).filter(Boolean))].slice(0, 12) : [];
  if (!t || !r.length)
    return null;
  const s = e.sourceRole === "assistant" ? "assistant" : "user";
  return {
    id: String(e.id || `summary_${Pr(`${s}\0${t}\0${r.join("|")}`)}`),
    text: De(t, 180),
    sourceMessageIds: r,
    sourceRole: s,
    ...e.createdAt ? { createdAt: String(e.createdAt) } : {}
  };
}
function Ea(n) {
  if (!n || typeof n != "object")
    return null;
  const e = n, t = String(e.artifactId || "").trim();
  return t ? {
    artifactId: t,
    ...e.runId ? { runId: String(e.runId) } : {},
    ...e.type ? { type: String(e.type) } : {},
    title: De(String(e.title || e.type || t), 80),
    ...e.status ? { status: String(e.status) } : {},
    ...e.summary ? { summary: De(String(e.summary), 160) } : {},
    ...e.createdAt ? { createdAt: String(e.createdAt) } : {}
  } : null;
}
function ts(n) {
  if (!n || typeof n != "object")
    return null;
  const e = n;
  if (e.version !== "agent-conversation-summary-v1")
    return null;
  const t = Array.isArray(e.coveredMessageIds) ? [...new Set(e.coveredMessageIds.map((i) => String(i || "").trim()).filter(Boolean))] : [], r = (i) => (Array.isArray(e[i]) ? e[i] : []).map(Aa).filter((o) => !!o), s = (Array.isArray(e.artifactRefs) ? e.artifactRefs : []).map(Ea).filter((i) => !!i), a = e.coverage && typeof e.coverage == "object" ? e.coverage : {};
  return {
    version: "agent-conversation-summary-v1",
    revision: Math.max(1, Math.floor(Number(e.revision) || 1)),
    coveredMessageIds: t,
    coverage: {
      ...a.startMessageId ? { startMessageId: String(a.startMessageId) } : {},
      ...a.endMessageId ? { endMessageId: String(a.endMessageId) } : {},
      messageCount: t.length
    },
    facts: r("facts").slice(-40),
    userDecisions: r("userDecisions").slice(-32),
    unresolvedQuestions: r("unresolvedQuestions").slice(-16),
    outcomes: r("outcomes").slice(-32),
    artifactRefs: s.slice(-64),
    updatedAt: String(e.updatedAt || (/* @__PURE__ */ new Date(0)).toISOString())
  };
}
function rs(n) {
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
function Ut(n, e) {
  const t = String(e.messageId || "");
  return {
    id: `${n}_${Pr(`${t}\0${e.content}`)}`,
    text: De(e.content, 180),
    sourceMessageIds: [t],
    sourceRole: e.role,
    ...e.createdAt ? { createdAt: e.createdAt } : {}
  };
}
function $t(n, e, t) {
  const r = new Map(n.map((s) => [s.id, s]));
  for (const s of e)
    r.set(s.id, s);
  return [...r.values()].slice(-t);
}
function Tr(n) {
  return {
    artifactId: n.artifactId,
    ...n.runId ? { runId: n.runId } : {},
    ...n.type ? { type: n.type } : {},
    title: De(String(n.title || n.type || n.artifactId), 80),
    ...n.status ? { status: n.status } : {},
    ...n.summary ? { summary: De(String(n.summary), 160) } : {},
    ...n.createdAt ? { createdAt: n.createdAt } : {}
  };
}
function Ca(n) {
  const e = es(n.history), t = ts(n.previous), r = new Set((t == null ? void 0 : t.coveredMessageIds) || []), s = new Set((n.newlyCoveredMessageIds || []).map(String)), a = e.filter((I) => s.has(String(I.messageId)) && !r.has(String(I.messageId))), i = rs(n.artifacts), o = new Map(((t == null ? void 0 : t.artifactRefs) || []).map((I) => [I.artifactId, I])), c = i.some((I) => {
    const y = o.get(I.artifactId);
    return ve(y || null) !== ve(Tr(I));
  });
  if (!a.length && !c)
    return;
  const d = [...(t == null ? void 0 : t.coveredMessageIds) || []];
  for (const I of a) {
    const y = String(I.messageId || "");
    y && !r.has(y) && (d.push(y), r.add(y));
  }
  const l = a.filter((I) => I.role === "user" && wa.test(I.content) && !dr.test(I.content)).map((I) => Ut("fact", I)), m = a.filter((I) => I.role === "user" && ya.test(I.content)).map((I) => Ut("decision", I)), h = a.filter((I) => I.role === "assistant" && !dr.test(I.content)).map((I) => Ut("outcome", I)), p = new Map(e.map((I, y) => [String(I.messageId), y])), f = a.filter((I) => {
    if (I.role !== "assistant" || !dr.test(I.content))
      return !1;
    const y = p.get(String(I.messageId)) ?? -1;
    return !e.slice(y + 1).some((A) => A.role === "user");
  }).map((I) => Ut("question", I)), v = ((t == null ? void 0 : t.unresolvedQuestions) || []).filter((I) => {
    const y = Math.max(...I.sourceMessageIds.map((A) => p.get(A) ?? -1));
    return y < 0 || !e.slice(y + 1).some((A) => A.role === "user");
  }), w = new Map(((t == null ? void 0 : t.artifactRefs) || []).map((I) => [I.artifactId, I]));
  for (const I of i)
    w.set(I.artifactId, Tr(I));
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
    facts: $t((t == null ? void 0 : t.facts) || [], l, 40),
    userDecisions: $t((t == null ? void 0 : t.userDecisions) || [], m, 32),
    unresolvedQuestions: $t(v, f, 16),
    outcomes: $t((t == null ? void 0 : t.outcomes) || [], h, 32),
    artifactRefs: [...w.values()].slice(-64),
    updatedAt: n.updatedAt || (/* @__PURE__ */ new Date()).toISOString()
  };
}
function Ta(n, e) {
  const t = [], r = /* @__PURE__ */ new Set();
  let s = 0;
  const a = Math.max(180, Math.min(1024, Math.floor(e / 4)));
  for (let i = n.length - 1; i >= 0; i -= 1) {
    const o = n[i];
    if (o.role !== "user" || !sn.test(o.content))
      continue;
    const c = o.content.split(new RegExp("(?<=[。！？!?；;\\n])")).map((p) => p.trim()).filter((p) => p && sn.test(p)), d = De(c.join(" ") || o.content, a), l = d.toLowerCase();
    if (!d || r.has(l))
      continue;
    const m = { sourceMessageIndex: i, excerpt: d }, h = ye(ve(m));
    s + h > e || (t.unshift(m), r.add(l), s += h);
  }
  return t;
}
function ns(n) {
  const e = n.toLowerCase(), t = /* @__PURE__ */ new Set();
  for (const r of e.match(/[a-z0-9_.:-]{3,}/g) || [])
    t.add(r);
  for (const r of e.match(/[\u3400-\u9fff]{2,}/g) || []) {
    r.length <= 8 && t.add(r);
    for (let s = 0; s < r.length - 1; s += 1)
      t.add(r.slice(s, s + 2));
  }
  return [...t].slice(0, 80);
}
function ss(n, e, t, r) {
  const s = t.toLowerCase();
  let a = r.some((i) => n.includes(i.toLowerCase())) ? 100 : 0;
  for (const i of e)
    s.includes(i) && (a += i.length >= 4 ? 3 : 1);
  return a;
}
function ba(n, e, t) {
  if (!n)
    return [];
  const r = ve(t).toLowerCase(), s = ns(r), a = [
    ...n.userDecisions,
    ...n.unresolvedQuestions,
    ...n.facts,
    ...n.outcomes
  ], i = a.map((m, h) => ({
    entry: m,
    index: h,
    score: ss(r, s, m.text, [m.id, ...m.sourceMessageIds])
  })).filter((m) => m.score > 0);
  if (!i.length && Cr.test(r))
    for (let m = Math.max(0, a.length - 3); m < a.length; m += 1)
      i.push({ entry: a[m], index: m, score: 1 });
  i.sort((m, h) => h.score - m.score || h.index - m.index);
  const o = n.coveredMessageIds.filter((m) => r.includes(m.toLowerCase())), c = !i.length && Cr.test(r) ? n.coveredMessageIds.slice(-3) : [], d = [.../* @__PURE__ */ new Set([
    ...o,
    ...i.slice(0, 4).flatMap((m) => m.entry.sourceMessageIds),
    ...c
  ])].slice(0, 6), l = new Map(e.map((m) => [String(m.messageId), m]));
  return d.flatMap((m) => {
    const h = l.get(m);
    return h ? [{
      messageId: m,
      role: h.role,
      content: De(h.content, 420),
      ...h.createdAt ? { createdAt: h.createdAt } : {},
      sourceRef: `agent-message:${m}`
    }] : [];
  });
}
function Na(n, e, t) {
  if (!e.length)
    return [];
  const r = ve(t).toLowerCase(), s = ns(r), a = new Map(((n == null ? void 0 : n.artifactRefs) || []).map((o) => [o.artifactId, o]));
  for (const o of e)
    a.has(o.artifactId) || a.set(o.artifactId, Tr(o));
  const i = e.flatMap((o, c) => {
    const d = a.get(o.artifactId);
    if (!d)
      return [];
    const l = [d.title, d.summary, d.type].filter(Boolean).join(" "), m = ss(r, s, l, [d.artifactId]);
    return m > 0 ? [{ artifact: o, ref: d, index: c, score: m }] : [];
  });
  if (!i.length && Cr.test(r) && /(?:草稿|报告|审核|产物|artifact|draft|report|review)/i.test(r)) {
    const o = e.filter((c) => a.has(c.artifactId));
    for (let c = Math.max(0, o.length - 2); c < o.length; c += 1) {
      const d = o[c];
      i.push({ artifact: d, ref: a.get(d.artifactId), index: c, score: 1 });
    }
  }
  return i.sort((o, c) => c.score - o.score || c.index - o.index), i.slice(0, 3).map(({ artifact: o, ref: c }) => ({
    artifactId: o.artifactId,
    ...o.runId ? { runId: o.runId } : {},
    type: o.type || c.type,
    title: o.title || c.title,
    summary: De(String(o.summary || c.summary || ""), 180),
    contentExcerpt: De(String(o.content || ve(o.metadata || {})), 520),
    reference: Ze(o.reference || {}, 120),
    sourceRef: `agent-artifact:${o.artifactId}`
  }));
}
function xa(n, e, t) {
  var i, o;
  const r = n.slice(e, t + 1), s = r.map((c, d) => ({
    message: c,
    sourceMessageIndex: Number(c.sourceMessageIndex ?? e + d),
    sourceMessageId: c.messageId
  })).filter(({ message: c }) => c.role === "user").slice(-2).map(({ message: c, sourceMessageIndex: d, sourceMessageId: l }) => ({
    sourceMessageIndex: d,
    sourceMessageId: l,
    excerpt: De(c.content, 100)
  })), a = r.map((c, d) => ({
    message: c,
    sourceMessageIndex: Number(c.sourceMessageIndex ?? e + d),
    sourceMessageId: c.messageId
  })).filter(({ message: c }) => c.role === "assistant").slice(-1).map(({ message: c, sourceMessageIndex: d, sourceMessageId: l }) => ({
    sourceMessageIndex: d,
    sourceMessageId: l,
    excerpt: De(c.content, 120)
  }));
  return {
    sourceRange: {
      startMessageIndex: Number(((i = r[0]) == null ? void 0 : i.sourceMessageIndex) ?? e),
      endMessageIndex: Number(((o = r[r.length - 1]) == null ? void 0 : o.sourceMessageIndex) ?? t)
    },
    sourceMessageIds: r.map((c) => c.messageId).filter(Boolean),
    userRequests: s,
    assistantOutcome: a
  };
}
function _a(n, e) {
  if (!n.length || e < 64)
    return { recentHistory: [], rollingSummary: [], summarizedCount: 0, omittedCount: n.length };
  const t = Math.max(64, Math.floor(e * 0.68)), r = [];
  let s = 0, a = n.length;
  for (let h = n.length - 1; h >= 0; h -= 1) {
    const p = n[h], f = { sourceMessageIndex: Number(p.sourceMessageIndex ?? h), ...p }, v = ye(ve(f));
    if (s + v > t) {
      if (!r.length) {
        const w = {
          sourceMessageIndex: Number(p.sourceMessageIndex ?? h),
          role: p.role,
          content: De(p.content, Math.max(32, t - 24)),
          messageId: p.messageId,
          ...p.createdAt ? { createdAt: p.createdAt } : {},
          compressed: !0
        };
        r.unshift(w), a = h;
      }
      break;
    }
    r.unshift(f), a = h, s += v;
  }
  const i = Math.max(0, e - ye(ve(r))), o = [];
  for (let h = a - 1; h >= 0; h -= 6) {
    const p = Math.max(0, h - 5);
    o.unshift({ start: p, end: h, summary: xa(n, p, h) });
  }
  const c = [];
  let d = 0, l = 0;
  for (let h = o.length - 1; h >= 0; h -= 1) {
    const p = o[h], f = ye(ve(p.summary));
    d + f > i || (c.unshift(p.summary), d += f, l += p.end - p.start + 1);
  }
  const m = Math.max(0, a);
  return {
    recentHistory: r,
    rollingSummary: c,
    summarizedCount: l,
    omittedCount: Math.max(0, m - l)
  };
}
function Bt(n, e) {
  const t = [...new Set(n.filter(Number.isFinite))].sort((i, o) => i - o);
  if (!t.length)
    return [];
  const r = [];
  let s = t[0], a = t[0];
  for (const i of t.slice(1)) {
    if (i === a + 1) {
      a = i;
      continue;
    }
    r.push({ mode: e, startMessageIndex: s, endMessageIndex: a }), s = i, a = i;
  }
  return r.push({ mode: e, startMessageIndex: s, endMessageIndex: a }), r;
}
class Ra {
  assemble(e) {
    const t = String(e.model || (e.providerType === "mcp-cli" ? "mcp-cli" : "unknown-model")), r = Sa(e.providerType, t, e.contextWindowTokens), s = Math.max(128, Math.floor(e.outputTokens || 0)), a = Number.isFinite(e.safetyTokens) && Number(e.safetyTokens) > 0 ? Math.floor(Number(e.safetyTokens)) : Math.max(2048, Math.min(16384, Math.floor(r.tokens * 0.1))), i = ye(String(e.systemPrompt || "")), o = Math.max(128, r.tokens - s - a - i), c = [];
    r.tokens <= s + a + i && c.push("Configured context window is smaller than the reserved system, output, and safety budgets.");
    const d = es(e.history), l = ts(e.persistentSummary), m = rs(e.artifacts), h = new Set((l == null ? void 0 : l.coveredMessageIds) || []), p = d.filter((P) => !h.has(String(P.messageId))), f = ba(l, d, e.currentRequest), v = Na(l, m, e.currentRequest), w = Math.max(256, Math.floor(o * 0.28)), g = Ta(
      d,
      Math.max(128, Math.floor(o * 0.12))
    ), u = (e.sections || []).filter((P) => P && String(P.id || "").trim()).map((P) => ({ ...P, id: String(P.id), priority: P.priority || "normal" })).sort((P, K) => an[P.priority] - an[K.priority]), I = {
      contextVersion: "agent-context-v1",
      currentRequest: Ze(e.currentRequest, w),
      persistentConstraints: g,
      persistentSummary: l ? Ze(l, Math.max(256, Math.floor(o * 0.18))) : null,
      recalledMessages: Ze(f, Math.max(128, Math.floor(o * 0.1))),
      recalledArtifacts: Ze(v, Math.max(128, Math.floor(o * 0.12))),
      rollingSummary: [],
      recentHistory: [],
      sections: []
    }, y = [], A = [], C = Math.max(128, Math.floor(o * 0.42));
    let E = 0;
    for (let P = 0; P < u.length; P += 1) {
      const K = u[P], Fe = u.length - P, at = Math.max(96, Math.floor((C - E) / Math.max(1, Fe))), Ct = Math.max(64, Math.min(K.maxTokens || at, C - E));
      if (Ct < 64 && K.priority !== "required") {
        y.push(K.id);
        continue;
      }
      const Br = {
        id: K.id,
        kind: K.kind,
        priority: K.priority,
        ...K.sourceRef ? { sourceRef: K.sourceRef } : {},
        value: Ze(K.value, Math.max(32, Ct - 24))
      }, Fr = ye(ve(Br));
      if (E + Fr > C && K.priority !== "required") {
        y.push(K.id);
        continue;
      }
      A.push(Br), E += Fr;
    }
    I.sections = A;
    const T = ye(ve(I)), R = Math.max(0, o - T - 32), M = _a(p, R);
    I.rollingSummary = M.rollingSummary, I.recentHistory = M.recentHistory;
    let J = ve(I), F = ye(J);
    const Y = I.rollingSummary, L = I.recentHistory;
    for (; F > o && Y.length; )
      Y.shift(), J = ve(I), F = ye(J);
    for (; F > o && L.length > 1; )
      L.shift(), J = ve(I), F = ye(J);
    for (; F > o && A.some((P) => P.priority !== "required"); ) {
      let P = A.length - 1;
      for (; P >= 0 && A[P].priority === "required"; )
        P -= 1;
      const [K] = A.splice(P, 1);
      y.push(String(K.id)), J = ve(I), F = ye(J);
    }
    for (; F > o && g.length; )
      g.shift(), J = ve(I), F = ye(J);
    F > o && (I.currentRequest = Ze(e.currentRequest, Math.max(64, Math.floor(w / 2))), J = ve(I), F = ye(J));
    const ae = new Map(d.map((P, K) => [
      String(P.messageId),
      Number(P.sourceMessageIndex ?? K)
    ])), b = /* @__PURE__ */ new Set();
    for (const P of (l == null ? void 0 : l.coveredMessageIds) || []) {
      const K = ae.get(P);
      typeof K == "number" && b.add(K);
    }
    for (const P of Y) {
      const K = Array.isArray(P.sourceMessageIds) ? P.sourceMessageIds.map(String) : [];
      if (K.length) {
        for (const at of K) {
          const Ct = ae.get(at);
          typeof Ct == "number" && b.add(Ct);
        }
        continue;
      }
      const Fe = P.sourceRange;
      if (!(!Fe || typeof Fe.startMessageIndex != "number" || typeof Fe.endMessageIndex != "number"))
        for (let at = Fe.startMessageIndex; at <= Fe.endMessageIndex; at += 1)
          b.add(at);
    }
    const Z = b.size, W = new Set(L.map((P) => Number(P.sourceMessageIndex))), Q = [...W].filter(Number.isFinite).length, ne = /* @__PURE__ */ new Set([...W, ...b]), Oe = d.map((P, K) => Number(P.sourceMessageIndex ?? K)).filter((P) => !ne.has(P)), $e = Oe.length, Be = L.filter((P) => P.compressed === !0).length, Le = lr(I.currentRequest), Je = A.filter((P) => lr(P.value)).map((P) => String(P.id)), D = Le || Z > 0 || $e > 0 || Be > 0 || Je.length > 0 || y.length > 0;
    l && l.coveredMessageIds.length ? c.push("Older conversation messages were represented by a persisted, traceable summary.") : Z > 0 && c.push("Older conversation messages were represented by traceable rolling summaries."), $e > 0 && c.push(`${$e} older conversation messages could not fit in this model request.`), y.length && c.push("Lower-priority context sections were omitted to fit the model budget.");
    const _ = [], G = [];
    for (const P of L) {
      const K = Number(P.sourceMessageIndex);
      Number.isFinite(K) && (P.compressed === !0 ? G : _).push(K);
    }
    const Ee = [
      ...Bt(_, "raw"),
      ...Bt(G, "compressed"),
      ...Bt([...b], "summary"),
      ...Bt(Oe, "omitted")
    ].sort((P, K) => P.startMessageIndex - K.startMessageIndex), be = new Map(d.map((P, K) => [
      Number(P.sourceMessageIndex ?? K),
      P
    ])), st = [...new Set([...b, ...Oe].sort((P, K) => P - K).flatMap((P) => {
      var Fe;
      const K = (Fe = be.get(P)) == null ? void 0 : Fe.messageId;
      return K ? [String(K)] : [];
    }))], dt = Ca({
      previous: l,
      history: d,
      newlyCoveredMessageIds: st,
      artifacts: m
    }), Me = new Set(y), Et = new Map(A.map((P) => [String(P.id), P])), lt = u.map((P) => {
      const K = Et.get(P.id), Fe = Me.has(P.id) || !K ? "omitted" : lr(K.value) ? "compressed" : "raw";
      return {
        id: P.id,
        kind: P.kind,
        priority: P.priority,
        mode: Fe,
        ...P.sourceRef ? { sourceRef: P.sourceRef } : {},
        estimatedTokens: K ? ye(ve(K)) : 0
      };
    });
    return {
      prompt: J,
      payload: I,
      ...dt ? { summaryUpdate: dt } : {},
      diagnostics: {
        contextVersion: "agent-context-v1",
        providerType: e.providerType,
        model: t,
        contextWindowTokens: r.tokens,
        contextWindowSource: r.source,
        outputTokens: s,
        safetyTokens: a,
        systemTokens: i,
        inputBudgetTokens: o,
        estimatedInputTokens: F,
        compressionApplied: D,
        currentRequestCompressed: Le,
        historyMessagesTotal: d.length,
        historyMessagesKept: Q,
        historyMessagesSummarized: Z,
        historyMessagesOmitted: $e,
        historyMessagesCompacted: Be,
        persistentConstraintsCount: g.length,
        persistentSummaryRevision: (l == null ? void 0 : l.revision) || 0,
        persistentSummaryMessageCount: (l == null ? void 0 : l.coveredMessageIds.length) || 0,
        recalledMessageIds: f.map((P) => String(P.messageId || "")).filter(Boolean),
        recalledArtifactIds: v.map((P) => String(P.artifactId || "")).filter(Boolean),
        currentRequestMode: Le ? "compressed" : "raw",
        historySources: Ee,
        sectionSources: lt,
        compressedSectionIds: Je,
        omittedSectionIds: [...new Set(y)],
        warnings: c
      }
    };
  }
}
const Da = /* @__PURE__ */ new Set([
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
]), ka = /* @__PURE__ */ new Set([
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
function as(n) {
  const e = /* @__PURE__ */ new Set(), t = [];
  for (const r of n) {
    const s = String(r || "").trim();
    if (!s)
      continue;
    const a = s.toLowerCase();
    e.has(a) || (e.add(a), t.push(s));
  }
  return t;
}
function Oa(n) {
  const e = n.toLowerCase();
  return /冲突|矛盾|一致|合理|consisten|conflict/.test(e) ? "consistency_check" : /伏笔|坑|悬念|未解|没回收|未回收|unresolved|thread|foreshadow/.test(e) ? "unresolved_threads" : /大纲|接下来|下一步|后续写|怎么写|outline|next beat|next/.test(e) ? "outline_next" : /后续|后面|之后|还有戏|还有剧情|未来|安排|future|later/.test(e) ? "future_plot_for_entity" : /当前|现在|状态|在哪里|位置|持有|关系|current|state|status|where/.test(e) ? "character_state" : "general_qa";
}
function La(n) {
  const e = Array.from(n.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g)).map((s) => String(s[1] || "").trim()).filter(Boolean), t = Array.from(n.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g)).map((s) => s[0]).filter((s) => !Da.has(s)), r = Array.from(n.matchAll(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g)).map((s) => s[0]).filter((s) => !ka.has(s.toLowerCase()));
  return as([...e, ...t, ...r]).slice(0, 8);
}
function Ma(n, e) {
  const t = String(n || ""), r = t.toLowerCase(), s = e.map((i) => String(i || "").trim()).filter(Boolean).filter((i) => r.includes(i.toLowerCase())), a = Array.from(t.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g)).map((i) => String(i[1] || "").trim()).filter(Boolean);
  return {
    intent: Oa(t),
    entityNames: as([...s, ...a]).slice(0, 8),
    keywords: La(t)
  };
}
function on(n, e) {
  return `${n.replace(/\/+$/, "")}/${e.replace(/^\/+/, "")}`;
}
async function Pa(n, e) {
  try {
    return await Dr.fetch(n, e);
  } catch {
    return await fetch(n, e);
  }
}
function Ua(n) {
  return Array.isArray(n) ? n.map((e) => Number(e)).filter((e) => Number.isFinite(e)) : [];
}
function $a(n) {
  const e = n.trim().replace(/\/+$/, "");
  return e.endsWith("/embeddings") ? e : e.endsWith("/v1") ? on(e, "embeddings") : on(e, "v1/embeddings");
}
class Ba {
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
    const r = new AbortController(), s = Math.max(1e3, this.settings.timeoutMs || 6e4);
    let a = !1;
    const i = setTimeout(() => {
      a = !0, r.abort();
    }, s), o = $a(this.settings.baseUrl), c = {
      model: this.settings.model,
      input: t
    };
    this.settings.dimensions && Number.isFinite(this.settings.dimensions) && (c.dimensions = this.settings.dimensions);
    const d = Date.now();
    try {
      B("INFO", "EmbeddingClient.embed.request", "Embedding request", {
        url: o,
        timeoutMs: s,
        body: Ie(c),
        inputCount: t.length
      });
      const h = await Pa(o, {
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
      const w = (Array.isArray(f == null ? void 0 : f.data) ? f.data : []).sort((u, I) => Number((u == null ? void 0 : u.index) || 0) - Number((I == null ? void 0 : I.index) || 0)).map((u) => Ua(u == null ? void 0 : u.embedding)).filter((u) => u.length > 0), g = ((m = w[0]) == null ? void 0 : m.length) || this.settings.dimensions || 0;
      if (w.length !== t.length)
        throw new Error(`Embedding API returned ${w.length} vectors for ${t.length} inputs.`);
      return B("INFO", "EmbeddingClient.embed.response", "Embedding response ok", {
        url: o,
        elapsedMs: Date.now() - d,
        inputCount: t.length,
        dimensions: g,
        model: (f == null ? void 0 : f.model) || this.settings.model
      }), {
        embeddings: w,
        model: (f == null ? void 0 : f.model) || this.settings.model,
        dimensions: g,
        provider: "openai-compatible"
      };
    } catch (h) {
      throw Se("EmbeddingClient.embed.error", h, {
        url: o,
        elapsedMs: Date.now() - d,
        didTimeout: a,
        requestBody: Ie(c)
      }), a ? new Error(`Embedding API timeout after ${s}ms`) : h;
    } finally {
      clearTimeout(i);
    }
  }
}
const _t = 384, cn = 900, Fa = 120, qa = 0.08;
function dn(n) {
  return Ne("sha256").update(n).digest("hex");
}
function os(n) {
  if (!(n != null && n.trim()))
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (s) => {
      !s || typeof s != "object" || (typeof s.text == "string" && t.push(s.text), Array.isArray(s.children) && s.children.forEach(r));
    };
    return r((e == null ? void 0 : e.root) || e), t.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return n.replace(/\s+/g, " ").trim();
  }
}
function qe(n) {
  if (typeof n != "string" || !n.trim())
    return [];
  try {
    const e = JSON.parse(n);
    return Array.isArray(e) ? e.map((t) => String(t || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function zt(n) {
  if (typeof n != "string" || !n.trim() || n.trim() === "{}")
    return "";
  try {
    const e = JSON.parse(n);
    return !e || typeof e != "object" ? "" : Object.entries(e).map(([t, r]) => `${t}: ${String(r || "")}`).filter((t) => !t.endsWith(": ")).join("; ");
  } catch {
    return n;
  }
}
function is(n) {
  const e = n.toLowerCase(), t = Array.from(e.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)).map((a) => a[0]), r = Array.from(e.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)).map((a) => a[0]), s = [];
  for (const a of r) {
    if (a.length === 1) {
      s.push(a);
      continue;
    }
    for (let i = 0; i < a.length - 1; i += 1)
      s.push(a.slice(i, i + 2));
    a.length <= 4 && s.push(a);
  }
  return [...t, ...s].filter(Boolean);
}
function ja(n) {
  const e = Ne("sha1").update(n).digest();
  return {
    index: e.readUInt32BE(0) % _t,
    sign: (e[4] & 1) === 1 ? 1 : -1
  };
}
function Wt(n) {
  const e = new Array(_t).fill(0), t = /* @__PURE__ */ new Map();
  for (const s of is(n))
    t.set(s, (t.get(s) || 0) + 1);
  for (const [s, a] of t) {
    const { index: i, sign: o } = ja(s);
    e[i] += o * Math.log1p(a);
  }
  const r = Math.sqrt(e.reduce((s, a) => s + a * a, 0));
  return r <= 0 ? e : e.map((s) => Number((s / r).toFixed(6)));
}
function Va(n) {
  const e = Buffer.alloc(n.length * 4);
  for (let t = 0; t < n.length; t += 1)
    e.writeFloatLE(Number.isFinite(n[t]) ? n[t] : 0, t * 4);
  return e;
}
function Ja(n, e) {
  if (!n)
    return [];
  const t = Buffer.isBuffer(n) ? n : Buffer.from(n), r = Math.floor(t.length / 4), s = e && e > 0 ? Math.min(e, r) : r, a = [];
  for (let i = 0; i < s; i += 1)
    a.push(t.readFloatLE(i * 4));
  return a;
}
function Ha(n, e) {
  const t = Math.min(n.length, e.length);
  let r = 0;
  for (let s = 0; s < t; s += 1)
    r += n[s] * e[s];
  return r;
}
function za(n, e) {
  const t = Array.from(new Set(is(n)));
  if (t.length === 0)
    return 0;
  const r = e.toLowerCase();
  let s = 0;
  for (const a of t)
    r.includes(a) && (s += 1);
  return s / t.length;
}
function Wa(n) {
  const e = n.replace(/\s+/g, " ").trim();
  if (!e)
    return [];
  if (e.length <= cn)
    return [e];
  const t = [];
  let r = 0;
  for (; r < e.length; ) {
    const s = Math.min(e.length, r + cn);
    if (t.push(e.slice(r, s)), s >= e.length)
      break;
    r = Math.max(0, s - Fa);
  }
  return t;
}
async function Dt() {
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
  for (const [r, s] of t)
    e.has(r) || await S.$executeRawUnsafe(s);
  await S.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_novel ON rag_vector_chunks(novel_id);"), await S.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_source ON rag_vector_chunks(source_type, source_id);");
}
async function ln(n) {
  var t;
  await Dt();
  const e = await S.$queryRaw`
        SELECT COUNT(*) as count FROM rag_vector_chunks WHERE novel_id = ${n};
    `;
  return Number(((t = e[0]) == null ? void 0 : t.count) || 0);
}
async function Ga(n) {
  var d;
  const [e, t, r, s, a, i, o] = await Promise.all([
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
    const m = zt(l.profile), h = Array.isArray(l.items) ? l.items.map((p) => {
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
      content: [l.name, l.type, l.description, zt(l.profile)].filter(Boolean).join(`
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
  for (const l of s) {
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
  for (const l of a) {
    const m = os(l.content || "");
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
        ...qe(l.keyFacts),
        ...qe(l.timelineHints),
        ...qe(l.openQuestions)
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
        ...qe(l.keyFacts),
        ...qe(l.unresolvedThreads),
        ...qe(l.hardConstraints)
      ].filter(Boolean).join(`
`)
    });
  return c;
}
async function Ka(n) {
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
  const t = os(e.content || "");
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
async function cs(n, e) {
  var t;
  switch (n) {
    case "chapter":
      return Ka(e);
    case "character": {
      const r = await S.character.findUnique({
        where: { id: e },
        include: { items: { include: { item: !0 } } }
      });
      if (!r)
        return null;
      const s = zt(r.profile), a = Array.isArray(r.items) ? r.items.map((i) => {
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
          s,
          a ? `Owned items: ${a}` : "",
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
        content: [r.name, r.type, r.description, zt(r.profile)].filter(Boolean).join(`
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
          ...qe(r.keyFacts),
          ...qe(r.timelineHints),
          ...qe(r.openQuestions)
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
          ...qe(r.keyFacts),
          ...qe(r.unresolvedThreads),
          ...qe(r.hardConstraints)
        ].filter(Boolean).join(`
`)
      };
    }
    default:
      return null;
  }
}
async function Xa(n) {
  const e = n.settings;
  if (e != null && e.enabled && e.baseUrl.trim())
    try {
      const r = new Ba(e), s = Math.max(1, Math.min(64, e.batchSize || 8)), a = [];
      let i = e.model, o = e.dimensions || 0;
      for (let c = 0; c < n.texts.length; c += s) {
        const d = n.texts.slice(c, c + s), l = await r.embed(d);
        a.push(...l.embeddings), i = l.model, o = l.dimensions;
      }
      return { vectors: a, provider: "openai-compatible", model: i, dimensions: o, fallbackUsed: !1 };
    } catch (r) {
      if (!e.fallbackToHash)
        throw r;
      console.warn("[RAG] Embedding API failed; falling back to local hash vectors:", r);
      const s = r instanceof Error ? r.message : String(r);
      return { vectors: n.texts.map((i) => Wt(i)), provider: "hash", model: "local-hash-v1", dimensions: _t, fallbackUsed: !0, fallbackError: s };
    }
  return { vectors: n.texts.map((r) => Wt(r)), provider: "hash", model: "local-hash-v1", dimensions: _t, fallbackUsed: !!(e != null && e.enabled) };
}
async function ds(n, e) {
  const t = [];
  for (const a of n) {
    const i = Wa(a.content);
    for (let o = 0; o < i.length; o += 1)
      t.push({ doc: a, index: o, content: i[o] });
  }
  const r = await Xa({
    texts: t.map((a) => `${a.doc.title}
${a.content}`),
    settings: e
  }), s = (/* @__PURE__ */ new Date()).toISOString();
  for (let a = 0; a < t.length; a += 1) {
    const i = t[a], o = r.vectors[a] || Wt(`${i.doc.title}
${i.content}`), c = dn(`${i.doc.sourceType}:${i.doc.sourceId}:${i.index}:${i.content}`), d = dn(`${i.doc.novelId}:${i.doc.sourceType}:${i.doc.sourceId}:${i.index}`), l = r.provider === "hash" ? JSON.stringify(o) : "[]", m = Va(o), h = o.length;
    await S.$executeRaw`
            INSERT INTO rag_vector_chunks (id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim, embedding_provider, embedding_model, content_hash, updated_at)
            VALUES (${d}, ${i.doc.novelId}, ${i.doc.sourceType}, ${i.doc.sourceId}, ${i.doc.title}, ${i.content}, ${l}, ${m}, ${h}, ${r.provider}, ${r.model}, ${c}, ${s});
        `;
  }
  return { chunks: t.length, sources: n.length, provider: r.provider, model: r.model, dimensions: r.dimensions, fallbackUsed: r.fallbackUsed, fallbackError: r.fallbackError };
}
async function Za(n, e) {
  await Dt();
  const t = await Ga(n);
  return await S.$executeRaw`DELETE FROM rag_vector_chunks WHERE novel_id = ${n};`, ds(t, e);
}
async function br(n) {
  if (await Dt(), n.novelId) {
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
async function Ya(n, e) {
  return await Dt(), await br({
    novelId: n.novelId,
    sourceType: n.sourceType,
    sourceId: n.sourceId
  }), n.content.trim() ? ds([n], e) : {
    chunks: 0,
    sources: 1,
    provider: "none",
    model: "empty-source",
    dimensions: 0,
    fallbackUsed: !1
  };
}
async function ls(n, e, t) {
  const r = await cs(n, e);
  return r ? { ...await Ya(r, t), novelId: r.novelId, sourceType: r.sourceType, sourceId: r.sourceId } : {
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
async function Qa(n, e) {
  const t = await ls("chapter", n, e);
  return { ...t, sourceId: t.sourceId };
}
async function eo(n) {
  var a;
  await Dt();
  const e = await S.$queryRaw`
        SELECT id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim
        FROM rag_vector_chunks
        WHERE novel_id = ${n.novelId};
    `;
  if (e.length === 0)
    return [];
  const t = Wt(n.query), r = ((a = e.find((i) => Number(i.embedding_dim || 0) > 0)) == null ? void 0 : a.embedding_dim) || 0, s = r === 0 || r === _t;
  return e.map((i) => {
    let o = za(n.query, `${i.title}
${i.content}`), c = "local_vector_lexical";
    if (s) {
      let d = Ja(i.embedding_blob, i.embedding_dim);
      if (d.length === 0 && i.embedding_json)
        try {
          const l = JSON.parse(i.embedding_json);
          d = Array.isArray(l) ? l.map((m) => Number(m) || 0) : [];
        } catch {
          d = [];
        }
      d.length > 0 && (o = Math.max(o, Ha(t, d)), c = "local_vector_hash");
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
    return Number(((o = i.metadata) == null ? void 0 : o.vectorSimilarity) || 0) >= qa;
  }).sort((i, o) => (o.score || 0) - (i.score || 0)).slice(0, Math.max(1, Math.min(16, n.limit ?? 8)));
}
function to(n, e) {
  const t = typeof n == "string" ? n.replace(/\s+/g, " ").trim() : "";
  return t ? t.length > e ? `${t.slice(0, e)}...` : t : "";
}
function ht(n) {
  if (typeof n != "string" || !n.trim())
    return [];
  try {
    const e = JSON.parse(n);
    return Array.isArray(e) ? e.map((t) => String(t || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function un(n) {
  if (typeof n != "string" || !n.trim() || n.trim() === "{}")
    return "";
  try {
    const e = JSON.parse(n);
    return !e || typeof e != "object" ? "" : Object.entries(e).map(([t, r]) => `${t}: ${String(r || "")}`).filter((t) => !t.endsWith(": ")).join("; ");
  } catch {
    return n;
  }
}
function xe(n, e) {
  const t = String(n || "").toLowerCase();
  return e.some((r) => t.includes(r.toLowerCase()));
}
function et(n, e, t) {
  return e === "future_plot_for_entity" && t === "plotPoint" ? n + 40 : e === "outline_next" && (t === "plotPoint" || t === "plotLine") ? n + 35 : e === "character_state" && (t === "character" || t === "relationship" || t === "item" || t === "map") ? n + 30 : e === "unresolved_threads" && (t === "narrativeSummary" || t === "chapterSummary" || t === "plotPoint") ? n + 25 : n;
}
function _e(n, e) {
  const t = `E${n.length + 1}`, r = to(e.excerpt, 900);
  r && n.push({ id: t, ...e, excerpt: r });
}
async function ro(n) {
  const [e, t, r] = await Promise.all([
    S.character.findMany({ where: { novelId: n }, select: { name: !0 } }),
    S.item.findMany({ where: { novelId: n }, select: { name: !0 } }),
    S.worldSetting.findMany({ where: { novelId: n }, select: { name: !0 } })
  ]), s = [...e, ...t, ...r].map((a) => String((a == null ? void 0 : a.name) || "").trim()).filter(Boolean);
  return Array.from(new Set(s));
}
async function no(n) {
  var T, R, M, J, F, Y, L, ae;
  const e = Math.max(4, Math.min(24, n.maxEvidenceItems ?? 12)), t = n.detection.entityNames, r = n.detection.keywords, s = n.detection.intent, a = [], i = [], o = /* @__PURE__ */ new Set(), c = (n.locale || "zh").startsWith("zh"), [d, l, m, h, p, f, v] = await Promise.all([
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
  (T = n.selectedText) != null && T.trim() && (_e(a, {
    sourceType: "currentContext",
    sourceId: n.chapterId || "selectedText",
    title: "Selected text",
    excerpt: n.selectedText,
    score: 95
  }), o.add("selected_text")), (R = n.currentContent) != null && R.trim() && (_e(a, {
    sourceType: "currentContext",
    sourceId: n.chapterId || "currentContent",
    title: v != null && v.title ? `Current chapter: ${v.title}` : "Current chapter context",
    excerpt: n.currentContent.slice(-1600),
    metadata: v ? { chapterOrder: v.order, volumeTitle: (M = v.volume) == null ? void 0 : M.title } : void 0,
    score: 55
  }), o.add("current_chapter_context")), (J = n.currentLocation) != null && J.trim() && (_e(a, {
    sourceType: "currentContext",
    sourceId: "currentLocation",
    title: "Current location",
    excerpt: n.currentLocation,
    score: 50
  }), o.add("current_location"));
  const w = await eo({
    novelId: n.novelId,
    query: n.question,
    limit: Math.min(8, e),
    settings: n.embeddingSettings
  });
  for (const b of w)
    _e(a, {
      ...b,
      score: 90 + Math.max(0, b.score || 0)
    });
  w.length > 0 && o.add("vector_chunks");
  const g = d.filter((b) => t.length === 0 ? r.some((Z) => xe(`${b.name} ${b.role} ${b.description} ${b.profile}`, [Z])) : xe(b.name, t));
  for (const b of g.slice(0, 8)) {
    const Z = un(b.profile), W = Array.isArray(b.items) ? b.items.map((Q) => {
      var ne;
      return `${((ne = Q.item) == null ? void 0 : ne.name) || ""}${Q.note ? `(${Q.note})` : ""}`;
    }).filter(Boolean).join(", ") : "";
    _e(a, {
      sourceType: "character",
      sourceId: b.id,
      title: `Character: ${b.name}`,
      excerpt: [
        b.role ? `Role: ${b.role}` : "",
        b.description ? `Description: ${b.description}` : "",
        Z ? `Profile: ${Z}` : "",
        W ? `Owned items: ${W}` : ""
      ].filter(Boolean).join(`
`),
      metadata: { name: b.name, isStarred: b.isStarred },
      score: et(100 + (b.isStarred ? 10 : 0), s, "character")
    }), o.add("characters");
    for (const Q of [...b.relationsAsSource || [], ...b.relationsAsTarget || []].slice(0, 8)) {
      const ne = ((F = Q.target) == null ? void 0 : F.name) || ((Y = Q.source) == null ? void 0 : Y.name) || "";
      _e(a, {
        sourceType: "relationship",
        sourceId: Q.id,
        title: `Relationship: ${b.name} - ${ne}`,
        excerpt: `${Q.relation || ""}${Q.description ? `: ${Q.description}` : ""}`,
        metadata: { characterName: b.name, relatedName: ne },
        score: et(80, s, "relationship")
      });
    }
    for (const Q of (b.mapMarkers || []).slice(0, 6))
      _e(a, {
        sourceType: "map",
        sourceId: Q.id,
        title: `Map: ${((L = Q.map) == null ? void 0 : L.name) || Q.mapId}`,
        excerpt: `${b.name} marker${Q.label ? `: ${Q.label}` : ""}`,
        metadata: { characterName: b.name, mapId: Q.mapId, mapType: (ae = Q.map) == null ? void 0 : ae.type },
        score: et(70, s, "map")
      });
  }
  for (const b of l) {
    const Z = `${b.name} ${b.type} ${b.description} ${b.profile}`;
    if (t.length > 0 && !xe(Z, t) || t.length === 0 && !r.some((ne) => xe(Z, [ne])))
      continue;
    const W = un(b.profile), Q = Array.isArray(b.owners) ? b.owners.map((ne) => {
      var de;
      return `${((de = ne.character) == null ? void 0 : de.name) || ""}${ne.note ? `(${ne.note})` : ""}`;
    }).filter(Boolean).join(", ") : "";
    _e(a, {
      sourceType: "item",
      sourceId: b.id,
      title: `${b.type || "Item"}: ${b.name}`,
      excerpt: [
        b.description ? `Description: ${b.description}` : "",
        W ? `Profile: ${W}` : "",
        Q ? `Owners: ${Q}` : ""
      ].filter(Boolean).join(`
`),
      score: et(78, s, "item")
    }), o.add("items");
  }
  for (const b of m) {
    const Z = `${b.name} ${b.content} ${b.type}`;
    t.length > 0 && !xe(Z, t) || t.length === 0 && !r.some((W) => xe(Z, [W])) || (_e(a, {
      sourceType: "worldSetting",
      sourceId: b.id,
      title: `World: ${b.name}`,
      excerpt: b.content,
      metadata: { type: b.type },
      score: 65
    }), o.add("world_settings"));
  }
  for (const b of h) {
    const Z = t.length === 0 ? r.some((W) => xe(`${b.name} ${b.description}`, [W])) : xe(`${b.name} ${b.description}`, t);
    (Z || s === "outline_next" || s === "unresolved_threads") && (_e(a, {
      sourceType: "plotLine",
      sourceId: b.id,
      title: `Plot line: ${b.name}`,
      excerpt: b.description || b.name,
      score: et(Z ? 85 : 45, s, "plotLine")
    }), o.add("plot_outline"));
    for (const W of b.points || []) {
      const Q = `${b.name} ${b.description || ""} ${W.title} ${W.description || ""}`, ne = t.length === 0 ? r.some((Be) => xe(Q, [Be])) : xe(Q, t), de = s === "outline_next" && W.status !== "resolved", Oe = s === "unresolved_threads" && W.status !== "resolved";
      if (!ne && !de && !Oe)
        continue;
      const $e = Array.isArray(W.anchors) ? W.anchors.map((Be) => {
        var Je;
        const Le = Be.chapter;
        return `${Be.type}: ${((Je = Le == null ? void 0 : Le.volume) == null ? void 0 : Je.title) || ""} ${(Le == null ? void 0 : Le.title) || Be.chapterId}`.trim();
      }).join("; ") : "";
      _e(a, {
        sourceType: "plotPoint",
        sourceId: W.id,
        title: `Plot point: ${W.title}`,
        excerpt: [
          `Line: ${b.name}`,
          `Status: ${W.status || "active"}`,
          W.description ? `Description: ${W.description}` : "",
          $e ? `Anchors: ${$e}` : ""
        ].filter(Boolean).join(`
`),
        metadata: { plotLineId: b.id, status: W.status, type: W.type },
        score: et((ne ? 105 : 70) + (W.status === "resolved" ? -20 : 20), s, "plotPoint")
      }), o.add("plot_points");
    }
  }
  const u = n.analysisScope || "current_chapter", I = u === "volume_structure" || u === "compare_two_paths";
  for (const b of I ? p : []) {
    const Z = ht(b.unresolvedThreads), W = ht(b.keyFacts), Q = ht(b.hardConstraints), ne = [
      b.summaryText,
      W.length ? `Key facts: ${W.join("; ")}` : "",
      Z.length ? `Unresolved threads: ${Z.join("; ")}` : "",
      Q.length ? `Hard constraints: ${Q.join("; ")}` : ""
    ].filter(Boolean).join(`
`), de = t.length === 0 ? r.some((Oe) => xe(ne, [Oe])) : xe(ne, t);
    !de && !["outline_next", "unresolved_threads", "general_qa"].includes(s) || (_e(a, {
      sourceType: "narrativeSummary",
      sourceId: b.id,
      title: `${b.level || "novel"} summary: ${b.title || "latest"}`,
      excerpt: ne,
      score: et(de ? 90 : 55, s, "narrativeSummary")
    }), o.add("narrative_summaries"));
  }
  const y = f.filter((b) => v ? u === "current_chapter" ? b.chapterId === v.id : u === "nearby_chapters" ? typeof b.chapterOrder == "number" && Math.abs(b.chapterOrder - v.order) <= 3 : u === "volume_structure" ? b.volumeId === v.volumeId : !0 : u !== "current_chapter" || b.chapterId === n.chapterId);
  for (const b of y) {
    const Z = ht(b.openQuestions), W = ht(b.timelineHints), Q = ht(b.keyFacts), ne = [
      b.compressedMemory || b.summaryText,
      Q.length ? `Key facts: ${Q.join("; ")}` : "",
      W.length ? `Timeline hints: ${W.join("; ")}` : "",
      Z.length ? `Open questions: ${Z.join("; ")}` : ""
    ].filter(Boolean).join(`
`), de = t.length === 0 ? r.some((Oe) => xe(ne, [Oe])) : xe(ne, t);
    !de && s !== "unresolved_threads" || (_e(a, {
      sourceType: "chapterSummary",
      sourceId: b.id,
      title: `Chapter summary: ${b.chapterId}`,
      excerpt: ne,
      metadata: { chapterId: b.chapterId, chapterOrder: b.chapterOrder },
      score: et(de ? 85 : 60, s, "chapterSummary")
    }), o.add("chapter_summaries"));
  }
  const A = Array.from(/* @__PURE__ */ new Set([...t, ...r])).slice(0, 6);
  for (const b of A) {
    const Z = await Or(n.novelId, b, 5, 0);
    for (const W of Z.slice(0, 4))
      _e(a, {
        sourceType: W.entityType === "idea" ? "idea" : "searchHit",
        sourceId: W.entityId,
        title: W.title || b,
        excerpt: W.preview || W.snippet,
        metadata: {
          keyword: b,
          chapterId: W.chapterId,
          volumeTitle: W.volumeTitle,
          matchType: W.matchType
        },
        score: W.matchType === "title" ? 62 : 42
      }), o.add("search_hits");
  }
  const C = /* @__PURE__ */ new Map();
  for (const b of a) {
    const Z = `${b.sourceType}:${b.sourceId}:${b.title}`, W = C.get(Z);
    (!W || (b.score || 0) > (W.score || 0)) && C.set(Z, b);
  }
  const E = Array.from(C.values()).sort((b, Z) => (Z.score || 0) - (b.score || 0)).slice(0, e).map((b, Z) => ({ ...b, id: `E${Z + 1}` }));
  return E.length === 0 && i.push(c ? "未找到相关证据，本次回答应视为低置信度。" : "No relevant evidence found. The answer should be treated as low confidence."), {
    evidence: E,
    warnings: i,
    usedContext: Array.from(o)
  };
}
function hn(n, e) {
  const t = [];
  return n != null && n.trim() && t.push(`[System Prompt]
${n.trim()}`), t.push(`[User Prompt]
${e.trim()}`), t.join(`

`);
}
function so(n, e) {
  const t = n.toLowerCase();
  return /不足以判断|资料不足|无法判断|insufficient|not enough/.test(t) ? "low" : /confidence\s*[:：]\s*high|置信度\s*[:：]\s*高/.test(t) ? "high" : /confidence\s*[:：]\s*low|置信度\s*[:：]\s*低/.test(t) ? "low" : e >= 5 ? "high" : e >= 2 ? "medium" : "low";
}
function ao(n, e) {
  const t = /* @__PURE__ */ new Set();
  for (const r of n.matchAll(/\[?(E\d+)\]?/g)) {
    const s = r[1];
    e.includes(s) && t.add(s);
  }
  return Array.from(t).map((r) => ({ evidenceId: r, label: `[${r}]` }));
}
class oo {
  async buildPromptBundle(e, t) {
    var h, p, f, v;
    const r = String(e.question || "").trim();
    if (!((h = e.novelId) != null && h.trim()))
      throw new Error("novelId is required");
    if (!r)
      throw new Error("question is required");
    const s = await ro(e.novelId), a = Ma(r, s), i = await no({
      novelId: e.novelId,
      chapterId: e.chapterId,
      currentContent: e.currentContent,
      selectedText: e.selectedText,
      currentLocation: e.currentLocation,
      detection: a,
      question: r,
      maxEvidenceItems: e.maxEvidenceItems,
      analysisScope: e.analysisScope,
      locale: e.locale,
      embeddingSettings: t
    }), o = i.evidence.map((w) => `[${w.id}] ${w.sourceType} | ${w.title}
${w.excerpt}`).join(`

`), c = (e.locale || "zh").startsWith("zh"), d = c ? "你是云梦小说智能体中的 RAG 问答助手。你只能基于 Evidence 中提供的资料回答。如果资料不足，请明确说明不足以判断。请区分“已写事实”“大纲计划”“写作建议”。涉及剧情判断时必须引用证据标签，例如 [E1]。不要编造未提供的设定、章节或人物状态。" : "You are a RAG Q&A assistant inside CloudDream Novel Agent. Answer only from the provided Evidence. If evidence is insufficient, say so clearly. Separate written facts, outline plans, and writing suggestions. Cite evidence labels such as [E1]. Do not invent missing lore, chapters, or character state.", l = [
      `Question=${r}`,
      `Intent=${a.intent}`,
      `AnalysisScope=${e.analysisScope || "current_chapter"}`,
      a.entityNames.length ? `DetectedEntities=${a.entityNames.join(", ")}` : "DetectedEntities=none",
      a.keywords.length ? `Keywords=${a.keywords.join(", ")}` : "Keywords=none",
      (p = e.selectedText) != null && p.trim() ? "SelectedTextProvided=true" : "SelectedTextProvided=false",
      (f = e.currentLocation) != null && f.trim() ? `CurrentLocation=${e.currentLocation.trim()}` : "",
      "Evidence=",
      o || "(no relevant evidence found)",
      c ? "Output=用简洁中文回答。若能回答，请按“已写事实 / 大纲计划 / 写作建议 / 置信度”组织；没有对应内容可省略该小节。必须引用证据标签。" : "Output=Answer concisely. Organize as Written facts / Outline plans / Writing suggestions / Confidence when applicable. Omit empty sections. Cite evidence labels."
    ].filter(Boolean).join(`

`), m = (v = e.overrideUserPrompt) != null && v.trim() ? e.overrideUserPrompt.trim() : l;
    return {
      systemPrompt: d,
      defaultUserPrompt: l,
      effectiveUserPrompt: m,
      intent: a.intent,
      evidence: i.evidence,
      citations: i.evidence.map((w) => ({ evidenceId: w.id, label: `[${w.id}]` })),
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
      rawPrompt: hn(r.systemPrompt, r.effectiveUserPrompt),
      editableUserPrompt: r.defaultUserPrompt
    };
  }
  async ask(e, t, r) {
    const s = await this.buildPromptBundle(e, r.embeddingSettings), a = await t.generate({
      systemPrompt: s.systemPrompt,
      prompt: s.effectiveUserPrompt,
      maxTokens: r.maxTokens,
      temperature: r.temperature ?? 0.2,
      signal: r.signal
    }), i = s.evidence.map((c) => c.id), o = ao(a.text, i);
    return {
      ok: !0,
      question: e.question,
      intent: s.intent,
      answer: a.text,
      confidence: so(a.text, s.evidence.length),
      evidence: s.evidence,
      citations: o.length > 0 ? o : s.citations.slice(0, 3),
      warnings: s.warnings,
      usedContext: s.usedContext,
      rawPrompt: hn(s.systemPrompt, s.effectiveUserPrompt),
      editableUserPrompt: s.defaultUserPrompt
    };
  }
}
const io = {
  characterLocations: [],
  relationshipChanges: [],
  knowledgeChanges: [],
  itemStates: [],
  resolvedConflicts: [],
  openedConflicts: [],
  warnings: []
};
function ot(n) {
  return n && typeof n == "object" && !Array.isArray(n) ? n : {};
}
function ge(n, e) {
  return String(n ?? "").trim().slice(0, e);
}
function ur(n, e, t) {
  return Array.isArray(n) ? [...new Set(n.map((r) => ge(r, t)).filter(Boolean))].slice(0, e) : [];
}
function co(n) {
  const e = ot(n);
  return {
    characterLocations: (Array.isArray(e.characterLocations) ? e.characterLocations : []).slice(0, 30).map(ot).map((t) => ({
      characterKey: ge(t.characterKey, 160),
      location: ge(t.location, 300),
      evidenceExcerpt: ge(t.evidenceExcerpt, 500)
    })).filter((t) => t.characterKey && t.location && t.evidenceExcerpt),
    relationshipChanges: (Array.isArray(e.relationshipChanges) ? e.relationshipChanges : []).slice(0, 30).map(ot).map((t) => ({
      sourceCharacterKey: ge(t.sourceCharacterKey, 160),
      targetCharacterKey: ge(t.targetCharacterKey, 160),
      change: ge(t.change, 500),
      evidenceExcerpt: ge(t.evidenceExcerpt, 500)
    })).filter((t) => t.sourceCharacterKey && t.targetCharacterKey && t.change && t.evidenceExcerpt),
    knowledgeChanges: (Array.isArray(e.knowledgeChanges) ? e.knowledgeChanges : []).slice(0, 30).map(ot).map((t) => ({
      characterKey: ge(t.characterKey, 160),
      learned: ur(t.learned, 20, 500),
      forgotten: ur(t.forgotten, 20, 500),
      evidenceExcerpt: ge(t.evidenceExcerpt, 500)
    })).filter((t) => t.characterKey && (t.learned.length > 0 || t.forgotten.length > 0) && t.evidenceExcerpt),
    itemStates: (Array.isArray(e.itemStates) ? e.itemStates : []).slice(0, 30).map(ot).map((t) => ({
      itemKey: ge(t.itemKey, 160),
      state: ge(t.state, 500),
      ...ge(t.holderKey, 160) ? { holderKey: ge(t.holderKey, 160) } : {},
      ...ge(t.location, 300) ? { location: ge(t.location, 300) } : {},
      evidenceExcerpt: ge(t.evidenceExcerpt, 500)
    })).filter((t) => t.itemKey && t.state && t.evidenceExcerpt),
    resolvedConflicts: (Array.isArray(e.resolvedConflicts) ? e.resolvedConflicts : []).slice(0, 20).map(ot).map((t) => ({ conflict: ge(t.conflict, 500), evidenceExcerpt: ge(t.evidenceExcerpt, 500) })).filter((t) => t.conflict && t.evidenceExcerpt),
    openedConflicts: (Array.isArray(e.openedConflicts) ? e.openedConflicts : []).slice(0, 20).map(ot).map((t) => ({ conflict: ge(t.conflict, 500), evidenceExcerpt: ge(t.evidenceExcerpt, 500) })).filter((t) => t.conflict && t.evidenceExcerpt),
    warnings: ur(e.warnings, 20, 500)
  };
}
function lo(n, e) {
  const t = (r) => e.includes(r);
  return {
    ...io,
    characterLocations: n.characterLocations.filter((r) => t(r.evidenceExcerpt)),
    relationshipChanges: n.relationshipChanges.filter((r) => t(r.evidenceExcerpt)),
    knowledgeChanges: n.knowledgeChanges.filter((r) => t(r.evidenceExcerpt)),
    itemStates: n.itemStates.filter((r) => t(r.evidenceExcerpt)),
    resolvedConflicts: n.resolvedConflicts.filter((r) => t(r.evidenceExcerpt)),
    openedConflicts: n.openedConflicts.filter((r) => t(r.evidenceExcerpt)),
    warnings: n.warnings
  };
}
const hr = 10 * 1024 * 1024, uo = 2e3, mn = /* @__PURE__ */ new Set(["foreshadowing", "mystery", "promise", "event"]), fn = /* @__PURE__ */ new Set(["active", "resolved"]), ho = /* @__PURE__ */ new Set(["item", "skill", "location"]), mo = /* @__PURE__ */ new Set(["world", "region", "scene"]), Ft = ["plotLines", "plotPoints", "characters", "items", "skills", "maps"], fo = {
  plotLines: ["主线", "支线", "故事线", "剧情线", "plot line", "story line"],
  plotPoints: ["要点", "情节点", "剧情点", "事件", "桥段", "转折", "冲突", "plot point", "scene beat"],
  characters: ["角色", "龙套", "配角", "人物", "反派", "主角", "npc", "character"],
  items: ["物品", "道具", "装备", "宝物", "武器", "法宝", "artifact", "item"],
  skills: ["技能", "招式", "能力", "法术", "功法", "绝招", "spell", "skill"],
  maps: ["地图", "场景", "地点", "区域", "城市", "宗门地图", "world map", "map", "location"]
}, mr = [
  "novel.list",
  "volume.list",
  "chapter.list",
  "chapter.create",
  "chapter.save",
  "chapter.generate"
], po = [
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
], tt = {
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
function fr(n) {
  return JSON.stringify(n ?? {});
}
function go(n) {
  const e = (n || "").toLowerCase();
  return e.includes("jpeg") || e.includes("jpg") ? "jpg" : e.includes("webp") ? "webp" : e.includes("gif") ? "gif" : e.includes("bmp") ? "bmp" : "png";
}
function vo(n) {
  return n.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function pn(n) {
  if (!(n != null && n.trim()))
    return "";
  try {
    const e = JSON.parse(n), t = [], r = (s) => {
      !s || typeof s != "object" || (typeof s.text == "string" && t.push(s.text), Array.isArray(s.children) && s.children.forEach(r));
    };
    return r((e == null ? void 0 : e.root) || e), t.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return n.replace(/\s+/g, " ").trim();
  }
}
function Io(n) {
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
function gn(n, e) {
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
function mt(n, e) {
  const t = /* @__PURE__ */ new Set(), r = [];
  for (const s of n) {
    const a = String(s || "").trim();
    if (!a)
      continue;
    const i = a.toLowerCase();
    if (!t.has(i) && (t.add(i), r.push(a), r.length >= e))
      break;
  }
  return r;
}
function yo(n) {
  if (!n || typeof n != "object")
    return [];
  const e = n, t = [
    ...e.activeRun && typeof e.activeRun == "object" ? [e.activeRun] : [],
    ...Array.isArray(e.priorRuns) ? e.priorRuns : []
  ], r = /* @__PURE__ */ new Map();
  for (const s of t) {
    if (!s || typeof s != "object")
      continue;
    const a = s;
    for (const i of Array.isArray(a.artifacts) ? a.artifacts : []) {
      if (!i || typeof i != "object")
        continue;
      const o = i, c = x(o.artifactId, 160);
      c && r.set(c, {
        artifactId: c,
        ...o.runId || a.runId ? { runId: x(o.runId || a.runId, 160) } : {},
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
function wo(n) {
  if (!n || typeof n != "object")
    return {};
  const e = n, t = (r) => {
    if (!r || typeof r != "object")
      return r;
    const s = r;
    return {
      ...s,
      artifacts: (Array.isArray(s.artifacts) ? s.artifacts : []).flatMap((a) => {
        if (!a || typeof a != "object")
          return [];
        const i = a;
        return [{
          artifactId: i.artifactId,
          runId: i.runId || s.runId,
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
class So {
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
    this.userDataPath = e(), this.settingsFilePath = k.join(this.userDataPath, "ai-settings.json"), this.mapImageStatsPath = k.join(this.userDataPath, "ai-map-image-stats.json"), this.settingsCache = this.loadSettings(), this.mapImageStatsCache = this.loadMapImageStats(), this.contextBuilder = new Ia(), this.agentContextAssembler = new Ra(), this.novelRagService = new oo(), this.capabilityDefinitions = ua({
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
    const e = new Set(this.capabilityDefinitions.map((i) => i.actionId)), t = po.map((i) => {
      const o = i.requiredActions.filter((l) => !e.has(l)), c = i.requiredActions.filter((l) => e.has(l)), d = i.requiredActions.length === 0 ? 0 : Math.round(c.length / i.requiredActions.length * 100);
      return {
        moduleId: i.moduleId,
        title: i.title,
        requiredActions: [...i.requiredActions],
        supportedActions: c,
        missingActions: o,
        coverage: d
      };
    }), r = t.reduce((i, o) => i + o.requiredActions.length, 0), s = t.reduce((i, o) => i + o.supportedActions.length, 0);
    return {
      overallCoverage: r === 0 ? 0 : Math.round(s / r * 100),
      totalRequired: r,
      totalSupported: s,
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
    return new rn(this.settingsCache).healthCheck();
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
    var w, g;
    const t = e.kind === "skill" ? "skill" : "mcp", r = t === "mcp" ? this.getOpenClawManifest().tools.map((u) => u.name) : this.getOpenClawSkillManifest().skills.map((u) => u.name);
    if (!r.length)
      return {
        ok: !1,
        kind: t,
        detail: t === "mcp" ? "No OpenClaw MCP tools available" : "No OpenClaw skills available",
        missingActions: [...mr],
        checks: []
      };
    const s = mr.filter((u) => !r.includes(u)), a = [], i = (u, I, y, A) => {
      a.push({ actionId: u, ok: I, detail: y, ...A ? { skipped: !0 } : {} });
    };
    s.length ? i("manifest.coverage", !1, `Missing required actions: ${s.join(", ")}`) : i("manifest.coverage", !0, `All required actions are covered (${mr.length})`);
    const o = (u, I) => t === "mcp" ? this.invokeOpenClawTool({ name: u, arguments: I }) : this.invokeOpenClawSkill({ name: u, input: I }), c = await o("novel.list");
    if (!c.ok)
      return i("novel.list", !1, c.error || "invoke failed"), {
        ok: !1,
        kind: t,
        detail: `OpenClaw ${t.toUpperCase()} smoke failed at novel.list: ${c.error || "unknown error"}`,
        missingActions: s,
        checks: a
      };
    i("novel.list", !0, "invoke ok");
    const l = (w = (Array.isArray(c.data) ? c.data : []).find((u) => typeof (u == null ? void 0 : u.id) == "string")) == null ? void 0 : w.id;
    if (!l) {
      i("volume.list", !0, "no novels in database; skipped", !0), i("chapter.list", !0, "no novels in database; skipped", !0);
      const u = s.length === 0;
      return {
        ok: u,
        kind: t,
        detail: u ? `OpenClaw ${t.toUpperCase()} smoke passed (manifest coverage ok, invoke ok, nested checks skipped due to empty data)` : `OpenClaw ${t.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${s.join(", ")})`,
        missingActions: s,
        checks: a
      };
    }
    const m = await o("volume.list", { novelId: l });
    if (!m.ok)
      return i("volume.list", !1, m.error || "invoke failed"), {
        ok: !1,
        kind: t,
        detail: `OpenClaw ${t.toUpperCase()} smoke failed at volume.list: ${m.error || "unknown error"}`,
        missingActions: s,
        checks: a
      };
    i("volume.list", !0, "invoke ok");
    const p = (g = (Array.isArray(m.data) ? m.data : []).find((u) => typeof (u == null ? void 0 : u.id) == "string")) == null ? void 0 : g.id;
    if (!p) {
      i("chapter.list", !0, "no volumes under first novel; skipped", !0);
      const u = s.length === 0;
      return {
        ok: u,
        kind: t,
        detail: u ? `OpenClaw ${t.toUpperCase()} smoke passed (manifest coverage ok, read-chain invoke ok)` : `OpenClaw ${t.toUpperCase()} smoke partial pass (read-chain ok, but manifest missing required actions: ${s.join(", ")})`,
        missingActions: s,
        checks: a
      };
    }
    const f = await o("chapter.list", { volumeId: p });
    if (!f.ok)
      return i("chapter.list", !1, f.error || "invoke failed"), {
        ok: !1,
        kind: t,
        detail: `OpenClaw ${t.toUpperCase()} smoke failed at chapter.list: ${f.error || "unknown error"}`,
        missingActions: s,
        checks: a
      };
    i("chapter.list", !0, "invoke ok");
    const v = s.length === 0;
    return {
      ok: v,
      kind: t,
      detail: v ? `OpenClaw ${t.toUpperCase()} smoke passed (manifest coverage + read-chain invoke all ok)` : `OpenClaw ${t.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${s.join(", ")})`,
      missingActions: s,
      checks: a
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
    const t = this.settingsCache.providerType, r = t === "http" ? this.settingsCache.http.model : "mcp-cli", s = t === "http" ? this.settingsCache.http.contextWindowTokens : this.settingsCache.mcpCli.contextWindowTokens, a = this.agentContextAssembler.assemble({
      providerType: t,
      model: r,
      contextWindowTokens: s,
      outputTokens: e.outputTokens,
      systemPrompt: e.systemPrompt,
      currentRequest: e.currentRequest,
      history: e.history,
      sections: e.sections,
      persistentSummary: e.persistentSummary,
      artifacts: e.artifacts
    });
    return B("INFO", "AiService.agentContext.assembled", "Agent model context assembled", {
      operation: e.operation,
      ...a.diagnostics
    }), a;
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
      throw new O("INVALID_INPUT", "message is required");
    const s = (e.locale || "zh-CN").startsWith("zh"), a = {
      team: s ? "创作团队统筹" : "creative team supervisor",
      writer: s ? "小说作者" : "novel writer",
      editor: s ? "小说编辑" : "novel editor",
      reader: s ? "普通读者评审" : "reader reviewer",
      worldbuilding: s ? "世界观编辑" : "worldbuilding editor",
      research_rag: s ? "考据与证据整理员" : "research assistant"
    }, i = a[e.role] || a.team, o = (e.history || []).map((L) => ({
      role: L.role,
      content: String(L.content || "").trim(),
      ...L.createdAt ? { createdAt: String(L.createdAt) } : {},
      ...L.messageId ? { messageId: String(L.messageId) } : {}
    })).filter((L) => L.content), c = mt(e.availableReadTools || [], 20), d = Array.isArray(e.availableOperations) ? e.availableOperations.slice(0, 30) : [], l = new Set(d.flatMap((L) => typeof (L == null ? void 0 : L.id) == "string" ? [L.id] : [])), m = (e.toolObservations || []).map((L) => ({
      toolName: x(L.toolName, 80),
      args: L.args,
      result: L.result ?? null,
      error: x(L.error, 1e3),
      ok: L.ok !== !1
    })), h = e.selectionContext && typeof e.selectionContext == "object" ? e.selectionContext : {}, p = h.chapterScope && typeof h.chapterScope == "object" ? h.chapterScope : null, f = {
      novelId: x(h.novelId, 160),
      novelTitle: x(h.novelTitle, 300),
      volumeId: x(h.volumeId, 160),
      chapterId: x(h.chapterId, 160),
      chapterTitle: x(h.chapterTitle, 300),
      ...p ? {
        chapterScope: {
          kind: x(p.kind, 40),
          volumeId: x(p.volumeId, 160),
          chapterIds: mt(Array.isArray(p.chapterIds) ? p.chapterIds : [], 20),
          anchorChapterId: x(p.anchorChapterId, 160),
          processingMode: x(p.processingMode, 20),
          experts: mt(Array.isArray(p.experts) ? p.experts : [], 4)
        }
      } : {}
    }, v = x(h.currentContent, 12e4), w = s ? [
      `你是云梦小说智能体中的${i}。`,
      "自然、具体地回答创作问题。只有 ToolObservations 或 CurrentEditorContent 中存在结果时，才能声称已经读取对应的项目内容。",
      "PersistentSummary 是带来源 ID 的会话压缩投影，RecalledMessages/RecalledArtifacts 是按引用召回的原来源摘录；优先采用召回原文与工具证据，不得把旧助手结论当成项目事实。",
      "判断用户是在普通讨论，还是提出了需要读取项目上下文、检索、生成草稿或修改数据的明确任务。",
      "SelectionContext 是当前编辑器显式选中的项目范围。存在 chapterId 时，“这篇文章”“本章”“当前章”等指代必须直接绑定该章节，不得再次询问用户选择章节，也不得为定位它调用 novel.list、volume.list 或 chapter.list。需要持久化章节资料时直接使用该 chapterId 调用 chapter.get；CurrentEditorContent 是用户当前可见正文，优先于数据库中的旧正文。",
      "你可以从 AvailableReadTools 主动选择只读工具。回答依赖项目事实且 ToolObservations 不足时，先返回 toolCalls；每轮最多 3 个，不得调用名单外工具。",
      "仅当 SelectionContext 没有可用目标，或用户明确要求跨章节、当前卷或全书范围时，才用 `volume.list` 发现真实 volumeId/chapterId；`chapter.list` 需要真实 volumeId，`chapter.get` 需要一个真实 chapterId。禁止虚构 ALL、ALL_IF_SUPPORTED 等占位 ID。",
      "收到 ToolObservations 后先综合结果；信息仍不足可继续调用只读工具，否则给出回答并将 toolCalls 设为空数组。",
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
      "Set shouldPlan=true only for sufficiently specified tasks that require project context, retrieval, draft generation, or data changes."
    ].join(" "), g = Math.min(this.settingsCache.http.maxTokens, 1600), u = [
      {
        id: "available-read-tools",
        kind: "metadata",
        priority: "low",
        value: c
      },
      {
        id: "available-operations",
        kind: "metadata",
        priority: "high",
        value: d
      }
    ];
    e.intentPreflight && u.push({
      id: "intent-preflight",
      kind: "decision",
      priority: "required",
      value: e.intentPreflight
    }), (f.novelId || f.volumeId || f.chapterId) && u.push({
      id: "current-selection",
      kind: "metadata",
      priority: "required",
      value: f,
      sourceRef: "renderer-current-selection"
    }), v && u.push({
      id: "current-editor-content",
      kind: "retrieval",
      priority: "high",
      value: v,
      sourceRef: f.chapterId ? `chapter:${f.chapterId}:editor-buffer` : "renderer-editor-buffer",
      maxTokens: 12e3
    }), m.length && u.push({
      id: "tool-observations",
      kind: "tool",
      priority: "high",
      value: m,
      sourceRef: "current-exploration-turn"
    });
    const I = yo(e.conversationContext);
    e.conversationContext && Object.keys(e.conversationContext).length && u.push({
      id: "conversation-state",
      kind: "plan",
      priority: "high",
      value: wo(e.conversationContext),
      sourceRef: "persisted-agent-conversation"
    });
    const y = this.assembleAgentContext({
      operation: "agent.generate_chat",
      systemPrompt: w,
      outputTokens: g,
      currentRequest: {
        message: r,
        role: e.role || "team",
        workMode: e.approvalMode || "review_required",
        selection: f
      },
      history: o,
      sections: u,
      persistentSummary: e.persistentSummary,
      artifacts: I
    }), A = await this.getProvider().generate({
      systemPrompt: w,
      prompt: y.prompt,
      maxTokens: g,
      temperature: Math.min(this.settingsCache.http.temperature, 0.5),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), C = Ce(A.text), E = x(C == null ? void 0 : C.content, 12e3) || x(A.text, 12e3);
    if (!E)
      throw new O("UNKNOWN", "Agent chat returned empty content");
    const T = Array.isArray(C == null ? void 0 : C.toolCalls) ? C.toolCalls.slice(0, 3).flatMap((L) => {
      if (!L || typeof L != "object")
        return [];
      const ae = L, b = x(ae.name, 80);
      return !b || !c.includes(b) ? [] : [{
        name: b,
        args: ae.args && typeof ae.args == "object" && !Array.isArray(ae.args) ? ae.args : {}
      }];
    }) : [], R = Array.isArray(C == null ? void 0 : C.requestedOperations) ? C.requestedOperations.slice(0, 8).flatMap((L) => {
      const ae = x(L, 120);
      return ae && l.has(ae) ? [ae] : [];
    }) : [], M = ["none", "report", "expert_report", "chapter_draft", "chapter_draft_batch", "creative_assets_draft"].includes(x(C == null ? void 0 : C.deliverable, 40)) ? x(C == null ? void 0 : C.deliverable, 40) : void 0, J = ["team", "writer", "editor", "reader", "worldbuilding", "research_rag"].includes(x(C == null ? void 0 : C.suggestedRole, 40)) ? x(C == null ? void 0 : C.suggestedRole, 40) : void 0, F = typeof (C == null ? void 0 : C.confidence) == "number" ? C.confidence : 0.5, Y = y.diagnostics;
    return {
      content: E,
      shouldPlan: (C == null ? void 0 : C.shouldPlan) === !0,
      needsClarification: (C == null ? void 0 : C.needsClarification) === !0,
      requestedOperations: R,
      deliverable: M,
      suggestedRole: J,
      confidence: Math.max(0, Math.min(1, F)),
      toolCalls: T,
      contextDiagnostics: Y,
      ...y.summaryUpdate ? { conversationSummary: y.summaryUpdate } : {},
      ...Y.compressionApplied ? {
        contextCompression: {
          applied: !0,
          model: Y.model,
          contextWindowTokens: Y.contextWindowTokens,
          inputBudgetTokens: Y.inputBudgetTokens,
          estimatedInputTokens: Y.estimatedInputTokens,
          historyMessagesTotal: Y.historyMessagesTotal,
          historyMessagesKept: Y.historyMessagesKept,
          historyMessagesSummarized: Y.historyMessagesSummarized,
          historyMessagesOmitted: Y.historyMessagesOmitted,
          historyMessagesCompacted: Y.historyMessagesCompacted,
          persistentSummaryRevision: Y.persistentSummaryRevision,
          persistentSummaryMessageCount: Y.persistentSummaryMessageCount,
          recalledMessageCount: Y.recalledMessageIds.length,
          recalledArtifactCount: Y.recalledArtifactIds.length,
          compressedSectionIds: Y.compressedSectionIds,
          omittedSectionIds: Y.omittedSectionIds
        }
      } : {}
    };
  }
  async generateChapterBeats(e, t) {
    const r = x(e.novelId, 160), s = x(e.chapterId, 160), a = x(e.goal, 4e3), i = Math.max(1, Math.min(5, Math.trunc(Number(e.chapterCount) || 0)));
    if (!r || !s || !a || !Number.isFinite(Number(e.chapterCount)))
      throw new O("INVALID_INPUT", "novelId, chapterId, goal and chapterCount are required");
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
      prompt: `Goal=${a}

AnchorChapterId=${s}

TargetChapterIds=${JSON.stringify(e.targetChapterIds || [])}

Context=${l}`,
      maxTokens: Math.min(this.settingsCache.http.maxTokens, 3200),
      temperature: Math.min(this.settingsCache.http.temperature, 0.55),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), h = Ce(m.text), p = Array.isArray(h == null ? void 0 : h.beats) ? h.beats : [];
    if (p.length !== i)
      throw new O("UNKNOWN", `Chapter beat generation returned ${p.length}/${i} beats`);
    return { beats: p.map((v, w) => {
      const g = x(v == null ? void 0 : v.title, 120), u = x(v == null ? void 0 : v.chapterGoal, 800), I = x(v == null ? void 0 : v.coreConflict, 800), y = x(v == null ? void 0 : v.endingHook, 800);
      if (!g || !u || !I || !y)
        throw new O("UNKNOWN", `Chapter beat ${w + 1} is incomplete`);
      const A = Math.max(100, Math.min(5e4, Math.trunc(Number(v == null ? void 0 : v.targetWordCount) || 2e3)));
      return {
        title: g,
        chapterGoal: u,
        coreConflict: I,
        keyEvents: Array.isArray(v == null ? void 0 : v.keyEvents) ? v.keyEvents.map((C) => x(C, 500)).filter(Boolean).slice(0, 12) : [],
        reveals: Array.isArray(v == null ? void 0 : v.reveals) ? v.reveals.map((C) => x(C, 500)).filter(Boolean).slice(0, 12) : [],
        endingHook: y,
        targetWordCount: A
      };
    }) };
  }
  async extractNarrativeState(e, t) {
    const r = x(e.generatedText, 8e4);
    if (!r)
      throw new O("INVALID_INPUT", "generatedText is required");
    const s = (e.locale || "zh-CN").startsWith("zh"), a = Array.isArray(e.characters) ? e.characters.slice(0, 100) : [], i = Array.isArray(e.items) ? e.items.slice(0, 100) : [], o = s ? [
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
        `KnownCharacters=${JSON.stringify(a)}`,
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
    }), d = Ce(c.text);
    if (!d)
      throw new O("UNKNOWN", "Narrative state extraction returned invalid JSON");
    const l = co(d), m = lo(l, r), h = new Set(a.flatMap((g) => [g.key, g.name]).filter(Boolean)), p = new Set(i.flatMap((g) => [g.key, g.name]).filter(Boolean)), f = (g) => h.has(g) || r.includes(g), v = (g) => p.has(g) || r.includes(g);
    return { delta: {
      ...m,
      characterLocations: m.characterLocations.filter((g) => f(g.characterKey)),
      relationshipChanges: m.relationshipChanges.filter((g) => f(g.sourceCharacterKey) && f(g.targetCharacterKey)),
      knowledgeChanges: m.knowledgeChanges.filter((g) => f(g.characterKey)),
      itemStates: m.itemStates.filter((g) => v(g.itemKey) && (!g.holderKey || f(g.holderKey)))
    } };
  }
  async generateAgentPlan(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    const s = mt(e.availableTools || [], 50), a = Array.isArray(e.availableToolchains) ? e.availableToolchains.slice(0, 20) : [];
    if (!s.length)
      throw new O("INVALID_INPUT", "availableTools is required");
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
        value: s
      }, {
        id: "available-toolchains",
        kind: "metadata",
        priority: "high",
        value: a
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
    }), m = Ce(l.text);
    if (!m || !Array.isArray(m.steps))
      throw new O("UNKNOWN", "Agent planner did not return valid JSON steps");
    return {
      title: x(m.title, 120) || (i ? "创作任务计划" : "Writing task plan"),
      deliverable: x(m.deliverable, 40),
      steps: m.steps
    };
  }
  async reviseAgentPlan(e, t) {
    var f;
    const r = x(e.goal, 12e3), s = x(e.revision, 8e3);
    if (!r || !s)
      throw new O("INVALID_INPUT", "goal and revision are required");
    const a = mt(e.availableTools || [], 50), i = Array.isArray(e.availableToolchains) ? e.availableToolchains.slice(0, 20) : [];
    if (!a.length)
      throw new O("INVALID_INPUT", "availableTools is required");
    const o = Array.isArray((f = e.currentPlan) == null ? void 0 : f.steps) ? e.currentPlan.steps.slice(0, 8) : [];
    if (!o.length)
      throw new O("INVALID_INPUT", "currentPlan.steps is required");
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
        revision: s,
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
          value: a
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
    }), p = Ce(h.text);
    if (!p || !Array.isArray(p.steps))
      throw new O("UNKNOWN", "Agent plan revision did not return valid JSON steps");
    return {
      title: x(p.title, 120) || e.currentPlan.title,
      deliverable: x(p.deliverable, 40),
      steps: p.steps
    };
  }
  async generateAgentConsistencyReview(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    if (!e.contextBundle || typeof e.contextBundle != "object")
      throw new O("INVALID_INPUT", "contextBundle is required");
    const a = (e.locale || "zh-CN").startsWith("zh") ? [
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
      systemPrompt: a,
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
      systemPrompt: a,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 18e4),
      signal: t
    }), d = Ce(c.text);
    if (!d || !Array.isArray(d.dimensions) || !Array.isArray(d.issues))
      throw new O("UNKNOWN", "Consistency reviewer did not return valid structured JSON");
    return d;
  }
  async generateAgentWriterRangeRevisionPlan(e, t) {
    var m, h;
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new O("INVALID_INPUT", "scopeBundle is required");
    const a = (e.locale || "zh-CN").startsWith("zh") ? [
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
      systemPrompt: a,
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
      systemPrompt: a,
      prompt: c,
      maxTokens: o,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), l = Ce(d.text);
    if (!l || !Array.isArray(l.dimensions) || !Array.isArray(l.findings))
      throw new O("UNKNOWN", "Writer revision planner did not return valid structured JSON");
    return l;
  }
  async generateAgentEditorRangeReview(e, t) {
    var m, h;
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new O("INVALID_INPUT", "scopeBundle is required");
    const a = (e.locale || "zh-CN").startsWith("zh") ? [
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
      systemPrompt: a,
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
      systemPrompt: a,
      prompt: c,
      maxTokens: o,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), l = Ce(d.text);
    if (!l || !Array.isArray(l.dimensions) || !Array.isArray(l.findings))
      throw new O("UNKNOWN", "Editor range reviewer did not return valid structured JSON");
    return l;
  }
  async generateAgentReaderChapterEvaluation(e, t) {
    var h, p;
    const r = x((h = e.chapter) == null ? void 0 : h.chapterId, 200), s = x((p = e.chapter) == null ? void 0 : p.content, 8e4);
    if (!r || !s)
      throw new O("INVALID_INPUT", "chapter.chapterId and chapter.content are required");
    const a = x(e.priorReaderState, 2e3), o = (e.locale || "zh-CN").startsWith("zh") ? [
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
        priorReaderState: a,
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
          content: s
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
    }), m = Ce(l.text);
    if (!m || typeof m.summary != "string" || typeof m.readerStateSummary != "string" || !Array.isArray(m.findings))
      throw new O("UNKNOWN", "Reader journey evaluator did not return valid structured JSON");
    return m;
  }
  async generateAgentWorldbuildingRangeConsistency(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new O("INVALID_INPUT", "scopeBundle is required");
    const a = (e.locale || "zh-CN").startsWith("zh") ? [
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
      systemPrompt: a,
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
      systemPrompt: a,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), d = Ce(c.text);
    if (!d || typeof d.summary != "string" || !Array.isArray(d.dimensions) || !Array.isArray(d.findings) || !Array.isArray(d.entityAssessments))
      throw new O("UNKNOWN", "Worldbuilding consistency reviewer did not return valid structured JSON");
    return d;
  }
  async extractAgentResearchClaims(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new O("INVALID_INPUT", "scopeBundle is required");
    const s = Math.max(1, Math.min(12, Number(e.maxClaims || 8))), i = (e.locale || "zh-CN").startsWith("zh") ? [
      "你是小说考据流程的声明抽取器，只从 ChapterScopeBundle 的目标章节中提取可被证据核验的现实事实、历史、科学、医学、法律、技术、地理、文化或经济陈述。",
      "不要提取纯虚构世界规则、人物情绪、审美评价、剧情预测或无法形成明确陈述的句子。",
      "chapterId 必须是 scope.chapterIds 中真实存在的目标章节 ID；excerpt 必须是当前输入中的短摘录，不得改写成不存在的原文。",
      "searchKeyword 用于当前小说项目全文检索，应简短且有辨识度。requiresExternalEvidence 表示仅靠项目内容和已导入资料通常无法可靠核验。",
      `最多返回 ${s} 条，按对作品可信度的影响排序并去重。只返回严格 JSON，不要 Markdown。`,
      '格式：{"claims":[{"claimId":"claim-1","statement":"可核验陈述","chapterId":"真实章节ID","excerpt":"短摘录","category":"historical|scientific|medical|legal|technical|geographic|cultural|economic|other","importance":"high|medium|low","searchKeyword":"项目检索词","needsProjectSearch":true,"requiresExternalEvidence":false}],"warnings":[]}。'
    ].join(" ") : [
      "Extract evidence-checkable real-world claims only from target chapters in the supplied ChapterScopeBundle.",
      "Exclude fictional lore, emotions, aesthetic opinions, plot predictions, and vague statements.",
      "Use only real target chapter IDs and excerpts present in the input. Produce short project-search keywords and flag claims that require external evidence.",
      `Return at most ${s} deduplicated claims in strict JSON with claims and warnings.`
    ].join(" "), o = Math.min(this.settingsCache.http.maxTokens, 3200), c = this.assembleAgentPrompt({
      operation: "agent.extract_research_claims",
      systemPrompt: i,
      outputTokens: o,
      currentRequest: { goal: r, maxClaims: s },
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
    }), l = Ce(d.text);
    if (!l || !Array.isArray(l.claims))
      throw new O("UNKNOWN", "Research claim extractor did not return valid structured JSON");
    return l;
  }
  async generateAgentResearchFactCheck(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    if (!e.scopeBundle || typeof e.scopeBundle != "object")
      throw new O("INVALID_INPUT", "scopeBundle is required");
    if (!Array.isArray(e.claims))
      throw new O("INVALID_INPUT", "claims is required");
    const a = (e.locale || "zh-CN").startsWith("zh") ? [
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
      systemPrompt: a,
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
      systemPrompt: a,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.1),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), d = Ce(c.text);
    if (!d || typeof d.summary != "string" || !Array.isArray(d.findings))
      throw new O("UNKNOWN", "Research fact-check reviewer did not return valid structured JSON");
    return d;
  }
  async generateAgentScopeAudit(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    const s = Array.isArray(e.childReports) ? e.childReports : [];
    if (!s.length)
      throw new O("INVALID_INPUT", "childReports is required");
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
        value: s,
        sourceRef: "novel.scope_audit@1.0.0"
      }]
    }), d = await this.getProvider().generate({
      systemPrompt: i,
      prompt: c,
      maxTokens: o,
      temperature: Math.min(this.settingsCache.http.temperature, 0.15),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), l = Ce(d.text);
    if (!l || typeof l.summary != "string" || !Array.isArray(l.findings) || !Array.isArray(l.conflicts))
      throw new O("UNKNOWN", "Scope audit supervisor did not return valid structured JSON");
    return l;
  }
  async generateAgentPlotlineAnalysis(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    if (!e.context || typeof e.context != "object")
      throw new O("INVALID_INPUT", "context is required");
    const a = (e.locale || "zh-CN").startsWith("zh") ? [
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
      systemPrompt: a,
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
      systemPrompt: a,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.2),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 21e4),
      signal: t
    }), d = Ce(c.text);
    if (!d || !Array.isArray(d.threads) || !Array.isArray(d.issues))
      throw new O("UNKNOWN", "Plotline analyzer did not return valid structured JSON");
    return d;
  }
  async generateAgentReport(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    const a = (e.locale || "zh-CN").startsWith("zh") ? [
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
      systemPrompt: a,
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
      systemPrompt: a,
      prompt: o,
      maxTokens: i,
      temperature: Math.min(this.settingsCache.http.temperature, 0.45),
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 18e4),
      signal: t
    }), d = Ce(c.text), l = x(d == null ? void 0 : d.content, 2e4), m = x(d == null ? void 0 : d.conversationSummary, 4e3);
    if (!l)
      throw new O("UNKNOWN", "Agent final report returned empty content");
    if (!m)
      throw new O("UNKNOWN", "Agent final report returned empty conversation summary");
    return { content: l, conversationSummary: m };
  }
  async detectAgentCreativeDirection(e, t) {
    const r = x(e.goal, 12e3);
    if (!r)
      throw new O("INVALID_INPUT", "goal is required");
    const a = (e.locale || "zh-CN").startsWith("zh") ? [
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
      systemPrompt: a,
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
      systemPrompt: a,
      prompt: o,
      maxTokens: i,
      temperature: 0.1,
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 12e4),
      signal: t
    }), d = Ce(c.text);
    if (!d || typeof d.requiresDecision != "boolean")
      throw new O("UNKNOWN", "Creative direction detector returned invalid JSON");
    return d.requiresDecision ? {
      requiresDecision: !0,
      title: x(d.title, 120),
      question: x(d.question, 500),
      reason: x(d.reason, 1e3),
      options: Array.isArray(d.options) ? d.options : []
    } : { requiresDecision: !1 };
  }
  async generateTitle(e) {
    var w, g;
    B("INFO", "AiService.generateTitle.start", "Generate title start", {
      chapterId: e.chapterId,
      novelId: e.novelId,
      providerType: this.settingsCache.providerType
    });
    const t = this.getProvider(), r = Math.max(5, Math.min(10, e.count ?? 6)), a = pn(e.content).slice(0, 4e3), i = await S.novel.findUnique({
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
    })).map((u, I) => {
      var y, A;
      return {
        index: I + 1,
        volumeTitle: ((y = u.volume) == null ? void 0 : y.title) || "",
        volumeOrder: ((A = u.volume) == null ? void 0 : A.order) || 0,
        chapterOrder: u.order || 0,
        title: u.title || `Chapter-${I + 1}`
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
          volumeTitle: ((w = o == null ? void 0 : o.volume) == null ? void 0 : w.title) || "",
          volumeOrder: ((g = o == null ? void 0 : o.volume) == null ? void 0 : g.order) || 0
        },
        recentChapterTitles: d,
        currentChapterFullText: a,
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
      return B("INFO", "AiService.generateTitle.success", "Generate title success", {
        chapterId: e.chapterId,
        candidateCount: p.length
      }), { candidates: p };
    const f = m.text.split(`
`).map((u) => u.replace(/^[-\d.\s]+/, "").trim()).filter(Boolean).slice(0, r).map((u) => ({ title: u, styleTag: "稳健推进" }));
    if (f.length > 0)
      return B("INFO", "AiService.generateTitle.success", "Generate title success", {
        chapterId: e.chapterId,
        candidateCount: f.length
      }), { candidates: f };
    const v = ((o == null ? void 0 : o.title) || a.slice(0, 12) || "新章节").trim();
    return B("INFO", "AiService.generateTitle.success", "Generate title success", {
      chapterId: e.chapterId,
      candidateCount: r
    }), {
      candidates: Array.from({ length: r }, (u, I) => ({
        title: `${v} · ${I + 1}`,
        styleTag: "稳健推进"
      }))
    };
  }
  async previewContinuePrompt(e) {
    B("INFO", "AiService.previewContinuePrompt.start", "Preview continue prompt start", {
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
    return B("INFO", "AiService.previewContinuePrompt.success", "Preview continue prompt success", {
      chapterId: e.chapterId
    }), {
      structured: t.structured,
      rawPrompt: gn(t.systemPrompt, r),
      editableUserPrompt: t.defaultUserPrompt,
      usedContext: t.usedContext,
      warnings: t.warnings
    };
  }
  async continueWriting(e, t) {
    B("INFO", "AiService.continueWriting.start", "Continue writing start", {
      chapterId: e.chapterId,
      novelId: e.novelId,
      providerType: this.settingsCache.providerType,
      targetLength: e.targetLength,
      contextChapterCount: e.contextChapterCount
    });
    const r = this.getProvider(), s = await this.buildContinuePromptBundle(e), a = Number.isFinite(e.temperature) ? Math.max(0, Math.min(2, Number(e.temperature))) : this.settingsCache.http.temperature, i = this.assembleDraftGenerationPrompt({
      operation: "chapter.generate_draft",
      systemPrompt: s.systemPrompt,
      outputTokens: this.settingsCache.http.maxTokens,
      structured: s.structured,
      effectiveUserPrompt: s.effectiveUserPrompt,
      usedContext: s.usedContext
    }), o = await r.generate({
      systemPrompt: s.systemPrompt,
      prompt: i,
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: a,
      signal: t
    });
    t == null || t.throwIfAborted();
    const c = await this.checkConsistency({
      novelId: e.novelId,
      text: o.text
    }), d = {
      text: o.text,
      usedContext: s.usedContext,
      warnings: s.warnings,
      contextPolicy: s.contextPolicy,
      contextSnapshot: s.contextSnapshot,
      consistency: c
    };
    return B("INFO", "AiService.continueWriting.success", "Continue writing success", {
      chapterId: e.chapterId,
      warningCount: s.warnings.length,
      generatedLength: d.text.length
    }), d;
  }
  async checkConsistency(e) {
    const t = [];
    return (await S.worldSetting.findMany({ where: { novelId: e.novelId } })).length === 0 && t.push("No world settings found for consistency baseline."), e.text.length < 20 && t.push("Generated text is too short."), { ok: t.length === 0, issues: t };
  }
  async previewNovelAskPrompt(e) {
    var r;
    B("INFO", "AiService.previewNovelAskPrompt.start", "Preview novel RAG prompt start", {
      novelId: e.novelId,
      questionLength: ((r = e.question) == null ? void 0 : r.length) ?? 0
    });
    const t = await this.novelRagService.preview(e, this.settingsCache.embedding);
    return B("INFO", "AiService.previewNovelAskPrompt.success", "Preview novel RAG prompt success", {
      novelId: e.novelId,
      intent: t.intent,
      evidenceCount: t.evidence.length
    }), t;
  }
  async askNovel(e, t) {
    var a;
    B("INFO", "AiService.askNovel.start", "Novel RAG ask start", {
      novelId: e.novelId,
      questionLength: ((a = e.question) == null ? void 0 : a.length) ?? 0,
      providerType: this.settingsCache.providerType
    });
    const r = this.getProvider(), s = await this.novelRagService.ask(e, r, {
      maxTokens: Math.min(2048, this.settingsCache.http.maxTokens || 2048),
      temperature: 0.2,
      embeddingSettings: this.settingsCache.embedding,
      signal: t
    });
    return B("INFO", "AiService.askNovel.success", "Novel RAG ask success", {
      novelId: e.novelId,
      intent: s.intent,
      confidence: s.confidence,
      evidenceCount: s.evidence.length
    }), s;
  }
  async rebuildRagIndex(e) {
    return Za(e, this.settingsCache.embedding);
  }
  async upsertRagChapterIndex(e, t) {
    var r;
    if (t != null && t.skipIfNovelNotIndexed) {
      const s = await S.chapter.findUnique({
        where: { id: e },
        select: { volume: { select: { novelId: !0 } } }
      }), a = (r = s == null ? void 0 : s.volume) == null ? void 0 : r.novelId;
      if (!a || await ln(a) === 0)
        return {
          chunks: 0,
          sources: 0,
          provider: "none",
          model: "not-indexed",
          dimensions: 0,
          fallbackUsed: !1,
          sourceId: e,
          novelId: a,
          skipped: !0
        };
    }
    return Qa(e, this.settingsCache.embedding);
  }
  async upsertRagSourceIndex(e, t, r) {
    if (e === "chapter")
      return { ...await this.upsertRagChapterIndex(t, r), sourceType: e };
    if (r != null && r.skipIfNovelNotIndexed) {
      const s = await cs(e, t), a = s == null ? void 0 : s.novelId;
      if (!a || await ln(a) === 0)
        return {
          chunks: 0,
          sources: 0,
          provider: "none",
          model: "not-indexed",
          dimensions: 0,
          fallbackUsed: !1,
          sourceType: e,
          sourceId: t,
          novelId: a,
          skipped: !0
        };
    }
    return ls(e, t, this.settingsCache.embedding);
  }
  async deleteRagChapterIndex(e, t) {
    return br({
      novelId: e,
      sourceType: "chapter",
      sourceId: t
    });
  }
  async deleteRagSourceIndex(e, t, r) {
    return br({ novelId: e, sourceType: t, sourceId: r });
  }
  deleteGeneratedMapAsset(e) {
    const t = String(e || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!t.startsWith("maps/"))
      return !1;
    const r = k.resolve(this.userDataPath, "maps"), s = k.resolve(this.userDataPath, t);
    return s !== r && !s.startsWith(`${r}${k.sep}`) || !re.existsSync(s) ? !1 : (re.unlinkSync(s), !0);
  }
  refreshRagSourceIndexInBackground(e, t, r) {
    this.upsertRagSourceIndex(e, t, { skipIfNovelNotIndexed: !0 }).catch((s) => {
      console.warn("[RAG] Failed to refresh source index:", { sourceType: e, sourceId: t, reason: r, error: s });
    });
  }
  async refreshLatestCreativeAssetIndexes(e, t) {
    var m;
    const r = async (h, p) => p.length === 0 ? [] : h.findMany({
      where: { novelId: e, name: { in: p } },
      select: { id: !0 }
    }), s = (t.plotLines ?? []).map((h) => h.name).filter(Boolean), a = (t.characters ?? []).map((h) => h.name).filter(Boolean), i = [
      ...(t.items ?? []).map((h) => h.name),
      ...(t.skills ?? []).map((h) => h.name)
    ].filter(Boolean), [o, c, d] = await Promise.all([
      r(S.plotLine, s),
      r(S.character, a),
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
    const r = t && typeof t == "object" ? t : null, s = typeof (r == null ? void 0 : r.id) == "string" ? r.id : "";
    s && (e === "worldsetting.create" || e === "worldsetting.update") && this.refreshRagSourceIndexInBackground("worldSetting", s, e);
  }
  async previewCreativeAssetsPrompt(e) {
    var s;
    B("INFO", "AiService.previewCreativeAssetsPrompt.start", "Preview creative assets prompt start", {
      novelId: e.novelId,
      briefLength: ((s = e.brief) == null ? void 0 : s.length) ?? 0,
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
    return B("INFO", "AiService.previewCreativeAssetsPrompt.success", "Preview creative assets prompt success", {
      novelId: e.novelId
    }), {
      structured: t.structured,
      rawPrompt: gn(t.systemPrompt, r),
      editableUserPrompt: t.defaultUserPrompt,
      usedContext: t.usedContext
    };
  }
  inferCreativeTargetSections(e) {
    const t = String(e || "").trim().toLowerCase();
    if (!t)
      return [...Ft];
    const r = [];
    for (const s of Ft)
      fo[s].some((i) => t.includes(i.toLowerCase())) && r.push(s);
    return r.length > 0 ? r : [...Ft];
  }
  resolveCreativeTargetSections(e) {
    const r = (Array.isArray(e.targetSections) ? e.targetSections : []).filter((s) => Ft.includes(s));
    return r.length > 0 ? r : this.inferCreativeTargetSections(e.brief);
  }
  buildEmptyCreativeDraft(e) {
    const t = {};
    for (const r of e)
      t[r] = [];
    return t;
  }
  async generateCreativeAssets(e, t) {
    var m, h, p, f, v, w, g, u, I, y, A, C, E;
    B("INFO", "AiService.generateCreativeAssets.start", "Generate creative assets start", {
      novelId: e.novelId,
      briefLength: ((m = e.brief) == null ? void 0 : m.length) ?? 0,
      providerType: this.settingsCache.providerType,
      targetSections: e.targetSections
    });
    const r = this.getProvider(), s = await this.buildCreativeAssetsPromptBundle(e), a = this.resolveCreativeTargetSections(e), i = this.assembleDraftGenerationPrompt({
      operation: "creative_assets.generate_draft",
      systemPrompt: s.systemPrompt,
      outputTokens: this.settingsCache.http.maxTokens,
      structured: s.structured,
      effectiveUserPrompt: s.effectiveUserPrompt,
      usedContext: s.usedContext
    }), o = await r.generate({
      systemPrompt: s.systemPrompt,
      prompt: i,
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: this.settingsCache.http.temperature,
      // 创作工坊需要生成多个板块的结构化 JSON，内容量大，使用更宽裕的超时
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 18e4),
      signal: t
    });
    try {
      const T = JSON.parse(o.text);
      if (T && typeof T == "object") {
        const R = this.buildEmptyCreativeDraft(a);
        for (const M of a) {
          const J = T == null ? void 0 : T[M];
          R[M] = Array.isArray(J) ? J : [];
        }
        return B("INFO", "AiService.generateCreativeAssets.success", "Generate creative assets success", {
          novelId: e.novelId,
          counts: {
            plotLines: ((h = R.plotLines) == null ? void 0 : h.length) ?? 0,
            plotPoints: ((p = R.plotPoints) == null ? void 0 : p.length) ?? 0,
            characters: ((f = R.characters) == null ? void 0 : f.length) ?? 0,
            items: ((v = R.items) == null ? void 0 : v.length) ?? 0,
            skills: ((w = R.skills) == null ? void 0 : w.length) ?? 0,
            maps: ((g = R.maps) == null ? void 0 : g.length) ?? 0
          }
        }), { draft: R };
      }
    } catch {
    }
    const c = fe().slice(0, 6), d = {
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
    }, l = this.buildEmptyCreativeDraft(a);
    for (const T of a)
      l[T] = d[T] ?? [];
    return B("INFO", "AiService.generateCreativeAssets.success", "Generate creative assets success", {
      novelId: e.novelId,
      counts: {
        plotLines: ((u = l.plotLines) == null ? void 0 : u.length) ?? 0,
        plotPoints: ((I = l.plotPoints) == null ? void 0 : I.length) ?? 0,
        characters: ((y = l.characters) == null ? void 0 : y.length) ?? 0,
        items: ((A = l.items) == null ? void 0 : A.length) ?? 0,
        skills: ((C = l.skills) == null ? void 0 : C.length) ?? 0,
        maps: ((E = l.maps) == null ? void 0 : E.length) ?? 0
      }
    }), {
      draft: l
    };
  }
  async validateCreativeAssetsDraft(e) {
    var v, w;
    const t = [], r = [], s = (g) => t.push(g), a = (g, u, I = uo) => {
      const y = typeof g == "string" ? g.trim() : "";
      return y ? y.length <= I ? y : (r.push(`${u} exceeds ${I} chars and was truncated`), y.slice(0, I)) : "";
    }, i = (g, u) => {
      if (!g || typeof g != "object" || Array.isArray(g))
        return {};
      const I = {};
      for (const [y, A] of Object.entries(g)) {
        const C = a(y, `${u}.key`, 64), E = a(A, `${u}.${y}`, 500);
        C && E && (I[C] = E);
      }
      return I;
    }, o = {
      plotLines: (e.draft.plotLines ?? []).map((g, u) => ({
        name: a(g.name, `plotLines[${u}].name`, 120),
        description: a(g.description, `plotLines[${u}].description`),
        color: a(g.color, `plotLines[${u}].color`, 16) || "#6366f1",
        points: (g.points ?? []).map((I, y) => {
          const A = a(I.type, `plotLines[${u}].points[${y}].type`, 32) || "event", C = a(I.status, `plotLines[${u}].points[${y}].status`, 32) || "active";
          return {
            title: a(I.title, `plotLines[${u}].points[${y}].title`, 120),
            description: a(I.description, `plotLines[${u}].points[${y}].description`),
            type: mn.has(A) ? A : "event",
            status: fn.has(C) ? C : "active"
          };
        })
      })),
      plotPoints: (e.draft.plotPoints ?? []).map((g, u) => {
        const I = a(g.type, `plotPoints[${u}].type`, 32) || "event", y = a(g.status, `plotPoints[${u}].status`, 32) || "active";
        return {
          title: a(g.title, `plotPoints[${u}].title`, 120),
          description: a(g.description, `plotPoints[${u}].description`),
          type: mn.has(I) ? I : "event",
          status: fn.has(y) ? y : "active",
          plotLineName: a(g.plotLineName, `plotPoints[${u}].plotLineName`, 120)
        };
      }),
      characters: (e.draft.characters ?? []).map((g, u) => ({
        name: a(g.name, `characters[${u}].name`, 120),
        role: a(g.role, `characters[${u}].role`, 64),
        description: a(g.description, `characters[${u}].description`),
        profile: i(g.profile, `characters[${u}].profile`)
      })),
      items: (e.draft.items ?? []).map((g, u) => {
        const I = a(g.type, `items[${u}].type`, 32) || "item";
        return {
          name: a(g.name, `items[${u}].name`, 120),
          type: ho.has(I) ? I : "item",
          description: a(g.description, `items[${u}].description`),
          profile: i(g.profile, `items[${u}].profile`)
        };
      }),
      skills: (e.draft.skills ?? []).map((g, u) => ({
        name: a(g.name, `skills[${u}].name`, 120),
        description: a(g.description, `skills[${u}].description`),
        profile: i(g.profile, `skills[${u}].profile`)
      })),
      maps: (e.draft.maps ?? []).map((g, u) => {
        const I = a(g.type, `maps[${u}].type`, 32) || "world";
        return {
          name: a(g.name, `maps[${u}].name`, 120),
          type: mo.has(I) ? I : "world",
          description: a(g.description, `maps[${u}].description`),
          imagePrompt: a(g.imagePrompt, `maps[${u}].imagePrompt`),
          imageUrl: a(g.imageUrl, `maps[${u}].imageUrl`, 2048),
          imageBase64: a(g.imageBase64, `maps[${u}].imageBase64`, 4194304),
          mimeType: a(g.mimeType, `maps[${u}].mimeType`, 64)
        };
      })
    };
    for (const [g, u] of (o.plotLines ?? []).entries()) {
      u.name || s({ scope: `plotLines[${g}]`, code: "INVALID_INPUT", detail: "Plot line name is required" });
      for (const [I, y] of (u.points ?? []).entries())
        y.title || s({ scope: `plotLines[${g}].points[${I}]`, code: "INVALID_INPUT", detail: "Plot point title is required" });
    }
    for (const [g, u] of (o.plotPoints ?? []).entries())
      u.title || s({ scope: `plotPoints[${g}]`, code: "INVALID_INPUT", detail: "Plot point title is required" });
    for (const [g, u] of (o.characters ?? []).entries())
      u.name || s({ scope: `characters[${g}]`, code: "INVALID_INPUT", detail: "Character name is required" });
    for (const [g, u] of (o.items ?? []).entries())
      u.name || s({ scope: `items[${g}]`, code: "INVALID_INPUT", detail: "Item name is required" });
    for (const [g, u] of (o.skills ?? []).entries())
      u.name || s({ scope: `skills[${g}]`, code: "INVALID_INPUT", detail: "Skill name is required" });
    for (const [g, u] of (o.maps ?? []).entries())
      if (u.name || s({ scope: `maps[${g}]`, code: "INVALID_INPUT", detail: "Map name is required" }), +!!u.imageBase64 + +!!u.imageUrl + +!!u.imagePrompt > 1 && s({
        scope: `maps[${g}]`,
        name: u.name,
        code: "INVALID_INPUT",
        detail: "Map image input must use only one source: imageBase64, imageUrl, or imagePrompt"
      }), u.imageUrl && !/^https?:\/\//i.test(u.imageUrl) && s({
        scope: `maps[${g}].imageUrl`,
        name: u.name,
        code: "INVALID_INPUT",
        detail: "Map imageUrl must start with http:// or https://"
      }), u.imageBase64)
        try {
          const y = Buffer.from(u.imageBase64, "base64").length;
          y === 0 && s({
            scope: `maps[${g}].imageBase64`,
            name: u.name,
            code: "INVALID_INPUT",
            detail: "Map imageBase64 is invalid"
          }), y > hr && s({
            scope: `maps[${g}].imageBase64`,
            name: u.name,
            code: "INVALID_INPUT",
            detail: `Map imageBase64 exceeds ${hr} bytes`
          });
        } catch {
          s({
            scope: `maps[${g}].imageBase64`,
            name: u.name,
            code: "INVALID_INPUT",
            detail: "Map imageBase64 is invalid"
          });
        }
    const c = (g, u) => {
      const I = /* @__PURE__ */ new Set();
      for (const y of g) {
        const A = (y.name || "").trim().toLowerCase();
        if (A) {
          if (I.has(A)) {
            s({
              scope: u,
              name: y.name,
              code: "CONFLICT",
              detail: `Duplicate name in current draft: ${y.name}`
            });
            continue;
          }
          I.add(A);
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
    }, f = (g, u, I) => {
      for (const y of g) {
        const A = (y.name || "").trim().toLowerCase();
        A && p[u].has(A) && s({
          scope: I,
          name: y.name,
          code: "CONFLICT",
          detail: `Name already exists in novel: ${y.name}`
        });
      }
    };
    return f(o.plotLines ?? [], "plotLines", "plotLines"), f(o.characters ?? [], "characters", "characters"), f(o.items ?? [], "items", "items"), f(o.skills ?? [], "items", "skills"), f(o.maps ?? [], "maps", "maps"), (((v = o.plotPoints) == null ? void 0 : v.length) ?? 0) > 0 && (((w = o.plotLines) == null ? void 0 : w.length) ?? 0) === 0 && r.push("Draft has plotPoints but no plotLines. System will create a default plot line when persisting."), {
      ok: t.length === 0,
      errors: t,
      warnings: r,
      normalizedDraft: o
    };
  }
  async confirmCreativeAssets(e) {
    var d, l, m, h, p, f;
    B("INFO", "AiService.confirmCreativeAssets.start", "Confirm creative assets start", {
      novelId: e.novelId,
      draftCounts: Ie({
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
      return B("WARN", "AiService.confirmCreativeAssets.validationFailed", "Confirm creative assets validation failed", {
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
    const s = t.normalizedDraft, a = this.getProvider(), i = [], o = [];
    let c = { ...r };
    try {
      await S.$transaction(async (w) => {
        const g = { ...r }, u = /* @__PURE__ */ new Map();
        for (const y of s.plotLines ?? []) {
          const A = await w.plotLine.create({
            data: {
              novelId: e.novelId,
              name: y.name,
              description: y.description || null,
              color: y.color || "#6366f1",
              sortOrder: Date.now() + g.plotLines
            }
          });
          o.push(Qe("plotLine", A)), u.set(y.name.toLowerCase(), A.id), g.plotLines += 1;
          for (const C of y.points ?? []) {
            const E = await w.plotPoint.create({
              data: {
                novelId: e.novelId,
                plotLineId: A.id,
                title: C.title,
                description: C.description || null,
                type: C.type || "event",
                status: C.status || "active",
                order: Date.now() + g.plotPoints
              }
            });
            o.push(Qe("plotPoint", E)), g.plotPoints += 1;
          }
        }
        const I = async (y) => {
          const A = (y || "").trim().toLowerCase();
          if (A && u.has(A))
            return u.get(A);
          const C = u.values().next().value;
          if (C)
            return C;
          const E = "AI 主线", T = await w.plotLine.create({
            data: {
              novelId: e.novelId,
              name: E,
              description: "Auto-created for loose plot points",
              color: "#6366f1",
              sortOrder: Date.now() + g.plotLines
            }
          });
          return o.push(Qe("plotLine", T)), u.set(E.toLowerCase(), T.id), g.plotLines += 1, T.id;
        };
        for (const y of s.plotPoints ?? []) {
          const A = await I(y.plotLineName), C = await w.plotPoint.create({
            data: {
              novelId: e.novelId,
              plotLineId: A,
              title: y.title,
              description: y.description || null,
              type: y.type || "event",
              status: y.status || "active",
              order: Date.now() + g.plotPoints
            }
          });
          o.push(Qe("plotPoint", C)), g.plotPoints += 1;
        }
        for (const y of s.characters ?? []) {
          const A = await w.character.create({
            data: {
              novelId: e.novelId,
              name: y.name,
              role: y.role || null,
              description: y.description || null,
              profile: fr(y.profile),
              sortOrder: Date.now() + g.characters
            }
          });
          o.push(Qe("character", A)), g.characters += 1;
        }
        for (const y of s.items ?? []) {
          const A = await w.item.create({
            data: {
              novelId: e.novelId,
              name: y.name,
              type: y.type || "item",
              description: y.description || null,
              profile: fr(y.profile),
              sortOrder: Date.now() + g.items
            }
          });
          o.push(Qe("item", A)), g.items += 1;
        }
        for (const y of s.skills ?? []) {
          const A = await w.item.create({
            data: {
              novelId: e.novelId,
              name: y.name,
              type: "skill",
              description: y.description || null,
              profile: fr(y.profile),
              sortOrder: Date.now() + g.items + g.skills
            }
          });
          o.push(Qe("item", A)), g.skills += 1;
        }
        for (const y of s.maps ?? []) {
          const A = await w.mapCanvas.create({
            data: {
              novelId: e.novelId,
              name: y.name,
              type: y.type || "world",
              description: y.description || null,
              sortOrder: Date.now() + g.maps
            }
          });
          let C = A;
          g.maps += 1;
          let E = null;
          if (y.imageBase64 || y.imageUrl)
            E = {
              imageBase64: y.imageBase64,
              imageUrl: y.imageUrl,
              mimeType: y.mimeType
            };
          else if (y.imagePrompt) {
            if (!a.generateImage)
              throw new O("INVALID_INPUT", `Provider ${a.name} does not support image generation`);
            const T = await a.generateImage({ prompt: y.imagePrompt });
            if (!(T != null && T.imageBase64) && !(T != null && T.imageUrl))
              throw new O("PROVIDER_UNAVAILABLE", `Map image generation returned empty data for ${y.name}`);
            E = {
              imageBase64: T.imageBase64,
              imageUrl: T.imageUrl,
              mimeType: T.mimeType
            };
          }
          if (E) {
            const T = await this.saveImageAsset(e.novelId, A.id, E);
            i.push(T.absolutePath), C = await w.mapCanvas.update({
              where: { id: A.id },
              data: { background: T.relativePath }
            }), g.mapImages += 1;
          }
          o.push(Qe("mapCanvas", C));
        }
        c = g;
      });
      const v = {
        success: !0,
        created: c,
        createdEntities: o,
        warnings: t.warnings,
        transactionMode: "atomic"
      };
      return this.refreshLatestCreativeAssetIndexes(e.novelId, s).catch((w) => {
        console.warn("[RAG] Failed to refresh creative asset indexes:", w);
      }), B("INFO", "AiService.confirmCreativeAssets.success", "Confirm creative assets success", {
        novelId: e.novelId,
        created: c,
        warningCount: t.warnings.length
      }), v;
    } catch (v) {
      Se("AiService.confirmCreativeAssets.error", v, {
        novelId: e.novelId
      });
      for (const u of i)
        try {
          re.existsSync(u) && re.unlinkSync(u);
        } catch {
        }
      const w = je(v), g = w.code === "INVALID_INPUT" ? "INVALID_INPUT" : w.code === "CONFLICT" ? "CONFLICT" : w.code === "UNKNOWN" ? "UNKNOWN" : "PERSISTENCE_ERROR";
      return {
        success: !1,
        created: r,
        warnings: t.warnings,
        errors: [
          {
            scope: "confirmCreativeAssets",
            code: g,
            detail: w.message || "Creative assets persistence failed"
          }
        ],
        transactionMode: "atomic"
      };
    }
  }
  async previewMapPrompt(e) {
    var r;
    B("INFO", "AiService.previewMapPrompt.start", "Preview map prompt start", {
      novelId: e.novelId,
      mapId: e.mapId,
      promptLength: ((r = e.prompt) == null ? void 0 : r.length) ?? 0
    });
    const t = await this.buildMapPromptBundle(e);
    return B("INFO", "AiService.previewMapPrompt.success", "Preview map prompt success", {
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
    var s, a, i, o;
    B("INFO", "AiService.generateMapImage.start", "Generate map image start", {
      novelId: e.novelId,
      mapId: e.mapId,
      promptLength: ((s = e.prompt) == null ? void 0 : s.length) ?? 0,
      providerType: this.settingsCache.providerType
    });
    const t = Date.now(), r = (c) => (this.recordMapImageCall({
      ok: c.ok,
      code: c.code,
      detail: c.detail,
      latencyMs: Date.now() - t
    }), c);
    try {
      const c = !!((a = e.prompt) != null && a.trim()), d = !!((i = e.overrideUserPrompt) != null && i.trim());
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
        throw new O("PERSISTENCE_ERROR", "Map id is missing after map creation");
      const f = await this.saveImageAsset(e.novelId, p, {
        imageBase64: h.imageBase64,
        imageUrl: h.imageUrl,
        mimeType: h.mimeType
      });
      await S.mapCanvas.update({
        where: { id: p },
        data: { background: f.relativePath }
      });
      const v = r({
        ok: !0,
        detail: "Map image generated and stored successfully",
        mapId: p,
        path: f.relativePath
      });
      return B("INFO", "AiService.generateMapImage.success", "Generate map image success", {
        novelId: e.novelId,
        mapId: p,
        imagePath: f.relativePath
      }), v;
    } catch (c) {
      Se("AiService.generateMapImage.error", c, {
        novelId: e.novelId,
        mapId: e.mapId
      });
      const d = je(c);
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
      throw new O("INVALID_INPUT", `Unknown actionId: ${e.actionId}`);
    try {
      const r = await t(e.payload);
      return this.refreshRagAfterAction(e.actionId, r), r;
    } catch (r) {
      throw je(r);
    }
  }
  async invokeOpenClawTool(e) {
    try {
      return { ok: !0, data: await this.executeAction({
        actionId: e.name,
        payload: e.arguments
      }) };
    } catch (t) {
      const r = je(t);
      return {
        ok: !1,
        error: It(r.code, r.message || "OpenClaw invoke failed"),
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
      const r = je(t);
      return {
        ok: !1,
        error: It(r.code, r.message || "OpenClaw skill invoke failed"),
        code: r.code
      };
    }
  }
  compactContinueHardContext(e) {
    const t = Array.isArray(e.worldSettings) ? e.worldSettings : [], r = Array.isArray(e.plotLines) ? e.plotLines : [], s = Array.isArray(e.characters) ? e.characters : [], a = Array.isArray(e.items) ? e.items : [], i = Array.isArray(e.maps) ? e.maps : [];
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
      characters: s.slice(0, 120).map((o) => ({
        name: x(o == null ? void 0 : o.name, 80),
        role: x(o == null ? void 0 : o.role, 32),
        description: x(o == null ? void 0 : o.description, 220)
      })).filter((o) => o.name && (o.role || o.description)),
      items: a.slice(0, 120).map((o) => ({
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
    const t = Array.isArray(e.recentChapters) ? e.recentChapters : [], r = Array.isArray(e.selectedIdeas) ? e.selectedIdeas : [], s = Array.isArray(e.selectedIdeaEntities) ? e.selectedIdeaEntities : [], a = Array.isArray(e.narrativeSummaries) ? e.narrativeSummaries : [], i = x(e.currentLocation, 120);
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
      selectedIdeaEntities: s.slice(0, 20).map((o) => ({
        name: x(o == null ? void 0 : o.name, 80),
        kind: x(o == null ? void 0 : o.kind, 24)
      })).filter((o) => o.name && o.kind),
      currentChapterBeforeCursor: x(e.currentChapterBeforeCursor, 12e3),
      ...i ? { currentLocation: i } : {},
      narrativeSummaries: a.slice(0, 4).map((o) => ({
        level: (o == null ? void 0 : o.level) === "volume" ? "volume" : "novel",
        title: x(o == null ? void 0 : o.title, 100),
        summaryText: x(o == null ? void 0 : o.summaryText, 1200),
        keyFacts: Array.isArray(o == null ? void 0 : o.keyFacts) ? mt(o.keyFacts.map((c) => x(c, 160)).filter(Boolean), 5) : []
      }))
    };
  }
  async buildContinuePromptBundle(e) {
    var I, y, A, C;
    const t = /^zh/i.test(String(e.locale || "").trim()), r = e.mode === "new_chapter" ? "new_chapter" : e.mode === "rewrite_chapter" ? "rewrite_chapter" : "continue_chapter", s = e.preparedContext, i = ((I = s == null ? void 0 : s.policy) == null ? void 0 : I.version) === "continuation-context-v1" && ((y = s.snapshot) == null ? void 0 : y.novelId) === e.novelId && ((A = s.snapshot) == null ? void 0 : A.anchorChapterId) === e.chapterId ? s : await this.contextBuilder.buildForContinueWriting({
      ...e,
      mode: r === "new_chapter" ? "new_chapter" : "continue_chapter",
      recentRawChapterCount: e.recentRawChapterCount ?? this.settingsCache.summary.recentChapterRawCount
    }), o = this.compactContinueHardContext(i.hardContext), c = r === "rewrite_chapter" ? {
      ...i.dynamicContext,
      currentChapterBeforeCursor: pn(e.currentContent || i.currentContentSource)
    } : i.dynamicContext, d = this.compactContinueDynamicContext(c), l = x(e.userIntent, 800), m = x(e.currentLocation, 120), h = e.batchContext && typeof e.batchContext == "object" ? e.batchContext : void 0, p = {
      ...i.params,
      targetLength: t ? `约${Math.max(100, Math.min(4e3, Number(i.params.targetLength || 500)))}汉字` : `about ${Math.max(100, Math.min(4e3, Number(i.params.targetLength || 500)))} Chinese characters`
    }, f = r === "rewrite_chapter" ? t ? "你是中文小说章节改写助手。输出完整替换正文，严格遵守世界观、大纲与跨章连续性。" : "Rewrite the complete fiction chapter with strict consistency to world settings, outline, and cross-chapter continuity." : t ? "你是中文小说续写助手。严格遵守世界观和大纲，不得破坏既有设定与人物行为逻辑。" : "Continue writing with strict consistency to world settings and plot outline. Do not break established lore.", w = [
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

`), g = (C = e.overrideUserPrompt) != null && C.trim() ? e.overrideUserPrompt.trim() : w, u = {
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
      defaultUserPrompt: w,
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
    var v;
    const t = this.resolveCreativeTargetSections(e), r = (e.locale || "zh").startsWith("zh"), s = await S.novel.findUnique({
      where: { id: e.novelId },
      select: { id: !0, title: !0, description: !0 }
    }), a = await this.contextBuilder.buildForCreativeAssets(e), i = r ? "你是一位小说创作助手，擅长根据用户的创意需求和已有小说内容生成结构化的创作素材。请严格以 JSON 格式输出，只输出 JSON，不要添加任何其他文字。所有生成的名称、描述等文本内容必须使用中文。生成的内容应与小说已有的角色、情节、世界观保持一致和关联。" : "You are a novel creation assistant. Generate structured creative assets in strict JSON format based on existing novel content. Output only JSON, no extra text. Generated content should be consistent with existing characters, plot, and world settings.", o = {
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
        title: (s == null ? void 0 : s.title) || "",
        description: (s == null ? void 0 : s.description) || ""
      },
      targetSections: t,
      outputShape: t,
      outputSchema: o,
      constraints: c
    };
    a.existingEntities.characters.length > 0 && (d.existingCharacters = a.existingEntities.characters), a.existingEntities.items.length > 0 && (d.existingItems = a.existingEntities.items), a.existingEntities.plotLines.length > 0 && (d.existingPlotLines = a.existingEntities.plotLines), a.existingEntities.worldSettings.length > 0 && (d.worldSettings = a.existingEntities.worldSettings), a.recentSummaries.length > 0 && (d.recentChapterSummaries = a.recentSummaries), a.narrativeSummaries.length > 0 && (d.narrativeSummary = a.narrativeSummaries[0]);
    const l = JSON.stringify(d), m = (v = e.overrideUserPrompt) != null && v.trim() ? e.overrideUserPrompt.trim() : l, h = [
      `Novel: ${(s == null ? void 0 : s.title) || e.novelId}`,
      ...a.usedContext
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
          estimatedContextTokens: a.estimatedTokens
        },
        constraints: f
      },
      usedContext: h,
      estimatedTokens: a.estimatedTokens
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
    })), s = Io(e.styleTemplate), a = r.length > 0 ? r.map((d, l) => `${l + 1}. ${d.title}: ${d.excerpt}`).join(`
`) : "No explicit world lore provided.", i = [
      s || "Style: follow user requested style.",
      `ImageSize=${e.imageSize || this.settingsCache.http.imageSize || "2K"}`,
      "Task: Generate a clean map background image.",
      `UserRequest=${e.prompt}`,
      "WorldLore:",
      a,
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
    return this.settingsCache.providerType === "mcp-cli" ? new rn(this.settingsCache) : new Kn(this.settingsCache);
  }
  async saveImageAsset(e, t, r) {
    let s = r.mimeType || "image/png", a;
    if (r.imageBase64)
      a = Buffer.from(r.imageBase64, "base64");
    else if (r.imageUrl) {
      const l = await fetch(r.imageUrl);
      if (!l.ok)
        throw new Error(`Image download failed: ${l.status}`);
      const m = l.headers.get("content-type") || "";
      m && (s = m);
      const h = await l.arrayBuffer();
      a = Buffer.from(h);
    } else
      throw new Error("No image data provided");
    if (a.length === 0)
      throw new Error("Image data is empty");
    if (a.length > hr)
      throw new Error("Image exceeds maximum size limit");
    if (!s.startsWith("image/"))
      throw new Error(`Invalid mime type: ${s}`);
    const i = go(s), o = k.join(this.userDataPath, "maps", e);
    re.existsSync(o) || re.mkdirSync(o, { recursive: !0 });
    const c = vo(`ai-${t}-${Date.now()}.${i}`), d = k.join(o, c);
    return re.writeFileSync(d, a), {
      relativePath: `maps/${e}/${c}`,
      absolutePath: d
    };
  }
  loadSettings() {
    try {
      if (!re.existsSync(this.settingsFilePath))
        return tt;
      const e = re.readFileSync(this.settingsFilePath, "utf8"), t = JSON.parse(e);
      return {
        ...tt,
        ...t,
        http: { ...tt.http, ...t.http ?? {} },
        mcpCli: { ...tt.mcpCli, ...t.mcpCli ?? {} },
        proxy: { ...tt.proxy, ...t.proxy ?? {} },
        summary: { ...tt.summary, ...t.summary ?? {} },
        embedding: { ...tt.embedding, ...t.embedding ?? {} }
      };
    } catch (e) {
      return console.error("[AI] Failed to load settings, fallback to defaults:", e), tt;
    }
  }
  persistSettings() {
    try {
      const e = k.dirname(this.settingsFilePath);
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
      const e = k.dirname(this.mapImageStatsPath);
      re.existsSync(e) || re.mkdirSync(e, { recursive: !0 }), re.writeFileSync(this.mapImageStatsPath, JSON.stringify(this.mapImageStatsCache, null, 2), "utf8");
    } catch (e) {
      console.warn("[AI] Failed to persist map image stats:", e);
    }
  }
  recordMapImageCall(e) {
    const t = (e.code || "").toLowerCase(), r = (e.detail || "").toLowerCase(), s = t.includes("rate") || t.includes("429") || r.includes("429") || r.includes("rate limit") || r.includes("quota");
    this.mapImageStatsCache = {
      ...this.mapImageStatsCache,
      totalCalls: this.mapImageStatsCache.totalCalls + 1,
      successCalls: this.mapImageStatsCache.successCalls + (e.ok ? 1 : 0),
      failedCalls: this.mapImageStatsCache.failedCalls + (e.ok ? 0 : 1),
      rateLimitFailures: this.mapImageStatsCache.rateLimitFailures + (!e.ok && s ? 1 : 0),
      lastFailureCode: e.ok ? this.mapImageStatsCache.lastFailureCode : e.code || "UNKNOWN",
      lastFailureAt: e.ok ? this.mapImageStatsCache.lastFailureAt : (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }, this.persistMapImageStats();
  }
}
const pr = {
  sessions: [],
  batches: []
};
function $(n, e) {
  return Object.assign(new Error(e), { code: n });
}
function Ao(n, e) {
  const t = String((n == null ? void 0 : n.title) ?? "").trim(), r = String((n == null ? void 0 : n.chapterGoal) ?? "").trim(), s = String((n == null ? void 0 : n.coreConflict) ?? "").trim(), a = String((n == null ? void 0 : n.endingHook) ?? "").trim(), i = Number(n == null ? void 0 : n.targetWordCount);
  if (!t || !r || !s || !a)
    throw $("INVALID_INPUT", `Chapter beat ${e + 1} is incomplete`);
  if (!Number.isInteger(i) || i < 100 || i > 5e4)
    throw $("INVALID_INPUT", `Chapter beat ${e + 1} targetWordCount must be between 100 and 50000`);
  return {
    beatId: fe(),
    childIndex: e,
    title: t,
    chapterGoal: r,
    coreConflict: s,
    keyEvents: Array.isArray(n.keyEvents) ? n.keyEvents.map(String).map((o) => o.trim()).filter(Boolean) : [],
    reveals: Array.isArray(n.reveals) ? n.reveals.map(String).map((o) => o.trim()).filter(Boolean) : [],
    endingHook: a,
    targetWordCount: i
  };
}
function vn(n) {
  if (!Array.isArray(n) || n.length < 1 || n.length > 5)
    throw $("INVALID_INPUT", "A chapter draft batch must contain between 1 and 5 beats");
  return n.map(Ao);
}
function Eo() {
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
function In(n, e, t, r, s = 1) {
  if (!r)
    return n;
  const a = r.coreConflict.trim(), i = {
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
    unresolvedConflicts: a && !n.unresolvedConflicts.includes(a) ? [...n.unresolvedConflicts, a] : n.unresolvedConflicts,
    stateDeltas: n.stateDeltas ?? []
  };
  return r.stateDelta ? us(i, r.stateDelta, { childIndex: e, draftSessionId: t, generationRevision: s }) : i;
}
function us(n, e, t) {
  const r = { ...n.characterLocations };
  for (const d of e.characterLocations)
    r[d.characterKey] = d.location;
  const s = Object.fromEntries(
    Object.entries(n.knowledgeState).map(([d, l]) => [d, [...l]])
  );
  for (const d of e.knowledgeChanges) {
    const l = new Set(s[d.characterKey] ?? []);
    for (const m of d.forgotten)
      l.delete(m);
    for (const m of d.learned)
      l.add(m);
    s[d.characterKey] = [...l];
  }
  const a = { ...n.itemStates };
  for (const d of e.itemStates)
    a[d.itemKey] = d.state;
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
    knowledgeState: s,
    itemStates: a,
    unresolvedConflicts: o,
    stateDeltas: c
  };
}
function yn(n, e) {
  const t = (a) => typeof a.childIndex != "number" || a.childIndex < e, r = (n.stateLedger.stateDeltas ?? []).filter((a) => a.childIndex < e);
  let s = {
    ...n.stateLedger,
    characterLocations: {},
    relationshipChanges: n.stateLedger.relationshipChanges.filter((a) => a.source !== "state_extraction" && t(a)),
    knowledgeState: {},
    foreshadowing: n.stateLedger.foreshadowing.filter(t),
    timeline: n.stateLedger.timeline.filter(t),
    itemStates: {},
    unresolvedConflicts: n.outline.beats.filter((a) => a.childIndex < e).map((a) => a.coreConflict.trim()).filter(Boolean),
    stateDeltas: []
  };
  for (const a of r)
    s = us(s, a, {
      childIndex: a.childIndex,
      draftSessionId: a.draftSessionId,
      generationRevision: a.generationRevision
    });
  return s;
}
class Co {
  constructor(e) {
    H(this, "getUserDataPath");
    H(this, "cache", null);
    this.getUserDataPath = e;
  }
  getStoreDir() {
    return k.join(this.getUserDataPath(), "automation");
  }
  getStorePath() {
    return k.join(this.getStoreDir(), "draft-sessions.json");
  }
  async ensureLoaded() {
    if (this.cache)
      return;
    const e = this.getStorePath();
    try {
      const t = await Ve.readFile(e, "utf8"), r = JSON.parse(t);
      this.cache = {
        sessions: Array.isArray(r.sessions) ? r.sessions : [],
        batches: Array.isArray(r.batches) ? r.batches : []
      };
    } catch (t) {
      if ((t == null ? void 0 : t.code) !== "ENOENT")
        throw t;
      this.cache = {
        sessions: [...pr.sessions],
        batches: [...pr.batches]
      };
    }
  }
  async flush() {
    await Ve.mkdir(this.getStoreDir(), { recursive: !0 }), await Ve.writeFile(this.getStorePath(), JSON.stringify(this.cache ?? pr, null, 2), "utf8");
  }
  createSessionRecord(e) {
    const t = (/* @__PURE__ */ new Date()).toISOString();
    return {
      ...e,
      draftSessionId: fe(),
      version: 1,
      createdAt: t,
      updatedAt: t
    };
  }
  async list(e) {
    var t;
    return await this.ensureLoaded(), [...((t = this.cache) == null ? void 0 : t.sessions) ?? []].filter((r) => !(e != null && e.novelId && r.novelId !== e.novelId || e != null && e.draftBatchId && r.draftBatchId !== e.draftBatchId || !(e != null && e.draftBatchId) && !(e != null && e.includeBatchChildren) && r.draftBatchId || e != null && e.workspace && r.workspace !== e.workspace || e != null && e.type && r.type !== e.type || e != null && e.status && r.status !== e.status || !(e != null && e.includeInactive) && r.status !== "draft")).sort((r, s) => s.updatedAt.localeCompare(r.updatedAt));
  }
  async getById(e) {
    var t;
    return await this.ensureLoaded(), ((t = this.cache) == null ? void 0 : t.sessions.find((r) => r.draftSessionId === e)) ?? null;
  }
  async getLatest(e) {
    return (await this.list(e))[0] ?? null;
  }
  async create(e) {
    var a, i;
    await this.ensureLoaded();
    const t = this.createSessionRecord(e), r = ((a = this.cache) == null ? void 0 : a.sessions) ?? [], s = e.draftBatchId ? r : r.map((o) => !o.draftBatchId && o.novelId === t.novelId && o.workspace === t.workspace && o.type === t.type && o.status === "draft" ? {
      ...o,
      status: "stale",
      version: o.version + 1,
      updatedAt: t.createdAt
    } : o);
    return this.cache = {
      sessions: [t, ...s],
      batches: ((i = this.cache) == null ? void 0 : i.batches) ?? []
    }, await this.flush(), t;
  }
  async update(e, t, r) {
    var d;
    await this.ensureLoaded();
    const s = ((d = this.cache) == null ? void 0 : d.sessions) ?? [], a = s.findIndex((l) => l.draftSessionId === e);
    if (a < 0)
      throw $("NOT_FOUND", "Draft session not found");
    const i = s[a];
    if (typeof t == "number" && i.version !== t)
      throw $("VERSION_CONFLICT", "Draft session version conflict");
    const c = {
      ...r(i),
      draftSessionId: i.draftSessionId,
      createdAt: i.createdAt,
      version: i.version + 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return s[a] = c, await this.flush(), c;
  }
  async listBatches(e) {
    var t;
    return await this.ensureLoaded(), [...((t = this.cache) == null ? void 0 : t.batches) ?? []].filter((r) => !(e != null && e.novelId && r.novelId !== e.novelId || e != null && e.volumeId && r.volumeId !== e.volumeId || e != null && e.status && r.status !== e.status || !(e != null && e.includeInactive) && ["committed", "discarded", "failed"].includes(r.status))).sort((r, s) => s.updatedAt.localeCompare(r.updatedAt));
  }
  async getBatchById(e) {
    var t;
    return await this.ensureLoaded(), ((t = this.cache) == null ? void 0 : t.batches.find((r) => r.draftBatchId === e)) ?? null;
  }
  async createBatch(e) {
    var l, m;
    await this.ensureLoaded();
    const t = String((e == null ? void 0 : e.novelId) ?? "").trim(), r = String((e == null ? void 0 : e.volumeId) ?? "").trim(), s = String((e == null ? void 0 : e.anchorChapterId) ?? "").trim();
    if (!t || !r || !s)
      throw $("INVALID_INPUT", "novelId, volumeId and anchorChapterId are required");
    if (e.mode !== "sequence_continuation" && e.mode !== "batch_rewrite")
      throw $("INVALID_INPUT", "Unsupported draft batch mode");
    const a = vn(e.beats), i = Array.isArray(e.targetChapterIds) ? e.targetChapterIds.map((h) => String(h || "").trim()).filter(Boolean) : [];
    if (e.mode === "batch_rewrite" && i.length !== a.length)
      throw $("INVALID_INPUT", "batch_rewrite requires one targetChapterId per beat");
    if (e.mode === "batch_rewrite" && new Set(i).size !== i.length)
      throw $("INVALID_INPUT", "batch_rewrite targetChapterIds must be unique");
    const o = Array.isArray(e.sourceSnapshot) ? e.sourceSnapshot : [];
    if (e.mode === "batch_rewrite") {
      const h = new Map(o.map((f) => [f.chapterId, f])), p = i.filter((f) => {
        const v = h.get(f);
        return !v || !Number.isInteger(v.version) || v.version < 1 || !String(v.contentHash || "").trim();
      });
      if (p.length > 0)
        throw $(
          "INVALID_INPUT",
          `batch_rewrite requires a versioned source snapshot for every target chapter: ${p.join(", ")}`
        );
    }
    const c = (/* @__PURE__ */ new Date()).toISOString(), d = {
      draftBatchId: fe(),
      novelId: t,
      volumeId: r,
      anchorChapterId: s,
      mode: e.mode,
      insertionMode: e.insertionMode,
      status: "outline_draft",
      outline: {
        revision: 1,
        status: "draft",
        beats: a
      },
      children: a.map((h, p) => ({
        childIndex: p,
        title: h.title,
        status: "pending",
        generationRevision: 1,
        targetChapterId: i[p] || void 0,
        dependsOnChildIndex: p > 0 ? p - 1 : void 0
      })),
      stateLedger: Eo(),
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
    const s = ((l = this.cache) == null ? void 0 : l.batches) ?? [], a = s.findIndex((m) => m.draftBatchId === e);
    if (a < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const i = s[a];
    if (i.version !== t)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    if (i.children.some((m) => !!m.draftSessionId))
      throw $("INVALID_STATE", "Cannot change chapter beats after draft generation has started");
    const o = vn(r);
    if (i.mode === "batch_rewrite" && o.length !== i.children.length)
      throw $("INVALID_INPUT", "A rewrite batch cannot change its target chapter count");
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
    return s[a] = d, await this.flush(), d;
  }
  async approveBatchOutline(e, t, r, s) {
    var l;
    await this.ensureLoaded();
    const a = ((l = this.cache) == null ? void 0 : l.batches) ?? [], i = a.findIndex((m) => m.draftBatchId === e);
    if (i < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const o = a[i];
    if (o.version !== t)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    if (o.outline.revision !== r)
      throw $("VERSION_CONFLICT", "Draft batch outline revision conflict");
    if (o.status !== "outline_draft")
      throw $("INVALID_STATE", "Draft batch outline is not awaiting approval");
    const c = (/* @__PURE__ */ new Date()).toISOString(), d = {
      ...o,
      status: "ready_to_generate",
      outline: {
        ...o.outline,
        status: "approved",
        approvedAt: c,
        approvedBy: s.trim() || "unknown"
      },
      version: o.version + 1,
      updatedAt: c
    };
    return a[i] = d, await this.flush(), d;
  }
  async createBatchChildSession(e, t, r, s, a) {
    var v, w, g, u;
    await this.ensureLoaded();
    const i = ((v = this.cache) == null ? void 0 : v.batches) ?? [], o = i.findIndex((I) => I.draftBatchId === e);
    if (o < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const c = i[o];
    if (!["ready_to_generate", "generating"].includes(c.status))
      throw $("INVALID_STATE", "Draft batch is not ready to generate");
    const d = c.children[t];
    if (!d || d.childIndex !== t)
      throw $("NOT_FOUND", "Draft batch child not found");
    if (d.draftSessionId)
      throw $("INVALID_STATE", "Draft batch child already has a draft session");
    if (typeof a == "number" && d.generationRevision !== a)
      throw $("VERSION_CONFLICT", "Draft batch child generation revision conflict");
    if (t > 0 && !["draft", "committed"].includes(((w = c.children[t - 1]) == null ? void 0 : w.status) ?? ""))
      throw $("INVALID_STATE", "The previous chapter draft must complete first");
    const l = t > 0 ? (g = c.children[t - 1]) == null ? void 0 : g.draftSessionId : void 0, m = this.createSessionRecord({
      ...r,
      novelId: c.novelId,
      draftBatchId: e,
      childIndex: t,
      generationRevision: d.generationRevision,
      dependsOnDraftSessionId: l,
      status: "draft"
    }), h = c.children.map((I) => I.childIndex === t ? { ...I, status: "draft", draftSessionId: m.draftSessionId } : I), p = h.every((I) => I.status === "draft" || I.status === "committed"), f = {
      ...c,
      status: p ? "ready_for_review" : "generating",
      children: h,
      stateLedger: In(
        c.stateLedger,
        t,
        m.draftSessionId,
        s,
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
  async prepareBatchRegeneration(e, t, r, s) {
    var A, C;
    await this.ensureLoaded();
    const a = ((A = this.cache) == null ? void 0 : A.batches) ?? [], i = a.findIndex((E) => E.draftBatchId === e);
    if (i < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const o = a[i];
    if (o.version !== t)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    if (o.status === "committed" || o.status === "discarded")
      throw $("INVALID_STATE", `Cannot regenerate a ${o.status} draft batch`);
    const c = o.children.findIndex((E) => E.status === "stale" || E.status === "failed" || E.status === "pending" || E.status === "generating"), d = r ?? c;
    if (!Number.isInteger(d) || d < 0 || d >= o.children.length)
      throw $(
        "INVALID_INPUT",
        "fromChildIndex is required when the batch has no failed, stale or pending child"
      );
    if (o.children.slice(d).some((E) => E.status === "committed"))
      throw $("INVALID_STATE", "Committed batch children cannot be regenerated");
    const l = o.children.slice(0, d).find((E) => E.status !== "draft" && E.status !== "committed");
    if (l)
      throw $(
        "INVALID_STATE",
        `Draft batch child ${l.childIndex + 1} must be resolved before regenerating a later child`
      );
    const m = o.children.slice(d).find((E) => {
      var T;
      return (T = E.error) == null ? void 0 : T.sideEffectUnknown;
    });
    if (m)
      throw $(
        "SIDE_EFFECT_UNKNOWN",
        `Draft batch child ${m.childIndex + 1} has an unknown generation result and must be reconciled first`
      );
    const h = new Set(
      o.children.slice(d).flatMap((E) => E.draftSessionId ? [E.draftSessionId] : [])
    ), p = ((C = this.cache) == null ? void 0 : C.sessions) ?? [], f = new Map(p.map((E) => [E.draftSessionId, E])), v = o.children.slice(0, d).flatMap((E) => E.draftSessionId ? [f.get(E.draftSessionId)] : []).filter((E) => !!E);
    if (v.length !== d)
      throw $("INVALID_STATE", "Preserved draft prefix is missing one or more DraftSessions");
    const w = (/* @__PURE__ */ new Date()).toISOString(), g = p.map((E) => !h.has(E.draftSessionId) || E.status === "stale" ? E : {
      ...E,
      status: "stale",
      version: E.version + 1,
      updatedAt: w
    }), u = o.children.map((E) => E.childIndex < d ? E : {
      ...E,
      status: "pending",
      generationRevision: E.generationRevision + 1,
      draftSessionId: void 0,
      error: void 0,
      reconciliation: void 0
    }), I = s && !o.linkedRunIds.includes(s) ? [...o.linkedRunIds, s] : o.linkedRunIds, y = {
      ...o,
      status: "ready_to_generate",
      children: u,
      stateLedger: yn(o, d),
      linkedRunIds: I,
      version: o.version + 1,
      updatedAt: w
    };
    return a[i] = y, this.cache = { sessions: g, batches: a }, await this.flush(), { batch: y, fromChildIndex: d, preservedDrafts: v };
  }
  async markBatchChildFailed(e) {
    var l, m, h, p, f, v, w;
    await this.ensureLoaded();
    const t = ((l = this.cache) == null ? void 0 : l.batches) ?? [], r = t.findIndex((g) => g.draftBatchId === e.draftBatchId);
    if (r < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const s = t[r];
    if (s.version !== e.version)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    const a = s.children[e.childIndex];
    if (!a || a.childIndex !== e.childIndex)
      throw $("NOT_FOUND", "Draft batch child not found");
    if (a.generationRevision !== e.generationRevision)
      throw $("VERSION_CONFLICT", "Draft batch child generation revision conflict");
    if (a.draftSessionId || a.status === "committed" || a.status === "discarded")
      throw $("INVALID_STATE", "Draft batch child already has a terminal result");
    const i = {
      code: String(((m = e.error) == null ? void 0 : m.code) || "GENERATION_FAILED"),
      message: String(((h = e.error) == null ? void 0 : h.message) || "Draft generation failed"),
      ...(p = e.error) != null && p.sideEffectUnknown ? { sideEffectUnknown: !0 } : {},
      ...(f = e.error) != null && f.invocationKey ? { invocationKey: String(e.error.invocationKey) } : {},
      ...(v = e.error) != null && v.requestId ? { requestId: String(e.error.requestId) } : {},
      ...(w = e.error) != null && w.method ? { method: String(e.error.method) } : {}
    }, o = s.children.map((g) => g.childIndex === e.childIndex ? {
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
      ...s,
      status: o.slice(0, e.childIndex).some((g) => g.status === "draft" || g.status === "committed") ? "partially_failed" : "failed",
      children: o,
      version: s.version + 1,
      updatedAt: c
    };
    return t[r] = d, await this.flush(), d;
  }
  async inspectBatchReconciliation(e) {
    var a, i;
    await this.ensureLoaded();
    const t = (((a = this.cache) == null ? void 0 : a.batches) ?? []).find((o) => o.draftBatchId === e.draftBatchId);
    if (!t)
      throw $("NOT_FOUND", "Draft batch not found");
    const r = t.children[e.childIndex];
    if (!r || r.childIndex !== e.childIndex)
      throw $("NOT_FOUND", "Draft batch child not found");
    if (r.generationRevision !== e.generationRevision)
      throw $("VERSION_CONFLICT", "Draft batch child generation revision conflict");
    const s = (((i = this.cache) == null ? void 0 : i.sessions) ?? []).filter((o) => o.draftBatchId === t.draftBatchId && o.childIndex === r.childIndex && o.generationRevision === r.generationRevision && o.type === "chapter-draft" && o.status === "draft").map((o) => ({
      draftSessionId: o.draftSessionId,
      draftBatchId: t.draftBatchId,
      childIndex: r.childIndex,
      generationRevision: r.generationRevision,
      status: o.status,
      previewSummary: o.previewSummary,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt
    }));
    return { batch: t, child: r, candidates: s };
  }
  async reconcileBatchUnknown(e) {
    var I, y, A, C, E, T, R, M, J;
    await this.ensureLoaded();
    const t = ((I = this.cache) == null ? void 0 : I.batches) ?? [], r = t.findIndex((F) => F.draftBatchId === e.draftBatchId);
    if (r < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const s = t[r], a = s.children[e.childIndex];
    if (!a || a.childIndex !== e.childIndex)
      throw $("NOT_FOUND", "Draft batch child not found");
    if (((y = a.reconciliation) == null ? void 0 : y.resolution) === e.resolution && a.reconciliation.invocationKey === e.invocationKey)
      return s;
    if (s.version !== e.version)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    if (a.generationRevision !== e.generationRevision)
      throw $("VERSION_CONFLICT", "Draft batch child generation revision conflict");
    if (!e.confirmation)
      throw $("CONFIRMATION_REQUIRED", "Explicit reconciliation confirmation is required");
    if (!((A = a.error) != null && A.sideEffectUnknown) || a.status !== "failed")
      throw $("INVALID_STATE", "Draft batch child is not awaiting side-effect reconciliation");
    const i = ((C = a.reconciliation) == null ? void 0 : C.invocationKey) || a.error.invocationKey;
    if (!i || i !== e.invocationKey)
      throw $("VERSION_CONFLICT", "Invocation key does not match the unknown batch child");
    const o = (/* @__PURE__ */ new Date()).toISOString();
    let c;
    if (e.resolution === "reconciled_succeeded") {
      const F = String(e.candidateDraftSessionId || "").trim();
      if (!F)
        throw $("INVALID_INPUT", "candidateDraftSessionId is required");
      if (c = (((E = this.cache) == null ? void 0 : E.sessions) ?? []).find((L) => L.draftSessionId === F && L.draftBatchId === s.draftBatchId && L.childIndex === a.childIndex && L.generationRevision === a.generationRevision && L.type === "chapter-draft" && L.status === "draft"), !c)
        throw $("CANDIDATE_NOT_FOUND", "No matching draft candidate was found");
      if (s.children.some((L) => L.childIndex !== a.childIndex && L.draftSessionId === (c == null ? void 0 : c.draftSessionId)))
        throw $("INVALID_STATE", "Draft candidate is already attached to another child");
    } else if (e.resolution !== "reconciled_absent")
      throw $("INVALID_INPUT", `Unsupported reconciliation resolution: ${String(e.resolution)}`);
    const d = {
      resolution: e.resolution,
      invocationKey: e.invocationKey,
      ...(T = a.reconciliation) != null && T.requestId || a.error.requestId ? {
        requestId: ((R = a.reconciliation) == null ? void 0 : R.requestId) || a.error.requestId
      } : {},
      method: ((M = a.reconciliation) == null ? void 0 : M.method) || a.error.method || "chapter.generate_draft",
      ...c ? { candidateDraftSessionId: c.draftSessionId } : {},
      ...(J = e.note) != null && J.trim() ? { note: e.note.trim() } : {},
      reconciledAt: o
    }, l = s.children.map((F) => F.childIndex !== a.childIndex ? F : c ? {
      ...F,
      status: "draft",
      draftSessionId: c.draftSessionId,
      error: void 0,
      reconciliation: d
    } : {
      ...F,
      status: "failed",
      error: {
        code: "RECONCILED_ABSENT",
        message: "用户已确认没有可用草稿，可以重新生成。"
      },
      reconciliation: d
    }), m = l.every((F) => F.status === "draft" || F.status === "committed"), h = l.some((F) => F.status === "failed"), p = l.some((F) => F.status === "draft" || F.status === "committed"), f = m ? "ready_for_review" : h ? p ? "partially_failed" : "failed" : "generating", v = s.outline.beats[a.childIndex], w = c != null && c.payload && typeof c.payload == "object" ? c.payload : {}, g = w.narrativeStateDelta && typeof w.narrativeStateDelta == "object" ? w.narrativeStateDelta : void 0, u = {
      ...s,
      status: f,
      children: l,
      stateLedger: c && v ? In(s.stateLedger, a.childIndex, c.draftSessionId, {
        title: v.title,
        coreConflict: v.coreConflict,
        keyEvents: v.keyEvents,
        reveals: v.reveals,
        endingHook: v.endingHook,
        summary: c.previewSummary,
        stateDelta: g
      }, c.generationRevision) : s.stateLedger,
      version: s.version + 1,
      updatedAt: o
    };
    return t[r] = u, await this.flush(), u;
  }
  async markBatchChildrenStale(e, t, r) {
    var h, p;
    await this.ensureLoaded();
    const s = ((h = this.cache) == null ? void 0 : h.batches) ?? [], a = s.findIndex((f) => f.draftBatchId === e);
    if (a < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const i = s[a];
    if (i.version !== t)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    if (!Number.isInteger(r) || r < 0 || r >= i.children.length)
      throw $("INVALID_INPUT", "afterChildIndex is outside the draft batch");
    const o = /* @__PURE__ */ new Set(), c = i.children.map((f) => f.childIndex <= r || ["committed", "discarded"].includes(f.status) ? f : (f.draftSessionId && o.add(f.draftSessionId), { ...f, status: "stale" })), d = (/* @__PURE__ */ new Date()).toISOString(), l = (((p = this.cache) == null ? void 0 : p.sessions) ?? []).map((f) => o.has(f.draftSessionId) ? { ...f, status: "stale", version: f.version + 1, updatedAt: d } : f), m = {
      ...i,
      status: "stale",
      children: c,
      stateLedger: yn(i, r),
      version: i.version + 1,
      updatedAt: d
    };
    return s[a] = m, this.cache = { sessions: l, batches: s }, await this.flush(), m;
  }
  async commitBatchPrefix(e, t, r, s, a, i) {
    var A, C;
    await this.ensureLoaded();
    const o = ((A = this.cache) == null ? void 0 : A.batches) ?? [], c = o.findIndex((E) => E.draftBatchId === e);
    if (c < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const d = o[c];
    if (d.version !== t)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    if (!Number.isInteger(r) || r < 1 || r > d.children.length)
      throw $("INVALID_INPUT", "prefixLength is outside the draft batch");
    const l = d.children.findIndex((E) => E.status !== "committed"), m = l < 0 ? d.children.length : l;
    if (d.children.slice(m).some((E) => E.status === "committed"))
      throw $("INVALID_STATE", "Draft batch contains a non-contiguous committed child");
    if (r <= m)
      throw $("INVALID_STATE", "Requested prefix is already committed");
    const h = Array.from(
      { length: r - m },
      (E, T) => m + T
    );
    if (a.length !== h.length || a.some((E, T) => E.childIndex !== h[T]))
      throw $("INVALID_INPUT", "Committed chapter mapping does not match the requested prefix");
    if (d.mode === "batch_rewrite" && (!i || i.mode !== "batch_rewrite"))
      throw $("INVALID_INPUT", "Rewrite commits require a reversible writeback record");
    const p = ((C = this.cache) == null ? void 0 : C.sessions) ?? [], f = new Map(p.map((E) => [E.draftSessionId, E])), v = new Map(a.map((E) => [E.childIndex, E]));
    for (const E of h) {
      const T = d.children[E], R = T != null && T.draftSessionId ? f.get(T.draftSessionId) : void 0;
      if (!T || T.status !== "draft" || !R || R.status !== "draft")
        throw $("INVALID_STATE", `Draft batch child ${E + 1} is not ready to commit`);
      if (R.draftBatchId !== e || R.childIndex !== E)
        throw $("INVALID_STATE", `Draft batch child ${E + 1} session linkage is invalid`);
    }
    const w = (/* @__PURE__ */ new Date()).toISOString(), g = p.map((E) => {
      const T = typeof E.childIndex == "number" ? v.get(E.childIndex) : void 0;
      return E.draftBatchId !== e || !T ? E : {
        ...E,
        chapterId: T.chapterId,
        status: "committed",
        payload: {
          ...E.payload,
          chapterId: T.chapterId,
          content: T.content
        },
        version: E.version + 1,
        updatedAt: w
      };
    }), u = d.children.map((E) => {
      const T = v.get(E.childIndex);
      return T ? { ...E, status: "committed", targetChapterId: T.chapterId } : E;
    }), I = u.every((E) => E.status === "committed"), y = {
      ...d,
      insertionMode: s,
      status: I ? "committed" : u.some((E) => E.status === "failed") ? "partially_failed" : u.some((E) => E.status === "stale") ? "stale" : "ready_for_review",
      children: u,
      writebacks: i ? [...d.writebacks ?? [], i] : d.writebacks,
      version: d.version + 1,
      updatedAt: w
    };
    return o[c] = y, this.cache = { sessions: g, batches: o }, await this.flush(), {
      batch: y,
      sessions: g.filter((E) => E.draftBatchId === e && typeof E.childIndex == "number" && E.childIndex < r).sort((E, T) => (E.childIndex ?? 0) - (T.childIndex ?? 0))
    };
  }
  async undoBatchWriteback(e, t, r, s) {
    var u, I;
    await this.ensureLoaded();
    const a = ((u = this.cache) == null ? void 0 : u.batches) ?? [], i = a.findIndex((y) => y.draftBatchId === e);
    if (i < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const o = a[i];
    if (o.version !== t)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    const c = [...o.writebacks ?? []].reverse().find((y) => y.status === "committed");
    if (!c || c.writebackId !== r)
      throw $("INVALID_STATE", "Only the latest writeback can be undone");
    const d = new Map(s.map((y) => [y.childIndex, y]));
    if (s.length !== c.chapters.length || c.chapters.some((y) => {
      var A;
      return typeof y.childIndex != "number" || ((A = d.get(y.childIndex)) == null ? void 0 : A.chapterId) !== y.chapterId;
    }))
      throw $("INVALID_INPUT", "Restored chapter mapping does not match the writeback");
    const l = (/* @__PURE__ */ new Date()).toISOString(), m = new Set(s.map((y) => y.childIndex)), h = o.children.map((y) => m.has(y.childIndex) ? { ...y, status: "draft" } : y), p = (((I = this.cache) == null ? void 0 : I.sessions) ?? []).map((y) => y.draftBatchId === e && typeof y.childIndex == "number" && m.has(y.childIndex) ? {
      ...y,
      status: "draft",
      version: y.version + 1,
      updatedAt: l
    } : y), f = new Map(s.map((y) => [y.chapterId, y])), v = o.sourceSnapshot.map((y) => {
      const A = f.get(y.chapterId);
      return A ? {
        chapterId: A.chapterId,
        version: A.version,
        contentHash: Ne("sha256").update(A.content || "", "utf8").digest("hex")
      } : y;
    }), w = {
      ...c,
      status: "undone",
      undoneAt: l
    }, g = {
      ...o,
      status: h.every((y) => y.status === "committed") ? "committed" : "ready_for_review",
      children: h,
      sourceSnapshot: v,
      writebacks: (o.writebacks ?? []).map((y) => y.writebackId === r ? w : y),
      version: o.version + 1,
      updatedAt: l
    };
    return a[i] = g, this.cache = { sessions: p, batches: a }, await this.flush(), {
      batch: g,
      sessions: p.filter((y) => y.draftBatchId === e),
      writeback: w
    };
  }
  async discardBatch(e, t) {
    var l, m;
    await this.ensureLoaded();
    const r = ((l = this.cache) == null ? void 0 : l.batches) ?? [], s = r.findIndex((h) => h.draftBatchId === e);
    if (s < 0)
      throw $("NOT_FOUND", "Draft batch not found");
    const a = r[s];
    if (a.version !== t)
      throw $("VERSION_CONFLICT", "Draft batch version conflict");
    if (a.status === "committed")
      throw $("INVALID_STATE", "A committed draft batch cannot be discarded");
    const i = new Set(a.children.flatMap((h) => h.draftSessionId ? [h.draftSessionId] : [])), o = (/* @__PURE__ */ new Date()).toISOString(), c = (((m = this.cache) == null ? void 0 : m.sessions) ?? []).map((h) => i.has(h.draftSessionId) ? { ...h, status: "discarded", version: h.version + 1, updatedAt: o } : h), d = {
      ...a,
      status: "discarded",
      children: a.children.map((h) => ({ ...h, status: "discarded" })),
      version: a.version + 1,
      updatedAt: o
    };
    return r[s] = d, this.cache = { sessions: c, batches: r }, await this.flush(), d;
  }
}
const To = { comments: [] };
function We(n, e) {
  return Object.assign(new Error(e), { code: n });
}
function it(n, e) {
  const t = String(n ?? "").trim();
  if (!t)
    throw We("INVALID_INPUT", `${e} is required`);
  return t;
}
class bo {
  constructor(e) {
    H(this, "getUserDataPath");
    H(this, "cache", null);
    H(this, "mutationTail", Promise.resolve());
    this.getUserDataPath = e;
  }
  getStoreDir() {
    return k.join(this.getUserDataPath(), "automation");
  }
  getStorePath() {
    return k.join(this.getStoreDir(), "review-comments.json");
  }
  async ensureLoaded() {
    if (!this.cache)
      try {
        const e = JSON.parse(await Ve.readFile(this.getStorePath(), "utf8"));
        this.cache = { comments: Array.isArray(e.comments) ? e.comments : [] };
      } catch (e) {
        if ((e == null ? void 0 : e.code) !== "ENOENT")
          throw e;
        this.cache = { comments: [] };
      }
  }
  async flush() {
    await Ve.mkdir(this.getStoreDir(), { recursive: !0 });
    const e = this.getStorePath(), t = `${e}.${process.pid}.tmp`;
    await Ve.writeFile(t, JSON.stringify(this.cache ?? To, null, 2), "utf8"), await Ve.rename(t, e);
  }
  async mutate(e) {
    const t = this.mutationTail;
    let r;
    this.mutationTail = new Promise((s) => {
      r = s;
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
      ((e == null ? void 0 : e.reviewVersionIds) ?? []).map((s) => String(s || "").trim()).filter(Boolean)
    );
    return [...((r = this.cache) == null ? void 0 : r.comments) ?? []].filter((s) => !(e != null && e.novelId && s.novelId !== e.novelId || e != null && e.sourceConversationId && s.sourceConversationId !== e.sourceConversationId || e != null && e.reviewVersionId && s.reviewVersionId !== e.reviewVersionId || t.size && !t.has(s.reviewVersionId) || e != null && e.status && s.status !== e.status)).sort((s, a) => s.createdAt.localeCompare(a.createdAt));
  }
  async save(e) {
    return this.mutate(async () => {
      var f, v;
      const t = it(e == null ? void 0 : e.novelId, "novelId"), r = it(e == null ? void 0 : e.sourceConversationId, "sourceConversationId"), s = it(e == null ? void 0 : e.sourceRunId, "sourceRunId"), a = it(e == null ? void 0 : e.reviewVersionId, "reviewVersionId"), i = it(e == null ? void 0 : e.body, "body"), o = it((f = e == null ? void 0 : e.anchor) == null ? void 0 : f.targetId, "anchor.targetId");
      if (i.length > 4e3)
        throw We("INVALID_INPUT", "Review comment must not exceed 4000 characters");
      const c = (/* @__PURE__ */ new Date()).toISOString(), d = ((v = this.cache) == null ? void 0 : v.comments) ?? [], l = String((e == null ? void 0 : e.commentId) || "").trim(), m = l ? d.findIndex((w) => w.commentId === l) : -1;
      if (l && m < 0)
        throw We("NOT_FOUND", "Review comment not found");
      const h = m >= 0 ? d[m] : null;
      if (h && h.status === "superseded")
        throw We("INVALID_STATE", "Superseded review comments cannot be edited");
      if (h && h.reviewVersionId !== a)
        throw We("VERSION_CONFLICT", "Review comment belongs to another review version");
      const p = {
        commentId: (h == null ? void 0 : h.commentId) ?? fe(),
        novelId: t,
        sourceConversationId: r,
        sourceRunId: s,
        ...e.sourceArtifactId ? { sourceArtifactId: String(e.sourceArtifactId) } : {},
        reviewVersionId: a,
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
      var a;
      const t = it(e, "commentId"), r = ((a = this.cache) == null ? void 0 : a.comments) ?? [], s = r.filter((i) => i.commentId !== t);
      if (s.length === r.length)
        throw We("NOT_FOUND", "Review comment not found");
      return this.cache = { comments: s }, await this.flush(), { commentId: t };
    });
  }
  async markSent(e) {
    return this.mutate(async () => {
      var c;
      if (!["discuss", "regenerate"].includes(e == null ? void 0 : e.mode))
        throw We("INVALID_INPUT", "mode must be discuss or regenerate");
      const t = new Set(((e == null ? void 0 : e.commentIds) ?? []).map((d) => String(d || "").trim()).filter(Boolean));
      if (!t.size)
        throw We("INVALID_INPUT", "commentIds is required");
      const r = ((c = this.cache) == null ? void 0 : c.comments) ?? [], s = r.filter((d) => t.has(d.commentId));
      if (s.length !== t.size)
        throw We("NOT_FOUND", "One or more review comments were not found");
      if (new Set(s.map((d) => `${d.novelId}:${d.sourceConversationId}`)).size !== 1)
        throw We("INVALID_INPUT", "Review comments must belong to one source conversation");
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
function No(n) {
  if (!n.startsWith("{"))
    return -1;
  let e = 0, t = !1, r = !1;
  for (let s = 0; s < n.length; s += 1) {
    const a = n[s];
    if (t) {
      r ? r = !1 : a === "\\" ? r = !0 : a === '"' && (t = !1);
      continue;
    }
    if (a === '"')
      t = !0;
    else if (a === "{")
      e += 1;
    else if (a === "}" && (e -= 1, e === 0))
      return s + 1;
  }
  return -1;
}
function Ur(n) {
  const e = n.trim(), t = No(e);
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
function hs(n) {
  if (n.type === "linebreak")
    return `
`;
  if (typeof n.text == "string")
    return n.text;
  if (!Array.isArray(n.children))
    return "";
  const e = n.children.map(hs).join("");
  return ["paragraph", "heading", "quote", "listitem"].includes(n.type ?? "") ? `${e}
` : e;
}
function gt(n) {
  return n.replace(/[ \t]+\n/g, `
`).replace(/\n[ \t]+/g, `
`).replace(/\n{3,}/g, `

`).trim();
}
function gr(n) {
  if (!(n != null && n.trim()))
    return "";
  const { document: e, trailingText: t } = Ur(n);
  return e ? [gt(hs(e.root)), gt(t)].filter(Boolean).join(`

`) : gt(t);
}
function xo(n) {
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
function _o(n) {
  const e = n.split(`
`), t = [];
  return e.forEach((r, s) => {
    r && t.push(xo(r)), s < e.length - 1 && t.push({ type: "linebreak", version: 1 });
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
function Nr(n) {
  return gt(n).split(/\n{2,}/).filter(Boolean).map(_o);
}
function Jt(n, e) {
  const t = gt(e), { document: r, trailingText: s } = Ur(n);
  if (!r)
    return [gt(n), t].filter(Boolean).join(`

`);
  const a = JSON.parse(JSON.stringify(r));
  return Array.isArray(a.root.children) || (a.root.children = []), a.root.children.push(...Nr(s), ...Nr(t)), JSON.stringify(a);
}
function ms(n) {
  const e = {
    root: {
      children: Nr(n),
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1
    }
  };
  return JSON.stringify(e);
}
function Ro(n) {
  const { document: e, trailingText: t } = Ur(n);
  return e ? t ? Jt(JSON.stringify(e), t) : JSON.stringify(e) : ms(t);
}
function Re(n, e, t) {
  return Object.assign(new Error(e), { code: n, details: t });
}
function xr(n) {
  return Ne("sha256").update(n || "", "utf8").digest("hex");
}
function Do(n) {
  const e = Array.from(
    { length: n.prefixLength - n.committedPrefixLength },
    (t, r) => n.committedPrefixLength + r
  );
  if (e.length < 1 || n.drafts.length !== e.length || n.drafts.some((t, r) => t.childIndex !== e[r]))
    throw Re("INVALID_INPUT", "Draft chapter writes do not match the requested prefix");
}
async function ko(n, e) {
  Do(e);
  const { batch: t } = e;
  return n.$transaction(async (r) => {
    const s = await r.volume.findUnique({
      where: { id: t.volumeId },
      select: { id: !0, novelId: !0 }
    });
    if (!s || s.novelId !== t.novelId)
      throw Re("NOT_FOUND", "Draft batch volume does not belong to the expected novel");
    const a = await r.chapter.findUnique({
      where: { id: t.anchorChapterId },
      select: { id: !0, volumeId: !0, order: !0, deleted: !0 }
    });
    if (!a || a.deleted || a.volumeId !== t.volumeId)
      throw Re("VERSION_CONFLICT", "Draft batch anchor chapter changed or was removed");
    const i = new Set(
      t.children.slice(0, e.committedPrefixLength).map((v) => v.targetChapterId).filter((v) => !!v)
    ), o = t.sourceSnapshot.filter(
      (v) => !i.has(v.chapterId)
    );
    if (o.length > 0) {
      const v = await r.chapter.findMany({
        where: { id: { in: o.map((u) => u.chapterId) } },
        select: { id: !0, version: !0, content: !0, deleted: !0 }
      }), w = new Map(v.map((u) => [u.id, u])), g = o.flatMap((u) => {
        const I = w.get(u.chapterId);
        return !I || I.deleted || I.version !== u.version || xr(I.content) !== u.contentHash ? [{
          chapterId: u.chapterId,
          expectedVersion: u.version,
          actualVersion: I == null ? void 0 : I.version
        }] : [];
      });
      if (g.length > 0)
        throw Re(
          "VERSION_CONFLICT",
          "One or more source chapters changed after draft generation",
          { conflicts: g }
        );
    }
    if (t.mode === "batch_rewrite") {
      const v = e.drafts.map((C) => C.targetChapterId).filter((C) => !!C).filter((C) => !t.sourceSnapshot.some((E) => E.chapterId === C));
      if (v.length > 0 || e.drafts.some((C) => !C.targetChapterId))
        throw Re(
          "INVALID_STATE",
          "Rewrite targets require versioned source snapshots",
          { chapterIds: v }
        );
      const w = e.drafts.map((C) => C.targetChapterId), g = await r.chapter.findMany({
        where: { id: { in: w } },
        select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0, wordCount: !0, version: !0, deleted: !0 }
      }), u = new Map(g.map((C) => [C.id, C]));
      if (g.length !== w.length || g.some((C) => C.deleted || C.volumeId !== t.volumeId))
        throw Re("VERSION_CONFLICT", "One or more rewrite targets changed or were removed");
      let I = 0;
      const y = [], A = [];
      for (const C of e.drafts) {
        const E = C.targetChapterId, T = u.get(E);
        if (!T)
          throw Re("VERSION_CONFLICT", `Rewrite target ${E} is unavailable`);
        const R = await r.chapter.update({
          where: { id: E },
          data: {
            content: C.content,
            wordCount: C.wordCount,
            version: { increment: 1 },
            updatedAt: /* @__PURE__ */ new Date()
          }
        });
        I += C.wordCount - T.wordCount, A.push({
          childIndex: C.childIndex,
          chapterId: R.id,
          volumeId: R.volumeId,
          title: R.title,
          order: R.order,
          beforeContent: T.content,
          beforeWordCount: T.wordCount,
          beforeVersion: T.version,
          afterContentHash: xr(R.content),
          afterVersion: R.version
        }), y.push({
          childIndex: C.childIndex,
          chapterId: R.id,
          volumeId: R.volumeId,
          title: R.title,
          order: R.order,
          version: R.version,
          content: R.content
        });
      }
      return I !== 0 && await r.novel.update({
        where: { id: t.novelId },
        data: { wordCount: { increment: I }, updatedAt: /* @__PURE__ */ new Date() }
      }), {
        chapters: y,
        insertionMode: t.insertionMode ?? e.insertionMode ?? "after_anchor",
        reorderedChapterIds: [],
        writeback: {
          writebackId: fe(),
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
    }), d = c.reduce((v, w) => Math.max(v, w.order), 0);
    if (e.committedPrefixLength === 0 && a.order < d && !e.insertionMode)
      throw Re(
        "INSERTION_MODE_REQUIRED",
        "The anchor is not the final chapter; choose after_anchor or volume_end before committing",
        { anchorChapterId: a.id, anchorOrder: a.order, finalOrder: d }
      );
    let l, m;
    if (e.committedPrefixLength > 0) {
      if (!t.insertionMode)
        throw Re("INVALID_STATE", "Partially committed batch has no fixed insertion mode");
      if (e.insertionMode && e.insertionMode !== t.insertionMode)
        throw Re("VERSION_CONFLICT", "Insertion mode cannot change after the first prefix commit");
      const v = t.children[e.committedPrefixLength - 1], w = v != null && v.targetChapterId ? await r.chapter.findUnique({
        where: { id: v.targetChapterId },
        select: { id: !0, volumeId: !0, order: !0, deleted: !0 }
      }) : null;
      if (!w || w.deleted || w.volumeId !== t.volumeId)
        throw Re("VERSION_CONFLICT", "The previously committed prefix chapter changed or was removed");
      l = t.insertionMode, m = w.order;
    } else
      l = e.insertionMode ?? t.insertionMode ?? "volume_end", m = l === "after_anchor" ? a.order : d;
    await r.chapter.updateMany({
      where: { volumeId: t.volumeId, deleted: !1, order: { gt: m } },
      data: { order: { increment: e.drafts.length }, version: { increment: 1 }, updatedAt: /* @__PURE__ */ new Date() }
    });
    const h = c.filter((v) => v.order > m).map((v) => v.id), p = [];
    let f = 0;
    for (const [v, w] of e.drafts.entries()) {
      const g = await r.chapter.create({
        data: {
          volumeId: t.volumeId,
          title: w.title,
          order: m + v + 1,
          content: w.content,
          wordCount: w.wordCount
        }
      });
      f += w.wordCount, p.push({
        childIndex: w.childIndex,
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
async function Oo(n, e, t) {
  if (e.mode !== "batch_rewrite" || t.mode !== "batch_rewrite" || t.status !== "committed")
    throw Re("INVALID_STATE", "Only an active batch rewrite can be undone");
  if (t.chapters.length < 1 || t.chapters.some((r) => !Number.isInteger(r.childIndex)))
    throw Re("INVALID_STATE", "The writeback record has no restorable chapters");
  return n.$transaction(async (r) => {
    const s = await r.chapter.findMany({
      where: { id: { in: t.chapters.map((d) => d.chapterId) } },
      select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0, wordCount: !0, version: !0, deleted: !0 }
    }), a = new Map(s.map((d) => [d.id, d])), i = t.chapters.flatMap((d) => {
      const l = a.get(d.chapterId);
      return !l || l.deleted || l.volumeId !== d.volumeId || l.version !== d.afterVersion || xr(l.content) !== d.afterContentHash ? [{
        chapterId: d.chapterId,
        expectedVersion: d.afterVersion,
        actualVersion: l == null ? void 0 : l.version
      }] : [];
    });
    if (i.length > 0)
      throw Re(
        "VERSION_CONFLICT",
        "正文已在写回后再次修改，无法安全撤销",
        { conflicts: i }
      );
    let o = 0;
    const c = [];
    for (const d of t.chapters) {
      const l = a.get(d.chapterId), m = await r.chapter.update({
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
function vt(n, e) {
  if (!n)
    return e;
  try {
    return JSON.parse(n);
  } catch {
    return e;
  }
}
function Lo(n) {
  return Ne("sha256").update(n || "", "utf8").digest("hex");
}
function wn(n) {
  if (n instanceof Date)
    return n.toISOString();
  const e = new Date(n);
  return Number.isNaN(e.getTime()) ? n : e.toISOString();
}
function bt(n) {
  return {
    revisionTaskId: n.revisionTaskId,
    novelId: n.novelId,
    sourceArtifactId: n.sourceArtifactId,
    sourceFindingId: n.sourceFindingId,
    title: n.title,
    description: n.description,
    targetChapterIds: vt(n.targetChapterIdsJson, []),
    sourceExpert: n.sourceExpert,
    severity: n.severity,
    recommendedRole: n.recommendedRole,
    status: n.status,
    sourceSnapshot: vt(n.sourceSnapshotJson, []),
    ...n.note ? { note: n.note } : {},
    ...n.planId ? { planId: n.planId } : {},
    ...n.planJson ? { plan: vt(n.planJson, {}) } : {},
    ...n.sourceConversationId ? { sourceConversationId: n.sourceConversationId } : {},
    ...n.sourceRunId ? { sourceRunId: n.sourceRunId } : {},
    entryReason: n.entryReason || "legacy",
    createdAt: wn(n.createdAt),
    updatedAt: wn(n.updatedAt)
  };
}
function Sn(n) {
  const e = vt(n.metadataJson, {}), t = vt(n.referenceJson, {}), r = e.expertReport ?? t.expertReport ?? e.report ?? t.report ?? e;
  if (!r || typeof r != "object")
    throw ie("INVALID_REPORT", "Artifact does not contain an expert report payload");
  const s = r;
  if (!Array.isArray(s.findings) || !Array.isArray(s.sourceSnapshot))
    throw ie("INVALID_REPORT", "Expert report findings and sourceSnapshot are required");
  const a = /* @__PURE__ */ new Set();
  for (const i of s.findings) {
    const o = typeof (i == null ? void 0 : i.findingId) == "string" ? i.findingId.trim() : "";
    if (!o || a.has(o))
      throw ie("INVALID_REPORT", "Expert report findingId values must be non-empty and unique");
    a.add(o);
  }
  return {
    ...s,
    artifactId: s.artifactId || n.artifactId,
    novelId: s.novelId || n.novelId
  };
}
class Mo {
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
    const t = new Set(e.map((a) => a.name));
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
    const r = await this.client.$queryRawUnsafe("PRAGMA table_info(AgentRevisionTask)"), s = new Set(r.map((a) => a.name));
    s.has("sourceConversationId") || await this.client.$executeRawUnsafe("ALTER TABLE AgentRevisionTask ADD COLUMN sourceConversationId TEXT"), s.has("sourceRunId") || await this.client.$executeRawUnsafe("ALTER TABLE AgentRevisionTask ADD COLUMN sourceRunId TEXT"), s.has("entryReason") || await this.client.$executeRawUnsafe("ALTER TABLE AgentRevisionTask ADD COLUMN entryReason TEXT NOT NULL DEFAULT 'legacy'"), await this.client.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_revision_task_novel_status ON AgentRevisionTask(novelId, status, updatedAt)"), await this.client.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_revision_task_artifact ON AgentRevisionTask(sourceArtifactId, sourceFindingId)");
  }
  async findStaleChapterIds(e, t, r) {
    if (!r.length)
      return [];
    const s = [...new Set(r.map((c) => c.chapterId).filter(Boolean))], a = s.map(() => "?").join(", "), i = await e.$queryRawUnsafe(`
            SELECT c.id AS chapterId, c.version AS version, c.content AS content
            FROM Chapter c
            INNER JOIN Volume v ON v.id = c.volumeId
            WHERE v.novelId = ? AND c.deleted = 0 AND c.id IN (${a})
        `, t, ...s), o = new Map(i.map((c) => [c.chapterId, c]));
    return r.flatMap((c) => {
      const d = o.get(c.chapterId);
      return !d || Number(d.version) !== Number(c.version) || Lo(d.content) !== c.contentHash ? [c.chapterId] : [];
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
      const a = (await r.$queryRawUnsafe(`
                SELECT artifactId, novelId, conversationId, runId, metadataJson, referenceJson, reviewStatus, reviewRevision,
                       reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt
                FROM AgentArtifact WHERE artifactId = ?
            `, e.artifactId))[0];
      if (!a)
        throw ie("NOT_FOUND", `Artifact not found: ${e.artifactId}`);
      if (Number(a.reviewRevision) !== e.expectedReviewRevision)
        throw ie("VERSION_CONFLICT", "Artifact review was changed by another operation", {
          expectedReviewRevision: e.expectedReviewRevision,
          actualReviewRevision: Number(a.reviewRevision)
        });
      const i = Sn(a), o = new Map(i.findings.map((u) => [u.findingId, u])), c = /* @__PURE__ */ new Map();
      for (const u of e.decisions) {
        if (!o.has(u.findingId))
          throw ie("INVALID_INPUT", `Unknown findingId: ${u.findingId}`);
        if (!["accepted", "rejected", "deferred"].includes(u.status))
          throw ie("INVALID_INPUT", `Unsupported finding decision: ${String(u.status)}`);
        if (c.has(u.findingId))
          throw ie("INVALID_INPUT", `Duplicate finding decision: ${u.findingId}`);
        c.set(u.findingId, u);
      }
      const d = vt(a.reviewDecisionsJson, []), l = new Map(d.map((u) => [u.findingId, u]));
      for (const u of c.values())
        l.set(u.findingId, u);
      const m = i.findings.flatMap((u) => {
        const I = l.get(u.findingId);
        return I ? [I] : [];
      }), h = await this.findStaleChapterIds(r, a.novelId, i.sourceSnapshot), p = h.length ? "stale" : m.length === i.findings.length ? "reviewed" : "in_review", f = Number(a.reviewRevision) + 1, v = (/* @__PURE__ */ new Date()).toISOString();
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
        v,
        v,
        a.artifactId
      );
      const w = async (u, I, y) => {
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
          `revision_${fe().replace(/-/g, "")}`,
          a.novelId,
          a.artifactId,
          u.findingId,
          u.title,
          u.recommendation || u.summary,
          JSON.stringify(u.chapterIds || []),
          u.expert || i.expert,
          u.severity,
          u.recommendedRole || "editor",
          y,
          JSON.stringify(i.sourceSnapshot),
          I.note || null,
          a.conversationId,
          a.runId,
          I.status === "deferred" ? "deferred" : "accepted",
          v,
          v
        );
      };
      for (const u of c.values()) {
        const I = o.get(u.findingId);
        if (u.status === "accepted" && e.createRevisionTasks !== !1) {
          const y = h.length ? "stale" : "open";
          await w(I, u, y);
        } else if (u.status === "deferred") {
          const y = h.length ? "stale" : "deferred";
          await w(I, u, y);
        } else
          await r.$executeRawUnsafe(`
                        UPDATE AgentRevisionTask SET status = ?, note = ?, updatedAt = ?
                        WHERE sourceArtifactId = ? AND sourceFindingId = ? AND status != 'resolved'
                    `, "closed", u.note || null, v, a.artifactId, I.findingId);
      }
      const g = await r.$queryRawUnsafe(`
                SELECT * FROM AgentRevisionTask WHERE sourceArtifactId = ? ORDER BY datetime(createdAt) ASC
            `, a.artifactId);
      return {
        review: {
          artifactId: a.artifactId,
          reviewStatus: p,
          reviewRevision: f,
          decisions: m,
          staleChapterIds: h,
          reviewedAt: v
        },
        revisionTasks: g.map(bt)
      };
    });
  }
  async listRevisionTasks(e) {
    var a;
    if (await this.ensureSchema(), !((a = e == null ? void 0 : e.novelId) != null && a.trim()))
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
        `, ...r)).map(bt);
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
    return bt(t[0]);
  }
  async updateRevisionTaskStatus(e) {
    await this.ensureSchema();
    const t = String((e == null ? void 0 : e.revisionTaskId) || "").trim(), r = String((e == null ? void 0 : e.expectedUpdatedAt) || "").trim();
    if (!t)
      throw ie("INVALID_INPUT", "revisionTaskId is required");
    if (!r)
      throw ie("INVALID_INPUT", "expectedUpdatedAt is required");
    const a = (await this.client.$queryRawUnsafe(
      "SELECT * FROM AgentRevisionTask WHERE revisionTaskId = ?",
      t
    ))[0];
    if (!a)
      throw ie("NOT_FOUND", `Revision task not found: ${t}`);
    const i = bt(a);
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
      const a = await this.getRevisionTask(e);
      throw ie("INVALID_TASK_STATUS", `Revision task cannot create a plan from status ${a.status}`);
    }
    return this.getRevisionTask(e);
  }
  async syncRevisionTasksFromRun(e) {
    await this.ensureSchema();
    const t = String((e == null ? void 0 : e.novelId) || "").trim(), r = String((e == null ? void 0 : e.sourceArtifactId) || "").trim(), s = String((e == null ? void 0 : e.sourceConversationId) || "").trim(), a = String((e == null ? void 0 : e.sourceRunId) || "").trim(), i = [...new Set(((e == null ? void 0 : e.findingIds) ?? []).map((v) => String(v || "").trim()).filter(Boolean))], o = new Set(((e == null ? void 0 : e.completedFindingIds) ?? []).map((v) => String(v || "").trim()).filter(Boolean));
    if (!t || !r || !s || !i.length)
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
    const l = Sn(d), m = new Map(l.findings.map((v) => [v.findingId, v]));
    for (const v of i)
      if (!m.has(v))
        throw ie("INVALID_INPUT", `Unknown findingId: ${v}`);
    const h = (/* @__PURE__ */ new Date()).toISOString(), p = i.map(() => "?").join(", ");
    if (e.outcome === "completed")
      await this.client.$executeRawUnsafe(`
                UPDATE AgentRevisionTask
                SET status = 'planned', sourceConversationId = ?, sourceRunId = ?, updatedAt = ?
                WHERE sourceArtifactId = ? AND sourceFindingId IN (${p})
                  AND status NOT IN ('resolved', 'stale')
            `, s, a || null, h, r, ...i);
    else if (e.outcome === "committed")
      await this.client.$executeRawUnsafe(`
                UPDATE AgentRevisionTask
                SET status = 'resolved', sourceConversationId = ?, sourceRunId = ?, updatedAt = ?
                WHERE sourceArtifactId = ? AND sourceFindingId IN (${p})
                  AND status NOT IN ('resolved', 'stale')
            `, s, a || null, h, r, ...i);
    else {
      const v = i.filter((g) => !o.has(g)), w = await this.findStaleChapterIds(this.client, t, l.sourceSnapshot);
      for (const g of v) {
        const u = m.get(g), I = w.length ? "stale" : "open";
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
          `revision_${fe().replace(/-/g, "")}`,
          t,
          r,
          u.findingId,
          u.title,
          u.recommendation || u.summary,
          JSON.stringify(u.chapterIds || []),
          u.expert || l.expert,
          u.severity,
          u.recommendedRole || "editor",
          I,
          JSON.stringify(l.sourceSnapshot),
          s,
          a || null,
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
        `, r, ...i)).map(bt) };
  }
}
const Po = {
  plotLines: [],
  plotPoints: [],
  characters: [],
  items: [],
  skills: [],
  maps: []
}, Uo = {
  "novel.list": 15e3,
  "volume.list": 15e3,
  "chapter.list": 15e3,
  "chapter.get": 15e3,
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
}, $o = 3e4;
function qt(n) {
  return {
    plotLines: (n.plotLines ?? []).map(() => !0),
    plotPoints: (n.plotPoints ?? []).map(() => !0),
    characters: (n.characters ?? []).map(() => !0),
    items: (n.items ?? []).map(() => !0),
    skills: (n.skills ?? []).map(() => !0),
    maps: (n.maps ?? []).map(() => !0)
  };
}
function ze(n) {
  if (!n || typeof n != "object")
    return { ...Po };
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
function Nt(n) {
  var t, r, s, a, i, o;
  return [
    `主线 ${((t = n.plotLines) == null ? void 0 : t.length) ?? 0}`,
    `要点 ${((r = n.plotPoints) == null ? void 0 : r.length) ?? 0}`,
    `角色 ${((s = n.characters) == null ? void 0 : s.length) ?? 0}`,
    `物品 ${((a = n.items) == null ? void 0 : a.length) ?? 0}`,
    `技能 ${((i = n.skills) == null ? void 0 : i.length) ?? 0}`,
    `地图 ${((o = n.maps) == null ? void 0 : o.length) ?? 0}`
  ].join(" / ");
}
function vr(n) {
  const e = (t, r) => (Array.isArray(t) ? t : []).filter((a) => typeof a == "object" && a && String(a[r] || "").trim());
  return {
    plotLines: e(n.plotLines, "name"),
    plotPoints: e(n.plotPoints, "title"),
    characters: e(n.characters, "name"),
    items: e(n.items, "name"),
    skills: e(n.skills, "name"),
    maps: e(n.maps, "name")
  };
}
function An(n, e) {
  return e ? {
    plotLines: (n.plotLines ?? []).filter((t, r) => e.plotLines[r]),
    plotPoints: (n.plotPoints ?? []).filter((t, r) => e.plotPoints[r]),
    characters: (n.characters ?? []).filter((t, r) => e.characters[r]),
    items: (n.items ?? []).filter((t, r) => e.items[r]),
    skills: (n.skills ?? []).filter((t, r) => e.skills[r]),
    maps: (n.maps ?? []).filter((t, r) => e.maps[r])
  } : ze(n);
}
function Bo(n) {
  return ze({
    plotLines: n.plotLines,
    plotPoints: n.plotPoints
  });
}
function Fo(n) {
  return ze({
    characters: n.characters,
    items: n.items,
    skills: n.skills
  });
}
function z(n, e, t) {
  return Object.assign(new Error(e), { code: n, details: t });
}
function X(n, e) {
  const t = typeof n == "string" ? n.trim() : "";
  if (!t)
    throw z("INVALID_INPUT", `${e} is required`);
  return t;
}
function ce(n, e) {
  if (typeof n != "number" || !Number.isFinite(n))
    throw z("INVALID_INPUT", `${e} must be a finite number`);
  return n;
}
function qo(n) {
  return Uo[n] ?? $o;
}
function jo(n) {
  const e = String(n || "").trim().toLowerCase();
  if (["creative_assets", "creative-assets", "outline-generate", "outline_generate", "outline"].includes(e))
    return "creative_assets";
  if (["chapter", "chapter-generate", "chapter_generate", "continue-writing", "continue_writing"].includes(e))
    return "chapter";
  throw z("INVALID_INPUT", `Unsupported prompt preview kind: ${String(n || "")}`);
}
class Vo {
  constructor(e, t) {
    H(this, "aiService");
    H(this, "draftStore");
    H(this, "reviewStore");
    H(this, "reviewCommentStore");
    H(this, "draftBatchCommitTail", Promise.resolve());
    this.aiService = e, this.draftStore = new Co(t), this.reviewStore = new Mo(S), this.reviewCommentStore = new bo(t);
  }
  async createRevisionTaskPlan(e, t) {
    var p;
    const r = X(e == null ? void 0 : e.revisionTaskId, "revisionTaskId"), s = Array.isArray(e == null ? void 0 : e.availableTools) ? e.availableTools.map((f) => String(f || "").trim()).filter(Boolean) : [];
    if (!s.length)
      throw z("INVALID_INPUT", "availableTools is required");
    const a = await this.reviewStore.getRevisionTask(r);
    if (a.status !== "open")
      throw z("INVALID_TASK_STATUS", `Revision task cannot create a plan from status ${a.status}`);
    await this.reviewStore.assertRevisionTaskFresh(a);
    const i = e.role || a.recommendedRole, o = [
      `根据已审核问题创建修订计划：${a.title}`,
      a.description,
      a.targetChapterIds.length ? `目标章节：${a.targetChapterIds.join("、")}` : "",
      `来源专家：${a.sourceExpert}；严重度：${a.severity}`,
      a.note ? `审核备注：${a.note}` : "",
      "只生成可审核计划，不直接修改或写回正文。"
    ].filter(Boolean).join(`
`), c = await this.aiService.generateAgentPlan({
      goal: o,
      role: i,
      locale: e.locale || "zh-CN",
      availableTools: s,
      availableToolchains: Array.isArray(e.availableToolchains) ? e.availableToolchains : []
    }, t.signal), d = `plan_${fe().replace(/-/g, "")}`, l = ((p = e.threadId) == null ? void 0 : p.trim()) || `thread_revision_${fe().replace(/-/g, "")}`, m = {
      planId: d,
      threadId: l,
      title: c.title,
      goal: o,
      requiresApproval: !0,
      preferredRole: i,
      ...c.deliverable ? { deliverable: c.deliverable } : {},
      steps: c.steps.map((f) => ({
        stepId: `step_${fe().replace(/-/g, "")}`,
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
    this.draftBatchCommitTail = new Promise((s) => {
      r = s;
    }), await t;
    try {
      return await e();
    } finally {
      r();
    }
  }
  logInvokeStart(e, t, r, s) {
    B("INFO", "AutomationService.invoke.start", "Automation invoke start", {
      requestId: r.requestId,
      method: e,
      source: r.source,
      origin: r.origin,
      timeoutMs: s,
      params: Ie(t)
    });
  }
  logInvokeSuccess(e, t, r, s) {
    B("INFO", "AutomationService.invoke.success", "Automation invoke success", {
      requestId: t.requestId,
      method: e,
      elapsedMs: Date.now() - r,
      result: Ie(s)
    });
  }
  logInvokeError(e, t, r, s) {
    Se("AutomationService.invoke.error", s, {
      requestId: t.requestId,
      method: e,
      elapsedMs: Date.now() - r
    });
  }
  async withTimeout(e, t, r, s) {
    var d;
    const a = qo(e), i = Date.now();
    this.logInvokeStart(e, t, r, a);
    let o;
    const c = new Promise((l, m) => {
      var h;
      o = setTimeout(() => {
        m(z("UPSTREAM_TIMEOUT", `Automation method ${e} timed out after ${a}ms`, {
          method: e,
          timeoutMs: a,
          requestId: r.requestId
        }));
      }, a), (h = o.unref) == null || h.call(o);
    });
    try {
      const l = await Promise.race([s(), c]);
      return o && clearTimeout(o), this.logInvokeSuccess(e, r, i, l), l;
    } catch (l) {
      throw o && clearTimeout(o), this.logInvokeError(e, r, i, l), (d = r.signal) != null && d.aborted ? z("CANCELLED", `Automation method ${e} was cancelled`, {
        method: e,
        requestId: r.requestId
      }) : l;
    }
  }
  buildPromptPreviewPayload(e, t) {
    if (e === "creative_assets") {
      const r = X(t.novelId, "payload.novelId"), s = X(t.brief, "payload.brief"), a = Array.isArray(t.targetSections) ? t.targetSections : String(t.kind || "").toLowerCase().includes("outline") ? ["plotLines", "plotPoints"] : void 0;
      return {
        ...t,
        novelId: r,
        brief: s,
        ...a ? { targetSections: a } : {}
      };
    }
    return {
      ...t,
      novelId: X(t.novelId, "payload.novelId"),
      chapterId: X(t.chapterId, "payload.chapterId"),
      currentContent: X(t.currentContent, "payload.currentContent")
    };
  }
  async listDrafts(e) {
    return this.draftStore.list(e);
  }
  async getDraft(e) {
    return this.draftStore.getById(e);
  }
  async getActiveDraft(e) {
    return X(e == null ? void 0 : e.novelId, "novelId"), this.draftStore.getLatest({
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
    return X(e == null ? void 0 : e.novelId, "novelId"), X(e == null ? void 0 : e.volumeId, "volumeId"), X(e == null ? void 0 : e.anchorChapterId, "anchorChapterId"), this.draftStore.createBatch(e);
  }
  async updateDraftBatchOutline(e) {
    return this.draftStore.updateBatchOutline(
      X(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version"),
      e == null ? void 0 : e.beats
    );
  }
  async approveDraftBatchOutline(e) {
    return this.draftStore.approveBatchOutline(
      X(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version"),
      ce(e == null ? void 0 : e.outlineRevision, "outlineRevision"),
      typeof (e == null ? void 0 : e.approvedBy) == "string" ? e.approvedBy : "desktop-ui"
    );
  }
  async attachDraftBatchChild(e) {
    return this.draftStore.createBatchChildSession(
      X(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.childIndex, "childIndex"),
      e == null ? void 0 : e.session
    );
  }
  async markDraftBatchStaleAfter(e) {
    return this.draftStore.markBatchChildrenStale(
      X(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version"),
      ce(e == null ? void 0 : e.afterChildIndex, "afterChildIndex")
    );
  }
  async prepareDraftBatchRegeneration(e) {
    const t = e == null ? void 0 : e.fromChildIndex;
    if (t !== void 0 && (!Number.isInteger(t) || t < 0))
      throw z("INVALID_INPUT", "fromChildIndex must be a non-negative integer");
    return this.draftStore.prepareBatchRegeneration(
      X(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version"),
      t,
      X(e == null ? void 0 : e.runId, "runId")
    );
  }
  async markDraftBatchChildFailed(e) {
    if (X(e == null ? void 0 : e.draftBatchId, "draftBatchId"), ce(e == null ? void 0 : e.version, "version"), ce(e == null ? void 0 : e.childIndex, "childIndex"), ce(e == null ? void 0 : e.generationRevision, "generationRevision"), !Number.isInteger(e.childIndex) || e.childIndex < 0)
      throw z("INVALID_INPUT", "childIndex must be a non-negative integer");
    if (!Number.isInteger(e.generationRevision) || e.generationRevision < 1)
      throw z("INVALID_INPUT", "generationRevision must be a positive integer");
    return this.draftStore.markBatchChildFailed(e);
  }
  async inspectDraftBatchReconciliation(e) {
    const t = ce(e == null ? void 0 : e.childIndex, "childIndex"), r = ce(e == null ? void 0 : e.generationRevision, "generationRevision");
    if (!Number.isInteger(t) || t < 0)
      throw z("INVALID_INPUT", "childIndex must be a non-negative integer");
    if (!Number.isInteger(r) || r < 1)
      throw z("INVALID_INPUT", "generationRevision must be a positive integer");
    return this.draftStore.inspectBatchReconciliation({
      draftBatchId: X(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      childIndex: t,
      generationRevision: r
    });
  }
  async reconcileDraftBatchUnknown(e) {
    if (X(e == null ? void 0 : e.invocationKey, "invocationKey"), (e == null ? void 0 : e.resolution) !== "reconciled_succeeded" && (e == null ? void 0 : e.resolution) !== "reconciled_absent")
      throw z("INVALID_INPUT", "resolution must be reconciled_succeeded or reconciled_absent");
    return this.draftStore.reconcileBatchUnknown({
      ...e,
      draftBatchId: X(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      version: ce(e == null ? void 0 : e.version, "version"),
      childIndex: ce(e == null ? void 0 : e.childIndex, "childIndex"),
      generationRevision: ce(e == null ? void 0 : e.generationRevision, "generationRevision"),
      invocationKey: X(e == null ? void 0 : e.invocationKey, "invocationKey")
    });
  }
  async discardDraftBatch(e) {
    return this.draftStore.discardBatch(
      X(e == null ? void 0 : e.draftBatchId, "draftBatchId"),
      ce(e == null ? void 0 : e.version, "version")
    );
  }
  async commitDraftBatchPrefix(e) {
    return this.serializeDraftBatchCommit(async () => {
      const t = X(e == null ? void 0 : e.draftBatchId, "draftBatchId"), r = ce(e == null ? void 0 : e.version, "version"), s = ce(e == null ? void 0 : e.prefixLength, "prefixLength");
      if (!Number.isInteger(s))
        throw z("INVALID_INPUT", "prefixLength must be an integer");
      const a = e == null ? void 0 : e.insertionMode;
      if (a !== void 0 && a !== "after_anchor" && a !== "volume_end")
        throw z("INVALID_INPUT", "insertionMode must be after_anchor or volume_end");
      const i = await this.draftStore.getBatchById(t);
      if (!i)
        throw z("NOT_FOUND", "Draft batch not found");
      if (i.version !== r)
        throw z("VERSION_CONFLICT", "Draft batch version conflict");
      if (!Number.isInteger(s) || s < 1 || s > i.children.length)
        throw z("INVALID_INPUT", "prefixLength is outside the draft batch");
      if (i.status === "discarded" || i.status === "failed")
        throw z("INVALID_STATE", `Draft batch cannot be committed from ${i.status}`);
      const o = i.children.findIndex((f) => f.status !== "committed"), c = o < 0 ? i.children.length : o;
      if (i.children.slice(c).some((f) => f.status === "committed"))
        throw z("INVALID_STATE", "Draft batch contains a non-contiguous committed child");
      if (s <= c)
        throw z("INVALID_STATE", "Requested prefix is already committed");
      const d = await this.draftStore.list({ draftBatchId: t, includeInactive: !0 }), l = new Map(d.map((f) => [f.draftSessionId, f])), m = i.children.slice(c, s).map((f) => {
        const v = f.draftSessionId ? l.get(f.draftSessionId) : void 0;
        if (!v || f.status !== "draft" || v.status !== "draft" || v.type !== "chapter-draft")
          throw z(
            "INVALID_STATE",
            `Draft batch child ${f.childIndex + 1} is not ready to commit`
          );
        if (v.draftBatchId !== t || v.childIndex !== f.childIndex)
          throw z(
            "INVALID_STATE",
            `Draft batch child ${f.childIndex + 1} session linkage is invalid`
          );
        const w = v.payload, g = String(w.generatedText || "").trim(), u = i.mode === "sequence_continuation" ? ms(g) : Ro(String(w.content || g));
        if (!gr(u))
          throw z(
            "INVALID_STATE",
            `Draft batch child ${f.childIndex + 1} has no reviewable content`
          );
        return {
          childIndex: f.childIndex,
          targetChapterId: f.targetChapterId,
          title: f.title.trim() || `第 ${f.childIndex + 1} 章`,
          content: u,
          wordCount: gr(u).length
        };
      }), h = await ko(S, {
        batch: i,
        committedPrefixLength: c,
        prefixLength: s,
        insertionMode: a,
        drafts: m
      }), p = await this.draftStore.commitBatchPrefix(
        t,
        r,
        s,
        h.insertionMode,
        h.chapters,
        h.writeback
      );
      for (const f of h.chapters)
        await Ue({
          id: f.chapterId,
          title: f.title,
          content: f.content,
          volumeId: f.volumeId,
          order: f.order,
          novelId: i.novelId
        }), nt(f.chapterId);
      if (h.reorderedChapterIds.length > 0) {
        const f = await S.chapter.findMany({
          where: { id: { in: h.reorderedChapterIds } },
          select: { id: !0, title: !0, content: !0, volumeId: !0 }
        });
        for (const v of f)
          await Ue({ ...v, novelId: i.novelId });
      }
      return {
        batch: p.batch,
        sessions: p.sessions,
        chapters: h.chapters,
        committedPrefixLength: s,
        insertionMode: h.insertionMode,
        writeback: h.writeback
      };
    });
  }
  async undoDraftBatch(e) {
    return this.serializeDraftBatchCommit(async () => {
      const t = X(e == null ? void 0 : e.draftBatchId, "draftBatchId"), r = ce(e == null ? void 0 : e.version, "version"), s = X(e == null ? void 0 : e.writebackId, "writebackId"), a = await this.draftStore.getBatchById(t);
      if (!a)
        throw z("NOT_FOUND", "Draft batch not found");
      if (a.version !== r)
        throw z("VERSION_CONFLICT", "Draft batch version conflict");
      const i = [...a.writebacks ?? []].reverse().find((d) => d.status === "committed");
      if (!i || i.writebackId !== s)
        throw z("INVALID_STATE", "Only the latest writeback can be undone");
      const o = await Oo(S, a, i), c = await this.draftStore.undoBatchWriteback(
        t,
        r,
        s,
        o
      );
      for (const d of o)
        await Ue({
          id: d.chapterId,
          title: d.title,
          content: d.content,
          volumeId: d.volumeId,
          order: d.order,
          novelId: a.novelId
        }), nt(d.chapterId);
      return {
        batch: c.batch,
        writeback: c.writeback
      };
    });
  }
  async generateCreativeAssetsDraft(e, t, r = "creative-assets") {
    X(e == null ? void 0 : e.novelId, "novelId"), X(e == null ? void 0 : e.brief, "brief");
    const s = await this.aiService.generateCreativeAssets(e, t.signal), a = vr(ze(s.draft));
    return this.draftStore.create({
      workspace: "ai-workbench",
      type: r,
      source: "internal-ai",
      origin: t.origin ?? "unknown",
      novelId: e.novelId,
      status: "draft",
      payload: a,
      selection: qt(a),
      previewSummary: Nt(a),
      validation: null
    });
  }
  async createChapterDraftSession(e, t) {
    var T, R, M, J, F, Y;
    X(e == null ? void 0 : e.novelId, "novelId"), X(e == null ? void 0 : e.chapterId, "chapterId"), X(e == null ? void 0 : e.currentContent, "currentContent");
    const r = typeof e.presentation == "string" ? e.presentation.trim().toLowerCase() : "", s = r === "silent" || r === "toast" || r === "modal" ? r : void 0, a = typeof e.draftBatchId == "string" ? e.draftBatchId.trim() : "", i = e.childIndex;
    if (a && !Number.isInteger(i) || !a && i !== void 0)
      throw z("INVALID_INPUT", "draftBatchId and integer childIndex must be supplied together");
    let o;
    if (!a) {
      const L = await S.chapter.findUnique({
        where: { id: e.chapterId },
        select: { id: !0, version: !0, content: !0, deleted: !0, volume: { select: { novelId: !0 } } }
      });
      if (!L || L.deleted || L.volume.novelId !== e.novelId)
        throw z("NOT_FOUND", "Chapter source is unavailable");
      o = {
        chapterId: L.id,
        version: L.version,
        contentHash: Ne("sha256").update(L.content || "", "utf8").digest("hex")
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
      ...v
    } = e, w = await this.aiService.continueWriting(v, t.signal);
    let g, u = "";
    if (a && Number.isInteger(i)) {
      const L = (T = e.preparedContext) == null ? void 0 : T.hardContext, ae = (b) => (b ?? []).map((Z) => ({
        key: String(Z.id || Z.name || "").trim(),
        name: String(Z.name || "").trim()
      })).filter((Z) => Z.key && Z.name);
      try {
        g = (await this.aiService.extractNarrativeState({
          locale: e.locale,
          generatedText: w.text,
          currentBeat: (R = e.batchContext) != null && R.currentBeat && typeof e.batchContext.currentBeat == "object" ? e.batchContext.currentBeat : {},
          priorStateLedger: (M = e.batchContext) != null && M.stateLedger && typeof e.batchContext.stateLedger == "object" ? e.batchContext.stateLedger : {},
          characters: ae(L == null ? void 0 : L.characters),
          items: ae(L == null ? void 0 : L.items)
        }, t.signal)).delta;
      } catch (b) {
        if ((J = t.signal) != null && J.aborted)
          throw b;
        u = "章节状态抽取失败，已使用节拍台账继续生成。", Se("AutomationService.chapter.state-extraction", b, {
          draftBatchId: a,
          childIndex: i,
          generationRevision: e.generationRevision
        });
      }
    }
    const I = a && e.batchMode === "batch_rewrite", y = I ? X(e.targetChapterId, "targetChapterId") : a ? `draft-batch:${a}:${i}` : e.chapterId, A = I ? e.currentContent : a ? "" : e.currentContent, C = {
      chapterId: y,
      baseContent: A,
      generatedText: w.text,
      content: I ? w.text : Jt(A, w.text),
      presentation: s,
      usedContext: w.usedContext,
      warnings: [
        ...w.warnings ?? [],
        ...u ? [u] : []
      ],
      narrativeStateDelta: g,
      contextPolicy: w.contextPolicy,
      contextSnapshot: w.contextSnapshot,
      sourceSnapshot: o,
      consistency: w.consistency
    }, E = {
      workspace: "chapter-editor",
      type: "chapter-draft",
      source: "internal-ai",
      origin: t.origin ?? "unknown",
      novelId: e.novelId,
      chapterId: y,
      status: "draft",
      payload: C,
      previewSummary: `${((F = e.batchTitle) == null ? void 0 : F.trim()) || "章节草稿"} ${w.text.length} 字符`
    };
    if (a && Number.isInteger(i)) {
      const L = (Y = e.batchContext) != null && Y.currentBeat && typeof e.batchContext.currentBeat == "object" ? e.batchContext.currentBeat : {};
      return (await this.draftStore.createBatchChildSession(
        a,
        i,
        E,
        {
          title: String(L.title || e.batchTitle || "").trim(),
          coreConflict: String(L.coreConflict || "").trim(),
          keyEvents: Array.isArray(L.keyEvents) ? L.keyEvents.map(String) : [],
          reveals: Array.isArray(L.reveals) ? L.reveals.map(String) : [],
          endingHook: String(L.endingHook || "").trim(),
          summary: w.text.length > 700 ? `${w.text.slice(0, 350)} ... ${w.text.slice(-250)}` : w.text,
          stateDelta: g
        },
        e.generationRevision
      )).session;
    }
    return this.draftStore.create(E);
  }
  async reviseChapterDraftSession(e, t) {
    var d, l;
    const r = X(e == null ? void 0 : e.sourceDraftSessionId, "sourceDraftSessionId");
    if (ce(e == null ? void 0 : e.sourceDraftVersion, "sourceDraftVersion"), !Array.isArray(e == null ? void 0 : e.comments) || e.comments.length === 0)
      throw z("INVALID_INPUT", "At least one review comment is required");
    const s = await this.draftStore.getById(r);
    if (!s)
      throw z("NOT_FOUND", "Source draft session not found");
    if (s.version !== e.sourceDraftVersion)
      throw z("VERSION_CONFLICT", "Source draft changed after the review comments were loaded");
    if (s.type !== "chapter-draft" || s.draftBatchId)
      throw z("INVALID_DRAFT_TYPE", "Only a standalone chapter draft can use chapter.revise_draft");
    if (s.status !== "draft")
      throw z("INVALID_STATE", "Only the current reviewable draft can be regenerated");
    const a = s.payload, i = e.comments.map((m, h) => {
      var v;
      const p = typeof m.anchor.paragraphIndex == "number" ? `第 ${m.anchor.paragraphIndex + 1} 段` : m.anchor.targetId, f = (v = m.anchor.quote) != null && v.trim() ? `
原文摘录：${m.anchor.quote.trim().slice(0, 500)}` : "";
      return `${h + 1}. ${p}：${m.body.trim()}${f}`;
    }).join(`
`), o = await this.aiService.continueWriting({
      novelId: s.novelId,
      chapterId: ((d = a.sourceSnapshot) == null ? void 0 : d.chapterId) || a.chapterId,
      currentContent: a.generatedText,
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
      throw z("EMPTY_RESULT", "Agent returned an empty revised draft");
    return this.draftStore.create({
      workspace: s.workspace,
      type: "chapter-draft",
      source: "internal-ai",
      origin: t.origin ?? "desktop-ui",
      novelId: s.novelId,
      chapterId: s.chapterId,
      revisionOfDraftSessionId: s.draftSessionId,
      reviewRequestId: ((l = e.reviewRequestId) == null ? void 0 : l.trim()) || fe(),
      status: "draft",
      payload: {
        ...a,
        generatedText: c,
        content: Jt(a.baseContent, c),
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
    const r = X(e == null ? void 0 : e.sourceDraftSessionId, "sourceDraftSessionId");
    if (ce(e == null ? void 0 : e.sourceDraftVersion, "sourceDraftVersion"), !Array.isArray(e == null ? void 0 : e.comments) || e.comments.length === 0)
      throw z("INVALID_INPUT", "At least one review comment is required");
    const s = await this.draftStore.getById(r);
    if (!s)
      throw z("NOT_FOUND", "Source draft session not found");
    if (s.version !== e.sourceDraftVersion)
      throw z("VERSION_CONFLICT", "Source draft changed after the review comments were loaded");
    if (s.type !== "creative-assets")
      throw z("INVALID_DRAFT_TYPE", "Only a creative assets draft can use creative_assets.revise_draft");
    if (s.status !== "draft")
      throw z("INVALID_STATE", "Only the current reviewable draft can be regenerated");
    if (e.comments.some((p) => p.reviewVersionId !== s.draftSessionId))
      throw z("VERSION_CONFLICT", "Review comments belong to another creative assets version");
    const a = vr(ze(s.payload)), i = Object.keys(a).filter((p) => {
      var f;
      return Array.isArray(a[p]) && (((f = a[p]) == null ? void 0 : f.length) ?? 0) > 0;
    }), o = e.comments.map((p, f) => {
      var g;
      const v = p.anchor.fieldPath || p.anchor.targetId, w = (g = p.anchor.quote) != null && g.trim() ? `
条目摘录：${p.anchor.quote.trim().slice(0, 500)}` : "";
      return `${f + 1}. ${v}：${p.body.trim()}${w}`;
    }).join(`
`), c = JSON.stringify(a, (p, f) => p === "imageBase64" ? "[保留原图片数据]" : f, 2), d = await this.aiService.generateCreativeAssets({
      novelId: s.novelId,
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
    }, t.signal), l = vr(ze(d.draft));
    if (Object.values(l).reduce((p, f) => p + ((f == null ? void 0 : f.length) ?? 0), 0) === 0)
      throw z("EMPTY_RESULT", "Agent returned an empty creative assets revision");
    return this.draftStore.create({
      workspace: s.workspace,
      type: "creative-assets",
      source: "internal-ai",
      origin: t.origin ?? "desktop-ui",
      novelId: s.novelId,
      revisionOfDraftSessionId: s.draftSessionId,
      reviewRequestId: ((h = e.reviewRequestId) == null ? void 0 : h.trim()) || fe(),
      status: "draft",
      payload: l,
      selection: qt(l),
      validation: null,
      previewSummary: Nt(l)
    });
  }
  async updateDraft(e) {
    X(e == null ? void 0 : e.draftSessionId, "draftSessionId"), ce(e == null ? void 0 : e.version, "version");
    const t = await this.draftStore.getById(e.draftSessionId);
    if (!t)
      throw z("NOT_FOUND", "Draft session not found");
    if (t.status !== "draft")
      throw z("INVALID_STATE", "Only an active draft can be edited");
    const r = await this.draftStore.update(e.draftSessionId, e.version, (s) => {
      var a;
      return {
        ...s,
        payload: e.payload ?? s.payload,
        selection: e.selection ?? s.selection,
        validation: e.validation === void 0 ? s.validation : e.validation,
        previewSummary: s.type === "chapter-draft" ? `章节草稿 ${((a = (e.payload ?? s.payload).generatedText) == null ? void 0 : a.length) ?? 0} 字符` : Nt(ze(e.payload ?? s.payload))
      };
    });
    if (t.draftBatchId && typeof t.childIndex == "number") {
      const s = await this.draftStore.getBatchById(t.draftBatchId), a = s == null ? void 0 : s.children[t.childIndex];
      s && (a == null ? void 0 : a.draftSessionId) === t.draftSessionId && t.childIndex < s.children.length - 1 && await this.draftStore.markBatchChildrenStale(
        s.draftBatchId,
        s.version,
        t.childIndex
      );
    }
    return r;
  }
  async discardDraft(e) {
    return X(e == null ? void 0 : e.draftSessionId, "draftSessionId"), ce(e == null ? void 0 : e.version, "version"), this.draftStore.update(e.draftSessionId, e.version, (t) => ({
      ...t,
      status: "discarded"
    }));
  }
  async validateCreativeDraftSession(e) {
    X(e == null ? void 0 : e.draftSessionId, "draftSessionId");
    const t = await this.draftStore.getById(e.draftSessionId);
    if (!t)
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    if (typeof e.version == "number" && t.version !== e.version)
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    if (t.type !== "creative-assets" && t.type !== "outline-draft")
      throw Object.assign(new Error("Only creative draft sessions can be validated"), { code: "INVALID_INPUT" });
    const r = await this.aiService.validateCreativeAssetsDraft({
      novelId: t.novelId,
      draft: An(ze(t.payload), t.selection)
    });
    return {
      session: await this.draftStore.update(t.draftSessionId, t.version, (a) => ({
        ...a,
        validation: r,
        payload: r.normalizedDraft,
        selection: qt(r.normalizedDraft),
        previewSummary: Nt(r.normalizedDraft)
      })),
      validation: r
    };
  }
  async commitDraft(e) {
    return this.serializeDraftBatchCommit(() => this.commitDraftSerialized(e));
  }
  async commitDraftSerialized(e) {
    var r;
    X(e == null ? void 0 : e.draftSessionId, "draftSessionId"), ce(e == null ? void 0 : e.version, "version");
    const t = await this.draftStore.getById(e.draftSessionId);
    if (!t)
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    if (t.version !== e.version)
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    if (t.type === "creative-assets" || t.type === "outline-draft") {
      const s = await this.aiService.validateCreativeAssetsDraft({
        novelId: t.novelId,
        draft: An(ze(t.payload), t.selection)
      }), a = s.normalizedDraft, i = await this.draftStore.update(t.draftSessionId, t.version, (l) => ({
        ...l,
        payload: a,
        selection: qt(a),
        validation: s,
        previewSummary: Nt(a)
      }));
      if (!s.ok)
        return {
          session: i,
          validation: s
        };
      const o = await this.aiService.confirmCreativeAssets({
        novelId: t.novelId,
        draft: a
      }), c = o.success && ((r = o.createdEntities) != null && r.length) ? {
        writebackId: fe(),
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
          validation: s,
          writebacks: c ? [...l.writebacks ?? [], c] : l.writebacks
        })),
        validation: s,
        confirmResult: o
      };
    }
    if (t.type === "chapter-draft") {
      if (t.draftBatchId)
        throw z(
          "INVALID_STATE",
          "Batch child drafts must be committed through draft.batch.commit_prefix",
          { draftBatchId: t.draftBatchId }
        );
      const s = t.payload, a = Jt(s.baseContent, s.generatedText), i = s.sourceSnapshot, o = (i == null ? void 0 : i.contentHash) ?? Ne("sha256").update(s.baseContent || "", "utf8").digest("hex"), c = gr(a).length, { sourceChapter: d, updatedChapter: l } = await S.$transaction(async (p) => {
        const f = await p.chapter.findUnique({
          where: { id: s.chapterId },
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
        }), v = f ? Ne("sha256").update(f.content || "", "utf8").digest("hex") : "";
        if (!f || f.deleted || f.volume.novelId !== t.novelId || i && f.version !== i.version || v !== o)
          throw z(
            "VERSION_CONFLICT",
            "正文在草稿生成后已发生变化，请基于最新正文重新生成",
            { chapterId: s.chapterId }
          );
        const w = await p.chapter.update({
          where: { id: f.id },
          data: {
            content: a,
            wordCount: c,
            version: { increment: 1 },
            updatedAt: /* @__PURE__ */ new Date()
          }
        }), g = c - f.wordCount;
        return g !== 0 && await p.novel.update({
          where: { id: t.novelId },
          data: { wordCount: { increment: g }, updatedAt: /* @__PURE__ */ new Date() }
        }), { sourceChapter: f, updatedChapter: w };
      }), m = {
        writebackId: fe(),
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
          afterContentHash: Ne("sha256").update(l.content || "", "utf8").digest("hex"),
          afterVersion: l.version
        }],
        committedAt: (/* @__PURE__ */ new Date()).toISOString()
      }, h = await this.draftStore.update(t.draftSessionId, t.version, (p) => ({
        ...p,
        status: "committed",
        writebacks: [...p.writebacks ?? [], m],
        payload: {
          ...p.payload,
          content: a
        }
      }));
      return await Ue({
        id: l.id,
        title: l.title,
        content: l.content,
        volumeId: l.volumeId,
        order: l.order,
        novelId: t.novelId
      }), nt(l.id), {
        session: h,
        saveResult: l
      };
    }
    throw Object.assign(new Error(`Unsupported draft type: ${t.type}`), { code: "INVALID_INPUT" });
  }
  async undoDraft(e) {
    return this.serializeDraftBatchCommit(async () => {
      var h;
      const t = X(e == null ? void 0 : e.draftSessionId, "draftSessionId"), r = ce(e == null ? void 0 : e.version, "version"), s = X(e == null ? void 0 : e.writebackId, "writebackId"), a = await this.draftStore.getById(t);
      if (!a)
        throw z("NOT_FOUND", "Draft session not found");
      if (a.version !== r)
        throw z("VERSION_CONFLICT", "Draft session version conflict");
      const i = [...a.writebacks ?? []].reverse().find((p) => p.status === "committed");
      if (!i || i.writebackId !== s)
        throw z("INVALID_STATE", "Only the latest writeback can be undone");
      if (i.mode === "creative_assets") {
        if (a.type !== "creative-assets" && a.type !== "outline-draft")
          throw z("INVALID_STATE", "Creative assets writeback belongs to another draft type");
        const { backgroundPaths: p } = await S.$transaction((g) => pa(g, a.novelId, i)), f = (/* @__PURE__ */ new Date()).toISOString(), v = { ...i, status: "undone", undoneAt: f }, w = await this.draftStore.update(a.draftSessionId, a.version, (g) => ({
          ...g,
          status: "draft",
          writebacks: (g.writebacks ?? []).map((u) => u.writebackId === s ? v : u)
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
        return await Promise.allSettled((((h = i.creativeAssets) == null ? void 0 : h.entities) ?? []).flatMap((g) => g.kind === "mapCanvas" ? [] : [this.aiService.deleteRagSourceIndex(a.novelId, g.kind, g.entityId)])), { session: w, writeback: v };
      }
      if (i.mode !== "single_chapter")
        throw z("INVALID_STATE", "This writeback must be undone through its batch workflow");
      const o = i.chapters[0];
      if (!o)
        throw z("INVALID_STATE", "The writeback has no chapter snapshot");
      const c = await S.$transaction(async (p) => {
        const f = await p.chapter.findUnique({
          where: { id: o.chapterId },
          select: { id: !0, content: !0, wordCount: !0, version: !0, deleted: !0 }
        }), v = f ? Ne("sha256").update(f.content || "", "utf8").digest("hex") : "";
        if (!f || f.deleted || f.version !== o.afterVersion || v !== o.afterContentHash)
          throw z(
            "VERSION_CONFLICT",
            "正文已在写回后再次修改，无法安全撤销",
            { chapterId: o.chapterId }
          );
        const w = await p.chapter.update({
          where: { id: o.chapterId },
          data: {
            content: o.beforeContent,
            wordCount: o.beforeWordCount,
            version: { increment: 1 },
            updatedAt: /* @__PURE__ */ new Date()
          }
        }), g = o.beforeWordCount - f.wordCount;
        return g !== 0 && await p.novel.update({
          where: { id: a.novelId },
          data: { wordCount: { increment: g }, updatedAt: /* @__PURE__ */ new Date() }
        }), w;
      }), d = (/* @__PURE__ */ new Date()).toISOString(), l = { ...i, status: "undone", undoneAt: d }, m = await this.draftStore.update(a.draftSessionId, a.version, (p) => ({
        ...p,
        status: "draft",
        writebacks: (p.writebacks ?? []).map((f) => f.writebackId === s ? l : f),
        payload: p.type === "chapter-draft" ? {
          ...p.payload,
          sourceSnapshot: {
            chapterId: c.id,
            version: c.version,
            contentHash: Ne("sha256").update(c.content || "", "utf8").digest("hex")
          }
        } : p.payload
      }));
      return await Ue({
        id: c.id,
        title: c.title,
        content: c.content,
        volumeId: c.volumeId,
        order: c.order,
        novelId: a.novelId
      }), nt(c.id), { session: m, writeback: l };
    });
  }
  async previewPrompt(e) {
    const t = jo(e == null ? void 0 : e.kind), r = this.buildPromptPreviewPayload(t, (e == null ? void 0 : e.payload) ?? {});
    let s;
    return t === "creative_assets" ? s = await this.aiService.previewCreativeAssetsPrompt(r) : s = await this.aiService.previewContinuePrompt(r), {
      kind: t,
      preview: s
    };
  }
  async applyPartialCreativeDraft(e) {
    X(e == null ? void 0 : e.novelId, "novelId");
    const t = await this.aiService.validateCreativeAssetsDraft({
      novelId: e.novelId,
      draft: ze(e.draft)
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
        case "draft.list":
          return this.listDrafts(t);
        case "draft.get":
          return this.getDraft(X(t == null ? void 0 : t.draftSessionId, "draftSessionId"));
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
          return this.getDraftBatch(X(t == null ? void 0 : t.draftBatchId, "draftBatchId"));
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
            novelId: X(t == null ? void 0 : t.novelId, "novelId"),
            draft: Bo(t)
          });
        case "character.create_batch":
          return this.applyPartialCreativeDraft({
            novelId: X(t == null ? void 0 : t.novelId, "novelId"),
            draft: Fo(t)
          });
        case "story_patch.apply":
          return this.applyPartialCreativeDraft({
            novelId: X(t == null ? void 0 : t.novelId, "novelId"),
            draft: ze(t == null ? void 0 : t.draft)
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
class Jo {
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
    return k.join(this.getUserDataPath(), "automation");
  }
  getRuntimePath() {
    return k.join(this.getAutomationDir(), "runtime.json");
  }
  async writeRuntime() {
    this.runtime && (await Ve.mkdir(this.getAutomationDir(), { recursive: !0 }), await Ve.writeFile(this.getRuntimePath(), JSON.stringify(this.runtime, null, 2), "utf8"));
  }
  async removeRuntime() {
    try {
      await Ve.unlink(this.getRuntimePath());
    } catch (e) {
      if ((e == null ? void 0 : e.code) !== "ENOENT")
        throw e;
    }
  }
  sendJson(e, t, r) {
    const s = JSON.stringify(r);
    e.writeHead(t, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(s, "utf8")
    }), e.end(s);
  }
  async readJson(e) {
    const t = [];
    for await (const s of e)
      t.push(Buffer.isBuffer(s) ? s : Buffer.from(s));
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
      token: fe(),
      pid: process.pid,
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    }, this.server = Kt.createServer(async (t, r) => {
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
          const s = await this.readJson(t), a = typeof s.requestId == "string" && s.requestId.trim() ? s.requestId.trim() : fe(), i = Date.now();
          B("INFO", "AutomationServer.invoke.start", "Automation HTTP invoke start", {
            requestId: a,
            method: s.method,
            origin: s.origin ?? "mcp-bridge",
            params: Ie(s.params)
          });
          const o = new AbortController();
          this.activeRequests.set(a, o);
          let c;
          try {
            c = await this.automationService.invoke(s.method, s.params, {
              source: "http",
              origin: s.origin ?? "mcp-bridge",
              requestId: a,
              signal: o.signal
            });
          } finally {
            this.activeRequests.get(a) === o && this.activeRequests.delete(a);
          }
          B("INFO", "AutomationServer.invoke.success", "Automation HTTP invoke success", {
            requestId: a,
            method: s.method,
            elapsedMs: Date.now() - i,
            result: Ie(c)
          }), this.notifyDataChanged(String(s.method || "")), this.sendJson(r, 200, { ok: !0, code: "OK", message: "ok", data: c });
          return;
        }
        if (t.method === "POST" && t.url === "/cancel") {
          const s = await this.readJson(t), a = typeof s.requestId == "string" ? s.requestId.trim() : "";
          if (!a) {
            this.sendJson(r, 400, { ok: !1, code: "INVALID_INPUT", message: "requestId is required" });
            return;
          }
          const i = this.activeRequests.get(a);
          i == null || i.abort(new Error("Automation request cancelled")), this.sendJson(r, 200, {
            ok: !0,
            code: "OK",
            message: i ? "cancelled" : "request not active",
            data: { requestId: a, cancelled: !!i }
          });
          return;
        }
        this.sendJson(r, 404, { ok: !1, code: "NOT_FOUND", message: "Not found" });
      } catch (s) {
        const a = this.normalizeError(s);
        Se("AutomationServer.invoke.error", s, {
          url: t.url,
          method: t.method
        }), this.sendJson(r, 500, {
          ok: !1,
          code: a.code,
          message: a.message,
          data: a.details
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
const Ho = /* @__PURE__ */ new Set(["run_completed", "run_failed", "run_cancelled"]);
function zo(n) {
  const e = n.split(/\r?\n/);
  let t = "message";
  const r = [];
  for (const s of e)
    if (!(!s || s.startsWith(":"))) {
      if (s.startsWith("event:")) {
        t = s.slice(6).trim();
        continue;
      }
      s.startsWith("data:") && r.push(s.slice(5).trimStart());
    }
  return r.length === 0 ? null : { eventName: t, data: r.join(`
`) };
}
function Wo(n, e) {
  const r = `${n}${e}`.replace(/\r\n/g, `
`).split(`

`);
  return {
    buffer: r.pop() || "",
    frames: r.map(zo).filter((a) => a !== null)
  };
}
function Go(n) {
  return Ho.has(n);
}
function Ko(n) {
  const e = Number.isFinite(n.afterSequence) ? Number(n.afterSequence) : 0, t = `/events/${encodeURIComponent(n.runId)}?afterSequence=${encodeURIComponent(String(e))}`;
  let r = !1, s = !1, a = null;
  const i = (o) => {
    r || s || (s = !0, n.onDisconnect({ runId: n.runId, message: o }));
  };
  return a = Kt.request(
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
        const l = Wo(c, d);
        c = l.buffer;
        for (const h of l.frames)
          if (h.eventName === "agent_run_event")
            try {
              const p = JSON.parse(h.data);
              n.onEvent(p), Go(p.type) && (r = !0, a == null || a.destroy());
            } catch (p) {
              (m = n.onParseError) == null || m.call(n, p);
            }
      }), o.on("end", () => {
        i("Agent event stream ended");
      }), o.on("error", (d) => {
        i(d.message || "Agent event stream error");
      });
    }
  ), a.on("error", (o) => {
    i(o.message || "Agent event stream error");
  }), a.end(), () => {
    r = !0, a == null || a.destroy();
  };
}
const Xo = 3, En = 1e3;
function Zo(n) {
  const e = n.consecutiveFailures + 1, t = e >= Xo && n.activeInvocations === 0 && !n.autoRestartAttempted;
  return {
    availability: t ? "recovering" : "slow",
    consecutiveFailures: e,
    shouldAutoRestart: t
  };
}
const jt = 6e4, Yo = 500, Cn = 15e3, Tn = "@@NOVEL_AGENT_PROGRESS@@", Qo = /* @__PURE__ */ new Set([
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
function bn() {
  return process.env.APP_ROOT ? k.resolve(process.env.APP_ROOT, "../..") : process.cwd();
}
function ei() {
  return new Promise((n, e) => {
    const t = Us.createServer();
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
function ti(n) {
  return Object.assign(new Error(`Agent runtime port unavailable: ${n}`), {
    code: "AGENT_RUNTIME_PORT_UNAVAILABLE"
  });
}
function fs(n) {
  if (!Number.isInteger(n) || n <= 0)
    throw ti(n);
}
function Ir(n, e, t, r, s = 8e3) {
  fs(n);
  const a = r ? JSON.stringify(r) : "";
  return new Promise((i, o) => {
    const c = Kt.request(
      {
        hostname: "127.0.0.1",
        port: n,
        path: e,
        method: r ? "POST" : "GET",
        headers: {
          ...r ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(a, "utf8")
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
    c.setTimeout(s, () => c.destroy(new Error("Agent runtime request timeout"))), c.on("error", o), a && c.write(a), c.end();
  });
}
function ri(n) {
  const e = typeof n == "object" && n !== null && "code" in n ? String(n.code || "") : "";
  return ["ECONNREFUSED", "ECONNRESET", "EPIPE", "AGENT_RUNTIME_PORT_UNAVAILABLE"].includes(e);
}
function ni(n) {
  if (typeof n != "object" || n === null || !("port" in n))
    return 0;
  const e = Number(n.port);
  return Number.isInteger(e) && e > 0 ? e : 0;
}
class si {
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
    B("INFO", "PythonRuntimeClient.prewarm", "Prewarming Python Agent runtime in background"), this.startInBackground();
  }
  async health() {
    if (this.recoveryPromise || this.startPromise)
      return this.statusSnapshot();
    if (this.availability === "failed")
      return this.statusSnapshot();
    if (this.phase !== "ready" || !this.process || this.port <= 0)
      return this.startInBackground(), this.statusSnapshot();
    try {
      const e = await Ir(this.port, "/health", this.token, void 0, 2e3);
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
    const r = Zo({
      consecutiveFailures: this.consecutiveHealthFailures,
      activeInvocations: this.activeInvocations,
      autoRestartAttempted: this.autoRestartAttempted
    });
    return this.consecutiveHealthFailures = r.consecutiveFailures, this.availability = r.availability, B("WARN", "PythonRuntimeClient.health.slow", "Agent runtime health probe failed", {
      consecutiveFailures: this.consecutiveHealthFailures,
      activeInvocations: this.activeInvocations,
      shouldAutoRestart: r.shouldAutoRestart,
      error: t
    }), r.shouldAutoRestart && (this.autoRestartAttempted = !0, this.beginRecovery({
      kind: "automatic",
      forceRestart: !0,
      allowAutomaticRetry: !1,
      delayMs: En
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
      this.phase = e, this.phaseChangedAt = Date.now(), B(
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
    if (!e.startsWith(Tn))
      return !1;
    try {
      const t = JSON.parse(e.slice(Tn.length)), r = String(t.phase || "");
      Qo.has(r) && this.setPhase(r);
    } catch (t) {
      B("WARN", "PythonRuntimeClient.progress.parse", "Failed to parse Agent runtime startup progress", {
        line: e,
        error: t instanceof Error ? t.message : String(t)
      });
    }
    return !0;
  }
  async invoke(e) {
    this.activeInvocations += 1;
    try {
      const t = await this.ensureReady();
      if (!t.ok)
        throw Object.assign(new Error(t.message || "Agent runtime unavailable"), {
          code: t.code || "AGENT_RUNTIME_UNAVAILABLE",
          details: t.data
        });
      try {
        return await this.invokeOnce(e);
      } catch (r) {
        if (!ri(r))
          throw r;
        const s = ni(r);
        B("WARN", "PythonRuntimeClient.invoke.retry", "Agent runtime connection failed; recovering once", {
          error: r instanceof Error ? r.message : String(r),
          port: this.port,
          failedPort: s
        });
        const a = await this.beginRecovery({
          kind: "connection",
          forceRestart: !0,
          allowAutomaticRetry: !1,
          failedPort: s
        });
        if (!a.ok)
          throw Object.assign(new Error(a.message || "Agent runtime recovery failed"), {
            code: a.code || "AGENT_RUNTIME_UNAVAILABLE",
            details: a.data
          });
        return this.invokeOnce(e);
      }
    } finally {
      this.activeInvocations = Math.max(0, this.activeInvocations - 1);
    }
  }
  async invokeOnce(e) {
    const t = this.port, r = this.token, s = await Ir(
      t,
      "/invoke",
      r,
      {
        requestId: e.requestId || fe(),
        method: e.method,
        params: e.params || {},
        context: e.context || {}
      },
      18e4
    );
    if (this.markHealthy(), !s.ok)
      throw Object.assign(new Error(s.message || "Agent runtime failed"), {
        code: s.code || "AGENT_RUNTIME_ERROR",
        details: s.data
      });
    return s.data;
  }
  async subscribeRunEvents(e, t, r, s) {
    const a = await this.ensureReady();
    if (!a.ok)
      throw Object.assign(new Error(a.message || "Agent runtime unavailable"), {
        code: a.code || "AGENT_RUNTIME_UNAVAILABLE",
        details: a.data
      });
    const i = this.port, o = this.token;
    fs(i), this.activeInvocations += 1;
    let c = !1;
    const d = () => {
      c || (c = !0, this.activeInvocations = Math.max(0, this.activeInvocations - 1));
    };
    try {
      const l = Ko({
        port: i,
        token: o,
        runId: e,
        afterSequence: t.afterSequence,
        onEvent: r,
        onDisconnect: (m) => {
          d(), s(m);
        },
        onParseError: (m) => {
          B("WARN", "PythonRuntimeClient.sse.parse", "Failed to parse Agent SSE event", {
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
      this.availability = r ? "starting" : "recovering", B("INFO", "PythonRuntimeClient.recovery.start", "Agent runtime recovery started", {
        kind: e.kind,
        forceRestart: e.forceRestart,
        activeInvocations: this.activeInvocations,
        consecutiveHealthFailures: this.consecutiveHealthFailures
      });
      try {
        if (e.delayMs && await new Promise((s) => setTimeout(s, e.delayMs)), e.kind === "automatic" && this.activeInvocations > 0)
          return this.availability = "slow", this.autoRestartAttempted = !1, B("INFO", "PythonRuntimeClient.recovery.deferred", "Skipped automatic restart while calls are active", {
            activeInvocations: this.activeInvocations
          }), this.statusSnapshot();
        if (e.failedPort && this.port > 0 && this.port !== e.failedPort && this.phase === "ready" && this.process)
          return this.markHealthy(), this.statusSnapshot();
        e.forceRestart && await this.stop();
        try {
          await this.ensureStarted();
        } catch (s) {
          if (!e.allowAutomaticRetry || this.autoRestartAttempted)
            throw s;
          this.autoRestartAttempted = !0, this.availability = "recovering", await new Promise((a) => setTimeout(a, En)), await this.stop(), await this.ensureStarted();
        }
        return this.markHealthy(), B("INFO", "PythonRuntimeClient.recovery.ready", "Agent runtime recovery completed", {
          kind: e.kind,
          port: this.port
        }), this.statusSnapshot();
      } catch (s) {
        const a = s instanceof Error ? s.message : String(s);
        return this.setPhase("failed", a), Se("PythonRuntimeClient.recovery.failed", s, { kind: e.kind }), this.statusSnapshot();
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
      const s = k.join(process.resourcesPath, "agent-runtime", "novel-agent-runtime.exe");
      if (re.existsSync(s))
        return { command: s, argsPrefix: [] };
      throw new Error(`Packaged Agent runtime missing: ${s}`);
    }
    const t = bn(), r = k.join(t, "agent_runtime", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    return re.existsSync(r) ? { command: r, argsPrefix: ["-m", "novel_agent_runtime"] } : { command: process.platform === "win32" ? "python" : "python3", argsPrefix: ["-m", "novel_agent_runtime"] };
  }
  async start() {
    this.setPhase("starting_python");
    const e = await ei(), t = fe();
    this.port = e, this.token = t;
    const r = k.join(this.getUserDataPath(), "agent");
    re.mkdirSync(r, { recursive: !0 });
    const { command: s, argsPrefix: a } = this.resolvePythonCommand(), i = [
      ...a,
      "--port",
      String(e),
      "--token",
      t,
      "--automation-runtime",
      this.getAutomationRuntimePath(),
      "--state-dir",
      r
    ];
    B("INFO", "PythonRuntimeClient.start", "Starting Python Agent runtime", {
      command: s,
      args: Ie(i),
      port: e
    });
    const o = qn(s, i, {
      cwd: this.isPackaged ? k.dirname(s) : k.join(bn(), "agent_runtime"),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        LANGGRAPH_STRICT_MSGPACK: "true"
      },
      windowsHide: !0
    });
    this.process = o, this.setPhase("loading_modules");
    let c = null, d = null, l = "";
    B("INFO", "PythonRuntimeClient.start.spawned", "Python Agent runtime process spawned", {
      pid: o.pid,
      port: e
    }), o.stdout.on("data", (m) => {
      l += String(m);
      const h = l.split(/\r?\n/u);
      l = h.pop() || "";
      for (const p of h)
        !p || this.applyProgressLine(p) || B("INFO", "PythonRuntimeClient.stdout", "Agent runtime stdout", { text: p.slice(0, 1e3) });
    }), o.stderr.on("data", (m) => {
      B("WARN", "PythonRuntimeClient.stderr", "Agent runtime stderr", { text: String(m).slice(0, 1e3) });
    }), o.on("exit", (m, h) => {
      c = { code: m, signal: h }, B("WARN", "PythonRuntimeClient.exit", "Agent runtime exited", { code: m, signal: h, pid: o.pid, port: e }), this.process === o && (this.process = null, this.port = 0, this.token = "", this.availability = "starting", this.setPhase("idle"));
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
  async waitForHealth(e, t, r, s) {
    const a = Date.now();
    let i = Cn, o;
    for (; Date.now() - a < jt; ) {
      const d = s == null ? void 0 : s();
      if (d)
        throw d;
      const l = r == null ? void 0 : r();
      if (l)
        throw Object.assign(
          new Error(`Agent runtime exited before health check passed: code=${l.code ?? "null"} signal=${l.signal ?? "null"}`),
          { code: "AGENT_RUNTIME_EXITED_DURING_STARTUP", details: l }
        );
      try {
        const h = await Ir(e, "/health", t, void 0, 2e3);
        if (h.ok)
          return;
        o = new Error(h.message || "Agent runtime health failed");
      } catch (h) {
        o = h;
      }
      const m = Date.now() - a;
      m >= i && (B("WARN", "PythonRuntimeClient.start.waiting", "Python Agent runtime is still starting", {
        port: e,
        elapsedMs: m,
        timeoutMs: jt,
        lastError: o instanceof Error ? o.message : String(o || "")
      }), i += Cn), await new Promise((h) => setTimeout(h, Yo));
    }
    const c = o instanceof Error ? o.message : String(o || "unknown error");
    throw Object.assign(
      new Error(`Agent runtime did not become healthy within ${jt / 1e3}s. Last health error: ${c}`),
      {
        code: "AGENT_RUNTIME_STARTUP_TIMEOUT",
        details: { port: e, timeoutMs: jt, lastMessage: c }
      }
    );
  }
}
function Pe(n) {
  if (!n)
    return null;
  try {
    return JSON.parse(n);
  } catch {
    return null;
  }
}
function ai(n, e, t) {
  return {
    runId: n.runId,
    threadId: n.threadId,
    planId: n.planId,
    status: n.status,
    currentStepId: n.currentStepId,
    progress: Number(n.progress || 0),
    draftSessionId: n.draftSessionId,
    cancelRequested: !!n.cancelRequested,
    pendingApproval: Pe(n.pendingApprovalJson) || null,
    approvalResponses: Pe(n.approvalResponsesJson) || [],
    planSnapshot: Pe(n.planJson) || void 0,
    artifacts: t.map((r) => ({
      artifactId: r.artifactId,
      runId: r.runId,
      planId: r.planId,
      type: r.type,
      title: r.title,
      status: r.status,
      summary: r.summary,
      content: r.content,
      reference: Pe(r.referenceJson) || {},
      metadata: Pe(r.metadataJson) || {},
      reviewStatus: r.reviewStatus || "unreviewed",
      reviewRevision: Number(r.reviewRevision || 0),
      reviewDecisions: Pe(r.reviewDecisionsJson) || [],
      reviewStaleChapterIds: Pe(r.reviewStaleChapterIdsJson) || [],
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
      payload: Pe(r.payloadJson) || {},
      createdAt: r.createdAt
    }))
  };
}
function oi(n, e) {
  const t = /* @__PURE__ */ new Set();
  for (const r of e) {
    const s = r.planSnapshot;
    if (!s || typeof s != "object")
      continue;
    const a = s.steps;
    if (Array.isArray(a))
      for (const i of a) {
        if (!i || typeof i != "object")
          continue;
        const o = i.title;
        typeof o == "string" && o.trim() && t.add(o.trim());
      }
  }
  return t.size === 0 ? n : n.filter((r) => r.role !== "assistant" || !t.has(r.content.trim()));
}
class ii {
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
    const r = await this.db.$queryRawUnsafe("PRAGMA table_info(AgentRun)"), s = new Set(r.map((o) => o.name));
    s.has("pendingApprovalJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentRun ADD COLUMN pendingApprovalJson TEXT"), s.has("approvalResponsesJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentRun ADD COLUMN approvalResponsesJson TEXT"), s.has("planJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentRun ADD COLUMN planJson TEXT"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_run_conversation_updated ON AgentRun(conversationId, updatedAt)"), await this.db.$executeRawUnsafe(`
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
    const a = await this.db.$queryRawUnsafe("PRAGMA table_info(AgentArtifact)"), i = new Set(a.map((o) => o.name));
    i.has("reviewStatus") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewStatus TEXT NOT NULL DEFAULT 'unreviewed'"), i.has("reviewRevision") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewRevision INTEGER NOT NULL DEFAULT 0"), i.has("reviewDecisionsJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewDecisionsJson TEXT"), i.has("reviewStaleChapterIdsJson") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewStaleChapterIdsJson TEXT"), i.has("reviewedAt") || await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewedAt DATETIME"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_artifact_conversation_created ON AgentArtifact(conversationId, createdAt)"), await this.db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_agent_artifact_run_created ON AgentArtifact(runId, createdAt)"), this.legacyStepMessagesCleaned || (await this.cleanupLegacyStepMessages(), this.legacyStepMessagesCleaned = !0);
  }
  async list(e) {
    await this.ensureSchema();
    const t = await this.db.$queryRawUnsafe(`
            SELECT id, novelId, title, description, role, runtimeConversationId,
                   updatedAt, suggestedGoal, planJson, runJson, contextSummaryJson, error
            FROM AgentConversation WHERE novelId = ? ORDER BY datetime(updatedAt) DESC
        `, e), r = [];
    for (const s of t) {
      const a = await this.db.$queryRawUnsafe(`
                SELECT id, conversationId, role, content, metadataJson, createdAt FROM AgentMessage
                WHERE conversationId = ? ORDER BY datetime(createdAt) ASC
            `, s.id), i = await this.db.$queryRawUnsafe(`
                SELECT runId, conversationId, novelId, threadId, planId, status,
                       currentStepId, progress, draftSessionId, cancelRequested,
                       pendingApprovalJson, approvalResponsesJson, planJson
                FROM AgentRun WHERE conversationId = ? ORDER BY datetime(updatedAt) DESC
            `, s.id), o = [];
      for (const p of i) {
        const f = await this.db.$queryRawUnsafe(`
                    SELECT eventId, sequence, runId, planId, threadId, stepId, type,
                           agent, toolName, status, payloadJson, createdAt
                    FROM AgentRunEvent WHERE runId = ? ORDER BY sequence ASC
                `, p.runId), v = await this.db.$queryRawUnsafe(`
                    SELECT artifactId, runId, planId, type, title, status, summary,
                           content, referenceJson, metadataJson, reviewStatus, reviewRevision,
                           reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt, createdAt
                    FROM AgentArtifact WHERE runId = ? ORDER BY datetime(createdAt) ASC
                `, p.runId);
        o.push(ai(p, f, v));
      }
      const c = Pe(s.runJson), d = !!(c && typeof c == "object" && Object.prototype.hasOwnProperty.call(c, "runId")), l = d ? c.runId : void 0, m = d ? typeof l == "string" ? o.find((p) => p.runId === l) ?? null : null : o[0] || null, h = oi(a, o);
      r.push({
        id: s.id,
        novelId: s.novelId,
        title: s.title,
        description: s.description || "",
        role: s.role,
        runtimeConversationId: s.runtimeConversationId,
        updatedAt: s.updatedAt,
        suggestedGoal: s.suggestedGoal,
        plan: Pe(s.planJson),
        run: m,
        runs: o,
        contextSummary: Pe(s.contextSummaryJson) || null,
        error: s.error || "",
        messages: h.map(({ id: p, role: f, content: v, metadataJson: w, createdAt: g }) => {
          const u = Pe(w), I = u && typeof u == "object" ? u : {};
          return {
            id: p,
            role: f,
            content: v,
            createdAt: g,
            ...Array.isArray(I.contextReads) ? { contextReads: I.contextReads } : {},
            ...I.contextDiagnostics && typeof I.contextDiagnostics == "object" ? { contextDiagnostics: I.contextDiagnostics } : {}
          };
        })
      });
    }
    return r;
  }
  async upsert(e) {
    return this.enqueue(e.id, async () => {
      var a, i;
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
        JSON.stringify({ runId: ((a = e.run) == null ? void 0 : a.runId) ?? null }),
        e.contextSummary ? JSON.stringify(e.contextSummary) : null,
        e.error || "",
        t,
        r
      ), await this.db.$executeRawUnsafe("DELETE FROM AgentMessage WHERE conversationId = ?", e.id);
      for (const o of e.messages || []) {
        const c = {
          ...(i = o.contextReads) != null && i.length ? { contextReads: o.contextReads } : {},
          ...o.contextDiagnostics ? { contextDiagnostics: o.contextDiagnostics } : {}
        };
        await this.db.$executeRawUnsafe(
          `
                    INSERT INTO AgentMessage (id, conversationId, role, content, metadataJson, createdAt) VALUES (?, ?, ?, ?, ?, ?)
                `,
          o.id,
          e.id,
          o.role,
          o.content,
          Object.keys(c).length ? JSON.stringify(c) : null,
          o.createdAt || t
        );
      }
      const s = e.run;
      if (s != null && s.runId) {
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
          s.runId,
          e.id,
          e.novelId,
          s.threadId,
          s.planId,
          s.status,
          s.currentStepId || null,
          Number(s.progress || 0),
          s.draftSessionId || null,
          s.cancelRequested ? 1 : 0,
          s.pendingApproval ? JSON.stringify(s.pendingApproval) : null,
          JSON.stringify(s.approvalResponses || []),
          s.planSnapshot ? JSON.stringify(s.planSnapshot) : null,
          t,
          r
        );
        for (const o of s.events || [])
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
            o.eventId,
            Number(o.sequence || 0),
            s.runId,
            o.planId || null,
            o.threadId || null,
            o.stepId || null,
            o.type,
            o.agent || null,
            o.toolName || null,
            o.status || null,
            JSON.stringify(o.payload || {}),
            o.createdAt || t
          );
        for (const o of s.artifacts || [])
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
            o.artifactId,
            e.id,
            s.runId,
            e.novelId,
            o.planId || s.planId,
            o.type,
            o.title,
            o.status,
            o.summary || null,
            o.content || null,
            JSON.stringify(o.reference || {}),
            JSON.stringify(o.metadata || {}),
            o.reviewStatus || "unreviewed",
            Number(o.reviewRevision || 0),
            JSON.stringify(o.reviewDecisions || []),
            JSON.stringify(o.reviewStaleChapterIds || []),
            o.reviewedAt || null,
            o.createdAt || t,
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
    var s;
    const e = await this.db.$queryRawUnsafe(`
            SELECT conversationId, planJson FROM AgentRun WHERE planJson IS NOT NULL
        `), t = /* @__PURE__ */ new Map();
    for (const a of e) {
      const i = Pe(a.planJson);
      if (!i || typeof i != "object")
        continue;
      const o = i.steps;
      if (!Array.isArray(o))
        continue;
      const c = t.get(a.conversationId) ?? /* @__PURE__ */ new Set();
      for (const d of o) {
        if (!d || typeof d != "object")
          continue;
        const l = d.title;
        typeof l == "string" && l.trim() && c.add(l.trim());
      }
      t.set(a.conversationId, c);
    }
    if (t.size === 0)
      return;
    const r = await this.db.$queryRawUnsafe(`
            SELECT id, conversationId, content FROM AgentMessage WHERE role = 'assistant'
        `);
    for (const a of r)
      (s = t.get(a.conversationId)) != null && s.has(a.content.trim()) && await this.db.$executeRawUnsafe(
        "DELETE FROM AgentMessage WHERE id = ? AND conversationId = ?",
        a.id,
        a.conversationId
      );
  }
  async enqueue(e, t) {
    const s = (this.writeQueues.get(e) ?? Promise.resolve()).catch(() => {
    }).then(t), a = s.then(() => {
    }, () => {
    });
    this.writeQueues.set(e, a);
    try {
      return await s;
    } finally {
      this.writeQueues.get(e) === a && this.writeQueues.delete(e);
    }
  }
}
const ci = /^(第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[卷册部集篇]|[卷册部集篇]\s*[0-9零〇一二两三四五六七八九十百千]+|第\s*[IVXLC]+\s*卷)(?:\s+.+)?$/iu, di = /^(第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[章节回节篇]|chapter\s*\d+|chap\.\s*\d+|序章|楔子|终章|尾声|后记|番外)(?:\s+.+)?$/iu;
function ps(n) {
  return n.replace(/^\uFEFF/, "").replace(/\r\n?/g, `
`);
}
function li(n) {
  return n.trim().replace(/[\u3000\t ]+/g, " ");
}
function Xt(n) {
  return ps(n).split(`
`).map((e) => e.trimEnd()).join(`
`).trim();
}
function ui(n) {
  return n.replace(/\s+/g, "").length;
}
function hi(n) {
  return k.parse(n).name.trim() || "导入作品";
}
function Nn(n) {
  return n ? (n.match(/�/g) || []).length > 0 ? !0 : (n.match(/[�]/g) || []).length > 0 : !1;
}
function mi(n) {
  const e = new TextDecoder("utf-8").decode(n);
  if (!Nn(e))
    return e;
  for (const t of ["gb18030", "gbk", "big5"])
    try {
      const r = new TextDecoder(t).decode(n);
      if (!Nn(r))
        return r;
    } catch {
    }
  return e;
}
async function fi(n) {
  const e = await Ve.readFile(n);
  return mi(e);
}
async function pi(n) {
  const e = await import("mammoth");
  return (await (e.default ?? e).extractRawText({ path: n })).value || "";
}
async function gi(n) {
  var a;
  const e = await import("pdf-parse"), { PDFParse: t } = e, r = await Ve.readFile(n), s = new t({ data: r });
  try {
    return (await s.getText()).text || "";
  } finally {
    await ((a = s.destroy) == null ? void 0 : a.call(s));
  }
}
async function vi(n) {
  const e = k.extname(n).toLowerCase();
  if (e === ".txt")
    return await fi(n);
  if (e === ".docx")
    return await pi(n);
  if (e === ".doc")
    throw new Error("暂不支持旧版 .doc，请先另存为 .docx 后再导入。");
  if (e === ".pdf")
    return await gi(n);
  throw new Error(`不支持的文件类型: ${e || "unknown"}`);
}
async function Ii(n) {
  const e = await vi(n), t = Xt(e);
  if (!t)
    throw new Error("未从文件中提取到可导入文本。");
  return Si(t, hi(n));
}
function xn(n) {
  const e = Xt(n), t = e ? e.split(/\n{2,}/).map((r) => r.trim()).filter(Boolean) : [""];
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
function yi(n) {
  return Xt(n.lines.join(`
`)).length > 0;
}
function yr(n) {
  return n.title === "开始" && !yi(n);
}
function wi(n, e) {
  const t = e.map((s, a) => ({
    title: s.title || "正文",
    order: a + 1,
    chapters: s.chapters.map((i, o) => {
      const c = Xt(i.lines.join(`
`));
      return {
        title: i.title || "开始",
        plainText: c,
        lexicalContent: xn(c),
        wordCount: ui(c),
        order: o + 1
      };
    }).filter((i) => i.plainText.length > 0 || i.title === "开始")
  })).filter((s) => s.chapters.length > 0), r = t.length ? t : [{
    title: "正文",
    order: 1,
    chapters: [{
      title: "开始",
      plainText: "",
      lexicalContent: xn(""),
      wordCount: 0,
      order: 1
    }]
  }];
  return {
    title: n,
    volumes: r,
    wordCount: r.reduce((s, a) => s + a.chapters.reduce((i, o) => i + o.wordCount, 0), 0)
  };
}
function Si(n, e) {
  const r = ps(n).split(`
`), s = [];
  let a = { title: "正文", chapters: [] }, i = { title: "开始", lines: [] };
  const o = () => {
    yr(i) || a.chapters.push(i);
  }, c = () => {
    yr(i) || o(), a.chapters.length > 0 && s.push(a);
  };
  for (const l of r) {
    const m = li(l);
    if (!m) {
      i.lines.push("");
      continue;
    }
    if (ci.test(m)) {
      c(), a = { title: m, chapters: [] }, i = { title: "开始", lines: [] };
      continue;
    }
    if (di.test(m)) {
      yr(i) || o(), i = { title: m, lines: [] };
      continue;
    }
    i.lines.push(l.trimEnd());
  }
  c();
  const d = e.trim() || "导入作品";
  return wi(d, s);
}
const _n = "http://localhost:8080/api/sync";
class Ai {
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
      const s = await fetch(`${_n}/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastSyncCursor: e })
      });
      if (!s.ok)
        throw new Error(`Pull failed: ${s.statusText}`);
      const a = await s.json(), { newSyncCursor: i, data: o } = a;
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
    } catch (s) {
      throw console.error("[Sync] Pull error:", s), s;
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
    }, (a, i) => typeof i == "bigint" ? i.toString() : i), s = await fetch(`${_n}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: r
    });
    if (!s.ok)
      throw new Error(`Push failed: ${s.statusText}`);
    return console.log("[Sync] Push success"), await s.json();
  }
}
function Ei(n) {
  return n && n.__esModule && Object.prototype.hasOwnProperty.call(n, "default") ? n.default : n;
}
var wt = { exports: {} }, gs = {
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
}, Zt = {};
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
    return function(...s) {
      return s.length && (r = r.replace(/\{(\d)\}/g, (a, i) => s[i] || "")), new Error("ADM-ZIP: " + r);
    };
  }
  for (const r of Object.keys(e))
    n[r] = t(e[r]);
})(Zt);
const Ci = q, we = Ge, Rn = gs, Ti = Zt, bi = typeof process == "object" && process.platform === "win32", Dn = (n) => typeof n == "object" && n !== null, vs = new Uint32Array(256).map((n, e) => {
  for (let t = 0; t < 8; t++)
    e & 1 ? e = 3988292384 ^ e >>> 1 : e >>>= 1;
  return e >>> 0;
});
function pe(n) {
  this.sep = we.sep, this.fs = Ci, Dn(n) && Dn(n.fs) && typeof n.fs.statSync == "function" && (this.fs = n.fs);
}
var Ni = pe;
pe.prototype.makeDir = function(n) {
  const e = this;
  function t(r) {
    let s = r.split(e.sep)[0];
    r.split(e.sep).forEach(function(a) {
      if (!(!a || a.substr(-1, 1) === ":")) {
        s += e.sep + a;
        var i;
        try {
          i = e.fs.statSync(s);
        } catch {
          e.fs.mkdirSync(s);
        }
        if (i && i.isFile())
          throw Ti.FILE_IN_THE_WAY(`"${s}"`);
      }
    });
  }
  t(n);
};
pe.prototype.writeFileTo = function(n, e, t, r) {
  const s = this;
  if (s.fs.existsSync(n)) {
    if (!t)
      return !1;
    var a = s.fs.statSync(n);
    if (a.isDirectory())
      return !1;
  }
  var i = we.dirname(n);
  s.fs.existsSync(i) || s.makeDir(i);
  var o;
  try {
    o = s.fs.openSync(n, "w", 438);
  } catch {
    s.fs.chmodSync(n, 438), o = s.fs.openSync(n, "w", 438);
  }
  if (o)
    try {
      s.fs.writeSync(o, e, 0, e.length, 0);
    } finally {
      s.fs.closeSync(o);
    }
  return s.fs.chmodSync(n, r || 438), !0;
};
pe.prototype.writeFileToAsync = function(n, e, t, r, s) {
  typeof r == "function" && (s = r, r = void 0);
  const a = this;
  a.fs.exists(n, function(i) {
    if (i && !t)
      return s(!1);
    a.fs.stat(n, function(o, c) {
      if (i && c.isDirectory())
        return s(!1);
      var d = we.dirname(n);
      a.fs.exists(d, function(l) {
        l || a.makeDir(d), a.fs.open(n, "w", 438, function(m, h) {
          m ? a.fs.chmod(n, 438, function() {
            a.fs.open(n, "w", 438, function(p, f) {
              a.fs.write(f, e, 0, e.length, 0, function() {
                a.fs.close(f, function() {
                  a.fs.chmod(n, r || 438, function() {
                    s(!0);
                  });
                });
              });
            });
          }) : h ? a.fs.write(h, e, 0, e.length, 0, function() {
            a.fs.close(h, function() {
              a.fs.chmod(n, r || 438, function() {
                s(!0);
              });
            });
          }) : a.fs.chmod(n, r || 438, function() {
            s(!0);
          });
        });
      });
    });
  });
};
pe.prototype.findFiles = function(n) {
  const e = this;
  function t(r, s, a) {
    let i = [];
    return e.fs.readdirSync(r).forEach(function(o) {
      const c = we.join(r, o), d = e.fs.statSync(c);
      i.push(we.normalize(c) + (d.isDirectory() ? e.sep : "")), d.isDirectory() && a && (i = i.concat(t(c, s, a)));
    }), i;
  }
  return t(n, void 0, !0);
};
pe.prototype.findFilesAsync = function(n, e) {
  const t = this;
  let r = [];
  t.fs.readdir(n, function(s, a) {
    if (s)
      return e(s);
    let i = a.length;
    if (!i)
      return e(null, r);
    a.forEach(function(o) {
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
  return vs[(n ^ e) & 255] ^ n >>> 8;
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
    case Rn.STORED:
      return "STORED (" + n + ")";
    case Rn.DEFLATED:
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
  for (var t = e.split("/"), r = 0, s = t.length; r < s; r++) {
    var a = we.normalize(we.join(n, t.slice(r, s).join(we.sep)));
    if (a.indexOf(n) === 0)
      return a;
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
pe.isWin = bi;
pe.crcTable = vs;
const xi = Ge;
var _i = function(n, { fs: e }) {
  var t = n || "", r = a(), s = null;
  function a() {
    return {
      directory: !1,
      readonly: !1,
      hidden: !1,
      executable: !1,
      mtime: 0,
      atime: 0
    };
  }
  return t && e.existsSync(t) ? (s = e.statSync(t), r.directory = s.isDirectory(), r.mtime = s.mtime, r.atime = s.atime, r.executable = (73 & s.mode) !== 0, r.readonly = (128 & s.mode) === 0, r.hidden = xi.basename(t)[0] === ".") : console.warn("Invalid path: " + t), {
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
}, Ri = {
  efs: !0,
  encode: (n) => Buffer.from(n, "utf8"),
  decode: (n) => n.toString("utf8")
};
wt.exports = Ni;
wt.exports.Constants = gs;
wt.exports.Errors = Zt;
wt.exports.FileAttr = _i;
wt.exports.decoder = Ri;
var kt = wt.exports, Yt = {}, rt = kt, U = rt.Constants, Di = function() {
  var n = 20, e = 10, t = 0, r = 0, s = 0, a = 0, i = 0, o = 0, c = 0, d = 0, l = 0, m = 0, h = 0, p = 0, f = 0;
  n |= rt.isWin ? 2560 : 768, t |= U.FLG_EFS;
  const v = {
    extraLen: 0
  }, w = (u) => Math.max(0, u) >>> 0, g = (u) => Math.max(0, u) & 255;
  return s = rt.fromDate2DOS(/* @__PURE__ */ new Date()), {
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
      return (t & U.FLG_EFS) > 0;
    },
    set flags_efs(u) {
      u ? t |= U.FLG_EFS : t &= ~U.FLG_EFS;
    },
    get flags_desc() {
      return (t & U.FLG_DESC) > 0;
    },
    set flags_desc(u) {
      u ? t |= U.FLG_DESC : t &= ~U.FLG_DESC;
    },
    get method() {
      return r;
    },
    set method(u) {
      switch (u) {
        case U.STORED:
          this.version = 10;
        case U.DEFLATED:
        default:
          this.version = 20;
      }
      r = u;
    },
    get time() {
      return rt.fromDOS2Date(this.timeval);
    },
    set time(u) {
      this.timeval = rt.fromDate2DOS(u);
    },
    get timeval() {
      return s;
    },
    set timeval(u) {
      s = w(u);
    },
    get timeHighByte() {
      return g(s >>> 8);
    },
    get crc() {
      return a;
    },
    set crc(u) {
      a = w(u);
    },
    get compressedSize() {
      return i;
    },
    set compressedSize(u) {
      i = w(u);
    },
    get size() {
      return o;
    },
    set size(u) {
      o = w(u);
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
      return v.extraLen;
    },
    set extraLocalLength(u) {
      v.extraLen = u;
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
      m = w(u);
    },
    get inAttr() {
      return h;
    },
    set inAttr(u) {
      h = w(u);
    },
    get attr() {
      return p;
    },
    set attr(u) {
      p = w(u);
    },
    // get Unix file permissions
    get fileAttr() {
      return (p || 0) >> 16 & 4095;
    },
    get offset() {
      return f;
    },
    set offset(u) {
      f = w(u);
    },
    get encrypted() {
      return (t & U.FLG_ENC) === U.FLG_ENC;
    },
    get centralHeaderSize() {
      return U.CENHDR + c + d + l;
    },
    get realDataOffset() {
      return f + U.LOCHDR + v.fnameLen + v.extraLen;
    },
    get localHeader() {
      return v;
    },
    loadLocalHeaderFromBinary: function(u) {
      var I = u.slice(f, f + U.LOCHDR);
      if (I.readUInt32LE(0) !== U.LOCSIG)
        throw rt.Errors.INVALID_LOC();
      v.version = I.readUInt16LE(U.LOCVER), v.flags = I.readUInt16LE(U.LOCFLG), v.method = I.readUInt16LE(U.LOCHOW), v.time = I.readUInt32LE(U.LOCTIM), v.crc = I.readUInt32LE(U.LOCCRC), v.compressedSize = I.readUInt32LE(U.LOCSIZ), v.size = I.readUInt32LE(U.LOCLEN), v.fnameLen = I.readUInt16LE(U.LOCNAM), v.extraLen = I.readUInt16LE(U.LOCEXT);
      const y = f + U.LOCHDR + v.fnameLen, A = y + v.extraLen;
      return u.slice(y, A);
    },
    loadFromBinary: function(u) {
      if (u.length !== U.CENHDR || u.readUInt32LE(0) !== U.CENSIG)
        throw rt.Errors.INVALID_CEN();
      n = u.readUInt16LE(U.CENVEM), e = u.readUInt16LE(U.CENVER), t = u.readUInt16LE(U.CENFLG), r = u.readUInt16LE(U.CENHOW), s = u.readUInt32LE(U.CENTIM), a = u.readUInt32LE(U.CENCRC), i = u.readUInt32LE(U.CENSIZ), o = u.readUInt32LE(U.CENLEN), c = u.readUInt16LE(U.CENNAM), d = u.readUInt16LE(U.CENEXT), l = u.readUInt16LE(U.CENCOM), m = u.readUInt16LE(U.CENDSK), h = u.readUInt16LE(U.CENATT), p = u.readUInt32LE(U.CENATX), f = u.readUInt32LE(U.CENOFF);
    },
    localHeaderToBinary: function() {
      var u = Buffer.alloc(U.LOCHDR);
      return u.writeUInt32LE(U.LOCSIG, 0), u.writeUInt16LE(e, U.LOCVER), u.writeUInt16LE(t, U.LOCFLG), u.writeUInt16LE(r, U.LOCHOW), u.writeUInt32LE(s, U.LOCTIM), u.writeUInt32LE(a, U.LOCCRC), u.writeUInt32LE(i, U.LOCSIZ), u.writeUInt32LE(o, U.LOCLEN), u.writeUInt16LE(c, U.LOCNAM), u.writeUInt16LE(v.extraLen, U.LOCEXT), u;
    },
    centralHeaderToBinary: function() {
      var u = Buffer.alloc(U.CENHDR + c + d + l);
      return u.writeUInt32LE(U.CENSIG, 0), u.writeUInt16LE(n, U.CENVEM), u.writeUInt16LE(e, U.CENVER), u.writeUInt16LE(t, U.CENFLG), u.writeUInt16LE(r, U.CENHOW), u.writeUInt32LE(s, U.CENTIM), u.writeUInt32LE(a, U.CENCRC), u.writeUInt32LE(i, U.CENSIZ), u.writeUInt32LE(o, U.CENLEN), u.writeUInt16LE(c, U.CENNAM), u.writeUInt16LE(d, U.CENEXT), u.writeUInt16LE(l, U.CENCOM), u.writeUInt16LE(m, U.CENDSK), u.writeUInt16LE(h, U.CENATT), u.writeUInt32LE(p, U.CENATX), u.writeUInt32LE(f, U.CENOFF), u;
    },
    toJSON: function() {
      const u = function(I) {
        return I + " bytes";
      };
      return {
        made: n,
        version: e,
        flags: t,
        method: rt.methodToString(r),
        time: this.time,
        crc: "0x" + a.toString(16).toUpperCase(),
        compressedSize: u(i),
        size: u(o),
        fileNameLength: u(c),
        extraLength: u(d),
        commentLength: u(l),
        diskNumStart: m,
        inAttr: h,
        attr: p,
        offset: f,
        centralHeaderSize: u(U.CENHDR + c + d + l)
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
}, pt = kt, le = pt.Constants, ki = function() {
  var n = 0, e = 0, t = 0, r = 0, s = 0;
  return {
    get diskEntries() {
      return n;
    },
    set diskEntries(a) {
      n = e = a;
    },
    get totalEntries() {
      return e;
    },
    set totalEntries(a) {
      e = n = a;
    },
    get size() {
      return t;
    },
    set size(a) {
      t = a;
    },
    get offset() {
      return r;
    },
    set offset(a) {
      r = a;
    },
    get commentLength() {
      return s;
    },
    set commentLength(a) {
      s = a;
    },
    get mainHeaderSize() {
      return le.ENDHDR + s;
    },
    loadFromBinary: function(a) {
      if ((a.length !== le.ENDHDR || a.readUInt32LE(0) !== le.ENDSIG) && (a.length < le.ZIP64HDR || a.readUInt32LE(0) !== le.ZIP64SIG))
        throw pt.Errors.INVALID_END();
      a.readUInt32LE(0) === le.ENDSIG ? (n = a.readUInt16LE(le.ENDSUB), e = a.readUInt16LE(le.ENDTOT), t = a.readUInt32LE(le.ENDSIZ), r = a.readUInt32LE(le.ENDOFF), s = a.readUInt16LE(le.ENDCOM)) : (n = pt.readBigUInt64LE(a, le.ZIP64SUB), e = pt.readBigUInt64LE(a, le.ZIP64TOT), t = pt.readBigUInt64LE(a, le.ZIP64SIZE), r = pt.readBigUInt64LE(a, le.ZIP64OFF), s = 0);
    },
    toBinary: function() {
      var a = Buffer.alloc(le.ENDHDR + s);
      return a.writeUInt32LE(le.ENDSIG, 0), a.writeUInt32LE(0, 4), a.writeUInt16LE(n, le.ENDSUB), a.writeUInt16LE(e, le.ENDTOT), a.writeUInt32LE(t, le.ENDSIZ), a.writeUInt32LE(r, le.ENDOFF), a.writeUInt16LE(s, le.ENDCOM), a.fill(" ", le.ENDHDR), a;
    },
    toJSON: function() {
      const a = function(i, o) {
        let c = i.toString(16).toUpperCase();
        for (; c.length < o; )
          c = "0" + c;
        return "0x" + c;
      };
      return {
        diskEntries: n,
        totalEntries: e,
        size: t + " bytes",
        offset: a(r, 4),
        commentLength: s
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
Yt.EntryHeader = Di;
Yt.MainHeader = ki;
var Qt = {}, Oi = function(n) {
  var e = jn, t = { chunkSize: (parseInt(n.length / 1024) + 1) * 1024 };
  return {
    deflate: function() {
      return e.deflateRawSync(n, t);
    },
    deflateAsync: function(r) {
      var s = e.createDeflateRaw(t), a = [], i = 0;
      s.on("data", function(o) {
        a.push(o), i += o.length;
      }), s.on("end", function() {
        var o = Buffer.alloc(i), c = 0;
        o.fill(0);
        for (var d = 0; d < a.length; d++) {
          var l = a[d];
          l.copy(o, c), c += l.length;
        }
        r && r(o);
      }), s.end(n);
    }
  };
};
const Li = +(process.versions ? process.versions.node : "").split(".")[0] || 0;
var Mi = function(n, e) {
  var t = jn;
  const r = Li >= 15 && e > 0 ? { maxOutputLength: e } : {};
  return {
    inflate: function() {
      return t.inflateRawSync(n, r);
    },
    inflateAsync: function(s) {
      var a = t.createInflateRaw(r), i = [], o = 0;
      a.on("data", function(c) {
        i.push(c), o += c.length;
      }), a.on("end", function() {
        var c = Buffer.alloc(o), d = 0;
        c.fill(0);
        for (var l = 0; l < i.length; l++) {
          var m = i[l];
          m.copy(c, d), d += m.length;
        }
        s && s(c);
      }), a.end(n);
    }
  };
};
const { randomFillSync: kn } = ft, Pi = Zt, Ui = new Uint32Array(256).map((n, e) => {
  for (let t = 0; t < 8; t++)
    e & 1 ? e = e >>> 1 ^ 3988292384 : e >>>= 1;
  return e >>> 0;
}), Is = (n, e) => Math.imul(n, e) >>> 0, On = (n, e) => Ui[(n ^ e) & 255] ^ n >>> 8, Rt = () => typeof kn == "function" ? kn(Buffer.alloc(12)) : Rt.node();
Rt.node = () => {
  const n = Buffer.alloc(12), e = n.length;
  for (let t = 0; t < e; t++)
    n[t] = Math.random() * 256 & 255;
  return n;
};
const Ht = {
  genSalt: Rt
};
function er(n) {
  const e = Buffer.isBuffer(n) ? n : Buffer.from(n);
  this.keys = new Uint32Array([305419896, 591751049, 878082192]);
  for (let t = 0; t < e.length; t++)
    this.updateKeys(e[t]);
}
er.prototype.updateKeys = function(n) {
  const e = this.keys;
  return e[0] = On(e[0], n), e[1] += e[0] & 255, e[1] = Is(e[1], 134775813) + 1, e[2] = On(e[2], e[1] >>> 24), n;
};
er.prototype.next = function() {
  const n = (this.keys[2] | 2) >>> 0;
  return Is(n, n ^ 1) >> 8 & 255;
};
function $i(n) {
  const e = new er(n);
  return function(t) {
    const r = Buffer.alloc(t.length);
    let s = 0;
    for (let a of t)
      r[s++] = e.updateKeys(a ^ e.next());
    return r;
  };
}
function Bi(n) {
  const e = new er(n);
  return function(t, r, s = 0) {
    r || (r = Buffer.alloc(t.length));
    for (let a of t) {
      const i = e.next();
      r[s++] = a ^ i, e.updateKeys(a);
    }
    return r;
  };
}
function Fi(n, e, t) {
  if (!n || !Buffer.isBuffer(n) || n.length < 12)
    return Buffer.alloc(0);
  const r = $i(t), s = r(n.slice(0, 12)), a = (e.flags & 8) === 8 ? e.timeHighByte : e.crc >>> 24;
  if (s[11] !== a)
    throw Pi.WRONG_PASSWORD();
  return r(n.slice(12));
}
function qi(n) {
  Buffer.isBuffer(n) && n.length >= 12 ? Ht.genSalt = function() {
    return n.slice(0, 12);
  } : n === "node" ? Ht.genSalt = Rt.node : Ht.genSalt = Rt;
}
function ji(n, e, t, r = !1) {
  n == null && (n = Buffer.alloc(0)), Buffer.isBuffer(n) || (n = Buffer.from(n.toString()));
  const s = Bi(t), a = Ht.genSalt();
  a[11] = e.crc >>> 24 & 255, r && (a[10] = e.crc >>> 16 & 255);
  const i = Buffer.alloc(n.length + 12);
  return s(a, i), s(n, i, 12);
}
var Vi = { decrypt: Fi, encrypt: ji, _salter: qi };
Qt.Deflater = Oi;
Qt.Inflater = Mi;
Qt.ZipCrypto = Vi;
var oe = kt, Ji = Yt, he = oe.Constants, wr = Qt, ys = function(n, e) {
  var t = new Ji.EntryHeader(), r = Buffer.alloc(0), s = Buffer.alloc(0), a = !1, i = null, o = Buffer.alloc(0), c = Buffer.alloc(0), d = !0;
  const l = n, m = typeof l.decoder == "object" ? l.decoder : oe.decoder;
  d = m.hasOwnProperty("efs") ? m.efs : !1;
  function h() {
    return !e || !(e instanceof Uint8Array) ? Buffer.alloc(0) : (c = t.loadLocalHeaderFromBinary(e), e.slice(t.realDataOffset, t.realDataOffset + t.compressedSize));
  }
  function p(I) {
    if (t.flags_desc) {
      const y = {}, A = t.realDataOffset + t.compressedSize;
      if (e.readUInt32LE(A) == he.LOCSIG || e.readUInt32LE(A) == he.CENSIG)
        throw oe.Errors.DESCRIPTOR_NOT_EXIST();
      if (e.readUInt32LE(A) == he.EXTSIG)
        y.crc = e.readUInt32LE(A + he.EXTCRC), y.compressedSize = e.readUInt32LE(A + he.EXTSIZ), y.size = e.readUInt32LE(A + he.EXTLEN);
      else if (e.readUInt16LE(A + 12) === 19280)
        y.crc = e.readUInt32LE(A + he.EXTCRC - 4), y.compressedSize = e.readUInt32LE(A + he.EXTSIZ - 4), y.size = e.readUInt32LE(A + he.EXTLEN - 4);
      else
        throw oe.Errors.DESCRIPTOR_UNKNOWN();
      if (y.compressedSize !== t.compressedSize || y.size !== t.size || y.crc !== t.crc)
        throw oe.Errors.DESCRIPTOR_FAULTY();
      if (oe.crc32(I) !== y.crc)
        return !1;
    } else if (oe.crc32(I) !== t.localHeader.crc)
      return !1;
    return !0;
  }
  function f(I, y, A) {
    if (typeof y > "u" && typeof I == "string" && (A = I, I = void 0), a)
      return I && y && y(Buffer.alloc(0), oe.Errors.DIRECTORY_CONTENT_ERROR()), Buffer.alloc(0);
    var C = h();
    if (C.length === 0)
      return I && y && y(C), C;
    if (t.encrypted) {
      if (typeof A != "string" && !Buffer.isBuffer(A))
        throw oe.Errors.INVALID_PASS_PARAM();
      C = wr.ZipCrypto.decrypt(C, t, A);
    }
    var E = Buffer.alloc(t.size);
    switch (t.method) {
      case oe.Constants.STORED:
        if (C.copy(E), p(E))
          return I && y && y(E), E;
        throw I && y && y(E, oe.Errors.BAD_CRC()), oe.Errors.BAD_CRC();
      case oe.Constants.DEFLATED:
        var T = new wr.Inflater(C, t.size);
        if (I)
          T.inflateAsync(function(R) {
            R.copy(R, 0), y && (p(R) ? y(R) : y(R, oe.Errors.BAD_CRC()));
          });
        else {
          if (T.inflate(E).copy(E, 0), !p(E))
            throw oe.Errors.BAD_CRC(`"${m.decode(r)}"`);
          return E;
        }
        break;
      default:
        throw I && y && y(Buffer.alloc(0), oe.Errors.UNKNOWN_METHOD()), oe.Errors.UNKNOWN_METHOD();
    }
  }
  function v(I, y) {
    if ((!i || !i.length) && Buffer.isBuffer(e))
      return I && y && y(h()), h();
    if (i.length && !a) {
      var A;
      switch (t.method) {
        case oe.Constants.STORED:
          return t.compressedSize = t.size, A = Buffer.alloc(i.length), i.copy(A), I && y && y(A), A;
        default:
        case oe.Constants.DEFLATED:
          var C = new wr.Deflater(i);
          if (I)
            C.deflateAsync(function(T) {
              A = Buffer.alloc(T.length), t.compressedSize = T.length, T.copy(A), y && y(A);
            });
          else {
            var E = C.deflate();
            return t.compressedSize = E.length, E;
          }
          C = null;
          break;
      }
    } else if (I && y)
      y(Buffer.alloc(0));
    else
      return Buffer.alloc(0);
  }
  function w(I, y) {
    return (I.readUInt32LE(y + 4) << 4) + I.readUInt32LE(y);
  }
  function g(I) {
    try {
      for (var y = 0, A, C, E; y + 4 < I.length; )
        A = I.readUInt16LE(y), y += 2, C = I.readUInt16LE(y), y += 2, E = I.slice(y, y + C), y += C, he.ID_ZIP64 === A && u(E);
    } catch {
      throw oe.Errors.EXTRA_FIELD_PARSE_ERROR();
    }
  }
  function u(I) {
    var y, A, C, E;
    I.length >= he.EF_ZIP64_SCOMP && (y = w(I, he.EF_ZIP64_SUNCOMP), t.size === he.EF_ZIP64_OR_32 && (t.size = y)), I.length >= he.EF_ZIP64_RHO && (A = w(I, he.EF_ZIP64_SCOMP), t.compressedSize === he.EF_ZIP64_OR_32 && (t.compressedSize = A)), I.length >= he.EF_ZIP64_DSN && (C = w(I, he.EF_ZIP64_RHO), t.offset === he.EF_ZIP64_OR_32 && (t.offset = C)), I.length >= he.EF_ZIP64_DSN + 4 && (E = I.readUInt32LE(he.EF_ZIP64_DSN), t.diskNumStart === he.EF_ZIP64_OR_16 && (t.diskNumStart = E));
  }
  return {
    get entryName() {
      return m.decode(r);
    },
    get rawEntryName() {
      return r;
    },
    set entryName(I) {
      r = oe.toBuffer(I, m.encode);
      var y = r[r.length - 1];
      a = y === 47 || y === 92, t.fileNameLength = r.length;
    },
    get efs() {
      return typeof d == "function" ? d(this.entryName) : d;
    },
    get extra() {
      return o;
    },
    set extra(I) {
      o = I, t.extraLength = I.length, g(I);
    },
    get comment() {
      return m.decode(s);
    },
    set comment(I) {
      if (s = oe.toBuffer(I, m.encode), t.commentLength = s.length, s.length > 65535)
        throw oe.Errors.COMMENT_TOO_LONG();
    },
    get name() {
      var I = m.decode(r);
      return a ? I.substr(I.length - 1).split("/").pop() : I.split("/").pop();
    },
    get isDirectory() {
      return a;
    },
    getCompressedData: function() {
      return v(!1, null);
    },
    getCompressedDataAsync: function(I) {
      v(!0, I);
    },
    setData: function(I) {
      i = oe.toBuffer(I, oe.decoder.encode), !a && i.length ? (t.size = i.length, t.method = oe.Constants.DEFLATED, t.crc = oe.crc32(I), t.changed = !0) : t.method = oe.Constants.STORED;
    },
    getData: function(I) {
      return t.changed ? i : f(!1, null, I);
    },
    getDataAsync: function(I, y) {
      t.changed ? I(i) : f(!0, I, y);
    },
    set attr(I) {
      t.attr = I;
    },
    get attr() {
      return t.attr;
    },
    set header(I) {
      t.loadFromBinary(I);
    },
    get header() {
      return t;
    },
    packCentralHeader: function() {
      t.flags_efs = this.efs, t.extraLength = o.length;
      var I = t.centralHeaderToBinary(), y = oe.Constants.CENHDR;
      return r.copy(I, y), y += r.length, o.copy(I, y), y += t.extraLength, s.copy(I, y), I;
    },
    packLocalHeader: function() {
      let I = 0;
      t.flags_efs = this.efs, t.extraLocalLength = c.length;
      const y = t.localHeaderToBinary(), A = Buffer.alloc(y.length + r.length + t.extraLocalLength);
      return y.copy(A, I), I += y.length, r.copy(A, I), I += r.length, c.copy(A, I), I += c.length, A;
    },
    toJSON: function() {
      const I = function(y) {
        return "<" + (y && y.length + " bytes buffer" || "null") + ">";
      };
      return {
        entryName: this.entryName,
        name: this.name,
        comment: this.comment,
        isDirectory: this.isDirectory,
        header: t.toJSON(),
        compressedData: I(e),
        data: I(i)
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
const Ln = ys, Hi = Yt, Ae = kt;
var zi = function(n, e) {
  var t = [], r = {}, s = Buffer.alloc(0), a = new Hi.MainHeader(), i = !1;
  const o = /* @__PURE__ */ new Set(), c = e, { noSort: d, decoder: l } = c;
  n ? p(c.readEntries) : i = !0;
  function m() {
    const v = /* @__PURE__ */ new Set();
    for (const w of Object.keys(r)) {
      const g = w.split("/");
      if (g.pop(), !!g.length)
        for (let u = 0; u < g.length; u++) {
          const I = g.slice(0, u + 1).join("/") + "/";
          v.add(I);
        }
    }
    for (const w of v)
      if (!(w in r)) {
        const g = new Ln(c);
        g.entryName = w, g.attr = 16, g.temporary = !0, t.push(g), r[g.entryName] = g, o.add(g);
      }
  }
  function h() {
    if (i = !0, r = {}, a.diskEntries > (n.length - a.offset) / Ae.Constants.CENHDR)
      throw Ae.Errors.DISK_ENTRY_TOO_LARGE();
    t = new Array(a.diskEntries);
    for (var v = a.offset, w = 0; w < t.length; w++) {
      var g = v, u = new Ln(c, n);
      u.header = n.slice(g, g += Ae.Constants.CENHDR), u.entryName = n.slice(g, g += u.header.fileNameLength), u.header.extraLength && (u.extra = n.slice(g, g += u.header.extraLength)), u.header.commentLength && (u.comment = n.slice(g, g + u.header.commentLength)), v += u.header.centralHeaderSize, t[w] = u, r[u.entryName] = u;
    }
    o.clear(), m();
  }
  function p(v) {
    var w = n.length - Ae.Constants.ENDHDR, g = Math.max(0, w - 65535), u = g, I = n.length, y = -1, A = 0;
    for ((typeof c.trailingSpace == "boolean" ? c.trailingSpace : !1) && (g = 0), w; w >= u; w--)
      if (n[w] === 80) {
        if (n.readUInt32LE(w) === Ae.Constants.ENDSIG) {
          y = w, A = w, I = w + Ae.Constants.ENDHDR, u = w - Ae.Constants.END64HDR;
          continue;
        }
        if (n.readUInt32LE(w) === Ae.Constants.END64SIG) {
          u = g;
          continue;
        }
        if (n.readUInt32LE(w) === Ae.Constants.ZIP64SIG) {
          y = w, I = w + Ae.readBigUInt64LE(n, w + Ae.Constants.ZIP64SIZE) + Ae.Constants.ZIP64LEAD;
          break;
        }
      }
    if (y == -1)
      throw Ae.Errors.INVALID_FORMAT();
    a.loadFromBinary(n.slice(y, I)), a.commentLength && (s = n.slice(A + Ae.Constants.ENDHDR)), v && h();
  }
  function f() {
    t.length > 1 && !d && t.sort((v, w) => v.entryName.toLowerCase().localeCompare(w.entryName.toLowerCase()));
  }
  return {
    /**
     * Returns an array of ZipEntry objects existent in the current opened archive
     * @return Array
     */
    get entries() {
      return i || h(), t.filter((v) => !o.has(v));
    },
    /**
     * Archive comment
     * @return {String}
     */
    get comment() {
      return l.decode(s);
    },
    set comment(v) {
      s = Ae.toBuffer(v, l.encode), a.commentLength = s.length;
    },
    getEntryCount: function() {
      return i ? t.length : a.diskEntries;
    },
    forEach: function(v) {
      this.entries.forEach(v);
    },
    /**
     * Returns a reference to the entry with the given name or null if entry is inexistent
     *
     * @param entryName
     * @return ZipEntry
     */
    getEntry: function(v) {
      return i || h(), r[v] || null;
    },
    /**
     * Adds the given entry to the entry list
     *
     * @param entry
     */
    setEntry: function(v) {
      i || h(), t.push(v), r[v.entryName] = v, a.totalEntries = t.length;
    },
    /**
     * Removes the file with the given name from the entry list.
     *
     * If the entry is a directory, then all nested files and directories will be removed
     * @param entryName
     * @returns {void}
     */
    deleteFile: function(v, w = !0) {
      i || h();
      const g = r[v];
      this.getEntryChildren(g, w).map((I) => I.entryName).forEach(this.deleteEntry);
    },
    /**
     * Removes the entry with the given name from the entry list.
     *
     * @param {string} entryName
     * @returns {void}
     */
    deleteEntry: function(v) {
      i || h();
      const w = r[v], g = t.indexOf(w);
      g >= 0 && (t.splice(g, 1), delete r[v], a.totalEntries = t.length);
    },
    /**
     *  Iterates and returns all nested files and directories of the given entry
     *
     * @param entry
     * @return Array
     */
    getEntryChildren: function(v, w = !0) {
      if (i || h(), typeof v == "object")
        if (v.isDirectory && w) {
          const g = [], u = v.entryName;
          for (const I of t)
            I.entryName.startsWith(u) && g.push(I);
          return g;
        } else
          return [v];
      return [];
    },
    /**
     *  How many child elements entry has
     *
     * @param {ZipEntry} entry
     * @return {integer}
     */
    getChildCount: function(v) {
      if (v && v.isDirectory) {
        const w = this.getEntryChildren(v);
        return w.includes(v) ? w.length - 1 : w.length;
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
      const v = [], w = [];
      let g = 0, u = 0;
      a.size = 0, a.offset = 0;
      let I = 0;
      for (const C of this.entries) {
        const E = C.getCompressedData();
        C.header.offset = u;
        const T = C.packLocalHeader(), R = T.length + E.length;
        u += R, v.push(T), v.push(E);
        const M = C.packCentralHeader();
        w.push(M), a.size += M.length, g += R + M.length, I++;
      }
      g += a.mainHeaderSize, a.offset = u, a.totalEntries = I, u = 0;
      const y = Buffer.alloc(g);
      for (const C of v)
        C.copy(y, u), u += C.length;
      for (const C of w)
        C.copy(y, u), u += C.length;
      const A = a.toBinary();
      return s && s.copy(A, Ae.Constants.ENDHDR), A.copy(y, u), n = y, i = !1, y;
    },
    toAsyncBuffer: function(v, w, g, u) {
      try {
        i || h(), f();
        const I = [], y = [];
        let A = 0, C = 0, E = 0;
        a.size = 0, a.offset = 0;
        const T = function(R) {
          if (R.length > 0) {
            const M = R.shift(), J = M.entryName + M.extra.toString();
            g && g(J), M.getCompressedDataAsync(function(F) {
              u && u(J), M.header.offset = C;
              const Y = M.packLocalHeader(), L = Y.length + F.length;
              C += L, I.push(Y), I.push(F);
              const ae = M.packCentralHeader();
              y.push(ae), a.size += ae.length, A += L + ae.length, E++, T(R);
            });
          } else {
            A += a.mainHeaderSize, a.offset = C, a.totalEntries = E, C = 0;
            const M = Buffer.alloc(A);
            I.forEach(function(F) {
              F.copy(M, C), C += F.length;
            }), y.forEach(function(F) {
              F.copy(M, C), C += F.length;
            });
            const J = a.toBinary();
            s && s.copy(J, Ae.Constants.ENDHDR), J.copy(M, C), n = M, i = !1, v(M);
          }
        };
        T(Array.from(this.entries));
      } catch (I) {
        w(I);
      }
    }
  };
};
const ue = kt, me = Ge, Wi = ys, Gi = zi, ct = (...n) => ue.findLast(n, (e) => typeof e == "boolean"), Mn = (...n) => ue.findLast(n, (e) => typeof e == "string"), Ki = (...n) => ue.findLast(n, (e) => typeof e == "function"), Xi = {
  // option "noSort" : if true it disables files sorting
  noSort: !1,
  // read entries during load (initial loading may be slower)
  readEntries: !1,
  // default method is none
  method: ue.Constants.NONE,
  // file system
  fs: null
};
var Zi = function(n, e) {
  let t = null;
  const r = Object.assign(/* @__PURE__ */ Object.create(null), Xi);
  n && typeof n == "object" && (n instanceof Uint8Array || (Object.assign(r, n), n = r.input ? r.input : void 0, r.input && delete r.input), Buffer.isBuffer(n) && (t = n, r.method = ue.Constants.BUFFER, n = void 0)), Object.assign(r, e);
  const s = new ue(r);
  if ((typeof r.decoder != "object" || typeof r.decoder.encode != "function" || typeof r.decoder.decode != "function") && (r.decoder = ue.decoder), n && typeof n == "string")
    if (s.fs.existsSync(n))
      r.method = ue.Constants.FILE, r.filename = n, t = s.fs.readFileSync(n);
    else
      throw ue.Errors.INVALID_FILENAME();
  const a = new Gi(t, r), { canonical: i, sanitize: o, zipnamefix: c } = ue;
  function d(p) {
    if (p && a) {
      var f;
      if (typeof p == "string" && (f = a.getEntry(me.posix.normalize(p))), typeof p == "object" && typeof p.entryName < "u" && typeof p.header < "u" && (f = a.getEntry(p.entryName)), f)
        return f;
    }
    return null;
  }
  function l(p) {
    const { join: f, normalize: v, sep: w } = me.posix;
    return f(".", v(w + p.split("\\").join(w) + w));
  }
  function m(p) {
    return p instanceof RegExp ? /* @__PURE__ */ function(f) {
      return function(v) {
        return f.test(v);
      };
    }(p) : typeof p != "function" ? () => !0 : p;
  }
  const h = (p, f) => {
    let v = f.slice(-1);
    return v = v === s.sep ? s.sep : "", me.relative(p, f) + v;
  };
  return {
    /**
     * Extracts the given entry from the archive and returns the content as a Buffer object
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {Buffer|string} [pass] - password
     * @return Buffer or Null in case of error
     */
    readFile: function(p, f) {
      var v = d(p);
      return v && v.getData(f) || null;
    },
    /**
     * Returns how many child elements has on entry (directories) on files it is always 0
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @returns {integer}
     */
    childCount: function(p) {
      const f = d(p);
      if (f)
        return a.getChildCount(f);
    },
    /**
     * Asynchronous readFile
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {callback} callback
     *
     * @return Buffer or Null in case of error
     */
    readFileAsync: function(p, f) {
      var v = d(p);
      v ? v.getDataAsync(f) : f(null, "getEntry failed for:" + p);
    },
    /**
     * Extracts the given entry from the archive and returns the content as plain text in the given encoding
     * @param {ZipEntry|string} entry - ZipEntry object or String with the full path of the entry
     * @param {string} encoding - Optional. If no encoding is specified utf8 is used
     *
     * @return String
     */
    readAsText: function(p, f) {
      var v = d(p);
      if (v) {
        var w = v.getData();
        if (w && w.length)
          return w.toString(f || "utf8");
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
    readAsTextAsync: function(p, f, v) {
      var w = d(p);
      w ? w.getDataAsync(function(g, u) {
        if (u) {
          f(g, u);
          return;
        }
        g && g.length ? f(g.toString(v || "utf8")) : f("");
      }) : f("");
    },
    /**
     * Remove the entry from the file or the entry and all it's nested directories and files if the given entry is a directory
     *
     * @param {ZipEntry|string} entry
     * @returns {void}
     */
    deleteFile: function(p, f = !0) {
      var v = d(p);
      v && a.deleteFile(v.entryName, f);
    },
    /**
     * Remove the entry from the file or directory without affecting any nested entries
     *
     * @param {ZipEntry|string} entry
     * @returns {void}
     */
    deleteEntry: function(p) {
      var f = d(p);
      f && a.deleteEntry(f.entryName);
    },
    /**
     * Adds a comment to the zip. The zip must be rewritten after adding the comment.
     *
     * @param {string} comment
     */
    addZipComment: function(p) {
      a.comment = p;
    },
    /**
     * Returns the zip comment
     *
     * @return String
     */
    getZipComment: function() {
      return a.comment || "";
    },
    /**
     * Adds a comment to a specified zipEntry. The zip must be rewritten after adding the comment
     * The comment cannot exceed 65535 characters in length
     *
     * @param {ZipEntry} entry
     * @param {string} comment
     */
    addZipEntryComment: function(p, f) {
      var v = d(p);
      v && (v.comment = f);
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
      var v = d(p);
      v && v.setData(f);
    },
    /**
     * Adds a file from the disk to the archive
     *
     * @param {string} localPath File to add to zip
     * @param {string} [zipPath] Optional path inside the zip
     * @param {string} [zipName] Optional name for the file
     * @param {string} [comment] Optional file comment
     */
    addLocalFile: function(p, f, v, w) {
      if (s.fs.existsSync(p)) {
        f = f ? l(f) : "";
        const g = me.win32.basename(me.win32.normalize(p));
        f += v || g;
        const u = s.fs.statSync(p), I = u.isFile() ? s.fs.readFileSync(p) : Buffer.alloc(0);
        u.isDirectory() && (f += s.sep), this.addFile(f, I, w, u);
      } else
        throw ue.Errors.FILE_NOT_FOUND(p);
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
      const v = me.resolve(p.localPath), { comment: w } = p;
      let { zipPath: g, zipName: u } = p;
      const I = this;
      s.fs.stat(v, function(y, A) {
        if (y)
          return f(y, !1);
        g = g ? l(g) : "";
        const C = me.win32.basename(me.win32.normalize(v));
        if (g += u || C, A.isFile())
          s.fs.readFile(v, function(E, T) {
            return E ? f(E, !1) : (I.addFile(g, T, w, A), setImmediate(f, void 0, !0));
          });
        else if (A.isDirectory())
          return g += s.sep, I.addFile(g, Buffer.alloc(0), w, A), setImmediate(f, void 0, !0);
      });
    },
    /**
     * Adds a local directory and all its nested files and directories to the archive
     *
     * @param {string} localPath - local path to the folder
     * @param {string} [zipPath] - optional path inside zip
     * @param {(RegExp|function)} [filter] - optional RegExp or Function if files match will be included.
     */
    addLocalFolder: function(p, f, v) {
      if (v = m(v), f = f ? l(f) : "", p = me.normalize(p), s.fs.existsSync(p)) {
        const w = s.findFiles(p), g = this;
        if (w.length)
          for (const u of w) {
            const I = me.join(f, h(p, u));
            v(I) && g.addLocalFile(u, me.dirname(I));
          }
      } else
        throw ue.Errors.FILE_NOT_FOUND(p);
    },
    /**
     * Asynchronous addLocalFolder
     * @param {string} localPath
     * @param {callback} callback
     * @param {string} [zipPath] optional path inside zip
     * @param {RegExp|function} [filter] optional RegExp or Function if files match will
     *               be included.
     */
    addLocalFolderAsync: function(p, f, v, w) {
      w = m(w), v = v ? l(v) : "", p = me.normalize(p);
      var g = this;
      s.fs.open(p, "r", function(u) {
        if (u && u.code === "ENOENT")
          f(void 0, ue.Errors.FILE_NOT_FOUND(p));
        else if (u)
          f(void 0, u);
        else {
          var I = s.findFiles(p), y = -1, A = function() {
            if (y += 1, y < I.length) {
              var C = I[y], E = h(p, C).split("\\").join("/");
              E = E.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, ""), w(E) ? s.fs.stat(C, function(T, R) {
                T && f(void 0, T), R.isFile() ? s.fs.readFile(C, function(M, J) {
                  M ? f(void 0, M) : (g.addFile(v + E, J, "", R), A());
                }) : (g.addFile(v + E + "/", Buffer.alloc(0), "", R), A());
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
      const v = this;
      p = typeof p == "object" ? p : { localPath: p }, localPath = me.resolve(l(p.localPath));
      let { zipPath: w, filter: g, namefix: u } = p;
      g instanceof RegExp ? g = /* @__PURE__ */ function(A) {
        return function(C) {
          return A.test(C);
        };
      }(g) : typeof g != "function" && (g = function() {
        return !0;
      }), w = w ? l(w) : "", u == "latin1" && (u = (A) => A.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "")), typeof u != "function" && (u = (A) => A);
      const I = (A) => me.join(w, u(h(localPath, A))), y = (A) => me.win32.basename(me.win32.normalize(u(A)));
      s.fs.open(localPath, "r", function(A) {
        A && A.code === "ENOENT" ? f(void 0, ue.Errors.FILE_NOT_FOUND(localPath)) : A ? f(void 0, A) : s.findFilesAsync(localPath, function(C, E) {
          if (C)
            return f(C);
          E = E.filter((T) => g(I(T))), E.length || f(void 0, !1), setImmediate(
            E.reverse().reduce(function(T, R) {
              return function(M, J) {
                if (M || J === !1)
                  return setImmediate(T, M, !1);
                v.addLocalFileAsync(
                  {
                    localPath: R,
                    zipPath: me.dirname(I(R)),
                    zipName: y(R)
                  },
                  T
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
      return new Promise((v, w) => {
        this.addLocalFolderAsync2(Object.assign({ localPath: p }, f), (g, u) => {
          g && w(g), u && v(this);
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
    addFile: function(p, f, v, w) {
      p = c(p);
      let g = d(p);
      const u = g != null;
      u || (g = new Wi(r), g.entryName = p), g.comment = v || "";
      const I = typeof w == "object" && w instanceof s.fs.Stats;
      I && (g.header.time = w.mtime);
      var y = g.isDirectory ? 16 : 0;
      let A = g.isDirectory ? 16384 : 32768;
      return I ? A |= 4095 & w.mode : typeof w == "number" ? A |= 4095 & w : A |= g.isDirectory ? 493 : 420, y = (y | A << 16) >>> 0, g.attr = y, g.setData(f), u || a.setEntry(g), g;
    },
    /**
     * Returns an array of ZipEntry objects representing the files and folders inside the archive
     *
     * @param {string} [password]
     * @returns Array
     */
    getEntries: function(p) {
      return a.password = p, a ? a.entries : [];
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
      return a.getEntryCount();
    },
    forEach: function(p) {
      return a.forEach(p);
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
    extractEntryTo: function(p, f, v, w, g, u) {
      w = ct(!1, w), g = ct(!1, g), v = ct(!0, v), u = Mn(g, u);
      var I = d(p);
      if (!I)
        throw ue.Errors.NO_ENTRY();
      var y = i(I.entryName), A = o(f, u && !I.isDirectory ? u : v ? y : me.basename(y));
      if (I.isDirectory) {
        var C = a.getEntryChildren(I);
        return C.forEach(function(R) {
          if (R.isDirectory)
            return;
          var M = R.getData();
          if (!M)
            throw ue.Errors.CANT_EXTRACT_FILE();
          var J = i(R.entryName), F = o(f, v ? J : me.basename(J));
          const Y = g ? R.header.fileAttr : void 0;
          s.writeFileTo(F, M, w, Y);
        }), !0;
      }
      var E = I.getData(a.password);
      if (!E)
        throw ue.Errors.CANT_EXTRACT_FILE();
      if (s.fs.existsSync(A) && !w)
        throw ue.Errors.CANT_OVERRIDE();
      const T = g ? p.header.fileAttr : void 0;
      return s.writeFileTo(A, E, w, T), !0;
    },
    /**
     * Test the archive
     * @param {string} [pass]
     */
    test: function(p) {
      if (!a)
        return !1;
      for (var f in a.entries)
        try {
          if (f.isDirectory)
            continue;
          var v = a.entries[f].getData(p);
          if (!v)
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
    extractAllTo: function(p, f, v, w) {
      if (v = ct(!1, v), w = Mn(v, w), f = ct(!1, f), !a)
        throw ue.Errors.NO_ZIP();
      a.entries.forEach(function(g) {
        var u = o(p, i(g.entryName));
        if (g.isDirectory) {
          s.makeDir(u);
          return;
        }
        var I = g.getData(w);
        if (!I)
          throw ue.Errors.CANT_EXTRACT_FILE();
        const y = v ? g.header.fileAttr : void 0;
        s.writeFileTo(u, I, f, y);
        try {
          s.fs.utimesSync(u, g.header.time, g.header.time);
        } catch {
          throw ue.Errors.CANT_EXTRACT_FILE();
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
    extractAllToAsync: function(p, f, v, w) {
      if (w = Ki(f, v, w), v = ct(!1, v), f = ct(!1, f), !w)
        return new Promise((A, C) => {
          this.extractAllToAsync(p, f, v, function(E) {
            E ? C(E) : A(this);
          });
        });
      if (!a) {
        w(ue.Errors.NO_ZIP());
        return;
      }
      p = me.resolve(p);
      const g = (A) => o(p, me.normalize(i(A.entryName))), u = (A, C) => new Error(A + ': "' + C + '"'), I = [], y = [];
      a.entries.forEach((A) => {
        A.isDirectory ? I.push(A) : y.push(A);
      });
      for (const A of I) {
        const C = g(A), E = v ? A.header.fileAttr : void 0;
        try {
          s.makeDir(C), E && s.fs.chmodSync(C, E), s.fs.utimesSync(C, A.header.time, A.header.time);
        } catch {
          w(u("Unable to create folder", C));
        }
      }
      y.reverse().reduce(function(A, C) {
        return function(E) {
          if (E)
            A(E);
          else {
            const T = me.normalize(i(C.entryName)), R = o(p, T);
            C.getDataAsync(function(M, J) {
              if (J)
                A(J);
              else if (!M)
                A(ue.Errors.CANT_EXTRACT_FILE());
              else {
                const F = v ? C.header.fileAttr : void 0;
                s.writeFileToAsync(R, M, f, F, function(Y) {
                  Y || A(u("Unable to write file", R)), s.fs.utimes(R, C.header.time, C.header.time, function(L) {
                    L ? A(u("Unable to set times", R)) : A();
                  });
                });
              }
            });
          }
        };
      }, w)();
    },
    /**
     * Writes the newly created zip file to disk at the specified location or if a zip was opened and no ``targetFileName`` is provided, it will overwrite the opened zip
     *
     * @param {string} targetFileName
     * @param {function} callback
     */
    writeZip: function(p, f) {
      if (arguments.length === 1 && typeof p == "function" && (f = p, p = ""), !p && r.filename && (p = r.filename), !!p) {
        var v = a.compressToBuffer();
        if (v) {
          var w = s.writeFileTo(p, v, !0);
          typeof f == "function" && f(w ? null : new Error("failed"), "");
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
      const { overwrite: v, perm: w } = Object.assign({ overwrite: !0 }, f);
      return new Promise((g, u) => {
        !p && r.filename && (p = r.filename), p || u("ADM-ZIP: ZIP File Name Missing"), this.toBufferPromise().then((I) => {
          const y = (A) => A ? g(A) : u("ADM-ZIP: Wasn't able to write zip file");
          s.writeFileToAsync(p, I, v, w, y);
        }, u);
      });
    },
    /**
     * @returns {Promise<Buffer>} A promise to the Buffer.
     */
    toBufferPromise: function() {
      return new Promise((p, f) => {
        a.toAsyncBuffer(p, f);
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
    toBuffer: function(p, f, v, w) {
      return typeof p == "function" ? (a.toAsyncBuffer(p, f, v, w), null) : a.compressToBuffer();
    }
  };
};
const Pn = /* @__PURE__ */ Ei(Zi);
class Yi {
  getBackupDir() {
    return Ge.join(V.getPath("userData"), "backups");
  }
  getAutoBackupDir() {
    return Ge.join(this.getBackupDir(), "auto");
  }
  ensureBackupDirs() {
    const e = this.getBackupDir(), t = this.getAutoBackupDir();
    q.existsSync(e) || q.mkdirSync(e, { recursive: !0 }), q.existsSync(t) || q.mkdirSync(t, { recursive: !0 });
  }
  // --- Encryption Helpers ---
  deriveKey(e, t) {
    return ft.pbkdf2Sync(e, t, 1e5, 32, "sha256");
  }
  encryptData(e, t) {
    const r = ft.randomBytes(16), s = ft.randomBytes(12), a = this.deriveKey(t, r), i = ft.createCipheriv("aes-256-gcm", a, s), o = Buffer.concat([i.update(e), i.final()]), c = i.getAuthTag();
    return {
      encryptedData: o,
      salt: r.toString("hex"),
      iv: s.toString("hex"),
      authTag: c.toString("hex")
    };
  }
  decryptData(e, t, r) {
    const s = Buffer.from(r.salt, "hex"), a = Buffer.from(r.iv, "hex"), i = Buffer.from(r.authTag, "hex"), o = this.deriveKey(t, s), c = ft.createDecipheriv("aes-256-gcm", o, a);
    return c.setAuthTag(i), Buffer.concat([c.update(e), c.final()]);
  }
  // --- Core Logic ---
  // 1. Export Data
  async exportData(e, t) {
    const [r, s, a, i, o, c] = await Promise.all([
      S.novel.findMany(),
      S.volume.findMany(),
      S.chapter.findMany(),
      S.character.findMany(),
      S.idea.findMany(),
      S.tag.findMany()
    ]), d = { novels: r, volumes: s, chapters: a, characters: i, ideas: o, tags: c }, l = Buffer.from(JSON.stringify(d)), m = new Pn(), h = {
      version: 1,
      appVersion: V.getVersion(),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      platform: process.platform,
      encrypted: !!t
    };
    if (t) {
      const { encryptedData: p, salt: f, iv: v, authTag: w } = this.encryptData(l, t);
      h.encryption = { algo: "aes-256-gcm", salt: f, iv: v, authTag: w }, m.addFile("data.bin", p);
    } else
      m.addFile("data.json", l);
    if (m.addFile("manifest.json", Buffer.from(JSON.stringify(h, null, 2))), !e) {
      const { filePath: p } = await yt.showSaveDialog({
        title: "Export Backup",
        defaultPath: `NovelData_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")}.nebak`,
        filters: [{ name: "CloudDream Novel Agent Backup", extensions: ["nebak"] }]
      });
      if (!p)
        throw new Error("Export cancelled");
      e = p;
    }
    return m.writeZip(e), e;
  }
  // 2. Import Data (Restore)
  async importData(e, t) {
    const r = new Pn(e), s = r.getEntry("manifest.json");
    if (!s)
      throw new Error("Invalid backup file: manifest.json missing");
    const a = JSON.parse(s.getData().toString("utf8"));
    let i;
    if (a.encrypted) {
      if (!t)
        throw new Error("PASSWORD_REQUIRED");
      const o = r.getEntry("data.bin");
      if (!o)
        throw new Error("Invalid backup file: data.bin missing");
      if (!a.encryption)
        throw new Error("Invalid backup file: encryption metadata missing");
      try {
        const c = this.decryptData(o.getData(), t, a.encryption);
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
      var r, s, a, i, o, c;
      if (await t.tag.deleteMany(), await t.idea.deleteMany(), await t.character.deleteMany(), await t.chapter.deleteMany(), await t.volume.deleteMany(), await t.novel.deleteMany(), (r = e.novels) != null && r.length)
        for (const d of e.novels)
          await t.novel.create({ data: d });
      if ((s = e.volumes) != null && s.length)
        for (const d of e.volumes)
          await t.volume.create({ data: d });
      if ((a = e.chapters) != null && a.length)
        for (const d of e.chapters)
          await t.chapter.create({ data: d });
      if ((i = e.characters) != null && i.length)
        for (const d of e.characters)
          await t.character.create({ data: d });
      if ((o = e.ideas) != null && o.length)
        for (const d of e.ideas)
          await t.idea.create({ data: d });
      if ((c = e.tags) != null && c.length)
        for (const d of e.tags)
          await t.tag.create({ data: d });
    }, {
      maxWait: 1e4,
      timeout: 2e4
    });
  }
  // 3. Auto Backup Logic
  async createAutoBackup() {
    try {
      this.ensureBackupDirs();
      const t = `auto_backup_${Date.now()}.nebak`, r = Ge.join(this.getAutoBackupDir(), t);
      await this.exportData(r), console.log("[BackupService] Auto-backup created:", t), await this.rotateAutoBackups();
    } catch (e) {
      console.error("[BackupService] Failed to create auto-backup:", e);
    }
  }
  async rotateAutoBackups() {
    this.ensureBackupDirs();
    const e = this.getAutoBackupDir(), r = q.readdirSync(e).filter((s) => s.endsWith(".nebak")).map((s) => ({
      name: s,
      time: q.statSync(Ge.join(e, s)).mtime.getTime()
    })).sort((s, a) => a.time - s.time).slice(3);
    for (const s of r)
      q.unlinkSync(Ge.join(e, s.name)), console.log("[BackupService] Rotated auto-backup:", s.name);
  }
  // 4. List Auto Backups
  async getAutoBackups() {
    this.ensureBackupDirs();
    const e = this.getAutoBackupDir();
    return q.readdirSync(e).filter((t) => t.endsWith(".nebak")).map((t) => {
      const r = q.statSync(Ge.join(e, t));
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
    const t = Ge.join(this.getAutoBackupDir(), e);
    if (!q.existsSync(t))
      throw new Error("Backup file not found");
    await this.importData(t);
  }
}
const tr = new Yi(), xt = k.dirname(Ms(import.meta.url));
process.env.APP_ROOT = k.join(xt, "..");
const _r = process.env.VITE_DEV_SERVER_URL, Dc = k.join(process.env.APP_ROOT, "dist-electron"), ws = k.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = _r ? k.join(process.env.APP_ROOT, "public") : ws;
process.on("uncaughtException", (n) => {
  Se("Main.uncaughtException", n), console.error("[Main] Uncaught Exception:", n), V.quit(), process.exit(1);
});
process.on("unhandledRejection", (n, e) => {
  Se("Main.unhandledRejection", n, { promise: String(e) }), console.error("[Main] Unhandled Rejection at:", e, "reason:", n), V.quit(), process.exit(1);
});
let j, Un = !1;
const Ss = "云梦小说智能体", Qi = "云梦小说编辑器", ec = "CloudDream Novel Agent Dev";
function tc() {
  return V.isPackaged && process.platform === "win32" ? process.execPath : "com.noveleditor.app";
}
function $r() {
  return V.isPackaged && typeof process.env.PORTABLE_EXECUTABLE_DIR == "string" && process.env.PORTABLE_EXECUTABLE_DIR.length > 0;
}
function As() {
  return k.join(k.dirname(V.getPath("exe")), "data");
}
function rc() {
  const n = process.env.PORTABLE_EXECUTABLE_DIR;
  return n ? k.join(n, "data") : As();
}
function Es(n, e) {
  if (!q.existsSync(n))
    return;
  q.existsSync(e) || q.mkdirSync(e, { recursive: !0 });
  const t = q.readdirSync(n, { withFileTypes: !0 });
  for (const r of t) {
    const s = k.join(n, r.name), a = k.join(e, r.name);
    if (!q.existsSync(a)) {
      if (r.isDirectory()) {
        q.cpSync(s, a, { recursive: !0 });
        continue;
      }
      q.copyFileSync(s, a);
    }
  }
}
function nc() {
  if (!V.isPackaged || $r())
    return;
  const n = As(), e = V.getPath("userData"), t = k.join(n, "novel_editor.db"), r = k.join(e, "novel_editor.db");
  !q.existsSync(t) || q.existsSync(r) || (Es(n, e), console.log("[Main] Migrated legacy packaged data from exe/data to userData."));
}
function sc() {
  if (!V.isPackaged || $r())
    return;
  const n = V.getPath("appData"), e = k.join(n, Qi), t = V.getPath("userData"), r = k.join(e, "novel_editor.db"), s = k.join(t, "novel_editor.db");
  !q.existsSync(r) || q.existsSync(s) || (Es(e, t), console.log("[Main] Migrated legacy product data from old app name to current userData."));
}
function ac() {
  if (V.isPackaged) {
    const t = k.join(process.resourcesPath, "icon_ink_pen_256.ico");
    return q.existsSync(t) ? t : void 0;
  }
  const n = k.join(process.env.APP_ROOT || "", "build", "icon_ink_pen_256.ico");
  if (q.existsSync(n))
    return n;
  const e = k.join(process.env.VITE_PUBLIC || "", "electron-vite.svg");
  return q.existsSync(e) ? e : void 0;
}
function oc() {
  const n = V.getPath("appData");
  return V.isPackaged ? k.join(n, Ss) : k.join(n, "@novel-editor", "desktop-dev");
}
function $n(n) {
  return n ? /[ \t"]/u.test(n) ? `"${n.replace(/"/gu, '\\"')}"` : n : '""';
}
function ic() {
  return V.isPackaged ? process.platform === "win32" ? k.join(process.resourcesPath, "mcp", "novel-editor-mcp.cmd") : k.join(process.resourcesPath, "mcp", "novel-editor-mcp.mjs") : process.platform === "win32" ? k.join(process.env.APP_ROOT || "", "scripts", "novel-editor-mcp.cmd") : k.join(process.env.APP_ROOT || "", "scripts", "novel-editor-mcp.mjs");
}
function Cs() {
  const n = ic(), e = q.existsSync(n), t = "novel_editor", r = 60, s = 120, a = process.platform === "win32" ? "cmd" : "node", i = process.platform === "win32" ? ["/c", n] : [n], o = process.platform === "win32" ? [
    `[mcp_servers.${t}]`,
    'command = "cmd"',
    `args = ["/c", "${n.replace(/\\/gu, "\\\\")}"]`,
    `startup_timeout_sec = ${r}`,
    `tool_timeout_sec = ${s}`
  ].join(`
`) : [
    `[mcp_servers.${t}]`,
    'command = "node"',
    `args = ["${n}"]`,
    `startup_timeout_sec = ${r}`,
    `tool_timeout_sec = ${s}`
  ].join(`
`), c = process.platform === "win32" ? `claude mcp add novel-editor --scope local -- cmd /c ${$n(n)}` : `claude mcp add novel-editor --scope local -- node ${$n(n)}`, d = JSON.stringify(
    {
      mcpServers: {
        [t]: {
          command: a,
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
    command: a,
    args: i,
    codexToml: o,
    claudeCommand: c,
    jsonConfig: d
  };
}
function Ts() {
  return k.join(V.getPath("userData"), "automation", "runtime.json");
}
function cc() {
  const n = Ts();
  if (!q.existsSync(n))
    throw new Error(`Automation runtime file not found: ${n}`);
  let e;
  try {
    e = JSON.parse(q.readFileSync(n, "utf8"));
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
async function dc(n) {
  const t = JSON.stringify({
    method: "novel.list",
    params: {},
    origin: "desktop-ui"
  });
  return await new Promise((r, s) => {
    const a = Kt.request(
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
            s(new Error(`Automation health response parse failed: ${(d == null ? void 0 : d.message) || "unknown error"}`));
          }
        });
      }
    );
    a.setTimeout(8e3, () => {
      a.destroy(new Error("Automation health request timeout"));
    }), a.on("error", (i) => s(i)), a.write(t), a.end();
  });
}
async function lc() {
  const n = Cs();
  if (!n.launcherExists)
    return { ok: !1, detail: `MCP launcher missing: ${n.commandPath}` };
  let e;
  try {
    e = cc();
  } catch (t) {
    return { ok: !1, detail: (t == null ? void 0 : t.message) || "Automation runtime unavailable" };
  }
  try {
    const t = await dc(e);
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
function uc(n) {
  const e = n.indexOf("--ai-diag");
  if (e < 0)
    return {};
  const t = n.slice(e + 1);
  if (t.length === 0)
    return { error: "Missing diagnostic action. Use: --ai-diag smoke <mcp|skill> [--json] [--db <path>] [--user-data <path>] or --ai-diag coverage [--json] [--db <path>] [--user-data <path>]" };
  const r = [];
  let s = !1, a, i;
  for (let d = 0; d < t.length; d += 1) {
    const l = t[d];
    if (l === "--json") {
      s = !0;
      continue;
    }
    if (l === "--db") {
      const m = t[d + 1];
      if (!m)
        return { error: "Missing value for --db" };
      a = m, d += 1;
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
  return o === "coverage" ? { command: { action: "coverage", json: s, dbPath: a, userDataPath: i } } : o === "smoke" ? c !== "mcp" && c !== "skill" ? { error: "Smoke mode requires kind: mcp | skill" } : { command: { action: "smoke", kind: c, json: s, dbPath: a, userDataPath: i } } : { error: `Unknown diagnostic action: ${o}` };
}
function hc(n, e) {
  if (e.action === "coverage") {
    const s = n;
    return [
      `[AI-Diag] Coverage ${s.overallCoverage}% (${s.totalSupported}/${s.totalRequired})`,
      ...s.modules.map((i) => {
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
    ...t.checks.map((s) => `- [${s.skipped ? "SKIPPED" : s.ok ? "OK" : "FAILED"}] ${s.actionId}: ${s.detail}`)
  ].join(`
`);
}
async function mc(n, e) {
  const t = e.action === "coverage" ? n.getCapabilityCoverage() : await n.testOpenClawSmoke({ kind: e.kind });
  return e.json ? console.log(JSON.stringify(t, null, 2)) : console.log(hc(t, e)), e.action === "smoke" && !t.ok ? 1 : 0;
}
function Bn() {
  if (!Lr() || Un)
    return;
  Un = !0;
  const n = console.error.bind(console), e = console.warn.bind(console);
  console.error = (...t) => {
    B("ERROR", "console.error", "console.error called", { args: Ie(t) }), n(...t);
  }, console.warn = (...t) => {
    B("WARN", "console.warn", "console.warn called", { args: Ie(t) }), e(...t);
  };
}
function te(n, e, t) {
  const r = je(t);
  Se(`Main.${n}`, t, {
    payload: Ie(e),
    normalizedError: r,
    displayMessage: It(r.code, r.message)
  });
}
const He = uc(process.argv);
async function bs(n) {
  const e = n == null ? void 0 : n.proxy;
  if (!e || !Ot.defaultSession)
    return;
  const t = () => {
    delete process.env.HTTP_PROXY, delete process.env.http_proxy, delete process.env.HTTPS_PROXY, delete process.env.https_proxy, delete process.env.ALL_PROXY, delete process.env.all_proxy, delete process.env.NO_PROXY, delete process.env.no_proxy;
  }, r = () => {
    e.httpProxy && (process.env.HTTP_PROXY = e.httpProxy, process.env.http_proxy = e.httpProxy), e.httpsProxy && (process.env.HTTPS_PROXY = e.httpsProxy, process.env.https_proxy = e.httpsProxy), e.allProxy && (process.env.ALL_PROXY = e.allProxy, process.env.all_proxy = e.allProxy), e.noProxy && (process.env.NO_PROXY = e.noProxy, process.env.no_proxy = e.noProxy);
  };
  if (e.mode === "off") {
    await Ot.defaultSession.setProxy({ mode: "direct" }), t();
    return;
  }
  if (e.mode === "custom") {
    const s = [e.allProxy, e.httpsProxy, e.httpProxy].filter((a) => !!a).join(";");
    await Ot.defaultSession.setProxy({
      mode: s ? "fixed_servers" : "direct",
      proxyRules: s,
      proxyBypassRules: e.noProxy || ""
    }), t(), r();
    return;
  }
  await Ot.defaultSession.setProxy({ mode: "system" }), t();
}
function Ns() {
  const n = !V.isPackaged, e = ac();
  j = new Fn({
    width: 1200,
    height: 800,
    ...e ? { icon: e } : {},
    webPreferences: {
      preload: k.join(xt, "preload.mjs"),
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
  }), j.once("ready-to-show", () => {
    j == null || j.show();
  }), j.webContents.on("did-finish-load", () => {
    j == null || j.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), j.webContents.on("devtools-opened", () => {
    n || j == null || j.webContents.closeDevTools();
  }), j.webContents.on("before-input-event", (t, r) => {
    r.key === "F11" && (j == null || j.setFullScreen(!j.isFullScreen()), t.preventDefault()), n && (r.key === "F12" || r.control && r.shift && r.key.toLowerCase() === "i") && (j != null && j.webContents.isDevToolsOpened() ? j.webContents.closeDevTools() : j == null || j.webContents.openDevTools(), t.preventDefault());
  }), _r ? j.loadURL(_r) : j.loadFile(k.join(ws, "index.html")), j.on("enter-full-screen", () => {
    j == null || j.webContents.send("app:fullscreen-change", !0);
  }), j.on("leave-full-screen", () => {
    j == null || j.webContents.send("app:fullscreen-change", !1);
  });
}
N.handle("app:toggle-fullscreen", () => {
  if (j) {
    const n = j.isFullScreen();
    return j.setFullScreen(!n), !n;
  }
  return !1;
});
N.handle("app:get-user-data-path", () => V.getPath("userData"));
N.handle("db:get-novels", async () => {
  console.log("[Main] Received db:get-novels");
  try {
    return await S.novel.findMany({
      orderBy: { updatedAt: "desc" }
    });
  } catch (n) {
    throw console.error("[Main] db:get-novels failed:", n), n;
  }
});
N.handle("db:update-novel", async (n, { id: e, data: t }) => {
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
N.handle("db:delete-novel", async (n, e) => {
  var t;
  console.log("[Main] Received db:delete-novel:", e);
  try {
    const r = await S.novel.findUnique({
      where: { id: e },
      select: { coverUrl: !0 }
    });
    if ((t = r == null ? void 0 : r.coverUrl) != null && t.startsWith("covers/")) {
      const s = k.join(V.getPath("userData"), r.coverUrl);
      q.existsSync(s) && q.unlinkSync(s);
    }
    return await S.novel.delete({
      where: { id: e }
    }), { ok: !0 };
  } catch (r) {
    throw console.error("[Main] db:delete-novel failed:", r), r;
  }
});
N.handle("db:upload-novel-cover", async (n, e) => {
  var t;
  try {
    const r = await yt.showOpenDialog(j, {
      title: "Select Cover Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (r.canceled || r.filePaths.length === 0)
      return null;
    const s = r.filePaths[0], a = k.extname(s), i = k.join(V.getPath("userData"), "covers");
    q.existsSync(i) || q.mkdirSync(i, { recursive: !0 });
    const o = await S.novel.findUnique({ where: { id: e }, select: { coverUrl: !0 } });
    if ((t = o == null ? void 0 : o.coverUrl) != null && t.startsWith("covers/")) {
      const m = k.join(V.getPath("userData"), o.coverUrl);
      q.existsSync(m) && q.unlinkSync(m);
    }
    const c = `${e}${a}`, d = k.join(i, c);
    q.copyFileSync(s, d);
    const l = `covers/${c}`;
    return await S.novel.update({
      where: { id: e },
      data: { coverUrl: l }
    }), { path: l };
  } catch (r) {
    throw console.error("[Main] db:upload-novel-cover failed:", r), r;
  }
});
N.handle("db:get-volumes", async (n, e) => {
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
N.handle("db:get-agent-conversations", async (n, e) => {
  try {
    return await rr.list(e);
  } catch (t) {
    throw console.error("[Main] db:get-agent-conversations failed:", t), t;
  }
});
N.handle("db:upsert-agent-conversation", async (n, e) => {
  try {
    return await rr.upsert(e);
  } catch (t) {
    throw console.error("[Main] db:upsert-agent-conversation failed:", t), t;
  }
});
N.handle("db:delete-agent-conversation", async (n, e) => {
  try {
    return await rr.delete(e);
  } catch (t) {
    throw console.error("[Main] db:delete-agent-conversation failed:", t), t;
  }
});
N.handle("db:create-volume", async (n, { novelId: e, title: t }) => {
  try {
    const r = await S.volume.findFirst({
      where: { novelId: e },
      orderBy: { order: "desc" }
    }), s = ((r == null ? void 0 : r.order) || 0) + 1;
    return await S.volume.create({
      data: { novelId: e, title: t, order: s }
    });
  } catch (r) {
    throw console.error("[Main] db:create-volume failed:", r), r;
  }
});
N.handle("db:create-chapter", async (n, { volumeId: e, title: t, order: r }) => {
  try {
    const s = await S.chapter.create({
      data: {
        volumeId: e,
        title: t,
        order: r,
        content: "",
        wordCount: 0
      },
      include: { volume: { select: { novelId: !0 } } }
    });
    return await Ue({ ...s, novelId: s.volume.novelId }), St(s.id, "create-chapter"), s;
  } catch (s) {
    throw console.error("[Main] db:create-chapter failed:", s), s;
  }
});
N.handle("db:get-chapter", async (n, e) => {
  try {
    return await S.chapter.findUnique({
      where: { id: e },
      include: { volume: { select: { novelId: !0 } } }
    });
  } catch (t) {
    throw console.error("[Main] db:get-chapter failed:", t), t;
  }
});
N.handle("db:rename-volume", async (n, { volumeId: e, title: t }) => {
  try {
    const r = await S.volume.update({
      where: { id: e },
      data: { title: t }
    }), s = await S.chapter.findMany({
      where: { volumeId: e },
      include: { volume: { select: { novelId: !0, title: !0, order: !0 } } }
    });
    for (const a of s)
      await Ue({
        ...a,
        novelId: a.volume.novelId,
        volumeTitle: a.volume.title,
        volumeOrder: a.volume.order
      }), St(a.id, "rename-volume");
    return r;
  } catch (r) {
    throw console.error("[Main] db:rename-volume failed:", r), r;
  }
});
N.handle("db:rename-chapter", async (n, { chapterId: e, title: t }) => {
  try {
    const r = await S.chapter.update({
      where: { id: e },
      data: { title: t }
    }), s = await S.chapter.findUnique({
      where: { id: e },
      select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0, volume: { select: { novelId: !0 } } }
    });
    return s && s.volume && (await Ue({ ...s, novelId: s.volume.novelId }), St(e, "rename-chapter")), r;
  } catch (r) {
    throw console.error("[Main] db:rename-chapter failed:", r), r;
  }
});
N.handle("db:delete-chapter", async (n, { chapterId: e }) => {
  var t, r, s, a;
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
      return await Ue({
        ...f,
        novelId: o,
        volumeTitle: i.volume.title,
        volumeOrder: i.volume.order
      }), St(e, "reset-only-chapter"), {
        mode: "reset",
        chapterId: e,
        fallbackChapterId: e,
        chapter: f
      };
    }
    const l = ((t = c[d + 1]) == null ? void 0 : t.id) ?? ((r = c[d - 1]) == null ? void 0 : r.id) ?? null, p = c.filter((f) => f.volumeId === i.volumeId && f.id !== e).map((f, v) => ({
      ...f,
      nextOrder: v + 1
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
    ]), await Vn("chapter", e), fc(o, e, "delete-chapter");
    for (const f of p)
      await Ue({
        id: f.id,
        title: f.title,
        content: f.content,
        volumeId: f.volumeId,
        novelId: o,
        volumeTitle: (s = f.volume) == null ? void 0 : s.title,
        order: f.nextOrder,
        volumeOrder: (a = f.volume) == null ? void 0 : a.order
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
N.handle("db:create-novel", async (n, e) => {
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
N.handle("db:import-novel-file", async () => {
  try {
    const n = await yt.showOpenDialog(j, {
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
    const e = n.filePaths[0], t = await Ii(e), r = t.volumes.reduce((o, c) => o + c.chapters.length, 0), s = (/* @__PURE__ */ new Date()).toISOString(), a = JSON.stringify({
      importSource: k.basename(e),
      importExtension: k.extname(e).replace(/^\./, "").toLowerCase(),
      importedAt: s
    }), i = await S.$transaction(async (o) => {
      const c = await o.novel.create({
        data: {
          title: t.title,
          wordCount: t.wordCount,
          formatting: a
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
          await Ue({
            ...c,
            novelId: c.volume.novelId,
            volumeTitle: c.volume.title,
            volumeOrder: c.volume.order
          }), St(c.id, "import-novel-file"), nt(c.id);
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
N.handle("db:save-chapter", async (n, { chapterId: e, content: t }) => {
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
    const s = r.volume.novelId, a = _s(t).length, i = a - r.wordCount, [, o] = await S.$transaction([
      // 1. Update Novel WordCount
      S.novel.update({
        where: { id: s },
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
          wordCount: a,
          updatedAt: /* @__PURE__ */ new Date()
        }
      })
    ]), c = await S.chapter.findUnique({
      where: { id: e },
      select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0 }
    });
    return c && (await Ue({ ...c, novelId: s }), St(e, "save-chapter")), nt(e), o;
  } catch (r) {
    throw console.error("[Main] db:save-chapter failed:", r), r;
  }
});
N.handle("db:create-idea", async (n, e) => {
  try {
    const { timestamp: t, tags: r, ...s } = e, a = s.novelId, i = await S.idea.create({
      data: {
        ...s,
        tags: {
          connectOrCreate: (r || []).map((c) => ({
            where: { name_novelId: { name: c, novelId: a } },
            create: { name: c, novelId: a }
          }))
        }
      },
      include: { tags: !0 }
    }), o = {
      ...i,
      tags: i.tags.map((c) => c.name),
      timestamp: i.createdAt.getTime()
    };
    return await kr({
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
N.handle("db:get-ideas", async (n, e) => {
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
      tags: r.tags.map((s) => s.name),
      timestamp: r.createdAt.getTime()
    }));
  } catch (t) {
    throw console.error("[Main] db:get-ideas failed:", t), t;
  }
});
N.handle("db:update-idea", async (n, e, t) => {
  try {
    const { timestamp: r, tags: s, ...a } = t, i = { ...a };
    if (s !== void 0) {
      const d = await S.idea.findUnique({ where: { id: e }, select: { novelId: !0 } });
      if (d) {
        const l = d.novelId;
        i.tags = {
          set: [],
          // Disconnect all existing
          connectOrCreate: (s || []).map((m) => ({
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
    return await kr({
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
N.handle("db:delete-idea", async (n, e) => {
  try {
    const t = await S.idea.delete({ where: { id: e } });
    return await Vn("idea", e), t;
  } catch (t) {
    throw console.error("[Main] db:delete-idea failed:", t), t;
  }
});
N.handle("db:check-index-status", async (n, e) => {
  try {
    const t = await js(e), r = await S.chapter.count({
      where: { volume: { novelId: e } }
    }), s = await S.idea.count({
      where: { novelId: e }
    });
    return {
      indexedChapters: t.chapters,
      totalChapters: r,
      indexedIdeas: t.ideas,
      totalIdeas: s
    };
  } catch (t) {
    throw console.error("[Main] db:check-index-status failed:", t), t;
  }
});
const xs = new Ai();
let ee, Rr, Gt = null, ke = null;
const rr = new ii(S), Ye = /* @__PURE__ */ new Map();
async function St(n, e) {
  return Te("chapter", n, e);
}
async function Te(n, e, t) {
  try {
    const r = await ee.upsertRagSourceIndex(n, e, { skipIfNovelNotIndexed: !0 });
    if (r.skipped)
      return;
    console.log("[RAG] Source index refreshed:", { sourceType: n, sourceId: e, reason: t, chunks: r.chunks, provider: r.provider, model: r.model });
  } catch (r) {
    console.warn("[RAG] Failed to refresh source index:", { sourceType: n, sourceId: e, reason: t, error: r });
  }
}
async function fc(n, e, t) {
  return At(n, "chapter", e, t);
}
async function At(n, e, t, r) {
  try {
    const s = await ee.deleteRagSourceIndex(n, e, t);
    console.log("[RAG] Source index removed:", { novelId: n, sourceType: e, sourceId: t, reason: r, deleted: s.deleted });
  } catch (s) {
    console.warn("[RAG] Failed to remove source index:", { novelId: n, sourceType: e, sourceId: t, reason: r, error: s });
  }
}
N.handle("ai:get-settings", async () => {
  try {
    return ee.getSettings();
  } catch (n) {
    throw te("ai:get-settings", void 0, n), console.error("[Main] ai:get-settings failed:", n), n;
  }
});
N.handle("ai:get-map-image-stats", async () => {
  try {
    return ee.getMapImageStats();
  } catch (n) {
    throw te("ai:get-map-image-stats", void 0, n), console.error("[Main] ai:get-map-image-stats failed:", n), n;
  }
});
N.handle("ai:list-actions", async () => {
  try {
    return ee.listActions();
  } catch (n) {
    throw te("ai:list-actions", void 0, n), console.error("[Main] ai:list-actions failed:", n), n;
  }
});
N.handle("ai:get-capability-coverage", async () => {
  try {
    return ee.getCapabilityCoverage();
  } catch (n) {
    throw te("ai:get-capability-coverage", void 0, n), console.error("[Main] ai:get-capability-coverage failed:", n), n;
  }
});
N.handle("ai:get-mcp-manifest", async () => {
  try {
    return ee.getMcpToolsManifest();
  } catch (n) {
    throw te("ai:get-mcp-manifest", void 0, n), console.error("[Main] ai:get-mcp-manifest failed:", n), n;
  }
});
N.handle("ai:get-mcp-cli-setup", async () => {
  try {
    return Cs();
  } catch (n) {
    throw te("ai:get-mcp-cli-setup", void 0, n), console.error("[Main] ai:get-mcp-cli-setup failed:", n), n;
  }
});
N.handle("ai:get-openclaw-manifest", async () => {
  try {
    return ee.getOpenClawManifest();
  } catch (n) {
    throw te("ai:get-openclaw-manifest", void 0, n), console.error("[Main] ai:get-openclaw-manifest failed:", n), n;
  }
});
N.handle("ai:get-openclaw-skill-manifest", async () => {
  try {
    return ee.getOpenClawSkillManifest();
  } catch (n) {
    throw te("ai:get-openclaw-skill-manifest", void 0, n), console.error("[Main] ai:get-openclaw-skill-manifest failed:", n), n;
  }
});
N.handle("ai:update-settings", async (n, e) => {
  try {
    const t = ee.updateSettings(e || {});
    return await bs(t), t;
  } catch (t) {
    throw te("ai:update-settings", e, t), console.error("[Main] ai:update-settings failed:", t), t;
  }
});
N.handle("ai:test-connection", async () => {
  try {
    return await ee.testConnection();
  } catch (n) {
    throw te("ai:test-connection", void 0, n), console.error("[Main] ai:test-connection failed:", n), n;
  }
});
N.handle("ai:test-mcp", async () => {
  try {
    return await lc();
  } catch (n) {
    throw te("ai:test-mcp", void 0, n), console.error("[Main] ai:test-mcp failed:", n), n;
  }
});
N.handle("ai:test-openclaw-mcp", async () => {
  try {
    return await ee.testOpenClawMcp();
  } catch (n) {
    throw te("ai:test-openclaw-mcp", void 0, n), console.error("[Main] ai:test-openclaw-mcp failed:", n), n;
  }
});
N.handle("ai:test-openclaw-skill", async () => {
  try {
    return await ee.testOpenClawSkill();
  } catch (n) {
    throw te("ai:test-openclaw-skill", void 0, n), console.error("[Main] ai:test-openclaw-skill failed:", n), n;
  }
});
N.handle("ai:test-openclaw-smoke", async (n, e) => {
  try {
    const t = (e == null ? void 0 : e.kind) === "skill" ? "skill" : "mcp";
    return await ee.testOpenClawSmoke({ kind: t });
  } catch (t) {
    throw te("ai:test-openclaw-smoke", e, t), console.error("[Main] ai:test-openclaw-smoke failed:", t), t;
  }
});
N.handle("ai:test-proxy", async () => {
  try {
    return await ee.testProxy();
  } catch (n) {
    throw te("ai:test-proxy", void 0, n), console.error("[Main] ai:test-proxy failed:", n), n;
  }
});
N.handle("ai:test-generate", async (n, e) => {
  try {
    return await ee.testGenerate(e == null ? void 0 : e.prompt);
  } catch (t) {
    throw te("ai:test-generate", e, t), console.error("[Main] ai:test-generate failed:", t), t;
  }
});
N.handle("ai:generate-title", async (n, e) => {
  try {
    return await ee.generateTitle(e);
  } catch (t) {
    throw te("ai:generate-title", e, t), console.error("[Main] ai:generate-title failed:", t), t;
  }
});
N.handle("ai:continue-writing", async (n, e) => {
  try {
    return await ee.continueWriting(e);
  } catch (t) {
    throw te("ai:continue-writing", e, t), console.error("[Main] ai:continue-writing failed:", t), t;
  }
});
N.handle("ai:preview-continue-prompt", async (n, e) => {
  try {
    return await ee.previewContinuePrompt(e);
  } catch (t) {
    throw te("ai:preview-continue-prompt", e, t), console.error("[Main] ai:preview-continue-prompt failed:", t), t;
  }
});
N.handle("ai:check-consistency", async (n, e) => {
  try {
    return await ee.checkConsistency(e);
  } catch (t) {
    throw te("ai:check-consistency", e, t), console.error("[Main] ai:check-consistency failed:", t), t;
  }
});
N.handle("ai:ask-novel", async (n, e) => {
  try {
    return await ee.askNovel(e);
  } catch (t) {
    throw te("ai:ask-novel", e, t), console.error("[Main] ai:ask-novel failed:", t), t;
  }
});
N.handle("ai:preview-novel-ask-prompt", async (n, e) => {
  try {
    return await ee.previewNovelAskPrompt(e);
  } catch (t) {
    throw te("ai:preview-novel-ask-prompt", e, t), console.error("[Main] ai:preview-novel-ask-prompt failed:", t), t;
  }
});
N.handle("ai:generate-creative-assets", async (n, e) => {
  try {
    return await ee.generateCreativeAssets(e);
  } catch (t) {
    throw te("ai:generate-creative-assets", e, t), console.error("[Main] ai:generate-creative-assets failed:", t), t;
  }
});
N.handle("ai:preview-creative-assets-prompt", async (n, e) => {
  try {
    return await ee.previewCreativeAssetsPrompt(e);
  } catch (t) {
    throw te("ai:preview-creative-assets-prompt", e, t), console.error("[Main] ai:preview-creative-assets-prompt failed:", t), t;
  }
});
N.handle("ai:validate-creative-assets", async (n, e) => {
  try {
    return await ee.validateCreativeAssetsDraft(e);
  } catch (t) {
    throw te("ai:validate-creative-assets", e, t), console.error("[Main] ai:validate-creative-assets failed:", t), t;
  }
});
N.handle("ai:confirm-creative-assets", async (n, e) => {
  try {
    return await ee.confirmCreativeAssets(e);
  } catch (t) {
    throw te("ai:confirm-creative-assets", e, t), console.error("[Main] ai:confirm-creative-assets failed:", t), t;
  }
});
N.handle("ai:generate-map-image", async (n, e) => {
  try {
    return await ee.generateMapImage(e);
  } catch (t) {
    return te("ai:generate-map-image", e, t), console.error("[Main] ai:generate-map-image failed:", t), { ok: !1, code: "UNKNOWN", detail: t instanceof Error ? t.message : String(t) };
  }
});
N.handle("ai:preview-map-prompt", async (n, e) => {
  try {
    return await ee.previewMapPrompt(e);
  } catch (t) {
    throw te("ai:preview-map-prompt", e, t), console.error("[Main] ai:preview-map-prompt failed:", t), t;
  }
});
N.handle("ai:rebuild-chapter-summary", async (n, e) => {
  try {
    return e != null && e.chapterId ? (nt(e.chapterId, "manual"), { ok: !0, detail: "summary rebuild scheduled" }) : { ok: !1, detail: "chapterId is required" };
  } catch (t) {
    return te("ai:rebuild-chapter-summary", e, t), console.error("[Main] ai:rebuild-chapter-summary failed:", t), { ok: !1, detail: t instanceof Error ? t.message : String(t) };
  }
});
N.handle("ai:execute-action", async (n, e) => {
  try {
    return await ee.executeAction(e);
  } catch (t) {
    throw te("ai:execute-action", e, t), console.error("[Main] ai:execute-action failed:", t), t;
  }
});
N.handle("ai:openclaw-invoke", async (n, e) => {
  try {
    return await ee.invokeOpenClawTool(e);
  } catch (t) {
    te("ai:openclaw-invoke", e, t), console.error("[Main] ai:openclaw-invoke failed:", t);
    const r = je(t);
    return {
      ok: !1,
      code: r.code,
      error: It(r.code, r.message)
    };
  }
});
N.handle("ai:openclaw-mcp-invoke", async (n, e) => {
  try {
    return await ee.invokeOpenClawTool(e);
  } catch (t) {
    te("ai:openclaw-mcp-invoke", e, t), console.error("[Main] ai:openclaw-mcp-invoke failed:", t);
    const r = je(t);
    return {
      ok: !1,
      code: r.code,
      error: It(r.code, r.message)
    };
  }
});
N.handle("ai:openclaw-skill-invoke", async (n, e) => {
  try {
    return await ee.invokeOpenClawSkill(e);
  } catch (t) {
    te("ai:openclaw-skill-invoke", e, t), console.error("[Main] ai:openclaw-skill-invoke failed:", t);
    const r = je(t);
    return {
      ok: !1,
      code: r.code,
      error: It(r.code, r.message)
    };
  }
});
N.handle("automation:invoke", async (n, e) => {
  const t = fe(), r = Date.now();
  try {
    B("INFO", "Main.automation:invoke.start", "Renderer automation invoke start", {
      requestId: t,
      method: e.method,
      origin: e.origin ?? "desktop-ui",
      params: Ie(e.params)
    });
    const s = await Rr.invoke(e.method, e.params, {
      source: "renderer",
      origin: e.origin ?? "desktop-ui",
      requestId: t
    });
    return B("INFO", "Main.automation:invoke.success", "Renderer automation invoke success", {
      requestId: t,
      method: e.method,
      elapsedMs: Date.now() - r,
      result: Ie(s)
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
    ])).has(e.method) && (j == null || j.webContents.send("automation:data-changed", { method: e.method })), s;
  } catch (s) {
    throw Se("Main.automation:invoke.error", s, {
      requestId: t,
      method: e.method,
      elapsedMs: Date.now() - r,
      payload: Ie(e)
    }), te("automation:invoke", e, s), s;
  }
});
N.handle("agent:health", async () => ke ? ke.health() : { ok: !1, code: "AGENT_RUNTIME_NOT_INITIALIZED", message: "Agent runtime client is not initialized" });
N.handle("agent:ensure-ready", async () => ke ? ke.ensureReady() : { ok: !1, code: "AGENT_RUNTIME_NOT_INITIALIZED", message: "Agent runtime client is not initialized" });
N.handle("agent:restart", async () => ke ? ke.restart() : { ok: !1, code: "AGENT_RUNTIME_NOT_INITIALIZED", message: "Agent runtime client is not initialized" });
N.handle("agent:invoke", async (n, e) => {
  if (!ke)
    throw Object.assign(new Error("Agent runtime client is not initialized"), { code: "AGENT_RUNTIME_NOT_INITIALIZED" });
  return ke.invoke({
    requestId: fe(),
    method: e.method,
    params: e.params || {},
    context: e.context || {}
  });
});
N.handle("agent:subscribe-run", async (n, e) => {
  var s;
  if (!ke)
    throw Object.assign(new Error("Agent runtime client is not initialized"), { code: "AGENT_RUNTIME_NOT_INITIALIZED" });
  const t = String((e == null ? void 0 : e.runId) || "").trim();
  if (!t)
    throw Object.assign(new Error("runId is required"), { code: "INVALID_INPUT" });
  (s = Ye.get(t)) == null || s();
  const r = await ke.subscribeRunEvents(
    t,
    { afterSequence: e.afterSequence },
    (a) => {
      var i;
      B("INFO", "Main.agent.runEvent", "Agent run event", {
        runId: a.runId,
        sequence: a.sequence,
        type: a.type,
        toolName: a.toolName,
        status: a.status,
        payload: Ie(a.payload)
      }), j == null || j.webContents.send("agent:run-event", a), ["run_completed", "run_failed", "run_cancelled"].includes(a.type) && ((i = Ye.get(t)) == null || i(), Ye.delete(t));
    },
    (a) => {
      B("WARN", "Main.agent.runDisconnected", "Agent run event stream disconnected", a), j == null || j.webContents.send("agent:run-disconnected", a), Ye.delete(t);
    }
  );
  return Ye.set(t, r), { ok: !0 };
});
N.handle("agent:unsubscribe-run", async (n, e) => {
  var r;
  const t = String((e == null ? void 0 : e.runId) || "").trim();
  return t ? ((r = Ye.get(t)) == null || r(), Ye.delete(t), { ok: !0 }) : { ok: !0 };
});
N.handle("sync:pull", async () => {
  try {
    return await xs.pull();
  } catch (n) {
    throw console.error("[Main] sync:pull failed:", n), n;
  }
});
N.handle("backup:export", async (n, e) => {
  try {
    return await tr.exportData(void 0, e);
  } catch (t) {
    throw console.error("[Main] backup:export failed:", t), t;
  }
});
N.handle("backup:import", async (n, { filePath: e, password: t }) => {
  try {
    if (!e) {
      const r = await yt.showOpenDialog({
        title: "Import Backup",
        filters: [{ name: "CloudDream Novel Agent Backup", extensions: ["nebak"] }],
        properties: ["openFile"]
      });
      if (r.canceled || r.filePaths.length === 0)
        return { success: !1, code: "CANCELLED" };
      e = r.filePaths[0];
    }
    return await tr.importData(e, t), { success: !0 };
  } catch (r) {
    console.error("[Main] backup:import failed:", r);
    const s = r.message || r.toString();
    return s.includes("PASSWORD_REQUIRED") ? { success: !1, code: "PASSWORD_REQUIRED", filePath: e } : s.includes("PASSWORD_INVALID") ? { success: !1, code: "PASSWORD_INVALID", filePath: e } : { success: !1, message: s };
  }
});
N.handle("backup:get-auto", async () => {
  try {
    return await tr.getAutoBackups();
  } catch (n) {
    throw console.error("[Main] backup:get-auto failed:", n), n;
  }
});
N.handle("backup:restore-auto", async (n, e) => {
  try {
    return await tr.restoreAutoBackup(e), !0;
  } catch (t) {
    throw console.error("[Main] backup:restore-auto failed:", t), t;
  }
});
N.handle("sync:push", async () => {
  try {
    return await xs.push();
  } catch (n) {
    throw console.error("[Main] sync:push failed:", n), n;
  }
});
N.handle("db:search", async (n, { novelId: e, keyword: t, limit: r = 20, offset: s = 0 }) => {
  try {
    return await Or(e, t, r, s);
  } catch (a) {
    throw console.error("[Main] db:search failed:", a), a;
  }
});
N.handle("db:rebuild-search-index", async (n, e) => {
  try {
    return await Jn(e);
  } catch (t) {
    throw console.error("[Main] db:rebuild-search-index failed:", t), t;
  }
});
N.handle("db:get-all-tags", async (n, e) => {
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
N.handle("db:get-plot-lines", async (n, e) => {
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
N.handle("db:create-plot-line", async (n, e) => {
  try {
    const r = ((await S.plotLine.aggregate({
      where: { novelId: e.novelId },
      _max: { sortOrder: !0 }
    }))._max.sortOrder || 0) + 1, s = await S.plotLine.create({
      data: { ...e, sortOrder: r }
    });
    return Te("plotLine", s.id, "create-plot-line"), s;
  } catch (t) {
    throw console.error("[Main] db:create-plot-line failed. Data:", e, "Error:", t), t;
  }
});
N.handle("db:update-plot-line", async (n, e) => {
  try {
    const t = await S.plotLine.update({
      where: { id: e.id },
      data: e.data
    });
    return Te("plotLine", t.id, "update-plot-line"), t;
  } catch (t) {
    throw console.error("[Main] db:update-plot-line failed. ID:", e.id, "Error:", t), t;
  }
});
N.handle("db:delete-plot-line", async (n, e) => {
  try {
    const t = await S.plotLine.findUnique({ where: { id: e }, select: { novelId: !0 } }), r = await S.plotLine.delete({ where: { id: e } });
    return t != null && t.novelId && At(t.novelId, "plotLine", e, "delete-plot-line"), r;
  } catch (t) {
    throw console.error("[Main] db:delete-plot-line failed. ID:", e, "Error:", t), t;
  }
});
N.handle("db:create-plot-point", async (n, e) => {
  try {
    const { plotLineId: t } = e, s = ((await S.plotPoint.aggregate({
      where: { plotLineId: t },
      _max: { order: !0 }
    }))._max.order || 0) + 1, a = await S.plotPoint.create({
      data: { ...e, order: s }
    });
    return Te("plotPoint", a.id, "create-plot-point"), a;
  } catch (t) {
    throw console.error("[Main] db:create-plot-point failed. Data:", e, "Error:", t), t;
  }
});
N.handle("db:update-plot-point", async (n, e) => {
  try {
    const t = await S.plotPoint.update({
      where: { id: e.id },
      data: e.data
    });
    return Te("plotPoint", t.id, "update-plot-point"), t;
  } catch (t) {
    throw console.error("[Main] db:update-plot-point failed. ID:", e.id, "Error:", t), t;
  }
});
N.handle("db:delete-plot-point", async (n, e) => {
  try {
    const t = await S.plotPoint.findUnique({ where: { id: e }, select: { novelId: !0 } }), r = await S.plotPoint.delete({ where: { id: e } });
    return t != null && t.novelId && At(t.novelId, "plotPoint", e, "delete-plot-point"), r;
  } catch (t) {
    throw console.error("[Main] db:delete-plot-point failed. ID:", e, "Error:", t), t;
  }
});
N.handle("db:create-plot-point-anchor", async (n, e) => {
  try {
    return await S.plotPointAnchor.create({ data: e });
  } catch (t) {
    throw console.error("[Main] db:create-plot-point-anchor failed. Data:", e, "Error:", t), t;
  }
});
N.handle("db:delete-plot-point-anchor", async (n, e) => {
  try {
    return await S.plotPointAnchor.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-plot-point-anchor failed. ID:", e, "Error:", t), t;
  }
});
N.handle("db:reorder-plot-lines", async (n, { lineIds: e }) => {
  try {
    const t = e.map(
      (r, s) => S.plotLine.update({
        where: { id: r },
        data: { sortOrder: s }
      })
    );
    return await S.$transaction(t), { success: !0 };
  } catch (t) {
    throw console.error("[Main] db:reorder-plot-lines failed:", t), t;
  }
});
N.handle("db:reorder-plot-points", async (n, { plotLineId: e, pointIds: t }) => {
  try {
    const r = t.map(
      (s, a) => S.plotPoint.update({
        where: { id: s },
        data: { order: a, plotLineId: e }
      })
    );
    await S.$transaction(r);
    for (const s of t)
      Te("plotPoint", s, "reorder-plot-points");
    return { success: !0 };
  } catch (r) {
    throw console.error("[Main] db:reorder-plot-points failed:", r), r;
  }
});
N.handle("db:upload-character-image", async (n, { characterId: e, type: t }) => {
  try {
    const r = await yt.showOpenDialog(j, {
      title: t === "avatar" ? "Select Avatar Image" : "Select Full Body Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (r.canceled || r.filePaths.length === 0)
      return null;
    const s = r.filePaths[0], a = k.extname(s), i = k.join(V.getPath("userData"), "characters", e);
    if (q.existsSync(i) || q.mkdirSync(i, { recursive: !0 }), t === "avatar") {
      const o = `avatar${a}`, c = k.join(i, o);
      q.readdirSync(i).filter((m) => m.startsWith("avatar.")).forEach((m) => {
        try {
          q.unlinkSync(k.join(i, m));
        } catch {
        }
      }), q.copyFileSync(s, c);
      const l = `characters/${e}/${o}`;
      return await S.character.update({
        where: { id: e },
        data: { avatar: l }
      }), { path: l };
    } else {
      const c = `fullbody_${Date.now()}${a}`, d = k.join(i, c);
      q.copyFileSync(s, d);
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
N.handle("db:delete-character-image", async (n, { characterId: e, imagePath: t, type: r }) => {
  try {
    const s = V.getPath("userData"), a = k.resolve(k.join(s, t));
    if (!a.startsWith(s + k.sep))
      throw new Error("Invalid image path: path traversal detected");
    if (q.existsSync(a) && q.unlinkSync(a), r === "avatar")
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
  } catch (s) {
    throw console.error("[Main] db:delete-character-image failed:", s), s;
  }
});
N.handle("db:get-character-map-locations", async (n, e) => {
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
N.handle("db:get-characters", async (n, e) => {
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
N.handle("db:get-character", async (n, e) => {
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
N.handle("db:create-character", async (n, e) => {
  try {
    const t = typeof e.profile == "object" ? JSON.stringify(e.profile) : e.profile, r = await S.character.create({
      data: { ...e, profile: t }
    });
    return Te("character", r.id, "create-character"), r;
  } catch (t) {
    throw console.error("[Main] db:create-character failed:", t), t;
  }
});
N.handle("db:update-character", async (n, { id: e, data: t }) => {
  try {
    const r = typeof t.profile == "object" ? JSON.stringify(t.profile) : t.profile, s = await S.character.update({
      where: { id: e },
      data: { ...t, profile: r }
    });
    return Te("character", e, "update-character"), s;
  } catch (r) {
    throw console.error("[Main] db:update-character failed:", r), r;
  }
});
N.handle("db:delete-character", async (n, e) => {
  try {
    const t = await S.character.findUnique({ where: { id: e }, select: { novelId: !0 } });
    await S.character.delete({ where: { id: e } }), t != null && t.novelId && At(t.novelId, "character", e, "delete-character");
  } catch (t) {
    throw console.error("[Main] db:delete-character failed:", t), t;
  }
});
N.handle("db:get-items", async (n, e) => {
  try {
    return await S.item.findMany({
      where: { novelId: e },
      orderBy: { sortOrder: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-items failed:", t), t;
  }
});
N.handle("db:get-item", async (n, e) => {
  try {
    return await S.item.findUnique({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:get-item failed:", t), t;
  }
});
N.handle("db:create-item", async (n, e) => {
  try {
    const r = ((await S.item.aggregate({
      where: { novelId: e.novelId },
      _max: { sortOrder: !0 }
    }))._max.sortOrder || 0) + 1, s = await S.item.create({
      data: { ...e, sortOrder: r }
    });
    return Te("item", s.id, "create-item"), s;
  } catch (t) {
    throw console.error("[Main] db:create-item failed:", t), t;
  }
});
N.handle("db:update-item", async (n, { id: e, data: t }) => {
  try {
    const r = await S.item.update({
      where: { id: e },
      data: { ...t, updatedAt: /* @__PURE__ */ new Date() }
    });
    return Te("item", e, "update-item"), r;
  } catch (r) {
    throw console.error("[Main] db:update-item failed:", r), r;
  }
});
N.handle("db:delete-item", async (n, e) => {
  try {
    const t = await S.item.findUnique({ where: { id: e }, select: { novelId: !0 } }), r = await S.item.delete({ where: { id: e } });
    return t != null && t.novelId && At(t.novelId, "item", e, "delete-item"), r;
  } catch (t) {
    throw console.error("[Main] db:delete-item failed:", t), t;
  }
});
N.handle("db:get-mentionables", async (n, e) => {
  try {
    const [t, r, s, a] = await Promise.all([
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
      ...s.map((i) => ({ id: i.id, name: i.name, icon: i.icon, type: "world", role: i.type })),
      ...a.map((i) => ({ id: i.id, name: i.name, type: "map", role: i.type }))
    ];
  } catch (t) {
    throw console.error("[Main] db:get-mentionables failed:", t), t;
  }
});
N.handle("db:get-world-settings", async (n, e) => {
  try {
    return await S.worldSetting.findMany({
      where: { novelId: e },
      orderBy: { sortOrder: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-world-settings failed:", t), t;
  }
});
N.handle("db:create-world-setting", async (n, e) => {
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
    return Te("worldSetting", r.id, "create-world-setting"), r;
  } catch (t) {
    throw console.error("[Main] db:create-world-setting failed:", t), t;
  }
});
N.handle("db:update-world-setting", async (n, e, t) => {
  try {
    const r = await S.worldSetting.update({
      where: { id: e },
      data: t
    });
    return Te("worldSetting", e, "update-world-setting"), r;
  } catch (r) {
    throw console.error("[Main] db:update-world-setting failed:", r), r;
  }
});
N.handle("db:delete-world-setting", async (n, e) => {
  try {
    const t = await S.worldSetting.findUnique({ where: { id: e }, select: { novelId: !0 } }), r = await S.worldSetting.delete({ where: { id: e } });
    return t != null && t.novelId && At(t.novelId, "worldSetting", e, "delete-world-setting"), r;
  } catch (t) {
    throw console.error("[Main] db:delete-world-setting failed:", t), t;
  }
});
N.handle("db:get-maps", async (n, e) => {
  try {
    return await S.mapCanvas.findMany({
      where: { novelId: e },
      orderBy: { sortOrder: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-maps failed:", t), t;
  }
});
N.handle("db:get-map", async (n, e) => {
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
N.handle("db:create-map", async (n, e) => {
  try {
    return await S.mapCanvas.create({ data: e });
  } catch (t) {
    throw console.error("[Main] db:create-map failed:", t), t;
  }
});
N.handle("db:update-map", async (n, { id: e, data: t }) => {
  try {
    const { markers: r, elements: s, createdAt: a, updatedAt: i, ...o } = t;
    return await S.mapCanvas.update({ where: { id: e }, data: o });
  } catch (r) {
    throw console.error("[Main] db:update-map failed:", r), r;
  }
});
N.handle("db:delete-map", async (n, e) => {
  try {
    const t = await S.mapCanvas.findUnique({ where: { id: e }, select: { background: !0, novelId: !0 } });
    if (t != null && t.background) {
      const r = k.join(V.getPath("userData"), t.background);
      q.existsSync(r) && q.unlinkSync(r);
    }
    return await S.mapCanvas.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-map failed:", t), t;
  }
});
N.handle("db:upload-map-bg", async (n, e) => {
  try {
    const t = await S.mapCanvas.findUnique({ where: { id: e }, select: { novelId: !0, background: !0 } });
    if (!t)
      return null;
    const r = await yt.showOpenDialog(j, {
      title: "Select Map Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (r.canceled || r.filePaths.length === 0)
      return null;
    const s = r.filePaths[0], a = k.extname(s), i = k.join(V.getPath("userData"), "maps", t.novelId);
    if (q.existsSync(i) || q.mkdirSync(i, { recursive: !0 }), t.background) {
      const f = k.join(V.getPath("userData"), t.background);
      q.existsSync(f) && q.unlinkSync(f);
    }
    const o = `${e}${a}`, c = k.join(i, o);
    q.copyFileSync(s, c);
    const d = `maps/${t.novelId}/${o}`, m = ks.createFromPath(c).getSize(), h = m.width || 1200, p = m.height || 800;
    return await S.mapCanvas.update({
      where: { id: e },
      data: { background: d, width: h, height: p }
    }), { path: d, width: h, height: p };
  } catch (t) {
    throw console.error("[Main] db:upload-map-bg failed:", t), t;
  }
});
N.handle("db:get-map-markers", async (n, e) => {
  try {
    return await S.characterMapMarker.findMany({
      where: { mapId: e },
      include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
    });
  } catch (t) {
    throw console.error("[Main] db:get-map-markers failed:", t), t;
  }
});
N.handle("db:create-map-marker", async (n, e) => {
  try {
    return await S.characterMapMarker.create({
      data: e,
      include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
    });
  } catch (t) {
    throw console.error("[Main] db:create-map-marker failed:", t), t;
  }
});
N.handle("db:update-map-marker", async (n, { id: e, data: t }) => {
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
N.handle("db:delete-map-marker", async (n, e) => {
  try {
    return await S.characterMapMarker.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-map-marker failed:", t), t;
  }
});
N.handle("db:get-map-elements", async (n, e) => {
  try {
    return await S.mapElement.findMany({
      where: { mapId: e },
      orderBy: { z: "asc" }
    });
  } catch (t) {
    throw console.error("[Main] db:get-map-elements failed:", t), t;
  }
});
N.handle("db:create-map-element", async (n, e) => {
  try {
    return await S.mapElement.create({ data: e });
  } catch (t) {
    throw console.error("[Main] db:create-map-element failed:", t), t;
  }
});
N.handle("db:update-map-element", async (n, { id: e, data: t }) => {
  try {
    const { createdAt: r, updatedAt: s, map: a, ...i } = t;
    return await S.mapElement.update({ where: { id: e }, data: i });
  } catch (r) {
    throw console.error("[Main] db:update-map-element failed:", r), r;
  }
});
N.handle("db:delete-map-element", async (n, e) => {
  try {
    return await S.mapElement.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-map-element failed:", t), t;
  }
});
N.handle("db:get-relationships", async (n, e) => {
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
N.handle("db:create-relationship", async (n, e) => {
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
N.handle("db:delete-relationship", async (n, e) => {
  try {
    return await S.relationship.delete({ where: { id: e } });
  } catch (t) {
    throw console.error("[Main] db:delete-relationship failed:", t), t;
  }
});
N.handle("db:get-character-items", async (n, e) => {
  try {
    return await S.itemOwnership.findMany({
      where: { characterId: e },
      include: { item: !0 }
    });
  } catch (t) {
    throw console.error("[Main] db:get-character-items failed:", t), t;
  }
});
N.handle("db:add-item-to-character", async (n, e) => {
  try {
    const t = await S.itemOwnership.create({
      data: e,
      include: { item: !0 }
    });
    return Te("character", e.characterId, "add-item-to-character"), t;
  } catch (t) {
    throw console.error("[Main] db:add-item-to-character failed:", t), t;
  }
});
N.handle("db:remove-item-from-character", async (n, e) => {
  try {
    const t = await S.itemOwnership.findUnique({ where: { id: e }, select: { characterId: !0 } }), r = await S.itemOwnership.delete({ where: { id: e } });
    return t != null && t.characterId && Te("character", t.characterId, "remove-item-from-character"), r;
  } catch (t) {
    throw console.error("[Main] db:remove-item-from-character failed:", t), t;
  }
});
N.handle("db:update-item-ownership", async (n, e, t) => {
  try {
    const r = await S.itemOwnership.update({
      where: { id: e },
      data: t,
      include: { item: !0 }
    });
    return Te("character", r.characterId, "update-item-ownership"), r;
  } catch (r) {
    throw console.error("[Main] db:update-item-ownership failed:", r), r;
  }
});
N.handle("db:get-character-timeline", async (n, e) => {
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
    }), s = /* @__PURE__ */ new Set();
    return r.filter((a) => a.chapter && !s.has(a.chapter.id) && s.add(a.chapter.id)).map((a) => {
      var i;
      return {
        chapterId: a.chapter.id,
        chapterTitle: a.chapter.title,
        volumeTitle: a.chapter.volume.title,
        order: a.chapter.order,
        volumeOrder: a.chapter.volume.order,
        snippet: ((i = a.plotPoint.description) == null ? void 0 : i.substring(0, 100)) || a.plotPoint.title
      };
    });
  } catch (t) {
    throw console.error("[Main] db:get-character-timeline failed:", t), t;
  }
});
function _s(n) {
  if (!n)
    return "";
  try {
    const e = JSON.parse(n);
    if (!e.root)
      return n;
    const t = [], r = (s) => {
      s.text && t.push(s.text), s.children && Array.isArray(s.children) && s.children.forEach(r), (s.type === "paragraph" || s.type === "heading" || s.type === "quote") && t.push(" ");
    };
    return r(e.root), t.join("").replace(/\s+/g, " ").trim();
  } catch {
    return n;
  }
}
N.handle("db:get-character-chapter-appearances", async (n, e) => {
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
    })).map((s) => {
      const a = _s(s.content || "");
      let i = "";
      const o = a.indexOf(t.name);
      if (o >= 0) {
        const c = Math.max(0, o - 30), d = Math.min(a.length, o + t.name.length + 50);
        i = (c > 0 ? "..." : "") + a.substring(c, d) + (d < a.length ? "..." : "");
      }
      return {
        chapterId: s.id,
        chapterTitle: s.title,
        volumeTitle: s.volume.title,
        order: s.order,
        volumeOrder: s.volume.order,
        snippet: i
      };
    }).filter((s) => s.snippet !== "") : [];
  } catch (t) {
    throw console.error("[Main] db:get-character-chapter-appearances failed:", t), t;
  }
});
N.handle("db:get-recent-chapters", async (n, e, t, r = 5) => {
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
  } catch (s) {
    throw console.error("[Main] db:get-recent-chapters failed:", s), s;
  }
});
V.on("window-all-closed", () => {
  process.platform !== "darwin" && (V.quit(), j = null);
});
V.on("before-quit", () => {
  for (const n of Ye.values())
    n();
  Ye.clear(), Gt && Gt.stop().catch((n) => {
    console.error("[Main] Failed to stop automation server:", n);
  }), ke && ke.stop().catch((n) => {
    console.error("[Main] Failed to stop agent runtime:", n);
  });
});
V.on("activate", () => {
  Fn.getAllWindows().length === 0 && Ns();
});
V.whenReady().then(async () => {
  var a, i, o;
  if (He.error) {
    Hr(V.getPath("userData")), Bn(), console.error(`[AI-Diag] Invalid arguments: ${He.error}`), V.exit(2);
    return;
  }
  V.setAppUserModelId(tc()), V.setName(V.isPackaged ? Ss : ec);
  const n = (a = He.command) != null && a.userDataPath ? k.resolve(He.command.userDataPath) : oc();
  if (V.setPath("userData", n), Hr(V.getPath("userData")), Bn(), console.log("[Main] App Ready. Starting DB Setup..."), console.log("[Main] User Data Path:", V.getPath("userData")), He.command || (ke = new si({
    getUserDataPath: () => V.getPath("userData"),
    getAutomationRuntimePath: Ts,
    isPackaged: V.isPackaged
  }), ke.prewarm()), He.command && V.isPackaged) {
    console.error("[AI-Diag] --ai-diag is only available in development mode."), V.exit(1);
    return;
  }
  (i = He.command) != null && i.userDataPath && console.log("[AI-Diag] userData override:", n);
  const e = k.resolve(V.getPath("userData"));
  Os.handle("local-resource", (c) => {
    const d = decodeURIComponent(c.url.replace("local-resource://", "")), l = k.resolve(k.join(e, d));
    return !l.startsWith(e + k.sep) && l !== e ? new Response("Forbidden", { status: 403 }) : Dr.fetch("file:///" + l.replace(/\\/g, "/"));
  });
  let t;
  V.isPackaged && $r() ? t = rc() : t = V.getPath("userData"), nc(), sc();
  const r = (o = He.command) != null && o.dbPath ? k.resolve(He.command.dbPath) : k.join(t, "novel_editor.db"), s = `file:${r}`;
  if (console.log("[Main] Database Path:", r), q.existsSync(k.dirname(r)) || q.mkdirSync(k.dirname(r), { recursive: !0 }), !V.isPackaged) {
    const c = k.resolve(xt, "../../../packages/core/prisma/schema.prisma");
    if (console.log("[Main] Development mode detected (unpackaged). Checking schema at:", c), q.existsSync(c)) {
      const d = k.dirname(r);
      q.existsSync(d) || q.mkdirSync(d, { recursive: !0 }), console.log("[Main] Schema found."), console.log("[Main] Cleaning up FTS tables before migration..."), qr(s);
      try {
        await S.$executeRawUnsafe("DROP TABLE IF EXISTS search_index;"), console.log("[Main] FTS tables dropped successfully.");
      } catch (m) {
        console.warn("[Main] Failed to drop FTS table (non-critical):", m);
      }
      await S.$disconnect(), console.log("[Main] Attempting synchronous DB push to:", r);
      const l = k.resolve(xt, "../../../packages/core/node_modules/.bin/prisma.cmd");
      if (console.log("[Main] Using Prisma binary at:", l), !q.existsSync(l))
        console.error("[Main] Prisma binary NOT found at:", l);
      else
        try {
          const m = `"${l}" db push --schema="${c}" --accept-data-loss --skip-generate`;
          console.log("[Main] Executing command:", m);
          const h = Ps(m, {
            env: { ...process.env, DATABASE_URL: s },
            cwd: k.resolve(xt, "../../../packages/core"),
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
  qr(s);
  try {
    await Ls() && console.log("[Main] Bundled database schema applied successfully."), await rr.ensureSchema();
  } catch (c) {
    throw console.error("[Main] Failed to ensure bundled database schema:", c), c;
  }
  if (ee = new So(() => V.getPath("userData")), ea((c, d, l) => {
    Te(c, d, l);
  }), Rr = new Vo(ee, () => V.getPath("userData")), Gt = new Jo(
    Rr,
    () => V.getPath("userData"),
    (c) => {
      j == null || j.webContents.send("automation:data-changed", { method: c });
    }
  ), await Gt.start(), He.command)
    try {
      const c = await mc(ee, He.command);
      await S.$disconnect(), V.exit(c);
      return;
    } catch (c) {
      console.error("[AI-Diag] Execution failed:", c), await S.$disconnect(), V.exit(1);
      return;
    }
  await Fs(), console.log("[Main] Search index initialized");
  try {
    await bs(ee.getSettings());
  } catch (c) {
    console.warn("[Main] Failed to apply AI proxy settings:", c);
  }
  Ns();
});
export {
  Dc as MAIN_DIST,
  ws as RENDERER_DIST,
  _r as VITE_DEV_SERVER_URL
};
