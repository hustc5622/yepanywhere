import type { CodexMcpMode } from "@yep-anywhere/shared";

export const CODEX_STANDARD_MCP_APP_SERVER_ARGS = [
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "-c",
  "mcp_servers.chrome-devtools.enabled=false",
] as const;

export const CODEX_CLEAR_MCP_APP_SERVER_ARGS = [
  ...CODEX_STANDARD_MCP_APP_SERVER_ARGS,
  "-c",
  "mcp_servers.node_repl.enabled=false",
  "-c",
  "mcp_servers.feishu-mcp.enabled=false",
  "-c",
  "mcp_servers.openaiDeveloperDocs.enabled=false",
] as const;

export function getCodexMcpAppServerArgs(
  mode: CodexMcpMode | undefined,
): string[] {
  if (mode === "clear") return [...CODEX_CLEAR_MCP_APP_SERVER_ARGS];
  return mode === "full" ? [] : [...CODEX_STANDARD_MCP_APP_SERVER_ARGS];
}
