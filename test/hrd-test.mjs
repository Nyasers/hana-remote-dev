// hrd-wake-test — hana-remote-dev 核心逻辑回归测试（零依赖，node 原生）
// 运行：npm test（node test/hrd-test.mjs）
// 覆盖：wake 信标、HRD 协议路由、会话日志模板/上限/归档、插件配置、事件日志、diff 明细
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

// 基于本文件位置推导 src 目录，不依赖部署机器的绝对路径（开源可移植）
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const u = (p) => pathToFileURL(path.join(SRC, p)).href;

let passed = 0;
let failed = 0;
let sectionName = "";
function section(name) {
  sectionName = name;
  console.log(`== ${name} ==`);
}
function check(name, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}  [${sectionName}]`);
  }
}

const wake = await import(u("lib/wake.js"));
const sessionLog = await import(u("lib/session-log.js"));
const pluginCfg = await import(u("lib/plugin-config.js"));
const { parseHrdUri, resolveSessionDetail, guideIndex, guideSection, parseGuideSections } = await import(u("tools/hrd.js"));

// ---------- deferred 唤醒（宿主原生任务终态投递） ----------
section("deferred 唤醒（register/resolve/fail）");
{
  const calls = [];
  const bus = { request: async (type, payload) => { calls.push({ type, payload }); return { ok: true }; } };
  const log = { info() {}, warn() {} };

  check("register 默认 trigger_parent_turn（完成唤醒）",
    (await wake.registerDeferredWake({ bus, sessionPath: "/s/x", taskId: "op_1", label: "cmd", log })) === true &&
    calls[0].type === "deferred:register" && calls[0].payload.meta.deliveryIntent === "trigger_parent_turn");
  check("register 带 notifyAgentOnFailure（失败必唤醒）", calls[0].payload.meta.notifyAgentOnFailure === true);
  check("register wakeOnExit=false → notify_ui_only（只记录）",
    (await wake.registerDeferredWake({ bus, sessionPath: "/s/x", taskId: "op_1b", label: "c", wakeOnExit: false, log })) === true &&
    calls[1].payload.meta.deliveryIntent === "notify_ui_only");
  check("resolve 携带结构化结果",
    (await wake.resolveDeferredWake({ bus, taskId: "op_1", result: { status: "ok" }, log })) === true &&
    calls[2].type === "deferred:resolve" && calls[2].payload.taskId === "op_1");
  check("fail 携带错误",
    (await wake.failDeferredWake({ bus, taskId: "op_1", error: { message: "boom" }, log })) === true &&
    calls[3].type === "deferred:fail");
  check("缺 sessionPath 跳过 register（不投递）", (await wake.registerDeferredWake({ bus, sessionPath: "", taskId: "op_2", log })) === false);
  check("缺 bus 跳过（静默）", (await wake.resolveDeferredWake({ bus: null, taskId: "op_3", log })) === false);
}

// ---------- wakeOnSessionEnd（tty 会话结局 → deferred 终态） ----------
section("wakeOnSessionEnd（tty 结局 → deferred 终态）");
{
  const calls = [];
  const bus = { request: async (type, payload) => { calls.push({ type, payload }); return { ok: true }; } };
  const log = { info() {}, warn() {} };
  const base = { bus, log, sessionPath: "/s/x", taskId: "sess_1", label: "top" };

  check("正常 exit 长任务 → resolve（唤醒）",
    (await wake.wakeOnSessionEnd({ ...base, how: "exit", durationMs: 5000, exitCode: 0, sessionLogPath: "/logs/sess_1.md" })) === true &&
    calls[0].type === "deferred:register" && calls[0].payload.meta.deliveryIntent === "trigger_parent_turn" &&
    calls[1].type === "deferred:resolve");
  check("瞬时 exit（<3s）→ notify_ui_only（只记录不唤醒）",
    (await wake.wakeOnSessionEnd({ ...base, taskId: "sess_2", how: "exit", durationMs: 800 })) === true &&
    calls[2].payload.meta.deliveryIntent === "notify_ui_only" && calls[3].type === "deferred:resolve");
  check("wakeOnExit=false → 只记录",
    (await wake.wakeOnSessionEnd({ ...base, taskId: "sess_3", how: "exit", durationMs: 5000, wakeOnExit: false })) === true &&
    calls[4].payload.meta.deliveryIntent === "notify_ui_only");
  check("wakeOnExit=true 短任务也唤醒",
    (await wake.wakeOnSessionEnd({ ...base, taskId: "sess_4", how: "exit", durationMs: 500, wakeOnExit: true })) === true &&
    calls[6].payload.meta.deliveryIntent === "trigger_parent_turn");
  check("断连 → fail（必唤醒）",
    (await wake.wakeOnSessionEnd({ ...base, taskId: "sess_5", how: "disconnect", durationMs: 9000 })) === true &&
    calls[8].type === "deferred:register" && calls[9].type === "deferred:fail");
  check("会话结局 result 带会话引用与 tool 标识",
    calls[1].payload.result.session !== null && calls[1].payload.result.tool === "tty_session");
}

// ---------- parseHrdUri ----------
section("parseHrdUri（HRD 资源协议路由）");
{
  check("status", parseHrdUri("HRD://status")?.kind === "status");
  check("connections 列表", parseHrdUri("HRD://connections")?.kind === "connections");
  check("connection 单例", parseHrdUri("HRD://connection/my-server")?.kind === "connection" && parseHrdUri("HRD://connection/my-server")?.alias === "my-server");
  check("alias 保留大小写", parseHrdUri("HRD://connection/MyServer")?.alias === "MyServer");
  check("session id 保留大小写", parseHrdUri("HRD://session/AbC123")?.id === "AbC123");
  check("session-read 路由", parseHrdUri("HRD://session-read/AbC123")?.kind === "session-read" && parseHrdUri("HRD://session-read/AbC123")?.id === "AbC123");
  check("POST connect", parseHrdUri("HRD://connection/my-server", "POST", { action: "connect" })?.kind === "connection-action");
  check("PUT 编辑", parseHrdUri("HRD://connection/my-server", "PUT")?.kind === "connection-edit");
  check("DELETE 移除", parseHrdUri("HRD://connection/my-server", "DELETE")?.kind === "connection-delete");
  check("session 定位", parseHrdUri("HRD://session/abc123")?.kind === "session" && parseHrdUri("HRD://session/abc123")?.id === "abc123");
  check("detail 已移除（返回 null）", parseHrdUri("HRD://session/abc123/detail") === null);
  check("sessions 列表", parseHrdUri("HRD://sessions")?.kind === "sessions");
  check("小写协议名也解析", parseHrdUri("hrd://status")?.kind === "status");
  check("非法 URI 返回 null", parseHrdUri("HRD://sessions/abc.md") === null && parseHrdUri("http://x") === null && parseHrdUri("") === null);
  check("缺省 method 一律 GET（body.action 不推断）", parseHrdUri("HRD://connection/my-server", undefined, { action: "connect" })?.kind === "connection");
  check("action=save 路由（创建配置）", parseHrdUri("HRD://connection/my-server", "POST", { action: "save" })?.kind === "connection-action" && parseHrdUri("HRD://connection/my-server", "POST", { action: "save" })?.action === "save");
  check("guide 根（索引）", parseHrdUri("HRD://guide")?.kind === "guide" && parseHrdUri("HRD://guide")?.section === null);
  check("guide 章节（路径段）", parseHrdUri("HRD://guide/exec")?.kind === "guide" && parseHrdUri("HRD://guide/exec")?.section === "exec");
  check("guide 章节大小写不敏感", parseHrdUri("hrd://GUIDE/Exec")?.kind === "guide" && parseHrdUri("hrd://GUIDE/Exec")?.section === "Exec");
  check("guide 多余路径段返回 null", parseHrdUri("HRD://guide/x/y") === null);
  check("guide 带 query 视为非法（? 不进白名单）", parseHrdUri("HRD://guide?section=exec") === null);
}

// ---------- guide 手册（HRD://guide） ----------
section("guide 手册（索引 / 章节 / 未知章节）");
{
  const parsed = parseGuideSections("## A\n\nfirst line of A\nrest\n## B\nsecond");
  check("sections 解析：标题/摘要（跳过空行）/正文", parsed.length === 2 && parsed[0].name === "A" && parsed[0].summary === "first line of A" && parsed[1].name === "B" && parsed[1].summary === "second");
}

// ---------- resolveSessionDetail ----------
section("resolveSessionDetail（会话记录定位）");
{
  check("detail 白名单防穿越", resolveSessionDetail("..%2F..%2Fx", "D:/data/logs") === null && resolveSessionDetail("abc123", "D:/data/logs")?.replaceAll("\\", "/").endsWith("logs/sessions/abc123.md"));
  check("detail O(1) 解码定位", (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-detail-"));
    const sid = `${Date.now().toString(36)}xyz`;
    const t = sessionLog.sessionIdTime(sid);
    const rel = sessionLog.sessionFileName(sid, t);
    const p = path.join(dir, "sessions", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x", "utf8");
    const hit = resolveSessionDetail(sid, dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return hit?.replaceAll("\\", "/").endsWith(rel.replaceAll("\\", "/"));
  })());
  check("detail 兜底扫描日期目录", (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-detail2-"));
    const sid = "xyz123abc";
    const sub = path.join(dir, "sessions", "2026-08-11");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `${sid}.md`), "x", "utf8");
    const hit = resolveSessionDetail(sid, dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return hit?.replaceAll("\\", "/").endsWith(`sessions/2026-08-11/${sid}.md`);
  })());
}

// ---------- sessionFileName / sessionIdTime ----------
section("session 文件名与时间解码");
{
  check("sessionFileName 纯 id", /^\d{4}-\d{2}-\d{2}\/mso9pl7u3og\.md$/.test(sessionLog.sessionFileName("mso9pl7u3og", Date.now()).replaceAll("\\", "/")));
  check("sessionIdTime 前 8~9 位 base36", (() => {
    const t = 1723400000000;
    const id = t.toString(36) + "xyz";
    const back = sessionLog.sessionIdTime(id);
    return back !== null && Math.abs(back - t) < 1000;
  })());
  check("sessionIdTime 非法返回 null", sessionLog.sessionIdTime("abc") === null || sessionLog.sessionIdTime("!!!") === null);
}

// ---------- createSessionLogger ----------
section("createSessionLogger（会话记录统一模板）");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-log-"));
  const sid = "msoabc123";
  const lg = sessionLog.createSessionLogger({ dir, sessionId: sid, kind: "tty", command: "tail -f", connLabel: "demo", startedAt: new Date("2026-08-11T00:00:00Z") });
  lg.appendOutput("line1\n");
  lg.appendOutput("line2\n");
  lg.finalize({ how: "exit", exitCode: 0, durationMs: 5000, startedAt: new Date("2026-08-11T00:00:00Z"), endedAt: new Date("2026-08-11T00:00:05Z"), outputBytes: 10 });
  const p = lg.filePath;
  const txt = fs.readFileSync(p, "utf8");
  check("统一模板标题", txt.includes("# HRD 会话记录：msoabc123"));
  check("类型行 tty", txt.includes("类型: tty（交互会话）"));
  check("终端记录段落", txt.includes("## 终端记录") && txt.includes("line1\nline2"));
  check("结局段落", txt.includes("## 结局") && txt.includes("exit 0"));
  check("finalize 后不再写入", (() => {
    lg.appendOutput("after-close");
    lg.finalize({ how: "exit", exitCode: 0 });
    const t2 = fs.readFileSync(p, "utf8");
    return !t2.includes("after-close");
  })());
  fs.rmSync(dir, { recursive: true, force: true });

  // exec 类型行 + timeout howText 覆盖
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-log2-"));
  const lg2 = sessionLog.createSessionLogger({ dir: dir2, sessionId: "exec123xyz", kind: "exec", command: "sleep 60", connLabel: "demo", startedAt: new Date("2026-08-11T00:00:00Z") });
  lg2.appendOutput("part1\n");
  lg2.finalize({ how: "exit", howText: "timeout（超过 30s 未完成）", exitCode: null, durationMs: 30000, startedAt: new Date("2026-08-11T00:00:00Z"), endedAt: new Date("2026-08-11T00:00:30Z"), outputBytes: 12 });
  const p2 = lg2.filePath;
  const txt2 = fs.readFileSync(p2, "utf8");
  check("exec 类型行", txt2.includes("类型: exec（一次性命令）"));
  check("timeout howText 覆盖结局", txt2.includes("timeout（超过 30s 未完成）"));
  fs.rmSync(dir2, { recursive: true, force: true });
}

// ---------- ANSI 清理 ----------
section("ANSI 清理");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-ansi-"));
  const lg = sessionLog.createSessionLogger({ dir, sessionId: "ansitest01", kind: "tty", command: "ls", connLabel: "demo", startedAt: new Date() });
  lg.appendOutput("\x1b[31mred\x1b[0m plain\n");
  lg.finalize({ how: "exit", exitCode: 0 });
  const p = lg.filePath;
  const txt = fs.readFileSync(p, "utf8");
  check("ANSI 序列移除", !txt.includes("\x1b[") && txt.includes("red plain"));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- cleanupSessionLogs ----------
section("cleanupSessionLogs（昨日归档 + 空间兜底 + 活跃保护）");
{
  const day = (n) => {
    const d = new Date(Date.now() - n * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const mk = (root, group, files) => {
    const g = path.join(root, "sessions", group);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(g, f)), { recursive: true });
      fs.writeFileSync(path.join(g, f), "x".repeat(500), "utf8");
    }
  };
  // 昨日归档：昨天及更早归档删除；今天保留
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-clean-"));
  mk(root, day(2), ["a.md", "b.md"]);
  mk(root, day(1), ["c.md"]);
  mk(root, day(0), ["d.md"]);
  sessionLog.cleanupSessionLogs(path.join(root, "sessions"), { maxBytes: 0 });
  check("昨日及更早归档删除", !fs.existsSync(path.join(root, "sessions", day(2))) && !fs.existsSync(path.join(root, "sessions", day(1))));
  check("今天保留", fs.existsSync(path.join(root, "sessions", day(0), "d.md")));
  check("归档就地生成 tar.gz", fs.readdirSync(path.join(root, "sessions")).some((f) => f.endsWith(".tar.gz")));
  // tar 读取侧：不解压列表 + 按需提取（直接定位昨日归档包）
  const gzPath = path.join(root, "sessions", `${day(1)}.tar.gz`);
  const entries = sessionLog.listTarGz(gzPath);
  check("列表含归档条目", entries.some((e) => e.name === `${day(1)}/c.md`));
  const hit = sessionLog.extractTarGz(gzPath, `${day(1)}/c.md`);
  check("按需提取内容一致", hit && hit.toString("utf8") === "x".repeat(500));
  check("提取不存在条目返回 null", sessionLog.extractTarGz(gzPath, `${day(1)}/nope.md`) === null);
  // 活跃引用保护：命中的组延迟归档，引用释放后归档
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-clean2-"));
  mk(root2, day(1), ["a.md"]);
  const activePath = path.join(root2, "sessions", day(1), "a.md");
  sessionLog.cleanupSessionLogs(path.join(root2, "sessions"), { maxBytes: 0, activePaths: new Set([activePath]) });
  check("活跃引用的目录不归档", fs.existsSync(activePath));
  sessionLog.cleanupSessionLogs(path.join(root2, "sessions"), { maxBytes: 0, activePaths: new Set() });
  check("引用释放后归档", !fs.existsSync(activePath));
  // 空间兜底：窗口内超限 → 归档最旧
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-clean3-"));
  const mk3 = (group, bytes) => {
    const g = path.join(root3, "sessions", group);
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, "x.md"), "x".repeat(bytes), "utf8");
  };
  mk3(day(1), 2000);
  mk3(day(0), 2000);
  sessionLog.cleanupSessionLogs(path.join(root3, "sessions"), { maxBytes: 3000, retentionDays: 0 });
  check("空间兜底归档最旧", !fs.existsSync(path.join(root3, "sessions", day(1))) && fs.existsSync(path.join(root3, "sessions", day(0), "x.md")));
  // 归档有界：tar.gz 超配额 → 删最旧
  const root4 = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-clean4-"));
  const gzDir = path.join(root4, "sessions");
  fs.mkdirSync(gzDir, { recursive: true });
  fs.writeFileSync(path.join(gzDir, "old.tar.gz"), "x".repeat(3000), "utf8");
  fs.writeFileSync(path.join(gzDir, "new.tar.gz"), "x".repeat(3000), "utf8");
  const oldT = new Date(Date.now() - 5 * 86400000);
  fs.utimesSync(path.join(gzDir, "old.tar.gz"), oldT, oldT);
  sessionLog.cleanupSessionLogs(gzDir, { maxBytes: 4000 });
  check("归档超配额删最旧", !fs.existsSync(path.join(gzDir, "old.tar.gz")) && fs.existsSync(path.join(gzDir, "new.tar.gz")));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
  fs.rmSync(root3, { recursive: true, force: true });
  fs.rmSync(root4, { recursive: true, force: true });
}

// ---------- plugin-config ----------
section("plugin-config（config.json 唯一源）");
{
  const dirCfg = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-cfg-"));
  const d2 = sessionLog.saveSessionLogConfig(dirCfg, { maxMB: 16, maxTotalMB: 0 });
  check("saveSessionLogConfig 生效", d2.maxMB === 16 && d2.maxTotalMB === 0);
  const d3 = sessionLog.loadSessionLogConfig(dirCfg);
  check("保存后读回一致", d3.maxMB === 16 && d3.maxTotalMB === 0);
  const pc = pluginCfg.loadPluginConfig(dirCfg);
  check("统一配置写入 config.json 且 idleTimeout 默认保留", fs.existsSync(path.join(dirCfg, "config.json")) && !fs.existsSync(path.join(dirCfg, "session-log.json")) && pc.idleTimeout === 300);
  const saved2 = pluginCfg.savePluginConfig(dirCfg, { idleTimeout: 600 });
  check("idleTimeout 可保存且不丢 sessionLog", saved2.idleTimeout === 600 && saved2.sessionLog.maxMB === 16);
  fs.writeFileSync(path.join(dirCfg, "config.json"), "{broken json", "utf8");
  const d4 = pluginCfg.loadPluginConfig(dirCfg);
  check("损坏配置回退默认", d4.sessionLog.maxMB === 8 && d4.sessionLog.maxTotalMB === 32 && d4.idleTimeout === 300);
  fs.rmSync(dirCfg, { recursive: true, force: true });
}

// ---------- describeProfileDiff ----------
section("describeProfileDiff（配置变更明细）");
{
  const prof = { name: "demo", host: "1.2.3.4", username: "alice", port: 22, proxyCommand: null };
  check("diff: 全字段变更", sessionLog.describeProfileDiff(prof, { host: "5.6.7.8", username: "bob", port: 2222, proxyCommand: "ssh jump", credentials: true }).join("; ") === "host: 1.2.3.4→5.6.7.8; username: alice→bob; port: 22→2222; proxyCommand: set; credentials: changed");
  check("diff: 同名不记", sessionLog.describeProfileDiff(prof, { host: "1.2.3.4" }).length === 0);
  check("diff: proxyCommand cleared", sessionLog.describeProfileDiff(prof, { proxyCommand: "" }).join("; ") === "proxyCommand: cleared");
}

// ---------- appendEventLog ----------
section("appendEventLog（统一事件流 jsonl + 上限）");
{
  const dirEvt = fs.mkdtempSync(path.join(os.tmpdir(), "hrd-log-evt-"));
  sessionLog.appendEventLog(dirEvt, { type: "connection:ok", ref: "demo", username: "hanako", host: "host", port: 22, connInstance: "c1" });
  sessionLog.appendEventLog(dirEvt, { type: "connection:disconnect", mode: "manual", ref: "demo", connInstance: "c1" });
  const evFiles = fs.readdirSync(path.join(dirEvt, "events"));
  check("事件流按日单文件", evFiles.length === 1 && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(evFiles[0]));
  const evt1 = fs.readFileSync(path.join(dirEvt, "events", evFiles[0]), "utf8");
  const lines1 = evt1.trim().split("\n");
  check("事件流追加两行合法 JSON", lines1.length === 2 && lines1.every((l) => JSON.parse(l).v === 1));
  const o1 = JSON.parse(lines1[0]);
  check("事件带 ts/type/字段", o1.ts && o1.type === "connection:ok" && o1.ref === "demo" && o1.connInstance === "c1");
  check("tsNow 本地 ISO 带时区毫秒", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(sessionLog.tsNow()));
  // 超过 2MB 后：标注一次，后续行不再写入
  fs.appendFileSync(path.join(dirEvt, "events", evFiles[0]), "x".repeat(2 * 1024 * 1024), "utf8");
  sessionLog.appendEventLog(dirEvt, { type: "op", opId: "h_after_cap" });
  sessionLog.appendEventLog(dirEvt, { type: "op", opId: "h_after_cap_2" });
  const evt2 = fs.readFileSync(path.join(dirEvt, "events", evFiles[0]), "utf8");
  const anno = (evt2.match(/log:truncated/g) || []).length;
  check("2MB 上限标注一次", anno === 1);
  check("超限后不再写入", !evt2.includes("h_after_cap") && !evt2.includes("h_after_cap_2"));
  // 连接/配置/操作同流单文件（type 分流）
  sessionLog.appendEventLog(dirEvt, { type: "config:set", maxMB: 8 });
  check("同流单文件 type 分流", fs.readdirSync(path.join(dirEvt, "events")).length === 1);
  fs.rmSync(dirEvt, { recursive: true, force: true });
}

// ---------- 汇总 ----------
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
