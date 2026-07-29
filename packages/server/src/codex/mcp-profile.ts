import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexMcpMode } from "@yep-anywhere/shared";

const execFileAsync = promisify(execFile);

export const CODEX_STANDARD_MCP_APP_SERVER_ARGS = [
  "--disable",
  "apps",
  "--disable",
  "plugins",
] as const;

export const CODEX_CLEAR_MCP_APP_SERVER_ARGS = [
  ...CODEX_STANDARD_MCP_APP_SERVER_ARGS,
] as const;

export function getCodexMcpAppServerArgs(
  mode: CodexMcpMode | undefined,
  configuredMcpServers: readonly string[] = [],
): string[] {
  if (mode === "clear") {
    return [
      ...CODEX_CLEAR_MCP_APP_SERVER_ARGS,
      ...configuredMcpServers.flatMap((name) => [
        "-c",
        `mcp_servers.${name}.enabled=false`,
      ]),
    ];
  }
  return mode === "full" ? [] : [...CODEX_STANDARD_MCP_APP_SERVER_ARGS];
}

/** 只返回 Codex 当前配置中带完整 transport 的 MCP server 名称。 */
export async function discoverConfiguredCodexMcpServers(
  codexCommand: string,
  timeoutMs = 3000,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      codexCommand,
      ["mcp", "list", "--json"],
      { encoding: "utf8", timeout: timeoutMs },
    );
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { name?: unknown }).name === "string"
          ? (entry as { name: string }).name
          : null,
      )
      .filter((name): name is string => Boolean(name));
  } catch {
    return [];
  }
}
