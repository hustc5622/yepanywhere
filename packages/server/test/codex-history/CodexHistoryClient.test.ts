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
  it("routes concurrent thread reads to their owning homes without changing global credentials", async () => {
    const originalHome = process.env.CODEX_HOME;
    const transports = new Map<string, CodexHistoryAppServerTransport>();
    const accounts = new Map([
      ["thread-a", "/accounts/a"],
      ["thread-b", "/accounts/b"],
    ]);
    const factory = vi.fn(({ env }: { env: NodeJS.ProcessEnv }) => {
      const home = env.CODEX_HOME ?? "default";
      const fake = transport(async (method) => {
        if (method === "initialize") return { userAgent: "history/0.155.1" };
        if (method === "thread/read") return { thread: { id: home } };
        // The account DB contains history; the ambient DB has no items.
        return {
          data: home.startsWith("/accounts/") ? [{ id: `final:${home}` }] : [],
          nextCursor: null,
        };
      });
      transports.set(home, fake);
      return fake;
    });
    const client = new CodexHistoryClient({
      command: "codex",
      clientFactory: factory,
      resolveThreadCodexHome: (threadId) => accounts.get(threadId),
    });
    try {
      const [a, b] = await Promise.all([
        client.readThread({ threadId: "thread-a", includeTurns: false }),
        client.readThread({ threadId: "thread-b", includeTurns: false }),
      ]);
      expect(a.thread.id).toBe("/accounts/a");
      expect(b.thread.id).toBe("/accounts/b");
      expect((await client.listTurns({ threadId: "thread-a" })).data).toEqual([
        { id: "final:/accounts/a" },
      ]);
      expect((await client.listItems({ threadId: "thread-b" })).data).toEqual([
        { id: "final:/accounts/b" },
      ]);
      expect(factory).toHaveBeenCalledTimes(2);
      expect((await client.listThreads({ useStateDbOnly: true })).data).toEqual(
        [],
      );
      expect(factory).toHaveBeenCalledTimes(3);
      expect(process.env.CODEX_HOME).toBe(originalHome);

      // Re-resolve bindings for each request; don't cache a thread's old home.
      accounts.set("thread-a", "/accounts/b");
      expect(
        (await client.readThread({ threadId: "thread-a", includeTurns: false }))
          .thread.id,
      ).toBe("/accounts/b");
      expect(factory).toHaveBeenCalledTimes(3);
    } finally {
      client.shutdown();
    }
    for (const fake of transports.values())
      expect(fake.close).toHaveBeenCalled();
  });

  it("isolates one account's timeout and backoff from another account", async () => {
    const factory = vi.fn(({ env }: { env: NodeJS.ProcessEnv }) =>
      transport(async (method) => {
        if (method === "initialize") return { userAgent: "history/0.155.1" };
        if (env.CODEX_HOME === "/accounts/broken") return new Promise(() => {});
        return { data: [{ id: "complete-answer" }], nextCursor: null };
      }),
    );
    const client = new CodexHistoryClient({
      command: "codex",
      requestTimeoutMs: 5,
      clientFactory: factory,
      resolveThreadCodexHome: (id) => `/accounts/${id}`,
    });
    try {
      await expect(
        client.listItems({ threadId: "broken" }),
      ).rejects.toMatchObject({ reason: "timeout" });
      await expect(
        client.listItems({ threadId: "broken" }),
      ).rejects.toMatchObject({ reason: "backoff" });
      expect((await client.listItems({ threadId: "healthy" })).data).toEqual([
        { id: "complete-answer" },
      ]);
    } finally {
      client.shutdown();
    }
  });

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
