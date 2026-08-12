/**
 * HRD 使用手册（单一事实源）：Agent 经 hrd 工具按需读取
 * （HRD://guide 索引 / HRD://guide/<章节> 详情），随代码版本走。
 * 用模板字符串承载（node 源码直跑与 rspack 打包均兼容，
 * 不引入 .md 的 ESM 扩展名问题）。内容无反引号与 ${}，可安全内嵌。
 */
export const guideMarkdown = `# HRD Guide

## SECURITY
安全规则：凭据隔离、不内联凭据、删除前确认。

1. **别名是身份，凭据是事件**：配置用别名指代（如 my-server）；密码、私钥、passphrase 只在录入/修改时出现一次，之后任何输出不得再提及。
2. **凭据隔离**：插件不读 \`~/.ssh\`。用户指定密钥时，Agent 显式读取并传入；无凭据无法认证。
3. **删除前确认**：删除连接配置必须先向用户确认。
4. **命令原文落盘**：会话记录忠实保存命令与输出（增量 append-only），命令中不得内联凭据（如 \`curl -u user:pwd\`、\`export TOKEN=...\`）；需要带秘密时先 \`write\` 到远端脚本再执行。

## CONNECTION
连接模型：按需建立、事件驱动释放、首次录入流程。

**连接自动管理**：按需建立——工具调用时未连接会自动从加密库取凭据建连，无需预连接；用完即放（事件驱动：exec/sftp 结束、tty 会话关闭即断，无进行中工作与活跃会话时释放）；异常残留由空闲扫描兜底回收（\`idleTimeout\`，默认 300s）。连接上有活跃会话时不回收。\`exec_command\` 的 \`connectionId\` 必填（命令无路径挂前缀）。

**首次录入**：用户给 host/user → Agent 索要凭据（只此一次）→ \`hrd(method="POST", uri="HRD://connection/<alias>", body={action: "save", host, username, password...})\` 保存（凭据加密落库，纯保存不连接验证，主机离线也能录入；连接成功在首次使用时验证）→ 确认别名 → 之后以别名指代。

## PATH
路径寻址：别名:路径。

文件类工具统一用「别名:路径」：\`my-server:/etc/nginx/nginx.conf\`。前缀不匹配报错 \`unknown connection\`，不静默降级。裸路径为本地（仅 \`file\` 工具的 copy 消费）。

## PROTOCOL
HRD 资源协议表：status/connection/session/guide。

连接/配置与会话资源统一经 \`hrd\` 端点按 URI 访问（单数 = 实例，复数 = 集合，动词进 body）：

| 方法 | URI | 说明 |
|---|---|---|
| GET | \`HRD://status\` | 连接/会话/操作总览 |
| GET | \`HRD://connections\` | 连接配置列表 |
| GET | \`HRD://connection/<alias>\` | 单连接状态 |
| POST | \`HRD://connection/<alias>\` | \`body.action = connect | disconnect | save\`（method 必须显式传 POST，不做推断） |
| PUT | \`HRD://connection/<alias>\` | \`body\` = 编辑字段（host/username/port/凭据/alias） |
| DELETE | \`HRD://connection/<alias>\` | 移除配置（先向用户确认） |
| GET | \`HRD://session/<id>\` | 会话记录**位置** + 结局摘要（拿到位置后自行 read/grep 查询内容） |
| GET | \`HRD://sessions\` | 会话列表（活跃 + 历史） |
| GET | \`HRD://guide\` | 本手册索引；\`HRD://guide/<章节>\` 查详情 |

\`HRD://\` 是插件本地资源协议（映射到插件数据目录，非网络 URL），协议名大小写不敏感。**method 必须显式传**（GET/POST/PUT/DELETE，缺省视为 GET），不做 body 推断。**action=save**：保存新配置（首次录入），URI 里的 \`<alias>\` 即配置名，host/username/凭据等字段随 body 传入；**action=connect**：连接已保存的配置；**action=disconnect**：断开该配置的全部连接。

## EXEC
执行约定：exec_command / stream / tty 交互。

- \`exec_command(connectionId, command)\` 阻塞执行，支持 \`workdir\` / \`timeout\`；\`stream: true\` 流式（卡片实时输出，完成时宿主 deferred 自动投递结果）；\`tty: true\` 交互会话
- \`wakeOnExit\`（tty / stream 通用）：显式意图——\`true\` 必唤醒，\`false\` 只记录不唤醒（结局照常落盘）；不传时默认策略：正常 exit 且会话 ≥3s 才唤醒（瞬时交互不打扰），异常/干预结局（disconnect/lost/killed）始终唤醒
- ⚠️ **tty 是 pty 执行传入的命令：命令执行完会话即结束**。\`echo\` 这类短命令瞬间退出，\`write_stdin\` 随即报 \`No active session\`——不是故障，是会话已结束。要开交互 shell 用**长驻命令**：\`exec_command(connectionId, command: "bash", tty: true)\`（交互脚本同理，如 \`python3 -i\`）
- \`write_stdin(sessionId, chars)\` 喂输入并回读输出；会话空闲超时自动终止，断连级联终止
- ⚠️ exec 通道不带交互 stdin：多行 heredoc 命令（\`cat <<EOF\` 等）不可靠，先 \`write\` 落盘脚本再执行，或改用 tty 会话

## QUERY
会话记录与 deferred 自动投递。

tty / stream 结束时，宿主 **deferred 自动投递**终局结果（\`<hana-background-result>\`，type=hrd-op）：payload 带 \`how\`（exit/killed/disconnect/lost）、\`exitCode\`、\`outputTail\` 与 \`HRD://session/<id>\` 引用，无需主动索取（wait 工具已退休）。需要全文时再查：

1. **定位**：\`hrd(GET HRD://session/<sessionId>)\` 返回记录文件实际位置 + 结局摘要
2. **内容**：拿到位置后自行决定查询方式——\`read\` 读全文（offset/limit 分段）、\`grep\` 搜特定模式、或宿主工具按需处理

记录随会话运行增量落盘（进行中即可读），空间有界保留（单文件 / 总字节，面板可配），引用只带路径，内容按需自取。

## CONFIG
插件配置与本地日志。

\`dataDir/config.json\`（面板唯一入口）：

\`\`\`json
{
  "sessionLog": { "maxMB": 8, "maxTotalMB": 32 },  // 会话日志两限（0 = 不设限）
  "idleTimeout": 300                                 // 兜底回收秒数（异常残留；正常路径 exec/会话结束已即时释放）
}
\`\`\`

不使用宿主 config 系统（manifest 无 config 键，代码不读 ctx.config）。面板胶囊（● 状态 | 时间 | 大小）点击开配置窗口。

日志（\`dataDir/logs/\`）：

| 路径 | 内容 |
|---|---|
| \`logs/session/<yyyy-mm-dd>/<id>.md\` | 会话记录（tty 交互与一次性 exec 同构模板，增量落盘 append-only；id 前 8~9 位 base36 为毫秒时间戳，O(1) 定位） |
| \`logs/connection/<yyyy-mm-dd>.md\` | 连接变动按日滚动：connect ok/fail/timeout、disconnect manual/auto、close |
| \`logs/config/<yyyy-mm-dd>.md\` | 配置变动按日滚动：连接配置增删改、插件配置变更 |
| \`logs/archive/<yyyy-mm-dd>.tar.gz\` | 超限清理时最旧日期目录打包归档（可解压还原；三平台原生支持） |

## TROUBLESHOOT
排查对照：错误 → 处理。

- 连接超时：检查网络与端口
- 认证失败：凭据未录或录错，重新提供
- \`unknown connection\`：别名拼错，\`hrd(GET HRD://connections)\` 核对
- \`No active session\`：tty 短命令已执行完退出；交互请用长驻命令（\`bash\`）
`;
