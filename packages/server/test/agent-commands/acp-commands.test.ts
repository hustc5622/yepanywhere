import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpCommandTracker,
  normalizeAcpCommands,
} from "../../src/agent-commands/acp-commands.js";
import {
  readAgentCommandCache,
  waitForAgentCommandCacheWrites,
} from "../../src/agent-commands/command-cache.js";

describe("ACP command lists", () => {
  // A private directory: the atomic writer tightens its parent's mode.
  const cacheDir = join(tmpdir(), `agent-commands-${randomUUID()}`);
  const cachePath = join(cacheDir, "agent-commands.json");
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("tags MiniMax Code skills and drops commands Yep cannot use", () => {
    expect(
      normalizeAcpCommands("mcode", [
        { name: "new", description: "Start a new session" },
        { name: "compact", description: "Compact", input: { hint: "[x]" } },
        { name: "pdf", description: "[Skill] Read PDFs" },
        { name: "bare", description: "[Skill]" },
      ]),
    ).toEqual([
      { name: "compact", description: "Compact", argumentHint: "[x]" },
      { name: "pdf", description: "Read PDFs", source: "skill" },
      { name: "bare", description: "", source: "skill" },
    ]);
    expect(
      normalizeAcpCommands("cursor", [
        { name: "copy-request-id", description: "Copy" },
        { name: "canvas", description: "Canvas" },
      ]),
    ).toEqual([{ name: "canvas", description: "Canvas" }]);
  });

  it("tracks the latest update and caches it per directory", async () => {
    const tracker = new AcpCommandTracker("cursor", "/repo", cachePath);
    const pending = tracker.current(1_000);
    expect(
      tracker.accept({ sessionId: "s", update: { sessionUpdate: "plan" } }),
    ).toBe(false);
    expect(
      tracker.accept({
        sessionId: "s",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "canvas", description: "Canvas" }],
        },
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual([
      { name: "canvas", description: "Canvas" },
    ]);
    await waitForAgentCommandCacheWrites();
    await expect(
      readAgentCommandCache("cursor", "/repo", cachePath),
    ).resolves.toEqual([{ name: "canvas", description: "Canvas" }]);
    await expect(
      readAgentCommandCache("mcode", "/repo", cachePath),
    ).resolves.toBeNull();
  });

  it("stops waiting when no list arrives", async () => {
    const tracker = new AcpCommandTracker("mcode", "/repo", cachePath);
    await expect(tracker.current(10)).resolves.toBeNull();
  });
});
