# OpenCode Provider 与 4520 Bridge 分阶段退役计划

状态：待实施

日期：2026-08-18

范围：Yep Anywhere 仓库内的 OpenCode provider、OpenCode session 发现/读取、4520 bridge、4521 managed `opencode serve`、forwarder plugin、部署与客户端入口

## 1. 决策与结论

Yep Anywhere 将退役 OpenCode 作为可创建、可恢复、可扫描和可远程审批的 provider 渠道，并移除 4520 OpenCode bridge 的构建、安装、启动、轮询、部署和运维入口。

本计划采用“先解耦、再断流、后删代码、最后经授权做运行态切换”的顺序，原因是当前有几段以 OpenCode 命名的代码已经被 Pi 或 ZCode 复用，不能直接删除：

- ZCode 复用 `packages/server/src/sessions/opencode-db.ts`、`opencode-db-worker.ts` 的通用 SQLite 查询能力；
- ZCode 复用 `packages/server/src/projects/opencode-scanner.ts` 的 `SESSION_DIGEST_SQL`；
- Pi 和 `OhMyRouterBenchmarkService` 复用 `packages/server/src/opencode-bridge/gateway-config.ts` 的部分 gateway 解析能力；
- `collapseEditForkFamilies` 虽位于 `opencode-branch.ts`，但已经用于 provider-agnostic 的 session 列表折叠；
- `OpenCodeSessionConfig` 等名称已经泄漏到 Pi 的 managed gateway 配置路径。

退役 OpenCode 不等于删除用户的 OpenCode 数据。`~/.local/share/opencode/opencode.db` 仍由 OpenCode 自己拥有；Yep 只停止读取、修改、索引和展示它。

## 2. 目标

完成后必须满足：

1. Yep 的 provider 列表、创建入口、恢复入口和 UI 中不再出现 OpenCode。
2. 主服务不再创建 `OpenCodeSessionScanner`、`OpenCodeSessionReader`、`OpenCodeBridgeHttpClient` 或 `OpenCodeSessionChangeMonitor`。
3. 普通启动、项目列表、global sessions、search、recents、inbox 和 focused watch 不再访问 `opencode.db`。
4. Yep 不再创建或检查 `yep_*` OpenCode SQLite 索引。
5. bundle 不再包含 OpenCode forwarder plugin 或 `yepanywhere-opencode-plugin` bin。
6. LaunchAgent 安装与 redeploy 默认路径不再安装、同步、保活或重启 4520/4521。
7. 代码经过授权部署后，主服务不再连接 4520，4520 bridge 与其 4521 child 可被安全卸载。
8. Pi、ZCode、Codex、Claude、Gemini、Kimi 等保留渠道行为不回归。
9. 旧 Yep metadata、recents、indexes 中出现 `provider: "opencode"` 时，服务能容错启动并忽略这些记录，而不是让整个状态文件解析失败。
10. OpenCode 原始数据库、session、event、用户配置不被自动删除或迁移。

## 3. 非目标

- 不清理、压缩、`VACUUM` 或删除 `opencode.db`。
- 不自动执行 `DROP INDEX yep_*`；如未来需要，必须是独立、显式、可审计的维护任务。
- 不自动删除 `references/opencode`、其 `.git` 或 `node_modules`。
- 不自动停止、kill、pkill 或替换当前运行中的 8022、4520、4521 或其他服务。
- 不借本次退役重写全部 provider 架构。
- 不新增浏览器/UI 自动化；除非用户另行明确授权，验证以类型检查、单元测试、构建检查和只读 HTTP/进程检查为主。
- 不删除历史 CHANGELOG、研究报告或迁移文档中的 OpenCode 记录；历史文档应保留事实并标记“已退役”。

## 4. 已知现场基线

2026-08-18 只读审计结果：

- 仓库约 11 GB；`references/opencode` 约 5.9 GB，其中 `node_modules` 约 5.4 GB。
- `~/.local/share/opencode` 约 8.6 GB，`opencode.db` 约 8.3 GB。
- 数据库有 803 个 session、35 个 directory、434 个可见 root session。
- 数据库存在 5 个 `yep_*` helper indexes。
- 4520 bridge 正在运行，并启动了 4521 `opencode serve`。
- bridge 状态中有 248 个 session，审计时全部 idle，active=0、pending=0。
- 主服务和 4521 进程都持有 `opencode.db` 文件句柄。
- OpenCode session stats 查询在当前日志中出现过约 1.1 秒耗时；历史全量 scope 校验出现过超过 150 秒的队列等待。

