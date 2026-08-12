/**
 * tty 会话结局 → 宿主 agent 自动唤醒（旁路通知，不影响面板历史回写）。
 *
 * 链路：tty 会话 close → 按 wakeOn 策略过滤结局 → 构造 HRD 唤醒消息 →
 *       bus.request("session:send", { sessionPath, text, context.system })
 *       → 宿主 promptSession → agent 自动醒来处理结果。
 *
 * 容错纪律：唤醒是会话结局的旁路通知，任何失败都不抛回调用方
 * （onClose 流程必须始终完成历史回写）。session_busy（宿主会话流式中）
 * 不放弃：持续重试直到注入成功（agent 回合结束宿主必然空闲），
 * 5min 窗口上限兑底；上限内仍失败则留痕（wake.log + 插件日志）。
 */

// 结局类型：与 ssh-client createSession onClose 的 how 判定一致。
export const WAKE_KINDS = ["exit", "killed", "disconnect", "lost"];

// 默认唤醒策略：正常 exit 只唤醒任务型会话（会话 ≥ EXIT_WAKE_MIN_MS），
// 瞬时交互不打扰；异常/干预结局（disconnect/lost/killed）无条件唤醒。
export const DEFAULT_WAKE_ON = ["exit", "disconnect", "lost", "killed"];

// 正常 exit 的任务判定阈值：会话时长 ≥ 此值（ms）才唤醒。
// 3s 以下 = 开壳即退的瞬时交互（探测、误触）；真实任务载体
// （ping -c 5 ≈ 4s、短脚本、sleep）都应获得唤醒信号。
export const EXIT_WAKE_MIN_MS = 3_000;

// session_busy 重试间隔（ms）：给进行中的宿主回合一个呼吸窗口。
const BUSY_RETRY_DELAY_MS = 3000;

// session_busy 重试上限：信标必须送达，宿主回合结束即注入成功；
// 上限是总时间窗兑底（3s × 100 = 5min），覆盖 agent 长回合（写作、
// 多步工具链）期间任务提前完成的情形。fire-and-forget 重试不阻塞
// onClose/连接释放（exec_command.js 已 catch 不 await）。
const BUSY_RETRY_MAX = 100;

// 文件级诊断（绕过宿主 logSink 的批量/去重，确定性记录唤醒链路每一步）
import fs from "node:fs";
import os from "node:os";
const WAKE_LOG = `${os.tmpdir()}\\hrd-wake.log`;
function flog(msg) {
  try {
    fs.appendFileSync(WAKE_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* best effort */
  }
}

/**
 * 归一化 wakeOn 配置：数组过滤合法值；逗号分隔字符串拆分；
 * 空/非法回退默认策略。
 * 当前 wakeOn 固定代码默认（不配置化，manifest 无 config 键）。
 * @param {unknown} raw - 策略值（数组或逗号字符串）
 * @returns {string[]}
 */
export function normalizeWakeOn(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    list = raw.split(",");
  }
  const filtered = list.map((s) => String(s).trim()).filter((s) => WAKE_KINDS.includes(s));
  return filtered.length ? [...new Set(filtered)] : [...DEFAULT_WAKE_ON];
}

/**
 * 构造唤醒信标：单行 HRD:// 会话记录引用（协议名 + 路径自解释，
 * 命令/结局等细节在记录文件内）。记录缺失时回退为纯标识符。
 * @param {object} info - createSession onClose 的结局信息
 * @param {string} info.sessionId - 全局唯一会话标识符（时间戳+随机，重载安全）
 * @param {string} [info.sessionLogPath] - 会话记录文件路径（是否落盘成功）
 * @returns {string}
 */
export function buildWakeMessage(info) {
  const sessionId = info.sessionId || "unknown";
  if (info.sessionLogPath) {
    // 信标 = 纯文本工具调用标记（与 [Use skill: xxx] 同构），method 显式化（ajax 式）。
    return `[Use tool: hana-remote-dev_hrd(method="GET", uri="HRD://session/${sessionId}")]`;
  }
  return `[HRD: tty 会话结束 · 标识符 ${sessionId}]`;
}

/**
 * 发送一次 session:send 唤醒请求。
 * @returns {"ok" | "busy" | "error"}
 */
