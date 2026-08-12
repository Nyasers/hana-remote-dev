import { resolveConnectionKey, connect } from "./ssh-client.js";

/**
 * Alias rules: 2+ chars, [A-Za-z0-9][A-Za-z0-9._-]*, must match the path-ref
 * prefix syntax so stored aliases always parse. Enforced at the tool layer
 * (hrd_cfg_connect / hrd_cfg_edit), not in the store.
 */
export function isValidAlias(name) {
  return typeof name === "string" && name.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/**
 * Path reference parsing — SCP-aligned addressing.
 *
 *   alias:/remote/path  |  HRD_xxx:/remote/path  → remote reference
 *   /any/path, ./rel, C:\x, D:/x                 → local
 *
 * Rules:
 *   - Prefix syntax: `^([A-Za-z0-9][A-Za-z0-9._-]*):(.*)$` with prefix length
 *     >= 2. The prefix is resolved against saved connection aliases / ids.
 *     Alias validation (no colon / slash / whitespace / @, >= 2 chars) is
 *     enforced at the hrd_cfg_edit tool layer so stored aliases always parse.
 *   - Single-letter prefixes (Windows drive letters) always fall through to
 *     local — SCP's `C:\foo` pitfall does not exist here.
 *   - Anything without a matching prefix form is local.
 *   - An unrecognized prefix is NOT silently downgraded to a local path:
 *     resolution fails with `unknown connection` (predictability).
 */
export function parsePathRef(input) {
  const s = String(input ?? "");
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*):(.*)$/.exec(s);
  if (m && m[1].length >= 2) {
    return { kind: "remote", ref: m[1], path: m[2] };
  }
  return { kind: "local", path: s };
}

/**
 * Ensure a connection reference (alias / internal id / pool key) has a live
 * connection, auto-connecting from stored credentials when needed.
 *
 * @param {string} connRef
 * @param {object} deps - { store: ConnectionStore }
 * @returns {Promise<string>} a connection handle usable by ssh-client
 */
export async function ensureConnection(connRef, { store, session = false }) {
  // 会话专用连接：独立池 key（profileId#session），与常规连接分离——tty 长驻
  // 不挤占 exec 连接，断开互不级联。同 profile 的多个 tty 会话共享一条会话连接。
  if (session) {
    const profile = store.get(connRef);
    if (!profile) {
      // connRef 可能是池 key（session key / 瞬态实例 id）：尝试直接命中
      const existingKey = resolveConnectionKey(connRef);
      if (existingKey) return existingKey;
      throw new Error(`unknown connection: ${connRef}`);
    }
    const key = `${profile.id}#session`;
    const existingKey = resolveConnectionKey(key);
    if (existingKey) return existingKey;
    await connectForProfile(profile, connRef, store, { key, session: true });
    return key;
  }

  // Already connected: return the canonical pool key (profileId for saved
  // profiles) rather than the caller's ref, so operations/sessions record
  // a stable id that matches listConnections().id.
  // 常规路径排除会话连接：exec 类操作始终走常规连接，不混入 tty 连接。
  const existingKey = resolveConnectionKey(connRef, { excludeSession: true });
  if (existingKey) return existingKey;

  const profile = store.get(connRef);
  if (!profile) {
    throw new Error(`unknown connection: ${connRef}`);
  }

  await connectForProfile(profile, connRef, store);
  return profile.id;
}

/** 按 profile 凭据建连（常规 / 会话连接共用）。 */
async function connectForProfile(profile, connRef, store, extra = {}) {
  const password = store.getSecret(connRef, "password");
  const privateKey = store.getSecret(connRef, "privateKey");
  const passphrase = store.getSecret(connRef, "passphrase");
  if (!password && !privateKey) {
    throw new Error(
      `no stored credentials for ${profile.alias}; run hrd_cfg_connect first or add credentials via hrd_cfg_edit`
    );
  }

  await connect({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    profileId: profile.id,
    alias: profile.alias,
    source: "auto",
    ...(password ? { password } : {}),
    ...(privateKey ? { privateKey } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(profile.proxyCommand ? { proxyCommand: profile.proxyCommand } : {}),
    ...extra,
  });
}

/**
 * Resolve a parsed remote reference (parsePathRef result, kind === "remote")
 * to a usable connection + remote path, auto-connecting when needed.
 *
 * @param {{ ref: string, path: string }} ref
 * @param {object} deps - { store: ConnectionStore }
 * @returns {Promise<{ connId: string, path: string }>}
 */
export async function resolveRemote(ref, deps) {
  return { connId: await ensureConnection(ref.ref, deps), path: ref.path };
}
