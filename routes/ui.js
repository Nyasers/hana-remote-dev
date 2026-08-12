// routes/ui.js — 壳（永不更新）：经 index.js 的 loadBundle() 读盘执行最新 index.cjs。
import { loadBundle } from "../index.js";

export default loadBundle().uiRoutes;
