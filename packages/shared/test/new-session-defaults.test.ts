import { describe, expect, it } from "vitest";
import {
  type NewSessionDefaults,
  getNewSessionProviderDefaults,
  mergeNewSessionDefaults,
  normalizeNewSessionDefaults,
} from "../src/types.js";

describe("new session defaults", () => {
  it("migrates legacy active-provider fields into a provider-specific entry", () => {
    const legacyDefaults: NewSessionDefaults = {
      provider: "codex",
      model: "gpt-5.6-sol",
      thinking: "on:max",
      reasoningEffort: "max",
      permissionMode: "bypassPermissions",
      codexMcpMode: "clear",
    };

    const normalized = normalizeNewSessionDefaults(legacyDefaults);

    expect(normalized).toEqual({
      ...legacyDefaults,
      byProvider: {
        codex: {
          model: "gpt-5.6-sol",
          thinking: "on:max",
          reasoningEffort: "max",
          permissionMode: "bypassPermissions",
          codexMcpMode: "clear",
        },
      },
    });
    expect(getNewSessionProviderDefaults(normalized, "codex")).toEqual(
      normalized?.byProvider?.codex,
    );
  });

  it("preserves other providers when one provider becomes the default", () => {
    const current = normalizeNewSessionDefaults({
      provider: "codex",
      model: "gpt-5.6-sol",
      permissionMode: "bypassPermissions",
      codexMcpMode: "full",
    });
    const llmGatewayConfig = {
      model: "claude-opus-4-8",
      requestProtocol: "anthropic" as const,
    };

    const merged = mergeNewSessionDefaults(current, {
      provider: "pi",
      permissionMode: "acceptEdits",
      llmGatewayConfig,
      byProvider: {
        pi: {
          permissionMode: "acceptEdits",
          llmGatewayConfig,
        },
      },
    });

    expect(merged?.provider).toBe("pi");
    expect(getNewSessionProviderDefaults(merged, "codex")).toEqual({
      model: "gpt-5.6-sol",
      permissionMode: "bypassPermissions",
      codexMcpMode: "full",
    });
    expect(getNewSessionProviderDefaults(merged, "pi")).toEqual({
      permissionMode: "acceptEdits",
      llmGatewayConfig,
    });
    expect(merged).toMatchObject({
      permissionMode: "acceptEdits",
      llmGatewayConfig,
    });
    expect(merged).not.toHaveProperty("codexMcpMode");
  });

  it("prefers the provider map over a stale compatibility mirror", () => {
    const defaults = normalizeNewSessionDefaults({
      provider: "codex",
      model: "stale-model",
      codexMcpMode: "full",
      byProvider: {
        codex: {
          model: "saved-model",
          permissionMode: "plan",
        },
      },
    });

    expect(defaults).toMatchObject({
      provider: "codex",
      model: "saved-model",
      permissionMode: "plan",
    });
    expect(defaults).not.toHaveProperty("codexMcpMode");
    expect(getNewSessionProviderDefaults(defaults, "codex")).toEqual({
      model: "saved-model",
      permissionMode: "plan",
    });
  });

  it("replaces one provider's entry so cleared options do not stay stale", () => {
    const current = normalizeNewSessionDefaults({
      provider: "codex",
      thinking: "on:max",
      reasoningEffort: "max",
      permissionMode: "bypassPermissions",
      codexMcpMode: "full",
    });

    const merged = mergeNewSessionDefaults(current, {
      provider: "codex",
      thinking: "off",
      permissionMode: "plan",
      codexMcpMode: "standard",
      byProvider: {
        codex: {
          thinking: "off",
          permissionMode: "plan",
          codexMcpMode: "standard",
        },
      },
    });

    expect(getNewSessionProviderDefaults(merged, "codex")).toEqual({
      thinking: "off",
      permissionMode: "plan",
      codexMcpMode: "standard",
    });
    expect(merged).not.toHaveProperty("reasoningEffort");
  });
});
