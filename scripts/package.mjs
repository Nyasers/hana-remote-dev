// package.mjs — 打包发布包：构建产物 → releases/<id>-<version>.zip + .sha256
// devDep 仅 archiver（zip 容器，久经考验）；sha256 用 node 内置 crypto。全平台可跑。
//
// 产物形态（zip 根 = 插件根）：index.js / manifest.json / README.md / native/ / routes/ / skills/
// 流程：npm run build（产物必须新鲜）→ 临时文件打 zip → rename 进 releases/（中断不留半成品）→ sha256
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ZipArchive } from "archiver"; // 8.x ESM 命名导出（npm 文档的 default import 是 README 笔误）
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const releases = path.join(root, "releases");

// ---------- 收集安装形态文件集 ----------
function collectDir(prefix, dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectDir(rel, abs, out);
    else if (entry.isFile()) out.push([rel, abs]);
  }
}

function collectFiles() {
  const files = [
    ["index.js", path.join(dist, "index.js")],
    ["manifest.json", path.join(root, "manifest.json")],
    ["README.md", path.join(root, "README.md")],
  ];
  for (const dir of ["native", "routes", "app"]) {
    const p = path.join(dist, dir);
    if (fs.existsSync(p)) collectDir(dir, p, files);
  }
  return files;
}

// ---------- 主流程 ----------
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (!manifest.id || !manifest.version) {
  console.error("manifest.json missing id/version; aborting");
  process.exit(1);
}
const { id, version } = manifest;

console.log("building dist…");
const build = spawnSync("npm run build", { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) {
  console.error("npm run build failed (exit " + build.status + "); aborting");
  process.exit(1);
}
if (!fs.existsSync(path.join(dist, "index.js"))) {
  console.error("dist is not built: no dist/index.js; aborting");
  process.exit(1);
}

const zipName = `${id}-${version}.zip`;
const zipPath = path.join(releases, zipName);
fs.mkdirSync(releases, { recursive: true });
const tmp = path.join(releases, `.${zipName}.tmp`); // 先写临时文件，rename 原子落位（中断不留半成品）

// archiver：stream 方式写 zip（entry 顺序 = append 顺序，zip 根 = 插件根）
const output = fs.createWriteStream(tmp);
const archive = new ZipArchive({ zlib: { level: 9 } });
const done = new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
});
archive.pipe(output);
try {
  for (const [name, abs] of collectFiles()) {
    if (!fs.existsSync(abs)) {
      console.error(`missing file for package: ${abs}; aborting`);
      process.exit(1);
    }
    archive.file(abs, { name });
  }
  await archive.finalize();
  await done;
  if (fs.existsSync(zipPath)) console.log(`overwriting existing package: ${zipName}`);
  fs.renameSync(tmp, zipPath);
} finally {
  // rename 失败（磁盘满等）也不留半成品 .tmp
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
}

const hash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
fs.writeFileSync(`${zipPath}.sha256`, hash);

console.log(`package created: ${zipPath}`);
console.log(`SHA256: ${hash}`);
