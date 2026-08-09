import { describe, expect, it, vi } from "vitest";
import { respondToAnyBridgeInput } from "../../src/bridge-common/multi.js";
import type {
  BridgeController,
  BridgeInputResolutionContext,
} from "../../src/bridge-common/types.js";

describe("bridge aggregation", () => {
  it("forwards the broker claim context with the provider response", async () => {
    const firstResponse = vi.fn(async () => false);
    const secondResponse = vi.fn(async () => true);
    const controllers = [
      { respondToInput: firstResponse } as unknown as BridgeController,
      { respondToInput: secondResponse } as unknown as BridgeController,
    ];
    const context: BridgeInputResolutionContext = {
      operationId: "operation-1",
      operationVersion: 2,
      actor: { id: "actor-1", channel: "yep" },
    };

    await expect(
      respondToAnyBridgeInput(
        controllers,
        "session-1",
        "request-1",
        "approve_for_session",
        context,
        { choice: "Continue" },
      ),
    ).resolves.toBe(true);

    expect(firstResponse).toHaveBeenCalledWith(
      "session-1",
      "request-1",
      "approve_for_session",
      { choice: "Continue" },
      context,
    );
    expect(secondResponse).toHaveBeenCalledWith(
      "session-1",
      "request-1",
      "approve_for_session",
      { choice: "Continue" },
      context,
    );
  });
});
