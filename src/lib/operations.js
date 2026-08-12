import { appendEventLog, eventTs } from "./session-log.js";

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

let opCounter = 0;
const operations = new Map();
const listeners = new Set();

// 操作日志落盘目录（logs 根目录；null = 不落盘）。由 install 注入，
// 每次 recordHistory / updateHistory 追加一行 logs/operations/<date>.md。
let opLogDir = null;
export function setOperationLogDir(dir) {
  opLogDir = dir || null;
}

function appendOpLogLine(line) {
  if (!opLogDir) return;
  appendEventLog(opLogDir, "operations", line);
}

// label 可能含管道符（命令/路径），替换为 ¦ 保列对齐
const clean = (s) => String(s ?? "").replace(/\|/g, "¦");
function opLogLine(entry) {
  const d = entry.durationMs ?? 0;
  return `${eventTs()} | ${clean(entry.tool)} ${entry.status || "ok"} | ${clean(entry.connId) || "-"} | ${clean(entry.label)} | ${d}ms${entry.exitCode != null ? ` | exit ${entry.exitCode}` : ""}`;
}

// 已完成操作历史（环形缓冲，面板「已完成操作」区块的数据源）
const HISTORY_MAX = 50;
const history = [];

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
 * @param {object} entry { tool, label, connId, status, startedAt, durationMs, exitCode, summary, kind? }
 */
export function recordHistory(entry) {
  const id = `h_${Date.now().toString(36)}_${++opCounter}`;
  history.unshift({
    opId: id,
    tool: entry.tool || "tool",
    kind: entry.kind || kindForTool(entry.tool),
    label: entry.label || "",
    connId: entry.connId || null,
    connInstance: entry.connInstance || null,
    status: entry.status || "ok",
    reason: entry.reason || null,
    startedAt: entry.startedAt || new Date().toISOString(),
    durationMs: entry.durationMs ?? 0,
    exitCode: entry.exitCode ?? null,
    summary: entry.summary || "",
  });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  appendOpLogLine(opLogLine(entry));
  notifyChange();
  return id;
}

/**
 * Patch a finished history entry in place (used by tty sessions: the entry
 * is recorded when the session starts, then its outcome is written back
 * when the session eventually closes). No-op when the id is not found.
 * @param {string} id - opId returned by recordHistory
 * @param {object} patch - partial entry fields to merge
 */
export function updateHistory(id, patch) {
  const h = history.find((e) => e.opId === id);
  if (!h) return false;
  Object.assign(h, patch);
  // tty 会话结局回写：补一条 closed 行（启动行的状态是会话创建，非终局）
  appendOpLogLine(opLogLine({
    tool: h.tool,
    status: `${h.status} (closed)`,
    connId: h.connId,
    label: h.label,
    durationMs: h.durationMs,
    exitCode: h.exitCode,
  }));
  notifyChange();
  return true;
}

/** List finished operations (newest first). */
export function listHistory() {
  return history.map((h) => ({ ...h }));
}

/** Subscribe to operation changes. Returns an unsubscribe function. */
export function onOperationChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyChange() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // a listener must never break the registry
    }
  }
}

/**
 * Register a new in-flight operation.
 * @param {object} opts
 * @param {string} opts.connId - connection alias / profileId / pool key
 * @param {string} [opts.connInstance] - connection instance id (batch marker;
 *   distinguishes reconnects that share the same pool key)
 * @param {string} opts.kind - "exec" | "copy" | ...
 * @param {string} opts.label - human-readable description
 * @param {Function} [opts.kill] - invoked on operations:kill; must settle
 *   the operation (resolve/reject the tool call) and clean up partial
 *   artifacts. Optional: operations without a kill function are
 *   non-interruptible and the panel shows them without a kill button.
 * @returns {string} opId (globally unique)
 */
export function startOperation({ connId, connInstance, kind, label, kill }) {
  const opId = `op_${Date.now().toString(36)}_${++opCounter}`;
  operations.set(opId, {
    opId,
    connId: connId || null,
    connInstance: connInstance || null,
    kind: kind || "op",
    label: label || "",
    kill: typeof kill === "function" ? kill : null,
    startedAt: new Date(),
  });
  notifyChange();
  return opId;
}

/** Remove a finished operation. */
export function endOperation(opId) {
  if (!opId || !operations.has(opId)) return false;
  operations.delete(opId);
  notifyChange();
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
  notifyChange();
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
