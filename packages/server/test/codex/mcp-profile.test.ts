import { describe, expect, it } from "vitest";
import { getCodexMcpAppServerArgs } from "../../src/codex/mcp-profile.js";

describe("Codex MCP 参数", () => {
  it("不会为不存在的 MCP server 生成禁用项", () => {
    expect(getCodexMcpAppServerArgs("standard")).toEqual([
      "--disable",
      "apps",
      "--disable",
      "plugins",
    ]);
  });

  it("clear 模式只禁用实际发现的 MCP server", () => {
    expect(
      getCodexMcpAppServerArgs("clear", ["node_repl", "playwright"]),
    ).toEqual([
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "-c",
      "mcp_servers.node_repl.enabled=false",
      "-c",
      "mcp_servers.playwright.enabled=false",
    ]);
  });

  it("full 模式不覆盖用户配置", () => {
    expect(getCodexMcpAppServerArgs("full", ["node_repl"])).toEqual([]);
  });
});
