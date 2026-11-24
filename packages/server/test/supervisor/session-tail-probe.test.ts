import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasSessionTailProbe,
  probeSessionTailActivity,
} from "../../src/supervisor/session-tail-probe.js";

const jsonl = (rows: unknown[]) =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

describe("probeSessionTailActivity", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `tail-probe-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const file = async (rows: unknown[]) => {
    const path = join(dir, `${randomUUID()}.jsonl`);
    await writeFile(path, jsonl(rows));
    return path;
  };

  it("has no tail probe for providers that cannot settle a turn", async () => {
    expect(hasSessionTailProbe("cursor")).toBe(false);
    expect(hasSessionTailProbe("claude")).toBe(false);
    expect(
      await probeSessionTailActivity("cursor", join(dir, "store.db")),
    ).toEqual({ turn: "unknown" });
    expect(await probeSessionTailActivity("agy", undefined)).toEqual({
      turn: "unknown",
    });
  });

  it("reads an agy transcript: a tool step is in flight, an answer settles", async () => {
    const working = await file([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: {} }],
      },
    ]);
    expect((await probeSessionTailActivity("agy", working)).turn).toBe(
      "in-flight",
    );
    const answered = await file([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT" },
      { step_index: 1, type: "PLANNER_RESPONSE", content: "Done." },
    ]);
    expect((await probeSessionTailActivity("agy", answered)).turn).toBe(
      "settled",
    );
  });

  it("reads a Codex rollout by its turn markers", async () => {
    const event = (type: string) => ({
      type: "event_msg",
      timestamp: new Date().toISOString(),
      payload: { type },
    });
    const meta = {
      type: "session_meta",
      timestamp: new Date().toISOString(),
      payload: { id: "s", cwd: "/tmp", timestamp: new Date().toISOString() },
    };
    expect(
      (
        await probeSessionTailActivity(
          "codex",
          await file([meta, event("task_started"), event("task_complete")]),
        )
      ).turn,
    ).toBe("settled");
    expect(
      (
        await probeSessionTailActivity(
          "codex",
          await file([meta, event("task_complete"), event("task_started")]),
        )
      ).turn,
    ).toBe("in-flight");
    expect(
      (await probeSessionTailActivity("codex", await file([meta]))).turn,
    ).toBe("unknown");
  });

  it("reads MiniMax Code rows without the Pi envelope", async () => {
    const row = (message: Record<string, unknown>) => ({
      message_id: randomUUID(),
      turn_id: "t",
      message,
    });
    const settled = await file([
      row({ role: "user", content: "Hi" }),
      row({ role: "assistant", content: [], stopReason: "stop" }),
      // Non-conversation rows after the answer do not reopen the turn.
      row({ role: "custom", customType: "background_task_read_settlement" }),
    ]);
    expect((await probeSessionTailActivity("mcode", settled)).turn).toBe(
      "settled",
    );
    const working = await file([
      row({ role: "user", content: "Hi" }),
      row({ role: "assistant", content: [], stopReason: "toolUse" }),
    ]);
    expect((await probeSessionTailActivity("mcode", working)).turn).toBe(
      "in-flight",
    );
  });
});
