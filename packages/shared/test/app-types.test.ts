import { describe, expect, it } from "vitest";
import {
  CLAUDE_EXTENDED_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  DEFAULT_CONTEXT_WINDOW,
  getModelContextWindow,
  getOpenCodeModelDefaultLimits,
} from "../src/app-types.js";

describe("getModelContextWindow", () => {
  it("returns default window for unknown model", () => {
    expect(getModelContextWindow("unknown-model")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("uses codex fallback when provider is codex and model is missing", () => {
    expect(getModelContextWindow(undefined, "codex")).toBe(
      CODEX_DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("detects codex and gpt-5 models as 258K", () => {
    expect(getModelContextWindow("codex-5.3")).toBe(
      CODEX_DEFAULT_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("gpt-5-codex")).toBe(
      CODEX_DEFAULT_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("openai/gpt-5")).toBe(
      CODEX_DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("detects explicit Claude 1M model variants", () => {
    expect(getModelContextWindow("sonnet[1m]")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("opus[1m]")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
    expect(getModelContextWindow("claude-opus-4-6[1m]")).toBe(
      CLAUDE_EXTENDED_CONTEXT_WINDOW,
    );
  });

  it("keeps non-codex provider fallback at default", () => {
    expect(getModelContextWindow(undefined, "codex-oss")).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("resolves OpenCode gateway models via the curated catalog", () => {
    // ohmyrouter exposes no context_window, so these must come from the table.
    expect(getModelContextWindow("claude-opus-4-8", "opencode")).toBe(
      1_000_000,
    );
    expect(getModelContextWindow("claude-haiku-4-5-20251001", "opencode")).toBe(
      200_000,
    );
    expect(getModelContextWindow("glm-5.2", "opencode")).toBe(1_000_000);
    expect(getModelContextWindow("glm-5.1", "opencode")).toBe(200_000);
    // Namespaced refs strip the provider prefix before matching.
    expect(
      getModelContextWindow("yep-anthropic/claude-opus-4-8", "opencode"),
    ).toBe(1_000_000);
    // Unknown OpenCode model still falls back to the 200K default.
    expect(getModelContextWindow("gpt-image-2", "opencode")).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });
});

describe("getOpenCodeModelDefaultLimits", () => {
  it("returns curated context/output limits by longest-prefix match", () => {
    expect(getOpenCodeModelDefaultLimits("deepseek-v4-pro")).toEqual({
      context: 1_000_000,
      output: 384_000,
    });
    expect(getOpenCodeModelDefaultLimits("gpt-5.4-mini")).toEqual({
      context: 400_000,
      output: 128_000,
    });
    expect(getOpenCodeModelDefaultLimits("gpt-5.5")).toEqual({
      context: 1_000_000,
      output: 128_000,
    });
    expect(getOpenCodeModelDefaultLimits("doubao-seed-2-1-pro-260628")).toEqual(
      {
        context: 256_000,
        output: 128_000,
      },
    );
  });

  it("returns undefined for unknown families", () => {
    expect(getOpenCodeModelDefaultLimits("gpt-image-2")).toBeUndefined();
    expect(getOpenCodeModelDefaultLimits(undefined)).toBeUndefined();
  });
});
