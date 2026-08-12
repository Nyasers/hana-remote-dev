// src/scripts/copy-native.mjs — 构建后把 ssh2 原生加速 .node 复刻到 dist/native/
// （external .node 保留原始相对 require，相对入口 bundle.cjs 解析；
//   rspack external 已把两个 .node 路径拉平为同级 ./，
//   复制目标同步为 native/*.node，无 build/Release/ 嵌套）
// 某平台无预编译产物时跳过对应文件（ssh2 自动 fallback 纯 JS crypto）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 本文件位于 src/scripts/ → 上两级为构建区根
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 产物目标 = 项目 dist/（与 bundle.cjs 同处 native/）
const dist = path.join(root, "dist");

const pairs = [
  // [source 相对路径, dist 内相对路径]
  // 目标目录 native/：与 bundle.cjs 同级（rspack external 已把 .node 拉平为同级 require）
  ["node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node", "native/sshcrypto.node"],
  ["node_modules/cpu-features/build/Release/cpufeatures.node", "native/cpufeatures.node"],
];

let copied = 0;
for (const [from, to] of pairs) {
  const srcPath = path.join(root, from);
  const dstPath = path.join(dist, to);
  if (fs.existsSync(srcPath)) {
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
    console.log(`native: ${path.basename(srcPath)} -> dist/${to}`);
    copied++;
  } else {
    console.log(`native: skip (missing) ${from} — fallback 纯 JS crypto`);
  }
}
console.log(`native: ${copied}/${pairs.length} files copied`);
