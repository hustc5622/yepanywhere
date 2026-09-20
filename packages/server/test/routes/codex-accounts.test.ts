import { describe, expect, it, vi } from "vitest";
import type { CodexAccountsService } from "../../src/codex-bridge/CodexAccountsService.js";
import { createCodexAccountsRoutes } from "../../src/routes/codex-accounts.js";

const idempotencyKey = "f3e4d5c6-1234-4567-89ab-123456789abc";

describe("Codex usage reset route", () => {
  const setup = () => {
    const resetUsage = vi.fn().mockResolvedValue({ outcome: "reset" });
    const routes = createCodexAccountsRoutes({
      codexAccountsService: { resetUsage } as unknown as CodexAccountsService,
    });
    const post = (body: unknown) =>
      routes.request("/acct-2/usage/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    return { resetUsage, post };
  };

  it.each([
    null,
    {},
    { idempotencyKey },
    { confirmed: true, idempotencyKey: "" },
    { confirmed: true, idempotencyKey, creditId: 42 },
  ])("rejects unconfirmed or malformed requests: %j", async (body) => {
    const { post, resetUsage } = setup();
    expect((await post(body)).status).toBe(400);
    expect(resetUsage).not.toHaveBeenCalled();
  });

  it("forwards the chosen account, credit, and stable idempotency key", async () => {
    const { post, resetUsage } = setup();
    const response = await post({
      confirmed: true,
      idempotencyKey,
      creditId: "credit-1",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "reset" });
    expect(resetUsage).toHaveBeenCalledWith("acct-2", {
      idempotencyKey,
      creditId: "credit-1",
    });
  });

  it("returns an upstream error without retrying the mutation", async () => {
    const { post, resetUsage } = setup();
    resetUsage.mockRejectedValue(new Error("timeout"));
    const response = await post({ confirmed: true, idempotencyKey });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "timeout" });
    expect(resetUsage).toHaveBeenCalledTimes(1);
  });
});
