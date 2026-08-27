# Kimi ACP 标题与工具渲染稳健性修复计划

> 状态：**已实施并通过本地验证；待用户授权后部署**
>
> 计划日期：2026-08-27
>
> 实施完成日期：2026-08-27
>
> Yep 源码基线：`7143a79348c9e446e62db16fa134adca1d0b61ab`
>
> 当前 8022 构建：`2026.8.5-7143a79348c9-20260826134736`
>
> 本机 Kimi CLI：`0.36.0`
>
> Kimi reference：已从 `4a93f70aa` 更新到上游 `7de7b18ee`，package 版本 `0.38.0`

## 1. 概述

本计划正式修复同一类 Kimi ACP 兼容性问题：provider 的原始数据可能包含隐藏宿主指令、多模态数组，或先发不完整工具快照再补齐参数；Yep 当前部分链路仍把这些数据当成完整字符串或完整工具输入，导致标题污染、工具结果丢失和前端渲染崩溃。

纳入本计划的三个已确认问题：

1. Kimi 自动标题被 Yep 注入的 `kimi-acp-single-question` reminder 污染；
2. `ReadMediaFile` 成功返回多模态 `ContentPart[]`，但客户端把数组降成空字符串，界面只显示 `""`；
3. Kimi `Write` lazy-create 的早期 `rawInput` 尚无路径或内容，`WriteRenderer` 直接调用字符串方法并触发全页 Error Boundary；Error Boundary 又把普通 `TypeError` 误报为版本不匹配。

总体原则：

- provider wire 是事实来源，先按 Kimi 原始契约建模，再投影到 Yep 的公共消息与渲染模型；
- streaming 工具输入和结果都按“可部分到达、可重复补齐、最终收敛”处理；
- 多模态结果不能静默丢失，也不能把 base64、`blobref` 或绝对路径无界输出到工具卡和日志；
- 单个工具 renderer 即使遇到未知快照，也不能拖垮整个会话页面；
- live stream 与刷新后的 persisted replay 必须得到等价的可见结果。

## 2. 已确认事实

### 2.1 标题污染

目标 session `session_ee199a6b-a72a-4832-8619-0c6168da9033` 的真实首条用户消息是“你好”，但 Kimi `state.json` 写入的非自定义标题为：

```text
<system-reminder> [yep-anywhere:kimi-acp-single-question] This ACP host ...
```

证据链：

- Yep 在每轮 Kimi internal prompt 前注入完整 reminder；public prompt 不包含它；
- Kimi 将 internal prompt 的开头压平并截断后写入 `state.json.title`；`isCustomTitle=false`；
- `KimiSessionReader.getSessionSummary()` 优先采用非 `New Session` 的 provider title；
- `getKimiPromptText()` 只会移除完整、原样、多行的 reminder，无法识别已经压平且截断的自动标题；
- 当前 8022 构建已经包含 reminder replay strip，因此问题不是旧部署，而是标题入口缺少单独的 provider-auto-title 判定；
- `SessionIndexService` 和 `SessionContentIndexService` 都会持久化 title，单改 reader 不足以保证已有错误标题立即消失。

### 2.2 `ReadMediaFile` 的真实输出

该 session 的两个 `ReadMediaFile` 结果都不是空值。原始 wire 形状为：

```text
[
  { type: "text", text: "<image path=\"...\">" },
  { type: "image_url", imageUrl: { url: "blobref:image/png;<sha256>" } },
  { type: "text", text: "</image>" }
]
```

Kimi 0.36.0 与最新 0.38.0 源码均确认：

- `ReadMediaFileTool` 的成功结果是 `string | ContentPart[]` 中的数组分支；
- 图片/视频结果由 opening tag、媒体 part、closing tag 三部分组成；
- session 落盘时，大型 data URL 会写入 `agents/<agent>/blobs/`，wire 中改存 `blobref`；
- ACP terminal `tool_call_update.content` 为通用客户端提供 JSON 字符串，同时 `rawOutput` 保留原始数组；
- Kimi TUI 有专用 `ReadMediaFile` renderer，只展示类型、路径、MIME、大小等摘要，避免输出 base64。

Yep 当前存在三处缺口：

1. `KimiToolResultEventSchema.result.output` 仍写死为 `z.string()`；
2. persisted normalization 在运行时把数组放进 `tool_result.content`，但公共类型和后续处理没有明确承认该形状；
3. `preprocessMessages.attachToolResult()` 对非字符串直接赋值 `""`，且工具 registry 没有 `ReadMediaFile` renderer，fallback 最终显示 `JSON.stringify("")`，即截图中的 `""`。

