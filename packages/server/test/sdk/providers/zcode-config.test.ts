/**
 * ZCode config/registry adapter tests.
 *
 * Tests `parseZCodeConfig`, `buildZCodeProviderRegistry`,
 * `buildCompositeId`, `resolveZCodeCompositeModelId`, and
 * `buildZCodeCatalogMap` against synthetic config/credentials objects.
 *
 * Uses the REAL ZCode 0.16.1 config structure:
 *   - Root key: singular `provider` (object map, NOT array)
 *   - Each provider: `name`, `kind`, `options`, `enabled`, `source`, `models`
 *   - `models` is an object map keyed by model ID (NOT array)
 *   - Secrets live in `options.apiKey`, `options.headers`
 *   - `systemDisabledReason` marks providers as system-disabled
 *
 * Secret sentinel regression: a fake API key `sk-test-sentinel-DO-NOT-LEAK`
 * must never appear in the output of any function under test.
 */

import { describe, expect, it } from "vitest";
import {
  buildCompositeId,
  buildZCodeCatalogMap,
  buildZCodeProviderRegistry,
  parseZCodeConfig,
  resolveZCodeCompositeModelId,
  resolveZCodeThoughtLevel,
} from "../../../src/sdk/providers/zcode-protocol/config.js";
import type {
  ZCodeConfigParseResult,
  ZCodeModelCatalogEntry,
} from "../../../src/sdk/providers/zcode-protocol/types.js";

// =============================================================================
// Synthetic test data (matches REAL ZCode 0.16.1 config structure)
// =============================================================================

const SECRET_SENTINEL = "sk-test-sentinel-DO-NOT-LEAK";

/**
 * A config with multiple providers matching the real ZCode 0.16.1 structure.
 * - `zai`: inline key in options, enabled
 * - `openai`: env-referenced key (legacy compat path), enabled
 * - `anthropic`: runtime headers, enabled
 * - `broken`: no key, enabled
 * - `disabled`: has key but enabled=false
 * - `sysdisabled`: has key but systemDisabledReason set
 */
const multiProviderConfig = {
  // Real CLI uses singular `provider` (NOT `providers`)
  provider: {
    zai: {
      name: "Z.AI",
      kind: "openai-compatible",
      enabled: true,
      source: "custom",
      options: { apiKey: SECRET_SENTINEL, baseURL: "https://api.z.ai" },
      models: {
        "glm-4.6": { name: "GLM-4.6" },
        "glm-4.5": { name: "GLM-4.5" },
      },
    },
    openai: {
      name: "OpenAI",
      kind: "openai",
      enabled: true,
      source: "custom",
      options: {
        apiKey: "openai-key-value",
        baseURL: "https://api.openai.com",
      },
      models: {
        "gpt-4o": { name: "GPT-4o" },
      },
    },
    anthropic: {
      name: "Anthropic",
      kind: "anthropic",
      enabled: true,
      source: "custom",
      options: {
        baseURL: "https://api.anthropic.com",
        headers: { "x-api-key": "anthropic-key" },
      },
      models: {
        "claude-sonnet-4": { name: "Claude Sonnet 4" },
      },
    },
    broken: {
      name: "No Key",
      kind: "openai",
      enabled: true,
      source: "custom",
      options: { baseURL: "https://broken.example.com" },
      models: {
        "gpt-4o-mini": { name: "GPT-4o-mini" },
      },
    },
    disabled: {
      name: "Disabled",
      kind: "openai",
      enabled: false,
      source: "custom",
      options: { apiKey: "disabled-key" },
      models: {
        "gpt-4o": { name: "GPT-4o" },
      },
    },
    sysdisabled: {
      name: "System Disabled",
      kind: "anthropic",
      enabled: true,
      source: "custom",
      systemDisabledReason: "oauth_provider_inactive",
      options: { apiKey: "sysdisabled-key" },
      models: {
        "claude-opus-4": { name: "Claude Opus 4" },
      },
    },
  },
  // Unknown top-level fields should be silently dropped.
  uiSettings: { theme: "dark" },
};

const multiProviderCredentials = {
  providers: {
    zai: { apiKey: SECRET_SENTINEL }, // same sentinel, different location
  },
  // Unknown fields should be dropped.
  other: { data: "should-be-ignored" },
};

// =============================================================================
// Tests
// =============================================================================

