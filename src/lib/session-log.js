/**
 * 会话日志（增量落盘）：随 tty 会话运行持续追加，会话结束 finalize。
 *
 * 文件是 append-only 的终端回放记录：
 *   标题 + 连接/命令元数据（创建时写）→ $ 命令 / 输出流（运行中增量写）
 *   → 结局段（close 时 finalize 追加）。
 * 不回头改写，输出按到达顺序落盘，「命令→输出」交错天然成立。
 *
 * 节流：输出高频时（tail -f、编译）防抖合并写盘（500ms 或 64KB 强制 flush）。
 * 全程吞错：日志失败不影响会话功能（旁路纪律）。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadPluginConfig, savePluginConfig } from "./plugin-config.js";
export { loadPluginConfig, savePluginConfig };

const FLUSH_DELAY_MS = 500;
const FLUSH_FORCE_BYTES = 64 * 1024;
const SESSION_LOG_BYTES = 32 * 1024 * 1024; // 目录总字节上限
const SESSION_FILE_MAX_BYTES = 8 * 1024 * 1024; // 单文件上限：防止单个长驻会话无限膨胀

// 面板可配的会话日志上限（0 = 不设限；MB 单位）。
// 只控制空间占用：单文件 + 目录总字节；文件数不设限（字节上限已兜底）。
// 配置统一存 dataDir/config.json（plugin-config），面板为唯一入口。
export const DEFAULT_SESSION_LOG_CFG = { maxMB: 8, maxTotalMB: 32 };

/** 读取会话日志两限（来自统一配置 dataDir/config.json）。 */
export function loadSessionLogConfig(dir) {
  return loadPluginConfig(dir).sessionLog;
}

/** 保存会话日志两限（写入统一配置 dataDir/config.json，保留其他字段）。 */
export function saveSessionLogConfig(dir, { maxMB, maxTotalMB } = {}) {
  const cur = loadPluginConfig(dir);
  return savePluginConfig(dir, { sessionLog: { maxMB, maxTotalMB }, idleTimeout: cur.idleTimeout }).sessionLog;
}

// conn/cfg 事件日志（append-only 单文件，2MB 硬上限，超限停止并标注一次）
const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const eventLogAnnotated = new Set();

/** 配置变更明细：连接字段逐项 old→new；proxyCommand 记 set/cleared；凭据只记 changed（不落明文）。
 * @param {{host?:string,username?:string,port?:number,proxyCommand?:string|null}} prev - 变更前配置
 * @param {{host?:string,username?:string,port?:number,proxyCommand?:string,credentials?:boolean}} next - 本次要改的字段（undefined = 不改）
 * @returns {string[]} 差异项数组（空 = 无字段变更） */
export function describeProfileDiff(prev, next) {
  const diffs = [];
  if (next.host !== undefined && next.host !== prev.host) diffs.push(`host: ${prev.host}→${next.host}`);
  if (next.username !== undefined && next.username !== prev.username) diffs.push(`username: ${prev.username}→${next.username}`);
  if (next.port !== undefined && String(next.port) !== String(prev.port)) diffs.push(`port: ${prev.port}→${next.port}`);
  if (next.proxyCommand !== undefined && next.proxyCommand !== (prev.proxyCommand || null)) {
    diffs.push(next.proxyCommand ? "proxyCommand: set" : "proxyCommand: cleared");
  }
  if (next.credentials) diffs.push("credentials: changed");
  return diffs;
}

