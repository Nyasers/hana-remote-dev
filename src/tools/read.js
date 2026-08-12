import { runtimeHolder } from "../lib/runtime.js";

export const name = "read";
export const description = "Read a remote file. Path must include a connection prefix (alias:/path). Supports offset/limit paging; large files are truncated at 50KB unless limit is given; binary files are detected and not dumped.";

export const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Remote path with connection prefix, e.g. my-server:/etc/nginx/nginx.conf",
    },
    offset: {
      type: "integer",
      description: "Byte offset to start reading from (default 0).",
    },
    limit: {
      type: "integer",
      description: "Max bytes to read. Without it, files over 50KB are truncated with a notice.",
    },
  },
  required: ["path"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);

  const ref = rd.pathRef.parsePathRef(input.path);
  if (ref.kind !== "remote") {
    return {
      content: [{ type: "text", text: `hrd_read operates on remote files; path must include a connection prefix (e.g. my-server:/etc/nginx/nginx.conf). Got: ${input.path}` }],
    };
  }

  try {
    const { connId, path } = await rd.pathRef.resolveRemote(ref, { store: rd.connectionStore });
    const client = await rd.sshClient.sftp(connId);
    try {
      const stats = await client.stat(path);
      if (stats.isDirectory) {
        return { content: [{ type: "text", text: `Is a directory: ${input.path}` }] };
      }

      const LIMIT = 50 * 1024;
      const offset = input.offset || 0;
      let limit = input.limit;
      let truncated = false;
      if (limit === undefined && stats.size - offset > LIMIT) {
        limit = LIMIT;
        truncated = true;
      }

      const buf = await client.readRange(path, offset, limit);
      if (buf.includes(0)) {
        return { content: [{ type: "text", text: `(binary file, ${stats.size} bytes — content not shown)` }] };
      }

      const parts = [];
      if (truncated) {
        parts.push(`(truncated: showing ${buf.length} of ${stats.size - offset} bytes; pass limit to read more)`);
      }
      parts.push(buf.toString("utf-8"));
      return { content: [{ type: "text", text: parts.join("\n") }] };
    } finally {
      client.end();
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to read file: ${rd.errText.describeError(err)}` }] };
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