describe("ZCode config adapter", () => {
  describe("parseZCodeConfig", () => {
    it("parses multiple providers", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      expect(result.errorCode).toBeNull();
      // 6 providers: zai, openai, anthropic, broken, disabled, sysdisabled
      expect(result.providers).toHaveLength(6);
    });

    it("marks providers with inline keys as available", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const zai = result.providers.find((p) => p.id === "zai");
      expect(zai?.hasSecret).toBe(true);
      expect(zai?.apiKeySource).toBe("inline");
    });

    it("marks providers with headers as available via runtime-headers", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const anthropic = result.providers.find((p) => p.id === "anthropic");
      expect(anthropic?.hasSecret).toBe(true);
      expect(anthropic?.apiKeySource).toBe("runtime-headers");
    });

    it("carries a compatibility credentials-file key into the registry", () => {
      const result = parseZCodeConfig(
        {
          provider: {
            credentialed: {
              kind: "openai",
              models: { "gpt-test": {} },
            },
          },
        },
        { providers: { credentialed: { apiKey: "credential-secret" } } },
      );

      expect(result.catalog[0]?.available).toBe(true);
      expect(buildZCodeProviderRegistry(result)[0]?.apiKey).toEqual({
        source: "inline",
        value: "credential-secret",
      });
    });

    it("rejects non-string runtime headers instead of building an invalid registry", () => {
      const result = parseZCodeConfig(
        {
          provider: {
            malformed: {
              kind: "openai-compatible",
              options: { headers: { authorization: { token: "secret" } } },
              models: { model: {} },
            },
          },
        },
        {},
      );

      expect(result.providers[0]?.hasSecret).toBe(false);
      expect(result.catalog[0]?.available).toBe(false);
      expect(buildZCodeProviderRegistry(result)).toEqual([]);
    });

    it("marks providers without secrets as unavailable", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const broken = result.providers.find((p) => p.id === "broken");
      expect(broken?.hasSecret).toBe(false);
    });

    it("marks disabled providers with enabled=false", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const disabled = result.providers.find((p) => p.id === "disabled");
      expect(disabled?.enabled).toBe(false);
    });

    it("marks system-disabled providers with systemDisabledReason", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const sysdisabled = result.providers.find((p) => p.id === "sysdisabled");
      expect(sysdisabled?.systemDisabledReason).toBe("oauth_provider_inactive");
    });

    it("builds composite IDs for catalog entries", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const ids = result.catalog.map((e) => e.compositeId);
      expect(ids).toContain("zai/glm-4.6");
      expect(ids).toContain("zai/glm-4.5");
      expect(ids).toContain("openai/gpt-4o");
      expect(ids).toContain("anthropic/claude-sonnet-4");
    });

    it("marks catalog entries with available=false when provider lacks secret", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const brokenEntry = result.catalog.find(
        (e) => e.compositeId === "broken/gpt-4o-mini",
      );
      expect(brokenEntry?.available).toBe(false);
      expect(brokenEntry?.unavailableReason).toBe("zcode_model_unavailable");
    });

    it("marks catalog entries with available=true when provider has secret", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const zaiEntry = result.catalog.find(
        (e) => e.compositeId === "zai/glm-4.6",
      );
      expect(zaiEntry?.available).toBe(true);
    });

    it("marks catalog entries available=false for disabled providers", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const disabledEntry = result.catalog.find(
        (e) => e.compositeId === "disabled/gpt-4o",
      );
      expect(disabledEntry?.available).toBe(false);
    });

    it("marks catalog entries available=false for system-disabled providers", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const sysdisabledEntry = result.catalog.find(
        (e) => e.compositeId === "sysdisabled/claude-opus-4",
      );
      expect(sysdisabledEntry?.available).toBe(false);
    });

    it("returns zcode_config_unavailable when config is not an object", () => {
      const result = parseZCodeConfig(null, null);
      expect(result.errorCode).toBe("zcode_config_unavailable");
      expect(result.providers).toHaveLength(0);
    });

    it("returns zcode_config_unavailable when config has no provider or providers", () => {
      const result = parseZCodeConfig({}, {});
      expect(result.errorCode).toBe("zcode_config_unavailable");
    });

    it("does not crash with malformed provider entries", () => {
      const malformedConfig = {
        provider: {
          bad: "not-an-object", // string instead of object
        },
      };
      const result = parseZCodeConfig(malformedConfig, {});
      // Should either skip or return unavailable, not crash.
      expect(result).toBeDefined();
    });

    it("supports legacy `providers` key for backward compat", () => {
      const legacyConfig = {
        providers: {
          zai: {
            kind: "openai-compatible",
            options: { apiKey: "test-key" },
            models: { "glm-4.6": { name: "GLM-4.6" } },
          },
        },
      };
      const result = parseZCodeConfig(legacyConfig, {});
      expect(result.errorCode).toBeNull();
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0]?.id).toBe("zai");
    });
  });

  describe("unknown provider kinds", () => {
    it("marks unknown kinds as unavailable (fail-closed)", () => {
      const config = {
        provider: {
          unknown: {
            name: "Unknown",
            kind: "some-unknown-kind",
            options: { apiKey: "test-key" },
            models: { "model-1": {} },
          },
        },
      };
      const result = parseZCodeConfig(config, {});
      // Unknown kind provider is parsed but models should not be catalogued
      // as available (they'd be in the catalog with available=false).
      const unknownProvider = result.providers.find((p) => p.id === "unknown");
      expect(unknownProvider).toBeDefined();
      expect(unknownProvider?.hasSecret).toBe(false);
    });
  });

  describe("secret sentinel regression", () => {
    /**
     * The `apiKeyValue` is included in the parsed result because it's needed
     * server-side to build the registry entry. However, it must NEVER appear
     * in the client-facing model catalog.  The catalog is what gets returned
     * to the browser via `/api/providers`.
     */
    it("does not include the API key in the client-facing catalog", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      // The catalog is what gets returned to the client — check it doesn't leak.
      const catalogSerialized = JSON.stringify(result.catalog);
      expect(catalogSerialized).not.toContain(SECRET_SENTINEL);
      expect(catalogSerialized).not.toContain("sk-test-sentinel");
      expect(catalogSerialized).not.toContain("apiKey");
    });

    /**
     * The registry entries DO contain the apiKey value as
     * `{source: "inline", value: ...}` because the real CLI 0.16.1 requires
     * it for authentication.  However, the registry is only sent to the
     * app-server child process over stdio — never to the client API or logs.
     *
     * This test verifies the registry entry uses the correct inline format
     * and that the sentinel is present in the value (not leaked elsewhere).
     */
    it("includes apiKey as inline value object in registry entries", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const registry = buildZCodeProviderRegistry(result);
      const zaiEntry = registry.find((r) => r.providerId === "zai");
      expect(zaiEntry?.apiKey).toEqual({
        source: "inline",
        value: SECRET_SENTINEL,
      });
    });

    it("does not include apiKey in the catalog entries", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      // Catalog entries should not have apiKey field at all.
      for (const entry of result.catalog) {
        const serialized = JSON.stringify(entry);
        expect(serialized).not.toContain(SECRET_SENTINEL);
        expect(serialized).not.toContain("apiKey");
      }
    });
  });

  describe("buildZCodeProviderRegistry", () => {
    it("only includes available providers (hasSecret && enabled && !sysdisabled)", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const registry = buildZCodeProviderRegistry(result);
      const ids = registry.map((r) => r.providerId);
      expect(ids).toContain("zai");
      expect(ids).toContain("anthropic");
      // "broken" should not be in the registry (no secret).
      expect(ids).not.toContain("broken");
      // "disabled" should not be in the registry (enabled=false).
      expect(ids).not.toContain("disabled");
      // "sysdisabled" should not be in the registry (systemDisabledReason).
      expect(ids).not.toContain("sysdisabled");
    });

    it("includes models for each provider with real registry structure", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const registry = buildZCodeProviderRegistry(result);
      const zai = registry.find((r) => r.providerId === "zai");
      expect(zai?.models).toHaveLength(2);
      const modelIds = zai?.models?.map((m) => m.modelId);
      expect(modelIds).toContain("glm-4.6");
      expect(modelIds).toContain("glm-4.5");
    });

    it("uses providerId/modelId (NOT id) in registry entries", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const registry = buildZCodeProviderRegistry(result);
      // Real CLI 0.16.1 uses providerId and modelId, NOT id.
      expect(registry[0]?.providerId).toBeDefined();
      expect(registry[0]?.models?.[0]?.modelId).toBeDefined();
      // Should not have legacy `id` field
      expect("id" in (registry[0] ?? {})).toBe(false);
    });

    it("includes baseURL and headers in registry entries", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const registry = buildZCodeProviderRegistry(result);
      const zai = registry.find((r) => r.providerId === "zai");
      expect(zai?.baseURL).toBe("https://api.z.ai");
      expect(zai?.apiKey).toEqual({
        source: "inline",
        value: SECRET_SENTINEL,
      });

      // Anthropic provider should have headers from options
      const anthropic = registry.find((r) => r.providerId === "anthropic");
      expect(anthropic?.headers).toBeDefined();
      expect(anthropic?.headers?.["x-api-key"]).toBe("anthropic-key");
    });

    it("uses source: 'custom' in registry entries", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const registry = buildZCodeProviderRegistry(result);
      expect(registry[0]?.source).toBe("custom");
    });

    /**
     * Real CLI 0.16.1 strict schema (probed 2026-08-13): the registry entry
     * rejects `name` with "Unrecognized key" and requires `models` to be a
     * non-empty array.  Sending `name` or omitting `models` fails the entire
     * `workspace/updateProviderRegistry` request with -32602.
     */
    it("never emits `name` keys and always emits a non-empty models array", () => {
      const result = parseZCodeConfig(
        multiProviderConfig,
        multiProviderCredentials,
      );
      const registry = buildZCodeProviderRegistry(result);
      expect(registry.length).toBeGreaterThan(0);
      for (const entry of registry) {
        expect("name" in entry).toBe(false);
        expect(Array.isArray(entry.models)).toBe(true);
        expect(entry.models.length).toBeGreaterThanOrEqual(1);
        for (const model of entry.models) {
          expect("name" in model).toBe(false);
        }
      }
    });

    it("skips providers with a secret but zero catalogued models", () => {
      const result = parseZCodeConfig(
        {
          provider: {
            empty: {
              name: "Empty",
              kind: "openai-compatible",
              options: { apiKey: SECRET_SENTINEL },
              enabled: true,
              models: {},
            },
          },
        },
        {},
      );
      const registry = buildZCodeProviderRegistry(result);
      expect(registry.find((r) => r.providerId === "empty")).toBeUndefined();
    });
  });

  describe("composite ID helpers", () => {
    it("builds composite IDs as providerId/modelId", () => {
      expect(buildCompositeId("zai", "glm-4.6")).toBe("zai/glm-4.6");
    });

    it("resolves composite IDs back to catalog entries", () => {
      const catalog: ZCodeModelCatalogEntry[] = [
        {
          compositeId: "zai/glm-4.6",
          providerId: "zai",
          modelId: "glm-4.6",
          available: true,
          thoughtLevels: [],
        },
      ];
      const entry = resolveZCodeCompositeModelId(catalog, "zai/glm-4.6");
      expect(entry).toBeDefined();
      expect(entry?.providerId).toBe("zai");
      expect(entry?.modelId).toBe("glm-4.6");
    });

    it("returns undefined for unknown composite IDs", () => {
      const entry = resolveZCodeCompositeModelId([], "zai/glm-4.6");
      expect(entry).toBeUndefined();
    });

    it("builds a catalog map for O(1) lookup", () => {
      const catalog: ZCodeModelCatalogEntry[] = [
        {
          compositeId: "a/1",
          providerId: "a",
          modelId: "1",
          available: true,
          thoughtLevels: [],
        },
        {
          compositeId: "b/2",
          providerId: "b",
          modelId: "2",
          available: false,
          thoughtLevels: [],
        },
      ];
      const map = buildZCodeCatalogMap(catalog);
      expect(map.get("a/1")).toBeDefined();
      expect(map.get("b/2")).toBeDefined();
      expect(map.get("c/3")).toBeUndefined();
      expect(map.size).toBe(2);
    });
  });

  describe("thought levels (reasoning capability)", () => {
    function catalogFor(reasoning: unknown) {
      const result = parseZCodeConfig(
        {
          provider: {
            p: {
              name: "P",
              kind: "anthropic",
              options: { apiKey: "key" },
              models: { m: { name: "M", reasoning } },
            },
          },
        },
        {},
      );
      const entry = result.catalog.find((e) => e.compositeId === "p/m");
      expect(entry).toBeDefined();
      return entry as NonNullable<typeof entry>;
    }

    it("extracts variants and the default variant from a reasoning object", () => {
      // Real ZCode 0.16.1 GLM-5-Turbo capability.
      const entry = catalogFor({
        enabled: true,
        variants: ["enabled", "off"],
        defaultVariant: "enabled",
      });
      expect(entry.thoughtLevels).toEqual(["enabled", "off"]);
      expect(entry.defaultThoughtLevel).toBe("enabled");
    });

    it("reports no levels for reasoning: null", () => {
      // Real ZCode 0.16.1 GLM-5.2 capability.
      const entry = catalogFor(null);
      expect(entry.thoughtLevels).toEqual([]);
      expect(entry.defaultThoughtLevel).toBeUndefined();
    });

    it("reports no levels when the field is absent", () => {
      const entry = catalogFor(undefined);
      expect(entry.thoughtLevels).toEqual([]);
    });

    it("reports no levels for a bare reasoning: true (no named variants)", () => {
      const entry = catalogFor(true);
      expect(entry.thoughtLevels).toEqual([]);
    });

    it("reports no levels when reasoning is explicitly disabled", () => {
      const entry = catalogFor({
        enabled: false,
        variants: ["enabled", "off"],
        defaultVariant: "enabled",
      });
      expect(entry.thoughtLevels).toEqual([]);
    });

    it("drops blank and duplicate variants while preserving config order", () => {
      const entry = catalogFor({
        enabled: true,
        variants: ["high", "  ", "high", "low"],
      });
      expect(entry.thoughtLevels).toEqual(["high", "low"]);
    });

    it("ignores a defaultVariant that is not among the variants", () => {
      const entry = catalogFor({
        enabled: true,
        variants: ["enabled"],
        defaultVariant: "off",
      });
      expect(entry.thoughtLevels).toEqual(["enabled"]);
      expect(entry.defaultThoughtLevel).toBeUndefined();
    });

    it("does not break parsing when reasoning has an unexpected shape", () => {
      const entry = catalogFor({ enabled: true, variants: "enabled" });
      expect(entry.thoughtLevels).toEqual([]);
    });
  });

  describe("resolveZCodeThoughtLevel", () => {
    const withLevels = {
      compositeId: "p/m",
      providerId: "p",
      modelId: "m",
      available: true,
      thoughtLevels: ["enabled", "off"],
      defaultThoughtLevel: "enabled",
    } satisfies ZCodeModelCatalogEntry;
    const withoutLevels = {
      compositeId: "p/n",
      providerId: "p",
      modelId: "n",
      available: true,
      thoughtLevels: [],
    } satisfies ZCodeModelCatalogEntry;

    it("returns a requested level the model advertises", () => {
      expect(resolveZCodeThoughtLevel(withLevels, "off")).toBe("off");
    });

    it("trims the requested level before matching", () => {
      expect(resolveZCodeThoughtLevel(withLevels, "  off  ")).toBe("off");
    });

    it("drops a requested level the model does not advertise", () => {
      // Mirrors the CLI's own guard: unsupported levels are not applied.
      expect(resolveZCodeThoughtLevel(withLevels, "xhigh")).toBeUndefined();
    });

    it("falls back to the model default when nothing is requested", () => {
      expect(resolveZCodeThoughtLevel(withLevels)).toBe("enabled");
      expect(resolveZCodeThoughtLevel(withLevels, null)).toBe("enabled");
      expect(resolveZCodeThoughtLevel(withLevels, "   ")).toBe("enabled");
    });

    it("returns undefined for a model with no thought levels", () => {
      expect(
        resolveZCodeThoughtLevel(withoutLevels, "enabled"),
      ).toBeUndefined();
      expect(resolveZCodeThoughtLevel(withoutLevels)).toBeUndefined();
    });

    it("returns undefined for an unknown model", () => {
      expect(resolveZCodeThoughtLevel(undefined, "enabled")).toBeUndefined();
    });
  });

  describe("duplicate model IDs across providers", () => {
    it("disambiguates via composite ID when model IDs collide", () => {
      const config = {
        provider: {
          a: {
            name: "Provider A",
            kind: "openai",
            options: { apiKey: "key-a" },
            models: { "gpt-4o": { name: "GPT-4o A" } },
          },
          b: {
            name: "Provider B",
            kind: "openai-compatible",
            options: { apiKey: "key-b" },
            models: { "gpt-4o": { name: "GPT-4o B" } },
          },
        },
      };
      const result = parseZCodeConfig(config, {});
      const ids = result.catalog.map((e) => e.compositeId);
      expect(ids).toContain("a/gpt-4o");
      expect(ids).toContain("b/gpt-4o");
      expect(ids).toHaveLength(2);
    });
  });
});

// Suppress unused type import warning.
void (null as unknown as ZCodeConfigParseResult);
