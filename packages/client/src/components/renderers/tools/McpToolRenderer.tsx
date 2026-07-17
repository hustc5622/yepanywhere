/**
 * Renderer for MCP tool calls (Codex `server:tool` / `mcp__server__tool`
 * names). Previously these fell through to the raw-JSON fallback, which made
 * the web transcript far poorer than the Codex TUI's dedicated MCP cells.
 */
import type { ToolRenderer } from "./types";

interface McpToolIdentity {
  server: string;
  tool: string;
}

/**
 * Detect MCP-style tool names. Handles:
 * - `server:tool` (Codex app-server mcp_tool_call items)
 * - `mcp__server__tool` (MCP namespace prefixes in persisted JSONL)
 * - `server__tool` (namespace-joined custom tool calls)
 */
export function parseMcpToolName(toolName: string): McpToolIdentity | null {
  if (!toolName) return null;

  const colonIndex = toolName.indexOf(":");
  if (colonIndex > 0 && colonIndex < toolName.length - 1) {
    return {
      server: toolName.slice(0, colonIndex),
      tool: toolName.slice(colonIndex + 1),
    };
  }

  const withoutPrefix = toolName.startsWith("mcp__")
    ? toolName.slice("mcp__".length)
    : toolName;
  const sepIndex = withoutPrefix.indexOf("__");
  if (
    (toolName.startsWith("mcp__") || toolName.includes("__")) &&
    sepIndex > 0 &&
    sepIndex < withoutPrefix.length - 2
  ) {
    return {
      server: withoutPrefix.slice(0, sepIndex),
      tool: withoutPrefix.slice(sepIndex + 2),
    };
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/**
 * Interpret an MCP tool result. MCP servers return
 * `{ content: [{type:"text"|"image",...}], isError? }`; Codex may persist it
 * as that object, a JSON string of it, or plain text.
 */
function extractMcpResult(result: unknown): {
  blocks: McpContentBlock[] | null;
  fallbackText: string | null;
} {
  let value = result;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        value = JSON.parse(trimmed) as unknown;
      } catch {
        return { blocks: null, fallbackText: trimmed };
      }
    } else {
      return { blocks: null, fallbackText: value };
    }
  }

  if (isRecord(value) && Array.isArray(value.content)) {
    return {
      blocks: value.content.filter(isRecord) as McpContentBlock[],
      fallbackText: null,
    };
  }

  if (Array.isArray(value) && value.every(isRecord)) {
    return { blocks: value as McpContentBlock[], fallbackText: null };
  }

  return {
    blocks: null,
    fallbackText: JSON.stringify(value, null, 2),
  };
}

function McpArgs({ input }: { input: unknown }) {
  if (!isRecord(input) || Object.keys(input).length === 0) {
    return <div className="mcp-tool-args mcp-tool-args-empty">no args</div>;
  }
  return (
    <div className="mcp-tool-args">
      {Object.entries(input).map(([key, value]) => (
        <div className="mcp-tool-arg" key={key}>
          <span className="mcp-tool-arg-key">{key}</span>
          <span className="mcp-tool-arg-value">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function McpResultBlocks({ blocks }: { blocks: McpContentBlock[] }) {
  return (
    <div className="mcp-tool-result">
      {blocks.map((block, index) => {
        const key = `${block.type ?? "block"}-${index}`;
        if (block.type === "text" && typeof block.text === "string") {
          return (
            <pre className="mcp-tool-result-text" key={key}>
              {block.text}
            </pre>
          );
        }
        if (
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        ) {
          return (
            <img
              key={key}
              className="mcp-tool-result-image"
              src={`data:${block.mimeType};base64,${block.data}`}
              alt="MCP tool result"
            />
          );
        }
        return (
          <pre className="mcp-tool-result-text" key={key}>
            {JSON.stringify(block, null, 2)}
          </pre>
        );
      })}
    </div>
  );
}

export const mcpToolRenderer: ToolRenderer = {
  tool: "__mcp__",
  getDisplayName(input) {
    void input;
    return "MCP";
  },
  renderToolUse(input, _context) {
    return <McpArgs input={input} />;
  },
  renderToolResult(result, isError, _context, input) {
    const { blocks, fallbackText } = extractMcpResult(result);
    return (
      <div className={isError ? "mcp-tool-error" : undefined}>
        <McpArgs input={input} />
        {blocks ? (
          <McpResultBlocks blocks={blocks} />
        ) : (
          <pre className="mcp-tool-result-text">{fallbackText ?? ""}</pre>
        )}
      </div>
    );
  },
};
