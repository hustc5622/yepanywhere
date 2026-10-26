# 在 Yep 中打开 DeepSeek Harness

侧栏的 **dsh** 入口会按需启动本机的 `dsh web`，并在 Yep 页面内显示原生界面。页面标题统一为 `dsh`，标题下直接展示内嵌页面；启动失败时提供重试按钮。

这是 Web 入口集成。会话、模型设置和审批由 dsh 自身管理。dsh 会话同时以只读 provider `dsh` 出现在 Yep 的项目与全部会话中，见下文「只读会话列表」。

## 安装和配置

在运行 Yep 服务端的机器上安装 dsh，并配置其模型凭据。本次适配验证使用 `0.2.1-rc.2`。

```zsh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
```

Yep 依次检查 `YEP_DSH_PATH`、当前 Node 所在目录、`~/.local/bin` 和 `PATH`。非标准安装可设置 `YEP_DSH_PATH` 为 dsh 可执行文件的绝对路径。不会自动下载或升级 dsh。

dsh 使用其原生数据目录，通常是 `~/.dsh`，也继承服务端的 `DSH_HOME`。在原生 Models 页面保存的凭据仍然有效。

## 访问路径

- `POST /api/dsh/launch`：通过 Yep 认证和请求头检查后启动或复用进程，只返回页面路径。
- `/apps/dsh/`：受 Yep 认证保护的 HTTP、资源、流式响应及 WebSocket 代理。
- 设置 `BASE_PATH=/yep` 时，上述路径相应变为 `/yep/api/dsh/launch` 和 `/yep/apps/dsh/`。

公网仍使用现有的 Yep 域名和 frp 隧道，不需要开放 dsh 端口。前置反向代理需要将这些路径转发给 Yep，并支持 WebSocket；HTTPS 沿用 Yep 的入口配置。

代理只连接 Yep 管理的本机 dsh。dsh 的启动 token 和认证 cookie 保留在服务端，不进入页面 URL；Yep 的密码会话仍参与每次代理请求的认证。桌面版通过有效 desktop token 换取仅限 dsh 路径的签名 cookie，以支持 iframe 子资源请求。

## 进程生命周期

首次点击启动一个独立、仅监听 `127.0.0.1` 随机端口的 dsh Web。重复点击复用同一进程，多个 Yep 实例通过文件锁协调启动。已经手动启动在 `3080` 等端口上的 dsh 不会被停止、替换或接管。

启动时通过专用 `dsh-web/web.patch.yml` 同时启用网页目录选择器的后端和前端，关闭自动选择器。否则 macOS 上的 loopback 启动会被识别为本机操作，点击「添加工作区」将打开服务器上的原生目录对话框，远端页面看起来没有反应。此配置只作用于 Yep 启动的 dsh，不修改用户的全局 Web profile。更新前已运行的 dsh 会继续被复用，需要在用户确认后重启该 dsh 进程，才能应用新的启动配置；只重启 Yep 不会替换它。

进程与 Yep web/API 进程分离，关闭页面或重启 Yep 不会主动结束 dsh；Yep 根据数据目录中 `dsh-web/process.json` 重新连接。只有明确确认旧 PID 已不存在时才重新启动；启动超时不会杀死可能仍在初始化或工作的进程。

`dsh-web/web.log` 记录启动输出，权限为 `0600`，其中包含 dsh 启动认证链接，不应直接公开。若入口提示启动失败，可在本机检查该日志及 dsh 安装路径。

## 只读会话列表

Yep 只读解析 dsh 的会话日志，在侧栏项目和「全部会话」中列出 dsh 会话，并显示运行状态和未读提醒；继续对话、审批和模型切换都在内嵌 dsh 页面完成。

