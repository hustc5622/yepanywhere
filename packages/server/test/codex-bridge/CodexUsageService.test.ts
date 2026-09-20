import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeUsageSnapshot,
  readCodexUsage,
} from "../../src/codex-bridge/CodexUsageService.js";

describe("readCodexUsage", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("normalizes the primary Codex windows, reset credits, and extra buckets", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yep-codex-usage-"));
    const codexPath = join(tempDir, "fake-codex.mjs");
    await writeFile(codexPath, FAKE_CODEX_APP_SERVER, { mode: 0o755 });
    await chmod(codexPath, 0o755);

    await expect(readCodexUsage(codexPath)).resolves.toEqual({
      primary: {
        usedPercent: 47,
        windowDurationMins: 300,
        resetsAt: 1_783_688_237,
      },
      secondary: {
        usedPercent: 7,
        windowDurationMins: 10_080,
        resetsAt: 1_784_275_037,
      },
      planType: "pro",
      resetCredits: { availableCount: 1, credits: null },
      additionalBuckets: [
        {
          id: "codex_spark",
          name: "GPT-5.3-Codex-Spark",
          primary: {
            usedPercent: 0,
            windowDurationMins: 300,
            resetsAt: 1_783_695_264,
          },
          secondary: {
            usedPercent: 0,
            windowDurationMins: 10_080,
            resetsAt: 1_784_282_064,
          },
          planType: "pro",
        },
      ],
      updatedAt: expect.any(String),
    });
  });
});

describe("reset credit details", () => {
  const normalize = (summary: unknown) =>
    normalizeUsageSnapshot({
      rate_limits: { primary: { used_percent: 10 } },
      rate_limit_reset_credits: summary,
    })?.resetCredits;

  it("preserves camelCase and snake_case expiry details without inventing unknown dates", () => {
    expect(
      normalize({
        available_count: 4,
        credits: [
          {
            id: "dated",
            status: "available",
            resetType: "codexRateLimits",
            expiresAt: 1791173941,
            title: "Full reset",
            description: "Gift",
          },
          {
            id: "forever",
            status: "available",
            reset_type: "codexRateLimits",
            expires_at: null,
          },
          { id: "unknown", status: "available" },
          { id: "invalid", expiresAt: "tomorrow" },
          null,
          { expiresAt: 123 },
        ],
      }),
    ).toEqual({
      availableCount: 4,
      credits: [
        {
          id: "dated",
          status: "available",
          resetType: "codexRateLimits",
          expiresAt: 1791173941,
          title: "Full reset",
          description: "Gift",
        },
        {
          id: "forever",
          status: "available",
          resetType: "codexRateLimits",
          expiresAt: null,
          title: null,
          description: null,
        },
        {
          id: "unknown",
          status: "available",
          resetType: "unknown",
          expiresAt: undefined,
          title: null,
          description: null,
        },
        {
          id: "invalid",
          status: "unknown",
          resetType: "unknown",
          expiresAt: undefined,
          title: null,
          description: null,
        },
      ],
    });
  });

  it("distinguishes unavailable details from an empty detail list", () => {
    expect(normalize({ availableCount: 1 })).toEqual({
      availableCount: 1,
      credits: null,
    });
    expect(normalize({ availableCount: 0, credits: [] })).toEqual({
      availableCount: 0,
      credits: [],
    });
  });
});

const FAKE_CODEX_APP_SERVER = `#!/usr/bin/env node
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
    return;
  }
  if (request.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 47, windowDurationMins: 300, resetsAt: 1783688237 },
          secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1784275037 },
          planType: "pro"
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: null,
            primary: { usedPercent: 47, windowDurationMins: 300, resetsAt: 1783688237 },
            secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1784275037 },
            planType: "pro"
          },
          codex_spark: {
            limitId: "codex_spark",
            limitName: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1783695264 },
            secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1784282064 },
            planType: "pro"
          }
        },
        rateLimitResetCredits: { availableCount: 1 }
      }
    }) + "\\n");
  }
});
`;
