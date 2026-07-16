# Claude Code UTM 远程执行器

Yep Anywhere 的 Claude provider 只支持远程执行：Yep 服务和 Agent SDK 运行在 macOS，真正的 Claude Code CLI、登录凭据、工具和 shell 命令均运行在 UTM 虚拟机中。macOS 不会启动本地 Claude CLI，也不会把本机 `ANTHROPIC_API_KEY` 或 Claude 凭据转发给虚拟机。

本实现从删除前的 Claude provider 中恢复了 Agent SDK 的 `spawnClaudeCodeProcess` 扩展点，但没有恢复以下旧路径：

- macOS 本地 Claude CLI
- `claude-ollama`
- 假设两端绝对路径一致的 home 目录替换
- 双向 rsync 和恢复前的 local-to-remote 覆盖

## 架构

```text
Yep client
    │ REST / WebSocket
    ▼
Yep server on macOS
    │ Claude Agent SDK stream-json protocol
    ▼
spawnClaudeCodeProcess
    │ ssh -T (stdin/stdout pipes)
    ▼
Claude Code CLI in UTM
    │ appends ~/.claude/projects through a bind mount
    ▼
shared VirtFS/9p Claude projects directory
    │ the same authoritative JSONL is visible on macOS
    ▼
Yep scanner maps remote cwd to the local project path in memory
```

Agent SDK 只负责 stream-json 控制协议。spawn hook 会把 SDK 原本要执行的本地 bundled CLI 命令改写成远端 `claude`，同时保留模型、permission mode、tool approval、resume、steer、interrupt 和动态命令等能力。

## 执行器配置

在 Settings → Providers → Remote Executors 中配置：

| 字段 | 含义 |
| --- | --- |
| `host` | SSH hostname、IP 或 `~/.ssh/config` alias |
| `user` / `port` | 可选 SSH 用户和端口 |
| `localRoot` | macOS 看到的共享目录绝对路径 |
| `remoteRoot` | UTM 中同一目录的挂载点 |
| `claudePath` | 可选远端 Claude CLI 绝对路径 |
| `sessionStorage.mode` | `shared`（推荐）或兼容用的 `ssh-replica` |
| `sessionStorage.localProjectsDir` | shared 模式下 macOS 看到的 Claude projects 根目录 |
| `sessionStorage.remoteProjectsDir` | shared 模式下 VM 看到的同一 projects 根目录 |
| `remoteClaudeConfigDir` | 仅 replica 高级配置；shared 模式禁止设置 |
| `remoteSessionsDir` | replica 模式可选的远端 session 根目录 |

针对当前 UTM 环境，建议配置为：

```json
{
  "host": "192.168.64.4",
  "user": "yueyuan",
  "localRoot": "/Users/yueyuan/Desktop/file/UTM",
  "remoteRoot": "/mnt/utm",
  "claudePath": "/home/yueyuan/.local/bin/claude",
  "sessionStorage": {
    "mode": "shared",
    "localProjectsDir": "/Users/yueyuan/Desktop/file/UTM/claude/projects",
    "remoteProjectsDir": "/mnt/utm/claude/projects"
  }
}
```

VM 中应让 `/home/yueyuan/.claude/projects` bind mount（或兼容性 symlink）到 `/mnt/utm/claude/projects`。不要把整个 `CLAUDE_CONFIG_DIR` 放入共享盘，否则 `.credentials.json`、settings 和 plugins 也会进入 macOS 可见目录。

项目路径通过根目录映射转换。例如：

```text
macOS: /Users/yueyuan/Desktop/file/UTM/projects/yepanywhere
UTM:   /mnt/utm/projects/yepanywhere
```

任何不在 `localRoot` 下的项目都会被拒绝，避免 Claude 意外操作虚拟机中的另一份 checkout。

## 当前 UTM 前置条件

已确认：

- `ssh yueyuan@192.168.64.4` 可免交互连接
- Claude CLI 位于 `/home/yueyuan/.local/bin/claude`
- UTM Claude Code 版本为 `2.1.202`
- Yep 使用对应的 `@anthropic-ai/claude-agent-sdk@0.3.202`，其协议绑定版本同为 `2.1.202`
- UTM 使用 QEMU backend，并把 `/Users/yueyuan/Desktop/file/UTM` 作为 VirtFS/9p 导出，mount tag 为 `share`
- 原始 9p 共享已通过 `/etc/fstab` 持久挂载到 `/mnt/utm-raw`，再由 `bindfs` 映射到 Claude 使用的 `/mnt/utm`
- `mnt-utm.mount` 与 `mnt-utm\x2draw.mount` 均由 `remote-fs.target` 自动拉起，当前状态为 `active`
- 当前通用 `/mnt/utm` 视图对 VM 普通用户显示为目录 `777`、普通文件 `666`；正式启用 transcript 前必须为 `claude/projects` 建立更严格的专用权限映射
- 已验证 VM 创建的文件可立即在 macOS 读取，Mac 与 Linux 两侧 `README.md` 的 SHA-256 一致

当前仓库 `/Users/yueyuan/Desktop/work/before_work/yepanywhere` 不在导出的共享根目录下；后续交给 Claude 的项目应创建在 `/Users/yueyuan/Desktop/file/UTM` 下。

