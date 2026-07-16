# Claude SSH 启动延迟日志

Claude SSH 会话的启动日志通过 `startupId` 串联。同一次创建或恢复请求会出现以下
事件；Agent SDK 的惰性启动阶段可能有少量交错：

| 事件 | 含义 |
| --- | --- |
| `provider_session_start_requested` | Yep 收到会话启动请求 |
| `claude_remote_preflight_start` / `complete` | SSH、Claude CLI、共享目录和 session 存储检查 |
| `claude_remote_cwd_check_complete` | 远端项目目录读写检查 |
| `claude_remote_initial_prompt_queued` | 初始提示词进入 Yep 的 provider 队列 |
| `claude_remote_sdk_query_create_start` / `created` | 创建 Agent SDK query |
| `provider_session_handle_created` | provider 已返回可监督的 session handle |
| `provider_first_message_wait_started` | Yep 开始等待 provider 首条消息 |
| `claude_remote_spawn_start` | Agent SDK 请求启动远端 Claude CLI |
| `claude_remote_ssh_process_spawned` | 本地 SSH 子进程已创建 |
| `claude_remote_prompt_handed_to_sdk` | 提示词已从 Yep 队列交给 Agent SDK |
| `claude_remote_first_stdout` | SSH 上的 Claude CLI 首次输出 stream-json 数据 |
| `provider_first_message_received` | Yep 收到首条 provider 消息，通常是 SDK `init` |
| `session_id_received` | SDK `init` 提供真实 session id |
| `provider_first_output_received` | Yep 收到首条 assistant/streaming 输出 |

如果远端 CLI 在 10 秒、30 秒或 120 秒后仍未产生 stdout，会记录
`claude_remote_startup_stalled`。其中 `phase=awaiting_claude_stdout` 表示 SSH
进程已经创建，延迟位于后续 SSH remote exec 或远端 Claude CLI 初始化阶段，
而不是 Yep 路由、队列或 WebSocket。

日志只记录 UUID、路径、阶段、耗时和字节数，不记录提示词或 stdout 内容。
排查时先按 `startupId` 过滤 `~/.yep-anywhere/logs/server-launchd.out.log` 或
配置的 server log：

```bash
rg -n -C 3 '<startupId>|claude_remote_startup_stalled' ~/.yep-anywhere/logs/server-launchd.out.log
```

当 `claude_remote_prompt_handed_to_sdk` 很快、但
`claude_remote_first_stdout` 很慢时，应在远端手动测量仓库初始化所依赖的命令。
共享挂载上的 `git status` 可能非常慢，因此不会由 Yep 自动执行，避免诊断日志
反过来加重启动延迟：

```bash
/usr/bin/time -f 'elapsed=%e' git -C <remote-project-path> status --porcelain=v1 -uno
```

如果远端项目经过 `bindfs` 等叠加挂载，还应对底层挂载执行同一测量。底层路径
因为 UID/GID 不同而触发 Git `dubious ownership` 时，可以只为这一次命令使用
`-c safe.directory=<path>`，无需修改全局 Git 配置：

```bash
/usr/bin/time -f 'elapsed=%e' git -c safe.directory=<raw-project-path> \
  -C <raw-project-path> status --porcelain=v1 -uno
```

如果底层挂载明显更快，修复方向是消除叠加挂载的 metadata 开销，并同时正确处理
远端用户的 UID/GID、读写权限和 Git `safe.directory`；不要只替换 `remoteRoot`。
