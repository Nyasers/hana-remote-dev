/**
 * Local Socket.IO server — the plugin's own duplex channel.
 *
 * Runs on 127.0.0.1 with a random port so it never collides with anything;
 * authenticated by a per-process random token delivered to the panel through
 * the host-guarded route GET /api/connections/socket-info. The WebSocket
 * upgrade happens on this server, fully decoupled from the host's HTTP layer.
 *
 * Transport events (C2S, with ack): connections:list|get|save|update|remove|connect|disconnect
 * Push events (S2C): state:changed — broadcast on any connection-pool,
 * session, or profile-store change (reason: connection | session | profile).
 */

import http from "node:http";
import crypto from "node:crypto";
import { Server } from "socket.io";
import { onConnectionChange, onSessionChange } from "./ssh-client.js";
import { onOperationChange } from "./operations.js";
import {
  handleList,
  handleGet,
  handleSave,
  handleUpdate,
  handleRemove,
  handleConnect,
  handleDisconnect,
  handleSessions,
  handleKillSession,
  handleOperations,
  handleKillOperation,
  handleAppearance,
  handleSessionLogGet,
  handleSessionLogSet,
} from "./channel-handlers.js";

const TOKEN_BYTES = 32;

export class LocalSocketServer {
  constructor({ log, runtime }) {
    this.log = log;
    // 不挂 runtime 属性：宿主可能在安装/状态收集时 JSON 序列化插件实例，
    // runtime.localSocket ↔ localSocket.runtime 互引会抛 circular structure。
    // 改用闭包捕获（函数属性序列化时跳过），事件分发经 this._handlers。
    const rt = runtime;
    this._handlers = {
      list: () => handleList(rt),
      get: (p) => handleGet(rt, p?.ref ?? p?.id),
      save: (p) => handleSave(rt, p ?? {}),
      update: async (p) => {
        const { id, ...rest } = p ?? {};
        return handleUpdate(rt, id, rest);
      },
      remove: (p) => handleRemove(rt, p?.ref ?? p?.id),
      connect: (p) => handleConnect(rt, p?.ref ?? p?.id),
      disconnect: (p) => handleDisconnect(rt, p?.ref ?? p?.id, p?.connId),
      sessions: (p) => handleSessions(rt, p?.ref ?? p?.id),
      killSession: (p) => handleKillSession(rt, p?.sessionId),
      operations: () => handleOperations(),
      killOperation: (p) => handleKillOperation(rt, p?.opId),
      sessionLogGet: () => handleSessionLogGet(rt),
      sessionLogSet: (p) => handleSessionLogSet(rt, p ?? {}),
      appearance: () => handleAppearance(rt),
    };
    this._subscribeProfiles = (cb) => rt.connectionStore.onChange(cb);
    this.token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    this.server = null;
    this.io = null;
    this.port = null;
    this.unsubscribe = null;
    this._unloadHandlers = new Set();
  }

  /** Start listening on 127.0.0.1 with a system-assigned port. */
  async start() {
    const httpServer = http.createServer((req, res) => {
      res.writeHead(404).end();
    });

    const io = new Server(httpServer, {
      cors: {
        // Local loopback only; the real gate is the token check below.
        origin: "*",
        methods: ["GET", "POST"],
      },
      allowRequest: (req, callback) => {
        const token = req._query?.token || req.headers["x-hrd-token"];
        if (token === this.token) {
          callback(null, true);
        } else {
          callback("unauthorized", false);
        }
      },
    });

    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });

    this.server = httpServer;
    this.io = io;
    this.port = httpServer.address().port;

    this.registerHandlers();
    this.unsubscribe = onConnectionChange(() => {
      try {
        io.emit("state:changed", { reason: "connection" });
      } catch {
        // broadcasting must never break the pool
      }
    });
    this._unsubSession = onSessionChange(() => {
      try {
        io.emit("state:changed", { reason: "session" });
      } catch {
        // broadcasting must never break the pool
      }
    });
    // Profile store changes (cfg tools, C2S save/update/remove, external
    // edits) — the panel's config list stays in sync without a refresh.
    this._unsubProfiles = this._subscribeProfiles(() => {
      try {
        io.emit("state:changed", { reason: "profile" });
      } catch {
        // broadcasting must never break the store
      }
    });
    // In-flight one-shot operations (exec / copy) — the panel sees what the
    // Agent is doing right now and can stop it.
    this._unsubOperations = onOperationChange(() => {
      try {
        io.emit("state:changed", { reason: "operation" });
      } catch {
        // broadcasting must never break the registry
      }
    });

    this.log.info(`hrd socket server listening on 127.0.0.1:${this.port}`);
    return this.port;
  }

  registerHandlers() {
    const io = this.io;
    const H = this._handlers;

    io.on("connection", (socket) => {
      // 连接角色（panel / card）：广播策略后续可按角色过滤
      socket.data.role = socket.handshake?.query?.role || "panel";
      // Initial sync: tell the fresh panel to pull the list once.
      socket.emit("state:changed", { reason: "open" });

      socket.on("connections:list", (payload, ack) => ack(H.list(payload)));
      socket.on("connections:get", (payload, ack) => ack(H.get(payload)));
      socket.on("connections:save", async (payload, ack) => ack(await H.save(payload)));
      socket.on("connections:update", async (payload, ack) => ack(await H.update(payload)));
      socket.on("connections:remove", (payload, ack) => ack(H.remove(payload)));
      socket.on("connections:connect", async (payload, ack) => ack(await H.connect(payload)));
      socket.on("connections:disconnect", (payload, ack) => ack(H.disconnect(payload)));
      socket.on("sessions:list", (payload, ack) => ack(H.sessions(payload)));
      socket.on("sessions:kill", (payload, ack) => ack(H.killSession(payload)));
      socket.on("operations:list", (payload, ack) => ack(H.operations(payload)));
      socket.on("operations:kill", (payload, ack) => ack(H.killOperation(payload)));
      socket.on("session-log:get", (payload, ack) => ack(H.sessionLogGet(payload)));
      socket.on("session-log:set", (payload, ack) => ack(H.sessionLogSet(payload)));
    });
  }

  /** Stop the server and release listeners. */
  async close() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this._unsubSession) {
      this._unsubSession();
      this._unsubSession = null;
    }
    if (this._unsubProfiles) {
      this._unsubProfiles();
      this._unsubProfiles = null;
    }
    if (this._unsubOperations) {
      this._unsubOperations();
      this._unsubOperations = null;
    }
    if (this.io) {
      this.io.close();
      this.io = null;
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
      this.port = null;
    }
    this.log.info("hrd socket server stopped");
  }
}
