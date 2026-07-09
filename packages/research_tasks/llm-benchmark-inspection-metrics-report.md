# LLM Benchmark 巡检分层指标体系建设报告

日期：2026-07-09

## 摘要

本报告面向一个固定题库的 LLM 供应商 API 巡检场景：系统会定时运行多个 benchmark，用于判断供应商模型是否稳定、是否发生异常、是否出现行为漂移。

当前已有基础设施包括：

- benchmark 覆盖多个能力方向。
- benchmark 题目固定，题目本身不会漂移。
- 每次执行都保留 case 级执行轨迹。
- 单个 case 在一次 benchmark 中会重复执行多次。

在这个基础上，最关键的建设方向不是寻找某个新的单一指标替代 reward，而是建立一套：

```text
统一巡检流程
+ 通用指标层
+ benchmark 类型指标包
+ benchmark 级自定义排查指标
+ case/tag 级归因分析
+ 统计显著性与稳定性判断
```

最终目标是让巡检结论从：

```text
本次 reward 从 82.1 降到 81.7，变化不大。
```

升级为：

```text
整体 reward 无显著下降，但 agent 工具调用类 case 的 tool_args_value_accuracy 下降 8.4pp，
unstable_case_rate 上升 11.2pp，异常集中在 long_horizon + multi_tool slice。
判定为 P1 行为回归，需要排查供应商模型更新或 tool-use policy 变化。
```

## 1. 问题定义

### 1.1 巡检真正要判断什么

LLM 供应商 API 的稳定性不是一个单一概念。实际需要判断的是：

1. API 是否可用。
2. 输出协议是否仍然可解析、可执行、可消费。
3. 任务质量是否下降。
4. 同一题多次执行是否更不稳定。
5. 模型行为分布是否漂移。
6. 成本、延迟、token 使用是否异常。
7. 异常集中在哪些 benchmark、case、tag、能力类型或失败模式上。

因此，巡检系统不应该只输出一个 reward，也不应该只通过 token 总量、thinking token 总量等过程指标判断稳定性。更合理的做法是将模型巡检建设成一个分层诊断系统。

### 1.2 不同 benchmark 需要不同指标

通用流程应该统一，但指标必须按 benchmark 特性扩展。

例如：

- Agent 类任务需要关注 tool call、工具参数、trajectory、恢复能力。
- 代码类任务需要关注编译、测试、运行错误、API 幻觉。
- 数学推理类任务需要关注最终答案、hard case、推理稳定性。
- 文学写作类任务需要关注风格、约束、重复、啰嗦程度。
- 安全类任务需要区分 harmful refusal、benign refusal、unsafe compliance。
- RAG / 长上下文类任务需要关注证据使用、引用准确性、幻觉。

因此，指标体系应该采用插件化或配置化结构：

```text
benchmark = 通用指标 + 类型指标包 + benchmark 自定义指标
```

## 2. 建设原则

### 2.1 Case 等权，而不是 repeat 等权

一个 case 可能重复运行多次，但 benchmark 聚合时建议先把 repeat 聚合到 case 级，再在 case 之间等权聚合。

推荐：

```text
repeat -> case metric -> benchmark metric
```

不推荐：

```text
所有 repeat 直接混在一起算均值
```

原因是某些 case 的 repeat 数、输出长度或成本可能不同，如果直接 repeat 等权，会让这些 case 在 benchmark 中被隐式放大。

### 2.2 总分负责概览，case/tag 指标负责诊断

总 reward 只能说明整体方向。真正定位问题需要：

- benchmark 级指标
- tag/slice 级指标
- case 级指标
- repeat 稳定性指标
- failure mode 指标

例如，overall reward 只下降 0.3pp 可能看起来无风险，但如果 critical slice 下降 6pp，就应该告警。

### 2.3 Token 指标用于解释，不单独判定质量

输出 token、thinking token、latency、cost 都是有价值的遥测指标，但它们通常不能单独证明模型稳定或不稳定。

合理用法：

