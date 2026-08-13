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


  // ── mini host SDK（@hana/plugin-sdk 协议兼容，免构建）──
  var PARENT = window.parent;
  var HOST_ORIGIN = pageParams.get("hana-host-origin") || "*";
  var hrdSeq = 0;

  // 宿主 capability 请求：postMessage hana.plugin.ui + kind:"request"，宿主按
  // manifest ui.hostCapabilities 白名单执行并回 response/error（如 clipboard.writeText）。
  function hostRequest(type, payload) {
    var id = "hrd-" + (++hrdSeq);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { cleanup(); reject(new Error("host 请求超时: " + type)); }, 8000);
      function onMsg(e) {
        if (e.source !== PARENT) return;
        var m = e.data;
        if (!m || m.id !== id || m.type !== type) return;
        cleanup();
        if (m.kind === "response") resolve(m.payload);
        else if (m.kind === "error") reject(new Error((m.error && m.error.message) || "host error"));
      }
      function cleanup() {
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
      }
      window.addEventListener("message", onMsg);
      PARENT.postMessage(
        { protocol: "hana.plugin.ui", version: 1, id: id, kind: "request", type: type, payload: payload },
        HOST_ORIGIN
      );
    });
  }

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

  // ── 状态机：Socket.IO 实时通道优先，轮询仅兑底 ──
  var timer = null;

  function refresh() {
    apiFetch("/ops/status?opId=" + encodeURIComponent(opId), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          renderFail((data && data.error) || "操作记录不存在");
          stop();
          return;
        }
        render(data.op);
        if (data.op.status !== "running") stop(); // 终局：停轮询 + 断 socket
      })
      .catch(function () { /* 瞬时网络错误静默重试 */ });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    // 终局主动断开：操作已完成，不再占连接（意外断线由 socket.io 重连承接）
    if (io && socketReady) {
      try { io.disconnect(); } catch (e) { /* ignore */ }
      socketReady = false;
    }
  }

  // ── Socket.IO 实时通道：按 opId 定向订阅（op:changed），state:changed 兑底 ──
  // socket.io 传输层自带 polling 兜底（websocket 不可用自动降级 HTTP 长轮询），
  // 无需手动双通道；仅当 socket-info 不可达（插件无本地 socket）才退手动轮询。
  // 认证带 role: card + opId：服务端按房间定向推送（op:<opId> 房间只推本操作）。
  var io = null;
  var socketReady = false;

  function setupSocket() {
    return apiFetch("/api/connections/socket-info", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (!info || !info.ok || !window.__hrdIo || !info.port || !info.token) return false;
        io = window.__hrdIo("http://127.0.0.1:" + info.port, {
          query: { token: info.token, role: "card", opId: opId },
          transports: ["websocket", "polling"],
          reconnectionAttempts: 8, // 断线有限重试，避免无限挂
          timeout: 5000,
        });
        io.on("connect", function () {
          socketReady = true;
          refresh(); // 连上即拉一次，补 socket 建立期间的变化
        });
        // 定向：本卡片关注的操作变化（房间 op:<opId> 只推这条）
        io.on("op:changed", function (ev) {
          if (ev && ev.opId && ev.opId !== opId) return;
          refresh();
        });
        // 兑底：open（连接建立初始同步）/ operation 全量广播
        io.on("state:changed", function (ev) {
          if (!ev || (ev.reason && ev.reason !== "operation" && ev.reason !== "open")) return;
          refresh();
        });
        io.on("disconnect", function () {
          socketReady = false;
        });
        return true;
      })
      .catch(function () { return false; });
  }


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

  // ── 折叠状态：用户显式操作优先于默认策略；跨 iframe 重建用 localStorage 持久化 ──
  // expanded：主行详情折叠；outputOpen：null=未操作（running 默认展开），bool=用户显式
  var state = {
    expanded: false,
    outputOpen: null,
    lastOutput: "",
    lastBadge: "",
  };

  try {
    var saved = JSON.parse(localStorage.getItem("hrd-card-" + opId) || "null");
    if (saved) {
      if (typeof saved.expanded === "boolean") state.expanded = saved.expanded;
      if (typeof saved.outputOpen === "boolean") state.outputOpen = saved.outputOpen;
    }
  } catch (e) { /* 隐私模式等场景忽略 */ }

  function persistState() {
    try { localStorage.setItem("hrd-card-" + opId, JSON.stringify({ expanded: state.expanded, outputOpen: state.outputOpen })); } catch (e) { /* ignore */ }
  }

  function toggleFold() {
    state.expanded = !state.expanded;
    persistState();
    var el = root.querySelector(".op");
    var btn = root.querySelector(".op-fold");
    if (el) el.classList.toggle("expanded", state.expanded);
    if (btn) btn.classList.toggle("open", state.expanded);
    reportSize();
  }

  // 输出区可见性：用户显式状态优先；从未操作时 running 默认展开
  function outputVisible(running) {
    return typeof state.outputOpen === "boolean" ? state.outputOpen : running;
  }

  // ── 增量渲染：首次建结构，后续只 patch 变化部分（不整卡重建）──
  // 避免每次轮询 innerHTML 全量替换导致展开状态/滚动位置被重置。
  var shellBuilt = false;

  function buildShell(op) {
    var html = "";
    html += '<div class="op">';
    // 主行：图标 + 状态文案（复用宿主 i18n 三态：正在…/看完了/打不开…）+ 徽标 + 耗时
    html += '<div class="op-row">';
    html += '<span class="op-icon"></span>';
    html += '<span class="op-text"></span>';
    html += '<span class="op-badge"></span>';
    html += '<span class="op-meta op-duration"></span>';
    html += '<button class="op-fold" id="op-fold" title="展开/收起详情">❯</button>';
    html += "</div>";
    // 副行：目标（命令/路径），hover 可复制；展开详情时取消溢出完整可见
    html += '<div class="op-sub"><span class="op-sub-text"></span><button class="op-copy" title="复制命令">⧉</button></div>';
    html += '<div class="op-summary"></div>';
    // 详情：工具 / 连接 / 退出码 / 耗时 / 开始 / 原因
    html += '<div class="op-detail">';
    html += '<div class="op-d-row"><span class="op-d-label">工具</span><span class="op-d-value op-d-tool"></span></div>';
    html += '<div class="op-d-row op-d-conn-row" style="display:none"><span class="op-d-label">连接</span><span class="op-d-value op-d-conn"></span></div>';
    html += '<div class="op-d-row op-d-exit-row" style="display:none"><span class="op-d-label">退出码</span><span class="op-d-value op-d-exit"></span></div>';
    html += '<div class="op-d-row"><span class="op-d-label">耗时</span><span class="op-d-value op-d-duration"></span></div>';
    html += '<div class="op-d-row"><span class="op-d-label">开始</span><span class="op-d-value op-d-started"></span></div>';
    html += '<div class="op-d-row op-d-reason-row" style="display:none"><span class="op-d-label">原因</span><span class="op-d-value op-d-reason"></span></div>';
    html += "</div>";
    // 完整输出：命令 stdout/stderr 收进详情区（可滚动）
    html += '<div class="op-output-wrap">';
    html += '<button class="op-output-toggle" id="op-output-toggle" title="展开/收起完整输出">输出 ▾</button>';
    html += '<pre class="op-output"></pre>';
    html += "</div>";
    html += "</div>";
    root.innerHTML = html;
    if (state.expanded) root.querySelector(".op").classList.add("expanded");
    root.querySelector(".op-fold").addEventListener("click", toggleFold);
    root.querySelector(".op-output-toggle").addEventListener("click", toggleOutput);
    root.querySelector(".op-copy").addEventListener("click", copyCommand);
    shellBuilt = true;
  }

  // ── 复制命令：宿主 capability（clipboard.writeText）→ clipboard API → execCommand → 自动选中 ──
  // 首选宿主桥接（manifest ui.hostCapabilities 已声明 clipboard.writeText，不受 iframe
  // opaque origin / Permissions-Policy 限制）；hostRequest 失败（老宿主/白名单未放开）
  // 时降级本地链路。最终兜底用 Selection 自动选中，选择不需要权限，必然可达。
  function copyCommand() {
    var text = root.querySelector(".op-sub-text").textContent || "";
    if (!text) return;
    hostRequest("clipboard.writeText", { text: text })
      .then(function () { doneCopy(true); })
      .catch(function () { legacyCopy(text); });
  }

  function legacyCopy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { doneCopy(true); }, function () { selectAndHint(); });
      return;
    }
    if (execCopy(text)) { doneCopy(true); return; }
    selectAndHint();
  }

  function execCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // 选中命令文本 + 按钮提示手动复制（不依赖 clipboard 权限）
  function selectAndHint() {
    var el = root.querySelector(".op-sub-text");
    if (el) {
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* ignore */ }
    }
    var btn = root.querySelector(".op-copy");
    if (!btn) return;
    btn.classList.add("copied");
    btn.textContent = "已选中";
    btn.title = "命令已选中，按 Ctrl+C 复制";
    setTimeout(function () {
      btn.classList.remove("copied");
      btn.textContent = "⧉";
      btn.title = "复制命令";
    }, 4000);
  }

  function doneCopy(ok) {
    var btn = root.querySelector(".op-copy");
    if (!btn) return;
    btn.classList.toggle("copied", ok);
    btn.textContent = ok ? "✓" : "✗";
    setTimeout(function () {
      btn.classList.remove("copied");
      btn.textContent = "⧉";
    }, 1200);
  }

  function patchText(sel, text) {
    var el = root.querySelector(sel);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function render(op) {
    if (!shellBuilt) buildShell(op);
    var running = op.status === "running";
    var ok = op.status === "ok";
    var badge = running ? "运行中" : ok ? "完成" : (op.reason || "失败");

    // 主行状态（变化才 patch）
    var icon = root.querySelector(".op-icon");
    if (icon) icon.textContent = op.emoji || "🔧";
    patchText(".op-text", op.text || op.tool || "");
    var badgeEl = root.querySelector(".op-badge");
    if (badgeEl && (badgeEl.textContent !== badge || badgeEl.className !== "op-badge " + (running ? "run" : ok ? "ok" : "fail"))) {
      badgeEl.textContent = badge;
      badgeEl.className = "op-badge " + (running ? "run" : ok ? "ok" : "fail");
    }
    patchText(".op-duration", fmtDuration(op.durationMs));

    // 副行 / 摘要：成功路径的结果一律收进「输出」折叠区（详情展开才看），
    // 摘要行只承载错误提示（失败一眼可见）；副行保持命令/目标不动。
    patchText(".op-sub-text", op.label || "");
    var sumEl = root.querySelector(".op-summary");
    if (sumEl) {
      var sum = op.summary || "";
      var show = !ok && !!sum;
      if (sumEl.textContent !== (show ? sum : "")) sumEl.textContent = show ? sum : "";
      sumEl.classList.toggle("err", show);
    }

    // 输出区：增量追加（不重建 pre，滚动位置不被重置）
    var outOpen = outputVisible(running);
    var wrap = root.querySelector(".op-output-wrap");
    if (wrap) wrap.classList.toggle("open", outOpen);
    var toggleBtn = root.querySelector(".op-output-toggle");
    if (toggleBtn) toggleBtn.textContent = "输出 " + (outOpen ? "▴" : "▾");
    var pre = root.querySelector(".op-output");
    if (pre) {
      var newText = op.output || "";
      if (newText.length > state.lastOutput.length) {
        pre.textContent += newText.slice(state.lastOutput.length);
        state.lastOutput = newText;
      }
      // 自动滚底：仅当用户视角在底部附近（回看历史时不被拉走）
      var nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
      if (outOpen && nearBottom) pre.scrollTop = pre.scrollHeight;
    }

    // 详情区（变化才 patch）
    patchText(".op-d-tool", op.tool || "");
    var conn = op.connInstance || op.connId || "";
    var connRow = root.querySelector(".op-d-conn-row");
    if (connRow) { connRow.style.display = conn ? "" : "none"; patchText(".op-d-conn", conn); }
    var exitRow = root.querySelector(".op-d-exit-row");
    if (exitRow) {
      exitRow.style.display = op.exitCode != null ? "" : "none";
      if (op.exitCode != null) patchText(".op-d-exit", op.exitCode);
    }
    patchText(".op-d-duration", fmtDuration(op.durationMs));
    patchText(".op-d-started", fmtTime(op.startedAt));
    var reasonRow = root.querySelector(".op-d-reason-row");
    if (reasonRow) {
      reasonRow.style.display = op.reason ? "" : "none";
      if (op.reason) patchText(".op-d-reason", op.reason);
    }

    reportSize();
  }

  function renderFail(msg) {
    root.innerHTML = '<div class="op"><div class="op-row"><span class="op-badge fail">' + esc(msg) + "</span></div></div>";
    reportSize();
  }

  // ── 输出区折叠：用户显式操作持久化，running 不再覆盖 ──
  function toggleOutput() {
    state.outputOpen = !outputVisible(root.querySelector(".op-output-wrap").classList.contains("open"));
    persistState();
    var wrap = root.querySelector(".op-output-wrap");
    var btn = root.querySelector(".op-output-toggle");
    if (wrap) wrap.classList.toggle("open", state.outputOpen);
    if (btn) btn.textContent = "输出 " + (state.outputOpen ? "▴" : "▾");
    reportSize();
  }

  // ── 启动 ──
  window.addEventListener("load", function () { setTimeout(reportSize, 60); });
  refresh(); // 首拉（创建态）
  setupSocket().then(function (ok) {
    // socket 可用：实时推送驱动，轮询不再启动
    // socket 不可用（socket-info 拿不到）：手动轮询兑底（慢速）
    if (!ok) timer = setInterval(refresh, 2500);
  });
})();
