/**
 * 操作终态 → 宿主 deferred 唤醒（卡片完成 = 任务终态 = 宿主原生钩子）。
 *
 * 链路：工具发起时 deferred:register（登记 + 投递策略）→ 终态
 *       deferred:resolve/fail → 宿主投递 <hana-background-result> 给 Agent
 *       会话（默认唤醒回合，结果结构化直达；notify_ui_only 只记录不唤醒）。
 *       busy 排队与补投重试由宿主托管，Agent 忙时不打断，闲了再叫。
 *
 * 与旧信标方案（session:send 注入 [Use tool: ...] 文本，Agent 醒来后二次查询）
 * 相比：结果随消息直接送达，无需信标、无需二次查询，整条链路收敛到宿主原生。
 *
 * 容错纪律：唤醒是终态的旁路通知，任何失败都不抛回调用方
 * （终局落盘流程不受影响）；register/resolve/fail 各自吞错。
 */

// 正常 exit 的任务判定阈值：会话时长 ≥ 此值（ms）才唤醒。
// 3s 以下 = 开壳即退的瞬时交互（探测、误触）；真实任务载体
// （ping -c 5 ≈ 4s、短脚本、sleep）都应获得唤醒信号。
export const EXIT_WAKE_MIN_MS = 3_000;

/**
 * 注册 deferred 占位（操作发起时调用，须先于 resolve/fail）。
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
 * tty 会话结局 → deferred 终态。
 * register 在结局时动态决策策略（结局已知才能定 deliveryIntent）：
 *   - wakeOnExit=false 或短 exit 会话（<3s 瞬时交互）→ notify_ui_only（只记录）
 *   - exit/killed → resolve（result 带 how/exitCode/outputTail + 会话引用）
 *   - disconnect/lost → fail（notifyAgentOnFailure 必唤醒，Agent 处理断连）
 * @param {object} info - createSession onClose 的结局信息
 * @param {string} info.sessionId - 全局唯一会话标识符（时间戳+随机，重载安全）
 * @param {string} [info.sessionLogPath] - 会话记录文件路径（HRD:// 引用）
 * @returns {Promise<boolean>}
 */
export async function wakeOnSessionEnd({ bus, sessionPath, taskId, label, how, exitCode, durationMs, outputTail, sessionLogPath, wakeOnExit, log }) {
  if (!bus?.request || !sessionPath || !taskId) {
    log?.info?.(`wakeOnSessionEnd skipped: bus=${bus?.request ? "ok" : "MISSING"}, sessionPath=${sessionPath ? "set" : "EMPTY"}`);
    return false;
  }
  const quiet =
    wakeOnExit === false ||
    (wakeOnExit === undefined && how === "exit" && (durationMs ?? 0) < EXIT_WAKE_MIN_MS);
  const registered = await registerDeferredWake({
    bus,
    sessionPath,
    taskId,
    label: String(label || ""),
    wakeOnExit: quiet ? false : true,
    log,
  });
  if (!registered) return false;
  if (how === "exit" || how === "killed") {
    return resolveDeferredWake({
      bus,
      taskId,
      result: {
        opId: taskId,
        tool: "tty_session",
        status: how === "exit" ? "ok" : "killed",
        exitCode: exitCode ?? null,
        durationMs: durationMs ?? null,
        label: String(label || ""),
        how,
        outputTail: String(outputTail || "").slice(0, 2048),
        session: sessionLogPath ? `HRD://session/${taskId}` : null,
      },
      log,
    });
  }
  return failDeferredWake({
    bus,
    taskId,
    error: { message: `tty session ${how}: ${String(label || "").slice(0, 200)}` },
    log,
  });
}