```text
thinking_tokens 下降 + hard_reasoning_pass_rate 下降
=> 可能 reasoning effort 被压缩。

output_tokens 上升 + writing_constraint_violation_rate 上升
=> 可能模型变啰嗦且不守约束。

thinking_tokens 变化明显，但质量与稳定性无变化
=> 记为 P2 或 Info，继续观察。
```

### 2.4 “没有显著下降”不等于“稳定”

如果要证明模型稳定，不能只看“差异不显著”。差异不显著可能只是样本量不足。

建议为关键指标定义业务等价区间：

```text
overall reward delta within +/- 1pp
critical slice pass_rate delta within +/- 2pp
schema_valid_rate delta within +/- 0.5pp
```

只有当置信区间落在可接受范围内时，才能更有把握地说模型在该指标上稳定。

## 3. 总体架构

建议系统拆成六层：

```text
1. 数据采集层：保存 run / case / repeat 的完整轨迹
2. 标准化层：把不同 benchmark 的输出归一成统一字段
3. 指标层：通用指标 + 类型指标包 + benchmark 自定义指标
4. 统计层：paired diff、置信区间、重复稳定性、时间序列异常
5. 告警层：P0/P1/P2 分级
6. 归因层：按 benchmark / tag / case / failure mode 下钻
```

数据流：

```text
Benchmark execution
  -> raw trace storage
  -> normalized case/repeat table
  -> metric computation
  -> baseline comparison
  -> statistical testing
  -> alert decision
  -> diagnosis report
```

## 4. 统一数据模型

所有 benchmark 都应该落到统一的逻辑表。最小统计单元是一次 repeat。

```text
benchmark_id
benchmark_type
case_id
case_tags
run_id
repeat_id
model
provider
model_version_or_alias
request_params
input_hash
output_text
parsed_answer
reward
pass_fail
judge_score
latency_ms
input_tokens
output_tokens
thinking_tokens
finish_reason
error_type
refusal_flag
format_valid
custom_metrics_json
trace_json
created_at
```

其中 `case_tags` 是后续诊断的基础。建议至少包含：

```text
capability: math / code / agent / writing / safety / rag / tool / long_context
difficulty: easy / medium / hard
criticality: normal / critical
format: free_form / json / multiple_choice / code / tool_call
risk: benign / sensitive / harmful / jailbreak
expected_behavior: answer / refuse / ask_clarification / call_tool
```

Agent 类任务可以增加：

```text
agent_depth: single_step / multi_step / long_horizon
tool_type: search / browser / calculator / database / file / api
trajectory_type: planning / recovery / verification / extraction
```

文学写作类任务可以增加：

```text
genre: fiction / poetry / essay / marketing / dialogue
style: classical / modern / humorous / formal / concise
constraint_type: length / persona / structure / rhetorical_device / taboo
```

RAG / 长上下文类任务可以增加：

```text
context_length_bucket: short / medium / long / ultra_long
evidence_position: beginning / middle / end / multi_span
answer_grounding: direct / inferred / multi_hop
```

## 5. Baseline 设计

### 5.1 Case 级 baseline

每个 case 都应该有自己的 baseline，而不是只保存 benchmark 总 baseline。

建议保存：

```text
case_baseline_mean_reward
case_baseline_pass_rate
case_baseline_score_std
case_baseline_answer_mode
case_baseline_answer_mode_share
case_baseline_output_tokens_mean
case_baseline_output_tokens_std
case_baseline_thinking_tokens_mean
case_baseline_thinking_tokens_std
case_baseline_latency_p50
case_baseline_latency_p95
case_baseline_refusal_rate
case_baseline_format_valid_rate
```

### 5.2 固定 baseline

固定 baseline 适合用于判断供应商模型是否偏离历史稳定行为。

优点：

- 解释简单。
- 能检测长期漂移。
- 不会被近期异常污染。

缺点：

- 如果确认新行为是可接受的，需要显式更新 baseline。

### 5.3 滚动 baseline

滚动 baseline 可以使用最近 7 天、14 天或最近 N 个健康 run。

优点：

- 对短期异常敏感。
- 能适应轻微正常波动。

缺点：

- 可能吸收慢性退化。
- 不适合作为唯一稳定性判断依据。

建议同时保留：

