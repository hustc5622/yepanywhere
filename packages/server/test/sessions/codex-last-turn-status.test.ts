import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexSessionEntry, UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexSessionReader,
  deriveCodexLastTurnStatus,
} from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";

const at = () => new Date().toISOString();
const event = (payload: Record<string, unknown>) =>
  ({ type: "event_msg", timestamp: at(), payload }) as CodexSessionEntry;
const prompt = event({ type: "user_message", message: "Hello" });
const started = event({ type: "task_started" });
const complete = event({ type: "task_complete" });
const aborted = event({ type: "turn_aborted", reason: "interrupted" });
const call = {
  type: "response_item",
  timestamp: at(),
  payload: { type: "function_call", name: "shell", call_id: "c1" },
} as unknown as CodexSessionEntry;

describe("deriveCodexLastTurnStatus", () => {
  it("follows the newest turn's start and terminal markers", () => {
    expect(deriveCodexLastTurnStatus([])).toBeUndefined();
    expect(deriveCodexLastTurnStatus([started, prompt, complete])).toBe(
      "completed",
    );
    expect(deriveCodexLastTurnStatus([started, prompt, aborted])).toBe(
      "interrupted",
    );
    expect(
      deriveCodexLastTurnStatus([
        started,
        prompt,
        event({ type: "task_complete", error: { message: "boom" } }),
      ]),
    ).toBe("failed");
    // A new turn after a finished one, cut off mid tool call.
    expect(
      deriveCodexLastTurnStatus([started, prompt, complete, started, call]),
    ).toBe("incomplete");
    expect(deriveCodexLastTurnStatus([started, prompt, complete, prompt])).toBe(
      "incomplete",
    );
  });
});

describe("CodexSessionReader lastTurnStatus", () => {
  let testDir: string;
  let reader: CodexSessionReader;

  beforeEach(async () => {
    testDir = join(tmpdir(), `codex-last-turn-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    reader = new CodexSessionReader({ sessionsDir: testDir });
  });

  afterEach(async () => {
    invalidateCodexSessionManifest(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  async function summary(entries: CodexSessionEntry[]) {
    const sessionId = randomUUID();
    const meta = {
      type: "session_meta",
      timestamp: at(),
      payload: { id: sessionId, cwd: "/test/project", timestamp: at() },
    };
    await writeFile(
      join(testDir, `rollout-${sessionId}.jsonl`),
      `${[meta, ...entries].map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    invalidateCodexSessionManifest(testDir);
    return reader.getSessionSummary(sessionId, "p" as UrlProjectId);
  }

  it("reports a finished rollout as completed", async () => {
    expect((await summary([started, prompt, complete]))?.lastTurnStatus).toBe(
      "completed",
    );
  });

  it("reports a rollout that stops mid-turn as incomplete", async () => {
    expect((await summary([started, prompt, call]))?.lastTurnStatus).toBe(
      "incomplete",
    );
  });
});
