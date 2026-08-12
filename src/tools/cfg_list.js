import { runtimeHolder } from "../lib/runtime.js";

export const name = "cfg_list";
export const description = "List saved SSH connection profiles and their current status.";

export const parameters = {
  type: "object",
  properties: {
    showSecrets: {
      type: "boolean",
      description: "Include whether secrets are stored (not the actual secrets).",
      default: false,
    },
  },
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);
  const profiles = rd.connectionStore.list();
  const activeConns = rd.sshClient.listConnections();

  if (profiles.length === 0) {
    return { content: [{ type: "text", text: "No saved connection profiles yet. Use hrd_cfg_connect to create one." }] };
  }

  const lines = profiles.map((p) => {
    const active = activeConns.find((a) => a.host === p.host && a.username === p.username && (a.port || 22) === (p.port || 22));
    const status = active ? `● connected (${active.id})` : "○ disconnected";
    const extras = [];
    if (input.showSecrets) {
      extras.push(p.hasSecret ? "[secret stored]" : "[no stored secret]");
    }
    const auth = p.authMethod || (p.hasSecret ? "encrypted" : "none");
    return `  ${p.name} (${p.id})\n    ${p.username}@${p.host}:${p.port}  auth: ${auth}  ${status}${extras.length ? "  " + extras.join(" ") : ""}`;
  });

  return {
    content: [{ type: "text", text: `Saved profiles:\n${lines.join("\n")}` }],
    details: { profiles, activeConnections: activeConns },
  };
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
