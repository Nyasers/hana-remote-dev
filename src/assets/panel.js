// 远程 — HRD 配置管理页面（no-build iframe panel）
// 安全契约：凭据（password/privateKey/passphrase）只在表单提交那一刻
// 出现在请求体里；输入框提交后立即清空；任何渲染都不回显凭据明文。
//
// 通信：经宿主 route 拿 socket-info（端口 + token），随后全部走插件本地
// Socket.IO 双向通道（C2S RPC + S2C state:changed）。
// socket.io-client 由页面壳内联注入（window.__hrdIo），避免子资源请求被宿主守卫拦截。

const io = window.__hrdIo;
if (typeof io !== "function") {
  throw new Error("socket.io bridge missing from shell document");
}

const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
let seq = 0;

function targetOrigin() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("hana-host-origin");
  if (explicit) return explicit;
  try {
    const origin = new URL(document.referrer).origin;
    // file:// 协议下 origin 序列化为 "null"，与宿主实际窗口不匹配，视为不可用
    return origin === "null" ? "*" : origin;
  } catch {
    // 宿主页面为 file:// 或 referrer 缺失时无法预测宿主 origin，回退 "*"。
    // 安全兜底：面板接收侧已校验 evt.source === window.parent + 随机 request id，
    // 且本地 iframe 受同源/跨域限制，伪造注入在桌面端实际不可达。
    return "*";
  }
}

function post(message) {
  window.parent.postMessage(message, targetOrigin());
}

function event(type, payload) {
  post({ protocol: PROTOCOL, version: VERSION, kind: "event", type, payload });
}

function request(type, payload, timeoutMs = 10000) {
  const id = `hana-plugin-${Date.now()}-${++seq}`;
  const origin = targetOrigin();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`Host request timed out: ${type}`));
    }, timeoutMs);

    function onMessage(evt) {
      if (evt.source !== window.parent) return;
      if (origin !== "*" && evt.origin !== origin) return;
      const msg = evt.data || {};
      if (msg.protocol !== PROTOCOL || msg.version !== VERSION || msg.id !== id || msg.type !== type) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (msg.kind === "error") reject(new Error(msg.error?.message || `Host request failed: ${type}`));
      else resolve(msg.payload);
    }

    window.addEventListener("message", onMessage);
    post({ protocol: PROTOCOL, version: VERSION, id, kind: "request", type, payload });
  });
}

function currentPluginId() {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(window.location.pathname || "");
  if (!match) throw new Error("Plugin API helper requires an iframe route under /api/plugins/:pluginId/.");
  return decodeURIComponent(match[1]);
}

function normalizePluginApiPath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Invalid plugin API path.");
  const trimmed = input.trim();
  if (
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes("#") ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) throw new Error("Invalid plugin API path.");
  const stripped = trimmed.replace(/^\/+/, "");
  if (!stripped || stripped.startsWith("./") || stripped === "api/plugins" || stripped.startsWith("api/plugins/")) {
    throw new Error("Invalid plugin API path. Use a route path relative to the current plugin.");
  }
  const queryIndex = stripped.indexOf("?");
  const rawPath = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped;
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (!segment) throw new Error("Invalid plugin API path.");
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Invalid plugin API path.");
    }
  }
  const parsed = new URL(`http://hana.local/${stripped}`);
  return `${segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/")}${parsed.search}`;
}

// 持续时间进制转换：毫秒 → 人类可读（<1s 留 ms；<1min 转 s；以上转 m+s）
function fmtDuration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) {
    const s = ms / 1000;
    return `${s >= 10 || s % 1 === 0 ? Math.round(s) : s.toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function pluginApiUrl(path) {
  return `${window.location.origin}/api/plugins/${encodeURIComponent(currentPluginId())}/${normalizePluginApiPath(path)}`;
}

function pluginApiFetch(path, init = {}) {
  const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
  if (!surfaceSession) throw new Error("hana.api.fetch requires pluginSurfaceSession in the iframe URL.");
  const headers = new Headers(init.headers || {});
  headers.set("X-Hana-Plugin-Surface-Session", surfaceSession);
  return fetch(pluginApiUrl(path), { ...init, headers });
}

const hana = {
  ready: () => event("hana.ready"),
  ui: { resize: (size) => event("ui.resize", size) },
  api: { url: pluginApiUrl, fetch: pluginApiFetch },
};

// ---- toast（页面内气泡，宿主 toast 无堆叠避让，多个会重叠，故自绘） ----

const toastRoot = document.createElement("div");
const toastTimers = new Set();

toastRoot.className = "toast-root";
document.addEventListener("DOMContentLoaded", () => document.body.append(toastRoot));

function showToast(message, type = "info") {
  if (!toastRoot.isConnected) document.body.append(toastRoot);
  const item = document.createElement("div");
  item.className = `toast toast-${type}`;
  item.textContent = message;
  item.addEventListener("click", () => dismiss(item));
  toastRoot.append(item);
  const timer = setTimeout(() => dismiss(item), 4000);
  toastTimers.add(timer);
  resize();
}

function dismiss(item) {
  if (!item.isConnected) return;
  item.classList.add("toast-out");
  setTimeout(() => {
    item.remove();
    resize();
  }, 180);
}

// ---- icons（内联 SVG，stroke 1.5，与 manifest 图标同风格） ----

const ICONS = {
  connect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>',
  disconnect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5"/><path d="M12 19h8"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>',
};

function icon(name) {
  return ICONS[name] || "";
}

/** 把图标字符串解析为真实 SVG 元素（仅限 ICONS 常量，非用户输入）。 */
function iconEl(name) {
  const tpl = document.createElement("template");
  tpl.innerHTML = icon(name);
  return tpl.content.firstElementChild;
}

// ---- app state ----

const root = document.getElementById("root");

/** @type {{id:string,host:string,port:number,username:string}[]} */
let activeConns = [];
let currentModal = null;
let currentConfirm = null;

// ---- render helpers ----

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function fmtDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${fmtDate(iso)} ${fmtTime(d)}`;
}

