import fs from "node:fs";
import path from "node:path";
import { runtimeHolder } from "../lib/runtime.js";
import { attachCard } from "../lib/card-utils.js";
import { resolveAgentName } from "../lib/agent-name.js";
export const name = "file";
export const description = "Remote file metadata (stat) and universal copy: local↔remote, remote↔remote (same connection via cp, cross-connection via streaming relay). Local↔local copies also work (intentional redundancy, SCP semantics: bare paths are local).";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["stat", "copy"],
      description: "stat: inspect a remote path. copy: copy source to target.",
    },
    source: {
      type: "string",
      description: "Source path. Remote form: alias:/path. Bare paths are local (e.g. ./local.txt, C:\\data\\x).",
    },
    target: {
      type: "string",
      description: "Copy target path (required for copy). Same addressing as source.",
    },
  },
  required: ["action", "source"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const store = rd.connectionStore;

  const started = Date.now();
  const label = `${input.action} ${input.source}${input.target ? " → " + input.target : ""}`.slice(0, 160);
  // 卡片 {name} 占位符：当前会话的 Agent 显示名（解析失败由渲染层回退 HRD）
  const agentName = resolveAgentName(ctx);
  const rec = (status, summary, exitCode = null, connId = null, opRef = null, connInstance = null) => {
    const id = rd.operations.recordHistory({
      tool: "file",
      label,
      connId,
      // 连接实例 id 在连接存活时取（withOperation 传入）；此时重查可能已释放落空。
      connInstance: connInstance ?? (connId ? rd.sshClient.instanceOf(connId) : null),
      agentName,
      status,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      exitCode,
      summary: String(summary || "").slice(0, 300),
      // copy 分支：关联 withOperation 的 opId，卡片按 op_xxx 查完成态；
      // 缺失会导致 getHistory(op_xxx) 查不到（stat 用 h_id 主键不受影响）。
      opRef,
    });
    return id;
  };

  if (input.action === "stat") {
    const ref = rd.pathRef.parsePathRef(input.source);
    if (ref.kind !== "remote") {
      const hid = rec("error", "stat 仅支持远程路径", null, null);
      return attachCard(
        { content: [{ type: "text", text: "hrd_file stat operates on remote paths; use the local file tool for local stats. Got: " + input.source }] },
        { opId: hid, label, summary: "stat 仅支持远程路径" }
      );
    }
    try {
      const { connId, path } = await rd.pathRef.resolveRemote(ref, { store });
      const client = await rd.sshClient.sftp(connId);
      try {
        const st = await client.stat(path);
        const hid = rec("ok", `${path}: ${st.isDirectory ? "directory" : "file"}, ${st.size} bytes`, null, connId);
        return attachCard(
          {
            content: [{ type: "text", text: `${path}:\n  type: ${st.isDirectory ? "directory" : "file"}\n  size: ${st.size} bytes\n  mode: 0o${st.mode?.toString(8) ?? "?"}\n  modified: ${st.modifyTime ?? "-"}` }],
            details: st,
          },
          { opId: hid, label, summary: `${path}: ${st.isDirectory ? "directory" : "file"}, ${st.size} bytes` }
        );
      } finally {
        client.end();
      }
    } catch (err) {
      const hid = rec("error", rd.errText.describeError(err), null, null);
      return attachCard(
        { content: [{ type: "text", text: `Failed to stat: ${rd.errText.describeError(err)}` }] },
        { opId: hid, label, summary: rd.errText.describeError(err) }
      );
    }
  }

  if (input.action === "copy") {
    if (!input.target) {
      rec("error", "target is required for copy", null, null);
      return { content: [{ type: "text", text: "target is required for copy." }] };
    }
    const src = rd.pathRef.parsePathRef(input.source);
    const dst = rd.pathRef.parsePathRef(input.target);

    try {
      if (src.kind === "local" && dst.kind === "local") {
        await fs.promises.mkdir(path.dirname(dst.path), { recursive: true });
        await fs.promises.copyFile(src.path, dst.path);
        rec("ok", `Copied ${src.path} → ${dst.path}`);
        return { content: [{ type: "text", text: `Copied ${src.path} → ${dst.path}` }] };
      }

      if (src.kind === "local" && dst.kind === "remote") {
        const { connId, path: remotePath } = await rd.pathRef.resolveRemote(dst, { store });
        const client = await rd.sshClient.sftp(connId);
        let rs = null;
        let ws = null;
        let r;
        const streamMode = input.stream === true;
        const workCopy = async ({ append } = {}) => {
          await mkdirpRemote(client, remotePath);
          rs = fs.createReadStream(src.path);
          ws = client.createWriteStream(remotePath);
          // 增量进度：已传字节（stream 模式下进卡片实时输出；阻塞模式无害）
          rs.on("data", () => append?.(`uploaded ${rs.bytesRead} bytes\n`));
          await pipeStreams(rs, ws);
        };
        const onSuccess = (out) => {
          if (out?.__killed) {
            rec("killed", `upload ${src.path} → ${input.target}`, null, connId, out.opId, out.connInstance);
            return;
          }
          const sm = `Uploaded ${src.path} → ${input.target}`;
          rec("ok", sm, null, connId, out.opId, out.connInstance);
          // deferred 终态：完成唤醒（默认）或仅记录（wakeOnExit=false）
          wake.resolveDeferredWake({
            bus: ctx.bus ?? runtimeHolder.current?.bus,
            taskId: out.opId,
            result: {
              opId: out.opId,
              tool: "file",
              status: "ok",
              durationMs: Date.now() - started,
              label,
              output: sm.slice(0, 2048),
            },
            log: runtimeHolder.current?.log,
          });
        };
        const onError = (err) => {
          rec("error", String(err?.message || err).slice(0, 300), null, connId, r.opId, r.connInstance);
          wake.failDeferredWake({
            bus: ctx.bus ?? runtimeHolder.current?.bus,
            taskId: r.opId,
            error: { message: String(err?.message || err).slice(0, 300) },
            log: runtimeHolder.current?.log,
          });
        };
        r = await withOperation(
          {
            connId,
            kind: "copy",
            label: `Upload ${src.path} → ${input.target}`,
            agentName,
            stream: streamMode,
            kill: () => {
              try { rs?.destroy(); } catch { /* ignore */ }
              try { ws?.destroy(); } catch { /* ignore */ }
              client.unlink(remotePath).catch(() => {});
            },
          },
          workCopy,
          {
            onSuccess,
            onError,
            // stream 模式：后台 work 结束后才释放 sftp client（阻塞模式在下方 finally）
            onFinally: () => client.end().catch(() => {}),
          }
        );
        if (streamMode) {
          return attachCard(
            { content: [{ type: "text", text: String(label) }], details: { streamOpId: r.opId, stream: true } },
            { opId: r.opId, label, summary: "" }
          );
        }
        try {
          if (r?.__killed) {
            rec("killed", `upload ${src.path} → ${input.target}`, null, connId, r.opId, r.connInstance);
            return attachCard(
              { content: [{ type: "text", text: `Operation killed: upload ${src.path} → ${input.target}` }] },
              { opId: r.opId, label, summary: "operation killed" }
            );
          }
          rec("ok", `Uploaded ${src.path} → ${input.target}`, null, connId, r.opId, r.connInstance);
          return attachCard(
            { content: [{ type: "text", text: `Uploaded ${src.path} → ${input.target}` }] },
            { opId: r.opId, label, summary: `Uploaded ${src.path} → ${input.target}` }
          );
        } finally {
          client.end();
        }
      }

      if (src.kind === "remote" && dst.kind === "local") {
        const { connId, path: remotePath } = await rd.pathRef.resolveRemote(src, { store });
        const client = await rd.sshClient.sftp(connId);
        let rs = null;
        let ws = null;
        let r;
        const streamMode = input.stream === true;
        const workCopy = async ({ append } = {}) => {
          await fs.promises.mkdir(path.dirname(dst.path), { recursive: true });
          rs = client.createReadStream(remotePath);
          ws = fs.createWriteStream(dst.path);
          // 增量进度：已传字节（stream 模式下进卡片实时输出；阻塞模式无害）
          rs.on("data", () => append?.(`downloaded ${rs.bytesRead} bytes\n`));
          await pipeStreams(rs, ws);
        };
        const onSuccess = (out) => {
          if (out?.__killed) {
            rec("killed", `download ${input.source} → ${dst.path}`, null, connId, out.opId, out.connInstance);
            return;
          }
          const sm = `Downloaded ${input.source} → ${dst.path}`;
          rec("ok", sm, null, connId, out.opId, out.connInstance);
          // deferred 终态：完成唤醒（默认）或仅记录（wakeOnExit=false）
          wake.resolveDeferredWake({
            bus: ctx.bus ?? runtimeHolder.current?.bus,
            taskId: out.opId,
            result: {
              opId: out.opId,
              tool: "file",
              status: "ok",
              durationMs: Date.now() - started,
              label,
              output: sm.slice(0, 2048),
            },
            log: runtimeHolder.current?.log,
          });
        };
        const onError = (err) => {
          rec("error", String(err?.message || err).slice(0, 300), null, connId, r.opId, r.connInstance);
          wake.failDeferredWake({
            bus: ctx.bus ?? runtimeHolder.current?.bus,
            taskId: r.opId,
            error: { message: String(err?.message || err).slice(0, 300) },
            log: runtimeHolder.current?.log,
          });
        };
        r = await withOperation(
          {
            connId,
            kind: "copy",
            label: `Download ${input.source} → ${dst.path}`,
            agentName,
            stream: streamMode,
            kill: () => {
              try { rs?.destroy(); } catch { /* ignore */ }
              try { ws?.destroy(); } catch { /* ignore */ }
              fs.promises.unlink(dst.path).catch(() => {});
            },
          },
          workCopy,
          {
            onSuccess,
            onError,
            // stream 模式：后台 work 结束后才释放 sftp client（阻塞模式在下方 finally）
            onFinally: () => client.end().catch(() => {}),
          }
        );
        if (streamMode) {
          return attachCard(
            { content: [{ type: "text", text: String(label) }], details: { streamOpId: r.opId, stream: true } },
            { opId: r.opId, label, summary: "" }
          );
        }
        try {
        if (r?.__killed) {
          rec("killed", `download ${input.source} → ${dst.path}`, null, connId, r.opId, r.connInstance);
          return attachCard(
            { content: [{ type: "text", text: `Operation killed: download ${input.source} → ${dst.path}` }] },
            { opId: r.opId, label, summary: "operation killed" }
          );
        }
        rec("ok", `Downloaded ${input.source} → ${dst.path}`, null, connId, r.opId, r.connInstance);
        return attachCard(
          { content: [{ type: "text", text: `Downloaded ${input.source} → ${dst.path}` }] },
          { opId: r.opId, label, summary: `Downloaded ${input.source} → ${dst.path}` }
        );
        } finally {
          client.end();
        }
      }

      // remote → remote
      const srcRes = await rd.pathRef.resolveRemote(src, { store });
      const dstRes = await rd.pathRef.resolveRemote(dst, { store });
      if (srcRes.connId === dstRes.connId) {
        // same connection: server-side cp, zero transfer.
        // mkdir 并入 exec 命令（借出 sftp 建目录会触发 releaseIfIdle 释放连接，
        // 后续 exec 将找不到连接——与 edit 双 sftp 同类问题）。
        let stream = null;
        let killed = false;
        const result = await withOperation(
          {
            connId: srcRes.connId,
            kind: "copy",
            label: `Copy ${input.source} → ${input.target}`,
            agentName,
            kill: () => {
              killed = true;
              try {
                stream?.close();
              } catch { /* ignore */ }
            },
          },
          async () =>
            rd.sshClient.exec(
              srcRes.connId,
              `${mkdirCmd(dstRes.path)}cp ${shellQuote(srcRes.path)} ${shellQuote(dstRes.path)}`,
              {
                onStream: (s) => {
                  stream = s;
                },
              }
            )
        );
        if (killed) {
          rec("killed", `copy ${input.source} → ${input.target}`, null, srcRes.connId, result.opId, result.connInstance);
          return attachCard(
            { content: [{ type: "text", text: `Operation killed: copy ${input.source} → ${input.target}` }] },
            { opId: result.opId, label, summary: "operation killed" }
          );
        }
        if (result.code !== 0) {
          rec("error", `cp failed (exit ${result.code})`, result.code, srcRes.connId, result.opId, result.connInstance);
          return attachCard(
            { content: [{ type: "text", text: `cp failed (exit ${result.code}): ${result.stderr || "(no stderr)"}` }] },
            { opId: result.opId, label, summary: `cp failed (exit ${result.code})` }
          );
        }
        rec("ok", `Copied ${input.source} → ${input.target}`, 0, srcRes.connId, result.opId, result.connInstance);
        return attachCard(
          { content: [{ type: "text", text: `Copied ${input.source} → ${input.target}` }] },
          { opId: result.opId, label, summary: `Copied ${input.source} → ${input.target}` }
        );
      }

      // cross-connection: streaming relay through the local host, no disk
      const clientA = await rd.sshClient.sftp(srcRes.connId);
      const clientB = await rd.sshClient.sftp(dstRes.connId);
      let rs = null;
      let ws = null;
      try {
        const r = await withOperation(
          {
            connId: srcRes.connId,
            kind: "copy",
            label: `Relay ${input.source} → ${input.target}`,
            agentName,
            kill: () => {
              try { rs?.destroy(); } catch { /* ignore */ }
              try { ws?.destroy(); } catch { /* ignore */ }
              clientB.unlink(dstRes.path).catch(() => {});
            },
          },
          async () => {
            await mkdirpRemote(clientB, dstRes.path);
            rs = clientA.createReadStream(srcRes.path);
            ws = clientB.createWriteStream(dstRes.path);
            await pipeStreams(rs, ws);
          }
        );
        if (r?.__killed) {
          rec("killed", `relay ${input.source} → ${input.target}`, null, srcRes.connId, r.opId, r.connInstance);
          return attachCard(
            { content: [{ type: "text", text: `Operation killed: relay ${input.source} → ${input.target}` }] },
            { opId: r.opId, label, summary: "operation killed" }
          );
        }
      } finally {
        clientA.end();
        clientB.end();
      }
      rec("ok", `Relayed ${input.source} → ${input.target}`, null, srcRes.connId, r.opId, r.connInstance);
      return attachCard(
        { content: [{ type: "text", text: `Relayed ${input.source} → ${input.target}` }] },
        { opId: r.opId, label, summary: `Relayed ${input.source} → ${input.target}` }
      );
    } catch (err) {
      const hid = rec("error", rd.errText.describeError(err));
      return attachCard(
        { content: [{ type: "text", text: `Copy failed: ${rd.errText.describeError(err)}` }] },
        { opId: hid, label, summary: rd.errText.describeError(err) }
      );
    }
  }

  rec("error", `unknown action: ${input.action}`, null, null);
  return { content: [{ type: "text", text: `Unknown action: ${input.action} (stat | copy)` }] };
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}