### 2.3 `Write` lazy-create 崩溃

Kimi ACP 可能先用 arguments delta lazy-create 工具，再通过后续 `tool_call_update` 补发完整 `rawInput`。Yep server 已明确按相同 tool id 重放更完整的 `tool_use`，客户端 preprocessing 也会合并该快照。

崩溃发生在中间态：

- 早期 `Write:10` 输入中 `file_path` 暂时为 `undefined`；
- `ToolCallRow` 在 pending 状态也会请求 collapsed preview；
- `WriteCollapsedPreview` 立即读取 `input.content` 和 `input.file_path`；
- `getFileName(undefined)` 最终执行 `undefined.split("/")`；
- 后续完整输入虽然到达，但顶层 Error Boundary 已进入错误态，不会因同一工具补齐输入而自动恢复；
- 当前持久化 transcript 已完整，刷新页面后可以正常渲染，证明 session 未损坏。

Error Boundary 的“可能版本不匹配”提示同样不可靠：它仅凭 `Cannot read properties of undefined`、`is not a function` 等通用异常文本推断版本问题，没有比较客户端 `__BUILD_ID__` 与 `/api/version.build.buildId`。本次前后端 buildId 完全一致，因此提示属于误报。

## 3. 目标

- Kimi 自动标题永远不展示 Yep provider-only reminder；已有错误标题在部署后无需修改 Kimi session 文件即可恢复。
- 用户手动设置的 Kimi custom title 不被 provider 兼容过滤误删。
- `ReadMediaFile` 在 live 与 persisted 两条路径都显示清晰的媒体结果，不再显示 `""`，且不泄露或渲染巨型 base64。
- 图片结果至少显示文件名、媒体类型和成功状态，并可在允许的本地路径上点击预览；视频结果安全降级为媒体摘要，不错误套用图片 renderer。
- `Write` 在空输入、仅 path、仅 content、path/content 分阶段到达等中间态下均不抛异常；完整输入到达后原地升级为正常预览。
- 单个工具渲染异常被限制在对应 tool row，不再让整个 session 页面进入不可恢复的全局错误页。
- 只有客户端与服务端 buildId 确实不一致时才显示版本不匹配提示；普通 TypeError 使用通用错误分类。
- 所有新增或修改的客户端文案同步维护 `en` 和 `zh-CN`。

## 4. 非目标与约束

- 不修改 Kimi CLI 源码或本机 `~/.kimi-code` session/state/wire 文件。
- 不通过重写 Kimi `state.json.title` 修复历史标题；修复发生在 Yep 的读取、缓存和展示层。
- 不把所有 provider 的工具结果统一改成 Kimi 特例；共享层只扩展真实的“字符串或结构化 content”能力，Kimi 媒体解析保持显式边界。
- 不在工具卡、日志、index 或异常报告中记录完整 base64、原始 `blobref` payload、prompt 或未经处理的绝对路径。
- 不借本任务重构全部 tool renderer；只做一次有界审计，修复与 partial-input 不变量直接相关的高风险入口。
- 本计划阶段不重启、不部署、不接管当前 8022 服务。
- 实施阶段默认不运行浏览器/UI 自动化；如验收必须依赖浏览器截图或交互，先取得用户明确授权。
- 保留当前工作树中与本任务无关的修改，不回滚、不覆盖、不暂存。
- 计划成稿时 `CHANGELOG.md`、`packages/client/src/i18n/en.json`、`packages/client/src/i18n/zh-CN.json` 已有其他未提交改动；实施前必须先审查这些文件的现有 diff，只增量合并本任务条目，不能用整文件替换覆盖用户工作。

## 5. 目标数据契约

### 5.1 Kimi tool result output

在 shared Kimi schema 中显式建模：

```ts
type KimiToolResultOutput = string | KimiToolResultContentPart[];
```

`KimiToolResultContentPart` 至少识别：

- `text`；
- `image_url` / `imageUrl`；
- `video_url` / `videoUrl`；
- `audio_url` / `audioUrl`；
- 带 `type` 的未知 passthrough part，保证 Kimi wire 演进不会让整个 record 退化成 untyped raw object。

新增共享、纯函数式的媒体摘要解析器，同时接受：

- persisted wire 的原生数组；
- ACP `content.text` 中 JSON 编码的数组；
- ACP `rawOutput` 的原生数组。

