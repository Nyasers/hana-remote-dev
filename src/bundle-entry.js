// rspack 构建入口（src/bundle-entry.js）
// 产物 = 插件入口 index.js 本体（commonjs2 + export default）
// module.exports = HanaRemoteDevPlugin 类：
//   - onload：registerTool ×10（hrd 端点 + 9 个操作工具，cfg_* 已收敛为内部实现）+ install(ctx)（宿主入口直接消费）
//   - 静态属性 hrdTools/uiRoutes/apiRoutes：routes 壳从 index.js 取导出

import fs from "node:fs";
import path from "node:path";

import * as execCommand from "./tools/exec_command.js";
import * as fileTool from "./tools/file.js";
import * as findTool from "./tools/find.js";
import * as grepTool from "./tools/grep.js";
import * as hrdTool from "./tools/hrd.js";
import * as lsTool from "./tools/ls.js";
import * as readTool from "./tools/read.js";
import * as writeTool from "./tools/write.js";
import * as editTool from "./tools/edit.js";
import * as writeStdin from "./tools/write_stdin.js";

import { ConnectionStore } from "./lib/connection-store.js";
import {
  disconnectAll,
  setIdleTimeout,
  setSessionLogDir,
  setEventLogDir,
  setSessionLogMaxBytes,
  setSessionLogMaxTotalBytes,
  startIdleManager,
  stopIdleManager,
} from "./lib/ssh-client.js";
import { setOperationLogDir } from "./lib/operations.js";
import * as sshClient from "./lib/ssh-client.js";
import * as pathRef from "./lib/path-ref.js";
import * as operations from "./lib/operations.js";
import * as errText from "./lib/err-text.js";
import * as tree from "./lib/tree.js";
import * as sessionLog from "./lib/session-log.js";
import * as wake from "./lib/wake.js";
import { LocalSocketServer } from "./lib/socket-server.js";
import { runtimeHolder } from "./lib/runtime.js";
import { resolveAgentName } from "./lib/agent-name.js";
import { attachCard } from "./lib/card-utils.js";

import registerUiRoutes from "./lib/ui-routes.js";
import registerApiRoutes from "./lib/api-routes.js";
import registerCardRoutes from "./lib/card-routes.js";

// ---- 工具定义（registerTool 直接消费：name/description/parameters/execute） ----

// 自带 operation 管理（进行中可观察 + 可终止）的工具：wrapper 不再重复注册，
// 避免双 operation；其余工具由 wrapper 统一注册通用 operation（可观察、无 kill）。
const SELF_MANAGED_OPS = new Set(["exec_command", "file"]);

// 工具错误以文本形式返回时不抛异常（read/ls/write/edit/find/grep 内部 catch 后
// 返回 `Failed to ...` 文本，agent 友好），wrapper 据此前缀判定失败状态。
const TOOL_ERR_TEXT = /^(Failed to |Is a directory|No such|Error[:：]|ENOENT|EACCES|EISDIR|ENOTDIR|EIO|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Permission denied|No active connection|Cannot |Not a |Host key verification|Connection (failed|closed|refused|timed out)|Command timeout|Session .* not found|No such session)/;

/**
 * 统一工具包装：
 * 1. 非 exec/file 工具注册通用 operation（进行中可观察，无 kill → 面板无终止按钮）
 * 2. 所有工具调用记录「已完成操作」历史（耗时/状态/摘要）
 * 供面板详情区「进行中操作 / 已完成操作」展示。工具本体零改动。
 */