这些数字只用于前后对比，实施时要重新采样，不能假设运行态没有变化。

## 5. 安全边界与权限

### 5.1 开发阶段允许

- 编辑仓库文件；
- 删除已确认只属于 OpenCode 的源码、测试和 bundle 资源；
- 运行聚焦测试、`pnpm lint`、`pnpm typecheck`、`pnpm test` 和必要构建；
- 对 4520、8022、数据库文件、日志和进程做只读检查；
- 新增一个默认 dry-run 的退役辅助脚本。

### 5.2 必须等待用户明确授权

- 部署或重启 8022；
- 停止、卸载或 kill 4520/4521；
- 修改或移除 LaunchAgent plist；
- 从 `~/.config/opencode/plugin/` 移除 forwarder plugin；
- 删除 `references/opencode`、`node_modules` 或其他本地大文件；
- 修改 `opencode.db`、删除索引或执行 `VACUUM`。

开发 goal 不得因为运行中的旧服务仍占用 4520 就标记 blocked；它应完成“代码已退役并可切换”的目标，然后把运行态切换列为需要单独授权的后续步骤。

## 6. 目标架构

退役后 provider 架构中不存在 OpenCode live adapter：

```text
Provider registry
  ├─ claude / claude-ollama
  ├─ codex / codex-oss
  ├─ gemini / gemini-acp
  ├─ pi
  ├─ kimi
  └─ zcode

Main server
  ├─ 不创建 OpenCode scanner / reader
  ├─ 不连接 4520
  ├─ 不启动 OpenCode DB monitor
  └─ 不修改 opencode.db

Deployment
  ├─ 不构建 OpenCode plugin
  ├─ 不安装 OpenCode LaunchAgent
  └─ 不保活 4520/4521
```

旧数据兼容只存在于持久化边界：解析到旧 `opencode` 标识时忽略或返回明确的 `provider_retired`，不能重新激活 runtime。

## 7. 分阶段实施

### 阶段 0：建立回归基线和退役契约

目标：在改代码前固定“哪些行为必须保留”和“哪些 OpenCode 路径必须消失”。

任务：

1. 记录工作树状态，保护用户已有改动。
2. 重新确认 OpenCode 直接和间接引用：

   ```bash
   rg -n -S 'opencode|OpenCode|OPENCODE' packages scripts package.json CHANGELOG.md AGENTS.md
   ```

3. 建立剩余 provider 的聚焦测试清单，至少覆盖：
   - provider registry；
   - ZCode scanner/reader/monitor；
   - Pi provider/model/gateway；
   - session provider resolution；
   - project/global/search/recents/inbox 路由；
   - bundle manifest 与 LaunchAgent 脚本测试（若已有）。
4. 为退役行为补契约测试：
   - provider 列表不返回 OpenCode；
   - `provider=opencode` 创建/恢复返回 `410 provider_retired`（过渡期）；
   - 旧 metadata 中的 `opencode` 不导致初始化失败；
   - ProjectScanner 不触发 OpenCode scanner；
   - main server startup 不启动 OpenCode bridge client/monitor/index ensure。
5. 在 `CHANGELOG.md` 的 `[Unreleased]` 记录即将进入正式产物的退役变更；此时不提升版本。

完成门槛：基线测试可运行，退役契约已有失败测试或明确断言，且没有修改运行中服务。

### 阶段 1：抽离被其他 Provider 复用的通用能力

目标：让后续删除 `opencode-*` 文件不会破坏 Pi 和 ZCode。此阶段应尽量做到纯重构、行为不变。

#### 1.1 通用 SQLite 查询层

建议结构：

```text
packages/server/src/sqlite/
  query-worker.ts
  query.ts
  session-change-sql.ts
```

任务：

1. 把 `opencode-db-worker.ts` 中与具体 provider 无关的 worker pool、timeout、budget、statement batch 能力迁到中性模块。
2. 把类型改为中性命名，例如：
   - `OpenCodeDbStatement` -> `SqliteStatement`
   - `OpenCodeDbFailureReason` -> `SqliteFailureReason`
   - `runOpenCodeDbStatements` -> `runSqliteStatements`
   - 日志事件 `opencode_db_*` -> `sqlite_db_*`，保留调用方 label 以区分 provider。