/** Register an in-flight operation for the panel, run the work, always end.
 *  When the kill function fires and the work then settles with an error,
 *  resolves with { __killed: true } so callers can report a clean kill.
 *  stream=true: 非阻塞后台执行，立即返回 { __stream: true, opId }；
 *  work 接收 { opId, append }（append 推增量进度）；终局由 hooks 接住：
 *  onSuccess(out) / onError(err) / onFinally()（client 释放）。 */
async function withOperation({ connId, kind, label, kill, agentName, stream = false }, work, hooks = {}) {
  const rd = requireRuntime();
  let killed = false;
  // 连接实例 id：在连接存活时取（操作结束自动释放后 instanceOf 会落空），
  // 随返回值带给 rec，保证历史批次按当时实例分组（conn_N 而非 profile id）。
  const connInstance = connId ? rd.sshClient.instanceOf(connId) : null;
  const opId = rd.operations.startOperation({
    connId,
    connInstance,
    agentName,
    kind,
    label,
    tool: "file",
    kill: () => {
      killed = true;
      try {
        kill?.();
      } catch {
        // kill handlers must not throw into the panel's RPC
      }
    },
  });
  if (stream) {
    // 非阻塞：后台执行（fire-and-forget），终局由 hooks 接住；
    // 卡片轮询不受工具返回影响（opId 先命中 in-flight，落盘后命中磁盘双写）。
    (async () => {
      try {
        const r = await work({ opId, append: (chunk) => rd.operations.appendOpOutput(opId, String(chunk ?? "")) });
        // 统一在返回对象上挂 opId：调用处据此注入卡片（work 可能无返回值）
        const out = r && typeof r === "object" ? r : {};
        out.opId = opId;
        out.connInstance = connInstance;
        if (killed) out.__killed = true;
        await hooks.onSuccess?.(out);
      } catch (err) {
        if (killed) {
          await hooks.onSuccess?.({ __killed: true, opId, connInstance });
        } else {
          await hooks.onError?.(err);
        }
      } finally {
        try {
          await hooks.onFinally?.();
        } finally {
          rd.operations.endOperation(opId);
        }
      }
    })();
    return { opId, connInstance, __stream: true };
  }
  try {
    const r = await work({ opId, append: (chunk) => rd.operations.appendOpOutput(opId, String(chunk ?? "")) });
    // 统一在返回对象上挂 opId：调用处据此注入卡片（work 可能无返回值）
    const out = r && typeof r === "object" ? r : {};
    out.opId = opId;
    out.connInstance = connInstance;
    if (killed) out.__killed = true;
    return out;
  } catch (err) {
    if (killed) return { __killed: true, opId, connInstance };
    throw err;
  } finally {
    rd.operations.endOperation(opId);
  }
}

