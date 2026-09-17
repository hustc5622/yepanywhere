import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmGatewayKeysService } from "../../src/llm-gateways/LlmGatewayKeysService.js";
import {
  envGatewayKeyId,
  isKnownGatewayKeyId,
  maskApiKey,
  readStoredGatewayKeys,
  resolveGatewayKeyForChannel,
  writeStoredGatewayKeys,
} from "../../src/llm-gateways/gateway-keys.js";
import { invalidateLlmGatewayOverlayCache } from "../../src/llm-gateways/index.js";

/**
 * Per-session gateway keys exist because one aggregator hands out several
 * tokens with different quotas and different model allowlists: which one a
 * session burns must be a per-session decision, not a process-wide one.
 */
describe("gateway keys", () => {
  let dir: string;
  let keysPath: string;

  const env = () => ({
    YEP_LLM_GATEWAY_API_KEY: "sk-default-environment-key",
    YEP_LLM_GATEWAY_API_BASE: "https://gateway.example/v1",
    YEP_LLM_GATEWAYS:
      "aitl=https://api.example.com/v1|EXTRA_KEY|codex-internal|AppInTheLoop",
    EXTRA_KEY: "sk-extra-environment-key",
    YEP_LLM_GATEWAY_KEYS_FILE: keysPath,
    // Keep the real data-dir overlay out of these assertions.
    YEP_LLM_GATEWAYS_FILE: join(dir, "llm-gateways.json"),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-gateway-keys-"));
    keysPath = join(dir, "llm-gateway-keys.json");
    invalidateLlmGatewayOverlayCache();
  });

  afterEach(async () => {
    invalidateLlmGatewayOverlayCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("masks credentials instead of exposing them", () => {
    expect(maskApiKey("sk-tmm76HCd6oAMHxajGSapiku55fju")).toBe("sk-tmm…5fju");
    expect(maskApiKey("short")).toBe("sk-****");
  });

  it("round-trips stored keys", () => {
    const stored = [
      {
        id: "gwkey-1",
        channelId: "aitl",
        label: "Claude-only key",
        apiKey: "sk-session-key",
        createdAt: new Date().toISOString(),
      },
    ];
    writeStoredGatewayKeys(stored, env());
    expect(readStoredGatewayKeys(env())).toEqual(stored);
  });

  it("only resolves a key for the channel that owns it", () => {
    writeStoredGatewayKeys(
      [
        {
          id: "gwkey-1",
          channelId: "aitl",
          label: null,
          apiKey: "sk-session-key",
          createdAt: new Date().toISOString(),
        },
      ],
      env(),
    );
    expect(resolveGatewayKeyForChannel("aitl", "gwkey-1", env())).toBe(
      "sk-session-key",
    );
    // Another channel must never be routed through a foreign credential.
    expect(resolveGatewayKeyForChannel("default", "gwkey-1", env())).toBeNull();
    // A removed key degrades to the environment credential.
    expect(resolveGatewayKeyForChannel("aitl", "gwkey-gone", env())).toBeNull();
    // `env:<channel>` means "use the environment key".
    expect(
      resolveGatewayKeyForChannel("aitl", envGatewayKeyId("aitl"), env()),
    ).toBeNull();
  });

  it("validates selectable key ids", () => {
    writeStoredGatewayKeys(
      [
        {
          id: "gwkey-1",
          channelId: "aitl",
          label: null,
          apiKey: "sk-session-key",
          createdAt: new Date().toISOString(),
        },
        {
          id: "gwkey-orphan",
          channelId: "removed-channel",
          label: null,
          apiKey: "sk-orphan",
          createdAt: new Date().toISOString(),
        },
      ],
      env(),
    );
    expect(isKnownGatewayKeyId("gwkey-1", env())).toBe(true);
    expect(isKnownGatewayKeyId(envGatewayKeyId("default"), env())).toBe(true);
    expect(isKnownGatewayKeyId("gwkey-orphan", env())).toBe(false);
    expect(isKnownGatewayKeyId("gwkey-unknown", env())).toBe(false);
  });

  it("lists every channel with its environment key first", async () => {
    writeStoredGatewayKeys(
      [
        {
          id: "gwkey-1",
          channelId: "aitl",
          label: "Claude-only key",
          apiKey: "sk-session-key-1234",
          createdAt: new Date().toISOString(),
        },
      ],
      env(),
    );
    const service = new LlmGatewayKeysService({ env: env() });
    const channels = await service.list();
    expect(channels.map((channel) => channel.id)).toEqual(["default", "aitl"]);

    const aitl = channels.find((channel) => channel.id === "aitl");
    expect(aitl?.keys.map((key) => key.id)).toEqual([
      envGatewayKeyId("aitl"),
      "gwkey-1",
    ]);
    // Credentials never leave the server.
    expect(JSON.stringify(channels)).not.toContain("sk-session-key-1234");
    expect(JSON.stringify(channels)).not.toContain("sk-extra-environment-key");
  });

  it("rejects a key the gateway does not accept", async () => {
    const service = new LlmGatewayKeysService({
      env: env(),
      fetchImpl: (async () =>
        new Response("nope", { status: 401 })) as typeof fetch,
    });
    await expect(
      service.addKey({ channelId: "aitl", apiKey: "sk-bad" }),
    ).rejects.toThrow(/AppInTheLoop.*401/);
    expect(readStoredGatewayKeys(env())).toEqual([]);
  });

  it("reports model access and hides the unlimited balance sentinel", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return Response.json({
          data: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
        });
      }
      if (url.includes("/billing/subscription")) {
        return Response.json({ hard_limit_usd: 100_000_000 });
      }
      return Response.json({ total_usage: 0 });
    }) as typeof fetch;

    const service = new LlmGatewayKeysService({ env: env(), fetchImpl });
    const added = await service.addKey({
      channelId: "aitl",
      apiKey: "sk-good-key-value",
      label: "Claude only",
    });
    expect(added.status?.ok).toBe(true);
    expect(added.status?.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    // An unlimited sentinel is reported as "no quota published", never as a
    // hundred-million-dollar balance.
    expect(added.status?.unlimited).toBe(true);
    expect(added.status?.balanceUsd).toBeNull();

    service.removeKey(added.id);
    expect(readStoredGatewayKeys(env())).toEqual([]);
  });

  it("reports a real balance when the gateway publishes one", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models"))
        return Response.json({ data: [{ id: "x" }] });
      if (url.includes("/billing/subscription")) {
        return Response.json({ hard_limit_usd: 20 });
      }
      // The usage endpoint reports cents, matching OpenAI's original shape.
      return Response.json({ total_usage: 450 });
    }) as typeof fetch;

    const service = new LlmGatewayKeysService({ env: env(), fetchImpl });
    const channel = service.channels().find((entry) => entry.id === "aitl");
    if (!channel) throw new Error("expected the aitl channel");
    const status = await service.probe(channel, "sk-probe", true);
    expect(status.limitUsd).toBe(20);
    expect(status.usedUsd).toBe(4.5);
    expect(status.balanceUsd).toBe(15.5);
    expect(status.unlimited).toBe(false);
  });
});
