# 会话文件改动：实施与逐步验收记录

日期：2026-09-21。  
对应：[开发与验收计划](./2026-09-21-session-tool-file-changes-development-plan.md)。  
状态：Codex／Pi 的首批工具驱动主链路已实现并完成下列离线验收；源码尚未部署。ZCode 原生 checkpoint artifact 接入及完整跨 provider 验收尚未完成，不能把本文理解为整份计划已全部完成。

## 1. 本次实现范围

- 新增共享 Zod 操作契约，区分确认写入、未决、失败、拒绝和逐文件部分结果。
- 新增不可变操作记录、内容对象、跨实例写锁、去重、终态冲突隔离、崩溃恢复与有界缓存。
- Codex 直连和 bridge 从成功的原生文件事件记录变化；历史读取支持 `patch_apply_end` 与新版 `item_completed → FileChange`。
- Pi 在原生 edit／write 的 operations 接口记录实际读取／写入内容，使用独立的持久化待投递目录传递给服务器，不把全文塞进通知。
- Codex／Pi 生产执行入口移除 `SessionFileLifecycle` 接线，不再在开始、结束或定时检查点扫描工作目录。旧采集模块保留供兼容读取和旧机制测试使用。
- 新文件索引按当前分支展示已确认操作的累计行数，详情默认展示单次操作 diff；只有 patch 时可以查看差异，完整内容按钮禁用并解释原因。
- 统计未知时展示“部分／未统计”，不伪造零值。旧快照标注为旧版工作区观测，不与新工具记录累计相加。
- 结构化历史结果中已存在 originalFile／content／patch 的其他 provider，可通过显式 `?source=operation` 兼容验证入口导入新账本；默认路径暂不切换，避免仅支持部分结果时隐藏旧列表中的其他文件。

## 2. 步骤结果与验收方式

“通过”仅指本表列出的验收范围。原计划更广的场景、真实模型调用和线上发布，不因单元测试通过就自动勾选。

| 步骤 | 已实施内容 | 本轮验收及结果 | 尚未覆盖／完成边界 |
| --- | --- | --- | --- |
| 0 协议与样例基线 | 核对实际版本、原生源码、历史 JSONL 与扫描调用入口 | Codex CLI 0.153.4；仓库生成 schema 0.151.0，已用本机 CLI 在临时目录生成 schema 核对本次使用的字段／状态；Pi 安装包 0.85.1／参考源码 0.84.2；ZCode CLI 0.16.9。真实样例找到原生子工具 FileChange | ZCode 旧 smoke 不兼容新版方法；未发起模型请求 |
| 1 数据契约 | identity、来源、逐文件结果、内容引用、patch 与状态校验 | `session-file-operation.test.ts` 5 项通过；共享类型构建通过 | 后续新增 provider 必须继续补充其状态映射，不能直接断言兼容 |
| 2 操作账本 | 原子对象发布、写锁、按 session 索引、冲突隔离、dirty 标记恢复、容量约束 | `operations.test.ts` 覆盖重复 100 次、两个写入实例、终态冲突、发布后崩溃、内容配额与旧对象可读性 | 不自动清理旧快照；对象回收仍需独立的引用保护策略 |
| 3 投影与行数 | 逐操作累计、当前 ancestry 过滤、工作区／session 隔离、未知统计 | 同文件 A／外部写入／A 不拼成首尾 diff；新增／删除、二进制、坏 patch、BOM、CRLF、结尾换行、空文件均有测试 | 没有实现额外的“净变化”视图；跨 session fork 的继承版本展示尚未完整接入，不能归为子 session 新写入 |
| 4 Codex 接入 | stdio observer、bridge 原生通知、rollout 历史导入、transport 重放去重 | adapter 5 项、历史导入 3 项、bridge 59 项及 Codex provider 回归通过；真实 JSONL 经 reader 与文件 API 返回正确记录 | 远端 environment 保守跳过，已验证不会读取本机同名路径；完整远端文件记录不是本轮交付 |
| 5 嵌套工具 | 直接消费 code-mode 子调用的原生 FileChange，不分析 JavaScript 意图 | 合成 135 行样例、真实历史样例和完整文件 API 均得到 `+135 / -0`；只有外层 exec 输出时不生成确认记录 | 没有原生子事件的其他执行器仍属未支持范围；不执行历史代码 |
| 6 Pi 接入 | 原生工具读写 operations 包装、磁盘 artifact、只含 ID 的通知、原生用户 entry 归属 | 真实已安装 SDK 的 write／edit／失败编辑／采集存储失败用例通过，并验证后来的用户消息不会改变工具归属；真实 Pi RPC 只读启动、加载扩展及 get_state 成功，无模型请求 | 未运行真实模型驱动的多轮 fork／resume 全场景；旧版不导出对应 SDK 能力时保留原工具并记录采集不可用 |
| 7 ZCode／其他 provider | 结构化历史成功结果的保守导入 | ZCode 风格 originalFile／content fixture 可得到准确差异；既有事件转换测试通过 | **原生 checkpoint artifact 读取尚未接入。** 新版 CLI 与当前项目的基础只读协议不兼容，见第 5 节；其他 provider 的旧路径仍有待收敛 |
| 8 文件 API | 新记录 ID、分支校验、内容按需读取、patch-only diff、独立 revision／缓存、旧快照兼容 | `session-saved-files.test.ts` 14 项通过；当前文件被外部修改后保存内容不变，其他分支不可读；并发读取共享身份扫描 | 保留有界索引与 truncated 提示，尚未提供超上限后的 cursor 翻页；其他 provider 的旧 diff 路径不在本轮全部替换 |
| 9 UI | 操作累计、单次 diff、未知统计标识、旧观测说明、中英文文案 | Inspector 19 项、保存面板 4 项、文件索引 hook 3 项通过；客户端类型检查通过 | 未运行浏览器自动化或截图验收 |
| 10 停用扫描／性能 | 移除 Codex／Pi／bridge 生产采集调用，增加隔离基准脚本 | 源码入口不再引用 captureWorkspace／SessionFileLifecycle；10／10,000／100,000 无关文件、1／4／8 并行 session 基准通过隔离断言 | 基准不包含模型生成、完整 transcript 加载或浏览器渲染耗时 |
| 11 发布准备 | CHANGELOG、旧机制说明、资源打包清单、本验收记录 | 新 Pi 资源加入两个 bundle 资源清单；格式与类型检查执行；代码、原始历史及现有服务保持可分别审阅 | 未提升正式版本、未发布、未运行 hot-apply 或重启现有服务；正式部署仍需明确授权 |

