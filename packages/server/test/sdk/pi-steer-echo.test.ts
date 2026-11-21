import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPiCommandCacheWrites } from "../../src/sdk/providers/pi-command-cache.js";
import { PiProvider } from "../../src/sdk/providers/pi.js";

/**
 * Steering input is delivered mid-turn, after the current tool batch. Yep has
 * already shown the optimistic prompt, so the provider has to re-emit the
 * delivered message under Pi's persisted entry id and the client identity the
 * client is still holding; otherwise the display projection would either drop
 * the prompt or duplicate it once the session file is read.
 */
const FAKE_PI_RPC = String.raw`#!/usr/bin/env node
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let buffer = "";
const entries = [
  { type: "message", id: "old-user", parentId: null, timestamp: "2026-09-02T07:58:51.565Z", message: { role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 1 } },
];
let pendingSteer = null;
const appendUser = (text) => {
  const id = "user-entry-" + (entries.length + 1);
  const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  entries.push({ type: "message", id, parentId: entries[entries.length - 1].id, timestamp: new Date().toISOString(), message });
  return { id, message };
};
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
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-steer-session", thinkingLevel: "high" } });
    } else if (command.type === "prompt") {
      const user = appendUser(command.message);
      output({ type: "response", id: command.id, command: "prompt", success: true });
      output({ type: "message_start", message: user.message });
      output({ type: "message_end", message: user.message });
      output({ type: "message_start", message: { role: "assistant", content: [] } });
      output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "stop", timestamp: Date.now() } });
    } else if (command.type === "steer") {
      pendingSteer = command.message;
      output({ type: "response", id: command.id, command: "steer", success: true, data: { disposition: "queued" } });
      output({ type: "queue_update", steering: [command.message], followUp: [] });
      // Delivered once the current tool batch is done.
      const steerUser = appendUser(command.message);
      output({ type: "message_start", message: steerUser.message });
      output({ type: "message_end", message: steerUser.message });
      output({ type: "queue_update", steering: [], followUp: [] });
      output({ type: "message_start", message: { role: "assistant", content: [] } });
      output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now() } });
      output({ type: "agent_settled" });
    } else if (command.type === "get_entries") {
      let slice = entries;
      if (command.since !== undefined) {
        const index = entries.findIndex((entry) => entry.id === command.since);
        if (index === -1) {
          output({ type: "response", id: command.id, command: "get_entries", success: false, error: "Entry not found: " + command.since });
          continue;
        }
        slice = entries.slice(index + 1);
      }
      output({ type: "response", id: command.id, command: "get_entries", success: true, data: { entries: slice, leafId: entries[entries.length - 1].id } });
    } else if (command.type === "abort") {
      output({ type: "response", id: command.id, command: "abort", success: true });
    } else if (command.id) {
      output({ type: "response", id: command.id, command: command.type, success: true });
    }
  }
});
`;

describe("PiProvider steering echo", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await waitForPiCommandCacheWrites();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("yep.pi.provider-config.v1")
    ];
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("re-emits a delivered steering message under Pi's entry id", async () => {
    const root = join(tmpdir(), `pi-steer-echo-${randomUUID()}`);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const fakePiPath = join(root, "fake-pi.cjs");
    tempDirs.push(root);
    await mkdir(join(sessionsDir, "--project--"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);

    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", join(root, "data"));
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
      agentDir: join(root, "yep-pi-agent"),
      extensionPath: resolve(
        import.meta.dirname,
        "../../resources/pi-yep-extension.mjs",
      ),
      timeout: 5_000,
    });

    const session = await provider.startSession({
      cwd: projectPath,
      model: "test-model",
    });
    try {
      const iterator = session.iterator as AsyncIterableIterator<
        Record<string, unknown>
      >;
      const seen: Record<string, unknown>[] = [];
      const drain = (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) return seen;
          seen.push(next.value);
          if (next.value.type === "result") return seen;
        }
      })();

      session.queue.push({
        text: "first prompt",
        uuid: "client-1",
        tempId: "t1",
      });
      await vi.waitFor(() => {
        expect(
          seen.some(
            (message) =>
              message.type === "user" &&
              message.clientUserMessageId === "client-1",
          ),
        ).toBe(true);
      }, 10_000);

      await expect(
        session.steer({ text: "insert this", uuid: "client-2", tempId: "t2" }),
      ).resolves.toBe(true);
      await drain;

      const users = seen.filter((message) => message.type === "user");
      const promptEcho = users.find(
        (message) => message.clientUserMessageId === "client-1",
      );
      const steerEcho = users.find(
        (message) => message.clientUserMessageId === "client-2",
      );
      expect(promptEcho).toMatchObject({ tempId: "t1" });
      expect(steerEcho).toMatchObject({
        supersedesMessageId: "client-2",
        tempId: "t2",
        message: { role: "user", content: "insert this" },
      });
      // The echo carries Pi's persisted entry id, not Yep's prompt uuid.
      expect(steerEcho?.uuid).not.toBe("client-2");
      expect(String(steerEcho?.uuid)).toMatch(/^user-entry-/);
    } finally {
      session.abort();
    }
  }, 20_000);
});
