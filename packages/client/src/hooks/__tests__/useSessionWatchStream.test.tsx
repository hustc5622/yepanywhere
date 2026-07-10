import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionWatchStream } from "../useSessionWatchStream";

const mocks = vi.hoisted(() => {
  const close = vi.fn();
  return {
    close,
    subscribeSessionWatch: vi.fn(() => ({ close })),
    connectionManager: {
      on: vi.fn(() => () => {}),
      markConnected: vi.fn(),
      recordEvent: vi.fn(),
      recordHeartbeat: vi.fn(),
      handleError: vi.fn(),
    },
  };
});

vi.mock("../../lib/connection", () => ({
  connectionManager: mocks.connectionManager,
  getWebSocketConnection: () => ({
    subscribeSessionWatch: mocks.subscribeSessionWatch,
  }),
  isNonRetryableError: () => false,
}));

describe("useSessionWatchStream", () => {
  afterEach(() => {
    mocks.close.mockClear();
    mocks.subscribeSessionWatch.mockClear();
    mocks.connectionManager.on.mockClear();
  });

  it("keeps the focused subscription when target object identity changes", () => {
    const { rerender, unmount } = renderHook(() =>
      useSessionWatchStream(
        {
          sessionId: "ses_1",
          projectId: "project_1",
          provider: "opencode",
        },
        { onChange: vi.fn() },
      ),
    );

    expect(mocks.subscribeSessionWatch).toHaveBeenCalledTimes(1);

    // The hook body creates a new target object on every parent render.
    rerender();

    expect(mocks.subscribeSessionWatch).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();

    unmount();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
