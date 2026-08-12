// rspack.config.mjs — hana-remote-dev 单 bundle 构建
// 输出 CJS（commonjs2）：ESM 输出下 ssh2 内部 __dirname 崩溃（POC 实锤）
// external：node:*（builtins）、*.node（原生模块按原始相对 require，缺失时 ssh2 fallback）
// asset/source：assets/ 下面板文件（panel.js/css/socket.io）构建时读为字符串，运行时全内联

import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// 产物写入项目内 dist/（构建职责止于发布包；部署到宿主目录由 dev slot / 手动完成）
// clean：构建前清空 dist，保证发布包是本次构建的纯产物
const DIST_DIR = path.join(root, "dist");

export default {
  mode: "production",
  target: "node",
  entry: path.join(root, "src", "bundle-entry.js"),
  output: {
    path: DIST_DIR,
    // CJS bundle：宿主以 ESM 加载入口 index.js（壳），实现必须 .cjs 后缀
    // （Node 对 .cjs 强制 CJS 语义；.js 会被 ESM loader 解析，裸 require 崩溃）。
    // 产物写进 native/（与 ssh2 原生 .node 同级）：bundle 内原生引用为同级相对 require，
    // dist 根保持只放手写文件（index.js 壳 / manifest / routes / skills）。
    filename: "native/bundle.cjs",
    // module.exports = 默认导出类（宿主 new + onload）
    library: { type: "commonjs2", export: "default" },
    clean: true,
  },
  module: {
    rules: [
      {
        // 面板资源：构建时读入为字符串（渲染时内联进 HTML）。
        // 源在 src/assets，经 minify-loader（terser / clean-css）压缩后 asset/source 内联
        // （loader 在构建进程内执行，无中间目录与跨进程文件时序问题）。
        test: /\.(js|css)$/,
        include: [path.join(root, "src", "assets")],
        use: [path.join(root, "src", "scripts", "minify-loader.mjs")],
        type: "asset/source",
      },
    ],
  },
  externals: [
    function ({ request }, callback) {
      if (/^node:/.test(request)) return callback(null, `commonjs ${request}`);
      if (/\.node$/.test(request)) {
        // 路径拉平：ssh2 的 sshcrypto 原 request 是 ./crypto/build/Release/，
        // cpu-features 原 request 是 ../build/Release/（相对其 lib/ 目录），
        // 统一拉平到 ./（bundle.cjs 与 *.node 同处 native/，copy-native 对齐）
        let merged = request.replace("./crypto/build/Release/", "./");
        merged = merged.replace("../build/Release/", "./");
        merged = merged.replace("./build/Release/", "./");
        return callback(null, `commonjs ${merged}`);
      }
      callback();
    },
  ],
  plugins: [],
  // 压缩：体积小、loader 读盘+编译更快；错误栈函数/类名仍保留（swc mangle 不动方法名），
  // 调试需要可读栈时临时置 false 即可（构建产物 500KB 级 → 1.6MB 级）
  optimization: {
    minimize: true,
  },
  devtool: false,
  stats: "minimal",
};
