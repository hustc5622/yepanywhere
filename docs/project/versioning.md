# 版本治理方案（Yep Anywhere fork 发行线）

状态：**阶段 1–5 已实施**（见 §12 进度）。决策已定：§2.3 取 A（不发 npm），§2.4 取 A（基线 `0.5.0`）。阶段 6–8 尚未实施。

> 注意：`releaseChannel` 门控（阶段 4）要**重新部署**后才在运行中的服务上生效。线上包 `0.4.29-a08854d03b6c-*` 是改造前构建的，仍会上报 `updateAvailable: true`。

已确定的方向：把 `origin`（`hustc5622/yepanywhere`）视为**独立发行线**，通过独立 tag 命名空间和 release channel 标识与 upstream（`kzahel/yepanywhere`）解耦。

---

## 1. 现状核准

以下数据为撰写本文时实测结果，是方案的事实基础。

| 项目 | 实测值 | 来源 |
| ---- | ---- | ---- |
| 根产品版本 | `0.4.29` | `package.json` |
| CHANGELOG 最新章节 | `0.4.28`，`[Unreleased]` 为空 | `CHANGELOG.md:8` |
| 仓库中存在的最新 `v*` tag | `v0.7.0`（来自 upstream，**非** HEAD 祖先） | `git tag --list 'v*'` |
| HEAD 可达的最新 `v*` tag | `v0.4.28`（`git describe` → `v0.4.28-278-ga08854d03`） | `git describe --tags` |
| upstream/main 版本 | `0.7.0` | `git show upstream/main:package.json` |
| 分叉规模 | upstream 领先 2328，本地领先 274 | `git rev-list --left-right --count upstream/main...HEAD` |
| bundle 版本来源 | `NPM_VERSION` 环境变量，缺省回退硬编码 | `scripts/build-bundle.ts:60` |
| 本地部署版本来源 | 根 `package.json.version` | `scripts/redeploy-server.sh:110` |
| CI 发布版本来源 | `v*.*.*` tag | `.github/workflows/publish.yml:41` |
| 部署一致性校验 | 只比对 `buildId` | `scripts/verify-deploy.mjs:103,115` |
| 更新检查 | 裸版本号请求公共更新服务 | `packages/server/src/routes/version.ts:52,87` |

关键结论：

1. `v0.5.0`、`v0.5.1`、`v0.5.2`、`v0.6.0`、`v0.6.1`、`v0.6.2`、`v0.7.0` 已被 upstream 占用，且会继续增长。本地发行线不能再使用裸 `v*` 命名空间。注意这些 tag 存在于本地仓库但**不在 HEAD 的祖先链上**，所以 `git describe` 解析到的是 `v0.4.28`——这不改变结论，dev 模式上报的 `0.4.28` 同样会被公共更新服务判定为落后。
2. `isNewerSemver` 只解析 `^(\d+)\.(\d+)\.(\d+)`（`packages/server/src/utils/semver.ts`），预发布/构建后缀在比较前被丢弃。因此 `0.5.0-local.1` 这类后缀**无法**阻止 upstream `0.7.0` 触发更新提示，必须用 channel 门控。
3. `verify-deploy.mjs` 只校验 `buildId`，不校验版本是否提升，所以同一版本可以反复正式部署。
4. 直接 `pnpm build:bundle`（不带 `NPM_VERSION`）会产出硬编码回退版本的包，这是一个静默错误来源。
5. dev 模式下 `getCurrentVersion()` 读到 `packages/server/package.json` 的占位值 `0.0.1`，回退到 `git describe`，因此**开发态上报 `0.4.28-278-g…` 而非根版本 `0.4.29`**。这是版本口径不一致的第二个来源，阶段 4 一并处理。


---

## 2. 发行线与 channel 模型

### 2.1 channel 定义

引入 `releaseChannel` 概念，取值：

| channel | 含义 | 版本来源 | tag |
| ---- | ---- | ---- | ---- |
| `upstream` | upstream 公共发行线 | upstream `package.json` | `v*` |
| `fork` | 本仓库 origin 发行线 | 本仓库 `package.json` | `ya-v*` |
| `dev` | 本地开发/临时验证 | git describe 或 workspace 占位版本 | 无 |

channel 由构建期决定并写入 build metadata，不在运行期猜测。

### 2.2 tag 命名

沿用仓库已有的前缀风格（`site-v*`、`bridge-v*`）：