输出是有界摘要，例如：

```ts
interface KimiReadMediaSummary {
  kind: "image" | "video" | "audio";
  path?: string;
  mimeType?: string;
  bytes?: number;
  mediaUrl?: string;
  blobRef?: { mimeType: string; hash: string };
}
```

解析器不得复制 base64；只计算必要的 MIME/字节摘要，并保留经过现有 hash 校验的 blob reference。

### 5.2 Partial tool input

客户端 renderer 的输入契约改为：工具 input 在 terminal result 到达前始终视为 `unknown`/partial，而不是完整 schema。

对 `Write` 使用一个集中 normalizer：

- path 依次接受 `file_path`、`path`、`filePath`；
- content 仅在确实为字符串时使用；
- augment 字段独立保留；
- normalizer 返回 optional 字段，不用类型断言伪造完整 `WriteInput`。

renderer 行为：

| 已到达字段 | pending 展示 | complete 展示 |
| --- | --- | --- |
| 无 path、无 content | 工具名 + spinner，不生成 collapsed preview | 使用 result；result 也不完整时显示有界 fallback |
| 仅 path | 文件名 + spinner，不计算行数 | 优先使用 result，缺 content 时不打开空 modal |
| 仅 content | 显示等待路径的中性状态，不调用路径函数 | 优先使用 result；否则显示无路径 fallback |
| path + content | 正常行数与预览 | 正常结果/预览 |

### 5.3 标题来源优先级

Kimi summary 的标题优先级调整为：

1. `isCustomTitle === true` 的非空标题；
2. 不含 Yep 唯一 ACP marker 的可用 provider title；
3. `derived.firstPromptText`；
4. 现有空标题 fallback。

只识别精确、锚定的 Yep marker：`[yep-anywhere:kimi-acp-single-question]`。不使用宽泛 `<system-reminder>` 正则，不删除普通用户提到相似术语的文本。

对于 `isCustomTitle` 缺失的旧数据，标题若以该唯一 marker 的完整或截断前缀开头，按污染的自动标题处理；若 `isCustomTitle === true`，即使内容相同也尊重用户显式标题。

## 6. 分阶段实施计划

### M0：固定回归样本与共享 helper

1. 从已确认 session 提炼不含真实路径/内容的最小 fixture：
   - flattened + truncated ACP reminder title；
   - `ReadMediaFile` 的 text/image_url/text 数组；
   - ACP JSON-string array 与 raw array 两种形状；
   - `Write` 空 input → path-only → full input 的三阶段快照。
2. 在 `packages/shared/src/kimi-schema/types.ts`：
   - 扩展 `KimiToolResultEventSchema.result.output`；
   - 增加精确的 poisoned-title 判定 helper；
   - 增加 `ReadMediaFile` 摘要解析 helper；
   - 从 `packages/shared/src/index.ts` 导出新 contract/helper。
3. 在 shared tests 中覆盖 exact marker、截断 marker、custom/user prose 不误伤、数组/JSON 字符串/错误输出/未知 part。

完成条件：shared 层能类型安全地解析 Kimi 0.36 与 0.38 的已观察输出，且不生成 base64 副本。

### M1：修复标题与历史 index

1. `KimiSessionCacheEntry` 保存 `state.isCustomTitle`。
2. `KimiSessionReader.getSessionSummary()` 按 5.3 的优先级选 title；不修改 Kimi state 文件。
3. `getSession()` 继续保留 provider 原始 title 供诊断，但公共 `summary.title/fullTitle` 必须使用清理后的候选值。
4. 给 summary index 增加 targeted migration predicate：若缓存中存在 `provider === "kimi"` 且 title/fullTitle 命中唯一 marker，则丢弃该 scope 的旧缓存并重建；不为一个 provider 问题无条件重建所有 provider index。
5. 给 content/search index 增加相同的 targeted migration，避免搜索页继续展示或匹配旧污染标题。
6. 测试 `state.json` mtime/size 未变化、仅代码升级的场景，确认新进程仍会使已有错误缓存失效。

完成条件：目标 session 的 metadata、project list、global sessions、recents 和 search 均不再出现 reminder；custom title 与正常 Kimi title 保持不变。

### M2：修复 `ReadMediaFile` live/persisted 投影

1. persisted normalization：
   - 识别 `tool.result.result.output` 的数组分支；
   - 从 wrapper text 与 media part 生成有界结构化摘要；
   - `blobref` 通过现有严格 parser 解析，并映射为受控 `/api/local-image` 预览来源；
   - 每个 result 继续按 `toolCallId` 独立发出，不能把并行工具结果 fan-out 到错误的 tool call。
