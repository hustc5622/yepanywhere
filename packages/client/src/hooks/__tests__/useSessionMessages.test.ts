import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { truncateMessagesForEdit } from "../useSessionMessages";

function message(id: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    type: "user",
    message: { role: "user", content: id },
    ...extra,
  };
}

describe("truncateMessagesForEdit", () => {
  it("preserves the streamed optimistic edit that arrived before resume returned", () => {
    const optimisticEdit = message("edited-stream", { tempId: "temp-edit" });
    const messages = [
      message("before"),
      message("edited-original"),
      message("old-response", { type: "assistant" }),
      optimisticEdit,
    ];

    expect(
      truncateMessagesForEdit(messages, "edited-original", "temp-edit"),
    ).toEqual([messages[0], optimisticEdit]);
  });

  it("keeps the previous truncation behavior without a matching temp id", () => {
    const messages = [
      message("before"),
      message("edited-original"),
      message("old-response", { type: "assistant" }),
    ];

    expect(truncateMessagesForEdit(messages, "edited-original")).toEqual([
      messages[0],
    ]);
  });
});
