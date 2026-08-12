// verify-stream.mjs — stream 模式核心链路验证：
// startOperation → running 快照 → 增量输出 → 完成落盘（opRef 双写）→ 终局快照
//（wait 只是循环调 readOperation，核心即此；卡片 /ops/status 同源）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../src/lib/operations.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-stream-"));
mod.setOperationLogDir(tmp);

let fail = 0;
function check(name, cond) {
  console.log((cond ? "ok  " : "FAIL") + "  " + name);
  if (!cond) fail++;
}

// 1. startOperation（stream 场景：exec_command stream:true）
const opId = mod.startOperation({
  connId: "Home", connInstance: "conn_1", agentName: "Hanako",
  kind: "exec", label: "sleep 3 && echo done",
});

// 2. running 快照（卡片首帧）
let snap = mod.readOperation(opId);
check("running 首帧", snap && snap.status === "running" && snap.kind === "exec" && snap.agentName === "Hanako" && snap.output === "" && snap.label === "sleep 3 && echo done");

// 3. 增量输出（appendOpOutput 逐 chunk）
mod.appendOpOutput(opId, "line1\n");
mod.appendOpOutput(opId, "line2\n");
snap = mod.readOperation(opId);
check("增量输出累积", snap.status === "running" && snap.output === "line1\nline2\n");
check("running 耗时递增", snap.durationMs >= 0 && typeof snap.durationMs === "number");

// 4. 终局：recordHistory（opRef 双写）→ endOperation
const hid = mod.recordHistory({
  tool: "exec_command", label: "sleep 3 && echo done", connId: "Home", connInstance: "conn_1",
  agentName: "Hanako", status: "ok", startedAt: new Date().toISOString(),
  durationMs: 3120, exitCode: 0, summary: "", output: "── stdout ──\ndone\n\nExit code: 0", opRef: opId,
});
mod.endOperation(opId);

// 5. 终局快照：in-flight 已释放 → 磁盘兜底；op_xxx 与 h_xxx 都能查到
snap = mod.readOperation(opId);
check("终局经 opId 可查（磁盘双写）", snap && snap.status === "ok" && snap.output.includes("done") && snap.exitCode === 0);
const hsnap = mod.readOperation(hid);
check("终局经 hid 可查", hsnap && hsnap.opId === hid && hsnap.connInstance === "conn_1");

// 6. 磁盘双写文件
const d = new Date();
const dateDir = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const files = fs.readdirSync(path.join(tmp, "ops", dateDir)).sort();
check("双写文件齐全", files.includes(`${hid}.json`) && files.includes(`${opId}.json`));

// 7. 未知 id → null
check("未知 id → null", mod.readOperation("op_nonexistent") === null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? "\nPASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