2. live ACP provider：
   - terminal update 优先检查 `rawOutput` 的多模态数组；
   - `content.text` 的 JSON 数组作为兼容 fallback；
   - 生成与 persisted path 相同的结构化摘要；
   - 不把完整 data URL 再广播给 Yep 客户端。
3. client preprocessing：
   - 不再把所有非字符串 `tool_result.content` 静默变成 `""`；
   - Kimi `ReadMediaFile` 数组必须进入 structured result 或显式摘要；
   - richness/merge 规则保证 persisted rich result 能升级 live partial result，反向 partial snapshot 不能覆盖完整摘要。
4. 新增专用 `ReadMediaFileRenderer`，不要把工具无条件别名成 `ViewImage`：
   - image：文件名、MIME/大小、成功状态、允许时点击预览；
   - video/audio：显示媒体摘要和路径，不调用图片组件；
   - error：显示有界错误文本；
   - missing blob/path：显示“结果已返回但预览不可用”的降级状态；
   - 永不渲染 base64 或原始 JSON 数组。
5. registry 注册 Kimi 原生工具名，并复用现有 `ViewImageRenderer` 的安全 fetch/modal 基础组件，而不是复制 local-image 请求逻辑。

完成条件：两个并行 `ReadMediaFile` 在运行中和刷新后都显示各自正确文件；工具卡中不存在 `""`、base64 或 raw `blobref`。

### M3：修复 `Write` partial input 与工具级错误隔离

1. 重构 `WriteRenderer` 的输入读取：
   - 所有路径/内容访问先经过 optional normalizer；
   - `getFileName`、`isMarkdownFile`、行数计算和 modal 构造不得接收未验证值；
   - `renderToolUse`、`getUseSummary`、`getResultSummary`、`renderCollapsedPreview` 使用同一 normalizer，避免只修一个入口。
2. pending input 不完整时不创建 collapsed preview；保留工具 header、状态和 spinner。字段补齐后由现有同 id merge 原地升级。
3. 完整 result 可以独立于 input 渲染；失败 result 不因 input 缺失而覆盖真实错误信息。
4. 在 `ToolCallRow`/render item 边界增加工具级错误隔离：
   - 单个 renderer 抛错时只替换该 tool row；
   - fallback 至少保留 tool name、状态和安全摘要；
   - 记录不含 input/output/path 正文的诊断字段；
   - 不静默吞掉异常，也不触发整个应用 Error Boundary。
5. 对核心 file renderers 做有界静态审计，确认 `Read`、`Write`、`Edit` 在 pending partial input 下没有同类直接字符串调用；只修发现的同类入口，不扩大为全 renderer 重构。

完成条件：空 `Write` input 渲染不抛错；后续 full `tool_call_update` 到达后显示正常文件预览；任一工具 renderer 的人工抛错不会清空整个 session 页面。

### M4：收紧全局 Error Boundary 分类

1. 删除基于通用 TypeError 文本的 `isLikelyVersionMismatch()` 推断。
2. 使用 `__BUILD_ID__` 与 `/api/version.build.buildId` 做 confirmed mismatch 判定：
   - 两者均存在且不相等才展示版本不匹配；
   - buildId 相同或信息不足时只显示通用错误；
   - dev profile 不做生产构建误判。
3. Error Boundary 仍提供 reload，但不宣称 reload/升级一定能修复普通渲染异常。
4. 移除错误页中失效的 upstream issue 链接和 `npm i -g yepanywhere` 指令，改为本独立项目的 issue 入口与正确的部署/刷新提示。
5. 将 `I18nProvider` 提升到 Error Boundary 外层，或提供等价的顶层 locale 访问方式；所有错误页文案进入 `en` / `zh-CN`，保持正常 App provider 顺序不变。
6. 增加 Error Boundary unit tests：generic TypeError、confirmed build mismatch、version API failure、reload action、双语 fallback。

完成条件：本次 `undefined.split` 类错误不再显示版本不匹配；人为构造不同 buildId 时仍显示准确警告。

### M5：验证、变更日志与部署准备

1. 更新 `CHANGELOG.md` 的 `[Unreleased]`，覆盖：
   - Kimi title 清理与旧 index migration；
   - `ReadMediaFile` 多模态结果展示；
   - Kimi `Write` streaming partial-input 崩溃修复；
   - Error Boundary 误判与工具级隔离。
