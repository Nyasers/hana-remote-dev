/**
 * Process-level runtime holder — the single source of truth for the live
 * plugin runtime.
 *
 * Why not ctx-only: the host snapshots the plugin context (ctx._remoteDev)
 * per session; after a dev reload the session's ctx still points at the old
 * (disposed) instance, so tools would fail with "not initialized" until the
 * session restarts.
 *
 * Why globalThis instead of a module-level variable: the host caches the
 * tool wrappers registered by *old* module instances across hot reloads
 * (disable → enable). A module-level `runtimeHolder` is per-module-instance,
 * so old wrappers would read the old (cleared) holder and report
 * "not initialized". globalThis is process-wide: whichever module instance a
 * wrapper came from, it resolves the *current* runtime. The holder only
 * clears itself when the disposed runtime is still the current one
 * (set-to-null guarded by identity check in bundle-entry).
 */

const RUNTIME_KEY = "__hrdRuntime__";

export const runtimeHolder = {
  get current() {
    return globalThis[RUNTIME_KEY] ?? null;
  },
  set current(value) {
    if (value === null || value === undefined) {
      delete globalThis[RUNTIME_KEY];
    } else {
      globalThis[RUNTIME_KEY] = value;
    }
  },
};
