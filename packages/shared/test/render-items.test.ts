import { describe, expect, it } from "vitest";
import {
  CODEX_THREAD_ITEM_RENDER_POLICY,
  CODEX_THREAD_ITEM_TYPES,
  NATIVE_RENDER_ITEM_TYPES,
  isNativeRenderItemType,
} from "../src/render-items.js";

describe("native render item coverage", () => {
  it("classifies every generated Codex ThreadItem variant exactly once", () => {
    expect(CODEX_THREAD_ITEM_TYPES).toHaveLength(18);
    expect(new Set(CODEX_THREAD_ITEM_TYPES).size).toBe(18);
    expect(Object.keys(CODEX_THREAD_ITEM_RENDER_POLICY).sort()).toEqual(
      [...CODEX_THREAD_ITEM_TYPES].sort(),
    );
  });

  it("exposes a stable runtime type guard for the exhaustive client registry", () => {
    for (const type of NATIVE_RENDER_ITEM_TYPES) {
      expect(isNativeRenderItemType(type)).toBe(true);
    }
    expect(isNativeRenderItemType("future_item")).toBe(false);
  });
});
