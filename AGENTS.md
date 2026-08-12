# hana-remote-dev — Agent 操作手册

Hana 远程开发插件（SSH 连接 / 远程 exec / 文件 / 卡片渲染）。开源仓库：`Nyasers/hana-remote-dev`（远端分支 **master**）。

## 项目结构

- `src/tools/` — 9 个工具（exec_command / exec_wait / tty / file / read / write / edit / grep / find / hrd）
- `src/lib/` — 核心库（ssh-client 连接管理、operations 操作落盘、card-routes 卡片路由、socket-server Socket.IO 通道、connection-store 配置加密）
- `app/` — 卡片渲染资源（card.css / card.js / panel.js），运行时读盘不缓存，改样式即时生效
- `scripts/` — 工程脚本（version.mjs 发版、package.mjs 打包、verify-native.mjs 原生模块校验）
- `test/` — 单测（当前 65 例，`npm test`）
- `specs/` — SDD 规范档案（specs/ 不入库，验收后归档 evidence）

## 关键约定

- **连接标识**：唯一标识统一 HRD 家族内部 ID（已保存连接 = `HRD_xxx`，会话 = `HRD_xxx#session`，瞬态 = `HRD_x_<ts>_<n>`）；落盘/日志/操作记录始终写完整 HRD id，展示层才用 alias 短名
- **摘要规范**：成功分支 summary 为空（输出统一收卡片输出折叠区）、错误分支 summary 显示原因；两个语义例外——file 成功摘要（Copied/Uploaded/stat 信息）与命令本身一致保留、tty 状态摘要（会话结束/终止/断开）保留但输出尾部移进 output
- **卡片机制**：9 工具每张专属卡（iframe `/card/op?opId=xxx`）；状态文案运行时直读宿主 locale（`{name}` → Agent 名）；命令输出收卡片详情折叠区，对话主区只显示命令；deferred 机制 bus 优先 ctx.bus、register 先于 resolve/fail、失败路径 notifyAgentOnFailure
- **exec_command content**：返回命令 + 完整输出（Agent 自动化可直接拿到 stdout；超长 16KB 头尾各 8KB 截断），完整内容仍在卡片输出区
- **主题**：卡片 iframe 靠 `hana-theme` + `hana-css` 双通道注入主题；宿主 `theme.css?theme=auto` 返回空，card.css 已内置 auto/无注入时按系统深浅自适应的兜底变量块

## 发布流程（日常发版）

详见 README「开发 → 发布流程」。速查：

```bash
git status --short          # 0. 工作区必须干净（version.mjs 强制）
npm test                    # 1. 回归
npm run build               # 2. 构建
npm run version -- patch    # 3. bump + package + commit + tag
git push origin master      # 4. 主分支
git push origin vX.Y.Z      # 5. 显式单 tag（bulk --tags 被安全策略拦截）
gh run watch <run-id> --repo Nyasers/hana-remote-dev --exit-status   # 6. CI 三平台
gh release download vX.Y.Z --repo Nyasers/hana-remote-dev --pattern "hana-remote-dev-*-Windows-x64.zip*" --clobber  # 7. 下载 win 资产
# 8. SHA256 校验 → stage 交付
```

硬约束：

- 宿主安装 zip 后必须**重载插件或重启宿主**（文件覆盖 ≠ 实例重载，否则跑的仍是内存旧 bundle）
- 命令中不得内联凭据（curl -u / export TOKEN）；删除连接配置必须先向用户确认
- 版本单一事实源 = package.json；版本号只能向上，不能回退
- 正式安装资产一律走 CI release（zip 与本地 dist 有行尾符/注释字节差异，代码一致）
- CI action 保持 node24 运行时（upload-artifact@v6 / download-artifact@v8），避免 GitHub 强制迁移告警

## 排障速记

- 卡片「主题跟随一半、深色可见度低」→ 先查 iframe 的 `hana-theme` 参数与宿主实际主题是否一致，再查 theme.css 注入是否成功（`theme=auto` 会返回空）
- 落盘 connId 出现 alias/旧格式 `conn_N` → wrapper 兜底解析（connectionStore.get(aliasOrId) → profile.id），查 buildHistoryEntry
- CI 排队等托管 runner 是正常现象（queue → in_progress 后约 3-5 分钟完成）
