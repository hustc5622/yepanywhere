# LLM 网关公共层与 Pi 多网关计划

> 历史说明：本文记录从 OpenCode 命名模块抽取公共层的过程。OpenCode 集成已于 2026-08-18 退役；现行实现只有 provider-neutral LLM gateway API。

状态：第 1 步（公共层抽取）与第 2 步（Pi 多 channel）均已落地。

## 1. 背景

Yep 需要访问 OpenAI/Anthropic 兼容的聚合网关。这一概念此前分散在四处，各自维护一份"base URL + api key + 可选 `X-Sub-Module`"的解析：

| 消费方 | 位置 | 此前状况 |
| --- | --- | --- |
| OpenCode bridge / managed provider | `packages/server/src/opencode-bridge/gateway-config.ts` | 自带 `resolveOpenCodeGatewayConfig`、`fetchOpenCodeGatewayModels`、`defaultSubModule`、`withV1Path` |
| Pi provider | `packages/server/src/sdk/providers/pi.ts` | 直接复用 OpenCode 的解析器，因此只能看到单一网关 |
| Session title 生成 | `packages/server/src/config.ts` | 自带 `getDefaultSessionTitleSubModule` + 硬编码 `https://api.ohmyrouter.com` |
| 网关基准测试 | `packages/server/src/services/OhMyRouterBenchmarkService.ts` | 复用 OpenCode 的解析器 |

直接后果：新增第二个网关必须同时改动多个 provider 模块，而 Pi 的模型目录只能等于 OpenCode 默认网关的目录。

本机实际存在两个网关（`~/.zshrc` 中的 `check_model` / `check_model_old` 别名，指向 `agent_test/shell/check_models.sh`）：

| channel | base | key 来源 | `X-Sub-Module` | 只读探测结果 |
| --- | --- | --- | --- | --- |
| `check_model` | `https://api.appintheloop.com/v1` | `NEW_LLM_API_KEY` | `codex-internal`（可空） | 25 个模型，含 `claude-opus-5`、`claude-fable-5`、`kimi-k3`、`gpt-5.6-{sol,luna,terra}` |
| `check_model_old` | `https://api.ohmyrouter.com/v1` | `LLM_API_OLD_KEY`（当前 `LLM_API_KEY`） | 空（Yep 用 `claude-code-internal`） | 40 个模型，即现网 Pi 目录 |

两边有大量同名 id（`claude-opus-4-6/4-7/4-8`、`claude-sonnet-4-6/5`、`gpt-5.6-*`、`MiniMax-M2.7/M3`、`M2-her`），所以任何合并都必须命名空间化。

## 2. 第 1 步：公共层（已完成）

新增 `packages/server/src/llm-gateways/index.ts`，provider-neutral、无 logger/无 config 单例依赖（bridge sidecar 不启动完整 server config 也能用）：

- `LlmGatewayCredentials { apiKey, apiBase, subModule? }`：调用一个网关所需的全部信息，`apiBase` 恒以 `/v1` 结尾。
- `LlmGatewayChannel extends LlmGatewayCredentials { id, label, isDefault }`：`id` 会被用于派生标识（模型前缀、生成的 provider id），因此限制为 `[a-z0-9][a-z0-9_-]*`。
- `resolveDefaultLlmGatewayChannel(env)`：等价于旧的 `resolveOpenCodeGatewayConfig`（`OPENCODE_LLM_*` 优先于 `LLM_*`，ohmyrouter 默认补 `claude-code-internal`），id 固定为 `default`。
- `resolveLlmGatewayChannels(env)` / `resolveLlmGatewayChannelsDetailed(env)`：default channel 恒排第一（只支持单网关的调用方取 `[0]` 即保持原行为），其余来自 `YEP_LLM_GATEWAYS`。
- `fetchLlmGatewayModels(credentials, fetchImpl?)`、`normalizeGatewayProtocols`、`gatewayAuthHeaders`、`gatewaySubModuleHeaders`、`withV1Path`、`defaultSubModuleForApiBase`、`defaultLabelForApiBase`。

`YEP_LLM_GATEWAYS` 支持两种写法：

