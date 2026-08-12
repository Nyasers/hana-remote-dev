import { runtimeHolder } from "../lib/runtime.js";

export const name = "cfg_disconnect";
export const description = "Close an active SSH connection (cascades: terminates interactive sessions on it). Omit connectionId to see active connections.";

export const parameters = {
  type: "object",
  properties: {
    connectionId: {
      type: "string",
      description: "Connection alias, profile id, or active connection id to close.",
    },
    all: {
      type: "boolean",
      description: "Close all active connections.",
      default: false,
    },
  },
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const active = rd.sshClient.listConnections();

  if (input.all) {
    for (const c of active) rd.sshClient.disconnect(c.id);
    return { content: [{ type: "text", text: `Closed ${active.length} connection(s).` }] };
  }

  if (!input.connectionId) {
    if (active.length === 0) return { content: [{ type: "text", text: "No active connections." }] };
    return {
      content: [{ type: "text", text: `Active connections (specify connectionId):\n${active.map((c) => `  ${c.alias || c.id}`).join("\n")}` }],
    };
  }

  const conn = active.find((c) => c.id === input.connectionId || c.handle === input.connectionId || c.alias === input.connectionId);
  if (!conn) {
    return { content: [{ type: "text", text: `No active connection: ${input.connectionId}` }] };
  }

  rd.sshClient.disconnect(conn.id);
  return { content: [{ type: "text", text: `Closed connection: ${conn.alias || conn.id}` }] };
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
