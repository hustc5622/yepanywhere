# 4510 Codex Bridge 轻量化实现与基准结果

> 日期：2026-08-18  
> 基线提交：`2746e6641de1` + 当前工作树  
> Node：`v25.9.0`  
> Codex protocol：`0.147.0`

## 最终架构

4510 的生产默认模式是 `lifecycle`。server → client 的高频 delta 只做 JSON-RPC parse 和 wire forwarding，不创建 `CodexEventIngress`、canonical envelope、reducer state 或 journal Promise。连接级 request/pending/thread identity 和有界 `SessionRecord` 仍在转发前同步投影。

bridge-specific lifecycle/full writer 是全服务单实例：enqueue 不等待磁盘，queue 有全局和单连接字节上限，snapshot/delta metadata 可 coalesce，terminal 记录优先，写失败打开 circuit 但不关闭上下游。writer 使用独占 lease、持久 `FileHandle`、跨 frame batch、有限 segment rotation，并可选择在 terminal batch 后 `datasync`。

现有 `codex-bridge/codex-events*.jsonl` 不删除、不迁移、不覆盖。只有显式 `legacy-blocking` 继续写旧 canonical bridge journal；`lifecycle`/`off`/`full` 启动和 resume 都不构造该 store，因此不会冷加载旧 full journal。

provider 自己的 `CodexEventIngress`、native item、artifact materializer 与 account attribution 保持独立权威。普通 Session GET 只从 provider journal补充 provider error；旧 bridge full journal只在显式 canonical/export 时按 admission 只读，并返回 source、retained coverage、leading gap 和 rollout fallback。

## 四种模式

| 模式 | 语义 |
| --- | --- |
| `off` | 显式极简回退/性能基线；无 bridge journal，wire 与 connection state 正常。 |
| `lifecycle` | 生产默认；delta journal bytes 为 0，只异步保存 compact lifecycle/terminal metadata 与 bounded session snapshot。 |
| `full` | 显式有界异步诊断；记录所有 frame 的安全 metadata，delta 按 connection/session/item coalesce，不保存 prompt、tool output、command、cwd 或 secret。 |
| `legacy-blocking` | 短期兼容回退；保留旧 store-before-forward canonical ingress，会恢复旧延迟、内存与 journal 增长特征。 |

## 基准方法

脚本：`scripts/bench-codex-bridge-forward.ts`。

每条 JSON-RPC notification 都由 fake app-server 作为一个独立 WebSocket frame 发出；每种场景在独立 child process 中运行。时间是从 fake upstream `send()` 到 downstream 收到该 frame的端到端 burst 延迟，所以绝对值包含发送端和 WebSocket 队列；跨模式判定使用同连接数的 `off` 相对基线。

主命令：

```bash
corepack pnpm tsx scripts/bench-codex-bridge-forward.ts \
  --connections=1,4 --frames=10000 --legacy-frames=1000 \
  --delta-bytes=1024
```

### 10,000 frames / connection，1 KiB delta

| 模式 | 连接/总 frame | p50 / p95 / p99 (ms) | 相对 off p95 | RSS / heapUsed | delta journal bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| `off` | 1 / 10,000 | 54.285 / 84.471 / 84.529 | baseline | 213.6 / 77.0 MiB | 0 |
| `lifecycle` | 1 / 10,000 | 61.118 / 87.521 / 87.610 | +3.050 ms | 208.3 / 47.2 MiB | 0 |
| `full` | 1 / 10,000 | 80.421 / 98.849 / 99.011 | +14.378 ms | 215.9 / 64.1 MiB | 2,552 |
| `legacy-blocking` | 1 / 1,000 | 272.544 / 653.983 / 694.680 | 不同 frame 数，不直接比值 | 228.7 / 111.9 MiB | 1,871,676 |
| `lifecycle`, writer 100 ms | 1 / 10,000 | 56.462 / 80.859 / 81.011 | -3.612 ms | 211.3 / 76.4 MiB | 0 |
| `off` | 4 / 40,000 | 197.324 / 268.648 / 270.707 | baseline | 384.5 / 107.2 MiB | 0 |
| `lifecycle` | 4 / 40,000 | 196.966 / 268.313 / 270.443 | -0.335 ms | 376.7 / 105.2 MiB | 0 |
| `full` | 4 / 40,000 | 262.244 / 376.942 / 379.139 | +108.294 ms | 378.6 / 121.8 MiB | 11,508 |
| `legacy-blocking` | 4 / 4,000 | 946.407 / 2,434.570 / 2,605.205 | 不同 frame 数，不直接比值 | 324.4 / 184.7 MiB | 7,486,704 |
| `lifecycle`, writer 100 ms | 4 / 40,000 | 204.222 / 273.045 / 275.238 | +4.397 ms | 379.2 / 110.5 MiB | 0 |

结论：`lifecycle` 的 1/4 连接 p95 分别为 off +3.050 ms / -0.335 ms；100 ms writer 场景分别为 -3.612 ms / +4.397 ms，满足相对基线 `+5 ms` 门槛。`full` 是诊断模式，metadata enqueue 的 CPU 仍可见，但不会等待 writer flush。`legacy-blocking` 即使只跑 1,000 frame，也已出现明显累计延迟和大幅 journal 增长。

### 100,000 delta 稳态

命令：

```bash
corepack pnpm tsx scripts/bench-codex-bridge-forward.ts \
  --modes=off,lifecycle --connections=1 --frames=100000 \
  --delta-bytes=64 --no-slow-writer
```

| 模式 | p50 / p95 / p99 (ms) | RSS / heapUsed | retained session / frame task / ingress | delta bytes |
| --- | ---: | ---: | ---: | ---: |
| `off` | 387.357 / 596.038 / 615.507 | 350.9 / 118.0 MiB | 0 / 0 / 0 | 0 |
| `lifecycle` | 376.824 / 581.637 / 602.288 | 348.3 / 117.6 MiB | 0 / 0 / 0 | 0 |

100,000 delta 后，`lifecycle` 相对 off 没有额外 retained heap，bridge 内没有对应数量的 session record、frame Promise task、canonical ingress、envelope、observation 或索引。

### Writer failure

4 个连接、每连接 1,000 delta，先注入一个 lifecycle write failure：4,000/4,000 frame 全部到达，p95 63.227 ms，`journal_failures_total=1`，`frameTasks=0`，上下游保持连接，delta journal bytes 为 0。

## 验收边界

- 本次未重启或接管当前 4510、8022、app-server 等运行服务。
- 未运行浏览器、Playwright、Chrome、UI 自动化。
- 未部署，未访问或修改真实 Feishu/Lark 账号，未发送真实消息；跨组件测试全部使用 loopback fake app-server 和 fake Feishu API。
- 未删除、压缩、迁移或覆盖任何现有 bridge/provider journal。
- 未做真实 4510 canary，因此 `<300 MiB` 的生产 sidecar 稳态 RSS 仍需在用户授权部署/重启后验证；独立 benchmark 的 RSS 包含 tsx、fake upstream/downstream、100k timestamp/latency fixture，不能等同于生产 sidecar RSS。