3. 把 `OPENCODE_DB_PATH` 和 OpenCode 专属 writable helper 留在薄适配层，直到阶段 2 删除。
4. 先迁移 ZCode scanner/reader 到通用模块。
5. 把 `SESSION_DIGEST_SQL` 移到中性 `session-change-sql.ts`；如果 OpenCode 与 ZCode schema 已分叉，则为两者分别定义 SQL，禁止 ZCode 再 import OpenCode scanner。
6. 为 worker timeout、inline fallback、read-only query、ZCode label 增加/迁移测试。

#### 1.2 通用 LLM gateway 配置

任务：

1. 把 Pi 使用的 `resolveOpenCodeOpenAICompatibleBaseURL` 移到 `llm-gateways/`，改成中性名字。
2. `OhMyRouterBenchmarkService` 改为依赖中性 gateway 类型。
3. OpenCode 专属的 config overlay、managed provider JSON、OpenCode process env 继续留在 OpenCode 模块，等待阶段 2 删除。
4. 对历史 `OPENCODE_LLM_*` 环境变量做决策：
   - 如果 Pi/共享 gateway 仍需要兼容，增加中性变量并保留旧变量的只读 deprecated alias；
   - 不允许因为删除 OpenCode provider 而悄悄破坏 Pi 的 gateway 模型发现。

#### 1.3 通用 edit-fork/list folding

任务：

1. 将 `collapseEditForkFamilies` 移出 `opencode-branch.ts` 到 provider-neutral 模块。
2. 客户端 `opencode-fork` 若实际是通用 edit-fork submission，重命名为 `edit-fork` 并迁移测试。
3. OpenCode 特有的 metadata 解析、branch view、diagnostic 留在旧模块，阶段 3 删除。

完成门槛：

- ZCode 与 Pi 不再 import `opencode-*` 模块；
- 保留 provider 的聚焦测试通过；
- 此阶段不改变 provider 列表或运行时行为。

建议提交：`refactor(server): extract shared sqlite and gateway helpers`

### 阶段 2：断开 OpenCode live runtime 与扫描路径

目标：拿到主要性能收益。完成后，新构建的 Yep 即使环境里仍有 OpenCode 数据，也不会访问它或连接 4520。

#### 2.1 Provider 与创建/恢复入口

1. 从 `ProviderName` 的 live provider 集合、provider registry 和 `getAllProviders()` 移除 `opencodeProvider`。
2. 删除或隔离 `packages/server/src/sdk/providers/opencode.ts`。
3. API 收到显式 `provider=opencode` 时，在一个过渡发布周期内返回：

   ```json
   { "error": "OpenCode provider has been retired", "code": "provider_retired" }
   ```

   HTTP 状态建议为 410；后续阶段再删除兼容分支。
4. `ENABLED_PROVIDERS` 改成真正的运行时 allowlist，而不是只过滤 `/api/providers` 的展示结果；任何未启用 provider 都不得创建 scanner、watcher、bridge 或 monitor。
5. `/api/providers/:name` 同样必须遵守 allowlist/retired 状态。

#### 2.2 Project/session 枚举

从以下位置移除 OpenCode scanner、reader、catalog 和 source：

- `projects/scanner.ts`
- `routes/provider-catalog.ts`
- `sessions/provider-resolution.ts`
- `sessions/session-locator.ts`
- `watcher/FocusedSessionWatchManager.ts`
- `routes/projects.ts`
- `routes/sessions.ts`
- `routes/global-sessions.ts`
- `routes/search.ts`
- `routes/recents.ts`
- `routes/inbox.ts`
- 相关 service deps/interface

要求：

- 不再生成 `hasOpenCodeSessions`；
- 不再生成 `opencodePaths`；
- 不再创建 `opencode::<db>::<projectPath>` index scope；
- focused watch 不再把 OpenCode 放进 fallback provider candidates；
- 找不到旧 OpenCode session 时应返回普通 not-found/retired 结果，不能做最后一次 DB fallback。

#### 2.3 Main server 后台任务

从 `packages/server/src/index.ts` 和 `app.ts` 移除：

- `OpenCodeBridgeHttpClient` 构造、start、shutdown；
- `OpenCodeSessionChangeMonitor`；
- `ensureOpenCodeDbIndexes`；
- OpenCode invalid-title startup backfill；
- OpenCode ownership resolver；
- `/api/opencode-bridge` live routes；
- OpenCode focused scanner；
- OpenCode DB worker shutdown（通用 worker 继续由 SQLite 层管理）。

