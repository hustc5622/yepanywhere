# Feishu / Lark 渠道迁移与回滚 Runbook

本文是把一个或多个 Feishu/Lark app/account 从既有 consumer 迁移到 Yep Anywhere 的通用执行模板。它不表示迁移已经发生，也不授权真实凭据探测、连接切换、routing mutation、部署、重启、故障注入或删除。

示例统一使用 `<canary-account-a>`、`<canary-account-b>`、`<legacy-consumer>`、`<data-dir>` 和 `<base-url>`。实际值只进入受控工单，不进入仓库、PR、普通日志或 shell history。

## 1. 不变量与完成条件

整个窗口必须保持：

- 同一 app/account 同时只有一个有效 long-connection consumer；
- 不删除旧 session、transcript、canonical journal、binding 或 accepted inbox item；
- interaction 不自动代答、越权批准或在未知结果后重放；
- 回滚只切 consumer/routing owner，不覆盖生产 durable state；
- secret、消息正文、附件、完整路径和 raw identity 不进入工单；
- 代码合并、部署、账号连接和旧 consumer 下线是四个独立授权点。

迁移完成必须由 change owner 签字，并至少证明：每个 canary account 通过约定 smoke matrix 和观察窗口；duplicate dispatch、stuck task、dead-letter 和未闭合 interaction 均满足预先定义的退出阈值；旧 consumer 不再拥有目标 routing；恢复材料仍可读。

## 2. 角色与授权点

| 角色 | 职责 |
| --- | --- |
| change owner | 决定开始、扩大、暂停、回滚和结束 |
| legacy owner | 提供旧 consumer、连接和 routing 的只读证据 |
| Yep operator | 准备配置、读取诊断、执行已批准动作 |
| smoke tester | 使用专用私聊/群聊/话题执行矩阵 |
| recovery owner | 验证备份、restore 演练和 code/runtime 回滚 |

以下动作分别请求授权，不用一次笼统批准替代：

1. 用真实凭据访问平台；
2. 停止旧 consumer 或连接 Yep account；
3. 部署、重启或停止 Yep/provider/bridge；
4. 修改 binding、routing 或 canonical rollout policy；
5. 运行浏览器、device、APK 或真实外部 contract test；
6. 删除旧配置、previous runtime、备份或历史数据。

## 3. 受控记录模板

```text
change_id:
operator:
started_at:
source_commit:
review_or_release_ref:
build_id_fingerprint:
codex_cli_version:
codex_schema_hash:
account_alias: <canary-account-a>
app_id_fingerprint:
legacy_consumer_fingerprint:
new_consumer_fingerprint:
code_backup_ref:
runtime_backup_ref:
config_backup_ref:
preflight_report_ref:
canary_started_at:
observation_ends_at:
rollback_decision:
completed_at:
```

所有 `*_ref` 指向 owner-only 存储；不要记录绝对私人路径。身份值使用不可逆、带用途前缀的 fingerprint，不能简单截断原始 ID。

## 4. 离线预检

预检脚本默认只读，不启动、停止或连接服务。它验证账号结构、secret 引用是否存在、权限模式、workspace 边界、binding owner/provider、durable store 和 legacy marker；离线模式不能证明凭据有效，也不能证明 consumer 唯一。

```bash
corepack pnpm feishu:migration:preflight \
  --data-dir <isolated-data-dir> \
  --accounts <canary-account-a>,<canary-account-b> \
  --legacy-label <legacy-consumer-label> \
  --strict
```

JSON 报告只能写入 owner-only 目录。它不包含 App Secret，但可能包含 data-dir 或账号 alias，因此不得直接上传到公开 PR。

在单独获得真实凭据的只读网络探测授权后，才可使用：

```bash
corepack pnpm feishu:migration:preflight \
  --data-dir <isolated-data-dir> \
  --accounts <canary-account-a> \
  --probe-credentials \
  --strict
```

