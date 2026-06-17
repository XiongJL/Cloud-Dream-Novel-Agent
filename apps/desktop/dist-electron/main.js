var Ur = Object.defineProperty;
var Fr = (r, t, e) => t in r ? Ur(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e }) : r[t] = e;
var G = (r, t, e) => (Fr(r, typeof t != "symbol" ? t + "" : t, e), e);
import { net as Et, app as O, dialog as Re, ipcMain as b, nativeImage as Br, BrowserWindow as lr, protocol as jr, session as Be } from "electron";
import { db as u, initDb as xt, ensureDbSchema as qr } from "@novel-editor/core";
import { fileURLToPath as zr } from "node:url";
import k from "node:path";
import { createHash as Ze, randomUUID as Oe } from "node:crypto";
import dr from "node:http";
import { execSync as Hr } from "child_process";
import N from "fs";
import W from "node:fs";
import { spawn as Vr } from "node:child_process";
import be from "node:fs/promises";
import pe from "path";
import ur from "zlib";
import _e from "crypto";
const Wr = [
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
async function Pt() {
  await u.$executeRaw`
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
async function Gr() {
  return (await u.$queryRawUnsafe("PRAGMA table_info(search_index);")).map((t) => t.name);
}
async function Lt() {
  const r = await u.novel.findMany({
    where: { deleted: !1 },
    select: { id: !0 }
  });
  for (const t of r)
    await pr(t.id);
}
async function Jr() {
  try {
    if ((await u.$queryRaw`
            SELECT name FROM sqlite_master WHERE type='table' AND name='search_index';
        `).length === 0)
      await Pt(), console.log("[SearchIndex] FTS5 table created successfully"), await Lt(), console.log("[SearchIndex] FTS5 index rebuilt from source data");
    else {
      const t = await Gr(), e = Wr.filter((n) => !t.includes(n));
      e.length > 0 && (console.warn(`[SearchIndex] Schema mismatch detected. Rebuilding FTS5 table. Missing columns: ${e.join(", ")}`), await u.$executeRawUnsafe("DROP TABLE IF EXISTS search_index;"), await Pt(), await Lt(), console.log("[SearchIndex] FTS5 table rebuilt successfully"));
    }
  } catch (r) {
    console.error("[SearchIndex] Failed to initialize FTS5 table:", r);
  }
}
function Zr(r) {
  if (!r)
    return "";
  try {
    const t = JSON.parse(r), e = [], n = (o) => {
      o.type === "text" && o.text && e.push(o.text), o.children && Array.isArray(o.children) && (o.children.forEach(n), o.type !== "root" && o.type !== "list" && o.type !== "listitem" && e.push(" "));
    };
    return t.root && n(t.root), e.join("").trim();
  } catch {
    return r;
  }
}
async function Ie(r) {
  const t = Zr(r.content);
  let e = r.novelId, n = r.volumeTitle, o = r.order, a = r.volumeOrder;
  if (!e || !n || o === void 0 || a === void 0) {
    const s = await u.chapter.findUnique({
      where: { id: r.id },
      select: {
        order: !0,
        volume: { select: { id: !0, novelId: !0, title: !0, order: !0 } }
      }
    });
    s && (o === void 0 && (o = s.order), s.volume && (e || (e = s.volume.novelId), n || (n = s.volume.title), a === void 0 && (a = s.volume.order)));
  }
  if (e)
    try {
      await u.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'chapter' AND entity_id = ${r.id};
        `, await u.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${t}, 'chapter', ${r.id}, ${e}, ${r.id}, ${r.title}, ${n || ""}, ${o || 0}, ${a || 0}, ${r.volumeId});
        `;
    } catch (s) {
      console.error("[SearchIndex] Failed to index chapter:", s);
    }
}
async function _t(r) {
  const t = [r.content, r.quote].filter(Boolean).join(" ");
  try {
    await u.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'idea' AND entity_id = ${r.id};
        `, await u.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${t}, 'idea', ${r.id}, ${r.novelId}, ${r.chapterId || ""}, ${r.content.substring(0, 50)}, '', 0, 0, '');
        `;
  } catch (e) {
    console.error("[SearchIndex] Failed to index idea:", e);
  }
}
async function mr(r, t) {
  try {
    await u.$executeRaw`
            DELETE FROM search_index WHERE entity_type = ${r} AND entity_id = ${t};
        `;
  } catch (e) {
    console.error("[SearchIndex] Failed to remove from index:", e);
  }
}
async function At(r, t, e = 20, n = 0) {
  if (!t.trim())
    return [];
  try {
    const a = `%${t.replace(/[%_]/g, "\\$&")}%`, s = await u.$queryRaw`
            SELECT entity_type, entity_id, chapter_id, novel_id, title, volume_title, content, chapter_order, volume_order, volume_id
            FROM search_index
            WHERE novel_id = ${r} 
            AND (content LIKE ${a} OR title LIKE ${a} OR volume_title LIKE ${a})
            ORDER BY volume_order ASC, chapter_order ASC
            LIMIT ${e} OFFSET ${n};
        `, i = [], l = t.toLowerCase(), v = /* @__PURE__ */ new Set();
    for (const m of s) {
      const C = m.content || "", I = m.title || "", g = m.volume_title || "", p = Number(m.chapter_order || 0), y = Number(m.volume_order || 0);
      m.entity_type === "chapter" && g && g.toLowerCase().includes(l) && (v.has(g) || (i.push({
        entityType: "chapter",
        entityId: m.entity_id,
        chapterId: m.chapter_id,
        novelId: m.novel_id,
        title: m.title,
        snippet: `Volume match: <mark>${g}</mark>`,
        preview: `Found in Volume: ${g}`,
        keyword: t,
        matchType: "volume",
        chapterOrder: p,
        volumeTitle: g,
        volumeOrder: y,
        volumeId: m.volume_id
      }), v.add(g))), m.entity_type === "chapter" && I.toLowerCase().includes(l) && i.push({
        entityType: "chapter",
        entityId: m.entity_id,
        chapterId: m.chapter_id,
        novelId: m.novel_id,
        title: m.title,
        snippet: `Title match: <mark>${I}</mark>`,
        preview: `Found in Title: ${I}`,
        keyword: t,
        matchType: "title",
        chapterOrder: p,
        volumeTitle: g,
        volumeOrder: y,
        volumeId: m.volume_id
      });
      const f = C.toLowerCase(), h = [];
      let c = 0;
      for (; c < f.length && h.length < 200; ) {
        const S = f.indexOf(l, c);
        if (S === -1)
          break;
        h.push(S), c = S + l.length;
      }
      const d = 60, w = [];
      for (const S of h)
        (w.length === 0 || S - w[w.length - 1] > d) && w.push(S);
      for (const S of w)
        i.push({
          entityType: m.entity_type,
          entityId: m.entity_id,
          chapterId: m.chapter_id,
          novelId: m.novel_id,
          title: m.title,
          snippet: Ot(C, t, S, 10, !0),
          preview: Ot(C, t, S, 25, !1),
          keyword: t,
          matchType: "content",
          chapterOrder: p,
          volumeTitle: g,
          volumeOrder: y,
          volumeId: m.volume_id
        });
    }
    return i;
  } catch (o) {
    return console.error("[SearchIndex] Search failed:", o), [];
  }
}
function Ot(r, t, e, n = 30, o = !0) {
  if (!r)
    return "";
  const a = Math.max(0, e - n), s = Math.min(r.length, e + t.length + n * 2);
  let i = "";
  a > 0 && (i += "...");
  const l = r.substring(a, e), v = r.substring(e, e + t.length), m = r.substring(e + t.length, s);
  return o ? i += l + "<mark>" + v + "</mark>" + m : i += l + v + m, s < r.length && (i += "..."), i;
}
async function pr(r) {
  var n, o;
  let t = 0, e = 0;
  try {
    await u.$executeRaw`DELETE FROM search_index WHERE novel_id = ${r};`;
    const a = await u.chapter.findMany({
      where: { volume: { novelId: r } },
      select: {
        id: !0,
        title: !0,
        content: !0,
        volumeId: !0,
        order: !0,
        volume: { select: { title: !0, order: !0 } }
      }
    });
    for (const i of a)
      await Ie({
        ...i,
        novelId: r,
        volumeTitle: (n = i.volume) == null ? void 0 : n.title,
        volumeOrder: (o = i.volume) == null ? void 0 : o.order
      }), t++;
    const s = await u.idea.findMany({
      where: { novelId: r },
      select: { id: !0, content: !0, quote: !0, novelId: !0, chapterId: !0 }
    });
    for (const i of s)
      await _t(i), e++;
  } catch (a) {
    console.error("[SearchIndex] Rebuild failed:", a);
  }
  return { chapters: t, ideas: e };
}
async function Kr(r) {
  try {
    const t = await u.$queryRaw`
            SELECT entity_type, COUNT(*) as count FROM search_index WHERE novel_id = ${r} GROUP BY entity_type;
        `;
    let e = 0, n = 0;
    return t.forEach((o) => {
      o.entity_type === "chapter" && (e = Number(o.count)), o.entity_type === "idea" && (n = Number(o.count));
    }), { chapters: e, ideas: n };
  } catch (t) {
    return console.error("[SearchIndex] Failed to get stats:", t), { chapters: 0, ideas: 0 };
  }
}
class q extends Error {
  constructor(e, n, o) {
    super(n);
    G(this, "code");
    G(this, "detail");
    this.code = e, this.detail = o, this.name = "AiActionError";
  }
}
function Xr(r) {
  const t = r.toLowerCase();
  return t.includes("timed out") || t.includes("timeout") || t.includes("aborterror") || t.includes("aborted") ? new q("PROVIDER_TIMEOUT", r) : t.includes("401") || t.includes("403") || t.includes("unauthorized") || t.includes("forbidden") || t.includes("api key") ? new q("PROVIDER_AUTH", r) : t.includes("content_filter") || t.includes("safety") || t.includes("filtered") ? new q("PROVIDER_FILTERED", r) : t.includes("429") || t.includes("503") || t.includes("model") || t.includes("unavailable") ? new q("PROVIDER_UNAVAILABLE", r) : t.includes("fetch") || t.includes("network") || t.includes("econn") ? new q("NETWORK_ERROR", r) : new q("UNKNOWN", r);
}
function de(r) {
  if (r instanceof q)
    return r;
  const t = r instanceof Error ? r.message : String(r ?? "unknown error");
  return Xr(t);
}
function Te(r, t) {
  switch (r) {
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
      return t || "未知错误，请稍后重试。";
  }
}
const Yr = "debug-dev.log", Qr = 15 * 1024 * 1024, en = "***REDACTED***", tn = /* @__PURE__ */ new Set([
  "authorization",
  "apikey",
  "api_key",
  "api key",
  "token",
  "access_token",
  "refresh_token"
]);
let he = null;
function bt() {
  return process.env.NODE_ENV !== "production";
}
function Mt(r) {
  bt() && (he = k.join(r, Yr), hr());
}
function ne(r) {
  return yt(r, /* @__PURE__ */ new WeakSet());
}
function L(r, t, e, n) {
  if (!bt())
    return;
  const o = [
    `[${(/* @__PURE__ */ new Date()).toISOString()}] [${r}] [${t}]`,
    `message=${e}`,
    n === void 0 ? "" : `extra=${nn(ne(n))}`,
    ""
  ].filter(Boolean);
  rn(o.join(`
`));
}
function ce(r, t, e) {
  const n = fr(t);
  L("ERROR", r, n.message, {
    error: n,
    ...e === void 0 ? {} : { extra: e }
  });
}
function hr() {
  if (!he)
    return;
  const r = k.dirname(he);
  W.existsSync(r) || W.mkdirSync(r, { recursive: !0 }), W.existsSync(he) || W.writeFileSync(he, "", "utf8");
}
function rn(r) {
  if (he)
    try {
      hr(), (W.existsSync(he) ? W.statSync(he).size : 0) >= Qr && W.writeFileSync(he, "", "utf8"), W.appendFileSync(he, `${r}
`, "utf8");
    } catch {
    }
}
function nn(r) {
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
}
function fr(r) {
  return r instanceof Error ? {
    name: r.name,
    message: r.message,
    stack: r.stack
  } : {
    name: typeof r,
    message: String(r)
  };
}
function yt(r, t) {
  if (r == null || typeof r == "string" || typeof r == "number" || typeof r == "boolean")
    return r;
  if (typeof r == "bigint")
    return r.toString();
  if (r instanceof Error)
    return fr(r);
  if (Array.isArray(r))
    return r.map((e) => yt(e, t));
  if (typeof r == "object") {
    const e = r;
    if (t.has(e))
      return "[Circular]";
    t.add(e);
    const n = {};
    for (const [o, a] of Object.entries(e)) {
      if (tn.has(o.toLowerCase())) {
        n[o] = en;
        continue;
      }
      n[o] = yt(a, t);
    }
    return t.delete(e), n;
  }
  return String(r);
}
function nt(r, t) {
  return `${r.replace(/\/+$/, "")}/${t.replace(/^\/+/, "")}`;
}
function $t(r) {
  try {
    return JSON.parse(r);
  } catch {
    return null;
  }
}
function ot(r) {
  var a, s;
  const t = String((r == null ? void 0 : r.message) || "unknown error"), e = ((a = r == null ? void 0 : r.cause) == null ? void 0 : a.code) || (r == null ? void 0 : r.code), n = (s = r == null ? void 0 : r.cause) == null ? void 0 : s.message, o = [t];
  return e && o.push(`code=${e}`), n && n !== t && o.push(`cause=${n}`), o.join(" | ");
}
async function at(r, t) {
  try {
    return await Et.fetch(r, t);
  } catch {
    return await fetch(r, t);
  }
}
class gr {
  constructor(t) {
    G(this, "name", "http");
    this.settings = t;
  }
  async healthCheck() {
    const { baseUrl: t, apiKey: e, timeoutMs: n } = this.settings.http;
    if (!t.trim())
      return { ok: !1, detail: "HTTP baseUrl is empty" };
    try {
      new URL(t);
    } catch {
      return { ok: !1, detail: "HTTP baseUrl is invalid" };
    }
    if (!e.trim())
      return { ok: !1, detail: "API key is empty" };
    const o = new AbortController();
    let a = !1;
    const s = Math.max(1e3, n), i = setTimeout(() => {
      a = !0, o.abort();
    }, s), l = nt(t, "models"), v = Date.now();
    try {
      L("INFO", "HttpProvider.healthCheck.request", "HTTP health check request", {
        url: l,
        timeoutMs: s,
        headers: { Authorization: `Bearer ${e}` }
      });
      const m = await at(l, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${e}`
        },
        signal: o.signal
      });
      return m.ok ? (L("INFO", "HttpProvider.healthCheck.response", "HTTP health check ok", {
        url: l,
        status: m.status,
        elapsedMs: Date.now() - v
      }), { ok: !0, detail: "HTTP provider is reachable" }) : (L("WARN", "HttpProvider.healthCheck.response", "HTTP health check rejected", {
        url: l,
        status: m.status,
        elapsedMs: Date.now() - v
      }), { ok: !1, detail: `HTTP provider rejected: ${m.status}` });
    } catch (m) {
      return ce("HttpProvider.healthCheck.error", m, {
        url: l,
        elapsedMs: Date.now() - v,
        didTimeout: a
      }), a ? { ok: !1, detail: `HTTP health check timed out after ${s}ms` } : { ok: !1, detail: `HTTP health check failed: ${ot(m)} | url=${l}` };
    } finally {
      clearTimeout(i);
    }
  }
  async generate(t) {
    var m, C, I, g, p, y;
    const e = t.prompt.trim();
    if (!e)
      return { text: "", model: this.settings.http.model };
    const n = new AbortController();
    let o = !1;
    const a = Math.max(1e3, t.timeoutMs ?? this.settings.http.timeoutMs), s = setTimeout(() => {
      o = !0, n.abort();
    }, a), i = {
      model: this.settings.http.model,
      messages: [
        ...t.systemPrompt ? [{ role: "system", content: t.systemPrompt }] : [],
        { role: "user", content: e }
      ],
      max_tokens: t.maxTokens ?? this.settings.http.maxTokens,
      temperature: t.temperature ?? this.settings.http.temperature
    }, l = nt(this.settings.http.baseUrl, "chat/completions"), v = Date.now();
    try {
      L("INFO", "HttpProvider.generate.request", "AI text generation request", {
        url: l,
        timeoutMs: a,
        body: ne(i)
      });
      const f = await at(l, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.http.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(i),
        signal: n.signal
      }), h = await f.text(), c = $t(h);
      if (L("INFO", "HttpProvider.generate.response", "AI text generation response", {
        url: l,
        status: f.status,
        elapsedMs: Date.now() - v,
        text: h
      }), !f.ok)
        throw new Error(((m = c == null ? void 0 : c.error) == null ? void 0 : m.message) || `HTTP ${f.status}: ${h.slice(0, 300)}`);
      const d = ((g = (I = (C = c == null ? void 0 : c.choices) == null ? void 0 : C[0]) == null ? void 0 : I.message) == null ? void 0 : g.content) || (c == null ? void 0 : c.output_text) || ((y = (p = c == null ? void 0 : c.content) == null ? void 0 : p[0]) == null ? void 0 : y.text) || "";
      return {
        text: typeof d == "string" ? d : JSON.stringify(d),
        model: (c == null ? void 0 : c.model) || this.settings.http.model
      };
    } catch (f) {
      throw ce("HttpProvider.generate.error", f, {
        url: l,
        elapsedMs: Date.now() - v,
        didTimeout: o,
        requestBody: ne(i)
      }), o || (f == null ? void 0 : f.name) === "AbortError" ? new Error(`HTTP request timeout after ${a}ms`) : new Error(`HTTP request failed: ${ot(f)} | url=${l}`);
    } finally {
      clearTimeout(s);
    }
  }
  async generateImage(t) {
    var m, C;
    const e = t.prompt.trim();
    if (!e)
      return {};
    const n = new AbortController();
    let o = !1;
    const a = Math.max(1e3, this.settings.http.timeoutMs), s = setTimeout(() => {
      o = !0, n.abort();
    }, a), i = {
      model: t.model || this.settings.http.model,
      prompt: e,
      size: t.size || "1024x1024",
      output_format: t.outputFormat || "png",
      watermark: t.watermark ?? !0
    }, l = nt(this.settings.http.baseUrl, "images/generations"), v = Date.now();
    try {
      L("INFO", "HttpProvider.generateImage.request", "AI image generation request", {
        url: l,
        timeoutMs: a,
        body: ne(i)
      });
      const I = await at(l, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.http.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(i),
        signal: n.signal
      }), g = await I.text(), p = $t(g);
      if (L("INFO", "HttpProvider.generateImage.response", "AI image generation response", {
        url: l,
        status: I.status,
        elapsedMs: Date.now() - v,
        text: g
      }), !I.ok)
        throw new Error(((m = p == null ? void 0 : p.error) == null ? void 0 : m.message) || `HTTP ${I.status}: ${g.slice(0, 300)}`);
      const y = ((C = p == null ? void 0 : p.data) == null ? void 0 : C[0]) || {};
      return {
        imageUrl: y.url,
        imageBase64: y.b64_json,
        mimeType: "image/png"
      };
    } catch (I) {
      throw ce("HttpProvider.generateImage.error", I, {
        url: l,
        elapsedMs: Date.now() - v,
        didTimeout: o,
        requestBody: ne(i)
      }), o || (I == null ? void 0 : I.name) === "AbortError" ? new Error(`HTTP request timeout after ${a}ms`) : new Error(`HTTP request failed: ${ot(I)} | url=${l}`);
    } finally {
      clearTimeout(s);
    }
  }
}
const H = "[Summary]", yr = {
  summaryMode: "local",
  summaryTriggerPolicy: "manual",
  summaryDebounceMs: 3e4,
  summaryMinIntervalMs: 18e4,
  summaryMinWordDelta: 120,
  summaryFinalizeStableMs: 6e5,
  summaryFinalizeMinWords: 1200,
  recentChapterRawCount: 2
}, Ce = {
  providerType: "http",
  http: {
    baseUrl: "",
    apiKey: "",
    model: "gpt-4.1-mini",
    imageModel: "doubao-seedream-5-0-260128",
    imageSize: "2K",
    imageOutputFormat: "png",
    imageWatermark: !1,
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
  summary: yr,
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
}, it = /* @__PURE__ */ new Map(), Pe = /* @__PURE__ */ new Map(), st = /* @__PURE__ */ new Map(), ct = /* @__PURE__ */ new Map();
let Rt = !1, He = null;
function on(r) {
  He = r;
}
function vt(r, t, e) {
  try {
    He == null || He(r, t, e);
  } catch (n) {
    console.warn(`${H} failed to notify RAG summary index refresh:`, n);
  }
}
function an(r) {
  if (!(r != null && r.trim()))
    return "";
  try {
    const t = JSON.parse(r), e = [], n = (o) => {
      !o || typeof o != "object" || (typeof o.text == "string" && e.push(o.text), Array.isArray(o.children) && o.children.forEach(n));
    };
    return n((t == null ? void 0 : t.root) || t), e.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return r.replace(/\s+/g, " ").trim();
  }
}
function sn(r) {
  return r ? r.split(/[。！？!?]/).map((e) => e.trim()).filter(Boolean).slice(0, 5).map((e, n) => `fact_${n + 1}: ${e.slice(0, 80)}`) : [];
}
function cn(r) {
  return r ? r.split(/[。！？!?]/).map((t) => t.trim()).filter((t) => t.includes("？") || t.includes("?")).slice(0, 5) : [];
}
function ln(r, t, e, n) {
  const o = Number.isFinite(t) ? `第${t}章` : "章节", a = n.length > 0 ? n.join(" | ") : "无明显关键事实";
  return `${o}《${r || "未命名章节"}》摘要：${e}
关键事实：${a}`;
}
function Ut(r) {
  if (typeof r != "string" || !r.trim())
    return [];
  try {
    const t = JSON.parse(r);
    return Array.isArray(t) ? t.map((e) => String(e || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function dn(r) {
  return Ze("sha256").update(r.join("|")).digest("hex");
}
function un(r, t, e) {
  const n = r === "volume" ? `卷级摘要（覆盖${t}章）` : `全书摘要（覆盖${t}章）`, o = e.map((a, s) => `${s + 1}. ${a}`).join(`
`);
  return `${n}
${o}`.slice(0, 2400);
}
function mn() {
  return k.join(O.getPath("userData"), "ai-settings.json");
}
function vr() {
  try {
    const r = mn();
    if (!W.existsSync(r))
      return Ce;
    const t = W.readFileSync(r, "utf8"), e = JSON.parse(t);
    return {
      ...Ce,
      ...e,
      http: { ...Ce.http, ...e.http ?? {} },
      mcpCli: { ...Ce.mcpCli, ...e.mcpCli ?? {} },
      proxy: { ...Ce.proxy, ...e.proxy ?? {} },
      summary: { ...yr, ...e.summary ?? {} }
    };
  } catch (r) {
    return console.warn(`${H} failed to load ai-settings.json, fallback to defaults:`, r), Ce;
  }
}
async function Ft(r, t) {
  return {
    summaryText: r.slice(0, 220) || "章节内容为空，暂无可提炼摘要。",
    keyFacts: sn(r),
    openQuestions: cn(r),
    timelineHints: [`chapter_order:${t ?? "unknown"}`],
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
async function pn(r, t, e, n) {
  var C, I;
  if (!(e.providerType === "http" && !!((C = e.http.baseUrl) != null && C.trim()) && !!((I = e.http.apiKey) != null && I.trim())))
    throw new Error("AI summary mode requires HTTP provider with baseUrl and apiKey");
  console.log(`${H} [${r}] AI summary start (model=${e.http.model})`);
  const a = new gr(e), s = Date.now(), i = await a.generate({
    systemPrompt: [
      "You summarize novel chapters for continuity memory.",
      "Return strict JSON only.",
      'Schema: {"summaryText":"...","keyFacts":["..."],"openQuestions":["..."],"timelineHints":["..."]}'
    ].join(" "),
    prompt: JSON.stringify({
      task: "chapter_memory_summary",
      chapterOrder: n,
      content: t.slice(0, 8e3),
      constraints: [
        "summaryText should be concise and neutral",
        "keyFacts at most 6 items",
        "openQuestions at most 4 items"
      ]
    }),
    maxTokens: Math.min(1024, e.http.maxTokens),
    temperature: Math.min(0.3, e.http.temperature)
  }), l = JSON.parse(i.text || "{}"), v = String(l.summaryText || "").trim();
  if (!v)
    throw new Error("AI summary returned empty summaryText");
  const m = Date.now() - s;
  return console.log(`${H} [${r}] AI summary success (${m}ms)`), {
    summaryText: v.slice(0, 400),
    keyFacts: Array.isArray(l.keyFacts) ? l.keyFacts.map((g) => String(g).trim()).filter(Boolean).slice(0, 6) : [],
    openQuestions: Array.isArray(l.openQuestions) ? l.openQuestions.map((g) => String(g).trim()).filter(Boolean).slice(0, 4) : [],
    timelineHints: Array.isArray(l.timelineHints) ? l.timelineHints.map((g) => String(g).trim()).filter(Boolean).slice(0, 6) : [`chapter_order:${n ?? "unknown"}`],
    provider: "http",
    model: e.http.model,
    promptVersion: "chapter-summary-ai-v1",
    temperature: Math.min(0.3, e.http.temperature),
    maxTokens: Math.min(1024, e.http.maxTokens),
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: m
  };
}
async function Bt(r, t, e) {
  const n = r === "volume" ? { novelId: t, volumeId: e || "", isLatest: !0, status: "active" } : { novelId: t, isLatest: !0, status: "active" }, o = await u.chapterSummary.findMany({
    where: n,
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
    take: r === "volume" ? 120 : 300
  });
  if (o.length === 0)
    return null;
  const a = o.map((f) => f.chapterId), s = o.map((f) => Number(f.chapterOrder)).filter((f) => Number.isFinite(f)), i = s.length > 0 ? Math.min(...s) : null, l = s.length > 0 ? Math.max(...s) : null, v = o.map((f) => String(f.summaryText || "").trim()).filter(Boolean).slice(-10), m = [...new Set(
    o.flatMap((f) => Ut(f.keyFacts))
  )].map((f) => String(f || "").slice(0, 120)).filter(Boolean).slice(0, 24), C = [...new Set(
    o.flatMap((f) => Ut(f.openQuestions))
  )].map((f) => String(f || "").slice(0, 120)).filter(Boolean).slice(0, 20), I = [
    r === "volume" ? "保持本卷叙事风格一致" : "保持全书叙事风格一致",
    "优先遵循现有大纲与关键事实"
  ], g = [
    "不得与已确认关键事实冲突",
    "保持角色动机与关系连续"
  ], p = dn(
    o.map((f) => `${f.id}:${new Date(f.updatedAt).toISOString()}`)
  );
  let y = null;
  if (r === "volume" && e) {
    const f = await u.volume.findUnique({
      where: { id: e },
      select: { title: !0 }
    });
    y = (f == null ? void 0 : f.title) || null;
  }
  return {
    title: y,
    summaryText: un(r, a.length, v),
    keyFacts: m,
    unresolvedThreads: C,
    styleGuide: I,
    hardConstraints: g,
    coverageChapterIds: a,
    chapterRangeStart: i,
    chapterRangeEnd: l,
    sourceFingerprint: p
  };
}
async function jt(r, t, e, n) {
  return u.$transaction(async (o) => {
    await o.narrativeSummary.updateMany({
      where: {
        novelId: t,
        level: r,
        volumeId: r === "volume" && n || null,
        isLatest: !0
      },
      data: {
        isLatest: !1,
        status: "stale"
      }
    });
    const a = await o.narrativeSummary.findFirst({
      where: {
        novelId: t,
        level: r,
        volumeId: r === "volume" && n || null,
        sourceFingerprint: e.sourceFingerprint
      }
    }), s = {
      novelId: t,
      volumeId: r === "volume" && n || null,
      level: r,
      title: e.title || null,
      summaryText: e.summaryText,
      keyFacts: JSON.stringify(e.keyFacts),
      unresolvedThreads: JSON.stringify(e.unresolvedThreads),
      styleGuide: JSON.stringify(e.styleGuide),
      hardConstraints: JSON.stringify(e.hardConstraints),
      coverageChapterIds: JSON.stringify(e.coverageChapterIds),
      chapterRangeStart: e.chapterRangeStart,
      chapterRangeEnd: e.chapterRangeEnd,
      sourceFingerprint: e.sourceFingerprint,
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
    return a != null && a.id ? (await o.narrativeSummary.update({
      where: { id: a.id },
      data: s
    })).id : (await o.narrativeSummary.create({ data: s })).id;
  });
}
async function hn(r, t) {
  try {
    const [e, n] = await Promise.all([
      Bt("volume", r, t),
      Bt("novel", r, null)
    ]);
    if (e) {
      const o = await jt("volume", r, e, t);
      console.log(`${H} [novel=${r}] narrative summary updated (level=volume, volume=${t})`), o && vt("narrativeSummary", o, "narrative-summary-volume");
    }
    if (n) {
      const o = await jt("novel", r, n, null);
      console.log(`${H} [novel=${r}] narrative summary updated (level=novel)`), o && vt("narrativeSummary", o, "narrative-summary-novel");
    }
  } catch (e) {
    console.error(`${H} [novel=${r}] narrative summary rebuild failed:`, e);
  }
}
function fn(r, t) {
  const e = `${r}:${t}`, n = ct.get(e);
  n && clearTimeout(n);
  const o = setTimeout(() => {
    ct.delete(e), hn(r, t);
  }, 15e3);
  ct.set(e, o);
}
async function lt(r, t) {
  var d;
  const e = vr(), n = !!(t != null && t.force), o = (t == null ? void 0 : t.reason) || "save", a = e.summary.summaryMode === "ai", s = a ? Math.max(18e5, e.summary.summaryMinIntervalMs) : e.summary.summaryMinIntervalMs, i = a ? Math.max(800, e.summary.summaryMinWordDelta) : e.summary.summaryMinWordDelta, l = await u.chapter.findUnique({
    where: { id: r },
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
  if (!((d = l == null ? void 0 : l.volume) != null && d.novelId)) {
    console.log(`${H} [${r}] skip: chapter or novel relation missing`);
    return;
  }
  if (!Rt)
    try {
      const w = await u.$queryRawUnsafe("PRAGMA database_list;"), S = Array.isArray(w) ? w.find((_) => (_ == null ? void 0 : _.name) === "main") : null;
      console.log(`${H} sqlite main db path: ${(S == null ? void 0 : S.file) || "unknown"}`);
    } catch {
      console.warn(`${H} failed to read sqlite db path via PRAGMA database_list`);
    } finally {
      Rt = !0;
    }
  const v = l.content || "", m = Ze("sha256").update(v).digest("hex"), C = Date.now(), I = await u.chapterSummary.findFirst({
    where: {
      chapterId: l.id,
      isLatest: !0,
      status: "active",
      summaryType: "standard"
    },
    orderBy: { updatedAt: "desc" }
  });
  if (!n && (I == null ? void 0 : I.sourceContentHash) === m) {
    console.log(`${H} [${r}] skip: same content hash`);
    return;
  }
  const g = Math.abs((l.wordCount || 0) - Number((I == null ? void 0 : I.sourceWordCount) || 0)), p = I != null && I.updatedAt ? new Date(I.updatedAt).getTime() : 0, y = p > 0 ? C - p : Number.MAX_SAFE_INTEGER;
  if (!n && p > 0 && y < s && g < i) {
    console.log(
      `${H} [${r}] skip: throttled (deltaWords=${g}, sinceLastMs=${y}, minIntervalMs=${s}, minWordDelta=${i})`
    );
    return;
  }
  const f = an(v);
  console.log(
    `${H} [${r}] start rebuild (reason=${o}, mode=${e.summary.summaryMode}, words=${l.wordCount || f.length}, deltaWords=${g}, force=${n})`
  );
  let h = await Ft(f, l.order ?? null);
  if (e.summary.summaryMode === "ai")
    try {
      h = await pn(r, f, e, l.order ?? null);
    } catch (w) {
      console.warn(`${H} [${r}] AI summary failed, fallback to local: ${(w == null ? void 0 : w.message) || "unknown error"}`), h = {
        ...await Ft(f, l.order ?? null),
        errorCode: "AI_SUMMARY_FALLBACK",
        errorDetail: (w == null ? void 0 : w.message) || "unknown ai summary error"
      };
    }
  const c = await u.$transaction(async (w) => {
    await w.chapterSummary.updateMany({
      where: { chapterId: l.id, isLatest: !0 },
      data: { isLatest: !1, status: "stale" }
    });
    const S = await w.chapterSummary.findFirst({
      where: {
        chapterId: l.id,
        sourceContentHash: m,
        summaryType: "standard"
      }
    }), _ = {
      novelId: l.volume.novelId,
      volumeId: l.volumeId,
      chapterId: l.id,
      summaryType: "standard",
      summaryText: h.summaryText,
      compressedMemory: ln(l.title || "", l.order ?? null, h.summaryText, h.keyFacts),
      keyFacts: JSON.stringify(h.keyFacts),
      entitiesSnapshot: JSON.stringify({}),
      timelineHints: JSON.stringify(h.timelineHints),
      openQuestions: JSON.stringify(h.openQuestions),
      sourceContentHash: m,
      sourceWordCount: l.wordCount || f.length,
      sourceUpdatedAt: l.updatedAt,
      chapterOrder: l.order ?? null,
      provider: h.provider,
      model: h.model,
      promptVersion: h.promptVersion,
      temperature: h.temperature,
      maxTokens: h.maxTokens,
      inputTokens: h.inputTokens,
      outputTokens: h.outputTokens,
      latencyMs: h.latencyMs,
      qualityScore: null,
      status: "active",
      errorCode: h.errorCode || null,
      errorDetail: h.errorDetail || null,
      isLatest: !0
    };
    if (S != null && S.id) {
      const x = await w.chapterSummary.update({
        where: { id: S.id },
        data: _
      });
      return console.log(`${H} [${r}] done: updated existing summary`), x.id;
    }
    const A = await w.chapterSummary.create({
      data: _
    });
    return console.log(`${H} [${r}] done: created new summary`), A.id;
  });
  c && vt("chapterSummary", c, "chapter-summary"), fn(l.volume.novelId, l.volumeId);
}
function Tt(r, t = "save") {
  const e = vr();
  if (t === "manual") {
    console.log(`${H} [${r}] manual trigger received`), lt(r, { force: !0, reason: "manual" }).catch((i) => {
      console.error(`${H} [${r}] manual rebuild failed:`, i);
    });
    return;
  }
  if (e.summary.summaryMode === "ai" && e.summary.summaryTriggerPolicy === "manual") {
    console.log(`${H} [${r}] skip scheduling: ai mode manual-only policy`);
    return;
  }
  if (e.summary.summaryMode === "ai" && e.summary.summaryTriggerPolicy === "finalized") {
    const i = Math.max(6e4, e.summary.summaryFinalizeStableMs), l = st.get(r);
    l && clearTimeout(l);
    const v = setTimeout(async () => {
      st.delete(r);
      const m = await u.chapter.findUnique({
        where: { id: r },
        select: { wordCount: !0 }
      }), C = (m == null ? void 0 : m.wordCount) || 0;
      if (C < e.summary.summaryFinalizeMinWords) {
        console.log(
          `${H} [${r}] finalized trigger skipped (wordCount=${C}, min=${e.summary.summaryFinalizeMinWords})`
        );
        return;
      }
      console.log(`${H} [${r}] finalized trigger fired after stable window ${i}ms`), lt(r, { force: !0, reason: "finalized" }).catch((I) => {
        console.error(`${H} [${r}] finalized rebuild failed:`, I);
      });
    }, i);
    st.set(r, v), console.log(`${H} [${r}] finalized trigger scheduled (${i}ms stable window)`);
    return;
  }
  const n = e.summary.summaryMode === "ai", o = Math.max(n ? 3e5 : 1e3, e.summary.summaryDebounceMs), a = it.get(r);
  if (n) {
    if (a) {
      const i = (Pe.get(r) || 0) + 1;
      Pe.set(r, i), i % 10 === 0 && console.log(`${H} [${r}] ai mode coalescing saves (${i} updates queued, timer unchanged)`);
      return;
    }
    Pe.set(r, 1), console.log(`${H} [${r}] ai mode scheduled (${o}ms, fixed window)`);
  } else
    a ? (clearTimeout(a), console.log(`${H} [${r}] debounce reset (${o}ms)`)) : console.log(`${H} [${r}] debounce scheduled (${o}ms)`);
  const s = setTimeout(() => {
    it.delete(r);
    const i = Pe.get(r) || 0;
    Pe.delete(r), console.log(n ? `${H} [${r}] ai mode fired after coalescing ${i} saves` : `${H} [${r}] debounce fired, evaluating rebuild`), lt(r).catch((l) => {
      console.error(`${H} [${r}] rebuild failed:`, l);
    });
  }, o);
  it.set(r, s);
}
function gn(r) {
  return [
    {
      actionId: "novel.list",
      title: "List novels",
      description: "Return novels sorted by update time.",
      permission: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "array" },
      handler: async () => u.novel.findMany({ orderBy: { updatedAt: "desc" } })
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId))
          throw new q("INVALID_INPUT", "novelId is required");
        return u.volume.findMany({
          where: { novelId: e.novelId },
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
      handler: async (t) => {
        var o;
        const e = t, n = ((o = e == null ? void 0 : e.title) == null ? void 0 : o.trim()) || `新作品 ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`;
        return u.novel.create({
          data: {
            title: n,
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.volumeId))
          throw new q("INVALID_INPUT", "volumeId is required");
        return u.chapter.findMany({
          where: { volumeId: e.volumeId },
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
      handler: async (t) => {
        var o;
        const e = t;
        if (!(e != null && e.volumeId))
          throw new q("INVALID_INPUT", "volumeId is required");
        let n = e.order;
        if (!Number.isFinite(n)) {
          const a = await u.chapter.findFirst({
            where: { volumeId: e.volumeId },
            orderBy: { order: "desc" }
          });
          n = ((a == null ? void 0 : a.order) || 0) + 1;
        }
        return u.chapter.create({
          data: {
            volumeId: e.volumeId,
            title: ((o = e.title) == null ? void 0 : o.trim()) || "",
            order: n,
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.chapterId))
          throw new q("INVALID_INPUT", "chapterId is required");
        return u.chapter.findUnique({
          where: { id: e.chapterId },
          include: { volume: { select: { novelId: !0 } } }
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.chapterId))
          throw new q("INVALID_INPUT", "chapterId is required");
        if (typeof e.content != "string")
          throw new q("INVALID_INPUT", "content is required");
        const n = e.source === "ai_ui" ? "ai_ui" : "ai_agent", o = await u.chapter.findUnique({
          where: { id: e.chapterId },
          select: { id: !0, content: !0, updatedAt: !0, wordCount: !0, volume: { select: { novelId: !0 } } }
        });
        if (!o || !o.volume)
          throw new q("NOT_FOUND", "Chapter or volume not found");
        const a = e.content.length, s = a - o.wordCount;
        try {
          const [, i] = await u.$transaction([
            u.novel.update({
              where: { id: o.volume.novelId },
              data: { wordCount: { increment: s }, updatedAt: /* @__PURE__ */ new Date() }
            }),
            u.chapter.update({
              where: { id: e.chapterId },
              data: { content: e.content, wordCount: a, updatedAt: /* @__PURE__ */ new Date() }
            })
          ]);
          return Tt(e.chapterId), {
            chapter: i,
            saveMeta: {
              source: n,
              rollbackPoint: {
                chapterId: o.id,
                content: o.content,
                updatedAt: o.updatedAt
              }
            }
          };
        } catch (i) {
          const l = de(i);
          throw new q("PERSISTENCE_ERROR", l.message);
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId) || !e.chapterId || typeof e.currentContent != "string")
          throw new q("INVALID_INPUT", "novelId, chapterId, currentContent are required");
        try {
          return await r.continueWriting({
            locale: e.locale,
            mode: e.mode,
            novelId: e.novelId,
            chapterId: e.chapterId,
            currentContent: e.currentContent,
            ideaIds: Array.isArray(e.ideaIds) ? e.ideaIds : void 0,
            contextChapterCount: e.contextChapterCount,
            recentRawChapterCount: e.recentRawChapterCount,
            targetLength: e.targetLength,
            style: e.style,
            tone: e.tone,
            pace: e.pace,
            temperature: e.temperature,
            userIntent: e.userIntent,
            currentLocation: e.currentLocation,
            overrideUserPrompt: e.overrideUserPrompt
          });
        } catch (n) {
          throw de(n);
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId))
          throw new q("INVALID_INPUT", "novelId is required");
        return u.plotLine.findMany({
          where: { novelId: e.novelId },
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId))
          throw new q("INVALID_INPUT", "novelId is required");
        return u.worldSetting.findMany({
          where: { novelId: e.novelId },
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
      handler: async (t) => {
        const e = t, n = String((e == null ? void 0 : e.novelId) || "").trim(), o = String((e == null ? void 0 : e.name) || "").trim();
        if (!n)
          throw new q("INVALID_INPUT", "novelId is required");
        if (!o)
          throw new q("INVALID_INPUT", "name is required");
        let a = e == null ? void 0 : e.sortOrder;
        if (typeof a != "number" || !Number.isFinite(a)) {
          const v = await u.worldSetting.findFirst({
            where: { novelId: n },
            orderBy: { sortOrder: "desc" }
          });
          a = ((v == null ? void 0 : v.sortOrder) || 0) + 1;
        }
        const s = typeof (e == null ? void 0 : e.content) == "string" ? e.content : "", i = typeof (e == null ? void 0 : e.type) == "string" && e.type.trim() ? e.type.trim() : "other", l = typeof (e == null ? void 0 : e.icon) == "string" && e.icon.trim() ? e.icon.trim() : null;
        return u.worldSetting.create({
          data: {
            novelId: n,
            name: o,
            content: s,
            type: i,
            icon: l,
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
      handler: async (t) => {
        const e = t, n = String((e == null ? void 0 : e.id) || "").trim();
        if (!n)
          throw new q("INVALID_INPUT", "id is required");
        const o = {};
        if (Object.prototype.hasOwnProperty.call(e, "name")) {
          const a = String((e == null ? void 0 : e.name) || "").trim();
          if (!a)
            throw new q("INVALID_INPUT", "name cannot be empty");
          o.name = a;
        }
        if (Object.prototype.hasOwnProperty.call(e, "content") && (o.content = typeof (e == null ? void 0 : e.content) == "string" ? e.content : ""), Object.prototype.hasOwnProperty.call(e, "type") && (o.type = typeof (e == null ? void 0 : e.type) == "string" && e.type.trim() ? e.type.trim() : "other"), Object.prototype.hasOwnProperty.call(e, "icon") && ((e == null ? void 0 : e.icon) === null ? o.icon = null : o.icon = typeof (e == null ? void 0 : e.icon) == "string" && e.icon.trim() ? e.icon.trim() : null), Object.prototype.hasOwnProperty.call(e, "sortOrder")) {
          if (typeof (e == null ? void 0 : e.sortOrder) != "number" || !Number.isFinite(e.sortOrder))
            throw new q("INVALID_INPUT", "sortOrder must be a finite number");
          o.sortOrder = e.sortOrder;
        }
        if (Object.keys(o).length === 0)
          throw new q("INVALID_INPUT", "At least one updatable field is required");
        return u.worldSetting.update({
          where: { id: n },
          data: o
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId))
          throw new q("INVALID_INPUT", "novelId is required");
        return u.character.findMany({
          where: { novelId: e.novelId },
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId))
          throw new q("INVALID_INPUT", "novelId is required");
        return u.item.findMany({
          where: { novelId: e.novelId },
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId))
          throw new Error("novelId is required");
        return u.mapCanvas.findMany({
          where: { novelId: e.novelId },
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId) || !(e != null && e.keyword))
          throw new q("INVALID_INPUT", "novelId and keyword are required");
        return At(e.novelId, e.keyword, e.limit ?? 20, e.offset ?? 0);
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
      handler: async (t) => {
        var n;
        const e = t;
        if (!(e != null && e.novelId) || !((n = e.question) != null && n.trim()))
          throw new q("INVALID_INPUT", "novelId and question are required");
        try {
          return await r.askNovel({
            novelId: e.novelId,
            question: e.question,
            chapterId: e.chapterId,
            currentContent: e.currentContent,
            selectedText: e.selectedText,
            currentLocation: e.currentLocation,
            locale: e.locale,
            maxEvidenceItems: e.maxEvidenceItems,
            overrideUserPrompt: e.overrideUserPrompt
          });
        } catch (o) {
          throw de(o);
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
      handler: async (t) => {
        const e = t;
        if (!(e != null && e.novelId))
          throw new q("INVALID_INPUT", "novelId is required");
        return r.rebuildRagIndex(e.novelId);
      }
    }
  ];
}
function yn(r) {
  return r.trim() ? (r.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((e) => e.replace(/^['"]|['"]$/g, "")) : [];
}
class qt {
  constructor(t) {
    G(this, "name", "mcp-cli");
    this.settings = t;
  }
  async healthCheck() {
    const { cliPath: t } = this.settings.mcpCli;
    if (!t.trim())
      return { ok: !1, detail: "MCP CLI path is empty" };
    if (!W.existsSync(t))
      return { ok: !1, detail: "MCP CLI path does not exist" };
    try {
      L("INFO", "McpCliProvider.healthCheck.request", "MCP CLI health check request", {
        cliPath: t,
        timeoutMs: this.settings.mcpCli.startupTimeoutMs
      });
      const { stdout: e } = await this.runProcess(["--version"], "", this.settings.mcpCli.startupTimeoutMs);
      return L("INFO", "McpCliProvider.healthCheck.response", "MCP CLI health check response", {
        cliPath: t,
        stdout: e
      }), { ok: !0, detail: (e || "MCP CLI is executable").slice(0, 200) };
    } catch (e) {
      return ce("McpCliProvider.healthCheck.error", e, { cliPath: t }), { ok: !1, detail: `MCP CLI check failed: ${(e == null ? void 0 : e.message) || "unknown error"}` };
    }
  }
  async generate(t) {
    const e = t.prompt.trim();
    if (!e)
      return { text: "", model: "mcp-cli" };
    const n = this.settings.mcpCli.argsTemplate || "", o = n.includes("{prompt}"), a = yn(n.replace("{prompt}", e));
    L("INFO", "McpCliProvider.generate.request", "MCP CLI generate request", {
      cliPath: this.settings.mcpCli.cliPath,
      args: a,
      prompt: o ? "" : e,
      promptEmbeddedInArgs: o
    });
    const { stdout: s } = await this.runProcess(a, o ? "" : e, this.settings.mcpCli.startupTimeoutMs);
    return L("INFO", "McpCliProvider.generate.response", "MCP CLI generate response", {
      cliPath: this.settings.mcpCli.cliPath,
      stdout: s
    }), {
      text: s.trim(),
      model: "mcp-cli"
    };
  }
  async runProcess(t, e, n) {
    const { cliPath: o, workingDir: a, envJson: s } = this.settings.mcpCli, i = this.parseEnvJson(s), l = Date.now();
    return new Promise((v, m) => {
      const C = Vr(o, t, {
        cwd: a || process.cwd(),
        env: { ...process.env, ...i },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: !0
      });
      let I = "", g = "", p = !1;
      const y = setTimeout(() => {
        p || (p = !0, C.kill("SIGTERM"), L("ERROR", "McpCliProvider.runProcess.timeout", "MCP CLI process timeout", {
          cliPath: o,
          args: t,
          elapsedMs: Date.now() - l
        }), m(new Error("MCP CLI process timeout")));
      }, Math.max(1e3, n));
      C.stdout.on("data", (f) => {
        I += f.toString();
      }), C.stderr.on("data", (f) => {
        g += f.toString();
      }), C.on("error", (f) => {
        p || (p = !0, clearTimeout(y), ce("McpCliProvider.runProcess.error", f, {
          cliPath: o,
          args: t,
          elapsedMs: Date.now() - l,
          env: ne(i)
        }), m(f));
      }), C.on("close", (f) => {
        if (!p) {
          if (p = !0, clearTimeout(y), f !== 0) {
            L("ERROR", "McpCliProvider.runProcess.exit", "MCP CLI exited with non-zero code", {
              cliPath: o,
              args: t,
              code: f,
              elapsedMs: Date.now() - l,
              stderr: g
            }), m(new Error(`MCP CLI exited with code ${f}: ${g.slice(0, 300)}`));
            return;
          }
          L("INFO", "McpCliProvider.runProcess.exit", "MCP CLI process completed", {
            cliPath: o,
            args: t,
            code: f,
            elapsedMs: Date.now() - l,
            stderr: g
          }), v({ stdout: I, stderr: g });
        }
      }), e && C.stdin.write(e), C.stdin.end();
    });
  }
  parseEnvJson(t) {
    if (!t.trim())
      return {};
    try {
      const e = JSON.parse(t);
      if (!e || typeof e != "object")
        return {};
      const n = {};
      for (const [o, a] of Object.entries(e))
        n[o] = String(a ?? "");
      return n;
    } catch {
      return {};
    }
  }
}
function dt(r) {
  const t = /* @__PURE__ */ new Set(), e = [];
  for (const n of r) {
    const o = String(n || "").trim();
    if (!o)
      continue;
    const a = o.toLowerCase();
    t.has(a) || (t.add(a), e.push(o));
  }
  return e;
}
function je(r) {
  if (!(r != null && r.trim()))
    return "";
  try {
    const t = JSON.parse(r), e = [], n = (o) => {
      !o || typeof o != "object" || (typeof o.text == "string" && e.push(o.text), Array.isArray(o.children) && o.children.forEach(n));
    };
    return n((t == null ? void 0 : t.root) || t), e.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return r.replace(/\s+/g, " ").trim();
  }
}
function vn(r) {
  const t = (r.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length, e = r.length - t;
  return Math.ceil(t * 1.5 + e * 0.4);
}
class wn {
  async buildForCreativeAssets(t) {
    const e = t.includeExistingEntities !== !1, n = Math.max(0, Math.min(8, t.contextChapterCount ?? 0)), o = t.filterCompletedPlotLines !== !1, a = [], [s, i, l, v, m, C] = await Promise.all([
      e ? u.character.findMany({
        where: { novelId: t.novelId },
        select: { name: !0, role: !0, description: !0 },
        orderBy: { updatedAt: "desc" },
        take: 30
      }) : [],
      e ? u.item.findMany({
        where: { novelId: t.novelId },
        select: { name: !0, type: !0, description: !0 },
        orderBy: { updatedAt: "desc" },
        take: 30
      }) : [],
      e ? u.plotLine.findMany({
        where: { novelId: t.novelId },
        include: {
          points: {
            select: { title: !0, status: !0, description: !0 },
            orderBy: { order: "asc" }
          }
        },
        orderBy: { sortOrder: "asc" }
      }) : [],
      // 世界观始终全量传递
      u.worldSetting.findMany({
        where: { novelId: t.novelId },
        select: { name: !0, content: !0, type: !0 },
        orderBy: { sortOrder: "asc" }
      }),
      n > 0 ? u.chapter.findMany({
        where: { volume: { novelId: t.novelId } },
        select: { id: !0, title: !0, content: !0, updatedAt: !0 },
        orderBy: { updatedAt: "desc" },
        take: n
      }) : [],
      u.narrativeSummary.findMany({
        where: {
          novelId: t.novelId,
          isLatest: !0,
          status: "active",
          level: "novel"
        },
        orderBy: { updatedAt: "desc" },
        take: 1
      })
    ]), I = l.map((A) => {
      const x = Array.isArray(A.points) ? A.points : [], P = o ? x.filter((R) => R.status !== "resolved") : x;
      return {
        name: String(A.name || ""),
        description: A.description ? String(A.description) : void 0,
        points: P.map((R) => ({
          title: String(R.title || ""),
          status: String(R.status || "active")
        }))
      };
    }), g = m.map((A) => A.id), p = g.length > 0 ? await u.chapterSummary.findMany({
      where: {
        chapterId: { in: g },
        isLatest: !0,
        status: "active"
      },
      orderBy: { updatedAt: "desc" }
    }) : [], y = /* @__PURE__ */ new Map();
    for (const A of p)
      y.has(A.chapterId) || y.set(A.chapterId, A);
    let f = 0;
    const h = m.map((A) => {
      const x = y.get(A.id), P = (x == null ? void 0 : x.compressedMemory) || (x == null ? void 0 : x.summaryText);
      return typeof P == "string" && P.trim() ? { chapterId: A.id, title: A.title || "", summary: P.slice(0, 800) } : (f++, {
        chapterId: A.id,
        title: A.title || "",
        summary: je(A.content || "").slice(0, 600)
      });
    });
    f > 0 && a.push(`${f} 个章节缺少摘要，已使用原文摘录替代。`);
    const c = C.map((A) => {
      let x = [];
      if (typeof A.keyFacts == "string" && A.keyFacts.trim())
        try {
          const P = JSON.parse(A.keyFacts);
          Array.isArray(P) && (x = dt(
            P.map((R) => String(R || "").trim()).filter(Boolean).slice(0, 12)
          ).slice(0, 8));
        } catch {
        }
      return {
        level: A.level === "volume" ? "volume" : "novel",
        title: String(A.title || ""),
        summaryText: String(A.summaryText || "").slice(0, 1500),
        keyFacts: x
      };
    }), d = {
      characters: s.map((A) => ({
        name: String(A.name || ""),
        role: A.role ? String(A.role) : void 0,
        description: A.description ? String(A.description).slice(0, 200) : void 0
      })),
      items: i.map((A) => ({
        name: String(A.name || ""),
        type: A.type ? String(A.type) : void 0,
        description: A.description ? String(A.description).slice(0, 200) : void 0
      })),
      plotLines: I,
      worldSettings: v.map((A) => ({
        name: String(A.name || ""),
        content: String(A.content || ""),
        type: String(A.type || "other")
      }))
    }, w = JSON.stringify({ existingEntities: d, recentSummaries: h, narrativeSummaries: c }), S = vn(w), _ = [];
    return d.characters.length > 0 && _.push(`characters_${d.characters.length}`), d.items.length > 0 && _.push(`items_${d.items.length}`), d.plotLines.length > 0 && _.push(`plotLines_${d.plotLines.length}`), _.push(`worldSettings_${d.worldSettings.length}`), h.length > 0 && _.push(`recentChapterSummaries_${h.length}`), c.length > 0 && _.push(`narrativeSummaries_${c.length}`), _.push(`estimatedTokens_${S}`), {
      existingEntities: d,
      recentSummaries: h,
      narrativeSummaries: c,
      usedContext: _,
      warnings: a,
      estimatedTokens: S
    };
  }
  async buildForContinueWriting(t) {
    const e = Math.max(1, Math.min(8, t.contextChapterCount ?? 3)), n = Math.max(0, Math.min(e, t.recentRawChapterCount ?? 2)), [o, a, s, i, l, v, m] = await Promise.all([
      u.worldSetting.findMany({
        where: { novelId: t.novelId },
        orderBy: { updatedAt: "desc" }
      }),
      u.plotLine.findMany({
        where: { novelId: t.novelId },
        include: { points: { include: { anchors: !0 } } },
        orderBy: { sortOrder: "asc" }
      }),
      u.character.findMany({
        where: { novelId: t.novelId },
        select: { name: !0, role: !0, description: !0 },
        orderBy: { updatedAt: "desc" },
        take: 100
      }),
      u.item.findMany({
        where: { novelId: t.novelId },
        select: { name: !0, type: !0, description: !0 },
        orderBy: { updatedAt: "desc" },
        take: 100
      }),
      u.mapCanvas.findMany({
        where: { novelId: t.novelId },
        select: { name: !0, type: !0, description: !0 },
        orderBy: { updatedAt: "desc" },
        take: 50
      }),
      u.chapter.findMany({
        where: {
          id: { not: t.chapterId },
          volume: { novelId: t.novelId }
        },
        select: {
          id: !0,
          title: !0,
          content: !0,
          updatedAt: !0
        },
        orderBy: { updatedAt: "desc" },
        take: e
      }),
      u.chapter.findUnique({
        where: { id: t.chapterId },
        select: { volumeId: !0 }
      })
    ]), C = Array.isArray(t.ideaIds) ? t.ideaIds.map((E) => String(E)).filter(Boolean) : [], I = C.length > 0 ? await u.idea.findMany({
      where: {
        novelId: t.novelId,
        id: { in: C }
      },
      include: { tags: !0 },
      orderBy: { updatedAt: "desc" },
      take: 20
    }) : [], g = v.map((E) => E.id), p = g.length > 0 ? await u.chapterSummary.findMany({
      where: {
        chapterId: { in: g },
        isLatest: !0,
        status: "active"
      },
      orderBy: { updatedAt: "desc" }
    }) : [], y = /* @__PURE__ */ new Map();
    for (const E of p)
      y.has(E.chapterId) || y.set(E.chapterId, E);
    const f = { value: 0 }, c = (await u.narrativeSummary.findMany({
      where: {
        novelId: t.novelId,
        isLatest: !0,
        status: "active",
        OR: [
          { level: "novel", volumeId: null },
          ...m != null && m.volumeId ? [{ level: "volume", volumeId: m.volumeId }] : []
        ]
      },
      orderBy: { updatedAt: "desc" },
      take: 2
    })).map((E) => {
      let M = [];
      if (typeof E.keyFacts == "string" && E.keyFacts.trim())
        try {
          const D = JSON.parse(E.keyFacts);
          Array.isArray(D) && (M = dt(
            D.map((U) => String(U || "").trim()).filter(Boolean).slice(0, 12)
          ).slice(0, 5));
        } catch {
          M = [];
        }
      return {
        level: E.level === "volume" ? "volume" : "novel",
        title: String(E.title || ""),
        summaryText: String(E.summaryText || "").slice(0, 1200),
        keyFacts: M
      };
    }), d = v.map((E, M) => ({
      chapterId: E.id,
      title: E.title || "",
      excerpt: (() => {
        if (M < n)
          return je(E.content || "").slice(-1200);
        const D = y.get(E.id), U = (D == null ? void 0 : D.compressedMemory) || (D == null ? void 0 : D.summaryText);
        return typeof U == "string" && U.trim() ? U.slice(-1200) : (f.value += 1, je(E.content || "").slice(-1200));
      })()
    })), w = je(t.currentContent || "").slice(-2400), S = I.map((E) => ({
      ideaId: E.id,
      content: (E.content || "").slice(0, 800),
      quote: typeof E.quote == "string" ? E.quote.slice(0, 300) : void 0,
      tags: Array.isArray(E.tags) ? E.tags.map((M) => String(M.name || "").trim()).filter(Boolean).slice(0, 12) : []
    })), _ = {
      characters: new Set(
        s.map((E) => String((E == null ? void 0 : E.name) || "").trim()).filter(Boolean)
      ),
      items: new Set(
        i.map((E) => String((E == null ? void 0 : E.name) || "").trim()).filter(Boolean)
      ),
      worldSettings: new Set(
        o.map((E) => String((E == null ? void 0 : E.name) || "").trim()).filter(Boolean)
      )
    }, A = [], x = /@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g;
    for (const E of S) {
      const M = `${E.content || ""}
${E.quote || ""}`, D = Array.from(M.matchAll(x));
      for (const U of D) {
        const z = String(U[1] || "").trim();
        z && (_.characters.has(z) ? A.push({ name: z, kind: "character" }) : _.items.has(z) ? A.push({ name: z, kind: "item" }) : _.worldSettings.has(z) && A.push({ name: z, kind: "worldSetting" }));
      }
    }
    const P = dt(A.map((E) => `${E.kind}:${E.name}`)).map((E) => {
      const [M, ...D] = E.split(":");
      return {
        name: D.join(":"),
        kind: M === "character" || M === "item" || M === "worldSetting" ? M : "character"
      };
    }).slice(0, 20), R = String(t.currentLocation || "").trim().slice(0, 120), Q = Math.max(0, C.length - S.length), te = [];
    return f.value > 0 && te.push(`${f.value} chapter summaries missing; fell back to chapter text excerpts.`), Q > 0 && te.push(`${Q} selected ideas not found; ignored.`), {
      hardContext: {
        worldSettings: o,
        plotLines: a,
        characters: s,
        items: i,
        maps: l
      },
      dynamicContext: {
        recentChapters: d,
        selectedIdeas: S,
        selectedIdeaEntities: P,
        currentChapterBeforeCursor: w,
        ...R ? { currentLocation: R } : {},
        narrativeSummaries: c
      },
      params: {
        mode: t.mode === "new_chapter" ? "new_chapter" : "continue_chapter",
        contextChapterCount: e,
        style: t.style || "default",
        tone: t.tone || "balanced",
        pace: t.pace || "medium",
        targetLength: Math.max(100, Math.min(4e3, t.targetLength ?? 500))
      },
      usedContext: [
        "world_settings_full",
        "plot_outline_full",
        "characters_items_maps_snapshot",
        `recent_chapter_summary_memory_preferred_${e}`,
        `recent_chapter_raw_text_${n}`,
        c.length > 0 ? `narrative_summaries_${c.length}` : "narrative_summaries_0",
        S.length > 0 ? `selected_ideas_${S.length}` : "selected_ideas_0",
        P.length > 0 ? `selected_idea_entities_${P.length}` : "selected_idea_entities_0",
        ...R ? ["current_location"] : [],
        "current_chapter_before_cursor"
      ],
      warnings: te
    };
  }
}
const In = /* @__PURE__ */ new Set([
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
]), Sn = /* @__PURE__ */ new Set([
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
function wr(r) {
  const t = /* @__PURE__ */ new Set(), e = [];
  for (const n of r) {
    const o = String(n || "").trim();
    if (!o)
      continue;
    const a = o.toLowerCase();
    t.has(a) || (t.add(a), e.push(o));
  }
  return e;
}
function Cn(r) {
  const t = r.toLowerCase();
  return /冲突|矛盾|一致|合理|consisten|conflict/.test(t) ? "consistency_check" : /伏笔|坑|悬念|未解|没回收|未回收|unresolved|thread|foreshadow/.test(t) ? "unresolved_threads" : /大纲|接下来|下一步|后续写|怎么写|outline|next beat|next/.test(t) ? "outline_next" : /后续|后面|之后|还有戏|还有剧情|未来|安排|future|later/.test(t) ? "future_plot_for_entity" : /当前|现在|状态|在哪里|位置|持有|关系|current|state|status|where/.test(t) ? "character_state" : "general_qa";
}
function En(r) {
  const t = Array.from(r.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g)).map((o) => String(o[1] || "").trim()).filter(Boolean), e = Array.from(r.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g)).map((o) => o[0]).filter((o) => !In.has(o)), n = Array.from(r.matchAll(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g)).map((o) => o[0]).filter((o) => !Sn.has(o.toLowerCase()));
  return wr([...t, ...e, ...n]).slice(0, 8);
}
function _n(r, t) {
  const e = String(r || ""), n = e.toLowerCase(), o = t.map((s) => String(s || "").trim()).filter(Boolean).filter((s) => n.includes(s.toLowerCase())), a = Array.from(e.matchAll(/@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g)).map((s) => String(s[1] || "").trim()).filter(Boolean);
  return {
    intent: Cn(e),
    entityNames: wr([...o, ...a]).slice(0, 8),
    keywords: En(e)
  };
}
function zt(r, t) {
  return `${r.replace(/\/+$/, "")}/${t.replace(/^\/+/, "")}`;
}
async function An(r, t) {
  try {
    return await Et.fetch(r, t);
  } catch {
    return await fetch(r, t);
  }
}
function bn(r) {
  return Array.isArray(r) ? r.map((t) => Number(t)).filter((t) => Number.isFinite(t)) : [];
}
function Tn(r) {
  const t = r.trim().replace(/\/+$/, "");
  return t.endsWith("/embeddings") ? t : t.endsWith("/v1") ? zt(t, "embeddings") : zt(t, "v1/embeddings");
}
class Ir {
  constructor(t) {
    this.settings = t;
  }
  isEnabled() {
    return !!(this.settings.enabled && this.settings.baseUrl.trim() && this.settings.model.trim());
  }
  async embed(t) {
    var m, C;
    if (!this.isEnabled())
      throw new Error("Embedding API is disabled or incomplete.");
    const e = t.map((I) => String(I || "").trim()).filter(Boolean);
    if (e.length === 0)
      return {
        embeddings: [],
        model: this.settings.model,
        dimensions: this.settings.dimensions || 0,
        provider: "openai-compatible"
      };
    const n = new AbortController(), o = Math.max(1e3, this.settings.timeoutMs || 6e4);
    let a = !1;
    const s = setTimeout(() => {
      a = !0, n.abort();
    }, o), i = Tn(this.settings.baseUrl), l = {
      model: this.settings.model,
      input: e
    };
    this.settings.dimensions && Number.isFinite(this.settings.dimensions) && (l.dimensions = this.settings.dimensions);
    const v = Date.now();
    try {
      L("INFO", "EmbeddingClient.embed.request", "Embedding request", {
        url: i,
        timeoutMs: o,
        body: ne(l),
        inputCount: e.length
      });
      const I = await An(i, {
        method: "POST",
        headers: {
          ...this.settings.apiKey.trim() ? { Authorization: `Bearer ${this.settings.apiKey}` } : {},
          "Content-Type": "application/json"
        },
        body: JSON.stringify(l),
        signal: n.signal
      }), g = await I.text();
      let p = null;
      try {
        p = JSON.parse(g);
      } catch {
        p = null;
      }
      if (!I.ok)
        throw new Error(((m = p == null ? void 0 : p.error) == null ? void 0 : m.message) || `Embedding API rejected: ${I.status} ${g.slice(0, 240)}`);
      const f = (Array.isArray(p == null ? void 0 : p.data) ? p.data : []).sort((c, d) => Number((c == null ? void 0 : c.index) || 0) - Number((d == null ? void 0 : d.index) || 0)).map((c) => bn(c == null ? void 0 : c.embedding)).filter((c) => c.length > 0), h = ((C = f[0]) == null ? void 0 : C.length) || this.settings.dimensions || 0;
      if (f.length !== e.length)
        throw new Error(`Embedding API returned ${f.length} vectors for ${e.length} inputs.`);
      return L("INFO", "EmbeddingClient.embed.response", "Embedding response ok", {
        url: i,
        elapsedMs: Date.now() - v,
        inputCount: e.length,
        dimensions: h,
        model: (p == null ? void 0 : p.model) || this.settings.model
      }), {
        embeddings: f,
        model: (p == null ? void 0 : p.model) || this.settings.model,
        dimensions: h,
        provider: "openai-compatible"
      };
    } catch (I) {
      throw ce("EmbeddingClient.embed.error", I, {
        url: i,
        elapsedMs: Date.now() - v,
        didTimeout: a,
        requestBody: ne(l)
      }), a ? new Error(`Embedding API timeout after ${o}ms`) : I;
    } finally {
      clearTimeout(s);
    }
  }
}
const Me = 384, Ht = 900, kn = 120, Dn = 0.08;
function Vt(r) {
  return Ze("sha256").update(r).digest("hex");
}
function Sr(r) {
  if (!(r != null && r.trim()))
    return "";
  try {
    const t = JSON.parse(r), e = [], n = (o) => {
      !o || typeof o != "object" || (typeof o.text == "string" && e.push(o.text), Array.isArray(o.children) && o.children.forEach(n));
    };
    return n((t == null ? void 0 : t.root) || t), e.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return r.replace(/\s+/g, " ").trim();
  }
}
function le(r) {
  if (typeof r != "string" || !r.trim())
    return [];
  try {
    const t = JSON.parse(r);
    return Array.isArray(t) ? t.map((e) => String(e || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function We(r) {
  if (typeof r != "string" || !r.trim() || r.trim() === "{}")
    return "";
  try {
    const t = JSON.parse(r);
    return !t || typeof t != "object" ? "" : Object.entries(t).map(([e, n]) => `${e}: ${String(n || "")}`).filter((e) => !e.endsWith(": ")).join("; ");
  } catch {
    return r;
  }
}
function Nn(r) {
  const t = r.toLowerCase(), e = Array.from(t.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)).map((a) => a[0]), n = Array.from(t.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)).map((a) => a[0]), o = [];
  for (const a of n) {
    if (a.length === 1) {
      o.push(a);
      continue;
    }
    for (let s = 0; s < a.length - 1; s += 1)
      o.push(a.slice(s, s + 2));
    a.length <= 4 && o.push(a);
  }
  return [...e, ...o].filter(Boolean);
}
function xn(r) {
  const t = Ze("sha1").update(r).digest();
  return {
    index: t.readUInt32BE(0) % Me,
    sign: (t[4] & 1) === 1 ? 1 : -1
  };
}
function Ge(r) {
  const t = new Array(Me).fill(0), e = /* @__PURE__ */ new Map();
  for (const o of Nn(r))
    e.set(o, (e.get(o) || 0) + 1);
  for (const [o, a] of e) {
    const { index: s, sign: i } = xn(o);
    t[s] += i * Math.log1p(a);
  }
  const n = Math.sqrt(t.reduce((o, a) => o + a * a, 0));
  return n <= 0 ? t : t.map((o) => Number((o / n).toFixed(6)));
}
function Pn(r) {
  const t = Buffer.alloc(r.length * 4);
  for (let e = 0; e < r.length; e += 1)
    t.writeFloatLE(Number.isFinite(r[e]) ? r[e] : 0, e * 4);
  return t;
}
function Ln(r, t) {
  if (!r)
    return [];
  const e = Buffer.isBuffer(r) ? r : Buffer.from(r), n = Math.floor(e.length / 4), o = t && t > 0 ? Math.min(t, n) : n, a = [];
  for (let s = 0; s < o; s += 1)
    a.push(e.readFloatLE(s * 4));
  return a;
}
function On(r, t) {
  const e = Math.min(r.length, t.length);
  let n = 0;
  for (let o = 0; o < e; o += 1)
    n += r[o] * t[o];
  return n;
}
function Mn(r) {
  const t = r.replace(/\s+/g, " ").trim();
  if (!t)
    return [];
  if (t.length <= Ht)
    return [t];
  const e = [];
  let n = 0;
  for (; n < t.length; ) {
    const o = Math.min(t.length, n + Ht);
    if (e.push(t.slice(n, o)), o >= t.length)
      break;
    n = Math.max(0, o - kn);
  }
  return e;
}
async function Ke() {
  await u.$executeRawUnsafe(`
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
  const r = await u.$queryRawUnsafe("PRAGMA table_info(rag_vector_chunks);"), t = new Set(r.map((n) => n.name)), e = [
    ["embedding_blob", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_blob BLOB;"],
    ["embedding_dim", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_dim INTEGER;"],
    ["embedding_provider", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_provider TEXT NOT NULL DEFAULT 'hash';"],
    ["embedding_model", "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'local-hash-v1';"]
  ];
  for (const [n, o] of e)
    t.has(n) || await u.$executeRawUnsafe(o);
  await u.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_novel ON rag_vector_chunks(novel_id);"), await u.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_source ON rag_vector_chunks(source_type, source_id);");
}
async function wt(r) {
  var e;
  await Ke();
  const t = await u.$queryRaw`
        SELECT COUNT(*) as count FROM rag_vector_chunks WHERE novel_id = ${r};
    `;
  return Number(((e = t[0]) == null ? void 0 : e.count) || 0);
}
async function $n(r) {
  var v;
  const [t, e, n, o, a, s, i] = await Promise.all([
    u.character.findMany({
      where: { novelId: r },
      include: { items: { include: { item: !0 } } },
      orderBy: { sortOrder: "asc" }
    }),
    u.item.findMany({ where: { novelId: r }, orderBy: { sortOrder: "asc" } }),
    u.worldSetting.findMany({ where: { novelId: r }, orderBy: { sortOrder: "asc" } }),
    u.plotLine.findMany({
      where: { novelId: r },
      include: { points: { orderBy: { order: "asc" } } },
      orderBy: { sortOrder: "asc" }
    }),
    u.chapter.findMany({
      where: { volume: { novelId: r } },
      select: { id: !0, title: !0, content: !0, order: !0, volume: { select: { title: !0, order: !0 } } },
      orderBy: [{ volume: { order: "asc" } }, { order: "asc" }]
    }),
    u.chapterSummary.findMany({
      where: { novelId: r, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" }
    }),
    u.narrativeSummary.findMany({
      where: { novelId: r, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" }
    })
  ]), l = [];
  for (const m of t) {
    const C = We(m.profile), I = Array.isArray(m.items) ? m.items.map((g) => {
      var p;
      return `${((p = g.item) == null ? void 0 : p.name) || ""}${g.note ? ` ${g.note}` : ""}`;
    }).filter(Boolean).join("; ") : "";
    l.push({
      novelId: r,
      sourceType: "character",
      sourceId: m.id,
      title: `Character: ${m.name}`,
      content: [
        m.name,
        m.role,
        m.description,
        C,
        I ? `Owned items: ${I}` : "",
        m.isStarred ? "starred important" : ""
      ].filter(Boolean).join(`
`)
    });
  }
  for (const m of e)
    l.push({
      novelId: r,
      sourceType: "item",
      sourceId: m.id,
      title: `${m.type || "Item"}: ${m.name}`,
      content: [m.name, m.type, m.description, We(m.profile)].filter(Boolean).join(`
`)
    });
  for (const m of n)
    l.push({
      novelId: r,
      sourceType: "worldSetting",
      sourceId: m.id,
      title: `World: ${m.name}`,
      content: [m.name, m.type, m.content].filter(Boolean).join(`
`)
    });
  for (const m of o) {
    l.push({
      novelId: r,
      sourceType: "plotLine",
      sourceId: m.id,
      title: `Plot line: ${m.name}`,
      content: [m.name, m.description].filter(Boolean).join(`
`)
    });
    for (const C of m.points || [])
      l.push({
        novelId: r,
        sourceType: "plotPoint",
        sourceId: C.id,
        title: `Plot point: ${C.title}`,
        content: [m.name, C.title, C.type, C.status, C.description].filter(Boolean).join(`
`)
      });
  }
  for (const m of a) {
    const C = Sr(m.content || "");
    C && l.push({
      novelId: r,
      sourceType: "chapter",
      sourceId: m.id,
      title: `${((v = m.volume) == null ? void 0 : v.title) || ""} ${m.title || ""}`.trim() || "Chapter",
      content: C
    });
  }
  for (const m of s)
    l.push({
      novelId: r,
      sourceType: "chapterSummary",
      sourceId: m.id,
      title: `Chapter summary: ${m.chapterId}`,
      content: [
        m.compressedMemory || m.summaryText,
        ...le(m.keyFacts),
        ...le(m.timelineHints),
        ...le(m.openQuestions)
      ].filter(Boolean).join(`
`)
    });
  for (const m of i)
    l.push({
      novelId: r,
      sourceType: "narrativeSummary",
      sourceId: m.id,
      title: `${m.level || "novel"} summary: ${m.title || "latest"}`,
      content: [
        m.summaryText,
        ...le(m.keyFacts),
        ...le(m.unresolvedThreads),
        ...le(m.hardConstraints)
      ].filter(Boolean).join(`
`)
    });
  return l;
}
async function Rn(r) {
  const t = await u.chapter.findUnique({
    where: { id: r },
    select: {
      id: !0,
      title: !0,
      content: !0,
      volume: { select: { novelId: !0, title: !0 } }
    }
  });
  if (!(t != null && t.volume))
    return null;
  const e = Sr(t.content || "");
  return e ? {
    novelId: t.volume.novelId,
    sourceType: "chapter",
    sourceId: t.id,
    title: `${t.volume.title || ""} ${t.title || ""}`.trim() || "Chapter",
    content: e
  } : {
    novelId: t.volume.novelId,
    sourceType: "chapter",
    sourceId: t.id,
    title: `${t.volume.title || ""} ${t.title || ""}`.trim() || "Chapter",
    content: ""
  };
}
async function Cr(r, t) {
  var e;
  switch (r) {
    case "chapter":
      return Rn(t);
    case "character": {
      const n = await u.character.findUnique({
        where: { id: t },
        include: { items: { include: { item: !0 } } }
      });
      if (!n)
        return null;
      const o = We(n.profile), a = Array.isArray(n.items) ? n.items.map((s) => {
        var i;
        return `${((i = s.item) == null ? void 0 : i.name) || ""}${s.note ? ` ${s.note}` : ""}`;
      }).filter(Boolean).join("; ") : "";
      return {
        novelId: n.novelId,
        sourceType: "character",
        sourceId: n.id,
        title: `Character: ${n.name}`,
        content: [
          n.name,
          n.role,
          n.description,
          o,
          a ? `Owned items: ${a}` : "",
          n.isStarred ? "starred important" : ""
        ].filter(Boolean).join(`
`)
      };
    }
    case "item": {
      const n = await u.item.findUnique({ where: { id: t } });
      return n ? {
        novelId: n.novelId,
        sourceType: "item",
        sourceId: n.id,
        title: `${n.type || "Item"}: ${n.name}`,
        content: [n.name, n.type, n.description, We(n.profile)].filter(Boolean).join(`
`)
      } : null;
    }
    case "worldSetting": {
      const n = await u.worldSetting.findUnique({ where: { id: t } });
      return n ? {
        novelId: n.novelId,
        sourceType: "worldSetting",
        sourceId: n.id,
        title: `World: ${n.name}`,
        content: [n.name, n.type, n.content].filter(Boolean).join(`
`)
      } : null;
    }
    case "plotLine": {
      const n = await u.plotLine.findUnique({ where: { id: t } });
      return n ? {
        novelId: n.novelId,
        sourceType: "plotLine",
        sourceId: n.id,
        title: `Plot line: ${n.name}`,
        content: [n.name, n.description].filter(Boolean).join(`
`)
      } : null;
    }
    case "plotPoint": {
      const n = await u.plotPoint.findUnique({
        where: { id: t },
        include: { plotLine: { select: { name: !0 } } }
      });
      return n ? {
        novelId: n.novelId,
        sourceType: "plotPoint",
        sourceId: n.id,
        title: `Plot point: ${n.title}`,
        content: [(e = n.plotLine) == null ? void 0 : e.name, n.title, n.type, n.status, n.description].filter(Boolean).join(`
`)
      } : null;
    }
    case "chapterSummary": {
      const n = await u.chapterSummary.findUnique({ where: { id: t } });
      return !n || n.status !== "active" ? null : {
        novelId: n.novelId,
        sourceType: "chapterSummary",
        sourceId: n.id,
        title: `Chapter summary: ${n.chapterId}`,
        content: [
          n.compressedMemory || n.summaryText,
          ...le(n.keyFacts),
          ...le(n.timelineHints),
          ...le(n.openQuestions)
        ].filter(Boolean).join(`
`)
      };
    }
    case "narrativeSummary": {
      const n = await u.narrativeSummary.findUnique({ where: { id: t } });
      return !n || n.status !== "active" ? null : {
        novelId: n.novelId,
        sourceType: "narrativeSummary",
        sourceId: n.id,
        title: `${n.level || "novel"} summary: ${n.title || "latest"}`,
        content: [
          n.summaryText,
          ...le(n.keyFacts),
          ...le(n.unresolvedThreads),
          ...le(n.hardConstraints)
        ].filter(Boolean).join(`
`)
      };
    }
    default:
      return null;
  }
}
async function Un(r) {
  const t = r.settings;
  if (t != null && t.enabled && t.baseUrl.trim())
    try {
      const n = new Ir(t), o = Math.max(1, Math.min(64, t.batchSize || 8)), a = [];
      let s = t.model, i = t.dimensions || 0;
      for (let l = 0; l < r.texts.length; l += o) {
        const v = r.texts.slice(l, l + o), m = await n.embed(v);
        a.push(...m.embeddings), s = m.model, i = m.dimensions;
      }
      return { vectors: a, provider: "openai-compatible", model: s, dimensions: i, fallbackUsed: !1 };
    } catch (n) {
      if (!t.fallbackToHash)
        throw n;
      console.warn("[RAG] Embedding API failed; falling back to local hash vectors:", n);
      const o = n instanceof Error ? n.message : String(n);
      return { vectors: r.texts.map((s) => Ge(s)), provider: "hash", model: "local-hash-v1", dimensions: Me, fallbackUsed: !0, fallbackError: o };
    }
  return { vectors: r.texts.map((n) => Ge(n)), provider: "hash", model: "local-hash-v1", dimensions: Me, fallbackUsed: !!(t != null && t.enabled) };
}
async function Er(r, t) {
  const e = [];
  for (const a of r) {
    const s = Mn(a.content);
    for (let i = 0; i < s.length; i += 1)
      e.push({ doc: a, index: i, content: s[i] });
  }
  const n = await Un({
    texts: e.map((a) => `${a.doc.title}
${a.content}`),
    settings: t
  }), o = (/* @__PURE__ */ new Date()).toISOString();
  for (let a = 0; a < e.length; a += 1) {
    const s = e[a], i = n.vectors[a] || Ge(`${s.doc.title}
${s.content}`), l = Vt(`${s.doc.sourceType}:${s.doc.sourceId}:${s.index}:${s.content}`), v = Vt(`${s.doc.novelId}:${s.doc.sourceType}:${s.doc.sourceId}:${s.index}`), m = n.provider === "hash" ? JSON.stringify(i) : "[]", C = Pn(i), I = i.length;
    await u.$executeRaw`
            INSERT INTO rag_vector_chunks (id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim, embedding_provider, embedding_model, content_hash, updated_at)
            VALUES (${v}, ${s.doc.novelId}, ${s.doc.sourceType}, ${s.doc.sourceId}, ${s.doc.title}, ${s.content}, ${m}, ${C}, ${I}, ${n.provider}, ${n.model}, ${l}, ${o});
        `;
  }
  return { chunks: e.length, sources: r.length, provider: n.provider, model: n.model, dimensions: n.dimensions, fallbackUsed: n.fallbackUsed, fallbackError: n.fallbackError };
}
async function _r(r, t) {
  await Ke();
  const e = await $n(r);
  return await u.$executeRaw`DELETE FROM rag_vector_chunks WHERE novel_id = ${r};`, Er(e, t);
}
async function It(r) {
  if (await Ke(), r.novelId) {
    const e = await u.$executeRaw`
            DELETE FROM rag_vector_chunks
            WHERE novel_id = ${r.novelId}
              AND source_type = ${r.sourceType}
              AND source_id = ${r.sourceId};
        `;
    return { deleted: Number(e || 0) };
  }
  const t = await u.$executeRaw`
        DELETE FROM rag_vector_chunks
        WHERE source_type = ${r.sourceType}
          AND source_id = ${r.sourceId};
    `;
  return { deleted: Number(t || 0) };
}
async function Fn(r, t) {
  return await Ke(), await It({
    novelId: r.novelId,
    sourceType: r.sourceType,
    sourceId: r.sourceId
  }), r.content.trim() ? Er([r], t) : {
    chunks: 0,
    sources: 1,
    provider: "none",
    model: "empty-source",
    dimensions: 0,
    fallbackUsed: !1
  };
}
async function Ar(r, t, e) {
  const n = await Cr(r, t);
  return n ? { ...await Fn(n, e), novelId: n.novelId, sourceType: n.sourceType, sourceId: n.sourceId } : {
    chunks: 0,
    sources: 0,
    provider: "none",
    model: "missing-source",
    dimensions: 0,
    fallbackUsed: !1,
    sourceType: r,
    sourceId: t
  };
}
async function Bn(r, t) {
  const e = await Ar("chapter", r, t);
  return { ...e, sourceId: e.sourceId };
}
async function jn(r, t) {
  const e = await wt(r);
  if (e > 0)
    return { rebuilt: !1, chunks: e };
  const n = await _r(r, t);
  return { rebuilt: !0, chunks: n.chunks, sources: n.sources };
}
async function qn(r) {
  var a, s;
  await jn(r.novelId, r.settings);
  const t = await u.$queryRaw`
        SELECT id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim
        FROM rag_vector_chunks
        WHERE novel_id = ${r.novelId};
    `;
  let e = Ge(r.query);
  const n = ((a = t.find((i) => Number(i.embedding_dim || 0) > 0)) == null ? void 0 : a.embedding_dim) || 0, o = t.some((i) => i.embedding_blob);
  if ((s = r.settings) != null && s.enabled && r.settings.baseUrl.trim() && o && n !== Me)
    try {
      e = (await new Ir(r.settings).embed([r.query])).embeddings[0] || e;
    } catch (i) {
      if (!r.settings.fallbackToHash)
        throw i;
      console.warn("[RAG] Query embedding API failed; falling back to local hash vector:", i);
    }
  return t.map((i) => {
    let l = Ln(i.embedding_blob, i.embedding_dim);
    if (l.length === 0 && i.embedding_json)
      try {
        const m = JSON.parse(i.embedding_json);
        l = Array.isArray(m) ? m.map((C) => Number(C) || 0) : [];
      } catch {
        l = [];
      }
    const v = On(e, l);
    return {
      id: i.id,
      sourceType: i.source_type,
      sourceId: i.source_id,
      title: i.title,
      excerpt: i.content,
      metadata: { vectorSimilarity: Number(v.toFixed(4)), retrieval: "local_vector_hash" },
      score: Math.round(v * 100)
    };
  }).filter((i) => {
    var l;
    return Number(((l = i.metadata) == null ? void 0 : l.vectorSimilarity) || 0) >= Dn;
  }).sort((i, l) => (l.score || 0) - (i.score || 0)).slice(0, Math.max(1, Math.min(16, r.limit ?? 8)));
}
function zn(r, t) {
  const e = typeof r == "string" ? r.replace(/\s+/g, " ").trim() : "";
  return e ? e.length > t ? `${e.slice(0, t)}...` : e : "";
}
function Ee(r) {
  if (typeof r != "string" || !r.trim())
    return [];
  try {
    const t = JSON.parse(r);
    return Array.isArray(t) ? t.map((e) => String(e || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function Wt(r) {
  if (typeof r != "string" || !r.trim() || r.trim() === "{}")
    return "";
  try {
    const t = JSON.parse(r);
    return !t || typeof t != "object" ? "" : Object.entries(t).map(([e, n]) => `${e}: ${String(n || "")}`).filter((e) => !e.endsWith(": ")).join("; ");
  } catch {
    return r;
  }
}
function ie(r, t) {
  const e = String(r || "").toLowerCase();
  return t.some((n) => e.includes(n.toLowerCase()));
}
function ge(r, t, e) {
  return t === "future_plot_for_entity" && e === "plotPoint" ? r + 40 : t === "outline_next" && (e === "plotPoint" || e === "plotLine") ? r + 35 : t === "character_state" && (e === "character" || e === "relationship" || e === "item" || e === "map") ? r + 30 : t === "unresolved_threads" && (e === "narrativeSummary" || e === "chapterSummary" || e === "plotPoint") ? r + 25 : r;
}
function se(r, t) {
  const e = `E${r.length + 1}`, n = zn(t.excerpt, 900);
  n && r.push({ id: e, ...t, excerpt: n });
}
async function Hn(r) {
  const [t, e, n] = await Promise.all([
    u.character.findMany({ where: { novelId: r }, select: { name: !0 } }),
    u.item.findMany({ where: { novelId: r }, select: { name: !0 } }),
    u.worldSetting.findMany({ where: { novelId: r }, select: { name: !0 } })
  ]), o = [...t, ...e, ...n].map((a) => String((a == null ? void 0 : a.name) || "").trim()).filter(Boolean);
  return Array.from(new Set(o));
}
async function Vn(r) {
  var S, _, A, x, P, R, Q, te;
  const t = Math.max(4, Math.min(24, r.maxEvidenceItems ?? 12)), e = r.detection.entityNames, n = r.detection.keywords, o = r.detection.intent, a = [], s = [], i = /* @__PURE__ */ new Set(), l = (r.locale || "zh").startsWith("zh"), [v, m, C, I, g, p, y] = await Promise.all([
    u.character.findMany({
      where: { novelId: r.novelId },
      include: {
        items: { include: { item: !0 } },
        relationsAsSource: { include: { target: !0 } },
        relationsAsTarget: { include: { source: !0 } },
        mapMarkers: { include: { map: !0 } }
      },
      orderBy: [{ isStarred: "desc" }, { sortOrder: "asc" }],
      take: 100
    }),
    u.item.findMany({
      where: { novelId: r.novelId },
      include: { owners: { include: { character: !0 } } },
      orderBy: { sortOrder: "asc" },
      take: 120
    }),
    u.worldSetting.findMany({
      where: { novelId: r.novelId },
      orderBy: { sortOrder: "asc" },
      take: 80
    }),
    u.plotLine.findMany({
      where: { novelId: r.novelId },
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
    u.narrativeSummary.findMany({
      where: { novelId: r.novelId, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: 3
    }),
    u.chapterSummary.findMany({
      where: { novelId: r.novelId, isLatest: !0, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: 12
    }),
    r.chapterId ? u.chapter.findUnique({
      where: { id: r.chapterId },
      select: { id: !0, title: !0, order: !0, volume: { select: { title: !0, order: !0 } } }
    }) : null
  ]);
  (S = r.selectedText) != null && S.trim() && (se(a, {
    sourceType: "currentContext",
    sourceId: r.chapterId || "selectedText",
    title: "Selected text",
    excerpt: r.selectedText,
    score: 95
  }), i.add("selected_text")), (_ = r.currentContent) != null && _.trim() && (se(a, {
    sourceType: "currentContext",
    sourceId: r.chapterId || "currentContent",
    title: y != null && y.title ? `Current chapter: ${y.title}` : "Current chapter context",
    excerpt: r.currentContent.slice(-1600),
    metadata: y ? { chapterOrder: y.order, volumeTitle: (A = y.volume) == null ? void 0 : A.title } : void 0,
    score: 55
  }), i.add("current_chapter_context")), (x = r.currentLocation) != null && x.trim() && (se(a, {
    sourceType: "currentContext",
    sourceId: "currentLocation",
    title: "Current location",
    excerpt: r.currentLocation,
    score: 50
  }), i.add("current_location"));
  const f = await qn({
    novelId: r.novelId,
    query: r.question,
    limit: Math.min(8, t),
    settings: r.embeddingSettings
  });
  for (const E of f)
    se(a, {
      ...E,
      score: 90 + Math.max(0, E.score || 0)
    });
  f.length > 0 && i.add("vector_chunks");
  const h = v.filter((E) => e.length === 0 ? n.some((M) => ie(`${E.name} ${E.role} ${E.description} ${E.profile}`, [M])) : ie(E.name, e));
  for (const E of h.slice(0, 8)) {
    const M = Wt(E.profile), D = Array.isArray(E.items) ? E.items.map((U) => {
      var z;
      return `${((z = U.item) == null ? void 0 : z.name) || ""}${U.note ? `(${U.note})` : ""}`;
    }).filter(Boolean).join(", ") : "";
    se(a, {
      sourceType: "character",
      sourceId: E.id,
      title: `Character: ${E.name}`,
      excerpt: [
        E.role ? `Role: ${E.role}` : "",
        E.description ? `Description: ${E.description}` : "",
        M ? `Profile: ${M}` : "",
        D ? `Owned items: ${D}` : ""
      ].filter(Boolean).join(`
`),
      metadata: { name: E.name, isStarred: E.isStarred },
      score: ge(100 + (E.isStarred ? 10 : 0), o, "character")
    }), i.add("characters");
    for (const U of [...E.relationsAsSource || [], ...E.relationsAsTarget || []].slice(0, 8)) {
      const z = ((P = U.target) == null ? void 0 : P.name) || ((R = U.source) == null ? void 0 : R.name) || "";
      se(a, {
        sourceType: "relationship",
        sourceId: U.id,
        title: `Relationship: ${E.name} - ${z}`,
        excerpt: `${U.relation || ""}${U.description ? `: ${U.description}` : ""}`,
        metadata: { characterName: E.name, relatedName: z },
        score: ge(80, o, "relationship")
      });
    }
    for (const U of (E.mapMarkers || []).slice(0, 6))
      se(a, {
        sourceType: "map",
        sourceId: U.id,
        title: `Map: ${((Q = U.map) == null ? void 0 : Q.name) || U.mapId}`,
        excerpt: `${E.name} marker${U.label ? `: ${U.label}` : ""}`,
        metadata: { characterName: E.name, mapId: U.mapId, mapType: (te = U.map) == null ? void 0 : te.type },
        score: ge(70, o, "map")
      });
  }
  for (const E of m) {
    const M = `${E.name} ${E.type} ${E.description} ${E.profile}`;
    if (e.length > 0 && !ie(M, e) || e.length === 0 && !n.some((z) => ie(M, [z])))
      continue;
    const D = Wt(E.profile), U = Array.isArray(E.owners) ? E.owners.map((z) => {
      var ue;
      return `${((ue = z.character) == null ? void 0 : ue.name) || ""}${z.note ? `(${z.note})` : ""}`;
    }).filter(Boolean).join(", ") : "";
    se(a, {
      sourceType: "item",
      sourceId: E.id,
      title: `${E.type || "Item"}: ${E.name}`,
      excerpt: [
        E.description ? `Description: ${E.description}` : "",
        D ? `Profile: ${D}` : "",
        U ? `Owners: ${U}` : ""
      ].filter(Boolean).join(`
`),
      score: ge(78, o, "item")
    }), i.add("items");
  }
  for (const E of C) {
    const M = `${E.name} ${E.content} ${E.type}`;
    e.length > 0 && !ie(M, e) || e.length === 0 && !n.some((D) => ie(M, [D])) || (se(a, {
      sourceType: "worldSetting",
      sourceId: E.id,
      title: `World: ${E.name}`,
      excerpt: E.content,
      metadata: { type: E.type },
      score: 65
    }), i.add("world_settings"));
  }
  for (const E of I) {
    const M = e.length === 0 ? n.some((D) => ie(`${E.name} ${E.description}`, [D])) : ie(`${E.name} ${E.description}`, e);
    (M || o === "outline_next" || o === "unresolved_threads") && (se(a, {
      sourceType: "plotLine",
      sourceId: E.id,
      title: `Plot line: ${E.name}`,
      excerpt: E.description || E.name,
      score: ge(M ? 85 : 45, o, "plotLine")
    }), i.add("plot_outline"));
    for (const D of E.points || []) {
      const U = `${E.name} ${E.description || ""} ${D.title} ${D.description || ""}`, z = e.length === 0 ? n.some((xe) => ie(U, [xe])) : ie(U, e), ue = o === "outline_next" && D.status !== "resolved", Ne = o === "unresolved_threads" && D.status !== "resolved";
      if (!z && !ue && !Ne)
        continue;
      const Dt = Array.isArray(D.anchors) ? D.anchors.map((xe) => {
        var Nt;
        const Se = xe.chapter;
        return `${xe.type}: ${((Nt = Se == null ? void 0 : Se.volume) == null ? void 0 : Nt.title) || ""} ${(Se == null ? void 0 : Se.title) || xe.chapterId}`.trim();
      }).join("; ") : "";
      se(a, {
        sourceType: "plotPoint",
        sourceId: D.id,
        title: `Plot point: ${D.title}`,
        excerpt: [
          `Line: ${E.name}`,
          `Status: ${D.status || "active"}`,
          D.description ? `Description: ${D.description}` : "",
          Dt ? `Anchors: ${Dt}` : ""
        ].filter(Boolean).join(`
`),
        metadata: { plotLineId: E.id, status: D.status, type: D.type },
        score: ge((z ? 105 : 70) + (D.status === "resolved" ? -20 : 20), o, "plotPoint")
      }), i.add("plot_points");
    }
  }
  for (const E of g) {
    const M = Ee(E.unresolvedThreads), D = Ee(E.keyFacts), U = Ee(E.hardConstraints), z = [
      E.summaryText,
      D.length ? `Key facts: ${D.join("; ")}` : "",
      M.length ? `Unresolved threads: ${M.join("; ")}` : "",
      U.length ? `Hard constraints: ${U.join("; ")}` : ""
    ].filter(Boolean).join(`
`), ue = e.length === 0 ? n.some((Ne) => ie(z, [Ne])) : ie(z, e);
    !ue && !["outline_next", "unresolved_threads", "general_qa"].includes(o) || (se(a, {
      sourceType: "narrativeSummary",
      sourceId: E.id,
      title: `${E.level || "novel"} summary: ${E.title || "latest"}`,
      excerpt: z,
      score: ge(ue ? 90 : 55, o, "narrativeSummary")
    }), i.add("narrative_summaries"));
  }
  for (const E of p) {
    const M = Ee(E.openQuestions), D = Ee(E.timelineHints), U = Ee(E.keyFacts), z = [
      E.compressedMemory || E.summaryText,
      U.length ? `Key facts: ${U.join("; ")}` : "",
      D.length ? `Timeline hints: ${D.join("; ")}` : "",
      M.length ? `Open questions: ${M.join("; ")}` : ""
    ].filter(Boolean).join(`
`), ue = e.length === 0 ? n.some((Ne) => ie(z, [Ne])) : ie(z, e);
    !ue && o !== "unresolved_threads" || (se(a, {
      sourceType: "chapterSummary",
      sourceId: E.id,
      title: `Chapter summary: ${E.chapterId}`,
      excerpt: z,
      metadata: { chapterId: E.chapterId, chapterOrder: E.chapterOrder },
      score: ge(ue ? 85 : 60, o, "chapterSummary")
    }), i.add("chapter_summaries"));
  }
  const c = Array.from(/* @__PURE__ */ new Set([...e, ...n])).slice(0, 6);
  for (const E of c) {
    const M = await At(r.novelId, E, 5, 0);
    for (const D of M.slice(0, 4))
      se(a, {
        sourceType: D.entityType === "idea" ? "idea" : "searchHit",
        sourceId: D.entityId,
        title: D.title || E,
        excerpt: D.preview || D.snippet,
        metadata: {
          keyword: E,
          chapterId: D.chapterId,
          volumeTitle: D.volumeTitle,
          matchType: D.matchType
        },
        score: D.matchType === "title" ? 62 : 42
      }), i.add("search_hits");
  }
  const d = /* @__PURE__ */ new Map();
  for (const E of a) {
    const M = `${E.sourceType}:${E.sourceId}:${E.title}`, D = d.get(M);
    (!D || (E.score || 0) > (D.score || 0)) && d.set(M, E);
  }
  const w = Array.from(d.values()).sort((E, M) => (M.score || 0) - (E.score || 0)).slice(0, t).map((E, M) => ({ ...E, id: `E${M + 1}` }));
  return w.length === 0 && s.push(l ? "未找到相关证据，本次回答应视为低置信度。" : "No relevant evidence found. The answer should be treated as low confidence."), {
    evidence: w,
    warnings: s,
    usedContext: Array.from(i)
  };
}
function Gt(r, t) {
  const e = [];
  return r != null && r.trim() && e.push(`[System Prompt]
${r.trim()}`), e.push(`[User Prompt]
${t.trim()}`), e.join(`

`);
}
function Wn(r, t) {
  const e = r.toLowerCase();
  return /不足以判断|资料不足|无法判断|insufficient|not enough/.test(e) ? "low" : /confidence\s*[:：]\s*high|置信度\s*[:：]\s*高/.test(e) ? "high" : /confidence\s*[:：]\s*low|置信度\s*[:：]\s*低/.test(e) ? "low" : t >= 5 ? "high" : t >= 2 ? "medium" : "low";
}
function Gn(r, t) {
  const e = /* @__PURE__ */ new Set();
  for (const n of r.matchAll(/\[?(E\d+)\]?/g)) {
    const o = n[1];
    t.includes(o) && e.add(o);
  }
  return Array.from(e).map((n) => ({ evidenceId: n, label: `[${n}]` }));
}
class Jn {
  async buildPromptBundle(t, e) {
    var I, g, p, y;
    const n = String(t.question || "").trim();
    if (!((I = t.novelId) != null && I.trim()))
      throw new Error("novelId is required");
    if (!n)
      throw new Error("question is required");
    const o = await Hn(t.novelId), a = _n(n, o), s = await Vn({
      novelId: t.novelId,
      chapterId: t.chapterId,
      currentContent: t.currentContent,
      selectedText: t.selectedText,
      currentLocation: t.currentLocation,
      detection: a,
      question: n,
      maxEvidenceItems: t.maxEvidenceItems,
      locale: t.locale,
      embeddingSettings: e
    }), i = s.evidence.map((f) => `[${f.id}] ${f.sourceType} | ${f.title}
${f.excerpt}`).join(`

`), l = (t.locale || "zh").startsWith("zh"), v = l ? "你是小说编辑器中的 RAG 问答助手。你只能基于 Evidence 中提供的资料回答。如果资料不足，请明确说明不足以判断。请区分“已写事实”“大纲计划”“写作建议”。涉及剧情判断时必须引用证据标签，例如 [E1]。不要编造未提供的设定、章节或人物状态。" : "You are a RAG Q&A assistant inside a novel editor. Answer only from the provided Evidence. If evidence is insufficient, say so clearly. Separate written facts, outline plans, and writing suggestions. Cite evidence labels such as [E1]. Do not invent missing lore, chapters, or character state.", m = [
      `Question=${n}`,
      `Intent=${a.intent}`,
      a.entityNames.length ? `DetectedEntities=${a.entityNames.join(", ")}` : "DetectedEntities=none",
      a.keywords.length ? `Keywords=${a.keywords.join(", ")}` : "Keywords=none",
      (g = t.selectedText) != null && g.trim() ? "SelectedTextProvided=true" : "SelectedTextProvided=false",
      (p = t.currentLocation) != null && p.trim() ? `CurrentLocation=${t.currentLocation.trim()}` : "",
      "Evidence=",
      i || "(no relevant evidence found)",
      l ? "Output=用简洁中文回答。若能回答，请按“已写事实 / 大纲计划 / 写作建议 / 置信度”组织；没有对应内容可省略该小节。必须引用证据标签。" : "Output=Answer concisely. Organize as Written facts / Outline plans / Writing suggestions / Confidence when applicable. Omit empty sections. Cite evidence labels."
    ].filter(Boolean).join(`

`), C = (y = t.overrideUserPrompt) != null && y.trim() ? t.overrideUserPrompt.trim() : m;
    return {
      systemPrompt: v,
      defaultUserPrompt: m,
      effectiveUserPrompt: C,
      intent: a.intent,
      evidence: s.evidence,
      citations: s.evidence.map((f) => ({ evidenceId: f.id, label: `[${f.id}]` })),
      warnings: s.warnings,
      usedContext: s.usedContext
    };
  }
  async preview(t, e) {
    const n = await this.buildPromptBundle(t, e);
    return {
      ok: !0,
      question: t.question,
      intent: n.intent,
      answer: "",
      confidence: n.evidence.length > 0 ? "medium" : "low",
      evidence: n.evidence,
      citations: n.citations,
      warnings: n.warnings,
      usedContext: n.usedContext,
      rawPrompt: Gt(n.systemPrompt, n.effectiveUserPrompt),
      editableUserPrompt: n.defaultUserPrompt
    };
  }
  async ask(t, e, n) {
    const o = await this.buildPromptBundle(t, n.embeddingSettings), a = await e.generate({
      systemPrompt: o.systemPrompt,
      prompt: o.effectiveUserPrompt,
      maxTokens: n.maxTokens,
      temperature: n.temperature ?? 0.2
    }), s = o.evidence.map((l) => l.id), i = Gn(a.text, s);
    return {
      ok: !0,
      question: t.question,
      intent: o.intent,
      answer: a.text,
      confidence: Wn(a.text, o.evidence.length),
      evidence: o.evidence,
      citations: i.length > 0 ? i : o.citations.slice(0, 3),
      warnings: o.warnings,
      usedContext: o.usedContext,
      rawPrompt: Gt(o.systemPrompt, o.effectiveUserPrompt),
      editableUserPrompt: o.defaultUserPrompt
    };
  }
}
const ut = 10 * 1024 * 1024, Zn = 2e3, Jt = /* @__PURE__ */ new Set(["foreshadowing", "mystery", "promise", "event"]), Zt = /* @__PURE__ */ new Set(["active", "resolved"]), Kn = /* @__PURE__ */ new Set(["item", "skill", "location"]), Xn = /* @__PURE__ */ new Set(["world", "region", "scene"]), qe = ["plotLines", "plotPoints", "characters", "items", "skills", "maps"], Yn = {
  plotLines: ["主线", "支线", "故事线", "剧情线", "plot line", "story line"],
  plotPoints: ["要点", "情节点", "剧情点", "事件", "桥段", "转折", "冲突", "plot point", "scene beat"],
  characters: ["角色", "龙套", "配角", "人物", "反派", "主角", "npc", "character"],
  items: ["物品", "道具", "装备", "宝物", "武器", "法宝", "artifact", "item"],
  skills: ["技能", "招式", "能力", "法术", "功法", "绝招", "spell", "skill"],
  maps: ["地图", "场景", "地点", "区域", "城市", "宗门地图", "world map", "map", "location"]
}, mt = [
  "novel.list",
  "volume.list",
  "chapter.list",
  "chapter.create",
  "chapter.save",
  "chapter.generate"
], Qn = [
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
], ye = {
  providerType: "http",
  http: {
    baseUrl: "",
    apiKey: "",
    model: "gpt-4.1-mini",
    imageModel: "doubao-seedream-5-0-260128",
    imageSize: "2K",
    imageOutputFormat: "png",
    imageWatermark: !1,
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
function pt(r) {
  return JSON.stringify(r ?? {});
}
function eo(r) {
  const t = (r || "").toLowerCase();
  return t.includes("jpeg") || t.includes("jpg") ? "jpg" : t.includes("webp") ? "webp" : t.includes("gif") ? "gif" : t.includes("bmp") ? "bmp" : "png";
}
function to(r) {
  return r.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function ro(r) {
  if (!(r != null && r.trim()))
    return "";
  try {
    const t = JSON.parse(r), e = [], n = (o) => {
      !o || typeof o != "object" || (typeof o.text == "string" && e.push(o.text), Array.isArray(o.children) && o.children.forEach(n));
    };
    return n((t == null ? void 0 : t.root) || t), e.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return r.replace(/\s+/g, " ").trim();
  }
}
function no(r) {
  switch (r) {
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
function Kt(r, t) {
  const e = [];
  return r != null && r.trim() && e.push(`[System Prompt]
${r.trim()}`), e.push(`[User Prompt]
${t.trim()}`), e.join(`

`);
}
function j(r, t) {
  const e = typeof r == "string" ? r.trim() : "";
  return e ? e.length > t ? e.slice(0, t) : e : "";
}
function oo(r, t) {
  const e = /* @__PURE__ */ new Set(), n = [];
  for (const o of r) {
    const a = String(o || "").trim();
    if (!a)
      continue;
    const s = a.toLowerCase();
    if (!e.has(s) && (e.add(s), n.push(a), n.length >= t))
      break;
  }
  return n;
}
class ao {
  constructor(t) {
    G(this, "userDataPath");
    G(this, "settingsFilePath");
    G(this, "mapImageStatsPath");
    G(this, "settingsCache");
    G(this, "mapImageStatsCache");
    G(this, "capabilityDefinitions");
    G(this, "capabilityRegistry");
    G(this, "contextBuilder");
    G(this, "novelRagService");
    this.userDataPath = t(), this.settingsFilePath = k.join(this.userDataPath, "ai-settings.json"), this.mapImageStatsPath = k.join(this.userDataPath, "ai-map-image-stats.json"), this.settingsCache = this.loadSettings(), this.mapImageStatsCache = this.loadMapImageStats(), this.contextBuilder = new wn(), this.novelRagService = new Jn(), this.capabilityDefinitions = gn({
      continueWriting: (e) => this.continueWriting(e),
      askNovel: (e) => this.askNovel(e),
      rebuildRagIndex: (e) => this.rebuildRagIndex(e)
    }), this.capabilityRegistry = new Map(
      this.capabilityDefinitions.map((e) => [e.actionId, e.handler])
    );
  }
  listActions() {
    return this.capabilityDefinitions.map((t) => ({
      actionId: t.actionId,
      title: t.title,
      description: t.description,
      permission: t.permission,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema
    }));
  }
  getCapabilityCoverage() {
    const t = new Set(this.capabilityDefinitions.map((s) => s.actionId)), e = Qn.map((s) => {
      const i = s.requiredActions.filter((m) => !t.has(m)), l = s.requiredActions.filter((m) => t.has(m)), v = s.requiredActions.length === 0 ? 0 : Math.round(l.length / s.requiredActions.length * 100);
      return {
        moduleId: s.moduleId,
        title: s.title,
        requiredActions: [...s.requiredActions],
        supportedActions: l,
        missingActions: i,
        coverage: v
      };
    }), n = e.reduce((s, i) => s + i.requiredActions.length, 0), o = e.reduce((s, i) => s + i.supportedActions.length, 0);
    return {
      overallCoverage: n === 0 ? 0 : Math.round(o / n * 100),
      totalRequired: n,
      totalSupported: o,
      modules: e
    };
  }
  getMcpToolsManifest() {
    return { tools: this.capabilityDefinitions.map((e) => ({
      name: e.actionId,
      description: `${e.title}. ${e.description}`,
      inputSchema: e.inputSchema
    })) };
  }
  getOpenClawManifest() {
    return {
      schemaVersion: "openclaw.tool.v1",
      tools: this.capabilityDefinitions.map((e) => ({
        name: e.actionId,
        description: `${e.title}. ${e.description}`,
        parameters: e.inputSchema
      }))
    };
  }
  getOpenClawSkillManifest() {
    return {
      schemaVersion: "openclaw.skill.v1",
      skills: this.capabilityDefinitions.map((e) => ({
        name: e.actionId,
        title: e.title,
        description: e.description,
        inputSchema: e.inputSchema
      }))
    };
  }
  getSettings() {
    return this.settingsCache;
  }
  getMapImageStats() {
    return this.mapImageStatsCache;
  }
  updateSettings(t) {
    return this.settingsCache = {
      ...this.settingsCache,
      ...t,
      http: { ...this.settingsCache.http, ...t.http ?? {} },
      mcpCli: { ...this.settingsCache.mcpCli, ...t.mcpCli ?? {} },
      proxy: { ...this.settingsCache.proxy, ...t.proxy ?? {} },
      summary: { ...this.settingsCache.summary, ...t.summary ?? {} },
      embedding: { ...this.settingsCache.embedding, ...t.embedding ?? {} }
    }, this.persistSettings(), this.settingsCache;
  }
  async testConnection() {
    return this.getProvider().healthCheck();
  }
  async testMcp() {
    return new qt(this.settingsCache).healthCheck();
  }
  async testOpenClawMcp() {
    const t = await this.testOpenClawSmoke({ kind: "mcp" });
    return { ok: t.ok, detail: t.detail };
  }
  async testOpenClawSkill() {
    const t = await this.testOpenClawSmoke({ kind: "skill" });
    return { ok: t.ok, detail: t.detail };
  }
  async testOpenClawSmoke(t) {
    var f, h;
    const e = t.kind === "skill" ? "skill" : "mcp", n = e === "mcp" ? this.getOpenClawManifest().tools.map((c) => c.name) : this.getOpenClawSkillManifest().skills.map((c) => c.name);
    if (!n.length)
      return {
        ok: !1,
        kind: e,
        detail: e === "mcp" ? "No OpenClaw MCP tools available" : "No OpenClaw skills available",
        missingActions: [...mt],
        checks: []
      };
    const o = mt.filter((c) => !n.includes(c)), a = [], s = (c, d, w, S) => {
      a.push({ actionId: c, ok: d, detail: w, ...S ? { skipped: !0 } : {} });
    };
    o.length ? s("manifest.coverage", !1, `Missing required actions: ${o.join(", ")}`) : s("manifest.coverage", !0, `All required actions are covered (${mt.length})`);
    const i = (c, d) => e === "mcp" ? this.invokeOpenClawTool({ name: c, arguments: d }) : this.invokeOpenClawSkill({ name: c, input: d }), l = await i("novel.list");
    if (!l.ok)
      return s("novel.list", !1, l.error || "invoke failed"), {
        ok: !1,
        kind: e,
        detail: `OpenClaw ${e.toUpperCase()} smoke failed at novel.list: ${l.error || "unknown error"}`,
        missingActions: o,
        checks: a
      };
    s("novel.list", !0, "invoke ok");
    const m = (f = (Array.isArray(l.data) ? l.data : []).find((c) => typeof (c == null ? void 0 : c.id) == "string")) == null ? void 0 : f.id;
    if (!m) {
      s("volume.list", !0, "no novels in database; skipped", !0), s("chapter.list", !0, "no novels in database; skipped", !0);
      const c = o.length === 0;
      return {
        ok: c,
        kind: e,
        detail: c ? `OpenClaw ${e.toUpperCase()} smoke passed (manifest coverage ok, invoke ok, nested checks skipped due to empty data)` : `OpenClaw ${e.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${o.join(", ")})`,
        missingActions: o,
        checks: a
      };
    }
    const C = await i("volume.list", { novelId: m });
    if (!C.ok)
      return s("volume.list", !1, C.error || "invoke failed"), {
        ok: !1,
        kind: e,
        detail: `OpenClaw ${e.toUpperCase()} smoke failed at volume.list: ${C.error || "unknown error"}`,
        missingActions: o,
        checks: a
      };
    s("volume.list", !0, "invoke ok");
    const g = (h = (Array.isArray(C.data) ? C.data : []).find((c) => typeof (c == null ? void 0 : c.id) == "string")) == null ? void 0 : h.id;
    if (!g) {
      s("chapter.list", !0, "no volumes under first novel; skipped", !0);
      const c = o.length === 0;
      return {
        ok: c,
        kind: e,
        detail: c ? `OpenClaw ${e.toUpperCase()} smoke passed (manifest coverage ok, read-chain invoke ok)` : `OpenClaw ${e.toUpperCase()} smoke partial pass (read-chain ok, but manifest missing required actions: ${o.join(", ")})`,
        missingActions: o,
        checks: a
      };
    }
    const p = await i("chapter.list", { volumeId: g });
    if (!p.ok)
      return s("chapter.list", !1, p.error || "invoke failed"), {
        ok: !1,
        kind: e,
        detail: `OpenClaw ${e.toUpperCase()} smoke failed at chapter.list: ${p.error || "unknown error"}`,
        missingActions: o,
        checks: a
      };
    s("chapter.list", !0, "invoke ok");
    const y = o.length === 0;
    return {
      ok: y,
      kind: e,
      detail: y ? `OpenClaw ${e.toUpperCase()} smoke passed (manifest coverage + read-chain invoke all ok)` : `OpenClaw ${e.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${o.join(", ")})`,
      missingActions: o,
      checks: a
    };
  }
  async testProxy() {
    const t = this.settingsCache.proxy;
    return t.mode !== "custom" ? { ok: !0, detail: `Proxy mode is ${t.mode}` } : !(t.httpProxy || t.httpsProxy || t.allProxy) ? { ok: !1, detail: "Custom proxy mode requires at least one proxy value" } : { ok: !0, detail: "Custom proxy configuration looks valid" };
  }
  async testGenerate(t) {
    var e;
    try {
      return { ok: !0, text: ((e = (await this.getProvider().generate({
        systemPrompt: "You are a concise assistant.",
        prompt: (t || "请用一句话回复：AI 生成测试成功").trim(),
        maxTokens: 128,
        temperature: 0.2
      })).text) == null ? void 0 : e.slice(0, 500)) || "" };
    } catch (n) {
      return { ok: !1, detail: (n == null ? void 0 : n.message) || "test generate failed" };
    }
  }
  async generateTitle(t) {
    var f, h;
    L("INFO", "AiService.generateTitle.start", "Generate title start", {
      chapterId: t.chapterId,
      novelId: t.novelId,
      providerType: this.settingsCache.providerType
    });
    const e = this.getProvider(), n = Math.max(5, Math.min(10, t.count ?? 6)), a = ro(t.content).slice(0, 4e3), s = await u.novel.findUnique({
      where: { id: t.novelId },
      select: { title: !0, description: !0 }
    }), i = await u.chapter.findUnique({
      where: { id: t.chapterId },
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
    }), v = (await u.chapter.findMany({
      where: {
        volume: { novelId: t.novelId },
        id: { not: t.chapterId }
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
    })).map((c, d) => {
      var w, S;
      return {
        index: d + 1,
        volumeTitle: ((w = c.volume) == null ? void 0 : w.title) || "",
        volumeOrder: ((S = c.volume) == null ? void 0 : S.order) || 0,
        chapterOrder: c.order || 0,
        title: c.title || `Chapter-${d + 1}`
      };
    }), m = [
      "You are a Chinese novel title assistant.",
      "Generate concise chapter title candidates based on provided context.",
      "Return STRICT JSON only. No markdown.",
      'JSON shape: {"candidates":[{"title":"...","styleTag":"..."}]}',
      "Each styleTag must be short Chinese phrase like: 稳健推进, 悬念强化, 意象抒情."
    ].join(" "), C = await e.generate({
      systemPrompt: m,
      prompt: JSON.stringify({
        task: "chapter_title_generation",
        count: n,
        novel: {
          title: (s == null ? void 0 : s.title) || "",
          description: (s == null ? void 0 : s.description) || ""
        },
        chapter: {
          title: (i == null ? void 0 : i.title) || "",
          order: (i == null ? void 0 : i.order) || 0,
          volumeTitle: ((f = i == null ? void 0 : i.volume) == null ? void 0 : f.title) || "",
          volumeOrder: ((h = i == null ? void 0 : i.volume) == null ? void 0 : h.order) || 0
        },
        recentChapterTitles: v,
        currentChapterFullText: a,
        constraints: [
          "title length <= 16 Chinese characters preferred",
          "avoid spoilers and proper nouns overuse",
          "output 5-10 candidates"
        ]
      }),
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: this.settingsCache.http.temperature
    }), I = (() => {
      try {
        return JSON.parse(C.text);
      } catch {
        return null;
      }
    })(), g = Array.isArray(I == null ? void 0 : I.candidates) ? I.candidates.map((c) => ({
      title: String((c == null ? void 0 : c.title) || "").trim(),
      styleTag: String((c == null ? void 0 : c.styleTag) || "").trim() || "稳健推进"
    })).filter((c) => !!c.title).slice(0, n) : [];
    if (g.length > 0)
      return L("INFO", "AiService.generateTitle.success", "Generate title success", {
        chapterId: t.chapterId,
        candidateCount: g.length
      }), { candidates: g };
    const p = C.text.split(`
`).map((c) => c.replace(/^[-\d.\s]+/, "").trim()).filter(Boolean).slice(0, n).map((c) => ({ title: c, styleTag: "稳健推进" }));
    if (p.length > 0)
      return L("INFO", "AiService.generateTitle.success", "Generate title success", {
        chapterId: t.chapterId,
        candidateCount: p.length
      }), { candidates: p };
    const y = ((i == null ? void 0 : i.title) || a.slice(0, 12) || "新章节").trim();
    return L("INFO", "AiService.generateTitle.success", "Generate title success", {
      chapterId: t.chapterId,
      candidateCount: n
    }), {
      candidates: Array.from({ length: n }, (c, d) => ({
        title: `${y} · ${d + 1}`,
        styleTag: "稳健推进"
      }))
    };
  }
  async previewContinuePrompt(t) {
    L("INFO", "AiService.previewContinuePrompt.start", "Preview continue prompt start", {
      chapterId: t.chapterId,
      novelId: t.novelId,
      contextChapterCount: t.contextChapterCount
    });
    const e = await this.buildContinuePromptBundle(t);
    return L("INFO", "AiService.previewContinuePrompt.success", "Preview continue prompt success", {
      chapterId: t.chapterId
    }), {
      structured: e.structured,
      rawPrompt: Kt(e.systemPrompt, e.effectiveUserPrompt),
      editableUserPrompt: e.defaultUserPrompt,
      usedContext: e.usedContext,
      warnings: e.warnings
    };
  }
  async continueWriting(t) {
    L("INFO", "AiService.continueWriting.start", "Continue writing start", {
      chapterId: t.chapterId,
      novelId: t.novelId,
      providerType: this.settingsCache.providerType,
      targetLength: t.targetLength,
      contextChapterCount: t.contextChapterCount
    });
    const e = this.getProvider(), n = await this.buildContinuePromptBundle(t), o = Number.isFinite(t.temperature) ? Math.max(0, Math.min(2, Number(t.temperature))) : this.settingsCache.http.temperature, a = await e.generate({
      systemPrompt: n.systemPrompt,
      prompt: n.effectiveUserPrompt,
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: o
    }), s = await this.checkConsistency({
      novelId: t.novelId,
      text: a.text
    }), i = {
      text: a.text,
      usedContext: n.usedContext,
      warnings: n.warnings,
      consistency: s
    };
    return L("INFO", "AiService.continueWriting.success", "Continue writing success", {
      chapterId: t.chapterId,
      warningCount: n.warnings.length,
      generatedLength: i.text.length
    }), i;
  }
  async checkConsistency(t) {
    const e = [];
    return (await u.worldSetting.findMany({ where: { novelId: t.novelId } })).length === 0 && e.push("No world settings found for consistency baseline."), t.text.length < 20 && e.push("Generated text is too short."), { ok: e.length === 0, issues: e };
  }
  async previewNovelAskPrompt(t) {
    var n;
    L("INFO", "AiService.previewNovelAskPrompt.start", "Preview novel RAG prompt start", {
      novelId: t.novelId,
      questionLength: ((n = t.question) == null ? void 0 : n.length) ?? 0
    });
    const e = await this.novelRagService.preview(t, this.settingsCache.embedding);
    return L("INFO", "AiService.previewNovelAskPrompt.success", "Preview novel RAG prompt success", {
      novelId: t.novelId,
      intent: e.intent,
      evidenceCount: e.evidence.length
    }), e;
  }
  async askNovel(t) {
    var o;
    L("INFO", "AiService.askNovel.start", "Novel RAG ask start", {
      novelId: t.novelId,
      questionLength: ((o = t.question) == null ? void 0 : o.length) ?? 0,
      providerType: this.settingsCache.providerType
    });
    const e = this.getProvider(), n = await this.novelRagService.ask(t, e, {
      maxTokens: Math.min(2048, this.settingsCache.http.maxTokens || 2048),
      temperature: 0.2,
      embeddingSettings: this.settingsCache.embedding
    });
    return L("INFO", "AiService.askNovel.success", "Novel RAG ask success", {
      novelId: t.novelId,
      intent: n.intent,
      confidence: n.confidence,
      evidenceCount: n.evidence.length
    }), n;
  }
  async rebuildRagIndex(t) {
    return _r(t, this.settingsCache.embedding);
  }
  async upsertRagChapterIndex(t, e) {
    var n;
    if (e != null && e.skipIfNovelNotIndexed) {
      const o = await u.chapter.findUnique({
        where: { id: t },
        select: { volume: { select: { novelId: !0 } } }
      }), a = (n = o == null ? void 0 : o.volume) == null ? void 0 : n.novelId;
      if (!a || await wt(a) === 0)
        return {
          chunks: 0,
          sources: 0,
          provider: "none",
          model: "not-indexed",
          dimensions: 0,
          fallbackUsed: !1,
          sourceId: t,
          novelId: a,
          skipped: !0
        };
    }
    return Bn(t, this.settingsCache.embedding);
  }
  async upsertRagSourceIndex(t, e, n) {
    if (t === "chapter")
      return { ...await this.upsertRagChapterIndex(e, n), sourceType: t };
    if (n != null && n.skipIfNovelNotIndexed) {
      const o = await Cr(t, e), a = o == null ? void 0 : o.novelId;
      if (!a || await wt(a) === 0)
        return {
          chunks: 0,
          sources: 0,
          provider: "none",
          model: "not-indexed",
          dimensions: 0,
          fallbackUsed: !1,
          sourceType: t,
          sourceId: e,
          novelId: a,
          skipped: !0
        };
    }
    return Ar(t, e, this.settingsCache.embedding);
  }
  async deleteRagChapterIndex(t, e) {
    return It({
      novelId: t,
      sourceType: "chapter",
      sourceId: e
    });
  }
  async deleteRagSourceIndex(t, e, n) {
    return It({ novelId: t, sourceType: e, sourceId: n });
  }
  refreshRagSourceIndexInBackground(t, e, n) {
    this.upsertRagSourceIndex(t, e, { skipIfNovelNotIndexed: !0 }).catch((o) => {
      console.warn("[RAG] Failed to refresh source index:", { sourceType: t, sourceId: e, reason: n, error: o });
    });
  }
  async refreshLatestCreativeAssetIndexes(t, e) {
    var C;
    const n = async (I, g) => g.length === 0 ? [] : I.findMany({
      where: { novelId: t, name: { in: g } },
      select: { id: !0 }
    }), o = (e.plotLines ?? []).map((I) => I.name).filter(Boolean), a = (e.characters ?? []).map((I) => I.name).filter(Boolean), s = [
      ...(e.items ?? []).map((I) => I.name),
      ...(e.skills ?? []).map((I) => I.name)
    ].filter(Boolean), [i, l, v] = await Promise.all([
      n(u.plotLine, o),
      n(u.character, a),
      n(u.item, s)
    ]);
    for (const I of i)
      this.refreshRagSourceIndexInBackground("plotLine", I.id, "confirm-creative-assets");
    for (const I of l)
      this.refreshRagSourceIndexInBackground("character", I.id, "confirm-creative-assets");
    for (const I of v)
      this.refreshRagSourceIndexInBackground("item", I.id, "confirm-creative-assets");
    const m = await u.plotPoint.findMany({
      where: { novelId: t },
      orderBy: { createdAt: "desc" },
      take: Math.max(0, (((C = e.plotPoints) == null ? void 0 : C.length) ?? 0) + (e.plotLines ?? []).reduce((I, g) => {
        var p;
        return I + (((p = g.points) == null ? void 0 : p.length) ?? 0);
      }, 0)),
      select: { id: !0 }
    });
    for (const I of m)
      this.refreshRagSourceIndexInBackground("plotPoint", I.id, "confirm-creative-assets");
  }
  refreshRagAfterAction(t, e) {
    const n = e && typeof e == "object" ? e : null, o = typeof (n == null ? void 0 : n.id) == "string" ? n.id : "";
    o && (t === "worldsetting.create" || t === "worldsetting.update") && this.refreshRagSourceIndexInBackground("worldSetting", o, t);
  }
  async previewCreativeAssetsPrompt(t) {
    var n;
    L("INFO", "AiService.previewCreativeAssetsPrompt.start", "Preview creative assets prompt start", {
      novelId: t.novelId,
      briefLength: ((n = t.brief) == null ? void 0 : n.length) ?? 0,
      targetSections: t.targetSections
    });
    const e = await this.buildCreativeAssetsPromptBundle(t);
    return L("INFO", "AiService.previewCreativeAssetsPrompt.success", "Preview creative assets prompt success", {
      novelId: t.novelId
    }), {
      structured: e.structured,
      rawPrompt: Kt(e.systemPrompt, e.effectiveUserPrompt),
      editableUserPrompt: e.defaultUserPrompt,
      usedContext: e.usedContext
    };
  }
  inferCreativeTargetSections(t) {
    const e = String(t || "").trim().toLowerCase();
    if (!e)
      return [...qe];
    const n = [];
    for (const o of qe)
      Yn[o].some((s) => e.includes(s.toLowerCase())) && n.push(o);
    return n.length > 0 ? n : [...qe];
  }
  resolveCreativeTargetSections(t) {
    const n = (Array.isArray(t.targetSections) ? t.targetSections : []).filter((o) => qe.includes(o));
    return n.length > 0 ? n : this.inferCreativeTargetSections(t.brief);
  }
  buildEmptyCreativeDraft(t) {
    const e = {};
    for (const n of t)
      e[n] = [];
    return e;
  }
  async generateCreativeAssets(t) {
    var v, m, C, I, g, p, y, f, h, c, d, w, S;
    L("INFO", "AiService.generateCreativeAssets.start", "Generate creative assets start", {
      novelId: t.novelId,
      briefLength: ((v = t.brief) == null ? void 0 : v.length) ?? 0,
      providerType: this.settingsCache.providerType,
      targetSections: t.targetSections
    });
    const e = this.getProvider(), n = await this.buildCreativeAssetsPromptBundle(t), o = this.resolveCreativeTargetSections(t), a = await e.generate({
      systemPrompt: n.systemPrompt,
      prompt: n.effectiveUserPrompt,
      maxTokens: this.settingsCache.http.maxTokens,
      temperature: this.settingsCache.http.temperature,
      // 创作工坊需要生成多个板块的结构化 JSON，内容量大，使用更宽裕的超时
      timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 18e4)
    });
    try {
      const _ = JSON.parse(a.text);
      if (_ && typeof _ == "object") {
        const A = this.buildEmptyCreativeDraft(o);
        for (const x of o) {
          const P = _ == null ? void 0 : _[x];
          A[x] = Array.isArray(P) ? P : [];
        }
        return L("INFO", "AiService.generateCreativeAssets.success", "Generate creative assets success", {
          novelId: t.novelId,
          counts: {
            plotLines: ((m = A.plotLines) == null ? void 0 : m.length) ?? 0,
            plotPoints: ((C = A.plotPoints) == null ? void 0 : C.length) ?? 0,
            characters: ((I = A.characters) == null ? void 0 : I.length) ?? 0,
            items: ((g = A.items) == null ? void 0 : g.length) ?? 0,
            skills: ((p = A.skills) == null ? void 0 : p.length) ?? 0,
            maps: ((y = A.maps) == null ? void 0 : y.length) ?? 0
          }
        }), { draft: A };
      }
    } catch {
    }
    const s = Oe().slice(0, 6), i = {
      plotLines: [{
        name: `主线-${s}`,
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
      characters: [{ name: `角色-${s}`, role: "protagonist", description: "AI 生成角色草稿", profile: { goal: "完成使命" } }],
      items: [{ name: `物品-${s}`, type: "item", description: "AI 生成物品草稿", profile: { rarity: "rare" } }],
      skills: [{ name: `技能-${s}`, description: "AI 生成技能草稿", profile: { rank: "A" } }],
      maps: [{ name: `世界地图-${s}`, type: "world", description: "AI 生成地图草稿", imagePrompt: "fantasy world map" }]
    }, l = this.buildEmptyCreativeDraft(o);
    for (const _ of o)
      l[_] = i[_] ?? [];
    return L("INFO", "AiService.generateCreativeAssets.success", "Generate creative assets success", {
      novelId: t.novelId,
      counts: {
        plotLines: ((f = l.plotLines) == null ? void 0 : f.length) ?? 0,
        plotPoints: ((h = l.plotPoints) == null ? void 0 : h.length) ?? 0,
        characters: ((c = l.characters) == null ? void 0 : c.length) ?? 0,
        items: ((d = l.items) == null ? void 0 : d.length) ?? 0,
        skills: ((w = l.skills) == null ? void 0 : w.length) ?? 0,
        maps: ((S = l.maps) == null ? void 0 : S.length) ?? 0
      }
    }), {
      draft: l
    };
  }
  async validateCreativeAssetsDraft(t) {
    var y, f;
    const e = [], n = [], o = (h) => e.push(h), a = (h, c, d = Zn) => {
      const w = typeof h == "string" ? h.trim() : "";
      return w ? w.length <= d ? w : (n.push(`${c} exceeds ${d} chars and was truncated`), w.slice(0, d)) : "";
    }, s = (h, c) => {
      if (!h || typeof h != "object" || Array.isArray(h))
        return {};
      const d = {};
      for (const [w, S] of Object.entries(h)) {
        const _ = a(w, `${c}.key`, 64), A = a(S, `${c}.${w}`, 500);
        _ && A && (d[_] = A);
      }
      return d;
    }, i = {
      plotLines: (t.draft.plotLines ?? []).map((h, c) => ({
        name: a(h.name, `plotLines[${c}].name`, 120),
        description: a(h.description, `plotLines[${c}].description`),
        color: a(h.color, `plotLines[${c}].color`, 16) || "#6366f1",
        points: (h.points ?? []).map((d, w) => {
          const S = a(d.type, `plotLines[${c}].points[${w}].type`, 32) || "event", _ = a(d.status, `plotLines[${c}].points[${w}].status`, 32) || "active";
          return {
            title: a(d.title, `plotLines[${c}].points[${w}].title`, 120),
            description: a(d.description, `plotLines[${c}].points[${w}].description`),
            type: Jt.has(S) ? S : "event",
            status: Zt.has(_) ? _ : "active"
          };
        })
      })),
      plotPoints: (t.draft.plotPoints ?? []).map((h, c) => {
        const d = a(h.type, `plotPoints[${c}].type`, 32) || "event", w = a(h.status, `plotPoints[${c}].status`, 32) || "active";
        return {
          title: a(h.title, `plotPoints[${c}].title`, 120),
          description: a(h.description, `plotPoints[${c}].description`),
          type: Jt.has(d) ? d : "event",
          status: Zt.has(w) ? w : "active",
          plotLineName: a(h.plotLineName, `plotPoints[${c}].plotLineName`, 120)
        };
      }),
      characters: (t.draft.characters ?? []).map((h, c) => ({
        name: a(h.name, `characters[${c}].name`, 120),
        role: a(h.role, `characters[${c}].role`, 64),
        description: a(h.description, `characters[${c}].description`),
        profile: s(h.profile, `characters[${c}].profile`)
      })),
      items: (t.draft.items ?? []).map((h, c) => {
        const d = a(h.type, `items[${c}].type`, 32) || "item";
        return {
          name: a(h.name, `items[${c}].name`, 120),
          type: Kn.has(d) ? d : "item",
          description: a(h.description, `items[${c}].description`),
          profile: s(h.profile, `items[${c}].profile`)
        };
      }),
      skills: (t.draft.skills ?? []).map((h, c) => ({
        name: a(h.name, `skills[${c}].name`, 120),
        description: a(h.description, `skills[${c}].description`),
        profile: s(h.profile, `skills[${c}].profile`)
      })),
      maps: (t.draft.maps ?? []).map((h, c) => {
        const d = a(h.type, `maps[${c}].type`, 32) || "world";
        return {
          name: a(h.name, `maps[${c}].name`, 120),
          type: Xn.has(d) ? d : "world",
          description: a(h.description, `maps[${c}].description`),
          imagePrompt: a(h.imagePrompt, `maps[${c}].imagePrompt`),
          imageUrl: a(h.imageUrl, `maps[${c}].imageUrl`, 2048),
          imageBase64: a(h.imageBase64, `maps[${c}].imageBase64`, 4194304),
          mimeType: a(h.mimeType, `maps[${c}].mimeType`, 64)
        };
      })
    };
    for (const [h, c] of (i.plotLines ?? []).entries()) {
      c.name || o({ scope: `plotLines[${h}]`, code: "INVALID_INPUT", detail: "Plot line name is required" });
      for (const [d, w] of (c.points ?? []).entries())
        w.title || o({ scope: `plotLines[${h}].points[${d}]`, code: "INVALID_INPUT", detail: "Plot point title is required" });
    }
    for (const [h, c] of (i.plotPoints ?? []).entries())
      c.title || o({ scope: `plotPoints[${h}]`, code: "INVALID_INPUT", detail: "Plot point title is required" });
    for (const [h, c] of (i.characters ?? []).entries())
      c.name || o({ scope: `characters[${h}]`, code: "INVALID_INPUT", detail: "Character name is required" });
    for (const [h, c] of (i.items ?? []).entries())
      c.name || o({ scope: `items[${h}]`, code: "INVALID_INPUT", detail: "Item name is required" });
    for (const [h, c] of (i.skills ?? []).entries())
      c.name || o({ scope: `skills[${h}]`, code: "INVALID_INPUT", detail: "Skill name is required" });
    for (const [h, c] of (i.maps ?? []).entries())
      if (c.name || o({ scope: `maps[${h}]`, code: "INVALID_INPUT", detail: "Map name is required" }), +!!c.imageBase64 + +!!c.imageUrl + +!!c.imagePrompt > 1 && o({
        scope: `maps[${h}]`,
        name: c.name,
        code: "INVALID_INPUT",
        detail: "Map image input must use only one source: imageBase64, imageUrl, or imagePrompt"
      }), c.imageUrl && !/^https?:\/\//i.test(c.imageUrl) && o({
        scope: `maps[${h}].imageUrl`,
        name: c.name,
        code: "INVALID_INPUT",
        detail: "Map imageUrl must start with http:// or https://"
      }), c.imageBase64)
        try {
          const w = Buffer.from(c.imageBase64, "base64").length;
          w === 0 && o({
            scope: `maps[${h}].imageBase64`,
            name: c.name,
            code: "INVALID_INPUT",
            detail: "Map imageBase64 is invalid"
          }), w > ut && o({
            scope: `maps[${h}].imageBase64`,
            name: c.name,
            code: "INVALID_INPUT",
            detail: `Map imageBase64 exceeds ${ut} bytes`
          });
        } catch {
          o({
            scope: `maps[${h}].imageBase64`,
            name: c.name,
            code: "INVALID_INPUT",
            detail: "Map imageBase64 is invalid"
          });
        }
    const l = (h, c) => {
      const d = /* @__PURE__ */ new Set();
      for (const w of h) {
        const S = (w.name || "").trim().toLowerCase();
        if (S) {
          if (d.has(S)) {
            o({
              scope: c,
              name: w.name,
              code: "CONFLICT",
              detail: `Duplicate name in current draft: ${w.name}`
            });
            continue;
          }
          d.add(S);
        }
      }
    };
    l(i.plotLines ?? [], "plotLines"), l(i.characters ?? [], "characters"), l(i.items ?? [], "items"), l(i.skills ?? [], "skills"), l(i.maps ?? [], "maps");
    const [v, m, C, I] = await Promise.all([
      u.plotLine.findMany({ where: { novelId: t.novelId }, select: { name: !0 } }),
      u.character.findMany({ where: { novelId: t.novelId }, select: { name: !0 } }),
      u.item.findMany({ where: { novelId: t.novelId }, select: { name: !0 } }),
      u.mapCanvas.findMany({ where: { novelId: t.novelId }, select: { name: !0 } })
    ]), g = {
      plotLines: new Set(v.map((h) => h.name.trim().toLowerCase())),
      characters: new Set(m.map((h) => h.name.trim().toLowerCase())),
      items: new Set(C.map((h) => h.name.trim().toLowerCase())),
      maps: new Set(I.map((h) => h.name.trim().toLowerCase()))
    }, p = (h, c, d) => {
      for (const w of h) {
        const S = (w.name || "").trim().toLowerCase();
        S && g[c].has(S) && o({
          scope: d,
          name: w.name,
          code: "CONFLICT",
          detail: `Name already exists in novel: ${w.name}`
        });
      }
    };
    return p(i.plotLines ?? [], "plotLines", "plotLines"), p(i.characters ?? [], "characters", "characters"), p(i.items ?? [], "items", "items"), p(i.skills ?? [], "items", "skills"), p(i.maps ?? [], "maps", "maps"), (((y = i.plotPoints) == null ? void 0 : y.length) ?? 0) > 0 && (((f = i.plotLines) == null ? void 0 : f.length) ?? 0) === 0 && n.push("Draft has plotPoints but no plotLines. System will create a default plot line when persisting."), {
      ok: e.length === 0,
      errors: e,
      warnings: n,
      normalizedDraft: i
    };
  }
  async confirmCreativeAssets(t) {
    var l, v, m, C, I, g;
    L("INFO", "AiService.confirmCreativeAssets.start", "Confirm creative assets start", {
      novelId: t.novelId,
      draftCounts: ne({
        plotLines: ((l = t.draft.plotLines) == null ? void 0 : l.length) ?? 0,
        plotPoints: ((v = t.draft.plotPoints) == null ? void 0 : v.length) ?? 0,
        characters: ((m = t.draft.characters) == null ? void 0 : m.length) ?? 0,
        items: ((C = t.draft.items) == null ? void 0 : C.length) ?? 0,
        skills: ((I = t.draft.skills) == null ? void 0 : I.length) ?? 0,
        maps: ((g = t.draft.maps) == null ? void 0 : g.length) ?? 0
      })
    });
    const e = await this.validateCreativeAssetsDraft(t), n = {
      plotLines: 0,
      plotPoints: 0,
      characters: 0,
      items: 0,
      skills: 0,
      maps: 0,
      mapImages: 0
    };
    if (!e.ok)
      return L("WARN", "AiService.confirmCreativeAssets.validationFailed", "Confirm creative assets validation failed", {
        novelId: t.novelId,
        errors: e.errors,
        warnings: e.warnings
      }), {
        success: !1,
        created: n,
        warnings: e.warnings,
        errors: e.errors,
        transactionMode: "atomic"
      };
    const o = e.normalizedDraft, a = this.getProvider(), s = [];
    let i = { ...n };
    try {
      await u.$transaction(async (y) => {
        const f = { ...n }, h = /* @__PURE__ */ new Map();
        for (const d of o.plotLines ?? []) {
          const w = await y.plotLine.create({
            data: {
              novelId: t.novelId,
              name: d.name,
              description: d.description || null,
              color: d.color || "#6366f1",
              sortOrder: Date.now() + f.plotLines
            }
          });
          h.set(d.name.toLowerCase(), w.id), f.plotLines += 1;
          for (const S of d.points ?? [])
            await y.plotPoint.create({
              data: {
                novelId: t.novelId,
                plotLineId: w.id,
                title: S.title,
                description: S.description || null,
                type: S.type || "event",
                status: S.status || "active",
                order: Date.now() + f.plotPoints
              }
            }), f.plotPoints += 1;
        }
        const c = async (d) => {
          const w = (d || "").trim().toLowerCase();
          if (w && h.has(w))
            return h.get(w);
          const S = h.values().next().value;
          if (S)
            return S;
          const _ = "AI 主线", A = await y.plotLine.create({
            data: {
              novelId: t.novelId,
              name: _,
              description: "Auto-created for loose plot points",
              color: "#6366f1",
              sortOrder: Date.now() + f.plotLines
            }
          });
          return h.set(_.toLowerCase(), A.id), f.plotLines += 1, A.id;
        };
        for (const d of o.plotPoints ?? []) {
          const w = await c(d.plotLineName);
          await y.plotPoint.create({
            data: {
              novelId: t.novelId,
              plotLineId: w,
              title: d.title,
              description: d.description || null,
              type: d.type || "event",
              status: d.status || "active",
              order: Date.now() + f.plotPoints
            }
          }), f.plotPoints += 1;
        }
        for (const d of o.characters ?? [])
          await y.character.create({
            data: {
              novelId: t.novelId,
              name: d.name,
              role: d.role || null,
              description: d.description || null,
              profile: pt(d.profile),
              sortOrder: Date.now() + f.characters
            }
          }), f.characters += 1;
        for (const d of o.items ?? [])
          await y.item.create({
            data: {
              novelId: t.novelId,
              name: d.name,
              type: d.type || "item",
              description: d.description || null,
              profile: pt(d.profile),
              sortOrder: Date.now() + f.items
            }
          }), f.items += 1;
        for (const d of o.skills ?? [])
          await y.item.create({
            data: {
              novelId: t.novelId,
              name: d.name,
              type: "skill",
              description: d.description || null,
              profile: pt(d.profile),
              sortOrder: Date.now() + f.items + f.skills
            }
          }), f.skills += 1;
        for (const d of o.maps ?? []) {
          const w = await y.mapCanvas.create({
            data: {
              novelId: t.novelId,
              name: d.name,
              type: d.type || "world",
              description: d.description || null,
              sortOrder: Date.now() + f.maps
            }
          });
          f.maps += 1;
          let S = null;
          if (d.imageBase64 || d.imageUrl)
            S = {
              imageBase64: d.imageBase64,
              imageUrl: d.imageUrl,
              mimeType: d.mimeType
            };
          else if (d.imagePrompt) {
            if (!a.generateImage)
              throw new q("INVALID_INPUT", `Provider ${a.name} does not support image generation`);
            const _ = await a.generateImage({ prompt: d.imagePrompt });
            if (!(_ != null && _.imageBase64) && !(_ != null && _.imageUrl))
              throw new q("PROVIDER_UNAVAILABLE", `Map image generation returned empty data for ${d.name}`);
            S = {
              imageBase64: _.imageBase64,
              imageUrl: _.imageUrl,
              mimeType: _.mimeType
            };
          }
          if (S) {
            const _ = await this.saveImageAsset(t.novelId, w.id, S);
            s.push(_.absolutePath), await y.mapCanvas.update({
              where: { id: w.id },
              data: { background: _.relativePath }
            }), f.mapImages += 1;
          }
        }
        i = f;
      });
      const p = {
        success: !0,
        created: i,
        warnings: e.warnings,
        transactionMode: "atomic"
      };
      return this.refreshLatestCreativeAssetIndexes(t.novelId, o).catch((y) => {
        console.warn("[RAG] Failed to refresh creative asset indexes:", y);
      }), L("INFO", "AiService.confirmCreativeAssets.success", "Confirm creative assets success", {
        novelId: t.novelId,
        created: i,
        warningCount: e.warnings.length
      }), p;
    } catch (p) {
      ce("AiService.confirmCreativeAssets.error", p, {
        novelId: t.novelId
      });
      for (const h of s)
        try {
          W.existsSync(h) && W.unlinkSync(h);
        } catch {
        }
      const y = de(p), f = y.code === "INVALID_INPUT" ? "INVALID_INPUT" : y.code === "CONFLICT" ? "CONFLICT" : y.code === "UNKNOWN" ? "UNKNOWN" : "PERSISTENCE_ERROR";
      return {
        success: !1,
        created: n,
        warnings: e.warnings,
        errors: [
          {
            scope: "confirmCreativeAssets",
            code: f,
            detail: y.message || "Creative assets persistence failed"
          }
        ],
        transactionMode: "atomic"
      };
    }
  }
  async previewMapPrompt(t) {
    var n;
    L("INFO", "AiService.previewMapPrompt.start", "Preview map prompt start", {
      novelId: t.novelId,
      mapId: t.mapId,
      promptLength: ((n = t.prompt) == null ? void 0 : n.length) ?? 0
    });
    const e = await this.buildMapPromptBundle(t);
    return L("INFO", "AiService.previewMapPrompt.success", "Preview map prompt success", {
      novelId: t.novelId,
      mapId: t.mapId
    }), {
      structured: e.structured,
      rawPrompt: e.effectiveUserPrompt,
      editableUserPrompt: e.defaultUserPrompt,
      usedWorldLore: e.usedWorldLore
    };
  }
  async generateMapImage(t) {
    var o, a, s, i;
    L("INFO", "AiService.generateMapImage.start", "Generate map image start", {
      novelId: t.novelId,
      mapId: t.mapId,
      promptLength: ((o = t.prompt) == null ? void 0 : o.length) ?? 0,
      providerType: this.settingsCache.providerType
    });
    const e = Date.now(), n = (l) => (this.recordMapImageCall({
      ok: l.ok,
      code: l.code,
      detail: l.detail,
      latencyMs: Date.now() - e
    }), l);
    try {
      const l = !!((a = t.prompt) != null && a.trim()), v = !!((s = t.overrideUserPrompt) != null && s.trim());
      if (!l && !v)
        return n({ ok: !1, code: "INVALID_INPUT", detail: "Map prompt is empty" });
      const m = this.getProvider();
      if (!m.generateImage)
        return n({ ok: !1, code: "INVALID_INPUT", detail: `Provider ${m.name} does not support image generation` });
      const C = await this.buildMapPromptBundle(t), I = await m.generateImage({
        prompt: C.effectiveUserPrompt,
        model: this.settingsCache.http.imageModel || void 0,
        size: t.imageSize || this.settingsCache.http.imageSize || void 0,
        outputFormat: this.settingsCache.http.imageOutputFormat || void 0,
        watermark: this.settingsCache.http.imageWatermark
      });
      if (!I.imageBase64 && !I.imageUrl)
        return n({ ok: !1, code: "PROVIDER_UNAVAILABLE", detail: "Provider did not return any image data" });
      let g = t.mapId;
      if (g || (g = (await u.mapCanvas.create({
        data: {
          novelId: t.novelId,
          name: ((i = t.mapName) == null ? void 0 : i.trim()) || `AI 地图 ${(/* @__PURE__ */ new Date()).toLocaleString()}`,
          type: t.mapType || "world",
          description: `Generated by AI with prompt: ${t.prompt}`,
          sortOrder: Date.now()
        }
      })).id), !g)
        throw new q("PERSISTENCE_ERROR", "Map id is missing after map creation");
      const p = await this.saveImageAsset(t.novelId, g, {
        imageBase64: I.imageBase64,
        imageUrl: I.imageUrl,
        mimeType: I.mimeType
      });
      await u.mapCanvas.update({
        where: { id: g },
        data: { background: p.relativePath }
      });
      const y = n({
        ok: !0,
        detail: "Map image generated and stored successfully",
        mapId: g,
        path: p.relativePath
      });
      return L("INFO", "AiService.generateMapImage.success", "Generate map image success", {
        novelId: t.novelId,
        mapId: g,
        imagePath: p.relativePath
      }), y;
    } catch (l) {
      ce("AiService.generateMapImage.error", l, {
        novelId: t.novelId,
        mapId: t.mapId
      });
      const v = de(l);
      return n({
        ok: !1,
        code: v.code,
        detail: v.message || "Map generation failed"
      });
    }
  }
  async executeAction(t) {
    const e = this.capabilityRegistry.get(t.actionId);
    if (!e)
      throw new q("INVALID_INPUT", `Unknown actionId: ${t.actionId}`);
    try {
      const n = await e(t.payload);
      return this.refreshRagAfterAction(t.actionId, n), n;
    } catch (n) {
      throw de(n);
    }
  }
  async invokeOpenClawTool(t) {
    try {
      return { ok: !0, data: await this.executeAction({
        actionId: t.name,
        payload: t.arguments
      }) };
    } catch (e) {
      const n = de(e);
      return {
        ok: !1,
        error: Te(n.code, n.message || "OpenClaw invoke failed"),
        code: n.code
      };
    }
  }
  async invokeOpenClawSkill(t) {
    try {
      return { ok: !0, data: await this.executeAction({
        actionId: t.name,
        payload: t.input
      }) };
    } catch (e) {
      const n = de(e);
      return {
        ok: !1,
        error: Te(n.code, n.message || "OpenClaw skill invoke failed"),
        code: n.code
      };
    }
  }
  compactContinueHardContext(t) {
    const e = Array.isArray(t.worldSettings) ? t.worldSettings : [], n = Array.isArray(t.plotLines) ? t.plotLines : [], o = Array.isArray(t.characters) ? t.characters : [], a = Array.isArray(t.items) ? t.items : [], s = Array.isArray(t.maps) ? t.maps : [];
    return {
      worldSettings: e.slice(0, 60).map((i) => ({
        name: j(i == null ? void 0 : i.name, 80),
        type: j(i == null ? void 0 : i.type, 32) || "other",
        content: j(i == null ? void 0 : i.content, 300) || j(i == null ? void 0 : i.description, 300)
      })).filter((i) => i.content),
      plotLines: n.slice(0, 40).map((i) => ({
        name: j(i == null ? void 0 : i.name, 100),
        description: j(i == null ? void 0 : i.description, 260),
        points: Array.isArray(i == null ? void 0 : i.points) ? i.points.filter((l) => String((l == null ? void 0 : l.status) || "").trim().toLowerCase() !== "resolved").slice(0, 12).map((l) => ({
          title: j(l == null ? void 0 : l.title, 100),
          description: j(l == null ? void 0 : l.description, 220),
          type: j(l == null ? void 0 : l.type, 24) || "event",
          status: j(l == null ? void 0 : l.status, 24) || "active"
        })).filter((l) => l.title || l.description) : []
      })).filter((i) => {
        var l;
        return i.name || (((l = i.points) == null ? void 0 : l.length) ?? 0) > 0;
      }),
      characters: o.slice(0, 120).map((i) => ({
        name: j(i == null ? void 0 : i.name, 80),
        role: j(i == null ? void 0 : i.role, 32),
        description: j(i == null ? void 0 : i.description, 220)
      })).filter((i) => i.name && (i.role || i.description)),
      items: a.slice(0, 120).map((i) => ({
        name: j(i == null ? void 0 : i.name, 80),
        type: j(i == null ? void 0 : i.type, 32) || "item",
        description: j(i == null ? void 0 : i.description, 220)
      })).filter((i) => i.name && i.description),
      maps: s.slice(0, 60).map((i) => ({
        name: j(i == null ? void 0 : i.name, 80),
        type: j(i == null ? void 0 : i.type, 24) || "world",
        description: j(i == null ? void 0 : i.description, 220)
      })).filter((i) => i.name && i.description)
    };
  }
  compactContinueDynamicContext(t) {
    const e = Array.isArray(t.recentChapters) ? t.recentChapters : [], n = Array.isArray(t.selectedIdeas) ? t.selectedIdeas : [], o = Array.isArray(t.selectedIdeaEntities) ? t.selectedIdeaEntities : [], a = Array.isArray(t.narrativeSummaries) ? t.narrativeSummaries : [], s = j(t.currentLocation, 120);
    return {
      recentChapters: e.slice(0, 8).map((i) => ({
        title: j(i == null ? void 0 : i.title, 120),
        excerpt: j(i == null ? void 0 : i.excerpt, 1200)
      })).filter((i) => i.title || i.excerpt),
      selectedIdeas: n.slice(0, 20).map((i) => ({
        content: j(i == null ? void 0 : i.content, 800),
        quote: j(i == null ? void 0 : i.quote, 300),
        tags: Array.isArray(i == null ? void 0 : i.tags) ? i.tags.slice(0, 12).map((l) => j(l, 32)).filter(Boolean) : []
      })).filter((i) => i.content || i.quote),
      selectedIdeaEntities: o.slice(0, 20).map((i) => ({
        name: j(i == null ? void 0 : i.name, 80),
        kind: j(i == null ? void 0 : i.kind, 24)
      })).filter((i) => i.name && i.kind),
      currentChapterBeforeCursor: j(t.currentChapterBeforeCursor, 2600),
      ...s ? { currentLocation: s } : {},
      narrativeSummaries: a.slice(0, 4).map((i) => ({
        level: (i == null ? void 0 : i.level) === "volume" ? "volume" : "novel",
        title: j(i == null ? void 0 : i.title, 100),
        summaryText: j(i == null ? void 0 : i.summaryText, 1200),
        keyFacts: Array.isArray(i == null ? void 0 : i.keyFacts) ? oo(i.keyFacts.map((l) => j(l, 160)).filter(Boolean), 5) : []
      }))
    };
  }
  async buildContinuePromptBundle(t) {
    var y;
    const e = /^zh/i.test(String(t.locale || "").trim()), n = t.mode === "new_chapter" ? "new_chapter" : "continue_chapter", o = await this.contextBuilder.buildForContinueWriting({
      ...t,
      mode: n,
      recentRawChapterCount: t.recentRawChapterCount ?? this.settingsCache.summary.recentChapterRawCount
    }), a = this.compactContinueHardContext(o.hardContext), s = this.compactContinueDynamicContext(o.dynamicContext), i = j(t.userIntent, 800), l = j(t.currentLocation, 120), v = {
      ...o.params,
      targetLength: e ? `约${Math.max(100, Math.min(4e3, Number(o.params.targetLength || 500)))}汉字` : `about ${Math.max(100, Math.min(4e3, Number(o.params.targetLength || 500)))} Chinese characters`
    }, m = e ? "你是中文小说续写助手。严格遵守世界观和大纲，不得破坏既有设定与人物行为逻辑。" : "Continue writing with strict consistency to world settings and plot outline. Do not break established lore.", I = [
      `WriteMode=${n}`,
      `HardContext=
${JSON.stringify(a, null, 2).slice(0, 18e3)}`,
      `DynamicContext=
${JSON.stringify(s, null, 2).slice(0, 12e3)}`,
      `WriteParams=
${JSON.stringify(v, null, 2)}`,
      ...i ? [`UserIntent=${i}`] : [],
      ...l ? [`CurrentLocation=${l}`] : [],
      n === "new_chapter" ? e ? "Constraint=基于大纲与世界观写出新章节开场，不得复述已有段落。" : "Constraint=Start a fresh chapter opening based on outline and world context. Do not echo prior chapter paragraphs." : e ? "Constraint=仅输出新增续写内容，不得重复当前章节或上下文已出现段落。" : "Constraint=Output must be NEW continuation content only. Do not restate prior paragraphs from current chapter or context.",
      e ? "Constraint=@实体名 表示对上下文中同名角色/物品/地点/设定的引用，续写时应保持实体设定一致。" : "Constraint=@EntityName means referencing the same named entity from context; keep entity traits consistent.",
      ...i ? [e ? "Constraint=尽量满足用户意图，但不得违反世界观与主线大纲。" : "Constraint=Prioritize the user intent when possible, but never violate established world settings and plot outline."] : [],
      e ? "Constraint=请严格遵守 HardContext 中的世界观、角色性格和物品设定；情节推进需与已有情节点保持一致。" : "Constraint=Strictly follow HardContext lore, character traits, and item settings; keep progression aligned with existing plot points.",
      e ? "Constraint=你的任务是续写光标后的新内容，不要重复 currentChapterBeforeCursor 里的任何句子。" : "Constraint=Write only the continuation after cursor; do not repeat any sentence from currentChapterBeforeCursor."
    ].join(`

`), g = (y = t.overrideUserPrompt) != null && y.trim() ? t.overrideUserPrompt.trim() : I, p = {
      ...o.params,
      ...i ? { userIntent: i } : {},
      ...l ? { currentLocation: l } : {}
    };
    return {
      systemPrompt: m,
      defaultUserPrompt: I,
      effectiveUserPrompt: g,
      structured: {
        goal: n === "new_chapter" ? e ? "生成新章节开场内容。" : "Generate opening content for a new chapter." : e ? "仅生成续写新增内容。" : "Generate continuation content only.",
        contextRefs: o.usedContext,
        params: p,
        constraints: [
          ...e ? ["严格遵守世界观与大纲一致性。"] : ["Keep strict consistency with world settings and outline."],
          ...i ? [e ? "在不冲突时优先满足用户意图。" : "Respect user intent when it does not conflict with hard context."] : [],
          ...e ? ["不得重复已有段落。", "只输出生成的续写正文。"] : ["Do not repeat existing paragraphs.", "Output only generated chapter text."]
        ]
      },
      usedContext: o.usedContext,
      warnings: o.warnings
    };
  }
  async buildCreativeAssetsPromptBundle(t) {
    var y;
    const e = this.resolveCreativeTargetSections(t), n = (t.locale || "zh").startsWith("zh"), o = await u.novel.findUnique({
      where: { id: t.novelId },
      select: { id: !0, title: !0, description: !0 }
    }), a = await this.contextBuilder.buildForCreativeAssets(t), s = n ? "你是一位小说创作助手，擅长根据用户的创意需求和已有小说内容生成结构化的创作素材。请严格以 JSON 格式输出，只输出 JSON，不要添加任何其他文字。所有生成的名称、描述等文本内容必须使用中文。生成的内容应与小说已有的角色、情节、世界观保持一致和关联。" : "You are a novel creation assistant. Generate structured creative assets in strict JSON format based on existing novel content. Output only JSON, no extra text. Generated content should be consistent with existing characters, plot, and world settings.", i = {
      plotLines: [{ name: "string", description: "string?" }],
      plotPoints: [{ title: "string", description: "string?", plotLineName: "string?" }],
      characters: [{ name: "string", role: "string?", description: "string?" }],
      items: [{ name: "string", type: "item|skill|location", description: "string?" }],
      skills: [{ name: "string", description: "string?" }],
      maps: [{ name: "string", type: "world|region|scene", description: "string?", imagePrompt: "string?" }]
    }, l = n ? [
      "仅返回严格的 JSON，不要包含 markdown 代码块标记或其他文字",
      "必须为所有请求的 section 生成内容，不得遗漏任何一个板块",
      `请求的 section 列表: ${e.join(", ")}`,
      "未请求的 section 必须设为空数组",
      "生成内容必须与已有小说内容（角色、情节、世界观）保持一致和关联",
      "避免与已存在的实体重名",
      "所有字段内容简洁、可直接使用",
      "所有名称和描述必须使用中文"
    ] : [
      "return strict JSON only, no markdown code fences or extra text",
      "generate content for ALL requested sections, do not leave any empty",
      `requested sections: ${e.join(", ")}`,
      "all unrequested sections must be empty arrays",
      "generated content must be consistent and related to existing novel content",
      "avoid duplicate names against existing entities",
      "fields should be concise and directly usable"
    ], v = {
      task: "creative_assets_generation",
      language: n ? "Chinese" : "English",
      brief: t.brief,
      novel: {
        title: (o == null ? void 0 : o.title) || "",
        description: (o == null ? void 0 : o.description) || ""
      },
      targetSections: e,
      outputShape: e,
      outputSchema: i,
      constraints: l
    };
    a.existingEntities.characters.length > 0 && (v.existingCharacters = a.existingEntities.characters), a.existingEntities.items.length > 0 && (v.existingItems = a.existingEntities.items), a.existingEntities.plotLines.length > 0 && (v.existingPlotLines = a.existingEntities.plotLines), a.existingEntities.worldSettings.length > 0 && (v.worldSettings = a.existingEntities.worldSettings), a.recentSummaries.length > 0 && (v.recentChapterSummaries = a.recentSummaries), a.narrativeSummaries.length > 0 && (v.narrativeSummary = a.narrativeSummaries[0]);
    const m = JSON.stringify(v), C = (y = t.overrideUserPrompt) != null && y.trim() ? t.overrideUserPrompt.trim() : m, I = [
      `Novel: ${(o == null ? void 0 : o.title) || t.novelId}`,
      ...a.usedContext
    ], g = n ? "根据用户创意简述和已有小说内容，生成可编辑的草稿素材。" : "Generate editable draft assets based on user brief and existing novel content.", p = n ? ["仅输出严格 JSON", "返回所有请求的板块", "与已有内容关联", "内容简洁可用", "避免重名", "使用中文"] : ["Output strict JSON.", "Return ALL selected sections.", "Stay consistent with existing content.", "Prefer concise fields.", "Avoid name conflicts."];
    return {
      systemPrompt: s,
      defaultUserPrompt: m,
      effectiveUserPrompt: C,
      structured: {
        goal: g,
        contextRefs: I,
        params: {
          briefLength: t.brief.trim().length,
          sections: e,
          locale: t.locale || "zh",
          estimatedContextTokens: a.estimatedTokens
        },
        constraints: p
      },
      usedContext: I,
      estimatedTokens: a.estimatedTokens
    };
  }
  async buildMapPromptBundle(t) {
    var l;
    const n = (await u.worldSetting.findMany({
      where: { novelId: t.novelId },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: !0, name: !0, content: !0 }
    })).map((v) => ({
      id: v.id,
      title: String(v.name || "Untitled"),
      excerpt: String(v.content || "").slice(0, 180)
    })), o = no(t.styleTemplate), a = n.length > 0 ? n.map((v, m) => `${m + 1}. ${v.title}: ${v.excerpt}`).join(`
`) : "No explicit world lore provided.", s = [
      o || "Style: follow user requested style.",
      `ImageSize=${t.imageSize || this.settingsCache.http.imageSize || "2K"}`,
      "Task: Generate a clean map background image.",
      `UserRequest=${t.prompt}`,
      "WorldLore:",
      a,
      "Constraints:",
      "- avoid text labels or UI marks",
      "- keep high readability for map canvas editing",
      "- preserve coherence with world lore"
    ].join(`
`), i = (l = t.overrideUserPrompt) != null && l.trim() ? t.overrideUserPrompt.trim() : s;
    return {
      defaultUserPrompt: s,
      effectiveUserPrompt: i,
      structured: {
        goal: "Generate map background image aligned with world lore.",
        contextRefs: [
          `Map type: ${t.mapType || "world"}`,
          `Map name: ${t.mapName || "(new map)"}`,
          `World lore refs: ${n.length}`
        ],
        params: {
          imageSize: t.imageSize || this.settingsCache.http.imageSize || "2K",
          styleTemplate: t.styleTemplate || "default"
        },
        constraints: [
          "No labels or UI overlays in generated image.",
          "Map should be readable for later annotation.",
          "Use world lore when available."
        ]
      },
      usedWorldLore: n
    };
  }
  getProvider() {
    return this.settingsCache.providerType === "mcp-cli" ? new qt(this.settingsCache) : new gr(this.settingsCache);
  }
  async saveImageAsset(t, e, n) {
    let o = n.mimeType || "image/png", a;
    if (n.imageBase64)
      a = Buffer.from(n.imageBase64, "base64");
    else if (n.imageUrl) {
      const m = await fetch(n.imageUrl);
      if (!m.ok)
        throw new Error(`Image download failed: ${m.status}`);
      const C = m.headers.get("content-type") || "";
      C && (o = C);
      const I = await m.arrayBuffer();
      a = Buffer.from(I);
    } else
      throw new Error("No image data provided");
    if (a.length === 0)
      throw new Error("Image data is empty");
    if (a.length > ut)
      throw new Error("Image exceeds maximum size limit");
    if (!o.startsWith("image/"))
      throw new Error(`Invalid mime type: ${o}`);
    const s = eo(o), i = k.join(this.userDataPath, "maps", t);
    W.existsSync(i) || W.mkdirSync(i, { recursive: !0 });
    const l = to(`ai-${e}-${Date.now()}.${s}`), v = k.join(i, l);
    return W.writeFileSync(v, a), {
      relativePath: `maps/${t}/${l}`,
      absolutePath: v
    };
  }
  loadSettings() {
    try {
      if (!W.existsSync(this.settingsFilePath))
        return ye;
      const t = W.readFileSync(this.settingsFilePath, "utf8"), e = JSON.parse(t);
      return {
        ...ye,
        ...e,
        http: { ...ye.http, ...e.http ?? {} },
        mcpCli: { ...ye.mcpCli, ...e.mcpCli ?? {} },
        proxy: { ...ye.proxy, ...e.proxy ?? {} },
        summary: { ...ye.summary, ...e.summary ?? {} },
        embedding: { ...ye.embedding, ...e.embedding ?? {} }
      };
    } catch (t) {
      return console.error("[AI] Failed to load settings, fallback to defaults:", t), ye;
    }
  }
  persistSettings() {
    try {
      const t = k.dirname(this.settingsFilePath);
      W.existsSync(t) || W.mkdirSync(t, { recursive: !0 }), W.writeFileSync(this.settingsFilePath, JSON.stringify(this.settingsCache, null, 2), "utf8");
    } catch (t) {
      console.error("[AI] Failed to persist settings:", t);
    }
  }
  loadMapImageStats() {
    const t = {
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      rateLimitFailures: 0,
      updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
    };
    try {
      if (!W.existsSync(this.mapImageStatsPath))
        return t;
      const e = W.readFileSync(this.mapImageStatsPath, "utf8"), n = JSON.parse(e);
      return {
        totalCalls: n.totalCalls ?? 0,
        successCalls: n.successCalls ?? 0,
        failedCalls: n.failedCalls ?? 0,
        rateLimitFailures: n.rateLimitFailures ?? 0,
        lastFailureCode: n.lastFailureCode || void 0,
        lastFailureAt: n.lastFailureAt || void 0,
        updatedAt: n.updatedAt || t.updatedAt
      };
    } catch (e) {
      return console.warn("[AI] Failed to load map image stats, fallback to defaults:", e), t;
    }
  }
  persistMapImageStats() {
    try {
      const t = k.dirname(this.mapImageStatsPath);
      W.existsSync(t) || W.mkdirSync(t, { recursive: !0 }), W.writeFileSync(this.mapImageStatsPath, JSON.stringify(this.mapImageStatsCache, null, 2), "utf8");
    } catch (t) {
      console.warn("[AI] Failed to persist map image stats:", t);
    }
  }
  recordMapImageCall(t) {
    const e = (t.code || "").toLowerCase(), n = (t.detail || "").toLowerCase(), o = e.includes("rate") || e.includes("429") || n.includes("429") || n.includes("rate limit") || n.includes("quota");
    this.mapImageStatsCache = {
      ...this.mapImageStatsCache,
      totalCalls: this.mapImageStatsCache.totalCalls + 1,
      successCalls: this.mapImageStatsCache.successCalls + (t.ok ? 1 : 0),
      failedCalls: this.mapImageStatsCache.failedCalls + (t.ok ? 0 : 1),
      rateLimitFailures: this.mapImageStatsCache.rateLimitFailures + (!t.ok && o ? 1 : 0),
      lastFailureCode: t.ok ? this.mapImageStatsCache.lastFailureCode : t.code || "UNKNOWN",
      lastFailureAt: t.ok ? this.mapImageStatsCache.lastFailureAt : (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }, this.persistMapImageStats();
  }
}
const io = {
  sessions: []
};
class so {
  constructor(t) {
    G(this, "getUserDataPath");
    G(this, "cache", null);
    this.getUserDataPath = t;
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
    const t = this.getStorePath();
    try {
      const e = await be.readFile(t, "utf8"), n = JSON.parse(e);
      this.cache = Array.isArray(n.sessions) ? n.sessions : [];
    } catch (e) {
      if ((e == null ? void 0 : e.code) !== "ENOENT")
        throw e;
      this.cache = [...io.sessions];
    }
  }
  async flush() {
    await be.mkdir(this.getStoreDir(), { recursive: !0 });
    const t = this.getStorePath(), e = {
      sessions: this.cache ?? []
    };
    await be.writeFile(t, JSON.stringify(e, null, 2), "utf8");
  }
  async list(t) {
    return await this.ensureLoaded(), [...this.cache ?? []].filter((n) => !(t != null && t.novelId && n.novelId !== t.novelId || t != null && t.workspace && n.workspace !== t.workspace || t != null && t.type && n.type !== t.type || t != null && t.status && n.status !== t.status || !(t != null && t.includeInactive) && n.status !== "draft")).sort((n, o) => o.updatedAt.localeCompare(n.updatedAt));
  }
  async getById(t) {
    return await this.ensureLoaded(), (this.cache ?? []).find((e) => e.draftSessionId === t) ?? null;
  }
  async getLatest(t) {
    return (await this.list(t))[0] ?? null;
  }
  async create(t) {
    await this.ensureLoaded();
    const e = (/* @__PURE__ */ new Date()).toISOString(), n = {
      ...t,
      draftSessionId: Oe(),
      version: 1,
      createdAt: e,
      updatedAt: e
    };
    return this.cache = [n, ...(this.cache ?? []).filter((o) => o.novelId !== n.novelId || o.workspace !== n.workspace || o.type !== n.type || o.status !== "draft")], await this.flush(), n;
  }
  async update(t, e, n) {
    await this.ensureLoaded();
    const o = this.cache ?? [], a = o.findIndex((v) => v.draftSessionId === t);
    if (a < 0)
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    const s = o[a];
    if (typeof e == "number" && s.version !== e)
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    const l = {
      ...n(s),
      draftSessionId: s.draftSessionId,
      createdAt: s.createdAt,
      version: s.version + 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return o[a] = l, this.cache = o, await this.flush(), l;
  }
}
const co = {
  plotLines: [],
  plotPoints: [],
  characters: [],
  items: [],
  skills: [],
  maps: []
}, lo = {
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
}, uo = 3e4;
function ht(r) {
  return {
    plotLines: (r.plotLines ?? []).map(() => !0),
    plotPoints: (r.plotPoints ?? []).map(() => !0),
    characters: (r.characters ?? []).map(() => !0),
    items: (r.items ?? []).map(() => !0),
    skills: (r.skills ?? []).map(() => !0),
    maps: (r.maps ?? []).map(() => !0)
  };
}
function fe(r) {
  if (!r || typeof r != "object")
    return { ...co };
  const t = r;
  return {
    plotLines: Array.isArray(t.plotLines) ? t.plotLines : [],
    plotPoints: Array.isArray(t.plotPoints) ? t.plotPoints : [],
    characters: Array.isArray(t.characters) ? t.characters : [],
    items: Array.isArray(t.items) ? t.items : [],
    skills: Array.isArray(t.skills) ? t.skills : [],
    maps: Array.isArray(t.maps) ? t.maps : []
  };
}
function ze(r) {
  var e, n, o, a, s, i;
  return [
    `主线 ${((e = r.plotLines) == null ? void 0 : e.length) ?? 0}`,
    `要点 ${((n = r.plotPoints) == null ? void 0 : n.length) ?? 0}`,
    `角色 ${((o = r.characters) == null ? void 0 : o.length) ?? 0}`,
    `物品 ${((a = r.items) == null ? void 0 : a.length) ?? 0}`,
    `技能 ${((s = r.skills) == null ? void 0 : s.length) ?? 0}`,
    `地图 ${((i = r.maps) == null ? void 0 : i.length) ?? 0}`
  ].join(" / ");
}
function mo(r) {
  const t = (e, n) => (Array.isArray(e) ? e : []).filter((a) => typeof a == "object" && a && String(a[n] || "").trim());
  return {
    plotLines: t(r.plotLines, "name"),
    plotPoints: t(r.plotPoints, "title"),
    characters: t(r.characters, "name"),
    items: t(r.items, "name"),
    skills: t(r.skills, "name"),
    maps: t(r.maps, "name")
  };
}
function Xt(r, t) {
  return t ? {
    plotLines: (r.plotLines ?? []).filter((e, n) => t.plotLines[n]),
    plotPoints: (r.plotPoints ?? []).filter((e, n) => t.plotPoints[n]),
    characters: (r.characters ?? []).filter((e, n) => t.characters[n]),
    items: (r.items ?? []).filter((e, n) => t.items[n]),
    skills: (r.skills ?? []).filter((e, n) => t.skills[n]),
    maps: (r.maps ?? []).filter((e, n) => t.maps[n])
  } : fe(r);
}
function po(r) {
  return fe({
    plotLines: r.plotLines,
    plotPoints: r.plotPoints
  });
}
function ho(r) {
  return fe({
    characters: r.characters,
    items: r.items,
    skills: r.skills
  });
}
function Xe(r, t, e) {
  return Object.assign(new Error(t), { code: r, details: e });
}
function ee(r, t) {
  const e = typeof r == "string" ? r.trim() : "";
  if (!e)
    throw Xe("INVALID_INPUT", `${t} is required`);
  return e;
}
function ft(r, t) {
  if (typeof r != "number" || !Number.isFinite(r))
    throw Xe("INVALID_INPUT", `${t} must be a finite number`);
  return r;
}
function fo(r) {
  return lo[r] ?? uo;
}
function go(r) {
  const t = String(r || "").trim().toLowerCase();
  if (["creative_assets", "creative-assets", "outline-generate", "outline_generate", "outline"].includes(t))
    return "creative_assets";
  if (["chapter", "chapter-generate", "chapter_generate", "continue-writing", "continue_writing"].includes(t))
    return "chapter";
  throw Xe("INVALID_INPUT", `Unsupported prompt preview kind: ${String(r || "")}`);
}
class yo {
  constructor(t, e) {
    G(this, "aiService");
    G(this, "draftStore");
    this.aiService = t, this.draftStore = new so(e);
  }
  logInvokeStart(t, e, n, o) {
    L("INFO", "AutomationService.invoke.start", "Automation invoke start", {
      requestId: n.requestId,
      method: t,
      source: n.source,
      origin: n.origin,
      timeoutMs: o,
      params: ne(e)
    });
  }
  logInvokeSuccess(t, e, n, o) {
    L("INFO", "AutomationService.invoke.success", "Automation invoke success", {
      requestId: e.requestId,
      method: t,
      elapsedMs: Date.now() - n,
      result: ne(o)
    });
  }
  logInvokeError(t, e, n, o) {
    ce("AutomationService.invoke.error", o, {
      requestId: e.requestId,
      method: t,
      elapsedMs: Date.now() - n
    });
  }
  async withTimeout(t, e, n, o) {
    const a = fo(t), s = Date.now();
    this.logInvokeStart(t, e, n, a);
    let i;
    const l = new Promise((v, m) => {
      var C;
      i = setTimeout(() => {
        m(Xe("UPSTREAM_TIMEOUT", `Automation method ${t} timed out after ${a}ms`, {
          method: t,
          timeoutMs: a,
          requestId: n.requestId
        }));
      }, a), (C = i.unref) == null || C.call(i);
    });
    try {
      const v = await Promise.race([o(), l]);
      return i && clearTimeout(i), this.logInvokeSuccess(t, n, s, v), v;
    } catch (v) {
      throw i && clearTimeout(i), this.logInvokeError(t, n, s, v), v;
    }
  }
  buildPromptPreviewPayload(t, e) {
    if (t === "creative_assets") {
      const n = ee(e.novelId, "payload.novelId"), o = ee(e.brief, "payload.brief"), a = Array.isArray(e.targetSections) ? e.targetSections : String(e.kind || "").toLowerCase().includes("outline") ? ["plotLines", "plotPoints"] : void 0;
      return {
        ...e,
        novelId: n,
        brief: o,
        ...a ? { targetSections: a } : {}
      };
    }
    return {
      ...e,
      novelId: ee(e.novelId, "payload.novelId"),
      chapterId: ee(e.chapterId, "payload.chapterId"),
      currentContent: ee(e.currentContent, "payload.currentContent")
    };
  }
  async listDrafts(t) {
    return this.draftStore.list(t);
  }
  async getDraft(t) {
    return this.draftStore.getById(t);
  }
  async getActiveDraft(t) {
    return ee(t == null ? void 0 : t.novelId, "novelId"), this.draftStore.getLatest({
      novelId: t.novelId,
      workspace: t.workspace,
      type: t.type,
      status: "draft"
    });
  }
  async generateCreativeAssetsDraft(t, e, n = "creative-assets") {
    ee(t == null ? void 0 : t.novelId, "novelId"), ee(t == null ? void 0 : t.brief, "brief");
    const o = await this.aiService.generateCreativeAssets(t), a = mo(fe(o.draft));
    return this.draftStore.create({
      workspace: "ai-workbench",
      type: n,
      source: "internal-ai",
      origin: e.origin ?? "unknown",
      novelId: t.novelId,
      status: "draft",
      payload: a,
      selection: ht(a),
      previewSummary: ze(a),
      validation: null
    });
  }
  async createChapterDraftSession(t, e) {
    ee(t == null ? void 0 : t.novelId, "novelId"), ee(t == null ? void 0 : t.chapterId, "chapterId"), ee(t == null ? void 0 : t.currentContent, "currentContent");
    const n = typeof t.presentation == "string" ? t.presentation.trim().toLowerCase() : "", o = n === "silent" || n === "toast" || n === "modal" ? n : void 0, { presentation: a, ...s } = t, i = await this.aiService.executeAction({
      actionId: "chapter.generate",
      payload: s
    }), l = {
      chapterId: t.chapterId,
      baseContent: t.currentContent,
      generatedText: i.text,
      content: `${t.currentContent}${i.text}`,
      presentation: o,
      usedContext: i.usedContext,
      warnings: i.warnings,
      consistency: i.consistency
    };
    return this.draftStore.create({
      workspace: "chapter-editor",
      type: "chapter-draft",
      source: "internal-ai",
      origin: e.origin ?? "unknown",
      novelId: t.novelId,
      chapterId: t.chapterId,
      status: "draft",
      payload: l,
      previewSummary: `章节草稿 ${i.text.length} 字符`
    });
  }
  async updateDraft(t) {
    return ee(t == null ? void 0 : t.draftSessionId, "draftSessionId"), ft(t == null ? void 0 : t.version, "version"), this.draftStore.update(t.draftSessionId, t.version, (e) => {
      var n;
      return {
        ...e,
        payload: t.payload ?? e.payload,
        selection: t.selection ?? e.selection,
        validation: t.validation === void 0 ? e.validation : t.validation,
        previewSummary: e.type === "chapter-draft" ? `章节草稿 ${((n = (t.payload ?? e.payload).generatedText) == null ? void 0 : n.length) ?? 0} 字符` : ze(fe(t.payload ?? e.payload))
      };
    });
  }
  async discardDraft(t) {
    return ee(t == null ? void 0 : t.draftSessionId, "draftSessionId"), ft(t == null ? void 0 : t.version, "version"), this.draftStore.update(t.draftSessionId, t.version, (e) => ({
      ...e,
      status: "discarded"
    }));
  }
  async validateCreativeDraftSession(t) {
    ee(t == null ? void 0 : t.draftSessionId, "draftSessionId");
    const e = await this.draftStore.getById(t.draftSessionId);
    if (!e)
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    if (typeof t.version == "number" && e.version !== t.version)
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    if (e.type !== "creative-assets" && e.type !== "outline-draft")
      throw Object.assign(new Error("Only creative draft sessions can be validated"), { code: "INVALID_INPUT" });
    const n = await this.aiService.validateCreativeAssetsDraft({
      novelId: e.novelId,
      draft: Xt(fe(e.payload), e.selection)
    });
    return {
      session: await this.draftStore.update(e.draftSessionId, e.version, (a) => ({
        ...a,
        validation: n,
        payload: n.normalizedDraft,
        selection: ht(n.normalizedDraft),
        previewSummary: ze(n.normalizedDraft)
      })),
      validation: n
    };
  }
  async commitDraft(t) {
    ee(t == null ? void 0 : t.draftSessionId, "draftSessionId"), ft(t == null ? void 0 : t.version, "version");
    const e = await this.draftStore.getById(t.draftSessionId);
    if (!e)
      throw Object.assign(new Error("Draft session not found"), { code: "NOT_FOUND" });
    if (e.version !== t.version)
      throw Object.assign(new Error("Draft session version conflict"), { code: "VERSION_CONFLICT" });
    if (e.type === "creative-assets" || e.type === "outline-draft") {
      const n = await this.aiService.validateCreativeAssetsDraft({
        novelId: e.novelId,
        draft: Xt(fe(e.payload), e.selection)
      }), o = n.normalizedDraft, a = await this.draftStore.update(e.draftSessionId, e.version, (l) => ({
        ...l,
        payload: o,
        selection: ht(o),
        validation: n,
        previewSummary: ze(o)
      }));
      if (!n.ok)
        return {
          session: a,
          validation: n
        };
      const s = await this.aiService.confirmCreativeAssets({
        novelId: e.novelId,
        draft: o
      });
      return {
        session: await this.draftStore.update(a.draftSessionId, a.version, (l) => ({
          ...l,
          status: s.success ? "committed" : "failed",
          validation: n
        })),
        validation: n,
        confirmResult: s
      };
    }
    if (e.type === "chapter-draft") {
      const n = e.payload, o = await this.aiService.executeAction({
        actionId: "chapter.save",
        payload: {
          chapterId: n.chapterId,
          content: n.content,
          source: "ai_agent"
        }
      });
      return {
        session: await this.draftStore.update(e.draftSessionId, e.version, (s) => ({
          ...s,
          status: "committed"
        })),
        saveResult: o
      };
    }
    throw Object.assign(new Error(`Unsupported draft type: ${e.type}`), { code: "INVALID_INPUT" });
  }
  async previewPrompt(t) {
    const e = go(t == null ? void 0 : t.kind), n = this.buildPromptPreviewPayload(e, (t == null ? void 0 : t.payload) ?? {});
    let o;
    return e === "creative_assets" ? o = await this.aiService.previewCreativeAssetsPrompt(n) : o = await this.aiService.previewContinuePrompt(n), {
      kind: e,
      preview: o
    };
  }
  async applyPartialCreativeDraft(t) {
    ee(t == null ? void 0 : t.novelId, "novelId");
    const e = await this.aiService.validateCreativeAssetsDraft({
      novelId: t.novelId,
      draft: fe(t.draft)
    });
    if (!e.ok)
      return { validation: e };
    const n = await this.aiService.confirmCreativeAssets({
      novelId: t.novelId,
      draft: e.normalizedDraft
    });
    return { validation: e, confirmResult: n };
  }
  async invoke(t, e, n) {
    return this.withTimeout(t, e, n, async () => {
      switch (t) {
        case "draft.list":
          return this.listDrafts(e);
        case "draft.get":
          return this.getDraft(ee(e == null ? void 0 : e.draftSessionId, "draftSessionId"));
        case "draft.get_active":
          return this.getActiveDraft(e);
        case "draft.update":
          return this.updateDraft(e);
        case "draft.commit":
          return this.commitDraft(e);
        case "draft.discard":
          return this.discardDraft(e);
        case "creative_assets.generate_draft":
          return this.generateCreativeAssetsDraft(e, n, "creative-assets");
        case "outline.generate_draft":
          return this.generateCreativeAssetsDraft({
            ...e,
            targetSections: ["plotLines", "plotPoints"]
          }, n, "outline-draft");
        case "chapter.generate_draft":
          return this.createChapterDraftSession(e, n);
        case "creative_assets.validate_draft":
          return this.validateCreativeDraftSession(e);
        case "outline.write":
          return this.applyPartialCreativeDraft({
            novelId: ee(e == null ? void 0 : e.novelId, "novelId"),
            draft: po(e)
          });
        case "character.create_batch":
          return this.applyPartialCreativeDraft({
            novelId: ee(e == null ? void 0 : e.novelId, "novelId"),
            draft: ho(e)
          });
        case "story_patch.apply":
          return this.applyPartialCreativeDraft({
            novelId: ee(e == null ? void 0 : e.novelId, "novelId"),
            draft: fe(e == null ? void 0 : e.draft)
          });
        case "prompt.preview":
          return this.previewPrompt(e);
        default:
          return this.aiService.executeAction({
            actionId: t,
            payload: e
          });
      }
    });
  }
}
class vo {
  constructor(t, e, n) {
    G(this, "automationService");
    G(this, "getUserDataPath");
    G(this, "onDataChanged");
    G(this, "server", null);
    G(this, "runtime", null);
    this.automationService = t, this.getUserDataPath = e, this.onDataChanged = n;
  }
  notifyDataChanged(t) {
    var n;
    (/* @__PURE__ */ new Set([
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
    ])).has(t) && ((n = this.onDataChanged) == null || n.call(this, t));
  }
  getAutomationDir() {
    return k.join(this.getUserDataPath(), "automation");
  }
  getRuntimePath() {
    return k.join(this.getAutomationDir(), "runtime.json");
  }
  async writeRuntime() {
    this.runtime && (await be.mkdir(this.getAutomationDir(), { recursive: !0 }), await be.writeFile(this.getRuntimePath(), JSON.stringify(this.runtime, null, 2), "utf8"));
  }
  async removeRuntime() {
    try {
      await be.unlink(this.getRuntimePath());
    } catch (t) {
      if ((t == null ? void 0 : t.code) !== "ENOENT")
        throw t;
    }
  }
  sendJson(t, e, n) {
    const o = JSON.stringify(n);
    t.writeHead(e, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(o, "utf8")
    }), t.end(o);
  }
  async readJson(t) {
    const e = [];
    for await (const o of t)
      e.push(Buffer.isBuffer(o) ? o : Buffer.from(o));
    const n = Buffer.concat(e).toString("utf8");
    return n ? JSON.parse(n) : {};
  }
  normalizeError(t) {
    return {
      code: (t == null ? void 0 : t.code) || "INTERNAL_ERROR",
      message: (t == null ? void 0 : t.message) || "Internal automation error",
      details: t == null ? void 0 : t.details
    };
  }
  isAuthorized(t) {
    return this.runtime ? (t.headers.authorization || "") === `Bearer ${this.runtime.token}` : !1;
  }
  async start() {
    if (this.server)
      return;
    this.runtime = {
      version: 1,
      port: 0,
      token: Oe(),
      pid: process.pid,
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    }, this.server = dr.createServer(async (e, n) => {
      try {
        if (e.url === "/health") {
          this.sendJson(n, 200, { ok: !0, code: "OK", message: "healthy", data: { pid: process.pid } });
          return;
        }
        if (!this.isAuthorized(e)) {
          this.sendJson(n, 401, { ok: !1, code: "UNAUTHORIZED", message: "Unauthorized" });
          return;
        }
        if (e.method === "POST" && e.url === "/invoke") {
          const o = await this.readJson(e), a = typeof o.requestId == "string" && o.requestId.trim() ? o.requestId.trim() : Oe(), s = Date.now();
          L("INFO", "AutomationServer.invoke.start", "Automation HTTP invoke start", {
            requestId: a,
            method: o.method,
            origin: o.origin ?? "mcp-bridge",
            params: ne(o.params)
          });
          const i = await this.automationService.invoke(o.method, o.params, {
            source: "http",
            origin: o.origin ?? "mcp-bridge",
            requestId: a
          });
          L("INFO", "AutomationServer.invoke.success", "Automation HTTP invoke success", {
            requestId: a,
            method: o.method,
            elapsedMs: Date.now() - s,
            result: ne(i)
          }), this.notifyDataChanged(String(o.method || "")), this.sendJson(n, 200, { ok: !0, code: "OK", message: "ok", data: i });
          return;
        }
        this.sendJson(n, 404, { ok: !1, code: "NOT_FOUND", message: "Not found" });
      } catch (o) {
        const a = this.normalizeError(o);
        ce("AutomationServer.invoke.error", o, {
          url: e.url,
          method: e.method
        }), this.sendJson(n, 500, {
          ok: !1,
          code: a.code,
          message: a.message,
          data: a.details
        });
      }
    }), await new Promise((e, n) => {
      this.server.once("error", n), this.server.listen(0, "127.0.0.1", () => e());
    });
    const t = this.server.address();
    if (!t || typeof t == "string")
      throw new Error("Failed to resolve automation server port");
    this.runtime.port = t.port, await this.writeRuntime();
  }
  async stop() {
    await this.removeRuntime(), this.server && (await new Promise((t, e) => {
      this.server.close((n) => {
        n ? e(n) : t();
      });
    }), this.server = null, this.runtime = null);
  }
}
const Yt = "http://localhost:8080/api/sync";
class wo {
  // Get the global sync cursor
  async getCursor() {
    const t = await u.syncState.findUnique({ where: { id: "global" } });
    return t ? Number(t.cursor) : 0;
  }
  async setCursor(t) {
    await u.syncState.upsert({
      where: { id: "global" },
      create: { id: "global", cursor: BigInt(t) },
      update: { cursor: BigInt(t) }
    });
  }
  async pull() {
    var e, n;
    const t = await this.getCursor();
    console.log("[Sync] Pulling from cursor:", t);
    try {
      const o = await fetch(`${Yt}/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastSyncCursor: t })
      });
      if (!o.ok)
        throw new Error(`Pull failed: ${o.statusText}`);
      const a = await o.json(), { newSyncCursor: s, data: i } = a;
      return await u.$transaction(async (l) => {
        var v, m, C;
        if ((v = i.novels) != null && v.length)
          for (const I of i.novels)
            await l.novel.upsert({
              where: { id: I.id },
              create: { ...I, updatedAt: new Date(I.updatedAt), createdAt: new Date(I.createdAt) },
              update: { ...I, updatedAt: new Date(I.updatedAt), createdAt: new Date(I.createdAt) }
            });
        if ((m = i.volumes) != null && m.length)
          for (const I of i.volumes)
            await l.volume.upsert({
              where: { id: I.id },
              create: { ...I, updatedAt: new Date(I.updatedAt), createdAt: new Date(I.createdAt) },
              update: { ...I, updatedAt: new Date(I.updatedAt), createdAt: new Date(I.createdAt) }
            });
        if ((C = i.chapters) != null && C.length)
          for (const I of i.chapters)
            await l.chapter.upsert({
              where: { id: I.id },
              create: { ...I, updatedAt: new Date(I.updatedAt), createdAt: new Date(I.createdAt) },
              update: { ...I, updatedAt: new Date(I.updatedAt), createdAt: new Date(I.createdAt) }
            });
      }), await this.setCursor(s), console.log("[Sync] Pull complete. New cursor:", s), { success: !0, count: (((e = i.novels) == null ? void 0 : e.length) || 0) + (((n = i.chapters) == null ? void 0 : n.length) || 0) };
    } catch (o) {
      throw console.error("[Sync] Pull error:", o), o;
    }
  }
  async push() {
    const t = await this.getCursor(), e = {
      novels: await u.novel.findMany({ where: { updatedAt: { gt: new Date(t) } } }),
      volumes: await u.volume.findMany({ where: { updatedAt: { gt: new Date(t) } } }),
      chapters: await u.chapter.findMany({ where: { updatedAt: { gt: new Date(t) } } })
    };
    if (e.novels.length === 0 && e.volumes.length === 0 && e.chapters.length === 0)
      return { success: !0, count: 0 };
    console.log("[Sync] Pushing changes...");
    const n = JSON.stringify({
      lastSyncCursor: t,
      changes: e
    }, (a, s) => typeof s == "bigint" ? s.toString() : s), o = await fetch(`${Yt}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: n
    });
    if (!o.ok)
      throw new Error(`Push failed: ${o.statusText}`);
    return console.log("[Sync] Push success"), await o.json();
  }
}
function Io(r) {
  return r && r.__esModule && Object.prototype.hasOwnProperty.call(r, "default") ? r.default : r;
}
var ke = { exports: {} }, br = {
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
}, Ye = {};
(function(r) {
  const t = {
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
  function e(n) {
    return function(...o) {
      return o.length && (n = n.replace(/\{(\d)\}/g, (a, s) => o[s] || "")), new Error("ADM-ZIP: " + n);
    };
  }
  for (const n of Object.keys(t))
    r[n] = e(t[n]);
})(Ye);
const So = N, re = pe, Qt = br, Co = Ye, Eo = typeof process == "object" && process.platform === "win32", er = (r) => typeof r == "object" && r !== null, Tr = new Uint32Array(256).map((r, t) => {
  for (let e = 0; e < 8; e++)
    t & 1 ? t = 3988292384 ^ t >>> 1 : t >>>= 1;
  return t >>> 0;
});
function Y(r) {
  this.sep = re.sep, this.fs = So, er(r) && er(r.fs) && typeof r.fs.statSync == "function" && (this.fs = r.fs);
}
var _o = Y;
Y.prototype.makeDir = function(r) {
  const t = this;
  function e(n) {
    let o = n.split(t.sep)[0];
    n.split(t.sep).forEach(function(a) {
      if (!(!a || a.substr(-1, 1) === ":")) {
        o += t.sep + a;
        var s;
        try {
          s = t.fs.statSync(o);
        } catch {
          t.fs.mkdirSync(o);
        }
        if (s && s.isFile())
          throw Co.FILE_IN_THE_WAY(`"${o}"`);
      }
    });
  }
  e(r);
};
Y.prototype.writeFileTo = function(r, t, e, n) {
  const o = this;
  if (o.fs.existsSync(r)) {
    if (!e)
      return !1;
    var a = o.fs.statSync(r);
    if (a.isDirectory())
      return !1;
  }
  var s = re.dirname(r);
  o.fs.existsSync(s) || o.makeDir(s);
  var i;
  try {
    i = o.fs.openSync(r, "w", 438);
  } catch {
    o.fs.chmodSync(r, 438), i = o.fs.openSync(r, "w", 438);
  }
  if (i)
    try {
      o.fs.writeSync(i, t, 0, t.length, 0);
    } finally {
      o.fs.closeSync(i);
    }
  return o.fs.chmodSync(r, n || 438), !0;
};
Y.prototype.writeFileToAsync = function(r, t, e, n, o) {
  typeof n == "function" && (o = n, n = void 0);
  const a = this;
  a.fs.exists(r, function(s) {
    if (s && !e)
      return o(!1);
    a.fs.stat(r, function(i, l) {
      if (s && l.isDirectory())
        return o(!1);
      var v = re.dirname(r);
      a.fs.exists(v, function(m) {
        m || a.makeDir(v), a.fs.open(r, "w", 438, function(C, I) {
          C ? a.fs.chmod(r, 438, function() {
            a.fs.open(r, "w", 438, function(g, p) {
              a.fs.write(p, t, 0, t.length, 0, function() {
                a.fs.close(p, function() {
                  a.fs.chmod(r, n || 438, function() {
                    o(!0);
                  });
                });
              });
            });
          }) : I ? a.fs.write(I, t, 0, t.length, 0, function() {
            a.fs.close(I, function() {
              a.fs.chmod(r, n || 438, function() {
                o(!0);
              });
            });
          }) : a.fs.chmod(r, n || 438, function() {
            o(!0);
          });
        });
      });
    });
  });
};
Y.prototype.findFiles = function(r) {
  const t = this;
  function e(n, o, a) {
    let s = [];
    return t.fs.readdirSync(n).forEach(function(i) {
      const l = re.join(n, i), v = t.fs.statSync(l);
      s.push(re.normalize(l) + (v.isDirectory() ? t.sep : "")), v.isDirectory() && a && (s = s.concat(e(l, o, a)));
    }), s;
  }
  return e(r, void 0, !0);
};
Y.prototype.findFilesAsync = function(r, t) {
  const e = this;
  let n = [];
  e.fs.readdir(r, function(o, a) {
    if (o)
      return t(o);
    let s = a.length;
    if (!s)
      return t(null, n);
    a.forEach(function(i) {
      i = re.join(r, i), e.fs.stat(i, function(l, v) {
        if (l)
          return t(l);
        v && (n.push(re.normalize(i) + (v.isDirectory() ? e.sep : "")), v.isDirectory() ? e.findFilesAsync(i, function(m, C) {
          if (m)
            return t(m);
          n = n.concat(C), --s || t(null, n);
        }) : --s || t(null, n));
      });
    });
  });
};
Y.prototype.getAttributes = function() {
};
Y.prototype.setAttributes = function() {
};
Y.crc32update = function(r, t) {
  return Tr[(r ^ t) & 255] ^ r >>> 8;
};
Y.crc32 = function(r) {
  typeof r == "string" && (r = Buffer.from(r, "utf8"));
  let t = r.length, e = -1;
  for (let n = 0; n < t; )
    e = Y.crc32update(e, r[n++]);
  return ~e >>> 0;
};
Y.methodToString = function(r) {
  switch (r) {
    case Qt.STORED:
      return "STORED (" + r + ")";
    case Qt.DEFLATED:
      return "DEFLATED (" + r + ")";
    default:
      return "UNSUPPORTED (" + r + ")";
  }
};
Y.canonical = function(r) {
  if (!r)
    return "";
  const t = re.posix.normalize("/" + r.split("\\").join("/"));
  return re.join(".", t);
};
Y.zipnamefix = function(r) {
  if (!r)
    return "";
  const t = re.posix.normalize("/" + r.split("\\").join("/"));
  return re.posix.join(".", t);
};
Y.findLast = function(r, t) {
  if (!Array.isArray(r))
    throw new TypeError("arr is not array");
  const e = r.length >>> 0;
  for (let n = e - 1; n >= 0; n--)
    if (t(r[n], n, r))
      return r[n];
};
Y.sanitize = function(r, t) {
  r = re.resolve(re.normalize(r));
  for (var e = t.split("/"), n = 0, o = e.length; n < o; n++) {
    var a = re.normalize(re.join(r, e.slice(n, o).join(re.sep)));
    if (a.indexOf(r) === 0)
      return a;
  }
  return re.normalize(re.join(r, re.basename(t)));
};
Y.toBuffer = function(t, e) {
  return Buffer.isBuffer(t) ? t : t instanceof Uint8Array ? Buffer.from(t) : typeof t == "string" ? e(t) : Buffer.alloc(0);
};
Y.readBigUInt64LE = function(r, t) {
  var e = Buffer.from(r.slice(t, t + 8));
  return e.swap64(), parseInt(`0x${e.toString("hex")}`);
};
Y.fromDOS2Date = function(r) {
  return new Date((r >> 25 & 127) + 1980, Math.max((r >> 21 & 15) - 1, 0), Math.max(r >> 16 & 31, 1), r >> 11 & 31, r >> 5 & 63, (r & 31) << 1);
};
Y.fromDate2DOS = function(r) {
  let t = 0, e = 0;
  return r.getFullYear() > 1979 && (t = (r.getFullYear() - 1980 & 127) << 9 | r.getMonth() + 1 << 5 | r.getDate(), e = r.getHours() << 11 | r.getMinutes() << 5 | r.getSeconds() >> 1), t << 16 | e;
};
Y.isWin = Eo;
Y.crcTable = Tr;
const Ao = pe;
var bo = function(r, { fs: t }) {
  var e = r || "", n = a(), o = null;
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
  return e && t.existsSync(e) ? (o = t.statSync(e), n.directory = o.isDirectory(), n.mtime = o.mtime, n.atime = o.atime, n.executable = (73 & o.mode) !== 0, n.readonly = (128 & o.mode) === 0, n.hidden = Ao.basename(e)[0] === ".") : console.warn("Invalid path: " + e), {
    get directory() {
      return n.directory;
    },
    get readOnly() {
      return n.readonly;
    },
    get hidden() {
      return n.hidden;
    },
    get mtime() {
      return n.mtime;
    },
    get atime() {
      return n.atime;
    },
    get executable() {
      return n.executable;
    },
    decodeAttributes: function() {
    },
    encodeAttributes: function() {
    },
    toJSON: function() {
      return {
        path: e,
        isDirectory: n.directory,
        isReadOnly: n.readonly,
        isHidden: n.hidden,
        isExecutable: n.executable,
        mTime: n.mtime,
        aTime: n.atime
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
}, To = {
  efs: !0,
  encode: (r) => Buffer.from(r, "utf8"),
  decode: (r) => r.toString("utf8")
};
ke.exports = _o;
ke.exports.Constants = br;
ke.exports.Errors = Ye;
ke.exports.FileAttr = bo;
ke.exports.decoder = To;
var Ue = ke.exports, Qe = {}, ve = Ue, T = ve.Constants, ko = function() {
  var r = 20, t = 10, e = 0, n = 0, o = 0, a = 0, s = 0, i = 0, l = 0, v = 0, m = 0, C = 0, I = 0, g = 0, p = 0;
  r |= ve.isWin ? 2560 : 768, e |= T.FLG_EFS;
  const y = {
    extraLen: 0
  }, f = (c) => Math.max(0, c) >>> 0, h = (c) => Math.max(0, c) & 255;
  return o = ve.fromDate2DOS(/* @__PURE__ */ new Date()), {
    get made() {
      return r;
    },
    set made(c) {
      r = c;
    },
    get version() {
      return t;
    },
    set version(c) {
      t = c;
    },
    get flags() {
      return e;
    },
    set flags(c) {
      e = c;
    },
    get flags_efs() {
      return (e & T.FLG_EFS) > 0;
    },
    set flags_efs(c) {
      c ? e |= T.FLG_EFS : e &= ~T.FLG_EFS;
    },
    get flags_desc() {
      return (e & T.FLG_DESC) > 0;
    },
    set flags_desc(c) {
      c ? e |= T.FLG_DESC : e &= ~T.FLG_DESC;
    },
    get method() {
      return n;
    },
    set method(c) {
      switch (c) {
        case T.STORED:
          this.version = 10;
        case T.DEFLATED:
        default:
          this.version = 20;
      }
      n = c;
    },
    get time() {
      return ve.fromDOS2Date(this.timeval);
    },
    set time(c) {
      this.timeval = ve.fromDate2DOS(c);
    },
    get timeval() {
      return o;
    },
    set timeval(c) {
      o = f(c);
    },
    get timeHighByte() {
      return h(o >>> 8);
    },
    get crc() {
      return a;
    },
    set crc(c) {
      a = f(c);
    },
    get compressedSize() {
      return s;
    },
    set compressedSize(c) {
      s = f(c);
    },
    get size() {
      return i;
    },
    set size(c) {
      i = f(c);
    },
    get fileNameLength() {
      return l;
    },
    set fileNameLength(c) {
      l = c;
    },
    get extraLength() {
      return v;
    },
    set extraLength(c) {
      v = c;
    },
    get extraLocalLength() {
      return y.extraLen;
    },
    set extraLocalLength(c) {
      y.extraLen = c;
    },
    get commentLength() {
      return m;
    },
    set commentLength(c) {
      m = c;
    },
    get diskNumStart() {
      return C;
    },
    set diskNumStart(c) {
      C = f(c);
    },
    get inAttr() {
      return I;
    },
    set inAttr(c) {
      I = f(c);
    },
    get attr() {
      return g;
    },
    set attr(c) {
      g = f(c);
    },
    // get Unix file permissions
    get fileAttr() {
      return (g || 0) >> 16 & 4095;
    },
    get offset() {
      return p;
    },
    set offset(c) {
      p = f(c);
    },
    get encrypted() {
      return (e & T.FLG_ENC) === T.FLG_ENC;
    },
    get centralHeaderSize() {
      return T.CENHDR + l + v + m;
    },
    get realDataOffset() {
      return p + T.LOCHDR + y.fnameLen + y.extraLen;
    },
    get localHeader() {
      return y;
    },
    loadLocalHeaderFromBinary: function(c) {
      var d = c.slice(p, p + T.LOCHDR);
      if (d.readUInt32LE(0) !== T.LOCSIG)
        throw ve.Errors.INVALID_LOC();
      y.version = d.readUInt16LE(T.LOCVER), y.flags = d.readUInt16LE(T.LOCFLG), y.method = d.readUInt16LE(T.LOCHOW), y.time = d.readUInt32LE(T.LOCTIM), y.crc = d.readUInt32LE(T.LOCCRC), y.compressedSize = d.readUInt32LE(T.LOCSIZ), y.size = d.readUInt32LE(T.LOCLEN), y.fnameLen = d.readUInt16LE(T.LOCNAM), y.extraLen = d.readUInt16LE(T.LOCEXT);
      const w = p + T.LOCHDR + y.fnameLen, S = w + y.extraLen;
      return c.slice(w, S);
    },
    loadFromBinary: function(c) {
      if (c.length !== T.CENHDR || c.readUInt32LE(0) !== T.CENSIG)
        throw ve.Errors.INVALID_CEN();
      r = c.readUInt16LE(T.CENVEM), t = c.readUInt16LE(T.CENVER), e = c.readUInt16LE(T.CENFLG), n = c.readUInt16LE(T.CENHOW), o = c.readUInt32LE(T.CENTIM), a = c.readUInt32LE(T.CENCRC), s = c.readUInt32LE(T.CENSIZ), i = c.readUInt32LE(T.CENLEN), l = c.readUInt16LE(T.CENNAM), v = c.readUInt16LE(T.CENEXT), m = c.readUInt16LE(T.CENCOM), C = c.readUInt16LE(T.CENDSK), I = c.readUInt16LE(T.CENATT), g = c.readUInt32LE(T.CENATX), p = c.readUInt32LE(T.CENOFF);
    },
    localHeaderToBinary: function() {
      var c = Buffer.alloc(T.LOCHDR);
      return c.writeUInt32LE(T.LOCSIG, 0), c.writeUInt16LE(t, T.LOCVER), c.writeUInt16LE(e, T.LOCFLG), c.writeUInt16LE(n, T.LOCHOW), c.writeUInt32LE(o, T.LOCTIM), c.writeUInt32LE(a, T.LOCCRC), c.writeUInt32LE(s, T.LOCSIZ), c.writeUInt32LE(i, T.LOCLEN), c.writeUInt16LE(l, T.LOCNAM), c.writeUInt16LE(y.extraLen, T.LOCEXT), c;
    },
    centralHeaderToBinary: function() {
      var c = Buffer.alloc(T.CENHDR + l + v + m);
      return c.writeUInt32LE(T.CENSIG, 0), c.writeUInt16LE(r, T.CENVEM), c.writeUInt16LE(t, T.CENVER), c.writeUInt16LE(e, T.CENFLG), c.writeUInt16LE(n, T.CENHOW), c.writeUInt32LE(o, T.CENTIM), c.writeUInt32LE(a, T.CENCRC), c.writeUInt32LE(s, T.CENSIZ), c.writeUInt32LE(i, T.CENLEN), c.writeUInt16LE(l, T.CENNAM), c.writeUInt16LE(v, T.CENEXT), c.writeUInt16LE(m, T.CENCOM), c.writeUInt16LE(C, T.CENDSK), c.writeUInt16LE(I, T.CENATT), c.writeUInt32LE(g, T.CENATX), c.writeUInt32LE(p, T.CENOFF), c;
    },
    toJSON: function() {
      const c = function(d) {
        return d + " bytes";
      };
      return {
        made: r,
        version: t,
        flags: e,
        method: ve.methodToString(n),
        time: this.time,
        crc: "0x" + a.toString(16).toUpperCase(),
        compressedSize: c(s),
        size: c(i),
        fileNameLength: c(l),
        extraLength: c(v),
        commentLength: c(m),
        diskNumStart: C,
        inAttr: I,
        attr: g,
        offset: p,
        centralHeaderSize: c(T.CENHDR + l + v + m)
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
}, Ae = Ue, J = Ae.Constants, Do = function() {
  var r = 0, t = 0, e = 0, n = 0, o = 0;
  return {
    get diskEntries() {
      return r;
    },
    set diskEntries(a) {
      r = t = a;
    },
    get totalEntries() {
      return t;
    },
    set totalEntries(a) {
      t = r = a;
    },
    get size() {
      return e;
    },
    set size(a) {
      e = a;
    },
    get offset() {
      return n;
    },
    set offset(a) {
      n = a;
    },
    get commentLength() {
      return o;
    },
    set commentLength(a) {
      o = a;
    },
    get mainHeaderSize() {
      return J.ENDHDR + o;
    },
    loadFromBinary: function(a) {
      if ((a.length !== J.ENDHDR || a.readUInt32LE(0) !== J.ENDSIG) && (a.length < J.ZIP64HDR || a.readUInt32LE(0) !== J.ZIP64SIG))
        throw Ae.Errors.INVALID_END();
      a.readUInt32LE(0) === J.ENDSIG ? (r = a.readUInt16LE(J.ENDSUB), t = a.readUInt16LE(J.ENDTOT), e = a.readUInt32LE(J.ENDSIZ), n = a.readUInt32LE(J.ENDOFF), o = a.readUInt16LE(J.ENDCOM)) : (r = Ae.readBigUInt64LE(a, J.ZIP64SUB), t = Ae.readBigUInt64LE(a, J.ZIP64TOT), e = Ae.readBigUInt64LE(a, J.ZIP64SIZE), n = Ae.readBigUInt64LE(a, J.ZIP64OFF), o = 0);
    },
    toBinary: function() {
      var a = Buffer.alloc(J.ENDHDR + o);
      return a.writeUInt32LE(J.ENDSIG, 0), a.writeUInt32LE(0, 4), a.writeUInt16LE(r, J.ENDSUB), a.writeUInt16LE(t, J.ENDTOT), a.writeUInt32LE(e, J.ENDSIZ), a.writeUInt32LE(n, J.ENDOFF), a.writeUInt16LE(o, J.ENDCOM), a.fill(" ", J.ENDHDR), a;
    },
    toJSON: function() {
      const a = function(s, i) {
        let l = s.toString(16).toUpperCase();
        for (; l.length < i; )
          l = "0" + l;
        return "0x" + l;
      };
      return {
        diskEntries: r,
        totalEntries: t,
        size: e + " bytes",
        offset: a(n, 4),
        commentLength: o
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
Qe.EntryHeader = ko;
Qe.MainHeader = Do;
var et = {}, No = function(r) {
  var t = ur, e = { chunkSize: (parseInt(r.length / 1024) + 1) * 1024 };
  return {
    deflate: function() {
      return t.deflateRawSync(r, e);
    },
    deflateAsync: function(n) {
      var o = t.createDeflateRaw(e), a = [], s = 0;
      o.on("data", function(i) {
        a.push(i), s += i.length;
      }), o.on("end", function() {
        var i = Buffer.alloc(s), l = 0;
        i.fill(0);
        for (var v = 0; v < a.length; v++) {
          var m = a[v];
          m.copy(i, l), l += m.length;
        }
        n && n(i);
      }), o.end(r);
    }
  };
};
const xo = +(process.versions ? process.versions.node : "").split(".")[0] || 0;
var Po = function(r, t) {
  var e = ur;
  const n = xo >= 15 && t > 0 ? { maxOutputLength: t } : {};
  return {
    inflate: function() {
      return e.inflateRawSync(r, n);
    },
    inflateAsync: function(o) {
      var a = e.createInflateRaw(n), s = [], i = 0;
      a.on("data", function(l) {
        s.push(l), i += l.length;
      }), a.on("end", function() {
        var l = Buffer.alloc(i), v = 0;
        l.fill(0);
        for (var m = 0; m < s.length; m++) {
          var C = s[m];
          C.copy(l, v), v += C.length;
        }
        o && o(l);
      }), a.end(r);
    }
  };
};
const { randomFillSync: tr } = _e, Lo = Ye, Oo = new Uint32Array(256).map((r, t) => {
  for (let e = 0; e < 8; e++)
    t & 1 ? t = t >>> 1 ^ 3988292384 : t >>>= 1;
  return t >>> 0;
}), kr = (r, t) => Math.imul(r, t) >>> 0, rr = (r, t) => Oo[(r ^ t) & 255] ^ r >>> 8, $e = () => typeof tr == "function" ? tr(Buffer.alloc(12)) : $e.node();
$e.node = () => {
  const r = Buffer.alloc(12), t = r.length;
  for (let e = 0; e < t; e++)
    r[e] = Math.random() * 256 & 255;
  return r;
};
const Ve = {
  genSalt: $e
};
function tt(r) {
  const t = Buffer.isBuffer(r) ? r : Buffer.from(r);
  this.keys = new Uint32Array([305419896, 591751049, 878082192]);
  for (let e = 0; e < t.length; e++)
    this.updateKeys(t[e]);
}
tt.prototype.updateKeys = function(r) {
  const t = this.keys;
  return t[0] = rr(t[0], r), t[1] += t[0] & 255, t[1] = kr(t[1], 134775813) + 1, t[2] = rr(t[2], t[1] >>> 24), r;
};
tt.prototype.next = function() {
  const r = (this.keys[2] | 2) >>> 0;
  return kr(r, r ^ 1) >> 8 & 255;
};
function Mo(r) {
  const t = new tt(r);
  return function(e) {
    const n = Buffer.alloc(e.length);
    let o = 0;
    for (let a of e)
      n[o++] = t.updateKeys(a ^ t.next());
    return n;
  };
}
function $o(r) {
  const t = new tt(r);
  return function(e, n, o = 0) {
    n || (n = Buffer.alloc(e.length));
    for (let a of e) {
      const s = t.next();
      n[o++] = a ^ s, t.updateKeys(a);
    }
    return n;
  };
}
function Ro(r, t, e) {
  if (!r || !Buffer.isBuffer(r) || r.length < 12)
    return Buffer.alloc(0);
  const n = Mo(e), o = n(r.slice(0, 12)), a = (t.flags & 8) === 8 ? t.timeHighByte : t.crc >>> 24;
  if (o[11] !== a)
    throw Lo.WRONG_PASSWORD();
  return n(r.slice(12));
}
function Uo(r) {
  Buffer.isBuffer(r) && r.length >= 12 ? Ve.genSalt = function() {
    return r.slice(0, 12);
  } : r === "node" ? Ve.genSalt = $e.node : Ve.genSalt = $e;
}
function Fo(r, t, e, n = !1) {
  r == null && (r = Buffer.alloc(0)), Buffer.isBuffer(r) || (r = Buffer.from(r.toString()));
  const o = $o(e), a = Ve.genSalt();
  a[11] = t.crc >>> 24 & 255, n && (a[10] = t.crc >>> 16 & 255);
  const s = Buffer.alloc(r.length + 12);
  return o(a, s), o(r, s, 12);
}
var Bo = { decrypt: Ro, encrypt: Fo, _salter: Uo };
et.Deflater = No;
et.Inflater = Po;
et.ZipCrypto = Bo;
var V = Ue, jo = Qe, K = V.Constants, gt = et, Dr = function(r, t) {
  var e = new jo.EntryHeader(), n = Buffer.alloc(0), o = Buffer.alloc(0), a = !1, s = null, i = Buffer.alloc(0), l = Buffer.alloc(0), v = !0;
  const m = r, C = typeof m.decoder == "object" ? m.decoder : V.decoder;
  v = C.hasOwnProperty("efs") ? C.efs : !1;
  function I() {
    return !t || !(t instanceof Uint8Array) ? Buffer.alloc(0) : (l = e.loadLocalHeaderFromBinary(t), t.slice(e.realDataOffset, e.realDataOffset + e.compressedSize));
  }
  function g(d) {
    if (e.flags_desc) {
      const w = {}, S = e.realDataOffset + e.compressedSize;
      if (t.readUInt32LE(S) == K.LOCSIG || t.readUInt32LE(S) == K.CENSIG)
        throw V.Errors.DESCRIPTOR_NOT_EXIST();
      if (t.readUInt32LE(S) == K.EXTSIG)
        w.crc = t.readUInt32LE(S + K.EXTCRC), w.compressedSize = t.readUInt32LE(S + K.EXTSIZ), w.size = t.readUInt32LE(S + K.EXTLEN);
      else if (t.readUInt16LE(S + 12) === 19280)
        w.crc = t.readUInt32LE(S + K.EXTCRC - 4), w.compressedSize = t.readUInt32LE(S + K.EXTSIZ - 4), w.size = t.readUInt32LE(S + K.EXTLEN - 4);
      else
        throw V.Errors.DESCRIPTOR_UNKNOWN();
      if (w.compressedSize !== e.compressedSize || w.size !== e.size || w.crc !== e.crc)
        throw V.Errors.DESCRIPTOR_FAULTY();
      if (V.crc32(d) !== w.crc)
        return !1;
    } else if (V.crc32(d) !== e.localHeader.crc)
      return !1;
    return !0;
  }
  function p(d, w, S) {
    if (typeof w > "u" && typeof d == "string" && (S = d, d = void 0), a)
      return d && w && w(Buffer.alloc(0), V.Errors.DIRECTORY_CONTENT_ERROR()), Buffer.alloc(0);
    var _ = I();
    if (_.length === 0)
      return d && w && w(_), _;
    if (e.encrypted) {
      if (typeof S != "string" && !Buffer.isBuffer(S))
        throw V.Errors.INVALID_PASS_PARAM();
      _ = gt.ZipCrypto.decrypt(_, e, S);
    }
    var A = Buffer.alloc(e.size);
    switch (e.method) {
      case V.Constants.STORED:
        if (_.copy(A), g(A))
          return d && w && w(A), A;
        throw d && w && w(A, V.Errors.BAD_CRC()), V.Errors.BAD_CRC();
      case V.Constants.DEFLATED:
        var x = new gt.Inflater(_, e.size);
        if (d)
          x.inflateAsync(function(P) {
            P.copy(P, 0), w && (g(P) ? w(P) : w(P, V.Errors.BAD_CRC()));
          });
        else {
          if (x.inflate(A).copy(A, 0), !g(A))
            throw V.Errors.BAD_CRC(`"${C.decode(n)}"`);
          return A;
        }
        break;
      default:
        throw d && w && w(Buffer.alloc(0), V.Errors.UNKNOWN_METHOD()), V.Errors.UNKNOWN_METHOD();
    }
  }
  function y(d, w) {
    if ((!s || !s.length) && Buffer.isBuffer(t))
      return d && w && w(I()), I();
    if (s.length && !a) {
      var S;
      switch (e.method) {
        case V.Constants.STORED:
          return e.compressedSize = e.size, S = Buffer.alloc(s.length), s.copy(S), d && w && w(S), S;
        default:
        case V.Constants.DEFLATED:
          var _ = new gt.Deflater(s);
          if (d)
            _.deflateAsync(function(x) {
              S = Buffer.alloc(x.length), e.compressedSize = x.length, x.copy(S), w && w(S);
            });
          else {
            var A = _.deflate();
            return e.compressedSize = A.length, A;
          }
          _ = null;
          break;
      }
    } else if (d && w)
      w(Buffer.alloc(0));
    else
      return Buffer.alloc(0);
  }
  function f(d, w) {
    return (d.readUInt32LE(w + 4) << 4) + d.readUInt32LE(w);
  }
  function h(d) {
    try {
      for (var w = 0, S, _, A; w + 4 < d.length; )
        S = d.readUInt16LE(w), w += 2, _ = d.readUInt16LE(w), w += 2, A = d.slice(w, w + _), w += _, K.ID_ZIP64 === S && c(A);
    } catch {
      throw V.Errors.EXTRA_FIELD_PARSE_ERROR();
    }
  }
  function c(d) {
    var w, S, _, A;
    d.length >= K.EF_ZIP64_SCOMP && (w = f(d, K.EF_ZIP64_SUNCOMP), e.size === K.EF_ZIP64_OR_32 && (e.size = w)), d.length >= K.EF_ZIP64_RHO && (S = f(d, K.EF_ZIP64_SCOMP), e.compressedSize === K.EF_ZIP64_OR_32 && (e.compressedSize = S)), d.length >= K.EF_ZIP64_DSN && (_ = f(d, K.EF_ZIP64_RHO), e.offset === K.EF_ZIP64_OR_32 && (e.offset = _)), d.length >= K.EF_ZIP64_DSN + 4 && (A = d.readUInt32LE(K.EF_ZIP64_DSN), e.diskNumStart === K.EF_ZIP64_OR_16 && (e.diskNumStart = A));
  }
  return {
    get entryName() {
      return C.decode(n);
    },
    get rawEntryName() {
      return n;
    },
    set entryName(d) {
      n = V.toBuffer(d, C.encode);
      var w = n[n.length - 1];
      a = w === 47 || w === 92, e.fileNameLength = n.length;
    },
    get efs() {
      return typeof v == "function" ? v(this.entryName) : v;
    },
    get extra() {
      return i;
    },
    set extra(d) {
      i = d, e.extraLength = d.length, h(d);
    },
    get comment() {
      return C.decode(o);
    },
    set comment(d) {
      if (o = V.toBuffer(d, C.encode), e.commentLength = o.length, o.length > 65535)
        throw V.Errors.COMMENT_TOO_LONG();
    },
    get name() {
      var d = C.decode(n);
      return a ? d.substr(d.length - 1).split("/").pop() : d.split("/").pop();
    },
    get isDirectory() {
      return a;
    },
    getCompressedData: function() {
      return y(!1, null);
    },
    getCompressedDataAsync: function(d) {
      y(!0, d);
    },
    setData: function(d) {
      s = V.toBuffer(d, V.decoder.encode), !a && s.length ? (e.size = s.length, e.method = V.Constants.DEFLATED, e.crc = V.crc32(d), e.changed = !0) : e.method = V.Constants.STORED;
    },
    getData: function(d) {
      return e.changed ? s : p(!1, null, d);
    },
    getDataAsync: function(d, w) {
      e.changed ? d(s) : p(!0, d, w);
    },
    set attr(d) {
      e.attr = d;
    },
    get attr() {
      return e.attr;
    },
    set header(d) {
      e.loadFromBinary(d);
    },
    get header() {
      return e;
    },
    packCentralHeader: function() {
      e.flags_efs = this.efs, e.extraLength = i.length;
      var d = e.centralHeaderToBinary(), w = V.Constants.CENHDR;
      return n.copy(d, w), w += n.length, i.copy(d, w), w += e.extraLength, o.copy(d, w), d;
    },
    packLocalHeader: function() {
      let d = 0;
      e.flags_efs = this.efs, e.extraLocalLength = l.length;
      const w = e.localHeaderToBinary(), S = Buffer.alloc(w.length + n.length + e.extraLocalLength);
      return w.copy(S, d), d += w.length, n.copy(S, d), d += n.length, l.copy(S, d), d += l.length, S;
    },
    toJSON: function() {
      const d = function(w) {
        return "<" + (w && w.length + " bytes buffer" || "null") + ">";
      };
      return {
        entryName: this.entryName,
        name: this.name,
        comment: this.comment,
        isDirectory: this.isDirectory,
        header: e.toJSON(),
        compressedData: d(t),
        data: d(s)
      };
    },
    toString: function() {
      return JSON.stringify(this.toJSON(), null, "	");
    }
  };
};
const nr = Dr, qo = Qe, oe = Ue;
var zo = function(r, t) {
  var e = [], n = {}, o = Buffer.alloc(0), a = new qo.MainHeader(), s = !1;
  const i = /* @__PURE__ */ new Set(), l = t, { noSort: v, decoder: m } = l;
  r ? g(l.readEntries) : s = !0;
  function C() {
    const y = /* @__PURE__ */ new Set();
    for (const f of Object.keys(n)) {
      const h = f.split("/");
      if (h.pop(), !!h.length)
        for (let c = 0; c < h.length; c++) {
          const d = h.slice(0, c + 1).join("/") + "/";
          y.add(d);
        }
    }
    for (const f of y)
      if (!(f in n)) {
        const h = new nr(l);
        h.entryName = f, h.attr = 16, h.temporary = !0, e.push(h), n[h.entryName] = h, i.add(h);
      }
  }
  function I() {
    if (s = !0, n = {}, a.diskEntries > (r.length - a.offset) / oe.Constants.CENHDR)
      throw oe.Errors.DISK_ENTRY_TOO_LARGE();
    e = new Array(a.diskEntries);
    for (var y = a.offset, f = 0; f < e.length; f++) {
      var h = y, c = new nr(l, r);
      c.header = r.slice(h, h += oe.Constants.CENHDR), c.entryName = r.slice(h, h += c.header.fileNameLength), c.header.extraLength && (c.extra = r.slice(h, h += c.header.extraLength)), c.header.commentLength && (c.comment = r.slice(h, h + c.header.commentLength)), y += c.header.centralHeaderSize, e[f] = c, n[c.entryName] = c;
    }
    i.clear(), C();
  }
  function g(y) {
    var f = r.length - oe.Constants.ENDHDR, h = Math.max(0, f - 65535), c = h, d = r.length, w = -1, S = 0;
    for ((typeof l.trailingSpace == "boolean" ? l.trailingSpace : !1) && (h = 0), f; f >= c; f--)
      if (r[f] === 80) {
        if (r.readUInt32LE(f) === oe.Constants.ENDSIG) {
          w = f, S = f, d = f + oe.Constants.ENDHDR, c = f - oe.Constants.END64HDR;
          continue;
        }
        if (r.readUInt32LE(f) === oe.Constants.END64SIG) {
          c = h;
          continue;
        }
        if (r.readUInt32LE(f) === oe.Constants.ZIP64SIG) {
          w = f, d = f + oe.readBigUInt64LE(r, f + oe.Constants.ZIP64SIZE) + oe.Constants.ZIP64LEAD;
          break;
        }
      }
    if (w == -1)
      throw oe.Errors.INVALID_FORMAT();
    a.loadFromBinary(r.slice(w, d)), a.commentLength && (o = r.slice(S + oe.Constants.ENDHDR)), y && I();
  }
  function p() {
    e.length > 1 && !v && e.sort((y, f) => y.entryName.toLowerCase().localeCompare(f.entryName.toLowerCase()));
  }
  return {
    /**
     * Returns an array of ZipEntry objects existent in the current opened archive
     * @return Array
     */
    get entries() {
      return s || I(), e.filter((y) => !i.has(y));
    },
    /**
     * Archive comment
     * @return {String}
     */
    get comment() {
      return m.decode(o);
    },
    set comment(y) {
      o = oe.toBuffer(y, m.encode), a.commentLength = o.length;
    },
    getEntryCount: function() {
      return s ? e.length : a.diskEntries;
    },
    forEach: function(y) {
      this.entries.forEach(y);
    },
    /**
     * Returns a reference to the entry with the given name or null if entry is inexistent
     *
     * @param entryName
     * @return ZipEntry
     */
    getEntry: function(y) {
      return s || I(), n[y] || null;
    },
    /**
     * Adds the given entry to the entry list
     *
     * @param entry
     */
    setEntry: function(y) {
      s || I(), e.push(y), n[y.entryName] = y, a.totalEntries = e.length;
    },
    /**
     * Removes the file with the given name from the entry list.
     *
     * If the entry is a directory, then all nested files and directories will be removed
     * @param entryName
     * @returns {void}
     */
    deleteFile: function(y, f = !0) {
      s || I();
      const h = n[y];
      this.getEntryChildren(h, f).map((d) => d.entryName).forEach(this.deleteEntry);
    },
    /**
     * Removes the entry with the given name from the entry list.
     *
     * @param {string} entryName
     * @returns {void}
     */
    deleteEntry: function(y) {
      s || I();
      const f = n[y], h = e.indexOf(f);
      h >= 0 && (e.splice(h, 1), delete n[y], a.totalEntries = e.length);
    },
    /**
     *  Iterates and returns all nested files and directories of the given entry
     *
     * @param entry
     * @return Array
     */
    getEntryChildren: function(y, f = !0) {
      if (s || I(), typeof y == "object")
        if (y.isDirectory && f) {
          const h = [], c = y.entryName;
          for (const d of e)
            d.entryName.startsWith(c) && h.push(d);
          return h;
        } else
          return [y];
      return [];
    },
    /**
     *  How many child elements entry has
     *
     * @param {ZipEntry} entry
     * @return {integer}
     */
    getChildCount: function(y) {
      if (y && y.isDirectory) {
        const f = this.getEntryChildren(y);
        return f.includes(y) ? f.length - 1 : f.length;
      }
      return 0;
    },
    /**
     * Returns the zip file
     *
     * @return Buffer
     */
    compressToBuffer: function() {
      s || I(), p();
      const y = [], f = [];
      let h = 0, c = 0;
      a.size = 0, a.offset = 0;
      let d = 0;
      for (const _ of this.entries) {
        const A = _.getCompressedData();
        _.header.offset = c;
        const x = _.packLocalHeader(), P = x.length + A.length;
        c += P, y.push(x), y.push(A);
        const R = _.packCentralHeader();
        f.push(R), a.size += R.length, h += P + R.length, d++;
      }
      h += a.mainHeaderSize, a.offset = c, a.totalEntries = d, c = 0;
      const w = Buffer.alloc(h);
      for (const _ of y)
        _.copy(w, c), c += _.length;
      for (const _ of f)
        _.copy(w, c), c += _.length;
      const S = a.toBinary();
      return o && o.copy(S, oe.Constants.ENDHDR), S.copy(w, c), r = w, s = !1, w;
    },
    toAsyncBuffer: function(y, f, h, c) {
      try {
        s || I(), p();
        const d = [], w = [];
        let S = 0, _ = 0, A = 0;
        a.size = 0, a.offset = 0;
        const x = function(P) {
          if (P.length > 0) {
            const R = P.shift(), Q = R.entryName + R.extra.toString();
            h && h(Q), R.getCompressedDataAsync(function(te) {
              c && c(Q), R.header.offset = _;
              const E = R.packLocalHeader(), M = E.length + te.length;
              _ += M, d.push(E), d.push(te);
              const D = R.packCentralHeader();
              w.push(D), a.size += D.length, S += M + D.length, A++, x(P);
            });
          } else {
            S += a.mainHeaderSize, a.offset = _, a.totalEntries = A, _ = 0;
            const R = Buffer.alloc(S);
            d.forEach(function(te) {
              te.copy(R, _), _ += te.length;
            }), w.forEach(function(te) {
              te.copy(R, _), _ += te.length;
            });
            const Q = a.toBinary();
            o && o.copy(Q, oe.Constants.ENDHDR), Q.copy(R, _), r = R, s = !1, y(R);
          }
        };
        x(Array.from(this.entries));
      } catch (d) {
        f(d);
      }
    }
  };
};
const Z = Ue, X = pe, Ho = Dr, Vo = zo, we = (...r) => Z.findLast(r, (t) => typeof t == "boolean"), or = (...r) => Z.findLast(r, (t) => typeof t == "string"), Wo = (...r) => Z.findLast(r, (t) => typeof t == "function"), Go = {
  // option "noSort" : if true it disables files sorting
  noSort: !1,
  // read entries during load (initial loading may be slower)
  readEntries: !1,
  // default method is none
  method: Z.Constants.NONE,
  // file system
  fs: null
};
var Jo = function(r, t) {
  let e = null;
  const n = Object.assign(/* @__PURE__ */ Object.create(null), Go);
  r && typeof r == "object" && (r instanceof Uint8Array || (Object.assign(n, r), r = n.input ? n.input : void 0, n.input && delete n.input), Buffer.isBuffer(r) && (e = r, n.method = Z.Constants.BUFFER, r = void 0)), Object.assign(n, t);
  const o = new Z(n);
  if ((typeof n.decoder != "object" || typeof n.decoder.encode != "function" || typeof n.decoder.decode != "function") && (n.decoder = Z.decoder), r && typeof r == "string")
    if (o.fs.existsSync(r))
      n.method = Z.Constants.FILE, n.filename = r, e = o.fs.readFileSync(r);
    else
      throw Z.Errors.INVALID_FILENAME();
  const a = new Vo(e, n), { canonical: s, sanitize: i, zipnamefix: l } = Z;
  function v(g) {
    if (g && a) {
      var p;
      if (typeof g == "string" && (p = a.getEntry(X.posix.normalize(g))), typeof g == "object" && typeof g.entryName < "u" && typeof g.header < "u" && (p = a.getEntry(g.entryName)), p)
        return p;
    }
    return null;
  }
  function m(g) {
    const { join: p, normalize: y, sep: f } = X.posix;
    return p(".", y(f + g.split("\\").join(f) + f));
  }
  function C(g) {
    return g instanceof RegExp ? /* @__PURE__ */ function(p) {
      return function(y) {
        return p.test(y);
      };
    }(g) : typeof g != "function" ? () => !0 : g;
  }
  const I = (g, p) => {
    let y = p.slice(-1);
    return y = y === o.sep ? o.sep : "", X.relative(g, p) + y;
  };
  return {
    /**
     * Extracts the given entry from the archive and returns the content as a Buffer object
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {Buffer|string} [pass] - password
     * @return Buffer or Null in case of error
     */
    readFile: function(g, p) {
      var y = v(g);
      return y && y.getData(p) || null;
    },
    /**
     * Returns how many child elements has on entry (directories) on files it is always 0
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @returns {integer}
     */
    childCount: function(g) {
      const p = v(g);
      if (p)
        return a.getChildCount(p);
    },
    /**
     * Asynchronous readFile
     * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
     * @param {callback} callback
     *
     * @return Buffer or Null in case of error
     */
    readFileAsync: function(g, p) {
      var y = v(g);
      y ? y.getDataAsync(p) : p(null, "getEntry failed for:" + g);
    },
    /**
     * Extracts the given entry from the archive and returns the content as plain text in the given encoding
     * @param {ZipEntry|string} entry - ZipEntry object or String with the full path of the entry
     * @param {string} encoding - Optional. If no encoding is specified utf8 is used
     *
     * @return String
     */
    readAsText: function(g, p) {
      var y = v(g);
      if (y) {
        var f = y.getData();
        if (f && f.length)
          return f.toString(p || "utf8");
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
    readAsTextAsync: function(g, p, y) {
      var f = v(g);
      f ? f.getDataAsync(function(h, c) {
        if (c) {
          p(h, c);
          return;
        }
        h && h.length ? p(h.toString(y || "utf8")) : p("");
      }) : p("");
    },
    /**
     * Remove the entry from the file or the entry and all it's nested directories and files if the given entry is a directory
     *
     * @param {ZipEntry|string} entry
     * @returns {void}
     */
    deleteFile: function(g, p = !0) {
      var y = v(g);
      y && a.deleteFile(y.entryName, p);
    },
    /**
     * Remove the entry from the file or directory without affecting any nested entries
     *
     * @param {ZipEntry|string} entry
     * @returns {void}
     */
    deleteEntry: function(g) {
      var p = v(g);
      p && a.deleteEntry(p.entryName);
    },
    /**
     * Adds a comment to the zip. The zip must be rewritten after adding the comment.
     *
     * @param {string} comment
     */
    addZipComment: function(g) {
      a.comment = g;
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
    addZipEntryComment: function(g, p) {
      var y = v(g);
      y && (y.comment = p);
    },
    /**
     * Returns the comment of the specified entry
     *
     * @param {ZipEntry} entry
     * @return String
     */
    getZipEntryComment: function(g) {
      var p = v(g);
      return p && p.comment || "";
    },
    /**
     * Updates the content of an existing entry inside the archive. The zip must be rewritten after updating the content
     *
     * @param {ZipEntry} entry
     * @param {Buffer} content
     */
    updateFile: function(g, p) {
      var y = v(g);
      y && y.setData(p);
    },
    /**
     * Adds a file from the disk to the archive
     *
     * @param {string} localPath File to add to zip
     * @param {string} [zipPath] Optional path inside the zip
     * @param {string} [zipName] Optional name for the file
     * @param {string} [comment] Optional file comment
     */
    addLocalFile: function(g, p, y, f) {
      if (o.fs.existsSync(g)) {
        p = p ? m(p) : "";
        const h = X.win32.basename(X.win32.normalize(g));
        p += y || h;
        const c = o.fs.statSync(g), d = c.isFile() ? o.fs.readFileSync(g) : Buffer.alloc(0);
        c.isDirectory() && (p += o.sep), this.addFile(p, d, f, c);
      } else
        throw Z.Errors.FILE_NOT_FOUND(g);
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
    addLocalFileAsync: function(g, p) {
      g = typeof g == "object" ? g : { localPath: g };
      const y = X.resolve(g.localPath), { comment: f } = g;
      let { zipPath: h, zipName: c } = g;
      const d = this;
      o.fs.stat(y, function(w, S) {
        if (w)
          return p(w, !1);
        h = h ? m(h) : "";
        const _ = X.win32.basename(X.win32.normalize(y));
        if (h += c || _, S.isFile())
          o.fs.readFile(y, function(A, x) {
            return A ? p(A, !1) : (d.addFile(h, x, f, S), setImmediate(p, void 0, !0));
          });
        else if (S.isDirectory())
          return h += o.sep, d.addFile(h, Buffer.alloc(0), f, S), setImmediate(p, void 0, !0);
      });
    },
    /**
     * Adds a local directory and all its nested files and directories to the archive
     *
     * @param {string} localPath - local path to the folder
     * @param {string} [zipPath] - optional path inside zip
     * @param {(RegExp|function)} [filter] - optional RegExp or Function if files match will be included.
     */
    addLocalFolder: function(g, p, y) {
      if (y = C(y), p = p ? m(p) : "", g = X.normalize(g), o.fs.existsSync(g)) {
        const f = o.findFiles(g), h = this;
        if (f.length)
          for (const c of f) {
            const d = X.join(p, I(g, c));
            y(d) && h.addLocalFile(c, X.dirname(d));
          }
      } else
        throw Z.Errors.FILE_NOT_FOUND(g);
    },
    /**
     * Asynchronous addLocalFolder
     * @param {string} localPath
     * @param {callback} callback
     * @param {string} [zipPath] optional path inside zip
     * @param {RegExp|function} [filter] optional RegExp or Function if files match will
     *               be included.
     */
    addLocalFolderAsync: function(g, p, y, f) {
      f = C(f), y = y ? m(y) : "", g = X.normalize(g);
      var h = this;
      o.fs.open(g, "r", function(c) {
        if (c && c.code === "ENOENT")
          p(void 0, Z.Errors.FILE_NOT_FOUND(g));
        else if (c)
          p(void 0, c);
        else {
          var d = o.findFiles(g), w = -1, S = function() {
            if (w += 1, w < d.length) {
              var _ = d[w], A = I(g, _).split("\\").join("/");
              A = A.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, ""), f(A) ? o.fs.stat(_, function(x, P) {
                x && p(void 0, x), P.isFile() ? o.fs.readFile(_, function(R, Q) {
                  R ? p(void 0, R) : (h.addFile(y + A, Q, "", P), S());
                }) : (h.addFile(y + A + "/", Buffer.alloc(0), "", P), S());
              }) : process.nextTick(() => {
                S();
              });
            } else
              p(!0, void 0);
          };
          S();
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
    addLocalFolderAsync2: function(g, p) {
      const y = this;
      g = typeof g == "object" ? g : { localPath: g }, localPath = X.resolve(m(g.localPath));
      let { zipPath: f, filter: h, namefix: c } = g;
      h instanceof RegExp ? h = /* @__PURE__ */ function(S) {
        return function(_) {
          return S.test(_);
        };
      }(h) : typeof h != "function" && (h = function() {
        return !0;
      }), f = f ? m(f) : "", c == "latin1" && (c = (S) => S.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "")), typeof c != "function" && (c = (S) => S);
      const d = (S) => X.join(f, c(I(localPath, S))), w = (S) => X.win32.basename(X.win32.normalize(c(S)));
      o.fs.open(localPath, "r", function(S) {
        S && S.code === "ENOENT" ? p(void 0, Z.Errors.FILE_NOT_FOUND(localPath)) : S ? p(void 0, S) : o.findFilesAsync(localPath, function(_, A) {
          if (_)
            return p(_);
          A = A.filter((x) => h(d(x))), A.length || p(void 0, !1), setImmediate(
            A.reverse().reduce(function(x, P) {
              return function(R, Q) {
                if (R || Q === !1)
                  return setImmediate(x, R, !1);
                y.addLocalFileAsync(
                  {
                    localPath: P,
                    zipPath: X.dirname(d(P)),
                    zipName: w(P)
                  },
                  x
                );
              };
            }, p)
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
    addLocalFolderPromise: function(g, p) {
      return new Promise((y, f) => {
        this.addLocalFolderAsync2(Object.assign({ localPath: g }, p), (h, c) => {
          h && f(h), c && y(this);
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
    addFile: function(g, p, y, f) {
      g = l(g);
      let h = v(g);
      const c = h != null;
      c || (h = new Ho(n), h.entryName = g), h.comment = y || "";
      const d = typeof f == "object" && f instanceof o.fs.Stats;
      d && (h.header.time = f.mtime);
      var w = h.isDirectory ? 16 : 0;
      let S = h.isDirectory ? 16384 : 32768;
      return d ? S |= 4095 & f.mode : typeof f == "number" ? S |= 4095 & f : S |= h.isDirectory ? 493 : 420, w = (w | S << 16) >>> 0, h.attr = w, h.setData(p), c || a.setEntry(h), h;
    },
    /**
     * Returns an array of ZipEntry objects representing the files and folders inside the archive
     *
     * @param {string} [password]
     * @returns Array
     */
    getEntries: function(g) {
      return a.password = g, a ? a.entries : [];
    },
    /**
     * Returns a ZipEntry object representing the file or folder specified by ``name``.
     *
     * @param {string} name
     * @return ZipEntry
     */
    getEntry: function(g) {
      return v(g);
    },
    getEntryCount: function() {
      return a.getEntryCount();
    },
    forEach: function(g) {
      return a.forEach(g);
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
    extractEntryTo: function(g, p, y, f, h, c) {
      f = we(!1, f), h = we(!1, h), y = we(!0, y), c = or(h, c);
      var d = v(g);
      if (!d)
        throw Z.Errors.NO_ENTRY();
      var w = s(d.entryName), S = i(p, c && !d.isDirectory ? c : y ? w : X.basename(w));
      if (d.isDirectory) {
        var _ = a.getEntryChildren(d);
        return _.forEach(function(P) {
          if (P.isDirectory)
            return;
          var R = P.getData();
          if (!R)
            throw Z.Errors.CANT_EXTRACT_FILE();
          var Q = s(P.entryName), te = i(p, y ? Q : X.basename(Q));
          const E = h ? P.header.fileAttr : void 0;
          o.writeFileTo(te, R, f, E);
        }), !0;
      }
      var A = d.getData(a.password);
      if (!A)
        throw Z.Errors.CANT_EXTRACT_FILE();
      if (o.fs.existsSync(S) && !f)
        throw Z.Errors.CANT_OVERRIDE();
      const x = h ? g.header.fileAttr : void 0;
      return o.writeFileTo(S, A, f, x), !0;
    },
    /**
     * Test the archive
     * @param {string} [pass]
     */
    test: function(g) {
      if (!a)
        return !1;
      for (var p in a.entries)
        try {
          if (p.isDirectory)
            continue;
          var y = a.entries[p].getData(g);
          if (!y)
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
    extractAllTo: function(g, p, y, f) {
      if (y = we(!1, y), f = or(y, f), p = we(!1, p), !a)
        throw Z.Errors.NO_ZIP();
      a.entries.forEach(function(h) {
        var c = i(g, s(h.entryName));
        if (h.isDirectory) {
          o.makeDir(c);
          return;
        }
        var d = h.getData(f);
        if (!d)
          throw Z.Errors.CANT_EXTRACT_FILE();
        const w = y ? h.header.fileAttr : void 0;
        o.writeFileTo(c, d, p, w);
        try {
          o.fs.utimesSync(c, h.header.time, h.header.time);
        } catch {
          throw Z.Errors.CANT_EXTRACT_FILE();
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
    extractAllToAsync: function(g, p, y, f) {
      if (f = Wo(p, y, f), y = we(!1, y), p = we(!1, p), !f)
        return new Promise((S, _) => {
          this.extractAllToAsync(g, p, y, function(A) {
            A ? _(A) : S(this);
          });
        });
      if (!a) {
        f(Z.Errors.NO_ZIP());
        return;
      }
      g = X.resolve(g);
      const h = (S) => i(g, X.normalize(s(S.entryName))), c = (S, _) => new Error(S + ': "' + _ + '"'), d = [], w = [];
      a.entries.forEach((S) => {
        S.isDirectory ? d.push(S) : w.push(S);
      });
      for (const S of d) {
        const _ = h(S), A = y ? S.header.fileAttr : void 0;
        try {
          o.makeDir(_), A && o.fs.chmodSync(_, A), o.fs.utimesSync(_, S.header.time, S.header.time);
        } catch {
          f(c("Unable to create folder", _));
        }
      }
      w.reverse().reduce(function(S, _) {
        return function(A) {
          if (A)
            S(A);
          else {
            const x = X.normalize(s(_.entryName)), P = i(g, x);
            _.getDataAsync(function(R, Q) {
              if (Q)
                S(Q);
              else if (!R)
                S(Z.Errors.CANT_EXTRACT_FILE());
              else {
                const te = y ? _.header.fileAttr : void 0;
                o.writeFileToAsync(P, R, p, te, function(E) {
                  E || S(c("Unable to write file", P)), o.fs.utimes(P, _.header.time, _.header.time, function(M) {
                    M ? S(c("Unable to set times", P)) : S();
                  });
                });
              }
            });
          }
        };
      }, f)();
    },
    /**
     * Writes the newly created zip file to disk at the specified location or if a zip was opened and no ``targetFileName`` is provided, it will overwrite the opened zip
     *
     * @param {string} targetFileName
     * @param {function} callback
     */
    writeZip: function(g, p) {
      if (arguments.length === 1 && typeof g == "function" && (p = g, g = ""), !g && n.filename && (g = n.filename), !!g) {
        var y = a.compressToBuffer();
        if (y) {
          var f = o.writeFileTo(g, y, !0);
          typeof p == "function" && p(f ? null : new Error("failed"), "");
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
    writeZipPromise: function(g, p) {
      const { overwrite: y, perm: f } = Object.assign({ overwrite: !0 }, p);
      return new Promise((h, c) => {
        !g && n.filename && (g = n.filename), g || c("ADM-ZIP: ZIP File Name Missing"), this.toBufferPromise().then((d) => {
          const w = (S) => S ? h(S) : c("ADM-ZIP: Wasn't able to write zip file");
          o.writeFileToAsync(g, d, y, f, w);
        }, c);
      });
    },
    /**
     * @returns {Promise<Buffer>} A promise to the Buffer.
     */
    toBufferPromise: function() {
      return new Promise((g, p) => {
        a.toAsyncBuffer(g, p);
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
    toBuffer: function(g, p, y, f) {
      return typeof g == "function" ? (a.toAsyncBuffer(g, p, y, f), null) : a.compressToBuffer();
    }
  };
};
const ar = /* @__PURE__ */ Io(Jo);
class Zo {
  getBackupDir() {
    return pe.join(O.getPath("userData"), "backups");
  }
  getAutoBackupDir() {
    return pe.join(this.getBackupDir(), "auto");
  }
  ensureBackupDirs() {
    const t = this.getBackupDir(), e = this.getAutoBackupDir();
    N.existsSync(t) || N.mkdirSync(t, { recursive: !0 }), N.existsSync(e) || N.mkdirSync(e, { recursive: !0 });
  }
  // --- Encryption Helpers ---
  deriveKey(t, e) {
    return _e.pbkdf2Sync(t, e, 1e5, 32, "sha256");
  }
  encryptData(t, e) {
    const n = _e.randomBytes(16), o = _e.randomBytes(12), a = this.deriveKey(e, n), s = _e.createCipheriv("aes-256-gcm", a, o), i = Buffer.concat([s.update(t), s.final()]), l = s.getAuthTag();
    return {
      encryptedData: i,
      salt: n.toString("hex"),
      iv: o.toString("hex"),
      authTag: l.toString("hex")
    };
  }
  decryptData(t, e, n) {
    const o = Buffer.from(n.salt, "hex"), a = Buffer.from(n.iv, "hex"), s = Buffer.from(n.authTag, "hex"), i = this.deriveKey(e, o), l = _e.createDecipheriv("aes-256-gcm", i, a);
    return l.setAuthTag(s), Buffer.concat([l.update(t), l.final()]);
  }
  // --- Core Logic ---
  // 1. Export Data
  async exportData(t, e) {
    const [n, o, a, s, i, l] = await Promise.all([
      u.novel.findMany(),
      u.volume.findMany(),
      u.chapter.findMany(),
      u.character.findMany(),
      u.idea.findMany(),
      u.tag.findMany()
    ]), v = { novels: n, volumes: o, chapters: a, characters: s, ideas: i, tags: l }, m = Buffer.from(JSON.stringify(v)), C = new ar(), I = {
      version: 1,
      appVersion: O.getVersion(),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      platform: process.platform,
      encrypted: !!e
    };
    if (e) {
      const { encryptedData: g, salt: p, iv: y, authTag: f } = this.encryptData(m, e);
      I.encryption = { algo: "aes-256-gcm", salt: p, iv: y, authTag: f }, C.addFile("data.bin", g);
    } else
      C.addFile("data.json", m);
    if (C.addFile("manifest.json", Buffer.from(JSON.stringify(I, null, 2))), !t) {
      const { filePath: g } = await Re.showSaveDialog({
        title: "Export Backup",
        defaultPath: `NovelData_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")}.nebak`,
        filters: [{ name: "Novel Editor Backup", extensions: ["nebak"] }]
      });
      if (!g)
        throw new Error("Export cancelled");
      t = g;
    }
    return C.writeZip(t), t;
  }
  // 2. Import Data (Restore)
  async importData(t, e) {
    const n = new ar(t), o = n.getEntry("manifest.json");
    if (!o)
      throw new Error("Invalid backup file: manifest.json missing");
    const a = JSON.parse(o.getData().toString("utf8"));
    let s;
    if (a.encrypted) {
      if (!e)
        throw new Error("PASSWORD_REQUIRED");
      const i = n.getEntry("data.bin");
      if (!i)
        throw new Error("Invalid backup file: data.bin missing");
      if (!a.encryption)
        throw new Error("Invalid backup file: encryption metadata missing");
      try {
        const l = this.decryptData(i.getData(), e, a.encryption);
        s = JSON.parse(l.toString("utf8"));
      } catch {
        throw new Error("PASSWORD_INVALID");
      }
    } else {
      const i = n.getEntry("data.json");
      if (!i)
        throw new Error("Invalid backup file: data.json missing");
      s = JSON.parse(i.getData().toString("utf8"));
    }
    await this.performRestore(s);
  }
  // Helper: Perform Restore (Transactional)
  async performRestore(t) {
    await this.createAutoBackup(), await u.$transaction(async (e) => {
      var n, o, a, s, i, l;
      if (await e.tag.deleteMany(), await e.idea.deleteMany(), await e.character.deleteMany(), await e.chapter.deleteMany(), await e.volume.deleteMany(), await e.novel.deleteMany(), (n = t.novels) != null && n.length)
        for (const v of t.novels)
          await e.novel.create({ data: v });
      if ((o = t.volumes) != null && o.length)
        for (const v of t.volumes)
          await e.volume.create({ data: v });
      if ((a = t.chapters) != null && a.length)
        for (const v of t.chapters)
          await e.chapter.create({ data: v });
      if ((s = t.characters) != null && s.length)
        for (const v of t.characters)
          await e.character.create({ data: v });
      if ((i = t.ideas) != null && i.length)
        for (const v of t.ideas)
          await e.idea.create({ data: v });
      if ((l = t.tags) != null && l.length)
        for (const v of t.tags)
          await e.tag.create({ data: v });
    }, {
      maxWait: 1e4,
      timeout: 2e4
    });
  }
  // 3. Auto Backup Logic
  async createAutoBackup() {
    try {
      this.ensureBackupDirs();
      const e = `auto_backup_${Date.now()}.nebak`, n = pe.join(this.getAutoBackupDir(), e);
      await this.exportData(n), console.log("[BackupService] Auto-backup created:", e), await this.rotateAutoBackups();
    } catch (t) {
      console.error("[BackupService] Failed to create auto-backup:", t);
    }
  }
  async rotateAutoBackups() {
    this.ensureBackupDirs();
    const t = this.getAutoBackupDir(), n = N.readdirSync(t).filter((o) => o.endsWith(".nebak")).map((o) => ({
      name: o,
      time: N.statSync(pe.join(t, o)).mtime.getTime()
    })).sort((o, a) => a.time - o.time).slice(3);
    for (const o of n)
      N.unlinkSync(pe.join(t, o.name)), console.log("[BackupService] Rotated auto-backup:", o.name);
  }
  // 4. List Auto Backups
  async getAutoBackups() {
    this.ensureBackupDirs();
    const t = this.getAutoBackupDir();
    return N.readdirSync(t).filter((e) => e.endsWith(".nebak")).map((e) => {
      const n = N.statSync(pe.join(t, e));
      return {
        filename: e,
        createdAt: n.mtime.getTime(),
        size: n.size
      };
    }).sort((e, n) => n.createdAt - e.createdAt);
  }
  // 5. Restore from Auto Backup
  async restoreAutoBackup(t) {
    this.ensureBackupDirs();
    const e = pe.join(this.getAutoBackupDir(), t);
    if (!N.existsSync(e))
      throw new Error("Backup file not found");
    await this.importData(e);
  }
}
const rt = new Zo(), Le = k.dirname(zr(import.meta.url));
process.env.APP_ROOT = k.join(Le, "..");
const St = process.env.VITE_DEV_SERVER_URL, Ta = k.join(process.env.APP_ROOT, "dist-electron"), Nr = k.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = St ? k.join(process.env.APP_ROOT, "public") : Nr;
process.on("uncaughtException", (r) => {
  ce("Main.uncaughtException", r), console.error("[Main] Uncaught Exception:", r), O.quit(), process.exit(1);
});
process.on("unhandledRejection", (r, t) => {
  ce("Main.unhandledRejection", r, { promise: String(t) }), console.error("[Main] Unhandled Rejection at:", t, "reason:", r), O.quit(), process.exit(1);
});
let $, ir = !1;
const xr = "云梦小说编辑器", Ko = "Novel Editor Dev";
function Xo() {
  return O.isPackaged && process.platform === "win32" ? process.execPath : "com.noveleditor.app";
}
function Pr() {
  return O.isPackaged && typeof process.env.PORTABLE_EXECUTABLE_DIR == "string" && process.env.PORTABLE_EXECUTABLE_DIR.length > 0;
}
function Lr() {
  return k.join(k.dirname(O.getPath("exe")), "data");
}
function Yo() {
  const r = process.env.PORTABLE_EXECUTABLE_DIR;
  return r ? k.join(r, "data") : Lr();
}
function Qo(r, t) {
  if (!N.existsSync(r))
    return;
  N.existsSync(t) || N.mkdirSync(t, { recursive: !0 });
  const e = N.readdirSync(r, { withFileTypes: !0 });
  for (const n of e) {
    const o = k.join(r, n.name), a = k.join(t, n.name);
    if (!N.existsSync(a)) {
      if (n.isDirectory()) {
        N.cpSync(o, a, { recursive: !0 });
        continue;
      }
      N.copyFileSync(o, a);
    }
  }
}
function ea() {
  if (!O.isPackaged || Pr())
    return;
  const r = Lr(), t = O.getPath("userData"), e = k.join(r, "novel_editor.db"), n = k.join(t, "novel_editor.db");
  !N.existsSync(e) || N.existsSync(n) || (Qo(r, t), console.log("[Main] Migrated legacy packaged data from exe/data to userData."));
}
function ta() {
  if (O.isPackaged) {
    const e = k.join(process.resourcesPath, "icon_ink_pen_256.ico");
    return N.existsSync(e) ? e : void 0;
  }
  const r = k.join(process.env.APP_ROOT || "", "build", "icon_ink_pen_256.ico");
  if (N.existsSync(r))
    return r;
  const t = k.join(process.env.VITE_PUBLIC || "", "electron-vite.svg");
  return N.existsSync(t) ? t : void 0;
}
function ra() {
  const r = O.getPath("appData");
  return O.isPackaged ? k.join(r, xr) : k.join(r, "@novel-editor", "desktop-dev");
}
function sr(r) {
  return r ? /[ \t"]/u.test(r) ? `"${r.replace(/"/gu, '\\"')}"` : r : '""';
}
function na() {
  return O.isPackaged ? process.platform === "win32" ? k.join(process.resourcesPath, "mcp", "novel-editor-mcp.cmd") : k.join(process.resourcesPath, "mcp", "novel-editor-mcp.mjs") : process.platform === "win32" ? k.join(process.env.APP_ROOT || "", "scripts", "novel-editor-mcp.cmd") : k.join(process.env.APP_ROOT || "", "scripts", "novel-editor-mcp.mjs");
}
function Or() {
  const r = na(), t = N.existsSync(r), e = "novel_editor", n = 60, o = 120, a = process.platform === "win32" ? "cmd" : "node", s = process.platform === "win32" ? ["/c", r] : [r], i = process.platform === "win32" ? [
    `[mcp_servers.${e}]`,
    'command = "cmd"',
    `args = ["/c", "${r.replace(/\\/gu, "\\\\")}"]`,
    `startup_timeout_sec = ${n}`,
    `tool_timeout_sec = ${o}`
  ].join(`
`) : [
    `[mcp_servers.${e}]`,
    'command = "node"',
    `args = ["${r}"]`,
    `startup_timeout_sec = ${n}`,
    `tool_timeout_sec = ${o}`
  ].join(`
`), l = process.platform === "win32" ? `claude mcp add novel-editor --scope local -- cmd /c ${sr(r)}` : `claude mcp add novel-editor --scope local -- node ${sr(r)}`, v = JSON.stringify(
    {
      mcpServers: {
        [e]: {
          command: a,
          args: s
        }
      }
    },
    null,
    2
  );
  return {
    commandPath: r,
    launcherExists: t,
    command: a,
    args: s,
    codexToml: i,
    claudeCommand: l,
    jsonConfig: v
  };
}
function oa() {
  return k.join(O.getPath("userData"), "automation", "runtime.json");
}
function aa() {
  const r = oa();
  if (!N.existsSync(r))
    throw new Error(`Automation runtime file not found: ${r}`);
  let t;
  try {
    t = JSON.parse(N.readFileSync(r, "utf8"));
  } catch (n) {
    throw new Error(`Failed to parse automation runtime: ${(n == null ? void 0 : n.message) || "unknown error"}`);
  }
  const e = t;
  if (!e || typeof e != "object")
    throw new Error("Automation runtime is empty");
  if (!Number.isFinite(e.port) || !e.port || e.port <= 0)
    throw new Error("Automation runtime port is invalid");
  if (typeof e.token != "string" || !e.token.trim())
    throw new Error("Automation runtime token is invalid");
  return {
    version: Number(e.version || 1),
    port: Number(e.port),
    token: e.token,
    pid: Number(e.pid || 0),
    startedAt: String(e.startedAt || "")
  };
}
async function ia(r) {
  const e = JSON.stringify({
    method: "novel.list",
    params: {},
    origin: "desktop-ui"
  });
  return await new Promise((n, o) => {
    const a = dr.request(
      {
        hostname: "127.0.0.1",
        port: r.port,
        path: "/invoke",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(e, "utf8"),
          Authorization: `Bearer ${r.token}`
        }
      },
      (s) => {
        const i = [];
        s.on("data", (l) => i.push(Buffer.isBuffer(l) ? l : Buffer.from(l))), s.on("end", () => {
          const l = Buffer.concat(i).toString("utf8");
          try {
            n(JSON.parse(l));
          } catch (v) {
            o(new Error(`Automation health response parse failed: ${(v == null ? void 0 : v.message) || "unknown error"}`));
          }
        });
      }
    );
    a.setTimeout(8e3, () => {
      a.destroy(new Error("Automation health request timeout"));
    }), a.on("error", (s) => o(s)), a.write(e), a.end();
  });
}
async function sa() {
  const r = Or();
  if (!r.launcherExists)
    return { ok: !1, detail: `MCP launcher missing: ${r.commandPath}` };
  let t;
  try {
    t = aa();
  } catch (e) {
    return { ok: !1, detail: (e == null ? void 0 : e.message) || "Automation runtime unavailable" };
  }
  try {
    const e = await ia(t);
    return e != null && e.ok ? {
      ok: !0,
      detail: `MCP bridge ready. launcher=ok runtime=ok invoke=ok novels=${Array.isArray(e.data) ? e.data.length : 0}`
    } : {
      ok: !1,
      detail: `Automation invoke failed: ${(e == null ? void 0 : e.code) || "UNKNOWN"} ${(e == null ? void 0 : e.message) || ""}`.trim()
    };
  } catch (e) {
    return { ok: !1, detail: `Automation invoke error: ${(e == null ? void 0 : e.message) || "unknown error"}` };
  }
}
function ca(r) {
  const t = r.indexOf("--ai-diag");
  if (t < 0)
    return {};
  const e = r.slice(t + 1);
  if (e.length === 0)
    return { error: "Missing diagnostic action. Use: --ai-diag smoke <mcp|skill> [--json] [--db <path>] [--user-data <path>] or --ai-diag coverage [--json] [--db <path>] [--user-data <path>]" };
  const n = [];
  let o = !1, a, s;
  for (let v = 0; v < e.length; v += 1) {
    const m = e[v];
    if (m === "--json") {
      o = !0;
      continue;
    }
    if (m === "--db") {
      const C = e[v + 1];
      if (!C)
        return { error: "Missing value for --db" };
      a = C, v += 1;
      continue;
    }
    if (m === "--user-data") {
      const C = e[v + 1];
      if (!C)
        return { error: "Missing value for --user-data" };
      s = C, v += 1;
      continue;
    }
    if (m.startsWith("--"))
      return { error: `Unknown option: ${m}` };
    n.push(m);
  }
  const [i, l] = n;
  return i === "coverage" ? { command: { action: "coverage", json: o, dbPath: a, userDataPath: s } } : i === "smoke" ? l !== "mcp" && l !== "skill" ? { error: "Smoke mode requires kind: mcp | skill" } : { command: { action: "smoke", kind: l, json: o, dbPath: a, userDataPath: s } } : { error: `Unknown diagnostic action: ${i}` };
}
function la(r, t) {
  if (t.action === "coverage") {
    const o = r;
    return [
      `[AI-Diag] Coverage ${o.overallCoverage}% (${o.totalSupported}/${o.totalRequired})`,
      ...o.modules.map((s) => {
        const i = s.missingActions.length ? ` missing=[${s.missingActions.join(", ")}]` : "";
        return `- ${s.title}: ${s.coverage}% (${s.supportedActions.length}/${s.requiredActions.length})${i}`;
      })
    ].join(`
`);
  }
  const e = r;
  return [
    `[AI-Diag] Smoke ${e.kind.toUpperCase()} ${e.ok ? "PASSED" : "FAILED"}`,
    `detail: ${e.detail}`,
    e.missingActions.length ? `missingActions: ${e.missingActions.join(", ")}` : "missingActions: none",
    ...e.checks.map((o) => `- [${o.skipped ? "SKIPPED" : o.ok ? "OK" : "FAILED"}] ${o.actionId}: ${o.detail}`)
  ].join(`
`);
}
async function da(r, t) {
  const e = t.action === "coverage" ? r.getCapabilityCoverage() : await r.testOpenClawSmoke({ kind: t.kind });
  return t.json ? console.log(JSON.stringify(e, null, 2)) : console.log(la(e, t)), t.action === "smoke" && !e.ok ? 1 : 0;
}
function cr() {
  if (!bt() || ir)
    return;
  ir = !0;
  const r = console.error.bind(console), t = console.warn.bind(console);
  console.error = (...e) => {
    L("ERROR", "console.error", "console.error called", { args: ne(e) }), r(...e);
  }, console.warn = (...e) => {
    L("WARN", "console.warn", "console.warn called", { args: ne(e) }), t(...e);
  };
}
function B(r, t, e) {
  const n = de(e);
  ce(`Main.${r}`, e, {
    payload: ne(t),
    normalizedError: n,
    displayMessage: Te(n.code, n.message)
  });
}
const me = ca(process.argv);
async function Mr(r) {
  const t = r == null ? void 0 : r.proxy;
  if (!t || !Be.defaultSession)
    return;
  const e = () => {
    delete process.env.HTTP_PROXY, delete process.env.http_proxy, delete process.env.HTTPS_PROXY, delete process.env.https_proxy, delete process.env.ALL_PROXY, delete process.env.all_proxy, delete process.env.NO_PROXY, delete process.env.no_proxy;
  }, n = () => {
    t.httpProxy && (process.env.HTTP_PROXY = t.httpProxy, process.env.http_proxy = t.httpProxy), t.httpsProxy && (process.env.HTTPS_PROXY = t.httpsProxy, process.env.https_proxy = t.httpsProxy), t.allProxy && (process.env.ALL_PROXY = t.allProxy, process.env.all_proxy = t.allProxy), t.noProxy && (process.env.NO_PROXY = t.noProxy, process.env.no_proxy = t.noProxy);
  };
  if (t.mode === "off") {
    await Be.defaultSession.setProxy({ mode: "direct" }), e();
    return;
  }
  if (t.mode === "custom") {
    const o = [t.allProxy, t.httpsProxy, t.httpProxy].filter((a) => !!a).join(";");
    await Be.defaultSession.setProxy({
      mode: o ? "fixed_servers" : "direct",
      proxyRules: o,
      proxyBypassRules: t.noProxy || ""
    }), e(), n();
    return;
  }
  await Be.defaultSession.setProxy({ mode: "system" }), e();
}
function $r() {
  const r = !O.isPackaged, t = ta();
  $ = new lr({
    width: 1200,
    height: 800,
    ...t ? { icon: t } : {},
    webPreferences: {
      preload: k.join(Le, "preload.mjs"),
      devTools: r
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
  }), $.once("ready-to-show", () => {
    $ == null || $.show();
  }), $.webContents.on("did-finish-load", () => {
    $ == null || $.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  }), $.webContents.on("devtools-opened", () => {
    r || $ == null || $.webContents.closeDevTools();
  }), $.webContents.on("before-input-event", (e, n) => {
    n.key === "F11" && ($ == null || $.setFullScreen(!$.isFullScreen()), e.preventDefault()), r && (n.key === "F12" || n.control && n.shift && n.key.toLowerCase() === "i") && ($ != null && $.webContents.isDevToolsOpened() ? $.webContents.closeDevTools() : $ == null || $.webContents.openDevTools(), e.preventDefault());
  }), St ? $.loadURL(St) : $.loadFile(k.join(Nr, "index.html")), $.on("enter-full-screen", () => {
    $ == null || $.webContents.send("app:fullscreen-change", !0);
  }), $.on("leave-full-screen", () => {
    $ == null || $.webContents.send("app:fullscreen-change", !1);
  });
}
b.handle("app:toggle-fullscreen", () => {
  if ($) {
    const r = $.isFullScreen();
    return $.setFullScreen(!r), !r;
  }
  return !1;
});
b.handle("app:get-user-data-path", () => O.getPath("userData"));
b.handle("db:get-novels", async () => {
  console.log("[Main] Received db:get-novels");
  try {
    return (await u.novel.findMany({
      include: {
        volumes: {
          select: {
            chapters: { select: { content: !0 } }
          }
        }
      },
      orderBy: { updatedAt: "desc" }
    })).map((t) => {
      const e = t.volumes.reduce(
        (a, s) => a + s.chapters.reduce((i, l) => i + kt(l.content || "").length, 0),
        0
      ), { volumes: n, ...o } = t;
      return {
        ...o,
        wordCount: e
      };
    });
  } catch (r) {
    throw console.error("[Main] db:get-novels failed:", r), r;
  }
});
b.handle("db:update-novel", async (r, { id: t, data: e }) => {
  console.log("[Main] Updating novel:", t, e);
  try {
    return await u.novel.update({
      where: { id: t },
      data: {
        ...e,
        updatedAt: /* @__PURE__ */ new Date()
      }
    });
  } catch (n) {
    throw console.error("[Main] db:update-novel failed:", n), n;
  }
});
b.handle("db:delete-novel", async (r, t) => {
  var e;
  console.log("[Main] Received db:delete-novel:", t);
  try {
    const n = await u.novel.findUnique({
      where: { id: t },
      select: { coverUrl: !0 }
    });
    if ((e = n == null ? void 0 : n.coverUrl) != null && e.startsWith("covers/")) {
      const o = k.join(O.getPath("userData"), n.coverUrl);
      N.existsSync(o) && N.unlinkSync(o);
    }
    return await u.novel.delete({
      where: { id: t }
    }), { ok: !0 };
  } catch (n) {
    throw console.error("[Main] db:delete-novel failed:", n), n;
  }
});
b.handle("db:upload-novel-cover", async (r, t) => {
  var e;
  try {
    const n = await Re.showOpenDialog($, {
      title: "Select Cover Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (n.canceled || n.filePaths.length === 0)
      return null;
    const o = n.filePaths[0], a = k.extname(o), s = k.join(O.getPath("userData"), "covers");
    N.existsSync(s) || N.mkdirSync(s, { recursive: !0 });
    const i = await u.novel.findUnique({ where: { id: t }, select: { coverUrl: !0 } });
    if ((e = i == null ? void 0 : i.coverUrl) != null && e.startsWith("covers/")) {
      const C = k.join(O.getPath("userData"), i.coverUrl);
      N.existsSync(C) && N.unlinkSync(C);
    }
    const l = `${t}${a}`, v = k.join(s, l);
    N.copyFileSync(o, v);
    const m = `covers/${l}`;
    return await u.novel.update({
      where: { id: t },
      data: { coverUrl: m }
    }), { path: m };
  } catch (n) {
    throw console.error("[Main] db:upload-novel-cover failed:", n), n;
  }
});
b.handle("db:get-volumes", async (r, t) => {
  try {
    return await u.volume.findMany({
      where: { novelId: t },
      include: {
        chapters: { orderBy: { order: "asc" } }
      },
      orderBy: { order: "asc" }
    });
  } catch (e) {
    throw console.error("[Main] db:get-volumes failed:", e), e;
  }
});
b.handle("db:create-volume", async (r, { novelId: t, title: e }) => {
  try {
    const n = await u.volume.findFirst({
      where: { novelId: t },
      orderBy: { order: "desc" }
    }), o = ((n == null ? void 0 : n.order) || 0) + 1;
    return await u.volume.create({
      data: { novelId: t, title: e, order: o }
    });
  } catch (n) {
    throw console.error("[Main] db:create-volume failed:", n), n;
  }
});
b.handle("db:create-chapter", async (r, { volumeId: t, title: e, order: n }) => {
  try {
    const o = await u.chapter.create({
      data: {
        volumeId: t,
        title: e,
        order: n,
        content: "",
        wordCount: 0
      },
      include: { volume: { select: { novelId: !0 } } }
    });
    return await Ie({ ...o, novelId: o.volume.novelId }), Fe(o.id, "create-chapter"), o;
  } catch (o) {
    throw console.error("[Main] db:create-chapter failed:", o), o;
  }
});
b.handle("db:get-chapter", async (r, t) => {
  try {
    return await u.chapter.findUnique({
      where: { id: t },
      include: { volume: { select: { novelId: !0 } } }
    });
  } catch (e) {
    throw console.error("[Main] db:get-chapter failed:", e), e;
  }
});
b.handle("db:rename-volume", async (r, { volumeId: t, title: e }) => {
  try {
    const n = await u.volume.update({
      where: { id: t },
      data: { title: e }
    }), o = await u.chapter.findMany({
      where: { volumeId: t },
      include: { volume: { select: { novelId: !0, title: !0, order: !0 } } }
    });
    for (const a of o)
      await Ie({
        ...a,
        novelId: a.volume.novelId,
        volumeTitle: a.volume.title,
        volumeOrder: a.volume.order
      }), Fe(a.id, "rename-volume");
    return n;
  } catch (n) {
    throw console.error("[Main] db:rename-volume failed:", n), n;
  }
});
b.handle("db:rename-chapter", async (r, { chapterId: t, title: e }) => {
  try {
    const n = await u.chapter.update({
      where: { id: t },
      data: { title: e }
    }), o = await u.chapter.findUnique({
      where: { id: t },
      select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0, volume: { select: { novelId: !0 } } }
    });
    return o && o.volume && (await Ie({ ...o, novelId: o.volume.novelId }), Fe(t, "rename-chapter")), n;
  } catch (n) {
    throw console.error("[Main] db:rename-chapter failed:", n), n;
  }
});
b.handle("db:delete-chapter", async (r, { chapterId: t }) => {
  var e, n, o, a;
  try {
    const s = await u.chapter.findUnique({
      where: { id: t },
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
    if (!(s != null && s.volume))
      throw new Error("Chapter not found");
    const i = s.volume.novelId, l = await u.chapter.findMany({
      where: { volume: { novelId: i } },
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
    }), v = l.findIndex((p) => p.id === t);
    if (v === -1)
      throw new Error("Chapter not found");
    if (l.length === 1) {
      const [, p] = await u.$transaction([
        u.novel.update({
          where: { id: i },
          data: {
            wordCount: 0,
            updatedAt: /* @__PURE__ */ new Date()
          }
        }),
        u.chapter.update({
          where: { id: t },
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
      return await Ie({
        ...p,
        novelId: i,
        volumeTitle: s.volume.title,
        volumeOrder: s.volume.order
      }), Fe(t, "reset-only-chapter"), {
        mode: "reset",
        chapterId: t,
        fallbackChapterId: t,
        chapter: p
      };
    }
    const m = ((e = l[v + 1]) == null ? void 0 : e.id) ?? ((n = l[v - 1]) == null ? void 0 : n.id) ?? null, g = l.filter((p) => p.volumeId === s.volumeId && p.id !== t).map((p, y) => ({
      ...p,
      nextOrder: y + 1
    })).filter((p) => p.order !== p.nextOrder);
    await u.$transaction([
      u.novel.update({
        where: { id: i },
        data: {
          wordCount: { decrement: s.wordCount },
          updatedAt: /* @__PURE__ */ new Date()
        }
      }),
      u.chapter.delete({
        where: { id: t }
      }),
      ...g.map((p) => u.chapter.update({
        where: { id: p.id },
        data: {
          order: p.nextOrder,
          updatedAt: /* @__PURE__ */ new Date()
        }
      }))
    ]), await mr("chapter", t), ua(i, t, "delete-chapter");
    for (const p of g)
      await Ie({
        id: p.id,
        title: p.title,
        content: p.content,
        volumeId: p.volumeId,
        novelId: i,
        volumeTitle: (o = p.volume) == null ? void 0 : o.title,
        order: p.nextOrder,
        volumeOrder: (a = p.volume) == null ? void 0 : a.order
      });
    return {
      mode: "deleted",
      chapterId: t,
      fallbackChapterId: m
    };
  } catch (s) {
    throw console.error("[Main] db:delete-chapter failed:", s), s;
  }
});
b.handle("db:create-novel", async (r, t) => {
  console.log("[Main] Received db:create-novel:", t);
  try {
    return await u.novel.create({
      data: {
        title: t,
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
  } catch (e) {
    throw console.error("[Main] db:create-novel failed:", e), e;
  }
});
b.handle("db:save-chapter", async (r, { chapterId: t, content: e }) => {
  try {
    console.log("[Main] Saving chapter:", t);
    const n = await u.chapter.findUnique({
      where: { id: t },
      select: {
        wordCount: !0,
        volume: { select: { novelId: !0 } }
      }
    });
    if (!n || !n.volume)
      throw new Error("Chapter or Volume not found");
    const o = n.volume.novelId, a = kt(e).length, s = a - n.wordCount, [, i] = await u.$transaction([
      // 1. Update Novel WordCount
      u.novel.update({
        where: { id: o },
        data: {
          wordCount: { increment: s },
          updatedAt: /* @__PURE__ */ new Date()
        }
      }),
      // 2. Update Chapter
      u.chapter.update({
        where: { id: t },
        data: {
          content: e,
          wordCount: a,
          updatedAt: /* @__PURE__ */ new Date()
        }
      })
    ]), l = await u.chapter.findUnique({
      where: { id: t },
      select: { id: !0, title: !0, content: !0, volumeId: !0, order: !0 }
    });
    return l && (await Ie({ ...l, novelId: o }), Fe(t, "save-chapter")), Tt(t), i;
  } catch (n) {
    throw console.error("[Main] db:save-chapter failed:", n), n;
  }
});
b.handle("db:create-idea", async (r, t) => {
  try {
    const { timestamp: e, tags: n, ...o } = t, a = o.novelId, s = await u.idea.create({
      data: {
        ...o,
        tags: {
          connectOrCreate: (n || []).map((l) => ({
            where: { name_novelId: { name: l, novelId: a } },
            create: { name: l, novelId: a }
          }))
        }
      },
      include: { tags: !0 }
    }), i = {
      ...s,
      tags: s.tags.map((l) => l.name),
      timestamp: s.createdAt.getTime()
    };
    return await _t({
      id: s.id,
      content: s.content,
      quote: s.quote,
      novelId: s.novelId,
      chapterId: s.chapterId
    }), i;
  } catch (e) {
    throw console.error("[Main] db:create-idea failed:", e), e;
  }
});
b.handle("db:get-ideas", async (r, t) => {
  try {
    return (await u.idea.findMany({
      where: { novelId: t },
      include: { tags: !0 },
      orderBy: [
        { isStarred: "desc" },
        { updatedAt: "desc" }
      ]
    })).map((n) => ({
      ...n,
      tags: n.tags.map((o) => o.name),
      timestamp: n.createdAt.getTime()
    }));
  } catch (e) {
    throw console.error("[Main] db:get-ideas failed:", e), e;
  }
});
b.handle("db:update-idea", async (r, t, e) => {
  try {
    const { timestamp: n, tags: o, ...a } = e, s = { ...a };
    if (o !== void 0) {
      const v = await u.idea.findUnique({ where: { id: t }, select: { novelId: !0 } });
      if (v) {
        const m = v.novelId;
        s.tags = {
          set: [],
          // Disconnect all existing
          connectOrCreate: (o || []).map((C) => ({
            where: { name_novelId: { name: C, novelId: m } },
            create: { name: C, novelId: m }
          }))
        };
      }
    }
    const i = await u.idea.update({
      where: { id: t },
      data: {
        ...s,
        updatedAt: /* @__PURE__ */ new Date()
      },
      include: { tags: !0 }
    }), l = {
      ...i,
      tags: i.tags.map((v) => v.name),
      timestamp: i.createdAt.getTime()
    };
    return await _t({
      id: i.id,
      content: i.content,
      quote: i.quote,
      novelId: i.novelId,
      chapterId: i.chapterId
    }), l;
  } catch (n) {
    throw console.error("[Main] db:update-idea failed:", n), n;
  }
});
b.handle("db:delete-idea", async (r, t) => {
  try {
    const e = await u.idea.delete({ where: { id: t } });
    return await mr("idea", t), e;
  } catch (e) {
    throw console.error("[Main] db:delete-idea failed:", e), e;
  }
});
b.handle("db:check-index-status", async (r, t) => {
  try {
    const e = await Kr(t), n = await u.chapter.count({
      where: { volume: { novelId: t } }
    }), o = await u.idea.count({
      where: { novelId: t }
    });
    return {
      indexedChapters: e.chapters,
      totalChapters: n,
      indexedIdeas: e.ideas,
      totalIdeas: o
    };
  } catch (e) {
    throw console.error("[Main] db:check-index-status failed:", e), e;
  }
});
const Rr = new wo();
let F, Ct, Je = null;
async function Fe(r, t) {
  return ae("chapter", r, t);
}
async function ae(r, t, e) {
  try {
    const n = await F.upsertRagSourceIndex(r, t, { skipIfNovelNotIndexed: !0 });
    if (n.skipped)
      return;
    console.log("[RAG] Source index refreshed:", { sourceType: r, sourceId: t, reason: e, chunks: n.chunks, provider: n.provider, model: n.model });
  } catch (n) {
    console.warn("[RAG] Failed to refresh source index:", { sourceType: r, sourceId: t, reason: e, error: n });
  }
}
async function ua(r, t, e) {
  return De(r, "chapter", t, e);
}
async function De(r, t, e, n) {
  try {
    const o = await F.deleteRagSourceIndex(r, t, e);
    console.log("[RAG] Source index removed:", { novelId: r, sourceType: t, sourceId: e, reason: n, deleted: o.deleted });
  } catch (o) {
    console.warn("[RAG] Failed to remove source index:", { novelId: r, sourceType: t, sourceId: e, reason: n, error: o });
  }
}
b.handle("ai:get-settings", async () => {
  try {
    return F.getSettings();
  } catch (r) {
    throw B("ai:get-settings", void 0, r), console.error("[Main] ai:get-settings failed:", r), r;
  }
});
b.handle("ai:get-map-image-stats", async () => {
  try {
    return F.getMapImageStats();
  } catch (r) {
    throw B("ai:get-map-image-stats", void 0, r), console.error("[Main] ai:get-map-image-stats failed:", r), r;
  }
});
b.handle("ai:list-actions", async () => {
  try {
    return F.listActions();
  } catch (r) {
    throw B("ai:list-actions", void 0, r), console.error("[Main] ai:list-actions failed:", r), r;
  }
});
b.handle("ai:get-capability-coverage", async () => {
  try {
    return F.getCapabilityCoverage();
  } catch (r) {
    throw B("ai:get-capability-coverage", void 0, r), console.error("[Main] ai:get-capability-coverage failed:", r), r;
  }
});
b.handle("ai:get-mcp-manifest", async () => {
  try {
    return F.getMcpToolsManifest();
  } catch (r) {
    throw B("ai:get-mcp-manifest", void 0, r), console.error("[Main] ai:get-mcp-manifest failed:", r), r;
  }
});
b.handle("ai:get-mcp-cli-setup", async () => {
  try {
    return Or();
  } catch (r) {
    throw B("ai:get-mcp-cli-setup", void 0, r), console.error("[Main] ai:get-mcp-cli-setup failed:", r), r;
  }
});
b.handle("ai:get-openclaw-manifest", async () => {
  try {
    return F.getOpenClawManifest();
  } catch (r) {
    throw B("ai:get-openclaw-manifest", void 0, r), console.error("[Main] ai:get-openclaw-manifest failed:", r), r;
  }
});
b.handle("ai:get-openclaw-skill-manifest", async () => {
  try {
    return F.getOpenClawSkillManifest();
  } catch (r) {
    throw B("ai:get-openclaw-skill-manifest", void 0, r), console.error("[Main] ai:get-openclaw-skill-manifest failed:", r), r;
  }
});
b.handle("ai:update-settings", async (r, t) => {
  try {
    const e = F.updateSettings(t || {});
    return await Mr(e), e;
  } catch (e) {
    throw B("ai:update-settings", t, e), console.error("[Main] ai:update-settings failed:", e), e;
  }
});
b.handle("ai:test-connection", async () => {
  try {
    return await F.testConnection();
  } catch (r) {
    throw B("ai:test-connection", void 0, r), console.error("[Main] ai:test-connection failed:", r), r;
  }
});
b.handle("ai:test-mcp", async () => {
  try {
    return await sa();
  } catch (r) {
    throw B("ai:test-mcp", void 0, r), console.error("[Main] ai:test-mcp failed:", r), r;
  }
});
b.handle("ai:test-openclaw-mcp", async () => {
  try {
    return await F.testOpenClawMcp();
  } catch (r) {
    throw B("ai:test-openclaw-mcp", void 0, r), console.error("[Main] ai:test-openclaw-mcp failed:", r), r;
  }
});
b.handle("ai:test-openclaw-skill", async () => {
  try {
    return await F.testOpenClawSkill();
  } catch (r) {
    throw B("ai:test-openclaw-skill", void 0, r), console.error("[Main] ai:test-openclaw-skill failed:", r), r;
  }
});
b.handle("ai:test-openclaw-smoke", async (r, t) => {
  try {
    const e = (t == null ? void 0 : t.kind) === "skill" ? "skill" : "mcp";
    return await F.testOpenClawSmoke({ kind: e });
  } catch (e) {
    throw B("ai:test-openclaw-smoke", t, e), console.error("[Main] ai:test-openclaw-smoke failed:", e), e;
  }
});
b.handle("ai:test-proxy", async () => {
  try {
    return await F.testProxy();
  } catch (r) {
    throw B("ai:test-proxy", void 0, r), console.error("[Main] ai:test-proxy failed:", r), r;
  }
});
b.handle("ai:test-generate", async (r, t) => {
  try {
    return await F.testGenerate(t == null ? void 0 : t.prompt);
  } catch (e) {
    throw B("ai:test-generate", t, e), console.error("[Main] ai:test-generate failed:", e), e;
  }
});
b.handle("ai:generate-title", async (r, t) => {
  try {
    return await F.generateTitle(t);
  } catch (e) {
    throw B("ai:generate-title", t, e), console.error("[Main] ai:generate-title failed:", e), e;
  }
});
b.handle("ai:continue-writing", async (r, t) => {
  try {
    return await F.continueWriting(t);
  } catch (e) {
    throw B("ai:continue-writing", t, e), console.error("[Main] ai:continue-writing failed:", e), e;
  }
});
b.handle("ai:preview-continue-prompt", async (r, t) => {
  try {
    return await F.previewContinuePrompt(t);
  } catch (e) {
    throw B("ai:preview-continue-prompt", t, e), console.error("[Main] ai:preview-continue-prompt failed:", e), e;
  }
});
b.handle("ai:check-consistency", async (r, t) => {
  try {
    return await F.checkConsistency(t);
  } catch (e) {
    throw B("ai:check-consistency", t, e), console.error("[Main] ai:check-consistency failed:", e), e;
  }
});
b.handle("ai:ask-novel", async (r, t) => {
  try {
    return await F.askNovel(t);
  } catch (e) {
    throw B("ai:ask-novel", t, e), console.error("[Main] ai:ask-novel failed:", e), e;
  }
});
b.handle("ai:preview-novel-ask-prompt", async (r, t) => {
  try {
    return await F.previewNovelAskPrompt(t);
  } catch (e) {
    throw B("ai:preview-novel-ask-prompt", t, e), console.error("[Main] ai:preview-novel-ask-prompt failed:", e), e;
  }
});
b.handle("ai:generate-creative-assets", async (r, t) => {
  try {
    return await F.generateCreativeAssets(t);
  } catch (e) {
    throw B("ai:generate-creative-assets", t, e), console.error("[Main] ai:generate-creative-assets failed:", e), e;
  }
});
b.handle("ai:preview-creative-assets-prompt", async (r, t) => {
  try {
    return await F.previewCreativeAssetsPrompt(t);
  } catch (e) {
    throw B("ai:preview-creative-assets-prompt", t, e), console.error("[Main] ai:preview-creative-assets-prompt failed:", e), e;
  }
});
b.handle("ai:validate-creative-assets", async (r, t) => {
  try {
    return await F.validateCreativeAssetsDraft(t);
  } catch (e) {
    throw B("ai:validate-creative-assets", t, e), console.error("[Main] ai:validate-creative-assets failed:", e), e;
  }
});
b.handle("ai:confirm-creative-assets", async (r, t) => {
  try {
    return await F.confirmCreativeAssets(t);
  } catch (e) {
    throw B("ai:confirm-creative-assets", t, e), console.error("[Main] ai:confirm-creative-assets failed:", e), e;
  }
});
b.handle("ai:generate-map-image", async (r, t) => {
  try {
    return await F.generateMapImage(t);
  } catch (e) {
    return B("ai:generate-map-image", t, e), console.error("[Main] ai:generate-map-image failed:", e), { ok: !1, code: "UNKNOWN", detail: e instanceof Error ? e.message : String(e) };
  }
});
b.handle("ai:preview-map-prompt", async (r, t) => {
  try {
    return await F.previewMapPrompt(t);
  } catch (e) {
    throw B("ai:preview-map-prompt", t, e), console.error("[Main] ai:preview-map-prompt failed:", e), e;
  }
});
b.handle("ai:rebuild-chapter-summary", async (r, t) => {
  try {
    return t != null && t.chapterId ? (Tt(t.chapterId, "manual"), { ok: !0, detail: "summary rebuild scheduled" }) : { ok: !1, detail: "chapterId is required" };
  } catch (e) {
    return B("ai:rebuild-chapter-summary", t, e), console.error("[Main] ai:rebuild-chapter-summary failed:", e), { ok: !1, detail: e instanceof Error ? e.message : String(e) };
  }
});
b.handle("ai:execute-action", async (r, t) => {
  try {
    return await F.executeAction(t);
  } catch (e) {
    throw B("ai:execute-action", t, e), console.error("[Main] ai:execute-action failed:", e), e;
  }
});
b.handle("ai:openclaw-invoke", async (r, t) => {
  try {
    return await F.invokeOpenClawTool(t);
  } catch (e) {
    B("ai:openclaw-invoke", t, e), console.error("[Main] ai:openclaw-invoke failed:", e);
    const n = de(e);
    return {
      ok: !1,
      code: n.code,
      error: Te(n.code, n.message)
    };
  }
});
b.handle("ai:openclaw-mcp-invoke", async (r, t) => {
  try {
    return await F.invokeOpenClawTool(t);
  } catch (e) {
    B("ai:openclaw-mcp-invoke", t, e), console.error("[Main] ai:openclaw-mcp-invoke failed:", e);
    const n = de(e);
    return {
      ok: !1,
      code: n.code,
      error: Te(n.code, n.message)
    };
  }
});
b.handle("ai:openclaw-skill-invoke", async (r, t) => {
  try {
    return await F.invokeOpenClawSkill(t);
  } catch (e) {
    B("ai:openclaw-skill-invoke", t, e), console.error("[Main] ai:openclaw-skill-invoke failed:", e);
    const n = de(e);
    return {
      ok: !1,
      code: n.code,
      error: Te(n.code, n.message)
    };
  }
});
b.handle("automation:invoke", async (r, t) => {
  const e = Oe(), n = Date.now();
  try {
    L("INFO", "Main.automation:invoke.start", "Renderer automation invoke start", {
      requestId: e,
      method: t.method,
      origin: t.origin ?? "desktop-ui",
      params: ne(t.params)
    });
    const o = await Ct.invoke(t.method, t.params, {
      source: "renderer",
      origin: t.origin ?? "desktop-ui",
      requestId: e
    });
    return L("INFO", "Main.automation:invoke.success", "Renderer automation invoke success", {
      requestId: e,
      method: t.method,
      elapsedMs: Date.now() - n,
      result: ne(o)
    }), (/* @__PURE__ */ new Set([
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
    ])).has(t.method) && ($ == null || $.webContents.send("automation:data-changed", { method: t.method })), o;
  } catch (o) {
    throw ce("Main.automation:invoke.error", o, {
      requestId: e,
      method: t.method,
      elapsedMs: Date.now() - n,
      payload: ne(t)
    }), B("automation:invoke", t, o), o;
  }
});
b.handle("sync:pull", async () => {
  try {
    return await Rr.pull();
  } catch (r) {
    throw console.error("[Main] sync:pull failed:", r), r;
  }
});
b.handle("backup:export", async (r, t) => {
  try {
    return await rt.exportData(void 0, t);
  } catch (e) {
    throw console.error("[Main] backup:export failed:", e), e;
  }
});
b.handle("backup:import", async (r, { filePath: t, password: e }) => {
  try {
    if (!t) {
      const n = await Re.showOpenDialog({
        title: "Import Backup",
        filters: [{ name: "Novel Editor Backup", extensions: ["nebak"] }],
        properties: ["openFile"]
      });
      if (n.canceled || n.filePaths.length === 0)
        return { success: !1, code: "CANCELLED" };
      t = n.filePaths[0];
    }
    return await rt.importData(t, e), { success: !0 };
  } catch (n) {
    console.error("[Main] backup:import failed:", n);
    const o = n.message || n.toString();
    return o.includes("PASSWORD_REQUIRED") ? { success: !1, code: "PASSWORD_REQUIRED", filePath: t } : o.includes("PASSWORD_INVALID") ? { success: !1, code: "PASSWORD_INVALID", filePath: t } : { success: !1, message: o };
  }
});
b.handle("backup:get-auto", async () => {
  try {
    return await rt.getAutoBackups();
  } catch (r) {
    throw console.error("[Main] backup:get-auto failed:", r), r;
  }
});
b.handle("backup:restore-auto", async (r, t) => {
  try {
    return await rt.restoreAutoBackup(t), !0;
  } catch (e) {
    throw console.error("[Main] backup:restore-auto failed:", e), e;
  }
});
b.handle("sync:push", async () => {
  try {
    return await Rr.push();
  } catch (r) {
    throw console.error("[Main] sync:push failed:", r), r;
  }
});
b.handle("db:search", async (r, { novelId: t, keyword: e, limit: n = 20, offset: o = 0 }) => {
  try {
    return await At(t, e, n, o);
  } catch (a) {
    throw console.error("[Main] db:search failed:", a), a;
  }
});
b.handle("db:rebuild-search-index", async (r, t) => {
  try {
    return await pr(t);
  } catch (e) {
    throw console.error("[Main] db:rebuild-search-index failed:", e), e;
  }
});
b.handle("db:get-all-tags", async (r, t) => {
  try {
    return t ? (await u.tag.findMany({
      where: { novelId: t },
      orderBy: { name: "asc" },
      select: { name: !0 }
    })).map((n) => n.name) : [];
  } catch (e) {
    throw console.error("[Main] db:get-all-tags failed:", e), e;
  }
});
b.handle("db:get-plot-lines", async (r, t) => {
  try {
    return await u.plotLine.findMany({
      where: { novelId: t },
      include: {
        points: {
          include: { anchors: !0 },
          orderBy: { order: "asc" }
        }
      },
      orderBy: { sortOrder: "asc" }
    });
  } catch (e) {
    throw console.error("[Main] db:get-plot-lines failed:", e), e;
  }
});
b.handle("db:create-plot-line", async (r, t) => {
  try {
    const n = ((await u.plotLine.aggregate({
      where: { novelId: t.novelId },
      _max: { sortOrder: !0 }
    }))._max.sortOrder || 0) + 1, o = await u.plotLine.create({
      data: { ...t, sortOrder: n }
    });
    return ae("plotLine", o.id, "create-plot-line"), o;
  } catch (e) {
    throw console.error("[Main] db:create-plot-line failed. Data:", t, "Error:", e), e;
  }
});
b.handle("db:update-plot-line", async (r, t) => {
  try {
    const e = await u.plotLine.update({
      where: { id: t.id },
      data: t.data
    });
    return ae("plotLine", e.id, "update-plot-line"), e;
  } catch (e) {
    throw console.error("[Main] db:update-plot-line failed. ID:", t.id, "Error:", e), e;
  }
});
b.handle("db:delete-plot-line", async (r, t) => {
  try {
    const e = await u.plotLine.findUnique({ where: { id: t }, select: { novelId: !0 } }), n = await u.plotLine.delete({ where: { id: t } });
    return e != null && e.novelId && De(e.novelId, "plotLine", t, "delete-plot-line"), n;
  } catch (e) {
    throw console.error("[Main] db:delete-plot-line failed. ID:", t, "Error:", e), e;
  }
});
b.handle("db:create-plot-point", async (r, t) => {
  try {
    const { plotLineId: e } = t, o = ((await u.plotPoint.aggregate({
      where: { plotLineId: e },
      _max: { order: !0 }
    }))._max.order || 0) + 1, a = await u.plotPoint.create({
      data: { ...t, order: o }
    });
    return ae("plotPoint", a.id, "create-plot-point"), a;
  } catch (e) {
    throw console.error("[Main] db:create-plot-point failed. Data:", t, "Error:", e), e;
  }
});
b.handle("db:update-plot-point", async (r, t) => {
  try {
    const e = await u.plotPoint.update({
      where: { id: t.id },
      data: t.data
    });
    return ae("plotPoint", e.id, "update-plot-point"), e;
  } catch (e) {
    throw console.error("[Main] db:update-plot-point failed. ID:", t.id, "Error:", e), e;
  }
});
b.handle("db:delete-plot-point", async (r, t) => {
  try {
    const e = await u.plotPoint.findUnique({ where: { id: t }, select: { novelId: !0 } }), n = await u.plotPoint.delete({ where: { id: t } });
    return e != null && e.novelId && De(e.novelId, "plotPoint", t, "delete-plot-point"), n;
  } catch (e) {
    throw console.error("[Main] db:delete-plot-point failed. ID:", t, "Error:", e), e;
  }
});
b.handle("db:create-plot-point-anchor", async (r, t) => {
  try {
    return await u.plotPointAnchor.create({ data: t });
  } catch (e) {
    throw console.error("[Main] db:create-plot-point-anchor failed. Data:", t, "Error:", e), e;
  }
});
b.handle("db:delete-plot-point-anchor", async (r, t) => {
  try {
    return await u.plotPointAnchor.delete({ where: { id: t } });
  } catch (e) {
    throw console.error("[Main] db:delete-plot-point-anchor failed. ID:", t, "Error:", e), e;
  }
});
b.handle("db:reorder-plot-lines", async (r, { lineIds: t }) => {
  try {
    const e = t.map(
      (n, o) => u.plotLine.update({
        where: { id: n },
        data: { sortOrder: o }
      })
    );
    return await u.$transaction(e), { success: !0 };
  } catch (e) {
    throw console.error("[Main] db:reorder-plot-lines failed:", e), e;
  }
});
b.handle("db:reorder-plot-points", async (r, { plotLineId: t, pointIds: e }) => {
  try {
    const n = e.map(
      (o, a) => u.plotPoint.update({
        where: { id: o },
        data: { order: a, plotLineId: t }
      })
    );
    await u.$transaction(n);
    for (const o of e)
      ae("plotPoint", o, "reorder-plot-points");
    return { success: !0 };
  } catch (n) {
    throw console.error("[Main] db:reorder-plot-points failed:", n), n;
  }
});
b.handle("db:upload-character-image", async (r, { characterId: t, type: e }) => {
  try {
    const n = await Re.showOpenDialog($, {
      title: e === "avatar" ? "Select Avatar Image" : "Select Full Body Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (n.canceled || n.filePaths.length === 0)
      return null;
    const o = n.filePaths[0], a = k.extname(o), s = k.join(O.getPath("userData"), "characters", t);
    if (N.existsSync(s) || N.mkdirSync(s, { recursive: !0 }), e === "avatar") {
      const i = `avatar${a}`, l = k.join(s, i);
      N.readdirSync(s).filter((C) => C.startsWith("avatar.")).forEach((C) => {
        try {
          N.unlinkSync(k.join(s, C));
        } catch {
        }
      }), N.copyFileSync(o, l);
      const m = `characters/${t}/${i}`;
      return await u.character.update({
        where: { id: t },
        data: { avatar: m }
      }), { path: m };
    } else {
      const l = `fullbody_${Date.now()}${a}`, v = k.join(s, l);
      N.copyFileSync(o, v);
      const m = `characters/${t}/${l}`, C = await u.character.findUnique({ where: { id: t }, select: { fullBodyImages: !0 } });
      let I = [];
      try {
        I = JSON.parse((C == null ? void 0 : C.fullBodyImages) || "[]");
      } catch {
      }
      return I.push(m), await u.character.update({
        where: { id: t },
        data: { fullBodyImages: JSON.stringify(I) }
      }), { path: m, images: I };
    }
  } catch (n) {
    throw console.error("[Main] db:upload-character-image failed:", n), n;
  }
});
b.handle("db:delete-character-image", async (r, { characterId: t, imagePath: e, type: n }) => {
  try {
    const o = O.getPath("userData"), a = k.resolve(k.join(o, e));
    if (!a.startsWith(o + k.sep))
      throw new Error("Invalid image path: path traversal detected");
    if (N.existsSync(a) && N.unlinkSync(a), n === "avatar")
      await u.character.update({
        where: { id: t },
        data: { avatar: null }
      });
    else {
      const s = await u.character.findUnique({ where: { id: t }, select: { fullBodyImages: !0 } });
      let i = [];
      try {
        i = JSON.parse((s == null ? void 0 : s.fullBodyImages) || "[]");
      } catch {
      }
      i = i.filter((l) => l !== e), await u.character.update({
        where: { id: t },
        data: { fullBodyImages: JSON.stringify(i) }
      });
    }
  } catch (o) {
    throw console.error("[Main] db:delete-character-image failed:", o), o;
  }
});
b.handle("db:get-character-map-locations", async (r, t) => {
  try {
    return (await u.characterMapMarker.findMany({
      where: { characterId: t },
      include: {
        map: { select: { id: !0, name: !0, type: !0 } }
      }
    })).map((n) => ({
      mapId: n.map.id,
      mapName: n.map.name,
      mapType: n.map.type
    }));
  } catch (e) {
    return console.error("[Main] db:get-character-map-locations failed:", e), [];
  }
});
b.handle("db:get-characters", async (r, t) => {
  try {
    return await u.character.findMany({
      where: { novelId: t },
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
  } catch (e) {
    throw console.error("[Main] db:get-characters failed:", e), e;
  }
});
b.handle("db:get-character", async (r, t) => {
  try {
    return await u.character.findUnique({
      where: { id: t },
      include: {
        items: {
          include: { item: !0 }
        }
      }
    });
  } catch (e) {
    throw console.error("[Main] db:get-character failed:", e), e;
  }
});
b.handle("db:create-character", async (r, t) => {
  try {
    const e = typeof t.profile == "object" ? JSON.stringify(t.profile) : t.profile, n = await u.character.create({
      data: { ...t, profile: e }
    });
    return ae("character", n.id, "create-character"), n;
  } catch (e) {
    throw console.error("[Main] db:create-character failed:", e), e;
  }
});
b.handle("db:update-character", async (r, { id: t, data: e }) => {
  try {
    const n = typeof e.profile == "object" ? JSON.stringify(e.profile) : e.profile, o = await u.character.update({
      where: { id: t },
      data: { ...e, profile: n }
    });
    return ae("character", t, "update-character"), o;
  } catch (n) {
    throw console.error("[Main] db:update-character failed:", n), n;
  }
});
b.handle("db:delete-character", async (r, t) => {
  try {
    const e = await u.character.findUnique({ where: { id: t }, select: { novelId: !0 } });
    await u.character.delete({ where: { id: t } }), e != null && e.novelId && De(e.novelId, "character", t, "delete-character");
  } catch (e) {
    throw console.error("[Main] db:delete-character failed:", e), e;
  }
});
b.handle("db:get-items", async (r, t) => {
  try {
    return await u.item.findMany({
      where: { novelId: t },
      orderBy: { sortOrder: "asc" }
    });
  } catch (e) {
    throw console.error("[Main] db:get-items failed:", e), e;
  }
});
b.handle("db:get-item", async (r, t) => {
  try {
    return await u.item.findUnique({ where: { id: t } });
  } catch (e) {
    throw console.error("[Main] db:get-item failed:", e), e;
  }
});
b.handle("db:create-item", async (r, t) => {
  try {
    const n = ((await u.item.aggregate({
      where: { novelId: t.novelId },
      _max: { sortOrder: !0 }
    }))._max.sortOrder || 0) + 1, o = await u.item.create({
      data: { ...t, sortOrder: n }
    });
    return ae("item", o.id, "create-item"), o;
  } catch (e) {
    throw console.error("[Main] db:create-item failed:", e), e;
  }
});
b.handle("db:update-item", async (r, { id: t, data: e }) => {
  try {
    const n = await u.item.update({
      where: { id: t },
      data: { ...e, updatedAt: /* @__PURE__ */ new Date() }
    });
    return ae("item", t, "update-item"), n;
  } catch (n) {
    throw console.error("[Main] db:update-item failed:", n), n;
  }
});
b.handle("db:delete-item", async (r, t) => {
  try {
    const e = await u.item.findUnique({ where: { id: t }, select: { novelId: !0 } }), n = await u.item.delete({ where: { id: t } });
    return e != null && e.novelId && De(e.novelId, "item", t, "delete-item"), n;
  } catch (e) {
    throw console.error("[Main] db:delete-item failed:", e), e;
  }
});
b.handle("db:get-mentionables", async (r, t) => {
  try {
    const [e, n, o, a] = await Promise.all([
      u.character.findMany({
        where: { novelId: t },
        select: { id: !0, name: !0, avatar: !0, role: !0, isStarred: !0 },
        orderBy: [
          { isStarred: "desc" },
          { name: "asc" }
        ]
      }),
      u.item.findMany({
        where: { novelId: t },
        select: { id: !0, name: !0, icon: !0 },
        orderBy: { name: "asc" }
      }),
      u.worldSetting.findMany({
        where: { novelId: t },
        select: { id: !0, name: !0, icon: !0, type: !0 },
        orderBy: { name: "asc" }
      }),
      u.mapCanvas.findMany({
        where: { novelId: t },
        select: { id: !0, name: !0, type: !0 },
        orderBy: { name: "asc" }
      })
    ]);
    return [
      ...e.map((s) => ({ ...s, type: "character" })),
      ...n.map((s) => ({ ...s, type: "item" })),
      ...o.map((s) => ({ id: s.id, name: s.name, icon: s.icon, type: "world", role: s.type })),
      ...a.map((s) => ({ id: s.id, name: s.name, type: "map", role: s.type }))
    ];
  } catch (e) {
    throw console.error("[Main] db:get-mentionables failed:", e), e;
  }
});
b.handle("db:get-world-settings", async (r, t) => {
  try {
    return await u.worldSetting.findMany({
      where: { novelId: t },
      orderBy: { sortOrder: "asc" }
    });
  } catch (e) {
    throw console.error("[Main] db:get-world-settings failed:", e), e;
  }
});
b.handle("db:create-world-setting", async (r, t) => {
  try {
    const e = await u.worldSetting.findFirst({
      where: { novelId: t.novelId },
      orderBy: { sortOrder: "desc" }
    }), n = await u.worldSetting.create({
      data: {
        novelId: t.novelId,
        name: t.name,
        type: t.type || "other",
        sortOrder: ((e == null ? void 0 : e.sortOrder) || 0) + 1
      }
    });
    return ae("worldSetting", n.id, "create-world-setting"), n;
  } catch (e) {
    throw console.error("[Main] db:create-world-setting failed:", e), e;
  }
});
b.handle("db:update-world-setting", async (r, t, e) => {
  try {
    const n = await u.worldSetting.update({
      where: { id: t },
      data: e
    });
    return ae("worldSetting", t, "update-world-setting"), n;
  } catch (n) {
    throw console.error("[Main] db:update-world-setting failed:", n), n;
  }
});
b.handle("db:delete-world-setting", async (r, t) => {
  try {
    const e = await u.worldSetting.findUnique({ where: { id: t }, select: { novelId: !0 } }), n = await u.worldSetting.delete({ where: { id: t } });
    return e != null && e.novelId && De(e.novelId, "worldSetting", t, "delete-world-setting"), n;
  } catch (e) {
    throw console.error("[Main] db:delete-world-setting failed:", e), e;
  }
});
b.handle("db:get-maps", async (r, t) => {
  try {
    return await u.mapCanvas.findMany({
      where: { novelId: t },
      orderBy: { sortOrder: "asc" }
    });
  } catch (e) {
    throw console.error("[Main] db:get-maps failed:", e), e;
  }
});
b.handle("db:get-map", async (r, t) => {
  try {
    return await u.mapCanvas.findUnique({
      where: { id: t },
      include: {
        markers: { include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } } },
        elements: { orderBy: { z: "asc" } }
      }
    });
  } catch (e) {
    throw console.error("[Main] db:get-map failed:", e), e;
  }
});
b.handle("db:create-map", async (r, t) => {
  try {
    return await u.mapCanvas.create({ data: t });
  } catch (e) {
    throw console.error("[Main] db:create-map failed:", e), e;
  }
});
b.handle("db:update-map", async (r, { id: t, data: e }) => {
  try {
    const { markers: n, elements: o, createdAt: a, updatedAt: s, ...i } = e;
    return await u.mapCanvas.update({ where: { id: t }, data: i });
  } catch (n) {
    throw console.error("[Main] db:update-map failed:", n), n;
  }
});
b.handle("db:delete-map", async (r, t) => {
  try {
    const e = await u.mapCanvas.findUnique({ where: { id: t }, select: { background: !0, novelId: !0 } });
    if (e != null && e.background) {
      const n = k.join(O.getPath("userData"), e.background);
      N.existsSync(n) && N.unlinkSync(n);
    }
    return await u.mapCanvas.delete({ where: { id: t } });
  } catch (e) {
    throw console.error("[Main] db:delete-map failed:", e), e;
  }
});
b.handle("db:upload-map-bg", async (r, t) => {
  try {
    const e = await u.mapCanvas.findUnique({ where: { id: t }, select: { novelId: !0, background: !0 } });
    if (!e)
      return null;
    const n = await Re.showOpenDialog($, {
      title: "Select Map Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"]
    });
    if (n.canceled || n.filePaths.length === 0)
      return null;
    const o = n.filePaths[0], a = k.extname(o), s = k.join(O.getPath("userData"), "maps", e.novelId);
    if (N.existsSync(s) || N.mkdirSync(s, { recursive: !0 }), e.background) {
      const p = k.join(O.getPath("userData"), e.background);
      N.existsSync(p) && N.unlinkSync(p);
    }
    const i = `${t}${a}`, l = k.join(s, i);
    N.copyFileSync(o, l);
    const v = `maps/${e.novelId}/${i}`, C = Br.createFromPath(l).getSize(), I = C.width || 1200, g = C.height || 800;
    return await u.mapCanvas.update({
      where: { id: t },
      data: { background: v, width: I, height: g }
    }), { path: v, width: I, height: g };
  } catch (e) {
    throw console.error("[Main] db:upload-map-bg failed:", e), e;
  }
});
b.handle("db:get-map-markers", async (r, t) => {
  try {
    return await u.characterMapMarker.findMany({
      where: { mapId: t },
      include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
    });
  } catch (e) {
    throw console.error("[Main] db:get-map-markers failed:", e), e;
  }
});
b.handle("db:create-map-marker", async (r, t) => {
  try {
    return await u.characterMapMarker.create({
      data: t,
      include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
    });
  } catch (e) {
    throw console.error("[Main] db:create-map-marker failed:", e), e;
  }
});
b.handle("db:update-map-marker", async (r, { id: t, data: e }) => {
  try {
    return await u.characterMapMarker.update({
      where: { id: t },
      data: e,
      include: { character: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
    });
  } catch (n) {
    throw console.error("[Main] db:update-map-marker failed:", n), n;
  }
});
b.handle("db:delete-map-marker", async (r, t) => {
  try {
    return await u.characterMapMarker.delete({ where: { id: t } });
  } catch (e) {
    throw console.error("[Main] db:delete-map-marker failed:", e), e;
  }
});
b.handle("db:get-map-elements", async (r, t) => {
  try {
    return await u.mapElement.findMany({
      where: { mapId: t },
      orderBy: { z: "asc" }
    });
  } catch (e) {
    throw console.error("[Main] db:get-map-elements failed:", e), e;
  }
});
b.handle("db:create-map-element", async (r, t) => {
  try {
    return await u.mapElement.create({ data: t });
  } catch (e) {
    throw console.error("[Main] db:create-map-element failed:", e), e;
  }
});
b.handle("db:update-map-element", async (r, { id: t, data: e }) => {
  try {
    const { createdAt: n, updatedAt: o, map: a, ...s } = e;
    return await u.mapElement.update({ where: { id: t }, data: s });
  } catch (n) {
    throw console.error("[Main] db:update-map-element failed:", n), n;
  }
});
b.handle("db:delete-map-element", async (r, t) => {
  try {
    return await u.mapElement.delete({ where: { id: t } });
  } catch (e) {
    throw console.error("[Main] db:delete-map-element failed:", e), e;
  }
});
b.handle("db:get-relationships", async (r, t) => {
  try {
    const [e, n] = await Promise.all([
      u.relationship.findMany({
        where: { sourceId: t },
        include: { target: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
      }),
      u.relationship.findMany({
        where: { targetId: t },
        include: { source: { select: { id: !0, name: !0, avatar: !0, role: !0 } } }
      })
    ]);
    return [...e, ...n];
  } catch (e) {
    throw console.error("[Main] db:get-relationships failed:", e), e;
  }
});
b.handle("db:create-relationship", async (r, t) => {
  try {
    return await u.relationship.create({
      data: t,
      include: {
        source: { select: { id: !0, name: !0, avatar: !0, role: !0 } },
        target: { select: { id: !0, name: !0, avatar: !0, role: !0 } }
      }
    });
  } catch (e) {
    throw console.error("[Main] db:create-relationship failed:", e), e;
  }
});
b.handle("db:delete-relationship", async (r, t) => {
  try {
    return await u.relationship.delete({ where: { id: t } });
  } catch (e) {
    throw console.error("[Main] db:delete-relationship failed:", e), e;
  }
});
b.handle("db:get-character-items", async (r, t) => {
  try {
    return await u.itemOwnership.findMany({
      where: { characterId: t },
      include: { item: !0 }
    });
  } catch (e) {
    throw console.error("[Main] db:get-character-items failed:", e), e;
  }
});
b.handle("db:add-item-to-character", async (r, t) => {
  try {
    const e = await u.itemOwnership.create({
      data: t,
      include: { item: !0 }
    });
    return ae("character", t.characterId, "add-item-to-character"), e;
  } catch (e) {
    throw console.error("[Main] db:add-item-to-character failed:", e), e;
  }
});
b.handle("db:remove-item-from-character", async (r, t) => {
  try {
    const e = await u.itemOwnership.findUnique({ where: { id: t }, select: { characterId: !0 } }), n = await u.itemOwnership.delete({ where: { id: t } });
    return e != null && e.characterId && ae("character", e.characterId, "remove-item-from-character"), n;
  } catch (e) {
    throw console.error("[Main] db:remove-item-from-character failed:", e), e;
  }
});
b.handle("db:update-item-ownership", async (r, t, e) => {
  try {
    const n = await u.itemOwnership.update({
      where: { id: t },
      data: e,
      include: { item: !0 }
    });
    return ae("character", n.characterId, "update-item-ownership"), n;
  } catch (n) {
    throw console.error("[Main] db:update-item-ownership failed:", n), n;
  }
});
b.handle("db:get-character-timeline", async (r, t) => {
  try {
    const e = await u.character.findUnique({ where: { id: t }, select: { name: !0, novelId: !0 } });
    if (!e)
      return [];
    const n = await u.plotPointAnchor.findMany({
      where: {
        plotPoint: {
          novelId: e.novelId,
          description: { contains: `@${e.name}` }
        }
      },
      include: {
        plotPoint: { select: { title: !0, description: !0, plotLine: { select: { name: !0 } } } },
        chapter: { select: { id: !0, title: !0, order: !0, volume: { select: { title: !0, order: !0 } } } }
      },
      orderBy: [{ chapter: { volume: { order: "asc" } } }, { chapter: { order: "asc" } }]
    }), o = /* @__PURE__ */ new Set();
    return n.filter((a) => a.chapter && !o.has(a.chapter.id) && o.add(a.chapter.id)).map((a) => {
      var s;
      return {
        chapterId: a.chapter.id,
        chapterTitle: a.chapter.title,
        volumeTitle: a.chapter.volume.title,
        order: a.chapter.order,
        volumeOrder: a.chapter.volume.order,
        snippet: ((s = a.plotPoint.description) == null ? void 0 : s.substring(0, 100)) || a.plotPoint.title
      };
    });
  } catch (e) {
    throw console.error("[Main] db:get-character-timeline failed:", e), e;
  }
});
function kt(r) {
  if (!r)
    return "";
  try {
    const t = JSON.parse(r);
    if (!t.root)
      return r;
    const e = [], n = (o) => {
      o.text && e.push(o.text), o.children && Array.isArray(o.children) && o.children.forEach(n), (o.type === "paragraph" || o.type === "heading" || o.type === "quote") && e.push(" ");
    };
    return n(t.root), e.join("").replace(/\s+/g, " ").trim();
  } catch {
    return r;
  }
}
b.handle("db:get-character-chapter-appearances", async (r, t) => {
  try {
    const e = await u.character.findUnique({ where: { id: t }, select: { name: !0, novelId: !0 } });
    return e ? (await u.chapter.findMany({
      where: {
        volume: { novelId: e.novelId },
        // Use LIKE for rough match on JSON string (imperfect but fast first filter)
        content: { contains: e.name }
      },
      select: {
        id: !0,
        title: !0,
        order: !0,
        content: !0,
        volume: { select: { title: !0, order: !0 } }
      },
      orderBy: [{ volume: { order: "asc" } }, { order: "asc" }]
    })).map((o) => {
      const a = kt(o.content || "");
      let s = "";
      const i = a.indexOf(e.name);
      if (i >= 0) {
        const l = Math.max(0, i - 30), v = Math.min(a.length, i + e.name.length + 50);
        s = (l > 0 ? "..." : "") + a.substring(l, v) + (v < a.length ? "..." : "");
      }
      return {
        chapterId: o.id,
        chapterTitle: o.title,
        volumeTitle: o.volume.title,
        order: o.order,
        volumeOrder: o.volume.order,
        snippet: s
      };
    }).filter((o) => o.snippet !== "") : [];
  } catch (e) {
    throw console.error("[Main] db:get-character-chapter-appearances failed:", e), e;
  }
});
b.handle("db:get-recent-chapters", async (r, t, e, n = 5) => {
  try {
    return await u.chapter.findMany({
      where: {
        volume: { novelId: e },
        content: { contains: `@${t}` }
      },
      select: {
        id: !0,
        title: !0,
        order: !0,
        wordCount: !0,
        updatedAt: !0
      },
      orderBy: { updatedAt: "desc" },
      take: n
    });
  } catch (o) {
    throw console.error("[Main] db:get-recent-chapters failed:", o), o;
  }
});
O.on("window-all-closed", () => {
  process.platform !== "darwin" && (O.quit(), $ = null);
});
O.on("before-quit", () => {
  Je && Je.stop().catch((r) => {
    console.error("[Main] Failed to stop automation server:", r);
  });
});
O.on("activate", () => {
  lr.getAllWindows().length === 0 && $r();
});
O.whenReady().then(async () => {
  var a, s, i;
  if (me.error) {
    Mt(O.getPath("userData")), cr(), console.error(`[AI-Diag] Invalid arguments: ${me.error}`), O.exit(2);
    return;
  }
  O.setAppUserModelId(Xo()), O.setName(O.isPackaged ? xr : Ko);
  const r = (a = me.command) != null && a.userDataPath ? k.resolve(me.command.userDataPath) : ra();
  if (O.setPath("userData", r), Mt(O.getPath("userData")), cr(), console.log("[Main] App Ready. Starting DB Setup..."), console.log("[Main] User Data Path:", O.getPath("userData")), me.command && O.isPackaged) {
    console.error("[AI-Diag] --ai-diag is only available in development mode."), O.exit(1);
    return;
  }
  (s = me.command) != null && s.userDataPath && console.log("[AI-Diag] userData override:", r);
  const t = k.resolve(O.getPath("userData"));
  jr.handle("local-resource", (l) => {
    const v = decodeURIComponent(l.url.replace("local-resource://", "")), m = k.resolve(k.join(t, v));
    return !m.startsWith(t + k.sep) && m !== t ? new Response("Forbidden", { status: 403 }) : Et.fetch("file:///" + m.replace(/\\/g, "/"));
  });
  let e;
  O.isPackaged && Pr() ? e = Yo() : e = O.getPath("userData"), ea();
  const n = (i = me.command) != null && i.dbPath ? k.resolve(me.command.dbPath) : k.join(e, "novel_editor.db"), o = `file:${n}`;
  if (console.log("[Main] Database Path:", n), N.existsSync(k.dirname(n)) || N.mkdirSync(k.dirname(n), { recursive: !0 }), !O.isPackaged) {
    const l = k.resolve(Le, "../../../packages/core/prisma/schema.prisma");
    if (console.log("[Main] Development mode detected (unpackaged). Checking schema at:", l), N.existsSync(l)) {
      const v = k.dirname(n);
      N.existsSync(v) || N.mkdirSync(v, { recursive: !0 }), console.log("[Main] Schema found."), console.log("[Main] Cleaning up FTS tables before migration..."), xt(o);
      try {
        await u.$executeRawUnsafe("DROP TABLE IF EXISTS search_index;"), console.log("[Main] FTS tables dropped successfully.");
      } catch (C) {
        console.warn("[Main] Failed to drop FTS table (non-critical):", C);
      }
      await u.$disconnect(), console.log("[Main] Attempting synchronous DB push to:", n);
      const m = k.resolve(Le, "../../../packages/core/node_modules/.bin/prisma.cmd");
      if (console.log("[Main] Using Prisma binary at:", m), !N.existsSync(m))
        console.error("[Main] Prisma binary NOT found at:", m);
      else
        try {
          const C = `"${m}" db push --schema="${l}" --accept-data-loss`;
          console.log("[Main] Executing command:", C);
          const I = Hr(C, {
            env: { ...process.env, DATABASE_URL: o },
            cwd: k.resolve(Le, "../../../packages/core"),
            stdio: "pipe",
            // Avoid inherit to prevent encoding issues
            windowsHide: !0
          });
          console.log("[Main] DB Push output:", I.toString()), console.log("[Main] DB Push completed successfully.");
        } catch (C) {
          console.error("[Main] DB Push failed."), C.stdout && console.log("[Main] stdout:", C.stdout.toString()), C.stderr && console.error("[Main] stderr:", C.stderr.toString());
        }
    } else
      console.warn("[Main] Schema file NOT found at:", l);
  }
  xt(o);
  try {
    await qr() && console.log("[Main] Bundled database schema applied successfully.");
  } catch (l) {
    throw console.error("[Main] Failed to ensure bundled database schema:", l), l;
  }
  if (F = new ao(() => O.getPath("userData")), on((l, v, m) => {
    ae(l, v, m);
  }), Ct = new yo(F, () => O.getPath("userData")), Je = new vo(
    Ct,
    () => O.getPath("userData"),
    (l) => {
      $ == null || $.webContents.send("automation:data-changed", { method: l });
    }
  ), await Je.start(), me.command)
    try {
      const l = await da(F, me.command);
      await u.$disconnect(), O.exit(l);
      return;
    } catch (l) {
      console.error("[AI-Diag] Execution failed:", l), await u.$disconnect(), O.exit(1);
      return;
    }
  await Jr(), console.log("[Main] Search index initialized");
  try {
    await Mr(F.getSettings());
  } catch (l) {
    console.warn("[Main] Failed to apply AI proxy settings:", l);
  }
  $r();
});
export {
  Ta as MAIN_DIST,
  Nr as RENDERER_DIST,
  St as VITE_DEV_SERVER_URL
};
