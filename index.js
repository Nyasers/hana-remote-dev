// index.js — 插件入口壳（源码保持可读；构建时由 sync-release.mjs terser 压缩进 dist）
// 职责：读盘执行 native/bundle.cjs（rspack 构建产物），导出插件类。
//
// 实现说明：
// - bundle 是 CJS 形态（commonjs2），不能直接 import（ESM loader 下裸 require 崩溃），
//   因此用 new Function + createRequire 在沙箱内按 CJS 语义执行。
// - loadBundle() 每次调用都重新读盘：构建/更新后无需重启宿主即可加载新 bundle
//   （routes/*.js 壳同样经 loadBundle() 取最新导出，单一事实源在 src/ 与 dist/native）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));

export function loadBundle() {
  const bundlePath = path.join(dir, "native", "bundle.cjs");
  const code = readFileSync(bundlePath, "utf8");
  const mod = { exports: {} };
  const bundleDir = path.join(dir, "native");
  return new Function(
    "exports",
    "module",
    "require",
    "__filename",
    "__dirname",
    code
  )(mod.exports, mod, require, bundlePath, bundleDir), mod.exports;
}

export default loadBundle();