function fmtIdle(iso) {
  if (!iso) return "-";
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// ---- socket channel（RPC 双向通道，取代 REST / SSE） ----

let socket = null;
let socketState = "connecting";
let lastPingAt = null;
let disconnectedAt = null;

const SOCK_LABELS = {
  connected: { cls: "online", label: "实时" },
  connecting: { cls: "", label: "连接中" },
  reconnecting: { cls: "mid", label: "重连中" },
  disconnected: { cls: "off", label: "已断开" },
};

function setSocketState(state) {
  if (state === "reconnecting" || state === "disconnected") {
    // 只记首次断开时刻，重连过程中保持显示
    if (!disconnectedAt) disconnectedAt = new Date();
  } else {
    disconnectedAt = null;
  }
  socketState = state;
  renderSocketState();
}

/** 通道心跳（engine 层 ping）→ 更新时间显示 */
function setLastPing() {
  lastPingAt = new Date();
  renderSockTime();
}

function fmtTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 更新 header 里的通道状态胶囊（元素不存在则跳过，如全页错误态）。
 *  文案：● 实时|15:22:31|1.2 MB（状态|心跳时间|日志总大小）
 *  实时显示心跳时间；断开/重连显示断开时刻。 */
function renderSocketState() {
  const holder = document.querySelector(".sock[data-sock]");
  if (!holder) return;
  const m = SOCK_LABELS[socketState] || SOCK_LABELS.disconnected;
  let time;
  if (socketState === "connected") {
    time = lastPingAt ? fmtTime(lastPingAt) : "--:--:--";
  } else {
    time = disconnectedAt ? fmtTime(disconnectedAt) : "--:--:--";
  }
  holder.replaceChildren(
    el("span", { class: `dot ${m.cls}`.trim() }),
    document.createTextNode(`${m.label} | ${time} | `),
    el("span", { id: "sock-size" }, [logCfgSizeText])
  );
}

/** 心跳到达：更新时间后重绘胶囊。 */
function renderSockTime() {
  renderSocketState();
}

async function fetchSocketInfo() {
  const res = await hana.api.fetch("api/connections/socket-info");
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `socket-info HTTP ${res.status}`);
  }
  return data;
}

async function connectChannel() {
  const info = await fetchSocketInfo();
  const s = io(`http://127.0.0.1:${info.port}`, { query: { token: info.token } });

  // 监听先于 connect 注册：握手期间的推送（open 初始同步）不丢
  s.on("state:changed", () => {
    refreshAll().catch(() => {
      /* 静默：下一条推送或重连补齐 */
    });
  });
  // 通道状态：连接 / 断开 / 重连中 / 重连失败
  s.on("connect", () => {
    setSocketState("connected");
    setLastPing();
  });
  s.on("disconnect", () => setSocketState("reconnecting"));
  s.io.on("reconnect_attempt", () => setSocketState("reconnecting"));
  s.io.on("reconnect", () => {
    setSocketState("connected");
    setLastPing();
    // 重连成功后补拉一次，覆盖离线窗口
    loadList().catch(() => {
      /* 静默 */
    });
  });
  s.io.on("reconnect_failed", () => {
    setSocketState("disconnected");
    // 插件 reload 会换端口：旧端口重连不可能成功，重新拉端口再连。
    scheduleChannelRestart();
  });
  // 心跳：engine 层 ping 事件（默认每 25s 一次），更新时间显示
  s.io.engine?.on("ping", () => setLastPing());

  await new Promise((resolve, reject) => {
    s.once("connect", resolve);
    s.once("connect_error", reject);
  });
  socket = s;
  setSocketState("connected");
  return s;
}

async function startChannel() {
  if (socket) {
    try {
      socket.close();
    } catch {
      // ignore
    }
    socket = null;
  }
  return connectChannel();
}

let restartTimer = null;
function scheduleChannelRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    startChannel()
      .then(() => {
        // channel is healthy again: the timer's job is done. A later
        // loadList failure must not trigger a rebuild that would close
        // the now-valid socket (refresh failures are non-fatal; a real
        // disconnect re-fires reconnect_failed and reschedules).
        clearTimeout(restartTimer);
        loadList().catch(() => {});
      })
      .catch(() => scheduleChannelRestart());
  }, 3000);
}

function rpc(event, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(new Error("通道未连接"));
      return;
    }
    socket.timeout(10000).emit(event, payload, (err, result) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!result || result.ok === false) {
        reject(new Error(result?.error || `操作失败：${event}`));
        return;
      }
      resolve(result);
    });
  });
}

// ---- list rendering ----

function activeFor(profile) {
  return activeConns.find(
    (c) => c.host === profile.host && c.username === profile.username && (c.port || 22) === (profile.port || 22)
  );
}

async function loadList() {
  const data = await rpc("connections:list");
  activeConns = data.data?.active || [];
  const saved = data.data?.saved || [];
  renderList(saved);
  return saved;
}

/** 推送驱动总刷新：列表 + 已展开详情的实时数据（不重建详情 DOM，
 *  展开状态不再因重建丢失）。 */
async function refreshAll() {
  const saved = await loadList();
  await Promise.all(
    [...expandedIds]
      .map((id) => saved.find((x) => x.id === id))
      .filter(Boolean)
      .map((profile) => expandDetail(profile))
  );
}

