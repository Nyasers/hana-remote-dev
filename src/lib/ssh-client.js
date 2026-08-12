import { Client } from "ssh2";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import * as sessionLog from "./session-log.js";

/**
 * Active connections pool.
 *
 * Key semantics: a saved profile connection is keyed by its internal
 * profileId (HRD_xxx) — a stable, restart-proof handle. Connections made
 * without a saved profile fall back to a transient conn_N id.
 *
 * One active connection per profile: connecting again with the same
 * profileId replaces the previous one (disconnect + reconnect), so the
 * pool never accumulates ambiguous duplicates.
 */
const connections = new Map();
let connCounter = 0;

// 建连单飞锁：同 key 并发 connect 复用进行中的 Promise（并行工具组共享连接）。
const pendingConnects = new Map();

// Connection-change listeners (event-driven UI updates, no polling).
const changeListeners = new Set();

/**
 * Subscribe to connection pool changes (connect / disconnect / remote close).
 * @param {Function} fn
 * @returns {Function} unsubscribe
 */
export function onConnectionChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notifyConnectionChange() {
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {
      // listener errors must not break the pool
    }
  }
}

const ConnState = {
  CONNECTING: "connecting",
  CONNECTED: "connected",
  CLOSED: "closed",
};

/**
 * Build a duplex stream out of a ProxyCommand child process, OpenSSH style:
 * the child's stdin/stdout carry the raw byte stream for the SSH protocol.
 * %h / %p placeholders are substituted like ssh(1) does.
 */
function proxySocket(command, host, port) {
  const cmd = String(command).replace(/%h/g, host).replace(/%p/g, String(port));
  const child = spawn(cmd, { shell: true });
  const stream = new Duplex({
    read() {},
    write(chunk, enc, cb) {
      child.stdin.write(chunk, enc, cb);
    },
    final(cb) {
      child.stdin.end(cb);
    },
  });
  child.stdout.on("data", (d) => stream.push(d));
  child.stdout.on("end", () => stream.push(null));
  child.stderr.on("data", () => {}); // proxy stderr stays out of the channel
  child.on("error", (e) => stream.destroy(e));
  child.on("close", () => stream.destroy());
  stream.on("close", () => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  });
  return stream;
}

/**
 * Normalize an expected host key fingerprint to lowercase hex (sha256).
 * Accepts OpenSSH-style "SHA256:<base64>" or a bare 64-char hex string.
 * Returns null for unsupported formats.
 */
