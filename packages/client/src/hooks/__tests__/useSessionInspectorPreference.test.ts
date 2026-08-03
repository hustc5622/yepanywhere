import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import { useSessionInspectorPreference } from "../useSessionInspectorPreference";

describe("useSessionInspectorPreference", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.sessionInspectorExpanded);
  });

  it("defaults to expanded and persists updates", () => {
    const { result } = renderHook(() => useSessionInspectorPreference());

    expect(result.current.isExpanded).toBe(true);

    act(() => result.current.setIsExpanded(false));

    expect(result.current.isExpanded).toBe(false);
    expect(window.localStorage.getItem(UI_KEYS.sessionInspectorExpanded)).toBe(
      "false",
    );
  });

  it("restores a collapsed preference", () => {
    window.localStorage.setItem(UI_KEYS.sessionInspectorExpanded, "false");

    const { result } = renderHook(() => useSessionInspectorPreference());

    expect(result.current.isExpanded).toBe(false);
  });
});