function renderList(profiles) {
  root.replaceChildren();

  const header = el("header", { class: "hdr" }, [
    el("div", { class: "hdr-left" }, [
      el("span", { class: "hdr-title" }, ["远程"]),
      el("span", { class: "hdr-sub" }, ["SSH 连接配置"]),
      el("span", { class: "sock", "data-sock": "", title: "通道状态" }),
    ]),
    el("div", { class: "hdr-right" }, [
      el("button", { class: "btn primary", type: "button", onclick: () => openEditor(null) }, [
        el("span", { class: "btn-icon" }, [iconEl("plus")]),
        el("span", {}, ["新增"]),
      ]),
      el("button", { class: "btn ghost", type: "button", title: "插件配置", onclick: openLogCfgModal }, [
        el("span", { class: "btn-icon" }, [iconEl("gear")]),
        el("span", {}, ["设置"]),
      ]),
    ]),
  ]);
  root.append(header);
  renderSocketState();
  startLogCfgSize();

  if (profiles.length === 0) {
    root.append(el("div", { class: "state empty" }, [
      el("div", { class: "empty-icon" }, [iconEl("terminal")]),
      el("p", { class: "empty-title" }, ["还没有连接配置"]),
      el("p", { class: "empty-hint" }, ["添加一个远程主机，即可从这里连接与管理"]),
      el("button", { class: "btn primary", type: "button", onclick: () => openEditor(null) }, [
        el("span", { class: "btn-icon" }, [iconEl("plus")]),
        el("span", {}, ["新增配置"]),
      ]),
    ]));
    resize();
    return;
  }

  const list = el("div", { class: "list" });
  for (const p of profiles) list.append(renderProfile(p));
  root.append(list);
  // 列表重建后恢复展开状态（卡片已挂载；expandDetail 幂等）
  for (const id of [...expandedIds]) {
    const p = profiles.find((x) => x.id === id);
    if (p) expandDetail(p);
  }
  resize();
}

/** 会话日志三限配置（窗口式，对齐新增配置 modal）。
 * 主页胶囊合并展示：● 状态 | 心跳时间 | 日志总大小（30s 自刷新大小段）。 */
let logCfgTimer = null;
let logCfgSizeTimer = null;
let logCfgSizeText = "…";

/** 字节自动换算：B / KB / MB / GB（保留 1 位小数）。 */
function fmtBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b < 1024) return `${b} B`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** 刷新胶囊尾部大小段（30s 自刷新；元素不存在自停）。 */
async function refreshLogCfgSize() {
  try {
    const res = await rpc("session-log:get");
    if (!res?.ok) throw new Error(res?.error ?? "读取失败");
    logCfgSizeText = fmtBytes(res.data?.actual?.bytes ?? 0);
  } catch {
    logCfgSizeText = "读取失败";
  }
  const sizeEl = document.getElementById("sock-size");
  if (sizeEl) sizeEl.textContent = logCfgSizeText;
}

function startLogCfgSize() {
  refreshLogCfgSize();
  if (logCfgSizeTimer) clearInterval(logCfgSizeTimer);
  logCfgSizeTimer = setInterval(() => {
    if (!document.querySelector(".sock[data-sock]")) {
      clearInterval(logCfgSizeTimer);
      logCfgSizeTimer = null;
      return;
    }
    refreshLogCfgSize();
  }, 30000);
}

function openLogCfgModal() {
  closeModal();
  const modal = el("div", { class: "overlay", onclick: (e) => { if (e.target === modal) closeModal(); } }, [
    el("div", { class: "modal", id: "logcfg-modal" }, [
      el("h2", {}, ["插件配置"]),
      el("p", { class: "logcfg-section" }, ["会话日志"]),
      el("div", { class: "field-row" }, [
        el("div", { class: "field" }, [
          el("span", {}, ["单文件 (MB)"]),
          el("input", { type: "number", min: "0", step: "1", id: "logcfg-maxmb", class: "field-input" }),
        ]),
        el("div", { class: "field" }, [
          el("span", {}, ["目录总大小 (MB)"]),
          el("input", { type: "number", min: "0", step: "1", id: "logcfg-maxtotal", class: "field-input" }),
        ]),
      ]),
      el("small", { class: "field-hint" }, ["0 = 不设限。时间归档为主：昨日自动打包 tar.gz（按天不可变、可解压还原）；空间限制仅兜底异常——单文件超限截断、目录超限归档最旧。"]),
      el("p", { class: "logcfg-section" }, ["连接"]),
      el("div", { class: "field" }, [
        el("span", {}, ["空闲回收 (秒)"]),
        el("input", { type: "number", min: "1", step: "1", id: "logcfg-idle", class: "field-input" }),
      ]),
      el("small", { class: "field-hint" }, ["兜底回收：异常残留连接空闲超过该秒数自动断开（exec/sftp 结束、tty 会话关闭已即时释放；长驻 tty 会话固定 600s 回收）。"]),
      el("div", { class: "modal-footer" }, [
        el("button", { class: "btn ghost", type: "button", onclick: () => closeModal() }, ["取消"]),
        el("button", { class: "btn primary", type: "button", onclick: () => submitLogCfg() }, ["保存"]),
      ]),
    ]),
  ]);
  document.body.append(modal);
  currentModal = modal;
  const setVals = () => {
    const m = document.getElementById("logcfg-modal");
    if (!m) return;
    rpc("session-log:get")
      .then((res) => {
        if (!res?.ok) return;
        const { limits, idleTimeout } = res.data;
        m.querySelector("#logcfg-maxmb").value = limits.maxMB;
        m.querySelector("#logcfg-maxtotal").value = limits.maxTotalMB;
        m.querySelector("#logcfg-idle").value = idleTimeout;
      })
      .catch(() => {});
  };
  setVals();
  if (logCfgTimer) clearInterval(logCfgTimer);
  logCfgTimer = setInterval(() => {
    if (!document.getElementById("logcfg-modal")) {
      clearInterval(logCfgTimer);
      logCfgTimer = null;
      return;
    }
    setVals();
  }, 30000);
  resize();
}