async function sendWake({ bus, sessionPath, text, log }) {
  if (!bus?.request) return "error";
  try {
    const resp = await bus.request("session:send", {
      sessionPath,
      text,
      context: {
        system:
          "这是一条 HRD 插件系统消息：远程 tty 会话已结束。请执行信标中的 hana-remote-dev_hrd 工具调用" +
          "（GET HRD://session/<id>）获取会话元数据与记录文件位置，再按需用 read/grep 查询记录内容。" +
          "无需回复用户；若无法调用工具，可直接忽略。",
      },
    });
    flog(`sent: resp=${JSON.stringify(resp)}`);
    log?.info?.(`wake sent, resp=${JSON.stringify(resp)}`);
    return "ok";
  } catch (err) {
    flog(`send error: ${String(err?.message || err)}`);
    log?.warn?.(`wake send failed: ${String(err?.message || err)}`);
    log?.info?.(`wake send failed: ${String(err?.message || err)}`);
    // 宿主会话流式中拒绝本次回合：调用方据此决定是否重试。
    if (String(err?.message || err).includes("session_busy")) return "busy";
    return "error";
  }
}

// ---- deferred 任务终态（stream 操作）→ 宿主投递 hana-background-result ----
// 宿主原生 deferred 机制：register（任务登记 + 投递策略）→ resolve/fail（终态）
// → 宿主投递 <hana-background-result> 给 Agent 会话，完成即唤醒回合（默认）。
// 相比 tty 信标（session:send 注入文本，Agent 醒来后二次查询），deferred 把结果
// 随消息直接送达，Agent 醒来即拿到结构化 result——卡片完成本身就是唤醒钩子。
// 容错纪律：任何失败只记录不抛回（终局落盘流程不受影响）。

/**
 * 注册 deferred 占位（stream 操作发起时调用，须先于 resolve/fail）。
 * wakeOnExit=false → notify_ui_only（只记录不唤醒）；否则 trigger_parent_turn
 * （宿主默认即唤醒，显式声明意图）；失败 notifyAgentOnFailure=true 必唤醒。
 * @returns {Promise<boolean>}
 */
export async function registerDeferredWake({ bus, sessionPath, taskId, label, wakeOnExit, log }) {
  if (!bus?.request || !sessionPath || !taskId) {
    log?.info?.(`deferred register skipped: bus=${bus?.request ? "ok" : "MISSING"}, sessionPath=${sessionPath ? "set" : "EMPTY"}`);
    return false;
  }
  try {
    await bus.request("deferred:register", {
      taskId,
      sessionPath,
      meta: {
        type: "hrd-op",
        label: String(label || ""),
        deliveryIntent: wakeOnExit === false ? "notify_ui_only" : "trigger_parent_turn",
        notifyAgentOnFailure: true,
      },
    });
    log?.info?.(`deferred registered: ${taskId} (deliveryIntent=${wakeOnExit === false ? "notify_ui_only" : "trigger_parent_turn"})`);
    return true;
  } catch (err) {
    log?.warn?.(`deferred register failed: ${String(err?.message || err)}`);
    return false;
  }
}

/**
 * 终态成功：resolve 携带结构化结果（宿主按 deliveryIntent 决定唤醒/只记录）。
 * @returns {Promise<boolean>}
 */
export async function resolveDeferredWake({ bus, taskId, result, log }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request("deferred:resolve", { taskId, result });
    log?.info?.(`deferred resolved: ${taskId}`);
    return true;
  } catch (err) {
    log?.warn?.(`deferred resolve failed: ${String(err?.message || err)}`);
    return false;
  }
}

/**
 * 终态失败：notifyAgentOnFailure=true 时宿主唤醒 Agent 处理（重试/换源决策）。
 * @returns {Promise<boolean>}
 */
export async function failDeferredWake({ bus, taskId, error, log }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request("deferred:fail", { taskId, error });
    log?.info?.(`deferred failed: ${taskId}`);
    return true;
  } catch (err) {
    log?.warn?.(`deferred fail failed: ${String(err?.message || err)}`);
    return false;
  }
}