| 产品面 | tag 前缀 | 现状 |
| ---- | ---- | ---- |
| 主产品（server + web client + bundle + mobile shell） | `ya-v*` | **新增** |
| Website | `site-v*` | 已存在（`scripts/release-website.sh:23`） |
| Device Bridge | `bridge-v*` | 已存在（`scripts/release-bridge.sh:23`） |
| Desktop | `desktop-v*` | 待确认是否已有发布流程 |

`v*` 命名空间保留给 upstream，本仓库不再创建。

### 2.3 npm 包名风险（**已决策：A**）

`publish.yml` 目前由 `v*.*.*` 触发，发布到 npm 包名 `yepanywhere`。该包名属于 upstream 发行线。

fork 发行线有三种选择：

- **A（已采纳）**：fork 只做 GitHub Release + 本地部署，不发 npm。`publish.yml` 保持只响应 `v*.*.*`，本仓库不推这类 tag，等价于禁用。新增独立的 `ya-v*` workflow，只跑 lint/typecheck/test + 构建 + GitHub Release。
- **B**：fork 发布到独立 npm 包名（如 `@hustc5622/yepanywhere`）。需要额外维护包名与安装文档。
- **C**：完全不用 CI 发布，只靠 `scripts/deploy.sh` 本地部署。tag 仅作为版本标记。

按 A 执行。`ya-v*` workflow 属阶段 7，尚未实施；在此之前 fork 的发布动作是「打 tag + 本地部署」。

### 2.4 版本号基线（**已决策：A → `0.5.0`**）

fork 与 upstream 的版本号会在数字上重叠（例如两条线都可能出现 `0.8.0`）。有 channel 标识后这只是可读性问题，但仍需选一个起点：

- **A（已采纳）**：从 `0.5.0` 起继续独立编号。理由：当前 `0.4.29` 之后累积了 256 个未定版提交并包含多项新功能，patch 号低估了变更规模；`ya-v0.5.0` 与 upstream 的 `v0.5.0` 在 git 中不冲突。代价：`/api/version` 里 `0.5.0` 与 upstream 的 `0.5.0` 数字同名，需靠 channel 区分。
- **B**：跳到 upstream 尚未到达的号段（如 `0.10.0`）以降低歧义。代价：仍会被 upstream 追上，且数字含义变得随意。
- **C**：fork 独立使用 `1.x`。代价：`1.0.0` 在 SemVer 语义中表示对外契约稳定，与现状不符。

按 A 执行：首次 `pnpm version:bump minor` 会把 `0.4.29` 推到 `0.5.0`，随后打 `ya-v0.5.0`。About 页面把版本展示为 `0.5.0 (fork)`（属阶段 8）。


---

## 3. “更新”的定义

不按 commit 提升 SemVer。定义如下：

> 每一次包含新代码或新行为的正式部署、安装包交付或公开发布，都必须使用一个高于上一次正式部署的新版本号。

**需要**提升产品版本：

- 通过 `scripts/deploy.sh` / `redeploy-server.sh` 做正式部署，且 bundle 内容相对上一次正式部署有变化。
- 交付新的 APK。
- 创建 `ya-v*` tag 或 GitHub Release。

**不需要**提升产品版本：

- 重启相同 bundle（`deploy.sh --restart-only`）。
- 重新安装完全相同的构建。
- `pnpm dev`、`dev:8022`、staging、hot reload 等本地验证。
- 仅构建时间变化、代码未变。

分工：正式更新靠**产品版本**区分，开发验证靠 **buildId** 区分。二者不互相替代。

---

## 4. SemVer 规模规则（0.x 阶段）

| 类型 | 示例 | 版本变化 |
| ---- | ---- | ---- |
| Patch | Bug 修复、provider 兼容性修复、性能优化、日志完善、依赖安全更新 | `0.5.0 → 0.5.1` |
| Minor | 新 provider、新页面、新工作流、新协议能力、明显的功能集合 | `0.5.1 → 0.6.0` |
| Breaking Minor | 0.x 阶段的数据/API/配置不兼容调整，必须附迁移说明 | `0.5.x → 0.6.0` |
| Major | 产品进入稳定契约，或 1.x 之后的不兼容变化 | `0.x → 1.0.0` |

判断顺序：先看是否破坏兼容（数据格式、API、配置、协议）→ 再看是否新增用户可见能力 → 否则 patch。

---

## 5. 产品面版本边界

不要求一次变更同时提升所有版本。

