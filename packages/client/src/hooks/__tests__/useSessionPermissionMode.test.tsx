import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionPermissionMode } from "../useSessionPermissionMode";

const { setPermissionModeMock } = vi.hoisted(() => ({
  setPermissionModeMock: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { setPermissionMode: setPermissionModeMock },
}));

afterEach(() => {
  setPermissionModeMock.mockReset();
});

describe("useSessionPermissionMode", () => {
  it("uses the mode returned while navigating from new-session setup", () => {
    const { result } = renderHook(() =>
      useSessionPermissionMode("ses_1", "self", "bypassPermissions", 3),
    );

    expect(result.current.permissionMode).toBe("bypassPermissions");
    expect(result.current.modeVersion).toBe(3);
  });

  it("applies server updates monotonically by version", () => {
    const { result } = renderHook(() =>
      useSessionPermissionMode("ses_1", "none"),
    );

    act(() => result.current.applyServerModeUpdate("plan", 2));
    expect(result.current.permissionMode).toBe("plan");
    expect(result.current.modeVersion).toBe(2);

    // A stale (lower-version) update is ignored.
    act(() => result.current.applyServerModeUpdate("acceptEdits", 1));
    expect(result.current.permissionMode).toBe("plan");
    expect(result.current.modeVersion).toBe(2);
  });

  it("persists the selected mode when the session is idle", async () => {
    setPermissionModeMock.mockResolvedValue({
      permissionMode: "plan",
      modeVersion: 0,
    });
    const { result } = renderHook(() =>
      useSessionPermissionMode("ses_1", "none"),
    );

    await act(async () => {
      await result.current.setPermissionMode("plan");
    });

    expect(result.current.permissionMode).toBe("plan");
    expect(setPermissionModeMock).toHaveBeenCalledWith("ses_1", "plan");
    expect(result.current.serverMode).toBe("plan");
  });

  it("syncs to the server and adopts the confirmed version when owned", async () => {
    setPermissionModeMock.mockResolvedValue({
      permissionMode: "acceptEdits",
      modeVersion: 5,
    });
    const { result } = renderHook(() =>
      useSessionPermissionMode("ses_1", "self"),
    );

    await act(async () => {
      await result.current.setPermissionMode("acceptEdits");
    });

    expect(setPermissionModeMock).toHaveBeenCalledWith("ses_1", "acceptEdits");
    expect(result.current.modeVersion).toBe(5);
    expect(result.current.serverMode).toBe("acceptEdits");
  });
});