```text
fixed_baseline: 判断是否偏离长期稳定行为
rolling_baseline: 判断是否出现近期异常
```

## 6. 通用指标层

### 6.1 系统健康指标

回答问题：API 本身是否可用？

```text
request_success_rate
timeout_rate
5xx_rate
rate_limit_rate
retry_rate
retry_success_rate
empty_output_rate
latency_p50
latency_p95
latency_p99
```

告警示例：

```text
P0: timeout_rate > 3%
P0: 5xx_rate > 1%
P1: latency_p95 比 baseline 高 50%
P2: rate_limit_rate 连续 3 次高于历史 p95
```

### 6.2 任务质量指标

回答问题：模型完成任务的质量是否退化？

```text
mean_reward
pass_rate
judge_score_mean
case_level_delta
critical_case_pass_rate
correct_to_wrong_rate
wrong_to_correct_rate
stable_correct_rate
stable_wrong_rate
```

推荐的 case-level paired comparison：

```text
case_score_current = mean(score over repeats in current run)
case_score_baseline = mean(score over repeats in baseline)
case_delta = case_score_current - case_score_baseline
benchmark_delta = mean(case_delta)
```

### 6.3 重复稳定性指标

回答问题：同一个 case 多次执行时，模型是否更随机、更不可预测？

```text
repeat_pass_rate
repeat_score_std
answer_mode_share
unique_answer_count
unstable_case_rate
stable_success_rate
stable_failure_rate
worst_of_n_score
best_of_n_score
```

建议定义：

```text
unstable_case = repeat_pass_rate >= 0.2 and repeat_pass_rate <= 0.8
stable_failure = repeat_pass_rate <= 0.1
stable_success = repeat_pass_rate >= 0.9
```

典型异常：

```text
overall reward 基本不变
unstable_case_rate 从 6% 上升到 18%
```

这说明模型平均表现没有明显变化，但单 case 行为更抖，线上 tail risk 可能变高。

### 6.4 行为漂移指标

回答问题：模型是否变成了另一种行为风格？

```text
refusal_rate
over_refusal_rate
unsafe_compliance_rate
verbosity_delta
answer_length_delta
semantic_drift_score
finish_reason_distribution
no_final_answer_rate
hedging_rate
self_correction_rate
```

这些指标适合作为 P2 观察信号，或与质量指标联动触发 P1。

### 6.5 过程遥测指标

回答问题：模型完成任务的过程是否明显变化？

```text
input_tokens
output_tokens
thinking_tokens
reasoning_to_answer_ratio
max_token_hit_rate
tokens_per_success
latency_per_success
latency_per_output_token
```

建议对 token 指标做 case-level 标准化：

```text
z_i = (current_tokens_i - baseline_mean_i) / baseline_std_i
```

这样可以避免长 case 或长输出 case 对总量造成过大影响。

## 7. Benchmark 类型指标包

### 7.1 Agent / Tool-use 类 Benchmark

关注点：

- 是否应该调用工具。
- 是否调用了正确工具。
- 工具参数是否正确。
- 多步 trajectory 是否合理。
- 工具失败后是否能恢复。
- 最终答案是否使用了工具结果。

指标：

```text
tool_call_rate
expected_tool_match_rate
tool_args_schema_valid_rate
tool_args_value_accuracy
tool_call_order_accuracy
unnecessary_tool_call_rate
missing_tool_call_rate
tool_retry_rate
tool_error_recovery_rate
plan_step_completion_rate
trajectory_success_rate
final_answer_after_tool_success_rate
```

排查示例：

```text
reward 小幅下降，但 missing_tool_call_rate 上升
=> 模型更倾向于直接回答，不调用工具。

tool_name 正确但 args 错误
=> 工具选择能力还在，但参数抽取或 schema 遵循退化。

前几步成功，后续失败
=> long-horizon planning 或上下文保持能力退化。

tool_call_rate 上升，但 final_answer_after_tool_success_rate 下降
=> 模型更频繁调用工具，但不能有效整合工具结果。
```

### 7.2 代码类 Benchmark

关注点：

- 代码是否能编译。
- 单元测试是否通过。
- 是否出现运行错误。
- 是否使用不存在的 API。
- patch 是否能应用。
- 输出格式是否符合要求。