function wrapTool(tool) {
  const orig = tool.execute;
  if (typeof orig !== "function") return tool;
  const selfManaged = SELF_MANAGED_OPS.has(tool.name);
  return {
    ...tool,
    async execute(input, ctx) {
      const started = Date.now();
      let opId = null;
      // 卡片 {name} 占位符：当前会话的 Agent 显示名（解析失败由渲染层回退 HRD）
      const agentName = resolveAgentName(ctx);

      // ── stream 分支：非阻塞 + 后台执行 + deferred 完成唤醒 ──
      // 任何远程操作可异步化（grep/find/read/ls/write/edit）：Agent 发起后不阻塞
      // 回合，完成被宿主唤醒（结果随 hana-background-result 直达）。
      // writeStdin（tty 输入）与 hrd（查询）语义上没有「完成」概念，不参与。
      if (!selfManaged && tool.name !== "writeStdin" && tool.name !== "hrd" && input?.stream === true) {
        const sentry = buildHistoryEntry(tool.name, input, started, null, null);
        const sopId = operations.startOperation({
          connId: sentry.connId,
          kind: tool.name,
          tool: tool.name,
          label: sentry.label,
          agentName,
        });
        const sctx = {
          ...ctx,
          _hrdAppend: (chunk) => operations.appendOpOutput(sopId, String(chunk ?? "")),
        };
        // deferred 注册（发起时；wakeOnExit=false → 只记录不唤醒）
        wake.registerDeferredWake({
          bus: ctx.bus ?? runtimeHolder.current?.bus,
          sessionPath: ctx.sessionPath,
          taskId: sopId,
          label: sentry.label,
          wakeOnExit: typeof input.wakeOnExit === "boolean" ? input.wakeOnExit : undefined,
          log: runtimeHolder.current?.log,
        }).catch(() => {});
        // 后台执行（fire-and-forget）：终局落盘 + deferred 终态 + 释放；
        // 卡片轮询不受工具返回影响（sopId 先命中 in-flight，落盘后命中磁盘双写）。
        (async () => {
          try {
            const result = await orig(input, sctx);
            const out = result?.content?.[0]?.text || "";
            const errLike = TOOL_ERR_TEXT.test(out);
            const rentry = buildHistoryEntry(tool.name, input, started, result, errLike ? new Error(out.slice(0, 120)) : null);
            operations.recordHistory({ ...rentry, opRef: sopId, agentName });
            if (result && typeof result === "object" && sopId) {
              result.details = {
                ...(result.details || {}),
                card: {
                  route: `/card/op?opId=${sopId}`,
                  title: rentry.label || tool.name,
                  description: rentry.summary || rentry.label || tool.name,
                  aspectRatio: "16:1",
                },
              };
            }
            wake.resolveDeferredWake({
              bus: ctx.bus ?? runtimeHolder.current?.bus,
              taskId: sopId,
              result: {
                opId: sopId,
                tool: tool.name,
                status: errLike ? "error" : "ok",
                durationMs: Date.now() - started,
                label: rentry.label,
                output: out.slice(0, 4096),
              },
              log: runtimeHolder.current?.log,
            });
          } catch (err) {
            operations.recordHistory({
              ...buildHistoryEntry(tool.name, input, started, null, err),
              opRef: sopId,
              agentName,
            });
            wake.failDeferredWake({
              bus: ctx.bus ?? runtimeHolder.current?.bus,
              taskId: sopId,
              error: { message: String(err?.message || err).slice(0, 300) },
              log: runtimeHolder.current?.log,
            });
          } finally {
            operations.endOperation(sopId);
          }
        })();
        // 立即返回：对话主区只显示操作名；卡片从挂载即 running（增量实时推进）
        return attachCard(
          {
            content: [{ type: "text", text: String(sentry.label || tool.name) }],
            details: { streamOpId: sopId, stream: true },
          },
          { opId: sopId, label: sentry.label, summary: "" }
        );
      }

      if (!selfManaged) {
        const entry = buildHistoryEntry(tool.name, input, started, null, null);
        opId = operations.startOperation({
          connId: entry.connId,
          kind: tool.name,
          tool: tool.name,
          label: entry.label,
          agentName,
        });
      }
      // 增量通道：工具执行中可调 ctx._hrdAppend(chunk) 推实时输出
      // （grep/find 等 walk 型工具逐步推命中；面板进行中操作实时可见）。
      // 快工具（ls 等一次往返无中间流）不调用，running 态自然一闪而过。
      const tctx = opId
        ? { ...ctx, _hrdAppend: (chunk) => operations.appendOpOutput(opId, String(chunk ?? "")) }
        : ctx;
      try {
        const result = await orig(input, tctx);
        // SELF_MANAGED 工具（exec_command/file）在工具内部自行记录历史
        // （带 connInstance 等语义字段）；wrapper 只兜底非自管理工具，
        // 否则同一次执行会双记录、双卡（null 批次 + 实例批次）。
        if (!selfManaged) {
          const out = result?.content?.[0]?.text || "";
          const errLike = TOOL_ERR_TEXT.test(out);
          const entry = buildHistoryEntry(tool.name, input, started, result, errLike ? new Error(out.slice(0, 120)) : null);
          operations.recordHistory({ ...entry, opRef: opId, agentName });
          // 操作卡片：插件工具在宿主 UI 只有 _fallback 兜底（"🔧 忙碌中…"），
          // 卡片补足操作详情（目标 / 状态 / 耗时 / 摘要），随 details.card 渲染在工具块下方。
          if (result && typeof result === "object" && opId) {
            result.details = {
              ...(result.details || {}),
              card: {
                route: `/card/op?opId=${opId}`,
                title: entry.label || tool.name,
                description: entry.summary || entry.label || tool.name,
                aspectRatio: "16:1", // 初始高度，配合 ui.resize 自适应
              },
            };
          }
        }
        return result;
      } catch (err) {
        if (!selfManaged) operations.recordHistory({ ...buildHistoryEntry(tool.name, input, started, null, err), agentName });
        throw err;
      } finally {
        if (opId) operations.endOperation(opId);
      }
    },
  };
}

