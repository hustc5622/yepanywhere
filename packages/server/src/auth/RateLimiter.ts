/**
 * Lightweight in-memory rate limiter for authentication endpoints.
 *
 * Tracks consecutive authentication failures per client key (IP) and globally
 * to protect single-owner self-hosted deployments from password brute-forcing,
 * pairing token guessing, and bcrypt CPU exhaustion.
 *
 * Every rejection carries the rule that produced it (`tier`), the remaining
 * wait (`retryAfterSec`) and that rule's full lockout length (`lockoutSec`) so
 * the login UI can state exactly how long the caller is locked out for.
 */

export interface AuthRateLimiterOptions {
  /** Failures within the window before a short lockout triggers (default: 5). */
  softThreshold?: number;
  /** Short lockout duration in ms (default: 60s). */
  softLockoutMs?: number;
  /** Failures within the window before a hard lockout triggers (default: 10). */
  hardThreshold?: number;
  /** Hard lockout duration in ms (default: 15m). */
  hardLockoutMs?: number;
  /** Rolling failure window in ms (default: 15m). */
  windowMs?: number;
  /** Global failure cap within globalWindowMs (default: 30). */
  globalThreshold?: number;
  /** Global window in ms (default: 5m). */
  globalWindowMs?: number;
  /** Global lockout duration in ms (default: 60s). */
  globalLockoutMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Which rule locked the client out. */
export type RateLimitTier = "soft" | "hard" | "global";

/** Tier a caller is still approaching, i.e. what the next failure would cost. */
export type UpcomingRateLimitTier = "soft" | "hard";

export interface RateLimitLockout {
  /** Seconds until the lockout expires. */
  retryAfterSec: number;
  /** Total length of the lockout rule that applied, in seconds. */
  lockoutSec: number;
  /** The rule that produced the lockout. */
  tier: RateLimitTier;
}

export type RateLimitDecision =
  | { allowed: true }
  | ({ allowed: false } & RateLimitLockout);

/** What the caller has left before the next lockout — used for 401 warnings. */
export interface RateLimitStatus {
  /** Failures recorded inside the current window. */
  failures: number;
  /** Failures still allowed before the next lockout tier triggers. */
  attemptsRemaining: number;
  /** The tier the next failure would trigger. */
  nextTier: UpcomingRateLimitTier;
  /** Lockout length that the next failure would trigger, in seconds. */
  nextLockoutSec: number;
}

interface Bucket {
  failures: number;
  windowStart: number;
  blockedUntil: number;
  lastSeen: number;
}

const GLOBAL_KEY = "__global__";
const MAX_TRACKED_KEYS = 2048;

export class AuthRateLimiter {
  private readonly softThreshold: number;
  private readonly softLockoutMs: number;
  private readonly hardThreshold: number;
  private readonly hardLockoutMs: number;
  private readonly windowMs: number;
  private readonly globalThreshold: number;
  private readonly globalWindowMs: number;
  private readonly globalLockoutMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: AuthRateLimiterOptions = {}) {
    this.softThreshold = options.softThreshold ?? 5;
    this.softLockoutMs = options.softLockoutMs ?? 60 * 1000;
    this.hardThreshold = options.hardThreshold ?? 10;
    this.hardLockoutMs = options.hardLockoutMs ?? 15 * 60 * 1000;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.globalThreshold = options.globalThreshold ?? 30;
    this.globalWindowMs = options.globalWindowMs ?? 5 * 60 * 1000;
    this.globalLockoutMs = options.globalLockoutMs ?? 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  check(clientKey: string): RateLimitDecision {
    const now = this.now();
    const key = normalizeClientKey(clientKey);
    const keyBlock = this.getBlock(key, now);
    const globalBlock = this.getBlock(GLOBAL_KEY, now);
    const block =
      !globalBlock ||
      (keyBlock && keyBlock.retryAfterMs >= globalBlock.retryAfterMs)
        ? keyBlock
        : globalBlock;
    if (!block) return { allowed: true };
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(block.retryAfterMs / 1000)),
      lockoutSec: Math.max(1, Math.ceil(block.lockoutMs / 1000)),
      tier: block.tier,
    };
  }

  recordFailure(clientKey: string): RateLimitDecision {
    const now = this.now();
    const key = normalizeClientKey(clientKey);
    this.pruneIfNeeded(now);

    this.bumpBucket(
      key,
      now,
      this.windowMs,
      this.softThreshold,
      this.softLockoutMs,
      this.hardThreshold,
      this.hardLockoutMs,
    );
    this.bumpBucket(
      GLOBAL_KEY,
      now,
      this.globalWindowMs,
      this.globalThreshold,
      this.globalLockoutMs,
      this.globalThreshold,
      this.globalLockoutMs,
    );

    return this.check(key);
  }

  recordSuccess(clientKey: string): void {
    const key = normalizeClientKey(clientKey);
    this.buckets.delete(key);
  }

  /**
   * Describe what the caller has left before the next lockout. Called after a
   * failed (but not yet rate-limited) attempt so the UI can say
   * "2 attempts left, then a 1 minute lockout".
   */
  describe(clientKey: string): RateLimitStatus {
    const now = this.now();
    const key = normalizeClientKey(clientKey);
    const bucket = this.buckets.get(key);
    const failures =
      bucket && now - bucket.windowStart <= this.windowMs ? bucket.failures : 0;

    if (failures < this.softThreshold) {
      return {
        failures,
        attemptsRemaining: Math.max(0, this.softThreshold - failures),
        nextTier: "soft",
        nextLockoutSec: Math.max(1, Math.ceil(this.softLockoutMs / 1000)),
      };
    }

    return {
      failures,
      attemptsRemaining: Math.max(0, this.hardThreshold - failures),
      nextTier: "hard",
      nextLockoutSec: Math.max(1, Math.ceil(this.hardLockoutMs / 1000)),
    };
  }

  /**
   * Drop every bucket, including the global one. Used when the account
   * credential changes (password reset from the CLI or the settings UI), since
   * a lockout earned by the previous password should not outlive it.
   */
  reset(): void {
    this.buckets.clear();
  }

  private getBlock(
    key: string,
    now: number,
  ): { retryAfterMs: number; lockoutMs: number; tier: RateLimitTier } | null {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.blockedUntil <= now) return null;
    const retryAfterMs = bucket.blockedUntil - now;

    if (key === GLOBAL_KEY) {
      return { retryAfterMs, lockoutMs: this.globalLockoutMs, tier: "global" };
    }

    const tier: UpcomingRateLimitTier =
      bucket.failures >= this.hardThreshold ? "hard" : "soft";
    return {
      retryAfterMs,
      lockoutMs: tier === "hard" ? this.hardLockoutMs : this.softLockoutMs,
      tier,
    };
  }

  private bumpBucket(
    key: string,
    now: number,
    windowMs: number,
    softThreshold: number,
    softLockoutMs: number,
    hardThreshold: number,
    hardLockoutMs: number,
  ): void {
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = {
        failures: 0,
        windowStart: now,
        blockedUntil: 0,
        lastSeen: now,
      };
      this.buckets.set(key, bucket);
    }

    bucket.failures += 1;
    bucket.lastSeen = now;

    if (bucket.failures >= hardThreshold) {
      bucket.blockedUntil = Math.max(bucket.blockedUntil, now + hardLockoutMs);
    } else if (bucket.failures >= softThreshold) {
      bucket.blockedUntil = Math.max(bucket.blockedUntil, now + softLockoutMs);
    }
  }

  private pruneIfNeeded(now: number): void {
    if (this.buckets.size < MAX_TRACKED_KEYS) return;
    const expiryCutoff = Math.max(this.windowMs, this.hardLockoutMs);
    for (const [key, bucket] of this.buckets) {
      if (key === GLOBAL_KEY) continue;
      if (bucket.blockedUntil <= now && now - bucket.lastSeen > expiryCutoff) {
        this.buckets.delete(key);
      }
    }
    // If still full, evict oldest entries (Map preserves insertion order)
    while (this.buckets.size >= MAX_TRACKED_KEYS) {
      const oldestKey = this.buckets.keys().next().value;
      if (!oldestKey || oldestKey === GLOBAL_KEY) break;
      this.buckets.delete(oldestKey);
    }
  }
}

function normalizeClientKey(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 128) : "unknown";
}