async function submitLogCfg() {
  const modal = document.getElementById("logcfg-modal");
  if (!modal) return;
  const maxMB = Number(modal.querySelector("#logcfg-maxmb").value);
  const maxTotalMB = Number(modal.querySelector("#logcfg-maxtotal").value);
  const idleTimeout = Number(modal.querySelector("#logcfg-idle").value);
  if (![maxMB, maxTotalMB].every((v) => Number.isFinite(v) && v >= 0) || !Number.isFinite(idleTimeout) || idleTimeout < 1) {
    showToast("请输入非负整数（0 = 不设限）；空闲回收 ≥ 1 秒", "error");
    return;
  }
  try {
    const res = await rpc("session-log:set", { maxMB, maxTotalMB, idleTimeout });
    if (!res?.ok) throw new Error(res?.error ?? "保存失败");
    refreshLogCfgSize(); // 保存后立即刷新胶囊大小段
    showToast("会话日志上限已保存", "ok");
  } catch (err) {
    showToast(err.message, "error");
  }
}

/** 状态五态 + 叫停来源：ok / error / timeout / killed / interrupted（disconnect 用户叫停 | lost 被动丢失） */
function histStatusMeta(status, reason) {
  switch (status) {
    case "error":
      return { cls: "err", icon: "✗", text: "失败" };
    case "timeout":
      return { cls: "err", icon: "⏱", text: "超时" };
    case "killed":
      return { cls: "killed", icon: "⏹", text: "已终止" };
    case "interrupted":
      return reason === "disconnect"
        ? { cls: "killed", icon: "⏹", text: "已断开" }
        : { cls: "err", icon: "⚠", text: "连接丢失" };
    default:
      return { cls: "ok", icon: "✓", text: "完成" };
  }
}

/** 操作类型 → 宿主同款 emoji 图标（来源：宿主 locales tool.* 状态文案，视觉统一） */
const OP_KIND_ICONS = {
  exec: "💻", // bash
  copy: "📎", // stage_files（传输/交付语义）
  read: "📖",
  write: "✏️",
  edit: "✏️",
  find: "🔍",
  grep: "🔍",
  ls: "📂",
};
function kindIcon(kind) {
  return OP_KIND_ICONS[kind] || "🔧"; // _fallback
}

/** 聚合卡内的一行操作：类型图标 + 命令 + 右侧状态；点击行展开详情。 */
function renderOpRow(item) {
  const wrap = el("div", { class: "op-item" });
  if (item._kind === "running") {
    const row = el("div", { class: "op-row running" }, [
      el("span", { class: "op-kind", title: opKindLabel(item.kind) }, [kindIcon(item.kind)]),
      el("span", { class: "op-label", title: item.label }, [item.label]),
      el("span", { class: "op-state", title: "进行中" }, [
        el("span", { class: "op-status spin" }),
        el("span", {}, ["运行中"]),
      ]),
      item.killable
        ? el("button", { class: "btn ghost danger sm", type: "button", onclick: (e) => { e.stopPropagation(); killOperationConfirm(item); } }, ["终止"])
        : null,
    ]);
    row.onclick = () => wrap.classList.toggle("open");
    wrap.append(
      row,
      el("div", { class: "op-detail" }, [
        el("div", { class: "hist-detail-row" }, [
          el("span", { class: "dg-key" }, ["工具"]),
          el("span", {}, [item.tool || item.kind]),
        ]),
        el("div", { class: "hist-detail-row" }, [
          el("span", { class: "dg-key" }, ["命令"]),
          el("span", { class: "hist-cmd" }, [item.label || "-"]),
        ]),
        el("div", { class: "hist-detail-row" }, [
          el("span", { class: "dg-key" }, ["开始"]),
          el("span", {}, [fmtDateTime(item.startedAt)]),
        ]),
      ])
    );
  } else {
    const st = histStatusMeta(item.status, item.reason);
    const ms = fmtDuration(item.durationMs);
    // 完成态：✓ + 时长；异常态：图标 + 状态文字（完整语义进 title）
    const stateTxt = st.cls === "ok" && ms ? `${st.icon} ${ms}` : `${st.icon} ${st.text}`;
    const row = el("div", { class: `op-row ${st.cls}` }, [
      el("span", { class: "op-kind", title: opKindLabel(item.kind) }, [kindIcon(item.kind)]),
      el("span", { class: "op-label", title: item.label || item.tool }, [item.label || item.tool]),
      el("span", { class: "op-state", title: `${st.text}${ms ? ` · ${ms}` : ""}` }, [stateTxt]),
    ]);
    row.onclick = () => wrap.classList.toggle("open");
    const detail = el("div", { class: "op-detail" }, [
      el("div", { class: "hist-detail-row" }, [
        el("span", { class: "dg-key" }, ["工具"]),
        el("span", {}, [item.tool || item.kind]),
      ]),
      el("div", { class: "hist-detail-row" }, [
        el("span", { class: "dg-key" }, ["命令"]),
        el("span", { class: "hist-cmd" }, [item.label || "-"]),
      ]),
      el("div", { class: "hist-detail-row" }, [
        el("span", { class: "dg-key" }, ["耗时"]),
        el("span", {}, [`${item.durationMs}ms`]),
      ]),
      el("div", { class: "hist-detail-row" }, [
        el("span", { class: "dg-key" }, ["时间"]),
        el("span", {}, [fmtDateTime(item.startedAt)]),
      ]),
    ]);
    if (item.exitCode !== null && item.exitCode !== undefined) {
      detail.append(el("div", { class: "hist-detail-row" }, [
        el("span", { class: "dg-key" }, ["退出码"]),
        el("span", {}, [String(item.exitCode)]),
      ]));
    }
    detail.append(el("div", { class: "hist-summary" }, [item.summary || "(无输出)"]));
    wrap.append(row, detail);
  }
  return wrap;
}

