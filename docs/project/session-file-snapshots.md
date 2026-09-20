# Session 文件快照基础层

共用模块已接入本机 Codex（直连及 bridge）和 Yep 管理的 Pi 执行生命周期。
只采集新执行窗口，不回填历史会话；Codex／Pi 的文件 API 和前端已读取新记录。ZCode、Kimi 不受影响。

## 接口与存储

实现位于 `packages/server/src/session-files/`：

- `SessionFileStore`：保存与读取内容对象、快照和变更记录。
- `captureWorkspace(store, cwd, policy?)`：保存实际工作目录的文件快照，返回持久化 ID。
- `recordSnapshotChanges(store, scope, beforeId, afterId)`：比较两个已保存的快照，持久化关联到 session 的变更记录。

基础层的调用顺序（生产适配器通过 `SessionFileLifecycle` 包装）：

```ts
const store = new SessionFileStore(join(dataDir, "session-file-snapshots"));
const before = await captureWorkspace(store, executionCwd);
// 先保存 before.id 与执行身份，再放行 agent；不能在收到 started 通知后补拍基线。
// await executeAgent();
const after = await captureWorkspace(store, executionCwd);
const delta = await recordSnapshotChanges(store, {
  provider: "codex", // 或 pi
  sessionId,
  branchId,
  turnId,
  // toolCallId：适配器具备可靠工具边界时提供。
}, before.id, after.id);
```

`branchId`、`turnId` 必填，由适配器映射原生身份；基础层不猜测分支关系。
`listRecords({ provider, sessionId })` 返回该 session 的记录 ID（哈希排序，非时间排序），
调用方负责按当前分支的 turn／entry ancestry 过滤。不能把 session 下所有分支直接合并。

存储目录必须位于实际工作区之外：

```text
session-file-snapshots/
  blobs/<sha256>.json        # 原始字节的 base64，支持文本和二进制
  snapshots/<sha256>.json    # 文件路径、内容引用、执行位、覆盖信息
  records/<scope-hash>/<sha256>.json
  executions/<uuid>.json     # 执行身份、前后快照 ID、结束状态和采集错误
```

内容按原始字节哈希去重。元数据同样按内容寻址，使用已有的 atomic JSON writer
写临时文件、fsync 后 rename。多个实例写相同对象、重试写同一变更记录不会产生重复记录。
读时校验哈希与元数据 schema；损坏不会被当作空内容。
目录和文件使用已有 writer 的 owner-only 权限。存储的是实际文件内容，不是备份产品。

先保存 blob，再发布 snapshot，最后发布 record。中途失败可以留下未引用对象，
但不会把未完成快照发布为成功；后续需增加引用回收和总存储配额，本阶段尚未实现 GC。

## 已接入的执行边界

- Codex stdio：发送 `turn/start` 前保存基线；响应后绑定原生 turn ID；终止通知或已结束的
  start 响应触发收尾。经 bridge 执行时 provider 不重复采集，由执行机器上的 bridge 负责。
- Codex bridge：转发 `turn/start` 前采集，支持 legacy-blocking 和 lifecycle 日志模式；
  `turn/completed`、不可重试的 turn error、请求拒绝和连接关闭均有收尾路径。
  同一线程的重复请求／steer 不覆盖已有基线，其他 turn 的迟到结束事件不结束当前采集。
- Pi：发送 `prompt` 前采集，以 `agent_settled` 收尾；不会在 `agent_end` 就提前结束，
  因而包含自动重试／压缩后的续跑。最终 assistant stopReason 用于记录成功、失败或中断。
- 两者的进程／连接退出路径尝试保存最后观测。退出不代表后台子进程一定停止，
  所以 `disconnected` 固定为 partial，不能声称捕获了完整执行。

保存基线后先写 active execution manifest，再放行请求。采集或存储错误会记录日志，
尽可能写入 manifest 的 `captureError`，不让文件索引功能破坏 agent 协议；没有基线就不伪造差异。
新进程不自动复用崩溃留下的 active manifest，它仅作为诊断证据。

新请求有执行前基线时 coverage 为 full；仅收到原生 `turn/started`（自动排队、原生控制或
中途接入）时只能保存晚到基线并标 partial。没有开始事件也没有经过请求入口的既有执行不回填。
full 只表示观测了执行窗口两端，不表示文件变化的唯一作者；采集不是原子事务。

Codex 的 scope 使用原生 thread/turn 身份；Pi 的 session/branch 使用 fork 后原生 session ID，
turnId 起初使用本次 Yep user UUID，收到持久化用户消息回显后绑定 Pi 原生 entry ID。API 按当前选中分支的有效 turn／entry ancestry 过滤；无法关联的记录不展示，也不根据文本或时间猜归属。
当前是轮次级采集，尚未细分工具级变更，也未接入文件实时通知。

