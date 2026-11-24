import type { CursorTranscriptMessage } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { deriveCursorLastTurnStatus } from "../../src/sessions/cursor-reader.js";

const user = (text = "Hi"): CursorTranscriptMessage => ({
  id: `u-${text}`,
  role: "user",
  text,
});
const answer = (text = "Done"): CursorTranscriptMessage => ({
  id: `a-${text}`,
  role: "assistant",
  text,
  blocks: [{ type: "text", text }],
});
const call = (id: string): CursorTranscriptMessage => ({
  id: `c-${id}`,
  role: "assistant",
  text: "",
  blocks: [{ type: "tool_use", id, name: "Bash", input: {} }],
});
const result = (id: string): CursorTranscriptMessage => ({
  id: `r-${id}`,
  role: "tool",
  text: "",
  blocks: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

describe("deriveCursorLastTurnStatus", () => {
  it("has no status without a turn", () => {
    expect(deriveCursorLastTurnStatus([])).toBeUndefined();
  });

  it("reports an answered turn as completed", () => {
    expect(
      deriveCursorLastTurnStatus([user(), call("t1"), result("t1"), answer()]),
    ).toBe("completed");
  });

  it("ignores trailing compaction markers and task notices", () => {
    expect(
      deriveCursorLastTurnStatus([
        user(),
        answer(),
        { id: "n", role: "notice", text: "task finished" },
        { id: "c", role: "compaction", text: "summary" },
      ]),
    ).toBe("completed");
  });

  it("reports a history that stops mid-turn as incomplete", () => {
    expect(deriveCursorLastTurnStatus([user()])).toBe("incomplete");
    expect(deriveCursorLastTurnStatus([user(), call("t1"), result("t1")])).toBe(
      "incomplete",
    );
    expect(deriveCursorLastTurnStatus([user(), call("t1")])).toBe("incomplete");
  });

  it("reports a Cursor backend error as failed", () => {
    expect(
      deriveCursorLastTurnStatus([
        user(),
        answer("Error: [unavailable] backend is down"),
      ]),
    ).toBe("failed");
  });
});
