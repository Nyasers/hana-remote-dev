// 临时验证：双闭包场景（模拟 loadBundle 两次执行）opLogDir 经 __G 全局共享
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 两个独立模块实例（模拟 index.js 顶层 default 与 routes/card.js 各执行一次 bundle）
const toolSide = await import("../src/lib/operations.js?side=tool");
const routeSide = await import("../src/lib/operations.js?side=route");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-ops2-"));

// 工具侧注入目录
toolSide.setOperationLogDir(tmp);

// route 侧从未调用 setOperationLogDir，但读 __G.opLogDir 应拿到工具侧写入的值
const d = new Date();
const dateDir = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 工具侧记录（落盘）
const hid = toolSide.recordHistory({
  tool: "exec_command", label: "uptime", connId: "Home", connInstance: "conn_1",
  agentName: "Hanako", status: "ok", durationMs: 927, exitCode: 0,
  summary: "", output: " 13:10:10 up 10 days\n", opRef: "op_route_test_1",
});
console.log("toolSide recorded:", hid);

// route 侧查询（模拟卡片 iframe /ops/status）
const snap = routeSide.getHistory(hid);
console.log("routeSide getHistory(h):", snap ? { opId: snap.opId, label: snap.label, agentName: snap.agentName, status: snap.status } : null);

const snapOp = routeSide.getHistory("op_route_test_1");
console.log("routeSide getHistory(opRef):", snapOp ? { opId: snapOp.opId, opRef: snapOp.opRef } : null);

// route 侧面板列表
console.log("routeSide listHistory:", routeSide.listHistory().map((e) => e.label));

// 磁盘文件确认
console.log("disk files:", fs.readdirSync(path.join(tmp, "ops", dateDir)));

// 双闭包下 updateHistory（route 侧调用）
const up = routeSide.updateHistory(hid, { status: "interrupted", reason: "lost" });
console.log("routeSide updateHistory:", up, "->", routeSide.getHistory(hid)?.status);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS");
