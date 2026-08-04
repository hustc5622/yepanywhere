import type { CodexMcpMode } from "@yep-anywhere/shared";

/**
 * Directly configured MCP server ids controlled by the cf-compatible profiles.
 * Keep this list aligned with the cf function in ~/.zshrc.
 */
export const CODEX_PROFILED_MCP_SERVER_IDS = [
  "node_repl",
  "feishu-mcp",
  "chrome-devtools",
  "computer-use",
  "openaiDeveloperDocs",
  "framelink-figma",
  "minimax-openapi",
  "sequential-thinking",
  "ShanLing",
  "item",
  "server-puppeteer",
  "web",
] as const;

export const CODEX_STANDARD_ENABLED_MCP_SERVER_IDS = [
  "node_repl",
  "feishu-mcp",
] as const;

const CODEX_STANDARD_ENABLED_MCP_SERVER_ID_SET = new Set<string>(
  CODEX_STANDARD_ENABLED_MCP_SERVER_IDS,
);

const CODEX_DISABLED_APPS_AND_PLUGINS_ARGS = [
  "--disable",
  "apps",
  "--disable",
  "plugins",
] as const;

const CODEX_ENABLED_APPS_AND_PLUGINS_ARGS = [
  "--enable",
  "apps",
  "--enable",
  "plugins",
] as const;

function buildMcpServerArgs(enabledServerIds: ReadonlySet<string>): string[] {
  return CODEX_PROFILED_MCP_SERVER_IDS.flatMap((serverId) => [
    "-c",
    `mcp_servers.${serverId}.enabled=${enabledServerIds.has(serverId)}`,
  ]);
}

export const CODEX_STANDARD_MCP_APP_SERVER_ARGS = [
  ...CODEX_DISABLED_APPS_AND_PLUGINS_ARGS,
  ...buildMcpServerArgs(CODEX_STANDARD_ENABLED_MCP_SERVER_ID_SET),
];

export const CODEX_CLEAR_MCP_APP_SERVER_ARGS = [
  ...CODEX_DISABLED_APPS_AND_PLUGINS_ARGS,
  ...buildMcpServerArgs(new Set<string>()),
];

export const CODEX_FULL_MCP_APP_SERVER_ARGS = [
  ...CODEX_ENABLED_APPS_AND_PLUGINS_ARGS,
  ...buildMcpServerArgs(new Set<string>(CODEX_PROFILED_MCP_SERVER_IDS)),
];

export function getCodexMcpAppServerArgs(
  mode: CodexMcpMode | undefined,
): string[] {
  if (mode === "clear") return [...CODEX_CLEAR_MCP_APP_SERVER_ARGS];
  return mode === "full"
    ? [...CODEX_FULL_MCP_APP_SERVER_ARGS]
    : [...CODEX_STANDARD_MCP_APP_SERVER_ARGS];
}