指标：

```text
compile_success_rate
unit_test_pass_rate
hidden_test_pass_rate
runtime_error_rate
syntax_error_rate
import_error_rate
hallucinated_api_rate
patch_apply_success_rate
format_compliance_rate
```

排查示例：

```text
文本 judge score 没变，但 unit_test_pass_rate 下降
=> 代码实际可用性退化。

compile_success 不变，hidden_test_pass_rate 下降
=> 表面代码格式没问题，逻辑正确性退化。

import_error_rate 上升
=> 可能出现依赖幻觉或 API 版本理解漂移。
```

### 7.3 数学 / 推理类 Benchmark

关注点：

- 最终答案是否正确。
- 难题是否退化。
- 推理是否稳定。
- 是否提前给出错误答案。
- 是否能自我修正。

指标：

```text
final_answer_accuracy
reasoning_consistency_rate
calculation_error_rate
format_extraction_success_rate
hard_case_pass_rate
easy_case_pass_rate
self_correction_success_rate
early_answer_rate
```

如果可见 reasoning 或 thinking 摘要，可以加：

```text
thinking_tokens_delta
reasoning_depth_proxy
reasoning_to_answer_ratio
```

排查示例：

```text
thinking_tokens 明显下降 + hard_case_pass_rate 下降
=> 可能 reasoning effort 被压缩。

easy case 稳定，hard case 抖动
=> 基础能力还在，但复杂推理稳定性下降。

format_extraction_success_rate 下降
=> 可能不是推理能力退化，而是答案格式变化导致抽取失败。
```

### 7.4 文学 / 写作 / 创意类 Benchmark

关注点：

- 是否遵循写作约束。
- 风格是否匹配。
- 内容是否连贯。
- 是否重复、模板化、过度啰嗦。
- 是否存在安全或合规问题。

指标：

```text
instruction_following_score
style_match_score
coherence_score
creativity_score
constraint_violation_rate
toxicity_rate
verbosity_delta
repetition_rate
template_like_response_rate
semantic_diversity
```

排查示例：

```text
reward 没变，但 verbosity 上升 60%
=> 模型可能变啰嗦。如果 judge 有 verbosity bias，可能误判为更好。

creativity 上升但 constraint_violation_rate 上升
=> 输出更发散，但可控性下降。

style_match_score 下降，coherence_score 不变
=> 不是基础写作能力下降，而是风格遵循能力下降。
```

LLM-as-judge 建议：

- 固定 judge 模型和 judge prompt。
- pairwise judge 时随机交换候选顺序。
- 明确要求 judge 不奖励冗长。
- 用少量人工标注样本校准 judge。
- 分别报告 style、constraint、coherence，不只报一个综合分。

### 7.5 安全 / 拒答类 Benchmark

关注点：

- harmful 请求是否拒答。
- benign 请求是否被过度拒答。
- jailbreak 是否成功。
- 敏感边界是否稳定。

指标：

```text
harmful_refusal_rate
benign_refusal_rate
over_refusal_rate
unsafe_compliance_rate
policy_explanation_quality
jailbreak_success_rate
sensitive_boundary_accuracy
```

排查示例：

```text
harmful_refusal_rate 上升
=> 可能是安全能力增强。

benign_refusal_rate 同时上升
=> 过度拒答，影响可用性。

unsafe_compliance_rate 上升
=> 安全回归，通常应判 P0 或 P1。

敏感边界 case 的 unstable_case_rate 上升
=> policy boundary 变抖，线上体验不可预测。
```

### 7.6 RAG / 长上下文类 Benchmark

关注点：

- 是否使用正确证据。
- 是否出现未支撑声明。
- 引用是否准确。
- 长上下文中是否丢失中间信息。
- 检索内容是否被正确整合。

指标：

```text
faithfulness_score
citation_accuracy
context_relevance_usage
answer_groundedness
unsupported_claim_rate
lost_in_middle_case_pass_rate
long_context_pass_rate
retrieved_evidence_coverage
```

排查示例：

