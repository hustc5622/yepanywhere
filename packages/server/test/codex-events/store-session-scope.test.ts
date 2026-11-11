import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlCodexEventStore } from "../../src/codex-events/index.js";
import { testDraft } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function journal(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-store-scope-"));
  tempDirs.push(directory);
  return join(directory, "events.jsonl");
}

describe("session-scoped JsonlCodexEventStore", () => {
  it("replays exactly the full store's events for its session", async () => {
    const filePath = journal();
    const writer = new JsonlCodexEventStore({ filePath });
    for (let i = 0; i < 5; i++) {
      await writer.append(
        testDraft("item/started", { i }, { sessionId: "a", eventId: `a-${i}` }),
      );
      // A foreign event that mentions session "a" in its payload.
      await writer.append(
        testDraft(
          "item/started",
          { note: '"sessionId":"a"' },
          { sessionId: "b", eventId: `b-${i}` },
        ),
      );
    }

    const full = new JsonlCodexEventStore({ filePath });
    const scoped = new JsonlCodexEventStore({ filePath, sessionId: "a" });
    expect(await scoped.replay({ sessionId: "a" })).toEqual(
      await full.replay({ sessionId: "a" }),
    );
    expect(await scoped.replay({ sessionId: "b" })).toEqual([]);
    expect(await scoped.latestSequence("a")).toBe(5);
    await expect(
      scoped.append(testDraft("warning", {}, { sessionId: "a" })),
    ).rejects.toThrow(/read-only/);
  });

  it("picks up the writer's later appends for its session", async () => {
    const filePath = journal();
    const writer = new JsonlCodexEventStore({ filePath });
    await writer.append(
      testDraft("item/started", {}, { sessionId: "a", eventId: "first" }),
    );
    const scoped = new JsonlCodexEventStore({ filePath, sessionId: "a" });
    expect(await scoped.replay({ sessionId: "a" })).toHaveLength(1);

    await writer.append(
      testDraft("item/started", {}, { sessionId: "b", eventId: "other" }),
    );
    await writer.append(
      testDraft("item/completed", {}, { sessionId: "a", eventId: "second" }),
    );
    const events = await scoped.replay({ sessionId: "a" });
    expect(events.map((event) => event.eventId)).toEqual(["first", "second"]);
  });
});
