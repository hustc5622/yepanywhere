# Claude Code 共享 Session 直存方案：现状、修改计划与测试流程

> 状态：已按最小 shared 方案实施；实机核查日期：2026-07-16；当前目标环境：macOS Yep Anywhere + UTM Ubuntu VM + Claude Code 2.1.202。VM 使用 `~/.claude/projects -> /mnt/utm/claude/projects` 软链接，Yep 在 macOS 侧直接扫描同一份 JSONL；未采用二次 bindfs 或逐 turn SSH replica。

## 1. 结论摘要

当前 macOS 目录 `/Users/yueyuan/Desktop/file/UTM` 已经通过 UTM VirtFS/9p 共享给 VM，并在 VM 中以 `/mnt/utm` 提供可写访问。两侧同名文件的 SHA-256 已实测一致，因此可以让 VM 中的 Claude Code 直接把 session JSONL 写入这块共享存储，Yep 在 macOS 侧直接读取，不再在每个 turn 结束后通过 SSH `cat` 拉取完整 JSONL。

但不应通过下面的方式实现：

```bash
CLAUDE_CONFIG_DIR=/mnt/utm/claude
```

Claude Code 2.1.202 没有仅覆盖 session/projects 目录的官方环境变量。`CLAUDE_CONFIG_DIR` 会整体迁移 settings、credentials、session history 和 plugins。VM 当前使用 `/home/yueyuan/.claude/.credentials.json` 保存登录凭据；把整个配置目录迁入共享盘，要么导致现有登录不可见，要么迫使凭据也进入 macOS 可见的共享目录，违背“认证只留在 VM”的边界。

推荐方案是：

1. 保持 VM 的 `CLAUDE_CONFIG_DIR` 未设置，凭据和 settings 继续留在 `/home/yueyuan/.claude`。
2. 以 `/mnt/utm/claude/projects` 为 bind mount source、以 `/home/yueyuan/.claude/projects` 为 mount point；如果无法使用 bind mount，再考虑让后者指向前者的 symlink。
3. Yep 在 macOS 侧直接扫描 `/Users/yueyuan/Desktop/file/UTM/claude/projects`。
4. Yep 读取 JSONL 时使用 executor 的 `remoteRoot -> localRoot` 映射，把 JSONL 内的远端 `cwd` 映射为 macOS 项目路径，不改写原始 JSONL。
5. shared 模式下禁用 SSH JSONL 拉取；保留 `ssh-replica` 作为兼容回退，并修复其 UTF-8 分块解码问题。

## 2. 目标与非目标

### 2.1 目标

- VM 中的 Claude Code CLI、认证、工具和 shell 继续在 VM 内运行。
- Claude session JSONL 由 Claude Code 直接写入共享目录。
- macOS 上的 Yep 直接读取同一份 JSONL，不维护第二份 cwd-rewritten replica。
- session 新建、实时展示、resume、历史消息编辑、附件和进程监督保持可用。
- 不把 VM 的 Claude OAuth/API 凭据复制到共享目录。
- SSH 仍用于启动 Claude CLI 和控制其 stdio 协议，但不再用于逐 turn 传输完整 JSONL。
- 保留旧的 SSH replica 模式，便于未配置共享 session 存储的 executor 使用和快速回滚。

### 2.2 非目标

- 不恢复 macOS 本地 Claude CLI。
- 不恢复 `claude-ollama`。
- 不把整个 `/home/yueyuan/.claude` 同步到 macOS。
- 不在本阶段解决所有多 VM、多用户、跨平台共享文件系统组合。
- 不在静态或单元测试阶段发起真实 Claude 模型请求。

## 3. 实机现状

### 3.1 macOS 侧

已确认：

```text
/Users/yueyuan/Desktop/file/UTM
├── README.md
├── claude/          # 当前为空
└── utm-ssh.sh
```

目录元数据：

```text
owner: yueyuan
uid:   503
gid:   20 (staff)
mode:  0755
```

当前 Yep Anywhere 仓库位于：

```text
/Users/yueyuan/Desktop/work/before_work/yepanywhere
```

它不在共享根 `/Users/yueyuan/Desktop/file/UTM` 之下，因此当前 checkout 不能直接作为 remote executor 项目。真正的远程 Claude smoke test 需要先在共享根下准备一个项目，例如：