```
# 紧凑：id=apiBase|API_KEY_ENV|subModule|Label（逗号分隔多条；后两段可省略）
YEP_LLM_GATEWAYS="aitl=https://api.appintheloop.com/v1|NEW_LLM_API_KEY|codex-internal|AppInTheLoop"

# JSON 数组
YEP_LLM_GATEWAYS='[{"id":"aitl","label":"App In The Loop",
  "apiBase":"https://api.appintheloop.com/v1","apiKeyEnv":"NEW_LLM_API_KEY",
  "subModule":"codex-internal"}]'
```

设计约束与理由：
- key 默认通过 `apiKeyEnv` 间接引用，避免把密钥复制进第二个变量（该变量随后会进入日志、子进程环境）。仍接受字面量 `apiKey`，供只能塞死值的部署使用。
- `apiKeyEnv` 必须是合法环境变量名。LaunchAgent 安装器会解析 `YEP_LLM_GATEWAYS`，把其中实际引用的 key 变量一并写入 server plist；`YEP_LLM_GATEWAY_MODELS` 也会保留“显式空值 = 展示全部”的语义。这样直接运行与本地类生产部署使用同一份配置契约。
- `subModule` 省略时按 host 取默认值；显式写空字符串可以关闭该 header。
- 非法条目**跳过并记录 problem**，不让一个拼错的额外网关把可用的默认网关一起搞挂。`packages/server/src/index.ts` 启动时打印这些 problem，否则用户只会看到"某个模型不出现在选择器里"。
- `default` 是保留 id。

改造方式（行为等价）：
- `gateway-config.ts` 的 `OpenCodeGatewayConfig` 变成 `LlmGatewayCredentials` 的别名（结构不变，现有字面量和测试全部照旧），`resolveOpenCodeGatewayConfig` / `fetchOpenCodeGatewayModels` / `gatewayHeaders` 改为薄封装；重复的 `withV1Path`、`defaultSubModule`、`isRecord`、catalog 解析、协议归一化被删除。
- `config.ts` 删掉 `getDefaultSessionTitleSubModule`，改用共享的 `defaultSubModuleForApiBase` 与 `DEFAULT_LLM_GATEWAY_API_BASE`。
- OpenCode 的模型目录仍以常驻 opencode server（4520/4521）为准，本次不改。

测试：`packages/server/test/llm-gateways/llm-gateways.test.ts`（17 项，含 appintheloop 真实响应形状的归一化、`openai-response` 端点类型、非法条目跳过顺序与 problem 文案）。原有 `gateway-config.test.ts`、`config.test.ts`、`pi-provider.test.ts`、`opencode.test.ts`、`OhMyRouterBenchmarkService.test.ts`、`OpenCodeBridgeService.test.ts` 全部通过；`launchd-runtime.test.ts` 追加了自定义 key 变量与显式空模型过滤值的 plist 回归覆盖。

## 3. 第 2 步：Pi 多 channel（已完成）

### 命名规则（`packages/server/src/sessions/pi-model-refs.ts`）

Pi 的模型身份是 (provider, modelId) 二元组，同名 id 在 Pi 内部不冲突；Yep 的 `ModelInfo.id` 是单一字符串，因此：

| | default channel | 额外 channel（如 `aitl`） |
| --- | --- | --- |
| Yep 模型 id | `claude-opus-4-8`（裸 id） | `aitl/claude-opus-5` |
| Pi provider id | `yep-anthropic` / `yep-openai-compatible` | `yep-anthropic-aitl` / `yep-openai-compatible-aitl` |
| 传给 Pi 的 modelId | 裸 id | 裸 id（去掉 channel 前缀） |

default channel 刻意保持裸 id 与无后缀 provider id：多网关之前创建的会话、保存的默认模型、以及 Pi 自己 `settings.json` 里持久化的 provider 选择都是这个形态，改名会直接破坏这些会话的 resume。

网关原生 id 本身可以带 `/`，因此展示 id 不是可逆路由编码：默认网关的 `openai/gpt-5` 会与名为 `openai` 的额外 channel 上的 `gpt-5` 同形。目录合并时会保留抓取时的 `(channel, bareModelId)` 来源；若两个来源生成同一个 Yep id，保留配置顺序靠前者（default 恒优先）、记录 warn 并丢弃冲突副本。会话启动与 `set_model` 只使用这份来源映射，绝不从 slash 字符串反推网关。`stripPiChannelPrefix` 仅留给没有来源元数据的展示/过滤路径。

