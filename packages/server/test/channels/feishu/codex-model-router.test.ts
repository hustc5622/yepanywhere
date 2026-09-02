import { describe, expect, it, vi } from "vitest";
import { FeishuCodexModelRouter } from "../../../src/channels/feishu/codex-model-router.js";
import type { CodexUsageSnapshot } from "../../../src/codex-bridge/types.js";

describe("FeishuCodexModelRouter", () => {
  it("keeps all Feishu scopes on DeepSeek until the shared Codex reset", async () => {
    let now = 1_000_000;
    const resetAt = Math.floor((now + 60_000) / 1_000);
    const readUsage = vi
      .fn<() => Promise<CodexUsageSnapshot>>()
      .mockResolvedValueOnce(usage(100, resetAt))
      .mockResolvedValueOnce(usage(0, resetAt + 3_600));
    const router = new FeishuCodexModelRouter({
      readUsage,
      now: () => now,
    });

    await router.recordUsageLimit();
    await expect(
      router.selectModel({
        preferredModel: "gpt-5.6-sol",
        fallbackModel: "deepseek-v4-flash-vision-exp",
        activeModel: "gpt-5.6-sol",
      }),
    ).resolves.toEqual({
      model: "deepseek-v4-flash-vision-exp",
      reason: "usage_limit_fallback",
    });

    now += 61_000;
    await expect(
      router.selectModel({
        preferredModel: "gpt-5.6-sol",
        fallbackModel: "deepseek-v4-flash-vision-exp",
        activeModel: "deepseek-v4-flash-vision-exp",
      }),
    ).resolves.toEqual({
      model: "gpt-5.6-sol",
      reason: "usage_limit_recovered",
    });
    expect(readUsage).toHaveBeenCalledTimes(2);
  });

  it("checks the existing Codex usage snapshot after restart", async () => {
    const readUsage = vi.fn(async () => usage(0, null));
    const router = new FeishuCodexModelRouter({ readUsage });

    await expect(
      router.selectModel({
        preferredModel: "gpt-5.6-sol",
        fallbackModel: "deepseek-v4-flash-vision-exp",
        activeModel: "deepseek-v4-flash-vision-exp",
      }),
    ).resolves.toEqual({
      model: "gpt-5.6-sol",
      reason: "usage_limit_recovered",
    });
  });

  it("stays on fallback when exhausted usage omits a reset timestamp", async () => {
    const readUsage = vi.fn(async () => usage(100, null));
    const router = new FeishuCodexModelRouter({ readUsage });

    await expect(
      router.selectModel({
        preferredModel: "gpt-5.6-sol",
        fallbackModel: "deepseek-v4-flash-vision-exp",
        activeModel: "deepseek-v4-flash-vision-exp",
      }),
    ).resolves.toEqual({
      model: "deepseek-v4-flash-vision-exp",
      reason: "usage_limit_fallback",
    });
  });
});

function usage(
  usedPercent: number,
  resetsAt: number | null,
): CodexUsageSnapshot {
  return {
    primary: {
      usedPercent,
      windowDurationMins: 7 * 24 * 60,
      resetsAt,
    },
    secondary: null,
    planType: "pro",
    resetCredits: null,
    additionalBuckets: [],
    updatedAt: new Date().toISOString(),
  };
}
