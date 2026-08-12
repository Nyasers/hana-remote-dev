// version-sync.mjs — 版本同步：从 package.json 读取版本（单一事实源）→ 同步 manifest.json
// 独立可运行：手动改了 package.json 版本后，执行本脚本即可对齐 manifest.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = path.join(root, "package.json");
const manifestPath = path.join(root, "manifest.json");

function getVersionFromPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")).version;
  } catch (error) {
    console.error("读取 package.json 失败:", error);
    process.exit(1);
  }
}

function updateManifest(version) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.version = version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    console.log(`已更新 manifest.json 中的版本号为 ${version}`);
  } catch (error) {
    console.error("更新 manifest.json 失败:", error);
    process.exit(1);
  }
}

const version = getVersionFromPackageJson();
console.log(`从 package.json 获取版本号: ${version}`);
updateManifest(version);
console.log("版本同步完成!");
