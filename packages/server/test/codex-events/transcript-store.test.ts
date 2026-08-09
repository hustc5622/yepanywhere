import { describe, expect, it } from "vitest";
import { InMemoryCodexEventStore } from "../../src/codex-events/store.js";
import {
  exportCanonicalCodexTranscriptFromStore,
  loadCanonicalCodexTranscript,
} from "../../src/codex-events/transcript-store.js";
import { testDraft } from "./helpers.js";

describe("canonical transcript store adapter", () => {
  it("loads and exports exclusively through the canonical event-store contract", async () => {
    const store = new InMemoryCodexEventStore({ now: () => 3_000 });
    await store.append(
      testDraft("turn/started", {
        threadId: "thread-store",
        turn: {
          id: "turn-store",
          status: "inProgress",
          items: [],
          startedAt: 1,
        },
      }),
    );
    await store.append(
      testDraft("item/completed", {
        threadId: "thread-store",
        turnId: "turn-store",
        item: {
          id: "agent-store",
          type: "agentMessage",
          phase: "final_answer",
          text: "canonical only",
        },
      }),
    );

    const atFirstEvent = await loadCanonicalCodexTranscript(
      store,
      "session-1",
      { throughSequence: 1 },
    );
    expect(atFirstEvent.source).toMatchObject({
      kind: "canonical_replay",
      throughSequence: 1,
      eventCount: 1,
    });
    expect(atFirstEvent.entries.some((entry) => entry.kind === "item")).toBe(
      false,
    );

    const exported = await exportCanonicalCodexTranscriptFromStore(
      store,
      "session-1",
      "markdown",
    );
    expect(exported.mediaType).toBe("text/markdown");
    expect(exported.fileName).toBe("codex-transcript-session-1.md");
    expect(exported.body).toContain("canonical only");
    expect(exported.body).toContain("Source: `canonical_replay`");
  });
});