export function normalizeFingerprint(input) {
  const s = String(input || "").trim();
  if (/^SHA256:/i.test(s)) {
    const b64 = s.slice(7).trim();
    try {
      const hex = Buffer.from(b64, "base64").toString("hex");
      return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  return /^[0-9a-f]{64}$/i.test(s) ? s.toLowerCase() : null;
}

/**
 * Connect to a remote host via SSH.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.username
 * @param {string} [opts.password]
 * @param {string} [opts.privateKey] - PEM content
 * @param {string} [opts.passphrase]
 * @param {string} [opts.agent]
 * @param {string} [opts.proxyCommand] - OpenSSH ProxyCommand (via child process)
 * @param {string} [opts.expectFingerprint] - expected host key fingerprint
 *   ("SHA256:<base64>" or hex). When set, the server host key is strictly
 *   verified against it; when unset, the host key is not verified.
 * @param {number} [opts.timeout=10] - seconds
 * @param {string} [opts.profileId] - when connecting a saved profile, pass
 *   its internal id: the connection is keyed by it (stable handle) and any
 *   previous connection with the same key is replaced.
 * @param {string} [opts.alias] - profile alias, surfaced in listings.
 * @param {string} [opts.key] - explicit pool key (e.g. `${profileId}#session` for
 *   session-dedicated connections). Defaults to profileId / conn_N.
 * @param {boolean} [opts.session] - marks a session-dedicated connection.
 * @returns {Promise<string>} connection handle (profileId, key, or conn_N)
 */
export function connect(opts) {
  const lockKey = opts.key || opts.profileId;
  if (lockKey && pendingConnects.has(lockKey)) {
    // 同 key 并发建连（并行工具组）：复用进行中的 Promise，避免重复建连。
    // 等待者与发起者共享同一条连接（同一 connId）。
    return pendingConnects.get(lockKey);
  }
  const p = new Promise((resolve, reject) => {
    const timeout = (opts.timeout || 10) * 1000;
    const client = new Client();
    // Stable handle for saved profiles / explicit keys; transient conn_N otherwise.
    const connId = opts.key || opts.profileId || `conn_${++connCounter}`;
    // 连接实例 id：每次连接唯一（池 key 稳定，实例区分批次）。
    // 瞬态连接（connId 已是 conn_N）直接以 connId 作为实例 id。
    const instanceId = connId.startsWith("conn_") ? connId : `conn_${++connCounter}`;

    // One active connection per pool key: replace the old one.
    if (opts.key || opts.profileId) {
      const existing = connections.get(connId);
      if (existing) {
        try {
          existing.client.end();
        } catch {
          // ignore
        }
        connections.delete(connId);
      }
    }

    const connectConfig = {
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      readyTimeout: timeout,
      // Detect half-open connections (remote gone without a clean close):
      // keepalive probes every 15s; 3 missed probes close the connection,
      // so the panel reflects an unexpected drop within ~a minute.
      keepaliveInterval: opts.keepaliveInterval ?? 15000,
      keepaliveCountMax: opts.keepaliveCountMax ?? 3,
    };

    if (opts.expectFingerprint) {
      const expected = normalizeFingerprint(opts.expectFingerprint);
      connectConfig.hostHash = "sha256";
      connectConfig.hostVerifier = (keyHex) => expected !== null && keyHex === expected;
    }

    if (opts.proxyCommand) {
      connectConfig.sock = proxySocket(opts.proxyCommand, opts.host, opts.port || 22);
    }

    if (opts.password) {
      connectConfig.password = opts.password;
    }
    if (opts.privateKey) {
      connectConfig.privateKey = opts.privateKey;
    }
    if (opts.passphrase) {
      connectConfig.passphrase = opts.passphrase;
    }
    if (opts.agent) {
      connectConfig.agent = opts.agent;
    }

    const timer = setTimeout(() => {
      client.end();
      notifyConnectionChange(); // a replaced old connection may have been dropped
      if (eventLogDir) sessionLog.appendEventLog(eventLogDir, "connection", `${sessionLog.eventTs()} connect timeout | ${opts.alias || opts.profileId || opts.host} | ${opts.username || "?"}@${opts.host}:${opts.port || 22}`);
      reject(new Error(`SSH connection timeout after ${timeout / 1000}s to ${opts.host}:${opts.port}`));
    }, timeout + 2000);

    client.on("ready", () => {
      clearTimeout(timer);
      connections.set(connId, {
        client,
        config: opts,
        instanceId,
        connectedAt: new Date(),
        state: ConnState.CONNECTED,
        lastUsedAt: Date.now(),
      });
      if (eventLogDir) sessionLog.appendEventLog(eventLogDir, "connection", `${sessionLog.eventTs()} connect ok | ${opts.alias || opts.profileId || opts.host} | ${opts.username || "?"}@${opts.host}:${opts.port || 22} | ${connId}`);
      notifyConnectionChange();
      resolve(connId);
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      notifyConnectionChange(); // a replaced old connection may have been dropped
      if (eventLogDir) sessionLog.appendEventLog(eventLogDir, "connection", `${sessionLog.eventTs()} connect fail | ${opts.alias || opts.profileId || opts.host} | ${err?.message || err}`);
      reject(err);
    });

    client.on("close", () => {
      // Clean up on remote close
      const entry = connections.get(connId);
      if (entry && entry.client === client) {
        entry.state = ConnState.CLOSED;
        connections.delete(connId);
        if (eventLogDir) sessionLog.appendEventLog(eventLogDir, "connection", `${sessionLog.eventTs()} close | ${connLabel(entry.config)} | socket closed by remote`);
        notifyConnectionChange();
      }
    });

    client.connect(connectConfig);
  });
  if (lockKey) {
    pendingConnects.set(lockKey, p);
    p.finally(() => {
      if (pendingConnects.get(lockKey) === p) pendingConnects.delete(lockKey);
    }).catch(() => {});
  }
  return p;
}

/**
 * Resolve a connection by handle: exact pool key first, then by profileId
 * or alias carried in the entry config.
 * @param {string} ref - alias, profileId, or pool key (conn_N)
 */
function resolveConnection(ref) {
  if (!ref) return null;
  if (connections.has(ref)) return connections.get(ref);
  for (const entry of connections.values()) {
    if (entry.config.profileId === ref || entry.config.alias === ref) return entry;
  }
  return null;
}

/**
 * Resolve a ref (alias, profileId, or pool key) to the canonical pool key.
 * Returns null when no connection matches. Used by ensureConnection so
 * operations and sessions record the stable pool key instead of whatever
 * alias the caller happened to pass in.
 * @param {string} ref - alias, profileId, or pool key
 * @returns {string|null}
 */
export function resolveConnectionKey(ref, opts = {}) {
  if (!ref) return null;
  if (connections.has(ref)) {
    if (opts.excludeSession && connections.get(ref).config.session) return null;
    return ref;
  }
  for (const [key, entry] of connections) {
    if (opts.excludeSession && entry.config.session) continue;
    if (entry.config.profileId === ref || entry.config.alias === ref) return key;
  }
  return null;
}

/**
 * Drop a connection after an operation-level failure (dead / half-open
 * socket, e.g. the remote VM was shut down without a clean close). The
 * in-flight operation still rejects; the next ensureConnection rebuilds
 * from stored credentials. Safe to call when the entry is already gone.
 * @param {string} connId - alias, profileId, or pool key
 */
function dropConnection(connId) {
  const entry = resolveConnection(connId);
  if (!entry) return;
  try {
    // destroy(): immediately tear down the socket. end() would wait for
    // in-flight channels, which hangs forever on a half-dead connection.
    entry.client.destroy();
  } catch {
    // ignore
  }
  entry.state = ConnState.CLOSED;
  for (const [key, value] of connections) {
    if (value === entry) connections.delete(key);
  }
  notifyConnectionChange();
}

/**
 * Execute a command on a remote host and collect output.
 *
 * @param {string} connId - alias, profileId, or pool key
 * @param {string} command
 * @param {object} [opts]
 * @param {number} [opts.timeout=30] - max execution time in seconds
 * @param {string} [opts.cwd] - working directory; prepends `cd <cwd> &&`
 * @param {boolean} [opts.pty] - allocate a pseudo-terminal. When set, the
 *   promise resolves with the raw stream instead of collected output
 *   (interactive use; caller manages the stream lifecycle).
 * @param {Function} [opts.onStream] - called with the exec stream as soon
 *   as it is created (non-pty path); lets callers attach a kill handle.
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null } | object>}
 *   collected result (default) or the raw exec stream ({ stream, stderrStream })
 */
export function exec(connId, command, opts = {}) {
  const entry = resolveConnection(connId);
  if (!entry) {
    return Promise.reject(new Error(`No active connection: ${connId}`));
  }
  // Busy-guard: mark the connection busy for the whole flight so the idle
  // sweep never reclaims a connection with work in progress.
  entry.lastUsedAt = Date.now();
  entry.busy = (entry.busy || 0) + 1;
  return execInner(connId, command, opts).finally(() => {
    entry.busy = Math.max(0, (entry.busy || 1) - 1);
    releaseIfIdle(connId); // 事件驱动：exec 结束即尝试释放（busy 归零 + 无会话 + 非 manual）
  });
}

function execInner(connId, command, opts = {}) {
  return new Promise((resolve, reject) => {
    const entry = resolveConnection(connId);
    if (!entry) {
      return reject(new Error(`No active connection: ${connId}`));
    }
    entry.lastUsedAt = Date.now();

    const fullCommand = opts.cwd ? `cd ${JSON.stringify(String(opts.cwd))} && ${command}` : command;

    const timeout = (opts.timeout || 30) * 1000;
    let stdout = "";
    let stderr = "";
    let code = null;

    entry.client.exec(fullCommand, (err, stream) => {
      if (err) {
        dropConnection(connId);
        return reject(err);
      }

      opts.onStream?.(stream);

      // 超时：只标记 + 关流，不在这里 reject（close 事件会先于同 tick 的
      // reject 触发并 resolve，reject 反而因 race 无效）。close 带 timedOut
      // 标记，调用方据此区分「命令超时」（系统）与「连接中断」（被动/用户）。
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          stream.close();
        } catch {
          // ignore
        }
      }, timeout);
      // failsafe：stream.close() 是优雅关闭，命令未结束前 close 事件不会来；
      // 这里强制收尾并带超时标记（hrdTimedOut），调用方据此显示「超时」而不是「失败”。
      const failsafe = setTimeout(() => {
        const err = new Error(`Command execution timeout after ${timeout / 1000}s`);
        err.hrdTimedOut = true;
        reject(err);
      }, timeout + 3000);

      stream.on("data", (data) => {
        stdout += data.toString("utf-8");
      });

      stream.stderr.on("data", (data) => {
        stderr += data.toString("utf-8");
      });

      stream.on("close", (exitCode) => {
        clearTimeout(timer);
        clearTimeout(failsafe);
        code = exitCode;
        resolve({ stdout, stderr, code, timedOut });
      });
    });
  });
}

