import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProvider } from "../../src/sdk/providers/pi.js";

/**
 * Pi's RPC event stream has no tool progress event, so a long-running bash call
 * used to render as a bare `IN` card until the tool result landed. The Yep
 * extension relays `tool_execution_update` through `ui.notify`, and the provider
 * turns that relay into a `partialOutput` snapshot on the pending tool_use
 * block (the same field the Codex exec preview uses).
 */

const STATE_KEY = Symbol.for("yep.pi.provider-config.v1");
const PARTIAL_PREFIX = "__YEP_PI_TOOL_PARTIAL__:";

function resetExtensionState(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[STATE_KEY];
}

async function loadExtension() {
  return await import("../../resources/pi-yep-extension.mjs");
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function createExtensionHarness() {
  const handlers = new Map<string, Handler>();
  const notify = vi.fn();
  const extensionApi = {
    registerProvider: vi.fn(),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  };
  return {
    handlers,
    notify,
    ctx: { ui: { notify } },
    extensionApi,
    relayed(): Array<{ toolCallId: string; text: string }> {
      return notify.mock.calls.map(([message]) =>
        JSON.parse(String(message).slice(PARTIAL_PREFIX.length)),
      );
    },
  };
}

describe("Pi extension partial tool output relay", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetExtensionState();
  });

  it("relays a bounded, deduplicated snapshot of a running tool", async () => {
    vi.useFakeTimers();
    resetExtensionState();
    const extension = await loadExtension();
    const harness = createExtensionHarness();
    extension.default(harness.extensionApi);

    const update = harness.handlers.get("tool_execution_update");
    expect(update).toBeTypeOf("function");

    update?.(
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "pnpm test" },
        partialResult: { content: [{ type: "text", text: "line one\n" }] },
      },
      harness.ctx,
    );

    // The first update is emitted immediately so the preview appears without
    // waiting for the throttle window.
    expect(harness.relayed()).toEqual([
      { toolCallId: "call-1", text: "line one\n" },
    ]);

    // Bursts inside the window coalesce, and the trailing emit carries the
    // newest cumulative snapshot rather than the one that opened the window.
    update?.(
      {
        toolCallId: "call-1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "line one\ntwo\n" }] },
      },
      harness.ctx,
    );
    update?.(
      {
        toolCallId: "call-1",
        toolName: "bash",
        partialResult: {
          content: [{ type: "text", text: "line one\ntwo\nthree\n" }],
        },
      },
      harness.ctx,
    );
    expect(harness.notify).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(harness.relayed()).toEqual([
      { toolCallId: "call-1", text: "line one\n" },
      { toolCallId: "call-1", text: "line one\ntwo\nthree\n" },
    ]);

    // An unchanged snapshot is not worth a stdout frame.
    await vi.advanceTimersByTimeAsync(500);
    update?.(
      {
        toolCallId: "call-1",
        toolName: "bash",
        partialResult: {
          content: [{ type: "text", text: "line one\ntwo\nthree\n" }],
        },
      },
      harness.ctx,
    );
    expect(harness.notify).toHaveBeenCalledTimes(2);
  });

  it("keeps only the tail of a very chatty tool and drops empty snapshots", async () => {
    resetExtensionState();
    const extension = await loadExtension();
    const harness = createExtensionHarness();
    extension.default(harness.extensionApi);
    const update = harness.handlers.get("tool_execution_update");

    update?.(
      { toolCallId: "call-2", partialResult: { content: [] } },
      harness.ctx,
    );
    expect(harness.notify).not.toHaveBeenCalled();

    const huge = "x".repeat(20_000);
    update?.(
      {
        toolCallId: "call-2",
        partialResult: { content: [{ type: "text", text: huge }] },
      },
      harness.ctx,
    );
    const [relayed] = harness.relayed();
    expect(relayed?.text).toHaveLength(8_000);
    expect(relayed?.text).toBe(huge.slice(-8_000));
  });

  it("does not relay updates that arrive without a tool call id", async () => {
    resetExtensionState();
    const extension = await loadExtension();
    const harness = createExtensionHarness();
    extension.default(harness.extensionApi);

    harness.handlers.get("tool_execution_update")?.(
      { partialResult: { content: [{ type: "text", text: "orphan" }] } },
      harness.ctx,
    );
    expect(harness.notify).not.toHaveBeenCalled();
  });
});

