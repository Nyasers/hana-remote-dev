// 临时验证：operations 落盘即腾内存（完成态不驻内存，查询全走磁盘）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../src/lib/operations.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-ops-"));

// 1. 注入目录并记录两条（一条带 opRef，一条不带；间隔模拟先后）
mod.setOperationLogDir(tmp);
const hid1 = mod.recordHistory({
  tool: "exec_command", label: "uptime", connId: "Home", connInstance: "conn_3",
  agentName: "Hanako", status: "ok", durationMs: 927, exitCode: 0,
  summary: "", output: " 13:01:24 up 10 days\n",
  opRef: "op_first_1",
});
await new Promise((r) => setTimeout(r, 10)); // 错开毫秒，验证倒序
const hid2 = mod.recordHistory({
  tool: "ls", label: "Home:/home/nyaser", connId: "Home",
  agentName: "Hanako", status: "ok", durationMs: 1416, exitCode: 0,
  summary: "", output: "total 100\ndrwxr-xr-x 2 nyaser nyaser 4096 Aug 12 .\n",
});
console.log("recorded:", hid1, hid2);

// 2. 内存腾空验证：__G 不再持有 history 数组（完成态不驻内存）
console.log("__G keys (expect no history):", Object.keys(globalThis.__hrd_ops_state));

// 3. 磁盘文件检查
const d = new Date();
const dateDir = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const opsDir = path.join(tmp, "ops", dateDir);
console.log("disk files:", fs.readdirSync(opsDir));

// 4. 直接读盘（模拟任何时刻查询，无需内存）
const g1 = mod.getHistory(hid1);
const g2 = mod.getHistory("op_first_1");
console.log("getHistory(h):", g1 && { label: g1.label, status: g1.status, agentName: g1.agentName, outputLen: g1.output.length, connInstance: g1.connInstance });
console.log("getHistory(opRef):", g2 && { opId: g2.opId, opRef: g2.opRef });

// 5. listHistory 磁盘倒序（新的在前，且无 op_ 副本重复）
const list = mod.listHistory();
console.log("listHistory:", list.map((e) => e.label), "count:", list.length);

// 6. updateHistory 读盘改盘
const patchOk = mod.updateHistory(hid2, { status: "interrupted", reason: "lost", durationMs: 5000, summary: "会话中断" });
const g3 = mod.getHistory(hid2);
console.log("updateHistory ok:", patchOk, "->", g3 && { status: g3.status, reason: g3.reason });

// 7. 未知 id
console.log("unknown:", mod.getHistory("h_nonexistent"), "| list empty dir:", mod.listHistory().length >= 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS");
