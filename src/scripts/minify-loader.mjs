// src/scripts/minify-loader.mjs — rspack loader：asset/source 内联前压缩面板资源
// 面板资源（src/assets/*.js/css）以字符串进 bundle，rspack 压缩器不碰字符串内容，
// 因此在 asset/source 之前经本 loader 压缩：
//   panel.js  → terser（ESM 保留）
//   panel.css → clean-css
//   socket.io.esm.min.js 已压缩，原样放行
// loader 在构建进程内执行：无中间目录、无跨进程文件时序问题。
// 注：HTML 模板保持 JS 模板字符串形态（静态部分 ~430 字符，独立压缩收益 < 0.2KB，不值得）
// 压缩实现见 minify-assets.mjs（与 sync-release 的 app/ 压缩共用，单一事实源）
import { minifyJs, minifyCss } from "./minify-assets.mjs";

export default async function minifyLoader(content) {
  const callback = this.async();
  try {
    const p = this.resourcePath;
    let out;
    if (p.endsWith(".css")) {
      out = minifyCss(content);
    } else if (p.endsWith("socket.io.esm.min.js")) {
      out = content; // 已是压缩态
    } else if (p.endsWith(".js")) {
      out = await minifyJs(content);
    } else {
      out = content;
    }
    callback(null, out);
  } catch (err) {
    callback(err);
  }
}
