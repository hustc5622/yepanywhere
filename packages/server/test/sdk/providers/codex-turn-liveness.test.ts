import { describe, expect, it, vi } from "vitest";
import { nextTurnEvent } from "../../../src/sdk/providers/codex-turn-liveness.js";

const fast = { idleMs: 20, probeTimeoutMs: 20 };

describe("Codex turn liveness", () => {
  it("returns events without probing while the turn is chatty", async () => {
    const probe = vi.fn(async () => ({}));
    await expect(
      nextTurnEvent(async () => "event", probe, vi.fn(), fast),
    ).resolves.toBe("event");
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps waiting through a quiet tool call when the server answers probes", async () => {
    const probe = vi.fn(async () => ({}));
    const close = vi.fn();
    const event = new Promise<string>((resolve) =>
      setTimeout(() => resolve("late event"), 90),
    );
    await expect(nextTurnEvent(() => event, probe, close, fast)).resolves.toBe(
      "late event",
    );
    expect(probe.mock.calls.length).toBeGreaterThan(0);
    expect(close).not.toHaveBeenCalled();
  });

  it("closes an app-server that stops answering mid-turn", async () => {
    let rejectPending: (error: Error) => void = () => {};
    const pending = new Promise<string>((_resolve, reject) => {
      rejectPending = reject;
    });
    const close = vi.fn(() => rejectPending(new Error("client closed")));
    await expect(
      nextTurnEvent(
        () => pending,
        () => new Promise(() => {}),
        close,
        fast,
      ),
    ).rejects.toThrow(/stopped responding during a turn/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