/**
 * Start an SFTP session for file operations.
 *
 * @param {string} connId - alias, profileId, or pool key
 * @returns {Promise<object>} sftpClient with helper methods
 */
export async function sftp(connId) {
  const entry = resolveConnection(connId);
  if (!entry) {
    throw new Error(`No active connection: ${connId}`);
  }
  entry.lastUsedAt = Date.now();
  // Busy-guard: file work keeps the connection busy until the session ends.
  entry.busy = (entry.busy || 0) + 1;

  return new Promise((resolve, reject) => {
    entry.client.sftp((err, sftp) => {
      if (err) {
        entry.busy = Math.max(0, (entry.busy || 1) - 1);
        dropConnection(connId);
        return reject(err);
      }

      const client = {
        /**
         * Read entire remote file as string.
         * @param {string} remotePath
         * @param {string} [encoding="utf-8"]
         */
        readFile(remotePath, encoding = "utf-8") {
          return new Promise((resolve2, reject2) => {
            sftp.readFile(remotePath, { encoding }, (err2, data) => {
              if (err2) return reject2(err2);
              resolve2(data);
            });
          });
        },

        /**
         * Read a byte range of a remote file.
         * @param {string} remotePath
         * @param {number} [offset=0]
         * @param {number} [length] - max bytes to read (rest of file when unset)
         * @returns {Promise<Buffer>}
         */
        readRange(remotePath, offset = 0, length) {
          return new Promise((resolve2, reject2) => {
            sftp.open(remotePath, "r", (err2, handle) => {
              if (err2) return reject2(err2);
              const chunks = [];
              let remaining = length;
              let position = offset;
              const buf = Buffer.alloc(64 * 1024);
              const readNext = () => {
                const want = remaining === undefined ? buf.length : Math.min(buf.length, remaining);
                sftp.read(handle, buf, 0, want, position, (err3, bytesRead) => {
                  if (err3) {
                    sftp.close(handle, () => reject2(err3));
                    return;
                  }
                  if (bytesRead <= 0) {
                    sftp.close(handle, () => resolve2(Buffer.concat(chunks)));
                    return;
                  }
                  chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
                  position += bytesRead;
                  if (remaining !== undefined) {
                    remaining -= bytesRead;
                    if (remaining <= 0) {
                      sftp.close(handle, () => resolve2(Buffer.concat(chunks)));
                      return;
                    }
                  }
                  readNext();
                });
              };
              readNext();
            });
          });
        },

        /**
         * Write content to a remote file.
         * @param {string} remotePath
         * @param {string|Buffer} content
         */
        writeFile(remotePath, content) {
          return new Promise((resolve2, reject2) => {
            sftp.writeFile(remotePath, content, (err2) => {
              if (err2) return reject2(err2);
              resolve2();
            });
          });
        },

        /**
         * Stream read a remote file (returns a Readable).
         */
        createReadStream(remotePath) {
          return sftp.createReadStream(remotePath);
        },

        /**
         * Stream write a remote file (returns a Writable).
         */
        createWriteStream(remotePath) {
          return sftp.createWriteStream(remotePath);
        },

        /**
         * Fast download: remote file to local path (no parent dir creation).
         */
        fastGet(remotePath, localPath) {
          return new Promise((resolve2, reject2) => {
            sftp.fastGet(remotePath, localPath, (err2) => (err2 ? reject2(err2) : resolve2()));
          });
        },

        /**
         * Fast upload: local file to remote path (no parent dir creation).
         */
        fastPut(localPath, remotePath) {
          return new Promise((resolve2, reject2) => {
            sftp.fastPut(localPath, remotePath, (err2) => (err2 ? reject2(err2) : resolve2()));
          });
        },

        /**
         * List a remote directory.
         * @param {string} remotePath
         * @returns {Promise<Array<{ filename: string, longname: string, attrs: object, isDirectory: boolean, isFile: boolean }>>}
         */
        readdir(remotePath) {
          return new Promise((resolve2, reject2) => {
            sftp.readdir(remotePath, (err2, list) => {
              if (err2) return reject2(err2);
              resolve2(
                list.map((entry) => ({
                  filename: entry.filename,
                  longname: entry.longname,
                  attrs: entry.attrs,
                  isDirectory: entry.attrs?.isDirectory?.() ?? false,
                  isFile: !(entry.attrs?.isDirectory?.() ?? false),
                  size: entry.attrs?.size ?? 0,
                  modifyTime: entry.attrs?.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : null,
                }))
              );
            });
          });
        },

        /**
         * Get file/directory stats.
         * @param {string} remotePath
         */
        stat(remotePath) {
          return new Promise((resolve2, reject2) => {
            sftp.stat(remotePath, (err2, stats) => {
              if (err2) return reject2(err2);
              resolve2({
                isDirectory: stats.isDirectory(),
                isFile: stats.isFile(),
                size: stats.size,
                mode: stats.mode,
                modifyTime: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null,
              });
            });
          });
        },

        /**
         * Delete a remote file.
         * @param {string} remotePath
         */
        unlink(remotePath) {
          return new Promise((resolve2, reject2) => {
            sftp.unlink(remotePath, (err2) => {
              if (err2) return reject2(err2);
              resolve2();
            });
          });
        },

        /**
         * Rename a remote file (POSIX: overwrites target atomically).
         * @param {string} fromPath
         * @param {string} toPath
         */
        rename(fromPath, toPath) {
          return new Promise((resolve2, reject2) => {
            sftp.rename(fromPath, toPath, (err2) => {
              if (err2) return reject2(err2);
              resolve2();
            });
          });
        },

        /**
         * Create a remote directory. Recursive mode stats each path segment
         * and creates only missing ones (ssh2's mkdir has no recursive
         * support and errors on existing dirs).
         * @param {string} remotePath
         * @param {boolean} [recursive=true]
         */
        mkdir(remotePath, recursive = true) {
          const mkdirP = (p) =>
            new Promise((resolve2, reject2) => {
              sftp.mkdir(p, (err2) => (err2 ? reject2(err2) : resolve2()));
            });
          const statP = (p) =>
            new Promise((resolve2, reject2) => {
              sftp.stat(p, (err2, st) => (err2 ? reject2(err2) : resolve2(st)));
            });

          if (!recursive) {
            return mkdirP(remotePath);
          }

          return (async () => {
            const absolute = String(remotePath).startsWith("/");
            const parts = String(remotePath).split("/").filter(Boolean);
            let cur = absolute ? "/" : "";
            for (const part of parts) {
              cur = cur === "/" ? `/${part}` : `${cur}/${part}`;
              try {
                const st = await statP(cur);
                if (!st.isDirectory()) {
                  throw new Error(`Not a directory: ${cur}`);
                }
              } catch {
                // Not present (or not a dir) — try to create it.
                try {
                  await mkdirP(cur);
                } catch (err2) {
                  // Race: another writer created it between stat and mkdir.
                  const st2 = await statP(cur).catch(() => null);
                  if (!st2 || !st2.isDirectory()) throw err2;
                }
              }
            }
          })();
        },

        /**
         * Close the SFTP session.
         */
        end() {
          sftp.end();
          entry.busy = Math.max(0, (entry.busy || 1) - 1);
          releaseIfIdle(connId); // 事件驱动：文件操作结束即尝试释放
        },
      };

      resolve(client);
    });
  });
}

