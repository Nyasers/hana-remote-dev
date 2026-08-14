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

> 以下为完整可执行步骤，Agent 直接照此执行，不需要查 README。

### 0. 前置：工作区必须干净

```powershell
cd E:\Hanako\workspace\Projects\plugins\hana-remote-dev
git status --short
```

- 有未提交改动：先 commit 源码改动（`npm run version` 的 version.mjs 会强制校验，脏工作区直接拒绝执行）。
- 已发布版本的 tag 若与代码不匹配（如改了源码想补发）需先确认是否走新版本号，不要回退版本。

### 1. 回归 + 构建

```powershell
fnm env --use-on-cd 2>&1 | Out-String | Invoke-Expression   # 项目需要 node 24
npm test              # 65 例单测；失败先修，不跳过
npm run build         # Rspack → dist/（terser 压缩，dist/ 不入库）
```

### 2. bump 版本（自动 package + commit + tag）

```powershell
npm run version -- patch    # 或 minor；patch 用于修 bug，minor 用于功能
```

- 自动完成：版本号 bump（单一事实源 = package.json）→ 打包 zip + sha256 到 releases/ → commit + tag vX.Y.Z。
- 确认输出中的新版本号与 tag 名。

### 3. 推送（两步，顺序固定）

```powershell
git push origin master      # 先主分支
git push origin vX.Y.Z      # 再显式单 tag 推送
```

- tag 必须单独推：bulk `--tags` 会被 GitHub 安全策略拦截。
- tag 推送触发 CI 多平台构建（release workflow，tag 触发）。

### 4. 等 CI + 下载资产

```powershell
$run = gh run list --repo Nyasers/hana-remote-dev --limit 1 --json databaseId -q ".[0].databaseId"
gh run watch $run --repo Nyasers/hana-remote-dev --exit-status
```

- 排队等托管 runner 是正常现象（queued → in_progress 后约 3-5 分钟完成）。
- 失败：`gh run view <run-id> --repo Nyasers/hana-remote-dev --log` 查日志；修复后重新 `git push origin vX.Y.Z`（先删远端 tag 或直接重推）。

```powershell
cd releases
gh release download vX.Y.Z --repo Nyasers/hana-remote-dev --pattern "hana-remote-dev-*-Windows-x64.zip*" --clobber
```

### 5. 校验 + 交付

```powershell
$expected = (Get-Content hana-remote-dev-<ver>-Windows-x64.zip.sha256 -Raw).Trim().Split(" ")[0]
$actual = (Get-FileHash hana-remote-dev-<ver>-Windows-x64.zip -Algorithm SHA256).Hash
# expected -eq actual 通过后：
stage_files → zip 交付给姐姐
```

- 正式安装资产一律走 CI release（zip 与本地 dist 有行尾符/注释字节差异，代码一致）。
- 交付时明确提醒：**宿主安装 zip 后必须重载插件或重启宿主**（文件覆盖 ≠ 插件实例重载，否则运行的仍是内存旧 bundle）。

### 6. 收尾

- 全工具回归（对已保存连接跑一遍 9 工具 + 错误分支，核对：connId 全 HRD id、成功 summary 空、output 有内容、op_/h_ 双写成对一致）。
- 更新版本轨迹记忆与 SPECS.md 归档（SDD：验收后 evidence.md 落盘 + SPECS.md Active 归档）。

### 硬约束

- 命令中不得内联凭据（curl -u / export TOKEN）；删除连接配置必须先向用户确认。
- 版本号只能向上，不能回退；版本单一事实源 = package.json。
- CI action 保持 node24 运行时（upload-artifact@v6 / download-artifact@v8），避免 GitHub 强制迁移告警。

## 排障速记

- 卡片「主题跟随一半、深色可见度低」→ 先查 iframe 的 `hana-theme` 参数与宿主实际主题是否一致，再查 theme.css 注入是否成功（`theme=auto` 会返回空）
- 落盘 connId 出现 alias/旧格式 `conn_N` → wrapper 兜底解析（connectionStore.get(aliasOrId) → profile.id），查 buildHistoryEntry
- CI 排队等托管 runner 是正常现象（queue → in_progress 后约 3-5 分钟完成）
