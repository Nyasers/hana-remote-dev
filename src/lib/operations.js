import { appendEventLog, eventTs } from "./session-log.js";
import fs from "node:fs";
import path from "node:path";

/**
 * In-flight operation registry — the panel's window into one-shot tool work
 * (non-tty exec, file transfers). Decoupled from the connection pool: an
 * operation is created by a tool call, carries a kill function supplied by
 * the caller, and is removed when the call settles.
 *
 * Panel contract (C2S): operations:list → [{ opId, connId, kind, label,
 * startedAt }]; operations:kill { opId } → invokes the kill function.
 * Push (S2C): state:changed { reason: "operation" } on start/end/kill.
 */

// 模块级状态挂 globalThis：loadBundle() 每次 new Function 执行都会产生全新模块闭包，
// 若工具执行（onload 注册）与卡片 route（routes 壳）各持一份 operations，
// 历史互不可见（卡片会报「操作记录不存在」）。与 download-progress 的
// globalThis 单例同思路：闭包变量重新绑定，但都指向同一份状态对象。
const __G = (globalThis.__hrd_ops_state ??= {});
let opCounter = (__G.opCounter ??= 0);
const operations = (__G.operations ??= new Map());
const listeners = (__G.listeners ??= new Set());

// 操作日志落盘目录（logs 根目录；null = 不落盘）。由 install 注入，
// 每次 recordHistory / updateHistory 追加一行 logs/operations/<date>.md，
// 并写完整 JSON 记录 logs/ops/<date>/<opId>.json（插件重启后卡片按 opId 从文件读回）。
// 注意：loadBundle() 每次 new Function 都是新闭包（index.js 顶层 default 与 routes/card.js
// 各一次），opLogDir 必须像 operations 一样挂 __G 全局共享，否则 route 侧
// getHistory 读盘时拿到 null → 卡片 404「操作记录不存在」。
export function setOperationLogDir(dir) {
  __G.opLogDir = dir || null;
}

// 磁盘操作记录保留天数（超过自动清理；完成态不驻内存，磁盘按天归档）
const OP_RECORD_DAYS = 30;

function formatLocalDate(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** 从 opId（h_<base36ms>_<n> / op_<base36ms>_<n>）解析日期目录；失败返回 null */
function opDateDir(id) {
  const m = /^(?:h|op)_([0-9a-z]+)_/.exec(String(id || ""));
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  if (!Number.isFinite(ms) || ms < 1e12) return null; // 2020 年前的时间戳不合理
  return formatLocalDate(new Date(ms));
}

/** 完整 JSON 落盘：主记录 + opRef 双写（旧卡片 URL 用的是进行时 op_xxx，查得到） */
function persistRecord(record) {
  if (!__G.opLogDir || !record || !record.opId) return;
  try {
    const dir = path.join(__G.opLogDir, "ops", opDateDir(record.opId) || formatLocalDate(new Date()));
    fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(record);
    fs.writeFileSync(path.join(dir, `${record.opId}.json`), json, "utf8");
    if (record.opRef && record.opRef !== record.opId) {
      fs.writeFileSync(path.join(dir, `${record.opRef}.json`), json, "utf8");
    }
    pruneOpRecords();
  } catch {
    /* best effort：落盘失败不影响调用方 */
  }
}

/** 清理超过保留天数的 ops 日期目录 */
function pruneOpRecords() {
  try {
    const root = path.join(__G.opLogDir, "ops");
    if (!fs.existsSync(root)) return;
    const cutoff = Date.now() - OP_RECORD_DAYS * 86400000;
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory() && st.mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* 单个目录清理失败不阻断 */
      }
    }
  } catch {
    /* best effort */
  }
}

/** 从磁盘读回完整操作记录（完成态不驻内存，卡片/面板查询一律走这里） */
function readHistoryFromDisk(id) {
  if (!__G.opLogDir || !id) return null;
  try {
    const dir = opDateDir(id);
    if (dir) {
      const p = path.join(__G.opLogDir, "ops", dir, `${id}.json`);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
    }
    // 日期解析失败兜底：扫最近 OP_RECORD_DAYS 天的目录
    const root = path.join(__G.opLogDir, "ops");
    if (!fs.existsSync(root)) return null;
    const cutoff = Date.now() - OP_RECORD_DAYS * 86400000;
    for (const name of fs.readdirSync(root).sort().reverse()) {
      const dirPath = path.join(root, name);
      try {
        if (fs.statSync(dirPath).mtimeMs < cutoff) continue;
        const p = path.join(dirPath, `${id}.json`);
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        /* skip */
      }
    }
    return null;
  } catch {
    return null;
  }
}

function appendOpLogLine(line) {
  if (!__G.opLogDir) return;
  appendEventLog(__G.opLogDir, "operations", line);
}

