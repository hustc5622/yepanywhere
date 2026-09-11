#!/usr/bin/env node
// A stateless STDIO transport. Yep owns credentials, refresh and tool execution.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const configPath = process.argv[2];
if (!configPath)
  throw new Error("Pass the Yep Feishu connector configuration path.");
const calls = new Map();
const input = createInterface({ input: process.stdin });
input.on("close", () => {
  for (const controller of calls.values()) controller.abort();
});
input.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === "notifications/cancelled") {
    calls.get(request.params?.requestId)?.abort();
    return;
  }
  if (request.id === undefined || request.id === null) return;
  const controller = new AbortController();
  calls.set(request.id, controller);
  try {
    let result;
    if (request.method === "initialize")
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "yep-feishu", version: "1.0.0" },
        instructions:
          "Yep manages Feishu authorization. If a tool returns user_auth_required, show its authorization link and wait. After authorization, continue the original task. Never read token files, launch another bridge, or replay an uncertain write.",
      };
    else if (request.method === "ping") result = {};
    else if (["tools/list", "tools/call"].includes(request.method)) {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const url = new URL(config.serverUrl);
      if (
        url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )
      )
        throw new Error("Yep connector requires HTTPS or localhost.");
      const response = await fetch(
        `${config.serverUrl.replace(/\/$/, "")}/api/auth/feishu/mcp`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(230000),
          ]),
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            method: request.method,
            params: request.params,
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Yep Feishu service returned HTTP ${response.status}`);
      result = await response.json();
    } else throw new Error(`Unsupported MCP method: ${request.method}`);
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } })}\n`,
    );
  } finally {
    calls.delete(request.id);
  }
});
