# 差异、未知项与后续核查

[返回总览](README.md)。下面分开记录已观察的现状、候选风险和建议。调查本身没有改实现；调查之后的整理进度见 [consolidation.md](consolidation.md)。优先级表示接手时的核查顺序，不是已证实缺陷的严重度。

## 已确认的文档/源码差异

| 编号 | 观察与证据 | 影响与合理解释 | 后续建议 |
| --- | --- | --- | --- |
| D1 | [旧连接矩阵](../project/connection-matrix.md) 声称四种 Direct/Secure/Relay 选择；当前 [useConnection.ts](../../packages/client/src/hooks/useConnection.ts) `useConnection` 固定 DirectConnection，API helper 用 fetch，stream 用 WS；在 client/src 和 server/src 扫描未找到所述 SecureConnection/ws-relay 实现 | 旧连接资料残留会让人追错安全边界和重连入口；历史功能可能已移除，本轮没有追完整删除历史 | 以 modules/F2 为当前导航；未来核对 Git 演变后给旧资料标记历史适用范围，不据“未找到”宣称全仓可删 |
| D2 | [bridge 持久化旧说明](../project/bridge-eventing-and-persistence.md) 最后仍说明 edit → thread/rollback；当前 [SessionCommandService.resume](../../packages/server/src/services/SessionCommandService.ts) 与 [codex.ts](../../packages/server/src/sdk/providers/codex.ts) `loadCodexForkBoundary` 走 source-preserving fork | 请求字段 rollbackNumTurns 名称保留了旧语义，旧日志清单不足以诊断新编辑链 | 使用 F4 的 fork 日志与原生新 ID；将来同步旧专题说明，不改变本轮既有文档 |
| D3 | [项目总览](../project/project-overview-and-status.md) provider 清单未列 Cursor；[server registry](../../packages/server/src/sdk/providers/index.ts) `getAllProviders` 和 [client registry](../../packages/client/src/providers/registry.ts) `activeProviders` 均有 Cursor | 文档快照较早；只看总览会漏 scanner/store/runtime/display 分支 | 以后 provider 变更同时复查两个 registry、policy、catalog、reader 和共享类型 |
| D4 | [main.tsx](../../packages/client/src/main.tsx) 仍注释要求同步 remote-main.tsx；当前源文件扫描没有该入口，index.html 只加载 main.tsx | 注释可能是旧入口清理后的残留；不能因此新建一个 remote-main 或恢复旧连接方案 | 用真实 HTML/Vite 入口确认；未来可单独清理注释，此轮仅记录 |
| D5 | [versioning.md](../project/versioning.md) §14 仍把 `DeviceBridgeService.ts` 写成当前解耦状态，并提到 `YEP_BRIDGE_REPO`。`packages/device-bridge`、`packages/android-device-server`、`packages/server/src/device/` 和 `/api/devices` 已不在 `635bf0a88` | 旧专题会让人去找已删除的串流实现。设置分类 `devices` 仍在，对应浏览器档案和推送 | 修订 versioning 的解耦表时删掉该行；不要把设置里的设备页恢复成远程控制 |

这些差异可由源码/文档直接比较确认；不需要推断线上故障。旧审计 [2026-10-15-code-audit-performance-correctness-redundancy.md](../project/2026-10-15-code-audit-performance-correctness-redundancy.md) 中的修复、误报与待验证项是**文档声称**，本地图未复验其全部结论。

## 重叠与风险候选