/**
 * Re-anchor a transient connection (conn_N) to a saved profile's id after
 * the profile has been persisted. Callers get the stable handle back.
 * @param {string} connId - current pool key (conn_N)
 * @param {string} profileId
 * @param {string} alias
 * @returns {string} the new handle (profileId), or the old one if the
 *   re-anchor could not happen (missing entry / id collision).
 */
export function anchorConnection(connId, profileId, alias) {
  const entry = connections.get(connId);
  if (!entry || connections.has(profileId)) return connId;
  entry.config.profileId = profileId;
  entry.config.alias = alias;
  connections.set(profileId, entry);
  connections.delete(connId);
  notifyConnectionChange();
  return profileId;
}

/**
 * Update the alias snapshot of an active connection after a profile rename,
 * so the pool resolves and displays the current alias immediately.
 * @param {string} profileId - pool key (HRD_xxx)
 * @param {string} alias - new alias
 * @returns {boolean} whether an active connection was updated
 */
export function renameConnectionAlias(profileId, alias) {
  const entry = connections.get(profileId);
  if (!entry) return false;
  entry.config.alias = alias;
  notifyConnectionChange();
  return true;
}

/**
 * List all active connections.
 * @returns {Array<{ id: string, handle: string, alias: string|null,
 * profileId: string|null, host: string, port: number, username: string,
 * connectedAt: Date }>}
 */