- 数据来源：`$DSH_HOME/sessions/<编码后的 cwd>/<session-id>/session.v<N>.jsonl.zstd`，`DSH_HOME` 为空时使用 `~/.dsh`。同一目录下保留的旧格式文件按最高版本号选取。文件由多个独立的 zstd 帧拼接而成（头部一帧，此后每次落盘一帧），Yep 逐帧解码，忽略正在写入的残缺尾帧，文件追加时只解码新增帧。项目归属以会话头的 `cwd` 为准，不反解目录名。
- 列出范围：只列根会话。带 `parentSession`、`origin: "subagent"` 或 `delegationDepth > 0` 的子 agent 会话不单独列出；没有用户提问的空白会话也不列出。
- 转换：只显示 `source.kind === "user"` 的用户消息；workspace 指令、runtime context、skill 目录、审批通知等注入内容不显示。`assistant/message` 的 `text`／`reasoning`／`tool-call` 和 `tool/result` 转为 Pi 线性会话，复用 Pi 渲染；工具名映射到 Bash、Read、Write、Edit、Grep、Glob、WebFetch、WebSearch 等现有渲染器。`turn/end` 的 aborted／error 分别标记为中断／失败，`compaction/summary` 显示为压缩边界。标题取最新的 `session/title`，上下文窗口取 `request/context`。图片和文件附件显示为占位文字。
- 状态：dsh Web 在进程内运行 agent，无法通过进程探测归属到项目，因此以日志尾部判定：最新一轮有 `turn/start` 而无 `turn/end` 时显示「运行中」；同时存在未决的 `approval/asked` 或未返回结果的 `ask_user_question` 时显示「等待输入」。Yep 启动前已在运行的轮次，要等 dsh 下一次写入日志后才显示。
- 打开原生页面：会话页底部用「在 dsh 中打开」代替输入框，跳转到 `/dsh?session=<id>`。dsh Web 把当前会话保存在 localStorage 的 `dsh.sessions.current`，启动时恢复；代理页面与 Yep 同源，Yep 在加载 iframe 前写入该键，dsh 就会打开对应会话。
- 只写 Yep 自己的元数据：重命名、置顶、已读和归档只改 Yep 的数据，归档不移动 dsh 文件。服务端拒绝对 dsh 会话执行新建、续接和发送消息（`409 read_only_provider`）。不读写 `session.lock`，不影响 dsh 的单写者锁。
- 开关：`dsh` 属于 `ENABLED_PROVIDERS` 的有效值；设置了 allowlist 但不包含 `dsh` 时，不扫描 `~/.dsh`，也不监听其中的文件变化。
- 实现入口：`packages/server/src/sessions/dsh-store.ts`（目录、帧解码、事件转换、状态）、`dsh-reader.ts`、`packages/server/src/projects/dsh-scanner.ts`、`ExternalSessionTracker` 的 dsh 分支，客户端 `ReadOnlySessionBar.tsx` 与 `DshPage.tsx`。协议事实以 `references/dsh/`（`deepseek-harness` 的 `dsh-v0.2.1-rc.2` tag）为准：存储格式看 `packages/session/session-persistence-jsonl/`，事件定义看 `packages/core/session/src/types.ts`，消息结构看 `packages/llm/llm/src/`，Web 端会话恢复看 `packages/client/ui-workspace/src/client/navigation.ts`。

暂不支持：子 agent 会话关联（`subagent/catalog`）、图片与附件预览、在 Yep 中发送消息。后续若需要在 Yep 中直接对话，可改用 `dsh acp`（ACP v1，支持 `session/new`／`resume`／`prompt`／`cancel`，不支持 `session/load`、fork 和问卷），但需要处理 dsh Web 占用写入锁时返回的 `session/writer-held`。

## 更新 dsh

进入 **设置 → 提供商 → CLI 更新**，在 dsh 卡片上检查版本。只跟随 npm 的官方 `latest` 渠道，不跟随 `next` 或 `alpha`。`latest` 是默认发布标签，不代表正式稳定版：截至 2026-10-19，它仍指向 `0.2.0-rc.2`。候选版本也会正确比较，例如 `0.2.1-rc.10` 高于 `0.2.1-rc.2`；若本机已安装版本更高，则保留当前版本，不降级。

更新流程：

1. 点击「检查更新」，查看目标版本。
2. 若 dsh Web 运行中，点击「停止 dsh Web…」并确认。此操作只停止 Yep 管理的进程；它会断开 dsh 页面，可能中断 dsh 任务。使用相同安装目录的其他 dsh 实例需要自行关闭。
3. 点击「更新 CLI」。使用该 dsh 安装目录配套的 npm 和 Node，安装检查得到的确切版本，并验证原路径上的版本确实更新。
4. 完成后点击「启动 dsh Web」，重新打开 dsh 页面。

只有 npm 全局安装支持在 Yep 中更新，自定义包装脚本仍由原安装渠道维护。打开更新页不会自动访问 registry 或执行升级。安装任务在服务端运行，可离开页面后返回查看状态和日志；最多等待 30 分钟。

更新期间文件锁阻止其他 Yep 实例启动 dsh，共用服务实例也会立即拒绝启动请求；运行中的 dsh 不会被更新任务自动停止。停止操作检查 PID 的命令行及专属配置路径，避免对陈旧 PID 对应的其他进程发送信号；只发送 SIGTERM，不强制结束超时进程。

## 验证更新

```zsh
pnpm --filter @yep-anywhere/server test -- test/sessions/dsh-store.test.ts test/supervisor/external-dsh-sessions.test.ts
pnpm --filter @yep-anywhere/server test -- test/dsh/web-service.test.ts test/routes/dsh.test.ts
pnpm --filter @yep-anywhere/server test -- test/services/HarnessUpdateService.test.ts test/routes/harness-updates.test.ts
pnpm lint:typography
```

聚焦测试覆盖并发启动、进程复用、认证、跨来源请求拦截、路径前缀、凭据隔离，以及文本和二进制 WebSocket 转发。浏览器/UI 验证仍遵循项目的显式授权要求。