过渡期可保留一个不连接任何 sidecar 的轻量 `410 Gone` route，明确告诉旧客户端渠道已退役；下一个正式版本删除该 route。

#### 2.4 旧 Yep 状态兼容

1. 区分 live provider type 与 persisted legacy provider type。
2. metadata、recents、notifications、indexes 读到 `opencode` 时：
   - 不抛出全局解析错误；
   - 不把记录加入 live project/session 列表；
   - 不自动删除记录；
   - 可记录一次低频 diagnostic。
3. 已存在的 `opencodeConfig` 字段只做容错读取并忽略，不能重新写入。

完成门槛：

- 单元测试证明启动和所有常规 API 不需要 `opencode.db` 存在；
- 代码路径上不再有 4520 HTTP client；
- `pnpm typecheck` 和 server 聚焦测试通过；
- 尚未部署或停止服务。

建议提交：`feat(providers): retire opencode runtime channel`

### 阶段 3：删除客户端与 shared 产品表面

目标：用户界面、API 类型和 shared schema 不再宣称支持 OpenCode。

#### 3.1 客户端

重点清理：

- `providers/implementations/OpenCodeProvider.ts`
- provider registry 与 badge/status 映射
- `NewSessionForm.tsx` 的 OpenCode config/limits/capabilities/advanced JSON
- permission mode hooks 与 OpenCode 特例
- `OpenCodeTaskRenderer.tsx`
- `openCodeSubagents.ts` 及 preprocess 特例
- session branching 的 OpenCode 专属分支
- Development Settings 中 OpenCode/4520/bridge 展示
- CSS 中 `new-session-opencode-*` 和 renderer 样式
- API client 中 OpenCode bridge/config 类型

新增或修改界面文案时，必须同步更新 `en` 与 `zh-CN`；不新增其他 locale。

#### 3.2 Shared

清理：

- `packages/shared/src/opencode-schema/`
- `UnifiedSession` 的 OpenCode variant
- live `ProviderName` 中的 `opencode`
- `SessionLocation` 的 live `opencode-db` 来源
- OpenCode SSE/session exports
- `OpenCodeSessionConfig`、request protocol、limits 等类型

若其中有 Pi/共享 gateway 仍在使用的能力，先改为 provider-neutral 类型再删除 OpenCode 名称。不得通过保留整套 OpenCode schema 来解决一个通用字段的复用问题。

#### 3.3 Normalization 与 archive

1. 删除 OpenCode message/part/tool/error/attachment normalization 分支。
2. 删除 OpenCode archive/restore SQL 写入。
3. 保证未知历史 provider 不让统一 renderer 崩溃；客户端可显示 generic unavailable 状态，但不提供恢复按钮。

完成门槛：

- UI 与 shared live API 无 OpenCode provider；
- `en`、`zh-CN` 同步；
- client/shared/server typecheck 通过；
- 相关组件与 normalization 测试通过。

建议提交：`refactor(client): remove opencode product surface`

### 阶段 4：废弃 4520 bridge 的构建、安装和部署渠道

目标：新 bundle 和部署工具不再生产或维护 4520。

#### 4.1 CLI/config/routes

删除：

- `--opencode-bridge-only`
- `runOpenCodeBridgeOnly()`
- `opencodeBridgeHost/Port/ControlUrl/ServerUrl/StartPort`
- `YEP_OPENCODE_BRIDGE_*` 与 `OPENCODE_BRIDGE_*` runtime config
- deploy API 的 `opencodeBridge` target 与 `--restart-opencode-bridge`

对于仍被 Pi/共享 LLM gateway 使用的 `OPENCODE_LLM_*`，按阶段 1 的兼容决策迁移，不能与 4520 bridge 变量混删。

#### 4.2 Bundle/package

删除：

- bundle 中的 `resources/opencode-plugin/yep-bridge.ts`
- `scripts/install-opencode-yep-plugin.sh` 的安装 bin
- `yepanywhere-opencode-plugin` package bin
- 构建阶段的 OpenCode plugin copy/校验

#### 4.3 LaunchAgent 与 redeploy

修改：

- `install-launchagents.sh` 默认只安装仍受支持的 server/bridge；
- 删除 `--opencode-bridge-only` 安装模式；
- 不再写 OpenCode bridge plist；
- 不再同步 global plugin；
- `redeploy-server.sh` 不再探测、保活、刷新、重启或等待 4520/4521；
- 常规部署不应因为旧 4520 正在运行而失败或要求 `--restart-opencode-bridge`。

