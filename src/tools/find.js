import path from "node:path";
import { runtimeHolder } from "../lib/runtime.js";
export const name = "find";
export const description = "Find remote files by glob pattern (sftp walk, OS-agnostic). Supports * ? ** wildcards against the file name.";

export const parameters = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Glob pattern matched against file names, e.g. *.log or app-?.conf. Use ** for any depth.",
    },
    path: {
      type: "string",
      description: "Remote directory with connection prefix, e.g. my-server:/var/log",
    },
    limit: {
      type: "integer",
      description: "Max results (default 100).",
    },
  },
  required: ["pattern", "path"],
};

const DEFAULT_LIMIT = 100;

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const ref = rd.pathRef.parsePathRef(input.path);
  if (ref.kind !== "remote") {
    return {
      content: [{ type: "text", text: `hrd_find operates on remote paths; path must include a connection prefix (e.g. my-server:/var/log). Got: ${input.path}` }],
    };
  }
  if (!input.pattern) {
    return { content: [{ type: "text", text: "pattern is required." }] };
  }

  let re;
  try {
    re = rd.tree.globToRegExp(String(input.pattern));
  } catch (err) {
    return { content: [{ type: "text", text: `Invalid glob pattern: ${rd.errText.describeError(err)}` }] };
  }

  try {
    const { connId, path } = await rd.pathRef.resolveRemote(ref, { store: rd.connectionStore });
    const client = await rd.sshClient.sftp(connId);
    const limit = input.limit || DEFAULT_LIMIT;
    const results = [];
    let walkSkipped = false;

    try {
      const stats = await client.stat(path);
      if (!stats.isDirectory) {
        return { content: [{ type: "text", text: `Not a directory: ${input.path}` }] };
      }

      await rd.tree.walkDir(client, path, {
        maxEntries: 2000,
        onFile: async (fullPath, isDir) => {
          if (isDir) return true;
          const name = fullPath.slice(fullPath.lastIndexOf("/") + 1);
          if (re.test(name)) {
            const rel = fullPath.startsWith(path) ? fullPath.slice(path.length + 1) : fullPath;
            results.push(rel);
            // 增量输出：每命中一个文件推给面板进行中操作（实时扫描进度）
            ctx?._hrdAppend?.(rel + "\n");
            if (results.length >= limit) return false;
          }
          return true;
        },
        onError: () => {},
      });
      walkSkipped = results.length >= limit;
    } finally {
      client.end();
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No files matching ${JSON.stringify(input.pattern)} in ${input.path}` }] };
    }

    const parts = [];
    if (walkSkipped) parts.push(`(hit limit: showing first ${results.length} results)`);
    parts.push(results.join("\n"));
    return { content: [{ type: "text", text: parts.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to find: ${rd.errText.describeError(err)}` }] };
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}