export function listConnections() {
  return [...connections.entries()].map(([id, entry]) => ({
    id,
    // Preferred handle for callers: the stable alias/profile id when the
    // connection came from a saved profile.
    handle: entry.config.profileId || id,
    alias: entry.config.alias || null,
    profileId: entry.config.profileId || null,
    // 连接实例 id：每次连接唯一（区分批次；操作/会话记录挂此 id）
    instanceId: entry.instanceId || id,
    host: entry.config.host,
    port: entry.config.port,
    username: entry.config.username,
    connectedAt: entry.connectedAt,
    source: entry.config.source || "manual",
  }));
}

/**
 * Resolve a pool key to its current connection instance id (null when the
 * connection is gone). Operations record this id so the panel can group
 * operations by connection batch.
 * @param {string} connId - alias, profileId, or pool key
 * @returns {string|null}
 */
export function instanceOf(connId) {
  const entry = resolveConnection(connId);
  return entry ? entry.instanceId || connId : null;
}

/**
 * Check if a connection is active.
 * @param {string} connId - alias, profileId, or pool key
 * @returns {boolean}
 */
export function isConnected(connId) {
  const entry = resolveConnection(connId);
  if (!entry) return false;
  return entry.state === ConnState.CONNECTED;
}

/**
 * Close an SSH connection.
 * @param {string} connId - alias, profileId, or pool key
 */
// 主动断开标记（面板断开按钮 / cfg_disconnect 工具）：exec 被打断时据此
// 区分「用户叫停」与「被动连接丢失」。窗口 30s，懒清理。
const manualDisconnects = new Map();

/**
 * Whether the given connection was manually disconnected within the window.
 * @param {string} connId
 * @param {number} [windowMs=30000]
 * @returns {boolean}
 */
export function wasManuallyDisconnected(connId, windowMs = 30000) {
  const ts = manualDisconnects.get(connId);
  if (ts === undefined) return false;
  if (Date.now() - ts > windowMs) {
    manualDisconnects.delete(connId);
    return false;
  }
  return true;
}

export function disconnect(connId, { manual = true } = {}) {
  // 主动断开（面板按钮 / cfg_disconnect / 工具 kill）才打「手动标记”；
  // idle 扫描与事件驱动释放的自动回收不打标——否则 30s 窗口内残留标记会把后续
  // 被动中断（超时 / 网络丢失）误判成「用户叫停”。
  if (manual) manualDisconnects.set(connId, Date.now());
  // Locate the pool key: exact match first, then by profileId/alias.
  let key = connId;
  if (!connections.has(connId)) {
    for (const [k, entry] of connections) {
      if (entry.config.profileId === connId || entry.config.alias === connId) {
        key = k;
        break;
      }
    }
  }
  const entry = connections.get(key);
  if (entry) {
    // Cascade: terminate interactive sessions bound to this connection.
    for (const sess of sessions.values()) {
      if (sess.connId === key && !sess.closed) {
        try {
          sess.stream.close();
        } catch {
          // ignore
        }
      }
    }
    connections.delete(key);
    if (eventLogDir) sessionLog.appendEventLog(eventLogDir, "connection", `${sessionLog.eventTs()} disconnect ${manual ? "manual" : "auto"} | ${connLabel(entry.config)} | ${key}`);
    try {
      // destroy() (not end()): end() is a graceful close that waits for
      // in-flight channels to finish, so a long exec would keep running
      // after the user disconnects. destroy() tears the socket down now
      // and every channel on it (exec streams, sftp, tty sessions) gets
      // its close event immediately.
      entry.client.destroy();
    } catch {
      // ignore
    }
    notifyConnectionChange();
  }
}

/**
 * Close all active connections.
 */
/**
 * 事件驱动释放（连接释放主路径）：操作（exec / sftp）或 tty 会话结束后调用，
 * 满足「无进行中工作、无活动会话、非手动连接」即断开（事件日志记 disconnect auto）。
 * 手动连接（显式意图）不自动释放；异常残留由 idle sweep 兜底。
 * @param {string} connId - 池 key / alias / profileId
 * @returns {boolean} 是否已释放
 */
