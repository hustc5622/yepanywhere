import { describe, expect, it, vi } from "vitest";
import type { CodexBridgeController } from "../../src/codex-bridge/types.js";
import { createCodexBridgeRoutes } from "../../src/routes/codex-bridge.js";

describe("Codex bridge routes", () => {
  it("returns account usage and forwards a fresh request", async () => {
    const getUsage = vi.fn(async () => ({
      usage: {
        primary: {
          usedPercent: 47,
          windowDurationMins: 300,
          resetsAt: 1_783_688_237,
        },
        secondary: null,
        planType: "pro",
        resetCredits: null,
        additionalBuckets: [],
        updatedAt: "2026-07-10T08:00:00.000Z",
      },
      error: null,
    }));
    const routes = createCodexBridgeRoutes({
      codexBridgeService: {
        getUsage,
      } as unknown as CodexBridgeController,
    });

    const response = await routes.request("/usage?fresh=1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      usage: { planType: "pro", primary: { usedPercent: 47 } },
    });
    expect(getUsage).toHaveBeenCalledWith({ fresh: true });
  });
});