bridge 仅采集本机托管或 loopback upstream；显式远端 environment 请求不读取本机同名路径。
线程创建参数及创建／恢复／分叉响应中的环境选择会保留为线程状态；后续 turn 省略环境字段时仍跳过远端采集。线程元数据明确返回空环境列表时恢复本机采集，缺失字段不会清除已有远端标记。
项目 cwd 未知时不以 bridge 自身 cwd 代替。远端执行机器仍需后续部署相应采集器。

## 采集范围

- Git 工作区：只读 `git ls-files` 枚举 tracked 和非 ignored 的 untracked 文件；
  读取的是当前 dirty 工作区内容，不是 HEAD/index 内容，不修改 Git index。
- 普通目录：递归枚举。没有 Git ignore 语义，使用显式目录排除策略。
- 默认排除 `.git`、`node_modules`、`.venv`、`__pycache__`；`.git` 不允许取消排除。
- 默认单文件 2 MiB、一次实际采集内容总量 64 MiB、枚举上限 20,000 条目。
  Git 枚举另有 15 秒超时和每次命令 8 MiB 输出限制，失败则整次采集报错，不退回无视 ignore 的扫描。
- 保存字节内容及 executable 位；重命名暂按删除与新增表达，不推断 rename。
- 不跟随文件或目录符号链接，不读取 FIFO 等特殊文件；子模块目录标记 unsupported。
- 检查读取前后 inode、size、mtime、ctime 和路径，发现读取期间变化则标记 unstable。

这是有界的完整扫描，不包含 watcher 或增量缓存。树级别不是原子快照；文件监听、
增量缓存留给后续优化；生命周期适配器已串行化采集及请求放行前的同步。路径检查防止常规链接越界，
不将其宣称为对恶意并发目录替换的操作系统级沙箱。

## 差异与可信度

比较只使用持久化快照，不读当前文件；后来的外部修改、删除或 commit 不会改变已记录版本。
仅同一 canonical workspace、同一种枚举方式和同一 policy 的快照允许比较。

快照有 `listingComplete` 和 `omissions`。读取失败、超限、链接、特殊文件会留下原因；
Git ignored 的文件／目录也记录边界，避免文件新变为 ignored 后被误报为删除。
只有另一侧能够证明路径不存在时才报告新增／删除；不能判断的路径放入 `uncertainPaths`。
`complete` 只表示配置覆盖范围内的比较完整，不表示捕获整个机器或整个仓库。

所有变更固定为 `evidence: snapshot`、`attribution: observed-during-execution`。
即使调用方提供 session 身份，基础层也不把时间相关性升级成“确定由该 session 写入”。
并发 session、外部编辑器、后台子进程仍可能参与修改；接入阶段需增加执行范围与冲突观测。
工具失败也可能留下文件变化，适配器必须在失败／中断路径尝试收尾，不能只采集成功执行。

前端分别展示会话保存版本和当前工作区版本。精确工具事件证据、异常恢复及增量通知仍待后续集成。

## 验证

```bash
pnpm --filter @yep-anywhere/server test -- test/session-files/snapshots.test.ts
pnpm --filter @yep-anywhere/server exec tsc --noEmit
```

## 文件 API 和前端

Codex／Pi 的 `GET /projects/:projectId/sessions/:sessionId/files` 只返回快照索引，
不再混入 transcript 的 shell 路径猜测；没有新采集时返回空列表，不回填旧记录。
其他 provider 保持原有接口行为。索引包含每个路径的 `savedVersions`，按执行保存版本，
不会把不同执行之间的外部修改拼成一个“本会话总 diff”。

- `GET .../files/content?path=...&recordId=...&branchId=...`：读取已保存文件版本；
  删除事件展示删除前内容，Markdown 通过现有安全 renderer 生成预览；二进制返回明确标记，当前不支持预览。
- `POST .../files/diff`：Codex／Pi 从请求的 recordId 所保存的 before／after 计算差异，
  不读取当前工作区。其他 provider 保留旧的编辑记录重建行为。
- 所有请求先解析 project/session/provider，随后按选中分支的有效消息、记录的实际工作区和文件路径筛选；
  不提供任意 blob ID 读取，也不能借 recordId 读取其他 session／分支／工作区内容。
- 索引读取上限为 5,000 条执行记录、500 个文件和 20,000 条会话消息，达到上限明确返回 truncated。
  选择结果按记录 ID 集合与会话文件 revision 缓存；新记录到达后即使 transcript 未变化也会失效。
- 前端打开文件面板时请求索引，并在上次请求完成 5 秒后刷新；关闭面板停止刷新。
  切换 session／分支不复用旧索引；Codex／Pi API 失败不会回退到客户端猜测。
- 默认打开“会话保存版本”，可以选择其他执行版本、查看本次执行 diff，或显式打开“当前工作区文件”。
  快照数据缺失时显示错误，不自动改读当前磁盘。始终标注“执行期间观测到变更”，不声称唯一作者。
