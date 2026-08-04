import { describe, expect, it } from "vitest";
import {
  buildSubagentStatChips,
  formatCompactTokens,
  formatSubagentDuration,
  joinStatChips,
  subagentTotalTokens,
} from "../subagentStats";

describe("formatCompactTokens", () => {
  it("keeps small numbers whole", () => {
    expect(formatCompactTokens(940)).toBe("940");
    expect(formatCompactTokens(0)).toBe("0");
  });

  it("formats thousands, trimming trailing .0", () => {
    expect(formatCompactTokens(43000)).toBe("43K");
    expect(formatCompactTokens(66963)).toBe("67K");
    // The acceptance-session cumulative totals.
    expect(formatCompactTokens(596509)).toBe("596.5K");
    expect(formatCompactTokens(207971)).toBe("208K");
  });

  it("formats millions", () => {
    expect(formatCompactTokens(1_234_567)).toBe("1.2M");
    expect(formatCompactTokens(12_000_000)).toBe("12M");
  });
});

describe("formatSubagentDuration", () => {
  it("formats the acceptance-session durations", () => {
    expect(formatSubagentDuration(265103)).toBe("4m 25s"); // agent-0
    expect(formatSubagentDuration(139774)).toBe("2m 19s"); // agent-1 (~2m20s)
  });

  it("formats seconds and hours", () => {
    expect(formatSubagentDuration(45000)).toBe("45s");
    expect(formatSubagentDuration(3_665_000)).toBe("1h 1m");
  });
});

describe("subagentTotalTokens", () => {
  it("prefers explicit totalTokens", () => {
    expect(subagentTotalTokens({ totalTokens: 500 })).toBe(500);
  });

  it("sums the breakdown when total is absent", () => {
    expect(
      subagentTotalTokens({
        inputOther: 100,
        inputCacheRead: 200,
        inputCacheCreation: 0,
        output: 50,
      }),
    ).toBe(350);
  });

  it("returns undefined when no usage is present", () => {
    expect(subagentTotalTokens(undefined)).toBeUndefined();
    expect(subagentTotalTokens({})).toBeUndefined();
  });
});

describe("buildSubagentStatChips", () => {
  it("omits missing metrics — never zero-fills", () => {
    expect(buildSubagentStatChips(undefined)).toEqual([]);
    expect(buildSubagentStatChips({ toolUseCount: 0, durationMs: 0 })).toEqual(
      [],
    );
  });

  it("builds the completed header (ctx + total + tools + duration)", () => {
    const chips = buildSubagentStatChips({
      toolUseCount: 33,
      durationMs: 265103,
      usage: { contextTokens: 66963, totalTokens: 596509 },
    });
    expect(joinStatChips(chips)).toBe(
      "4m 25s · 33 tools · 67K ctx · 596.5K total",
    );
  });

  it("hides the cumulative total while running (moving number)", () => {
    const chips = buildSubagentStatChips(
      {
        toolUseCount: 18,
        durationMs: 134000,
        usage: { contextTokens: 43000, totalTokens: 123456 },
      },
      { showTotal: false },
    );
    expect(joinStatChips(chips)).toBe("2m 14s · 18 tools · 43K ctx");
    expect(chips.find((c) => c.key === "total")).toBeUndefined();
  });

  it("uses a live elapsed override when provided", () => {
    const chips = buildSubagentStatChips(
      { toolUseCount: 5, durationMs: 1000 },
      { elapsedMs: 134000, showTotal: false },
    );
    expect(chips.find((c) => c.key === "elapsed")?.label).toBe("2m 14s");
  });

  it("uses caller-supplied localized labels", () => {
    const chips = buildSubagentStatChips(
      {
        toolUseCount: 33,
        durationMs: 265103,
        usage: { contextTokens: 66963, totalTokens: 596509 },
      },
      {
        labels: {
          seconds: (count) => `${count}秒`,
          minutesSeconds: (minutes, seconds) => `${minutes}分 ${seconds}秒`,
          hoursMinutes: (hours, minutes) => `${hours}小时 ${minutes}分`,
          tools: (count) => `${count} 个工具`,
          context: (tokens) => `上下文 ${tokens}`,
          total: (tokens) => `总计 ${tokens}`,
        },
      },
    );

    expect(joinStatChips(chips)).toBe(
      "4分 25秒 · 33 个工具 · 上下文 67K · 总计 596.5K",
    );
  });
});