| 产品面 | 版本来源 | 是否跟随根版本 |
| ---- | ---- | ---- |
| Server | 根 `package.json` → `NPM_VERSION` | 是 |
| Web Client | 同上（build-info） | 是 |
| npm bundle | 同上 | 是 |
| Mobile Shell（Android versionName） | `packages/mobile/src-tauri/tauri.conf.json` 的 `version` 指向 `../../../package.json` | 是（已自动） |
| Website | `site-v*` + `site/CHANGELOG.md` | 否 |
| Device Bridge | `bridge-v*` | 否 |
| Desktop | `packages/desktop/package.json` + `src-tauri/Cargo.toml` + `tauri.conf.json`，当前均为 `0.1.0` | 否 |
| Workspace 子包（`@yep-anywhere/server` 等 `0.0.1`） | 占位值 | 否，永不作为产品版本 |
| `RESUME_PROTOCOL_VERSION`（当前 `2`，`packages/server/src/routes/version.ts:137`） | 兼容边界 | 否，仅在协议兼容性变化时提升 |

一次变更同时影响主服务与 Device Bridge 时，分别提升两条版本，并在 CHANGELOG 中写明兼容关系。

Desktop 版本分散在三处（package.json / Cargo.toml / tauri.conf.json），若后续要发布，应先统一为单一来源，本方案不覆盖。

---

## 6. 三个脚本的设计

**已实施**：`scripts/version.ts`（单文件，按子命令分派），根 `package.json` 已暴露：

```json
"version:status": "tsx scripts/version.ts status",
"version:bump": "tsx scripts/version.ts bump",
"version:check": "tsx scripts/version.ts check"
```

不引入 Changesets——它面向多包 npm 发布，与本仓库“单一根产品版本 + 多条独立 tag 线”的模型不匹配。

### 6.1 `version:status`

只读，输出：

- 根 `package.json.version`
- CHANGELOG 最新已定版章节 + `[Unreleased]` 是否为空
- 最近的 `ya-v*` tag，以及自该 tag 起的提交数
- 当前 HEAD short commit、工作树 dirty 状态
- 若本地服务在跑：`GET {base}/api/version` 的 `current` / `build.buildId` / `resumeProtocolVersion`
- 判定结论：`需要提升版本` / `可直接重启` / `版本与 CHANGELOG 漂移`

### 6.2 `version:bump <patch|minor|major>`

- 读取根版本，计算新版本。
- 拒绝执行的前提条件：`[Unreleased]` 为空（说明变更没有记录）。
- 写入根 `package.json.version`。
- 把 `## [Unreleased]` 定版为 `## [X.Y.Z] - YYYY-MM-DD`，并在其上重新插入空的 `## [Unreleased]`。
- **不**自动 `git commit`，**不**自动打 tag。人工检查后再提交。
- 输出下一步提示（`version:check` → commit → deploy → tag）。

可选参数：`--dry-run`。

### 6.3 `version:check`

退出码非 0 即失败。`--profile release`（默认）跑全部适用项，`--profile local` 只跑第 1、2、4 项，供 §7 的部署门禁调用。校验项：

1. 根版本是合法 SemVer。
2. CHANGELOG 最新已定版章节 == 根版本。
3. `[Unreleased]` 下没有遗留条目（仅 release profile）。
4. 根版本 > 上一个 `ya-v*` tag 的版本（无 tag 时视为通过）。
5. tag 模式（`--tag ya-vX.Y.Z`）：tag 版本 == 根版本。
6. 该版本对应的 `ya-v*` tag 尚不存在（防重复发布，仅 release profile）。
7. 构建产物模式（`--build-info <path>`）：`dist/npm-package/build-info.json` 的 `version` == 根版本。

   > 原方案还要求校验「不等于 `build-bundle.ts` 的硬编码回退值」。该回退已在阶段 2 删除——`build-bundle.ts` 现在在缺 `NPM_VERSION` 时读根 `package.json`，读不到就退出——所以这条子校验已无对象，不再实现。

8. 部署后模式（`--base-url`）：以子进程调用 `scripts/verify-deploy.mjs`，由它比对 `/api/version`、`/build-info.json` 与本地 `build-info.json` 的 `buildId`。不重复实现该逻辑。

~~已知的当前行为：在首次 `version:bump` 之前，第 2 项必然失败（根 `0.4.29` vs CHANGELOG `0.4.28`）。~~ 首次 bump 已执行，五项校验现已全部通过。

---

## 7. 正式部署门禁

在 `redeploy-server.sh` 构建 bundle 之前插入检查：

```
若本次会重建 bundle（非 --restart-only）：
  运行 version:check 的“本地部署”子集（第 1、2、4 项）
  读取当前运行版本 GET /api/version → current
  若 根版本 <= 运行版本 且 bundle 内容将发生变化：
      拒绝部署，提示 pnpm version:bump
```

