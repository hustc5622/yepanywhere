import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PI_OVERLAY_BACKUP_DIR,
  restorePiIsolatedAgentDir,
  syncPiNativeAgentDir,
} from "../../src/sdk/providers/pi-native-agent-dir.js";
import { PiProvider } from "../../src/sdk/providers/pi.js";

const FAKE_PI_RPC = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.PI_FAKE_START_PATH, JSON.stringify({
  args: process.argv.slice(2),
  agentDir: process.env.PI_CODING_AGENT_DIR,
}));
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-native-session", thinkingLevel: "high" } });
    } else if (command.id) {
      output({ type: "response", id: command.id, command: command.type, success: true });
    }
  }
});
`;

describe("Pi native agent dir overlay", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("yep.pi.provider-config.v1")
    ];
    await Promise.all(
      roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeDirs() {
    const root = join(tmpdir(), `pi-native-${randomUUID()}`);
    roots.push(root);
    const user = join(root, "user-agent");
    const overlay = join(root, "yep-agent");
    await mkdir(join(user, "npm", "node_modules"), { recursive: true });
    await writeFile(join(user, "mcp.json"), '{"mcpServers":{}}');
    await writeFile(
      join(user, "settings.json"),
      '{"defaultProvider":"mafia","packages":["npm:pi-mcp-adapter"]}',
    );
    return { root, user, overlay };
  }

  it("links user entries, copies settings, and keeps overlay-only files", async () => {
    const { user, overlay } = await makeDirs();
    await mkdir(overlay, { recursive: true });
    await writeFile(join(overlay, "APPEND_SYSTEM.md"), "yep only");
    await writeFile(join(overlay, "mcp.json"), "legacy isolated");

    await syncPiNativeAgentDir(user, overlay);

    expect(await readlink(join(overlay, "mcp.json"))).toBe(
      join(user, "mcp.json"),
    );
    expect(await readlink(join(overlay, "npm"))).toBe(join(user, "npm"));
    expect(await readFile(join(overlay, "APPEND_SYSTEM.md"), "utf8")).toBe(
      "yep only",
    );
    expect(
      await readFile(join(overlay, PI_OVERLAY_BACKUP_DIR, "mcp.json"), "utf8"),
    ).toBe("legacy isolated");
    const settings = join(overlay, "settings.json");
    expect((await lstat(settings)).isSymbolicLink()).toBe(false);
    expect(await readFile(settings, "utf8")).toContain("pi-mcp-adapter");

    // Pi rewriting the overlay settings must not touch the user's file.
    await writeFile(settings, '{"defaultProvider":"yep-anthropic"}');
    expect(await readFile(join(user, "settings.json"), "utf8")).toContain(
      "mafia",
    );
  });

  it("refreshes on every sync and replaces a stray settings symlink", async () => {
    const { user, overlay } = await makeDirs();
    await syncPiNativeAgentDir(user, overlay);
    await rm(join(user, "mcp.json"));
    await writeFile(join(user, "trust.json"), "{}");
    await writeFile(join(user, "settings.json"), '{"theme":"light"}');
    await rm(join(overlay, "settings.json"));
    await symlink(join(user, "settings.json"), join(overlay, "settings.json"));

    await syncPiNativeAgentDir(user, overlay);

    await expect(lstat(join(overlay, "mcp.json"))).rejects.toThrow();
    expect(await readlink(join(overlay, "trust.json"))).toBe(
      join(user, "trust.json"),
    );
    expect((await lstat(join(overlay, "settings.json"))).isSymbolicLink()).toBe(
      false,
    );
    expect(await readFile(join(user, "settings.json"), "utf8")).toBe(
      '{"theme":"light"}',
    );
  });

  it("drops a cache rewritten over its link without stacking backups", async () => {
    const { user, overlay } = await makeDirs();
    await mkdir(overlay, { recursive: true });
    await writeFile(join(overlay, "mcp.json"), "legacy isolated");
    await syncPiNativeAgentDir(user, overlay);
    // An atomic rename by Pi replaces the link with a regular file.
    await rm(join(overlay, "mcp.json"));
    await writeFile(join(overlay, "mcp.json"), "runtime rewrite");

    await syncPiNativeAgentDir(user, overlay);

    expect(await readlink(join(overlay, "mcp.json"))).toBe(
      join(user, "mcp.json"),
    );
    expect(
      await readFile(join(overlay, PI_OVERLAY_BACKUP_DIR, "mcp.json"), "utf8"),
    ).toBe("legacy isolated");
  });

  it("restores the isolated layout", async () => {
    const { user, overlay } = await makeDirs();
    await mkdir(overlay, { recursive: true });
    await writeFile(join(overlay, "mcp.json"), "legacy isolated");
    await syncPiNativeAgentDir(user, overlay);

    await restorePiIsolatedAgentDir(user, overlay);

    await expect(lstat(join(overlay, "npm"))).rejects.toThrow();
    expect(await readFile(join(overlay, "mcp.json"), "utf8")).toBe(
      "legacy isolated",
    );
  });

  it("starts Pi with user extensions enabled and the overlay as agent dir", async () => {
    const { root, user, overlay } = await makeDirs();
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const fakePiPath = join(root, "fake-pi.cjs");
    const startPath = join(root, "start.json");
    await mkdir(join(sessionsDir, "--project--"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);

    vi.stubEnv("YEP_PI_NATIVE_CONFIG", "true");
    vi.stubEnv("PI_FAKE_START_PATH", startPath);
    vi.stubEnv("YEP_LLM_GATEWAY_API_KEY", "test-only-secret");
    vi.stubEnv("YEP_LLM_GATEWAY_API_BASE", "https://gateway.example/v1");
    vi.stubEnv("YEP_LLM_GATEWAY_MODELS", "");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: "test-model",
                name: "Test Model",
                context_window: 128_000,
                supported_endpoint_types: ["anthropic/messages"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const provider = new PiProvider({
      piPath: fakePiPath,
      sessionsDir,
      agentDir: overlay,
      userAgentDir: user,
      extensionPath: resolve(
        import.meta.dirname,
        "../../resources/pi-yep-extension.mjs",
      ),
      timeout: 5_000,
    });
    const session = await provider.startSession({
      cwd: projectPath,
      model: "test-model",
      initialMessage: { text: "hello" },
    });
    try {
      await (
        session.iterator as AsyncIterableIterator<Record<string, unknown>>
      ).next();
    } finally {
      session.abort();
    }

    const start = JSON.parse(await readFile(startPath, "utf8")) as {
      args: string[];
      agentDir: string;
    };
    expect(start.agentDir).toBe(overlay);
    expect(start.args).not.toContain("--no-extensions");
    expect(start.args).toContain("--extension");
    expect(await readlink(join(overlay, "mcp.json"))).toBe(
      join(user, "mcp.json"),
    );
  });
});
