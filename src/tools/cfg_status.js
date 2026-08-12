import { runtimeHolder } from "../lib/runtime.js";

export const name = "cfg_status";
export const description = "Inspect the panel-side state: active connections, interactive sessions, in-flight operations, and the panel channel. Omit connectionId for the full picture.";

export const parameters = {
  type: "object",
  properties: {
    connectionId: {
      type: "string",
      description: "Connection alias, profile id, or active connection id. When set, only that connection's sessions/operations are shown.",
    },
    sessionId: {
      type: "string",
      description: "Query a specific session by its id (timestamp+random) or session record HRD://sessions/<id>.md. Active sessions show live state; ended sessions show the outcome snapshot (how / exitCode / duration / output).",
    },
    output: {
      type: "string",
      enum: ["tail", "full"],
      description: "How much session stdio output to include (default tail: last 1KB). full returns the complete buffered output (bounded by the 1MB session buffer cap).",
    },
  },
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const active = rd.sshClient.listConnections();
  const allSessions = rd.sshClient.listSessions();
  const allOps = rd.operations.listOperations();
  const socket = rd.localSocket;

  // 指定会话：活跃优先，否则查结束快照（唤醒信标的查询入口）。
  if (input.sessionId) {
    const full = input.output === "full";
    const live = allSessions.find((s) => s.sessionId === input.sessionId);
    if (live) {
      const out = full ? live.buffer : stripAnsiTail(live.buffer);
      const tail = full && live.truncated ? "\n[注意: 活跃期输出超过 1MB 缓冲上限，最早部分已丢弃]" : "";
      return {
        content: [{ type: "text", text: `会话 ${live.sessionId} [${handleByConn(ctx, live.connId)}]: ● 活跃中 "${live.command}" started ${live.startedAt.toISOString()}\n${out}${tail}` }],
        details: { session: live, status: "active", outputMode: full ? "full" : "tail" },
      };
    }
    const ended = rd.sshClient.getSessionHistory(input.sessionId);
    if (ended) {
      const out = full ? ended.output : ended.output.slice(-1024);
      const truncatedNote = full && ended.truncated ? "\n[注意: 输出超过 1MB 缓冲上限，最早部分已丢弃]" : "";
      const text = [
        `会话 ${ended.sessionId} [${handleByConn(ctx, ended.connId)}]: ○ 已结束 "${ended.command}"`,
        `结局: ${howText(ended.how, ended.exitCode)}`,
        `耗时: ${Math.round((ended.durationMs || 0) / 1000)}s`,
        `起止: ${ended.startedAt.toISOString()} → ${ended.endedAt.toISOString()}`,
        full ? `输出（${ended.outputBytes} bytes）:` : "── 输出尾部 ──",
        out,
        truncatedNote,
      ].join("\n");
      return { content: [{ type: "text", text }], details: { session: ended, status: "ended", outputMode: full ? "full" : "tail" } };
    }
    return { content: [{ type: "text", text: `未找到会话：${input.sessionId}（可能超出历史保留上限）` }], details: { session: null } };
  }

  if (input.connectionId) {
    const conn = findByHandle(active, input.connectionId);
    if (!conn) {
      return { content: [{ type: "text", text: `No active connection: ${input.connectionId}` }] };
    }
    const healthy = rd.sshClient.isConnected(conn.id);
    const sessions = allSessions.filter((s) => s.connId === conn.id);
    const ops = allOps.filter((o) => o.connId === conn.id);
    const lines = [
      `连接 ${handleOf(conn, ctx)}: ${healthy ? "● healthy" : "○ disconnected"}`,
      `  ${conn.username}@${conn.host}:${conn.port}`,
      `  建立: ${conn.connectedAt.toISOString()}`,
      `  来源: 自动建连`,
      `Sessions (${sessions.length}): ${sessions.length ? sessions.map((s) => `${s.sessionId} "${s.command}"`).join("; ") : "(none)"}`,
      `Operations (${ops.length}): ${ops.length ? ops.map((o) => `${o.opId}[${o.kind}] ${o.label}${o.killable ? "" : " (not killable)"}`).join("; ") : "(none)"}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }], details: { conn, sessions, operations: ops } };
  }

  const parts = [`Active connections (${active.length}):`];
  if (active.length === 0) {
    parts.push("  (none)");
  } else {
    for (const c of active) {
      const healthy = rd.sshClient.isConnected(c.id);
      parts.push(`  ${handleOf(c, ctx)}: ${healthy ? "●" : "○"} ${c.username}@${c.host}:${c.port} (since ${c.connectedAt.toISOString()})`);
    }
  }

  parts.push(`\nSessions (${allSessions.length}):`);
  if (allSessions.length === 0) {
    parts.push("  (none)");
  } else {
    for (const s of allSessions) {
      parts.push(`  ${s.sessionId} [${handleByConn(ctx, s.connId)}] "${s.command}" started ${s.startedAt.toISOString()}`);
    }
  }

  parts.push(`\nOperations (${allOps.length}):`);
  if (allOps.length === 0) {
    parts.push("  (none)");
  } else {
    for (const o of allOps) {
      parts.push(`  ${o.opId} [${o.kind}] ${o.label}${o.killable ? "" : " (not killable)"}`);
    }
  }

  parts.push(`\nChannel: ${socket?.port ? `socket 127.0.0.1:${socket.port}` : "unavailable"}`);

  return {
    content: [{ type: "text", text: parts.join("\n") }],
    details: { connections: active, sessions: allSessions, operations: allOps, socket: socket?.port ? { port: socket.port } : null },
  };
}

/** Match by alias, profileId, or pool key. */
function findByHandle(active, ref) {
  return active.find((c) => c.id === ref || c.handle === ref || c.alias === ref);
}

/** 结局文案（与 exec_command 历史回写同款格式）。 */
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

/** 去 ANSI 后的输出尾部（1KB）。 */
function stripAnsiTail(s) {
  return String(s || "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][0-9A-Z]/g, "")
    .slice(-1024);
}

/** Human-facing handle: current profile alias (resolved via store, so a
 *  cfg_edit rename is reflected), falling back to the connection snapshot. */
function handleOf(conn, ctx) {
  const store = ctx?._remoteDev?.connectionStore;
  if (store && conn.profileId) {
    try {
      const p = store.get(conn.profileId);
      if (p) return p.alias || p.name;
    } catch {
      // fall through to snapshot
    }
  }
  return conn.alias || conn.id;
}

/** Resolve a connection id to its display handle (for session rows). */
function handleByConn(ctx, connId) {
  const conn = requireRuntime(ctx).sshClient.listConnections().find((c) => c.id === connId);
  if (!conn) return connId;
  return handleOf(conn, ctx);
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}

