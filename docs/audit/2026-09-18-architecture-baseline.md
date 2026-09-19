# Yep Anywhere：2026-09-18 架构审计

## 范围与结论

审计固定在 `ae69e1822c2797a4c8ce8578bd6c3bfb00a2ee24`，不是把不同时刻的 main 混合分析。已获取完整 Git 快照，逐文件校验 2,655 个 Git blob；对 2,071 个 JS/TS 家族文件做语法、静态导入/导出、精确函数体重复扫描，并沿关键业务链路阅读源码。

**全量机械扫描不等于逐行人工审阅全部代码，也不等于所有 provider、原生平台或线上安全验证。** 本轮没有读取真实用户凭据/生产日志、调用真实模型、连接设备、部署或重启服务。

项目已有可保留的架构边界：会话命令服务、runtime façade、Supervisor/Process、provider adapters、InteractionBroker、服务端 display projection。建议在这些边界内消除重复与反向依赖，不推倒重写，不直接删旧展示或 provider 兼容路径。

本轮还确认了一个需要先独立处理的安全问题：gateway 完整 API key 被拼入启动日志。它未包含在本 PR 的结构重构中。

## 1. 基线

| 检查 | 结果 |
|---|---|
| 固定源码 | 2,655 文件；Git blob SHA 全部匹配 |
| 源 tar SHA-256 | `982223fe669ff888da4af3372610176db9af541ed7352a8924d6dbf3c2fc0318` |
| JS/TS 语法扫描 | 2,071 文件；语法解析诊断 0 |
| 导入/导出/字面量加载边 | 8,149；其中 6,028 条解析到仓库文件 |
| 生成代码 | 828 文件，单独分类，不当作手写冗余 |
| 静态值依赖环 | 1 个非平凡强连通分量，11 个前端文件 |
| 精确重复函数体 | 12 组；至少 80 tokens，忽略注释空白但保留标识符 |
| 演化分析 | 最近 300 commits，2026-08-07 至 2026-09-17 |
| 环境 | Node 22.22.2、pnpm 9.15.1、TypeScript 5.9.3、GitHub Linux runner |
| install / lint / typecheck | 冻结锁文件安装与检查均通过 |
| 基线测试 | shared 421、client 1,045、server 3,744：合计 5,210，411 个测试文件 |
| 试点测试 | shared 421、client 1,045、server 3,750：合计 5,216，412 个测试文件 |
| 完整产品 build | 本轮未执行；typecheck 只包含 shared 的前置 build |
| 原生 / 真 provider / 手动浏览器 | 本轮未执行；原仓库自动 CI 仍按既有配置运行 E2E |

证据运行：

