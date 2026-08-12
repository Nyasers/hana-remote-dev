import { runtimeHolder } from "../lib/runtime.js";
export const name = "write";
export const description = "Write a remote file (UTF-8 text). Parent directories are created automatically; writes are atomic (temp file + rename), so a failed write never leaves a half-written file.";

export const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Remote path with connection prefix, e.g. my-server:/etc/nginx/nginx.conf",
    },
    content: {
      type: "string",
      description: "UTF-8 text content to write.",
    },
  },
  required: ["path", "content"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const ref = rd.pathRef.parsePathRef(input.path);
  if (ref.kind !== "remote") {
    return {
      content: [{ type: "text", text: `hrd_write operates on remote files; path must include a connection prefix (e.g. my-server:/etc/nginx/nginx.conf). Got: ${input.path}` }],
    };
  }

  try {
    const { connId, path } = await rd.pathRef.resolveRemote(ref, { store: rd.connectionStore });
    const content = String(input.content ?? "");
    await rd.sshClient.writeAtomic(connId, path, content);
    return { content: [{ type: "text", text: `Written ${content.length} bytes to ${input.path}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to write file: ${rd.errText.describeError(err)}` }] };
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