| 编号 | 观察到的事实 | 可能合理的解释 / 尚不能下的结论 | 建议核查方式 |
| --- | --- | --- | --- |
| C1 | [useSessionMessages.ts](../../packages/client/src/hooks/useSessionMessages.ts) 同时保留 projected/legacy；[routes/sessions.ts](../../packages/server/src/routes/sessions.ts) 旧详情还有 canonical overlay；[session-display.ts](../../packages/server/src/routes/session-display.ts) 提供新 source | 迁移/诊断/详情兼容可解释双路径；不是重复实现已无价值 | 修改展示先指定目标模型，再比较 F2 和对应 legacy/inspector 场景；没有删除建议 |
| C2 | [policy.ts](../../packages/server/src/sdk/providers/policy.ts) live 集合含 claude-ollama，但 [providers/index.ts](../../packages/server/src/sdk/providers/index.ts) `getProvider` 不解析它；Gemini discovery 与 name resolution 也有别名差异 | 保留历史数据识别或类型兼容可能合理；允许枚举不证明新建可用 | 先跟踪 validateRequestedProvider → resolveProvider 和历史读取，补矩阵说明；动态验证只使用隔离数据，不触发现有会话 |
| C3 | [SessionMetadataService.doSave](../../packages/server/src/metadata/SessionMetadataService.ts)、[NotificationService.doSave](../../packages/server/src/notifications/NotificationService.ts) 直接 writeFile；NotificationService.recordSeen 在保存前已广播；index/broker 使用不同的原子写/锁策略 | 进程内串行减少竞态，但不等于崩溃原子性或跨进程单 writer；保存失败后的内存/磁盘一致性待确认，尚无数据丢失复现 | 将来在临时目录做中断/并发 writer 实验，并先确认实际部署是否共享 dataDir；不要动真实状态文件 |
| C4 | 原生历史、runtime journal、Codex provider/bridge journal、server display、client snapshot 都可保存相关状态 | 分别服务历史、重连、生命周期、显示，不应武断合并；状态差异可能源于保留策略和时序 | 按 data 页逐层带上 ID/epoch/source/coverage 对齐；先找首次分歧，不通过清缓存掩盖原因 |
| C5 | [GitStatusPage.tsx](../../packages/client/src/pages/GitStatusPage.tsx) 仍导出 `GitStatusContent`，主路由 `/git-status` 重定向到 `/settings/source-control`；[SourceControlSettings.tsx](../../packages/client/src/pages/settings/SourceControlSettings.tsx) 继续导入该符号。`EmulatorPage.tsx` 已删除 | Git 页面文件仍是设置内容的实现，不是死路由。模拟器页面不再是复用候选 | 整理 Git 入口时只统计 `GitStatusContent` 的引用。不要按旧地图恢复 `EmulatorPage` |
| C6 | [routes/local-file.ts](../../packages/server/src/routes/local-file.ts) 与 [routes/local-image.ts](../../packages/server/src/routes/local-image.ts) 接受任意可读绝对路径 | 已决策（2026-10-21）：项目外文件预览不限制路径，只依赖 API 认证，见 [文件侧边预览统一设计](../project/file-preview-unification.md) | 已关闭；若将来支持多用户或不可信访问，需重新评估 |

## 未知项与具体解除条件

