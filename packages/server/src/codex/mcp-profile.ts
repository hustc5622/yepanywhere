import type { CodexMcpMode } from "@yep-anywhere/shared";

/**
 * MCP servers kept enabled by the default/light profile when they exist.
 * `feishu-mcp` is retained as a compatibility alias for older local configs;
 * current cf configs use `lark`.
 */
export const CODEX_STANDARD_ENABLED_MCP_SERVER_IDS = [
  "node_repl",
  "lark",
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

/**
 * MCP enablement is deliberately absent from app-server CLI args. Codex
 * validates the CLI override layer independently, so an enabled-only MCP entry
 * is invalid even when the base config contains that server's transport.
 */
export const CODEX_STANDARD_MCP_APP_SERVER_ARGS = [
  ...CODEX_DISABLED_APPS_AND_PLUGINS_ARGS,
] as const;

export const CODEX_CLEAR_MCP_APP_SERVER_ARGS = [
  ...CODEX_DISABLED_APPS_AND_PLUGINS_ARGS,
] as const;

export const CODEX_FULL_MCP_APP_SERVER_ARGS = [
  ...CODEX_ENABLED_APPS_AND_PLUGINS_ARGS,
] as const;

const MCP_ENABLED_OVERRIDE_PATTERN =
  /^mcp_servers\..+\.enabled=(?:true|false)$/;

export interface CodexMcpConfigEntry {
  name: string;
  transport:
    | { type: "stdio"; command: string }
    | { type: "streamable_http"; url: string };
}

type CodexMcpJsonValue =
  | number
  | string
  | boolean
  | CodexMcpJsonValue[]
  | { [key: string]: CodexMcpJsonValue | undefined }
  | null;

export type CodexMcpServerThreadConfig = Record<string, CodexMcpJsonValue>;

export interface CodexMcpThreadConfig {
  [key: string]: CodexMcpJsonValue;
  mcp_servers: Record<string, CodexMcpServerThreadConfig>;
}

export interface ResolvedCodexMcpThreadProfile {
  threadConfig: CodexMcpThreadConfig;
  configuredServerIds: string[];
}

function getProfileBaseArgs(mode: CodexMcpMode | undefined): readonly string[] {
  if (mode === "clear") return CODEX_CLEAR_MCP_APP_SERVER_ARGS;
  return mode === "full"
    ? CODEX_FULL_MCP_APP_SERVER_ARGS
    : CODEX_STANDARD_MCP_APP_SERVER_ARGS;
}

function stripMcpEnabledOverrides(args: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (
      (arg === "-c" || arg === "--config") &&
      typeof value === "string" &&
      MCP_ENABLED_OVERRIDE_PATTERN.test(value)
    ) {
      index += 1;
      continue;
    }
    if (arg !== undefined) filtered.push(arg);
  }
  return filtered;
}

/**
 * Return only process-wide feature flags and remove legacy invalid MCP args.
 * Per-server enablement belongs in thread start/resume/fork config.
 */
