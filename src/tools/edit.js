import { runtimeHolder } from "../lib/runtime.js";
export const name = "edit";
export const description = "Precisely edit a remote file: replace oldText with newText (multiple edits supported). Each oldText must appear exactly once, otherwise the edit fails without writing. Writes are atomic.";

export const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Remote path with connection prefix, e.g. my-server:/etc/nginx/nginx.conf",
    },
    edits: {
      type: "array",
      description: "List of edits: [{ oldText, newText }]. Every oldText must occur exactly once in the file.",
      items: {
        type: "object",
        properties: {
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["oldText", "newText"],
      },
    },
  },
  required: ["path", "edits"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const ref = rd.pathRef.parsePathRef(input.path);
  if (ref.kind !== "remote") {
    return {
      content: [{ type: "text", text: `hrd_edit operates on remote files; path must include a connection prefix (e.g. my-server:/etc/nginx/nginx.conf). Got: ${input.path}` }],
    };
  }

  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return { content: [{ type: "text", text: "edits must be a non-empty array of { oldText, newText }." }] };
  }
  for (const e of input.edits) {
    if (typeof e?.oldText !== "string" || typeof e?.newText !== "string") {
      return { content: [{ type: "text", text: "Each edit must be { oldText: string, newText: string }." }] };
    }
  }

  try {
    const { connId, path } = await rd.pathRef.resolveRemote(ref, { store: rd.connectionStore });
    const client = await rd.sshClient.sftp(connId);
    let content;
    try {
      const buf = await client.readRange(path, 0);
      if (buf.includes(0)) {
        return { content: [{ type: "text", text: `Refusing to edit binary file: ${input.path}` }] };
      }
      content = buf.toString("utf-8");
    } finally {
      client.end();
    }

    let result = content;
    for (const e of input.edits) {
      const occurrences = result.split(e.oldText).length - 1;
      if (occurrences === 0) {
        return { content: [{ type: "text", text: `Edit failed (nothing written): oldText not found: ${JSON.stringify(e.oldText)}` }] };
      }
      if (occurrences > 1) {
        return { content: [{ type: "text", text: `Edit failed (nothing written): oldText occurs ${occurrences} times (must be unique): ${JSON.stringify(e.oldText)}` }] };
      }
      result = result.replace(e.oldText, e.newText);
    }

    await rd.sshClient.writeAtomic(connId, path, result);
    return { content: [{ type: "text", text: `Applied ${input.edits.length} edit(s) to ${input.path}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to edit file: ${rd.errText.describeError(err)}` }] };
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