保留一个显式的退役工具，例如：

```text
scripts/retire-opencode-integration.sh
  --dry-run   默认，只报告
  --apply     需要用户明确授权后运行
```

dry-run 应报告：

- 4520 status、active/pending 数量；
- 4520/4521 listener 与 PID；
- OpenCode LaunchAgent plist；
- forwarder plugin 安装路径；
- Yep helper index 名称；
- `references/opencode` 体积。

apply 的安全要求：

- active 或 pending 非零时拒绝执行；
- 先移除/停用 forwarder plugin，再卸载 sidecar；
- 优先正常终止，不默认 SIGKILL；
- 不修改 `opencode.db`；
- 不删除 reference repo；
- 每个动作输出可审计结果；
- 脚本本身不得在 goal 中未经用户授权运行 `--apply`。

完成门槛：

- `pnpm build:bundle` 产物中没有 OpenCode plugin、installer、bin 或 bridge entrypoint；
- 安装脚本不会新建 OpenCode plist；
- redeploy 脚本没有 4520 restart/preserve 逻辑；
- dry-run 工具测试通过。

建议提交：`chore(deploy): remove opencode bridge packaging`

### 阶段 5：删除 OpenCode 专属源码、测试和现行文档

可删除的主要源码范围：

- `packages/server/src/opencode-bridge/`
- `packages/server/src/opencode-lifecycle/`
- `packages/server/src/opencode/`
- `packages/server/src/sdk/providers/opencode.ts`
- `packages/server/src/projects/opencode-scanner.ts`
- `packages/server/src/sessions/opencode-reader.ts`
- `packages/server/src/sessions/opencode-db-indexes.ts`
- `packages/server/src/services/OpenCodeSessionChangeMonitor.ts`
- `packages/server/src/routes/opencode-bridge.ts`
- `packages/server/resources/opencode-plugin/`
- `packages/shared/src/opencode-schema/`
- OpenCode 专属 client 文件
- 对应 mocks、unit、E2E、plugin 和 bridge tests

删除前必须再次确认没有 Pi/ZCode/共享服务 import。

文档处理：

1. 更新 `AGENTS.md` 的 provider 列表、环境变量和参考源码说明。
2. 更新 README、provider capability、项目概览、部署和 bridge 文档。
3. 历史研究/任务文档保留，但在顶部标记“OpenCode 渠道已退役，仅作历史参考”。
4. 更新 `CHANGELOG.md [Unreleased]`，明确：
   - OpenCode provider/bridge/UI 已移除；
   - Yep 不删除 OpenCode 数据；
   - 操作员需显式卸载旧 LaunchAgent/plugin；
   - Pi/ZCode 的共享 helper 已迁为中性模块。

完成门槛：

- 生产源码、现行配置和构建脚本中没有 OpenCode runtime；
- `rg` 剩余命中仅允许出现在 CHANGELOG、历史文档、退役计划和显式 retirement helper；
- 全量 lint/typecheck/test 通过。

建议提交：`test(docs): finalize opencode retirement`

### 阶段 6：经授权的运行态切换

此阶段不是开发 goal 的默认授权范围。

#### 6.1 切换前检查

1. 重新读取 4520 status/session views；确认 active=0、pending=0。
2. 确认没有用户正在使用 OpenCode bridge approval。
3. 记录 8022、4520、4521 PID、端口、启动时间和日志位置。
4. 记录 plugin/plist 文件状态；不读取或输出密钥。
5. 确认新构建已通过前述验证。

#### 6.2 执行顺序

在用户明确授权部署、重启和卸载后：

1. 部署不含 OpenCode runtime 的新 server bundle；
2. 重启 8022；
3. 验证 8022 正常，再卸载 4520 LaunchAgent；
4. 确认其 managed 4521 child 正常退出；
5. 移除/停用 global forwarder plugin；
6. 不删除 OpenCode DB 和数据；
7. 如有残留进程，先报告，再单独请求强制终止授权。

#### 6.3 只读验收

```bash
lsof -nP -iTCP:4520 -sTCP:LISTEN
lsof -nP -iTCP:4521 -sTCP:LISTEN
lsof -p <8022-pid> | rg 'opencode\.db'
curl -fsS http://127.0.0.1:8022/yep/api/providers
```

