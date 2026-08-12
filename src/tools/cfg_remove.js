import { runtimeHolder } from "../lib/runtime.js";

export const name = "cfg_remove";
export const description = "Delete a saved SSH connection profile and its stored credentials. The Agent must show the target profile and get explicit user confirmation before calling this tool.";

export const parameters = {
  type: "object",
  properties: {
    connectionId: {
      type: "string",
      description: "Profile alias (e.g. \"my-server\") or internal id to delete.",
    },
    force: {
      type: "boolean",
      description: "Also remove the profile when it has active connections (connections are not terminated by removal).",
      default: false,
    },
  },
  required: ["connectionId"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const target = rd.connectionStore.get(input.connectionId);
  if (!target) {
    return { content: [{ type: "text", text: `Profile "${input.connectionId}" not found.` }] };
  }

  const active = rd.sshClient.listConnections().filter((c) =>
    c.profileId && c.profileId === target.id
  );
  if (active.length > 0 && !input.force) {
    return {
      content: [{
        type: "text",
        text: `Profile "${target.name}" has ${active.length} active connection(s) (${active.map((c) => c.id).join(", ")}). Removal does not terminate them. Disconnect first, or pass force: true to remove anyway.`,
      }],
    };
  }

  const ok = rd.connectionStore.remove(target.name);
  if (!ok) {
    return { content: [{ type: "text", text: `Failed to remove profile "${target.name}".` }] };
  }

  rd.sessionLog.appendEventLog(rd.logsDir, "config", `${rd.sessionLog.eventTs()} connection:remove | ${target.name} | ${target.username}@${target.host}:${target.port ?? 22}`);

  return {
    content: [{ type: "text", text: `Profile removed: ${target.name} (credentials entry cleaned up).` }],
    details: { removed: target.name },
  };
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
