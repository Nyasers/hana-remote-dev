/**
 * HRD 资源协议端点：统一按 URI 访问连接/会话资源（RESTful 风格）。
 *
 * 设计（姐姐定稿）：
 *   单数 connection/session = 资源实例，复数 = 集合；
 *   动词进 body（connect/disconnect），不占路径段；
 *   session/<id>/detail 不绑定文件格式（协议不泄漏实现）。
 *
 * 路由表：
 *   GET    HRD://status                      → 连接/会话/操作总览
 *   GET    HRD://connections                 → 连接配置列表
 *   GET    HRD://connection/<alias>          → 单连接状态
 *   POST   HRD://connection/<alias>          → body.action: connect | disconnect
 *   PUT    HRD://connection/<alias>          → body = 编辑字段（host/username/port/凭据/alias）
 *   DELETE HRD://connection/<alias>          → 移除配置
 *   GET    HRD://session/<id>                → 记录文件实际位置 + 结局摘要（agent 自行决定 read/grep）
 *   GET    HRD://sessions                    → 会话列表（活跃 + 历史）
 *
 * 协议只负责定位，内容访问走通用工具（agent 拿到位置后用 read/grep 按需查询）。
 * 与宿主工具对应的文件类工具（read/write/edit/ls/grep/find/file）与
 * tty 生命周期（exec_command/write_stdin）保持专用，不并入。
 */

import fs from "node:fs";
import path from "node:path";
import { runtimeHolder } from "../lib/runtime.js";
import * as sessionLog from "../lib/session-log.js";
import * as cfgStatus from "./cfg_status.js";
import * as cfgList from "./cfg_list.js";
import * as cfgConnect from "./cfg_connect.js";
import * as cfgDisconnect from "./cfg_disconnect.js";
import * as cfgEdit from "./cfg_edit.js";
import * as cfgRemove from "./cfg_remove.js";
import { handleSave } from "../lib/channel-handlers.js";
import { guideMarkdown } from "../lib/guide.js";

// cfg_* 已并入 hrd 协议端点（不再单独注册），源码保留为内部实现供路由复用。
const CFG_TOOLS = {
  cfg_status: cfgStatus,
  cfg_list: cfgList,
  cfg_connect: cfgConnect,
  cfg_disconnect: cfgDisconnect,
  cfg_edit: cfgEdit,
  cfg_remove: cfgRemove,
};
function tool(name) {
  return CFG_TOOLS[name];
}

export const name = "hrd";
export const description =
  "HRD 资源协议端点：按 URI 定位连接/会话资源。GET HRD://status（总览）/ HRD://connections（配置列表）/ HRD://connection/<alias>（状态）/ HRD://session/<id>（会话记录位置+摘要）/ HRD://sessions（会话列表）/ HRD://guide（使用手册索引）/ HRD://guide/<章节>（章节详情，如 security/connection/protocol/exec/query）；POST HRD://connection/<alias> body={action:connect|disconnect|save}；PUT/DELETE 同 URI 编辑/移除配置。method 必须显式传（GET/POST/PUT/DELETE），不做推断。会话记录内容由 Agent 拿到位置后自行用 read/grep 查询。命令中不得内联凭据（curl -u、export TOKEN），删除连接配置必须先向用户确认。";

export const parameters = {
  type: "object",
  properties: {
    uri: {
      type: "string",
      description: "Resource URI, e.g. HRD://status, HRD://connection/my-server, HRD://session/<id>",
    },
    method: {
      type: "string",
      enum: ["GET", "POST", "PUT", "DELETE"],
      description: "HTTP-style method (ajax-style; default GET). Must be explicit for POST/PUT/DELETE — no inference from body.",
    },
    body: {
      type: "object",
      description: "POST: { action: \"connect\" | \"disconnect\" | \"save\" }（save 时随 body 传 host/username/password/privateKey/passphrase/proxyCommand 等创建字段）; PUT: connection edit fields (alias/host/username/port/password/privateKey/passphrase/proxyCommand); DELETE: { force?: true }.",
    },
  },
  required: ["uri"],
};

// ---- 路由解析（纯函数，可单测） ----

const URI_RE = /^HRD:\/\/([a-z][a-z0-9-]*(?:\/[a-zA-Z0-9._-]+)*)$/i;

/**
 * 解析 HRD URI。
 * @returns {object|null} { kind, alias?, id?, section? } — kind ∈
 *   status | connections | connection | connection-action | connection-edit |
 *   connection-delete | session | sessions | guide
 */