export function releaseIfIdle(connId) {
  const entry = resolveConnection(connId);
  if (!entry) return false;
  if ((entry.busy || 0) > 0) return false; // 并发工作（并行 exec/sftp 组）仍在进行：最后一个完成者负责释放
  if ([...sessions.values()].some((s) => s.connId === connId && !s.closed)) return false; // tty 会话仍活动
  if (entry.config.source === "manual") return false; // 手动连接不自动释放
  disconnect(connId, { manual: false });
  return true;
}

export function disconnectAll() {
  for (const [id] of connections) {
    disconnect(id);
  }
}

// ---------------------------------------------------------------------------
// Interactive session pool (hrd_exec_command tty / hrd_write_stdin)
//
// A session is a pty-backed exec channel bound to one connection. sessionId
// is globally unique (timestamp+random, reload-safe), so sessions on different
// connections never collide; hrd_write_stdin addresses sessions by sessionId only.
// ---------------------------------------------------------------------------

const sessions = new Map();
const sessionChangeListeners = new Set();
const sessionKills = new Set(); // 用户主动 kill 的会话（close 时据此判定 how=killed）
const SESSION_BUFFER_LIMIT = 1024 * 1024; // 1MB cap

// sessionId 无状态生成：时间戳(base36) + 随机 3 位，不带前缀（信标/URI/工具参数直接复用，
// 协议名 HRD:// 与目录 session/ 已自解释）。不依赖模块级计数器，
// 插件重载/重启后不会重置归零，也就不会与历史记录文件（<sessionId>.md）冲突。
export function nextSessionId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// 已结束会话的历史快照：唤醒信标携带 sessionId，agent 调 cfg_status 查询结局。
// 快照保存完整输出（stripAnsi 后，受活跃期 buffer 1MB cap 限制，超限有 truncated 标记）。
// 有界保留：条数 + 总字节双限（丢最旧），防止无限增长；sessionId 全局唯一。
const sessionHistory = new Map();
const SESSION_HISTORY_LIMIT = 200;
const SESSION_HISTORY_BYTES = 32 * 1024 * 1024; // 32MB 总输出上限

/**
 * 有界插入历史快照：超过条数或总字节上限时丢弃最旧条目（Map 插入序 = 时间序）。
 * @param {Map} map - sessionId → { outputBytes, ... }
 * @param {number} maxEntries
 * @param {number} [maxTotalBytes]
 */
export function evictHistory(map, maxEntries, maxTotalBytes = Infinity) {
  let total = 0;
  for (const v of map.values()) total += v.outputBytes || 0;
  while (map.size > maxEntries || total > maxTotalBytes) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    const v = map.get(oldest);
    total -= v.outputBytes || 0;
    map.delete(oldest);
  }
}

// 会话日志目录（dataDir/logs/session）：由 bundle-entry install 注入；为 null 时不写日志。
let sessionLogDir = null;
// 事件日志目录（dataDir/logs，connection/config）：由 bundle-entry 注入。
let eventLogDir = null;

// 连接可读名（alias 优先，回落 host）
function connLabel(cfg) {
  return cfg.alias || cfg.host || "?";
}
// 空间两限（0 = 不设限）：由 bundle-entry 从面板配置注入。
let sessionLogMaxBytes = 8 * 1024 * 1024; // 单文件
let sessionLogMaxTotalBytes = 32 * 1024 * 1024; // 目录总字节

export function setSessionLogDir(dir) {
  sessionLogDir = dir || null;
}

export function setEventLogDir(dir) {
  eventLogDir = dir || null;
}