const FAKE_PI_RPC = String.raw`#!/usr/bin/env node
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
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
    if (command.type === "get_state") {
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-partial-session", thinkingLevel: "high" } });
    } else if (command.type === "prompt") {
      output({ type: "response", id: command.id, command: "prompt", success: true });
      output({ type: "message_start", message: { role: "assistant", content: [] } });
      output({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      output({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "running it" } });
      output({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { id: "call-live", name: "bash", arguments: { command: "pnpm test" } } } });
      output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "running it" }, { type: "toolCall", id: "call-live", name: "bash", arguments: { command: "pnpm test" } }], stopReason: "toolUse", timestamp: Date.now() } });
      output({ type: "extension_ui_request", id: "notify-1", method: "notify", message: "__YEP_PI_TOOL_PARTIAL__:" + JSON.stringify({ toolCallId: "call-live", text: "compiling...\n" }) });
      output({ type: "extension_ui_request", id: "notify-2", method: "notify", message: "__YEP_PI_TOOL_PARTIAL__:" + JSON.stringify({ toolCallId: "call-live", text: "compiling...\nlinking...\n" }) });
      output({ type: "extension_ui_request", id: "notify-3", method: "notify", message: "plain notify, not a relay" });
      output({ type: "extension_ui_request", id: "notify-4", method: "notify", message: "__YEP_PI_TOOL_PARTIAL__:{not json" });
      output({ type: "extension_ui_request", id: "notify-5", method: "notify", message: "__YEP_PI_TOOL_PARTIAL__:" + JSON.stringify({ toolCallId: "unknown-call", text: "orphan" }) });
      output({ type: "message_end", message: { role: "toolResult", toolCallId: "call-live", content: [{ type: "text", text: "compiling...\nlinking...\ndone\n" }], isError: false, timestamp: Date.now() } });
      output({ type: "agent_settled" });
    } else if (command.type === "abort") {
      output({ type: "response", id: command.id, command: "abort", success: true });
    } else if (command.id) {
      output({ type: "response", id: command.id, command: command.type, success: true });
    }
  }
});
`;

interface StreamedMessage {
  type?: string;
  uuid?: string;
  message?: { content?: unknown };
}

function blocksOf(
  message: StreamedMessage | undefined,
): Array<Record<string, unknown>> {
  const content = message?.message?.content;
  return Array.isArray(content)
    ? (content as Array<Record<string, unknown>>)
    : [];
}

async function collectUntilResult(
  iterator: AsyncIterableIterator<StreamedMessage>,
): Promise<StreamedMessage[]> {
  const collected: StreamedMessage[] = [];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const next = await iterator.next();
    if (next.done) return collected;
    collected.push(next.value);
    if (next.value.type === "result") return collected;
  }
  throw new Error("Timed out waiting for the Pi turn to settle");
}

describe("PiProvider live tool output", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetExtensionState();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("projects a relayed notify onto the pending tool_use block", async () => {
    const root = join(tmpdir(), `pi-partial-${randomUUID()}`);
    const sessionsDir = join(root, "sessions");
    const projectPath = join(root, "project");
    const fakePiPath = join(root, "fake-pi.cjs");
    tempDirs.push(root);
    await mkdir(join(sessionsDir, "--project--"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(fakePiPath, FAKE_PI_RPC);
    await chmod(fakePiPath, 0o755);

    vi.stubEnv("YEP_LLM_GATEWAY_API_KEY", "test-only-secret");
    vi.stubEnv("YEP_LLM_GATEWAY_API_BASE", "https://gateway.example/v1");
    vi.stubEnv("YEP_LLM_GATEWAY_MODELS", "");
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
                supported_endpoint_types: ["anthropic/messages"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const provider = new PiProvider({
      piPath: fakePiPath,
      sessionsDir,
      agentDir: join(root, "yep-pi-agent"),
      extensionPath: resolve(
        import.meta.dirname,
        "../../resources/pi-yep-extension.mjs",
      ),
      timeout: 5_000,
    });

    const session = await provider.startSession({
      cwd: projectPath,
      model: "test-model",
    });
    let streamed: StreamedMessage[] = [];
    try {
      session.queue.push({ text: "run the tests" });
      streamed = await collectUntilResult(
        session.iterator as AsyncIterableIterator<StreamedMessage>,
      );
    } finally {
      session.abort();
    }

    const previews = streamed.filter((message) =>
      blocksOf(message).some(
        (block) => typeof block.partialOutput === "string",
      ),
    );
    expect(previews).toHaveLength(2);

    const [first, second] = previews;
    const toolBlockOf = (message: StreamedMessage | undefined) =>
      blocksOf(message).find((block) => block.type === "tool_use");
    expect(toolBlockOf(first)).toMatchObject({
      id: "call-live",
      // Pi tool names are canonicalized for the shared renderers.
      name: "Bash",
      partialOutput: "compiling...\n",
    });
    expect(toolBlockOf(second)).toMatchObject({
      id: "call-live",
      partialOutput: "compiling...\nlinking...\n",
    });

    // The preview must reuse the owning assistant message so the client merges
    // it into the existing tool row instead of appending a new one, and it must
    // keep the sibling text block intact.
    const owner = streamed.findLast(
      (message) =>
        message.type === "assistant" &&
        blocksOf(message).some(
          (block) => block.type === "tool_use" && block.id === "call-live",
        ) &&
        !blocksOf(message).some(
          (block) => typeof block.partialOutput === "string",
        ),
    );
    expect(owner?.uuid).toBeTruthy();
    expect(first?.uuid).toBe(owner?.uuid);
    expect(second?.uuid).toBe(owner?.uuid);
    expect(blocksOf(first).map((block) => block.type)).toEqual(
      blocksOf(owner).map((block) => block.type),
    );

    // Unrelated notifies, malformed payloads and unknown tool ids stay inert.
    const toolResult = streamed.find((message) =>
      blocksOf(message).some((block) => block.type === "tool_result"),
    );
    expect(toolResult).toBeTruthy();
  });
});
