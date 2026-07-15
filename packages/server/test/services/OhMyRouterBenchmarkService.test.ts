import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OhMyRouterBenchmarkService,
  type OhMyRouterThroughputBenchmark,
  benchmarkOhMyRouterModel,
} from "../../src/services/OhMyRouterBenchmarkService.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../../src/services/ServerSettingsService.js";

const config = {
  apiKey: "test-key",
  apiBase: "https://api.ohmyrouter.com/v1",
  subModule: "claude-code-internal",
};

function sseResponse(lines: string[]): Response {
  return new Response(lines.join("\n\n"), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("benchmarkOhMyRouterModel", () => {
  it("uses the streamed usage count and measures output throughput", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"token token"}}]}',
        'data: {"choices":[],"usage":{"completion_tokens":2}}',
        "data: [DONE]",
      ]),
    );

    const result = await benchmarkOhMyRouterModel({
      config,
      model: {
        id: "test-model",
        name: "Test model",
        supportedRequestProtocols: ["openai-compatible"],
      },
      fetchImpl,
    });

    expect(result).toMatchObject({
      modelId: "test-model",
      protocol: "openai-compatible",
      outputTokens: 2,
      tokenCountSource: "reported",
    });
    expect(result.tokensPerSecond).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.ohmyrouter.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "X-Sub-Module": "claude-code-internal",
        }),
      }),
    );
  });
});

describe("OhMyRouterBenchmarkService", () => {
  let settings: ServerSettings;
  let serverSettingsService: {
    getSetting: <K extends keyof ServerSettings>(key: K) => ServerSettings[K];
    updateSettings: (
      updates: Partial<ServerSettings>,
    ) => Promise<ServerSettings>;
  };

  beforeEach(() => {
    settings = { serviceWorkerEnabled: true };
    serverSettingsService = {
      getSetting: (key) => settings[key],
      updateSettings: async (updates) => {
        settings = { ...settings, ...updates };
        return settings;
      },
    };
  });

  it("runs every model returned by the OhMyRouter catalog and persists results", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "test-model",
                name: "Test model",
                supported_endpoint_types: ["openai"],
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"token token"}}]}',
          'data: {"choices":[],"usage":{"completion_tokens":2}}',
          "data: [DONE]",
        ]),
      );
    const service = new OhMyRouterBenchmarkService({
      serverSettingsService: serverSettingsService as ServerSettingsService,
      env: {
        OPENCODE_LLM_API_KEY: "test-key",
        OPENCODE_LLM_API_BASE: "https://api.ohmyrouter.com",
      },
      fetchImpl,
    });

    const started = await service.start();

    expect(started.status).toBe("running");
    await vi.waitFor(() => {
      expect(settings.ohmyrouterThroughputBenchmark?.status).toBe("completed");
    });
    expect(settings.ohmyrouterThroughputBenchmark).toMatchObject({
      totalModels: 1,
      completedModels: 1,
      results: [{ modelId: "test-model", outputTokens: 2 }],
    });
  });

  it("marks an in-progress benchmark as interrupted during startup", async () => {
    const benchmark: OhMyRouterThroughputBenchmark = {
      id: "previous-run",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      totalModels: 2,
      completedModels: 1,
      results: [],
    };
    settings.ohmyrouterThroughputBenchmark = benchmark;
    const service = new OhMyRouterBenchmarkService({
      serverSettingsService: serverSettingsService as ServerSettingsService,
    });

    await service.initialize();

    expect(settings.ohmyrouterThroughputBenchmark).toMatchObject({
      id: "previous-run",
      status: "interrupted",
    });
  });
});
