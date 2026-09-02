import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  DEFAULT_SEARCH_SORT,
  parseSearchSort,
  useSearchSortPreference,
} from "../useSearchSortPreference";

describe("useSearchSortPreference", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(UI_KEYS.searchSort);
  });

  it("defaults to the recency ordering and persists updates", () => {
    const { result } = renderHook(() => useSearchSortPreference());

    expect(result.current.storedSort).toBe(DEFAULT_SEARCH_SORT);
    expect(DEFAULT_SEARCH_SORT).toBe("recent");

    act(() => result.current.rememberSort("relevance"));

    expect(result.current.storedSort).toBe("relevance");
    expect(window.localStorage.getItem(UI_KEYS.searchSort)).toBe("relevance");
  });

  it("restores a stored preference on the next visit", () => {
    window.localStorage.setItem(UI_KEYS.searchSort, "relevance");

    const { result } = renderHook(() => useSearchSortPreference());

    expect(result.current.storedSort).toBe("relevance");
  });

  it("ignores a corrupted stored value", () => {
    window.localStorage.setItem(UI_KEYS.searchSort, "oldest-first");

    const { result } = renderHook(() => useSearchSortPreference());

    expect(result.current.storedSort).toBe(DEFAULT_SEARCH_SORT);
  });
});

describe("parseSearchSort", () => {
  it("accepts only known orderings", () => {
    expect(parseSearchSort("recent")).toBe("recent");
    expect(parseSearchSort("relevance")).toBe("relevance");
    expect(parseSearchSort("matches")).toBeNull();
    expect(parseSearchSort(null)).toBeNull();
    expect(parseSearchSort(undefined)).toBeNull();
  });
});
