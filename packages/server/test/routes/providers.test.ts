import { describe, expect, it, vi } from "vitest";
import { createProvidersRoutes } from "../../src/routes/providers.js";

describe("provider routes", () => {
  it("returns remote Claude usage and forwards the fresh flag", async () => {
    const getClaudeUsage = vi.fn(async () => ({
      usage: {
        primary: {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: null,
        },
        secondary: null,
        planType: "pro",
        resetCredits: null,
        additionalBuckets: [],
        updatedAt: "2026-07-16T08:00:00.000Z",
      },
      error: null,
    }));
    const routes = createProvidersRoutes({ getClaudeUsage });

    const response = await routes.request("/claude/usage?fresh=1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      usage: { planType: "pro", primary: { usedPercent: 12 } },
    });
    expect(getClaudeUsage).toHaveBeenCalledWith({ fresh: true });
  });
});