```text
答案看起来合理，但 unsupported_claim_rate 上升
=> 幻觉增加。

短上下文不变，long_context_pass_rate 下降
=> 上下文利用能力退化。

citation_accuracy 下降，answer_groundedness 不变
=> 内容可能正确，但引用格式或定位能力退化。
```

## 8. 单个 Benchmark 配置

建议每个 benchmark 都有一个配置文件，声明：

- benchmark 类型。
- 使用哪些指标包。
- 哪些 tag 是关键 slice。
- primary metrics 是什么。
- secondary metrics 是什么。
- P0/P1/P2 告警规则是什么。

### 8.1 Agent Benchmark 配置示例

```yaml
benchmark_id: agent_web_tasks_v2
benchmark_type: agent

metric_packs:
  - common
  - repeat_stability
  - tool_use
  - trajectory

critical_tags:
  - long_horizon
  - payment_flow
  - multi_tool

primary_metrics:
  - trajectory_success_rate
  - tool_args_value_accuracy
  - final_answer_accuracy

secondary_metrics:
  - latency_p95
  - thinking_tokens_delta
  - unnecessary_tool_call_rate

alerts:
  p0:
    - metric: tool_args_schema_valid_rate
      drop_pp: 10
    - metric: critical_case_pass_rate
      drop_pp: 15
  p1:
    - metric: trajectory_success_rate
      paired_ci_upper_below: 0
      min_drop_pp: 3
    - metric: unstable_case_rate
      increase_pp: 8
  p2:
    - metric: thinking_tokens_delta
      relative_change: 0.3
    - metric: verbosity_delta
      relative_change: 0.5
```

### 8.2 文学写作 Benchmark 配置示例

```yaml
benchmark_id: chinese_literary_writing_v1
benchmark_type: writing

metric_packs:
  - common
  - repeat_stability
  - writing_quality
  - behavior_drift

primary_metrics:
  - instruction_following_score
  - style_match_score
  - constraint_violation_rate

secondary_metrics:
  - repetition_rate
  - output_tokens_delta
  - semantic_diversity

alerts:
  p1:
    - metric: constraint_violation_rate
      increase_pp: 6
    - metric: instruction_following_score
      drop_pp: 5
  p2:
    - metric: output_tokens_delta
      relative_change: 0.5
    - metric: repetition_rate
      increase_pp: 5
```

### 8.3 安全 Benchmark 配置示例

```yaml
benchmark_id: safety_boundary_v3
benchmark_type: safety

metric_packs:
  - common
  - repeat_stability
  - safety

primary_metrics:
  - harmful_refusal_rate
  - benign_refusal_rate
  - unsafe_compliance_rate

critical_tags:
  - jailbreak
  - self_harm
  - cyber
  - medical

alerts:
  p0:
    - metric: unsafe_compliance_rate
      increase_pp: 2
      tags:
        - critical
  p1:
    - metric: benign_refusal_rate
      increase_pp: 5
    - metric: jailbreak_success_rate
      increase_pp: 3
  p2:
    - metric: refusal_rate
      relative_change: 0.25
```

## 9. 统计判断流程

### 9.1 聚合 repeat 到 case 级

对每个 case：

```text
case_score = mean(repeat_score)
case_pass_rate = mean(repeat_pass_fail)
case_score_std = std(repeat_score)
case_answer_mode_share = max(answer_count) / repeat_count
case_output_tokens_mean = mean(output_tokens)
case_thinking_tokens_mean = mean(thinking_tokens)
```

### 9.2 与 baseline 做 paired diff

```text
case_delta_i = current_case_metric_i - baseline_case_metric_i
benchmark_delta = mean(case_delta_i)
```

按 tag/slice 同样计算：

```text
slice_delta = mean(case_delta_i where tag = target_tag)
```

### 9.3 计算置信区间

建议：

- 连续分数：paired bootstrap 或 paired t-test。
- 二元 pass/fail：McNemar、paired bootstrap 或 Wilson interval。
- case 相关性较强：cluster bootstrap 或 cluster robust standard error。
- 多次 repeat：先聚合到 case 级，再对 case 做 paired comparison。

报告中至少包含：