// label 可能含管道符（命令/路径），替换为 ¦ 保列对齐
const clean = (s) => String(s ?? "").replace(/\|/g, "¦");
function opLogLine(entry) {
  const d = entry.durationMs ?? 0;
  return `${eventTs()} | ${clean(entry.tool)} ${entry.status || "ok"} | ${clean(entry.connId) || "-"} | ${clean(entry.label)} | ${d}ms${entry.exitCode != null ? ` | exit ${entry.exitCode}` : ""}`;
}

// 卡片详情完整输出上限（stdout/stderr，超出截断；完整记录在 session 日志落盘）
const OUTPUT_MAX_CHARS = 64 * 1024;

/** 工具名 → 操作类型归一化（历史条目 kind 字段；面板类型图标依赖） */
const TOOL_KIND = {
  exec_command: "exec",
  write_stdin: "exec",
  read: "read",
  write: "write",
  edit: "edit",
  find: "find",
  grep: "grep",
  ls: "ls",
  file: "copy",
};
function kindForTool(tool) {
  return TOOL_KIND[tool] || String(tool || "op");
}

/**
 * Record a finished tool call into the history buffer.
 * Called by the registerTool wrapper in bundle-entry (all tools, uniformly).
 * 完成态只落盘不驻内存：命令执行完即落盘，内存只留 in-flight operations Map。
 * @param {object} entry { tool, label, connId, connInstance, agentName, status, startedAt, durationMs, exitCode, summary, output, kind?, opRef? }
 *   entry.output - 完整输出（stdout/stderr），卡片详情展示；超长截断
 *   entry.output - 完整输出（stdout/stderr），卡片详情展示；超长截断
 */
export function recordHistory(entry) {
  const id = `h_${Date.now().toString(36)}_${++opCounter}`;
  const record = {
    opId: id,
    tool: entry.tool || "tool",
    kind: entry.kind || kindForTool(entry.tool),
    label: entry.label || "",
    connId: entry.connId || null,
    connInstance: entry.connInstance || null,
    // 卡片 {name} 占位符：操作时从 ctx 解析的 Agent 显示名（回退由渲染层兜底）
    agentName: entry.agentName || null,
    status: entry.status || "ok",
    reason: entry.reason || null,
    startedAt: entry.startedAt || new Date().toISOString(),
    durationMs: entry.durationMs ?? 0,
    exitCode: entry.exitCode ?? null,
    summary: entry.summary || "",
    output: String(entry.output || "").slice(0, OUTPUT_MAX_CHARS),
    // 关联 in-flight op（wrapTool 的 startOperation opId）；卡片按此查询完成态
    opRef: entry.opRef || null,
  };
  appendOpLogLine(opLogLine(entry));
  persistRecord(record);
  notifyChange(id);
  return id;
}

/**
 * Patch a finished history entry in place (used by tty sessions: the entry
 * is recorded when the session starts, then its outcome is written back
 * when the session eventually closes). No-op when the id is not found.
 * 完成态已不驻内存：读盘 → 合并 → 重写（插件重启后 tty 结局回写同样有效）。
 * @param {string} id - opId returned by recordHistory
 * @param {object} patch - partial entry fields to merge
 */
export function updateHistory(id, patch) {
  const rec = readHistoryFromDisk(id);
  if (!rec) return false;
  if (patch.output !== undefined) {
    patch.output = String(patch.output || "").slice(0, OUTPUT_MAX_CHARS);
  }
  Object.assign(rec, patch);
  // tty 会话结局回写：补一条 closed 行（启动行的状态是会话创建，非终局）
  appendOpLogLine(opLogLine({
    tool: rec.tool,
    status: `${rec.status} (closed)`,
    connId: rec.connId,
    label: rec.label,
    durationMs: rec.durationMs,
    exitCode: rec.exitCode,
  }));
  persistRecord(rec); // 结局回写同步到磁盘（旧 tty 卡片读到终局而非启动态）
  notifyChange(id);
  return true;
}

/** List finished operations (newest first). 完成态只落盘：从磁盘倒序读取。 */
export function listHistory(limit = 50) {
  if (!__G.opLogDir) return [];
  const out = [];
  try {
    const root = path.join(__G.opLogDir, "ops");
    if (!fs.existsSync(root)) return out;
    // 日期目录倒序（新→旧）；目录内只取主记录（跳过 op_ 双写副本），文件名倒序 ≈ 时间倒序
    for (const dir of fs.readdirSync(root).sort().reverse()) {
      const dirPath = path.join(root, dir);
      let files;
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      const mains = files.filter((f) => f.startsWith("h_") && f.endsWith(".json")).sort().reverse();
      for (const f of mains) {
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(dirPath, f), "utf8")));
        } catch {
          /* 单条损坏跳过 */
        }
        if (out.length >= limit) return out;
      }
    }
  } catch {
    /* best effort */
  }
  return out;
}

/**
 * Look up a finished operation by id. Accepts either the history id
 * (h_xxx) or the in-flight op id (op_xxx, via the opRef link).
 * Used by the operation card status route.
 * 完成态只落盘：无论内存有无都从磁盘读（卡片查询 = 一次小文件 IO）。
 * @param {string} id
 * @returns {object|null} history entry snapshot (sans internals)
 */