2. 开发阶段不提升版本号；正式部署/发布前按 CalVer 流程执行 `pnpm version:status` / `pnpm version:bump` / `pnpm version:check`。
3. 运行聚焦测试后执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

4. 不默认运行 `pnpm test:e2e`；只有新增 E2E 覆盖确有必要时再运行。浏览器/UI 验证需另行获得授权。
5. 经用户授权部署后，比较 `/api/version`、`/build-info.json` 和 bundle build-info，确认客户端/服务端 buildId 一致；不得擅自重启当前服务。

## 7. 文件级改动清单

计划涉及的主要文件如下；实施时以实际依赖为准，但不得遗漏对应测试和双语文案。

### Shared

- `packages/shared/src/kimi-schema/types.ts`
- `packages/shared/src/index.ts`
- `packages/shared/test/kimi-schema/types.test.ts`

### Server

- `packages/server/src/sdk/providers/kimi.ts`
- `packages/server/src/sessions/kimi-reader.ts`
- `packages/server/src/sessions/normalization.ts`
- `packages/server/src/indexes/SessionIndexService.ts`
- `packages/server/src/indexes/SessionContentIndexService.ts`
- `packages/server/test/sdk/providers/kimi.test.ts`
- `packages/server/test/sessions/kimi-reader.test.ts`
- `packages/server/test/sessions/normalization.test.ts`
- `packages/server/test/indexes/SessionIndexService.test.ts`
- `packages/server/test/indexes/SessionContentIndexService.test.ts`

### Client

- `packages/client/src/lib/preprocessMessages.ts`
- `packages/client/src/lib/__tests__/preprocessMessages.test.ts`
- `packages/client/src/components/blocks/ToolCallRow.tsx`
- `packages/client/src/components/blocks/__tests__/ToolCallRow.test.tsx`
- `packages/client/src/components/renderers/tools/WriteRenderer.tsx`
- `packages/client/src/components/renderers/tools/ViewImageRenderer.tsx`
- `packages/client/src/components/renderers/tools/ReadMediaFileRenderer.tsx`（新增）
- `packages/client/src/components/renderers/tools/index.tsx`
- `packages/client/src/components/renderers/tools/types.ts`
- `packages/client/src/components/renderers/tools/__tests__/WriteRenderer.test.tsx`
- `packages/client/src/components/renderers/tools/__tests__/ReadMediaFileRenderer.test.tsx`（新增）
- `packages/client/src/components/ErrorBoundary.tsx`
- `packages/client/src/components/__tests__/ErrorBoundary.test.tsx`（新增）
- `packages/client/src/App.tsx`
- `packages/client/src/main.tsx`
- `packages/client/src/i18n/en.json`
- `packages/client/src/i18n/zh-CN.json`

### Release

- `CHANGELOG.md`

## 8. 测试矩阵

| 层级 | 场景 | 预期 |
| --- | --- | --- |
| shared schema | string tool output | 保持 string |
| shared schema | image/video content array | 类型化解析且保留顺序 |
| shared helper | JSON-string media array | 得到有界摘要，不复制 base64 |
| shared helper | blobref / data URL / malformed URL | 严格解析或安全降级 |
| title helper | 完整、压平、截断 marker | 判定为 poisoned auto title |
| title helper | 普通 user prose / custom title | 不误删 |
| Kimi reader | poisoned auto title + 首条用户文本 | 回退到首条用户文本 |
| Kimi reader | `isCustomTitle=true` | 保留 custom title |
| summary/content index | 旧缓存 mtime/size 未变 | targeted migration 后重建 |
| live ACP | `rawOutput=ContentPart[]` | 输出结构化媒体摘要 |
| live ACP | 仅 JSON-string content | 兼容解析 |
| persisted replay | `blobref` image result | 映射受控预览 URL |
| parallel tools | 两个 `ReadMediaFile` | 按 toolCallId 正确配对 |
| client merge | rich persisted + partial live | rich result 胜出 |
| media renderer | image | 摘要 + 可用时预览 |
| media renderer | video/audio | 安全摘要，不调用 image modal |
| media renderer | missing blob/error | 有界 fallback，无 raw payload |
| Write renderer | `{}` pending input | 不抛错，不生成错误预览 |
| Write renderer | path-only/content-only | 占位并等待补齐 |
| Write renderer | later full update | 原地显示正常预览 |
| Write renderer | result-only complete/error | 使用真实 result，不依赖 input |
| tool boundary | renderer 人工抛错 | 仅该 row fallback，会话其余内容保留 |
| Error Boundary | generic TypeError + 相同 buildId | 不显示版本不匹配 |
| Error Boundary | 不同 buildId | 显示 confirmed mismatch |
| Error Boundary | version API 失败 | 通用错误 + reload，不误判 |

