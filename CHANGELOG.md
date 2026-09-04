# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this independent release line uses calendar versions in `YYYY.M.N` format.

## [Unreleased]

### Added
- 飞书 Codex 渠道支持订阅额度故障转移：账号可配置 `codexUsageLimitFallbackModel`；当 OpenAI Codex 原生返回 `usageLimitExceeded` 且该 turn 尚未产生文本、工具或审批副作用时，Yep 会在同一 Codex CLI/app-server 执行链内移除失败 turn，并以 DeepSeek model source 重派原消息及图片附件。所有飞书账号复用“新建会话”页同源的 `account/rateLimits/read` 用量与 `resetsAt`，耗尽期间共享 DeepSeek 路由；窗口重置并刷新确认后，下一条消息自动切回账号的 `defaultModel`。上下文超限、session budget、普通 429 和已有副作用的失败不会自动重放；`/new` 创建但尚未写入 rollout 的 provisional thread 会在首条消息或切源时安全替换，不再以 `CODEX_NO_ROLLOUT` 失败。
- 新增只读 session display API 与客户端请求契约：`display` 按 40 个真实用户 turn 分页，`display/questions` 独立分页并显式报告 `complete`/`partial` coverage，`display/tool-groups/:detailRef` 仅在展开时恢复目标组且按 50 个 renderer 工具分页；opaque cursor/detailRef 均绑定 session、branch 与 revision，过期引用返回明确的 409 stale。Codex app-server 使用 `turns/list(itemsView="summary")` 保留 turn 身份与 cursor，并以有界并发逐 turn 读取 items：display 投影保留完整语义，问题目录立即丢弃非用户 item，确保同一原生 turn 内后续 steer 问题不会被 summary 的“仅第一问”规则漏掉；Codex rollout 复用 byte-offset cursor，Pi 等 provider 复用 normalized fallback。Codex 原生 `turn_id` 现在也进入轻量问题元数据，确保目录跳转到正确的 display turn。
- 新增 session 轻量展示的 strict 共享契约与服务端只读投影器：按真实用户 turn 保留问题和 assistant 文本，将连续工具调用压缩为只含状态、数量、文件/检查计数及不透明详情引用的工具组，保留审批、提问、错误与必要的 provider 时间线通知，并把用户媒体降为无正文占位；首屏 40 turns、工具详情每页 50 项作为后续 API/UI 接入的固定默认值。Codex、Pi、Kimi normalization oracle 和超大工具结果测试确保投影不携带 tool input/output、内联媒体或隐藏工具正文中的本地路径，且不修改 provider 消息。
- 用户消息复制按钮现在会复制整条 session 输入：保留纯文本剪贴板格式，同时把该条输入中的全部可读图片写入富剪贴板；粘贴到现有会话或新建会话输入框时会恢复原文本和所有图片附件。无法使用富剪贴板或读取部分图片时会降级为文本并显示部分复制提示。
- 为项目 Git 状态弹窗中的分支和上游分支添加完整名称复制按钮，提供中英文成功/失败提示，并支持鼠标移入弹窗及键盘操作。
- Add a one-click copy control to every fenced code block in assistant Markdown, including live streaming blocks and nested agent output, with bilingual labels, clipboard fallback, and success/failure feedback.
- Expose DeepSeek V4 Flash Vision (Experimental) in the Codex model-source catalog as `deepseek-v4-flash-vision-exp`, with the official 1,048,576-token context window, 384K maximum output, `low/high/max` reasoning tiers, and text-plus-image input metadata. The managed catalog now marks the existing V4 Flash and V4 Pro entries as text-only and advertises original-detail images only for the Vision model, matching DeepSeek's Codex catalog instead of claiming image support for every DeepSeek model.
- Keep a one-click copy button visible inside every user-message bubble, so prompt text can be copied without dragging to select it first.
- Surface Pi's automatic request retries as provider retry status. Pi retries a failed request inside the turn, so nothing in the message stream distinguishes "thinking" from "waiting out a 429 backoff", and the UI showed an ordinary thinking pulse for the whole delay. Pi's `auto_retry_start`/`auto_retry_end` events now map onto the existing provider-neutral `SessionRetryStatus` (attempt, message, retry deadline resolved from the reported delay), which the session list already renders as a retry badge. Providers report this through a new `onRetryStatus` side channel rather than the message stream, because that stream is replayed into the transcript and backoff is transient status, not conversation; the live status is included in initial activity and REST snapshots so a page opened during backoff does not miss it, and a settled turn clears the state defensively in case the provider skipped its end event.
- Read LLM gateway credentials from a `llm-gateways.json` overlay in the data directory (path override: `YEP_LLM_GATEWAYS_FILE`), applied on top of the channels resolved from `YEP_LLM_GATEWAY_*`/`YEP_LLM_GATEWAYS`. Keys previously only came from the process environment, which for a launchd/systemd-managed server is frozen at launch: a key rotated anywhere else kept being used until someone edited the service definition and restarted Yep, and the only symptom was the provider's own rejection inside a session (`403 budget_exceeded` on a Pi turn, with nothing in the server log). The overlay is re-read while the server runs — a stat per resolve, revalidated at most once a second — so rotation is a file write. An entry whose `id` matches an environment channel overrides only the fields it sets and keeps `apiKeyEnv`, so provider processes still scrub the retired credential from the child environment; any other entry declares a new channel and needs `apiBase` plus a key. A malformed overlay is reported like any other rejected gateway entry instead of taking working channels down, the data-directory lookup is skipped for callers that pass a fabricated environment (tests, bridge sidecars), and startup now prints the active channels and their configured keys for the private instance so "which key is this server actually using" is answerable without restarting it.

### Changed
- 静态前端资源现在支持内容协商压缩、构建期预压缩和条件请求，主要针对内网穿透/远程访问链路。此前 `compress()` 只挂在 `/api/*` 上，`createStaticRoutes()` 自己读文件直接返回，所以整个前端 bundle 一直以原始字节下发：实测渲染阻塞的首屏关键路径（entry + modulepreload + CSS）931 KB，到 session 视图累计 1.65 MB，其中 Tailwind CSS 单文件压缩比 6.9:1。在 frp 隧道上这不只是几秒白屏，它还会占满与实时 WebSocket 共享的那条复用 TCP 连接，把流式事件排到后面。构建期新增 `vite-plugin-precompress`，为每个可压缩产物生成最高质量的 `.br`/`.gz`（2.06 MB → gzip 0.55 MB / brotli 0.46 MB）；服务端按 `Accept-Encoding` 优选 brotli，命中预压缩文件时运行时 CPU 为零，缺失时用快速档（gzip 6 / brotli q5）即时压缩并按 `path+mtime+size+coding` 缓存（上限 48 MiB，同时省掉每请求一次 448 KB 的 `readFile`）。关键路径实测 931 KB → 196 KB（4.74x），首屏到 session 视图 1.65 MB → 362 KB（4.56x）。所有静态响应现在都带 ETag：hashed 资源的 validator 含内容编码，避免共享缓存把 brotli 响应交给只支持 gzip 的客户端；SPA shell 改用内容哈希，`public/sw.js` 早已按「navigation 用 `cache: "no-cache"` 换 304」编写，但服务端此前从不发 validator，所以每次导航都全量重传。`.webmanifest` 和 `.wasm` 补进 MIME 表，此前退化成 `application/octet-stream` 并因此被排除在压缩之外。`YEP_SKIP_PRECOMPRESS=true` 可跳过构建期压缩。
- Session detail 响应改为条件请求（ETag + `Cache-Control: private, no-cache`）。这是最大的重复 API 载荷——实测一页 transcript 为 176 KB identity / 64 KB gzip——而客户端在每次 SWR revalidate 时都会重新拉取：重开读过的会话、从后台切回、来回切换分支都会触发。validator 由序列化后的响应体哈希得到，而不是文件 revision，因为 payload 混合了 `activity`、`hasUnread`、`lastSeenAt` 等实时字段，用 revision 会在实时状态已变化时错误地返回 304。该路由走浏览器原生 `fetch`，因此不需要任何客户端改动：浏览器自己发 `If-None-Match` 并把 304 透明地解析成缓存副本。`no-cache`（而非 `no-store`）是关键——它允许存储但强制 revalidate，正是把重新传输变成 304 的语义。
- HTTP keep-alive 空闲窗口从 Node 默认的 5 秒提高到 70 秒（`headersTimeout` 75 秒）。5 秒在 loopback 上无所谓，但穿透链路下建立一条连接约需两个往返（visitor → frps，然后 frps → frpc 下发 `StartWorkConn` 并回连），对本机两台 frps 实测为 ~40–70 ms。用户看完一屏、停 6 秒再点一个 session 就要重新付这笔成本，而 HTTP/1.1 首屏会并发开到 6 条连接。
- 搜索结果支持排序切换：默认按会话更新时间从新到旧展示（同时在结果头部显示会话时间），并可在搜索页顶部切换为“匹配优先”，恢复原来的标题命中 → 匹配数 → 时间排序。排序状态写入 URL `sort` 参数（服务端 `GET /api/search?sort=recent|relevance`），同时以浏览器级 UI 偏好（`yep-anywhere-search-sort`）记住上次选择：无 `sort` 参数时沿用上次排序，带 `sort` 的分享链接优先生效并刷新该偏好。
- Active/external session 的历史首开也改用 metadata/display，不再因为运行中就下载整段 legacy tool input/result；服务端只把最新可读 assistant 输出之后唯一尚未封口的工具组标成 `liveTail`。self-owned session 仅恢复该 live tail 的 bounded raw 详情并继续接收 stream，external session 仅自动展开该 live tail；progress/commentary、普通文本或 final 出现后，客户端先按可读输出边界立即收拢工具，随后在 80ms–2s 的有界持久化确认窗口内用最新 display 接管并删除已闭合 raw 前缀。历史组保持 lazy detail，thinking、内部 system/provider 行不触发收拢，AskUserQuestion/plan progress 保持独立；stale 会刷新 display 重试一次，失败时保留 raw，显式 `?history=legacy` 保留完整旧链路。
- Session 页面默认组合使用轻量 metadata/display/questions 状态，不再在首开构造完整隐藏工具 `Message[]`；display 首屏从实测起点 20 放宽到 40 个真实 user turns，语义 turn 自动向前分页，问题目录后台补全并显式显示 partial/unavailable，工具组展开后才局部恢复现有 renderer。live stream 继续承载唯一开放尾部，settle 后刷新轻量投影。Session Inspector 在桌面侧栏显示或移动抽屉打开时自动补齐 Files/Checks、plan/goal/subagent 索引，但索引请求只返回路径、检查命令、计划状态和子智能体身份等 body-free 元数据，不重新下载 tool output、patch 正文或完整 assistant 文本；实时尾部与安全索引合并，idle 后按 revision 更新。活跃历史 revision 变化会自动从第一页重试一次，失败后才显示明确的索引重试入口。
- 将 checked-in Codex app-server protocol baseline 从 `0.147.0` 同步到 `0.151.0`，并让 `pnpm dev`、`dev:8022`、`dev:8022:replace`、`dev:auto`、`staging` 在启动前自动检测 CLI 版本变化：版本未变时快速退出，本机 CLI 较旧时只提示而不自动降级，升级时重生成 stable/experimental schema、TypeScript 与 runtime hash，并在全部 coverage 审计通过后自动更新 `expectedVersion`；新增未分类的 server-facing capability 仍会在写入前 fail closed，`codex:protocol:check` 与 CI 保持只读。
- 文件浏览器工具栏现在分别提供“复制标题”和“复制全文”：前者复制页面顶部显示的完整文件名，后者原样复制文件正文，并各自显示独立的成功或失败反馈。
- 会话页顶部标题现在展开显示当前会话的完整标题，不再重复承担会话切换；左侧会话菜单新增“复制标题”，并提供中英文结果提示。
- 将 session 内的 Markdown/文件预览与代码编辑详情从居中遮罩弹窗改为桌面右侧并排面板，会话仍可在左侧独立滚动和操作；打开另一文件时替换当前面板，窄屏继续使用原有弹窗/全屏体验。文件头现在以文件名为主、目录与大小/行数为紧凑副信息，面板内 Markdown 使用更适合分栏阅读的字号与标题层级；桌面分隔线支持拖拽或键盘调整并记住比例，双击可恢复默认宽度；`Edit` 的短 diff 与未截断 patch 也始终显示右侧详情入口，不再只有超长修改可打开；右侧 diff/patch 对长行启用 soft wrap，完整内容无需再横向滑动。
- 内网单用户实例改为明文展示和记录：保留原始文件路径、工具输入输出、凭据、错误详情、附件提示、已有推理内容及飞书消息/导出数据，移除敏感内容拦截和密钥遮盖；仍保留认证授权、文件访问范围、HTML/URL 安全校验及日志/导出容量限制。旧日志已丢失的信息只在原始会话仍有对应数据时恢复。
- 精简侧边栏会话卡片：标题统一单行省略并保留完整标题悬停提示，置顶仅用背景区分；默认隐藏勾选框，从会话菜单「选择会话归档…」进入批量选择，归档完成或取消后退出选择模式，桌面与移动端操作一致。
- Make AI session titles explicitly user-triggered from the session three-dot menu instead of waiting for first-turn completion or backfilling titles at server startup. Manual generation now defaults to `deepseek-v4-flash` and sends the conversation available at click time—all real user inputs plus assistant progress, thinking, and responses—while excluding tool calls, arguments, and results. Compacted/legacy Codex histories that retain only tool-result user messages fall back to the session's full original-prompt summary, so they can still be titled without sending tool output. Session cards and the session header show an inline generating indicator for the lifetime of the request.
- Replace the sidebar's separate starred-session collection with project-scoped session pins. Existing `isStarred` metadata is reused as the single durable pin bit, so previously starred sessions become pinned automatically and keep their auto-archive protection. The sidebar now fetches one combined list, backfills pins that fall outside the ordinary recent-session limit, elevates old pins into Recent Sessions, sorts them above ordinary sessions when their project group is expanded, and gives pinned rows a distinct accented background; menus, filters, bulk actions, indicators, and bilingual copy now use pin/unpin terminology.
- Declutter recent-session project rows by replacing the always-visible branch name and Git counters with a compact status button. Hover or keyboard focus previews the current project Git summary, while click, touch tap, and touch long-press pin the same detail popover; the session inspector now always keeps the current project branch visible, including on a clean working tree.
- Stop running the canonical Codex projection twice per event by default. `shadow` mode built a second projection and two SHA-256 hashes for every notification purely to compare them, but the comparison cannot succeed: the canonical side reads the redacted envelope while the legacy side reads the raw notification, and redaction rewrites `path`/`movePath` to workspace-relative form, fingerprints other path-bearing keys, and scrubs absolute paths inside strings, while only `timestamp` is normalised before hashing. Any payload carrying a path therefore diverged by construction — 53,649 warnings on one install, 37,302 of them `item/commandExecution/outputDelta`, against 16 for the path-free `turn/plan/updated` — and the resulting parity snapshot has no reader. The default is now `legacy`; event ingestion, journalling, token-usage extraction and generated-artifact materialization are unchanged, since none of them live in the projection branch. `YEP_CODEX_EVENT_SPINE_MODE=shadow` still enables the comparison for anyone resuming the canonical-to-primary migration, and it now reports one line per diverging method instead of one per event.
- Stop journalling high-frequency Codex deltas, and stop hydrating the journal into the writer. The provider event journal recorded every app-server notification, unlike the 4510 bridge which has classified and dropped deltas since its lifecycle rewrite; measured on one install the same event stream produced a 2.1 MB bridge journal and a 176 MB provider journal, with `item/agentMessage/delta`, `item/commandExecution/outputDelta` and a ~30 KB-per-event `turn/diff/updated` making up 83% of the bytes. Deltas are still serialized, projected and rendered; they simply leave no durable record, which is the same split the bridge already makes. Retention is now sized against the reader's 512 MiB admission budget (64 MiB per segment, two closed segments plus the active file) rather than free disk: the previous ~1 GiB ceiling put the journal permanently over that line, so every canonical overlay was rejected and the journal was written but never read. Rotation defaults are resolved per field, so unset or partial production environment overrides cannot silently restore the store's larger generic limits. `YEP_CODEX_EVENT_JOURNAL_MODE=full` restores full event retention; `minimal` keeps only the `error`/`turn/completed` records that the always-on error and turn-health overlay actually replays.
- Give the provider journal writer an append-only store that indexes sequences, a bounded recent-identity window and dedupe keys instead of retaining every envelope, and stop replaying the journal when a Codex session starts. Reads are served by separate long-lived store instances, so the writer never needed the events it was holding; a cold load of an 892 MB journal materialized it into four in-memory indexes, which is why resident memory settled at ~2.5 GiB within two minutes of startup and then stayed flat. The session-start replay was waste on top of that: it rebuilds a projection nothing reads, and restores correlations by matching `source.connectionId`, which a freshly generated connection id can never match. A caller that supplies its own connection id may be resuming, so it still replays.
- Serve the 4510 `/sessions` catalog conditionally and make bridge snapshot ETags survive a sidecar restart. `/sessions` is not on the poll path, but the session locator fetches it whenever a lookup misses every cheaper source, and at roughly 100 KiB each of those misses paid a full transfer and JSON parse; it now carries the same entity tag as `/session-views` and answers 304, with the main server keeping the last catalog and revalidating via `If-None-Match`. Both tags previously keyed on the bare change revision, which a restarting sidecar resets to its initial value while repopulating sessions from persisted state without notifying — a client holding the old tag could be handed a 304 for a snapshot it had never seen. The tag now includes a per-process id, so any restart is a guaranteed miss, the SSE change frame carries that id, and a targeted refresh is only accepted when it comes from the same instance the client last synchronized with. A sidecar that does not send an ETag is not cached at all.
- Keep every project touched in the last 7 days visible in the sidebar's recent-session list. The sidebar renders the global top-50 sessions grouped by project, so a working directory with only one or two recent sessions disappeared whenever busier projects filled the list, forcing a trip through New Session to find it again. `GET /api/sessions` now accepts `projectCoverageDays`: after the top-N cut, the newest in-window session of each dropped project is appended (capped at 50 extras, still ordered by recency, `hasMore` unchanged), and the sidebar requests a 7-day window.
- Make the 4510 → 8022 session-state feed conditional and changed-count-aware: startup and recovery use one `/session-views` snapshot with revision/ETag and 304 responses, while complete SSE frames identify changed sessions for bounded requests to the existing `/sessions/:id/view` route. Single-session changes no longer transfer or parse the full catalog, missing/hidden rows act as tombstones, revision gaps recover on the next conditional snapshot, and 4510 still does not read transcript history.
- Move Codex manifest discovery/stat/plain-header fallback into a Codex-only worker with per-root single-flight. The provider-wide catalog uses it only when the public app-server state DB is empty or missing rows; the common SessionIndex and Gemini/Pi/Kimi/ZCode readers keep their existing project-scoped behavior.
- Build Codex session/project lists from one provider-wide app-server `thread/list(useStateDbOnly=true, sortKey=updated_at)` catalog instead of rebuilding a project-scoped rollout index for every cwd. The catalog paginates once, validates rollout paths, filters subagent rows, groups canonical cwd buckets, shares a short-lived single-flight snapshot across project/global routes, merges bridge/live state and Yep metadata, and background-reconciles real manifest files missing from a non-empty stale DB; an empty/unavailable DB and `YEP_CODEX_LIST_SOURCE=manifest` retain the existing scan-and-repair path.
- Read paginated Codex session history through a single long-lived, read-only app-server client instead of rescanning the rollout. The production path uses metadata-only `thread/read` plus bounded `thread/turns/list` and `thread/items/list`, source-locked opaque cursors, CLI-version/schema capability caching, single-flight requests, timeout/backoff recovery, and typed rollout fallback for legacy, unavailable, unsupported, unmaterialized, or parity-sensitive pages. Common user/assistant/reasoning/tool messages retain only stable native provenance instead of duplicating full ThreadItems; generated images, local media and unsupported hook/review/sleep pages fall back to the existing rollout materializer. `YEP_CODEX_HISTORY_READ_MODE=rollout` remains an immediate kill switch.
- Keep a bounded, module-level LRU of the five most recent Codex transcript snapshots (32 MiB total, 12 MiB per session) so A → B → A navigation and route remounts paint cached messages immediately while REST revalidates in the background. Cache keys isolate project/session/branch/history source, unchanged messages retain object identity during ID-based merge, file/history rewrites invalidate only the affected session branch, and cached values exclude reasoning blocks, inline media, empty sessions and over-budget snapshots.
- Add privacy-safe Codex session performance observability: session detail and list routes expose stage-level `Server-Timing`, and 4510 polling records snapshot bytes, trigger reasons and unchanged polls. A read-only app-server history smoke and cold/warm rollout-vs-app-server benchmark cover public list/read/turn/item methods without resuming a thread or sending a model request; the benchmark starts the history client inside the first timed read so “cold” includes initialize.
- Make the 4510 Codex Bridge a lightweight lifecycle proxy by default. High-frequency deltas now forward immediately without entering the bridge durable journal or connection-local canonical reducer; `off`, bounded asynchronous `full`, and explicit `legacy-blocking` modes remain available. Compact lifecycle persistence uses a bounded/coalescing background writer with terminal priority and circuit breaking, while retained legacy bridge journals are loaded only for explicit canonical/export requests with source, coverage, and rollout fallback metadata.
- Speed up Pi session opens by reusing parsed JSONL snapshots, avoiding redundant reads and branch scans, deriving summary and messages together, and deferring inline media on the client fast path.