进入 canary 的最低门槛：`summary.fail=0`；凭据有效性由 probe 或等价 external contract 证明；consumer exclusivity 有现场证据；所有 warning 均有 owner 和处置结论。

## 5. 版本、工具链和恢复快照

在任何变更前只读记录：

```bash
git rev-parse HEAD
node --version
corepack pnpm --version
codex --version
corepack pnpm codex:protocol:check
curl -fsS <base-url>/api/version
curl -fsS <base-url>/build-info.json
```

不要把认证 token 放入命令行或工单。若实例要求认证，使用现有受控机制并只保存脱敏结果。

备份至少包括：

- 当前 code ref、review/release artifact 和 build metadata；
- LaunchAgent plist、当前 runtime bundle 和 `.previous` bundle（若存在）；
- `accounts.json`、`secrets.json`、`bindings.json`；
- `inbox.jsonl`、`outbox.json`、`operations.json`；
- canonical event journal/checkpoint；
- preflight、schema hash 和 consumer-owner 记录。

配置/状态备份使用目录 `0700`、文件 `0600`。restore 演练只能在临时 data dir 和未监听端口中进行，不允许用生产 data dir 验证。

## 6. 两类主机的兼容门禁

升级前在干净 checkout/CI 中验证，不在承载运行 bundle 的工作树执行 build：

| Profile | 必须证明 |
| --- | --- |
| clean/default host | Node pin 与 pnpm pin 一致；无 Feishu config/secret 仍可 build/test；channel inert；既有 Claude/Codex/Gemini/Pi/Kimi/ZCode 路径不因 Lark SDK 初始化失败 |
| Feishu-enabled fake host | 只使用 synthetic config、mock SDK、临时 data dir 和 fake provider；protocol、interaction、session、artifact、channel tests 通过；不访问真实 tenant |

仓库同时维护 `.nvmrc` 和 `.node-version`，两者必须相同。部署脚本会拒绝不一致的 Node pin 或错误 pnpm 版本；不要因为某台主机恰好安装了更高 Node 或全局 pnpm 就跳过门禁。

LaunchAgent 使用仓库外 runtime copy。构建源仍在 `dist/npm-package`，但 plist 的 CLI 与 working directory 指向 `${YEP_LAUNCHD_RUNTIME_DIR}`；同步会保留一份 `${YEP_LAUNCHD_RUNTIME_DIR}.previous`。这避免后台进程依赖 Desktop 等隐私保护目录，也让 repo build 与运行文件分离。

## 7. 部署边界

部署不是本 Runbook 自动执行的步骤。获得授权前，先输出将发生的精确动作：

- 是否构建新的 server/client bundle；
- 是否更新 LaunchAgent runtime copy 和 `.previous`；
- 哪些 listener 会重启，哪些 bridge PID 必须保持不变；
- enabled channel 的 long connection 是否会断开并 reconciliation；
- 失败时 code/runtime/plist/plugin 各自如何回滚。

`scripts/deploy.sh --server-only` 会构建 bundle，并可能更新已安装 LaunchAgent 的 runtime copy；若继续执行 restart，server listener 和 enabled channel connection 会发生变化。默认不得追加 bridge restart、skip-checks 或 destructive 参数。

部署后、发送 canary 前核对：

- API、client、source bundle 和 live runtime 的 build metadata 一致；
- server listener 仍由预期 owner 管理，没有意外 direct fallback；
- 明确要求保留的 bridge listener PID 未变化；
- config、secret 和 plist 的预期 fingerprint 未被意外改写；
- recovery 后 inbox/outbox/operation 已收敛，未出现重复 turn；
- 目标账号尚未连接，直到 legacy consumer exclusivity 得到证明。

## 8. 单消费者交接状态机

每个 account 独立执行：

```text
LEGACY_ONLY -> QUIESCING -> NO_CONSUMER -> YEP_CANARY -> YEP_ONLY
                              |               |
                              +--- rollback --+
```