function renderProfile(p) {
  const conn = activeFor(p);
  const online = !!conn;
  const endpoint = `${p.username || "-"}@${p.host}:${p.port}`;

  const meta = [el("span", { class: "endpoint" }, [endpoint])];
  if (p.keyPath) meta.push(el("span", { class: "meta-item", title: p.keyPath }, [`key ${p.keyPath}`]));
  if (p.proxyCommand) meta.push(el("span", { class: "meta-item", title: p.proxyCommand }, ["代理"]));
  meta.push(
    p.hasSecret
      ? el("span", { class: "badge has-secret" }, ["已存凭据"])
      : el("span", { class: "badge no-secret" }, ["无凭据"]),
    el("span", { class: "meta-item created" }, [fmtDate(p.createdAt)])
  );

  const actions = [];
  // 连接全自动（操作即建连、TTL 即断开）；强制释放入口在每条连接（批次卡）里。
  actions.push(el("button", { class: "btn ghost", type: "button", title: "编辑", onclick: () => openEditor(p) }, [
    el("span", { class: "btn-icon" }, [iconEl("edit")]),
    el("span", {}, ["编辑"]),
  ]));
  actions.push(el("button", { class: "btn ghost danger", type: "button", title: "删除", onclick: () => confirmDelete(p) }, [
    el("span", { class: "btn-icon" }, [iconEl("trash")]),
    el("span", {}, ["删除"]),
  ]));

  const detail = el("div", { class: "profile-detail", hidden: "" });

  const card = el("div", { class: `profile ${online ? "online" : "offline"}`, "data-id": p.id }, [
    el("div", { class: "profile-top" }, [
      el("div", { class: "profile-left" }, [
        el("button", {
          class: "expand-btn",
          type: "button",
          title: "展开详情（连接与会话）",
          onclick: () => toggleDetail(p),
        }, [iconEl("chevron")]),
        el("div", { class: "profile-alias" }, [
          el("span", { class: online ? "dot online" : "dot", title: online ? "已连接" : "未连接" }),
          el("span", { class: "alias", title: p.alias }, [p.alias]),
        ]),
      ]),
      el("div", { class: "profile-actions" }, actions),
    ]),
    el("div", { class: "profile-meta" }, meta),
    detail,
  ]);

  return card;
}

// ---- expandable detail (connection info + sessions) ----

const expandedIds = new Set();

async function toggleDetail(profile) {
  const card = findCard(profile.id);
  const detail = card?.querySelector(".profile-detail");
  if (!detail) return;

  if (expandedIds.has(profile.id)) {
    expandedIds.delete(profile.id);
    card.classList.remove("expanded");
    detail.hidden = true;
    detail.replaceChildren();
    resize();
    return;
  }

  expandedIds.add(profile.id);
  await expandDetail(profile);
}

/** 幂等展开：仅展开 + 拉取最新数据（不收起）。列表重建后恢复展开、
 *  推送刷新已展开详情时复用；重复调用安全（renderDetail 全量替换）。 */
async function expandDetail(profile) {
  const card = findCard(profile.id);
  const detail = card?.querySelector(".profile-detail");
  if (!detail) return;
  card.classList.add("expanded");
  detail.hidden = false;
  try {
    const [sres, ores] = await Promise.all([
      rpc("sessions:list", { ref: profile.id }),
      rpc("operations:list"),
    ]);
    renderDetail(detail, profile, sres.data?.sessions || [], ores.data?.operations || [], ores.data?.history || []);
  } catch (err) {
    detail.replaceChildren(el("div", { class: "detail-error" }, [err.message]));
  }
  resize();
}

