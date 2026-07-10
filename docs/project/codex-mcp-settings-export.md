# Codex MCP 设置导出

生成日期：2026-07-09

来源：
- 用户级 Codex 配置：`~/.codex/config.toml`
- 当前仓库没有项目级 `.codex/config.toml`
- `codex mcp list` 当前启用：`chrome-devtools`、`computer-use`、`node_repl`、`feishu-mcp`

## 给别人使用的参考配置

把下面内容按需合并到使用者自己的 `~/.codex/config.toml`。其中带 `YOUR_...` 的值必须替换；带“我们自己的信息”的注释不能直接照抄。

```toml
# 通用 Chrome DevTools MCP：可复制。
[mcp_servers.chrome-devtools]
command = "npx"
args = ["-y", "chrome-devtools-mcp@latest"]

# 这些 approve 是我们的便利设置：仅在信任本机浏览器操作和 MCP server 时保留。
[mcp_servers.chrome-devtools.tools.click]
approval_mode = "approve"

[mcp_servers.chrome-devtools.tools.close_page]
approval_mode = "approve"

[mcp_servers.chrome-devtools.tools.evaluate_script]
approval_mode = "approve"

[mcp_servers.chrome-devtools.tools.navigate_page]
approval_mode = "approve"

[mcp_servers.chrome-devtools.tools.new_page]
approval_mode = "approve"

[mcp_servers.chrome-devtools.tools.take_screenshot]
approval_mode = "approve"

[mcp_servers.chrome-devtools.tools.take_snapshot]
approval_mode = "approve"

# 飞书 MCP：URL 是我们自己的信息，别人必须替换成自己的 MCP 网关和账号标识。
[mcp_servers.feishu-mcp]
url = "https://YOUR_MCP_GATEWAY_DOMAIN/mcp?openId=YOUR_FEISHU_OPEN_ID"

# 这些 approve 是我们的便利设置：只有在信任该 Feishu MCP 网关、鉴权和工具权限后再保留。
[mcp_servers.feishu-mcp.tools.create-doc]
approval_mode = "approve"

[mcp_servers.feishu-mcp.tools.enable-tools]
approval_mode = "approve"

[mcp_servers.feishu-mcp.tools.fetch-doc]
approval_mode = "approve"

[mcp_servers.feishu-mcp.tools.update-doc]
approval_mode = "approve"

[mcp_servers.feishu-mcp.tools.oauth-status]
approval_mode = "approve"

[mcp_servers.feishu-mcp.tools.list-folder]
approval_mode = "approve"

# Codex 插件提供的能力：这些通常由 Codex App/插件管理。
# 如果对方没有安装对应插件或版本不同，不要手工复制内部 MCP 路径。
[plugins."computer-use@openai-bundled"]
enabled = true

[plugins."browser@openai-bundled"]
enabled = true

[plugins."chrome@openai-bundled"]
enabled = true
```

可用 CLI 初始化通用 MCP，再手工补充 tool approval：

```bash
codex mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
codex mcp add feishu-mcp --url "https://YOUR_MCP_GATEWAY_DOMAIN/mcp?openId=YOUR_FEISHU_OPEN_ID"
codex mcp list
codex mcp get feishu-mcp
```

## 流程描述

这套流程把 Codex MCP 配置集中放在用户级 `~/.codex/config.toml`：通用本地进程型 MCP 用 `codex mcp add <name> -- <command>` 接入，例如 `chrome-devtools`；HTTP 型 MCP 用 `codex mcp add <name> --url <url>` 接入，例如 Feishu MCP 网关。接入后用 `codex mcp list` 和 `codex mcp get <name>` 检查生效状态，再按团队信任边界在 `tools.<tool>.approval_mode` 中把高频、安全边界清楚的工具设为 `approve`，其余工具保留默认确认。

插件提供的 MCP，例如 `computer-use`，不是通过普通 `[mcp_servers.*]` 完整声明启动命令，而是由已安装插件携带 `.mcp.json` 并在 Codex 中启用插件后出现。因此分享给别人时，优先说明“安装/启用对应 Codex 插件”，不要要求对方复制本机生成的插件缓存路径。

## 当前本机快照与私有字段标注

### `chrome-devtools`

- 类型：STDIO MCP
- 当前命令：`npx -y chrome-devtools-mcp@latest`
- 私有性：无明显私有字段；`approval_mode = "approve"` 是我们的本机偏好，分享时要说明风险。

### `feishu-mcp`

- 类型：Streamable HTTP MCP
- URL 模板：`https://YOUR_MCP_GATEWAY_DOMAIN/mcp?openId=YOUR_FEISHU_OPEN_ID`
- 私有性：
  - `YOUR_MCP_GATEWAY_DOMAIN`：替换成使用者自己的 MCP 网关域名。
  - `YOUR_FEISHU_OPEN_ID`：替换成使用者自己的飞书用户/账号绑定标识。
  - tool approval：我们自己的信任策略，别人应按自己的审批边界配置。

### `node_repl`

- 类型：STDIO MCP
- 当前用途：Codex App 内置 Node REPL，用于 Browser/Chrome 插件联动。
- 私有性：
  - `/Applications/Codex.app/...`：本机 Codex App 安装路径，和使用者的系统/版本绑定。
  - `~/.codex`：使用者自己的 `CODEX_HOME`，不要复制其他人的绝对路径。
  - `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`：我们当前 Codex App/Browser 客户端版本相关值。
- 处理建议：不建议作为通用模板复制。让对方安装并启用 Codex 的 Browser/Chrome/Computer Use 插件，由 Codex 自己生成对应配置。

### `computer-use`

- 类型：插件提供的 STDIO MCP
- 来源：`computer-use@openai-bundled` 插件缓存中的 `.mcp.json`
- 当前插件内声明：

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"],
      "cwd": "."
    }
  }
}
```

- 私有性：路径相对插件缓存和 Codex App 打包结构，不是用户应该手动维护的通用配置。

## 未纳入导出的内容

以下内容存在于 `~/.codex/config.toml`，但不属于 MCP 设置或不适合分享为 MCP 模板：
- `model`、`model_reasoning_effort`、`service_tier`
- `[projects.*]` trusted 列表，全部是我们自己的本机项目路径
- marketplace 本地缓存路径
- desktop 偏好、hook trust hash、TUI 状态
- `notify` 命令路径，属于我们自己的 Codex Computer Use 本机路径
