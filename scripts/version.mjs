// version.mjs — 版本更新一条龙：bump package.json → 同步 manifest（version-sync）→ npm install 同步 lock → 打包验证 → git commit + annotated tag
// 用法: node scripts/version.mjs patch | minor | major | <具体版本号>
//       node scripts/version.mjs patch --dry-run   预览将要执行的步骤（不落盘、不改 git）
// 前置: 工作区干净（未提交改动会拒绝执行，避免混入 release commit）
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const versionArg = args.find((a) => !a.startsWith("--"));

if (!versionArg) {
  console.error("请提供版本号参数，例如: patch, minor, major 或具体版本号");
  process.exit(1);
}

const packageJsonPath = path.join(root, "package.json");

function readPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch (error) {
    console.error("读取 package.json 失败:", error);
    process.exit(1);
  }
}

function writePackageJson(data) {
  try {
    fs.writeFileSync(packageJsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (error) {
    console.error("写入 package.json 失败:", error);
    process.exit(1);
  }
}

function calculateNewVersion(currentVersion, versionType) {
  if (versionType === "patch" || versionType === "minor" || versionType === "major") {
    const [major, minor, patch] = currentVersion.split(".").map(Number);
    if (versionType === "patch") return `${major}.${minor}.${patch + 1}`;
    if (versionType === "minor") return `${major}.${minor + 1}.0`;
    if (versionType === "major") return `${major + 1}.0.0`;
  }
  return versionType;
}

function runCommand(command, description) {
  console.log(`\n🚀 ${description}...`);
  if (dryRun) {
    console.log(`  [dry-run] ${command}`);
    return;
  }
  try {
    execSync(command, { stdio: "inherit", cwd: root, shell: true });
    console.log(`✅ ${description} 完成`);
  } catch (error) {
    console.error(`❌ ${description} 失败:`, error.message);
    process.exit(1);
  }
}

function main() {
  const packageJson = readPackageJson();
  const currentVersion = packageJson.version;
  const newVersion = calculateNewVersion(currentVersion, versionArg);

  console.log(`当前版本: ${currentVersion}`);
  console.log(`新版本: ${newVersion}${dryRun ? "（dry-run，不落盘）" : ""}`);

  if (newVersion === currentVersion) {
    console.error("版本号未变化，无需更新");
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error(`无效版本号: ${newVersion}（应为 patch/minor/major 或 x.y.z）`);
    process.exit(1);
  }

  // 工作区必须干净（bump 自带 commit，不允许混入其他改动）
  const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
  if (dirty) {
    console.error(`工作区有未提交改动，先处理再执行：\n${dirty}`);
    process.exit(1);
  }

  // 1) 更新 package.json
  if (!dryRun) {
    packageJson.version = newVersion;
    writePackageJson(packageJson);
  }
  console.log(`✅ 已更新 package.json 中的版本号为 ${newVersion}${dryRun ? "（dry-run）" : ""}`);

  // 2) 同步 manifest.json（version-sync，package.json 为单一事实源）
  runCommand("node scripts/version-sync.mjs", "同步 manifest.json 版本");

  // 3) lock 同步（npm 权威，根版本跟随 package.json）
  runCommand("npm install", "同步 lock 根版本");

  // 4) 打包验证（内部自动 build + copy-native + sha256，产物 releases/）
  runCommand("npm run package", "执行打包验证");

  // 5) 提交更改并创建 annotated tag
  runCommand("git add .", "添加所有更改到暂存区");
  runCommand(`git commit -m "v${newVersion}"`, "提交更改");
  runCommand(`git tag -a v${newVersion} -m "v${newVersion}"`, `创建标签 v${newVersion}`);

  console.log(`\n🎉 版本更新完成! 新版本: ${newVersion}`);
  console.log(`提示: 运行 git push && git push --tags 来推送更改和标签（tag 触发 CI 多平台构建）`);
}

main();