export function setSessionLogMaxBytes(bytes) {
  sessionLogMaxBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

export function setSessionLogMaxTotalBytes(bytes) {
  sessionLogMaxTotalBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/** 当前生效的两限（面板回显；MB 单位，0 = 不设限）。 */
export function getSessionLogLimits() {
  return {
    maxMB: sessionLogMaxBytes > 0 ? Math.round(sessionLogMaxBytes / (1024 * 1024)) : 0,
    maxTotalMB: sessionLogMaxTotalBytes > 0 ? Math.round(sessionLogMaxTotalBytes / (1024 * 1024)) : 0,
  };
}

/** 指定会话的日志文件路径（不存在返回 null）。 */
export function getSessionLogPath(sessionId) {
  const ended = sessionHistory.get(sessionId);
  if (ended?.logPath) return ended.logPath;
  return null;
}

/** 查询已结束会话的结局快照；不存在返回 null。 */
export function getSessionHistory(sessionId) {
  return sessionHistory.get(sessionId) || null;
}

/** 列出已结束会话（可选按连接过滤），按结束时间倒序。 */
export function listSessionHistory(connId) {
  const all = [...sessionHistory.values()];
  const filtered = connId ? all.filter((s) => s.connId === connId) : all;
  return filtered.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
}

/**
 * Subscribe to session changes (created / terminated / activity).
 * @param {Function} fn
 * @returns {Function} unsubscribe
 */
export function onSessionChange(fn) {
  sessionChangeListeners.add(fn);
  return () => sessionChangeListeners.delete(fn);
}

function notifySessionChange() {
  for (const fn of sessionChangeListeners) {
    try {
      fn();
    } catch {
      // listener errors must not break the pool
    }
  }
}

/** 移除终端 ANSI 转义序列，保留可读文本。 */
function stripAnsi(s) {
  return String(s || "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][0-9A-Z]/g, "");
}

/**
 * Start an interactive (pty) session on a connection.
 * @param {string} connId - alias, profileId, or pool key
 * @param {string} command
 * @param {object} [opts] - { cwd }
 * @returns {Promise<string>} sessionId
 */
export function createSession(connId, command, opts = {}) {
  return new Promise((resolve, reject) => {
    const entry = resolveConnection(connId);
    if (!entry) return reject(new Error(`No active connection: ${connId}`));
    entry.lastUsedAt = Date.now();

    const sessionId = nextSessionId();
    const fullCommand = opts.cwd ? `cd ${JSON.stringify(String(opts.cwd))} && ${command}` : command;

    entry.client.exec(fullCommand, { pty: true }, (err, stream) => {
      if (err) {
        dropConnection(connId);
        return reject(err);
      }

      const sess = {
        sessionId,
        connId,
        command: String(command),
        startedAt: new Date(),
        lastActivityAt: Date.now(),
        stream,
        buffer: "",
        unreadOffset: 0,
        truncated: false,
        closed: false,
      };

      // 会话日志（增量落盘）：随运行持续追加，close 时 finalize。
      // 日志是使用过程的副产品，不依赖 wake 收尾；失败静默（日志器为 null）。
      // 提示符带真实主机前缀（user@host$），便于阅读与复盘。
      const logger = sessionLogDir
        ? sessionLog.createSessionLogger({
            dir: sessionLogDir,
            sessionId,
            connId,
            command: String(command),
            startedAt: sess.startedAt,
            maxFileBytes: sessionLogMaxBytes,
          })
        : null;
      sess.logger = logger;
      if (logger) sessionLog.cleanupSessionLogs(sessionLogDir, { maxBytes: sessionLogMaxTotalBytes });

      stream.on("data", (d) => {
        sess.lastActivityAt = Date.now();
        let text = d.toString("utf-8");
        if (sess.buffer.length + text.length > SESSION_BUFFER_LIMIT) {
          const drop = sess.buffer.length + text.length - SESSION_BUFFER_LIMIT;
          sess.buffer = sess.buffer.slice(drop) + text;
          sess.unreadOffset = 0;
          sess.truncated = true;
        } else {
          sess.buffer += text;
        }
        sess.logger?.appendOutput(text);
        notifySessionChange();
      });
      stream.on("close", (exitCode) => {
        sess.closed = true;
        sess.lastActivityAt = Date.now();
        const durationMs = Date.now() - sess.startedAt.getTime();
        // 会话结局判定：正常退出（带 exit code）/ 用户终止（kill 标记）/ 用户断开
        // （manual 标记）/ 其余被动中断（idle 回收、网络异常）
        let how = "lost";
        if (exitCode !== undefined) how = "exit";
        else if (sessionKills.delete(sessionId)) how = "killed";
        else if (wasManuallyDisconnected(connId)) how = "disconnect";
        const outputTail = stripAnsi(sess.buffer).slice(-1024);
        sessions.delete(sessionId);
        releaseIfIdle(connId); // 事件驱动：tty 会话关闭后若无其他会话/工作，释放连接
        // 历史快照：完整输出供按需查询（sessionId 全局唯一，直接作为标识符）。
        const output = stripAnsi(sess.buffer);
        const logPath = sess.logger?.filePath || null;
        // 日志封口：flush + 追加结局段（失败静默，快照仍可查）
        sess.logger?.finalize({
          how,
          exitCode: exitCode ?? null,
          durationMs,
          startedAt: sess.startedAt,
          endedAt: new Date(),
          outputBytes: Buffer.byteLength(output),
          truncated: sess.truncated,
        });
        sessionHistory.set(sessionId, {
          sessionId,
          connId,
          command: sess.command,
          startedAt: sess.startedAt,
          endedAt: new Date(),
          how,
          exitCode: exitCode ?? null,
          durationMs,
          output,
          outputBytes: Buffer.byteLength(output),
          truncated: sess.truncated,
          logPath,
        });
        evictHistory(sessionHistory, SESSION_HISTORY_LIMIT, SESSION_HISTORY_BYTES);
        opts.onClose?.({ sessionId, connId, exitCode: exitCode ?? null, how, durationMs, outputTail });
        notifySessionChange();
      });
      stream.on("error", () => {
        /* close event follows */
      });

      sessions.set(sessionId, sess);
      notifySessionChange();
      resolve(sessionId);
    });
  });
}

/**
 * Write input to an interactive session and return output produced since
 * the last read (expect-style write/read alternation). Resolves after the
 * output settles (or a short grace period), so a pty echo is captured.
 * @param {string} sessionId
 * @param {string} chars
 * @returns {Promise<string>} new output since the last read
 */
export function writeSession(sessionId, chars) {
  const sess = sessions.get(sessionId);
  if (!sess) return Promise.reject(new Error(`No active session: ${sessionId}`));
  if (sess.closed) return Promise.reject(new Error(`Session already closed: ${sessionId}`));
  sess.lastActivityAt = Date.now();
  const charsStr = String(chars);
  sess.logger?.appendInput(charsStr);
  try {
    sess.stream.write(String(chars));
  } catch (err) {
    return Promise.reject(new Error(`Failed to write to session: ${err.message}`));
  }

  // Wait for new output to arrive (pty echo is async) or a grace timeout.
  return new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      if (sess.buffer.length > sess.unreadOffset || Date.now() - t0 > 400) {
        const out = sess.buffer.slice(sess.unreadOffset);
        sess.unreadOffset = sess.buffer.length;
        resolve(out);
      } else {
        setTimeout(poll, 25);
      }
    };
    poll();
  });
}

