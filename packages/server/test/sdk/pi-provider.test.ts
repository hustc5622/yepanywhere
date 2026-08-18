import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProvider } from "../../src/sdk/providers/pi.js";

const FAKE_PI_RPC = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const logPath = process.env.PI_FAKE_LOG_PATH;
const config = JSON.parse(process.env.YEP_PI_PROVIDER_CONFIG || "{\"providers\":[]}");
const append = (value) => fs.appendFileSync(logPath, JSON.stringify(value) + "\n");
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
append({
  kind: "startup",
  args: process.argv.slice(2),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  hasGatewayKey: Boolean(process.env.YEP_PI_LLM_API_KEY),
  globalInstructions: config.globalInstructions,
  providers: config.providers.map((provider) => ({
    id: provider.id,
    baseUrl: provider.config.baseUrl,
    models: provider.config.models.map((model) => ({
      id: model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: model.compat,
    })),
  })),
});
let buffer = "";
let forked = false;
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
    if (command.type === "fork") {
      forked = true;
      output({ type: "response", id: command.id, command: "fork", success: true, data: { text: "old", cancelled: false } });
    } else if (command.type === "set_model") {
      output(forked
        ? { type: "response", id: command.id, command: "set_model", success: true, data: { id: command.modelId } }
        : { type: "response", id: command.id, command: "set_model", success: false, error: "set_model must follow fork" });
    } else if (command.type === "set_thinking_level") {
      output({ type: "response", id: command.id, command: "set_thinking_level", success: true });
    } else if (command.type === "get_state") {
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-fork-session", thinkingLevel: "high", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 } });
    } else if (command.type === "prompt") {
      output({ type: "response", id: command.id, command: "prompt", success: true });
      output({ type: "message_start", message: { role: "assistant", content: [] } });
      output({ type: "message_update", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      output({ type: "message_update", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "running" } });
      output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "running" }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }], provider: "yep-anthropic", model: "test-model", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, stopReason: "toolUse", timestamp: Date.now() } });
      output({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: "__YEP_PI_TOOL_APPROVAL__:bash", message: JSON.stringify({ toolName: "bash", toolCallId: "call-1", input: { command: "pwd" } }) });
    } else if (command.type === "extension_ui_response") {
      output({ type: "message_end", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "/tmp/project" }], details: { exitCode: 0 }, isError: false, timestamp: Date.now() } });
      output({ type: "message_start", message: { role: "assistant", content: [] } });
      output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "yep-anthropic", model: "test-model", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, stopReason: "stop", timestamp: Date.now() } });
      output({ type: "agent_settled" });
    } else if (command.type === "abort") {
      output({ type: "response", id: command.id, command: "abort", success: true });
    }
  }
});
`;

async function nextMessage(
  iterator: AsyncIterableIterator<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out waiting for Pi RPC")),
        5_000,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (result.done) throw new Error("Pi iterator ended unexpectedly");
  return result.value;
}

describe("PiProvider RPC integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("yep.pi.provider-config.v1")
    ];
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("forks before selecting the model, streams events, and bridges approval", async () => {
    const root = join(tmpdir(), `pi-provider-${randomUUID()}`);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const nestedDir = join(sessionsDir, "--project--");
    const fakePiPath = join(root, "fake-pi.cjs");
    const agentDir = join(root, "yep-pi-agent");
    const logPath = join(root, "rpc-log.jsonl");
    tempDirs.push(root);
    await mkdir(nestedDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);
    await writeFile(
      join(nestedDir, "source.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "source-session",
        timestamp: "2026-08-15T00:00:00.000Z",
        cwd: projectPath,
      })}\n`,
    );

    vi.stubEnv("YEP_LLM_GATEWAY_API_KEY", "test-only-secret");
    vi.stubEnv("YEP_LLM_GATEWAY_API_BASE", "https://gateway.example/v1");
    // The picker only offers a curated set of production model families; an
    // empty allowlist keeps this fixture's synthetic model visible.
    vi.stubEnv("YEP_LLM_GATEWAY_MODELS", "");
    vi.stubEnv("PI_FAKE_LOG_PATH", logPath);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: "test-model",
                name: "Test Model",
                context_window: 128_000,
                supported_endpoint_types: [
                  "chat/completions",
                  "anthropic/messages",
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const approval = vi.fn().mockResolvedValue({ behavior: "allow" });
    const provider = new PiProvider({
      piPath: fakePiPath,
      sessionsDir,
      agentDir,
      extensionPath: resolve(
        import.meta.dirname,
        "../../resources/pi-yep-extension.mjs",
      ),
      timeout: 5_000,
    });
    await expect(provider.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        id: "test-model",
        defaultReasoningEffort: "medium",
        supportsEffort: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
        ],
      }),
    ]);
    const session = await provider.startSession({
      cwd: projectPath,
      resumeSessionId: "source-session",
      resumeSessionAt: "source-user-entry",
      initialMessage: { text: "edited prompt", uuid: "yep-user" },
      llmGatewayConfig: {
        model: "test-model",
        requestProtocol: "anthropic",
        limits: { context: 96_000, output: 12_000 },
      },
      thinking: { type: "adaptive" },
      // Dynamically registered Pi models clamp xhigh to high because they do
      // not define an xhigh thinkingLevelMap.
      reasoningEffort: "xhigh",
      globalInstructions: "Follow the global test policy.",
      onToolApproval: approval,
    });

    const messages: Record<string, unknown>[] = [];
    while (!messages.some((message) => message.type === "result")) {
      messages.push(
        await nextMessage(
          session.iterator as AsyncIterableIterator<Record<string, unknown>>,
        ),
      );
    }
    await session.iterator.return?.();

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "system",
          subtype: "init",
          session_id: "pi-fork-session",
          model: "test-model",
          reasoningEffort: "high",
        }),
        expect.objectContaining({
          type: "user",
          uuid: "yep-user",
        }),
        expect.objectContaining({ type: "result" }),
      ]),
    );
    expect(approval).toHaveBeenCalledWith(
      "Bash",
      { command: "pwd" },
      expect.objectContaining({
        requestId: "approval-1",
        requestMethod: "pi/tool_call",
        respectProviderDecision: false,
      }),
    );

    const log = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const startup = log[0] as {
      args: string[];
      agentDir: string;
      globalInstructions: string;
      providers: Array<{
        id: string;
        baseUrl: string;
        models: Array<{
          id: string;
          contextWindow: number;
          maxTokens: number;
          compat?: Record<string, unknown>;
        }>;
      }>;
    };
    expect(startup.agentDir).toBe(agentDir);
    expect(startup.globalInstructions).toBe("Follow the global test policy.");
    expect(startup.args).toEqual(
      expect.arrayContaining([
        "--mode",
        "rpc",
        "--provider",
        "yep-anthropic",
        "--model",
        "test-model",
        "--no-extensions",
        "--extension",
        "--session",
      ]),
    );
    expect(startup.args[startup.args.indexOf("--session-dir") + 1]).toBe(
      nestedDir,
    );
    expect(startup.providers).toEqual(
      expect.arrayContaining([
        {
          id: "yep-anthropic",
          baseUrl: "https://gateway.example",
          models: [
            {
              id: "test-model",
              contextWindow: 96_000,
              maxTokens: 12_000,
            },
          ],
        },
        {
          id: "yep-openai-compatible",
          baseUrl: "https://gateway.example/v1",
          models: [
            {
              id: "test-model",
              contextWindow: 96_000,
              maxTokens: 12_000,
              // Portable request shape: generic OpenAI-compatible gateways
              // reject the developer role and other api.openai.com-only
              // fields that Pi's default compat detection would send.
              compat: {
                supportsDeveloperRole: false,
                supportsStore: false,
                maxTokensField: "max_tokens",
              },
            },
          ],
        },
      ]),
    );
    const commands = log
      .filter((entry) => entry.kind === "command")
      .map(
        (entry) =>
          entry.command as {
            type: string;
            confirmed?: boolean;
            level?: string;
          },
      );
    expect(
      commands.findIndex((command) => command.type === "fork"),
    ).toBeLessThan(
      commands.findIndex((command) => command.type === "set_model"),
    );
    expect(commands.find((command) => command.type === "prompt")).toMatchObject(
      { message: "edited prompt" },
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "set_thinking_level",
        level: "xhigh",
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "extension_ui_response",
        confirmed: true,
      }),
    );
  });

  it("keeps generated providers across Pi's extension reload without env leakage", async () => {
    const stateKey = Symbol.for("yep.pi.provider-config.v1");
    delete (globalThis as Record<PropertyKey, unknown>)[stateKey];
    vi.stubEnv("YEP_PI_LLM_API_KEY", "reload-secret");
    vi.stubEnv(
      "YEP_PI_PROVIDER_CONFIG",
      JSON.stringify({
        providers: [
          {
            id: "yep-openai-compatible",
            config: {
              name: "Test",
              baseUrl: "https://gateway.example/v1",
              api: "openai-completions",
              models: [],
            },
          },
        ],
      }),
    );

    const extension = await import("../../resources/pi-yep-extension.mjs");
    const firstRegister = vi.fn();
    let approvalHandler:
      | ((
          event: Record<string, unknown>,
          context: {
            ui: { confirm: (...args: unknown[]) => Promise<boolean> };
          },
        ) => unknown)
      | undefined;
    extension.default({
      registerProvider: firstRegister,
      on: (event: string, handler: typeof approvalHandler) => {
        if (event === "tool_call") approvalHandler = handler;
      },
    });
    expect(process.env.YEP_PI_LLM_API_KEY).toBeUndefined();
    expect(process.env.YEP_PI_PROVIDER_CONFIG).toBeUndefined();
    expect(firstRegister).toHaveBeenCalledWith(
      "yep-openai-compatible",
      expect.objectContaining({ apiKey: "reload-secret" }),
    );

    const secondRegister = vi.fn();
    extension.default({
      registerProvider: secondRegister,
      on: vi.fn(),
    });
    expect(secondRegister).toHaveBeenCalledWith(
      "yep-openai-compatible",
      expect.objectContaining({ apiKey: "reload-secret" }),
    );

    const confirm = vi.fn().mockResolvedValue(false);
    await expect(
      approvalHandler?.(
        { toolName: "write", toolCallId: "call-2", input: { path: "a" } },
        { ui: { confirm } },
      ),
    ).resolves.toEqual(expect.objectContaining({ block: true }));
  });
});
