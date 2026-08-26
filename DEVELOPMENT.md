# 开发指南

## 环境准备

```bash
git clone https://github.com/kzahel/yepanywhere.git
cd yepanywhere
pnpm install
pnpm dev
```

然后在浏览器打开 http://localhost:3400。

如果只需要主应用，不想安装 relay workspace，可以使用：

```bash
pnpm setup:core
pnpm dev
```

## 常用命令

```bash
pnpm setup:core # 只安装 root + client + server + shared，跳过 relay
pnpm dev        # 启动开发服务器
pnpm lint       # 运行 Biome linter
pnpm typecheck  # 运行 TypeScript 类型检查
pnpm test       # 运行单元测试
pnpm test:e2e   # 运行 E2E 测试
```

## 8022 热重载

本机 `8022` 可以用开发热重载模式原地接管，同时保留 `4510`
Codex bridge sidecar，不会断开已有 `codex --remote ws://127.0.0.1:4510`
会话：

```bash
pnpm dev:8022:replace
```

这个命令会：

- 使用 `PORT=8022`、`BASE_PATH=/yep`、`VITE_PORT=8024`
- 强制 `YEP_CODEX_BRIDGE_MODE=external`，指向 `http://127.0.0.1:4510`
- 启用前端 Vite HMR 和后端 `tsx watch`
- 只停止当前 `8022` web/API listener；如果发现 `4510` 被 `8022`
  进程内嵌持有，会拒绝启动
- 如果当前 Yep 主进程有 active managed work，会拒绝替换；确实要中断它们时再加
  `--allow-yep-session-interrupt`

只做检查、不启动或停止任何进程：

```bash
pnpm dev:8022 -- --check
```

## 端口配置

端口都从同一个 `PORT` 变量推导出来，默认值是 `3400`：

| 端口 | 用途 |
|------|------|
| PORT + 0 | 主服务器 |
| PORT + 1 | 维护服务器 |
| PORT + 2 | Vite 开发服务器 |

```bash
PORT=4000 pnpm dev  # 使用 4000、4001、4002
```

## 数据目录

服务端状态默认保存在 `~/.yep-anywhere/`：

- `logs/`：服务器日志
- `indexes/`：会话索引缓存
- `uploads/`：上传文件
- `session-metadata.json`：自定义标题、归档/置顶状态

### 同时运行多个实例

可以使用 profile 同时运行开发和生产实例：

```bash
# 生产实例（默认 profile，端口 3400）
PORT=3400 pnpm start

# 开发实例（dev profile，端口 4000）
PORT=4000 YEP_ANYWHERE_PROFILE=dev pnpm dev
```

环境变量：

- `YEP_ANYWHERE_PROFILE`：profile 名称后缀，会创建 `~/.yep-anywhere-{profile}/`
- `YEP_ANYWHERE_DATA_DIR`：完整的数据目录覆盖路径

## 服务器日志

日志写入 `{dataDir}/logs/server.log`。实时查看：

```bash
tail -f ~/.yep-anywhere/logs/server.log
```

环境变量：

- `LOG_LEVEL`：最低日志级别，可选 `fatal`、`error`、`warn`、`info`、`debug`、`trace`，默认 `info`
- `LOG_TO_FILE`：设为 `"true"` 时启用文件日志，默认关闭
- `LOG_PRETTY`：设为 `"false"` 时关闭控制台美化输出，默认开启

## 维护服务器

当主服务器无响应时，`PORT + 1` 上会运行一个轻量 HTTP 维护服务器，用于诊断：

```bash
curl http://localhost:3401/status          # 查看服务器状态
curl -X POST http://localhost:3401/reload  # 重启服务器
```