/**
 * Read unread output of an interactive session.
 * @param {string} sessionId
 * @returns {string}
 */
export function readSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) throw new Error(`No active session: ${sessionId}`);
  const out = sess.buffer.slice(sess.unreadOffset);
  sess.unreadOffset = sess.buffer.length;
  return out;
}

/**
 * Terminate an interactive session. Closing the channel sends SIGHUP to the
 * remote process (pty). The session entry is removed on the close event.
 * @param {string} sessionId
 * @returns {boolean} whether the session existed
 */
export function killSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess || sess.closed) return false;
  sessionKills.add(sessionId); // 用户终止标记：close 时据此判定 how=killed
  try {
    sess.stream.close();
  } catch {
    // ignore
  }
  return true;
}

/**
 * List sessions, optionally filtered by connection.
 * @param {string} [connId]
 * @returns {Array<object>} session metadata (no output content)
 */
export function listSessions(connId) {
  return [...sessions.values()]
    .filter((s) => !connId || s.connId === connId)
    .map((s) => ({
      sessionId: s.sessionId,
      connId: s.connId,
      command: s.command,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      closed: s.closed,
      truncated: s.truncated,
    }));
}

// ---------------------------------------------------------------------------
// Idle management (auto-reclaim):
//   - a session is idle when no input write and no output activity happened
//     for idleTimeout → kill
//   - a connection is idle when it has no active sessions and no recent use
//     (exec / sftp / session creation) for idleTimeout → disconnect
// Connections with active sessions are never reclaimed by idle.
//
// 主路径是事件驱动释放（releaseIfIdle：exec/sftp 结束、tty 会话关闭即断）；
// 本 sweep 只是兜底：异常残留（半开连接、被跳过的释放）超时回收。
// ---------------------------------------------------------------------------

let idleTimer = null;
let idleTimeoutMs = 300 * 1000; // 兜底 TTL（默认 300s，bundle-entry 按配置显式设置）：异常残留连接才轮到它
const manualIdleTimeoutMs = 600 * 1000; // 手动预连接保留 600s（显式意图，面板已无入口，防御性保留）

/** Set the idle timeout (seconds) for auto connections. */
export function setIdleTimeout(seconds) {
  idleTimeoutMs = (Number(seconds) || 10) * 1000;
}

/** Start the periodic idle sweep (5s interval, unref'd). */
export function startIdleManager() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const sess of sessions.values()) {
      // tty 会话长驻：空闲阈值用 manual（600s），不随 exec 短 TTL 被杀
      if (!sess.closed && now - sess.lastActivityAt > manualIdleTimeoutMs) {
        try {
          sess.stream.close();
        } catch {
          // ignore
        }
      }
    }
    for (const [id, entry] of connections) {
      const hasSessions = [...sessions.values()].some((s) => s.connId === id && !s.closed);
      // 有会话或有进行中的工作（busy）的连接永不回收
      if (hasSessions || (entry.busy || 0) > 0) continue;
      const limit = entry.config.source === "manual" ? manualIdleTimeoutMs : idleTimeoutMs;
      if (now - (entry.lastUsedAt || 0) > limit) {
        // idle 自动回收：不打手动标记（见 disconnect 的 manual 参数）
        disconnect(id, { manual: false });
      }
    }
  }, 5 * 1000);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

/** Stop the periodic idle sweep. */
export function stopIdleManager() {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Higher-level file helpers used by the hrd_* tools
// ---------------------------------------------------------------------------

/**
 * Read a byte range of a remote file (convenience wrapper).
 * @param {string} connId
 * @param {string} remotePath
 * @param {number} [offset=0]
 * @param {number} [length]
 * @returns {Promise<Buffer>}
 */
export async function readRange(connId, remotePath, offset, length) {
  const c = await sftp(connId);
  try {
    return await c.readRange(remotePath, offset || 0, length);
  } finally {
    c.end();
  }
}

/**
 * Atomically write a remote file: mkdir -p parents, write to a temp file,
 * rename over the target. POSIX rename overwrites atomically; on failure
 * (remote Windows) falls back to unlink + rename. Temp file is removed on
 * any error, so no .hrd-tmp-* residue is left on failure paths.
 * @param {string} connId
 * @param {string} remotePath
 * @param {string|Buffer} content
 */
export async function writeAtomic(connId, remotePath, content) {
  const c = await sftp(connId);
  let tmp = null;
  try {
    const idx = remotePath.lastIndexOf("/");
    const dir = idx > 0 ? remotePath.slice(0, idx) : "/";
    await c.mkdir(dir, true);
    tmp = `${remotePath}.hrd-tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await c.writeFile(tmp, content);
    try {
      await c.rename(tmp, remotePath);
    } catch {
      // POSIX rename overwrites the target; Windows needs unlink first.
      try {
        await c.unlink(remotePath);
      } catch {
        // target may not exist
      }
      await c.rename(tmp, remotePath);
    }
    tmp = null;
  } catch (err) {
    if (tmp) {
      try {
        await c.unlink(tmp);
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    c.end();
  }
}