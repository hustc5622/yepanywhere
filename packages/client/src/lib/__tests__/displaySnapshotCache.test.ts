import type { SessionDisplaySnapshot } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { DisplaySnapshotCache } from "../displaySnapshotCache";

const snapshot = (seq = 0): SessionDisplaySnapshot => ({
  version: 2,
  view: { sessionId: "s", branchScopeId: "active", epoch: "e" },
  seq,
  nodes: [],
  activity: { state: "completed", tools: [], runningCount: 0 },
});
afterEach(() => vi.restoreAllMocks());

it("only serializes the changed session, including eviction", () => {
  const cache = new DisplaySnapshotCache();
  for (let i = 0; i < 5; i++) cache.set(String(i), snapshot());
  const stringify = vi.spyOn(JSON, "stringify");
  for (let i = 0; i < 100; i++) cache.set("0", snapshot(i));
  expect(stringify).toHaveBeenCalledTimes(100);
  cache.set("new", snapshot());
  expect(stringify).toHaveBeenCalledTimes(101);
  expect(cache.has("1")).toBe(false);
  expect(cache.has("0")).toBe(true);
});

it("subtracts replacement bytes and evicts by last write, not read", () => {
  const value = snapshot();
  const cache = new DisplaySnapshotCache(JSON.stringify(value).length * 2 * 2);
  cache.set("a", value);
  cache.set("b", value);
  cache.set("a", value);
  cache.get("b");
  cache.set("c", value);
  expect(cache.has("b")).toBe(false);
  expect(cache.get("a")).toBe(value);
  expect(cache.get("c")).toBe(value);
});

it("evicts oversized entries and clears byte accounting", () => {
  const value = snapshot();
  const budget = JSON.stringify(value).length * 2;
  const cache = new DisplaySnapshotCache(budget);
  cache.set("a", value);
  cache.clear();
  cache.set("b", value);
  expect(cache.get("b")).toBe(value);
  cache.set("oversized", {
    ...value,
    view: { ...value.view, sessionId: "x".repeat(1000) },
  });
  expect(cache.has("b")).toBe(false);
  expect(cache.has("oversized")).toBe(false);
  cache.set("c", value);
  expect(cache.get("c")).toBe(value);
});
