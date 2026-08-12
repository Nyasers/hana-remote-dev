import { runtimeHolder } from "../lib/runtime.js";
export const name = "ls";
export const description = "List a remote directory (names, or detailed size/time with long mode).";

export const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Remote directory with connection prefix, e.g. my-server:/etc/nginx",
    },
    long: {
      type: "boolean",
      description: "Show detailed file info (size, modify time).",
      default: true,
    },
  },
  required: ["path"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const ref = rd.pathRef.parsePathRef(input.path);
  if (ref.kind !== "remote") {
    return {
      content: [{ type: "text", text: `hrd_ls operates on remote paths; path must include a connection prefix (e.g. my-server:/etc/nginx). Got: ${input.path}` }],
    };
  }

  try {
    const { connId, path } = await rd.pathRef.resolveRemote(ref, { store: rd.connectionStore });
    const client = await rd.sshClient.sftp(connId);
    try {
      const stats = await client.stat(path);
      if (!stats.isDirectory) {
        return { content: [{ type: "text", text: `Not a directory: ${input.path}` }] };
      }
      const entries = await client.readdir(path);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: `(empty directory: ${input.path})` }] };
      }

      if (input.long !== false) {
        const lines = entries.map((e) => {
          const type = e.isDirectory ? "d" : "-";
          const size = e.isDirectory ? "-".padStart(8) : String(e.size).padStart(8);
          const time = e.modifyTime ? e.modifyTime.slice(0, 10) : "";
          return `${type}  ${size}  ${time}  ${e.filename}`;
        });
        return { content: [{ type: "text", text: `${input.path}:\n${lines.join("\n")}` }] };
      }

      const names = entries.map((e) => e.filename + (e.isDirectory ? "/" : ""));
      return { content: [{ type: "text", text: `${input.path}:\n${names.join("\n")}` }] };
    } finally {
      client.end();
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to list directory: ${rd.errText.describeError(err)}` }] };
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