期望：

- 4520/4521 无 listener；
- 8022 不持有 `opencode.db`；
- providers 响应无 OpenCode；
- 项目/session/search/notification 主路径正常；
- 日志无 `opencode::` scope、OpenCode monitor 或 bridge poll。

### 阶段 7：观察期与兼容壳删除

建议至少观察一个正式发布周期：

1. 对比退役前后的空闲 CPU、内存、项目列表 TTFB、session list TTFB 和日志量。
2. 确认旧 metadata/indexes 不触发异常。
3. 确认 Pi/ZCode gateway、session scanning 与 title generation 无回归。
4. 下一个版本删除过渡的 410 route、`provider_retired` 特例和不再需要的 deprecated env alias。
5. 本地空间清理另开任务：可选择移除 `references/opencode/node_modules` 或整个 reference clone，但不得与产品代码退役绑在同一个不可回滚步骤里。

## 8. 验证矩阵

### 8.1 每阶段聚焦检查

- 阶段 1：SQLite worker、ZCode scanner/reader、Pi provider/gateway tests。
- 阶段 2：provider registry、ProjectScanner、provider resolution、session locator、projects/sessions/global/search/recents/inbox tests。
- 阶段 3：client provider registry、NewSessionForm、branching、renderer、normalization、shared schemas。
- 阶段 4：CLI/config、bundle manifest、LaunchAgent/redeploy script tests、retirement dry-run。
- 阶段 5：全量静态检查和测试。

### 8.2 必跑命令

按改动范围逐步运行，最终至少运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build:bundle
```

只有确实需要 E2E 覆盖且用户明确授权浏览器/UI 自动化时才运行相关 UI/E2E 流程。

### 8.3 静态残留检查

最终执行：

```bash
rg -n -S 'opencode|OpenCode|OPENCODE|4520|4521' \
  packages scripts package.json pnpm-workspace.yaml AGENTS.md README.md docs
```

逐项审核剩余命中，不能机械要求零命中。允许的类别仅限：

- CHANGELOG 历史；
- 已标记历史参考的文档；
- 本退役计划；
- 明确用于清理旧安装的 retirement helper；
- 短期 persisted-data compatibility shim。

## 9. 性能验收

在不使用浏览器自动化的前提下，记录退役前后：

- 8022 空闲 CPU/内存；
- 4520/4521 是否存在；
- 8022 的 open files 中是否存在 `opencode.db`；
- `/api/projects`、global sessions 和 project sessions 的多次 curl TTFB；
- `SessionIndexService` 每分钟 full validation 次数；
- `opencode_db_*`/`opencode::`/bridge poll 日志计数；
- server log 增长速度。

性能目标不是承诺固定百分比，而是证明 OpenCode 路径的资源消耗已经归零：无 bridge、无 DB handle、无 OpenCode scope、无 monitor、无 plugin sync。

## 10. 回滚策略

1. 阶段 1 是中性重构，可独立回滚。
2. 阶段 2 到阶段 5 应按逻辑提交拆分，禁止一个巨型提交混合 rename、删除和行为变更。
3. 在运行态切换前保留上一版 bundle/commit，可回滚 8022。
4. 不删除 `opencode.db`，因此产品代码回滚后仍可恢复读取。
5. 旧 plugin/plist 如需回滚，应从已知 bundle 重新显式安装，不能依赖退役脚本自动恢复。
6. 任何运行态回滚同样需要用户授权，不得由开发 goal 自动执行。

## 11. Goal 完成定义

开发 goal 仅在以下条件全部满足时完成：

- 阶段 1 至阶段 5 的代码、测试和文档工作完成；
- `CHANGELOG.md [Unreleased]` 已更新；
- Pi/ZCode 的共享能力已中性化且测试通过；
- OpenCode provider、scanner、reader、monitor、bridge、plugin、UI、bundle 和部署入口已从新构建中移除；
- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build:bundle` 通过，或失败项被证明与本任务前置 dirty 状态无关并清晰记录；
- 静态残留已逐项审核；
- 未未经授权部署、重启、停止服务、卸载 LaunchAgent/plugin 或删除用户数据；
- 最终报告明确列出运行态切换所需的授权动作和只读验收命令。

运行态 4520/4521 仍存在不阻止开发 goal 完成，因为它们属于阶段 6 的显式授权操作；但新代码不得再构建、安装、启动或连接它们。