可以把项目移动或 clone 到 `/Users/yueyuan/Desktop/file/UTM/projects/yepanywhere`。若需在另一台同配置 VM 重建挂载，先准备依赖和挂载点：

```bash
sudo apt-get install -y bindfs
sudo mkdir -p /mnt/utm-raw /mnt/utm
```

另一种方案是修改 UTM 的共享目录，使其覆盖当前 checkout，再让 `localRoot` / `remoteRoot` 对应该共享根。不要用指向共享根外的 macOS symlink 规避映射；共享文件系统通常无法安全地跟随到导出目录之外。

当前 VM 的 `/etc/fstab` 使用以下两层挂载：

```fstab
share /mnt/utm-raw 9p trans=virtio,version=9p2000.L,rw,access=any,_netdev,nofail,auto 0 0
/mnt/utm-raw /mnt/utm fuse.bindfs force-user=yueyuan,force-group=yueyuan,perms=a+rwX,create-as-mounter,create-with-perms=a+rwX,chown-ignore,chgrp-ignore,allow_other,_netdev,nofail,x-systemd.requires-mounts-for=/mnt/utm-raw 0 0
```

单独使用 9p 的 `access=any` 仍会让 Linux 根据 macOS 文件的 UID/GID 和 mode 做本地权限检查，因此 macOS 新建的默认 `0644` 文件无法由 UID 1000 的 `yueyuan` 修改。`bindfs` 让 Claude 看到稳定的 guest owner 和读写权限，同时不把所有普通源码文件误标为可执行。现有 `allow_other` 配合 `a+rwX` 意味着 VM 内其他用户也能读写该视图，不能直接作为正式 transcript 权限模型。shared storage 的本地 projects 目录必须为 `0700` 或 `0750`，JSONL 应为 `0600` 或 `0640`。

可用以下命令做非干扰式检查：

```bash
systemctl is-active 'mnt-utm\x2draw.mount'
systemctl is-active mnt-utm.mount
findmnt -T /mnt/utm-raw
findmnt -T /mnt/utm
test -r /mnt/utm && test -w /mnt/utm
```

## 会话与同步

- 新会话必须选择一个已配置的 SSH 执行器。
- session metadata 记录 executor host，resume 时继续使用同一配置。
- shared 模式中 VM 与 macOS 读取同一份权威 `~/.claude/projects/.../*.jsonl`，不再维护第二份副本。
- 每个 turn 返回 `result` 后，Yep 只在短等待窗口内确认共享 JSONL 已可见，并显式触发 scanner/index invalidation；不会执行 SSH `cat`，也不会自动回退覆盖共享文件。
- JSONL 保留 Claude 写入的远端 `cwd`。scanner/resume 在读取有明确路径语义的 cwd 时执行 `remoteRoot -> localRoot` 映射，消息文本和 tool payload 保持原样。
- 未配置 `sessionStorage` 的旧 executor，以及显式 `ssh-replica` 模式，仍会在 turn 后通过 SSH 拉取 JSONL；该 fallback 使用按字节限制的 UTF-8 安全解码，并保留原始尾部换行。
- resume 前不会再把本地副本推回虚拟机，从而避免旧副本覆盖远端真实历史。
- 当前不开放 Claude session clone：现有 clone 工具只会生成本地 JSONL，无法作为 UTM 中的权威 session 恢复。历史消息编辑仍通过远端 Claude 的 `resumeSessionAt` 完成。

上传附件若不在共享根内，会先复制到 `localRoot/.yep-anywhere/remote-uploads/`，再把映射后的 UTM 路径交给 Claude。

## 安全边界

- SSH 使用 argv 调用，不经过本地 shell；host、user、port 和路径均经过校验。
- SSH 强制 `BatchMode=yes`，不会卡在密码输入。
- host 前使用 `--`，拒绝以 `-` 开头或含 shell 元字符的目标。
- 远端命令的路径与参数使用 POSIX shell quoting。
- 只向 UTM 传递 Agent SDK 控制协议所需的非敏感环境变量。
- UTM 自己的 Claude 登录和配置是唯一认证来源。
- shared 模式的配置校验要求两侧 projects 目录经 root 映射后完全一致，并拒绝共享 `CLAUDE_CONFIG_DIR`、重复声明同一个本地 projects store 或 root 外路径。

## 非干扰式检查

以下检查不会启动 Yep 服务或发起 Claude 模型请求：

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=5 yueyuan@192.168.64.4 true
ssh -T yueyuan@192.168.64.4 "bash -lc '/home/yueyuan/.local/bin/claude --version'"
ssh -T yueyuan@192.168.64.4 "test -r /mnt/utm && test -w /mnt/utm"
ssh -T yueyuan@192.168.64.4 'test "$HOME/.claude/projects" -ef /mnt/utm/claude/projects'
```

设置页的 Test Connection 还会检查本地/远端 projects 目录、`~/.claude/projects` 是否指向共享 store、凭据目录是否留在共享根外，以及本地目录权限是否不宽于 `0750`。真正的端到端验证应在共享目录挂载并放入项目后，再创建一条 Claude session；这会实际调用 Claude，因此不属于默认静态检查。
