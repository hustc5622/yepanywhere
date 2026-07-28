import { describe, expect, it } from "vitest";
import {
  CLAUDE_EXTENDED_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  DEFAULT_CONTEXT_WINDOW,
  getModelContextWindow,
  getOpenCodeModelDefaultLimits,
  resolveClaudeModelLabel,
  resolveModelDisplayLabel,
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

describe("resolveClaudeModelLabel", () => {
  it("resolves full versioned Opus 5", () => {
    expect(resolveClaudeModelLabel("claude-opus-5")).toBe("Opus 5");
  });

  it("resolves full versioned Opus 4.8", () => {
    expect(resolveClaudeModelLabel("claude-opus-4-8")).toBe("Opus 4.8");
  });

  it("resolves Opus 4.8 Fast variant", () => {
    expect(resolveClaudeModelLabel("claude-opus-4-8-fast")).toBe(
      "Opus 4.8 Fast",
    );
  });

  it("resolves short SDK name opus", () => {
    expect(resolveClaudeModelLabel("opus")).toBe("Opus 4.8");
  });

  it("resolves short SDK name sonnet", () => {
    expect(resolveClaudeModelLabel("sonnet")).toBe("Sonnet 5");
  });

  it("resolves short SDK name haiku", () => {
    expect(resolveClaudeModelLabel("haiku")).toBe("Haiku 4.5");
  });

  it("strips date suffix from full ID", () => {
    expect(resolveClaudeModelLabel("claude-opus-4-5-20251101")).toBe(
      "Opus 4.5",
    );
    expect(resolveClaudeModelLabel("claude-sonnet-4-5-20250929")).toBe(
      "Sonnet 4.5",
    );
  });

  it("handles [1m] extended context suffix", () => {
    expect(resolveClaudeModelLabel("claude-opus-4-8[1m]")).toBe("Opus 4.8 1M");
    expect(resolveClaudeModelLabel("opus[1m]")).toBe("Opus 4.8 1M");
    expect(resolveClaudeModelLabel("sonnet[1m]")).toBe("Sonnet 5 1M");
  });

  it("capitalizes unknown Claude family", () => {
    expect(resolveClaudeModelLabel("claude-newmodel-3-2")).toBe("Newmodel 3.2");
  });

  it("handles fable 5 short name", () => {
    expect(resolveClaudeModelLabel("claude-fable-5")).toBe("Fable 5");
  });
});

describe("resolveModelDisplayLabel", () => {
  it("returns null for default/empty", () => {
    expect(resolveModelDisplayLabel(undefined)).toBeNull();
    expect(resolveModelDisplayLabel("default")).toBeNull();
    expect(resolveModelDisplayLabel("")).toBeNull();
  });

  it("resolves namespaced Mafia Opus 5 with channel prefix", () => {
    expect(resolveModelDisplayLabel("mafia/claude-opus-5")).toBe(
      "Mafia Opus 5",
    );
  });

  it("resolves namespaced Anthropic Opus 4.8 without channel prefix", () => {
    expect(resolveModelDisplayLabel("anthropic/claude-opus-4-8")).toBe(
      "Opus 4.8",
    );
  });

  it("resolves namespaced Anthropic Opus 4.8 Fast", () => {
    expect(resolveModelDisplayLabel("anthropic/claude-opus-4-8-fast")).toBe(
      "Opus 4.8 Fast",
    );
  });

  it("resolves bare claude-opus-5", () => {
    expect(resolveModelDisplayLabel("claude-opus-5")).toBe("Opus 5");
  });

  it("resolves bare claude-opus-4-8", () => {
    expect(resolveModelDisplayLabel("claude-opus-4-8")).toBe("Opus 4.8");
  });

  it("resolves bare claude-opus-4-8-fast", () => {
    expect(resolveModelDisplayLabel("claude-opus-4-8-fast")).toBe(
      "Opus 4.8 Fast",
    );
  });

  it("resolves short SDK name opus", () => {
    expect(resolveModelDisplayLabel("opus")).toBe("Opus 4.8");
  });

  it("resolves short SDK name sonnet", () => {
    expect(resolveModelDisplayLabel("sonnet")).toBe("Sonnet 5");
  });

  it("resolves extended context suffix", () => {
    expect(resolveModelDisplayLabel("claude-opus-4-8[1m]")).toBe("Opus 4.8 1M");
    expect(resolveModelDisplayLabel("opus[1m]")).toBe("Opus 4.8 1M");
  });

  it("does not add channel prefix for yep-anthropic", () => {
    expect(resolveModelDisplayLabel("yep-anthropic/claude-opus-4-8")).toBe(
      "Opus 4.8",
    );
  });
});