export function getCodexMcpAppServerArgs(
  mode: CodexMcpMode | undefined,
  baseArgs: readonly string[] = getProfileBaseArgs(mode),
): string[] {
  return stripMcpEnabledOverrides(baseArgs);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getMcpServerConfigMap(
  config: unknown,
): Record<string, unknown> | null {
  const record = asRecord(config);
  if (!record) return null;
  return (
    asRecord(record.mcp_servers) ??
    // Older integrations occasionally camel-cased arbitrary config keys.
    asRecord(record.mcpServers)
  );
}

function parseMcpConfigEntry(
  name: string,
  value: unknown,
): CodexMcpConfigEntry | null {
  const entry = asRecord(value);
  if (!entry) return null;

  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (command && url) {
    throw new Error(
      `Codex MCP server ${name} defines both stdio and HTTP transports`,
    );
  }
  if (command) {
    return { name, transport: { type: "stdio", command } };
  }
  if (url) {
    return { name, transport: { type: "streamable_http", url } };
  }
  return null;
}

/**
 * Extract only the minimum transport discriminator from config/read output.
 * Do not copy args, env, headers, or credentials into logs or bridge state;
 * Codex's recursive config merge keeps those fields from the base layer.
 */
export function getCodexMcpConfigEntries(
  effectiveConfig: unknown,
): CodexMcpConfigEntry[] {
  const servers = getMcpServerConfigMap(effectiveConfig);
  if (!servers) return [];

  return Object.entries(servers)
    .map(([name, value]) => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        throw new Error("Codex config/read returned an empty MCP server name");
      }
      const entry = parseMcpConfigEntry(normalizedName, value);
      if (!entry) {
        throw new Error(
          `Codex MCP server ${normalizedName} has no command or URL`,
        );
      }
      return entry;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildThreadServerConfig(
  entry: CodexMcpConfigEntry,
  enabled: boolean,
): CodexMcpServerThreadConfig {
  return entry.transport.type === "stdio"
    ? { command: entry.transport.command, enabled }
    : { url: entry.transport.url, enabled };
}

function isServerEnabled(
  mode: CodexMcpMode | undefined,
  serverId: string,
): boolean {
  const normalizedMode = mode ?? "standard";
  return (
    normalizedMode === "full" ||
    (normalizedMode === "standard" &&
      CODEX_STANDARD_ENABLED_MCP_SERVER_ID_SET.has(serverId))
  );
}

export function getCodexMcpThreadConfig(
  mode: CodexMcpMode | undefined,
  entries: Iterable<CodexMcpConfigEntry>,
): CodexMcpThreadConfig {
  const servers = Array.from(entries).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const mcpServers: Record<string, CodexMcpServerThreadConfig> = {};

  for (const entry of servers) {
    mcpServers[entry.name] = buildThreadServerConfig(
      entry,
      isServerEnabled(mode, entry.name),
    );
  }

  return { mcp_servers: mcpServers };
}

/**
 * Build a valid high-precedence thread config from app-server config/read.
 * Existing client-supplied MCP fields are retained, while the selected profile
 * remains authoritative for `enabled`. A transport from the effective config
 * is added when the client supplied only a partial override, which keeps the
 * strict SessionFlags layer independently valid on Codex 0.146+.
 */
export function resolveCodexMcpThreadProfile(
  mode: CodexMcpMode | undefined,
  effectiveConfig: unknown,
  existingThreadConfig?: unknown,
): ResolvedCodexMcpThreadProfile {
  const effectiveEntries = getCodexMcpConfigEntries(effectiveConfig);
  const entriesByName = new Map(
    effectiveEntries.map((entry) => [entry.name, entry] as const),
  );
  const existingServers = getMcpServerConfigMap(existingThreadConfig);

  if (existingServers) {
    for (const [name, value] of Object.entries(existingServers)) {
      const normalizedName = name.trim();
      if (!normalizedName) {
        throw new Error(
          "Codex thread config contains an empty MCP server name",
        );
      }
      const entry = parseMcpConfigEntry(normalizedName, value);
      if (entry) entriesByName.set(normalizedName, entry);
      if (!entry && !entriesByName.has(normalizedName)) {
        throw new Error(
          `Codex MCP server ${normalizedName} has no command or URL in effective or thread config`,
        );
      }
    }
  }

  const entries = Array.from(entriesByName.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const threadConfig = getCodexMcpThreadConfig(mode, entries);

  if (existingServers) {
    for (const [name, value] of Object.entries(existingServers)) {
      const normalizedName = name.trim();
      const existing = asRecord(value);
      if (!existing) continue;
      const generated = threadConfig.mcp_servers[normalizedName];
      if (!generated) continue;
      threadConfig.mcp_servers[normalizedName] = {
        ...generated,
        ...(existing as CodexMcpServerThreadConfig),
        enabled: isServerEnabled(mode, normalizedName),
      };
    }
  }

  return {
    threadConfig,
    configuredServerIds: entries.map((entry) => entry.name),
  };
}