| 未确认事项 | 为什么本轮没有结论 | 后续要拿到的证据 |
| --- | --- | --- |
| 8022 的 commit、`BASE_PATH`、runtime 形态 | 调查当时未查端口。2026-10-20 用户重启后已只读核对，记录在 [consolidation.md](consolidation.md#8022-运行核对) | 已拿到 `/yep/api/version`、`/yep/build-info.json`、`/yep/api/status/workers`。4510 与 bridge 是否启用仍未查 |
| provider CLI / 生成 schema / 本机协议一致性 | 只读仓库参考与 adapter；未启动 CLI | 按 AGENTS 的 provider 参考/临时 probe 要求，在明确授权范围比较版本与响应；不得自动发模型请求 |
| 每种 provider 的完整状态/分叉/审批语义 | F4 深入 Codex，其余只盘点接线或抽样 reader | 每个 adapter 分别追同一用例，补故障分支和真实协议证据，不能靠 Codex 测试替代 |
| 认证关闭/开启、desktop token、反向代理前缀组合 | 中间件含明确路径比较，但未做带前缀请求 | 用隔离 Hono 测试检查 login、status、hook、WS upgrade 的矩阵；确认实际代理行为后再认定故障 |
| 推送、Feishu/OAuth/MCP、webhook、Worker/R2 | 注册只证明代码可达，外部凭据与投递情况未查看 | 外部账号配置和权限核对、测试目标的投递/回调证据；涉及给他人发消息须另获授权 |
| UI 的视觉、焦点、滚动、移动键盘与性能 | 没有浏览器/截图/设备；组件源码不能代替真实布局 | 用户明确授权后按 agent-browser 规则验证指定页面；本轮无 UI 通过声明 |
| 大会话的时延、内存与存储退化 | 有界代码/测试或历史 benchmark 不能推出当前性能 | 隔离大 fixture、测量环境与 buildId、CPU/内存/响应时延；真实数据先脱敏 |
| 磁盘满、损坏、并发存储、归档中途失败 | 没做故障注入，也未读现场文件 | 临时目录故障测试；核对 manifest/metadata/provider store 的恢复策略 |
| 桌面/移动安装与远程执行器 | 只确认入口和集成边界。设备串流包已删除，不再把 Android/Go sidecar 当作待验收实现 | 独立验收仍在的 Rust 壳、二进制来源与版本、目标 SSH 权限；不自动启动或替换已有进程 |

## 地图试用

以下是**只读桌面推演**，用于检查导航是否足够，不是已实施的修改或已复现的故障。

### 修改需求：新增一种工具结果的折叠预览，并保留按需详情

1. 从 capabilities 的“看工具造成的文件变化/阅读历史”进入 F2，先确定输入是 display 工具组还是 legacy raw message。
2. UI 页定位 `ToolRendererRegistry` 和 `canonicalizeToolName`，优先复用已有 tool renderer、`DisplayToolGroupRow`、`DetailPanel`；不能直接给 SessionPage 加一套并行工具名判断。
3. modules 定位 `SessionDisplayService` / `registerSessionDisplayRoutes`，data 页确认 preview 是有界派生数据，完整正文可能来自 history 或 details cache；检查 shared session-display schema 是否需要字段变化。
4. 主要影响面：server projection/详情、shared wire schema、工具 registry/具体 renderer、两种历史模式、嵌套 transcript、`en/zh-CN`；若只变视觉，不应无故触及 provider 执行协议。
5. 验证位置：F2 中的 display route/service/hook tests，工具 renderer 的 `__tests__`、typography 检查。真实折叠、长结果、移动详情操作仍需要后续获授权的 UI 验收。

**试用结果**：能定位输入来源、生产装配、复用组件和测试层；地图特别补入了一级内容 registry 与二级工具 registry 的区别，以及压缩 preview 不能当完整详情的约束。

### 故障问题：会话显示 waiting-input，但手机没收到提醒或点击后报“请求已处理”

1. 从 F3 进入 `SessionInteractionService.selectPendingInputOwner`，先分 process pending 与 bridge pending；由 data 页区分 ownership、activity、requestId 与 operation version。
2. modules 定位 `RuntimeController`：external 模式不能只看 web shell 本地 Supervisor；再查 EventBus → PushNotifier 的调用链。
3. 分别判断：缺请求/陈旧 provider 观测、没有订阅或通知类型关闭、已连接 browser profile 被过滤、发送失败与去重状态；“已处理”则看 broker 的 resolved/stale/CAS，而不是再次盲发 approve。
4. 复用对象：pending-input 查询、统一 command/interaction service、broker 操作身份。避免直接调用 provider 另建一条审批 writer。
5. 验证位置：F3 列出的 interaction/broker/push tests；F5 的 inbox tier 测试确认 badge 口径。若要确诊现场，还缺经过授权的 runtime/bridge 状态、脱敏 request/operation 身份和投递结果。

**试用结果**：能区分状态来源、通知决策和回答冲突三层，定位主要影响范围与复用入口；没有运行证据时只能列候选，不能宣称已找到根因。

## 本轮交付检查

- 已对七份文档执行本地链接/锚点、显式符号词元、表格列数、代码围栏和空白检查；逐页人工核对核心调用方向与三个 Mermaid 图的正文一致性。未调用 Mermaid 渲染器，不把静态结构检查写成渲染验收。
- 明确区分源码、历史文档声称和待确认项；没有把测试文件存在或测试名当作通过。
- 覆盖矩阵位于 README；外围子系统只盘点入口，第三方全实现、真实服务与 UI 验收不在本轮范围。
- 两个试用均能完成静态定位；未知项保留具体解除条件。下一轮应由实际修改或故障驱动核查，不自动开始重构。

2026-10-20 对照 `635bf0a88` 修订了过时事实：删除设备桥接入口，更正设置分类和 `/devices` 重定向，补上 dsh、工具合集耗时和本地图片/视频预览。F1–F5 的步骤未重写，两个试用未重跑，也没有新的运行证据。修订后七个文件的相对链接均能落到现存路径。
