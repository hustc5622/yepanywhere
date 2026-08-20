import { describe, expect, it } from "vitest";
import { derivePiSession } from "../../src/sessions/normalization.js";

function content(id: string, entries: unknown[]) {
  const all = entries as never[];
  return {
    header: {
      type: "session" as const,
      version: 3,
      id,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd: "/tmp/p",
    },
    entries: all,
    activeEntries: all,
  } as Parameters<typeof derivePiSession>[0];
}

function assistant(stopReason: string) {
  return {
    type: "message",
    id: `a-${stopReason}`,
    parentId: "u",
    timestamp: "2026-08-19T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stopReason,
    },
  };
}

const user = {
  type: "message",
  id: "u",
  parentId: null,
  timestamp: "2026-08-19T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text: "go" }] },
};

const toolResult = {
  type: "message",
  id: "tr",
  parentId: "a-toolUse",
  timestamp: "2026-08-19T00:00:03.000Z",
  message: {
    role: "toolResult",
    toolCallId: "c1",
    content: [{ type: "text", text: "ok" }],
  },
};

/**
 * `lastTurnStatus` drives the "interrupted" affordance in session lists. Pi
 * ends a turn only on a terminal stop reason: a log whose newest entry is a
 * tool call or a tool result was cut short, and reporting those as completed
 * hid every session that died mid-tool.
 */
describe("derivePiSession lastTurnStatus", () => {
  it("reports a terminal stop reason as completed", () => {
    for (const stopReason of ["stop", "length"]) {
      expect(
        derivePiSession(content("s", [user, assistant(stopReason)]))
          .lastTurnStatus,
      ).toBe("completed");
    }
  });

  it("reports an error stop reason as failed", () => {
    expect(
      derivePiSession(content("s", [user, assistant("error")])).lastTurnStatus,
    ).toBe("failed");
  });

  it("reports a turn cut off mid tool call as interrupted", () => {
    expect(
      derivePiSession(content("s", [user, assistant("toolUse")]))
        .lastTurnStatus,
    ).toBe("interrupted");
    expect(
      derivePiSession(content("s", [user, assistant("aborted")]))
        .lastTurnStatus,
    ).toBe("interrupted");
    expect(
      derivePiSession(content("s", [user, assistant("pending")]))
        .lastTurnStatus,
    ).toBe("interrupted");
  });

  it("reports a trailing tool result as interrupted", () => {
    expect(
      derivePiSession(content("s", [user, assistant("toolUse"), toolResult]))
        .lastTurnStatus,
    ).toBe("interrupted");
  });

  it("reports an unanswered prompt as interrupted", () => {
    expect(
      derivePiSession(content("s", [assistant("stop"), user])).lastTurnStatus,
    ).toBe("interrupted");
  });

  it("reports no status for a session without assistant turns", () => {
    expect(derivePiSession(content("s", [])).lastTurnStatus).toBeUndefined();
  });
});
