import { describe, expect, it } from "vitest";
import { PairingService } from "../../src/auth/PairingService.js";

describe("PairingService", () => {
  it("redeems a valid token exactly once (single-use)", () => {
    const service = new PairingService({ ttlMs: 120_000 });
    const created = service.createToken({ label: "My Phone" });

    expect(created.token.length).toBeGreaterThanOrEqual(32);
    expect(created.ttlSeconds).toBe(120);

    expect(service.redeemToken(created.token)).toEqual({
      ok: true,
      label: "My Phone",
    });
    // Replaying the same token fails
    expect(service.redeemToken(created.token)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects expired tokens", () => {
    let now = 5_000_000;
    const service = new PairingService({
      ttlMs: 60_000,
      now: () => now,
    });

    const created = service.createToken();
    now += 61_000;

    expect(service.redeemToken(created.token)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("evicts oldest token when maxActiveTokens is exceeded", () => {
    const service = new PairingService({ maxActiveTokens: 2 });
    const first = service.createToken();
    const second = service.createToken();
    const third = service.createToken();

    expect(service.redeemToken(first.token)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(service.redeemToken(second.token).ok).toBe(true);
    expect(service.redeemToken(third.token).ok).toBe(true);
  });
});