## 3. 真实样例的证据纠正

最初调研只定位到 `exec` 的源码与外层 `{}` 返回，不能据此证明子调用成功。实施时继续检查该 rollout 中的 `event_msg.item_completed`，发现实际另有：

- `item.type = FileChange`；
- 独立的 `exec-…` 子工具 ID；
- 明确的原生 thread／turn 身份；
- `status = completed`；
- `changes[path] = {type: add, content: …}`，包含完整的新增 Markdown。

因此该样例不需要解析、求值或运行 JavaScript。实现使用原生子工具证据，外层代码中的路径不参与确认归属。

真实验收分两层，数据都写入一次性临时目录，完成后删除：

1. 原生 JSONL → 历史 adapter → 操作存储 → 文件投影。
2. 复制同一 JSONL → 真实 `CodexSessionReader` → Hono `/files` 请求 → 新索引。

两层都返回一条确认操作，路径 `docs/api-testing/oncall_alerting.md`，行数 `+135 / -0`，来源 `operation`。第二层 HTTP 状态为 200。没有从该项目当前文件或旧目录快照反推差异，也没有向运行中的 8022 服务写入测试数据。

## 4. 测试命令与结果

2026-09-22 提交前复审补充：修复实时通知与历史导入中文件顺序不同导致同一操作被误判为冲突的问题。新增两项回归分别覆盖实时先到／历史先到，确认重放不改变 revision、两个文件各计数一次，内容不同仍隔离为真实冲突。两项用例在修复前失败、修复后通过；重跑 `test/session-files` 与 `test/routes/session-saved-files.test.ts` 共 63 项通过，其中包含实际安装 Pi SDK 的两项集成用例。

集中回归：服务端 15 个测试文件、325 项通过；客户端 3 个测试文件、26 项通过；共享层 2 个测试文件、18 项通过。其后为 BOM、CRLF、结尾换行和空文件补充 4 项，相关操作／路由的 26 项聚焦测试通过；另补充 Pi 内容配额耗尽时仍保留文件身份的用例，Pi 4 项（含实际 SDK 2 项）通过，并核对并发导入不重复记录。当前累计覆盖 374 个不同测试用例。后续对本模块继续修改时，按涉及范围重跑，不把旧结果当作新修改的验收。

```bash
pnpm --filter @yep-anywhere/shared build
pnpm --filter @yep-anywhere/shared test -- test/session-file-operation.test.ts test/session-files.test.ts
pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/client exec tsc --noEmit

FILE_OPERATION_TEST_PI_SDK=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  pnpm --filter @yep-anywhere/server test -- \
  test/session-files \
  test/routes/session-saved-files.test.ts test/routes/session-files.test.ts \
  test/codex-bridge/CodexBridgeService.test.ts test/sdk/providers/codex.test.ts \
  test/sdk/pi-provider.test.ts test/sdk/pi-user-entry-echo.test.ts \
  test/sdk/pi-retry-status.test.ts test/sdk/pi-extension-credentials.test.ts \
  test/sdk/providers/zcode-events.test.ts

pnpm --filter @yep-anywhere/client test -- \
  src/components/__tests__/SessionInspector.test.tsx \
  src/components/__tests__/SessionSavedFilePanel.test.tsx \
  src/hooks/__tests__/useSessionFileIndex.test.ts
```

`FILE_OPERATION_TEST_PI_SDK` 必须指向待验收机器实际安装的 Pi SDK。未设置时，两个安装包集成用例会明确 skip，不能把 skip 写成通过。本机集中回归设置了该变量，两个用例均实际运行。测试使用独立 Node 子进程加载 SDK，避免仓库 Vitest 的 `source` 条件错误地选择全局包中未发布的源码文件。

