# 会话文件改动改为工具驱动的开发与验收计划

日期：2026-09-21  
状态：实施中。Codex／Pi 核心链路已在工作树切换，逐步结果见[验收记录](./2026-09-21-session-tool-file-changes-acceptance.md)；尚未部署。本文的验收清单是完整目标，不表示全部已通过。  
范围：会话文件索引、改动行数、保存内容与 diff；重点替换 Codex／Pi 的工作目录扫描采集。  
关联：[现有 Session 文件快照说明](./session-file-snapshots.md)。

本轮实施结果逐步记录在[验收记录](./2026-09-21-session-tool-file-changes-acceptance.md)，包括已通过的测试、真实样例回放、性能数据和未完成项；请以该记录判断当前完成范围，不把以下目标清单当作已实现能力。

## 1. 要解决的问题与最终交付

用户需要回答的是“这个 session 通过工具改了哪些文件、具体改了什么”。现在 Codex／Pi 使用执行窗口内的工作目录前后快照，只能证明“这段时间磁盘发生了变化”，不能证明变化属于该 session。

目标是建立按工具执行归属的文件变更记录：

- 文件列表、行数和 diff 来自本会话实际执行的工具操作。
- 保存内容仅针对操作涉及的文件，优先复用 provider 已提供的内容和 patch。
- 同目录的其他 session、外部编辑器和后台进程不会因为时间重叠而进入本会话统计。
- 历史差异不依赖当前磁盘，不因后续编辑、删除或 Git commit 改变。
- 普通 Shell／未知 MCP 没有文件变更证据时，保留能力边界，不用全目录扫描补齐归属。
- 新执行不再调用工作目录全量快照，不再运行 15 秒目录采集定时器。

本文最初交付为开发计划，目前已进入实施，结果见验收记录。开发阶段不自动部署、重启或修改第三方应用配置；部署与浏览器检查继续遵循项目 AGENTS.md 的授权边界。

## 2. 已确认的现状与调研依据

### 2.1 当前实现

| 项目 | 现状 | 影响 |
| --- | --- | --- |
| 文件枚举 | Git 项目使用 `git ls-files`，普通目录递归枚举 | 枚举范围是工作目录，不是当前工具涉及的文件 |
| 内容读取 | 逐个检查并读取文件；默认单文件 2 MiB、总量 64 MiB、枚举 20,000 条目 | 未修改文件也消耗预算；内容去重不免除前置读取 |
| 采集时机 | 执行前、执行后，以及上次采集结束约 15 秒后的检查点 | 长轮次和多 session 重复付出扫描成本 |
| 归属 | `observed-during-execution` | 无法排除其他写入者 |
| Codex／Pi 文件 API | `session-display.ts` 优先使用快照记录 | 原有工具记录解析没有用于这两类 provider 的主文件索引 |
| 其他 provider | 仍有 transcript 工具提取路径 | 不能直接认为旧路径全部准确；部分 diff 会从当前工作区逆向重建 |
| 本会话上一轮修复 | 解释覆盖原因；用最近一次快照补行数；区分全局覆盖与单文件差异 | 可保留有用的 UI，但没有解决归属和扫描问题 |

主要入口（均为仓库相对路径）：

- `packages/server/src/session-files/{capture,lifecycle,changes,reader,store,types}.ts`
- `packages/server/src/routes/session-display.ts`
- `packages/server/src/sessions/{session-file-activity,session-file-changes,file-index-cache}.ts`
- `packages/shared/src/session-files.ts`
- `packages/client/src/components/{SessionInspector,SessionSavedFilePanel,SessionFileDiffPanel}.tsx`
- `packages/client/src/hooks/useSessionFileIndex.ts`

### 2.2 本次问题的真实回归样例

截图会话 `01a0c206-885c-7aa2-bd1a-00cbebbd9409` 的文档路径是 `docs/api-testing/oncall_alerting.md`。

已核对的事实：

- 结束快照达到 64 MiB 总量预算；2,162 个条目因预算不足被跳过，25 个文件超出单文件上限。
- 文档保存版本本身完整，新增 135 行。
- 原生 JSONL 中创建文档的可见调用是 `custom_tool_call`，工具名为 `exec`；其代码内部调用 `tools.apply_patch(...)`。
- 对应外层返回显示执行结束以及 `{}`，单凭它不能确认任意子调用。实施时进一步检查发现，同一 rollout 另有 `item_completed → FileChange`，携带子调用 ID、原生 turn ID、`status: completed` 和完整新增内容；新实现直接使用该证据，不解析 JavaScript。
- 随后的另一条 `exec` 调用只是用 Python 检查文档；看到命令里有该路径不代表这条调用修改了它。

因此，迁移不能只测试顶层 `Edit` 或原生 `fileChange`。嵌套执行器是首批交付的必测项。禁止执行历史 JavaScript 来提取 patch，也禁止通过“代码中出现 apply_patch + 外层成功”无条件认定修改已完成。

测试应从该结构制作最小合成 fixture，文档内容、用户路径和业务信息不提交进测试仓库。

### 2.3 同类产品的可确认做法