豁免路径：

- `deploy.sh --restart-only`：不重建，跳过门禁。
- `deploy.sh --dev-server`、`pnpm dev`、`pnpm staging`：开发路径，跳过门禁，靠 buildId 区分。
- 新增 `--allow-version-reuse`：显式逃生舱，打印醒目警告后继续。用于回滚验证等场景。

“bundle 内容将发生变化”的判定：比较当前 HEAD commit + dirty 状态与上一次正式部署记录。需要在部署时落一份部署记录（如 `~/.yep-anywhere/last-deploy.json`，含 version / commit / buildId / 时间）。这是本方案唯一需要新增的持久化状态。

---

## 8. CHANGELOG 流程

开发期直接写入 `[Unreleased]`：

```markdown
## [Unreleased]

### Added
- 新增……

### Changed
- 调整……

### Fixed
- 修复 Codex MCP 在不同启动环境下的配置兼容问题。
```

`version:bump` 时自动转为：

```markdown
## [0.5.0] - 2026-08-06
```

分类沿用 Keep a Changelog：`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`。

条目写用户可感知的行为变化，不写实现细节和文件名。

---

## 9. AGENTS.md 拟新增规则

AGENTS.md 只放长期规则，不放逐版本内容。拟在「发布」小节新增：

> 凡会进入正式部署产物的功能、修复或兼容性变更，开发时必须更新 `CHANGELOG.md` 的 `[Unreleased]`；正式部署或发布前必须按 SemVer 提升根 `package.json` 版本，并确保版本号、CHANGELOG、release tag 与构建产物一致。本仓库是独立 fork 发行线，主产品 tag 使用 `ya-v*`，`v*` 保留给 upstream。开发和临时验证不需要提升版本，靠 `buildId` 区分。详见 `docs/project/versioning.md`。

同时把现有「发布」段落中的 `v*` 描述改为 `ya-v*`，避免与 upstream 命名空间混淆。

---

## 10. 更新检查的 channel 改造

问题：`version.ts` 把裸版本号发给 `https://updates.yepanywhere.com/version/{version}`，拿到 upstream 的 `0.7.0` 后判定有更新。fork 用户会被引导去安装 upstream 包。

改造方案（按实施成本排序）：

**第一步（必须，成本最低）——✅ 已实施**：build metadata 增加 `releaseChannel`。`version.ts` 在 channel 不为 `upstream` 时**完全跳过**公共更新服务，返回 `latest: null`、`updateAvailable: false`。这一步立即消除错误更新提示，且不需要自建更新服务。

**第二步（可选）**：`/api/version` 响应体新增顶层 `releaseChannel` 字段，客户端 `AboutSettings.tsx` 展示 `0.5.0 (fork)`，并把「检查更新」入口在 fork channel 下替换为指向 origin GitHub Release 的链接。

> 注：channel 已经通过 `build.releaseChannel` 出现在 `/api/version` 响应里（`VersionInfo.build` 是完整的 `RuntimeBuildInfo`），所以第二步只剩纯 UI 工作，不需要再改服务端契约。

**第三步（可选，仅在需要自动更新时）**：自建 fork 更新端点，请求时携带 channel，例如 `GET /version/{channel}/{version}`。

### 10.1 已实施的 channel 解析规则

`ReleaseChannel = "upstream" | "fork" | "dev"`，定义在 `packages/server/src/build-info.ts`。解析优先级：

| 情况 | 结果 | 理由 |
| ---- | ---- | ---- |
| bundle 的 `build-info.json` 带合法 `releaseChannel` | 用该值 | 构建期烘焙，运行期不猜 |
| bundle 存在但**无该字段**（改造前构建的包，含当前线上包） | `fork` | 这类包只可能来自本仓库；且默认 `fork` 会关闭更新检查，是安全的失败方向 |
| 无 bundle（dev 树） | `YEP_RELEASE_CHANNEL` 合法值，否则 `dev` | dev 树不是发行版；env 是显式逃生舱（测试用），不是推断 |
| `YEP_RELEASE_CHANNEL` 值非法 | 忽略，回退 `dev` | 打错的 channel 名不应被信任 |

`schemaVersion` **保持为 1**：`parseBundledBuildInfo` 会拒绝 `schemaVersion !== 1`，若改为 2，所有已部署的 bundle 都会被判为非法而回退到 dev 元数据。新字段是可选加字段，向后兼容。