另用真实 `/opt/homebrew/bin/pi --mode rpc --no-extensions --extension …` 在临时 agent/session 目录发送一次 `get_state`，验证扩展安装路径解析：成功响应、零 extension error、零模型请求。曾发现并修复 `require.resolve` 无法解析仅提供 ESM import 导出的 Pi 包的问题，改为从真实 CLI 安装位置读取其公开 import 入口。

客户端旧测试仍会输出已有的 React `act(...)` 提示；测试通过不表示做过浏览器视觉检查。

## 5. ZCode 未完成项与具体解除条件

本机 App 版本 3.14.0，内置 CLI 报告 0.16.9。执行已有只读 smoke 的结果：

1. 原始 App bundle 路径启动失败，CLI 定位内置 provider config 的相对路径与实际 bundle 布局不匹配。
2. 使用临时目录中的 CLI／config 符号链接提供它期望的布局，不修改应用安装目录或用户配置后，进程可以响应，但返回 `Method not found: workspace/readState`。
3. 因此不能继续拿仓库面向旧 CLI 的协议断言当作当前 artifact 读取接口事实。没有臆造新的 artifact RPC，也没有自动安装 ZCode hook 插件。

解除条件是：先完成当前 ZCode CLI 的基础协议能力核验／兼容适配，并让只读请求通过，再接入 checkpoint artifact 与 rewind 的原生关系。该部分应单独评审，不为了文件索引功能把整套 provider 协议静默升级。

目前只接入了有明确结构化结果的历史文件事实；它不等同于原生 artifact 接入，也不构成第二批完整验收。

## 6. 性能与并发隔离基准

脚本：`scripts/benchmark-session-file-operations.ts`。

```bash
pnpm exec tsx --conditions source scripts/benchmark-session-file-operations.ts --sizes=10,10000,100000
```

环境：macOS arm64、Node v25.9.0。每组重复 5 次。创建无关文件的时间不计入统计；计时覆盖确认事件入库、冷索引投影、一次暖 revision 读取。每个 session 仅记录自己的一个文件，脚本对文件数、文件名和新增行数作断言。

| 无关文件数 | 1 个 session 中位数 | 4 个并行 session 中位数 | 8 个并行 session 中位数 |
| --- | --- | --- | --- |
| 10 | 39.94 ms | 172.62 ms | 384.96 ms |
| 10,000 | 38.16 ms | 163.42 ms | 365.62 ms |
| 100,000 | 38.71 ms | 149.99 ms | 360.86 ms |

这些是每组全部 session 完成的耗时，不是单个请求的平均耗时。目录规模从 10 增到 100,000 没有导致耗时增长。持久化 fsync、内容配额写锁及操作数量仍有成本；不把结果描述为“零开销”。另外，adapter 测试在工作区路径根本不存在时仍能完成记录和投影，证明计算不依赖读取磁盘上的工作文件。

## 7. 数据边界、兼容与回滚

新目录为 `<dataDir>/session-file-operations/`，与旧 `session-file-snapshots/` 分开。

- 内容对象默认单个最多 8 MiB，累计保留原始内容预算 256 MiB，内容相同按哈希去重。此预算是已记录内容的保存限额，不是扫描工作目录的预算。
- 每 session 最多 20,000 个操作身份、按紧凑 JSON 计量的 64 MiB 操作记录；单个内存快照保留最多 5,000 个操作／32 MiB，文件列表最多 500 个路径，超限返回 truncated。
- 统计每个文本 diff 最多 25ms，单次投影有 250ms 总时间预算；超时保留文件与未知统计标识。
- Pi 通知只传 artifact ID；成功导入账本后删除待投递副本。待投递目录也有条目数／字节预算，避免导入失败时持续无界积累。
- 新内容缺失、损坏或超限，不改读当前工作区。操作冲突从已确认统计中隔离。
- 原始 provider 会话不修改；旧快照只读保留，不做自动删除或强制升级。
- 没有工具事实时，不以 Shell 字符串、助手总结或当前 Git 状态补齐“已确认修改”。

回滚以停止新采集或退回上一已发布包为边界，新目录和旧目录分离。没有实施自动数据回收。若回滚到仍启用目录扫描的旧正式版本，其旧行为需要在发布说明中明确，不能把它称作新架构的自动安全回退。

## 8. 当前交付与后续顺序

当前可审阅的是 Codex／Pi 首批核心实现、真实样例恢复、相关 UI 与测试。其余明确未完成的工作包括：ZCode 原生 artifact 适配；全部 provider 的旧 diff 路径收敛；完整跨 session fork 继承版本展示；超出索引上限后的 cursor 翻页；受保护的对象回收策略。

这些项不能在原开发计划中整体勾选通过。继续开发时优先处理 ZCode 基础协议前置兼容，再补齐其他 provider／分支场景的 fixture 和 API 验收。线上部署、runtime 重启和浏览器自动化保持独立状态，不因本轮开发授权而自动执行。