## 12. 建议执行原则

- 每个阶段先读相关实现和测试，再编辑；不要依靠字符串批量删除。
- 每次重构后先跑聚焦测试，再进入下一阶段。
- 发现 Pi/ZCode/共享服务仍依赖 OpenCode 命名模块时，优先抽出通用能力，不复制整套实现。
- 保留工作树中与本任务无关的改动，不回滚 `context.md` 或其他用户文件。
- 不为了追求 `rg` 零命中而破坏历史记录或兼容解析。
- 如果某一阶段出现真实阻塞，记录具体文件、失败命令、已尝试方案；不要因为任务较大就提前停止。

## 13. 新 Codex session 的 Goal 启动提示词

在同一仓库的新 Codex session 中粘贴下面整段。它要求 Codex 创建一个不设 token budget 的开发 goal；完整细节以本文件为事实来源，避免把超过 goal objective 长度限制的全部计划重复塞进 objective。

```text
请立即创建一个 goal（不要设置 token_budget），创建后马上开始执行。Goal objective 如下：

在 /Users/yueyuan/Desktop/work/before_work/yepanywhere 中，严格按照 docs/project/2026-08-18-opencode-provider-and-4520-retirement-plan.md 完成 OpenCode provider 与 4520 bridge 的代码退役。目标范围是计划中的阶段 0 至阶段 5：建立契约基线；先把被 Pi、ZCode 和共享 gateway 复用的 SQLite、gateway、edit-fork 能力迁到 provider-neutral 模块；随后断开 OpenCode provider、session scanner/reader/index/monitor、4520 bridge client 和所有 API/session 枚举路径；删除客户端/shared 产品表面；移除 4520/4521 的 CLI、bundle、plugin、LaunchAgent 安装与 redeploy 渠道；清理专属源码、测试和现行文档并更新 CHANGELOG.md [Unreleased]。

完成条件：新构建不再注册、展示、创建、恢复、扫描或连接 OpenCode；普通 server 启动与 API 不访问 opencode.db、不创建 yep_* OpenCode 索引、不连接 4520；bundle 不包含 OpenCode bridge/plugin/installer/bin；Pi 和 ZCode 不再 import opencode 命名模块且相关行为无回归；旧 metadata/recents/indexes 中的 opencode 标识能被安全忽略；pnpm lint、pnpm typecheck、pnpm test、pnpm build:bundle 通过；所有 opencode/OpenCode/OPENCODE/4520/4521 残留命中按计划逐项审核；最终给出变更摘要、验证证据、剩余兼容壳和运行态切换清单。

执行约束：
1. 开始前完整阅读仓库根 AGENTS.md 和上述计划文件，检查 git status，保留并绕开用户已有改动，尤其不要修改或回滚无关的 context.md。
2. 按阶段顺序工作并维护可见计划；每个阶段先阅读相关实现/测试，再用 apply_patch 编辑，先跑聚焦测试再进入下一阶段。不要用机械字符串替换，也不要做一个不可审查的巨型改动。
3. 阶段 1 必须先完成中性化解耦；不能直接删除仍被 Pi/ZCode 使用的 opencode-db、SESSION_DIGEST_SQL、gateway-config 或 collapseEditForkFamilies。
4. live ProviderName 与 persisted legacy provider 要分开处理；退役 OpenCode 不能导致旧状态文件整体解析失败，也不能自动删除用户的 OpenCode 数据。
5. 界面文案变更同步维护 en 与 zh-CN，不新增其他 locale。
6. 本 goal 不授权部署、重启/停止/kill 任何服务，不授权卸载 LaunchAgent/plugin，不授权删除 references/opencode 或 node_modules，不授权修改 opencode.db、DROP INDEX 或 VACUUM；不要运行 retirement helper 的 --apply。允许对 8022、4520、4521、日志和文件句柄做只读检查。
7. 不要因为运行中的旧 4520/4521 仍存在而把开发 goal 标记 blocked；它们属于计划阶段 6 的另行授权运维切换。代码阶段完成后应正常完成 goal，并在最终报告中明确请求那一步的授权。
8. 不要 commit、push、deploy 或发布，除非我在该新 session 中另行明确要求。
9. 只有阶段 0 至 5 的代码、测试、文档、CHANGELOG 和构建验收全部完成，且无未解释的回归，才将 goal 标记 complete；任务较大、上下文压缩或接近单轮结束都不是停止理由。
```
