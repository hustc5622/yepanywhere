# 飞书 / Lark 渠道桥接运维手册

本文说明 Yep Anywhere 内置 Feishu/Lark 渠道的能力、配置、离线验收和回滚边界。渠道由 Yep Server 托管，复用同一套 `SessionCommandService`、provider runtime、Codex session、`InteractionBroker` 和持久化状态，不创建第二套 agent runtime。

文档中的账号、路径和服务地址均为占位符。它不授权连接真实应用、修改 routing、停止旧消费者、部署或重启任何服务；这些动作必须在单独批准的变更窗口中执行。

## 能力与边界

渠道实现包括：

- 多应用账号，所有状态按 `accountId` 隔离；
- 私聊、群聊和话题的稳定 scope/session binding；
- `text`、`post`、`interactive`、引用和 `merge_forward` 标准化；
- 消息资源下载、受控 attachment 提取和原生图片/音频输入；
- durable inbox/outbox、重复事件防护和进程恢复；
- 流式 CardKit 回复、长回复分段和 plain-text 降级；
- command/file/permission/MCP approval、问题表单和一次性 CAS resolution；
- `/help`、`/status`、`/new`、`/reset`、`/stop`、`/project`、`/mode`、`/doctor` 和受限的 `/codex` 动作；
- 账号设置、连接控制、权限提示、脱敏诊断和只读迁移预检。

渠道默认不启用 `bypassPermissions`，不执行任意 Feishu 工具调用，也不把 MCP UI HTML 发送到聊天。Feishu MCP 与本渠道是两种不同能力：MCP 是 agent 主动调用平台 API；渠道是用户经聊天控制既有 Yep/provider runtime。

没有 enabled account 时，渠道保持 inert：不创建 SDK client、WebSocket、cleanup timer 或网络连接，也不要求 secret/config。这是默认 profile 的兼容门禁。

## 平台应用配置

在 Feishu/Lark 开放平台创建企业自建应用并启用机器人。当前 transport 使用长连接接收事件，不要求公网 webhook 地址。

基础订阅：

- 事件：`im.message.receive_v1`
- 卡片回调：`card.action.trigger`

按当前实现核对最小 scopes：

| 能力 | Scope | 必需性 |
| --- | --- | --- |
| 接收消息 | `im:message` | 必需 |
| 机器人发消息 | `im:message:send_as_bot` | 必需 |
| 读取引用和合并转发 | `im:message:readonly` | 必需 |
| 下载消息资源 | `im:resource` | 必需 |
| 群与话题元数据 | `im:chat` | 必需 |
| 创建、更新流式卡片 | `cardkit:card:write` | 必需 |
| 解析用户显示名 | `contact:user.base:readonly` | 可选；缺失时使用安全占位名 |

实际要求以设置页和 `GET /api/channels/feishu/accounts/:accountId/permissions` 为准。增加能力时先更新代码中的权限矩阵和 contract tests，再申请对应 scope；不要预先申请无关权限。

## Yep 账号策略

关键字段：

- `accountId`：本机稳定命名空间，只允许小写字母、数字、`_` 和 `-`；
- `domain`：国内 Feishu 选择 `feishu`，国际 Lark 选择 `lark`；
- `proxyMode`：控制 OpenAPI 与 WebSocket endpoint discovery；`auto` 默认让国内 Feishu 直连、国际 Lark 继承环境代理，`direct` 强制该账号直连，`environment` 强制该账号遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。实际 WebSocket 仍由 SDK 直连，除非显式提供 proxy agent；
- `allowedUsers` / `adminUsers`：至少配置一个，否则账号进入 `locked`；
- `allowedChats`：群聊 allowlist；空集合不得被解释为“允许所有群聊”；
- `allowedWorkspaceRoots`：所有可启动项目的真实路径边界；
- `defaultProjectPath`：首次消息的默认项目，必须位于允许根目录内；
- `groupSessionMode`：通常使用 `thread-when-available`；
- `defaultModel` / `defaultReasoningEffort`：留空时沿用 provider 默认值；
- `defaultCodexMcpMode`：`standard`、`clear` 或 `full`；
- `defaultPermissionMode`：`default`、`plan`、`acceptEdits` 或当前 schema 允许的安全值；
- `requireMentionInGroup`：生产群建议开启。

App Secret 通过独立 write-only API 保存。客户端不读取或回显原值；secret 不得写入普通配置、日志、诊断包、issue 或版本库。

## 持久化数据

数据位于 `${YEP_ANYWHERE_DATA_DIR}/channels/feishu/`；未显式设置 data dir 时使用 Yep 的 profile 数据目录。

| 文件 | 内容 | 保护 |
| --- | --- | --- |
| `accounts.json` | 非敏感账号策略 | 原子写入 |
| `secrets.json` | 本地 secret store | `0600`、原子写入 |
| `bindings.json` | scope 到 session 的 binding | `0600`、原子写入 |
| `inbox.jsonl` | 事件身份、状态和枚举错误码 | `0600`、append + fsync |
| `outbox.json` | 有界外发 intent 和重试状态 | `0600`、原子写入 |
| `operations.json` | interaction 投影与幂等信息 | `0600`、原子写入 |

`InteractionBroker` 是 approval/question decision 的唯一 authority；channel operation store 只保存安全投影，不形成第二套决策系统。诊断和 durable state 不保存消息正文、答案、tool input、附件字节、App Secret 或原始身份值。

