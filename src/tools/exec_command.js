import { runtimeHolder } from "../lib/runtime.js";
import * as wake from "../lib/wake.js";
import { attachCard } from "../lib/card-utils.js";
import { resolveAgentName } from "../lib/agent-name.js";
export const name = "exec_command";
export const description = "Execute a shell command on a remote host. Auto-connects when the profile is not connected. With tty: true, starts an interactive session and returns a sessionId for hrd_write_stdin.";

export const parameters = {
  type: "object",
  properties: {
    connectionId: {
      type: "string",
      description: "Connection alias or internal id (required). Auto-connects from stored credentials when needed.",
    },
    command: {
      type: "string",
      description: "Shell command to execute.",
    },
    workdir: {
      type: "string",
      description: "Working directory on the remote host (cd <workdir> && command).",
    },
    timeout: {
      type: "integer",
      description: "Max execution time in seconds (default 30).",
    },
    tty: {
      type: "boolean",
      description: "Start an interactive pty session; returns sessionId + initial output. The process stays running; feed it via hrd_write_stdin.",
      default: false,
    },
    wakeOnExit: {
      type: "boolean",
      description: "tty / stream 通用。Explicit intent for wake-on-exit: true = wake the agent when this session/operation ends normally (bypasses filters); false = do not wake on normal end (stream 下仅记录，卡片照常)。Omit to use the default policy (wake on completion; tty 下需会话 ran >= 3s 或异常结束).",
    },
    stream: {
      type: "boolean",
      description: "Streaming mode: returns immediately with a live card (real-time output accrual). Retrieve the final result with the wait tool (opId comes back in result.details.streamOpId). Mutually exclusive with tty. 完成时默认唤醒 Agent（deferred 投递结果），wakeOnExit: false 只记录不唤醒。",
      default: false,
    },
  },
  required: ["connectionId", "command"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);

  if (!input.connectionId) {
    return { content: [{ type: "text", text: "connectionId is required (alias or internal id)." }] };
  }

  const started = Date.now();
  // 卡片 {name} 占位符：当前会话的 Agent 显示名（解析失败由渲染层回退 HRD）
  const agentName = resolveAgentName(ctx);
  let connId = null;
  let connInstance = null;
  let execResult = null; // 一次性命令执行结果：函数级 finally 落盘会话记录用（与 try 块作用域无关）
  let status = "ok";
  let reason = null;
  let exitCode = null;
  let summary = "";
  let output = ""; // 完整输出（stdout/stderr + 结局标注）：卡片详情展示 + result.details 供调用方读取
  let ttyHistId = null; // tty 会话：创建时记录，关闭时按结局回写同一条
  let opId = null; // 非 tty 执行：startOperation 的 opId（函数级，供 catch/finally 注入卡片）
  let catchRecorded = false; // catch 路径已自行 recordHistory（连接失败等 op 创建前抛错），外层 finally 跳过
  let streamHandled = false; // stream 模式：落盘/释放由后台执行自管，finally 跳过

  try {
    if (input.tty && input.stream) {
      return { content: [{ type: "text", text: "tty 与 stream 互斥：交互会话请用 tty，流式执行请用 stream" }] };
    }
    if (input.tty) {
      // tty 会话走独立会话连接（profileId#session）：与 exec 连接分离，
      // 长驻互不挤占、断开互不级联；同 profile 的 tty 会话共享该连接。
      connId = await rd.pathRef.ensureConnection(input.connectionId, { store: rd.connectionStore, session: true });
      connInstance = rd.sshClient.instanceOf(connId);
      const sessionId = await rd.sshClient.createSession(connId, input.command, {
        cwd: input.workdir,
        // 会话结局回写：历史记录在会话创建时写入（status=ok），关闭时按
        // 实际结局更新同一条（exit / killed / disconnect / lost）。
        onClose: (info) => {
          if (info.sessionId !== sessionId) return;
          // 输出尾部拼进 summary：断开/结束后历史记录里能看到会话最终输出
          //（类似 subagent 返回结果，避免输出只活在会话卡里）。
          const tail = info.outputTail ? `\n\n── 输出尾部 ──\n${info.outputTail}` : "";
          if (info.how === "exit") {
            rd.operations.updateHistory(ttyHistId, {
              status: "ok",
              exitCode: info.exitCode,
              durationMs: info.durationMs,
              summary: `会话结束 (exit ${info.exitCode})${tail}`,
            });
          } else if (info.how === "killed") {
            rd.operations.updateHistory(ttyHistId, {
              status: "killed",
              durationMs: info.durationMs,
              summary: `会话已终止${tail}`,
            });
          } else if (info.how === "disconnect") {
            rd.operations.updateHistory(ttyHistId, {
              status: "interrupted",
              reason: "disconnect",
              durationMs: info.durationMs,
              summary: `已断开：会话终止${tail}`,
            });
          } else {
            rd.operations.updateHistory(ttyHistId, {
              status: "interrupted",
              reason: "lost",
              durationMs: info.durationMs,
              summary: `会话中断${tail}`,
            });
          }
          // 自动唤醒：会话结局 → deferred 终态（register 结局时动态决策策略，
          // 结果随 hana-background-result 直达；busy 排队与补投由宿主托管）。
          const live = runtimeHolder.current;
          if (live?.bus) {
            // 会话日志已由 ssh-client 随运行增量落盘（createSession 时初始化、
            // close 时 finalize）；此处只取日志路径用于 result 的 HRD:// 引用。
            const sessionLogPath = live.sshClient?.getSessionLogPath?.(info.sessionId) || null;
            wake.wakeOnSessionEnd({
              bus: ctx.bus ?? live.bus,
              sessionPath: ctx.sessionPath,
              taskId: info.sessionId,
              label: input.command,
              how: info.how,
              exitCode: info.exitCode ?? null,
              durationMs: info.durationMs,
              outputTail: info.outputTail,
              sessionLogPath,
              wakeOnExit: typeof input.wakeOnExit === "boolean" ? input.wakeOnExit : undefined,
              log: live.log,
            }).catch(() => {}); // 唤醒失败不打扰 onClose 流程
          } else {
            live?.log?.info?.("wake skipped: bus unavailable");
          }
        },
      });
      // 会话日志已随运行增量落盘（ssh-client 内）；注册到当前工具会话，
      // agent 会话进行中即可通过 HRD://sessions/<id>.md 读取。
      try {
        const logPath = rd.sshClient.getSessionLogPath(sessionId);
        const live = runtimeHolder.current;
        if (logPath && live?.registerSessionFile && ctx.sessionRef) {
          live.registerSessionFile({
            sessionRef: ctx.sessionRef,
            filePath: logPath,
            label: `${sessionId}.md`,
            origin: "plugin_output",
            storageKind: "plugin_data",
          });
        }
      } catch {
        // 注册失败静默：HRD:// 寻址仍可读（read 工具直接解析 dataDir）
      }

      // Initial output arrives async after the exec callback; give it a beat.
      // 竞态：命令极快退出时会话已 close（readSession 抛 No active session），
      // 此时会话正常结束，初始输出不可读不报错（结局在日志/历史里）。
      await new Promise((r) => setTimeout(r, 300));
      let initial = "";
      try {
        initial = rd.sshClient.readSession(sessionId);
      } catch {
        /* 会话已结束 */
      }
      const parts = [`Session started: ${sessionId}\nCommand: ${input.command}`];
      if (initial) parts.push(initial);
      parts.push(`(interactive session; feed input via hrd_write_stdin, sessionId: ${sessionId})`);
      summary = `interactive session ${sessionId}`;
      ttyHistId = rd.operations.recordHistory({
        tool: "exec_command",
        label: input.command,
        connId,
        connInstance,
        agentName,
        status,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        exitCode: null,
        summary,
      });
      return attachCard(
        {
          content: [{ type: "text", text: parts.join("\n") }],
          details: { sessionId, connectionId: connId },
        },
        { opId: ttyHistId, label: input.command, summary }
      );
    }

    // ── stream 模式：立即返回 + 后台执行 + 卡片实时推进 ──
    // 仿 download-progress：工具不阻塞（卡片随 result 挂载时命令还在跑），
    // 输出经 appendOpOutput 增量进 in-flight 状态，卡片轮询 /ops/status
    // 由 running 态一路推到完成态；Agent 用 wait 取终局结果。
    if (input.stream) {
      connId = await rd.pathRef.ensureConnection(input.connectionId, { store: rd.connectionStore });
      connInstance = rd.sshClient.instanceOf(connId);
      let streamRef = null;
      let killed = false;
      opId = rd.operations.startOperation({
        connId,
        connInstance,
        agentName,
        kind: "exec",
        label: input.command,
        kill: () => {
          killed = true;
          try {
            streamRef?.close();
          } catch {
            /* stream may already be gone */
          }
        },
      });
      // deferred 注册：完成即唤醒宿主 Agent（卡片完成 = 任务终态 = 宿主原生钩子）。
      // 结果随 hana-background-result 直接送达，Agent 无需信标二次查询。
      // bus 优先用工具执行 ctx（宿主按调用注入，与 download-progress 同源）；
      // runtime.bus（install 时 ctx）仅兑底。
      const live0 = runtimeHolder.current;
      await wake.registerDeferredWake({
        bus: ctx.bus ?? live0?.bus,
        sessionPath: ctx.sessionPath,
        taskId: opId,
        label: input.command,
        wakeOnExit: typeof input.wakeOnExit === "boolean" ? input.wakeOnExit : undefined,
        log: live0?.log,
      });
      // 后台执行（fire-and-forget）：结局判定与常规 exec 一致，终局落盘 + 释放；
      // 卡片轮询不受工具返回影响（op_xxx 先命中 in-flight，落盘后命中磁盘双写副本）。
      rd.sshClient
        .exec(connId, input.command, {
          cwd: input.workdir,
          timeout: input.timeout,
          onStream: (s) => {
            streamRef = s;
            try {
              s.on("data", (d) => rd.operations.appendOpOutput(opId, String(d)));
              s.stderr.on("data", (d) => rd.operations.appendOpOutput(opId, String(d)));
            } catch {
              /* 监听失败不影响执行 */
            }
          },
        })
        .then((result) => {
          let st = "ok";
          let rs = null;
          let sm = "";
          if (killed) {
            st = "killed";
            sm = "operation killed";
          } else if (result.timedOut) {
            st = "timeout";
            sm = `命令超时（超过 ${input.timeout || 30}s）`;
          } else if (result.code === undefined) {
            st = "interrupted";
            rs = rd.sshClient.wasManuallyDisconnected(connId) ? "disconnect" : "lost";
            sm = rs === "disconnect" ? "已断开：命令未完成" : "连接丢失：命令未完成";
          }
          const parts = [];
          if (result.stdout) parts.push(`── stdout ──\n${result.stdout}`);
          if (result.stderr) parts.push(`── stderr ──\n${result.stderr}`);
          if (!result.stdout && !result.stderr) parts.push("(no output)");
          if (result.timedOut) parts.push(`\n命令超时：超过 ${input.timeout || 30}s 未完成`);
          if (result.code === undefined && !result.timedOut) parts.push("\n连接中断：命令未完成（通道已关闭）");
          if (!killed && result.code !== undefined) parts.push(`\nExit code: ${result.code}`);
          rd.operations.recordHistory({
            tool: "exec_command",
            label: input.command,
            connId,
            connInstance,
            agentName,
            status: st,
            reason: rs,
            startedAt: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            exitCode: result.code ?? null,
            summary: sm,
            output: parts.join("\n"),
            opRef: opId,
          });
          rd.operations.endOperation(opId);
          writeCommandLog(rd, input, connId, result, { status: st, reason: rs, started });
          // deferred 终态：完成结果送达宿主（默认唤醒 Agent 回合；wakeOnExit=false 仅记录）
          wake.resolveDeferredWake({
            bus: ctx.bus ?? runtimeHolder.current?.bus,
            taskId: opId,
            result: {
              opId,
              tool: "exec_command",
              status: st,
              exitCode: result.code ?? null,
              durationMs: Date.now() - started,
              label: String(input.command || ""),
              output: parts.join("\n").slice(0, 4096), // 消息体截断；完整输出在卡片/落盘
            },
            log: runtimeHolder.current?.log,
          });
        })
        .catch((err) => {
          const timedOut = err?.hrdTimedOut === true;
          // 失败前可能已有部分输出（appendOpOutput 增量）：先取快照再释放
          const partial = rd.operations.readOperation(opId)?.output || "";
          rd.operations.recordHistory({
            tool: "exec_command",
            label: input.command,
            connId,
            connInstance,
            agentName,
            status: timedOut ? "timeout" : "error",
            reason: null,
            startedAt: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            exitCode: null,
            summary: timedOut ? `命令超时（超过 ${input.timeout || 30}s）` : String(err?.message || err).slice(0, 300),
            output: partial,
            opRef: opId,
          });
          rd.operations.endOperation(opId);
          // deferred 失败终态：notifyAgentOnFailure=true → 宿主唤醒 Agent 决策
          wake.failDeferredWake({
            bus: ctx.bus ?? runtimeHolder.current?.bus,
            taskId: opId,
            error: {
              message: `${timedOut ? "timeout" : "error"}: ${(timedOut ? `命令超时（超过 ${input.timeout || 30}s）` : String(err?.message || err)).slice(0, 300)}`,
            },
            log: runtimeHolder.current?.log,
          });
        });
      streamHandled = true;
      // 立即返回：对话主区只显示命令；卡片从挂载即 running，输出逐行推进
      return attachCard(
        {
          content: [{ type: "text", text: String(input.command || input.connectionId || "exec_command") }],
          details: { streamOpId: opId, stream: true },
        },
        { opId, label: input.command, summary: "", output: "", stream: true }
      );
    }

    // 常规 exec：复用常规连接（排除会话连接）
    connId = await rd.pathRef.ensureConnection(input.connectionId, { store: rd.connectionStore });
    connInstance = rd.sshClient.instanceOf(connId);
    let stream = null;
    let killed = false;
    opId = rd.operations.startOperation({
      connId,
      connInstance,
      agentName,
      kind: "exec",
      label: input.command,
      kill: () => {
        killed = true;
        try {
          stream?.close();
        } catch {
          // stream may already be gone
        }
      },
    });
    try {
      const result = await rd.sshClient.exec(connId, input.command, {
        cwd: input.workdir,
        timeout: input.timeout,
        onStream: (s) => {
          stream = s;
          // 常规 exec 也推增量：长命令（apt install / build）执行中
          // 面板进行中操作实时显示输出（64KB 截断，内存最近窗口）
          try {
            s.on("data", (d) => rd.operations.appendOpOutput(opId, String(d)));
            s.stderr.on("data", (d) => rd.operations.appendOpOutput(opId, String(d)));
          } catch {
            /* 监听失败不影响执行 */
          }
        },
      });
      execResult = result;
      exitCode = result.code ?? null;
      if (killed) {
        status = "killed";
        summary = "operation killed";
        return attachCard(
          { content: [{ type: "text", text: `Operation killed: ${input.command}` }] },
          { opId, label: input.command, summary }
        );
      }
      const parts = [];
      if (result.stdout) parts.push(`── stdout ──\n${result.stdout}`);
      if (result.stderr) parts.push(`── stderr ──\n${result.stderr}`);
      if (!result.stdout && !result.stderr) parts.push("(no output)");
      let contentText;
      if (result.timedOut) {
        // 命令超时（ssh-client 主动关流）：系统行为，与连接中断区分。
        const secs = input.timeout || 30;
        parts.push(`\n命令超时：超过 ${secs}s 未完成`);
        status = "timeout";
        summary = `命令超时（超过 ${secs}s）`;
        contentText = `Command timeout: exceeded ${secs}s`;
      } else if (result.code === undefined) {
        // Channel closed without an exit status: the connection was torn
        // down mid-flight (disconnect / destroy).
        parts.push("\n连接中断：命令未完成（通道已关闭）");
        status = "interrupted";
        // 区分「用户叫停」（断开按钮 / cfg_disconnect）与「被动丢失」（网络异常）
        const manual = rd.sshClient.wasManuallyDisconnected(connId);
        if (manual) {
          reason = "disconnect";
          summary = "已断开：命令未完成";
          parts.push("（连接被主动断开）");
        } else {
          reason = "lost";
          summary = "连接丢失：命令未完成";
        }
        contentText = `命令未完成（${reason === "disconnect" ? "连接被主动断开" : "连接丢失"}）`;
      } else {
        parts.push(`\nExit code: ${result.code}`);
        // 卡片不显示输出摘要行：只留命令（op-sub）+ 详情退出码（op-d-row）
        summary = "";
        // 对话主区只显示跑了什么命令（摘要/输出全部收进卡片详情）
        contentText = String(input.command || input.connectionId || "exec_command");
      }
      // 完整输出（含结局标注）：卡片详情展示 + 随 result 返回给调用方
      output = parts.join("\n");      return attachCard(
        { content: [{ type: "text", text: contentText }], details: { output } },
        { opId, label: input.command, summary, output }
      );
    } finally {
      rd.operations.endOperation(opId);
    }
  } catch (err) {
    // 超时（failsafe reject 带 hrdTimedOut 标记）单独成态；其余为执行错误。
    const timedOut = err?.hrdTimedOut === true;
    status = timedOut ? "timeout" : "error";
    summary = timedOut
      ? `命令超时（超过 ${input.timeout || 30}s）`
      : String(err?.message || err).slice(0, 300);
    // catch 路径（连接失败/启动前抛错）可能没有 opId：自行记录历史拿 h_id 兜底注入卡片，
    // 置 catchRecorded 让外层 finally 跳过（避免双记录；连接失败本就不写命令日志）。
    const hid = rd.operations.recordHistory({
      tool: "exec_command",
      label: input.command,
      connId,
      connInstance,
      agentName,
      status,
      reason,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      exitCode,
      summary,
      opRef: opId || undefined,
    });
    catchRecorded = true;
    return attachCard(
      {
        content: [
          {
            type: "text",
            text: timedOut
              ? `Command timeout: exceeded ${input.timeout || 30}s`
              : `Execution failed: ${rd.errText.describeError(err)}`,
          },
        ],
      },
      { opId: opId || hid, label: input.command, summary }
    );
  } finally {
    // 唯一收口：所有路径（ok / killed / interrupted / error）只记一条历史。
    // tty 会话例外：由 tty 分支自行记录（status=ok + 会话创建），结局在
    // 会话关闭时通过 updateHistory 回写——单一收口不适用（结局异步）。
    if (!ttyHistId && !catchRecorded && !streamHandled) {
      rd.operations.recordHistory({
      tool: "exec_command",
      label: input.command,
      connId,
      connInstance,
      agentName,
      status,
      reason,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      exitCode,
      summary,
      output,
      opRef: opId,
    });
      // 一次性命令记录：执行已发生（execResult 非空）才落盘；连接失败等未执行场景不记。
      writeCommandLog(rd, input, connId, execResult, { status, reason, started });
    }
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}

/** 一次性命令记录：命令执行完成后整段落盘（session/<yyyy-mm-dd>/<id>.md，与 tty 会话同构统一模板）。
 *  记录完整 stdout/stderr 与结局；失败静默（best effort，不影响命令结果）。 */
function writeCommandLog(rd, input, connId, result, { status, reason, started }) {
  if (!rd.sessionLogDir || !rd.sessionLog || !connId || !result) return;
  try {
    const sessionId = rd.sshClient.nextSessionId();
    const startedAt = new Date(started);
    const logger = rd.sessionLog.createSessionLogger({
      dir: rd.sessionLogDir,
      sessionId,
      connId,
      command: String(input.command),
      startedAt,
      kind: "exec",
    });
    if (!logger) return;
    const out = [];
    if (result.stdout) out.push(`── stdout ──\n${result.stdout}`);
    if (result.stderr) out.push(`── stderr ──\n${result.stderr}`);
    if (!result.stdout && !result.stderr) out.push("(no output)");
    if (result.timedOut) out.push(`\n命令超时：超过 ${input.timeout || 30}s 未完成`);
    if (result.code === undefined && !result.timedOut) {
      out.push("\n连接中断：命令未完成（通道已关闭）");
    }
    logger.appendOutput(out.join("\n"));
    const endedAt = new Date();
    let how = "exit";
    let howText = null;
    if (status === "killed") {
      how = "killed";
    } else if (result.timedOut) {
      howText = `timeout（超过 ${input.timeout || 30}s 未完成）`;
    } else if (result.code === undefined) {
      how = reason === "disconnect" ? "disconnect" : "lost";
    }
    logger.finalize({
      how,
      howText,
      exitCode: result.code ?? null,
      durationMs: endedAt.getTime() - started,
      startedAt,
      endedAt,
      outputBytes: Buffer.byteLength(out.join("\n"), "utf8"),
    });
  } catch {
    /* best effort */
  }
}