### 目录抓取（`PiProvider.getAvailableModels`）

- 遍历 `resolveLlmGatewayChannels(process.env)`，`Promise.allSettled` 并发抓取。
- 额外 channel 的模型 id 加前缀，`name` 追加 `(<channel label>)`，让选择器能区分同名模型。
- **失败隔离**：某个 channel 抓取失败时复用它上一次成功的目录（`channelModelCache`）并 warn；只有全部失败且无任何缓存时才返回空目录。
- 不再配置的 channel 缓存会被清理；合并结果按 default channel 优先、配置顺序其后，并按 id 去重。
- 若默认网关原生 slash id 与额外 channel 命名空间冲突，保留默认来源并省略歧义副本，避免请求静默发到错误网关。

### 会话启动与切换

- `buildPiExtensionConfig` 现在按 (channel × protocol) 生成 provider，每个 provider 只注册它自己 channel 的模型（裸 id）。
- **bridge gateway proxy 只对 default channel 使用**：`/gateway/v1` 的上游是硬编码的默认网关并注入它的 `X-Sub-Module`，把别的 channel 走它会静默发到错误的网关。代价是额外 channel 拿不到 bridge 的 SSE 分片合并修复（GLM 的 AI SDK 解码竞态），需要时得给 proxy 加 channel 路由。
- `resolvePiModelRoute` 提供**裸 id 回退**：请求 id 不在目录里时，回退到任何提供该裸模型的 channel（优先 default），并记 info 日志。历史会话与保存的默认值因此不会以 `Pi model "x" is not available` 开不起来。
- `routeModel` / 启动 `--provider` / `set_model` 全部发送 (channel provider id, 裸 modelId)。

### 凭据传递（`packages/server/resources/pi-yep-extension.mjs`）

- 新增 `YEP_PI_LLM_API_KEYS`（JSON map：providerId → key），替代原来的单值 `YEP_PI_LLM_API_KEY`（仍作为 fallback 保留）。
- 没有对应 key 的 provider **直接丢弃**（fail closed），避免注册出一个每次请求都报错的模型。
- 三个 env 在扩展捕获后立即从 `process.env` 删除，保持原有安全性质（Pi 的 bash 工具会继承环境）。
- provider 侧现在还会额外清理 `YEP_LLM_GATEWAYS` 以及每个 channel 的 `apiKeyEnv`（共享层新增该字段专门用于此清理），否则 `NEW_LLM_API_KEY` 这类变量会被 bash 工具原样读到。

### 展示

- `pi-reader` 从 `model_change.provider` / `assistant.provider` 反推 channel，把历史会话里的裸 id 还原成 `aitl/claude-opus-5`，否则两个网关的同名模型在 transcript 上无法区分，且 context window 会按选择器从不使用的 id 去查。
- shared `resolveModelDisplayLabel` 的 channel 白名单翻转成隐藏名单（`anthropic`/`yep-anthropic`/`yep-openai-compatible`/`default`）。原先硬编码的 `mafia|ohmyrouter|gemini|kimi` 无法涵盖动态 channel；翻转后既保留 opencode 现有显示（非 `claude-` 模型仍不加前缀），也让新 channel 的 badge 显示来源。

### 测试

- `packages/server/test/sdk/pi-multi-gateway.test.ts`：同名 id 命名空间、单 channel 失败复用缓存、无 channel 返回空、(channel × protocol) provider 生成、per-provider key map、子环境凭据清理、裸 id 回退、`set_model` 参数。
- 同一测试还覆盖默认网关 `openai/gpt-5` 与 `openai` channel 的 `gpt-5` 冲突，固定“保留默认来源且启动参数仍为默认 provider + 原生 slash id”。
- `packages/server/test/sdk/pi-extension-credentials.test.ts`：per-provider key、缺 key 丢弃 provider、legacy 单值兼容、无凭据不注册。
- `packages/server/test/sessions/pi-model-refs.test.ts`、`pi-reader-channels.test.ts`、`packages/shared/test/app-types.test.ts` 新增用例。

