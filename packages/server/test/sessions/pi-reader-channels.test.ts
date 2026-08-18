import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("Pi session reader gateway channels", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("re-attaches the channel namespace recorded in the generated provider id", async () => {
    const sessionsDir = join(tmpdir(), `pi-channel-sessions-${randomUUID()}`);
    const projectPath = join(tmpdir(), `pi-channel-project-${randomUUID()}`);
    const projectDir = join(sessionsDir, "--pi-channel-project--");
    tempDirs.push(sessionsDir);
    await mkdir(projectDir, { recursive: true });

    const sessionId = randomUUID();
    await writeFile(
      join(projectDir, `session_${sessionId}.jsonl`),
      jsonl([
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-08-17T00:00:00.000Z",
          cwd: projectPath,
        },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp: "2026-08-17T00:00:01.000Z",
          // Pi stores the bare gateway id plus Yep's generated provider id.
          provider: "yep-anthropic-aitl",
          modelId: "claude-opus-5",
        },
        {
          type: "message",
          id: "user",
          parentId: "model",
          timestamp: "2026-08-17T00:00:02.000Z",
          message: { role: "user", content: "hello", timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant",
          parentId: "user",
          timestamp: "2026-08-17T00:00:03.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            provider: "yep-anthropic-aitl",
            model: "claude-opus-5",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            stopReason: "stop",
            timestamp: 2,
          },
        },
      ]),
    );

    const reader = new PiSessionReader({ sessionsDir });
    await expect(
      reader.getSessionSummary(sessionId, encodeProjectId(projectPath)),
    ).resolves.toMatchObject({ provider: "pi", model: "aitl/claude-opus-5" });
  });

  it("leaves default-channel models bare", async () => {
    const sessionsDir = join(tmpdir(), `pi-default-sessions-${randomUUID()}`);
    const projectPath = join(tmpdir(), `pi-default-project-${randomUUID()}`);
    const projectDir = join(sessionsDir, "--pi-default-project--");
    tempDirs.push(sessionsDir);
    await mkdir(projectDir, { recursive: true });

    const sessionId = randomUUID();
    await writeFile(
      join(projectDir, `session_${sessionId}.jsonl`),
      jsonl([
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-08-17T00:00:00.000Z",
          cwd: projectPath,
        },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp: "2026-08-17T00:00:01.000Z",
          provider: "yep-anthropic",
          modelId: "claude-opus-4-8",
        },
        {
          type: "message",
          id: "user",
          parentId: "model",
          timestamp: "2026-08-17T00:00:02.000Z",
          message: { role: "user", content: "hello", timestamp: 1 },
        },
      ]),
    );

    const reader = new PiSessionReader({ sessionsDir });
    await expect(
      reader.getSessionSummary(sessionId, encodeProjectId(projectPath)),
    ).resolves.toMatchObject({ model: "claude-opus-4-8" });
  });
});
