
import fs from "node:fs";
import { runtimeHolder } from "../lib/runtime.js";

export const name = "cfg_connect";
export const description = "Establish an SSH connection (pre-connect: optional, hrd_* tools auto-connect when needed). Connect to a saved profile by alias, or create one from host/username + credentials.";

export const parameters = {
  type: "object",
  properties: {
    host: {
      type: "string",
      description: "Remote hostname or IP address.",
    },
    port: {
      type: "integer",
      description: "SSH port (default from config, usually 22).",
    },
    username: {
      type: "string",
      description: "SSH username.",
    },
    authMethod: {
      type: "string",
      enum: ["key", "password"],
      description: "Authentication method.",
    },
    password: {
      type: "string",
      description: "Password (only used with authMethod=password). Stored encrypted when saveConfig is enabled.",
    },
    privateKey: {
      type: "string",
      description: "Private key PEM content (used with authMethod=key). Pasted inline.",
    },
    passphrase: {
      type: "string",
      description: "Passphrase for an encrypted private key (PEM or PPK). Stored encrypted when saveConfig is enabled.",
    },
    keyPath: {
      type: "string",
      description: "Path to a local private key file on disk (used with authMethod=key). More reliable than pasting inline.",
    },
    proxyCommand: {
      type: "string",
      description: "OpenSSH ProxyCommand, e.g. \"ssh -W %h:%p bastion\". Spawns a child process whose stdio carries the SSH stream.",
    },
    expectFingerprint: {
      type: "string",
      description: "Expected host key fingerprint (OpenSSH style \"SHA256:<base64>\" or 64-char hex). When set, the server host key is strictly verified and mismatches are rejected; when unset, the host key is not verified.",
    },
    saveConfig: {
      type: "boolean",
      description: "Save this connection as a profile for future reuse.",
      default: true,
    },
    configName: {
      type: "string",
      description: "Friendly name for the saved profile (defaults to user@host). Must be 2+ chars, no colon/slash/whitespace/@.",
    },
    connectionId: {
      type: "string",
      description: "Connect a saved profile by its Host alias (e.g. \"my-server\") or internal id.",
    },
    timeout: {
      type: "integer",
      description: "Connection timeout in seconds (default 10).",
    },
  },
};

export async function execute(input, ctx) {
  const rd = requireRuntime(ctx);

  let connectOpts = {};
  let savedProfile = null;
  if (input.connectionId) {
    const profile = rd.connectionStore.get(input.connectionId);
    if (!profile) {
      return { content: [{ type: "text", text: `Connection profile "${input.connectionId}" not found.` }] };
    }
    savedProfile = profile;
    connectOpts = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      proxyCommand: profile.proxyCommand || null,
      profileId: profile.id,
      alias: profile.name,
    };
    const password = rd.connectionStore.getSecret(profile.name, "password");
    if (password) connectOpts.password = password;
    const privateKey = rd.connectionStore.getSecret(profile.name, "privateKey");
    if (privateKey) {
      connectOpts.privateKey = privateKey;
    } else if (profile.keyPath) {
      try {
        connectOpts.privateKey = fs.readFileSync(profile.keyPath, "utf-8");
      } catch {
        /* give up */
      }
    }
    const passphrase = rd.connectionStore.getSecret(profile.name, "passphrase");
    if (passphrase) connectOpts.passphrase = passphrase;
  } else {
    connectOpts = {
      host: input.host,
      port: input.port || 22,
      username: input.username,
    };
  }

  if (input.password) connectOpts.password = input.password;
  if (input.privateKey) connectOpts.privateKey = input.privateKey;
  if (input.keyPath) {
    try {
      connectOpts.privateKey = fs.readFileSync(input.keyPath, "utf-8");
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to read key file: ${rd.errText.describeError(err)}` }] };
    }
  }
  if (input.timeout) connectOpts.timeout = input.timeout;
  if (input.passphrase) connectOpts.passphrase = input.passphrase;
  if (input.proxyCommand) connectOpts.proxyCommand = input.proxyCommand;
  if (input.expectFingerprint) connectOpts.expectFingerprint = input.expectFingerprint;

  if (!connectOpts.host || !connectOpts.username) {
    return { content: [{ type: "text", text: "Host and username are required. Provide them directly or use a saved connectionId." }] };
  }
  if (!connectOpts.password && !connectOpts.privateKey) {
    return {
      content: [{ type: "text", text: "No authentication method available. Provide a password or privateKey, or use a saved profile with stored credentials." }],
    };
  }

  try {
    const connId = await rd.sshClient.connect(connectOpts);

    const isReconnect = !!input.connectionId;
    const shouldSave = input.saveConfig !== undefined ? input.saveConfig : !isReconnect;

    if (shouldSave) {
      const name = input.configName || `${connectOpts.username}@${connectOpts.host}`;
      if (!rd.pathRef.isValidAlias(name)) {
        return {
          content: [{ type: "text", text: `Invalid alias "${name}": 2+ chars, no colon / slash / whitespace / @ (chars: letters, digits, . _ -).` }],
        };
      }
      const profile = {
        name,
        host: connectOpts.host,
        port: connectOpts.port,
        username: connectOpts.username,
        proxyCommand: input.proxyCommand || null,
      };
      const saved = rd.connectionStore.save(profile);

      if (input.password) {
        rd.connectionStore.setSecret(saved.name, "password", input.password);
      }
      const keyContent = input.privateKey || (input.keyPath ? safeReadKey(input.keyPath) : null);
      if (keyContent) {
        rd.connectionStore.setSecret(saved.name, "privateKey", keyContent);
      }
      if (input.passphrase) {
        rd.connectionStore.setSecret(saved.name, "passphrase", input.passphrase);
      }

      const handle = rd.sshClient.anchorConnection(connId, saved.id, saved.name);

      rd.sessionLog.appendEventLog(rd.logsDir, "config", `${rd.sessionLog.eventTs()} connection:add | ${saved.name} | ${connectOpts.username}@${connectOpts.host}:${connectOpts.port}`);

      return {
        content: [{ type: "text", text: `已连接 ${saved.name}（${connectOpts.username}@${connectOpts.host}:${connectOpts.port}）` }],
        details: { connectionId: handle, handle, profileId: saved.id },
      };
    }

    if (isReconnect) {
      const profile = rd.connectionStore.get(input.connectionId);
      return {
        content: [{ type: "text", text: `已重新连接 ${profile.name}` }],
        details: { connectionId: connId, handle: connId, profileId: profile.id },
      };
    }

    return {
      content: [{ type: "text", text: `Connected to ${connectOpts.username}@${connectOpts.host}:${connectOpts.port}.\nConnection id: ${connId}` }],
      details: { connectionId: connId, handle: connId },
    };
  } catch (err) {
    return { content: [{ type: "text", text: `Connection failed: ${rd.errText.describeError(err)}` }] };
  }
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development 插件尚未初始化，请确认插件已启用。");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}

function safeReadKey(keyPath) {
  try {
    return fs.readFileSync(keyPath, "utf-8");
  } catch {
    return null;
  }
}
