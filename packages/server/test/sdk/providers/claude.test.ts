import type {
  ModelInfo as ClaudeSdkModelInfo,
  SDKControlGetUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  mapClaudeSdkModel,
  normalizeClaudeContextWindow,
  normalizeClaudeUsage,
} from "../../../src/sdk/providers/claude-control.js";
import { safeAttachmentName } from "../../../src/sdk/providers/claude.js";

describe("remote Claude provider", () => {
  it("keeps attachment names inside one bounded path component", () => {
    const name = safeAttachmentName("../../message/id", "../unsafe file.png");

    expect(name).toBe("______message_id-unsafe_file.png");
    expect(name).not.toContain("/");
    expect(name.length).toBeLessThanOrEqual(241);
  });

  it("maps the VM model catalog with version, context, and effort capabilities", () => {
    const model = mapClaudeSdkModel(
      {
        value: "claude-fable-5[1m]",
        resolvedModel: "claude-fable-5",
        displayName: "Fable",
        description: "Fable 5 · Most capable for long-running tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
        supportsAutoMode: true,
      } satisfies ClaudeSdkModelInfo,
      967_000,
    );

    expect(model).toEqual({
      id: "claude-fable-5[1m]",
      resolvedModel: "claude-fable-5",
      name: "Fable 5",
      description: "Fable 5 · Most capable for long-running tasks",
      contextWindow: 1_000_000,
      supportsEffort: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
        { reasoningEffort: "max" },
      ],
      supportsAdaptiveThinking: true,
      supportsFastMode: false,
      supportsAutoMode: true,
    });
  });

  it("normalizes Claude's reserved 967K prompt budget to the 1M model tier", () => {
    expect(normalizeClaudeContextWindow(967_000, "sonnet")).toBe(1_000_000);
    expect(normalizeClaudeContextWindow(200_000, "haiku")).toBe(200_000);
  });

  it("normalizes structured Claude plan usage into picker windows", () => {
    const usage = normalizeClaudeUsage({
      session: {
        total_cost_usd: 0,
        total_api_duration_ms: 0,
        total_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {},
      },
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: {
          utilization: 18,
          resets_at: "2026-07-16T12:30:00.000Z",
        },
        seven_day: { utilization: 42, resets_at: null },
        model_scoped: [
          { display_name: "Fable", utilization: 7, resets_at: null },
        ],
      },
      behaviors: null,
    } as unknown as SDKControlGetUsageResponse);

    expect(usage).toMatchObject({
      planType: "pro",
      primary: { usedPercent: 18, windowDurationMins: 300 },
      secondary: { usedPercent: 42, windowDurationMins: 10_080 },
      additionalBuckets: [
        {
          name: "Fable",
          primary: { usedPercent: 7, windowDurationMins: 10_080 },
        },
      ],
    });
  });
});