export function parseHrdUri(uri, method, body) {
  const m = URI_RE.exec(String(uri || "").trim());
  if (!m) return null;
  const raw = m[1].split("/");
  const segs = [String(raw[0]).toLowerCase(), ...raw.slice(1)]; // 仅资源名小写，alias/id 保留原样

  if (segs.length === 1) {
    if (segs[0] === "status") return { kind: "status" };
    if (segs[0] === "connections") return { kind: "connections" };
    if (segs[0] === "sessions") return { kind: "sessions" };
    if (segs[0] === "guide") return { kind: "guide", section: null }; // 手册根 → 索引
    return null;
  }
  if (segs[0] === "guide" && segs.length === 2) {
    return { kind: "guide", section: segs[1] }; // 章节名大小写不敏感（匹配时 upper）
  }
  if (segs[0] === "connection" && segs.length === 2) {
    const alias = segs[1]; // 配置别名大小写敏感，保留原样
    // method 必须显式（GET/POST/PUT/DELETE），不做 body 推断——调用方意图自描述，无歧义。
    const mth = String(method || "GET").toUpperCase();
    if (mth === "POST") return { kind: "connection-action", alias, action: body?.action };
    if (mth === "PUT") return { kind: "connection-edit", alias };
    if (mth === "DELETE") return { kind: "connection-delete", alias };
    return { kind: "connection", alias };
  }
  if (segs[0] === "session-read" && segs.length === 2) {
    return { kind: "session-read", id: segs[1] };
  }
  if (segs[0] === "session" && segs.length === 2) {
    return { kind: "session", id: segs[1] };
  }
  return null;
}

/** HRD://session/<id> → logsDir/session/<文件>（文件名白名单防穿越）。
 *  映射：session/<yyyy-mm-dd>/<id>.md（id 前 9 位 base36 编码毫秒时间戳，O(1) 定位）；
 *  解码失败/时间漂移时兜底扫描日期目录；旧格式 <hh-mm-ss>.<id>.md 与平铺 <id>.md 兼容。 */
export function resolveSessionDetail(id, logsDir) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(id || ""))) return null;
  const dir = path.join(logsDir, "session");
  // 1) O(1)：id 解码时间戳 → 确定性路径
  const t = sessionLog.sessionIdTime(id);
  if (t) {
    const p = path.join(dir, sessionLog.dayStamp(t), `${id}.md`);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* fallthrough */
    }
  }
  // 2) 兜底：扫描日期目录匹配 <id>.md 或旧格式 <hh-mm-ss>.<id>.md（有界目录）
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const hit = fs.readdirSync(path.join(dir, d.name)).find((f) => f === `${id}.md` || f.endsWith(`.${id}.md`));
      if (hit) return path.join(dir, d.name, hit);
    }
  } catch {
    /* best effort */
  }
  // 3) 存量平铺兼容
  return path.join(dir, `${id}.md`);
}

// ---- 工具执行 ----

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const route = parseHrdUri(input.uri, input.method, input.body);
  if (!route) {
    return {
      content: [{ type: "text", text: `无法解析 HRD URI：${input.uri}（参考：HRD://status / HRD://connection/<alias> / HRD://session/<id>/detail）` }],
    };
  }

  switch (route.kind) {
    case "status":
      return statusOverview(rd, ctx);
    case "connections":
      return connectionsList(rd, ctx);
    case "connection":
      return connectionStatus(rd, ctx, route.alias);
    case "connection-action":
      return connectionAction(rd, ctx, route.alias, route.action, input.body);
    case "connection-edit":
      return connectionEdit(rd, ctx, route.alias, input.body || {});
    case "connection-delete":
      return connectionDelete(rd, ctx, route.alias, input.body?.force === true);
    case "session":
      return sessionLocate(rd, ctx, route.id);
    case "session-read":
      return sessionRead(rd, ctx, route.id);
    case "sessions":
      return sessionsList(rd, ctx);
    case "guide":
      return guideRoute(route.section);
    default:
      return { content: [{ type: "text", text: `Unhandled route: ${route.kind}` }] };
  }
}

// ---- guide 手册（单一事实源：src/assets/guide.md 内联进 bundle） ----

/** 解析 guide.md：## 章节名 + 每节首非空行摘要 + 正文。 */
export function parseGuideSections(text) {
  const sections = [];
  const lines = String(text).split("\n");
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+([A-Za-z0-9_-]+)/.exec(line);
    if (m) {
      cur = { name: m[1].toUpperCase(), summary: "", body: [] };
      sections.push(cur);
    } else if (cur) {
      if (!cur.summary && line.trim()) cur.summary = line.trim().replace(/\s+/g, " ").slice(0, 72);
      cur.body.push(line);
    }
  }
  return sections;
}