/** 从工具名 + 入参 + 结果构造历史条目（通用规则，不依赖各工具内部语义）。 */
function buildHistoryEntry(toolName, input, started, result, err) {
  const inputObj = input && typeof input === "object" ? input : {};
  // label：优先命令全文，其次动作+目标，再退到关键参数拼接
  let label = "";
  if (inputObj.command) {
    label = String(inputObj.command);
  } else if (inputObj.action) {
    label = `${inputObj.action}${inputObj.source ? " " + inputObj.source : ""}${inputObj.target ? " → " + inputObj.target : ""}`;
  } else if (inputObj.pattern && inputObj.path) {
    label = `"${inputObj.pattern}" in ${inputObj.path}`;
  } else if (inputObj.path) {
    label = String(inputObj.path);
  } else if (inputObj.ref || inputObj.id) {
    label = String(inputObj.ref || inputObj.id);
  } else {
    const keys = Object.keys(inputObj);
    if (keys.length) label = keys.slice(0, 2).map((k) => `${k}=${String(inputObj[k]).slice(0, 60)}`).join(" ");
  }
  if (label.length > 160) label = label.slice(0, 157) + "…";

  // connId：连接参数或路径的 alias 前缀
  let connId = inputObj.connectionId || inputObj.conn || null;
  if (!connId) {
    for (const key of ["source", "target", "path"]) {
      const v = inputObj[key];
      if (typeof v === "string" && v.includes(":/")) {
        connId = v.slice(0, v.indexOf(":/"));
        break;
      }
    }
  }
  // 连接标识统一为 HRD 家族内部 id：alias（端点可读名）解析为 profileId
  //（HRD_xxx），保证跨工具落盘/卡片/面板一致——exec/file 自管理路径已在
  // 内部解析，wrapper 兜底路径（grep/write/edit/read/ls/find）这里补同一解析。
  // 已命中的 HRD id / 查不到的引用（conn_N 旧数据、瞬态实例）保持原样。
  if (connId) {
    try {
      const profile = runtimeHolder.current?.connectionStore?.get(String(connId));
      if (profile) connId = profile.id;
    } catch {
      /* 解析失败保留原始引用（连接日志等仍可读） */
    }
  }
  // connInstance：统一后实例 id = 连接 id（v0.9.2 定案），wrapper 兜底路径
  // 在执行前无法查实例表，直接与解析后的 connId 同值，与 exec/file 双写一致。
  const connInstance = connId ? String(connId) : null;

  // summary：仅错误摘要。成功路径的结果文本统一收进 output（卡片输出折叠区），
  // 不写进 summary——摘要行只承载错误提示（一眼可见）；description 由调用方
  // 降级到 label。自管理工具（exec/file）各自保持其短行动摘要语义。
  let summary = "";
  let output = "";
  let exitCode = null;
  if (err) {
    summary = String(err?.message || err);
  } else if (result) {
    const text = Array.isArray(result.content)
      ? result.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n")
      : "";
    output = text;
    const m = text.match(/Exit code: (-?\d+)/);
    if (m) exitCode = Number(m[1]);
  }

  return {
    tool: toolName,
    label,
    connId: connId ? String(connId) : null,
    connInstance,
    status: err ? "error" : "ok",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    exitCode,
    summary,
    output,
  };
}

// hrdTool（HRD:// 资源协议端点）原样导出，不参与操作历史；
// 操作工具统一过 wrapTool：非自管工具（read/ls/write/edit/find/grep）由 wrapper
// 记录 operation + history（带 connId 推导）；exec_command/file 自管（内部记录），
// wrapper 跳过避免双记录。
export const hrdTools = [
  hrdTool,
  ...[execCommand, fileTool, findTool, grepTool, lsTool, readTool, writeTool, editTool, writeStdin].map(wrapTool),
];