| 产品与证据 | 可确认的行为 | 本项目采用的原则 |
| --- | --- | --- |
| WorkBuddy 5.5.6 本机 CLI 与[官方自动备份说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes) | 检查点代码匹配成功的 Edit／Write／MultiEdit 调用；已有文件首次修改前备份；记录会话的 tracked file backups | 由工具确定范围，按需留存版本 |
| ZCode 3.14.0 本机 `zcode.cjs` | 成功结果中的 `filePath`、`originalFile`、`content`、`structuredPatch` 被保存为关联 session／turn／toolCall 的 artifact，再产生 `checkpoint.created` 和行数汇总 | 操作证据、版本内容、归属身份一并保存 |
| Qoder [文件检查点](https://docs.qoder.com/cli/sdk/checkpoint)与[回退说明](https://docs.qoder.com/cli/undo-restore) | 文件检查点跟随会话文件编辑工具；Bash 直接写文件不属于可回退文件快照范围 | 明确未知写入的边界 |
| Qoder [工作区 diff](https://docs.qoder.com/cli/review-changes) | `/diff` 是 Git 工作区视图 | 工作区状态与会话操作记录分开 |

本机源码位置：

- `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy.js`
- `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`

这些结论针对上述文档和已检查的代码路径，不代表这些产品的所有功能都采用同一种实现，也不代表它们能解决任意跨进程并发写入。

### 2.4 Provider 接入证据与待验证项

| Provider／入口 | 已确认 | 实施前必须验证 |
| --- | --- | --- |
| Codex app-server | 本地参考协议包含 `fileChange`、`changes[].path/kind/diff`、`PatchApplyStatus`；`turn/diff/updated` 是轮次汇总更新 | 已安装 CLI 的实际通知次序、最终 item 是否完整、重放是否保留 patch、嵌套 exec 是否产生子操作证据 |
| Codex Yep journal | `item/fileChange/patchUpdated` 和 `turn/diff/updated` 在 `journal-retention.ts` 的 delta 排除集合中 | 不能假定这些流式内容重启后仍在；需要持久化最终文件事实，而非恢复全部 delta 日志 |
| Pi | 参考源码存在 `tool_call`、`tool_result`；edit 返回 `details.patch`，write 成功结果没有完整旧内容 | 实际依赖版本是否一致；扩展参数变更顺序；如何在真正读写边界取得准确 preimage |
| ZCode | 原生 checkpoint artifact 有文件前后内容和 patch；Yep 当前将 `checkpoint.created`／`rewind.triggered` 当作无输出事件 | artifact 的实际读取协议、权限、保留时长、分支语义；不能臆造 app-server 请求字段 |
| Claude 等已有 transcript 路径 | 已有 Edit／Write／Patch 提取器 | 缺失结果是否被误算成功；截断结果、覆盖写、部分失败和当前磁盘依赖 |

Codex 依据：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server?translationFallback=zh-Hans)、`references/codex/codex-rs/app-server-protocol/src/protocol/v2/{item,turn}.rs`。实际集成以本地 CLI 版本、生成 schema 与回放样本一致为准。

Pi 依据：`references/pi/packages/coding-agent/src/core/tools/{edit,write}.ts` 和 `core/extensions/{types,runner,wrapper}.ts`。参考代码中的编辑队列仅能证明对应实现内的串行行为，不能当成跨进程锁。

## 3. 范围、原则与不变量

### 3.1 交付范围

首批必须完成：公共记录层、Codex 直连与 bridge、Pi、嵌套工具执行验证、现有文件 API／UI、旧数据兼容、停用新执行的全目录扫描。

第二批在同一数据契约上接入 ZCode 原生 artifact，并收敛其他已支持 provider 的工具解析。WorkBuddy 和 Qoder 只作为调研参考，本计划不新增这两个 provider。

首批可独立交付，但不能宣称所有 provider 已迁移。若实际样例的嵌套写入证据仍拿不到，首批不满足完整验收，必须列出具体缺口；其他独立步骤仍可完成。

### 3.2 必须保持的约束

1. 实际执行的变更、尝试执行的变更、文件读取和路径引用分别处理。
2. 每条操作有稳定的 provider／执行源／session／分支／turn／tool 身份；显示路径不是记录主键。
3. 不以时间邻近、助手文本、Git dirty 文件集合或全目录 watcher 推断写入者。
4. 不把发送审批、工具开始或输入 patch 当作成功结果。
5. 工具失败不等于一定没有写入；有明确部分落盘证据时只确认该部分，其余保持未知。
6. 收到工具结果以后再读当前磁盘，只能得到当前观测，不能冒充该工具写入后的版本。
7. 文件完整内容是否可预览、操作 patch 是否完整、会话覆盖是否充分，使用不同状态表达。
8. 无法计算的行数为未知，不伪造 `0`；二进制修改保留文件条目。
9. 不修改 provider 原生 session 文件，不把文档中的规划 schema 当作已有协议。
10. 原始证据必须先保存，派生索引可重建；不再复制整份 transcript 建立第二套权威会话库。

## 4. 目标数据流与统计口径

### 4.1 数据流

```text
provider 原生文件事件 / 工具实际执行结果 / 可验证的执行边界记录
  → provider adapter：解析身份、执行状态、文件证据
  → 操作记录与必要内容对象持久化
  → 当前分支的 session 文件索引（可重建、带 revision）
  → 文件列表 / +新增 -删除 / 操作 diff / 已保存版本
```

当前工作区文件和 Git 面板仍通过各自入口访问，不能参与历史操作 diff 的计算。

### 4.2 公共记录模型（设计草案）

最终由 shared Zod schema 定义，再推导 TypeScript 类型。至少包含以下概念：

| 字段组 | 内容及含义 |
| --- | --- |
| identity | schemaVersion、provider、执行源标识、sessionId、branch／ancestry 身份、turnId、toolCallId／itemId、子操作编号 |
| ordering | provider 原生顺序／来源 revision、首次观测时间、最终结果时间；不能只按时间排序 |
| source | native-file-event、tool-result、instrumented-write、historical-tool-record；保留原始证据引用 |
| outcome | pending、applied、partially-applied、failed、declined、unknown；另有逐文件结果 |
| changes | 旧路径／新路径、add／modify／delete／rename／mode-change、稳定的文件操作身份 |
| evidence | 原始 patch、格式版本、是否截断、before／after 内容引用与哈希、缺失原因 |
| accuracy | 归属证据、patch 完整性、内容完整性、版本链连续性，分别表达 |
| stats | additions、deletions、scope、availability；可精确计算才写数值 |
| projection | 是否仍在选中分支；rollback／fork 后重算可见性，不删除原始操作 |

同一工具从 pending 更新到终态是一次操作的状态演进；重复通知不是新操作。一个工具改多个文件时，每个文件是同一操作下的独立条目。

工具 ID 的作用域至少包含 provider、执行源和 session。bridge 和 provider 同时看见同一事件时，需要映射到同一原生操作身份；不要使用本机接收时间或两个 journal 各自的 sequence 做跨源去重。

### 4.3 列表、详情与行数

- 默认文件列表展示当前分支中有已确认变更证据的文件。曾修改后恢复原内容的文件仍可查看操作历史，不因净差异为零而消失。
- 默认 `+N / -M` 定义为“本会话当前分支内已确认操作的累计新增／删除行数”，每个操作只统计一次。中英文界面明确这一口径。
- 详情默认打开最近一次已确认操作的 diff；提供该文件的操作列表，可跳转到对应消息。列表的累计数与单次操作数明确标注。
- 例如两次操作先新增 3 行、再删除同样 3 行：累计为 `+3 / -3`；连续版本链可另展示净变化 `+0 / -0`，不能把两种口径混用。
- 仅在相邻操作的 afterHash 与下一次 beforeHash 一致，且内容、顺序、分支完整时，才可合并连续链计算净变化。中间插入外部编辑时切断链；即便每次操作可准确归属，也不能把整条首尾 diff 全归给本会话。
- 只有轮次累计 diff、没有可拆分的操作 patch 时，保留 turn 级证据及统计口径，不能与同轮 tool 统计相加。原生 tool 事实齐备后替换这一回退来源。
- 有未知统计的操作时，总数必须标记为已知部分；不能显示一个没有说明的精确总数。API 同时给出已统计和未统计操作数量。
- 只有 patch 时也应能展示 diff；没有完整 after 内容时不提供伪造的 Markdown 全文预览。

这是有意替换上一轮“最近一次快照行数”的口径；前后端契约和文案必须一起变更，避免相同字段被静默换义。

## 5. 分步实施与逐步验收

每一步完成后记录：修改文件、测试命令、实际结果、尚未覆盖的能力。以下路径中新增模块和测试文件为拟定路径，不表示当前已存在。

### 步骤 0：建立协议与真实样例基线

**依赖：** 无。此步只读，不接管现有服务。

**怎么做：**

1. 记录当前工作树基线，区分已有快照／行数修复与本次迁移修改，保留无关改动。
2. 核对 Codex CLI／schema、Pi 安装依赖、ZCode 本机版本；记录版本和能力矩阵。
3. 为直接 patch、嵌套 exec、覆盖写、删除、多文件部分失败、拒绝、分支回退各保存最小脱敏 fixture。
4. 追踪本次 `exec → tools.apply_patch` 的生产端、原始输入输出、可能的子调用事件和重启后历史来源。明确是否已有稳定子调用 ID、实际执行状态和完整 patch。
5. 对照旧链路确认 `turn/diff/updated` 等内容何处不落日志，避免只验证实时展示。
6. 记录旧方案的目录枚举次数、读取文件数／字节、只读 turn 的采集开销，作为性能对照。

**产物：** provider 能力矩阵、最小 fixture、现有采集调用图、基线报告。

**验收：**

- [ ] 已列出每种入口可取得的身份、成功状态、patch、before、after，以及缺失字段。
- [ ] 对真实 Markdown 样例能解释工具证据链，不能只引用磁盘快照证明归属。
- [ ] 所有“待验证能力”明确列出；不能把原生 fileChange 覆盖范围推广到任意 exec。
- [ ] 未运行模型请求、重启服务或安装插件来伪造验证完成；需要这些动作时单独列出条件。

### 步骤 1：冻结数据契约与状态机

**依赖：** 步骤 0。

**怎么做：**

1. 扩展 `packages/shared/src/session-files.ts`，或拆出独立 `session-file-change-schema.ts`，以 Zod 为事实来源。
2. 定义第 4 节中的操作身份、逐文件结果、证据、统计 scope 和缺失原因。
3. 定义状态转换与冲突规则：迟到 started 不覆盖终态；重复 completed 不增加计数；相同身份但不同最终内容进入诊断状态，不能任意最后写胜出。
4. 定义全局 capability／coverage 与单文件 content／diff 状态；移除一个 `complete` 布尔值承载所有含义的设计。
5. API 增加 schema／统计语义版本，使旧客户端降级显示而非误读行数。

**产物：** schema、状态机说明、共享类型、契约测试。

**验收：**

- [ ] 拒绝结果缺失但被标为 applied 的无证据记录；字段允许有明确来源的能力差异。
- [ ] 同路径不同 session、同 tool ID 不同执行源、同调用不同文件互不冲突。
- [ ] 未知行数、二进制、有 patch 无全文、部分失败均可表达。
- [ ] schema round-trip、坏输入和兼容旧 API 的测试通过。

### 步骤 2：建立持久化操作账本与可重建索引

**依赖：** 步骤 1。

**怎么做：**

1. 在 `packages/server/src/session-files/` 新增操作 recorder／store／projector，复用现有内容寻址、原子写和哈希校验能力。
2. 新记录使用独立版本／目录命名，不能写入旧 `FileChangeRecord` 后让旧代码误读。
3. 先保存 blob／patch，再发布操作终态，最后更新 session revision 和派生索引；崩溃后可重放重建。
4. 记录待处理操作的有界状态；超时或进程断开标为 unknown，不推测成功，不读全目录“补完”。
5. 明确多写入实例的所有权及锁／CAS 方案；同一操作重复提交幂等，两个不同操作不能互相覆盖。
6. API 使用索引摘要，内容和完整 patch 按需读取；继承 `FileIndexCache` 的同版本并发合并能力。
7. 单对象与总存储配额必须有界，但超限只影响涉及的内容／证据，不把不相关文件隐藏。具体数值在基线结果后确定并写入配置说明。
8. 首批不自动删除旧快照；新对象回收采用明确引用与保留策略，禁止按 blob 文件时间直接删除仍被引用的内容。

**产物：** 新账本、revision、索引、恢复与配额策略。

**验收：**

- [ ] 100 次重复同一终态仅产生一个逻辑操作；重复读取不重新解析全部历史。
- [ ] 在 blob 写入后、终态发布前、索引更新前分别模拟崩溃，重启后无伪造成功、无错误计数。
- [ ] 损坏／缺失一个内容对象只影响该文件预览，文件索引和其他文件仍可读。
- [ ] 多写入实例和迟到响应测试通过；失败构建不会永久污染缓存。
- [ ] 不通过该模块遍历工作区或读取未涉及文件。

### 步骤 3：实现独立于 provider 的差异计算与分支投影

**依赖：** 步骤 2。

**怎么做：**

1. 从 `session-file-changes.ts`、`edit-raw-patch.ts` 提取可复用的 patch 解析与计数逻辑。
2. 支持新增、修改、删除、显式重命名、空文件、无结尾换行、CRLF、Unicode、权限位变更和二进制。
3. 从真实执行 patch 或保存的 before／after 计算；未知旧内容的覆盖写不能当作文件新增。
4. 按原生 ancestry／rollback／fork 规则投影当前分支。子 session 的操作不自动归到父 session；如需展示，只提供显式关联入口。
5. fork 继承历史采用来源引用或可重建映射，保留原作者身份；同一继承操作不复制计数。
6. 采用第 4.3 节的累计口径，并在 hash 连续时允许另算净变化。
7. diff 计算设置单任务与总 CPU／内存预算，超时返回明确的 unavailable 状态。

**产物：** diff／统计服务、分支投影、纯逻辑测试。

**验收：**

- [ ] 同 session 新增 3 行又删除 3 行，累计 `+3 / -3`；净变化仅在连续链模式为零。
- [ ] A 修改后 B 插入一行再由 A 修改：A 的两次操作可查看，B 的行不进入 A 的累计，A 的首尾链被判为不连续。
- [ ] rollback／fork 后只显示选中 ancestry，直接按 record ID 请求隐藏分支也不可越权读取。
- [ ] 修改、删除或 commit 当前磁盘后，保存的 diff 和统计不变。
- [ ] `+++`／`---` 文件头与“无结尾换行”标记不被误计为内容行。

### 步骤 4：接入 Codex 原生文件事件与历史重放

**依赖：** 步骤 0～3。

**怎么做：**

1. 从已生成的 Codex 协议类型及参考源码实现 adapter，不手写猜测协议。
2. 在 `packages/server/src/codex-events/` 的事件归一化／投影边界提取 `fileChange`；根据原生 status 区分 pending、completed、failed、declined。
3. `patchUpdated` 为同 item 的更新，不逐次累加；最终记录与历史 hydrated item 合并去重。
4. 将 `turn/diff/updated` 当作轮次汇总更新，不能按通知次数累加，也不能与逐工具记录重复计数。
5. 在现有 delta 丢弃策略之前留存必要的最终文件事实；优先复用最终 item，不恢复无限增长的原始流日志。
6. Codex 直连、4510 bridge、不同账号路径均进入同一语义 recorder；确定一个写入所有者，另一端只消费，或以原生身份幂等合并。
7. 远端环境仅消费远端的内容／patch，不读取服务器本机同名路径；路径标识包含执行环境。
8. 完整历史从原生 item／rollout 恢复；只恢复有实际结果的操作，缺失结果留为 unknown。

**产物：** Codex adapter、最终事实持久化、直连／bridge fixture 与重放测试。

**验收：**

- [ ] started、patchUpdated、completed、turn diff、历史 item 同时出现时只统计一次。
- [ ] refused／declined 为零已确认修改；failed 多文件调用不把全部输入 patch 判成功。
- [ ] 断线重连、重复转发、服务进程重新创建后结果一致。
- [ ] 两个 session 在同目录交错修改不同文件，结果严格分离。
- [ ] 远端与本机同名文件测试证明没有错误本地读盘。
- [ ] 最终事实在 journal 不保存 delta 的模式下仍可恢复。

### 步骤 5：处理嵌套 exec／code-mode 工具调用

**依赖：** 步骤 0 的证据核实、步骤 2～4。

**怎么做：**

1. 查明 `exec → tools.apply_patch` 的实际工具执行端能否提供子调用事件。已有事件时保留 parentCallId、子调用稳定 ID、输入 patch、实际执行结果与错误。
2. 如执行端为 Yep 可扩展组件，在实际 apply_patch／Edit／Write 包装层产生结构化子操作记录；若为外部工具服务，需要其暴露结果契约，不能仅修改前端解析器假装获得该能力。
3. 对不具备子事件的历史记录，允许有界静态语法解析提取“候选操作”。只接受可解释的字面量、稳定调用结构；动态拼接、条件分支、循环、多调用返回丢失均不得升级成确定执行记录。
4. 候选 patch 只有在能绑定具体子执行结果时才进入已确认统计；否则展示为无法验证的历史候选，不混入精确总数。
5. 禁止 `eval`、`new Function` 或运行历史脚本。不能靠路径名包含 `.md`、stdout 提到成功或助手宣称完成判断文件实际变更。
6. 将真实样例的创建和随后只读校验拆成两个 fixture：前者验证捕获能力，后者不得产生写入条目。

**产物：** 嵌套调用 adapter／执行端契约、保守的历史解析、能力缺口说明。

**验收：**

- [ ] 直接 apply_patch 与同一 patch 的受支持嵌套执行均产生一致的逐文件操作事实。
- [ ] 未执行的条件分支、只构造 patch 字符串、子调用失败被 catch、外层成功但子结果丢失，不产生已确认改动。
- [ ] 同一次 exec 的两个子 patch 不遗漏、不重复，且可追溯到各自结果。
- [ ] 新采集的同构 Markdown 场景准确显示 `+135 / -0`，不依赖全目录扫描。
- [ ] 对现有历史样例，能取得充分子执行证据则回填；否则明确保留旧观测／未知状态，不能把旧快照改标为工具确证。

**完成边界：** 若外部执行端无法提供必要信息，记录所缺事件与最小接口需求。本步骤不能以“顶层 fileChange 已支持”代替验收通过，也不通过重新开启目录扫描掩盖缺口。

### 步骤 6：接入 Pi 的实际工具读写边界

**依赖：** 步骤 0～3。

**怎么做：**

1. 在 `pi-yep-extension.mjs` 与 `sdk/providers/pi.ts` 接入工具身份和结果，复用原生 session／entry／toolCallId。
2. edit 优先读取成功结果的 `details.patch`；兼容实际安装版本的 oldText／newText 或 edits 数组格式。
3. write 覆盖旧文件需要 preimage。优先使用 Pi 工具 operation adapter 或经过验证的包装，使读取、真实写入及结果记录位于实际工具执行边界。
4. 单独 `tool_call` handler 提前读取的内容不能自动认定为准确 preimage：后续 handler 可能改参数，审批可能被拒绝，其他执行可能先写入。必须验证最终参数与真实读写位置。
5. 尽量从工具已经读取的字节和将要写入的内容产生记录，避免 post-hook 再读盘误收其他进程的写入。
6. 新增、覆盖、删除、错误／中断分别确认实际副作用；写入后取消但返回 error 的情况不能简单丢掉已落盘证据。
7. 通过持久化的有界数据通道保存记录，不把整文件塞进 UI 通知前缀或临时 stdout 并假定可以长期回放。
8. 不改 Pi 的匹配规则、权限审批、工具返回含义及 session tree；其他自定义工具没有可靠写入事件时报告能力边界。

**产物：** Pi adapter／扩展读写采集、原生 entry 关联、重放支持。

**验收：**

- [ ] edit 的单块、多块、CRLF 和 BOM 场景与真实工具结果一致。
- [ ] write 新建与覆盖分别计算正确行数；没有 preimage 时不虚报删除为零。
- [ ] 参数被其他扩展改变、审批拒绝、写入后取消三类场景没有假记录。
- [ ] fork、resume、重载扩展和重启后，记录不串分支、不重复注册或计数。
- [ ] 工具之外的同目录文件不被读取；普通 Bash 不触发目录扫描。

### 步骤 7：完善 ZCode 与其他现有 provider 的证据接入

**依赖：** 步骤 1～3；ZCode 需要步骤 0 的协议核验。可独立于首批 UI 开发推进，但单独标记完成状态。

**怎么做：**

1. ZCode 从本机 CLI bundle 核实 `checkpoint.created`、artifact 和 rewind 的真实协议，用临时 app-server 做只读 schema 探测。
2. 替换 `zcode-protocol/events.ts` 对相关文件事实的直接忽略；在合适的原生事件层消费 artifact，避免把 artifact 全文复制成聊天消息。
3. artifact 引用限定在当前 session／执行源，按 provider 支持的读取接口读取并持久化必要内容；不接受任意本机路径或任意 URL 作为内容读取授权。
4. 不代替用户安装 ZCode hook 插件，不修改 `~/.zcode`。涉及安装的能力单列依赖。
5. Claude 等已有路径复用 `originalFile`、实际结果和 patch，修复“没有结果也按输入统计”的情况。
6. 逐个记录 provider 能力；没有可靠写入证据的工具保留工具日志，不能靠模糊工具名、Shell 路径猜测升级成已确认修改。
7. 去掉这些会话历史 diff 对 `readWorktreeFile + reconstructSessionBaseline` 的依赖；证据不足则保留可确认部分并解释缺失。

**产物：** provider 能力表、ZCode artifact adapter、既有解析器的证据校验。

**验收：**

- [ ] ZCode checkpoint 可关联到正确 tool／turn，重复事件只计一次，rewind 只改变投影可见性。
- [ ] 缺失或超期 artifact 保留文件操作信息并说明内容不可用，不读取当前磁盘补充。
- [ ] 每个迁移 provider 至少覆盖成功、拒绝／失败、缺结果、分支和重启 fixture。
- [ ] unsupported provider 不显示“全量记录完整”；也不会触发快照回退。

### 步骤 8：切换文件 API，保留明确的历史兼容

**依赖：** 步骤 2～6；其他 provider 随步骤 7 的完成情况接入。

**怎么做：**

1. 保持现有 `/files`、`/files/content`、`/files/diff` 入口，增加新契约字段或显式 API 版本，按选中分支返回操作投影。
2. 索引返回操作数、累计统计及其完整性、最近操作引用、能力边界、revision 和分页信息；不随索引传送全部 patch／文件正文。
3. 内容／diff 请求携带稳定操作与版本标识，逐次校验 project、session、分支 ancestry、执行源及路径权限。
4. 内容请求不自动落到当前文件；没有全文但有 patch 的记录允许单独读取 diff。
5. 旧快照只作为“旧版执行期间观测”保存入口，不与新工具确证累计相加。混合历史按明确来源展示，不把旧快照自动升级成工具事实。
6. 有充分历史工具结果的部分可按需、可恢复地索引；索引标记进度与截断，不能每次打开面板重新全量扫描 transcript。
7. 缓存键包含契约／project／provider／执行源／session／branch／记录 revision；新操作即使 transcript mtime 未变也刷新。
8. 建立冷索引的单次并发合并、增量游标和有界分页。一个 session 的读写不使所有 session 缓存失效。

**产物：** API、旧数据兼容层、分页与缓存。

**验收：**

- [ ] 索引请求不读当前工作区内容；详情只读授权的保存对象。
- [ ] 旧 recordId 链接仍有明确响应；新旧来源不重复计数。
- [ ] session／branch 快速切换和迟到响应不串数据。
- [ ] 伪造其他 session／分支的 operationId、路径穿越、远端同名路径均被拒绝。
- [ ] 新增操作使 revision 改变；无变化轮询复用索引，不重算全部 diff。

### 步骤 9：调整文件列表与 diff／预览交互

**依赖：** 步骤 1、8。

**怎么做：**

1. `SessionInspector` 展示第 4.3 节约定的累计 `+ / -`，同时显示操作次数；移动端也能看懂统计口径，不能只依赖 hover title。
2. `SessionSavedFilePanel` 从执行快照选择改为操作／保存版本选择；列表总数和当前操作统计分开标注。
3. 对已有完整内容保留安全 Markdown 预览；只有 patch 时直接提供 diff；二进制、内容缺失、超限分别提示。
4. 去掉新工具记录上的“工作区扫描覆盖不完整”提示。替换为具体能力或证据状态，例如“部分命令的文件写入未被记录”“此操作的完整内容不可用”。
5. 没有变更记录但发生过未支持命令时，显示“未记录到可确认的文件改动”，不声称命令没有修改文件。
6. 旧快照明确标注“旧版观测记录”，与工具确证记录区分；Git 标签保持工作区语义。
7. 所有新增文案同步 `en` 与 `zh-CN`。保持现有文件排序、长路径截断、消息跳转和键盘可访问性。
8. 基础验收使用组件测试。桌面／移动端真实浏览器检查作为单列步骤，只有用户授权后执行。

**产物：** 文件列表、操作详情、双语文案、组件回归测试。

**验收：**

- [ ] 单次新建显示 `+135 / -0`；连续多次编辑显示明确标注的累计统计。
- [ ] 列表累计与选中单次 diff 不被误认为同一数值；未知部分不会显示成精确零。
- [ ] 二进制、有 patch 无全文、旧快照、部分失败和无记录状态均有可理解的界面。
- [ ] 打开文件与跳转消息都定位正确操作，切分支后不复用旧版本。
- [ ] 中英文组件测试通过；未授权的浏览器检查记为未执行，不记为通过。

### 步骤 10：停用目录采集，验证并发与性能

**依赖：** 首批 provider、API 和 UI 验收通过。

**怎么做：**

1. 移除 Codex provider、CodexBridgeService 和 Pi provider 的 `SessionFileLifecycle.begin/bind/checkpoint/finish/close` 目录采集接线。
2. 保留旧快照的只读读取能力；采集器若仍供历史测试／诊断使用，不能留在生产会话生命周期中。
3. 新数据不足时停留在“记录不可用／部分支持”，禁止异常处理、feature flag 或 provider fallback 偷偷恢复全目录扫描。
4. 添加调用计数或依赖注入断言，证明新执行不会调用 `captureWorkspace`、目录枚举或目录级 watcher。
5. 构造 10、10,000、100,000 个无关文件的临时工作区；每组运行相同的一次小文件工具编辑。大样本通过专用本地 benchmark 执行，普通 CI 用较小样本与调用断言。
6. 交错驱动 1、4、8 个 session：不同文件、同文件、外部编辑、已存在 dirty 文件、工具运行中 commit。
7. 记录文件读取次数／字节、事件处理时间、API 冷暖耗时、CPU、峰值内存和磁盘增长；至少重复 5 次，性能数字附机器和样本说明。

**产物：** 旧接线删除、隔离性回归、可重复 benchmark 与结果报告。

**验收：**

- [ ] 只读／空闲 turn 的文件变更模块对工作区进行零文件内容读取、零目录枚举。
- [ ] 改一个小文件时，仅读取该操作涉及的文件或 provider 内容；增加无关文件不增加读取范围。
- [ ] 所有 session 的已确认操作归属正确，外部文件不进入任何无关 session 的统计。
- [ ] 暖索引请求不重复读保存 blob／patch；未变化的 5 秒前端轮询不重复全量构建。
- [ ] 性能耗时随操作／证据量增长；无关文件数量增加导致耗时变化超过 20% 时调查原因，不仅凭单次时间宣称合格。
- [ ] 无全局扫描定时器、无 provider 间共享的长队列导致无关 session 等待；同 session 的顺序仍正确。

### 步骤 11：发布、迁移和回滚准备

**依赖：** 首批全部硬性验收通过；步骤 7 的未完成 provider 明确标注。

**怎么做：**

1. 更新 `CHANGELOG.md` 的 Unreleased 和现有 `session-file-snapshots.md`：区分旧观测模型与新操作模型，记录统计口径和能力边界。
2. 为首次启动、混合历史、索引重建、只读旧版本编写运维说明；发布包识别新 schema，旧包不能误读新目录。
3. 加入不含文件正文的诊断：adapter 能力、捕获成功／失败数、未知结果数、去重冲突、记录与内容读取失败、索引耗时。
4. 先在隔离测试环境验证升级与降级数据兼容。允许回滚 API／UI 或关闭新捕获；不能把恢复全目录扫描作为默认降级路径。
5. 正式部署前执行版本提升与 `version:check`，记录部署后需要核对的版本／buildId／API 样例。
6. 本改动涉及 shared、provider、扩展资源和 bridge，按 runtime 档处理；已有活跃 turn 时不要强行 hot-apply。部署／runtime 重启需用户明确授权，并在合适的空闲窗口进行。
7. 旧快照清理不随首次上线执行；另行制定有引用保护、可预览的保留和清理策略。

**产物：** 发布说明、升级／降级手册、验收报告。

**验收：**

- [ ] 实际版本、CHANGELOG、构建产物一致；开发验证期间不提前冒充正式发布。
- [ ] 旧数据只读可用，新数据在禁用新功能后不损坏、不误解析。
- [ ] 上线后真实工具事件产生正确记录；未知写入有明确提示，且没有全目录扫描。
- [ ] 未取得部署授权时，本步骤标记“部署准备完成，线上未验证”，其余开发成果正常交付。

## 6. 跨步骤必须通过的回归矩阵

| 编号 | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| T01 | A／B session 同目录分别修改 a.md／b.md | A 仅计 a.md，B 仅计 b.md |
| T02 | A、B、A 交错修改同一文件 | 每次操作归属准确；A 的不连续历史不合并成精确净 diff |
| T03 | 外部编辑器改文件 | 没有本会话工具证据就不加入本会话 |
| T04 | 会话开始前有 dirty／untracked 文件 | 不因为文件已存在差异就计入本会话 |
| T05 | 工具完成后删除文件或执行 commit | 已保存差异与行数不变 |
| T06 | 审批拒绝／工具开始但没有结果 | 不增加已确认统计；必要时显示 pending／unknown |
| T07 | 多文件工具部分成功 | 只确认有落盘证据的文件，保留其他失败状态 |
| T08 | 更新通知、最终通知、bridge 转发、历史重放重复 | 一次逻辑操作只计一次 |
| T09 | 新建、覆盖、删除、重命名、mode-only、二进制 | 文件种类与状态正确；未知文本统计不伪造 |
| T10 | 空文件、CRLF、BOM、无结尾换行、Unicode | 行数与保存的实际 patch 对齐 |
| T11 | 两次操作改回原文 | 累计统计与可选净变化明确区分 |
| T12 | rollback／fork／resume／compaction | 使用原生身份和 ancestry；隐藏操作不可从详情接口越权读 |
| T13 | 远端与本机相同绝对路径 | 从对应执行源读取证据，不读本机同名文件 |
| T14 | Shell／未知 MCP／Python 写文件 | 没有证据时不编造文件归属，不扫描补齐 |
| T15 | exec 内嵌 apply_patch，与 exec 只读校验 | 前者按子操作证据记录，后者不生成写入记录 |
| T16 | exec 条件未执行／catch 子调用失败 | 外层成功不转为文件修改成功 |
| T17 | 重启、崩溃、丢 blob、patch 截断、配额超限 | 有明确局部状态，其他文件及 session 继续可用 |
| T18 | 冷索引并发请求、迟到旧响应、关闭面板 | 同 revision 合并构建；不会覆盖新索引；停止无用轮询 |
| T19 | 工作区无关文件从 10 增到 100,000 | 目标操作的工作区读取范围不变 |
| T20 | 旧快照与新工具记录并存 | 来源清晰，不跨来源双计数、不把旧观测升级为确证 |
| T21 | 工具写盘成功但记录持久化失败 | 工具结果保持原语义；暴露记录缺口，可恢复时按原始证据补录 |
| T22 | 上层统计包含一条未知行数操作 | 标注已知部分与未知数量，不展示无说明的精确总数 |

## 7. 检查命令与验证方式

以下现有测试适合修改对应模块后执行，按实际改动选择，不为文档提交运行整套源码测试：

```bash
pnpm --filter @yep-anywhere/shared build
pnpm --filter @yep-anywhere/server exec tsc --noEmit
pnpm --filter @yep-anywhere/client exec tsc --noEmit

pnpm --filter @yep-anywhere/server test -- test/session-files
pnpm --filter @yep-anywhere/server test -- test/routes/session-saved-files.test.ts test/routes/session-files.test.ts
pnpm --filter @yep-anywhere/server test -- test/sessions/session-file-changes.test.ts test/sessions/session-file-activity.test.ts
pnpm --filter @yep-anywhere/server test -- test/codex-events
pnpm --filter @yep-anywhere/server test -- test/sdk/pi-provider.test.ts test/sdk/pi-user-entry-echo.test.ts
pnpm --filter @yep-anywhere/server test -- test/sdk/providers/zcode-events.test.ts test/sdk/providers/zcode-protocol.test.ts

pnpm --filter @yep-anywhere/client test -- src/components/__tests__/SessionInspector.test.tsx src/components/__tests__/SessionSavedFilePanel.test.tsx src/hooks/__tests__/useSessionFileIndex.test.ts
```

新增测试建议分布在 `test/session-files/` 的 recorder、projection、stats、nested-tools、migration、isolation 测试，以及各 provider 的现有测试目录。新增性能脚本在步骤 10 创建后，将确切命令补入本文；不要把尚不存在的脚本当作可执行验收命令。

- 格式检查只针对实际修改文件运行 Biome，并执行 `git diff --check`。
- fixture、单元、组件和临时目录 API 测试不需要启动或停止现有服务。
- ZCode 只读协议 smoke 可使用已有 `pnpm test:zcode-app-server-smoke -- --read-only --summary`；发起模型请求或创建诊断 session 前先取得授权。
- 真实 provider 写入验证优先在临时项目和独立测试进程完成；涉及模型请求、外部配置或服务操作时明确说明并按授权执行。
- 浏览器／UI 自动化与截图检查单列，未经明确授权不运行；也不把组件测试表述为浏览器验收。

## 8. 依赖顺序、提交拆分与完成定义

建议实施顺序：

```text
0 协议与样例核实 → 1 契约 → 2 存储 → 3 投影与统计
  → 4 Codex + 5 嵌套工具 + 6 Pi
  → 8 API → 9 UI → 10 停用扫描与综合验收 → 11 发布准备

7 ZCode／其他 provider 基于 1～3 接入，逐 provider 交付与验收。
```

上图表达模块依赖，不要求启动多个 agent。是否委派协作遵循会话授权。

建议按契约、存储、各 provider、API、UI、旧接线移除、验收文档拆分可审阅提交。每个提交应能通过对应检查；不因拆分提交而把中间数据格式暴露给正式部署。本文不授权自动 commit／push。

首批完成必须同时满足：

- [ ] Codex 直连／bridge、Pi 的支持工具均以实际执行证据归属；嵌套工具新采集场景通过验收。
- [ ] 文件列表、累计 `+ / -`、单次 diff、完整内容预览各自语义一致。
- [ ] 核心隔离性、回放、分支、损坏恢复与访问控制测试通过。
- [ ] 新执行没有全目录快照、目录级监视补偿或定时扫描回退。
- [ ] 历史缺证据、Shell 能力缺口和未完成 provider 都如实显示并写入发布说明。
- [ ] 基线与新方案的读取范围、并发隔离和性能报告齐备。

本文原始交付为开发计划，目前已进入实施。开发验收与正式部署分别记状态；未授权的线上操作不应阻止文档、代码和离线验收结果正常交付，也不能被写成已完成上线。
