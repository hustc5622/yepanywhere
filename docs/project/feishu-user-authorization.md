# Yep 原生飞书用户授权与 MCP

Yep 独立管理 OAuth、refresh token 和 38 个 Lark 工具入口。运行和构建均不需要 MLB Manager，不读取旧机器人目录的 `tokens.json`，不调用旧 bridge。

工具契约和 SDK 业务处理代码已迁移为仓库内维护的 `packages/server/resources/feishu/`；文档 Markdown 的三个工具继续访问飞书自己的 `mcp.feishu.cn`，其他业务工具使用飞书 SDK。语音识别的本地音频转换使用 `ffmpeg`，没有引入旧应用的解码器 bundle。

## 启用

1. 在飞书应用后台开通所需业务权限与 `offline_access`，并发布应用使权限生效。
2. 准备手机能访问的 HTTPS 地址，将 `<base-url>/api/auth/feishu/callback` 登记为该应用 OAuth 重定向地址。例如 base URL 带 `/yep` 时，回调也要带 `/yep`。HTTP 只用于 localhost 开发。
3. 在 Yep 设置 → 飞书用户授权，为现有渠道账号启用“由 Yep 管理用户授权”，填写完全一致的回调地址和需要的 scope。
4. 用户在飞书发送 `/auth`，或在 Yep 设置点击“连接 / 重新授权”，使用对应飞书账号完成授权。实际授权用户必须与渠道请求者一致。

用户和管理员 allowlist 仍来自现有飞书账号配置。未启用用户授权时，生产渠道注入禁用的 Yep connector，避免退回全局旧 Lark MCP。未配置回调地址时 `/auth` 会明确提示管理员配置，不会伪装为授权成功。

现有已过期的令牌不能迁移成有效令牌，需要完成一次新的 OAuth；本实现没有导入旧 refresh token 的入口，避免新旧进程共享同一条刷新链。

## Desktop / CLI 配置切换

Yep 飞书渠道的新建和恢复会话会自动获得带请求者绑定的 `yep-feishu` MCP 配置，并禁用 `lark` / `feishu-mcp` 旧入口。独立 server ID 避免 Codex 递归合并旧 transport/env；不能用 JSON null 删除这些字段，因为 Codex 会将 null 转为 TOML 空字符串。MCP 配置发生变化时，只在空闲边界重建对应会话进程；活跃任务会拒绝立即切换，不被中断。

Desktop/CLI 直接使用全局 MCP 配置，需要一次明确切换：在授权设置页为有 `defaultProjectPath` 的账号生成“本机 Codex MCP 配置”。配置中的第二个参数是 Yep 生成的 connector JSON 路径。

在 **Yep 所在主机**运行以下工具，默认只预览，不改配置：

```bash
node packages/server/resources/feishu/configure-codex.mjs \
  --connector-config /path/to/yep/channels/feishu/mcp-clients/CLIENT.json
```

打包版本中的脚本位于发布目录的 `resources/feishu/configure-codex.mjs`。审阅预览并待活跃任务结束后，添加 `--apply` 执行；可用 `--config /path/to/config.toml` 指向特定 Codex 配置。它会备份配置、替换 `lark` 和 `feishu-mcp` 表及其子表（包括旧的工具审批覆盖），不重启任何进程。需要的工具审批偏好可在审阅时重新加到新配置。

connector 只通过作用域受限的 bearer credential 访问 Yep，绑定 account、user 和工作目录。该 credential 不能读取任意用户 token；每次请求重新检查账号、用户 allowlist 和工作目录权限。connector JSON 包含凭据，按本地私有文件管理。源码及发布资源不含生产凭据。

默认 connector 使用服务本机地址；特殊网络配置可通过 `YEP_FEISHU_MCP_SERVER_URL` 指定入口。HTTPS 必须受 Node 信任；自签证书部署请配置受信任证书链，不关闭 TLS 校验。

当前 connector 的文件操作在 Yep 服务所在主机执行；不把它配置到使用不同文件系统的远端 agent。路径限定为绑定工作目录与系统临时目录，检查已存在祖先的真实路径，防止通过符号链接越出允许范围。

## 自动维护和失败恢复

- 业务请求前检查 access token 安全余量，必要时合并为一次刷新。
- 服务每分钟检查到期任务；空闲授权的维护刷新最长间隔 24 小时，短 TTL 按剩余寿命提前安排。
- grant 以 domain/app/user 为主键，同一数据目录内的进程共享文件锁。不要把 refresh token 复制到其他机器或 profile 各自刷新。
- 令牌对、到期时间和 revision 原子写入；请求发出前先记录刷新意图。
- `20037`、撤销、重复使用与应用配置错误分别记录。网络超时不能证明 token 未被消费，因此进入 `refresh_uncertain`，不盲目重试。
- 用户取消、拒绝或授权失败后抑制自动反复发起；可以明确用 `/auth` 或 Web 页面重新开始。

飞书工具在尚未发出业务 API 请求时需要授权，会展示授权卡片，并最多等待约三分钟。期间完成授权，继续同一次工具调用。等待超时、进程退出或原任务结束后，用户在原会话回复“继续”；系统不自动重放整轮任务，不宣称已经恢复一个已结束的 MCP 请求。

`/auth status` 查看状态，`/auth cancel` 取消当前 OAuth 流程；`/stop` 同时取消该请求者的待授权流程。取消 MCP 请求后检查 abort signal；停止状态还会增加持久化取消版本，每次 SDK 业务请求前重新核对，避免授权完成与停止同时发生时继续写入。已发送的写操作结果不确定时保留错误，不自动重发。

同一渠道 session 首次启用用户授权后固定授权用户。其他群成员需要自己的会话才能使用自己的凭据，不能沿用最早发起人的授权；系统不会自动新建会话。

## 存储、API 与部署边界

- grant 与 OAuth attempt：`<data-dir>/channels/feishu/user-auth/`。
- connector 绑定：`<data-dir>/channels/feishu/mcp-clients/`。
- 管理 API：`/api/channels/feishu/user-auth`，以及 account 下的 `user-auth` 路径；沿用 Yep 全局认证。
- OAuth callback：`/api/auth/feishu/callback`，由一次性 state + PKCE + 用户身份校验授权，不依赖 Yep cookie。
- MCP：`/api/auth/feishu/mcp`，独立校验 connector credential；匿名访问会返回 401。

正式部署依照项目 CalVer 流程 bump/check，再使用统一部署入口。启用账号与真实 OAuth 需要可用的回调域名和用户确认；自动化测试不能代替这些部署条件。

回滚不要恢复旧 token 备份。新令牌由 Yep 持有，旧进程不再能从旧目录获得它；如果回滚到不支持新授权服务的版本，先停止使用该 connector，再按需要重新授权。

## 验证

聚焦测试覆盖假时钟空闲续期、两个服务实例并发、一次性回调、错用户授权、刷新不确定状态、取消后不写、38 个工具契约、原生文件下载与 4510 profile 合并；同时回归渠道 runtime、SessionCommandService 和 Supervisor。真实平台的全部业务 action 仍需按账号实际能力在部署后验证，不能将 mock 测试等同于飞书应用已开通全部权限。
