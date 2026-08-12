// card-routes.js — 操作卡片路由
//   GET /card/op?opId=xxx   卡片页面（iframe 内容：轮询状态 + 渲染操作详情）
//   GET /ops/status?opId=xxx 操作状态 JSON（卡片轮询源）
//
// 设计：插件工具在宿主 UI 只有 _fallback 兜底（"🔧 忙碌中…"），卡片补足
// 操作详情（目标 / 状态 / 耗时 / 结果摘要）。状态文案**运行时直读宿主 locale**
// （artifacts/renderer/<ver>/locales/zh.json 的 tool 段），宿主更新文案后
// 卡片自动跟随，本地不维护副本（内置表仅作宿主文件读不到时的离线兜底）。
// {name} 占位符替换为执行会话的 Agent 名（agentName，工具调用时解析），
// 取不到回退 "HRD"。语言先行 zh，后续可随宿主 locale 切换。
// 卡片资源（card.css / card.js）运行时读盘（不缓存，改样式即时生效），
// 位置：插件根 app/（与 download-progress 的 app/ 同构）。

import fs from "node:fs";
import path from "node:path";
import { readOperation } from "./operations.js";
import { inlineSocketIo } from "./ui-routes.js";

const APP_DIR = path.join(__dirname, "..", "app");

// ---- 工具 → 宿主 tool 段 key 映射 ----
// 同名直用（ls/read/write/edit/find/grep）；exec_command 按操作形态分流：
// tty（kind="tty"，交互式终端）→ 宿主 terminal；非 tty（一次性命令）→
// 宿主 bash（宿主标准 shell 工具，无 tty 标记的历史记录兜底同 bash）。
// write_stdin 属 tty 输入 → terminal；file 借用宿主 truncate 的整理语义。
const TOOL_KEY = {
  exec_command: (kind) => (kind === "tty" ? "terminal" : "bash"),
  write_stdin: "terminal",
  file: "truncate",
};

// ---- 离线兜底（仅宿主 locale 文件读不到时使用；结构 = 宿主 zh.json 原文） ----
const FALLBACK_I18N = {
  ls: { emoji: "📂", running: "{name} 正在看文件夹里有什么", done: "{name} 看完了", failed: "{name} 打不开这个目录" },
  read: { emoji: "📖", running: "{name} 正在翻阅文件", done: "{name} 翻完了", failed: "{name} 没翻到" },
  write: { emoji: "✏️", running: "{name} 提笔写字中", done: "{name} 落笔了", failed: "{name} 笔没墨了" },
  edit: { emoji: "✏️", running: "{name} 提笔改字中", done: "{name} 改好了", failed: "{name} 越改越乱了" },
  find: { emoji: "🔍", running: "{name} 正在找文件", done: "{name} 找到了", failed: "{name} 翻遍了也没找到" },
  grep: { emoji: "🔍", running: "{name} 正在文件里翻找", done: "{name} 翻到了", failed: "{name} 翻了个遍，没有" },
  file: { emoji: "✂️", running: "{name} 正在整理文件", done: "{name} 整理好了", failed: "{name} 整理不动了" },
  bash: { emoji: "💻", running: "{name} 正在执行命令", done: "{name} 命令执行完毕", failed: "{name} 命令执行失败" },
  terminal: { emoji: "💻", running: "{name} 正在敲命令", done: "敲完了", failed: "命令执行失败" },
};
const FALLBACK_FALLBACK = { emoji: "🔧", running: "{name} 正在忙碌中…", done: "{name} 忙完了", failed: "{name} 没忙明白" };

// 宿主 locale 缓存：按文件 mtime 失效（宿主更新文案 1s 内自然生效）
const hostI18nCache = { tried: false, at: 0, mtimeMs: 0, tools: null, fallback: null };

/** 定位宿主根（artifacts/agents 的上一级）：插件数据目录 <root>/plugin-data/<id> 上提两级。 */
function hostRoot(ctx) {
  const dd = ctx?.dataDir || null;
  if (!dd) return null;
  const p1 = path.dirname(dd);
  if (path.basename(p1) === "plugin-data" || path.basename(p1) === "pluginData") return path.dirname(p1);
  return p1;
}

/** artifacts/renderer 下最高版本目录（ctx 无 appVersion 时的兜底）。 */
function latestRendererVersion(root) {
  try {
    const dir = path.join(root, "artifacts", "renderer");
    const vers = fs
      .readdirSync(dir)
      .filter((n) => /^\d+\.\d+\.\d+/.test(n))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        return 0;
      });
    return vers[0] || null;
  } catch {
    return null;
  }
}

