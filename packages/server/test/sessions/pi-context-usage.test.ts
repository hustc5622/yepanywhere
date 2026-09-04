import { describe, expect, it } from "vitest";
import { derivePiSession } from "../../src/sessions/normalization.js";

const CONTEXT_WINDOW = 1_000_000;

function content(entries: unknown[]) {
  const all = entries as never[];
  return {
    header: {
      type: "session" as const,
      version: 3,
      id: "s",
      timestamp: "2026-09-03T00:00:00.000Z",
      cwd: "/tmp/p",
    },
    entries: all,
    activeEntries: all,
  } as Parameters<typeof derivePiSession>[0];
}

function derive(entries: unknown[]) {
  return derivePiSession(content(entries), {
    getContextWindow: () => CONTEXT_WINDOW,
  });
}

let seq = 0;

function usage(partial: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}) {
  const input = partial.input ?? 0;
  const output = partial.output ?? 0;
  const cacheRead = partial.cacheRead ?? 0;
  const cacheWrite = partial.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: partial.totalTokens ?? input + output + cacheRead + cacheWrite,
  };
}

function assistant(options: {
  stopReason: string;
  usage?: ReturnType<typeof usage>;
  content?: unknown[];
}) {
  seq += 1;
  return {
    type: "message",
    id: `a-${seq}`,
    parentId: "u",
    timestamp: `2026-09-03T00:00:${String(seq).padStart(2, "0")}.000Z`,
    message: {
      role: "assistant",
      content: options.content ?? [{ type: "text", text: "hi" }],
      model: "claude-opus-5",
      provider: "yep-anthropic-aitl",
      stopReason: options.stopReason,
      ...(options.usage ? { usage: options.usage } : {}),
    },
  };
}

const user = {
  type: "message",
  id: "u",
  parentId: null,
  timestamp: "2026-09-03T00:00:00.500Z",
  message: { role: "user", content: [{ type: "text", text: "go" }] },
};

/** A real turn: half the window used, reported via the provider total. */
const goodTurn = assistant({
  stopReason: "toolUse",
  usage: usage({ input: 2, output: 1952, cacheRead: 499_529, cacheWrite: 660 }),
});

/**
 * Pi persists this exact shape when a request is interrupted — an assistant
 * entry with empty content and an all-zero usage block. Observed in
 * `01a064ed-…` right before the composer meter dropped to 0%.
 */
const abortedTurn = assistant({
  stopReason: "aborted",
  content: [],
  usage: usage({}),
});

const erroredTurn = assistant({
  stopReason: "error",
  content: [],
  usage: usage({}),
});

/**
 * The composer/list context ring reads `contextUsage` straight off the JSONL
 * summary. Pi logs an all-zero usage block for aborted and errored turns, so
 * taking the newest assistant unconditionally reported "0% used" until the
 * next successful reply — which reads as an empty session on mobile, where
 * the numeric label is hidden and the ring is the only signal.
 */
describe("derivePiSession contextUsage", () => {
  it("derives context fill from the newest usable assistant turn", () => {
    expect(derive([user, goodTurn]).contextUsage).toEqual({
      inputTokens: 502_143,
      outputTokens: 1952,
      cacheReadTokens: 499_529,
      cacheCreationTokens: 660,
      contextWindow: CONTEXT_WINDOW,
      percentage: 50,
    });
  });

  it("keeps the last real reading when the next turn is aborted", () => {
    const derived = derive([user, goodTurn, abortedTurn]);
    expect(derived.contextUsage?.inputTokens).toBe(502_143);
    expect(derived.contextUsage?.percentage).toBe(50);
    // The interrupt still has to surface in the turn status.
    expect(derived.lastTurnStatus).toBe("interrupted");
  });

  it("keeps the last real reading when the next turn errors out", () => {
    const derived = derive([user, goodTurn, erroredTurn]);
    expect(derived.contextUsage?.inputTokens).toBe(502_143);
    expect(derived.lastTurnStatus).toBe("failed");
  });

  it("omits contextUsage when no turn ever reported usage", () => {
    // Undefined (not a zeroed record) is what makes the client fall back to
    // the live `context-status` endpoint instead of rendering an empty ring.
    expect(derive([user, abortedTurn]).contextUsage).toBeUndefined();
    expect(
      derive([user, assistant({ stopReason: "stop" })]).contextUsage,
    ).toBeUndefined();
  });

  it("excludes zero-usage turns from cumulative spend", () => {
    const withInterrupt = derive([user, goodTurn, abortedTurn, erroredTurn]);
    expect(withInterrupt.cumulativeUsage).toEqual(
      derive([user, goodTurn]).cumulativeUsage,
    );
    expect(withInterrupt.cumulativeUsage?.turnCount).toBe(1);
  });
});