function renderDetail(detail, profile, sessions, operations, history) {
  const parts = [];

  // 进行中 + 已完成合并，按连接实例分组（批次 = 一次连接的实例 id；
  // 历史兼容：无实例的旧记录 fallback 到 connId）。
  // cfg_* 是配置管理操作（不涉及连接使用），不显示在连接批次里。
  const isCfg = (t) => /cfg_/.test(t || "");
  const mine = operations.filter(
    (o) => !isCfg(o.tool) && (o.connId === profile.alias || o.connId === profile.id || o.connId === `${profile.id}#session`)
  );
  const myHist = (history || []).filter(
    (h) => !isCfg(h.tool) && (h.connId === profile.alias || h.connId === profile.id || h.connId === `${profile.id}#session`)
  );

  const groups = new Map();
  const groupAdd = (item) => {
    const key = item.connInstance || item.connId || "none";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  };
  for (const o of mine) groupAdd({ ...o, _kind: "running" });
  for (const h of myHist) groupAdd({ ...h, _kind: "done" });

  // All three dimensions empty: a single merged empty state, never two.
  if (mine.length === 0 && myHist.length === 0 && sessions.length === 0) {
    parts.push(el("div", { class: "detail-section" }, [
      el("div", { class: "detail-title" }, ["进行中的操作或会话（0）"]),
      el("p", { class: "detail-empty" }, ["无进行中的操作或会话"]),
    ]));
    detail.replaceChildren(...parts);
    return;
  }

  // 当前活跃连接（用于卡头匹配：按实例 id 或池 key）
  const conns = activeConns.filter(
    (c) => c.host === profile.host && c.username === profile.username && (c.port || 22) === (profile.port || 22)
  );

  // 批次卡统一按最后活动倒序（最新在上）；活跃连接通常就是刚操作完的，自然靠前
  const lastAt = (k) =>
    Math.max(...groups.get(k).map((i) => new Date(i.startedAt || i.lastActivityAt || 0).getTime()), 0);
  const keys = [...groups.keys()].sort((a, b) => lastAt(b) - lastAt(a));

  for (const k of keys) {
    // 组内按命令执行顺序（正序：先执行的在先）
    const items = groups.get(k).sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    const conn = conns.find((x) => x.instanceId === k || x.id === k);
    const running = items.some((i) => i._kind === "running");

    // 卡头：活跃连接（●）或断开批次（○）；端点固定在配置卡上，批次卡只认 conn id
    const head = [];
    // 窄栏时间戳缩短到「月/日 时:分:秒」（年份在 title 悬停完整版）
    const tsShort = (iso) => {
      if (!iso) return "-";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "-";
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    if (conn) {
      const fullTs = `自动建连 · 建立 ${fmtDateTime(conn.connectedAt)}`;
      const isSess = conn.id.endsWith("#session");
      // 短名：端点可读名（别名）；完整 HRD id 只在悬停 title 出现
      const shortName = `${isSess ? "会话 · " : ""}${conn.alias || conn.instanceId || conn.id}`;
      head.push(
        el("span", { class: "conn-dot on" }),
        el("span", { class: "conn-title", title: `${isSess ? "会话连接" : "连接"} · ${conn.instanceId || conn.id}` }, [shortName]),
        el("button", { class: "btn ghost sm", type: "button", title: "强制释放该连接（终止其上活动会话）", onclick: () => disconnectProfile(profile, conn) }, ["断开"]),
        el("span", { class: "conn-meta", title: fullTs }, [
          `自动建连 · ${tsShort(conn.connectedAt)}`,
        ])
      );
    } else {
      // 历史批次：行1 = 指示灯 + 端点名；行2 = 状态 · 操作数 · 最后活动时间
      const isNone = k === "none";
      const isSess = k === `${profile.id}#session`;
      // 短名：端点可读名（别名），完整 HRD id 只在悬停 title 出现
      const shortName = isNone ? "本地操作" : `${isSess ? "会话 · " : ""}${profile.name}`;
      const titleTxt = shortName;
      const timeTxt = isNone
        ? ""
        : `${running ? "进行中" : "已断开"} · ${items.length} 条操作 · ${tsShort(new Date(lastAt(k)).toISOString())}`;
      head.push(
        el("span", { class: "conn-dot off" }),
        el("span", { class: "conn-title", title: isNone ? titleTxt : `${shortName} · ${running ? "进行中" : "已断开"} · ${k}` }, [titleTxt]),
        el("span", { class: "conn-meta", title: timeTxt }, [timeTxt])
      );
    }
    const card = el("div", { class: "conn-card" + (conn ? "" : " closed") }, [
      el("div", { class: "conn-head" }, head),
    ]);
    const opsCard = el("div", { class: "ops-card" });
    for (const item of items) opsCard.append(renderOpRow(item));
    card.append(opsCard);
    parts.push(card);
  }

  // 会话独立区（tty 长驻，不随 exec 批次流转）
  if (sessions.length > 0) {
    const sessSection = el("div", { class: "detail-section" }, [
      el("div", { class: "detail-title" }, [`进行中的会话（${sessions.length}）`]),
    ]);
    for (const s of sessions) {
      sessSection.append(el("div", { class: "session-row" }, [
        el("div", { class: "session-info" }, [
          el("span", { class: "session-cmd", title: s.command }, [s.command]),
          el("span", { class: "session-meta" }, [`${s.sessionId} · 开始 ${fmtDateTime(s.startedAt)} · 空闲 ${fmtIdle(s.lastActivityAt)}`]),
        ]),
        el("button", { class: "btn ghost danger sm", type: "button", onclick: () => killSessionConfirm(s) }, ["终止"]),
      ]));
    }
    parts.push(sessSection);
  }

  detail.replaceChildren(...parts);
}

function opKindLabel(kind) {
  const map = {
    exec: "命令执行",
    copy: "传输",
    read: "读取",
    write: "写入",
    edit: "编辑",
    find: "查找",
    grep: "搜索",
    ls: "列表",
    file: "文件",
    cfg_connect: "连接",
    cfg_disconnect: "断开",
    cfg_edit: "配置编辑",
    cfg_list: "配置列表",
    cfg_remove: "配置删除",
    cfg_status: "状态",
  };
  return map[kind] || String(kind || "操作");
}

function killSessionConfirm(session) {
  closeConfirm();
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) closeConfirm(); } }, [
    el("div", { class: "modal confirm" }, [
      el("h2", {}, ["终止会话"]),
      el("p", {}, [`确定终止会话 ${session.sessionId}？`]),
      el("p", { class: "session-cmd-block" }, [session.command]),
      el("div", { class: "modal-footer" }, [
        el("button", { class: "btn ghost", type: "button", onclick: () => closeConfirm() }, ["取消"]),
        el("button", { class: "btn danger", type: "button", onclick: () => doKillSession(session) }, ["终止"]),
      ]),
    ]),
  ]);
  document.body.append(overlay);
  currentConfirm = overlay;
}

async function doKillSession(session) {
  const overlay = currentConfirm;
  if (!overlay) return;
  const btn = overlay.querySelector(".modal-footer .btn.danger");
  btn.disabled = true;
  btn.textContent = "终止中…";
  try {
    await rpc("sessions:kill", { sessionId: session.sessionId });
    showToast("会话已终止", "success");
    closeConfirm();
    await refreshAll(); // state:changed 也会推一次，这里直接拉最新
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "终止";
    showToast(err.message, "error");
  }
}

function killOperationConfirm(op) {
  closeConfirm();
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) closeConfirm(); } }, [
    el("div", { class: "modal confirm" }, [
      el("h2", {}, ["终止操作"]),
      el("p", {}, [`确定终止该操作？传输类操作会清理目标端已写入的部分文件。`]),
      el("p", { class: "session-cmd-block" }, [op.label]),
      el("div", { class: "modal-footer" }, [
        el("button", { class: "btn ghost", type: "button", onclick: () => closeConfirm() }, ["取消"]),
        el("button", { class: "btn danger", type: "button", onclick: () => doKillOperation(op) }, ["终止"]),
      ]),
    ]),
  ]);
  document.body.append(overlay);
  currentConfirm = overlay;
}

