import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProvider } from "../../src/sdk/providers/pi.js";

/**
 * Pi persists a prompt under its own entry id and never stores Yep's client
 * UUID. The provider therefore re-emits the prompt under the persisted id once
 * Pi reports `message_end`, reading only the entries appended since the last
 * known leaf.
 */
const FAKE_PI_RPC = String.raw`#!/usr/bin/env node
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let buffer = "";
const entries = [
  { type: "message", id: "old-user", parentId: null, timestamp: "2026-09-02T07:58:51.565Z", message: { role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 1 } },
  { type: "message", id: "old-assistant", parentId: "old-user", timestamp: "2026-09-02T07:58:58.254Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } },
];
let promptCount = 0;
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
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-echo-session", thinkingLevel: "high" } });
    } else if (command.type === "prompt") {
      promptCount += 1;
      const userId = "user-entry-" + promptCount;
      const assistantId = "assistant-entry-" + promptCount;
      const userMessage = { role: "user", content: [{ type: "text", text: command.message }], timestamp: 1788335957393 };
      entries.push({ type: "message", id: userId, parentId: entries[entries.length - 1].id, timestamp: "2026-09-02T07:59:17.396Z", message: userMessage });
      output({ type: "response", id: command.id, command: "prompt", success: true });
      output({ type: "message_start", message: userMessage });
      output({ type: "message_end", message: userMessage });
      const assistantMessage = { role: "assistant", content: [{ type: "text", text: "done " + promptCount }], stopReason: "stop", timestamp: Date.now() };
      entries.push({ type: "message", id: assistantId, parentId: userId, timestamp: new Date().toISOString(), message: assistantMessage });
      output({ type: "message_start", message: { role: "assistant", content: [] } });
      output({ type: "message_end", message: assistantMessage });
      output({ type: "agent_settled" });
    } else if (command.type === "get_entries") {
      require("node:fs").appendFileSync("get-entries.log", JSON.stringify(command.since ?? null) + "\n");
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

async function drainUntilResult(
  iterator: AsyncIterableIterator<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const next = await iterator.next();
    if (next.done) return seen;
    seen.push(next.value);
    if (next.value.type === "result") return seen;
  }
  throw new Error("Timed out waiting for the Pi turn to settle");
}

describe("PiProvider persisted user entry echo", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
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

  it("re-emits each prompt under Pi's entry id and names the optimistic row it replaces", async () => {
    const root = join(tmpdir(), `pi-echo-${randomUUID()}`);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const fakePiPath = join(root, "fake-pi.cjs");
    tempDirs.push(root);
    await mkdir(join(sessionsDir, "--project--"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);

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

      session.queue.push({
        text: "first prompt",
        uuid: "client-1",
        tempId: "t1",
      });
      const firstTurn = await drainUntilResult(iterator);
      const firstUsers = firstTurn.filter((m) => m.type === "user");
      expect(firstUsers.map((m) => m.uuid)).toEqual([
        "client-1",
        "user-entry-1",
      ]);
      expect(firstUsers[1]).toMatchObject({
        uuid: "user-entry-1",
        clientUserMessageId: "client-1",
        supersedesMessageId: "client-1",
        tempId: "t1",
        timestamp: "2026-09-02T07:59:17.393Z",
        message: { role: "user", content: "first prompt" },
      });

      // The second turn must only read entries after the remembered leaf.
      session.queue.push({ text: "second prompt", uuid: "client-2" });
      const secondTurn = await drainUntilResult(iterator);
      const secondUsers = secondTurn.filter((m) => m.type === "user");
      expect(secondUsers.map((m) => m.uuid)).toEqual([
        "client-2",
        "user-entry-2",
      ]);
      expect(secondUsers[1]).toMatchObject({
        clientUserMessageId: "client-2",
        supersedesMessageId: "client-2",
      });
      expect(secondUsers[1]?.tempId).toBeUndefined();

      const cursors = (
        await readFile(join(projectPath, "get-entries.log"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(cursors).toEqual([null, "assistant-entry-1"]);
    } finally {
      session.abort();
    }
  });
});