export function getHistory(id) {
  if (!id) return null;
  const fromDisk = readHistoryFromDisk(id);
  return fromDisk ? { ...fromDisk } : null;
}

/** Subscribe to operation changes. Returns an unsubscribe function. */
export function onOperationChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 通知订阅者：操作状态变化（opId 可空——连接池/会话等非操作变更不带） */
function notifyChange(opId) {
  for (const fn of [...listeners]) {
    try {
      fn(opId || null);
    } catch {
      // a listener must never break the registry
    }
  }
}

/** 追加 in-flight 操作输出（stream 模式增量；超长截断，内存只留最近窗口） */
let changeNotifyTimer = null;
function scheduleChangeNotify() {
  if (changeNotifyTimer) return;
  changeNotifyTimer = setTimeout(() => {
    changeNotifyTimer = null;
    notifyChange(opId);
  }, 250);
}
export function appendOpOutput(opId, chunk) {
  const op = operations.get(opId);
  if (!op) return false;
  const next = String(op.output || "") + String(chunk || "");
  op.output = next.length > OUTPUT_MAX_CHARS ? next.slice(-OUTPUT_MAX_CHARS) : next;
  op._updatedAt = Date.now();
  // stream 增量：throttle 广播（卡片 Socket.IO 实时推进，高频输出不刷屏）
  scheduleChangeNotify();
  return true;
}

/**
 * 读操作快照：in-flight 优先（running 态，含增量输出），否则磁盘完成态。
 * 卡片轮询 /ops/status 与 wait 工具都用它：进行时拿到 running + 当前输出，
 * 终局（recordHistory 落盘 + endOperation）后自动落到磁盘完成态。
 * @param {string} id - op_xxx（in-flight）或 h_xxx / op_xxx（完成态）
 * @returns {object|null}
 */
export function readOperation(id) {
  const op = operations.get(id);
  if (op) {
    return {
      opId: op.opId,
      tool: op.tool || "exec_command",
      kind: op.kind || "exec",
      agentName: op.agentName || null,
      label: op.label || "",
      connId: op.connId || null,
      connInstance: op.connInstance || null,
      status: "running",
      reason: null,
      startedAt: op.startedAt.toISOString(),
      durationMs: Date.now() - op.startedAt.getTime(),
      exitCode: null,
      summary: "",
      output: op.output || "",
    };
  }
  const fromDisk = readHistoryFromDisk(id);
  return fromDisk ? { ...fromDisk } : null;
}

/**
 * Register a new in-flight operation.
 * @param {object} opts
 * @param {string} opts.connId - connection alias / profileId / pool key
 * @param {string} [opts.connInstance] - connection id (HRD_xxx / HRD_x_...);
 *   panel groups operations by this id
 * @param {string} opts.kind - "exec" | "copy" | ...
 * @param {string} opts.label - human-readable description
 * @param {string} [opts.agentName] - Agent 显示名（卡片 {name} 占位符）
 * @param {string} [opts.tool] - 发起工具名（exec_command / 未来其他流式工具）
 * @param {Function} [opts.kill] - invoked on operations:kill; must settle
 *   the operation (resolve/reject the tool call) and clean up partial
 *   artifacts. Optional: operations without a kill function are
 *   non-interruptible and the panel shows them without a kill button.
 * @returns {string} opId (globally unique)
 */
export function startOperation({ connId, connInstance, kind, label, agentName, kill, tool }) {
  const opId = `op_${Date.now().toString(36)}_${++opCounter}`;
  operations.set(opId, {
    opId,
    tool: tool || null,
    connId: connId || null,
    connInstance: connInstance || null,
    kind: kind || "op",
    label: label || "",
    agentName: agentName || null,
    output: "",
    kill: typeof kill === "function" ? kill : null,
    startedAt: new Date(),
  });
  notifyChange(opId);
  return opId;
}

/** Remove a finished operation. */
export function endOperation(opId) {
  if (!opId || !operations.has(opId)) return false;
  operations.delete(opId);
  notifyChange(opId);
  return true;
}

/**
 * Kill an in-flight operation. No-op (returns false) when the operation is
 * gone or has no kill function.
 * @param {string} opId
 * @returns {boolean} whether a kill was dispatched
 */
export function killOperation(opId) {
  const op = operations.get(opId);
  if (!op || !op.kill) return false;
  try {
    op.kill();
  } catch {
    // a throwing kill handler must not break the panel's RPC; the op is
    // still removed once the work settles
  }
  notifyChange(opId);
  return true;
}

/** List in-flight operations (sans kill closures). */
export function listOperations() {
  return [...operations.values()].map((op) => ({
    opId: op.opId,
    connId: op.connId,
    connInstance: op.connInstance || null,
    kind: op.kind,
    label: op.label,
    startedAt: op.startedAt.toISOString(),
    killable: Boolean(op.kill),
  }));
}
