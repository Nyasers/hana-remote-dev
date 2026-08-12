/**
 * 插件统一配置（dataDir/config.json）——面板为唯一入口（姐姐定稿）：
 * 不使用宿主 config 系统（manifest 无 config 键，代码也不读 ctx.config）。
 *
 * 结构：
 * {
 *   "sessionLog": { "maxMB": 8, "maxTotalMB": 32 },  // 会话日志空间两限（0 = 不设限）
 *   "idleTimeout": 300                                // 连接空闲自动回收秒数
 * }
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PLUGIN_CFG = {
  sessionLog: { maxMB: 8, maxTotalMB: 32 },
  idleTimeout: 300,
};

const clamp = (v, d) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);

/** 读取插件配置（dataDir/config.json）；不存在/损坏/旧宿主结构回退默认。 */
export function loadPluginConfig(dir) {
  try {
    const p = path.join(dir, "config.json");
    if (!fs.existsSync(p)) return structuredClone(DEFAULT_PLUGIN_CFG);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const sl = j.sessionLog && typeof j.sessionLog === "object" ? j.sessionLog : {};
    const idle = Number(j.idleTimeout);
    return {
      sessionLog: {
        maxMB: clamp(sl.maxMB, DEFAULT_PLUGIN_CFG.sessionLog.maxMB),
        maxTotalMB: clamp(sl.maxTotalMB, DEFAULT_PLUGIN_CFG.sessionLog.maxTotalMB),
      },
      idleTimeout: Number.isFinite(idle) && idle > 0 ? Math.floor(idle) : DEFAULT_PLUGIN_CFG.idleTimeout,
    };
  } catch {
    return structuredClone(DEFAULT_PLUGIN_CFG);
  }
}

/** 保存插件配置（原子写：临时文件 + rename）；未提及字段保留现值。 */
export function savePluginConfig(dir, cfg = {}) {
  const cur = loadPluginConfig(dir);
  const sl = cfg.sessionLog ?? {};
  const clean = {
    sessionLog: {
      maxMB: clamp(sl.maxMB, cur.sessionLog.maxMB),
      maxTotalMB: clamp(sl.maxTotalMB, cur.sessionLog.maxTotalMB),
    },
    idleTimeout: Number.isFinite(cfg.idleTimeout) && cfg.idleTimeout > 0 ? Math.floor(cfg.idleTimeout) : cur.idleTimeout,
  };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "config.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf8");
  fs.renameSync(tmp, path.join(dir, "config.json"));
  return clean;
}
