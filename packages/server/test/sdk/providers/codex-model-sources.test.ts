import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexModelSourceError,
  CodexModelSourceRegistry,
} from "../../../src/sdk/providers/codex-model-sources.js";

describe("CodexModelSourceRegistry", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "codex-model-sources-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const withKey = () =>
    new CodexModelSourceRegistry({
      env: { DEEPSEEK_API_KEY: "sk-test" },
      dataDir,
    });
  const withoutKey = () => new CodexModelSourceRegistry({ env: {}, dataDir });

  it("always includes the built-in openai source", () => {
    const registry = withoutKey();
    expect(registry.get("openai")?.kind).toBe("builtin");
    expect(registry.getAvailability("openai").available).toBe(true);
  });

  it("marks deepseek available only when its API key is present", () => {
    expect(withKey().getAvailability("deepseek").available).toBe(true);
    const missing = withoutKey().getAvailability("deepseek");
    expect(missing.available).toBe(false);
    expect(missing.reason).toBe("missing_api_key");
  });

  it("never leaks the API key value in the public source summary", () => {
    const sources = withKey().getPublicSources();
    const serialized = JSON.stringify(sources);
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("DEEPSEEK_API_KEY");
    expect(serialized).not.toContain("api.deepseek.com");
  });

  it("rejects unknown sources", () => {
    expect(() => withKey().require("mystery")).toThrow(CodexModelSourceError);
  });

  it("rejects a model that does not belong to the source", () => {
    const registry = withKey();
    expect(() =>
      registry.assertModelSelectable("deepseek", "gpt-5.6-sol"),
    ).toThrowError(/not valid/i);
    expect(() =>
      registry.assertModelSelectable("deepseek", "deepseek-v4-flash"),
    ).not.toThrow();
    expect(() =>
      registry.assertModelSelectable("deepseek", "deepseek-v4-pro"),
    ).not.toThrow();
  });

  it("blocks selecting a source that is unavailable", () => {
    expect(() =>
      withoutKey().assertModelSelectable("deepseek", "deepseek-v4-flash"),
    ).toThrowError(/unavailable/i);
  });

  it("builds pinned app-server args for the source", () => {
    const registry = withKey();
    const openaiArgs = registry.buildAppServerArgs(registry.require("openai"));
    expect(openaiArgs).toEqual(["-c", 'model_provider="openai"']);
    // OpenAI must keep the user's own service_tier preference (not pinned).
    expect(openaiArgs).not.toContain('service_tier="default"');

    const deepseekArgs = registry.buildAppServerArgs(
      registry.require("deepseek"),
    );
    expect(deepseekArgs).toContain('model_provider="deepseek"');
    expect(deepseekArgs).toContain(
      'model_providers.deepseek.base_url="https://api.deepseek.com/"',
    );
    expect(deepseekArgs).toContain(
      'model_providers.deepseek.env_key="DEEPSEEK_API_KEY"',
    );
    // Pin the neutral service tier so a global OpenAI-only tier does not leak.
    expect(deepseekArgs).toContain('service_tier="default"');
    expect(
      deepseekArgs.some((arg) => arg.startsWith("model_catalog_json=")),
    ).toBe(true);
  });

  it("materializes a valid catalog with the model's context window", () => {
    const registry = withKey();
    const catalogPath = registry.materializeCatalog(
      registry.require("deepseek"),
    );
    expect(catalogPath).toBeTruthy();
    expect(existsSync(catalogPath as string)).toBe(true);
    const parsed = JSON.parse(readFileSync(catalogPath as string, "utf8"));
    expect(parsed.models.map((model: { slug: string }) => model.slug)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(parsed.models[0].context_window).toBe(1_000_000);
    expect(parsed.models[1].context_window).toBe(1_000_000);
  });

  it("maps a model slug back to its owning custom source", () => {
    const registry = withKey();
    expect(registry.findModelSource("deepseek-v4-flash")).toBe("deepseek");
    expect(registry.findModelSource("deepseek-v4-pro")).toBe("deepseek");
    // OpenAI live models have no catalog owner.
    expect(registry.findModelSource("gpt-5.6-sol")).toBeUndefined();
    expect(registry.findModelSource(undefined)).toBeUndefined();
  });

  it("exposes catalog models as composite picker ModelInfo", () => {
    const registry = withKey();
    const infos = registry.getCatalogModelInfos(registry.require("deepseek"));
    expect(infos).toEqual([
      expect.objectContaining({
        id: "deepseek/deepseek-v4-flash",
        modelProvider: "deepseek",
        providerModelId: "deepseek-v4-flash",
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({
        id: "deepseek/deepseek-v4-pro",
        modelProvider: "deepseek",
        providerModelId: "deepseek-v4-pro",
        contextWindow: 1_000_000,
      }),
    ]);
  });

  it("uses DeepSeek's advertised tiers and official compatibility mapping", () => {
    const registry = withKey();
    // DeepSeek advertises low/high/max; supported tiers pass through.
    expect(
      registry.resolveReasoningEffort("deepseek", "deepseek-v4-flash", "low"),
    ).toBe("low");
    expect(
      registry.resolveReasoningEffort("deepseek", "deepseek-v4-flash", "high"),
    ).toBe("high");
    expect(
      registry.resolveReasoningEffort("deepseek", "deepseek-v4-pro", "max"),
    ).toBe("max");
    // The official compatibility table maps medium/xhigh to high.
    expect(
      registry.resolveReasoningEffort(
        "deepseek",
        "deepseek-v4-flash",
        "medium",
      ),
    ).toBe("high");
    expect(
      registry.resolveReasoningEffort("deepseek", "deepseek-v4-flash", "xhigh"),
    ).toBe("high");
    // Unknown higher tiers clamp to the highest advertised tier.
    expect(
      registry.resolveReasoningEffort("deepseek", "deepseek-v4-flash", "ultra"),
    ).toBe("max");
    // Unknown values fall back to the model's default.
    expect(
      registry.resolveReasoningEffort("deepseek", "deepseek-v4-flash", "bogus"),
    ).toBe("high");
    // Missing request is passed through (no effort to resolve).
    expect(
      registry.resolveReasoningEffort(
        "deepseek",
        "deepseek-v4-flash",
        undefined,
      ),
    ).toBeUndefined();
  });

  it("keeps the full tier set for the built-in openai source", () => {
    const registry = withKey();
    expect(registry.resolveReasoningEffort("openai", undefined, "xhigh")).toBe(
      "xhigh",
    );
    expect(registry.resolveReasoningEffort("openai", undefined, "max")).toBe(
      "max",
    );
  });
});
