import { runtimeHolder } from "../lib/runtime.js";

export const name = "write_stdin";
export const description = "Write input to an interactive session (started via hrd_exec_command tty: true) and return output produced since the last read (expect-style alternation).";

export const parameters = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      description: "Session id returned by hrd_exec_command with tty: true.",
    },
    chars: {
      type: "string",
      description: "Input to write to the session stdin (include \\n for a line).",
    },
  },
  required: ["sessionId", "chars"],
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  try {
    const out = await rd.sshClient.writeSession(input.sessionId, input.chars);
    return {
      content: [{ type: "text", text: out ? out : "(no new output)" }],
      details: { sessionId: input.sessionId },
    };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to write to session: ${rd.errText.describeError(err)}` }] };
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
