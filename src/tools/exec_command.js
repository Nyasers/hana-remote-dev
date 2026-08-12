import { runtimeHolder } from "../lib/runtime.js";
import * as wake from "../lib/wake.js";
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
      description: "tty only. Explicit intent for wake-on-exit: true = wake the agent when this session ends normally (bypasses filters); false = do not wake on normal exit. Omit to use the default policy (wake if session ran >= 3s or ended abnormally).",
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
  let connId = null;
  let connInstance = null;
  let execResult = null; // 一次性命令执行结果：函数级 finally 落盘会话记录用（与 try 块作用域无关）
  let status = "ok";
  let reason = null;
  let exitCode = null;
  let summary = "";
  let ttyHistId = null; // tty 会话：创建时记录，关闭时按结局回写同一条

  try {
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
          // 自动唤醒（旁路通知）：按 wakeOn 策略过滤结局，消息 = 结局 + 输出尾部。
          // runtime 引用用 runtimeHolder.current（reload 后旧 ctx 快照指向 disposed
          // 实例）。bus 来自插件实例 ctx（install 时存入 runtime），工具 ctx 无 bus；
          // sessionPath 来自工具 ctx（宿主每次调用注入，闭包捕获自工具调用时）。
          const live = runtimeHolder.current;
          if (live?.wakeOn?.length && live.bus) {
            // 会话日志已由 ssh-client 随运行增量落盘（createSession 时初始化、
            // close 时 finalize）；此处只取日志路径用于信标（HRD:// 引用）。
            const sessionLogPath = live.sshClient?.getSessionLogPath?.(info.sessionId) || null;
            wake.maybeWakeAgent({
              bus: live.bus,
              sessionPath: ctx.sessionPath,
              wakeOn: live.wakeOn,
              log: live.log,
              info: {
                sessionId: info.sessionId,
                command: String(input.command),
                how: info.how,
                exitCode: info.exitCode ?? null,
                durationMs: info.durationMs,
                outputTail: info.outputTail,
                sessionLogPath,
                wakeOnExit: typeof input.wakeOnExit === "boolean" ? input.wakeOnExit : undefined,
              },
            }).catch(() => {}); // 唤醒失败不打扰 onClose 流程
          } else {
            live?.log?.info?.(`wake not configured: wakeOn=${JSON.stringify(live?.wakeOn)}`);
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
        status,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        exitCode: null,
        summary,
      });
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { sessionId, connectionId: connId },
      };
    }

    // 常规 exec：复用常规连接（排除会话连接）
    connId = await rd.pathRef.ensureConnection(input.connectionId, { store: rd.connectionStore });
    connInstance = rd.sshClient.instanceOf(connId);
    let stream = null;
    let killed = false;
    const opId = rd.operations.startOperation({
      connId,
      connInstance,
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
        },
      });
      execResult = result;
      exitCode = result.code ?? null;
      if (killed) {
        status = "killed";
        summary = "operation killed";
        return { content: [{ type: "text", text: `Operation killed: ${input.command}` }] };
      }
      const parts = [];
      if (result.stdout) parts.push(`── stdout ──\n${result.stdout}`);
      if (result.stderr) parts.push(`── stderr ──\n${result.stderr}`);
      if (!result.stdout && !result.stderr) parts.push("(no output)");
      if (result.timedOut) {
        // 命令超时（ssh-client 主动关流）：系统行为，与连接中断区分。
        const secs = input.timeout || 30;
        parts.push(`\n命令超时：超过 ${secs}s 未完成`);
        status = "timeout";
        summary = `命令超时（超过 ${secs}s）`;
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
      } else {
        parts.push(`\nExit code: ${result.code}`);
        const outText = (result.stdout || "").trim();
        summary = (outText ? outText.split("\n")[0].slice(0, 160) : "") + ` (exit ${result.code})`;
      }
      return { content: [{ type: "text", text: parts.join("\n") }] };
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
    return {
      content: [
        {
          type: "text",
          text: timedOut
            ? `Command timeout: exceeded ${input.timeout || 30}s`
            : `Execution failed: ${rd.errText.describeError(err)}`,
        },
      ],
    };
  } finally {
    // 唯一收口：所有路径（ok / killed / interrupted / error）只记一条历史。
    // tty 会话例外：由 tty 分支自行记录（status=ok + 会话创建），结局在
    // 会话关闭时通过 updateHistory 回写——单一收口不适用（结局异步）。
    if (!ttyHistId) {
      rd.operations.recordHistory({
      tool: "exec_command",
      label: input.command,
      connId,
      connInstance,
      status,
      reason,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      exitCode,
      summary,
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