/** 事件日志时间戳（本地时间 YYYY-MM-DD HH:MM:SS）。 */
export function eventTs(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 按日文件名（YYYY-MM-DD），用于事件日志与编排。 */
export function dayStamp(d = new Date()) {
  return eventTs(d).slice(0, 10);
}

/** 会话记录文件路径：session/<yyyy-mm-dd>/<sessionId>.md（按日目录 + 纯 ID 文件名）。 */
export function sessionFileName(sessionId, startedAt = new Date()) {
  const d = startedAt instanceof Date ? startedAt : new Date(startedAt);
  return path.join(dayStamp(d), `${sessionId}.md`);
}

/** 解码 sessionId 里的毫秒时间戳（id = 时间戳(base36, 8~9 位) + 随机 3 位）；失败返回 null。 */
export function sessionIdTime(id) {
  const s = String(id || "");
  if (s.length < 8 || s.length > 12) return null;
  const t = parseInt(s.slice(0, -3), 36);
  return Number.isFinite(t) && t > 0 ? new Date(t) : null;
}

/** 本地时间 HH-MM-SS（已不被文件名使用，保留给需要的时间片段展示）。 */
export function timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** 追加一行事件日志（<dir>/<base>/<YYYY-MM-DD>.md）；失败静默（best effort）。 */
export function appendEventLog(dir, base, line) {
  try {
    const sub = path.join(dir, base);
    fs.mkdirSync(sub, { recursive: true });
    const p = path.join(sub, `${dayStamp()}.md`);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > EVENT_LOG_MAX_BYTES) {
        if (!eventLogAnnotated.has(p)) {
          eventLogAnnotated.add(p);
          fs.appendFileSync(p, `\n> ${eventTs()} 事件日志已达 2MB 上限，后续事件不再记录\n`, "utf8");
        }
        return;
      }
    } catch {
      /* stat 失败按可写处理 */
    }
    fs.appendFileSync(p, `${line}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

// ---- 归档（旧日志打包压缩保留，不直接删除） ----

/** tar 条目头（V7 + ustar magic，512 字节）。 */
function tarHeader(name, size, mtimeMs) {
  const buf = Buffer.alloc(512);
  buf.write(String(name).slice(0, 99), 0, "utf8");
  buf.write("0000644\0", 100); // mode
  buf.write("0000000\0", 108); // uid
  buf.write("0000000\0", 116); // gid
  buf.write(Math.floor(size).toString(8).padStart(11, "0") + "\0", 124);
  buf.write(Math.floor(mtimeMs / 1000).toString(8).padStart(11, "0") + "\0", 136);
  buf.write("        ", 148); // checksum 占位（视为空格参与求和）
  buf.write("0", 156); // typeflag：常规文件
  buf.write("ustar\0", 257);
  buf.write("00", 263);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return buf;
}

/** 把一组会话记录打包为 tar.gz（内存拼接，低频小体量；零依赖：手写 tar + zlib.gzip）。 */
function tarGz(entries) {
  const chunks = [];
  for (const e of entries) {
    const data = fs.readFileSync(e.path);
    chunks.push(tarHeader(e.name, data.length, e.mtime));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // 结束块
  return zlib.gzipSync(Buffer.concat(chunks));
}

/** 归档一组会话记录到 <logs>/archive/<组名>.tar.gz（组名=日期目录名或 flat-<文件名>）。 */
function archiveGroup(archiveDir, g) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const entries = g.files.map((f) => ({
    name: g.dirPath ? `${g.name}/${path.basename(f)}` : path.basename(f),
    path: f,
    mtime: fs.statSync(f).mtimeMs,
  }));
  const gz = tarGz(entries);
  const out = path.join(archiveDir, `${g.name}.tar.gz`);
  // 同名存档不应出现（同一日期目录归档一次即删除）；若出现则不覆盖（保留已有，直接丢弃本次）
  if (!fs.existsSync(out)) fs.writeFileSync(out, gz);
}

/** 清理会话日志：总字节超限时，把最旧的日期目录整体打包归档到 <logs>/archive/ 后删除。
 * @param {string} dir - session 日志目录
 * @param {object} [opts] - { maxBytes }；缺省用默认常量；0 = 不设限 */
export function cleanupSessionLogs(dir, { maxBytes = SESSION_LOG_BYTES } = {}) {
  try {
    const archiveDir = path.join(path.dirname(dir), "archive");
    // 按组（日期目录 / 平铺存量文件）聚合，按最早 mtime 排序
    const groups = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        const files = fs.readdirSync(p)
          .filter((f) => f.endsWith(".md"))
          .map((f) => path.join(p, f));
        if (!files.length) continue;
        let total = 0;
        let earliest = Infinity;
        for (const f of files) {
          const st = fs.statSync(f);
          total += st.size;
          earliest = Math.min(earliest, st.mtimeMs);
        }
        groups.push({ name: d.name, files, total, earliest, dirPath: p });
      } else if (d.isFile() && d.name.endsWith(".md")) {
        const st = fs.statSync(p);
        groups.push({ name: `flat-${d.name}`, files: [p], total: st.size, earliest: st.mtimeMs, dirPath: null });
      }
    }
    groups.sort((a, b) => a.earliest - b.earliest);
    let total = groups.reduce((s, g) => s + g.total, 0);
    while (maxBytes > 0 && total > maxBytes) {
      const g = groups.shift();
      if (!g) break;
      try {
        archiveGroup(archiveDir, g);
        for (const f of g.files) fs.unlinkSync(f);
        if (g.dirPath) {
          try {
            fs.rmdirSync(g.dirPath);
          } catch {
            /* 目录非空（如残留文件）：保留 */
          }
        }
        total -= g.total;
      } catch {
        /* 归档失败则不删（宁可超限也不丢数据） */
      }
    }
  } catch {
    /* best effort */
  }
}

/** 移除终端 ANSI 转义序列（chunk 级；跨 chunk 的残缺序列留待后续 chunk 清理）。 */
function stripAnsi(s) {
  return String(s || "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][0-9A-Z]/g, "");
}

const HOW_TEXT = {
  exit: (code) => `exit ${code ?? ""}`.trim(),
  killed: () => "killed（已被终止）",
  disconnect: () => "disconnect（连接被主动断开）",
  lost: () => "lost（连接丢失，可能网络异常）",
  timeout: () => "timeout（超过时限未完成）",
};

/**
 * 创建会话日志器。
 * @param {object} opts
 * @param {string} opts.dir - session 日志目录（dataDir/logs/session）
 * @param {string} opts.sessionId
 * @param {string} opts.connId
 * @param {string} opts.command
 * @param {Date} opts.startedAt
 * @param {string} opts.kind - "tty"（交互会话，默认）| "exec"（一次性命令）；仅影响头部类型行，模板统一
 * @returns {object|null} logger（初始化失败返回 null）：
 *   { filePath, appendOutput(text), appendInput(chars), finalize(info) }
 */
export function createSessionLogger({ dir, sessionId, connId, command, startedAt, maxFileBytes = SESSION_FILE_MAX_BYTES, kind = "tty" }) {
  let filePath;
  let headBytes = 0;
  try {
    // 文件名按日编排：session/<yyyy-mm-dd>/<sessionId>.md
    filePath = path.join(dir, sessionFileName(sessionId, startedAt));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 提示符由远端 shell 自己渲染（PS1 回显自带，如 hanako@host:~$），
    // 这里不插入任何自造标记，记录 = 终端输出流原样。
    const head = [
      `# HRD 会话记录：${sessionId}`,
      "",
      `- 会话: ${sessionId}`,
      `- 连接: ${connId}`,
      `- 命令: \`${String(command || "").replace(/`/g, "\\`")}\``,
      `- 类型: ${kind === "exec" ? "exec（一次性命令）" : "tty（交互会话）"}`,
      `- 开始: ${startedAt?.toISOString?.() || startedAt}`,
      "",
      "## 终端记录",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, head, "utf8");
    headBytes = Buffer.byteLength(head, "utf8");
  } catch {
    return null;
  }

  let pending = "";
  let timer = null;
  let closed = false;
  let ok = true;
  let written = headBytes; // 已落盘字节（头部起始）
  let droppedBytes = 0; // 超单文件上限后丢弃的字节（结局段标注）

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const text = pending;
    pending = "";
    const bytes = Buffer.byteLength(text, "utf8");
    // 单文件上限：任一批次导致累计超限即整批丢弃（append-only 无法回头截断，有界优先）；maxFileBytes=0 时不设限
    if (maxFileBytes > 0 && written + bytes > maxFileBytes) {
      droppedBytes += bytes;
      return;
    }
    try {
      fs.appendFileSync(filePath, text, "utf8");
      written += bytes;
    } catch {
      ok = false;
      pending = text; // 写失败保留，等待下次尝试
    }
  };
  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_DELAY_MS);
    if (typeof timer.unref === "function") timer.unref();
  };

  return {
    filePath,
    get ok() {
      return ok;
    },
    appendOutput(text) {
      if (closed) return;
      pending += stripAnsi(text);
      if (pending.length >= FLUSH_FORCE_BYTES) flush();
      else schedule();
    },
    appendInput(chars) {
      // 输入不写标记：命令回显（tty echo）与 PS1 都在输出流里，记录保持终端原样。
      // 这里只先 flush 当前输出，保证时序（输出在前、输入动作在后）。
      if (closed) return;
      flush();
    },
    /** 会话结束：flush + 追加结局段 + 封口。 */
    finalize(info) {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const howText = info.howText || (HOW_TEXT[info.how] || (() => String(info.how || "closed")))(info.exitCode);
      // 未 flush 的输出批次：若累计超限则丢弃（不落盘），只保留结局段；maxFileBytes=0 时不设限
      if (maxFileBytes > 0 && written + Buffer.byteLength(pending, "utf8") > maxFileBytes) {
        droppedBytes += Buffer.byteLength(pending, "utf8");
        pending = "";
      }
      const tail = [
        "",
        `## 结局`,
        "",
        `- 结局: ${howText}`,
        `- 耗时: ${Math.round((info.durationMs || 0) / 1000)}s`,
        `- 起止: ${info.startedAt?.toISOString?.() || info.startedAt} → ${info.endedAt?.toISOString?.() || info.endedAt}`,
        `- 输出: ${info.outputBytes ?? 0} bytes${info.truncated ? "（超过 1MB 活跃缓冲上限，最早部分已丢弃）" : ""}`,
        ...(droppedBytes > 0 ? [`- 日志: 截断（超过单文件上限，${droppedBytes} bytes 未落盘）`] : []),
        "",
      ].join("\n");
      pending += tail;
      try {
        fs.appendFileSync(filePath, pending, "utf8");
        pending = "";
      } catch {
        ok = false;
      }
    },
  };
}