```text
current_value
baseline_value
delta
95% confidence_interval
sample_size
affected_cases
```

### 9.4 结合业务显著性

统计显著不一定业务重要。建议为每类指标定义 practical threshold。

示例：

```text
overall reward drop >= 1pp 才值得告警
critical slice pass_rate drop >= 3pp 判 P1
schema_valid_rate drop >= 1pp 判 P1
unsafe_compliance_rate increase >= 1pp 判 P0/P1
```

### 9.5 时间序列异常检测

对于长期巡检指标，可以增加：

```text
EWMA
CUSUM
rolling z-score
control chart
```

典型规则：

```text
单次大幅异常：metric 超过 fixed threshold
持续小幅漂移：EWMA 连续超过控制线
连续弱异常：连续 3 次高于 rolling p95
```

## 10. 告警分级

### 10.1 P0：工程或安全不可接受

典型条件：

```text
API 大面积不可用
schema / tool call 大面积失败
安全 benchmark 出现 unsafe compliance 明显上升
critical case 稳定失败
生产关键协议被破坏
```

### 10.2 P1：质量或关键行为显著回归

典型条件：

```text
primary metric 显著下降
critical slice 显著下降
unstable_case_rate 明显上升
agent/tool/code 等核心协议能力下降
```

### 10.3 P2：行为漂移或早期风险

典型条件：

```text
token / thinking token 异常变化
verbosity / refusal / semantic drift 明显变化
latency / cost 异常但质量尚未下降
finish_reason 分布变化
```

## 11. 自动巡检报告模板

每次巡检建议自动生成固定结构报告：

```text
1. 总体结论
- 状态：P1
- 主要原因：agent tool args value accuracy 显著下降
- 影响范围：agent_web_tasks_v2 / multi_tool / long_horizon

2. 系统健康
- success_rate: 99.7%，正常
- latency_p95: +18%，P2

3. 质量变化
- overall reward: -0.6pp，CI 跨 0，不显著
- critical_case_pass_rate: -6.4pp，显著

4. 稳定性变化
- unstable_case_rate: 7.1% -> 18.6%
- stable_failure_cases: +31

5. Benchmark 特定指标
- tool_call_rate: -9.2pp
- tool_args_schema_valid_rate: -1.1pp
- tool_args_value_accuracy: -8.7pp

6. Top 回归 case
- case_1023: pass_rate 0.9 -> 0.2，原因：漏调 search tool
- case_1188: pass_rate 0.8 -> 0.1，原因：tool args 日期字段错误

7. 初步归因
- 非系统健康问题
- 格式能力基本稳定
- 工具选择和参数语义退化
- 可能是供应商 tool-use 行为变化或模型 alias 更新

8. 建议动作
- 冻结该模型用于 agent 场景升级
- 对比备用模型
- 扩大 multi_tool slice 重跑
- 联系供应商确认模型 alias 是否更新
```

## 12. 归因分析方法

### 12.1 Benchmark 级归因

先看哪些 benchmark 触发告警：

```text
benchmark_id
benchmark_type
primary_metric_delta
alert_level
```

用于区分：

- 全部 benchmark 都下降：可能是供应商整体模型或 API 层变化。
- 只有某类 benchmark 下降：可能是特定能力漂移。
- 只有单个 benchmark 下降：可能是该 benchmark 指标、解析器或输入格式问题。

### 12.2 Tag / Slice 级归因

对异常 benchmark 下钻：

```text
difficulty
capability
format
criticality
expected_behavior
```

示例：

```text
overall reward: -0.5pp
hard slice: -4.2pp
easy slice: +0.1pp
```

这说明问题集中在高难推理，而不是整体退化。

### 12.3 Case 级归因

输出 top regressed cases：

```text
case_id
baseline_pass_rate
current_pass_rate
delta
tags
dominant_failure_mode
sample_outputs
```

重点关注：

- 从稳定正确变成稳定错误。
- 从稳定正确变成不稳定。
- 从不稳定变成稳定错误。
- critical case 退化。

### 12.4 Failure Mode 聚类

建议为不同 benchmark 类型建立 failure mode taxonomy。

Agent 类：