## 管理 API

所有端点位于 `/api/channels/feishu`，沿用 Yep 的全局认证、Origin 检查和写请求防护：

```text
GET    /accounts
PUT    /accounts/:accountId
DELETE /accounts/:accountId
PUT    /accounts/:accountId/secret
DELETE /accounts/:accountId/secret
POST   /accounts/:accountId/test
POST   /accounts/:accountId/connect
POST   /accounts/:accountId/disconnect
POST   /accounts/:accountId/reconnect
GET    /accounts/:accountId/permissions
GET    /status
GET    /doctor
GET    /diagnostics
GET    /bindings
DELETE /bindings/:scopeKey
```

`/status` 返回按账号聚合的进程期指标；`/diagnostics` 只返回配置状态、固定错误码、计数和持久化状态摘要。两者都不是内容导出接口。进程重启后易失计数会归零，恢复以 durable inbox/outbox/binding/operation 为准。

连接失败采用带 jitter 的有界指数退避。REST 429/平台频控按 API 类别分别退避；任何重试都不得再次创建 provider turn。CardKit 更新失败走 durable outbox 或 plain fallback，不改变 canonical turn 的终态。

## 用户命令

```text
/help
/status
/new
/reset
/stop
/project
/project list
/project use <configured-name>
/mode <allowed-mode>
/doctor
/codex <supported-action>
```

普通用户只能选择预配置项目；管理员提供的路径仍必须经过 `allowedWorkspaceRoots` 和真实路径校验。`/reset` 解除当前 scope binding，不删除 provider history。`/stop` 中断目标 turn，不等同于批准、拒绝或停止所有后台终端。

## 离线验证

代码验证使用固定 schema、fake transport、mock SDK、临时 data dir 和 synthetic identity：

```bash
corepack pnpm codex:protocol:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm -r test
```

迁移预检默认离线、只读；账号必须显式指定：

```bash
corepack pnpm feishu:migration:preflight \
  --data-dir <isolated-data-dir> \
  --accounts <canary-account-a>,<canary-account-b> \
  --legacy-label <legacy-consumer-label> \
  --strict
```

`--probe-credentials` 会访问真实平台，只能在另行授权后使用。浏览器、device、APK、真实 tenant smoke、service restart 和 consumer 切换也不属于离线验证。

## 验收矩阵

| 场景 | 必须观察到 |
| --- | --- |
| 私聊纯文本 | 一个 inbox record、一个 turn、一个 terminal reply |
| 群聊未 mention | 策略要求 mention 时 fail closed，不创建 turn |
| 群聊 / 话题 | scope 稳定，不同 thread 隔离 |
| `post` / `interactive` | 阅读顺序稳定，未知元素有安全 fallback |
| 引用 / `merge_forward` | 关系和资源 ownership 可解释，截断显式 |
| 图片 / 文件 | MIME、大小、digest 和 extraction 状态可追溯 |
| 连续消息 | 明确 queue/steer，不并发破坏 session |
| 重复 event / action | durable dedupe/CAS 后只执行一次 |
| 长回复 / CardKit 429 | 最终文本不丢，必要时 plain fallback |
| approval / question | actor、decision、scope 和 request identity 精确 |
| stale callback | 标记 resolved/expired，不重放 provider response |
| process exit / restart | turn 与卡片进入可恢复终态，不自动重复 dispatch |

真实验收只能使用独立 canary 应用，并遵守单消费者不变量。记录安全 fingerprint、correlation ID、时间和枚举结果，不复制消息正文、附件、secret 或绝对路径。

## 迁移与回滚边界

迁移顺序始终是：备份和离线预检 → 旧 consumer quiesce → 证明无 consumer → 只连接一个 canary account → 最小 smoke → 观察窗口 → 再扩大。禁止同一 app/account 长期由两个 long-connection consumer 同时连接。

回滚只改变 consumer/routing owner，不删除 Yep session、binding、inbox、outbox、operation、canonical journal 或附件。切换窗口内已经 accepted 的事件必须逐项 reconciliation，不能批量重发。完整流程见 [Feishu/Lark 迁移与回滚 Runbook](./feishu-migration-runbook.md)。

## 故障排查

- `locked`：用户和管理员 allowlist 均为空。
- `SECRET_MISSING`：write-only secret 未配置或引用不可用。
- `DUPLICATE_APP_ID`：同一实例启用了重复 App ID。
- `INBOUND_HANDLER_MISSING`：channel runtime 未完成两阶段初始化。
- `WS_START_FAILED` / `BOT_IDENTITY_FAILED`：检查 domain、应用状态、凭据和网络；不要打印原值。
- event 收到但未执行：检查 rejected/duplicate 指标、mention/allowlist 和 durable inbox。
- attachment 失败：检查 scope、大小、MIME、digest、extractor 和 retention 状态。
- CardKit 降级：检查 outbox、频控和 fixed error code；不得创建第二个 turn。
- interaction 卡失效：对比 broker 中的 request/version/terminal 状态，不人工重放 callback。

若普通日志、诊断中出现正文、显示名、附件内容、secret、access token、完整 tool input 或私人绝对路径，应按安全缺陷处理并停止扩大流量。卡片仍不得从结构化 tool/runtime 字段泄露路径；唯一例外是 agent 明确写入 user-visible 回复正文的本地路径，这类文本按原回复保留，并将本地 Markdown 链接降为可读的非跳转路径。
