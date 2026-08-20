import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionRetryStatus } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProvider } from "../../src/sdk/providers/pi.js";

/**
 * Pi retries a failed request inside the turn: nothing in the message stream
 * changes while it backs off, so without these events the UI shows an ordinary
 * thinking pulse and a rate-limited session is indistinguishable from a slow
 * one.
 */
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
      output({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-retry-session", thinkingLevel: "high" } });
    } else if (command.type === "prompt") {
      output({ type: "response", id: command.id, command: "prompt", success: true });
      output({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 4000, errorMessage: "429 rate limited" });
      output({ type: "auto_retry_end", success: true, attempt: 2 });
      output({ type: "message_start", message: { role: "assistant", content: [] } });
      output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now() } });
      output({ type: "agent_settled" });
    } else if (command.type === "abort") {
      output({ type: "response", id: command.id, command: "abort", success: true });
    } else if (command.id) {
      output({ type: "response", id: command.id, command: command.type, success: true });
    }
  }
});
`;

async function drainUntilResult(
  iterator: AsyncIterableIterator<Record<string, unknown>>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const next = await iterator.next();
    if (next.done) return;
    if (next.value.type === "result") return;
  }
  throw new Error("Timed out waiting for the Pi turn to settle");
}

describe("PiProvider retry status", () => {
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

  it("reports Pi auto-retry backoff through onRetryStatus and clears it", async () => {
    const root = join(tmpdir(), `pi-retry-${randomUUID()}`);
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

    const retryStatuses: (SessionRetryStatus | undefined)[] = [];
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

    const before = Date.now();
    const session = await provider.startSession({
      cwd: projectPath,
      model: "test-model",
      onRetryStatus: (status) => retryStatuses.push(status),
    });
    try {
      session.queue.push({ text: "hello" });
      await drainUntilResult(
        session.iterator as AsyncIterableIterator<Record<string, unknown>>,
      );
    } finally {
      session.abort();
    }

    // Backoff is reported, then cleared. The trailing clear may be emitted by
    // `auto_retry_end` or defensively by the settled turn, so only the first
    // two entries are pinned.
    expect(retryStatuses.length).toBeGreaterThanOrEqual(2);
    const [started, ...rest] = retryStatuses;
    expect(started).toMatchObject({
      attempt: 2,
      message: "429 rate limited (attempt 2/5)",
    });
    expect(started?.next).toBeGreaterThanOrEqual(before + 4000);
    expect(rest.every((status) => status === undefined)).toBe(true);
  });
});
