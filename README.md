# Hana Remote Development (hana-remote-dev)

让 Hanako 能通过 SSH 连接远程服务器：读写远程文件、执行远程命令、维持交互式会话。连接按需建立、用完即放，配置与日志全本地化。

## 功能

- **连接管理**：按需建立（工具调用时从加密库取凭据自动建连），事件驱动释放（exec/sftp 结束、tty 会话关闭即断），空闲扫描兜底回收；面板提供强制断开
- **远程文件**：read / write / edit / ls / grep / find / file（stat + copy，本地↔远程、远程↔远程）
- **远程执行**：exec_command（一次性命令，自动落会话记录）/ tty 交互会话（write_stdin 喂输入，结局自动唤醒 Agent）
- **配置管理**：`config.json` 唯一配置源（面板唯一写入口），凭据加密落库，事件审计（connection/config 按日）
- **日志体系**：会话记录（tty 与 exec 同构模板，增量落盘）+ 连接/配置事件按日滚动 + 超限 tar.gz 归档

## 安装

从 [Releases](https://github.com/Nyasers/hana-remote-dev/releases/latest) 下载对应平台的安装包（zip 附 .sha256 校验和，建议核对后安装）：

| 平台 | 文件名 |
|---|---|
| Windows x64 | `hana-remote-dev-<version>-Windows-x64.zip` |
| Linux x64 | `hana-remote-dev-<version>-Linux-x64.zip` |
| macOS（Apple Silicon） | `hana-remote-dev-<version>-macOS-arm64.zip` |

1. 打开 Hana **设置 → 插件**，将 zip 拖入安装区（或点击选择文件），宿主自动校验并安装
2. 插件声明 `full-access`，首次使用前在插件管理中开启**「允许全权插件」**并刷新

> **macOS Intel 用户**：暂不发布 Intel 原生包。可直接安装 arm64 包（原生加速模块加载失败时自动回退纯 JS 实现，功能完整、性能略降），或按下方「从源码构建」在本机产出 x64 原生包。

### 从源码构建

需 Node.js 24 环境（建议先 `npm ci` 安装依赖，trustedDependencies 已放行 ssh2/cpu-features 原生编译）：

```bash
npm install
npm run package   # 构建 → releases/hana-remote-dev-<version>.zip（附 .sha256）
```

## 使用

所有远程操作经 `hrd` 协议端点（method 必须显式传）：

```
# 首次录入配置（纯保存，不连接验证；凭据只出现一次，加密落库）
hrd(method="POST", uri="HRD://connection/my-server", body={action: "save", host, username, password})

# 执行命令（connectionId 必填，自动建连）
exec_command(connectionId: "my-server", command: "ls -la /var/log")

# 读写远程文件（路径带别名前缀）
read(path: "my-server:/var/log/syslog")
write(path: "my-server:/etc/nginx/conf.d/default.conf", content: "...")

# 交互式会话
exec_command(connectionId: "my-server", command: "bash -l", tty: true) → sessionId
write_stdin(sessionId, chars)
```

### 会话结束自动唤醒

tty 会话结束后，插件向 Agent 注入唤醒信标（`[Use tool: hana-remote-dev_hrd(method="GET", uri="HRD://session/<id>")]`），
Agent 据此拉取会话元数据与记录。判定优先级：

1. **显式意图**（推荐）：`exec_command(..., tty: true, wakeOnExit: true)` 必唤醒；`wakeOnExit: false` 必不唤醒
2. **默认兑底**：未声明时，正常 exit 且会话 ≥3s 才唤醒（瞬时交互不打扰）；异常/干预结局（disconnect/lost/killed）始终唤醒

宿主回合进行中（session_busy）时信标不丢弃：每 3s 重试，5 分钟窗口内注入成功即止，窗口耗尽留痕（`%TMP%\hrd-wake.log`）。

## 配置

`dataDir/config.json`（面板为唯一写入口）：

```json
{
  "sessionLog": { "maxMB": 8, "maxTotalMB": 32 },
  "idleTimeout": 300
}
```

- `sessionLog.maxMB` / `maxTotalMB`：会话日志单文件/总量上限（0 = 不设限），超限归档最旧日期组为 tar.gz
- `idleTimeout`：空闲兜底回收秒数（正常路径 exec/会话结束已即时释放）

## 日志

```
logs/
├── session/<yyyy-mm-dd>/<id>.md   ← 会话记录（tty / exec 统一模板，增量落盘）
├── connection/<yyyy-mm-dd>.md     ← 连接事件（connect ok/fail/timeout、disconnect manual/auto）
├── config/<yyyy-mm-dd>.md         ← 配置事件（connection:add/update/remove、config:set）
└── archive/<组名>.tar.gz          ← 超限归档（可解压还原）
```

凭据纪律：事件日志与会话记录绝不落明文凭据；命令原文忠实落盘，勿在命令中内联凭据。

## 开发

```bash
npm run build   # rspack 构建 → dist/
npm run package # 打包 → releases/hana-remote-dev-<version>.zip + .sha256
```