- 原 main CI：[35216547329](https://github.com/hustc5622/yepanywhere/actions/runs/35216547329)。
- 本次固定快照与基线复跑：[35315712476](https://github.com/hustc5622/yepanywhere/actions/runs/35315712476)。
- 负对照与重构验证：[35316889311](https://github.com/hustc5622/yepanywhere/actions/runs/35316889311)。

以上不是覆盖率或安全评分。本次未运行 Knip、jscpd、dependency-cruiser；静态数字来自 TypeScript AST 扫描器。Actions 审计 artifact 保留 7 天，完整文本证据另随审计交付包保存。

## 2. 实际架构

### 工作区与产品形态

`pnpm-workspace.yaml` 仅包含 `packages/*`。有 package.json 的 JS 工作区是 client、server、shared、desktop、mobile；site 与 sharing-worker 独立。Go device-bridge、Kotlin android-device-server、Objective-C ios-sim-server 不能用 TypeScript CI 验证替代。

| 部分 | 实际职责与入口 |
|---|---|
| Web client | React 页面与 hooks；`api/client.ts:544` 使用 fetch；会话/活动订阅走 WebSocket |
| Hono shell | `server/src/index.ts` 装配服务，`app.ts` 注册 API、中间件、reader、commands、interactions、display |
| runtime | 默认 EmbeddedRuntimeController；external 时 shell 用 HttpRuntimeController，独立进程在 loopback 上提供控制 API |
| Supervisor / Process | worker admission、排队、启动/恢复 provider、消息队列、审批、进程/turn 状态 |
| provider / bridge | Codex app-server/bridge；Pi RPC；Kimi/Gemini ACP；ZCode app-server；Claude 历史兼容 |
| 历史和展示 | 原生 reader + normalization、Codex canonical journal、runtime replay journal、可重建 display projection |
| 飞书 | durable inbox/binding、附件、回复、卡片交互，共用 SessionCommandService |
| desktop / mobile | desktop 为 Tauri/Rust 启动器和 Bun sidecar；mobile 是 Tauri 原生壳加远端页面 loader |
| 设备串流 | DeviceBridgeService → Go sidecar → WebRTC signaling / 视频 / 输入 → 设备适配 |
| 配套 | Astro site；Cloudflare/R2 sharing-worker；update-server 只有 JSON，不是独立服务实现 |

源码要点：

- `app.ts:784–856` 创建 Supervisor、RuntimeController、SessionInteractionService、SessionCommandService。默认 provider 为 Codex。
- `sdk/providers/index.ts:81–127` 的主动发现列表排除 Claude；`getProvider("claude")` 仍保留；Gemini 与 Gemini ACP 名称均映射到 ACP。
- `runtime/standalone.ts:38–139` 限制 loopback，持有独立 Supervisor、event journal 和 token 控制接口。
- `index.ts:1100–1124` 将 WS 路由与 runtime、display、uploads、devices、terminal 连接起来。
- `app.ts:568–655` 根据 provider 选择 reader，ZCode 读 SQLite，其他 reader 保持其原生存储语义。

不要把 Session、Process、turn、display stage、interaction operation 当成同一个生命周期对象；也不要把 provider 原生历史、canonical event journal、runtime replay 和 Yep metadata 因为都“保存状态”就直接合并。

## 3. 六条业务主线

### 新建和继续会话

`NewSessionForm / SessionPage → api/client.ts → routes/sessions.ts → SessionCommandService → RuntimeController → Supervisor → AgentProvider.startSession → Process`。

路由委派命令，命令服务做上下文准备，Supervisor 做容量和排队，provider 返回 iterator/queue/abort 与能力控制方法。证据：`routes/sessions.ts:2432–2494`、`services/SessionCommandService.ts:803–951`、`supervisor/Supervisor.ts:319–377,619–774`。

### 历史、实时和重连

`provider history / reader → display source → SessionDisplayService + reducer → snapshot/WS 增量 → useProjectedSessionMessages → renderers`。

`SessionDisplayService.ts:283–301` 在读历史前先订阅事件，再 refresh，避免读取窗口漏事件。`routes/session-display.ts:351–450` 组织原生历史与 reader；`useSessionMessages.ts` 按选项切换新旧模型。新路径默认启用，但 legacy 仍可达，不能当死代码删除。

### 审批和用户问题

`provider pending request → Process / bridge owner → SessionInteractionService → InteractionBroker → provider response`。

`interactions/SessionInteractionService.ts:265–449` 检查 requestId、operationId、version，处理 stale/already_resolved/provider_rejected。Web 与飞书不应各自维护第二套审批权威。

### 飞书

`transport → durable inbox + scope/binding → inbound processor → SessionCommandService → runtime`；reply manager 订阅命令服务回传结果。

`channels/feishu/channel-runtime.ts:198–300` 先准备持久化、安装 handlers，再初始化与恢复消费；inbound-processor 的 start/send/create 复用核心会话命令。

### 上传与两阶段创建

create-only 先获得 session 身份，再上传附件，最后提交首条消息。因此 create 与 start 不是应立即合并的重复 API。HTTP/WS/飞书复用 UploadManager，但各入口授权、下载和归属边界仍须独立。

证据：`Supervisor.ts:380–385`、`routes/sessions.ts:2450–2474`、`uploads/manager.ts`、`index.ts:1101–1123`。

### 原生壳与设备

desktop 的安装/设置 React 入口不同于主 Web 页面；Rust 管理 server 子进程。mobile loader 选择远端节点与桥接原生能力。Go sidecar 负责设备传输。本轮只核对入口、代码关系和工作流边界，没有跑 Tauri/APK/Go/iOS 全构建或实机验收。

## 4. 发现与优先级

### SEC-01：完整 gateway key 进入日志——确认，高优先级

`server/src/index.ts:409–434` 的 `warnAboutLlmGatewayConfig()` 将 `channel.apiKey` 直接拼接到 console.log。`logging/logger.ts:190–205,238–249` 的拦截和格式化仍转发这个字符串；查看到的 Pino 配置没有对该字符串内容做有效脱敏。

这是凭据进入日志的确定代码路径，不是已证实泄露或利用。应单独停止记录原始 key，保留无敏感内容的渠道/key 标识；哨兵凭据测试应确保日志中找不到该凭据。不能只配置对象字段 redact 却继续在 msg 字符串里插入 key。日志曾被共享/导出/集中采集时再评估轮换。本 PR 未修改这一项。

### ARCH-01：service 反向引用 routes——确认，本 PR 已修

`SessionCommandService.ts:45` 从 `routes/session-model.ts` 导入纯模型选择规则；该规则不属于 HTTP 层。迁到 `sessions/session-model.ts`，保留原行为和四个测试，只更新依赖位置。

### ARCH-02：11 文件 renderer 值依赖环——确认结构，未复现运行故障

主要回路：`RenderItemComponent → ToolCallRow → tools registry → TaskRenderer → RenderItemComponent`。另有 `ContentBlockRenderer ↔ renderers/index.ts` 聚合导出回路。Task 的子代理递归渲染有合理需求，不能机械删掉。

11 节点为 RenderItemComponent、DisplayToolGroupRow、ProjectedToolGroupRow、ToolCallRow、ContentBlockRenderer、ToolResultRenderer、ToolUseRenderer、renderers/index、TaskRenderer、renderers/tools/index、tools/summaries。

后续先分离纯 summary/metadata 与 React registry，显式组织嵌套渲染；保留子代理、错误和展开行为测试。不要用动态 import 掩盖统计结果。

### DUP-01：12 组精确函数体重复——确认候选，不是全部必须抽取

优先例子：`client/src/lib/bashCommand.ts:63–113` 与 `server/src/codex/normalization.ts:888–929` 的 launcher 识别/展开函数。适合以跨端 fixture 测试保护后，迁入 shared 的具名领域模块。其他候选包含 web-run 解析、稳定序列化、artifact 文件名校验。旧 Gemini 与 ACP 的重复、smoke 脚本退出处理不必先抽。

### HOT-01：高变化职责集中——确认指标，不等于 Bug

最近 300 commits：codex.ts 6,699 行/38 次变化；routes/sessions.ts 3,140 行/36 次；api/client.ts 2,354 行/27 次；app.ts 1,763 行/26 次；SessionPage.tsx 2,863 行/25 次；SessionCommandService.ts 2,482 行/20 次；Process.ts 2,653 行/20 次。

应保留 façade，分别拆 transport/lifecycle/projection、会话选择和分支策略、页面编排与状态 hook。不以“文件小于 N 行”为目标，不同时升级 SDK 和改变状态模型。

### MIG-01：新旧展示并存——确认过渡状态

已有 `docs/project/2026-09-07-session-display-lifecycle-redesign.md`，并非从未设计过。沿现有方案完成 provider × history/live/reconnect/branch/detail 验收矩阵后再退役旧路径，避免第三套 message model。

### CHECK-01：验证范围——确认

root typecheck 排除 mobile；普通 CI 不跑完整 bundle build；desktop/bridge 有自己的 paths/tags 工作流。全绿不表示实机或真实 provider 已验证，应按产品形态设置门禁，而不是声称项目没有测试。

### DOC-01：概览漂移——确认

README 仍把 Claude 写为主要 provider，实际默认执行和发现路径以 Codex 为主。端到端加密的概述需说明具体部署保证：`routes/ws-handlers.ts:1–7` 描述 plaintext 消息帧，TLS/可信网络取决于部署。本轮没有测生产网络，不能据此声称实际流量已泄露。

### CONFIG-01：mobile 默认地址耦合——确认事实，产品取舍

`mobile/static-shim/loader.js:14–65` 写有个人默认节点、旧节点迁移列表、HTTP TCP 与 HTTPS 入口。独立发行或迁移环境时应区分发行默认值、用户保存配置和迁移规则，并明确 TLS/可信隧道边界。

### VERIFY-01：外置 runtime 与 bridge ownership——待验证，不报作确定 Bug

`app.ts:818–864` 接受外置 runtime，但 bridge ownership resolver 直接看本地 Supervisor。应补外置 runtime 持有 session、shell 重连、bridge 同时 poll 的集成测试，确认不会出现错误 ownership 或重复审批。不能未经验证直接改掉已有抑制逻辑。

## 5. 已实施的试点和防回退规则

验证代码提交：`9b7d0046709ff86aaca1b923f20d24a375575d42`。纯重构涉及 4 个文件（含 2 次重命名），不改模型选择/API/会话生命周期；本说明文档是其后的文档提交。

新增 `packages/server/test/architecture/dependency-boundaries.test.ts`：

1. server/services 不导入 server/routes。
2. shared 不依赖 client/server 应用。
3. client 不依赖 server 源码。

三项生产规则加三项检测器回归测试，共 6 项。涵盖 static/type-only import、re-export、字面量 dynamic import/require、import type expression、import equals、现有 server @/ alias 和 workspace 包名。未来计算路径和新增 alias 需要另行扩展，它不是完整 dead-code/cycle 检查器。

负对照已执行：旧代码加 guard 时 1 failed / 5 passed，报错精确指向 SessionCommandService 的 routes 依赖。迁移后 install/lint/typecheck 通过，5,216 tests 全通过。现有 renderer 环没有被本次小型 guard 修复，不应如此宣称。

## 6. 后续分步验收

| 顺序 | 改动边界 | 验收 |
|---|---|---|
| 先处理日志 | 仅停止明文凭据输出 | 哨兵 key 不进入日志；不改变渠道选择和鉴权 |
| shared 纯规则 | 一次一个语义相同的函数簇 | 跨端 fixtures 等价；空值/引号/嵌套/非法输入；shared 不引入 Node/React |
| renderer 边界 | summary/metadata 与 registry | 环的具体边减少；Task/子代理/失败/展开行为不变 |
| 展示迁移闭环 | 沿现有 projection 方案 | 首开、停留、刷新、重连、切换会话和分支详情一致后才退役 legacy |
| 大模块拆分 | 保留原 façade，分 transport/lifecycle/projection | 状态序列契约和 external ownership 场景通过，逐个迁移调用方 |

没有合并 main，没有部署或重启用户服务。审计工作流在独立 audit 分支；不要为接收本 PR 而把临时审计工作流整体合并。项目本机的 references/codex、references/pi 与真实 ZCode CLI 不在 Git 快照内，本报告不把这些未读资料作为已验证证据。
