import { afterEach, describe, expect, it, vi } from "vitest";

const STATE_KEY = Symbol.for("yep.pi.provider-config.v1");

function resetExtensionState(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[STATE_KEY];
}

async function loadExtension() {
  // The extension caches its parsed config on globalThis (Pi reloads
  // extensions after a native fork), so the state key is cleared per test.
  return await import("../../resources/pi-yep-extension.mjs");
}

const PROVIDER_CONFIG = JSON.stringify({
  providers: [
    {
      id: "yep-anthropic",
      config: {
        name: "default (Anthropic)",
        baseUrl: "https://default.example",
        api: "anthropic-messages",
        models: [],
      },
    },
    {
      id: "yep-anthropic-aitl",
      config: {
        name: "extra (Anthropic)",
        baseUrl: "https://extra.example",
        api: "anthropic-messages",
        models: [],
      },
    },
  ],
});

describe("Pi extension gateway credentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetExtensionState();
  });

  it("gives each generated provider its own gateway key and scrubs the env", async () => {
    resetExtensionState();
    vi.stubEnv("YEP_PI_PROVIDER_CONFIG", PROVIDER_CONFIG);
    vi.stubEnv(
      "YEP_PI_LLM_API_KEYS",
      JSON.stringify({
        "yep-anthropic": "default-secret",
        "yep-anthropic-aitl": "extra-secret",
      }),
    );

    const extension = await loadExtension();
    const registerProvider = vi.fn();
    extension.default({ registerProvider, on: vi.fn() });

    expect(registerProvider).toHaveBeenCalledWith(
      "yep-anthropic",
      expect.objectContaining({ apiKey: "default-secret" }),
    );
    expect(registerProvider).toHaveBeenCalledWith(
      "yep-anthropic-aitl",
      expect.objectContaining({ apiKey: "extra-secret" }),
    );
    // Pi's bash tool inherits process.env, so nothing may remain behind.
    expect(process.env.YEP_PI_LLM_API_KEYS).toBeUndefined();
    expect(process.env.YEP_PI_PROVIDER_CONFIG).toBeUndefined();
  });

  it("drops a provider with no credential instead of registering a failing model", async () => {
    resetExtensionState();
    vi.stubEnv("YEP_PI_PROVIDER_CONFIG", PROVIDER_CONFIG);
    vi.stubEnv(
      "YEP_PI_LLM_API_KEYS",
      JSON.stringify({ "yep-anthropic": "default-secret" }),
    );

    const extension = await loadExtension();
    const registerProvider = vi.fn();
    extension.default({ registerProvider, on: vi.fn() });

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(
      "yep-anthropic",
      expect.objectContaining({ apiKey: "default-secret" }),
    );
  });

  it("still honours the legacy single-key variable", async () => {
    resetExtensionState();
    vi.stubEnv("YEP_PI_PROVIDER_CONFIG", PROVIDER_CONFIG);
    vi.stubEnv("YEP_PI_LLM_API_KEY", "legacy-secret");

    const extension = await loadExtension();
    const registerProvider = vi.fn();
    extension.default({ registerProvider, on: vi.fn() });

    expect(registerProvider.mock.calls.map(([id]) => id)).toEqual([
      "yep-anthropic",
      "yep-anthropic-aitl",
    ]);
    for (const [, config] of registerProvider.mock.calls) {
      expect(config).toMatchObject({ apiKey: "legacy-secret" });
    }
    expect(process.env.YEP_PI_LLM_API_KEY).toBeUndefined();
  });

  it("registers nothing when no credential is supplied", async () => {
    resetExtensionState();
    vi.stubEnv("YEP_PI_PROVIDER_CONFIG", PROVIDER_CONFIG);

    const extension = await loadExtension();
    const registerProvider = vi.fn();
    extension.default({ registerProvider, on: vi.fn() });

    expect(registerProvider).not.toHaveBeenCalled();
  });
});
