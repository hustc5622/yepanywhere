import { describe, expect, it } from "vitest";
import {
  BudgetedCache,
  SharedByteBudget,
} from "../../src/utils/budgetedCache.js";

describe("BudgetedCache", () => {
  it("evicts least-recently-used entries across caches sharing a budget", () => {
    const budget = new SharedByteBudget(100);
    const a = new BudgetedCache<string>(budget);
    const b = new BudgetedCache<string>(budget);
    a.set("a1", "x", 20);
    b.set("b1", "x", 20);
    a.set("a2", "x", 20);
    expect(a.get("a1")).toBe("x"); // a1 is now the most recent
    b.set("b2", "x", 25);
    b.set("b3", "x", 25); // 110 bytes: the oldest (b1) goes
    expect(b.get("b1")).toBeUndefined();
    expect(a.get("a1")).toBe("x");
    expect(budget.usedBytes).toBe(90);
  });

  it("does not retain a value larger than a quarter of the budget", () => {
    const budget = new SharedByteBudget(100);
    const cache = new BudgetedCache<string>(budget);
    cache.set("big", "x", 26);
    expect(cache.size).toBe(0);
    expect(budget.usedBytes).toBe(0);
  });

  it("releases bytes on delete, replace and clear", () => {
    const budget = new SharedByteBudget(100);
    const cache = new BudgetedCache<string>(budget);
    cache.set("k", "one", 10);
    cache.set("k", "two", 15);
    expect(budget.usedBytes).toBe(15);
    cache.set("other", "x", 5);
    cache.delete("k");
    expect(budget.usedBytes).toBe(5);
    cache.clear();
    expect(budget.usedBytes).toBe(0);
  });
});
