import { describe, expect, it } from "vitest";
import {
  normalizeReasoningEffortForProvider,
  parseOptionalOpenCodeConfig,
  parseOptionalReasoningEffort,
} from "../../src/services/SessionCommandService.js";

describe("OpenCode session config validation", () => {
  it("accepts a complete managed model configuration", () => {
    expect(
      parseOptionalOpenCodeConfig({
        model: "glm-5.2",
        requestProtocol: "openai-compatible",
        limits: { context: 200_000, input: 180_000, output: 32_768 },
        capabilities: {
          reasoning: false,
          toolCall: true,
          temperature: true,
          attachment: false,
        },
        advanced: {
          provider: { options: { headers: { "X-Trace": "yep" } } },
          model: { options: { thinking: { type: "disabled" } } },
        },
      }),
    ).toEqual({
      opencodeConfig: {
        model: "glm-5.2",
        requestProtocol: "openai-compatible",
        limits: { context: 200_000, input: 180_000, output: 32_768 },
        capabilities: {
          reasoning: false,
          toolCall: true,
          temperature: true,
          attachment: false,
        },
        advanced: {
          provider: { options: { headers: { "X-Trace": "yep" } } },
          model: { options: { thinking: { type: "disabled" } } },
        },
      },
    });
  });

  it("rejects incomplete limits and unsupported protocols", () => {
    expect(
      parseOptionalOpenCodeConfig({
        model: "glm-5.2",
        requestProtocol: "openai-compatible",
        limits: { context: 200_000 },
      }).error,
    ).toContain("requires both context and output");
    expect(
      parseOptionalOpenCodeConfig({
        model: "glm-5.2",
        requestProtocol: "openai-responses",
      }).error,
    ).toContain("requestProtocol");
  });

  it("rejects prototype-polluting keys in advanced JSON", () => {
    const advanced = JSON.parse(
      '{"provider":{"__proto__":{"polluted":true}}}',
    ) as unknown;
    expect(
      parseOptionalOpenCodeConfig({
        model: "glm-5.2",
        requestProtocol: "anthropic",
        advanced,
      }).error,
    ).toContain("reserved key");
  });

  it("uses OpenCode default as an explicit variant clear marker", () => {
    expect(normalizeReasoningEffortForProvider("opencode", "default")).toBe(
      undefined,
    );
    expect(normalizeReasoningEffortForProvider("opencode", "max")).toBe("max");
    expect(normalizeReasoningEffortForProvider("codex", "default")).toBe(
      "default",
    );
  });

  it("accepts printable custom OpenCode variant IDs", () => {
    expect(parseOptionalReasoningEffort("future.v2:max")).toEqual({
      reasoningEffort: "future.v2:max",
    });
    expect(parseOptionalReasoningEffort("bad\nvariant")).toEqual({
      error: "Invalid reasoningEffort",
    });
  });
});