1. `LEGACY_ONLY`：记录旧实例 fingerprint、启动方式、连接状态和最后事件时间。
2. `QUIESCING`：停止接受新事件，等待已 accepted work 到 terminal；queue/inflight 必须归零。
3. `NO_CONSUMER`：证明旧 long connection 已断开；不能通过同时连接 Yep 来“看谁收到”。
4. `YEP_CANARY`：只连接一个 account，确认另一个账号和旧 routing 不变。
5. `YEP_ONLY`：smoke 与观察窗口通过后，才更新 owner 记录。

无法证明旧 consumer 已停止时，不得进入 `YEP_CANARY`。平台 event dedupe 不能替代 consumer exclusivity。

## 9. Canary 和 smoke

账号按一项一项顺序推进。`<canary-account-a>` 完成最小 smoke、完整矩阵和观察窗口后，才开始 `<canary-account-b>`。rollout/projection 也按 account gate，禁止直接改变全局默认。

最小 smoke：私聊文本、群聊 mention、话题、图片、文件、stop、approval、question。完整矩阵再增加：引用、merge-forward、连续消息、重复 event、unknown event、CardKit 429/5xx、attachment 拒绝、process exit 和 replay。

每一项只记录：event fingerprint、correlation fingerprint、session/turn opaque locator、开始/终态时间、固定结果码。不要复制原始正文、filename、attachment、prompt、answer 或 tool input。

## 10. 观测与硬回滚条件

按约定间隔保存不含内容的状态摘要：channel status/diagnostics、worker 状态、version/build metadata、canonical sequence/unknown count 和 open interaction count。

出现以下任一情况立即停止扩大并进入回滚评估：

- 同一 account 被两个 consumer 同时接收；
- 同一 event 创建多个 turn 或最终回复；
- accepted event 丢失，或 terminal 后外部回复长期不终结；
- approval/question 绑定错误 actor、request、turn 或 scope；
- secret、raw reasoning、私人路径或未脱敏 identity 外发；
- binding 越过 allowed root，或 provider/owner 与计划不符；
- durable replay 与 live canonical state 不一致；
- code/runtime/build identity 无法对应，或 listener ownership 丢失。

## 11. 回滚

### Consumer/routing 回滚

1. 停止扩大测试并记录安全 correlation；
2. 让 Yep 停止接收目标 account 的新事件；
3. 等待或持久化 inflight，确认 long connection 已断开；
4. 恢复 legacy consumer 的最后已知配置；
5. 再次证明只有一个 consumer 后恢复 routing；
6. 对窗口内 accepted events 逐项 reconciliation，禁止批量重发；
7. 保留诊断和脱敏 fixture，修复后从第一个 canary 重新开始。

### Code/runtime 回滚

- PR 尚未合并：关闭 review branch，不改 main。
- 已由人类合并：在新 review branch 上逆序 `git revert`，不改写已发布历史。
- 已同步但未重启：恢复经验证的 source bundle，并把 runtime `.previous` 提升回 active target；先备份当前失败 bundle。
- 已重启：恢复 code/runtime/plist/plugin 后重新执行 build identity 和 listener ownership 检查，再恢复流量。
- durable state：永不通过覆盖生产 inbox/binding/operation/journal 来“回滚代码”；使用新代码兼容读取或经审计 migration。

任何 runtime 交换都要使用精确、已验证路径；不对 home、repo root 或未识别目录执行递归删除。若 `.previous` 不存在或验证失败，停止并从 owner-only artifact 恢复。

## 12. 最终签字与保留

最终签字前确认：

- 每个 canary account 已通过约定观察窗口；
- legacy consumer 不再拥有目标 routing；
- smoke、恢复演练和 hard-trigger audit 有证据；
- app/build/Codex/schema/runtime identity 已归档；
- code、runtime、config 和 durable-state 回滚路径均已验证；
- known limitation 和 blocked-with-reason 能力已记录；
- 旧配置和恢复材料的 owner、保留期、清理审批入口已登记。

完成签字后，迁移项才可标记为完成。本文档本身不授予连接、停用、重启、部署、routing mutation 或删除权限。