### Fixed
- 修复 Codex 会话中同一张上传图片在用户消息里显示两个附件标识：轻量 display 投影会剥掉 `input_image` 的内联 `image_url`/mime，只留下 `deferred` 占位，客户端因该占位没有预览数据而无法把它并入文本中列出的托管附件，于是额外渲染出 `pasted-image-1.*`。现在没有任何文件名信息的 Codex 内联图片占位会直接并入同条消息里的图片附件，不再重复显示。
- 修复 Pi 运行中会话在离开再返回（或 WebSocket 重连）后，用户提问在时间线和会话索引中重复展示的问题。根因是 Pi 以自己的 entry id 持久化提问、不会记录 Yep 的 client UUID，实时流里的乐观用户消息与 session 文件里的那条无法按身份对应；轻量 display 首开路径既匹配不到 `clientUserMessageId`，也没有已持久化时间水位，服务端重放的乐观消息就被当作新消息追加。现在 Pi provider 在收到提问的 `message_end` 后通过 RPC `get_entries`（以上次 leaf 为 `since` 游标，只传增量）取回刚追加的 entry id，并以该 id 重新发出用户消息，同时用 `supersedesMessageId` 指明它替换的乐观行；Process 历史与客户端都原地替换乐观行而不是追加，display 路径按 `question.messageId` 直接识别。这也让运行中的提问立刻拥有真实 entry id，无需刷新即可作为 Pi 原生分支/编辑锚点。作为兜底，display 路径还会用 display 页与已恢复 live tail 的时间戳初始化水位，并对重放/乐观提问按文本加 15s 时间窗做语义匹配。
- 修复 Codex 会话在切换 reasoning effort 并重启 app-server 后只展示首轮历史：本地 transport 关闭现在会等待旧子进程真正退出后才允许 Supervisor 恢复同一 thread，避免新旧 rollout writer 在交接窗口写出重复 ordinal；轻量 `display`/`display/questions` 也会把“无下一页但少于完整 rollout 问题索引”的原生投影视为不完整并自动回退 JSONL，因此已有损坏的 thread-history SQLite 投影无需改写原始会话即可恢复全部展示。
- 修复语义化轻量历史把 assistant 文本降级为纯文本的问题：display 投影现在只为实际可见的 assistant 文本补充与旧历史路径一致的安全 Markdown HTML，恢复本地文档跳链、右侧文件预览、列表、行内代码和代码块，同时继续保持工具正文按需加载。
- 修复 Codex 会话打开 Session Inspector 时偶发“无法加载会话索引”：完整 Files/Checks/plan/goal/subagent 索引需要跨多页组合 app-server turns/items，活跃 turn 的投影并非原子快照，旧实现会在写入期间继续扫描并把中途 parity 变化统一显示成 stale 错误；即使进入 idle，较早页面只要含本地图片/音频等严格 transcript 必须回退的 item，source-locked app-server cursor 也会被误报为 stale。Inspector 现在在 `in-turn` 阶段保留轻量 display、问题目录和实时尾部，取消已开始的全量索引 generation，并在本轮结束后自动补齐；body-free projection 意图会传入 history reader，媒体和无专用 renderer 的 native item 只在该安全索引内降为 deferred/opaque 占位，随后由 Inspector 投影移除正文，普通 canonical transcript 仍保持 strict parity。等待期间显示明确的延迟状态，稳定状态下的真实失败仍保留错误与手动重试入口。
- 修复仍会绕过完整 renderer augmentation 的四条消息出口：轻量 display 现在只对用户实际展开或 active live-tail 恢复的工具详情页生成 Edit/Write/Read/Markdown 增强，完成的子智能体详情、session 文件落盘前的进程快照及无 live Process 的离线 durable replay 也复用同一增强语义；Codex `FileChange` 在这些路径中不再只剩文件名和 `Patch preview unavailable`，同时不对隐藏 turn 预计算 diff。
- 修复轻量 Session 页面把右侧会话索引误改成手动加载、且失败时复用“工具详情”错误并吞掉真实异常的问题：索引现在随可见 Inspector 自动加载，桌面和移动端默认都能展示文件、检查、计划、Goal 与子智能体；安全索引不会覆盖实时尾部，分支切换通过加载代际隔离旧响应；Codex 活跃会话分页期间发生 revision 变化时会从第一页重试完整快照，持续失败会记录原始错误并提供单独的“会话索引”重试入口。SessionIndex 提升到 v12，确保旧的有界 Codex 问题缓存会重建 coverage，而不是把截断结果误报为 complete。
- 恢复 Codex 原生编辑 fork 的单卡片分支体验：服务端结合 app-server `forkedFromId`、Yep fork sidecar 和完整 `thread/items/list` 构建 provider-neutral branch graph，并在创建子 thread 时持久化被编辑的精确 user-message ID；同一 turn 内连续 steer 出来的多个用户问题不再把切换器错误挂到该 turn 的第一问，真正的原问题与替换问题共享同一逻辑 parent。跨-session 编辑导航会主动轮询新分支落盘，无需重新进入；共同前缀继续使用稳定 native item identity，React 只替换分叉后的后缀。fork family 在侧边栏仍折叠为一个卡片并继承根 session 标题，切换 `b1 / b2` 不再把卡片/页头改成新 prompt。
- 修复晚进入运行中会话时 Codex `FileChange` 只显示文件名和 `Patch preview unavailable`：durable journal replay、Process 短期 replay 与后续实时消息现在共用同一个有序 augmentation 队列，历史 Edit 在发送前同样生成 `_rawPatch`、`_structuredPatch` 和 diff HTML，同时 replay 不再被误送入流式 Markdown coordinator。
- 修复 Codex paginated 编辑 fork 在继承历史含本地图片、`imageView` 或未来未知 ThreadItem 时轻量 display 只剩新问题的问题：app-server semantic 投影现在把用户媒体降为 deferred 占位，复用既有 `ViewImage` 工具表示，并把无法完整展开的 native item 收敛为不含原始 payload 的安全摘要；不再因单个媒体/未知 item 整页退回只包含子 rollout 的 JSONL reader。完整 canonical transcript 仍保留严格 parity fallback，fork 的父历史继续由原生 thread-store lineage 提供。
- 修复运行中 Codex session 在轻量 display 历史与实时消息交汇时重复显示当前用户问题或 assistant 进度文本：用户输入同时识别旧 `user_message.client_id` 与当前 `item_completed(UserMessage).client_id`，assistant 文本保留原生 item correlation identity；display、独立问题目录和客户端实时尾部现在按稳定身份接管。运行中重载、持久化延迟或 WebSocket 回放不再把同一行显示两次，用户刻意连续发送的相同文本及不同原生 assistant item 仍分别保留。
- 修复轻量 session display 在首开或重连回放时把已闭合的 Codex 工具行追加到 `final_answer` 之后：display 已持有的 assistant 边界现在会清理同一 turn 的 raw 前缀，包含 final 的 closed turn 也会拒绝迟到的 tool replay；下一 turn 的实时工具仍正常保留。
- 修复部分 Codex session 冷打开后不显示上下文用量：app-server 的轻量 `Thread`/catalog 摘要不包含 token usage，客户端现在会在 metadata 缺失时立即通过专用 `context-status` 路径从共享 SessionIndex/rollout 摘要补齐，并在首次尚未持久化时做一次延迟重试；较晚返回的持久化值不会覆盖更新的实时 usage，live session 收拢到 display 历史时也会保留已知用量。原始 `token_count` 没有 `info` 或有效 input token 的会话仍保持隐藏。
- 修复运行中打开的 session 在 turn 完成后仍永久停留在 legacy 工具明细的问题：客户端现在保留 active/external 的实时逐条 renderer，在 ownership 变为 `none` 且进程进入 idle 后原子切换到轻量 display/questions；切换前后各确认一次 ownership，避免会话在请求途中恢复时误清空实时消息，display 不可用或显式 `?history=legacy` 时继续保留 legacy 内容。
- 修复 generic Codex 轻量 session 中工具组首次展开即返回 409 stale：不透明 `detailRef` 现在绑定 reader-native rollout revision，详情读取用同一 revision 校验并重建 locator，兼容带原生 `turn_id`、因 legacy cursor fallback 而不再返回 pagination metadata 的 Codex 历史。
- 修复轻量 session display 在真实长问题上返回 500：问题摘要现在把省略号计入 140 字符上限，并在 API 边界重新压缩旧 session index 中可能超限的历史摘要，兼容升级前已持久化的数据。
- 修复 Codex paginated session 在恢复、bridge active-turn rejoin、编辑分支和 steer 竞态中请求完整历史的问题：lifecycle 请求改用 `excludeTurns`，bridge 通过原生 `initialTurnsPage` 原子取得 live turn，edit/fork 只分页读取尾部 boundary，且仅对已确认的 legacy history 保留一次受控 full-read fallback；app-server 的 `deprecationNotice` 现在只进入有界去重诊断，不再显示为用户 transcript warning。
- 修复飞书通道误用启动 shell 遗留代理的问题：账号新增 `proxyMode`，`auto` 默认让国内 Feishu 直连、国际 Lark 的 OpenAPI 与 WebSocket endpoint discovery 继承环境代理，`direct` / `environment` 可按账号覆盖；直连使用与 SDK 全局实例隔离的 HTTP wrapper，不再修改 Lark SDK 的全局 Axios 配置。这样本地 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY` 指向的代理关闭后，Feishu 机器人身份校验不会持续报 `BOT_IDENTITY_FAILED`，依赖代理的 Lark 账号也不受影响；失败日志只记录脱敏的网络错误码、HTTP 状态和实际绕过标记，不记录代理地址、凭据或请求体。
- 修复“全部会话”仍只按时间排列、没有体现置顶优先级的问题：当前筛选范围内的置顶会话现在统一排在普通会话之前，两组内部继续按最近更新时间排序；接口会补齐落在普通首屏之外的置顶项，并用补齐前的时间页边界继续分页，避免“加载更多”漏掉中间会话。
- 修复 Codex 新会话在实时回显与 rollout 刷新交汇时偶发重复显示用户消息的问题：保留 Codex 原生 `user_message.client_id`，并让 Process 回显、rollout normalization、canonical overlay 与 app-server history 统一发布同一个用户消息 correlation identity；附件的 `<image>`/`input_image` 表示差异和落盘延迟不再参与消息身份判断。
- 修复 Kimi ACP 会话的标题与工具展示兼容性：隐藏 reminder 不再污染自动标题并会定向刷新旧索引；`ReadMediaFile` 的图片/视频结果以有界摘要和可用预览展示，不再变成 `""` 或重复传输 base64；`Write` 等工具在流式参数尚未补齐时安全等待，单个 renderer 异常只降级对应工具行；全局错误页仅在两端 buildId 确实不一致时提示版本问题。
- 修复侧边栏项目收起后置顶会话仍显示的问题；置顶会话随项目统一折叠，重新展开后仍优先显示。
- Channel-created Codex sessions (e.g. the Feishu bot) now start on the model source that owns the requested slug: `resolveCodexModelProviderForStart` falls back to `findModelSource(model)` before the built-in `openai` source, mirroring the resume path. Previously a managed model such as `deepseek-v4-flash` configured as a Feishu account `defaultModel` was launched with `model_provider="openai"` and failed upstream, because only the browser new-session form sends an explicit `codexModelProvider`
- Keep Pi transcripts ordered across reconnects by treating persisted Pi history as an authoritative snapshot instead of incrementally merging native entry IDs with unrelated live UUIDs, and defer that replacement until an owned turn is idle. Pi session discovery now shares one provider-wide file catalog, unchanged parsed sessions survive unrelated file changes without periodic forced reparsing, summary/detail reads share the normal media-deferred snapshot, and project reader aliases reuse the same cache instead of scanning the full Pi tree independently.
- Keep file-change paths intact across live events, app-server history, canonical journal replay and JSONL normalization. Original POSIX/Windows paths and patch content remain visible; exact per-tool-call fingerprints recover paths from older masked journals when the original rollout still exists.
- Fix Codex session fast-path correctness without expanding storage/provider architecture: app-server history now uses direction- and session-locked opaque cursors with symmetric older/newer pagination and inclusive-anchor de-duplication; provider-supplied reasoning and original structured path fields remain visible in REST payloads, real base64 image-generation/local-media pages use typed rollout fallback, and large command/MCP payloads are not copied into native envelopes. The catalog explicitly includes `cli`/`vscode`/`exec`/`appServer`, retains manifest-confirmed rows across TTL refreshes, removes invalidated manifest-only rows before recomposition, and supplies cheap metadata/mixed-provider routing. The client snapshot LRU uses bounded structural estimates and reference-preserving merges instead of serializing multi-megabyte payloads on the main thread.
- Keep canonical event-journal retention chronological when multiple rotations happen in the same millisecond. Segment names use a numeric collision suffix, but lexicographic sorting placed `-2` before the unsuffixed first segment and could prune a newer segment while retaining an older one, turning expected prefix loss into a silent interior gap.
- Restore Codex input namespaces and native context compaction in Web sessions. Codex CLI controls now complete under `/` while `$` lists active app-server skills and sends selected mentions as structured skill inputs; a bare `/compact` is intercepted before message submission and invokes `thread/compact/start`, automatically resuming an inactive stored thread without injecting a model turn first, while `/compact ...` is rejected with an explicit no-arguments message instead of becoming a normal model turn that only claims to preserve context.
- Make the file viewer's copy button work on plain HTTP and restricted WebViews by using the shared clipboard fallback, and show visible feedback when every copy method fails.
- Preserve local filesystem paths that Codex intentionally includes in user-visible agent replies, including canonical agent-message deltas/snapshots and recovered Feishu card deliveries. Feishu cards now render local Markdown link destinations as readable path text instead of replacing them with a local-path placeholder that CardKit could surface as “地址已隐藏”; secret-shaped values and structured tool/runtime path fields remain redacted or fingerprinted.
- Select the pinned Node runtime by PATH order instead of trusting `nvm use`, so `scripts/deploy.sh` stops aborting with "NVM selected v25.9.0, but .nvmrc requires v22.22.2" on a machine that also has a Homebrew Node. `nvm use` only prepends its bin directory when PATH holds no NVM entry; when one is already present it rewrites that entry **in place**, so any Node earlier on PATH keeps winning while NVM still reports success and prints "Now using node v22.22.2". A `~/.zshrc` that loads NVM and then prepends more directories produces exactly that shape — reproduced on this machine, where `nvm use 22` leaves the NVM bin at position 26 and `command -v node` resolves to `/opt/homebrew/bin/node`. The deploy guard was therefore correct to refuse, but its remediation could never succeed. `ensure_project_node` now resolves the pinned version's bin directory itself (directly when the exact version is installed, through `nvm which` only for an alias or partial pin), moves it to the front of PATH, clears Bash's command hash, and verifies against the resolved binary rather than the literal `.nvmrc` string — which also fixes an alias pin such as `22` failing its own version check. The failure message now names the binary that won so a remaining PATH problem is self-diagnosing. The Corepack pnpm shim is unaffected: `ensure_pnpm` re-prepends it afterwards in every caller.
- Track Pi session activity from the session-specific JSONL tail, including Pi sessions driven by an in-process host. A trailing user prompt, tool result, or non-terminal assistant stop keeps the session running even when no standalone `pi` process exists; a terminal assistant stop now marks that session finished even if an unrelated or idle Pi CLI remains in the same project. Tail reads start at 256 KiB and expand backwards only when needed, so oversized image/reasoning/tool-result records no longer hide the real terminal entry. Periodic validation still expires unfinished log-only evidence after five minutes without a write, preventing a crashed host from leaving ownership stuck forever. External status events now carry the proven `in-turn` activity, persisted `lastTurnStatus`/errors travel on `session-updated`, and old Pi summary-index rows missing those fields are rebuilt once instead of hiding the status until another file change.
- Report a Pi turn that stopped mid tool call as interrupted rather than completed. `lastTurnStatus` treated the presence of any last assistant message as a completed turn, but Pi ends a turn only on a terminal stop reason: `toolUse`, `pending` and `deferred` all mean the agent still owed work. A session killed while a tool was running — the common shape for an interrupted Pi session, since its log ends on the tool call or its result — was therefore shown as having finished normally. Trailing tool results are now tracked as their own tail marker instead of being invisible to the derivation.
- Stop the external-provider process probe from spawning a `lsof` storm that starved the whole server. Each tracked external session revalidates its liveness on a 3 s timer, and the shared process snapshot resolved one working directory per candidate process with one sequential `lsof` each behind a 1 s TTL and no in-flight sharing. Once a sweep took longer than the TTL — ~50 candidates on this machine, one spawn each — every concurrent caller started its own full sweep and the misses fed each other: measured on a live 8022 install at roughly **1000 `lsof` spawns per second**, with 81% of main-thread samples inside `posix_spawn`, a permanent 20–30% CPU floor, and a backlog of unreaped children. The user-visible effect was server-wide, not provider-specific: `/api/version` degraded from 10 ms to 1.7 s, a 3.4 KB Pi session response took 1.6–14 s, and `/api/recents` hit a 60 s timeout. A sweep now shares its in-flight build across callers, serves the previous snapshot while a refresh runs, resolves every unknown pid through a single batched `lsof -a -p <pid,...> -d cwd -Fpn` (chunked, tolerating the non-zero exit lsof returns for pids it cannot open), and memoizes pid+command→cwd so a refresh usually spawns nothing beyond `ps`. A full real sweep now costs 2 spawns and ~80 ms instead of ~50 spawns and over a second.
- Preserve Codex agent-message deltas as the shared lossless SDK stream so bridge-owned turns continue updating Feishu/Lark cards in real time, while provider canonical ingress, native item attribution, generated-artifact provenance, and broker-owned approval resolution remain authoritative.
- Bound Codex rollout session loading before normalization. Summary, agent-mapping, and paginated detail reads now stream one UTF-8 JSONL line at a time with byte/line budgets, weighted admission, stable byte-offset cursors and file revisions, bounded page projection, and explicit fallback for rollback histories that still require the legacy branch reducer. Large rollouts no longer materialize the full file, `split("\\n")`, and complete parsed-entry array on the normal summary/detail path; canonical journal overlay is conservatively skipped for rollouts above the 64 MiB safety threshold (configurable via `YEP_CODEX_CANONICAL_MAX_ROLLOUT_BYTES`), and cold journals above the 512 MiB admission budget (configurable via `YEP_CODEX_EVENT_STORE_ADMISSION_BYTES`) are rejected before hydration. Codex clone/fork copies use the same bounded decoder instead of materializing the source text.

## [2026.8.5] - 2026-08-18

### Added
- Pi can serve models from multiple provider-neutral LLM gateway channels at once. Extra channels come from `YEP_LLM_GATEWAYS`; catalogs are fetched concurrently, non-default channel models are namespaced, ambiguous slash-qualified IDs remain tied to their source channel, and each generated Pi provider receives only its own credential and protocol metadata. Existing bare default-channel model IDs remain stable for resume compatibility, failed catalogs keep their last successful snapshot, and the reader restores channel namespaces from Pi persisted provider IDs.

### Changed
- Retire the OpenCode provider and its 4520/4521 bridge integration from the live product, API, client, bundle, and deployment paths. Yep leaves the user's OpenCode database and sessions untouched; existing operators must explicitly remove the old LaunchAgent and forwarder plugin after deploying the retired build. SQLite, gateway, and edit-fork helpers still used by Pi or ZCode move to provider-neutral modules, while persisted legacy `opencode` metadata is tolerated and ignored instead of reactivating the provider.
- Offer only a curated set of current models in Pi's picker. Aggregator gateways list their whole historic catalog, so two gateways produced 63 entries — a dozen superseded Claude snapshots (`claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001-thinking`), ten Gemini variants, families nobody drives this agent with, and endpoints that are not chat at all (`gemini-embedding-001`, `gpt-image-2`). The catalog Pi advertises is now an allowlist of newest-release prefixes — Claude Opus 4.8/5 and Fable 5, GPT 5.6+, GLM 5.2, Kimi K3, MiniMax M3, DeepSeek V4 — which on this machine's two gateways yields 16 entries instead of 63. An allowlist rather than a deny list because these catalogs keep growing: a new dated Claude snapshot or Gemini preview must not silently reappear. `YEP_LLM_GATEWAY_MODELS` replaces the prefix list and an empty value offers everything the gateway reports. Filtering is display-only: session start, the generated Pi provider catalog and mid-session routing all read the unfiltered list, so a session already pinned to an omitted model still resumes and still runs — tying visibility to routability would have silently broken exactly those sessions, so a test pins it
- Consolidate LLM gateway credentials, channel parsing, model catalogs, protocol normalization, headers, model visibility and default limits under provider-neutral shared/server modules. Pi, session-title generation, the gateway benchmark and LaunchAgent configuration now use `YEP_LLM_GATEWAY_*`/`YEP_LLM_GATEWAYS`; provider-owned bridge wrappers and runtime coupling were removed.

### Fixed
- Keep Pi multi-gateway routes tied to the source catalog instead of reparsing the slash-qualified display id. Gateway-native ids may contain slashes, so a default model such as `openai/gpt-5` has the same Yep-facing id as `gpt-5` on an extra channel named `openai`; reparsing that string silently moved the default model onto the extra gateway. Catalog assembly now retains `(channel, bareModelId)` as route metadata, keeps the first source (the default channel is ordered first), warns and omits an ambiguous duplicate, and uses only the retained source for startup and `set_model`. The LaunchAgent installer also carries every valid key variable referenced by `YEP_LLM_GATEWAYS` into the server plist, and preserves a set-but-empty `YEP_LLM_GATEWAY_MODELS`, so deployed processes honor the same arbitrary `apiKeyEnv` and “show all models” configuration as direct server runs
- Make Pi's plan mode the strict approval gate its UI describes. Pi has no native plan prompt or plan lifecycle, but the shared Yep policy still inherited Claude's special auto-approval for `Write` calls under `.claude/plans/`, contradicting the promise that every Pi write asks. The exception is now disabled for Pi while remaining available to providers that actually save native plans there
- Stop the session-index concurrency cap from blocking the request path. Capping full validations at one removed the concurrency storm but replaced it with head-of-line blocking, and separating queue wait from scan duration made the trade measurable: on a live server the actual scan work has a p50 of **20 ms** while queue waits reached **8291 ms**, including a scope that waited 8.3 s to perform 40 ms of work behind a single 5 s Kimi scan. Aggregate scan occupancy was 4.3% of wall time while queueing accounted for 35% — and because full validation runs on the request path, those waits were user-visible latency, not background cost. The cap now shapes rather than gates. A scope whose previous scan finished within `fullValidationFastPathMs` (default 50) skips the queue, because the queue exists to keep several heavy scans off the event loop and a 20 ms scan is not one of those; a scope with no history still queues, since its cost is unknown. Anyone who does queue gives up after `fullValidationMaxQueueWaitMs` (default 1000) and runs anyway, so no request is starved behind the slowest scan in the system. Both escapes admit extra concurrency deliberately, which is still strictly bounded compared with the unlimited concurrency that existed before the cap. `getDebugStats()` reports `fullValidationQueueBypasses` and the log line marks bypassed passes, so a cap that has stopped shaping anything is visible rather than assumed
- Separate full-validation queue wait from scan duration in the session-index metric, and log the scope the throttle actually keys on. Serializing full validations moved wall time out of the work and into a queue, but `recordCallStats` measured from the start of the request, so a scope that waited for another scope's scan and then worked for 380 ms was recorded as one long scan. That made the pile-up fix read as a regression — observed on a live server as p50 rising from 379 ms to 1492 ms with a 26.8 s maximum — while hiding both the real per-scan cost and the real contention. `durationMs` is now the scan itself, `queueWaitMs` is reported beside it (and triggers the slow-path log on its own), and `getDebugStats()` exposes `fullValidationQueueWaitMs` plus its per-scan mean. The log line also gained `scope=`: throttling and slot admission are keyed by index scope while many scopes share one directory, so log lines that looked like a broken throttle — six directories all showing a 0-second minimum interval — were simply different scopes sharing a directory, and the old line could not tell them apart
- Budget the canonical Codex overlay's own work instead of the journal load that precedes it. The 2 s clock started when the canonical phase began, so journal selection and replay were charged to it — and journal replay is an uninterruptible cold-load cost, measured at 3371 ms for the provider journal and 3419 ms for the bridge journal on a live install. The result was that the first canonical request after every restart was denied its overlay because *loading* was slow rather than because projecting was: production logs show exactly one such fallback ~17 s after each of the last three restarts, with `journalReplayMs` alone exceeding the whole allowance. The clock now starts once the journal is in memory, so the budget bounds the work it can actually influence. The generated-artifact scan stays inside the window on purpose, because it walks every replayed event and is precisely the kind of post-load work that needs bounding. A request may therefore now take a cold replay plus up to the budget, rather than being cut short at the budget with nothing to show for it; the replay cost is one-time per store per process (~96 ms once warm) and is still reported as `journalReplayMs`, alongside the new `budgetMs`, so a slow load stays visible instead of being hidden behind a generic timeout. The budget is injectable through `SessionsDeps.canonicalOverlayBudgetMs` (default unchanged at 2000 ms) so the boundary is testable without sleeping for the production value
- Select the freshest canonical Codex journal instead of the first one that happens to hold the session. Provider and bridge journals are independently sequenced, and source selection returned the first source containing any event for the session — which silently preferred a stale journal. Measured on a live install, one session existed in both: the provider journal ended at 2026-08-16T05:09:30Z while the bridge journal ended at 2026-08-16T18:18:37Z, so because provider came first, every canonical projection of that session was **13.2 hours behind what had actually been recorded**, with nothing in the response or the logs to indicate it. Journals are still never merged — their sequence spaces are independent, so one is chosen whole — and ties keep the previous positional precedence, so single-journal installs behave exactly as before. Freshest wins because the overlay exists to enrich the rows the client is looking at, which are the recent ones, and because full history comes from the legacy rollout rather than from this journal. Comparison uses `receivedAtMs`, the one timestamp our own ingress sets on both the provider and the bridge path, so the ranking stays on a single clock; a journal whose events carry no usable timestamp is treated as "unknown freshness" rather than "empty" so its canonical data is never dropped. Cost: every source is now probed instead of stopping at the first hit, via a new O(1) `latestEventAtMs` on the store, so only the winning journal is replayed. That does force a cold load of journals positional precedence might have skipped, which is accepted because a mixed workload loads them all anyway. Verified against the real journals: the selector now picks the bridge journal for that session, and the same session turns out to hold 405,157 bridge events rather than the 144,029 the stale journal exposed
- Report canonical Codex journal pruning instead of losing history silently. The durable event store keeps 3 closed segments of 256 MiB each, so on a live install — measured at one rotation per ~17 h — roughly 2.9 days of history is retained and everything older is deleted. Nothing noticed: rotated events stay in the in-memory indexes for the life of the process (deliberately, so replay and per-session sequences stay continuous), so the loss only materializes after a restart, and no layer checked for it. `matchesReplaySnapshot` only compares a cached projection against the replay, so an incomplete replay validates cleanly against an equally incomplete cache, and the reducer folds a partial history without complaint. Pruning now reports which sessions each deleted segment held and how many events it took from each, described from bookkeeping captured at load time and carried across the rotation rename rather than by re-reading a 256 MiB file that is being deleted for being large. A cold load additionally reports sessions whose surviving journal no longer starts at sequence 1 — per-session sequences are dense and start at 1, so the first surviving sequence is exactly the count of deleted leading events — which is the signal a restarted process previously had no way to produce. A session whose events were removed entirely still cannot be detected, because sequence assignment restarts at 1 once nothing survives; that case makes a session vanish rather than render a truncated history, and the code says so. Verified against both production journals (provider and bridge, ~740 MB and ~700 MB): no gaps, which is the correct answer because segment pruning has not fired yet on that install — the instrumentation is in place before the first deletion rather than after it
- Stop the canonical Codex overlay from disabling itself on long sessions. `DEFAULT_MAX_REFRESH_EVENTS = 100_000` has been there since the first event-spine commit with no comment or measurement behind it, and it rejected the whole overlay on *total journal size*. Measured on a production journal (144,029 events for one session, 10,494 legacy rows) the overlay is linear at 35-47 us/event with no knee anywhere near the constant, and the two regimes differ by two orders of magnitude: a windowed request costs 139 ms while an unwindowed one costs 6.8 s. The projection cache does not close that gap because it memoizes the reduce, not the candidate build and legacy matching (warm 6.7 s vs cold 7.0 s). The ceiling now applies only to the unwindowed regime, so the windowed request the client actually makes is served canonically instead of silently falling back to legacy normalization on every single request — 692 of the 705 fallbacks in one day of logs were this session. The check also moved ahead of the generated-artifact scan, which walks every replayed event: an out-of-bounds session used to pay for that scan and have the result discarded by the next statement (25-39 ms warm, ~1 s on a cold store, per request). `CodexProjectionCache` no longer evicts the entry the current `apply` call is using: a session whose own projection exceeded `maxTotalEvents` used to evict *itself* on the way out, leaving an empty cache, so exactly the sessions that need the incremental projection were guaranteed never to have it (`cache.size === 0` and a full ~8 s cold projection on every request for that same session). Finally, the fallback log now records `outcome`, `errorName`, `errorMessage` and `journalReplayMs`: it previously reported neither the error name nor its message, so a hard event-limit rejection appeared as `budgetExceeded: false` with an unexplained duration, and a known bound now logs at debug instead of warning once per request
- Send the adaptive thinking payload for Claude models Yep registers with Pi. Pi's `anthropic-messages` client only emits `thinking: { type: "adaptive" }` + `output_config.effort` when the model carries `compat.forceAdaptiveThinking`, which its generated catalog sets but a dynamically registered gateway model does not, so Yep's Pi sessions sent the legacy `thinking: { type: "enabled", budget_tokens }` shape and current releases rejected the whole turn with `400 "thinking.type.enabled" is not supported for this model`. Reproduced live on `aitl/claude-opus-5` at effort `high`. Registered models now carry the traits upstream derives from the model id (`references/pi/packages/ai/scripts/generate-models.ts`): adaptive thinking for Opus 4.6/4.7/4.8/5, Sonnet 4.6/5 and Fable 5; `supportsTemperature: false` for Opus 4.7/4.8/5, which reject it; the adaptive effort maps (`max` on every adaptive model, `xhigh` only where Anthropic offers it); and Fable 5's `off: null`, without which Pi would send `thinking: { type: "disabled" }` to a model that cannot disable thinking. Older Claude snapshots and non-Claude models keep budget-based thinking, so no other request shape changes
- Give Pi its own permission-mode copy and enforcement semantics. Pi has no native permission policy, so Yep applies its mode policy to canonicalized Pi tool names; plan mode is a stricter approval gate rather than a provider plan prompt, and writes or commands remain behind approval.
- Stop the transcript from swallowing everything above a selection while the user copies. Selecting text in a long session and then scrolling up crossed the 200px auto-load threshold, and the prepended chunk changed the React key of the turn at the top of the window (`turn-<first render item id>`), so React unmounted that whole subtree — measured in headless Chrome on a 466-message session: exactly one existing `.assistant-turn` removed, the selection collapsing to `anchorNode = .message-list, anchorOffset = 1`, and the next mouse move producing a 442-character selection of content the user never touched (`MessageActions`/`Cmd+C` then copy exactly that). Turn keys now come from a sticky registry (render-item id → turn key, reset per session/branch, pruned when items leave the window), so a turn that gains items at its head keeps its identity and its DOM; auto-pagination is additionally deferred while a mouse/pen drag or a live selection intersects the list, and retried on pointer release or once the selection clears (touch is excluded because a touch scroll always holds a pointer down). The load-older scroll compensation also never ran: it measured `scrollHeight` two animation frames after a fire-and-forget async request, i.e. before the data landed, so the delta was always ~0 — measured effect was ~19,900px of content inserted above the viewport with `scrollTop` unchanged (a tracked row moved from `top: 2482` to `top: 22464`). The correction now runs in the layout effect of the commit that adds the rows, with a follow-up frame for late layout
- Stop two remaining transcript remounts from dropping a live text selection, both found while verifying the fix above against a real 466-message session. (1) A load-older round that pushes a transcript past the 80-row virtualization threshold used to switch modes mid-selection, which remounts every row; virtualization now keeps whatever mode it is already in for as long as a selection intersects the list (the same reason `focusBranchId`/`targetMessageId` already suppress it). (2) `TextBlock` rendered server markdown through `dangerouslySetInnerHTML`, and a prepend commit re-applies that prop with a *byte-identical* string (measured by trapping the `innerHTML` setter: two applications, `pairIdentical: true`, 4078 chars each), which recreates every node inside the block and therefore the selection's anchor. The HTML is now written imperatively in a layout effect that skips re-applying identical content to the same host node. Measured on the explicit "Load older messages" path while holding a selection: five consecutive rounds grow the list 28 → 82 rows with zero row removals, the selection survives all of them, and `Cmd+C` yields exactly the selected text (before: the selection was gone after the first round)

## [2026.8.4] - 2026-08-17

### Added
- Compress `/api/*` responses with gzip. Session payloads are dominated by server-rendered augment output — on a measured 1.72 MB pi session response, `_highlightedContentHtml` alone was 1.49 MB (73%) — and that HTML is highly redundant, so nothing was gaining from being sent verbatim over a link. Measured after the change: a pi session response 385,685 → 119,494 bytes (3.2:1) and the 188 MB Codex session's window 801,475 → 158,028 bytes (5.1:1); an earlier 1.72 MB body compressed 7.2:1, which over the throttled remote tunnel is the difference between ~112 s and ~16 s of transfer. Streaming is unaffected: `text/event-stream` is excluded from Hono's compressible-type allowlist *and* `streamSSE` sets `Transfer-Encoding`, which the middleware also skips — verified live, an SSE response still arrives as plaintext with no `Content-Encoding`. Binary downloads (APK, images) are skipped by content type. One accepted wart: Hono can only honour its size threshold when the handler declared a `Content-Length`, which `c.json()` does not, so small JSON responses are compressed too; that costs a few bytes and a little CPU on polling endpoints and was preferred over replacing well-tested middleware with a bespoke one
- Partial-read parity tests for Codex rollouts (`codex-partial-read-parity.test.ts`), gating the tail-read work: the window produced by parsing a whole rollout and the window produced by parsing only its tail must be deep-equal, including ids. The suite also pins the boundary where tail reads are unsafe — `codexRolloutSupportsTailRead` returns false for rollouts containing `thread_rolled_back` markers, because such a marker drops the user turns *preceding* it and a tail read cannot see them, so the marker silently does nothing and the window keeps history a full read discards. That is a semantic divergence no id scheme can repair, so those rollouts must be read in full

### Changed
- Throttle and serialize session-index full validations. Watcher events for every provider except Claude cannot tell which project scope owns the changed file, so `handleFileChange` marks *all* of that provider's loaded scopes dirty — and a dirty directory bypassed the existing 30 s full-validation interval entirely. With a shared backing store (OpenCode keeps one sqlite file for every project) a single write therefore queued one full store scan per scope. On a live server with 43 projects and 153 index scopes this reached **29 full validations per second at 250–800 ms each**, saturating the event loop: an unrelated session read whose own work measures ~15 ms took 3–11 s, and the same request varied between 0.02 s and 22 s. A dirty directory now still forces a full pass but no more often than `SESSION_INDEX_FULL_VALIDATION_MIN_MS` (default 5000) per scope, and at most `SESSION_INDEX_MAX_CONCURRENT_FULL_VALIDATIONS` (default 1) run at a time so scopes sharing a store cannot pile up. The service default for the floor is 0, so embedders keep the previous behaviour unless the config layer opts in. Trade-off: a newly created or externally modified session can take up to the floor to appear in list views
- Stop deep-copying canonical Codex events on every replay. `JsonlCodexEventStore.replay()` ran `structuredClone` over each envelope it returned; the client's default `view=canonical` session load replays a whole session's journal, so a session with 144k journalled events paid ~650 ms and produced ~250 MB of garbage on *every* request, and the heap grew by roughly that much per session open. No consumer mutates a replayed envelope — the overlay copies the array before sorting, and the reducer, candidate builder and artifact scan only read — so the copies bought nothing. Replay now returns shared, `readonly` references (the reference `InMemoryCodexEventStore` keeps copying, where journals are tiny and isolation is worth the allocation). Measured against the real 775 MB provider journal: warm replay 647–692 ms → 2–4 ms, and heap stays flat across repeated replays instead of climbing ~250 MB each time
- Collapse the redundant rollout reads that made opening a large Codex session slow. Opening one session fans out into `GET /projects/:p/sessions/:s`, `/metadata`, and `/agents`, and each endpoint independently read and JSON-parsed the whole rollout file; on a 188 MB / 32k-line session that burst took ~2.8 s wall clock and the concurrent copies also multiplied peak memory. A new `readSharedCodexEntries` (`packages/server/src/sessions/codex-entries-reader.ts`) coalesces reads of the same path that overlap in time, so the burst shares one read+parse. Nothing is retained after a read settles, so there is no cache to invalidate and a caller can only observe data one read older than its own request — already true when every caller read at a slightly different instant. Entries are now typed `readonly` end to end (`buildCodexBranchView`, `convertCodexEntries`, and the Codex reader helpers) so the read-only contract the sharing depends on is enforced by the compiler. Measured on the same instance: session-open burst 2.84 s → 1.00 s, single session request 2.22 s → 1.07 s
- Stop serializing the session message window twice. `GET /projects/:p/sessions/:s` returned `messages` at the top level and a byte-identical copy under `session.messages` that no client ever read; the nested copy is now omitted and `messages` was dropped from the client `Session` type (message state is owned by `useSessionMessages`). Same session as above: response 1.462 MB → 0.803 MB
- Point the `mini` mobile-shell TCP node at the new frp server (`39.106.189.88:18022`, previously `39.106.200.1:18022`) in both the client node list and the APK static shim, and treat the retired `http://39.106.200.1:18022` origin as a deprecated default so persisted app data falls back to the current endpoint instead of dialing the dead address

### Fixed
- Anchor Codex message, question, and branch ids to entry byte offsets instead of a running counter. `convertCodexEntries` derived every uuid from its position in whatever entry array it was handed, so identity depended on how much of the rollout had been parsed and on which branch was selected: the same message was `codex-15760-<ts>` after a full read and `codex-225-<ts>` after a tail read, and switching branches shifted the ids of messages in the shared prefix even though those messages had not changed. Ids are now `codex-@<byteOffset>`, which is unique (measured over a 32k-entry production rollout: zero collisions, versus 294 colliding groups for `timestamp` alone and 4 for `timestamp|type|payloadType`), stable under append, and preserved across zstd compression. Entries built without a file keep their previous positional ids, so fixtures and other providers are unaffected. `SessionIndexService` moves to version 11 so cached `userQuestions[].id` values are rebuilt; `SessionInspector.mergeQuestionItems` already deduplicates on `timestamp + text` as well as id, so the rebuild window cannot show duplicates
- Read Codex rollouts that have been compressed to `.jsonl.zst`. Codex ships a background worker (`codex-rs/rollout/src/compression.rs`) that compresses rollouts cold for 7 days and then deletes the plain file; Yep's manifest scan only matched `.jsonl` and had no zstd path anywhere, so with that worker active every Codex session older than a week would not degrade but simply vanish from Yep. Discovery now accepts both forms and prefers plain when both exist (Codex materializes a compressed rollout back to plain before appending, so during a resume the plain copy is the live one), and reads decompress transparently — the manifest header read streams through the decompressor and stops at the first newline instead of inflating the whole file. The worker is gated behind `Feature::LocalThreadStoreCompression`, verified `under development` / default-off on the installed Codex 0.147.0 via `codex features`, so this is a latent-failure fix rather than a live one. `ExternalSessionTracker` is deliberately left plain-only: a compressed rollout is by definition inactive, and Codex materializes it back to plain before any append, so live sessions always have a plain file. Node only exposes zstd in `node:zlib` from v22.15.0 while this package supports `node >=22.13.0`, so the bindings are resolved lazily rather than at import (binding them at module scope threw a `TypeError` during import of a module that `app.ts` depends on, i.e. no server start at all on 22.13/22.14), and on such a runtime compressed rollouts are skipped during discovery instead of being listed as sessions whose every read is guaranteed to fail. Root cause of the wider hazard, fixed with it: how rollout bytes are stored was knowledge spread across whichever call site happened to open a file, and `readFile(path, "utf-8")` does not fail on compressed bytes — it silently returns mojibake. `cloneCodexSession` (fork/branch) inlined exactly that read *and* is the only place Yep writes a rollout, so a compressed source would have produced a corrupt `rollout-*.jsonl` that then became a permanent manifest entry. Decoding now has a single owner (`codex-rollout-file.ts`, pinned by a test that fails if a second module reaches for the codec), the clone path decodes through it, and it validates the decoded text before writing so any storage format this build does not understand degrades to a clean error instead of a corrupt file. `CodexSessionManifestEntry` gained `compressed: boolean` because a bare `filePath: string` cannot tell a consumer that its bytes are not text. Consumers that only stat or move the bytes are safe for both forms and stay unchanged — archive/restore is a byte-level move, verified lossless for a compressed session, which matters because auto-archive fires at 7 days and Codex compresses after 7 days cold

## [2026.8.3] - 2026-08-17

### Added
- Pi coding-agent support based on the pinned `references/pi` source: native strict-LF JSONL RPC transport, generated process-local gateway providers, shared OpenCode gateway model catalog and endpoint selection, Codex-style thinking controls, streamed messages/tool results, Yep approval bridging, compaction/model switching, native session discovery and active-branch normalization, cross-session edit-fork switching/lineage, archive/search/index/watch integration, and provider-specific UI identity. Dynamically registered `openai-completions` models pin a portable request compat (no `developer` role, `store`, or `max_completion_tokens`) so generic OpenAI-compatible gateways do not reject Pi's api.openai.com-oriented defaults with a 400. The bundled extension is loaded without installing into or modifying Pi config under `~/.pi`, disables user extensions for Yep-owned processes, and removes gateway credentials from the child environment before Pi tools run; native session JSONL remains in Pi's normal session tree
- Kimi goal lifecycle display (inline read-only card): the shared `kimi-schema` now registers `goal.create`/`goal.update`/`goal.clear`/`forked` wire record schemas (mirroring `references/kimi-code` 0.36.0+ `goalOps.ts`), and `getKimiGoalTimeline` replays them into a snapshot timeline (status `active|paused|blocked|complete|cleared`, budget limits `tokenBudget/turnBudget/wallClockBudgetMs`, consumption counters `turnsUsed/tokensUsed/wallClockMs`, actor `user|model|runtime|system`, change classification `created|status|budget|progress|cleared`). The server's `convertKimiMessages` merges the snapshots into the transcript as inline `type: "kimi_goal"` messages placed by timestamp, and the client renders them with a `GoalInlineBlock` card — objective, status badge with icon/color, budget progress bars (warning at ≥80%), and final tallies on clear. Historical Kimi sessions that previously lost all goal information now show the full goal timeline
- Expanded Kimi wire schema coverage from 6 to more than 40 recognized persisted record types. Added typed validation for profile/tool/context/turn/swarm/plan/task/LLM/permission/plugin/compaction/interaction and goal lifecycle records while retaining unknown records for forward compatibility. `config.update` now follows upstream's single partial-update payload and preserves combined `modelAlias` + `profileName` records; `getKimiSubagentType` prefers authoritative `profile.bind.profileName` with a `config.update.profileName` fallback
- Kimi context compaction tracking: `kimi-reader.deriveFromWire` now parses `full_compaction.begin` + `context.apply_compaction` records into `compactCount`/`compactEvents` (timestamp, before/after tokens, reclaimed, trigger), surfaced on the session summary — matching the existing Codex compaction display
- Kimi offline session terminal status: when a Kimi process has exited (no live runtime), the last `turn.ended.reason` (`completed|cancelled|failed|blocked`) is now mapped to the session-level `lastTurnStatus`, so offline sessions show "completed / interrupted / failed" instead of a blank status
- Kimi ACP tool name precision for subagent dispatch: `inferKimiAcpToolName` now recognizes `Agent` and `AgentSwarm` by exact name and by distinctive args (`subagent_type`/`prompt`/`description` for Agent, `items`/`prompt_template` for AgentSwarm), so online subagent dispatches no longer fall back to the generic "KimiTool" label
- Subagent type visual differentiation: the `task-agent-type` badge now uses type-specific colors and icons (explore → blue + 🔍 read-only, coder → purple + ✏️ editing, agent → green, plan → amber) instead of a uniform `badge-info` text chip

- ZCode goal lifecycle (session/goal full chain): `AgentSession.getGoal`/`goalAction` (strict 0.16.1 params, shared `ZCodeSessionGoalParamsSchema`/`ZCodeSessionGoalResultSchema` contracts) → Supervisor/Process/RuntimeController wiring → `POST /api/processes/:processId/goal` (action enum validation, objective required for set/replace, 404/400/502 semantics matching the compact route) → a "Goal…" SessionMenu entry for owned ZCode sessions opening a small dialog: current goal status via `action: "show"`, objective input with Set/Replace buttons, and Pause/Resume/Clear actions; responses surface as toasts (the CLI's `startedTurn` on set/replace is normal behavior of an explicit user action; the objective text is never logged). Protocol-level finding recorded in the support doc: rewind/checkpoint and cancelBackgroundTask UIs are not feasible on CLI 0.16.1 — the app-server offers no method to enumerate checkpoints or background tasks
- ZCode P5 native advanced capabilities, aligned with other providers: subagent transcript display (the reader maps the parent `Agent` tool call to its child session through `~/.zcode/cli/agents/<parentSessionId>/agent_*/metadata.json` — whose `parentToolUseId` matches the parent's tool part callID and whose `childSessionId` matches the sqlite `subagent_child` row — and renders the child transcript through the shared agent-tree UI with descriptor/metrics); mid-session context compaction (`session/compact` full chain: `AgentSession.compact` → Process/RuntimeController → `POST /api/processes/:processId/compact` → SessionMenu "Compact context" entry, shown only for owned ZCode sessions); mid-session reasoning/thought-level switching (`session/setThoughtLevel` with fail-closed validation against the current model's advertised thought levels, `POST /api/processes/:processId/reasoning-effort`, and level chips in the model switch modal fed by the provider's model catalog, en + zh-CN copy)
- ZCode image/file attachments on outbound messages: structured uploads and pasted base64 images are now forwarded as native `session/send` `attachments` records (`{kind: "image"|"file", filename, localPath|dataBase64, mimeType, sizeBytes}`) instead of only appearing as text paths in the prompt. The wire shape matches the CLI 0.16.1 attachment normalizer (loose records validated by live probing); the key is omitted entirely when a message has no attachments so the strict params schema never sees an empty array
- ZCode branch-state view for edit-fork families (branch switcher arrows, aligned with the OpenCode experience): `buildZCodeBranchView` derives each fork's boundary without stored metadata — the child's copied prefix (fresh ids, identical text) is matched against the parent by strict same-index text comparison, and the first user message after the prefix (the edited original) anchors the sibling grouping, so the original and edited prompts render as 1/2 branch alternatives and navigate across native sessions. The zcode reader assembles the family from sqlite `parent_id` unioned with Yep's `forkParentSessionId` sidecar metadata, serves it through `LoadedSession.branchState` (including `?branchId=` selection), and normalization annotates zcode user prompts (fresh-id copied prompts resolve back to canonical options by timestamp+text). Requires no client changes — zcode message uuids already equal native message ids
- ZCode bridge v1: supervision of externally started `zcode tui` sessions plus remote tool-approval forwarding (aligned with the OpenCode bridge capability, minimal scope). A new ZCode hook plugin (`packages/server/resources/zcode-plugin/` — `.zcode-plugin/plugin.json`, `hooks/hooks.json` registering all 7 CLI hook events, and `hook-entry.mjs`) forwards hook events to the main server; `PermissionRequest` waits for a client decision through a server-side long poll comfortably below the hook's `timeoutMs`, and every failure mode (no config, timeout, server error) exits silently so the TUI falls back to its native dialog. Server: `ZCodeBridgeService` (external-session registry fed by SessionStart plus hook keepalives and a quiet-session TTL — ZCode's `Stop` is turn-level, not SessionEnd — pending-permission queue, mtime-cached shared token from `~/.zcode/yep-bridge.json`) and `POST/GET /api/zcode-bridge/*` routes — the hook endpoint authenticates with the shared token (exempt from cookie auth via a middleware skip), client endpoints use the normal client auth. Client: a lightweight approvals card on the global sessions page (5s polling, approve/deny, tool + workspace + input preview, en + zh-CN copy). `scripts/install-zcode-yep-plugin.sh` copies the plugin into `~/.zcode/plugins/yep-bridge/`, expands absolute node/hook paths, writes the shared token (mode 600), and registers the directory in `plugins.dirs` with a config backup; `--uninstall` undoes all of it
- ZCode MCP server status visibility (first provider to expose MCP listing): `mcp/list` wiring with strict shared schemas (`ZCodeMcpListParamsSchema`/`ZCodeMcpServerStatusSchema`/`ZCodeMcpListResultSchema`); a new optional `AgentProvider.listMcpServers(cwd)` that spawns a short-lived app-server purely for the query and always sends `mode: "status"` (read-only, no MCP connections are opened) and projects only the safe fields (status/transport/toolCount/updatedAt/error — raw server config never leaves the CLI); `GET /api/providers/zcode/mcp-servers?projectId=<id>` (400 missing projectId, 404 unsupported, 503 capability failures with stable `zcode_*` code, 502 protocol errors); the new-session form shows an informational ZCode MCP Servers section (name + lifecycle status + tool count + failure summary, one fetch per provider selection, en + zh-CN copy)
- ZCode historical message editing via `session/fork` (edit-fork, aligned with the OpenCode experience): editing a persisted user prompt resumes the source session, locates the edited message through `session/messages`, forks the session at the predecessor message (ZCode message targets are inclusive, so the fork excludes the edited message and everything after), closes the source, and runs the new turn on the forked session which inherits the source's mode/model/thought level (explicit overrides are re-applied via `session/setModel`/`session/setMode`). Editing fails closed with a stable error when the edited message is unknown or is the session's first message. Shared `zcode-schema` gains strict `session/messages`/`session/fork`/`session/close` contract schemas and the `zcode_first_message_edit_unsupported` error code; the supervisor re-keys the process onto the fork's native id; `SessionCommandService` forwards `resumeSessionAt`, records `forkParentSessionId` lineage, and returns it in the resume response; the ZCode SQLite reader lists interactive fork children (still hiding `subagent_child` sessions) and surfaces native `parent_id` lineage so fork families collapse in the list views; the client enables historical editing for persisted ZCode prompts and reuses the provider-agnostic fork submission/navigation path
- ZCode per-model reasoning effort ("thought level") support: the config adapter now parses each model's `reasoning` capability (`{enabled, variants, defaultVariant}`) into catalog `thoughtLevels`/`defaultThoughtLevel`, `getAvailableModels()` advertises them as `supportedReasoningEfforts`/`defaultReasoningEffort`/`supportsEffort`, and the resolved level is sent as `thoughtLevel` on `session/create`/`session/resume`. Mirrors the CLI's own guard (`resolveZCodeThoughtLevel`): a level the selected model does not advertise is dropped rather than sent, and a model with `reasoning: null` (e.g. GLM-5.2) advertises none so the picker stays hidden
- ZCode ask/edit/plan/full-access mode copy on the new-session form and session mode selector, matching ZCode's own picker wording; previously the `modeZcode*`/`newSessionZcode*` strings were unreachable because `useProviderPermissionModeConfig` had no ZCode branch
- ZCode SQLite reader, project scanner, and persisted-session normalization (P2): `ZCodeSessionReader implements ISessionReader` with read-only `~/.zcode/cli/db/db.sqlite` queries (session/message/part tables, correct sequence ordering, change detection, listSessionFiles, index scope key); `ZCodeSessionScanner` with `GROUP BY directory` project aggregation and 5s cache; enriched `convertZCodeMessages` handling text/reasoning/tool (tool_use + tool_result)/step parts; provider-resolution `createZCodeSource`/`mayHaveZCodeSessions`/`buildCandidateGroups` wiring; scanner.ts `enableZCode`/zcodeScanner merge block/`getOrCreateProject` detection; app.ts `readerFactory`/`zcodeReaderFactory`/`processSessionSourceFactory`/route deps wiring; provider-catalog `zcodePaths`/`zcodeScanner`; read-only safety (fixture hash unchanged after reads)
- ZCode provider real-time session MVP (P1, 2026-08-12 real protocol fix, real model smoke happy path verified): `ZCodeProvider implements AgentProvider` with real ZCode CLI 0.16.1 protocol contract — `session/create` sends `workspace` (not `cwd`) and result is parsed from `result.session.sessionId` (not `result.id`); `session/resume` uses `sessionId` (not `id`); `session/send` uses `content` string (not nested message object); `session/setModel` uses `model: {providerId, modelId}` (not top-level fields); `workspace/updateProviderRegistry` sends `{workspace, registry: {revision, generatedAt, providers[]}}` with `apiKey: {source: "inline", value: ...}`; protocol event converter uses real `type`/`payload`/`seq` envelope (not `event`/`params`); `interaction/requestPermission` → `onToolApproval` routing; `interaction/requestProviderRuntimeHeaders` returns real provider headers; `session/requestRuntimePreferences` returns `{nativeSearchEnhancementsEnabled, memoryEnabled}`; `ensureCliConfig()` auto-creates `~/.zcode/cli/config.json`; `session/setMode` mid-session switching; `zcodeDbPath`/`zcodeReaderFactory` passed through provider resolution deps; real model smoke verified complete happy path: create → subscribe → send → model.streaming (reasoning_delta + text_delta) → turn.completed with usage, against live CLI 0.16.1
- ZCode provider compatibility contract and infrastructure (P0, 2026-08-12 real protocol fix): shared `zcode-schema` Zod schemas aligned to real CLI 0.16.1 — no `jsonrpc` field required in request/response/notification/server-request envelopes; workspace identity (`workspacePath`/`workspaceKey`), model ref (`providerId`/`modelId`), session params (create/resume/send/setModel/setMode/subscribe), session snapshot, and event envelope (`type`/`payload`/`seq`/`sessionId`) schemas; server `zcode-protocol` transport client omits `jsonrpc` from outbound messages; CLI discovery (env → PATH → macOS app bundle) with version probe; server-only config whitelist adapter supporting real `provider` object map (singular), `models` object map, `options` (apiKey/baseURL/headers), `enabled`/`systemDisabledReason` fields; registry builder outputs real `providerId`/`modelId` structure; read-only smoke verified against real CLI 0.16.1 (workspace/readState + session/list pass without timeout)
- Expose DeepSeek V4 Pro in the Codex model-source catalog (`deepseek-codex-2026-08-13`): `deepseek-v4-pro` joins `deepseek-v4-flash` in the new-session picker and `allowedModelIds`, with the same 1M context / 384K output and official `low/high/max` reasoning tiers
- Add a model-aware Kimi thinking-mode picker, apply the selected ACP thought level before the first prompt, and preserve it across session reloads and resumes
- APK-local mobile shell connection and diagnostics panel with editable server address, retry/default recovery actions, an always-available connection shortcut, bilingual copy, and copyable app/WebView connection details
- Process-level `CodexProjectionCache` with LRU/event-count waterlines and incremental projection replay; warm projections apply only events newer than the cached sequence instead of cold-reducing the full history
- Size-based rotation for the canonical Codex event journals: when the active `events.jsonl` reaches `YEP_CODEX_EVENT_STORE_ROTATE_BYTES` (default 256 MiB) the next append renames it to a timestamped segment (`events.{yyyyMMddHHmmssSSS}.jsonl`) and prunes closed segments beyond `YEP_CODEX_EVENT_STORE_KEEP_SEGMENTS` (default 3). Cold loads transparently aggregate retained segments in chronological order, per-session sequences stay continuous across segment boundaries, and rotations are logged via `codex_event_store_rotated`. Applies to both the provider journal and the 4510 bridge journal, bounding their disk growth (previously ~190 MB/day, unbounded)
- Cache-aware canonical source selection that validates projection prefixes after journal replacement while long-lived JSONL stores refresh only appended file bytes
- Soft time budget (`budgetMs`/`startedMs`) on the canonical overlay with `CodexOverlayBudgetExceededError`; the route catches budget expiry at overlay checkpoints and falls back to legacy normalization
- Structured diagnostic logging on the canonical overlay path: journal replay duration, overlay duration, total duration, cache hit/miss, event count, projected message count, and fallback outcome
- Synthetic benchmark script `scripts/bench-codex-overlay.ts` covering 100/1k/2k/5k/10k/20k event scales with cold reduce, warm apply, overlay, budget exceeded, and RSS/heap delta measurements
- Codex goal UI: the "Goal…" SessionMenu entry and `GoalModal` dialog are now available for owned Codex sessions (previously ZCode-only). The provider adapts the neutral goal actions to native `thread/goal/*` controls: replace clears the previous goal before setting a new active objective, pause writes a non-active status, resume writes `active` (which may make an idle Codex goal runtime start an automatic continuation), clear distinguishes an actual removal from an already-empty goal, and show formats objective, status, token budget/usage, and elapsed time in a TUI-style summary. Goal RPC completion alone does not prove whether a turn started; full automatic-turn supervision and new-session Goal-first remain tracked in `docs/project/2026-08-14-codex-goal-support-plan.md`
- Codex sub-agent transcript access: the session manifest indexes sub-agent sessions by `parent_thread_id` and retains their path/nickname/role/depth metadata. `CodexSessionReader` links durable paginated `item_completed` SpawnAgent items to child rollout files using the real call id, supports nested sub-agent parents, validates project/session lineage, normalizes child transcripts, and derives failed/interrupted/completed lifecycle from terminal events (including `task_complete.error`). The Session Inspector recognizes native sub-agent activity/collaboration items and links each child thread to its session page
- Codex native ThreadItem rendering (plan, sub-agent activity, collaboration): the canonical transcript view now turns `codex_native_item` system messages into dedicated proposed-plan, checklist, goal, and sub-agent blocks with English and Simplified Chinese copy. V2 `subAgentActivity` and V1 `collabAgentToolCall` payloads preserve current lowercase activity kinds and status-only agent states; unknown ThreadItem types render a compact escaped label instead of vanishing. Existing `compact_boundary`/`warning`/`turn_aborted` system rendering is unchanged
- Codex canonical goal and plan state: `thread/goal/updated` and `thread/goal/cleared` now reduce into the latest per-thread goal snapshot and project a current `threadGoal` item that remains visible outside the recent-item window until cleared. `turn/plan/updated` retains its full explanation/checklist payload and original event sequence, preventing a later turn event from duplicating or relocating the rendered plan row

### Changed
- Allow `llm-gateways.json` to hide exact, channel-qualified Pi picker entries through a hot-reloaded `hiddenModels` list. This keeps account- or gateway-specific failures out of new-session choices without making the models unroutable for existing sessions or hiding a working namesake on another channel.
- Move the current Codex Goal snapshot out of the chronological transcript and into Session Inspector, where it is derived from the authoritative `thread/goal/updated` objective rather than any user prompt; plan and goal state cards now stay available in the right-side session outline without being pinned beside the newest message
- Retire the Claude Code SSH channel from the active provider catalog, new-session flow, and provider settings, and stop provider refreshes from probing the remote Claude CLI; historical Claude session metadata and transcript rendering remain compatible
- Install deployment bundle runtime dependencies directly from `https://registry.npmmirror.com/` by default, ignoring inherited proxy settings and preferring the local npm cache; `YEP_DEPLOY_NPM_REGISTRY` can override the registry when needed, and deployment logs now show the selected network path
- Render Feishu-origin user prompts as compact channel messages instead of exposing raw context/attachment manifests: internal refs, hashes and operator IDs are hidden, generated image placeholders collapse into named preview chips, downloaded files become actionable links, and safe HTTP(S) document links in the message body open directly
- Harden the managed DeepSeek Codex provider for transient upstream overloads with eight HTTP/SSE retries, a ten-minute stream idle window, explicitly disabled OpenAI authentication/WebSocket inheritance, and a visible automatic-retry notice
- Gate the canonical Codex overlay behind an explicit `view=canonical` query. The transcript client opts in because it renders canonical native items; other Session GET consumers retain the lower-cost legacy normalization path, and the overlay keeps its projection budget/fallback safeguards for long journals
- Rewrite the canonical Codex event reducer as a linear batch builder that clones the initial projection once and uses `Set`-based dedupe indexes, eliminating per-event `structuredClone` of the entire state and O(N) array `includes` that made batch replay approach quadratic complexity
- Pre-build semantic duplicate and legacy item-id indexes in the canonical session overlay so candidate matching no longer rescans the full message list per candidate
- Fast-path `insertByTimestamp` by checking the tail element first, turning the common time-ordered append case from O(N²) into O(N)
- `JsonlCodexEventStore` now tracks file size/mtime and only reads the appended tail on subsequent replays, avoiding a full-file `readFile` when a long journal has only grown
- JSONL source factories now share a single `JsonlCodexEventStore` instance per file path so the incremental file refresh works across requests
- Window canonical candidate construction by a recent-event lower bound when the caller only needs the tail, avoiding Message construction for old projection items while still replaying complete state
- Update the built-in mobile shell `mini` node to its current connection endpoint

### Fixed
- Prevent wide code and diff results from making the APK transcript itself horizontally pannable; horizontal scrolling now stays inside the renderer that owns it, so a right swipe cannot drag the mobile message viewport out of bounds
- Keep the APK shell from covering session search, outline, and info actions with its persistent connection pill: custom endpoint recovery and diagnostics now open from Settings → Local Access (and still appear automatically on connection failure). Synchronize the edge-to-edge safe-area background plus Android status/navigation bar icon contrast with the embedded client's selected `light`, `dark`, `verydark`, or resolved `auto` theme
- Let Codex bridge MCP startup progress settle when `cf` uses a light or clear per-thread profile: Codex 0.147 derives the TUI's expected startup set from the unprofiled local config, while app-server emits status only for profile-enabled servers, leaving the header stuck on the last real MCP (often `feishu-mcp`). After a successful thread start/resume/fork, the bridge now sends terminal UI-accounting events for client-expected servers disabled by the selected profile; this neither enables those servers nor adds tools, and synthetic events stay out of bridge diagnostics
- Prevent provider transcript rows from multiplying across reconnects: Codex live lifecycle items and persisted rollout messages now reconcile by their native turn/item identity instead of text-and-time heuristics alone, while ZCode suppresses replayed event sequences, consumes the real strict `message.upserted` payload, and assigns stable identities to reasoning and tool rows
- Preserve Kimi's active permission mode when approving an `ExitPlanMode` review, so a YOLO session no longer falls back to manual approval before implementation or passes that downgraded mode to subagents
- Prevent Kimi ACP sessions from silently dropping later items in a batched `AskUserQuestion`: the host now tells Kimi to ask one question per call, retry any omitted question separately, and never infer a Recommended default; persisted and live Kimi JSON answer results are also normalized so transcripts show the real answered count and selected option instead of `0 answered`
- Keep each transcript Thinking disclosure independent, so expanding or collapsing one reasoning block no longer changes every reasoning block in the current session or nested subagent transcript
- Deduplicate Codex code-mode plan progress between the transcript and Session Inspector, keep native-only turn-plan snapshots available in the inspector, and suppress canonical reasoning/command/message placeholders that only repeated normalized transcript activity as empty label cards
- Normalize Kimi `TodoList` progress consistently across live ACP updates and persisted wire replay: structured writes now collapse into the Session Inspector plan, read-only queries remain visible tool rows, and the duplicate ACP `plan` notification no longer appears as fake reasoning that vanishes after refresh
- Show the context-usage indicator on first entry into a session instead of only after navigating away and back: both bridge-owned and stdio app-server Codex sessions now consume `thread/tokenUsage/updated` as it arrives (using fresh input tokens normally and the compacted total when post-compaction input is zero); the stdio provider projects live `system/turn_usage` messages instead of waiting for `turn/completed`, while the bridge persists usage and carries it on session summaries and `session-updated` events (including the sidecar poll diff). The Session GET extracts both live and completed Codex usage with the SDK-reported context window, and the client applies early live messages and metadata events even around its initial load, retaining a delayed metadata retry only as a fallback
- Reset the APK mobile shell to the destination server's project list when switching endpoints instead of carrying over the previous server's project/session route and surfacing `Project not found`; same-endpoint retries still preserve the current page
- Keep long-running `/goal` workflow sessions in the regular session list and sidebar instead of classifying them as one-off slash-command sessions
- Keep ZCode's shared SQLite store intact when archiving one session by toggling only that project-scoped row's `time_archived`, and require the configured project directory for every ZCode summary/content/stats lookup so a guessed session ID cannot cross project boundaries. Compatibility credentials are now carried into the in-memory provider registry, malformed non-string runtime headers fail closed, MCP status errors are credential-redacted, and the hook installer explicitly enforces `0600` on both bridge and CLI config files
- Refuse Codex bridge status endpoints on unrelated hosts before attaching the desktop bearer token; wildcard bridge listeners are rewritten to the configured control host, while loopback aliases remain interoperable
- Prevent ZCode provider discovery and model/MCP queries from copying credential-bearing `v2/config.json` data into `~/.zcode/cli/config.json`: bootstrap creation now occurs only when a managed session starts, writes only the selected composite model with atomic `0600` permissions, preserves existing content while tightening its mode, and keeps all query paths read-only. Keep external sessions registered across turn-level `Stop` hooks until their quiet-session TTL expires, and distinguish interactive edit forks from `subagent_child` rows so fork updates remain live while internal transcripts stay out of user indexes. The shared ZCode request contracts now mirror the CLI's strict schemas at top-level and nested workspace/model/registry boundaries so extra keys fail tests before reaching the app-server
- Restore ZCode live assistant streaming: the real CLI 0.16.1 `model.streaming` payloads carry chunks in `delta` (not `text`/`reasoning`), identify messages with `assistantMessageId` (not `messageId`), flush `tool_input_delta.delta` as a full accumulated snapshot (not an increment), and send the parsed `input` object on `tool_call` — the converter read the legacy fixture spellings, so live assistant text and reasoning were silently dropped and streamed tool inputs could be corrupted. The converter now reads the real fields (legacy spellings kept as fallbacks), the fake app-server emits the real shape, and new converter tests lock the contract. Verified by an authorized live-model smoke: registry apply → session/create → streamed marker text → turn.completed with usage → file attachment round-trip (model echoed the attached file's content) → exclusive edit-fork (child omits the replaced prompt) → mcp/list
- Preserve the last retryable Codex provider cause when automatic retries end in an unclassified error, and restore provider retry/failure messages after refresh through a method-indexed lightweight journal overlay without re-enabling the expensive canonical item projection
- Prevent adjacent Feishu merge-forward material and its instruction from producing duplicate replies by batching at durable ingress before slow normalization, while preserving one provider turn per reply card when inputs miss the batching window
- Unblock ZCode session creation: the real CLI 0.16.1 validates `workspace/updateProviderRegistry` with a strict schema that requires each `registry.providers[]` entry to carry a non-empty `models` array of bare `{modelId}` entries and rejects `name` keys at both the provider and the model level, but the registry builder emitted `name` and omitted `models` for providers without catalogued models, so every update failed with `-32602 Invalid params — registry.providers.0.models: expected array, received undefined; Unrecognized key: "name"` and no ZCode session could start. The builder and shared schemas now match the probed live contract (providers with zero models are skipped entirely), verified end-to-end against the live CLI 0.16.1 with the machine's real config (registry `status: "applied"`, model catalog populated)
- Resolve Codex session reasoning effort against the selected model source's advertised tiers: DeepSeek uses its official `low/high/max` set and compatibility mapping (`medium`/`xhigh` → `high`), with unknown higher tiers clamped to `max` and other unknown values falling back to the model default (`high`); OpenAI keeps the full tier set. This applies on new sessions, resume, edit-fork, queued messages, and stale effort values read back from a previous turn
- Use the 4520-managed OpenCode server's connected model catalog for Yep's picker and turn execution, including treating a successful empty provider list as authoritative instead of falling back to another process's CLI catalog; hide models from providers unavailable to that runtime, and remap stale provider-qualified session selections to the sole connected provider exposing the same model ID. This prevents failures such as `ProviderModelNotFoundError: Model not found: deepseek/deepseek-v4-pro` when the executable route is `ohmyrouter/deepseek-v4-pro`
- Stop offering ZCode's `auto` permission mode: ZCode CLI 0.16.1 denies every tool call in that mode (`mode.auto.unimplemented`, "Auto mode is reserved but not implemented yet") and its own picker exposes only build/edit/plan/yolo. Because Yep's canonical `DEFAULT_PERMISSION_MODE` is `auto`, advertising it made it the implicit default for new ZCode sessions and blocked every tool. The provider now advertises `default`/`acceptEdits`/`plan`/`bypassPermissions` only, and `YEP_TO_ZCODE_MODE_MAP.auto` degrades to `build` so sessions persisted before the withdrawal still run
- Stop sending `model` and `mode` on ZCode `session/resume`: the real params schema is `.strict()` and accepts neither key, so every resume that carried a selected model or permission mode failed with `-32602 Invalid params`. Both are now applied after the session exists via `session/setModel`/`session/setMode`. The test fixture now enforces the real CLI's strict param allowlists so this class of contract violation fails in CI instead of only against the live CLI
- Stop advertising a ZCode thinking toggle the provider could not apply: `supportsThinkingToggle` was `true` while nothing read `options.thinking` or called `session/setThoughtLevel`, so the control was a no-op. ZCode's reasoning control is a named per-model thought level and is now surfaced through `supportedReasoningEfforts` instead
- Normalize ZCode `turn.completed` usage into canonical token fields (`input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) instead of passing the raw provider object straight through, so ZCode sessions report token usage in the UI. Accepts the AI-SDK camelCase, Anthropic, and OpenAI spellings the CLI itself reads, and falls back to `cacheStats.cacheReadTokens` when the usage object omits cache accounting
- Keep a ZCode model in the catalog when its `reasoning` capability has an unexpected shape, instead of letting the malformed field drop the whole model
- Rejoin 4510-owned Codex sessions through the resident bridge WebSocket instead of spawning a competing stdio app-server, including active-turn steering and a typed bridge error; route resumed direct OpenCode TUI sessions through a 4520/plugin command channel so prompts, permission changes, and aborts execute in the original process instead of silently switching to 4521
- Surface Kimi ACP refusals and prompt failures as visible session errors, and preserve persisted `turn.ended` provider errors such as `provider.filtered` after transcript reloads
- Make LaunchAgent log-size detection portable across BSD and GNU `stat` by discarding partial output from a failed probe before falling back
- Restore Kimi CLI 0.34 session discovery by normalizing v2 `state.json` metadata (`cwd` and numeric timestamps), watching Kimi session files, invalidating summary/search indexes, and accepting the current ACP `usage_update` notification shape
- Make local 8022/4510/4520 deployment cutovers safe and deterministic: serialize CLI/UI deploys, wait for embedded active work, reject conflicting dev auxiliary ports before shutdown, reload bridge LaunchAgents from the promoted runtime, preserve the real previous bundle on duplicate syncs, and persist detached job exit results across the 8022 restart
- Restore uploaded-image preview modals without re-exposing server-local paths by projecting managed attachments to validated, authenticated API URLs in live and persisted session messages
- Keep the Reports page pointed at the repository-adjacent `research_tasks` directory after LaunchAgent runtime isolation by persisting an absolute `YEP_REPORTS_DIR`, reloading updated server plists at the coordinated restart point, and retaining a repository-root fallback
- Keep the APK recovery panel visible until the embedded Yep Anywhere client sends its real ready signal, and migrate the retired `43.226.60.75:61874` default instead of letting persisted app data override the current endpoint
- Keep canonical transcript export and Feishu/Lark projection on their original canonical journal paths so they are unaffected by the normal Session GET capability gate
- Preserve in-progress agent, plan, and reasoning stream content when the canonical item-start snapshot still contains empty placeholder fields
- Load the canonical Codex event journal in bounded chunks instead of a single `readFile`: once `events.jsonl` grew past the runtime's maximum string length (~512 MiB) every cold store load threw `RangeError: Cannot create a string longer than 0x1fffffe8 characters`, which surfaced as new Codex sessions failing immediately after `thread/start` (`API error: 500`). A failed cold load also no longer poisons the store for the process lifetime — the next caller retries instead of rethrowing the cached rejection
- Show live Kimi subagent activity while a foreground `Agent`/`AgentSwarm` call is still running, instead of pinning the card to "waiting for first activity" until it finishes: Kimi's ACP adapter never streams child events, and the child's id only traveled inside the parent tool result, so the client could not locate the on-disk transcript beforehand. The reader now maps explicit `resume`/`resume_agent_ids` back to their existing child directories and assigns new pending spawns provisional ids from the remaining `agents/<id>/` directories in call order, bounded by each call's declared item count. The client keeps partially discovered swarms unresolved, retries briefly for directory-creation lag, re-reads mappings when later child wire files appear, and replaces provisional ids with result-backed identities once children complete

### Security
- Restrict deploy env files, LaunchAgent plists/logs, and deployment job state to private permissions, and rotate oversized LaunchAgent logs during installation

## [2026.8.2] - 2026-08-10

### Changed
- Restore the pre-canonical session rendering and navigation experience while retaining the self-hosted Feishu/Lark channel backend, durable interactions, and safe deployment runtime
- Run every OpenCode SQLite read on a dedicated worker thread with a query deadline, a soft budget, and structured `durationMs`/timeout diagnostics, so a slow scan of a multi-gigabyte `opencode.db` can no longer stall the API thread, WebSocket traffic, or heartbeat timers
- Create `yep_`-prefixed `time_updated` helper indexes on `opencode.db` at startup, guarded by an upstream-schema check and disabled by `OPENCODE_DB_ENSURE_INDEXES=false`, turning incremental change scans from full table scans into covering-index range searches

### Fixed
- Load `.env.deploy.local` in `scripts/install-launchagents.sh` so a standalone LaunchAgent reinstall no longer rebuilds the plist without the session-title, OpenCode model, and FCM credentials that `scripts/deploy.sh` already supplies
- Stop resolving single-session OpenCode stats through a whole-database aggregation; the freshness check for one session no longer costs a full `message`/`part` scan, which dominated session listing and search latency
- Drop the per-refresh `SUM(LENGTH(data))` over every OpenCode message and part, replacing the session-index change token with row counts that need no payload reads (forces one re-index of OpenCode sessions after upgrade)
- Bound the OpenCode change-monitor replay window inside each `UNION` branch; it previously aggregated `session`, `message` and `part` in full on every drained poll
- Replace the OpenCode replay fingerprint's full-row `SELECT *` with an aggregate digest, and batch the reader's per-message part lookups into grouped queries, removing the N+1 reads behind session detail and project listings
- Fix an out-of-scope `base` reference that made an OpenCode subagent-listing test throw, and load `node:sqlite` through `process.getBuiltinModule` in tests so the OpenCode SQLite suites actually execute under Vitest instead of silently skipping

## [2026.8.1] - 2026-08-09

### Added
- Check in a complete Codex app-server 0.147.0 stable/experimental protocol baseline with deterministic schema manifests and explicit coverage guards
- Add a durable, redacted Codex event spine with replay, diagnostics, canonical transcripts, and shadow-by-default bridge/provider ingress
- Centralize pending approvals and questions behind a durable at-most-once CAS interaction authority, with authenticated Codex sidecar claims and lifecycle recovery
- Harden resident provider ownership with atomic worker admission, restart-safe terminal replay, fail-closed message queues, stable Codex turn controls, and redacted bridge diagnostics
- Add a provider-neutral session application layer with source-preserving Codex forks, lineage, structured Skills input, native controls, and authenticated canonical transcript export
- Add bounded attachment extraction and generated-artifact materialization with opaque references, exact-event provenance, retention, and verified downloads
- Add an inert-by-default self-hosted Feishu/Lark channel with isolated accounts, durable inbox/outbox, CardKit replies, broker-backed interactions, commands, diagnostics, and read-only migration preflight
- Add typed client rendering for native Codex activity, Skills, subagents, fork lineage, canonical interactions, artifacts, transcript export, and Feishu account settings
- Expose the pinned Codex protocol identity and bounded fingerprint-only compatibility diagnostics through the version API

### Changed
- Align `.nvmrc` and `.node-version` on Node 22.22.2, verify the repository-pinned pnpm through Corepack, and keep deploy entry points independent of incidental global toolchains
- Run macOS LaunchAgents from an atomically promoted repository-external runtime bundle while retaining one verified previous bundle for rollback

### Fixed
- Keep JSON and other non-media OpenCode uploads on the tool-readable local-path flow instead of forwarding unsupported MIME types as native model attachments
- Preserve image/PDF input for Anthropic OpenCode models that use the legacy `attachment: true` capability by emitting the `modalities` declaration required by current OpenCode

### Security
- Keep Feishu/Lark app secrets write-only and exclude message content, answers, provider tool input, raw identities, credentials, and private paths from durable projections and diagnostics
- Bind generated artifacts and channel callbacks to exact event, actor, scope, generation, digest, and workspace provenance before exposing downloads or external actions

## [2026.8.0] - 2026-08-06

> Backfilled summary covering the ~278 commits between `v0.4.28` and the start of
> the independent fork release line. The `0.4.29` recorded in `package.json`
> during this period was an intermediate working version that was never formally
> released, so it has no section of its own. Entries below are a thematic
> summary rather than a per-commit reconstruction. See
> `docs/project/versioning.md` for the release model.

### Added
- Multi-provider sessions: OpenCode, Codex and Kimi CLI (over ACP) alongside Claude, with provider-neutral session branches
- Per-session model source selection, provider-prefixed model grouping, and model reasoning variants
- SSH remote executors, relay host picker, remote terminal, and remote Claude project support
- Device bridge: app-server bridge sidecar, session inspector, and bridge turn health indicators
- Global conversation search and in-session message search
- Subagent sessions, transcripts, and swarm details rendered inline
- Multimodal image input, native file part uploads, and inline comments with image assets
- Context window breakdown modal backed by a persisted window cache
- Actionable approve/deny directly on pending-input notifications
- Interactive deploy flow and a dev hot-reload deploy action
- Browsable project path picker and project-filtered session shortcuts
- Sidebar session bulk actions, project activity, and git status summaries
- Codex account usage display on the new-session form
- Independent fork release line: builds carry a release channel and no longer offer upstream releases as updates
- Mobile shell preset for the home node

### Changed
- Version numbers are calendar-based (`YYYY.M.N`), replacing SemVer; they can no longer be confused with an upstream release
- Device bridge binaries are fetched from this repository rather than upstream's releases, and can be redirected with `YEP_BRIDGE_REPO`
- Approvals are driven through native ACP session modes, with provider-specific permission modes surfaced in the new session form
- The selected permission mode is remembered per session, survives provider restarts, and can be changed while a session is idle
- Session state machine and rewind accuracy realigned with upstream part coverage
- Transcript rendering reworked: live exec output, MCP cells, warnings, markdown details blocks, web tool outputs, and the AskUserQuestion UI
- Change signals are pushed rather than polled, removing polling latency
- Session message list is virtualized; git status, session stats, summaries and deterministic text rendering are now cached
- WebSocket frames are compressed
- Desktop layout widened with collapsible side panels

### Fixed
- Session titles are retried, backfilled, and preserved across boilerplate events
- OpenCode provider startup hardened; spurious change events no longer emitted
- Codex MCP profile compatibility across different launch environments
- Codex sessions no longer fail to start when the local MCP configuration does not match Yep's expected server list
- Anthropic-compatible gateways no longer reject tool calls over schemas Bedrock cannot accept
- Codex model source and live messages preserved across resume and snapshot refresh
- Server LaunchAgent restarts after crashes

### Removed
- Desktop auto-updater, which pointed at upstream's update service and verified against upstream's signing key — upstream builds could install over this fork, and this fork can never sign an update of its own

## [0.4.28] - 2026-04-16

### Changed
- Upgrade claude-agent-sdk to 0.2.111 (adds Opus 4.7 support)

## [0.4.27] - 2026-04-16

### Fixed
- Preserve provider on session restarts

## [0.4.26] - 2026-04-13

### Fixed
- Prefer persisted provider for session resume and agents

## [0.4.25] - 2026-04-13

### Added
- Core workspace setup script

### Fixed
- Fix clearing empty server settings
- Keep idle Claude sessions owned while alive
- Fix Codex sessions not appearing in All Sessions on Windows
- Fix Windows spawn ENOENT and EINVAL in scripts
- Fix notification read-state persistence on restart
- Fix Windows project path deduplication

## [0.4.24] - 2026-04-05

### Added
- Lifecycle webhook support
- ToolSearch schema validation
- Claude metadata session entry handling
- Relay host upsert on auto-resume for reliable reconnect

### Changed
- Update claude-agent-sdk to 0.2.90
- Update Claude model selection options
- Move persist-remote-sessions toggle to Remote Access settings
- Align Codex session schema with upstream types

### Fixed
- Avoid new-session remounts on project refresh
- Allow local image access to managed uploads
- Fix relay host ID race condition during session refresh
- Fix modal title overflow on long names

## [0.4.20] - 2026-04-02

### Added
- Local media preview modal for file paths in markdown
- Prefer recent project for new sessions

## [0.4.19] - 2026-03-29

### Added
- Centralized cross-provider session listing
- Session summary caching for Gemini and Codex providers
- Safe HOME guards for dev and test entrypoints

### Fixed
- Fix streaming edit patch filenames
- Improve PTY and Codex PTY tool rendering
- Fix mixed-provider session resolution and titles
- Preserve Claude sibling ordering on reload
- Stabilize session replay and queued prompt rendering
- Detect Codex CLI from desktop app sandbox-bin location

## [0.4.18] - 2026-03-27

### Added
- New session defaults: save preferred provider, model, and permission mode
- Local image viewing for Codex imageView events
- Scoped session indexing for shared providers

### Fixed
- Resolve allowed image paths for macOS /tmp symlink
- Deduplicate sessions on Windows caused by mixed-slash cwds
- Improve provider process handling

## [0.4.17] - 2026-03-22

### Fixed
- Widen tool_result content type for broader SDK compatibility
- Stabilize Claude persisted session rendering
- Guard localStorage calls in i18n module
- Prevent false unread notifications from late JSONL writes
- Exclude progress messages from DAG to prevent dead branches

## [0.4.16] - 2026-03-21

### Added
- Client-side i18n with lazy-loaded locale bundles (English, Chinese, Spanish, French, German, Japanese)
- Language selector in Appearance settings

## [0.4.15] - 2026-03-19

### Fixed
- Pin @biomejs/biome to 1.9.4 to fix CI (pnpm resolved ^1.9.4 to breaking 2.x)

## [0.4.14] - 2026-03-19

### Added
- Provider filtering and voice input toggle via environment variables
- Dynamic model list and Claude profile support
- Age filter and bulk archive for filtered sessions
- Approval panel truncation with view-details modal for large tool calls

### Changed
- Update Claude Agent SDK to 0.2.77

### Fixed
- Prevent NODE_ENV=production from leaking into Claude Code child processes (#41)

## [0.4.13] - 2026-03-15

### Changed
- Update Claude Agent SDK to 0.2.76 with runtime context window detection
- Support SDK 0.2.76+ Agent tool format and subagents directory
- Version-aware device bridge updates
- Restore iOS simulator home button

## [0.4.12] - 2026-03-13

### Added
- iOS simulator device bridge support with HID input
- Improved iOS simulator bridge preflight error messages

### Changed
- Reduce routine update checks

## [0.4.11] - 2026-03-12

### Added
- Relay telemetry and stats dashboard
- Relay server compatibility reporting
- Fetch version and bridge version from update server instead of npm registry/hardcoding

### Fixed
- Fix inbox race condition
- Prevent Enter key from triggering send during IME composition
- Relax relay resume proof skew tolerance

## [0.4.10] - 2026-03-10

### Added
- `/model` slash command for mid-session model switching
- Codex correlation debug logging

### Codex
- Improve replay deduplication
- Preserve timestamps on stream messages
- Improve session reconnect merging

### Fixed
- Fix Codex session titles on agents page
- Fix Codex session cloning in mixed projects
- Fix Codex session clone visibility
- Fix Codex session discovery defaults
- Reduce Codex debug logging overhead

## [0.4.9] - 2026-03-06

### Added
- ModelInfoService for accurate context window lookups
- PDF file previews in Read tool renderer
- Server timestamps to streamed SDK messages for replay dedup
- Stream vs persisted render parity harness
- Slash commands attached to session REST response

### Codex
- Keep pending Bash rows collapsed
- Improve image previews and Bash row summaries
- Normalize tool rendering (heredoc writes, bash, edit patches) across stream and JSONL
- Surface rate limit exhaustion as error messages
- Treat rate-limit updates as telemetry only
- Log Codex messages to sdk-raw

### Fixed
- Filter replayed stream messages using persisted timestamp watermark
- Fix getResultSummary crash for PDF Read results
- Fix live Codex edit patch previews for file changes
- Persist provider to session metadata for correct resume
- Detect claude-ollama sessions from model name in JSONL
- Skip Ollama detection ping when URL is explicitly configured

## [0.4.8] - 2026-03-03

### Added
- Android device bridge with WebRTC streaming and MediaCodec capture
- ChromeOS device transport and streaming with host aliases
- Ollama local model provider with customizable system prompt
- Adaptive bitrate and quality controls for device streaming
- Immersive keyboard mode for Android device input
- On-demand download for device bridge sidecar binary
- CI pipeline for device bridge sidecar binaries
- Emulator streaming E2E tests and validation scripts

### Fixed
- Fix Windows session spawning across all providers
- Fix session resume losing provider for non-Claude models
- Fix crash when tool result content is an array instead of string
- Stabilize Android stream startup and soak reliability
- Fix keyboard input mapping for emulator and Android streams
- Fix WebRTC video stream stalling after a few seconds
- Fix sidecar crash on WebSocket disconnect
- Fix emulator bridge cascading restart loop

### Changed
- Rename Emulator to Devices in sidebar and routes
- Refactor bridge to unified device interface with Android and ChromeOS transports

## [0.4.7] - 2026-03-01

### Added
- Draft badge in session sidebar, list, and inbox

### Fixed
- Fix Codex sessions not appearing due to truncated first-line read (#23)
- Fix duplicate message display when queuing deferred messages
- Fix stale detection killing busy processes and orphaning CLI sessions

## [0.4.6] - 2026-02-27

### Added
- Configurable tab size setting for code and diff display
- Codex scanner diagnostics for troubleshooting session discovery

### Fixed
- Fix Windows session discovery
- Fix Gemini session discovery for newer CLI versions
- Fix Codex/Gemini session discovery when ~/.claude/projects is missing

### Changed
- Update Gemini model list for v0.30.0 CLI
- Optimize Gemini session loading with generalized session index
- Extract shared JSONL/BOM utilities to reduce duplication

## [0.4.5] - 2026-02-25

### Added
- Session cloning support for Codex sessions
- Show session creation date in Session Info panel

### Fixed
- Fix Codex sessions failing with 'minimal' reasoning effort
- Fix broken image paths in README

## [0.4.4] - 2026-02-25

### Added
- 3-way thinking toggle: off / auto / on (model decides when to think in auto mode)

### Fixed
- Fix thinking "on" mode for Opus 4.6+ and wait for CLI exit on abort
- Reconnect session stream after thinking-mode process restart
- Fix context usage percentage being too low after compaction
- Fix DAG not bridging across compaction boundaries with broken logicalParentUuid
- Fix source control page issues

## [0.4.3] - 2026-02-23

### Added
- Source Control page with git working tree status
- File diff viewer: click any file to see syntax-highlighted diff with full context toggle and markdown preview
- Session sharing via Cloudflare Worker + R2

### Fixed
- Fix denied subagent showing spinner instead of error state
- Fix remote client redirect loop on git-status page
- Fix DAG selecting stale pre-compaction branch over post-compaction one

## [0.4.2] - 2026-02-22

### Added
- HTTPS self-signed cert support (`--https-self-signed` flag and `HTTPS_SELF_SIGNED` env var)
- Codex shell tool rendering for grep/read workflows

### Fixed
- Fix HTTP LAN access: randomUUID fallback for insecure contexts and non-secure cookie handling
- Lazy-load tssrp6a to fix crash on HTTP LAN access (insecure context)
- Auth disable now clears credentials and simplifies enable flow

### Changed
- File logging and SDK message logging default to off (opt-in)
- Replace `LOG_TO_CONSOLE` with `LOG_PRETTY` for clearer semantics

## [0.4.1] - 2026-02-22

### Added
- Session cache with phased optimizations: cached scanner results, batched stats, cached stats endpoint with invalidation
- Cross-process locking and atomic writes for session index files
- Improved pending tool render and settings copy

### Fixed
- Fix localhost websocket auth policy when remote access is enabled
- Fix send racing ahead of in-flight file uploads

## [0.4.0] - 2026-02-22

### Security
- Harden markdown rendering against XSS
- Harden SSH host handling for remote executors
- Harden auth enable flow and add secure recovery path
- Patch vulnerable dependencies (bn.js)
- Enforce 0600 permissions on sensitive data files
- Add SRP handshake rate limiting and timeout guards
- Harden session resume replay defenses for untrusted relays
- Harden relay replay protection for SRP sessions

### Added
- Tauri 2 desktop app scaffold with setup wizard
- Tauri 2 mobile app scaffold with Android support
- Global agent instructions setting for cross-project context
- Permission rules for session bash command filtering
- Legacy relay protocol compatibility for old servers

### Fixed
- Guard SecureConnection send when WebSocket global is unavailable
- Stop reconnect loop on intentional remote disconnect
- Fix stale reconnect race and reduce reconnect noise
- Fix localhost cookie-auth websocket regression
- Fix WebSocket SRP auth-state coupling and regressions
- Fix server crash when spawning sessions with foreign project paths
- Fix streamed Codex Edit patch augmentation parity
- Fix Linux AppImage builds (patchelf corruption, native deps, signing)

### Changed
- Default remote sessions to memory with dev persistence toggle
- Refactor websocket transport into auth, routing, and handler modules
- Improve server update modal copy and layout
- Remove browser control module

## [0.3.2] - 2025-02-18

### Changed
- Update README with current Codex support status (full diffs, approvals, streaming)

## [0.3.1] - 2025-02-18

### Fixed
- Fix Codex provider labeling (CLI, not Desktop)

## [0.3.0] - 2025-02-18

### Added
- Codex CLI integration with app-server approvals and protocol workflow
- Codex session launch metadata, originator override, and steering improvements
- Focused session-watch subscriptions for session pages
- Server-side highlighted diff HTML for parsed raw patches
- Browser control module for headless browser automation

### Fixed
- Relay navigation dropping machine name from URL
- Codex Bash error inference for exit code output
- Codex persisted apply_patch diff rendering
- Codex session context and stream reliability

### Changed
- Collapse injected session setup prompts in transcript
- Normalize update_plan and write_stdin tool events
- Improve Codex persisted session rendering parity
- Show Codex provider errors in session UI

## [0.2.9] - 2025-02-15

### Fixed
- `--open` flag now opens the Windows browser when running under WSL

## [0.2.8] - 2025-02-15

### Added
- `--open` CLI flag to open the dashboard in the default browser on startup

## [0.2.7] - 2025-02-13

### Fixed
- Fix relay connect URL dropping username query parameter during redirect

## [0.2.6] - 2025-02-09

### Fixed
- Fix page crash on LAN IPs due to eager tssrp6a loading
- Fall back to any project for new sessions; replace postinstall symlink with import rewriting

## [0.2.5] - 2025-02-09

### Fixed
- Windows support: fix project directory detection for Windows drive-letter encoded paths (e.g. `c--Users-kaa-project`)
- Windows support: fix session index path encoding for backslash separators

## [0.2.4] - 2025-02-09

### Fixed
- Windows support: replace Unix `which` with `where` for CLI detection
- Windows support: accept Windows absolute paths (e.g. `C:\Users\...`) in project validation
- Windows support: fix path traversal guard and project directory encoding for backslash paths
- Windows support: use `os.homedir()` instead of `process.env.HOME` for tilde expansion
- Windows support: fix path separator handling in codex/gemini directory resolution
- Windows support: show PowerShell install command instead of curl/bash

## [0.2.2] - 2025-02-03

### Added
- Relay connection status bar
- Website release process with tag-based deployment

### Fixed
- Sibling tool branches in conversation tree

### Changed
- Simplify Claude, Codex, and Gemini auth to CLI detection only
- Update claude-agent-sdk to 0.2.29

## [0.2.1] - 2025-01-31

### Added
- CLI setup commands for headless auth configuration
- Relay `/online/:username` endpoint for status checks
- Multi-host support for remote access
- Switch host button to sidebar
- WebSocket keepalive ping/pong to RelayClientService
- Host offline modal and tool approval click protection
- Error boundary for graceful error handling
- Terminate option to session menu

### Fixed
- Host picker navigation and relay routes session resumption
- Relay login to set currentHostId before connecting
- DAG branch selection to prefer conversation over progress messages
- Session status event field name and auto-retry on dead process
- Sidebar overlay auto-close logic
- SRP auth hanging on unexpected messages
- Relay reconnection error messages for unreachable server
- Mobile reconnection showing stale session status
- Dual sidebar rendering on viewport resize
- Skip API calls on login page to prevent 401 popups
- Various relay host routing and disconnect handling fixes

### Changed
- Update claude-agent-sdk to 0.2.19
- Rename session status to ownership and clarify agent activity

## [0.1.10] - 2025-01-23

### Fixed
- Handle 401 auth errors in SSE connections
- Fix session stream reconnection on mobile wake
- Fix relay reconnection to actually reconnect WebSocket

### Added
- Connection diagnostics and detailed reconnect logging
- Show event stream connection status in session info modal