async function doKillOperation(op) {
  const overlay = currentConfirm;
  if (!overlay) return;
  const btn = overlay.querySelector(".modal-footer .btn.danger");
  btn.disabled = true;
  btn.textContent = "终止中…";
  try {
    await rpc("operations:kill", { opId: op.opId });
    showToast("操作已终止", "success");
    closeConfirm();
    await refreshAll();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "终止";
    showToast(err.message, "error");
  }
}

// ---- editor modal ----

function openEditor(profile) {
  closeModal();

  const editing = !!profile;
  const title = editing ? `编辑 ${profile.alias}` : "新增配置";

  const fields = [
    field("alias", "别名", editing ? profile.alias : "", editing ? "保存后修改生效" : "如 my-server，连接时用这个别名"),
    field("host", "主机", editing ? profile.host : ""),
    field("username", "用户名", editing ? (profile.username || "") : ""),
    el("div", { class: "field-row" }, [
      field("port", "端口", editing ? String(profile.port) : "22"),
    ]),
    field("proxyCommand", "代理命令（可选）", editing ? (profile.proxyCommand || "") : "", "如 ssh -W %h:%p bastion"),
  ];

  const secretNote = editing && profile.hasSecret
    ? el("p", { class: "modal-note" }, ["已存有凭据，凭据栏留空则保持不变"])
    : null;

  const authRow = el("div", { class: "radio-row" }, [
    radio("auth", "password", "密码", true),
    radio("auth", "key", "私钥", false),
  ]);
  const passwordField = field("password", "密码", "", "type=password");
  const keyField = el("div", { class: "field" }, [
    el("span", {}, ["私钥内容（PEM / PPK）"]),
    el("textarea", { id: "privateKey", placeholder: "-----BEGIN ..." }),
  ]);
  const passField = field("passphrase", "私钥口令（可选）", "", "type=password");

  const modal = el("div", { class: "overlay", onclick: (e) => { if (e.target === modal) closeModal(); } }, [
    el("div", { class: "modal" }, [
      el("h2", {}, [title]),
      ...fields,
      authRow,
      passwordField,
      keyField,
      passField,
      secretNote,
      el("div", { class: "modal-footer" }, [
        el("button", { class: "btn ghost", type: "button", onclick: () => closeModal() }, ["取消"]),
        el("button", { class: "btn primary", type: "button", onclick: () => submitEditor(editing, profile) }, [editing ? "保存" : "创建"]),
      ]),
    ]),
  ]);

  syncAuthVisibility(modal);

  document.body.append(modal);
  currentModal = modal;
  resize();
}

function syncAuthVisibility(modal) {
  const mode = modal.querySelector('input[name="auth"]:checked')?.value || "password";
  modal.querySelector("#password").closest(".field").style.display = mode === "password" ? "" : "none";
  modal.querySelector("#privateKey").closest(".field").style.display = mode === "key" ? "" : "none";
  modal.querySelector("#passphrase").closest(".field").style.display = mode === "key" ? "" : "none";
  modal.querySelectorAll('input[name="auth"]').forEach((r) => {
    r.addEventListener("change", () => syncAuthVisibility(modal));
  });
}

async function submitEditor(editing, profile) {
  const modal = currentModal;
  if (!modal) return;
  const val = (id) => modal.querySelector(`#${id}`)?.value.trim();

  const payload = {
    name: val("alias"),
    host: val("host"),
    username: val("username"),
    port: Number(val("port") || 22),
    proxyCommand: val("proxyCommand") || null,
  };

  // 凭据：只在提交这一刻从输入框读取；读后立即清空输入框
  const mode = modal.querySelector('input[name="auth"]:checked')?.value;
  if (mode === "password" && val("password")) payload.password = val("password");
  if (mode === "key" && val("privateKey")) payload.privateKey = val("privateKey");
  if (mode === "key" && val("passphrase")) payload.passphrase = val("passphrase");

  // 立即擦除凭据输入框
  modal.querySelector("#password").value = "";
  modal.querySelector("#privateKey").value = "";
  modal.querySelector("#passphrase").value = "";

  const btn = modal.querySelector(".modal-footer .btn.primary");
  btn.disabled = true;
  btn.textContent = editing ? "保存中…" : "创建中…";

  try {
    if (editing) {
      await rpc("connections:update", { id: profile.id, ...payload });
      showToast("配置已更新", "success");
    } else {
      await rpc("connections:save", payload);
      showToast("配置已创建", "success");
    }
    closeModal();
    await loadList();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = editing ? "保存" : "创建";
    showToast(err.message, "error");
  }
}

// ---- delete confirm ----

function confirmDelete(profile) {
  closeConfirm();
  const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) closeConfirm(); } }, [
    el("div", { class: "modal confirm" }, [
      el("h2", {}, ["删除配置"]),
      el("p", {}, [`确定删除「${profile.alias}」？关联的加密凭据会一并清除。`]),
      el("div", { class: "modal-footer" }, [
        el("button", { class: "btn ghost", type: "button", onclick: () => closeConfirm() }, ["取消"]),
        el("button", { class: "btn danger", type: "button", onclick: () => doDelete(profile) }, ["删除"]),
      ]),
    ]),
  ]);
  document.body.append(overlay);
  currentConfirm = overlay;
}

async function doDelete(profile) {
  const overlay = currentConfirm;
  if (!overlay) return;
  const btn = overlay.querySelector(".modal-footer .btn.danger");
  btn.disabled = true;
  btn.textContent = "删除中…";
  try {
    await rpc("connections:remove", { ref: profile.id });
    showToast("配置已删除", "success");
    closeConfirm();
    await loadList();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "删除";
    showToast(err.message, "error");
  }
}

// ---- connect / disconnect ----