```text
/Users/yueyuan/Desktop/file/UTM/projects/yepanywhere
```

### 3.2 UTM 配置与 VM 挂载

UTM 配置已确认：

```text
DirectoryShareMode:     VirtFS
DirectoryShareReadOnly: false
```

VM 当前有两层挂载：

```text
share (9p, rw)
  -> /mnt/utm-raw
  -> bindfs
  -> /mnt/utm
```

`/etc/fstab` 已存在持久化配置：

```fstab
share /mnt/utm-raw 9p trans=virtio,version=9p2000.L,rw,access=any,_netdev,nofail,auto 0 0
/mnt/utm-raw /mnt/utm fuse.bindfs force-user=yueyuan,force-group=yueyuan,perms=a+rwX,create-as-mounter,create-with-perms=a+rwX,chown-ignore,chgrp-ignore,allow_other,_netdev,nofail,x-systemd.requires-mounts-for=/mnt/utm-raw 0 0
```

这意味着旧文档中“共享目录尚未写入 `/etc/fstab`”的描述已经过时。

VM 中的实际权限：

```text
/mnt/utm         0777 yueyuan:yueyuan
/mnt/utm/claude  0777 yueyuan:yueyuan
```

`yueyuan` 用户对 `/mnt/utm/claude` 的 read/write/execute 检查已经通过。

### 3.3 共享一致性证据

macOS 与 VM 两侧 `README.md` 的 SHA-256 均为：

```text
ff69bad95a953b6fb917ebbb30da543ebf58dcb553baa2cb47d0016f320edd3a
```

对应路径：

```text
macOS: /Users/yueyuan/Desktop/file/UTM/README.md
VM:    /mnt/utm/README.md
```

因此当前 `/mnt/utm` 确实映射到了目标 macOS 目录，而不是另一块同名目录。

### 3.4 VM Claude Code 状态

已确认：

```text
CLI:      /home/yueyuan/.local/bin/claude
resolved: /home/yueyuan/.local/share/claude/versions/2.1.202
version:  2.1.202 (Claude Code)
```

当前未设置：

```text
CLAUDE_CONFIG_DIR
CLAUDE_SESSIONS_DIR
```

当前配置目录：

```text
/home/yueyuan/.claude
├── .credentials.json   # 0600，仅记录元数据，未读取内容
├── settings.json
├── projects/
├── sessions/
├── backups/
└── downloads/
```

当前 session JSONL 位于：

```text
/home/yueyuan/.claude/projects/-home-yueyuan/<session-id>.jsonl
```

现有 JSONL 顶层 `cwd` 为 `/home/yueyuan`，说明 Claude Code 会把 VM 看到的 cwd 原样写入 session 文件。

### 3.5 Claude Code 可配置性结论

对 VM 中 2.1.202 CLI 的帮助信息和二进制环境变量字符串做了精确检查，只发现：

```text
CLAUDE_CONFIG_DIR
```

没有发现：

```text
CLAUDE_SESSIONS_DIR
CLAUDE_PROJECTS_DIR
```

官方文档同样说明：

