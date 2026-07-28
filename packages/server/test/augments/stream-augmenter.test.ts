import { describe, expect, it } from "vitest";
import {
  type MarkdownAugmentData,
  type PendingData,
  createStreamAugmenter,
} from "../../src/augments/stream-augmenter.js";

interface Captured {
  augments: MarkdownAugmentData[];
  pending: PendingData[];
}

async function createHarness() {
  const captured: Captured = { augments: [], pending: [] };
  const augmenter = await createStreamAugmenter({
    onMarkdownAugment: (data) => captured.augments.push(data),
    onPending: (data) => captured.pending.push(data),
  });
  return { augmenter, captured };
}

describe("createStreamAugmenter", () => {
  it("does not replay a streamed message's text through the coordinator", async () => {
    const { augmenter, captured } = await createHarness();

    await augmenter.processMessage({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg_1", role: "assistant", content: [] },
      },
    });
    await augmenter.processMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "First paragraph.\n\n" },
      },
    });
    await augmenter.processMessage({
      type: "stream_event",
      event: { type: "message_stop" },
    });

    const streamedAugments = captured.augments.length;
    const streamedPending = captured.pending.length;
    expect(streamedAugments).toBeGreaterThan(0);

    // The final assistant message repeats the already-streamed text. It should
    // only produce the uuid-keyed final render, never new streaming blocks.
    await augmenter.processMessage({
      type: "assistant",
      uuid: "msg_1",
      message: { role: "assistant", content: "First paragraph.\n\n" },
    });

    const newAugments = captured.augments.slice(streamedAugments);
    expect(newAugments).toHaveLength(1);
    expect(newAugments[0]?.messageId).toBe("msg_1");
    expect(newAugments[0]?.blockIndex).toBeUndefined();
    expect(captured.pending).toHaveLength(streamedPending);
  });

  it("keeps rendering whole-text assistant messages that never streamed", async () => {
    const { augmenter, captured } = await createHarness();

    await augmenter.processMessage({
      type: "assistant",
      uuid: "msg_gemini",
      message: { role: "assistant", content: "Whole answer.\n\n" },
    });

    // Final render plus at least one coordinator-produced streaming block.
    expect(
      captured.augments.some(
        (augment) =>
          augment.messageId === "msg_gemini" &&
          augment.blockIndex === undefined,
      ),
    ).toBe(true);
    expect(
      captured.augments.some((augment) => augment.blockIndex !== undefined) ||
        captured.pending.length > 0,
    ).toBe(true);
  });
});