/** help 风格索引：章节名对齐列 + 首行摘要（程序化生成，永远与正文同步）。 */
export function guideIndex() {
  const sections = parseGuideSections(guideMarkdown);
  const lines = ["有关某个章节的详细信息，请键入 HRD://guide/<章节名>", ""];
  for (const s of sections) lines.push(`${s.name.padEnd(14)}${s.summary}`);
  return lines.join("\n");
}

/** 章节正文；未知章节返回 null。 */
export function guideSection(name) {
  const target = String(name || "").toUpperCase();
  const sections = parseGuideSections(guideMarkdown);
  const hit = sections.find((s) => s.name === target);
  return hit ? hit.body.join("\n").trim() : null;
}

function guideRoute(section) {
  if (!section) {
    return { content: [{ type: "text", text: guideIndex() }], details: { guide: "index" } };
  }
  const body = guideSection(section);
  if (body === null) {
    return {
      content: [{ type: "text", text: `未知章节：${section}\n\n${guideIndex()}` }],
      details: { guide: "unknown", section },
    };
  }
  return { content: [{ type: "text", text: body }], details: { guide: "section", section: section.toUpperCase() } };
}

// ---- 路由实现（复用原 cfg_* 工具语义） ----

function statusOverview(rd, ctx) {
  return tool("cfg_status").execute({}, ctx);
}

function connectionsList(rd, ctx) {
  return tool("cfg_list").execute({}, ctx);
}

function connectionStatus(rd, ctx, alias) {
  return tool("cfg_status").execute({ connectionId: alias }, ctx);
}

async function connectionAction(rd, ctx, alias, action, body) {
  if (action === "connect") return tool("cfg_connect").execute({ connectionId: alias }, ctx);
  if (action === "disconnect") return tool("cfg_disconnect").execute({ connectionId: alias }, ctx);
  if (action === "save") {
    // 保存新配置（首次录入）：纯保存语义（不连接验证，主机离线也能录入）；
    // 复用面板保存路径（handleSave）：字段校验 + 凭据加密落库 + connection:add 审计。
    const { action: _drop, ...fields } = body || {};
    if (!rd.pathRef.isValidAlias(alias)) {
      return { content: [{ type: "text", text: `Invalid alias "${alias}": 2+ chars, no colon / slash / whitespace / @ (chars: letters, digits, . _ -).` }] };
    }
    const res = await handleSave(rd, { ...fields, name: alias });
    if (!res.ok) {
      return { content: [{ type: "text", text: `保存失败：${res.error}${res.status ? `（${res.status}）` : ""}` }] };
    }
    return { content: [{ type: "text", text: `Profile saved: ${alias} (${res.data.profile.username}@${res.data.profile.host}:${res.data.profile.port})` }] };
  }
  return { content: [{ type: "text", text: `POST HRD://connection/<alias> 需要 body.action = "connect" | "disconnect" | "save"，收到：${String(action)}` }] };
}

function connectionEdit(rd, ctx, alias, body) {
  return tool("cfg_edit").execute({ connectionId: alias, ...body }, ctx);
}

function connectionDelete(rd, ctx, alias, force) {
  return tool("cfg_remove").execute({ connectionId: alias, ...(force ? { force: true } : {}) }, ctx);
}

/** HRD://session-read/<id> → 会话记录内容（活跃目录优先，归档包按需提取兜底）。
 *  与 sessionLocate 互补：定位给位置，读取给内容（归档场景无法给出真实路径）。 */
function sessionRead(rd, ctx, id) {
  const live = rd.sshClient.listSessions().find((s) => s.sessionId === id);
  const p = live?.logger?.filePath || resolveSessionDetail(id, rd.logsDir);
  if (p && fs.existsSync(p)) {
    const text = fs.readFileSync(p, "utf8");
    return { content: [{ type: "text", text }], details: { sessionId: id, source: "file", bytes: Buffer.byteLength(text, "utf8") } };
  }
  const arch = resolveArchivedSession(id, rd.logsDir);
  if (arch) {
    const gz = fs.readFileSync(arch.gzPath);
    const hit = sessionLog.extractTarGz(gz, arch.entry);
    if (hit) {
      return { content: [{ type: "text", text: hit.toString("utf8") }], details: { sessionId: id, source: "archive", bytes: hit.length } };
    }
  }
  return { content: [{ type: "text", text: `会话 ${id} 无落盘记录（未找到活跃/归档文件）` }] };
}

