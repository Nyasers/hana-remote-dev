// card.js — 操作卡片前端（iframe 内执行）
// 轮询插件 /ops/status 拿操作快照，渲染 emoji + 文案 + 目标 + 状态 + 耗时 + 摘要。
// 含 mini host SDK（@hana/plugin-sdk 协议兼容，免构建）：ui.resize 高度自适应。
// 状态从服务端 /ops/status 返回（opId 查询完成态记录；进行时扩展保留轮询骨架）。

(function () {
  "use strict";

  var root = document.getElementById("op-root");
  if (!root) return;
  var API = window.__API || "";
  var pageParams = new URLSearchParams(location.search);
  var opId = (root && root.dataset.op) || pageParams.get("opId") || "";
  if (!opId) { root.innerHTML = '<div class="op"><div class="op-row"><span class="op-badge fail">缺少操作 ID</span></div></div>'; return; }

  // 本地连接带 token query，远程连接带 pluginSurfaceSession header（宿主认证）
  var LOOPBACK_TOKEN = pageParams.get("token") || "";
  var SURFACE_SESSION = pageParams.get("pluginSurfaceSession") || "";

  function apiUrl(path) {
    var url = API + path;
    if (LOOPBACK_TOKEN) {
      url += (url.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(LOOPBACK_TOKEN);
    }
    return url;
  }

  function apiFetch(path, init) {
    var headers = new Headers(init && init.headers);
    if (SURFACE_SESSION) headers.set("X-Hana-Plugin-Surface-Session", SURFACE_SESSION);
    return fetch(apiUrl(path), Object.assign({}, init || {}, { headers: headers }));
  }

  // ── mini host SDK：高度自适应（iframe 贴合内容，避免"浏览器窗口"感）──
  var PARENT = window.parent;
  var HOST_ORIGIN = pageParams.get("hana-host-origin") || "*";
  function reportSize() {
    try {
      // 必须用 body.scrollHeight（documentElement.scrollHeight 在内容不足时=视口高度）
      var h = Math.ceil(document.body ? document.body.scrollHeight : 0);
      if (!h || h < 24) h = 24;
      PARENT.postMessage(
        { protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: { width: 400, height: h } },
        HOST_ORIGIN
      );
    } catch (e) { /* 忽略 */ }
  }

  // ── 状态机：running 持续轮询（输出增量推进），完成态渲染一次即停 ──
  var timer = null;

  function poll() {
    apiFetch("/ops/status?opId=" + encodeURIComponent(opId), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          renderFail((data && data.error) || "操作记录不存在");
          stop();
          return;
        }
        render(data.op);
        if (data.op.status !== "running") stop(); // 终局停；running 持续轮询
      })
      .catch(function () { /* 瞬时网络错误静默重试 */ });
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function fmtDuration(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + "ms";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "s";
    return Math.round(s / 60) + "m " + Math.round(s % 60) + "s";
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    return hh + ":" + mm + ":" + ss;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── 折叠状态 ──
  var expanded = false;

  function toggleFold() {
    expanded = !expanded;
    var el = root.querySelector(".op");
    var btn = root.querySelector(".op-fold");
    if (el) el.classList.toggle("expanded", expanded);
    if (btn) btn.classList.toggle("open", expanded);
    reportSize();
  }

  function render(op) {
    var running = op.status === "running";
    var ok = op.status === "ok";
    var badge = running ? "运行中" : ok ? "完成" : (op.reason || "失败");
    var html = "";
    html += '<div class="op">';
    // 主行：图标 + 状态文案（复用宿主 i18n 三态：正在…/看完了/打不开…）+ 徽标 + 耗时
    html += '<div class="op-row">';
    html += '<span class="op-icon">' + esc(op.emoji || "🔧") + "</span>";
    html += '<span class="op-text">' + esc(op.text || op.tool) + "</span>";
    html += '<span class="op-badge ' + (running ? "run" : ok ? "ok" : "fail") + '">' + esc(badge) + "</span>";
    html += '<span class="op-meta">' + fmtDuration(op.durationMs) + "</span>";
    html += '<button class="op-fold" id="op-fold" title="展开/收起详情">❯</button>';
    html += "</div>";
    // 副行：目标（命令/路径）
    if (op.label) {
      html += '<div class="op-sub" title="' + esc(op.label) + '">' + esc(op.label) + "</div>";
    }
    if (op.summary) {
      html += '<div class="op-summary' + (ok ? "" : " err") + '">' + esc(op.summary) + "</div>";
    }
    // 完整输出：命令 stdout/stderr 收进详情区（可滚动），不在主行直接铺开；
    // running 时默认展开（实时看输出推进），终局回到用户手动折叠状态（默认收起）
    if (op.output) {
      var outOpen = outputOpen || running;
      html += '<div class="op-output-wrap' + (outOpen ? " open" : "") + '">';
      html += '<button class="op-output-toggle" id="op-output-toggle" title="展开/收起完整输出">输出 ' + (outOpen ? "▴" : "▾") + "</button>";
      html += '<pre class="op-output">' + esc(op.output) + "</pre>";
      html += "</div>";
    }
    html += '<div class="op-detail">';
    html += '<div class="op-d-row"><span class="op-d-label">工具</span><span class="op-d-value">' + esc(op.tool) + "</span></div>";
    if (op.connInstance || op.connId) html += '<div class="op-d-row"><span class="op-d-label">连接</span><span class="op-d-value">' + esc(op.connInstance || op.connId) + "</span></div>";
    if (op.exitCode != null) html += '<div class="op-d-row"><span class="op-d-label">退出码</span><span class="op-d-value">' + esc(op.exitCode) + "</span></div>";
    html += '<div class="op-d-row"><span class="op-d-label">耗时</span><span class="op-d-value">' + fmtDuration(op.durationMs) + "</span></div>";
    html += '<div class="op-d-row"><span class="op-d-label">开始</span><span class="op-d-value">' + fmtTime(op.startedAt) + "</span></div>";
    if (op.reason) html += '<div class="op-d-row"><span class="op-d-label">原因</span><span class="op-d-value">' + esc(op.reason) + "</span></div>";
    html += "</div>";
    html += "</div>";

    if (root.innerHTML !== html) root.innerHTML = html;
    reportSize();

    var foldBtn = document.getElementById("op-fold");
    if (foldBtn) foldBtn.addEventListener("click", toggleFold);
    var outputToggle = document.getElementById("op-output-toggle");
    if (outputToggle) outputToggle.addEventListener("click", toggleOutput);

    // running 时输出区随增量自动滚到底（盯着最新一行）
    if (running) {
      var pre = root.querySelector(".op-output");
      if (pre) pre.scrollTop = pre.scrollHeight;
    }
  }

  // ── 输出区折叠（默认收起，点击展开；iframe 高度自适应）──
  var outputOpen = false;

  function toggleOutput() {
    outputOpen = !outputOpen;
    var wrap = root.querySelector(".op-output-wrap");
    var btn = root.querySelector(".op-output-toggle");
    if (wrap) wrap.classList.toggle("open", outputOpen);
    if (btn) btn.textContent = outputOpen ? "输出 ▴" : "输出 ▾";
    reportSize();
  }

  function renderFail(msg) {
    root.innerHTML = '<div class="op"><div class="op-row"><span class="op-badge fail">' + esc(msg) + "</span></div></div>";
    reportSize();
  }

  // ── 启动 ──
  window.addEventListener("load", function () { setTimeout(reportSize, 60); });
  poll();
  timer = setInterval(poll, 600);
})();
