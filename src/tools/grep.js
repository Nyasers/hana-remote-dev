import { runtimeHolder } from "../lib/runtime.js";
export const name = "grep";
export const description = "Search remote file contents (sftp walk + JS matching, OS-agnostic). Returns matches as file:line:content, with optional context lines, case-insensitive and literal modes.";

export const parameters = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Search pattern (regex unless literal is true).",
    },
    path: {
      type: "string",
      description: "Remote directory with connection prefix, e.g. my-server:/etc/nginx",
    },
    context: {
      type: "integer",
      description: "Lines of context before/after each match (default 0).",
    },
    ignoreCase: {
      type: "boolean",
      description: "Case-insensitive matching.",
      default: false,
    },
    literal: {
      type: "boolean",
      description: "Treat pattern as a literal string, not a regex.",
      default: false,
    },
    limit: {
      type: "integer",
      description: "Max matches to return (default 100).",
    },
    maxFileBytes: {
      type: "integer",
      description: "Files larger than this (bytes) are skipped with a notice (default 10MB).",
    },
  },
  required: ["pattern", "path"],
};

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const ref = rd.pathRef.parsePathRef(input.path);
  if (ref.kind !== "remote") {
    return {
      content: [{ type: "text", text: `hrd_grep operates on remote paths; path must include a connection prefix (e.g. my-server:/etc/nginx). Got: ${input.path}` }],
    };
  }
  if (!input.pattern) {
    return { content: [{ type: "text", text: "pattern is required." }] };
  }

  let re = null;
  let literal = input.literal ? String(input.pattern) : null;
  if (!literal) {
    try {
      re = new RegExp(String(input.pattern), input.ignoreCase ? "i" : "");
    } catch (err) {
      return { content: [{ type: "text", text: `Invalid regex pattern: ${rd.errText.describeError(err)} (use literal: true for plain text)` }] };
    }
  } else if (input.ignoreCase) {
    literal = literal.toLowerCase();
  }

  try {
    const { connId, path } = await rd.pathRef.resolveRemote(ref, { store: rd.connectionStore });
    const client = await rd.sshClient.sftp(connId);
    const limit = input.limit || DEFAULT_LIMIT;
    const maxFileBytes = input.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
    const context = Math.max(0, input.context || 0);
    const hits = [];
    const skippedFiles = [];
    let walkSkipped = false;

    try {
      const stats = await client.stat(path);
      if (stats.isDirectory) {
        await rd.tree.walkDir(
          client,
          path,
          {
            maxEntries: 2000,
            onFile: (fullPath, isDir) => (isDir ? Promise.resolve(true) : matchFile(fullPath)),
            onError: (err, dir) => {
              skippedFiles.push(`${dir} (${rd.errText.describeError(err)})`);
            },
          }
        );
        walkSkipped = hits.length >= limit;
      } else {
        // Single file path: match it directly (system grep semantics).
        await matchFile(path);
      }
      walkSkipped = hits.length >= limit;
    } finally {
      client.end();
    }

    async function matchFile(fullPath) {
      try {
        const st = await client.stat(fullPath);
        if (st.size > maxFileBytes) {
          skippedFiles.push(`${fullPath} (${st.size} bytes > ${maxFileBytes})`);
          return true;
        }
        const buf = await client.readRange(fullPath, 0);
        if (buf.includes(0)) return true; // binary — skip silently
        const text = buf.toString("utf-8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const matched = literal
            ? (input.ignoreCase ? lines[i].toLowerCase().includes(literal) : lines[i].includes(literal))
            : re.test(lines[i]);
          if (!matched) continue;
          const ctxStart = Math.max(0, i - context);
          const ctxEnd = Math.min(lines.length - 1, i + context);
          let block = "";
          if (context > 0) {
            for (let j = ctxStart; j <= ctxEnd; j++) {
              const mark = j === i ? ">" : " ";
              block += `${mark} ${fullPath}:${j + 1}:${lines[j]}\n`;
            }
            block = block.slice(0, -1);
          } else {
            block = `${fullPath}:${i + 1}:${lines[i]}`;
          }
          hits.push(block);
          return hits.length < limit; // stop early when limit reached
        }
      } catch {
        // unreadable file (permissions etc.) — skip
      }
      return true;
    }

    if (hits.length === 0) {
      const notice = skippedFiles.length ? ` (skipped ${skippedFiles.length} entries)` : "";
      return { content: [{ type: "text", text: `No matches for ${JSON.stringify(input.pattern)} in ${input.path}${notice}` }] };
    }

    const parts = [];
    if (walkSkipped) parts.push(`(hit limit: showing first ${hits.length} matches)`);
    if (skippedFiles.length) parts.push(`(skipped ${skippedFiles.length} entries: ${skippedFiles.slice(0, 5).join(", ")}${skippedFiles.length > 5 ? ", ..." : ""})`);
    parts.push(hits.join("\n"));
    return { content: [{ type: "text", text: parts.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to search: ${rd.errText.describeError(err)}` }] };
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