/** mkdir -p the parent directory of a remote path. */
async function mkdirpRemote(client, remotePath) {
  const idx = remotePath.lastIndexOf("/");
  if (idx > 0) {
    await client.mkdir(remotePath.slice(0, idx), true);
  }
}

/** mkdir -p 命令前缀（若路径有父目录）；并入 exec 避免借出 sftp client。 */
function mkdirCmd(remotePath) {
  const idx = remotePath.lastIndexOf("/");
  if (idx <= 0) return "";
  return `mkdir -p ${shellQuote(remotePath.slice(0, idx))} && `;
}

/** POSIX-safe single-quote shell quoting. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Pipe two streams to completion (works for sftp and fs streams alike).
 * Completion signal: ssh2's sftp write stream does not reliably emit
 * `finish` (it closes without it), so success is resolved when the read
 * side has fully ended and the write side has closed with no error.
 * @param {import("node:stream").Readable} rs
 * @param {import("node:stream").Writable} ws
 * @returns {Promise<void>}
 */
function pipeStreams(rs, ws) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let rsEnded = false;
    let wsClosed = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        rs.destroy();
      } catch {
        // ignore
      }
      try {
        ws.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    rs.on("error", fail);
    ws.on("error", fail);
    rs.on("end", () => {
      rsEnded = true;
      if (wsClosed) succeed();
    });
    ws.on("finish", succeed);
    ws.on("close", () => {
      wsClosed = true;
      if (rsEnded) succeed();
    });
    rs.pipe(ws);
  });
}
