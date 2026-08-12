// card-routes.js — 操作卡片路由
//   GET /card/op?opId=xxx   卡片页面（iframe 内容：轮询状态 + 渲染操作详情）
//   GET /ops/status?opId=xxx 操作状态 JSON（卡片轮询源）
//
// 设计：插件工具在宿主 UI 只有 _fallback 兜底（"🔧 忙碌中…"），卡片补足
// 操作详情（目标 / 状态 / 耗时 / 结果摘要）。文案对齐宿主 i18n 的 per-tool
// 三态设计（running/done/failed + emoji），语言先行 zh，后续补全语言集。
// 卡片资源（card.css / card.js）运行时读盘（不缓存，改样式即时生效），
// 位置：插件根 app/（与 download-progress 的 app/ 同构）。

import fs from "node:fs";
import path from "node:path";
import { getHistory } from "./operations.js";

const APP_DIR = path.join(__dirname, "..", "app");

// ---- i18n（zh 先行；结构对齐宿主 zh.json 的 per-tool 三态） ----
// 宿主已覆盖的 key 直接抄值（read/write/edit/find/grep/ls）；
// terminal（💻 敲命令）给 exec_command / write_stdin；
// file 借用宿主 truncate 的整理语义（宿主无 copy 文案）。
const I18N = {
  exec_command: { emoji: "💻", running: "正在敲命令", done: "敲完了", failed: "命令执行失败" },
  write_stdin: { emoji: "💻", running: "正在敲命令", done: "敲完了", failed: "命令执行失败" },
  read: { emoji: "📖", running: "正在翻阅文件", done: "翻完了", failed: "没翻到" },
  write: { emoji: "✏️", running: "提笔写字中", done: "落笔了", failed: "笔没墨了" },
  edit: { emoji: "✏️", running: "提笔改字中", done: "改好了", failed: "越改越乱了" },
  find: { emoji: "🔍", running: "正在找文件", done: "找到了", failed: "翻遍了也没找到" },
  grep: { emoji: "🔍", running: "正在文件里翻找", done: "翻到了", failed: "翻了个遍，没有" },
  ls: { emoji: "📂", running: "正在看文件夹里有什么", done: "看完了", failed: "打不开这个目录" },
  file: { emoji: "📎", running: "正在整理文件", done: "整理好了", failed: "整理不动了" },
};
const I18N_FALLBACK = { emoji: "🔧", running: "正在忙碌中", done: "忙完了", failed: "没忙明白" };

function textFor(tool, state) {
  const t = I18N[tool] || I18N_FALLBACK;
  return { emoji: t.emoji, text: t[state] || t.done };
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

  // 卡片页（iframe 内容）：opId 参数 + 宿主注入的主题样式
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
<script>${assets.js}<\/script>
</body>
</html>`);
  });

  // 状态轮询源：按 opId（h_xxx 或 opRef）查完成态记录
  app.get("/ops/status", (c) => {
    const opId = String(c.req.query("opId") || "");
    if (!opId) return c.json({ ok: false, error: "缺少 opId" }, 400);
    const snap = getHistory(opId);
    if (!snap) return c.json({ ok: false, error: "操作记录不存在" }, 404);
    const t = textFor(snap.tool, snap.status === "ok" ? "done" : "failed");
    return c.json({
      ok: true,
      op: {
        opId: snap.opId,
        tool: snap.tool,
        kind: snap.kind,
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
      },
    });
  });
}
