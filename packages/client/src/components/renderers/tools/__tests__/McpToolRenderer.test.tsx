import { describe, expect, it } from "vitest";
import { mcpToolRenderer, parseMcpToolName } from "../McpToolRenderer";
import { toolRegistry } from "../index";

describe("parseMcpToolName", () => {
  it("parses server:tool names", () => {
    expect(parseMcpToolName("github:search_issues")).toEqual({
      server: "github",
      tool: "search_issues",
    });
  });

  it("parses mcp__server__tool names", () => {
    expect(parseMcpToolName("mcp__github__search_issues")).toEqual({
      server: "github",
      tool: "search_issues",
    });
  });

  it("parses namespace-joined server__tool names", () => {
    expect(parseMcpToolName("linear__create_ticket")).toEqual({
      server: "linear",
      tool: "create_ticket",
    });
  });

  it("rejects ordinary tool names", () => {
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("update_plan")).toBeNull();
    expect(parseMcpToolName("spawn_agent")).toBeNull();
    expect(parseMcpToolName("")).toBeNull();
  });
});

describe("toolRegistry MCP routing", () => {
  it("routes unregistered MCP names to the MCP renderer", () => {
    expect(toolRegistry.get("github:search_issues")).toBe(mcpToolRenderer);
    expect(toolRegistry.get("mcp__github__search_issues")).toBe(
      mcpToolRenderer,
    );
  });

  it("keeps registered tools on their dedicated renderers", () => {
    expect(toolRegistry.get("Bash")).not.toBe(mcpToolRenderer);
    expect(toolRegistry.get("update_plan")).not.toBe(mcpToolRenderer);
  });

  it("formats MCP display names as server · tool", () => {
    expect(toolRegistry.getDisplayName("github:search_issues")).toBe(
      "github · search_issues",
    );
  });
});
