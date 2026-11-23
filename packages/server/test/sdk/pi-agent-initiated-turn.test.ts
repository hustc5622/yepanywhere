import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPiCommandCacheWrites } from "../../src/sdk/providers/pi-command-cache.js";
import { PiProvider } from "../../src/sdk/providers/pi.js";

/**
 * Pi extensions start runs on their own (`sendMessage(..., { triggerTurn })`:
 * async subagent results, goal continuation). The fake settles the prompt's
 * run, then wakes itself up once, exactly like a subagent completion. A
 * `/handled` prompt is answered by an extension command without a run.
 */
const FAKE_PI_RPC = String.raw`#!/usr/bin/env node
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const fs = require("node:fs");
const log = process.env.FAKE_PI_LOG;
let buffer = "";
const assistant = (text, stopReason = "stop") => {
  output({ type: "message_start", message: { role: "assistant", content: [] } });
  output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now() } });
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
    if (log) fs.appendFileSync(log, JSON.stringify(command) + "\n");
    if (command.type === "get_state") {
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-wake-session", thinkingLevel: "high" } });
    } else if (command.type === "prompt" && command.message === "/handled") {
      output({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "handled" } });
    } else if (command.type === "prompt") {
      output({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
      output({ type: "agent_start" });
      assistant("started a background job");
      output({ type: "agent_settled", aborted: false });
      setTimeout(() => {
        // The extension's completion notice wakes the agent with no prompt.
        output({ type: "agent_start" });
        output({ type: "message_start", message: { role: "custom", customType: "subagent-notify", content: "done" } });
        output({ type: "message_end", message: { role: "custom", customType: "subagent-notify", content: "done" } });
        assistant("the background job finished");
        output({ type: "agent_settled", aborted: false });
      }, 150);
    } else if (command.type === "get_entries") {
      output({ type: "response", id: command.id, command: "get_entries", success: true, data: { entries: [], leafId: null } });
    } else if (command.id) {
      output({ type: "response", id: command.id, command: command.type, success: true });
    }
  }
});
`;

describe("PiProvider agent-initiated turns", () => {
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

  async function start() {
    const root = join(tmpdir(), `pi-wake-${randomUUID()}`);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const fakePiPath = join(root, "fake-pi.cjs");
    const commandLog = join(root, "commands.jsonl");
    tempDirs.push(root);
    await mkdir(join(sessionsDir, "--project--"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);

    vi.stubEnv("FAKE_PI_LOG", commandLog);
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
    const seen: Record<string, unknown>[] = [];
    const iterator = session.iterator as AsyncIterableIterator<
      Record<string, unknown>
    >;
    void (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        seen.push(next.value);
      }
    })();
    return { session, seen, commandLog };
  }

  it("frames a run Pi starts on its own as an agent-initiated turn", async () => {
    const { session, seen, commandLog } = await start();
    try {
      session.queue.push({ text: "kick off", uuid: "client-1" });
      await vi.waitFor(() => {
        expect(seen.filter((m) => m.type === "result")).toHaveLength(2);
      }, 10_000);

      const timeline = seen
        .filter(
          (m) =>
            m.type === "result" ||
            (m.type === "system" && m.subtype === "turn_started") ||
            m.type === "assistant",
        )
        .map((m) =>
          m.type === "assistant"
            ? `assistant:${JSON.stringify((m.message as { content?: unknown })?.content).includes("finished") ? "wake" : "prompt"}`
            : m.type === "result"
              ? "result"
              : "turn_started",
        );
      expect(timeline).toEqual([
        "assistant:prompt",
        "result",
        "turn_started",
        "assistant:wake",
        "result",
      ]);
      expect(
        seen.find((m) => m.type === "system" && m.subtype === "turn_started"),
      ).toMatchObject({ origin: "agent", session_id: "pi-wake-session" });

      // Prompts may race an extension run, so they always say how to join it.
      const { readFile } = await import("node:fs/promises");
      const prompts = (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((command) => command.type === "prompt");
      expect(prompts[0]).toMatchObject({
        message: "kick off",
        streamingBehavior: "followUp",
      });
    } finally {
      session.abort();
    }
  }, 20_000);

  it("does not let a stale wake-up end the next prompt early", async () => {
    const { session, seen } = await start();
    try {
      session.queue.push({ text: "first", uuid: "client-1" });
      await vi.waitFor(() => {
        expect(seen.filter((m) => m.type === "result")).toHaveLength(2);
      }, 10_000);
      session.queue.push({ text: "second", uuid: "client-2" });
      await vi.waitFor(() => {
        expect(seen.filter((m) => m.type === "result")).toHaveLength(4);
      }, 10_000);
      // Every result closes exactly one turn: prompt, wake, prompt, wake.
      const markers = seen
        .filter(
          (m) =>
            m.type === "result" ||
            (m.type === "user" && typeof m.uuid === "string") ||
            (m.type === "system" && m.subtype === "turn_started"),
        )
        .map((m) =>
          m.type === "result"
            ? "result"
            : m.type === "user"
              ? "user"
              : "turn_started",
        );
      expect(markers).toEqual([
        "user",
        "result",
        "turn_started",
        "result",
        "user",
        "result",
        "turn_started",
        "result",
      ]);
    } finally {
      session.abort();
    }
  }, 20_000);

  it("closes a prompt an extension command handled without a run", async () => {
    const { session, seen } = await start();
    try {
      session.queue.push({ text: "/handled", uuid: "client-1" });
      await vi.waitFor(() => {
        expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
      }, 10_000);
    } finally {
      session.abort();
    }
  }, 20_000);
});
