import { listConnections, isConnected } from "./ssh-client.js";
import { runtimeHolder } from "./runtime.js";
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
} from "./channel-handlers.js";

export default function registerRoutes(app, ctx) {
  // ---- Channel bootstrap ----

  /** Where the panel can reach the plugin's local Socket.IO server. */
  app.get("/api/connections/socket-info", (c) => {
    const runtime = requireRuntime(ctx);
    const local = runtime.localSocket;
    if (!local || !local.port) {
      return c.json({ ok: false, error: "Local socket server is not available." }, 503);
    }
    return c.json({ ok: true, port: local.port, token: local.token });
  });

  // ---- Read ----

  app.get("/api/connections", (c) => {
    const runtime = requireRuntime(ctx);
    const { ok, data } = handleList(runtime);
    return ok ? c.json(data) : c.json({ ok: false, error: data }, 500);
  });

  app.get("/api/connections/:id", (c) => {
    const runtime = requireRuntime(ctx);
    const { ok, data } = handleGet(runtime, c.req.param("id"));
    return ok ? c.json(data) : c.json({ ok: false, error: data }, 500);
  });

  // ---- Write: profile CRUD ----

  app.post("/api/connections", async (c) => {
    const runtime = requireRuntime(ctx);
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    const result = await handleSave(runtime, body);
    return respond(c, result, 201);
  });

  app.put("/api/connections/:id", async (c) => {
    const runtime = requireRuntime(ctx);
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    const result = await handleUpdate(runtime, c.req.param("id"), body);
    return respond(c, result);
  });

  app.delete("/api/connections/:id", (c) => {
    const runtime = requireRuntime(ctx);
    const result = handleRemove(runtime, c.req.param("id"));
    return respond(c, result);
  });

  // ---- Write: connection lifecycle ----

  app.post("/api/connections/:id/connect", async (c) => {
    const runtime = requireRuntime(ctx);
    const result = await handleConnect(runtime, c.req.param("id"));
    return respond(c, result);
  });

  app.post("/api/connections/:id/disconnect", (c) => {
    const runtime = requireRuntime(ctx);
    const result = handleDisconnect(runtime, c.req.param("id"));
    return respond(c, result);
  });

  // ---- Sessions (monitoring / management) ----

  app.get("/api/connections/:id/sessions", (c) => {
    const runtime = requireRuntime(ctx);
    const result = handleSessions(runtime, c.req.param("id"));
    return respond(c, result);
  });

  app.post("/api/connections/:id/sessions/:sessionId/kill", (c) => {
    const runtime = requireRuntime(ctx);
    const result = handleKillSession(runtime, c.req.param("sessionId"));
    return respond(c, result);
  });

  // ---- Health ----

  app.get("/api/health", (c) => {
    const runtime = requireRuntime(ctx);
    const active = listConnections().map((conn) => ({
      ...conn,
      connectedAt: conn.connectedAt.toISOString(),
      healthy: isConnected(conn.id),
    }));
    return c.json({ ok: true, active });
  });
}

// ---- Helpers ----

function respond(c, result, successStatus = 200) {
  if (result.ok) {
    return c.json({ ok: true, ...result.data }, successStatus);
  }
  const status = result.status ?? 500;
  const payload = { ok: false, error: result.error };
  if (result.data) payload.data = result.data;
  return c.json(payload, status);
}

function requireRuntime(ctx) {
  if (!ctx?._remoteDev && !runtimeHolder.current) {
    throw new Error("Remote Development plugin runtime is not initialized");
  }
  return ctx?._remoteDev ?? runtimeHolder.current;
}

