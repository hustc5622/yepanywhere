export const ALL_TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}>;
export const OAPI_TOOL_NAMES: Set<string>;
export const MCP_DOC_TOOL_NAMES: Set<string>;
export function resolveTokenMode(
  name: string,
  action?: string,
): "user" | "tenant" | "auto";
