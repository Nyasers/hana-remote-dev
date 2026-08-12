/**
 * Channel handlers — the single implementation of every connection-panel
 * operation. Both the host REST routes and the local Socket.IO channel call
 * into this layer, so the two transports can never drift apart.
 *
 * Every handler returns a uniform envelope:
 *   { ok: true, data }  |  { ok: false, error, status? }
 */

import fs from "node:fs";
import path from "node:path";
import { listConnections, isConnected, connect, disconnect, listSessions, killSession, getSessionLogLimits, setSessionLogMaxBytes, setSessionLogMaxTotalBytes, setIdleTimeout } from "./ssh-client.js";
import { listOperations, killOperation, listHistory } from "./operations.js";
import { loadSessionLogConfig, cleanupSessionLogs, appendEventLog, eventTs, describeProfileDiff } from "./session-log.js";
import { loadPluginConfig, savePluginConfig } from "./plugin-config.js";

// ---- 会话日志三限（面板配置） ----

/** 当前配置（两限 + idleTimeout）+ 实际占用（logs/session/ 目录 .md 文件数与字节）。 */
export function handleSessionLogGet(runtime) {
  const limits = getSessionLogLimits();
  const pcfg = loadPluginConfig(runtime.dataDir);
  const dir = path.join(runtime.logsDir, "session");
  let files = 0;
  let bytes = 0;
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        // 日期子目录（session/<yyyy-mm-dd>/<id>.md）
        for (const f of fs.readdirSync(p)) {
          if (f.endsWith(".md")) {
            files += 1;
            bytes += fs.statSync(path.join(p, f)).size;
          }
        }
      } else if (d.isFile() && d.name.endsWith(".md")) {
        // 存量平铺兼容
        files += 1;
        bytes += fs.statSync(p).size;
      }
    }
  } catch {
    /* 目录不存在/不可读：按空处理 */
  }
  return { ok: true, data: { limits, idleTimeout: pcfg.idleTimeout, actual: { files, bytes } } };
}