```text
missing_tool_call
wrong_tool
invalid_tool_args
wrong_tool_order
failed_recovery
ignored_tool_result
incorrect_final_answer
```

代码类：

```text
syntax_error
compile_error
runtime_error
logic_error
missing_import
hallucinated_api
patch_not_applicable
```

写作类：

```text
style_mismatch
constraint_violation
repetition
too_verbose
too_generic
unsafe_content
low_coherence
```

安全类：

```text
unsafe_compliance
over_refusal
policy_boundary_flip
jailbreak_success
insufficient_safe_completion
```

## 13. 建设路线图

### 13.1 第一期：统一基线与通用指标

目标：把所有 benchmark 纳入统一统计框架。

工作项：

```text
统一 case/repeat 数据表
建立 case-level baseline
实现系统健康指标
实现通用质量指标
实现重复稳定性指标
实现 token / latency 遥测指标
支持 benchmark/tag/case 下钻
```

交付：

```text
通用巡检报表
case-level diff 表
benchmark-level summary
P0/P1/P2 初版规则
```

### 13.2 第二期：建立类型指标包

目标：让不同 benchmark 有自己的诊断能力。

工作项：

```text
agent/tool 指标包
code 指标包
math/reasoning 指标包
writing 指标包
safety 指标包
rag/long-context 指标包
```

交付：

```text
benchmark config schema
metric pack registry
benchmark-specific report sections
failure mode taxonomy
```

### 13.3 第三期：自动归因与报告

目标：从指标看板升级为自动巡检诊断。

工作项：

```text
自动识别 regression case
自动聚类 failure mode
自动生成 benchmark-specific 巡检报告
建立历史趋势分析
建立供应商模型 alias 漂移记录
将生产事故 case 回流到 benchmark
```

交付：

```text
自动巡检报告
异常 case 样例
根因假设
建议动作
供应商模型稳定性历史档案
```

## 14. 推荐落地优先级

如果资源有限，建议按以下顺序推进：

1. 统一 case/repeat 数据模型。
2. 建立 case-level baseline。
3. 实现 paired diff + 置信区间。
4. 实现 `unstable_case_rate`、`stable_failure_rate`。
5. 给所有 case 补齐 tags。
6. 为最重要的 2 到 3 类 benchmark 建类型指标包。
7. 做 P0/P1/P2 告警。
8. 自动生成巡检报告。

其中最关键的是第 2、3、4、5 项。没有 case-level baseline 和 tags，后续指标很难解释。

## 15. 参考资料

- Anthropic: [A statistical approach to model evaluations](https://www.anthropic.com/research/statistical-approach-to-model-evals)
- arXiv: [Adding Error Bars to Evals](https://arxiv.org/pdf/2411.00640)
- arXiv: [How is ChatGPT's behavior changing over time?](https://arxiv.org/abs/2307.09009)
- arXiv: [(Why) Is My Prompt Getting Worse? Rethinking Regression Testing for Evolving LLM APIs](https://arxiv.org/abs/2311.11123)
- arXiv: [Test Before You Deploy: Detecting Behavioral Drift in LLM APIs](https://arxiv.org/html/2604.27789v1)
- Braintrust: [LLM evaluation guide](https://www.braintrust.dev/articles/llm-evaluation-guide)
- LangChain: [LLM evals](https://www.langchain.com/resources/llm-evals)
- OpenAI: [Evaluating chain-of-thought monitorability](https://openai.com/index/evaluating-chain-of-thought-monitorability/)

## 16. 总结

当前基建已经具备建设高质量 LLM API 巡检体系的核心条件：固定题目、case 级轨迹、多次 repeat。

下一步应将 benchmark 从“统一 reward 排名”升级为“可解释的分层诊断系统”。

推荐的最终形态是：

```text
通用流程统一，指标按 benchmark 类型扩展；
总分负责概览，case/tag 指标负责诊断；
reward 判断质量，稳定性指标判断可预测性；
token 指标用于解释，不单独判定模型稳定；
每个 benchmark 都声明自己的 primary metrics、secondary metrics 和 failure modes；
每次巡检输出 P0/P1/P2 结论、异常 slice、回归 case 和初步归因。
```

