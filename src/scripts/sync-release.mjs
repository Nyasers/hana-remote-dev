// src/scripts/sync-release.mjs — 构建后把静态文件同步进 dist/（发布包完整化）
// dist 已由 rspack clean 清空，这里负责：
//   JS（index.js loader + routes/*.js 壳 + app/bundle.cjs 主产物）统一过 terser
//   app/ 卡片资源（card.js/card.css）压缩后拷贝（同 minify-assets 共享逻辑）
//   manifest 原样拷贝
// 构建职责到此为止，部署到宿主目录由 dev slot / 手动完成。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";
import { minifyJs, minifyCss } from "./minify-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "dist");

// JS：全部过 terser（壳为 ESM 保留 module:true；bundle 为 CJS IIFE 用默认）
const JS_ESM_ITEMS = ["index.js", "routes/api.js", "routes/ui.js", "routes/card.js"];
const JS_CJS_ITEM = "app/bundle.cjs";

for (const rel of JS_ESM_ITEMS) {
  const srcPath = path.join(root, rel);
  const outPath = path.join(dist, rel);
  const code = fs.readFileSync(srcPath, "utf8");
  const out = await minify(code, { module: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out.code);
  console.log(`terser: ${rel} (${code.length}B -> ${out.code.length}B)`);
}

{
  // rspack（swc minimizer）产物再压一遍：swc 与 terser 优化面互补，通常还能再省 1~3%
  const rel = JS_CJS_ITEM;
  const p = path.join(dist, rel);
  const code = fs.readFileSync(p, "utf8");
  const out = await minify(code);
  fs.writeFileSync(p, out.code);
  console.log(`terser: ${rel} (${code.length}B -> ${out.code.length}B)`);
}

// 非 JS 静态项：原样拷贝（skills 已随 SKILL 退役移除——Agent 手册经 HRD://guide 按需取）
const RAW_ITEMS = ["manifest.json"];
for (const item of RAW_ITEMS) {
  fs.cpSync(path.join(root, item), path.join(dist, item), { recursive: true });
  console.log(`sync: ${item}`);
}

// app/ 卡片资源：JS/CSS 压缩后拷贝（源码保持可读，发布形态为压缩版；
// card-routes.js 运行时读盘，路径不变不缓存，压缩不影响加载），其余原样。
{
  const srcDir = path.join(root, "app");
  const dstDir = path.join(dist, "app");
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, name);
    const dstPath = path.join(dstDir, name);
    const st = fs.statSync(srcPath);
    if (st.isDirectory()) {
      fs.cpSync(srcPath, dstPath, { recursive: true });
      console.log(`sync: app/${name}/ (dir)`);
      continue;
    }
    const content = fs.readFileSync(srcPath, "utf8");
    if (name.endsWith(".js")) {
      const out = await minifyJs(content);
      fs.writeFileSync(dstPath, out);
      console.log(`minify: app/${name} (${content.length}B -> ${out.length}B)`);
    } else if (name.endsWith(".css")) {
      const out = minifyCss(content);
      fs.writeFileSync(dstPath, out);
      console.log(`minify: app/${name} (${content.length}B -> ${out.length}B)`);
    } else {
      fs.copyFileSync(srcPath, dstPath);
      console.log(`sync: app/${name}`);
    }
  }
}