/** 保存插件配置（持久化 dataDir/config.json）+ 立即应用 + 立即清理一次。 */
export function handleSessionLogSet(runtime, payload) {
  try {
    const clean = savePluginConfig(runtime.dataDir, {
      sessionLog: { maxMB: payload?.maxMB, maxTotalMB: payload?.maxTotalMB },
      idleTimeout: payload?.idleTimeout,
    });
    const sl = clean.sessionLog;
    setSessionLogMaxBytes(sl.maxMB > 0 ? sl.maxMB * 1024 * 1024 : 0);
    setSessionLogMaxTotalBytes(sl.maxTotalMB > 0 ? sl.maxTotalMB * 1024 * 1024 : 0);
    setIdleTimeout(clean.idleTimeout);
    cleanupSessionLogs(path.join(runtime.logsDir, "session"), {
      maxBytes: sl.maxTotalMB > 0 ? sl.maxTotalMB * 1024 * 1024 : 0,
    });
    appendEventLog(runtime.logsDir, "config", `${eventTs()} config:set | maxMB=${sl.maxMB} maxTotalMB=${sl.maxTotalMB} idleTimeout=${clean.idleTimeout} | panel`);
    return { ok: true, data: { limits: getSessionLogLimits(), idleTimeout: clean.idleTimeout } };
  } catch (err) {
    // 失败路径也留审计痕迹（配置未生效但至少可追溯）
    try {
      appendEventLog(runtime.logsDir, "config", `${eventTs()} config:set fail | ${String(err?.message ?? err).slice(0, 120)} | panel`);
    } catch {
      /* 审计本身失败则静默 */
    }
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ---- Appearance（宿主聊天宽度跟随） ----

/**
 * 读宿主聊天宽度：agent 配置 agents/<primaryAgent>/config.yaml → chat.contentWidth
 * （宿主「外观 → 聊天宽度」落盘于此；preferences.json 的 editor.markdown 是排版设置，非此值）。
 * 返回 640 / 720 / 800 / "unlimited"，失败回退 720。
 */
export function handleAppearance(runtime) {
  const fallback = { ok: true, data: { contentWidth: 720 } };
  try {
    const dataRoot = runtime?.dataDir ? path.resolve(runtime.dataDir, "..", "..") : null;
    if (dataRoot) {
      // 优先 primaryAgent 的 config.yaml，其次 agents/ 下任意含 chat.contentWidth 的配置
      const agentIds = [];
      const prefsPath = path.join(dataRoot, "user", "preferences.json");
      if (fs.existsSync(prefsPath)) {
        try {
          const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
          if (prefs?.primaryAgent) agentIds.push(prefs.primaryAgent);
        } catch { /* ignore */ }
      }
      const agentsDir = path.join(dataRoot, "agents");
      if (fs.existsSync(agentsDir)) {
        for (const entry of fs.readdirSync(agentsDir)) {
          if (fs.statSync(path.join(agentsDir, entry)).isDirectory() && !agentIds.includes(entry)) agentIds.push(entry);
        }
      }
      for (const id of agentIds) {
        const yamlPath = path.join(agentsDir, id, "config.yaml");
        if (!fs.existsSync(yamlPath)) continue;
        const cw = parseChatContentWidth(fs.readFileSync(yamlPath, "utf8"));
        if (cw !== null) {
          const num = Number(cw);
          const norm = Number.isFinite(num) && [640, 720, 800].includes(num) ? num : cw === "unlimited" ? "unlimited" : null;
          if (norm !== null) {
            runtime?.log?.info?.(`appearance: ${yamlPath} -> ${norm}`);
            return { ok: true, data: { contentWidth: norm } };
          }
        }
      }
    }
    runtime?.log?.info?.(`appearance: no chat.contentWidth found, fallback 720`);
    return fallback;
  } catch (err) {
    runtime?.log?.error?.(`appearance read failed: ${err.message}`);
    return fallback;
  }
}

/** 轻量解析 config.yaml 的 chat: 块 → contentWidth 值（零依赖，不引 YAML 库）。 */
function parseChatContentWidth(yamlText) {
  let inChat = false;
  for (const line of yamlText.split(/\r?\n/)) {
    if (/^chat:\s*$/.test(line)) { inChat = true; continue; }
    if (!inChat) continue;
    if (/^\S/.test(line)) break; // 下一顶层键，chat 块结束
    const m = line.match(/^\s+contentWidth:\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

// ---- Read ----

export function handleList(runtime) {
  const active = listConnections().map((conn) => ({
    ...conn,
    connectedAt: conn.connectedAt.toISOString(),
    healthy: isConnected(conn.id),
  }));
  return { ok: true, data: { active, saved: runtime.connectionStore.list() } };
}

export function handleGet(runtime, ref) {
  const connId = ref;
  const active = listConnections().find((conn) => conn.id === connId);
  const saved = runtime.connectionStore.get(connId);
  return {
    ok: true,
    data: {
      active: active
        ? { ...active, connectedAt: active.connectedAt.toISOString(), healthy: isConnected(active.id) }
        : null,
      saved,
    },
  };
}

// ---- Profile CRUD ----

/** Create a profile (connection params + optional credentials). */
export async function handleSave(runtime, body) {
  const store = runtime.connectionStore;
  const name = String(body.name || "").trim();
  const host = String(body.host || "").trim();
  const username = String(body.username || "").trim();
  if (!name || !host || !username) {
    return { ok: false, error: "name, host and username are required.", status: 400 };
  }
  if (store.get(name)) {
    return { ok: false, error: `Profile "${name}" already exists.`, status: 409 };
  }

  const saved = store.save({
    name,
    host,
    username,
    port: body.port || 22,
    proxyCommand: body.proxyCommand || null,
  });

  // Credentials are single-event: they enter the encrypted store here and
  // are never echoed back in any response.
  applyCredentialFields(store, saved.name, body);

  appendEventLog(runtime.logsDir, "config", `${eventTs()} connection:add | ${saved.name} | ${saved.username}@${saved.host}:${saved.port}`);
  return { ok: true, data: { profile: saved } };
}

/** Update a profile: connection params, optional alias rename, optional credentials. */
export async function handleUpdate(runtime, ref, body) {
  const store = runtime.connectionStore;
  const target = store.get(ref);
  if (!target) {
    return { ok: false, error: `Profile "${ref}" not found.`, status: 404 };
  }

  // Alias change first: rename preserves the internal id and credentials.
  let workingRef = ref;
  if (body.name !== undefined) {
    const newName = String(body.name).trim();
    if (newName && newName !== target.name) {
      const renamed = store.rename(target.name, newName);
      if (!renamed) {
        return { ok: false, error: `Cannot rename to "${newName}": alias missing or already taken.`, status: 409 };
      }
      workingRef = renamed.name;
    }
  }

  const changes = {};
  if (body.host !== undefined) changes.host = body.host;
  if (body.username !== undefined) changes.username = body.username;
  if (body.port !== undefined) changes.port = body.port;
  if (body.proxyCommand !== undefined) changes.proxyCommand = body.proxyCommand;

  const updated = Object.keys(changes).length > 0
    ? store.update(workingRef, changes)
    : store.get(workingRef);
  if (!updated) {
    return { ok: false, error: "Update failed.", status: 500 };
  }

  applyCredentialFields(store, updated.name, body);

  const diffs = describeProfileDiff(target, {
    host: body.host,
    username: body.username,
    port: body.port,
    proxyCommand: body.proxyCommand,
    credentials: !!(body.password || body.privateKey || body.passphrase),
  });
  appendEventLog(runtime.logsDir, "config", `${eventTs()} connection:update | ${updated.name}${ref !== updated.name ? ` (renamed from ${ref})` : ""}${diffs.length ? ` | ${diffs.join("; ")}` : ""}`);
  return { ok: true, data: { profile: updated } };
}

/** Delete a profile; refuses while it has active connections. */
export function handleRemove(runtime, ref) {
  const store = runtime.connectionStore;
  const target = store.get(ref);
  if (!target) {
    return { ok: false, error: `Profile "${ref}" not found.`, status: 404 };
  }

  const active = activeForProfile(target);
  if (active.length > 0) {
    return {
      ok: false,
      error: `Profile "${target.name}" has ${active.length} active connection(s). Disconnect first.`,
      data: { activeIds: active.map((a) => a.id) },
      status: 409,
    };
  }

  if (!store.remove(target.name)) {
    return { ok: false, error: `Failed to remove profile "${target.name}".`, status: 500 };
  }
  appendEventLog(runtime.logsDir, "config", `${eventTs()} connection:remove | ${target.name} | ${target.username}@${target.host}:${target.port ?? 22}`);
  return { ok: true, data: { removed: target.name } };
}

// ---- Connection lifecycle ----

/** Connect using a saved profile; credentials come from the encrypted store. */
export async function handleConnect(runtime, ref) {
  const store = runtime.connectionStore;
  const profile = store.get(ref);
  if (!profile) {
    return { ok: false, error: `Profile "${ref}" not found.`, status: 404 };
  }

  const connectOpts = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    proxyCommand: profile.proxyCommand || null,
    // 稳定句柄：以 profileId 为池 key，别名展示。
    profileId: profile.id,
    alias: profile.name,
    // 连接生命周期统一自动管理：按需建立 + 用完即放（releaseIfIdle），
    // 面板只提供强制断开；显式 connect 也标记 auto，避免展示/回收语义分裂。
    source: "auto",
  };
  const password = store.getSecret(profile.name, "password");
  if (password) connectOpts.password = password;
  const privateKey = store.getSecret(profile.name, "privateKey");
  if (privateKey) {
    connectOpts.privateKey = privateKey;
  } else if (profile.keyPath) {
    // Fallback for hand-written IdentityFile entries: read the key file.
    try {
      connectOpts.privateKey = fs.readFileSync(profile.keyPath, "utf-8");
    } catch { /* give up */ }
  }
  const passphrase = store.getSecret(profile.name, "passphrase");
  if (passphrase) connectOpts.passphrase = passphrase;

  if (!connectOpts.password && !connectOpts.privateKey) {
    return { ok: false, error: `Profile "${profile.name}" has no stored credentials.`, status: 400 };
  }

  try {
    const handle = await connect(connectOpts);
    return { ok: true, data: { connectionId: handle, handle, alias: profile.name } };
  } catch (err) {
    return { ok: false, error: `Connection failed: ${err.message}`, status: 502 };
  }
}

/**
 * Disconnect active connections matching this profile (idempotent).
 * @param {object} runtime
 * @param {string} ref - profile alias or id
 * @param {string} [connId] - disconnect only this connection (pool key);
 *   omit to disconnect every connection of the profile.
 */
export function handleDisconnect(runtime, ref, connId) {
  const store = runtime.connectionStore;
  const profile = store.get(ref);
  if (!profile) {
    return { ok: false, error: `Profile "${ref}" not found.`, status: 404 };
  }

  const active = activeForProfile(profile);
  const targets = connId ? active.filter((a) => a.id === connId) : active;
  const sessionCount = targets.reduce((n, a) => n + listSessions(a.id).length, 0);
  for (const a of targets) disconnect(a.id);
  return { ok: true, data: { disconnected: targets.map((a) => a.id), sessionsTerminated: sessionCount } };
}

// ---- Sessions (monitoring / management) ----

/**
 * List interactive sessions on a profile's active connections.
 * @param {object} runtime
 * @param {string} ref - profile alias or id
 * @returns {{ok: true, data: {sessions: Array}}}
 */
export function handleSessions(runtime, ref) {
  const store = runtime.connectionStore;
  const profile = store.get(ref);
  if (!profile) {
    return { ok: false, error: `Profile "${ref}" not found.`, status: 404 };
  }

  const active = activeForProfile(profile);
  const sessions = [];
  for (const conn of active) {
    for (const s of listSessions(conn.id)) {
      sessions.push({
        ...s,
        startedAt: s.startedAt.toISOString(),
        // lastActivityAt 是时间戳 number（createSession 里 Date.now()），需转 Date
        lastActivityAt: new Date(s.lastActivityAt).toISOString(),
        connAlias: profile.name,
      });
    }
  }
  return { ok: true, data: { sessions } };
}

/** Terminate an interactive session by its globally unique id. */
export function handleKillSession(runtime, sessionId) {
  const killed = killSession(String(sessionId || ""));
  if (!killed) {
    return { ok: false, error: `Session "${sessionId}" not found or already closed.`, status: 404 };
  }
  return { ok: true, data: { sessionId } };
}

// ---- In-flight operations (monitoring / management) ----

/**
 * List in-flight one-shot operations (non-tty exec, file transfers).
 * @returns {{ok: true, data: {operations: Array}}}
 */
export function handleOperations() {
  return { ok: true, data: { operations: listOperations(), history: listHistory() } };
}

/** Kill an in-flight operation (stream destroy / channel close + cleanup). */
export function handleKillOperation(runtime, opId) {
  const dispatched = killOperation(String(opId || ""));
  if (!dispatched) {
    return { ok: false, error: `Operation "${opId}" not found or not killable.`, status: 404 };
  }
  return { ok: true, data: { opId } };
}

// ---- Helpers ----

/**
 * Match active connections against a profile by host + username + port
 * (same semantics as the hrd_cfg_remove tool).
 */
export function activeForProfile(profile) {
  return listConnections().filter((conn) =>
    conn.host === profile.host &&
    conn.username === profile.username &&
    (conn.port || 22) === (profile.port || 22)
  );
}

/**
 * Store credential fields from a request body (single-event: never echoed).
 * Empty/absent fields are ignored, so an edit form can leave them blank to
 * keep existing credentials. Mutual exclusion (password vs key) is enforced
 * inside ConnectionStore#setSecret.
 */
function applyCredentialFields(store, name, body) {
  if (body.password) store.setSecret(name, "password", body.password);
  if (body.privateKey) store.setSecret(name, "privateKey", body.privateKey);
  if (body.passphrase) store.setSecret(name, "passphrase", body.passphrase);
}
