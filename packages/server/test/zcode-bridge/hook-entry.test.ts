/**
 * hook-entry.mjs stdin/stdout contract tests.
 *
 * Spawns the real plugin entry script against a stub HTTP server standing in
 * for the Yep server, verifying:
 *   - PermissionRequest decisions are written back in the CLI's stdout
 *     contract (hookSpecificOutput.decision)
 *   - bridge requests carry the shared token and the X-Yep-Anywhere header
 *   - failure modes (no config, decision:null, server error) exit 0 silently
 *     so the TUI falls back to its native dialog
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK_ENTRY = fileURLToPath(
  new URL("../../resources/zcode-plugin/hook-entry.mjs", import.meta.url),
);
const TOKEN = "hook-entry-test-token";

interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

async function runHookEntry(
  stdinPayload: Record<string, unknown>,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.write(`${JSON.stringify(stdinPayload)}\n`);
    child.stdin.end();
  });
}

describe("hook-entry.mjs", () => {
  let tempDir: string;
  let server: Server;
  let serverUrl: string;
  let captured: CapturedRequest[];
  let responder: (body: Record<string, unknown>) => Record<string, unknown>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-hook-entry-test-"));
    captured = [];
    responder = () => ({ ok: true });
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf-8");
      });
      req.on("end", () => {
        captured.push({
          path: req.url ?? "",
          headers: req.headers,
          body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responder(JSON.parse(body || "{}"))));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${port}`;
    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify({ serverUrl, token: TOKEN }),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  function hookEnv(): Record<string, string> {
    return { YEP_ZCODE_BRIDGE_CONFIG: join(tempDir, "config.json") };
  }

  it("writes the PermissionRequest decision back in the CLI contract", async () => {
    responder = () => ({
      decision: { behavior: "allow", updatedInput: { command: "ls -la" } },
    });
    const result = await runHookEntry(
      {
        hook_event_name: "PermissionRequest",
        session_id: "ses-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "perm-1",
      },
      hookEnv(),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { command: "ls -la" } },
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.path).toBe("/api/zcode-bridge/hook");
    expect(captured[0]?.headers["x-zcode-bridge-token"]).toBe(TOKEN);
    expect(captured[0]?.headers["x-yep-anywhere"]).toBe("true");
    expect(captured[0]?.body).toMatchObject({
      hook_event_name: "PermissionRequest",
      tool_use_id: "perm-1",
    });
  });

  it("forwards a deny decision with its message", async () => {
    responder = () => ({
      decision: { behavior: "deny", message: "too risky" },
    });
    const result = await runHookEntry(
      { hook_event_name: "PermissionRequest", tool_use_id: "perm-2" },
      hookEnv(),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "too risky" },
      },
    });
  });

  it("stays silent (fail-safe) when the server returns no decision", async () => {
    responder = () => ({ decision: null });
    const result = await runHookEntry(
      { hook_event_name: "PermissionRequest", tool_use_id: "perm-3" },
      hookEnv(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("forwards lifecycle events fire-and-forget with no stdout", async () => {
    const result = await runHookEntry(
      {
        hook_event_name: "SessionStart",
        session_id: "ses-1",
        cwd: "/tmp/proj",
      },
      hookEnv(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      hook_event_name: "SessionStart",
      session_id: "ses-1",
    });
  });

  it("exits silently when the bridge config is missing", async () => {
    const result = await runHookEntry(
      { hook_event_name: "PermissionRequest", tool_use_id: "perm-4" },
      { YEP_ZCODE_BRIDGE_CONFIG: join(tempDir, "missing.json") },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(captured).toHaveLength(0);
  });

  it("exits silently when the server rejects the hook", async () => {
    // Force a 503 by pointing the config at a stub that errors on every hook.
    const badServer = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      badServer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { port } = badServer.address() as AddressInfo;
      await writeFile(
        join(tempDir, "config-bad.json"),
        JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, token: TOKEN }),
      );
      const result = await runHookEntry(
        { hook_event_name: "PermissionRequest", tool_use_id: "perm-5" },
        { YEP_ZCODE_BRIDGE_CONFIG: join(tempDir, "config-bad.json") },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await new Promise<void>((resolve) => badServer.close(() => resolve()));
    }
  });
});