/** HRD://session/<id> 归档兜底：按 sessionId 时间戳定位 session/<date>.tar.gz 包内条目。
 * @returns {object|null} { gzPath, entry, size } */
export function resolveArchivedSession(id, logsDir) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(id || ""))) return null;
  const t = sessionLog.sessionIdTime(id);
  if (!t) return null;
  const dir = path.join(logsDir, "session");
  const gzPath = path.join(dir, `${sessionLog.dayStamp(t)}.tar.gz`);
  if (!fs.existsSync(gzPath)) return null;
  try {
    const entries = sessionLog.listTarGz(gzPath);
    const hit = entries.find((e) => e.name === `${sessionLog.dayStamp(t)}/${id}.md` || e.name.endsWith(`/${id}.md`) || e.name.endsWith(`.${id}.md`));
    if (!hit) return null;
    return { gzPath, entry: hit.name, size: hit.size };
  } catch {
    return null;
  }
}

/**
 * 会话定位：返回记录文件实际位置 + 结局摘要，内容访问由 agent 自行决定
 * （read 读全文 / grep 搜模式 / 宿主工具按需处理；归档场景用 HRD://session-read/<id> 提取）。
 */
function sessionLocate(rd, ctx, id) {
  // 位置：活跃会话 → 日志器路径；已结束 → 历史快照 logPath；否则按命名规则推测
  const live = rd.sshClient.listSessions().find((s) => s.sessionId === id);
  const ended = rd.sshClient.getSessionHistory(id);
  const logPath = live?.logger?.filePath || ended?.logPath || resolveSessionDetail(id, rd.logsDir);
  const exists = logPath ? fs.existsSync(logPath) : false;
  const arch = !exists && !live ? resolveArchivedSession(id, rd.logsDir) : null;

  const lines = [`会话 ${id}:`];
  if (live) {
    lines.push(`  状态: ● 活跃中 "${live.command}" started ${live.startedAt.toISOString()}`);
  } else if (ended) {
    lines.push(
      `  状态: ○ 已结束 "${ended.command}"`,
      `  结局: ${howText(ended.how, ended.exitCode)}`,
      `  耗时: ${Math.round((ended.durationMs || 0) / 1000)}s`,
      `  起止: ${ended.startedAt.toISOString()} → ${ended.endedAt.toISOString()}`
    );
  } else {
    lines.push("  状态: 未找到（可能超出历史保留上限）");
  }
  if (exists) {
    lines.push(`  记录: ${logPath}`, "  内容请用 read/grep 按需查询（会话进行中即可读）。");
  } else if (arch) {
    lines.push(`  记录: 已归档（${path.basename(arch.gzPath)} 内条目 ${arch.entry}，${arch.size} B）`);
    lines.push("  内容: 可用 HRD://session-read/<id> 提取。");
  } else {
    lines.push("  记录: （无落盘文件）");
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { sessionId: id, active: !!live, summary: ended, logPath: exists ? logPath : null, archived: arch ?? null },
  };
}

function howText(how, exitCode) {
  return (
    {
      exit: `exit ${exitCode ?? ""}`.trim(),
      killed: "killed（已被终止）",
      disconnect: "disconnect（连接被主动断开）",
      lost: "lost（连接丢失，可能网络异常）",
    }[how] || String(how || "closed")
  );
}

/** 会话列表（活跃 + 历史）。 */
function sessionsList(rd, ctx) {
  const live = rd.sshClient.listSessions();
  const history = rd.sshClient.listSessionHistory();
  const handleByConn = (connId) => {
    const conn = rd.sshClient.listConnections().find((c) => c.id === connId);
    return conn?.alias || conn?.handle || connId;
  };
  const lines = [];
  lines.push(`Sessions (${live.length + history.length}):`);
  lines.push("  ● active:");
  if (live.length === 0) lines.push("    (none)");
  else for (const s of live) lines.push(`    ${s.sessionId} [${handleByConn(s.connId)}] "${s.command}" started ${s.startedAt.toISOString()}`);
  lines.push("  ○ ended:");
  if (history.length === 0) lines.push("    (none)");
  else for (const h of history) lines.push(`    ${h.sessionId} [${handleByConn(h.connId)}] "${h.command}" ${h.how} ${Math.round((h.durationMs || 0) / 1000)}s ended ${h.endedAt.toISOString()}`);
  return { content: [{ type: "text", text: lines.join("\n") }], details: { active: live, ended: history } };
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