// ---- 生命周期（原 onload 体；返回 dispose） ----

export async function install(ctx) {
  const { dataDir, log } = ctx;
  fs.mkdirSync(dataDir, { recursive: true });

  const connectionStore = new ConnectionStore({ dataDir });
  try {
    await connectionStore.init();
  } catch (err) {
    // A corrupted/unreadable hrd.db must not take the whole plugin down:
    // tools keep loading and will surface a clear "not initialized"
    // error instead of a module-level crash.
    log.error(`hrd.db init failed: ${err?.message || err}`);
    connectionStore.close();
    return null;
  }

  // 单一事实源：工具层全部经由 runtime 访问 lib（reload 即刷新）。
  // bus 来自插件实例 ctx（install 时注入，含权限包装）；工具执行 ctx 不含 bus，
  // 唤醒链路（onClose 闭包）必须经 runtime 拿宿主能力。
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const runtime = {
    connectionStore, sshClient, pathRef, operations, errText, tree, wake, dataDir, logsDir, log, sessionLog,
    sessionLogDir: path.join(logsDir, "session"),
    bus: ctx.bus ?? null,
    registerSessionFile: ctx.registerSessionFile ?? null,
  };
  ctx._remoteDev = runtime;
  runtimeHolder.current = runtime;

  // 会话日志目录：tty 会话与一次性命令随运行落盘（agent 可经 HRD://sessions/ 读取）
  setSessionLogDir(path.join(logsDir, "session"));
  // 事件日志目录：connection/（连接变动）/ config/（配置变动）
  setEventLogDir(logsDir);
  // 操作日志目录：operations/（每次工具调用一行，含状态/耗时/退出码）
  setOperationLogDir(logsDir);

  // 统一配置（dataDir/config.json，面板唯一入口）：会话日志两限 + 空闲兜底 TTL
  // （主路径为事件驱动释放：exec/sftp 结束、tty 会话关闭即断；此 TTL 只兜异常残留）
  const pcfg = sessionLog.loadPluginConfig(dataDir);
  setSessionLogMaxBytes(pcfg.sessionLog.maxMB > 0 ? pcfg.sessionLog.maxMB * 1024 * 1024 : 0);
  setSessionLogMaxTotalBytes(pcfg.sessionLog.maxTotalMB > 0 ? pcfg.sessionLog.maxTotalMB * 1024 * 1024 : 0);
  setIdleTimeout(pcfg.idleTimeout);
  startIdleManager();

  // Local Socket.IO server: the panel's duplex channel. A failure here must
  // not take the plugin down either — tools keep working, the page shows
  // "socket unavailable".
  const localSocket = new LocalSocketServer({ log, runtime });
  // 非枚举挂载：宿主可能在安装/状态收集时 JSON 序列化插件上下文，
  // 枚举属性会把 runtime↔localSocket 循环暴露出来；函数闭包天然不可序列化。
  Object.defineProperty(runtime, "localSocket", {
    value: localSocket,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  try {
    await localSocket.start();
  } catch (err) {
    log.error(`hrd socket server start failed: ${err?.message || err}`);
    runtime.localSocket = null;
  }

  // Cleanup on plugin unload
  return () => {
    if (runtime.localSocket) {
      runtime.localSocket.close().catch(() => {});
    }
    disconnectAll();
    stopIdleManager();
    connectionStore.close();
    if (runtimeHolder.current === runtime) runtimeHolder.current = null;
    delete ctx._remoteDev;
  };
}

// ---- routes 工厂（壳从静态属性取用） ----

// ---- 插件入口类（宿主直接消费：new → onload） ----

export default class HanaRemoteDevPlugin {
  static hrdTools = hrdTools;
  static uiRoutes = registerUiRoutes;
  static apiRoutes = registerApiRoutes;
  static cardRoutes = registerCardRoutes;

  async onload() {
    // hrdTools 已在导出时统一过 wrapTool（操作工具带 operation/history 记录），
    // 这里不再重复包装（避免双 operation / 双历史）。hrd 端点不参与操作历史。
    for (const tool of hrdTools) {
      try {
        this.ctx.registerTool?.(tool);
      } catch (err) {
        this.ctx.log?.error?.(`registerTool ${tool.name} failed: ${err?.message || err}`);
      }
    }

    const dispose = await install(this.ctx);
    if (dispose) this.register(dispose);
  }
}
