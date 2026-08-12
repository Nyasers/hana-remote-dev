// agent-name.js — 从工具调用 ctx 解析当前会话的 Agent 显示名
//
// 宿主渲染工具状态文案（"📂 {name} 正在看文件夹里有什么"）时 {name} 替换为
// 执行会话的 Agent 名。插件卡片（自身 iframe）没有该注入上下文，但工具调用
// ctx 带 sessionPath（形如 <hostRoot>agents/<agentId>/sessions/xxx.jsonl 或
// <hostRoot>agents/<agentId>/subagent-sessions/direct/xxx.jsonl），可从路径
// 切出宿主根 + agentId，再读 agents/<agentId>/config.yaml 的 agent.name。
//
// 解析失败返回 null（调用方回退 "HRD"）。缓存按 sessionPath 键（同一会话内
// 重复解析零 IO）。

import fs from "node:fs";
import path from "node:path";

const cache = new Map();

export function resolveAgentName(ctx) {
  const sp = ctx?.sessionPath || ctx?.sessionRef?.sessionPath;
  if (!sp || typeof sp !== "string") return null;
  if (cache.has(sp)) return cache.get(sp);
  const name = readAgentName(sp);
  cache.set(sp, name);
  return name;
}

function readAgentName(sessionPath) {
  const m = sessionPath.match(/(?:^|[\\/])agents[\\/]([^\\/]+)[\\/]/);
  if (!m) return null;
  const hostRoot = sessionPath.slice(0, m.index + 1);
  const agentId = m[1];
  try {
    const cfg = path.join(hostRoot, "agents", agentId, "config.yaml");
    const txt = fs.readFileSync(cfg, "utf8");
    // YAML：顶层 `agent:` 下的 `name:`（其他段落的 name 不匹配）
    const nm = txt.match(/^agent:\s*\r?\n\s*name:\s*(.+?)\s*$/m);
    return nm ? nm[1] : agentId;
  } catch {
    return agentId;
  }
}