/**
 * 唤醒入口：按 wakeOn 策略过滤结局 → 发送 → session_busy 静默重试一次。
 * 全程吞错（返回值仅用于可观测性，调用方无需处理）。
 *
 * @param {object} opts
 * @param {object} [opts.bus] - 宿主注入的工具 ctx.bus（bus.request 可用性
 *   已在探针中实测；缺失时直接跳过唤醒）
 * @param {string} [opts.sessionPath] - 唤醒目标宿主会话（工具 ctx.sessionPath，
 *   闭包捕获于工具调用时）
 * @param {string[]} [opts.wakeOn] - 归一化后的策略列表
 * @param {object} opts.info - onClose 结局信息（command / how / exitCode / durationMs / outputTail / wakeOnExit）
 * @param {object} [opts.log] - 插件 log（诊断用；缺失时静默）
 * @param {number} [opts.busyDelayMs] - busy 重试间隔（测试可注入，默认 3s）
 * @param {number} [opts.busyRetryMax] - busy 重试上限（测试可注入，默认 100）
 * @returns {Promise<"skipped"|"ok"|"busy"|"error">}
 */
export async function maybeWakeAgent({ bus, sessionPath, wakeOn, info, log, busyDelayMs = BUSY_RETRY_DELAY_MS, busyRetryMax = BUSY_RETRY_MAX }) {
  flog(`enter: sessionPath=${sessionPath ? "set" : "EMPTY"}, bus.request=${bus?.request ? "ok" : "MISSING"}, how=${info?.how}, wakeOnExit=${info?.wakeOnExit}`);
  if (!sessionPath || !bus?.request) {
    log?.info?.(`wake skipped: sessionPath=${sessionPath ? "set" : "EMPTY"}, bus.request=${bus?.request ? "ok" : "MISSING"}`);
    flog(`skipped: sessionPath=${sessionPath ? "set" : "EMPTY"}`);
    return "skipped";
  }
  // 会话级显式意图（exec_command input.wakeOnExit）优先于全局策略与阈值，
  // 只作用于 exit 结局：true = 必唤醒；false = 必不唤醒。
  // 未声明时回退全局 wakeOn 策略 + 时长阈值兑底（过滤器只兜底，不猜意图）。
  if (info.how === "exit" && info.wakeOnExit === false) {
    log?.info?.(`wake skipped: wakeOnExit=false (explicit)`);
    flog(`skipped: wakeOnExit=false`);
    return "skipped";
  }
  const kinds = wakeOn && wakeOn.length ? wakeOn : DEFAULT_WAKE_ON;
  if (info.how === "exit" && info.wakeOnExit === true) {
    log?.info?.(`wake bypass filters: wakeOnExit=true (explicit)`);
    flog(`explicit wakeOnExit=true, bypass filters`);
  } else if (!kinds.includes(info.how)) {
    log?.info?.(`wake skipped: how=${info.how} not in wakeOn=[${kinds.join(",")}]`);
    flog(`skipped: how=${info.how}`);
    return "skipped";
  } else if (info.how === "exit" && (info.durationMs ?? 0) < EXIT_WAKE_MIN_MS) {
    // 未显式声明时的兑底：瞬时交互（开壳即退）不唤醒。
    log?.info?.(`wake skipped: exit too fast (${info.durationMs}ms < ${EXIT_WAKE_MIN_MS}ms)`);
    flog(`skipped: exit too fast (${info.durationMs}ms)`);
    return "skipped";
  }

  const text = buildWakeMessage({ ...info, sessionId: info.sessionId || "unknown" });
  log?.info?.(`wake send -> ${sessionPath} (how=${info.how})`);
  flog(`sending to ${sessionPath}`);
  // busy = 宿主仍在流式回合中：持续重试直到注入成功（agent 回合结束宿主必然
  // 空闲），上限兜底防无限重试；其他错误不重试。
  let result = await sendWake({ bus, sessionPath, text, log });
  let retries = 0;
  while (result === "busy" && retries < busyRetryMax) {
    retries += 1;
    log?.info?.(`wake busy, retry ${retries}/${busyRetryMax}`);
    flog(`busy, retry ${retries}/${busyRetryMax}`);
    await new Promise((r) => setTimeout(r, busyDelayMs));
    result = await sendWake({ bus, sessionPath, text, log });
  }
  if (result === "busy") {
    log?.warn?.(`wake gave up after ${retries} retries (window ${(busyDelayMs * retries) / 1000}s)`);
    flog(`gave up after ${retries} retries`);
  }
  log?.info?.(`wake result: ${result}`);
  flog(`result: ${result}`);
  return result;
}