async function connectProfile(profile) {
  const card = findCard(profile.id);
  const btn = card?.querySelector(".profile-actions .btn.accent");
  if (btn) { btn.disabled = true; btn.classList.add("busy"); }
  try {
    const data = await rpc("connections:connect", { ref: profile.id });
    showToast(`已连接 ${data.data?.alias || profile.alias}`, "success");
    await loadList();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.classList.remove("busy"); }
    showToast(err.message, "error");
  }
}

async function disconnectProfile(profile, conn) {
  const connId = conn?.id || null;
  const card = findCard(profile.id);
  const btn = card?.querySelector(".profile-actions .btn.ghost");
  if (btn) btn.disabled = true;

  // 有活动会话时先确认：断开将级联终止会话（仅统计目标连接上的）
  let sessionCount = 0;
  try {
    const res = await rpc("sessions:list", { ref: profile.id });
    const sesses = res.data?.sessions || [];
    sessionCount = connId ? sesses.filter((s) => s.connId === connId).length : sesses.length;
  } catch {
    // 查询失败不阻塞断开，按 0 处理
  }
  if (btn) btn.disabled = false;

  if (sessionCount > 0) {
    closeConfirm();
    const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) closeConfirm(); } }, [
      el("div", { class: "modal confirm" }, [
        el("h2", {}, ["断开连接"]),
        el("p", {}, [`确定断开「${profile.alias}」的连接？该连接上有 ${sessionCount} 个活动会话，将一并终止。`]),
        el("div", { class: "modal-footer" }, [
          el("button", { class: "btn ghost", type: "button", onclick: () => closeConfirm() }, ["取消"]),
          el("button", { class: "btn danger", type: "button", onclick: () => doDisconnect(profile, connId) }, ["断开"]),
        ]),
      ]),
    ]);
    document.body.append(overlay);
    currentConfirm = overlay;
    return;
  }

  doDisconnect(profile, connId);
}

async function doDisconnect(profile, connId) {
  const overlay = currentConfirm;
  const card = findCard(profile.id);
  const btn = card?.querySelector(".profile-actions .btn.ghost");
  if (overlay) {
    const dbtn = overlay.querySelector(".modal-footer .btn.danger");
    if (dbtn) {
      dbtn.disabled = true;
      dbtn.textContent = "断开中…";
    }
  }
  if (btn) btn.disabled = true;
  try {
    const res = await rpc("connections:disconnect", { ref: profile.id, connId });
    const terminated = res.data?.sessionsTerminated || 0;
    showToast(terminated > 0 ? `已断开（终止 ${terminated} 个会话）` : "已断开", "success");
    if (overlay) closeConfirm();
    await loadList();
  } catch (err) {
    if (btn) btn.disabled = false;
    if (overlay) {
      const dbtn = overlay.querySelector(".modal-footer .btn.danger");
      if (dbtn) {
        dbtn.disabled = false;
        dbtn.textContent = "断开";
      }
    }
    showToast(err.message, "error");
  }
}

function findCard(profileId) {
  return document.querySelector(`.profile[data-id="${profileId}"]`);
}

// ---- form field builders ----

function field(id, label, value = "", hint = "") {
  const inputAttrs = { id, class: "field-input" };
  if (hint === "type=password") {
    inputAttrs.type = "password";
    inputAttrs.autocomplete = "new-password";
  } else if (id === "port") {
    inputAttrs.type = "number";
    inputAttrs.min = "1";
    inputAttrs.max = "65535";
  } else {
    inputAttrs.type = "text";
  }
  if (id !== "password" && id !== "passphrase" && id !== "privateKey") {
    inputAttrs.value = value;
  }
  const children = [el("span", {}, [label])];
  if (id === "privateKey") {
    children.push(el("textarea", { id, placeholder: "-----BEGIN ..." }));
  } else {
    children.push(el("input", inputAttrs));
  }
  if (hint && hint !== "type=password") children.push(el("small", { class: "field-hint" }, [hint]));
  return el("div", { class: "field" }, children);
}

function radio(name, value, label, checked) {
  return el("label", {}, [
    el("input", { type: "radio", name, value, checked: checked ? "checked" : null }),
    label,
  ]);
}

// ---- misc ----

function closeModal() {
  if (currentModal) {
    // 关闭时彻底清除凭据输入框残留
    currentModal.querySelectorAll('input[type="password"], #privateKey').forEach((n) => { n.value = ""; });
    currentModal.remove();
    currentModal = null;
  }
}

function closeConfirm() {
  if (currentConfirm) {
    currentConfirm.remove();
    currentConfirm = null;
  }
}

function showError(err) {
  root.replaceChildren(
    el("header", { class: "hdr" }, [
      el("div", { class: "hdr-left" }, [
        el("span", { class: "hdr-title" }, ["远程"]),
        el("span", { class: "hdr-sub" }, ["SSH 连接配置"]),
      ]),
      el("div", { class: "hdr-right" }, [
        el("button", { class: "btn ghost", type: "button", title: "重试", onclick: () => loadList().catch(showError) }, [
          el("span", { class: "btn-icon" }, [iconEl("refresh")]),
          el("span", {}, ["重试"]),
        ]),
      ]),
    ]),
    el("div", { class: "state error" }, [`加载失败：${err.message}`])
  );
  resize();
}

function resize() {
  hana.ui.resize({ height: Math.max(320, document.body.scrollHeight + 8) });
}

// ---- boot ----

root.replaceChildren(el("div", { class: "state" }, ["加载中…"]));
startChannel()
  .then(() => loadList())
  .then(() => hana.ready())
  .catch((err) => {
    showError(err);
    hana.ready();
  });

// 页面回到前台时补一次刷新，覆盖重连窗口内的变化
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadList().catch(() => {
      /* 静默 */
    });
    checkBuild();
  }
});

// ---- build watcher（开发循环，仅 dev 模式启用） ----
// 面板代码已全内联进 HTML（rspack-bundle 形态），刷新页面即最新。
// 插件 reload 会卸载插件页面，重开标签页即全新 HTML，无需任何版本提示机制。
