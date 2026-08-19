import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_GATEWAY_CHANNEL_ID,
  invalidateLlmGatewayOverlayCache,
  resolveLlmGatewayChannels,
  resolveLlmGatewayChannelsDetailed,
  resolveLlmGatewayOverlayPath,
} from "../../src/llm-gateways/index.js";

/**
 * The overlay file exists so a rotated gateway key takes effect without editing
 * the service environment and restarting the server: the environment of a
 * launchd/systemd-managed process is frozen at launch, so a key retired
 * elsewhere kept being used until someone restarted Yep.
 */
describe("LLM gateway credentials overlay", () => {
  let dir: string;
  let overlayPath: string;

  const baseEnv = () => ({
    YEP_LLM_GATEWAY_API_KEY: "env-default-key",
    YEP_LLM_GATEWAY_API_BASE: "https://gateway.example/v1",
    YEP_LLM_GATEWAYS:
      "aitl=https://api.example.com/v1|EXTRA_KEY|codex-internal|AppInTheLoop",
    EXTRA_KEY: "env-extra-key",
    YEP_LLM_GATEWAYS_FILE: overlayPath,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-llm-gateways-"));
    overlayPath = join(dir, "llm-gateways.json");
    invalidateLlmGatewayOverlayCache();
  });

  afterEach(async () => {
    invalidateLlmGatewayOverlayCache();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeOverlay(value: unknown): Promise<void> {
    await writeFile(overlayPath, JSON.stringify(value), "utf8");
    invalidateLlmGatewayOverlayCache();
  }

  it("is inert when no overlay file exists", () => {
    const channels = resolveLlmGatewayChannels(baseEnv());
    expect(channels.map((channel) => channel.apiKey)).toEqual([
      "env-default-key",
      "env-extra-key",
    ]);
  });

  it("overrides the key of a channel declared in the environment", async () => {
    await writeOverlay({ channels: [{ id: "aitl", apiKey: "rotated-key" }] });

    const channel = resolveLlmGatewayChannels(baseEnv()).find(
      (candidate) => candidate.id === "aitl",
    );
    expect(channel).toMatchObject({
      apiKey: "rotated-key",
      apiBase: "https://api.example.com/v1",
      subModule: "codex-internal",
      label: "AppInTheLoop",
      // Retained so provider processes still scrub the retired credential from
      // the child environment.
      apiKeyEnv: "EXTRA_KEY",
    });
  });

  it("overrides the default channel key", async () => {
    await writeOverlay({
      channels: [{ id: DEFAULT_LLM_GATEWAY_CHANNEL_ID, apiKey: "rotated" }],
    });

    expect(
      resolveLlmGatewayChannels(baseEnv()).find((channel) => channel.isDefault)
        ?.apiKey,
    ).toBe("rotated");
  });

  it("declares a channel that the environment does not define", async () => {
    await writeOverlay({
      channels: [
        {
          id: "mafia",
          apiBase: "https://api.example.com",
          apiKey: "file-key",
          label: "Mafia",
        },
      ],
    });

    expect(
      resolveLlmGatewayChannels(baseEnv()).find(
        (channel) => channel.id === "mafia",
      ),
    ).toEqual({
      id: "mafia",
      label: "Mafia",
      isDefault: false,
      apiKey: "file-key",
      apiBase: "https://api.example.com/v1",
    });
  });

  it("picks up a rotated key without a restart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await writeOverlay({ channels: [{ id: "aitl", apiKey: "first-key" }] });
      expect(
        resolveLlmGatewayChannels(baseEnv()).find(
          (channel) => channel.id === "aitl",
        )?.apiKey,
      ).toBe("first-key");

      // No cache invalidation here: the file is re-read purely because its
      // stat changed, which is what makes rotation a plain file write.
      await writeFile(
        overlayPath,
        JSON.stringify({ channels: [{ id: "aitl", apiKey: "second-key" }] }),
        "utf8",
      );
      vi.setSystemTime(Date.now() + 5_000);

      expect(
        resolveLlmGatewayChannels(baseEnv()).find(
          (channel) => channel.id === "aitl",
        )?.apiKey,
      ).toBe("second-key");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a malformed overlay instead of dropping working channels", async () => {
    await writeFile(overlayPath, "{not json", "utf8");
    invalidateLlmGatewayOverlayCache();

    const { channels, problems } = resolveLlmGatewayChannelsDetailed(baseEnv());
    expect(channels).toHaveLength(2);
    expect(problems[0]?.reason).toContain("overlay file is not readable JSON");
  });

  it("reports an entry that neither matches nor fully declares a channel", async () => {
    await writeOverlay({ channels: [{ id: "ghost", apiKey: "key" }] });

    const { channels, problems } = resolveLlmGatewayChannelsDetailed(baseEnv());
    expect(channels.map((channel) => channel.id)).toEqual([
      DEFAULT_LLM_GATEWAY_CHANNEL_ID,
      "aitl",
    ]);
    expect(problems[0]?.reason).toBe("apiBase is required");
  });

  it("ignores the data-directory overlay for a fabricated environment", () => {
    expect(resolveLlmGatewayOverlayPath({ HOME: dir })).toBeNull();
    expect(
      resolveLlmGatewayOverlayPath({ YEP_LLM_GATEWAYS_FILE: "/x.json" }),
    ).toBe("/x.json");
  });
});
