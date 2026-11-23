/**
 * In-memory one-time device pairing tokens.
 *
 * Allows an already-authenticated device (e.g. Mac browser) to mint a short-lived,
 * high-entropy, single-use token (QR code / `#pair=` URL) so a phone browser or
 * Android shell can sign in without typing a password.
 *
 * Security properties:
 * - 256-bit cryptographically random token (`base64url`)
 * - Stored in memory only as SHA-256 hash (never written to disk)
 * - Short TTL (default: 120 seconds)
 * - Strictly single-use (atomically deleted upon redemption)
 * - Bounded concurrency (max 5 active tokens)
 */

import * as crypto from "node:crypto";

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 120 * 1000;
const MAX_ACTIVE_TOKENS = 5;

export interface PairingTokenRecord {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  createdBySessionId?: string;
  label?: string;
}

export interface CreatedPairingToken {
  /** Raw one-time token (returned once to the creating authenticated device). */
  token: string;
  /** ISO-8601 expiration timestamp. */
  expiresAt: string;
  /** Remaining TTL in whole seconds. */
  ttlSeconds: number;
}

export type PairingRedeemResult =
  | { ok: true; label?: string }
  | { ok: false; reason: "invalid" | "expired" };

export interface PairingServiceOptions {
  ttlMs?: number;
  maxActiveTokens?: number;
  now?: () => number;
}

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export class PairingService {
  private readonly ttlMs: number;
  private readonly maxActiveTokens: number;
  private readonly now: () => number;
  private readonly tokens = new Map<string, PairingTokenRecord>();

  constructor(options: PairingServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxActiveTokens = options.maxActiveTokens ?? MAX_ACTIVE_TOKENS;
    this.now = options.now ?? (() => Date.now());
  }

  createToken(options?: {
    createdBySessionId?: string;
    label?: string;
    ttlMs?: number;
  }): CreatedPairingToken {
    const now = this.now();
    this.pruneExpired(now);

    while (this.tokens.size >= this.maxActiveTokens) {
      const oldestHash = this.tokens.keys().next().value;
      if (!oldestHash) break;
      this.tokens.delete(oldestHash);
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHash = hashToken(token);
    const effectiveTtlMs = Math.max(
      10_000,
      Math.min(options?.ttlMs ?? this.ttlMs, 10 * 60 * 1000),
    );
    const expiresAt = now + effectiveTtlMs;

    this.tokens.set(tokenHash, {
      tokenHash,
      createdAt: now,
      expiresAt,
      createdBySessionId: options?.createdBySessionId,
      label: options?.label?.trim().slice(0, 64) || undefined,
    });

    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSeconds: Math.ceil(effectiveTtlMs / 1000),
    };
  }

  redeemToken(rawToken: string): PairingRedeemResult {
    const trimmed = rawToken.trim();
    if (!trimmed || trimmed.length < 16 || trimmed.length > 256) {
      return { ok: false, reason: "invalid" };
    }

    const now = this.now();
    const tokenHash = hashToken(trimmed);
    const record = this.tokens.get(tokenHash);
    if (!record) {
      return { ok: false, reason: "invalid" };
    }

    // Consume immediately (single-use) regardless of expiry.
    this.tokens.delete(tokenHash);

    if (now > record.expiresAt) {
      return { ok: false, reason: "expired" };
    }

    return { ok: true, label: record.label };
  }

  /** Clear all pending pairing tokens (e.g. when password changes or auth is disabled). */
  clearAll(): void {
    this.tokens.clear();
  }

  private pruneExpired(now: number): void {
    for (const [hash, record] of this.tokens) {
      if (now > record.expiresAt) {
        this.tokens.delete(hash);
      }
    }
  }
}