- [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars) 覆盖整个配置目录。
- settings、credentials、session history 和 plugins 都位于该目录下。
- Linux 在设置 `CLAUDE_CONFIG_DIR` 后，[`.credentials.json` 也会迁入该目录](https://code.claude.com/docs/en/team)。
- transcript 是明文数据，可能包含工具读取到的敏感内容，依赖文件权限保护，见 [`.claude` 目录说明](https://code.claude.com/docs/en/claude-directory)。

结论：Claude CLI 没有官方的“只改变 projects/session 根目录”配置；需要通过文件系统 bind mount 或 symlink 只重定向 `~/.claude/projects`。

## 4. 当前 Yep 实现及问题

### 4.1 当前数据流

当前 worktree 中的实现大致是：

```text
Claude Code in VM
  writes ~/.claude/projects/<remote-cwd>/<session>.jsonl
        │
        │ result message
        ▼
Yep server runs SSH `cat`
        │
        │ reads the whole JSONL into a JS string
        ▼
rewrite top-level cwd fields
        │
        ▼
atomic write into local ~/.claude/projects/<local-cwd>/<session>.jsonl
```

涉及的主要入口：

- `packages/server/src/sdk/providers/claude.ts`
- `packages/server/src/sdk/remote-spawn.ts`
- `packages/server/src/sdk/session-sync.ts`
- `packages/server/src/projects/scanner.ts`
- `packages/server/src/config.ts`

### 4.2 SSH 流式读取的数据完整性问题

`runRemoteCommand()` 当前对每个 stdout/stderr `Buffer` 分块单独调用 `.toString()`。Node stream 的分块边界不保证落在 UTF-8 字符边界；中文等多字节字符跨分块时会变成替换字符。

实测把 `汉` 的 UTF-8 Buffer 拆成两个 chunk，逐块 `.toString()` 后得到：

```text
���
```

这会污染本地 replica，严重时使 JSONL 行无法解析。

即使改为 shared 直存模式，仍建议修复这条 fallback 路径：

- 使用 `StringDecoder` 分别解码 stdout/stderr；或
- 累计 `Buffer[]`，按字节计数限制大小，最后统一 `Buffer.concat(...).toString("utf8")`；
- 不要对 session 原始内容无条件 `trim()`；
- 增加跨 chunk 多字节字符回归测试。

### 4.3 直接共享后仍存在 cwd 映射问题

假设项目映射为：

```text
macOS: /Users/yueyuan/Desktop/file/UTM/projects/demo
VM:    /mnt/utm/projects/demo
```

Claude JSONL 会记录：

```json
{"cwd":"/mnt/utm/projects/demo"}
```

当前 `ProjectScanner` 会直接把这个 cwd 当成 macOS 项目路径。结果可能是：

- 项目显示为 `/mnt/utm/projects/demo`；
- macOS 上该路径不存在；
- new session / resume 的项目恢复逻辑失败；
- 同一个项目可能以 local/remote 两个路径重复出现。

因此不能只把 JSONL 放进共享目录，还必须把 cwd 的逻辑映射从“修改文件内容”改成“读取时映射”。

### 4.4 当前 bindfs 权限不适合 transcript

当前 bindfs 使用：

```text
perms=a+rwX
create-with-perms=a+rwX
allow_other
```

这会让 VM 视角下的目录为 0777、文件为 0666，并可能让 VM 新建的 transcript 在 macOS 原始目录中也具有过宽权限。Claude JSONL 是明文，可能包含源码、命令输出、路径和被工具读取到的秘密，因此正式迁移前必须为 session 目录建立更严格的权限策略。

建议至少满足：

```text
directory: 0700 或 0750
JSONL:      0600 或 0640
```

不要为了让 VM 可写而对整个 session 根使用 `a+rwX`。

### 4.5 共享文件系统事件仍需验证

目前只验证了挂载、读取、路径对应和权限检查；尚未从 VM 创建真实临时文件，因此以下行为仍需在迁移前测试：

- VM 写入后 macOS 是否立即可见；
- append、fsync、rename 是否保持内容和 mtime；
- macOS `fs.watch` / Yep `FileWatcher` 是否收到由 VM 通过 9p 写入产生的事件；
- 中文和大于典型 pipe/page 大小的内容是否保持字节一致；
- Claude Code 以 0600 创建 JSONL 时，macOS 最终权限是否符合预期。

## 5. 目标架构

### 5.1 文件系统布局

推荐布局：

```text
macOS
/Users/yueyuan/Desktop/file/UTM/
├── projects/
│   └── <project>/
└── claude/
    └── projects/
        └── -mnt-utm-projects-<project>/
            └── <session-id>.jsonl

VM
/mnt/utm/
├── projects/
│   └── <project>/
└── claude/
    └── projects/
        └── -mnt-utm-projects-<project>/
            └── <session-id>.jsonl

/mnt/utm/claude/projects
    bind-mounted on /home/yueyuan/.claude/projects
```

保留在 VM 私有文件系统：

```text
/home/yueyuan/.claude/.credentials.json
/home/yueyuan/.claude/settings.json
/home/yueyuan/.claude/plugins/
/home/yueyuan/.claude/backups/
```

### 5.2 运行时数据流

```text
Yep client
   │ REST / WebSocket
   ▼
Yep server on macOS
   │ Agent SDK stream-json over SSH stdio
   ▼
Claude CLI in VM
   │ appends JSONL through ~/.claude/projects bind mount
   ▼
Shared VirtFS/9p directory
   │ one authoritative shared file, exposed through two paths
   ▼
Yep scanner/reader on macOS
   │ maps remote cwd -> local cwd in memory
   ▼
UI/session index
```

shared 模式下不再存在：

- SSH `cat` JSONL；
- 每 turn 复制完整文件；
- 本地 cwd-rewritten replica；
- replica 与 VM 权威副本之间的覆盖竞争。

### 5.3 建议的配置模型

为了保持兼容并让模式显式，建议给每个 executor 增加 session storage 配置，而不是依赖一个隐式全局环境变量：

```ts
interface RemoteSessionStorageConfig {
  mode: "shared" | "ssh-replica";
  /** macOS/Yep 看到的 Claude projects 根目录 */
  localProjectsDir?: string;
  /** VM 中 Claude projects 根目录 */
  remoteProjectsDir?: string;
}

interface RemoteExecutorConfig {
  host: string;
  user?: string;
  port?: number;
  localRoot: string;
  remoteRoot: string;
  claudePath?: string;
  remoteClaudeConfigDir?: string;
  sessionStorage?: RemoteSessionStorageConfig;
}
```

当前环境的建议值：

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

验证规则建议：

- `mode=shared` 时两个 projects dir 都必须存在且为绝对路径。
- `localProjectsDir` 必须位于 `localRoot` 下。
- `remoteProjectsDir` 必须位于 `remoteRoot` 下。
- `translateSharedPath(localProjectsDir)` 必须等于 `remoteProjectsDir`，防止误配到不同物理目录。
- 不允许 shared projects dir 与项目工作目录本身重叠。
- 多 executor 使用同一个 local projects dir 时必须显式拒绝，除非确认它们共享同一权威 session store。
- `ssh-replica` 保持当前行为，但继续使用 `remoteSessionsDir` 兼容旧配置。

`remoteClaudeConfigDir` 不应用来实现 session-only 共享。它只适合用户明确希望迁移整套 Claude profile 的高级场景，UI 中应增加风险说明。

## 6. 后续修改计划

### 阶段 A：先完成 VM 文件系统准备

前提：确认当前没有活跃 Claude Code session，避免迁移时有进程继续向旧目录追加。

1. 为 `/mnt/utm/claude/projects` 建立专用、安全的可写权限映射。
2. 保留 `/home/yueyuan/.claude/.credentials.json` 和 settings 原位。
3. 备份当前 `/home/yueyuan/.claude/projects`。
4. 把现有 projects 内容复制到共享 projects 目录。
5. 用 bind mount 把共享 projects 目录挂载到 `/home/yueyuan/.claude/projects`。
6. bind mount 验证通过后再决定是否删除旧备份。
7. 把专用挂载写入 `/etc/fstab`，但保留可回滚路径。

优先使用 bind mount，而不是 symlink：

- 对 Claude CLI 来说路径仍是标准的 `~/.claude/projects`；
- 更容易通过 `findmnt` 验证真实来源；
- 可在 fstab 中明确管理依赖和权限；
- 减少某些工具拒绝跟随 symlink 的兼容风险。

### 阶段 B：增加共享存储配置与校验

预计修改：

| 文件 | 修改内容 |
| --- | --- |
| `packages/shared/src/types.ts` | 增加 `RemoteSessionStorageConfig` 和 executor 字段 |
| `packages/shared/src/index.ts` | 导出新类型 |
| `packages/server/src/sdk/remote-executor-config.ts` | 解析、规范化、校验 shared/replica 配置 |
| `packages/server/src/services/ServerSettingsService.ts` | 迁移旧 executor 配置并保持向后兼容 |
| `packages/server/src/routes/settings.ts` | API 接受和返回 session storage 配置 |
| `packages/client/src/pages/settings/RemoteExecutorsSettings.tsx` | 增加 storage mode 及 local/remote projects dir 表单 |
| `packages/client/src/hooks/useRemoteExecutors.ts` | 保持新配置的读写类型 |
| `packages/client/src/i18n/*.json` | 新字段、校验错误和风险说明 |

兼容策略：

- 没有 `sessionStorage` 的旧配置按 `ssh-replica` 处理。
- 已存在的 `remoteSessionsDir` 继续作为 replica 模式远端来源。
- 不在迁移时自动设置或复制 `remoteClaudeConfigDir`。

### 阶段 C：把 cwd 转换改为读取时映射

新增一个集中式路径映射模块，避免 scanner、resume 和 provider 各自实现不同规则：

```ts
mapLocalPathToRemote(localPath, executor): string
mapRemotePathToLocal(remotePath, executor): string
```

要求：

- 使用路径组件边界，而不是简单字符串前缀。
- local 使用宿主平台 path 语义，remote 使用 POSIX path 语义。
- 拒绝 `..`、root 外路径和绝对 suffix。
- 多个 remoteRoot 匹配时优先使用 session metadata 中保存的 executor。
- metadata 缺失时只能使用唯一、最长且无歧义的 root 匹配；否则返回明确错误。

需要审查和修改所有直接读取 Claude JSONL cwd 的路径，至少包括：

- `packages/server/src/projects/scanner.ts`
- `packages/server/src/projects/paths.ts`
- resume/start cwd recovery
- session/project index 构建
- 任何依据 JSONL cwd 计算 project ID 的代码

原则：

- 物理 JSONL 保持 Claude 原始内容，不改写。
- API/UI 中的项目 cwd 使用 macOS local path。
- 工具 payload 和消息文本中的 VM 路径保持原样；只有具有明确语义的 cwd/project path 做映射。

### 阶段 D：让 Claude provider 支持 shared 模式

修改 `packages/server/src/sdk/providers/claude.ts`：

1. 启动前验证项目 localRoot/remoteRoot 映射。
2. shared 模式额外验证：
   - local projects dir 存在且可读；
   - remote projects dir 存在且可写；
   - VM 的 `/home/yueyuan/.claude/projects` 实际挂载到配置的 remote projects dir；
   - 不设置 `CLAUDE_CONFIG_DIR`。
3. 收到 `result` 后不调用 `syncRemoteSessionFile()`。
4. 在一个短暂、可配置的等待窗口内确认 local JSONL 已可见，避免 9p 可见性延迟。
5. 显式通知 session index/scanner 文件已更新；不要只依赖文件系统 watcher。
6. 若共享文件在等待窗口内不可见，返回可观察的 warning，但不要自动回退并覆盖文件，除非配置明确允许。

shared 与 replica 必须走清晰的分支，避免同一个 turn 同时直写和复制。

### 阶段 E：调整 watcher、scanner 和索引

当前 FileWatcher 主要观察一个 Claude projects 根。shared 模式需要：

- 观察 `localProjectsDir`；
- VM append 产生事件时触发 session/index 更新；
- 即使 macOS 没收到 9p 写入事件，也有 result 后的显式 invalidation 或低频 rescan 兜底；
- 处理 JSONL 正在 append 时的部分末行；
- 不把 partial JSON 当作永久损坏；下一次事件/扫描应能恢复。

如果第一阶段只支持一个 shared executor，可以暂时通过 Yep server 已有的进程环境变量指定：

```bash
CLAUDE_SESSIONS_DIR=/Users/yueyuan/Desktop/file/UTM/claude/projects
```

这里的 `CLAUDE_SESSIONS_DIR` 只控制 macOS 上 Yep 的扫描根，不是 Claude Code CLI 支持的环境变量，也不得转发给 VM 中的 Claude CLI。

但最终建议让 scanner 接受多个命名 session source，而不是依赖进程级单目录环境变量：

```ts
interface ClaudeSessionSource {
  id: string;
  projectsDir: string;
  executorHost?: string;
  pathMapping?: {
    localRoot: string;
    remoteRoot: string;
  };
}
```

这样多 executor 可以拥有独立 session 根，并在扫描时保留来源信息。

### 阶段 F：修复并保留 SSH replica fallback

即使 shared 模式成为当前 UTM 默认，仍要修复 replica 模式：

- UTF-8 流式解码正确性；
- stdout/stderr 独立字节计数；
- 避免每个 chunk 对累计字符串执行 `Buffer.byteLength()` 导致 O(n²)；
- session 内容不做无条件 trim；
- 超限时终止并清理 SSH child；
- 增加中文、emoji、跨 chunk JSONL、超限和 timeout 测试。

### 阶段 G：设置页、文档和迁移提示

设置页需要明确区分：

- `Shared directory`：Claude 直接写共享 JSONL；
- `SSH replica`：Yep 在 turn 后通过 SSH 复制 JSONL。

shared 模式的 Test Connection 应显示：

- SSH 连接；
- Claude CLI 版本；
- project shared root 可写；
- remote projects dir 可写；
- local projects dir 可读；
- 两侧目录映射一致；
- credential 目录未落入共享根；
- 权限是否过宽。

同时更新：

- `docs/project/remote-executors.md`
- 当前 UTM fstab 状态
- shared storage 安全边界
- rollback 步骤
- 真正模型 smoke test 的成本和前置条件

## 7. 修改后的测试流程

测试按风险从低到高分层。任何一层失败都先停止，不进入下一层。

### 7.1 第 0 层：迁移前基线与备份

目的：确认路径、版本、挂载和当前 session 数量，留下可回滚基线。

macOS：

```bash
ls -la /Users/yueyuan/Desktop/file/UTM
stat -f '%N %Sp %u:%g' /Users/yueyuan/Desktop/file/UTM/claude
shasum -a 256 /Users/yueyuan/Desktop/file/UTM/README.md
```

VM：

```bash
ssh -T -o BatchMode=yes yueyuan@192.168.64.4 'findmnt -T /mnt/utm'
ssh -T -o BatchMode=yes yueyuan@192.168.64.4 'findmnt -T /mnt/utm-raw'
ssh -T -o BatchMode=yes yueyuan@192.168.64.4 '/home/yueyuan/.local/bin/claude --version'
ssh -T -o BatchMode=yes yueyuan@192.168.64.4 'du -sh /home/yueyuan/.claude/projects'
ssh -T -o BatchMode=yes yueyuan@192.168.64.4 "stat -c '%n %a %U:%G' /home/yueyuan/.claude/.credentials.json"
```

验收：

- 共享目录和 CLI 均存在；
- 两侧 README hash 一致；
- credentials 仍是 VM 私有路径且权限为 0600；
- 已备份现有 `~/.claude/projects`。

### 7.2 第 1 层：共享文件系统语义测试，不调用 Claude

目的：验证 VM -> macOS 的真实写入、append、rename、Unicode、权限和删除行为。

测试文件应放在专用临时目录，例如：

```text
VM:    /mnt/utm/claude/.probe-<timestamp>/
macOS: /Users/yueyuan/Desktop/file/UTM/claude/.probe-<timestamp>/
```

测试内容：

1. VM 创建包含中文、emoji 和换行的文件。
2. macOS 读取并比较 SHA-256。
3. VM 追加超过 128 KiB 的内容，再比较 SHA-256。
4. VM 原子 rename，macOS 确认旧名消失、新名出现。
5. 检查两侧 owner/mode。
6. macOS 启动一个短时 `fs.watch` 探针，VM 再写一次，确认事件是否到达。
7. 删除测试目录，确认两侧均消失。

验收：

- 所有 hash 一致；
- 不出现 Unicode 替换字符；
- rename 可见；
- 文件最终权限不宽于约定；
- watcher 可靠，或已确认必须使用显式 invalidation/rescan 兜底。

### 7.3 第 2 层：路径映射单元测试

新增覆盖：

- local root 本身映射到 remote root；
- 多层项目路径映射；
- 空格、中文和 Unicode 文件名；
- `..` 越界拒绝；
- 相似前缀拒绝，例如 `/root-a` 不能匹配 `/root`；
- symlink/realpath 策略明确；
- Windows local path 与 POSIX remote path 的边界；
- remote cwd -> local cwd 逆映射；
- 多 executor remoteRoot 重叠和歧义；
- metadata 指定 executor 时选择正确映射。

建议新增或扩展：

```text
packages/server/test/sdk/remote-spawn.test.ts
packages/server/test/sdk/remote-executor-config.test.ts
packages/server/test/projects/scanner.test.ts
packages/server/test/projects/paths.test.ts
```

### 7.4 第 3 层：shared/replica provider 单元测试

shared 模式必须验证：

- `result` 后不会调用 `runRemoteCommand(... cat ...)`；
- local JSONL 已存在时直接完成；
- local JSONL 延迟出现时能在等待窗口内发现；
- 超时只产生明确 warning，不覆盖权威文件；
- 不向 remote CLI 设置共享目录形式的 `CLAUDE_CONFIG_DIR`；
- credentials 路径不会进入日志或 API；
- session metadata 仍记录 executor。

replica 模式必须验证：

- 中文字符跨 Buffer chunk 时保持原文；
- emoji/四字节 UTF-8 跨 chunk；
- trailing newline 保留；
- 128 MiB 限制按原始字节计算；
- timeout/超限后 child 被清理；
- cwd replica 改写只影响语义 cwd 字段。

### 7.5 第 4 层：静态检查与完整单元测试

按顺序运行：

```bash
pnpm lint
pnpm typecheck
pnpm --filter @yep-anywhere/server test -- \
  test/sdk/remote-executor-config.test.ts \
  test/sdk/remote-spawn.test.ts \
  test/sdk/session-sync.test.ts \
  test/sdk/providers/claude.test.ts \
  test/routes/settings.test.ts
pnpm test
```

验收：全部通过，且没有通过降低断言、跳过测试或吞错实现。

### 7.6 第 5 层：合成 JSONL 集成测试，不调用 Claude

在临时 shared projects 根生成合成 session：

```text
<temp>/claude/projects/-mnt-utm-projects-demo/<uuid>.jsonl
```

JSONL 中设置：

```json
{"type":"user","cwd":"/mnt/utm/projects/demo","sessionId":"<uuid>"}
```

然后验证：

- scanner 返回 macOS 路径 `/Users/yueyuan/Desktop/file/UTM/projects/demo`；
- project ID 按 local path 编码；
- session reader 能读出消息；
- resume cwd recovery 返回 local path；
- provider 启动时再把 local path 映射回 remote path；
- 原始 JSONL 内容没有被 Yep 重写；
- watcher/invalidation 后 project/session count 更新。

该层应使用临时目录和 mock executor，不依赖正在运行的 8022 服务。

### 7.7 第 6 层：隔离 profile 的 API 集成测试

不要直接重启或替换现有服务。使用独立 profile、data dir 和端口启动隔离实例：

```bash
PORT=<unused-port> \
YEP_ANYWHERE_PROFILE=claude-shared-test \
CLAUDE_SESSIONS_DIR=/Users/yueyuan/Desktop/file/UTM/claude/projects \
pnpm dev
```

验证 API：

- 保存 shared executor 配置；
- 读取后字段保持规范化；
- Test Connection 报告两侧 projects dir 就绪；
- provider discovery 显示 Claude 可用；
- 无歧义配置错误返回 400；
- runtime settings 更新后无需重建整个 server 对象；
- 不触碰正式 profile 的 settings 和 metadata。

如果只验证 API，可使用 HTTP/单元测试；浏览器自动化不是默认要求。

### 7.8 第 7 层：真实 Claude smoke test

此层会发起真实 Claude 请求并产生费用，只在前六层全部通过后执行。

前置条件：

- 在共享根下准备测试项目；
- VM 对项目和 session 目录可写；
- VM Claude CLI 已登录；
- 确认没有使用生产敏感项目；
- 明确记录测试 session ID。

建议用例：

1. 新建 Claude session，发送只读短提示。
2. 确认 VM 的 `~/.claude/projects` 与 macOS shared projects 指向同一权威共享文件，并比较路径、大小、mtime 和 SHA-256；不要求跨 9p 两侧的 inode 数值相同。
3. 验证 JSONL 在 macOS 侧无需复制即可读取。
4. 验证 Yep UI/API 把项目显示为 macOS local path。
5. 发送第二个 turn，确认 append 可见且消息不重复。
6. 断开客户端后等待 agent 完成，确认服务端保活。
7. resume 同一 session，确认仍由原 executor 运行。
8. 测试一个包含中文和 emoji 的 prompt。
9. 测试一个不在共享根内的附件，确认临时复制和 remote path 转换正常。
10. 如范围包含历史编辑，再测试 `resumeSessionAt`。

日志验收：

- 有 `claude_remote_spawn_start`；
- 没有 shared session 的 `ssh cat`/replica sync 事件；
- 没有 `claude_remote_session_sync_failed`；
- 有 shared file visible/index invalidation 的新事件；
- 不记录 credentials、token 或完整敏感 transcript。

磁盘验收：

- session JSONL 只存在一份权威共享文件；
- VM credentials 仍只在 `/home/yueyuan/.claude/.credentials.json`；
- `/Users/yueyuan/Desktop/file/UTM/claude` 下没有 `.credentials.json`；
- JSONL 权限满足安全策略；
- 本地不再生成 cwd-rewritten duplicate。

### 7.9 第 8 层：回归与长会话测试

真实 smoke 通过后再覆盖：

- 10+ turns 的持续 append；
- 大型 tool output；
- subagent/agent session 文件；
- interrupt 后 resume；
- SSH 临时断开；
- VM 重启后 fstab 自动挂载；
- macOS 重启/UTM 重启后的路径恢复；
- executor 配置移除再恢复；
- shared 模式与 replica 模式同时存在；
- session archive、search/index、star/unread count；
- 服务端运行期间更新 executor 设置。

浏览器/UI 自动化只有在明确要求时再执行；默认先使用单元测试、API 和文件系统检查。

## 8. 验收标准

实现完成必须同时满足：

- [ ] VM Claude CLI 不设置共享目录形式的 `CLAUDE_CONFIG_DIR`。
- [ ] VM credentials 没有进入共享目录。
- [ ] `~/.claude/projects` 的共享挂载在 VM 重启后自动恢复。
- [ ] VM 与 macOS 读取同一份 session JSONL。
- [ ] shared 模式不执行 SSH JSONL `cat`。
- [ ] JSONL remote cwd 在 API/UI 中映射为 local cwd。
- [ ] 原始 JSONL 不被 Yep 重写。
- [ ] new session、第二 turn、resume 全部工作。
- [ ] 中文和 emoji 内容字节完整。
- [ ] 文件权限不宽于约定。
- [ ] watcher 不可靠时有显式 invalidation/rescan 兜底。
- [ ] replica fallback 的 UTF-8 问题已修复。
- [ ] lint、typecheck、聚焦测试和完整测试全部通过。
- [ ] 真实 smoke test 日志中没有凭据泄露和 sync failure。

## 9. 回滚方案

任何真实 session 测试前都必须保留旧 `~/.claude/projects` 备份。

回滚顺序：

1. 确认没有活跃 Claude CLI 正在写 session。
2. 取消 `~/.claude/projects` 的 bind mount 或 symlink。
3. 恢复原 VM 私有 projects 目录。
4. 从 `/etc/fstab` 移除或禁用专用 projects 挂载项。
5. 把 executor 的 `sessionStorage.mode` 改回 `ssh-replica`。
6. 恢复 Yep 原来的 Claude sessions root。
7. 对共享期间产生的 session 做单向、安全合并，禁止旧副本覆盖较新的权威文件。
8. 重新运行一个只读 resume smoke test。

回滚不得删除共享 JSONL，直到确认 VM 私有目录已经包含所有较新的 session。

## 10. 仍需做出的实现决策

开始编码前建议明确以下选择：

1. **VM projects 重定向方式**：推荐 bind mount，symlink 只作 fallback。
2. **权限模型**：为 Claude projects 建独立 bindfs/mount，还是收紧整个 `/mnt/utm`。
3. **第一版范围**：只支持当前一个 UTM shared executor，还是同时实现多 source scanner。
4. **watcher 兜底**：result 后显式 invalidation、周期 rescan，或两者都用。
5. **shared 可见性超时**：建议短等待并 warning，不自动复制覆盖。
6. **旧 replica 的保留周期**：建议至少保留到 shared 模式完成真实长会话回归。
7. **session source 身份**：多 executor 时使用 host、稳定 UUID，还是显式配置名。

对当前单 VM 环境，推荐先完成：安全 projects bind mount、shared 配置、集中 cwd 映射、显式 invalidation、replica UTF-8 修复；多 executor session source 合并可以作为下一阶段。
