import panelCss from "../assets/panel.css";
import panelJs from "../assets/panel.js";
import socketIoSource from "../assets/socket.io.esm.min.js";

// rspack-bundle 形态：面板全内联（asset/source 经 minify-loader 压缩后读入），
// 无静态资源请求、无宿主缓存问题；token 仅用于页面自身请求。

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

export default function registerPluginUiRoutes(app, ctx) {
  app.get("/sidebar", (c) =>
    // 页面必须永不缓存：HTML 全内联（面板代码随每次请求新鲜生成），
    // 缓存会导致面板刷新拿到旧版。
    c.html(renderShell(c, ctx), { "cache-control": "no-store, no-cache, max-age=0" })
  );
}

function renderShell(c, ctx) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  // 全内联形态：无 assets URL、无 token 传递、无宿主缓存问题。
  // 面板代码（panel.js/panel.css/socket.io）在构建时经 minify-loader 压缩后读入。
  // HTML 模板保持 JS 模板字符串（静态部分 ~430 字符，独立压缩收益 < 0.2KB，不值得拆）

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>远程</title>
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <style>${panelCss}</style>
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-theme="${escapeAttr(theme)}" data-surface="sidebar">
  <div id="root" data-surface="sidebar"></div>
  <script type="module">${inlineSocketIo()}</script>
  <script type="module">${panelJs}</script>
</body>
</html>`;
}

/**
 * socket.io-client ESM inlined into the shell document.
 *
 * A static `import "./socket.io.esm.min.js"` from panel.js would produce a
 * subresource request WITHOUT the iframe session query, which the host guard
 * rejects (it only accepts X-Hana-Plugin-Surface-Session header or the
 * pluginSurfaceSession query, neither of which subresource requests carry).
 * Inlining keeps the dependency inside the shell document (no extra request)
 * and the module scope stays isolated from panel.js.
 */
function inlineSocketIo() {
  const raw = socketIoSource;
  const exportIdx = raw.lastIndexOf("export{");
  if (exportIdx >= 0) {
    return `${raw.slice(0, exportIdx)}\nwindow.__hrdIo = xt;`;
  }
  return `${raw}\nwindow.__hrdIo = xt;`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
