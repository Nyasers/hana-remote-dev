import { runtimeHolder } from "../lib/runtime.js";
export const name = "cfg_edit";
export const description = "Edit a saved connection profile: alias, connection fields, or credentials. At least one field required. Credential rules: writing a password clears the private key; writing a private key clears the password.";

export const parameters = {
  type: "object",
  properties: {
    connectionId: {
      type: "string",
      description: "Profile alias or internal id to edit.",
    },
    alias: {
      type: "string",
      description: "New Host alias (2+ chars, no colon / slash / whitespace / @). Internal id and encrypted credentials stay in place.",
    },
    host: {
      type: "string",
      description: "New remote hostname or IP address.",
    },
    username: {
      type: "string",
      description: "New SSH username.",
    },
    port: {
      type: "integer",
      description: "New SSH port.",
    },
    proxyCommand: {
      type: "string",
      description: "New ProxyCommand. Pass empty string to clear.",
    },
    password: {
      type: "string",
      description: "New password (stored encrypted; single-event credential, never echoed back).",
    },
    privateKey: {
      type: "string",
      description: "New private key PEM content (stored encrypted; single-event credential).",
    },
    passphrase: {
      type: "string",
      description: "New passphrase for an encrypted private key (stored encrypted; single-event credential).",
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

  const hasConnectionChange = [input.host, input.username, input.port, input.proxyCommand].some((v) => v !== undefined);
  const hasSecretChange = [input.password, input.privateKey, input.passphrase].some((v) => v);
  const hasAliasChange = input.alias !== undefined;

  if (!hasAliasChange && !hasConnectionChange && !hasSecretChange) {
    return {
      content: [{ type: "text", text: "Nothing to edit: pass at least one of alias / host / username / port / proxyCommand / password / privateKey / passphrase." }],
    };
  }

  // Alias first (rename keeps id + encrypted entry in place), then fields.
  if (hasAliasChange) {
    if (!rd.pathRef.isValidAlias(input.alias)) {
      return {
        content: [{ type: "text", text: `Invalid alias "${input.alias}": 2+ chars, no colon / slash / whitespace / @ (chars: letters, digits, . _ -).` }],
      };
    }
    const renamed = rd.connectionStore.rename(target.name, input.alias);
    if (!renamed) {
      return { content: [{ type: "text", text: `Rename failed: "${input.alias}" may already be taken.` }] };
    }
    // Keep the pool's alias snapshot in sync so the new alias resolves
    // immediately (disconnect / status / sessions).
    rd.sshClient.renameConnectionAlias(target.id, input.alias);
  }

  const currentName = input.alias || target.name;

  if (hasConnectionChange) {
    const changes = {};
    if (input.host !== undefined) changes.host = input.host;
    if (input.username !== undefined) changes.username = input.username;
    if (input.port !== undefined) changes.port = input.port;
    if (input.proxyCommand !== undefined) changes.proxyCommand = input.proxyCommand;
    const updated = rd.connectionStore.update(currentName, changes);
    if (!updated) {
      return { content: [{ type: "text", text: "Failed to update connection fields." }] };
    }
  }

  if (input.password) rd.connectionStore.setSecret(currentName, "password", input.password);
  if (input.privateKey) rd.connectionStore.setSecret(currentName, "privateKey", input.privateKey);
  if (input.passphrase) rd.connectionStore.setSecret(currentName, "passphrase", input.passphrase);

  const final = rd.connectionStore.get(currentName);

  const diffs = rd.sessionLog.describeProfileDiff(target, {
    host: input.host,
    username: input.username,
    port: input.port,
    proxyCommand: input.proxyCommand,
    credentials: hasSecretChange,
  });
  rd.sessionLog.appendEventLog(rd.logsDir, "config", `${rd.sessionLog.eventTs()} connection:update | ${final.name}${input.alias && input.alias !== target.name ? ` (renamed from ${target.name})` : ""}${diffs.length ? ` | ${diffs.join("; ")}` : ""}`);
  return {
    content: [{ type: "text", text: `Profile updated: ${final.name} (${final.username}@${final.host}:${final.port})` }],
    details: { id: final.id, alias: final.name },
  };
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}
