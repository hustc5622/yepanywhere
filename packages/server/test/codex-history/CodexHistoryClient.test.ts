import { describe, expect, it, vi } from "vitest";
import {
  type CodexHistoryAppServerTransport,
  CodexHistoryClient,
} from "../../src/codex-history/CodexHistoryClient.js";
import type { CodexHistoryClientError } from "../../src/codex-history/types.js";

function transport(
  request: (method: string, params?: unknown) => Promise<unknown>,
): CodexHistoryAppServerTransport {
  let alive = false;
  return {
    connect: vi.fn(async () => {
      alive = true;
    }),
    isAlive: vi.fn(() => alive),
    request: vi.fn(request) as CodexHistoryAppServerTransport["request"],
    notify: vi.fn(),
    close: vi.fn(() => {
      alive = false;
    }),
  };
}

describe("CodexHistoryClient", () => {
  it("uses one long-lived apps/plugins-disabled transport and single-flights reads", async () => {
    let resolveRead!: (value: unknown) => void;
    const readPromise = new Promise((resolve) => {
      resolveRead = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") {
        return {
          userAgent: "yep-anywhere-history-read/0.149.0 test",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "linux",
        };
      }
      if (method === "thread/read") return readPromise;
      if (method === "thread/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/turns/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      if (method === "thread/items/list") {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fake = transport(request);
    const factory = vi.fn(() => fake);
    const client = new CodexHistoryClient({
      command: "codex",
      cwd: "/tmp",
      clientFactory: factory,
    });

    const first = client.readThread({
      threadId: "thread-1",
      includeTurns: false,
    });
    const second = client.readThread({
      threadId: "thread-1",
      includeTurns: false,
    });
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "thread/read"),
      ).toHaveLength(1),
    );
    resolveRead({ thread: { id: "thread-1" } });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await client.listThreads({ useStateDbOnly: true });
    await client.listTurns({ threadId: "thread-1" });
    await client.listItems({ threadId: "thread-1" });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0].args).toEqual([
      "--disable",
      "apps",
      "--disable",
      "plugins",
    ]);
    expect(client.getCapability()).toMatchObject({
      protocolVersion: "0.149.0",
      supportsThreadListStateDbOnly: true,
      supportsThreadTurnsList: true,
      supportsThreadItemsList: true,
    });
    client.shutdown();
  });

  it("closes a timed-out transport and applies exponential restart backoff", async () => {
    let now = 1_000;
    const fake = transport(async (method) => {
      if (method === "initialize") {
        return {
          userAgent: "history/0.149.0",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "linux",
        };
      }
      return new Promise(() => {});
    });
    const factory = vi.fn(() => fake);
    const client = new CodexHistoryClient({
      command: "codex",
      requestTimeoutMs: 5,
      now: () => now,
      clientFactory: factory,
    });

    await expect(
      client.readThread({ threadId: "thread-1", includeTurns: false }),
    ).rejects.toMatchObject<CodexHistoryClientError>({ reason: "timeout" });
    await expect(
      client.readThread({ threadId: "thread-2", includeTurns: false }),
    ).rejects.toMatchObject<CodexHistoryClientError>({ reason: "backoff" });
    expect(fake.close).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);

    now += 250;
    client.shutdown();
  });

  it("classifies unsupported methods without tearing down the transport", async () => {
    const fake = transport(async (method) => {
      if (method === "initialize") {
        return {
          userAgent: "history/0.149.0",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "linux",
        };
      }
      const error = new Error("not supported") as Error & { code: number };
      error.name = "CodexJsonRpcError";
      error.code = -32601;
      throw error;
    });
    // The production transport throws the concrete class. Use the real class
    // so this test also locks the cross-module error contract.
    fake.request = vi.fn(async (method: string) => {
      if (method === "initialize") {
        return {
          userAgent: "history/0.149.0",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "linux",
        };
      }
      const { CodexJsonRpcError } = await import(
        "../../src/sdk/providers/codex.js"
      );
      throw new CodexJsonRpcError(-32601, "unsupported");
    }) as CodexHistoryAppServerTransport["request"];
    const client = new CodexHistoryClient({
      command: "codex",
      clientFactory: () => fake,
    });

    await expect(
      client.listItems({ threadId: "thread-1" }),
    ).rejects.toMatchObject<CodexHistoryClientError>({ reason: "unsupported" });
    expect(fake.close).not.toHaveBeenCalled();
    client.shutdown();
  });
});