/** 读宿主 zh.json 的 tool 段（mtime 缓存；失败返回 null）。 */
function loadHostToolI18n(ctx) {
  const now = Date.now();
  const c = hostI18nCache;
  if (c.tried && now - c.at < 1000) return c; // 1s 节流
  const root = hostRoot(ctx);
  if (root) {
    try {
      const ver = ctx?.appVersion || ctx?._appVersion || latestRendererVersion(root);
      const zh = path.join(root, "artifacts", "renderer", ver, "locales", "zh.json");
      const st = fs.statSync(zh);
      if (!c.tried || st.mtimeMs !== c.mtimeMs) {
        const json = JSON.parse(fs.readFileSync(zh, "utf8"));
        const tool = (json && typeof json === "object" && json.tool) || {};
        c.tools = tool;
        c.fallback = tool._fallback || null;
        c.mtimeMs = st.mtimeMs;
        c.tried = true;
        c.at = now;
        return c;
      }
      c.at = now;
      return c; // 文件未变化，沿用缓存
    } catch {
      c.tried = true;
      c.at = now;
      c.tools = null;
      c.fallback = null;
    }
  }
  return c;
}

/** 宿主文案拆 emoji：模板 "📂 {name} 看完了" → { emoji: "📂", text: "{name} 看完了" }。 */
function splitEmoji(text) {
  const s = String(text ?? "");
  const m = s.match(/^(\p{Extended_Pictographic}\uFE0F?)/u);
  if (!m) return { emoji: "", text: s };
  return { emoji: m[1], text: s.slice(m[1].length) };
}

/** 取某工具的三态文案（宿主优先，离线兜底），返回 { emoji, running, done, failed }。
 *  kind 供 exec_command 分流（tty → terminal，非 tty/无标记 → bash）。 */
function entryFor(tool, ctx, kind) {
  const cache = loadHostToolI18n(ctx);
  const mapped = TOOL_KEY[tool];
  const key = typeof mapped === "function" ? mapped(kind) : mapped || tool;
  const raw = (cache.tools && (cache.tools[key] || cache.fallback)) || null;
  if (raw && typeof raw === "object") {
    const r = splitEmoji(raw.running);
    return {
      emoji: r.emoji || "🔧",
      running: r.text,
      done: splitEmoji(raw.done).text,
      failed: splitEmoji(raw.failed).text,
    };
  }
  return FALLBACK_I18N[key] || FALLBACK_FALLBACK;
}

/** 状态文案：{name} → Agent 名（取不到回退 HRD）。 */
function textFor(tool, state, agentName, ctx, kind) {
  const t = entryFor(tool, ctx, kind);
  const name = agentName || "HRD";
  return { emoji: t.emoji, text: (t[state] || t.done || "").replaceAll("{name}", name).trim() };
}

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readCardAssets() {
  return {
    css: fs.readFileSync(path.join(APP_DIR, "card.css"), "utf-8"),
    js: fs.readFileSync(path.join(APP_DIR, "card.js"), "utf-8"),
  };
}

export default function registerCardRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;

  // 卡片页（iframe 内容）：opId 参数 + 宿主注入的主题样式。
  // socket.io-client 内联注入（与 /sidebar 同机制）：卡片经本地 Socket.IO
  // 订阅 state:changed（operation 变更实时推送），HTTP 轮询降级为断线兑底。
  app.get("/card/op", (c) => {
    const assets = readCardAssets();
    const opId = String(c.req.query("opId") || "");
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    return c.html(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>操作</title>
${hcLink}
<style>${assets.css}<\/style>
</head>
<body data-hana-theme="${esc(th)}">
<div id="op-root" data-op="${esc(opId)}"></div>
<script>window.__API="${base}";<\/script>
<script type="module">${inlineSocketIo()}<\/script>
<script type="module">${assets.js}<\/script>
</body>
</html>`);
  });

  // 状态轮询源：按 opId（h_xxx / op_xxx）查操作快照。
  // in-flight（operations Map）→ running 态（含增量输出）；落盘完成态 → 终局。
  // 流式卡片轮询由此从「执行中」一路推进到「完成」，无需宿主进行时挂卡机制。
  app.get("/ops/status", (c) => {
    const opId = String(c.req.query("opId") || "");
    if (!opId) return c.json({ ok: false, error: "缺少 opId" }, 400);
    const snap = readOperation(opId);
    if (!snap) return c.json({ ok: false, error: "操作记录不存在" }, 404);
    const state = snap.status === "running" ? "running" : snap.status === "ok" ? "done" : "failed";
    const t = textFor(snap.tool, state, snap.agentName, ctx, snap.kind);
    return c.json({
      ok: true,
      op: {
        opId: snap.opId,
        tool: snap.tool,
        kind: snap.kind,
        agentName: snap.agentName || null,
        emoji: t.emoji,
        text: t.text,
        label: snap.label,
        connId: snap.connId,
        connInstance: snap.connInstance,
        status: snap.status,
        reason: snap.reason,
        startedAt: snap.startedAt,
        durationMs: snap.durationMs,
        exitCode: snap.exitCode,
        summary: snap.summary,
        output: snap.output || "",
      },
    });
  });
}
