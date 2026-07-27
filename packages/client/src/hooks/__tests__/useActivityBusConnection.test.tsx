import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityBusConnection } from "../useActivityBusConnection";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  refreshConsumers: vi.fn(),
  isMobileShellDocument: vi.fn(() => true),
}));

vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    authEnabled: false,
    isLoading: false,
  }),
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    connect: mocks.connect,
    disconnect: mocks.disconnect,
    refreshConsumers: mocks.refreshConsumers,
  },
}));

vi.mock("../../lib/nativePushBridge", () => ({
  isMobileShellDocument: mocks.isMobileShellDocument,
}));

describe("useActivityBusConnection", () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    if (originalHidden) {
      Object.defineProperty(document, "hidden", originalHidden);
    } else {
      Reflect.deleteProperty(document, "hidden");
    }
  });

  it("suspends mobile-shell subscriptions while hidden and refreshes on return", () => {
    const rendered = renderHook(() => useActivityBusConnection());
    expect(mocks.connect).toHaveBeenCalledOnce();

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.disconnect).toHaveBeenCalledOnce();

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.refreshConsumers).toHaveBeenCalledOnce();

    rendered.unmount();
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);
  });
});
