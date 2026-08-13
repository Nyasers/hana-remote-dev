// verify-native.mjs <platform> — 校验 dist/app/native/*.node 是目标平台二进制（fail-closed）
// 用途: CI 构建后自检，防止 copy-native 静默 skip / 平台错配 → "以为加速了其实没有"
// 用法: node scripts/verify-native.mjs Windows-x64 | Linux-x64 | macOS-x64 | macOS-arm64
// 魔数: PE = "MZ"; ELF = \x7fELF; Mach-O = CF FA ED FE（小端 MH_MAGIC_64）+ cputype 区分 x64/arm64
// platform 显式传参（对齐宿主 verify-seed-kit 的教训：不依赖 process.platform/process.arch 默认值）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const platform = process.argv[2];

const EXPECT = {
  "Windows-x64": { magic: [0x4d, 0x5a], label: "PE (MZ)" },
  "Linux-x64": { magic: [0x7f, 0x45, 0x4c, 0x46], label: "ELF" },
  "macOS-x64": { magic: [0xcf, 0xfa, 0xed, 0xfe], cputype: 0x01000007, label: "Mach-O x86_64" },
  "macOS-arm64": { magic: [0xcf, 0xfa, 0xed, 0xfe], cputype: 0x0100000c, label: "Mach-O arm64" },
};

if (!EXPECT[platform]) {
  console.error(`未知平台: ${platform}（支持 Windows-x64 / Linux-x64 / macOS-x64 / macOS-arm64）`);
  process.exit(1);
}

const exp = EXPECT[platform];
const files = ["app/native/sshcrypto.node", "app/native/cpufeatures.node"].map((f) => path.join(root, "dist", f));

let ok = true;
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`❌ 缺失: ${f}（copy-native 未拷到，原生加速未生效）`);
    ok = false;
    continue;
  }
  const buf = fs.readFileSync(f);
  const head = [...buf.subarray(0, 4)];
  const magicOk = exp.magic.every((b, i) => head[i] === b);
  let cpuOk = true;
  if (exp.cputype) cpuOk = buf.readUInt32LE(4) === exp.cputype;
  if (magicOk && cpuOk) {
    console.log(`✅ ${path.basename(f)}: ${exp.label}`);
  } else {
    console.error(
      `❌ ${path.basename(f)}: 魔数 ${head.map((b) => b.toString(16).padStart(2, "0")).join(" ")} ≠ ${exp.label}` +
        (exp.cputype ? `（cputype=0x${buf.readUInt32LE(4).toString(16)}）` : "")
    );
    ok = false;
  }
}

if (!ok) {
  console.error(`native 校验失败（${platform}）`);
  process.exit(1);
}
console.log(`native 校验通过（${platform}）`);
