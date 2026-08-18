import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProvider } from "../../src/sdk/providers/pi.js";

/**
 * Minimal fake `pi --mode rpc` that records its startup environment and
 * provider catalog, then answers just enough commands for startSession to
 * reach its init message.
 */
const FAKE_PI_RPC = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const logPath = process.env.PI_FAKE_LOG_PATH;
const config = JSON.parse(process.env.YEP_PI_PROVIDER_CONFIG || "{\"providers\":[]}");
const append = (value) => fs.appendFileSync(logPath, JSON.stringify(value) + "\n");
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
append({
  kind: "startup",
  args: process.argv.slice(2),
  apiKeys: process.env.YEP_PI_LLM_API_KEYS,
  legacyApiKey: process.env.YEP_PI_LLM_API_KEY ?? null,
  leakedEnv: [
    "LLM_API_KEY",
    "LLM_API_BASE",
    "OPENCODE_LLM_API_KEY",
    "YEP_LLM_GATEWAYS",
    "EXTRA_GATEWAY_KEY",
  ].filter((key) => process.env[key] !== undefined),
  providers: config.providers.map((provider) => ({
    id: provider.id,
    baseUrl: provider.config.baseUrl,
    api: provider.config.api,
    headers: provider.config.headers ?? null,
    models: provider.config.models.map((model) => ({ id: model.id, compat: model.compat ?? null, thinkingLevelMap: model.thinkingLevelMap ?? null })),
  })),
});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    append({ kind: "command", command });
    if (command.type === "get_state") {
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-multi-session", thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 } });
    } else {
      output({ type: "response", id: command.id, command: command.type, success: true });
    }
  }
});
`;

function catalogResponse(models: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ success: true, data: models }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("PiProvider multi-gateway channels", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function stubTwoChannels(): void {
    vi.stubEnv("LLM_API_KEY", "default-secret");
    vi.stubEnv("LLM_API_BASE", "https://default.example/v1");
    vi.stubEnv("EXTRA_GATEWAY_KEY", "extra-secret");
    vi.stubEnv(
      "YEP_LLM_GATEWAYS",
      "aitl=https://extra.example/v1|EXTRA_GATEWAY_KEY|codex-internal",
    );
  }

  it("namespaces extra-channel models and keeps a failing channel's last catalog", async () => {
    stubTwoChannels();
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("https://default.example")) {
        return catalogResponse([
          { id: "claude-opus-4-8", supported_endpoint_types: ["anthropic"] },
        ]);
      }
      return catalogResponse([
        // Deliberately the same id as the default channel plus an exclusive
        // one, which is exactly the collision namespacing has to survive.
        { id: "claude-opus-4-8", supported_endpoint_types: ["anthropic"] },
        {
          id: "claude-opus-5",
          name: "Claude Opus 5",
          supported_endpoint_types: ["anthropic", "openai"],
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const provider = new PiProvider({ timeout: 5_000 });
    const models = await provider.getAvailableModels();
    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-4-8",
      "aitl/claude-opus-4-8",
      "aitl/claude-opus-5",
    ]);
    expect(
      models.find((model) => model.id === "aitl/claude-opus-5")?.name,
    ).toBe("Claude Opus 5 (extra.example)");

    // The extra channel now fails; its last good catalog must survive so one
    // unreachable gateway cannot empty the picker.
    fetchImpl.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("https://default.example")) {
        return catalogResponse([
          { id: "claude-opus-4-8", supported_endpoint_types: ["anthropic"] },
        ]);
      }
      throw new Error("gateway unreachable");
    });
    const afterFailure = await provider.getAvailableModels({
      waitForRefresh: true,
    });
    expect(afterFailure.map((model) => model.id)).toEqual([
      "claude-opus-4-8",
      "aitl/claude-opus-4-8",
      "aitl/claude-opus-5",
    ]);
  });

  it("offers only the curated newest models but keeps the rest routable", async () => {
    stubTwoChannels();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).startsWith("https://default.example")
          ? catalogResponse([
              {
                id: "claude-opus-4-8",
                supported_endpoint_types: ["anthropic"],
              },
              {
                id: "claude-opus-4-6",
                supported_endpoint_types: ["anthropic"],
              },
              {
                id: "claude-sonnet-5",
                supported_endpoint_types: ["anthropic"],
              },
              {
                id: "gemini-3.5-flash",
                supported_endpoint_types: ["openai"],
              },
              { id: "glm-5.1", supported_endpoint_types: ["openai"] },
              { id: "glm-5.2", supported_endpoint_types: ["openai"] },
            ])
          : catalogResponse([
              { id: "claude-opus-5", supported_endpoint_types: ["anthropic"] },
              {
                id: "claude-opus-4-5-20251101",
                supported_endpoint_types: ["anthropic"],
              },
            ]),
      ),
    );

    const provider = new PiProvider({ timeout: 5_000 });
    const visible = await provider.getAvailableModels();
    expect(visible.map((model) => model.id)).toEqual([
      "claude-opus-4-8",
      "glm-5.2",
      "aitl/claude-opus-5",
    ]);
  });

  it("returns nothing when no gateway channel is configured", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("OPENCODE_LLM_API_KEY", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("must not be called");
      }),
    );
    await expect(
      new PiProvider({ timeout: 5_000 }).getAvailableModels(),
    ).resolves.toEqual([]);
  });

  it("still starts a session pinned to a model the picker omits", async () => {
    stubTwoChannels();
    const root = join(tmpdir(), `pi-hidden-${randomUUID()}`);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const fakePiPath = join(root, "fake-pi.cjs");
    const logPath = join(root, "rpc-log.jsonl");
    tempDirs.push(root);
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);
    vi.stubEnv("PI_FAKE_LOG_PATH", logPath);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).startsWith("https://default.example")
          ? catalogResponse([
              {
                id: "claude-opus-4-8",
                supported_endpoint_types: ["anthropic"],
              },
              {
                id: "claude-opus-4-6",
                supported_endpoint_types: ["anthropic"],
              },
            ])
          : catalogResponse([]),
      ),
    );

    const provider = new PiProvider({
      piPath: fakePiPath,
      sessionsDir,
      agentDir: join(root, "agent"),
      extensionPath: resolve(
        import.meta.dirname,
        "../../resources/pi-yep-extension.mjs",
      ),
      timeout: 5_000,
    });
    // The picker does not offer Opus 4.6, but a session already pinned to it
    // must not fail to start.
    const session = await provider.startSession({
      cwd: projectPath,
      model: "claude-opus-4-6",
      thinking: { type: "disabled" },
    });
    const first = await session.iterator.next();
    expect(first.value).toMatchObject({
      type: "system",
      subtype: "init",
      model: "claude-opus-4-6",
    });
    await session.iterator.return?.();
    session.abort();

    const startup = JSON.parse(
      (await readFile(logPath, "utf8")).split("\n")[0] ?? "{}",
    ) as { args: string[] };
    expect(startup.args[startup.args.indexOf("--model") + 1]).toBe(
      "claude-opus-4-6",
    );
  });

  it("generates one provider per channel/protocol, passes per-provider keys, and resolves a bare model id", async () => {
    stubTwoChannels();
    const root = join(tmpdir(), `pi-multi-${randomUUID()}`);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const fakePiPath = join(root, "fake-pi.cjs");
    const logPath = join(root, "rpc-log.jsonl");
    tempDirs.push(root);
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);
    vi.stubEnv("PI_FAKE_LOG_PATH", logPath);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).startsWith("https://default.example")
          ? catalogResponse([
              {
                id: "claude-opus-4-8",
                supported_endpoint_types: ["anthropic", "openai"],
              },
            ])
          : catalogResponse([
              { id: "claude-opus-5", supported_endpoint_types: ["anthropic"] },
            ]),
      ),
    );

    const provider = new PiProvider({
      piPath: fakePiPath,
      sessionsDir,
      agentDir: join(root, "agent"),
      extensionPath: resolve(
        import.meta.dirname,
        "../../resources/pi-yep-extension.mjs",
      ),
      timeout: 5_000,
    });
    const session = await provider.startSession({
      cwd: projectPath,
      // A stored bare id from before multi-gateway support: it must resolve to
      // the channel that serves it instead of failing the session start.
      model: "claude-opus-5",
      thinking: { type: "disabled" },
    });

    const first = await session.iterator.next();
    expect(first.value).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: "pi-multi-session",
      model: "aitl/claude-opus-5",
    });
    await session.iterator.return?.();
    session.abort();

    const log = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const startup = log[0] as {
      args: string[];
      apiKeys: string;
      legacyApiKey: string | null;
      leakedEnv: string[];
      providers: Array<{
        id: string;
        baseUrl: string;
        api: string;
        headers: Record<string, string> | null;
        models: Array<{
          id: string;
          compat: Record<string, unknown> | null;
          thinkingLevelMap: Record<string, string | null> | null;
        }>;
      }>;
    };

    // Pi is started on the resolved channel's provider with the bare model id.
    expect(startup.args[startup.args.indexOf("--provider") + 1]).toBe(
      "yep-anthropic-aitl",
    );
    expect(startup.args[startup.args.indexOf("--model") + 1]).toBe(
      "claude-opus-5",
    );
    expect(startup.providers).toEqual([
      {
        id: "yep-anthropic",
        baseUrl: "https://default.example",
        api: "anthropic-messages",
        headers: null,
        models: [
          {
            id: "claude-opus-4-8",
            // Current Claude releases reject the legacy budget-based thinking
            // payload; Pi only emits the adaptive shape for a model carrying
            // this compat flag.
            compat: {
              forceAdaptiveThinking: true,
              supportsTemperature: false,
            },
            thinkingLevelMap: { max: "max", xhigh: "xhigh" },
          },
        ],
      },
      {
        id: "yep-openai-compatible",
        baseUrl: "https://default.example/v1",
        api: "openai-completions",
        headers: null,
        models: [
          {
            id: "claude-opus-4-8",
            compat: {
              supportsDeveloperRole: false,
              supportsStore: false,
              maxTokensField: "max_tokens",
            },
            thinkingLevelMap: null,
          },
        ],
      },
      {
        id: "yep-anthropic-aitl",
        baseUrl: "https://extra.example",
        api: "anthropic-messages",
        headers: { "X-Sub-Module": "codex-internal" },
        models: [
          {
            id: "claude-opus-5",
            compat: {
              forceAdaptiveThinking: true,
              supportsTemperature: false,
            },
            thinkingLevelMap: { max: "max", xhigh: "xhigh" },
          },
        ],
      },
    ]);
    expect(JSON.parse(startup.apiKeys)).toEqual({
      "yep-openai-compatible": "default-secret",
      "yep-anthropic": "default-secret",
      "yep-anthropic-aitl": "extra-secret",
    });
    // Only the generated map may carry credentials into the child: Pi's bash
    // tool inherits this environment.
    expect(startup.legacyApiKey).toBeNull();
    expect(startup.leakedEnv).toEqual([]);

    const setModel = log
      .filter((entry) => entry.kind === "command")
      .map((entry) => entry.command as Record<string, unknown>)
      .find((command) => command.type === "set_model");
    expect(setModel).toMatchObject({
      provider: "yep-anthropic-aitl",
      modelId: "claude-opus-5",
    });
  });

  it("keeps a slash-bearing default model on its source gateway when a channel prefix collides", async () => {
    vi.stubEnv("LLM_API_KEY", "default-secret");
    vi.stubEnv("LLM_API_BASE", "https://default.example/v1");
    vi.stubEnv("EXTRA_GATEWAY_KEY", "extra-secret");
    vi.stubEnv(
      "YEP_LLM_GATEWAYS",
      "openai=https://extra.example/v1|EXTRA_GATEWAY_KEY",
    );
    const root = join(tmpdir(), `pi-collision-${randomUUID()}`);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const fakePiPath = join(root, "fake-pi.cjs");
    const logPath = join(root, "rpc-log.jsonl");
    tempDirs.push(root);
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);
    vi.stubEnv("PI_FAKE_LOG_PATH", logPath);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).startsWith("https://default.example")
          ? catalogResponse([
              {
                // This is a bare id owned by the default gateway, not a Yep
                // channel-qualified id.
                id: "openai/gpt-5",
                supported_endpoint_types: ["anthropic"],
              },
            ])
          : catalogResponse([
              {
                // Qualifying this model for the channel named `openai` would
                // produce the same Yep-facing id. The safe behavior is to
                // retain the default model and omit this ambiguous duplicate.
                id: "gpt-5",
                supported_endpoint_types: ["anthropic"],
              },
            ]),
      ),
    );

    const provider = new PiProvider({
      piPath: fakePiPath,
      sessionsDir,
      agentDir: join(root, "agent"),
      extensionPath: resolve(
        import.meta.dirname,
        "../../resources/pi-yep-extension.mjs",
      ),
      timeout: 5_000,
    });
    const session = await provider.startSession({
      cwd: projectPath,
      model: "openai/gpt-5",
      thinking: { type: "disabled" },
    });
    const first = await session.iterator.next();
    expect(first.value).toMatchObject({
      type: "system",
      subtype: "init",
      model: "openai/gpt-5",
    });
    await session.iterator.return?.();
    session.abort();

    const startup = JSON.parse(
      (await readFile(logPath, "utf8")).split("\n")[0] ?? "{}",
    ) as {
      args: string[];
      providers: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    expect(startup.args[startup.args.indexOf("--provider") + 1]).toBe(
      "yep-anthropic",
    );
    expect(startup.args[startup.args.indexOf("--model") + 1]).toBe(
      "openai/gpt-5",
    );
    expect(startup.providers).toEqual([
      expect.objectContaining({
        id: "yep-anthropic",
        models: [expect.objectContaining({ id: "openai/gpt-5" })],
      }),
    ]);
  });
});