### 线上验证发现并修复的两件事

**1. `400 "thinking.type.enabled" is not supported for this model`**

现场：session `01a00f9b-8776-7621-9e66-252a6e83c757`，model `aitl/claude-opus-5`，effort `high`，`lastTurnStatus: failed`。

根因在 `references/pi/packages/ai/src/api/anthropic-messages.ts:1046`：Pi 只有在 `model.compat.forceAdaptiveThinking === true` 时才发 `thinking: {type:"adaptive"}` + `output_config.effort`，否则发旧的 `thinking: {type:"enabled", budget_tokens}`。Pi 自带目录由 `packages/ai/scripts/generate-models.ts` 按 id 生成这些 quirk，而 Yep 动态注册的网关模型什么都没有 → 一律走旧形态，被新模型整轮拒绝。

修复：新增 `packages/server/src/sdk/providers/pi-model-compat.ts`，镜像上游三组规则（`generate-models.ts:546` / `:564` / `:840-866`）：

| 规则 | 命中模型 |
| --- | --- |
| `compat.forceAdaptiveThinking: true` | opus-4-6/4-7/4-8/5、sonnet-4-6/5、fable-5（含 `4.8` 点号写法） |
| `compat.supportsTemperature: false` | opus-4-7/4-8/5 |
| `thinkingLevelMap {max}` | opus-4-6、sonnet-4-6 |
| `thinkingLevelMap {max, xhigh}` | opus-4-7/4-8/5、sonnet-5、fable-5 |
| `thinkingLevelMap {off: null}` | fable-5（不能关闭 thinking，否则 `thinking:{type:"disabled"}` 也会被拒） |

`buildPiExtensionConfig` 在注册 anthropic 协议模型时合并这些 traits；openai-compatible 协议仍只带 `PI_OPENAI_COMPLETIONS_COMPAT`。

**2. 选择器里全是老模型 / 无关模型**

两个网关合起来 63 个模型：十几个作废的 Claude 快照（`claude-opus-4-5-20251101`、`claude-haiku-4-5-20251001-thinking`）、十个 Gemini 变体、以及 `gemini-embedding-001`、`gpt-image-2` 这种根本不是 chat 的端点。

新增 `isVisibleGatewayModel`（`llm-gateways` 公共层），采用**允许清单**而非屏蔽清单 —— 网关目录只会越长越多，屏蔽清单会让新的日期快照/预览版悄悄回到选择器。默认清单（每个家族只留最新）：

| 家族 | 保留前缀 |
| --- | --- |
| Anthropic | `claude-opus-4-8`、`claude-opus-5`、`claude-fable-5`（不含 sonnet/haiku） |
| OpenAI | `gpt-5.6`、`gpt-5.7`、`gpt-6`（预留） |
| Zhipu | `glm-5.2` |
| Moonshot | `kimi-k3` |
| MiniMax | `minimax-m3` |
| DeepSeek | `deepseek-v4`（pro + flash） |

Gemini、doubao、qwen、mimo、M2-her、gpt-5.5、glm-5.1、kimi-k2.x、MiniMax-M2.x 全部不再出现。实测本机两个网关：63 → **16**。

`YEP_LLM_GATEWAY_MODELS=前缀1,前缀2` 整表替换；置空 = 全显示（测试 fixture 就用这个）。

**关键约束：不展示 ≠ 不可路由。** `getAvailableModels()`（选择器/切换模型）过滤，`loadRoutableModels()`（会话启动、extension provider 注册、`resolvePiModelRoute`）不过滤。否则任何已经绑在被过滤模型上的历史会话会直接开不起来 —— 有专门测试守住这条。

### 已知取舍与后续

- 额外 channel 无 bridge buffering（见上）。
- `YEP_LLM_GATEWAYS` 目前只有 Pi 消费；OpenCode 仍以常驻 opencode server 的目录为准，要让 OpenCode 也看到额外 channel 需要写入用户 `opencode.json` 或扩展 managed provider 生成逻辑。
- 若用户把 default channel 换成另一家网关，裸 id 的含义会随之改变（历史会话会回退到新的 default）。真要严格锁定需要在会话里持久化 channel id。
