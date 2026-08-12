/**
 * 插件统一配置（dataDir/config.json）——面板为唯一入口：
 * 不使用宿主 config 系统（manifest 无 config 键，代码也不读 ctx.config）。
 *
 * 结构：
 * {
 *   "idleTimeout": 300   // 连接空闲自动回收秒数
 * }
 * 日志不设空间限制：时间归档为主策略（按天不可变、昨日自动打包），无需大小配置。
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PLUGIN_CFG = {
  idleTimeout: 300,
};

/** 读取插件配置（dataDir/config.json）；不存在/损坏/旧宿主结构回退默认。 */
export function loadPluginConfig(dir) {
  try {
    const p = path.join(dir, "config.json");
    if (!fs.existsSync(p)) return structuredClone(DEFAULT_PLUGIN_CFG);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const idle = Number(j.idleTimeout);
    return {
      idleTimeout: Number.isFinite(idle) && idle > 0 ? Math.floor(idle) : DEFAULT_PLUGIN_CFG.idleTimeout,
    };
  } catch {
    return structuredClone(DEFAULT_PLUGIN_CFG);
  }
}

/** 保存插件配置（原子写：临时文件 + rename）；未提及字段保留现值。 */
export function savePluginConfig(dir, cfg = {}) {
  const cur = loadPluginConfig(dir);
  const clean = {
    idleTimeout: Number.isFinite(cfg.idleTimeout) && cfg.idleTimeout > 0 ? Math.floor(cfg.idleTimeout) : cur.idleTimeout,
  };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "config.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf8");
  fs.renameSync(tmp, path.join(dir, "config.json"));
  return clean;
}
