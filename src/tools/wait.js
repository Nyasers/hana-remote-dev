// wait.js — 异步操作结果获取（通用）
// 配合流式/异步操作使用：轮询操作状态直到终局（ok/error/timeout/killed/
// interrupted），返回完整输出与结局字段。类似 download-progress 的
// download-wait：执行是异步的，Agent 需要结果时用本工具阻塞等待。
// 任何通过 startOperation 注册的异步操作（exec_command stream:true 当前，
// 未来流式化的 grep/find/read 等）都可以用同一 opId 等待，无需区分来源。

import { runtimeHolder } from "../lib/runtime.js";

export const name = "wait";
export const description =
  "Wait for a remote-dev async operation to finish and return its full result: output, exit code, status, duration. Any operation registered via startOperation can be awaited by opId — exec_command with stream: true today, other streaming tools (grep/find/read on large targets, etc.) as they gain stream support. Polls the operation until it settles or the timeout is reached.";

export const parameters = {
  type: "object",
  properties: {
    opId: {
      type: "string",
      description: "Operation id to await (op_xxx from exec_command result.details.streamOpId, or any async operation id).",
    },
    timeoutMs: {
      type: "integer",
      description: "Max wait in milliseconds (default 120000).",
    },
    pollMs: {
      type: "integer",
      description: "Poll interval in ms (default 500).",
    },
  },
  required: ["opId"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const opId = String(input?.opId || "").trim();
  if (!opId) {
    return { content: [{ type: "text", text: "opId is required (operation id to await)." }] };
  }
  const timeoutMs = Number(input?.timeoutMs) > 0 ? Number(input.timeoutMs) : 120000;
  const pollMs = Number(input?.pollMs) > 0 ? Number(input.pollMs) : 500;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const snap = rd.operations.readOperation(opId);
    if (snap) {
      last = snap;
      if (snap.status !== "running") {
        const out = snap.output || "";
        return {
          content: [{ type: "text", text: out || "(no output)" }],
          details: {
            streamOpId: opId,
            status: snap.status,
            reason: snap.reason || null,
            exitCode: snap.exitCode,
            durationMs: snap.durationMs,
            output: out,
          },
        };
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // 超时：返回最近快照（可能仍 running，或已完成但轮询窗口错过）
  return {
    content: [
      {
        type: "text",
        text: `等待超时（${timeoutMs}ms）` + (last ? `：操作${last.status === "running" ? "仍在运行" : `已结束（${last.status}）`}` : "：未找到操作记录"),
      },
    ],
    details: last
      ? { streamOpId: opId, status: last.status, durationMs: last.durationMs, output: last.output || "" }
      : { streamOpId: opId },
  };
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
