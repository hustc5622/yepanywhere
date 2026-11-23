import { describe, expect, it } from "vitest";
import { AuthRateLimiter } from "../../src/auth/RateLimiter.js";

describe("AuthRateLimiter", () => {
  it("triggers soft lockout after 5 failures and hard lockout after 10 failures", () => {
    let now = 1_000_000;
    const limiter = new AuthRateLimiter({
      softThreshold: 5,
      softLockoutMs: 60_000,
      hardThreshold: 10,
      hardLockoutMs: 900_000,
      windowMs: 900_000,
      now: () => now,
    });

    for (let i = 0; i < 4; i++) {
      expect(limiter.recordFailure("1.2.3.4")).toEqual({ allowed: true });
    }

    const fifth = limiter.recordFailure("1.2.3.4");
    expect(fifth).toEqual({
      allowed: false,
      retryAfterSec: 60,
      tier: "soft",
      lockoutSec: 60,
    });
    expect(limiter.check("1.2.3.4")).toEqual({
      allowed: false,
      retryAfterSec: 60,
      tier: "soft",
      lockoutSec: 60,
    });

    // Different client is still allowed
    expect(limiter.check("5.6.7.8")).toEqual({ allowed: true });

    // Advance past soft lockout
    now += 61_000;
    expect(limiter.check("1.2.3.4")).toEqual({ allowed: true });

    // 5 more failures hit hard lockout (10 total in window)
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure("1.2.3.4");
    }
    const tenth = limiter.recordFailure("1.2.3.4");
    expect(tenth).toEqual({
      allowed: false,
      retryAfterSec: 900,
      tier: "hard",
      lockoutSec: 900,
    });
  });

  it("resets per-client bucket on successful auth", () => {
    let now = 1_000_000;
    const limiter = new AuthRateLimiter({
      softThreshold: 3,
      softLockoutMs: 30_000,
      now: () => now,
    });

    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    limiter.recordSuccess("1.2.3.4");

    expect(limiter.recordFailure("1.2.3.4")).toEqual({ allowed: true });
    expect(limiter.recordFailure("1.2.3.4")).toEqual({ allowed: true });
    now += 1000;
    expect(limiter.recordFailure("1.2.3.4")).toEqual({
      allowed: false,
      retryAfterSec: 30,
      tier: "soft",
      lockoutSec: 30,
    });
  });

  it("reports the remaining attempts and the upcoming lockout duration", () => {
    const now = 1_000_000;
    const limiter = new AuthRateLimiter({
      softThreshold: 5,
      softLockoutMs: 60_000,
      hardThreshold: 10,
      hardLockoutMs: 900_000,
      windowMs: 900_000,
      now: () => now,
    });

    // Nothing recorded yet: the full soft allowance is still available.
    expect(limiter.describe("1.2.3.4")).toEqual({
      failures: 0,
      attemptsRemaining: 5,
      nextTier: "soft",
      nextLockoutSec: 60,
    });

    limiter.recordFailure("1.2.3.4");
    expect(limiter.describe("1.2.3.4")).toEqual({
      failures: 1,
      attemptsRemaining: 4,
      nextTier: "soft",
      nextLockoutSec: 60,
    });

    // Failures 5..9 sit between the soft and hard tiers, so the warning now
    // points at the 15 minute hard lockout instead of the 1 minute one.
    for (let i = 0; i < 4; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.describe("1.2.3.4")).toEqual({
      failures: 5,
      attemptsRemaining: 5,
      nextTier: "hard",
      nextLockoutSec: 900,
    });

    for (let i = 0; i < 4; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.describe("1.2.3.4")).toEqual({
      failures: 9,
      attemptsRemaining: 1,
      nextTier: "hard",
      nextLockoutSec: 900,
    });
  });

  it("forgets failures once the rolling window has passed", () => {
    let now = 1_000_000;
    const limiter = new AuthRateLimiter({
      softThreshold: 5,
      softLockoutMs: 60_000,
      hardThreshold: 10,
      hardLockoutMs: 900_000,
      windowMs: 900_000,
      now: () => now,
    });

    for (let i = 0; i < 4; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.describe("1.2.3.4").failures).toBe(4);

    now += 900_001;
    expect(limiter.describe("1.2.3.4")).toEqual({
      failures: 0,
      attemptsRemaining: 5,
      nextTier: "soft",
      nextLockoutSec: 60,
    });
  });

  it("clears every bucket on reset so a password reset lifts the lockout", () => {
    const now = 1_000_000;
    const limiter = new AuthRateLimiter({
      softThreshold: 5,
      softLockoutMs: 60_000,
      hardThreshold: 10,
      hardLockoutMs: 900_000,
      windowMs: 900_000,
      now: () => now,
    });

    for (let i = 0; i < 10; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.check("1.2.3.4")).toEqual({
      allowed: false,
      retryAfterSec: 900,
      tier: "hard",
      lockoutSec: 900,
    });

    limiter.reset();

    expect(limiter.check("1.2.3.4")).toEqual({ allowed: true });
    expect(limiter.describe("1.2.3.4")).toEqual({
      failures: 0,
      attemptsRemaining: 5,
      nextTier: "soft",
      nextLockoutSec: 60,
    });
  });

  it("blocks every client from the global bucket and labels it as global", () => {
    const now = 1_000_000;
    const limiter = new AuthRateLimiter({
      softThreshold: 100,
      hardThreshold: 100,
      globalThreshold: 2,
      globalWindowMs: 60_000,
      globalLockoutMs: 30_000,
      now: () => now,
    });

    expect(limiter.recordFailure("1.1.1.1")).toEqual({ allowed: true });
    expect(limiter.recordFailure("2.2.2.2")).toEqual({
      allowed: false,
      retryAfterSec: 30,
      tier: "global",
      lockoutSec: 30,
    });
    expect(limiter.check("3.3.3.3")).toEqual({
      allowed: false,
      retryAfterSec: 30,
      tier: "global",
      lockoutSec: 30,
    });
  });
});
