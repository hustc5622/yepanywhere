import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readPiCommandCache,
  waitForPiCommandCacheWrites,
} from "../../src/sdk/providers/pi-command-cache.js";
import { PiProvider } from "../../src/sdk/providers/pi.js";

/**
 * Manual compaction is a control job that runs between turns: Pi rejects a
 * prompt while it compacts, and its compaction events must not leak into the
 * next turn. Automatic compaction inside a turn is surfaced as a status.
 */
const FAKE_PI_RPC = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const log = (value) => fs.appendFileSync("commands.log", JSON.stringify(value) + "\n");
let buffer = "";
const entries = [
  { type: "message", id: "old-user", parentId: null, timestamp: "2026-09-02T07:58:51.565Z", message: { role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 1 } },
];
let promptCount = 0;
let compactCount = 0;
const appendCompaction = (summary) => {
  compactCount += 1;
  const entry = { type: "compaction", id: "compaction-" + compactCount, parentId: entries[entries.length - 1].id, timestamp: "2026-09-02T08:00:0" + compactCount + ".000Z", summary, firstKeptEntryId: "old-user", tokensBefore: 1000 };
  entries.push(entry);
  return { summary, firstKeptEntryId: "old-user", tokensBefore: 1000 };
};
const finishPrompt = (command) => {
  promptCount += 1;
  const userMessage = { role: "user", content: [{ type: "text", text: command.message }], timestamp: 1 };
  entries.push({ type: "message", id: "user-entry-" + promptCount, parentId: entries[entries.length - 1].id, timestamp: "2026-09-02T07:59:17.396Z", message: userMessage });
  output({ type: "message_start", message: userMessage });
  output({ type: "message_end", message: userMessage });
  if (command.message === "auto") {
    output({ type: "compaction_start", reason: "threshold" });
    const result = appendCompaction("auto summary");
    output({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false });
  }
  const assistantMessage = { role: "assistant", content: [{ type: "text", text: "done " + promptCount }], stopReason: "stop", timestamp: Date.now() };
  entries.push({ type: "message", id: "assistant-entry-" + promptCount, parentId: entries[entries.length - 1].id, timestamp: new Date().toISOString(), message: assistantMessage });
  output({ type: "message_start", message: { role: "assistant", content: [] } });
  output({ type: "message_end", message: assistantMessage });
  log({ type: "agent_settled" });
  output({ type: "agent_settled" });
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
    if (command.type !== "get_entries") log({ type: command.type, customInstructions: command.customInstructions, message: command.message });
    if (command.type === "get_state") {
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-compact-session", thinkingLevel: "high" } });
    } else if (command.type === "prompt") {
      output({ type: "response", id: command.id, command: "prompt", success: true });
      if (command.message === "slow") setTimeout(() => finishPrompt(command), 300);
      else finishPrompt(command);
    } else if (command.type === "compact") {
      output({ type: "compaction_start", reason: "manual" });
      if (command.customInstructions === "fail") {
        output({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Compaction failed: Nothing to compact" });
        output({ type: "response", id: command.id, command: "compact", success: false, error: "Nothing to compact" });
        continue;
      }
      setTimeout(() => {
        const result = appendCompaction("manual summary");
        output({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
        output({ type: "response", id: command.id, command: "compact", success: true, data: result });
      }, 50);
    } else if (command.type === "get_commands") {
      output({ type: "response", id: command.id, command: "get_commands", success: true, data: { commands: [
        { name: "review", description: " Review the diff ", source: "extension", sourceInfo: {} },
        { name: "yep:side-v1", description: "internal", source: "extension", sourceInfo: {} },
        { name: "fix-tests", description: "Fix failing tests", source: "prompt", sourceInfo: {} },
        { name: "skill:imagegen", source: "skill", sourceInfo: {} },
        { name: "review", description: "duplicate", source: "prompt", sourceInfo: {} },
      ] } });
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
    } else if (command.id) {
      output({ type: "response", id: command.id, command: command.type, success: true });
    }
  }
});
`;

type SdkRecord = Record<string, unknown>;

async function drainUntilResult(
  iterator: AsyncIterableIterator<SdkRecord>,
): Promise<SdkRecord[]> {
  const seen: SdkRecord[] = [];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const next = await iterator.next();
    if (next.done) return seen;
    seen.push(next.value);
    if (next.value.type === "result") return seen;
  }
  throw new Error("Timed out waiting for the Pi turn to settle");
}

const statuses = (messages: SdkRecord[]) =>
  messages
    .filter((m) => m.type === "system" && m.subtype === "status")
    .map((m) => m.status);

describe("PiProvider compaction and / commands", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    // The provider remembers Pi's `/` list in the data dir asynchronously.
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

  async function startSession() {
    const root = join(tmpdir(), `pi-compact-${randomUUID()}`);
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
    const iterator = session.iterator as AsyncIterableIterator<SdkRecord>;
    const commands = async () =>
      (await readFile(join(projectPath, "commands.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as SdkRecord);
    return { session, iterator, commands, cwd: projectPath };
  }

  it("announces Pi's live / list with init and through supportedCommands", async () => {
    const { session, iterator, cwd } = await startSession();
    try {
      const expected = [
        { name: "review", description: "Review the diff", source: "extension" },
        {
          name: "fix-tests",
          description: "Fix failing tests",
          source: "prompt",
        },
        { name: "skill:imagegen", description: "", source: "skill" },
      ];
      const init = await iterator.next();
      expect(init.value).toMatchObject({
        subtype: "init",
        slash_commands: expected,
      });
      await expect(session.supportedCommands?.()).resolves.toEqual(expected);
      await waitForPiCommandCacheWrites();
      await expect(readPiCommandCache(cwd)).resolves.toEqual(expected);
    } finally {
      session.abort();
    }
  });

  it("answers supportedCommands from the cache while Pi is starting", async () => {
    const { session, iterator, cwd } = await startSession();
    try {
      // The iterator has not started, so the RPC client does not exist yet.
      await expect(session.supportedCommands?.()).resolves.toEqual(
        (await readPiCommandCache(cwd)) ?? [],
      );
      await iterator.next();
      await expect(session.supportedCommands?.()).resolves.toHaveLength(3);
    } finally {
      session.abort();
    }
  });

  it("runs a manual compaction between turns with custom instructions", async () => {
    const { session, iterator, commands } = await startSession();
    try {
      // Consume the init message so the session loop is idle on input.
      session.queue.push({ text: "hello", uuid: "client-1" });
      await drainUntilResult(iterator);

      const compacted = session.compact?.({
        customInstructions: "  keep API notes  ",
      });
      const messages = await drainUntilResult(iterator);
      await expect(compacted).resolves.toBeUndefined();

      expect(statuses(messages)).toEqual(["compacting", null]);
      const boundary = messages.find((m) => m.subtype === "compact_boundary");
      expect(boundary).toMatchObject({
        uuid: "compaction-1",
        parentUuid: "assistant-entry-1",
        content: "manual summary",
        timestamp: "2026-09-02T08:00:01.000Z",
      });
      expect(messages.at(-1)?.type).toBe("result");
      expect(
        (await commands()).find((c) => c.type === "compact"),
      ).toMatchObject({ customInstructions: "keep API notes" });

      // The next turn must not replay the manual compaction events.
      session.queue.push({ text: "after", uuid: "client-2" });
      const next = await drainUntilResult(iterator);
      expect(statuses(next)).toEqual([]);
    } finally {
      session.abort();
    }
  });

  it("waits for the active turn instead of aborting it", async () => {
    const { session, iterator, commands } = await startSession();
    try {
      session.queue.push({ text: "slow", uuid: "client-1" });
      // Let the turn start (init, then the user row) before compacting.
      expect((await iterator.next()).value?.subtype).toBe("init");
      expect((await iterator.next()).value?.type).toBe("user");
      const compacted = session.compact?.();
      const turn = await drainUntilResult(iterator);
      expect(statuses(turn)).toEqual([]);
      const compaction = await drainUntilResult(iterator);
      await compacted;
      expect(statuses(compaction)).toEqual(["compacting", null]);

      const types = (await commands()).map((c) => c.type);
      expect(types.indexOf("compact")).toBeGreaterThan(
        types.indexOf("agent_settled"),
      );
      expect(types).not.toContain("abort");
    } finally {
      session.abort();
    }
  });

  it("refuses steering while a compaction runs", async () => {
    const { session, iterator } = await startSession();
    try {
      session.queue.push({ text: "hello", uuid: "client-1" });
      await drainUntilResult(iterator);
      const compacted = session.compact?.();
      const status = await iterator.next();
      expect(status.value).toMatchObject({
        subtype: "status",
        status: "compacting",
      });
      await expect(
        session.steer?.({ text: "mid", uuid: "client-steer" }),
      ).resolves.toBe(false);
      await drainUntilResult(iterator);
      await compacted;
    } finally {
      session.abort();
    }
  });

  it("rejects with Pi's reason and still ends the busy period", async () => {
    const { session, iterator } = await startSession();
    try {
      session.queue.push({ text: "hello", uuid: "client-1" });
      await drainUntilResult(iterator);
      const compacted = session.compact?.({ customInstructions: "fail" });
      compacted?.catch(() => undefined);
      const messages = await drainUntilResult(iterator);
      await expect(compacted).rejects.toThrow("Nothing to compact");
      expect(statuses(messages)).toEqual(["compacting", null]);
      expect(messages.some((m) => m.subtype === "compact_boundary")).toBe(
        false,
      );
      expect(messages.at(-1)?.type).toBe("result");
    } finally {
      session.abort();
    }
  });

  it("surfaces automatic compaction inside a turn", async () => {
    const { session, iterator } = await startSession();
    try {
      session.queue.push({ text: "auto", uuid: "client-1" });
      const messages = await drainUntilResult(iterator);
      expect(statuses(messages)).toEqual(["compacting", null]);
      expect(
        messages.find((m) => m.subtype === "compact_boundary"),
      ).toMatchObject({ uuid: "compaction-1", content: "auto summary" });
    } finally {
      session.abort();
    }
  });
});
