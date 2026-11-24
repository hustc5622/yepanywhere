# 会话状态统一裁决（Session Lifecycle）

会话「在不在跑、上一轮怎么结束」由服务端唯一的裁决器决定：
`packages/server/src/sessions/session-lifecycle.ts` 的 `resolveSessionLifecycle()`。
会话列表（全局 `/api/sessions`、项目列表、侧栏）、会话详情、展示投影
（`routes/session-display.ts` → `SessionDisplayService`）和归档限制都调用它，
不要在路由里再手写一套判定。

## 分层

1. **证据（各 harness 各自实现）**
   - 自有进程：`Process.getInfo()` / `RuntimeProcessSnapshot` 的 `state`、待处理输入、
     `hasPendingBackgroundWork`（目前只有 agy 实现）、`lastTurnOutcome`（进程收到的最近
     一个 `result`，新一轮开始时清空）。
   - 外部活跃：`ExternalSessionTracker`。进程探测 `supervisor/externalProcessProbe.ts`
     覆盖 claude、gemini、codex、pi、agy、cursor、mcode；日志尾探测
     `supervisor/session-tail-probe.ts` 覆盖 pi、dsh、agy、codex、mcode。
     `settled` 的尾态是权威的（同目录空闲的 CLI 不会让会话显示为运行中），
     `in-flight` 是进程探测无法否定的活跃证据（Pi Web、MiniMax Code App 这类进程内宿主）。
     Cursor 的 store 在模型仍在思考时就会写出「看起来已完成」的回答，所以不做尾态探测。
   - 持久化历史：各 reader 输出 `SessionSummary.lastTurnStatus`
     （`completed | interrupted | failed | incomplete`）。Claude 另保留旧的 `interrupted` 布尔值。
2. **裁决**：`resolveSessionLifecycle(evidence)` 一次产出 `runtime`（`SessionRuntime`）、
   `visibleLastTurnStatus`、`displayActivity`、`toolsMayBeActive`。
3. **投影**：列表徽标（`client/src/lib/sessionStatusBadge.ts`）、详情页状态条
   （`SessionStreamPanes.tsx`）、输入框状态（`useSession.ts`）。
   侧栏项目行用同一个 `resolveSessionStatusBadge()` 逐会话求值，再经
   `addToSessionStatusRollup()` 汇总成「待审批／待回答／待处理」和运行中计数，
   不另写判定，所以项目行与展开后的会话卡片不会不一致。

## 待处理输入（审批／提问）的证据来源

「等用户操作」的状态只有一个出口：`pendingInputType`（`tool-approval | user-question`）
加 `activity: "waiting-input"`。各 harness 汇入的方式：

| 来源 | 怎么进入统一状态 | 区分审批/提问 |
| ---- | ---------------- | ------------- |
| Yep 自有进程（Claude、Codex、Gemini ACP、agy、mcode、Cursor、Pi） | provider 把原生请求（Claude `canUseTool`、Codex app-server approval/`request_user_input`/MCP elicitation、ACP `session/request_permission` 与 `elicitation/create`、Cursor ask/plan、Pi 扩展 `confirm`）统一转成 `onToolApproval` → `Process` 待处理队列 → `waiting-input` + `InputRequest` | 是（`AskUserQuestion` 为提问，其余为审批） |
| Codex remote bridge（`codex --remote`） | bridge `session-views` 自带 `pendingInputType` 与 `activity` | 是 |
| dsh（只读） | 日志尾探测 `waitingInput` → 外部活跃 `waiting-input` | 否，列表按「待回答」展示 |
| 终端里跑的 Claude 等外部会话 | 只有详情页会从历史重建未回答的 `AskUserQuestion`（`persisted-pending-input.ts`），列表拿不到 | — |
| 其他外部 CLI 会话 | 进程／日志尾只能证明在跑，无法看到终端里的审批弹窗 | — |

新增 provider 时，审批与提问一律走 `onToolApproval`，不要自建一套等待状态；
外部会话能从日志尾判断等待输入的，在探针里返回 `waitingInput`。

## 优先级

| # | 证据 | `displayActivity` | 归档 |
| - | ---- | ----------------- | ---- |
| 1 | 自有进程等待输入（或有待处理请求） | `waiting-input` | 拦截 |
| 2 | 自有进程 `in-turn` | `running` | 拦截 |
| 3 | 自有进程 `hold` | `hold` | 拦截 |
| 4 | 自有进程空闲且有后台任务 | `background` | 拦截（`background_work`） |
| 5 | 外部进程／日志尾／bridge 证明活跃 | `running` / `waiting-input` | 拦截 |
| 6 | 运行态查询本身失败（`runtimeUnavailable`） | `unknown` | 允许 |
| 7 | 自有进程空闲 | 历史末轮状态；历史停在半截时，若进程刚在 5 秒内收到 `result` 则以进程结果为准，否则 `incomplete` | 允许 |
| 8 | 没有任何东西在驱动 | 历史末轮状态；没有状态（空会话）时 `completed` | 允许 |

`unknown`（「无法确认是否仍在运行」）只用于第 6 行。只要 Yep 持有进程，
或明确知道没有东西在跑，就必须给出确定的结果。

## 展示语义

- `background`：本轮已结束但后台任务还在跑。工具行保持运行中和计时，输入框可发送，
  区块不折叠，侧栏显示「后台运行」。
- `incomplete`：agent 已停止，没有结果的工具行收敛为「未知」状态，不再转圈计时。

## 新增 provider 时

- reader 的摘要要输出 `lastTurnStatus`，否则无进程的半截会话只能显示为已完成。
- 能在两次提问之间自行开始一轮的 provider，用 `turn_started` 开始、用 `result` 结束；
  会自行唤醒的后台工作通过 `AgentSession.hasPendingBackgroundWork()` 暴露。
- 能从日志尾判断本轮是否收尾的，在 `session-tail-probe.ts` 注册探针；
  CLI 进程在 `externalProcessProbe.ts` 的 `commandMatchesProvider` 里登记。