`scripts/build-bundle.ts` 侧默认写入 `fork`，可用 `YEP_RELEASE_CHANNEL` 覆盖；值非法直接报错退出，避免打错字静默恢复 upstream 更新提示。

涉及文件（已改）：

- `scripts/build-bundle.ts`：写入 `releaseChannel` + 构建日志打印 channel
- `packages/server/src/build-info.ts`：`ReleaseChannel` 类型、`BuildInfo.releaseChannel`、解析与默认值
- `packages/server/src/routes/version.ts`：channel 不为 `upstream` 时跳过更新检查
- `packages/server/test/version.test.ts`：既有 6 个更新服务用例改为显式 `upstream` channel，另加 7 个门控用例

注意：不要试图用 `0.5.0-fork.1` 这类后缀解决，`isNewerSemver` 会忽略后缀。

---

## 11. 一次性收敛（实施第一步）

当前存在的漂移需要先收敛，否则新机制第一次运行就会失败：

1. ~~补齐 CHANGELOG~~ **已完成**：`v0.4.28`→HEAD 的 278 个提交已按主题汇总写入 `[Unreleased]`，并在章节顶部注明 `0.4.29` 是未正式定版的中间状态（因此不单独开 `## [0.4.29]` 章节）。
2. ~~执行首次 `pnpm version:bump minor`~~ **已完成**：`0.4.29` → `0.5.0`，`[Unreleased]` 定版为 `## [0.5.0] - 2026-08-06`，并补入 backfill 写成之后才落地的提交（release channel 门控、权限模式持久化、Codex MCP 启动修复、Anthropic 网关 schema 修复、mobile home 节点）。第 2 项 check 的漂移已消除。
3. ~~修掉 `build-bundle.ts` 的硬编码回退~~ **已完成**：缺 `NPM_VERSION` 时读根 `package.json`，读不到或格式非法则报错退出，不再静默产出 `0.4.8`。
4. ~~创建 `ya-v0.5.0` tag~~ **已完成**：annotated tag，指向 `719358fea`。已验证 `publish.yml` 的 `v*.*.*` 触发器不匹配 `ya-v*`，推送后未产生 npm 发布 run。

---

## 12. 实施顺序

| 阶段 | 内容 | 影响面 | 状态 |
| ---- | ---- | ---- | ---- |
| 0 | 确认 §2.3 npm 策略、§2.4 版本基线 | 决策 | ✅ A / `0.5.0` |
| 1 | 本文档落地 + AGENTS.md 规则 | 文档 | ✅ 已完成 |
| 2 | 补齐 CHANGELOG，修 `build-bundle.ts` 回退 | 低 | ✅ 已完成 |
| 3 | 实现 `scripts/version.ts` 三个子命令 | 低，新增文件 | ✅ 已完成 |
| 4 | `releaseChannel` 第一步（跳过 upstream 更新检查） | 中，触及 server/build | ✅ 已完成 |
| 5 | 首次 `version:bump minor` + `ya-v0.5.0` tag | 决策已定后执行 | ✅ 已完成 |
| 6 | `redeploy-server.sh` 部署门禁 + 部署记录 | 中，影响部署流程 | ⬜ 未开始 |
| 7 | 新增 `ya-v*` GitHub Release workflow | 低 | ⬜ 未开始 |
| 8 | 客户端 channel 展示（可选） | 低 | ⬜ 未开始 |

阶段 6 建议先以 warn-only 模式跑一段时间，确认没有误报后再改为硬失败。

阶段 4 优先于阶段 5：先关掉错误的 upstream 更新提示，再正式定版，避免 `0.5.0` 上线后立刻被 upstream 的 `0.7.0` 判定为「有更新」。

---

## 13. 风险

- **部署门禁误报**：dirty 工作树在开发机上是常态，若把 dirty 当作“内容变化”会频繁拦截。建议门禁只在正式部署路径生效，并保留 `--allow-version-reuse`。
- **npm 包名冲突**：若误推 `v*` tag，`publish.yml` 会尝试以 `yepanywhere` 名义发布。实施时应在 workflow 中增加仓库归属校验（`github.repository == 'kzahel/yepanywhere'`）作为兜底。
- **与 upstream 后续同步**：一旦 fork 独立编号，未来 merge upstream 时 `package.json.version` 会冲突。约定：版本号冲突一律以 fork 值为准，并在 merge 说明中记录同步到的 upstream 版本。
- **CHANGELOG 回填质量**：278 个提交的汇总条目必然粗糙。这是可接受的一次性代价，不要为此阻塞机制落地。