## 9. 风险与缓解

### 9.1 多模态结果体积重新膨胀

风险：直接把 ACP `rawOutput` data URL 广播给客户端，会放大内存、WebSocket 与缓存体积。

缓解：在 server/provider 边界提取有界摘要；persisted blob 只通过 hash + 受控 URL 引用；测试断言响应和 renderer 文本中不存在 base64。

### 9.2 工具结果错配

风险：并行 tool results 若依赖 message-level `toolUseResult`，可能被错误 fan-out。

缓解：所有摘要以 `toolCallId/tool_use_id` 为主键；只有单 result message 才允许使用 message-level structured fallback；沿用并扩展现有防 fan-out 测试。

### 9.3 标题误删用户内容

风险：宽泛过滤 `<system-reminder>` 会删除合法用户文本或手动标题。

缓解：仅匹配 Yep 唯一 marker，结合 `isCustomTitle`，并为 user prose/custom title 增加反例测试。

### 9.4 Index migration 造成无谓全量扫描

风险：全局 version bump 会让所有 provider index 重建。

缓解：优先使用只针对缓存中 poisoned Kimi title 的 migration predicate；summary 与 content index 分别覆盖测试和性能日志。

### 9.5 工具级 Error Boundary 掩盖真实 bug

风险：局部 fallback 可能让异常长期无人注意。

缓解：fallback 只保护用户界面，仍发送去敏诊断；测试和开发日志保留错误类型、renderer/tool 名与 buildId，但不记录 input/output/path 正文。

### 9.6 I18nProvider 提升引入 provider 顺序回归

风险：移动 provider 层级可能影响 hooks 或测试 wrapper。

缓解：只提升 locale provider，保持 Toast/Auth/Inbox/SchemaValidation 相对顺序；增加 App bootstrap 与 Error Boundary 测试，核对登录页和 session 页正常渲染。

## 10. 验收标准

全部满足后才能把修复标记为完成：

1. 目标 Kimi session 的标题显示“你好”或等价首条公开用户文本，不再出现 ACP reminder。
2. 已有 summary/search index 不依赖 session 文件变更即可移除旧污染标题。
3. 两个截图对应的 `ReadMediaFile` 卡片各自显示正确文件信息，不出现 `""`。
4. live stream 与刷新后 replay 的 `ReadMediaFile` 可见信息一致。
5. API、客户端 state、DOM 文本和日志中不出现该媒体的完整 base64。
6. `Write` 空输入/分阶段输入不会抛异常，完整输入到达后正常显示预览。
7. 人工构造 renderer 异常时，session 页面其他消息仍可用。
8. buildId 一致的普通 TypeError 不再显示版本不匹配；真实不一致仍准确提示。
9. `en` / `zh-CN` 文案同步，错误页不再指向 upstream issue 或不存在的 npm 更新路径。
10. `pnpm lint`、`pnpm typecheck`、`pnpm test` 全部通过。
11. `CHANGELOG.md [Unreleased]` 已记录用户可见修复。
12. 未修改或覆盖当前工作树中与本任务无关的用户改动。

## 11. 推荐实施顺序与提交切分

建议按以下逻辑切分，便于 review 与回滚：

1. `fix(kimi): normalize titles and media result contracts`
   - shared schema/helper、reader title、summary/content index migration、server normalization/provider tests；
2. `fix(client): render Kimi media and partial Write calls safely`
   - preprocessing、`ReadMediaFileRenderer`、`WriteRenderer`、tool-level boundary；
3. `fix(client): classify error-boundary build mismatches precisely`
   - buildId 判定、双语错误页、独立项目链接；
4. `docs(changelog): record Kimi ACP rendering fixes`
   - `[Unreleased]` 与必要的实现后文档状态更新。

本文 M0–M5 已完成实施。`pnpm lint`、`pnpm typecheck`、`pnpm test` 均通过；涉及最后一轮图片预览来源优先级调整的 `ReadMediaFileRenderer` / `ViewImageRenderer` 聚焦测试也已复跑通过。未运行浏览器自动化，且不会在未获部署授权的情况下重启或替换当前 8022 服务。
